/**
 * DOOMCRAFT — achievements: the parser refuses rather than corrects, the
 * predicate is one function, and adding this module to the quests pack did not
 * move a single existing fingerprint.
 *
 * Every test here names the DEFECTIVE implementation it discriminates. A test
 * whose named defect produces the same asserted value is decoration, and this
 * project has shipped several of those; the comments are how the next reader
 * checks the claim rather than trusting it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACHIEVEMENT_STATS,
  MAX_ACHIEVEMENTS_PER_PACK,
  MAX_ACHIEVEMENT_BLURB,
  MAX_ACHIEVEMENT_INPUT_BYTES,
  MAX_ACHIEVEMENT_NAME,
  MAX_ACHIEVEMENT_SCRAP,
  MAX_ACHIEVEMENT_TOTAL_SCRAP,
  achievementDone,
  achievementProgress,
  achievementsFingerprintInputs,
  parseAchievementsSection,
  type AchievementDef,
} from './achievements.ts';
import { MAX_CHALLENGE_INPUT_BYTES, challengesFingerprintInputs, parseChallengesManifest } from './challenges.ts';
import { questsPack } from './packs.ts';

const QUESTS_JSON = fileURLToPath(new URL('../../content/quests.json', import.meta.url));

/**
 * `content/quests.json` as it stood before achievements existed, reduced to the
 * fields the encoder reads. Frozen on purpose: see the first test.
 */
const FROZEN_PRE_ACHIEVEMENT_QUESTS = JSON.stringify({
  challenges: [
    { id: 'daily.kill-25', period: 'daily', stat: 'kills', target: 25, scrap: 40,
      name: 'Exterminator', blurb: 'Take down 25 enemies or players today.' },
    { id: 'daily.win-1', period: 'daily', stat: 'wins', target: 1, scrap: 30,
      name: 'Take the Day', blurb: 'Win a match today.' },
    { id: 'daily.blocks-40', period: 'daily', stat: 'blocksPlaced', target: 40, scrap: 25,
      name: 'Field Engineer', blurb: 'Place 40 blocks today.' },
    { id: 'daily.damage-2000', period: 'daily', stat: 'damageDealt', target: 2000, scrap: 30,
      name: 'Heavy Ordnance', blurb: 'Deal 2000 damage today.' },
    { id: 'weekly.kills-250', period: 'weekly', stat: 'kills', target: 250, scrap: 150,
      name: 'War of Attrition', blurb: 'Take down 250 enemies or players this week.' },
    { id: 'weekly.wins-10', period: 'weekly', stat: 'wins', target: 10, scrap: 150,
      name: 'Campaign Season', blurb: 'Win 10 matches this week.' },
    { id: 'weekly.streak-8', period: 'weekly', stat: 'bestStreak', target: 8, scrap: 100,
      item: 'title-knee-deep', name: 'Knee-Deep',
      blurb: 'Hit an 8-kill streak in a single match this week.' },
  ],
});

function def(over: Partial<AchievementDef> = {}): AchievementDef {
  return {
    id: 'achievement.kills-1000', name: 'Exterminator', blurb: 'Take down a thousand.',
    stat: 'kills', target: 1000, scrap: 250, item: null, ...over,
  };
}

/** A whole quests manifest around a given achievements member. */
function manifest(achievements: unknown): string {
  const root: Record<string, unknown> = {
    challenges: [{
      id: 'daily.kill-25', period: 'daily', stat: 'kills', target: 25, scrap: 40,
      name: 'Exterminator', blurb: 'Take down 25 today.',
    }],
  };
  if (achievements !== undefined) root.achievements = achievements;
  return JSON.stringify(root);
}

