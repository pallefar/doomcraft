/**
 * Capture OURS — the mirror of tools/capture-ref.mjs, pointed at our own build.
 *
 *   node tools/capture-ours.mjs                       # desktop 1440x900
 *   node tools/capture-ours.mjs --mobile              # 412x915  + 4x CPU throttle
 *   node tools/capture-ours.mjs --mobile --landscape  # 915x412  + 4x CPU throttle
 *   node tools/capture-ours.mjs --headed              # real window, real GPU
 *   node tools/capture-ours.mjs --prod                # build + preview instead of dev
 *
 * Same viewports, same twelve screenshot points and the same metrics keys as the
 * reference capture, so `shots/ours-<tag>-NN-*.png` lines up 1:1 with
 * `ref/voxiom/<tag>-NN-*.png` and the two metrics files can be diffed field by
 * field.
 *
 * Output
 *   shots/ours-<tag>-NN-name.png
 *   shots/ours-<tag>-metrics.json    per-run
 *   shots/ours-metrics.json          alias for the run that just finished
 *   shots/ours-<tag>-uitext.txt
 *
 * Two things this measures that the ref script does not, because they decide
 * whether a number means anything:
 *   - `gpu`: the unmasked WebGL renderer. A SwiftShader run is software
 *     rasterisation and its fps must NOT be compared against the bar.
 *   - `cpuThrottle`: the throttle actually applied, verified by timing a spin
 *     loop, the same way BAR.md verified the bar's throttle was genuine.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const MOBILE = has('--mobile');
const LAND = has('--landscape');
const HEADED = has('--headed');
const PROD = has('--prod');
const NO_SERVE = has('--no-serve');
const KEEP = has('--keep');
const THROTTLE = Number(val('--throttle', MOBILE ? '4' : '1'));
const TAG = val('--tag', MOBILE ? (LAND ? 'mobileland' : 'mobile') : 'desktop');
const PORT = Number(val('--port', PROD ? '4173' : '5173'));
const URL = val('--url', `http://localhost:${PORT}/`);

const VIEWPORT = MOBILE
  ? (LAND ? { width: 915, height: 412 } : { width: 412, height: 915 })
  : { width: 1440, height: 900 };

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

/* ------------------------------------------------------------------ *
 * Dev server
 * ------------------------------------------------------------------ */

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(700, () => { s.destroy(); resolve(false); });
  });
}

async function waitForPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });
}

let serverProc = null;

