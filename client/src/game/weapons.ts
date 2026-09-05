/**
 * DOOMCRAFT — client weapon runtime.
 *
 * ref/BAR.md weakness #2 and #3: the bar's viewmodel is a static billboard that
 * does not move one pixel across 1.2 s of mouselook, and its crosshair never
 * reacts. Every shot fired through this file emits the full feedback package —
 * muzzle flash, tracer, impact, view kick, camera recoil, screen shake, hit
 * marker — and keeps a live spread value the dynamic crosshair reads.
 *
 * It computes, but does not apply, damage: the server is authoritative. What it
 * produces is a `ShotReport` the netcode layer ships and the HUD reads, so the
 * hit marker appears on the same frame as the shot instead of a round trip later.
 *
 * Determinism: pellet patterns come from `shotSeed(ownerId, shotSeq, pellet)` fed
 * into the SHARED `coneSpread`, so the server reproduces the exact same cone from
 * the input sequence number. Never roll pellets from Math.random.
 *
 * Allocation: none per shot. Reports and scratch are preallocated.
 */

import {
  HITSCAN_MAX_DISTANCE, HEADSHOT_MULTIPLIER,
  PLAYER_HALF_WIDTH, PLAYER_HEIGHT, PLAYER_HEAD_MIN_Y, PLAYER_HEAD_HALF_WIDTH,
  MAX_PLAYERS, MAX_ENTITIES,
} from '@shared/constants';
import {
  WeaponId, FireKind, AmmoType, AMMO_TYPE_COUNT, AMMO_MAX, AMMO_START,
  WEAPON_COUNT, WEAPON_AMMO,
  getWeapon, ammoTypeOf,
  ownsWeapon, grantWeapon, nextWeapon,
  STARTING_WEAPON_MASK, DEFAULT_WEAPON, weaponFromSlot,
  nextShotSeq, shotSeed,
} from '@shared/weapons';
import {
  applyShotSpreadOf, BASE_ARSENAL, BASE_SLOT, createVariantSlots, currentSpreadOf,
  damageAtDistanceOf, fireIntervalMsOf, isAutomaticOf, knockbackImpulseOf,
  recoverSpreadOf, spreadFractionOf,
  type EffectiveWeapon, type SessionArsenal, type VariantSlots,
} from '@shared/arsenal';
import { BLOCK_SOLID, blockHardness } from '@shared/blocks';
import {
  coneSpread, rayAABB, createVoxelHit, hash2i, Rng, clampf,
  type VoxelHit,
} from '@shared/math';
/**
 * The only thing the runtime needs from the world is a voxel raycast.
 * `VoxelWorld` (the offline/sandbox store) and the netcode's `ClientWorld`
 * adapter both satisfy this, so the shot path never forces a second copy of
 * the world to exist.
 */
export interface WeaponWorld {
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number, out: VoxelHit,
    blocking?: (id: number) => boolean,
  ): boolean;
}

/* ------------------------------------------------------------------------ *
 * Renderer hooks — implemented by the renderer / viewmodel / audio pieces
 * ------------------------------------------------------------------------ */

/**
 * Presentation hooks. Every method is optional: a headless runtime (bots, the
 * server mirror, tests) passes nothing and the maths is unchanged.
 */
export interface WeaponFx {
  /** Point light + sprite at the muzzle, along the fire direction. */
  muzzleFlash?(
    weaponId: number,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    intensity: number, ms: number, color: number, radius: number,
  ): void;
  /** One pellet's visible trail. */
  tracer?(
    weaponId: number,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    color: number,
  ): void;
  /** Bullet hit a block. `blockId` is what was struck. */
  impact?(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    blockId: number, weaponId: number,
  ): void;
  /** Bullet hit a body. */
  fleshImpact?(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    targetId: number, headshot: boolean, weaponId: number,
  ): void;
  /**
   * Crosshair hit marker. Called once per shot, not once per pellet.
   *
   * `hits` / `pellets` let the marker scale with how much of a shotgun blast
   * actually landed — one pellet grazing and all seven at point blank are the
   * same event to a boolean, and they are not the same event to the player.
   */
  hitMarker?(
    damage: number, headshot: boolean, killed: boolean,
    hits?: number, pellets?: number,
  ): void;
  /**
   * One call per shot that CONNECTED, fired after every pellet is resolved and
   * anchored at the heaviest hit.
   *
   * It exists because lethality is a property of the SHOT, not of a pellet: a
   * shotgun kills with seven pellets none of which is fatal alone, so the
   * per-pellet `fleshImpact` hook can never know. This is the hook that makes
   * a kill look different from a hit on the frame it happens.
   */
  hitConfirm?(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    damage: number, headshot: boolean, killed: boolean,
    /**
     * How much of the shot landed and how far away it landed.
     *
     * A shotgun that puts one pellet of seven into a demon at 30 m and one that
     * puts all seven into it at 2 m carry the same `killed === false` and very
     * different `damage`, but damage alone cannot separate "I clipped it" from
     * "I am too far away for this gun" — the first should feel like a miss you
     * got away with and the second should feel like a solid hit that the range
     * falloff ate. `hits/pellets` is the coverage and `distance` is the excuse,
     * and the effects layer needs both to grade the burst honestly.
     */
    hits?: number, pellets?: number, distance?: number,
  ): void;
  /** Viewmodel impulse, view space: +x right, +y up, +z toward the player. */
  viewKick?(
    kx: number, ky: number, kz: number,
    pitch: number, yaw: number, roll: number,
    recovery: number,
  ): void;
  /** A shot actually left the barrel. */
  fire?(weaponId: number, shotSeq: number): void;
  /** Trigger pulled with an empty mag. */
  dryFire?(weaponId: number): void;
  reloadStart?(weaponId: number, ms: number, shellByShell: boolean): void;
  reloadShell?(weaponId: number, magAfter: number): void;
  reloadEnd?(weaponId: number): void;
  switchStart?(fromId: number, toId: number, ms: number): void;
  switchEnd?(weaponId: number): void;
  /** Chaingun barrel spin, 0..1. Drives the viewmodel and the whine. */
  spin?(weaponId: number, value: number): void;
  /** Melee swing connected with nothing. */
  meleeMiss?(weaponId: number): void;
  /**
   * A melee swing or a tool bit the WORLD rather than a body.
   *
   * The gun path has had a wall hook since day one (`impact`); melee had none,
   * so a saw held against a stone wall produced a swinging viewmodel and an
   * entirely unchanged wall — the exact failure this piece is judged on. The
   * normal is the outward normal of the struck FACE, the point is on that face,
   * and `power` is 0..1 of how much of the block the strike took, which is what
   * lets the effects layer grade the dust and advance the crack.
   */
  blockStrike?(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    blockId: number, weaponId: number, power: number,
  ): void;
}

/** The camera-side feedback surface. `PlayerCamera` satisfies this structurally. */
export interface CameraFeedback {
  addRecoil(pitchKick: number, yawKick: number, recovery: number): void;
  addShake(amplitude: number, ms: number, frequency: number): void;
  addFovPunch(degrees: number, recovery?: number): void;
}

/** Projectile creation. The projectile system (renderer + netcode) implements it. */
export interface ProjectileSpawner {
  /**
   * Create a projectile. Returns a local id, or -1 when the pool is full.
   * `speed` is metres per second along the unit direction.
   */
  spawn(
    weaponId: number, ownerId: number,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    speed: number, shotSeq: number,
  ): number;
}

