/**
 * DOOMCRAFT — the weapon-variant schema, and the two refusals that make a
 * variant a SIDEGRADE rather than an upgrade.
 *
 * docs/VARIANTS.md §1 and §7. A variant is a named override set applied to one
 * base `WeaponId` — never a new id, never new behaviour, never a feel field.
 * This module parses one, refuses everything it cannot vouch for, and is the
 * ONLY thing that decides whether a stat line is allowed to exist.
 * `shared/src/arsenal.ts` assembles; it does not judge. Keeping those apart is
 * deliberate: a room must not be able to widen the whitelist by handing the
 * arsenal a richer object.
 *
 * THREE GATES, IN ORDER, AND EACH ONE EXISTS BECAUSE THE OTHERS DO NOT CATCH
 * ITS CASE.
 *
 *   1. THE WHITELIST + BANDS. Only 16 fields may move, every one of them has a
 *      band, and a band is relative to the base wherever that makes sense — so
 *      a weapon with no splash cannot gain any (×anything of 0 is 0) without a
 *      special case.
 *   2. THE POWER BUDGET, ±12%. A weighted sum of axis ratios.
 *   3. STRICT DOMINANCE. A variant may not be better-or-equal on every axis
 *      with at least one strictly better. §6 forbids straight upgrades in
 *      words, and the band alone does not: an "everything up 10%" variant
 *      lands inside ±12% and is exactly what §6 means.
 *
 * WHY THE AXES ARE PER-ARCHETYPE (the user's decision, 2026-09-05).
 *
 * The first draft of the budget scored every weapon on all four axes. On the
 * real table that is not merely imprecise, it is undefined and exploitable:
 *
 *   - Four of the seven weapons have no splash at all, so `splash / baseSplash`
 *     is 0/0. `Math.abs(NaN) <= 0.12` is FALSE, so the check would have refused
 *     every pistol, shotgun, chaingun and chainsaw variant ever written — a
 *     gate that fails everything, which is its own kind of broken.
 *   - The chainsaw has magSize 0 and reloadMs 0 and produced a NaN DPS the same
 *     way.
 *   - And two axes were COUNTERFEIT CURRENCY. A projectile's direct damage is
 *     stored at spawn and never has falloff applied to it, so a plasma variant
 *     could "pay" for damage by ruining a falloff curve that never runs. The
 *     shotgun reloads on `reloadShellMs`, so paying with `reloadMs` cost
 *     nothing at all.
 *
 * So an axis is scored only where it is LIVE for that archetype, the surviving
 * weights are renormalised, and — the other half of the same idea — an override
 * of a field that cannot reach this archetype's firing path is REFUSED rather
 * than silently priced at zero. See `INERT`.
 */

import { MAX_CONTENT_ID_LENGTH, sanitiseContentId } from './modes.ts';
import {
  type PacketReader, type PacketWriter, S2C,
} from './protocol.ts';
import {
  FireKind, WEAPON_COUNT, WeaponId, WEAPONS, type WeaponDef,
} from './weapons.ts';

/* ------------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------------ */

/**
 * The 16 fields a variant may move. Everything else is a refusal.
 *
 * `terrainDamage` WAS here and is deliberately gone. It is genuinely live —
 * detonation passes it straight to `world.carveSphere` — but it belongs to no
 * budget axis, so `{ terrainDamage: 3.9 }` on a rocket parsed with a budget of
 * exactly 1.0 and no dominance, and bought a carve radius of 2.6 m -> 3.9 m
 * for nothing at all. A field the budget cannot charge for is not a sidegrade
 * dimension. The choice was to price it or to remove it; removing it is the
 * smaller and reversible answer, and it takes the `carveSphere`
 * non-termination hazard off the variant surface entirely rather than merely
 * banding it away.
 */
export type VariantField =
  | 'damage' | 'pellets' | 'headshotMultiplier' | 'rpm' | 'magSize' | 'reloadMs'
  | 'splashRadius' | 'splashDamage'
  | 'spread' | 'spreadMax' | 'spreadPerShot'
  | 'falloffStart' | 'falloffEnd' | 'falloffMin' | 'falloffCurve'
  | 'projectileSpeed';

export interface VariantDef {
  readonly id: string;
  readonly base: WeaponId;
  readonly name: string;
  readonly over: Readonly<Partial<Record<VariantField, number>>>;
}

export interface VariantsManifest {
  readonly variants: readonly VariantDef[];
}

export interface VariantsParseResult {
  readonly manifest: VariantsManifest | null;
  readonly errors: string[];
}

/**
 * Sixty-four, and it has to fit a u8. The equipped claim is a `Uint8Array` on
 * both predictors (`PlayerEntity.variantSlots`, `WeaponRuntime.variantSlots`)
 * and a round in flight carries its firing-time slot in one too
 * (`Simulation.projVariant`). 64 variants occupy slots 1..64; with the base at
 * 0 that is 65 values, comfortably inside a byte.
 */
export const MAX_VARIANTS_PER_PACK = 64;

export const MAX_VARIANT_NAME = 40;

/** The band ±12% of §7.1, as a fraction. */
export const BUDGET_TOLERANCE = 0.12;

/** Per-SHOT payload (damage × pellets) may move this much against the base. */
export const PAYLOAD_BAND: readonly [number, number] = Object.freeze([0.25, 2.5]);

