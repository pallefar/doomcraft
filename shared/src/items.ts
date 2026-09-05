/**
 * DOOMCRAFT — items: the definitions, the ownership reference, and the
 * derived state rule (docs/ECONOMY.md "Items", docs/PACKS.md §7).
 *
 * An items pack is DATA (Rule A): cosmetics are palette + emissive numbers
 * the renderer already knows how to wear, titles are strings, and nothing
 * here is code.
 *
 * WEAPON VARIANTS, AND WHAT CHANGED (V4b). The stat tables still are not
 * here: a variant's numbers live in the VARIANTS pack (shared/src/variants.ts,
 * pack kind 7), which V2-V4a built precisely because a stat the client
 * predicts is not cosmetic data. What items.ts gained is the OWNERSHIP TOKEN
 * for one — `kind: 'weapon_variant'` plus a `variantId` naming the row — so a
 * player can own, list and trade an entitlement to a variant. The token is
 * inert in V4b: nothing equips it, nothing grants it, no drop rolls it and no
 * challenge may pay it (see `challengeGrantRefusal`). Supply arrives in V4e.
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
  /**
   * V4b — the ownership token for a weapon VARIANT (docs/VARIANTS.md §7).
   * APPENDED, never inserted: every existing numeric value has to stay put,
   * because `ITEM_KIND_NAMES[kind]` is what a fingerprint line carries and
   * an inserted member would re-mean every already-serialized item line.
   *
   * The token is inert in V4b: it can be owned, listed and traded; it grants
   * no weapon. Equipping is V4c, crafting is V4e.
   */
  WEAPON_VARIANT = 5,
}

export const ITEM_KIND_NAMES: readonly string[] = Object.freeze([
  'skin', 'emblem', 'trail', 'title', 'trophy', 'weapon_variant',
]);

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
  /**
   * V4b — the variants-pack row this token owns (`shotgun-slug`), or `''`.
   * Non-empty EXACTLY when `kind === WEAPON_VARIANT`; the parser refuses both
   * halves of that biconditional rather than dropping the field.
   *
   * It is deliberately NOT checked against the live variants pack here:
   * items.ts must not import variants.ts and the two packs version
   * independently, so the cross-pack existence check is a release-gate job.
   */
  readonly variantId: string;
}

export interface ItemsManifest {
  readonly items: readonly ItemDef[];
}

/**
 * The id prefix every WEAPON_VARIANT token carries, enforced by the parser as
 * a biconditional (see `parseItemsManifest`). It exists so that a bare ref —
 * with no manifest in hand — still names its kind: `guessKind` in the loadout
 * needs it for a DORMANT token, and `grantDrops` needs it to tell a mint from
 * a transfer without importing the pack registry.
 */
export const WEAPON_VARIANT_ID_PREFIX = 'weapon_variant-';

/** Whether a LOCAL id (not a full ref) names a weapon-variant token. */
export function isWeaponVariantLocalId(localId: string): boolean {
  return localId.startsWith(WEAPON_VARIANT_ID_PREFIX);
}

/** Whether a full `items@<v>:<id>` ref names a weapon-variant token. */
export function refIsWeaponVariant(ref: string): boolean {
  const parsed = parseItemRef(ref);
  return parsed !== null && isWeaponVariantLocalId(parsed.localId);
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
  weapon_variant: ItemKind.WEAPON_VARIANT,
});
const RARITY_BY_NAME: Readonly<Record<string, ItemRarity>> = Object.freeze({
  common: ItemRarity.COMMON, uncommon: ItemRarity.UNCOMMON, rare: ItemRarity.RARE,
  epic: ItemRarity.EPIC, relic: ItemRarity.RELIC,
});

export const MAX_ITEMS_PER_PACK = 512;
export const MAX_ITEM_NAME = 48;
export const MAX_TITLE_TEXT = 24;
/**
 * Mirrors `MAX_PACK_INPUT_BYTES` (shared/src/packs.ts), declared here rather
 * than imported so this module stays free of the pack registry — exactly as
 * `MAX_CHALLENGE_INPUT_BYTES` and `MAX_VARIANT_INPUT_BYTES` are. The items
 * test asserts the two agree, so they cannot drift.
 *
 * It is measured in UTF-8 BYTES and that is the whole point of it: `name` and
 * `text` are capped in UTF-16 CODE UNITS (`.slice(48)`, `.slice(24)`), so a
 * CJK name costs three bytes per unit and a `.length` check would pass a
 * 238-byte line as 94.
 */
