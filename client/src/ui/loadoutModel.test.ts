/**
 * DOOMCRAFT — the Loadout tab's decisions, proven off the DOM.
 *
 * The rules under test are the ones that cost money if they drift:
 * a non-ACTIVE item must never offer an equip action, duplicates must render
 * as ×N rather than vanish, the state must come from `itemStateFor` against
 * the LIVE pack, and no rendered string may ever say NaN.
 */

import { describe, expect, it } from 'vitest';

import {
  CRAFT_COPIES,
  CRAFT_FEES_BY_RARITY,
  buildLoadoutView,
  economyTabsFor,
  fallbackName,
  renderedLoadoutStrings,
  swatchCss,
  wireVariantClaims,
  type LoadoutInputs,
  type WireItemsPack,
  type WireVariantsPack,
} from '@/ui/loadoutModel';
import { ITEM_KIND_NAMES, ItemKind, parseItemsManifest } from '@shared/items';
import { readFileSync } from 'node:fs';

const RUST = 'items@1:skin-rust-marine';
const HAZARD = 'items@1:skin-void-hazard';
const TITLE = 'items@1:title-hangar-rat';
const GONE = 'items@1:trail-retired';

const PACK: WireItemsPack = {
  version: 1,
  items: parseItemsManifest(JSON.stringify({
    items: [
      { id: 'skin-rust-marine', kind: 'skin', name: 'Rust Marine', rarity: 'common', tradable: true, tint: [0.8, 0.4, 0.2] },
      { id: 'skin-void-hazard', kind: 'skin', name: 'Void Hazard', rarity: 'uncommon', tradable: true },
      { id: 'title-hangar-rat', kind: 'title', name: 'Hangar Rat', rarity: 'common', text: 'HANGAR RAT' },
    ],
  })).manifest!.items,
};

function inputsOf(patch: Partial<LoadoutInputs> = {}): LoadoutInputs {
  return {
    phase: 'ready',
    inventory: {
      items: [
        { ref: RUST, ms: 10, source: 'drop' },
        { ref: RUST, ms: 11, source: 'drop' },
        { ref: TITLE, ms: 12, source: 'prize' },
        { ref: GONE, ms: 13, source: 'drop' },
        { ref: HAZARD, ms: 14, source: 'drop' },
      ],
      equippedSkin: '',
      title: '',
      variants: {},
    },
    revoked: [HAZARD],
    scrap: 860,
    lifetimeScrap: 1200,
    pack: PACK,
    variants: null,
    reserved: {},
    scrapVisible: true,
    busyRef: '',
    ...patch,
  };
}

function rowFor(inputs: LoadoutInputs, ref: string) {
  for (const s of buildLoadoutView(inputs).sections) {
    for (const r of s.rows) if (r.ref === ref) return r;
  }
  return null;
}

