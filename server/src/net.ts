/**
 * DOOMCRAFT — connection lifecycle, snapshot assembly and anti-cheat.
 *
 * One `Connection` per socket. It owns:
 *   - a jitter-buffered input queue with a hard time budget (a client cannot
 *     buy itself extra physics by sending more commands),
 *   - a delta baseline SnapshotBuffer plus a scratch buffer for the frame,
 *   - a per-client chunk interest set and a bandwidth budget,
 *   - the rate limits that make lying expensive.
 *
 * Transport agnostic: `ws` on the real server, a MessagePort inside the
 * client's local-server Worker. Nothing here imports node:* or the DOM.
 */

import {
  BlockDeltaBuffer,
  C2S,
  CAP_INFLATE,
  CAP_LOW_SPEC,
  CHUNK_HEIGHT,
  CHUNK_SIZE,
  CLIENT_TIMEOUT_MS,
  DMG_YOU_ARE_VICTIM,
  MAX_BLOCK_DELTAS_PER_MESSAGE,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  PF_ALL,
  PF_AMMO,
  PF_LOCAL,
  PF_REMOVED,
  PF_SPAWN,
  EF_ALL,
  EF_HEALTH,
  EF_POS,
  EF_REMOVED,
  EF_SPAWN,
  EF_STATE,
  EF_VEL,
  EF_YAW,
  RF_ALL,
  RF_REMOVED,
  RF_SPAWN,
  PROTOCOL_VERSION,
  PacketReader,
  PacketWriter,
  S2C,
  SNAP_FULL,
  SNAP_MATCH_OVER,
  SnapshotBuffer,
  TICK_MS,
  WORLD_CHUNK_COUNT,
  WORLD_CHUNKS_PER_AXIS,
  WORLD_MIN_CHUNK,
  MAX_ENTITIES,
  MAX_PROJECTILES,
  EntityType,
  clamp,
  copyPlayerRecord,
  createBlockEditCommand,
  createAppearanceMessage,
  createHelloMessage,
  createInputCommand,
  decodeBlockEdit,
  decodeChatC2S,
  decodeAppearance,
  decodeHello,
  decodeInput,
  decodePing,
  encodeBlockDeltas,
  CHUNK_HEADER_BYTES,
  CHUNK_Z_HEADER_BYTES,
  encodeChatS2C,
  encodeChunk,
  encodeChunkZ,
  encodeDamage,
  encodeKill,
  encodePong,
  encodeSnapshot,
  encodeWelcome,
  playerDeltaMask,
  quantizeAngle,
  quantizePos,
  quantizeVel,
  readMessageId,
  rleEncodeInto,
  rleMaxBytes,
} from '@doomcraft/shared';
import {
  C2S_MODE,
  createModeActionMessage,
  createModeSelectMessage,
  decodeModeAction,
  decodeModeSelect,
  encodeModeContext,
  encodeModeEvent,
  encodeModeState,
  type ModeActionMessage,
  type ModeContextMessage,
  type ModeEventMessage,
  type ModeSelectMessage,
  type ModeStateBuffer,
} from '@doomcraft/shared/modes';
import type { PlayerEntity } from './sim.js';
import { EditResult, Simulation } from './sim.js';
import { ServerWorld } from './world.js';

/* ------------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------------ */

/** Commands shorter than this are noise; longer than this are a lie. */
export const MIN_INPUT_DT_MS = 1;
export const MAX_INPUT_DT_MS = 50;
/** Simulated milliseconds a client may buy per real tick. 1.0 == no headroom. */
export const INPUT_TIME_SCALE = 1.10;
/** Ceiling on unspent simulated time, so a stalled client catches up but never sprints. */
export const INPUT_BANK_MAX_MS = 250;
/** Commands held before the oldest gets dropped. */
export const INPUT_QUEUE_CAPACITY = 64;
/** Steady-state queue depth we try to keep — the jitter buffer. */
export const INPUT_QUEUE_TARGET = 3;
/** Messages per second before a connection is treated as hostile. */
export const MAX_MESSAGES_PER_SECOND = 400;
/** Chunk bytes per tick while the client is still loading in. */
export const CHUNK_BURST_BYTES = 96 * 1024;
/** Chunk bytes per tick once the client is playing. */
export const CHUNK_STEADY_BYTES = 16 * 1024;
/** Stop queueing chunks when this much is already waiting in the socket. */
export const SOCKET_BACKLOG_LIMIT = 512 * 1024;
/** A full (baseline-free) snapshot at least this often, for safety. */
export const FULL_SNAPSHOT_INTERVAL_MS = 3000;
/**
 * Cold-cache deflates one room may run in one 20 ms slice of its 50 ms tick.
 *
 * Compressing a chunk costs ~0.48 ms; the cache makes that a once-per-chunk
 * cost for the whole room's lifetime, but the *first* joiner into a fresh room
 * pays all of it. Uncapped, a 96 KB burst budget buys ~19 compressed chunks in
 * one tick — 9 ms of deflate in a room whose whole tick is normally 0.4 ms.
 * Six keeps the worst tick under 3 ms and still streams 120 chunks/s, which is
 * faster than the uncompressed path manages today.
 */
export const CHUNK_DEFLATES_PER_TICK = 6;

const CHUNK_SLOTS = WORLD_CHUNK_COUNT;

/**
 * Zero-length sentinel, never sent. It means two things depending on where it
 * is found, and both are "do not deflate this chunk right now":
 *   - returned from `compressedChunk`: cold chunk, this tick's deflate budget
 *     is spent, come back next tick;
 *   - stored in `chunkZCache`: this chunk does not compress, stop trying.
 */
const EMPTY_PACKET = new Uint8Array(0);

function chunkSlot(cx: number, cz: number): number {
  return (cx - WORLD_MIN_CHUNK) + (cz - WORLD_MIN_CHUNK) * WORLD_CHUNKS_PER_AXIS;
}

/* ------------------------------------------------------------------------ *
 * Chunk compression
 *
 * The join burst is 169 chunks and 2.99 MB, and it is the same 2.99 MB for
 * every player who ever joins the room. RLE'd voxels deflate 3.8x, so the
 * bytes are the easy part; the trap is *where* the CPU goes.
 *
 *   - `ws` permessage-deflate gets the same 3.8x but costs a zlib context per
 *     socket and compresses every 20 Hz snapshot forever. Measured on this
 *     tree: server CPU per joiner 67 -> 253 ms, and steady-state throughput
 *     5.7 -> 13.2 millicores/player (players/core 177 -> 76). Rejected.
 *   - Compressing here instead means the deflate is per *chunk*, so it is
 *     cached and the second joiner pays a memcpy. It also never touches the
 *     snapshot path, which is where the tick budget lives.
 *
 * This module cannot import `node:zlib` — it also runs inside the browser's
 * local-server Worker. So the deflate arrives by injection. No compressor
 * registered (the Worker) or no `CAP_INFLATE` from the client (an older build)
 * and the uncompressed `S2C.CHUNK` path runs exactly as it always has.
 * ------------------------------------------------------------------------ */

