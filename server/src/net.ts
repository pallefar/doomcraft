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
  EF_REMOVED,
  EF_SPAWN,
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
  clamp,
  copyPlayerRecord,
  createBlockEditCommand,
  createHelloMessage,
  createInputCommand,
  decodeBlockEdit,
  decodeChatC2S,
  decodeHello,
  decodeInput,
  decodePing,
  encodeBlockDeltas,
  encodeChatS2C,
  encodeChunk,
  encodeDamage,
  encodeKill,
  encodePong,
  encodeSnapshot,
  encodeWelcome,
  playerDeltaMask,
  readMessageId,
} from '@doomcraft/shared';
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

const CHUNK_SLOTS = WORLD_CHUNK_COUNT;

function chunkSlot(cx: number, cz: number): number {
  return (cx - WORLD_MIN_CHUNK) + (cz - WORLD_MIN_CHUNK) * WORLD_CHUNKS_PER_AXIS;
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
  private readonly input = createInputCommand();
  private readonly edit = createBlockEditCommand();
  private readonly reader = new PacketReader();
  private readonly shared = new PacketWriter(16384);

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

  private onPing(conn: Connection, bytes: Uint8Array): void {
    const clientTime = decodePing(this.reader.reset(bytes));
    const w = this.shared;
    encodePong(w, clientTime, this.nowMs >>> 0, this.sim.tick);
    conn.send(w.copy());
    conn.lastPongMs = this.clock();
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
    this.sendBlockDeltas();
    for (let i = 0; i < this.connections.length; i++) {
      const conn = this.connections[i];
      if (!conn.ready) continue;
      this.streamChunks(conn);
      this.sendSnapshot(conn);
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

      const voxels = this.world.ensureChunk(bestCX, bestCZ);
      encodeChunk(w, bestCX, bestCZ, voxels);
      conn.send(w.copy());
      conn.chunkSent[bestSlot] = 1;
      conn.chunksAcked++;
      conn.stats.chunksSent++;
      budget -= w.offset;

      // The spawn neighbourhood is what "interactive" means; once it is out the
      // rest can trickle at the steady rate.
      if (conn.loadingIn && conn.chunksAcked >= 25) conn.loadingIn = false;
    }
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

    /* --- entities --- */
    for (let e = 0; e < MAX_ENTITIES; e++) {
      if (sim.entActive[e] !== 1) continue;
      const slot = s.addEntity(sim.entId[e]);
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
      s.entityHealth[slot] = Math.max(0, Math.min(65535, sim.entHealth[e]));
      s.entityState[slot] = sim.entState[e];
      // Always self-describing: type and variant ride along so a client can key
      // records by id without ever inheriting a recycled slot's identity.
      s.entityMask[slot] = EF_SPAWN | EF_ALL;
      conn.knownEntity[e] = 1;
      conn.knownEntityGen[e] = sim.entGen[e];
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
