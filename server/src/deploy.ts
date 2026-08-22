/**
 * DOOMCRAFT — the deploy tier: draining, flag resolution, and the version
 * document.
 *
 * This is the server half of the patch system described in
 * `docs/INFRASTRUCTURE.md` §6 and specified in `docs/PATCHING.md`. Three
 * things live here and nothing else:
 *
 *   1. `HostLifecycle` — a host is either admitting, draining, or drained.
 *      **Rooms are the deploy unit.** A deploy starts new hosts, marks the old
 *      ones draining, and the old ones keep running every match they already
 *      have until those matches end on their own. Nobody is disconnected
 *      mid-match because nothing a player is inside is ever restarted.
 *   2. `FlagService` — the operator's flag document, resolved per player,
 *      server-side, so the value can be transmitted rather than guessed at.
 *   3. `versionDocument` — what `/api/version` answers, so a bug report can
 *      name the exact three axes it came from.
 *
 * ## The drain has TWO gates, and it needs both
 *
 * 1. `guardCreate` — no new ROOM. Wrapped around the room factory, below.
 * 2. `admitting` — no new PLAYER, into any room, including the ones already
 *    running here. `server/src/index.ts` passes it to every `Room` as
 *    `RoomOptions.admitting`, and `net.ts` turns a HELLO away with
 *    `UpdateReason.HOST_DRAINING`.
 *
 * The second gate used to be missing, and the drain could not converge without
 * it. Gate creation alone and a busy `deathmatch` key is repopulated as fast as
 * it empties: arrivals keep the humans count above zero forever, the host never
 * reaches `DRAINED`, and the only thing that ever ends the rollout is
 * `forceMigrateMs` — a deadline whose whole cost is `forcedPlayers`, the number
 * this file exists to keep at zero. "Existing matches run to completion" is a
 * claim about the players who are already in them, not a licence to admit more.
 *
 * It is worth naming what this costs, because it is a real player: your friend
 * is nine minutes into a match on this host, you click their invite, and you
 * are turned away from a match that is still alive. What they get is
 * `HOST_DRAINING` — "your next match starts on the new one" — and a room on a
 * host that is not about to disappear. A drain that never finishes costs more,
 * and it costs it to everybody still inside when the deadline fires.
 *
 * ## Why the factory and not the router
 *
 * `ModeRouter` takes its room factory by injection, so wrapping the factory
 * gates the one place a room can possibly come into existence — no matter who
 * calls `route`, no matter what a later caller is added. Gating `route` itself
 * would leave every other path open, and gating it inside `ModeRouter` would
 * put deploy policy inside the matchmaker.
 */

import {
  BUILD_ID,
  CONTENT_MIN_SUPPORTED,
  CONTENT_VERSION,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  PROTOCOL_WINDOW_DAYS,
  protocolFingerprint,
} from '@doomcraft/shared/version';
import {
  FLAGS,
  FLAG_ORDER,
  createFlagConfig,
  flagConfigETag,
  hostBucket,
  nextFlagDocument,
  parseFlagConfig,
  resolveFlagBits,
  unpackFlags,
  type FlagConfig,
  type FlagWrite,
} from '@doomcraft/shared/flags';

/* ------------------------------------------------------------------------ *
 * Drain
 * ------------------------------------------------------------------------ */

export enum HostState {
  /** Normal. New rooms are created here. */
  ADMITTING = 0,
  /** No new rooms and no new players. Live matches run to completion. */
  DRAINING = 1,
  /** Every room is gone. Safe to exit. */
  DRAINED = 2,
}

export const HOST_STATE_NAMES: readonly string[] = ['admitting', 'draining', 'drained'];

/**
 * Thrown by the guarded room factory when a draining host is asked for a new
 * room. The caller turns it into `UpdateReason.HOST_DRAINING`, which the client
 * reads as "your next match starts on the new host" rather than as an error.
 */
export class HostDrainingError extends Error {
  constructor() {
    super('host is draining and will not create new rooms');
    this.name = 'HostDrainingError';
  }
}

/** What the lifecycle needs to see of one live room. */
export interface LiveRoom {
  key: string;
  humans: number;
}

