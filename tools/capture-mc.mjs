// Capture the BUILDER bar: live Minecraft Classic (classic.minecraft.net).
//
// Modelled on tools/capture-ref.mjs. Headed Chrome + a persistent profile, because the page
// wants a real GL context and a real gesture before it will hand over pointer lock, and because
// the anniversary build parks a cookie banner in front of the canvas on a cold profile.
//
// What it produces in ref/mcclassic/:
//   mc-00-landing.png      the pre-game page
//   mc-01-loading.png      "Generating level"
//   mc-02-world.png        spawned, looking at the world
//   mc-03-look-down.png    looking at the ground (the placement highlight reads best here)
//   mc-04-highlight.png    close on a block face — the targeted-block outline
//   mc-05-place.png        after right-click place
//   mc-06-break.png        after left-click break
//   mc-07-picker.png       the B block picker (the whole creative palette in one grid)
//   mc-08-picker-hover.png a hovered palette cell
//   mc-09-after-pick.png   back in the world holding the picked block
//   mc-10-tower.png        a small built structure, to judge placement cadence
//   mc-12-break-hold-*.png four frames of a held break at 80/200/400/800 ms
//   mc-13-break-done.png   the frame after release
//   mc-14/15/16-place-*    the same for a held place
//   mc-gameplay.webm       canvas-only 60 fps recording of place/break/look
//   mc-metrics.json        timings + fps distribution
//   mc-uitext.txt          all DOM text (Classic's chrome is DOM, the game is canvas)
//
// `node tools/capture-mc.mjs --cadence` runs a separate, shorter probe instead and writes
// mc-cadence.json + mc-cadence-pose.png + mc-cadence-after.png. See the block below.
//
// NOTE: Playwright's recordVideo does NOT capture an accelerated WebGL canvas — it writes a ~2 KB
// file with nothing in it. tools/reccanvas.mjs runs captureStream(60) + MediaRecorder in-page.
//
// FINDING (four --cadence runs plus the stills): the bar has NO hold-repeat and NO dig progress.
// mc-12-break-hold-{80,200,400,800}.png and mc-13-break-done.png all share one MD5, and the
// engine hook counted 0-1 voxel writes per 2.6 s hold. One click is one block.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { recordCanvas } from './reccanvas.mjs';

const OUT = path.resolve('/Users/karstenhaldan/youtube/doomcraft/ref/mcclassic');
const PROFILE = path.resolve('/Users/karstenhaldan/youtube/doomcraft/tools/.profile-mc');
fs.mkdirSync(OUT, { recursive: true });

const viewport = { width: 1440, height: 900 };
const log = (...a) => console.log(...a);
const shot = async (p, n) => { await p.screenshot({ path: path.join(OUT, `mc-${n}.png`) }); log('SHOT', n); };

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport, deviceScaleFactor: 1,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle', '--enable-unsafe-swiftshader',
  ],
});
const p = ctx.pages()[0] || await ctx.newPage();
p.on('pageerror', (e) => log('PAGEERROR', e.message));

const t0 = Date.now();
await p.goto('https://classic.minecraft.net/', { waitUntil: 'domcontentloaded', timeout: 120000 });
const tTitle = Date.now() - t0;
await p.waitForTimeout(2500);

// Cookie / consent — Mojang's banner sits over the canvas and eats the click that grants pointer lock.
async function killConsent(page) {
  const sels = [
    '#onetrust-accept-btn-handler', '.onetrust-close-btn-handler',
    'button:has-text("Accept All Cookies")', 'button:has-text("Accept all")',
    'button:has-text("Accept")', 'button:has-text("I agree")', 'button:has-text("Got it")',
  ];
  for (let round = 0; round < 4; round++) {
    let hit = false;
    for (const sel of sels) {
      try {
        const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 600 })) { await b.click({ force: true, timeout: 3000 }); hit = true; await page.waitForTimeout(700); }
      } catch { /* not present */ }
    }
    await page.evaluate(() => {
      for (const s of ['#onetrust-consent-sdk', '.onetrust-pc-dark-filter', '#CybotCookiebotDialog'])
        document.querySelectorAll(s).forEach((e) => e.remove());
    }).catch(() => {});
    if (!hit) break;
  }
}
await killConsent(p);
await shot(p, '00-landing');

