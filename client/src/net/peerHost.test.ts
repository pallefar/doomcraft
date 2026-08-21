/**
 * DOOMCRAFT — the host-authoritative peer, end to end.
 *
 * Everything in here is real except the radio: the real `SignalHub` from
 * server/src/signal.ts, the real `Room` (and therefore the real `sim.ts`,
 * `world.ts` and `net.ts`), the real `NetClient` with its real prediction, and
 * the real binary protocol. Only `RTCPeerConnection` is a double, because loss
 * has to be an input rather than a hope — see rtcFake.ts.
 *
 * That combination is the claim the whole exercise rests on: a peer host is
 * the existing worker server with a DataChannel instead of a socket. If the
 * protocol or the simulation had been forked, these tests could not be written
 * at all.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { C2S, PacketReader, S2C, SNAP_FULL, SnapshotBuffer, decodeSnapshot } from '@shared';
import { ModeId } from '@shared/modes';
import type { SignalC2S, SignalS2C } from '@shared/signal';
import { SignalHub, type SignalSocket } from '@doomcraft/server/src/signal.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';

import { NetClient } from './client.js';
import { FakeRtcNetwork } from './rtcFake.js';
import {
  JOIN_STAGGER_MS,
  PEER_CAP_MAX,
  createPeerHost,
  describeHostDeparture,
  hostableMode,
  probeHostEligibility,
  type HostEligibility,
  type PeerHost,
  type PeerHostEvent,
} from './peerHost.js';
import {
  PEER_SILENCE_MS,
  joinPeerRoom,
  type SignalPort,
  type WebRtcClientTransport,
} from './webrtc.js';
import type { ServerTransport } from './transport.js';

/* ------------------------------------------------------------------------ *
 * The seam itself
 * ------------------------------------------------------------------------ */

describe('the transport seam', () => {
  it('is the same shape the authoritative room already required', () => {
    // `ServerTransport` (client/src/net/transport.ts) is declared separately
    // from `NetTransport` (server/src/net.ts) so the client bundle never
    // imports the server package for a type. These two assignments are what
    // stops them drifting: if either grows a member, the build breaks here
    // rather than at the first peer-hosted match.
    const asServer: ServerTransport = null as unknown as NetTransport;
    const asNet: NetTransport = null as unknown as ServerTransport;
    expect(asServer).toBe(asNet);
  });
});

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

const DESKTOP: HostEligibility = {
  eligible: true, deviceClass: 'desktop', reason: '', recommendedGuests: 3,
};

async function settle(turns = 80): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** A `SignalPort` wired straight into the real hub, with no socket in between. */
function hubPort(hub: SignalHub, address: string): SignalPort {
  let open = true;
  const port: SignalPort = {
    get open(): boolean { return open; },
    onMessage: null,
    onClose: null,
    send(): void { /* replaced below */ },
    close(): void { /* replaced below */ },
  };
  const socket: SignalSocket = {
    get isOpen(): boolean { return open; },
    send(text: string): void { port.onMessage?.(JSON.parse(text) as SignalS2C); },
    close(): void {
      if (!open) return;
      open = false;
      port.onClose?.();
    },
  };
  const conn = hub.attach(socket, address);
  if (conn === null) throw new Error('hub refused the connection');
  port.send = (msg: SignalC2S): void => { if (open) hub.receive(conn, JSON.stringify(msg)); };
  port.close = (): void => { hub.detach(conn); socket.close(); };
  return port;
}

interface Guest {
  transport: WebRtcClientTransport;
  client: NetClient;
  /** True for each snapshot that arrived with SNAP_FULL set. */
  snapshotFull: boolean[];
  snapshots: number;
  status: string;
  closedWith: [number, string] | null;
}

interface World {
  now(): number;
  hub: SignalHub;
  rtc: FakeRtcNetwork;
  host: PeerHost;
  /** The port the host is listening on — lets a test act as the hub. */
  hostPort: SignalPort;
  hostEvents: PeerHostEvent[];
  hostClient: NetClient;
  /** Advance virtual time, tick the room, and move every packet. */
  step(ms?: number, times?: number): void;
  addGuest(name: string): Promise<Guest>;
  dispose(): void;
}

