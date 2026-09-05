// Re-capture THE BAR (voxiom.io) actually FIGHTING WITH A GUN.
//
// ref/voxiom/desktop-gameplay.webm shows a player holding a SHOVEL, never firing, with a nearly
// static camera. A gunfeel A/B against that proves nothing. This script produces a second, separate
// recording in which the player holds a FIREARM, FIRES it, and the camera PANS — so the two sides
// of the comparison are actually comparable.
//
//   node tools/capture-ref-gunfight.mjs [--mode "Capture The Gems"] [--secs 20] [--out NAME]
//
// It never touches ref/voxiom/desktop-gameplay.webm or any other existing file: everything it
// writes is prefixed `desktop-gunfight` (or --out).
//
// Traps this script exists to work around (all measured, see ref/BAR.md):
//  * headless is blocked by Cloudflare  -> headed Chrome + persistent profile
//  * two stacked consent CMPs           -> click both in a loop, then remove the roots
//  * "Play" is a heading, not a button  -> click the mode tile
//  * recordVideo cannot see a WebGL canvas -> tools/reccanvas.mjs (captureStream + MediaRecorder)
//  * pointer-lock mouselook             -> VERIFIED here, not assumed: a page-side probe counts the
//    movementX deltas the game's own listeners receive, so a run that could not turn the camera
//    reports that fact instead of silently producing 400 identical frames.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { recordCanvas } from './reccanvas.mjs';

const ROOT = '/Users/karstenhaldan/youtube/doomcraft';
const OUT = path.join(ROOT, 'ref/voxiom');
const SCRATCH = process.env.SCRATCH || path.join(ROOT, 'tools/.gunfight-scratch');
const PROFILE = path.join(ROOT, 'tools/.profile');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MODE = arg('--mode', 'Capture The Gems');
const SECS = +arg('--secs', 20);
const NAME = arg('--out', 'desktop-gunfight');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const log = (...a) => console.log(...a);
const viewport = { width: 1440, height: 900 };

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport, deviceScaleFactor: 1,
  args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
});
const p = ctx.pages()[0] || await ctx.newPage();
const shot = async (n) => { await p.screenshot({ path: path.join(SCRATCH, `${n}.png`) }).catch(() => {}); };

await p.goto('https://voxiom.io', { waitUntil: 'domcontentloaded', timeout: 90000 });
for (let i = 0; i < 12; i++) { if (!/just a moment/i.test(await p.title())) break; await p.waitForTimeout(2500); }

async function killConsent(page) {
  const sels = ['.fc-cta-consent', '.fc-button.fc-cta-consent', 'button.fc-cta-consent',
    '#qc-cmp2-ui button[mode="primary"]', 'button:has-text("Consent")', 'button:has-text("Accept all")',
    'button:has-text("Accept")', 'button:has-text("AGREE")', '.fc-cta-do-not-consent'];
  for (let round = 0; round < 6; round++) {
    let hit = false;
    for (const sel of sels) {
      try {
        const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 700 })) { await b.click({ force: true, timeout: 3000 }); hit = true; await page.waitForTimeout(900); }
      } catch { /* CMP not present this round */ }
    }
    await page.evaluate(() => {
      for (const s of ['.fc-consent-root', '#qc-cmp2-container', '.qc-cmp-cleanslate', '.fc-dialog-container']) {
        document.querySelectorAll(s).forEach((e) => e.remove());
      }
    }).catch(() => {});
    if (!hit) break;
  }
}
await killConsent(p);
await p.waitForTimeout(4000);
await killConsent(p);
await shot('00-menu');
fs.writeFileSync(path.join(SCRATCH, '00-menu.txt'),
  await p.evaluate(() => document.body.innerText.slice(0, 4000)));

// Enter the mode. The tile is the clickable thing; the word "Play" above it is a heading.
try {
  const tile = p.locator(`text=/^${MODE}$/`).last();
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await tile.click({ timeout: 20000, force: true });
  log(`CLICKED_MODE ${MODE}`);
} catch (e) { log('MODE_CLICK_FAILED', e.message); }

// Watch the load in: a match can sit in "Waiting for players" for a while.
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(4000);
  const t = await p.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 800)).catch(() => '');
  log(`T+${(i + 1) * 4}s ${JSON.stringify(t.slice(0, 160))}`);
  if (i === 3 || i === 7) await shot(`01-load-${i}`);
  if (/Press `?Tab`? for full map|Press enter to chat/i.test(t)) { log('IN_GAME'); break; }
}
await shot('02-ingame');
fs.writeFileSync(path.join(SCRATCH, '02-ingame.txt'),
  await p.evaluate(() => document.body.innerText.slice(0, 4000)));

const canvas = p.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

// Pointer lock, verified. Chrome refuses requestPointerLock when the document is not focused.
await p.bringToFront();
let locked = false;
for (let a = 0; a < 6 && !locked; a++) {
  await p.mouse.click(cx, cy);
  await p.waitForTimeout(900);
  locked = await p.evaluate(() => document.pointerLockElement !== null).catch(() => false);
}
log('POINTER_LOCK', locked);

// The probe: does synthetic mouse motion actually reach the game as movementX/Y?
// Answering this with a number is the difference between a capture and a fake.
await p.evaluate(() => {
  window.__mv = { n: 0, sumAbsX: 0, sumAbsY: 0, trusted: 0 };
  window.addEventListener('mousemove', (e) => {
    window.__mv.n++;
    window.__mv.sumAbsX += Math.abs(e.movementX || 0);
    window.__mv.sumAbsY += Math.abs(e.movementY || 0);
    if (e.isTrusted) window.__mv.trusted++;
  }, true);
  window.__clicks = 0;
  window.addEventListener('mousedown', () => { window.__clicks++; }, true);
});

