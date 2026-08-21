#!/usr/bin/env node
/**
 * DOOMCRAFT — load harness.
 *
 * Measures the real per-player and per-room cost of the shipped server, so a
 * cost model can be built on numbers instead of guesses.
 *
 * NOTHING HERE IS A MOCK. The host role imports the real `Room`, `NetHub`,
 * `Simulation` and `ServerWorld` and the real `ws` WebSocketServer, wired
 * exactly the way `server/src/index.ts` wires them (same `noServer` upgrade,
 * same `WsTransport`, same `perMessageDeflate: false`, same maxPayload). The
 * client role speaks the real binary protocol from `shared/src/protocol.ts` —
 * real HELLO, real 60 Hz INPUT, real PING, real BLOCK_EDIT — and decodes the
 * real delta snapshots with the real decoder.
 *
 * Two deliberate differences from `server/src/index.ts`, both because that file
 * cannot express the thing being measured:
 *
 *   1. It constructs exactly ONE Room per process. To measure rooms/core the
 *      host role constructs N. Everything inside a Room is untouched.
 *   2. It drives that Room from its own `setInterval`. With N rooms the host
 *      uses ONE 5 ms scheduler that calls `room.advance(now)` on every room —
 *      which is what a multi-room process must do anyway, and it keeps N timer
 *      objects out of the measurement.
 *
 * Usage
 *   npx tsx tools/loadtest.mjs bandwidth  [--players N] [--mode M] [--seconds S]
 *   npx tsx tools/loadtest.mjs rooms      [--ramp 1,4,16,...] [--bots B]
 *   npx tsx tools/loadtest.mjs memory     [--ramp 1,4,16,...] [--bots B]
 *   npx tsx tools/loadtest.mjs breakpoint [--step 32] [--bots 12]
 *   npx tsx tools/loadtest.mjs builder    [--players N] [--eps E]
 *   npx tsx tools/loadtest.mjs cdn
 *   npx tsx tools/loadtest.mjs --role host --port P --rooms R   (internal)
 *
 * Flags common to the driver scenarios:
 *   --mode deathmatch|horde|sandbox   room game mode           (default deathmatch)
 *   --bots N                          bot bodies per room      (default 0)
 *   --max-players N                   per-room cap override    (default 32 = MAX_PLAYERS)
 *   --seconds N                       steady-state sample window
 *   --json                            emit the raw result object as JSON too
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import {
  GameMode,
  WS_PATH,
  MAX_PLAYERS,
  TICK_MS,
  INPUT_SEND_MS,
  HEARTBEAT_MS,
  BTN_FIRE, BTN_JUMP, BTN_SPRINT,
  PS_DEAD,
  S2C,
  PacketWriter,
  PacketReader,
  SnapshotBuffer,
  MAX_ENTITIES,
  MAX_PROJECTILES,
  BlockAction,
  encodeHello,
  encodeInput,
  encodePing,
  encodeRespawn,
  encodeBlockEdit,
  decodeWelcome,
  decodeSnapshot,
  createWelcomeMessage,
  PF_POS,
  PF_STATE,
  CHUNK_VOLUME,
  WORLD_CHUNK_COUNT,
  WORLD_MIN_CHUNK,
  WORLD_CHUNKS_PER_AXIS,
  rleDecode,
} from '@doomcraft/shared';
import { Room } from '../server/src/room.js';
import * as NetMod from '../server/src/net.js';
import { deflateRawSync } from 'node:zlib';

/* ---- bw-verify additions -------------------------------------------------
 * A copy of loadtest.mjs with the minimum needed to measure the compressed
 * join path honestly:
 *   - the host registers the SAME compressor server/src/index.ts registers
 *     (deflateRawSync level 6) when the tree has setChunkCompressor;
 *   - the synthetic client advertises CAP_INFLATE (bit 4) and really inflates
 *     + rleDecodes every S2C.CHUNK_Z, so it holds the same voxels a browser
 *     would;
 *   - both roles hash the world so a decode error cannot pass as a saving.
 * `--no-inflate` makes the client behave exactly like the old one.
 * ------------------------------------------------------------------------ */
const CAP_INFLATE_BIT = 1 << 4;
import { inflateRawSync } from 'node:zlib';
function zlibInflateRaw(z, outLen) {
  const out = inflateRawSync(Buffer.from(z));
  if (out.length !== outLen) throw new Error(`inflate short ${out.length}/${outLen}`);
  return out;
}
const S2C_CHUNK_Z = 9;
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function chunkSlotOf(cx, cz) {
  return (cx - WORLD_MIN_CHUNK) + (cz - WORLD_MIN_CHUNK) * WORLD_CHUNKS_PER_AXIS;
}


const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/* ------------------------------------------------------------------------ *
 * Arg parsing
 * ------------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const num = (v, d) => (v === undefined ? d : Number(v));

function parseMode(v) {
  switch (String(v ?? 'deathmatch').toLowerCase()) {
    case 'horde': return GameMode.HORDE;
    case 'sandbox': case 'builder': return GameMode.SANDBOX;
    default: return GameMode.DEATHMATCH;
  }
}
const MODE_NAME = ['deathmatch', 'horde', 'sandbox'];

/* ------------------------------------------------------------------------ *
 * Statistics helpers
 * ------------------------------------------------------------------------ */

/** Fixed-width histogram; 0.02 ms buckets to 60 ms, then an overflow bin. */
class Hist {
  constructor(width = 0.02, bins = 3000) {
    this.width = width;
    this.bins = new Float64Array(bins + 1);
    this.n = 0; this.sum = 0; this.max = 0;
  }
  add(v) {
    this.n++; this.sum += v;
    if (v > this.max) this.max = v;
    let i = Math.floor(v / this.width);
    if (i < 0) i = 0;
    if (i >= this.bins.length) i = this.bins.length - 1;
    this.bins[i]++;
  }
  pct(p) {
    if (this.n === 0) return 0;
    const target = this.n * p;
    let seen = 0;
    for (let i = 0; i < this.bins.length; i++) {
      seen += this.bins[i];
      if (seen >= target) return (i + 0.5) * this.width;
    }
    return this.max;
  }
  get mean() { return this.n === 0 ? 0 : this.sum / this.n; }
  snapshot() {
    return {
      n: this.n, meanMs: this.mean, maxMs: this.max,
      p50: this.pct(0.5), p95: this.pct(0.95), p99: this.pct(0.99), p999: this.pct(0.999),
    };
  }
  reset() { this.bins.fill(0); this.n = 0; this.sum = 0; this.max = 0; }
}

function pctOf(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}
function summarise(values) {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    mean: s.length ? sum / s.length : 0,
    p50: pctOf(s, 0.5), p95: pctOf(s, 0.95), p99: pctOf(s, 0.99),
    min: s[0] ?? 0, max: s[s.length - 1] ?? 0,
  };
}

/**
 * WebSocket frame overhead for a binary payload, RFC 6455.
 * Server->client frames are unmasked; client->server frames carry a 4-byte mask.
 */
function wsOverhead(payloadLen, masked) {
  const ext = payloadLen < 126 ? 0 : payloadLen < 65536 ? 2 : 8;
  return 2 + ext + (masked ? 4 : 0);
}

/* ------------------------------------------------------------------------ *
 * HOST ROLE — N real Rooms behind one real ws server
 * ------------------------------------------------------------------------ */

class WsTransport {
  constructor(socket) { this.socket = socket; }
  get isOpen() { return this.socket.readyState === 1; }
  get bufferedAmount() { return this.socket.bufferedAmount; }
  send(data) {
    if (this.socket.readyState !== 1) return;
    this.socket.send(data, { binary: true });
  }
  close(code = 1000, reason = '') {
    try { this.socket.close(code, reason); } catch { /* already closing */ }
  }
}

