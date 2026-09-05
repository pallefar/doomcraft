/**
 * DOOMCRAFT — the trade-up's rules, off the wire.
 *
 * The expensive ones: a craft consumes exactly three copies and the OLDEST
 * three; copies on a trade table are not material; titles never craft; the
 * target is the chosen one, same kind, exactly one rarity up; and eating the
 * last copy of an equipped skin unequips it rather than leaving a ghost.
 */

import { describe, expect, it } from 'vitest';

import { CRAFT_COPIES, CRAFT_FEES, applyCraft, craftVerdict } from './craft.js';
import { createProfile, grantDrops } from './persistence.js';
import { ItemRarity, parseItemsManifest, type ItemDef } from '@doomcraft/shared/items';

const MANIFEST = parseItemsManifest(JSON.stringify({
  items: [
    { id: 'skin-a', kind: 'skin', name: 'Skin A', rarity: 'common', tradable: true },
    { id: 'skin-b', kind: 'skin', name: 'Skin B', rarity: 'uncommon', tradable: true },
    { id: 'skin-c', kind: 'skin', name: 'Skin C', rarity: 'rare', tradable: true },
    { id: 'skin-r', kind: 'skin', name: 'Skin R', rarity: 'relic', tradable: true },
    { id: 'trail-b', kind: 'trail', name: 'Trail B', rarity: 'uncommon', tradable: true },
    { id: 'title-a', kind: 'title', name: 'Title A', rarity: 'common', text: 'T' },
    {
      id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
      rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
    },
    {
      id: 'weapon_variant-rocket-swift', kind: 'weapon_variant', name: 'Swift Rocket',
      rarity: 'rare', tradable: true, variantId: 'rocket-swift',
    },
  ],
})).manifest!;
const DEFS = new Map<string, ItemDef>(MANIFEST.items.map((i) => [i.id, i]));
const NONE = new Map<string, number>();

const A = 'items@1:skin-a';

function owner(copies = 3, scrap = 500): ReturnType<typeof createProfile> {
  const p = createProfile('device-craft');
  for (let i = 0; i < copies; i++) grantDrops(p, [A], 'drop', `seed-${i}`, 100 + i);
  p.economy.scrap = scrap;
  return p;
}

describe('craftVerdict', () => {
  it('accepts three free copies + the fee, and prices by TARGET rarity', () => {
    const v = craftVerdict(owner(), A, 'skin-b', DEFS, 1, NONE);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.plan.targetRef).toBe('items@1:skin-b');
      expect(v.plan.fee).toBe(CRAFT_FEES[ItemRarity.UNCOMMON]);
    }
  });

  it('refuses too few copies, and copies held by the escrow are NOT material', () => {
    expect(craftVerdict(owner(2), A, 'skin-b', DEFS, 1, NONE).ok).toBe(false);
    const reserved = new Map([[A, 1]]);
    const v = craftVerdict(owner(3), A, 'skin-b', DEFS, 1, reserved);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('trade table');
  });

  it('refuses the fee it cannot pay, naming both numbers', () => {
    const v = craftVerdict(owner(3, 10), A, 'skin-b', DEFS, 1, NONE);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/costs 50 Scrap — you have 10/);
  });

  it('refuses cross-kind, wrong-rarity, relic-source, titles, ghosts and the revoked', () => {
    expect(craftVerdict(owner(), A, 'trail-b', DEFS, 1, NONE).ok).toBe(false); // cross-kind
    expect(craftVerdict(owner(), A, 'skin-c', DEFS, 1, NONE).ok).toBe(false);  // two rarities up
    const relic = createProfile('d');
    grantDrops(relic, ['items@1:skin-r', 'items@1:skin-r', 'items@1:skin-r'], 'drop', 's', 1);
    relic.economy.scrap = 9999;
    expect(craftVerdict(relic, 'items@1:skin-r', 'skin-b', DEFS, 1, NONE).ok).toBe(false); // above relic
    const titled = createProfile('d2');
    grantDrops(titled, ['items@1:title-a', 'items@1:title-a', 'items@1:title-a'], 'prize', 's', 1);
    titled.economy.scrap = 9999;
    const t = craftVerdict(titled, 'items@1:title-a', 'skin-b', DEFS, 1, NONE);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toContain('proof');
    const ghost = owner();
    grantDrops(ghost, ['items@1:skin-gone', 'items@1:skin-gone', 'items@1:skin-gone'], 'drop', 's', 1);
    expect(craftVerdict(ghost, 'items@1:skin-gone', 'skin-b', DEFS, 1, NONE).ok).toBe(false); // dormant
    const revoked = owner();
    revoked.moderation.revokedItems.push({ ref: A, ms: 1, reason: 'test' });
    expect(craftVerdict(revoked, A, 'skin-b', DEFS, 1, NONE).ok).toBe(false);
  });
});

