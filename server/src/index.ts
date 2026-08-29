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
 * DOOMCRAFT_MAX_ROOMS, DOOMCRAFT_DRAIN_MS, DOOMCRAFT_JOURNAL_DAYS,
 * DOOMCRAFT_FINANCIAL_DAYS. SIGINT and SIGTERM stop admitting new players, let
 * live matches finish inside the drain budget, then flush saves and exit.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import type { ConnectionStats, NetTransport } from './net.js';
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
import { AdminGate, AdminVerdict, AttemptThrottle, type AdminDecision } from './adminAuth.js';
import {
  AccountStore,
  NAME_MAX,
  NAME_MIN,
  PASSPHRASE_MIN,
  SessionTable,
  cookieValue,
  expiredSessionCookie,
  nameKeyOf,
  passphraseOk,
  publicAccount,
  sessionCookie,
  sessionCredential,
} from './accounts.js';
import { AccountGraph, JsonGraphBackend, countableProfile } from './accountGraph.js';
import { mergeDeviceIntoAccount, planMerge, readMergeLog, undoMerge } from './merge.js';
import { ReferralService } from './referrals.js';
import { TradeService, type TradeResult } from './trades.js';
import { CompetitionService } from './competitions.js';
import { renderShareCard } from './shareCard.js';
import { parseItemRef, type ItemDef, type ItemKind } from '@doomcraft/shared/items';
import { asAccountId, asDeviceId } from '@doomcraft/shared/identity';
import { MatchType, SessionOrigin } from '@doomcraft/shared/trust';
import { levelLibrary } from './levels.js';
import { compileLevel, parseLevelJson } from '@doomcraft/shared/level';
import { renderLevelPreview } from './studioPreview.js';
import {
  FlagService,
  HOST_ID,
  HostDrainingError,
  HostLifecycle,
  stableIdFor,
  versionDocument,
  type LiveRoom,
} from './deploy.js';
import {
  DEFAULT_FINANCIAL_DAYS,
  DEFAULT_JOURNAL_DAYS,
  JsonJournal,
  newLedgerId,
  redactPlayerId,
} from './journal.js';
import {
  AdminAuditLog,
  DEFAULT_AUDIT_DAYS,
  redactProfileKey,
  requireMutationFields,
} from './adminAudit.js';
import { ADMIN_CONSOLE_HTML, adminSignInHtml } from './admin/console.js';
import {
  connectionRollup,
  consoleCapabilities,
  flagRegistryView,
  playerLookup,
  redactGuardAudit,
} from './admin/model.js';
import { CONTENT_VERSION } from '@doomcraft/shared/version';
import { PackInventory, ReleaseService, releaseContentHash, rollMatchDrops } from './packs.js';
import { StudioService } from './studio.js';
import { AdService } from './ads.js';
import { CreativeStore, IMAGE_MAX_BYTES } from './creatives.js';
import { PHASE_ONE_SURFACES, type AdEventType, type SurfaceId } from '@doomcraft/shared/sponsor';
import { PackKind } from '@doomcraft/shared/packs';
import { flagOn } from '@doomcraft/shared/flags';
import { utcDayKey, utcWeekKey } from '@doomcraft/shared/challenges';
import {
  ROLLOUT_LADDER,
  anonymousFlagBits,
  flagConfigETag,
  planFlagWrite,
  unpackFlags,
} from '@doomcraft/shared/flags';
import type { RoomOptions } from './room.js';
import { SignalHub, attachSignalSocket, iceConfigFromEnv, type WsLike } from './signal.js';
import { JsonFileStore, MAX_SCRAP_BALANCE, applyEquip, createProfile, equipVerdict, grantDrops, isValidDeviceId, migrateProfile, publicProfile, serialiseProfile } from './persistence.js';
import { CRAFT_COPIES, applyCraft, craftVerdict } from './craft.js';
import type { EquipSlot, PersistenceStore, StoredProfile } from './persistence.js';

/* ------------------------------------------------------------------------ *
 * Paths and configuration
 * ------------------------------------------------------------------------ */

const here = fileURLToPath(import.meta.url);
/** server/src/index.ts and server/dist/index.js are both two levels down. */
const repoRoot = resolve(here, '..', '..', '..');
const staticRoot = resolve(process.env.DOOMCRAFT_STATIC ?? join(repoRoot, 'dist'));
const dataRoot = resolve(process.env.DOOMCRAFT_DATA ?? join(repoRoot, 'server', '.data'));

/*
 * THE WRITABILITY PROBE — run at boot, carried on /api/version, and LOUD.
 *
 * Every durable store under dataRoot swallows its own write errors, each
 * for a locally good reason ("an unwritable doc must not break play").
 * Together those good reasons compose into the worst failure this host
 * has had: on 2026-08-28 the Railway volume turned out to be mounted
 * root-owned under `USER node`, and every profile, account, journal and
 * release write since 2026-08-22 had failed SILENTLY — the host looked
 * healthy while holding everything in memory and losing it on each
 * deploy. A data root that cannot be written is not an inconvenience to
 * shrug at; it is data loss with a delay. So it is checked ONCE, here,
 * where it can scream.
 */
let dataWritable = true;
let dataWriteError = '';
try {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(dataRoot, '.writable'), new Date().toISOString(), 'utf8');
} catch (e) {
  dataWritable = false;
  dataWriteError = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `\n!!! DOOMCRAFT_DATA (${dataRoot}) IS NOT WRITABLE: ${dataWriteError}\n`
    + '!!! Every profile, account, journal and release write on this host WILL BE LOST.\n'
    + '!!! On Railway: check the volume is mounted at the data root and owned by the\n'
    + '!!! container user (railway ssh -- chown node:node /data).\n\n',
  );
}

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
 * THE ACCOUNTS, beside the profiles and under the same `DOOMCRAFT_DATA`.
 *
 * `server/src/accounts.ts` holds the rule that matters: the FIRST account
 * created on this host becomes its owner, decided under the store's write lock
 * so two signups in the same tick cannot both win it. Everything else here is
 * plumbing.
 *
 * Loaded eagerly, before the first request can arrive, for one reason: the
 * bootstrap decision reads `ownerCount()`, and an `AccountStore` that has not
 * read its file yet reports zero. `signup()` awaits `ready()` inside the lock
 * as well, so this is belt and braces rather than the only guard — but the
 * `/admin` page also asks `ownerCount()` and would otherwise offer to create an
 * owner on a host that already has one.
 */
const accounts = new AccountStore(dataRoot, { clock: () => Date.now() });
void accounts.ready();

/**
 * Sessions. IN MEMORY, and they die with the process — see `accounts.ts` and
 * the line the console prints saying so. One box, one operator; a session store
 * on disk is a credential at rest with no expiry anybody can see.
 */
const sessions = new SessionTable();

/* --- C4: the player identity graph (docs/PLATFORM.md §2.3) --------------- *
 * The passphrase account (above) is the CREDENTIAL; this graph is the
 * device->profile authority: which profile file a device's play banks to,
 * and the single-use tickets the WebSocket upgrade admits with. The legacy
 * linkAccount/accountIndex substrate stops being written from here on —
 * the graph is the one resolver.                                            */
const graph = new AccountGraph(new JsonGraphBackend(dataRoot));

/* Viral tier 1 (docs/ECONOMY.md "Viral sharing"): codes, first-wins
 * attribution, engagement conversion through the journal, caps + queue. */
const referrals = new ReferralService(dataRoot);

/* Trading (docs/ECONOMY.md "Trading"): the two-sided escrow. The engine owns
 * every rule; the routes below own identity and transport only. `recover()`
 * runs at boot, just before listen, to finish any settling trade a crash
 * left behind. */
const trades = new TradeService(dataRoot);

/* Competitions (docs/ECONOMY.md "Competitions"): auto-rolling seasons and
 * operator-created tournaments on a state-based ladder. Accrual rides the
 * same onProfilePersisted seam as referrals and is gated on NOTHING —
 * turning the tab off mid-season must never lose a season. */
const competitions = new CompetitionService(dataRoot);

/** Where a share card points its reader. Overridable per deployment. */
const SHARE_HOST = process.env.DOOMCRAFT_SHARE_HOST ?? 'doomcraft.vercel.app';

/** The graph's name for a passphrase account. One player, one id. The
 * account store already namespaces its ids (`house:<hex>`), so the graph
 * adopts them verbatim — `pass:house:<hex>` would be two namespaces deep
 * and a lie about the provider. */
function graphIdFor(accountId: string): ReturnType<typeof asAccountId> {
  return asAccountId(accountId.includes(':') ? accountId : `pass:${accountId}`);
}

/* The dc_dev device cookie — the Safari ITP fix (docs/INFRASTRUCTURE.md):
 * script-written localStorage is evicted after 7 idle days, so a returning
 * player on day 8 silently lost everything. A server-set httpOnly cookie
 * with a 400-day max-age survives; the client mirrors it via POST
 * /api/device, which answers with the id the cookie remembers. */
const DEVICE_COOKIE = 'dc_dev';
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
function deviceCookie(id: string): string {
  return `${DEVICE_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`;
}
/** The cookie's word beats the body's — the cookie is the one the caller cannot typo. */
function deviceFromRequest(req: IncomingMessage, body: Record<string, unknown> | null): string | null {
  const fromCookie = cookieValue(req.headers.cookie, DEVICE_COOKIE);
  if (fromCookie !== null && isValidDeviceId(fromCookie)) return fromCookie;
  const fromBody = typeof body?.deviceId === 'string' ? body.deviceId : '';
  return isValidDeviceId(fromBody) ? fromBody : null;
}

/* C6: the two-phase confirm with delay. The first call banks an intent and
 * answers 428 with the token and the earliest usable moment; a confirm
 * inside the delay window is refused (425, token still live), so a
 * double-click cannot ban anybody, and an unknown or expired token starts
 * over rather than guessing. */
const ADMIN_CONFIRM_DELAY_MS = Math.max(0, Number(process.env.DOOMCRAFT_CONFIRM_DELAY_MS ?? 3000));
const ADMIN_CONFIRM_TTL_MS = 5 * 60_000;
const adminIntents = new Map<string, { token: string; notBeforeMs: number; expiresMs: number }>();
function requireConfirm(key: string, provided: unknown, now: number): { status: number; body: Record<string, unknown> } | null {
  const held = adminIntents.get(key);
  if (typeof provided === 'string' && held !== undefined && provided === held.token) {
    if (now > held.expiresMs) {
      adminIntents.delete(key);
    } else if (now < held.notBeforeMs) {
      return { status: 425, body: { error: 'confirm inside the delay window — wait, then resend', notBeforeMs: held.notBeforeMs } };
    } else {
      adminIntents.delete(key);
      return null;
    }
  }
  const token = randomBytes(12).toString('hex');
  adminIntents.set(key, { token, notBeforeMs: now + ADMIN_CONFIRM_DELAY_MS, expiresMs: now + ADMIN_CONFIRM_TTL_MS });
  return { status: 428, body: { error: 'confirm required', confirmToken: token, notBeforeMs: now + ADMIN_CONFIRM_DELAY_MS } };
}

/** The audit log's name for a profile key — the handle, never the id. */
function hashDeviceForAudit(profileKey: string): string {
  return redactPlayerId(profileKey);
}

/** The §3.2.1 question's numbers — what is at stake on this device. */
function askSummary(profile: StoredProfile): Record<string, number | string> {
  return {
    level: profile.progress.level,
    xp: profile.progress.xp,
    scrap: profile.economy.scrap,
    matches: profile.stats.matches,
    firstPlayedMs: profile.createdMs,
    name: profile.progress.name,
  };
}

/**
 * The failure budget for `/api/auth/signup` and `/api/auth/signin`, with the
 * same numbers as the admin bearer's (20 a minute per client address) and the
 * opposite ordering — see `AttemptThrottle` for why a scrypt route must refuse
 * before it hashes and a sha-256 compare need not.
 */
const authThrottle = new AttemptThrottle();

/**
 * THE REWARD JOURNAL. Append-only NDJSON beside the profile store.
 *
 * Constructed here, next to `store`, because it is the same kind of thing and
 * because the two have to agree: `Room.persistMember` writes a row from inside
 * `store.update`'s callback, under the same per-device lock that moved the
 * balance. Nothing else in this process may write one.
 *
 * A journal cannot be backfilled from balances, which is why it lands now
 * rather than with the merge that needs it. See `server/src/journal.ts`.
 */
const journal = new JsonJournal(dataRoot, {
  clock: () => Date.now(),
  journalDays: envDays('DOOMCRAFT_JOURNAL_DAYS', DEFAULT_JOURNAL_DAYS),
  financialDays: envDays('DOOMCRAFT_FINANCIAL_DAYS', DEFAULT_FINANCIAL_DAYS),
});
/* Seed the 48 h idempotency set from disk BEFORE the first match can end, so a
 * payout retried across a restart is refused rather than paid twice. */
void journal.ready();
/* Retention. One sweep at boot and one every six hours: a day file is the unit,
 * so there is nothing to do more often than that. */
void journal.sweep();
const journalSweeper = setInterval(() => {
  void journal.sweep();
  void auditLog.sweep();
}, 6 * 60 * 60 * 1000);
if (typeof journalSweeper.unref === 'function') journalSweeper.unref();

/**
 * THE ADMIN ACTION LOG. Append-only NDJSON beside the reward journal.
 *
 * Every mutating admin route writes one row with its `before` and `after`
 * state, so `docs/PLATFORM.md` §5.8's "undo is the real reviewer" is a property
 * of the file rather than a slogan: the operator can read what the document was
 * and put it back.
 *
 * Constructed here rather than inside the console module on purpose. The
 * console is a page; the log is a fact about this process, and it must exist
 * whether or not anybody ever opens the page — `curl` writes rows too.
 */