async function runHost() {
  // EXACTLY what server/src/index.ts does. Absent on the pre-fix tree.
  if (typeof NetMod.setChunkCompressor === 'function' && args['no-compress'] === undefined) {
    NetMod.setChunkCompressor((src) => {
      try { return deflateRawSync(src, { level: 6 }); } catch { return null; }
    });
  }
  const port = num(args.port, 0);
  const roomCount = num(args.rooms, 1);
  const mode = parseMode(args.mode);
  const bots = num(args.bots, 0);
  const maxPlayers = num(args['max-players'], MAX_PLAYERS);
  const seed = num(args.seed, 12345);
  const enemies = num(args.enemies, -1);

  const rooms = [];
  const stepHist = new Hist();
  /*
   * Tick INTERVAL, per room. `ticks.deficit` is too forgiving to answer "is the
   * tick stable": Room.advance can catch up 8 ticks in one wake, so a room can
   * be 300 ms late and still show zero lost ticks. What a 20 Hz shooter
   * actually feels is the gap between one tick of ITS OWN room and the next,
   * so that gap is what is histogrammed here. 50 ms is perfect.
   */
  const intervalHist = new Hist(1, 600);
  const lastStepNs = [];
  let buildMs = 0;

  function instrument(r, idx) {
    const orig = r.step.bind(r);
    lastStepNs[idx] = 0n;
    r.step = () => {
      const t = process.hrtime.bigint();
      if (lastStepNs[idx] !== 0n) intervalHist.add(Number(t - lastStepNs[idx]) / 1e6);
      lastStepNs[idx] = t;
      orig();
      stepHist.add(Number(process.hrtime.bigint() - t) / 1e6);
    };
  }

  for (let i = 0; i < roomCount; i++) {
    const t0 = process.hrtime.bigint();
    const r = new Room({
      seed: (seed + i) >>> 0,
      mode,
      botFill: bots,
      enemies,
      store: null,          // the shipped server passes a JsonFileStore; profile
                            // writes are measured separately in `builder`.
      eagerWorld: true,     // what a real server does at boot
      name: `lt-${i}`,
      clock: () => Date.now(),
    });
    // `readonly maxPlayers` is compile-time only; Room clamps the ctor option to
    // MAX_PLAYERS (32). Overriding here is the ONLY way to measure a 50-player
    // room, and it is honest: every downstream consumer (net.attach, snapshot
    // buffer sizing, roster) reads this property.
    if (maxPlayers !== MAX_PLAYERS) r.maxPlayers = maxPlayers;
    buildMs += Number(process.hrtime.bigint() - t0) / 1e6;

    // Instrument the real tick. `private step()` is a plain runtime method;
    // shadowing it on the instance times exactly one 20 Hz tick of one room.
    instrument(r, i);
    rooms.push(r);
  }

  /* --- one scheduler for every room ------------------------------------- */
  /*
   * Phase-stagger. Every Room owns a 50 ms accumulator; left alone they all
   * empty on the same 5 ms wake and the process does 100 % of its tick work in
   * 10 % of the time. That bunching, not CPU exhaustion, is what a naive
   * multi-room scheduler hits first, so it is spread here on purpose and the
   * unstaggered behaviour is available with `--stagger 0` for comparison.
   */
  const stagger = String(args.stagger ?? '1') !== '0';
  if (stagger) {
    const now0 = Date.now();
    for (let i = 0; i < rooms.length; i++) {
      rooms[i].lastAdvanceMs = now0;
      rooms[i].accumulatorMs = (i * TICK_MS) / Math.max(1, rooms.length) % TICK_MS;
    }
  }
  let ticksRun = 0;
  let batchHist = new Hist(0.05, 4000);
  const loop = setInterval(() => {
    const now = Date.now();
    const t = process.hrtime.bigint();
    for (let i = 0; i < rooms.length; i++) ticksRun += rooms[i].advance(now);
    batchHist.add(Number(process.hrtime.bigint() - t) / 1e6);
  }, Math.max(5, Math.floor(TICK_MS / 2)));

  /* --- stats window ------------------------------------------------------ */
  let winStartMs = Date.now();
  let winCpu = process.cpuUsage();
  let winTicks = 0;

  function statsBody() {
    const nowMs = Date.now();
    const wallMs = nowMs - winStartMs;
    const cpu = process.cpuUsage(winCpu);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const expected = Math.floor(wallMs / TICK_MS) * rooms.length;
    const actual = ticksRun - winTicks;
    let conns = 0;
    let humans = 0;
    let bodies = 0;
    for (const r of rooms) {
      conns += r.net.connections.length;
      humans += r.humanCount;
      bodies += r.sim.players.length;
    }
    const mem = process.memoryUsage();
    return {
      rooms: rooms.length,
      roomBuildMsTotal: buildMs,
      wallMs, cpuMs,
      cores: wallMs > 0 ? cpuMs / wallMs : 0,
      ticks: { expected, actual, deficit: expected - actual,
               deficitPct: expected > 0 ? (expected - actual) / expected : 0 },
      step: stepHist.snapshot(),
      interval: intervalHist.snapshot(),
      batch: batchHist.snapshot(),
      conns, humans, bodies,
      rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal,
      external: mem.external, arrayBuffers: mem.arrayBuffers,
    };
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/_stats') {
      const body = JSON.stringify(statsBody());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (url.pathname === '/_reset') {
      stepHist.reset(); batchHist.reset(); intervalHist.reset();
      winStartMs = Date.now(); winCpu = process.cpuUsage(); winTicks = ticksRun;
      res.writeHead(204); res.end();
      return;
    }
    if (url.pathname === '/_worldhash') {
      const room = rooms[Number(url.searchParams.get('room') ?? '0')];
      const w = room.world;
      const out = new Array(WORLD_CHUNK_COUNT).fill(0);
      for (let cz = WORLD_MIN_CHUNK; cz < WORLD_MIN_CHUNK + WORLD_CHUNKS_PER_AXIS; cz++) {
        for (let cx = WORLD_MIN_CHUNK; cx < WORLD_MIN_CHUNK + WORLD_CHUNKS_PER_AXIS; cx++) {
          out[chunkSlotOf(cx, cz)] = fnv1a(w.ensureChunk(cx, cz));
        }
      }
      const body = JSON.stringify({ hashes: out });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (url.pathname === '/_gc') {
      if (typeof global.gc === 'function') { global.gc(); global.gc(); }
      const mem = process.memoryUsage();
      const body = JSON.stringify({ gc: typeof global.gc === 'function', ...mem });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (url.pathname === '/_addrooms') {
      const n = Number(url.searchParams.get('n') ?? '0');
      for (let i = 0; i < n; i++) {
        const idx = rooms.length;
        const r = new Room({
          seed: (seed + idx) >>> 0, mode, botFill: bots, enemies, store: null,
          eagerWorld: true, name: `lt-${idx}`, clock: () => Date.now(),
        });
        if (maxPlayers !== MAX_PLAYERS) r.maxPlayers = maxPlayers;
        instrument(r, idx);
        rooms.push(r);
      }
      if (stagger) {
        const now0 = Date.now();
        for (let i = 0; i < rooms.length; i++) {
          rooms[i].lastAdvanceMs = now0;
          rooms[i].accumulatorMs = (i * TICK_MS) / Math.max(1, rooms.length) % TICK_MS;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rooms: rooms.length }));
      return;
    }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== WS_PATH) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const roomIdx = Number(url.searchParams.get('room') ?? '0') % rooms.length;
    const room = rooms[roomIdx];
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = room.join(new WsTransport(ws));
      const device = url.searchParams.get('device') ?? '';
      if (device) conn.deviceId = device;
      ws.on('message', (data) => {
        if (Array.isArray(data)) room.receive(conn, Buffer.concat(data));
        else if (data instanceof ArrayBuffer) room.receive(conn, new Uint8Array(data));
        else room.receive(conn, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
      ws.on('close', () => { room.leave(conn); });
      ws.on('error', () => { room.leave(conn); });
    });
  });

  await new Promise((done) => httpServer.listen(port, '127.0.0.1', done));
  const actualPort = httpServer.address().port;
  process.stdout.write(`##HOST_READY##${JSON.stringify({ port: actualPort, rooms: rooms.length, buildMs })}\n`);

  process.on('SIGTERM', () => { clearInterval(loop); process.exit(0); });
  process.on('SIGINT', () => { clearInterval(loop); process.exit(0); });
}

/* ------------------------------------------------------------------------ *
 * DRIVER — spawn a host, drive synthetic clients
 * ------------------------------------------------------------------------ */