/* ------------------------------------------------------------------------ *
 * Bands
 *
 * EVERY whitelisted field has one. The first draft banded 12 of 18 and the six
 * it left open included `terrainDamage`, which goes straight to
 * `world.carveSphere`, whose `for (let y = y0; y <= y1; y++)` cannot terminate
 * when y0 is -1e20 — because `-1e20 + 1 === -1e20`. One projectile from a
 * variant carrying a finite, in-budget, dominance-clean `terrainDamage: 1e20`
 * would have blocked the event loop forever.
 *
 * UPDATED 2026-09-05: `carveSphere` is now bounded in its own right, on BOTH
 * implementations — it refuses non-finite input, clamps to
 * `TERRAIN_CARVE_MAX_RADIUS` and clamps its three loop ranges to the world box,
 * which is what actually closes it (a radius clamp alone does not: a centre of
 * 1e20 with a radius of ONE lands y0 === y1 and hangs just the same). So the
 * paragraph above is no longer the only thing standing between a pack and a
 * dead room. It is left standing because its CONCLUSION is unchanged and was
 * never really about the loop: a field the budget cannot charge for is not a
 * sidegrade dimension, and `terrainDamage` stays off the whitelist for that
 * reason first. Defence in depth is the right shape here — the clamp is the
 * one that has to hold, and the whitelist is the one that has to be argued.
 * ------------------------------------------------------------------------ */

interface Band {
  /** Multiples of the base value. */
  readonly rel?: readonly [number, number];
  /** Absolute range, for fields where a multiple of the base is meaningless. */
  readonly abs?: readonly [number, number];
  /** Refuse a non-integer. Counts are counts. */
  readonly integer?: boolean;
}

const BANDS: Readonly<Record<VariantField, Band>> = Object.freeze({
  // A WIDE SANITY RAIL, not the balance control. The payload band below is
  // what actually bounds damage, because the meaningful quantity is
  // damage × pellets: docs/VARIANTS.md's own headline example is a slug
  // shotgun at `damage: 62`, which is 5.6× the base's per-pellet 11 and only
  // 0.8× its per-shot 77. A ×2.5 rail on this field alone refuses the one
  // variant the document was written to describe.
  damage: { rel: [0.1, 20] },
  pellets: { abs: [1, 12], integer: true },
  headshotMultiplier: { rel: [0.5, 1.5] },
  rpm: { rel: [0.3, 1.6] },
  magSize: { rel: [0.5, 2.0], integer: true },
  reloadMs: { rel: [0.5, 2.0] },
  splashRadius: { rel: [0, 1.5] },
  splashDamage: { rel: [0, 1.5] },
  // Down to a tenth, because a slug is not a buckshot cone narrowed by a
  // fifth — docs/VARIANTS.md §1's example asks for 0.012 against a base of
  // 0.09, and a tighter cone is CHARGED by the handling axis anyway. Which is
  // the division of labour throughout this table: a band is a safety rail
  // against absurdity and engine hazards, and the BUDGET does the balance.
  spread: { rel: [0.1, 3.0] },
  spreadMax: { rel: [0.1, 3.0] },
  spreadPerShot: { rel: [0, 3.0] },
  falloffStart: { rel: [0.5, 2.0] },
  falloffEnd: { rel: [0.5, 2.0] },
  falloffMin: { abs: [0, 1] },
  falloffCurve: { abs: [0.5, 3] },
  projectileSpeed: { rel: [0.5, 1.6] },
});

export const VARIANT_FIELDS: readonly VariantField[] =
  Object.freeze(Object.keys(BANDS) as VariantField[]);

/* ------------------------------------------------------------------------ *
 * What is inert on which archetype
 *
 * "Measured currency": a variant may not pay, or be paid, in a field the
 * engine does not read for its base. Each entry answers "does moving this
 * field change what this archetype actually does?" and every one was checked
 * against the firing path, not against the type.
 * ------------------------------------------------------------------------ */

