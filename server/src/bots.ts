/**
 * DOOMCRAFT — enemies and filler bots.
 *
 * Two separate populations, both of which exist to kill the bar's cold start
 * (weakness #5) and its empty sandbox (weakness #7):
 *
 *   MonsterManager — Doom archetypes as world ENTITIES: a rushing Imp, a
 *     strafing hitscan Zombie trooper, a slow armoured Baron with a shotgun,
 *     a flying Cacodemon that spits plasma and a Lost Soul that charges. They
 *     navigate with a coarse flow field that is rebuilt when the world changes,
 *     so blowing the floor out from under a path re-routes them instead of
 *     walking them into a hole.
 *
 *   BotDriver — filler PLAYERS. They synthesise InputCommands and go through
 *     `Simulation.applyInput`, exactly like a human socket, so they are subject
 *     to the same physics, spread, fire rate and reloads.
 *
 * Browser-safe: no node:*, no ws.
 */

import {
  BTN_CROUCH,
  BTN_FIRE,
  BTN_JUMP,
  BTN_RELOAD,
  BTN_SPRINT,
  BlockId,
  CHUNK_HEIGHT,
  EntityType,
  RemoveReason,
  GRAVITY,
  MAX_ENTITIES,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  Rng,
  STEP_HEIGHT,
  SPEED_RUN,
  TERMINAL_VELOCITY,
  WORLD_MIN_BLOCK_X,
  WORLD_MIN_BLOCK_Z,
  WORLD_SIZE_BLOCKS,
  WeaponId,
  anglesToForward,
  angleDelta,
  blockToChunk,
  clamp,
  createInputCommand,
  hash2i,
  isGrounded,
  moveAABB,
  ownsWeapon,
  wrapAngle,
} from '@doomcraft/shared';
import type { InputCommand } from '@doomcraft/shared';
import { ES_ALERT, ES_ATTACK, ES_FLYING, ES_MOVING, ES_PAIN, ES_WINDUP, PlayerEntity, Simulation } from './sim.js';

/* ------------------------------------------------------------------------ *
 * Navigation — coarse flow field over the voxel surface
 * ------------------------------------------------------------------------ */

/** Blocks per navigation cell. 4 keeps the field at 104x104 = 10816 cells. */
export const FLOW_CELL = 4;
export const FLOW_DIM = Math.ceil(WORLD_SIZE_BLOCKS / FLOW_CELL);
const FLOW_CELLS = FLOW_DIM * FLOW_DIM;
const FLOW_UNREACHED = 0x7fffffff;
/** Maximum climb between neighbouring cells: a step plus a jump. */
const MAX_CLIMB = 2;
/** Maximum survivable drop between neighbouring cells. */
const MAX_DROP = 7;

/**
 * A breadth-first distance field over walkable ground, flooded outward from
 * every living player at once. Monsters read the steepest descent, so one BFS
 * serves the whole population and every monster automatically heads for the
 * nearest reachable player.
 */
export class NavField {
  readonly dist = new Int32Array(FLOW_CELLS);
  readonly height = new Int16Array(FLOW_CELLS);
  readonly walkable = new Uint8Array(FLOW_CELLS);
  private readonly queue = new Int32Array(FLOW_CELLS);
  /** world.editSerial at the last walkability rebuild. */
  private terrainStamp = -1;
  private generationStamp = -1;
  rebuilds = 0;

  /** Rebuild the walkability + height grid from the world surface map. */
  refreshTerrain(world: { surfaceKnown(x: number, z: number): number; getBlock(x: number, y: number, z: number): number }): void {
    for (let cz = 0; cz < FLOW_DIM; cz++) {
      for (let cx = 0; cx < FLOW_DIM; cx++) {
        const i = cx + cz * FLOW_DIM;
        const wx = WORLD_MIN_BLOCK_X + cx * FLOW_CELL + (FLOW_CELL >> 1);
        const wz = WORLD_MIN_BLOCK_Z + cz * FLOW_CELL + (FLOW_CELL >> 1);
        const y = world.surfaceKnown(wx, wz);
        if (y < 1 || y > CHUNK_HEIGHT - 4) { this.walkable[i] = 0; this.height[i] = -1; continue; }
        const ground = world.getBlock(wx, y, wz);
        if (ground === BlockId.LAVA) { this.walkable[i] = 0; this.height[i] = y; continue; }
        // Two blocks of headroom, or a monster cannot stand there.
        const clear = world.getBlock(wx, y + 1, wz) === BlockId.AIR && world.getBlock(wx, y + 2, wz) === BlockId.AIR;
        this.walkable[i] = clear ? 1 : 0;
        this.height[i] = y;
      }
    }
  }

  /** Cell index for a world position, or -1 when outside the arena. */
  static cellOf(x: number, z: number): number {
    const cx = Math.floor((x - WORLD_MIN_BLOCK_X) / FLOW_CELL);
    const cz = Math.floor((z - WORLD_MIN_BLOCK_Z) / FLOW_CELL);
    if (cx < 0 || cz < 0 || cx >= FLOW_DIM || cz >= FLOW_DIM) return -1;
    return cx + cz * FLOW_DIM;
  }

  static cellCentreX(cell: number): number {
    return WORLD_MIN_BLOCK_X + (cell % FLOW_DIM) * FLOW_CELL + FLOW_CELL * 0.5;
  }
  static cellCentreZ(cell: number): number {
    return WORLD_MIN_BLOCK_Z + Math.floor(cell / FLOW_DIM) * FLOW_CELL + FLOW_CELL * 0.5;
  }