const live: World[] = [];
afterEach(() => { while (live.length > 0) live.pop()?.dispose(); });

async function makeWorld(opts: { maxGuests?: number } = {}): Promise<World> {
  let nowMs = 0;
  const now = (): number => nowMs;

  const hub = new SignalHub({ now });
  const rtc = new FakeRtcNetwork();
  const hostEvents: PeerHostEvent[] = [];
  const guests: Guest[] = [];
  const hostPort = hubPort(hub, 'host-ip');

  const host = createPeerHost({
    signal: hostPort,
    mode: ModeId.QUEST,
    seed: 4242,
    botFill: 0,
    enemies: 0,
    maxGuests: opts.maxGuests ?? 3,
    inline: true,
    manual: true,
    autoPump: false,
    now,
    rtc: rtc.factory('host'),
    eligibility: DESKTOP,
    onEvent: (e) => { hostEvents.push(e); },
  });
  await host.ready;

  const hostClient = new NetClient({
    name: 'Host', transport: host.transport, autoReconnect: false,
    keepalive: null, wallClock: now,
  });
  hostClient.connect();

  const world: World = {
    now, hub, rtc, host, hostPort, hostEvents, hostClient,

    step(ms = 25, times = 1): void {
      for (let i = 0; i < times; i++) {
        nowMs += ms;
        host.advance(nowMs);      // the room produces
        rtc.flush();              // packets cross the wire
        host.pump(nowMs);
        for (const g of guests) g.transport.link.pump(nowMs);
        hostClient.update(ms / 1000);
        for (const g of guests) g.client.update(ms / 1000);
        rtc.flush();              // and the answers cross back
      }
    },

    async addGuest(name: string): Promise<Guest> {
      const transport = await joinPeerRoom({
        code: host.code ?? '',
        signal: hubPort(hub, `guest-${name}`),
        rtc: rtc.factory('guest'),
        now,
        autoPump: false,
      });
      const guest: Guest = {
        transport,
        client: null as unknown as NetClient,
        snapshotFull: [],
        snapshots: 0,
        status: 'idle',
        closedWith: null,
      };
      guest.client = new NetClient({
        name, transport, autoReconnect: false, keepalive: null, wallClock: now,
        events: { onStatus: (s): void => { guest.status = s; } },
      });
      guest.client.connect();

      // Tap the transport AFTER connect(), which is where NetClient installs
      // its own handlers.
      const reader = new PacketReader();
      const scratch = new SnapshotBuffer();
      const passMessage = transport.onmessage;
      transport.onmessage = (data): void => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length > 0 && bytes[0] === S2C.SNAPSHOT) {
          guest.snapshots++;
          const s = decodeSnapshot(reader.reset(bytes), scratch);
          guest.snapshotFull.push((s.flags & SNAP_FULL) !== 0);
        }
        passMessage?.(data);
      };
      const passClose = transport.onclose;
      transport.onclose = (code, reason): void => {
        guest.closedWith = [code, reason];
        passClose?.(code, reason);
      };

      guests.push(guest);
      await settle();
      return guest;
    },

    dispose(): void {
      for (const g of guests) g.client.dispose();
      hostClient.dispose();
      host.stop('test over');
      hub.closeAll();
    },
  };

  live.push(world);
  return world;
}

/** Act as the hub and hand the host a peer it did not ask for. */
function injectPeer(w: World, peerId: string): void {
  w.hostPort.onMessage?.({ t: 'peer', peer: peerId });
}

/* ------------------------------------------------------------------------ *
 * Refusals — the rules that exist in order to say no
 * ------------------------------------------------------------------------ */

