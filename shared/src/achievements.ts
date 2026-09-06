/**
 * DOOMCRAFT — achievements as DATA, alongside the challenge engine.
 *
 * An achievement is LIFETIME and ONE-SHOT where a challenge is periodic and
 * repeating, and the difference runs deeper than the period field: a challenge
 * measures A MATCH, an achievement measures A CAREER. So an achievement reads
 * the lifetime stat block the profile already keeps and the player is already
 * shown, rather than accruing a counter of its own.
 *
 * THAT IS A DISPLAY DECISION AND ONLY A DISPLAY DECISION. A second counter
 * would accrue under different gates from the block behind the profile screen,
 * and the two would then disagree in front of the player — "1,000 kills" on one
 * panel and "940 / 1000" on the next. One number, one source. It is NOT an
 * anti-farm argument, and it was mistaken for one in the first draft of this
 * design; see ACHIEVEMENT_STATS for what actually does that job.
 *
 * The obligation is a different object from the evidence. A lifetime stat is
 * never wiped, so it is tempting to say the counter IS the durable debt — but
 * the counter preserves the STAT, and what a player is owed is the DEF, which
 * lives in a content pack that can be re-cut between earning and paying. So a
 * completion is snapshotted into `owed` at detection (server/src/persistence.ts)
 * and paid from the snapshot. That is not a second progress counter.
 *
 * The parser refuses instead of correcting, and here it refuses one thing the
 * challenge parser does not: an over-long name or blurb. The challenge parser
 * TRUNCATES, and this module deliberately does not copy it — silently rewriting
 * what the author typed is the behaviour `challenges.ts`' own header calls "an
 * editor that lies".
 */

import { sanitiseContentId } from './modes.ts';

/**
 * The lifetime stats an achievement may price.
 *
 * A SEPARATE list from `CHALLENGE_STATS`, not a re-export, even though the two
 * overlap: they answer different questions. `CHALLENGE_STATS` asks which
 * per-match tally fields exist; this asks which LIFETIME fields exist on the
 * profile's stat block. A future per-match stat with no lifetime counterpart
 * must not silently become an achievement stat.
 *
 * THE ADMISSION RULE: every unit of the lifetime total must have required an
 * action the simulation observed. What that excludes, and why:
 *
 *   `matches`, `secondsPlayed` — increment for a round in which the player did
 *     nothing at all. `CHALLENGE_STATS` excludes `seconds` for the same reason:
 *     "a stat the player cannot fail to accumulate is a login reward wearing a
 *     challenge's name."
 *   `wins` — MEASURED, not assumed: `applyMatchResult` with
 *     `{kills:0, deaths:0, won:true, damageDealt:0, blocks:0, seconds:12}`
 *     gives `roundPays = false` and zero Scrap, and still moves `stats.wins` to
 *     1. A hundred of them make a hundred lifetime wins for a hundred rounds of
 *     doing nothing, because `endRound` can crown a sole player at zero kills.
 *     Challenges never see it — `buildSubmission` zeroes `challengeIds` when
 *     `roundPays` is false — but the lifetime block does, so an achievement may
 *     not price wins until that is fixed.
 *   `deaths` — an achievement is a reward, and a reward for dying pays people
 *     to die. (`playedIdle` counts deaths as ACTIVITY, which is the opposite
 *     question and the right answer to it: being killed is not idling.)
 *
 * WHAT IS ACCEPTED, EXPLICITLY: the five below are not behind the
 * thirty-second/not-idle floor that `roundPays` puts in front of challenge
 * progress, because `applyMatchResult` writes the lifetime block
 * unconditionally. They can therefore be advanced in short rounds. That is
 * accepted rather than proved harmless: the per-unit cost is the same in a
 * short round as a long one, and the targets are large.
 */
export const ACHIEVEMENT_STATS = Object.freeze([
  'kills', 'bestStreak', 'damageDealt', 'blocksPlaced', 'blocksBroken',
] as const);
export type AchievementStat = (typeof ACHIEVEMENT_STATS)[number];

/**
 * The lifetime fields evaluation reads — a structural subset of the profile's
 * stat block, so this module never imports the persistence layer.
 */
export interface LifetimeStatSource {
  readonly kills: number;
  readonly bestStreak: number;
  readonly damageDealt: number;
  readonly blocksPlaced: number;
  readonly blocksBroken: number;
}

export interface AchievementDef {
  /** `achievement.<slug>`. The prefix is required, which is what keeps this id space disjoint from the challenge one. */
  readonly id: string;
  readonly name: string;
  /** One player-facing line. Required, for the reason a challenge needs one: no description is a mystery box. */
  readonly blurb: string;
  readonly stat: AchievementStat;
  /** The lifetime value that completes it. */
  readonly target: number;
  /** Scrap paid ONCE, ever. */
  readonly scrap: number;
  /**
   * Items-manifest LOCAL id granted on completion, or null. The full
   * `items@<v>:<id>` ref is formatted at grant time from the paying room's
   * pinned items version, exactly as challenge rewards and match drops are.
   */
  readonly item: string | null;
}

