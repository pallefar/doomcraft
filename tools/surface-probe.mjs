/**
 * DOOMCRAFT — surface-detail measurement run.
 *
 *   node tools/surface-probe.mjs --label before
 *   node tools/surface-probe.mjs --label after --shots
 *
 * Drives client/probe.html in a real headed Chromium (a headless run has no
 * timer-query GPU worth quoting) and prints two tables:
 *
 *   1. High-pass 3x3 residual RMS in absolute 8-bit grey levels, per material,
 *      measured at the mean luminance the original captures recorded, next to
 *      the bar's own sand and grass measured from ref/voxiom with the same
 *      operator. The bar patches are hard-coded rectangles, not a search, so
 *      the reference side of the table cannot drift between runs.
 *   2. GPU cost as ms per megapixel — the slope of frame time against pixel
 *      count with the camera pinned, with the atlas off and on.
 *
 * Results land in shots/surface-<label>.json so a before/after diff is a file
 * comparison rather than a memory of what the terminal said.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPng, luma, highPassRms } from './hprms.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const LABEL = val('--label', 'run');
const PORT = Number(val('--port', '5173'));
const SHOTS = has('--shots');

/* ------------------------------------------------------------------ *
 * The bar, measured off disk with the same operator.
 *
 * Fixed rectangles chosen once by scanning for the flattest patch at the
 * luminance the original table quotes; pinned here so the reference numbers
 * are constants and only our side of the comparison can move.
 * ------------------------------------------------------------------ */

const BAR = [
  { key: 'BAR sand, mid-near', file: 'desktop-08-combat.png', x: 648, y: 624, w: 48, h: 48 },
  { key: 'BAR grass top', file: 'desktop-02-fwd.png', x: 800, y: 528, w: 48, h: 48 },
  { key: 'BAR sky (calibration)', file: 'desktop-08-combat.png', x: 600, y: 150, w: 64, h: 64 },
];

function measureBar() {
  return BAR.map((p) => {
    const img = readPng(path.join(ROOT, 'ref', 'voxiom', p.file));
    const r = highPassRms(img, luma(img), p.x, p.y, p.w, p.h);
    return { key: p.key, rms: r.rms, mean: r.mean };
  });
}

/* ------------------------------------------------------------------ *
 * Our materials.
 *
 * Block + face + operating point are the identification of each row in the
 * recorded before-table; the luminance is what pins it to that capture.
 * ------------------------------------------------------------------ */

const SPECS = [
  { key: 'OURS DM stone wall, nose', block: 'STONE', face: 'PZ', dist: 1.2, targetLum: 41 },
  { key: 'OURS builder red wall', block: 'HELLSTONE', face: 'PZ', dist: 2.2, targetLum: 30 },
  { key: 'OURS builder red floor', block: 'HELLSTONE', face: 'PY', pitch: 45, targetLum: 58 },
  { key: 'OURS quest brick', block: 'BRICK', face: 'PZ', dist: 10.0, targetLum: 26 },
  { key: 'OURS quest tile floor', block: 'TECH_PANEL', face: 'PY', pitch: 45, targetLum: 56 },
  { key: 'OURS sand top (bar-matched)', block: 'SAND', face: 'PY', pitch: 45, targetLum: 205 },
  { key: 'OURS grass top (bar-matched)', block: 'GRASS', face: 'PY', pitch: 45, targetLum: 152 },
  { key: 'OURS cobble wall', block: 'COBBLESTONE', face: 'PZ', dist: 2.2, targetLum: 45 },
  { key: 'OURS obsidian wall', block: 'OBSIDIAN', face: 'PZ', dist: 2.2, targetLum: 28 },
  { key: 'OURS planks wall', block: 'PLANKS', face: 'PZ', dist: 2.2, targetLum: 70 },
];

/* ------------------------------------------------------------------ *
 * Dev server
 * ------------------------------------------------------------------ */

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(700, () => { s.destroy(); resolve(false); });
  });
}

