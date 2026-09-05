/**
 * DOOMCRAFT — cosmetic crafting: the trade-up (docs/ECONOMY.md "crafting from
 * Scrap + duplicates").
 *
 * DETERMINISTIC BY DESIGN. The player picks the exact target; three duplicate
 * copies of one item plus a Scrap fee become that target, same kind, exactly
 * one rarity up. A random outcome would be a loot box with extra steps, and
 * this project's standing rule is no loot boxes — a craft is a purchase whose
 * price includes proof you played.
 *
 * THE RULES, each with the reason it exists:
 *  - Source must be ACTIVE (the live pack defines it, not revoked): a craft
 *    is a statement about the live catalogue, and consuming ghosts would let
 *    a rollback mint value.
 *  - Source and target share a KIND, and only the tradable kinds craft
 *    (skins, emblems, trails). Titles and trophies are proof of achievement;
 *    crafting one would launder it exactly as a trade would.
 *  - V4e: the kind rule bends in exactly ONE direction. Three COMMON cosmetics
 *    plus the uncommon fee become one UNCOMMON weapon-variant token — the
 *    entry recipe, and the only way variant supply is ever greater than zero
 *    (docs/VARIANTS.md §7.2). A variant is never crafting MATERIAL, so the
 *    ladder has one rung and V4e does not add a second.
 *  - Copies on a live trade's table are NOT consumable — the escrow already
 *    owns them (`TradeService.reservedRefs`), and a copy must never be in
 *    two stories at once.
 *  - The fee debits through the journal as the first `'spend'` emitter, under
 *    the same per-device lock that moves the balance, idempotent on the
 *    client nonce — a crash-replayed craft consumes and grants NOTHING twice.
 *  - Consumption takes the OLDEST copies first, exactly as trade settlement
 *    does, and unequips a skin whose last copy was eaten (trades.ts:673's
 *    rule) — an equipped ghost reads as a lost item.
 */

import {
  ITEM_KIND_NAMES,
  ITEM_RARITY_NAMES,
  ItemKind,
  ItemRarity,
  formatItemRef,
  parseItemRef,
  type ItemDef,
} from '@doomcraft/shared/items';

import type { StoredProfile } from './persistence.js';

/** Duplicate copies one craft consumes. */
export const CRAFT_COPIES = 3;

/** Scrap fee by TARGET rarity. There is no common target: nothing crafts down. */
export const CRAFT_FEES: Readonly<Record<number, number>> = Object.freeze({
  [ItemRarity.UNCOMMON]: 50,
  [ItemRarity.RARE]: 150,
  [ItemRarity.EPIC]: 400,
  [ItemRarity.RELIC]: 1000,
});

/**
 * The kinds that may be crafting MATERIAL — exactly the kinds that trade.
 *
 * THIS SET IS CHECKED AGAINST THE SOURCE AND NOTHING ELSE. V4e adds an entry
 * recipe whose OUTPUT is a weapon variant, and the tempting one-line version of
 * that change — adding `ItemKind.WEAPON_VARIANT` here — would also have made
 * variants legal material, i.e. variant -> variant crafting, which is out of
 * scope for V4e. The two directions therefore have two sets.
 */
export const CRAFTABLE_KINDS: ReadonlySet<ItemKind> = new Set([
  ItemKind.SKIN, ItemKind.EMBLEM, ItemKind.TRAIL,
]);

/**
 * V4e — the kinds a craft may PRODUCE. Titles and trophies stay out (crafting
 * proof-of-achievement launders it exactly as a trade would); weapon variants
 * come in, because the craft bench is the ONLY acquisition route
 * `docs/VARIANTS.md` §7.2 gives them and without this V4e the rule is circular:
 * a variant craft would need three variants and there are none.
 *
 * A variant is a legal TARGET and never a legal SOURCE, so no craft can climb
 * the variant ladder — which matters because there is no ladder to climb: both
 * bundled tokens are uncommon and rarities above uncommon are out of scope.
 */
export const CRAFT_TARGET_KINDS: ReadonlySet<ItemKind> = new Set([
  ItemKind.SKIN, ItemKind.EMBLEM, ItemKind.TRAIL, ItemKind.WEAPON_VARIANT,
]);

/**
 * The V4e ENTRY RECIPE, as one predicate both sides of the craft rule read:
 * three duplicates of one COMMON cosmetic become one UNCOMMON weapon-variant
 * token. The COMMON restriction is EXPLICIT and not inherited from the
 * rarity+1 rule: with the source merely "a cosmetic", an UNCOMMON skin would
 * craft into a RARE variant the moment a rare token exists, which is the
 * rarity ladder clause 10 puts out of scope.
 */
export function isEntryCraft(sourceDef: ItemDef, targetDef: ItemDef): boolean {
  return targetDef.kind === ItemKind.WEAPON_VARIANT
    && CRAFTABLE_KINDS.has(sourceDef.kind)
    && sourceDef.rarity === ItemRarity.COMMON;
}

export interface CraftPlan {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly targetLocalId: string;
  readonly fee: number;
}

export type CraftVerdict =
  | { ok: true; plan: CraftPlan }
  | { ok: false; status: number; error: string };

function refuse(status: number, error: string): CraftVerdict {
  return { ok: false, status, error };
}