/* ------------------------------------------------------------------------ *
 * Hit targets
 * ------------------------------------------------------------------------ */

/**
 * Candidate bodies for a hitscan, as flat typed arrays so a shot allocates
 * nothing. The game layer refills it from the interpolated snapshot each frame
 * (and the netcode layer refills it from rewound positions for lag comp).
 *
 * Positions are FEET CENTRE, matching the movement convention.
 */
export interface HitTargets {
  count: number;
  readonly id: Uint16Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly halfWidth: Float32Array;
  readonly height: Float32Array;
  readonly headMinY: Float32Array;
  readonly headHalfWidth: Float32Array;
  readonly alive: Uint8Array;
  readonly team: Uint8Array;
  /**
   * Current health, so a kill can be predicted on the SAME FRAME as the shot
   * rather than a round trip later. 0 means "unknown" and never predicts a
   * kill: a hit marker that lies is worse than one that is late.
   */
  readonly health: Float32Array;
}

export function createHitTargets(capacity: number = MAX_PLAYERS + MAX_ENTITIES): HitTargets {
  return {
    count: 0,
    id: new Uint16Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    z: new Float32Array(capacity),
    halfWidth: new Float32Array(capacity),
    height: new Float32Array(capacity),
    headMinY: new Float32Array(capacity),
    headHalfWidth: new Float32Array(capacity),
    alive: new Uint8Array(capacity),
    team: new Uint8Array(capacity),
    health: new Float32Array(capacity),
  };
}

/** Append a standard humanoid target. Returns false when the buffer is full. */
export function pushPlayerTarget(
  t: HitTargets, id: number, x: number, y: number, z: number,
  alive: boolean = true, team: number = 0, health: number = 0,
): boolean {
  const i = t.count;
  if (i >= t.id.length) return false;
  t.id[i] = id;
  t.x[i] = x; t.y[i] = y; t.z[i] = z;
  t.halfWidth[i] = PLAYER_HALF_WIDTH;
  t.height[i] = PLAYER_HEIGHT;
  t.headMinY[i] = PLAYER_HEAD_MIN_Y;
  t.headHalfWidth[i] = PLAYER_HEAD_HALF_WIDTH;
  t.alive[i] = alive ? 1 : 0;
  t.team[i] = team;
  t.health[i] = health;
  t.count = i + 1;
  return true;
}

/** Append a non-humanoid target (a demon) with an explicit box. */
export function pushEntityTarget(
  t: HitTargets, id: number, x: number, y: number, z: number,
  halfWidth: number, height: number, headMinY: number, headHalfWidth: number,
  alive: boolean = true, team: number = 255, health: number = 0,
): boolean {
  const i = t.count;
  if (i >= t.id.length) return false;
  t.id[i] = id;
  t.x[i] = x; t.y[i] = y; t.z[i] = z;
  t.halfWidth[i] = halfWidth;
  t.height[i] = height;
  t.headMinY[i] = headMinY;
  t.headHalfWidth[i] = headHalfWidth;
  t.alive[i] = alive ? 1 : 0;
  t.team[i] = team;
  t.health[i] = health;
  t.count = i + 1;
  return true;
}

/* ------------------------------------------------------------------------ *
 * Shot report
 * ------------------------------------------------------------------------ */

export const HIT_NONE = 0;
export const HIT_WORLD = 1;
export const HIT_BODY = 2;
export const HIT_HEAD = 3;

/** Largest pellet count any weapon fires. Shotgun is 7; 16 leaves headroom. */
export const MAX_PELLETS = 16;

/** Per-shot result. One instance is reused for every shot — copy what you keep. */
export interface ShotReport {
  weaponId: number;
  shotSeq: number;
  pellets: number;
  /** Pellets that struck a body. */
  hits: number;
  headshots: number;
  totalDamage: number;
  /** True when at least one pellet found a body. */
  connected: boolean;
  /**
   * Bodies this shot is PREDICTED to have killed, summing every pellet that
   * landed on the same target. Zero whenever target health is unknown.
   */
  kills: number;
  /** First predicted victim, or 0. */
  lethalId: number;
  /** The heaviest single pellet — where the hit burst is anchored. */
  bestDamage: number;
  bestX: number; bestY: number; bestZ: number;
  /** Unit normal pointing back at the shooter from that hit. */
  bestNx: number; bestNy: number; bestNz: number;
  /**
   * Range of that heaviest pellet, in metres. The effects layer sizes hit
   * feedback in SCREEN space, and screen space is a function of distance — a
   * flash that is right at 3 m is a sub-pixel dot at 40 m.
   */
  bestDistance: number;
  readonly kind: Uint8Array;
  readonly targetId: Uint16Array;
  readonly damage: Float32Array;
  readonly distance: Float32Array;
  readonly hitX: Float32Array;
  readonly hitY: Float32Array;
  readonly hitZ: Float32Array;
  /** Unit direction of each pellet — the netcode layer replays these. */
  readonly dirX: Float32Array;
  readonly dirY: Float32Array;
  readonly dirZ: Float32Array;
}

export function createShotReport(): ShotReport {
  return {
    weaponId: 0, shotSeq: 0, pellets: 0, hits: 0, headshots: 0,
    totalDamage: 0, connected: false,
    kills: 0, lethalId: 0,
    bestDamage: 0, bestX: 0, bestY: 0, bestZ: 0,
    bestNx: 0, bestNy: 0, bestNz: 1, bestDistance: 0,
    kind: new Uint8Array(MAX_PELLETS),
    targetId: new Uint16Array(MAX_PELLETS),
    damage: new Float32Array(MAX_PELLETS),
    distance: new Float32Array(MAX_PELLETS),
    hitX: new Float32Array(MAX_PELLETS),
    hitY: new Float32Array(MAX_PELLETS),
    hitZ: new Float32Array(MAX_PELLETS),
    dirX: new Float32Array(MAX_PELLETS),
    dirY: new Float32Array(MAX_PELLETS),
    dirZ: new Float32Array(MAX_PELLETS),
  };
}

/** Re-exported so existing importers keep one name for one contract. */
export { shotSeed };

/* ------------------------------------------------------------------------ *
 * Fire context
 * ------------------------------------------------------------------------ */

export interface FireContext {
  /** Monotonic milliseconds — `performance.now()` on the client. */
  nowMs: number;
  /** Eye position. */
  ox: number; oy: number; oz: number;
  /** Unit aim direction. Use the camera's VIEW angles so recoil actually aims. */
  dx: number; dy: number; dz: number;
  firing: boolean;
  altFiring: boolean;
  airborne: boolean;
  crouched: boolean;
  ownerId: number;
  world: WeaponWorld | null;
  targets: HitTargets | null;
  /** Ignore targets on this team. 255 disables friendly-fire filtering. */
  team: number;
}

export function createFireContext(): FireContext {
  return {
    nowMs: 0, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: -1,
    firing: false, altFiring: false, airborne: false, crouched: false,
    ownerId: 0, world: null, targets: null, team: 255,
  };
}

/* ------------------------------------------------------------------------ *
 * Switch / reload phases
 * ------------------------------------------------------------------------ */

export const SWITCH_NONE = 0;
export const SWITCH_OUT = 1;
export const SWITCH_IN = 2;

