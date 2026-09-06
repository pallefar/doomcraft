/**
 * DOOMCRAFT — V4c: does the claim reach the BODY?
 *
 * Every assertion in this file is about THE DAMAGE THE ARSENAL SERVES, not
 * about a slot number and not about an acceptance code. A slot index is an
 * intermediate value that renumbers the first time somebody reorders a table;
 * "the shotgun fires one 62-damage slug" is the thing the player experiences
 * and the thing a wrong answer is wrong ABOUT. Asserting `slots[1] === 1`
 * would pass just as happily against an arsenal that put the slug in slot 1
 * and served the base from it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WeaponId } from '@doomcraft/shared';
import { SessionArsenal } from '@doomcraft/shared/arsenal';
import {
  overlaysFromWire, parseVariantsManifest, wireEntriesFor,
  type VariantDef, type VariantWireEntry, type VariantsManifest,
} from '@doomcraft/shared/variants';
import { createProfile, grantDrops, type StoredProfile } from './persistence.js';
import { variantSlotsFor } from './variantClaims.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SLUG = 'items@1:weapon_variant-shotgun-slug';
const SWIFT = 'items@1:weapon_variant-rocket-swift';

/** The pack this repository actually ships, read off disk and parsed for real. */
function shippedTable(): readonly VariantWireEntry[] {
  const text = readFileSync(join(REPO, 'content', 'variants.json'), 'utf8');
  const parsed = parseVariantsManifest(text);
  expect(parsed.errors, 'content/variants.json no longer parses').toEqual([]);
  return wireEntriesFor(parsed.manifest as VariantsManifest);
}

function tableOf(...defs: VariantDef[]): readonly VariantWireEntry[] {
  return wireEntriesFor({ variants: defs });
}

/** A profile that owns `refs` and has `claims` written on it. */
function owner(refs: readonly string[], claims: Record<string, string>): StoredProfile {
  const p = createProfile('device-variants');
  grantDrops(p, refs, 'trade', 'seed', 1);
  for (const [weapon, ref] of Object.entries(claims)) p.inventory.variants[weapon] = ref;
  return p;
}

/** What a player with these slots actually fires. */
function served(entries: readonly VariantWireEntry[], slots: Uint8Array, weapon: WeaponId) {
  return SessionArsenal.from(overlaysFromWire(entries)).statsFor(weapon, slots[weapon]);
}