describe('adding achievements moved no existing fingerprint', () => {
  /* THE DEPLOYMENT HAZARD, pinned. The defective implementation is an
   * unconditional append — a separator, an empty marker, a trailing '|' — which
   * changes the input list of a manifest that declares no achievements. Every
   * release declaration carries a digest over these exact strings, and
   * `quests@1` is the bundled fallback every host resolves to, so a changed
   * list there stops every existing declaration verifying. The golden was
   * captured by running the encoder BEFORE this module existed. */
  it('encodes an achievement-free manifest exactly as it did before this module existed', () => {
    /* A FROZEN FIXTURE, not the live file. This test's job is to pin the
     * ENCODER, and reading `content/quests.json` would have coupled it to the
     * CONTENT — so the moment A4 added achievements there, the correct
     * implementation would fail its own regression test and the obvious repair
     * would be to edit the golden, which is how a ratchet quietly stops being
     * one. The bytes below are that file as it stood before any achievement
     * existed. */
    const parsed = parseChallengesManifest(FROZEN_PRE_ACHIEVEMENT_QUESTS);
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest!.achievements).toEqual([]);

    const inputs = challengesFingerprintInputs(parsed.manifest!);
    expect(inputs).toEqual([
      'daily.blocks-40:daily/blocksPlaced/40/25/-/Field Engineer/Place 40 blocks today.',
      'daily.damage-2000:daily/damageDealt/2000/30/-/Heavy Ordnance/Deal 2000 damage today.',
      'daily.kill-25:daily/kills/25/40/-/Exterminator/Take down 25 enemies or players today.',
      'daily.win-1:daily/wins/1/30/-/Take the Day/Win a match today.',
      'weekly.kills-250:weekly/kills/250/150/-/War of Attrition/Take down 250 enemies or players this week.',
      'weekly.streak-8:weekly/bestStreak/8/100/title-knee-deep/Knee-Deep/Hit an 8-kill streak in a single match this week.',
      'weekly.wins-10:weekly/wins/10/150/-/Campaign Season/Win 10 matches this week.',
    ]);
    expect(questsPack(inputs, 1).fingerprint).toBe(1271166066);
  });

  it('still parses the LIVE content/quests.json, whatever it now carries', () => {
    /* The fixture above cannot see a live file that stopped parsing, so this
     * is the half that watches the real one. It deliberately asserts nothing
     * about the fingerprint: that number is content, and content is allowed to
     * move — `releases.test.ts` owns what happens when it does. */
    const parsed = parseChallengesManifest(readFileSync(QUESTS_JSON, 'utf8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest!.challenges.length).toBeGreaterThan(0);
  });

  it('appends achievement lines only when there are any, after the challenge lines', () => {
    const withNone = parseChallengesManifest(manifest(undefined)).manifest!;
    const withEmpty = parseChallengesManifest(manifest([])).manifest!;
    const withOne = parseChallengesManifest(manifest([{
      id: 'achievement.first-blood', stat: 'kills', target: 1, scrap: 25,
      name: 'First Blood', blurb: 'Take down your first.',
    }])).manifest!;

    const base = challengesFingerprintInputs(withNone);
    // An EMPTY array must be indistinguishable from an absent one. The
    // defective implementation appends a marker for the empty case.
    expect(challengesFingerprintInputs(withEmpty)).toEqual(base);
    expect(questsPack(challengesFingerprintInputs(withEmpty)).fingerprint)
      .toBe(questsPack(base).fingerprint);

    const one = challengesFingerprintInputs(withOne);
    expect(one.slice(0, base.length)).toEqual(base);
    expect(one).toHaveLength(base.length + 1);
    expect(questsPack(one).fingerprint).not.toBe(questsPack(base).fingerprint);
  });
});

describe('the achievement input encoding is unambiguous', () => {
  /* The shipped challenge encoder joins free text with '/' and therefore
   * cannot tell {name:"A/B", blurb:"C"} from {name:"A", blurb:"B/C"} — a live
   * defect recorded in HANDOVER §3. This asserts the new encoder does not
   * repeat it. The DEFECTIVE implementation is a bare `|` join with the JSON
   * quoting dropped: that collides on exactly this pair. */
  it('distinguishes a delimiter inside a name from one inside a blurb', () => {
    const a = achievementsFingerprintInputs([def({ name: 'A|B', blurb: 'C' })]);
    const b = achievementsFingerprintInputs([def({ name: 'A', blurb: 'B|C' })]);
    expect(a[0]).not.toBe(b[0]);

    // And the pair the LEGACY encoder collides on, to show the difference is
    // in the encoder rather than in the inputs being unusual.
    const c = achievementsFingerprintInputs([def({ name: 'A/B', blurb: 'C' })]);
    const d = achievementsFingerprintInputs([def({ name: 'A', blurb: 'B/C' })]);
    expect(c[0]).not.toBe(d[0]);
  });

  it('sorts by id and carries every player-visible field', () => {
    const lines = achievementsFingerprintInputs([
      def({ id: 'achievement.zulu' }), def({ id: 'achievement.alpha', scrap: 10 }),
    ]);
    expect(lines[0].startsWith('achievement.alpha|')).toBe(true);
    expect(lines[1].startsWith('achievement.zulu|')).toBe(true);
    // Every field that differs must move the line, or a re-cut is invisible.
    const base = achievementsFingerprintInputs([def()])[0];
    for (const over of [
      { target: 999 }, { scrap: 249 }, { item: 'title-hangar-rat' },
      { name: 'Other' }, { blurb: 'Other.' }, { stat: 'bestStreak' as const },
    ]) {
      expect(achievementsFingerprintInputs([def(over)])[0]).not.toBe(base);
    }
  });
});

describe('the parser refuses rather than corrects', () => {
  /* Three cases that must NOT collapse into each other. The defective
   * implementation treats a present non-array as absent, which is how a typo
   * ships a pack that silently awards nothing and passes every gate. */
  it('separates absent, empty, and present-but-not-an-array', () => {
    expect(parseAchievementsSection(undefined)).toEqual({ defs: [], errors: [] });
    expect(parseAchievementsSection([])).toEqual({ defs: [], errors: [] });

    const bad = parseAchievementsSection({ id: 'achievement.x' });
    expect(bad.defs).toBeNull();
    expect(bad.errors).toEqual(['achievements is present but is not an array']);
  });

  it('refuses an over-long name or blurb instead of truncating it', () => {
    /* The challenge parser TRUNCATES (`e.name.slice(0, MAX)`), and copying that
     * is the defect: a truncated name is a name the author never wrote, saved
     * without a word. The defective implementation slices and returns a def;
     * the correct one returns null with a named error. */
    const long = parseAchievementsSection([
      { ...def(), name: 'x'.repeat(MAX_ACHIEVEMENT_NAME + 1) },
    ]);
    expect(long.defs).toBeNull();
    expect(long.errors[0]).toContain(`over the ${MAX_ACHIEVEMENT_NAME} cap`);

    const longBlurb = parseAchievementsSection([
      { ...def(), blurb: 'y'.repeat(MAX_ACHIEVEMENT_BLURB + 1) },
    ]);
    expect(longBlurb.defs).toBeNull();
    expect(longBlurb.errors[0]).toContain(`over the ${MAX_ACHIEVEMENT_BLURB} cap`);

    // The boundary itself is legal — a cap that refuses its own limit is a
    // different bug from one that truncates.
    const exact = parseAchievementsSection([
      { ...def(), name: 'x'.repeat(MAX_ACHIEVEMENT_NAME), blurb: 'y' },
    ]);
    expect(exact.errors).toEqual([]);
    expect(exact.defs![0].name).toHaveLength(MAX_ACHIEVEMENT_NAME);
  });

  it('requires the achievement. prefix, which is what keeps the id spaces disjoint', () => {
    /* Three separate obligations. A wrong-prefix id that appears NOWHERE else
     * proves the prefix rule itself, rather than a collision check standing in
     * for it — the first draft of this test used `daily.x`, which both a prefix
     * rule and a collision check refuse, so it discriminated neither. */
    const wrong = parseAchievementsSection([{ ...def(), id: 'lifetime.kills-1000' }]);
    expect(wrong.defs).toBeNull();
    expect(wrong.errors[0]).toContain('is not achievement.<canonical-slug>');

    const dup = parseAchievementsSection([def(), def()]);
    expect(dup.defs).toBeNull();
    expect(dup.errors[0]).toContain('duplicate achievement id');

    // And a challenge and an achievement may share a SLUG without colliding,
    // because the prefixes differ. This is what the prefix rule buys.
    const both = parseChallengesManifest(JSON.stringify({
      challenges: [{
        id: 'daily.kill-25', period: 'daily', stat: 'kills', target: 25, scrap: 40,
        name: 'A', blurb: 'B',
      }],
      achievements: [{ ...def(), id: 'achievement.kill-25' }],
    }));
    expect(both.errors).toEqual([]);
    expect(both.manifest!.challenges).toHaveLength(1);
    expect(both.manifest!.achievements).toHaveLength(1);
  });

  it('refuses an unknown stat, and `wins` is deliberately unknown', () => {
    /* Not a spelling test. `wins` is a real lifetime field on the profile and
     * an obvious achievement — and a hundred idle rounds move it a hundred
     * times while paying nothing, so pricing it would mint Scrap for doing
     * nothing (HANDOVER §3). The parser is where that decision is enforced. */
    for (const stat of ['wins', 'matches', 'secondsPlayed', 'deaths', 'seconds']) {
      const r = parseAchievementsSection([{ ...def(), stat }]);
      expect(r.defs, `stat "${stat}" must be refused`).toBeNull();
      expect(r.errors[0]).toContain(`unknown lifetime stat "${stat}"`);
    }
    for (const stat of ACHIEVEMENT_STATS) {
      expect(parseAchievementsSection([{ ...def(), stat }]).errors).toEqual([]);
    }
  });

  it('bounds target, scrap, the manifest total, the count and the line length', () => {
    expect(parseAchievementsSection([{ ...def(), target: 0 }]).defs).toBeNull();
    expect(parseAchievementsSection([{ ...def(), target: 1.5 }]).defs).toBeNull();
    expect(parseAchievementsSection([{ ...def(), scrap: -1 }]).defs).toBeNull();
    expect(parseAchievementsSection([
      { ...def(), scrap: MAX_ACHIEVEMENT_SCRAP + 1 },
    ]).defs).toBeNull();

    // Pays nothing at all — a chore, not an award.
    expect(parseAchievementsSection([{ ...def(), scrap: 0, item: null }]).defs).toBeNull();

    const many = Array.from({ length: MAX_ACHIEVEMENTS_PER_PACK + 1 }, (_, i) =>
      def({ id: `achievement.a${i}` }));
    expect(parseAchievementsSection(many).errors[0])
      .toContain(`over the ${MAX_ACHIEVEMENTS_PER_PACK} cap`);

    // The manifest-wide total, reached with legal per-def amounts.
    const rich = Array.from({ length: 11 }, (_, i) =>
      def({ id: `achievement.b${i}`, scrap: MAX_ACHIEVEMENT_SCRAP }));
    const total = parseAchievementsSection(rich);
    expect(total.defs).toBeNull();
    expect(total.errors.at(-1)).toContain(`over the ${MAX_ACHIEVEMENT_TOTAL_SCRAP} cap`);

    // A def that parses but overflows the pack input line would mint a version
    // that can never pass a gate and can never be edited in place.
    const fat = parseAchievementsSection([{
      ...def(), name: 'x'.repeat(MAX_ACHIEVEMENT_NAME), blurb: 'y'.repeat(MAX_ACHIEVEMENT_BLURB),
    }]);
    expect(fat.defs).toBeNull();
    expect(fat.errors[0]).toContain(`over the ${MAX_ACHIEVEMENT_INPUT_BYTES}-byte cap`);
  });

  it('counts an over-long line in UTF-8 BYTES, not characters', () => {
    /* The defective implementation uses `.length`. A name of multi-byte
     * characters is well under the character cap and over the byte cap, and it
     * is the byte cap the release gate enforces. */
    /* The line must be UNDER the character cap and OVER the byte cap, or both
     * implementations refuse it and the test proves nothing — which is what
     * the first version of it did. 24 skulls are 48 UTF-16 units (exactly the
     * name cap) but 96 UTF-8 bytes, so a 30-character blurb puts the line at
     * 123 by `.length` and 171 in bytes. `.length` accepts; bytes refuse. */
    const emoji = '💀'.repeat(24);
    expect(emoji.length).toBe(MAX_ACHIEVEMENT_NAME);
    const r = parseAchievementsSection([{
      ...def(), name: emoji, blurb: 'z'.repeat(30),
    }]);
    expect(achievementsFingerprintInputs([def({ name: emoji, blurb: 'z'.repeat(30) })])[0].length)
      .toBeLessThanOrEqual(MAX_ACHIEVEMENT_INPUT_BYTES);
    expect(r.defs).toBeNull();
    expect(r.errors[0]).toContain('byte pack input line');
  });

  it('pins the input-byte cap to the challenge one so the pack registry has one number', () => {
    expect(MAX_ACHIEVEMENT_INPUT_BYTES).toBe(MAX_CHALLENGE_INPUT_BYTES);
  });
});

describe('one progress function, one completion function', () => {
  const career = {
    kills: 940, bestStreak: 12, damageDealt: 100_000,
    blocksPlaced: 4999, blocksBroken: 0,
  };

  it('reads the lifetime block, clamps at the target, and never returns NaN', () => {
    expect(achievementProgress(def({ target: 1000 }), career)).toBe(940);
    expect(achievementProgress(def({ target: 500 }), career)).toBe(500);
    expect(achievementDone(def({ target: 1000 }), career)).toBe(false);
    expect(achievementDone(def({ target: 940 }), career)).toBe(true);

    // EXACT target completes. The defective implementation writes `>` — and
    // because progress is clamped AT the target, `>` can never be true, so it
    // would silently complete nothing, ever.
    expect(achievementDone(def({ target: 940 }), career)).toBe(true);

    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(achievementProgress(def(), { ...career, kills: bad })).toBe(0);
    }
    expect(achievementProgress(def(), { ...career, kills: -5 })).toBe(0);
    expect(achievementProgress(def({ target: 10 }), { ...career, kills: 3.9 })).toBe(3);
  });

  it('reads the stat the def names and no other', () => {
    /* The defective implementation hard-codes `kills`. Each stat is given a
     * value no other stat has, so a wrong field cannot coincidentally match. */
    const distinct = { kills: 11, bestStreak: 22, damageDealt: 33, blocksPlaced: 44, blocksBroken: 55 };
    const expected: Record<string, number> = {
      kills: 11, bestStreak: 22, damageDealt: 33, blocksPlaced: 44, blocksBroken: 55,
    };
    for (const stat of ACHIEVEMENT_STATS) {
      expect(achievementProgress(def({ stat, target: 1000 }), distinct)).toBe(expected[stat]);
    }
  });
});
