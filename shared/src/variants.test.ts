/**
 * The V2 gate, and the adversarial proof docs/VARIANTS.md §5 demands of it:
 * take a REAL variant row, mutate ONE field to turn it into an upgrade, and
 * watch the check bite.
 *
 * Almost every case below is an attack that a reviewer of the V2 PLAN
 * constructed against an earlier version of this schema, before any of it was
 * written. Each one had a concrete consequence — a NaN that refused every
 * pistol variant ever written, a plasma variant collecting 20% real damage for
 * a drawback the engine never applies, a `terrainDamage` that hangs the server
 * forever. They are kept here in the shape they arrived in.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  applyOver, BUDGET_TOLERANCE, isInert, MAX_VARIANT_INPUT_BYTES, MAX_VARIANT_NAME,
  MAX_VARIANTS_PER_PACK,
  parseVariantsManifest, scoreVariant, VARIANT_FIELDS, variantsFingerprintInputs,
  type VariantField,
} from './variants.ts';
import { MAX_PACK_INPUT_BYTES, variantsPack } from './packs.ts';
import {
  bandEdgesFor, createVariantTableMessage, decodeVariantTable, encodeVariantTable,
  HOT_NARROWING, MAX_VARIANT_TABLE_BYTES, narrowedValueOf, overlaysFromWire, wireEntriesFor,
  type VariantsManifest,
} from './variants.ts';
import { FireKind, WEAPON_COUNT, WeaponId, WEAPONS, type WeaponDef } from './weapons.ts';
import { PacketReader, PacketWriter } from './protocol.ts';
import { damageAtDistanceOf, SessionArsenal } from './arsenal.ts';
// The end-to-end case needs a REAL room, because the empty-table failure this
// file's last section is about lives in `decodeRoomVariantTable`'s
// `decoded === null ? [] : ...` and nowhere else. See the note above
// `describe('a manifest the parser accepts reaches a real Room')`.

const IDS = Array.from({ length: WEAPON_COUNT }, (_, i) => i);

function parse(...variants: unknown[]): ReturnType<typeof parseVariantsManifest> {
  return parseVariantsManifest(JSON.stringify({ variants }));
}
function one(over: Record<string, number>, base = WeaponId.PISTOL, id = 'probe'): ReturnType<typeof parseVariantsManifest> {
  return parse({ id, base, name: 'Probe', over });
}
function refusal(r: ReturnType<typeof parseVariantsManifest>): string {
  expect(r.manifest, `expected a refusal, got a manifest`).toBeNull();
  return r.errors.join(' | ');
}

/* ------------------------------------------------------------------------ *
 * The budget is defined for every archetype
 * ------------------------------------------------------------------------ */

describe('the power budget on the real weapon table', () => {
  it('scores every base against itself at exactly 1, with no NaN anywhere', () => {
    // The whole reason the axes are per-archetype. Four of the seven weapons
    // have no splash, so a fixed four-axis budget computes 0/0 for them — and
    // `Math.abs(NaN) <= 0.12` is FALSE, so the naive version would have
    // refused every pistol, shotgun, chaingun and chainsaw variant ever
    // written rather than accepting a bad one.
    for (const id of IDS) {
      const w = WEAPONS[id];
      const r = scoreVariant(w, w);
      expect(Number.isNaN(r.budget), `${w.short} budget is NaN`).toBe(false);
      expect(r.budget).toBeCloseTo(1, 12);
      expect(r.withinBand).toBe(true);
      expect(r.dominates).toBe(false);
      for (const a of r.axes) {
        expect(Number.isFinite(a.ratio), `${w.short} ${a.axis} ratio`).toBe(true);
        expect(a.ratio).toBeCloseTo(1, 12);
      }
      expect(r.axes.length, `${w.short} scored on no axis at all`).toBeGreaterThan(0);
    }
  });

  it('drops exactly the axes each archetype does not have', () => {
    const axesOf = (id: number): string[] =>
      scoreVariant(WEAPONS[id], WEAPONS[id]).axes.map((a) => a.axis).sort();

    // Hitscan: no splash on any of them.
    expect(axesOf(WeaponId.PISTOL)).toEqual(['dps', 'handling', 'range']);
    expect(axesOf(WeaponId.SHOTGUN)).toEqual(['dps', 'handling', 'range']);
    // Projectile: range is dropped because direct damage is stored at spawn
    // and falloff never runs on it.
    expect(axesOf(WeaponId.ROCKET)).toEqual(['dps', 'handling', 'splash']);
    expect(axesOf(WeaponId.BFG)).toEqual(['dps', 'handling', 'splash']);
    // Melee: no magazine, no cone, no projectile — so no handling sub-term
    // applies at all, and no splash.
    expect(axesOf(WeaponId.CHAINSAW)).toEqual(['dps', 'range']);
  });
});

/* ------------------------------------------------------------------------ *
 * It accepts the variants the design was written to describe
 * ------------------------------------------------------------------------ */

describe('a gate that can pass', () => {
  // A check that refuses everything is as broken as one that accepts
  // everything, and the first draft of this budget refused all four hitscan
  // archetypes by accident. These two are the documented targets.
  const SLUG = {
    id: 'shotgun-slug', base: WeaponId.SHOTGUN, name: 'Slug Shotgun',
    over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 },
  };
  const BURST = {
    id: 'pistol-burst', base: WeaponId.PISTOL, name: 'Burst Pistol',
    over: { rpm: 620, damage: 12 },
  };

  it("accepts docs/VARIANTS.md §1's slug shotgun, verbatim", () => {
    const r = parse(SLUG);
    expect(r.errors).toEqual([]);
    expect(r.manifest?.variants[0].id).toBe('shotgun-slug');
  });

  it('accepts the burst pistol', () => {
    expect(parse(BURST).errors).toEqual([]);
  });

  it('accepts them together and keeps both', () => {
    const r = parse(SLUG, BURST);
    expect(r.errors).toEqual([]);
    expect(r.manifest?.variants.length).toBe(2);
  });
});

/* ------------------------------------------------------------------------ *
 * Counterfeit currency
 * ------------------------------------------------------------------------ */