describe('states and actions', () => {
  it('derives active/dormant/revoked from the LIVE pack, never from storage', () => {
    expect(rowFor(inputsOf(), RUST)?.state).toBe('active');
    expect(rowFor(inputsOf(), GONE)?.state).toBe('dormant');
    expect(rowFor(inputsOf(), HAZARD)?.state).toBe('revoked');
    // The same ref flips dormant when the pack stops defining it.
    const emptyPack = inputsOf({ pack: { version: 2, items: [] } });
    expect(rowFor(emptyPack, RUST)?.state).toBe('dormant');
  });

  it('never offers an equip action on a non-ACTIVE item', () => {
    expect(rowFor(inputsOf(), RUST)?.action).toBe('equip');
    expect(rowFor(inputsOf(), GONE)?.action).toBeNull();
    expect(rowFor(inputsOf(), HAZARD)?.action).toBeNull();
  });

  it('a title equips as a title, and non-slot kinds get no action at all', () => {
    const title = rowFor(inputsOf(), TITLE);
    expect(title?.slot).toBe('title');
    expect(title?.action).toBe('equip');
    expect(title?.note).toBe('HANGAR RAT');
    const gone = rowFor(inputsOf(), GONE);
    expect(gone?.slot).toBeNull(); // a trail has no claim slot in this stage
  });

  it('the equipped row says so and offers unequip — even after going dormant', () => {
    const equipped = inputsOf({ inventory: { ...inputsOf().inventory!, equippedSkin: RUST } });
    const row = rowFor(equipped, RUST);
    expect(row?.equipped).toBe(true);
    expect(row?.action).toBe('unequip');
    // The claim survives the pack dropping the item; unclaiming stays possible.
    const dormant = inputsOf({
      inventory: { ...inputsOf().inventory!, equippedSkin: RUST },
      pack: { version: 2, items: [] },
    });
    expect(rowFor(dormant, RUST)?.action).toBe('unequip');
  });

  it('an in-flight equip disables every action', () => {
    const busy = inputsOf({ busyRef: RUST });
    expect(rowFor(busy, RUST)?.action).toBeNull();
    expect(rowFor(busy, RUST)?.busy).toBe(true);
    expect(rowFor(busy, TITLE)?.action).toBeNull();
  });

  it('duplicates render as ×N on one row, never as dropped rows', () => {
    const row = rowFor(inputsOf(), RUST);
    expect(row?.copies).toBe(2);
    const refs = buildLoadoutView(inputsOf()).sections.flatMap((s) => s.rows.map((r) => r.ref));
    expect(new Set(refs).size).toBe(refs.length); // one row per distinct ref
    expect(refs).toContain(GONE); // owning it is enough to be shown
  });

  it('never renders a trade affordance — that is stage b, and titles never trade', () => {
    for (const s of renderedLoadoutStrings(buildLoadoutView(inputsOf()))) {
      expect(s.toLowerCase()).not.toContain('trade');
    }
  });
});

