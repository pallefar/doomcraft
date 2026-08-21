/**
 * DOOMCRAFT — the WebRTC transport, at the link level.
 *
 * These tests are about the two things a browser cannot be made to do on
 * demand: lose a packet, and lose exactly the packet you wanted. Everything
 * here runs against `rtcFake.ts`, so loss is an input rather than a hope.
 *
 * The integration — a real Room, a real NetClient and the real signalling hub,
 * two peers, the binary protocol end to end — is in peerHost.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { C2S, S2C } from '@shared';
import { C2S_MODE, S2C_MODE } from '@shared/modes';

import {
  DatagramCounter,
  Reliability,
  clientMessageReliability,
  decodeCtrl,
  encodeCtrl,
  frameDatagram,
  isCtrlFrame,
  seqDelta,
  serverMessageReliability,
  CtrlType,
} from './transport.js';
import { FakeRtcNetwork } from './rtcFake.js';
import {
  PEER_SILENCE_MS,
  PeerLink,
  RESYNC_MIN_INTERVAL_MS,
  type SignalPort,
} from './webrtc.js';
import type { SignalC2S, SignalS2C } from '@shared/signal';

/* ------------------------------------------------------------------------ *
 * A two-ended signalling loop with no server in it
 * ------------------------------------------------------------------------ */

function signalPair(): { a: SignalPort; b: SignalPort } {
  const make = (name: string): SignalPort & { peer?: SignalPort } => ({
    open: true,
    onMessage: null,
    onClose: null,
    send(msg: SignalC2S): void {
      // The hub rewrites `to` into `from` before relaying; this two-ended stub
      // does the same, so the link sees exactly the shape it would in prod.
      const out = { ...(msg as unknown as Record<string, unknown>) };
      delete out.to;
      out.from = name;
      (this as { peer?: SignalPort }).peer?.onMessage?.(out as unknown as SignalS2C);
    },
    close(): void { (this as { open: boolean }).open = false; },
  });
  const a = make('a');
  const b = make('b');
  a.peer = b;
  b.peer = a;
  return { a, b };
}

interface Pair {
  net: FakeRtcNetwork;
  guest: PeerLink;
  host: PeerLink;
  guestGot: Uint8Array[];
  hostGot: Uint8Array[];
  hostResyncs: number;
  connect(): Promise<void>;
}

async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function makePair(now: () => number = () => 0): Pair {
  const net = new FakeRtcNetwork();
  const { a, b } = signalPair();
  const guestGot: Uint8Array[] = [];
  const hostGot: Uint8Array[] = [];

  const guest = new PeerLink({
    role: 'offerer', remoteId: 'h', signal: a, rtc: net.factory(),
    now, autoPump: false, requestResyncOnLoss: true,
  });
  const host = new PeerLink({
    role: 'answerer', remoteId: 'g1', signal: b, rtc: net.factory(),
    now, autoPump: false, requestResyncOnLoss: false,
  });

  const pair: Pair = {
    net, guest, host, guestGot, hostGot, hostResyncs: 0,
    async connect(): Promise<void> {
      await guest.start();
      await settle();
    },
  };

  guest.onData = (b2): void => { guestGot.push(b2.slice()); };
  host.onData = (b2): void => { hostGot.push(b2.slice()); };
  host.onResyncRequest = (): void => { pair.hostResyncs++; };
  a.onMessage = (m): void => { guest.handleSignal(m); };
  b.onMessage = (m): void => { host.handleSignal(m); };

  return pair;
}

/* ------------------------------------------------------------------------ *
 * Reliability routing — the one decision this layer makes
 * ------------------------------------------------------------------------ */