/** True when `field` cannot affect `base`'s firing path at all. */
export function isInert(base: WeaponDef, field: VariantField): boolean {
  switch (field) {
    case 'pellets':
      // The projectile and melee branches fire exactly once, whatever this says.
      return base.kind !== FireKind.HITSCAN;
    case 'headshotMultiplier':
      // `resolveHitscan` is the only server path that tests for a head;
      // `resolveMelee` has no headshot logic at all.
      return base.kind !== FireKind.HITSCAN;
    case 'reloadMs':
      // A shell-by-shell reload runs on `reloadShellMs`, which is NOT
      // variant-able; a magazine-less weapon never reloads.
      return base.magSize <= 0 || base.reloadShellMs > 0;
    case 'magSize':
      return base.magSize <= 0;
    case 'spread':
    case 'spreadMax':
    case 'spreadPerShot':
      // Melee resolves down the aim with no cone on either side.
      return base.kind === FireKind.MELEE;
    case 'falloffStart':
    case 'falloffEnd':
    case 'falloffMin':
    case 'falloffCurve':
      // A projectile's direct damage is stored at spawn (`projDamage`) and its
      // splash comes from `splashDamageAt`. Falloff never runs for either.
      return base.kind === FireKind.PROJECTILE;
    case 'projectileSpeed':
      return base.kind !== FireKind.PROJECTILE;
    case 'splashRadius':
    case 'splashDamage':
      return base.splashRadius <= 0 || base.splashDamage <= 0;
    case 'damage':
    case 'rpm':
      return false;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------------ *
 * The axes
 *
 * Every one is oriented so that HIGHER IS BETTER, and every one carries the
 * archetypes it is live for. `handling` is the mean of whichever of its four
 * sub-terms apply, which is what keeps §7.1's decided weight of 0.15 intact
 * while letting a chainsaw — which has no magazine, no cone and no projectile
 * — simply not have the axis.
 * ------------------------------------------------------------------------ */

/** A quarter of the hits a competent player lands are heads. Stated, not hidden. */
const HEADSHOT_SHARE = 0.25;

export const AXIS_WEIGHTS = Object.freeze({ dps: 0.50, range: 0.20, splash: 0.15, handling: 0.15 });

function shotIntervalMs(w: WeaponDef): number { return 60000 / w.rpm; }

/** Milliseconds of reload per emptied magazine. 0 when the weapon never reloads. */
function reloadTotalMs(w: WeaponDef): number {
  if (w.magSize <= 0) return 0;
  return w.reloadShellMs > 0 ? w.reloadShellMs * w.magSize : w.reloadMs;
}

/** Damage per second including the reload, not the burst rate. */
export function sustainedDps(w: WeaponDef): number {
  const shots = w.magSize > 0 ? w.magSize : 1;
  const cycleMs = shots * shotIntervalMs(w) + reloadTotalMs(w);
  const uplift = w.kind === FireKind.HITSCAN
    ? 1 + (w.headshotMultiplier - 1) * HEADSHOT_SHARE
    : 1;
  return (w.damage * w.pellets * uplift * shots) / (cycleMs / 1000);
}

/**
 * The area under the falloff curve from the muzzle to `falloffEnd`, in
 * metre-multipliers. Closed form, not a numeric integral: the curve is 1 up to
 * `falloffStart` and `1 + (min-1)·t^curve` after it, and the integral of
 * `t^curve` over a unit interval is `1/(curve+1)`.
 */
export function effectiveRange(w: WeaponDef): number {
  const span = Math.max(0, w.falloffEnd - w.falloffStart);
  return w.falloffStart + span * (1 + (w.falloffMin - 1) / (w.falloffCurve + 1));
}

export function splashPower(w: WeaponDef): number {
  return w.splashRadius * w.splashDamage;
}

interface SubTerm {
  readonly key: string;
  readonly live: (base: WeaponDef) => boolean;
  readonly value: (w: WeaponDef) => number;
}

const HANDLING_TERMS: readonly SubTerm[] = Object.freeze([
  // What one magazine is worth before you have to stop.
  { key: 'capacity', live: (b) => b.magSize > 0, value: (w) => w.magSize },
  // How little of your time the reload eats. For a shell reloader this moves
  // WITH magSize (total = shellMs × magSize), so capacity and uptime trade
  // against each other exactly as they do in the hand.
  { key: 'uptime', live: (b) => reloadTotalMs(b) > 0, value: (w) => 1000 / reloadTotalMs(w) },
  // Tightness of the cone. Melee has none on either side.
  {
    key: 'cone',
    live: (b) => b.kind !== FireKind.MELEE && (b.spread + b.spreadMax + b.spreadPerShot) > 0,
    value: (w) => 1 / (w.spread + w.spreadMax + w.spreadPerShot),
  },
  // Less lead to pull off. Only a projectile has any.
  {
    key: 'speed',
    live: (b) => b.kind === FireKind.PROJECTILE && b.projectileSpeed > 0,
    value: (w) => w.projectileSpeed,
  },
]);

export interface AxisScore {
  readonly axis: 'dps' | 'range' | 'splash' | 'handling';
  readonly weight: number;
  readonly base: number;
  readonly variant: number;
  /** variant / base. Higher is always better. */
  readonly ratio: number;
}

export interface BudgetReport {
  readonly axes: readonly AxisScore[];
  /** The weighted mean of the ratios over the axes that applied. 1 is parity. */
  readonly budget: number;
  /** Signed distance from parity. */
  readonly delta: number;
  readonly withinBand: boolean;
  /** True when the variant is >= base everywhere and > base somewhere. */
  readonly dominates: boolean;
}

/** Float slack, so "unchanged" survives an arithmetic round trip. */
const EPS = 1e-9;

export function scoreVariant(base: WeaponDef, variant: WeaponDef): BudgetReport {
  const axes: AxisScore[] = [];
  const push = (
    axis: AxisScore['axis'], weight: number, b: number, v: number,
  ): void => {
    if (!(b > 0)) return;                 // an axis this archetype does not have
    axes.push({ axis, weight, base: b, variant: v, ratio: v / b });
  };

  push('dps', AXIS_WEIGHTS.dps, sustainedDps(base), sustainedDps(variant));
  if (base.kind !== FireKind.PROJECTILE) {
    push('range', AXIS_WEIGHTS.range, effectiveRange(base), effectiveRange(variant));
  }
  push('splash', AXIS_WEIGHTS.splash, splashPower(base), splashPower(variant));

  const sub: number[] = [];
  for (const t of HANDLING_TERMS) {
    if (!t.live(base)) continue;
    const b = t.value(base);
    if (!(b > 0) || !Number.isFinite(b)) continue;
    const v = t.value(variant);
    if (!Number.isFinite(v)) continue;
    sub.push(v / b);
  }
  if (sub.length > 0) {
    const mean = sub.reduce((a, b) => a + b, 0) / sub.length;
    axes.push({ axis: 'handling', weight: AXIS_WEIGHTS.handling, base: 1, variant: mean, ratio: mean });
  }

  let weighted = 0;
  let total = 0;
  for (const a of axes) { weighted += a.weight * a.ratio; total += a.weight; }
  const budget = total > 0 ? weighted / total : 1;
  const delta = budget - 1;

  const better = axes.filter((a) => a.ratio > 1 + EPS).length;
  const worse = axes.filter((a) => a.ratio < 1 - EPS).length;

  return {
    axes: Object.freeze(axes),
    budget,
    delta,
    withinBand: Math.abs(delta) <= BUDGET_TOLERANCE + EPS,
    dominates: better > 0 && worse === 0,
  };
}

/* ------------------------------------------------------------------------ *
 * One value, judged in ONE place
 *
 * There are two doors into a variant's numbers — `parseVariantsManifest`,
 * which reads a pack file, and `decodeVariantTable`, which reads bytes off a
 * socket — and for most of V3 only the first one judged anything. The second
 * validated the row's `count`, its `id` and its `base` and then took sixteen
 * f64s on trust. A hostile row therefore bought an accepted effective
 * `damage: NaN` (measured: `damageAtDistanceOf` returns NaN at every range,
 * so a hit subtracts NaN and the victim's health becomes NaN forever) and an
 * accepted `magSize: 7.5`, whose narrowed `hot.magSize` is 7 while the raw
 * field stays 7.5 — the SAME `EffectiveWeapon` disagreeing with itself about
 * one weapon, which is the exact shape of the bug class this whole arc exists
 * to prevent.
 *
 * So the value rules live here, in functions BOTH doors call, and the split
 * into several of them is not decoration. The parser interleaves a third
 * refusal (`isInert`) between the shape and the band, and it has to stay
 * there: an inert field is reported with a value of `base[f] || 1`, so on a
 * field whose base is 0 — a pistol's `splashRadius`, a chainsaw's `magSize` —
 * a combined check would fire the band first and answer "outside 0..0" where
 * "the pistol has no splash to scale" is the true and useful answer. Separate
 * functions keep that order exactly, with no duplicated check, and let the
 * wire decoder take the subset of rules it can afford to enforce — which is
 * NOT all of them, and `decodeVariantTable` argues at length about which.
 *
 * Each returns the parser's message TAIL, or null. The parser prepends
 * `${id}: ` and pushes it; the decoder only asks whether it is null, because
 * a wire refusal has nowhere to put a sentence. That asymmetry is the whole
 * awkwardness of sharing these, and it is a smaller price than two copies of
 * a rule drifting apart — this file already has the scar (`BANDS.toString`)
 * from a check that existed in one place and was reasoned about in another.
 * ------------------------------------------------------------------------ */

/**
 * Finite, and whole where the band says counts are counts: everything a value
 * can get wrong without reference to the archetype it lands on.
 *
 * Non-numbers arrive here as NaN, which is the same refusal they always got.
 */
function valueShapeError(field: VariantField, v: number): string | null {
  if (!Number.isFinite(v)) return `${field} is not a finite number`;
  if (BANDS[field].integer === true && !Number.isInteger(v)) {
    // `magSize: 7.5` makes a reload transfer half a round, which the typed
    // arrays resolve as destroying a reserve round and loading nothing.
    //
    // The `pellets` half of this argument USED to be the stronger one — 1.5
    // sits inside 1..12 and made the server fire twice (`i < def.pellets`)
    // while the client fired once — and it is now dead, because both
    // predictors read `def.hot.pellets` and u8(1.5) is 1 on both sides
    // (2026-09-05). The rail stays: a count that is not a count is still
    // nonsense to store, `magSize` still bites, and a rule kept only while
    // some other file happens to round the same way is a rule waiting to
    // break. Recorded rather than deleted so nobody re-derives the old
    // justification and finds it false.
    return `${field} must be a whole number, not ${v}`;
  }
  return null;
}

/**
 * The band of §7 resolved against one archetype. Exported because the wire
 * decoder enforces the FLOOR of it and nothing else (see
 * `decodeVariantTable`), and the test that says why has to be able to read
 * both edges rather than take the claim on trust.
 */
export function bandEdgesFor(base: WeaponDef, field: VariantField): readonly [number, number] {
  const band = BANDS[field];
  if (band.abs !== undefined) return band.abs as readonly [number, number];
  const baseValue = base[field] as number;
  const rel = band.rel as readonly [number, number];
  return [baseValue * rel[0], baseValue * rel[1]];
}

/** The band, both edges. The parser's rail; NOT the decoder's — see below. */
function valueBandError(base: WeaponDef, field: VariantField, v: number): string | null {
  const [lo, hi] = bandEdgesFor(base, field);
  if (v < lo - EPS || v > hi + EPS) return `${field} ${v} is outside ${lo}..${hi}`;
  return null;
}

/**
 * The half of the band that does NOT depend on the receiver's copy of the
 * weapon table: nothing here is ever negative.
 *
 * Every band's floor is zero or above on every archetype — the absolute ones
 * start at 1, 0 and 0.5, and the relative ones are a non-negative multiplier
 * times a base stat that is itself non-negative — so this refuses strictly
 * less than the band does and cannot refuse anything the band would allow.
 * It is stated separately rather than derived because it is the only piece of
 * the band the wire can enforce without importing the whole coupling the band
 * carries with it, and `variants.test.ts` walks all 7 x 16 pairs through
 * `bandEdgesFor` so this cannot quietly become a claim the table stopped
 * supporting.
 *
 * It earns its place on the u16/u8 narrowings: `magSize: -7` keeps the raw
 * -7 and gives `hot.magSize` 65529, and `pellets: -1` gives `hot.pellets`
 * 255. Those are the fractional-magazine bug with a bigger number on it.
 */
function negativeValueError(field: VariantField, v: number): string | null {
  return v < 0 ? `${field} ${v} is negative` : null;
}

/* ------------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------------ */

/** Apply an override to a base, for scoring. Not the arsenal's assembly step. */
export function applyOver(
  base: WeaponDef, over: Readonly<Partial<Record<VariantField, number>>>,
): WeaponDef {
  return Object.freeze({ ...base, ...over, id: base.id }) as WeaponDef;
}

export function parseVariantsManifest(text: string): VariantsParseResult {
  const errors: string[] = [];
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    // NOT copied from parseItemsManifest, which read its array outside the try
    // and threw a TypeError past every caller on the literal `null`.
    if (parsed === null || typeof parsed !== 'object') {
      return { manifest: null, errors: ['not a JSON object'] };
    }
    root = parsed as Record<string, unknown>;
  } catch {
    return { manifest: null, errors: ['not valid JSON'] };
  }

  const list = Array.isArray(root.variants) ? root.variants : null;
  if (list === null) return { manifest: null, errors: ['no variants array'] };
  if (list.length > MAX_VARIANTS_PER_PACK) {
    return {
      manifest: null,
      errors: [`${list.length} variants is over the ${MAX_VARIANTS_PER_PACK} cap`],
    };
  }

  const seen = new Set<string>();
  const variants: VariantDef[] = [];

  for (const entry of list) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    if (id !== sanitiseContentId(id) || id.length === 0) {
      errors.push(`variant id "${id}" is not a canonical slug`);
      continue;
    }
    if (seen.has(id)) { errors.push(`duplicate variant id "${id}"`); continue; }
    seen.add(id);

    const baseId = typeof e.base === 'number' ? e.base : -1;
    if (!Number.isInteger(baseId) || baseId < 0 || baseId >= WEAPON_COUNT) {
      errors.push(`${id}: base ${String(e.base)} is not a WeaponId`);
      continue;
    }
    const base = WEAPONS[baseId];

    const name = typeof e.name === 'string' ? e.name.slice(0, MAX_VARIANT_NAME) : '';
    if (name.length === 0) { errors.push(`${id}: no display name`); continue; }

    const rawOver = (e.over ?? null) as Record<string, unknown> | null;
    if (rawOver === null || typeof rawOver !== 'object' || Array.isArray(rawOver)) {
      errors.push(`${id}: no over object`);
      continue;
    }

    const over: Partial<Record<VariantField, number>> = {};
    let bad = false;
    for (const key of Object.keys(rawOver)) {
      const field = key as VariantField;
      // `Object.hasOwn`, not `BANDS[key] === undefined`. `JSON.parse` gives
      // `{"toString": 1}` an OWN key, `Object.keys` returns it, and
      // `BANDS.toString` then finds Object.prototype's method — which is not
      // undefined, so the whitelist ADMITTED it and the band read below threw
      // "Cannot read properties of undefined (reading '0')" out of both
      // `checkVariantsValidate` and `variantsAt`, instead of refusing.
      const band = Object.hasOwn(BANDS, key) ? BANDS[field] : undefined;
      if (band === undefined) {
        // Not ignored. A field outside the whitelist is a variant asking for
        // something the schema does not sell, and silently dropping it would
        // ship a stat line whose author believes it does something.
        errors.push(`${id}: "${key}" is not a variant-able field`);
        bad = true;
        continue;
      }
      // A non-number becomes NaN and is refused by the finiteness rule below,
      // with the message it has always had. The coercion is what lets ONE
      // shared function serve both this door and the wire's, where the bytes
      // are a `Float64Array` and cannot be anything but numbers.
      const raw = rawOver[key];
      const v = typeof raw === 'number' ? raw : Number.NaN;
      const shape = valueShapeError(field, v);
      if (shape !== null) {
        errors.push(`${id}: ${shape}`);
        bad = true;
        continue;
      }
      if (isInert(base, field)) {
        errors.push(
          `${id}: ${field} does nothing on ${base.name} — `
          + `${inertReason(base, field)}`,
        );
        bad = true;
        continue;
      }
      const outOfBand = valueBandError(base, field, v);
      if (outOfBand !== null) {
        errors.push(`${id}: ${outOfBand}`);
        bad = true;
        continue;
      }
      over[field] = v;
    }
    if (bad) continue;

    if (Object.keys(over).length === 0) {
      errors.push(`${id}: overrides nothing — a variant that changes no number is not a variant`);
      continue;
    }

    const eff = applyOver(base, over);

    // The cross-field rail. `damage` and `pellets` are only meaningful
    // together — a slug is one pellet hitting as hard as the spread used to,
    // and banding either alone either forbids that or lets a seven-pellet
    // weapon quietly double its whole payload.
    const payloadBase = base.damage * base.pellets;
    const payloadNow = eff.damage * eff.pellets;
    if (payloadNow < payloadBase * PAYLOAD_BAND[0] - EPS
      || payloadNow > payloadBase * PAYLOAD_BAND[1] + EPS) {
      errors.push(
        `${id}: per-shot payload ${payloadNow} is outside `
        + `${payloadBase * PAYLOAD_BAND[0]}..${payloadBase * PAYLOAD_BAND[1]} `
        + `(damage × pellets, against ${base.name}'s ${payloadBase})`,
      );
      continue;
    }

    const report = scoreVariant(base, eff);
    if (!report.withinBand) {
      errors.push(
        `${id}: power budget ${(report.budget).toFixed(4)} is ${(report.delta * 100).toFixed(1)}% `
        + `off ${base.name}, outside ±${(BUDGET_TOLERANCE * 100).toFixed(0)}% `
        + `(${report.axes.map((a) => `${a.axis} ×${a.ratio.toFixed(3)}`).join(', ')})`,
      );
      continue;
    }
    if (report.dominates) {
      errors.push(
        `${id}: better than ${base.name} on every axis and worse on none — `
        + 'a straight upgrade, which the power budget alone does not catch '
        + `(${report.axes.map((a) => `${a.axis} ×${a.ratio.toFixed(3)}`).join(', ')})`,
      );
      continue;
    }

    variants.push(Object.freeze({ id, base: baseId as WeaponId, name, over: Object.freeze(over) }));
  }

  if (errors.length > 0) return { manifest: null, errors };
  return { manifest: Object.freeze({ variants: Object.freeze(variants) }), errors };
}

