/**
 * DOOMCRAFT — the Loadout tab, decided here. No DOM in this file.
 *
 * Same split as `profileModel.ts` and for the same reason: vitest runs under
 * `environment: 'node'`, so every line that decides WHAT the tab says lives
 * here and is tested, and `loadoutTab.ts` only decides where the strings land.
 *
 * THE OWNERSHIP RULE, RENDERED (shared/src/items.ts, docs/PACKS.md §7):
 * an owned ref's state is DERIVED at read time through `itemStateFor` against
 * the LIVE items pack — never stored, never guessed. This model refuses to
 * offer an equip action on anything that is not ACTIVE, refuses to name a
 * trade affordance at all (that is stage b), and renders duplicates as ×N
 * because crafting eats them — a dropped row would read as a lost item.
 *
 * Every rendered string is laundered: no `NaN`, `Infinity` or `undefined` may
 * appear anywhere in a `LoadoutView`, and the test proves it over the whole
 * rendered set exactly as `profileModel.test.ts` does.
 */

import {
  ITEM_KIND_NAMES,
  ITEM_RARITY_NAMES,
  ItemKind,
  itemStateFor,
  parseItemRef,
  type ItemDef,
  type ItemState,
} from '@shared/items';

/* ------------------------------------------------------------------------ *
 * Wire shapes — the half of the server's answers this tab reads
 * ------------------------------------------------------------------------ */

/** One owned copy as `GET /api/profile` serialises it. */
export interface WireOwnedItem {
  readonly ref: string;
  readonly ms: number;
  readonly source: string;
}

export interface WireInventory {
  readonly items: readonly WireOwnedItem[];
  readonly equippedSkin: string;
  readonly title: string;
}

/** `GET /api/items` — the live pack. PUBLIC and unflagged. */
export interface WireItemsPack {
  readonly version: number;
  readonly items: readonly ItemDef[];
}

/**
 * What the tab knows when it builds a view. `phase` is honest about why data
 * is missing: 'loading' (fetches in flight), 'offline' (no server answered),
 * 'noProfile' (404 — a player who never finished an online match, which is a
 * NORMAL state, not an error), 'ready'.
 */
export interface LoadoutInputs {
  readonly phase: 'loading' | 'offline' | 'noProfile' | 'ready';
  readonly inventory: WireInventory | null;
  /** `moderation.revokedItems[].ref` off the same profile answer. */
  readonly revoked: readonly string[];
  readonly scrap: number;
  readonly lifetimeScrap: number;
  readonly pack: WireItemsPack | null;
  /** `economySurfacesOn(product, probe)` — decided by the caller, once. */
  readonly scrapVisible: boolean;
  /** The ref a POST /api/equip is in flight for, or ''. Disables actions. */
  readonly busyRef: string;
}

/* ------------------------------------------------------------------------ *
 * Rendered shapes
 * ------------------------------------------------------------------------ */

export type LoadoutSlot = 'skin' | 'title';

export interface LoadoutRow {
  readonly ref: string;
  readonly name: string;
  readonly kindLabel: string;
  readonly rarityLabel: string;
  readonly state: ItemState;
  /** Owned copies of this exact ref. ×N is meaningful — crafting eats them. */
  readonly copies: number;
  readonly equipped: boolean;
  /** Which claim slot this row can occupy, or null (emblems, trails, trophies). */
  readonly slot: LoadoutSlot | null;
  /** 'equip' | 'unequip' | null. Never offered on a non-ACTIVE item. */
  readonly action: 'equip' | 'unequip' | null;
  readonly busy: boolean;
  /** CSS colour for the swatch, or ''. Skins/trails only. */
  readonly swatch: string;
  /** 'not in the current items pack' | 'revoked' | title text | ''. */
  readonly note: string;
}

export interface LoadoutSection {
  readonly title: string;
  readonly rows: readonly LoadoutRow[];
}

export interface LoadoutView {
  /** The one-line status over the list. NEVER empty when sections are. */
  readonly line: string;
  readonly balance: { readonly shown: boolean; readonly scrap: string; readonly lifetime: string };
  readonly sections: readonly LoadoutSection[];
}

/* ------------------------------------------------------------------------ *
 * Laundering — same contract as profileModel.safeInt, restated locally so
 * this module needs nothing from a file it would drag into the lazy chunk.
 * ------------------------------------------------------------------------ */

function safeCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(n)));
}