// The anniversary build gates on a username + "Start". Both the field and the button move around
// between revisions, so probe several shapes and fall through to "click the canvas" if none exist.
async function enterGame(page) {
  const nameSel = ['input[name="username"]', 'input#username', 'input[type="text"]'];
  for (const s of nameSel) {
    try {
      const el = page.locator(s).first();
      if (await el.isVisible({ timeout: 800 })) { await el.fill('Doomcraft'); log('TYPED_NAME via', s); break; }
    } catch { /* next */ }
  }
  const startSel = [
    'button:has-text("Start")', 'a:has-text("Start")', 'text=/^Start$/',
    'button:has-text("Play")', 'text=/Play Classic/i', 'button[type="submit"]', 'input[type="submit"]',
  ];
  for (const s of startSel) {
    try {
      const el = page.locator(s).first();
      if (await el.isVisible({ timeout: 900 })) { await el.click({ force: true, timeout: 4000 }); log('CLICKED_START via', s); return true; }
    } catch { /* next */ }
  }
  return false;
}
const started = await enterGame(p);
log('ENTER_GAME', started);
await p.waitForTimeout(2500);
await shot(p, '01-loading');

// FPS probe.
await p.evaluate(() => {
  window.__f = [];
  const l = (t) => { window.__f.push(t); if (window.__f.length > 6000) window.__f.shift(); requestAnimationFrame(l); };
  requestAnimationFrame(l);
});

// Wait for the world: the canvas stops being uniformly black.
const tGen = Date.now();
let live = false;
for (let i = 0; i < 40; i++) {
  live = await p.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c || !c.width) return false;
    const g = document.createElement('canvas');
    g.width = 32; g.height = 32;
    const x = g.getContext('2d');
    try { x.drawImage(c, 0, 0, 32, 32); } catch { return false; }
    const d = x.getImageData(0, 0, 32, 32).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; if (v < min) min = v; if (v > max) max = v; }
    return max - min > 60;
  }).catch(() => false);
  if (live) break;
  await p.waitForTimeout(1000);
}
const tWorld = Date.now() - tGen;
log('WORLD_LIVE', live, 'after', tWorld, 'ms');
await p.waitForTimeout(1500);
await shot(p, '02-world');

const canvas = p.locator('canvas').first();
const box = await canvas.boundingBox().catch(() => null);
if (!box) { log('NO_CANVAS'); await ctx.close(); process.exit(1); }
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

// Pointer lock needs a real click on the canvas, and the first one is routinely swallowed
// (Chrome's "press Esc to exit" chip eats it, or the canvas has not taken focus yet). Verify it
// actually engaged instead of assuming: without the lock every mouse.move is a no-op and the whole
// look/place/break half of the capture silently records the same frame ten times.
// Chrome refuses requestPointerLock() when the document is not focused, and an automated
// window very often is not. This one line is the difference between a real capture and ten
// identical frames.
await p.bringToFront();
let locked = false;
for (let attempt = 0; attempt < 5 && !locked; attempt++) {
  await p.mouse.click(cx, cy);
  await p.waitForTimeout(900);
  locked = await p.evaluate(() => document.pointerLockElement !== null).catch(() => false);
  if (!locked) { await p.mouse.move(cx + 4, cy + 4); await p.waitForTimeout(300); }
}
log('POINTER_LOCK', locked);

// Under pointer lock only movementX/Y matters, and Playwright derives it from the delta between
// consecutive mouse.move calls — so walk the cursor in small steps and keep it inside the viewport.
let mx = cx, my = cy;
const look = async (dx, dy, steps = 12) => {
  for (let i = 0; i < steps; i++) {
    mx += dx / steps; my += dy / steps;
    if (mx < 8 || mx > viewport.width - 8) mx = cx;
    if (my < 8 || my > viewport.height - 8) my = cy;
    await p.mouse.move(mx, my);
    await p.waitForTimeout(18);
  }
};
const hold = async (key, ms) => { await p.keyboard.down(key); await p.waitForTimeout(ms); await p.keyboard.up(key); };

/* -------------------------------------------------------------------------------------------- *
 * --cadence: the one number a screenshot cannot give
 *
 * "A repeat-rate on hold that feels right rather than spammy" is the whole of placement feel, and
 * it is invisible in a still. The four `mc-12-break-hold-*.png` frames are byte-identical, which
 * proves the bar has no dig progress — but it says nothing about how fast a HELD button repeats.
 *
 * Two measurements, best first:
 *
 *  1. Hook the engine. This build is `noa` (Babylon under it) and it parks the instance on
 *     `window.noa`. Wrapping `noa.setBlock` / `noa.world.setBlockID` records the exact
 *     `performance.now()` of every voxel write, which is the ground truth.
 *  2. Fall back to pixels. Downsample the GL canvas to 48x48 every ~20 ms and record the
 *     sum-of-absolute-difference against the previous sample. A block appearing under the
 *     crosshair is a step change; cloud drift is not. Peaks over a threshold are edit events.
 *
 * Either way the output is an array of event timestamps per held button, and the interesting
 * statistic is the median gap between consecutive events.
 * -------------------------------------------------------------------------------------------- */
