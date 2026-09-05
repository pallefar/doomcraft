/**
 * DOOMCRAFT — the inventory's persistence story (PERSIST_VERSION 5) and the
 * drop roll's arithmetic. The migration fixture follows the repo's rule: a
 * frozen v4 profile from before the bump, pushed through the real
 * migrateProfile, with the economy it carried proven intact.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DROP_CHANCE,
  DROP_RARITY_WEIGHTS,
  rollMatchDrops,
} from './packs.js';
import {
  MAX_OWNED_ITEMS,
  PERSIST_VERSION,
  applyEquip,
  createProfile,
  equipVerdict,
  grantDrops,
  migrateProfile,
  serialiseProfile,
} from './persistence.js';
import type { EquipSlot } from './persistence.js';
import { buildSubmission } from './reward.js';
import { ItemKind, itemStateFor, parseItemRef, parseItemsManifest } from '@doomcraft/shared/items';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');

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
    expect(PERSIST_VERSION).toBe(7);
    expect(p.economy.scrap).toBe(860);
    expect(p.economy.lifetimeScrap).toBe(1200);
    expect(p.progress.xp).toBe(4200);
    expect(p.inventory).toEqual({ items: [], equippedSkin: '', title: '' });
    expect(p.moderation).toEqual({ banned: false, bannedUntilMs: 0, reason: '', revokedItems: [] });
    expect(p.ageBand).toBe('unknown');
  });

  it('migrates a frozen v5 profile: challenges seeded empty, the v5 economy intact', () => {
    const v5 = {
      ...V4_FIXTURE,
      version: 5,
      inventory: { items: [], equippedSkin: '', title: '' },
      moderation: { banned: false, bannedUntilMs: 0, reason: '', revokedItems: [] },
      ageBand: 'unknown',
    };
    const p = migrateProfile(v5, 'device-fixture-v5', 1_755_100_000_000);
    // Tracks the constant. A literal here says nothing about the migration and
    // has to be edited on every bump, which is how a version pin stops meaning
    // anything; `PERSIST_VERSION` is pinned once, deliberately, above.
    expect(p.version).toBe(PERSIST_VERSION);
    expect(p.challenges).toEqual({ day: '', week: '', counts: {}, done: [], owed: [] });
    // v7: a profile written before rewarded existed starts owing nothing and
    // having taken nothing, so its first grant today pays the top of the ladder.
    expect(p.adRewards).toEqual({ day: '', count: 0, lastMs: 0 });
    expect(p.economy.scrap).toBe(860);
    expect(p.economy.lifetimeScrap).toBe(1200);
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

/* ------------------------------------------------------------------------ *
 * Equipping — the claim is validated at the door, then merely stored
 * ------------------------------------------------------------------------ */

