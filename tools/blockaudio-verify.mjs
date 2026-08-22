/**
 * DOOMCRAFT — is the server's block stream actually audible, and is it sane?
 *
 * `client/src/game/editAudio.test.ts` proves the RULES. This proves the WIRING,
 * in the real browser against the real authoritative room, because the rules
 * being right is worth nothing if `Game.onBlocks` never calls them — which is
 * exactly the bug this fixes.
 *
 * Three questions, each answered by counting real `Sfx` calls:
 *
 *   A  a block change that arrives from the server and was NOT predicted here
 *      makes exactly one sound, at the right place, with the right material
 *      (the block that WAS there, not the AIR that replaced it)
 *   B  a crater's worth of changes in one tick makes one sound, not fifty
 *   C  a change this client DID predict — its own click — is silent on echo,
 *      so a dig is heard once at click time and not again a round trip later
 *
 * A and B need a change this client did not predict, which is what another
 * player's dig is. They get one by sending a real edit and then putting the
 * optimistic local prediction BACK before the server's answer returns: the
 * packet, the server, the decode, `onBlockDelta`'s previous-block capture,
 * `Game.onBlocks`, the gate and `Sfx` are all the real ones, and the client's
 * view of the voxel going into the echo is exactly what it would be if someone
 * else had swung the pick.
 *
 *   node tools/blockaudio-verify.mjs [--port 5173]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', '5173'));
const URL = `http://localhost:${PORT}/`;

const portOpen = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 800);
});
let proc = null;
async function serve() {
  if (await portOpen(PORT)) return;
  proc = spawn('npx', ['vite', '--config', 'client/vite.config.ts', '--port', String(PORT)],
    { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) { if (await portOpen(PORT)) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error('vite did not come up');
}

await serve();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => window.__DC__?.ready === true, null, { timeout: 90_000 });
await page.evaluate(() => window.__DC__.enterMode('deathmatch', { level: '', skill: 2 }));
const box = await page.locator('#game').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.evaluate(() => { if (document.pointerLockElement === null) window.__DC__.unlockedLook?.(true); });
await page.waitForFunction(() => window.__DC__.playing === true, null, { timeout: 20_000 });
await page.waitForTimeout(2500);

/* Tap the real Sfx instance. Nothing is stubbed out — the originals still run,
 * so the engine, the spatialiser and the voice allocator all still see the
 * calls exactly as they would in a match. */
await page.evaluate(() => {
  const g = window.__DC__.game;
  const s = g.sfx;
  window.__TAP__ = { breaks: [], places: [] };
  const ob = s.blockBreak.bind(s), op = s.blockPlace.bind(s);
  s.blockBreak = (x, y, z, id) => { window.__TAP__.breaks.push({ x, y, z, id, t: performance.now() }); ob(x, y, z, id); };
  s.blockPlace = (x, y, z) => { window.__TAP__.places.push({ x, y, z, t: performance.now() }); op(x, y, z); };
});

const fail = [];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail.push(msg); };

/* --- A: one server-side change this client did not predict --------------- */
const a = await page.evaluate(async () => {
  const g = window.__DC__.game;
  const w = g.net.world;
  const p = g.net.renderPos;
  let target = null;
  for (let r = 2; r < 8 && !target; r++) {
    for (let dy = -2; dy <= 2 && !target; dy++) {
      const x = Math.floor(p[0]) + r, y = Math.floor(p[1]) + dy, z = Math.floor(p[2]);
      if (y > 0 && y < 63 && w.getBlock(x, y, z) > 0) target = { x, y, z, was: w.getBlock(x, y, z) };
    }
  }
  if (!target) return { err: 'no solid voxel near the spawn' };
  window.__TAP__.breaks.length = 0;
  const sent = g.net.requestEdit(0, target.x, target.y, target.z, 0);
  // Undo the optimistic prediction. From here the echo is indistinguishable
  // from another player having broken this block.
  w.setBlock(target.x, target.y, target.z, target.was);
  await new Promise((r) => setTimeout(r, 800));
  return { target, sent, breaks: window.__TAP__.breaks.slice() };
});
if (a.err) { ok(false, `A: ${a.err}`); } else {
  ok(a.sent === true, 'A: the edit went to the server');
  ok(a.breaks.length === 1, `A: one unpredicted break makes exactly 1 sound (got ${a.breaks.length})`);
  const b = a.breaks[0];
  if (b) {
    ok(b.id === a.target.was,
      `A: sounds the material that WAS there, id ${b.id} vs ${a.target.was} (AIR=0 would be the bug)`);
    ok(Math.abs(b.x - (a.target.x + 0.5)) < 0.01 && Math.abs(b.z - (a.target.z + 0.5)) < 0.01,
      `A: positioned at the voxel (${b.x}, ${b.y}, ${b.z})`);
  }
}

/* --- B: a crater's worth in one tick ------------------------------------ */
const bres = await page.evaluate(async () => {
  const g = window.__DC__.game;
  const w = g.net.world;
  const p = g.net.renderPos;
  window.__TAP__.breaks.length = 0;
  const undo = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -3; dy <= 1; dy++) {
        const x = Math.floor(p[0]) + dx, y = Math.floor(p[1]) + dy, z = Math.floor(p[2]) + dz + 8;
        if (y < 1 || y > 62) continue;
        const was = w.getBlock(x, y, z);
        if (was > 0 && g.net.requestEdit(0, x, y, z, 0)) undo.push([x, y, z, was]);
      }
    }
  }
  for (const [x, y, z, was] of undo) w.setBlock(x, y, z, was);
  await new Promise((r) => setTimeout(r, 1000));
  return { sent: undo.length, heard: window.__TAP__.breaks.length };
});
ok(bres.sent > 15, `B: sent ${bres.sent} voxel changes in one frame`);
ok(bres.heard > 0 && bres.heard <= 6,
  `B: heard ${bres.heard} sounds for ${bres.sent} changes (one per delta would be ${bres.sent})`);

/* --- C: an edit this client predicted is silent on echo ------------------ */
const c = await page.evaluate(async () => {
  const g = window.__DC__.game;
  const w = g.net.world;
  const p = g.net.renderPos;
  let target = null;
  for (let r = 2; r < 8 && !target; r++) {
    for (let dy = -2; dy <= 2 && !target; dy++) {
      const x = Math.floor(p[0]) - r, y = Math.floor(p[1]) + dy, z = Math.floor(p[2]) + 2;
      if (y > 0 && y < 63 && w.getBlock(x, y, z) > 0) target = { x, y, z };
    }
  }
  if (!target) return { err: 'no solid voxel' };
  window.__TAP__.breaks.length = 0;
  // Exactly what `Game.stepEdits` does, minus the local `sfx.blockBreak` that
  // it plays at click time — so anything counted here is a duplicate.
  const sent = g.net.requestEdit(0, target.x, target.y, target.z, 0);
  await new Promise((r) => setTimeout(r, 900));
  return { sent, echoes: window.__TAP__.breaks.length };
});
if (c.err) { ok(false, `C: ${c.err}`); } else {
  ok(c.sent === true, 'C: the edit went to the server');
  ok(c.echoes === 0, `C: a predicted edit produces no echo sound (got ${c.echoes})`);
}

ok(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
await browser.close();
if (proc) proc.kill();
console.log(fail.length === 0 ? '\nALL GREEN' : `\n${fail.length} FAILED`);
process.exit(fail.length === 0 ? 0 : 1);