function inertReason(base: WeaponDef, field: VariantField): string {
  switch (field) {
    case 'pellets': return 'only a hitscan weapon fires more than one';
    case 'headshotMultiplier': return 'only resolveHitscan tests for a head';
    case 'reloadMs':
      return base.magSize <= 0
        ? 'it never reloads'
        : 'it reloads shell by shell, on reloadShellMs, which is not variant-able';
    case 'magSize': return 'it has no magazine';
    case 'spread': case 'spreadMax': case 'spreadPerShot':
      return 'melee resolves down the aim with no cone';
    case 'falloffStart': case 'falloffEnd': case 'falloffMin': case 'falloffCurve':
      return 'a projectile stores its damage at spawn and falloff never runs';
    case 'projectileSpeed': return 'it fires no projectile';
    case 'splashRadius': case 'splashDamage': return 'it has no splash to scale';
    default: return 'it is not read on this archetype';
  }
}

/* ------------------------------------------------------------------------ *
 * Fingerprint
 * ------------------------------------------------------------------------ */

/**
 * One canonical line per variant, id-sorted, covering EVERY whitelisted field
 * — present or not — so the console diff shows exactly which number moved and
 * a removed override reads as a change rather than as nothing.
 *
 * Fields are emitted in `VARIANT_FIELDS` order and an absent one is `-`, which
 * keeps a line short enough for the release gate's 160-byte cap on input lines
 * even at the 48-character content-id limit.
 */