const auditLog = new AdminAuditLog(dataRoot, {
  clock: () => Date.now(),
  days: envDays('DOOMCRAFT_AUDIT_DAYS', DEFAULT_AUDIT_DAYS),
});
void auditLog.ready();
void auditLog.sweep();

function envDays(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '');
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

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

/**
 * What `/api/version` says about the release tier: the live pack set per
 * pack, what is pending, and what this host cannot satisfy — `unsatisfied`
 * non-empty is Rule E visible from the outside (the host is refusing a
 * release and serving the previous one, docs/PACKS.md 8.6).
 */
function releaseView(): Record<string, unknown> {
  const doc = releases.document();
  const live = releases.live();
  const pendingRelease = doc.history.find((r) => r.revision === doc.pendingRevision) ?? null;
  return {
    release: {
      revision: live.revision,
      ordinal: live.ordinal,
      frozen: doc.frozen,
      packs: live.packs.map((p) => ({
        label: p.label, cls: p.digest.length > 0 ? 'data' : 'build',
        fingerprint: p.fingerprint, digest: p.digest,
      })),
      unsatisfied: live.revision === 0 ? [] : inventory.unsatisfied(live),
      pending: pendingRelease === null ? null : {
        revision: pendingRelease.revision,
        ordinal: pendingRelease.ordinal,
        rolloutBp: pendingRelease.rolloutBp,
        unsatisfied: inventory.unsatisfied(pendingRelease),
      },
    },
  };
}

/** The live items pack's id set — what `itemStateFor` derives ACTIVE from. */
function liveItemIdSet(): ReadonlySet<string> {
  const decl = releases.live().packs.find((pk) => pk.kind === PackKind.ITEMS);
  const installed = decl === undefined ? null : inventory.itemsAt(decl.version);
  return new Set((installed?.manifest.items ?? []).map((i) => i.id));
}

/** The live items pack as localId -> def — what "tradable" and ACTIVE mean. */
function liveItemDefs(): ReadonlyMap<string, ItemDef> {
  const decl = releases.live().packs.find((pk) => pk.kind === PackKind.ITEMS);
  const installed = decl === undefined ? null : inventory.itemsAt(decl.version);
  return new Map((installed?.manifest.items ?? []).map((i) => [i.id, i]));
}

/** The compact before/after an audit row carries; full state lives in releases.json. */
function releaseSummary(): string {
  const doc = releases.document();
  return JSON.stringify({
    revision: doc.revision,
    live: doc.liveRevision,
    pending: doc.pendingRevision,
    frozen: doc.frozen,
    states: doc.history.map((r) => `${r.revision}:${r.state}@${r.ordinal}`),
  });
}

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
/**
 * THE PACK TIER (docs/PACKS.md phase 2). The inventory is what is INSTALLED
 * on this host — versioned pack directories under `DOOMCRAFT_PACKS`, falling
 * back to `content/` as version 1 so an unconfigured deploy behaves exactly
 * as before. The release service is which installed versions are LIVE:
 * durable under `DOOMCRAFT_DATA`, CAS on every mutation, one audit line per
 * transition in `release.jsonl`. Two hosts on the same CONTENT_VERSION with
 * different files on disk still differ in `/api/version` — the data packs'
 * fingerprints carry that difference, per pack and reviewable.
 */
const inventory = new PackInventory({ packsRoot: process.env.DOOMCRAFT_PACKS ?? null });
const releases = new ReleaseService(dataRoot, inventory, { clock: () => Date.now() });
/**
 * THE CREATOR STUDIO (docs/STUDIO.md): the operator authors data packs from
 * the panel; saves mint NEW version directories under DOOMCRAFT_PACKS and
 * still walk the release machine to reach a player. Build-class designs
 * (weapons, characters) land as drafts for the platform lane.
 */
/**
 * THE AD PLATFORM, phase 1 (docs/SPONSORS.md): decide → fill → measure →
 * event → redirect, server-authoritative, house-backed. Campaigns are
 * operator-authored in $DOOMCRAFT_DATA/sponsors.json; every counted event
 * lands in ads.jsonl because billing is a batch job over a log.
 */
/* §2.2 — content-addressed creatives, operator lane. The store answers the
 * decide path with the stored file's OWN dimensions, so a display fill can
 * never be a shape the slot did not book. */
const creatives = new CreativeStore(dataRoot);
const ads = new AdService(dataRoot, {
  clock: () => Date.now(),
  assetFor: (sha256) => creatives.info(sha256),
});

const studio = new StudioService(inventory, {
  packsRoot: process.env.DOOMCRAFT_PACKS ?? null,
  dataRoot,
  clock: () => Date.now(),
});
/** The fleet-agreement number: the LIVE release's identity, pending excluded. */
const contentHash = (): number => releaseContentHash(releases.live());

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
    /*
     * WHICH RELEASE THIS ROOM RUNS, decided once, here, and pinned. The
     * instance id is minted with randomBytes — never the room key (~36 fixed
     * strings under MAX_ROOMS, so a partial rollout would select the same
     * zero rooms forever) and never options.seed (client-suppliable) — see
     * docs/PACKS.md 8.1. The resolver is total: a bad document falls back to
     * the builtin release rather than 503ing every upgrade (8.3).
     */
    const roomInstanceId = randomBytes(8).toString('hex');
    const release = releases.resolveFor(roomInstanceId);
    /* The items version challenge rewards are formatted against — pinned
     * once, read by both the defs filter and the settlement. */
    const challengeItemVersion = release.packs.find((pk) => pk.kind === PackKind.ITEMS)?.version
      ?? (inventory.itemsVersions().at(-1) ?? 1);
    const room = new Room({
      ...options,
      store,
      guard,
      journal,
      /* Viral tier 1: a paying round may newly satisfy the referred
       * player's engagement threshold. Fire-and-forget by contract. */
      onProfilePersisted: (profileKey) => {
        void referrals.sweep(profileKey, { store, journal });
        void competitions.sweep(profileKey, { store, journal });
      },
      hostId: HOST_ID,
      sessionOrigin: isInvite ? SessionOrigin.SERVER_INVITE : SessionOrigin.SERVER_MATCHMAKER,
      sessionIntent: isInvite ? MatchType.PRIVATE : MatchType.PUBLIC,
      // A real server generates all 169 chunks once, at room construction; the
      // browser Worker trickles. `roomOptionsFor` already turns this off for an
      // authored Quest level, whose terrain is replaced anyway.
      eagerWorld: options.eagerWorld,
      clock: () => Date.now(),
      /* The release's OWN levels, version-bound and frozen (8.9): a reload or
       * a later release must never change what an in-flight Quest room
       * resolves for its next campaign level. Falls back to the shared
       * library when the release names no installed levels version. */
      levels: inventory.viewFor(release) ?? levels,
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
      contentVersion: release.ordinal,
      contentHash: releaseContentHash(release),
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
      /* Item drops, from THIS room's pinned release — the room never learns
       * the release tier exists. Dark until the economy_items flag resolves
       * on for the member; reward.ts zeroes the roll for idle rounds. */
      rollDrops: (ctx) => {
        if (!flagOn(ctx.flagBits, 'economy_items')) return [];
        const decl = release.packs.find((pk) => pk.kind === PackKind.ITEMS);
        if (decl === undefined) return [];
        const installed = inventory.itemsAt(decl.version);
        if (installed === null) return [];
        return rollMatchDrops(installed.manifest, decl.version, Math.random);
      },
      /* Challenge defs, from THIS room's pinned release when it names a
       * quests version; releases cut before S4 name none, so the newest
       * installed pack (bundle quests@1 at minimum) keeps the feature live
       * rather than dark until the next promote. Item rewards format against
       * the pinned items version, exactly as drops do. */
      challenges: (() => {
        const qdecl = release.packs.find((pk) => pk.kind === PackKind.QUESTS);
        const qi = qdecl !== undefined
          ? inventory.questsAt(qdecl.version)
          : inventory.questsAt(inventory.questsVersions().at(-1) ?? 1);
        const defs = qi?.manifest.challenges ?? [];
        /* The gate checks quests.refs against the items version THE SAME
         * DRAFT names — but a release that names no quests pack falls back
         * to the newest installed one, a pairing no gate ever saw (a
         * rollback to a pre-S4 release is the live example). Re-check the
         * pairing HERE, at pin time, and drop a def whose item id is not in
         * the pinned items manifest: a challenge that cannot pay the reward
         * it advertises must not be on the board at all. */
        const pinnedItems = inventory.itemsAt(challengeItemVersion);
        const known = new Set((pinnedItems?.manifest.items ?? []).map((i) => i.id));
        return defs.filter((d) => d.item === null || known.has(d.item));
      })(),
      challengeItemVersion,
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
  // Expired sessions go out on the same timer. They are in memory, so this is
  // a bound on the map's size and nothing more — the expiry itself is checked
  // on every resolve, so a swept-late session was never admitted.
  sessions.sweep(Date.now());
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
  /*
   * THE SECOND CREDENTIAL. A session token resolves to an account, and the
   * account's role is read LIVE on every request — so an owner demoted by
   * `POST /api/admin/owner/transfer` stops being admitted on their existing
   * session immediately, without anybody having to hunt down its token.
   */
  resolveSession: (token) => {
    const row = sessions.resolve(token, Date.now());
    if (row === null) return null;
    const role = accounts.roleOf(row.accountId);
    return role === null ? null : { accountId: row.accountId, role };
  },
  ownerCount: () => accounts.ownerCount(),
});
const adminSweeper = setInterval(() => { adminGate.sweep(); authThrottle.sweep(Date.now()); }, 60_000);
if (typeof adminSweeper.unref === 'function') adminSweeper.unref();

function admitAdmin(req: IncomingMessage, path: string): AdminDecision {
  return adminGate.admitRequest(
    { authorization: req.headers.authorization, sessionToken: sessionCredential(req.headers) },
    clientAddress(req),
    path,
  );
}

/**
 * The refusal an admin verdict turns into. Never leaks which token is wrong.
 *
 * Three answers, and the 403 is the new one. A caller holding a session this
 * host minted already knows the host has accounts, so hiding the console behind
 * a 404 from them buys nothing and costs a support ticket; every OTHER refusal
 * still answers 404, identical to a host with no admin surface at all.
 */
function refuseAdmin(res: ServerResponse, verdict: AdminVerdict, cors: string | null): void {
  if (verdict === AdminVerdict.THROTTLED) {
    res.setHeader('retry-after', '60');
    sendJson(res, 429, { error: 'too many attempts' }, cors);
    return;
  }
  if (verdict === AdminVerdict.FORBIDDEN) {
    sendJson(res, 403, { error: 'this console is for the owner account' }, cors);
    return;
  }
  sendJson(res, 404, { error: 'not found' }, cors);
}

/**
 * The sentence a refused signup gets.
 *
 * Spelled out rather than echoed as a code, because the two failures a human
 * hits are "my name has a space in it" and "twelve characters, really?", and a
 * form that says `bad-name` makes them guess. `name-taken` is deliberately
 * distinguishable: a signup form that hides it is a form that cannot be used.
 */
function signupErrorText(error: 'bad-name' | 'bad-passphrase' | 'name-taken'): string {
  switch (error) {
    case 'bad-name':
      return `name must be ${NAME_MIN}-${NAME_MAX} characters of a-z, 0-9, _ or -`;
    case 'bad-passphrase':
      return `passphrase must be at least ${PASSPHRASE_MIN} characters`;
    default:
      return 'that name is taken';
  }
}

/** The public shape of one account id, or null when it has gone. */
function publicAccountOrNull(accountId: string): ReturnType<typeof publicAccount> | null {
  const a = accounts.byId(accountId);
  return a === null ? null : publicAccount(a);
}

/** Correlates an audit row with the response the operator saw. */
function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Every live connection's counters, for the console's metrics screen.
 *
 * `ConnectionStats` is maintained on every connection and, until this call
 * site, was aggregated nowhere and served nowhere — the bandwidth-per-player
 * and reconciliation-correction numbers `docs/INFRASTRUCTURE.md` calls the
 * metrics nobody instruments were already in memory. Reading them costs one
 * pass over the room table and emits no event.
 */
function allConnectionStats(): ConnectionStats[] {
  const out: ConnectionStats[] = [];
  for (const key of router.keys()) {
    const room = router.get(key);
    if (room === null) continue;
    for (const conn of room.net.connections) out.push(conn.stats);
  }
  return out;
}

/**
 * The operator's view of this host.
 *
 * Deliberately a SUPERSET of the public `/api/status` rather than a replacement
 * for it: `/api/status` stays public because it is this project's ops surface
 * and several things already read it, and the extra detail an operator wants —
 * the signalling hub's counters, the per-connection rollup, the two store
 * statuses — lands here, behind the bearer, where it costs nothing to be
 * generous.
 */
function adminStatusDocument(): Record<string, unknown> {
  return {
    draining: notAdmitting(),
    shutdown: draining,
    deploy: lifecycle.report(),
    fleet: fleetStatus(),
    directory: directory.status(),
    rooms: router.status().map(redactRoomRow),
    entitlement: guard.status(),
    ads: ads.status(),
    signal: signalHub.stats(),
    connections: connectionRollup(allConnectionStats()),
    journal: journal.status(),
    audit: auditLog.status(),
    uptimeMs: Date.now() - bootMs,
  };
}

/**
 * The guard on every mutating admin route, applied BEFORE anything is changed.
 *
 * `docs/PLATFORM.md` §5.8 argues that the confirm ritual is the review for a
 * one-person team. A ritual the panel performs is a ritual `curl` skips, so the
 * two fields that make an audit row worth having are checked here, at the
 * route, where no client can decline to send them. Returns the refusal body, or
 * null when the request may proceed.
 */