describe('equipVerdict / applyEquip', () => {
  const SKIN = 'items@1:skin-rust-marine';
  const TITLE = 'items@1:title-hangar-rat';
  const kinds = new Map<string, ItemKind>([
    ['skin-rust-marine', ItemKind.SKIN],
    ['title-hangar-rat', ItemKind.TITLE],
  ]);
  const kindOf = (ref: string): ItemKind | null => {
    const parsed = parseItemRef(ref);
    return parsed === null ? null : kinds.get(parsed.localId) ?? null;
  };
  const owner = (): ReturnType<typeof createProfile> => {
    const p = createProfile('device-eq');
    grantDrops(p, [SKIN, TITLE], 'drop', 'seed', 1);
    return p;
  };

  it('equips an owned skin and an owned title, and \'\' unequips', () => {
    const p = owner();
    expect(equipVerdict(p, 'skin', SKIN, kindOf)).toEqual({ ok: true });
    expect(equipVerdict(p, 'title', TITLE, kindOf)).toEqual({ ok: true });
    applyEquip(p, new Map<EquipSlot, string>([['skin', SKIN], ['title', TITLE]]));
    expect(p.inventory.equippedSkin).toBe(SKIN);
    expect(p.inventory.title).toBe(TITLE);
    expect(equipVerdict(p, 'skin', '', kindOf)).toEqual({ ok: true });
    applyEquip(p, new Map<EquipSlot, string>([['skin', '']]));
    expect(p.inventory.equippedSkin).toBe('');
    expect(p.inventory.title).toBe(TITLE); // the untouched slot stays claimed
  });

  it('refuses junk, the unowned, the revoked, the unresolvable, and a kind mismatch', () => {
    const p = owner();
    expect(equipVerdict(p, 'skin', 'not-a-ref', kindOf).ok).toBe(false);
    expect(equipVerdict(p, 'skin', 'items@1:skin-never-owned', kindOf).ok).toBe(false);
    p.moderation.revokedItems.push({ ref: SKIN, ms: 2, reason: 'test' });
    expect(equipVerdict(p, 'skin', SKIN, kindOf).ok).toBe(false);
    const q = owner();
    grantDrops(q, ['items@9:skin-from-nowhere'], 'drop', 'seed', 1);
    expect(equipVerdict(q, 'skin', 'items@9:skin-from-nowhere', kindOf).ok).toBe(false);
    // A title claimed as a skin: the renderer would wear nothing forever.
    expect(equipVerdict(q, 'skin', TITLE, kindOf).ok).toBe(false);
    expect(equipVerdict(q, 'title', SKIN, kindOf).ok).toBe(false);
  });

  it('a dormant item may still be claimed — state is derived at read, not at equip', () => {
    // kindOf resolves it (the granting pack is installed) but the LIVE pack
    // may not define it; the claim stands and lights up if the pack returns.
    const p = owner();
    expect(equipVerdict(p, 'skin', SKIN, kindOf)).toEqual({ ok: true });
    expect(itemStateFor(SKIN, new Set<string>(), new Set<string>())).toBe('dormant');
    expect(itemStateFor(SKIN, new Set(['skin-rust-marine']), new Set<string>())).toBe('active');
  });
});

/* ------------------------------------------------------------------------ *
 * V4b — a weapon variant never DROPS
 * ------------------------------------------------------------------------ */