export function variantsFingerprintInputs(manifest: VariantsManifest): string[] {
  return [...manifest.variants]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((v) => `${v.id}:${v.base}/`
      + VARIANT_FIELDS.map((f) => (v.over[f] === undefined ? '-' : String(v.over[f]))).join(','));
}

/* ------------------------------------------------------------------------ *
 * The wire — S2C.VARIANT_TABLE
 *
 * Phase V3. A room pins a variant table; this is how a client learns which
 * one, and which slots the server resolved for it.
 *
 * THREE DECISIONS ARE BUILT INTO THE LAYOUT, AND EACH ONE HAS A NUMBER
 * BEHIND IT.
 *
 * 1. EFFECTIVE VALUES, NOT A PRESENT/ABSENT MASK. Every row carries all 16
 *    whitelisted fields at the value the variant actually fires with, so the
 *    receiver never combines the wire with its own compiled table for any of
 *    them. This is a narrowing of the trust surface, NOT its abolition: the
 *    ~25 fields a variant may not move — `spreadAir`, `spreadRecovery`,
 *    `spreadCrouchScale`, `reloadShellMs`, `knockback`, the feel fields — are
 *    still read from the compiled archetype on both sides, exactly as they
 *    are for the base weapon today, and a bundle whose compiled table differs
 *    still mispredicts through them. (Measured: a client whose pistol
 *    `spreadAir` is 0.028 against a server's 0.014 fires an airborne cold
 *    cone of 0.03799999977648258 rad against the server's
 *    0.02399999977648258, and no field on this wire touches it. Worse, that
 *    divergence is invisible to `weaponsFingerprintInputs()`, which does not
 *    list `spreadAir` either — see HANDOVER 6.)
 *
 * 2. f64, NOT f32. `w.f32()` narrows, and a row carries fields the variant
 *    never overrode. A rocket variant that moves only `rpm` would arrive with
 *    `splashRadius` 4.400000095367432 instead of 4.4 — and `detonate()` tests
 *    that DOUBLE against the blast distance, so a body 4.40000005 m away
 *    would take an impulse of 6.3e-16 m/s where it takes exactly 0 today.
 *    A shotgun variant moving only magazine and damage would inherit a
 *    headshot multiplier of 1.600000023841858 and pay 16.00000023841858 for
 *    a headshot pellet instead of 16. f64 is lossless, so an inherited field
 *    keeps the archetype's double and `hotFor()` does exactly the narrowing
 *    it already does. 8 bytes x 16 x 64 rows is 8 KB; the writer is 16 KB and
 *    grows by doubling anyway.
 *
 * 3. IT IS DECODED BEFORE IT IS USED, ON BOTH SIDES. The server builds its
 *    arsenal from the bytes it sends, not from the manifest it parsed. With
 *    f64 that is a lossless round trip and therefore free — which is the
 *    point: it is a structural guarantee rather than a fact about today's
 *    format, and it is what keeps a future narrowing from silently splitting
 *    the two predictors in the eighth digit (the `fc01475` bug class).
 * ------------------------------------------------------------------------ */

