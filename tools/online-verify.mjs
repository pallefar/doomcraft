/**
 * DOOMCRAFT — can two real browsers play together, and does offline still work?
 *
 *   node tools/online-verify.mjs          # both
 *   node tools/online-verify.mjs online   # two browsers against a real server
 *   node tools/online-verify.mjs offline  # the static bundle with no server
 *
 * `server/src/online.test.ts` already proves the multi-room server at the WIRE
 * level, with real sockets and the real binary protocol, and it runs in CI. This
 * is the layer above that one cannot reach: **the shipped bundle, in Chromium,
 * driven through the real menu.** It is here because the headline claim of the
 * online work is "two browsers can play together", and a claim about browsers
 * has to be checked in browsers.
 *
 * Requires a build (`npx vite build --config client/vite.config.ts`) and
 * playwright's chromium. Exits non-zero on the first failed assertion, so it is
 * usable as a release gate.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');

let failures = 0;
const ok = (m) => { console.log(`  ok   ${m}`); };
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };
const note = (m) => { console.log(`       ${m}`); };

function requireBuild() {
  if (existsSync(join(DIST, 'index.html'))) return;
  console.error('no client bundle in dist/ — run: npx vite build --config client/vite.config.ts');
  process.exit(2);
}

/** Wait until `fn()` is true in the page. Throws with a readable label. */
async function until(page, fn, timeout, label) {
  try {
    await page.waitForFunction(fn, undefined, { timeout, polling: 200 });
  } catch {
    throw new Error(`timed out waiting for ${label}`);
  }
}

async function booted(page) {
  await until(page, () => window.__DC__?.game?.ready === true, 60_000, 'boot');
}

/* ------------------------------------------------------------------------ *
 * Offline: the static bundle, a dumb file server, no game server anywhere.
 * This is exactly the doomcraft.vercel.app deployment.
 * ------------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary',
};

async function runOffline() {
  console.log('\noffline — the static build, no server anywhere');
  const port = 9300 + Math.floor(Math.random() * 300);
  const files = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    let f = resolve(join(DIST, p === '/' ? 'index.html' : p));
    if (!f.startsWith(DIST) || !existsSync(f) || statSync(f).isDirectory()) f = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  await new Promise((r) => files.listen(port, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${port}`;

  // The static document must NOT advertise a server. Only the Node origin does.
  if (readFileSync(join(DIST, 'index.html'), 'utf8').includes('doomcraft-server')) {
    fail('the static index.html advertises a server — it must not');
  } else ok('static index.html advertises no server');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
    // Anything leaving the origin is a bug in an offline-capable build.
    const offOrigin = [];
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) offOrigin.push(u);
      route.continue();
    });

    const t0 = Date.now();
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await booted(page);
    ok(`booted in ${Date.now() - t0} ms with no server anywhere`);

    const s = await page.evaluate(() => ({
      configured: window.__DC__.game.session.configured,
      kind: window.__DC__.game.session.current.kind,
      reason: window.__DC__.game.session.current.reason,
      strip: !!document.querySelector('.dc-online'),
    }));
    note(JSON.stringify(s));
    if (s.configured) fail('a static build must not report a configured server');
    else ok('serverUrl is empty; the client never looks for a server');
    if (s.strip) fail('the online strip is in the DOM of an offline build');
    else ok('no online UI in the offline menu');

    for (const mode of ['deathmatch', 'quest', 'builder', 'horde']) {
      const t = Date.now();
      const got = await page.evaluate((m) => window.__DC__.enterMode(m), mode);
      await until(
        page,
        () => window.__DC__.game.net.status === 'playing' && window.__DC__.game.net.world.chunkCount >= 9,
        40_000,
        `${mode} to become live`,
      );
      const kind = await page.evaluate(() => window.__DC__.game.session.current.kind);
      if (got !== mode || kind !== 'local') fail(`${mode}: entered "${got}" on a ${kind} session`);
      else ok(`${mode}: playable offline in ${Date.now() - t} ms`);
      await page.evaluate(() => window.__DC__.leaveMode());
    }

    if (offOrigin.length) fail(`off-origin requests: ${offOrigin.join(', ')}`);
    else ok('zero off-origin requests');
  } finally {
    await browser.close();
    files.close();
  }
}

/* ------------------------------------------------------------------------ *
 * Online: the real server binary, two independent browser contexts.
 * ------------------------------------------------------------------------ */

