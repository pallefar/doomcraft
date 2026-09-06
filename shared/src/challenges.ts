/**
 * DOOMCRAFT — daily / weekly challenges as DATA (docs/STUDIO.md S4,
 * docs/ECONOMY.md "Daily / weekly challenges feeding Scrap and drops").
 *
 * A challenge is a pure predicate over the stats a match already reports —
 * never over the mode. That is not a style choice: challenge evaluation runs
 * inside the entitlement guard, and shared/src/trust.test.ts fails the build
 * on any ModeId literal near a reward word. Criteria arrive as data (this
 * module's manifest, shipped as the `quests` pack), the trust table decides
 * which sessions may bank them, and the guard checks the claim against the
 * same predicate the room used. One predicate, three callers, zero modes.
 *
 * The parser refuses instead of correcting (shared/src/items.ts discipline):
 * an editor that lets you save what the machine will refuse is an editor
 * that lies.
 */

import { sanitiseContentId } from './modes.ts';
import {
  achievementsFingerprintInputs,
  parseAchievementsSection,
  type AchievementDef,
} from './achievements.ts';

export type ChallengePeriod = 'daily' | 'weekly';

/**
 * The stats a challenge may read — each one a field the server's round tally
 * already carries for every mode. `seconds` is deliberately absent: time
 * passes for an idle player too, and a stat the player cannot fail to
 * accumulate is a login reward wearing a challenge's name.
 */
export const CHALLENGE_STATS = Object.freeze([
  'kills', 'wins', 'bestStreak', 'damageDealt', 'blocksPlaced', 'blocksBroken',
] as const);
export type ChallengeStat = (typeof CHALLENGE_STATS)[number];

/**
 * How per-match contributions fold into the period counter. `bestStreak` is
 * a high-water mark — two matches with streak 4 do not make a streak 8 — so
 * it folds as MAX; every other stat is additive across the period.
 */
export function challengeAggregation(stat: ChallengeStat): 'sum' | 'max' {
  return stat === 'bestStreak' ? 'max' : 'sum';
}

export interface ChallengeDef {
  /** `<period>.<slug>`, e.g. `daily.kill-25`. The prefix must match `period`. */
  readonly id: string;
  readonly name: string;
  /** One player-facing line. Required: a challenge with no description is a mystery box. */
  readonly blurb: string;
  readonly period: ChallengePeriod;
  readonly stat: ChallengeStat;
  /** The period counter value that completes the challenge. */
  readonly target: number;
  /** Scrap paid on completion, once per period. */
  readonly scrap: number;
  /**
   * Items-manifest LOCAL id granted on completion, or null. The full
   * `items@<v>:<id>` ref is formatted at grant time with the paying room's
   * pinned items version, exactly as match drops are; the release gate
   * cross-checks the id against the paired items manifest.
   */
  readonly item: string | null;
}

export interface ChallengesManifest {
  readonly challenges: readonly ChallengeDef[];
  /**
   * Lifetime one-shot awards, shipped in the same pack (shared/src/achievements.ts).
   * ALWAYS PRESENT, possibly empty — an absent array normalises to `[]` so no
   * caller has to decide what `undefined` means, while a present non-array is
   * refused. A quests manifest that declares none is unchanged in every
   * observable way, including its fingerprint.
   */
  readonly achievements: readonly AchievementDef[];
}

/**
 * The whole active set must fit one result submission: the entitlement
 * guard clamps `challengeIds` at its own MAX_CHALLENGE_IDS (a server-internal
 * cap, not a wire limit). The test beside this file asserts the two
 * constants are equal so they cannot drift apart — raise them together.
 */
export const MAX_CHALLENGES_PER_PACK = 8;
/** Per-def Scrap ceiling, sized against the 800/day match-play cap. */
export const MAX_CHALLENGE_SCRAP = 500;
/** Manifest-wide Scrap ceiling — the operator-error bound on the only mint outside meterReward. */
export const MAX_CHALLENGE_TOTAL_SCRAP = 2000;
export const MAX_CHALLENGE_TARGET = 1_000_000;
export const MAX_CHALLENGE_NAME = 48;
export const MAX_CHALLENGE_BLURB = 120;
/**
 * Mirrors `MAX_PACK_INPUT_BYTES` (shared/src/packs.ts). Declared here rather
 * than imported to keep this module free of the pack registry; the
 * challenges test asserts the two agree, so they cannot drift.
 */
export const MAX_CHALLENGE_INPUT_BYTES = 160;

/** UTF-8 byte length without node:Buffer — this module runs in the browser too. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export interface ChallengesParseResult {
  manifest: ChallengesManifest | null;
  /** Why, one line each. Non-empty means `manifest` is null. */
  errors: string[];
}