function spawnHost(opts) {
  return new Promise((done, fail) => {
    const argv = [
      '--expose-gc',
      '--import', 'tsx',
      join(HERE, 'bw-verify.mjs'),
      '--role', 'host',
      '--port', '0',
      '--rooms', String(opts.rooms ?? 1),
      '--mode', opts.mode ?? 'deathmatch',
      '--bots', String(opts.bots ?? 0),
      '--max-players', String(opts.maxPlayers ?? MAX_PLAYERS),
      '--seed', String(opts.seed ?? 12345),
      '--stagger', String(opts.stagger ?? '1'),
      '--enemies', String(opts.enemies ?? -1),
    ];
    const child = spawn(process.execPath, argv, {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('##HOST_READY##');
      if (i < 0) return;
      const nl = buf.indexOf('\n', i);
      if (nl < 0) return;
      const info = JSON.parse(buf.slice(i + '##HOST_READY##'.length, nl));
      child.stdout.off('data', onData);
      child.stdout.resume();
      done({ child, ...info });
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => fail(new Error(`host exited early with ${code}`)));
    setTimeout(() => fail(new Error('host did not become ready in 400 s')), 400_000).unref?.();
  });
}

async function hostGet(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (res.status === 204) return null;
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ *
 * Synthetic client — the real protocol, a plausible player
 * ------------------------------------------------------------------------ */

class SyntheticClient {
  constructor(index, port, roomIdx, opts = {}) {
    this.index = index;
    this.roomIdx = roomIdx;
    this.url = `ws://127.0.0.1:${port}${WS_PATH}?room=${roomIdx}&device=lt-${String(index).padStart(6, '0')}-aaaaaaaaaaaaaaaa`;
    this.writer = new PacketWriter(2048);
    this.reader = new PacketReader();
    this.snap = new SnapshotBuffer(opts.maxPlayers ?? MAX_PLAYERS, MAX_ENTITIES, MAX_PROJECTILES);
    this.welcome = createWelcomeMessage();

    this.playerId = 0;
    this.spawned = false;
    this.dead = false;
    this.pos = [0, 40, 0];
    this.chunksIn = 0;
    this.chunkBytes = 0;
    this.chunkWireBytes = 0;
    this.chunkZIn = 0;
    this.chunkPlainIn = 0;
    this.wantInflate = opts.wantInflate !== false;
    this.chunkHashes = new Int32Array(WORLD_CHUNK_COUNT).fill(-1);
    this.decodeErrors = 0;
    this.chunkDone = false;
    this.chunkDoneMs = 0;

    // Byte ledgers. `*Wire` adds the RFC 6455 frame header.
    this.down = 0; this.downWire = 0; this.downMsgs = 0;
    this.up = 0; this.upWire = 0; this.upMsgs = 0;
    this.byKind = new Map();

    // Sampling window
    this.win = null;

    // Behaviour state
    this.seq = 0;
    this.editSeq = 0;
    this.yaw = Math.random() * Math.PI * 2;
    this.pitch = 0;
    this.turn = 0;
    this.moveX = 0; this.moveZ = 1;
    this.buttons = 0;
    this.accMs = 0;
    this.pingMs = 0;
    this.decideMs = 0;
    this.fireMs = 0;
    this.firing = false;
    this.jumpMs = 0;
    this.editAccMs = 0;
    this.editsPerSec = opts.editsPerSec ?? 0;
    this.editsSent = 0;
    this.editsAcked = 0;
    this.blockDeltasIn = 0;
    this.rng = mulberry32(0x9e3779b9 ^ (index * 2654435761));
  }

  connect() {
    return new Promise((done, fail) => {
      const ws = new WebSocket(this.url, { perMessageDeflate: false });
      ws.binaryType = 'nodebuffer';
      this.ws = ws;
      ws.on('open', () => {
        const caps = this.wantInflate ? CAP_INFLATE_BIT : 0;
        this.rawSend(encodeHello(this.writer, `lt${this.index}`, this.index & 0xff, caps, 0).copy());
        done();
      });
      ws.on('message', (data) => this.onMessage(data));
      ws.on('error', (e) => fail(e));
      ws.on('close', () => { this.closed = true; });
    });
  }

  rawSend(bytes) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.up += bytes.length;
    this.upWire += bytes.length + wsOverhead(bytes.length, true);
    this.upMsgs++;
    if (this.win) { this.win.up += bytes.length; this.win.upWire += bytes.length + wsOverhead(bytes.length, true); this.win.upMsgs++; }
    this.ws.send(bytes, { binary: true });
  }

  onMessage(data) {
    const len = data.length;
    const wire = len + wsOverhead(len, false);
    this.down += len; this.downWire += wire; this.downMsgs++;
    const id = data[0];
    const k = this.byKind.get(id) ?? { bytes: 0, msgs: 0 };
    k.bytes += len; k.msgs++;
    this.byKind.set(id, k);
    if (this.win) {
      this.win.down += len; this.win.downWire += wire; this.win.downMsgs++;
      const wk = this.win.byKind.get(id) ?? { bytes: 0, msgs: 0 };
      wk.bytes += len; wk.msgs++;
      this.win.byKind.set(id, wk);
    }

    const r = this.reader.reset(data);
    switch (id) {
      case S2C.WELCOME: {
        decodeWelcome(r, this.welcome);
        this.playerId = this.welcome.playerId;
        this.expectChunks = this.welcome.chunkCount;
        break;
      }
      case S2C.CHUNK: {
        this.chunksIn++;
        this.chunkPlainIn++;
        this.chunkBytes += len;
        this.chunkWireBytes += wire;
        // Decode it the way the client does, so plain and compressed paths are
        // hashed identically and a wrong chunk cannot pass either way.
        try {
          r.u8();
          const cx = r.i16(); const cz = r.i16();
          const rleLen = r.u32();
          const vox = new Uint8Array(CHUNK_VOLUME);
          rleDecode(r.bytes, r.offset, rleLen, vox);
          const slot = chunkSlotOf(cx, cz);
          if (slot >= 0 && slot < WORLD_CHUNK_COUNT) this.chunkHashes[slot] = fnv1a(vox) | 0;
        } catch { this.decodeErrors++; }
        if (!this.chunkDone && this.expectChunks && this.chunksIn >= this.expectChunks) {
          this.chunkDone = true;
          this.chunkDoneMs = Date.now();
        }
        break;
      }
      case S2C_CHUNK_Z: {
        this.chunksIn++;
        this.chunkZIn++;
        this.chunkBytes += len;
        this.chunkWireBytes += wire;
        try {
          r.u8();
          const cx = r.i16(); const cz = r.i16();
          const rleLen = r.u32();
          const zLen = r.u32();
          const z = r.bytes.subarray(r.offset, r.offset + zLen);
          const rle = zlibInflateRaw(z, rleLen);
          const vox = new Uint8Array(CHUNK_VOLUME);
          rleDecode(rle, 0, rleLen, vox);
          const slot = chunkSlotOf(cx, cz);
          if (slot >= 0 && slot < WORLD_CHUNK_COUNT) this.chunkHashes[slot] = fnv1a(vox) | 0;
        } catch { this.decodeErrors++; }
        if (!this.chunkDone && this.expectChunks && this.chunksIn >= this.expectChunks) {
          this.chunkDone = true;
          this.chunkDoneMs = Date.now();
        }
        break;
      }
      case S2C.SNAPSHOT: {
        const s = decodeSnapshot(r, this.snap);
        if (this.win) {
          this.win.snaps++;
          this.win.snapBytes += len;
          this.win.recPlayers += s.playerCount;
          this.win.recEntities += s.entityCount;
          this.win.recProjectiles += s.projectileCount;
          if (s.baselineTick === 0) { this.win.fullSnaps++; this.win.fullSnapBytes += len; }
        }
        for (let i = 0; i < s.playerCount; i++) {
          if (s.playerId[i] !== this.playerId) continue;
          const m = s.playerMask[i];
          if (m & PF_POS) { this.pos[0] = s.playerX[i]; this.pos[1] = s.playerY[i]; this.pos[2] = s.playerZ[i]; }
          if (m & PF_STATE) this.dead = (s.playerState[i] & PS_DEAD) !== 0;
          this.spawned = true;
        }
        break;
      }
      case S2C.BLOCK_DELTA: this.blockDeltasIn++; break;
      default: break;
    }
  }

  /** One driver frame. `dtMs` is real elapsed time. */
  update(dtMs) {
    if (!this.ws || this.ws.readyState !== 1 || this.playerId === 0) return;

    this.decideMs += dtMs;
    if (this.decideMs > 600 + this.rng() * 900) {
      this.decideMs = 0;
      this.turn = (this.rng() - 0.5) * 3.2;          // rad/s of mouse look
      this.moveZ = this.rng() < 0.82 ? 1 : (this.rng() < 0.5 ? -1 : 0);
      this.moveX = this.rng() < 0.45 ? (this.rng() < 0.5 ? -1 : 1) : 0;
    }
    this.fireMs += dtMs;
    if (!this.firing && this.fireMs > 1200 + this.rng() * 1600) { this.firing = true; this.fireMs = 0; }
    else if (this.firing && this.fireMs > 300 + this.rng() * 500) { this.firing = false; this.fireMs = 0; }
    this.jumpMs += dtMs;
    const jump = this.jumpMs > 3500;
    if (jump) this.jumpMs = 0;

    this.yaw += this.turn * (dtMs / 1000);
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + (this.rng() - 0.5) * 0.06));
    this.buttons = (this.firing ? BTN_FIRE : 0) | (jump ? BTN_JUMP : 0) | BTN_SPRINT;

    // 60 Hz input, exactly as client/src/net/client.ts does it.
    this.accMs += dtMs;
    let steps = 0;
    while (this.accMs >= INPUT_SEND_MS && steps < 8) {
      let stepMs = Math.round(INPUT_SEND_MS);
      if (stepMs > this.accMs) stepMs = Math.floor(this.accMs);
      if (stepMs < 1) stepMs = 1;
      this.accMs -= stepMs;
      this.seq++;
      encodeInput(this.writer, this.seq, stepMs, this.yaw, this.pitch, this.buttons, this.moveX, this.moveZ, 0);
      this.rawSend(this.writer.copy());
      steps++;
    }
    if (steps === 8) this.accMs = 0;

    this.pingMs += dtMs;
    if (this.pingMs >= HEARTBEAT_MS) {
      this.pingMs = 0;
      this.rawSend(encodePing(this.writer, Date.now() >>> 0).copy());
    }

    if (this.dead) this.rawSend(encodeRespawn(this.writer).copy());

    if (this.editsPerSec > 0 && this.spawned && !this.dead) {
      this.editAccMs += dtMs;
      const period = 1000 / this.editsPerSec;
      while (this.editAccMs >= period) {
        this.editAccMs -= period;
        // A cell about 2 m in front at foot height: inside REACH_PLACE (6 m),
        // never inside the player's own body. Alternate place / break so every
        // edit is a real change the server must journal and broadcast.
        const bx = Math.round(this.pos[0] + Math.cos(this.yaw) * 2);
        const bz = Math.round(this.pos[2] + Math.sin(this.yaw) * 2);
        const by = Math.max(1, Math.min(62, Math.round(this.pos[1])));
        const place = (this.editsSent & 1) === 0;
        this.editSeq++;
        encodeBlockEdit(
          this.writer, this.editSeq,
          place ? BlockAction.PLACE : BlockAction.BREAK,
          bx, by, bz, place ? 3 : 0,
        );
        this.rawSend(this.writer.copy());
        this.editsSent++;
      }
    }
  }

  openWindow() {
    this.win = {
      down: 0, downWire: 0, downMsgs: 0, up: 0, upWire: 0, upMsgs: 0, byKind: new Map(),
      snaps: 0, snapBytes: 0, fullSnaps: 0, fullSnapBytes: 0,
      recPlayers: 0, recEntities: 0, recProjectiles: 0,
      t0: Date.now(),
    };
  }
  closeWindow() {
    const w = this.win; this.win = null;
    if (!w) return null;
    w.ms = Date.now() - w.t0;
    return w;
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drive every client from one loop for `ms`, or until `until()` goes true. */
async function driveClients(clients, ms, onTick, until) {
  const t0 = Date.now();
  let last = t0;
  return new Promise((done) => {
    const h = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      for (const c of clients) c.update(dt);
      onTick?.(now - t0);
      if (now - t0 >= ms || (until !== undefined && until())) { clearInterval(h); done(); }
    }, 8);
  });
}

