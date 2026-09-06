/**
 * DOOMCRAFT — achievement settlement: detection is a WRITE, payment is
 * has-first, the receipt outranks the debt, and the promise is paid from the
 * snapshot rather than from whatever the catalogue says today.
 *
 * These drive the REAL functions the room calls, with a REAL journal on disk.
 * Every test names the DEFECTIVE implementation it discriminates, because a
 * test whose named defect produces the same asserted value is decoration and
 * this session has already caught five of those.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { AchievementDef } from '@doomcraft/shared/achievements';

import { JsonJournal, newLedgerId } from './journal.js';
import { achievementMergeRefusal, applyMergeFields } from './merge.js';
import {
  MAX_ACHIEVEMENT_RECEIPTS,
  MAX_OWNED_ITEMS,
  createProfile,
  settleAchievements,
  type AchievementSettlementDeps,
  type StoredProfile,
} from './persistence.js';

const DEVICE = 'device-abcdef12';
const DEVICE_B = 'device-b0b0b0b0';
const NOON = Date.UTC(2026, 8, 6, 12, 0, 0);

const KILLS: AchievementDef = {
  id: 'achievement.kills-1000', name: 'Exterminator', blurb: 'A thousand down.',
  stat: 'kills', target: 1000, scrap: 250, item: null,
};
const STREAK: AchievementDef = {
  id: 'achievement.streak-15', name: 'Unbroken', blurb: 'Fifteen without dying.',
  stat: 'bestStreak', target: 15, scrap: 150, item: 'trophy-first-season',
};

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

function harness(): {
  profile: StoredProfile;
  journal: JsonJournal;
  deps: (over?: Partial<AchievementSettlementDeps>) => AchievementSettlementDeps;
} {
  const dir = mkdtempSync(join(tmpdir(), 'dc-ach-'));
  tempDirs.push(dir);
  const journal = new JsonJournal(dir, { clock: () => NOON });
  const profile = createProfile(DEVICE, NOON);
  return {
    profile,
    journal,
    deps: (over = {}) => ({
      defs: [KILLS, STREAK],
      nowMs: NOON,
      deviceId: DEVICE,
      mayPayScrap: true,
      mayGrantItems: true,
      itemVersion: 1,
      itemKnown: () => true,
      journal,
      rowId: newLedgerId,
      ...over,
    }),
  };
}

/** A career already past a target — the retroactive case, which is the normal one. */
function career(p: StoredProfile, over: Partial<StoredProfile['stats']> = {}): void {
  Object.assign(p.stats, over);
}

describe('detection reads the lifetime block', () => {
  it('completes from history alone, in a round that scored nothing', async () => {
    /* The whole point of reading `stats`: a player with 1,200 lifetime kills
     * earns the thousand-kill award at their next settlement, not after a
     * further thousand. The DEFECTIVE implementation reads the round's
     * contribution — which is zero here, so it pays nothing. */
    const { profile, deps } = harness();
    career(profile, { kills: 1200 });
    const paid = await settleAchievements(profile, deps({ defs: [KILLS] }));
    expect(paid).toEqual([{ id: 'achievement.kills-1000', scrap: 250 }]);
    expect(profile.economy.scrap).toBe(250);
    expect(profile.achievements.done).toEqual(['achievement.kills-1000']);
    expect(profile.achievements.owed).toEqual([]);
  });

  it('completes at EXACTLY the target, not one past it', async () => {
    /* `achievementProgress` clamps AT the target, so a `>` in the completion
     * test can never be true and the defective build completes nothing, ever.
     * An off-by-one input is the only one that sees it. */
    const { profile, deps } = harness();
    career(profile, { kills: 999 });
    expect(await settleAchievements(profile, deps({ defs: [KILLS] }))).toEqual([]);
    career(profile, { kills: 1000 });
    expect(await settleAchievements(profile, deps({ defs: [KILLS] })))
      .toEqual([{ id: 'achievement.kills-1000', scrap: 250 }]);
  });

  it('pays once across repeated settlements, and once more across a RELOAD with the journal forgotten', async () => {
    /* The one-shot claim. The obvious lever — reordering the receipt write
     * around the journal check — does NOT discriminate: it still pays once and
     * still skips the second time. What discriminates is PERSISTENCE plus a
     * journal that has forgotten, which is the state after the ~48 h dedup
     * window closes. The defective implementation is a receipt that does not
     * survive the round trip, or one that gets evicted. */
    const { profile, deps } = harness();
    career(profile, { kills: 1200 });
    await settleAchievements(profile, deps({ defs: [KILLS] }));
    await settleAchievements(profile, deps({ defs: [KILLS] }));
    expect(profile.economy.scrap).toBe(250);

    // Serialise, reload, and settle against a journal that never heard of it.
    const reloaded = JSON.parse(JSON.stringify(profile)) as StoredProfile;
    const fresh = harness();
    const paid = await settleAchievements(reloaded, fresh.deps({ defs: [KILLS] }));
    expect(paid).toEqual([]);
    expect(reloaded.economy.scrap).toBe(250);
  });
});

