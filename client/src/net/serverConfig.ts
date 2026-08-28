/**
 * DOOMCRAFT — where the game server is, if there is one at all.
 *
 * THE DEFAULT IS "NOWHERE", AND THAT IS THE IMPORTANT PART.
 *
 * The live site (https://doomcraft.vercel.app) is static hosting with no server
 * behind it. Every mode runs the authoritative room in a Worker in the tab and
 * costs $0 to serve — see docs/INFRASTRUCTURE.md §0.1. If this file ever
 * *guessed* at a server URL, that build would try to open a socket to a host
 * that is not there, and the player would watch a spinner instead of a game.
 *
 * So the rule is: a server URL has to be configured, explicitly, by exactly one
 * of five sources, checked in this order:
 *
 *   1. `?server=wss://…`   — one match, for testing and for a shared link.
 *   2. `localStorage`      — sticky, set by the same query param or by the UI.
 *   3. `<meta name="doomcraft-server" content="self">` — stamped into the
 *      document by `server/src/index.ts` as it serves it. This is how the
 *      Docker image works with no configuration: the host that answered the
 *      request is the host with the rooms, and it says so. The static host
 *      never stamps it, so the identical bundle stays offline there.
 *   4. `VITE_DOOMCRAFT_SERVER` — baked at build time, for a static deploy whose
 *      rooms live on a different origin. Absent, the bundle is offline-only.
 *   5. In `vite dev` only, same-origin — because `client/vite.config.ts` already
 *      proxies `/ws` to `localhost:8080`, so a developer running `npm run dev`
 *      gets the real server with no configuration at all.
 *
 * Nothing here opens a socket or does any I/O. It answers "what URL, if any",
 * and `session.ts` decides whether it is reachable.
 */

import { MODE_KEYS, ModeId } from '@shared/modes';

/** localStorage key for a sticky server override. */
export const SERVER_URL_KEY = 'doomcraft:server';
/** Query parameter that sets it. `?server=off` clears it back to offline. */
export const SERVER_URL_PARAM = 'server';

/** The build-time default. Empty in every build that has no server. */
function bakedServerUrl(): string {
  // `import.meta.env` is Vite's; guard so this module also loads under vitest
  // and under the Worker, neither of which necessarily define it.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_DOOMCRAFT_SERVER ?? '').trim();
}

/** The tag `server/src/index.ts` stamps into every document it serves. */
export const SERVER_META_NAME = 'doomcraft-server';

/**
 * The origin advertised by the page itself, or ''.
 *
 * `content="self"` means "the origin you loaded this page from", which is the
 * only value that survives a proxy, a CDN and localhost alike. An absolute URL
 * is also accepted, for a deployment that serves the client from one host and
 * the rooms from another.
 */
function metaServerUrl(origin: string): string {
  if (typeof document === 'undefined') return '';
  const tag = document.querySelector(`meta[name="${SERVER_META_NAME}"]`);
  const content = (tag?.getAttribute('content') ?? '').trim();
  if (content.length === 0) return '';
  return content === 'self' ? normaliseServerUrl(origin) : normaliseServerUrl(content);
}

function isDevServer(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  return env?.DEV === true;
}

/**
 * Accept only an absolute ws/wss/http/https origin, or ''.
 *
 * A relative value is refused rather than resolved: the whole point of the
 * setting is to name a DIFFERENT origin from the static host, and silently
 * resolving `/ws` against a Vercel deployment would produce a socket to a host
 * that answers 404 forever.
 */
export function normaliseServerUrl(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  if (v.length === 0) return '';
  // Explicit opt-out, so a sticky override can be cleared from the URL bar.
  if (v === 'off' || v === 'none' || v === '0') return '';
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return '';
  }
  const scheme = parsed.protocol;
  if (scheme !== 'ws:' && scheme !== 'wss:' && scheme !== 'http:' && scheme !== 'https:') return '';
  // Keep the path (a server may live under a prefix) but drop query and hash,
  // which are ours to add. A trailing slash is normalised away.
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${scheme}//${parsed.host}${path}`;
}

