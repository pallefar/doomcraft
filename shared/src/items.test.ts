/**
 * DOOMCRAFT — items: the parser refuses, the ref round-trips, and state is
 * derived, never stored (docs/PACKS.md §7, docs/ECONOMY.md Items).
 */

import { describe, expect, it } from 'vitest';

import {
  ITEM_KIND_NAMES,
  ItemKind,
  ItemRarity,
  MAX_ITEM_INPUT_BYTES,
  challengeGrantRefusal,
  formatItemRef,
  refIsWeaponVariant,
  itemStateFor,
  itemsFingerprintInputs,
  parseItemRef,
  parseItemsManifest,
  type ItemDef,
  type ItemsManifest,
} from './items.ts';
import { MAX_PACK_INPUT_BYTES } from './packs.ts';

/**
 * A hand-built manifest, bypassing the parser on purpose. Several proofs below
 * are about what the SERIALIZER would emit for input the parser now refuses —
 * "the collision this refusal prevents" — and there is no way to ask that
 * question through a door that has just been shut.
 */
const def = (over: Partial<ItemDef> = {}): ItemDef => ({
  id: 'a', kind: ItemKind.SKIN, name: 'A', rarity: ItemRarity.COMMON, tradable: false,
  tint: null, emissive: null, text: '', variantId: '', ...over,
});
const handBuilt = (...items: ItemDef[]): ItemsManifest => ({ items });

const good = (over: Record<string, unknown> = {}): string => JSON.stringify({
  items: [
    { id: 'skin-a', kind: 'skin', name: 'A', rarity: 'common', tradable: true, tint: [1, 1, 1] },
    { id: 'title-b', kind: 'title', name: 'B', rarity: 'rare', tradable: false, text: 'The B' },
    ...(Array.isArray(over.extra) ? over.extra : []),
  ],
});

describe('a manifest that is not an object', () => {
  // Found by an adversarial review of the V2 plan, which proposed copying this
  // parser: `JSON.parse('null')` succeeds, and the `root.items` access sat
  // outside the try, so the literal `null` threw a TypeError past every caller
  // instead of being refused. Reverting the guard makes this throw, not fail.
  it('is refused, not thrown past the caller', () => {
    for (const body of ['null', '5', '"a string"', 'true']) {
      const r = parseItemsManifest(body);
      expect(r.manifest, body).toBeNull();
      expect(r.errors, body).toEqual(['not a JSON object']);
    }
  });

  it('still calls an array with no items array exactly that', () => {
    expect(parseItemsManifest('{}').errors).toEqual(['no items array']);
    expect(parseItemsManifest('[]').errors).toEqual(['no items array']);
  });

  it('still refuses bytes that are not JSON at all', () => {
    expect(parseItemsManifest('{oh no').errors).toEqual(['not valid JSON']);
  });
});

describe('the manifest parser refuses instead of correcting', () => {
  it('parses a good manifest', () => {
    const r = parseItemsManifest(good());
    expect(r.errors).toEqual([]);
    expect(r.manifest?.items.length).toBe(2);
  });

  it('refuses a tradable title — proof of achievement, a trade would launder it', () => {
    const r = parseItemsManifest(JSON.stringify({
      items: [{ id: 'title-x', kind: 'title', name: 'X', rarity: 'epic', tradable: true, text: 'X' }],
    }));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('launder');
  });

  it('refuses a duplicate id, a non-canonical id, an unknown kind, an off-range tint, and a mute title', () => {
    for (const bad of [
      { id: 'skin-a', kind: 'skin', name: 'dup', rarity: 'common' },
      { id: 'Skin-B', kind: 'skin', name: 'case', rarity: 'common' },
      { id: 'skin-c', kind: 'hat', name: 'kind', rarity: 'common' },
      { id: 'skin-d', kind: 'skin', name: 'tint', rarity: 'common', tint: [9, 0, 0] },
      { id: 'title-c', kind: 'title', name: 'quiet', rarity: 'common', text: '' },
    ]) {
      const r = parseItemsManifest(good({ extra: [bad] }));
      if (bad.id === 'skin-d') {
        // An off-range tint is nulled, not fatal — the item still parses flat.
        expect(r.manifest?.items.find((i) => i.id === 'skin-d')?.tint).toBeNull();
      } else {
        expect(r.manifest, JSON.stringify(bad)).toBeNull();
      }
    }
  });
});

