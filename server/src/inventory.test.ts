/**
 * DOOMCRAFT — the inventory's persistence story (PERSIST_VERSION 5) and the
 * drop roll's arithmetic. The migration fixture follows the repo's rule: a
 * frozen v4 profile from before the bump, pushed through the real
 * migrateProfile, with the economy it carried proven intact.
 */

import { describe, expect, it } from 'vitest';

import {
  DROP_CHANCE,
  DROP_RARITY_WEIGHTS,
  rollMatchDrops,
} from './packs.js';
import {
  MAX_OWNED_ITEMS,
  PERSIST_VERSION,
  createProfile,
  grantDrops,
  migrateProfile,
  serialiseProfile,
} from './persistence.js';
import { buildSubmission } from './reward.js';
import { parseItemsManifest } from '@doomcraft/shared/items';

/** A profile exactly as a v4 host serialised one (economy present, no inventory). */
const V4_FIXTURE = {
  version: 4,
  deviceId: 'device-fixture-v4',
  accountId: null,
  accountSecret: null,
  createdMs: 1_700_000_000_000,
  updatedMs: 1_755_000_000_000,
  progress: { name: 'Vet', skin: 2, xp: 4200, kills: 300, deaths: 120, wins: 22, gamesPlayed: 60 },
  settings: {},
  bindings: {},
  loadout: { primary: 1, weapons: [0, 1, 2, 3, 4, 5, 6], blocks: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  entitlements: { adsRemoved: false, product: null, receipt: null, purchasedMs: 0 },
  stats: { matches: 60, wins: 22, kills: 300, deaths: 120 },
  economy: { scrap: 860, lifetimeScrap: 1200, day: '2026-08-22', dayXp: 500, dayScrap: 60, dayMatches: 4 },
};

describe('v4 -> v5', () => {
  it('migrates a real v4 profile: balance intact, inventory empty, band unknown', () => {
    const p = migrateProfile(V4_FIXTURE, 'device-fixture-v4', 1_755_100_000_000);
    expect(p.version).toBe(PERSIST_VERSION);
    expect(PERSIST_VERSION).toBe(5);
    expect(p.economy.scrap).toBe(860);
    expect(p.economy.lifetimeScrap).toBe(1200);
    expect(p.progress.xp).toBe(4200);
    expect(p.inventory).toEqual({ items: [], equippedSkin: '', title: '' });
    expect(p.moderation).toEqual({ banned: false, bannedUntilMs: 0, reason: '', revokedItems: [] });
    expect(p.ageBand).toBe('unknown');
  });

  it('round-trips a v5 profile with items through serialise and back', () => {
    const p = createProfile('device-rt');
    grantDrops(p, ['items@1:skin-rust-marine', 'items@1:skin-rust-marine'], 'drop', 'host:room:r1', 123);
    p.inventory.title = 'items@1:title-hangar-rat';
    p.moderation.revokedItems.push({ ref: 'items@1:skin-void-hazard', ms: 5, reason: 'test take-back' });
    p.ageBand = '13-17';
    const back = migrateProfile(serialiseProfile(p), 'device-rt');
    // Duplicates are meaningful (crafting eats them) — both copies survive.
    expect(back.inventory.items.length).toBe(2);
    expect(back.inventory.items[0]).toEqual({ ref: 'items@1:skin-rust-marine', ms: 123, source: 'drop', sourceId: 'host:room:r1' });
    expect(back.inventory.title).toBe('items@1:title-hangar-rat');
    expect(back.moderation.revokedItems[0].reason).toBe('test take-back');
    expect(back.ageBand).toBe('13-17');
  });

  it('carries a NEWER build\'s field inside inventory through a v5 host untouched', () => {
    // The nested downgrade guard, extended to the new sections: a "v6" field
    // inside inventory must survive read-and-write on this build, or the
    // first rollback after v6 destroys it (the exact hole GUARDED_PROFILE_
    // SECTIONS §comment records for economy).
    const v6ish = {
      ...serialiseProfile(createProfile('device-guard')),
      inventory: { items: [], equippedSkin: '', title: '', craftingQueue: [{ id: 'x' }] },
    };
    const once = migrateProfile(v6ish, 'device-guard');
    const out = serialiseProfile(once) as { inventory?: { craftingQueue?: unknown } };
    expect(out.inventory?.craftingQueue).toEqual([{ id: 'x' }]);
  });

  it('grantDrops refuses past the cap and refuses junk refs, and never throws', () => {
    const p = createProfile('device-cap');
    expect(grantDrops(p, ['not-a-ref'], 'drop', 's', 1)).toEqual([]);
    for (let i = 0; i < MAX_OWNED_ITEMS + 10; i++) grantDrops(p, ['items@1:skin-a'], 'drop', 's', 1);
    expect(p.inventory.items.length).toBe(MAX_OWNED_ITEMS);
  });
});

/* ------------------------------------------------------------------------ *
 * The roll
 * ------------------------------------------------------------------------ */

const MANIFEST = parseItemsManifest(JSON.stringify({
  items: [
    { id: 'c1', kind: 'skin', name: 'c1', rarity: 'common', tradable: true },
    { id: 'c2', kind: 'skin', name: 'c2', rarity: 'common', tradable: true },
    { id: 'r1', kind: 'trail', name: 'r1', rarity: 'relic', tradable: true },
    { id: 't1', kind: 'title', name: 't1', rarity: 'common', tradable: false, text: 'T' },
  ],
})).manifest!;

describe('rollMatchDrops', () => {
  it('drops nothing when the chance roll misses, one ref when it hits', () => {
    expect(rollMatchDrops(MANIFEST, 2, () => 0.99)).toEqual([]);
    const seq = [0.0, 0.0, 0.0][Symbol.iterator]();
    const hit = rollMatchDrops(MANIFEST, 2, () => seq.next().value ?? 0);
    expect(hit).toEqual(['items@2:c1']);
  });

  it('never rolls a title or a trophy — those are earned, not found', () => {
    const rolls: string[] = [];
    let n = 0;
    const rand = (): number => {
      // Cycle deterministically through the space.
      n = (n + 7919) % 10_000;
      return n / 10_000;
    };
    for (let i = 0; i < 2_000; i++) rolls.push(...rollMatchDrops(MANIFEST, 1, rand));
    expect(rolls.length).toBeGreaterThan(100);
    expect(rolls.some((r) => r.includes(':t1'))).toBe(false);
    // And the weights lean the way the table says: commons dominate relics.
    const commons = rolls.filter((r) => r.includes(':c')).length;
    const relics = rolls.filter((r) => r.includes(':r1')).length;
    expect(commons).toBeGreaterThan(relics * 3);
    expect(DROP_RARITY_WEIGHTS[0]).toBeGreaterThan(DROP_RARITY_WEIGHTS[4]);
    expect(DROP_CHANCE).toBeLessThan(0.5);
  });

  it('an empty or cosmetics-free manifest rolls nothing rather than throwing', () => {
    const empty = parseItemsManifest('{"items":[]}').manifest!;
    expect(rollMatchDrops(empty, 1, () => 0)).toEqual([]);
    const titlesOnly = parseItemsManifest(JSON.stringify({
      items: [{ id: 't', kind: 'title', name: 't', rarity: 'common', tradable: false, text: 'T' }],
    })).manifest!;
    expect(rollMatchDrops(titlesOnly, 1, () => 0)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * The pays gate carries drops
 * ------------------------------------------------------------------------ */

describe('buildSubmission and drops', () => {
  const tally = (over: Record<string, unknown>): Parameters<typeof buildSubmission>[0] => ({
    sessionId: 's', deviceId: 'device-x', won: false,
    kills: 0, deaths: 0, seconds: 120, bestStreak: 0,
    damageDealt: 0, blocksPlaced: 0, blocksBroken: 0, favouriteWeapon: 0,
    ...over,
  } as Parameters<typeof buildSubmission>[0]);

  it('zeroes drops for an idle round, exactly as it zeroes the money', () => {
    const idle = buildSubmission(tally({ drops: ['items@1:c1'] }));
    expect(idle.xp).toBe(0);
    expect(idle.drops).toEqual([]);
    const active = buildSubmission(tally({ kills: 3, damageDealt: 300, drops: ['items@1:c1'] }));
    expect(active.xp).toBeGreaterThan(0);
    expect(active.drops).toEqual(['items@1:c1']);
  });
});