/**
 * NOT `MAX_CHALLENGES_PER_PACK`'s eight. That cap exists because "the whole
 * active set must fit one result submission" — it is pinned equal to the
 * guard's `MAX_CHALLENGE_IDS`. Achievements never appear on the wire (there is
 * no producer and no claim; the settlement derives them server-side from state
 * the guard already gated), so the submission constraint does not apply and the
 * two constants must NOT be pinned together.
 */
export const MAX_ACHIEVEMENTS_PER_PACK = 24;
/** Per-def ceiling, the challenge precedent. */
export const MAX_ACHIEVEMENT_SCRAP = 500;
/**
 * Manifest-wide ceiling. Higher than the challenge total (2000) because this
 * one is a ONE-TIME mint per player rather than a per-period one — and it
 * bounds ONE MANIFEST, not a player's lifetime across successive manifests that
 * introduce new ids. The lifetime bound is the receipt ceiling on the profile.
 */
export const MAX_ACHIEVEMENT_TOTAL_SCRAP = 5000;
export const MAX_ACHIEVEMENT_TARGET = 1_000_000;
export const MAX_ACHIEVEMENT_NAME = 48;
export const MAX_ACHIEVEMENT_BLURB = 120;

/** UTF-8 byte length without node:Buffer — this module runs in the browser too. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/* ------------------------------------------------------------------------ *
 * Evaluation — one progress function, one completion function, no third
 * opinion. Three callers: the settlement, the board route, and the tests.
 * ------------------------------------------------------------------------ */

/** How far along `def` this career is, clamped to the target. Never negative, never NaN. */
export function achievementProgress(def: AchievementDef, s: LifetimeStatSource): number {
  const raw = s[def.stat];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(Math.max(0, Math.floor(raw)), def.target);
}

/**
 * THE completion test. Nothing else may compare a target to anything —
 * `achievementProgress` clamps AT the target, so a caller writing its own
 * `>` instead of `>=` would silently never complete anything.
 */
export function achievementDone(def: AchievementDef, s: LifetimeStatSource): boolean {
  return achievementProgress(def, s) >= def.target;
}

/* ------------------------------------------------------------------------ *
 * Fingerprint inputs
 * ------------------------------------------------------------------------ */

/**
 * Canonical input lines, id-sorted (code-unit sort, the levelsPack rule).
 *
 * THE ENCODING IS NOT THE CHALLENGE ENCODING, and that is deliberate.
 * `challengesFingerprintInputs` joins every field with `/`, free text included,
 * so `{name:"A/B", blurb:"C"}` and `{name:"A", blurb:"B/C"}` both produce
 * `daily.x:daily/kills/1/1/-/A/B/C` — two different manifests, one fingerprint,
 * and a console diff that renders no change. That is a live defect in the
 * shipped encoder (HANDOVER §3) and fixing it moves every declared quests
 * digest, so it is its own release and is NOT done here. What is done here is
 * refusing to add a second instance of it: the two free-text fields are
 * JSON-quoted, so no `|` or quote inside a name can forge a field boundary.
 */
export function achievementsFingerprintInputs(
  defs: readonly AchievementDef[],
): string[] {
  return [...defs]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => `${a.id}|${a.stat}|${a.target}|${a.scrap}|${a.item ?? '-'}`
      + `|${JSON.stringify(a.name)}|${JSON.stringify(a.blurb)}`);
}

/* ------------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------------ */

export interface AchievementsParseResult {
  /** Frozen defs, or null when `errors` is non-empty. */
  defs: readonly AchievementDef[] | null;
  errors: string[];
}

/**
 * Parse the `achievements` member of a quests manifest root.
 *
 * ABSENT normalises to an empty list; PRESENT-BUT-NOT-AN-ARRAY is an error, and
 * so is a malformed entry inside a present array. Those three cases must not
 * collapse into one another: a typo'd key that silently means "no achievements"
 * is how a pack ships doing nothing and passes every gate.
 */
