/**
 * DOOMCRAFT — HORDE tests.
 *
 * The claims worth proving are the ones the mode dies without:
 *
 *   1. A wall built across the only approach is answered — the demon either
 *      repaths around it or attacks it, and when it attacks, the wall's hit
 *      points go down and the block eventually stops existing.
 *   2. A flyer does not care. It crosses the same fortification and never takes
 *      a hit point off it.
 *   3. Blocks cost credits, out of the same wallet that buys guns, and a
 *      placement nobody can pay for is reverted by the server.
 *   4. The wave curve escalates in shape, not just in count.
 *
 * The arena is hand-built rather than generated so the geometry is exactly what
 * the assertions say it is: a flat room split by a full-height partition with
 * one doorway, which is the only way from the west half to the east half.
 */

import { describe, expect, it } from 'vitest';
import {
  BlockId,
  CHUNK_HEIGHT,
  EntityType,
  TICK_MS,
} from '@doomcraft/shared';
import { ModeAction, ModeId, ModePhase } from '@doomcraft/shared/modes';
import { SessionArsenal } from '@doomcraft/shared/arsenal';
import { WeaponId, WEAPONS, getWeapon, ownsWeapon } from '@doomcraft/shared/weapons';

import { MonsterManager } from './bots.js';
import {
  ES_ALERT_BIT,
  ES_ATTACK_BIT,
  ES_MOVING_BIT,
  ES_WINDUP_BIT,
  FortLedger,
  HORDE_ENEMIES,
  HORDE_GATE_COUNT,
  HORDE_SHOP,
  HORDE_START_CREDITS,
  HordeDirector,
  HordeItem,
  blockCost,
  bossWave,
  composeWave,
  createWaveComposition,
  describeGates,
  fortHpFor,
  gateIsHot,
  hordeEnemy,
} from './horde.js';
import { joinRequestFor, resolveModePlan } from './modes.js';
import { ES_ALERT, ES_ATTACK, ES_MOVING, ES_WINDUP, Simulation } from './sim.js';
import type { PlayerEntity } from './sim.js';
import { ServerWorld } from './world.js';

/* ------------------------------------------------------------------------ *
 * Arena
 *
 *   x: -4 .. 44   z: -4 .. 28      flattened, floor top at y = FLOOR
 *   perimeter walls, 4 blocks thick, full height
 *   partition at x = 21..22, full height, with a doorway at z = 8..15
 *
 * The 4-block thickness is not decoration: NavField samples one column per
 * 4x4 cell (at x,z congruent to 2 mod 4), so a thinner barrier is invisible to
 * the flow field. The partition sits at x = 21..22 and the doorway spans
 * z = 8..15 precisely so that the sampled columns 22/10 and 22/14 are the only
 * two cells the flood can pass through.
 * ------------------------------------------------------------------------ */

const FLOOR = 6;
const X0 = -4;
const X1 = 44;
const Z0 = -4;
const Z1 = 28;
const PART_X0 = 21;
const PART_X1 = 22;
const DOOR_Z0 = 8;
const DOOR_Z1 = 15;
/** The player wall goes in the doorway, on the sampled column. */
const WALL_X = 22;
const WALL_TOP = FLOOR + 3;      // three blocks tall: y = 7, 8, 9

interface Arena {
  world: ServerWorld;
  sim: Simulation;
  monsters: MonsterManager;
  horde: HordeDirector;
  player: PlayerEntity;
}

function column(world: ServerWorld, x: number, z: number, floorTop: number, fillTo: number): void {
  for (let y = CHUNK_HEIGHT - 1; y > floorTop; y--) {
    if (world.getBlock(x, y, z) !== BlockId.AIR) world.setBlock(x, y, z, BlockId.AIR, 0);
  }
  for (let y = 1; y <= floorTop; y++) {
    if (world.getBlock(x, y, z) !== BlockId.STONE) world.setBlock(x, y, z, BlockId.STONE, 0);
  }
  for (let y = floorTop + 1; y <= fillTo; y++) world.setBlock(x, y, z, BlockId.STONE, 0);
}

function inPerimeter(x: number, z: number): boolean {
  return x <= X0 + 3 || x >= X1 - 3 || z <= Z0 + 3 || z >= Z1 - 3;
}

function buildArena(seed: number, withPartition: boolean): Arena {
  const world = new ServerWorld(seed);
  for (let z = Z0; z <= Z1; z++) {
    for (let x = X0; x <= X1; x++) {
      const wall = inPerimeter(x, z)
        || (withPartition && x >= PART_X0 && x <= PART_X1 && (z < DOOR_Z0 || z > DOOR_Z1));
      column(world, x, z, FLOOR, wall ? CHUNK_HEIGHT - 1 : FLOOR);
    }
  }
  world.journal.reset();

  const sim = new Simulation(world, seed);
  sim.lagCompensation = false;
  const monsters = new MonsterManager(sim, seed);
  const plan = resolveModePlan(joinRequestFor(ModeId.HORDE, '', '', 2, seed));
  const horde = new HordeDirector({ sim, monsters, plan, seed });

  const player = sim.addPlayer(1, 'Holder', 0, false);
  horde.addPlayer(1);
  placePlayer(sim, player, 34.5, FLOOR + 1, 12.5);
  return { world, sim, monsters, horde, player };
}

