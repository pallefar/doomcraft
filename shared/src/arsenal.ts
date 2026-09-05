/**
 * DOOMCRAFT — the session arsenal.
 *
 * VARIANTS.md §2: "a `SessionArsenal` object — `statsFor(weaponId,
 * variantSlot): EffectiveWeapon` — constructed once per session/room from
 * (compiled base table + the room's pinned variant table + each player's
 * equipped variant claims). Both predictors take it as a constructor argument
 * instead of importing the module tables directly."
 *
 * This is phase V1: the seam, and nothing behind it. There is exactly one slot,
 * slot 0, and it holds the compiled table. `SessionArsenal.compiled()` is what
 * every caller gets today, and its §2 invariant is that a session with zero
 * variants installed behaves byte-identically to one that never heard of this
 * file — pinned by `client/src/game/lockstep.test.ts`.
 *
 * WHY THE `hot` RECORD EXISTS, AND WHY IT IS NOT FLATTENED INTO THE DEF.
 *
 * `shared/src/weapons.ts` keeps two representations of the same weapon, and
 * they are not equal. `WEAPONS[i]` holds JavaScript doubles; the derived hot
 * tables hold the same numbers narrowed to Float32Array / Uint16Array /
 * Uint8Array at module load. The narrowing is lossy for six of them:
 *
 *     splashRadius   rocket   4.4     -> 4.400000095367432
 *     splashRadius   plasma   0.9     -> 0.8999999761581421
 *     60000/rpm      pistol   142.857142857...  -> 142.85714721679688
 *     60000/rpm      chaingun  85.714285714...  ->  85.71428680419922
 *     60000/rpm      rocket   681.818181818...  -> 681.8181762695312
 *     60000/rpm      plasma    90.909090909...  ->  90.90908813476562
 *
 * and the shipping code reads BOTH, sometimes three lines apart:
 * `splashDamageAt` uses the float32 radius while `sim.ts`'s detonate loop tests
 * `def.splashRadius`, the double. That difference is presently harmless — the
 * tighter cutoff wins — but it is a real difference, and a seam that quietly
 * unified the two would be a behaviour change wearing a refactor's clothes.
 *
 * So an `EffectiveWeapon` carries the def's doubles as its own fields AND the
 * narrowed values under `hot`, reproduced through typed arrays of the same
 * widths the module uses. Call sites keep reading whichever one they read
 * before. Nothing is unified here; unification, if it is ever wanted, is a
 * separate change with its own argument and its own moved golden.
 */

import { clamp } from './constants.ts';
import {
  WEAPON_COUNT, WeaponId, WEAPONS, type WeaponDef,
} from './weapons.ts';

/* ------------------------------------------------------------------------ *
 * The effective weapon
 * ------------------------------------------------------------------------ */

/**
 * The narrowed reads. One field per derived table in `weapons.ts`, at the same
 * width, so `hot.damage` IS `WEAPON_DAMAGE[id]` and not merely close to it.
 */
export interface HotWeapon {
  /** float32 `60000 / rpm` — `WEAPON_FIRE_INTERVAL_MS`. */
  readonly fireIntervalMs: number;
  /** float32 — `WEAPON_DAMAGE`. */
  readonly damage: number;
  /** uint8 — `WEAPON_PELLETS`. */
  readonly pellets: number;
  /** uint8 — `WEAPON_KIND`. */
  readonly kind: number;
  /** uint8 — `WEAPON_AMMO`. */
  readonly ammo: number;
  /** uint16 — `WEAPON_MAG_SIZE`. */
  readonly magSize: number;
  /** float32 — `WEAPON_SPLASH_RADIUS`. */
  readonly splashRadius: number;
  /** float32 — `WEAPON_SPLASH_DAMAGE`. */
  readonly splashDamage: number;
  /** float32 — `WEAPON_PROJECTILE_SPEED`. */
  readonly projectileSpeed: number;
  /** `WEAPON_AUTOMATIC[id] === 1`. */
  readonly automatic: boolean;
}

/** One weapon as a session actually has it: the base, plus whatever a variant did. */
export interface EffectiveWeapon extends WeaponDef {
  /** 0 is the compiled base. */
  readonly variantSlot: number;
  /** Content id of the variant in this slot; '' for the base. */
  readonly variantId: string;
  readonly hot: HotWeapon;
}

/** The base slot. A revoked, dormant or mode-denied claim resolves here. */
export const BASE_SLOT = 0;

/**
 * One entry of a room's pinned variant table, ASSEMBLED — not validated.
 *
 * The whitelist, the per-field bands, the power budget and the
 * strict-dominance refusal all belong to the pack parser (V2,
 * `shared/src/variants.ts`), which is the only thing that will ever construct
 * these from bytes. This type is the handoff between that parser and this
 * assembly step, and keeping the two apart is deliberate: a room must not be
 * able to widen the whitelist by handing the arsenal a richer object.
 */