async function runOnline() {
  console.log('\nonline — two browsers, one server, one room');
  const port = 8800 + Math.floor(Math.random() * 400);
  const origin = `http://127.0.0.1:${port}`;
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-online-verify-'));
  const srv = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'server/src/index.ts')], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: DIST,
      DOOMCRAFT_DATA: dataRoot,
      // No bots, so every body in a snapshot is one of the two browsers.
      DOOMCRAFT_BOTS: '0',
      NODE_OPTIONS: '',
    },
  });
  let log = '';
  srv.stdout.on('data', (c) => { log += String(c); });
  srv.stderr.on('data', (c) => { log += String(c); });

  const deadline = Date.now() + 45_000;
  for (;;) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) { console.error(log); throw new Error('server never came up'); }
    await new Promise((r) => { setTimeout(r, 150); });
  }
  ok('server up');

  const html = await (await fetch(`${origin}/`)).text();
  if (!html.includes('name="doomcraft-server"')) fail('the served document does not advertise the server');
  else ok('the served document advertises the server (meta doomcraft-server)');

  const browser = await chromium.launch();
  try {
    const pages = [];
    for (const name of ['Alpha', 'Bravo']) {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 620 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => fail(`[${name}] pageerror: ${e.message}`));
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      pages.push({ name, page });
    }
    for (const { name, page } of pages) { await booted(page); ok(`${name}: booted`); }

    // Boot is always the Worker room, so time-to-interactive never pays for a
    // network round trip. The switch happens on Play.
    const bootKind = await pages[0].page.evaluate(() => window.__DC__.game.session.current.kind);
    if (bootKind !== 'local') fail(`boot session should be local, was ${bootKind}`);
    else ok('boot session is local — the offline path is unchanged');

    for (const { name, page } of pages) {
      await page.evaluate(() => window.__DC__.enterMode('deathmatch'));
      await until(
        page,
        () => window.__DC__?.game?.session?.current?.kind === 'remote',
        40_000,
        `${name} to reach a remote session`,
      );
      const st = await page.evaluate(() => window.__DC__.game.session.current);
      ok(`${name}: session=${st.kind} url=${st.url} reason="${st.reason}"`);
    }

    const rooms = await (await fetch(`${origin}/api/rooms`)).json();
    const dm = rooms.rooms.find((r) => r.key === 'deathmatch');
    if (!dm) fail('no deathmatch room on the server');
    else if (dm.humans !== 2) fail(`the server sees ${dm.humans} humans, expected 2`);
    else ok('the server sees ONE room "deathmatch" with 2 humans');

    for (const { name, page } of pages) {
      await until(
        page,
        () => window.__DC__.game.net.players.filter((p) => p.active).length >= 2,
        30_000,
        `${name} to see the other player`,
      );
      const seen = await page.evaluate(() => {
        const net = window.__DC__.game.net;
        return {
          me: net.playerId,
          others: net.players.filter((p) => p.active && !p.isLocal).map((p) => p.id),
        };
      });
      ok(`${name}: playerId=${seen.me}, sees ${JSON.stringify(seen.others)}`);
    }

    // The real claim: input in one browser moves the body the other RENDERS.
    const before = await pages[1].page.evaluate(() => {
      const o = window.__DC__.game.net.players.find((p) => p.active && !p.isLocal);
      return { id: o.id, x: o.x, z: o.z };
    });
    await pages[0].page.evaluate(() => { window.__DC__.game.allowUnlockedLook(true); });
    await pages[0].page.keyboard.down('w');
    await new Promise((r) => { setTimeout(r, 3000); });
    await pages[0].page.keyboard.up('w');
    await new Promise((r) => { setTimeout(r, 600); });
    const after = await pages[1].page.evaluate((id) => {
      const o = window.__DC__.game.net.players.find((p) => p.active && p.id === id);
      return o ? { x: o.x, z: o.z } : null;
    }, before.id);
    const moved = after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
    if (moved > 0.5) ok(`Bravo saw Alpha's body move ${moved.toFixed(2)} m from a real keypress`);
    else fail(`Bravo saw Alpha move only ${moved.toFixed(2)} m`);

    // Kill the server outright. Both must end up in a PLAYABLE local room —
    // not a spinner, not a dead menu.
    srv.kill('SIGKILL');
    for (const { name, page } of pages) {
      await until(
        page,
        () => window.__DC__?.game?.session?.current?.kind === 'local'
          && window.__DC__.game.net.status === 'playing'
          && window.__DC__.game.net.world.chunkCount >= 9,
        60_000,
        `${name} to fall back into a live local room`,
      );
      const st = await page.evaluate(() => ({
        reason: window.__DC__.game.session.current.reason,
        chunks: window.__DC__.game.net.world.chunkCount,
      }));
      ok(`${name}: server killed -> local "${st.reason}", ${st.chunks} chunks, playing`);
    }
  } finally {
    await browser.close();
    try { srv.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

/* ------------------------------------------------------------------------ */

requireBuild();
const which = (process.argv[2] ?? 'both').toLowerCase();
try {
  if (which === 'both' || which === 'offline') await runOffline();
  if (which === 'both' || which === 'online') await runOnline();
} catch (err) {
  fail(err.message);
}
console.log(failures === 0 ? '\nall assertions passed' : `\n${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