describe('refs and derived state', () => {
  it('round-trips a ref and refuses a malformed one', () => {
    const ref = formatItemRef(3, 'skin-a');
    expect(ref).toBe('items@3:skin-a');
    expect(parseItemRef(ref)).toEqual({ version: 3, localId: 'skin-a' });
    for (const bad of ['items@0:x', 'levels@1:x', 'items@1:UPPER', 'items@70000:x', 'junk']) {
      expect(parseItemRef(bad), bad).toBeNull();
    }
  });

  it('derives ACTIVE from the live pack, DORMANT from absence, REVOKED only from the operator', () => {
    const live = new Set(['skin-a']);
    const revoked = new Set(['items@1:skin-a']);
    expect(itemStateFor('items@1:skin-a', live, new Set())).toBe('active');
    // The granting VERSION is provenance: a v1 grant is active while the id
    // survives in the live pack, whatever version that is.
    expect(itemStateFor('items@9:skin-a', live, new Set())).toBe('active');
    expect(itemStateFor('items@1:skin-gone', live, new Set())).toBe('dormant');
    expect(itemStateFor('items@1:skin-a', live, revoked)).toBe('revoked');
    expect(itemStateFor('not-a-ref', live, new Set())).toBe('dormant');
  });

  it('fingerprint inputs are id-sorted so manifest order never moves the pack', () => {
    const a = parseItemsManifest(good()).manifest!;
    const swapped = parseItemsManifest(JSON.stringify({
      items: [
        { id: 'title-b', kind: 'title', name: 'B', rarity: 'rare', tradable: false, text: 'The B' },
        { id: 'skin-a', kind: 'skin', name: 'A', rarity: 'common', tradable: true, tint: [1, 1, 1] },
      ],
    })).manifest!;
    expect(itemsFingerprintInputs(a)).toEqual(itemsFingerprintInputs(swapped));
    expect(itemsFingerprintInputs(a)[1]).toContain('title-b');
    expect(ItemKind.TITLE).toBe(3);
  });
});

/* ------------------------------------------------------------------------ *
 * V4b — the weapon-variant ownership token, and four holes in the parser
 * that shipped beside it.
 * ------------------------------------------------------------------------ */

const oneItem = (over: Record<string, unknown>): string => JSON.stringify({
  items: [{ id: 'a', kind: 'skin', name: 'A', rarity: 'common', ...over }],
});

describe('V4b: the WEAPON_VARIANT kind is APPENDED, never inserted', () => {
  it('leaves every existing numeric kind and its serialized name exactly where it was', () => {
    // An inserted member would re-mean `ITEM_KIND_NAMES[kind]` for every item
    // line already on disk. These five numbers are load-bearing history.
    expect(ItemKind.SKIN).toBe(0);
    expect(ItemKind.EMBLEM).toBe(1);
    expect(ItemKind.TRAIL).toBe(2);
    expect(ItemKind.TITLE).toBe(3);
    expect(ItemKind.TROPHY).toBe(4);
    expect(ItemKind.WEAPON_VARIANT).toBe(5);
    expect(ITEM_KIND_NAMES).toEqual(['skin', 'emblem', 'trail', 'title', 'trophy', 'weapon_variant']);
  });

  it('accepts a token, and puts variantId between emissive and text', () => {
    const r = parseItemsManifest(JSON.stringify({
      items: [{
        id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
        rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
      }],
    }));
    expect(r.errors).toEqual([]);
    expect(itemsFingerprintInputs(r.manifest!)).toEqual([
      'weapon_variant-shotgun-slug:weapon_variant/uncommon/1/-/-/shotgun-slug//Slug Shotgun',
    ]);
    // And the column is emitted UNCONDITIONALLY, so a non-variant item's line
    // gains an empty one rather than the two encodings colliding.
    expect(itemsFingerprintInputs(handBuilt(def()))).toEqual(['a:skin/common/0/-/-///A']);
  });
});