/** Raw-deflate `src`, or return null to fall back to the uncompressed path. */
export type ChunkCompressor = (src: Uint8Array) => Uint8Array | null;

let chunkCompressor: ChunkCompressor | null = null;

/**
 * Install the raw-deflate used for `S2C.CHUNK_Z`. Called once at boot by
 * `server/src/index.ts`; left unset everywhere else, including the Worker.
 */
export function setChunkCompressor(fn: ChunkCompressor | null): void {
  chunkCompressor = fn;
}

/** Whether compressed chunks are available in this process at all. */
export function hasChunkCompressor(): boolean {
  return chunkCompressor !== null;
}

/**
 * One RLE staging buffer for the whole process, not one per room.
 *
 * It only lives between `rleEncodeInto` and the synchronous deflate on the very
 * next line, and a Node server is single threaded, so there is no room in which
 * two users of it can overlap. Per-room it would be 192 KB of permanently idle
 * memory on a box that runs eighty rooms per core.
 */
let rleScratch: Uint8Array | null = null;
function rleScratchFor(voxelCount: number): Uint8Array {
  const need = rleMaxBytes(voxelCount);
  if (rleScratch === null || rleScratch.length < need) rleScratch = new Uint8Array(need);
  return rleScratch;
}

/* ------------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------------ */

/** The minimum a socket must provide. `ws` and a Worker port both fit. */
export interface NetTransport {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  /** Bytes still queued for the wire. Return 0 when the transport cannot tell. */
  readonly bufferedAmount: number;
}

/** What the room must provide to the net layer. */
export interface NetHost {
  /** Accept a client. Return the assigned player id, or 0 to refuse. */
  onHello(conn: Connection, name: string, skin: number, caps: number): number;
  onDisconnect(conn: Connection): void;
  onChat(conn: Connection, text: string): void;
  onRespawnRequest(conn: Connection): void;
  /**
   * `C2S_MODE.SELECT`. Optional: a room that does not implement it simply runs
   * whatever mode it was constructed with, which is what the tests do.
   */
  onModeSelect?(conn: Connection, msg: ModeSelectMessage): void;
  /** `C2S_MODE.ACTION` — use, buy, undo, ready, restart. Optional. */
  onModeAction?(conn: Connection, msg: ModeActionMessage): void;
  readonly seed: number;
  readonly gameMode: number;
  readonly matchOver: boolean;
}

export interface ConnectionStats {
  droppedInputs: number;
  rejectedEdits: number;
  appliedInputs: number;
  bytesSent: number;
  bytesReceived: number;
  messagesIn: number;
  snapshotsSent: number;
  chunksSent: number;
  violations: number;
}

/* ------------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------------ */

export class Connection {
  readonly id: number;
  readonly transport: NetTransport;
  playerId = 0;
  player: PlayerEntity | null = null;
  name = '';
  skin = 0;
  /** Packed appearance from HELLO / C2S.APPEARANCE. Opaque to the server. */
  avatar = 0;
  caps = 0;
  /** True once HELLO has been accepted. */
  ready = false;
  closed = false;
  /** Device id supplied out of band by the HTTP profile API, for persistence. */
  deviceId = '';

  readonly stats: ConnectionStats = {
    droppedInputs: 0, rejectedEdits: 0, appliedInputs: 0,
    bytesSent: 0, bytesReceived: 0, messagesIn: 0,
    snapshotsSent: 0, chunksSent: 0, violations: 0,
  };

  /* --- input jitter buffer (struct of arrays, never reallocated) --- */
  readonly qSeq = new Uint32Array(INPUT_QUEUE_CAPACITY);
  readonly qDt = new Uint16Array(INPUT_QUEUE_CAPACITY);
  readonly qYaw = new Float32Array(INPUT_QUEUE_CAPACITY);
  readonly qPitch = new Float32Array(INPUT_QUEUE_CAPACITY);
  readonly qButtons = new Uint16Array(INPUT_QUEUE_CAPACITY);
  readonly qMoveX = new Float32Array(INPUT_QUEUE_CAPACITY);
  readonly qMoveZ = new Float32Array(INPUT_QUEUE_CAPACITY);
  readonly qSlot = new Uint8Array(INPUT_QUEUE_CAPACITY);
  qHead = 0;
  qTail = 0;
  qCount = 0;
  timeBankMs = 0;
  lastAcceptedSeq = 0;

  /* --- latency estimate (see estimateLatency) --- */
  helloRecvMs = 0;
  clientSimMs = 0;
  lagFloorMs = Number.POSITIVE_INFINITY;
  rttMs = 0;
  lastRecvMs = 0;
  lastPongMs = 0;

  /* --- outgoing state --- */
  readonly baseline: SnapshotBuffer;
  readonly scratch: SnapshotBuffer;
  baselineTick = 0;
  lastFullMs = -1e9;
  lastRosterVersion = -1;
  readonly knownEntity = new Uint8Array(MAX_ENTITIES);
  readonly knownEntityGen = new Uint16Array(MAX_ENTITIES);
  readonly knownProj = new Uint8Array(MAX_PROJECTILES);
  readonly knownProjGen = new Uint16Array(MAX_PROJECTILES);
  /**
   * Per-entity delta baseline: the last **quantised** values this connection
   * was actually sent, indexed by *sim slot* and only valid while
   * `knownEntity[slot] === 1 && knownEntityGen[slot] === sim.entGen[slot]`, so
   * a recycled slot can never inherit its predecessor's baseline.
   *
   * Quantised, not raw, for the same reason `playerDeltaMask` compares
   * quantised values: "changed" has to mean the same thing here as it does in
   * `encodeSnapshot`, or sub-quantum jitter would bill bytes that carry no
   * information — or worse, a real change would round to the same wire value
   * and never be sent again.
   */
  readonly entBaseQX = new Int16Array(MAX_ENTITIES);
  readonly entBaseQY = new Int16Array(MAX_ENTITIES);
  readonly entBaseQZ = new Int16Array(MAX_ENTITIES);
  readonly entBaseQVX = new Int16Array(MAX_ENTITIES);
  readonly entBaseQVY = new Int16Array(MAX_ENTITIES);
  readonly entBaseQVZ = new Int16Array(MAX_ENTITIES);
  readonly entBaseQYaw = new Uint16Array(MAX_ENTITIES);
  readonly entBaseHealth = new Uint16Array(MAX_ENTITIES);
  readonly entBaseState = new Uint8Array(MAX_ENTITIES);
  readonly chunkSent = new Uint8Array(CHUNK_SLOTS);
  chunksAcked = 0;
  loadingIn = true;