function groupInt(v: unknown): string {
  const digits = safeCount(v).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/** `skin-rust-marine` -> `Rust Marine` when the live pack cannot name it. */
export function fallbackName(localId: string): string {
  const parts = localId.split('-').filter((p) => p.length > 0);
  const rest = parts[0] !== undefined && (ITEM_KIND_NAMES as readonly string[]).includes(parts[0])
    ? parts.slice(1) : parts;
  const words = rest.length > 0 ? rest : parts;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Multiplicative tint (0..4 per channel) to a display colour, or ''. */
export function swatchCss(tint: readonly [number, number, number] | null | undefined): string {
  if (tint === null || tint === undefined) return '';
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${ch(tint[0])},${ch(tint[1])},${ch(tint[2])})`;
}

/* ------------------------------------------------------------------------ *
 * Which economy tabs exist at all — decided from the /api/flags probe
 * ------------------------------------------------------------------------ */

export type EconomyTabId = 'loadout';

/**
 * The menu-time truth: on the menu `game.net.flagBits` comes from the local
 * in-tab Worker, which can never carry the economy bits — so the tab strip is
 * decided from one GET of `/api/flags?device=` instead (the `ads/serve.ts`
 * pattern). A killed flag is false in both sources, so the kill switch kills.
 */
export function economyTabsFor(flags: Readonly<Record<string, unknown>> | null): EconomyTabId[] {
  if (flags === null) return [];
  return flags.economy_items === true ? ['loadout'] : [];
}

/* ------------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------------ */

const KIND_ORDER: readonly ItemKind[] = [
  ItemKind.SKIN, ItemKind.TITLE, ItemKind.EMBLEM, ItemKind.TRAIL, ItemKind.TROPHY,
];

const SECTION_TITLES: Readonly<Record<number, string>> = Object.freeze({
  [ItemKind.SKIN]: 'Skins',
  [ItemKind.TITLE]: 'Titles',
  [ItemKind.EMBLEM]: 'Emblems',
  [ItemKind.TRAIL]: 'Trails',
  [ItemKind.TROPHY]: 'Trophies',
});

const SLOT_FOR_KIND: Readonly<Record<number, LoadoutSlot | null>> = Object.freeze({
  [ItemKind.SKIN]: 'skin',
  [ItemKind.TITLE]: 'title',
  [ItemKind.EMBLEM]: null,
  [ItemKind.TRAIL]: null,
  [ItemKind.TROPHY]: null,
});

export function buildLoadoutView(inputs: LoadoutInputs): LoadoutView {
  const balance = {
    shown: inputs.scrapVisible && inputs.phase === 'ready',
    scrap: groupInt(inputs.scrap),
    lifetime: groupInt(inputs.lifetimeScrap),
  };

  if (inputs.phase === 'loading') return { line: 'Loading…', balance, sections: [] };
  if (inputs.phase === 'offline') {
    return { line: 'No server answered. Items live on the game server; try again online.', balance, sections: [] };
  }
  if (inputs.phase === 'noProfile' || inputs.inventory === null) {
    return { line: 'No server progress yet — finish an online match and your drops land here.', balance, sections: [] };
  }

  const liveIds = new Set((inputs.pack?.items ?? []).map((i) => i.id));
  const defsById = new Map((inputs.pack?.items ?? []).map((i) => [i.id, i]));
  const revoked = new Set(inputs.revoked);

  // Dedup by ref, counting copies. Insertion order = first-owned order.
  const counts = new Map<string, number>();
  for (const owned of inputs.inventory.items) {
    if (typeof owned.ref !== 'string' || parseItemRef(owned.ref) === null) continue;
    counts.set(owned.ref, (counts.get(owned.ref) ?? 0) + 1);
  }

  const rowsByKind = new Map<ItemKind, LoadoutRow[]>();
  for (const [ref, copies] of counts) {
    const parsed = parseItemRef(ref);
    if (parsed === null) continue;
    const def: ItemDef | undefined = defsById.get(parsed.localId);
    const state = itemStateFor(ref, liveIds, revoked);
    // Kind is only knowable from the live pack; an unknown-kind (dormant)
    // ref still renders — under Skins by its id prefix if it says so, else
    // in a best-guess bucket — because hiding an owned item reads as loss.
    const kind = def?.kind ?? guessKind(parsed.localId);
    const slot = SLOT_FOR_KIND[kind] ?? null;
    const equipped = slot === 'skin'
      ? inputs.inventory.equippedSkin === ref
      : slot === 'title' ? inputs.inventory.title === ref : false;
    const canAct = slot !== null && state === 'active';
    const action = equipped && slot !== null ? 'unequip' as const
      : canAct ? 'equip' as const : null;
    const note = state === 'revoked' ? 'revoked'
      : state === 'dormant' ? 'not in the current items pack'
      : kind === ItemKind.TITLE ? (def?.text ?? '') : '';
    const row: LoadoutRow = {
      ref,
      name: def?.name ?? fallbackName(parsed.localId),
      kindLabel: ITEM_KIND_NAMES[kind] ?? 'item',
      rarityLabel: def === undefined ? '' : ITEM_RARITY_NAMES[def.rarity] ?? '',
      state,
      copies,
      equipped,
      slot,
      action: inputs.busyRef !== '' ? null : action,
      busy: inputs.busyRef === ref,
      swatch: swatchCss(def?.tint ?? null),
      note,
    };
    const bucket = rowsByKind.get(kind) ?? [];
    bucket.push(row);
    rowsByKind.set(kind, bucket);
  }

  const sections: LoadoutSection[] = [];
  for (const kind of KIND_ORDER) {
    const rows = rowsByKind.get(kind);
    if (rows === undefined || rows.length === 0) continue;
    sections.push({ title: SECTION_TITLES[kind] ?? 'Items', rows });
  }

  const line = sections.length === 0
    ? 'No items yet — items drop from online matches.'
    : 'Equipping is a claim: the game wears only what the live items pack still defines.';
  return { line, balance, sections };
}

/** Best-effort kind for a ref the live pack no longer defines. */
function guessKind(localId: string): ItemKind {
  const head = localId.split('-')[0] ?? '';
  const idx = (ITEM_KIND_NAMES as readonly string[]).indexOf(head);
  return idx >= 0 ? idx as ItemKind : ItemKind.SKIN;
}

/** Every string a `LoadoutView` renders — the no-NaN test walks this. */
export function renderedLoadoutStrings(v: LoadoutView): string[] {
  const out: string[] = [v.line, v.balance.scrap, v.balance.lifetime];
  for (const s of v.sections) {
    out.push(s.title);
    for (const r of s.rows) {
      out.push(r.name, r.kindLabel, r.rarityLabel, r.state, String(r.copies), r.note, r.swatch);
    }
  }
  return out;
}