/* ------------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------------ */

export class WeaponRuntime {
  /**
   * The stats this session fires with — VARIANTS.md §2's seam, the client half.
   * Handed in by whoever built the session: a room passes the arsenal it
   * resolved from its pinned release, and the local Worker passes the compiled
   * one, exactly as it builds rooms from BUILTIN_CONTENT_HASH today.
   */
  readonly arsenal: SessionArsenal;
  /**
   * This player's equipped variant slot per weapon. All zeros in phase V1.
   * The MIRROR of `PlayerEntity.variantSlots` on the server — these two are a
   * lockstep pair like every other number on this path, and a divergence here
   * is a divergence in where the pellets went.
   */
  readonly variantSlots: VariantSlots = createVariantSlots();

  /** Bitmask of owned weapons. */
  owned = STARTING_WEAPON_MASK;
  /** Weapon in hand. During a switch this stays the OLD one until SWITCH_IN. */
  current = DEFAULT_WEAPON;
  /** Weapon being switched to, or -1. */
  pending = -1;

  /** Rounds in the magazine, per weapon. */
  readonly mag = new Uint16Array(WEAPON_COUNT);
  /** Reserve rounds, per AmmoType. */
  readonly reserve = new Uint16Array(AMMO_TYPE_COUNT);
  /**
   * Accumulated cone, per weapon. Read by the dynamic crosshair.
   *
   * FLOAT64, and it matters. This was a Float32Array, and the server's
   * `PlayerEntity.heatSpread` is a plain double — so every shot after the
   * first was predicted through a cone narrowed to float32 and resolved
   * through one that was not. Seven numbers; there was never anything to save
   * here, and the authoritative side is the one to match.
   */
  readonly heat = new Float64Array(WEAPON_COUNT);

  /** Chaingun barrel spin, 0..1. */
  spin = 0;

  /**
   * TRAUMA — 0..1, the accumulated violence of what you are doing right now.
   *
   * A per-shot shake table alone makes the two-hundredth chaingun round land
   * exactly like the first, which is the one thing sustained fire should never
   * feel like. Trauma is the standard fix: every shot ADDS to a scalar that
   * bleeds off at a fixed rate, and the shake amplitude actually sent to the
   * camera is scaled by trauma SQUARED. Squared is what keeps it honest — a
   * single pistol shot is a tick, a held chaingun burst climbs to a rumble
   * over about a second, and the frame you stop it starts falling away again.
   *
   * It multiplies the weapon's own amplitude rather than replacing it, so the
   * relative weight of the seven weapons is untouched and the ceiling is
   * bounded at `1 + TRAUMA_SHAKE_GAIN` — see the tuning note on the constants.
   */
  trauma = 0;

  /** Milliseconds until the next shot is allowed. */
  private cooldownMs = 0;
  /** Set while the trigger has been held since the last shot (semi-auto gate). */
  private triggerHeld = false;

  reloading = false;
  reloadRemainingMs = 0;
  private reloadShellMode = false;

  switchPhase = SWITCH_NONE;
  switchRemainingMs = 0;

  /** Monotonically increasing shot id. Seeds pellet cones. */
  shotSeq = 0;

  /** Reused output. */
  readonly report: ShotReport = createShotReport();

  private readonly hit: VoxelHit = createVoxelHit();
  private readonly rng = new Rng(1);
  private readonly dir = new Float64Array(3);

  /**
   * Per-shot damage tally, keyed by target id.
   *
   * A shotgun kills with seven pellets none of which is fatal on its own, so
   * lethality can only be decided once the whole shot is resolved. At most
   * MAX_PELLETS distinct bodies can be struck by one shot, so a linear scan
   * over a fixed array is both allocation-free and faster than a Map.
   */
  private readonly tallyId = new Uint16Array(MAX_PELLETS);
  /**
   * FLOAT64, and the reason is a kill marker that lied.
   *
   * These were Float32Arrays. Seven shotgun pellets of 100/7 accumulate in
   * float32 to EXACTLY 100 against a 100-health target, so `resolveKills` drew
   * a kill — while the server, subtracting the same seven doubles from double
   * health, left the target alive on 0.00000095367431640625. `totalDamage` on
   * the report was right all along at 99.99999904632568; only this separately
   * narrowed accumulator was wrong, which is why nothing else caught it.
   */
  private readonly tallyDmg = new Float64Array(MAX_PELLETS);
  private readonly tallyHp = new Float64Array(MAX_PELLETS);
  private tallyCount = 0;

  fx: WeaponFx | null = null;
  camera: CameraFeedback | null = null;
  projectiles: ProjectileSpawner | null = null;

  constructor(
    fx?: WeaponFx, camera?: CameraFeedback, projectiles?: ProjectileSpawner,
    arsenal: SessionArsenal = BASE_ARSENAL,
  ) {
    this.fx = fx ?? null;
    this.camera = camera ?? null;
    this.projectiles = projectiles ?? null;
    this.arsenal = arsenal;
    this.resetLoadout(STARTING_WEAPON_MASK);
  }

  /**
   * The stats this player fires `weaponId` with. One lookup, one place — the
   * client mirror of `Simulation.statsFor`.
   */
  stats(weaponId: number = this.current): EffectiveWeapon {
    return this.arsenal.statsFor(weaponId, this.variantSlots[weaponId] ?? BASE_SLOT);
  }

  /* -------------------------------------------------------------------- *
   * Loadout
   * -------------------------------------------------------------------- */

  /**
   * A NEW CONNECTION, WHICH IS A NEW BODY — not a respawn.
   *
   * `PlayerEntity.reset()` zeroes the server's `shotSeq` when a pooled body is
   * allocated to a player, and NOT on respawn. The client keeps its runtime
   * across a session change (`game.ts enterSession`: "the two rooms are
   * different simulations with different player ids"), so without this the
   * client carried its old counter into a body that had started again at zero
   * and every cone from then on was seeded from a different number on the two
   * sides. Called at the same lifecycle moment the server's reset happens, and
   * deliberately NOT from `resetLoadout`, which a respawn also runs.
   */
  beginSession(): void {
    this.shotSeq = 0;
  }

  /** Fresh spawn: full mags on owned weapons, starting reserves. */
  resetLoadout(mask: number = STARTING_WEAPON_MASK): void {
    this.owned = mask;
    for (let i = 0; i < WEAPON_COUNT; i++) {
      const w = this.stats(i);
      this.mag[i] = ownsWeapon(mask, i) ? w.hot.magSize : 0;
      this.heat[i] = w.spread;
    }
    for (let a = 0; a < AMMO_TYPE_COUNT; a++) this.reserve[a] = AMMO_START[a];
    this.current = ownsWeapon(mask, DEFAULT_WEAPON) ? DEFAULT_WEAPON : firstOwned(mask);
    this.pending = -1;
    this.spin = 0;
    this.trauma = 0;
    this.cooldownMs = 0;
    this.reloading = false;
    this.reloadRemainingMs = 0;
    this.switchPhase = SWITCH_NONE;
    this.switchRemainingMs = 0;
    this.triggerHeld = false;
  }

