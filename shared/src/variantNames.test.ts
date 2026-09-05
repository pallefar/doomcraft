/**
 * DOOMCRAFT — V4d: DISPLAY TRUTH on the wire.
 *
 * Two additions and one rule.
 *
 *   1. `S2C.KILL` gains a NINTH byte, the variant slot the killing shot was
 *      FIRED with, and its decoder must accept eight-byte messages.
 *   2. `S2C.VARIANT_NAMES` carries `id -> name` for the rows this room pinned.
 *   3. A slot is resolved through THAT room's ordering, and a name that would
 *      label the wrong archetype is not shown.
 *
 * Everything here is about what a player is TOLD. Nothing on either wire
 * reaches a predictor, which is why every failure below degrades to the
 * archetype's name rather than refusing anything.
 */

import { describe, expect, it } from 'vitest';

import {
  createKillEvent, decodeKill, encodeKill, PacketReader, PacketWriter, S2C,
} from './protocol.ts';
import {
  createVariantNamesMessage, decodeVariantNames, encodeVariantNames,
  MAX_VARIANT_NAME, MAX_VARIANT_NAME_BYTES, MAX_VARIANT_NAMES_BYTES,
  MAX_VARIANT_TABLE_BYTES, MAX_VARIANTS_PER_PACK,
  parseVariantsManifest, variantDisplayName, variantNamesFor, wireEntriesFor,
  type VariantNameEntry, type VariantWireEntry,
} from './variants.ts';
import { MAX_CONTENT_ID_LENGTH } from './modes.ts';
import { WeaponId } from './weapons.ts';

/* ------------------------------------------------------------------------ *
 * Fixtures — two real rows, from content/variants.json's own shapes.
 * ------------------------------------------------------------------------ */

const SLUG = {
  id: 'shotgun-slug', base: WeaponId.SHOTGUN, name: 'Slug Shotgun',
  over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 },
};
const SWIFT = {
  id: 'rocket-swift', base: WeaponId.ROCKET, name: 'Swift Rocket',
  over: { damage: 82, rpm: 104, splashRadius: 3.8, projectileSpeed: 66 },
};

function tableOf(...rows: unknown[]): {
  entries: readonly VariantWireEntry[]; names: VariantNameEntry[];
} {
  const parsed = parseVariantsManifest(JSON.stringify({ variants: rows }));
  expect(parsed.errors).toEqual([]);
  expect(parsed.manifest).not.toBeNull();
  const manifest = parsed.manifest as NonNullable<typeof parsed.manifest>;
  const entries = wireEntriesFor(manifest);
  return { entries, names: variantNamesFor(manifest, entries) };
}

/** The map a client builds from a decoded names message. */
function mapOf(names: readonly VariantNameEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of names) m.set(e.id, e.name);
  return m;
}

/** Round-trip through the real wire, so nothing below tests an in-memory object. */
function overTheWire(names: readonly VariantNameEntry[]): Map<string, string> {
  const bytes = encodeVariantNames(new PacketWriter(MAX_VARIANT_NAMES_BYTES), names).copy();
  const out = decodeVariantNames(new PacketReader(bytes), createVariantNamesMessage());
  expect(out, 'a message this encoder wrote must decode').not.toBeNull();
  return mapOf((out as NonNullable<typeof out>).names);
}

/* ------------------------------------------------------------------------ *
 * 1. The ninth KILL byte
 * ------------------------------------------------------------------------ */