export const MAX_ITEM_INPUT_BYTES = 160;

/** UTF-8 byte length without node:Buffer — this module runs in the browser too. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** C0 plus DEL — anything invisible in a review diff. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

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
    const parsed: unknown = JSON.parse(text);
    // `JSON.parse('null')` SUCCEEDS and returns null, and the property access
    // below sits outside this try — so a manifest whose entire body is the
    // literal `null` threw a TypeError straight past every caller instead of
    // being refused like any other malformed input. A pack is untrusted bytes
    // on disk; refusing it is the whole job.
    if (parsed === null || typeof parsed !== 'object') {
      return { manifest: null, errors: ['not a JSON object'] };
    }
    root = parsed as Record<string, unknown>;
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
    /* `Object.hasOwn`, not `MAP[str] === undefined`. `JSON.parse` gives
     * `{"kind": "constructor"}` an OWN key on the ENTRY, and the lookup
     * `KIND_BY_NAME["constructor"]` then finds Object.prototype's own
     * constructor — a FUNCTION, which is not `undefined`, so the guard below
     * passed it straight through. Measured on the shipped parser:
     * `{id:"a",kind:"constructor",rarity:"common",name:"A"}` returned
     * `errors: []` with `typeof items[0].kind === "function"`, and its
     * fingerprint line was `a:undefined/common/0/-/-//A` — byte-identical to
     * the line `kind:"toString"` produced. Two different manifests, one
     * digest, and a `kindName` of `undefined` on the wire. Same fix commit
     * 8c6f196 applied to `BANDS.toString` in the variants parser. */
    const kindName = typeof e.kind === 'string' ? e.kind : '';
    const kind = Object.hasOwn(KIND_BY_NAME, kindName) ? KIND_BY_NAME[kindName] : undefined;
    if (kind === undefined) { errors.push(`${rawId}: unknown kind "${String(e.kind)}"`); continue; }
    const rarityName = typeof e.rarity === 'string' ? e.rarity : '';
    const rarity = Object.hasOwn(RARITY_BY_NAME, rarityName) ? RARITY_BY_NAME[rarityName] : undefined;
    if (rarity === undefined) { errors.push(`${rawId}: unknown rarity "${String(e.rarity)}"`); continue; }
    const name = typeof e.name === 'string' ? e.name.slice(0, MAX_ITEM_NAME) : '';
    if (name.length === 0) { errors.push(`${rawId}: no display name`); continue; }
    /* REFUSED, NOT STRIPPED, and for the reason parseVariantsManifest gives:
     * the pack digest is `inputs.join('\n')`, so a name carrying its own
     * newline splits one item's record into two lines and lets an N-item
     * manifest reproduce the joined bytes of an N+1-item one. Tab and the
     * rest of C0 are the same defect, invisible in the diff. Stripping would
     * mint a display string the author never wrote — the exact "approve one
     * string, serve another" failure putting these fields in the line closes. */
    if (CONTROL_CHARS.test(name)) {
      errors.push(`${rawId}: display name has a control character — one fingerprint `
        + 'line is one item, and a newline or tab inside it forges the review diff');
      continue;
    }
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
    if (CONTROL_CHARS.test(text)) {
      errors.push(`${rawId}: title text has a control character — one fingerprint `
        + 'line is one item, and a newline or tab inside it forges the review diff');
      continue;
    }
    /* `text` and `name` BOTH trail the line and BOTH used to be free-form, so
     * `{text:"Alpha/Beta", name:"Gamma"}` and `{text:"Alpha", name:"Beta/Gamma"}`
     * serialized to the identical line — measured — while the loadout renders
     * a different item name. A free-form token is unambiguous only where it is
     * TERMINAL, and only `name` can be. `text` is a display title, so refusing
     * a slash in it costs nothing and leaves one terminal free-form token,
     * matching variantsFingerprintInputs and challengesFingerprintInputs. */
    if (text.includes('/')) {
      errors.push(`${rawId}: title text may not contain "/" — it is a fingerprint `
        + 'column separator, and two free-form tokens either side of one make '
        + 'two different manifests serialize to the same line');
      continue;
    }
    /* The V4b ownership token, as a biconditional. Half (a): a WEAPON_VARIANT
     * with no variantId names nothing and would be an item whose whole purpose
     * is unresolvable. Half (b): a variantId on any other kind is REFUSED
     * rather than dropped, because a field silently discarded is a field whose
     * author believes it does something (the terrainDamage lesson, 8c6f196).
     *
     * Existence of the row in the live variants pack is NOT checked here:
     * this module must not import variants.ts and the two packs version
     * independently, so that is a release-gate check (V4c). */
    const rawVariantId = typeof e.variantId === 'string' ? e.variantId : '';
    if (kind === ItemKind.WEAPON_VARIANT) {
      if (rawVariantId.length === 0 || rawVariantId !== sanitiseContentId(rawVariantId)) {
        errors.push(`${rawId}: a weapon_variant needs a canonical variantId slug, got `
          + `"${String(e.variantId)}"`);
        continue;
      }
      /* THE ID PREFIX IS A RULE, NOT A CONVENTION, AND IT CARRIES TWO LOADS.
       *
       * 1. `client/src/ui/loadoutModel.ts` guessKind() is the ONLY thing that
       *    can name the kind of a ref the live pack no longer defines: it
       *    splits the localId on '-' and looks the head up in
       *    ITEM_KIND_NAMES. A token called `cool-gun` therefore renders a
       *    DORMANT variant under "Skins", which is the exact failure the
       *    section exists to prevent.
       * 2. `grantDrops` (server/src/persistence.ts) is the single chokepoint
       *    every grant flows through, and it sees only a REF — no manifest,
       *    no kind. Making `id` self-describing is what lets the mint sites
       *    refuse a variant there without teaching persistence about packs.
       *
       * Enforced as a BICONDITIONAL (the else-branch below refuses the prefix
       * on any other kind), so "the ref starts with weapon_variant-" and "the
       * item is a WEAPON_VARIANT" are the same statement for anything this
       * parser accepted. Two representations agree by construction or they
       * drift; there is no third option. */
      if (rawId !== `${WEAPON_VARIANT_ID_PREFIX}${rawVariantId}`) {
        errors.push(`${rawId}: a weapon_variant's id must be `
          + `"${WEAPON_VARIANT_ID_PREFIX}${rawVariantId}" — the prefix is what names the kind `
          + 'to a dormant loadout row and to the grant chokepoint, neither of which has the manifest');
        continue;
      }
    } else {
      if (rawVariantId.length > 0) {
        errors.push(`${rawId}: a ${ITEM_KIND_NAMES[kind]} may not carry a variantId — `
          + 'only a weapon_variant owns a variants-pack row');
        continue;
      }
      if (isWeaponVariantLocalId(rawId)) {
        errors.push(`${rawId}: only a weapon_variant may use the `
          + `"${WEAPON_VARIANT_ID_PREFIX}" id prefix — everything that reads a bare ref `
          + 'treats it as the kind');
        continue;
      }
    }
    items.push(Object.freeze({
      id: rawId, kind, name, rarity, tradable,
      tint: colour(e.tint), emissive: colour(e.emissive), text,
      variantId: rawVariantId,
    }));
  }
  /* Every def must fit ONE pack input line, in UTF-8 BYTES. The release gate
   * caps input lines at MAX_PACK_INPUT_BYTES and a version directory is
   * IMMUTABLE, so a manifest that parses but overflows the line mints a pack
   * that can never pass a gate and can never be edited in place — an editor
   * that accepts what the machine will refuse forever. Both sibling data packs
   * already own this cap; items was the one that did not, and the hole was
   * measurable: a row with a 48-character id, a CJK name and a CJK text
   * emitted a 399-byte line with `errors: []`.
   *
   * BYTES, not `.length`. `name` and `text` are sliced in UTF-16 code units,
   * so `{id:'a', kind:'skin', rarity:'common', name:'\u754c'.repeat(48),
   * text:'\u754c'.repeat(24)}` is 238 bytes and 94 code units: a `.length`
   * check accepts it and the gate then refuses the version forever. */
  for (const line of itemsFingerprintInputs({ items })) {
    const bytes = utf8Bytes(line);
    if (bytes > MAX_ITEM_INPUT_BYTES) {
      errors.push(`${line.slice(0, line.indexOf(':'))}: its fields make a `
        + `${bytes}-byte pack input line, over the ${MAX_ITEM_INPUT_BYTES}-byte cap `
        + '(MAX_PACK_INPUT_BYTES — the release gate would refuse the version forever)');
    }
  }
  if (errors.length > 0) return { manifest: null, errors };
  return { manifest: Object.freeze({ items: Object.freeze(items) }), errors };
}