  /**
   * Flood from `sources` (flat x,z pairs). Terrain is re-scanned whenever the
   * world's edit serial moved, which is how the field survives a rocket taking
   * out the bridge a monster was crossing.
   */
  rebuild(
    world: { surfaceKnown(x: number, z: number): number; getBlock(x: number, y: number, z: number): number; editSerial: number; generation: number },
    sources: Float64Array, sourceCount: number,
  ): void {
    if (world.editSerial !== this.terrainStamp || world.generation !== this.generationStamp) {
      this.refreshTerrain(world);
      this.terrainStamp = world.editSerial;
      this.generationStamp = world.generation;
    }
    this.dist.fill(FLOW_UNREACHED);

    let head = 0;
    let tail = 0;
    for (let s = 0; s < sourceCount; s++) {
      const cell = NavField.cellOf(sources[s * 2], sources[s * 2 + 1]);
      if (cell < 0) continue;
      if (this.dist[cell] === 0) continue;
      this.dist[cell] = 0;
      this.queue[tail++] = cell;
    }
    if (tail === 0) { this.rebuilds++; return; }

    while (head < tail) {
      const cur = this.queue[head++];
      const d = this.dist[cur];
      const cx = cur % FLOW_DIM;
      const cz = (cur / FLOW_DIM) | 0;
      const hCur = this.height[cur];
      for (let n = 0; n < 4; n++) {
        const nx = cx + (n === 0 ? 1 : n === 1 ? -1 : 0);
        const nz = cz + (n === 2 ? 1 : n === 3 ? -1 : 0);
        if (nx < 0 || nz < 0 || nx >= FLOW_DIM || nz >= FLOW_DIM) continue;
        const ni = nx + nz * FLOW_DIM;
        if (this.dist[ni] !== FLOW_UNREACHED) continue;
        if (this.walkable[ni] === 0) continue;
        const hN = this.height[ni];
        if (hCur >= 0) {
          const rise = hN - hCur;
          if (rise > MAX_CLIMB || rise < -MAX_DROP) continue;
        }
        this.dist[ni] = d + 1;
        if (tail < FLOW_CELLS) this.queue[tail++] = ni;
      }
    }
    this.rebuilds++;
  }

  /** Distance in cells to the nearest source, or -1 when unreachable. */
  distanceAt(x: number, z: number): number {
    const c = NavField.cellOf(x, z);
    if (c < 0) return -1;
    const d = this.dist[c];
    return d === FLOW_UNREACHED ? -1 : d;
  }

  /**
   * Unit-ish descent direction at a world position, written into `out[0]`/`out[1]`.
   * Returns false when the position has no route to a source.
   */
  direction(x: number, z: number, out: Float64Array): boolean {
    const c = NavField.cellOf(x, z);
    if (c < 0) return false;
    const cx = c % FLOW_DIM;
    const cz = (c / FLOW_DIM) | 0;
    let best = this.dist[c];
    let bx = 0, bz = 0;
    let found = false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= FLOW_DIM || nz >= FLOW_DIM) continue;
        const ni = nx + nz * FLOW_DIM;
        const d = this.dist[ni];
        if (d >= best) continue;
        // Diagonals only when both orthogonal neighbours are open, so nothing
        // tries to cut a corner through a wall.
        if (dx !== 0 && dz !== 0) {
          if (this.walkable[cx + dx + cz * FLOW_DIM] === 0 || this.walkable[cx + (cz + dz) * FLOW_DIM] === 0) continue;
        }
        best = d;
        bx = dx; bz = dz;
        found = true;
      }
    }
    if (!found) { out[0] = 0; out[1] = 0; return false; }
    const l = Math.sqrt(bx * bx + bz * bz) || 1;
    out[0] = bx / l;
    out[1] = bz / l;
    return true;
  }
}

/* ------------------------------------------------------------------------ *
 * Monster archetypes
 * ------------------------------------------------------------------------ */

export interface MonsterArchetype {
  readonly type: EntityType;
  readonly name: string;
  readonly health: number;
  readonly halfW: number;
  readonly height: number;
  readonly flying: boolean;
  /** Ground/flight speed, m/s. */
  readonly speed: number;
  readonly accel: number;
  readonly sightRange: number;
  /** Distance at which it will try to attack. */
  readonly attackRange: number;
  /** Distance it tries to hold; below this it backs off. */
  readonly preferredRange: number;
  readonly attackCooldownMs: number;
  readonly windupMs: number;
  readonly meleeDamage: number;
  readonly hitscanDamage: number;
  readonly hitscanPellets: number;
  readonly hitscanSpread: number;
  readonly projectileWeapon: number;
  readonly projectileSpeed: number;
  readonly projectileDamage: number;
  /** 0..1 tendency to circle-strafe rather than beeline. */
  readonly strafe: number;
  /** 0..1 chance per second of hopping while chasing. */
  readonly jumpiness: number;
  readonly score: number;
}

function archetype(a: MonsterArchetype): MonsterArchetype { return Object.freeze(a); }

export const MONSTERS: readonly MonsterArchetype[] = Object.freeze([
  archetype({
    type: EntityType.IMP, name: 'Imp',
    health: 60, halfW: 0.42, height: 1.75, flying: false,
    speed: 8.6, accel: 42, sightRange: 62, attackRange: 2.5, preferredRange: 0,
    attackCooldownMs: 620, windupMs: 180,
    meleeDamage: 21, hitscanDamage: 0, hitscanPellets: 0, hitscanSpread: 0,
    projectileWeapon: -1, projectileSpeed: 0, projectileDamage: 0,
    strafe: 0.15, jumpiness: 0.7, score: 1,
  }),
  archetype({
    type: EntityType.ZOMBIE, name: 'Trooper',
    health: 48, halfW: 0.38, height: 1.8, flying: false,
    speed: 5.4, accel: 30, sightRange: 70, attackRange: 44, preferredRange: 16,
    attackCooldownMs: 820, windupMs: 140,
    meleeDamage: 0, hitscanDamage: 9, hitscanPellets: 1, hitscanSpread: 0.045,
    projectileWeapon: -1, projectileSpeed: 0, projectileDamage: 0,
    strafe: 0.85, jumpiness: 0.15, score: 1,
  }),
  archetype({
    type: EntityType.CACODEMON, name: 'Cacodemon',
    health: 170, halfW: 0.85, height: 1.7, flying: true,
    speed: 5.2, accel: 16, sightRange: 66, attackRange: 40, preferredRange: 13,
    attackCooldownMs: 1150, windupMs: 300,
    meleeDamage: 0, hitscanDamage: 0, hitscanPellets: 0, hitscanSpread: 0,
    projectileWeapon: WeaponId.PLASMA, projectileSpeed: 31, projectileDamage: 27,
    strafe: 0.55, jumpiness: 0, score: 2,
  }),
  archetype({
    type: EntityType.BARON, name: 'Baron',
    health: 340, halfW: 0.62, height: 2.4, flying: false,
    speed: 3.6, accel: 18, sightRange: 60, attackRange: 26, preferredRange: 9,
    attackCooldownMs: 1550, windupMs: 420,
    meleeDamage: 34, hitscanDamage: 10, hitscanPellets: 6, hitscanSpread: 0.125,
    projectileWeapon: -1, projectileSpeed: 0, projectileDamage: 0,
    strafe: 0.25, jumpiness: 0.05, score: 4,
  }),
  archetype({
    type: EntityType.LOST_SOUL, name: 'Lost Soul',
    health: 32, halfW: 0.35, height: 0.9, flying: true,
    speed: 13.5, accel: 26, sightRange: 58, attackRange: 1.9, preferredRange: 0,
    attackCooldownMs: 1100, windupMs: 260,
    meleeDamage: 15, hitscanDamage: 0, hitscanPellets: 0, hitscanSpread: 0,
    projectileWeapon: -1, projectileSpeed: 0, projectileDamage: 0,
    strafe: 0.05, jumpiness: 0, score: 1,
  }),
]);