export interface HostLifecycleOptions {
  /** Wall clock, ms. Injected so a test does not have to wait 30 minutes. */
  clock?: () => number;
  /**
   * The hard stop. A draining host force-closes whatever is left at
   * `drainStart + forceMigrateMs`.
   *
   * Bounded on purpose: without a deadline one player idling in a Builder world
   * pins an old binary online forever, and "we cannot finish the rollout
   * because of one AFK" is how a fleet ends up with six live versions. 30
   * minutes is INFRASTRUCTURE.md's number, chosen to sit beyond p99 match
   * length for every mode.
   */
  forceMigrateMs?: number;
  /** Enumerate live rooms. Wired to `ModeRouter.status()` in production. */
  liveRooms(): LiveRoom[];
  /**
   * Stop one room. Wired to `ModeRouter.get(key)?.stop()`.
   *
   * It does NOT have to remove the room from the caller's table — the lifecycle
   * remembers what it has already stopped and never counts or stops it twice.
   * That keeps this interface satisfiable by every room table without teaching
   * the matchmaker about deploys.
   */
  stopRoom(key: string): void;
  /** Called once, when the last room is gone or the deadline forced it. */
  onDrained?(): void;
}

export const DEFAULT_FORCE_MIGRATE_MS = 30 * 60_000;

export class HostLifecycle {
  private state = HostState.ADMITTING;
  private drainStartMs = -1;
  private drainedFired = false;
  private readonly clock: () => number;
  private readonly forceMigrateMs: number;
  private readonly liveRooms: () => LiveRoom[];
  private readonly stopRoom: (key: string) => void;
  private readonly onDrained: (() => void) | null;
  /**
   * Rooms this lifecycle has already stopped.
   *
   * A key cannot come back: a draining host creates no rooms, so nothing can
   * ever reoccupy a stopped key. That is what makes remembering keys, rather
   * than requiring the caller to delete rows, correct rather than merely
   * convenient.
   */
  private readonly stopped = new Set<string>();
  /** Rooms the deadline had to close. A rollout-quality metric, not a counter. */
  forcedRooms = 0;
  /** Players who were in one of those rooms. This is the number that matters. */
  forcedPlayers = 0;

  constructor(options: HostLifecycleOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.forceMigrateMs = Math.max(0, options.forceMigrateMs ?? DEFAULT_FORCE_MIGRATE_MS);
    this.liveRooms = options.liveRooms;
    this.stopRoom = options.stopRoom;
    this.onDrained = options.onDrained ?? null;
  }

  get status(): HostState { return this.state; }
  get statusName(): string { return HOST_STATE_NAMES[this.state] ?? 'unknown'; }
  get draining(): boolean { return this.state !== HostState.ADMITTING; }
  get drained(): boolean { return this.state === HostState.DRAINED; }

  /**
   * `NetHost.admitting`: false stops this host taking on anything new —
   * including a new player into a room it is already running.
   *
   * Wired into every `Room` as `RoomOptions.admitting` in
   * `server/src/index.ts`. Without that wiring the drain cannot converge; see
   * the header. Read live, so `beginDrain()` takes effect on the next HELLO.
   */
  get admitting(): boolean { return this.state === HostState.ADMITTING; }

  /** True while this host may still bring a new room into existence. */
  get mayCreateRoom(): boolean { return this.state === HostState.ADMITTING; }

  /** When the deadline fires, or -1 while admitting. */
  get deadlineMs(): number {
    return this.drainStartMs < 0 ? -1 : this.drainStartMs + this.forceMigrateMs;
  }

  /** Milliseconds left before the deadline; 0 once it has passed. */
  msUntilDeadline(): number {
    if (this.drainStartMs < 0) return -1;
    return Math.max(0, this.deadlineMs - this.clock());
  }

  /**
   * Mark this host draining. Idempotent — a second SIGTERM, or a second call
   * from the admin endpoint, must not restart the clock and hand the host
   * another thirty minutes.
   */
  beginDrain(): void {
    if (this.state !== HostState.ADMITTING) return;
    this.state = HostState.DRAINING;
    this.drainStartMs = this.clock();
    // A host with nothing running is drained the moment it is told to drain.
    this.tick();
  }

  /**
   * Wrap a room factory so a draining host cannot make one.
   *
   * `ModeRouter` is handed the result. Everything that can create a room goes
   * through it, including code written after this file.
   */
  guardCreate<A extends unknown[], T>(factory: (...args: A) => T): (...args: A) => T {
    return (...args: A): T => {
      if (!this.mayCreateRoom) throw new HostDrainingError();
      return factory(...args);
    };
  }

