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

import { describe, expect, it } from 'vitest';

import {
  applyOver, BUDGET_TOLERANCE, isInert, MAX_VARIANTS_PER_PACK,
  parseVariantsManifest, scoreVariant, VARIANT_FIELDS, variantsFingerprintInputs,
  type VariantField,
} from './variants.ts';
import { FireKind, WEAPON_COUNT, WeaponId, WEAPONS } from './weapons.ts';

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
    expect(isInert(WEAPONS[WeaponId.PISTOL], 'terrainDamage')).toBe(true);
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
  it('refuses a terrainDamage that would hang the server forever', () => {
    // `world.carveSphere` starts `for (let y = y0; y <= y1; y++)` at
    // `floor(cy - radius)`. At 1e20 that is -1e20, and -1e20 + 1 === -1e20, so
    // y never advances and one projectile blocks the event loop. The value is
    // finite, whitelisted, and moves none of the budget axes — bands are the
    // only thing standing in front of it.
    expect(-1e20 + 1).toBe(-1e20);
    expect(refusal(one({ terrainDamage: 1e20 }, WeaponId.ROCKET))).toContain('terrainDamage');
    expect(refusal(one({ terrainDamage: 1e20 }, WeaponId.PLASMA))).toContain('terrainDamage');
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
