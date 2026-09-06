/**
 * DOOMCRAFT — V4c: turning a stored variant CLAIM into this room's slot map.
 *
 * The profile stores an item REF per base weapon (`inventory.variants`). A
 * room fires from a `SessionArsenal` built out of ITS OWN table, where overlay
 * row `i` occupies slot `i + 1` and slot 0 is the untouched archetype
 * (`SessionArsenal.from`, shared/src/arsenal.ts). This module is the only
 * place the two meet.
 *
 * THREE THINGS IT WILL NOT DO, each of which is a way to hand a player the
 * wrong gun with no error anywhere:
 *
 *  1. IT NEVER READS `releases.live()`. It resolves against the entries the
 *     ROOM will encode and send — the array `Room.variantTable` returns, which
 *     the room decoded from its own bytes. A room may be pinned to a different
 *     release than the live one, and two tables holding the same two variants
 *     in the opposite order would otherwise grant the OTHER gun. The room's
 *     `resolveVariantSlots` cannot catch that: it clamps by COUNT, and both
 *     indices are in range.
 *
 *  2. IT NEVER TRUSTS THE STORED CLAIM. Ownership is re-derived at READ time,
 *     at every join. A trade removes the item and leaves the claim behind
 *     (`Trades.removeCopies` now clears it too, but only for a settlement this
 *     build ran), an operator revokes a copy without touching the profile, and
 *     a pack can be rolled back under a claim that was legal when it was made.
 *     So: still owned, not revoked, and present in THIS room's table.
 *
 *  3. IT NEVER REFUSES THE ROOM. Every failure above resolves to `BASE_SLOT`
 *     and the player fires the base weapon, which is docs/PACKS.md's Rule E
 *     applied one level down: refusing the room is worse than serving the
 *     base. Nothing here throws and nothing here writes.
 *
 * The variant id comes off the REF, not out of an items manifest, and that is
 * sound because `parseItemsManifest` enforces
 * `id === "weapon_variant-<variantId>"` as a BICONDITIONAL (V4b, shared/src/
 * items.ts). A room holds no items pack — it is handed a variants table and
 * nothing else — so requiring one here would make the gun a player fires
 * depend on a pack the room was never pinned to.
 */

import { WEAPON_COUNT } from '@doomcraft/shared';
import { parseItemRef, WEAPON_VARIANT_ID_PREFIX } from '@doomcraft/shared/items';
import type { VariantWireEntry } from '@doomcraft/shared/variants';

import type { StoredProfile } from './persistence.js';

/** Slot 0: the compiled archetype. Mirrors `BASE_SLOT` in shared/src/arsenal. */
const BASE_SLOT = 0;

/**
 * The per-weapon slot map this profile earns in a room whose table is
 * `entries`. All zeros for a missing profile, an empty table, or a profile
 * with nothing equipped.
 *
 * THE `+ 1` IS THE WHOLE FUNCTION. `SessionArsenal.from` sets `slot = 0` and
 * increments BEFORE filling, so row `r` of the table lands in slot `r + 1`
 * and `slotCount` is `rows + 1`. Writing `r` would name the slot of the
 * PREVIOUS row — for row 0 that is BASE_SLOT, so the player who equipped
 * something fires the base gun and no code path anywhere reports it.
 */
export function variantSlotsFor(
  profile: StoredProfile | null | undefined,
  entries: readonly VariantWireEntry[],
): Uint8Array {
  const out = new Uint8Array(WEAPON_COUNT);
  if (profile === null || profile === undefined) return out;
  const claims = profile.inventory?.variants;
  if (claims === null || claims === undefined) return out;

  for (const [key, ref] of Object.entries(claims)) {
    const weaponId = Number(key);
    if (!Number.isInteger(weaponId) || weaponId < 0 || weaponId >= WEAPON_COUNT) continue;
    if (typeof ref !== 'string' || ref === '') continue;

    // Still owned? A traded-away copy leaves the claim behind.
    if (!profile.inventory.items.some((i) => i.ref === ref)) continue;
    // Still theirs? An operator take-back writes only `revokedItems`.
    if (profile.moderation?.revokedItems?.some((r) => r.ref === ref) === true) continue;

    const parsed = parseItemRef(ref);
    if (parsed === null) continue;
    if (!parsed.localId.startsWith(WEAPON_VARIANT_ID_PREFIX)) continue;
    const variantId = parsed.localId.slice(WEAPON_VARIANT_ID_PREFIX.length);
    if (variantId === '') continue;

    const rowIndex = entries.findIndex((e) => e.id === variantId);
    if (rowIndex < 0) continue; // not in THIS room's table -> the base weapon
    // The table is the authority on which weapon the row overrides. A claim
    // filed under the shotgun for a row this table says is a rocket variant
    // would put a rocket slot on the shotgun's byte, and every slot holds
    // every weapon — so the shotgun would silently fire its base while the
    // player is told they are wearing something.
    if (entries[rowIndex].base !== weaponId) continue;

    out[weaponId] = rowIndex + 1;
  }
  return out;
}

export { BASE_SLOT as VARIANT_BASE_SLOT };
