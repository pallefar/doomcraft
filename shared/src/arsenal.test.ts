/**
 * The V1 invariant, asserted directly rather than only through the lockstep
 * golden: with zero variants installed, `statsFor(id, 0)` IS the compiled
 * table — every cold field the same double, every hot field the same narrowed
 * value — and every `*Of` function agrees with its id-taking twin.
 */

import { describe, expect, it } from 'vitest';

import {
  applyShotSpreadOf, BASE_ARSENAL, BASE_SLOT, createVariantSlots,
  currentSpreadOf, damageAtDistanceOf, damageFalloffScaleOf, fireIntervalMsOf,
  isAutomaticOf, knockbackImpulseOf, recoverSpreadOf, SessionArsenal,
  splashDamageAtOf,
} from './arsenal.ts';
import {
  applyShotSpread, currentSpread, damageAtDistance, damageFalloffScale,
  fireIntervalMs, getWeapon, isAutomatic, knockbackImpulse, recoverSpread,
  splashDamageAt, WEAPON_AMMO, WEAPON_AUTOMATIC, WEAPON_COUNT, WEAPON_DAMAGE,
  WEAPON_FIRE_INTERVAL_MS, WEAPON_KIND, WEAPON_MAG_SIZE, WEAPON_PELLETS,
  WEAPON_PROJECTILE_SPEED, WEAPON_SPLASH_DAMAGE, WEAPON_SPLASH_RADIUS,
  WEAPONS, WeaponId,
} from './weapons.ts';

const IDS = Array.from({ length: WEAPON_COUNT }, (_, i) => i);

/** Distances chosen to straddle every falloff boundary in the table. */
const DISTANCES = [
  0, 0.001, 0.5, 1, 1.9, 2, 2.6, 3, 4.39, 4.4, 4.41, 6, 8.9, 9, 12, 20, 28,
  30, 44, 60, 120, 219, 220, 400,
];

const HEATS = [0, 0.0005, 0.004, 0.009, 0.012, 0.03, 0.055, 0.09, 0.2, 1];

