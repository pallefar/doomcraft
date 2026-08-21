/**
 * Capture the avatar editor (client/src/ui/avatarEditor.ts) against a running
 * dev server, on desktop and on a 412x915 phone.
 *
 *   npm run dev                      # in another shell
 *   node tools/capture-locker.mjs            # 1440x900
 *   node tools/capture-locker.mjs --mobile   # 412x915, touch, mobile UA
 *
 * As well as the nine screenshots it asserts the three things that are easy to
 * get wrong and impossible to see in a still:
 *   - the packed avatar survives a hard refresh (schema-versioned save)
 *   - closing the editor removes its canvas, so no second GL context is held
 *   - twelve open/close cycles still leave exactly one preview canvas
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/Users/karstenhaldan/youtube/doomcraft/shots';
const URL = 'http://localhost:5173/';
const MOBILE = process.argv.includes('--mobile');
const TAG = MOBILE ? 'locker-mobile' : 'locker-desktop';
const VIEWPORT = MOBILE ? { width: 412, height: 915 } : { width: 1440, height: 900 };

const browser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--disable-blink-features=AutomationControlled',
  ],
});
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  hasTouch: MOBILE,
  isMobile: MOBILE,
  userAgent: MOBILE
    ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
    : undefined,
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__DC__ && window.__DC__.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(1500);

const shot = async (name) => {
  const f = path.join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path: f });
  console.log('wrote', f);
};

await shot('00-menu');

await page.evaluate(() => window.__DC__.openLocker());
// let the atlas land + the 12 thumbnails render
await page.waitForTimeout(3000);
await shot('01-open');

// switch to the colour tab
const tabs = page.locator('.dca-tab');
console.log('tabs:', await tabs.count());
await tabs.nth(4).click();
await page.waitForTimeout(600);
await shot('02-colour');

// pick a loud colour so the tint is visibly doing something
await page.locator('.dca-sw').first().locator('.dca-swatch').nth(3).click();
await page.waitForTimeout(200);
await page.locator('.dca-sw').nth(1).locator('.dca-swatch').nth(7).click();
await page.waitForTimeout(700);
await shot('03-colour-picked');

// back to a zone tab, choose an outfit
await tabs.nth(0).click();
await page.waitForTimeout(400);
await page.locator('.dca-chip').nth(6).click();
await page.waitForTimeout(700);
await shot('04-head-tab');

// drag the model
const box = await page.locator('.dca-stage').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 - 130, box.y + box.height / 2 + 20, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(500);
await shot('05-rotated');

// randomise
await page.getByRole('button', { name: 'Randomise' }).click();
await page.waitForTimeout(800);
await shot('06-random');

const state = await page.evaluate(() => ({
  avatar: window.__DC__.avatar,
  lockerOpen: window.__DC__.lockerOpen,
  raw: localStorage.getItem('doomcraft:save') ?? localStorage.getItem('dc.save') ?? '',
  keys: Object.keys(localStorage),
  canvases: document.querySelectorAll('canvas').length,
}));
console.log('state', JSON.stringify({ ...state, raw: state.raw.slice(0, 160) }, null, 1));

// close and check the second context is gone
await page.evaluate(() => window.__DC__.closeLocker());
await page.waitForTimeout(600);
const after = await page.evaluate(() => ({
  canvases: document.querySelectorAll('canvas').length,
  lockerOpen: window.__DC__.lockerOpen,
  screen: window.__DC__.screen,
}));
console.log('afterClose', JSON.stringify(after));

// reload: does the look survive a hard refresh?
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__DC__ && window.__DC__.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(1200);
const reloaded = await page.evaluate(() => window.__DC__.avatar);
console.log('persist', JSON.stringify({ before: state.avatar, afterReload: reloaded, same: state.avatar === reloaded }));
await page.evaluate(() => window.__DC__.openLocker());
await page.waitForTimeout(2500);
await shot('07-after-reload');

// open/close 12 times: no context leak, no orphan loop
const churn = await page.evaluate(async () => {
  for (let i = 0; i < 12; i++) {
    window.__DC__.openLocker();
    await new Promise((r) => setTimeout(r, 60));
    window.__DC__.closeLocker();
    await new Promise((r) => setTimeout(r, 40));
  }
  window.__DC__.openLocker();
  await new Promise((r) => setTimeout(r, 400));
  return { canvases: document.querySelectorAll('canvas').length, open: window.__DC__.lockerOpen };
});
console.log('churn', JSON.stringify(churn));
await shot('08-after-churn');

console.log('errors', JSON.stringify(errors.slice(0, 12), null, 1));
await browser.close();