const ARCHETYPE_BY_TYPE = new Map<number, MonsterArchetype>();
for (const m of MONSTERS) ARCHETYPE_BY_TYPE.set(m.type, m);

export function monsterArchetype(type: number): MonsterArchetype | undefined {
  return ARCHETYPE_BY_TYPE.get(type);
}

/* ------------------------------------------------------------------------ *
 * Monster manager
 * ------------------------------------------------------------------------ */

/** Monster spawn annulus around a live player, metres. */
const SPAWN_RING_MIN = 22;
const SPAWN_RING_MAX = 58;
/** Past this from every player a monster is scenery, not a threat. */
const CULL_DISTANCE = 130;

const SCRATCH_POS = new Float64Array(3);
const SCRATCH_VEL = new Float64Array(3);
const SCRATCH_DIR = new Float64Array(3);
const SCRATCH_FLOW = new Float64Array(2);

export interface MonsterBudget {
  /** How many monsters to keep alive. */
  target: number;
  /** Milliseconds between spawn attempts. */
  spawnIntervalMs: number;
  /** Toughest archetype index allowed to spawn (scales with the wave). */
  maxTier: number;
}

export class MonsterManager {
  readonly nav = new NavField();
  private readonly sim: Simulation;
  private readonly rng: Rng;
  private navTimer = 0;
  private spawnTimer = 0;
  private readonly sources = new Float64Array(64 * 2);
  /** Wave counter for horde mode. */
  wave = 1;
  budget: MonsterBudget = { target: 0, spawnIntervalMs: 1400, maxTier: 2 };
  private cullTimer = 4000;
  kills = 0;

  constructor(sim: Simulation, seed: number) {
    this.sim = sim;
    this.rng = new Rng(seed ^ 0x5bd1e995);
  }

