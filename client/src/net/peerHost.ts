/**
 * DOOMCRAFT — the host-authoritative peer.
 *
 * This is the existing worker server with DataChannels bolted to the side. It
 * is NOT a second implementation of anything: `localServer.ts` already runs
 * `room.ts` / `sim.ts` / `world.ts` / `net.ts` in a Worker and speaks the same
 * binary protocol as the real server, and `Room` has always been
 * multi-connection. All this file adds is (a) more connections, (b) a WebRTC
 * pipe per connection, and (c) the refusals.
 *
 * ============================================================================
 * THE FOUR HARD RULES. Each one is enforced here, in code.
 * ============================================================================
 *
 * 1. A PEER ROOM AWARDS NOTHING.
 *    A host-authoritative peer runs `sim.ts` in readable JavaScript on
 *    hardware the player owns. Every anti-cheat guard in the tree — the
 *    `MAX_INPUT_DT_MS` clamp, the `INPUT_TIME_SCALE` time bank, `OUT_OF_REACH`
 *    edit rejection, lag-compensated hitscan — protects the room FROM its
 *    clients. None of them protects anyone from the room's owner, who can
 *    fabricate kills, wave counts, drops, match duration and results at will.
 *    docs/ECONOMY.md decision 1 is "the server grants every reward; the client
 *    never does". So: `store: null` in the room (localServer.ts), and no path
 *    from here to the profile API. XP, Scrap, drops, leaderboard, share cards
 *    and challenge progress are all absent by construction, not by policy.
 *
 * 2. ONLY QUEST CO-OP MAY BE PEER HOSTED.
 *    Deathmatch is ranked and drops tradable items. Builder owns a persistent
 *    world other players come back to, and a peer cannot own that. Horde
 *    lists "waves survived" as an XP source, so peer-hosting it would mean
 *    deleting Horde's progression — a product cost no bandwidth saving covers.
 *    `hostableMode()` refuses all three.
 *
 * 3. NEVER ELECT A PHONE AS HOST.
 *    Not bandwidth — the room runs in a dedicated Worker and worker timers
 *    survive Chrome's intensive throttling (see keepalive.worker.ts), so a
 *    backgrounded DESKTOP host keeps ticking. But iOS Safari suspends
 *    background JavaScript within seconds: one phone call, one notification,
 *    one app switch, and the match is over for everyone in it. See
 *    `probeHostEligibility()`.
 *
 * 4. REFUSE, DO NOT DEGRADE.
 *    The star tops out well before bandwidth does. A guest beyond the cap is
 *    turned away at signalling, before any ICE work is done — never admitted
 *    into a room that then quietly drops its snapshot rate for everybody.
 *
 * ============================================================================
 * HOST MIGRATION: THERE IS NONE. THE MATCH ENDS. HERE IS WHAT THAT COSTS.
 * ============================================================================
 *
 * The honest options were "transfer authority to another peer" or "end the
 * match", and transfer loses on every axis that matters here:
 *
 *   Detection.   A closed laptop lid sends no FIN. The socket does not close,
 *                it stops, and to every guest that is indistinguishable from
 *                packet loss. The existing floor is `CLIENT_TIMEOUT_MS` = 15 s.
 *                A dedicated probe gets that to ~3 s (`PEER_SILENCE_MS`) and
 *                not much below — a mobile radio handover can black-hole a
 *                link for over a second, and ending matches on handovers would
 *                be a worse bug than the one being fixed.
 *   Re-seeding.  The new host must have the world and the live state. Shipping
 *                it is 2.98 MB — 2.0 s on a median mobile uplink, 1.2 s on
 *                cable — plus entities, projectiles, scores and player state.
 *   Shadowing.   Avoiding the re-seed means every peer simulates in parallel:
 *                double the CPU on every device, and it re-opens cross-engine
 *                divergence, because `sim.ts` moveStep calls `Math.sin` /
 *                `Math.cos` on the core per-tick movement path and ECMAScript
 *                does not require those to be bit-identical. A Safari peer and
 *                a Chrome peer can disagree on the first tick.
 *   Re-ICE.      Every surviving guest must renegotiate to the new host: fresh
 *                ICE plus DTLS, 0.5-2 s each, longer through TURN, and each
 *                one re-rolls the relay dice. NAT reachability is pairwise —
 *                a guest who could reach the old host may have no path at all
 *                to the new one.
 *   Exploit.     A losing host can force a migration deliberately.
 *
 * Realistic total: 5-20 seconds of frozen, then partly broken, match. For a
 * four-player unranked co-op run that awards nothing, that is worse than a
 * clean end.
 *
 * WHAT A PLAYER ACTUALLY EXPERIENCES
 *
 *   Host quits, closes the tab, or navigates away
 *     -> `pagehide` fires, every guest gets a BYE on the reliable channel,
 *        and sees "Host left the game" within one round trip (<200 ms).
 *   Host closes the lid, loses power, or the browser is killed
 *     -> no BYE. Guests see the world freeze, and after 3 s of total silence
 *        get "Lost connection to host". Not 15 s.
 *   Either way
 *     -> the run ends. Nothing was being awarded, so nothing is lost except
 *        the run itself. The downloaded WORLD survives in `ClientWorld` (the
 *        client's `resetSession()` deliberately keeps it), so continuing on a
 *        server-hosted room with the same seed does not re-download 2.98 MB.
 *   Host on a phone
 *     -> never happens; they could not have hosted (rule 3). An all-mobile
 *        lobby has no eligible host and falls back to a real server, which is
 *        also why the server fleet can be run at lower utilisation but can
 *        never be decommissioned.
 */

