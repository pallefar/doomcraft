/**
 * DOOMCRAFT — the room directory (matchmaking).
 *
 * `ModeRouter` (modes.ts) already answers "which room does this request belong
 * in". This file is the thin, READ-MOSTLY layer over it that a browser can talk
 * to before it opens a socket:
 *
 *   - list the open public rooms,
 *   - mint a private room behind a six-character join code,
 *   - resolve a code back to a room key,
 *   - answer "where do I play right now" in one round trip.
 *
 * THE DESIGN CONSTRAINT, restated from docs/INFRASTRUCTURE.md: matchmaking is
 * not allowed to be the bottleneck, and it is not allowed to be a wait. The bar
 * (ref/BAR.md weakness #5) takes ~25 s from click to shooting because it queues
 * you into a lobby. We do not queue anybody, ever:
 *
 *   **A client never has to call this file to start playing.** It can open
 *   `/ws?mode=deathmatch` directly and the router creates or reuses a room that
 *   is *already ticking with bots in it* — see `ModeDef.botFill` and
 *   `Room.maintainBots`. The directory exists so the UI can show a room list
 *   and honour a join code, not so the game can start.
 *
 * Everything here is derived from the router on demand. The ONLY state this
 * file owns is the private-code table, which is a `Map` of at most `maxPrivate`
 * entries, each one 6 characters and a room key, swept on a timer. That is
 * deliberately per-process: a multi-box fleet moves the table into the director
 * tier described in docs/INFRASTRUCTURE.md §"Rooms are the deploy unit", and
 * nothing else in this file has to change when it does.
 */

import { ModeId, MODE_KEYS, clampSkill, isModeId, sanitiseContentId } from '@doomcraft/shared/modes';
import { roomKeyForRequest, type ModeJoinRequest, type ModeSimPlan, type RoomLike } from './modes.js';
import { makeCode, normaliseCode, seededRandom } from './worlds.js';

/* ------------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------------ */

/** An unused private code is forgotten after this long. */
export const DEFAULT_RESERVATION_TTL_MS = 30 * 60_000;
/** Hard cap on live codes, so the table cannot be grown without bound. */
export const DEFAULT_MAX_PRIVATE = 512;
/** How many codes to try before admitting the table is too crowded. */
const CODE_ATTEMPTS = 24;
/** The separator that makes a private key impossible to reach by accident. */
export const PRIVATE_KEY_MARK = '~';

/* ------------------------------------------------------------------------ *
 * What the directory reads
 * ------------------------------------------------------------------------ */

/**
 * The three methods the directory needs from a `ModeRouter`. Declared
 * structurally so this file never has to know the room type, and so a test can
 * hand it a table of fakes.
 */
export interface DirectorySource<T extends RoomLike = RoomLike> {
  keys(): string[];
  get(key: string): T | null;
  planOf(key: string): ModeSimPlan | null;
}

/** One row of the room list. This is the JSON the client sees. */
export interface RoomSummary {
  key: string;
  mode: string;
  modeId: number;
  levelId: string;
  worldId: string;
  skill: number;
  /** Humans in the room right now. */
  humans: number;
  /** Bodies in the room, humans and bots together. */
  players: number;
  maxPlayers: number;
  /** False when the room is full. A full room is still listed, greyed out. */
  open: boolean;
  /** True when bots are already fighting in there — i.e. you can start now. */
  bots: boolean;
  state: string;
}

/** The answer to "where do I play?". `ws` is ready to hand to a WebSocket. */
export interface MatchTicket {
  /** Path plus query, relative to the server origin. Never absolute. */
  ws: string;
  mode: string;
  modeId: number;
  levelId: string;
  worldId: string;
  skill: number;
  /** The room this will land in, when one already exists. */
  key: string | null;
  /** Humans already in that room. 0 when it does not exist yet. */
  humans: number;
  /** True when the room does not exist yet and will be built on connect. */
  fresh: boolean;
  /** Private rooms only. */
  code: string | null;
}

/* ------------------------------------------------------------------------ *
 * Private reservations
 * ------------------------------------------------------------------------ */

export interface Reservation {
  code: string;
  /** The router base key. Always contains `PRIVATE_KEY_MARK`. */
  key: string;
  req: ModeJoinRequest;
  createdMs: number;
  /** Bumped every time somebody resolves the code. */
  touchedMs: number;
}

