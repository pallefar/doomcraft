/**
 * The share loop, end to end: boot the REAL server with share_cards forced,
 * FINISH the first tutorial drill through the real game (walk, open the door
 * with E, throw the exit switch, take the pad), and on the intermission click
 * the Share button. Headless chromium has no share sheet, so the button falls
 * back to the download path — the harness catches the download and verifies
 * PNG magic + 1200×630 from the bytes. Also proves the profile Overview's
 * Share panel appears when the probe grants the flag.
 *
 * Run from the repo root:  node tools/shot-share.mjs [--skip-build]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SEED_DEVICE = 'aeaeaeaeaeaeaeaeaeaeaeae';

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

// Seed stats.last so the card is renderable even if this run's reward
// submission lags the click — the UI loop is what this harness proves.
const dataRoot = mkdtempSync(join(tmpdir(), 'dc-share-shot-'));
const shard = join(dataRoot, 'profiles', SEED_DEVICE.slice(0, 2));
mkdirSync(shard, { recursive: true });
writeFileSync(join(shard, `${SEED_DEVICE}.json`), JSON.stringify({
  version: 5, deviceId: SEED_DEVICE, createdMs: Date.now() - 30 * 86_400_000,
  progress: { name: 'Marine', xp: 900 },
  stats: {
    matches: 12,
    last: { ms: Date.now() - 60_000, kills: 9, deaths: 2, won: true, seconds: 285, bestStreak: 4, xp: 210, scrap: 28 },
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
      rules: { online_play: { force: true }, share_cards: { force: true } },
    }),
  },
});
server.stdout?.resume(); server.stderr?.on('data', (d) => process.stderr.write(d));

function pngSize(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  return { w, h };
}

try {
  if (!(await waitForPort(PORT, 60_000))) throw new Error('server did not come up');
  mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
  await page.addInitScript(([id]) => {
    localStorage.setItem('doomcraft:progress:device', id);
  }, [SEED_DEVICE]);

  // 1. The profile Overview grows a Share panel when the probe grants it.
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => window.__DC__.openProfile());
  await page.waitForSelector('.dcp-share', { state: 'visible', timeout: 10_000 });
  await page.screenshot({ path: 'shots/share-profile.png' });
  await page.evaluate(() => window.__DC__.closeProfile());

  // 2. Finish drill one for real: straight south, E for the door and the
  //    switch, then two steps back north onto the armed pad.
  await page.goto(`${ORIGIN}/?mode=quest&level=tut-01-basic-training&skill=1&autoplay=1`);
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });
  await page.mouse.click(720, 450);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    if (document.pointerLockElement === null) window.__DC__.unlockedLook(true);
  });
  await page.waitForFunction(() => window.__DC__.playing === true, null, { timeout: 20_000 });
  await page.waitForTimeout(800);

  await page.keyboard.down('KeyW');
  const deadline = Date.now() + 60_000;
  let done = false;
  while (Date.now() < deadline && !done) {
    await page.waitForTimeout(350);
    await page.keyboard.press('KeyE'); // opens the door, throws the switch
    done = await page.evaluate(() => document.querySelector('.dcqi') !== null);
    if (!done && Math.random() < 0.15) {
      // A knee wall can catch the walk; a hop clears it.
      await page.keyboard.press('Space');
    }
    if (!done) {
      // After the switch arms the exit, the pad is BEHIND us — walk back a
      // beat every few seconds so crossing the armed pad is inevitable.
      const armed = await page.evaluate(() => (document.getElementById('hud')?.textContent ?? '').includes('exit pad hums'));
      if (armed) {
        await page.keyboard.up('KeyW');
        await page.keyboard.down('KeyS');
        await page.waitForTimeout(1600);
        await page.keyboard.up('KeyS');
        await page.keyboard.down('KeyW');
      }
    }
  }
  await page.keyboard.up('KeyW').catch(() => {});
  if (!done) throw new Error('never reached the intermission — the drill was not finished');

  // 3. The intermission carries the Share button; the click downloads a card.
  await page.waitForSelector('.dcqi-actions button:text("Share result")', { state: 'visible', timeout: 10_000 });
  await page.screenshot({ path: 'shots/share-intermission.png' });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.click('.dcqi-actions button:text("Share result")'),
  ]);
  const file = join(tmpdir(), 'dc-share-card.png');
  await download.saveAs(file);
  const bytes = readFileSync(file);
  const size = pngSize(bytes);
  if (size === null || size.w !== 1200 || size.h !== 630) {
    throw new Error(`downloaded card is not a 1200x630 PNG: ${JSON.stringify(size)} (${bytes.length} bytes)`);
  }
  console.log('CARD', bytes.length, 'bytes', JSON.stringify(size));

  await browser.close();
  console.log('OK shots/share-profile.png shots/share-intermission.png');
} finally {
  server.kill('SIGKILL');
}
