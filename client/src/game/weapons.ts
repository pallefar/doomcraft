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
  WEAPONS, WeaponId, FireKind, AmmoType, AMMO_TYPE_COUNT, AMMO_MAX, AMMO_START,
  WEAPON_COUNT, WEAPON_KIND, WEAPON_AMMO, WEAPON_MAG_SIZE,
  WEAPON_FIRE_INTERVAL_MS, WEAPON_PELLETS,
  getWeapon, isAutomatic, ammoTypeOf,
  damageAtDistance, currentSpread, applyShotSpread, recoverSpread, spreadFraction,
  knockbackImpulse, ownsWeapon, grantWeapon, nextWeapon,
  STARTING_WEAPON_MASK, DEFAULT_WEAPON, weaponFromSlot,
} from '@shared/weapons';
import { BLOCK_SOLID } from '@shared/blocks';
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
  /** Crosshair hit marker. Called once per shot, not once per pellet. */
  hitMarker?(damage: number, headshot: boolean, killed: boolean): void;
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
  };
}

/** Append a standard humanoid target. Returns false when the buffer is full. */
export function pushPlayerTarget(
  t: HitTargets, id: number, x: number, y: number, z: number,
  alive: boolean = true, team: number = 0,
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
  t.count = i + 1;
  return true;
}

