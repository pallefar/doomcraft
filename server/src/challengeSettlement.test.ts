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
import { applyMergeFields } from './merge.js';
import {
  MAX_OWNED_ITEMS,
  MAX_SCRAP_BALANCE,
  accrueChallenges,
  createProfile,
  creditChallengeScrap,
  migrateProfile,
  settleChallenges,
  type ChallengeSettlementDeps,
  type StoredProfile,
} from './persistence.js';

const DEVICE = 'device-abcdef12';
const DEVICE_B = 'device-b0b0b0b0';
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

  it('carries an owed completion ACROSS the period roll — the roll must not eat a debt', async () => {
    const h = harness();
    // Earned at 23:50 in a Builder-shaped session that may not pay.
    const late = NOON + 11.8 * 3_600_000; // 2026-08-28 23:48 UTC
    await settleChallenges(h.profile, h.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }), nowMs: late, mayPayScrap: false,
    }));
    expect(h.profile.economy.scrap).toBe(0);
    expect(h.profile.challenges.owed.map((o) => o.id)).toEqual(['daily.kill-5']);

    // Next day, a paying match. The counter is rolled away — the DEBT is not.
    const nextDay = late + 40 * 60_000; // 00:28 UTC on the 29th
    const paid = await settleChallenges(h.profile, h.deps({ nowMs: nextDay }));
    expect(paid).toEqual([{ id: 'daily.kill-5', scrap: 40 }]);
    expect(h.profile.economy.scrap).toBe(40);
    // Paid under YESTERDAY's key, so today's copy of the same challenge is
    // still earnable — the receipt belongs to the period it was earned in.
    expect(await h.journal.has('prize', 'challenge:daily.kill-5:2026-08-28', DEVICE)).toBe(true);
    expect(h.profile.challenges.done).not.toContain('daily.kill-5');
    expect(h.profile.challenges.owed).toEqual([]);
  });

  it('keeps an item-bearing completion owed when the inventory is FULL, then pays it when space frees', async () => {
    const h = harness();
    for (let i = 0; i < MAX_OWNED_ITEMS; i++) {
      h.profile.inventory.items.push({ ref: `items@1:filler-${i}`, ms: NOON, source: 'drop', sourceId: 's' });
    }
    const blocked = await settleChallenges(h.profile, h.deps({
      grantedIds: ['weekly.streak-3'], stats: stats({ bestStreak: 4 }),
    }));
    // BOTH halves or neither: no scrap, no receipt, no row — still owed.
    expect(blocked).toEqual([]);
    expect(h.profile.economy.scrap).toBe(0);
    expect(h.profile.challenges.done).toEqual([]);
    expect(h.profile.challenges.owed.map((o) => o.id)).toEqual(['weekly.streak-3']);
    expect(await h.journal.has('prize', 'challenge:weekly.streak-3:2026-W35', DEVICE)).toBe(false);

    h.profile.inventory.items.length = MAX_OWNED_ITEMS - 1;
    const paid = await settleChallenges(h.profile, h.deps({}));
    expect(paid).toEqual([{ id: 'weekly.streak-3', scrap: 100 }]);
    expect(h.profile.inventory.items.some((i) => i.ref === 'items@1:title-knee-deep')).toBe(true);
    expect(h.profile.challenges.owed).toEqual([]);
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

describe('stored challenge state survives a disk round trip', () => {
  it('keeps the NEWEST entries at the cap — evicting a live receipt would re-open double-pay', () => {
    // 300 stale ids from re-cut packs at the FRONT, the live pack's at the back.
    const counts: Record<string, number> = {};
    const done: string[] = [];
    for (let i = 0; i < 300; i++) { counts[`weekly.stale-${i}`] = 1; done.push(`weekly.stale-${i}`); }
    counts['weekly.live'] = 3;
    done.push('weekly.live');
    const p = migrateProfile({
      version: 6, deviceId: DEVICE,
      challenges: { day: '2026-08-28', week: '2026-W35', counts, done, owed: [] },
    }, DEVICE, NOON);
    expect(p.challenges.counts['weekly.live']).toBe(3);
    expect(p.challenges.done).toContain('weekly.live');
    // The oldest are the ones that fall off, never the live pack's.
    expect(p.challenges.counts['weekly.stale-0']).toBeUndefined();
  });


  it('a merged receipt discharges the merged debt instead of paying it twice', async () => {
    /* The two-device case, driven through the REAL merge, because the bug is
     * not visible inside either half on its own. A banks a completion in a
     * session that grants progress but not Scrap, so it sits in `owed` with
     * nothing credited. B is the SAME HUMAN on another device, who completed
     * and was PAID today, so B holds the receipt. `applyMergeFields` unions
     * `done` within the period and unions `owed` by sourceId with no
     * cross-check, so A ends up holding both — and the journal cannot catch
     * it, because its key ends in the profile key and B paid under B's.
     *
     * The assertion is the DOWNSTREAM COST, not the flag: the balance and the
     * ledger row, which is what a player and an auditor actually see. */
    const a = harness();
    const b = harness();

    await settleChallenges(a.profile, a.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }), mayPayScrap: false,
    }));
    expect(a.profile.challenges.owed.map((o) => o.id)).toEqual(['daily.kill-5']);
    expect(a.profile.economy.scrap).toBe(0);

    await settleChallenges(b.profile, b.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }), deviceId: DEVICE_B,
    }));
    expect(b.profile.challenges.done).toEqual(['daily.kill-5']);
    expect(b.profile.economy.scrap).toBe(40);

    applyMergeFields(a.profile, b.profile, NOON);
    // The state the merge really produces: one completion in BOTH lists.
    expect(a.profile.challenges.done).toEqual(['daily.kill-5']);
    expect(a.profile.challenges.owed).toHaveLength(1);

    await settleChallenges(a.profile, a.deps());

    const src = 'challenge:daily.kill-5:2026-08-28';
    expect(a.profile.economy.scrap).toBe(0);
    expect(await a.journal.has('prize', src, DEVICE)).toBe(false);
    expect(a.profile.challenges.done).toEqual(['daily.kill-5']);
    expect(a.profile.challenges.owed).toEqual([]);
  });

  it("an EARLIER period's debt still pays through this period's receipt", async () => {
    /* The other side of the same guard, and the reason its period test is not
     * decoration. The first version of this test could not fail: the day roll
     * empties `done` before a carried debt is ever examined, so the branch was
     * never reached and dropping the period test left it green.
     *
     * The state that DOES reach it is again one only the merge can build.
     * A completed and was PAID today, so A holds today's receipt. B banked the
     * SAME challenge YESTERDAY in a session that could not pay, so B holds a
     * debt stamped with yesterday's period. That is a different completion,
     * genuinely never paid, and today's receipt must not discharge it. */
    const a = harness();
    const b = harness();

    // B, yesterday: banked and unpaid.
    const yesterday = NOON - DAY_MS;
    await settleChallenges(b.profile, b.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }),
      nowMs: yesterday, deviceId: DEVICE_B, mayPayScrap: false,
    }));
    expect(b.profile.challenges.owed[0].periodKey).toBe('2026-08-27');

    // A, today: completed and paid, so today's receipt is on the profile.
    await settleChallenges(a.profile, a.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }),
    }));
    expect(a.profile.challenges.done).toEqual(['daily.kill-5']);
    expect(a.profile.economy.scrap).toBe(40);

    applyMergeFields(a.profile, b.profile, NOON);
    // Today's receipt and YESTERDAY's debt, together, on one profile.
    expect(a.profile.challenges.done).toEqual(['daily.kill-5']);
    expect(a.profile.challenges.owed.map((o) => o.periodKey)).toEqual(['2026-08-27']);

    await settleChallenges(a.profile, a.deps());

    // Yesterday's completion pays: 40 for today, 40 for the carried debt.
    expect(a.profile.economy.scrap).toBe(80);
    expect(await a.journal.has('prize', 'challenge:daily.kill-5:2026-08-27', DEVICE)).toBe(true);
    expect(a.profile.challenges.owed).toEqual([]);
  });

  it("a DAILY receipt does not cross on a shared WEEK, robbing today's unpaid debt", async () => {
    /* Found by a test written for something else, and it is the interaction
     * that matters rather than either half. The union's two loops each copied
     * the WHOLE of B's `done`, so a daily receipt crossed whenever the profiles
     * shared an ISO week — harmless while the payment loop ignored `done`, and
     * a loss the moment that loop learned to let a receipt discharge a debt.
     *
     * A earns the daily TODAY in a session that cannot pay. B was paid the SAME
     * daily YESTERDAY, same ISO week. The defective union hands A a receipt for
     * a completion A never earned today, and the debt is discharged for nothing.
     * Asserted as the BALANCE, because "was the receipt copied" is the flag and
     * this is the cost. */
    const a = harness();
    const b = harness();

    await settleChallenges(a.profile, a.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }), mayPayScrap: false,
    }));
    expect(a.profile.challenges.owed).toHaveLength(1);

    // B: same ISO week (Friday 2026-08-28 and Thursday the 27th are both W35),
    // different day, and paid.
    const yesterday = NOON - DAY_MS;
    await settleChallenges(b.profile, b.deps({
      grantedIds: ['daily.kill-5'], stats: stats({ kills: 5 }),
      nowMs: yesterday, deviceId: DEVICE_B,
    }));
    expect(b.profile.challenges.done).toEqual(['daily.kill-5']);
    expect(b.profile.challenges.week).toBe(a.profile.challenges.week);
    expect(b.profile.challenges.day).not.toBe(a.profile.challenges.day);

    applyMergeFields(a.profile, b.profile, NOON);
    await settleChallenges(a.profile, a.deps());

    /* THE BALANCE FIRST, deliberately: it is what the player loses, and a
     * failure message reading "expected 0 to be 40" says so, where "expected
     * ['daily.kill-5'] to equal []" only says a flag moved. */
    expect(a.profile.economy.scrap).toBe(40);
    expect(a.profile.challenges.owed).toEqual([]);
    expect(a.profile.challenges.done).toEqual(['daily.kill-5']);
  });

  it('a WEEKLY receipt still crosses on a shared week, and a daily on a shared day', async () => {
    /* The other direction, so the prefix scoping cannot be "fixed" by simply
     * refusing to union anything. Both profiles sit in the same day AND the
     * same week, so both classes must cross. */
    const a = harness();
    const b = harness();
    await settleChallenges(b.profile, b.deps({
      grantedIds: ['daily.kill-5', 'weekly.wins-2'],
      stats: stats({ kills: 5, won: true }), deviceId: DEVICE_B,
    }));
    await settleChallenges(b.profile, b.deps({
      grantedIds: ['weekly.wins-2'], stats: stats({ won: true }), deviceId: DEVICE_B,
    }));
    expect(b.profile.challenges.done.sort()).toEqual(['daily.kill-5', 'weekly.wins-2']);

    // Put A in the same period without paying anything.
    await settleChallenges(a.profile, a.deps({ grantedIds: [], stats: stats() }));
    applyMergeFields(a.profile, b.profile, NOON);
    expect(a.profile.challenges.done.sort()).toEqual(['daily.kill-5', 'weekly.wins-2']);
  });

  it('round-trips owed entries and refuses malformed ones', () => {
    const p = migrateProfile({
      version: 6, deviceId: DEVICE,
      challenges: {
        day: '', week: '', counts: {}, done: [],
        owed: [
          { id: 'daily.kill-5', periodKey: '2026-08-28', sourceId: 'challenge:daily.kill-5:2026-08-28', scrap: 40, item: null },
          { id: 'daily.kill-5', periodKey: '2026-08-28', sourceId: 'challenge:daily.kill-5:2026-08-28', scrap: 999, item: null },
          { id: '', periodKey: 'x', sourceId: 'y', scrap: 1, item: null },
          { nonsense: true },
        ],
      },
    }, DEVICE, NOON);
    expect(p.challenges.owed).toEqual([{
      id: 'daily.kill-5', periodKey: '2026-08-28',
      sourceId: 'challenge:daily.kill-5:2026-08-28', scrap: 40, item: null,
    }]);
  });
});
