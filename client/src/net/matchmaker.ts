/**
 * DOOMCRAFT — the client half of the room directory.
 *
 * `server/src/directory.ts` is the other half; read its header first, because
 * the design constraint lives there: **matchmaking is never a wait.** Nothing
 * in this file is on the path between clicking Play and shooting. A client can
 * open the game socket directly and the server will create or reuse a room that
 * is already ticking with bots in it. These calls exist so the UI can show a
 * room list and honour a join code.
 *
 * Everything is therefore:
 *
 *   - **aborted on a deadline.** A directory that is slow is the same as a
 *     directory that is down, because the alternative — the local Worker — is
 *     right there and costs nothing. `DIRECTORY_TIMEOUT_MS` is short on purpose.
 *   - **never fatal.** Every function resolves to a value or null. There is no
 *     path through this module that leaves the caller with an unhandled
 *     rejection or a spinner.
 *   - **validated on arrival.** The server is a different origin and a
 *     different deploy cadence; a field that is missing or the wrong type is
 *     dropped, not trusted into the UI.
 */

import { apiUrl, gameSocketUrl, type RemoteJoin } from './serverConfig.js';

/**
 * How long a directory call may take before the client gives up on it.
 *
 * 2.5 s, and the number is not arbitrary: `probeServer` runs on the path to the
 * mode picker, and the bar we are beating (ref/BAR.md weakness #5) is a ~25 s
 * matchmaking wait. A probe that can cost 2.5 s in the worst case and 0 s in
 * the common one keeps us two orders of magnitude inside that.
 */
export const DIRECTORY_TIMEOUT_MS = 2500;
/** The reachability probe gets less: it is only asking "is anything there". */
export const PROBE_TIMEOUT_MS = 1500;

/* ------------------------------------------------------------------------ *
 * Shapes (mirrors of server/src/directory.ts)
 * ------------------------------------------------------------------------ */

export interface RoomRow {
  key: string;
  mode: string;
  modeId: number;
  levelId: string;
  worldId: string;
  skill: number;
  humans: number;
  players: number;
  maxPlayers: number;
  open: boolean;
  bots: boolean;
  state: string;
}

export interface Ticket {
  ws: string;
  mode: string;
  modeId: number;
  levelId: string;
  worldId: string;
  skill: number;
  key: string | null;
  humans: number;
  fresh: boolean;
  code: string | null;
}

export interface ServerHealth {
  ok: boolean;
  draining: boolean;
  uptimeMs: number;
  rooms: number;
  humans: number;
}

/* ------------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------------ */

/** `fetch` with a deadline. Resolves to null on ANY failure, never throws. */
async function getJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> {
  if (typeof fetch !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { controller?.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller?.signal,
      // The directory is public and holds no session; a cookie would only make
      // it a CORS problem.
      credentials: 'omit',
      cache: 'no-store',
    });
    // A draining host answers 503 on /health with a real body worth reading.
    if (!res.ok && res.status !== 503) return null;
    return await res.json() as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : null;
}

/* ------------------------------------------------------------------------ *
 * Calls
 * ------------------------------------------------------------------------ */

/**
 * Is there a server at `base`, and is it taking players?
 *
 * This is the gate in front of every remote path. A `null` answer means "play
 * locally", and it covers all of: no server configured, DNS failure, TLS
 * failure, connection refused, a 500, a slow box, and a host that is draining
 * for a deploy. The caller does not have to distinguish them, because the
 * response to every one of them is the same.
 */
export async function probeServer(base: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ServerHealth | null> {
  if (base.length === 0) return null;
  const body = asRecord(await getJson(apiUrl(base, '/health'), timeoutMs));
  if (body === null) return null;
  const fleet = asRecord(body.fleet) ?? {};
  const health: ServerHealth = {
    ok: bool(body.ok, false),
    draining: bool(body.draining, false),
    uptimeMs: num(body.uptimeMs),
    rooms: num(fleet.rooms),
    humans: num(fleet.humans),
  };
  // A draining host still answers, and still must not be joined.
  return health.ok && !health.draining ? health : null;
}

/** The open public rooms, busiest first. Empty on any failure. */
export async function listRooms(base: string, mode?: string): Promise<RoomRow[]> {
  if (base.length === 0) return [];
  const q = mode !== undefined && mode.length > 0 ? `?mode=${encodeURIComponent(mode)}` : '';
  const body = asRecord(await getJson(apiUrl(base, `/api/rooms${q}`), DIRECTORY_TIMEOUT_MS));
  const rows = body === null ? null : body.rooms;
  if (!Array.isArray(rows)) return [];
  const out: RoomRow[] = [];
  for (const raw of rows) {
    const r = asRecord(raw);
    if (r === null) continue;
    out.push({
      key: str(r.key),
      mode: str(r.mode, 'deathmatch'),
      modeId: num(r.modeId, 3),
      levelId: str(r.levelId),
      worldId: str(r.worldId),
      skill: num(r.skill, 2),
      humans: num(r.humans),
      players: num(r.players),
      maxPlayers: num(r.maxPlayers, 32),
      open: bool(r.open, true),
      bots: bool(r.bots, false),
      state: str(r.state, 'idle'),
    });
  }
  return out;
}

function parseTicket(v: unknown): Ticket | null {
  const t = asRecord(v);
  if (t === null || typeof t.ws !== 'string') return null;
  return {
    ws: t.ws,
    mode: str(t.mode, 'deathmatch'),
    modeId: num(t.modeId, 3),
    levelId: str(t.levelId),
    worldId: str(t.worldId),
    skill: num(t.skill, 2),
    key: typeof t.key === 'string' ? t.key : null,
    humans: num(t.humans),
    fresh: bool(t.fresh, true),
    code: typeof t.code === 'string' ? t.code : null,
  };
}

/**
 * "Where do I play?" — optional. The socket URL this returns is the same one
 * `gameSocketUrl` builds locally; the value of asking is the room's current
 * population, which is what lets the UI say "3 playing" instead of "joining…".
 */
export async function quickplay(base: string, join: RemoteJoin): Promise<Ticket | null> {
  if (base.length === 0) return null;
  // Reuse the exact query the socket would carry, so the two can never drift.
  const socket = gameSocketUrl(base, join);
  const query = socket.slice(socket.indexOf('?'));
  return parseTicket(asRecord(await getJson(apiUrl(base, `/api/quickplay${query}`), DIRECTORY_TIMEOUT_MS))?.ticket);
}

/** Mint a private room. Returns its join code, or null. */
export async function createPrivateRoom(
  base: string,
  join: Omit<RemoteJoin, 'code'>,
): Promise<{ code: string; ticket: Ticket | null } | null> {
  if (base.length === 0) return null;
  const body = asRecord(await getJson(apiUrl(base, '/api/rooms/private'), DIRECTORY_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: join.modeId,
      level: join.levelId ?? '',
      world: join.worldId ?? '',
      skill: join.skill ?? 2,
    }),
  }));
  if (body === null || typeof body.code !== 'string' || body.code.length === 0) return null;
  return { code: body.code, ticket: parseTicket(body.ticket) };
}

/**
 * Resolve a typed-in join code without opening a socket, so a typo is an
 * error message in the menu rather than a failed connection behind a spinner.
 */
export async function resolveCode(base: string, code: string): Promise<Ticket | null> {
  if (base.length === 0 || code.length === 0) return null;
  const url = apiUrl(base, `/api/quickplay?code=${encodeURIComponent(code)}`);
  return parseTicket(asRecord(await getJson(url, DIRECTORY_TIMEOUT_MS))?.ticket);
}