describe('the promise survives a session that may not pay it', () => {
  it('records the debt with mayPayScrap false, then pays it from the SNAPSHOT', async () => {
    /* Two defects, one test. Returning before the debt is recorded loses the
     * award; paying anyway ignores the permission. Both change the asserted
     * balance. The snapshot half needs the def to CHANGE between the two
     * settlements — otherwise paying from the current def is indistinguishable
     * from paying from the promise. */
    const { profile, deps } = harness();
    career(profile, { kills: 1200 });

    expect(await settleAchievements(profile, deps({ defs: [KILLS], mayPayScrap: false }))).toEqual([]);
    expect(profile.economy.scrap).toBe(0);
    expect(profile.achievements.done).toEqual([]);
    expect(profile.achievements.owed).toEqual([{
      id: 'achievement.kills-1000', sourceId: 'achievement:achievement.kills-1000',
      scrap: 250, item: null,
    }]);

    // The catalogue is re-cut: the award is gone from the defs and the one
    // that remains pays a different amount. The promise is unaffected.
    const recut: AchievementDef = { ...KILLS, scrap: 1 };
    const paid = await settleAchievements(profile, deps({ defs: [recut] }));
    expect(paid).toEqual([{ id: 'achievement.kills-1000', scrap: 250 }]);
    expect(profile.economy.scrap).toBe(250);
  });

  it('pays a debt whose def has been REMOVED entirely', async () => {
    /* The case that broke "the lifetime counter IS the debt". With no def
     * there is nothing to re-derive from, so a build that pays from `defs`
     * pays nothing and the award is silently forfeited. */
    const { profile, deps } = harness();
    career(profile, { kills: 1200 });
    await settleAchievements(profile, deps({ defs: [KILLS], mayPayScrap: false }));
    const paid = await settleAchievements(profile, deps({ defs: [] }));
    expect(paid).toEqual([{ id: 'achievement.kills-1000', scrap: 250 }]);
  });

  it('pays a debt whose def has had its TARGET raised out of reach', async () => {
    const { profile, deps } = harness();
    career(profile, { kills: 1200 });
    await settleAchievements(profile, deps({ defs: [KILLS], mayPayScrap: false }));
    const raised: AchievementDef = { ...KILLS, target: 1_000_000 };
    expect(await settleAchievements(profile, deps({ defs: [raised] })))
      .toEqual([{ id: 'achievement.kills-1000', scrap: 250 }]);
  });
});

describe('an item-bearing award is both halves or neither', () => {
  it('keeps the debt when the inventory is full, and pays it whole when space frees', async () => {
    /* The defective implementation credits Scrap before discovering the item
     * cannot land, so the first-pass balance differs. */
    const { profile, deps } = harness();
    career(profile, { bestStreak: 20 });
    profile.inventory.items = Array.from({ length: MAX_OWNED_ITEMS }, (_, i) => ({
      ref: `items@1:filler-${i}`, ms: NOON, source: 'drop', sourceId: `f${i}`,
    }));

    expect(await settleAchievements(profile, deps({ defs: [STREAK] }))).toEqual([]);
    expect(profile.economy.scrap).toBe(0);
    expect(profile.achievements.done).toEqual([]);
    expect(profile.achievements.owed.map((o) => o.id)).toEqual(['achievement.streak-15']);

    profile.inventory.items.pop();
    expect(await settleAchievements(profile, deps({ defs: [STREAK] })))
      .toEqual([{ id: 'achievement.streak-15', scrap: 150 }]);
    expect(profile.economy.scrap).toBe(150);
    expect(profile.inventory.items.at(-1)!.ref).toBe('items@1:trophy-first-season');
    expect(profile.inventory.items.at(-1)!.source).toBe('achievement');
  });

  it('keeps the debt when the item is no longer in the pinned manifest', async () => {
    /* A DEBT OUTLIVES THE DEF IT CAME FROM, and the payment loop walks `owed`,
     * not `defs` — so the room's pin-time filter cannot reach this. The
     * defective implementation omits `itemKnown` and lets grantDrops decide,
     * and grantDrops is a syntactic gate with no membership lookup: it accepts
     * the ref, the award reads as paid, and the item is dormant from birth.
     * Executed to confirm that, not assumed. */
    const { profile, deps } = harness();
    career(profile, { bestStreak: 20 });

    expect(await settleAchievements(profile, deps({
      defs: [STREAK], itemKnown: () => false,
    }))).toEqual([]);
    expect(profile.economy.scrap).toBe(0);
    expect(profile.inventory.items).toEqual([]);
    expect(profile.achievements.owed.map((o) => o.id)).toEqual(['achievement.streak-15']);

    // The catalogue comes back; the promise pays, item and all.
    expect(await settleAchievements(profile, deps({ defs: [STREAK] })))
      .toEqual([{ id: 'achievement.streak-15', scrap: 150 }]);
    expect(profile.inventory.items.map((i) => i.ref)).toEqual(['items@1:trophy-first-season']);
  });

  it('defers an item-bearing award when the session may not grant items, but not a Scrap-only one', async () => {
    const { profile, deps } = harness();
    career(profile, { kills: 1200, bestStreak: 20 });
    const paid = await settleAchievements(profile, deps({ mayGrantItems: false }));
    expect(paid).toEqual([{ id: 'achievement.kills-1000', scrap: 250 }]);
    expect(profile.achievements.done).toEqual(['achievement.kills-1000']);
    expect(profile.achievements.owed.map((o) => o.id)).toEqual(['achievement.streak-15']);
  });
});

