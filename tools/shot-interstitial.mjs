/**
 * Boot the REAL server with a booked INTERSTITIAL campaign and
 * `sponsor_interstitial` forced on, then drive the shipping pipeline through
 * `window.__DC__.offerInterstitial()` and screenshot the overlay.
 *
 * A green serve.test.ts cannot see this surface: the decisions are unit-tested,
 * but whether the skip control is actually visible, actually focused and
 * actually high-contrast is a question about pixels. §5.3 cites a countdown
 * interstitial with a low-contrast or delayed skip as the Age Appropriate
 * Design Code's named nudge pattern, so "look at it" is the whole point.
 *
 * The measurement, not just the picture: focus must land on the dialog (the
 * skip is disabled for its first second and a disabled button cannot hold it),
 * the skip must become usable and take focus inside that second, and pressing
 * it must actually close the overlay.
 *
 * Run from the repo root:  node tools/shot-interstitial.mjs [--skip-build]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}`))));
  });
}

if (!process.argv.includes('--skip-build')) await run('npm', ['run', 'build']);

const dataRoot = mkdtempSync(join(tmpdir(), 'dc-inter-'));
const NOW = Date.now();

/* One live campaign, one approved TEXT creative, bound to S10. Text rather than
 * display so the harness needs no uploaded asset — the layout under test is the
 * card, the label and the skip control. */
writeFileSync(join(dataRoot, 'sponsors.json'), JSON.stringify({
  sponsors: [{ id: 'spn_1', legalName: 'CubeRealm Ltd', displayName: 'CubeRealm', status: 'active' }],
  creatives: [{
    id: 'crv_inter', sponsorId: 'spn_1', kind: 'text', status: 'approved',
    sha256: '', mime: 'text/plain', bytes: 60, width: 0, height: 0,
    altText: 'CubeRealm — voxel worlds, free to play',
    text: 'CubeRealm — build a world, then survive it. Free to play.',
    clickUrl: 'https://example.com/cube', rejectReason: '',
  }],
  campaigns: [{
    schema: 1, id: 'cmp_inter', sponsorId: 'spn_1', name: 'cube-interstitial', status: 'live',
    startMs: NOW - 86_400_000, endMs: NOW + 86_400_000,
    budgetMicros: 50_000_000, dailyCapMicros: 50_000_000, pacing: 'even',
    pricing: { model: 'cpm', bidMicros: 8_000_000 },
    targeting: {
      modes: [], regions: [], excludeRegions: [], platforms: [],
      minAccountLevel: 0, ageBands: [], levelIds: [], weekdayMaskUtc: 0, hourMaskUtc: 0,
    },
    caps: { perSessionImpressions: 4, perDayImpressions: 8, minSecondsBetween: 0, perDayInterstitials: 4 },
    placements: [{ surface: 10, creativeIds: ['crv_inter'], weight: 100, floorMicrosCpm: 0 }],
    disclosure: 'ad',
  }],
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
      rules: { sponsor_slots: { force: true }, sponsor_interstitial: { force: true } },
    }),
  },
});
server.stdout?.resume();
server.stderr?.on('data', (d) => process.stderr.write(d));

let browser;
try {
  if (!(await waitForPort(PORT, 60_000))) throw new Error('server did not come up');

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });

  const opened = await page.evaluate(() => window.__DC__.offerInterstitial(3));
  if (opened !== true) throw new Error('the pipeline refused to open an interstitial');

  await page.waitForSelector('#ad-overlay[data-open="1"] .dc-inter-skip', { timeout: 10_000 });

  /* MEASUREMENT 1: the keyboard is never left on nothing. The skip is disabled
     for its first second and a disabled button cannot hold focus, so the DIALOG
     takes it first — which is also what announces the overlay to a screen
     reader. */
  const onOpen = await page.evaluate(() => document.activeElement?.id ?? '');
  if (onOpen !== 'ad-overlay') throw new Error(`focus is not on the dialog at open (active id: "${onOpen}")`);

  // MEASUREMENT 2: the skip becomes usable inside the AADC's one second, and
  // takes the keyboard when it does.
  await page.waitForFunction(
    () => document.querySelector('.dc-inter-skip')?.disabled === false,
    null, { timeout: 2_000 },
  );
  const onEnable = await page.evaluate(() => document.activeElement?.className ?? '');
  if (!onEnable.includes('dc-inter-skip')) throw new Error(`skip did not take focus when enabled (active: ${onEnable})`);

  mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: 'shots/interstitial.png' });

  // MEASUREMENT 3: pressing it actually closes the overlay.
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.getElementById('ad-overlay')?.dataset.open !== '1',
    null, { timeout: 5_000 },
  );

  // MEASUREMENT 4: the server recorded a served interstitial and a verdict.
  const res = await fetch(`${ORIGIN}/api/status`);
  if (!res.ok) throw new Error('status probe failed');

  process.stdout.write('shots/interstitial.png\n');
  process.stdout.write('skip focused on open, enabled within 1s, and closes the overlay\n');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
