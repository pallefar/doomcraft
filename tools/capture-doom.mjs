/**
 * Capture the SECOND bar: DOOM (1993), shareware episode, running in-browser at
 * https://archive.org/details/DoomsharewareEpisode (em-dosbox, 560x384 canvas).
 *
 * voxiom.io has no campaign, so it cannot be the bar for Quest mode. Judging quest
 * levels against voxiom would be judging them against nothing. This is the real bar:
 * E1M1 "Hangar" — the most-played FPS level ever made.
 *
 *   node tools/capture-doom.mjs
 *
 * Output: ref/doom/doom-NN-*.png, ref/doom/doom-gameplay.webm, ref/doom/doom-metrics.json
 *
 * !! THE .webm HAS NO AUDIO TRACK. `canvas.captureStream()` captures video only,
 *    by construction — the same reason it captures the canvas without the DOM HUD.
 *    Do not try to analyse DOOM's sound from it; ffprobe shows one VP9 stream.
 *    For audio, decode the DMX lumps out of the shareware DOOM1.WAD instead
 *    (55 sound lumps, 11025 Hz 8-bit unsigned) — see tools/wad2wav.mjs.
 */
import { chromium } from 'playwright';
import { recordCanvas } from './reccanvas.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'ref', 'doom');
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const shot = (n) => p.locator('canvas').first().screenshot({ path: path.join(OUT, `doom-${n}.png`) });

await p.goto('https://archive.org/details/DoomsharewareEpisode', { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForTimeout(6000);

// archive.org keeps the canvas hidden behind a poster until #emulate is clicked.
const starter = p.locator('#emulate, .js-emulation-emulate, #jsmessSS').first();
await starter.click({ force: true, timeout: 30000 }).catch(async () => {
  await p.locator('#theatre-ia-wrap').first().click({ force: true, timeout: 15000 });
});
console.log('clicked start; waiting for em-dosbox to boot DOOM');
const canvas = p.locator('canvas').first();
await canvas.waitFor({ state: 'visible', timeout: 120000 });
await p.waitForTimeout(30000);
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await p.mouse.click(cx, cy);
await p.waitForTimeout(5000);
await shot('00-boot');

// Through the title/demo loop into a real game: Enter through menus, pick skill 3.
const tap = async (key, ms = 900) => { await p.keyboard.press(key); await p.waitForTimeout(ms); };
await p.mouse.click(cx, cy);
await tap('Enter', 2500);       // dismiss title / demo
await shot('01-title');
await tap('Enter', 1500);       // New Game
await tap('Enter', 1500);       // Episode 1: Knee-Deep in the Dead
await tap('ArrowDown', 400); await tap('ArrowDown', 400);
await tap('Enter', 6000);       // skill 3: Hurt me plenty
await shot('02-e1m1-start');

// Play E1M1 while recording the canvas at 60fps.
const video = await recordCanvas(p, 0, async () => {
  const hold = async (key, ms) => { await p.keyboard.down(key); await p.waitForTimeout(ms); await p.keyboard.up(key); };
  await hold('ArrowUp', 1800);                       // forward into the room
  await p.keyboard.press('Control'); await p.waitForTimeout(500);   // fire
  await hold('ArrowRight', 700);                     // turn
  await hold('ArrowUp', 1500);
  await p.keyboard.press('Space'); await p.waitForTimeout(900);     // use/open door
  await hold('ArrowUp', 2000);
  await p.keyboard.press('2'); await p.waitForTimeout(600);         // pistol->shotgun if held
  for (let i = 0; i < 5; i++) { await p.keyboard.press('Control'); await p.waitForTimeout(400); }
  await hold('ArrowLeft', 800);
  await hold('ArrowUp', 1800);
});
fs.writeFileSync(path.join(OUT, 'doom-gameplay.webm'), video);
await shot('03-combat');
await tap('Tab', 800); await shot('04-automap'); await tap('Tab', 800);
await tap('Escape', 1200); await shot('05-menu');

const fps = await p.evaluate(() => {
  const f = window.__fp || []; return f.length;
});
fs.writeFileSync(path.join(OUT, 'doom-metrics.json'), JSON.stringify({
  source: 'https://archive.org/details/DoomsharewareEpisode',
  engine: 'em-dosbox', canvas: { w: 560, h: 384 },
  note: 'DOOM 1993 runs at 320x200 internally, 35 tics/sec. fps is not comparable to a modern renderer; this bar is for LEVEL DESIGN, PACE, ENEMY BEHAVIOUR and READABILITY, not for frame rate.',
  videoBytes: video.length,
}, null, 2));
console.log('DOOM CAPTURED', video.length, 'bytes of video');
await b.close();