/** Persist (or clear) the sticky override. Never throws in private mode. */
export function storeServerUrl(url: string): void {
  try {
    if (url.length === 0) localStorage.removeItem(SERVER_URL_KEY);
    else localStorage.setItem(SERVER_URL_KEY, url);
  } catch { /* private mode */ }
}

function readStoredServerUrl(): string {
  try { return normaliseServerUrl(localStorage.getItem(SERVER_URL_KEY)); } catch { return ''; }
}

/**
 * The configured server origin, or '' for "this build is offline-only".
 *
 * `search` and `origin` are injectable so this is testable without a DOM.
 */
export function resolveServerUrl(
  search: string = typeof location === 'undefined' ? '' : location.search,
  origin: string = typeof location === 'undefined' ? '' : location.origin,
): string {
  const params = new URLSearchParams(search);
  if (params.has(SERVER_URL_PARAM)) {
    const fromQuery = normaliseServerUrl(params.get(SERVER_URL_PARAM));
    // A query param is also how you turn it OFF, so persist the empty string.
    storeServerUrl(fromQuery);
    return fromQuery;
  }
  const stored = readStoredServerUrl();
  if (stored.length > 0) return stored;
  const advertised = metaServerUrl(origin);
  if (advertised.length > 0) return advertised;
  const baked = normaliseServerUrl(bakedServerUrl());
  if (baked.length > 0) return baked;
  // `vite dev` proxies /ws and /rtc to localhost:8080 already.
  if (isDevServer() && origin.length > 0) return normaliseServerUrl(origin);
  return '';
}

/* ------------------------------------------------------------------------ *
 * URL construction
 * ------------------------------------------------------------------------ */

/** `https://host` -> `wss://host`. Leaves ws/wss alone. */
export function toWebSocketOrigin(base: string): string {
  if (base.startsWith('https:')) return `wss:${base.slice('https:'.length)}`;
  if (base.startsWith('http:')) return `ws:${base.slice('http:'.length)}`;
  return base;
}

/** `wss://host` -> `https://host`. Leaves http/https alone. */
export function toHttpOrigin(base: string): string {
  if (base.startsWith('wss:')) return `https:${base.slice('wss:'.length)}`;
  if (base.startsWith('ws:')) return `http:${base.slice('ws:'.length)}`;
  return base;
}

/** Everything the server needs to route a socket to the right room. */
export interface RemoteJoin {
  modeId: ModeId;
  levelId?: string;
  worldId?: string;
  skill?: number;
  /** Private room join code. Overrides mode/level entirely, server side. */
  code?: string;
}

/**
 * The game socket URL.
 *
 * The mode travels in the QUERY, not in a `C2S_MODE.SELECT` after the socket is
 * open, because the server has to pick a room before it attaches the socket to
 * one — see the header of `server/src/index.ts`. That is the one protocol-shaped
 * decision in this file and it is why online mode switching is a reconnect.
 */
export function gameSocketUrl(base: string, join: RemoteJoin): string {
  const p = new URLSearchParams();
  if (join.code !== undefined && join.code.length > 0) {
    p.set('code', join.code);
  } else {
    p.set('mode', MODE_KEYS[join.modeId] ?? 'deathmatch');
    if (join.levelId) p.set('level', join.levelId);
    if (join.worldId) p.set('world', join.worldId);
    if (join.modeId === ModeId.QUEST && join.skill !== undefined) p.set('skill', String(join.skill));
  }
  // C4: identity does NOT ride the URL. `?device=` is refused server-side
  // (PLATFORM §2.1 defect #7); the transport appends a single-use `?t=`
  // ticket it fetched seconds earlier — see ticketedWebSocketTransport.
  return `${toWebSocketOrigin(base)}/ws?${p.toString()}`;
}

/** The JSON API base for the directory endpoints. */
export function apiUrl(base: string, path: string): string {
  return `${toHttpOrigin(base)}${path.startsWith('/') ? path : `/${path}`}`;
}
