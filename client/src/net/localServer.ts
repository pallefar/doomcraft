/**
 * DOOMCRAFT — the local server.
 *
 * The whole authoritative stack (room.ts, sim.ts, world.ts, bots.ts, net.ts)
 * runs inside a module Web Worker and speaks the exact same binary protocol as
 * the real server, over postMessage instead of a socket. That gives us:
 *
 *   - single player and offline play with zero code duplication,
 *   - a match that is live the instant the worker boots — no matchmaking,
 *     which is how we beat the bar's ~25 s cold start,
 *   - one code path to debug: if it works locally it works online.
 *
 * This file is BOTH the main-thread API and the worker entry. It detects which
 * side it is on; the heavy server modules are behind a dynamic import so the
 * main-thread bundle never pays for them.
 *
 * MULTI-PEER
 *
 * `Room` has always been multi-connection (`room.join()` per socket, an array
 * of `Connection` in net.ts); this file used to attach exactly one. It now
 * attaches any number, keyed by a small integer peer id, which is what turns
 * "the local server" into "the peer host" with no second copy of the
 * simulation. Peer 0 is always the hosting tab itself. `peerHost.ts` owns ids
 * 1..N and pipes them over WebRTC.
 *
 * Every worker data frame carries a 2-byte little-endian peer id in front of
 * the packet. That costs nothing: both directions already had to copy the
 * bytes out of a reused writer buffer before transferring them.
 */

import { TransportState, type ClientTransport, type ServerTransport } from './transport.js';
import type { Level } from '@shared/level';
import type { ContentResolver } from '@doomcraft/server/src/modes.js';
import { FLAG_ORDER, MAX_FLAG_BITS, defaultFlagBits } from '@shared/flags';
import { Feature, isEnabled } from '@shared/features';

/* ------------------------------------------------------------------------ *
 * The campaign, for the Worker room
 *
 * WHY THIS EXISTS. A Quest level used to live only in the CLIENT's voxel store
 * while the room this file boots went on simulating the player's body against
 * generated terrain. The client rewinds onto the server's answer every
 * snapshot, so the room's invisible hills decided where you could walk: you
 * fell through authored floors and stopped dead in empty corridors.
 *
 * The room now stamps the level into its own world (`Room.installLevels` ->
 * `applyLevelToWorld`), which means it needs the bytes. The ids come from the
 * bundler for free — a new .json in content/levels is a new campaign entry with
 * no code change, exactly as `quest.ts` promises — but the CONTENT is fetched
 * lazily, one level, the first time a room is actually asked to run it. A
 * Deathmatch session downloads none of it.
 * ------------------------------------------------------------------------ */