import { GameMode } from '@shared';
import { ModeId, legacyGameMode } from '@shared/modes';
import {
  SIGNAL_PROTOCOL_VERSION,
  type IceServerConfig,
  type SignalC2S,
  type SignalS2C,
} from '@shared/signal';

import { createLocalServer, LOCAL_PEER_ID, type LocalServer } from './localServer.js';
import type { ClientTransport } from './transport.js';
import {
  webRtcServerTransport,
  type RtcFactory,
  type SignalPort,
  type WebRtcServerTransport,
} from './webrtc.js';

/* ------------------------------------------------------------------------ *
 * Caps
 *
 * These come from the measured star limits, not from taste. Host upstream for
 * a deathmatch-shaped room (33 entities) at 20 Hz snapshots plus WebRTC's
 * 93-byte per-datagram framing:
 *
 *     N=4   0.45 Mbps up,   60 pps
 *     N=8   1.13 Mbps up,  140 pps
 *     N=16  2.76 Mbps up,  300 pps
 *     N=32  7.10 Mbps up,  620 pps
 *
 * Bandwidth is not the binding constraint — a median fixed line has 51 Mbps
 * up. What binds is the join burst (169 chunks, 2.98 MB, re-encoded per
 * joiner: 8.94 MB at N=4, 44.7 MB at N=16, blocking the host's uplink for
 * seconds), the per-joiner CPU (20-50 ms measured on an M3 Pro), and the fact
 * that a cheating host is free.
 * ------------------------------------------------------------------------ */

/** Guests in the recommended build: Quest co-op, four players including host. */
export const PEER_CAP_DEFAULT = 3;

/**
 * Hard ceiling on guests, whatever the caller asks for. 8 players is the
 * largest star the assessment calls safe, and the only mode allowed to peer
 * host caps at 4 anyway — so this exists purely so a config mistake cannot
 * quietly produce a 32-player peer room.
 */
export const PEER_CAP_MAX = 7;

/**
 * Minimum gap between admitting guests.
 *
 * The join burst lands on the HOST, not on us: `net.ts` streams all 169 chunks
 * to every joiner and re-runs `encodeChunk` per client. One joiner is 2.98 MB
 * and 20-50 ms of CPU; three arriving together is 8.94 MB back to back, which
 * is 3.6 s of a 20 Mbps cable uplink with the live match sharing it.
 *
 * Staggering is time-based rather than progress-based on purpose: per-peer
 * chunk progress lives on `Connection` inside the Worker, and plumbing it out
 * would put a second, weaker copy of `net.ts`'s bookkeeping on the page. Four
 * seconds is a measured upper bound for one joiner on cable, not a guess.
 */
export const JOIN_STAGGER_MS = 4000;

/* ------------------------------------------------------------------------ *
 * Who may host
 * ------------------------------------------------------------------------ */