export interface WeaponOverlay {
  /** Content id of the variant. */
  readonly id: string;
  /** The archetype it modifies. */
  readonly base: number;
  /** Fields to override. */
  readonly over: Readonly<Partial<WeaponDef>>;
}

/* ------------------------------------------------------------------------ *
 * Narrowing, done the way the module does it
 * ------------------------------------------------------------------------ */

const F32 = new Float32Array(1);
const U16 = new Uint16Array(1);
const U8 = new Uint8Array(1);

function f32(v: number): number { F32[0] = v; return F32[0]; }
function u16(v: number): number { U16[0] = v; return U16[0]; }
function u8(v: number): number { U8[0] = v; return U8[0]; }

function hotFor(d: WeaponDef): HotWeapon {
  return Object.freeze({
    fireIntervalMs: f32(60000 / d.rpm),
    damage: f32(d.damage),
    pellets: u8(d.pellets),
    kind: u8(d.kind),
    ammo: u8(d.ammo),
    magSize: u16(d.magSize),
    splashRadius: f32(d.splashRadius),
    splashDamage: f32(d.splashDamage),
    projectileSpeed: f32(d.projectileSpeed),
    automatic: u8(d.automatic ? 1 : 0) === 1,
  });
}

function effectiveFor(d: WeaponDef, variantSlot: number, variantId: string): EffectiveWeapon {
  return Object.freeze({ ...d, variantSlot, variantId, hot: hotFor(d) });
}

/* ------------------------------------------------------------------------ *
 * The arsenal
 * ------------------------------------------------------------------------ */

/**
 * Per-player equipped variant claims, one slot index per weapon. All zeros is
 * "no variants equipped", which is every player in phase V1.
 */
export type VariantSlots = Uint8Array;

export function createVariantSlots(): VariantSlots {
  return new Uint8Array(WEAPON_COUNT);
}

export class SessionArsenal {
  /** How many variant slots this session resolves. V1 is always 1. */
  readonly slotCount: number;

  /** `slot * WEAPON_COUNT + weaponId`. */
  private readonly table: readonly EffectiveWeapon[];

  private constructor(table: readonly EffectiveWeapon[], slotCount: number) {
    this.table = table;
    this.slotCount = slotCount;
  }

  /**
   * The compiled table plus one slot per overlay, in the order given: overlay
   * `i` becomes slot `i + 1`, and slot 0 stays the untouched archetype.
   *
   * Nothing is validated here — see `WeaponOverlay`. An overlay naming an
   * unknown base is dropped rather than throwing, because a room resolving a
   * release must not be able to take the process down; the parser is where a
   * bad table is refused, loudly, before it ever reaches a room.
   */
  static from(overlays: readonly WeaponOverlay[]): SessionArsenal {
    const table: EffectiveWeapon[] = [];
    for (let i = 0; i < WEAPON_COUNT; i++) table.push(effectiveFor(WEAPONS[i], BASE_SLOT, ''));

    let slot = BASE_SLOT;
    for (const o of overlays) {
      const base = Number.isInteger(o.base) && o.base >= 0 && o.base < WEAPON_COUNT
        ? WEAPONS[o.base] : null;
      if (base === null) continue;
      slot++;
      // Every weapon exists in every slot. A player holding the shotgun in a
      // room whose slot 2 is a pistol variant fires the BASE shotgun, not a
      // hole — the same answer the clamp gives, reached without a branch on
      // the firing path.
      for (let i = 0; i < WEAPON_COUNT; i++) {
        const isTarget = i === o.base;
        const d = isTarget ? { ...base, ...o.over, id: base.id } as WeaponDef : WEAPONS[i];
        table.push(effectiveFor(d, slot, isTarget ? o.id : ''));
      }
    }
    return new SessionArsenal(Object.freeze(table), slot + 1);
  }

  /**
   * The compiled table and nothing else. This is what the local Worker builds
   * from (VARIANTS.md §2: the static Vercel build is outside the release
   * mechanism and must keep working with zero fetches), and what every room
   * builds from until a variants pack exists.
   */
  static compiled(): SessionArsenal {
    return SessionArsenal.from([]);
  }

