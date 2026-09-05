/**
 * DOOMCRAFT — the arsenal.
 *
 * These numbers ARE the gunfeel. ref/BAR.md weakness #2 and #3: the bar has no
 * muzzle flash, no viewmodel kick, no screen shake and a dead crosshair. Every
 * weapon here carries the full feedback package so the renderer, the HUD and the
 * audio layer all read from one source of truth.
 *
 * Tuning lineage is Doom (1993) / Doom Eternal, converted to metres and seconds:
 *   - shotgun is a 7-pellet 0.09 rad cone that shreds inside 9 m and is useless past 28 m
 *   - chaingun is 700 rpm whose cone climbs from 0.009 to 0.055 rad while held
 *   - rocket splash can be ridden (SELF_KNOCKBACK, selfDamageScale 0.55)
 *   - BFG is a 1.5 s commitment that deletes a room
 */

import { clamp } from './constants.ts';
import { hash2i } from './math.ts';

/* ------------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------------ */

export enum WeaponId {
  PISTOL = 0,
  SHOTGUN = 1,
  CHAINGUN = 2,
  ROCKET = 3,
  PLASMA = 4,
  BFG = 5,
  CHAINSAW = 6,
}
export const WEAPON_COUNT = 7;

export enum AmmoType {
  NONE = 0,
  BULLETS = 1,
  SHELLS = 2,
  ROCKETS = 3,
  CELLS = 4,
}
export const AMMO_TYPE_COUNT = 5;
export const AMMO_NAMES: readonly string[] = Object.freeze(['-', 'Bullets', 'Shells', 'Rockets', 'Cells']);
/** Reserve cap per ammo type, indexed by AmmoType. */
export const AMMO_MAX: Uint16Array = new Uint16Array([0, 400, 80, 40, 400]);
/** Reserve carried on spawn, indexed by AmmoType. */
export const AMMO_START: Uint16Array = new Uint16Array([0, 120, 24, 8, 120]);
/** Packed 0xRRGGBB used by the HUD ammo counter, indexed by AmmoType. */
export const AMMO_COLORS: Uint32Array = new Uint32Array([0x888888, 0xf0c860, 0xe08840, 0xd05030, 0x50c8f0]);

export enum FireKind {
  HITSCAN = 0,
  PROJECTILE = 1,
  MELEE = 2,
}

