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
  ItemRarity,
  itemStateFor,
  parseItemRef,
  type ItemDef,
  type ItemState,
} from '@shared/items';
import { WEAPON_COUNT } from '@shared/weapons';

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
  /**
   * V4f — the equipped weapon variant per BASE WEAPON: `String(weaponId)` ->
   * the owned item REF, absent meaning "the base gun". Straight off
   * `GET /api/profile`'s `profile.inventory.variants` (`StoredInventory`).
   *
   * It stores the REF and not a table row, and this side has to compare on the
   * ref for the same reason the server stores one: a player can own several
   * copies of the same variant, and lighting "Equipped" on the id would light
   * every copy at once.
   */
  readonly variants: Readonly<Record<string, string>>;
}

/** One row of `GET /api/variants` — id, base and name, never the overrides. */
export interface WireVariantDef {
  readonly id: string;
  readonly base: number;
  readonly name: string;
}

/**
 * `GET /api/variants` — the live variants pack. PUBLIC and unflagged, exactly
 * like `/api/items`, and `{version: 0, variants: []}` when none is live.
 *
 * The tab needs it because a variant token's equip SLOT is not a property of
 * its kind: `variant:1` is "what the shotgun fires with", and the base weapon
 * lives here, not on the `ItemDef`.
 */
export interface WireVariantsPack {
  readonly version: number;
  readonly variants: readonly WireVariantDef[];
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
  /**
   * V4f — `GET /api/variants`, or null when it did not answer. A null map is
   * NOT "no variants": it is "the tab cannot name the slot", and a row whose
   * base it cannot resolve gets no equip action rather than a guessed one.
   */
  readonly variants: WireVariantsPack | null;
  /**
   * V4e — what the trade escrow holds for this player, ref -> copies, straight
   * off `GET /api/profile`'s `reserved`. `craftVerdict` counts FREE copies, so
   * a tab that counted RAW copies offered crafts the server refused with 400.
   */
  readonly reserved: Readonly<Record<string, number>>;
  /** `economySurfacesOn(product, probe)` — decided by the caller, once. */
  readonly scrapVisible: boolean;
  /** The ref a POST /api/equip is in flight for, or ''. Disables actions. */
  readonly busyRef: string;
}

/* ------------------------------------------------------------------------ *
 * Rendered shapes
 * ------------------------------------------------------------------------ */

/**
 * The slot names `POST /api/equip` accepts, restated from `EquipSlot` in
 * `server/src/persistence.ts`. `variant:<baseWeaponId>` is canonical decimal
 * ONLY — `variantSlotWeaponId` refuses `variant:01` and `variant:1.0` — which
 * is why `variantSlotFor` below builds the string from a laundered integer
 * rather than from whatever the wire said.
 */
export type LoadoutSlot = 'skin' | 'title' | `variant:${number}`;

export interface CraftTarget {
  readonly localId: string;
  readonly name: string;
  readonly rarityLabel: string;
  readonly swatch: string;
  readonly fee: number;
}

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
  /**
   * The trade-up: non-empty ONLY when this row can craft (ACTIVE, three or
   * more copies, a craftable kind, and the live pack defines at least one
   * same-kind item exactly one rarity up). The player picks the target —
   * crafting is deterministic, never a roll.
   */
  readonly craftTargets: readonly CraftTarget[];
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

export type EconomyTabId = 'loadout' | 'trade' | 'competitions';

/**
 * The menu-time truth: on the menu `game.net.flagBits` comes from the local
 * in-tab Worker, which can never carry the economy bits — so the tab strip is
 * decided from one GET of `/api/flags?device=` instead (the `ads/serve.ts`
 * pattern). A killed flag is false in both sources, so the kill switch kills.
 */
export function economyTabsFor(flags: Readonly<Record<string, unknown>> | null): EconomyTabId[] {
  if (flags === null) return [];
  const out: EconomyTabId[] = [];
  if (flags.economy_items === true) out.push('loadout');
  if (flags.economy_trading === true) out.push('trade');
  if (flags.economy_competitions === true) out.push('competitions');
  return out;
}

/* ------------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------------ */

/**
 * KIND_ORDER IS THE ONLY THING THAT BUILDS SECTIONS, so a kind missing from it
 * is not merely unsorted — it is DROPPED. Measured before V4b added the last
 * entry: one owned item at `kind = 5` produced `sections = 0, rows = 0`, i.e.
 * the player owns a thing and the tab renders nothing at all, which reads as
 * a lost item. Appending is mandatory whenever `ItemKind` grows.
 */
const KIND_ORDER: readonly ItemKind[] = [
  ItemKind.SKIN, ItemKind.TITLE, ItemKind.EMBLEM, ItemKind.TRAIL, ItemKind.TROPHY,
  ItemKind.WEAPON_VARIANT,
];