/* ------------------------------------------------------------------------ *
 * Scenario: bandwidth
 * ------------------------------------------------------------------------ */

async function scenarioBandwidth() {
  const players = num(args.players, 25);
  const modeName = String(args.mode ?? 'deathmatch');
  const seconds = num(args.seconds, 30);
  const bots = num(args.bots, 0);
  const maxPlayers = num(args['max-players'], Math.max(MAX_PLAYERS, players));

  const host = await spawnHost({ rooms: 1, mode: modeName, bots, maxPlayers, enemies: num(args.enemies, -1) });
  const clients = [];
  try {
    for (let i = 0; i < players; i++) {
      const c = new SyntheticClient(i, host.port, 0, { maxPlayers, wantInflate: args['no-inflate'] === undefined });
      await c.connect();
      clients.push(c);
      await sleep(25);   // arrivals, not a thundering herd
    }

    // --- join phase: drive until every client has the whole world -----------
    const joinT0 = Date.now();
    await driveClients(clients, 120_000, () => {}, () => clients.every((c) => c.chunkDone));
    const joinMs = Date.now() - joinT0;
    const allDone = clients.every((c) => c.chunkDone);
    // Settle: the join burst must be out of the socket before steady state.
    await driveClients(clients, 4000, () => {});

    const worldHash = await hostGet(host.port, '/_worldhash');
    let mismatches = 0, missing = 0, decodeErrors = 0;
    for (const c of clients) {
      decodeErrors += c.decodeErrors;
      for (let i = 0; i < WORLD_CHUNK_COUNT; i++) {
        if (c.chunkHashes[i] === -1) { missing++; continue; }
        if ((c.chunkHashes[i] >>> 0) !== (worldHash.hashes[i] >>> 0)) mismatches++;
      }
    }

    const joinLedger = clients.map((c) => ({
      chunks: c.chunksIn, chunkBytes: c.chunkBytes, chunkWireBytes: c.chunkWireBytes,
      chunkZ: c.chunkZIn, chunkPlain: c.chunkPlainIn,
      totalDown: c.down, totalDownWire: c.downWire,
      totalUp: c.up, totalUpWire: c.upWire,
    }));

    // --- steady state -------------------------------------------------------
    await hostGet(host.port, '/_reset');
    for (const c of clients) c.openWindow();
    const perSecondDown = [];
    const perSecondUp = [];
    let lastSampleMs = 0;
    let lastDown = clients.map((c) => c.downWire);
    let lastUp = clients.map((c) => c.upWire);
    await driveClients(clients, seconds * 1000, (elapsed) => {
      if (elapsed - lastSampleMs < 1000) return;
      lastSampleMs = elapsed;
      clients.forEach((c, i) => {
        perSecondDown.push(c.downWire - lastDown[i]);
        perSecondUp.push(c.upWire - lastUp[i]);
        lastDown[i] = c.downWire;
        lastUp[i] = c.upWire;
      });
    });
    const wins = clients.map((c) => c.closeWindow());
    const stats = await hostGet(host.port, '/_stats');

    const secs = wins[0].ms / 1000;
    const downApp = wins.map((w) => w.down / (w.ms / 1000));
    const downWire = wins.map((w) => w.downWire / (w.ms / 1000));
    const upApp = wins.map((w) => w.up / (w.ms / 1000));
    const upWire = wins.map((w) => w.upWire / (w.ms / 1000));

    const kinds = new Map();
    for (const w of wins) {
      for (const [id, v] of w.byKind) {
        const k = kinds.get(id) ?? { bytes: 0, msgs: 0 };
        k.bytes += v.bytes; k.msgs += v.msgs;
        kinds.set(id, k);
      }
    }

    const result = {
      scenario: 'bandwidth',
      mode: modeName, players, bots, maxPlayers,
      chunksExpected: clients[0].expectChunks,
      joinCompleteForAll: allDone,
      joinMs,
      join: {
        chunksMean: summarise(joinLedger.map((j) => j.chunks)).mean,
        chunkBytesMean: summarise(joinLedger.map((j) => j.chunkBytes)).mean,
        chunkWireBytesMean: summarise(joinLedger.map((j) => j.chunkWireBytes)).mean,
        chunkZMean: summarise(joinLedger.map((j) => j.chunkZ)).mean,
        chunkPlainMean: summarise(joinLedger.map((j) => j.chunkPlain)).mean,
        totalDownWireMean: summarise(joinLedger.map((j) => j.totalDownWire)).mean,
        chunkBytes: summarise(joinLedger.map((j) => j.chunkBytes)),
      },
      worldCheck: { chunksPerClient: WORLD_CHUNK_COUNT, clients: clients.length, mismatches, missing, decodeErrors },
      steady: {
        seconds: secs,
        downAppBps: summarise(downApp),
        downWireBps: summarise(downWire),
        upAppBps: summarise(upApp),
        upWireBps: summarise(upWire),
        perSecondDownWire: summarise(perSecondDown),
        perSecondUpWire: summarise(perSecondUp),
        byKind: [...kinds].map(([id, v]) => ({
          id, name: S2C[id] ?? String(id),
          bytesPerPlayerPerSec: v.bytes / players / secs,
          msgsPerPlayerPerSec: v.msgs / players / secs,
        })).sort((a, b) => b.bytesPerPlayerPerSec - a.bytesPerPlayerPerSec),
        editsSent: clients.reduce((a, c) => a + c.editsSent, 0),
        snapshot: (() => {
          const snaps = wins.reduce((a, w) => a + w.snaps, 0);
          const full = wins.reduce((a, w) => a + w.fullSnaps, 0);
          return {
            perSec: snaps / players / secs,
            meanBytes: snaps ? wins.reduce((a, w) => a + w.snapBytes, 0) / snaps : 0,
            fullPerSec: full / players / secs,
            fullMeanBytes: full ? wins.reduce((a, w) => a + w.fullSnapBytes, 0) / full : 0,
            deltaMeanBytes: (snaps - full)
              ? (wins.reduce((a, w) => a + w.snapBytes - w.fullSnapBytes, 0)) / (snaps - full) : 0,
            recPlayersPerSnap: snaps ? wins.reduce((a, w) => a + w.recPlayers, 0) / snaps : 0,
            recEntitiesPerSnap: snaps ? wins.reduce((a, w) => a + w.recEntities, 0) / snaps : 0,
            recProjectilesPerSnap: snaps ? wins.reduce((a, w) => a + w.recProjectiles, 0) / snaps : 0,
          };
        })(),
      },
      host: stats,
    };
    printBandwidth(result);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    for (const c of clients) c.close();
    await sleep(200);
    host.child.kill('SIGKILL');
  }
}