export type DeviceClass = 'desktop' | 'mobile' | 'unknown';

export interface HostEligibility {
  eligible: boolean;
  deviceClass: DeviceClass;
  /** Player-facing, one short sentence. */
  reason: string;
  /** Guests this device should be offered, never above `PEER_CAP_MAX`. */
  recommendedGuests: number;
}

/** The bits of `navigator` this check reads. Injected by tests. */
export interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  hardwareConcurrency?: number;
  userAgentData?: { mobile?: boolean; platform?: string };
  connection?: { type?: string; effectiveType?: string; saveData?: boolean };
}

/**
 * May this device host? The answer is "no" far more often than people expect,
 * and every "no" here is a match that does not end badly later.
 */
export function probeHostEligibility(
  nav?: NavigatorLike | null,
  hasWebRtc = typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function',
): HostEligibility {
  const n = nav ?? (globalThis as unknown as { navigator?: NavigatorLike }).navigator ?? null;

  if (!hasWebRtc) {
    return { eligible: false, deviceClass: 'unknown', reason: 'This browser cannot host.', recommendedGuests: 0 };
  }
  if (n === null) {
    // Node, a test, a worker with no navigator. Nothing to disqualify on.
    return { eligible: true, deviceClass: 'unknown', reason: '', recommendedGuests: PEER_CAP_DEFAULT };
  }

  const ua = n.userAgent ?? '';
  const uaMobile = n.userAgentData?.mobile === true;
  // iPadOS 13+ reports itself as a Mac. Touch points is the reliable tell.
  const iPadAsMac = /Macintosh/.test(ua) && (n.maxTouchPoints ?? 0) > 1;
  const uaLooksMobile = /iPhone|iPad|iPod|Android|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua);

  if (uaMobile || iPadAsMac || uaLooksMobile) {
    return {
      eligible: false,
      deviceClass: 'mobile',
      // The real reason, not a euphemism: iOS Safari suspends background JS in
      // seconds, so a phone host ends the match on the first incoming call.
      reason: 'Phones and tablets cannot host — the match would end when your screen sleeps.',
      recommendedGuests: 0,
    };
  }

  if (n.connection?.type === 'cellular' || n.connection?.effectiveType === '2g' || n.connection?.saveData === true) {
    return {
      eligible: false,
      deviceClass: 'desktop',
      reason: 'A metered or cellular connection cannot host.',
      recommendedGuests: 0,
    };
  }

  // The host renders the game AND runs the simulation AND re-encodes the world
  // for every joiner. Fewer cores does not make it ineligible, it makes it a
  // smaller room — which is a capacity decision taken up front, not a
  // mid-match degrade.
  const cores = n.hardwareConcurrency ?? 8;
  const recommendedGuests = cores >= 8 ? PEER_CAP_DEFAULT : cores >= 4 ? 2 : 1;

  return { eligible: true, deviceClass: 'desktop', reason: '', recommendedGuests };
}

/* ------------------------------------------------------------------------ *
 * Which modes may be peer hosted
 * ------------------------------------------------------------------------ */

export interface ModeVerdict { allowed: boolean; reason: string }

/**
 * Rule 2, in code. This is the gate that keeps the economy off a peer's
 * machine, so it is a hard refusal rather than a warning.
 */
export function hostableMode(mode: ModeId): ModeVerdict {
  switch (mode) {
    case ModeId.QUEST:
      return { allowed: true, reason: '' };
    case ModeId.DEATHMATCH:
      return {
        allowed: false,
        reason: 'Deathmatch is ranked and drops tradable items — it runs on our servers only.',
      };
    case ModeId.BUILDER:
      return {
        allowed: false,
        reason: 'Builder worlds are persistent and live on our servers, not on a player.',
      };
    case ModeId.HORDE:
      return {
        allowed: false,
        reason: 'Horde awards XP for waves survived, so it runs on our servers.',
      };
    default:
      return { allowed: false, reason: 'This mode cannot be peer hosted.' };
  }
}

/* ------------------------------------------------------------------------ *
 * Why a guest was turned away
 * ------------------------------------------------------------------------ */

export type RefusalReason =
  | 'room-full'
  | 'joining-too-fast'
  | 'host-stopping'
  | 'duplicate';