const SECTION_TITLES: Readonly<Record<number, string>> = Object.freeze({
  [ItemKind.SKIN]: 'Skins',
  [ItemKind.TITLE]: 'Titles',
  [ItemKind.EMBLEM]: 'Emblems',
  [ItemKind.TRAIL]: 'Trails',
  [ItemKind.TROPHY]: 'Trophies',
  [ItemKind.WEAPON_VARIANT]: 'Weapon Variants',
});

/**
 * KIND -> SLOT, and WEAPON_VARIANT IS DELIBERATELY ABSENT FROM IT.
 *
 * This table is the wrong shape for a variant and forcing it in would be the
 * bug: it maps a kind to ONE fixed slot, while a variant token's slot depends
 * on the ITEM — `weapon_variant-shotgun-slug` is `variant:1` and
 * `weapon_variant-rocket-swift` is `variant:3`. A constant here (`variant:0`,
 * say) would hand every token the pistol slot, which `equipVerdict` refuses
 * with "that variant is for weapon 1, not weapon 0" — an Equip button that
 * always 400s, which is exactly what V4b's comment was avoiding. The row
 * computes its own slot through `variantSlotFor`; the absence keeps anything
 * from reading a wrong constant out of here.
 */
const SLOT_FOR_KIND: Readonly<Record<number, LoadoutSlot | null>> = Object.freeze({
  [ItemKind.SKIN]: 'skin',
  [ItemKind.TITLE]: 'title',
  [ItemKind.EMBLEM]: null,
  [ItemKind.TRAIL]: null,
  [ItemKind.TROPHY]: null,
});

/**
 * The equip slot of one weapon-variant row, or null when the tab cannot name
 * it — which is the same answer for four different reasons, all of them "the
 * server would refuse this claim":
 *
 *   - the live items pack does not define the token (a DORMANT one, `def`
 *     undefined) — `equipVerdict` answers "no installed pack defines this item";
 *   - the def carries no `variantId` (impossible for a WEAPON_VARIANT the
 *     parser accepted, and cheap to be sure of);
 *   - `/api/variants` did not answer, so the map is empty;
 *   - it answered and does not NAME this row — a token minted by an items pack
 *     whose variants pack has since been re-cut. `equipVerdict` answers "no
 *     installed variants pack defines this variant", so an enabled button here
 *     is a 400 the player did not ask for.
 *
 * `base` is laundered rather than trusted: it arrives over the wire, and
 * `variantSlotWeaponId` on the server accepts CANONICAL DECIMAL ONLY inside
 * `0..WEAPON_COUNT`. `variant:1.5`, `variant:-1` and `variant:undefined` are
 * all slots that route to nothing, and this is the only place that builds one.
 */
function variantSlotFor(
  def: ItemDef | undefined,
  bases: ReadonlyMap<string, number>,
): LoadoutSlot | null {
  if (def === undefined || def.variantId === '') return null;
  const base = bases.get(def.variantId);
  if (base === undefined) return null;
  return `variant:${base}`;
}

/**
 * `/api/variants` -> `variantId -> base weapon`, laundered at the door.
 *
 * A row whose base is not a canonical in-range weapon id is DROPPED rather
 * than kept with a repaired value: a dropped row costs the player an Equip
 * button, a repaired one costs them the wrong gun.
 */
function variantBasesOf(pack: WireVariantsPack | null): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const v of pack?.variants ?? []) {
    if (typeof v?.id !== 'string' || v.id === '') continue;
    const base = v.base;
    if (typeof base !== 'number' || !Number.isInteger(base) || base < 0 || base >= WEAPON_COUNT) continue;
    out.set(v.id, base);
  }
  return out;
}

/**
 * The claim map off a server answer, as strings.
 *
 * BOTH doors that carry it dropped it before V4f and each one alone is a
 * distinct bug: `GET /api/profile` dropping it meant no variant row could ever
 * read as Equipped, and `POST /api/equip`'s 200 dropping it meant a SUCCESSFUL
 * equip repainted from stale claims and the button flipped straight back to
 * "Equip". It lives here rather than in `loadoutTab.ts` so it is testable off
 * the DOM, which is this file's whole reason to exist.
 *
 * It only refuses a shape that is not a string map; `variantClaimsOf` below is
 * what decides which KEYS count.
 */
export function wireVariantClaims(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * `inventory.variants` -> `baseWeaponId -> the claimed REF`, laundered the same
 * way `sanitiseVariantClaims` launders it on the server: canonical decimal keys
 * only, so `'01'` cannot become a second name for slot 1.
 */
function variantClaimsOf(inv: WireInventory): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  const raw: unknown = inv.variants;
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || id >= WEAPON_COUNT || String(id) !== key) continue;
    if (typeof value === 'string' && value !== '') out.set(id, value);
  }
  return out;
}