  /**
   * Advance the drain. Call it on the same timer that sweeps idle rooms;
   * it is cheap and idempotent.
   *
   * Returns true once the host is fully drained.
   */
  tick(): boolean {
    if (this.state === HostState.ADMITTING) return false;
    if (this.state === HostState.DRAINED) return true;

    // An empty room on a draining host is dead weight: no new player can ever
    // be routed into it, so it is stopped at once rather than waiting out the
    // ordinary idle timeout. This is what makes a drain finish in seconds when
    // the host happened to be quiet.
    for (const r of this.rooms()) {
      if (r.humans <= 0) this.stop(r.key);
    }

    const remaining = this.rooms();
    if (remaining.length === 0) return this.finish();

    if (this.clock() >= this.deadlineMs) {
      // The bound. Everyone still here is being moved, and we count them,
      // because "how many players did this deploy actually interrupt" is the
      // only honest measure of whether the drain budget is right.
      for (const r of remaining) {
        this.forcedRooms++;
        this.forcedPlayers += Math.max(0, r.humans);
        this.stop(r.key);
      }
      return this.finish();
    }
    return false;
  }

  /** Live rooms this lifecycle has not already stopped. */
  private rooms(): LiveRoom[] {
    const all = this.liveRooms();
    if (this.stopped.size === 0) return all;
    return all.filter((r) => !this.stopped.has(r.key));
  }

  private stop(key: string): void {
    if (this.stopped.has(key)) return;
    this.stopped.add(key);
    try { this.stopRoom(key); } catch { /* a room that will not stop is still gone */ }
  }

  private finish(): boolean {
    this.state = HostState.DRAINED;
    if (!this.drainedFired) {
      this.drainedFired = true;
      this.onDrained?.();
    }
    return true;
  }

  /** For `/health` and for the deploy tooling watching a rollout. */
  report(): Record<string, unknown> {
    const rooms = this.state === HostState.DRAINED ? [] : this.rooms();
    let humans = 0;
    for (const r of rooms) humans += Math.max(0, r.humans);
    return {
      state: this.statusName,
      admitting: this.admitting,
      rooms: rooms.length,
      humans,
      msUntilDeadline: this.msUntilDeadline(),
      forcedRooms: this.forcedRooms,
      forcedPlayers: this.forcedPlayers,
    };
  }
}

/* ------------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------------ */

/**
 * Holds the operator's flag document and resolves it per player.
 *
 * Deliberately dumb: no fetching, no polling, no timers. Whoever owns the
 * process decides where the document comes from — an env var at boot, a file, a
 * poll of the config service — and calls `load`. That keeps this testable and
 * keeps the *policy* (how often, from where, signed by whom) out of the
 * mechanism.
 */
export class FlagService {
  private config: FlagConfig = createFlagConfig();
  private tag = flagConfigETag(this.config);

  /**
   * REPLACE the document wholesale. Total: bad input leaves the previous one in
   * force.
   *
   * This is the BOOT path (`DOOMCRAFT_FLAGS`) and it is right there, where the
   * env var is the whole truth. It is the wrong thing for an operator's edit —
   * see `apply`, and see `nextFlagDocument` for what a full replace did to the
   * freeze command `docs/PATCHING.md` prescribes.
   */
  load(input: unknown): FlagConfig {
    const next = parseFlagConfig(input);
    this.config = next;
    this.tag = flagConfigETag(next);
    return next;
  }

  /**
   * MERGE an operator's patch into the live document, with compare-and-swap.
   *
   * A refused write (`ok === false`) changes nothing at all — not the document,
   * not the ETag — so the caller can answer 409 and mean it.
   */
  apply(patch: unknown): FlagWrite {
    const write = nextFlagDocument(this.config, patch);
    if (!write.ok) return write;
    this.config = write.document;
    this.tag = flagConfigETag(write.document);
    return write;
  }

  /** Parse a JSON string, e.g. `DOOMCRAFT_FLAGS`. Never throws. */
  loadJson(text: string | undefined): FlagConfig {
    if (typeof text !== 'string' || text.trim().length === 0) return this.config;
    try {
      return this.load(JSON.parse(text));
    } catch {
      return this.config;
    }
  }

  get document(): FlagConfig { return this.config; }
  get etag(): string { return this.tag; }
  get frozen(): boolean { return this.config.frozen; }

