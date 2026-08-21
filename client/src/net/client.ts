/**
 * DOOMCRAFT — the client half of the network model.
 *
 *   - connect / reconnect with backoff, over a WebSocket or over the local
 *     server running in a Worker (same binary protocol either way),
 *   - input at 60 Hz with sequence numbers,
 *   - CLIENT-SIDE PREDICTION using the server's own movement kernel
 *     (`moveStep` from server/src/sim.ts — there is only one implementation),
 *   - reconciliation that replays unacked inputs and then bleeds the visual
 *     error away over ~120 ms, so a misprediction never snaps the camera,
 *   - entity interpolation at a 100 ms render delay with bounded extrapolation,
 *   - predicted block edits that roll back when the server disagrees,
 *   - a KEEPALIVE driven by a clock outside `requestAnimationFrame`, because a
 *     background tab stops rAF and the server drops a silent client after
 *     `CLIENT_TIMEOUT_MS`. See the "Keepalive" block below.
 *
 * The renderer reads `renderPos`, `players`, `entities` and `projectiles`; it
 * never talks to the socket.
 */

import {
  BlockDeltaBuffer,
  BlockAction,
  BlockId,
  BLOCK_SOLID,
  CAP_INFLATE,
  CAP_RETURNING,
  CHUNK_HEIGHT,
  CHUNK_SIZE_MASK,
  CHUNK_VOLUME,
  CLIENT_TIMEOUT_MS,
  HEARTBEAT_MS,
  INPUT_SEND_MS,
  INTERP_DELAY_MS,
  MAX_ENTITIES,
  MAX_EXTRAPOLATE_MS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  PF_LOCAL,
  PF_REMOVED,
  PF_SPAWN,
  PITCH_LIMIT,
  PREDICTION_HISTORY,
  PS_DEAD,
  PacketReader,
  PacketWriter,
  RECONNECT_BACKOFF_MS,
  RF_REMOVED,
  EF_HEALTH,
  EF_POS,
  EF_REMOVED,
  EF_SPAWN,
  EF_STATE,
  EF_VEL,
  EF_YAW,
  S2C,
  SNAP_FULL,
  SNAPSHOT_HISTORY,
  SnapshotBuffer,
  TICK_MS,
  WORLD_MAX_CHUNK,
  WORLD_MIN_CHUNK,
  blockToChunk,
  chunkKey,
  clamp,
  createChatMessage,
  createChunkZHeader,
  createDamageEvent,
  createKillEvent,
  createPongMessage,
  createWelcomeMessage,
  decodeBlockDeltas,
  decodeChatS2C,
  decodeChunkZHeader,
  decodeDamage,
  decodeKill,
  decodePong,
  decodeSnapshot,
  decodeWelcome,
  dequantizeAngle,
  dequantizePitch,
  encodeBlockEdit,
  encodeAppearance,
  encodeChatC2S,
  encodeHello,
  encodeInput,
  encodePing,
  encodeRespawn,
  expDecay,
  lerpAngle,
  quantizeAngle,
  quantizePitch,
  rleDecode,
  voxelIndex,
} from '@shared';

import {
  ModeStateBuffer,
  S2C_MODE,
  createModeContextMessage,
  createModeEventMessage,
  decodeModeContext,
  decodeModeEvent,
  decodeModeState,
  type ModeContextMessage,
  type ModeEventMessage,
} from '@shared/modes';
import type { ChatMessage, DamageEvent, KillEvent, SolidAt, WelcomeMessage } from '@shared';
import { createMoveState, eyeHeightOf, moveStep } from '@doomcraft/server/src/sim.js';
import type { CollisionWorld, MoveState } from '@doomcraft/server/src/sim.js';
import { defaultServerUrl, webSocketTransport } from './transport.js';
import type { ClientTransport } from './transport.js';
import type { InflateRequest, InflateResult } from './chunkInflate.worker.js';

/* ------------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------------ */

/**
 * The transport seam moved to `./transport.ts` so the WebSocket path, the
 * Worker path and the WebRTC path can share one definition — and so the
 * reliability routing table has exactly one home. Re-exported here because
 * `ClientTransport` has always been part of this module's public surface.
 */
export {
  TransportState,
  webSocketTransport,
  defaultServerUrl,
} from './transport.js';
export type { ClientTransport, ServerTransport, TransportKind } from './transport.js';

/* ------------------------------------------------------------------------ *
 * Keepalive — the pump that does NOT live in requestAnimationFrame
 *
 * The server drops any connection it has not heard from for
 * `CLIENT_TIMEOUT_MS` (15 s, `server/src/net.ts` reapTimeouts). Everything the
 * client normally sends — 60 Hz input, the 1 Hz `C2S.PING` — is driven from
 * `update()`, which is driven from `requestAnimationFrame`. A hidden tab
 * throttles rAF to ~1 Hz and stops it completely when the tab is occluded, so
 * fifteen seconds behind another window used to end the match.
 *
 * The fix is a clock that rAF cannot take away:
 *
 *   1. a dedicated Worker timer (`keepalive.worker.ts`) — worker timers are
 *      exempt from Chrome's *intensive* throttling, which clamps a hidden
 *      page's own timers to one wake-up per MINUTE. At one per minute a
 *      `setInterval` keepalive would still lose the match.
 *   2. a plain `setInterval` on the page, running alongside as the fallback
 *      for anything that cannot spawn a Worker.
 *   3. an immediate send on `visibilitychange`, wired up by the caller, so the
 *      timeout window starts fresh the moment the tab goes away.
 *
 * A keepalive is one `C2S.PING`: ~5 bytes, already implemented on both ends,
 * and it refreshes `conn.lastRecvMs` exactly like input does. Nothing is
 * simulated and no input is queued while hidden — see `resumeFromBackground`.
 * ------------------------------------------------------------------------ */

/**
 * How often the keepalive clock wakes. Cheap: a wake-up that finds recent
 * traffic on the socket does nothing at all.
 */
export const KEEPALIVE_TICK_MS = 1000;

/**
 * Send a keepalive when the socket has been silent this long. A fifth of
 * `CLIENT_TIMEOUT_MS`, so four consecutive keepalives can be lost — to
 * throttling, to packet loss, to a stalled worker — before the server reaps us.
 */
export const KEEPALIVE_SILENCE_MS = Math.floor(CLIENT_TIMEOUT_MS / 5);

/**
 * A frame loop that has been stopped longer than this is treated as a real
 * absence by `resumeFromBackground()`. Below it, nothing on screen has gone
 * stale enough to be worth a re-sync: 250 ms is one clamped `update()` step
 * (`update` caps dt at 250 ms) and well under `MAX_EXTRAPOLATE_MS` of
 * dead-reckoning, so the interpolators can simply carry on.
 */
export const RESUME_RESYNC_MS = 250;

/**
 * `clientTimeMs` stamped on a keepalive ping. The server echoes it back; the
 * client uses the sentinel to keep these pongs out of the RTT estimate, since
 * a hidden tab's clock is frozen and would otherwise report a 0 ms ping.
 */
const KEEPALIVE_PING_STAMP = 0xffffffff;

/** A clock the net pump can rely on. `start` is idempotent. */
export interface KeepaliveClock {
  start(intervalMs: number, onTick: () => void): void;
  stop(): void;
}