/**
 * Canonical input lines for the pack fingerprint — one per item, every field
 * that changes what a player owns or sees, in id order (code-unit sort).
 *
 * `variantId` sits IMMEDIATELY AFTER `emissive` and BEFORE `text`, inside the
 * positional block, because it is a `sanitiseContentId` slug and so cannot
 * contain `/` — while `text` and `name` are free-form. A new column may only
 * go where every token before it is delimiter-free; anywhere after `text` and
 * a title carrying a slash would shift it. `name` stays the single terminal
 * free-form token (`text` now refuses `/`, see the parser).
 *
 * The column is emitted UNCONDITIONALLY — every line gains `//` or
 * `/shotgun-slug/`. A conditional suffix would make two different manifests —
 * a non-variant item, and a variant whose variantId happened to be empty —
 * serialize identically, which is the thing a fingerprint exists to prevent.
 *
 * THIS MOVES items@1's DIGEST, and that is accepted rather than avoided.
 * `itemsAt()` recomputes both fingerprint and digest from the file on every
 * load, so no version bump can dodge it; the same version number legitimately
 * has a new digest when the serialization changes. What makes it safe TODAY is
 * a fact about the running host, not about the code: `GET /api/admin/release`
 * on the live origin returns `history: []`, `liveRevision: 0`,
 * `pendingRevision: 0` — no stored release document records an items digest,
 * so there is nothing to strand. `/api/version` could NOT have established
 * that: it publishes the POST-fallback view, identical for an empty document
 * and for a stored release this host already cannot satisfy (HANDOVER §0 rule
 * 35). Re-probe `/api/admin/release` immediately before the deploy, and ship
 * the binary and the content together — both sides of the digest move in the
 * same commit.
 */