  /* --- rate limiting --- */
  msgWindowStartMs = 0;
  msgWindowCount = 0;

  readonly writer = new PacketWriter(16384);
  readonly deltas = new BlockDeltaBuffer(MAX_BLOCK_DELTAS_PER_MESSAGE);

  constructor(id: number, transport: NetTransport, maxPlayers: number) {
    this.id = id;
    this.transport = transport;
    this.baseline = new SnapshotBuffer(maxPlayers, MAX_ENTITIES, MAX_PROJECTILES);
    this.scratch = new SnapshotBuffer(maxPlayers, MAX_ENTITIES, MAX_PROJECTILES);
  }

  send(bytes: Uint8Array): void {
    if (this.closed || !this.transport.isOpen) return;
    this.stats.bytesSent += bytes.length;
    this.transport.send(bytes);
  }

  pushInput(seq: number, dtMs: number, yaw: number, pitch: number, buttons: number, moveX: number, moveZ: number, slot: number): void {
    if (this.qCount >= INPUT_QUEUE_CAPACITY) {
      // Overflow: throw away the oldest command. A client that overruns the
      // queue is either lagging badly or trying to bank extra movement.
      this.qHead = (this.qHead + 1) % INPUT_QUEUE_CAPACITY;
      this.qCount--;
      this.stats.droppedInputs++;
    }
    const i = this.qTail;
    this.qSeq[i] = seq;
    this.qDt[i] = dtMs;
    this.qYaw[i] = yaw;
    this.qPitch[i] = pitch;
    this.qButtons[i] = buttons;
    this.qMoveX[i] = moveX;
    this.qMoveZ[i] = moveZ;
    this.qSlot[i] = slot;
    this.qTail = (i + 1) % INPUT_QUEUE_CAPACITY;
    this.qCount++;
  }

  resetQueue(): void {
    this.qHead = 0;
    this.qTail = 0;
    this.qCount = 0;
    this.timeBankMs = 0;
  }
}

/* ------------------------------------------------------------------------ *
 * NetHub
 * ------------------------------------------------------------------------ */

export class NetHub {
  readonly connections: Connection[] = [];
  private readonly sim: Simulation;
  private readonly world: ServerWorld;
  private readonly host: NetHost;
  private nextConnId = 1;

  private readonly hello = createHelloMessage();
  private readonly appearance = createAppearanceMessage();
  private readonly modeSelectMsg = createModeSelectMessage();
  private readonly modeActionMsg = createModeActionMessage();
  private readonly input = createInputCommand();
  private readonly edit = createBlockEditCommand();
  private readonly reader = new PacketReader();
  private readonly shared = new PacketWriter(16384);

  /* --- compressed chunk cache (see "Chunk compression" above) --- */
  /**
   * slot -> the finished `S2C.CHUNK_Z` packet for that chunk, ready to hand
   * straight to a socket. Built lazily on first send and dropped whenever the
   * chunk's voxels change, so it is never stale and idle rooms never pay for
   * it. ~4.9 KB per cached chunk, ~0.83 MB if a room ends up streaming all 169.
   */
  private readonly chunkZCache: (Uint8Array | null)[] = new Array(CHUNK_SLOTS).fill(null);
  /** Deflates spent this tick, reset by `flush`. */
  private deflateBudget = 0;

  /** Simulation clock, advanced by the room each tick. */
  nowMs = 0;
  /**
   * Monotonic wall clock in milliseconds since the room started. Separate from
   * `nowMs` because the latency estimate has to measure real arrival times, not
   * fixed 50 ms simulation steps.
   */
  clock: () => number;

  constructor(sim: Simulation, world: ServerWorld, host: NetHost, clock?: () => number) {
    this.sim = sim;
    this.world = world;
    this.host = host;
    this.clock = clock ?? (() => this.nowMs);
  }

  /* -------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------- */

  attach(transport: NetTransport, maxPlayers = MAX_PLAYERS): Connection {
    const now = this.clock();
    const conn = new Connection(this.nextConnId++, transport, maxPlayers);
    conn.lastRecvMs = now;
    conn.helloRecvMs = now;
    conn.msgWindowStartMs = now;
    this.connections.push(conn);
    return conn;
  }

  detach(conn: Connection, code = 1000, reason = 'bye'): void {
    if (conn.closed) return;
    conn.closed = true;
    const i = this.connections.indexOf(conn);
    if (i >= 0) this.connections.splice(i, 1);
    try { conn.transport.close(code, reason); } catch { /* already gone */ }
    this.host.onDisconnect(conn);
  }

  /** Drop connections that stopped talking. */
  reapTimeouts(): void {
    for (let i = this.connections.length - 1; i >= 0; i--) {
      const c = this.connections[i];
      if (!c.transport.isOpen) { this.detach(c, 1006, 'transport closed'); continue; }
      if (this.clock() - c.lastRecvMs > CLIENT_TIMEOUT_MS) this.detach(c, 1001, 'timeout');
    }
  }

  /* -------------------------------------------------------------- *
   * Receive
   * -------------------------------------------------------------- */

  receive(conn: Connection, data: ArrayBuffer | Uint8Array): void {
    if (conn.closed) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length === 0) return;
    const now = this.clock();
    conn.stats.bytesReceived += bytes.length;
    conn.stats.messagesIn++;
    conn.lastRecvMs = now;

    // Flood control.
    if (now - conn.msgWindowStartMs >= 1000) {
      conn.msgWindowStartMs = now;
      conn.msgWindowCount = 0;
    }
    if (++conn.msgWindowCount > MAX_MESSAGES_PER_SECOND) {
      conn.stats.violations++;
      if (conn.msgWindowCount > MAX_MESSAGES_PER_SECOND * 3) {
        this.detach(conn, 1008, 'message flood');
      }
      return;
    }