describe('reliability routing', () => {
  it('sends only superseded traffic unreliably', () => {
    expect(clientMessageReliability(C2S.INPUT)).toBe(Reliability.UNRELIABLE);
    expect(clientMessageReliability(C2S.PING)).toBe(Reliability.UNRELIABLE);
    expect(serverMessageReliability(S2C.SNAPSHOT)).toBe(Reliability.UNRELIABLE);
    expect(serverMessageReliability(S2C.PONG)).toBe(Reliability.UNRELIABLE);
  });

  it('never risks a one-shot message on the unreliable channel', () => {
    // A lost chunk is a permanently missing piece of world; a lost block delta
    // is a wall that exists on one screen and not the other, forever.
    for (const id of [S2C.WELCOME, S2C.CHUNK, S2C.BLOCK_DELTA, S2C.DAMAGE, S2C.KILL, S2C.CHAT]) {
      expect(serverMessageReliability(id)).toBe(Reliability.RELIABLE);
    }
    for (const id of [C2S.HELLO, C2S.BLOCK_EDIT, C2S.CHAT, C2S.RESPAWN, C2S.APPEARANCE]) {
      expect(clientMessageReliability(id)).toBe(Reliability.RELIABLE);
    }
  });

  it('keeps the mode sidecar reliable — it is not superseded', () => {
    // S2C_MODE.STATE looks like a snapshot companion, but the room only sends
    // it when a field CHANGED, so a lost one stays wrong until the next change.
    expect(serverMessageReliability(S2C_MODE.STATE)).toBe(Reliability.RELIABLE);
    expect(serverMessageReliability(S2C_MODE.EVENT)).toBe(Reliability.RELIABLE);
    expect(serverMessageReliability(S2C_MODE.CONTEXT)).toBe(Reliability.RELIABLE);
    expect(clientMessageReliability(C2S_MODE.SELECT)).toBe(Reliability.RELIABLE);
    expect(clientMessageReliability(C2S_MODE.ACTION)).toBe(Reliability.RELIABLE);
  });

  it('defaults an unknown id to reliable', () => {
    expect(serverMessageReliability(200)).toBe(Reliability.RELIABLE);
    expect(clientMessageReliability(200)).toBe(Reliability.RELIABLE);
  });
});

/* ------------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------------ */

describe('datagram framing', () => {
  it('control frames cannot collide with the game protocol', () => {
    // The base protocol uses 1..8 and the mode extension 16..18; 9..15 are
    // reserved. Anything a control frame uses must be outside all of them.
    const frame = encodeCtrl(CtrlType.RESYNC, 7);
    expect(isCtrlFrame(frame)).toBe(true);
    expect(frame[0]).toBeGreaterThan(18);
    expect(decodeCtrl(frame)).toEqual({ type: CtrlType.RESYNC, arg: 7 });
    for (const id of [C2S.HELLO, C2S.INPUT, S2C.SNAPSHOT, S2C_MODE.CONTEXT]) {
      expect(isCtrlFrame(Uint8Array.of(id, 0, 0, 0, 0, 0))).toBe(false);
    }
  });

  it('counts loss across a 16-bit wrap without a false positive', () => {
    expect(seqDelta(0xfffe, 1)).toBe(3);
    expect(seqDelta(5, 4)).toBe(-1);

    const c = new DatagramCounter();
    expect(c.accept(0xfffd)).toBe(0);
    expect(c.accept(0xfffe)).toBe(0);
    // 0xffff went missing, then the counter wrapped.
    expect(c.accept(0)).toBe(1);
    expect(c.lost).toBe(1);
    // A straggler that lost the race is dropped, not applied backwards: an
    // out-of-order snapshot would rewind every remote player by 50 ms.
    expect(c.accept(0xffff)).toBe(-1);
    expect(c.reordered).toBe(1);
  });

  it('round-trips a sequence prefix', () => {
    const framed = frameDatagram(0x1234, Uint8Array.of(3, 9, 9));
    expect(framed[0] | (framed[1] << 8)).toBe(0x1234);
    expect([...framed.subarray(2)]).toEqual([3, 9, 9]);
  });
});

/* ------------------------------------------------------------------------ *
 * The link
 * ------------------------------------------------------------------------ */

