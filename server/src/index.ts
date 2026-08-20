/**
 * DOOMCRAFT — server entry point.
 *
 * One HTTP server that does three jobs:
 *   1. serves the built client from <repo>/dist in production,
 *   2. exposes the JSON profile / entitlement API used for saved progress,
 *   3. upgrades /ws into the binary game protocol.
 *
 * `PORT` (default 8080) and `DOOMCRAFT_DATA` (default <repo>/server/.data)
 * come from the environment. SIGINT and SIGTERM flush saves and drain sockets
 * before the process exits.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';

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

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
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
  handleApi(req, res, url)
    .then((handled) => {
      if (handled) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'method not allowed'); return; }
      serveStatic(req, res, url.pathname);
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
