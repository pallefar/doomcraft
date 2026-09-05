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
 *   1. THE WHITELIST + BANDS. Only 17 fields may move, every one of them has a
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

import { sanitiseContentId } from './modes.ts';
import {
  FireKind, WEAPON_COUNT, WeaponId, WEAPONS, type WeaponDef,
} from './weapons.ts';

/* ------------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------------ */

/** The 17 fields a variant may move. Everything else is a refusal. */
export type VariantField =
  | 'damage' | 'pellets' | 'headshotMultiplier' | 'rpm' | 'magSize' | 'reloadMs'
  | 'splashRadius' | 'splashDamage' | 'terrainDamage'
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
  terrainDamage: { rel: [0, 1.5] },
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
    case 'terrainDamage':
      return base.terrainDamage <= 0;
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
      const band = BANDS[field];
      if (band === undefined) {
        // Not ignored. A field outside the whitelist is a variant asking for
        // something the schema does not sell, and silently dropping it would
        // ship a stat line whose author believes it does something.
        errors.push(`${id}: "${key}" is not a variant-able field`);
        bad = true;
        continue;
      }
      const v = rawOver[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`${id}: ${field} is not a finite number`);
        bad = true;
        continue;
      }
      if (band.integer === true && !Number.isInteger(v)) {
        // `pellets: 1.5` sits inside 1..12 and makes the SERVER fire twice
        // (`i < def.pellets`) while the client fires one; `magSize: 7.5` makes
        // a reload transfer half a round, which the typed arrays resolve as
        // destroying a reserve round and loading nothing.
        errors.push(`${id}: ${field} must be a whole number, not ${v}`);
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
      const baseValue = base[field] as number;
      const lo = band.abs !== undefined ? band.abs[0] : baseValue * (band.rel as readonly [number, number])[0];
      const hi = band.abs !== undefined ? band.abs[1] : baseValue * (band.rel as readonly [number, number])[1];
      if (v < lo - EPS || v > hi + EPS) {
        errors.push(`${id}: ${field} ${v} is outside ${lo}..${hi}`);
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
    case 'terrainDamage': return 'it carves no terrain';
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