    const id = readMessageId(bytes);
    try {
      switch (id) {
        case C2S.HELLO: this.onHello(conn, bytes); break;
        case C2S.INPUT: this.onInput(conn, bytes); break;
        case C2S.BLOCK_EDIT: this.onBlockEdit(conn, bytes); break;
        case C2S.CHAT: this.onChat(conn, bytes); break;
        case C2S.RESPAWN: this.onRespawn(conn); break;
        case C2S.PING: this.onPing(conn, bytes); break;
        case C2S.APPEARANCE: this.onAppearance(conn, bytes); break;
        case C2S_MODE.SELECT: this.onModeSelect(conn, bytes); break;
        case C2S_MODE.ACTION: this.onModeAction(conn, bytes); break;
        default:
          conn.stats.violations++;
          break;
      }
    } catch {
      // A malformed packet is a protocol violation, not a crash.
      conn.stats.violations++;
      if (conn.stats.violations > 24) this.detach(conn, 1002, 'protocol error');
    }
  }

  private onHello(conn: Connection, bytes: Uint8Array): void {
    if (conn.ready) { conn.stats.violations++; return; }
    decodeHello(this.reader.reset(bytes), this.hello);
    if (this.hello.protocolVersion !== PROTOCOL_VERSION) {
      this.detach(conn, 1002, 'protocol version mismatch');
      return;
    }
    conn.name = sanitiseName(this.hello.name);
    conn.skin = this.hello.skin & 0xff;
    conn.avatar = this.hello.avatar >>> 0;
    conn.caps = this.hello.caps;
    conn.helloRecvMs = this.clock();
    conn.clientSimMs = 0;
    conn.lagFloorMs = Number.POSITIVE_INFINITY;

    const playerId = this.host.onHello(conn, conn.name, conn.skin, conn.caps);
    if (playerId === 0) {
      this.detach(conn, 1013, 'server full');
      return;
    }
    conn.playerId = playerId;
    conn.player = this.sim.getPlayer(playerId) ?? null;
    // `NetHost.onHello` predates the avatar and does not need to know about it:
    // the body is already built by the time it returns, so the appearance is
    // stamped on here rather than widening an interface four rooms implement.
    if (conn.player !== null) conn.player.avatar = conn.avatar;
    conn.ready = true;
    conn.loadingIn = true;

    // Fewer chunks for a phone: it has less to render and less to download.
    const w = this.shared;
    encodeWelcome(
      w, playerId, this.host.seed, 1000 / TICK_MS,
      (conn.caps & CAP_LOW_SPEC) !== 0 ? 5 : 6,
      CHUNK_SIZE, CHUNK_HEIGHT, MAX_PLAYERS, this.host.gameMode,
      this.nowMs >>> 0, WORLD_CHUNK_COUNT,
    );
    conn.send(w.copy());
  }

  private onInput(conn: Connection, bytes: Uint8Array): void {
    if (!conn.ready || !conn.player) return;
    const c = decodeInput(this.reader.reset(bytes), this.input);

    // Replays and reorders are dropped: the sequence must move forward.
    if (c.seq <= conn.lastAcceptedSeq) {
      conn.stats.droppedInputs++;
      return;
    }
    conn.lastAcceptedSeq = c.seq;

    const dt = clamp(Math.round(c.dtMs), MIN_INPUT_DT_MS, MAX_INPUT_DT_MS);
    if (c.dtMs > MAX_INPUT_DT_MS) conn.stats.violations++;

    // Clamp the move vector to the unit disc: no diagonal speed bonus, no
    // "moveZ = 12" nonsense.
    let mx = c.moveX;
    let mz = c.moveZ;
    const ml = Math.sqrt(mx * mx + mz * mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    conn.clientSimMs += dt;
    this.estimateLatency(conn);

    conn.pushInput(c.seq, dt, c.yaw, c.pitch, c.buttons, mx, mz, c.slot & 0x0f);
  }

  /**
   * One-way delay estimate without a protocol field for it.
   *
   * The client starts sending input as soon as WELCOME lands, so the very first
   * command arrives about one round trip after HELLO was received. Every later
   * command should arrive at `helloRecv + sum(dt)` if the network were
   * instantaneous and drift free; the running minimum of the shortfall is
   * therefore the round trip, and it can only be beaten by a genuinely faster
   * packet. A slow upward creep keeps clock drift from pinning it forever.
   */
  private estimateLatency(conn: Connection): void {
    const sample = this.clock() - (conn.helloRecvMs + conn.clientSimMs);
    if (sample < conn.lagFloorMs) conn.lagFloorMs = sample;
    else conn.lagFloorMs += 0.0012 * TICK_MS;
    const rtt = clamp(conn.lagFloorMs, 0, 400);
    // Smooth so one lucky packet does not collapse the rewind window.
    conn.rttMs = conn.rttMs * 0.9 + rtt * 0.1;
    if (conn.player) conn.player.rttMs = conn.rttMs;
  }

  private onBlockEdit(conn: Connection, bytes: Uint8Array): void {
    if (!conn.ready || !conn.player) return;
    const e = decodeBlockEdit(this.reader.reset(bytes), this.edit);
    const result = this.sim.requestEdit(conn.player, e.action, e.x, e.y, e.z, e.blockId, e.seq);
    if (result !== EditResult.OK && result !== EditResult.NO_CHANGE) {
      conn.stats.rejectedEdits++;
      if (result === EditResult.OUT_OF_REACH || result === EditResult.OUT_OF_WORLD) conn.stats.violations++;
      // Tell the client the truth about that voxel so its prediction snaps back.
      const w = this.shared;
      conn.deltas.reset();
      conn.deltas.ackEditSeq = conn.player.lastEditSeq;
      conn.deltas.push(e.x, e.y, e.z, this.world.getBlock(e.x, e.y, e.z));
      encodeBlockDeltas(w, conn.deltas);
      conn.send(w.copy());
    }
  }

  private onChat(conn: Connection, bytes: Uint8Array): void {
    if (!conn.ready) return;
    const text = decodeChatC2S(this.reader.reset(bytes)).slice(0, MAX_CHAT_LENGTH).trim();
    if (text.length === 0) return;
    this.host.onChat(conn, text);
  }

  private onRespawn(conn: Connection): void {
    if (!conn.ready) return;
    this.host.onRespawnRequest(conn);
  }

  /**
   * A live outfit change. There is nothing to validate — the bits are opaque
   * here and the client clamps every index against its own roster before it
   * indexes anything — so this is a store, and the ordinary delta encoder
   * notices the changed field and ships it to everyone else on the next
   * snapshot. Rate limiting rides on the existing per-connection violation
   * budget via the message-rate cap; a client spamming it only spends its own
   * bandwidth, because an unchanged value produces no delta bit.
   */
  private onAppearance(conn: Connection, bytes: Uint8Array): void {
    if (!conn.ready) return;
    decodeAppearance(this.reader.reset(bytes), this.appearance);
    conn.skin = this.appearance.skin & 0xff;
    conn.avatar = this.appearance.avatar >>> 0;
    const p = conn.player;
    if (p === null) return;
    p.skin = conn.skin;
    p.avatar = conn.avatar;
  }

  private onPing(conn: Connection, bytes: Uint8Array): void {
    const clientTime = decodePing(this.reader.reset(bytes));
    const w = this.shared;
    encodePong(w, clientTime, this.nowMs >>> 0, this.sim.tick);
    conn.send(w.copy());
    conn.lastPongMs = this.clock();
  }

  /* -------------------------------------------------------------- *
   * Mode sidecar
   *
   * The base protocol does not know what a mode is; it only knows these three
   * ids belong to somebody else. Decode, hand to the host, and treat a host
   * that does not implement the hook as "this room has no modes" rather than
   * as a protocol violation — that is what keeps every existing test green.
   * -------------------------------------------------------------- */

  private onModeSelect(conn: Connection, bytes: Uint8Array): void {
    if (!conn.ready) { conn.stats.violations++; return; }
    decodeModeSelect(this.reader.reset(bytes), this.modeSelectMsg);
    this.host.onModeSelect?.(conn, this.modeSelectMsg);
  }

  private onModeAction(conn: Connection, bytes: Uint8Array): void {
    if (!conn.ready) { conn.stats.violations++; return; }
    decodeModeAction(this.reader.reset(bytes), this.modeActionMsg);
    this.host.onModeAction?.(conn, this.modeActionMsg);
  }

  sendModeState(conn: Connection, state: ModeStateBuffer): void {
    if (!conn.ready) return;
    encodeModeState(this.shared, state);
    conn.send(this.shared.copy());
  }

  sendModeContext(conn: Connection, context: ModeContextMessage): void {
    if (!conn.ready) return;
    encodeModeContext(this.shared, context);
    conn.send(this.shared.copy());
  }

  broadcastModeContext(context: ModeContextMessage): void {
    encodeModeContext(this.shared, context);
    const packet = this.shared.copy();
    for (let i = 0; i < this.connections.length; i++) {
      const c = this.connections[i];
      if (c.ready) c.send(packet);
    }
  }

  sendModeEvent(conn: Connection, event: ModeEventMessage): void {
    if (!conn.ready) return;
    encodeModeEvent(this.shared, event);
    conn.send(this.shared.copy());
  }

  broadcastModeEvent(event: ModeEventMessage): void {
    encodeModeEvent(this.shared, event);
    const packet = this.shared.copy();
    for (let i = 0; i < this.connections.length; i++) {
      const c = this.connections[i];
      if (c.ready) c.send(packet);
    }
  }

  /* -------------------------------------------------------------- *
   * Tick: drain input into the simulation
   * -------------------------------------------------------------- */

  /**
   * Spend each client's time budget on its queued commands. This is the
   * speed-hack gate: a client may only ever buy `INPUT_TIME_SCALE` times real
   * time, whatever it claims in `dtMs` and however many packets it sends.
   */
  consumeInputs(tickMs: number): void {
    for (let i = 0; i < this.connections.length; i++) {
      const conn = this.connections[i];
      const p = conn.player;
      if (!conn.ready || !p || !p.active) continue;

      conn.timeBankMs = Math.min(INPUT_BANK_MAX_MS, conn.timeBankMs + tickMs * INPUT_TIME_SCALE);

      // Jitter buffer: hold a couple of commands back so a late packet does not
      // starve the tick, but never let the backlog grow into banked time.
      let guard = INPUT_QUEUE_CAPACITY;
      while (conn.qCount > 0 && guard-- > 0) {
        const h = conn.qHead;
        const dt = conn.qDt[h];
        if (dt > conn.timeBankMs) break;

        conn.timeBankMs -= dt;
        this.input.seq = conn.qSeq[h];
        this.input.dtMs = dt;
        this.input.yaw = conn.qYaw[h];
        this.input.pitch = conn.qPitch[h];
        this.input.buttons = conn.qButtons[h];
        this.input.moveX = conn.qMoveX[h];
        this.input.moveZ = conn.qMoveZ[h];
        this.input.slot = conn.qSlot[h];
        conn.qHead = (h + 1) % INPUT_QUEUE_CAPACITY;
        conn.qCount--;
        conn.stats.appliedInputs++;
        this.sim.applyInput(p, this.input, dt);
      }

      // Anything still queued beyond a comfortable jitter window is a client
      // running fast. Drop it rather than let it accumulate into a burst.
      const keep = INPUT_QUEUE_TARGET * 4;
      while (conn.qCount > keep) {
        conn.qHead = (conn.qHead + 1) % INPUT_QUEUE_CAPACITY;
        conn.qCount--;
        conn.stats.droppedInputs++;
      }
    }
  }

  /* -------------------------------------------------------------- *
   * Tick: send
   * -------------------------------------------------------------- */

  /** Ship everything produced by this tick. Call after the simulation stepped. */
  flush(): void {
    this.sendEvents();
    this.invalidateEditedChunks();
    this.sendBlockDeltas();
    this.deflateBudget = CHUNK_DEFLATES_PER_TICK;
    for (let i = 0; i < this.connections.length; i++) {
      const conn = this.connections[i];
      if (!conn.ready) continue;
      this.streamChunks(conn);
      this.sendSnapshot(conn);
    }
  }

  /**
   * Drop the cached packet for any chunk this tick's edits touched, so a joiner
   * arriving after a firefight is never handed pre-demolition terrain. Runs off
   * the same journal `sendBlockDeltas` reads, before the room clears it.
   */
  private invalidateEditedChunks(): void {
    const j = this.world.journal;
    if (j.count === 0) return;
    for (let i = 0; i < j.count; i++) {
      const slot = chunkSlot(j.x[i] >> 5, j.z[i] >> 5);
      if (slot >= 0 && slot < CHUNK_SLOTS) this.chunkZCache[slot] = null;
    }
  }

  private sendEvents(): void {
    const sim = this.sim;
    const w = this.shared;

    for (let i = 0; i < sim.damageCount; i++) {
      const e = sim.damageEvents[i];
      for (let c = 0; c < this.connections.length; c++) {
        const conn = this.connections[c];
        if (!conn.ready) continue;
        const isVictim = conn.playerId === e.victimId;
        const isAttacker = conn.playerId === e.attackerId;
        if (!isVictim && !isAttacker) continue;
        encodeDamage(
          w, e.attackerId, e.victimId, e.amount, e.weaponId,
          e.flags | (isVictim ? DMG_YOU_ARE_VICTIM : 0),
          e.dirX, e.dirY, e.dirZ, e.healthAfter, e.armorAfter,
        );
        conn.send(w.copy());
      }
    }

    for (let i = 0; i < sim.killCount; i++) {
      const e = sim.killEvents[i];
      encodeKill(w, e.killerId, e.victimId, e.weaponId, e.flags, e.killerStreak);
      const packet = w.copy();
      for (let c = 0; c < this.connections.length; c++) {
        const conn = this.connections[c];
        if (conn.ready) conn.send(packet);
      }
    }
  }

  /**
   * Broadcast the tick's voxel changes. A client that has not received the
   * chunk yet is skipped — it will get the change baked into the chunk itself.
   */
  private sendBlockDeltas(): void {
    const j = this.world.journal;
    if (j.count === 0) return;
    const w = this.shared;

    for (let c = 0; c < this.connections.length; c++) {
      const conn = this.connections[c];
      if (!conn.ready) continue;
      const ack = conn.player ? conn.player.lastEditSeq : 0;
      let i = 0;
      while (i < j.count) {
        conn.deltas.reset();
        conn.deltas.ackEditSeq = ack;
        while (i < j.count && conn.deltas.count < conn.deltas.capacity) {
          const cx = j.x[i] >> 5;
          const cz = j.z[i] >> 5;
          const slot = chunkSlot(cx, cz);
          if (slot >= 0 && slot < CHUNK_SLOTS && conn.chunkSent[slot] === 1) {
            conn.deltas.push(j.x[i], j.y[i], j.z[i], j.id[i]);
          }
          i++;
        }
        if (conn.deltas.count === 0) continue;
        encodeBlockDeltas(w, conn.deltas);
        conn.send(w.copy());
      }
    }
  }

  /** Send the nearest chunks the client does not have, inside the byte budget. */
  private streamChunks(conn: Connection): void {
    const p = conn.player;
    if (!p) return;
    if (conn.transport.bufferedAmount > SOCKET_BACKLOG_LIMIT) return;

    let budget = conn.loadingIn ? CHUNK_BURST_BYTES : CHUNK_STEADY_BYTES;
    const w = conn.writer;
    const px = p.pos[0];
    const pz = p.pos[2];

    while (budget > 0) {
      let bestSlot = -1;
      let bestDist = Infinity;
      let bestCX = 0;
      let bestCZ = 0;
      for (let cz = WORLD_MIN_CHUNK; cz <= -WORLD_MIN_CHUNK; cz++) {
        for (let cx = WORLD_MIN_CHUNK; cx <= -WORLD_MIN_CHUNK; cx++) {
          const slot = chunkSlot(cx, cz);
          if (conn.chunkSent[slot] === 1) continue;
          const d = ServerWorld.chunkDistance(cx, cz, px, pz);
          if (d < bestDist) { bestDist = d; bestSlot = slot; bestCX = cx; bestCZ = cz; }
        }
      }
      if (bestSlot < 0) {
        conn.loadingIn = false;
        return;
      }

      let packet = this.compressedChunk(bestSlot, bestCX, bestCZ, conn);
      if (packet === null) {
        // Uncompressed path: unchanged since the beginning. This is what the
        // browser's local-server Worker and any pre-v3 client get.
        const voxels = this.world.ensureChunk(bestCX, bestCZ);
        encodeChunk(w, bestCX, bestCZ, voxels);
        packet = w.copy();
      } else if (packet.length === 0) {
        // The deflate budget for this tick is spent and this chunk is cold.
        // Stop here; the next tick picks the same chunk up.
        return;
      }
      conn.send(packet);
      conn.chunkSent[bestSlot] = 1;
      conn.chunksAcked++;
      conn.stats.chunksSent++;
      budget -= packet.length;

      // The spawn neighbourhood is what "interactive" means; once it is out the
      // rest can trickle at the steady rate.
      if (conn.loadingIn && conn.chunksAcked >= 25) conn.loadingIn = false;
    }
  }

  /**
   * The cached `S2C.CHUNK_Z` packet for one chunk.
   *
   * Returns `null` when this connection or this process has no compressed path
   * (caller falls back to `S2C.CHUNK`), and a zero-length view when the chunk
   * is cold and this tick's deflate budget is already spent.
   *
   * Cache hits are the common case by a wide margin: the deflate is per chunk
   * per room, so joiner #2 onwards costs a `send` and nothing else.
   */
  private compressedChunk(
    slot: number, cx: number, cz: number, conn: Connection,
  ): Uint8Array | null {
    const deflate = chunkCompressor;
    if (deflate === null || (conn.caps & CAP_INFLATE) === 0) return null;

    const cached = this.chunkZCache[slot];
    // A chunk already judged incompressible goes down the raw path for free.
    if (cached === EMPTY_PACKET) return null;
    if (cached !== null) return cached;
    if (this.deflateBudget <= 0) return EMPTY_PACKET;

    const voxels = this.world.ensureChunk(cx, cz);
    const scratch = rleScratchFor(voxels.length);
    const rleLen = rleEncodeInto(voxels, scratch, 0);
    const z = deflate(scratch.subarray(0, rleLen));
    // A compressor that gave up, or one that made the chunk bigger, is not
    // worth a second message type. Fall back and never ask again this tick.
    if (z === null || z.length + CHUNK_Z_HEADER_BYTES >= rleLen + CHUNK_HEADER_BYTES) {
      this.deflateBudget--;
      // Remember the verdict. Without this every joiner re-deflates a chunk
      // that has already proved it will not shrink.
      this.chunkZCache[slot] = EMPTY_PACKET;
      return null;
    }
    this.deflateBudget--;
    const packet = encodeChunkZ(conn.writer, cx, cz, rleLen, z).copy();
    this.chunkZCache[slot] = packet;
    return packet;
  }

  /** Assemble and send one delta snapshot for a connection. */
  private sendSnapshot(conn: Connection): void {
    const sim = this.sim;
    const s = conn.scratch;
    const base = conn.baseline;
    s.reset();
    s.tick = sim.tick;
    s.ackInputSeq = conn.player ? conn.player.lastInputSeq : 0;
    s.ackEditSeq = conn.player ? conn.player.lastEditSeq : 0;
    s.localId = conn.playerId;

    const full = conn.baselineTick === 0
      || conn.lastRosterVersion !== sim.rosterVersion
      || this.nowMs - conn.lastFullMs >= FULL_SNAPSHOT_INTERVAL_MS;
    conn.lastRosterVersion = sim.rosterVersion;
    // Note: `full` also re-sends every name, which is how a late joiner learns
    // who is in the match without a separate roster message.
    s.baselineTick = full ? 0 : conn.baselineTick;
    s.flags = (full ? SNAP_FULL : 0) | (this.host.matchOver ? SNAP_MATCH_OVER : 0);
    if (full) conn.lastFullMs = this.nowMs;

    /* --- players --- */
    const live = sim.players;
    const liveCount = Math.min(live.length, s.maxPlayers);
    for (let i = 0; i < liveCount; i++) {
      const p = live[i];
      const slot = s.addPlayer(p.id);
      if (slot < 0) break;
      s.playerX[slot] = p.pos[0];
      s.playerY[slot] = p.pos[1];
      s.playerZ[slot] = p.pos[2];
      s.playerVX[slot] = p.vel[0];
      s.playerVY[slot] = p.vel[1];
      s.playerVZ[slot] = p.vel[2];
      s.playerYaw[slot] = p.yaw;
      s.playerPitch[slot] = p.pitch;
      s.playerHealth[slot] = clamp(Math.round(p.health), 0, 255);
      s.playerArmor[slot] = clamp(Math.round(p.armor), 0, 255);
      s.playerWeapon[slot] = p.weapon;
      s.playerState[slot] = p.stateBits();
      s.playerMag[slot] = p.mag[p.weapon];
      s.playerReserve[slot] = p.reserveFor(p.weapon);
      s.playerKills[slot] = Math.min(65535, p.kills);
      s.playerDeaths[slot] = Math.min(65535, p.deaths);
      s.playerTeam[slot] = p.team;
      s.playerSkin[slot] = p.skin;
      s.playerAvatar[slot] = p.avatar;
      s.playerName[slot] = p.name;

      const isLocal = p.id === conn.playerId;
      const bi = full ? -1 : base.indexOfPlayer(p.id);
      let mask: number;
      if (bi < 0) {
        mask = PF_SPAWN | PF_ALL;
      } else {
        mask = playerDeltaMask(base, bi, s, slot);
      }
      if (!isLocal) {
        mask &= ~PF_AMMO;
      } else {
        mask |= PF_LOCAL;
        // PF_ALL deliberately omits PF_AMMO (it is a local-only field), and the
        // baseline records the values whether or not they were transmitted — so
        // without this the very first record would bake mag/reserve into the
        // baseline unsent and `playerDeltaMask` would never flag them again.
        // The client then shows 0 / 0 until the first shot changes them.
        if (full || bi < 0) mask |= PF_AMMO;
      }
      s.playerMask[slot] = mask;
    }

    // Players present in the baseline but gone now.
    if (!full) {
      for (let bi = 0; bi < base.playerCount; bi++) {
        const id = base.playerId[bi];
        if (sim.getPlayer(id)) continue;
        const slot = s.addPlayer(id);
        if (slot < 0) break;
        s.playerMask[slot] = PF_REMOVED;
      }
    }

    /* --- entities ---
     *
     * Delta-encoded against `conn.entBase*`. An entity whose quantised state is
     * identical to what this connection was last sent is OMITTED ENTIRELY: it
     * costs zero bytes, not the 23 a full record costs. ~33 stationary pickups
     * used to be retransmitted in full 20x/s for the whole match.
     *
     * TRANSPORT ASSUMPTION — READ THIS BEFORE ADDING A TRANSPORT.
     * `knownEntity` and `entBase*` advance at SEND time, never on an ack, so
     * "the last thing we sent" is taken to be "the baseline the client holds".
     * On `ws` and on the local-server Worker's MessagePort that is exactly
     * true: both are reliable and ordered, a sent snapshot arrives once and in
     * order, and this costs nothing.
     *
     * It is NOT true on a lossy transport, and this tree has one: the peer-host
     * WebRTC path (client/src/net/webrtc.ts) deliberately carries snapshots on
     * an unreliable, unordered data channel. A dropped datagram there leaves
     * the client decoding against a baseline it never received — for entities
     * that means a stale record (or, if the lost snapshot held the EF_REMOVED,
     * a ghost) that no later snapshot repairs, because we will never re-send a
     * field we believe the client already has.
     *
     * That transport pays for it one layer down and the repair is now
     * LOAD-BEARING, not a nicety: every unreliable datagram carries a sequence
     * number, the receiver notices a gap, the guest asks for a resync on the
     * reliable channel, and `peerHost` answers by setting `conn.baselineTick
     * = 0` — which lands on the `full` test above and re-describes every
     * entity. Before entities were delta-coded a lost EF_REMOVED healed itself
     * on the next tick, because the client pruned anything the server stopped
     * mentioning; it does not any more (see the SNAP_FULL prune in
     * client/src/net/client.ts).
     *
     * So: any new transport that can drop or reorder must either provide the
     * same gap-detect-and-resync, or the honest fix — the client echoes the
     * tick it applied, the server keeps a ring of per-tick baselines, and
     * `entBase*` only ever advances to an ACKNOWLEDGED tick. Widening
     * FULL_SNAPSHOT_INTERVAL_MS is not a fix; it only bounds the damage.
     */
    for (let e = 0; e < MAX_ENTITIES; e++) {
      if (sim.entActive[e] !== 1) continue;

      const isPickup = sim.entType[e] >= EntityType.PICKUP_HEALTH;
      const qx = quantizePos(sim.entX[e]);
      const qy = quantizePos(sim.entY[e]);
      const qz = quantizePos(sim.entZ[e]);
      const qvx = quantizeVel(sim.entVX[e]);
      const qvy = quantizeVel(sim.entVY[e]);
      const qvz = quantizeVel(sim.entVZ[e]);
      // A pickup's yaw is server-side decoration: `Simulation.stepPickups`
      // spins it every single tick, and nothing on the client ever reads it —
      // pickups are drawn spinning off the renderer's own clock, and every
      // consumer of `RemoteEntityView.yaw` filters to monsters first. Sending
      // it would turn each pickup into a 6-byte delta 20x/s and give back most
      // of what this whole block saves. Pin the baseline at 0 so the compare
      // below can never resurrect it.
      const qyaw = isPickup ? 0 : quantizeAngle(sim.entYaw[e]);
      const health = Math.max(0, Math.min(65535, sim.entHealth[e]));
      const state = sim.entState[e];

      // A full snapshot carries no baseline, so every entity must be complete.
      const known = !full
        && conn.knownEntity[e] === 1
        && conn.knownEntityGen[e] === sim.entGen[e];

      let mask: number;
      if (!known) {
        // Self-describing: type and variant ride along so the client can key
        // the record by id without inheriting a recycled slot's identity.
        mask = EF_SPAWN | EF_ALL;
        if (isPickup) mask &= ~EF_YAW;
      } else {
        mask = 0;
        if (qx !== conn.entBaseQX[e] || qy !== conn.entBaseQY[e] || qz !== conn.entBaseQZ[e]) mask |= EF_POS;
        if (qyaw !== conn.entBaseQYaw[e]) mask |= EF_YAW;
        if (health !== conn.entBaseHealth[e]) mask |= EF_HEALTH;
        if (state !== conn.entBaseState[e]) mask |= EF_STATE;
        if (qvx !== conn.entBaseQVX[e] || qvy !== conn.entBaseQVY[e] || qvz !== conn.entBaseQVZ[e]) mask |= EF_VEL;
        // Nothing the wire can express has changed. Say nothing at all.
        if (mask === 0) continue;
      }

      const slot = s.addEntity(sim.entId[e]);
      // Scratch is full. Leave the baseline alone: this entity is simply not in
      // this snapshot, and the next one will still see it as changed.
      if (slot < 0) break;
      s.entityType[slot] = sim.entType[e];
      s.entityVariant[slot] = sim.entVariant[e];
      s.entityX[slot] = sim.entX[e];
      s.entityY[slot] = sim.entY[e];
      s.entityZ[slot] = sim.entZ[e];
      s.entityVX[slot] = sim.entVX[e];
      s.entityVY[slot] = sim.entVY[e];
      s.entityVZ[slot] = sim.entVZ[e];
      s.entityYaw[slot] = sim.entYaw[e];
      s.entityHealth[slot] = health;
      s.entityState[slot] = state;
      s.entityMask[slot] = mask;

      conn.knownEntity[e] = 1;
      conn.knownEntityGen[e] = sim.entGen[e];
      conn.entBaseQX[e] = qx;
      conn.entBaseQY[e] = qy;
      conn.entBaseQZ[e] = qz;
      conn.entBaseQVX[e] = qvx;
      conn.entBaseQVY[e] = qvy;
      conn.entBaseQVZ[e] = qvz;
      conn.entBaseQYaw[e] = qyaw;
      conn.entBaseHealth[e] = health;
      conn.entBaseState[e] = state;
    }
    for (let i = 0; i < sim.removedEntityCount; i++) {
      const slot = s.addEntity(sim.removedEntityId[i]);
      if (slot < 0) break;
      s.entityMask[slot] = EF_REMOVED;
      s.entityReason[slot] = sim.removedEntityReason[i];
    }

    /* --- projectiles --- */
    for (let r = 0; r < MAX_PROJECTILES; r++) {
      if (sim.projActive[r] !== 1) continue;
      const slot = s.addProjectile(sim.projId[r]);
      if (slot < 0) break;
      s.projWeapon[slot] = sim.projWeapon[r];
      s.projOwner[slot] = sim.projOwner[r];
      s.projX[slot] = sim.projX[r];
      s.projY[slot] = sim.projY[r];
      s.projZ[slot] = sim.projZ[r];
      s.projVX[slot] = sim.projVX[r];
      s.projVY[slot] = sim.projVY[r];
      s.projVZ[slot] = sim.projVZ[r];
      s.projMask[slot] = RF_SPAWN | RF_ALL;
      conn.knownProj[r] = 1;
      conn.knownProjGen[r] = sim.projGen[r];
    }
    for (let i = 0; i < sim.removedProjCount; i++) {
      const slot = s.addProjectile(sim.removedProjId[i]);
      if (slot < 0) break;
      s.projMask[slot] = RF_REMOVED;
      s.projReason[slot] = sim.removedProjReason[i];
    }

    const w = conn.writer;
    encodeSnapshot(w, s);
    conn.send(w.copy());
    conn.stats.snapshotsSent++;

    /* --- roll the baseline forward (live players only) --- */
    base.reset();
    for (let i = 0; i < s.playerCount; i++) {
      if ((s.playerMask[i] & PF_REMOVED) !== 0) continue;
      const bslot = base.addPlayer(s.playerId[i]);
      if (bslot < 0) break;
      copyPlayerRecord(s, i, base, bslot);
    }
    conn.baselineTick = s.tick;

    // Entities and projectiles the sim dropped are unknown again.
    for (let i = 0; i < MAX_ENTITIES; i++) if (sim.entActive[i] === 0) conn.knownEntity[i] = 0;
    for (let i = 0; i < MAX_PROJECTILES; i++) if (sim.projActive[i] === 0) conn.knownProj[i] = 0;
  }

  /* -------------------------------------------------------------- *
   * Outbound helpers used by the room
   * -------------------------------------------------------------- */

  broadcastChat(senderId: number, channel: number, text: string): void {
    const w = this.shared;
    encodeChatS2C(w, senderId, channel, text);
    const packet = w.copy();
    for (let i = 0; i < this.connections.length; i++) {
      const c = this.connections[i];
      if (c.ready) c.send(packet);
    }
  }

  sendChatTo(conn: Connection, senderId: number, channel: number, text: string): void {
    const w = this.shared;
    encodeChatS2C(w, senderId, channel, text);
    conn.send(w.copy());
  }

  /** Force every client to re-download the world (round restart). */
  resetWorldStreams(): void {
    // Every caller has just regenerated or repainted the world, so every
    // cached compressed chunk now describes terrain that no longer exists.
    this.chunkZCache.fill(null);
    for (let i = 0; i < this.connections.length; i++) {
      const c = this.connections[i];
      c.chunkSent.fill(0);
      c.chunksAcked = 0;
      c.loadingIn = true;
      c.baselineTick = 0;
      c.lastFullMs = -1e9;
      c.lastRosterVersion = -1;
      c.baseline.reset();
      c.knownEntity.fill(0);
      c.knownProj.fill(0);
    }
  }

  connectionFor(playerId: number): Connection | undefined {
    for (let i = 0; i < this.connections.length; i++) {
      if (this.connections[i].playerId === playerId) return this.connections[i];
    }
    return undefined;
  }

  /** For the local worker server: how far behind is this client on chunks? */
  static chunkProgress(conn: Connection): number {
    return conn.chunksAcked / WORLD_CHUNK_COUNT;
  }
}

/** Strip control characters, collapse whitespace, cap the length. */
export function sanitiseName(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length && out.length < MAX_NAME_LENGTH; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) continue;
    out += raw[i];
  }
  out = out.trim();
  return out.length === 0 ? 'Marine' : out;
}

/** Chat text hygiene. Length is already capped by the wire format. */
export function sanitiseChat(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length && out.length < MAX_CHAT_LENGTH; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) continue;
    out += raw[i];
  }
  return out.trim();
}