describe('the balance and the honest sentences', () => {
  it('shows the balance only when the caller decided the surfaces are on', () => {
    expect(buildLoadoutView(inputsOf()).balance).toEqual({ shown: true, scrap: '860', lifetime: '1,200' });
    expect(buildLoadoutView(inputsOf({ scrapVisible: false })).balance.shown).toBe(false);
    // Never on a phase that has no numbers to show.
    expect(buildLoadoutView(inputsOf({ phase: 'loading' })).balance.shown).toBe(false);
  });

  it('each phase says what is actually true', () => {
    expect(buildLoadoutView(inputsOf({ phase: 'loading' })).line).toContain('Loading');
    expect(buildLoadoutView(inputsOf({ phase: 'offline' })).line).toContain('No server');
    expect(buildLoadoutView(inputsOf({ phase: 'noProfile' })).line).toContain('finish an online match');
    const empty = inputsOf({ inventory: { items: [], equippedSkin: '', title: '', variants: {} } });
    expect(buildLoadoutView(empty).sections).toEqual([]);
    expect(buildLoadoutView(empty).line).toContain('No items yet');
  });

  it('no rendered string ever says NaN, Infinity or undefined', () => {
    const hostile = inputsOf({
      scrap: Number.NaN,
      lifetimeScrap: Number.POSITIVE_INFINITY,
      inventory: {
        items: [
          { ref: RUST, ms: Number.NaN, source: 'drop' },
          { ref: 'junk-not-a-ref', ms: 1, source: 'drop' },
          { ref: '', ms: 1, source: 'drop' },
          { ref: 'items@1:weapon_variant-shotgun-slug', ms: 2, source: 'grant' },
        ],
        equippedSkin: '',
        title: '',
        /* Junk keys: none of these is a canonical decimal weapon id, so none
         * may light Equipped on anything. */
        variants: { '01': RUST, '1.0': RUST, x: RUST } as unknown as Record<string, string>,
      },
      /* A hostile variants pack. `slot` is posted as a JSON KEY to /api/equip
       * and `variant:${base}` is built from THIS number, so a NaN, a fraction
       * or a missing field must not be able to become `variant:NaN`. */
      pack: {
        version: 1,
        items: parseItemsManifest(JSON.stringify({
          items: [{
            id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
            rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
          }],
        })).manifest!.items,
      },
      variants: {
        version: 1,
        variants: [
          { id: 'shotgun-slug', base: Number.NaN, name: 'Slug Shotgun' },
        ],
      },
    });
    for (const view of [buildLoadoutView(hostile), buildLoadoutView(inputsOf())]) {
      for (const s of renderedLoadoutStrings(view)) {
        expect(s).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });
});

describe('the tab strip decision', () => {
  it('grants each tab on its own flag alone, and nothing without them', () => {
    expect(economyTabsFor(null)).toEqual([]);
    expect(economyTabsFor({})).toEqual([]);
    expect(economyTabsFor({ economy_scrap: true })).toEqual([]);
    expect(economyTabsFor({ economy_items: true })).toEqual(['loadout']);
    expect(economyTabsFor({ economy_trading: true })).toEqual(['trade']);
    expect(economyTabsFor({ economy_competitions: true })).toEqual(['competitions']);
    expect(economyTabsFor({ economy_items: true, economy_trading: true, economy_competitions: true }))
      .toEqual(['loadout', 'trade', 'competitions']);
    expect(economyTabsFor({ economy_items: 'yes' as unknown as boolean })).toEqual([]);
  });
});

describe('the trade-up affordance', () => {
  const THREE_RUST = {
    items: [
      { ref: RUST, ms: 10, source: 'drop' },
      { ref: RUST, ms: 11, source: 'drop' },
      { ref: RUST, ms: 12, source: 'drop' },
    ],
    equippedSkin: '', title: '', variants: {},
  };

  it('offers targets only at 3+ copies, ACTIVE, craftable kind, one rarity up', () => {
    const three = inputsOf({ inventory: THREE_RUST });
    const targets = rowFor(three, RUST)?.craftTargets ?? [];
    // Rust Marine is a common skin; the pack's uncommon skin is Void Hazard.
    expect(targets.map((t) => t.localId)).toEqual(['skin-void-hazard']);
    expect(targets[0].fee).toBe(50);
    // Two copies: no affordance.
    const two = inputsOf({ inventory: { ...THREE_RUST, items: THREE_RUST.items.slice(0, 2) } });
    expect(rowFor(two, RUST)?.craftTargets).toEqual([]);
    // A title never crafts, whatever the copy count.
    const titles = inputsOf({
      inventory: { items: [1, 2, 3].map((i) => ({ ref: TITLE, ms: i, source: 'prize' })), equippedSkin: '', title: '', variants: {} },
    });
    expect(rowFor(titles, TITLE)?.craftTargets).toEqual([]);
    // Dormant source: no affordance even with copies.
    const dormant = inputsOf({ inventory: THREE_RUST, pack: { version: 2, items: [] } });
    expect(rowFor(dormant, RUST)?.craftTargets).toEqual([]);
  });

  it('mirrors the server constants — read from server/src/craft.ts, not assumed', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(here, '..', '..', '..', 'server', 'src', 'craft.ts'), 'utf8');
    expect(src).toContain(`export const CRAFT_COPIES = ${CRAFT_COPIES};`);
    for (const [rarity, fee] of Object.entries(CRAFT_FEES_BY_RARITY)) {
      // Each fee number must appear against the same rarity index in the
      // server table (the literal is keyed by ItemRarity enum member).
      expect(src, `fee ${fee} for rarity ${rarity}`).toMatch(new RegExp(`:\\s*${fee},`));
    }
  });
});

describe('helpers', () => {
  it('names a dormant ref from its id without the kind prefix', () => {
    expect(fallbackName('skin-rust-marine')).toBe('Rust Marine');
    expect(fallbackName('trail-retired')).toBe('Retired');
    expect(fallbackName('oddball')).toBe('Oddball');
  });

  it('renders a tint as css and refuses to invent one', () => {
    expect(swatchCss([1, 0.5, 0])).toBe('rgb(255,128,0)');
    expect(swatchCss(null)).toBe('');
    expect(swatchCss([9, 9, 9])).toBe('rgb(255,255,255)'); // clamped, not garbage
  });
});

