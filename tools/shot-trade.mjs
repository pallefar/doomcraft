/**
 * Two REAL browsers trade with each other over the REAL server: open → code →
 * join → offer both sides → confirm both → settled, driven entirely through
 * the Trade tab UI. The measurement: both inventories read back through
 * /api/profile with the items swapped. Screenshots at the waiting, active and
 * settled states.
 *
 * Run from the repo root:  node tools/shot-trade.mjs [--skip-build]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const ALFA = 'aeaeaeaeaeaeaeaeaeaeaeae';
const BRAVO = 'bebebebebebebebebebebebe';
const RUST = 'items@1:skin-rust-marine';
const EMBER = 'items@1:skin-ember-core';
const COOLDOWN_MS = 48 * 3_600_000;

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

const dataRoot = mkdtempSync(join(tmpdir(), 'dc-trade-shot-'));
function seed(device, refs) {
  const shard = join(dataRoot, 'profiles', device.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, `${device}.json`), JSON.stringify({
    version: 5, deviceId: device,
    createdMs: Date.now() - 30 * 86_400_000,
    progress: { name: device === ALFA ? 'Alfa' : 'Bravo', xp: 900 },
    stats: {
      matches: 25,
      last: { ms: Date.now(), kills: 10, deaths: 3, won: true, seconds: 300, bestStreak: 5, xp: 200, scrap: 30 },
    },
    inventory: {
      items: refs.map((ref) => ({ ref, ms: Date.now() - COOLDOWN_MS - 3_600_000, source: 'drop', sourceId: 'seed' })),
      equippedSkin: '', title: '',
    },
  }), 'utf8');
}
seed(ALFA, [RUST]);
seed(BRAVO, [EMBER]);

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
        economy_trading: { force: true },
      },
    }),
  },
});
server.stdout?.resume(); server.stderr?.on('data', (d) => process.stderr.write(d));

async function openTradeTab(browser, device) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
  await page.addInitScript(([id]) => {
    localStorage.setItem('doomcraft:progress:device', id);
  }, [device]);
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => window.__DC__.openProfile());
  await page.waitForSelector('.dcp-tabs.is-shown', { timeout: 10_000 });
  await page.click('.dcp-tab:text("Trade")');
  await page.waitForSelector('.dct-box', { timeout: 10_000 });
  return page;
}

try {
  if (!(await waitForPort(PORT, 60_000))) throw new Error('server did not come up');
  mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch();

  // ALFA opens a trade and shows the code.
  const a = await openTradeTab(browser, ALFA);
  await a.click('.dct button:text("Open a trade")');
  await a.waitForSelector('.dct-code', { timeout: 10_000 });
  const code = (await a.evaluate(() => document.querySelector('.dct-code').textContent)).trim();
  if (!/^TR[0-9A-Z]{6}$/.test(code)) throw new Error(`bad code on screen: "${code}"`);
  await a.screenshot({ path: 'shots/trade-waiting.png' });
  console.log('CODE', code);

  // BRAVO joins with the code.
  const b = await openTradeTab(browser, BRAVO);
  await b.fill('.dct-row input', code);
  await b.click('.dct button:text-is("Join")');
  await b.waitForSelector('.dct-pick', { timeout: 10_000 });

  // ALFA's poll notices the join and renders the active screen.
  await a.waitForSelector('.dct-pick', { timeout: 15_000 });

  // Both offer their one tradable skin, through the picker.
  for (const [page, name] of [[a, 'Rust Marine'], [b, 'Ember Core']]) {
    await page.locator('.dct-pick', { hasText: name }).locator('button:text-is("Offer")').click();
    await page.click('.dct button:text("Update offer")');
    await page.waitForSelector(`.dct-offer:has-text("${name}")`, { timeout: 10_000 });
  }
  // ALFA must SEE Bravo's offer arrive (the poll), then both confirm.
  await a.waitForSelector('.dct-offer:has-text("Ember Core")', { timeout: 15_000 });
  await a.screenshot({ path: 'shots/trade-active.png' });

  await a.click('.dct button:text("Confirm trade")');
  await a.waitForSelector('.dct-offer h3 i:text("Confirmed")', { timeout: 10_000 });
  await b.waitForSelector('.dct-offer h3 i:text("Confirmed")', { timeout: 15_000 });

  // THE RESET, MADE VISIBLE: Bravo changes the offer AFTER Alfa confirmed.
  // Alfa's confirm must vanish AND the screen must say why.
  await b.locator('.dct-pick', { hasText: 'Ember Core' }).locator('button:text-is("Offered")').click();
  await b.click('.dct button:text("Update offer")');
  await a.waitForFunction(() => document.body.textContent.includes('both confirms were reset'), null, { timeout: 15_000 });
  await a.screenshot({ path: 'shots/trade-reset.png' });
  // Bravo restores the deal; both confirm for real this time.
  await b.locator('.dct-pick', { hasText: 'Ember Core' }).locator('button:text-is("Offer")').click();
  await b.click('.dct button:text("Update offer")');
  await a.waitForSelector('.dct-offer:has-text("Ember Core")', { timeout: 15_000 });
  await a.click('.dct button:text("Confirm trade")');
  await b.waitForSelector('.dct-offer h3 i:text("Confirmed")', { timeout: 15_000 });
  await b.click('.dct button:text("Confirm trade")');

  // Settlement: both screens reach the done state.
  await b.waitForFunction(() => document.querySelector('.dct-line')?.textContent.includes('Settled'), null, { timeout: 20_000 });
  await a.waitForFunction(() => document.querySelector('.dct-line')?.textContent.includes('Settled'), null, { timeout: 20_000 });
  await a.screenshot({ path: 'shots/trade-settled.png' });

  // THE MEASUREMENT: the items actually swapped, server-side.
  const inv = async (device) => {
    const res = await fetch(`${ORIGIN}/api/profile?device=${device}`);
    const body = await res.json();
    return body.profile.inventory.items.map((i) => i.ref);
  };
  const alfa = await inv(ALFA);
  const bravo = await inv(BRAVO);
  console.log('ALFA owns', alfa, 'BRAVO owns', bravo);
  if (!(alfa.includes(EMBER) && !alfa.includes(RUST))) throw new Error('ALFA did not receive EMBER for RUST');
  if (!(bravo.includes(RUST) && !bravo.includes(EMBER))) throw new Error('BRAVO did not receive RUST for EMBER');

  await browser.close();
  console.log('OK shots/trade-waiting.png shots/trade-active.png shots/trade-settled.png');
} finally {
  server.kill('SIGKILL');
}
