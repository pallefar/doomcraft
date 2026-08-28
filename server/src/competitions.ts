/**
 * DOOMCRAFT — competitions: seasons and tournaments (docs/ECONOMY.md
 * "Competitions"), on the same seam as referrals — `onProfilePersisted`
 * after every paying round — with zero room.ts changes.
 *
 * The ladder's arithmetic is STATE-based, not event-based, and that is the
 * whole design: an entrant's points are the delta of `progress.xp` (a
 * monotonic counter only match payouts move) since their baseline was
 * snapshotted at enrolment. There is no per-match event to double-count,
 * to lose in a crash, or to replay — the profile and the baseline are both
 * durable, and the watermark and the points move in the same doc write.
 * Each sweep's increment is clamped to `MATCH_XP_CAP` and the excess is
 * FORGOTTEN, so a mid-season account merge (which legitimately jumps `xp`
 * by a pre-season amount) smuggles at most one match's worth of points
 * into a ladder — once, not amortised over later rounds.
 *
 * Seasons auto-enrol on the first paying round inside the window and roll
 * over by themselves — finalising one mints the next, so the system runs
 * with zero operator attention. Tournaments are operator-created (that is
 * where the prize table is decided, which is why creation confirm-gates in
 * the routes) and require an explicit `enter()`, with the entry rule
 * checked at the door.
 *
 * Prizes pay ONLY through the journal — `kind: 'prize'`, `sourceId:
 * prize:<competitionId>` — so finalisation is idempotent per player
 * forever, whatever crashes or replays. Item prizes ride the same tag
 * through the inventory's provenance, checked before granting. The flag
 * (`economy_competitions`) gates the SURFACES in the routes; accrual here
 * is gated on nothing, because turning the tab off mid-season must never
 * lose a season (shared/src/flags.ts says so).
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseItemRef } from '@doomcraft/shared/items';

import { newLedgerId, redactPlayerId, type Journal } from './journal.js';
import { MAX_SCRAP_BALANCE, grantDrops, type PersistenceStore, type StoredProfile } from './persistence.js';
import { MATCH_XP_CAP } from './reward.js';

export const COMPETITIONS_FILE = 'competitions.json';
export const COMPETITIONS_LOG_FILE = 'competitions.jsonl';

export const SEASON_LENGTH_MS = 28 * 24 * 3600_000;
/** Top ten, the way an arcade cabinet would say it. */
export const SEASON_SCRAP_BY_RANK: readonly number[] =
  Object.freeze([500, 300, 200, 150, 100, 100, 100, 50, 50, 50]);
export const MAX_PRIZE_RANKS = 100;
export const MAX_PRIZE_SCRAP = 100_000;
export const MAX_WINNER_ITEMS = 4;
export const MIN_TOURNAMENT_MS = 10 * 60_000;
export const MAX_TOURNAMENT_MS = 30 * 24 * 3600_000;
export const STANDINGS_LIMIT = 50;

export type CompetitionKind = 'season' | 'tournament';
export type CompetitionState = 'running' | 'finalised' | 'cancelled';

export interface CompetitionRow {
  id: string;
  kind: CompetitionKind;
  name: string;
  startMs: number;
  endMs: number;
  /** Scrap by rank, index 0 = first place. */
  scrapByRank: number[];
  /** Item refs granted to rank 1 only — a trophy, if the pack ships one. */
  winnerItems: string[];
  /** Entry rule, tournaments only; seasons take everyone who plays. */
  minLevel: number;
  state: CompetitionState;
  createdBy: string;
  /** Written once at finalisation, then never again. */
  placements: PlacementRow[] | null;
}

export interface PlacementRow {
  rank: number;
  key: string;
  name: string;
  points: number;
  wins: number;
  scrap: number;
}

