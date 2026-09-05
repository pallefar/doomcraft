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

/**
 * Mirrors `MAX_PACK_INPUT_BYTES` (shared/src/packs.ts), which `checkPackInputs`
 * (server/src/gate.ts) enforces in BOTH release gates over the assembled pack
 * set — this pack included. Declared here rather than imported to keep this
 * module free of the pack registry, the same split `shared/src/challenges.ts`
 * makes for `MAX_CHALLENGE_INPUT_BYTES`; the test asserts the two agree, so
 * they cannot drift.
 */
export const MAX_VARIANT_INPUT_BYTES = 160;

/** UTF-8 byte length without node:Buffer — this module runs in the browser too. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

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
 * into several of them is not decoration. The parser interleaves a further
 * refusal (`isInert`) between the archetype-free rules and the band, and it
 * has to stay there: an inert field is reported with a value of
 * `base[f] || 1`, so on a field whose base is 0 — a pistol's `splashRadius`,
 * a chainsaw's `magSize` — a combined check would fire the band first and
 * answer "outside 0..0" where "the pistol has no splash to scale" is the true
 * and useful answer. Separate functions keep that order exactly, with no
 * duplicated check, and let the wire decoder take the subset of rules it can
 * afford to enforce — which is NOT all of them, and `decodeVariantTable`
 * argues at length about which.
 *
 * THE INVARIANT BETWEEN THE TWO DOORS, AND THE DAY IT WAS FALSE.
 *
 * Anything `parseVariantsManifest` accepts, `decodeVariantTable` MUST accept.
 * Not the other way round — the decoder is deliberately the looser door, and
 * the long note on it says why — but this direction is not a preference, it
 * is the difference between a loud failure and a silent one.
 *
 * It was broken for a few hours on 2026-09-05, by the commit that gave the
 * decoder its negative rail. The parser's band compares with a tolerance
 * (`v < lo - EPS`, EPS = 1e-9) so that "unchanged" survives an arithmetic
 * round trip; the decoder's `negativeValueError` refuses every negative
 * EXACTLY. The gap between them is the interval [-1e-9, 0), and a manifest
 * sitting in it was accepted by the parser, passed the release gate's
 * `variants.validate` — which asks only whether `parsed.manifest !== null` —
 * and was then refused by the wire. Measured, on
 * `{"magSize":4,"damage":10,"spreadPerShot":-1e-10}` against the shotgun:
 * parser 0 errors and 1 variant, gate ok, `decodeVariantTable` null, and
 * `Room.variantTable.length` 0 with an arsenal `slotCount` of 1 — because
 * `decodeRoomVariantTable` reads `decoded === null ? [] : ...`.
 *
 * That last line is the whole argument for the invariant. A refused manifest
 * is loud and fixable: the operator sees the errors and edits a number. A
 * manifest the parser blesses and the wire refuses is a room that publishes a
 * variants pack, serves an EMPTY table, and hands every player the base
 * arsenal with no error anywhere — green gate, published pack, nothing
 * happens. There is no worse outcome available in this module.
 *
 * So the fix is not "widen the decoder to match the parser's tolerance", which
 * would put a negative on the wire and make `hot.pellets` 255 out of -1. It is
 * that the parser runs the decoder's rules FIRST and IN THE DECODER'S ORDER,
 * as one contiguous block, before it reaches anything that mentions the
 * archetype. Two lists that must agree agree by construction when one of them
 * is literally the prefix of the other, and by coincidence otherwise — and
 * this file already knows what coincidence costs (`BANDS.toString`).
 *
 * The ordering principle that falls out of it is better than the one it
 * replaces, too. The shared block is exactly the rules that are true of a
 * NUMBER IN ITSELF — finite, whole, non-negative, representable — and the
 * parser-only rules that follow are exactly the ones that need an archetype
 * to even be asked. The one message this reorders is a negative on an inert
 * field, which now reads "splashRadius -1 is negative" rather than
 * "splashRadius does nothing on Pistol". That is a fair trade and not the
 * same fault as the one `isInert`-before-band exists to avoid: "outside 0..0"
 * is MISLEADING about why the field is wrong, while "is negative" is simply a
 * second true thing about the same number.
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

/**
 * How `arsenal.ts`'s `hotFor` narrows each whitelisted field — the third and
 * last of the archetype-free rules, and the one that says a value has to be
 * SIMULABLE and not merely well-formed.
 *
 * WHY A VALUE THAT DECODES IS NOT YET A VALUE THAT RUNS.
 *
 * `hotFor` reproduces the narrowing `weapons.ts` does at module load, because
 * the shipping code reads both representations of the same weapon — the def's
 * double and the typed-array read, sometimes three lines apart. That is
 * deliberate and it is not going away. But a narrowing is a function, and a
 * function has a domain: past the end of it the narrowed twin stops being a
 * lossy version of the wire value and becomes an unrelated number.
 *
 * Measured on values `decodeVariantTable` accepted the day this was written:
 *
 *     magSize   65536   ->  hot.magSize        0
 *     pellets     256   ->  hot.pellets        0
 *     damage     1e40   ->  hot.damage         Infinity
 *     rpm           0   ->  hot.fireIntervalMs Infinity
 *     rpm       1e308   ->  hot.fireIntervalMs 0
 *
 * and with `damage: 1e40` beside `falloffMin: 0`, `damageAtDistanceOf` returns
 * NaN at long range — `Infinity × 0` — which is the health-goes-NaN-forever
 * failure the finiteness rule already exists to prevent, reached through a
 * value that IS finite on the wire.
 *
 * Every one of those is half a decode. `decodeVariantTable`'s own headline is
 * "Decode, or refuse — never half of one", and a row whose magazine is 65536
 * on the wire and 0 in the hand is exactly half of one: it is the
 * `magSize: 7.5` bug — one `EffectiveWeapon` disagreeing with itself about one
 * weapon — with a bigger number on it. A weapon with `hot.magSize` 0 and
 * `magSize` 65536 can never finish a reload; `hot.pellets` 0 fires no pellets
 * at all while the budget was scored on 256 of them; `fireIntervalMs` 0 is a
 * shot every frame and Infinity is a gun that never fires again.
 *
 * WHERE THE LINE IS DRAWN, AND WHY IT IS NOT `f32(v) === v`.
 *
 * "Survive its own narrowing" cannot mean equality for the float32 fields.
 * The rocket's real `splashRadius` 4.4 narrows to 4.400000095367432, the
 * pistol's `60000/rpm` to 142.85714721679688, and `arsenal.ts` documents those
 * six lossy pairs as SHIPPED BEHAVIOUR that a seam must not quietly unify.
 * Demanding equality would refuse the compiled table itself. So the rule per
 * width is the strongest one that still admits every value the narrowing is a
 * faithful lossy image of:
 *
 *   - `u8` / `u16` are exact on their whole domain, so equality is the right
 *     test and it is free: it refuses only what is out of range (a
 *     non-integer is already gone at `valueShapeError`, a negative at
 *     `negativeValueError`).
 *   - `f32` is lossy everywhere and total until it overflows, so the test is
 *     that the narrowed twin is still FINITE. Below ~3.4e38 the twin is a
 *     rounding of the wire value; above it, it is Infinity, which is not.
 *   - `rpm` is not narrowed at all — it is CONSUMED. `fireIntervalMs` is
 *     `f32(60000 / rpm)`, so the rule belongs to the derived quantity: it must
 *     be finite and strictly greater than zero, which is what "a shot interval"
 *     means. This is the only field whose rail catches a value neither of the
 *     others would: `rpm: 0` is not negative and is perfectly finite, and
 *     `rpm: -0` is not even negative (`-0 < 0` is false) while `60000 / -0` is
 *     -Infinity.
 *
 * THE NINE FIELDS WITH NO RAIL, AND THE ARGUMENT FOR LEAVING THEM ALONE.
 *
 * `headshotMultiplier`, `reloadMs`, `spread`, `spreadMax`, `spreadPerShot`,
 * `falloffStart`, `falloffEnd`, `falloffMin`, `falloffCurve` are not in
 * `HotWeapon` at all. Both predictors read them as the f64 that came off the
 * wire, through `EffectiveWeapon`'s own fields, and do the same arithmetic on
 * them — so there is no narrowing to survive and no second representation to
 * disagree with. A finite non-negative double is already fully representable
 * for them, and inventing a ceiling here would be a BAND, which this file
 * refuses to put on the wire for reasons `decodeVariantTable` spends two
 * paragraphs on. They can still buy a ridiculous match; that is decision 1's
 * accepted cost, and it is the same cost the base arsenal already carries.
 *
 * The rail is scoped to CONSTRUCTION — what `SessionArsenal.from` computes
 * once when it builds the table — and not to every quantity the firing path
 * later derives. That is a real boundary and not a convenience: a construction
 * result is stored and read forever by both sides, while a firing-path
 * quantity is recomputed identically on both sides from the same stored
 * numbers, so an absurd one is a bad match rather than a split predictor.
 *
 * The map is exported so `variants.test.ts` can drive every field through a
 * real `SessionArsenal` and prove this classification is what `hotFor`
 * actually does — the narrowers below are a second copy of three lines of
 * `arsenal.ts` (they are private there and this module may not widen that
 * file's API to borrow them), and an unwitnessed second copy of a rule is the
 * exact scar this file already carries.
 */