describe('applyCraft', () => {
  it('consumes exactly three copies, the OLDEST first, and debits the fee', () => {
    const p = owner(5, 500);
    const v = craftVerdict(p, A, 'skin-b', DEFS, 1, NONE);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const out = applyCraft(p, v.plan);
    const left = p.inventory.items.filter((i) => i.ref === A);
    expect(left).toHaveLength(2);
    // Seeded at ms 100..104: the two NEWEST copies survive.
    expect(left.map((i) => i.ms).sort()).toEqual([103, 104]);
    expect(out.debited).toBe(-50);
    expect(out.balanceAfter).toBe(450);
    expect(p.economy.scrap).toBe(450);
  });

  it('unequips a skin whose LAST copy was eaten, and only then', () => {
    const p = owner(3, 500);
    p.inventory.equippedSkin = A;
    const v = craftVerdict(p, A, 'skin-b', DEFS, 1, NONE);
    if (!v.ok) throw new Error(v.error);
    applyCraft(p, v.plan);
    expect(p.inventory.equippedSkin).toBe('');
    const q = owner(4, 500);
    q.inventory.equippedSkin = A;
    const w = craftVerdict(q, A, 'skin-b', DEFS, 1, NONE);
    if (!w.ok) throw new Error(w.error);
    applyCraft(q, w.plan);
    expect(q.inventory.equippedSkin).toBe(A); // a copy survives; the claim stands
  });

  it('the constants say what the design says', () => {
    expect(CRAFT_COPIES).toBe(3);
    expect(CRAFT_FEES[ItemRarity.UNCOMMON]).toBeLessThan(CRAFT_FEES[ItemRarity.RARE]);
    expect(CRAFT_FEES[ItemRarity.RARE]).toBeLessThan(CRAFT_FEES[ItemRarity.EPIC]);
    expect(CRAFT_FEES[ItemRarity.EPIC]).toBeLessThan(CRAFT_FEES[ItemRarity.RELIC]);
  });
});

describe('V4b: no craft mints a weapon variant', () => {
  /*
   * CONFIRMING the existing rule rather than adding a second one: variants are
   * craft-only per docs/VARIANTS.md §7.2, and V4b ships NO recipe — V4e does.
   * `CRAFTABLE_KINDS` is where that is decided and it is a whitelist, so the
   * new kind is excluded by construction. This is the test that says the
   * whitelist is doing that job, so the day someone widens it they are told.
   */
  const SLUG = 'items@1:weapon_variant-shotgun-slug';

  it('refuses a weapon_variant as crafting MATERIAL and as a crafting TARGET', () => {
    const p = createProfile('device-craft-variant');
    for (let i = 0; i < 3; i++) grantDrops(p, [SLUG], 'trade', `seed-${i}`, 100 + i);
    p.economy.scrap = 5000;
    expect(p.inventory.items.length, 'the fixture never got the copies').toBe(3);

    const asSource = craftVerdict(p, SLUG, 'weapon_variant-rocket-swift', DEFS, 1, NONE);
    expect(asSource.ok).toBe(false);
    if (!asSource.ok) expect(asSource.error).toContain('cannot be crafted');

    // And a skin cannot be crafted INTO one: the kinds must match.
    const asTarget = craftVerdict(owner(), A, 'weapon_variant-shotgun-slug', DEFS, 1, NONE);
    expect(asTarget.ok).toBe(false);
    if (!asTarget.ok) expect(asTarget.error).toContain('crafts into a skin');
  });
});