describe('a variant may not pay in currency the engine does not spend', () => {
  it('refuses a projectile paying with falloff, which never runs on it', () => {
    // The review's sharpest find: plasma direct damage is stored at spawn in
    // `projDamage` and falloff is never applied to it, so `{ damage: 25.2,
    // falloffStart: 0, falloffMin: 0 }` scored a budget of exactly 1.0 while
    // collecting a 20% real damage increase.
    const e = refusal(one({ damage: 25.2, falloffStart: 0, falloffMin: 0 }, WeaponId.PLASMA));
    expect(e).toContain('falloffStart does nothing on Plasma Rifle');
    expect(e).toContain('stores its damage at spawn');
  });

  it('refuses a shell-reloader paying with reloadMs, which it never reads', () => {
    // The shotgun reloads on `reloadShellMs`. Doubling `reloadMs` from 2400 to
    // 4800 lowered the computed DPS from 70 to 55 and changed the actual
    // reload by nothing at all.
    const e = refusal(one({ reloadMs: 4800, damage: 13 }, WeaponId.SHOTGUN));
    expect(e).toContain('reloadMs does nothing on Shotgun');
    expect(e).toContain('reloadShellMs');
  });

  it('refuses every inert field on every archetype that cannot read it', () => {
    for (const id of IDS) {
      const base = WEAPONS[id];
      for (const f of VARIANT_FIELDS) {
        if (!isInert(base, f)) continue;
        const e = refusal(one({ [f]: (base[f] as number) || 1 }, id, `x-${id}-${f.toLowerCase()}`));
        expect(e, `${base.short}/${f}`).toContain(`${f} does nothing on ${base.name}`);
      }
    }
  });

  it('agrees with the firing path about what is inert', () => {
    // Spot checks against what the two predictors actually read, so this table
    // is anchored to code and not to the type declaration.
    expect(isInert(WEAPONS[WeaponId.ROCKET], 'pellets')).toBe(true);        // fires once
    expect(isInert(WEAPONS[WeaponId.CHAINSAW], 'headshotMultiplier')).toBe(true); // resolveMelee has no head test
    expect(isInert(WEAPONS[WeaponId.CHAINSAW], 'spread')).toBe(true);       // melee has no cone
    expect(isInert(WEAPONS[WeaponId.PISTOL], 'projectileSpeed')).toBe(true);
    expect(isInert(WEAPONS[WeaponId.PISTOL], 'splashRadius')).toBe(true);
    // And the live ones stay live.
    expect(isInert(WEAPONS[WeaponId.SHOTGUN], 'pellets')).toBe(false);
    expect(isInert(WEAPONS[WeaponId.PISTOL], 'reloadMs')).toBe(false);
    expect(isInert(WEAPONS[WeaponId.CHAINSAW], 'falloffEnd')).toBe(false);  // resolveMelee DOES apply falloff
    expect(isInert(WEAPONS[WeaponId.ROCKET], 'projectileSpeed')).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Straight upgrades
 * ------------------------------------------------------------------------ */

describe('no straight upgrades', () => {
  it('refuses an "everything up 10%" variant on the BAND', () => {
    // The hazard the user spotted in the decision itself: a weighted sum with
    // a ±12% band admits a variant that is 10% better at everything.
    const e = refusal(one({ damage: 18.7, rpm: 462, magSize: 17 }));
    expect(e).toContain('power budget');
    expect(e).toContain('outside ±12%');
  });

  it('refuses a free upgrade the BAND alone would have allowed', () => {
    // Rocket speed 46 -> 73.6 is inside its band and moves only one sub-term,
    // so the budget lands at +3.75% — comfortably inside ±12%. Dominance is
    // the only thing that catches it, which is why it exists.
    const r = one({ projectileSpeed: 73.6 }, WeaponId.ROCKET);
    const report = scoreVariant(
      WEAPONS[WeaponId.ROCKET],
      applyOver(WEAPONS[WeaponId.ROCKET], { projectileSpeed: 73.6 }),
    );
    expect(report.withinBand, 'the band alone must NOT catch this').toBe(true);
    expect(Math.abs(report.delta)).toBeLessThan(BUDGET_TOLERANCE);
    expect(report.dominates).toBe(true);
    expect(refusal(r)).toContain('better than Rocket Launcher on every axis');
  });

  it('THE ADVERSARIAL PROOF: one field of a real accepted row turns it upgrade', () => {
    // docs/VARIANTS.md §5's requirement, exactly: take a real row that passes,
    // move ONE number to make it strictly better, and watch the check bite.
    const real = {
      id: 'pistol-burst', base: WeaponId.PISTOL, name: 'Burst Pistol',
      over: { rpm: 620, damage: 12 },
    };
    expect(parse(real).errors, 'the real row must pass first').toEqual([]);

    // Its whole drawback is the damage cut. Undo it and nothing is paid.
    const upgraded = { ...real, over: { rpm: 620, damage: 17 } };
    const e = refusal(parse(upgraded));
    expect(e).toMatch(/power budget|better than Pistol on every axis/);
  });

  it('accepts a real sidegrade — worse somewhere, better somewhere', () => {
    const r = one({ rpm: 620, damage: 12 });
    expect(r.errors).toEqual([]);
    const report = scoreVariant(WEAPONS[WeaponId.PISTOL], applyOver(WEAPONS[WeaponId.PISTOL], { rpm: 620, damage: 12 }));
    expect(report.dominates).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Bands, counts and the engine hazards behind them
 * ------------------------------------------------------------------------ */

describe('bands', () => {
  it('does not sell terrainDamage at all — no axis can charge for it', () => {
    /*
     * It was on the whitelist and banded, and that was not enough: it belongs
     * to no budget axis, so `{ terrainDamage: 3.9 }` on a rocket scored a
     * budget of exactly 1.0 with no dominance and bought a carve radius of
     * 2.6 m -> 3.9 m for nothing. A field the budget cannot charge for is not
     * a sidegrade dimension.
     *
     * Removing it also takes the `carveSphere` non-termination hazard off the
     * surface rather than merely banding it away: that loop is
     * `for (let y = y0; y <= y1; y++)` from `floor(cy - radius)`, and at 1e20
     * the counter cannot advance at all.
     */
    expect(-1e20 + 1).toBe(-1e20);
    expect(VARIANT_FIELDS).not.toContain('terrainDamage');
    for (const value of [3.9, 1e20]) {
      for (const base of [WeaponId.ROCKET, WeaponId.PLASMA, WeaponId.PISTOL]) {
        expect(refusal(one({ terrainDamage: value }, base, `td-${base}`)))
          .toContain('"terrainDamage" is not a variant-able field');
      }
    }
  });

  it('refuses an INHERITED property instead of throwing on it', () => {
    // `JSON.parse('{"toString":1}')` gives an OWN key that `Object.keys`
    // returns, and `BANDS.toString` finds Object.prototype's method — not
    // undefined — so the whitelist admitted it and the band read threw
    // "Cannot read properties of undefined (reading '0')" out of both
    // `checkVariantsValidate` and `variantsAt`.
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      const r = parseVariantsManifest(
        `{"variants":[{"id":"proto","base":0,"name":"X","over":{"${key}":1}}]}`);
      expect(r.manifest, key).toBeNull();
      expect(r.errors.join(' '), key).toContain(`"${key}" is not a variant-able field`);
    }
  });

  it('bands EVERY whitelisted field — none is left open', () => {
    for (const f of VARIANT_FIELDS) {
      // Find an archetype the field is live on, and prove a huge value is refused.
      const id = IDS.find((i) => !isInert(WEAPONS[i], f));
      expect(id, `${f} is inert everywhere — it should not be whitelisted`).toBeDefined();
      const e = refusal(one({ [f]: 1e9 }, id as number, `big-${f.toLowerCase()}`));
      expect(e, `${f} accepted 1e9`).not.toBe('');
    }
  });

  it('refuses a fractional pellet count, which desyncs the predictors', () => {
    // `pellets: 1.5` is inside 1..12. The server loops `i < def.pellets` and
    // fires TWICE; the client reads the u8-narrowed `hot.pellets` and fires
    // once.
    expect(refusal(one({ pellets: 1.5 }, WeaponId.SHOTGUN))).toContain('whole number');
  });

  it('refuses a fractional magazine, which destroys ammunition on reload', () => {
    // `magSize: 7.5` with a magazine of 7 computes a transfer of 0.5, and the
    // typed arrays resolve that as one round leaving the reserve and none
    // arriving in the magazine.
    expect(refusal(one({ magSize: 7.5 }))).toContain('whole number');
  });

  it('bands the PAYLOAD, not damage alone', () => {
    // damage × pellets is the only meaningful quantity: §1's slug is 5.6× the
    // per-pellet damage and 0.8× the per-shot payload.
    expect(refusal(one({ pellets: 1, damage: 200 }, WeaponId.SHOTGUN))).toContain('per-shot payload');
    expect(one({ pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 }, WeaponId.SHOTGUN).errors)
      .toEqual([]);
  });

  it('cannot add an axis the archetype does not have, without a special case', () => {
    // A relative band times a base of zero is zero, so the rail does this for
    // free — but it is load-bearing, so it is asserted.
    expect(refusal(one({ splashRadius: 3 }))).toContain('splashRadius');
  });
});

/* ------------------------------------------------------------------------ *
 * Every refusal the parser can make is reachable
 * ------------------------------------------------------------------------ */

describe('refusals', () => {
  it('is not a JSON object', () => {
    for (const body of ['null', '5', '"a string"', 'true']) {
      expect(parseVariantsManifest(body).errors, body).toEqual(['not a JSON object']);
    }
  });
  it('is not JSON at all', () => {
    expect(parseVariantsManifest('{oh no').errors).toEqual(['not valid JSON']);
  });
  it('has no variants array', () => {
    expect(parseVariantsManifest('{}').errors).toEqual(['no variants array']);
  });
  it('is over the cap', () => {
    const many = Array.from({ length: MAX_VARIANTS_PER_PACK + 1 }, (_, i) =>
      ({ id: `v${i}`, base: 0, name: 'x', over: { rpm: 400 } }));
    expect(refusal(parse(...many))).toContain(`over the ${MAX_VARIANTS_PER_PACK} cap`);
  });
  it('has a non-slug id', () => {
    expect(refusal(parse({ id: 'Not A Slug!', base: 0, name: 'x', over: { rpm: 400 } })))
      .toContain('is not a canonical slug');
  });
  it('has a duplicate id', () => {
    const v = { id: 'twice', base: 0, name: 'x', over: { rpm: 400 } };
    expect(refusal(parse(v, v))).toContain('duplicate variant id');
  });
  it('names a base that is not a WeaponId', () => {
    for (const base of [-1, WEAPON_COUNT, 1.5, 'shotgun']) {
      expect(refusal(parse({ id: 'b', base, name: 'x', over: { rpm: 400 } })))
        .toContain('is not a WeaponId');
    }
  });
  it('has no display name', () => {
    expect(refusal(parse({ id: 'n', base: 0, over: { rpm: 400 } }))).toContain('no display name');
  });
  it('has no over object', () => {
    expect(refusal(parse({ id: 'o', base: 0, name: 'x' }))).toContain('no over object');
    expect(refusal(parse({ id: 'o', base: 0, name: 'x', over: [] }))).toContain('no over object');
  });
  it('overrides nothing', () => {
    expect(refusal(parse({ id: 'e', base: 0, name: 'x', over: {} }))).toContain('overrides nothing');
  });
  it('names a field outside the whitelist — refused, never ignored', () => {
    // Silently dropping it would ship a stat line whose author believes it
    // does something. `switchInMs` is a feel field and deliberately not
    // variant-able (§1.2).
    expect(refusal(one({ switchInMs: 100 } as unknown as Record<string, number>)))
      .toContain('"switchInMs" is not a variant-able field');
  });
  it('gives a non-finite number', () => {
    for (const bad of ['NaN', 'Infinity']) {
      const r = parseVariantsManifest(
        `{"variants":[{"id":"f","base":0,"name":"x","over":{"rpm":${bad}}}]}`);
      // NaN/Infinity are not valid JSON literals, so this is a parse refusal —
      // which is itself the point: they cannot reach the number path from a file.
      expect(r.manifest).toBeNull();
    }
    // They CAN reach it from a hand-built object, so the guard is real.
    expect(refusal(one({ rpm: Number.POSITIVE_INFINITY }))).toContain('not a finite number');
  });
  it('collects every error rather than stopping at the first', () => {
    const r = parse(
      { id: 'Bad Id', base: 0, name: 'x', over: { rpm: 400 } },
      { id: 'noname', base: 0, over: { rpm: 400 } },
    );
    expect(r.errors.length).toBe(2);
    expect(r.manifest).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * Fingerprint
 * ------------------------------------------------------------------------ */

describe('fingerprint inputs', () => {
  const rows = [
    { id: 'zebra', base: WeaponId.PISTOL, name: 'Z', over: { rpm: 620, damage: 12 } },
    { id: 'alpha', base: WeaponId.PISTOL, name: 'A', over: { rpm: 620, damage: 12 } },
  ];

  it('are id-sorted, so a reordered file is not a diff', () => {
    const a = variantsFingerprintInputs(parse(...rows).manifest!);
    const b = variantsFingerprintInputs(parse(...[...rows].reverse()).manifest!);
    expect(a).toEqual(b);
    expect(a[0].startsWith('alpha:')).toBe(true);
  });

  it('carry every whitelisted field, so a removed override reads as a change', () => {
    const with2 = variantsFingerprintInputs(parse(rows[0]).manifest!)[0];
    const with1 = variantsFingerprintInputs(
      parse({ ...rows[0], over: { rpm: 620, damage: 13 } }).manifest!)[0];
    expect(with2).not.toBe(with1);
    // One column per field, plus the id:base prefix.
    expect(with2.split('/')[1].split(',').length).toBe(VARIANT_FIELDS.length);
  });

  it('move the pack IDENTITY when only the NAME changes', () => {
    /* The adversarial case, kept in the shape it arrived in: take a real row,
     * rename it, change nothing else. Before 2026-09-05 the name was not in
     * the line at all, so the fingerprint stayed 351436725 and the digest
     * stayed 20d02f7f82cdc39c70e13ae66a9597830f1785f016f088a07b9264649b186f6f
     * — an operator could review and approve one display string while the
     * host served another, with nothing in the diff to see it by. V4 puts
     * that string on the HUD and the killfeed.
     *
     * The assertion is the DOWNSTREAM COST, not that the name appears in the
     * line. A token can be present and still be inert; what has to move is
     * what `server/src/packs.ts:234` builds out of these lines — the u32 the
     * release document pins, and the sha256 the console shows.
     */
    const identity = (name: string) => {
      const r = parse({
        id: 'four-shell', base: WeaponId.SHOTGUN, name, over: { magSize: 4, damage: 10 },
      });
      expect(r.errors).toEqual([]);
      const inputs = variantsFingerprintInputs(r.manifest!);
      return {
        inputs,
        fingerprint: variantsPack(inputs, 1).fingerprint,
        digest: createHash('sha256').update(inputs.join('\n'), 'utf8').digest('hex'),
      };
    };
    const before = identity('Four Shell');
    const after = identity('Renamed');
    expect(after.inputs).not.toEqual(before.inputs);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.digest).not.toBe(before.digest);
    // And ONLY the name moved: everything before the last `/` is byte-identical,
    // so the reviewer reads a rename instead of sixteen numbers shifting. This
    // is what fails if the name is ever put anywhere but the end of the line.
    const cut = (l: string) => l.slice(0, l.lastIndexOf('/'));
    expect(cut(after.inputs[0])).toBe(cut(before.inputs[0]));
  });

  it('cannot be forged by a name that carries its own newline', () => {
    /* The digest is `inputs.join('\n')`, so a line break inside a name stops
     * being one token in one record. If this parsed, a ONE-variant manifest
     * would hash exactly as a TWO-variant one, and the review diff would show
     * a row nobody wrote. Refused at the door rather than stripped, because a
     * stripped name is a display string the author never wrote and never sees
     * — the same failure the line above exists to close.
     */
    const r = parse({
      id: 'probe', base: WeaponId.PISTOL, name: 'X\nghost:0/9', over: { rpm: 620, damage: 12 },
    });
    expect(refusal(r)).toContain('control character');
    // Nothing the parser DOES accept can hold one, so no line ever splits.
    const ok = parse({ id: 'probe', base: WeaponId.PISTOL, name: 'X', over: { rpm: 620, damage: 12 } });
    expect(variantsFingerprintInputs(ok.manifest!)[0]).not.toContain('\n');
  });

  it('refuse a row whose line overflows ONE pack input line', () => {
    /* Legal on every other axis — it is the worst-case row below with the
     * longest name `MAX_VARIANT_NAME` allows — and 172 bytes long. Nothing
     * warned about this before: `checkPackInputs` runs in both release gates
     * over the assembled pack set, and a version directory is immutable, so
     * the author would have baked a version that can never be published and
     * can never be edited in place.
     */
    const r = parse({
      id: 'a'.repeat(48), base: WeaponId.PLASMA, name: 'N'.repeat(MAX_VARIANT_NAME),
      over: { damage: 20.900000000000002, splashDamage: 8.100000000000001, rpm: 660.0000000000001 },
    });
    const said = refusal(r);
    expect(said).toContain('172-byte pack input line');
    expect(said).toContain('MAX_PACK_INPUT_BYTES');
  });

  it('cap the line at exactly what the release gate caps it at', () => {
    /* The drift guard `challenges.test.ts` keeps over its own mirror, and it
     * gets its OWN test on purpose: folded into the refusal case above it
     * would sit after two assertions that a drifted constant already fails,
     * so the drift would never be the thing the report names. A copy of a
     * constant that no test compares is a constant with two values.
     */
    expect(MAX_VARIANT_INPUT_BYTES).toBe(MAX_PACK_INPUT_BYTES);
  });

  it('take a REALISTIC row at BOTH limits — a gate that cannot pass is worth what one that cannot fail is worth', () => {
    /* The other direction, and the one that decides whether the cap is a
     * guard rail or a tax the author has to budget against: the longest id
     * the schema allows (48, MAX_CONTENT_ID_LENGTH), the longest name it
     * allows, and six overrides at the precision a human actually types. It
     * parses, it goes on the wire, it comes back, and its line still has
     * room. Only unrounded float noise at both limits at once trips the cap.
     */
    const id = 'a'.repeat(48);
    const name = 'N'.repeat(MAX_VARIANT_NAME);
    const row = {
      id, base: WeaponId.SHOTGUN, name,
      over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 },
    };
    const r = parse(row);
    expect(r.errors).toEqual([]);
    const line = variantsFingerprintInputs(r.manifest!)[0];
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_VARIANT_INPUT_BYTES);
    expect(line.endsWith(`/${name}`)).toBe(true);
    /* And the wire is untouched by any of it. The parser's length rule is an
     * AUTHORING constraint on a review artifact; the table carries no id
     * length and no name at all, so there is nothing for `decodeVariantTable`
     * to check and no manifest this refuses that the decoder would have
     * taken. The "anything the parser accepts, the decoder accepts" invariant
     * is about VALUES, and this row proves the long end of it still holds.
     */
    const { bytes } = wire(row);
    const m = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage())!;
    expect(m.variants[0].id).toBe(id);
    const arsenal = SessionArsenal.from(overlaysFromWire(m.variants));
    expect(arsenal.statsFor(WeaponId.SHOTGUN, 1).pellets).toBe(1);
    expect(arsenal.statsFor(WeaponId.SHOTGUN, 1).damage).toBe(62);
  });

  it('fit the release gate\'s 160-byte cap at the worst case', () => {
    // A 48-character content id (the limit) and the ugliest floats a valid
    // row can hold. The review built a 163-byte line against an earlier
    // encoding; this one is the reason the fields are positional.
    const id = 'a'.repeat(48);
    const r = parse({
      id, base: WeaponId.PLASMA, name: 'X',
      over: { damage: 20.900000000000002, splashDamage: 8.100000000000001, rpm: 660.0000000000001 },
    });
    expect(r.errors).toEqual([]);
    const line = variantsFingerprintInputs(r.manifest!)[0];
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(160);
  });
});

/* ------------------------------------------------------------------------ *
 * The wire — V3
 *
 * The claim under test is not "it round-trips". It is that a SERVER and a
 * CLIENT that build their arsenals from the same bytes hold the same numbers,
 * including the narrowed `hot` reads, including the fields a variant never
 * touched. That is what `fc01475` cost five separate fixes to establish for
 * the cone, and this is the same property one layer down.
 * ------------------------------------------------------------------------ */

const SLUG = {
  id: 'slug-shotgun', base: WeaponId.SHOTGUN, name: 'Slug Shotgun',
  over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, rpm: 42 },
};
const RK = { id: 'heavy-rocket', base: WeaponId.ROCKET, name: 'Heavy', over: { rpm: 80 } };

function wire(...variants: unknown[]): { entries: ReturnType<typeof wireEntriesFor>; bytes: Uint8Array } {
  const r = parse(...variants);
  expect(r.errors).toEqual([]);
  const entries = wireEntriesFor(r.manifest!);
  const w = encodeVariantTable(
    new PacketWriter(MAX_VARIANT_TABLE_BYTES), entries, new Uint8Array(WEAPON_COUNT),
  );
  return { entries, bytes: w.copy() };
}

describe('the room table on the wire', () => {
  it('gives a server and a client the SAME numbers, hot reads included', () => {
    const { bytes } = wire(SLUG, RK);
    // Two INDEPENDENT decodes, as the two ends really do it.
    const a = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage());
    const b = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage());
    const server = SessionArsenal.from(overlaysFromWire(a!.variants));
    const client = SessionArsenal.from(overlaysFromWire(b!.variants));
    expect(server.slotCount).toBe(3);
    for (let slot = 0; slot < server.slotCount; slot++) {
      for (let id = 0; id < WEAPON_COUNT; id++) {
        const s = server.statsFor(id, slot);
        const c = client.statsFor(id, slot);
        for (const k of Object.keys(s) as (keyof typeof s)[]) {
          if (k === 'hot') continue;
          expect(Object.is(s[k], c[k]), `slot ${slot} weapon ${id} field ${String(k)}`).toBe(true);
        }
        for (const k of Object.keys(s.hot) as (keyof typeof s.hot)[]) {
          expect(Object.is(s.hot[k], c.hot[k]), `slot ${slot} weapon ${id} hot.${String(k)}`).toBe(true);
        }
      }
    }
  });

  it('leaves an INHERITED field at the archetype\'s double, which f32 would not', () => {
    // THE REASON THIS WIRE IS f64. `heavy-rocket` overrides `rpm` and nothing
    // else, so it inherits the rocket's splashRadius. Narrowed to float32 that
    // becomes 4.400000095367432 — and `sim.ts detonate()` tests the DOUBLE
    // against the blast distance, so a body at 4.40000005 m would take an
    // impulse where it takes none today. The shotgun's headshot multiplier is
    // the same story: 1.6 narrows to 1.600000023841858 and a headshot pellet
    // pays 16.00000023841858 instead of 16.
    const { bytes } = wire(RK, SLUG);
    const m = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage())!;
    const arsenal = SessionArsenal.from(overlaysFromWire(m.variants));
    const rocket = arsenal.statsFor(WeaponId.ROCKET, 1);
    expect(rocket.variantId).toBe('heavy-rocket');
    expect(rocket.rpm).toBe(80);
    expect(Object.is(rocket.splashRadius, WEAPONS[WeaponId.ROCKET].splashRadius)).toBe(true);
    expect(rocket.splashRadius).toBe(4.4);
    // And the hot read stays exactly the narrowing weapons.ts already does.
    expect(rocket.hot.splashRadius).toBe(4.400000095367432);

    const slug = arsenal.statsFor(WeaponId.SHOTGUN, 2);
    expect(slug.headshotMultiplier).toBe(WEAPONS[WeaponId.SHOTGUN].headshotMultiplier);
    expect(slug.headshotMultiplier).toBe(1.6);
  });

  it('carries the per-player slot map beside the table', () => {
    const { entries } = wire(SLUG);
    const slots = new Uint8Array(WEAPON_COUNT);
    slots[WeaponId.SHOTGUN] = 1;
    const bytes = encodeVariantTable(new PacketWriter(512), entries, slots).copy();
    const m = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage())!;
    expect([...m.slots]).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it('an empty table is a real message, not silence', () => {
    // A room with no variants still says so. "Count zero" and "a server too
    // old to say anything" are different facts and the client has to be able
    // to tell them apart.
    const bytes = encodeVariantTable(
      new PacketWriter(64), [], new Uint8Array(WEAPON_COUNT),
    ).copy();
    expect(bytes.length).toBe(2 + WEAPON_COUNT);
    const m = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage())!;
    expect(m.variants).toEqual([]);
    expect(SessionArsenal.from(overlaysFromWire(m.variants)).slotCount).toBe(1);
  });

  it('REFUSES a truncated packet whole, and leaves the previous message untouched', () => {
    // Atomicity is the property, not tolerance. A half-adopted table is two
    // predictors disagreeing, which is worse than no table at all — so every
    // prefix of a real message must decode to null, and the caller-owned
    // output object must still hold whatever it held before.
    const { bytes } = wire(SLUG, RK);
    const out = createVariantTableMessage();
    out.variants = [{ id: 'previous', base: WeaponId.PISTOL, values: new Float64Array(VARIANT_FIELDS.length) }];
    out.slots = Uint8Array.from([9, 9, 9, 9, 9, 9, 9]);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(
        decodeVariantTable(new PacketReader(bytes.subarray(0, cut)), out),
        `prefix of ${cut} bytes decoded`,
      ).toBeNull();
    }
    expect(out.variants[0].id).toBe('previous');
    expect([...out.slots]).toEqual([9, 9, 9, 9, 9, 9, 9]);
    // The whole thing still decodes, so the loop above was testing truncation
    // and not a broken encoder.
    expect(decodeVariantTable(new PacketReader(bytes), out)).not.toBeNull();
    expect(out.variants).toHaveLength(2);
  });

  it('refuses a row whose base is not a WeaponId, rather than dropping it', () => {
    // Dropping renumbers every later slot, and the slot map beside it was
    // written in the SENDER's numbering. One bad row would silently point a
    // player at a different weapon's variant.
    const { entries } = wire(SLUG, RK);
    const bytes = encodeVariantTable(
      new PacketWriter(512),
      [{ ...entries[0], base: WEAPON_COUNT as WeaponId }, entries[1]],
      new Uint8Array(WEAPON_COUNT),
    ).copy();
    expect(decodeVariantTable(new PacketReader(bytes), createVariantTableMessage())).toBeNull();
  });

  it('the wire order IS the slot order', () => {
    const { bytes } = wire(SLUG, RK);
    const m = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage())!;
    const arsenal = SessionArsenal.from(overlaysFromWire(m.variants));
    // Row 0 -> slot 1, row 1 -> slot 2. Both ends derive it the same way from
    // the same bytes, which is what makes the slot map meaningful at all.
    expect(arsenal.statsFor(m.variants[0].base, 1).variantId).toBe(m.variants[0].id);
    expect(arsenal.statsFor(m.variants[1].base, 2).variantId).toBe(m.variants[1].id);
  });
});

/* ------------------------------------------------------------------------ *
 * The wire validates its own numbers
 *
 * `decodeVariantTable` validated the row COUNT, the id and the base, and then
 * read sixteen f64s on trust. An adversarial reviewer encoded rows that
 * bought an accepted effective `damage: NaN` (measured: `damageAtDistanceOf`
 * returned NaN at every range) and an accepted `magSize: 7.5` whose
 * `hot.magSize` narrowed to 7 — the same `EffectiveWeapon` holding two
 * different magazine sizes for one weapon.
 *
 * Every test below asserts the CONSEQUENCE and not merely that decode
 * returned null, because "returns null" is a fact about a function and "the
 * predictor still computes a number" is the fact anyone cares about. The
 * refusal assertion comes last on purpose: with the guard reverted the red
 * that fires is the cost, not the mechanism.
 * ------------------------------------------------------------------------ */

/** One row, encoded as a whole message, exactly as a sender would write it. */
function rowBytes(base: WeaponId, values: Float64Array, id = 'probe-row'): Uint8Array {
  return encodeVariantTable(
    new PacketWriter(MAX_VARIANT_TABLE_BYTES),
    [{ id, base, values }], new Uint8Array(WEAPON_COUNT),
  ).copy();
}

/** All 16 fields at the archetype's own value: a row that inherits everything. */
function baseRow(base: number): Float64Array {
  const out = new Float64Array(VARIANT_FIELDS.length);
  for (let i = 0; i < VARIANT_FIELDS.length; i++) out[i] = WEAPONS[base][VARIANT_FIELDS[i]] as number;
  return out;
}

/** A receiver that has already adopted a good table — the state a refusal falls back to. */
function receiverHolding(base: WeaponId, values: Float64Array): ReturnType<typeof createVariantTableMessage> {
  const out = createVariantTableMessage();
  expect(decodeVariantTable(new PacketReader(rowBytes(base, values)), out)).not.toBeNull();
  return out;
}

function statsOf(out: ReturnType<typeof createVariantTableMessage>, weapon: WeaponId): ReturnType<SessionArsenal['statsFor']> {
  return SessionArsenal.from(overlaysFromWire(out.variants)).statsFor(weapon, 1);
}

describe('the wire refuses a value no predictor could run', () => {
  it('refuses a NaN, so the receiver\'s damage arithmetic stays a number', () => {
    // NaN compares false against everything, so nothing downstream recovers
    // from it: `hot.damage` is f32(NaN), `damageAtDistanceOf` is NaN at every
    // range, and a victim's health goes NaN and never comes back.
    const { entries } = wire(SLUG);
    const out = receiverHolding(WeaponId.SHOTGUN, entries[0].values);
    const before = damageAtDistanceOf(statsOf(out, WeaponId.SHOTGUN), 14);
    expect(before).toBeGreaterThan(0);

    const poisoned = Float64Array.from(entries[0].values);
    poisoned[VARIANT_FIELDS.indexOf('damage')] = Number.NaN;
    // Not caught by the band, which is why finiteness is its own rule:
    // `NaN < lo` and `NaN > hi` are both false.
    const [lo, hi] = bandEdgesFor(WEAPONS[WeaponId.SHOTGUN], 'damage');
    expect(Number.NaN < lo || Number.NaN > hi).toBe(false);

    const m = decodeVariantTable(new PacketReader(rowBytes(WeaponId.SHOTGUN, poisoned, SLUG.id)), out);

    const after = damageAtDistanceOf(statsOf(out, WeaponId.SHOTGUN), 14);
    expect(Number.isNaN(after), 'the shotgun deals NaN damage at 14 m').toBe(false);
    expect(Object.is(after, before), 'the receiver kept the table it had').toBe(true);
    expect(m).toBeNull();
  });

  it('refuses a fractional magazine, which splits ONE weapon against itself', () => {
    // The reviewer's second row. `magSize: 7.5` is EXACTLY the pistol band's
    // floor (15 x 0.5), so the band does not refuse it and the integer rule is
    // the only thing in the way — which is the point of asserting the floor
    // here rather than assuming it.
    expect(bandEdgesFor(WEAPONS[WeaponId.PISTOL], 'magSize')[0]).toBe(7.5);

    const out = receiverHolding(WeaponId.PISTOL, baseRow(WeaponId.PISTOL));
    const half = baseRow(WeaponId.PISTOL);
    half[VARIANT_FIELDS.indexOf('magSize')] = 7.5;
    const m = decodeVariantTable(new PacketReader(rowBytes(WeaponId.PISTOL, half)), out);

    // THE COST: `hot.magSize` is the u16 the client fills the magazine to
    // (`client/src/game/weapons.ts:594`) and the raw `magSize` is what both
    // sides test it against (`:748` — `this.mag[id] >= def.magSize`). At
    // 7 and 7.5 that test is false forever: the weapon reloads a full
    // magazine for the rest of the match, while the server fills the same
    // magazine to 7.5 (`server/src/horde.ts:1054`).
    const stats = statsOf(out, WeaponId.PISTOL);
    expect(stats.hot.magSize, 'a magazine filled to hot.magSize is not a full magazine').toBe(stats.magSize);
    expect(stats.hot.magSize >= stats.magSize, 'the reload never completes').toBe(true);
    expect(m).toBeNull();
  });

  it('refuses a negative, which the u16 narrowing turns into 65529', () => {
    const out = receiverHolding(WeaponId.PISTOL, baseRow(WeaponId.PISTOL));
    const negative = baseRow(WeaponId.PISTOL);
    negative[VARIANT_FIELDS.indexOf('magSize')] = -7;
    const m = decodeVariantTable(new PacketReader(rowBytes(WeaponId.PISTOL, negative)), out);

    const stats = statsOf(out, WeaponId.PISTOL);
    expect(stats.hot.magSize, 'the narrowed magazine wrapped').toBe(stats.magSize);
    expect(stats.hot.magSize).toBeLessThanOrEqual(WEAPONS[WeaponId.PISTOL].magSize * 2);
    expect(m).toBeNull();
  });

  it('has a zero floor on every band, so refusing a negative refuses nothing legal', () => {
    // The decoder enforces the FLOOR of the band and not its relative edges,
    // and that is only free while every floor is >= 0. If a band ever gains a
    // negative floor this is the test that says the wire rule went with it.
    for (const id of IDS) {
      for (const f of VARIANT_FIELDS) {
        expect(bandEdgesFor(WEAPONS[id], f)[0], `${WEAPONS[id].short}/${f}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('still decodes a legitimate table, inherited fields and all', () => {
    // A gate that cannot pass is worth exactly what one that cannot fail is
    // worth. One row per archetype with all 16 fields at the archetype's own
    // value is the extreme of "inherited", and the row most exposed to a rail
    // that reasons about the base table.
    const entries = IDS.map((id) => ({ id: `arch-${id}`, base: id as WeaponId, values: baseRow(id) }));
    const bytes = encodeVariantTable(
      new PacketWriter(MAX_VARIANT_TABLE_BYTES), entries, new Uint8Array(WEAPON_COUNT),
    ).copy();
    const m = decodeVariantTable(new PacketReader(bytes), createVariantTableMessage());
    expect(m).not.toBeNull();
    expect(m!.variants).toHaveLength(WEAPON_COUNT);
    // And the real, parser-approved ones.
    const real = decodeVariantTable(new PacketReader(wire(SLUG, RK).bytes), createVariantTableMessage());
    expect(real).not.toBeNull();
    expect(real!.variants).toHaveLength(2);
  });

  it('does NOT refuse on the RELATIVE band, which would desync a rebalance deploy', () => {
    // Deliberate, and asserted so a later tightening cannot land quietly. The
    // band's upper edge and relative floor are scaled by the RECEIVER's
    // compiled WEAPONS table, and this game ships its server (Railway) and
    // its client (Vercel, outside the release mechanism — VARIANTS.md 2)
    // separately, so a client on yesterday's weapon table is the normal state
    // during a rebalance. Band-checking here would turn that from "the ~25
    // non-variant-able fields mispredict", which is the layout's stated cost,
    // into "every row refused and both ends desync through the fallback".
    //
    // version.test.ts's frozen VARIANT_TABLE vector is exactly such a row —
    // `base: 1` carrying the pistol's numbers — and it has to keep decoding.
    const values = baseRow(WeaponId.PISTOL);
    const [lo, hi] = bandEdgesFor(WEAPONS[WeaponId.SHOTGUN], 'rpm');
    const rpm = values[VARIANT_FIELDS.indexOf('rpm')];
    expect(rpm > hi, `rpm ${rpm} is inside the shotgun's ${lo}..${hi} — the row proves nothing`).toBe(true);
    const m = decodeVariantTable(
      new PacketReader(rowBytes(WeaponId.SHOTGUN, values)), createVariantTableMessage());
    expect(m).not.toBeNull();
    expect(m!.variants[0].values[VARIANT_FIELDS.indexOf('rpm')]).toBe(rpm);
  });
});

/* ------------------------------------------------------------------------ *
 * THE INVARIANT: anything the parser accepts, the wire accepts
 *
 * The two doors ran different rules for a few hours on 2026-09-05 and the
 * result was the worst failure this module can produce. `valueBandError`
 * compares with EPS slack (`v < lo - EPS`, EPS = 1e-9) so that "unchanged"
 * survives an arithmetic round trip; the wire's `negativeValueError` refuses
 * every negative exactly. A manifest sitting in the nanometre between them
 * parsed with zero errors, satisfied the release gate — `variants.validate`
 * asks only `parsed.manifest !== null` (`server/src/gate.ts:462`) — and was
 * then refused by `decodeVariantTable`, which `decodeRoomVariantTable` turns
 * into an EMPTY table (`server/src/room.ts:137`). Green gate, published pack,
 * every player on the base arsenal, no error anywhere.
 *
 * A refused manifest is loud and fixable. This is not. So the property below
 * is the point of the whole section, and the two tests after it are the two
 * halves it cannot be allowed to satisfy vacuously: one proves the sweep
 * actually reaches accepted manifests in interesting places, and one takes
 * the fixture through a real `Room`.
 * ------------------------------------------------------------------------ */

/** Encode and decode a parsed manifest exactly as `Room`'s constructor does. */
function roundTrip(manifest: VariantsManifest): ReturnType<typeof decodeVariantTable> {
  const bytes = encodeVariantTable(
    new PacketWriter(MAX_VARIANT_TABLE_BYTES), wireEntriesFor(manifest), new Uint8Array(WEAPON_COUNT),
  ).copy();
  return decodeVariantTable(new PacketReader(bytes), createVariantTableMessage());
}

/**
 * The values worth aiming at one field of one archetype.
 *
 * Both band edges exactly; each edge displaced by 1e-10, 1e-9 and 1e-8 in both
 * directions, which brackets EPS and is where the two doors actually parted
 * company; zero and negative zero, because `-0 < 0` is FALSE and the sign is
 * still on the wire; and the ends of the three narrowings `arsenal.ts` does —
 * u8 at 255/256, u16 at 65535/65536, float32 at its last finite value and past
 * it. `MAX_VALUE` is there because "the biggest double" is the value an
 * attacker reaches for first.
 */
const F32_MAX = 3.4028234663852886e38;
function probeValues(base: WeaponDef, field: VariantField): number[] {
  const [lo, hi] = bandEdgesFor(base, field);
  const nudges = [1e-10, 1e-9, 1e-8];
  return [
    lo, hi, (lo + hi) / 2, 0, -0, 1,
    ...nudges.flatMap((e) => [lo - e, lo + e, hi - e, hi + e, -e, e]),
    255, 256, 65535, 65536,
    F32_MAX, F32_MAX * 1.001, 1e39, 1e40, 1e308, Number.MAX_VALUE,
  ];
}

/**
 * A cost big enough that a lone probe value is not automatically a straight
 * upgrade. Without it the strict-dominance rule refuses nearly every
 * single-field variant and the sweep would prove almost nothing: a tighter
 * cone alone is better on handling and worse on nothing, which §6 forbids.
 * `rpm` is live on all seven archetypes and always costs DPS, so it is the one
 * carrier that works everywhere; when `rpm` is itself the field under test the
 * damage cut takes over.
 */
function carrierFor(base: WeaponDef, field: VariantField): Record<string, number> {
  return field === 'rpm'
    ? { damage: base.damage * 0.85 }
    : { rpm: base.rpm * 0.8 };
}

interface SweepResult {
  probes: number;
  accepted: number;
  refused: number;
  /** Parsed clean, refused by the wire. Every one of these is the bug. */
  leaks: string[];
  /**
   * Probes that landed IN THE EPS HOLE and were refused for being negative —
   * negative, and forgiven by the band's own tolerance of its floor. This is
   * the sweep proving it still reaches the place where the two doors parted;
   * without it the leak list could be empty because nothing interesting was
   * ever tried.
   */
  holeRefusals: number;
}

function sweep(): SweepResult {
  const out: SweepResult = { probes: 0, accepted: 0, refused: 0, leaks: [], holeRefusals: 0 };
  for (const id of IDS) {
    const base = WEAPONS[id];
    for (const field of VARIANT_FIELDS) {
      const [lo, hi] = bandEdgesFor(base, field);
      for (const v of probeValues(base, field)) {
        // `valueBandError`'s own test, spelled out: EPS is 1e-9 and the band
        // forgives anything inside it.
        const bandForgives = !(v < lo - 1e-9 || v > hi + 1e-9);
        for (const over of [{ [field]: v }, { ...carrierFor(base, field), [field]: v }]) {
          out.probes++;
          const r = parseVariantsManifest(JSON.stringify({
            variants: [{ id: 'probe', base: id, name: 'Probe', over }],
          }));
          if (r.manifest === null) {
            out.refused++;
            if (v < 0 && bandForgives && r.errors.join(' ').includes('is negative')) {
              out.holeRefusals++;
            }
            continue;
          }
          out.accepted++;
          if (roundTrip(r.manifest) === null) {
            out.leaks.push(`${base.short}/${field}=${v} over=${JSON.stringify(over)}`);
          }
        }
      }
    }
  }
  return out;
}

describe('parser-accept is a SUBSET of decoder-accept', () => {
  it('every manifest the parser blesses survives encode -> decode', () => {
    const r = sweep();

    // THE PROPERTY. On the code this file was written against there were 108
    // of these, over six archetypes and five fields.
    expect(r.leaks, `${r.leaks.length} manifest(s) parsed clean and were refused by the wire`)
      .toEqual([]);

    /*
     * AND THE THREE THINGS THAT STOP AN EMPTY LEAK LIST FROM MEANING NOTHING.
     * A sweep that accepts nothing, or refuses nothing, or never reaches the
     * EPS hole has an empty leak list too — and that is the shape of a green
     * test that cannot fail. Measured on 2026-09-05, after the fix: 7616
     * probes, 789 accepted, 6827 refused, 400 of the refusals inside the hole.
     * The floors sit well under those so ordinary balance work does not trip
     * them, and well over zero so a sweep that quietly degenerated — a broken
     * carrier, a renamed field, a band that stopped reaching its own floor —
     * is a failure and not a pass.
     */
    expect(r.probes, 'the sweep barely ran').toBeGreaterThan(5000);
    expect(r.accepted, 'the sweep accepted almost nothing; it proves almost nothing')
      .toBeGreaterThan(300);
    expect(r.refused, 'the sweep refused almost nothing; the parser is not being exercised')
      .toBeGreaterThan(3000);
    expect(
      r.holeRefusals,
      'no probe reached the EPS hole and was refused for its sign, so this sweep can '
      + 'no longer catch the bug it was written for',
    ).toBeGreaterThan(100);
  });
});

/* ------------------------------------------------------------------------ *
 * The fixture, end to end, through a real Room
 *
 * WHY THIS TEST IMPORTS THE SERVER FROM A shared/ TEST.
 *
 * The codec property above proves `parse -> encode -> decode` never breaks.
 * It passes with `decodeRoomVariantTable` deleted, with `Room` never built,
 * and with `SessionArsenal.from` fed an empty array — and the failure being
 * fixed here is precisely that a room SILENTLY substitutes an empty table for
 * a refused one. "The bytes round-trip" and "the room the operator published
 * actually fires the variant" are different facts, and only the second one is
 * the one anybody cares about.
 *
 * `client/src/net/variantWire.test.ts` already reaches for `Room` the same
 * way, so the import shape is the repository's own. It is not free: `tsc -b`
 * pulls eleven server files into `shared`'s composite program to check it, and
 * `shared`'s tsconfig declares `"types": []`, so the day `room.ts`'s
 * transitive imports touch a `node:` builtin this build breaks. If that is too
 * much coupling for `shared/`, this describe block belongs verbatim in
 * `client/src/net/variantWire.test.ts`, which already has the Room harness and
 * already pays this cost.
 * ------------------------------------------------------------------------ */

/** The exact manifest that parsed clean and served an empty table. */
/* ------------------------------------------------------------------------ *
 * The representability rail
 *
 * The second class of the same bug, on the other door. `decodeVariantTable`
 * ACCEPTED every value below, and each one produced a narrowed twin in
 * `hotFor` that is not a lossy image of the wire value but an unrelated
 * number — which is `magSize: 7.5` again with a bigger number on it, and
 * exactly the half-decode the function's own headline forbids.
 *
 * Every test asserts the CONSEQUENCE first and the refusal last, so that with
 * the rail reverted the red that fires is the cost and not the mechanism.
 * ------------------------------------------------------------------------ */

describe('the wire refuses a value its own narrowing cannot carry', () => {
  it('refuses a magazine past the u16, which becomes ZERO in the hand', () => {
    const out = receiverHolding(WeaponId.PISTOL, baseRow(WeaponId.PISTOL));
    const before = statsOf(out, WeaponId.PISTOL).hot.magSize;
    expect(before).toBeGreaterThan(0);

    const row = baseRow(WeaponId.PISTOL);
    row[VARIANT_FIELDS.indexOf('magSize')] = 65536;
    const m = decodeVariantTable(new PacketReader(rowBytes(WeaponId.PISTOL, row)), out);

    const stats = statsOf(out, WeaponId.PISTOL);
    // `hot.magSize` is what the client fills the magazine TO and `magSize` is
    // what both sides test it against, so 0 against 65536 is a weapon that
    // holds nothing and reloads forever.
    expect(stats.hot.magSize, 'the magazine wrapped to zero').toBe(stats.magSize);
    expect(stats.hot.magSize).toBe(before);
    expect(m).toBeNull();
  });

  it('refuses a pellet count past the u8, which fires NO pellets', () => {
    const out = receiverHolding(WeaponId.SHOTGUN, baseRow(WeaponId.SHOTGUN));
    const before = statsOf(out, WeaponId.SHOTGUN).hot.pellets;
    expect(before).toBe(7);

    const row = baseRow(WeaponId.SHOTGUN);
    row[VARIANT_FIELDS.indexOf('pellets')] = 256;
    const m = decodeVariantTable(new PacketReader(rowBytes(WeaponId.SHOTGUN, row)), out);

    const stats = statsOf(out, WeaponId.SHOTGUN);
    // Both predictors loop `hot.pellets` (that is the shared ceiling closed
    // earlier today), so a shotgun that wrapped to 0 does nothing at all while
    // its budget was scored on 256 pellets.
    expect(stats.hot.pellets, 'the shotgun fires no pellets').toBeGreaterThan(0);
    expect(stats.hot.pellets).toBe(before);
    expect(m).toBeNull();
  });

  it('refuses a damage that overflows the float32 — and the NaN beyond it', () => {
    const out = receiverHolding(WeaponId.PISTOL, baseRow(WeaponId.PISTOL));
    const before = damageAtDistanceOf(statsOf(out, WeaponId.PISTOL), 40);

    const row = baseRow(WeaponId.PISTOL);
    row[VARIANT_FIELDS.indexOf('damage')] = 1e40;
    row[VARIANT_FIELDS.indexOf('falloffMin')] = 0;
    const m = decodeVariantTable(new PacketReader(rowBytes(WeaponId.PISTOL, row)), out);

    const stats = statsOf(out, WeaponId.PISTOL);
    // 1e40 is FINITE on the wire, so the finiteness rule never sees it — and
    // `f32(1e40)` is Infinity, so `hot.damage × 0` at long range is NaN. That
    // is the health-goes-NaN-forever failure reached through a legal double.
    expect(Number.isFinite(stats.hot.damage), 'hot.damage is Infinity').toBe(true);
    expect(Number.isNaN(damageAtDistanceOf(stats, 40)), 'damage at 40 m is NaN').toBe(false);
    expect(damageAtDistanceOf(stats, 40)).toBe(before);
    expect(m).toBeNull();
  });

  it('refuses an rpm whose SHOT INTERVAL is not a duration', () => {
    // `fireIntervalMs` is `f32(60000 / rpm)`, so this rail belongs to the
    // derived quantity and catches values no other rule can see: 0 is neither
    // negative nor non-finite, 1e308 is an ordinary double, and -0 is not even
    // negative — `-0 < 0` is false — while `60000 / -0` is -Infinity.
    for (const [rpm, note] of [
      [0, 'a gun that never fires again'],
      [1e308, 'a shot every frame'],
      [-0, 'a negative interval'],
    ] as [number, string][]) {
      const out = receiverHolding(WeaponId.PISTOL, baseRow(WeaponId.PISTOL));
      const before = statsOf(out, WeaponId.PISTOL).hot.fireIntervalMs;
      const row = baseRow(WeaponId.PISTOL);
      row[VARIANT_FIELDS.indexOf('rpm')] = rpm;
      const m = decodeVariantTable(new PacketReader(rowBytes(WeaponId.PISTOL, row)), out);

      const interval = statsOf(out, WeaponId.PISTOL).hot.fireIntervalMs;
      expect(Number.isFinite(interval) && interval > 0, `rpm ${rpm}: ${note}`).toBe(true);
      expect(interval).toBe(before);
      expect(m, `rpm ${rpm}`).toBeNull();
    }
  });

  it('still decodes the values the narrowing is merely LOSSY on', () => {
    // A gate that cannot pass is worth what one that cannot fail is worth, and
    // this is the rail most at risk of being written as `f32(v) === v`. The
    // rocket's real splashRadius 4.4 narrows to 4.400000095367432 and always
    // has (`arsenal.ts` documents six such pairs as shipped behaviour), so an
    // equality rule would refuse the compiled table itself.
    expect(narrowedValueOf('splashRadius', 4.4)).toBe(4.400000095367432);
    expect(narrowedValueOf('splashRadius', 4.4)).not.toBe(4.4);
    const entries = IDS.map((id) => ({ id: `arch-${id}`, base: id as WeaponId, values: baseRow(id) }));
    const bytes = encodeVariantTable(
      new PacketWriter(MAX_VARIANT_TABLE_BYTES), entries, new Uint8Array(WEAPON_COUNT),
    ).copy();
    expect(decodeVariantTable(new PacketReader(bytes), createVariantTableMessage()))
      .not.toBeNull();
    // And the last finite float32 is still a number the engine can hold.
    const edge = baseRow(WeaponId.PISTOL);
    edge[VARIANT_FIELDS.indexOf('damage')] = F32_MAX;
    expect(decodeVariantTable(new PacketReader(rowBytes(WeaponId.PISTOL, edge)), createVariantTableMessage()))
      .not.toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * `HOT_NARROWING` is a claim about `arsenal.ts`, not a comment
 *
 * The rail duplicates three lines of `arsenal.ts` — `f32`, `u16` and `u8` are
 * private there and this module may not widen that file's API to borrow them —
 * and an unwitnessed second copy of a rule is the exact scar this file already
 * carries from `BANDS.toString`. So the classification is driven through a
 * REAL `SessionArsenal`, field by field, and the "not narrowed" half is
 * checked against `HotWeapon`'s actual keys rather than against a memory of
 * them.
 * ------------------------------------------------------------------------ */

describe('the narrowing table matches what SessionArsenal really does', () => {
  /** `hot` as a bag, so a field name can be looked up in it. */
  function hotOf(base: WeaponId, over: Record<string, number>): Record<string, number> {
    return SessionArsenal.from([{ id: 'probe', base, over }])
      .statsFor(base, 1).hot as unknown as Record<string, number>;
  }
  const HOT_KEYS = Object.keys(hotOf(WeaponId.PISTOL, {}));

  it('classifies all 16 fields, and every one the way hotFor does', () => {
    expect(Object.keys(HOT_NARROWING).sort()).toEqual([...VARIANT_FIELDS].sort());
    for (const field of VARIANT_FIELDS) {
      const kind = HOT_NARROWING[field];
      if (kind === 'none') {
        // Not narrowed means not present: both predictors read the f64 off
        // `EffectiveWeapon` itself, so there is no second representation to
        // disagree with and nothing for a rail to protect.
        expect(HOT_KEYS, `${field} IS narrowed — HOT_NARROWING says it is not`)
          .not.toContain(field);
        continue;
      }
      if (kind === 'fireInterval') {
        expect(field).toBe('rpm');
        for (const rpm of [420, 700, 1e-3]) {
          expect(hotOf(WeaponId.PISTOL, { rpm }).fireIntervalMs, `rpm ${rpm}`)
            .toBe(narrowedValueOf('rpm', rpm));
        }
        continue;
      }
      expect(HOT_KEYS, `${field} is NOT narrowed — HOT_NARROWING says ${kind}`).toContain(field);
      // Values chosen to straddle each width's end, so a table that named the
      // wrong width would answer differently here.
      const probes = kind === 'u8' ? [200, 255, 256, 300]
        : kind === 'u16' ? [200, 65535, 65536, 70000]
          : [4.4, 1e38, 1e40];
      for (const v of probes) {
        expect(hotOf(WeaponId.PISTOL, { [field]: v })[field], `${field}=${v}`)
          .toBe(narrowedValueOf(field, v));
      }
    }
  });

  it('RATCHET: no band edge on today\'s table can reach the rail', () => {
    /*
     * The parser-side half of the representability rail is defence in depth
     * and cannot bite today: `magSize` tops out at 200 against a u16's 65535,
     * `pellets` at 12 against a u8's 255, the float32 fields at 4800 against
     * ~3.4e38, and `rpm` runs 12..1120 for a shot interval of 53.6..5000 ms.
     * That is a fact about the weapon table, not about the schema, and this
     * test is what turns it into a watched fact: the day a rebalance pushes an
     * edge past its width, this goes red and says the parser rail has stopped
     * being decoration.
     */
    for (const id of IDS) {
      for (const field of VARIANT_FIELDS) {
        const [lo, hi] = bandEdgesFor(WEAPONS[id], field);
        const where = `${WEAPONS[id].short}/${field} ${lo}..${hi}`;
        const kind = HOT_NARROWING[field];
        if (kind === 'none') continue;
        if (kind === 'fireInterval') {
          for (const rpm of [lo, hi]) {
            const interval = narrowedValueOf('rpm', rpm);
            expect(Number.isFinite(interval) && interval > 0, where).toBe(true);
          }
          continue;
        }
        if (kind === 'f32') {
          expect(Number.isFinite(narrowedValueOf(field, hi)), where).toBe(true);
          continue;
        }
        // Counts: the largest whole number the band admits must survive.
        const top = Math.floor(hi);
        expect(narrowedValueOf(field, top), where).toBe(top);
      }
    }
  });
});