  /** Live monsters (excludes pickups). */
  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (this.sim.entActive[i] === 1 && this.sim.entType[i] < EntityType.PICKUP_HEALTH) n++;
    }
    return n;
  }

  step(dtMs: number): void {
    const dt = dtMs / 1000;
    const sim = this.sim;

    this.navTimer -= dtMs;
    if (this.navTimer <= 0) {
      this.navTimer = 220;
      let n = 0;
      for (let i = 0; i < sim.players.length && n < 64; i++) {
        const p = sim.players[i];
        if (p.dead || !p.active) continue;
        this.sources[n * 2] = p.pos[0];
        this.sources[n * 2 + 1] = p.pos[2];
        n++;
      }
      this.nav.rebuild(sim.world, this.sources, n);
    }

    this.spawnTimer -= dtMs;
    if (this.budget.target > 0 && this.spawnTimer <= 0) {
      this.spawnTimer = this.budget.spawnIntervalMs;
      if (this.liveCount < this.budget.target) this.spawnOne();
    }

    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (sim.entActive[i] !== 1) continue;
      if (sim.entType[i] >= EntityType.PICKUP_HEALTH) continue;
      this.stepMonster(i, dt, dtMs);
    }

    this.cullTimer -= dtMs;
    if (this.cullTimer <= 0) {
      this.cullTimer = 2000;
      this.cullStranded();
    }
  }

  /**
   * Retire monsters nobody can reach. A 416 m arena will strand a demon behind
   * a terrace forever, and every stranded demon is a slot the budget cannot
   * spend near the fight. Recycling them is what keeps the pressure on.
   */
  private cullStranded(): void {
    const sim = this.sim;
    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (sim.entActive[i] !== 1) continue;
      if (sim.entType[i] >= EntityType.PICKUP_HEALTH) continue;
      let nearest = Infinity;
      for (let k = 0; k < sim.players.length; k++) {
        const p = sim.players[k];
        if (p.dead || !p.active) continue;
        const dx = p.pos[0] - sim.entX[i];
        const dz = p.pos[2] - sim.entZ[i];
        const d = dx * dx + dz * dz;
        if (d < nearest) nearest = d;
      }
      if (nearest > CULL_DISTANCE * CULL_DISTANCE) sim.removeEntity(i, RemoveReason.DESPAWNED);
    }
  }

  /** Drop a monster at a spawn point away from every player. */
  spawnOne(): number {
    const sim = this.sim;
    const tier = Math.min(this.budget.maxTier, MONSTERS.length - 1);
    // Weight toward the cheap archetypes; Barons stay rare.
    const roll = this.rng.next();
    let index = 0;
    if (roll > 0.93) index = 3;
    else if (roll > 0.76) index = 2;
    else if (roll > 0.62) index = 4;
    else if (roll > 0.32) index = 1;
    if (index > tier) index = index % (tier + 1);
    const a = MONSTERS[index];

    // Doom puts monsters in the room you are walking into, not on the far side
    // of the map. A uniform sample over a 416 m arena spawns them ~150 m away,
    // outside every archetype's sight range, and they never arrive — so the
    // spawn is an annulus around a random live player: far enough not to
    // materialise in your face, close enough that they are coming for you.
    let anchorX = 0;
    let anchorZ = 0;
    let anchored = false;
    let live = 0;
    // Humans first: a horde that keeps the bots company while the player walks
    // an empty map is the single worst thing this mode can do.
    let humansAlive = false;
    for (let i = 0; i < sim.players.length; i++) {
      const p = sim.players[i];
      if (!p.dead && p.active && !p.isBot) { humansAlive = true; break; }
    }
    for (let i = 0; i < sim.players.length; i++) {
      const p = sim.players[i];
      if (p.dead || !p.active) continue;
      if (humansAlive && p.isBot) continue;
      live++;
      if (this.rng.next() < 1 / live) { anchorX = p.pos[0]; anchorZ = p.pos[2]; anchored = true; }
    }

    for (let attempt = 0; attempt < 24; attempt++) {
      let x: number;
      let z: number;
      if (anchored && attempt < 18) {
        const ang = this.rng.next() * Math.PI * 2;
        const rad = SPAWN_RING_MIN + this.rng.next() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
        x = Math.round(anchorX + Math.cos(ang) * rad);
        z = Math.round(anchorZ + Math.sin(ang) * rad);
        if (x < WORLD_MIN_BLOCK_X + 24 || x > WORLD_MIN_BLOCK_X + WORLD_SIZE_BLOCKS - 24) continue;
        if (z < WORLD_MIN_BLOCK_Z + 24 || z > WORLD_MIN_BLOCK_Z + WORLD_SIZE_BLOCKS - 24) continue;
      } else {
        x = Math.round(this.rng.range(WORLD_MIN_BLOCK_X + 24, WORLD_MIN_BLOCK_X + WORLD_SIZE_BLOCKS - 24));
        z = Math.round(this.rng.range(WORLD_MIN_BLOCK_Z + 24, WORLD_MIN_BLOCK_Z + WORLD_SIZE_BLOCKS - 24));
      }
      if (!sim.world.hasChunk(blockToChunk(x), blockToChunk(z))) continue;
      const y = sim.world.standableY(x, z);
      if (y < 0) continue;
      let tooClose = false;
      for (let i = 0; i < sim.players.length; i++) {
        const p = sim.players[i];
        if (p.dead || !p.active) continue;
        const dx = p.pos[0] - x, dz = p.pos[2] - z;
        if (dx * dx + dz * dz < SPAWN_RING_MIN * SPAWN_RING_MIN) { tooClose = true; break; }
      }
      if (tooClose) continue;
      const spawnY = a.flying ? y + 2.2 : y;
      return sim.spawnEntity(a.type, x + 0.5, spawnY, z + 0.5, a.health, a.halfW, a.height, a.flying, 0);
    }
    return -1;
  }

  /** Spawn a specific archetype at a position — used by scripted encounters. */
  spawnAt(type: number, x: number, y: number, z: number): number {
    const a = ARCHETYPE_BY_TYPE.get(type);
    if (!a) return -1;
    return this.sim.spawnEntity(a.type, x, y, z, a.health, a.halfW, a.height, a.flying, 0);
  }

  private stepMonster(i: number, dt: number, dtMs: number): void {
    const sim = this.sim;
    const a = ARCHETYPE_BY_TYPE.get(sim.entType[i]);
    if (!a) return;

    if (sim.entPain[i] > 0) sim.entPain[i] = Math.max(0, sim.entPain[i] - dtMs);
    else sim.entState[i] &= ~ES_PAIN;
    if (sim.entAttackCd[i] > 0) sim.entAttackCd[i] = Math.max(0, sim.entAttackCd[i] - dtMs);

    const ex = sim.entX[i], ey = sim.entY[i], ez = sim.entZ[i];
    const eyeY = ey + a.height * 0.72;

    /* --- target selection --- */
    let target: PlayerEntity | null = null;
    let targetDist = Infinity;
    let targetLos = false;
    const current = sim.entTarget[i] !== 0 ? sim.getPlayer(sim.entTarget[i]) : undefined;
    for (let pi = 0; pi < sim.players.length; pi++) {
      const p = sim.players[pi];
      if (p.dead || !p.active) continue;
      const dx = p.pos[0] - ex, dy = p.pos[1] + PLAYER_EYE_HEIGHT - eyeY, dz = p.pos[2] - ez;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > a.sightRange) continue;
      const los = sim.hasLineOfSight(ex, eyeY, ez, p.pos[0], p.pos[1] + PLAYER_EYE_HEIGHT * 0.8, p.pos[2]);
      // Stickiness: the current target keeps a 25% distance advantage so the
      // monster does not flip between two players every tick.
      const weighted = (p === current ? d * 0.75 : d) + (los ? 0 : 34);
      if (weighted < targetDist) {
        targetDist = weighted;
        target = p;
        targetLos = los;
      }
    }
    if (!target && current && !current.dead) {
      target = current;
      const dx = current.pos[0] - ex, dy = current.pos[1] - ey, dz = current.pos[2] - ez;
      targetDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      targetLos = false;
    }
    sim.entTarget[i] = target ? target.id : 0;

    let state = sim.entState[i] & ES_PAIN;
    if (a.flying) state |= ES_FLYING;

    /* --- steering --- */
    let wishX = 0, wishZ = 0, wishY = 0;
    let desiredYaw = sim.entYaw[i];

    if (target) {
      state |= ES_ALERT;
      const dx = target.pos[0] - ex;
      const dz = target.pos[2] - ez;
      const flat = Math.sqrt(dx * dx + dz * dz) || 1e-6;
      desiredYaw = Math.atan2(-dx, -dz);

      if (targetLos) {
        sim.entLos[i] = 900;
      } else {
        sim.entLos[i] = Math.max(0, sim.entLos[i] - dtMs);
      }

      const straightLine = targetLos || sim.entLos[i] > 0;
      if (straightLine && flat < 46) {
        let fx = dx / flat, fz = dz / flat;
        // Hold the preferred range: rushers close, shooters keep their distance.
        if (a.preferredRange > 0) {
          if (flat < a.preferredRange * 0.75) { fx = -fx; fz = -fz; }
          else if (flat < a.preferredRange * 1.25) { fx = 0; fz = 0; }
        }
        // Circle strafe, flipping direction on a timer so it is not a treadmill.
        sim.entTimer[i] -= dtMs;
        if (sim.entTimer[i] <= 0) {
          sim.entTimer[i] = 700 + this.rng.next() * 1500;
          if (this.rng.next() < 0.45) sim.entStrafe[i] = sim.entStrafe[i] > 0 ? -1 : 1;
        }
        const sx = -(dz / flat) * sim.entStrafe[i] * a.strafe;
        const sz = (dx / flat) * sim.entStrafe[i] * a.strafe;
        wishX = fx + sx;
        wishZ = fz + sz;
      } else {
        // No sight line: follow the flow field toward the nearest player.
        if (this.nav.direction(ex, ez, SCRATCH_FLOW)) {
          wishX = SCRATCH_FLOW[0];
          wishZ = SCRATCH_FLOW[1];
        } else {
          wishX = dx / flat;
          wishZ = dz / flat;
        }
      }

      if (a.flying) {
        const desiredY = target.pos[1] + 1.6 + Math.sin((sim.nowMs + i * 613) * 0.0016) * 1.1;
        wishY = clamp((desiredY - ey) * 0.6, -1, 1);
      }
    } else {
      // Idle: drift along the flow field so monsters converge on the fight.
      if (this.nav.direction(ex, ez, SCRATCH_FLOW)) {
        wishX = SCRATCH_FLOW[0] * 0.55;
        wishZ = SCRATCH_FLOW[1] * 0.55;
      }
      sim.entLos[i] = 0;
    }

    const wl = Math.sqrt(wishX * wishX + wishZ * wishZ);
    if (wl > 1) { wishX /= wl; wishZ /= wl; }
    if (wl > 0.05) state |= ES_MOVING;

    /* --- attack --- */
    // Every attack telegraphs: a wind-up you can see and dodge, then the hit.
    if (sim.entWindup[i] > 0) {
      state |= ES_WINDUP;
      sim.entWindup[i] -= dtMs;
      if (sim.entWindup[i] <= 0) {
        sim.entWindup[i] = 0;
        state &= ~ES_WINDUP;
        if (target) {
          const dx = target.pos[0] - ex;
          const dy = target.pos[1] + PLAYER_HEIGHT * 0.55 - eyeY;
          const dz = target.pos[2] - ez;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= a.attackRange * 1.35) {
            this.attack(i, a, target);
            state |= ES_ATTACK;
          }
        }
      }
    } else if (target && targetLos && sim.entAttackCd[i] <= 0) {
      const dx = target.pos[0] - ex;
      const dy = target.pos[1] + PLAYER_HEIGHT * 0.55 - eyeY;
      const dz = target.pos[2] - ez;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= a.attackRange) {
        sim.entWindup[i] = a.windupMs;
        sim.entAttackCd[i] = a.attackCooldownMs + a.windupMs;
        state |= ES_WINDUP;
      }
    }

    /* --- integrate --- */
    SCRATCH_POS[0] = ex; SCRATCH_POS[1] = ey; SCRATCH_POS[2] = ez;
    SCRATCH_VEL[0] = sim.entVX[i]; SCRATCH_VEL[1] = sim.entVY[i]; SCRATCH_VEL[2] = sim.entVZ[i];

    const speed = (state & ES_WINDUP) !== 0 ? a.speed * 0.35 : a.speed;
    const tx = wishX * speed;
    const tz = wishZ * speed;
    const ax = tx - SCRATCH_VEL[0];
    const az = tz - SCRATCH_VEL[2];
    const al = Math.sqrt(ax * ax + az * az);
    const maxA = a.accel * dt;
    if (al > maxA && al > 1e-9) {
      SCRATCH_VEL[0] += (ax / al) * maxA;
      SCRATCH_VEL[2] += (az / al) * maxA;
    } else {
      SCRATCH_VEL[0] = tx;
      SCRATCH_VEL[2] = tz;
    }

    if (a.flying) {
      SCRATCH_VEL[1] += (wishY * a.speed * 0.8 - SCRATCH_VEL[1]) * Math.min(1, a.accel * dt * 0.25);
      // Never let a flyer sink into the floor or scrape the sky.
      const ground = sim.world.surfaceKnown(Math.floor(ex), Math.floor(ez));
      if (ground >= 0 && ey < ground + 1.6) SCRATCH_VEL[1] += 6 * dt * (ground + 1.6 - ey);
      if (ey > CHUNK_HEIGHT - 4) SCRATCH_VEL[1] -= 8 * dt;
    } else {
      const grounded = sim.entGround[i] === 1;
      if (grounded) {
        // Hop over the small stuff; the step in moveAABB handles single blocks.
        const wantJump = (state & ES_MOVING) !== 0 && a.jumpiness > 0 &&
          this.rng.next() < a.jumpiness * dt * 2 &&
          this.blockedAhead(ex, ey, ez, wishX, wishZ, a.halfW);
        if (wantJump) SCRATCH_VEL[1] = 8.2;
        else SCRATCH_VEL[1] -= GRAVITY * 0.3 * dt;
      } else {
        SCRATCH_VEL[1] -= GRAVITY * dt;
      }
      if (SCRATCH_VEL[1] < -TERMINAL_VELOCITY) SCRATCH_VEL[1] = -TERMINAL_VELOCITY;
    }

    moveAABB(SCRATCH_POS, SCRATCH_VEL, a.halfW, a.height, dt, a.flying ? 0 : STEP_HEIGHT, sim.world.solidAt);

    sim.entX[i] = SCRATCH_POS[0];
    sim.entY[i] = SCRATCH_POS[1];
    sim.entZ[i] = SCRATCH_POS[2];
    sim.entVX[i] = SCRATCH_VEL[0];
    sim.entVY[i] = SCRATCH_VEL[1];
    sim.entVZ[i] = SCRATCH_VEL[2];
    if (!a.flying) {
      sim.entGround[i] = isGrounded(SCRATCH_POS, a.halfW, 0.08, sim.world.solidAt) ? 1 : 0;
    }

    // Fell out of the world (a rocket removed the floor): teleport to a ledge.
    if (sim.entY[i] < 1) {
      const y = sim.world.standableY(Math.floor(sim.entX[i]), Math.floor(sim.entZ[i]));
      if (y >= 0) { sim.entY[i] = y; sim.entVY[i] = 0; }
      else sim.removeEntity(i, 5 /* DESPAWNED */);
    }

    sim.entYaw[i] = wrapAngle(sim.entYaw[i] + angleDelta(sim.entYaw[i], desiredYaw) * Math.min(1, dt * 9));
    sim.entState[i] = state;
  }

  /** Is there a wall within a metre in the direction of travel? */
  private blockedAhead(x: number, y: number, z: number, dx: number, dz: number, halfW: number): boolean {
    const px = x + dx * (halfW + 0.7);
    const pz = z + dz * (halfW + 0.7);
    return sIsSolid(this.sim, px, y + 0.4, pz) || sIsSolid(this.sim, px, y + 1.1, pz);
  }

  private attack(i: number, a: MonsterArchetype, target: PlayerEntity): void {
    const sim = this.sim;
    const ex = sim.entX[i];
    const ey = sim.entY[i] + a.height * 0.72;
    const ez = sim.entZ[i];
    const tx = target.pos[0];
    const ty = target.pos[1] + PLAYER_HEIGHT * 0.55;
    const tz = target.pos[2];
    let dx = tx - ex, dy = ty - ey, dz = tz - ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    dx /= d; dy /= d; dz /= d;

    if (a.projectileWeapon >= 0) {
      sim.spawnProjectile(
        0, a.projectileWeapon,
        ex + dx * (a.halfW + 0.4), ey + dy * 0.4, ez + dz * (a.halfW + 0.4),
        dx * a.projectileSpeed, dy * a.projectileSpeed, dz * a.projectileSpeed,
        a.projectileDamage, true,
      );
      return;
    }

    if (a.hitscanPellets > 0 && d > 2.2) {
      for (let p = 0; p < a.hitscanPellets; p++) {
        const sx = dx + (this.rng.next() - 0.5) * a.hitscanSpread * 2;
        const sy = dy + (this.rng.next() - 0.5) * a.hitscanSpread * 2;
        const sz = dz + (this.rng.next() - 0.5) * a.hitscanSpread * 2;
        const l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
        if (!sim.hasLineOfSight(ex, ey, ez, ex + (sx / l) * d, ey + (sy / l) * d, ez + (sz / l) * d)) continue;
        // Only pellets whose jittered ray still lands on the body connect.
        const hitX = ex + (sx / l) * d;
        const hitY = ey + (sy / l) * d;
        const hitZ = ez + (sz / l) * d;
        if (Math.abs(hitX - tx) > PLAYER_HALF_WIDTH + 0.15) continue;
        if (Math.abs(hitZ - tz) > PLAYER_HALF_WIDTH + 0.15) continue;
        if (hitY < target.pos[1] - 0.1 || hitY > target.pos[1] + target.height + 0.1) continue;
        sim.damagePlayer(target, 0, a.hitscanDamage, WeaponId.PISTOL, 0, dx, dy, dz);
      }
      return;
    }

    if (a.meleeDamage > 0 && d <= a.attackRange + 0.6) {
      sim.damagePlayer(target, 0, a.meleeDamage, WeaponId.CHAINSAW, 0, dx, dy, dz);
      target.vel[0] += dx * 4.5;
      target.vel[1] += 2.4;
      target.vel[2] += dz * 4.5;
    }
  }
}