describe('the receipt outranks the debt', () => {
  it('discharges a merged debt instead of paying it a second time', async () => {
    /* The exact shape found LIVE in settleChallenges and fixed the same week —
     * built in here from the start. A holds an unpaid promise, B is the same
     * human on another device who was already paid, and the merge unions both
     * lists. The journal cannot see it: its key ends in the PROFILE KEY, and B
     * paid under B's. Unlike the challenge version there is no period to scope
     * the rule by, because an achievement is earned once, ever. */
    const a = harness();
    const b = harness();
    career(a.profile, { kills: 1200 });
    career(b.profile, { kills: 1200 });

    await settleAchievements(a.profile, a.deps({ defs: [KILLS], mayPayScrap: false }));
    expect(a.profile.achievements.owed).toHaveLength(1);

    await settleAchievements(b.profile, b.deps({ defs: [KILLS], deviceId: DEVICE_B }));
    expect(b.profile.economy.scrap).toBe(250);

    applyMergeFields(a.profile, b.profile, NOON);
    expect(a.profile.achievements.done).toEqual(['achievement.kills-1000']);
    expect(a.profile.achievements.owed).toHaveLength(1);

    const paid = await settleAchievements(a.profile, a.deps({ defs: [KILLS] }));
    expect(paid).toEqual([]);
    expect(a.profile.economy.scrap).toBe(0);
    expect(await a.journal.has('prize', 'achievement:achievement.kills-1000', DEVICE)).toBe(false);
    // The debt is DISCHARGED, not left to try again every match forever.
    expect(a.profile.achievements.owed).toEqual([]);
    // And no duplicate receipt.
    expect(a.profile.achievements.done).toEqual(['achievement.kills-1000']);
  });

  it('unions receipts unconditionally, where the challenge union needs a matching period', async () => {
    /* The structural difference, asserted rather than described. The defective
     * implementation copies the challenge union verbatim, period test and all;
     * there is no period on an achievement receipt, so the test would either
     * never fire or fire on an unrelated field. */
    const a = harness();
    const b = harness();
    b.profile.achievements.done.push('achievement.kills-1000');
    b.profile.challenges.day = '2026-09-06';
    a.profile.challenges.day = '1999-01-01';   // periods deliberately disagree
    b.profile.challenges.done.push('daily.kill-25');

    applyMergeFields(a.profile, b.profile, NOON);
    // The challenge receipt does NOT cross a period boundary...
    expect(a.profile.challenges.done).toEqual([]);
    // ...and the achievement receipt does.
    expect(a.profile.achievements.done).toEqual(['achievement.kills-1000']);
  });
});

describe('the ceilings refuse rather than make room', () => {
  it('stops paying at the receipt ceiling and keeps the promise', async () => {
    const { profile, deps } = harness();
    profile.achievements.done = Array.from({ length: MAX_ACHIEVEMENT_RECEIPTS },
      (_, i) => `achievement.old-${i}`);
    career(profile, { kills: 1200 });

    expect(await settleAchievements(profile, deps({ defs: [KILLS] }))).toEqual([]);
    expect(profile.economy.scrap).toBe(0);
    expect(profile.achievements.done).toHaveLength(MAX_ACHIEVEMENT_RECEIPTS);
    expect(profile.achievements.owed.map((o) => o.id)).toEqual(['achievement.kills-1000']);

    // One below the ceiling, the same award pays — so the refusal is the
    // ceiling and not something else about this fixture.
    profile.achievements.done.pop();
    expect(await settleAchievements(profile, deps({ defs: [KILLS] })))
      .toEqual([{ id: 'achievement.kills-1000', scrap: 250 }]);
  });

  it('refuses a merge that would overflow, before anything is debited', () => {
    const a = createProfile(DEVICE, NOON);
    const b = createProfile(DEVICE_B, NOON);
    a.achievements.done = Array.from({ length: MAX_ACHIEVEMENT_RECEIPTS }, (_, i) => `achievement.a${i}`);
    b.achievements.done = ['achievement.b0'];
    const refusal = achievementMergeRefusal(a, b);
    expect(refusal).toContain('refusing rather than dropping one');

    // An overlapping receipt is not an overflow: the union is by id.
    b.achievements.done = ['achievement.a0'];
    expect(achievementMergeRefusal(a, b)).toBeNull();
  });
});