interface EntryRow {
  joinedMs: number;
  updatedMs: number;
  /** The monotonic counters at enrolment — matches/wins are deltas from here. */
  baseline: { xp: number; matches: number; wins: number };
  /**
   * The XP watermark: points grow by `min(xp - lastXp, MATCH_XP_CAP)` per
   * sweep and the watermark then jumps to `xp` — so a merge's counter jump
   * admits ONE match ceiling and the excess is FORGOTTEN, never amortised
   * into later sweeps. Watermark and points move in the same doc write, so
   * a crash between profile save and doc persist re-counts the same delta
   * once and doubles nothing.
   */
  lastXp: number;
  points: number;
  matches: number;
  wins: number;
  /** Display name cached at sweep so standings never load N profiles. */
  name: string;
}

interface CompetitionsDoc {
  version: 1;
  seasonOrdinal: number;
  competitions: Record<string, CompetitionRow>;
  /** competitionId -> profileKey -> entry. */
  entries: Record<string, Record<string, EntryRow>>;
}

export interface CompetitionDeps {
  store: PersistenceStore;
  journal: Journal | null;
}

export interface StandingView {
  readonly rank: number;
  readonly who: string;
  readonly name: string;
  readonly points: number;
  readonly wins: number;
  readonly you: boolean;
}

export interface CompetitionView {
  readonly id: string;
  readonly kind: CompetitionKind;
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly state: CompetitionState;
  readonly minLevel: number;
  readonly scrapByRank: readonly number[];
  readonly entrants: number;
  readonly entered: boolean;
  readonly yourRank: number;
  readonly yourPoints: number;
}

export type EnterResult = { ok: true } | { ok: false; status: number; error: string };