async function ensureServer() {
  if (await portOpen(PORT)) { log(`SERVER already up on :${PORT}`); return; }
  if (NO_SERVE) throw new Error(`nothing listening on :${PORT} and --no-serve was passed`);

  if (PROD) {
    log('BUILD vite build …');
    await run('npx', ['vite', 'build', '--config', 'client/vite.config.ts']);
    log('SERVE vite preview …');
    serverProc = spawn('npx', ['vite', 'preview', '--config', 'client/vite.config.ts', '--port', String(PORT)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    log('SERVE vite dev …');
    serverProc = spawn('npx', ['vite', '--config', 'client/vite.config.ts', '--port', String(PORT)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  serverProc.stdout?.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  serverProc.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  if (!(await waitForPort(PORT, 90_000))) throw new Error('vite did not come up');
  // Vite prints "ready" before the first module graph is warm; give it a beat.
  await new Promise((r) => setTimeout(r, 400));
}

function stopServer() {
  if (serverProc !== null && !KEEP) {
    try { serverProc.kill('SIGTERM'); } catch { /* already gone */ }
    serverProc = null;
  }
}

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

const FPS_PROBE = () => {
  const w = window;
  w.__f = [];
  if (w.__fpsLoopRunning) return;
  w.__fpsLoopRunning = true;
  const loop = (t) => {
    w.__f.push(t);
    if (w.__f.length > 8000) w.__f.shift();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

async function main() {
  await ensureServer();

  const browser = await chromium.launch({
    headless: !HEADED,
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
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 400)));

  await page.addInitScript(FPS_PROBE);

  const cdp = await context.newCDPSession(page);
  if (THROTTLE > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    log(`CPU_THROTTLE ${THROTTLE}x`);
  }

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const tTitle = Date.now() - t0;

  // Interactive = the menu's Play button is live, which is exactly what the ref
  // script measured on voxiom (time until the Battle Royale tile is clickable).
  let tPlayable = -1;
  try {
    await page.waitForFunction(() => window.__DC__ !== undefined && window.__DC__.ready === true,
      null, { timeout: 60_000 });
    tPlayable = Date.now() - t0;
  } catch {
    log('READY_TIMEOUT — dumping diagnostics');
    await page.screenshot({ path: path.join(OUT, `ours-${TAG}-FAILED.png`) });
    const diag = await page.evaluate(() => ({
      dc: typeof window.__DC__,
      stats: window.__DC__ ? window.__DC__.stats() : null,
      boot: document.getElementById('boot-status')?.textContent ?? null,
    })).catch((e) => ({ error: String(e) }));
    log('DIAG ' + JSON.stringify(diag));
    log('CONSOLE_ERRORS ' + JSON.stringify(consoleErrors.slice(0, 8), null, 1));
    log('PAGE_ERRORS ' + JSON.stringify(pageErrors.slice(0, 8), null, 1));
    await browser.close();
    stopServer();
    process.exit(2);
  }

  log(`TIME_TO_TITLE_MS ${tTitle}`);
  log(`TIME_TO_MENU_PLAYABLE_MS ${tPlayable}`);

  // Let the streaming settle so the menu backdrop is the finished world.
  await page.waitForTimeout(900);
  const shot = async (name) => {
    await page.waitForTimeout(320);
    await page.screenshot({ path: path.join(OUT, `ours-${TAG}-${name}.png`) });
  };
  await shot('00-menu');

  /* --- verify the throttle is real, the way BAR.md did --- */
  const spinMs = await page.evaluate(() => {
    const t = performance.now();
    let x = 0;
    for (let i = 0; i < 8_000_000; i++) x += i % 7;
    return { ms: +(performance.now() - t).toFixed(2), x };
  });

  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  log(`GPU ${gpu}`);
  log(`SPIN_8M_MS ${spinMs.ms}`);

  /* --- enter the match --- */
  const box = await page.locator('#game').boundingBox();
  const cx = box ? box.x + box.width / 2 : VIEWPORT.width / 2;
  const cy = box ? box.y + box.height / 2 : VIEWPORT.height / 2;

  const tClick = Date.now();
  await page.evaluate(() => window.__DC__.play());
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(260);
  // Pointer lock is not granted in every environment. Fall back to unlocked
  // deltas so the look drive below actually turns the camera.
  await page.evaluate(() => {
    if (document.pointerLockElement === null) window.__DC__.unlockedLook(true);
  });
  await page.waitForFunction(() => window.__DC__.playing === true, null, { timeout: 15_000 });
  log(`TIME_MENU_TO_INGAME_MS ${Date.now() - tClick}`);
  await shot('01-entering');

  /* --- measure from here: this window is pure gameplay --- */
  await page.evaluate(() => { window.__f = []; });

  /* --- driving ------------------------------------------------------ *
   * The pointer is warped, not teleported: a `mouse.move` back to the centre
   * produces its own movementX/Y and would cancel the sweep it was meant to
   * finish. So the cursor is TRACKED, sweeps are absolute, and re-centring
   * happens with the game's input suspended.
   * ------------------------------------------------------------------ */
  let mx = cx;
  let my = cy;
  const padX = 30;
  const padY = 30;

  const recentre = async () => {
    await page.evaluate(() => window.__DC__.suspendInput(true));
    await page.mouse.move(cx, cy);
    await page.evaluate(() => window.__DC__.suspendInput(false));
    mx = cx; my = cy;
  };

  /** Turn by a pixel delta. Sweeps that would leave the window re-centre first. */
  const look = async (dx, dy, steps = 10) => {
    if (mx + dx < padX || mx + dx > VIEWPORT.width - padX
      || my + dy < padY || my + dy > VIEWPORT.height - padY) {
      await recentre();
    }
    const tx = Math.max(padX, Math.min(VIEWPORT.width - padX, mx + dx));
    const ty = Math.max(padY, Math.min(VIEWPORT.height - padY, my + dy));
    const x0 = mx, y0 = my;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x0 + (tx - x0) * (i / steps), y0 + (ty - y0) * (i / steps));
      await page.waitForTimeout(16);
    }
    mx = tx; my = ty;
  };

  /** Turn, then undo the vertical half so the horizon stays where it was. */
  const sweep = async (dx, dy, steps = 10) => {
    await look(dx, dy, steps);
    if (dy !== 0) await look(0, -dy, Math.max(2, steps >> 1));
  };

  const holdWhile = async (code, ms, fn) => {
    await page.keyboard.down(code);
    await fn();
    await page.waitForTimeout(ms);
    await page.keyboard.up(code);
  };
  const hold = async (code, ms) => {
    await page.keyboard.down(code);
    await page.waitForTimeout(ms);
    await page.keyboard.up(code);
  };

  /**
   * Point somewhere worth photographing. A player who walks into a wall turns
   * around; a harness that does not ends up with twelve pictures of a wall.
   * Both of these steer with real pointer motion — nothing here writes the
   * camera directly.
   */
  const faceOpenGround = async (tries = 9) => {
    for (let i = 0; i < tries; i++) {
      const clear = await page.evaluate(() => window.__DC__.clearance());
      if (clear > 6) return clear;
      // Nose against a wall: step back before turning, the way a player would.
      if (clear < 2.5 && i % 3 === 2) await hold('KeyS', 320);
      await look(210, 0, 5);
    }
    return page.evaluate(() => window.__DC__.clearance());
  };

  const faceEnemy = async (maxDeg = 150) => {
    const aim = await page.evaluate(() => window.__DC__.aimPixels());
    if (aim === null || aim.dist > 90) return false;
    const ppr = await page.evaluate(() => window.__DC__.pixelsPerRadian());
    if (Math.abs(aim.x) > (maxDeg * Math.PI / 180) * ppr) return false;
    // Split the turn so it reads as a flick, not a teleport.
    await look(aim.x * 0.6, aim.y * 0.6, 6);
    const aim2 = await page.evaluate(() => window.__DC__.aimPixels());
    if (aim2 !== null) await look(aim2.x, aim2.y, 4);
    // Pointing at a demon on the far side of a wall is still a picture of a wall.
    const clear = await page.evaluate(() => window.__DC__.clearance());
    if (clear < 3) { await faceOpenGround(); return false; }
    return true;
  };

  const clicks = async (n, button = 'left') => {
    for (let i = 0; i < n; i++) {
      await page.mouse.down({ button });
      await page.waitForTimeout(130);
      await page.mouse.up({ button });
      await page.waitForTimeout(180);
    }
  };

  await faceOpenGround();
  await sweep(220, 0);
  await holdWhile('KeyW', 1200, () => sweep(120, -20, 6));
  await faceOpenGround();
  await shot('02-fwd');

  await sweep(-300, 24);
  await hold('KeyA', 900);
  await faceOpenGround();
  await shot('03-strafe');

  // Catch the shot itself. The muzzle flash lives for 60 ms and the bar has no
  // flash at all (ref/BAR.md weakness #2) — photographing the recovery frame
  // would throw away the whole comparison.
  await faceEnemy();
  await clicks(2);
  await page.mouse.down();
  await page.waitForTimeout(24);
  await page.screenshot({ path: path.join(OUT, `ours-${TAG}-04-shoot.png`) });
  await page.mouse.up();

  // Shotgun: 70 ms of flash, so this one can be photographed mid-shot.
  await page.keyboard.press('Digit2');
  await page.waitForTimeout(520);
  await faceOpenGround();
  await page.mouse.down();
  await page.waitForTimeout(20);
  await page.screenshot({ path: path.join(OUT, `ours-${TAG}-05-weapon2.png`) });
  await page.mouse.up();
  await page.waitForTimeout(200);

  // Chaingun: spun up and firing, so the barrels are turning in the frame.
  await page.keyboard.press('Digit3');
  await page.waitForTimeout(520);
  await faceOpenGround();
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(OUT, `ours-${TAG}-06-weapon3.png`) });
  await page.mouse.up();
  await page.waitForTimeout(150);

  await hold('Space', 220);
  await shot('07-jump');

  // The combat frame. A rocket, because the thing the bar cannot do at all is
  // blow a hole in the level: flash, blast shell, shockwave ring, debris and a
  // crater, all in one frame.
  await page.keyboard.press('Digit4');
  await page.waitForTimeout(600);
  const found = await faceEnemy();
  if (!found) await faceOpenGround();
  await holdWhile('KeyW', 900, async () => { await faceEnemy(); });
  // Put something in front of the rocket, then time the shutter to the flight.
  // A rocket travels at 46 m/s: fired at a wall 12 m away the blast is 260 ms
  // out, and photographing 90 ms after that catches the shell still expanding.
  // With nothing in range, tilt 15 degrees down and blow up the floor instead —
  // 6 m out, which is outside the 4.4 m splash that would kill the cameraman.
  let range = await page.evaluate(() => window.__DC__.clearance());
  if (range > 26) {
    await look(0, 120, 4);
    range = await page.evaluate(() => window.__DC__.clearance());
  }
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
  await page.waitForTimeout(Math.min(760, (Math.min(range, 30) / 46) * 1000 + 90));
  await page.screenshot({ path: path.join(OUT, `ours-${TAG}-08-combat.png`) });
  await page.waitForTimeout(400);
  await look(0, -120, 4);
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(300);

  await page.keyboard.press('KeyB');
  await page.waitForTimeout(420);
  await faceOpenGround();
  await shot('09-build');

  await look(0, 200, 6);              // aim at the floor
  await clicks(2, 'right');           // place blocks
  await clicks(2, 'left');            // and dig one out
  await shot('10-place');
  await page.keyboard.press('KeyB');

  // A last stretch of continuous motion so the 1% low is measured under load,
  // not while standing still.
  await look(0, -200, 6);             // and back up to the horizon
  await holdWhile('KeyW', 2600, async () => {
    await page.keyboard.down('ShiftLeft');
    await sweep(340, -20, 10);
    await sweep(-340, 20, 10);
    await page.keyboard.up('ShiftLeft');
  });

  const fps = await page.evaluate(() => {
    const f = window.__f || [];
    if (f.length < 30) return null;
    const d = [];
    for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
    d.sort((x, y) => x - y);
    const q = (k) => d[Math.floor(d.length * k)];
    return {
      frames: d.length,
      medianMs: +q(0.5).toFixed(2),
      p95Ms: +q(0.95).toFixed(2),
      p99Ms: +q(0.99).toFixed(2),
      fpsMedian: +(1000 / q(0.5)).toFixed(1),
      fps1pctLow: +(1000 / q(0.99)).toFixed(1),
    };
  });
  log('FPS ' + JSON.stringify(fps));

  const stats = await page.evaluate(() => window.__DC__.stats());
  log('GAME ' + JSON.stringify(stats));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await shot('11-esc-menu');

  const bytes = await page.evaluate(
    () => performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0),
  );
  log('TRANSFER_BYTES ' + bytes);

  const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 4000));
  fs.writeFileSync(path.join(OUT, `ours-${TAG}-uitext.txt`), text);

  const metrics = {
    tTitle,
    tPlayable,
    fps,
    bytes,
    /* context the ref file does not carry, but which decides if fps is honest */
    tag: TAG,
    viewport: VIEWPORT,
    cpuThrottle: THROTTLE,
    spin8mMs: spinMs.ms,
    gpu,
    headed: HEADED,
    mode: PROD ? 'preview(prod build)' : 'vite dev',
    url: URL,
    game: stats,
    consoleErrors,
    pageErrors,
  };
  fs.writeFileSync(path.join(OUT, `ours-${TAG}-metrics.json`), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(OUT, 'ours-metrics.json'), JSON.stringify(metrics, null, 2));

  if (consoleErrors.length > 0) log('CONSOLE_ERRORS ' + JSON.stringify(consoleErrors.slice(0, 10), null, 1));
  if (pageErrors.length > 0) log('PAGE_ERRORS ' + JSON.stringify(pageErrors.slice(0, 10), null, 1));

  await browser.close();
  stopServer();
  log('DONE ' + OUT);
}

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