  /**
   * The stats a shot actually uses.
   *
   * Both arguments are clamped rather than trusted, INTEGRALITY INCLUDED — a
   * bare range check lets 1.5 through and indexes a hole in the table, which
   * is a `undefined.damage` crash on the firing path rather than a fallback.
   * An out-of-range weapon id resolves to the pistol, which is what
   * `getWeapon` has always done; a slot
   * this session does not have resolves to the base, which is the same fallback
   * a dormant, revoked or mode-denied variant claim will take in V4 — so the
   * clamp is the feature, not a guard bolted on.
   */
  statsFor(weaponId: number, variantSlot: number): EffectiveWeapon {
    const id = Number.isInteger(weaponId) && weaponId >= 0 && weaponId < WEAPON_COUNT
      ? weaponId : WeaponId.PISTOL;
    const slot = Number.isInteger(variantSlot) && variantSlot > 0 && variantSlot < this.slotCount
      ? variantSlot : BASE_SLOT;
    return this.table[slot * WEAPON_COUNT + id];
  }
}

/**
 * The process-wide compiled arsenal.
 *
 * Safe to share: every entry is frozen and the table is frozen. A room that
 * pins a variants release builds its own with `SessionArsenal` and hands it to
 * its predictors; this one is the zero-variant answer, and in V1 it is the only
 * answer there is.
 */
export const BASE_ARSENAL: SessionArsenal = SessionArsenal.compiled();

/* ------------------------------------------------------------------------ *
 * The sync contract, taking an EffectiveWeapon
 *
 * These are the `weapons.ts` pure functions with the module-table lookup taken
 * out of them — same arithmetic, same order, same reads. The id-taking
 * originals stay exactly where they are and are NOT reimplemented on top of
 * these: roughly a hundred call sites outside the two predictors (the HUD, the
 * viewmodel, the killfeed, the audio layer) still use them, and leaving that
 * path physically untouched is what makes "the refactor changed nothing" a
 * claim about code rather than about a test.
 * ------------------------------------------------------------------------ */

/** Multiplier in [falloffMin, 1] applied to damage at `dist` metres. */
export function damageFalloffScaleOf(w: EffectiveWeapon, dist: number): number {
  if (dist <= w.falloffStart) return 1;
  if (dist >= w.falloffEnd) return w.falloffMin;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  const shaped = w.falloffCurve === 1 ? t : Math.pow(t, w.falloffCurve);
  return 1 + (w.falloffMin - 1) * shaped;
}

/** Damage of one pellet / one direct hit at `dist` metres, before armour. */
export function damageAtDistanceOf(w: EffectiveWeapon, dist: number): number {
  return w.hot.damage * damageFalloffScaleOf(w, dist);
}

/** Splash damage at `dist` metres from the blast centre. 0 outside the radius. */
export function splashDamageAtOf(w: EffectiveWeapon, dist: number): number {
  const r = w.hot.splashRadius;
  if (r <= 0 || dist >= r) return 0;
  const t = 1 - dist / r;
  return w.hot.splashDamage * t * t;
}

/** Impulse in m/s a hit for `damage` points imparts to the victim. */
export function knockbackImpulseOf(w: EffectiveWeapon, damage: number): number {
  return w.knockback * damage;
}

/**
 * Cone half-angle for the next shot. Client prediction and server validation
 * must both call this so the reconciliation never disagrees about spread.
 */
export function currentSpreadOf(
  w: EffectiveWeapon, heatSpread: number, airborne: boolean, crouched: boolean,
): number {
  let s = heatSpread < w.spread ? w.spread : (heatSpread > w.spreadMax ? w.spreadMax : heatSpread);
  if (airborne) s += w.spreadAir;
  if (crouched) s *= w.spreadCrouchScale;
  return s;
}

/** New accumulated cone after firing one shot. */
export function applyShotSpreadOf(w: EffectiveWeapon, heatSpread: number): number {
  const s = (heatSpread < w.spread ? w.spread : heatSpread) + w.spreadPerShot;
  return s > w.spreadMax ? w.spreadMax : s;
}

/** New accumulated cone after `dt` seconds of not firing. */
export function recoverSpreadOf(w: EffectiveWeapon, heatSpread: number, dt: number): number {
  const s = heatSpread - w.spreadRecovery * dt;
  return s < w.spread ? w.spread : s;
}

/** 0..1 for the dynamic crosshair: how far the cone has opened toward its ceiling. */
export function spreadFractionOf(w: EffectiveWeapon, heatSpread: number): number {
  if (w.spreadMax <= w.spread) return 0;
  return clamp((heatSpread - w.spread) / (w.spreadMax - w.spread), 0, 1);
}

/** Milliseconds between shots — the float32 the module's hot table holds. */
export function fireIntervalMsOf(w: EffectiveWeapon): number {
  return w.hot.fireIntervalMs;
}

/** True when holding the fire button keeps firing. */
export function isAutomaticOf(w: EffectiveWeapon): boolean {
  return w.hot.automatic;
}
