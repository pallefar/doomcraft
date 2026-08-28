/**
 * DOOMCRAFT — the choice between the room in this tab and a room on a server.
 *
 * `client/src/game/game.ts` used to call `createLocalServer()` unconditionally,
 * so every mode ran the authoritative room in a Worker and the entire server
 * tier had no shipped client. This file is that missing branch, and it is only
 * a branch: both sides speak the identical binary protocol over the identical
 * `ClientTransport` seam (see transport.ts), so nothing downstream of here —
 * not `NetClient`, not prediction, not the chunk inflater, not a single mode —
 * can tell them apart.
 *
 * THE THREE RULES
 *
 * 1. **Offline must keep working, and it is the DEFAULT.** The live site is
 *    static hosting with no server. If no server is configured, or a configured
 *    one does not answer inside `PROBE_TIMEOUT_MS`, or it answers "draining",
 *    the session is local and the player never learns there was a question.
 *    There is no code path here that can produce a spinner.
 *
 * 2. **Some modes are local even when a server exists.** Quest single-player
 *    and a local Builder world cost the server real money (docs/INFRASTRUCTURE
 *    .md sizes the fleet in millicores per player) and gain the player nothing:
 *    they have no opponents. They stay in the Worker, where they also keep
 *    working on a plane. Deathmatch and a shared Builder world go remote,
 *    because being online is the entire point of them.
 *
 * 3. **A remote session that fails falls back, once, and stays fallen.** A
 *    server that is down at connect time is indistinguishable from one that
 *    dies four seconds in, and the answer to both is the room in the Worker —
 *    which is already how single player works, so it is not a degraded mode. It
 *    falls back exactly once per `start()` so a flapping server cannot put the
 *    player in a reconnect loop between two worlds.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It does not migrate a live match. Switching sessions is a disconnect and a
 * reconnect: a new world, a new player id, a new match. Moving a player between
 * two authoritative simulations without either one noticing needs a state
 * handoff the protocol does not have (`docs/CONTRACT.md` §15) and would be a
 * wire change, not wiring.
 */

import { ModeId, legacyGameMode } from '@shared/modes';
import type { ClientTransport } from './transport.js';
import { createLocalServer, type LocalServer, type LocalServerOptions } from './localServer.js';
import { apiUrl, gameSocketUrl, resolveServerUrl, type RemoteJoin } from './serverConfig.js';
import { ticketedWebSocketTransport } from './transport.js';
import { probeServer, type ServerHealth } from './matchmaker.js';

/* ------------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------------ */

/** Which pipe the authoritative room is on. */
export type SessionKind = 'local' | 'remote';

/**
 * Modes that go to a server when one is configured and reachable.
 *
 * Horde is deliberately NOT in this set even though it is co-op: it has no
 * matchmaking UI yet, so a Horde player sent to a server would be alone in a
 * room that costs a core, when the identical experience is free in the Worker.
 * Add it here the day the room list can show "2/4 fighting wave 7".
 */
export const ONLINE_MODES: ReadonlySet<ModeId> = new Set([ModeId.DEATHMATCH]);

/**
 * How long a remote session may take to produce its first packet before the
 * client stops waiting and plays locally instead.
 *
 * A cold WebSocket to a distant region is ~200 ms to open and the WELCOME comes
 * back on the first tick after that; the join burst that follows is bandwidth,
 * not latency. 6 s is therefore ~20x the honest worst case, which is the right
 * shape for a deadline whose job is to catch "there is nothing there" rather
 * than to police a slow network.
 */
export const REMOTE_CONNECT_DEADLINE_MS = 6000;

/**
 * How long a health answer is reused.
 *
 * The probe runs on the path from "click Play" to "shooting", so it must not
 * cost a round trip every match. 15 s is long enough that leaving a match and
 * starting another is free, and short enough that a host that started draining
 * while the player was in the menu is noticed before they are sent to it.
 */
export const PROBE_CACHE_MS = 15_000;

/* ------------------------------------------------------------------------ *
 * What a session is asked for
 * ------------------------------------------------------------------------ */

export interface SessionTarget {
  modeId: ModeId;
  /** Authored level (Quest). */
  levelId?: string;
  /** Persistent world (Builder). */
  worldId?: string;
  skill?: number;
  /** Private room join code. Forces remote — a code is a server's room. */
  code?: string;
  /** Force one side regardless of policy. `?server=` and tests use this. */
  force?: SessionKind;

  /* --- local-room configuration, ignored when remote ------------------- */
  seed?: number;
  botFill?: number;
  enemies?: number;
  allWeapons?: boolean;
  latencyMs?: number;
}

/** Why the session ended up where it did. Shown in the UI and in telemetry. */
export interface SessionState {
  kind: SessionKind;
  /** The server this session is on, or '' when local. */
  url: string;
  /** Human-readable, e.g. 'no server configured', 'server unreachable'. */
  reason: string;
  /** True when this is a remote session that fell back to the Worker. */
  fellBack: boolean;
  health: ServerHealth | null;
}