function sIsSolid(sim: Simulation, x: number, y: number, z: number): boolean {
  return sim.world.isSolid(Math.floor(x), Math.floor(y), Math.floor(z));
}

/* ------------------------------------------------------------------------ *
 * Filler bots — synthetic players
 * ------------------------------------------------------------------------ */

export const BOT_NAMES: readonly string[] = Object.freeze([
  'Ripper', 'Doomguy', 'Kessler', 'Vex', 'Nyx', 'Harbinger', 'Slayer', 'Torque',
  'Marrow', 'Cinder', 'Havoc', 'Wraith', 'Bishop', 'Rune', 'Cobalt', 'Grit',
  'Onyx', 'Prowl', 'Sable', 'Static', 'Talon', 'Vandal', 'Zealot', 'Blitz',
]);

interface BotBrain {
  player: PlayerEntity;
  cmd: InputCommand;
  /** 0..1 — aim precision, reaction time and strafe discipline. */
  skill: number;
  targetId: number;
  reacquireMs: number;
  reactionMs: number;
  strafeDir: number;
  strafeTimer: number;
  jumpTimer: number;
  fireHoldMs: number;
  aimYaw: number;
  aimPitch: number;
  wanderX: number;
  wanderZ: number;
  wanderTimer: number;
  rng: Rng;
}