describe('what may be peer hosted', () => {
  it('allows Quest co-op and refuses every mode that touches the economy', () => {
    expect(hostableMode(ModeId.QUEST).allowed).toBe(true);
    for (const mode of [ModeId.DEATHMATCH, ModeId.BUILDER, ModeId.HORDE]) {
      const v = hostableMode(mode);
      expect(v.allowed).toBe(false);
      expect(v.reason.length).toBeGreaterThan(10);
    }
  });

  it('throws rather than quietly hosting a ranked mode', () => {
    const hub = new SignalHub();
    expect(() => createPeerHost({
      signal: hubPort(hub, 'ranked-attempt'),
      mode: ModeId.DEATHMATCH,
      eligibility: DESKTOP,
      inline: true,
    })).toThrow(/ranked/i);
  });

  it('throws rather than hosting on an ineligible device', () => {
    const hub = new SignalHub();
    expect(() => createPeerHost({
      signal: hubPort(hub, 'phone-attempt'),
      mode: ModeId.QUEST,
      inline: true,
      eligibility: {
        eligible: false, deviceClass: 'mobile', recommendedGuests: 0,
        reason: 'Phones and tablets cannot host — the match would end when your screen sleeps.',
      },
    })).toThrow(/Phones and tablets/);
  });
});