export interface GameSessionOptions {
  /** Server origin. Defaults to `resolveServerUrl()`; '' means offline-only. */
  serverUrl?: string;
  /** Stable per-device id, so a remote room can attribute XP to a profile. */
  deviceId?: string;
  /** Override the mode policy. */
  onlineModes?: ReadonlySet<ModeId>;
  /** Fired whenever the session moves. */
  onState?(state: SessionState): void;

  /* --- seams, so this is testable without a browser -------------------- */
  probe?: (base: string) => Promise<ServerHealth | null>;
  makeLocal?: (options: LocalServerOptions) => LocalServer;
  makeRemote?: (url: string) => ClientTransport;
  now?: () => number;
}

/* ------------------------------------------------------------------------ *
 * GameSession
 * ------------------------------------------------------------------------ */

export class GameSession {
  readonly serverUrl: string;
  private readonly deviceId: string;
  private readonly onlineModes: ReadonlySet<ModeId>;
  private readonly onState: (state: SessionState) => void;
  private readonly probe: (base: string) => Promise<ServerHealth | null>;
  private readonly makeLocal: (options: LocalServerOptions) => LocalServer;
  private readonly makeRemote: (url: string) => ClientTransport;

  private target: SessionTarget = { modeId: ModeId.DEATHMATCH };
  private state: SessionState = { kind: 'local', url: '', reason: 'not started', fellBack: false, health: null };
  /** The live Worker room, when this session is local. */
  private local: LocalServer | null = null;
  /** The URL `createTransport` will dial, when this session is remote. */
  private remoteUrl = '';
  /** One fallback per `start()`; see rule 3. */
  private fallbackUsed = false;
  private disposed = false;
  /** Bumped by every `start()`, so a probe that resolves late is ignored. */
  private epoch = 0;
  /** Last health answer and when it arrived. See `PROBE_CACHE_MS`. */
  private cachedHealth: ServerHealth | null = null;
  private cachedAtMs = -Infinity;
  /** In-flight probe, shared so two fast Play clicks make one request. */
  private probeInFlight: Promise<ServerHealth | null> | null = null;
  private readonly now: () => number;