const BOT_SCRATCH = new Float64Array(3);

/**
 * Drives the filler bots. They exist so a match is playable one second after
 * the click — the single biggest thing the bar gets wrong.
 */
export class BotDriver {
  private readonly sim: Simulation;
  private readonly nav: NavField;
  private readonly brains = new Map<number, BotBrain>();
  private nameCursor = 0;
  private readonly rng: Rng;

  constructor(sim: Simulation, nav: NavField, seed: number) {
    this.sim = sim;
    this.nav = nav;
    this.rng = new Rng(seed ^ 0x1f83d9ab);
  }

  get count(): number { return this.brains.size; }

  nextName(): string {
    const base = BOT_NAMES[this.nameCursor % BOT_NAMES.length];
    const round = Math.floor(this.nameCursor / BOT_NAMES.length);
    this.nameCursor++;
    return round === 0 ? base : `${base}${round + 1}`;
  }

  attach(player: PlayerEntity, skill = 0.55): void {
    this.brains.set(player.id, {
      player,
      cmd: createInputCommand(),
      skill: clamp(skill, 0.15, 0.95),
      targetId: 0,
      reacquireMs: 0,
      reactionMs: 0,
      strafeDir: this.rng.bool(0.5) ? 1 : -1,
      strafeTimer: 0,
      jumpTimer: 0,
      fireHoldMs: 0,
      aimYaw: player.yaw,
      aimPitch: 0,
      wanderX: player.pos[0],
      wanderZ: player.pos[2],
      wanderTimer: 0,
      rng: this.rng.fork(player.id),
    });
  }