describe('rollMatchDrops and the V4b ownership token', () => {
  /*
   * Clause 19. `rollMatchDrops` skipped only TITLE and TROPHY, so the two
   * tokens `content/items.json` gains in V4b were droppable the moment they
   * were authored — and docs/VARIANTS.md §7.2 makes variants CRAFT-ONLY.
   *
   * The manifest here is the honest worst case: the only rows that are not
   * titles or trophies ARE the tokens. On the unfixed code every drop is a
   * variant; on the fixed code the roll has nothing to give and returns [].
   * (Against the real content manifest the effect is dilute — 79 of 902 drops
   * in 4000 seeded rounds — which is exactly why the test does not use it: a
   * denominator that hides the mechanism is the wrong denominator.)
   */
  const VARIANTS_ONLY = parseItemsManifest(JSON.stringify({
    items: [
      { id: 't1', kind: 'title', name: 'T', rarity: 'common', tradable: false, text: 'T' },
      {
        id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
        rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
      },
      {
        id: 'weapon_variant-rocket-swift', kind: 'weapon_variant', name: 'Swift Rocket',
        rarity: 'uncommon', tradable: true, variantId: 'rocket-swift',
      },
    ],
  })).manifest!;

  const seq = (...values: number[]): (() => number) => {
    let n = 0;
    return () => values[n++] ?? 0;
  };

  it('gives a manifest of nothing-but-variants nothing to drop', () => {
    // The chance roll PASSES (0 < DROP_CHANCE) and the rarity roll lands
    // squarely inside the uncommon bucket, so the only thing standing between
    // this and a minted variant is the kind exclusion.
    expect(rollMatchDrops(VARIANTS_ONLY, 1, seq(0, 0.6, 0.6))).toEqual([]);
    expect(rollMatchDrops(VARIANTS_ONLY, 1, seq(0, 0.6, 0.0))).toEqual([]);
    expect(rollMatchDrops(VARIANTS_ONLY, 1, seq(0, 0, 0))).toEqual([]);
  });

  it('never emits a weapon_variant ref over the whole reachable space', () => {
    // Sweeping rather than sampling: the assertion is about the SET of refs
    // the roll can ever return, which is what "supply is zero" means.
    const seen = new Set<string>();
    for (let a = 0; a < 100; a++) {
      for (let b = 0; b < 100; b++) {
        for (const ref of rollMatchDrops(VARIANTS_ONLY, 1, seq(0, a / 100, b / 100))) seen.add(ref);
      }
    }
    expect(seen.size, 'the sweep reached no drop at all — the lever is gone').toBe(0);

    // The same sweep over the REAL bundled manifest: plenty of drops, no
    // variant among them. Without this half the test above passes on an empty
    // manifest for the wrong reason.
    const bundled = parseItemsManifest(
      readFileSync(join(repoRoot, 'content', 'items.json'), 'utf8'),
    ).manifest!;
    expect(bundled.items.some((i) => i.kind === ItemKind.WEAPON_VARIANT)).toBe(true);
    const live = new Set<string>();
    for (let a = 0; a < 100; a++) {
      for (let b = 0; b < 100; b++) {
        for (const ref of rollMatchDrops(bundled, 1, seq(0, a / 100, b / 100))) live.add(ref);
      }
    }
    expect(live.size).toBeGreaterThan(3);
    expect([...live].filter((r) => r.includes('weapon_variant'))).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * V4b — variant SUPPLY cannot increase, at the one chokepoint
 * ------------------------------------------------------------------------ */

describe('grantDrops is where "no variant supply" is a fact rather than an argument', () => {
  /*
   * Three separate refusals — rollMatchDrops' kind skip, CRAFTABLE_KINDS and
   * quests.refs — were the whole case that V4b mints no variants, and a FOURTH
   * and FIFTH path walked past all of them: `ChallengeDef.item` (closed in
   * gate.ts) and competition `winnerItems`, which `createTournament` validates
   * with `parseItemRef` ALONE — pure syntax, no kind resolution at all — and
   * then hands to `grantDrops(..., 'prize', ...)` at finalisation.
   *
   * So the invariant lives at the chokepoint every one of them flows through,
   * and it is stated as MINT vs TRANSFER rather than as a blanket refusal:
   * variants are deliberately TRADABLE, so "no variant ref may be written"
   * would be the wrong rule and would break the only thing the token can do
   * in V4b.
   */
  const VARIANT = 'items@1:weapon_variant-shotgun-slug';
  const SKIN = 'items@1:skin-rust-marine';

  const inventoryAfter = (source: string): string[] => {
    const p = createProfile('device-mint-test', 1_000);
    grantDrops(p, [SKIN, VARIANT], source, 'src', 2_000);
    return p.inventory.items.map((i) => i.ref);
  };

  it('refuses a weapon variant from EVERY minting source, including one nobody has written yet', () => {
    // The four live mint sources, plus two that do not exist: the default has
    // to be the SAFE side or a sixth call site inherits the hole.
    for (const source of ['drop', 'challenge', 'prize', 'craft', 'grant', 'sponsor', '']) {
      expect(inventoryAfter(source), `source "${source}" minted a variant`).toEqual([SKIN]);
    }
  });

  it('still MOVES one on a transfer — the token is tradable and that is the point', () => {
    expect(inventoryAfter('trade')).toEqual([SKIN, VARIANT]);
  });

  it('names every grantDrops call site, so a sixth one cannot inherit the default silently', () => {
    /*
     * A SOURCE SCAN in trust.test.ts's style, and it is here because of the
     * shape of the miss it closes: competition prizes were a grant path nobody
     * had enumerated, and the argument "there is no other path" was made three
     * times without anyone counting. This counts.
     */
    const files = readdirSync(join(repoRoot, 'server', 'src'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const sources = new Set<string>();
    for (const f of files) {
      const src = readFileSync(join(repoRoot, 'server', 'src', f), 'utf8');
      for (const m of src.matchAll(/grantDrops\([\s\S]{0,200}?'([a-z]+)'/g)) sources.add(m[1]);
    }
    // 'drop' room.ts | 'challenge' persistence.ts | 'prize' competitions.ts
    // | 'craft' index.ts | 'trade' trades.ts. A new one here is a decision:
    // does it MINT (and must therefore refuse variants) or TRANSFER?
    expect([...sources].sort()).toEqual(['challenge', 'craft', 'drop', 'prize', 'trade']);
  });
});