describe('V4b: variantId is a biconditional, refused both ways', () => {
  // 15(a). Reverting the first half makes this parse with errors: [].
  it('refuses a weapon_variant with no variantId — the token would name nothing', () => {
    // The id is `weapon_variant-` on purpose: with an EMPTY variantId the id
    // rule below is satisfied (prefix + '' === the id), so this input isolates
    // this refusal instead of tripping over its neighbour. Without it a token
    // parses whose variantId names no row in the variants pack at all.
    const empty = parseItemsManifest(JSON.stringify({
      items: [{ id: 'weapon_variant-', kind: 'weapon_variant', name: 'V', rarity: 'uncommon' }],
    }));
    expect(empty.manifest).toBeNull();
    expect(empty.errors[0]).toContain('canonical variantId');

    for (const bad of [{}, { variantId: '' }, { variantId: 'Not Canonical' }, { variantId: 5 }]) {
      const r = parseItemsManifest(JSON.stringify({
        items: [{ id: 'wv-a', kind: 'weapon_variant', name: 'V', rarity: 'uncommon', ...bad }],
      }));
      expect(r.manifest, JSON.stringify(bad)).toBeNull();
    }
  });

  /*
   * The id prefix is a RULE, and it is a BICONDITIONAL. Two readers name a
   * variant's kind from a bare ref with no manifest in hand — `guessKind` in
   * the loadout (a DORMANT token, whose def is gone by definition) and
   * `grantDrops` (which has no pack registry and must not grow one) — so
   * "the id starts with weapon_variant-" and "the item is a WEAPON_VARIANT"
   * have to be the same statement, in both directions, or they drift.
   */
  it('requires a weapon_variant id to be exactly the prefix plus its variantId', () => {
    const r = parseItemsManifest(JSON.stringify({
      items: [{
        id: 'cool-gun', kind: 'weapon_variant', name: 'V', rarity: 'uncommon',
        variantId: 'shotgun-slug',
      }],
    }));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('weapon_variant-shotgun-slug');
    // A prefix with the WRONG row is refused too — the id is not a namespace.
    expect(parseItemsManifest(JSON.stringify({
      items: [{
        id: 'weapon_variant-rocket-swift', kind: 'weapon_variant', name: 'V',
        rarity: 'uncommon', variantId: 'shotgun-slug',
      }],
    })).manifest).toBeNull();
  });

  it('refuses the prefix on any other kind — the other direction of the same rule', () => {
    const r = parseItemsManifest(JSON.stringify({
      items: [{ id: 'weapon_variant-fake', kind: 'skin', name: 'S', rarity: 'common' }],
    }));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('id prefix');
    // Which is what makes `refIsWeaponVariant` exact for anything the parser
    // accepted — the predicate grantDrops decides mint-vs-transfer on.
    expect(refIsWeaponVariant('items@1:weapon_variant-shotgun-slug')).toBe(true);
    expect(refIsWeaponVariant('items@1:skin-rust-marine')).toBe(false);
    expect(refIsWeaponVariant('weapon_variant-shotgun-slug')).toBe(false); // not a ref
  });

  // 15(b). Reverting the second half makes this parse and SILENTLY DROP the
  // field, which is the terrainDamage lesson (8c6f196): a field whose author
  // believes it does something and which nothing reads.
  it('refuses a variantId on any other kind rather than dropping it', () => {
    for (const kind of ['skin', 'emblem', 'trail', 'trophy']) {
      const r = parseItemsManifest(JSON.stringify({
        items: [{ id: 'x', kind, name: 'X', rarity: 'common', variantId: 'shotgun-slug' }],
      }));
      expect(r.manifest, kind).toBeNull();
      expect(r.errors[0], kind).toContain('may not carry a variantId');
    }
  });
});