describe('the compiled arsenal is the compiled table', () => {
  it('returns every cold field of the def unchanged', () => {
    for (const id of IDS) {
      const w = BASE_ARSENAL.statsFor(id, BASE_SLOT);
      const d = WEAPONS[id];
      for (const key of Object.keys(d) as Array<keyof typeof d>) {
        expect(`${String(key)}=${String(w[key])}`).toBe(`${String(key)}=${String(d[key])}`);
      }
      expect(w.variantSlot).toBe(BASE_SLOT);
      expect(w.variantId).toBe('');
    }
  });

  it('narrows every hot field to the SAME bits the derived tables hold', () => {
    for (const id of IDS) {
      const h = BASE_ARSENAL.statsFor(id, BASE_SLOT).hot;
      expect(h.fireIntervalMs).toBe(WEAPON_FIRE_INTERVAL_MS[id]);
      expect(h.damage).toBe(WEAPON_DAMAGE[id]);
      expect(h.pellets).toBe(WEAPON_PELLETS[id]);
      expect(h.kind).toBe(WEAPON_KIND[id]);
      expect(h.ammo).toBe(WEAPON_AMMO[id]);
      expect(h.magSize).toBe(WEAPON_MAG_SIZE[id]);
      expect(h.splashRadius).toBe(WEAPON_SPLASH_RADIUS[id]);
      expect(h.splashDamage).toBe(WEAPON_SPLASH_DAMAGE[id]);
      expect(h.projectileSpeed).toBe(WEAPON_PROJECTILE_SPEED[id]);
      expect(h.automatic).toBe(WEAPON_AUTOMATIC[id] === 1);
    }
  });

  it('keeps the def double and the hot float32 APART where they differ', () => {
    // The reason `hot` exists at all. If someone ever "tidies" EffectiveWeapon
    // by flattening the narrowed values over the def's doubles, this is the
    // test that goes red — and the lockstep golden goes red with it, because
    // `splashDamageAt` reads one of these and sim.ts's detonate loop reads the
    // other three lines away.
    const rocket = BASE_ARSENAL.statsFor(WeaponId.ROCKET, BASE_SLOT);
    expect(rocket.splashRadius).toBe(4.4);
    expect(rocket.hot.splashRadius).toBe(4.400000095367432);
    expect(rocket.hot.splashRadius).not.toBe(rocket.splashRadius);

    const plasma = BASE_ARSENAL.statsFor(WeaponId.PLASMA, BASE_SLOT);
    expect(plasma.splashRadius).toBe(0.9);
    expect(plasma.hot.splashRadius).toBe(0.8999999761581421);

    const chaingun = BASE_ARSENAL.statsFor(WeaponId.CHAINGUN, BASE_SLOT);
    expect(60000 / chaingun.rpm).toBe(85.71428571428571);
    expect(chaingun.hot.fireIntervalMs).toBe(85.71428680419922);
  });

  it('hands out frozen entries, so one room cannot retune another', () => {
    const w = BASE_ARSENAL.statsFor(WeaponId.BFG, BASE_SLOT);
    expect(Object.isFrozen(w)).toBe(true);
    expect(Object.isFrozen(w.hot)).toBe(true);
  });

  it('clamps an unknown weapon to the pistol, exactly as getWeapon does', () => {
    for (const bad of [-1, WEAPON_COUNT, 99, 1.5]) {
      expect(BASE_ARSENAL.statsFor(bad, BASE_SLOT).id).toBe(getWeapon(bad).id);
    }
  });

  it('resolves a slot this session does not have to the base', () => {
    // This clamp is the V4 behaviour, not a guard: a dormant, revoked or
    // mode-denied variant claim resolves here and the player fires the base.
    for (const slot of [1, 2, 200, -3]) {
      const w = BASE_ARSENAL.statsFor(WeaponId.SHOTGUN, slot);
      expect(w.variantSlot).toBe(BASE_SLOT);
      expect(w).toBe(BASE_ARSENAL.statsFor(WeaponId.SHOTGUN, BASE_SLOT));
    }
  });

  it('a freshly built arsenal is a separate object with identical numbers', () => {
    const other = SessionArsenal.compiled();
    expect(other).not.toBe(BASE_ARSENAL);
    for (const id of IDS) {
      expect(JSON.stringify(other.statsFor(id, 0))).toBe(
        JSON.stringify(BASE_ARSENAL.statsFor(id, 0)));
    }
  });

  it('starts every player with no variant equipped', () => {
    const slots = createVariantSlots();
    expect(slots.length).toBe(WEAPON_COUNT);
    expect([...slots]).toEqual(IDS.map(() => 0));
  });
});

describe('the arsenal-taking functions agree with the id-taking ones', () => {
  it('damage, falloff and splash, across every falloff boundary', () => {
    for (const id of IDS) {
      const w = BASE_ARSENAL.statsFor(id, BASE_SLOT);
      for (const d of DISTANCES) {
        expect(damageFalloffScaleOf(w, d)).toBe(damageFalloffScale(id, d));
        expect(damageAtDistanceOf(w, d)).toBe(damageAtDistance(id, d));
        expect(splashDamageAtOf(w, d)).toBe(splashDamageAt(id, d));
      }
    }
  });

  it('spread, in every posture and at every heat', () => {
    for (const id of IDS) {
      const w = BASE_ARSENAL.statsFor(id, BASE_SLOT);
      for (const h of HEATS) {
        for (const air of [false, true]) {
          for (const crouch of [false, true]) {
            expect(currentSpreadOf(w, h, air, crouch)).toBe(currentSpread(id, h, air, crouch));
          }
        }
        expect(applyShotSpreadOf(w, h)).toBe(applyShotSpread(id, h));
        for (const dt of [0, 1 / 60, 0.02, 0.25]) {
          expect(recoverSpreadOf(w, h, dt)).toBe(recoverSpread(id, h, dt));
        }
      }
    }
  });

  it('knockback, fire interval and the automatic flag', () => {
    for (const id of IDS) {
      const w = BASE_ARSENAL.statsFor(id, BASE_SLOT);
      for (const dmg of [0, 1, 7.5, 26, 62, 300]) {
        expect(knockbackImpulseOf(w, dmg)).toBe(knockbackImpulse(id, dmg));
      }
      expect(fireIntervalMsOf(w)).toBe(fireIntervalMs(id));
      expect(isAutomaticOf(w)).toBe(isAutomatic(id));
    }
  });
});
