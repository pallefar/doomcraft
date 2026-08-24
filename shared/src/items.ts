/**
 * DOOMCRAFT — items: the definitions, the ownership reference, and the
 * derived state rule (docs/ECONOMY.md "Items", docs/PACKS.md §7).
 *
 * An items pack is DATA (Rule A): cosmetics are palette + emissive numbers
 * the renderer already knows how to wear, titles are strings, and nothing
 * here is code. Weapon VARIANTS — sidegrade stat tables — are deliberately
 * absent: a stat the client predicts from its compiled table is BUILD-class
 * content by the same argument that keeps weapons out of the data packs
 * (docs/PACKS.md §1.1), and shipping variants means making the predictor
 * data-driven, which is a different project.
 *
 * THE OWNERSHIP RULE (docs/PACKS.md §7, implemented as written):
 * item state is DERIVED from the live release on read, never stamped into a
 * profile. A rollback recomputes ownership for every player at once and
 * writes nothing. One honest divergence from the §7 sketch: pack versions
 * are single u16s, not major.minor — so ACTIVE means "the live items pack
 * DEFINES this id", whatever version granted it, and the stored ref keeps
 * the granting version as provenance. Removing an id from the pack is still
 * exactly the §7 hazard: every owned copy goes dormant at the next read,
 * silently — which is why the gate carries `items.dormanted`.
 */

import { sanitiseContentId } from './modes.ts';

export enum ItemKind {
  SKIN = 0,
  EMBLEM = 1,
  TRAIL = 2,
  TITLE = 3,
  TROPHY = 4,
}

export const ITEM_KIND_NAMES: readonly string[] = Object.freeze(['skin', 'emblem', 'trail', 'title', 'trophy']);

export enum ItemRarity {
  COMMON = 0,
  UNCOMMON = 1,
  RARE = 2,
  EPIC = 3,
  RELIC = 4,
}

export const ITEM_RARITY_NAMES: readonly string[] = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'relic']);

export interface ItemDef {
  /** Content-id slug, globally unique across the pack (gate check packs.unique). */
  readonly id: string;
  readonly kind: ItemKind;
  readonly name: string;
  readonly rarity: ItemRarity;
  /**
   * Titles and trophies are NEVER tradable — proof of achievement, so a
   * trade would launder it (docs/ECONOMY.md). The parser refuses a manifest
   * that says otherwise rather than quietly correcting it.
   */
  readonly tradable: boolean;
  /** Multiplicative tint, skins/trails. Cosmetics must never cost frames. */
  readonly tint: readonly [number, number, number] | null;
  /** Emissive mask colour, skins/trails. */
  readonly emissive: readonly [number, number, number] | null;
  /** The string shown by the player's name. Titles only. */
  readonly text: string;
}

export interface ItemsManifest {
  readonly items: readonly ItemDef[];
}

/** `items@3:red-hazard-skin` — the granting pack version is provenance. */
export function formatItemRef(version: number, localId: string): string {
  return `items@${version}:${localId}`;
}

export interface ParsedItemRef { version: number; localId: string }

export function parseItemRef(ref: string): ParsedItemRef | null {
  const m = /^items@(\d{1,5}):([a-z0-9_-]{1,64})$/.exec(ref);
  if (m === null) return null;
  const version = Number(m[1]);
  if (!Number.isInteger(version) || version < 1 || version > 0xffff) return null;
  return { version, localId: m[2] };
}

/** One owned copy. Duplicates are meaningful (crafting eats them). */
export interface OwnedItem {
  readonly ref: string;
  readonly ms: number;
  /** 'drop' | 'challenge' | 'prize' | 'sponsor' | 'craft' | 'grant' */
  readonly source: string;
  /** Idempotency lineage — the payout source that granted it. */
  readonly sourceId: string;
}

export type ItemState = 'active' | 'dormant' | 'revoked';

/**
 * The §7 rule as one function. `liveIds` is the id set of the LIVE release's
 * items pack; `revoked` is the operator's explicit take-backs from the
 * profile's moderation record — the only state that is ever WRITTEN.
 */
export function itemStateFor(
  ref: string,
  liveIds: ReadonlySet<string>,
  revoked: ReadonlySet<string>,
): ItemState {
  if (revoked.has(ref)) return 'revoked';
  const parsed = parseItemRef(ref);
  if (parsed === null) return 'dormant';
  return liveIds.has(parsed.localId) ? 'active' : 'dormant';
}

