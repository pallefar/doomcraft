/**
 * Boot the REAL server serving the REAL built bundle, with a seeded inventory
 * and the economy flags forced, then drive the profile overlay to the Loadout
 * tab, EQUIP a skin through the UI, and prove the claim landed server-side by
 * reading /api/profile back. Screenshots are the visible half of the proof;
 * the read-back is the measurement (rule 3).
 *
 * Run from the repo root:  node tools/shot-loadout.mjs [--skip-build]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SEED_DEVICE = 'aeaeaeaeaeaeaeaeaeaeaeae';
const RUST = 'items@1:skin-rust-marine';
const EMBER = 'items@1:skin-ember-core';
const HAZARD = 'items@1:skin-void-hazard';
const TITLE = 'items@1:title-hangar-rat';
const RETIRED = 'items@1:trail-retired'; // not in the live pack -> dormant

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

// 1. The bundle — the same bytes production serves.
if (!process.argv.includes('--skip-build') || !existsSync('dist/index.html')) {
  console.log('building dist…');
  const build = spawn('npx', ['vite', 'build', '--config', 'client/vite.config.ts'], { stdio: 'inherit' });
  const code = await new Promise((r) => build.on('close', r));
  if (code !== 0) throw new Error(`vite build exited ${code}`);
}

// 2. Seed a profile with the states the tab must render: duplicates (x2),
//    a second active skin, a title, a dormant ref, a revoked ref, a balance.
const dataRoot = mkdtempSync(join(tmpdir(), 'dc-loadout-data-'));
const shard = join(dataRoot, 'profiles', SEED_DEVICE.slice(0, 2));
mkdirSync(shard, { recursive: true });
writeFileSync(join(shard, `${SEED_DEVICE}.json`), JSON.stringify({
  version: 5, deviceId: SEED_DEVICE, createdMs: Date.now() - 30 * 86_400_000,
  progress: { name: 'Marine', xp: 4200, kills: 300, deaths: 120, wins: 22, gamesPlayed: 60 },
  economy: { scrap: 860, lifetimeScrap: 1200, day: '', dayXp: 0, dayScrap: 0, dayMatches: 0 },
  inventory: {
    // Four rust copies: enough to craft (3) with one left over, so the
    // crafting arc below is provable from this seed alone.
    items: [RUST, RUST, RUST, RUST, EMBER, TITLE, RETIRED, HAZARD]
      .map((ref) => ({ ref, ms: 1_700_000_000_000, source: 'drop', sourceId: 'seed' })),
    equippedSkin: '', title: '',
  },
  moderation: { banned: false, bannedUntilMs: 0, reason: '', revokedItems: [{ ref: EMBER, ms: 2, reason: 'seeded take-back' }] },
}), 'utf8');

// 3. The real server, flags forced the way production will be after the flip.
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
      rules: {
        online_play: { force: true },
        economy_scrap: { force: true },
        economy_items: { force: true },
      },
    }),
  },
});
server.stdout?.resume(); server.stderr?.on('data', (d) => process.stderr.write(d));

try {
  if (!(await waitForPort(PORT, 60_000))) throw new Error('server did not come up');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
  await page.addInitScript(([id]) => {
    localStorage.setItem('doomcraft:progress:device', id);
  }, [SEED_DEVICE]);

  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });

  // 4. Open the profile; the strip must APPEAR (a capture that can fail).
  await page.evaluate(() => window.__DC__.openProfile());
  await page.waitForFunction(() => window.__DC__.profileOpen === true, null, { timeout: 10_000 });
  await page.waitForSelector('.dcp-tabs.is-shown', { timeout: 10_000 });
  const screen = await page.evaluate(() => window.__DC__.screen);
  if (screen !== 'menu') throw new Error(`overlay must not be a screen; screen=${screen}`);

  // 5. Into the Loadout tab; the seeded rows must actually render.
  await page.click('.dcp-tab:text("Loadout")');
  await page.waitForSelector('.dcl-sec', { timeout: 10_000 });
  const text = await page.evaluate(() => document.querySelector('.dcl').textContent);
  for (const needle of ['×4', 'Rust Marine', 'Hangar Rat', 'revoked', 'not in the current items pack', '860']) {
    if (!text.includes(needle)) throw new Error(`loadout tab is missing "${needle}" — rendered: ${text.slice(0, 400)}`);
  }
  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: 'shots/loadout-tab.png' });

  // 6. Equip through the UI…
  const rustRow = page.locator('.dcl-row', { hasText: 'Rust Marine' });
  await rustRow.locator('button:text-is("Equip")').click();
  await page.waitForSelector('.dcl-on', { timeout: 10_000 });
  await page.screenshot({ path: 'shots/loadout-equipped.png' });

  // 7. …and prove the claim landed SERVER-side, not merely on the screen.
  const res = await fetch(`${ORIGIN}/api/profile?device=${SEED_DEVICE}`);
  const body = await res.json();
  const claims = body.profile?.inventory;
  if (claims?.equippedSkin !== RUST) {
    throw new Error(`equip did not persist: server says ${JSON.stringify(claims)}`);
  }
  console.log('SERVER CLAIMS', JSON.stringify(claims));

  // 8. The trade-up: open the picker on the rust row, pay 50 Scrap for the
  //    chosen uncommon, and prove the swap server-side.
  await page.locator('.dcl-row', { hasText: 'Rust Marine' }).locator('button:text-is("Craft up")').click();
  await page.waitForSelector('.dcl-craft', { timeout: 10_000 });
  const pitch = await page.evaluate(() => document.querySelector('.dcl-craft').textContent);
  if (!pitch.includes('no rolls, no boxes')) throw new Error(`craft panel pitch missing: ${pitch.slice(0, 200)}`);
  await page.screenshot({ path: 'shots/loadout-craft.png' });
  await page.locator('.dcl-craft .dcl-row', { hasText: 'Void Hazard' }).locator('button').click();
  await page.waitForSelector('.dcl-flash', { timeout: 15_000 });
  await page.screenshot({ path: 'shots/loadout-crafted.png' });

  const after = await (await fetch(`${ORIGIN}/api/profile?device=${SEED_DEVICE}`)).json();
  const refs = after.profile.inventory.items.map((i) => i.ref);
  const rustLeft = refs.filter((r) => r === RUST).length;
  const hazards = refs.filter((r) => r === HAZARD).length;
  const scrap = after.profile.economy.scrap;
  if (rustLeft !== 1 || hazards !== 2 || scrap !== 810) {
    throw new Error(`craft did not settle: rust=${rustLeft} hazard=${hazards} scrap=${scrap}`);
  }
  console.log('CRAFTED', JSON.stringify({ rustLeft, hazards, scrap }));

  await browser.close();
  console.log('OK shots/loadout-tab.png shots/loadout-equipped.png shots/loadout-craft.png shots/loadout-crafted.png');
} finally {
  server.kill('SIGKILL');
}