if (process.argv.includes('--cadence')) {
  const hooked = await p.evaluate(() => {
    window.__ev = [];
    const stamp = () => { window.__ev.push(performance.now()); };
    // Hook the OUTERMOST entry point only. `noa.setBlock` calls `noa.world.setBlockID`, so
    // wrapping both double-counts every edit and makes a one-block hold look like two.
    const cands = [];
    const noa = window.noa;
    if (noa && typeof noa.setBlock === 'function') cands.push([noa, 'setBlock']);
    else if (noa && noa.world && typeof noa.world.setBlockID === 'function') cands.push([noa.world, 'setBlockID']);
    for (const [obj, key] of cands) {
      const orig = obj[key];
      obj[key] = function wrapped(...a) { stamp(); return orig.apply(this, a); };
    }
    return cands.map(([, k]) => k);
  });
  log('CADENCE_HOOK', JSON.stringify(hooked));

  // Pixel sampler, always on: it is the cross-check on the hook, and the only signal if the
  // engine is not reachable from the page scope.
  await p.evaluate(() => {
    const c = document.getElementById('noa-canvas') || document.querySelector('canvas');
    const g = document.createElement('canvas');
    g.width = 48; g.height = 48;
    const x = g.getContext('2d', { willReadFrequently: true });
    let prev = null;
    window.__px = [];
    window.__pxTimer = setInterval(() => {
      try { x.drawImage(c, 0, 0, 48, 48); } catch { return; }
      const d = x.getImageData(0, 0, 48, 48).data;
      if (prev !== null) {
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]) + Math.abs(d[i + 2] - prev[i + 2]);
        window.__px.push([performance.now(), s]);
      }
      prev = d.slice();
    }, 20);
  });

  const probe = async (label, button, ms, prep, during) => {
    await prep();
    await p.waitForTimeout(400);
    await p.evaluate(() => { window.__ev = []; window.__px = []; });
    await p.mouse.down({ button });
    if (during === undefined) await p.waitForTimeout(ms); else await during();
    await p.mouse.up({ button });
    await p.waitForTimeout(250);
    const r = await p.evaluate(() => ({ ev: window.__ev.slice(), px: window.__px.slice() }));
    // Pixel events: a sample whose delta clears 6x the median delta and is a local maximum.
    const vals = r.px.map((s) => s[1]).slice().sort((a, b) => a - b);
    const med = vals.length ? vals[vals.length >> 1] : 0;
    const thr = Math.max(600, med * 6);
    const peaks = [];
    for (let i = 1; i < r.px.length - 1; i++) {
      if (r.px[i][1] > thr && r.px[i][1] >= r.px[i - 1][1] && r.px[i][1] > r.px[i + 1][1]) {
        if (peaks.length === 0 || r.px[i][0] - peaks[peaks.length - 1] > 45) peaks.push(r.px[i][0]);
      }
    }
    const gaps = (a) => { const g = []; for (let i = 1; i < a.length; i++) g.push(+(a[i] - a[i - 1]).toFixed(1)); return g; };
    const median = (a) => (a.length === 0 ? null : [...a].sort((x, y) => x - y)[a.length >> 1]);
    const out = {
      label, heldMs: ms,
      hookEvents: r.ev.length, hookGapsMs: gaps(r.ev), hookMedianGapMs: median(gaps(r.ev)),
      pixelEvents: peaks.length, pixelGapsMs: gaps(peaks), pixelMedianGapMs: median(gaps(peaks)),
      pixelThreshold: Math.round(thr), pixelSamples: r.px.length,
    };
    log('CADENCE', JSON.stringify(out));
    return out;
  };

  // Park the camera once, at roughly 45 degrees onto the ground about two metres ahead, and do
  // NOT move it again. Every probe below runs from the same pose, so the only variable is the
  // button. Looking straight down would place blocks into the camera (the bar allows exactly
  // that — weakness #3) and looking up would aim at sky and register nothing, and both of those
  // are how the first run of this probe produced an unreadable answer.
  // Do NOT walk first. The generator spawns on a beach as often as not, and the run that taught
  // this lesson strolled into the sea and aimed the crosshair at water, which Classic does not
  // target at all — zero events, and nothing to tell that apart from "the hold does not repeat".
  // Pitch all the way to straight down (the engine clamps at -90). Two cells ahead on a random
  // seed is a coin flip between flat grass and a cliff lip — the run that taught THIS lesson
  // chewed a notch through the lip in two clicks and then aimed the remaining eight at open sea.
  // Straight down is the one direction with guaranteed depth: terrain runs to bedrock, so every
  // break exposes a fresh target, the shaft feeds itself, and the probe cannot run out of world.
  await look(0, 900);
  await p.waitForTimeout(500);
  await shot(p, 'cadence-pose');

  // CONTROL: ten discrete clicks 100 ms apart. If the engine registers ten edits here, then a
  // hold that registers one is a hold that genuinely does not repeat — rather than a probe that
  // is aiming at nothing.
  await p.evaluate(() => { window.__ev = []; });
  for (let i = 0; i < 10; i++) {
    await p.mouse.down({ button: 'left' }); await p.waitForTimeout(20); await p.mouse.up({ button: 'left' });
    await p.waitForTimeout(80);
  }
  await p.waitForTimeout(250);
  const clickRun = await p.evaluate(() => ({ events: window.__ev.length, stamps: window.__ev.slice() }));
  log('CADENCE_CLICKS', JSON.stringify(clickRun.events));

  const breakRun = await probe('break-hold', 'left', 2600, async () => {});
  // A second hold, this time with the crosshair crawling one pixel every 40 ms. If a hold repeats
  // only when the AIMED CELL changes — rather than on a timer — this run fires and the still one
  // does not, and that is a different design decision with a different answer in placement.ts.
  const breakSweep = await probe('break-hold-sweeping', 'left', 2600, async () => {}, async () => {
    for (let i = 0; i < 60; i++) { await p.mouse.move(mx + (i % 2 ? 1 : -1), my + i * 0.2); await p.waitForTimeout(40); }
  });
  // Climb back to 45 degrees so PLACE has a wall to extrude off rather than the camera's own cell.
  const placeRun = await probe('place-hold', 'right', 2600, async () => { await look(0, -260); });
  await p.evaluate(() => { clearInterval(window.__pxTimer); });
  await shot(p, 'cadence-after');

  fs.writeFileSync(path.join(OUT, 'mc-cadence.json'), JSON.stringify({
    hooked, clickRun, breakRun, breakSweep, placeRun,
  }, null, 2));
  log('DONE_CADENCE ' + path.join(OUT, 'mc-cadence.json'));
  await ctx.close();
  process.exit(0);
}