  grant(weaponId: number, withAmmo: boolean = true): void {
    if (weaponId < 0 || weaponId >= WEAPON_COUNT) return;
    const had = ownsWeapon(this.owned, weaponId);
    this.owned = grantWeapon(this.owned, weaponId);
    if (!had) {
      this.mag[weaponId] = this.stats(weaponId).hot.magSize;
      if (withAmmo) this.addAmmo(ammoTypeOf(weaponId), AMMO_START[ammoTypeOf(weaponId)] >> 1);
    }
  }

  /** Returns how much was actually taken (reserves are capped). */
  addAmmo(type: number, amount: number): number {
    if (type <= 0 || type >= AMMO_TYPE_COUNT || amount <= 0) return 0;
    const max = AMMO_MAX[type];
    const before = this.reserve[type];
    const after = before + amount > max ? max : before + amount;
    this.reserve[type] = after;
    return after - before;
  }

  /** Rounds in the current weapon's magazine. */
  get magazine(): number { return this.mag[this.current]; }
  /** Reserve for the current weapon's ammo type. Infinity for the chainsaw. */
  get reserveAmmo(): number {
    const t = ammoTypeOf(this.current);
    return t === AmmoType.NONE ? Infinity : this.reserve[t];
  }
  /** 0..1 of the HEAT alone. Prefer `liveSpreadFraction` for the crosshair. */
  get spreadFraction(): number { return spreadFractionOf(this.stats(), this.heat[this.current]); }

  /** 0..1 accumulated trauma. Read by the HUD and by tests. */
  get traumaLevel(): number { return this.trauma; }

  /** Add trauma from something that is not a shot — taking a hit, a near blast. */
  addTrauma(v: number): number {
    const t = this.trauma + v;
    this.trauma = t > 1 ? 1 : t < 0 ? 0 : t;
    return this.trauma;
  }

  /**
   * Multiplier this frame's shake amplitude is scaled by. Squared response, so
   * low trauma is nearly transparent and a sustained burst is a real ramp.
   */
  get shakeGain(): number {
    return 1 + TRAUMA_SHAKE_GAIN * this.trauma * this.trauma;
  }
  /** Live cone half-angle in radians, including airborne and crouch modifiers. */
  liveSpread(airborne: boolean, crouched: boolean): number {
    return currentSpreadOf(this.stats(), this.heat[this.current], airborne, crouched);
  }

  /**
   * 0..1 for the dynamic crosshair, measured against the cone the shot will
   * ACTUALLY use — heat plus the airborne penalty and the crouch bonus.
   *
   * `spreadFraction` normalises heat alone, and a crosshair driven off that
   * sits perfectly still while you jump even though the cone has trebled. That
   * is a smaller version of the bar's own weakness #3: a crosshair that does
   * not describe where the bullets go. Two consequences fall out of measuring
   * against the true cone, and both are wanted:
   *
   *  - Leaving the ground opens the crosshair immediately.
   *  - A shotgun's crosshair sits wider AT REST than a pistol's, because its
   *    cone is wider at rest. Under the heat-only fraction both read zero.
   *
   * The scale runs from the tightest cone the weapon can make (crouched, cold)
   * to the widest (max heat, airborne), so the ends of the scale never move.
   */
  liveSpreadFraction(airborne: boolean, crouched: boolean): number {
    const d = this.stats();
    const floor = d.spread * d.spreadCrouchScale;
    const ceil = d.spreadMax + d.spreadAir;
    if (ceil <= floor) return 0;
    const live = currentSpreadOf(this.stats(), this.heat[this.current], airborne, crouched);
    return clampf((live - floor) / (ceil - floor), 0, 1);
  }
  /** True when the trigger would produce a shot right now. */
  get ready(): boolean {
    return this.switchPhase === SWITCH_NONE && !this.reloading && this.cooldownMs <= 0;
  }

  /* -------------------------------------------------------------------- *
   * Weapon switching
   * -------------------------------------------------------------------- */

  /** Begin switching. No-op when unowned or already in hand. */
  switchTo(weaponId: number): boolean {
    if (weaponId < 0 || weaponId >= WEAPON_COUNT) return false;
    if (!ownsWeapon(this.owned, weaponId)) return false;
    if (weaponId === this.current && this.switchPhase === SWITCH_NONE) return false;
    if (this.pending === weaponId) return false;
    this.pending = weaponId;
    /*
     * THE COOLING RULE IS THE SERVER'S: a switch resets the cone.
     *
     * `sim.ts` keeps ONE `heatSpread` and zeroes it the moment a slot command
     * changes weapon. The client keeps heat PER WEAPON and kept it across a
     * switch, so switching away from a bloomed gun and back gave a first shot
     * the client predicted through a 0.036 rad cone and the server resolved
     * through 0.010. The authoritative side wins, and it is also the kinder
     * rule: a swap costs 200-600 ms of switch time, and paying that should
     * hand you an accurate first shot rather than the bloom you left behind.
     */
    this.heat[weaponId] = 0;
    this.reloading = false;
    this.reloadRemainingMs = 0;
    this.switchPhase = SWITCH_OUT;
    // Switch times are FEEL fields and deliberately outside the variant
    // whitelist (VARIANTS.md §1.2), so these read the archetype — as
    // `sim.ts` does, because the two must not drift.
    this.switchRemainingMs = getWeapon(this.current).switchOutMs;
    this.spin = 0;
    if (this.fx?.switchStart) this.fx.switchStart(this.current, weaponId, this.switchRemainingMs);
    return true;
  }

  /** Cycle to the next/previous owned weapon. */
  cycle(direction: number): boolean {
    const from = this.pending >= 0 ? this.pending : this.current;
    const next = nextWeapon(this.owned, from, direction);
    return next === from ? false : this.switchTo(next);
  }

  /** Hotbar slot 1..7. */
  selectSlot(slot: number): boolean {
    return this.switchTo(weaponFromSlot(slot));
  }

  /* -------------------------------------------------------------------- *
   * Reload
   * -------------------------------------------------------------------- */

  startReload(): boolean {
    const id = this.current;
    const def = this.stats(id);
    if (def.magSize <= 0) return false;
    if (this.reloading || this.switchPhase !== SWITCH_NONE) return false;
    if (this.mag[id] >= def.magSize) return false;
    const type = def.ammo;
    if (type === AmmoType.NONE || this.reserve[type] <= 0) return false;

    this.reloading = true;
    this.reloadShellMode = def.reloadShellMs > 0;
    this.reloadRemainingMs = this.reloadShellMode ? def.reloadShellMs : def.reloadMs;
    if (this.fx?.reloadStart) this.fx.reloadStart(id, def.reloadMs, this.reloadShellMode);
    return true;
  }

  /** Abort a shell-by-shell reload so the shotgun can fire what it has. */
  cancelReload(): void {
    if (!this.reloading) return;
    this.reloading = false;
    this.reloadRemainingMs = 0;
    if (this.fx?.reloadEnd) this.fx.reloadEnd(this.current);
  }