/* ------------------------------------------------------------------------ *
 * Definition
 * ------------------------------------------------------------------------ */

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  /** Three-letter HUD label. */
  readonly short: string;
  /** Hotbar slot, 1..7. */
  readonly slot: number;
  readonly kind: FireKind;
  readonly ammo: AmmoType;

  /** Damage per pellet / per projectile direct hit, before falloff and armour. */
  readonly damage: number;
  readonly pellets: number;
  readonly headshotMultiplier: number;

  /** Cone half-angle in radians when cold. */
  readonly spread: number;
  /** Cone half-angle ceiling while held down. */
  readonly spreadMax: number;
  /** Radians added to the cone per shot fired. */
  readonly spreadPerShot: number;
  /** Radians of cone recovered per second while not firing. */
  readonly spreadRecovery: number;
  /** Extra cone added while airborne. */
  readonly spreadAir: number;
  /** Cone multiplier while crouched. */
  readonly spreadCrouchScale: number;

  readonly rpm: number;
  /** True when holding the fire button keeps firing. */
  readonly automatic: boolean;
  /** Milliseconds of spin-up before the first shot (chaingun). 0 for everything else. */
  readonly spinUpMs: number;
  readonly spinDownMs: number;

  /** PROJECTILE only. m/s. */
  readonly projectileSpeed: number;
  /** PROJECTILE only. m/s^2 downward. */
  readonly projectileGravity: number;
  /** PROJECTILE only. Collision sphere radius, metres. */
  readonly projectileRadius: number;
  readonly projectileLifeMs: number;
  /** Packed 0xRRGGBB of the projectile / tracer. */
  readonly projectileColor: number;
  /** Emissive point-light radius around the projectile, metres. 0 = no light. */
  readonly projectileLight: number;

  /** Metres. 0 means no splash. */
  readonly splashRadius: number;
  /** Damage at the centre of the splash. */
  readonly splashDamage: number;
  /** Fraction of splash damage the shooter takes from their own blast. */
  readonly selfDamageScale: number;
  /** Extra impulse multiplier applied to the shooter — this is the rocket jump. */
  readonly selfKnockbackScale: number;
  /** Splash radius in blocks the shot carves out of the world. 0 = non-destructive. */
  readonly terrainDamage: number;

  readonly magSize: number;
  readonly reserveMax: number;
  readonly reloadMs: number;
  /** >0 means shell-by-shell reload; this is the time per shell. */
  readonly reloadShellMs: number;

  /** MELEE only. Metres. */
  readonly meleeRange: number;

  /** Radians of upward camera punch per shot. */
  readonly recoilPitch: number;
  /** Radians of horizontal camera punch per shot; sign alternates. */
  readonly recoilYaw: number;
  /** Exponential recovery rate, 1/s, back to the pre-recoil aim. */
  readonly recoilRecovery: number;

  /** Screen shake amplitude, metres of camera offset at full strength. */
  readonly shakeAmplitude: number;
  readonly shakeMs: number;
  readonly shakeFrequency: number;

  /** Viewmodel impulse in view space: +x right, +y up, +z toward the player. */
  readonly viewKickX: number;
  readonly viewKickY: number;
  readonly viewKickZ: number;
  /** Viewmodel rotational impulse, radians: pitch, yaw, roll. */
  readonly viewKickPitch: number;
  readonly viewKickYaw: number;
  readonly viewKickRoll: number;
  /** 1/s exponential return of the viewmodel to rest. */
  readonly viewKickRecovery: number;

  /** Point-light intensity of the muzzle flash. */
  readonly muzzleIntensity: number;
  readonly muzzleMs: number;
  readonly muzzleColor: number;
  readonly muzzleRadius: number;

  /** Damage stays at 1.0 until this distance. */
  readonly falloffStart: number;
  /** Damage is falloffMin at and past this distance. */
  readonly falloffEnd: number;
  readonly falloffMin: number;
  /** Curve exponent between start and end. 1 = linear, >1 = holds damage longer. */
  readonly falloffCurve: number;

  /** Impulse in m/s applied to a hit player per point of damage. */
  readonly knockback: number;

  readonly switchInMs: number;
  readonly switchOutMs: number;

  /** Base crosshair gap in CSS px. The dynamic crosshair scales it by the live cone. */
  readonly crosshairGap: number;
}

function w(d: WeaponDef): WeaponDef { return Object.freeze(d); }