/**
 * Validate one craft against a profile WITHOUT writing anything. `defs` is
 * the LIVE items pack as localId -> def, `liveVersion` its pack version, and
 * `reserved` what the escrow holds for this player.
 */
export function craftVerdict(
  profile: StoredProfile,
  sourceRef: string,
  targetLocalId: string,
  defs: ReadonlyMap<string, ItemDef>,
  liveVersion: number,
  reserved: ReadonlyMap<string, number>,
): CraftVerdict {
  const parsed = parseItemRef(sourceRef);
  if (parsed === null) return refuse(400, 'source is not an item ref');
  if (profile.moderation.revokedItems.some((r) => r.ref === sourceRef)) {
    return refuse(400, 'this item was revoked');
  }
  const sourceDef = defs.get(parsed.localId);
  if (sourceDef === undefined) return refuse(400, 'the live items pack no longer defines this item');
  if (!CRAFTABLE_KINDS.has(sourceDef.kind)) {
    return refuse(400, `a ${ITEM_KIND_NAMES[sourceDef.kind] ?? 'item'} cannot be crafted — it is proof, not material`);
  }
  const copies = profile.inventory.items.filter((i) => i.ref === sourceRef).length;
  const available = copies - (reserved.get(sourceRef) ?? 0);
  if (available < CRAFT_COPIES) {
    return refuse(400, copies >= CRAFT_COPIES
      ? `${copies - available} cop${copies - available === 1 ? 'y is' : 'ies are'} on a trade table — crafting needs ${CRAFT_COPIES} free copies`
      : `crafting eats ${CRAFT_COPIES} copies of the same item — you have ${copies}`);
  }
  if (sourceDef.rarity >= ItemRarity.RELIC) return refuse(400, 'nothing crafts above relic');

  const targetDef = defs.get(targetLocalId);
  if (targetDef === undefined) return refuse(400, 'the live items pack does not define that target');
  if (!CRAFT_TARGET_KINDS.has(targetDef.kind)) {
    return refuse(400, `a ${ITEM_KIND_NAMES[targetDef.kind] ?? 'item'} cannot be crafted — it is proof, not material`);
  }
  if (targetDef.kind !== sourceDef.kind) {
    // The ONE direction the kind rule bends: the V4e entry recipe.
    if (targetDef.kind !== ItemKind.WEAPON_VARIANT) {
      return refuse(400, `a ${ITEM_KIND_NAMES[sourceDef.kind]} crafts into a ${ITEM_KIND_NAMES[sourceDef.kind]}, not a ${ITEM_KIND_NAMES[targetDef.kind]}`);
    }
    if (!isEntryCraft(sourceDef, targetDef)) {
      return refuse(400, `a weapon variant is crafted from ${CRAFT_COPIES} COMMON cosmetics — ${sourceDef.name} is ${ITEM_RARITY_NAMES[sourceDef.rarity] ?? 'not common'}`);
    }
  }
  if (targetDef.rarity !== sourceDef.rarity + 1) {
    return refuse(400, `the target must be exactly one rarity up (${ITEM_RARITY_NAMES[sourceDef.rarity + 1]})`);
  }
  const fee = CRAFT_FEES[targetDef.rarity] ?? 0;
  if (fee <= 0) return refuse(400, 'that rarity has no crafting fee — refused rather than free');
  if (profile.economy.scrap < fee) {
    return refuse(400, `crafting ${targetDef.name} costs ${fee} Scrap — you have ${profile.economy.scrap}`);
  }
  return {
    ok: true,
    plan: {
      sourceRef,
      targetLocalId,
      targetRef: formatItemRef(liveVersion, targetLocalId),
      fee,
    },
  };
}

export interface CraftOutcome {
  /** The Scrap actually debited — the observed delta for the journal row. */
  readonly debited: number;
  readonly balanceAfter: number;
}

/**
 * Consume and grant. Call ONLY after `craftVerdict` passed, inside the same
 * `store.update` callback that checked it — the callback runs synchronously
 * over the live object, so nothing can un-own a copy in between. The GRANT is
 * the caller's job (`grantDrops` with source 'craft' and the nonce sourceId),
 * because the grant is what the idempotency replay looks for.
 */
export function applyCraft(profile: StoredProfile, plan: CraftPlan): CraftOutcome {
  // Oldest copies first, exactly as trade settlement consumes.
  const mine = profile.inventory.items
    .map((item, index) => ({ item, index }))
    .filter((e) => e.item.ref === plan.sourceRef)
    .sort((a, b) => a.item.ms - b.item.ms || a.index - b.index)
    .slice(0, CRAFT_COPIES)
    .map((e) => e.index)
    .sort((a, b) => b - a);
  for (const index of mine) profile.inventory.items.splice(index, 1);

  const remaining = profile.inventory.items.some((i) => i.ref === plan.sourceRef);
  if (!remaining && profile.inventory.equippedSkin === plan.sourceRef) profile.inventory.equippedSkin = '';
  if (!remaining && profile.inventory.title === plan.sourceRef) profile.inventory.title = '';

  const before = profile.economy.scrap;
  profile.economy.scrap = Math.max(0, before - plan.fee);
  return { debited: profile.economy.scrap - before, balanceAfter: profile.economy.scrap };
}