  private finishReloadStep(): void {
    const id = this.current;
    const def = this.stats(id);
    const type = def.ammo;
    if (type === AmmoType.NONE) { this.reloading = false; return; }

    if (this.reloadShellMode) {
      if (this.mag[id] < def.magSize && this.reserve[type] > 0) {
        this.mag[id]++;
        this.reserve[type]--;
        if (this.fx?.reloadShell) this.fx.reloadShell(id, this.mag[id]);
      }
      if (this.mag[id] >= def.magSize || this.reserve[type] <= 0) {
        this.reloading = false;
        if (this.fx?.reloadEnd) this.fx.reloadEnd(id);
      } else {
        this.reloadRemainingMs = def.reloadShellMs;
      }
      return;
    }

    const want = def.magSize - this.mag[id];
    const take = want > this.reserve[type] ? this.reserve[type] : want;
    this.mag[id] += take;
    this.reserve[type] -= take;
    this.reloading = false;
    if (this.fx?.reloadEnd) this.fx.reloadEnd(id);
  }

  /* -------------------------------------------------------------------- *
   * Per-frame
   * -------------------------------------------------------------------- */

  /**
   * Advance timers, spread recovery and spin, then fire as many shots as the
   * elapsed time allows. Returns the number of shots fired this frame.
   *
   * Firing inside `update` (rather than once per frame) is what keeps a 700 rpm
   * chaingun honest at 60 fps: 11.67 shots/second does not divide into frames.
   */
  update(dt: number, ctx: FireContext): number {
    if (dt > 0.25) dt = 0.25;
    const dtMs = dt * 1000;

    /* --- switching --- */
    if (this.switchPhase !== SWITCH_NONE) {
      this.switchRemainingMs -= dtMs;
      if (this.switchRemainingMs <= 0) {
        if (this.switchPhase === SWITCH_OUT) {
          const to = this.pending >= 0 ? this.pending : this.current;
          this.current = to;
          this.pending = -1;
          this.switchPhase = SWITCH_IN;
          this.switchRemainingMs = getWeapon(to).switchInMs;   // feel field; see switchTo
        } else {
          this.switchPhase = SWITCH_NONE;
          this.switchRemainingMs = 0;
          this.cooldownMs = 0;
          if (this.fx?.switchEnd) this.fx.switchEnd(this.current);
        }
      }
    }

    /* --- reload --- */
    if (this.reloading) {
      this.reloadRemainingMs -= dtMs;
      if (this.reloadRemainingMs <= 0) this.finishReloadStep();
    }

    /* --- cooldown --- */
    if (this.cooldownMs > 0) this.cooldownMs -= dtMs;

    const id = this.current;
    const def = this.stats(id);

    /* --- spin-up --- */
    if (def.spinUpMs > 0) {
      const wantSpin = ctx.firing && this.switchPhase === SWITCH_NONE && !this.reloading;
      if (wantSpin) this.spin = clampf(this.spin + dtMs / def.spinUpMs, 0, 1);
      else if (def.spinDownMs > 0) this.spin = clampf(this.spin - dtMs / def.spinDownMs, 0, 1);
      else this.spin = 0;
      if (this.fx?.spin) this.fx.spin(id, this.spin);
    } else {
      this.spin = ctx.firing ? 1 : 0;
    }

    /* --- spread recovery: only while the trigger is UP ---
     *
     * This condition used to read `!ctx.firing || this.cooldownMs > 0`, and
     * that second clause is a measured bug, not a nuance. A weapon spends
     * almost every frame of sustained fire inside its own cooldown — the
     * chaingun's interval is 85.7 ms and a frame is 16.7 ms — so recovery ran
     * on roughly five frames out of every six while the trigger was held.
     * Compare the two rates: the chaingun adds 0.0038 rad per shot at 11.67
     * shots/second (+0.044 rad/s) and recovers 0.085 rad/s, and the pistol adds
     * 0.006 at 7/s (+0.042) against 0.10 rad/s. Both are net NEGATIVE, so the
     * accumulated cone never left its floor and the dynamic crosshair — the
     * thing built specifically to beat the bar's dead static plus — never
     * bloomed from firing at all. Only the airborne penalty ever moved it.
     *
     * The rule is now the one every shooter uses: the cone opens while you
     * hold the trigger and closes when you let go. Reloading and switching
     * count as letting go, because the gun is not cycling.
     *
     * `server/src/sim.ts` carries the identical condition. These two must stay
     * in lockstep: the client predicts its own cone and the server reproduces
     * it from (ownerId, shotSeq), so a divergence here is a divergence in
     * where the pellets went.
     */
    if (!ctx.firing || this.reloading || this.switchPhase !== SWITCH_NONE) {
      this.heat[id] = recoverSpreadOf(def, this.heat[id], dt);
    }

    /* --- trauma bleed-off ---
     * Before the trigger is read, so a shot fired this frame is not immediately
     * decayed by the same frame's dt.
     */
    if (this.trauma > 0) {
      // Proportional plus a constant floor. Pure proportional decay has a tail
      // that never reaches zero, so the screen keeps a residual twitch minutes
      // after the last shot; pure constant decay makes the equilibrium a knife
      // edge — a weapon whose input rate is a hair under the decay rate banks
      // nothing at all and one a hair over it saturates. The two together give
      // a real equilibrium per weapon AND a hard finish about a second and a
      // half after you let go.
      this.trauma -= (TRAUMA_DECAY_PER_S * this.trauma + TRAUMA_DECAY_FLOOR) * dt;
      if (this.trauma < 1e-3) this.trauma = 0;
    }

    /* --- trigger --- */
    let shots = 0;
    if (!ctx.firing) {
      this.triggerHeld = false;
      return 0;
    }

    // A shell-by-shell reload yields to the trigger.
    if (this.reloading && this.reloadShellMode && this.mag[id] > 0) this.cancelReload();

    const auto = isAutomaticOf(def);
    if (!auto && this.triggerHeld) return 0;

    // Fire every interval that elapsed, so high rpm is frame-rate independent.
    let guard = 0;
    while (this.canFireNow(ctx) && guard++ < 8) {
      this.fireOnce(ctx);
      shots++;
      // `this.current` rather than `id`: `fireOnce` can switch nothing, but
      // reading the held weapon here is what the pre-seam code did and the
      // golden holds it to that.
      const held = this.stats();
      this.cooldownMs += fireIntervalMsOf(held);
      if (!isAutomaticOf(held)) break;
    }
    this.triggerHeld = true;

    if (shots === 0 && this.ready && this.mag[id] === 0 && def.magSize > 0) {
      if (this.fx?.dryFire) this.fx.dryFire(id);
      // Empty gun auto-reloads, which is what a Doom player expects.
      this.startReload();
      this.cooldownMs = 220;
    }
    return shots;
  }

  private canFireNow(ctx: FireContext): boolean {
    if (this.switchPhase !== SWITCH_NONE) return false;
    if (this.reloading) return false;
    if (this.cooldownMs > 0) return false;
    const id = this.current;
    const def = this.stats(id);
    if (def.spinUpMs > 0 && this.spin < 1) return false;
    if (def.magSize > 0 && this.mag[id] <= 0) return false;
    if (!ctx.firing) return false;
    return true;
  }

  /* -------------------------------------------------------------------- *
   * The shot
   * -------------------------------------------------------------------- */