export const WEAPONS: readonly WeaponDef[] = Object.freeze([
  w({
    id: WeaponId.PISTOL, name: 'Pistol', short: 'PST', slot: 1,
    kind: FireKind.HITSCAN, ammo: AmmoType.BULLETS,
    damage: 17, pellets: 1, headshotMultiplier: 2.0,
    spread: 0.010, spreadMax: 0.030, spreadPerShot: 0.0060, spreadRecovery: 0.10,
    spreadAir: 0.014, spreadCrouchScale: 0.72,
    rpm: 420, automatic: true, spinUpMs: 0, spinDownMs: 0,
    projectileSpeed: 0, projectileGravity: 0, projectileRadius: 0, projectileLifeMs: 0,
    projectileColor: 0xffe0a0, projectileLight: 0,
    splashRadius: 0, splashDamage: 0, selfDamageScale: 0, selfKnockbackScale: 0, terrainDamage: 0,
    magSize: 15, reserveMax: 400, reloadMs: 850, reloadShellMs: 0,
    meleeRange: 0,
    recoilPitch: 0.022, recoilYaw: 0.006, recoilRecovery: 9.0,
    shakeAmplitude: 0.05, shakeMs: 60, shakeFrequency: 34,
    viewKickX: 0.004, viewKickY: 0.010, viewKickZ: 0.075,
    viewKickPitch: 0.045, viewKickYaw: 0.012, viewKickRoll: 0.020, viewKickRecovery: 16,
    muzzleIntensity: 1.1, muzzleMs: 45, muzzleColor: 0xffd08a, muzzleRadius: 5.0,
    falloffStart: 26, falloffEnd: 70, falloffMin: 0.55, falloffCurve: 1.0,
    knockback: 0.030,
    switchInMs: 200, switchOutMs: 140,
    crosshairGap: 4,
  }),
  w({
    id: WeaponId.SHOTGUN, name: 'Shotgun', short: 'SHT', slot: 2,
    kind: FireKind.HITSCAN, ammo: AmmoType.SHELLS,
    damage: 11, pellets: 7, headshotMultiplier: 1.6,
    spread: 0.090, spreadMax: 0.110, spreadPerShot: 0.0100, spreadRecovery: 0.14,
    spreadAir: 0.030, spreadCrouchScale: 0.85,
    rpm: 75, automatic: false, spinUpMs: 0, spinDownMs: 0,
    projectileSpeed: 0, projectileGravity: 0, projectileRadius: 0, projectileLifeMs: 0,
    projectileColor: 0xffcf90, projectileLight: 0,
    splashRadius: 0, splashDamage: 0, selfDamageScale: 0, selfKnockbackScale: 0, terrainDamage: 0,
    magSize: 8, reserveMax: 80, reloadMs: 2400, reloadShellMs: 400,
    meleeRange: 0,
    recoilPitch: 0.075, recoilYaw: 0.012, recoilRecovery: 6.5,
    shakeAmplitude: 0.30, shakeMs: 140, shakeFrequency: 26,
    viewKickX: 0.006, viewKickY: 0.030, viewKickZ: 0.260,
    viewKickPitch: 0.150, viewKickYaw: 0.020, viewKickRoll: 0.055, viewKickRecovery: 10,
    muzzleIntensity: 2.0, muzzleMs: 70, muzzleColor: 0xffc066, muzzleRadius: 8.0,
    falloffStart: 9, falloffEnd: 28, falloffMin: 0.30, falloffCurve: 1.35,
    knockback: 0.055,
    switchInMs: 300, switchOutMs: 190,
    crosshairGap: 12,
  }),
  w({
    id: WeaponId.CHAINGUN, name: 'Chaingun', short: 'CHG', slot: 3,
    kind: FireKind.HITSCAN, ammo: AmmoType.BULLETS,
    damage: 9, pellets: 1, headshotMultiplier: 1.8,
    spread: 0.009, spreadMax: 0.055, spreadPerShot: 0.0038, spreadRecovery: 0.085,
    spreadAir: 0.018, spreadCrouchScale: 0.70,
    rpm: 700, automatic: true, spinUpMs: 170, spinDownMs: 320,
    projectileSpeed: 0, projectileGravity: 0, projectileRadius: 0, projectileLifeMs: 0,
    projectileColor: 0xffe0a0, projectileLight: 0,
    splashRadius: 0, splashDamage: 0, selfDamageScale: 0, selfKnockbackScale: 0, terrainDamage: 0,
    magSize: 100, reserveMax: 400, reloadMs: 3200, reloadShellMs: 0,
    meleeRange: 0,
    recoilPitch: 0.012, recoilYaw: 0.005, recoilRecovery: 12.0,
    shakeAmplitude: 0.07, shakeMs: 50, shakeFrequency: 40,
    viewKickX: 0.003, viewKickY: 0.006, viewKickZ: 0.050,
    viewKickPitch: 0.030, viewKickYaw: 0.010, viewKickRoll: 0.014, viewKickRecovery: 20,
    muzzleIntensity: 0.9, muzzleMs: 32, muzzleColor: 0xffd8a0, muzzleRadius: 5.5,
    falloffStart: 22, falloffEnd: 64, falloffMin: 0.50, falloffCurve: 1.0,
    knockback: 0.022,
    switchInMs: 380, switchOutMs: 220,
    crosshairGap: 5,
  }),
  w({
    id: WeaponId.ROCKET, name: 'Rocket Launcher', short: 'RKT', slot: 4,
    kind: FireKind.PROJECTILE, ammo: AmmoType.ROCKETS,
    damage: 92, pellets: 1, headshotMultiplier: 1.0,
    spread: 0.0, spreadMax: 0.0, spreadPerShot: 0.0, spreadRecovery: 0.0,
    spreadAir: 0.0, spreadCrouchScale: 1.0,
    rpm: 88, automatic: false, spinUpMs: 0, spinDownMs: 0,
    projectileSpeed: 46, projectileGravity: 0, projectileRadius: 0.22, projectileLifeMs: 4000,
    projectileColor: 0xffa040, projectileLight: 7.0,
    splashRadius: 4.4, splashDamage: 108, selfDamageScale: 0.55, selfKnockbackScale: 1.55, terrainDamage: 2.6,
    magSize: 5, reserveMax: 40, reloadMs: 2500, reloadShellMs: 0,
    meleeRange: 0,
    recoilPitch: 0.100, recoilYaw: 0.020, recoilRecovery: 5.5,
    shakeAmplitude: 0.55, shakeMs: 220, shakeFrequency: 22,
    viewKickX: 0.008, viewKickY: 0.050, viewKickZ: 0.340,
    viewKickPitch: 0.190, viewKickYaw: 0.026, viewKickRoll: 0.070, viewKickRecovery: 8,
    muzzleIntensity: 1.6, muzzleMs: 90, muzzleColor: 0xffb060, muzzleRadius: 9.0,
    falloffStart: 999, falloffEnd: 1000, falloffMin: 1.0, falloffCurve: 1.0,
    knockback: 0.075,
    switchInMs: 420, switchOutMs: 240,
    crosshairGap: 9,
  }),
  w({
    id: WeaponId.PLASMA, name: 'Plasma Rifle', short: 'PLS', slot: 5,
    kind: FireKind.PROJECTILE, ammo: AmmoType.CELLS,
    damage: 21, pellets: 1, headshotMultiplier: 1.4,
    spread: 0.014, spreadMax: 0.030, spreadPerShot: 0.0016, spreadRecovery: 0.060,
    spreadAir: 0.012, spreadCrouchScale: 0.80,
    rpm: 660, automatic: true, spinUpMs: 0, spinDownMs: 0,
    projectileSpeed: 92, projectileGravity: 0, projectileRadius: 0.16, projectileLifeMs: 2500,
    projectileColor: 0x66c8ff, projectileLight: 4.0,
    splashRadius: 0.9, splashDamage: 8, selfDamageScale: 0.0, selfKnockbackScale: 0.0, terrainDamage: 0,
    magSize: 60, reserveMax: 400, reloadMs: 1900, reloadShellMs: 0,
    meleeRange: 0,
    recoilPitch: 0.010, recoilYaw: 0.006, recoilRecovery: 11.0,
    shakeAmplitude: 0.05, shakeMs: 40, shakeFrequency: 44,
    viewKickX: 0.002, viewKickY: 0.008, viewKickZ: 0.045,
    viewKickPitch: 0.028, viewKickYaw: 0.008, viewKickRoll: 0.010, viewKickRecovery: 19,
    muzzleIntensity: 1.0, muzzleMs: 36, muzzleColor: 0x8cd8ff, muzzleRadius: 6.0,
    falloffStart: 999, falloffEnd: 1000, falloffMin: 1.0, falloffCurve: 1.0,
    knockback: 0.018,
    switchInMs: 320, switchOutMs: 200,
    crosshairGap: 6,
  }),
  w({
    id: WeaponId.BFG, name: 'BFG 9000', short: 'BFG', slot: 6,
    kind: FireKind.PROJECTILE, ammo: AmmoType.CELLS,
    damage: 240, pellets: 1, headshotMultiplier: 1.0,
    spread: 0.0, spreadMax: 0.0, spreadPerShot: 0.0, spreadRecovery: 0.0,
    spreadAir: 0.0, spreadCrouchScale: 1.0,
    rpm: 40, automatic: false, spinUpMs: 0, spinDownMs: 0,
    projectileSpeed: 32, projectileGravity: 0, projectileRadius: 0.70, projectileLifeMs: 5000,
    projectileColor: 0x8cff3c, projectileLight: 16.0,
    splashRadius: 9.5, splashDamage: 400, selfDamageScale: 0.25, selfKnockbackScale: 0.8, terrainDamage: 5.5,
    magSize: 3, reserveMax: 400, reloadMs: 3400, reloadShellMs: 0,
    meleeRange: 0,
    recoilPitch: 0.130, recoilYaw: 0.0, recoilRecovery: 4.0,
    shakeAmplitude: 0.90, shakeMs: 420, shakeFrequency: 15,
    viewKickX: 0.0, viewKickY: 0.090, viewKickZ: 0.500,
    viewKickPitch: 0.260, viewKickYaw: 0.0, viewKickRoll: 0.0, viewKickRecovery: 5,
    muzzleIntensity: 3.0, muzzleMs: 200, muzzleColor: 0x9cff5c, muzzleRadius: 16.0,
    falloffStart: 999, falloffEnd: 1000, falloffMin: 1.0, falloffCurve: 1.0,
    knockback: 0.090,
    switchInMs: 620, switchOutMs: 320,
    crosshairGap: 16,
  }),
  w({
    id: WeaponId.CHAINSAW, name: 'Chainsaw', short: 'SAW', slot: 7,
    kind: FireKind.MELEE, ammo: AmmoType.NONE,
    damage: 26, pellets: 1, headshotMultiplier: 1.3,
    spread: 0.0, spreadMax: 0.0, spreadPerShot: 0.0, spreadRecovery: 0.0,
    spreadAir: 0.0, spreadCrouchScale: 1.0,
    rpm: 480, automatic: true, spinUpMs: 90, spinDownMs: 220,
    projectileSpeed: 0, projectileGravity: 0, projectileRadius: 0, projectileLifeMs: 0,
    projectileColor: 0xc03020, projectileLight: 0,
    splashRadius: 0, splashDamage: 0, selfDamageScale: 0, selfKnockbackScale: 0, terrainDamage: 0,
    magSize: 0, reserveMax: 0, reloadMs: 0, reloadShellMs: 0,
    meleeRange: 2.6,
    recoilPitch: 0.004, recoilYaw: 0.010, recoilRecovery: 14.0,
    shakeAmplitude: 0.12, shakeMs: 40, shakeFrequency: 52,
    viewKickX: 0.014, viewKickY: 0.004, viewKickZ: 0.030,
    viewKickPitch: 0.010, viewKickYaw: 0.030, viewKickRoll: 0.040, viewKickRecovery: 22,
    muzzleIntensity: 0, muzzleMs: 0, muzzleColor: 0x000000, muzzleRadius: 0,
    falloffStart: 2.0, falloffEnd: 2.6, falloffMin: 0.7, falloffCurve: 1.0,
    knockback: 0.010,
    switchInMs: 260, switchOutMs: 160,
    crosshairGap: 8,
  }),
]);

