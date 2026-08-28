/**
 * Boot the real client, enter Builder, flip to SURVIVAL (KeyG), open the
 * palette (KeyB), click the Craft chip, screenshot the bench; then craft a
 * recipe and screenshot again. Evidence for the crafting-bench stage.
 * Run from the repo root: node <this file>
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import net from 'node:net';

const PORT = 5199;
const URL = `http://localhost:${PORT}/`;

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

const vite = spawn('npx', ['vite', '--config', 'client/vite.config.ts', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stdout?.resume(); vite.stderr?.resume();

try {
  if (!(await waitForPort(PORT, 90_000))) throw new Error('vite did not come up');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true, null, { timeout: 60_000 });
  const entered = await page.evaluate(() => window.__DC__.enterMode('builder'));
  console.log('ENTERED', entered);
  await page.mouse.click(720, 450);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    if (document.pointerLockElement === null) window.__DC__.unlockedLook(true);
  });
  await page.waitForFunction(() => window.__DC__.playing === true, null, { timeout: 20_000 });
  await page.waitForTimeout(1500);

  // Survival variant, then mine nothing — the starter kit stocks the bench.
  console.log('S0', await page.evaluate(() => window.__DC__.screen), JSON.stringify(await page.evaluate(() => window.__DC__.stats().activeKey ?? window.__DC__.stats())).slice(0,120));
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(600);
  console.log('S1', await page.evaluate(() => window.__DC__.screen));
  await page.evaluate(() => {
    const el = document.querySelector('.dcb-pick');
    window.__pickLog = [];
    new MutationObserver(() => window.__pickLog.push(el.style.display + '@' + performance.now().toFixed(0)))
      .observe(el, { attributes: true, attributeFilter: ['style'] });
  });
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(600);
  console.log('PICKLOG', JSON.stringify(await page.evaluate(() => window.__pickLog)));
  console.log('S2', await page.evaluate(() => window.__DC__.screen), await page.evaluate(() => [...document.querySelectorAll('.dcb-pick')].map(e=>e.style.display).join(',')), 'modeKey', await page.evaluate(() => window.__DC__.modeKey));
  await page.screenshot({ path: 'shots/craft-debug.png' });
  const st = await page.evaluate(() => ({
    pick: document.querySelector('.dcb-pick') !== null,
    pickShown: (document.querySelector('.dcb-pick') || {}).style?.display,
    craftChip: document.querySelector('.dcb-craft') !== null,
    craftShown: (document.querySelector('.dcb-craft') || {}).style?.display,
    toasts: [...document.querySelectorAll('#hud *')].slice(0,0),
  }));
  console.log('STATE', JSON.stringify(st));
  await page.click('.dcb-craft');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shots/craft-bench-open.png' });

  // Craft the first affordable recipe (stone -> brick from the starter kit).
  const before = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.dcb-item')];
    return cells.map((c) => c.textContent);
  });
  const idx = before.findIndex((t) => t !== null && t.includes('craft up to'));
  if (idx < 0) throw new Error('no affordable recipe rendered: ' + JSON.stringify(before));
  await page.click(`.dcb-item >> nth=${idx}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shots/craft-bench-crafted.png' });
  const after = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.dcb-item')];
    return cells.map((c) => c.textContent);
  });
  console.log('BEFORE', before[idx]);
  console.log('AFTER ', after[idx]);
  await browser.close();
  console.log('OK shots/craft-bench-open.png shots/craft-bench-crafted.png');
} finally {
  vite.kill('SIGKILL');
}