  /**
   * Fire one shot. Public so bots and the replay path can drive it directly;
   * `update` is the normal entry point.
   */
  fireOnce(ctx: FireContext): ShotReport {
    const id = this.current;
    const def = this.stats(id);
    const seq = this.shotSeq = nextShotSeq(this.shotSeq);

    if (def.magSize > 0 && this.mag[id] > 0) this.mag[id]--;

    const report = this.report;
    report.weaponId = id;
    report.shotSeq = seq;
    report.pellets = 0;
    report.hits = 0;
    report.headshots = 0;
    report.totalDamage = 0;
    report.connected = false;
    report.kills = 0;
    report.lethalId = 0;
    report.bestDamage = 0;
    report.bestDistance = 0;
    this.tallyCount = 0;

    const spread = currentSpreadOf(def, this.heat[id], ctx.airborne, ctx.crouched);

    switch (def.hot.kind as FireKind) {
      case FireKind.HITSCAN: this.fireHitscan(ctx, def, spread, seq, report); break;
      case FireKind.PROJECTILE: this.fireProjectile(ctx, def, spread, seq, report); break;
      case FireKind.MELEE: this.fireMelee(ctx, def, report); break;
    }

    this.heat[id] = applyShotSpreadOf(def, this.heat[id]);
    this.resolveKills(report);
    this.emitFeedback(ctx, def, report);
    return report;
  }

  /**
   * Record one pellet's damage against a body and, on the first pellet to hit
   * it, that body's health.
   */
  private tally(targetId: number, damage: number, health: number): void {
    for (let i = 0; i < this.tallyCount; i++) {
      if (this.tallyId[i] === targetId) {
        this.tallyDmg[i] += damage;
        return;
      }
    }
    if (this.tallyCount >= MAX_PELLETS) return;
    const i = this.tallyCount++;
    this.tallyId[i] = targetId;
    this.tallyDmg[i] = damage;
    this.tallyHp[i] = health;
  }

  /**
   * Turn the tally into a predicted kill count.
   *
   * Deliberately conservative: health 0 means the caller did not supply it, and
   * an unknown-health target never produces a kill marker. The server's
   * authoritative DMG_FATAL still arrives and still fires the marker, so the
   * cost of not predicting is a late marker and the cost of over-predicting is
   * a marker that lied. Late is cheaper.
   */
  private resolveKills(report: ShotReport): void {
    for (let i = 0; i < this.tallyCount; i++) {
      const hp = this.tallyHp[i];
      if (hp > 0 && this.tallyDmg[i] >= hp) {
        report.kills++;
        if (report.lethalId === 0) report.lethalId = this.tallyId[i];
      }
    }
  }

  /** Keep the heaviest pellet of the shot — the hit burst is anchored there. */
  private noteBestHit(
    damage: number, x: number, y: number, z: number,
    nx: number, ny: number, nz: number, distance: number,
  ): void {
    const r = this.report;
    if (damage < r.bestDamage) return;
    r.bestDamage = damage;
    r.bestX = x; r.bestY = y; r.bestZ = z;
    r.bestNx = nx; r.bestNy = ny; r.bestNz = nz;
    r.bestDistance = distance;
  }

  private emitFeedback(ctx: FireContext, def: EffectiveWeapon, report: ShotReport): void {
    const id = def.id;
    const fx = this.fx;
    if (fx) {
      if (fx.fire) fx.fire(id, report.shotSeq);
      if (def.muzzleIntensity > 0 && fx.muzzleFlash) {
        fx.muzzleFlash(
          id, ctx.ox, ctx.oy, ctx.oz, ctx.dx, ctx.dy, ctx.dz,
          def.muzzleIntensity, def.muzzleMs, def.muzzleColor, def.muzzleRadius,
        );
      }
      if (fx.viewKick) {
        fx.viewKick(
          def.viewKickX, def.viewKickY, def.viewKickZ,
          def.viewKickPitch, def.viewKickYaw, def.viewKickRoll, def.viewKickRecovery,
        );
      }
      if (report.connected) {
        const killed = report.kills > 0;
        const headshot = report.headshots > 0;
        if (fx.hitMarker) {
          fx.hitMarker(report.totalDamage, headshot, killed, report.hits, report.pellets);
        }
        if (fx.hitConfirm) {
          fx.hitConfirm(
            report.bestX, report.bestY, report.bestZ,
            report.bestNx, report.bestNy, report.bestNz,
            report.totalDamage, headshot, killed,
            report.hits, report.pellets, report.bestDistance,
          );
        }
      }
    }
    // Trauma is banked BEFORE the shake is sent, so the shot that raised it is
    // also the shot that feels it. Adding it afterwards costs one whole shot of
    // lag on a ramp and the first round of a burst then reads as the loudest.
    this.addTrauma(TRAUMA_PER_SHOT_BASE + def.shakeAmplitude * TRAUMA_PER_SHOT_AMP);
    /* And the kill's trauma with it, BEFORE the camera is driven.
     *
     * The rule two lines up — bank first, then shake, or the shot that raised
     * the trauma is not the shot that feels it — was being applied to the shot
     * and then broken for the kill, which was banked after the camera call. So
     * a kill rode the burst's existing trauma and its own contribution only
     * reached the NEXT round, which on a one-shot weapon means it never landed
     * at all. Banking it here is what actually makes finishing something the
     * peak of the burst rather than a claim in a comment.
     */
    const killed = report.kills > 0;
    if (killed) this.addTrauma(TRAUMA_PER_KILL);

    const cam = this.camera;
    if (cam) {
      cam.addRecoil(def.recoilPitch, def.recoilYaw, def.recoilRecovery);
      const gain = this.shakeGain;
      cam.addShake(def.shakeAmplitude * gain, def.shakeMs, def.shakeFrequency);
      if (def.shakeAmplitude >= 0.3) cam.addFovPunch(-def.shakeAmplitude * 3.0 * gain, 7);
      // A KILL shakes; a hit does not. That asymmetry is the whole point — if
      // every connecting pellet nudged the camera, a chaingun burst would be
      // one continuous rumble and the kill would vanish inside it. The camera's
      // own "a stronger source wins the slot" rule keeps this from stomping the
      // weapon's shake on heavy guns.
      //
      // Scaled by the same trauma gain as the weapon's own shake, and it has to
      // be: a flat amplitude means the kill that ends a long burst is quieter
      // relative to the rumble around it than the kill that opens one, which
      // inverts the reading it exists to produce.
      if (killed) cam.addShake(KILL_SHAKE_AMPLITUDE * gain, KILL_SHAKE_MS, KILL_SHAKE_HZ);
    }
  }

  /* --- hitscan --- */