/* ------------------------------------------------------------------------ *
 * Derived hot tables
 * ------------------------------------------------------------------------ */

export const WEAPON_NAMES: string[] = new Array<string>(WEAPON_COUNT);
export const WEAPON_SHORT_NAMES: string[] = new Array<string>(WEAPON_COUNT);
/** Milliseconds between shots. */
export const WEAPON_FIRE_INTERVAL_MS = new Float32Array(WEAPON_COUNT);
export const WEAPON_DAMAGE = new Float32Array(WEAPON_COUNT);
export const WEAPON_PELLETS = new Uint8Array(WEAPON_COUNT);
export const WEAPON_KIND = new Uint8Array(WEAPON_COUNT);
export const WEAPON_AMMO = new Uint8Array(WEAPON_COUNT);
export const WEAPON_MAG_SIZE = new Uint16Array(WEAPON_COUNT);
export const WEAPON_SPLASH_RADIUS = new Float32Array(WEAPON_COUNT);
export const WEAPON_SPLASH_DAMAGE = new Float32Array(WEAPON_COUNT);
export const WEAPON_PROJECTILE_SPEED = new Float32Array(WEAPON_COUNT);
export const WEAPON_AUTOMATIC = new Uint8Array(WEAPON_COUNT);
/** Slot 1..7 -> WeaponId. Index 0 is unused and holds WeaponId.PISTOL. */
export const WEAPON_BY_SLOT = new Uint8Array(8);

