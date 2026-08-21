/**
 * DOOMCRAFT — server entry point.
 *
 * One HTTP server that does four jobs:
 *   1. serves the built client from <repo>/dist in production,
 *   2. exposes the JSON profile / entitlement API used for saved progress,
 *   3. upgrades /ws into the binary game protocol,
 *   4. puts a strict Content-Security-Policy on EVERY response — see the
 *      "Security headers" block below. This is the control that keeps a
 *      third-party ad tag from executing in the game's own origin.
 *
 * `PORT` (default 8080) and `DOOMCRAFT_DATA` (default <repo>/server/.data)
 * come from the environment. SIGINT and SIGTERM flush saves and drain sockets
 * before the process exits.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';

import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { DEFAULT_SERVER_PORT, GameMode, WS_PATH } from '@doomcraft/shared';
import { Room } from './room.js';
import type { NetTransport } from './net.js';
import { JsonFileStore, isValidDeviceId, migrateProfile, publicProfile } from './persistence.js';
import type { PersistenceStore, StoredProfile } from './persistence.js';

/* ------------------------------------------------------------------------ *
 * Paths and configuration
 * ------------------------------------------------------------------------ */

const here = fileURLToPath(import.meta.url);
/** server/src/index.ts and server/dist/index.js are both two levels down. */
const repoRoot = resolve(here, '..', '..', '..');
const staticRoot = resolve(process.env.DOOMCRAFT_STATIC ?? join(repoRoot, 'dist'));
const dataRoot = resolve(process.env.DOOMCRAFT_DATA ?? join(repoRoot, 'server', '.data'));

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_SERVER_PORT;
const HOST = process.env.HOST ?? '0.0.0.0';
const MODE = parseMode(process.env.DOOMCRAFT_MODE);
const SEED = Number.parseInt(process.env.DOOMCRAFT_SEED ?? '', 10);
const BOT_FILL = Number.parseInt(process.env.DOOMCRAFT_BOTS ?? '', 10);
const MAX_BODY_BYTES = 64 * 1024;