describe('V4b: the parse-time byte cap items never had', () => {
  /*
   * 15(c). The cap both sibling data packs already own. Without it an operator
   * authors a pack that parses clean, INSTALLS into an immutable version
   * directory, and is then refused by the release gate forever with no
   * author-time signal.
   */
  it('refuses an over-long line and names the constant, counting UTF-8 BYTES', () => {
    // THE INPUT IS CHOSEN SO THE TWO CANDIDATE IMPLEMENTATIONS DISAGREE.
    // `name` and `text` are sliced in UTF-16 CODE UNITS while the pack cap is
    // in UTF-8 BYTES, so this row is 238 bytes and 94 code units (237 and 93
    // before the variantId column added its separator): a `line.length <= 160`
    // check ACCEPTS it and the gate then refuses the version forever. The
    // obvious alternative input — a 48-char id with a CJK name AND text AND
    // six long floats — is 399 bytes and 255 code units, over BOTH caps, and
    // would have proven nothing about which one was used.
    const cjkName = '界'.repeat(48);
    const cjkText = '界'.repeat(24);
    const line = itemsFingerprintInputs(handBuilt(def({ name: cjkName, text: cjkText })))[0];
    expect(line.length, 'a .length check would ACCEPT this row').toBeLessThanOrEqual(MAX_ITEM_INPUT_BYTES);
    expect(line.length).toBe(94);

    const r = parseItemsManifest(JSON.stringify({
      items: [{ id: 'a', kind: 'skin', rarity: 'common', name: cjkName, text: cjkText }],
    }));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('238-byte pack input line');
    expect(r.errors[0]).toContain('MAX_PACK_INPUT_BYTES');
    // And the cap agrees with the pack registry's, so they cannot drift.
    expect(MAX_ITEM_INPUT_BYTES).toBe(MAX_PACK_INPUT_BYTES);
  });

  it('leaves an all-ASCII 48-character name inside the cap — a guard rail, not a budget', () => {
    expect(parseItemsManifest(oneItem({ name: 'A'.repeat(48) })).errors).toEqual([]);
  });
});

describe('V4b: one fingerprint line is one item', () => {
  /*
   * 15(d). The refusal is not the interesting half — the COLLISION it prevents
   * is (HANDOVER §0 rule 21: assert the downstream cost). The pack digest is
   * the input lines joined with newlines, so a name carrying its own newline
   * makes a TWO-item manifest reproduce the joined bytes of a THREE-item one,
   * byte for byte, and an operator approves a digest that means something else.
   */
  it('refuses a control character in name, and that is exactly the digest forgery it stops', () => {
    const forgedName = 'A\nb:skin/common/0/-/-///B';
    const forged = handBuilt(def({ id: 'a', name: forgedName }), def({ id: 'c', name: 'C' }));
    const honest = handBuilt(
      def({ id: 'a' }), def({ id: 'b', name: 'B' }), def({ id: 'c', name: 'C' }),
    );
    expect(forged.items.length).toBe(2);
    expect(honest.items.length).toBe(3);
    expect(itemsFingerprintInputs(forged).join('\n'))
      .toBe(itemsFingerprintInputs(honest).join('\n'));

    // ...and that two-item manifest cannot be authored.
    const r = parseItemsManifest(JSON.stringify({
      items: [
        { id: 'a', kind: 'skin', name: forgedName, rarity: 'common' },
        { id: 'c', kind: 'skin', name: 'C', rarity: 'common' },
      ],
    }));
    expect(r.manifest, 'a name with a newline forges the review diff').toBeNull();
    expect(r.errors[0]).toContain('control character');
  });

  it('refuses the quieter C0 characters and DEL, in name and in text', () => {
    for (const ch of ['\u0000', '\t', '\r', '\u001f', '\u007f']) {
      const n = parseItemsManifest(oneItem({ name: `A${ch}B` }));
      expect(n.manifest, JSON.stringify(ch)).toBeNull();
      expect(n.errors[0], JSON.stringify(ch)).toContain('control character');
      const t = parseItemsManifest(oneItem({ kind: 'title', text: `T${ch}X` }));
      expect(t.manifest, JSON.stringify(ch)).toBeNull();
      expect(t.errors[0], JSON.stringify(ch)).toContain('control character');
    }
  });
});