describe('who may host', () => {
  const withRtc = true;

  it('never elects a phone or a tablet', () => {
    const iphone = probeHostEligibility({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }, withRtc);
    expect(iphone.eligible).toBe(false);
    expect(iphone.deviceClass).toBe('mobile');

    expect(probeHostEligibility({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' }, withRtc).eligible).toBe(false);
    expect(probeHostEligibility({ userAgent: 'irrelevant', userAgentData: { mobile: true } }, withRtc).eligible).toBe(false);

    // iPadOS 13+ lies and calls itself a Mac. Touch points give it away.
    const ipad = probeHostEligibility(
      { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 },
      withRtc,
    );
    expect(ipad.eligible).toBe(false);
    expect(ipad.deviceClass).toBe('mobile');

    // The same string without touch is a real Mac.
    const mac = probeHostEligibility(
      { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0, hardwareConcurrency: 10 },
      withRtc,
    );
    expect(mac.eligible).toBe(true);
    expect(mac.recommendedGuests).toBe(3);
  });

  it('refuses a cellular or data-saving connection, and shrinks a weak machine', () => {
    const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    expect(probeHostEligibility({ userAgent: desktop, connection: { type: 'cellular' } }, withRtc).eligible).toBe(false);
    expect(probeHostEligibility({ userAgent: desktop, connection: { saveData: true } }, withRtc).eligible).toBe(false);
    expect(probeHostEligibility({ userAgent: desktop, hardwareConcurrency: 4 }, withRtc).recommendedGuests).toBe(2);
    expect(probeHostEligibility({ userAgent: desktop, hardwareConcurrency: 2 }, withRtc).recommendedGuests).toBe(1);
  });

  it('refuses a browser with no WebRTC at all', () => {
    expect(probeHostEligibility({ userAgent: 'whatever' }, false).eligible).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The whole thing, working
 * ------------------------------------------------------------------------ */

describe('two peers over WebRTC', () => {
  it('connects and runs the real binary protocol through the real room', async () => {
    const w = await makeWorld();
    expect(w.host.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    const guest = await w.addGuest('Guest');
    expect(guest.transport.readyState).toBe(1);

    w.step(25, 200);

    // The guest is a full participant: welcomed, streamed world, predicting
    // against snapshots, and the room counts two humans.
    expect(guest.client.playerId).toBeGreaterThan(0);
    expect(guest.client.playerId).not.toBe(w.hostClient.playerId);
    expect(guest.client.world.chunkCount).toBeGreaterThan(0);
    expect(guest.snapshots).toBeGreaterThan(20);
    expect(guest.status).toBe('playing');

    let status: Record<string, unknown> = {};
    w.host.requestStatus((s) => { status = s; });
    expect(status.humans).toBe(2);
    expect(status.peers).toBe(2); // the host's own connection plus the guest

    // And the reliability split actually happened on the wire. Direction has
    // to be checked explicitly: C2S and S2C reuse the same id numbers, and
    // C2S.INPUT and S2C.CHUNK are both 2.
    const fromHost = (e: { from: string }): boolean => e.from.startsWith('host');
    const rt = w.rtc.log.filter((e) => e.label === 'dc-rt');
    const rel = w.rtc.log.filter((e) => e.label === 'dc-rel');
    expect(rt.length).toBeGreaterThan(20);
    expect(rel.length).toBeGreaterThan(0);

    // Host -> guest on the unreliable channel: snapshots and pongs, nothing
    // else. Byte 2, because bytes 0-1 are the transport sequence prefix.
    const s2cRt = new Set(rt.filter(fromHost).map((e) => e.bytes[2]));
    expect(s2cRt.has(S2C.SNAPSHOT)).toBe(true);
    expect([...s2cRt].every((id) => id === S2C.SNAPSHOT || id === S2C.PONG)).toBe(true);

    // Guest -> host on the unreliable channel: input and pings, nothing else.
    const c2sRt = new Set(rt.filter((e) => !fromHost(e)).map((e) => e.bytes[2]));
    expect(c2sRt.has(C2S.INPUT)).toBe(true);
    expect([...c2sRt].every((id) => id === C2S.INPUT || id === C2S.PING)).toBe(true);

    // The world stream and the handshake went reliably, and no snapshot did.
    const s2cRel = new Set(rel.filter(fromHost).map((e) => e.bytes[0]));
    expect(s2cRel.has(S2C.CHUNK)).toBe(true);
    expect(s2cRel.has(S2C.WELCOME)).toBe(true);
    expect(s2cRel.has(S2C.SNAPSHOT)).toBe(false);
    const c2sRel = new Set(rel.filter((e) => !fromHost(e)).map((e) => e.bytes[0]));
    expect(c2sRel.has(C2S.HELLO)).toBe(true);
    expect(c2sRel.has(C2S.INPUT)).toBe(false);
  });

  it('repairs a lost snapshot with a full one, and never stalls', async () => {
    const w = await makeWorld();
    const guest = await w.addGuest('Guest');
    w.step(25, 160);

    const before = guest.snapshots;
    const fullsBefore = guest.snapshotFull.filter(Boolean).length;

    // Lose the next host->guest snapshot. `net.ts` rolls its delta baseline
    // forward at SEND time with no ack, so without repair the guest would be
    // decoding player deltas against a baseline it never received.
    let dropped = false;
    w.rtc.drop = (info): boolean => {
      if (dropped || info.label !== 'dc-rt') return false;
      if (info.bytes[2] !== S2C.SNAPSHOT) return false;
      dropped = true;
      return true;
    };

    w.step(25, 20);
    w.rtc.drop = null;
    w.step(25, 20);

    expect(dropped).toBe(true);
    // The stream kept flowing across the gap: 40 steps of 25 ms is one second,
    // and a 20 Hz snapshot stream should have delivered most of 20 more. On a
    // reliable channel every one of them would have queued behind the loss.
    expect(guest.snapshots - before).toBeGreaterThan(12);

    // The guest noticed, asked, and the room answered with a full snapshot —
    // the repair path, all the way through the unmodified delta encoder.
    const stats = guest.transport.stats();
    expect(stats.datagramsLost).toBeGreaterThanOrEqual(1);
    expect(stats.resyncsRequested).toBeGreaterThanOrEqual(1);
    expect(guest.snapshotFull.filter(Boolean).length).toBeGreaterThan(fullsBefore);
  });
});

/* ------------------------------------------------------------------------ *
 * The cap
 * ------------------------------------------------------------------------ */

describe('peer cap', () => {
  it('refuses the guest beyond the cap instead of degrading the room', async () => {
    const w = await makeWorld({ maxGuests: 1 });
    expect(w.host.maxGuests).toBe(1);

    await w.addGuest('First');
    w.step(25, 40);
    expect(w.host.guestCount).toBe(1);

    // The hub knows the cap too, so the second joiner is turned away before a
    // single ICE candidate is gathered.
    await expect(w.addGuest('Second')).rejects.toThrow(/room-full/);
    expect(w.host.guestCount).toBe(1);
  });

  it('the host does not trust the hub: it refuses over-cap peers itself', async () => {
    const w = await makeWorld({ maxGuests: 1 });
    await w.addGuest('First');
    w.step(25, 40);

    const wireBefore = w.rtc.log.length;
    injectPeer(w, 'g99');

    const refusals = w.hostEvents.filter((e) => e.t === 'guest-refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ why: 'room-full' });
    expect(w.host.guestCount).toBe(1);
    // Refused before any RTCPeerConnection existed: nothing new on the wire.
    expect(w.rtc.log.length).toBe(wireBefore);
  });

  it('staggers admissions so the 2.98 MB join burst does not pile up', async () => {
    const w = await makeWorld({ maxGuests: 3 });
    await w.addGuest('First');
    w.step(25, 4); // 100 ms — well inside JOIN_STAGGER_MS

    injectPeer(w, 'g50');
    expect(w.hostEvents.filter((e) => e.t === 'guest-refused'))
      .toMatchObject([{ why: 'joining-too-fast' }]);

    w.step(JOIN_STAGGER_MS, 1);
    injectPeer(w, 'g51');
    expect(w.hostEvents.filter((e) => e.t === 'guest-joined')).toHaveLength(2);
  });

  it('never lets a configuration mistake produce a 32-player peer room', async () => {
    const w = await makeWorld({ maxGuests: 31 });
    expect(w.host.maxGuests).toBeLessThanOrEqual(PEER_CAP_MAX);
    // The device recommendation binds first when it is the lower of the two.
    expect(w.host.maxGuests).toBe(3);
  });
});

/* ------------------------------------------------------------------------ *
 * Host departure — the match ends, and here is how it feels
 * ------------------------------------------------------------------------ */

describe('host departure', () => {
  it('a host that quits ends the match immediately, with a reason', async () => {
    const w = await makeWorld();
    const guest = await w.addGuest('Guest');
    w.step(25, 160);
    expect(guest.status).toBe('playing');
    const chunksBefore = guest.client.world.chunkCount;

    w.host.stop('host closed the game');
    w.rtc.flush();

    expect(guest.closedWith).toEqual([1000, 'peer left']);
    expect(guest.status).toBe('closed');
    const departure = describeHostDeparture(...(guest.closedWith as [number, string]));
    expect(departure.graceful).toBe(true);
    expect(departure.matchOver).toBe(true);

    // The world is NOT thrown away — `resetSession()` keeps it — so continuing
    // on a server room with the same seed costs no re-download.
    expect(guest.client.world.chunkCount).toBe(chunksBefore);
    expect(chunksBefore).toBeGreaterThan(0);
  });

  it('a host that vanishes is detected in seconds, not the 15 s socket timeout', async () => {
    const w = await makeWorld();
    const guest = await w.addGuest('Guest');
    w.step(25, 160);

    // A closed laptop lid: the host stops producing and stops acknowledging,
    // and no FIN is ever sent. Only virtual time moves.
    const start = w.now();
    let t = start;
    for (let i = 0; i < 10 && guest.closedWith === null; i++) {
      t += 600;
      guest.transport.link.pump(t);
    }

    expect(guest.closedWith).toEqual([1006, 'peer silent']);
    // Detected inside one probe interval of PEER_SILENCE_MS, and nowhere near
    // the 15 s a plain socket timeout would have taken.
    expect(t - start).toBeLessThanOrEqual(PEER_SILENCE_MS + 600);
    const departure = describeHostDeparture(...(guest.closedWith as [number, string]));
    expect(departure.graceful).toBe(false);
    expect(departure.matchOver).toBe(true);
    expect(departure.message).toMatch(/Lost connection/);
  });

  it('losing signalling does not end a match that is already connected', async () => {
    const w = await makeWorld();
    const guest = await w.addGuest('Guest');
    w.step(25, 160);
    const before = guest.snapshots;

    w.hub.closeAll();
    w.step(25, 40);

    expect(guest.closedWith).toBeNull();
    expect(guest.snapshots).toBeGreaterThan(before);
  });
});

/* ------------------------------------------------------------------------ *
 * The economy rule
 * ------------------------------------------------------------------------ */

describe('a peer room awards nothing', () => {
  it('runs with no persistence store, so there is no path to a reward', async () => {
    const w = await makeWorld();
    await w.addGuest('Guest');
    w.step(25, 80);

    // Anything that grants XP, Scrap, a drop, a leaderboard place or a share
    // card has to go through `PersistenceStore`, and `localServer.ts` builds
    // the room with `store: null`. The absence is structural, not a policy that
    // someone can forget. `persistMember()` in room.ts returns immediately.
    let status: Record<string, unknown> = {};
    w.host.requestStatus((s) => { status = s; });
    expect(status.name).toBe('local');
    expect(status.humans).toBe(2);
  });
});
