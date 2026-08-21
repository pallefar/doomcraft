/**
 * DOOMCRAFT — character draw-call / frame-time bench.
 *
 *   node tools/char-bench.mjs --root <repo> --tag before
 *
 * Answers exactly three questions, at 915x412 under a verified 4x CPU
 * throttle, which is the viewport and the throttle ref/BAR.md's 0.90 ms budget
 * was measured at:
 *
 *   1. renderer.info.render.calls with N enemies inside the frustum
 *   2. FrameStats.medianMs() over a settled window at that N
 *   3. bytes actually fetched for character assets (CDP network accounting)
 *
 * It drives Horde through the real mode registry, skips the fortify clock, and
 * then samples once per animation frame for a fixed window, bucketing every
 * sample by the number of monsters whose world position is inside the camera
 * frustum THAT frame. So "N enemies visible" is counted the same way before and
 * after the change — from the shipping camera matrices, not from a guess.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

const ROOT = path.resolve(val('--root', process.cwd()));
const TAG = val('--tag', 'run');
const PORT = Number(val('--port', '5199'));
const THROTTLE = Number(val('--throttle', '4'));
const WIDTH = Number(val('--width', '915'));
const HEIGHT = Number(val('--height', '412'));
const MODE = val('--mode', 'horde');
const SECONDS = Number(val('--seconds', '26'));
const OUT = path.resolve(val('--out', path.join(ROOT, 'shots')));
const HEADED = has('--headed');
/** Force the sampling yaw so a before/after pair sees the same terrain. */
const FIXED_YAW = val('--yaw', '');

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

/* ---------------------------------------------------------------- server */

function portOpen(port) {
  return new Promise((r) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); r(true); });
    s.on('error', () => r(false));
    s.setTimeout(600, () => { s.destroy(); r(false); });
  });
}
async function waitPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await portOpen(port)) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
}