describe('the ninth KILL byte', () => {
  const w = new PacketWriter(32);

  it('carries the slot the shot was fired with, in one added byte', () => {
    const bytes = encodeKill(w, 4660, 22136, WeaponId.SHOTGUN, 0, 3, 2).copy();
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(S2C.KILL);
    expect(bytes[8]).toBe(2);

    const e = decodeKill(new PacketReader(bytes), createKillEvent());
    expect(e.killerId).toBe(4660);
    expect(e.victimId).toBe(22136);
    expect(e.weaponId).toBe(WeaponId.SHOTGUN);
    expect(e.killerStreak).toBe(3);
    expect(e.variantSlot).toBe(2);
  });

  it('leaves an OLD decoder reading its five fields and one byte unread — which '
    + 'is the whole claim that this costs no protocol bump', () => {
    const bytes = encodeKill(w, 4660, 22136, WeaponId.SHOTGUN, 0, 3, 2).copy();
    // The v3 decoder, spelled out: opcode, u16, u16, u8, u8, u8 and stop.
    const r = new PacketReader(bytes);
    r.u8();
    expect(r.u16()).toBe(4660);
    expect(r.u16()).toBe(22136);
    expect(r.u8()).toBe(WeaponId.SHOTGUN);
    expect(r.u8()).toBe(0);
    expect(r.u8()).toBe(3);
    expect(r.offset, 'the five fields end where they always did').toBe(8);
    expect(r.remaining, 'and exactly one byte is left over').toBe(1);
  });

  /*
   * THE RESET IS THE THING UNDER TEST, not the read.
   *
   * `decodeKill` mutates a caller-owned object and every caller in the tree
   * reuses one (`NetClient.kill`, and `createKillEvent()` in the server's own
   * tests). An eight-byte message is an OLD SERVER or a replayed capture; if
   * the absent byte merely left the field alone, the last kill by a variant
   * would rename every base-weapon kill after it.
   */
  it('an eight-byte KILL decodes as slot 0 into an object that already held 2', () => {
    const out = createKillEvent();

    const nine = encodeKill(w, 4660, 22136, WeaponId.SHOTGUN, 0, 3, 2).copy();
    decodeKill(new PacketReader(nine), out);
    expect(out.variantSlot, 'the object must really be dirty first').toBe(2);

    const eight = nine.slice(0, 8);
    expect(eight.length).toBe(8);
    decodeKill(new PacketReader(eight), out);

    expect(out.killerId, 'the five old fields still decode').toBe(4660);
    expect(out.victimId).toBe(22136);
    expect(out.weaponId).toBe(WeaponId.SHOTGUN);
    expect(out.killerStreak).toBe(3);
    expect(out.variantSlot, 'and the slot is RESET, not retained').toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The names message
 * ------------------------------------------------------------------------ */

describe('S2C.VARIANT_NAMES', () => {
  it('round-trips the room\'s rows, in the room\'s order', () => {
    const { entries, names } = tableOf(SLUG, SWIFT);
    expect(names).toEqual([
      { id: 'shotgun-slug', name: 'Slug Shotgun' },
      { id: 'rocket-swift', name: 'Swift Rocket' },
    ]);
    expect(names.map((n) => n.id)).toEqual(entries.map((e) => e.id));

    const bytes = encodeVariantNames(new PacketWriter(256), names).copy();
    expect(bytes[0]).toBe(S2C.VARIANT_NAMES);
    expect(bytes[1]).toBe(2);
    const out = decodeVariantNames(new PacketReader(bytes), createVariantNamesMessage());
    expect(out?.names).toEqual(names);
  });

  it('refuses a truncated message whole, and leaves `out` where it was', () => {
    const { names } = tableOf(SLUG, SWIFT);
    const bytes = encodeVariantNames(new PacketWriter(256), names).copy();
    const out = createVariantNamesMessage();
    expect(decodeVariantNames(new PacketReader(bytes), out)).not.toBeNull();
    const kept = out.names;

    for (let cut = 1; cut < bytes.length; cut++) {
      const short = bytes.slice(0, cut);
      expect(
        decodeVariantNames(new PacketReader(short), out),
        `${String(cut)} bytes of a ${String(bytes.length)}-byte message must refuse`,
      ).toBeNull();
      expect(out.names, 'a refusal touches nothing').toBe(kept);
    }
  });

  it('drops a name it would not render rather than refusing every OTHER row', () => {
    // A control character is refused at PARSE time (it forges the review
    // diff), so our own server can never send one. On the peer topology the
    // "server" is another player's browser and can send precisely these bytes.
    const w = new PacketWriter(256);
    const out = decodeVariantNames(new PacketReader(encodeVariantNames(w, [
      { id: 'shotgun-slug', name: 'Slug\nShotgun' },
      { id: 'rocket-swift', name: 'Swift Rocket' },
    ]).copy()), createVariantNamesMessage());
    expect(out?.names).toEqual([
      { id: 'shotgun-slug', name: '' },
      { id: 'rocket-swift', name: 'Swift Rocket' },
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The size budget — IN BYTES
 * ------------------------------------------------------------------------ */

describe('the names budget is measured in bytes, not in code units', () => {
  it('states its arithmetic and fits inside the table\'s budget', () => {
    expect(MAX_VARIANT_NAME).toBe(40);
    expect(MAX_VARIANT_NAME_BYTES).toBe(120);
    expect(MAX_VARIANT_NAMES_BYTES).toBe(10_882);
    expect(MAX_VARIANT_NAMES_BYTES).toBeLessThanOrEqual(MAX_VARIANT_TABLE_BYTES);
  });

  /*
   * `MAX_VARIANT_NAME` is 40 UTF-16 CODE UNITS and `parseVariantsManifest`
   * slices to it, so a forty-character CJK name is 120 UTF-8 BYTES. Budgeting
   * 40 truncates it at the thirteenth character — the exact units mistake
   * that cost V4b its 160-byte item-line cap, one phase ago.
   */
  it('carries the worst case whole: 64 rows, 48-character ids, 40 three-byte '
    + 'characters of name', () => {
    const names: VariantNameEntry[] = [];
    const longName = '中'.repeat(MAX_VARIANT_NAME);
    expect(longName.length).toBe(40);
    expect(new TextEncoder().encode(longName).length).toBe(120);

    for (let i = 0; i < MAX_VARIANTS_PER_PACK; i++) {
      const id = ('v' + String(i).padStart(2, '0') + 'a'.repeat(64)).slice(0, MAX_CONTENT_ID_LENGTH);
      expect(id.length).toBe(48);
      names.push({ id, name: longName });
    }

    const bytes = encodeVariantNames(new PacketWriter(64), names).copy();

    // The NAME first, because a truncated display string is the cost and the
    // byte count is only how it happens. A budget of 40 leaves 13 characters.
    const out = decodeVariantNames(new PacketReader(bytes), createVariantNamesMessage());
    expect(out?.names).toHaveLength(MAX_VARIANTS_PER_PACK);
    expect(out?.names[0].name).toBe(longName);
    expect(out?.names[63].name).toBe(longName);
    expect(out?.names[63].id).toBe(names[63].id);
    expect(bytes.length).toBe(MAX_VARIANT_NAMES_BYTES);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. Resolution — through the ROOM's ordering, and never onto another gun
 * ------------------------------------------------------------------------ */

describe('what the feed calls the gun', () => {
  it('names the variant the shot was fired with', () => {
    const { entries, names } = tableOf(SLUG, SWIFT);
    expect(variantDisplayName(entries, overTheWire(names), WeaponId.SHOTGUN, 1))
      .toBe('Slug Shotgun');
    expect(variantDisplayName(entries, overTheWire(names), WeaponId.ROCKET, 2))
      .toBe('Swift Rocket');
  });

  it('a client that never received a names message renders the BASE weapon\'s '
    + 'name — never a blank and never an id', () => {
    const { entries } = tableOf(SLUG, SWIFT);
    const none = new Map<string, string>();
    expect(variantDisplayName(entries, none, WeaponId.SHOTGUN, 1)).toBe('Shotgun');
    expect(variantDisplayName(entries, none, WeaponId.ROCKET, 2)).toBe('Rocket Launcher');
    // And with no table either — the room a client joins before anything lands.
    expect(variantDisplayName([], none, WeaponId.SHOTGUN, 1)).toBe('Shotgun');
  });

  it('slot 0 is the archetype, and so is a slot this table does not have', () => {
    const { entries, names } = tableOf(SLUG, SWIFT);
    const m = overTheWire(names);
    expect(variantDisplayName(entries, m, WeaponId.SHOTGUN, 0)).toBe('Shotgun');
    expect(variantDisplayName(entries, m, WeaponId.SHOTGUN, 3)).toBe('Shotgun');
    expect(variantDisplayName(entries, m, WeaponId.SHOTGUN, -1)).toBe('Shotgun');
    expect(variantDisplayName(entries, m, WeaponId.SHOTGUN, 1.5)).toBe('Shotgun');
  });

  /*
   * EVERY SLOT HOLDS EVERY WEAPON. `SessionArsenal.from` fills a slot with the
   * whole table and swaps in the overlay only for its own archetype, so a slot
   * number naming a row for a DIFFERENT gun is not a hole — the shot fires the
   * base weapon's numbers. Labelling it with that row's name prints a shotgun
   * variant over a rocket kill, which is a lie about the only thing this whole
   * message exists to tell the truth about.
   */
  it('refuses to label a shot with a row for another archetype', () => {
    const { entries, names } = tableOf(SLUG, SWIFT);
    const m = overTheWire(names);
    // Slot 2 is the ROCKET row. A shotgun kill arriving with it fires base
    // shotgun numbers, and must read as the base shotgun.
    expect(variantDisplayName(entries, m, WeaponId.SHOTGUN, 2)).toBe('Shotgun');
    expect(variantDisplayName(entries, m, WeaponId.ROCKET, 1)).toBe('Rocket Launcher');
  });

  /*
   * THE ORDERING IS THE ROOM'S. Two rooms pinned to tables holding the same
   * two rows in the opposite order give the slug DIFFERENT SLOT NUMBERS — 1
   * and 2 — and both must still say "Slug Shotgun". This is V4c's phase-
   * defining `+ 1` seen from the display side: an index resolved against any
   * other ordering names the other gun with no error anywhere.
   */
  it('two tables holding the same rows in opposite order name the same gun', () => {
    const a = tableOf(SLUG, SWIFT);
    const b = tableOf(SWIFT, SLUG);

    expect(a.entries[0].id).toBe('shotgun-slug');
    expect(b.entries[1].id).toBe('shotgun-slug');

    const inA = variantDisplayName(a.entries, overTheWire(a.names), WeaponId.SHOTGUN, 1);
    const inB = variantDisplayName(b.entries, overTheWire(b.names), WeaponId.SHOTGUN, 2);
    expect(inA).toBe('Slug Shotgun');
    expect(inB).toBe('Slug Shotgun');
    expect(inA).toBe(inB);

    // And the mirror: the rocket row, at the other two numbers.
    expect(variantDisplayName(a.entries, overTheWire(a.names), WeaponId.ROCKET, 2))
      .toBe('Swift Rocket');
    expect(variantDisplayName(b.entries, overTheWire(b.names), WeaponId.ROCKET, 1))
      .toBe('Swift Rocket');
  });
});
