/**
 * DOOMCRAFT — audio cost bench.
 *
 * One question: does the audio layer cost frames? It drives a fixed 25 s
 * combat script (all seven weapons, sustained automatic fire, rockets, block
 * edits) and reports the renderer's own medianMs over that window, plus the
 * audio engine's voice statistics when it is present.
 *
 * Run it once with --silent (audio muted at the source, so every scheduling
 * call still happens but nothing is synthesised) and once without, or before
 * and after the feature, and compare.
 *
 *   node tools/audio-bench.mjs [--port 5173] [--silent] [--tag name]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const PORT = Number(arg('--port', '5173'));
const TAG = arg('--tag', has('--silent') ? 'silent' : 'audio');
const SECONDS = Number(arg('--seconds', '25'));
const URL = `http://localhost:${PORT}/`;

const portOpen = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 800);
});

let proc = null;
async function serve() {
  if (await portOpen(PORT)) { console.log(`[bench] server already up on :${PORT}`); return; }
  proc = spawn('npx', ['vite', '--config', 'client/vite.config.ts', '--port', String(PORT)],
    { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    if (await portOpen(PORT)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('vite did not come up');
}

const b = [];
const log = (s) => { console.log(s); b.push(s); };

await serve();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
    '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => window.__DC__?.ready === true, null, { timeout: 90_000 });

await page.evaluate(() => window.__DC__.enterMode('deathmatch', { level: '', skill: 2 }));
const box = await page.locator('#game').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.click(cx, cy);
await page.evaluate(() => { if (document.pointerLockElement === null) window.__DC__.unlockedLook(true); });
await page.waitForFunction(() => window.__DC__.playing === true, null, { timeout: 20_000 });
await page.waitForTimeout(1500);

if (has('--silent') && await page.evaluate(() => typeof window.__DC__.audioSilence === 'function')) {
  await page.evaluate(() => window.__DC__.audioSilence(true));
  log('[bench] audio scheduling ON, synthesis muted at source');
}

// Settle, then measure.
await page.waitForTimeout(1200);
await page.evaluate(() => 0);

const samples = [];
const t0 = Date.now();
let slot = 1;
while ((Date.now() - t0) / 1000 < SECONDS) {
  // Cycle weapons and hold fire: this is the audio-heaviest thing the game does.
  await page.keyboard.press(String(slot));
  slot = slot % 7 + 1;
  await page.mouse.down();
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx + (i % 2 ? 90 : -90), cy + (i % 3 ? 20 : -20));
    await page.waitForTimeout(120);
  }
  await page.mouse.up();
  await page.keyboard.press('r');
  await page.waitForTimeout(150);
  samples.push(await page.evaluate(() => ({
    medianMs: window.__DC__.stats().medianMs,
    audio: window.__DC__.audioStats ? window.__DC__.audioStats() : null,
  })));
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const finalStats = await page.evaluate(() => ({
  stats: window.__DC__.stats(),
  audio: window.__DC__.audioStats ? window.__DC__.audioStats() : null,
}));

log(`TAG                 ${TAG}`);
log(`SAMPLES             ${samples.length}`);
log(`MEDIAN_MS           ${med(samples.map((s) => s.medianMs)).toFixed(3)}`);
log(`MEDIAN_MS_FINAL     ${finalStats.stats.medianMs.toFixed(3)}`);
log(`ONE_PCT_LOW_FPS     ${finalStats.stats.onePctLowFps}`);
log(`DRAW_CALLS          ${finalStats.stats.drawCalls}`);
if (finalStats.audio) log(`AUDIO               ${JSON.stringify(finalStats.audio)}`);
if (errors.length) log(`ERRORS              ${JSON.stringify(errors.slice(0, 6), null, 1)}`);

fs.mkdirSync(path.join(ROOT, 'progress'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'progress', `audio-bench-${TAG}.txt`), b.join('\n') + '\n');
await browser.close();
if (proc) proc.kill('SIGTERM');
process.exit(0);
