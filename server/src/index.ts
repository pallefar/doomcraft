/**
 * DOOMCRAFT — server entry point.
 *
 * One HTTP server that does six jobs:
 *   1. serves the built client from <repo>/dist in production,
 *   2. exposes the JSON profile / entitlement API used for saved progress,
 *   3. hosts MANY rooms through `ModeRouter` and upgrades /ws into the binary
 *      game protocol, routed by `?mode=&level=&world=&skill=&code=`,
 *   4. answers the room directory / matchmaking API (`/api/rooms`,
 *      `/api/quickplay`) — see directory.ts for why it is never a queue,
 *   5. puts a strict Content-Security-Policy on EVERY response — see the
 *      "Security headers" block below. This is the control that keeps a
 *      third-party ad tag from executing in the game's own origin,
 *   6. drains gracefully on SIGTERM instead of dropping live matches.
 *
 * WHY ROUTING HAPPENS AT UPGRADE TIME, NOT ON `C2S_MODE.SELECT`
 *
 * `Room` has always accepted a `SELECT` and reconfigured itself. That is right
 * for one room per process and wrong for many: a joiner selecting Quest would
 * wipe out the Deathmatch everybody else was in. So the mode travels in the
 * WebSocket URL, the router picks the room BEFORE the socket attaches, and the
 * room is constructed with `lockMode: true` so a later `SELECT` naming a
 * different place is answered with the room's real context and ignored.
 *
 * The environment contract is documented in full in docs/ONLINE.md. The short
 * version: PORT, HOST, DOOMCRAFT_DATA, DOOMCRAFT_STATIC, DOOMCRAFT_ORIGINS,
 * DOOMCRAFT_MAX_ROOMS, DOOMCRAFT_DRAIN_MS. SIGINT and SIGTERM stop admitting
 * new players, let live matches finish inside the drain budget, then flush
 * saves and exit.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { DEFAULT_SERVER_PORT, GameMode, WS_PATH } from '@doomcraft/shared';
import { MODE_KEYS, ModeId } from '@doomcraft/shared/modes';
import { SIGNAL_PATH } from '@doomcraft/shared/signal';
import { Room } from './room.js';
import { setChunkCompressor } from './net.js';
import type { NetTransport } from './net.js';
import {
  DEFAULT_MAX_ROOMS,
  DEFAULT_ROOM_IDLE_MS,
  ModeRouter,
  joinRequestFor,
  roomOptionsFor,
  type ModeJoinRequest,
  type ModeSimPlan,
} from './modes.js';
import {
  PRIVATE_KEY_MARK,
  RoomDirectory,
  UnknownCodeError,
  joinRequestFromQuery,
} from './directory.js';
import { EntitlementGuard, guardProfileWrite } from './entitlementGuard.js';
import { AdminGate, AdminVerdict } from './adminAuth.js';
import { MatchType, SessionOrigin } from '@doomcraft/shared/trust';
import { levelLibrary } from './levels.js';
import {
  FlagService,
  HostDrainingError,
  HostLifecycle,
  stableIdFor,
  versionDocument,
  type LiveRoom,
} from './deploy.js';
import { CONTENT_VERSION, contentHashFor } from '@doomcraft/shared/version';
import { flagConfigETag } from '@doomcraft/shared/flags';
import type { RoomOptions } from './room.js';
import { SignalHub, attachSignalSocket, iceConfigFromEnv, type WsLike } from './signal.js';
import { JsonFileStore, isValidDeviceId, migrateProfile, publicProfile } from './persistence.js';
import type { PersistenceStore } from './persistence.js';

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

/**
 * Rooms this process will hold. The default of 32 is `DEFAULT_MAX_ROOMS`, i.e.
 * ~1,024 players at 32 a room — a long way past what one box wants, so the real
 * limit is set from the cost model in docs/INFRASTRUCTURE.md and not from here.
 */
const MAX_ROOMS = intEnv('DOOMCRAFT_MAX_ROOMS', DEFAULT_MAX_ROOMS, 1, 4096);
/** How long an empty room lingers before the sweeper stops and forgets it. */
const ROOM_IDLE_MS = intEnv('DOOMCRAFT_ROOM_IDLE_MS', DEFAULT_ROOM_IDLE_MS, 5_000, 3_600_000);
/**
 * How long SIGTERM waits for live matches to end before closing them anyway.
 * Must be shorter than the orchestrator's own kill grace period or the process
 * is SIGKILLed mid-drain and the point is lost. Docker Compose and Kubernetes
 * both default to 30 s, so 25 s is the largest safe default.
 */
const DRAIN_MS = intEnv('DOOMCRAFT_DRAIN_MS', 25_000, 0, 30 * 60_000);
/** Build the default room at boot so the first player never waits for terrain. */
const PREWARM = process.env.DOOMCRAFT_PREWARM !== '0';
/**
 * The DEPLOY drain's hard stop, distinct from `DOOMCRAFT_DRAIN_MS` above.
 *
 * A deploy marks a host draining and lets its matches finish; this bounds how
 * long "finish" is allowed to take. Without it one player idling in a Builder
 * world pins an old binary online indefinitely, and "we cannot finish the
 * rollout because of one AFK" is how a fleet ends up running six versions.
 * 30 minutes is docs/INFRASTRUCTURE.md's number, set beyond p99 match length
 * for every mode. See docs/PATCHING.md.
 */
const FORCE_MIGRATE_MS = intEnv('DOOMCRAFT_FORCE_MIGRATE_MS', 30 * 60_000, 0, 6 * 3600_000);
/** Token for `POST /api/admin/drain`. Unset disables the endpoint entirely. */
const ADMIN_TOKEN = (process.env.DOOMCRAFT_ADMIN_TOKEN ?? '').trim();

/**
 * The payment provider that may verify a receipt, or none.
 *
 * `POST /api/entitlement` used to grant the $4.99 ad-free product to any
 * device id, from any origin, on an unverified `receipt` string — its own
 * comment said "a real build verifies `receipt` with the payment provider
 * here" and then granted anyway. That is not an unfinished feature, it is a
 * free product, and the live client calls this exact route.
 *
 * There is no payment provider and none is expected in this stage, so the
 * honest default is REFUSE: unset means the route 404s, exactly as
 * `docs/PLATFORM.md` §2.5 prescribes. `DOOMCRAFT_ENTITLEMENT_PROVIDER=none`
 * binds a no-op provider that grants without verifying — for a local dev box
 * and nothing else, which is why it announces itself at boot and reports
 * `verifies: false` on `/api/version`'s sibling surfaces.
 */
