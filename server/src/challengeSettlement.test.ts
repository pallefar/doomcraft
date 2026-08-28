/**
 * DOOMCRAFT — challenge settlement: accrual is pure progress, payment is
 * has-first per completion, the receipt is the profile, and a torn write is
 * repaired rather than repaid (Studio S4; the crash-window analysis lives on
 * `settleChallenges`). These tests drive the REAL functions the room calls,
 * with a REAL journal on disk — a copy of the logic proves nothing.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { ChallengeDef } from '@doomcraft/shared/challenges';

import { JsonJournal, newLedgerId } from './journal.js';
import {
  MAX_SCRAP_BALANCE,
  accrueChallenges,
  createProfile,
  creditChallengeScrap,
  settleChallenges,
  type ChallengeSettlementDeps,
  type StoredProfile,
} from './persistence.js';

const DEVICE = 'device-abcdef12';
/** Friday 2026-08-28 noon UTC — day 2026-08-28, ISO week 2026-W35. */
const NOON = Date.UTC(2026, 7, 28, 12, 0, 0);
const DAY_MS = 86_400_000;

const KILLS: ChallengeDef = {
  id: 'daily.kill-5', name: 'Five', blurb: 'Take down five.',
  period: 'daily', stat: 'kills', target: 5, scrap: 40, item: null,
};
const STREAK: ChallengeDef = {
  id: 'weekly.streak-3', name: 'Streak', blurb: 'Hit a 3-streak.',
  period: 'weekly', stat: 'bestStreak', target: 3, scrap: 100, item: 'title-knee-deep',
};
const WINS: ChallengeDef = {
  id: 'weekly.wins-2', name: 'Twice', blurb: 'Win twice.',
  period: 'weekly', stat: 'wins', target: 2, scrap: 150, item: null,
};

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

function stats(over: Partial<{ kills: number; won: boolean; bestStreak: number;
  damageDealt: number; blocksPlaced: number; blocksBroken: number }> = {}) {
  return {
    kills: 0, won: false, bestStreak: 0, damageDealt: 0,
    blocksPlaced: 0, blocksBroken: 0, ...over,
  };
}

function harness(): {
  profile: StoredProfile;
  journal: JsonJournal;
  clock: { now: number };
  deps: (over?: Partial<ChallengeSettlementDeps>) => ChallengeSettlementDeps;
} {
  const dir = mkdtempSync(join(tmpdir(), 'dc-chal-'));
  tempDirs.push(dir);
  const clock = { now: NOON };
  const journal = new JsonJournal(dir, { clock: () => clock.now });
  const profile = createProfile(DEVICE, NOON);
  return {
    profile,
    journal,
    clock,
    deps: (over = {}) => ({
      defs: [KILLS, STREAK, WINS],
      grantedIds: [],
      stats: stats(),
      nowMs: clock.now,
      deviceId: DEVICE,
      mayPayScrap: true,
      mayGrantItems: true,
      itemVersion: 1,
      journal,
      rowId: newLedgerId,
      ...over,
    }),
  };
}

describe('accrual is pure progress', () => {
  it('sums additive stats, clamps at target, and folds bestStreak as MAX', () => {
    const { profile } = harness();
    accrueChallenges(profile, [KILLS, STREAK], ['daily.kill-5', 'weekly.streak-3'],
      stats({ kills: 3, bestStreak: 2 }), NOON);
    expect(profile.challenges.counts['daily.kill-5']).toBe(3);
    expect(profile.challenges.counts['weekly.streak-3']).toBe(2);
    accrueChallenges(profile, [KILLS, STREAK], ['daily.kill-5', 'weekly.streak-3'],
      stats({ kills: 9, bestStreak: 1 }), NOON);
    // kills 3+9 clamps at target 5; streak MAX(2,1) stays 2 — two matches
    // with streak 2 are not a streak 4.
    expect(profile.challenges.counts['daily.kill-5']).toBe(5);
    expect(profile.challenges.counts['weekly.streak-3']).toBe(2);
  });

  it('rolls the day bucket without touching the week, and vice versa', () => {
    const { profile } = harness();
    accrueChallenges(profile, [KILLS, WINS], ['daily.kill-5', 'weekly.wins-2'],
      stats({ kills: 5, won: true }), NOON);
    profile.challenges.done.push('daily.kill-5');
    // Saturday: same ISO week, new day — daily state resets, weekly holds.
    accrueChallenges(profile, [KILLS, WINS], [], stats(), NOON + DAY_MS);
    expect(profile.challenges.counts['daily.kill-5']).toBeUndefined();
    expect(profile.challenges.done).toEqual([]);
    expect(profile.challenges.counts['weekly.wins-2']).toBe(1);
    // Monday: new ISO week — weekly state resets too.
    accrueChallenges(profile, [KILLS, WINS], [], stats(), NOON + 3 * DAY_MS);
    expect(profile.challenges.counts['weekly.wins-2']).toBeUndefined();
  });
});