function placePlayer(sim: Simulation, p: PlayerEntity, x: number, y: number, z: number): void {
  p.pos[0] = x; p.pos[1] = y; p.pos[2] = z;
  p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
  p.dead = false;
  p.health = 100;
  p.onGround = true;
  p.spawnProtectUntilMs = sim.nowMs + 3_600_000;   // the test is about walls, not damage
  p.histCount = 0;
  p.histHead = 0;
  p.pushHistory(sim.nowMs);
}

/** One simulation tick in exactly the order server/src/room.ts runs it. */
function tick(a: Arena, dtMs = TICK_MS): void {
  a.sim.beginTick(dtMs);
  a.monsters.step(dtMs);
  a.sim.stepTick(dtMs);
  a.horde.step(dtMs);
  a.sim.clearEvents();
  a.world.journal.reset();
}

function run(a: Arena, ticks: number): void {
  for (let i = 0; i < ticks; i++) tick(a);
}

/** Put a three-high wall in the doorway, paid for out of the player's wallet. */
function buildWall(a: Arena, z0: number, z1: number, ownerId: number): void {
  for (let z = z0; z <= z1; z++) {
    for (let y = FLOOR + 1; y <= WALL_TOP; y++) {
      a.world.setBlock(WALL_X, y, z, BlockId.STONE, ownerId);
    }
  }
}

function spawnGround(a: Arena, type: EntityType, x: number, z: number): number {
  return a.monsters.spawnAt(type, x, FLOOR + 1, z);
}

function distToPlayer(a: Arena, slot: number): number {
  const dx = a.sim.entX[slot] - a.player.pos[0];
  const dz = a.sim.entZ[slot] - a.player.pos[2];
  return Math.sqrt(dx * dx + dz * dz);
}

/** Total hit points still standing across the doorway wall. */
function wallHp(a: Arena, z0: number, z1: number): number {
  let total = 0;
  for (let z = z0; z <= z1; z++) {
    for (let y = FLOOR + 1; y <= WALL_TOP; y++) {
      const hp = a.horde.fort.hpAt(WALL_X, y, z);
      if (hp > 0) total += hp;
    }
  }
  return total;
}

