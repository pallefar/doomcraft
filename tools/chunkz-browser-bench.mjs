#!/usr/bin/env node
/**
 * DOOMCRAFT — the client half of the compressed join burst, in a real browser.
 *
 *   node --import tsx tools/chunkz-browser-bench.mjs [--throttle 4] [--keep]
 *
 * Generates the real 169-chunk world with the real `ServerWorld`, encodes the
 * real `S2C.CHUNK` and `S2C.CHUNK_Z` packets with the real encoders, then hands
 * both sets to `client/__chunkzbench.html` running in real Chromium and reads
 * back three timings:
 *
 *   A  main thread, uncompressed RLE   the path that shipped before
 *   B  worker, deflate + RLE           the path that ships now
 *   C  main thread, deflate + RLE      the ChunkInflater fallback
 *
 * MAIN-THREAD milliseconds is the number that matters. Total CPU going up is
 * fine — it went up in a thread nobody is drawing on.
 *
 * `--throttle N` applies CDP CPU throttling, so the phone case can be read too.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { ServerWorld } from '../server/src/world.js';
import {
  PacketWriter, WORLD_MIN_CHUNK, encodeChunk, encodeChunkZ, rleEncodeInto, rleMaxBytes,
} from '@doomcraft/shared';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const THROTTLE = Number(val('--throttle', '1'));
const SEED = Number(val('--seed', '12345'));
const PORT = 5173;

/* ------------------------------------------------------------------ *
 * Fixtures: the real packets, from the real world
 * ------------------------------------------------------------------ */

function frame(packets) {
  let total = 0;
  for (const p of packets) total += 4 + p.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const p of packets) {
    view.setUint32(o, p.length, true); o += 4;
    out.set(p, o); o += p.length;
  }
  return out;
}

function buildFixtures() {
  const world = new ServerWorld(SEED);
  world.generateAll();
  const w = new PacketWriter(1 << 20);
  const scratch = new Uint8Array(rleMaxBytes(32 * 64 * 32));
  const raw = [];
  const z = [];
  let deflateNs = 0n;
  for (let cz = WORLD_MIN_CHUNK; cz <= -WORLD_MIN_CHUNK; cz++) {
    for (let cx = WORLD_MIN_CHUNK; cx <= -WORLD_MIN_CHUNK; cx++) {
      const vox = world.ensureChunk(cx, cz);
      encodeChunk(w, cx, cz, vox);
      raw.push(w.copy());
      const rleLen = rleEncodeInto(vox, scratch, 0);
      const t = process.hrtime.bigint();
      const packed = deflateRawSync(scratch.subarray(0, rleLen), { level: 6 });
      deflateNs += process.hrtime.bigint() - t;
      encodeChunkZ(w, cx, cz, rleLen, packed);
      z.push(w.copy());
    }
  }
  const sum = (a) => a.reduce((x, b) => x + b.length, 0);
  return {
    raw, z,
    rawBytes: sum(raw), zBytes: sum(z),
    deflateMs: Number(deflateNs) / 1e6,
  };
}

/* ------------------------------------------------------------------ *
 * Dev server
 * ------------------------------------------------------------------ */

const portOpen = (port) => new Promise((r) => {
  const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); r(true); });
  s.on('error', () => r(false));
  s.setTimeout(600, () => { s.destroy(); r(false); });
});

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const p = spawn('npx', ['vite', '--config', 'client/vite.config.ts'],
    { cwd: ROOT, stdio: 'ignore', detached: false });
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    if (await portOpen(PORT)) return p;
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill('SIGKILL');
  throw new Error('vite did not start');
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const fx = buildFixtures();
console.log(`\n=== FIXTURES (real terrain, seed ${SEED}) ===`);
console.log(`  ${fx.raw.length} chunks`);
console.log(`  S2C.CHUNK    ${(fx.rawBytes / 1048576).toFixed(3)} MB`);
console.log(`  S2C.CHUNK_Z  ${(fx.zBytes / 1048576).toFixed(3)} MB   ratio ${(fx.rawBytes / fx.zBytes).toFixed(2)}x`);
console.log(`  server deflate, whole world, once per room: ${fx.deflateMs.toFixed(0)} ms`);

const proc = await ensureServer();
const browser = await chromium.launch({ args: ['--enable-features=WebAssemblyJSPromiseIntegration'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', String(e).slice(0, 300)));
  if (THROTTLE > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  }
  await page.goto(`http://localhost:${PORT}/__chunkzbench.html`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => window.__CHUNKZ__ !== undefined, null, { timeout: 30_000 });

  const supported = await page.evaluate(() => window.__CHUNKZ__.supported);
  console.log(`\n  DecompressionStream('deflate-raw') in this browser: ${supported}`);

  const rawB64 = Buffer.from(frame(fx.raw)).toString('base64');
  const zB64 = Buffer.from(frame(fx.z)).toString('base64');
  const r = await page.evaluate(
    ([a, b]) => window.__CHUNKZ__.run(a, b), [rawB64, zB64],
  );

  const row = (label, x) => {
    console.log(`\n  ${label}`);
    console.log(`    wall            ${x.ms.toFixed(1)} ms   (${(x.ms / r.chunks).toFixed(3)} ms/chunk)`);
    console.log(`    MAIN THREAD     ${x.mainMs.toFixed(1)} ms   (${(x.mainMs / r.chunks).toFixed(3)} ms/chunk)`);
    console.log(`    long tasks      ${x.longTasks.count}, longest ${x.longTasks.maxMs.toFixed(0)} ms, total ${x.longTasks.totalMs.toFixed(0)} ms`);
    console.log(`    worst 4 ms heartbeat gap ${x.worstGapMs.toFixed(1)} ms`);
    if (x.bootMs !== undefined) console.log(`    worker boot     ${x.bootMs.toFixed(0)} ms (dev server, unbundled)`);
  };
  console.log(`\n=== BROWSER DECODE, ${r.chunks} chunks, CPU throttle ${THROTTLE}x ===`);
  row('A  main thread, uncompressed RLE  (before)', r.a);
  row('B  worker, deflate + RLE          (after)', r.b);
  row('C  main thread, deflate + RLE     (fallback)', r.c);
  console.log(`\n  main-thread decode cost: ${r.a.mainMs.toFixed(1)} -> ${r.b.mainMs.toFixed(1)} ms  ` +
    `(${(r.a.mainMs / Math.max(0.01, r.b.mainMs)).toFixed(1)}x less work on the thread that draws)`);
} finally {
  await browser.close();
  if (proc && !argv.includes('--keep')) proc.kill('SIGKILL');
}
process.exit(0);