/** Append a non-humanoid target (a demon) with an explicit box. */
export function pushEntityTarget(
  t: HitTargets, id: number, x: number, y: number, z: number,
  halfWidth: number, height: number, headMinY: number, headHalfWidth: number,
  alive: boolean = true, team: number = 255,
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

/**
 * Seed for one pellet. Both sides derive it the same way, so the server can
 * regenerate the client's cone from (ownerId, shotSeq) alone.
 */
export function shotSeed(ownerId: number, shotSeq: number, pellet: number): number {
  return hash2i((ownerId << 16) | (pellet & 0xffff), shotSeq, 0x5c07);
}

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
  /** Accumulated cone, per weapon. Read by the dynamic crosshair. */
  readonly heat = new Float32Array(WEAPON_COUNT);

  /** Chaingun barrel spin, 0..1. */
  spin = 0;
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

  fx: WeaponFx | null = null;
  camera: CameraFeedback | null = null;
  projectiles: ProjectileSpawner | null = null;

  constructor(fx?: WeaponFx, camera?: CameraFeedback, projectiles?: ProjectileSpawner) {
    this.fx = fx ?? null;
    this.camera = camera ?? null;
    this.projectiles = projectiles ?? null;
    this.resetLoadout(STARTING_WEAPON_MASK);
  }

  /* -------------------------------------------------------------------- *
   * Loadout
   * -------------------------------------------------------------------- */

  /** Fresh spawn: full mags on owned weapons, starting reserves. */
  resetLoadout(mask: number = STARTING_WEAPON_MASK): void {
    this.owned = mask;
    for (let i = 0; i < WEAPON_COUNT; i++) {
      this.mag[i] = ownsWeapon(mask, i) ? WEAPON_MAG_SIZE[i] : 0;
      this.heat[i] = WEAPONS[i].spread;
    }
    for (let a = 0; a < AMMO_TYPE_COUNT; a++) this.reserve[a] = AMMO_START[a];
    this.current = ownsWeapon(mask, DEFAULT_WEAPON) ? DEFAULT_WEAPON : firstOwned(mask);
    this.pending = -1;
    this.spin = 0;
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
      this.mag[weaponId] = WEAPON_MAG_SIZE[weaponId];
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
  /** 0..1 for the dynamic crosshair (bar weakness #3: theirs never moves). */
  get spreadFraction(): number { return spreadFraction(this.current, this.heat[this.current]); }
  /** Live cone half-angle in radians, including airborne and crouch modifiers. */
  liveSpread(airborne: boolean, crouched: boolean): number {
    return currentSpread(this.current, this.heat[this.current], airborne, crouched);
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
    this.reloading = false;
    this.reloadRemainingMs = 0;
    this.switchPhase = SWITCH_OUT;
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
    const def = getWeapon(id);
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
    const def = getWeapon(id);
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
          this.switchRemainingMs = getWeapon(to).switchInMs;
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
    const def = getWeapon(id);

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

    /* --- spread recovery: only while not shooting --- */
    if (!ctx.firing || this.cooldownMs > 0) {
      this.heat[id] = recoverSpread(id, this.heat[id], dt);
    }

    /* --- trigger --- */
    let shots = 0;
    if (!ctx.firing) {
      this.triggerHeld = false;
      return 0;
    }

    // A shell-by-shell reload yields to the trigger.
    if (this.reloading && this.reloadShellMode && this.mag[id] > 0) this.cancelReload();

    const auto = isAutomatic(id);
    if (!auto && this.triggerHeld) return 0;

    // Fire every interval that elapsed, so high rpm is frame-rate independent.
    let guard = 0;
    while (this.canFireNow(ctx) && guard++ < 8) {
      this.fireOnce(ctx);
      shots++;
      this.cooldownMs += WEAPON_FIRE_INTERVAL_MS[this.current];
      if (!isAutomatic(this.current)) break;
    }
    this.triggerHeld = true;

    if (shots === 0 && this.ready && this.mag[id] === 0 && getWeapon(id).magSize > 0) {
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
    const def = getWeapon(id);
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
    const def = getWeapon(id);
    const seq = ++this.shotSeq;

    if (def.magSize > 0 && this.mag[id] > 0) this.mag[id]--;

    const report = this.report;
    report.weaponId = id;
    report.shotSeq = seq;
    report.pellets = 0;
    report.hits = 0;
    report.headshots = 0;
    report.totalDamage = 0;
    report.connected = false;

    const spread = currentSpread(id, this.heat[id], ctx.airborne, ctx.crouched);

    switch (WEAPON_KIND[id] as FireKind) {
      case FireKind.HITSCAN: this.fireHitscan(ctx, def.id, spread, seq, report); break;
      case FireKind.PROJECTILE: this.fireProjectile(ctx, def.id, spread, seq, report); break;
      case FireKind.MELEE: this.fireMelee(ctx, def.id, report); break;
    }

    this.heat[id] = applyShotSpread(id, this.heat[id]);
    this.emitFeedback(ctx, id, report);
    return report;
  }

  private emitFeedback(ctx: FireContext, id: number, report: ShotReport): void {
    const def = getWeapon(id);
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
      if (report.connected && fx.hitMarker) {
        fx.hitMarker(report.totalDamage, report.headshots > 0, false);
      }
    }
    const cam = this.camera;
    if (cam) {
      cam.addRecoil(def.recoilPitch, def.recoilYaw, def.recoilRecovery);
      cam.addShake(def.shakeAmplitude, def.shakeMs, def.shakeFrequency);
      if (def.shakeAmplitude >= 0.3) cam.addFovPunch(-def.shakeAmplitude * 3.0, 7);
    }
  }

  /* --- hitscan --- */

  private fireHitscan(
    ctx: FireContext, id: number, spread: number, seq: number, report: ShotReport,
  ): void {
    const pellets = WEAPON_PELLETS[id] > MAX_PELLETS ? MAX_PELLETS : WEAPON_PELLETS[id];
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
        const base = damageAtDistance(id, dist);
        const dmg = head ? base * getWeapon(id).headshotMultiplier : base;
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
        if (this.fx?.tracer) this.fx.tracer(id, ctx.ox, ctx.oy, ctx.oz, hx, hy, hz, getWeapon(id).projectileColor);
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
        if (this.fx?.tracer) this.fx.tracer(id, ctx.ox, ctx.oy, ctx.oz, hx, hy, hz, getWeapon(id).projectileColor);
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
        if (this.fx?.tracer) this.fx.tracer(id, ctx.ox, ctx.oy, ctx.oz, hx, hy, hz, getWeapon(id).projectileColor);
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
      }
    }
    return best;
  }

  /* --- projectile --- */

  private fireProjectile(
    ctx: FireContext, id: number, spread: number, seq: number, report: ShotReport,
  ): void {
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

    const def = getWeapon(id);
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

  private fireMelee(ctx: FireContext, id: number, report: ShotReport): void {
    report.pellets = 1;
    report.dirX[0] = ctx.dx;
    report.dirY[0] = ctx.dy;
    report.dirZ[0] = ctx.dz;

    const def = getWeapon(id);
    const range = def.meleeRange;
    const dist = this.traceTargets(ctx, ctx.dx, ctx.dy, ctx.dz, range);
    if (dist < 0) {
      report.kind[0] = HIT_NONE;
      report.distance[0] = range;
      if (this.fx?.meleeMiss) this.fx.meleeMiss(id);
      return;
    }

    const head = scratchHeadshot;
    const base = damageAtDistance(id, dist);
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
    if (this.fx?.fleshImpact) {
      this.fx.fleshImpact(hx, hy, hz, -ctx.dx, -ctx.dy, -ctx.dz, scratchTargetId, head, id);
    }
  }

  /* -------------------------------------------------------------------- *
   * Knockback helper
   * -------------------------------------------------------------------- */

  /** Impulse the last shot should impart to its victim, in m/s. */
  knockbackFor(report: ShotReport): number {
    return knockbackImpulse(report.weaponId, report.totalDamage);
  }
}

/* ------------------------------------------------------------------------ *
 * Module scratch
 * ------------------------------------------------------------------------ */

let scratchTargetId = 0;
let scratchHeadshot = false;

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