export function itemsFingerprintInputs(manifest: ItemsManifest): string[] {
  return [...manifest.items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((i) =>
      `${i.id}:${ITEM_KIND_NAMES[i.kind]}/${ITEM_RARITY_NAMES[i.rarity]}/${i.tradable ? 1 : 0}`
      + `/${i.tint === null ? '-' : i.tint.join(',')}`
      + `/${i.emissive === null ? '-' : i.emissive.join(',')}`
      + `/${i.variantId}/${i.text}/${i.name}`);
}

/**
 * Why a CHALLENGE may not pay this item, or null.
 *
 * ONE predicate, because there are TWO doors onto exactly this decision and
 * HANDOVER §0 rule 29 is about what happens when two doors drift:
 * `checkQuestsRefs` (server/src/gate.ts — the release gate, both
 * implementations) and `StudioService.validateQuestsSource` (the CHECK button
 * and the save path), which does its own id lookup across every installed
 * items version. Duplicating the rule would let the studio bless a quests
 * manifest the gate refuses forever, which is the "editor that lies" this
 * repo keeps naming.
 *
 * docs/VARIANTS.md §7.2 makes variants CRAFT-ONLY. `ChallengeDef.item` is an
 * items-manifest local id granted at settlement as `items@<v>:<id>`, and the
 * ref gate only ever asked whether the id EXISTS — never what KIND it is — so
 * a quests pack naming a weapon_variant parsed clean, gated green and made
 * variant supply 1 at the first completion, well outside any drop roll.
 */
export function challengeGrantRefusal(def: ItemDef): string | null {
  if (def.kind === ItemKind.WEAPON_VARIANT) {
    return `"${def.id}" is a weapon_variant, and docs/VARIANTS.md §7.2 makes `
      + 'variants craft-only — a challenge may not mint one';
  }
  return null;
}