export const HOT_NARROWING: Readonly<Record<VariantField, 'u8' | 'u16' | 'f32' | 'fireInterval' | 'none'>> =
  Object.freeze({
    damage: 'f32',
    pellets: 'u8',
    headshotMultiplier: 'none',
    rpm: 'fireInterval',
    magSize: 'u16',
    reloadMs: 'none',
    splashRadius: 'f32',
    splashDamage: 'f32',
    spread: 'none',
    spreadMax: 'none',
    spreadPerShot: 'none',
    falloffStart: 'none',
    falloffEnd: 'none',
    falloffMin: 'none',
    falloffCurve: 'none',
    projectileSpeed: 'f32',
  });

const F32_VIEW = new Float32Array(1);
const U16_VIEW = new Uint16Array(1);
const U8_VIEW = new Uint8Array(1);

/** The narrowed twin `arsenal.ts` will hold for this field, or `v` if none. */
export function narrowedValueOf(field: VariantField, v: number): number {
  switch (HOT_NARROWING[field]) {
    case 'f32': F32_VIEW[0] = v; return F32_VIEW[0];
    case 'u16': U16_VIEW[0] = v; return U16_VIEW[0];
    case 'u8': U8_VIEW[0] = v; return U8_VIEW[0];
    case 'fireInterval': F32_VIEW[0] = 60000 / v; return F32_VIEW[0];
    default: return v;
  }
}