for (let i = 0; i < WEAPON_COUNT; i++) {
  const d = WEAPONS[i];
  WEAPON_NAMES[i] = d.name;
  WEAPON_SHORT_NAMES[i] = d.short;
  WEAPON_FIRE_INTERVAL_MS[i] = 60000 / d.rpm;
  WEAPON_DAMAGE[i] = d.damage;
  WEAPON_PELLETS[i] = d.pellets;
  WEAPON_KIND[i] = d.kind;
  WEAPON_AMMO[i] = d.ammo;
  WEAPON_MAG_SIZE[i] = d.magSize;
  WEAPON_SPLASH_RADIUS[i] = d.splashRadius;
  WEAPON_SPLASH_DAMAGE[i] = d.splashDamage;
  WEAPON_PROJECTILE_SPEED[i] = d.projectileSpeed;
  WEAPON_AUTOMATIC[i] = d.automatic ? 1 : 0;
  WEAPON_BY_SLOT[d.slot] = d.id;
}
WEAPON_BY_SLOT[0] = WeaponId.PISTOL;

/* ------------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------------ */

export function getWeapon(id: number): WeaponDef {
  return WEAPONS[id] ?? WEAPONS[WeaponId.PISTOL];
}
export function weaponName(id: number): string { return WEAPON_NAMES[id] ?? 'Unknown'; }
export function fireIntervalMs(id: number): number { return WEAPON_FIRE_INTERVAL_MS[id]; }
export function isAutomatic(id: number): boolean { return WEAPON_AUTOMATIC[id] === 1; }
export function isHitscan(id: number): boolean { return WEAPON_KIND[id] === FireKind.HITSCAN; }
export function isProjectile(id: number): boolean { return WEAPON_KIND[id] === FireKind.PROJECTILE; }
export function isMelee(id: number): boolean { return WEAPON_KIND[id] === FireKind.MELEE; }
export function ammoTypeOf(id: number): number { return WEAPON_AMMO[id]; }
export function ammoMax(type: number): number { return AMMO_MAX[type] ?? 0; }
export function weaponFromSlot(slot: number): number {
  return slot >= 1 && slot <= 7 ? WEAPON_BY_SLOT[slot] : WeaponId.PISTOL;
}