export interface RoomDirectoryOptions<T extends RoomLike = RoomLike> {
  source: DirectorySource<T>;
  clock?: () => number;
  /** 0..1 generator for join codes. Seed it in a test to pin the codes. */
  rand?: () => number;
  reservationTtlMs?: number;
  maxPrivate?: number;
}

/* ------------------------------------------------------------------------ *
 * Request parsing
 *
 * The wire form of a join request on the HTTP/WS side is a query string, not a
 * `C2S_MODE.SELECT` packet, because the routing decision has to be made BEFORE
 * the socket attaches to a room — a client that attached first and selected
 * afterwards would either reconfigure a stranger's match or have to be moved
 * between rooms mid-session. So the mode travels in the URL.
 * ------------------------------------------------------------------------ */

/** Read a join request out of `?mode=&level=&world=&skill=&seed=`. */
export function joinRequestFromQuery(params: URLSearchParams): ModeJoinRequest {
  const raw = (params.get('mode') ?? '').toLowerCase();
  const byKey = MODE_KEYS.indexOf(raw);
  const byNumber = Number.parseInt(raw, 10);
  const modeId: ModeId = byKey >= 0
    ? (byKey as ModeId)
    : (isModeId(byNumber) ? (byNumber as ModeId) : ModeId.DEATHMATCH);
  const seed = Number.parseInt(params.get('seed') ?? '', 10);
  const skill = Number.parseInt(params.get('skill') ?? '', 10);
  return {
    modeId,
    skill: clampSkill(Number.isFinite(skill) ? skill : 2),
    levelId: sanitiseContentId(params.get('level') ?? ''),
    worldId: sanitiseContentId(params.get('world') ?? ''),
    seed: Number.isFinite(seed) ? seed >>> 0 : 0,
    flags: 0,
  };
}

/**
 * The query string that would produce `req`. The inverse of the above.
 *
 * A join code is EXCLUSIVE: it already names one specific room, and the
 * upgrade handler ignores the mode when a code is present, so emitting both
 * would put a field on the wire that looks authoritative and is not. This
 * matches `gameSocketUrl` in client/src/net/serverConfig.ts exactly — the two
 * build the same URL and are asserted to round-trip in directory.test.ts.
 */
export function queryForRequest(req: ModeJoinRequest, code?: string | null): string {
  const p = new URLSearchParams();
  if (code) {
    p.set('code', code);
    return p.toString();
  }
  p.set('mode', MODE_KEYS[req.modeId] ?? 'deathmatch');
  if (req.levelId) p.set('level', req.levelId);
  if (req.worldId) p.set('world', req.worldId);
  if (req.modeId === ModeId.QUEST) p.set('skill', String(req.skill));
  return p.toString();
}

/* ------------------------------------------------------------------------ *
 * The directory
 * ------------------------------------------------------------------------ */

export class RoomDirectory<T extends RoomLike = RoomLike> {
  private readonly source: DirectorySource<T>;
  private readonly clock: () => number;
  private readonly rand: () => number;
  private readonly ttlMs: number;
  private readonly maxPrivate: number;
  private readonly codes = new Map<string, Reservation>();

  constructor(options: RoomDirectoryOptions<T>) {
    this.source = options.source;
    this.clock = options.clock ?? (() => Date.now());
    this.rand = options.rand ?? seededRandom(((Math.random() * 0xffffffff) >>> 0) || 1);
    this.ttlMs = Math.max(60_000, options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS);
    this.maxPrivate = Math.max(1, options.maxPrivate ?? DEFAULT_MAX_PRIVATE);
  }

  /* --- listing --------------------------------------------------------- */

  /** True for a key minted by `createPrivate`. Private rooms are never listed. */
  static isPrivateKey(key: string): boolean {
    return key.includes(PRIVATE_KEY_MARK);
  }

  /**
   * The public rooms, busiest first — a half-full room is a better match than
   * an empty one, and filling rooms in order is also what keeps the box count
   * honest in the cost model.
   */
  list(modeId?: ModeId): RoomSummary[] {
    const out: RoomSummary[] = [];
    for (const key of this.source.keys()) {
      if (RoomDirectory.isPrivateKey(key)) continue;
      const room = this.source.get(key);
      const plan = this.source.planOf(key);
      if (room === null || plan === null) continue;
      if (modeId !== undefined && plan.modeId !== modeId) continue;
      const status = safeStatus(room);
      out.push({
        key,
        mode: MODE_KEYS[plan.modeId] ?? 'deathmatch',
        modeId: plan.modeId,
        levelId: plan.levelId,
        worldId: plan.worldId,
        skill: plan.skill,
        humans: room.humanCount,
        players: numberOf(status.players),
        maxPlayers: room.maxPlayers,
        open: room.humanCount < room.maxPlayers,
        bots: numberOf(status.bots) > 0,
        state: typeof status.state === 'string' ? status.state : 'idle',
      });
    }
    out.sort((a, b) => (b.humans - a.humans) || a.key.localeCompare(b.key));
    return out;
  }