export function parseChallengesManifest(text: string): ChallengesParseResult {
  const errors: string[] = [];
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    // `JSON.parse('null')` SUCCEEDS and returns null, and the property access
    // below sits outside this try — so a manifest whose entire body is the
    // literal `null` threw a TypeError straight past every caller instead of
    // being refused like any other malformed input. A pack is untrusted bytes
    // on disk; refusing it is the whole job.
    if (parsed === null || typeof parsed !== 'object') {
      return { manifest: null, errors: ['not a JSON object'] };
    }
    root = parsed as Record<string, unknown>;
  } catch {
    return { manifest: null, errors: ['not valid JSON'] };
  }
  const list = Array.isArray(root.challenges) ? root.challenges : null;
  if (list === null) return { manifest: null, errors: ['no challenges array'] };
  /* Parsed BEFORE the challenge loop returns, so an achievement error and a
   * challenge error come back together rather than one release at a time. */
  const ach = parseAchievementsSection(root.achievements);
  if (list.length > MAX_CHALLENGES_PER_PACK) {
    return {
      manifest: null,
      errors: [`${list.length} challenges is over the ${MAX_CHALLENGES_PER_PACK} cap `
        + '(MAX_CHALLENGES_PER_PACK — the whole active set must fit one result submission)'],
    };
  }
  const seen = new Set<string>();
  const defs: ChallengeDef[] = [];
  let totalScrap = 0;
  for (const entry of list) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const rawId = typeof e.id === 'string' ? e.id : '';
    const dot = rawId.indexOf('.');
    const prefix = dot > 0 ? rawId.slice(0, dot) : '';
    const slug = dot > 0 ? rawId.slice(dot + 1) : '';
    if ((prefix !== 'daily' && prefix !== 'weekly')
      || slug.length === 0 || slug !== sanitiseContentId(slug)) {
      errors.push(`challenge id "${rawId}" is not <daily|weekly>.<canonical-slug>`);
      continue;
    }
    if (seen.has(rawId)) { errors.push(`duplicate challenge id "${rawId}"`); continue; }
    seen.add(rawId);
    const period = typeof e.period === 'string' ? e.period : '';
    if (period !== 'daily' && period !== 'weekly') {
      errors.push(`${rawId}: unknown period "${String(e.period)}"`);
      continue;
    }
    if (period !== prefix) {
      errors.push(`${rawId}: id says "${prefix}" but period says "${period}" — one of them lies`);
      continue;
    }
    const stat = typeof e.stat === 'string' ? e.stat : '';
    if (!(CHALLENGE_STATS as readonly string[]).includes(stat)) {
      errors.push(`${rawId}: unknown stat "${String(e.stat)}"`);
      continue;
    }
    const target = typeof e.target === 'number' ? e.target : NaN;
    if (!Number.isInteger(target) || target < 1 || target > MAX_CHALLENGE_TARGET) {
      errors.push(`${rawId}: target must be an integer in 1..${MAX_CHALLENGE_TARGET}`);
      continue;
    }
    const scrap = typeof e.scrap === 'number' ? e.scrap : NaN;
    if (!Number.isInteger(scrap) || scrap < 0 || scrap > MAX_CHALLENGE_SCRAP) {
      errors.push(`${rawId}: scrap must be an integer in 0..${MAX_CHALLENGE_SCRAP} `
        + '(MAX_CHALLENGE_SCRAP — challenge payouts bypass the daily meter, so the parser is the cap)');
      continue;
    }
    const item = typeof e.item === 'string' && e.item.length > 0 ? e.item : null;
    if (item !== null && item !== sanitiseContentId(item)) {
      errors.push(`${rawId}: item "${item}" is not a canonical items-manifest id`);
      continue;
    }
    if (scrap === 0 && item === null) {
      errors.push(`${rawId}: pays nothing — a challenge with no reward is a chore`);
      continue;
    }
    const name = typeof e.name === 'string' ? e.name.slice(0, MAX_CHALLENGE_NAME) : '';
    if (name.length === 0) { errors.push(`${rawId}: no display name`); continue; }
    const blurb = typeof e.blurb === 'string' ? e.blurb.slice(0, MAX_CHALLENGE_BLURB) : '';
    if (blurb.length === 0) {
      errors.push(`${rawId}: no blurb — a challenge with no description is a mystery box`);
      continue;
    }
    totalScrap += scrap;
    defs.push(Object.freeze({
      id: rawId, name, blurb,
      period: period as ChallengePeriod, stat: stat as ChallengeStat,
      target, scrap, item,
    }));
  }
  if (totalScrap > MAX_CHALLENGE_TOTAL_SCRAP) {
    errors.push(`the manifest pays ${totalScrap} Scrap in total, over the `
      + `${MAX_CHALLENGE_TOTAL_SCRAP} cap (MAX_CHALLENGE_TOTAL_SCRAP)`);
  }
  /* Every def must fit ONE pack input line. The release gate caps input
   * lines at MAX_PACK_INPUT_BYTES and a version directory is immutable, so
   * a manifest that parses but overflows the line mints a pack that can
   * never pass a gate and can never be edited in place — an editor that
   * accepts what the machine will refuse forever. The parser owns the cap
   * because the studio route and the bundled manifest share it. */
  for (const line of challengesFingerprintInputs({ challenges: defs, achievements: [] })) {
    const bytes = utf8Bytes(line);
    if (bytes > MAX_CHALLENGE_INPUT_BYTES) {
      errors.push(`${line.slice(0, line.indexOf(':'))}: its name and blurb make a `
        + `${bytes}-byte pack input line, over the ${MAX_CHALLENGE_INPUT_BYTES}-byte cap `
        + '(MAX_PACK_INPUT_BYTES — the release gate would refuse the version forever)');
    }
  }
  errors.push(...ach.errors);
  if (errors.length > 0) return { manifest: null, errors };
  return {
    manifest: Object.freeze({
      challenges: Object.freeze(defs),
      achievements: ach.defs ?? Object.freeze([]),
    }),
    errors,
  };
}

