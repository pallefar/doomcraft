/**
 * Boot the real server with an env bearer, load /admin in a real browser,
 * and screenshot the console screens — the proof harness for console
 * changes (a green console.test.ts cannot see a screen that renders
 * nothing). Usage: node tools/shot-console.mjs [tab ...]
 * Defaults to the C6.1 screens: referrals + player.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'console-shot-bearer-token-32-chars-x';
const TABS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['referrals', 'player'];

function freePort() {
  return new Promise((done, fail) => {
    const probe = net.createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => done(port));
    });
  });
}

const port = await freePort();
const staticRoot = mkdtempSync(join(tmpdir(), 'dc-console-static-'));
const dataRoot = mkdtempSync(join(tmpdir(), 'dc-console-data-'));
writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
// A player with history, so the Players screen has something to say.
const DEVICE = 'adadadadadadadadadadadad';
const shard = join(dataRoot, 'profiles', DEVICE.slice(0, 2));
mkdirSync(shard, { recursive: true });
writeFileSync(join(shard, `${DEVICE}.json`), JSON.stringify({
  version: 5, deviceId: DEVICE, createdMs: 1_700_000_000_000,
  progress: { xp: 4200, gamesPlayed: 62 },
  economy: { scrap: 380, lifetimeScrap: 1240, day: '2026-08-28', dayXp: 0, dayScrap: 0, dayMatches: 0 },
}), 'utf8');

const child = spawn(process.execPath, ['--import', 'tsx', join(here, '..', 'server', 'src', 'index.ts')], {
  cwd: join(here, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1',
    DOOMCRAFT_STATIC: staticRoot, DOOMCRAFT_DATA: dataRoot,
    DOOMCRAFT_BOTS: '0', DOOMCRAFT_PREWARM: '0',
    DOOMCRAFT_ADMIN_TOKEN: TOKEN,
  },
});
child.stdout?.resume(); child.stderr?.resume();

try {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    if (Date.now() > deadline) throw new Error('server did not start');
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) { await res.text(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setExtraHTTPHeaders({ authorization: `Bearer ${TOKEN}` });
  await page.addInitScript((tok) => { localStorage.setItem('dc.admin.token', tok); }, TOKEN);
  await page.goto(`${origin}/admin`);
  await page.waitForSelector('#tabs', { timeout: 20_000 });
  await page.waitForTimeout(1200);

  for (const tab of TABS) {
    await page.click(`#btn-${tab}`);
    if (tab === 'player') {
      await page.fill('#player-key', DEVICE);
      await page.click('#player-go');
    }
    await page.waitForTimeout(900);
    await page.screenshot({ path: `shots/console-${tab}.png`, fullPage: true });
    console.log(`shots/console-${tab}.png`);
  }
  await browser.close();
} finally {
  child.kill('SIGKILL');
}