  /* --- private rooms ---------------------------------------------------- */

  /**
   * Mint a code for a room that does not exist yet.
   *
   * Nothing is constructed here on purpose: a room is 169 chunks of terrain and
   * a 20 Hz timer, and a player who copies a code and never uses it must not
   * cost a core. The router builds it on the first socket that arrives with the
   * code, exactly as it builds a public room on the first socket.
   */
  createPrivate(req: ModeJoinRequest): Reservation | null {
    this.sweep();
    if (this.codes.size >= this.maxPrivate) return null;
    const now = this.clock();
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = makeCode(this.rand);
      if (this.codes.has(code)) continue;
      const reservation: Reservation = {
        code,
        key: `${roomKeyForRequest(req)}${PRIVATE_KEY_MARK}${code}`,
        req,
        createdMs: now,
        touchedMs: now,
      };
      this.codes.set(code, reservation);
      return reservation;
    }
    return null;
  }

  /** Resolve a typed-in code. Accepts "9K M-2 QD" for "9km2qd". */
  resolveCode(raw: string): Reservation | null {
    const code = normaliseCode(raw);
    if (code.length === 0) return null;
    const hit = this.codes.get(code);
    if (hit === undefined) return null;
    hit.touchedMs = this.clock();
    return hit;
  }

  /**
   * Forget codes nobody used and whose room is gone. A code whose room still
   * exists is kept alive regardless of age — the match is still being played.
   */
  sweep(): number {
    const now = this.clock();
    let dropped = 0;
    for (const [code, r] of [...this.codes]) {
      if (this.source.get(r.key) !== null) { r.touchedMs = now; continue; }
      if (now - r.touchedMs < this.ttlMs) continue;
      this.codes.delete(code);
      dropped++;
    }
    return dropped;
  }

  get privateCount(): number { return this.codes.size; }

  /* --- the one-round-trip answer ---------------------------------------- */

  /**
   * "Where do I play?" — the endpoint that replaces a lobby queue.
   *
   * It never waits and never creates anything. It reports the room the client's
   * next socket will land in and, crucially, whether that room is already live,
   * so the UI can say "3 playing" instead of "searching…".
   */
  quickplay(req: ModeJoinRequest, code?: string | null): MatchTicket {
    const reservation = code ? this.resolveCode(code) : null;
    if (code && reservation === null) {
      // A bad code must not silently drop the player into a public room.
      throw new UnknownCodeError(code);
    }
    const effective = reservation !== null ? reservation.req : req;
    const baseKey = reservation !== null ? reservation.key : roomKeyForRequest(effective);

    // The router spills to `key#2`, `key#3`… when an instance fills up, so the
    // room a socket lands in is the first of those with a seat free.
    let landing: string | null = null;
    let humans = 0;
    for (let n = 0; n < 64; n++) {
      const key = n === 0 ? baseKey : `${baseKey}#${n + 1}`;
      const room = this.source.get(key);
      if (room === null) break;
      if (room.humanCount < room.maxPlayers) { landing = key; humans = room.humanCount; break; }
    }

    return {
      ws: `/ws?${queryForRequest(effective, reservation?.code ?? null)}`,
      mode: MODE_KEYS[effective.modeId] ?? 'deathmatch',
      modeId: effective.modeId,
      levelId: effective.levelId,
      worldId: effective.worldId,
      skill: effective.skill,
      key: landing,
      humans,
      fresh: landing === null,
      code: reservation?.code ?? null,
    };
  }

  status(): Record<string, unknown> {
    return { privateCodes: this.codes.size, maxPrivate: this.maxPrivate, ttlMs: this.ttlMs };
  }
}

/** Thrown by `quickplay` when a join code does not resolve. */
export class UnknownCodeError extends Error {
  constructor(readonly code: string) {
    super('no such room code');
    this.name = 'UnknownCodeError';
  }
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

function safeStatus(room: RoomLike): Record<string, unknown> {
  try { return room.status(); } catch { return {}; }
}

function numberOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