// Walk a little so we are not standing in the spawn column, then look down at the ground:
// the targeted-block wireframe is unmistakable against a flat grass field.
await hold('w', 900);
await look(0, 420);
await p.waitForTimeout(500);
await shot(p, '03-look-down');
await look(0, -70);
await p.waitForTimeout(400);
await shot(p, '04-highlight');

// Right-click = place, left-click = break. Screenshot each so the two can be diffed.
await p.mouse.down({ button: 'right' }); await p.waitForTimeout(120); await p.mouse.up({ button: 'right' });
await p.waitForTimeout(500);
await shot(p, '05-place');
await p.mouse.down({ button: 'left' }); await p.waitForTimeout(400); await p.mouse.up({ button: 'left' });
await p.waitForTimeout(500);
await shot(p, '06-break');

// B = the creative block picker.
await p.keyboard.press('KeyB');
await p.waitForTimeout(900);
await shot(p, '07-picker');
await p.mouse.move(cx - 120, cy - 40); await p.waitForTimeout(400);
await shot(p, '08-picker-hover');
await p.mouse.click(cx - 120, cy - 40);
await p.waitForTimeout(900);
await shot(p, '09-after-pick');

// Build something: hold-place cadence is what "feels right rather than spammy" has to match.
await look(0, 120);
for (let i = 0; i < 6; i++) {
  await p.mouse.down({ button: 'right' }); await p.waitForTimeout(90); await p.mouse.up({ button: 'right' });
  await p.waitForTimeout(160);
  await p.keyboard.press('Space');
  await p.waitForTimeout(200);
}
await look(240, -140);
await p.waitForTimeout(600);
await shot(p, '10-tower');