function fmtB(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n.toFixed(0)} B`;
}

function printBandwidth(r) {
  const s = r.steady;
  console.log(`\n=== BANDWIDTH  mode=${r.mode}  players=${r.players}  bots=${r.bots} ===`);
  console.log(`join: every client had the whole world after ${(r.joinMs / 1000).toFixed(1)} s`);
  console.log(`join: ${r.join.chunksMean.toFixed(0)}/${r.chunksExpected} chunks, ` +
    `${fmtB(r.join.chunkBytesMean)} of chunk payload per player (all done: ${r.joinCompleteForAll})`);
  console.log(`      chunk bytes p50 ${fmtB(r.join.chunkBytes.p50)}  p95 ${fmtB(r.join.chunkBytes.p95)}`);
  console.log(`      chunk WIRE bytes/player ${fmtB(r.join.chunkWireBytesMean)}   (CHUNK_Z ${r.join.chunkZMean.toFixed(0)}, CHUNK ${r.join.chunkPlainMean.toFixed(0)})`);
  console.log(`      total join downstream wire/player ${fmtB(r.join.totalDownWireMean)}`);
  console.log(`  WORLD CHECK: ${r.worldCheck.clients} clients x ${r.worldCheck.chunksPerClient} chunks -> ` +
    `mismatches ${r.worldCheck.mismatches}, missing ${r.worldCheck.missing}, decodeErrors ${r.worldCheck.decodeErrors}`);
  console.log(`steady (${s.seconds.toFixed(1)} s):`);
  console.log(`  down app   mean ${s.downAppBps.mean.toFixed(0)} B/s   p95 ${s.downAppBps.p95.toFixed(0)} B/s`);
  console.log(`  down wire  mean ${s.downWireBps.mean.toFixed(0)} B/s   p95 ${s.downWireBps.p95.toFixed(0)} B/s`);
  console.log(`  up   app   mean ${s.upAppBps.mean.toFixed(0)} B/s   p95 ${s.upAppBps.p95.toFixed(0)} B/s`);
  console.log(`  up   wire  mean ${s.upWireBps.mean.toFixed(0)} B/s   p95 ${s.upWireBps.p95.toFixed(0)} B/s`);
  console.log(`  per-second samples (wire): down p50 ${s.perSecondDownWire.p50.toFixed(0)} p95 ${s.perSecondDownWire.p95.toFixed(0)} max ${s.perSecondDownWire.max.toFixed(0)}`);
  console.log(`  message mix (down, per player per second):`);
  for (const k of s.byKind) {
    console.log(`    ${String(k.name).padEnd(12)} ${k.bytesPerPlayerPerSec.toFixed(0).padStart(7)} B/s  ${k.msgsPerPlayerPerSec.toFixed(1).padStart(6)} msg/s`);
  }
  const sn = s.snapshot;
  console.log(`  snapshots: ${sn.perSec.toFixed(1)}/s, mean ${sn.meanBytes.toFixed(0)} B ` +
    `(delta ${sn.deltaMeanBytes.toFixed(0)} B, full ${sn.fullMeanBytes.toFixed(0)} B every ${(1 / (sn.fullPerSec || 1)).toFixed(1)} s)`);
  console.log(`  records per snapshot: ${sn.recPlayersPerSnap.toFixed(1)} players, ` +
    `${sn.recEntitiesPerSnap.toFixed(1)} entities, ${sn.recProjectilesPerSnap.toFixed(1)} projectiles`);
  console.log(`  host: ${r.host.cores.toFixed(3)} cores, tick deficit ${(r.host.ticks.deficitPct * 100).toFixed(2)}%, ` +
    `step p50 ${r.host.step.p50.toFixed(2)} ms p95 ${r.host.step.p95.toFixed(2)} ms max ${r.host.step.maxMs.toFixed(2)} ms, ` +
    `tick gap p50 ${r.host.interval.p50.toFixed(1)} p99 ${r.host.interval.p99.toFixed(1)} ms`);
}

/* ------------------------------------------------------------------------ *
 * Scenario: rooms/core  (bots only — pure simulation + snapshot assembly)
 * ------------------------------------------------------------------------ */

async function scenarioRooms() {
  const ramp = String(args.ramp ?? '1,2,4,8,16,32,64,128').split(',').map(Number);
  const bots = num(args.bots, 12);
  const perRoom = num(args['clients-per-room'], 0);
  const modeName = String(args.mode ?? 'deathmatch');
  const seconds = num(args.seconds, 30);
  const warmMs = num(args.warm, 30) * 1000;
  const rows = [];
  console.log(`\n=== ROOMS/CORE  mode=${modeName}  bots/room=${bots}  real clients/room=${perRoom} ===`);
  console.log('rooms  bodies  cores  cores/room  tickDef%  step mean   p95   tickGap p50   p95    p99    max   rss MB');

  // Idle-process baseline: the same host with zero rooms.
  const idleHost = await spawnHost({ rooms: 0, mode: modeName, bots });
  await sleep(2000);
  await hostGet(idleHost.port, '/_reset');
  await sleep(5000);
  const idle = await hostGet(idleHost.port, '/_stats');
  idleHost.child.kill('SIGKILL');
  console.log(`(idle host with 0 rooms: ${idle.cores.toFixed(4)} cores, ${(idle.rss / 1048576).toFixed(0)} MB RSS)`);
  await sleep(300);

  for (const rooms of ramp) {
    const host = await spawnHost({ rooms, mode: modeName, bots, stagger: args.stagger ?? '1' });
    const clients = [];
    let drive = null;
    try {
      if (perRoom > 0) {
        for (let r = 0; r < rooms; r++) {
          for (let i = 0; i < perRoom; i++) {
            const c = new SyntheticClient(r * 1000 + i, host.port, r, {});
            await c.connect();
            clients.push(c);
            // Keep the already-connected ones alive: CLIENT_TIMEOUT_MS is 15 s
            // from the last byte received, and a long connect loop would reap them.
            if (clients.length % 32 === 0) await driveClients(clients, 120, () => {});
          }
        }
        // Let the world stream out before the measurement window opens.
        await driveClients(clients, 240_000, () => {}, () => clients.every((c) => c.chunkDone));
        await driveClients(clients, 3000, () => {});
        drive = driveClients(clients, (seconds + 4) * 1000, () => {});
      } else {
        // Warm up: bots spawn on a timer, and V8 needs thousands of ticks
        // before `step` reaches its steady tier. Short warmups measure the
        // interpreter, not the server.
        await sleep(warmMs);
      }
      await hostGet(host.port, '/_reset');
      for (const c of clients) c.openWindow();
      const dcpu0 = process.cpuUsage();
      const dwall0 = Date.now();
      await sleep(seconds * 1000);
      const dcpu = process.cpuUsage(dcpu0);
      const driverCores = ((dcpu.user + dcpu.system) / 1000) / (Date.now() - dwall0);
      const s = await hostGet(host.port, '/_stats');
      const cw = clients.map((c) => c.closeWindow()).filter(Boolean);
      const cdown = cw.length ? cw.reduce((a, w) => a + w.downWire / (w.ms / 1000), 0) / cw.length : 0;
      const cup = cw.length ? cw.reduce((a, w) => a + w.upWire / (w.ms / 1000), 0) / cw.length : 0;
      const csnaps = cw.length ? cw.reduce((a, w) => a + w.snaps / (w.ms / 1000), 0) / cw.length : 0;
      rows.push({ rooms, clients: clients.length, idleCores: idle.cores, driverCores, cdown, cup, csnaps, ...s });
      console.log(
        `${String(rooms).padStart(5)}  ${String(s.bodies).padStart(6)}  ${s.cores.toFixed(3).padStart(5)}  ` +
        `${((s.cores - idle.cores) / rooms).toFixed(5).padStart(9)}  ` +
        `${(s.ticks.deficitPct * 100).toFixed(2).padStart(7)}  ` +
        `${s.step.meanMs.toFixed(3).padStart(8)} ${s.step.p95.toFixed(3).padStart(6)}  ` +
        `${s.interval.p50.toFixed(1).padStart(10)} ${s.interval.p95.toFixed(1).padStart(6)} ` +
        `${s.interval.p99.toFixed(1).padStart(6)} ${s.interval.maxMs.toFixed(1).padStart(6)}  ${(s.rss / 1048576).toFixed(0).padStart(6)}` +
        (perRoom > 0 ? `  driver ${driverCores.toFixed(2)} cores  client ${cdown.toFixed(0)}/${cup.toFixed(0)} B/s down/up, ${csnaps.toFixed(1)} snap/s` : ''),
      );
      if (drive) await drive;
    } finally {
      for (const c of clients) c.close();
      await sleep(200);
      host.child.kill('SIGKILL');
      await sleep(300);
    }
  }
  if (args.json) console.log(JSON.stringify(rows, null, 2));
  return rows;
}

/* ------------------------------------------------------------------------ *
 * Scenario: memory  (RSS vs rooms, and RSS vs players)
 * ------------------------------------------------------------------------ */

async function scenarioMemory() {
  const modeName = String(args.mode ?? 'deathmatch');
  const rooms = num(args.rooms, 64);
  const stepN = num(args.step, 8);
  const players = num(args.players, 24);

  console.log(`\n=== MEMORY  mode=${modeName} ===`);
  // --- rooms, empty (no bots, no sockets) --------------------------------
  const host = await spawnHost({ rooms: 0, mode: modeName, bots: 0 });
  const roomRows = [];
  try {
    await sleep(500);
    let g = await hostGet(host.port, '/_gc');
    roomRows.push({ rooms: 0, rss: g.rss, heapUsed: g.heapUsed, external: g.external, arrayBuffers: g.arrayBuffers });
    for (let n = stepN; n <= rooms; n += stepN) {
      await hostGet(host.port, `/_addrooms?n=${stepN}`);
      await sleep(600);
      g = await hostGet(host.port, '/_gc');
      roomRows.push({ rooms: n, rss: g.rss, heapUsed: g.heapUsed, external: g.external, arrayBuffers: g.arrayBuffers });
    }
    console.log('rooms   rss MB   heapUsed MB   arrayBuffers MB   marginal MB/room');
    for (let i = 0; i < roomRows.length; i++) {
      const r = roomRows[i];
      const prev = roomRows[i - 1];
      const marg = prev ? (r.rss - prev.rss) / (r.rooms - prev.rooms) / 1048576 : 0;
      console.log(
        `${String(r.rooms).padStart(5)}  ${(r.rss / 1048576).toFixed(1).padStart(7)}  ` +
        `${(r.heapUsed / 1048576).toFixed(1).padStart(11)}  ${(r.arrayBuffers / 1048576).toFixed(1).padStart(15)}  ` +
        `${prev ? marg.toFixed(3).padStart(16) : ''.padStart(16)}`,
      );
    }
    const first = roomRows[0], last = roomRows[roomRows.length - 1];
    const mbPerRoom = (last.rss - first.rss) / last.rooms / 1048576;
    console.log(`  => ${mbPerRoom.toFixed(3)} MB RSS per empty room (${first.rooms}->${last.rooms} rooms)`);
    var roomMB = mbPerRoom;
  } finally {
    host.child.kill('SIGKILL');
    await sleep(300);
  }

  // --- players joining one room ------------------------------------------
  const host2 = await spawnHost({ rooms: 1, mode: modeName, bots: 0, maxPlayers: Math.max(MAX_PLAYERS, players) });
  const clients = [];
  const playerRows = [];
  try {
    await sleep(500);
    let g = await hostGet(host2.port, '/_gc');
    playerRows.push({ players: 0, rss: g.rss, heapUsed: g.heapUsed, arrayBuffers: g.arrayBuffers });
    for (let i = 0; i < players; i++) {
      const c = new SyntheticClient(i, host2.port, 0, { maxPlayers: Math.max(MAX_PLAYERS, players) });
      await c.connect();
      clients.push(c);
      await driveClients(clients, 900, () => {});
      if ((i + 1) % 4 === 0 || i + 1 === players) {
        await driveClients(clients, 2500, () => {});   // let chunk streaming finish
        g = await hostGet(host2.port, '/_gc');
        playerRows.push({ players: i + 1, rss: g.rss, heapUsed: g.heapUsed, arrayBuffers: g.arrayBuffers });
      }
    }
    console.log('\nplayers  rss MB   heapUsed MB   arrayBuffers MB   marginal MB/player');
    for (let i = 0; i < playerRows.length; i++) {
      const r = playerRows[i];
      const prev = playerRows[i - 1];
      const marg = prev ? (r.rss - prev.rss) / (r.players - prev.players) / 1048576 : 0;
      console.log(
        `${String(r.players).padStart(7)}  ${(r.rss / 1048576).toFixed(1).padStart(7)}  ` +
        `${(r.heapUsed / 1048576).toFixed(1).padStart(11)}  ${(r.arrayBuffers / 1048576).toFixed(1).padStart(15)}  ` +
        `${prev ? marg.toFixed(3).padStart(18) : ''.padStart(18)}`,
      );
    }
    const f = playerRows[0], l = playerRows[playerRows.length - 1];
    const mbPerPlayer = (l.rss - f.rss) / l.players / 1048576;
    console.log(`  => ${mbPerPlayer.toFixed(3)} MB RSS per connected player (0->${l.players})`);
    var playerMB = mbPerPlayer;
  } finally {
    for (const c of clients) c.close();
    await sleep(200);
    host2.child.kill('SIGKILL');
  }
  const out = { roomRows, playerRows, mbPerRoom: roomMB, mbPerPlayer: playerMB };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  return out;
}

/* ------------------------------------------------------------------------ *
 * Scenario: breakpoint — add rooms to one process until something gives
 * ------------------------------------------------------------------------ */

async function scenarioBreakpoint() {
  const stepN = num(args.step, 32);
  const bots = num(args.bots, 12);
  const modeName = String(args.mode ?? 'deathmatch');
  const maxRooms = num(args['max-rooms'], 2048);
  const dwell = num(args.dwell, 8);

  console.log(`\n=== BREAKPOINT  mode=${modeName}  bodies/room=${bots}  +${stepN} rooms per stage ===`);
  console.log('rooms   cores  tickDef%  step p95  tickGap p50   p95    p99    max   batch p95   rss MB  heap MB  arrayBuf MB  verdict');
  const host = await spawnHost({ rooms: 0, mode: modeName, bots, stagger: args.stagger ?? '1' });
  const rows = [];
  try {
    for (let rooms = stepN; rooms <= maxRooms; rooms += stepN) {
      await hostGet(host.port, `/_addrooms?n=${stepN}`);
      await sleep(2500 + bots * 60);        // bots spawn on a timer
      await hostGet(host.port, '/_reset');
      await sleep(dwell * 1000);
      const s = await hostGet(host.port, '/_stats');
      // "Stable 20 Hz" means every room's OWN gap between ticks stays near
      // 50 ms. 60 ms at p99 is a fifth of a tick late, which a 20 Hz shooter
      // shows as jitter; that is the failure this ramp is looking for.
      const slipping = s.interval.p99 > 60 || s.ticks.deficitPct > 0.02;
      const verdict = s.interval.p99 > 75 ? 'TICK SLIP' : s.interval.p99 > 60 ? 'jitter' : 'ok';
      rows.push({ rooms, ...s, slipping });
      console.log(
        `${String(rooms).padStart(5)}  ${s.cores.toFixed(3).padStart(5)}  ` +
        `${(s.ticks.deficitPct * 100).toFixed(2).padStart(7)}  ` +
        `${s.step.p95.toFixed(3).padStart(8)}  ` +
        `${s.interval.p50.toFixed(1).padStart(10)} ${s.interval.p95.toFixed(1).padStart(6)} ` +
        `${s.interval.p99.toFixed(1).padStart(6)} ${s.interval.maxMs.toFixed(1).padStart(6)}  ` +
        `${s.batch.p95.toFixed(2).padStart(9)}  ${(s.rss / 1048576).toFixed(0).padStart(6)}  ` +
        `${(s.heapUsed / 1048576).toFixed(0).padStart(7)}  ${(s.arrayBuffers / 1048576).toFixed(0).padStart(11)}  ${verdict}`,
      );
      if (s.interval.p99 > 100) { console.log('  -> stopping: p99 tick gap past 100 ms'); break; }
    }
  } finally {
    host.child.kill('SIGKILL');
  }
  if (args.json) console.log(JSON.stringify(rows, null, 2));
  return rows;
}

/* ------------------------------------------------------------------------ *
 * Scenario: builder — block-edit write rate, wire cost and disk I/O
 * ------------------------------------------------------------------------ */

async function scenarioBuilder() {
  const players = num(args.players, 16);
  const eps = num(args.eps, 3);
  const seconds = num(args.seconds, 30);

  console.log(`\n=== BUILDER  players=${players}  edits/player/s=${eps} ===`);
  const host = await spawnHost({ rooms: 1, mode: 'sandbox', bots: 0, maxPlayers: Math.max(MAX_PLAYERS, players) });
  const clients = [];
  let net;
  try {
    for (let i = 0; i < players; i++) {
      const c = new SyntheticClient(i, host.port, 0, { maxPlayers: Math.max(MAX_PLAYERS, players), editsPerSec: eps });
      await c.connect();
      clients.push(c);
      await sleep(25);
    }
    await driveClients(clients, 30_000, () => {});     // land, settle, finish chunks
    await hostGet(host.port, '/_reset');
    for (const c of clients) c.openWindow();
    const before = clients.map((c) => c.editsSent);
    await driveClients(clients, seconds * 1000, () => {});
    const wins = clients.map((c) => c.closeWindow());
    const s = await hostGet(host.port, '/_stats');
    const editsSent = clients.reduce((a, c, i) => a + (c.editsSent - before[i]), 0);
    const secs = wins[0].ms / 1000;
    const bdBytes = wins.reduce((a, w) => a + (w.byKind.get(S2C.BLOCK_DELTA)?.bytes ?? 0), 0);
    const bdMsgs = wins.reduce((a, w) => a + (w.byKind.get(S2C.BLOCK_DELTA)?.msgs ?? 0), 0);
    net = {
      editsPerSecTotal: editsSent / secs,
      editsPerPlayerPerSec: editsSent / players / secs,
      blockDeltaBytesPerPlayerPerSec: bdBytes / players / secs,
      blockDeltaMsgsPerPlayerPerSec: bdMsgs / players / secs,
      downWirePerPlayerPerSec: wins.reduce((a, w) => a + w.downWire, 0) / players / secs,
      upWirePerPlayerPerSec: wins.reduce((a, w) => a + w.upWire, 0) / players / secs,
      hostCores: s.cores, tickDeficitPct: s.ticks.deficitPct,
      stepP95: s.step.p95,
    };
    console.log(`  accepted edit traffic: ${net.editsPerPlayerPerSec.toFixed(2)} edits/player/s ` +
      `(${net.editsPerSecTotal.toFixed(1)} edits/s in the room)`);
    console.log(`  BLOCK_DELTA downstream: ${net.blockDeltaBytesPerPlayerPerSec.toFixed(0)} B/player/s ` +
      `in ${net.blockDeltaMsgsPerPlayerPerSec.toFixed(1)} msg/s`);
    console.log(`  total down ${net.downWirePerPlayerPerSec.toFixed(0)} B/player/s, up ${net.upWirePerPlayerPerSec.toFixed(0)} B/player/s (wire)`);
    console.log(`  host ${net.hostCores.toFixed(3)} cores, tick deficit ${(net.tickDeficitPct * 100).toFixed(2)} %`);
  } finally {
    for (const c of clients) c.close();
    await sleep(200);
    host.child.kill('SIGKILL');
  }
  return net;
}

/* ------------------------------------------------------------------------ *
 * Scenario: chunks — the join burst, and how much of it is compressible
 * ------------------------------------------------------------------------ */

async function scenarioChunks() {
  const zlib = await import('node:zlib');
  const { ServerWorld } = await import('../server/src/world.js');
  const { encodeChunk, WORLD_MIN_CHUNK } = await import('@doomcraft/shared');

  const w = new ServerWorld(num(args.seed, 12345));
  const t0 = process.hrtime.bigint();
  w.generateAll();
  const genMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const pw = new PacketWriter(1 << 20);
  let raw = 0, gz = 0, br = 0, encNs = 0n, n = 0;
  for (let cz = WORLD_MIN_CHUNK; cz <= -WORLD_MIN_CHUNK; cz++) {
    for (let cx = WORLD_MIN_CHUNK; cx <= -WORLD_MIN_CHUNK; cx++) {
      const vox = w.ensureChunk(cx, cz);
      const t = process.hrtime.bigint();
      encodeChunk(pw, cx, cz, vox);
      encNs += process.hrtime.bigint() - t;
      const bytes = pw.copy();
      raw += bytes.length;
      gz += zlib.gzipSync(bytes, { level: 6 }).length;
      br += zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
      n++;
    }
  }
  console.log(`\n=== CHUNK STREAM  (${n} chunks, the whole world every player is sent) ===`);
  console.log(`  ServerWorld.generateAll(): ${genMs.toFixed(0)} ms, once per room`);
  console.log(`  per player: raw ${(raw / 1048576).toFixed(2)} MB | gzip-6 ${(gz / 1048576).toFixed(2)} MB | brotli-5 ${(br / 1048576).toFixed(2)} MB`);
  console.log(`  mean chunk: ${(raw / n).toFixed(0)} B raw, ${(gz / n).toFixed(0)} B gzip, ${(br / n).toFixed(0)} B brotli`);
  console.log(`  encodeChunk (RLE): ${(Number(encNs) / 1e6 / n).toFixed(2)} ms/chunk => ` +
    `${(Number(encNs) / 1e6).toFixed(0)} ms of CPU per joining player (re-encoded per client, never cached)`);
  console.log(`  the ws server sets perMessageDeflate:false, so the ${(raw / 1048576).toFixed(2)} MB is what crosses the wire today.`);
  return { raw, gz, br, n, genMs };
}

/* ------------------------------------------------------------------------ *
 * Scenario: persist — Builder's real disk cost
 *
 * `server/src/worlds.ts` is a complete, tested persistence layer that
 * `server/src/index.ts` does not mount (grep: nothing outside worlds.ts and its
 * test ever names `worldStore` or `/api/worlds`). So this drives the module
 * directly, with the real node:fs adapter, the real `encodeWorld`, the real
 * autosave debounce.
 * ------------------------------------------------------------------------ */

async function scenarioPersist() {
  const { WorldStore, encodeWorld, AUTOSAVE_MS, AUTOSAVE_MAX_MS } = await import('../server/src/worlds.js');
  const { mkdtempSync, statSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const dir = mkdtempSync(join(tmpdir(), 'dc-worlds-'));
  console.log(`\n=== BUILDER PERSISTENCE  (real worlds.ts, real fs, dir=${dir}) ===`);
  console.log(`autosave debounce ${AUTOSAVE_MS} ms, forced every ${AUTOSAVE_MAX_MS} ms`);

  const sizes = String(args.deltas ?? '1000,10000,100000,500000').split(',').map(Number);
  const rows = [];
  for (const n of sizes) {
    const store = new WorldStore({ dir, autosaveMs: 0, autosaveMaxMs: 0 });
    await store.load();
    const w = store.create({ name: `w${n}`, ownerId: 'owner', seed: 7 });
    // A builder builds structures, not confetti: walk contiguous runs so the
    // varint gap coder sees the locality it was written for.
    let x = -180, y = 30, z = -180;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) {
      w.applyEdit('owner', x, y, z, 3, Date.now());
      x++;
      if (x > 200) { x = -180; z++; if (z > 200) { z = -180; y++; } }
    }
    const editMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const te = process.hrtime.bigint();
    const bytes = encodeWorld(w);
    const encodeMs = Number(process.hrtime.bigint() - te) / 1e6;

    const ts = process.hrtime.bigint();
    const ok = await store.save(w.id);
    const saveMs = Number(process.hrtime.bigint() - ts) / 1e6;
    const onDisk = statSync(`${dir}/${w.id}.dcw`).size;

    rows.push({ deltas: n, fileBytes: onDisk, bytesPerDelta: onDisk / n, editMs, encodeMs, saveMs, ok });
    console.log(
      `${String(n).padStart(7)} deltas -> ${String(onDisk).padStart(9)} B on disk ` +
      `(${(onDisk / n).toFixed(2)} B/delta), apply ${(editMs / n * 1000).toFixed(2)} us/edit, ` +
      `encode ${encodeMs.toFixed(1)} ms, save(write+rename+fsync-less) ${saveMs.toFixed(1)} ms`);
    rmSync(`${dir}/${w.id}.dcw`, { force: true });
  }

  // --- what a live builder world costs per second -------------------------
  const players = num(args.players, 16);
  const eps = num(args.eps, 3);
  console.log(`\nprojection for one live world, ${players} builders at ${eps} accepted edits/s each:`);
  for (const r of rows) {
    const savesPerSec = 1000 / AUTOSAVE_MS;              // continuous editing -> debounce fires every window
    const writeBps = r.fileBytes * savesPerSec;
    console.log(`  world of ${String(r.deltas).padStart(7)} deltas (${(r.fileBytes / 1048576).toFixed(2)} MB): ` +
      `${(writeBps / 1024).toFixed(0)} KB/s of disk writes, ` +
      `${(r.encodeMs * savesPerSec).toFixed(1)} ms/s of CPU just to re-encode it`);
  }
  const editRate = players * eps;
  console.log(`  the log grows at up to ${editRate} deltas/s while they build, so a world reaches`);
  for (const r of rows) {
    console.log(`    ${String(r.deltas).padStart(7)} deltas after ${(r.deltas / editRate / 60).toFixed(1)} min of that`);
  }

  rmSync(dir, { recursive: true, force: true });
  if (args.json) console.log(JSON.stringify(rows, null, 2));
  return rows;
}

/* ------------------------------------------------------------------------ *
 * Scenario: cdn — what a fresh player downloads, and what a returning one does
 * ------------------------------------------------------------------------ */

async function scenarioCdn() {
  const { readdirSync, statSync, readFileSync, existsSync } = await import('node:fs');
  const zlib = await import('node:zlib');
  const distRoot = join(REPO, 'dist');

  if (args.build || !existsSync(join(distRoot, 'index.html'))) {
    console.log('building client…');
    await new Promise((done, fail) => {
      const b = spawn('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
      b.on('exit', (c) => (c === 0 ? done() : fail(new Error(`build exited ${c}`))));
    });
  }

  /* --- static inventory -------------------------------------------------- */
  const files = [];
  (function walk(dir, rel) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) { walk(abs, `${rel}${name}/`); continue; }
      const buf = readFileSync(abs);
      files.push({
        path: `${rel}${name}`,
        raw: st.size,
        gzip: zlib.gzipSync(buf, { level: 9 }).length,
        brotli: zlib.brotliCompressSync(buf, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
        }).length,
      });
    }
  })(distRoot, '');
  files.sort((a, b) => b.raw - a.raw);
  const total = files.reduce((a, f) => ({
    raw: a.raw + f.raw, gzip: a.gzip + f.gzip, brotli: a.brotli + f.brotli,
  }), { raw: 0, gzip: 0, brotli: 0 });

  console.log(`\n=== CDN  (dist inventory, ${files.length} files) ===`);
  console.log('bytes raw        gzip      brotli   file');
  for (const f of files) {
    console.log(`${String(f.raw).padStart(9)} ${String(f.gzip).padStart(11)} ${String(f.brotli).padStart(11)}   ${f.path}`);
  }
  console.log(`${String(total.raw).padStart(9)} ${String(total.gzip).padStart(11)} ${String(total.brotli).padStart(11)}   TOTAL (whole bundle, every route)`);

  /* --- what a browser actually fetches ----------------------------------- */
  let browserRows = null;
  try {
    const { chromium } = await import('playwright');
    const port = 8123 + Math.floor(Math.random() * 400);
    const srv = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'server/src/index.ts')], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, PORT: String(port), DOOMCRAFT_STATIC: distRoot, NODE_OPTIONS: '' },
    });
    await new Promise((done) => {
      const on = (c) => { if (String(c).includes('listening')) { srv.stdout.off('data', on); srv.stdout.resume(); done(); } };
      srv.stdout.on('data', on);
      setTimeout(done, 20_000).unref?.();
    });

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    const record = () => {
      const rows = [];
      const handler = async (res) => {
        try {
          const req = res.request();
          const sizes = await req.sizes().catch(() => null);
          rows.push({
            url: res.url().replace(`http://127.0.0.1:${port}`, ''),
            status: res.status(),
            fromCache: res.fromServiceWorker() || (await res.headerValue('x-from-cache')) !== null,
            body: sizes?.responseBodySize ?? 0,
            headers: sizes?.responseHeadersSize ?? 0,
          });
        } catch { /* navigation raced the listener */ }
      };
      page.on('response', handler);
      return { rows, stop: () => page.off('response', handler) };
    };

    // cold: brand-new profile, empty HTTP cache
    const cold = record();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForTimeout(6000);
    cold.stop();

    // warm: same context, so the HTTP cache is populated
    const warm = record();
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(6000);
    warm.stop();

    const sum = (rows) => rows.reduce((a, r) => a + r.body + r.headers, 0);
    const sumBody = (rows) => rows.reduce((a, r) => a + r.body, 0);
    browserRows = {
      coldRequests: cold.rows.length, coldBytes: sum(cold.rows), coldBodyBytes: sumBody(cold.rows),
      warmRequests: warm.rows.length, warmBytes: sum(warm.rows), warmBodyBytes: sumBody(warm.rows),
      cold: cold.rows, warm: warm.rows,
    };
    console.log(`\nreal chromium, cold profile:  ${browserRows.coldRequests} requests, ` +
      `${(browserRows.coldBytes / 1048576).toFixed(3)} MB on the wire (body ${(browserRows.coldBodyBytes / 1048576).toFixed(3)} MB)`);
    for (const r of cold.rows.filter((r) => r.body > 0).sort((a, b) => b.body - a.body).slice(0, 20)) {
      console.log(`   ${String(r.body).padStart(8)} B  ${r.status}  ${r.url}`);
    }
    console.log(`real chromium, warm reload:   ${browserRows.warmRequests} requests, ` +
      `${(browserRows.warmBytes / 1048576).toFixed(3)} MB on the wire (body ${(browserRows.warmBodyBytes / 1048576).toFixed(3)} MB)`);
    for (const r of warm.rows.filter((r) => r.body > 0).sort((a, b) => b.body - a.body).slice(0, 20)) {
      console.log(`   ${String(r.body).padStart(8)} B  ${r.status}  ${r.url}`);
    }

    await browser.close();
    srv.kill('SIGKILL');
  } catch (e) {
    console.log(`\n(browser measurement unavailable: ${e.message})`);
  }

  const out = { files, total, browser: browserRows };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  return out;
}

/* ------------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------------ */

async function main() {
  if (args.role === 'host') { await runHost(); return; }
  const cmd = args._[0] ?? 'help';
  switch (cmd) {
    case 'bandwidth': await scenarioBandwidth(); break;
    case 'rooms': await scenarioRooms(); break;
    case 'memory': await scenarioMemory(); break;
    case 'breakpoint': await scenarioBreakpoint(); break;
    case 'builder': await scenarioBuilder(); break;
    case 'cdn': await scenarioCdn(); break;
    case 'persist': await scenarioPersist(); break;
    case 'chunks': await scenarioChunks(); break;
    default:
      console.log(`usage: npx tsx tools/loadtest.mjs <bandwidth|rooms|memory|breakpoint|builder|persist|chunks|cdn> [flags]`);
      process.exitCode = 1;
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