describe('payment is has-first, once per period', () => {
  it('pays a completion once — a second contributing settlement moves nothing', async () => {
    const h = harness();
    const paid = await settleChallenges(h.profile, h.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }),
    }));
    expect(paid).toEqual([{ id: 'daily.kill-5', scrap: 40 }]);
    expect(h.profile.economy.scrap).toBe(40);
    expect(h.profile.challenges.done).toContain('daily.kill-5');
    // The journal row exists under the period-keyed source id.
    expect(await h.journal.has('prize', 'challenge:daily.kill-5:2026-08-28', DEVICE)).toBe(true);

    const again = await settleChallenges(h.profile, h.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }),
    }));
    expect(again).toEqual([]);
    expect(h.profile.economy.scrap).toBe(40);
  });

  it('weekly source ids carry the ISO week key', async () => {
    const h = harness();
    await settleChallenges(h.profile, h.deps({
      grantedIds: ['weekly.wins-2'], stats: stats({ won: true }),
    }));
    const again = await settleChallenges(h.profile, h.deps({
      grantedIds: ['weekly.wins-2'], stats: stats({ won: true }),
    }));
    expect(again.map((p) => p.id)).toEqual(['weekly.wins-2']);
    expect(await h.journal.has('prize', 'challenge:weekly.wins-2:2026-W35', DEVICE)).toBe(true);
  });

  it('banks progress where payment cannot happen, and pays in the first session that can', async () => {
    const h = harness();
    // A Builder-shaped settlement: challenge progress granted, Scrap not.
    const owed = await settleChallenges(h.profile, h.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }), mayPayScrap: false,
    }));
    expect(owed).toEqual([]);
    expect(h.profile.economy.scrap).toBe(0);
    expect(h.profile.challenges.counts['daily.kill-5']).toBe(5);
    expect(h.profile.challenges.done).toEqual([]);
    // The next paying settlement — zero new contribution — pays the debt.
    const paid = await settleChallenges(h.profile, h.deps({}));
    expect(paid).toEqual([{ id: 'daily.kill-5', scrap: 40 }]);
    expect(h.profile.economy.scrap).toBe(40);
  });

  it('repairs a torn write: journal row present, receipt lost — done[] is restored and NOTHING moves', async () => {
    const h = harness();
    await settleChallenges(h.profile, h.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }),
    }));
    // The crash: the row reached the disk, the debounced profile write did
    // not. Counts survive from an earlier flush; the receipt is gone.
    h.profile.challenges.done = [];
    const replay = await settleChallenges(h.profile, h.deps({}));
    expect(replay).toEqual([]);
    expect(h.profile.economy.scrap).toBe(40);
    expect(h.profile.challenges.done).toContain('daily.kill-5');
  });

  it('an item-bearing completion pays both halves or defers whole', async () => {
    const h = harness();
    // Scrap yes, items no: the completion must NOT half-pay.
    const deferred = await settleChallenges(h.profile, h.deps({
      grantedIds: ['weekly.streak-3'], stats: stats({ bestStreak: 4 }), mayGrantItems: false,
    }));
    expect(deferred).toEqual([]);
    expect(h.profile.economy.scrap).toBe(0);
    expect(h.profile.challenges.done).toEqual([]);
    // Both bits: scrap, receipt, and the title land together.
    const paid = await settleChallenges(h.profile, h.deps({}));
    expect(paid).toEqual([{ id: 'weekly.streak-3', scrap: 100 }]);
    const owned = h.profile.inventory.items.find((i) => i.ref === 'items@1:title-knee-deep');
    expect(owned?.source).toBe('challenge');
    expect(owned?.sourceId).toBe('challenge:weekly.streak-3:2026-W35');
  });

  it('records the OBSERVED delta when the balance ceiling bites', async () => {
    const h = harness();
    h.profile.economy.scrap = MAX_SCRAP_BALANCE - 10;
    const paid = await settleChallenges(h.profile, h.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }),
    }));
    // Asked 40, moved 10 — the paid list (and the journal row it mirrors)
    // reports the movement, never the intention.
    expect(paid).toEqual([{ id: 'daily.kill-5', scrap: 10 }]);
    expect(h.profile.economy.scrap).toBe(MAX_SCRAP_BALANCE);
  });
});

describe('creditChallengeScrap', () => {
  it('clamps at the balance ceiling and reports before/after', () => {
    const profile = createProfile(DEVICE, NOON);
    profile.economy.scrap = MAX_SCRAP_BALANCE - 3;
    const moved = creditChallengeScrap(profile, 40);
    expect(moved).toEqual({ before: MAX_SCRAP_BALANCE - 3, after: MAX_SCRAP_BALANCE });
  });
});