/** Multiplier in [falloffMin, 1] applied to damage at `dist` metres. */
export function damageFalloffScale(id: number, dist: number): number {
  const d = WEAPONS[id];
  if (!d) return 1;
  if (dist <= d.falloffStart) return 1;
  if (dist >= d.falloffEnd) return d.falloffMin;
  const t = (dist - d.falloffStart) / (d.falloffEnd - d.falloffStart);
  const shaped = d.falloffCurve === 1 ? t : Math.pow(t, d.falloffCurve);
  return 1 + (d.falloffMin - 1) * shaped;
}

/** Damage of one pellet / one direct hit at `dist` metres, before armour. */
export function damageAtDistance(id: number, dist: number): number {
  return WEAPON_DAMAGE[id] * damageFalloffScale(id, dist);
}

/** Splash damage at `dist` metres from the blast centre. 0 outside the radius. */
export function splashDamageAt(id: number, dist: number): number {
  const r = WEAPON_SPLASH_RADIUS[id];
  if (r <= 0 || dist >= r) return 0;
  const t = 1 - dist / r;
  return WEAPON_SPLASH_DAMAGE[id] * t * t;
}

/** Impulse in m/s a hit for `damage` points imparts to the victim. */
export function knockbackImpulse(id: number, damage: number): number {
  const d = WEAPONS[id];
  return d ? d.knockback * damage : 0;
}