  private fireHitscan(
    ctx: FireContext, def: EffectiveWeapon, spread: number, seq: number, report: ShotReport,
  ): void {
    const id = def.id;
    const pellets = def.hot.pellets > MAX_PELLETS ? MAX_PELLETS : def.hot.pellets;
    report.pellets = pellets;
    const dir = this.dir;
    const world = ctx.world;

    for (let p = 0; p < pellets; p++) {
      this.rng.reseed(shotSeed(ctx.ownerId, seq, p));
      // A single pellet with no cone must not be nudged by the RNG at all.
      if (spread > 0) {
        coneSpread(dir, 0, ctx.dx, ctx.dy, ctx.dz, spread, this.rng.next(), this.rng.next());
      } else {
        dir[0] = ctx.dx; dir[1] = ctx.dy; dir[2] = ctx.dz;
      }
      report.dirX[p] = dir[0];
      report.dirY[p] = dir[1];
      report.dirZ[p] = dir[2];

      let wallDist = HITSCAN_MAX_DISTANCE;
      let wallBlock = 0;
      let wnx = 0, wny = 0, wnz = 0;
      if (world !== null) {
        if (world.raycast(
          ctx.ox, ctx.oy, ctx.oz, dir[0], dir[1], dir[2],
          HITSCAN_MAX_DISTANCE, this.hit, hitscanBlocking,
        )) {
          wallDist = this.hit.distance;
          wallBlock = this.hit.block;
          wnx = this.hit.nx; wny = this.hit.ny; wnz = this.hit.nz;
        }
      }

      const bodyDist = this.traceTargets(ctx, dir[0], dir[1], dir[2], wallDist);

      if (bodyDist >= 0 && bodyDist <= wallDist) {
        const dist = bodyDist;
        const head = scratchHeadshot;
        const base = damageAtDistanceOf(def, dist);
        const dmg = head ? base * def.headshotMultiplier : base;
        report.kind[p] = head ? HIT_HEAD : HIT_BODY;
        report.targetId[p] = scratchTargetId;
        report.damage[p] = dmg;
        report.distance[p] = dist;
        const hx = ctx.ox + dir[0] * dist;
        const hy = ctx.oy + dir[1] * dist;
        const hz = ctx.oz + dir[2] * dist;
        report.hitX[p] = hx; report.hitY[p] = hy; report.hitZ[p] = hz;
        report.hits++;
        if (head) report.headshots++;
        report.totalDamage += dmg;
        report.connected = true;
        this.tally(scratchTargetId, dmg, scratchTargetHealth);
        this.noteBestHit(dmg, hx, hy, hz, -dir[0], -dir[1], -dir[2], dist);
        if (this.fx?.tracer) this.fx.tracer(id, ctx.ox, ctx.oy, ctx.oz, hx, hy, hz, def.projectileColor);
        if (this.fx?.fleshImpact) {
          this.fx.fleshImpact(hx, hy, hz, -dir[0], -dir[1], -dir[2], scratchTargetId, head, id);
        }
      } else if (wallDist < HITSCAN_MAX_DISTANCE) {
        report.kind[p] = HIT_WORLD;
        report.targetId[p] = 0;
        report.damage[p] = 0;
        report.distance[p] = wallDist;
        const hx = ctx.ox + dir[0] * wallDist;
        const hy = ctx.oy + dir[1] * wallDist;
        const hz = ctx.oz + dir[2] * wallDist;
        report.hitX[p] = hx; report.hitY[p] = hy; report.hitZ[p] = hz;
        if (this.fx?.tracer) this.fx.tracer(id, ctx.ox, ctx.oy, ctx.oz, hx, hy, hz, def.projectileColor);
        if (this.fx?.impact) this.fx.impact(hx, hy, hz, wnx, wny, wnz, wallBlock, id);
      } else {
        report.kind[p] = HIT_NONE;
        report.targetId[p] = 0;
        report.damage[p] = 0;
        report.distance[p] = HITSCAN_MAX_DISTANCE;
        const hx = ctx.ox + dir[0] * HITSCAN_MAX_DISTANCE;
        const hy = ctx.oy + dir[1] * HITSCAN_MAX_DISTANCE;
        const hz = ctx.oz + dir[2] * HITSCAN_MAX_DISTANCE;
        report.hitX[p] = hx; report.hitY[p] = hy; report.hitZ[p] = hz;
        if (this.fx?.tracer) this.fx.tracer(id, ctx.ox, ctx.oy, ctx.oz, hx, hy, hz, def.projectileColor);
      }
    }
  }

  /**
   * Nearest body along a ray within `maxDist`. Returns the distance or -1, and
   * writes `scratchTargetId` / `scratchHeadshot`. The head box is tested first
   * so a shot that clips both scores the headshot.
   */
  private traceTargets(
    ctx: FireContext, dx: number, dy: number, dz: number, maxDist: number,
  ): number {
    scratchTargetId = 0;
    scratchHeadshot = false;
    scratchTargetHealth = 0;
    const t = ctx.targets;
    if (t === null || t.count === 0) return -1;

    let best = -1;
    for (let i = 0; i < t.count; i++) {
      if (t.alive[i] === 0) continue;
      if (t.id[i] === ctx.ownerId) continue;
      if (ctx.team !== 255 && t.team[i] === ctx.team) continue;

      const hw = t.halfWidth[i];
      const px = t.x[i], py = t.y[i], pz = t.z[i];
      const limit = best < 0 ? maxDist : best;
      const tb = rayAABB(
        ctx.ox, ctx.oy, ctx.oz, dx, dy, dz,
        px - hw, py, pz - hw,
        px + hw, py + t.height[i], pz + hw,
        limit,
      );
      if (tb < 0) continue;

      const hhw = t.headHalfWidth[i];
      const th = rayAABB(
        ctx.ox, ctx.oy, ctx.oz, dx, dy, dz,
        px - hhw, py + t.headMinY[i], pz - hhw,
        px + hhw, py + t.height[i], pz + hhw,
        limit,
      );
      const useHead = th >= 0;
      const dist = useHead ? th : tb;
      if (best < 0 || dist < best) {
        best = dist;
        scratchTargetId = t.id[i];
        scratchHeadshot = useHead;
        scratchTargetHealth = t.health[i];
      }
    }
    return best;
  }

  /* --- projectile --- */

  private fireProjectile(
    ctx: FireContext, def: EffectiveWeapon, spread: number, seq: number, report: ShotReport,
  ): void {
    const id = def.id;
    report.pellets = 1;
    const dir = this.dir;
    if (spread > 0) {
      this.rng.reseed(shotSeed(ctx.ownerId, seq, 0));
      coneSpread(dir, 0, ctx.dx, ctx.dy, ctx.dz, spread, this.rng.next(), this.rng.next());
    } else {
      dir[0] = ctx.dx; dir[1] = ctx.dy; dir[2] = ctx.dz;
    }
    report.dirX[0] = dir[0];
    report.dirY[0] = dir[1];
    report.dirZ[0] = dir[2];
    report.kind[0] = HIT_NONE;

    // Spawn slightly ahead of the eye so the projectile is not born inside the
    // wall you are hugging.
    const off = 0.35;
    if (this.projectiles !== null) {
      this.projectiles.spawn(
        id, ctx.ownerId,
        ctx.ox + dir[0] * off, ctx.oy + dir[1] * off, ctx.oz + dir[2] * off,
        dir[0], dir[1], dir[2], def.projectileSpeed, seq,
      );
    }
  }

  /* --- melee --- */