/* ------------------------------------------------------------------------ *
 * V4b — an owned weapon-variant token has to be VISIBLE
 * ------------------------------------------------------------------------ */

describe('V4b: the Weapon Variants section', () => {
  /*
   * 15(f). KIND_ORDER is the ONLY thing that builds sections, so a kind
   * missing from it is not merely unsorted — the row is DROPPED and the player
   * owns an item the tab renders nothing for. Measured before the fix with a
   * single owned token: `sections = 0, rows = 0`.
   *
   * The DORMANT direction is the one that matters, because it is the one that
   * cannot be repaired by the pack: with no def to read a kind from,
   * `guessKind` splits the localId on '-' and looks the head up in
   * ITEM_KIND_NAMES, which is why the id has to be `weapon_variant-<row>`.
   * Get that wrong and the token renders under "Skins".
   */
  const VARIANT_PACK: WireItemsPack = {
    version: 1,
    items: parseItemsManifest(JSON.stringify({
      items: [{
        id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
        rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
      }],
    })).manifest!.items,
  };
  const OWNED = 'items@1:weapon_variant-shotgun-slug';

  it('renders an ACTIVE token under Weapon Variants, with no equip action in V4b', () => {
    const v = buildLoadoutView(inputsOf({
      pack: VARIANT_PACK,
      revoked: [],
      inventory: { items: [{ ref: OWNED, ms: 1, source: 'grant' }], equippedSkin: '', title: '', variants: {} },
    }));
    const titles = v.sections.map((s) => s.title);
    expect(titles).toContain('Weapon Variants');
    const row = v.sections.find((s) => s.title === 'Weapon Variants')!.rows[0];
    expect(row.name).toBe('Slug Shotgun');
    expect(row.state).toBe('active');
    expect(row.kindLabel).toBe('weapon_variant');
    /* No slot, because this case hands the model NO variants pack at all
     * (`inputsOf` defaults `variants: null`). From V4f the slot exists, but it
     * is `variant:<base weapon>` and the base lives in the VARIANTS pack — so
     * with nothing to resolve `shotgun-slug` against, the honest answer is
     * still no action rather than a guessed one. The V4f block below is where
     * the map is present and the button appears. */
    expect(row.slot).toBeNull();
    expect(row.action).toBeNull();
    // And no craft target — CRAFTABLE_KINDS does not carry the kind.
    expect(row.craftTargets).toEqual([]);
  });

  it('renders a DORMANT token under Weapon Variants and NOT under Skins', () => {
    const v = buildLoadoutView(inputsOf({
      pack: { version: 2, items: [] },
      revoked: [],
      inventory: { items: [{ ref: OWNED, ms: 1, source: 'grant' }], equippedSkin: '', title: '', variants: {} },
    }));
    expect(v.sections.map((s) => s.title)).toEqual(['Weapon Variants']);
    const row = v.sections[0].rows[0];
    expect(row.state).toBe('dormant');
    expect(row.name).toBe('Shotgun Slug');
    expect(v.sections.some((s) => s.title === 'Skins')).toBe(false);
  });

  it('every ItemKind has a section, so the next kind cannot vanish the way this one would have', () => {
    // The ratchet the measurement above earned. A kind absent from KIND_ORDER
    // renders in NO section; asserting the list is complete is cheaper than
    // rediscovering that per kind.
    const kinds = Object.values(ItemKind).filter((v): v is ItemKind => typeof v === 'number');
    for (const kind of kinds) {
      const localId = `${ITEM_KIND_NAMES[kind]}-thing`;
      const v = buildLoadoutView(inputsOf({
        pack: { version: 9, items: [] },
        revoked: [],
        inventory: {
          items: [{ ref: `items@1:${localId}`, ms: 1, source: 'grant' }],
          equippedSkin: '', title: '', variants: {},
        },
      }));
      expect(v.sections.length, `kind ${kind} (${ITEM_KIND_NAMES[kind]}) renders in no section`).toBe(1);
      expect(v.sections[0].title, `kind ${kind}`).not.toBe('Items');
    }
  });
});