/**
 * Cone half-angle for the next shot. Client prediction and server validation
 * must both call this so the reconciliation never disagrees about spread.
 * `heatSpread` is the accumulated cone carried on the player's weapon state.
 */
export function currentSpread(id: number, heatSpread: number, airborne: boolean, crouched: boolean): number {
  const d = WEAPONS[id];
  if (!d) return 0;
  let s = heatSpread < d.spread ? d.spread : (heatSpread > d.spreadMax ? d.spreadMax : heatSpread);
  if (airborne) s += d.spreadAir;
  if (crouched) s *= d.spreadCrouchScale;
  return s;
}

/** New accumulated cone after firing one shot. */
export function applyShotSpread(id: number, heatSpread: number): number {
  const d = WEAPONS[id];
  if (!d) return 0;
  const s = (heatSpread < d.spread ? d.spread : heatSpread) + d.spreadPerShot;
  return s > d.spreadMax ? d.spreadMax : s;
}

/** New accumulated cone after `dt` seconds of not firing. */
export function recoverSpread(id: number, heatSpread: number, dt: number): number {
  const d = WEAPONS[id];
  if (!d) return 0;
  const s = heatSpread - d.spreadRecovery * dt;
  return s < d.spread ? d.spread : s;
}

/** 0..1 for the dynamic crosshair: how far the cone has opened toward its ceiling. */
export function spreadFraction(id: number, heatSpread: number): number {
  const d = WEAPONS[id];
  if (!d || d.spreadMax <= d.spread) return 0;
  return clamp((heatSpread - d.spread) / (d.spreadMax - d.spread), 0, 1);
}

/* ------------------------------------------------------------------------ *
 * The shot
 * ------------------------------------------------------------------------ */

/**
 * SHOT SEQUENCE NUMBERS WRAP AT 16 BITS, ON BOTH SIDES.
 *
 * The server has always masked (`p.shotSeq = (p.shotSeq + 1) & 0xffff`) and
 * the client counted without a bound, so the two agreed for the first 65 535
 * shots of a session and then seeded every cone differently forever. Both go
 * through this now so there is one rule rather than two that happen to match.
 */
export function nextShotSeq(seq: number): number {
  return (seq + 1) & 0xffff;
}

/**
 * The seed for ONE pellet of one shot.
 *
 * This is the sync contract. Both predictors derive every pellet from
 * (ownerId, shotSeq, pellet) and nothing else — no room seed, no stream
 * position — so any pellet of any shot can be regenerated independently, by
 * either side, in any order. It lives here rather than in either predictor
 * because a copy on each side is two rules, and two rules drift.
 */
export function shotSeed(ownerId: number, shotSeq: number, pellet: number): number {
  return hash2i((ownerId << 16) | (pellet & 0xffff), shotSeq, 0x5c07);
}

/* ------------------------------------------------------------------------ *
 * Loadout
 * ------------------------------------------------------------------------ */

/** Weapons every player spawns holding. */
export const STARTING_WEAPONS: readonly number[] = Object.freeze([WeaponId.PISTOL, WeaponId.CHAINSAW]);
export const DEFAULT_WEAPON: number = WeaponId.PISTOL;

/** Bitmask of owned weapons for a fresh spawn. */
export const STARTING_WEAPON_MASK: number = (1 << WeaponId.PISTOL) | (1 << WeaponId.CHAINSAW);
/** Every weapon owned — sandbox and horde practice. */
export const ALL_WEAPON_MASK: number = (1 << WEAPON_COUNT) - 1;

export function ownsWeapon(mask: number, id: number): boolean {
  return (mask & (1 << id)) !== 0;
}
export function grantWeapon(mask: number, id: number): number {
  return mask | (1 << id);
}
/** Next owned weapon after `from`, cycling. Returns `from` when nothing else is owned. */
export function nextWeapon(mask: number, from: number, dir: number): number {
  const step = dir >= 0 ? 1 : WEAPON_COUNT - 1;
  let id = from;
  for (let i = 0; i < WEAPON_COUNT; i++) {
    id = (id + step) % WEAPON_COUNT;
    if ((mask & (1 << id)) !== 0) return id;
  }
  return from;
}