/** Blocks of the doorway wall still present in the world. */
function wallBlocks(a: Arena, z0: number, z1: number): number {
  let n = 0;
  for (let z = z0; z <= z1; z++) {
    for (let y = FLOOR + 1; y <= WALL_TOP; y++) {
      if (a.world.getBlock(WALL_X, y, z) === BlockId.STONE) n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------------------ *
 * The arena itself — if this is wrong every behaviour test below is theatre
 * ------------------------------------------------------------------------ */

describe('horde test arena', () => {
  it('is a flat room whose only route east is the doorway', () => {
    const a = buildArena(9001, true);
    expect(a.world.standableY(6, 10)).toBe(FLOOR + 1);
    expect(a.world.standableY(34, 12)).toBe(FLOOR + 1);
    // The partition is solid where it is not a doorway, open where it is.
    expect(a.world.isSolid(22, FLOOR + 2, 4)).toBe(true);
    expect(a.world.isSolid(22, FLOOR + 2, 20)).toBe(true);
    expect(a.world.isSolid(22, FLOOR + 2, 10)).toBe(false);
    expect(a.world.isSolid(22, FLOOR + 2, 14)).toBe(false);
    // …and the flood really does get through it.
    run(a, 20);
    expect(a.monsters.nav.distanceAt(6, 10)).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 1. The interlock: a wall is an obstacle the horde has to solve
 * ------------------------------------------------------------------------ */

describe('a wall across the only approach', () => {
  it('cuts the route, and the demon answers by attacking it — the wall loses health and breaks', () => {
    const a = buildArena(4242, true);
    run(a, 20);
    expect(a.monsters.nav.distanceAt(6, 10)).toBeGreaterThanOrEqual(0);

    // Seal the doorway out of the player's own credits.
    const creditsBefore = a.horde.creditsOf(1);
    buildWall(a, DOOR_Z0, DOOR_Z1, 1);
    run(a, 20);
    expect(a.horde.creditsOf(1)).toBeLessThan(creditsBefore);

    // The flow field now says the west half cannot reach the player at all:
    // this is the "repath" half of the contract, and it has no answer left.
    expect(a.monsters.nav.distanceAt(6, 10)).toBe(-1);

    // 8 columns x 3 blocks of stone, all at full health.
    const startHp = wallHp(a, DOOR_Z0, DOOR_Z1);
    expect(wallBlocks(a, DOOR_Z0, DOOR_Z1)).toBe(24);
    expect(startHp).toBe(24 * fortHpFor(BlockId.STONE));

    const imp = spawnGround(a, EntityType.IMP, 6.5, 10.5);
    expect(imp).toBeGreaterThanOrEqual(0);

    // Let it walk into the wall and commit to breaking through.
    let besieged = false;
    for (let i = 0; i < 240 && !besieged; i++) {
      tick(a);
      if (a.horde.isBreaching(imp)) besieged = true;
    }
    expect(besieged).toBe(true);

    // The swing telegraphs before it lands, exactly like a player-facing attack.
    let sawWindup = false;
    for (let i = 0; i < 60 && !sawWindup; i++) {
      tick(a);
      if ((a.sim.entState[imp] & ES_WINDUP_BIT) !== 0) sawWindup = true;
    }
    expect(sawWindup).toBe(true);

    // …and the wall's health goes down.
    let damagedHp = startHp;
    for (let i = 0; i < 200; i++) {
      tick(a);
      damagedHp = wallHp(a, DOOR_Z0, DOOR_Z1);
      if (damagedHp < startHp) break;
    }
    expect(damagedHp).toBeLessThan(startHp);

    // …to zero on the block it chose, at which point there is a hole.
    let broken = false;
    for (let i = 0; i < 600 && !broken; i++) {
      tick(a);
      if (wallBlocks(a, DOOR_Z0, DOOR_Z1) < 24) broken = true;
    }
    expect(broken).toBe(true);
    expect(a.horde.fort.breaches).toBeGreaterThan(0);
    expect(wallHp(a, DOOR_Z0, DOOR_Z1)).toBeLessThan(damagedHp);
  });

  it('leaves the wall alone when the wall has a gap: the flow field routes through it', () => {
    const a = buildArena(4243, true);
    run(a, 20);

    // Wall the northern half of the doorway only. z = 8..11 covers the sampled
    // column 10; z = 12..15 stays open and covers the sampled column 14.
    buildWall(a, DOOR_Z0, 11, 1);
    run(a, 20);

    const blockedHp = a.horde.fort.hpAt(WALL_X, FLOOR + 1, 10);
    expect(blockedHp).toBe(fortHpFor(BlockId.STONE));

    // The route survives — that IS the repath.
    expect(a.monsters.nav.distanceAt(6, 10)).toBeGreaterThanOrEqual(0);

    const imp = spawnGround(a, EntityType.IMP, 6.5, 10.5);
    const startDist = distToPlayer(a, imp);
    run(a, 220);

    // It went around rather than through: it is closer than it started and it
    // never took a bite out of the standing wall.
    if (a.sim.entActive[imp] === 1) {
      expect(distToPlayer(a, imp)).toBeLessThan(startDist);
    }
    expect(a.horde.fort.hpAt(WALL_X, FLOOR + 1, 10)).toBe(blockedHp);
    expect(a.horde.fort.breaches).toBe(0);
  });

  it('re-opens the route the moment the wall comes down', () => {
    const a = buildArena(4244, true);
    run(a, 20);
    buildWall(a, DOOR_Z0, DOOR_Z1, 1);
    run(a, 20);
    expect(a.monsters.nav.distanceAt(6, 10)).toBe(-1);

    // Take the wall out from under the flow field — a rocket does exactly this.
    for (let z = DOOR_Z0; z <= DOOR_Z1; z++) {
      for (let y = FLOOR + 1; y <= WALL_TOP; y++) a.world.setBlock(WALL_X, y, z, BlockId.AIR, 0);
    }
    run(a, 30);
    expect(a.monsters.nav.distanceAt(6, 10)).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Flyers are the counter
 * ------------------------------------------------------------------------ */

describe('flyers', () => {
  it('a Lost Soul is unaffected by a one-block wall', () => {
    const a = buildArena(5150, false);
    run(a, 10);
    // One block high, right across its path.
    for (let z = 6; z <= 20; z++) a.world.setBlock(WALL_X, FLOOR + 1, z, BlockId.STONE, 1);
    run(a, 10);

    const soul = a.monsters.spawnAt(EntityType.LOST_SOUL, 6.5, FLOOR + 2.4, 12.5);
    expect(soul).toBeGreaterThanOrEqual(0);
    const startX = a.sim.entX[soul];

    let crossed = false;
    for (let i = 0; i < 300 && !crossed; i++) {
      tick(a);
      if (a.sim.entActive[soul] !== 1) break;
      if (a.sim.entX[soul] > WALL_X + 1) crossed = true;
      // It must never be committed to breaking anything, ever.
      expect(a.horde.isBreaching(soul)).toBe(false);
    }
    expect(startX).toBeLessThan(WALL_X);
    expect(crossed).toBe(true);

    // The wall it crossed is untouched: still there, still at full health.
    expect(a.world.getBlock(WALL_X, FLOOR + 1, 12)).toBe(BlockId.STONE);
    const hp = a.horde.fort.hpAt(WALL_X, FLOOR + 1, 12);
    expect(hp === -1 || hp === fortHpFor(BlockId.STONE)).toBe(true);
    expect(a.horde.fort.breaches).toBe(0);
  });

  it('crosses the same three-high wall that pins a ground demon', () => {
    const a = buildArena(5151, true);
    run(a, 20);
    buildWall(a, DOOR_Z0, DOOR_Z1, 1);
    run(a, 20);
    expect(a.monsters.nav.distanceAt(6, 12)).toBe(-1);

    const soul = a.monsters.spawnAt(EntityType.LOST_SOUL, 6.5, FLOOR + 2.4, 12.5);
    let crossed = false;
    for (let i = 0; i < 400 && !crossed; i++) {
      tick(a);
      if (a.sim.entActive[soul] !== 1) break;
      if (a.sim.entX[soul] > WALL_X + 0.8) crossed = true;
    }
    expect(crossed).toBe(true);
    // Crossing is not chewing: every block of the wall is still standing.
    for (let z = DOOR_Z0; z <= DOOR_Z1; z++) {
      expect(a.world.getBlock(WALL_X, FLOOR + 1, z)).toBe(BlockId.STONE);
    }
    expect(a.horde.fort.breaches).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The economy — one wallet for walls and for guns
 * ------------------------------------------------------------------------ */

describe('horde economy', () => {
  it('charges credits for every placed block and registers it as fortification', () => {
    const a = buildArena(6001, true);
    run(a, 10);
    const before = a.horde.creditsOf(1);
    expect(before).toBe(HORDE_START_CREDITS);

    a.world.setBlock(30, FLOOR + 1, 12, BlockId.STONE, 1);
    tick(a);

    expect(a.horde.creditsOf(1)).toBe(before - blockCost(BlockId.STONE));
    const rec = a.horde.fort.get(30, FLOOR + 1, 12);
    expect(rec).toBeDefined();
    expect(rec?.owner).toBe(1);
    expect(rec?.hp).toBe(fortHpFor(BlockId.STONE));
  });

  it('reverts a placement the player cannot pay for', () => {
    const a = buildArena(6002, true);
    run(a, 10);
    // Obsidian is a keep, not a fence: 34 credits a block.
    const perBlock = blockCost(BlockId.OBSIDIAN);
    expect(perBlock).toBeGreaterThan(blockCost(BlockId.STONE));

    const affordable = Math.floor(HORDE_START_CREDITS / perBlock);
    for (let i = 0; i <= affordable; i++) {
      a.world.setBlock(28, FLOOR + 1 + i, 12, BlockId.OBSIDIAN, 1);
    }
    tick(a);

    // The last one could not be paid for and is gone again.
    expect(a.world.getBlock(28, FLOOR + 1 + affordable, 12)).toBe(BlockId.AIR);
    expect(a.world.getBlock(28, FLOOR + affordable, 12)).toBe(BlockId.OBSIDIAN);
    expect(a.horde.creditsOf(1)).toBeLessThan(perBlock);
  });

  it('a wall and a gun come out of the same pocket', () => {
    const a = buildArena(6003, true);
    run(a, 10);
    // 180 starting credits is nowhere near the 700-credit Rocket Launcher…
    expect(a.horde.onAction(1, 2 /* ModeAction.BUY */, HordeItem.WEAPON_ROCKET, 1, 1)).toBe(false);
    expect(a.horde.creditsOf(1)).toBe(HORDE_START_CREDITS);

    // …every block spent digs that hole deeper…
    a.world.setBlock(30, FLOOR + 1, 14, BlockId.METAL, 1);
    tick(a);
    expect(a.horde.creditsOf(1)).toBe(HORDE_START_CREDITS - blockCost(BlockId.METAL));

    // …and the shotgun you already own is only ever an ammo top-up.
    const before = a.horde.creditsOf(1);
    expect(a.horde.onAction(1, 2, HordeItem.WEAPON_SHOTGUN, 1, 2)).toBe(true);
    expect(a.horde.creditsOf(1)).toBeLessThan(before);
    expect(a.horde.creditsOf(1)).toBeGreaterThan(before - 200);
  });

  it('salvages part of a wall you take down yourself', () => {
    const a = buildArena(6004, true);
    run(a, 10);
    a.world.setBlock(30, FLOOR + 1, 16, BlockId.STONE, 1);
    tick(a);
    const afterPlace = a.horde.creditsOf(1);
    a.world.setBlock(30, FLOOR + 1, 16, BlockId.AIR, 1);
    tick(a);
    const afterBreak = a.horde.creditsOf(1);
    expect(afterBreak).toBeGreaterThan(afterPlace);
    expect(afterBreak).toBeLessThan(HORDE_START_CREDITS);
    expect(a.horde.fort.get(30, FLOOR + 1, 16)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The fortification ledger
 * ------------------------------------------------------------------------ */

describe('fort ledger', () => {
  it('prices hit points off block hardness', () => {
    expect(fortHpFor(BlockId.DIRT)).toBeLessThan(fortHpFor(BlockId.STONE));
    expect(fortHpFor(BlockId.STONE)).toBeLessThan(fortHpFor(BlockId.METAL));
    expect(fortHpFor(BlockId.METAL)).toBeLessThan(fortHpFor(BlockId.OBSIDIAN));
    expect(fortHpFor(BlockId.BEDROCK)).toBe(0);
  });

  it('takes damage down to a break and then forgets the block', () => {
    const fort = new FortLedger();
    const max = fortHpFor(BlockId.STONE);
    fort.register(1, 2, 3, BlockId.STONE, 7);
    expect(fort.hpAt(1, 2, 3)).toBe(max);
    expect(fort.damage(1, 2, 3, BlockId.STONE, 10)).toBe(max - 10);
    expect(fort.damage(1, 2, 3, BlockId.STONE, max)).toBe(0);
    expect(fort.hpAt(1, 2, 3)).toBe(-1);
    expect(fort.breaches).toBe(1);
  });

  it('quotes and applies a repair', () => {
    const fort = new FortLedger();
    fort.register(0, 8, 0, BlockId.STONE, 3);
    fort.damage(0, 8, 0, BlockId.STONE, 60);
    const quote = fort.repairQuote(0.5, 8.5, 0.5, 6, 3);
    expect(quote.blocks).toBe(1);
    expect(quote.cost).toBeGreaterThan(0);
    expect(fort.repairApply(0.5, 8.5, 0.5, 6, 3)).toBe(1);
    expect(fort.hpAt(0, 8, 0)).toBe(fortHpFor(BlockId.STONE));
    expect(fort.repairQuote(0.5, 8.5, 0.5, 6, 3).blocks).toBe(0);
  });

  it('keys every voxel in the arena uniquely', () => {
    const fort = new FortLedger();
    fort.register(-192, 0, -192, BlockId.STONE, 1);
    fort.register(223, 63, 223, BlockId.METAL, 1);
    fort.register(-192, 63, 223, BlockId.BRICK, 1);
    expect(fort.size).toBe(3);
    expect(fort.get(-192, 0, -192)?.blockId).toBe(BlockId.STONE);
    expect(fort.get(223, 63, 223)?.blockId).toBe(BlockId.METAL);
    expect(fort.get(-192, 63, 223)?.blockId).toBe(BlockId.BRICK);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The curve
 * ------------------------------------------------------------------------ */

describe('wave composition', () => {
  const c = createWaveComposition();

  it('is deterministic in (wave, skill, players, seed)', () => {
    const a = composeWave(9, 2, 2, 1234, createWaveComposition());
    const b = composeWave(9, 2, 2, 1234, createWaveComposition());
    expect(Array.from(a.count)).toEqual(Array.from(b.count));
    expect(a.gateMask).toBe(b.gateMask);
    expect(Array.from(a.order)).toEqual(Array.from(b.order));
  });

  it('grows in count, gates, burst and cadence together', () => {
    const w1 = composeWave(1, 2, 1, 7, createWaveComposition());
    const w6 = composeWave(6, 2, 1, 7, createWaveComposition());
    const w14 = composeWave(14, 2, 1, 7, createWaveComposition());
    expect(w1.total).toBeLessThan(w6.total);
    expect(w6.total).toBeLessThan(w14.total);
    expect(w1.gateCount).toBeLessThan(w14.gateCount);
    expect(w1.burst).toBeLessThanOrEqual(w14.burst);
    expect(w14.spawnIntervalMs).toBeLessThan(w1.spawnIntervalMs);
    expect(w1.aggression).toBeLessThan(w14.aggression);
    expect(w1.threat).toBeLessThan(w14.threat);
  });

  it('introduces the archetypes on a schedule instead of all at once', () => {
    composeWave(1, 2, 1, 7, c);
    expect(c.countOf(EntityType.IMP)).toBe(c.total);
    expect(c.hasFlyers).toBe(false);

    composeWave(2, 2, 1, 7, c);
    expect(c.countOf(EntityType.ZOMBIE)).toBeGreaterThan(0);

    composeWave(3, 2, 1, 7, c);
    expect(c.countOf(EntityType.LOST_SOUL)).toBeGreaterThan(0);

    composeWave(4, 2, 1, 7, c);
    expect(c.countOf(EntityType.CACODEMON)).toBeGreaterThan(0);
    expect(c.hasFlyers).toBe(true);
  });

  it('puts Barons on the boss cadence and orders a wave light-to-heavy', () => {
    expect(bossWave(4)).toBe(false);
    expect(bossWave(5)).toBe(true);
    expect(bossWave(10)).toBe(true);

    composeWave(5, 2, 1, 7, c);
    expect(c.boss).toBe(true);
    expect(c.countOf(EntityType.BARON)).toBeGreaterThan(0);
    expect(c.countOf(EntityType.BARON)).toBe(c.bossCount);

    // The heavy end of the wave arrives last: the average tier of the back half
    // is above the average tier of the front half.
    let front = 0;
    let back = 0;
    const half = c.total >> 1;
    for (let i = 0; i < half; i++) front += HORDE_ENEMIES[c.order[i]].tier;
    for (let i = half; i < c.total; i++) back += HORDE_ENEMIES[c.order[i]].tier;
    expect(back / Math.max(1, c.total - half)).toBeGreaterThan(front / Math.max(1, half));
  });

  it('never queues more than the caps allow', () => {
    for (let w = 1; w <= 120; w++) {
      composeWave(w, 4, 4, 31337, c);
      let sum = 0;
      for (let i = 0; i < c.count.length; i++) sum += c.count[i];
      expect(c.total).toBeGreaterThan(0);
      expect(c.total).toBeLessThanOrEqual(c.order.length);
      expect(sum).toBeGreaterThanOrEqual(c.total);
      expect(c.gateCount).toBeLessThanOrEqual(HORDE_GATE_COUNT);
      expect(c.aliveCap).toBeGreaterThan(0);
      expect(c.spawnIntervalMs).toBeGreaterThan(0);
    }
  });

  it('names the gates it lit', () => {
    composeWave(12, 2, 1, 99, c);
    const named = describeGates(c.gateMask);
    expect(named.length).toBeGreaterThan(0);
    let lit = 0;
    for (let g = 0; g < HORDE_GATE_COUNT; g++) if (gateIsHot(c.gateMask, g)) lit++;
    expect(lit).toBe(c.gateCount);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Wiring contracts the rest of the codebase relies on
 * ------------------------------------------------------------------------ */

describe('horde wiring', () => {
  it('mirrors sim.ts entity state bits exactly', () => {
    expect(ES_MOVING_BIT).toBe(ES_MOVING);
    expect(ES_ATTACK_BIT).toBe(ES_ATTACK);
    expect(ES_ALERT_BIT).toBe(ES_ALERT);
    expect(ES_WINDUP_BIT).toBe(ES_WINDUP);
  });

  it('describes the roster the client renders', () => {
    for (let t = 0; t < 5; t++) {
      const def = hordeEnemy(t);
      expect(def).toBeDefined();
      expect(def?.type).toBe(t);
      // Only the walkers can hurt geometry.
      if (def?.flying) expect(def.siegeDamage).toBe(0);
      else expect(def?.siegeDamage).toBeGreaterThan(0);
    }
    expect(hordeEnemy(EntityType.PICKUP_HEALTH)).toBeUndefined();
  });

  it('takes over spawning from the ambient monster director', () => {
    const a = buildArena(7007, true);
    expect(a.monsters.budget.target).toBe(0);
    run(a, 40);
    // Still in the fortify window, so nothing has been released yet.
    expect(a.horde.phase).toBe(ModePhase.BUILD);
    expect(a.monsters.liveCount).toBe(0);
    expect(a.horde.holdKnown).toBe(true);
  });

  it('runs a build phase, then a wave, then pays out and fortifies again', () => {
    const a = buildArena(7008, true);
    run(a, 20);
    expect(a.horde.phase).toBe(ModePhase.BUILD);
    expect(a.horde.wave).toBe(0);

    // Ready up rather than waiting out the 48 s first window.
    a.horde.onAction(1, 1 /* ModeAction.READY */, 0, 0, 1);
    run(a, 30);
    expect(a.horde.phase).toBe(ModePhase.LIVE);
    expect(a.horde.wave).toBe(1);

    // Wave 1 is imps and they are queued, not dumped.
    run(a, 60);
    expect(a.horde.aliveMonsters).toBeGreaterThan(0);
    expect(a.horde.aliveMonsters).toBeLessThanOrEqual(a.horde.composition.aliveCap);
    for (let i = 0; i < a.sim.entCapacity; i++) {
      if (a.sim.entActive[i] !== 1) continue;
      if (a.sim.entType[i] >= EntityType.PICKUP_HEALTH) continue;
      expect(a.sim.entType[i]).toBe(EntityType.IMP);
      // Spawn validation: nothing materialises on top of the hold.
      const dx = a.sim.entX[i] - a.horde.holdX;
      const dz = a.sim.entZ[i] - a.horde.holdZ;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(12);
    }
  });

  it('emits a state sidecar only when something changed', () => {
    const a = buildArena(7009, true);
    run(a, 4);
    const first = a.horde.composeState(1);
    expect(first).not.toBeNull();
    expect(first?.modeId).toBe(ModeId.HORDE);
    expect(first?.budget).toBe(HORDE_START_CREDITS);
    // Same tick, nothing moved: no second packet.
    expect(a.horde.composeState(1)).toBeNull();
    expect(a.horde.composeState(999)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * The loadout reads the room's arsenal
 *
 * `equipStart` runs on the JOIN path, after `spawnPlayer` has already filled
 * the magazines, and it refilled them from the compiled table. That is outside
 * both predictors, so the V1 seam refactor did not touch it and the lockstep
 * golden could never have noticed: a shotgun variant that pays for its damage
 * with a smaller magazine entered Horde holding the BASE's eight shells and
 * never paid the drawback at all.
 *
 * The test only means anything with a variant installed — with zero variants
 * `statsFor(p, i).magSize` and `getWeapon(i).magSize` are the same number, and
 * an assertion on the base is a test that cannot fail.
 * ------------------------------------------------------------------------ */

describe('the horde loadout', () => {
  function hordeWithArsenal(arsenal: SessionArsenal, slot: number) {
    const seed = 4242;
    const world = new ServerWorld(seed);
    for (let z = Z0; z <= Z1; z++) {
      for (let x = X0; x <= X1; x++) column(world, x, z, FLOOR, FLOOR);
    }
    const sim = new Simulation(world, seed, arsenal);
    sim.lagCompensation = false;
    const monsters = new MonsterManager(sim, seed);
    const plan = resolveModePlan(joinRequestFor(ModeId.HORDE, '', '', 2, seed));
    const horde = new HordeDirector({ sim, monsters, plan, seed });
    const p = sim.addPlayer(1, 'Holder', 0, false);
    p.variantSlots.fill(slot);
    sim.spawnPlayer(p);
    horde.addPlayer(1);
    return p;
  }

  it('fills the starting magazine from the ROOM\'s arsenal, not the compiled table', () => {
    const half = Math.floor(WEAPONS[WeaponId.SHOTGUN].magSize / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).not.toBe(getWeapon(WeaponId.SHOTGUN).magSize);

    const arsenal = SessionArsenal.from([
      { id: 'shotgun-drum', base: WeaponId.SHOTGUN, over: { magSize: half } },
    ]);
    const p = hordeWithArsenal(arsenal, 1);
    expect(p.mag[WeaponId.SHOTGUN]).toBe(half);
  });

  it('still gives the compiled magazine when no variant is equipped', () => {
    const arsenal = SessionArsenal.from([
      { id: 'shotgun-drum', base: WeaponId.SHOTGUN, over: { magSize: 3 } },
    ]);
    const p = hordeWithArsenal(arsenal, 0);
    expect(p.mag[WeaponId.SHOTGUN]).toBe(getWeapon(WeaponId.SHOTGUN).magSize);
  });
});

/* ------------------------------------------------------------------------ *
 * The SHOP reads the room's arsenal too
 *
 * `equipStart` is one of two places in this file that fills a magazine, and the
 * test above nails it down. `deliver` is the other one, on the shop path, and
 * it had no test at all: a weapon bought mid-run is granted and its magazine is
 * filled right there, and if that fill reads the compiled table then a variant
 * that pays for its damage with a smaller magazine hands the drawback back the
 * moment the player buys the gun instead of starting with it. Same bug, second
 * door, and the first test cannot see through it — `equipStart` only ever
 * touches weapons in `startWeaponMask`, and the shop's whole point is the ones
 * that are not.
 *
 * WHY THIS IS NOT THE OBVIOUS TEST. The obvious test buys the SHOTGUN and looks
 * at the magazine. It is green with the fix reverted, and it is worth spelling
 * out why, because it looks completely convincing while it runs:
 *
 *   Horde's `startWeaponMask` is `STARTING_WEAPON_MASK | (1 << SHOTGUN)`. The
 *   player already OWNS the shotgun. `buy` sees that and quarter-prices it, and
 *   `deliver`'s weapon branch is guarded by `!ownsWeapon(...)` — so the line
 *   under test never runs. The purchase still returns true off the ammo branch,
 *   credits still go down, the shell reserve still goes up, and the magazine
 *   still reads whatever `equipStart` put there, which is the variant's number,
 *   because the OTHER fix — the one that is already tested — put it there. The
 *   assertion passes by borrowing another line's correctness. Every observable
 *   in that version (purchase result, credits, reserve, magazine) is identical
 *   with the delivery fix present and reverted. It is a test that cannot fail.
 *
 * So this one buys a weapon the player does NOT own: the chaingun. That forces
 * the `!ownsWeapon` branch, which is the only door to the line, and it starts
 * from `mag[CHAINGUN] === 0` so the number that ends up there can only have
 * been written by `deliver`. The unowned chaingun costs 350 against 180 start
 * credits, which is its own trap: without the grant below, `buy` breaks out of
 * the loop, `bought` stays 0, `buy` returns false, and every assertion after a
 * `toBe(false)` is describing a purchase that never happened. Hence the
 * unconditional `toBe(true)` before the magazine is ever looked at.
 *
 * And, as above: with no variant resolved, `statsFor(p, i).magSize` and
 * `getWeapon(i).magSize` are the same number and the assertion cannot fail. The
 * setup asserts the variant really resolved before it asserts anything else.
 * ------------------------------------------------------------------------ */

describe('the horde shop', () => {
  function shopWithArsenal(arsenal: SessionArsenal, slot: number) {
    const seed = 4243;
    const world = new ServerWorld(seed);
    for (let z = Z0; z <= Z1; z++) {
      for (let x = X0; x <= X1; x++) column(world, x, z, FLOOR, FLOOR);
    }
    const sim = new Simulation(world, seed, arsenal);
    sim.lagCompensation = false;
    const monsters = new MonsterManager(sim, seed);
    const plan = resolveModePlan(joinRequestFor(ModeId.HORDE, '', '', 2, seed));
    const horde = new HordeDirector({ sim, monsters, plan, seed });
    const p = sim.addPlayer(1, 'Buyer', 0, false);
    p.variantSlots.fill(slot);
    sim.spawnPlayer(p);
    horde.addPlayer(1);
    return { sim, horde, p };
  }

  /**
   * `creditsOf` is a getter and there is no public setter — the production
   * wallet is only ever moved by `pay`, off kills, wave clears and purchases.
   * Earning 350 credits through kills would drag a live wave, the shadow-kill
   * attribution and the wave-number payout multiplier into a test about a
   * magazine, and every one of those is a way for the setup to quietly not
   * happen. So the run record is written directly, and the write is checked
   * through the public getter on the next line: if the private shape ever moves,
   * this throws or the `toBe` fails, rather than the test silently sliding into
   * the "cannot afford it" hole described above.
   *
   * It does not weaken anything. Credits are the GATE that lets `buy` reach
   * `deliver`; they are not the claim. The claim is the number in the magazine,
   * and the purchase still goes through the real `buy` -> `deliver` path at the
   * real 350-credit price, which the credit assertion below proves it paid.
   */
  function grantCredits(horde: HordeDirector, id: number, credits: number): void {
    const runs = (horde as unknown as { players: Map<number, { credits: number }> }).players;
    const run = runs.get(id);
    if (run === undefined) throw new Error('no run record for player ' + id);
    run.credits = credits;
  }

  it('fills a BOUGHT weapon\'s magazine from the ROOM\'s arsenal, not the compiled table', () => {
    const half = Math.floor(WEAPONS[WeaponId.CHAINGUN].magSize / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).not.toBe(getWeapon(WeaponId.CHAINGUN).magSize);

    const arsenal = SessionArsenal.from([
      { id: 'chaingun-short-belt', base: WeaponId.CHAINGUN, over: { magSize: half } },
    ]);
    const { sim, horde, p } = shopWithArsenal(arsenal, 1);

    // The setup really did resolve the variant — otherwise the assertion at the
    // bottom is an assertion about the base and cannot fail.
    expect(sim.statsFor(p, WeaponId.CHAINGUN).magSize).toBe(half);
    // …and the shop path is genuinely the only way this magazine gets filled.
    expect(ownsWeapon(p.weaponMask, WeaponId.CHAINGUN)).toBe(false);
    expect(p.mag[WeaponId.CHAINGUN]).toBe(0);

    const price = HORDE_SHOP[HordeItem.WEAPON_CHAINGUN].price;
    expect(price).toBeGreaterThan(HORDE_START_CREDITS);
    const wallet = price + 150;
    grantCredits(horde, 1, wallet);
    expect(horde.creditsOf(1)).toBe(wallet);

    // Unconditional: a refused purchase would leave the magazine at 0 and every
    // later assertion would be describing something that never happened.
    expect(horde.onAction(1, ModeAction.BUY, HordeItem.WEAPON_CHAINGUN, 1, 1)).toBe(true);
    expect(ownsWeapon(p.weaponMask, WeaponId.CHAINGUN)).toBe(true);
    expect(horde.creditsOf(1)).toBe(wallet - price);

    // The line under test. Base is 100, this room's chaingun holds `half`.
    expect(p.mag[WeaponId.CHAINGUN]).toBe(half);
  });
});