interface ChargingProvider {
  readonly id: string;
  /** False for any provider that cannot actually check a receipt. */
  readonly verifies: boolean;
  verify(product: string, receipt: string | null): Promise<boolean>;
}

const CHARGING_PROVIDER: ChargingProvider | null = ((): ChargingProvider | null => {
  const name = (process.env.DOOMCRAFT_ENTITLEMENT_PROVIDER ?? '').trim().toLowerCase();
  if (name === '') return null;
  if (name === 'none' || name === 'house' || name === 'dev') {
    return {
      id: 'none',
      verifies: false,
      verify: async (): Promise<boolean> => true,
    };
  }
  // An unknown name is a typo in a deploy, and a typo must not silently open
  // the till. Refuse the same way an unset value does, and say why.
  console.warn(`[entitlement] unknown DOOMCRAFT_ENTITLEMENT_PROVIDER "${name}" — the route stays closed`);
  return null;
})();
if (CHARGING_PROVIDER !== null && !CHARGING_PROVIDER.verifies) {
  console.warn('[entitlement] provider "none" grants without verifying a receipt — DEV ONLY');
}

/**
 * Browser origins allowed to open a game socket and to call the JSON API.
 *
 * UNSET means "any origin", which is what a dev box and a single-origin deploy
 * both want and is exactly as permissive as the `access-control-allow-origin: *`
 * this file already shipped. SET means only these, and it is what you want the
 * moment the client is served from somewhere else (a static host) and the game
 * server is a separate origin — see docs/ONLINE.md.
 *
 * A request with NO `Origin` header is always allowed: that is a load test, a
 * health probe or a native client, none of which a browser can forge an origin
 * for, and refusing them would break `tools/loadtest.mjs`.
 */
const ALLOWED_ORIGINS = parseOriginList(process.env.DOOMCRAFT_ORIGINS);

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** `https://a.example, http://localhost:5173` -> a set. `*` means everything. */
function parseOriginList(raw: string | undefined): Set<string> | null {
  const v = (raw ?? '').trim();
  if (v.length === 0 || v === '*') return null;
  const out = new Set<string>();
  for (const part of v.split(',')) {
    const origin = part.trim();
    if (origin.length === 0 || origin.length > 200) continue;
    if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin)) continue;
    out.add(origin.toLowerCase());
  }
  return out.size > 0 ? out : null;
}

/** True when this request may talk to us. No Origin header is always allowed. */
function originAllowed(req: IncomingMessage): boolean {
  if (ALLOWED_ORIGINS === null) return true;
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  return ALLOWED_ORIGINS.has(origin.toLowerCase());
}

/** The value for `access-control-allow-origin`, echoing only what is allowed. */
function corsOrigin(req: IncomingMessage): string | null {
  if (ALLOWED_ORIGINS === null) return '*';
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (typeof origin !== 'string' || origin.length === 0) return null;
  return ALLOWED_ORIGINS.has(origin.toLowerCase()) ? origin : null;
}

function parseMode(v: string | undefined): GameMode {
  switch ((v ?? '').toLowerCase()) {
    case 'horde': return GameMode.HORDE;
    case 'sandbox': return GameMode.SANDBOX;
    default: return GameMode.DEATHMATCH;
  }
}