/** One row as it travels: an id, its archetype, and all 16 fields resolved. */
export interface VariantWireEntry {
  readonly id: string;
  readonly base: WeaponId;
  /** `VARIANT_FIELDS` order, effective values. Always 16 long. */
  readonly values: Float64Array;
}

export interface VariantTableMessage {
  variants: VariantWireEntry[];
  /** `WEAPON_COUNT` bytes: the slot the SERVER resolved for each weapon id. */
  slots: Uint8Array;
}

export function createVariantTableMessage(): VariantTableMessage {
  return { variants: [], slots: new Uint8Array(WEAPON_COUNT) };
}

/**
 * Worst case on the wire: 1 opcode + 1 count + 64 rows of
 * (1 + 48 id bytes + 1 base + 16 x 8) + WEAPON_COUNT slot bytes.
 *
 * Stated as arithmetic rather than as a literal so it cannot drift away from
 * the constants it is made of, and asserted in the tests.
 */
export const MAX_VARIANT_TABLE_BYTES =
  2 + MAX_VARIANTS_PER_PACK * (1 + MAX_CONTENT_ID_LENGTH + 1 + VARIANT_FIELDS.length * 8)
  + WEAPON_COUNT;

/** The 16 effective values of one parsed variant, in `VARIANT_FIELDS` order. */
export function wireValuesFor(v: VariantDef): Float64Array {
  const eff = applyOver(WEAPONS[v.base], v.over);
  const out = new Float64Array(VARIANT_FIELDS.length);
  for (let i = 0; i < VARIANT_FIELDS.length; i++) out[i] = eff[VARIANT_FIELDS[i]] as number;
  return out;
}