/** The value has a narrowed twin the engine can actually run with. */
function representabilityError(field: VariantField, v: number): string | null {
  const kind = HOT_NARROWING[field];
  if (kind === 'none') return null;
  const n = narrowedValueOf(field, v);
  if (kind === 'fireInterval') {
    return Number.isFinite(n) && n > 0
      ? null
      : `rpm ${v} gives a shot interval of ${n} ms, which is not a duration`;
  }
  if (kind === 'f32') {
    return Number.isFinite(n)
      ? null
      : `${field} ${v} overflows the float32 hot.${field}, which becomes ${n}`;
  }
  return n === v
    ? null
    : `${field} ${v} does not survive the ${kind} narrowing of hot.${field}, which becomes ${n}`;
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
    // The name is IN the fingerprint line now (see `variantsFingerprintInputs`)
    // and the review digest is those lines joined with '\n'. A name carrying
    // its own newline therefore stops being one token in one record: it prints
    // as an extra line in the diff that no variant owns, and it lets a
    // one-variant manifest reproduce the joined bytes of a two-variant one —
    // an operator approving a single row over a digest that means something
    // else. Tab and the rest of C0 are the same defect with a quieter
    // symptom: invisible in a diff, so two names that read identically to the
    // reviewer can carry different identities.
    //
    // REFUSED, NOT STRIPPED. Stripping would mint a display string the author
    // never wrote and never sees, which is the exact "approve one string,
    // serve another" failure putting the name in the line is here to close.
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      errors.push(`${id}: display name has a control character — one fingerprint `
        + 'line is one variant, and a newline or tab inside it forges the review diff');
      continue;
    }

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
      // THE WIRE'S RULES, IN THE WIRE'S ORDER, BEFORE ANYTHING ARCHETYPE-AWARE.
      //
      // These three lines are the same three `decodeVariantTable` runs, and
      // they are kept as a contiguous prefix on purpose: the invariant is that
      // anything this parser accepts the decoder accepts, and the only way to
      // hold it by construction rather than by coincidence is for one list to
      // BE the prefix of the other. The long note above them has the measured
      // cost of the day they diverged — a manifest with `spreadPerShot: -1e-10`
      // that parsed clean, passed the release gate, and served a room an empty
      // variant table.
      //
      // In particular the band below must NOT be relied on to catch a
      // negative. It compares with EPS slack so an arithmetic round trip does
      // not read as a change, and that slack is a hole exactly one nanometre
      // wide that the wire does not have.
      const shape = valueShapeError(field, v);
      if (shape !== null) {
        errors.push(`${id}: ${shape}`);
        bad = true;
        continue;
      }
      const negative = negativeValueError(field, v);
      if (negative !== null) {
        errors.push(`${id}: ${negative}`);
        bad = true;
        continue;
      }
      const unrepresentable = representabilityError(field, v);
      if (unrepresentable !== null) {
        errors.push(`${id}: ${unrepresentable}`);
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

  /* Every variant must fit ONE pack input line. `checkPackInputs` caps input
   * lines at MAX_PACK_INPUT_BYTES in BOTH release gates now, and a version
   * directory is immutable, so a manifest that parses but overflows the line
   * mints a pack that can never pass a gate and can never be edited in place
   * — an editor that accepts what the machine will refuse forever. The parser
   * owns the cap because every door into this pack goes through it, which is
   * the same reasoning and the same shape as `parseChallengesManifest`.
   *
   * THIS WAS ALREADY BROKEN BEFORE THE NAME WENT IN. Measured on the encoding
   * as it stood: the shipped two-row fixture's longest line is 56 bytes, but
   * a 48-character id (`MAX_CONTENT_ID_LENGTH`) with all sixteen fields
   * overridden at float-noise precision is 354 — over the cap, with nothing
   * anywhere saying so until release time. The name adds 41 to that, 395.
   *
   * WHERE IT ACTUALLY BITES. At the worst-case id and name the line spends
   * 48 + 1 + 1 + 1 on the prefix and 1 + 40 on the name, leaving 68 bytes for
   * sixteen columns and fifteen commas: 31 + k*(len - 1) <= 68 for k
   * overrides of `len` characters each. Seventeen-character float noise
   * (`20.900000000000002`) buys k = 2; six-character values (`0.0123`) buy 7;
   * three-character ones fit all sixteen. At the twelve-character ids real
   * variants have (`shotgun-slug`) it is 4 and 14. Realistic rows override
   * two to six fields, so this refuses only the extreme — a maximum-length id
   * AND a maximum-length name AND unrounded floats, together. It is a guard
   * rail, not a budget an author has to think about.
   *
   * It is deliberately NOT mirrored into `decodeVariantTable`. The invariant
   * that anything the parser accepts the decoder accepts is about VALUES —
   * the three wire rules run as a contiguous prefix above for exactly that
   * reason. This is not a value rule. The wire carries no id length and no
   * name at all (the table is base + 16 f64s and a slot), so there is no
   * decoder-side quantity to check and no manifest this refuses that the
   * decoder would have taken. Adding a length check to the decoder would
   * invent a rule the wire cannot express.
   */
  for (const line of variantsFingerprintInputs({ variants })) {
    const bytes = utf8Bytes(line);
    if (bytes > MAX_VARIANT_INPUT_BYTES) {
      errors.push(`${line.slice(0, line.indexOf(':'))}: its id, overrides and name make a `
        + `${bytes}-byte pack input line, over the ${MAX_VARIANT_INPUT_BYTES}-byte cap `
        + '(MAX_PACK_INPUT_BYTES — the release gate would refuse the version forever)');
    }
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
 * Fields are emitted in `VARIANT_FIELDS` order and an absent one is `-`.
 *
 * THE NAME IS LAST, AND THAT POSITION IS THE ARGUMENT.
 *
 * Until 2026-09-05 the name was not in the line at ALL. Renaming "Four Shell"
 * to "Renamed" left the fingerprint at 351436725 and the sha256 digest
 * byte-identical, so an operator could review and approve one display string
 * while the host served another, with nothing in the diff to see it by —
 * against a file (shared/src/packs.ts) whose whole reason for checking the
 * input LISTS in is that "the reviewable artifact is the diff, never the
 * number". V4 puts that string on the HUD and the killfeed, so it is not
 * cosmetic metadata; it is what a player is told they are holding.
 *
 * It goes at the END because it is the only FREE-FORM token in the line. `id`
 * is a `sanitiseContentId` slug (`[a-z0-9_-]`), `base` is a digit, and the
 * sixteen columns are `-` or `String(number)` — none of them can contain `/`
 * or `,`. A free-form token is unambiguous only where it is terminal: the
 * reader takes everything after the second `/` and stops. Anywhere else and a
 * name holding a `,` forges a column boundary while a name holding a `/`
 * shifts every field one place, so renaming a variant would print as sixteen
 * numbers moving — the precise opposite of what a field-level line diff is
 * for. Terminal position also leaves the positional block byte-identical to
 * what it was before the name existed, so a pure rename diffs as one token
 * appended-side and nothing else. `challengesFingerprintInputs` already
 * trails its free text (`/${c.name}/${c.blurb}`); the two data packs now read
 * alike.
 *
 * A name cannot smuggle a line break past this: `parseVariantsManifest`
 * refuses C0 controls, and it also refuses a line over
 * `MAX_VARIANT_INPUT_BYTES`. The claim this comment used to make — that the
 * positional encoding "keeps a line short enough for the release gate's
 * 160-byte cap even at the 48-character content-id limit" — was measurably
 * FALSE and is gone; see the parser.
 */
export function variantsFingerprintInputs(manifest: VariantsManifest): string[] {
  return [...manifest.variants]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((v) => `${v.id}:${v.base}/`
      + VARIANT_FIELDS.map((f) => (v.over[f] === undefined ? '-' : String(v.over[f]))).join(',')
      + `/${v.name}`);
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
 * finite, whole where `BANDS[field].integer` says counts are counts, not
 * negative, and representable — with a narrowed twin in `hotFor` that is
 * still a lossy image of the wire value rather than an unrelated number. A
 * single failure refuses the whole message, exactly as a bad `base` does.
 *
 * Those four are also, in that order, the FIRST four things
 * `parseVariantsManifest` does to a field, and the ordering is load-bearing
 * rather than tidy: the invariant that anything the parser accepts this door
 * accepts holds by construction only while one list is the literal prefix of
 * the other. The note on `negativeValueError` above has the measurement from
 * the day it was not.
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
 *   - And a value past the END of its narrowing is the same fault again with
 *     no sign on it: `magSize: 65536` gives `hot.magSize` 0, `pellets: 256`
 *     gives `hot.pellets` 0, `damage: 1e40` gives `hot.damage` Infinity, and
 *     `rpm: 0` and `rpm: 1e308` give a shot interval of Infinity and 0. See
 *     `HOT_NARROWING` for the full argument, including why the rule for the
 *     float32 fields is finiteness and not equality — `splashRadius` 4.4
 *     narrows to 4.400000095367432 and always has.
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
      if (representabilityError(field, v) !== null) return null;
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
