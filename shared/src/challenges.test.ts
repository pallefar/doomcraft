/**
 * DOOMCRAFT — challenges: the parser refuses, evaluation is mode-blind, and
 * the period keys agree with the calendar. Refusal proofs come BEFORE the
 * green pass over the shipped manifest (the gate.test.ts discipline): every
 * cap here is a money bound, and a cap that was never seen refusing is a
 * green test that cannot fail.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_STATS,
  MAX_CHALLENGES_PER_PACK,
  MAX_CHALLENGE_INPUT_BYTES,
  MAX_CHALLENGE_SCRAP,
  MAX_CHALLENGE_TOTAL_SCRAP,
  challengeAggregation,
  challengeContribution,
  challengePeriodKey,
  challengesFingerprintInputs,
  contributingChallengeIds,
  parseChallengesManifest,
  utcDayKey,
  utcWeekKey,
  type ChallengeStatSource,
} from './challenges.ts';
import { MAX_PACK_INPUT_BYTES, PackKind, questsPack } from './packs.ts';

const QUESTS_JSON = fileURLToPath(new URL('../../content/quests.json', import.meta.url));

const def = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'daily.kill-5', period: 'daily', stat: 'kills', target: 5, scrap: 10,
  name: 'Five', blurb: 'Take down five.', ...over,
});
const manifest = (...defs: Record<string, unknown>[]): string =>
  JSON.stringify({ challenges: defs });

describe('a manifest that is not an object', () => {
  // Found by an adversarial review of the V2 plan, which proposed copying this
  // parser: `JSON.parse('null')` succeeds, and the `root.challenges` access sat
  // outside the try, so the literal `null` threw a TypeError past every caller
  // instead of being refused. Reverting the guard makes this throw, not fail.
  it('is refused, not thrown past the caller', () => {
    for (const body of ['null', '5', '"a string"', 'true']) {
      const r = parseChallengesManifest(body);
      expect(r.manifest, body).toBeNull();
      expect(r.errors, body).toEqual(['not a JSON object']);
    }
  });

  it('still calls an array with no items array exactly that', () => {
    expect(parseChallengesManifest('{}').errors).toEqual(['no challenges array']);
    expect(parseChallengesManifest('[]').errors).toEqual(['no challenges array']);
  });

  it('still refuses bytes that are not JSON at all', () => {
    expect(parseChallengesManifest('{oh no').errors).toEqual(['not valid JSON']);
  });
});

describe('the parser refuses instead of correcting', () => {
  it('refuses non-JSON and a missing challenges array', () => {
    expect(parseChallengesManifest('nope').errors).toEqual(['not valid JSON']);
    expect(parseChallengesManifest('{}').errors).toEqual(['no challenges array']);
  });

  it('refuses a set larger than one submission can carry', () => {
    const defs = Array.from({ length: MAX_CHALLENGES_PER_PACK + 1 }, (_, i) =>
      def({ id: `daily.c-${i}` }));
    const r = parseChallengesManifest(manifest(...defs));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('MAX_CHALLENGES_PER_PACK');
  });

  it('refuses malformed ids, duplicate ids, and a period the id contradicts', () => {
    for (const bad of [
      def({ id: 'kill-5' }),                       // no period prefix
      def({ id: 'hourly.kill-5' }),                // unknown prefix
      def({ id: 'daily.Kill-5' }),                 // non-canonical slug
      def({ id: 'daily.' }),                       // empty slug
      def({ id: 'weekly.kill-5' }),                // prefix contradicts period: 'daily'
    ]) {
      const r = parseChallengesManifest(manifest(bad));
      expect(r.manifest, JSON.stringify(bad)).toBeNull();
    }
    const dup = parseChallengesManifest(manifest(def(), def()));
    expect(dup.manifest).toBeNull();
    expect(dup.errors[0]).toContain('duplicate');
  });

  it('refuses an unknown stat and an off-range target', () => {
    expect(parseChallengesManifest(manifest(def({ stat: 'seconds' }))).manifest).toBeNull();
    expect(parseChallengesManifest(manifest(def({ target: 0 }))).manifest).toBeNull();
    expect(parseChallengesManifest(manifest(def({ target: 2.5 }))).manifest).toBeNull();
  });

  it('refuses scrap over the per-def cap — the parser IS the mint bound', () => {
    const r = parseChallengesManifest(manifest(def({ scrap: MAX_CHALLENGE_SCRAP + 1 })));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('MAX_CHALLENGE_SCRAP');
  });

  it('refuses a manifest whose total pay is over the pack-wide cap', () => {
    const defs = [
      def({ id: 'daily.a', scrap: 500 }), def({ id: 'daily.b', scrap: 500 }),
      def({ id: 'daily.c', scrap: 500 }), def({ id: 'daily.d', scrap: 500 }),
      def({ id: 'daily.e', scrap: 500 }),
    ];
    const r = parseChallengesManifest(manifest(...defs));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('MAX_CHALLENGE_TOTAL_SCRAP');
    expect(2500).toBeGreaterThan(MAX_CHALLENGE_TOTAL_SCRAP);
  });

  it('refuses a def whose name+blurb overflow ONE pack input line — the gate would refuse the version forever', () => {
    // Parser-legal on every other axis: 40-char name, 118-char blurb.
    const r = parseChallengesManifest(manifest(def({
      name: 'N'.repeat(40), blurb: 'B'.repeat(118),
    })));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('MAX_PACK_INPUT_BYTES');
    // And the cap agrees with the pack registry's, so they cannot drift.
    expect(MAX_CHALLENGE_INPUT_BYTES).toBe(MAX_PACK_INPUT_BYTES);
  });

  it('counts UTF-8 BYTES, not UTF-16 units — an emoji blurb cannot smuggle a long line', () => {
    const r = parseChallengesManifest(manifest(def({ blurb: '🔥'.repeat(40) })));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('byte pack input line');
  });

  it('refuses a challenge that pays nothing, has no name, or has no blurb', () => {
    expect(parseChallengesManifest(manifest(def({ scrap: 0 }))).manifest).toBeNull();
    expect(parseChallengesManifest(manifest(def({ name: '' }))).manifest).toBeNull();
    expect(parseChallengesManifest(manifest(def({ blurb: '' }))).manifest).toBeNull();
  });

  it('refuses a non-canonical item id but accepts a canonical one', () => {
    expect(parseChallengesManifest(manifest(def({ item: 'Title-X' }))).manifest).toBeNull();
    const ok = parseChallengesManifest(manifest(def({ item: 'title-knee-deep' })));
    expect(ok.errors).toEqual([]);
    expect(ok.manifest?.challenges[0]?.item).toBe('title-knee-deep');
  });

  it('parses a good manifest, and scrap-0 is fine when an item pays instead', () => {
    const r = parseChallengesManifest(manifest(def({ scrap: 0, item: 'title-knee-deep' })));
    expect(r.errors).toEqual([]);
    expect(r.manifest?.challenges.length).toBe(1);
  });
});

describe('the shipped manifest', () => {
  it('content/quests.json parses clean and fits one submission', () => {
    const r = parseChallengesManifest(readFileSync(QUESTS_JSON, 'utf8'));
    expect(r.errors).toEqual([]);
    const defs = r.manifest?.challenges ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.length).toBeLessThanOrEqual(MAX_CHALLENGES_PER_PACK);
    // Every stat used is a legal stat, every item id is a slug the gate will
    // cross-check against the items manifest.
    for (const d of defs) expect(CHALLENGE_STATS).toContain(d.stat);
  });
});

describe('evaluation is a pure stat predicate', () => {
  const stats = (over: Partial<ChallengeStatSource> = {}): ChallengeStatSource => ({
    kills: 0, won: false, bestStreak: 0, damageDealt: 0,
    blocksPlaced: 0, blocksBroken: 0, ...over,
  });
  const parsed = (over: Record<string, unknown> = {}) =>
    parseChallengesManifest(manifest(def(over))).manifest!.challenges[0]!;

  it('wins reads the won flag; a loss contributes nothing', () => {
    const d = parsed({ id: 'daily.win-1', stat: 'wins', target: 1 });
    expect(challengeContribution(d, stats({ won: true }))).toBe(1);
    expect(challengeContribution(d, stats({ won: false }))).toBe(0);
  });

  it('sum stats report the match value; bestStreak folds as MAX, not SUM', () => {
    const kills = parsed();
    expect(challengeContribution(kills, stats({ kills: 7 }))).toBe(7);
    expect(challengeAggregation('kills')).toBe('sum');
    expect(challengeAggregation('bestStreak')).toBe('max');
  });

  it('garbage stat values contribute zero, never NaN or negatives', () => {
    const d = parsed();
    expect(challengeContribution(d, stats({ kills: Number.NaN }))).toBe(0);
    expect(challengeContribution(d, stats({ kills: -3 }))).toBe(0);
    expect(challengeContribution(d, stats({ kills: 2.9 }))).toBe(2);
  });

  it('contributingChallengeIds is exactly the >0 subset', () => {
    const r = parseChallengesManifest(manifest(
      def({ id: 'daily.kill-5' }),
      def({ id: 'daily.win-1', stat: 'wins', target: 1 }),
    ));
    expect(contributingChallengeIds(r.manifest!.challenges, stats({ kills: 3 })))
      .toEqual(['daily.kill-5']);
  });
});

describe('period keys agree with the calendar', () => {
  it('utcDayKey is the UTC date', () => {
    expect(utcDayKey(Date.UTC(2026, 7, 28, 23, 59))).toBe('2026-08-28');
    expect(utcDayKey(Date.UTC(2026, 7, 28, 0, 0))).toBe('2026-08-28');
  });

  it('utcWeekKey is the ISO week, Monday start, year of the Thursday', () => {
    // 2026-01-01 is a Thursday — week 1 of 2026.
    expect(utcWeekKey(Date.UTC(2026, 0, 1))).toBe('2026-W01');
    // Dec 29 2025 is the Monday of that same week.
    expect(utcWeekKey(Date.UTC(2025, 11, 29))).toBe('2026-W01');
    // Sunday Jan 4 2026 still week 1; Monday Jan 5 opens week 2.
    expect(utcWeekKey(Date.UTC(2026, 0, 4))).toBe('2026-W01');
    expect(utcWeekKey(Date.UTC(2026, 0, 5))).toBe('2026-W02');
    // Today's arc anchor: 2026-08-28 (a Friday) sits in W35.
    expect(utcWeekKey(Date.UTC(2026, 7, 28))).toBe('2026-W35');
  });

  it('challengePeriodKey routes by period', () => {
    const ms = Date.UTC(2026, 7, 28, 12);
    expect(challengePeriodKey('daily', ms)).toBe('2026-08-28');
    expect(challengePeriodKey('weekly', ms)).toBe('2026-W35');
  });
});

describe('the quests pack producer', () => {
  it('fingerprint inputs are id-sorted and move on every player-visible field', () => {
    const base = parseChallengesManifest(manifest(
      def({ id: 'daily.zz' }), def({ id: 'daily.aa' }),
    )).manifest!;
    const inputs = challengesFingerprintInputs(base);
    expect(inputs[0]!.startsWith('daily.aa:')).toBe(true);
    for (const over of [
      { target: 6 }, { scrap: 11 }, { name: 'Other' },
      { blurb: 'Changed.' }, { item: 'title-knee-deep' },
    ] as Record<string, unknown>[]) {
      const moved = parseChallengesManifest(manifest(
        def({ id: 'daily.zz' }), def({ id: 'daily.aa', ...over }),
      )).manifest!;
      expect(challengesFingerprintInputs(moved), JSON.stringify(over))
        .not.toEqual(inputs);
    }
  });

  it('questsPack carries the QUESTS kind, the key and the version label', () => {
    const p = questsPack(['daily.a:daily/kills/5/10/-/A/a.'], 3);
    expect(p.kind).toBe(PackKind.QUESTS);
    expect(p.label).toBe('quests@3');
    expect(p.digest).toBe('');
    const p2 = questsPack(['daily.a:daily/kills/6/10/-/A/a.'], 3);
    expect(p2.fingerprint).not.toBe(p.fingerprint);
  });
});
