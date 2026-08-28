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
  buildLoadoutView,
  economyTabsFor,
  fallbackName,
  renderedLoadoutStrings,
  swatchCss,
  type LoadoutInputs,
  type WireItemsPack,
} from '@/ui/loadoutModel';
import { parseItemsManifest } from '@shared/items';

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
    },
    revoked: [HAZARD],
    scrap: 860,
    lifetimeScrap: 1200,
    pack: PACK,
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
    const empty = inputsOf({ inventory: { items: [], equippedSkin: '', title: '' } });
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
        ],
        equippedSkin: '',
        title: '',
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
  it('grants the loadout tab on economy_items alone, and nothing without it', () => {
    expect(economyTabsFor(null)).toEqual([]);
    expect(economyTabsFor({})).toEqual([]);
    expect(economyTabsFor({ economy_scrap: true })).toEqual([]);
    expect(economyTabsFor({ economy_items: true })).toEqual(['loadout']);
    expect(economyTabsFor({ economy_items: 'yes' as unknown as boolean })).toEqual([]);
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