let serverProc = null;
async function ensureServer() {
  if (await portOpen(PORT)) { console.log(`dev server already on :${PORT}`); return; }
  console.log(`starting vite on :${PORT}`);
  serverProc = spawn('npm', ['run', 'dev:client'], { cwd: ROOT, stdio: 'ignore', detached: false });
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    if (await portOpen(PORT)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('vite did not come up');
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 3) => (v === null || v === undefined ? '   -  ' : v.toFixed(n));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await ensureServer();

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--enable-gpu',
      '--use-angle=metal',
      '--enable-webgl-draft-extensions',
      '--disable-frame-rate-limit',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('  page error:', m.text()); });
  page.on('pageerror', (e) => console.log('  page exception:', e.message));

  await page.goto(`http://localhost:${PORT}/probe.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__PROBE__?.ready === true, null, { timeout: 30_000 });

  const gpuName = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    const d = c.getExtension('WEBGL_debug_renderer_info');
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER);
  });
  const hasTimer = await page.evaluate(() => window.__PROBE__.hasTimer);
  console.log(`GPU: ${gpuName}`);
  console.log(`timer query: ${hasTimer ? 'yes' : 'NO — ms/Mpx unavailable'}`);

  const specs = await page.evaluate((s) => s.map((x) => ({
    ...x, block: window.__PROBE__.BlockId[x.block], face: window.__PROBE__.Face[x.face],
  })), SPECS);
  for (let i = 0; i < specs.length; i++) specs[i].key = SPECS[i].key;

  const GPUONLY = has('--gpuonly');
  const ours = GPUONLY ? [] : await page.evaluate((s) => window.__PROBE__.measureAll(s), specs);
  const bar = GPUONLY ? [] : measureBar();

  console.log('\n  high-pass 3x3 residual RMS, absolute 8-bit grey levels');
  console.log('  ' + pad('patch', 34) + pad('RMS', 8) + pad('mean lum', 10) + 'p20..p80');
  for (const r of bar) {
    console.log('  ' + pad(r.key, 34) + pad(num(r.rms), 8) + pad(r.mean.toFixed(1), 10));
  }
  for (const r of ours) {
    const spec = SPECS.find((s) => s.key === r.key);
    console.log('  ' + pad(spec.key, 34) + pad(num(r.rms), 8) + pad(r.mean.toFixed(1), 10)
      + `${num(r.rmsLo)} .. ${num(r.rmsHi)}  (exp ${r.exposure.toFixed(2)})`);
  }

  /* ---- optional: how the metric responds to amplitude ---- */
  if (has('--gain')) {
    console.log('\n  RMS vs global detail scale (uDetail), seam held at default');
    const keys = ['OURS DM stone wall, nose', 'OURS builder red wall', 'OURS quest brick',
      'OURS quest tile floor', 'OURS sand top (bar-matched)'];
    for (const k of keys) {
      const s0 = specs.find((x) => x.key === k);
      const row = [];
      for (const g of [0, 0.5, 1, 2, 4, 8]) {
        await page.evaluate((v) => window.__PROBE__.setDetail(v), g);
        const r = await page.evaluate((x) => window.__PROBE__.measure(x), s0);
        row.push(`x${g} ${num(r.rms, 2)}`);
      }
      await page.evaluate(() => window.__PROBE__.setDetail(1));
      console.log('  ' + pad(k, 30) + row.join('  '));
    }
    console.log('\n  RMS with detail OFF and seam OFF — the irreducible dither + quantisation floor');
    for (const k of keys) {
      const s0 = specs.find((x) => x.key === k);
      await page.evaluate(() => { window.__PROBE__.setDetail(0); window.__PROBE__.setSeam(0); });
      const r = await page.evaluate((x) => window.__PROBE__.measure(x), s0);
      await page.evaluate(() => { window.__PROBE__.setDetail(1); window.__PROBE__.setSeam(0.12); });
      console.log('  ' + pad(k, 30) + num(r.rms));
    }
  }

  /* ---- optional: how the metric moves with viewing distance ---- */
  if (has('--sweep')) {
    console.log('\n  RMS vs viewing distance (the metric is scale-dependent by construction)');
    for (const s of SPECS.filter((x) => x.face === 'PZ')) {
      const row = [];
      for (const dist of [0.8, 1.2, 1.8, 2.6, 3.6, 5.0, 7.0, 10.0]) {
        const spec = await page.evaluate((x) => ({
          ...x, block: window.__PROBE__.BlockId[x.block], face: window.__PROBE__.Face[x.face],
        }), { ...s, dist });
        const r = await page.evaluate((x) => window.__PROBE__.measure(x), spec);
        row.push(`${dist}m ${num(r.rms, 2)}`);
      }
      console.log('  ' + pad(s.key, 30) + row.join('  '));
    }
    for (const s of SPECS.filter((x) => x.face === 'PY')) {
      const row = [];
      for (const pitch of [12, 18, 25, 35, 50, 70]) {
        const spec = await page.evaluate((x) => ({
          ...x, block: window.__PROBE__.BlockId[x.block], face: window.__PROBE__.Face[x.face],
        }), { ...s, pitch });
        const r = await page.evaluate((x) => window.__PROBE__.measure(x), spec);
        row.push(`${pitch}deg ${num(r.rms, 2)}`);
      }
      console.log('  ' + pad(s.key, 30) + row.join('  '));
    }
  }

  /* ---- GPU cost ---- */
  const gpuSpec = { block: await page.evaluate(() => window.__PROBE__.BlockId.STONE), face: 4, dist: 0.9 };
  let flat = null, atlas = null;
  // Three independent sweeps per configuration, reported by their MEDIAN slope.
  // A single sweep on a laptop GPU occasionally picks up a clock or scheduling
  // artefact big enough to move the fit, and a performance claim that turns on
  // which run you kept is not a measurement.
  const sweep3 = async () => {
    const runs = [];
    const n = GPUONLY ? 7 : 3;
    for (let i = 0; i < n; i++) runs.push(await page.evaluate((s) => window.__PROBE__.gpuSweep(s), gpuSpec));
    if (runs.some((r) => r.error)) return runs.find((r) => r.error);
    runs.sort((a, b) => a.msPerMpx - b.msPerMpx);
    return { ...runs[runs.length >> 1], all: runs.map((r) => r.msPerMpx) };
  };
  if (hasTimer) {
    await page.evaluate(() => window.__PROBE__.setTexture(false));
    flat = await sweep3();
    await page.evaluate(() => window.__PROBE__.setTexture(true));
    atlas = await sweep3();
    console.log('\n  fragment cost, pinned camera, full-screen wall');
    for (const [name, r] of [['flat  (no atlas)', flat], ['atlas           ', atlas]]) {
      if (r.error) { console.log(`  ${name}: ${r.error}`); continue; }
      console.log(`  ${name}: ${num(r.msPerMpx)} ms/Mpx   intercept ${num(r.interceptMs)} ms   r2 ${num(r.r2, 4)}`
        + `   3 sweeps ${r.all.map((v) => v.toFixed(3)).join(' / ')}`);
      console.log('      ' + r.points.map((p) => `${p.mpx.toFixed(2)}Mpx ${p.ms.toFixed(3)}ms`).join('  '));
    }
  }

  const tiles = GPUONLY ? [] : await page.evaluate(() => window.__PROBE__.tileStats());
  console.log('\n  atlas tile density (one tile == one block)');
  console.log('  ' + pad('tile', 12) + pad('structure/block', 17) + 'adj-texel MAD (fine detail)');
  for (const t of tiles) {
    if (t.tile === 'PLAIN') continue;
    console.log('  ' + pad(t.tile, 12) + pad(t.featuresPerBlock.toFixed(1), 17) + t.mad.toFixed(4));
  }

  if (SHOTS) {
    for (const s of specs) {
      const url = await page.evaluate((x) => window.__PROBE__.shot(x, 1), s);
      const name = SPECS.find((q) => q.key === s.key).key.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      fs.writeFileSync(path.join(OUT, `probe-${LABEL}-${name}.png`),
        Buffer.from(url.split(',')[1], 'base64'));
    }
    console.log(`\n  wrote ${specs.length} probe shots to shots/probe-${LABEL}-*.png`);
  }

  /* ---- the escape hatch, exercised in the real game, not in the rig ---- */
  let hatch = null;
  if (has('--hatch')) {
    const g = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    g.on('pageerror', (e) => errors.push(e.message));
    g.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await g.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await g.waitForFunction(() => window.__DC__?.ready === true, null, { timeout: 30_000 });
    hatch = await g.evaluate(async () => {
      const dc = window.__DC__;
      const base = { ...dc.game.settings };
      const rows = [];
      for (const [quality, preset] of [
        ['high', 'full'], ['high', 'low'], ['high', 'off'],
        ['low', 'full'], ['medium', 'full'], ['high', 'full'],
      ]) {
        dc.game.applySettings({ ...base, quality, surfaceDetail: preset });
        const u = dc.game.materials.uniforms;
        rows.push({
          quality, preset,
          textureOn: dc.game.materials.textureOn,
          define: dc.game.materials.opaque.defines.USE_TEXTURE ?? 0,
          maxLights: dc.game.materials.opaque.defines.MAX_LIGHTS,
          uDetail: u.uDetail.value,
          uDetailAbs: u.uDetailAbs.value,
          uSeam: u.uSeam.value,
          jitter: [u.uBlockJitter.value.x, u.uBlockJitter.value.y],
        });
      }
      dc.game.applySettings(base);
      return rows;
    });
    console.log('\n  escape hatch (quality tier x surface-detail preset), live in the game');
    console.log('  ' + pad('quality', 9) + pad('preset', 8) + pad('USE_TEXTURE', 13)
      + pad('MAX_LIGHTS', 12) + pad('uDetail', 9) + pad('uDetailAbs', 12) + 'uSeam');
    for (const r of hatch) {
      console.log('  ' + pad(r.quality, 9) + pad(r.preset, 8) + pad(r.define, 13)
        + pad(r.maxLights, 12) + pad(r.uDetail.toFixed(3), 9)
        + pad(r.uDetailAbs.toFixed(3), 12) + r.uSeam.toFixed(3));
    }
    console.log(`  page errors: ${errors.length === 0 ? 'none' : errors.join(' | ')}`);
    await g.close();
  }

  const outFile = path.join(OUT, `surface-${LABEL}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ label: LABEL, gpu: gpuName, bar, ours, tiles, hatch, flat, atlas }, null, 2));
  console.log(`\n  wrote ${outFile}`);

  await browser.close();
  if (serverProc !== null) serverProc.kill('SIGTERM');
}

main().catch((e) => {
  console.error(e);
  if (serverProc !== null) serverProc.kill('SIGTERM');
  process.exit(1);
});