  /** This player's flags as a `u32`, for `S2C.SESSION_CONFIG`. */
  bitsFor(stableId: string): number {
    return resolveFlagBits(this.config, stableId);
  }

  /** This player's flags as a record, for `/api/flags`. */
  resolveFor(stableId: string): Record<string, boolean> {
    return unpackFlags(this.bitsFor(stableId));
  }

  /**
   * Which staged-rollout stage this player is in, 0..10000, unsalted and
   * stable. The DIRECTOR uses this to keep a player on one build across
   * matches; it is not a flag bucket and must not be confused with one.
   */
  hostBucketFor(stableId: string): number {
    return hostBucket(stableId);
  }

  /** The registry, for an admin panel that has to render the switches. */
  registry(): Array<Record<string, unknown>> {
    return FLAG_ORDER.map((key, bit) => {
      const def = FLAGS[key];
      const rule = this.config.rules[key];
      return {
        key, bit,
        kind: def?.kind ?? 'unknown',
        what: def?.what ?? '',
        blastRadius: def?.blastRadius ?? '',
        defaultOn: def?.defaultOn ?? false,
        force: rule?.force ?? null,
        rolloutBp: rule?.rolloutBp ?? 0,
      };
    });
  }
}

/**
 * The identity a flag rollout is bucketed by.
 *
 * The device id is the only stable thing this server has about a player today,
 * and it is the same key the profile store uses. A connection without one gets
 * a per-connection id, which means an anonymous player may land differently in
 * two sessions — acceptable, and better than bucketing everyone anonymous
 * identically and turning a 1% rollout into an all-or-nothing coin flip on the
 * whole anonymous population.
 */
export function stableIdFor(conn: { deviceId?: string; id?: number }): string {
  const d = conn.deviceId ?? '';
  return d.length > 0 ? d : `conn:${conn.id ?? 0}`;
}

/* ------------------------------------------------------------------------ *
 * The version document
 * ------------------------------------------------------------------------ */

/**
 * THIS PROCESS. Minted at module load, never persisted, never reused.
 *
 * Two jobs, and it is the same value for both. A fleet console cannot tell two
 * hosts apart without it — `build.id` is the bundle and every host in a fleet
 * shares it. And the reward journal needs it: a room's `sessionId` is
 * `"<room key>#<round>"`, which repeats across a restart of one host, so
 * anything using that as an idempotency key silently refuses the second
 * process's payouts as duplicates (`docs/PLATFORM.md` §4.2).
 *
 * It lives HERE, next to `BUILD_ID` and inside the version document, so a
 * caller cannot publish a version document without it — the same reason
 * `contentHash` is a required parameter below.
 *
 * `globalThis.crypto` rather than `node:crypto`: this file is imported by
 * `index.ts` only, but the rule that keeps the server tier importable is worth
 * not breaking one file at a time.
 */
export const HOST_ID = ((): string => {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
})();

/**
 * What `/api/version` answers, and what a bug report should carry.
 *
 * All three axes, named separately, because "what version are you on" is not a
 * question with one answer. `protocolFingerprint` is included so two hosts that
 * claim the same protocol version can be checked for actually having the same
 * wire layout — which is precisely the failure a mixed fleet produces and the
 * one nobody thinks to look for.
 *
 * `contentHash` is a REQUIRED parameter, and that is the fix rather than an
 * inconvenience. It used to default to a bare `contentHashFor()` — no level
 * hashes — so the one number `docs/PATCHING.md` says exists precisely so that
 * "two hosts on the same CONTENT_VERSION with different files on disk produce
 * different hashes and are visible in /api/version" was a per-BUILD constant,
 * identical on every host in the fleet. The folded value was computed correctly
 * in `index.ts`, rode `SESSION_CONFIG`, and never reached this document. A
 * default is what let that happen quietly; now a caller that does not have the
 * host's real content hash cannot produce the document at all.
 */
export function versionDocument(
  contentHash: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol: {
      version: PROTOCOL_VERSION,
      minSupported: PROTOCOL_MIN_SUPPORTED,
      windowDays: PROTOCOL_WINDOW_DAYS,
      fingerprint: protocolFingerprint(),
    },
    content: {
      version: CONTENT_VERSION,
      minSupported: CONTENT_MIN_SUPPORTED,
      hash: contentHash >>> 0,
    },
    build: { id: BUILD_ID, host: HOST_ID },
    ...extra,
  };
}
