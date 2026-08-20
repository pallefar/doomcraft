// Capture the BAR: live voxiom.io gameplay reference frames + metrics.
// Headed Chrome w/ persistent profile is required (Cloudflare blocks headless).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('/Users/karstenhaldan/youtube/doomcraft/ref/voxiom');
const PROFILE = path.resolve('/Users/karstenhaldan/youtube/doomcraft/tools/.profile');
const MOBILE = process.argv.includes('--mobile');
const LAND = process.argv.includes('--landscape');
const tag = MOBILE ? (LAND ? 'mobileland' : 'mobile') : 'desktop';
fs.mkdirSync(OUT, { recursive: true });

const viewport = MOBILE ? (LAND ? { width: 915, height: 412 } : { width: 412, height: 915 }) : { width: 1440, height: 900 };
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport,
  deviceScaleFactor: 1, hasTouch: MOBILE, isMobile: MOBILE,
  userAgent: MOBILE ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' : undefined,
  args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
  recordVideo: { dir: path.join(OUT, `video-${tag}`), size: viewport },
});
const p = ctx.pages()[0] || await ctx.newPage();
const log = (...a) => console.log(...a);

const t0 = Date.now();
await p.goto('https://voxiom.io', { waitUntil: 'domcontentloaded', timeout: 90000 });
// Cloudflare
for (let i = 0; i < 12; i++) { if (!/just a moment/i.test(await p.title())) break; await p.waitForTimeout(2500); }
const tTitle = Date.now() - t0;

// consent — several CMPs stack here (AdInPlay/Quantcast + Google Funding Choices)
async function killConsent(page) {
  const sels = ['.fc-cta-consent', '.fc-button.fc-cta-consent', 'button.fc-cta-consent',
    '#qc-cmp2-ui button[mode="primary"]', 'button:has-text("Consent")', 'button:has-text("Accept all")',
    'button:has-text("Accept")', 'button:has-text("AGREE")', '.fc-cta-do-not-consent'];
  for (let round = 0; round < 6; round++) {
    let hit = false;
    for (const sel of sels) {
      try { const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 700 })) { await b.click({ force: true, timeout: 3000 }); hit = true; await page.waitForTimeout(900); }
      } catch {}
    }
    // nuke leftover consent roots that swallow pointer events
    await page.evaluate(() => { for (const s of ['.fc-consent-root', '#qc-cmp2-container', '.qc-cmp-cleanslate', '.fc-dialog-container'])
      document.querySelectorAll(s).forEach(e => e.remove()); }).catch(() => {});
    if (!hit) break;
  }
}
await killConsent(p);
await p.waitForTimeout(3000);
// time until Play button is actually clickable = time-to-playable(menu)
const play = p.locator('div:has-text("Battle Royale")').last();
try { await play.waitFor({ state: 'visible', timeout: 45000 }); } catch {}
const tPlayable = Date.now() - t0;
await p.screenshot({ path: path.join(OUT, `${tag}-00-menu.png`) });
log(`TIME_TO_TITLE_MS ${tTitle}`); log(`TIME_TO_MENU_PLAYABLE_MS ${tPlayable}`);

// FPS probe installed before entering game
await p.addInitScript(() => { window.__f = []; const l = t => { window.__f.push(t); if (window.__f.length > 4000) window.__f.shift(); requestAnimationFrame(l); }; requestAnimationFrame(l); });
await p.evaluate(() => { window.__f = []; const l = t => { window.__f.push(t); if (window.__f.length > 4000) window.__f.shift(); requestAnimationFrame(l); }; requestAnimationFrame(l); });

await killConsent(p);
try {
  // click the actual game-mode tile, not the "Play" heading
  const tile = p.locator('text=/^Battle Royale$/').last();
  await tile.scrollIntoViewIfNeeded().catch(()=>{});
  await tile.click({ timeout: 15000, force: true });
  console.log('CLICKED_MODE Battle Royale');
} catch (e) { log('PLAY_CLICK_FAILED', e.message); }
const tClick = Date.now();
await p.waitForTimeout(25000);
log(`TIME_MENU_TO_INGAME_MS ~${Date.now() - tClick}`);
await p.screenshot({ path: path.join(OUT, `${tag}-01-entering.png`) });

const canvas = p.locator('canvas').first();
const box = await canvas.boundingBox().catch(() => null);
if (box) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await p.mouse.click(cx, cy); // pointer lock
  await p.waitForTimeout(1500);
}
// drive it: look around, walk, shoot, build, swap weapons
const seq = [
  ['move', 600, 0], ['key', 'w', 1200], ['shot', '02-fwd'],
  ['move', -900, 120], ['key', 'a', 900], ['shot', '03-strafe'],
  ['click', 3], ['shot', '04-shoot'],
  ['key', 'Digit2', 300], ['shot', '05-weapon2'],
  ['key', 'Digit3', 300], ['shot', '06-weapon3'],
  ['key', 'Space', 200], ['shot', '07-jump'],
  ['move', 400, -200], ['key', 'w', 1500], ['click', 4], ['shot', '08-combat'],
  ['key', 'KeyB', 400], ['shot', '09-build'],
  ['click', 2], ['shot', '10-place'],
  ['key', 'Escape', 800], ['shot', '11-esc-menu'],
];
for (const [kind, a, b] of seq) {
  try {
    if (kind === 'move') { for (let i = 0; i < 12; i++) { await p.mouse.move(720 + (a / 12) * i, 450 + (b / 12) * i); await p.waitForTimeout(25); } }
    else if (kind === 'key') { await p.keyboard.down(a); await p.waitForTimeout(b); await p.keyboard.up(a); }
    else if (kind === 'click') { for (let i = 0; i < a; i++) { await p.mouse.down(); await p.waitForTimeout(120); await p.mouse.up(); await p.waitForTimeout(200); } }
    else if (kind === 'shot') { await p.waitForTimeout(400); await p.screenshot({ path: path.join(OUT, `${tag}-${a}.png`) }); }
  } catch (e) { log('SEQ_FAIL', kind, e.message); }
}

const fps = await p.evaluate(() => {
  const f = window.__f || []; if (f.length < 30) return null;
  const d = []; for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
  d.sort((x, y) => x - y);
  const q = k => d[Math.floor(d.length * k)];
  return { frames: d.length, medianMs: +q(.5).toFixed(2), p95Ms: +q(.95).toFixed(2), p99Ms: +q(.99).toFixed(2), fpsMedian: +(1000 / q(.5)).toFixed(1), fps1pctLow: +(1000 / q(.99)).toFixed(1) };
});
log('FPS ' + JSON.stringify(fps));
const bytes = await p.evaluate(() => performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0));
log('TRANSFER_BYTES ' + bytes);
const text = await p.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 4000));
fs.writeFileSync(path.join(OUT, `${tag}-uitext.txt`), text);
fs.writeFileSync(path.join(OUT, `${tag}-metrics.json`), JSON.stringify({ tTitle, tPlayable, fps, bytes }, null, 2));
await ctx.close();
log('DONE ' + OUT);