const BUNDLED_LEVEL_SOURCES = import.meta.glob(
  '../../../content/levels/*.json',
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

/** `../../../content/levels/e1m2-coolant.json` -> `e1m2-coolant`. */
function levelIdFromPath(path: string): string {
  const slash = path.lastIndexOf('/');
  const name = slash < 0 ? path : path.slice(slash + 1);
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

/**
 * `ContentResolver` over the bundled campaign.
 *
 * `resolveId` answers synchronously from the glob's keys, so a `SELECT` naming
 * a level that does not exist is still corrected on the spot. `levelFor` only
 * answers for levels already compiled; `requestLevel` is what pulls one in.
 */
function createBundledLevels(): ContentResolver {
  const sources = new Map<string, () => Promise<string>>();
  for (const path of Object.keys(BUNDLED_LEVEL_SOURCES)) {
    sources.set(levelIdFromPath(path), BUNDLED_LEVEL_SOURCES[path]);
  }
  const ids = [...sources.keys()].sort();
  const compiled = new Map<string, Level>();
  const inFlight = new Map<string, Promise<void>>();

  return {
    resolveId(requested: string): string {
      return sources.has(requested) ? requested : (ids[0] ?? '');
    },
    levelFor(id: string): Level | null {
      return compiled.get(id) ?? null;
    },
    requestLevel(id: string): Promise<void> {
      const running = inFlight.get(id);
      if (running !== undefined) return running;
      const load = sources.get(id);
      if (load === undefined) return Promise.resolve();
      const job = (async (): Promise<void> => {
        // Dynamic, so the level compiler rides in the room's chunk rather than
        // the page's: a tab that never opens the campaign never loads it.
        const [{ compileLevel, parseLevelJson }, raw] = await Promise.all([
          import('@shared/level'),
          load(),
        ]);
        const src = parseLevelJson(raw);
        if (src !== null) compiled.set(id, compileLevel(src));
      })().finally(() => { inFlight.delete(id); });
      inFlight.set(id, job);
      return job;
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Wire between the page and the worker
 * ------------------------------------------------------------------------ */

interface StartMessage {
  t: 'start';
  seed?: number;
  mode?: number;
  botFill?: number;
  enemies?: number;
  latencyMs?: number;
  allWeapons?: boolean;
  maxPlayers?: number;
  /** Skip `room.start()`; the caller drives `advance()`. Inline only. */
  manual?: boolean;
  /**
   * The flag bits this room hands its players in `S2C.SESSION_CONFIG`.
   *
   * Computed on the PAGE, because that is where localStorage and the query
   * string are; the worker has neither. See `localFlagBits()`.
   */
  flagBits?: number;
}
interface StopMessage { t: 'stop' }
interface StatusRequest { t: 'status' }
interface PeerOpenMessage { t: 'peer-open'; id: number }
interface PeerCloseMessage { t: 'peer-close'; id: number; code?: number; reason?: string }
/** Force this peer's next snapshot to be a full one. See `resyncPeer`. */
interface PeerResyncMessage { t: 'peer-resync'; id: number }
type ControlToWorker =
  | StartMessage | StopMessage | StatusRequest
  | PeerOpenMessage | PeerCloseMessage | PeerResyncMessage;

interface ReadyMessage { t: 'ready' }
interface StatusMessage { t: 'status'; status: Record<string, unknown> }
interface ErrorMessage { t: 'error'; message: string }
/** The room itself dropped a peer: timeout, protocol violation, room full. */
interface PeerClosedMessage { t: 'peer-closed'; id: number; code: number; reason: string }
type ControlToPage = ReadyMessage | StatusMessage | ErrorMessage | PeerClosedMessage;

/** The hosting tab's own connection. Never used for a remote peer. */
export const LOCAL_PEER_ID = 0;

export interface LocalServerOptions {
  seed?: number;
  /** GameMode. Defaults to deathmatch. */
  mode?: number;
  /** Bodies in the match, humans included. Defaults to BOT_FILL_TARGET. */
  botFill?: number;
  /** Doom monsters alive at once. -1 uses the mode default. */
  enemies?: number;
  /** Fake one-way latency in ms, for testing prediction. 0 by default. */
  latencyMs?: number;
  /** Spawn holding all seven weapons. Single player defaults to the arsenal. */
  allWeapons?: boolean;
  /** Room capacity, humans and bots together. Defaults to MAX_PLAYERS. */
  maxPlayers?: number;
  /** Skip the Worker and run the server on the main thread. */
  inline?: boolean;
  /**
   * Drive the room by hand instead of from a timer, via `LocalServer.advance`.
   * Requires `inline` — a Worker cannot be stepped synchronously. This exists
   * so the net stack can be tested on a virtual clock, which is the only way
   * packet loss and timeouts are reproducible.
   */
  manual?: boolean;
  /** Room clock. Defaults to `performance.now`. Pair with `manual` in tests. */
  clock?: () => number;
  onStatus?(status: Record<string, unknown>): void;
  onError?(message: string): void;
}

export interface LocalServer {
  /** Hand this to `new NetClient({ transport })`. Always peer 0. */
  readonly transport: ClientTransport;
  /** Resolves once the room exists. Rejects if it could not be built. */
  readonly ready: Promise<void>;
  /** Only meaningful with `manual`. Steps the room up to `nowMs`. */
  advance(nowMs: number): void;
  /** False when the Worker could not start and the server runs inline. */
  readonly inWorker: boolean;
  /** Ask the room for a status snapshot; the answer arrives via `onStatus`. */
  requestStatus(): void;
  stop(): void;

  /* --- multi-peer, used by peerHost.ts ------------------------------- */

  /** Attach a remote peer. Ids must be unique and non-zero. */
  openPeer(id: number): void;
  /** Feed one packet that arrived from a remote peer. */
  receiveFromPeer(id: number, bytes: Uint8Array): void;
  /** Detach a remote peer. Idempotent. */
  closePeer(id: number, code?: number, reason?: string): void;
  /**
   * Force this peer's next snapshot to be a baseline-free full one.
   *
   * This is the whole of the unreliable-transport repair, and it is why the
   * delta encoder in `server/src/net.ts` did not have to be touched: that file
   * decides "full or delta" from the public field `Connection.baselineTick`,
   * so a peer that lost snapshots is repaired by zeroing it. One
   * implementation of net.ts for the server and the peer host, as required.
   */
  resyncPeer(id: number): void;
  /** Packets the room produced for a remote peer. */
  onPeerData: ((id: number, bytes: Uint8Array) => void) | null;
  /** The ROOM dropped a peer — timeout, flood, protocol error, room full. */
  onPeerClosed: ((id: number, code: number, reason: string) => void) | null;
}

/* ------------------------------------------------------------------------ *
 * Environment detection
 * ------------------------------------------------------------------------ */

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

function detectWorkerScope(): WorkerScope | null {
  const g = globalThis as unknown as {
    DedicatedWorkerGlobalScope?: unknown;
    postMessage?: unknown;
    document?: unknown;
  };
  if (typeof g.document !== 'undefined') return null;
  if (typeof g.DedicatedWorkerGlobalScope === 'undefined') return null;
  if (typeof g.postMessage !== 'function') return null;
  return globalThis as unknown as WorkerScope;
}

/* ------------------------------------------------------------------------ *
 * Peer-id framing for the worker boundary
 * ------------------------------------------------------------------------ */

function framePeer(id: number, bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.length + 2);
  out[0] = id & 0xff;
  out[1] = (id >>> 8) & 0xff;
  out.set(bytes, 2);
  return out.buffer;
}

function unframePeer(buffer: ArrayBuffer): { id: number; bytes: Uint8Array } | null {
  if (buffer.byteLength < 2) return null;
  const view = new Uint8Array(buffer);
  return { id: view[0] | (view[1] << 8), bytes: view.subarray(2) };
}

/* ------------------------------------------------------------------------ *
 * Server side — shared by the worker and the inline fallback
 * ------------------------------------------------------------------------ */

interface RoomHost {
  advance(nowMs: number): void;
  openPeer(id: number): void;
  receive(id: number, bytes: Uint8Array): void;
  closePeer(id: number): void;
  resyncPeer(id: number): void;
  status(): Record<string, unknown>;
  stop(): void;
}

/**
 * Build a Room and let peers attach to it. `deliver` is called with every
 * packet the room produces, tagged with the peer it is for; feed packets back
 * in with `receive`. `notifyClosed` fires when the ROOM drops a peer, which is
 * how a `server full` refusal or a timeout reaches the page.
 */
async function createRoomHost(
  options: StartMessage,
  deliver: (id: number, bytes: Uint8Array) => void,
  notifyClosed: (id: number, code: number, reason: string) => void,
  clock?: () => number,
): Promise<RoomHost> {
  // Dynamic so the authoritative stack lands in its own chunk: a player who
  // only ever joins an online match never downloads the simulation.
  const { Room } = await import('@doomcraft/server/src/room.js');
  type Conn = ReturnType<InstanceType<typeof Room>['join']>;

  const latency = Math.max(0, options.latencyMs ?? 0);
  let running = true;
  const pending: Array<ReturnType<typeof setTimeout>> = [];

  const later = (fn: () => void): void => {
    if (latency === 0) { fn(); return; }
    const handle = setTimeout(() => {
      const i = pending.indexOf(handle);
      if (i >= 0) pending.splice(i, 1);
      if (running) fn();
    }, latency);
    pending.push(handle);
  };

  const room = new Room({
    seed: options.seed,
    mode: options.mode,
    botFill: options.botFill,
    enemies: options.enemies,
    allWeapons: options.allWeapons,
    maxPlayers: options.maxPlayers,
    // A peer-hosted room NEVER persists anything. This is not an optimisation:
    // docs/ECONOMY.md decision 1 is "the server grants every reward; the client
    // never does", and a room simulated on a player's own machine is a client.
    // See the hard rules in peerHost.ts.
    store: null,
    // Trickle the arena in from the spawn outward. Generating all 169 chunks
    // up front would blow the 3 s interactive budget on a phone.
    eagerWorld: false,
    clock: clock ?? (() => nowMs()),
    name: 'local',
    // The worker room is not a second party. It runs in this tab, it grants
    // nothing (`store: null` above), and there is no operator on the other end
    // to pull a kill switch — so the only honest answer it can give a client
    // asking "are the reward surfaces on?" is the page's own preference, which
    // the page computed and sent. A remote server ignores all of this and
    // resolves its own bits from the flag service (server/src/index.ts).
    resolveFlags: () => (options.flagBits ?? defaultFlagBits()) >>> 0,
    // The campaign, so a Quest `SELECT` makes this room's world BE the level
    // instead of leaving the level on the client and the collision on a hill.
    levels: createBundledLevels(),
  });

  interface Peer { conn: Conn; open: boolean }
  const peers = new Map<number, Peer>();

  const openPeer = (id: number): void => {
    if (!running || peers.has(id)) return;
    const peer: Peer = { conn: null as unknown as Conn, open: true };
    const transport: ServerTransport = {
      get isOpen(): boolean { return running && peer.open; },
      get bufferedAmount(): number { return 0; },
      send(data: Uint8Array): void {
        if (!running || !peer.open) return;
        // The writer reuses its buffer, so copy before the bytes leave.
        const copy = data.slice();
        later(() => { if (peer.open) deliver(id, copy); });
      },
      close(code = 1000, reason = 'closed'): void {
        if (!peer.open) return;
        peer.open = false;
        peers.delete(id);
        notifyClosed(id, code, reason);
      },
    };
    peer.conn = room.join(transport);
    peers.set(id, peer);
  };

  openPeer(LOCAL_PEER_ID);
  if (options.manual !== true) room.start();

  return {
    advance(now: number): void { if (running) room.advance(now); },
    openPeer,
    receive(id: number, bytes: Uint8Array): void {
      const peer = peers.get(id);
      if (!running || !peer || !peer.open) return;
      later(() => { if (peer.open) room.receive(peer.conn, bytes); });
    },
    closePeer(id: number): void {
      const peer = peers.get(id);
      if (!peer) return;
      // Order matters: clearing `open` first stops `NetHub.detach` from
      // bouncing this back out as a room-initiated close.
      peer.open = false;
      peers.delete(id);
      room.leave(peer.conn);
    },
    resyncPeer(id: number): void {
      const peer = peers.get(id);
      if (!peer || !peer.open) return;
      // `net.ts` sendSnapshot: `full = conn.baselineTick === 0 || ...`.
      peer.conn.baselineTick = 0;
    },
    status(): Record<string, unknown> {
      return { ...room.status(), peers: peers.size };
    },
    stop(): void {
      running = false;
      for (const h of pending) clearTimeout(h);
      pending.length = 0;
      for (const [, peer] of peers) { peer.open = false; room.leave(peer.conn); }
      peers.clear();
      room.stop();
    },
  };
}

function nowMs(): number {
  const perf = (globalThis as unknown as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/* ------------------------------------------------------------------------ *
 * Worker entry
 * ------------------------------------------------------------------------ */

function bootWorker(scope: WorkerScope): void {
  let host: RoomHost | null = null;
  let starting = false;

  const post = (msg: ControlToPage): void => { scope.postMessage(msg); };

  scope.onmessage = (ev: { data: unknown }): void => {
    const data = ev.data;

    if (data instanceof ArrayBuffer) {
      const framed = unframePeer(data);
      if (framed) host?.receive(framed.id, framed.bytes);
      return;
    }

    const control = data as ControlToWorker;
    if (!control || typeof control !== 'object') return;

    switch (control.t) {
      case 'start': {
        if (host || starting) return;
        starting = true;
        createRoomHost(
          control,
          (id, bytes) => {
            const buffer = framePeer(id, bytes);
            scope.postMessage(buffer, [buffer]);
          },
          (id, code, reason) => { post({ t: 'peer-closed', id, code, reason }); },
        ).then((h) => {
          host = h;
          starting = false;
          post({ t: 'ready' });
        }).catch((err: unknown) => {
          starting = false;
          post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
        });
        break;
      }
      case 'stop':
        host?.stop();
        host = null;
        break;
      case 'status':
        if (host) post({ t: 'status', status: host.status() });
        break;
      case 'peer-open':
        host?.openPeer(control.id);
        break;
      case 'peer-close':
        host?.closePeer(control.id);
        break;
      case 'peer-resync':
        host?.resyncPeer(control.id);
        break;
      default:
        break;
    }
  };
}

const WORKER_SCOPE = detectWorkerScope();
if (WORKER_SCOPE !== null) bootWorker(WORKER_SCOPE);

/* ------------------------------------------------------------------------ *
 * Main-thread API
 * ------------------------------------------------------------------------ */

class LocalTransport implements ClientTransport {
  readonly kind = 'worker' as const;
  readyState: number = TransportState.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((data: ArrayBuffer | Uint8Array) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  /** Packets sent before the server said it was ready. */
  private readonly queued: Uint8Array[] = [];
  private sink: ((bytes: Uint8Array) => void) | null = null;

  attach(sink: (bytes: Uint8Array) => void): void {
    this.sink = sink;
    this.readyState = TransportState.OPEN;
    for (const q of this.queued) sink(q);
    this.queued.length = 0;
    this.onopen?.();
  }

  send(data: Uint8Array): void {
    if (this.readyState > TransportState.OPEN) return;
    const copy = data.slice();
    if (this.sink) this.sink(copy);
    else if (this.queued.length < 256) this.queued.push(copy);
  }

  deliver(bytes: ArrayBuffer | Uint8Array): void {
    this.onmessage?.(bytes);
  }

  close(code = 1000, reason = 'local server stopped'): void {
    if (this.readyState === TransportState.CLOSED) return;
    this.readyState = TransportState.CLOSED;
    this.sink = null;
    this.onclose?.(code, reason);
  }

  fail(message: string): void {
    this.onerror?.(new Error(message));
  }
}

/**
 * What the in-tab room tells its own player about the feature flags.
 *
 * Only a flag whose subject is entirely inside this tab may be answered from a
 * client-side preference. `economy_scrap` qualifies *for this room* because
 * this room pays nobody — `store: null`, no gate, no grant — so the surfaces it
 * unlocks show zeroes, which is exactly the truth about an offline match. Every
 * other bit keeps its shipped default, `online_play` above all: that one is
 * about reaching a machine this tab does not own, and no preference in here can
 * make that machine exist.
 *
 * Takes the answer rather than reading it, so it can be tested. `isEnabled`
 * wants `localStorage` and `location`; this function wants neither.
 */
export function localFlagBits(economyProduct: boolean): number {
  let bits = defaultFlagBits();
  const i = FLAG_ORDER.indexOf('economy_scrap');
  if (i >= 0 && i < MAX_FLAG_BITS && economyProduct) bits |= 1 << i;
  return bits >>> 0;
}

/**
 * Start the authoritative server for this tab.
 *
 * The returned transport is already usable: packets sent before the worker
 * finishes booting are queued and replayed, so the caller can construct the
 * NetClient and call `connect()` immediately.
 */
export function createLocalServer(options: LocalServerOptions = {}): LocalServer {
  const transport = new LocalTransport();
  const start: StartMessage = {
    t: 'start',
    seed: options.seed,
    mode: options.mode,
    botFill: options.botFill,
    enemies: options.enemies,
    latencyMs: options.latencyMs,
    allWeapons: options.allWeapons,
    maxPlayers: options.maxPlayers,
    manual: options.manual === true && options.inline === true,
    flagBits: localFlagBits(isEnabled(Feature.ECONOMY)),
  };

  let worker: Worker | null = null;
  let inlineHost: RoomHost | null = null;
  let stopped = false;
  let markReady: () => void = () => { /* replaced below */ };
  let markFailed: (err: Error) => void = () => { /* replaced below */ };
  const ready = new Promise<void>((res, rej) => { markReady = res; markFailed = rej; });
  // A rejection nobody awaited must not become an unhandled rejection.
  ready.catch(() => { /* the caller may never look */ });

  const api: LocalServer = {
    transport,
    ready,
    get inWorker(): boolean { return worker !== null; },
    advance(nowMs2: number): void { inlineHost?.advance(nowMs2); },
    onPeerData: null,
    onPeerClosed: null,

    openPeer(id: number): void {
      if (stopped || id === LOCAL_PEER_ID) return;
      if (worker) worker.postMessage({ t: 'peer-open', id } satisfies PeerOpenMessage);
      else inlineHost?.openPeer(id);
    },
    receiveFromPeer(id: number, bytes: Uint8Array): void {
      if (stopped || id === LOCAL_PEER_ID) return;
      if (worker) {
        const buffer = framePeer(id, bytes);
        worker.postMessage(buffer, [buffer]);
      } else {
        inlineHost?.receive(id, bytes);
      }
    },
    closePeer(id: number, code = 1000, reason = 'peer left'): void {
      if (stopped || id === LOCAL_PEER_ID) return;
      if (worker) worker.postMessage({ t: 'peer-close', id, code, reason } satisfies PeerCloseMessage);
      else inlineHost?.closePeer(id);
    },
    resyncPeer(id: number): void {
      if (stopped) return;
      if (worker) worker.postMessage({ t: 'peer-resync', id } satisfies PeerResyncMessage);
      else inlineHost?.resyncPeer(id);
    },

    requestStatus(): void {
      if (worker) worker.postMessage({ t: 'status' } satisfies StatusRequest);
      else if (inlineHost) options.onStatus?.(inlineHost.status());
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      transport.close(1000, 'local server stopped');
      if (worker) {
        try { worker.postMessage({ t: 'stop' } satisfies StopMessage); } catch { /* gone */ }
        worker.terminate();
        worker = null;
      }
      if (inlineHost) { inlineHost.stop(); inlineHost = null; }
    },
  };

  const deliver = (id: number, bytes: Uint8Array): void => {
    if (stopped) return;
    if (id === LOCAL_PEER_ID) transport.deliver(bytes);
    else api.onPeerData?.(id, bytes);
  };
  const notifyClosed = (id: number, code: number, reason: string): void => {
    if (stopped) return;
    if (id === LOCAL_PEER_ID) transport.close(code, reason);
    else api.onPeerClosed?.(id, code, reason);
  };

  const runInline = (): void => {
    void createRoomHost(start, deliver, notifyClosed, options.clock).then((h) => {
      if (stopped) { h.stop(); return; }
      inlineHost = h;
      transport.attach((bytes) => h.receive(LOCAL_PEER_ID, bytes));
      markReady();
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      options.onError?.(message);
      transport.fail(message);
      markFailed(err instanceof Error ? err : new Error(message));
    });
  };

  if (options.inline) {
    runInline();
  } else {
    try {
      worker = new Worker(new URL('./localServer.ts', import.meta.url), {
        type: 'module',
        name: 'doomcraft-local-server',
      });
      worker.onmessage = (ev: MessageEvent): void => {
        const data = ev.data as unknown;
        if (data instanceof ArrayBuffer) {
          const framed = unframePeer(data);
          if (framed) deliver(framed.id, framed.bytes);
          return;
        }
        const control = data as ControlToPage;
        if (!control || typeof control !== 'object') return;
        if (control.t === 'ready') {
          const w = worker;
          if (!w) return;
          transport.attach((bytes) => {
            const buffer = framePeer(LOCAL_PEER_ID, bytes);
            w.postMessage(buffer, [buffer]);
          });
          markReady();
        } else if (control.t === 'status') {
          options.onStatus?.(control.status);
        } else if (control.t === 'peer-closed') {
          notifyClosed(control.id, control.code, control.reason);
        } else if (control.t === 'error') {
          options.onError?.(control.message);
          transport.fail(control.message);
        }
      };
      worker.onerror = (ev: ErrorEvent): void => {
        options.onError?.(ev.message || 'worker error');
        // A worker that cannot start must not cost the player the match.
        if (!inlineHost && !stopped) {
          worker?.terminate();
          worker = null;
          runInline();
        }
      };
      worker.postMessage(start);
    } catch (err) {
      worker = null;
      options.onError?.(err instanceof Error ? err.message : String(err));
      runInline();
    }
  }

  return api;
}
