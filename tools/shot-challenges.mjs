/**
 * Boot the REAL server with economy_competitions forced and a profile seeded
 * with CURRENT-period challenge progress, then drive the profile overlay's
 * Competitions tab and prove the Challenges section renders the truth: a
 * live progress bar, a done row, the item half of a reward, and the
 * teaching note. The measurement: /api/challenges reads back the same
 * numbers the DOM shows.
 *
 * Run from the repo root:  node tools/shot-challenges.mjs [--skip-build]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SEED_DEVICE = 'aeaeaeaeaeaeaeaeaeaeaeae';

/* UTC period keys, the shared/src/challenges.ts definitions restated for a
 * harness that cannot import TS. */
function utcDayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function utcWeekKey(ms) {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monBased = (new Date(midnight).getUTCDay() + 6) % 7;
  const thursday = midnight + (3 - monBased) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function waitForPort(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > until) resolve(false); else setTimeout(probe, 250);
      });
    };
    probe();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

if (!process.argv.includes('--skip-build') || !existsSync('dist/index.html')) {
  console.log('building dist…');
  const build = spawn('npx', ['vite', 'build', '--config', 'client/vite.config.ts'], { stdio: 'inherit' });
  const code = await new Promise((r) => build.on('close', r));
  if (code !== 0) throw new Error(`vite build exited ${code}`);
}

const dataRoot = mkdtempSync(join(tmpdir(), 'dc-chal-shot-'));
const shard = join(dataRoot, 'profiles', SEED_DEVICE.slice(0, 2));
mkdirSync(shard, { recursive: true });
writeFileSync(join(shard, `${SEED_DEVICE}.json`), JSON.stringify({
  version: 6, deviceId: SEED_DEVICE, createdMs: Date.now() - 30 * 86_400_000,
  progress: { name: 'Marine', xp: 4200 },
  stats: { matches: 20 },
  challenges: {
    day: utcDayKey(Date.now()), week: utcWeekKey(Date.now()),
    counts: { 'daily.kill-25': 10, 'weekly.streak-8': 5 },
    done: ['daily.win-1'],
  },
}), 'utf8');

const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1',
    DOOMCRAFT_STATIC: 'dist', DOOMCRAFT_DATA: dataRoot,
    DOOMCRAFT_BOTS: '0', DOOMCRAFT_PREWARM: '0',
    DOOMCRAFT_FLAGS: JSON.stringify({
      rules: { online_play: { force: true }, economy_competitions: { force: true } },
    }),
  },
});
server.stdout?.resume(); server.stderr?.on('data', (d) => process.stderr.write(d));

try {
  if (!(await waitForPort(PORT, 60_000))) throw new Error('server did not come up');

  mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
  await page.addInitScript(([id]) => {
    localStorage.setItem('doomcraft:progress:device', id);
  }, [SEED_DEVICE]);

  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => window.__DC__.openProfile());
  await page.waitForSelector('.dcp-tabs.is-shown', { timeout: 10_000 });
  await page.click('.dcp-tab:text("Competitions")');
  await page.waitForSelector('.dcc-chhead', { timeout: 10_000 });

  const text = await page.evaluate(() => document.querySelector('.dcc').textContent);
  for (const needle of [
    'Challenges',
    'Exterminator', '10 / 25',            // live daily progress
    'Take the Day', 'done',               // the paid daily renders as done
    '100 Scrap + Knee-Deep',              // the item half, named
    'midnight UTC', 'online matches only', // the teaching note
  ]) {
    if (!text.includes(needle)) throw new Error(`challenges section missing "${needle}" — ${text.slice(0, 500)}`);
  }

  // A real bar, not a zeroed one: the kill daily's fill is ~40% wide.
  const widths = await page.$$eval('.dcc-ch-bar i', (els) => els.map((e) => e.style.width));
  if (!widths.includes('40%')) throw new Error(`expected a 40% bar among ${JSON.stringify(widths)}`);

  await page.screenshot({ path: 'shots/challenges-tab.png' });

  // THE MEASUREMENT: the wire says what the DOM shows.
  const res = await fetch(`${ORIGIN}/api/challenges?device=${SEED_DEVICE}`);
  const body = await res.json();
  const kill = body.challenges.find((c) => c.id === 'daily.kill-25');
  const win = body.challenges.find((c) => c.id === 'daily.win-1');
  if (kill?.progress !== 10) throw new Error(`wire progress wrong: ${JSON.stringify(kill)}`);
  if (win?.done !== true) throw new Error(`wire done wrong: ${JSON.stringify(win)}`);
  console.log('WIRE', JSON.stringify({ kill: kill.progress, winDone: win.done }));

  await browser.close();
  console.log('OK shots/challenges-tab.png');
} finally {
  server.kill('SIGKILL');
}