/** The ModeId a socket with no `?mode=` gets, from `DOOMCRAFT_MODE`. */
function defaultModeId(): ModeId {
  switch (MODE) {
    case GameMode.HORDE: return ModeId.HORDE;
    case GameMode.SANDBOX: return ModeId.BUILDER;
    default: return ModeId.DEATHMATCH;
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
 * The tag that tells the page it is being served by a host that also runs the
 * rooms, so online play needs no configuration at all in this deployment.
 *
 * Why a meta tag and not a build-time constant: the SAME client bundle is
 * served by the static host (which has no rooms) and by this server (which
 * does). A constant baked at build time would have to be different in the two,
 * which means two builds of an identical bundle and a way to get them mixed up.
 * The host that answers the request is the one thing that knows the truth, and
 * it stamps it on the way out.
 *
 * `self` rather than an absolute URL because the origin the browser used is the
 * only correct one: behind a proxy, a CDN, or on localhost, anything this
 * process believes about its own hostname is a guess. `connect-src 'self'` in
 * the CSP above already allows exactly this and nothing else.
 *
 * Read by `resolveServerUrl` in client/src/net/serverConfig.ts.
 */
const SERVER_META = '<meta name="doomcraft-server" content="self">';

/**
 * Stamp the nonce onto every inline `<style>` and `<script>` in the document,
 * inject the shim as the first thing in `<head>`, and advertise that this
 * origin hosts rooms.
 *
 * `<noscript>` and `</script>` do not match: the lookahead requires the tag
 * name to be followed by whitespace or `>`, and a closing tag starts with `</`.
 */
function stampNonce(html: string, nonce: string): string {
  const out = html
    .replace(/<style(?=[\s>])/gi, `<style nonce="${nonce}"`)
    .replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
  const injected = SERVER_META + nonceShim(nonce);
  const head = /<head(\s[^>]*)?>/i.exec(out);
  if (head === null) return injected + out;
  return out.replace(head[0], head[0] + injected);
}

/* ------------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------------ */

const store: PersistenceStore = new JsonFileStore(dataRoot);
const bootMs = Date.now();

/**
 * THE reward gate. One per process, shared by every room, because the
 * session ledger and the audit ring are process-wide facts and a per-room
 * guard would give each room its own private accounting.
 *
 * `docs/ECONOMY.md` decision 1 in its wired form: every payout in this
 * process goes through `guard.submit`, and `guardProfileWrite` closes the
 * other door — the HTTP profile route a client could otherwise post XP to.
 */
const guard = new EntitlementGuard(() => Date.now());

/**
 * The installed campaign. The router uses it as its `ContentResolver`, so a
 * `?level=` naming something that is not on disk lands on a level that is,
 * rather than on an empty room. A library that cannot load is not fatal — the
 * three generated modes do not need it.
 */
const levels = (() => {
  try { return levelLibrary(); } catch { return null; }
})();

/* ------------------------------------------------------------------------ *
 * The room table
 *
 * This is the change docs/INFRASTRUCTURE.md asked for: the process used to hold
 * exactly one `Room` and therefore capped at `MAX_PLAYERS` (32) players. It now
 * holds up to `MAX_ROOMS` of them, keyed by mode and content, created on the
 * first socket that asks for one and reaped once empty.
 * ------------------------------------------------------------------------ */

let draining = false;

/* ------------------------------------------------------------------------ *
 * The deploy tier
 *
 * Two DIFFERENT drains, and conflating them is a mistake worth naming:
 *
 *   - `draining` above is the SHUTDOWN drain. SIGTERM, `DOOMCRAFT_DRAIN_MS`
 *     (25 s by default), bounded by the orchestrator's kill grace period. It
 *     refuses the upgrade outright, because in 25 s this process is gone.
 *   - `lifecycle` below is the DEPLOY drain (docs/PATCHING.md). Hours if it
 *     needs them. It refuses to CREATE a room AND refuses new players into the
 *     rooms it already has, while letting every match already running finish —
 *     so a deploy drops nobody and the host empties as those matches end.
 *     Refusing arrivals is what makes the drain converge: gate creation alone
 *     and a busy key is repopulated as fast as it empties, leaving the
 *     30-minute deadline — measured in dropped players — as the only exit.
 *
 * A deploy uses the second and only then, once the host reports `drained`,
 * the first. That ordering is what makes a rollout free of dropped players.
 * ------------------------------------------------------------------------ */

/** Feature flags, resolved server-side. `DOOMCRAFT_FLAGS` is the boot document. */
const flags = new FlagService();
flags.loadJson(process.env.DOOMCRAFT_FLAGS);

/**
 * The content this PROCESS is on. Each room pins the value it was constructed
 * with, so a room that outlives a deploy keeps serving what its players joined
 * for — see `RoomOptions.contentVersion`.
 */
const contentHash = contentHashFor(
  // Every installed level's own FNV-1a content hash, in the library's stable
  // order. Two hosts on the same CONTENT_VERSION with different level files on
  // disk is a real operational mistake, and comparing `/api/version` between
  // hosts is the only thing that catches it.
  levels === null ? [] : levels.all().map((l) => l.contentHash),
);

/* `lifecycle` and `router` refer to each other — the gate is inside the room
 * factory, and the drain reads the room table — so both need an explicit type
 * annotation to break the inference cycle. */
const lifecycle: HostLifecycle = new HostLifecycle({
  clock: () => Date.now(),
  forceMigrateMs: FORCE_MIGRATE_MS,
  liveRooms: (): LiveRoom[] => router.keys()
    .map((key: string): LiveRoom => ({ key, humans: router.get(key)?.humanCount ?? 0 })),
  stopRoom: (key: string): void => { router.get(key)?.stop(); },
  onDrained: () => {
    process.stdout.write('deploy drain complete: every match finished, no player was dropped\n');
  },
});

const router: ModeRouter<Room> = new ModeRouter<Room>({
  maxRooms: MAX_ROOMS,
  idleMs: ROOM_IDLE_MS,
  levels,
  clock: () => Date.now(),
  overrides: {
    seed: Number.isFinite(SEED) ? SEED >>> 0 : undefined,
    botFill: Number.isFinite(BOT_FILL) ? BOT_FILL : undefined,
  },
  /*
   * Wrapped, so the DEPLOY drain gates the one place a room can come into
   * existence — no matter who calls `route`, now or later. `route` already
   * answers a throw here with a 503 at the upgrade.
   */
  create: lifecycle.guardCreate((key: string, plan: ModeSimPlan, options: RoomOptions): Room => {
    /*
     * How this room came into existence, decided here and nowhere else.
     *
     * A private room is one the directory minted a code for, and its key
     * carries `PRIVATE_KEY_MARK` — a server fact no client can forge, because
     * the client never supplies the key, only a code the directory resolves.
     * `resolveMatchType` clamps both of these anyway (an invite room is PRIVATE
     * however it was requested), so this pair is the intent, not the verdict.
     */
    const isInvite = key.includes(PRIVATE_KEY_MARK);
    const room = new Room({
      ...options,
      store,
      guard,
      sessionOrigin: isInvite ? SessionOrigin.SERVER_INVITE : SessionOrigin.SERVER_MATCHMAKER,
      sessionIntent: isInvite ? MatchType.PRIVATE : MatchType.PUBLIC,
      // A real server generates all 169 chunks once, at room construction; the
      // browser Worker trickles. `roomOptionsFor` already turns this off for an
      // authored Quest level, whose terrain is replaced anyway.
      eagerWorld: options.eagerWorld,
      clock: () => Date.now(),
      levels,
      name: key,
      plan,
      // Many rooms in one process: a `SELECT` naming a different place must not
      // reconfigure this one. See the header note.
      lockMode: true,
      /* --- the patch system, per room --------------------------------- *
       * Content is PINNED here and never re-read: a balance patch reaches
       * every new room at once and no in-flight match has its time-to-kill
       * changed underneath it. Flags are resolved server-side, per player, and
       * transmitted in `S2C.SESSION_CONFIG` — the client never decides. */
      contentVersion: CONTENT_VERSION,
      contentHash,
      /*
       * BOTH drains stop new players, and the deploy one has to or it never
       * converges.
       *
       * Gating only room CREATION leaves every existing room open, so arrivals
       * keep repopulating a host that is trying to leave and the only thing
       * that ever ends the drain is the 30-minute deadline — which is the one
       * outcome the whole design exists to avoid, because that deadline is
       * measured in dropped players. A draining host therefore refuses new
       * HELLOs into the rooms it already has as well, with
       * `UpdateReason.HOST_DRAINING`, which the client reads as "your next
       * match starts on the new host". Everybody already inside is untouched:
       * their matches run to completion and the host drains as they end.
       */
      admitting: () => !draining && lifecycle.admitting,
      resolveFlags: (conn) => flags.bitsFor(stableIdFor(conn)),
    });
    room.start();
    return room;
  }),
});

const directory = new RoomDirectory<Room>({ source: router, clock: () => Date.now() });

/** Reap empty rooms and expired join codes. Cheap, idempotent, unref'd. */
const roomSweeper = setInterval(() => {
  // The deploy drain reaps empty rooms itself and reports when the last match
  // has finished, so it runs even while the shutdown drain has stopped the
  // ordinary sweep.
  lifecycle.tick();
  if (draining) return;
  router.sweep();
  directory.sweep();
  // The ledger keys its TTL on when a session was CREATED, not on when it was
  // last touched, so a room that stays up for more than SESSION_TTL_MS loses
  // its current round's entry and the next payout comes back NO_SESSION —
  // flagged as a violation. Six hours is far beyond any round, so in practice
  // this only reaps rounds that already ended.
  guard.ledger.sweep();
}, 30_000);
if (typeof roomSweeper.unref === 'function') roomSweeper.unref();

/**
 * Build the default room at boot.
 *
 * Not an optimisation for the server — an optimisation for the FIRST player.
 * `eagerWorld` generation plus the bot fill is the only slow part of a join,
 * and doing it before anybody is watching is what keeps the promise in
 * docs/MODES.md that Deathmatch is playable one frame after the click.
 */
const bootRequest: ModeJoinRequest = joinRequestFor(defaultModeId());
if (PREWARM) router.route(bootRequest);

/**
 * The bearer for the three admin routes. See `server/src/adminAuth.ts` for
 * the four things that were wrong with the version that lived here inline.
 *
 * An unset token still means the routes do not exist — they answer 404, not
 * 401, so an unconfigured deployment does not advertise an admin surface. A
 * client that has burned its failure budget gets 429 instead, which is the one
 * new answer.
 *
 * Every refusal writes a line. Until now a brute-force attempt against this
 * bearer left no trace anywhere in the tree, which meant the first evidence of
 * one would have been the drain being pulled on a live fleet.
 */
const adminGate = new AdminGate(ADMIN_TOKEN, {
  clock: () => Date.now(),
  onDenied: (d) => {
    console.warn(`[admin] denied ${d.reason} from ${d.client}${d.path === '' ? '' : ` for ${d.path}`}`);
  },
});
const adminSweeper = setInterval(() => { adminGate.sweep(); }, 60_000);
if (typeof adminSweeper.unref === 'function') adminSweeper.unref();

function admitAdmin(req: IncomingMessage, path: string): AdminVerdict {
  return adminGate.admit(req.headers.authorization, clientAddress(req), path);
}

/** The refusal an admin verdict turns into. Never leaks which token is wrong. */
function refuseAdmin(res: ServerResponse, verdict: AdminVerdict, cors: string | null): void {
  if (verdict === AdminVerdict.THROTTLED) {
    res.setHeader('retry-after', '60');
    sendJson(res, 429, { error: 'too many attempts' }, cors);
    return;
  }
  sendJson(res, 404, { error: 'not found' }, cors);
}

/**
 * "Is this host taking anybody new?" — the ONE question every matchmaking
 * surface has to answer, and the one they used to get wrong.
 *
 * `/health`, `/api/rooms`, `/api/quickplay` and `/api/rooms/private` all used to
 * read the bare `draining` flag, which is the SHUTDOWN drain only. A host that
 * was deploy-draining therefore answered 503 on `/health` while still listing
 * its rooms and still minting tickets pointing at itself — the directory
 * actively contradicting the drain and sending players at a host trying to go
 * away. Both drains mean the same thing to a client, so they are asked as one
 * question here and nowhere else.
 */
function notAdmitting(): boolean {
  return draining || lifecycle.draining;
}

/**
 * A room key with its private join code removed.
 *
 * `docs/PACKS.md` §0.2 item 2: `GET /api/status` is unauthenticated, defaults
 * to `access-control-allow-origin: *`, and returned `router.status()` verbatim
 * — and a private room's key IS its join code: `${roomKey}~${code}`. So the
 * operator page handed every private room in the fleet to anybody who asked,
 * and `/api/rooms` filtering them out (`directory.ts`) bought nothing.
 *
 * `key` is not the only carrier: the router builds each room with `name: key`
 * (see the `create` callback), so `Room.status().name` is the same string and
 * is spread into the same row. Both are cut. The row keeps saying that a
 * private room exists and how full it is, which is what an operator is
 * actually looking at during a rollout; what it stops saying is how to join it.
 */
function redactRoomRow(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  const key = typeof out.key === 'string' ? out.key : '';
  if (!key.includes(PRIVATE_KEY_MARK)) return out;
  out.key = key.slice(0, key.indexOf(PRIVATE_KEY_MARK));
  out.private = true;
  if (typeof out.name === 'string' && out.name.includes(PRIVATE_KEY_MARK)) {
    out.name = out.name.slice(0, out.name.indexOf(PRIVATE_KEY_MARK));
  }
  return out;
}

/** Totals across every live room, for `/health` and the status page. */
function fleetStatus(): Record<string, unknown> {
  let humans = 0;
  let players = 0;
  let connections = 0;
  for (const key of router.keys()) {
    const r = router.get(key);
    if (r === null) continue;
    humans += r.humanCount;
    players += r.sim.players.length;
    connections += r.net.connections.length;
  }
  return { rooms: router.size, maxRooms: MAX_ROOMS, humans, players, connections };
}

/* ------------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, body: unknown, allowOrigin: string | null = '*'): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  };
  // Only ever echo an origin the allowlist already accepted. `vary` matters:
  // a CDN must not serve one origin's permissive response to another origin.
  if (allowOrigin !== null) {
    headers['access-control-allow-origin'] = allowOrigin;
    if (allowOrigin !== '*') headers.vary = 'origin';
  }
  res.writeHead(status, headers);
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

/**
 * The room a status query is about. An explicit `?room=<key>` wins; otherwise
 * the busiest public room, which is what a single-room deploy used to be.
 */
function pickRoom(key: string | null): { key: string; room: Room } | null {
  if (key !== null && key.length > 0) {
    const exact = router.get(key);
    return exact === null ? null : { key, room: exact };
  }
  let best: { key: string; room: Room } | null = null;
  for (const k of router.keys()) {
    /*
     * THE SECOND DOOR onto the same leak `redactRoomRow` closes, found while
     * closing the first. Auto-pick chooses the busiest room, a private room is
     * usually the busiest room on a quiet host, and the response echoes
     * `key` — so `GET /api/scoreboard` with no parameters handed out a live
     * join code to anybody who asked. Naming a private key explicitly is
     * still answered: a caller who has the code already has the code.
     */
    if (RoomDirectory.isPrivateKey(k)) continue;
    const room = router.get(k);
    if (room === null) continue;
    if (best === null || room.humanCount > best.room.humanCount) best = { key: k, room };
  }
  return best;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const cors = corsOrigin(req);

  if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
    const headers: Record<string, string> = {
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    };
    if (cors !== null) {
      headers['access-control-allow-origin'] = cors;
      if (cors !== '*') headers.vary = 'origin';
    }
    res.writeHead(204, headers);
    res.end();
    return true;
  }

  /* --- health ---------------------------------------------------------- *
   * Two states, and the difference is the whole point of having it: a healthy
   * process answers 200, a DRAINING one answers 503 so the load balancer stops
   * sending it new players while the matches already inside it finish. A
   * container orchestrator's liveness probe must therefore point at /health
   * only if it tolerates the drain window — point readiness here, liveness at
   * nothing at all, and let the drain deadline do the killing.
   * --------------------------------------------------------------------- */
  if (path === '/health' || path === '/api/health') {
    // Either drain takes this host out of rotation: the shutdown one because
    // the process is about to be gone, the deploy one because it must stop
    // being handed new rooms. Both are a 503 to a load balancer and neither
    // touches the matches already inside.
    const out = notAdmitting();
    sendJson(res, out ? 503 : 200, {
      ok: !out,
      draining,
      deploy: lifecycle.report(),
      uptimeMs: Date.now() - bootMs,
      protocol: 1,
      version: versionDocument(),
      fleet: fleetStatus(),
    }, cors);
    return true;
  }

  /* --- the three version axes ------------------------------------------ *
   * What a bug report should carry, and what deploy tooling compares between
   * hosts. `protocol.fingerprint` is the interesting field: two hosts claiming
   * the same protocol version but hashing differently is a mixed fleet, which
   * is the failure nobody thinks to look for. See docs/PATCHING.md.
   * --------------------------------------------------------------------- */
  if (path === '/api/version') {
    sendJson(res, 200, versionDocument({ deploy: lifecycle.report() }), cors);
    return true;
  }

  /* --- feature flags ---------------------------------------------------- *
   * The MENU's copy, fetched once per boot, before there is a game socket.
   * The authoritative per-player values ride `S2C.SESSION_CONFIG` on the game
   * connection instead, so this is one request per session and not one per
   * minute per player — docs/INFRASTRUCTURE.md prices the latter at ~$10.8k a
   * month and rejects it. A strong ETag makes even this one a 304 at the edge.
   * --------------------------------------------------------------------- */
  if (path === '/api/flags') {
    const device = url.searchParams.get('device') ?? '';
    const id = isValidDeviceId(device) ? device : 'anonymous';
    const etag = `W/${flagConfigETag(flags.document).slice(0, -1)}-${id.slice(0, 8)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'public, max-age=60, stale-while-revalidate=600' });
      res.end();
      return true;
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, stale-while-revalidate=600',
      etag,
      vary: 'origin',
    };
    if (cors !== null) headers['access-control-allow-origin'] = cors;
    const body = JSON.stringify({
      revision: flags.document.revision,
      frozen: flags.frozen,
      flags: flags.resolveFor(id),
    });
    headers['content-length'] = String(Buffer.byteLength(body));
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  /* --- the operator's two switches -------------------------------------- *
   * Both are refused outright unless `DOOMCRAFT_ADMIN_TOKEN` is set, so a
   * default deployment has no admin surface at all. "Freeze all rollouts" is
   * INFRASTRUCTURE.md's one toggle reachable from a phone; `drain` is how a
   * deploy takes a host out of rotation without dropping a single match.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/drain' && req.method === 'POST') {
    const verdict = admitAdmin(req, path);
    if (verdict !== AdminVerdict.OK) { refuseAdmin(res, verdict, cors); return true; }
    lifecycle.beginDrain();
    sendJson(res, 200, { deploy: lifecycle.report() }, cors);
    return true;
  }

  if (path === '/api/admin/flags' && req.method === 'POST') {
    const verdict = admitAdmin(req, path);
    if (verdict !== AdminVerdict.OK) { refuseAdmin(res, verdict, cors); return true; }
    const doc = flags.load(await readBody(req));
    // Everyone already connected keeps the flags they were resolved with for
    // the life of their session. That is deliberate: a feature appearing or
    // vanishing under a player mid-match is the thing flags exist to prevent.
    sendJson(res, 200, { revision: doc.revision, frozen: doc.frozen, registry: flags.registry() }, cors);
    return true;
  }

  /*
   * The refusal log. Only rejections and strips are recorded, so an empty ring
   * next to a non-zero `accepted` is what a healthy process looks like — and a
   * ring full of NOT_A_PARTICIPANT or CLIENT_REPORTED is somebody probing.
   * Admin-gated exactly like the two switches above: no token, no route.
   */
  if (path === '/api/admin/entitlement' && (req.method === 'GET' || req.method === 'HEAD')) {
    const verdict = admitAdmin(req, path);
    if (verdict !== AdminVerdict.OK) { refuseAdmin(res, verdict, cors); return true; }
    sendJson(res, 200, {
      status: guard.status(),
      recent: guard.recent(64),
      // The other half of "an operator can see the gate running": until now a
      // refused bearer was counted nowhere and logged nowhere.
      auth: { denied: adminGate.denied, throttled: adminGate.throttled },
    }, cors);
    return true;
  }

  if (path === '/api/status') {
    sendJson(res, 200, {
      // The operator's view names both drains separately, because during a
      // rollout "which one am I in" is the question being asked.
      draining: notAdmitting(),
      shutdown: draining,
      deploy: lifecycle.report(),
      fleet: fleetStatus(),
      directory: directory.status(),
      rooms: router.status().map(redactRoomRow),
      // A healthy fleet shows a rising `accepted` and an all-but-empty `codes`
      // map. `violations` climbing is the number worth an alert.
      entitlement: guard.status(),
    }, cors);
    return true;
  }

  if (path === '/api/scoreboard') {
    const target = pickRoom(url.searchParams.get('room'));
    if (target === null) { sendJson(res, 404, { error: 'no such room' }, cors); return true; }
    sendJson(res, 200, { key: target.key, scoreboard: target.room.scoreboard() }, cors);
    return true;
  }

  /* --- the directory ---------------------------------------------------- *
   * Three endpoints and no queue. See directory.ts for why.
   * --------------------------------------------------------------------- */

  if (path === '/api/rooms' && (req.method === 'GET' || req.method === 'HEAD')) {
    const modeParam = (url.searchParams.get('mode') ?? '').toLowerCase();
    const modeIndex = MODE_KEYS.indexOf(modeParam);
    /*
     * A draining host lists NOTHING, and says so.
     *
     * Not merely a flag next to a full list: every room on this host now
     * refuses new HELLOs, so advertising one as `open` would be a lie the
     * client can only discover by opening a socket and being turned away. The
     * operator's view of what is still running is `/api/status` and
     * `/health`.deploy, which are the surfaces that want it.
     */
    const out = notAdmitting();
    sendJson(res, 200, {
      draining: out,
      rooms: out ? [] : directory.list(modeIndex >= 0 ? (modeIndex as ModeId) : undefined),
    }, cors);
    return true;
  }

  /** "Where do I play?" — one round trip, never a wait. */
  if (path === '/api/quickplay') {
    // No ticket may ever point at a host that is going away — that is
    // matchmaking undoing the drain. 503, with the same body shape, so the
    // client's `parseTicket` reads null and falls back exactly as it does for
    // an unreachable server.
    if (notAdmitting()) {
      sendJson(res, 503, { draining: true, ticket: null, error: 'draining' }, cors);
      return true;
    }
    const code = url.searchParams.get('code');
    try {
      const ticket = directory.quickplay(joinRequestFromQuery(url.searchParams), code);
      sendJson(res, 200, { draining: false, ticket }, cors);
    } catch (err) {
      if (err instanceof UnknownCodeError) sendJson(res, 404, { error: 'no such room code' }, cors);
      else throw err;
    }
    return true;
  }

  /** Mint a private room. Nothing is built until somebody actually joins it. */
  if (path === '/api/rooms/private' && req.method === 'POST') {
    // A code minted here names a room that does not exist yet, and a draining
    // host creates none — so the code would be dead on arrival.
    if (notAdmitting()) { sendJson(res, 503, { error: 'draining' }, cors); return true; }
    const body = await readBody(req) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const k of ['mode', 'level', 'world', 'skill', 'seed']) {
      const v = body[k];
      if (typeof v === 'string' || typeof v === 'number') params.set(k, String(v));
    }
    const reservation = directory.createPrivate(joinRequestFromQuery(params));
    if (reservation === null) { sendJson(res, 503, { error: 'too many private rooms' }, cors); return true; }
    sendJson(res, 200, {
      code: reservation.code,
      ticket: directory.quickplay(reservation.req, reservation.code),
    }, cors);
    return true;
  }

  /*
   * A GET THAT DOES NOT WRITE. It used to call `store.ensure`, which creates.
   *
   * `curl ".../api/profile?device=$(openssl rand -hex 6)"` in a loop was
   * therefore unauthenticated, unbounded disk growth at roughly 900 bytes a
   * request, on a route with no rate limit — and nothing in the tree sweeps
   * `<dataRoot>/profiles/`. A device with no profile is not an error state
   * either: the client mints its own id in localStorage and a player who has
   * never finished a match has genuinely never had one written.
   *
   * 404 with no body detail, and `publicProfile` decides what a body may say.
   */
  if (path === '/api/profile' && req.method === 'GET') {
    const deviceId = url.searchParams.get('device') ?? '';
    if (!isValidDeviceId(deviceId)) { sendJson(res, 400, { error: 'bad device id' }, cors); return true; }
    const profile = await store.load(deviceId);
    if (profile === null) { sendJson(res, 404, { error: 'no such profile' }, cors); return true; }
    sendJson(res, 200, { profile: publicProfile(profile) }, cors);
    return true;
  }

  if (path === '/api/profile' && req.method === 'POST') {
    const body = await readBody(req) as Record<string, unknown>;
    const deviceId = String(body.deviceId ?? '');
    if (!isValidDeviceId(deviceId)) { sendJson(res, 400, { error: 'bad device id' }, cors); return true; }
    /*
     * THE OTHER HALF of "the server grants every reward".
     *
     * This route used to merge the client's whole `progress` object into the
     * stored profile, and `migrateProfile`'s only bound on xp is `>= 0` — so a
     * browser could post itself any level it liked without playing a match.
     * `guardProfileWrite` drops every field that is an output of
     * `reviewSubmission` rather than an input from a browser.
     */
    const filtered = guardProfileWrite(body);
    const merged = await store.update(deviceId, (p) => {
      /*
       * Merge `progress` FIELD BY FIELD onto the stored copy rather than
       * replacing it. The filter has just removed xp, kills, wins and the rest
       * from the incoming object; a wholesale replace would therefore read them
       * back as absent and reset them to zero — the guard destroying exactly
       * the counters it exists to protect.
       */
      const sent = filtered.accepted.progress;
      const progress = sent !== null && typeof sent === 'object' && !Array.isArray(sent)
        ? { ...p.progress, ...(sent as Record<string, unknown>) }
        : p.progress;
      // The client may only send the parts it owns; everything is re-validated.
      const incoming = migrateProfile({ ...p, ...filtered.accepted, progress, deviceId }, deviceId);
      p.progress = incoming.progress;
      p.settings = incoming.settings;
      p.bindings = incoming.bindings;
      p.loadout = incoming.loadout;
      // Entitlements are server truth and are never taken from the client.
      p.progress.adsRemoved = p.entitlements.adsRemoved;
      if (p.entitlements.adsRemoved) p.settings.showAds = false;
    });
    /*
     * Say what was dropped rather than accepting it silently. The list is a
     * checked-in constant (`SERVER_OWNED_PROFILE_FIELDS`), so naming it back
     * tells an attacker nothing they could not read in the repo, and it turns
     * "my xp did not save" from a mystery into a one-line answer.
     */
    /*
     * COUNT the refusal, do not merely echo it.
     *
     * `guardProfileWrite` has always returned `violation` and this call site
     * read only `rejectedFields` — so the field had zero readers in the whole
     * tree and the detector for "post your XP straight to /api/profile" was
     * wired to nothing. `guard.noteProfileWrite` puts it in the same counter
     * and the same audit ring as a refused match submission, because they are
     * the same event through a different door.
     */
    if (guard.noteProfileWrite(deviceId, filtered)) {
      console.warn(`[profile] refused ${filtered.rejectedFields.length} server-owned field(s) from ${deviceId}: ${filtered.rejectedFields.slice(0, 8).join(', ')}`);
    }
    sendJson(res, 200, {
      profile: publicProfile(merged),
      rejected: filtered.rejectedFields,
    }, cors);
    return true;
  }

  if (path === '/api/entitlement' && req.method === 'POST') {
    const body = await readBody(req) as Record<string, unknown>;
    const deviceId = String(body.deviceId ?? '');
    const product = String(body.product ?? '');
    const receipt = typeof body.receipt === 'string' ? body.receipt : null;
    if (!isValidDeviceId(deviceId)) { sendJson(res, 400, { error: 'bad device id' }, cors); return true; }
    /*
     * NO PROVIDER, NO GRANT. This route used to hand the paid product to any
     * device id, from any origin, on an unverified `receipt` string, and its
     * own comment said so. `CHARGING_PROVIDER` is null unless an operator
     * deliberately bound one, so the shipping default is a refusal —
     * `docs/PLATFORM.md` §2.5's "404 unless a charging provider is bound".
     * The live client already treats a non-2xx here as "not purchased" and
     * leaves the button alone, so this degrades instead of breaking.
     */
    if (CHARGING_PROVIDER === null) {
      sendJson(res, 404, { error: 'no charging provider is configured', granted: false }, cors);
      return true;
    }
    if (!await CHARGING_PROVIDER.verify(product, receipt)) {
      sendJson(res, 402, { error: 'receipt not verified', granted: false }, cors);
      return true;
    }
    const profile = await store.grantEntitlement(deviceId, product, receipt);
    sendJson(res, 200, { profile: publicProfile(profile), granted: profile.entitlements.adsRemoved }, cors);
    return true;
  }

  /* --- the two routes that are deliberately not here -------------------- *
   *
   * `POST /api/account/link` and `POST /api/account/resolve` are DELETED, and
   * this comment is here so the next person does not helpfully add them back.
   *
   * `link` took `{deviceId, accountId}` unauthenticated, on ANY device id it
   * was handed, and answered with `publicProfile(victim)` PLUS a freshly
   * minted durable secret — a permanent read handle on any profile whose
   * device id you can guess or observe. In the other direction
   * `accountIndex.set(accountId, deviceId)` is unconditional, so re-pointing a
   * victim's `accountId` at an attacker's device makes the victim's own
   * `(accountId, secret)` fail forever, invisibly, while their profile file
   * still says the right thing. `resolve` then turned a bearer secret straight
   * into a profile blob with no session concept anywhere behind it.
   *
   * Both had ZERO callers in `client/` — `grep -rn "/api/account" client/src`
   * is empty — so nothing shipped depended on them. Deleting them is also the
   * precondition for a real provider later (`docs/PLATFORM.md` §2.6): if
   * `link` survives to the day WorkOS lands, an attacker links
   * `workos:<subject>` to their own device BEFORE the real owner ever signs
   * in, and the owner's first sign-in lands on the attacker's profile.
   *
   * `PersistenceStore.linkAccount` / `resolveAccount` are KEPT, with their
   * tests (`sim.test.ts`): they are the substrate a real, authenticated flow
   * re-fronts. Only the unauthenticated HTTP surface is gone.
   * --------------------------------------------------------------------- */

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

/*
 * `perMessageDeflate` stays OFF, deliberately, and the join burst is compressed
 * one layer up instead (`setChunkCompressor` below).
 *
 * Measured on this tree, not assumed. Turning it on does get the join burst
 * from 3.01 MB to 0.80 MB — but it also:
 *   - compresses every 20 Hz snapshot forever, taking steady-state cost from
 *     5.7 to 13.2 millicores/player (players/core 177 -> 76),
 *   - costs 253 ms of server CPU per joiner instead of 67 ms, because a
 *     per-socket deflate stream cannot be shared or cached between joiners,
 *   - allocates a zlib context per connection: +181 KB RSS per connection pair
 *     over 500 sockets, which is the fragmentation caveat in the `ws` README
 *     showing up as a real number on a box the cost model sizes at 2 GB.
 * Compressing the chunk payload explicitly gets the same 3.8x for a one-off
 * per-chunk deflate that every later joiner reads out of a cache.
 */
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

/**
 * The join burst's compressor. `net.ts` cannot import `node:zlib` (it also runs
 * in the browser's local-server Worker), so the real server hands it one here.
 *
 * Level 6 on the RLE stream: 3.79x on measured terrain against 3.59x at level 4
 * and 3.83x at level 9. Bandwidth is the hosting bill, so the extra 0.3 ms of
 * once-per-chunk CPU is bought gladly; level 9 triples it for 1%.
 */
setChunkCompressor((src) => {
  try {
    return deflateRawSync(src, { level: 6 });
  } catch {
    // Never let a compressor fault cost a player their world: net.ts falls
    // back to the uncompressed S2C.CHUNK path on null.
    return null;
  }
});

/* ------------------------------------------------------------------------ *
 * WebRTC signalling
 *
 * The same `ws` server, a different path. This is the whole server-side cost
 * of peer hosting: an SDP offer, an answer and a few ICE candidates relayed
 * once per match. It holds no game state and never sees a game packet — see
 * signal.ts. Peer-hosted rooms award nothing, so there is nothing here worth
 * attacking except the relay itself, which is why the hub rate limits hard.
 * ------------------------------------------------------------------------ */

const signalHub = new SignalHub({ ice: iceConfigFromEnv() });
const signalSweeper = setInterval(() => { signalHub.sweep(); }, 60_000);
if (typeof signalSweeper.unref === 'function') signalSweeper.unref();

/** Behind a load balancer this must come from a TRUSTED proxy header only. */
function clientAddress(req: IncomingMessage): string {
  const trustProxy = process.env.DOOMCRAFT_TRUST_PROXY === '1';
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd;
    if (typeof first === 'string' && first.length > 0) return first.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Refuse an upgrade with a real HTTP status, so the browser sees a reason. */
function refuseUpgrade(socket: { write(s: string): void; destroy(): void }, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\n`
    + 'connection: close\r\n'
    + 'content-length: 0\r\n\r\n',
  );
  socket.destroy();
}

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // A browser cannot forge `Origin`, so this is the one cheap control that
  // stops another site from opening sockets against this fleet on its
  // visitors' behalf. Unset `DOOMCRAFT_ORIGINS` means "any", as documented.
  if (!originAllowed(req)) { refuseUpgrade(socket, 403, 'Forbidden'); return; }

  if (url.pathname === SIGNAL_PATH) {
    if (draining) { refuseUpgrade(socket, 503, 'Draining'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSignalSocket(signalHub, ws as unknown as WsLike, clientAddress(req));
    });
    return;
  }

  if (url.pathname !== WS_PATH) {
    refuseUpgrade(socket, 404, 'Not Found');
    return;
  }

  // Step 3 of the drain: no new players onto a host that is going away. The
  // matches already inside it keep running untouched.
  if (draining) { refuseUpgrade(socket, 503, 'Draining'); return; }

  /* --- which room? ------------------------------------------------------ *
   * Decided here, before a single game byte moves, from the URL. A join code
   * overrides the content key entirely; an unknown code is refused rather than
   * quietly dropped into a public room, because "my friend's code did nothing
   * and I am in a stranger's match" is worse than an error.
   * --------------------------------------------------------------------- */
  const request = joinRequestFromQuery(url.searchParams);
  const codeParam = url.searchParams.get('code');
  let baseKey: string | undefined;
  let joinRequest = request;
  if (codeParam !== null && codeParam.length > 0) {
    const reservation = directory.resolveCode(codeParam);
    if (reservation === null) { refuseUpgrade(socket, 404, 'Unknown Room Code'); return; }
    baseKey = reservation.key;
    joinRequest = reservation.req;
  } else if (url.searchParams.get('mode') === null) {
    // Backwards compatibility: a bare `/ws`, which is what `tools/loadtest.mjs`
    // and every pre-router client open, still lands in the default room.
    joinRequest = bootRequest;
  }

  let routed;
  try {
    routed = router.route(joinRequest, baseKey);
  } catch (err) {
    // Two different 503s. "Draining" is a deploy and the client should look for
    // another host; "No Room Available" is this host being full, and retrying
    // it later is reasonable. Same status, different reason, and the reason is
    // the only thing a human debugging a rollout has to go on.
    refuseUpgrade(socket, 503, err instanceof HostDrainingError ? 'Draining' : 'No Room Available');
    return;
  }
  const { key, room } = routed;

  wss.handleUpgrade(req, socket, head, (ws) => {
    const deviceId = url.searchParams.get('device') ?? '';
    const conn = room.join(new WsTransport(ws));
    if (isValidDeviceId(deviceId)) conn.deviceId = deviceId;
    // Keep the reaper off a room somebody is walking into but has not yet
    // said HELLO in — `humanCount` is still 0 for those few hundred ms.
    router.touch(key);

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
  const first = router.keys()[0] ?? '(none — built on first join)';
  process.stdout.write(
    `doomcraft server listening on http://${HOST}:${PORT}${WS_PATH}\n` +
    `  default room ${first}\n` +
    `  default mode ${MODE_KEYS[defaultModeId()]}  (legacy ${GameMode[MODE]})\n` +
    `  room cap     ${MAX_ROOMS}  (idle reap ${Math.round(ROOM_IDLE_MS / 1000)}s)\n` +
    `  levels       ${levels === null ? 'none' : `${levels.dir}`}\n` +
    `  origins      ${ALLOWED_ORIGINS === null ? '* (any — set DOOMCRAFT_ORIGINS to restrict)' : [...ALLOWED_ORIGINS].join(' ')}\n` +
    `  static root  ${staticRoot}${hasBundle ? '' : '  (no bundle yet — run npm run build)'}\n` +
    `  data root    ${dataRoot}\n` +
    `  drain budget ${Math.round(DRAIN_MS / 1000)}s\n`,
  );
});

/* ------------------------------------------------------------------------ *
 * Graceful drain
 *
 * docs/INFRASTRUCTURE.md §"Rooms are the deploy unit. Drain, never restart."
 * asks for four things, and this is the single-process shape of all four:
 *
 *   1. stop admitting new players     — `draining` gates the /ws upgrade,
 *   2. tell the load balancer         — /health flips to 503,
 *   3. leave live matches alone       — rooms keep ticking, nothing is stopped,
 *   4. exit when the last room empties, bounded by a deadline.
 *
 * What is deliberately NOT here: migrating a live match to another host. That
 * needs the director tier and a `S2C.UPDATE_REQUIRED`-style message the
 * protocol does not have yet (see the note in INFRASTRUCTURE.md on the
 * protocol window). Until then the bound is honest: everybody still playing at
 * `DRAIN_MS` is closed with 1001, and their client reconnects — which, with
 * the router, lands them in a fresh room on the new host.
 * ------------------------------------------------------------------------ */

/** Humans still in a match anywhere in this process. */
function liveHumans(): number {
  let n = 0;
  for (const key of router.keys()) n += router.get(key)?.humanCount ?? 0;
  return n;
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  draining = true;
  // The deploy drain too, so an operator who never called /api/admin/drain
  // still gets "no new rooms" and the "every match finished" report. It is
  // idempotent, so a host that was already draining for a deploy keeps its
  // original deadline rather than being handed a fresh one.
  lifecycle.beginDrain();

  const deadline = Date.now() + DRAIN_MS;
  process.stdout.write(
    `\n${signal}: draining — ${liveHumans()} player(s) in ${router.size} room(s), ` +
    `budget ${Math.round(DRAIN_MS / 1000)}s\n`,
  );

  /* The HTTP listener STAYS UP for the whole drain, and that is the point.
   *
   * A load balancer only learns that this host is going away by asking it, and
   * `/health` is where it asks. Closing the listener here — which is the
   * obvious thing to write — makes the probe fail to CONNECT rather than
   * answer 503, which reads as "the box is gone" to some balancers and as "not
   * yet, retry" to others, and gives the ones in the second camp no reason to
   * stop routing. Refusing the /ws upgrade (see `draining` there) is what
   * actually stops new players; the listener is what tells anybody so.
   * server/src/online.test.ts pins this. */
  clearInterval(roomSweeper);
  clearInterval(signalSweeper);
  // Signalling holds no match state; nothing is lost by ending it at once.
  signalHub.closeAll(1001, 'server shutting down');

  while (Date.now() < deadline && liveHumans() > 0) {
    await new Promise<void>((done) => { setTimeout(done, 250); });
  }

  const stranded = liveHumans();
  if (stranded > 0) {
    process.stdout.write(`drain deadline reached with ${stranded} player(s) still in a match\n`);
  }

  for (const key of router.keys()) {
    const r = router.get(key);
    if (r === null) continue;
    for (const conn of [...r.net.connections]) r.net.detach(conn, 1001, 'server shutting down');
  }
  router.stopAll();
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
  // Only now: every match is over and there is nothing left to tell anybody.
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

export { router, directory, store, httpServer, wss, signalHub };