export interface PeerGuestInfo {
  readonly id: number;
  readonly signalId: string;
  readonly joinedMs: number;
  readonly connected: boolean;
}

export type PeerHostEvent =
  | { t: 'code'; code: string }
  | { t: 'guest-joined'; id: number; signalId: string }
  | { t: 'guest-open'; id: number }
  | { t: 'guest-left'; id: number; code: number; reason: string }
  | { t: 'guest-refused'; signalId: string; why: RefusalReason }
  | { t: 'error'; message: string };

/* ------------------------------------------------------------------------ *
 * The host
 * ------------------------------------------------------------------------ */

export interface PeerHostOptions {
  /** An open signalling channel. `peerHost` sends `host` on it immediately. */
  signal: SignalPort;
  /** Must be `ModeId.QUEST`. Anything else throws. */
  mode: ModeId;
  seed?: number;
  enemies?: number;
  /** Bots to fill the room with. Co-op wants none. */
  botFill?: number;
  allWeapons?: boolean;
  /** Clamped to `PEER_CAP_MAX` and to the device's recommendation. */
  maxGuests?: number;
  /** Lobby label. Never rendered without escaping. */
  label?: string;

  rtc?: RtcFactory;
  iceServers?: IceServerConfig[];
  /** Diagnostics: force TURN, to exercise the relay path deliberately. */
  relayOnly?: boolean;
  /** Run the room on the main thread instead of a Worker. Tests. */
  inline?: boolean;
  /** Drive the room by hand via `advance()`. Requires `inline`. Tests. */
  manual?: boolean;
  /** Monotonic milliseconds. Tests inject a virtual clock. */
  now?: () => number;
  /** False in tests, which call `pump()` themselves. */
  autoPump?: boolean;
  /** Skip the device check. Tests only — never wire this to a setting. */
  eligibility?: HostEligibility;
  onEvent?(ev: PeerHostEvent): void;
}

export interface PeerHost {
  /** The host's own pipe into its own room. Hand this to `NetClient`. */
  readonly transport: ClientTransport;
  /** Resolves once the room exists. */
  readonly ready: Promise<void>;
  /** Only with `manual`: step the room. */
  advance(nowMs: number): void;
  /** Null until the signalling hub answers. */
  readonly code: string | null;
  readonly maxGuests: number;
  readonly guestCount: number;
  guests(): PeerGuestInfo[];
  /** Room status, delivered to `onStatus` if the caller supplied one. */
  requestStatus(onStatus: (s: Record<string, unknown>) => void): void;
  /** Drive liveness. Production wires this to a timer; tests call it directly. */
  pump(nowMs: number): void;
  /**
   * End the match on purpose: every guest gets a BYE first, so they see "host
   * left" immediately instead of waiting out `PEER_SILENCE_MS`.
   */
  stop(reason?: string): void;
}

interface Guest {
  id: number;
  signalId: string;
  transport: WebRtcServerTransport;
  joinedMs: number;
  connected: boolean;
  closed: boolean;
}

/**
 * Boot a peer-hosted room and serve guests over WebRTC.
 *
 * Throws — synchronously, before anything is allocated — when this device or
 * this mode is not allowed to host. That is deliberate: a refusal must be
 * impossible to ignore, and the caller has to have a server fallback anyway.
 */
