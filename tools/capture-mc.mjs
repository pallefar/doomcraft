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
//   mc-gameplay.webm       canvas-only 60 fps recording of place/break/look
//   mc-metrics.json        timings + fps distribution
//   mc-uitext.txt          all DOM text (Classic's chrome is DOM, the game is canvas)
//
// NOTE: Playwright's recordVideo does NOT capture an accelerated WebGL canvas — it writes a ~2 KB
// file with nothing in it. tools/reccanvas.mjs runs captureStream(60) + MediaRecorder in-page.
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
