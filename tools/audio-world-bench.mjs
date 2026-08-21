/**
 * DOOMCRAFT — world-audio cost bench.
 *
 * `tools/audio-bench.mjs` measures the WEAPON side of the audio layer in
 * Deathmatch, where there are no monsters, no level palette and nothing for the
 * music to react to. This one measures the other half: enemy vocalisations, the
 * ambience bed and the intensity sequencer, in Horde, which is the mode that
 * puts thirty monsters and a rising threat curve in front of the player at once.
 *
 * One question, the same one: does it cost frames?
 *
 *   node tools/audio-world-bench.mjs [--port 5173] [--seconds 30] [--tag name]
 *   node tools/audio-world-bench.mjs --off --tag before   (world audio disabled)
 *
 * `--off` is the control. It leaves every other system exactly as it is and
 * stops the three world layers being updated, so the difference between the two
 * runs is this feature and nothing else.
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
const OFF = has('--off');
const SPLIT = has('--split');
const TAG = arg('--tag', OFF ? 'world-off' : 'world-on');
const SECONDS = Number(arg('--seconds', '30'));
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

const lines = [];
const log = (s) => { console.log(s); lines.push(s); };

await serve();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => window.__DC__?.ready === true, null, { timeout: 90_000 });

await page.evaluate(() => window.__DC__.enterMode('horde', { level: '', skill: 2 }));
const box = await page.locator('#game').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.click(cx, cy);
await page.evaluate(() => { if (document.pointerLockElement === null) window.__DC__.unlockedLook(true); });
await page.waitForFunction(() => window.__DC__.playing === true, null, { timeout: 30_000 });

if (OFF) {
  await page.evaluate(() => window.__DC__.audioWorldEnabled(false));
  log('[bench] world audio DISABLED (control run)');
}

// Let the wave director spin up and the bakes land before measuring.
await page.waitForTimeout(4000);

/**
 * Drive combat for `secs` and return the samples.
 *
 * Both halves of a `--split` run happen in ONE page, in one world, against one
 * wave director. Comparing two separate processes compared two different maps:
 * the first attempt measured 143 draw calls in the control run and 57 in the
 * test run, which is not a 2.5x saving from an audio feature, it is two
 * different rooms.
 */
async function drive(secs) {
  const out = [];
  const start = Date.now();
  while ((Date.now() - start) / 1000 < secs) {
    await page.mouse.down();
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(cx + (i % 2 ? 110 : -110), cy + (i % 3 ? 24 : -24));
      await page.waitForTimeout(130);
    }
    await page.mouse.up();
    await page.keyboard.press('r');
    await page.waitForTimeout(160);
    out.push(await page.evaluate(() => ({
      medianMs: window.__DC__.stats().medianMs,
      entities: window.__DC__.stats().entities,
      drawCalls: window.__DC__.stats().drawCalls,
      world: window.__DC__.audioWorld ? window.__DC__.audioWorld() : null,
    })));
  }
  return out;
}

let samples;
if (SPLIT) {
  const on = await drive(SECONDS / 2);
  await page.evaluate(() => window.__DC__.audioWorldEnabled(false));
  await page.waitForTimeout(1200);
  const off = await drive(SECONDS / 2);
  const m = (a) => { const s2 = [...a].sort((x, y) => x - y); return s2[Math.floor(s2.length / 2)]; };
  log(`SPLIT_ON_MEDIAN_MS  ${m(on.map((s2) => s2.medianMs)).toFixed(3)}  (n=${on.length}, draws ${m(on.map((s2) => s2.drawCalls))})`);
  log(`SPLIT_OFF_MEDIAN_MS ${m(off.map((s2) => s2.medianMs)).toFixed(3)}  (n=${off.length}, draws ${m(off.map((s2) => s2.drawCalls))})`);
  log(`SPLIT_DELTA_MS      ${(m(on.map((s2) => s2.medianMs)) - m(off.map((s2) => s2.medianMs))).toFixed(3)}`);
  samples = on.concat(off);
} else {
  samples = await drive(SECONDS);
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const max = (a) => a.reduce((m, v) => (v > m ? v : m), 0);
const final = await page.evaluate(() => ({
  stats: window.__DC__.stats(),
  audio: window.__DC__.audioStats ? window.__DC__.audioStats() : null,
  world: window.__DC__.audioWorld ? window.__DC__.audioWorld() : null,
}));

log(`TAG                 ${TAG}`);
log(`SAMPLES             ${samples.length}`);
log(`MEDIAN_MS           ${med(samples.map((s) => s.medianMs)).toFixed(3)}`);
log(`MEDIAN_MS_FINAL     ${final.stats.medianMs.toFixed(3)}`);
log(`ONE_PCT_LOW_FPS     ${final.stats.onePctLowFps}`);
log(`DRAW_CALLS          ${final.stats.drawCalls}`);
log(`PEAK_ENTITIES       ${max(samples.map((s) => s.entities))}`);
if (final.audio) log(`AUDIO               ${JSON.stringify(final.audio)}`);
if (final.world) log(`WORLD               ${JSON.stringify(final.world)}`);
const worlds = samples.map((s2) => s2.world).filter(Boolean);
if (worlds.length) {
  log(`THREAT_MAX          ${max(worlds.map((w) => w.musicThreat)).toFixed(3)}`);
  log(`TIER_MAX            ${max(worlds.map((w) => w.musicTier))}`);
  log(`MONSTER_VOICES_MAX  ${max(worlds.map((w) => w.monsterVoices))}`);
  log(`TIERS_SEEN          ${JSON.stringify([...new Set(worlds.map((w) => w.musicTier))].sort())}`);
}
if (errors.length) log(`ERRORS              ${JSON.stringify(errors.slice(0, 6), null, 1)}`);

fs.mkdirSync(path.join(ROOT, 'progress'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'progress', `audio-world-bench-${TAG}.txt`), lines.join('\n') + '\n');
await browser.close();
if (proc) proc.kill('SIGTERM');
process.exit(0);