export function createPeerHost(options: PeerHostOptions): PeerHost {
  const verdict = hostableMode(options.mode);
  if (!verdict.allowed) throw new Error(verdict.reason);

  const eligibility = options.eligibility ?? probeHostEligibility();
  if (!eligibility.eligible) throw new Error(eligibility.reason || 'This device cannot host.');

  const now = options.now ?? (() => Date.now());
  const emit = (ev: PeerHostEvent): void => { options.onEvent?.(ev); };

  const requested = options.maxGuests ?? eligibility.recommendedGuests;
  const maxGuests = Math.max(0, Math.min(requested, eligibility.recommendedGuests, PEER_CAP_MAX));

  let statusSink: ((s: Record<string, unknown>) => void) | null = null;

  const server: LocalServer = createLocalServer({
    seed: options.seed,
    mode: legacyGameMode(options.mode),
    botFill: options.botFill ?? 0,
    enemies: options.enemies ?? -1,
    allWeapons: options.allWeapons,
    // +1 for the host's own body. `Room` clamps to at least 2.
    maxPlayers: Math.max(2, maxGuests + 1),
    inline: options.inline,
    manual: options.manual,
    clock: options.now,
    onStatus: (s) => { statusSink?.(s); },
    onError: (m) => { emit({ t: 'error', message: m }); },
  });

  const guests = new Map<number, Guest>();
  const bySignalId = new Map<string, Guest>();
  let nextGuestId = LOCAL_PEER_ID + 1;
  let lastAdmitMs = -1e9;
  let code: string | null = null;
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pageHideHandler: (() => void) | null = null;

  /* --- room -> guest -------------------------------------------------- */

  server.onPeerData = (id, bytes): void => {
    guests.get(id)?.transport.send(bytes);
  };
  server.onPeerClosed = (id, closeCode, reason): void => {
    // The ROOM dropped this peer: timeout, message flood, protocol error, or
    // `server full` from `onHello`. Take the WebRTC link down with it.
    const g = guests.get(id);
    if (!g) return;
    dropGuest(g, closeCode, reason);
  };

  /* --- signalling ----------------------------------------------------- */

  const signal = options.signal;
  signal.onMessage = (msg: SignalS2C): void => {
    switch (msg.t) {
      case 'hosted':
        code = msg.code;
        emit({ t: 'code', code: msg.code });
        break;
      case 'peer':
        admit(msg.peer);
        break;
      case 'peer-gone': {
        const g = bySignalId.get(msg.peer);
        if (g) dropGuest(g, 1001, 'guest gave up during signalling');
        break;
      }
      case 'sdp':
      case 'ice': {
        const g = bySignalId.get(msg.from);
        if (g) g.transport.link.handleSignal(msg);
        break;
      }
      case 'error':
        emit({ t: 'error', message: msg.detail ? `${msg.code}: ${msg.detail}` : msg.code });
        break;
      default:
        break;
    }
  };
  signal.onClose = (): void => {
    // Losing signalling does NOT end the match: ICE is already done for every
    // connected guest, and the DataChannels carry on without it. It only means
    // nobody new can join.
    emit({ t: 'error', message: 'signalling closed; no new players can join' });
  };

  signal.send({
    t: 'host',
    v: SIGNAL_PROTOCOL_VERSION,
    cap: maxGuests,
    label: options.label,
  } satisfies SignalC2S);

  /* --- admission ------------------------------------------------------ */

  function refuse(signalId: string, why: RefusalReason): void {
    // Tell the hub, so the guest gets an answer instead of a timeout, and do it
    // BEFORE any RTCPeerConnection exists: a refused joiner costs this host
    // zero ICE gathering and zero DTLS.
    signal.send({ t: 'bye', to: signalId } satisfies SignalC2S);
    emit({ t: 'guest-refused', signalId, why });
  }

  function admit(signalId: string): void {
    if (stopping) { refuse(signalId, 'host-stopping'); return; }
    if (bySignalId.has(signalId)) { refuse(signalId, 'duplicate'); return; }

    // Rule 4: refuse, do not degrade.
    if (guests.size >= maxGuests) { refuse(signalId, 'room-full'); return; }

    const t = now();
    if (t - lastAdmitMs < JOIN_STAGGER_MS) { refuse(signalId, 'joining-too-fast'); return; }
    lastAdmitMs = t;

    const id = nextGuestId++;
    const guest: Guest = {
      id,
      signalId,
      joinedMs: t,
      connected: false,
      closed: false,
      transport: null as unknown as WebRtcServerTransport,
    };

    guest.transport = webRtcServerTransport({
      remoteId: signalId,
      signal,
      iceServers: options.iceServers,
      relayOnly: options.relayOnly,
      rtc: options.rtc,
      now: options.now,
      autoPump: options.autoPump,
      onData: (bytes) => { server.receiveFromPeer(id, bytes); },
      onOpen: () => {
        guest.connected = true;
        // Attach to the room only once the pipe is real, so a guest that never
        // completes ICE never occupies a player slot.
        server.openPeer(id);
        emit({ t: 'guest-open', id });
      },
      onResyncRequest: () => { server.resyncPeer(id); },
      onClose: (closeCode, reason) => { dropGuest(guest, closeCode, reason); },
    });

    guests.set(id, guest);
    bySignalId.set(signalId, guest);
    emit({ t: 'guest-joined', id, signalId });
  }

  function dropGuest(guest: Guest, closeCode: number, reason: string): void {
    if (guest.closed) return;
    guest.closed = true;
    guest.connected = false;
    guests.delete(guest.id);
    bySignalId.delete(guest.signalId);
    server.closePeer(guest.id, closeCode, reason);
    guest.transport.close(closeCode, reason);
    emit({ t: 'guest-left', id: guest.id, code: closeCode, reason });
  }

  /* --- host departure ------------------------------------------------- *
   * The graceful half of "the match ends". `pagehide` is the event that
   * actually fires on mobile Safari and on a bfcache navigation; `beforeunload`
   * does not reliably. Both are wired, both are idempotent.
   * -------------------------------------------------------------------- */

  const g = globalThis as unknown as {
    addEventListener?: (t: string, f: () => void) => void;
    removeEventListener?: (t: string, f: () => void) => void;
  };
  if (typeof g.addEventListener === 'function') {
    pageHideHandler = (): void => { stop('host closed the game'); };
    g.addEventListener('pagehide', pageHideHandler);
    g.addEventListener('beforeunload', pageHideHandler);
  }

  function stop(reason = 'host left'): void {
    if (stopping) return;
    stopping = true;
    if (timer !== null) { clearInterval(timer); timer = null; }
    if (pageHideHandler && typeof g.removeEventListener === 'function') {
      g.removeEventListener('pagehide', pageHideHandler);
      g.removeEventListener('beforeunload', pageHideHandler);
      pageHideHandler = null;
    }
    // BYE first, then teardown. This is the difference between "Host left the
    // game" in under a round trip and three seconds of a frozen world.
    for (const guest of [...guests.values()]) dropGuest(guest, 1000, reason);
    try { signal.send({ t: 'bye' } satisfies SignalC2S); } catch { /* already gone */ }
    signal.close();
    server.stop();
  }

  function pump(nowMs: number): void {
    for (const guest of [...guests.values()]) guest.transport.link.pump(nowMs);
  }

  if (options.autoPump !== false) {
    timer = setInterval(() => { pump(now()); }, 500);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  return {
    transport: server.transport,
    ready: server.ready,
    advance: (nowMs: number): void => { server.advance(nowMs); },
    get code(): string | null { return code; },
    get maxGuests(): number { return maxGuests; },
    get guestCount(): number { return guests.size; },
    guests(): PeerGuestInfo[] {
      return [...guests.values()].map((x) => ({
        id: x.id, signalId: x.signalId, joinedMs: x.joinedMs, connected: x.connected,
      }));
    },
    requestStatus(onStatus): void {
      statusSink = onStatus;
      server.requestStatus();
    },
    pump,
    stop,
  };
}

/* ------------------------------------------------------------------------ *
 * Guest-side: what the close code means
 * ------------------------------------------------------------------------ */

export interface HostDeparture {
  /** True when the host said goodbye rather than vanishing. */
  graceful: boolean;
  /** One short sentence for the player. */
  message: string;
  /**
   * Always true. There is no peer host migration — see the header. The
   * caller's move is a server-hosted room, which is available because the
   * server fleet can never be retired: an all-mobile lobby has no eligible
   * host at all.
   */
  matchOver: true;
}

/** Turn a transport close into something a human can read. */
export function describeHostDeparture(closeCode: number, reason: string): HostDeparture {
  if (closeCode === 1000) {
    return { graceful: true, message: 'The host left the game.', matchOver: true };
  }
  if (reason === 'peer silent') {
    return { graceful: false, message: 'Lost connection to the host.', matchOver: true };
  }
  if (reason === 'handshake timed out' || reason === 'ice failed') {
    return { graceful: false, message: 'Could not reach the host. Try a server game.', matchOver: true };
  }
  return { graceful: false, message: 'The match ended unexpectedly.', matchOver: true };
}

/** Sanity: the legacy sim switch a peer-hosted Quest room runs under. */
export const PEER_HOST_GAME_MODE: GameMode = legacyGameMode(ModeId.QUEST);