function parseMode(v: string | undefined): GameMode {
  switch ((v ?? '').toLowerCase()) {
    case 'horde': return GameMode.HORDE;
    case 'sandbox': return GameMode.SANDBOX;
    default: return GameMode.DEATHMATCH;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------------ *
 * Security headers
 *
 * There was no Content-Security-Policy here at all (docs/BUGS-FOUND.md §2).
 * That is about to stop being hygiene debt: the moment a third-party ad tag is
 * served, the CSP is the only thing standing between a compromised creative and
 * the game's own origin — its localStorage, its deviceId, its WebSocket.
 *
 * The policy below was not guessed. It was measured against the shipped bundle
 * (boot, then enter and leave deathmatch, builder and horde, then play) and
 * tightened until the browser reported ZERO violations. Starting from
 * `default-src 'self'` the real game produced exactly four classes of them:
 *
 *   14x style-src-elem    every mode's UI does `document.createElement('style')`
 *    3x style-src-attr    a `style="text-align:right"` in the scoreboard header
 *    1x script-src-elem   the `window.__DC_T0__` first-paint stamp in index.html
 *    1x img-src data:     the inline SVG favicon
 *
 * No worker violation, in dev or prod: Vite emits both the mesher worker and
 * the local-server worker as same-origin module URLs, so `'self'` covers them.
 * `blob:` is kept in `worker-src` anyway — a bundler change that inlines a
 * worker must not be able to break the mesher, because a broken mesher is how a
 * CSP gets deleted instead of fixed.
 *
 * How the inline cases are handled, in order of preference:
 *
 *   - A fresh nonce per response, stamped onto the `<style>` and `<script>` in
 *     index.html as it is served. Hashes were the alternative and were rejected:
 *     a hash covers only the markup in the file, and 14 of the 15 inline styles
 *     are created at runtime by JavaScript, so a hash policy would have shipped
 *     an unstyled HUD.
 *   - Those runtime `<style>` elements get the same nonce from a five-line shim
 *     injected with the page (`nonceShim`). It is a shim, and it is marked as
 *     one: the moment style injection goes through a shared helper that can read
 *     the nonce itself, delete `nonceShim` and this paragraph with it.
 *   - `style-src-attr 'unsafe-inline'` is the one relaxation, and it is scoped
 *     to *attributes only*. A style attribute cannot load a script, cannot
 *     import, and cannot reach the network; `style-src-elem` stays nonce-only,
 *     so no third party can inject a stylesheet. This is deliberately NOT the
 *     blanket `style-src 'unsafe-inline'` that would also re-open `<style>`.
 *
 * `script-src` has no `'unsafe-inline'` and no `'unsafe-eval'`. That is the
 * whole point of the exercise: an ad network tag cannot run here unless someone
 * adds its origin to this file on purpose.
 * ------------------------------------------------------------------------ */

/**
 * Extra origins allowed to supply sponsor creative, as a comma-separated list
 * of `https://host[:port]`. They are added to `img-src` and `frame-src` and to
 * nothing else — never to `script-src`. Anything that is not a plain https
 * origin is dropped rather than passed through into the header.
 */
const SPONSOR_ORIGINS = parseOrigins(process.env.DOOMCRAFT_SPONSOR_ORIGIN);
/** Optional collector for violation reports. */
const CSP_REPORT_URI = sanitizeReportUri(process.env.DOOMCRAFT_CSP_REPORT_URI);
/**
 * Ship the policy as `-Report-Only` for one deploy when adding a new surface,
 * so violations are collected instead of breaking players. Never the default.
 */
const CSP_REPORT_ONLY = process.env.DOOMCRAFT_CSP_REPORT_ONLY === '1';

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const origin = part.trim();
    if (origin.length === 0 || origin.length > 200) continue;
    if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin)) continue;
    out.push(origin);
  }
  return out;
}

function sanitizeReportUri(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (v.length === 0 || v.length > 300) return null;
  // A header value must not carry a separator or a newline into the response.
  if (/[\s;,]/.test(v)) return null;
  if (!/^(https:\/\/[a-z0-9.-]+(:\d{1,5})?)?\/[^\s;,]*$/i.test(v)) return null;
  return v;
}

/** The policy for one response. `nonce` is fresh per request. */
function contentSecurityPolicy(nonce: string): string {
  const sponsors = SPONSOR_ORIGINS.length > 0 ? ' ' + SPONSOR_ORIGINS.join(' ') : '';
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // No handler attributes anywhere. Nothing in this game uses one.
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    // Attributes only — see the note above. `style-src-elem` stays nonce-gated.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob:${sponsors}`,
    "font-src 'self'",
    "media-src 'self'",
    // Same-origin module workers; blob: as the bundler-change safety valve.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    // 'self' also covers ws:// and wss:// back to this exact origin.
    "connect-src 'self'",
    // A sponsor iframe must be named here explicitly before it can ever load.
    SPONSOR_ORIGINS.length > 0 ? `frame-src${sponsors}` : "frame-src 'none'",
    "manifest-src 'self'",
    // An aggregator portal must not be able to frame the game and stack its own
    // ads on top of ours — that is ad fraud against our own sponsors.
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ];
  if (CSP_REPORT_URI !== null) directives.push(`report-uri ${CSP_REPORT_URI}`);
  return directives.join('; ');
}

/**
 * Applied at the top of the request handler, so a route added later cannot
 * forget it: `writeHead(status, headers)` merges with anything already set by
 * `setHeader`, and the per-route headers win where they overlap.
 */
function applySecurityHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader(
    CSP_REPORT_ONLY ? 'content-security-policy-report-only' : 'content-security-policy',
    contentSecurityPolicy(nonce),
  );
  res.setHeader('x-content-type-options', 'nosniff');
  // For anything too old to honour frame-ancestors.
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'no-referrer');
  // ...-allow-popups, because a sponsor click-out opens a window on purpose.
  res.setHeader('cross-origin-opener-policy', 'same-origin-allow-popups');
  res.setHeader(
    'permissions-policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=(), midi=()',
  );
}

/**
 * The shim that gives runtime-created `<style>` elements the page's nonce.
 *
 * Every mode's UI builds its stylesheet with `document.createElement('style')`.
 * CSP checks a style element when it is inserted, exactly as if it had been in
 * the markup, so without a nonce all fourteen of them are blocked and the HUD
 * ships unstyled. Patching the constructor is the smallest change that fixes
 * all fourteen without touching fourteen files.
 *
 * DELETE ME once `<style>` creation goes through one helper in the client that
 * can read the nonce off the document itself.
 */
function nonceShim(nonce: string): string {
  const n = JSON.stringify(nonce);
  return `<script nonce="${nonce}">(function(n){try{`
    + 'var C=Document.prototype.createElement;'
    + 'Document.prototype.createElement=function(t,o){'
    + 'var e=C.call(this,t,o);'
    + 'try{if(String(t).toLowerCase()==="style")e.setAttribute("nonce",n)}catch(_){}'
    + 'return e};'
    + `}catch(_){}})(${n});</script>`;
}

/** Cache of the raw HTML on disk, keyed by path, invalidated by mtime. */
const htmlCache = new Map<string, { mtimeMs: number; text: string }>();

function readHtml(target: string, mtimeMs: number): string {
  const hit = htmlCache.get(target);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.text;
  const text = readFileSync(target, 'utf8');
  htmlCache.set(target, { mtimeMs, text });
  return text;
}

/**
 * Stamp the nonce onto every inline `<style>` and `<script>` in the document
 * and inject the shim as the first thing in `<head>`.
 *
 * `<noscript>` and `</script>` do not match: the lookahead requires the tag
 * name to be followed by whitespace or `>`, and a closing tag starts with `</`.
 */
function stampNonce(html: string, nonce: string): string {
  const out = html
    .replace(/<style(?=[\s>])/gi, `<style nonce="${nonce}"`)
    .replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
  const head = /<head(\s[^>]*)?>/i.exec(out);
  if (head === null) return nonceShim(nonce) + out;
  return out.replace(head[0], head[0] + nonceShim(nonce));
}

/* ------------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------------ */

const store: PersistenceStore = new JsonFileStore(dataRoot);
const bootMs = Date.now();

const room = new Room({
  seed: Number.isFinite(SEED) ? SEED >>> 0 : undefined,
  mode: MODE,
  botFill: Number.isFinite(BOT_FILL) ? BOT_FILL : undefined,
  store,
  eagerWorld: true,
  clock: () => Date.now(),
  name: process.env.DOOMCRAFT_ROOM ?? 'doomcraft-1',
});
room.start();

/* ------------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolvePromise({}); return; }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(new Error('invalid json'));
      }
    });
    req.on('error', rejectPromise);
  });
}

/** Resolve a URL path inside the static root, refusing anything that escapes it. */
function resolveStatic(pathname: string): string | null {
  const decoded = safeDecode(pathname);
  if (decoded === null) return null;
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(join(staticRoot, clean));
  if (target !== staticRoot && !target.startsWith(staticRoot + sep)) return null;
  return target;
}