describe('V4b: only ONE terminal free-form token', () => {
  /*
   * 15(e). `text` and `name` both trailed the line and both were free-form, so
   * the boundary between them was decided by the FIRST slash — which either
   * could contain. Measured on the shipped parser: the two manifests below
   * serialized to the identical line while the loadout rendered a different
   * item name.
   */
  it('refuses a slash in text — two free-form tokens either side of one collide', () => {
    const a = handBuilt(def({ text: 'Alpha/Beta', name: 'Gamma' }));
    const b = handBuilt(def({ text: 'Alpha', name: 'Beta/Gamma' }));
    expect(itemsFingerprintInputs(a)).toEqual(itemsFingerprintInputs(b));
    expect(itemsFingerprintInputs(a)[0]).toBe('a:skin/common/0/-/-//Alpha/Beta/Gamma');

    const refused = parseItemsManifest(oneItem({ kind: 'title', text: 'Alpha/Beta' }));
    expect(refused.manifest).toBeNull();
    expect(refused.errors[0]).toContain('may not contain "/"');

    // The other one stays legal: `name` is TERMINAL, so a slash in it is
    // unambiguous — the reader takes everything after the last column and
    // stops. Refusing it too would be a rule the format does not need.
    expect(parseItemsManifest(oneItem({ name: 'Beta/Gamma' })).errors).toEqual([]);
  });
});

describe('V4b: an inherited Object.prototype member is not a kind (fix 8c6f196, in items)', () => {
  /*
   * Clause 21 — a defect in SHIPPED code, not in the new column.
   * `KIND_BY_NAME[str]` finds inherited members, so `kind: "constructor"`
   * yielded a FUNCTION, which is not `undefined`, and the guard passed it.
   * MEASURED on the shipped parser: `errors: []`,
   * `typeof manifest.items[0].kind === "function"`, and a fingerprint line of
   * `a:undefined/common/0/-/-//A` — byte-identical to the one `kind:"toString"`
   * produced. Two different manifests, one digest, and `undefined` served to
   * the client as a kind name. `rarity: "constructor"` gave
   * `a:skin/undefined/0/-/-//A` the same way.
   */
  for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    it(`refuses kind "${poison}" and rarity "${poison}"`, () => {
      const k = parseItemsManifest(oneItem({ kind: poison }));
      expect(k.manifest, `kind ${poison}`).toBeNull();
      expect(k.errors[0]).toContain('unknown kind');

      const rr = parseItemsManifest(oneItem({ rarity: poison }));
      expect(rr.manifest, `rarity ${poison}`).toBeNull();
      expect(rr.errors[0]).toContain('unknown rarity');
    });
  }

  it('kills the collision itself: two manifests that shared one digest now both refuse', () => {
    const a = parseItemsManifest(oneItem({ kind: 'constructor' }));
    const b = parseItemsManifest(oneItem({ kind: 'toString' }));
    expect([a.manifest, b.manifest]).toEqual([null, null]);
  });
});

describe('V4b: a challenge may not mint a weapon variant', () => {
  it('is ONE predicate, so the studio and the gate cannot disagree about it', () => {
    const items = parseItemsManifest(JSON.stringify({
      items: [
        { id: 'skin-a', kind: 'skin', name: 'A', rarity: 'common', tradable: true },
        { id: 'title-b', kind: 'title', name: 'B', rarity: 'rare', text: 'B' },
        { id: 'trophy-c', kind: 'trophy', name: 'C', rarity: 'epic' },
        {
          id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
          rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
        },
      ],
    })).manifest!;
    const refusals = items.items.map((i) => [i.id, challengeGrantRefusal(i) !== null] as const);
    expect(refusals).toEqual([
      ['skin-a', false], ['title-b', false], ['trophy-c', false],
      ['weapon_variant-shotgun-slug', true],
    ]);
    expect(challengeGrantRefusal(items.items[3])).toContain('craft-only');
  });
});