/**
 * Restated from `server/src/craft.ts` because the client cannot import server
 * code; `loadoutModel.test.ts` reads that file and fails on drift, exactly as
 * `profileModel.test.ts` guards its `RemoteStats` restatement.
 */
export const CRAFT_COPIES = 3;
export const CRAFT_FEES_BY_RARITY: Readonly<Record<number, number>> = Object.freeze({
  [ItemRarity.UNCOMMON]: 50,
  [ItemRarity.RARE]: 150,
  [ItemRarity.EPIC]: 400,
  [ItemRarity.RELIC]: 1000,
});
const CRAFTABLE_KINDS: ReadonlySet<ItemKind> = new Set([ItemKind.SKIN, ItemKind.EMBLEM, ItemKind.TRAIL]);
/**
 * V4e — `CRAFT_TARGET_KINDS`, restated. Two sets on the server for the reason
 * spelled out there: `CRAFTABLE_KINDS` is a SOURCE check, so a weapon variant
 * is a legal craft OUTPUT and never legal material.
 */
const CRAFT_TARGET_KINDS: ReadonlySet<ItemKind> = new Set([
  ItemKind.SKIN, ItemKind.EMBLEM, ItemKind.TRAIL, ItemKind.WEAPON_VARIANT,
]);

/**
 * The offered targets for one row. `free` is copies MINUS what the escrow
 * holds and `scrap` is the live balance, because those are the two things
 * `craftVerdict` checks that this function used to ignore — it took the raw
 * copy count and no balance at all, so with one copy on a trade table (or 49
 * Scrap) the tab offered an enabled button against a server that answered 400.
 * `craftAgreement.test.ts` asserts the two sets are EQUAL, not that one is a
 * subset: a subset assertion is vacuously true when the tab offers nothing,
 * which is the other half of the same bug.
 */
function craftTargetsFor(
  def: ItemDef | undefined,
  state: ItemState,
  free: number,
  pack: WireItemsPack | null,
  scrap: number,
): CraftTarget[] {
  if (def === undefined || state !== 'active' || free < CRAFT_COPIES) return [];
  if (!CRAFTABLE_KINDS.has(def.kind) || def.rarity >= ItemRarity.RELIC) return [];
  const fee = CRAFT_FEES_BY_RARITY[def.rarity + 1] ?? 0;
  if (fee <= 0 || scrap < fee) return [];
  return (pack?.items ?? [])
    .filter((t) => CRAFT_TARGET_KINDS.has(t.kind)
      && t.rarity === def.rarity + 1
      && (t.kind === def.kind
        // The V4e entry recipe, and only it: a COMMON cosmetic into a variant.
        || (t.kind === ItemKind.WEAPON_VARIANT && def.rarity === ItemRarity.COMMON)))
    .map((t) => ({
      localId: t.id,
      name: t.name,
      rarityLabel: ITEM_RARITY_NAMES[t.rarity] ?? '',
      swatch: swatchCss(t.tint),
      fee,
    }));
}

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
  const variantBases = variantBasesOf(inputs.variants);
  const variantClaims = variantClaimsOf(inputs.inventory);

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
    const slot: LoadoutSlot | null = kind === ItemKind.WEAPON_VARIANT
      ? variantSlotFor(def, variantBases)
      : SLOT_FOR_KIND[kind] ?? null;
    /*
     * EQUIPPED-NESS IS A REF COMPARISON, on all three slots.
     *
     * `inventory.variants` is keyed by the base weapon and VALUED BY THE REF
     * the player owns, and comparing on anything coarser — the variant id, the
     * localId, the ref with its `items@N:` prefix stripped — lights every copy
     * the player holds of that variant, including copies of a DIFFERENT pack
     * version that the server would happily equip separately.
     */
    const equipped = slot === 'skin'
      ? inputs.inventory.equippedSkin === ref
      : slot === 'title' ? inputs.inventory.title === ref
      : slot !== null ? variantClaims.get(Number(slot.slice('variant:'.length))) === ref
      : false;
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
      craftTargets: inputs.busyRef !== '' ? []
        : craftTargetsFor(def, state, copies - (inputs.reserved[ref] ?? 0), inputs.pack, inputs.scrap),
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
      /* `slot` is in here from V4f on. It is not painted as text, but it IS
       * posted as a JSON KEY to /api/equip, and `variant:${base}` is built
       * from a wire number — so `variant:NaN` and `variant:undefined` are
       * reachable exactly the way a rendered NaN is, and they route to a slot
       * `variantSlotWeaponId` refuses. The no-NaN sweep is the cheapest place
       * to keep that impossible. */
      out.push(r.name, r.kindLabel, r.rarityLabel, r.state, String(r.copies), r.note, r.swatch, r.slot ?? '');
      for (const t of r.craftTargets) out.push(t.name, t.rarityLabel, String(t.fee), t.swatch);
    }
  }
  return out;
}