function safeDecode(v: string): string | null {
  try { return decodeURIComponent(v); } catch { return null; }
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, nonce: string): void {
  if (!existsSync(staticRoot)) {
    sendText(res, 503, 'client bundle not built — run `npm run build`');
    return;
  }
  let target = resolveStatic(pathname === '/' ? '/index.html' : pathname);
  if (target === null) { sendText(res, 403, 'forbidden'); return; }

  let stats = existsSync(target) ? statSync(target) : null;
  if (stats?.isDirectory()) {
    target = join(target, 'index.html');
    stats = existsSync(target) ? statSync(target) : null;
  }
  if (!stats) {
    // Single-page fallback so deep links land on the game.
    target = join(staticRoot, 'index.html');
    stats = existsSync(target) ? statSync(target) : null;
    if (!stats) { sendText(res, 404, 'not found'); return; }
  }

  const ext = extname(target).toLowerCase();
  const immutable = target.includes(`${sep}a${sep}`) && ext !== '.html';
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': String(stats.size),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };

  // The document carries this response's nonce, so it can never be cached or
  // revalidated into a page whose nonce no longer matches its header.
  if (ext === '.html') {
    const body = Buffer.from(stampNonce(readHtml(target, stats.mtimeMs), nonce), 'utf8');
    headers['content-length'] = String(body.length);
    headers['cache-control'] = 'no-store';
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    res.writeHead(200, headers);
    res.end(body);
    return;
  }

  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  res.writeHead(200, headers);
  const stream = createReadStream(target);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;

  if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    res.end();
    return true;
  }

  if (path === '/health' || path === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      uptimeMs: Date.now() - bootMs,
      protocol: 1,
      room: room.status(),
    });
    return true;
  }

  if (path === '/api/status') {
    sendJson(res, 200, { room: room.status(), scoreboard: room.scoreboard() });
    return true;
  }

  if (path === '/api/scoreboard') {
    sendJson(res, 200, { scoreboard: room.scoreboard() });
    return true;
  }

  if (path === '/api/profile' && req.method === 'GET') {
    const deviceId = url.searchParams.get('device') ?? '';
    if (!isValidDeviceId(deviceId)) { sendJson(res, 400, { error: 'bad device id' }); return true; }
    const profile = await store.ensure(deviceId);
    sendJson(res, 200, { profile: publicProfile(profile) });
    return true;
  }

  if (path === '/api/profile' && req.method === 'POST') {
    const body = await readBody(req) as Record<string, unknown>;
    const deviceId = String(body.deviceId ?? '');
    if (!isValidDeviceId(deviceId)) { sendJson(res, 400, { error: 'bad device id' }); return true; }
    const merged = await store.update(deviceId, (p) => {
      // The client may only send the parts it owns; everything is re-validated.
      const incoming = migrateProfile({ ...p, ...body, deviceId }, deviceId);
      p.progress = incoming.progress;
      p.settings = incoming.settings;
      p.bindings = incoming.bindings;
      p.loadout = incoming.loadout;
      // Entitlements are server truth and are never taken from the client.
      p.progress.adsRemoved = p.entitlements.adsRemoved;
      if (p.entitlements.adsRemoved) p.settings.showAds = false;
    });
    sendJson(res, 200, { profile: publicProfile(merged) });
    return true;
  }

  if (path === '/api/entitlement' && req.method === 'POST') {
    const body = await readBody(req) as Record<string, unknown>;
    const deviceId = String(body.deviceId ?? '');
    const product = String(body.product ?? '');
    const receipt = typeof body.receipt === 'string' ? body.receipt : null;
    if (!isValidDeviceId(deviceId)) { sendJson(res, 400, { error: 'bad device id' }); return true; }
    // A real build verifies `receipt` with the payment provider here. Until a
    // provider is wired up this endpoint is the single place that decides, so
    // the client can never grant itself the entitlement.
    const profile = await store.grantEntitlement(deviceId, product, receipt);
    sendJson(res, 200, { profile: publicProfile(profile), granted: profile.entitlements.adsRemoved });
    return true;
  }

  if (path === '/api/account/link' && req.method === 'POST') {
    const body = await readBody(req) as Record<string, unknown>;
    const deviceId = String(body.deviceId ?? '');
    const accountId = String(body.accountId ?? '');
    if (!isValidDeviceId(deviceId) || accountId.length < 3 || accountId.length > 64) {
      sendJson(res, 400, { error: 'bad request' });
      return true;
    }
    const { profile, secret } = await store.linkAccount(deviceId, accountId);
    sendJson(res, 200, { profile: publicProfile(profile), secret });
    return true;
  }

  if (path === '/api/account/resolve' && req.method === 'POST') {
    const body = await readBody(req) as Record<string, unknown>;
    const accountId = String(body.accountId ?? '');
    const secret = String(body.secret ?? '');
    const profile: StoredProfile | null = await store.resolveAccount(accountId, secret);
    if (!profile) { sendJson(res, 404, { error: 'no such account' }); return true; }
    sendJson(res, 200, { profile: publicProfile(profile) });
    return true;
  }

  return false;
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // One nonce per response, set before anything can start writing. Every route
  // below — JSON, plain text, static, and the error paths — inherits it.
  const nonce = randomBytes(16).toString('base64');
  applySecurityHeaders(res, nonce);
  handleApi(req, res, url)
    .then((handled) => {
      if (handled) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'method not allowed'); return; }
      serveStatic(req, res, url.pathname, nonce);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'error';
      sendJson(res, message === 'body too large' ? 413 : 400, { error: message });
    });
});