// --- feel probe -----------------------------------------------------------------------------
// Stills cannot answer "how fast does a held button repeat" or "is there a dig progress overlay",
// and those two numbers are the whole of placement feel. Dig out of the stone we just buried
// ourselves in, then hold each button and shoot the sequence.
await look(0, -200);
for (let i = 0; i < 6; i++) {
  await p.mouse.down({ button: 'left' }); await p.waitForTimeout(260); await p.mouse.up({ button: 'left' });
  await p.waitForTimeout(120);
}
await hold('w', 700);
await look(0, 300);
await p.waitForTimeout(400);
await shot(p, '11-clear');

// Held BREAK: is there a progress overlay, and how long does one block take?
await p.mouse.down({ button: 'left' });
for (const ms of [80, 200, 400, 800]) { await p.waitForTimeout(ms === 80 ? 80 : ms - 0); await shot(p, `12-break-hold-${ms}`); }
await p.mouse.up({ button: 'left' });
await p.waitForTimeout(400);
await shot(p, '13-break-done');

// Held PLACE: does holding repeat, and at what cadence?
await look(0, -120);
await p.mouse.down({ button: 'right' });
await p.waitForTimeout(250); await shot(p, '14-place-hold-250');
await p.waitForTimeout(1250); await shot(p, '15-place-hold-1500');
await p.mouse.up({ button: 'right' });
await p.waitForTimeout(400);
await shot(p, '16-place-released');

// Canvas-only 60 fps recording while driving place / break / look.
//
// The page has SIX canvases: #version, #hotbar, #previewWindow, #chat, #menu, #progress,
// #overlay (the HUD, drawn in 2D) and finally #noa-canvas (the WebGL world, Babylon.js under
// the `noa` voxel engine). reccanvas.mjs records `document.querySelector('canvas')`, which is
// the 512x68 version-string canvas — that is what a 5.7 KB "video" looks like. Hoist the game
// canvas to the front of the body so it is the one that gets recorded; the HUD divs stay later
// in document order, so they keep painting over it on screen.
await p.evaluate(() => {
  const noa = document.getElementById('noa-container');
  if (noa !== null && noa.parentNode !== null) noa.parentNode.insertBefore(noa, noa.parentNode.firstChild);
});
await p.waitForTimeout(600);
log('RECORDING_CANVAS', await p.evaluate(() => {
  const c = document.querySelector('canvas');
  return c === null ? 'none' : `${c.id || '(anon)'} ${c.width}x${c.height}`;
}));
let video = null;
try {
  video = await recordCanvas(p, 8, async () => {
    await look(-260, 0, 14);
    await hold('w', 700);
    await p.mouse.down({ button: 'right' }); await p.waitForTimeout(140); await p.mouse.up({ button: 'right' });
    await p.waitForTimeout(300);
    await p.mouse.down({ button: 'left' }); await p.waitForTimeout(700); await p.mouse.up({ button: 'left' });
    await look(320, 90, 16);
    await hold('a', 700);
    await p.mouse.down({ button: 'right' }); await p.waitForTimeout(140); await p.mouse.up({ button: 'right' });
    await p.waitForTimeout(900);
    await look(0, -180, 12);
    await p.waitForTimeout(900);
  });
  fs.writeFileSync(path.join(OUT, 'mc-gameplay.webm'), video);
  log('VIDEO_BYTES', video.length);
} catch (e) { log('VIDEO_FAILED', e.message); }

const fps = await p.evaluate(() => {
  const f = window.__f || [];
  if (f.length < 30) return null;
  const d = [];
  for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
  d.sort((x, y) => x - y);
  const q = (k) => d[Math.floor(d.length * k)];
  return {
    frames: d.length, medianMs: +q(0.5).toFixed(2), p95Ms: +q(0.95).toFixed(2), p99Ms: +q(0.99).toFixed(2),
    fpsMedian: +(1000 / q(0.5)).toFixed(1), fps1pctLow: +(1000 / q(0.99)).toFixed(1),
  };
});
log('FPS ' + JSON.stringify(fps));
const bytes = await p.evaluate(() => performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0));
const text = await p.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 4000));
fs.writeFileSync(path.join(OUT, 'mc-uitext.txt'), text);
fs.writeFileSync(path.join(OUT, 'mc-metrics.json'), JSON.stringify({ tTitle, tWorld, live, started, fps, bytes }, null, 2));
await ctx.close();
log('DONE ' + OUT);