  detach(playerId: number): void { this.brains.delete(playerId); }

  /** Produce one command per bot and push it through the normal input path. */
  step(dtMs: number): void {
    const sim = this.sim;
    const dt = dtMs / 1000;
    for (const brain of this.brains.values()) {
      const p = brain.player;
      if (!p.active) continue;
      const cmd = brain.cmd;
      cmd.seq = (cmd.seq + 1) >>> 0;
      cmd.dtMs = dtMs;
      cmd.buttons = 0;
      cmd.moveX = 0;
      cmd.moveZ = 0;
      cmd.slot = p.weapon;

      if (p.dead) {
        cmd.yaw = p.yaw;
        cmd.pitch = p.pitch;
        sim.applyInput(p, cmd, dtMs);
        continue;
      }

      this.think(brain, dt, dtMs);
      sim.applyInput(p, cmd, dtMs);
    }
  }

  private think(brain: BotBrain, dt: number, dtMs: number): void {
    const sim = this.sim;
    const p = brain.player;
    const cmd = brain.cmd;
    const skill = brain.skill;

    /* --- pick a target --- */
    brain.reacquireMs -= dtMs;
    if (brain.reacquireMs <= 0) {
      brain.reacquireMs = 260;
      let best = -1;
      let bestScore = Infinity;
      for (let i = 0; i < sim.players.length; i++) {
        const o = sim.players[i];
        if (o === p || o.dead || !o.active) continue;
        const d = dist3(p.pos[0], p.pos[1], p.pos[2], o.pos[0], o.pos[1], o.pos[2]);
        if (d > 90) continue;
        const los = sim.hasLineOfSight(p.pos[0], p.eyeY, p.pos[2], o.pos[0], o.pos[1] + PLAYER_EYE_HEIGHT, o.pos[2]);
        const score = d + (los ? 0 : 55) + (o.id === brain.targetId ? -12 : 0);
        if (score < bestScore) { bestScore = score; best = o.id; }
      }
      if (best !== brain.targetId) {
        brain.targetId = best < 0 ? 0 : best;
        brain.reactionMs = 90 + (1 - skill) * 260;
      }
    }
    if (brain.reactionMs > 0) brain.reactionMs -= dtMs;

    const target = brain.targetId !== 0 ? sim.getPlayer(brain.targetId) : undefined;
    let hasShot = false;
    let tx = 0, ty = 0, tz = 0, tdist = 0;

    if (target && !target.dead && target.active) {
      tx = target.pos[0];
      ty = target.pos[1] + PLAYER_HEIGHT * 0.62;
      tz = target.pos[2];
      tdist = dist3(p.pos[0], p.eyeY, p.pos[2], tx, ty, tz);
      hasShot = sim.hasLineOfSight(p.pos[0], p.eyeY, p.pos[2], tx, ty, tz) && brain.reactionMs <= 0;
    }

    /* --- aim --- */
    if (target && (hasShot || tdist < 40)) {
      // Lead the shot a little at range so bots are not trivially strafed.
      const lead = tdist / 90;
      const ax = tx + target.vel[0] * lead - p.pos[0];
      const ay = ty + target.vel[1] * lead * 0.4 - p.eyeY;
      const az = tz + target.vel[2] * lead - p.pos[2];
      const flat = Math.sqrt(ax * ax + az * az) || 1e-6;
      const wantYaw = Math.atan2(-ax, -az);
      const wantPitch = Math.atan2(ay, flat);
      const turn = (3.2 + skill * 9) * dt;
      brain.aimYaw = wrapAngle(brain.aimYaw + angleDelta(brain.aimYaw, wantYaw) * Math.min(1, turn));
      brain.aimPitch = brain.aimPitch + (wantPitch - brain.aimPitch) * Math.min(1, turn);
      const err = (1 - skill) * 0.05;
      brain.aimYaw += (brain.rng.next() - 0.5) * err;
      brain.aimPitch += (brain.rng.next() - 0.5) * err * 0.6;
    } else {
      // Look where we are going.
      const dx = brain.wanderX - p.pos[0];
      const dz = brain.wanderZ - p.pos[2];
      if (dx * dx + dz * dz > 1) {
        const wantYaw = Math.atan2(-dx, -dz);
        brain.aimYaw = wrapAngle(brain.aimYaw + angleDelta(brain.aimYaw, wantYaw) * Math.min(1, 5 * dt));
      }
      brain.aimPitch += (0 - brain.aimPitch) * Math.min(1, 4 * dt);
    }
    cmd.yaw = brain.aimYaw;
    cmd.pitch = clamp(brain.aimPitch, -1.4, 1.4);

    /* --- movement --- */
    brain.strafeTimer -= dtMs;
    if (brain.strafeTimer <= 0) {
      brain.strafeTimer = 500 + brain.rng.next() * 1400;
      if (brain.rng.next() < 0.6) brain.strafeDir = brain.strafeDir > 0 ? -1 : 1;
    }

    let moveX = 0;
    let moveZ = 0;
    if (target && !target.dead && tdist < 60) {
      const desired = this.desiredRange(p.weapon);
      if (tdist > desired * 1.25) moveZ = 1;
      else if (tdist < desired * 0.6) moveZ = -1;
      else moveZ = 0.25;
      moveX = brain.strafeDir * (0.55 + skill * 0.45);
      if (!hasShot) {
        // Break the wall: walk the flow field toward the target instead.
        if (this.nav.direction(p.pos[0], p.pos[2], SCRATCH_FLOW)) {
          // Project the world-space wish onto the local move axes:
          // right = (cos yaw, -sin yaw), forward = (-sin yaw, -cos yaw).
          const fx = SCRATCH_FLOW[0];
          const fz = SCRATCH_FLOW[1];
          const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
          moveX = fx * cy - fz * sy;
          moveZ = -fx * sy - fz * cy;
        } else {
          moveZ = 1;
        }
      }
      if (tdist > 18) cmd.buttons |= BTN_SPRINT;
    } else {
      brain.wanderTimer -= dtMs;
      const dx = brain.wanderX - p.pos[0];
      const dz = brain.wanderZ - p.pos[2];
      if (brain.wanderTimer <= 0 || dx * dx + dz * dz < 9) {
        brain.wanderTimer = 3000 + brain.rng.next() * 4000;
        const ang = brain.rng.next() * Math.PI * 2;
        const rad = 22 + brain.rng.next() * 60;
        brain.wanderX = clamp(p.pos[0] + Math.cos(ang) * rad, WORLD_MIN_BLOCK_X + 12, WORLD_MIN_BLOCK_X + WORLD_SIZE_BLOCKS - 12);
        brain.wanderZ = clamp(p.pos[2] + Math.sin(ang) * rad, WORLD_MIN_BLOCK_Z + 12, WORLD_MIN_BLOCK_Z + WORLD_SIZE_BLOCKS - 12);
      }
      moveZ = 1;
      cmd.buttons |= BTN_SPRINT;
    }

    // Unstick: if we barely moved but wanted to, hop and swing the strafe.
    const speed = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]);
    brain.jumpTimer -= dtMs;
    if (speed < SPEED_RUN * 0.25 && (moveX !== 0 || moveZ !== 0) && brain.jumpTimer <= 0) {
      brain.jumpTimer = 420;
      cmd.buttons |= BTN_JUMP;
      brain.strafeDir = brain.strafeDir > 0 ? -1 : 1;
    } else if (target && hasShot && brain.rng.next() < 0.55 * dt) {
      cmd.buttons |= BTN_JUMP;
    }

    if (p.inWater) cmd.buttons |= BTN_JUMP;

    cmd.moveX = clamp(moveX, -1, 1);
    cmd.moveZ = clamp(moveZ, -1, 1);

    /* --- weapon --- */
    const wantWeapon = this.chooseWeapon(p, tdist, target !== undefined && !target.dead);
    cmd.slot = wantWeapon;

    if (p.mag[p.weapon] === 0 && !p.reloading) cmd.buttons |= BTN_RELOAD;

    if (target && hasShot && tdist < this.maxRange(p.weapon)) {
      // Aim gate: only pull the trigger when the crosshair is roughly on target.
      anglesToForward(BOT_SCRATCH, 0, cmd.yaw, cmd.pitch);
      const ax = tx - p.pos[0], ay = ty - p.eyeY, az = tz - p.pos[2];
      const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      const dot = (BOT_SCRATCH[0] * ax + BOT_SCRATCH[1] * ay + BOT_SCRATCH[2] * az) / al;
      const gate = 0.985 - (1 - skill) * 0.02;
      if (dot > gate) {
        brain.fireHoldMs = 120 + brain.rng.next() * 220;
      }
    }
    if (brain.fireHoldMs > 0) {
      brain.fireHoldMs -= dtMs;
      cmd.buttons |= BTN_FIRE;
    }

    if (p.crouching && !target) cmd.buttons |= 0;
    if (target && tdist > 34 && skill > 0.7 && p.onGround && brain.rng.next() < 0.4 * dt) {
      cmd.buttons |= BTN_CROUCH;
    }
  }

  private desiredRange(weapon: number): number {
    switch (weapon) {
      case WeaponId.SHOTGUN: return 8;
      case WeaponId.CHAINSAW: return 2;
      case WeaponId.ROCKET: return 18;
      case WeaponId.BFG: return 22;
      case WeaponId.CHAINGUN: return 16;
      default: return 14;
    }
  }

  private maxRange(weapon: number): number {
    switch (weapon) {
      case WeaponId.SHOTGUN: return 22;
      case WeaponId.CHAINSAW: return 2.6;
      case WeaponId.ROCKET: return 55;
      case WeaponId.BFG: return 60;
      default: return 70;
    }
  }

  private chooseWeapon(p: PlayerEntity, dist: number, hasTarget: boolean): number {
    if (!hasTarget) return p.weapon;
    const prefer: number[] = dist < 3
      ? [WeaponId.CHAINSAW, WeaponId.SHOTGUN, WeaponId.CHAINGUN, WeaponId.PISTOL]
      : dist < 12
        ? [WeaponId.SHOTGUN, WeaponId.CHAINGUN, WeaponId.PLASMA, WeaponId.PISTOL]
        : dist < 30
          ? [WeaponId.CHAINGUN, WeaponId.PLASMA, WeaponId.ROCKET, WeaponId.PISTOL]
          : [WeaponId.ROCKET, WeaponId.CHAINGUN, WeaponId.PISTOL];
    for (let i = 0; i < prefer.length; i++) {
      const w = prefer[i];
      if (!ownsWeapon(p.weaponMask, w)) continue;
      if (w !== WeaponId.CHAINSAW && p.mag[w] === 0 && p.reserveFor(w) === 0) continue;
      return w;
    }
    return p.weapon;
  }
}

function dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Deterministic bot skill from a room seed and a slot index. */
export function botSkillFor(seed: number, index: number): number {
  return 0.32 + (hash2i(seed, index, 0x51ed) % 1000) / 1000 * 0.55;
}