  private fireMelee(ctx: FireContext, def: EffectiveWeapon, report: ShotReport): void {
    const id = def.id;
    report.pellets = 1;
    report.dirX[0] = ctx.dx;
    report.dirY[0] = ctx.dy;
    report.dirZ[0] = ctx.dz;

    const range = def.meleeRange;
    const dist = this.traceTargets(ctx, ctx.dx, ctx.dy, ctx.dz, range);
    if (dist < 0) {
      /* NOTHING SOFT IN RANGE — but the swing still has to land somewhere.
       *
       * A saw held against a wall used to resolve as a clean miss: no report,
       * no hook, nothing at the point of contact, and the only evidence of
       * contact anywhere on screen was the viewmodel's own animation. That is
       * the same nothing the bar ships. So the melee trace falls through to the
       * WORLD, and a face inside reach is a hit on that face.
       *
       * It is presentation only: no damage is scored, `connected` stays false,
       * and the hit marker still does not fire — a wall is not a kill. */
      if (this.worldStrike(ctx, def, range, report)) return;
      report.kind[0] = HIT_NONE;
      report.distance[0] = range;
      if (this.fx?.meleeMiss) this.fx.meleeMiss(id);
      return;
    }

    const head = scratchHeadshot;
    const base = damageAtDistanceOf(def, dist);
    const dmg = head ? base * def.headshotMultiplier : base;
    report.kind[0] = head ? HIT_HEAD : HIT_BODY;
    report.targetId[0] = scratchTargetId;
    report.damage[0] = dmg;
    report.distance[0] = dist;
    report.hits = 1;
    if (head) report.headshots = 1;
    report.totalDamage = dmg;
    report.connected = true;
    const hx = ctx.ox + ctx.dx * dist;
    const hy = ctx.oy + ctx.dy * dist;
    const hz = ctx.oz + ctx.dz * dist;
    report.hitX[0] = hx; report.hitY[0] = hy; report.hitZ[0] = hz;
    this.tally(scratchTargetId, dmg, scratchTargetHealth);
    this.noteBestHit(dmg, hx, hy, hz, -ctx.dx, -ctx.dy, -ctx.dz, dist);
    if (this.fx?.fleshImpact) {
      this.fx.fleshImpact(hx, hy, hz, -ctx.dx, -ctx.dy, -ctx.dz, scratchTargetId, head, id);
    }
  }

  /**
   * Bite the world with a melee weapon. True when a face was inside reach.
   *
   * `power` is the fraction of a block this one swing is worth, from the
   * weapon's damage against the block's hardness — a chainsaw takes a wooden
   * plank apart visibly faster than it does stone, which is the cue that tells
   * a player what a surface is made of without a single word of UI.
   */
  private worldStrike(
    ctx: FireContext, def: EffectiveWeapon, range: number, report: ShotReport,
  ): boolean {
    const id = def.id;
    const world = ctx.world;
    if (world === null) return false;
    if (!world.raycast(
      ctx.ox, ctx.oy, ctx.oz, ctx.dx, ctx.dy, ctx.dz, range, this.hit, hitscanBlocking,
    )) return false;

    const d = this.hit.distance;
    const hx = ctx.ox + ctx.dx * d;
    const hy = ctx.oy + ctx.dy * d;
    const hz = ctx.oz + ctx.dz * d;
    report.kind[0] = HIT_WORLD;
    report.targetId[0] = 0;
    report.damage[0] = 0;
    report.distance[0] = d;
    report.hitX[0] = hx; report.hitY[0] = hy; report.hitZ[0] = hz;

    if (this.fx?.blockStrike) {
      const hardness = blockHardness(this.hit.block);
      const power = clampf(
        (def.hot.damage * MELEE_TERRAIN_BITE) / (hardness > 0.1 ? hardness : 0.1),
        0.16, 1,
      );
      this.fx.blockStrike(
        hx, hy, hz, this.hit.nx, this.hit.ny, this.hit.nz,
        this.hit.block, id, power,
      );
    }
    return true;
  }

  /* -------------------------------------------------------------------- *
   * Knockback helper
   * -------------------------------------------------------------------- */

  /** Impulse the last shot should impart to its victim, in m/s. */
  knockbackFor(report: ShotReport): number {
    return knockbackImpulseOf(this.stats(report.weaponId), report.totalDamage);
  }
}

/* ------------------------------------------------------------------------ *
 * Module scratch
 * ------------------------------------------------------------------------ */

let scratchTargetId = 0;
let scratchHeadshot = false;
let scratchTargetHealth = 0;

/* ------------------------------------------------------------------------ *
 * Trauma
 * ------------------------------------------------------------------------ *
 *
 * Five numbers, chosen by solving for the equilibrium each weapon reaches
 * under sustained fire rather than by feel. Trauma settles where the input
 * (shots per second x trauma per shot) balances the bleed
 * (TRAUMA_DECAY_PER_S x trauma + TRAUMA_DECAY_FLOOR), i.e. at
 * (input - floor) / rate:
 *
 *   chaingun  11.67/s x (0.055 + 0.07 x 0.30) = 0.887/s -> 0.67 -> gain 1.41
 *   pistol     7.00/s x (0.055 + 0.05 x 0.30) = 0.490/s -> 0.30 -> gain 1.08
 *   shotgun     1.25/s x (0.055 + 0.30 x 0.30) = 0.181/s -> 0.00 -> gain 1.00
 *   BFG        one shot of                      0.325   -> spike, gone in ~0.9 s
 *
 * which is exactly the ordering wanted. The chaingun is the weapon with no
 * per-shot weight at all — 0.07 m of shake is a tick — so it is the one that
 * has to earn its violence by accumulation, and it climbs to a 1.4x rumble in
 * about a second of held trigger. The shotgun already hits like a shotgun on
 * round one and must NOT be doubled: its 1.25 rounds per second put it below
 * the decay floor, so it banks nothing and stays exactly as the table wrote it.
 *
 * The ceiling is hard: gain can never exceed 1 + TRAUMA_SHAKE_GAIN = 1.9, so
 * no amount of held trigger turns the screen into a blur.
 */
/**
 * Metres of block a melee weapon takes per point of damage, per unit hardness.
 *
 * Solved, not guessed: the chainsaw does 26 and stone is hardness 1.5, so
 * 0.02 puts one swing at 0.35 of a block face — three swings from clean to
 * shattered at 8 swings a second, i.e. the wall visibly degrades inside half a
 * second of held trigger. Softer materials go faster on the same constant,
 * which is the read we want.
 */
const MELEE_TERRAIN_BITE = 0.02;

const TRAUMA_PER_SHOT_BASE = 0.055;
const TRAUMA_PER_SHOT_AMP = 0.30;
const TRAUMA_PER_KILL = 0.22;
const TRAUMA_DECAY_PER_S = 1.05;
const TRAUMA_DECAY_FLOOR = 0.18;
const TRAUMA_SHAKE_GAIN = 0.90;

/**
 * The kill shake. Small in metres and short in time — this rides ON TOP of the
 * weapon's own shake, so it only has to be the difference between "I hit it"
 * and "it is dead", not a second recoil.
 */
const KILL_SHAKE_AMPLITUDE = 0.11;
const KILL_SHAKE_MS = 130;
const KILL_SHAKE_HZ = 24;

/** Hitscan stops on solids only — you can shoot through water and lava. */
function hitscanBlocking(id: number): boolean { return BLOCK_SOLID[id] === 1; }

function firstOwned(mask: number): number {
  for (let i = 0; i < WEAPON_COUNT; i++) if (ownsWeapon(mask, i)) return i;
  return WeaponId.PISTOL;
}

/** Total damage a full shotgun blast does at point blank — used by the HUD. */
export function maxBurstDamage(weaponId: number): number {
  const def = getWeapon(weaponId);
  return def.damage * def.pellets;
}

/** Ammo type name lookup convenience for the HUD. */
export function currentAmmoType(runtime: WeaponRuntime): number {
  return WEAPON_AMMO[runtime.current];
}

/** Headshot multiplier including the global scalar, for damage-number UI. */
export function headshotScale(weaponId: number): number {
  return getWeapon(weaponId).headshotMultiplier * (HEADSHOT_MULTIPLIER / 2);
}