let mx = cx, my = cy;
const look = async (dx, dy, steps = 10, dt = 16) => {
  for (let i = 0; i < steps; i++) {
    mx += dx / steps; my += dy / steps;
    if (mx < 40 || mx > viewport.width - 40) mx = cx;
    if (my < 40 || my > viewport.height - 40) my = cy;
    await p.mouse.move(mx, my);
    await p.waitForTimeout(dt);
  }
};
await look(300, 0, 10);
await p.waitForTimeout(300);
const mv = await p.evaluate(() => window.__mv);
log('MOUSELOOK_PROBE ' + JSON.stringify(mv));

/* Hotbar selection. MEASURED, and it is the single trap that made the first run useless:
 * `keyboard.press('2')` does NOT change the held item. The keydown arrives (trusted, key "2",
 * code "Digit2") and voxiom ignores it — the engine polls key STATE per frame, and Playwright's
 * press goes down and up inside one frame. A HELD press works, and so does the mouse wheel.
 * The first capture in Capture The Gems used press() and photographed a shovel five times. */
const selectSlot = async (code, ms = 220) => {
  await p.keyboard.down(code);
  await p.waitForTimeout(ms);
  await p.keyboard.up(code);
  await p.waitForTimeout(500);
};
const hotbarShot = async (n) => {
  await p.screenshot({ path: path.join(SCRATCH, `${n}.png`), clip: { x: 1040, y: 730, width: 360, height: 140 } }).catch(() => {});
};
for (const d of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']) {
  await selectSlot(d);
  await hotbarShot(`03-slot-${d}`);
}

// Capture The Gems loadout: 1 shovel, 2 assault rifle, 3 pistol, 4 dirt x45, 5 empty.
const SLOT = arg('--slot', 'Digit2');
await selectSlot(SLOT, 260);
await shot('03-weapon-selected');
await hotbarShot('03-weapon-selected-hotbar');
log('SELECTED_SLOT ' + SLOT);
const hudText = () => p.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n')).catch(() => '');
const hudBefore = await hudText();
log('HUD_BEFORE ' + JSON.stringify(hudBefore.slice(0, 400)));

/* ---- the recording ---------------------------------------------------------------------- *
 * Continuous mouselook the whole time, with firing bursts layered on top, so every sampled
 * frame has both a moving camera and (in the burst windows) a shot in flight.
 * ------------------------------------------------------------------------------------------ */
// --aim lets a run point somewhere before recording (positive dy looks DOWN). Firing into open sky
// shows the muzzle but nothing of what a bullet does when it lands, so a run aimed at a wall is a
// different measurement, not a prettier version of the same one.
const AIM = arg('--aim', '');
if (AIM) { const [ax, ay] = AIM.split(',').map(Number); await look(ax, ay, 14, 20); await p.waitForTimeout(600); log('AIMED ' + AIM); }
const DRIFT = +arg('--drift', -5);

const fireLog = [];
const hud = [];
const t0 = Date.now();
const stamp = () => +((Date.now() - t0) / 1000).toFixed(2);
const buf = await recordCanvas(p, SECS, async () => {
  const burst = async (ms) => {
    const s = stamp();
    await p.mouse.down();
    // keep turning while the trigger is held — recoil/sway only shows against a moving camera
    const t = Date.now();
    while (Date.now() - t < ms) await look(20, DRIFT, 2, 16);
    await p.mouse.up();
    fireLog.push([s, stamp()]);
    hud.push([stamp(), (await hudText()).slice(0, 300)]);
  };
  const reload = async () => { await p.keyboard.down('KeyR'); await p.waitForTimeout(220); await p.keyboard.up('KeyR'); await p.waitForTimeout(1800); };
  await look(-120, 0, 8);
  await burst(900);
  await look(140, -DRIFT * 6, 10);
  await burst(1100);
  await reload();
  await p.keyboard.down('KeyW');
  await look(-180, DRIFT * 5, 12);
  await burst(1200);
  await p.keyboard.up('KeyW');
  await look(220, 0, 12);
  await burst(1400);
  await reload();
  await look(-160, -DRIFT * 4, 10);
  await burst(900);
  await look(180, DRIFT * 4, 10);
  await burst(1500);
  await reload();
  await look(-120, 0, 8);
  await burst(1000);
  await look(120, 0, 8);
});
const mv2 = await p.evaluate(() => ({ mv: window.__mv, clicks: window.__clicks }));
log('AFTER_DRIVE ' + JSON.stringify(mv2));
log('FIRE_WINDOWS ' + JSON.stringify(fireLog));
for (const [t, h] of hud) log(`HUD@${t}s ` + JSON.stringify(h.slice(0, 220)));

const dest = path.join(OUT, `${NAME}.webm`);
if (fs.existsSync(dest)) { log('REFUSING_TO_OVERWRITE ' + dest); fs.writeFileSync(path.join(SCRATCH, `${NAME}.webm`), buf); }
else fs.writeFileSync(dest, buf);
fs.writeFileSync(path.join(OUT, `${NAME}-drive.json`), JSON.stringify({
  mode: MODE, slot: SLOT, seconds: SECS, pointerLock: locked, mouselook: mv2, fireWindows: fireLog,
  hudSamples: hud,
}, null, 2));
await shot('04-after');
log('WROTE ' + dest + ' ' + buf.length + ' bytes');
await ctx.close();