/** Wall-clock milliseconds. Unlike `NetClient.nowMs` this advances while hidden. */
function wallNow(): number {
  const perf = (globalThis as unknown as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/**
 * Worker timer first, page interval alongside it. Both are started; whichever
 * the browser lets run keeps the match alive, and a tick that arrives while the
 * socket is already busy costs one subtraction.
 */
export function createKeepaliveClock(): KeepaliveClock {
  let worker: Worker | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let tick: (() => void) | null = null;

  return {
    start(intervalMs: number, onTick: () => void): void {
      if (tick !== null) return;
      tick = onTick;

      if (typeof Worker !== 'undefined') {
        try {
          worker = new Worker(new URL('./keepalive.worker.ts', import.meta.url), {
            type: 'module',
            name: 'doomcraft-keepalive',
          });
          worker.onmessage = (): void => { tick?.(); };
          // A worker that cannot start must not cost the player the match.
          worker.onerror = (): void => { worker?.terminate(); worker = null; };
          worker.postMessage({ t: 'start', ms: intervalMs });
        } catch {
          worker = null;
        }
      }

      if (typeof setInterval === 'function') {
        interval = setInterval(() => { tick?.(); }, intervalMs);
      }
    },
    stop(): void {
      tick = null;
      if (worker !== null) {
        try { worker.postMessage({ t: 'stop' }); } catch { /* already gone */ }
        worker.terminate();
        worker = null;
      }
      if (interval !== null) { clearInterval(interval); interval = null; }
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Compressed chunks
 *
 * The server sends `S2C.CHUNK_Z` — the same RLE stream as `S2C.CHUNK`, raw
 * deflated — but only to a client that asked for it with `CAP_INFLATE`. This
 * is the whole negotiation, and it is why the change cannot strand anyone:
 *
 *   - `DecompressionStream('deflate-raw')` is Chrome 103+, Firefox 113+,
 *     Safari 16.4+ (March 2023, so iOS 16.4). Everything older, plus anything
 *     with a CSP that forbids workers, simply never sets the bit and keeps
 *     receiving `S2C.CHUNK`. The bytes cost more; nothing breaks.
 *   - The browser's local-server Worker has no compressor at all, so single
 *     player never sees a compressed chunk and its load path is untouched.
 *
 * Support is probed once, up front, because HELLO goes out before the first
 * chunk arrives and the answer has to be honest at that moment.
 * ------------------------------------------------------------------------ */

/** Can this browser inflate a raw-deflate stream off the main thread? */
export function chunkInflateSupported(): boolean {
  if (typeof Worker === 'undefined') return false;
  const DS = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  if (typeof DS !== 'function') return false;
  try {
    // `deflate-raw` landed after `gzip` in every engine; constructing one is
    // the only way to know this build has it.
    new (DS as new (f: string) => unknown)('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

/**
 * Owns the inflate worker and the main-thread path of last resort.
 *
 * The worker is created on the FIRST compressed chunk, never at connect: the
 * shipped single-player build never receives one, and a worker nobody uses is
 * a thread and a module fetch on the critical path to interactive.
 *
 * If the worker cannot be built or dies mid-session the fallback runs the same
 * `DecompressionStream` on the main thread. That is not a frame-budget hazard
 * the way a bulk inflate would be — chunks arrive as ~4.9 KB messages, one
 * inflate each, and the API is asynchronous so the work lands off the current
 * task either way. It is the safety net, not the design.
 */
class ChunkInflater {
  private worker: Worker | null = null;
  private workerFailed = false;
  private disposed = false;

  constructor(private readonly onResult: (r: InflateResult) => void) {}

  /** `z` is borrowed: it is copied into a transferable before this returns. */
  submit(cx: number, cz: number, seq: number, rleLen: number, z: Uint8Array): void {
    if (this.disposed) return;
    // The reader's buffer is reused for the next packet, so the worker gets its
    // own copy. One 4.9 KB copy per chunk, then zero copies both ways after.
    const buf = z.slice().buffer;
    const w = this.ensureWorker();
    if (w !== null) {
      const req: InflateRequest = { cx, cz, seq, rleLen, buf };
      try {
        w.postMessage(req, [buf]);
        return;
      } catch {
        this.killWorker();
      }
    }
    void this.inflateOnPage(cx, cz, seq, rleLen, new Uint8Array(buf));
  }

  dispose(): void {
    this.disposed = true;
    this.killWorker();
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== null || this.workerFailed) return this.worker;
    try {
      const w = new Worker(new URL('./chunkInflate.worker.ts', import.meta.url), {
        type: 'module',
        name: 'doomcraft-chunk-inflate',
      });
      w.onmessage = (ev: MessageEvent): void => {
        if (!this.disposed) this.onResult(ev.data as InflateResult);
      };
      w.onerror = (): void => { this.killWorker(); this.workerFailed = true; };
      this.worker = w;
    } catch {
      this.workerFailed = true;
      this.worker = null;
    }
    return this.worker;
  }

  private killWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w === null) return;
    w.onmessage = null;
    w.onerror = null;
    try { w.terminate(); } catch { /* already gone */ }
  }

  private async inflateOnPage(
    cx: number, cz: number, seq: number, rleLen: number, z: Uint8Array,
  ): Promise<void> {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      void writer.write(z).catch(() => { /* surfaces on the read side */ });
      void writer.close().catch(() => { /* ditto */ });
      const rle = new Uint8Array(rleLen);
      const reader = ds.readable.getReader();
      let off = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        if (off + value.length > rleLen) throw new Error('inflate overflow');
        rle.set(value, off);
        off += value.length;
      }
      if (off !== rleLen) throw new Error('inflate short');
      const voxels = new Uint8Array(CHUNK_VOLUME);
      rleDecode(rle, 0, rleLen, voxels);
      if (!this.disposed) this.onResult({ cx, cz, seq, voxels: voxels.buffer });
    } catch (e) {
      if (!this.disposed) {
        this.onResult({ cx, cz, seq, err: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

/**
 * A chunk that has been received but not yet decoded, plus any BLOCK_DELTA that
 * landed in it while it was in flight.
 *
 * The server marks a chunk "sent" the instant it queues the packet, so from
 * that moment it will happily stream edits for it. Decoding is now asynchronous,
 * so those edits can beat the chunk home. Applying them to a chunk that is not
 * there yet loses them silently and desyncs the client's collision world from
 * the server's — so they are held here and baked into the voxels the moment
 * they arrive, before anything downstream ever sees the chunk.
 */
interface PendingChunk {
  seq: number;
  x: number[];
  y: number[];
  z: number[];
  id: number[];
}

/* ------------------------------------------------------------------------ *
 * Client-side voxel world
 * ------------------------------------------------------------------------ */

/**
 * The voxels the client has received. Prediction collides against this, and the
 * mesher reads it. It answers exactly like the server does outside the arena
 * (BEDROCK), or prediction and simulation would disagree at the rim.
 */
export class ClientWorld implements CollisionWorld {
  readonly chunks = new Map<number, Uint8Array>();
  readonly solidAt: SolidAt;
  /** Bumped on every change so the mesher can tell something moved. */
  revision = 0;

  private lastKey = -1;
  private lastChunk: Uint8Array | null = null;

  constructor() {
    this.solidAt = (x: number, y: number, z: number): boolean => BLOCK_SOLID[this.getBlock(x, y, z)] === 1;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BlockId.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BlockId.AIR;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    if (cx < WORLD_MIN_CHUNK || cx > WORLD_MAX_CHUNK || cz < WORLD_MIN_CHUNK || cz > WORLD_MAX_CHUNK) {
      return BlockId.BEDROCK;
    }
    const key = chunkKey(cx, cz);
    let chunk: Uint8Array | undefined | null = key === this.lastKey ? this.lastChunk : this.chunks.get(key);
    if (chunk === undefined || chunk === null) return BlockId.AIR;
    this.lastKey = key;
    this.lastChunk = chunk;
    return chunk[voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK)];
  }

  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return false;
    const i = voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK);
    if (chunk[i] === id) return false;
    chunk[i] = id;
    this.revision++;
    return true;
  }

  hasChunk(cx: number, cz: number): boolean { return this.chunks.has(chunkKey(cx, cz)); }

  chunkAt(cx: number, cz: number): Uint8Array | undefined { return this.chunks.get(chunkKey(cx, cz)); }

  putChunk(cx: number, cz: number, voxels: Uint8Array): void {
    this.chunks.set(chunkKey(cx, cz), voxels);
    this.lastKey = -1;
    this.lastChunk = null;
    this.revision++;
  }

  clear(): void {
    this.chunks.clear();
    this.lastKey = -1;
    this.lastChunk = null;
    this.revision++;
  }

  get chunkCount(): number { return this.chunks.size; }
}

/* ------------------------------------------------------------------------ *
 * Views the renderer consumes
 * ------------------------------------------------------------------------ */

export interface RemotePlayerView {
  id: number;
  active: boolean;
  isLocal: boolean;
  name: string;
  /** Legacy one-byte appearance; kept for anything still reading it. */
  skin: number;
  /** Packed avatar — see client/src/characters/avatar.ts. 0 is the default marine. */
  avatar: number;
  team: number;
  /** Interpolated render transform. */
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  vx: number; vy: number; vz: number;
  health: number;
  armor: number;
  weapon: number;
  state: number;
  kills: number;
  deaths: number;
}

export interface RemoteEntityView {
  id: number;
  active: boolean;
  type: number;
  variant: number;
  state: number;
  health: number;
  x: number; y: number; z: number;
  yaw: number;
  /**
   * Interpolated velocity, m/s. Already on the wire as `EF_VEL` and already
   * carried through `EntityTrack.sample()` — it was simply never copied out.
   * The character rig chooses idle / walk / sprint from it, so exposing the
   * three floats the snapshot already paid for costs zero extra bytes.
   */
  vx: number; vy: number; vz: number;
}

export interface RemoteProjectileView {
  id: number;
  active: boolean;
  weapon: number;
  owner: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds since the client first saw it — drives the trail. */
  age: number;
}

export interface LocalPlayerView {
  id: number;
  health: number;
  armor: number;
  weapon: number;
  mag: number;
  reserve: number;
  kills: number;
  deaths: number;
  dead: boolean;
  state: number;
}

export type NetStatus =
  | 'idle' | 'connecting' | 'loading' | 'playing'
  | 'reconnecting' | 'closed' | 'error';

export interface NetClientEvents {
  onStatus?(status: NetStatus, detail?: string): void;
  onWelcome?(welcome: WelcomeMessage): void;
  /** A chunk arrived. `voxels` is owned by ClientWorld — do not keep a mutable copy. */
  onChunk?(cx: number, cz: number, voxels: Uint8Array, received: number, total: number): void;
  /** Voxels changed. Coordinates are world space; remesh the touched chunks. */
  onBlocks?(count: number, x: Int16Array, y: Uint8Array, z: Int16Array, id: Uint8Array): void;
  onDamage?(e: DamageEvent): void;
  onKill?(e: KillEvent): void;
  /**
   * An entity left the snapshot. `reason` is `RemoveReason` — the byte the
   * server already sends with `EF_REMOVED` and that this client used to throw
   * away. The view is about to be recycled: read it now, do not keep it.
   *
   * This is what lets a monster leave a corpse. The simulation kills and
   * removes in the same tick (`sim.damageEntity`), so a dead monster is never
   * transmitted as dead — it simply stops being transmitted. Without the
   * reason byte the client cannot tell "killed in front of you" from
   * "despawned 200 m away", and would either drop every body instantly or
   * litter the arena with corpses of things that walked out of range.
   */
  onEntityGone?(view: RemoteEntityView, reason: number): void;
  onChat?(m: ChatMessage): void;
  onSnapshot?(s: SnapshotBuffer): void;
  /** Fired when reconciliation had to move the local player. */
  onCorrection?(errorMetres: number): void;
  /**
   * The mode sidecar (`S2C_MODE.STATE`). The buffer is REUSED — read it now or
   * copy it; never keep the reference.
   */
  onModeState?(state: ModeStateBuffer): void;
  /** One-shot mode notification. The record is reused. */
  onModeEvent?(event: ModeEventMessage): void;
  /** Which level/world the room is running. The record is reused. */
  onModeContext?(context: ModeContextMessage): void;
}

export interface NetClientOptions {
  /** WebSocket URL. Ignored when `transport` is supplied. */
  url?: string;
  /** Pre-built transport — this is how the local Worker server is plugged in. */
  transport?: ClientTransport;
  /** Factory used for reconnects. Defaults to a WebSocket on `url`. */
  createTransport?: () => ClientTransport;
  name: string;
  skin?: number;
  /** Packed avatar sent in HELLO. Change it later with `setAvatar`. */
  avatar?: number;
  caps?: number;
  autoReconnect?: boolean;
  events?: NetClientEvents;
  /**
   * The clock that keeps the socket alive while `requestAnimationFrame` is
   * throttled or stopped. Defaults to `createKeepaliveClock()` (Worker timer +
   * page interval). Pass `null` to opt out, or a fake to drive it from a test.
   */
  keepalive?: KeepaliveClock | null;
  /** Wall-clock source, in ms. Injected by tests; defaults to performance.now. */
  wallClock?: () => number;
}

/* ------------------------------------------------------------------------ *
 * Interpolation ring
 * ------------------------------------------------------------------------ */

const RING = SNAPSHOT_HISTORY;

class InterpTrack {
  readonly time = new Float64Array(RING);
  readonly x = new Float32Array(RING);
  readonly y = new Float32Array(RING);
  readonly z = new Float32Array(RING);
  readonly yaw = new Float32Array(RING);
  readonly pitch = new Float32Array(RING);
  readonly vx = new Float32Array(RING);
  readonly vy = new Float32Array(RING);
  readonly vz = new Float32Array(RING);
  head = 0;
  count = 0;

  reset(): void { this.head = 0; this.count = 0; }

  push(t: number, x: number, y: number, z: number, yaw: number, pitch: number, vx: number, vy: number, vz: number): void {
    const i = this.head;
    this.time[i] = t;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.yaw[i] = yaw; this.pitch[i] = pitch;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.head = (i + 1) % RING;
    if (this.count < RING) this.count++;
  }

  /**
   * Sample at `t`. Between two frames it interpolates; past the newest frame it
   * extrapolates on the last known velocity for at most MAX_EXTRAPOLATE_MS, so
   * a dropped snapshot glides instead of freezing. Writes into `out`:
   * [x, y, z, yaw, pitch, vx, vy, vz].
   */
  sample(t: number, out: Float64Array): boolean {
    if (this.count === 0) return false;
    const newest = (this.head - 1 + RING) % RING;
    if (this.count === 1 || t >= this.time[newest]) {
      const dtMs = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, t - this.time[newest]));
      const s = dtMs / 1000;
      out[0] = this.x[newest] + this.vx[newest] * s;
      out[1] = this.y[newest] + this.vy[newest] * s;
      out[2] = this.z[newest] + this.vz[newest] * s;
      out[3] = this.yaw[newest];
      out[4] = this.pitch[newest];
      out[5] = this.vx[newest]; out[6] = this.vy[newest]; out[7] = this.vz[newest];
      return true;
    }
    const oldest = (this.head - this.count + RING) % RING;
    if (t <= this.time[oldest]) {
      out[0] = this.x[oldest]; out[1] = this.y[oldest]; out[2] = this.z[oldest];
      out[3] = this.yaw[oldest]; out[4] = this.pitch[oldest];
      out[5] = this.vx[oldest]; out[6] = this.vy[oldest]; out[7] = this.vz[oldest];
      return true;
    }
    let b = newest;
    for (let k = 1; k < this.count; k++) {
      const a = (newest - k + RING) % RING;
      if (this.time[a] <= t) {
        const t0 = this.time[a];
        const t1 = this.time[b];
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        out[0] = this.x[a] + (this.x[b] - this.x[a]) * f;
        out[1] = this.y[a] + (this.y[b] - this.y[a]) * f;
        out[2] = this.z[a] + (this.z[b] - this.z[a]) * f;
        out[3] = lerpAngle(this.yaw[a], this.yaw[b], f);
        out[4] = this.pitch[a] + (this.pitch[b] - this.pitch[a]) * f;
        out[5] = this.vx[a] + (this.vx[b] - this.vx[a]) * f;
        out[6] = this.vy[a] + (this.vy[b] - this.vy[a]) * f;
        out[7] = this.vz[a] + (this.vz[b] - this.vz[a]) * f;
        return true;
      }
      b = a;
    }
    return false;
  }
}

interface PendingEdit {
  seq: number;
  x: number; y: number; z: number;
  prevId: number;
  newId: number;
  sentMs: number;
}

/* ------------------------------------------------------------------------ *
 * NetClient
 * ------------------------------------------------------------------------ */

/** Position error, in metres, above which the local player is corrected. */
export const RECONCILE_EPSILON = 0.035;
/** Error above which we teleport instead of smoothing. */
export const RECONCILE_SNAP = 3.0;
/** 1/s decay of the visual correction offset. */
export const CORRECTION_RATE = 11;
/** Predicted steps per frame, so a long frame cannot stall the loop. */
export const MAX_PREDICT_STEPS = 4;

export class NetClient {
  readonly world = new ClientWorld();
  readonly events: NetClientEvents;

  status: NetStatus = 'idle';
  playerId = 0;
  seed = 0;
  gameMode = 0;
  serverTick = 0;
  rttMs = 0;
  /** 0..1 while the world streams in. Drive the loading bar with it. */
  loadProgress = 0;
  chunksReceived = 0;
  chunksExpected = 1;
  matchOver = false;

  /**
   * The mode sidecar, as last received. Kept on the client rather than in the
   * mode so a mode entered AFTER the packet landed still sees current state —
   * a room announces itself once, and a mode switch must not lose that.
   */
  readonly modeState = new ModeStateBuffer();
  readonly modeEvent: ModeEventMessage = createModeEventMessage();
  readonly modeContext: ModeContextMessage = createModeContextMessage();
  /** False until the room has ever sent a STATE — modes fall back on it. */
  modeStateSeen = false;
  modeContextSeen = false;

  /** Predicted body. `pos` is feet centre; the camera sits at pos.y + eye height. */
  readonly predicted: MoveState = createMoveState();
  /** Predicted position plus the smoothed correction offset. Render from this. */
  readonly renderPos = new Float64Array(3);
  readonly correction = new Float64Array(3);

  readonly local: LocalPlayerView = {
    id: 0, health: 100, armor: 0, weapon: 0, mag: 0, reserve: 0,
    kills: 0, deaths: 0, dead: false, state: 0,
  };

  readonly players: RemotePlayerView[] = [];
  readonly entities: RemoteEntityView[] = [];
  readonly projectiles: RemoteProjectileView[] = [];

  /* --- input state the game loop feeds in --- */
  private inYaw = 0;
  private inPitch = 0;
  private inButtons = 0;
  private inMoveX = 0;
  private inMoveZ = 0;
  private inSlot = 0;

  /* --- transport --- */
  private transport: ClientTransport | null = null;
  private readonly makeTransport: () => ClientTransport;
  private readonly hello: { name: string; skin: number; caps: number; avatar: number };
  private autoReconnect: boolean;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;
  private disposed = false;

  /* --- keepalive (independent of requestAnimationFrame) --- */
  private readonly keepalive: KeepaliveClock | null;
  private readonly wallClock: () => number;
  /** Wall clock at the last byte we put on the wire. Drives the keepalive. */
  private lastSendWallMs = 0;
  /**
   * Wall clock at the last `update()`. The frame loop is the only caller, so
   * this is literally "when did this client last render", which is the signal
   * `resumeFromBackground()` needs — the visibility flag is not.
   */
  private lastUpdateWallMs = 0;
  private keepaliveRunning = false;
  /** Keepalives sent because the render loop had stopped. Asserted by tests. */
  keepalivesSent = 0;

  /* --- protocol scratch (allocated once) --- */
  private readonly writer = new PacketWriter(2048);
  private readonly reader = new PacketReader();
  private readonly snapshot = new SnapshotBuffer(MAX_PLAYERS, MAX_ENTITIES, MAX_PROJECTILES);
  private readonly welcome = createWelcomeMessage();
  private readonly damage = createDamageEvent();
  private readonly kill = createKillEvent();
  private readonly chat = createChatMessage();
  private readonly pong = createPongMessage();
  private readonly deltas = new BlockDeltaBuffer();
  private readonly sampleOut = new Float64Array(8);

  /* --- prediction history --- */
  private readonly hSeq = new Uint32Array(PREDICTION_HISTORY);
  private readonly hDt = new Float32Array(PREDICTION_HISTORY);
  private readonly hButtons = new Uint16Array(PREDICTION_HISTORY);
  private readonly hMoveX = new Float32Array(PREDICTION_HISTORY);
  private readonly hMoveZ = new Float32Array(PREDICTION_HISTORY);
  private readonly hYaw = new Float32Array(PREDICTION_HISTORY);
  private readonly hPitch = new Float32Array(PREDICTION_HISTORY);
  private readonly hPX = new Float64Array(PREDICTION_HISTORY);
  private readonly hPY = new Float64Array(PREDICTION_HISTORY);
  private readonly hPZ = new Float64Array(PREDICTION_HISTORY);
  private readonly hVX = new Float64Array(PREDICTION_HISTORY);
  private readonly hVY = new Float64Array(PREDICTION_HISTORY);
  private readonly hVZ = new Float64Array(PREDICTION_HISTORY);
  private readonly hFlags = new Uint8Array(PREDICTION_HISTORY);
  private readonly hJumpCd = new Float32Array(PREDICTION_HISTORY);
  private readonly hCoyote = new Float32Array(PREDICTION_HISTORY);
  private readonly hJumpBuf = new Float32Array(PREDICTION_HISTORY);
  private hHead = 0;
  private hCount = 0;

  private inputSeq = 0;
  private editSeq = 0;
  private ackedInputSeq = 0;
  private ackedEditSeq = 0;
  private accumulatorMs = 0;
  private pingTimer = 0;
  private lastPingSentMs = 0;
  private spawnReceived = false;

  private readonly tracks: InterpTrack[] = [];
  private readonly entityTracks: InterpTrack[] = [];
  /**
   * Snapshot records are ordered by the server's own arrays, and that order
   * shifts when something is removed. Views are therefore keyed by id, never by
   * record index — otherwise one leave would swap two players' interpolation
   * tracks and teleport them past each other.
   */
  private readonly playerSlotById = new Map<number, number>();
  private readonly entitySlotById = new Map<number, number>();
  private readonly projSlotById = new Map<number, number>();
  private readonly playerSlotUsed = new Uint8Array(MAX_PLAYERS);
  private readonly entitySlotUsed = new Uint8Array(MAX_ENTITIES);
  private readonly projSlotUsed = new Uint8Array(MAX_PROJECTILES);
  private readonly playerSeen = new Uint8Array(MAX_PLAYERS);
  private readonly entitySeen = new Uint8Array(MAX_ENTITIES);
  private readonly projSeen = new Uint8Array(MAX_PROJECTILES);
  /**
   * Last transform the server actually transmitted for each entity slot, in
   * world units. Entity records are delta-encoded: a snapshot may carry
   * `EF_HEALTH` and nothing else, and `decodeSnapshot` fills its buffer
   * POSITIONALLY, so any field whose mask bit is clear holds whatever unrelated
   * entity happened to occupy that record index last time. These arrays are the
   * per-entity state the masks are applied to, and they are what gets pushed
   * into the interpolation track.
   */
  private readonly entNetX = new Float32Array(MAX_ENTITIES);
  private readonly entNetY = new Float32Array(MAX_ENTITIES);
  private readonly entNetZ = new Float32Array(MAX_ENTITIES);
  private readonly entNetYaw = new Float32Array(MAX_ENTITIES);
  private readonly entNetVX = new Float32Array(MAX_ENTITIES);
  private readonly entNetVY = new Float32Array(MAX_ENTITIES);
  private readonly entNetVZ = new Float32Array(MAX_ENTITIES);
  private readonly pendingEdits: PendingEdit[] = [];

  /* --- compressed chunk decode (see "Compressed chunks" above) --- */
  private readonly chunkZ = createChunkZHeader();
  private inflater: ChunkInflater | null = null;
  /**
   * chunkKey -> deltas that arrived while the chunk was still inflating.
   * Empty except during a join burst on a live, being-edited world.
   */
  private readonly pendingChunks = new Map<number, PendingChunk>();
  /**
   * Bumped by `resetSession`. A worker result stamped with an older epoch
   * belongs to a connection that no longer exists and is dropped.
   */
  private chunkEpoch = 0;

  private clockOffsetMs = 0;
  private clockReady = false;
  /** Client clock in ms; monotonic. */
  private nowMs = 0;

  constructor(options: NetClientOptions) {
    this.events = options.events ?? {};
    this.hello = {
      name: options.name,
      skin: options.skin ?? 0,
      caps: options.caps ?? 0,
      avatar: (options.avatar ?? 0) >>> 0,
    };
    this.autoReconnect = options.autoReconnect ?? true;
    this.wallClock = options.wallClock ?? wallNow;
    this.keepalive = options.keepalive === undefined ? createKeepaliveClock() : options.keepalive;
    this.lastSendWallMs = this.wallClock();
    this.lastUpdateWallMs = this.lastSendWallMs;
    const url = options.url;
    if (options.createTransport) {
      this.makeTransport = options.createTransport;
    } else if (options.transport) {
      let first: ClientTransport | null = options.transport;
      this.makeTransport = (): ClientTransport => {
        if (first) { const t = first; first = null; return t; }
        // A supplied one-shot transport cannot be rebuilt; fall back to the URL.
        return webSocketTransport(url ?? defaultServerUrl());
      };
      this.autoReconnect = options.autoReconnect ?? false;
    } else {
      const target = url ?? defaultServerUrl();
      this.makeTransport = (): ClientTransport => webSocketTransport(target);
    }

    for (let i = 0; i < MAX_PLAYERS; i++) {
      this.players.push({
        id: 0, active: false, isLocal: false, name: '', skin: 0, avatar: 0, team: 0,
        x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0,
        health: 0, armor: 0, weapon: 0, state: 0, kills: 0, deaths: 0,
      });
      this.tracks.push(new InterpTrack());
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      this.entities.push({ id: 0, active: false, type: 0, variant: 0, state: 0, health: 0, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0 });
      this.entityTracks.push(new InterpTrack());
    }
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectiles.push({ id: 0, active: false, weapon: 0, owner: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0 });
    }
  }

  /* -------------------------------------------------------------- *
   * Connection
   * -------------------------------------------------------------- */

  connect(): void {
    if (this.disposed || this.transport) return;
    this.startKeepalive();
    this.setStatus('connecting');
    const t = this.makeTransport();
    this.transport = t;
    t.onopen = (): void => this.onOpen();
    t.onmessage = (data): void => this.onMessage(data);
    t.onclose = (code, reason): void => this.onClose(code, reason);
    t.onerror = (err): void => {
      this.setStatus('error', err instanceof Error ? err.message : 'socket error');
    };
    // A transport that is already open (the Worker server) never fires onopen.
    if (t.readyState === 1) this.onOpen();
  }

  disconnect(): void {
    this.autoReconnect = false;
    this.stopKeepalive();
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const t = this.transport;
    this.transport = null;
    if (t) {
      t.onopen = null; t.onmessage = null; t.onclose = null; t.onerror = null;
      t.close(1000, 'client left');
    }
    this.setStatus('closed');
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.inflater?.dispose();
    this.inflater = null;
    this.pendingChunks.clear();
  }

  /* -------------------------------------------------------------- *
   * Keepalive
   *
   * The one part of the net path that is NOT driven by the frame loop.
   * -------------------------------------------------------------- */

  private startKeepalive(): void {
    if (this.keepaliveRunning || this.keepalive === null) return;
    this.keepaliveRunning = true;
    this.keepalive.start(KEEPALIVE_TICK_MS, () => { this.keepaliveTick(); });
  }

  private stopKeepalive(): void {
    if (!this.keepaliveRunning || this.keepalive === null) return;
    this.keepaliveRunning = false;
    this.keepalive.stop();
  }

  /**
   * One wake-up of the independent clock. Sends a ping only if the socket has
   * genuinely gone quiet, so a tab that is still rendering never pays for this.
   *
   * `force` skips the silence check — that is the `visibilitychange` path,
   * where the point is to restart the server's 15 s window at the exact moment
   * the tab is hidden rather than up to `KEEPALIVE_SILENCE_MS` later.
   *
   * Returns true if a keepalive went out.
   */
  keepaliveTick(force = false): boolean {
    if (this.disposed || !this.connected) return false;
    const now = this.wallClock();
    if (!force && now - this.lastSendWallMs < KEEPALIVE_SILENCE_MS) return false;
    this.keepalivesSent++;
    this.sendPing(true);
    return true;
  }

  /**
   * The tab is back. Re-sync instead of replaying the gap.
   *
   * Everything time-based in this client is driven by `nowMs`, which only
   * advances inside `update()`. After a spell in the background `update()` is
   * called again with a dt the frame loop has already clamped, so there is no
   * spiral — but there IS stale state that must not be believed:
   *
   *   - the input accumulator, which would otherwise burn `MAX_PREDICT_STEPS`
   *     of commands the player never gave,
   *   - the clock offset, which is now minutes wrong; dropping `clockReady`
   *     makes the next snapshot snap it instead of easing 5% per frame,
   *   - the interpolation rings, whose newest sample is older than
   *     `MAX_EXTRAPOLATE_MS` and would dead-reckon every remote player across
   *     the whole gap on the first frame back,
   *   - the visual correction offset, which is about to be recomputed against
   *     an authoritative position we have not seen yet.
   *
   * The world, the socket and the pending block edits all survive: nothing here
   * touches the session.
   *
   * The re-sync is gated on `renderGapMs` — how long the frame loop was
   * actually stopped — and NOT on the visibility flag that triggered it.
   * `visibilitychange` also fires for a tab flick the compositor never even
   * throttled, and there the re-sync would be pure harm: wiping the
   * interpolation rings freezes every remote player until two fresh snapshots
   * land. The keepalive is unconditional; the surgery is not.
   */
  resumeFromBackground(): void {
    this.keepaliveTick(true);
    if (this.renderGapMs < RESUME_RESYNC_MS) return;
    this.accumulatorMs = 0;
    this.pingTimer = 0;
    this.clockReady = false;
    this.correction[0] = 0;
    this.correction[1] = 0;
    this.correction[2] = 0;
    for (let i = 0; i < this.tracks.length; i++) this.tracks[i].reset();
    for (let i = 0; i < this.entityTracks.length; i++) this.entityTracks[i].reset();
  }

  private onOpen(): void {
    this.setStatus('loading');
    this.reconnectAttempts = 0;
    const caps = this.hello.caps
      | (this.everConnected ? CAP_RETURNING : 0)
      | (chunkInflateSupported() ? CAP_INFLATE : 0);
    this.everConnected = true;
    encodeHello(this.writer, this.hello.name, this.hello.skin, caps, this.hello.avatar);
    this.rawSend(this.writer.copy());
    this.sendPing();
  }

  private onClose(code: number, reason: string): void {
    this.transport = null;
    this.resetSession();
    if (!this.autoReconnect || this.disposed) {
      // The session is over; nothing left to keep alive.
      this.stopKeepalive();
      this.setStatus('closed', reason || String(code));
      return;
    }
    this.setStatus('reconnecting', reason || String(code));
    const attempt = Math.min(this.reconnectAttempts++, 6);
    const base = RECONNECT_BACKOFF_MS * Math.pow(1.6, attempt);
    const delay = Math.min(15000, base) * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Forget everything session-scoped; the world survives a reconnect. */
  private resetSession(): void {
    // Anything still inside the inflate worker belongs to the connection that
    // just went away. Bumping the epoch drops those results on arrival.
    this.chunkEpoch++;
    this.pendingChunks.clear();
    this.hHead = 0;
    this.hCount = 0;
    this.inputSeq = 0;
    this.ackedInputSeq = 0;
    this.spawnReceived = false;
    this.clockReady = false;
    this.accumulatorMs = 0;
    this.pendingEdits.length = 0;
    for (let i = 0; i < this.tracks.length; i++) { this.tracks[i].reset(); this.players[i].active = false; }
    for (let i = 0; i < this.entityTracks.length; i++) { this.entityTracks[i].reset(); this.entities[i].active = false; }
    for (let i = 0; i < this.projectiles.length; i++) this.projectiles[i].active = false;
    this.playerSlotById.clear();
    this.entitySlotById.clear();
    this.projSlotById.clear();
    this.playerSlotUsed.fill(0);
    this.entitySlotUsed.fill(0);
    this.projSlotUsed.fill(0);
    this.entNetX.fill(0); this.entNetY.fill(0); this.entNetZ.fill(0);
    this.entNetYaw.fill(0);
    this.entNetVX.fill(0); this.entNetVY.fill(0); this.entNetVZ.fill(0);
    this.snapshot.reset();
    this.modeStateSeen = false;
    this.modeContextSeen = false;
    this.modeState.reset();
  }

  private setStatus(s: NetStatus, detail?: string): void {
    if (this.status === s) return;
    this.status = s;
    this.events.onStatus?.(s, detail);
  }

  private rawSend(bytes: Uint8Array): void {
    const t = this.transport;
    if (!t || t.readyState !== 1) return;
    // The keepalive is armed off the last byte that actually left, so a healthy
    // 60 Hz frame loop keeps it permanently disarmed and it costs one clock
    // read per packet. `nowMs` cannot be used here: it is frame time, and frame
    // time is exactly what stops in a background tab.
    this.lastSendWallMs = this.wallClock();
    t.send(bytes);
  }

  /**
   * Send an already-encoded packet. This is how a mode puts `C2S_MODE.SELECT`
   * and `C2S_MODE.ACTION` on the wire without the net client having to know
   * what either one means.
   */
  send(bytes: Uint8Array): boolean {
    const t = this.transport;
    if (!t || t.readyState !== 1) return false;
    this.lastSendWallMs = this.wallClock();
    t.send(bytes);
    return true;
  }

  get connected(): boolean { return this.transport !== null && this.transport.readyState === 1; }

  /* -------------------------------------------------------------- *
   * Input from the game loop
   * -------------------------------------------------------------- */

  setLook(yaw: number, pitch: number): void {
    this.inYaw = yaw;
    this.inPitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  setMove(moveX: number, moveZ: number): void {
    let x = moveX, z = moveZ;
    const l = Math.sqrt(x * x + z * z);
    if (l > 1) { x /= l; z /= l; }
    this.inMoveX = x;
    this.inMoveZ = z;
  }

  setButtons(buttons: number): void { this.inButtons = buttons & 0xffff; }
  setSlot(slot: number): void { this.inSlot = slot & 0x0f; }

  /** Camera eye position for the current frame, written into `out`. */
  eyePosition(out: Float64Array): void {
    out[0] = this.renderPos[0];
    out[1] = this.renderPos[1] + eyeHeightOf(this.predicted);
    out[2] = this.renderPos[2];
  }

  /* -------------------------------------------------------------- *
   * Frame update
   * -------------------------------------------------------------- */

  /**
   * Call once per rendered frame with the frame time in seconds. Emits input at
   * 60 Hz, predicts locally with the same steps, and advances the interpolation
   * clock for everyone else.
   */
  update(dtSeconds: number): void {
    // One wall-clock read per frame, so `renderGapMs` can tell a tab flick from
    // a real absence without the caller having to time anything.
    this.lastUpdateWallMs = this.wallClock();
    const dtMs = Math.min(250, Math.max(0, dtSeconds * 1000));
    this.nowMs += dtMs;

    if (this.connected && this.spawnReceived) {
      this.accumulatorMs += dtMs;
      let steps = 0;
      while (this.accumulatorMs >= INPUT_SEND_MS && steps < MAX_PREDICT_STEPS) {
        // The wire carries dtMs as a whole number of milliseconds, and the
        // server simulates exactly that integer. Predicting with the fractional
        // 16.667 instead would run the client 2% fast on every step and
        // manufacture a correction several times a second — so the integer is
        // chosen first and used for BOTH the packet and the prediction.
        let stepMs = Math.round(INPUT_SEND_MS);
        if (stepMs > this.accumulatorMs) stepMs = Math.floor(this.accumulatorMs);
        if (stepMs < 1) stepMs = 1;
        this.accumulatorMs -= stepMs;
        this.stepInput(stepMs);
        steps++;
      }
      if (steps === MAX_PREDICT_STEPS) this.accumulatorMs = 0;

      this.pingTimer += dtMs;
      if (this.pingTimer >= HEARTBEAT_MS) {
        this.pingTimer = 0;
        this.sendPing();
      }
    }

    // Bleed the correction offset away. This is the reason a misprediction
    // never snaps: the camera keeps moving, the error just stops existing.
    const rate = CORRECTION_RATE;
    for (let i = 0; i < 3; i++) {
      this.correction[i] = expDecay(this.correction[i], 0, rate, dtSeconds);
      if (Math.abs(this.correction[i]) < 1e-4) this.correction[i] = 0;
    }

    // Sub-step extrapolation removes the beat between a 60 Hz input step and a
    // display running at some other rate.
    const lead = Math.min(this.accumulatorMs, INPUT_SEND_MS) / 1000;
    this.renderPos[0] = this.predicted.pos[0] + this.predicted.vel[0] * lead + this.correction[0];
    this.renderPos[1] = this.predicted.pos[1] + this.predicted.vel[1] * lead + this.correction[1];
    this.renderPos[2] = this.predicted.pos[2] + this.predicted.vel[2] * lead + this.correction[2];

    this.updateInterpolation(dtSeconds);
  }

  /**
   * One 1/60 s input step: send it, then predict it.
   *
   * The prediction runs on the QUANTISED command, not on the raw input. The
   * wire rounds moveX/moveZ to int8/127 and the angles to the protocol grid; if
   * we predicted with the raw values we would disagree with the server by a
   * fraction of a percent of speed on every single step, which integrates into
   * a permanent stream of corrections.
   */
  private stepInput(dtMs: number): void {
    const seq = ++this.inputSeq;
    const moveX = Math.round(this.inMoveX * 127) / 127;
    const moveZ = Math.round(this.inMoveZ * 127) / 127;
    const yaw = dequantizeAngle(quantizeAngle(this.inYaw));
    const pitch = dequantizePitch(quantizePitch(this.inPitch));

    encodeInput(this.writer, seq, dtMs, yaw, pitch, this.inButtons, moveX, moveZ, this.inSlot);
    this.rawSend(this.writer.copy());

    const m = this.predicted;
    m.yaw = yaw;
    m.pitch = pitch;
    if (!this.local.dead) {
      moveStep(m, moveX, moveZ, this.inButtons, dtMs / 1000, this.world);
    }

    const i = this.hHead;
    this.hSeq[i] = seq;
    this.hDt[i] = dtMs;
    this.hButtons[i] = this.inButtons;
    this.hMoveX[i] = moveX;
    this.hMoveZ[i] = moveZ;
    this.hYaw[i] = yaw;
    this.hPitch[i] = pitch;
    this.hPX[i] = m.pos[0]; this.hPY[i] = m.pos[1]; this.hPZ[i] = m.pos[2];
    this.hVX[i] = m.vel[0]; this.hVY[i] = m.vel[1]; this.hVZ[i] = m.vel[2];
    this.hFlags[i] = (m.onGround ? 1 : 0) | (m.crouching ? 2 : 0) | (m.inWater ? 4 : 0);
    this.hJumpCd[i] = m.jumpCooldown;
    this.hCoyote[i] = m.coyote;
    this.hJumpBuf[i] = m.jumpBuffer;
    this.hHead = (i + 1) % PREDICTION_HISTORY;
    if (this.hCount < PREDICTION_HISTORY) this.hCount++;
  }

  /**
   * `keepalive` marks a ping sent by the independent clock rather than by the
   * frame loop. A hidden tab's `nowMs` is frozen, so its round trip would
   * measure as 0 ms and drag the displayed ping to zero; the sentinel stamp
   * lets `onPong` recognise the echo and leave the RTT estimate alone.
   */
  private sendPing(keepalive = false): void {
    const stamp = keepalive ? KEEPALIVE_PING_STAMP : (Math.round(this.nowMs) >>> 0);
    if (!keepalive) this.lastPingSentMs = this.nowMs;
    encodePing(this.writer, stamp);
    this.rawSend(this.writer.copy());
  }

  /* -------------------------------------------------------------- *
   * Receive
   * -------------------------------------------------------------- */

  private onMessage(data: ArrayBuffer | Uint8Array): void {
    const r = this.reader.reset(data);
    const id = r.bytes[r.offset];
    switch (id) {
      case S2C.WELCOME: this.onWelcome(r); break;
      case S2C.CHUNK: this.onChunk(r); break;
      case S2C.CHUNK_Z: this.onChunkZ(r); break;
      case S2C.SNAPSHOT: this.onSnapshot(r); break;
      case S2C.BLOCK_DELTA: this.onBlockDelta(r); break;
      case S2C.DAMAGE: this.onDamage(r); break;
      case S2C.KILL: this.onKill(r); break;
      case S2C.CHAT: this.onChat(r); break;
      case S2C.PONG: this.onPong(r); break;
      case S2C_MODE.STATE: this.onModeState(r); break;
      case S2C_MODE.EVENT: this.onModeEvent(r); break;
      case S2C_MODE.CONTEXT: this.onModeContext(r); break;
      default: break;
    }
  }

  private onWelcome(r: PacketReader): void {
    const w = decodeWelcome(r, this.welcome);
    this.playerId = w.playerId;
    this.local.id = w.playerId;
    this.seed = w.seed;
    this.gameMode = w.gameMode;
    this.chunksExpected = Math.max(1, w.chunkCount);
    this.chunksReceived = this.world.chunkCount;
    this.loadProgress = Math.min(1, this.chunksReceived / this.chunksExpected);
    this.events.onWelcome?.(w);
  }

  private onChunk(r: PacketReader): void {
    // Decode straight into the array the world will keep, so a chunk costs one
    // allocation and no copy.
    const existingCx = r.view.getInt16(r.offset + 1, true);
    const existingCz = r.view.getInt16(r.offset + 3, true);
    let target = this.world.chunkAt(existingCx, existingCz);
    if (!target) {
      target = new Uint8Array(CHUNK_VOLUME);
      this.world.putChunk(existingCx, existingCz, target);
      this.chunksReceived++;
    } else {
      this.world.revision++;
    }
    r.u8();
    r.i16();
    r.i16();
    const len = r.u32();
    target.fill(0);
    rleDecode(r.bytes, r.offset, len, target);
    r.skip(len);

    this.loadProgress = Math.min(1, this.chunksReceived / this.chunksExpected);
    this.events.onChunk?.(existingCx, existingCz, target, this.chunksReceived, this.chunksExpected);
  }

  /**
   * The compressed twin of `onChunk`. All this thread does is read a 13-byte
   * header and hand the deflate stream to the worker; the inflate, the RLE
   * expansion and the 64 KB allocation all happen off the main thread and come
   * back as a transferred buffer in `onChunkDecoded`.
   */
  private onChunkZ(r: PacketReader): void {
    const h = decodeChunkZHeader(r, this.chunkZ);
    if (h.rleLen <= 0 || h.zLen <= 0 || h.zLen > r.remaining) return;
    const z = r.bytes.subarray(r.offset, r.offset + h.zLen);
    r.skip(h.zLen);

    const key = chunkKey(h.cx, h.cz);
    // Claim the slot before the async hop, so BLOCK_DELTAs arriving in the gap
    // know to queue rather than vanish.
    const prior = this.pendingChunks.get(key);
    if (prior !== undefined) {
      // Same chunk re-sent (a round restart re-streams the world). The older
      // decode is now stale; its result is dropped by the seq check.
      prior.seq = this.chunkEpoch;
      prior.x.length = 0; prior.y.length = 0; prior.z.length = 0; prior.id.length = 0;
    } else {
      this.pendingChunks.set(key, { seq: this.chunkEpoch, x: [], y: [], z: [], id: [] });
    }

    if (this.inflater === null) {
      this.inflater = new ChunkInflater((res) => this.onChunkDecoded(res));
    }
    this.inflater.submit(h.cx, h.cz, this.chunkEpoch, h.rleLen, z);
  }

  /** A chunk came back from the inflate worker. Publish it exactly like `onChunk`. */
  private onChunkDecoded(res: InflateResult): void {
    const key = chunkKey(res.cx, res.cz);
    const pending = this.pendingChunks.get(key);
    // Stale: the session was reset, or a newer copy of this chunk is in flight.
    if (pending === undefined || pending.seq !== res.seq || res.seq !== this.chunkEpoch) return;
    this.pendingChunks.delete(key);

    if (res.voxels === undefined) {
      // The decode failed. Say nothing to the world rather than publish
      // garbage; the chunk stays missing and the round restart re-sends it.
      this.events.onStatus?.('error', `chunk ${res.cx},${res.cz}: ${res.err ?? 'decode failed'}`);
      return;
    }

    const voxels = new Uint8Array(res.voxels);
    if (voxels.length !== CHUNK_VOLUME) return;

    // Bake in every edit that overtook the chunk, BEFORE anyone sees it. The
    // renderer and the collision world then agree by construction.
    for (let i = 0; i < pending.x.length; i++) {
      const y = pending.y[i];
      if (y < 0 || y >= CHUNK_HEIGHT) continue;
      voxels[voxelIndex(pending.x[i] & CHUNK_SIZE_MASK, y, pending.z[i] & CHUNK_SIZE_MASK)] = pending.id[i];
    }

    const fresh = this.world.chunkAt(res.cx, res.cz) === undefined;
    this.world.putChunk(res.cx, res.cz, voxels);
    if (fresh) this.chunksReceived++;

    this.loadProgress = Math.min(1, this.chunksReceived / this.chunksExpected);
    this.events.onChunk?.(res.cx, res.cz, voxels, this.chunksReceived, this.chunksExpected);
  }

  private onBlockDelta(r: PacketReader): void {
    const d = decodeBlockDeltas(r, this.deltas);
    for (let i = 0; i < d.count; i++) {
      const pending = this.pendingChunks.size === 0
        ? undefined
        : this.pendingChunks.get(chunkKey(blockToChunk(d.x[i]), blockToChunk(d.z[i])));
      if (pending !== undefined) {
        // The chunk is still in the inflate worker. Hold the edit; it is baked
        // into the voxels in `onChunkDecoded`.
        pending.x.push(d.x[i]);
        pending.y.push(d.y[i]);
        pending.z.push(d.z[i]);
        pending.id.push(d.id[i]);
        continue;
      }
      this.world.setBlock(d.x[i], d.y[i], d.z[i], d.id[i]);
    }
    this.ackedEditSeq = d.ackEditSeq;
    this.reconcileEdits(d);
    if (d.count > 0) this.events.onBlocks?.(d.count, d.x, d.y, d.z, d.id);
  }

  /**
   * Drop predicted edits the server has acknowledged. If an acknowledged edit
   * is not reflected in the world after applying this message, the server
   * refused it — put the old block back.
   */
  private reconcileEdits(d: BlockDeltaBuffer): void {
    for (let i = this.pendingEdits.length - 1; i >= 0; i--) {
      const e = this.pendingEdits[i];
      if (e.seq > d.ackEditSeq) continue;
      const actual = this.world.getBlock(e.x, e.y, e.z);
      if (actual !== e.newId) {
        // The server's own value already landed in the delta list; nothing to
        // undo. Otherwise the edit was rejected and we roll it back.
        let inMessage = false;
        for (let k = 0; k < d.count; k++) {
          if (d.x[k] === e.x && d.y[k] === e.y && d.z[k] === e.z) { inMessage = true; break; }
        }
        if (!inMessage) this.world.setBlock(e.x, e.y, e.z, e.prevId);
      }
      this.pendingEdits.splice(i, 1);
    }
    // Anything older than two seconds is never coming back.
    const cutoff = this.nowMs - 2000;
    for (let i = this.pendingEdits.length - 1; i >= 0; i--) {
      const e = this.pendingEdits[i];
      if (e.sentMs >= cutoff) continue;
      if (this.world.getBlock(e.x, e.y, e.z) === e.newId) this.world.setBlock(e.x, e.y, e.z, e.prevId);
      this.pendingEdits.splice(i, 1);
    }
  }

  private onDamage(r: PacketReader): void {
    this.events.onDamage?.(decodeDamage(r, this.damage));
  }

  private onKill(r: PacketReader): void {
    this.events.onKill?.(decodeKill(r, this.kill));
  }

  private onChat(r: PacketReader): void {
    this.events.onChat?.(decodeChatS2C(r, this.chat));
  }

  private onPong(r: PacketReader): void {
    const p = decodePong(r, this.pong);
    this.serverTick = p.tick;
    if (p.clientTimeMs === KEEPALIVE_PING_STAMP) return;   // keepalive echo, not a sample
    const rtt = Math.max(0, this.nowMs - p.clientTimeMs);
    this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
  }

  /* -------------------------------------------------------------- *
   * Mode sidecar
   *
   * Three cold messages, three reused records. The registry hands each one to
   * whichever mode is live; a room that never sends them costs nothing.
   * -------------------------------------------------------------- */

  private onModeState(r: PacketReader): void {
    decodeModeState(r, this.modeState);
    this.modeStateSeen = true;
    this.events.onModeState?.(this.modeState);
  }

  private onModeEvent(r: PacketReader): void {
    decodeModeEvent(r, this.modeEvent);
    this.events.onModeEvent?.(this.modeEvent);
  }

  private onModeContext(r: PacketReader): void {
    decodeModeContext(r, this.modeContext);
    this.modeContextSeen = true;
    this.events.onModeContext?.(this.modeContext);
  }

  /* -------------------------------------------------------------- *
   * Snapshot
   * -------------------------------------------------------------- */

  private onSnapshot(r: PacketReader): void {
    const s = decodeSnapshot(r, this.snapshot);
    this.serverTick = s.tick;
    this.ackedInputSeq = s.ackInputSeq;
    this.matchOver = (s.flags & 2) !== 0;

    // Map server tick time onto the client clock. A big jump means we joined,
    // reconnected or the tab was suspended: snap rather than crawl.
    const serverTimeMs = s.tick * TICK_MS;
    const offset = this.nowMs - serverTimeMs;
    if (!this.clockReady || Math.abs(offset - this.clockOffsetMs) > 500) {
      this.clockOffsetMs = offset;
      this.clockReady = true;
    } else {
      this.clockOffsetMs += (offset - this.clockOffsetMs) * 0.05;
    }

    this.playerSeen.fill(0);
    this.entitySeen.fill(0);
    this.projSeen.fill(0);

    for (let i = 0; i < s.playerCount; i++) {
      const mask = s.playerMask[i];
      const id = s.playerId[i];
      if ((mask & PF_REMOVED) !== 0) { this.releasePlayer(id); continue; }

      const slot = this.slotForPlayer(id);
      if (slot < 0) continue;
      this.playerSeen[slot] = 1;
      const view = this.players[slot];
      view.id = id;
      view.active = true;
      view.name = s.playerName[i];
      view.skin = s.playerSkin[i];
      view.avatar = s.playerAvatar[i];
      view.team = s.playerTeam[i];
      view.health = s.playerHealth[i];
      view.armor = s.playerArmor[i];
      view.weapon = s.playerWeapon[i];
      view.state = s.playerState[i];
      view.kills = s.playerKills[i];
      view.deaths = s.playerDeaths[i];
      view.isLocal = id === this.playerId;

      if ((mask & PF_SPAWN) !== 0 && !view.isLocal) this.tracks[slot].reset();

      if (view.isLocal) {
        this.applyLocal(s, i, serverTimeMs);
      } else {
        this.tracks[slot].push(
          serverTimeMs,
          s.playerX[i], s.playerY[i], s.playerZ[i],
          s.playerYaw[i], s.playerPitch[i],
          s.playerVX[i], s.playerVY[i], s.playerVZ[i],
        );
      }
    }

    for (let i = 0; i < s.entityCount; i++) {
      const mask = s.entityMask[i];
      const id = s.entityId[i];
      if ((mask & EF_REMOVED) !== 0) {
        const gone = this.entitySlotById.get(id);
        if (gone !== undefined) this.events.onEntityGone?.(this.entities[gone], s.entityReason[i]);
        this.releaseEntity(id);
        continue;
      }

      const slot = this.slotForEntity(id);
      if (slot < 0) continue;
      this.entitySeen[slot] = 1;
      const view = this.entities[slot];
      view.id = id;
      view.active = true;
      // Apply ONLY the fields the server transmitted. Everything else keeps the
      // value this entity already had — `s.entity*[i]` is positional and would
      // otherwise hand us a different entity's leftovers. `EF_SPAWN` is the
      // server's promise that the record is complete.
      if ((mask & EF_SPAWN) !== 0) {
        view.type = s.entityType[i];
        view.variant = s.entityVariant[i];
      }
      if ((mask & EF_STATE) !== 0) view.state = s.entityState[i];
      if ((mask & EF_HEALTH) !== 0) view.health = s.entityHealth[i];
      if ((mask & EF_POS) !== 0) {
        this.entNetX[slot] = s.entityX[i];
        this.entNetY[slot] = s.entityY[i];
        this.entNetZ[slot] = s.entityZ[i];
      }
      if ((mask & EF_YAW) !== 0) this.entNetYaw[slot] = s.entityYaw[i];
      if ((mask & EF_VEL) !== 0) {
        this.entNetVX[slot] = s.entityVX[i];
        this.entNetVY[slot] = s.entityVY[i];
        this.entNetVZ[slot] = s.entityVZ[i];
      }
      this.entityTracks[slot].push(
        serverTimeMs, this.entNetX[slot], this.entNetY[slot], this.entNetZ[slot],
        this.entNetYaw[slot], 0, this.entNetVX[slot], this.entNetVY[slot], this.entNetVZ[slot],
      );
    }

    for (let i = 0; i < s.projectileCount; i++) {
      const id = s.projId[i];
      if ((s.projMask[i] & RF_REMOVED) !== 0) { this.releaseProjectile(id); continue; }
      const slot = this.slotForProjectile(id);
      if (slot < 0) continue;
      this.projSeen[slot] = 1;
      const view = this.projectiles[slot];
      const isNew = !view.active || view.id !== id;
      view.id = id;
      view.active = true;
      view.weapon = s.projWeapon[i];
      view.owner = s.projOwner[i];
      view.x = s.projX[i]; view.y = s.projY[i]; view.z = s.projZ[i];
      view.vx = s.projVX[i]; view.vy = s.projVY[i]; view.vz = s.projVZ[i];
      if (isNew) view.age = 0;
    }

    // Players and projectiles are sent in full every snapshot, so for them
    // silence still means gone, removal message or not.
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      if (this.playerSlotUsed[slot] === 1 && this.playerSeen[slot] === 0) this.releasePlayerSlot(slot);
    }
    // Entities are delta-encoded: an absent record means "nothing changed since
    // your baseline", NOT "gone". Only a full snapshot enumerates every entity,
    // so only a full snapshot may prune — it is the resync that catches an
    // EF_REMOVED the client somehow never applied.
    if ((s.flags & SNAP_FULL) !== 0) {
      for (let slot = 0; slot < MAX_ENTITIES; slot++) {
        if (this.entitySlotUsed[slot] === 1 && this.entitySeen[slot] === 0) this.releaseEntitySlot(slot);
      }
    }
    for (let slot = 0; slot < MAX_PROJECTILES; slot++) {
      if (this.projSlotUsed[slot] === 1 && this.projSeen[slot] === 0) this.releaseProjectileSlot(slot);
    }

    this.events.onSnapshot?.(s);
  }

  /** Adopt the server's authoritative local state and replay unacked input. */
  private applyLocal(s: SnapshotBuffer, i: number, _serverTimeMs: number): void {
    this.local.health = s.playerHealth[i];
    this.local.armor = s.playerArmor[i];
    this.local.weapon = s.playerWeapon[i];
    this.local.mag = s.playerMag[i];
    this.local.reserve = s.playerReserve[i];
    this.local.kills = s.playerKills[i];
    this.local.deaths = s.playerDeaths[i];
    this.local.state = s.playerState[i];
    const wasDead = this.local.dead;
    this.local.dead = (s.playerState[i] & PS_DEAD) !== 0;

    const sx = s.playerX[i], sy = s.playerY[i], sz = s.playerZ[i];

    if (!this.spawnReceived || (wasDead && !this.local.dead)) {
      // First snapshot, or we just respawned: take the server's word for it.
      this.predicted.pos[0] = sx; this.predicted.pos[1] = sy; this.predicted.pos[2] = sz;
      this.predicted.vel[0] = s.playerVX[i]; this.predicted.vel[1] = s.playerVY[i]; this.predicted.vel[2] = s.playerVZ[i];
      this.predicted.yaw = s.playerYaw[i];
      this.predicted.pitch = s.playerPitch[i];
      this.predicted.onGround = true;
      this.predicted.crouching = false;
      this.predicted.jumpCooldown = 0;
      this.predicted.coyote = 0;
      this.predicted.jumpBuffer = 0;
      this.correction[0] = 0; this.correction[1] = 0; this.correction[2] = 0;
      this.hHead = 0;
      this.hCount = 0;
      this.spawnReceived = true;
      this.setStatus('playing');
      return;
    }

    // Locate the history entry the server just acknowledged.
    const ack = s.ackInputSeq;
    let found = -1;
    for (let k = 0; k < this.hCount; k++) {
      const idx = (this.hHead - 1 - k + PREDICTION_HISTORY * 2) % PREDICTION_HISTORY;
      if (this.hSeq[idx] === ack) { found = idx; break; }
    }
    if (found < 0) {
      // No matching command (huge stall or a fresh session): accept the server.
      const dx = sx - this.predicted.pos[0];
      const dy = sy - this.predicted.pos[1];
      const dz = sz - this.predicted.pos[2];
      const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (err > RECONCILE_EPSILON) {
        this.pushCorrection(dx, dy, dz, err);
        this.predicted.pos[0] = sx; this.predicted.pos[1] = sy; this.predicted.pos[2] = sz;
        this.predicted.vel[0] = s.playerVX[i]; this.predicted.vel[1] = s.playerVY[i]; this.predicted.vel[2] = s.playerVZ[i];
      }
      this.hCount = 0;
      this.hHead = 0;
      return;
    }

    const ex = sx - this.hPX[found];
    const ey = sy - this.hPY[found];
    const ez = sz - this.hPZ[found];
    const err = Math.sqrt(ex * ex + ey * ey + ez * ez);

    // Drop acknowledged history either way.
    const keep: number[] = [];
    for (let k = 0; k < this.hCount; k++) {
      const idx = (this.hHead - this.hCount + k + PREDICTION_HISTORY * 2) % PREDICTION_HISTORY;
      if (this.hSeq[idx] > ack) keep.push(idx);
    }

    if (err <= RECONCILE_EPSILON) {
      this.trimHistory(keep);
      return;
    }

    // Rewind to the server's state at the acked command, restore the parts of
    // the body the wire does not carry, then replay everything since.
    const beforeX = this.predicted.pos[0];
    const beforeY = this.predicted.pos[1];
    const beforeZ = this.predicted.pos[2];

    const m = this.predicted;
    m.pos[0] = sx; m.pos[1] = sy; m.pos[2] = sz;
    m.vel[0] = s.playerVX[i]; m.vel[1] = s.playerVY[i]; m.vel[2] = s.playerVZ[i];
    const flags = this.hFlags[found];
    m.onGround = (flags & 1) !== 0;
    m.crouching = (flags & 2) !== 0;
    m.inWater = (flags & 4) !== 0;
    m.jumpCooldown = this.hJumpCd[found];
    m.coyote = this.hCoyote[found];
    m.jumpBuffer = this.hJumpBuf[found];

    for (let k = 0; k < keep.length; k++) {
      const idx = keep[k];
      m.yaw = this.hYaw[idx];
      m.pitch = this.hPitch[idx];
      moveStep(m, this.hMoveX[idx], this.hMoveZ[idx], this.hButtons[idx], this.hDt[idx] / 1000, this.world);
      this.hPX[idx] = m.pos[0]; this.hPY[idx] = m.pos[1]; this.hPZ[idx] = m.pos[2];
      this.hVX[idx] = m.vel[0]; this.hVY[idx] = m.vel[1]; this.hVZ[idx] = m.vel[2];
      this.hFlags[idx] = (m.onGround ? 1 : 0) | (m.crouching ? 2 : 0) | (m.inWater ? 4 : 0);
      this.hJumpCd[idx] = m.jumpCooldown;
      this.hCoyote[idx] = m.coyote;
      this.hJumpBuf[idx] = m.jumpBuffer;
    }
    m.yaw = this.inYaw;
    m.pitch = this.inPitch;

    this.pushCorrection(m.pos[0] - beforeX, m.pos[1] - beforeY, m.pos[2] - beforeZ, err);
    this.trimHistory(keep);
    this.events.onCorrection?.(err);
  }

  /**
   * Record where the body moved to so the camera can stay where it was and
   * catch up smoothly. Beyond RECONCILE_SNAP the error is too large to hide.
   */
  private pushCorrection(dx: number, dy: number, dz: number, err: number): void {
    if (err > RECONCILE_SNAP) {
      this.correction[0] = 0; this.correction[1] = 0; this.correction[2] = 0;
      return;
    }
    this.correction[0] -= dx;
    this.correction[1] -= dy;
    this.correction[2] -= dz;
    const len = Math.sqrt(
      this.correction[0] * this.correction[0] +
      this.correction[1] * this.correction[1] +
      this.correction[2] * this.correction[2],
    );
    if (len > RECONCILE_SNAP) {
      const k = RECONCILE_SNAP / len;
      this.correction[0] *= k; this.correction[1] *= k; this.correction[2] *= k;
    }
  }

  /** Compact the history ring down to the entries that are still unacked. */
  private trimHistory(keep: number[]): void {
    if (keep.length === this.hCount) return;
    const n = keep.length;
    if (n === 0) { this.hCount = 0; this.hHead = 0; return; }
    const seq = new Uint32Array(n), dt = new Float32Array(n), btn = new Uint16Array(n);
    const mx = new Float32Array(n), mz = new Float32Array(n);
    const yw = new Float32Array(n), pt = new Float32Array(n);
    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    const vx = new Float64Array(n), vy = new Float64Array(n), vz = new Float64Array(n);
    const fl = new Uint8Array(n), jc = new Float32Array(n), cy = new Float32Array(n), jb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = keep[i];
      seq[i] = this.hSeq[s]; dt[i] = this.hDt[s]; btn[i] = this.hButtons[s];
      mx[i] = this.hMoveX[s]; mz[i] = this.hMoveZ[s];
      yw[i] = this.hYaw[s]; pt[i] = this.hPitch[s];
      px[i] = this.hPX[s]; py[i] = this.hPY[s]; pz[i] = this.hPZ[s];
      vx[i] = this.hVX[s]; vy[i] = this.hVY[s]; vz[i] = this.hVZ[s];
      fl[i] = this.hFlags[s]; jc[i] = this.hJumpCd[s]; cy[i] = this.hCoyote[s]; jb[i] = this.hJumpBuf[s];
    }
    this.hSeq.set(seq, 0); this.hDt.set(dt, 0); this.hButtons.set(btn, 0);
    this.hMoveX.set(mx, 0); this.hMoveZ.set(mz, 0);
    this.hYaw.set(yw, 0); this.hPitch.set(pt, 0);
    this.hPX.set(px, 0); this.hPY.set(py, 0); this.hPZ.set(pz, 0);
    this.hVX.set(vx, 0); this.hVY.set(vy, 0); this.hVZ.set(vz, 0);
    this.hFlags.set(fl, 0); this.hJumpCd.set(jc, 0); this.hCoyote.set(cy, 0); this.hJumpBuf.set(jb, 0);
    this.hCount = n;
    this.hHead = n % PREDICTION_HISTORY;
  }


  /* --- id-keyed view slots ------------------------------------------- */

  private slotForPlayer(id: number): number {
    const existing = this.playerSlotById.get(id);
    if (existing !== undefined) return existing;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (this.playerSlotUsed[i] === 1) continue;
      this.playerSlotUsed[i] = 1;
      this.playerSlotById.set(id, i);
      this.tracks[i].reset();
      return i;
    }
    return -1;
  }

  private slotForEntity(id: number): number {
    const existing = this.entitySlotById.get(id);
    if (existing !== undefined) return existing;
    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (this.entitySlotUsed[i] === 1) continue;
      this.entitySlotUsed[i] = 1;
      this.entitySlotById.set(id, i);
      this.entityTracks[i].reset();
      return i;
    }
    return -1;
  }

  private slotForProjectile(id: number): number {
    const existing = this.projSlotById.get(id);
    if (existing !== undefined) return existing;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (this.projSlotUsed[i] === 1) continue;
      this.projSlotUsed[i] = 1;
      this.projSlotById.set(id, i);
      return i;
    }
    return -1;
  }

  private releasePlayer(id: number): void {
    const slot = this.playerSlotById.get(id);
    if (slot === undefined) return;
    this.releasePlayerSlot(slot);
  }

  private releasePlayerSlot(slot: number): void {
    const view = this.players[slot];
    this.playerSlotById.delete(view.id);
    this.playerSlotUsed[slot] = 0;
    this.tracks[slot].reset();
    view.active = false;
    view.isLocal = false;
    view.id = 0;
  }

  private releaseEntity(id: number): void {
    const slot = this.entitySlotById.get(id);
    if (slot === undefined) return;
    this.releaseEntitySlot(slot);
  }

  private releaseEntitySlot(slot: number): void {
    const view = this.entities[slot];
    this.entitySlotById.delete(view.id);
    this.entitySlotUsed[slot] = 0;
    this.entityTracks[slot].reset();
    view.active = false;
    view.id = 0;
    // Clear the delta target too: the next tenant of this slot is a different
    // entity, and the server only re-sends the fields it considers changed.
    this.entNetX[slot] = 0; this.entNetY[slot] = 0; this.entNetZ[slot] = 0;
    this.entNetYaw[slot] = 0;
    this.entNetVX[slot] = 0; this.entNetVY[slot] = 0; this.entNetVZ[slot] = 0;
  }

  private releaseProjectile(id: number): void {
    const slot = this.projSlotById.get(id);
    if (slot === undefined) return;
    this.releaseProjectileSlot(slot);
  }

  private releaseProjectileSlot(slot: number): void {
    const view = this.projectiles[slot];
    this.projSlotById.delete(view.id);
    this.projSlotUsed[slot] = 0;
    view.active = false;
    view.id = 0;
  }

  /* -------------------------------------------------------------- *
   * Interpolation
   * -------------------------------------------------------------- */

  private updateInterpolation(dtSeconds: number): void {
    if (!this.clockReady) return;
    const renderTime = this.nowMs - this.clockOffsetMs - INTERP_DELAY_MS;
    const out = this.sampleOut;

    for (let i = 0; i < this.players.length; i++) {
      const view = this.players[i];
      if (!view.active || view.isLocal) continue;
      if (!this.tracks[i].sample(renderTime, out)) continue;
      view.x = out[0]; view.y = out[1]; view.z = out[2];
      view.yaw = out[3]; view.pitch = out[4];
      view.vx = out[5]; view.vy = out[6]; view.vz = out[7];
    }

    for (let i = 0; i < this.entities.length; i++) {
      const view = this.entities[i];
      if (!view.active) continue;
      if (!this.entityTracks[i].sample(renderTime, out)) continue;
      view.x = out[0]; view.y = out[1]; view.z = out[2];
      view.yaw = out[3];
      view.vx = out[5]; view.vy = out[6]; view.vz = out[7];
    }

    // Projectiles are dead-reckoned from the last snapshot: they are fast, and
    // a 100 ms delay would make a rocket look like it left the barrel late.
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (!p.active) continue;
      p.age += dtSeconds;
      p.x += p.vx * dtSeconds;
      p.y += p.vy * dtSeconds;
      p.z += p.vz * dtSeconds;
    }

    // The local record keeps the predicted transform so the scoreboard and the
    // third-person shadow agree with the camera.
    for (let i = 0; i < this.players.length; i++) {
      const view = this.players[i];
      if (!view.active || !view.isLocal) continue;
      view.x = this.renderPos[0];
      view.y = this.renderPos[1];
      view.z = this.renderPos[2];
      view.yaw = this.predicted.yaw;
      view.pitch = this.predicted.pitch;
      view.vx = this.predicted.vel[0];
      view.vy = this.predicted.vel[1];
      view.vz = this.predicted.vel[2];
    }
  }

  /* -------------------------------------------------------------- *
   * Outbound actions
   * -------------------------------------------------------------- */

  /**
   * Break or place a block. The change is applied locally straight away and
   * rolled back if the server refuses it. Returns false when the local check
   * already says no.
   */
  requestEdit(action: BlockAction, x: number, y: number, z: number, blockId: number): boolean {
    if (!this.connected || this.local.dead) return false;
    if (y < 1 || y >= CHUNK_HEIGHT) return false;
    const prev = this.world.getBlock(x, y, z);
    const next = action === BlockAction.PLACE ? blockId : BlockId.AIR;
    if (prev === next) return false;
    if (action === BlockAction.PLACE && BLOCK_SOLID[prev] === 1) return false;

    const seq = ++this.editSeq;
    encodeBlockEdit(this.writer, seq, action, x, y, z, blockId);
    this.rawSend(this.writer.copy());

    this.world.setBlock(x, y, z, next);
    this.pendingEdits.push({ seq, x, y, z, prevId: prev, newId: next, sentMs: this.nowMs });
    if (this.pendingEdits.length > 128) this.pendingEdits.shift();
    return true;
  }

  sendChat(text: string): void {
    if (!this.connected || text.length === 0) return;
    encodeChatC2S(this.writer, text);
    this.rawSend(this.writer.copy());
  }

  requestRespawn(): void {
    if (!this.connected) return;
    encodeRespawn(this.writer);
    this.rawSend(this.writer.copy());
  }

  /**
   * Change what everyone else sees you wearing, without a reconnect.
   *
   * Six bytes, sent only when something actually changed — the editor is a live
   * preview and would otherwise fire one of these per slider frame. The value
   * is also written back into the HELLO so a reconnect keeps the new look.
   */
  setAvatar(avatar: number, skin: number): void {
    const a = avatar >>> 0;
    const k = skin & 0xff;
    if (this.hello.avatar === a && this.hello.skin === k) return;
    this.hello.avatar = a;
    this.hello.skin = k;
    if (!this.connected) return;
    encodeAppearance(this.writer, k, a);
    this.rawSend(this.writer.copy());
  }

  /* -------------------------------------------------------------- *
   * Introspection
   * -------------------------------------------------------------- */

  /** Live scoreboard, highest score first. Allocates — call it for the UI only. */
  scoreboard(): RemotePlayerView[] {
    const out = this.players.filter((p) => p.active);
    out.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
    return out;
  }

  playerById(id: number): RemotePlayerView | undefined {
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i].active && this.players[i].id === id) return this.players[i];
    }
    return undefined;
  }

  /** Unacked input commands — a direct read on how far ahead prediction is. */
  get pendingInputs(): number { return this.hCount; }
  get pendingEditCount(): number { return this.pendingEdits.length; }
  get interpDelayMs(): number { return INTERP_DELAY_MS; }
  get lastAckedInput(): number { return this.ackedInputSeq; }
  get lastAckedEdit(): number { return this.ackedEditSeq; }
  get lastPingAgeMs(): number { return this.nowMs - this.lastPingSentMs; }
  /** Wall-clock ms since the last byte left. What the keepalive is armed off. */
  get socketSilenceMs(): number { return this.wallClock() - this.lastSendWallMs; }
  /** Wall-clock ms since the frame loop last called `update()`. */
  get renderGapMs(): number { return this.wallClock() - this.lastUpdateWallMs; }
  /** Interpolation clock state. Exposed so the resume path can be asserted. */
  get debugClockReady(): boolean { return this.clockReady; }
  get debugClockOffsetMs(): number { return this.clockOffsetMs; }
}