/** A parsed manifest as rows. Order IS the slot order: row i becomes slot i+1. */
export function wireEntriesFor(manifest: VariantsManifest): VariantWireEntry[] {
  return manifest.variants.map((v) => ({ id: v.id, base: v.base, values: wireValuesFor(v) }));
}

export function encodeVariantTable(
  w: PacketWriter, entries: readonly VariantWireEntry[], slots: Uint8Array,
): PacketWriter {
  w.reset();
  w.u8(S2C.VARIANT_TABLE);
  const n = entries.length > MAX_VARIANTS_PER_PACK ? MAX_VARIANTS_PER_PACK : entries.length;
  w.u8(n);
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    w.str(e.id, MAX_CONTENT_ID_LENGTH);
    w.u8(e.base & 0xff);
    for (let f = 0; f < VARIANT_FIELDS.length; f++) w.f64(e.values[f]);
  }
  for (let i = 0; i < WEAPON_COUNT; i++) w.u8(slots[i] ?? 0);
  return w;
}

/**
 * Decode, or refuse — never half of one.
 *
 * Returns `null` on anything it cannot vouch for, and does NOT touch `out`
 * until every byte has been read, so a truncated packet leaves the receiver's
 * existing table and slot map exactly where they were. That atomicity is the
 * point: a partially replaced arsenal is two predictors disagreeing, which is
 * the one failure this whole arc exists to prevent.
 *
 * A row whose `base` is not a `WeaponId` refuses the WHOLE message rather
 * than being dropped. Dropping would renumber every later slot, and the slot
 * map that arrives with it was numbered by the sender.
 *
 * WHICH OF THE PARSER'S REFUSALS THIS DOOR REPEATS, AND WHICH IT DOES NOT.
 *
 * It repeats the rules that are true of a NUMBER IN ITSELF, through the same
 * functions the pack parser calls rather than a second reading of them:
 * finite, whole where `BANDS[field].integer` says counts are counts, and not
 * negative. A single failure refuses the whole message, exactly as a bad
 * `base` does.
 *
 *   - NaN is not a stat line, it is the absence of one. `hot.damage` is
 *     `f32(NaN)`, `damageAtDistanceOf` returns NaN at every distance, and a
 *     victim whose health goes NaN never dies and never heals: NaN compares
 *     false against everything, so no clamp in the game recovers from it.
 *   - A fractional count splits ONE `EffectiveWeapon` against itself.
 *     `magSize: 7.5` narrows to `hot.magSize` 7, so the client fills a
 *     magazine to 7 and then tests `this.mag[id] >= def.magSize` — 7 >= 7.5
 *     is false — and reloads a full weapon forever, while the server fills
 *     the same magazine to 7.5 (`server/src/horde.ts:1054`). Neither side is
 *     wrong about the wire; the value has no coherent reading on either.
 *   - A negative is the same fault with a wider blast: `magSize: -7` gives
 *     `hot.magSize` 65529 against a raw -7.
 *
 * It does NOT repeat the RELATIVE half of the band, the payload band, the
 * power budget, the strict-dominance refusal or the inert refusal — and the
 * line between the two lists is not "whatever is cheap to compute". Every one
 * of those is computable here; the row carries its own `base`, so
 * `WEAPONS[base]` and `scoreVariant` are both in reach. The line is what a
 * refusal COSTS when it is wrong.
 *
 * Refusing this message does not stop the sender simulating the table. It
 * makes the receiver fall back to the base arsenal while the sender keeps
 * firing the variant — two predictors disagreeing, which is the exact failure
 * the refusal was meant to prevent. So a decode-time refusal only pays for
 * itself on a value that NOBODY could simulate coherently, and every check
 * above is of that kind while none of the checks below it is. A variant 15%
 * over budget, or better on every axis, or paying in a field its archetype
 * cannot read, is bad CONTENT — perfectly simulable, and caught at pack-parse
 * time by the party that has both the authority to judge it and the error
 * strings to explain itself. It is not a wire fault, and a receiver is not
 * the authority on what content a room may run.
 *
 * The band's upper edge and its relative floor are excluded for a second and
 * sharper reason: they are scaled by the RECEIVER's compiled `WEAPONS` table,
 * and this game deploys its two halves separately (the server on Railway, the
 * static client on Vercel, which VARIANTS.md §2 notes is outside the release
 * mechanism entirely). A client running yesterday's weapon table is the
 * NORMAL state during a rebalance, not a hypothetical — and a band check
 * would turn that from "the ~25 non-variant-able fields mispredict", which is
 * decision 1's stated and accepted cost, into "every row is refused and both
 * ends desync through the fallback". The floor of zero is the only part of
 * the band that carries none of that coupling, because no revision of the
 * weapon table will ever give a stat a negative value. `version.test.ts`'s
 * frozen VARIANT_TABLE vector is the standing proof that this door must not
 * be band-checked: its row declares `base: 1` and then carries the PISTOL's
 * numbers (rpm 420 against the shotgun's band of 22.5..120), and it has to
 * keep decoding.
 *
 * The inert refusal is different again: it is not declined, it is UNASKABLE.
 * Decision 1 of the layout is that every row carries all 16 fields at their
 * effective value whether the variant moved them or not, so "did this row
 * override `falloffStart`?" is a question the bytes cannot answer — an inert
 * field arrives holding the archetype's own number, which is what a
 * well-formed row is supposed to look like. Recasting it as "an inert field
 * must equal `WEAPONS[base]` exactly" would put the compiled table back in
 * authority over the very fields decision 1 took it out of, and on the
 * strictest possible terms: an eighth-digit difference would refuse every
 * row.
 *
 * The hazard the band exists for in the parser does not reach this door
 * either. `terrainDamage`, the field whose 1e20 would have hung
 * `world.carveSphere` forever, was deliberately removed from the whitelist
 * and is not on this wire, and the two remaining distance-driven loops are
 * capped independently of any stat: `raycastVoxels` stops at 512 steps
 * (`shared/src/math.ts:556`) and `detonate` iterates players and entities,
 * not metres. A finite, non-negative, absurd number on this wire buys a
 * ridiculous match, not a wedged event loop — and on the peer topology it
 * buys it in a match that `shared/src/trust.ts` already grants nothing for.
 *
 * Honest about reach: on the dedicated-server topology the sender is our own
 * server writing rows from a manifest this module already parsed, so this is
 * defence in depth. On the WebRTC peer topology the "server" is another
 * player's browser and can send precisely these bytes. `shared/src/trust.ts`
 * already grants nothing from a peer-hosted match, so this is not an economy
 * hole — it is a SIMULATION hole, and the thing it protects is the receiving
 * client's own predictor.
 */