describe('peer link', () => {
  it('establishes over signalling and carries bytes both ways', async () => {
    const p = makePair();
    await p.connect();

    expect(p.guest.isOpen).toBe(true);
    expect(p.host.isOpen).toBe(true);

    p.host.sendGame(Uint8Array.of(S2C.SNAPSHOT, 1, 2, 3), Reliability.UNRELIABLE);
    p.host.sendGame(Uint8Array.of(S2C.CHUNK, 4, 5), Reliability.RELIABLE);
    p.guest.sendGame(Uint8Array.of(C2S.INPUT, 7), Reliability.UNRELIABLE);
    p.net.flush();

    expect(p.guestGot.map((b) => [...b])).toEqual([[S2C.SNAPSHOT, 1, 2, 3], [S2C.CHUNK, 4, 5]]);
    expect(p.hostGot.map((b) => [...b])).toEqual([[C2S.INPUT, 7]]);

    // The sequence prefix is transport framing and must never reach the
    // protocol decoders.
    expect(p.guestGot[0].length).toBe(4);
  });

  it('puts each message on the channel the routing table chose', async () => {
    const p = makePair();
    await p.connect();
    p.host.sendGame(Uint8Array.of(S2C.SNAPSHOT), Reliability.UNRELIABLE);
    p.host.sendGame(Uint8Array.of(S2C.CHUNK), Reliability.RELIABLE);
    p.net.flush();

    const rt = p.net.log.filter((e) => e.label === 'dc-rt');
    const rel = p.net.log.filter((e) => e.label === 'dc-rel');
    expect(rt.some((e) => e.bytes[2] === S2C.SNAPSHOT)).toBe(true);
    expect(rt.some((e) => e.bytes[2] === S2C.CHUNK)).toBe(false);
    expect(rel.some((e) => e.bytes[0] === S2C.CHUNK)).toBe(true);
  });

  it('DROPS A DATAGRAM WITHOUT STALLING THE ONES BEHIND IT', async () => {
    let now = 0;
    const p = makePair(() => now);
    await p.connect();

    // Lose exactly the third host->guest datagram.
    let n = 0;
    p.net.drop = (info): boolean => info.label === 'dc-rt' && info.from === 'pc2' && ++n === 3;

    for (let i = 0; i < 6; i++) {
      p.host.sendGame(Uint8Array.of(S2C.SNAPSHOT, i), Reliability.UNRELIABLE);
      p.net.flush();
    }

    // Five of six arrive, and — the point of the test — number four is here,
    // delivered on its own tick rather than queued behind the retransmit of
    // number three. On a reliable channel this array would be [0,1] until the
    // retransmit landed.
    expect(p.guestGot.map((b) => b[1])).toEqual([0, 1, 3, 4, 5]);

    const stats = p.guest.stats();
    expect(stats.datagramsLost).toBe(1);
    expect(stats.datagramsReceived).toBe(5);
    expect(stats.resyncsRequested).toBe(1);

    // And the far side was told, so it can rebuild the delta baseline.
    p.net.flush();
    expect(p.hostResyncs).toBe(1);
  });

  it('rate limits repair requests so loss cannot cost more than it repairs', async () => {
    let now = 0;
    const p = makePair(() => now);
    await p.connect();
    p.net.drop = (info): boolean => info.label === 'dc-rt' && info.from === 'pc2' && info.index % 2 === 0;

    for (let i = 0; i < 20; i++) {
      p.host.sendGame(Uint8Array.of(S2C.SNAPSHOT, i), Reliability.UNRELIABLE);
      p.net.flush();
      now += 10;
    }
    // 20 datagrams, 10 lost, 200 ms of virtual time: at most one request.
    expect(p.guest.stats().datagramsLost).toBeGreaterThanOrEqual(9);
    expect(p.guest.stats().resyncsRequested).toBe(1);

    now += RESYNC_MIN_INTERVAL_MS + 1;
    p.host.sendGame(Uint8Array.of(S2C.SNAPSHOT, 99), Reliability.UNRELIABLE);
    p.host.sendGame(Uint8Array.of(S2C.SNAPSHOT, 100), Reliability.UNRELIABLE);
    p.net.flush();
    expect(p.guest.stats().resyncsRequested).toBe(2);
  });

  it('fragments a reliable message over the SCTP size limit and reassembles it', async () => {
    const p = makePair();
    await p.connect();

    // Worst case for `encodeChunk` is rleMaxBytes(65536) = 196,608 bytes, three
    // times the 64 KB floor. Oversending does not truncate — it closes the
    // channel — so this path is load bearing for the world stream.
    const big = new Uint8Array(150_000);
    big[0] = S2C.CHUNK;
    for (let i = 1; i < big.length; i++) big[i] = i & 0xff;

    p.host.sendGame(big, Reliability.RELIABLE);
    p.net.flush();

    expect(p.guestGot.length).toBe(1);
    expect(p.guestGot[0].length).toBe(big.length);
    expect(p.guestGot[0][0]).toBe(S2C.CHUNK);
    expect(p.guestGot[0][149_999]).toBe(big[149_999]);
    expect(p.host.stats().fragmentsSent).toBeGreaterThan(1);
  });

  it('declares a silent peer dead in seconds, not the 15 s socket timeout', async () => {
    let now = 0;
    const p = makePair(() => now);
    await p.connect();

    const closes: Array<[number, string]> = [];
    p.guest.onClose = (c, r): void => { closes.push([c, r]); };

    now += PEER_SILENCE_MS - 1;
    p.guest.pump(now);
    expect(closes).toHaveLength(0);

    now += 2;
    p.guest.pump(now);
    expect(closes).toEqual([[1006, 'peer silent']]);
    expect(p.guest.isOpen).toBe(false);
  });

  it('a graceful close reaches the far side as a BYE, not as silence', async () => {
    const p = makePair();
    await p.connect();
    const closes: Array<[number, string]> = [];
    p.guest.onClose = (c, r): void => { closes.push([c, r]); };

    p.host.close(1000, 'host left');
    p.net.flush();

    expect(closes).toEqual([[1000, 'peer left']]);
  });

  it('reports whether the connection went through TURN', async () => {
    const p = makePair();
    await p.connect();
    expect(await p.guest.probeRelay()).toBe(false);
    p.net.relayed = true;
    expect(await p.guest.probeRelay()).toBe(true);
  });
});