/* ------------------------------------------------------------------------ *
 * V4f — THE EQUIP BUTTON. A player can craft a variant token (V4e) and could
 * not equip it: V4c landed only the server half of the slot.
 *
 * Every case below names the input on which the DEFECTIVE and the CORRECT
 * implementations produce DIFFERENT values (§0 rule 38), because the obvious
 * input for two of them does not discriminate at all — see each test.
 * ------------------------------------------------------------------------ */

describe('V4f: a weapon-variant token gets the slot its BASE WEAPON names', () => {
  /** Both bundled tokens, so a wrong-base defect has somewhere to land. */
  const VARIANT_PACK: WireItemsPack = {
    version: 1,
    items: parseItemsManifest(JSON.stringify({
      items: [
        {
          id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
          rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
        },
        {
          id: 'weapon_variant-rocket-swift', kind: 'weapon_variant', name: 'Swift Rocket',
          rarity: 'uncommon', tradable: true, variantId: 'rocket-swift',
        },
      ],
    })).manifest!.items,
  };

  /** `GET /api/variants` as the bundled pack answers it: base 1 and base 3. */
  const VARIANTS: WireVariantsPack = {
    version: 1,
    variants: [
      { id: 'shotgun-slug', base: 1, name: 'Slug Shotgun' },
      { id: 'rocket-swift', base: 3, name: 'Swift Rocket' },
    ],
  };

  const SLUG = 'items@1:weapon_variant-shotgun-slug';
  const SLUG_V2 = 'items@2:weapon_variant-shotgun-slug';
  const SWIFT = 'items@1:weapon_variant-rocket-swift';

  function variantInputs(patch: Partial<LoadoutInputs> = {}): LoadoutInputs {
    return inputsOf({
      pack: VARIANT_PACK,
      variants: VARIANTS,
      revoked: [],
      inventory: {
        items: [{ ref: SLUG, ms: 1, source: 'grant' }],
        equippedSkin: '', title: '', variants: {},
      },
      ...patch,
    });
  }

  it('(a) an owned Slug Shotgun offers Equip into variant:1 — the SLOT STRING, not merely an action', () => {
    /*
     * DISCRIMINATION. Asserting only "an action exists" passes on a build that
     * puts a constant in SLOT_FOR_KIND: `variant:0` produces an enabled button
     * too, and `equipVerdict` answers it "that variant is for weapon 1, not
     * weapon 0". The slot STRING is what separates the two.
     * Defective (V4e, no client half): slot null, action null.
     * Defective (a kind constant):     slot 'variant:0', action 'equip'.
     */
    const row = rowFor(variantInputs(), SLUG);
    expect(row).not.toBeNull();
    expect(row?.slot).toBe('variant:1');
    expect(row?.action).toBe('equip');
    // And the OTHER bundled token is a different gun, from the same map.
    const both = variantInputs({
      inventory: {
        items: [{ ref: SLUG, ms: 1, source: 'grant' }, { ref: SWIFT, ms: 2, source: 'grant' }],
        equippedSkin: '', title: '', variants: {},
      },
    });
    expect(rowFor(both, SWIFT)?.slot).toBe('variant:3');
  });

  it('(b) an ACTIVE token the variants pack does not name renders, with NO action', () => {
    /*
     * DISCRIMINATION, and the obvious input fails it. A DORMANT unmapped token
     * gives `action === null` in BOTH implementations, because `state !==
     * 'active'` already suppresses the action — so the row proves nothing
     * about the map lookup. This token is ACTIVE (the items pack defines it)
     * and its `variantId` is absent from the variants map, which is a real
     * state: an items pack shipped against a variants pack that has since been
     * re-cut. `equipVerdict` answers "no installed variants pack defines this
     * variant", so an enabled button here is a 400 the player did not ask for.
     * Correct:   slot null, action null, ROW PRESENT.
     * Defective (no guard on the lookup): slot 'variant:undefined',
     *   action 'equip' — a button that posts a slot routing to nothing.
     */
    const noSwift: WireVariantsPack = {
      version: 2,
      variants: [{ id: 'shotgun-slug', base: 1, name: 'Slug Shotgun' }],
    };
    const v = buildLoadoutView(variantInputs({
      variants: noSwift,
      inventory: {
        items: [{ ref: SWIFT, ms: 1, source: 'grant' }],
        equippedSkin: '', title: '', variants: {},
      },
    }));
    const row = v.sections.flatMap((sec) => sec.rows).find((r) => r.ref === SWIFT);
    // PRESENT — hiding an owned item reads as loss, so this is not a row count.
    expect(row, 'the row vanished; an owned item must always render').toBeDefined();
    expect(row?.state).toBe('active');
    expect(row?.slot).toBeNull();
    expect(row?.action).toBeNull();
    // The mapped token in the same view still gets its button, so the whole
    // map did not simply fail to load.
    expect(rowFor(variantInputs({ variants: noSwift }), SLUG)?.slot).toBe('variant:1');
  });

  it('(clause 7) a DORMANT token still renders and still offers nothing', () => {
    const v = buildLoadoutView(variantInputs({ pack: { version: 9, items: [] } }));
    const row = v.sections.flatMap((sec) => sec.rows).find((r) => r.ref === SLUG);
    expect(row?.state).toBe('dormant');
    expect(row?.slot).toBeNull();
    expect(row?.action).toBeNull();
  });

  it('(d) Equipped lights for the stored REF alone, not for every copy of the variant', () => {
    /*
     * DISCRIMINATION, and the obvious input fails it. "Two copies, one
     * equipped" does NOT work: `buildLoadoutView` dedups by ref, so two copies
     * of `items@1:…-shotgun-slug` collapse into ONE row with `copies: 2`, and a
     * defective localId comparison and the correct ref comparison both answer
     * `[true]`. Two DISTINCT VERSIONED REFS of the same variant are two rows —
     * a real state, since a re-cut items pack mints `items@2:` refs while the
     * old ones stay owned and active — and `applyEquip` stores exactly one of
     * them.
     * Correct:   [false, true] — only the ref in `inventory.variants['1']`.
     * Defective (compare by localId or by variantId): [true, true], and the
     *   player is shown two guns equipped in one slot.
     */
    const v = buildLoadoutView(variantInputs({
      inventory: {
        items: [{ ref: SLUG, ms: 1, source: 'grant' }, { ref: SLUG_V2, ms: 2, source: 'craft' }],
        equippedSkin: '', title: '',
        variants: { 1: SLUG_V2 },
      },
    }));
    const rows = v.sections.flatMap((sec) => sec.rows).filter((r) => r.ref === SLUG || r.ref === SLUG_V2);
    expect(rows.map((r) => r.ref)).toEqual([SLUG, SLUG_V2]);
    expect(rows.map((r) => r.equipped)).toEqual([false, true]);
    // And the actions follow: one to claim, one to release (clause 6).
    expect(rows.map((r) => r.action)).toEqual(['equip', 'unequip']);
    expect(rows.map((r) => r.slot)).toEqual(['variant:1', 'variant:1']);
  });

  it('a claim under a NON-canonical key equips nothing — `01` is not slot 1', () => {
    /*
     * `variantSlotWeaponId` refuses `variant:01`, and `sanitiseVariantClaims`
     * refuses the key, so a profile that somehow carries one names no slot.
     * Reading it as slot 1 would show Equipped on an item the game will not
     * wear — the "told yes, given nothing" failure this repo ranks worst.
     */
    const v = buildLoadoutView(variantInputs({
      inventory: {
        items: [{ ref: SLUG, ms: 1, source: 'grant' }],
        equippedSkin: '', title: '',
        variants: { '01': SLUG } as unknown as Record<string, string>,
      },
    }));
    const row = v.sections.flatMap((sec) => sec.rows).find((r) => r.ref === SLUG);
    expect(row?.equipped).toBe(false);
    expect(row?.action).toBe('equip');
  });

  it('SLOT_FOR_KIND carries no entry for WEAPON_VARIANT — the slot is the ITEM’s, not the kind’s', () => {
    /*
     * Clause 4, asserted as SOURCE because the table is module-private. Two
     * variant tokens with two different bases in one view is the behavioural
     * half: a kind-keyed constant cannot produce two different slots.
     */
    const both = variantInputs({
      inventory: {
        items: [{ ref: SLUG, ms: 1, source: 'grant' }, { ref: SWIFT, ms: 2, source: 'grant' }],
        equippedSkin: '', title: '', variants: {},
      },
    });
    const rows = buildLoadoutView(both).sections.flatMap((sec) => sec.rows);
    const slots = rows.filter((r) => r.kindLabel === 'weapon_variant').map((r) => r.slot).sort();
    expect(slots).toEqual(['variant:1', 'variant:3']);
    const src = readFileSync(new URL('./loadoutModel.ts', import.meta.url), 'utf8');
    const table = /const SLOT_FOR_KIND[^;]*;/s.exec(src)?.[0] ?? '';
    expect(table, 'SLOT_FOR_KIND not found — the assertion below would be vacuous').toContain('ItemKind.SKIN');
    expect(table).not.toContain('WEAPON_VARIANT');
  });
});

