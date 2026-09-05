/**
 * DOOMCRAFT V4f — the equip door's TWO DOORS must accept the same set.
 *
 * `equipVerdict` (server) decides which slot an owned ref may be claimed into;
 * `buildLoadoutView` (client, `loadoutModel.ts`) decides which Equip button the
 * Loadout tab OFFERS. Two implementations, two languages, one rule. §0 rule 29:
 * "each one refuses bad input" is not a proof that they agree — and V4c shipped
 * the server half of the variant slot ALONE, so for the whole of V4c-V4e the
 * two doors disagreed on every weapon-variant token in the game.
 *
 * WHY THE COMPARISON IS OVER (ref, slot) PAIRS AND NOT OVER A SLOT SET.
 * A set of slot NAMES does not discriminate. Consider a build that swaps the
 * two bundled tokens — the Slug Shotgun offered as `variant:3` and the Swift
 * Rocket as `variant:1`. The global set of offered slots is
 * `{skin, title, variant:1, variant:3}` either way, so set equality passes AND
 * both by-name membership checks pass, while `POST /api/equip` answers the
 * first click **400 "that variant is for weapon 1, not weapon 3"**. The pair is
 * what carries the information. Membership of `variant:1` and `variant:3` by
 * name is kept alongside it, because a global set equality DOES still catch the
 * V4e state this phase fixes, where the tab offered no variant slot at all and
 * both sides would otherwise have been compared as empty.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseItemsManifest, type ItemDef, type ItemKind } from '@doomcraft/shared/items';
import { parseVariantsManifest, type VariantDef } from '@doomcraft/shared/variants';
import { WEAPON_COUNT } from '@doomcraft/shared/weapons';

import {
  createProfile, equipVerdict, grantDrops, type EquipSlot, type StoredProfile,
} from './persistence.js';

/*
 * THE CLIENT MODEL, LOADED AT RUNTIME — `craftAgreement.test.ts`'s device and
 * its reasoning: `client/` and `server/` are separate composite TS projects
 * with disjoint rootDirs, so a static cross-import fails `tsc -b` by design,
 * and a COPY of the model would defeat the entire point of this file. The
 * negative control below is what stops a wrong path from making every equality
 * here pass over two empty sets.
 */
const CLIENT_MODEL = '../../client/src/ui/loadoutModel.ts';

interface ClientInputs {
  phase: 'ready';
  inventory: {
    items: Array<{ ref: string; ms: number; source: string }>;
    equippedSkin: string;
    title: string;
    variants: Record<string, string>;
  };
  revoked: string[];
  scrap: number;
  lifetimeScrap: number;
  pack: { version: number; items: readonly ItemDef[] };
  variants: { version: number; variants: Array<{ id: string; base: number; name: string }> };
  reserved: Record<string, number>;
  scrapVisible: boolean;
  busyRef: string;
}
interface ClientView {
  sections: Array<{ rows: Array<{ ref: string; slot: string | null; action: string | null }> }>;
}
type BuildLoadoutView = (inputs: ClientInputs) => ClientView;