/* ------------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------------ */

class WsTransport implements NetTransport {
  constructor(private readonly socket: WebSocket) {}
  get isOpen(): boolean { return this.socket.readyState === 1; }
  get bufferedAmount(): number { return this.socket.bufferedAmount; }
  send(data: Uint8Array): void {
    if (this.socket.readyState !== 1) return;
    this.socket.send(data, { binary: true });
  }
  close(code = 1000, reason = ''): void {
    try { this.socket.close(code, reason); } catch { /* already closing */ }
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const deviceId = url.searchParams.get('device') ?? '';
    const conn = room.join(new WsTransport(ws));
    if (isValidDeviceId(deviceId)) conn.deviceId = deviceId;

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (Array.isArray(data)) {
        room.receive(conn, Buffer.concat(data));
      } else if (data instanceof ArrayBuffer) {
        room.receive(conn, new Uint8Array(data));
      } else {
        room.receive(conn, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    });
    ws.on('close', () => { room.leave(conn); });
    ws.on('error', () => { room.leave(conn); });
  });
});

/* ------------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------------ */

httpServer.listen(PORT, HOST, () => {
  const hasBundle = existsSync(join(staticRoot, 'index.html'));
  process.stdout.write(
    `doomcraft server listening on http://${HOST}:${PORT}${WS_PATH}\n` +
    `  world seed   ${room.seed}\n` +
    `  game mode    ${GameMode[room.gameMode]}\n` +
    `  static root  ${staticRoot}${hasBundle ? '' : '  (no bundle yet — run npm run build)'}\n` +
    `  data root    ${dataRoot}\n`,
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${signal}: draining…\n`);

  room.stop();
  for (const conn of [...room.net.connections]) room.net.detach(conn, 1001, 'server shutting down');
  for (const client of wss.clients) {
    try { client.close(1001, 'server shutting down'); } catch { /* ignore */ }
  }

  const forced = setTimeout(() => {
    process.stdout.write('shutdown timed out, exiting\n');
    process.exit(1);
  }, 5000);
  if (typeof forced.unref === 'function') forced.unref();

  try { await store.flush(); await store.close(); } catch { /* best effort */ }
  await new Promise<void>((done) => { wss.close(() => done()); });
  await new Promise<void>((done) => { httpServer.close(() => done()); });
  clearTimeout(forced);
  process.stdout.write('bye\n');
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('uncaughtException', (err) => {
  process.stderr.write(`uncaught: ${String(err instanceof Error ? err.stack : err)}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`unhandled rejection: ${String(err)}\n`);
});

export { room, store, httpServer, wss };