export function parseAchievementsSection(raw: unknown): AchievementsParseResult {
  if (raw === undefined) return { defs: Object.freeze([]), errors: [] };
  if (!Array.isArray(raw)) {
    return { defs: null, errors: ['achievements is present but is not an array'] };
  }
  if (raw.length > MAX_ACHIEVEMENTS_PER_PACK) {
    return {
      defs: null,
      errors: [`${raw.length} achievements is over the ${MAX_ACHIEVEMENTS_PER_PACK} cap `
        + '(MAX_ACHIEVEMENTS_PER_PACK)'],
    };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  const defs: AchievementDef[] = [];
  let totalScrap = 0;

  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const rawId = typeof e.id === 'string' ? e.id : '';
    const dot = rawId.indexOf('.');
    const prefix = dot > 0 ? rawId.slice(0, dot) : '';
    const slug = dot > 0 ? rawId.slice(dot + 1) : '';
    if (prefix !== 'achievement' || slug.length === 0 || slug !== sanitiseContentId(slug)) {
      errors.push(`achievement id "${rawId}" is not achievement.<canonical-slug>`);
      continue;
    }
    if (seen.has(rawId)) { errors.push(`duplicate achievement id "${rawId}"`); continue; }
    seen.add(rawId);

    const stat = typeof e.stat === 'string' ? e.stat : '';
    if (!(ACHIEVEMENT_STATS as readonly string[]).includes(stat)) {
      errors.push(`${rawId}: unknown lifetime stat "${String(e.stat)}" `
        + `(one of ${ACHIEVEMENT_STATS.join(', ')})`);
      continue;
    }
    const target = typeof e.target === 'number' ? e.target : NaN;
    if (!Number.isInteger(target) || target < 1 || target > MAX_ACHIEVEMENT_TARGET) {
      errors.push(`${rawId}: target must be an integer in 1..${MAX_ACHIEVEMENT_TARGET}`);
      continue;
    }
    const scrap = typeof e.scrap === 'number' ? e.scrap : NaN;
    if (!Number.isInteger(scrap) || scrap < 0 || scrap > MAX_ACHIEVEMENT_SCRAP) {
      errors.push(`${rawId}: scrap must be an integer in 0..${MAX_ACHIEVEMENT_SCRAP} `
        + '(MAX_ACHIEVEMENT_SCRAP — achievement payouts bypass the daily meter, so the parser is the cap)');
      continue;
    }
    const item = typeof e.item === 'string' && e.item.length > 0 ? e.item : null;
    if (item !== null && item !== sanitiseContentId(item)) {
      errors.push(`${rawId}: item "${item}" is not a canonical items-manifest id`);
      continue;
    }
    if (scrap === 0 && item === null) {
      errors.push(`${rawId}: pays nothing — an achievement with no reward is a chore`);
      continue;
    }
    const name = typeof e.name === 'string' ? e.name : '';
    if (name.length === 0) { errors.push(`${rawId}: no display name`); continue; }
    if (name.length > MAX_ACHIEVEMENT_NAME) {
      errors.push(`${rawId}: name is ${name.length} characters, over the ${MAX_ACHIEVEMENT_NAME} cap `
        + '(refused rather than truncated — an editor that silently rewrites what you typed is an editor that lies)');
      continue;
    }
    const blurb = typeof e.blurb === 'string' ? e.blurb : '';
    if (blurb.length === 0) {
      errors.push(`${rawId}: no blurb — an achievement with no description is a mystery box`);
      continue;
    }
    if (blurb.length > MAX_ACHIEVEMENT_BLURB) {
      errors.push(`${rawId}: blurb is ${blurb.length} characters, over the ${MAX_ACHIEVEMENT_BLURB} cap `
        + '(refused rather than truncated)');
      continue;
    }

    totalScrap += scrap;
    defs.push(Object.freeze({
      id: rawId, name, blurb, stat: stat as AchievementStat, target, scrap, item,
    }));
  }

  if (totalScrap > MAX_ACHIEVEMENT_TOTAL_SCRAP) {
    errors.push(`the manifest pays ${totalScrap} Scrap in achievements, over the `
      + `${MAX_ACHIEVEMENT_TOTAL_SCRAP} cap (MAX_ACHIEVEMENT_TOTAL_SCRAP)`);
  }

  /* Every def must fit ONE pack input line, the challenge argument verbatim:
   * the release gate caps input lines and a version directory is immutable, so
   * a manifest that parses but overflows the line mints a pack that can never
   * pass a gate and can never be edited in place. The cap is imported from the
   * challenge module rather than restated, because the limit belongs to the
   * pack registry and one number cannot be allowed to become two. */
  for (const line of achievementsFingerprintInputs(defs)) {
    const bytes = utf8Bytes(line);
    if (bytes > MAX_ACHIEVEMENT_INPUT_BYTES) {
      errors.push(`${line.slice(0, line.indexOf('|'))}: its name and blurb make a `
        + `${bytes}-byte pack input line, over the ${MAX_ACHIEVEMENT_INPUT_BYTES}-byte cap `
        + '(MAX_PACK_INPUT_BYTES — the release gate would refuse the version forever)');
    }
  }

  if (errors.length > 0) return { defs: null, errors };
  return { defs: Object.freeze(defs), errors };
}

/**
 * Mirrors `MAX_PACK_INPUT_BYTES` (shared/src/packs.ts) and
 * `MAX_CHALLENGE_INPUT_BYTES`. Declared here rather than imported to keep this
 * module free of the pack registry; the test beside this file asserts all of
 * them agree, so they cannot drift.
 */
export const MAX_ACHIEVEMENT_INPUT_BYTES = 160;