let buildLoadoutView: BuildLoadoutView;
beforeAll(async () => {
  const mod = await import(CLIENT_MODEL) as { buildLoadoutView?: unknown };
  if (typeof mod.buildLoadoutView !== 'function') {
    throw new Error(`${CLIENT_MODEL} exported no buildLoadoutView — the agreement test would prove nothing`);
  }
  buildLoadoutView = mod.buildLoadoutView as BuildLoadoutView;
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** THE REAL BUNDLED PACKS — not fixtures. The two doors must agree on ships. */
const ITEMS = parseItemsManifest(readFileSync(join(repoRoot, 'content', 'items.json'), 'utf8')).manifest!;
const VARIANTS = parseVariantsManifest(readFileSync(join(repoRoot, 'content', 'variants.json'), 'utf8')).manifest!;
const DEFS: ReadonlyMap<string, ItemDef> = new Map(ITEMS.items.map((i) => [i.id, i]));
const VARIANT_DEFS: ReadonlyMap<string, VariantDef> = new Map(VARIANTS.variants.map((v) => [v.id, v]));

const PACK = { version: 1, items: ITEMS.items };
/** `GET /api/variants`'s body, built from the same manifest the route reads. */
const WIRE_VARIANTS = {
  version: 1,
  variants: VARIANTS.variants.map((v) => ({ id: v.id, base: v.base, name: v.name })),
};

const SLUG = 'items@1:weapon_variant-shotgun-slug';
const SWIFT = 'items@1:weapon_variant-rocket-swift';
const RUST = 'items@1:skin-rust-marine';
const HANGAR = 'items@1:title-hangar-rat';
const IMP = 'items@1:emblem-imp-skull';
const TROPHY = 'items@1:trophy-first-season';

/** Everything a player could own here, in one profile. */
const OWNED: readonly string[] = [SLUG, SWIFT, RUST, HANGAR, IMP, TROPHY];

/** Every slot `POST /api/equip` will even look at (server/src/index.ts). */
const ALL_SLOTS: readonly EquipSlot[] = [
  'skin', 'title',
  ...Array.from({ length: WEAPON_COUNT }, (_, w) => `variant:${w}` as EquipSlot),
];

/*
 * The route's two resolvers, restated. They are five lines of pack lookup in
 * `server/src/index.ts` and importing them is not possible (they close over the
 * process-wide `releases`/`inventory`); the RULE under test is `equipVerdict`,
 * which is the real thing, and both resolvers here read the real bundled packs.
 */
const kindOf = (ref: string): ItemKind | null => {
  const localId = /^items@\d+:(.+)$/.exec(ref)?.[1] ?? '';
  return DEFS.get(localId)?.kind ?? null;
};
const variantBaseOf = (ref: string): number | null => {
  const localId = /^items@\d+:(.+)$/.exec(ref)?.[1] ?? '';
  const def = DEFS.get(localId);
  if (def === undefined || def.variantId === '') return null;
  return VARIANT_DEFS.get(def.variantId)?.base ?? null;
};

function seededProfile(): StoredProfile {
  const p = createProfile('device-equip-agreement');
  /*
   * SEEDED THROUGH 'trade', not 'drop': `grantDrops` refuses to MINT a weapon
   * variant, so a 'drop' seed would leave the profile holding ZERO tokens and
   * every set below would agree over nothing (§0 rule 22 / rule 2).
   */
  OWNED.forEach((ref, i) => { grantDrops(p, [ref], 'trade', `seed-${i}`, 1_000 + i); });
  for (const ref of OWNED) {
    if (!p.inventory.items.some((i) => i.ref === ref)) {
      throw new Error(`fixture never granted ${ref}; the agreement would be over an empty set`);
    }
  }
  return p;
}

/** Every (ref, slot) the SERVER would accept, sorted. Unequip is excluded. */
function serverAccepts(profile: StoredProfile): string[] {
  const out: string[] = [];
  for (const ref of OWNED) {
    for (const slot of ALL_SLOTS) {
      if (equipVerdict(profile, slot, ref, kindOf, variantBaseOf).ok) out.push(`${ref} -> ${slot}`);
    }
  }
  return out.sort();
}

function inputsFor(profile: StoredProfile): ClientInputs {
  return {
    phase: 'ready',
    inventory: {
      items: profile.inventory.items.map((i) => ({ ref: i.ref, ms: i.ms, source: i.source })),
      equippedSkin: profile.inventory.equippedSkin,
      title: profile.inventory.title,
      variants: { ...profile.inventory.variants },
    },
    revoked: profile.moderation.revokedItems.map((r) => r.ref),
    scrap: profile.economy.scrap,
    lifetimeScrap: profile.economy.lifetimeScrap,
    pack: PACK,
    variants: WIRE_VARIANTS,
    reserved: {},
    scrapVisible: true,
    busyRef: '',
  };
}

/** Every (ref, slot) the TAB would offer, sorted. */
function uiOffers(profile: StoredProfile): string[] {
  return buildLoadoutView(inputsFor(profile)).sections
    .flatMap((sec) => sec.rows)
    .filter((r) => r.action !== null && r.slot !== null)
    .map((r) => `${r.ref} -> ${r.slot ?? ''}`)
    .sort();
}

describe('V4f: the tab offers exactly the slots the equip door accepts', () => {
  it('the client module really loaded — the negative control for every set below', () => {
    expect(typeof buildLoadoutView).toBe('function');
    const rows = buildLoadoutView(inputsFor(seededProfile())).sections.flatMap((s) => s.rows);
    expect(rows.map((r) => r.ref).sort()).toEqual([...OWNED].sort());
  });

  it('(e) agrees pair for pair over the whole bundled pack', () => {
    const p = seededProfile();
    expect(uiOffers(p)).toEqual(serverAccepts(p));
  });

  it('and the agreed set actually CONTAINS variant:1 and variant:3, on the RIGHT tokens', () => {
    /*
     * The equality above is satisfied by two empty sets — which is precisely
     * the state this phase ends, where the tab offered no variant slot at all.
     * These are the memberships that make it non-vacuous, and they are pairs
     * for the reason in this file's header: the slot NAMES alone are identical
     * under a swap that the server refuses with a 400.
     */
    const accepted = serverAccepts(seededProfile());
    expect(accepted).toContain(`${SLUG} -> variant:1`);
    expect(accepted).toContain(`${SWIFT} -> variant:3`);
    expect(accepted).not.toContain(`${SLUG} -> variant:3`);
    expect(accepted).not.toContain(`${SWIFT} -> variant:1`);
    const offered = uiOffers(seededProfile());
    expect(offered).toContain(`${SLUG} -> variant:1`);
    expect(offered).toContain(`${SWIFT} -> variant:3`);
    expect(offered).not.toContain(`${SLUG} -> variant:3`);
    expect(offered).not.toContain(`${SWIFT} -> variant:1`);
    // A cosmetic never reaches a weapon slot on either side.
    expect(accepted).toContain(`${RUST} -> skin`);
    expect(accepted).toContain(`${HANGAR} -> title`);
    for (let w = 0; w < WEAPON_COUNT; w++) {
      expect(accepted).not.toContain(`${RUST} -> variant:${w}`);
      expect(offered).not.toContain(`${RUST} -> variant:${w}`);
    }
    // Emblems and trophies have no slot in this stage, on either side.
    expect(accepted.some((row) => row.startsWith(IMP))).toBe(false);
    expect(offered.some((row) => row.startsWith(IMP))).toBe(false);
    expect(offered.some((row) => row.startsWith(TROPHY))).toBe(false);
  });

  it('agrees once a variant is EQUIPPED: the row flips to unequip on the same slot', () => {
    /*
     * `applyEquip` stores the ref under `String(base)`; the tab reads it back
     * and offers Unequip on the same slot. Both are still a claim on
     * `variant:1`, so the pair sets must still match.
     */
    const p = seededProfile();
    p.inventory.variants['1'] = SLUG;
    expect(uiOffers(p)).toEqual(serverAccepts(p));
    const rows = buildLoadoutView(inputsFor(p)).sections.flatMap((s) => s.rows);
    const slug = rows.find((r) => r.ref === SLUG);
    expect(slug?.action).toBe('unequip');
    expect(slug?.slot).toBe('variant:1');
  });

  it('agrees when a token is REVOKED — the tab drops the button the server would refuse', () => {
    const p = seededProfile();
    p.moderation.revokedItems.push({ ref: SLUG, ms: 2_000, reason: 'test' });
    expect(equipVerdict(p, 'variant:1', SLUG, kindOf, variantBaseOf).ok).toBe(false);
    expect(uiOffers(p)).toEqual(serverAccepts(p));
    expect(uiOffers(p)).not.toContain(`${SLUG} -> variant:1`);
    // The rocket is untouched, so this is not "both sets went empty".
    expect(uiOffers(p)).toContain(`${SWIFT} -> variant:3`);
  });

  it('agrees when the items pack goes DORMANT on the token', () => {
    /*
     * A live items pack that no longer defines the token: `kindOf` answers
     * null and the server refuses "no installed pack defines this item", while
     * `itemStateFor` makes the row dormant and the tab offers nothing. The
     * item still RENDERS — hiding it would read as loss — which is why this is
     * an agreement about ACTIONS and not about rows.
     */
    const p = seededProfile();
    const thinPack = { version: 2, items: ITEMS.items.filter((i) => i.variantId === '') };
    const inputs = { ...inputsFor(p), pack: thinPack };
    const rows = buildLoadoutView(inputs).sections.flatMap((s) => s.rows);
    expect(rows.map((r) => r.ref)).toContain(SLUG);
    expect(rows.find((r) => r.ref === SLUG)?.action).toBeNull();
    expect(rows.find((r) => r.ref === SLUG)?.slot).toBeNull();
    const thinDefs = new Map(thinPack.items.map((i) => [i.id, i]));
    const thinKindOf = (ref: string): ItemKind | null =>
      thinDefs.get(/^items@\d+:(.+)$/.exec(ref)?.[1] ?? '')?.kind ?? null;
    expect(equipVerdict(p, 'variant:1', SLUG, thinKindOf, variantBaseOf).ok).toBe(false);
  });
});
