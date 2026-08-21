#!/usr/bin/env node
/**
 * DOOMCRAFT — what the compressed join burst actually costs.
 *
 *   node --import tsx tools/chunkz-bench.mjs [--clients 8] [--seed 12345]
 *
 * Real `Room`, real `NetHub`, real `ws` WebSocketServer wired the way
 * `server/src/index.ts` wires it (noServer upgrade, maxPayload 256 KB,
 * perMessageDeflate FALSE), real binary protocol, real terrain. Clients are
 * real `ws` sockets speaking real HELLO and inflating with node's zlib, and
 * every chunk they decode is compared byte for byte against the server's own
 * voxels — a bandwidth number from a decoder that is quietly wrong is worse
 * than no number.
 *
 * Bytes are counted at the TCP socket (`socket.bytesRead`), so ws framing is
 * included and nothing is inferred from payload lengths.
 *
 * Two runs, same world, same client count:
 *   raw  — clients send caps 0, server falls back to S2C.CHUNK   (today)
 *   z    — clients send CAP_INFLATE, server sends S2C.CHUNK_Z    (this change)
 *
 * The per-joiner CPU split matters as much as the ratio: the deflate is cached
 * per chunk per room, so joiner #1 pays for it and joiner #2 onwards pays a
 * memcpy. Both are printed.
 */

import { createServer } from 'node:http';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';

import { Room } from '../server/src/room.js';
import { setChunkCompressor } from '../server/src/net.js';
import {
  CAP_INFLATE,
  CHUNK_VOLUME,
  GameMode,
  PacketReader,
  PacketWriter,
  S2C,
  WORLD_CHUNK_COUNT,
  WS_PATH,
  createChunkZHeader,
  createWelcomeMessage,
  decodeChunkZHeader,
  decodeWelcome,
  encodeHello,
  rleDecode,
} from '@doomcraft/shared';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const CLIENTS = Number(val('--clients', '8'));
const SEED = Number(val('--seed', '12345'));

class WsTransport {
  constructor(socket) { this.socket = socket; }
  get isOpen() { return this.socket.readyState === 1; }
  get bufferedAmount() { return this.socket.bufferedAmount; }
  send(data) { if (this.socket.readyState === 1) this.socket.send(data, { binary: true }); }
  close(code = 1000, reason = '') { try { this.socket.close(code, reason); } catch { /* gone */ } }
}

/** One joiner: real socket, real HELLO, real decode, real verification. */
function join(port, index, caps, world) {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { perMessageDeflate: false });
    const reader = new PacketReader();
    const header = createChunkZHeader();
    const welcome = createWelcomeMessage();
    const voxels = new Uint8Array(CHUNK_VOLUME);
    let chunks = 0, appBytes = 0, zPayload = 0, mismatches = 0, decodeNs = 0n;
    let sock = null, startNs = 0n;

    ws.on('upgrade', (res) => { sock = res.socket; });
    ws.on('open', () => {
      startNs = process.hrtime.bigint();
      const w = new PacketWriter(256);
      encodeHello(w, `p${index}`, 0, caps, 0);
      ws.send(w.copy(), { binary: true });
    });
    ws.on('message', (data) => {
      const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      appBytes += u8.length;
      const id = u8[0];
      if (id === S2C.WELCOME) { decodeWelcome(reader.reset(u8), welcome); return; }
      if (id !== S2C.CHUNK && id !== S2C.CHUNK_Z) return;

      const t = process.hrtime.bigint();
      let cx, cz;
      if (id === S2C.CHUNK_Z) {
        decodeChunkZHeader(reader.reset(u8), header);
        cx = header.cx; cz = header.cz;
        zPayload += header.zLen;
        const rle = inflateRawSync(u8.subarray(reader.offset, reader.offset + header.zLen));
        if (rle.length !== header.rleLen) mismatches++;
        voxels.fill(0);
        rleDecode(rle, 0, header.rleLen, voxels);
      } else {
        reader.reset(u8);
        reader.u8(); cx = reader.i16(); cz = reader.i16();
        const len = reader.u32();
        voxels.fill(0);
        rleDecode(reader.bytes, reader.offset, len, voxels);
      }
      decodeNs += process.hrtime.bigint() - t;

      const truth = world.ensureChunk(cx, cz);
      for (let i = 0; i < CHUNK_VOLUME; i++) {
        if (voxels[i] !== truth[i]) { mismatches++; break; }
      }

      if (++chunks >= WORLD_CHUNK_COUNT) {
        const joinMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        const wire = sock ? sock.bytesRead : -1;
        ws.close();
        done({ index, chunks, appBytes, zPayload, wire, joinMs, mismatches, decodeMs: Number(decodeNs) / 1e6 });
      }
    });
    ws.on('error', fail);
  });
}