  constructor(options: GameSessionOptions = {}) {
    this.serverUrl = options.serverUrl ?? resolveServerUrl();
    this.deviceId = options.deviceId ?? '';
    this.onlineModes = options.onlineModes ?? ONLINE_MODES;
    this.onState = options.onState ?? ((): void => { /* nobody listening */ });
    this.probe = options.probe ?? ((base) => probeServer(base));
    this.makeLocal = options.makeLocal ?? createLocalServer;
    /* C4: the default remote transport fetches a single-use socket ticket
     * at connect time (docs/PLATFORM.md §2.3). Tests that inject their own
     * makeRemote are untouched — a fake transport needs no credential. */
    this.makeRemote = options.makeRemote
      ?? ((url): ClientTransport => ticketedWebSocketTransport(url, () => this.mintTicket()));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * One ticket per connection attempt — they are single-use and 120 s by
   * design, so caching one would be a bug. '' means "connect anonymously":
   * the mint failing must never keep a player out of a match, it only stops
   * that match banking anything.
   */
  private async mintTicket(): Promise<string> {
    try {
      const res = await fetch(apiUrl(this.serverUrl, '/api/session/ticket'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: this.deviceId }),
      });
      if (!res.ok) return '';
      const body = await res.json() as { ticket?: string };
      return typeof body.ticket === 'string' ? body.ticket : '';
    } catch {
      return '';
    }
  }

  /**
   * Ask the server if it is there, at most once per `PROBE_CACHE_MS`.
   *
   * Also the warm-up hook: `Game` fires it during boot, while the menu is
   * painting and the Worker room is coming up, so the answer is already in
   * hand by the time anybody clicks Play and the switch costs nothing.
   */
  async checkServer(force = false): Promise<ServerHealth | null> {
    if (!this.configured || this.disposed) return null;
    if (!force && this.now() - this.cachedAtMs < PROBE_CACHE_MS) return this.cachedHealth;
    if (this.probeInFlight !== null) return this.probeInFlight;
    const inFlight = this.probe(this.serverUrl)
      .catch(() => null)
      .then((health) => {
        this.cachedHealth = health;
        this.cachedAtMs = this.now();
        this.probeInFlight = null;
        return health;
      });
    this.probeInFlight = inFlight;
    return inFlight;
  }

  /** Where this session currently is. */
  get current(): SessionState { return this.state; }
  get kind(): SessionKind { return this.state.kind; }
  /** The Worker room, or null when this session is remote. */
  get localServer(): LocalServer | null { return this.local; }
  /** True when a server is configured at all. The UI greys out online without it. */
  get configured(): boolean { return this.serverUrl.length > 0; }

  /**
   * Would this target go remote, if a server answered?
   *
   * Pure policy, no I/O — the mode picker calls it to decide whether to show
   * "Online" on a tile before anything has been probed.
   */
  prefersRemote(target: SessionTarget): boolean {
    if (target.force === 'local') return false;
    if (target.force === 'remote') return true;
    if (!this.configured) return false;
    // A join code is by definition a room on a server.
    if (target.code !== undefined && target.code.length > 0) return true;
    // A Builder world that only exists on this device has nothing to share.
    if (target.modeId === ModeId.BUILDER) return (target.worldId ?? '').length > 0;
    return this.onlineModes.has(target.modeId);
  }

  /**
   * Decide where this target plays and make that side ready to be connected to.
   *
   * Resolves with the state it settled on. It NEVER rejects: an unreachable
   * server resolves as a local session, which is the whole point of the file.
   */
  async start(target: SessionTarget): Promise<SessionState> {
    if (this.disposed) return this.state;
    const epoch = ++this.epoch;
    this.target = { ...target };
    this.fallbackUsed = false;
    this.teardown();

    if (!this.prefersRemote(target)) {
      return this.settleLocal(
        this.configured ? 'this mode plays in your browser' : 'no server configured',
        false,
        null,
      );
    }

    // The one await on the path to play, and it is bounded by `probeServer`'s
    // own AbortController — and usually already answered, because `Game` warms
    // it during boot. A server that does not answer inside it is treated as
    // absent, which is exactly how the static deploy behaves today.
    const health = await this.checkServer();
    if (epoch !== this.epoch || this.disposed) return this.state;
    if (health === null) {
      return this.settleLocal('server unreachable — playing offline', true, null);
    }

    const join: RemoteJoin = {
      modeId: target.modeId,
      levelId: target.levelId,
      worldId: target.worldId,
      skill: target.skill,
      code: target.code,
    };
    this.remoteUrl = gameSocketUrl(this.serverUrl, join);
    return this.publish({
      kind: 'remote',
      url: this.serverUrl,
      reason: health.humans > 0 ? `${health.humans} online` : 'online',
      fellBack: false,
      health,
    });
  }

  /**
   * Give up on the remote server and bring the Worker room up instead.
   *
   * Returns false when there is nothing to do — already local, or the one
   * fallback for this session has been spent. The caller reconnects on true.
   */
  fallBackToLocal(reason: string): boolean {
    if (this.disposed) return false;
    if (this.state.kind === 'local') return false;
    if (this.fallbackUsed) return false;
    this.fallbackUsed = true;
    // The cached "it is up" answer is now known to be wrong.
    this.cachedHealth = null;
    this.cachedAtMs = -Infinity;
    this.teardown();
    this.settleLocal(reason, true, null);
    return true;
  }

  /**
   * The factory handed to `NetClient`. It is called on the FIRST connect and on
   * every reconnect after that, which is what makes the switch possible without
   * rebuilding the client or forking a second one.
   *
   * A Worker transport is single-use — closing it closes the room — so a local
   * reconnect gets a whole new room. That is correct: the old room's world and
   * player ids are gone either way, and it is why `autoReconnect` is off for
   * local sessions (see `wantsAutoReconnect`).
   */
  createTransport(): ClientTransport {
    if (this.state.kind === 'remote') return this.makeRemote(this.remoteUrl);
    if (this.local === null) this.local = this.buildLocal();
    return this.local.transport;
  }

  /**
   * Should `NetClient` retry by itself?
   *
   * Remote: yes — a dropped socket on a live server is a network blip and the
   * backoff in client.ts is the right answer. Local: no — the Worker room does
   * not drop, and a "reconnect" to it would silently discard the match.
   */
  get wantsAutoReconnect(): boolean { return this.state.kind === 'remote'; }

  /** Only meaningful for a local session driven manually (tests). */
  advance(nowMs: number): void { this.local?.advance(nowMs); }

  /** Ready-when-the-room-exists, for the local side. Resolves at once remotely. */
  get ready(): Promise<void> {
    return this.local?.ready ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
  }

  /* -------------------------------------------------------------- *
   * Internals
   * -------------------------------------------------------------- */

  private teardown(): void {
    const l = this.local;
    this.local = null;
    this.remoteUrl = '';
    l?.stop();
  }

  private settleLocal(reason: string, fellBack: boolean, health: ServerHealth | null): SessionState {
    this.local = this.buildLocal();
    return this.publish({ kind: 'local', url: '', reason, fellBack, health });
  }

  private buildLocal(): LocalServer {
    const t = this.target;
    return this.makeLocal({
      seed: t.seed,
      // The Worker room predates the mode layer and takes the legacy three-way
      // `GameMode`; the client sends a real `C2S_MODE.SELECT` right after
      // connecting, which is what actually configures it. Passing the mode here
      // only decides what it looks like for the first few hundred ms.
      mode: legacyGameMode(t.modeId),
      botFill: t.botFill,
      enemies: t.enemies ?? -1,
      allWeapons: t.allWeapons ?? true,
      latencyMs: t.latencyMs,
    });
  }

  private publish(state: SessionState): SessionState {
    this.state = state;
    this.onState(state);
    return state;
  }
}