export function decodeVariantTable(
  r: PacketReader, out: VariantTableMessage,
): VariantTableMessage | null {
  if (r.remaining < 2) return null;
  r.u8();
  const count = r.u8();
  if (count > MAX_VARIANTS_PER_PACK) return null;
  const rows: VariantWireEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (r.remaining < 1) return null;
    const idLen = r.bytes[r.offset];
    if (r.remaining < 1 + idLen + 1 + VARIANT_FIELDS.length * 8) return null;
    const id = sanitiseContentId(r.str());
    if (id.length === 0) return null;
    const base = r.u8();
    if (!Number.isInteger(base) || base < 0 || base >= WEAPON_COUNT) return null;
    const values = new Float64Array(VARIANT_FIELDS.length);
    for (let f = 0; f < VARIANT_FIELDS.length; f++) values[f] = r.f64();
    for (let f = 0; f < VARIANT_FIELDS.length; f++) {
      const field = VARIANT_FIELDS[f];
      const v = values[f];
      if (valueShapeError(field, v) !== null) return null;
      if (negativeValueError(field, v) !== null) return null;
    }
    rows.push({ id, base: base as WeaponId, values });
  }
  if (r.remaining < WEAPON_COUNT) return null;
  const slots = new Uint8Array(WEAPON_COUNT);
  for (let i = 0; i < WEAPON_COUNT; i++) slots[i] = r.u8();
  out.variants = rows;
  out.slots = slots;
  return out;
}

/**
 * Decoded rows as the assembly step wants them.
 *
 * `SessionArsenal.from` gives overlay `i` slot `i + 1`, which is the same
 * numbering the sender used when it wrote the slot map, so the two agree by
 * construction rather than by convention.
 */
export function overlaysFromWire(
  entries: readonly VariantWireEntry[],
): { id: string; base: number; over: Partial<Record<VariantField, number>> }[] {
  return entries.map((e) => {
    const over: Partial<Record<VariantField, number>> = {};
    for (let f = 0; f < VARIANT_FIELDS.length; f++) over[VARIANT_FIELDS[f]] = e.values[f];
    return { id: e.id, base: e.base, over };
  });
}