/**
 * Canonical input lines for the pack fingerprint — one per challenge, every
 * player-visible field, in id order (code-unit sort, the levelsPack rule).
 */
export function challengesFingerprintInputs(manifest: ChallengesManifest): string[] {
  const lines = [...manifest.challenges]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => `${c.id}:${c.period}/${c.stat}/${c.target}/${c.scrap}`
      + `/${c.item ?? '-'}/${c.name}/${c.blurb}`);
  /* APPEND ONLY WHEN THERE IS SOMETHING TO APPEND. A quests pack that declares
   * no achievements must fingerprint to exactly what it did before this module
   * existed, or every release declaration naming an existing quests version
   * stops verifying against the host that installed it — the `weapons@2` shape
   * of hazard, and this time it would hit `quests@1`, which is the bundled
   * fallback every host resolves to. An unconditional separator or an empty
   * marker is the defect; the test beside this file pins the seven lines and
   * the fingerprint of today's content/quests.json against it. */
  const achievements = manifest.achievements ?? [];
  if (achievements.length === 0) return lines;
  return [...lines, ...achievementsFingerprintInputs(achievements)];
}

/* ------------------------------------------------------------------------ *
 * Evaluation — the ONE predicate, shared by the room producer, the guard
 * and the settlement. Mode-blind by construction: it reads nothing but the
 * stat fields below.
 * ------------------------------------------------------------------------ */

/** The stat fields evaluation reads — a structural subset of the round tally. */
export interface ChallengeStatSource {
  readonly kills: number;
  readonly won: boolean;
  readonly bestStreak: number;
  readonly damageDealt: number;
  readonly blocksPlaced: number;
  readonly blocksBroken: number;
}

/** This match's contribution toward `def` — 0 means the match moved nothing. */
export function challengeContribution(def: ChallengeDef, stats: ChallengeStatSource): number {
  const raw = def.stat === 'wins' ? (stats.won ? 1 : 0) : stats[def.stat];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

/** The ids this match contributes to — what the room attaches to the submission. */
export function contributingChallengeIds(
  defs: readonly ChallengeDef[], stats: ChallengeStatSource,
): string[] {
  return defs.filter((d) => challengeContribution(d, stats) > 0).map((d) => d.id);
}

/* ------------------------------------------------------------------------ *
 * Period keys — UTC only, one boundary, the same one for everybody
 * (the persistence.ts `utcDay` argument).
 * ------------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD`, UTC. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * ISO-8601 week, `YYYY-Www`, UTC, Monday-start. A date belongs to the week
 * of its Thursday, so Dec 29 2025 (a Monday) is 2026-W01 — the standard
 * everyone's calendar app already agrees on.
 */
export function utcWeekKey(ms: number): string {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monBased = (new Date(midnight).getUTCDay() + 6) % 7;
  const thursday = midnight + (3 - monBased) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The journal/receipt key for `period` at `ms` — derive it ONCE per settlement. */
export function challengePeriodKey(period: ChallengePeriod, ms: number): string {
  return period === 'daily' ? utcDayKey(ms) : utcWeekKey(ms);
}
