/**
 * Boot the REAL built bundle straight into the first tutorial drill
 * (?mode=quest&level=tut-01-basic-training) and prove the coaching actually
 * fires: the episode description reaches the HUD feed, and WALKING into the
 * first lesson region flashes its message. A tutorial whose text cannot fire
 * teaches nobody — this is the runtime half of shared/src/tutorial.test.ts.
 *
 * Run from the repo root:  node tools/shot-tutorial.mjs [--skip-build]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

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

const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1',
    DOOMCRAFT_STATIC: 'dist', DOOMCRAFT_DATA: mkdtempSync(join(tmpdir(), 'dc-tut-')),
    DOOMCRAFT_BOTS: '0', DOOMCRAFT_PREWARM: '0',
  },
});
server.stdout?.resume(); server.stderr?.resume();

try {
  if (!(await waitForPort(PORT, 60_000))) throw new Error('server did not come up');
  mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));

  await page.goto(`${ORIGIN}/?mode=quest&level=tut-01-basic-training&skill=1&autoplay=1`);
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });
  await page.mouse.click(720, 450);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    if (document.pointerLockElement === null) window.__DC__.unlockedLook(true);
  });
  await page.waitForFunction(() => window.__DC__.playing === true, null, { timeout: 20_000 });
  await page.waitForTimeout(1200);

  // The episode description must reach the HUD feed. Polled, not one-shot:
  // the feed line lands a beat after `playing` flips and scrolls away later.
  const hud = () => page.evaluate(() => document.getElementById('hud')?.textContent ?? '');
  let described = false;
  for (let i = 0; i < 25 && !described; i++) {
    described = (await hud()).includes('Boot camp');
    if (!described) await page.waitForTimeout(200);
  }
  if (!described) {
    throw new Error(`the level description never reached the feed — HUD says: ${(await hud()).slice(0, 300)}`);
  }

  // Walk south (spawn faces the corridor) into the l-move lesson region.
  await page.keyboard.down('KeyW');
  let flashed = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(200);
    const text = await hud();
    if (text.includes('Move with W A S D')) { flashed = true; break; }
  }
  await page.keyboard.up('KeyW');
  if (!flashed) throw new Error(`walked 6 seconds and the first lesson never flashed — HUD: ${(await hud()).slice(0, 300)}`);
  await page.screenshot({ path: 'shots/tutorial-drill.png' });

  await browser.close();
  console.log('OK shots/tutorial-drill.png — description in feed, first lesson flashed on walk-in');
} finally {
  server.kill('SIGKILL');
}
