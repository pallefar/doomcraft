/**
 * Boot the REAL server with economy_competitions forced, create a REAL
 * tournament through the admin two-phase confirm, then drive the profile
 * overlay's Competitions tab: season + tournament render, Enter through the
 * UI, the roster state appears, the empty standings board says its sentence.
 * The measurement: /api/competitions reads back entered:true.
 *
 * Run from the repo root:  node tools/shot-competitions.mjs [--skip-build]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SEED_DEVICE = 'aeaeaeaeaeaeaeaeaeaeaeae';
const TOKEN = 'competitions-shot-bearer-token-32ch';

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

const dataRoot = mkdtempSync(join(tmpdir(), 'dc-comp-shot-'));
const shard = join(dataRoot, 'profiles', SEED_DEVICE.slice(0, 2));
mkdirSync(shard, { recursive: true });
writeFileSync(join(shard, `${SEED_DEVICE}.json`), JSON.stringify({
  version: 5, deviceId: SEED_DEVICE, createdMs: Date.now() - 30 * 86_400_000,
  progress: { name: 'Marine', xp: 4200 },
  stats: { matches: 20 },
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
    DOOMCRAFT_ADMIN_TOKEN: TOKEN,
    DOOMCRAFT_CONFIRM_DELAY_MS: '50',
    DOOMCRAFT_FLAGS: JSON.stringify({
      rules: { online_play: { force: true }, economy_competitions: { force: true } },
    }),
  },
});
server.stdout?.resume(); server.stderr?.on('data', (d) => process.stderr.write(d));

async function admin(path, body) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

try {
  if (!(await waitForPort(PORT, 60_000))) throw new Error('server did not come up');

  // A real tournament, through the real confirm walk.
  const create = {
    name: 'Friday Skirmish', kind: 'tournament',
    endMs: Date.now() + 3 * 86_400_000, scrapByRank: [300, 150],
    actor: 'harness', reason: 'competitions tab proof harness tournament',
  };
  const first = await admin('/api/admin/competitions/create', create);
  if (first.status !== 428) throw new Error(`expected 428 confirm, got ${first.status}: ${JSON.stringify(first.body)}`);
  await new Promise((r) => setTimeout(r, 120));
  const second = await admin('/api/admin/competitions/create', { ...create, confirm: first.body.confirmToken });
  if (second.status !== 200 && second.status !== 201) throw new Error(`tournament create refused: ${second.status} ${JSON.stringify(second.body)}`);
  console.log('TOURNAMENT', JSON.stringify(second.body).slice(0, 120));

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
  await page.waitForSelector('.dcc-box', { timeout: 10_000 });

  const text = () => page.evaluate(() => document.querySelector('.dcc').textContent);
  const before = await text();
  for (const needle of ['Season', 'Friday Skirmish', 'Tournament', '1st place 300 Scrap']) {
    if (!before.includes(needle)) throw new Error(`competitions tab missing "${needle}" — ${before.slice(0, 400)}`);
  }

  // Enter the tournament through the UI…
  await page.locator('.dcc-box', { hasText: 'Friday Skirmish' }).locator('button:text-is("Enter")').click();
  await page.waitForFunction(() => document.querySelector('.dcc').textContent.includes('on the roster'), null, { timeout: 10_000 });

  // …expand the empty board and see the honest sentence.
  await page.locator('.dcc-box', { hasText: 'Friday Skirmish' }).locator('button:text-is("Standings")').click();
  await page.waitForFunction(() => document.querySelector('.dcc').textContent.includes('first paying match'), null, { timeout: 10_000 });
  await page.screenshot({ path: 'shots/competitions-tab.png' });

  // THE MEASUREMENT: the server says entered.
  const res = await fetch(`${ORIGIN}/api/competitions?device=${SEED_DEVICE}`);
  const body = await res.json();
  const tourney = body.competitions.find((c) => c.name === 'Friday Skirmish');
  if (tourney?.entered !== true) throw new Error(`server does not say entered: ${JSON.stringify(body.competitions)}`);
  console.log('ENTERED', JSON.stringify(tourney));

  await browser.close();
  console.log('OK shots/competitions-tab.png');
} finally {
  server.kill('SIGKILL');
}