async function run(label, caps) {
  const room = new Room({
    seed: SEED, mode: GameMode.DEATHMATCH, botFill: 0, enemies: -1,
    store: null, eagerWorld: true, name: 'bench', clock: () => Date.now(),
  });
  const http = createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  http.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => {
    const conn = room.join(new WsTransport(ws));
    ws.on('message', (d) => room.receive(conn, new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    ws.on('close', () => room.leave(conn));
    ws.on('error', () => room.leave(conn));
  }));
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const port = http.address().port;
  room.start();

  // Joiner #1 alone first: that is the one that fills the compressed cache, and
  // averaging it in with the rest would hide both numbers.
  const cpuA = process.cpuUsage();
  const first = await join(port, 0, caps, room.world);
  const firstCpuMs = (() => { const c = process.cpuUsage(cpuA); return (c.user + c.system) / 1000; })();

  const cpuB = process.cpuUsage();
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, CLIENTS - 1) }, (_, i) => join(port, i + 1, caps, room.world)),
  );
  const restCpu = process.cpuUsage(cpuB);
  const restCpuMs = (restCpu.user + restCpu.system) / 1000;

  room.stop();
  await new Promise((r) => { http.close(r); wss.close(); });

  const all = [first, ...rest];
  const mismatches = all.reduce((a, b) => a + b.mismatches, 0);
  const avg = (k, xs) => xs.reduce((a, b) => a + b[k], 0) / xs.length;

  return {
    label,
    wire: avg('wire', all),
    app: avg('appBytes', all),
    joinMs: avg('joinMs', all),
    firstJoinMs: first.joinMs,
    warmJoinMs: rest.length > 0 ? avg('joinMs', rest) : NaN,
    decodeMs: avg('decodeMs', all),
    coldCpuMs: firstCpuMs,
    warmCpuMs: rest.length > 0 ? restCpuMs / rest.length : NaN,
    mismatches,
  };
}

const MB = (n) => (n / 1048576).toFixed(3);

setChunkCompressor(null);
const raw = await run('raw  (S2C.CHUNK, today)', 0);

setChunkCompressor((src) => deflateRawSync(src, { level: 6 }));
const z = await run('z    (S2C.CHUNK_Z)', CAP_INFLATE);

console.log(`\n=== JOIN BURST — ${CLIENTS} real ws joiners, ${WORLD_CHUNK_COUNT} chunks each, seed ${SEED} ===`);
for (const r of [raw, z]) {
  console.log(`\n  ${r.label}`);
  console.log(`    wire bytes / joiner   ${MB(r.wire)} MB   (TCP payload, ws framing included)`);
  console.log(`    app  bytes / joiner   ${MB(r.app)} MB`);
  console.log(`    join wall, joiner 1   ${r.firstJoinMs.toFixed(0)} ms  (all ${WORLD_CHUNK_COUNT} chunks, tick-paced, cold cache)`);
  console.log(`    join wall, joiner 2+  ${Number.isNaN(r.warmJoinMs) ? 'n/a' : r.warmJoinMs.toFixed(0) + ' ms'}  (warm cache)`);
  console.log(`    client decode CPU     ${r.decodeMs.toFixed(1)} ms / joiner  (inflate + RLE, node zlib)`);
  console.log(`    server CPU, joiner 1  ${r.coldCpuMs.toFixed(0)} ms  (cold cache)`);
  console.log(`    server CPU, joiner 2+ ${Number.isNaN(r.warmCpuMs) ? 'n/a' : r.warmCpuMs.toFixed(0) + ' ms'}  (warm cache)`);
  console.log(`    voxel mismatches      ${r.mismatches}`);
}
console.log(`\n  RATIO  ${(raw.wire / z.wire).toFixed(2)}x on the wire   (${MB(raw.wire)} -> ${MB(z.wire)} MB per joiner)`);
console.log(`  server CPU per steady-state joiner: ${raw.warmCpuMs.toFixed(0)} -> ${z.warmCpuMs.toFixed(0)} ms`);
if (raw.mismatches + z.mismatches > 0) {
  console.error('\n  *** VOXEL MISMATCH — the ratio above is worthless ***');
  process.exit(1);
}
process.exit(0);