let proc = null;
async function serve() {
  if (await portOpen(PORT)) { log(`port ${PORT} already open, reusing`); return; }
  proc = spawn('node', [
    path.join(ROOT, 'node_modules/vite/bin/vite.js'),
    '--config', path.join(ROOT, 'client/vite.config.ts'),
    '--port', String(PORT), '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  if (!await waitPort(PORT, 40000)) throw new Error('vite did not start');
}
function stopServe() { if (proc !== null) { proc.kill('SIGTERM'); proc = null; } }

/* ---------------------------------------------------------------- page fns */

/**
 * Sample the renderer. Runs in the page, so it reads the SAME numbers the game
 * reports: `renderer.info.render.calls` and the shipping `FrameStats`.
 *
 * Frustum test is done by hand from the camera's own matrices rather than by
 * importing THREE, so it works identically on every build.
 */
const SAMPLE_FN = `(() => {
  const g = window.__DC__.game;
  const cam = g.renderer.camera;
  cam.updateMatrixWorld();
  const p = cam.projectionMatrix.elements, v = cam.matrixWorldInverse.elements;
  // m = P * V, column-major
  const m = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += p[k * 4 + r] * v[c * 4 + k];
    m[c * 4 + r] = s;
  }
  const inside = (x, y, z) => {
    const cx = m[0]*x + m[4]*y + m[8]*z + m[12];
    const cy = m[1]*x + m[5]*y + m[9]*z + m[13];
    const cw = m[3]*x + m[7]*y + m[11]*z + m[15];
    if (cw <= 0) return false;
    return Math.abs(cx) <= cw * 1.06 && Math.abs(cy) <= cw * 1.35;
  };
  let visible = 0, alive = 0, dead = 0;
  for (const e of g.net.entities) {
    if (!e.active || e.type >= 16) continue;
    alive++;
    if ((e.state & 8) !== 0) dead++;
    // sample the body's middle, not its feet
    if (inside(e.x, e.y + 0.9, e.z)) visible++;
  }
  const cs = g.characterStats ? g.characterStats() : null;
  return {
    visible, monsters: alive, deadMonsters: dead,
    calls: g.renderer.drawCalls,
    tris: g.renderer.triangles,
    medianMs: g.renderer.stats.medianMs(),
    fps: g.renderer.stats.fps,
    chunks: g.chunks.stats.visibleChunks,
    charDraws: cs ? cs.draws : 0,
    charInstances: cs ? cs.instances : 0,
    charBodies: cs ? cs.bodies : 0,
  };
})()`;

/* ---------------------------------------------------------------- main */

async function main() {
  await serve();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--disable-frame-rate-limit'],
  });
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  /* --- byte accounting: every response, by URL ---------------------- */
  const bytes = new Map();
  page.on('response', async (res) => {
    try {
      const url = res.url();
      const buf = await res.body().catch(() => null);
      if (buf === null) return;
      bytes.set(url, (bytes.get(url) ?? 0) + buf.length);
    } catch { /* redirects and aborted requests have no body */ }
  });

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE', m.text()); });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__DC__ && window.__DC__.ready, null, { timeout: 90000 });

  /* --- verify the throttle is genuine -------------------------------- */
  const spin = await page.evaluate(() => {
    const t = performance.now();
    let x = 0;
    for (let i = 0; i < 8e6; i++) x += Math.sqrt(i);
    return { ms: performance.now() - t, x };
  });

  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'none';
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'masked';
  });
  log(`gpu=${gpu} spinMs=${spin.ms.toFixed(0)} throttle=${THROTTLE}x`);

  const entered = await page.evaluate((m) => window.__DC__.enterMode(m, { skill: 2, seed: 7 }), MODE);
  log(`mode=${entered}`);
  await page.evaluate(() => window.__DC__.play());
  await page.waitForTimeout(2500);

  /* --- pick a yaw, then LOCK it ------------------------------------------ *
   * Draw calls are dominated by visible chunks, and visible chunks depend on
   * which way you are facing. Sweeping while sampling therefore confounds "how
   * many enemies" with "how much terrain", which is exactly the confound this
   * bench exists to avoid. So: scan once for the busiest direction, then hold
   * it, and let the wave walk through the frustum at constant terrain cost.
   * ---------------------------------------------------------------------- */
  await page.evaluate(() => window.__DC__.suspendInput(true));
  let bestYaw = 0;
  let bestSeen = -1;
  for (let i = 0; FIXED_YAW === '' && i < 28; i++) {
    const y = (i / 28) * Math.PI * 2;
    await page.evaluate((yy) => { window.__DC__.game.camera.setAngles(yy, -0.04); }, y);
    await page.waitForTimeout(70);
    const s = await page.evaluate(SAMPLE_FN);
    // Most VISIBLE CHUNKS, not most monsters: the scan runs during the fortify
    // window when there are no monsters yet, and open ground is both the
    // heaviest direction to draw and the one a wave will walk out of.
    if (s.chunks > bestSeen) { bestSeen = s.chunks; bestYaw = y; }
  }
  if (FIXED_YAW !== '') bestYaw = Number(FIXED_YAW);
  log(`locked yaw=${bestYaw.toFixed(4)} seen=${bestSeen}`);

  /* --- phase 1: the fortify window, which has NO monsters ---------------- *
   * The player has not moved since spawn and nothing has spawned to push it,
   * so this frame is byte-identical scenery between a before and an after run
   * at the same seed and the same yaw. It is the only clean answer to "what
   * does the character subsystem cost when there is nothing to draw".
   * ---------------------------------------------------------------------- */
  const quiet = [];
  const quietEnd = Date.now() + 9000;
  while (Date.now() < quietEnd) {
    await page.evaluate((y) => { window.__DC__.game.camera.setAngles(y, -0.04); }, bestYaw);
    quiet.push(await page.evaluate(SAMPLE_FN));
    await page.waitForTimeout(110);
  }
  const qmed = (f) => { const v = quiet.map(f).sort((a, b) => a - b); return v[v.length >> 1]; };
  const quietRow = {
    phase: 'fortify (no monsters)', samples: quiet.length,
    calls: qmed((s) => s.calls), chunks: qmed((s) => s.chunks),
    medianMs: Number(qmed((s) => s.medianMs).toFixed(3)),
    tris: qmed((s) => s.tris), charDraws: qmed((s) => s.charDraws),
  };
  log(`quiet: ${JSON.stringify(quietRow)}`);
  await page.screenshot({ path: path.join(OUT, `bench-${TAG}-00-quiet.png`) });

  // Skip the fortify clock: the wave is the rest of the measurement.
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(2500);

  const samples = [];
  const end = Date.now() + SECONDS * 1000;
  let shots = 0;
  while (Date.now() < end) {
    await page.evaluate((y) => { window.__DC__.game.camera.setAngles(y, -0.04); }, bestYaw);
    const s = await page.evaluate(SAMPLE_FN);
    samples.push(s);
    if (s.visible >= 2 && shots < 8) {
      shots++;
      await page.screenshot({ path: path.join(OUT, `bench-${TAG}-${String(shots).padStart(2, '0')}-n${s.visible}.png`) });
    }
    await page.waitForTimeout(110);
  }

  /* --- control for terrain, then bucket by visible N ---------------------- *
   * Only samples inside the modal chunk count (+/-2) are kept, so every row is
   * the same amount of world with a different number of monsters in front of
   * it. Rows report their chunk count so the reader can check that.
   * ---------------------------------------------------------------------- */
  const chunkHist = new Map();
  for (const s of samples) chunkHist.set(s.chunks, (chunkHist.get(s.chunks) ?? 0) + 1);
  let modal = 0, modalN = -1;
  for (const [c, n] of chunkHist) if (n > modalN) { modalN = n; modal = c; }
  const kept = samples.filter((s) => Math.abs(s.chunks - modal) <= 2);
  log(`modal chunks=${modal}; kept ${kept.length}/${samples.length} samples`);

  const buckets = new Map();
  for (const s of kept) {
    const k = s.visible;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
  const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([n, list]) => {
    const med = (f) => { const v = list.map(f).sort((a, b) => a - b); return v[v.length >> 1]; };
    return {
      n, samples: list.length,
      calls: med((s) => s.calls),
      callsMin: Math.min(...list.map((s) => s.calls)),
      callsMax: Math.max(...list.map((s) => s.calls)),
      medianMs: Number(med((s) => s.medianMs).toFixed(3)),
      tris: med((s) => s.tris),
      chunks: med((s) => s.chunks),
      charDraws: med((s) => s.charDraws),
      charInstances: med((s) => s.charInstances),
      charBodies: med((s) => s.charBodies),
    };
  });

  /* --- transfer bytes ---------------------------------------------------- */
  const charBytes = {};
  let charTotal = 0;
  for (const [url, n] of bytes) {
    if (/characters\/cast\.(glb|png)|kenney-chars\.png|GLTFLoader/.test(url)) {
      charBytes[url.replace(/^https?:\/\/[^/]+\//, '')] = n;
      charTotal += n;
    }
  }

  const result = { tag: TAG, yaw: bestYaw, quiet: quietRow, modalChunks: modal, keptSamples: kept.length, gpu, throttle: THROTTLE, spinMs: spin.ms, viewport: [WIDTH, HEIGHT], mode: entered, rows, charBytes, charTotal, sampleCount: samples.length };
  fs.writeFileSync(path.join(OUT, `bench-${TAG}.json`), JSON.stringify(result, null, 2));
  log(JSON.stringify(result, null, 2));

  await browser.close();
  stopServe();
}

main().catch((e) => { console.error(e); stopServe(); process.exit(1); });