async function refuseUnaudited(
  res: ServerResponse,
  body: unknown,
  cors: string | null,
): Promise<{ actor: string; reason: string } | null> {
  const check = requireMutationFields(body);
  if (check.ok) return check.value;
  // No audit row on purpose: a request that never named an actor has nothing to
  // attribute, and writing one would fill the log with unattributable noise any
  // unauthenticated-looking scanner could generate. The refusal is counted in
  // the gate's own counters, which is where a flood shows up.
  sendJson(res, 400, { error: check.error }, cors);
  return null;
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

/**
 * The same row, minus the world seed, for the UNAUTHENTICATED `/api/status`.
 *
 * `docs/PLATFORM.md` §5.9 names the seed as the reason it recommends moving
 * `/api/status` behind the admin gate: it is a matchmaking-abuse surface —
 * anybody who can read it can generate the room's world offline and know the
 * map before they join it.
 *
 * Gating the whole route was the other option and was not taken: `/api/status`
 * is this project's public ops surface, several tests and any external monitor
 * read it unauthenticated, and a wholesale gate is a separate decision with its
 * own blast radius. Cutting the one field that is actually dangerous costs
 * nothing — nothing in the tree reads it from here — and the operator still has
 * it, on `/api/admin/status`, behind the bearer.
 */
function publicRoomRow(row: Record<string, unknown>): Record<string, unknown> {
  const out = redactRoomRow(row);
  delete out.seed;
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

/**
 * A state-changing POST must come from a page we serve, as JSON. Two checks,
 * each sufficient on its own: an `Origin` we do not allow is refused (browsers
 * always send one on a cross-site POST), and a body that is not
 * `application/json` is refused — which is what stops a `<form
 * enctype="text/plain">` on any site from reaching `/api/auth/signup` and
 * claiming the owner role on a virgin host. Requests with no `Origin` at all
 * (curl, tests, the operator's own shell) are unaffected by the first check
 * and must still send JSON for the second.
 */
function refuseCrossSiteWrite(req: IncomingMessage, res: ServerResponse, cors: string | null): boolean {
  if (!originAllowed(req)) { sendJson(res, 403, { error: 'origin not allowed' }, cors); return true; }
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    sendJson(res, 415, { error: 'content-type must be application/json' }, cors); return true;
  }
  return false;
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
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

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  /* This response's CSP nonce. Only `/admin` uses it — the console is the one
   * document this function serves, and it is stamped with the same function
   * `serveStatic` uses for the game so the two can never drift. */
  nonce: string,
): Promise<boolean> {
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
      version: versionDocument(contentHash(), releaseView()),
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
    sendJson(res, 200, versionDocument(contentHash(), {
      ...releaseView(),
      deploy: lifecycle.report(),
      /* The writability probe's verdict rides the same document deploy
       * tooling already reads, so "the volume is root-owned again" is one
       * curl away instead of six days of silent loss away. */
      data: { writable: dataWritable, error: dataWriteError },
    }), cors);
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
    /*
     * A CALLER WITH NO IDENTITY DOES NOT GET BUCKETED, IT GETS THE DEFAULTS.
     *
     * This used to hash the literal string 'anonymous' for every device-less
     * HTTP caller — which is exactly the failure `deploy.ts`'s `stableIdFor`
     * says it is avoiding on the socket path: one bucket for the whole
     * anonymous population turns a 1% rollout into an all-or-nothing coin flip
     * on all of them, decided once, at random, by the flag key.
     *
     * `anonymousFlagBits` is the fix and it is NOT `defaultFlagBits()`, which
     * is what `docs/PLATFORM.md` §5.5(d) asks for: the defaults throw away the
     * operator's explicit forces along with the gamble, so a kill switch pulled
     * at 3 a.m. would still show the feature to every device-less caller. Only
     * the PARTIAL rollouts fall back. See the function.
     */
    const anonymous = !isValidDeviceId(device);
    const id = anonymous ? '' : device;
    const etag = `W/${flagConfigETag(flags.document).slice(0, -1)}-${anonymous ? 'default' : id.slice(0, 8)}"`;
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
      flags: anonymous ? unpackFlags(anonymousFlagBits(flags.document)) : flags.resolveFor(id),
    });
    headers['content-length'] = String(Buffer.byteLength(body));
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  /* --- the installed campaign ------------------------------------------- *
   * `LevelLibrary.handle()` is a complete, tested HTTP surface that NOTHING
   * called. `grep '\.handle(' server/src/index.ts` returned nothing, while
   * `client/src/modes/quest/quest.ts` has been fetching `/api/levels` and
   * `/api/levels/<id>/data` on every Quest launch whenever a server is
   * configured — and getting the SPA `index.html` back with a 200, because an
   * unmatched GET falls through to `serveStatic`. The client's `isLevelBinary`
   * check is what stopped that becoming a crash; it was never a route.
   *
   * Mounted here, next to `/api/flags`, because it is the same kind of thing:
   * content this host is serving, read-only, cacheable, no token.
   *
   * The library's own responses carry `access-control-allow-origin: *`. That is
   * this process's decision to make, not the library's, so the header is
   * dropped and replaced with whatever `corsOrigin` allows — otherwise mounting
   * it would silently widen a surface `DOOMCRAFT_ORIGINS` was set to narrow.
   * --------------------------------------------------------------------- */
  if (path === '/api/levels' || path.startsWith('/api/levels/')) {
    if (levels === null) {
      // Honest 503 rather than the SPA document: this host has no campaign
      // installed, and a client that asked deserves to be told in JSON.
      sendJson(res, 503, { error: 'this host has no level library' }, cors);
      return true;
    }
    const inm = req.headers['if-none-match'];
    const out = levels.handle(path, req.method ?? 'GET', Array.isArray(inm) ? inm[0] : inm);
    if (out === null) { sendJson(res, 404, { error: 'no such level resource' }, cors); return true; }
    const headers: Record<string, string | number> = { ...out.headers };
    delete headers['access-control-allow-origin'];
    if (cors !== null) {
      headers['access-control-allow-origin'] = cors;
      if (cors !== '*') headers.vary = 'origin';
    }
    const body = typeof out.body === 'string' ? Buffer.from(out.body, 'utf8') : Buffer.from(out.body);
    headers['content-length'] = body.length;
    if (req.method === 'HEAD' || out.status === 304) {
      if (out.status === 304) delete headers['content-length'];
      res.writeHead(out.status, headers);
      res.end();
      return true;
    }
    res.writeHead(out.status, headers);
    res.end(body);
    return true;
  }

  /* --- accounts: sign up, sign in, sign out, who am I ------------------- *
   *
   * FOUR ROUTES, and the first one is the only interesting one: on a host with
   * no owner, `POST /api/auth/signup` MINTS THE OWNER. `docs/PLATFORM.md` §2.5
   * deleted `POST /api/account/link` and `POST /api/account/resolve` in S0
   * because they were unauthenticated takeover primitives; these are what
   * re-front the same substrate (`PersistenceStore.linkAccount`) behind a
   * credential the caller has to prove.
   *
   * THREE RULES HOLD ACROSS ALL FOUR:
   *
   *   1. **No secret is ever in a response body.** Not the passphrase, not the
   *      `passHash`, not the salt, not the session token. The session leaves
   *      this process exactly once, in a `Set-Cookie` header, `httpOnly` so no
   *      script can read it back — including the console's own.
   *      `accountsRoutes.test.ts` greps every one of these bodies, and every
   *      `/api/admin/*` body, for the on-disk hash.
   *   2. **Signup and signin are throttled BEFORE they hash**, per client
   *      address, with the admin bearer's numbers (20 a minute). See
   *      `AttemptThrottle` for why the ordering is the opposite of the gate's.
   *   3. **A wrong name and a wrong passphrase are the same answer**, 401, and
   *      the same latency — `AccountStore.signin` hashes against a decoy salt
   *      when the name is unknown, so this is not a user enumerator with a
   *      stopwatch.
   * --------------------------------------------------------------------- */
  if (path === '/api/auth/signup' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const client = clientAddress(req);
    const now = Date.now();
    if (!authThrottle.allow(client, now)) {
      res.setHeader('retry-after', '60');
      sendJson(res, 429, { error: 'too many attempts' }, cors);
      return true;
    }
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;

    /*
     * THE §3.2 PRE-FLIGHT (row 3, the family PC). A signup from a device
     * whose ANONYMOUS profile has countable state gets the one question —
     * "Keep this device's progress?" — BEFORE the account exists, so the
     * answer can arrive on a clean retry instead of colliding with
     * name-taken. Claiming wrongly loses 40 hours; asking costs one click.
     * The inputs are validated first so an unusable signup is never asked.
     */
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
    if (isValidDeviceId(deviceId) && body.keepProgress === undefined
      && nameKeyOf(body.name) !== null && passphraseOk(body.passphrase)) {
      const home = await graph.accountForDevice(asDeviceId(deviceId));
      if (home === null) {
        const profile = await store.load(deviceId);
        if (profile !== null && countableProfile(profile)) {
          sendJson(res, 200, { ask: askSummary(profile) }, cors);
          return true;
        }
      }
    }

    const result = await accounts.signup(body.name, body.passphrase, now);
    if (!result.ok) {
      authThrottle.fail(client, now);
      const status = result.error === 'name-taken' ? 409 : 400;
      sendJson(res, status, { error: signupErrorText(result.error) }, cors);
      return true;
    }
    authThrottle.clear(client);
    /*
     * THE LINK, through the §3.2 decision table. The graph is the one
     * resolver of "which profile does this device's play bank to"; the
     * legacy store.linkAccount/accountIndex substrate is not written any
     * more. `keepProgress` carries the pre-flight's answer: true binds this
     * device (its progress follows the account), false starts the account
     * fresh and leaves the device's anonymous profile claimable by whoever
     * actually earned it. A device already claimed by ANOTHER account is
     * the shared machine (row 4): the new account plays under its own
     * fresh profile and the device's home never moves.
     */
    let linkedDevice = false;
    let decisionRow = 0;
    if (isValidDeviceId(deviceId)) {
      const profile = await store.load(deviceId);
      const out = await graph.signIn({
        provider: 'pass', secretHash: null,
        credentialAccount: null,
        mintAccountId: graphIdFor(result.account.id),
        deviceId: asDeviceId(deviceId),
        deviceHasProfile: profile !== null,
        deviceCountable: countableProfile(profile),
        answer: body.keepProgress === true ? 'keep' : body.keepProgress === false ? 'fresh' : undefined,
      });
      decisionRow = out.decision.row;
      if (out.kind === 'account') {
        await accounts.linkDevice(result.account.id, deviceId);
        linkedDevice = out.decision.row !== 4 && out.decision.row !== 3
          ? true : out.account.primaryDeviceId === deviceId;
      }
    }
    const token = sessions.mint(result.account.id, now);
    res.setHeader('set-cookie', sessionCookie(token));
    if (result.bootstrapped) {
      console.warn(`[accounts] ${result.account.name} is now the OWNER of this host`);
    }
    sendJson(res, 201, {
      account: publicAccount(result.account),
      /* True exactly once in a host's life: this signup took the owner role. */
      bootstrapped: result.bootstrapped,
      linkedDevice,
      decisionRow,
    }, cors);
    return true;
  }

  if (path === '/api/auth/signin' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const client = clientAddress(req);
    const now = Date.now();
    if (!authThrottle.allow(client, now)) {
      res.setHeader('retry-after', '60');
      sendJson(res, 429, { error: 'too many attempts' }, cors);
      return true;
    }
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const result = await accounts.signin(body.name, body.passphrase, now);
    if (!result.ok) {
      authThrottle.fail(client, now);
      console.warn(`[accounts] failed sign-in from ${client}`);
      sendJson(res, 401, { error: 'wrong name or passphrase' }, cors);
      return true;
    }
    authThrottle.clear(client);

    /*
     * Device binding through the §3.2 table. The SESSION always opens — it
     * rides the credential, never the device (row 9's whole point) — and
     * the decision only governs what this device banks to from now on:
     * row 5 attaches a new device to the account, row 3/8 surface the one
     * question (`ask` / `merge.offered`) for the client to answer on a
     * retry with `keepProgress` / `declineMerge`, and a device claimed by
     * someone else is left exactly where it was.
     */
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
    let decisionRow = 0;
    let ask: Record<string, number | string> | null = null;
    let mergeOffered = false;
    if (isValidDeviceId(deviceId)) {
      const gid = graphIdFor(result.account.id);
      const existing = await graph.get(gid);
      const profile = await store.load(deviceId);
      const out = await graph.signIn({
        provider: 'pass', secretHash: null,
        credentialAccount: existing === null ? null : gid,
        mintAccountId: gid,
        deviceId: asDeviceId(deviceId),
        deviceHasProfile: profile !== null,
        deviceCountable: countableProfile(profile),
        answer: body.keepProgress === true ? 'keep'
          : body.keepProgress === false ? 'fresh'
            : body.declineMerge === true ? 'decline' : undefined,
      });
      decisionRow = out.decision.row;
      if (out.kind === 'account') await accounts.linkDevice(result.account.id, deviceId);
      if (out.kind === 'ask' && profile !== null) ask = askSummary(profile);
      if (out.kind === 'merge_offered') mergeOffered = true;
    }

    const token = sessions.mint(result.account.id, now);
    res.setHeader('set-cookie', sessionCookie(token));
    sendJson(res, 200, {
      account: publicAccount(result.account),
      decisionRow,
      ...(ask !== null ? { ask } : {}),
      ...(mergeOffered ? { merge: { offered: true } } : {}),
    }, cors);
    return true;
  }

  if (path === '/api/auth/signout' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    /* Unthrottled on purpose: there is no credential to guess here, and a
     * limiter on sign-out is a limiter that keeps somebody signed IN. */
    const revoked = sessions.revoke(sessionCredential(req.headers));
    res.setHeader('set-cookie', expiredSessionCookie());
    sendJson(res, 200, { ok: true, revoked }, cors);
    return true;
  }

  if (path === '/api/auth/me' && (req.method === 'GET' || req.method === 'HEAD')) {
    /* What the game client will read for its account panel (C4). No panel is
     * built in this stage — server and console only. */
    const row = sessions.resolve(sessionCredential(req.headers), Date.now());
    const account = row === null ? null : accounts.byId(row.accountId);
    if (account === null) { sendJson(res, 401, { error: 'not signed in' }, cors); return true; }
    sendJson(res, 200, {
      account: publicAccount(account),
      /* The console prints this. A restart signs everybody out and nobody
       * should have to discover that from a 401 mid-rollout. */
      sessionsSurviveRestart: false,
    }, cors);
    return true;
  }

  /* --- C4: the device cookie and the socket ticket ----------------------- */

  /*
   * The dc_dev mirror. The client posts the id it holds in localStorage; the
   * cookie's word wins when both exist, because the cookie is the one Safari
   * ITP cannot evict and the one a page cannot typo. Day 8 on Safari:
   * localStorage is gone, the cookie is not, and this answer restores it.
   */
  if (path === '/api/device' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const fromCookie = cookieValue(req.headers.cookie, DEVICE_COOKIE);
    if (fromCookie !== null && isValidDeviceId(fromCookie)) {
      res.setHeader('set-cookie', deviceCookie(fromCookie));   // re-arm the 400 days
      sendJson(res, 200, { deviceId: fromCookie, restored: true }, cors);
      return true;
    }
    const claimed = typeof body.deviceId === 'string' && isValidDeviceId(body.deviceId)
      ? body.deviceId
      : randomBytes(12).toString('hex');
    res.setHeader('set-cookie', deviceCookie(claimed));
    sendJson(res, 200, { deviceId: claimed, restored: false }, cors);
    return true;
  }

  /*
   * C5 — the merge, accepted (docs/PLATFORM.md §3). The offer came from the
   * §3.2 table at sign-in (row 8); this route is the player saying yes on
   * THIS device. `preview: true` answers with the plan the confirm dialog
   * renders verbatim and writes nothing.
   */
  if (path === '/api/account/merge' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const row = sessions.resolve(sessionCredential(req.headers), Date.now());
    if (row === null) { sendJson(res, 401, { error: 'not signed in' }, cors); return true; }
    const device = deviceFromRequest(req, body);
    if (device === null) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const gid = graphIdFor(row.accountId);
    if (body.preview === true) {
      const record = await graph.get(gid);
      const pa = record === null ? null : await store.load(record.primaryDeviceId);
      const pb = await store.load(device);
      if (pa === null || pb === null) { sendJson(res, 404, { error: 'nothing to merge' }, cors); return true; }
      sendJson(res, 200, { plan: planMerge(pa, pb) }, cors);
      return true;
    }
    if (body.decline === true) {
      // Row 8 declined -> row 5 (§3.2): the device joins the account, the
      // anonymous progress stays where it is, unmerged and unclaimed by
      // nobody else from here on.
      const profile = await store.load(device);
      const out = await graph.signIn({
        provider: 'pass', secretHash: null,
        credentialAccount: (await graph.get(gid)) === null ? null : gid,
        mintAccountId: gid,
        deviceId: asDeviceId(device),
        deviceHasProfile: profile !== null,
        deviceCountable: countableProfile(profile),
        answer: 'decline',
      });
      sendJson(res, 200, { declined: true, decisionRow: out.decision.row }, cors);
      return true;
    }
    const result = await mergeDeviceIntoAccount(
      { graph, store, journal, dataRoot },
      gid, asDeviceId(device), 'player', 'account-panel merge',
    );
    if (!result.ok) { sendJson(res, result.status, { error: result.error }, cors); return true; }
    sendJson(res, 200, { eventId: result.eventId, plan: result.plan }, cors);
    return true;
  }

  /* --- the share card (docs/ECONOMY.md "Share cards"; SPONSORS.md S36) --- *
   * A 1200×630 PNG of the caller's LAST paying round, rendered server-side
   * so it cannot be faked, carrying their referral code — the shareable
   * artefact the referral loop was missing. S36: nothing third-party above
   * the bottom strip; until sponsors phase 2 binds a real lockup the strip
   * carries the house wordmark only, for everyone.                          */
  if (path === '/api/share/card' && (req.method === 'GET' || req.method === 'HEAD')) {
    const raw = cookieValue(req.headers.cookie, DEVICE_COOKIE) ?? url.searchParams.get('device') ?? '';
    if (!isValidDeviceId(raw)) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(raw));
    if (!flagOn(flags.bitsFor(key), 'share_cards')) {
      sendJson(res, 404, { error: 'share cards are not enabled' }, cors);
      return true;
    }
    const profile = await store.load(key);
    const last = profile?.stats.last ?? null;
    if (profile === null || last === null) {
      sendJson(res, 404, { error: 'play a match first — the card renders your last round' }, cors);
      return true;
    }
    const code = await referrals.codeFor(key, clientAddress(req));
    const mm = Math.floor(last.seconds / 60);
    const ss = String(Math.floor(last.seconds % 60)).padStart(2, '0');
    const png = renderShareCard({
      name: profile.progress.name || 'Marine',
      modeName: '',
      headline: `${last.kills} KILLS ${last.won ? '· VICTORY' : `· ${last.deaths} DEATHS`}`,
      subline: `+${last.xp} XP · +${last.scrap} SCRAP · ${mm}:${ss} PLAYED`,
      refCode: code,
      host: SHARE_HOST,
      lockupText: '',
    });
    const headers: Record<string, string> = {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'private, no-store',
    };
    if (cors !== null) headers['access-control-allow-origin'] = cors;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : png);
    return true;
  }

  /* --- viral tier 1: referral codes ------------------------------------- */

  /** The player's own code (minted on first ask) and their conversion tally. */
  if (path === '/api/referral/mine' && (req.method === 'GET' || req.method === 'HEAD')) {
    const raw = cookieValue(req.headers.cookie, DEVICE_COOKIE) ?? url.searchParams.get('device') ?? '';
    if (!isValidDeviceId(raw)) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(raw));
    const code = await referrals.codeFor(key, clientAddress(req));
    sendJson(res, 200, { code, converted: referrals.conversionsFor(key) }, cors);
    return true;
  }

  /**
   * `?ref=` lands here, once, at first visit. First wins forever; a veteran
   * is refused ('too-late'); self-referral is refused; a same-network claim
   * is accepted but its conversion parks for review. The answer never
   * distinguishes refusals to the CALLER beyond ok — a probe must not learn
   * the attribution table — but the reason is logged for the operator.
   */
  if (path === '/api/referral/claim' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const device = deviceFromRequest(req, body);
    const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : '';
    if (device === null || code === '') { sendJson(res, 400, { error: 'bad request' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(device));
    const result = await referrals.claim(key, code, clientAddress(req), { store, journal });
    sendJson(res, 200, { ok: result.ok }, cors);
    return true;
  }

  if (path === '/api/admin/referrals' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, {
      status: referrals.status(),
      queue: referrals.reviewQueue().map((q) => ({
        referred: redactPlayerId(q.referredKey),
        referredKey: q.referredKey,
        referrer: redactPlayerId(q.attribution.referrerKey),
        claimedMs: q.attribution.ms,
        review: q.attribution.review,
      })),
    }, cors);
    return true;
  }

  /** The queue's release valve — it PAYS, so it confirms like the C6 verbs. */
  if (path === '/api/admin/referrals/approve' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    const referredKey = typeof b.referredKey === 'string' ? b.referredKey : '';
    if (!isValidDeviceId(referredKey)) { sendJson(res, 400, { error: 'bad referredKey' }, cors); return true; }
    const now = Date.now();
    const pending = requireConfirm(`${who.actor}|referral-approve|${referredKey}`, b.confirm, now);
    if (pending !== null) { sendJson(res, pending.status, pending.body, cors); return true; }
    const paid = await referrals.approve(referredKey, { store, journal });
    await auditLog.record({
      ms: now, actor: who.actor, verb: 'referral.approve',
      subject: redactPlayerId(referredKey), reason: who.reason,
      before: '', after: paid ? 'paid' : 'nothing pending',
      outcome: paid ? 'applied' : 'refused', requestId: newRequestId(),
    });
    sendJson(res, paid ? 200 : 404, { ok: paid }, cors);
    return true;
  }

  if (path === '/api/admin/competitions' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, {
      status: competitions.status(),
      competitions: await competitions.overview('', { store, journal }),
    }, cors);
    return true;
  }

  /** Creation IS the paying decision — the finaliser pays the table it
   *  writes automatically — so it confirms like the C6 verbs. */
  if (path === '/api/admin/competitions/create' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name : '';
    const now = Date.now();
    const pending = requireConfirm(`${who.actor}|competition-create|${name}`, b.confirm, now);
    if (pending !== null) { sendJson(res, pending.status, pending.body, cors); return true; }
    const made = competitions.createTournament({
      name,
      startMs: typeof b.startMs === 'number' ? b.startMs : now,
      endMs: typeof b.endMs === 'number' ? b.endMs : 0,
      minLevel: typeof b.minLevel === 'number' ? b.minLevel : 1,
      scrapByRank: Array.isArray(b.scrapByRank) ? b.scrapByRank.filter((n): n is number => typeof n === 'number') : [],
      winnerItems: Array.isArray(b.winnerItems) ? b.winnerItems.filter((r): r is string => typeof r === 'string') : [],
      actor: who.actor,
    });
    await auditLog.record({
      ms: now, actor: who.actor, verb: 'competition.create',
      subject: made.ok ? made.id : name, reason: who.reason,
      before: '', after: made.ok ? 'running' : made.error,
      outcome: made.ok ? 'applied' : 'refused', requestId: newRequestId(),
    });
    if (!made.ok) { sendJson(res, 400, { error: made.error }, cors); return true; }
    sendJson(res, 201, { id: made.id }, cors);
    return true;
  }

  /** Cancel pays NOBODY — that is what distinguishes it from letting it end. */
  if (path === '/api/admin/competitions/cancel' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.slice(0, 64) : '';
    const done = competitions.cancelCompetition(id, who.actor);
    await auditLog.record({
      ms: Date.now(), actor: who.actor, verb: 'competition.cancel',
      subject: id, reason: who.reason,
      before: '', after: done ? 'cancelled' : 'not cancellable',
      outcome: done ? 'applied' : 'refused', requestId: newRequestId(),
    });
    sendJson(res, done ? 200 : 404, { ok: done }, cors);
    return true;
  }

  /* --- competitions: seasons and tournaments (docs/ECONOMY.md) ----------- *
   * Reads and enter are flag-gated on the caller's own `economy_competitions`
   * bits (the tab), never the accrual. The admin verbs live with the other
   * admin routes below: CREATE confirm-gates because the prize table it
   * writes is money the finaliser will pay automatically.                   */
  if ((path === '/api/competitions' || path === '/api/competitions/standings')
      && (req.method === 'GET' || req.method === 'HEAD')) {
    const raw = cookieValue(req.headers.cookie, DEVICE_COOKIE) ?? url.searchParams.get('device') ?? '';
    if (!isValidDeviceId(raw)) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(raw));
    if (!flagOn(flags.bitsFor(key), 'economy_competitions')) {
      sendJson(res, 404, { error: 'competitions are not enabled' }, cors);
      return true;
    }
    if (path === '/api/competitions') {
      sendJson(res, 200, { competitions: await competitions.overview(key, { store, journal }) }, cors);
      return true;
    }
    const table = await competitions.standings(
      (url.searchParams.get('id') ?? '').slice(0, 64), key, { store, journal });
    if (table === null) { sendJson(res, 404, { error: 'no such competition' }, cors); return true; }
    sendJson(res, 200, { standings: table }, cors);
    return true;
  }

  /* --- challenges: the daily/weekly board (docs/ECONOMY.md, Studio S4) --- *
   * Same gate as competitions — the flag registry claims daily/weekly
   * challenges for `economy_competitions`. Progress renders through a VIEW
   * roll: the period keys are computed at REQUEST time and a stored bucket
   * from an older period answers zeroed counts and an empty done — a read
   * never writes the profile, and yesterday's finished board never renders
   * as today's. */
  if (path === '/api/challenges' && (req.method === 'GET' || req.method === 'HEAD')) {
    const raw = cookieValue(req.headers.cookie, DEVICE_COOKIE) ?? url.searchParams.get('device') ?? '';
    if (!isValidDeviceId(raw)) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(raw));
    if (!flagOn(flags.bitsFor(key), 'economy_competitions')) {
      sendJson(res, 404, { error: 'challenges are not enabled' }, cors);
      return true;
    }
    const live = releases.live();
    const qdecl = live.packs.find((pk) => pk.kind === PackKind.QUESTS);
    const qi = qdecl !== undefined
      ? inventory.questsAt(qdecl.version)
      : inventory.questsAt(inventory.questsVersions().at(-1) ?? 1);
    const defs = qi?.manifest.challenges ?? [];
    const idecl = live.packs.find((pk) => pk.kind === PackKind.ITEMS);
    const items = inventory.itemsAt(idecl?.version ?? (inventory.itemsVersions().at(-1) ?? 1));
    const profile = await store.load(key);
    const now = Date.now();
    const day = utcDayKey(now);
    const week = utcWeekKey(now);
    const ch = profile?.challenges ?? null;
    sendJson(res, 200, {
      day,
      week,
      challenges: defs.map((d) => {
        const fresh = ch !== null && (d.period === 'daily' ? ch.day === day : ch.week === week);
        return {
          id: d.id,
          name: d.name,
          blurb: d.blurb,
          period: d.period,
          stat: d.stat,
          target: d.target,
          scrap: d.scrap,
          item: d.item,
          itemName: d.item === null ? ''
            : items?.manifest.items.find((i) => i.id === d.item)?.name ?? '',
          progress: fresh ? Math.min(ch.counts[d.id] ?? 0, d.target) : 0,
          done: fresh ? ch.done.includes(d.id) : false,
        };
      }),
    }, cors);
    return true;
  }

  if (path === '/api/competitions/enter' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const device = deviceFromRequest(req, body);
    if (device === null) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(device));
    if (!flagOn(flags.bitsFor(key), 'economy_competitions')) {
      sendJson(res, 404, { error: 'competitions are not enabled' }, cors);
      return true;
    }
    const id = typeof body.id === 'string' ? body.id.slice(0, 64) : '';
    const out = await competitions.enter(key, id, { store, journal });
    if (!out.ok) { sendJson(res, out.status, { error: out.error }, cors); return true; }
    sendJson(res, 200, { ok: true }, cors);
    return true;
  }

  /* --- trading: the two-sided escrow (docs/ECONOMY.md "Trading") --------- *
   * Every verb resolves the caller to a PROFILE KEY — the same resolution a
   * payout uses, so a claimed device trades as its person — and gates on the
   * caller's own `economy_trading` bits, which is the kill switch. The
   * engine (`trades.ts`) owns every rule: eligibility, the ACTIVE-state
   * check at offer AND confirm, the confirm reset on any change, and the
   * crash-recoverable settlement. These routes own identity and transport
   * only.                                                                   */
  if ((path === '/api/trade/mine' || path === '/api/trade/state')
      && (req.method === 'GET' || req.method === 'HEAD')) {
    const raw = cookieValue(req.headers.cookie, DEVICE_COOKIE) ?? url.searchParams.get('device') ?? '';
    if (!isValidDeviceId(raw)) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(raw));
    if (!flagOn(flags.bitsFor(key), 'economy_trading')) {
      sendJson(res, 404, { error: 'trading is not enabled' }, cors);
      return true;
    }
    if (path === '/api/trade/mine') {
      sendJson(res, 200, { trades: await trades.mine(key) }, cors);
      return true;
    }
    const view = await trades.stateFor(key, (url.searchParams.get('id') ?? '').slice(0, 64));
    if (view === null) { sendJson(res, 404, { error: 'no such trade' }, cors); return true; }
    sendJson(res, 200, { trade: view }, cors);
    return true;
  }

  if (path.startsWith('/api/trade/') && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const device = deviceFromRequest(req, body);
    if (device === null) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(device));
    if (!flagOn(flags.bitsFor(key), 'economy_trading')) {
      sendJson(res, 404, { error: 'trading is not enabled' }, cors);
      return true;
    }
    const deps = { store, defs: liveItemDefs };
    const tradeId = typeof body.tradeId === 'string' ? body.tradeId.slice(0, 64) : '';
    const verb = path.slice('/api/trade/'.length);
    let out: TradeResult | null = null;
    if (verb === 'open') out = await trades.open(key, deps);
    else if (verb === 'join') {
      const code = typeof body.code === 'string'
        ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : '';
      out = await trades.join(key, code, deps);
    } else if (verb === 'offer') {
      // Refused, not filtered: an offer with junk in it must not quietly
      // become a smaller offer the caller never made.
      const raw = Array.isArray(body.refs) ? body.refs : null;
      if (raw === null || raw.length > 32 || raw.some((r) => typeof r !== 'string' || r.length > 96)) {
        sendJson(res, 400, { error: 'refs must be an array of item refs' }, cors);
        return true;
      }
      out = await trades.offer(key, tradeId, raw as string[], deps);
    } else if (verb === 'confirm') out = await trades.confirm(key, tradeId, deps);
    else if (verb === 'cancel') out = await trades.cancel(key, tradeId);
    if (out === null) { sendJson(res, 404, { error: 'unknown trade verb' }, cors); return true; }
    if (!out.ok) { sendJson(res, out.status, { error: out.error }, cors); return true; }
    sendJson(res, 200, { trade: out.trade }, cors);
    return true;
  }

  /*
   * The WS credential (§2.3): single-use, 120 seconds, minted here and
   * redeemed exactly once at the upgrade. A signed-in caller's ticket
   * carries the ACCOUNT's profile key whatever device asks — that is what
   * makes a payout bank to the person; an anonymous caller's carries the
   * device's RESOLVED key, so a claimed device banks to its account even
   * when nobody typed a passphrase this session.
   */
  if (path === '/api/session/ticket' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const row = sessions.resolve(sessionCredential(req.headers), Date.now());
    if (row !== null) {
      const ticket = await graph.mintAccountTicket(graphIdFor(row.accountId));
      if (ticket !== null) { sendJson(res, 200, { ticket }, cors); return true; }
      // Signed in, but the account never bound a device: the device path
      // below still answers.
    }
    const device = deviceFromRequest(req, body);
    if (device === null) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    /* C6 enforcement: a banned PROFILE mints no credential. The graph-level
     * account ban is checked again at redemption; this is the profile-level
     * half, and it reads the resolved key so a ban follows the person. */
    const bannedKey = await graph.resolveProfileKey(asDeviceId(device));
    const banned = await store.load(bannedKey);
    if (banned !== null && banned.moderation.banned
      && (banned.moderation.bannedUntilMs === 0 || Date.now() < banned.moderation.bannedUntilMs)) {
      sendJson(res, 403, { error: 'this player is banned', untilMs: banned.moderation.bannedUntilMs }, cors);
      return true;
    }
    sendJson(res, 200, { ticket: await graph.mintDeviceTicket(asDeviceId(device)) }, cors);
    return true;
  }

  /* --- the operator's two switches -------------------------------------- *
   * Both are refused outright unless `DOOMCRAFT_ADMIN_TOKEN` is set, so a
   * default deployment has no admin surface at all. "Freeze all rollouts" is
   * INFRASTRUCTURE.md's one toggle reachable from a phone; `drain` is how a
   * deploy takes a host out of rotation without dropping a single match.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/drain' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const who = await refuseUnaudited(res, await readBody(req), cors);
    if (who === null) return true;
    const before = JSON.stringify(lifecycle.report());
    lifecycle.beginDrain();
    const action = await auditLog.record({
      ms: Date.now(), actor: who.actor, verb: 'drain', subject: HOST_ID, reason: who.reason,
      before, after: JSON.stringify(lifecycle.report()),
      outcome: 'applied', requestId: newRequestId(),
    });
    sendJson(res, 200, { deploy: lifecycle.report(), action: action.id }, cors);
    return true;
  }

  /* --- the console shell ------------------------------------------------ *
   * A page, not an API. It ships no data and holds no secret: the token is
   * typed in and kept in `sessionStorage`, and every /api/admin/* call it makes
   * is gated. This route is therefore NOT token-gated — but it does not exist
   * at all without a token, matching the 404 philosophy of the gate itself, so
   * an unconfigured deployment advertises no admin surface.
   *
   * Handled HERE rather than by `serveStatic`, because the SPA fallback would
   * otherwise hand out the game's index.html with a 200 for this path — the
   * exact failure `/api/levels` had for months.
   * --------------------------------------------------------------------- */
  if (path === '/admin' && (req.method === 'GET' || req.method === 'HEAD')) {
    /*
     * FOUR ANSWERS, and which one you get is the whole of S5 at this route:
     *
     *   - no env token AND no owner account -> 404. There is no console here.
     *   - a session whose account is a PLAYER -> 403. They authenticated; they
     *     are not the owner. See `refuseAdmin`.
     *   - no credential -> 200 and the SIGN-IN page, which offers "create the
     *     owner account" when `ownerCount() === 0` and a sign-in otherwise.
     *     Not a 404: 404 is reserved for a host with no surface at all, and
     *     answering it here would hide the page the owner needs.
     *   - the env bearer or an owner session -> 200 and the console.
     *
     * The env-bearer operator lands on the sign-in page too, because a browser
     * cannot put a bearer on a top-level navigation. That page's script sends
     * them straight through: the console it loads next asks for the bearer in
     * the header bar exactly as it did before this stage.
     */
    const decision = adminGate.admitRequest(
      { authorization: req.headers.authorization, sessionToken: sessionCredential(req.headers) },
      clientAddress(req),
      path,
      // Asking for the sign-in page is not a failed attempt. See `admitRequest`.
      { record: false },
    );
    if (decision.verdict === AdminVerdict.FORBIDDEN || decision.verdict === AdminVerdict.THROTTLED) {
      refuseAdmin(res, decision.verdict, cors);
      return true;
    }
    if (decision.verdict !== AdminVerdict.OK) {
      if (!adminGate.hasSurface) { sendJson(res, 404, { error: 'not found' }, cors); return true; }
      const page = Buffer.from(
        stampNonce(adminSignInHtml({ bootstrap: accounts.ownerCount() === 0 }), nonce),
        'utf8',
      );
      const signInHeaders: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(page.length),
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        'referrer-policy': 'no-referrer',
      };
      if (req.method === 'HEAD') { res.writeHead(200, signInHeaders); res.end(); return true; }
      res.writeHead(200, signInHeaders);
      res.end(page);
      return true;
    }
    const body = Buffer.from(stampNonce(ADMIN_CONSOLE_HTML, nonce), 'utf8');
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      // A console is never framed and never linked out of; both are cheap here
      // and neither is negotiable on a page that can drain a host.
      'referrer-policy': 'no-referrer',
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return true; }
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  /* --- what this host is, and what the console may do to it ------------- */
  if (path === '/api/admin/whoami' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, {
      version: versionDocument(contentHash(), { ...releaseView(), deploy: lifecycle.report() }),
      uptimeMs: Date.now() - bootMs,
      draining: notAdmitting(),
      shutdown: draining,
      // The honest half. `docs/PLATFORM.md` §5.6 finds that most operator verbs
      // have no storage behind them at all; the console renders this list
      // rather than a row of buttons that do nothing.
      capabilities: consoleCapabilities(),
      auth: { denied: adminGate.denied, throttled: adminGate.throttled },
      /*
       * WHICH credential got in, so the console can say it out loud. `env` is
       * the shared bearer out of the environment and is root; `owner` is a
       * person with an account. The audit log's `actor` field is still a label
       * and still required — one bearer admits every operator who has it — but
       * an owner session at least names one of them.
       */
      identity: {
        via: gate.via,
        account: gate.accountId === null ? null : publicAccountOrNull(gate.accountId),
        owners: accounts.ownerCount(),
        sessions: sessions.size,
        /* Stated, not implied: a restart signs everybody out. */
        sessionsSurviveRestart: false,
        accountsDegraded: accounts.degraded,
      },
    }, cors);
    return true;
  }

  /* --- the operator's fleet view ---------------------------------------- */
  if (path === '/api/admin/status' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, adminStatusDocument(), cors);
    return true;
  }

  /* --- READING the flag document ---------------------------------------- *
   * There was no GET. A GET fell through `handleApi` to `serveStatic`'s SPA
   * fallback and returned the game's index.html with a 200, so the flag
   * document was readable only as a side effect of WRITING it — which is the
   * one operation an operator inspecting a live fleet must not have to perform.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/flags' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, {
      host: HOST_ID,
      revision: flags.document.revision,
      frozen: flags.frozen,
      etag: flags.etag,
      ladder: ROLLOUT_LADDER,
      registry: flagRegistryView(flags.registry(), flags.document),
    }, cors);
    return true;
  }

  /* --- REVIEWING a write before it fires -------------------------------- *
   * The POST below is destructive in one direction and irreversible in none,
   * but it is still the request that turns a feature on for everybody. `/plan`
   * returns the exact document that would result, a diff, the confirm delay and
   * the warning list — computed by `planFlagWrite`, a pure function in
   * `shared/src/flags.ts` with tests, rather than by untested JavaScript inside
   * an HTML string.
   *
   * It writes NOTHING, including no audit row: planning is reading.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/flags/plan' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const plan = planFlagWrite(flags.document, await readBody(req));
    if (!plan.ok) {
      sendJson(res, 409, {
        error: 'revision conflict — somebody else edited the document',
        expected: plan.conflict?.expected ?? -1,
        revision: plan.conflict?.actual ?? flags.document.revision,
      }, cors);
      return true;
    }
    sendJson(res, 200, {
      document: plan.document,
      touched: plan.touched,
      diff: plan.diff,
      warnings: plan.warnings,
      risk: plan.risk,
      delayMs: plan.delayMs,
      offLadder: plan.offLadder,
      subject: plan.subject,
    }, cors);
    return true;
  }

  /*
   * A MERGE, not a replace, and a compare-and-swap on `revision`.
   *
   * `docs/PATCHING.md` prescribes the emergency freeze as
   * `-d '{"revision":9,"frozen":true}'`. Under the old full-replace this
   * request deleted every force and every rolloutBp on the host: the single
   * most destructive call in the API was the one the runbook told an operator
   * to paste at 3 a.m. `nextFlagDocument` is the whole rule set and it is pure;
   * this route is the 409.
   */
  if (path === '/api/admin/flags' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;

    /*
     * THE LADDER, enforced on the SERVER and not merely offered as five buttons.
     *
     * `docs/PATCHING.md` §5 has one rollout ladder — 0 / 100 / 500 / 2500 /
     * 10000 — and `docs/PLATFORM.md` §5.8 makes it the review: "a rollout you
     * cannot type freehand is a rollout you cannot fat-finger from 500 to
     * 5000". A guard that lives in the panel is a guard an operator with `curl`
     * skips by accident, so a value off the ladder is refused here unless the
     * request says `allowCustomRollout` in so many words. That is the "custom
     * demands its own reason string" rule, made into a field rather than a
     * habit — and it applies to the console exactly as it applies to a script.
     */
    const plan = planFlagWrite(flags.document, body);
    const allowCustom = (body as Record<string, unknown> | null)?.allowCustomRollout === true;
    if (plan.ok && plan.offLadder.length > 0 && !allowCustom) {
      sendJson(res, 400, {
        error: 'rollout is not on the ladder — resend with allowCustomRollout: true and say why in the reason',
        ladder: ROLLOUT_LADDER,
        offLadder: plan.offLadder,
      }, cors);
      return true;
    }

    const before = JSON.stringify(flags.document);
    const wasFrozen = flags.frozen;
    const write = flags.apply(body);
    if (!write.ok) {
      const c = write.conflict;
      /* A refused write IS an admin action and gets a row. A 409 that leaves no
       * trace is how two operators discover afterwards that they were both
       * editing, having each seen only their own half of it. */
      await auditLog.record({
        ms: Date.now(), actor: who.actor, verb: 'flags.set',
        subject: `revision ${c?.expected ?? -1}`, reason: who.reason,
        before, after: before, outcome: 'refused', requestId: newRequestId(),
      });
      sendJson(res, 409, {
        error: 'revision conflict — somebody else edited the document',
        expected: c?.expected ?? -1,
        revision: c?.actual ?? flags.document.revision,
      }, cors);
      return true;
    }
    const doc = write.document;
    const verb = wasFrozen === doc.frozen
      ? 'flags.set'
      : (doc.frozen ? 'flags.freeze' : 'flags.unfreeze');
    const action = await auditLog.record({
      ms: Date.now(), actor: who.actor, verb,
      /* The SAME string `/plan` told the operator to type back, so the row and
       * the confirm dialog cannot describe two different things. */
      subject: plan.subject,
      reason: who.reason,
      before, after: JSON.stringify(doc),
      outcome: 'applied', requestId: newRequestId(),
    });
    // Everyone already connected keeps the flags they were resolved with for
    // the life of their session. That is deliberate: a feature appearing or
    // vanishing under a player mid-match is the thing flags exist to prevent.
    sendJson(res, 200, {
      revision: doc.revision,
      frozen: doc.frozen,
      touched: write.touched,
      action: action.id,
      registry: flagRegistryView(flags.registry(), doc),
    }, cors);
    return true;
  }

  /* --- THE RELEASE TIER (docs/PACKS.md phase 2) ------------------------- *
   *
   * Eight routes, one state machine, and every rule enforced HERE, not in
   * the panel: one pending release at a time; approve needs a green gate AND
   * a sentence; every mutation carries ifRevision and a mismatch is a 409
   * with the current document in the body; rollback is refused with the
   * exact reason when it would destroy something (schema-touching, a build
   * pack this binary does not carry, a data pack no longer installed).
   * Every accepted transition writes one line to release.jsonl (inside the
   * service) AND one admin audit row (here) — the second copy is what makes
   * "what changed between Tuesday and the bug report" answerable from the
   * console's own history screen.
   * --------------------------------------------------------------------- */
  /* --- THE CREATOR STUDIO (docs/STUDIO.md S1) --------------------------- */
  if (path === '/api/admin/studio' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, {
      studio: studio.status(),
      installed: inventory.summary(),
      /* The editors seed from the NEWEST INSTALLED version, not the live
       * release — you edit forward from the latest cut, whatever is live. */
      seeds: {
        items: ((): string => {
          const v = inventory.itemsVersions().at(-1);
          const f = v === undefined ? null : inventory.itemsFileFor(v);
          return f === null ? '' : readFileSync(f, 'utf8');
        })(),
        campaign: ((): string => {
          const v = inventory.campaignVersions().at(-1);
          const f = v === undefined ? null : inventory.episodesFileFor(v);
          return f === null ? '' : readFileSync(f, 'utf8');
        })(),
        quests: ((): string => {
          const v = inventory.questsVersions().at(-1);
          const f = v === undefined ? null : inventory.questsFileFor(v);
          return f === null ? '' : readFileSync(f, 'utf8');
        })(),
      },
    }, cors);
    return true;
  }

  /* The challenge board's dry-run — same contract as the level lab's:
   * the save's own two gates (parser caps + item refs), no write, no
   * audit row. */
  if (path === '/api/admin/studio/quests/validate' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const verdict = studio.validateQuestsSource(typeof body.manifest === 'string' ? body.manifest : '');
    sendJson(res, 200, verdict, cors);
    return true;
  }

  /* The level lab's dry-run: the real validator's report, no write, no audit
   * row — validating is reading, and filling the log with keystrokes would
   * bury the rows that matter. */
  if (path === '/api/admin/studio/level/validate' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    sendJson(res, 200, studio.validateLevelSource(typeof body.source === 'string' ? body.source : ''), cors);
    return true;
  }

  /* S2: the in-panel preview — a dry run exactly like /validate (it writes
   * nothing, no audit row: rendering is reading), answering a top-down slice
   * PNG of the pasted source so the author sees the layout before saving. */
  if (path === '/api/admin/studio/level/preview' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const src = parseLevelJson(typeof body.source === 'string' ? body.source : '');
    if (src === null) { sendJson(res, 400, { error: 'not a parseable level source' }, cors); return true; }
    let png: Buffer;
    try {
      png = renderLevelPreview(compileLevel(src));
    } catch (e) {
      sendJson(res, 400, { error: `compile failed: ${e instanceof Error ? e.message : String(e)}` }, cors);
      return true;
    }
    const headers: Record<string, string> = {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'private, no-store',
    };
    if (cors !== null) headers['access-control-allow-origin'] = cors;
    res.writeHead(200, headers);
    res.end(png);
    return true;
  }

  if (path.startsWith('/api/admin/studio/') && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;

    const sub = path.slice('/api/admin/studio/'.length);
    let result: import('./studio.js').StudioResult & { diff?: string[] };
    let verb: string;
    switch (sub) {
      case 'items':
        verb = 'studio.items';
        result = studio.saveItems(typeof b.manifest === 'string' ? b.manifest : '');
        break;
      case 'level':
        verb = 'studio.level';
        result = studio.saveLevel(typeof b.source === 'string' ? b.source : '');
        break;
      case 'campaign':
        verb = 'studio.campaign';
        result = studio.saveCampaign(typeof b.manifest === 'string' ? b.manifest : '');
        break;
      case 'quests':
        verb = 'studio.quests';
        result = studio.saveQuests(typeof b.manifest === 'string' ? b.manifest : '');
        break;
      case 'draft':
        verb = 'studio.draft';
        result = studio.saveDraft(b.kind === 'characters' ? 'characters' : 'weapons', b.body ?? null);
        break;
      default:
        sendJson(res, 404, { error: 'no such studio surface', surface: sub }, cors);
        return true;
    }

    await auditLog.record({
      ms: Date.now(), actor: who.actor, verb,
      subject: result.ok ? result.label : 'refused',
      reason: who.reason,
      before: '', after: result.ok ? result.detail : result.error,
      outcome: result.ok ? 'applied' : 'refused', requestId: newRequestId(),
    });

    if (!result.ok) { sendJson(res, result.status, { error: result.error }, cors); return true; }
    sendJson(res, 200, result, cors);
    return true;
  }

  /* --- §2.2 CREATIVES, operator lane ------------------------------------ *
   * Upload is admin-only and audited; the content hash is the only address,
   * so approve-then-swap is impossible by construction. Serving is public,
   * immutable and nosniffed — the bytes were vetted at the door.            */
  if (path === '/api/admin/creatives' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, { creatives: creatives.list() }, cors);
    return true;
  }

  if (path === '/api/admin/creatives' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    // Base64 of the 400 KB image cap plus the audit fields; the default
    // 64 KB body budget is for JSON, not art.
    let body: unknown;
    try { body = await readBody(req, Math.ceil(IMAGE_MAX_BYTES * 4 / 3) + 4096); }
    catch { sendJson(res, 413, { error: 'body too large' }, cors); return true; }
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    const kind = b.kind === 'image' ? 'image' as const : 'display' as const;
    const data = typeof b.dataBase64 === 'string' ? b.dataBase64 : '';
    const result = creatives.put(Buffer.from(data, 'base64'), kind);
    await auditLog.record({
      ms: Date.now(), actor: who.actor, verb: 'ads.creative',
      subject: result.ok ? result.sha256 : 'refused', reason: who.reason,
      before: '',
      after: result.ok ? `${result.url} ${result.width}x${result.height} ${result.bytes}B` : result.error,
      outcome: result.ok ? 'applied' : 'refused', requestId: newRequestId(),
    });
    if (!result.ok) { sendJson(res, result.status, { error: result.error }, cors); return true; }
    sendJson(res, 200, result, cors);
    return true;
  }

  if (path.startsWith('/cdn/crv/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const m = /^\/cdn\/crv\/([0-9a-f]{64})\.(png|jpg|webp)$/.exec(path);
    const hit = m === null ? null : creatives.resolve(m[1]);
    if (hit === null) { sendJson(res, 404, { error: 'no such creative' }, cors); return true; }
    const bytes = readFileSync(hit.path);
    res.writeHead(200, {
      'content-type': hit.mime,
      'content-length': bytes.length,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  }

  /* --- THE AD PIPELINE (docs/SPONSORS.md phase 1) ----------------------- *
   * decide and event are public same-origin surfaces like /api/profile; the
   * redirector is the ONLY place a click becomes a fact. The client never
   * chooses a fill and never asserts a countable event.                     */
  if (path === '/api/ads/decide' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
    const surfaces = (Array.isArray(body.surfaces) ? body.surfaces : [])
      .filter((v): v is SurfaceId => typeof v === 'number' && (PHASE_ONE_SURFACES as readonly number[]).includes(v));
    let adsRemoved = false;
    let ageBand: 'unknown' | 'u13' | '13-17' | '18plus' = 'unknown';
    if (isValidDeviceId(deviceId)) {
      const profile = await store.load(deviceId);
      if (profile !== null) {
        adsRemoved = profile.progress.adsRemoved;
        ageBand = profile.ageBand;
      }
    }
    const fills = ads.decide({
      deviceId,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : '',
      surfaces,
      mode: typeof body.mode === 'number' ? body.mode : 0,
      platform: body.platform === 'mobile' ? 'mobile' : 'desktop',
    }, {
      adsRemoved,
      ageBand,
      /* No edge geo on this host yet: region is unknown, and a campaign that
       * targets regions therefore never serves — fail closed, never guessed
       * from a client-supplied field. */
      region: '',
    });
    sendJson(res, 200, { fills }, cors);
    return true;
  }

  if (path === '/api/ads/event' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const nonce = typeof body.nonce === 'string' ? body.nonce : '';
    const type = typeof body.type === 'string' ? body.type as AdEventType : 'impression';
    const verdict = ads.event(
      nonce, type,
      typeof body.ms === 'number' ? body.ms : Date.now(),
      typeof body.exposureMs === 'number' ? body.exposureMs : 0,
    );
    /* A refused event answers 200 with ok:false — a 4xx would teach a probe
     * which nonces are live, and the client retry path must not treat a
     * refusal as transport failure. */
    sendJson(res, 200, verdict, cors);
    return true;
  }

  if (path.startsWith('/r/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const clickId = path.slice(3);
    const hit = /^[A-Za-z0-9_-]{16,64}$/.test(clickId) ? ads.redirect(clickId) : null;
    if (hit === null) { sendJson(res, 404, { error: 'unknown link' }, cors); return true; }
    /* The human ALWAYS gets the 302 — what varied is whether it counted,
     * and that decision is already in the log. */
    res.writeHead(302, { location: hit.target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
    return true;
  }

  /*
   * The LIVE release's item definitions — what an owned ref resolves to. The
   * client joins this against the profile's inventory; ownership never rides
   * here and nothing about the caller is read, so it is public and cacheable
   * like /api/levels.
   */
  if (path === '/api/items' && (req.method === 'GET' || req.method === 'HEAD')) {
    const live = releases.live();
    const decl = live.packs.find((pk) => pk.kind === PackKind.ITEMS);
    const installed = decl === undefined ? null : inventory.itemsAt(decl.version);
    sendJson(res, 200, {
      version: decl?.version ?? 0,
      items: installed?.manifest.items ?? [],
    }, cors);
    return true;
  }

  /* --- equipping (docs/ECONOMY.md "Items") ------------------------------- *
   * The claim half of the ownership rule: `equippedSkin`/`title` are stored
   * claims, and every surface that WEARS an item re-derives its state through
   * `itemStateFor` at read time. Same identity resolution and per-caller
   * `economy_items` gate as every other economy route.                       */
  if (path === '/api/equip' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const device = deviceFromRequest(req, body);
    if (device === null) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(device));
    if (!flagOn(flags.bitsFor(key), 'economy_items')) {
      sendJson(res, 404, { error: 'items are not enabled' }, cors);
      return true;
    }
    const wants = new Map<EquipSlot, string>();
    for (const slot of ['skin', 'title'] as const) {
      if (!(slot in body)) continue;
      const v = body[slot];
      if (typeof v !== 'string' || v.length > 96) {
        sendJson(res, 400, { error: `${slot} must be an item ref, or '' to unequip` }, cors);
        return true;
      }
      wants.set(slot, v);
    }
    if (wants.size === 0) { sendJson(res, 400, { error: 'nothing to equip' }, cors); return true; }
    const kindOf = (ref: string): ItemKind | null => {
      const parsed = parseItemRef(ref);
      if (parsed === null) return null;
      const live = liveItemDefs().get(parsed.localId);
      if (live !== undefined) return live.kind;
      const granting = inventory.itemsAt(parsed.version);
      return granting?.manifest.items.find((i) => i.id === parsed.localId)?.kind ?? null;
    };
    /* Validate then write inside ONE update callback: the callback runs
     * synchronously over the live object, so a concurrent settlement cannot
     * un-own an item between the check and the claim. A refusal writes no
     * slot at all — both claims land or neither does. */
    let refusal: string | null = null;
    const updated = await store.update(key, (p) => {
      for (const [slot, ref] of wants) {
        const v = equipVerdict(p, slot, ref, kindOf);
        if (!v.ok) { refusal = v.error; return; }
      }
      applyEquip(p, wants);
    });
    if (refusal !== null) { sendJson(res, 400, { error: refusal }, cors); return true; }
    sendJson(res, 200, {
      inventory: { equippedSkin: updated.inventory.equippedSkin, title: updated.inventory.title },
    }, cors);
    return true;
  }

  /* --- crafting: the deterministic trade-up (docs/ECONOMY.md) ------------ *
   * Three duplicates + a Scrap fee -> the CHOSEN item one rarity up, same
   * kind. The engine (`craft.ts`) owns every rule; this route owns identity,
   * the escrow reservation set, and the journal's first 'spend' rows —
   * idempotent on the client nonce, so a crash-replayed craft consumes and
   * grants nothing twice.                                                   */
  if (path === '/api/craft' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const device = deviceFromRequest(req, body);
    if (device === null) { sendJson(res, 400, { error: 'no device identity' }, cors); return true; }
    const key = await graph.resolveProfileKey(asDeviceId(device));
    if (!flagOn(flags.bitsFor(key), 'economy_items')) {
      sendJson(res, 404, { error: 'crafting is not enabled' }, cors);
      return true;
    }
    const source = typeof body.source === 'string' ? body.source.slice(0, 96) : '';
    const target = typeof body.target === 'string' ? body.target.slice(0, 64) : '';
    const nonce = typeof body.nonce === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.nonce) ? body.nonce : '';
    if (nonce === '') { sendJson(res, 400, { error: 'a craft needs a client nonce (8-64 url-safe chars)' }, cors); return true; }
    const decl = releases.live().packs.find((pk) => pk.kind === PackKind.ITEMS);
    if (decl === undefined) { sendJson(res, 400, { error: 'the live release carries no items pack' }, cors); return true; }
    const defs = liveItemDefs();
    const reserved = trades.reservedRefs(key);
    const sourceId = `craft:${nonce}`;
    const now = Date.now();

    let refusal: { status: number; error: string } | null = null;
    let crafted = '';
    let replay = false;
    const updated = await store.update(key, async (p) => {
      // Idempotency FIRST and inside the same update, exactly as every
      // payment in this repo: the nonce's grant is the durable receipt.
      const prior = p.inventory.items.find((i) => i.sourceId === sourceId);
      if (prior !== undefined || await journal.has('spend', sourceId, key)) {
        crafted = prior?.ref ?? '';
        replay = true;
        return;
      }
      const v = craftVerdict(p, source, target, defs, decl.version, reserved);
      if (!v.ok) { refusal = { status: v.status, error: v.error }; return; }
      const outcome = applyCraft(p, v.plan);
      const landed = grantDrops(p, [v.plan.targetRef], 'craft', sourceId, now);
      crafted = landed[0]?.ref ?? v.plan.targetRef;
      await journal.append([{
        id: newLedgerId(now), ms: now, kind: 'spend', sourceId,
        playerId: key, currency: 'scrap',
        delta: outcome.debited, balanceAfter: outcome.balanceAfter,
        actor: 'system:craft',
        reason: `crafted ${v.plan.targetLocalId} from ${CRAFT_COPIES}x ${v.plan.sourceRef}`,
      }]);
    });
    if (refusal !== null) { sendJson(res, (refusal as { status: number }).status, { error: (refusal as { error: string }).error }, cors); return true; }
    sendJson(res, 200, {
      crafted,
      replay,
      balance: updated.economy.scrap,
      inventory: { equippedSkin: updated.inventory.equippedSkin, title: updated.inventory.title },
    }, cors);
    return true;
  }

  if (path === '/api/admin/release' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, {
      document: releases.document(),
      installed: {
        levels: inventory.levelsVersions(),
        campaign: inventory.campaignVersions(),
        items: inventory.itemsVersions(),
        quests: inventory.questsVersions(),
        packs: inventory.installedPacks().map((p) => ({ label: p.label, fingerprint: p.fingerprint, digest: p.digest })),
        detail: inventory.summary(),
      },
      live: releaseView().release,
    }, cors);
    return true;
  }

  if (path.startsWith('/api/admin/release') && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    const ifRevision = typeof b.ifRevision === 'number' ? b.ifRevision : -1;

    const sub = path.slice('/api/admin/release'.length);
    const before = releaseSummary();
    let result: import('./packs.js').ReleaseResult;
    let verb: string;
    switch (sub) {
      case '':
        verb = 'release.draft';
        /* S3: the studio's one-click passes picks; absent fields mean
         * "newest installed", which is what the Review button always sent. */
        result = await releases.createDraft(ifRevision, {
          levels: typeof b.levels === 'number' ? b.levels : undefined,
          campaign: typeof b.campaign === 'number' ? b.campaign : undefined,
          items: typeof b.items === 'number' ? b.items : undefined,
          quests: typeof b.quests === 'number' ? b.quests : undefined,
          note: typeof b.note === 'string' ? b.note : undefined,
        });
        break;
      case '/gate':
        verb = 'release.gate';
        result = await releases.gateDraft(ifRevision);
        break;
      case '/approve':
        verb = 'release.approve';
        result = await releases.approve(ifRevision, typeof b.note === 'string' ? b.note : '');
        break;
      case '/stage':
        verb = 'release.stage';
        result = await releases.stage(ifRevision, typeof b.bp === 'number' ? b.bp : Number.NaN, b.allowCustomRollout === true);
        break;
      case '/promote':
        verb = 'release.promote';
        result = await releases.promote(ifRevision);
        break;
      case '/rollback':
        verb = 'release.rollback';
        result = await releases.rollback(ifRevision);
        break;
      case '/freeze':
        verb = b.frozen === true ? 'release.freeze' : 'release.unfreeze';
        result = await releases.setFrozen(ifRevision, b.frozen === true);
        break;
      default:
        sendJson(res, 404, { error: 'no such release action', action: sub }, cors);
        return true;
    }

    /* A refused mutation IS an admin action and gets a row — a 409 that
     * leaves no trace is how two tabs discover afterwards that they were
     * both editing (same rule as the flags route). */
    await auditLog.record({
      ms: Date.now(), actor: who.actor, verb,
      subject: result.ok
        ? `revision ${result.release?.revision ?? result.doc.liveRevision}`
        : `refused at document ${result.doc.revision}`,
      reason: who.reason,
      before, after: releaseSummary(),
      outcome: result.ok ? 'applied' : 'refused', requestId: newRequestId(),
    });

    if (!result.ok) {
      sendJson(res, result.status, { error: result.error, document: result.doc }, cors);
      return true;
    }
    sendJson(res, 200, { document: result.doc, release: result.release ?? null }, cors);
    return true;
  }

  /* --- WHO OWNS THIS HOST, and the way to take it back ------------------ *
   *
   * THE BOOTSTRAP WINDOW IS A REAL HOLE AND THIS IS ITS PATCH. Between the
   * moment a host is deployed and the moment its operator signs up, ANYBODY who
   * finds the URL can be the owner — the rule that makes the console ownable
   * with no vendor is the same rule that makes it claimable by a stranger.
   *
   * So this route is **callable with the env bearer and NOTHING else**, not
   * even with an owner session. `adminGate.admitEnvOnly` is a separate method
   * for exactly this reason: if a squatter's own session could call it, the
   * squatter would simply transfer the role back to themselves and the safety
   * net would be a formality. `DOOMCRAFT_ADMIN_TOKEN` is the credential they
   * never had, and it stays root.
   *
   * It writes an audit row like every other mutation, and demoting every other
   * owner is part of the same call — "exactly one owner" is the invariant, and
   * a transfer that left two would break it as surely as a raced signup.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/owner/transfer' && req.method === 'POST') {
    const verdict = adminGate.admitEnvOnly(req.headers.authorization, clientAddress(req), path);
    if (verdict !== AdminVerdict.OK) { refuseAdmin(res, verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = (await readBody(req) ?? {}) as Record<string, unknown>;
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const before = JSON.stringify({ owners: accounts.owners() });
    const result = await accounts.transferOwner(body.name);
    if (!result.ok) {
      await auditLog.record({
        ms: Date.now(), actor: who.actor, verb: 'owner.transfer',
        subject: typeof body.name === 'string' ? body.name.slice(0, 40) : '(none)',
        reason: who.reason, before, after: before,
        outcome: 'refused', requestId: newRequestId(),
      });
      sendJson(res, 404, { error: 'no account by that name' }, cors);
      return true;
    }
    const after = JSON.stringify({ owners: accounts.owners() });
    const action = await auditLog.record({
      ms: Date.now(), actor: who.actor, verb: 'owner.transfer', subject: result.owner.name,
      reason: who.reason, before, after,
      outcome: 'applied', requestId: newRequestId(),
    });
    /* No session is revoked, and none needs to be: `AdminGate`'s resolver reads
     * the role LIVE on every request, so a demoted owner's open console starts
     * answering 403 on its next poll. */
    sendJson(res, 200, {
      owner: publicAccount(result.owner),
      demoted: result.demoted,
      owners: accounts.owners(),
      action: action.id,
    }, cors);
    return true;
  }

  /* --- the admin action log --------------------------------------------- *
   * Read-only. Every mutation above wrote a row here with its before and after
   * state, which is what makes an undo one paste rather than an archaeology
   * project. Rows whose verb starts with `player.` are moderation records and
   * outlive the ordinary retention window — see `server/src/adminAudit.ts`.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/audit' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    const sinceRaw = Number(url.searchParams.get('since') ?? '0');
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    const limitRaw = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
    sendJson(res, 200, {
      rows: await auditLog.read(since, limit),
      status: auditLog.status(),
    }, cors);
    return true;
  }

  /* --- one player, and what cannot be done to them ---------------------- *
   * LOOKUP ONLY, and the response says so. `docs/PLATFORM.md` §5.6 walks every
   * operator verb and finds most of them have no storage behind them: no
   * moderation field, no `Room.kick`, no currency method, no `unlink`. The
   * `missing` array is that list, returned with every lookup so the console
   * cannot render a screen that lies about its own powers.
   *
   * The device id goes IN — an operator has it from a support ticket — and
   * never comes back OUT: everything in the response is keyed by the same
   * eight-character handle the journal uses.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/player' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    const key = url.searchParams.get('key') ?? '';
    if (!isValidDeviceId(key)) { sendJson(res, 400, { error: 'key must be a device id' }, cors); return true; }
    const limitRaw = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
    sendJson(res, 200, playerLookup({
      key,
      profile: await store.load(key),
      rows: await journal.read(key, 0, limit),
      sums: await journal.balances(key),
      liveItemIds: liveItemIdSet(),
    }), cors);
    return true;
  }

  /* --- C6: the operator verbs the Players screen was refusing to lie about *
   * Every one is admin-gated, audited, journal-backed where money moves, and
   * the destructive ones sit behind a TWO-PHASE CONFIRM WITH DELAY: the
   * first call answers 428 with a token and the earliest moment it may be
   * used; a confirm inside the delay window is refused — a double-click
   * cannot ban anybody.                                                     */
  if (path.startsWith('/api/admin/player/') && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    const deviceId = typeof b.deviceId === 'string' ? b.deviceId : '';
    if (!isValidDeviceId(deviceId)) { sendJson(res, 400, { error: 'bad device id' }, cors); return true; }
    const verb = path.slice('/api/admin/player/'.length);
    const now = Date.now();

    // Kick is immediate — a reconnect undoes it; everything else confirms.
    if (verb !== 'kick') {
      const pending = requireConfirm(`${who.actor}|${verb}|${deviceId}`, b.confirm, now);
      if (pending !== null) { sendJson(res, pending.status, pending.body, cors); return true; }
    }

    const profileKey = await graph.resolveProfileKey(asDeviceId(deviceId));
    let after = '';
    let refused = '';
    switch (verb) {
      case 'moderate': {
        const banned = b.banned === true;
        const untilMs = typeof b.untilMs === 'number' && Number.isFinite(b.untilMs) ? Math.max(0, b.untilMs) : 0;
        const updated = await store.update(profileKey, (p) => {
          p.moderation.banned = banned;
          p.moderation.bannedUntilMs = banned ? untilMs : 0;
          p.moderation.reason = banned ? who.reason : '';
        });
        const home = await graph.accountForDevice(asDeviceId(deviceId));
        if (home !== null) {
          await graph.moderate(home.accountId, banned ? 'banned' : 'clear', who.reason, untilMs);
        }
        // A ban takes effect NOW, not at the next connect.
        let kicked = 0;
        for (const key of router.keys()) kicked += router.get(key)?.kick(profileKey, 'banned') ?? 0;
        after = `banned=${updated.moderation.banned} until=${untilMs} kicked=${kicked}`;
        break;
      }
      case 'revoke-item': {
        const ref = typeof b.ref === 'string' ? b.ref.slice(0, 80) : '';
        if (ref === '') { refused = 'ref required'; break; }
        await store.update(profileKey, (p) => {
          if (!p.moderation.revokedItems.some((r) => r.ref === ref)) {
            p.moderation.revokedItems.push({ ref, ms: now, reason: who.reason });
          }
        });
        after = `revoked ${ref}`;
        break;
      }
      case 'currency': {
        const delta = typeof b.delta === 'number' && Number.isFinite(b.delta) ? Math.trunc(b.delta) : NaN;
        if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100_000) {
          refused = 'delta must be a non-zero integer within ±100000';
          break;
        }
        // The journal is the truth the balance follows — never the reverse.
        const entryId = newLedgerId(now);
        const updated = await store.update(profileKey, (p) => {
          p.economy.scrap = Math.max(0, Math.min(p.economy.scrap + delta, MAX_SCRAP_BALANCE));
          if (delta > 0) p.economy.lifetimeScrap = Math.min(p.economy.lifetimeScrap + delta, MAX_SCRAP_BALANCE);
        });
        await journal.append([{
          id: entryId, ms: now, kind: 'admin.adjust', sourceId: `admin:${entryId}`,
          playerId: profileKey, currency: 'scrap',
          delta, balanceAfter: updated.economy.scrap,
          actor: `admin:${who.actor}`, reason: who.reason,
        }]);
        after = `scrap ${delta > 0 ? '+' : ''}${delta} -> ${updated.economy.scrap}`;
        break;
      }
      case 'entitlement': {
        const adsRemoved = b.adsRemoved === true;
        const updated = await store.update(profileKey, (p) => {
          p.entitlements.adsRemoved = adsRemoved;
          p.progress.adsRemoved = adsRemoved;
          if (adsRemoved && p.entitlements.purchasedMs === 0) p.entitlements.purchasedMs = now;
        });
        after = `adsRemoved=${updated.entitlements.adsRemoved}`;
        break;
      }
      case 'kick': {
        let kicked = 0;
        for (const key of router.keys()) kicked += router.get(key)?.kick(profileKey, who.reason || 'removed by operator') ?? 0;
        after = `kicked ${kicked} connection(s)`;
        break;
      }
      case 'reset-progress': {
        /* C6.1. The archive is written FIRST and its failure refuses the
         * reset — a destructive verb without its undo raw material is a
         * verb support cannot walk back. The name stays (identity, not
         * progress); settings, bindings, entitlements, moderation and the
         * account link stay; the scrap zeroing goes through the journal
         * like every other balance movement. */
        const entryId = newLedgerId(now);
        let hadScrap = 0;
        let archived = false;
        const updated = await store.update(profileKey, (p) => {
          try {
            const dir = join(dataRoot, 'reset');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${profileKey}-${entryId}.json`), JSON.stringify(serialiseProfile(p), null, 2), 'utf8');
            archived = true;
          } catch { /* refused below */ }
          if (!archived) return;
          hadScrap = p.economy.scrap;
          const name = p.progress.name;
          const fresh = createProfile(profileKey, now);
          p.progress = fresh.progress;
          p.progress.name = name;
          p.progress.adsRemoved = p.entitlements.adsRemoved;
          p.stats = fresh.stats;
          p.economy = fresh.economy;
          p.inventory = fresh.inventory;
        });
        if (!archived) { refused = 'could not archive the profile — nothing was reset'; break; }
        if (hadScrap > 0) {
          await journal.append([{
            id: entryId, ms: now, kind: 'admin.adjust', sourceId: `reset:${entryId}`,
            playerId: profileKey, currency: 'scrap',
            delta: -hadScrap, balanceAfter: updated.economy.scrap,
            actor: `admin:${who.actor}`, reason: who.reason,
          }]);
        }
        after = `progress reset — ${hadScrap} scrap zeroed, archived as reset/${profileKey}-${entryId}.json`;
        break;
      }
      default:
        sendJson(res, 404, { error: 'no such player verb' }, cors);
        return true;
    }

    await auditLog.record({
      ms: now, actor: who.actor, verb: `player.${verb}`,
      subject: hashDeviceForAudit(profileKey), reason: who.reason,
      before: '', after: refused === '' ? after : refused,
      outcome: refused === '' ? 'applied' : 'refused', requestId: newRequestId(),
    });
    if (refused !== '') { sendJson(res, 400, { error: refused }, cors); return true; }
    sendJson(res, 200, { ok: true, result: after }, cors);
    return true;
  }

  /* --- C6.1: the §3.6 merge undo ----------------------------------------- *
   * Money moves and a profile is rewritten, so it confirms like the C6
   * verbs. The engine (`merge.ts`) owns the idempotency and the crash
   * order; this route owns the gate, the confirm and the audit row.        */
  if (path === '/api/admin/merge/undo' && req.method === 'POST') {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    if (refuseCrossSiteWrite(req, res, cors)) return true;
    const body = await readBody(req);
    const who = await refuseUnaudited(res, body, cors);
    if (who === null) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    const eventId = typeof b.eventId === 'string' ? b.eventId.slice(0, 64) : '';
    if (eventId === '') { sendJson(res, 400, { error: 'eventId required' }, cors); return true; }
    const now = Date.now();
    const pending = requireConfirm(`${who.actor}|merge-undo|${eventId}`, b.confirm, now);
    if (pending !== null) { sendJson(res, pending.status, pending.body, cors); return true; }
    const out = await undoMerge({ graph, store, journal, dataRoot }, eventId, `admin:${who.actor}`, who.reason);
    await auditLog.record({
      ms: now, actor: who.actor, verb: 'merge.undo',
      subject: eventId, reason: who.reason,
      before: '', after: out.ok ? `restored ${out.restoredScrap} scrap, shortfall ${out.shortfall}` : out.error,
      outcome: out.ok ? 'applied' : 'refused', requestId: newRequestId(),
    });
    if (!out.ok) { sendJson(res, out.status, { error: out.error }, cors); return true; }
    sendJson(res, 200, { ok: true, restoredScrap: out.restoredScrap, shortfall: out.shortfall }, cors);
    return true;
  }

  /** The merge history an undo needs an event id FROM — newest first. */
  if (path === '/api/admin/merges' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    const rows = readMergeLog(dataRoot);
    const undone = new Set(rows.filter((r) => r.state === 'undone').map((r) => r.id));
    sendJson(res, 200, {
      merges: rows.filter((r) => r.state === 'applied').slice(-100).reverse().map((r) => ({
        eventId: r.id, ms: r.ms,
        into: r.intoAccountId, from: redactPlayerId(r.fromDeviceId),
        scrapMoved: r.scrapMoved, undone: undone.has(r.id),
      })),
    }, cors);
    return true;
  }

  /*
   * The refusal log. Only rejections and strips are recorded, so an empty ring
   * next to a non-zero `accepted` is what a healthy process looks like — and a
   * ring full of NOT_A_PARTICIPANT or CLIENT_REPORTED is somebody probing.
   * Admin-gated exactly like the two switches above: no token, no route.
   */
  if (path === '/api/admin/entitlement' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    sendJson(res, 200, {
      status: guard.status(),
      /*
       * REDACTED, and it had not been. Every row in the guard's ring carries a
       * FULL device id, and this route returned them verbatim — so the surface
       * built to watch for somebody probing the reward gate was itself handing
       * out the stable identifier of every player who tripped it. `sessionId`
       * goes too: it is `"<room key>#<round>"`, and a private room's key IS its
       * join code, which is the leak `redactRoomRow` was written to close.
       */
      recent: redactGuardAudit(guard.recent(64)),
      // The other half of "an operator can see the gate running": until now a
      // refused bearer was counted nowhere and logged nowhere.
      auth: { denied: adminGate.denied, throttled: adminGate.throttled },
    }, cors);
    return true;
  }

  /* --- the reward journal, for an operator ------------------------------ *
   * The read half of `server/src/journal.ts`. The admin console (C3/C6) renders
   * this; there is no UI in this commit and this route is the seam.
   *
   * Two things are answered at once and the second is the point: the PAGE of
   * rows, and the RECONCILIATION — the stored balance beside the sum of every
   * delta the journal holds for that player. A divergence is the only evidence
   * that a payout moved a balance without being recorded, and it is invisible
   * from either number on its own.
   *
   * `player` is a full device id on the way in — the operator has it, from a
   * support ticket — and is never a full device id on the way OUT.
   * `docs/PLATFORM.md` §5.7 requires every admin serialiser to redact it, and
   * a journal row carries one on every line.
   * --------------------------------------------------------------------- */
  if (path === '/api/admin/journal' && (req.method === 'GET' || req.method === 'HEAD')) {
    const gate = admitAdmin(req, path);
    if (gate.verdict !== AdminVerdict.OK) { refuseAdmin(res, gate.verdict, cors); return true; }
    const key = url.searchParams.get('player') ?? '';
    if (!isValidDeviceId(key)) { sendJson(res, 400, { error: 'player must be a device id' }, cors); return true; }
    const sinceRaw = Number(url.searchParams.get('since') ?? '0');
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    const limitRaw = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
    const redacted = redactPlayerId(key);
    const rows = (await journal.read(key, since, limit))
      .map((e) => ({ ...e, playerId: redacted }));
    const sums = await journal.balances(key);
    const profile = await store.load(key);
    sendJson(res, 200, {
      player: redacted,
      rows,
      /*
       * `stored` is null when the player has no profile on this host, which is
       * the normal state on a fleet — the rows and the balance can live on
       * different boxes until there is one shared store. `fromDay` is the
       * oldest retained day: outside it the sum is a lower bound, not a
       * balance, and an operator must not read it as one.
       */
      reconcile: {
        fromDay: sums.fromDay,
        rows: sums.rows,
        xp: { stored: profile === null ? null : profile.progress.xp, journal: sums.xp },
        scrap: { stored: profile === null ? null : profile.economy.scrap, journal: sums.scrap },
      },
      status: journal.status(),
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
      rooms: router.status().map(publicRoomRow),
      // A healthy fleet shows a rising `accepted` and an all-but-empty `codes`
      // map. `violations` climbing is the number worth an alert.
      entitlement: guard.status(),
    ads: ads.status(),
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
    /* C4: a session beats ?device= — the signed-in caller reads the
     * ACCOUNT's profile of record, and the graph resolves an anonymous
     * device to its home account's file when one exists. */
    let profileKey = url.searchParams.get('device') ?? '';
    const sessionRow = sessions.resolve(sessionCredential(req.headers), Date.now());
    if (sessionRow !== null) {
      const record = await graph.get(graphIdFor(sessionRow.accountId));
      if (record !== null) profileKey = record.primaryDeviceId;
    } else if (isValidDeviceId(profileKey)) {
      profileKey = await graph.resolveProfileKey(asDeviceId(profileKey));
    }
    if (!isValidDeviceId(profileKey)) { sendJson(res, 400, { error: 'bad device id' }, cors); return true; }
    const profile = await store.load(profileKey);
    if (profile === null) { sendJson(res, 404, { error: 'no such profile' }, cors); return true; }
    sendJson(res, 200, { profile: publicProfile(profile) }, cors);
    return true;
  }

  if (path === '/api/profile' && req.method === 'POST') {
    if (refuseCrossSiteWrite(req, res, cors)) return true;
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
    if (refuseCrossSiteWrite(req, res, cors)) return true;
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
  handleApi(req, res, url, nonce)
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

httpServer.on('upgrade', (req, socket, head) => { void (async () => {
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

  /*
   * C4: identity rides a single-use ticket, never a bare id. `?device=` is
   * REFUSED, not ignored — accepting it alongside the ticket would leave
   * PLATFORM §2.1 defect #7 open (anyone naming a victim's id could burn
   * their day caps). The ticket was minted seconds ago by /api/session/
   * ticket and already carries the RESOLVED profile key, so `conn.deviceId`
   * is the person's file from the first byte and every payout, journal row,
   * entitlement participant and flag bucket downstream keys per person with
   * no room.ts change. No ticket at all is still a valid spectator-shaped
   * join: the connection plays, nothing banks.
   */
  if (url.searchParams.has('device')) {
    refuseUpgrade(socket, 400, 'Ticket Required');
    return;
  }
  const ticketParam = url.searchParams.get('t') ?? '';
  const ticket = ticketParam === '' ? null : await graph.redeemTicket(ticketParam);
  if (ticketParam !== '' && ticket === null) {
    refuseUpgrade(socket, 401, 'Ticket Expired');
    return;
  }
  if (ticket !== null && ticket.moderation === 'banned') {
    refuseUpgrade(socket, 403, 'Forbidden');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = room.join(new WsTransport(ws));
    if (ticket !== null) conn.deviceId = ticket.profileKey;
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
})(); });

/* ------------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------------ */

/* Finish any trade a crash left mid-settlement — the per-side guards make
 * this a no-op when the last process got everything to disk. */
void trades.recover({ store, defs: liveItemDefs });

/* Open the first season (or finalise one that ended while the host was
 * down) — the journal makes a replayed finalisation pay nobody twice. */
void competitions.ensure({ store, journal });

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
  clearInterval(journalSweeper);
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
  // Accounts are written synchronously at every mutation, so this only drains a
  // write that was in flight when SIGTERM landed. Sessions are NOT flushed:
  // they are in memory by design and a restart signs everybody out.
  try { await accounts.flush(); } catch { /* best effort */ }
  // After the store, because the journal's own writes are already on disk by
  // then: this only closes the append handles.
  try { await journal.close(); } catch { /* best effort */ }
  try { await auditLog.close(); } catch { /* best effort */ }
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

export { router, directory, store, journal, httpServer, wss, signalHub };