/* ------------------------------------------------------------------------ *
 * V4f — the two doors that carry the claim map, and the tab's use of them
 * ------------------------------------------------------------------------ */

describe('V4f: the claim map survives BOTH server answers', () => {
  it('wireVariantClaims keeps string values and refuses everything else', () => {
    expect(wireVariantClaims({ 1: 'items@1:weapon_variant-shotgun-slug' }))
      .toEqual({ 1: 'items@1:weapon_variant-shotgun-slug' });
    // Absent, null and non-objects are an empty map, never a throw: this runs
    // on whatever a server (or a proxy) actually answered.
    expect(wireVariantClaims(undefined)).toEqual({});
    expect(wireVariantClaims(null)).toEqual({});
    expect(wireVariantClaims('nope')).toEqual({});
    expect(wireVariantClaims([1, 2])).toEqual({});
    // A non-string value is dropped rather than coerced — `'3'` as a slot ref
    // would be a claim on an item that cannot exist.
    expect(wireVariantClaims({ 1: 3, 2: null, 3: 'items@1:x' })).toEqual({ 3: 'items@1:x' });
  });

  it('loadoutTab decodes it on BOTH the profile read and the equip answer', () => {
    /*
     * A SOURCE ratchet, in `wiring.test.ts`'s idiom, and it is here because the
     * failure it guards is a WIRING failure that no model test can see: the
     * model was correct and the tab handed it `{}`.
     *
     * Two distinct bugs, one per call site, both live on the tree V4f started
     * from. `fetchProfile` built its `WireInventory` from `equippedSkin` and
     * `title` only, so `inventory.variants` was always empty and no variant row
     * could EVER read as Equipped. And the 200 branch of `equip()` rebuilt the
     * inventory from `equippedSkin` and `title` only, so a SUCCESSFUL variant
     * equip repainted from the stale claims it had just replaced and the button
     * flipped back to "Equip" until the next full refresh — while the server
     * had stored the claim. `POST /api/equip` has answered with the whole map
     * since V4c; only this side was throwing it away.
     */
    const src = readFileSync(new URL('./loadoutTab.ts', import.meta.url), 'utf8');
    const profileDecode = /private async fetchProfile[\s\S]*?\n  \}/.exec(src)?.[0] ?? '';
    expect(profileDecode, 'fetchProfile not found — the assertion below would be vacuous')
      .toContain('equippedSkin');
    expect(profileDecode).toContain('wireVariantClaims(');

    const equipSend = /private async equip[\s\S]*?\n  \}/.exec(src)?.[0] ?? '';
    expect(equipSend, 'equip() not found — the assertion below would be vacuous')
      .toContain('/api/equip');
    expect(equipSend).toContain('wireVariantClaims(');

    // And the tab actually asks the server for the variants pack at all.
    expect(src).toContain('/api/variants');
    expect(src).toContain('variants: this.variants');
  });
});