function utcDayStamp(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

export class CompetitionService {
  private readonly root: string;
  private readonly clock: () => number;
  private doc: CompetitionsDoc = { version: 1, seasonOrdinal: 0, competitions: {}, entries: {} };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string, options: { clock?: () => number } = {}) {
    this.root = dataRoot.replace(/\/+$/, '');
    this.clock = options.clock ?? (() => Date.now());
    try {
      const raw = JSON.parse(readFileSync(join(this.root, COMPETITIONS_FILE), 'utf8')) as CompetitionsDoc;
      if (raw.version === 1) this.doc = { ...this.doc, ...raw };
    } catch { /* first boot */ }
  }

  private locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private persist(): void {
    try {
      mkdirSync(this.root, { recursive: true });
      const tmp = join(this.root, `${COMPETITIONS_FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.doc, null, 2), 'utf8');
      renameSync(tmp, join(this.root, COMPETITIONS_FILE));
    } catch { /* an unwritable doc must not break play */ }
  }

  private audit(row: Record<string, unknown>): void {
    try {
      mkdirSync(this.root, { recursive: true });
      appendFileSync(join(this.root, COMPETITIONS_LOG_FILE), JSON.stringify(row) + '\n', 'utf8');
    } catch { /* an unwritable log must not break a competition */ }
  }

  /* --- the season machine ---------------------------------------------- */

  /**
   * Make sure a season covers `now`, finalising anything that has ended.
   * Called at boot, from every sweep, and from every read — cheap when
   * there is nothing to do, which is almost always.
   */
  private async upkeep(deps: CompetitionDeps): Promise<void> {
    const now = this.clock();
    for (const c of Object.values(this.doc.competitions)) {
      if (c.state === 'running' && now >= c.endMs) await this.finalise(c, deps, now);
    }
    const covered = Object.values(this.doc.competitions)
      .some((c) => c.kind === 'season' && c.state === 'running' && c.startMs <= now && now < c.endMs);
    if (!covered) {
      this.doc.seasonOrdinal += 1;
      const id = `season-${this.doc.seasonOrdinal}`;
      this.doc.competitions[id] = {
        id, kind: 'season', name: `Season ${this.doc.seasonOrdinal}`,
        startMs: now, endMs: now + SEASON_LENGTH_MS,
        scrapByRank: SEASON_SCRAP_BY_RANK.slice(), winnerItems: [], minLevel: 1,
        state: 'running', createdBy: 'system:season', placements: null,
      };
      this.doc.entries[id] = {};
      this.persist();
      this.audit({ ms: now, competitionId: id, event: 'open', until: utcDayStamp(now + SEASON_LENGTH_MS) });
    }
  }

  /** Public wrapper for boot and for tests. */
  ensure(deps: CompetitionDeps): Promise<void> {
    return this.locked(() => this.upkeep(deps));
  }

  /* --- accrual ----------------------------------------------------------- */

  /**
   * After every paying round (the `onProfilePersisted` seam). Auto-enrols
   * the player into the running season; updates the cached deltas for every
   * running competition they are in. The per-sweep increment clamp is the
   * merge fence — see the header.
   */
  sweep(profileKey: string, deps: CompetitionDeps): Promise<void> {
    return this.locked(async () => {
      await this.upkeep(deps);
      const now = this.clock();
      const profile = await deps.store.load(profileKey);
      if (profile === null) return;
      for (const c of Object.values(this.doc.competitions)) {
        if (c.state !== 'running' || now < c.startMs || now >= c.endMs) continue;
        const entries = this.doc.entries[c.id] ?? (this.doc.entries[c.id] = {});
        let entry = entries[profileKey];
        if (entry === undefined) {
          if (c.kind !== 'season') continue;   // tournaments take an explicit enter()
          entry = entries[profileKey] = this.freshEntry(profile, now);
        }
        this.refresh(entry, profile, now);
      }
      this.persist();
    });
  }

  private freshEntry(p: StoredProfile, now: number): EntryRow {
    return {
      joinedMs: now, updatedMs: now,
      baseline: { xp: p.progress.xp, matches: p.stats.matches, wins: p.stats.wins },
      lastXp: p.progress.xp,
      points: 0, matches: 0, wins: 0,
      name: p.progress.name || 'Marine',
    };
  }

  private refresh(entry: EntryRow, p: StoredProfile, now: number): void {
    // The merge fence — see the EntryRow comment: one ceiling per sweep,
    // the excess forgotten.
    const delta = Math.max(0, p.progress.xp - entry.lastXp);
    entry.points += Math.min(delta, MATCH_XP_CAP);
    entry.lastXp = p.progress.xp;
    entry.matches = Math.max(0, p.stats.matches - entry.baseline.matches);
    entry.wins = Math.max(0, p.stats.wins - entry.baseline.wins);
    entry.name = p.progress.name || entry.name;
    entry.updatedMs = now;
  }

  /* --- entering ---------------------------------------------------------- */

  enter(profileKey: string, competitionId: string, deps: CompetitionDeps): Promise<EnterResult> {
    return this.locked(async () => {
      await this.upkeep(deps);
      const now = this.clock();
      const c = this.doc.competitions[competitionId];
      if (c === undefined || c.state !== 'running') return { ok: false as const, status: 404, error: 'no such competition' };
      if (now >= c.endMs) return { ok: false as const, status: 409, error: 'that competition has ended' };
      const entries = this.doc.entries[c.id] ?? (this.doc.entries[c.id] = {});
      if (entries[profileKey] !== undefined) return { ok: true as const };
      const profile = await deps.store.load(profileKey);
      if (profile === null) return { ok: false as const, status: 403, error: 'no profile yet — play a match first' };
      if (profile.moderation.banned) return { ok: false as const, status: 403, error: 'this account is moderated' };
      if (profile.progress.level < c.minLevel) {
        return { ok: false as const, status: 403, error: `reach level ${c.minLevel} to enter` };
      }
      entries[profileKey] = this.freshEntry(profile, now);
      this.persist();
      this.audit({ ms: now, competitionId, event: 'enter', who: redactPlayerId(profileKey) });
      return { ok: true as const };
    });
  }

  /* --- finalisation — the only code that pays ---------------------------- */

  private rankedEntries(id: string): Array<{ key: string; entry: EntryRow }> {
    return Object.entries(this.doc.entries[id] ?? {})
      .map(([key, entry]) => ({ key, entry }))
      .filter(({ entry }) => entry.points > 0)
      .sort((a, b) =>
        b.entry.points - a.entry.points
        || b.entry.wins - a.entry.wins
        || a.entry.joinedMs - b.entry.joinedMs);
  }

  private async finalise(c: CompetitionRow, deps: CompetitionDeps, now: number): Promise<void> {
    const ranked = this.rankedEntries(c.id);
    const placements: PlacementRow[] = ranked.slice(0, MAX_PRIZE_RANKS).map(({ key, entry }, i) => ({
      rank: i + 1, key, name: entry.name,
      points: entry.points, wins: entry.wins,
      scrap: c.scrapByRank[i] ?? 0,
    }));
    c.placements = placements;
    c.state = 'finalised';
    this.persist();
    this.audit({
      ms: now, competitionId: c.id, event: 'finalise',
      entrants: ranked.length, paidRanks: placements.filter((p) => p.scrap > 0).length,
    });

    const sourceId = `prize:${c.id}`;
    for (const p of placements) {
      const items = p.rank === 1 ? c.winnerItems : [];
      if (p.scrap <= 0 && items.length === 0) continue;
      // Same shape as every payment in this repo: idempotency check FIRST
      // and inside the same update, the append LAST but still inside.
      await deps.store.update(p.key, async (profile) => {
        if (deps.journal !== null && await deps.journal.has('prize', sourceId, p.key)) return;
        if (items.length > 0 && !profile.inventory.items.some((it) => it.sourceId === sourceId)) {
          grantDrops(profile, items, 'prize', sourceId, now);
        }
        if (p.scrap > 0) {
          profile.economy.scrap = Math.min(profile.economy.scrap + p.scrap, MAX_SCRAP_BALANCE);
          profile.economy.lifetimeScrap = Math.min(profile.economy.lifetimeScrap + p.scrap, MAX_SCRAP_BALANCE);
        }
        if (deps.journal !== null) {
          await deps.journal.append([{
            id: newLedgerId(now), ms: now, kind: 'prize', sourceId,
            playerId: p.key, currency: 'scrap',
            delta: p.scrap, balanceAfter: profile.economy.scrap,
            actor: 'system:competition',
            reason: `${c.name} — rank ${p.rank} of ${ranked.length}`,
          }]);
        }
      });
    }
  }

  /* --- the operator's verbs (routes confirm-gate the paying one) --------- */

  createTournament(input: {
    name: string; startMs: number; endMs: number; minLevel: number;
    scrapByRank: number[]; winnerItems: string[]; actor: string;
  }): { ok: true; id: string } | { ok: false; error: string } {
    const name = input.name.trim().slice(0, 48);
    if (name.length === 0) return { ok: false, error: 'a tournament needs a name' };
    const span = input.endMs - input.startMs;
    if (!Number.isFinite(span) || span < MIN_TOURNAMENT_MS || span > MAX_TOURNAMENT_MS) {
      return { ok: false, error: 'tournament length must be between 10 minutes and 30 days' };
    }
    if (input.scrapByRank.length > MAX_PRIZE_RANKS) return { ok: false, error: `at most ${MAX_PRIZE_RANKS} paid ranks` };
    for (const s of input.scrapByRank) {
      if (!Number.isInteger(s) || s < 0 || s > MAX_PRIZE_SCRAP) {
        return { ok: false, error: `each rank prize must be 0..${MAX_PRIZE_SCRAP} Scrap` };
      }
    }
    if (input.winnerItems.length > MAX_WINNER_ITEMS) return { ok: false, error: `at most ${MAX_WINNER_ITEMS} winner items` };
    for (const ref of input.winnerItems) {
      if (parseItemRef(ref) === null) return { ok: false, error: `"${ref}" is not an item ref` };
    }
    const minLevel = Number.isInteger(input.minLevel) ? Math.min(Math.max(input.minLevel, 1), 200) : 1;
    const now = this.clock();
    const id = `t-${newLedgerId(now)}`;
    this.doc.competitions[id] = {
      id, kind: 'tournament', name,
      startMs: Math.max(input.startMs, now), endMs: input.endMs,
      scrapByRank: input.scrapByRank.slice(), winnerItems: input.winnerItems.slice(),
      minLevel, state: 'running', createdBy: input.actor, placements: null,
    };
    this.doc.entries[id] = {};
    this.persist();
    this.audit({ ms: now, competitionId: id, event: 'create', actor: input.actor, name });
    return { ok: true, id };
  }

  /** Cancel pays NOBODY — that is what distinguishes it from letting it end. */
  cancelCompetition(competitionId: string, actor: string): boolean {
    const c = this.doc.competitions[competitionId];
    if (c === undefined || c.state !== 'running' || c.kind !== 'tournament') return false;
    c.state = 'cancelled';
    c.placements = [];
    this.persist();
    this.audit({ ms: this.clock(), competitionId, event: 'cancel', actor });
    return true;
  }

  /* --- reads ------------------------------------------------------------- */

  /** The Competitions tab: what is on, and where the caller stands. */
  overview(profileKey: string, deps: CompetitionDeps): Promise<CompetitionView[]> {
    return this.locked(async () => {
      await this.upkeep(deps);
      const now = this.clock();
      return Object.values(this.doc.competitions)
        .filter((c) => c.state === 'running'
          || (c.state === 'finalised' && now - c.endMs < 14 * 24 * 3600_000))
        .sort((a, b) => a.endMs - b.endMs)
        .map((c) => {
          const ranked = this.rankedEntries(c.id);
          const at = ranked.findIndex((r) => r.key === profileKey);
          const entry = (this.doc.entries[c.id] ?? {})[profileKey];
          return Object.freeze({
            id: c.id, kind: c.kind, name: c.name,
            startMs: c.startMs, endMs: c.endMs, state: c.state,
            minLevel: c.minLevel, scrapByRank: Object.freeze(c.scrapByRank.slice()),
            entrants: Object.keys(this.doc.entries[c.id] ?? {}).length,
            entered: entry !== undefined,
            yourRank: at < 0 ? 0 : at + 1,
            yourPoints: entry?.points ?? 0,
          });
        });
    });
  }

  /** Top N plus the caller's own row, keys redacted to journal handles. */
  standings(competitionId: string, profileKey: string, deps: CompetitionDeps): Promise<StandingView[] | null> {
    return this.locked(async () => {
      await this.upkeep(deps);
      const c = this.doc.competitions[competitionId];
      if (c === undefined) return null;
      const source: Array<{ rank: number; key: string; name: string; points: number; wins: number }> =
        c.placements !== null
          ? c.placements
          : this.rankedEntries(c.id).map(({ key, entry }, i) => ({
            rank: i + 1, key, name: entry.name, points: entry.points, wins: entry.wins,
          }));
      const rows = source.slice(0, STANDINGS_LIMIT);
      const you = source.find((r) => r.key === profileKey);
      if (you !== undefined && !rows.includes(you)) rows.push(you);
      return rows.map((r) => Object.freeze({
        rank: r.rank, who: redactPlayerId(r.key), name: r.name,
        points: r.points, wins: r.wins, you: r.key === profileKey,
      }));
    });
  }

  status(): Record<string, number> {
    const all = Object.values(this.doc.competitions);
    return {
      running: all.filter((c) => c.state === 'running').length,
      finalised: all.filter((c) => c.state === 'finalised').length,
      entrants: Object.values(this.doc.entries).reduce((n, e) => n + Object.keys(e).length, 0),
    };
  }
}