describe('variantSlotsFor — the claim reaches the body', () => {
  /*
   * THE OFF-BY-ONE, AND IT IS THE WHOLE PHASE.
   *
   * `SessionArsenal.from` sets `slot = BASE_SLOT` and increments BEFORE it
   * fills, so row r lands in slot r + 1. Writing `rowIndex` instead of
   * `rowIndex + 1` puts row 0 at slot 0 — the BASE — so the player equipped
   * something, was told yes, and fires the compiled shotgun with nothing
   * anywhere reporting it. Row 1 written as slot 1 serves the OTHER variant.
   */
  it('serves the SLUG to a player who equipped the slug, not the base and not the other row', () => {
    const entries = shippedTable();
    expect(entries.map((e) => e.id)).toEqual(['shotgun-slug', 'rocket-swift']);

    const p = owner([SLUG, SWIFT], {
      [String(WeaponId.SHOTGUN)]: SLUG,
      [String(WeaponId.ROCKET)]: SWIFT,
    });
    const slots = variantSlotsFor(p, entries);

    // The DAMAGE first, deliberately: it is what the player feels, and it is
    // the assertion that survives somebody renumbering the slots.
    const shotgun = served(entries, slots, WeaponId.SHOTGUN);
    expect(shotgun.damage, 'base shotgun is 11 x 7; the slug is 62 x 1').toBe(62);
    expect(shotgun.pellets).toBe(1);
    expect(shotgun.variantId).toBe('shotgun-slug');

    const rocket = served(entries, slots, WeaponId.ROCKET);
    expect(rocket.damage, 'base rocket is 92 direct; the swift one is 82').toBe(82);
    expect(rocket.projectileSpeed).toBe(66);
    expect(rocket.variantId).toBe('rocket-swift');
  });

  it('leaves a weapon nobody claimed on the compiled archetype', () => {
    const entries = shippedTable();
    const p = owner([SLUG], { [String(WeaponId.SHOTGUN)]: SLUG });
    const slots = variantSlotsFor(p, entries);
    // Every slot contains every weapon, so the rocket in the shotgun's slot is
    // the BASE rocket — no branch on the firing path, and no hole.
    const rocket = served(entries, slots, WeaponId.ROCKET);
    expect(rocket.variantId).toBe('');
    expect(rocket.damage).toBe(92);
  });

  /*
   * THE ORDERING TEST. Two tables that hold the SAME two variants in the
   * OPPOSITE order. A resolver that read a table other than the room's — the
   * live release, say, while the room is pinned to an older one — would write
   * the same index into both and hand the player a different gun in one of
   * them, with no error anywhere and both indices inside `slotCount`.
   */
  it('gives the same player the same gun from two tables with the rows swapped', () => {
    const src = shippedTable();
    const forwards = tableOf(...defsOf());
    const backwards = tableOf(...defsOf().reverse());
    expect(forwards.map((e) => e.id)).toEqual(['shotgun-slug', 'rocket-swift']);
    expect(backwards.map((e) => e.id)).toEqual(['rocket-swift', 'shotgun-slug']);
    expect(src.map((e) => e.id)).toEqual(forwards.map((e) => e.id));

    const p = owner([SLUG], { [String(WeaponId.SHOTGUN)]: SLUG });
    const a = served(forwards, variantSlotsFor(p, forwards), WeaponId.SHOTGUN);
    const b = served(backwards, variantSlotsFor(p, backwards), WeaponId.SHOTGUN);

    expect(a.damage, 'the forwards room served the wrong gun').toBe(62);
    expect(b.damage, 'the backwards room served a DIFFERENT gun for the same claim').toBe(62);
    expect(a.pellets).toBe(b.pellets);
    expect(a.variantId).toBe('shotgun-slug');
    expect(b.variantId).toBe('shotgun-slug');
    // And the two rooms really did number them differently, or the swap was
    // not exercised and this test proves nothing.
    expect(variantSlotsFor(p, forwards)[WeaponId.SHOTGUN])
      .not.toBe(variantSlotsFor(p, backwards)[WeaponId.SHOTGUN]);
  });

  it('serves the BASE for a variant this room\'s table does not contain', () => {
    // The player owns and claims the slug; this room ships only the rocket.
    const rocketOnly = tableOf(defsOf()[1]);
    const p = owner([SLUG], { [String(WeaponId.SHOTGUN)]: SLUG });
    const slots = variantSlotsFor(p, rocketOnly);
    const shotgun = served(rocketOnly, slots, WeaponId.SHOTGUN);
    expect(shotgun.variantId).toBe('');
    expect(shotgun.damage).toBe(11);
    expect(shotgun.pellets).toBe(7);
  });

  it('serves the BASE when the room ships no variants at all', () => {
    const p = owner([SLUG], { [String(WeaponId.SHOTGUN)]: SLUG });
    const slots = variantSlotsFor(p, []);
    expect(served([], slots, WeaponId.SHOTGUN).damage).toBe(11);
  });

  /*
   * OWNERSHIP IS RE-DERIVED AT READ TIME, EVERY JOIN.
   *
   * These two are written with a claim that is EXPLICITLY STALE — the copy is
   * simply not in `items` — rather than by driving a real trade. A test that
   * traded the item away would pass with this check deleted, because
   * `Trades.removeCopies` now clears the claim on its way out: the cleanup
   * would have erased the test's own input. See `trades.test.ts` for the
   * settlement half; this is the half that has to hold for a claim no
   * settlement this build ran ever touched.
   */
  it('serves the BASE for a claim on a copy the profile no longer owns', () => {
    const entries = shippedTable();
    const p = owner([], { [String(WeaponId.SHOTGUN)]: SLUG });
    expect(p.inventory.items).toEqual([]);
    const shotgun = served(entries, variantSlotsFor(p, entries), WeaponId.SHOTGUN);
    expect(shotgun.variantId).toBe('');
    expect(shotgun.damage).toBe(11);
  });

  it('serves the BASE for a claim on a REVOKED copy', () => {
    const entries = shippedTable();
    const p = owner([SLUG], { [String(WeaponId.SHOTGUN)]: SLUG });
    p.moderation.revokedItems.push({ ref: SLUG, ms: 2, reason: 'operator take-back' });
    const shotgun = served(entries, variantSlotsFor(p, entries), WeaponId.SHOTGUN);
    expect(shotgun.variantId).toBe('');
    expect(shotgun.damage).toBe(11);
  });

  /*
   * AND ONE ASSERTION IN THIS FILE IS ABOUT A SLOT NUMBER, on purpose, because
   * the damage CANNOT distinguish it and pretending otherwise would be a green
   * test that cannot fail. Every slot holds every weapon, so a rocket sitting
   * in the slug's slot fires the BASE rocket — the same numbers it fires from
   * slot 0. What the guard actually protects is the slot MAP, which goes on
   * the wire (`encodeVariantTable`) and which the client resolves against the
   * same table: a byte naming a row that overrides a different weapon is a
   * number both predictors must then agree to ignore, and "agree to ignore"
   * is how `fc01475` happened five times over.
   */
  it('refuses to put a foreign row\'s slot on a weapon\'s byte', () => {
    const entries = shippedTable();
    const p = owner([SLUG], { [String(WeaponId.ROCKET)]: SLUG });
    const slots = variantSlotsFor(p, entries);
    expect(slots[WeaponId.ROCKET], 'the slug is a SHOTGUN row').toBe(0);
    expect(served(entries, slots, WeaponId.ROCKET).variantId).toBe('');
    expect(served(entries, slots, WeaponId.ROCKET).damage).toBe(92);
  });

  it('ignores a ref that is not a weapon_variant token, and junk keys', () => {
    const entries = shippedTable();
    const p = owner(['items@1:skin-rust-marine'], {
      [String(WeaponId.SHOTGUN)]: 'items@1:skin-rust-marine',
    });
    expect(variantSlotsFor(p, entries)[WeaponId.SHOTGUN]).toBe(0);
    expect(variantSlotsFor(null, entries).every((v) => v === 0)).toBe(true);
  });
});

/** The two shipped rows as defs, so a test can reorder them. */
function defsOf(): VariantDef[] {
  const text = readFileSync(join(REPO, 'content', 'variants.json'), 'utf8');
  const parsed = parseVariantsManifest(text);
  expect(parsed.errors).toEqual([]);
  return [...(parsed.manifest as VariantsManifest).variants];
}
