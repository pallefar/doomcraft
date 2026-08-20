/**
 * Mode-switch loop — the leak check for the mode layer.
 *
 *   node tools/mode-loop.mjs                 # 3 rounds of all four modes
 *   node tools/mode-loop.mjs --rounds 6
 *   node tools/mode-loop.mjs --headed --throttle 4
 *
 * Four modes share one renderer, one net client, one `#hud` and one frame loop,
 * so the only thing that makes switching safe is that a mode's teardown is
 * exactly the inverse of its setup. This drives the real build through
 * `window.__DC__.enterMode()` / `leaveMode()` over and over and asserts, after
 * every single exit, that:
 *
 *   - the mode scope is EMPTY: zero live teardowns, zero listeners, zero
 *     timers, zero scene objects, zero workers, zero elements, zero errors;
 *   - `three`'s scene child count is back to the baseline the shell booted
 *     with — a mode that forgets an Object3D shows up here even if its own
 *     ledger looks clean;
 *   - `#hud` and `#ui` child counts are back to baseline, so no orphan panel;
 *   - the renderer's own resource counters (geometries, textures, programs)
 *     have not grown round over round, which is the leak a scope ledger cannot
 *     see because three caches those globally;
 *   - the page has logged no new errors.
 *
 * Exit code 0 means clean. Anything else prints what grew and by how much.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const ROUNDS = Math.max(1, Number(val('--rounds', '3')));
const HEADED = has('--headed');
const THROTTLE = Number(val('--throttle', '1'));
const PORT = Number(val('--port', '5173'));
const URL = val('--url', `http://localhost:${PORT}/`);
const NO_SERVE = has('--no-serve');
/** Seconds each mode is left running before it is torn down again. */
const DWELL_MS = Number(val('--dwell', '1400'));

const MODES = ['quest', 'builder', 'horde', 'deathmatch'];

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(700, () => { s.destroy(); resolve(false); });
  });
}

async function waitForPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let serverProc = null;

async function ensureServer() {
  if (await portOpen(PORT)) { log(`SERVER already up on :${PORT}`); return; }
  if (NO_SERVE) throw new Error(`nothing listening on :${PORT} and --no-serve was passed`);
  serverProc = spawn('npx', ['vite', '--config', 'client/vite.config.ts', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  if (!(await waitForPort(PORT, 90_000))) throw new Error('vite did not come up');
  await new Promise((r) => setTimeout(r, 400));
}

function stopServer() {
  if (serverProc !== null) {
    try { serverProc.kill('SIGTERM'); } catch { /* already gone */ }
    serverProc = null;
  }
}

/** Everything we compare between "before any mode" and "after every mode". */
const SNAPSHOT = () => {
  const dc = window.__DC__;
  const g = dc.game;
  const info = g.renderer.renderer?.info ?? { memory: { geometries: -1, textures: -1 }, programs: null };
  return {
    scope: dc.modeScope(),
    activeKey: dc.modeKey,
    sceneChildren: g.renderer.scene.children.length,
    hudChildren: document.getElementById('hud').childElementCount,
    uiChildren: document.getElementById('ui').childElementCount,
    styleTags: document.head.querySelectorAll('style').length,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : -1,
    overlays: g.renderer.overlays ? g.renderer.overlays.length : -1,
    workers: g.chunks.stats.workerCount,
    listeners: 0,
  };
};

function diff(base, now, keys) {
  const out = {};
  for (const k of keys) if (base[k] !== now[k]) out[k] = `${base[k]} -> ${now[k]}`;
  return out;
}

async function main() {
  await ensureServer();

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));

  const cdp = await context.newCDPSession(page);
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true,
    null, { timeout: 60_000 });
  // Let the world finish streaming so the baseline is a settled scene, not a
  // half-loaded one that would keep growing on its own.
  await page.waitForTimeout(2500);

  const baseline = await page.evaluate(SNAPSHOT);
  log('BASELINE ' + JSON.stringify(baseline));

  const COMPARE = [
    'sceneChildren', 'hudChildren', 'uiChildren', 'styleTags',
    'overlays', 'workers',
  ];
  const GROWTH = ['geometries', 'textures', 'programs'];

  const failures = [];
  const rows = [];
  let prevGrowth = null;

  for (let round = 1; round <= ROUNDS; round++) {
    for (const mode of MODES) {
      const t0 = Date.now();
      const got = await page.evaluate((m) => window.__DC__.enterMode(m), mode);
      if (got !== mode) failures.push(`round ${round}: enterMode("${mode}") landed in "${got}"`);
      await page.waitForTimeout(DWELL_MS);

      const inside = await page.evaluate(SNAPSHOT);
      await page.evaluate(() => window.__DC__.leaveMode());
      await page.waitForTimeout(350);
      const after = await page.evaluate(SNAPSHOT);

      const s = after.scope;
      const dirty = s.live || s.listeners || s.timers || s.objects || s.workers || s.elements || s.errors;
      if (dirty) failures.push(`round ${round} ${mode}: scope not empty after exit ${JSON.stringify(s)}`);

      const d = diff(baseline, after, COMPARE);
      if (Object.keys(d).length > 0) failures.push(`round ${round} ${mode}: ${JSON.stringify(d)}`);

      rows.push({
        round, mode, ms: Date.now() - t0,
        heldWhileLive: inside.scope.live,
        afterScope: s,
        afterCounts: { scene: after.sceneChildren, hud: after.hudChildren, ui: after.uiChildren, styles: after.styleTags },
        gpu: { geometries: after.geometries, textures: after.textures, programs: after.programs },
      });
      log(`round ${round} ${mode.padEnd(10)} live=${String(inside.scope.live).padStart(3)} `
        + `after=${JSON.stringify(s)} scene=${after.sceneChildren} hud=${after.hudChildren} `
        + `ui=${after.uiChildren} styles=${after.styleTags} geo=${after.geometries} tex=${after.textures}`);
    }

    // three caches geometries/textures/programs globally, so a per-round
    // comparison is the only way to see a leak the scope ledger cannot.
    const now = await page.evaluate(SNAPSHOT);
    if (prevGrowth !== null) {
      const g = diff(prevGrowth, now, GROWTH);
      if (Object.keys(g).length > 0) {
        failures.push(`round ${round}: GPU resources grew round over round ${JSON.stringify(g)}`);
      }
    }
    prevGrowth = now;
  }

  const newErrors = errors.filter((e) => !e.includes('404'));
  if (newErrors.length > 0) failures.push(`page errors: ${JSON.stringify(newErrors.slice(0, 6))}`);

  const report = {
    rounds: ROUNDS,
    modes: MODES,
    dwellMs: DWELL_MS,
    headed: HEADED,
    cpuThrottle: THROTTLE,
    baseline,
    rows,
    failures,
    clean: failures.length === 0,
  };
  fs.writeFileSync(path.join(OUT, 'ours-mode-loop.json'), JSON.stringify(report, null, 2));

  await page.screenshot({ path: path.join(OUT, 'ours-mode-loop-final.png') });
  await browser.close();
  stopServer();

  if (failures.length === 0) {
    log(`\nCLEAN — ${ROUNDS} rounds x ${MODES.length} modes, every scope empty on exit, `
      + 'no scene/DOM/GPU growth.');
    process.exit(0);
  }
  log('\nDIRTY:');
  for (const f of failures) log('  - ' + f);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
