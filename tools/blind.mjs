// Build a genuinely blind A/B pair for a critic.
//
//   node tools/blind.mjs <imgOurs> <imgBar> <outDir> <swap:0|1>
//
// Writes <outDir>/A.png and <outDir>/B.png with branding masked out, plus nothing else —
// the directory contains no hint of which is which. The swap bit is decided by the caller
// (the workflow script) and is NEVER written to disk, so a filesystem-capable critic cannot
// recover the mapping. Prints only "ok".
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [ours, bar, outDir, swapArg, modeArg] = process.argv.slice(2);
if (!ours || !bar || !outDir) { console.error('usage: blind.mjs <ours> <bar> <outDir> <swap> [menu|game]'); process.exit(1); }
const mode = modeArg || 'menu';
const swap = swapArg === '1';
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Regions (as fractions of width/height) that carry the brand on either side. Masked flat grey
// on BOTH images so the mask itself is not a tell.
const MENU_MASKS = [
  { x: 0.30, y: 0.02, w: 0.40, h: 0.16 },  // centre wordmark area (menu)
  { x: 0.00, y: 0.00, w: 0.17, h: 0.09 },  // top-left social/brand badge
  { x: 0.00, y: 0.11, w: 0.17, h: 0.17 },  // top-left cross-promo tile
  { x: 0.87, y: 0.00, w: 0.13, h: 0.08 },  // top-right stream badges
  { x: 0.00, y: 0.955, w: 0.20, h: 0.045 }, // footer legal links
  // ADDED 2026-09-06. A blind critic read the product name straight off a menu
  // screenshot and correctly binned its own verdict: the masks above cover the
  // BAR's brand furniture and nothing else, but the challenger's front screen
  // prints its own product name as live text inside its reserved house-ad
  // slots. Measured at (1230,421)-(1325,437) and (671,826)-(769,841) on a
  // 1440x900 page; padded here because glyph runs move with copy changes.
  // Masks apply to BOTH images, so these cost the bar the same area they cost
  // the challenger.
  { x: 0.83, y: 0.44, w: 0.13, h: 0.05 },  // right-rail house slot, name text
  { x: 0.44, y: 0.90, w: 0.14, h: 0.05 },  // bottom house slot, name text
];
// In-game there is no wordmark; the only tells are player names in the chat feed. Masking the
// whole HUD would hide the thing under review, so only the name column goes.
const GAME_MASKS = [
  { x: 0.012, y: 0.655, w: 0.19, h: 0.10 },  // chat/kill-feed player names
];
const MASKS = mode === 'game' ? GAME_MASKS : MENU_MASKS;

const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage();

async function mask(src, dst) {
  const buf = fs.readFileSync(src).toString('base64');
  const ext = path.extname(src).slice(1).replace('jpg', 'jpeg');
  await page.setContent(`<style>html,body{margin:0;background:#888}img{display:block}
  .m{position:absolute;background:#8a8a8a}</style>
  <div id="r" style="position:relative;display:inline-block">
    <img id="i" src="data:image/${ext};base64,${buf}">
    ${MASKS.map((m) => `<div class="m" style="left:${m.x * 100}%;top:${m.y * 100}%;width:${m.w * 100}%;height:${m.h * 100}%"></div>`).join('')}
  </div>`);
  await page.waitForFunction(() => { const i = document.getElementById('i'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 15000 });
  const el = await page.$('#r');
  await el.screenshot({ path: dst });
}

await mask(swap ? bar : ours, path.join(outDir, 'A.png'));
await mask(swap ? ours : bar, path.join(outDir, 'B.png'));
await b.close();
console.log('ok');