/* ------------------------------------------------------------------------ *
 * The manifest parser — refusals, not corrections
 * ------------------------------------------------------------------------ */

export interface ItemsParseResult {
  manifest: ItemsManifest | null;
  /** Why, one line each. Non-empty means `manifest` is null. */
  errors: string[];
}

const KIND_BY_NAME: Readonly<Record<string, ItemKind>> = Object.freeze({
  skin: ItemKind.SKIN, emblem: ItemKind.EMBLEM, trail: ItemKind.TRAIL,
  title: ItemKind.TITLE, trophy: ItemKind.TROPHY,
});
const RARITY_BY_NAME: Readonly<Record<string, ItemRarity>> = Object.freeze({
  common: ItemRarity.COMMON, uncommon: ItemRarity.UNCOMMON, rare: ItemRarity.RARE,
  epic: ItemRarity.EPIC, relic: ItemRarity.RELIC,
});

export const MAX_ITEMS_PER_PACK = 512;
export const MAX_ITEM_NAME = 48;
export const MAX_TITLE_TEXT = 24;

function colour(v: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out: number[] = [];
  for (const c of v) {
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 4) return null;
    out.push(c);
  }
  return [out[0], out[1], out[2]];
}

export function parseItemsManifest(text: string): ItemsParseResult {
  const errors: string[] = [];
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { manifest: null, errors: ['not valid JSON'] };
  }
  const list = Array.isArray(root.items) ? root.items : null;
  if (list === null) return { manifest: null, errors: ['no items array'] };
  if (list.length > MAX_ITEMS_PER_PACK) {
    return { manifest: null, errors: [`${list.length} items is over the ${MAX_ITEMS_PER_PACK} cap`] };
  }
  const seen = new Set<string>();
  const items: ItemDef[] = [];
  for (const entry of list) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const rawId = typeof e.id === 'string' ? e.id : '';
    if (rawId !== sanitiseContentId(rawId) || rawId.length === 0) {
      errors.push(`item id "${rawId}" is not a canonical slug`);
      continue;
    }
    if (seen.has(rawId)) { errors.push(`duplicate item id "${rawId}"`); continue; }
    seen.add(rawId);
    const kind = KIND_BY_NAME[typeof e.kind === 'string' ? e.kind : ''];
    if (kind === undefined) { errors.push(`${rawId}: unknown kind "${String(e.kind)}"`); continue; }
    const rarity = RARITY_BY_NAME[typeof e.rarity === 'string' ? e.rarity : ''];
    if (rarity === undefined) { errors.push(`${rawId}: unknown rarity "${String(e.rarity)}"`); continue; }
    const name = typeof e.name === 'string' ? e.name.slice(0, MAX_ITEM_NAME) : '';
    if (name.length === 0) { errors.push(`${rawId}: no display name`); continue; }
    const tradable = e.tradable === true;
    if (tradable && (kind === ItemKind.TITLE || kind === ItemKind.TROPHY)) {
      errors.push(`${rawId}: a ${ITEM_KIND_NAMES[kind]} may not be tradable — proof of achievement, and a trade would launder it`);
      continue;
    }
    const text = typeof e.text === 'string' ? e.text.slice(0, MAX_TITLE_TEXT) : '';
    if (kind === ItemKind.TITLE && text.length === 0) {
      errors.push(`${rawId}: a title with no text is not a title`);
      continue;
    }
    items.push(Object.freeze({
      id: rawId, kind, name, rarity, tradable,
      tint: colour(e.tint), emissive: colour(e.emissive), text,
    }));
  }
  if (errors.length > 0) return { manifest: null, errors };
  return { manifest: Object.freeze({ items: Object.freeze(items) }), errors };
}

/**
 * Canonical input lines for the pack fingerprint — one per item, every field
 * that changes what a player owns or sees, in id order (code-unit sort).
 */
export function itemsFingerprintInputs(manifest: ItemsManifest): string[] {
  return [...manifest.items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((i) =>
      `${i.id}:${ITEM_KIND_NAMES[i.kind]}/${ITEM_RARITY_NAMES[i.rarity]}/${i.tradable ? 1 : 0}`
      + `/${i.tint === null ? '-' : i.tint.join(',')}`
      + `/${i.emissive === null ? '-' : i.emissive.join(',')}`
      + `/${i.text}/${i.name}`);
}
