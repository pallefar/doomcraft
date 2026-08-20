/**
 * DOOMCRAFT — HORDE: the client economy, against the real server.
 *
 * `server/src/horde.test.ts` proves the mode's mechanics: a wall across the
 * only approach is repathed around or chewed through, its hit points go down,
 * a flyer ignores it, and a placement nobody can pay for is reverted. This file
 * proves the other half of the contract — that the CLIENT's copy of the economy
 * says the same things the server does.
 *
 * That matters because `economy.ts` is a prediction layer. Its whole purpose is
 * to grey the ghost out a frame before the click instead of letting the server
 * revert a block a hundred milliseconds after it appeared, and a prediction
 * that disagrees with the authority is worse than no prediction at all. Most of
 * the agreement is structural — the price table, the wave curve and the roster
 * are *imported* from `server/src/horde.ts`, so they cannot drift — but three
 * things could:
 *
 *   1. the monster health table, mirrored because `bots.ts` drags the whole
 *      simulation into the page bundle;
 *   2. `carveSphere`'s hardness ceiling, which is module-private in
 *      `world.ts` and is the entire reason obsidian is worth 6.2x stone;
 *   3. the placement rules, reimplemented from `ServerWorld.validateEdit` and
 *      `Simulation.requestEdit`.
 *
 * All three are pinned here against the real server code, and the last one is
 * checked end to end: the client quotes a price, the block goes down, and the
 * director charges exactly what was quoted.
 */

import { describe, expect, it } from 'vitest';

import {
  BLOCK_HARDNESS,
  BlockId,
  CHUNK_HEIGHT,
  EntityType,
  STARTING_WEAPON_MASK,
  TICK_MS,
  WeaponId,
} from '@shared';
import { ModeId } from '@shared/modes';

import { MONSTERS, MonsterManager } from '@doomcraft/server/src/bots.js';
import {
  HORDE_COMBAT_PREMIUM,
  HORDE_START_CREDITS,
  HordeDirector,
  blockCost,
  composeWave,
  createWaveComposition,
  fortHpFor,
} from '@doomcraft/server/src/horde.js';
import { joinRequestFor, resolveModePlan } from '@doomcraft/server/src/modes.js';
import { Simulation } from '@doomcraft/server/src/sim.js';
import { ServerWorld } from '@doomcraft/server/src/world.js';

import {
  BLASTPROOF_HARDNESS,
  BLOCKS_PER_GATE,
  HORDE_ENEMY_HEALTH,
  PLACE_BROKE,
  PLACE_IN_BODY,
  PLACE_OCCUPIED,
  PLACE_OK,
  PlacementPricer,
  WALL_STOCK,
  bestDps,
  blocksFor,
  createTradeReadout,
  evaluateTrade,
  gatesClosable,
  hordeDps,
  wallOptionOf,
  waveHitPoints,
} from './economy';

/* ------------------------------------------------------------------------ *
 * A flat room, so the geometry is exactly what the assertions say it is.
 * ------------------------------------------------------------------------ */

const FLOOR = 6;

function flatArena(seed: number): {
  world: ServerWorld;
  sim: Simulation;
  horde: HordeDirector;
} {
  const world = new ServerWorld(seed);
  for (let z = -4; z <= 28; z++) {
    for (let x = -4; x <= 44; x++) {
      for (let y = CHUNK_HEIGHT - 1; y > FLOOR; y--) {
        if (world.getBlock(x, y, z) !== BlockId.AIR) world.setBlock(x, y, z, BlockId.AIR, 0);
      }
      for (let y = 1; y <= FLOOR; y++) {
        if (world.getBlock(x, y, z) !== BlockId.STONE) world.setBlock(x, y, z, BlockId.STONE, 0);
      }
    }
  }
  world.journal.reset();

  const sim = new Simulation(world, seed);
  sim.lagCompensation = false;
  const monsters = new MonsterManager(sim, seed);
  const plan = resolveModePlan(joinRequestFor(ModeId.HORDE, '', '', 2, seed));
  const horde = new HordeDirector({ sim, monsters, plan, seed });

  const p = sim.addPlayer(1, 'Holder', 0, false);
  horde.addPlayer(1);
  p.pos[0] = 20.5; p.pos[1] = FLOOR + 1; p.pos[2] = 12.5;
  p.dead = false;
  p.onGround = true;
  p.spawnProtectUntilMs = sim.nowMs + 3_600_000;
  p.pushHistory(sim.nowMs);

  // Let the director find its hold point and open the fortify window.
  for (let i = 0; i < 10; i++) {
    sim.beginTick(TICK_MS);
    monsters.step(TICK_MS);
    sim.stepTick(TICK_MS);
    horde.step(TICK_MS);
    sim.clearEvents();
    world.journal.reset();
  }
  return { world, sim, horde };
}

function tickOnce(a: { world: ServerWorld; sim: Simulation; horde: HordeDirector }): void {
  a.sim.beginTick(TICK_MS);
  a.sim.stepTick(TICK_MS);
  a.horde.step(TICK_MS);
  a.sim.clearEvents();
  a.world.journal.reset();
}

/* ------------------------------------------------------------------------ *
 * 1. The two mirrored numbers
 * ------------------------------------------------------------------------ */

describe('numbers the client had to copy', () => {
  it('mirrors the monster health table that lives in bots.ts', () => {
    expect(HORDE_ENEMY_HEALTH.length).toBe(MONSTERS.length);
    for (const m of MONSTERS) {
      expect(HORDE_ENEMY_HEALTH[m.type]).toBe(m.health);
    }
  });

  it('is right that obsidian is the only wall in the palette a rocket cannot open', () => {
    // `ServerWorld.carveSphere` skips anything harder than a ceiling it keeps
    // to itself. The client mirrors that ceiling to print BLASTPROOF on one
    // row, so the label is proved with an actual blast, not with the constant.
    const a = flatArena(9101);
    const y = FLOOR + 1;
    a.world.setBlock(10, y, 10, BlockId.OBSIDIAN, 1);
    a.world.setBlock(11, y, 10, BlockId.METAL, 1);
    a.world.carveSphere(11.0, y + 0.5, 10.5, 3, 0);

    expect(a.world.getBlock(10, y, 10)).toBe(BlockId.OBSIDIAN);
    expect(a.world.getBlock(11, y, 10)).toBe(BlockId.AIR);

    for (const opt of WALL_STOCK) {
      expect(opt.blastproof).toBe(BLOCK_HARDNESS[opt.blockId] > BLASTPROOF_HARDNESS);
    }
    expect(WALL_STOCK.filter((o) => o.blastproof).map((o) => o.blockId)).toEqual([BlockId.OBSIDIAN]);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The trade the mode is made of
 * ------------------------------------------------------------------------ */

describe('one purse, two doors', () => {
  it('prices a gate of wall in the same currency as a gun', () => {
    const stone = wallOptionOf(BlockId.STONE);
    const obsidian = wallOptionOf(BlockId.OBSIDIAN);
    expect(stone).toBeDefined();
    expect(obsidian).toBeDefined();
    if (stone === undefined || obsidian === undefined) return;

    // Same credits, very different shapes: obsidian buys far fewer blocks, and
    // each one costs a Baron several more swings. That asymmetry is the choice.
    expect(blocksFor(700, stone, false)).toBeGreaterThan(blocksFor(700, obsidian, false) * 5);
    expect(obsidian.baronSwings).toBeGreaterThan(stone.baronSwings * 2);
    expect(obsidian.gateCost).toBeGreaterThan(stone.gateCost * 5);

    // A gate is a real, finite number of blocks, not a hand-wave.
    expect(BLOCKS_PER_GATE).toBeGreaterThan(12);
    expect(stone.gateCost).toBe(stone.cost * BLOCKS_PER_GATE);

    // 700 credits — a Rocket Launcher — is a few gates of stone and a fraction
    // of one gate of obsidian. Both ends of that are decisions.
    expect(gatesClosable(700, stone)).toBeGreaterThan(1);
    expect(gatesClosable(700, obsidian)).toBeLessThan(1.5);

    // Building while the wave is live costs the premium the director charges.
    expect(blocksFor(100, stone, true)).toBe(Math.floor(100 / (stone.cost * HORDE_COMBAT_PREMIUM)));
  });

  it('rates a wave weapon by what it does to a wave, not to one demon', () => {
    // The Chainsaw is the second highest single-target DPS in the game and is
    // worth nothing against nineteen demons at four gates, so it scores zero.
    expect(hordeDps(WeaponId.CHAINSAW)).toBe(0);
    // Splash is what a 700- and a 2200-credit gun are for.
    expect(hordeDps(WeaponId.ROCKET)).toBeGreaterThan(hordeDps(WeaponId.CHAINGUN) * 2);
    expect(hordeDps(WeaponId.BFG)).toBeGreaterThan(hordeDps(WeaponId.ROCKET));
    // A run starts on pistol + chainsaw + shotgun, and none of them is a BFG.
    const start = STARTING_WEAPON_MASK | (1 << WeaponId.SHOTGUN);
    expect(bestDps(start)).toBeGreaterThan(0);
    expect(bestDps(start)).toBeLessThan(hordeDps(WeaponId.ROCKET));
  });

  it('leans to walls when broke on the ground and to guns when the wave has wings', () => {
    const trade = createTradeReadout();
    const stone = wallOptionOf(BlockId.STONE);
    if (stone === undefined) return;
    const start = STARTING_WEAPON_MASK | (1 << WeaponId.SHOTGUN);

    // Wave 2 is ground only, and 60 credits will not close two gates.
    const early = composeWave(2, 2, 1, 4242, createWaveComposition());
    expect(early.hasFlyers).toBe(false);
    evaluateTrade(60, early, start, stone, trade);
    expect(trade.lean).toBe(-1);
    expect(trade.line).toContain('gates');

    // A wave whose hit points are mostly airborne cannot be walled at all, and
    // the gun it names has to be a real improvement on what you already hold.
    const flying = createWaveComposition();
    composeWave(12, 2, 1, 4242, flying);
    flying.count.fill(0);
    flying.count[EntityType.CACODEMON] = 10;
    flying.count[EntityType.IMP] = 1;
    flying.total = 11;
    evaluateTrade(900, flying, start, stone, trade);
    expect(trade.flyers).toBeGreaterThan(0.9);
    expect(trade.lean).toBe(1);
    expect(trade.gunId).toBe(WeaponId.ROCKET);
    expect(trade.ttkWithGun).toBeLessThan(trade.ttkNow);

    // And when the purse genuinely covers both it says so rather than
    // manufacturing a dilemma.
    evaluateTrade(9999, early, start, stone, trade);
    expect(trade.lean).toBe(0);
    expect(trade.line.startsWith('Both')).toBe(true);
  });

  it('measures a wave in hit points the same way the roster does', () => {
    const c = composeWave(6, 2, 1, 77, createWaveComposition());
    let expected = 0;
    for (let i = 0; i < HORDE_ENEMY_HEALTH.length; i++) expected += c.countOf(i) * HORDE_ENEMY_HEALTH[i];
    expect(waveHitPoints(c)).toBe(expected);
    expect(waveHitPoints(c)).toBeGreaterThan(waveHitPoints(composeWave(2, 2, 1, 77, createWaveComposition())));
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The placement rules, against the ones that actually run
 * ------------------------------------------------------------------------ */

describe('the ghost refuses what the server would revert', () => {
  const ground = (_x: number, y: number, _z: number): number =>
    (y <= FLOOR ? BlockId.STONE : BlockId.AIR);

  it('quotes, refuses and prices exactly like the director', () => {
    const pricer = new PlacementPricer();

    // Looking straight down from three blocks up: the block goes on the floor.
    const rich = pricer.solve(
      10.5, FLOOR + 3, 10.5, 0, -1, 0, ground,
      30.5, FLOOR + 1, 30.5,
      BlockId.STONE, HORDE_START_CREDITS, false, false,
    );
    expect(rich.ok).toBe(true);
    expect(rich.refusal).toBe(PLACE_OK);
    expect(rich.y).toBe(FLOOR + 1);
    expect(rich.cost).toBe(blockCost(BlockId.STONE));
    expect(rich.hp).toBe(fortHpFor(BlockId.STONE));

    // One credit short of the server's own price, said BEFORE the block is
    // sent. That is the entire point of mirroring the rule.
    const broke = pricer.solve(
      10.5, FLOOR + 3, 10.5, 0, -1, 0, ground,
      30.5, FLOOR + 1, 30.5,
      BlockId.STONE, blockCost(BlockId.STONE) - 1, false, false,
    );
    expect(broke.ok).toBe(false);
    expect(broke.refusal).toBe(PLACE_BROKE);

    // Mid-wave the same block costs the premium, and the same balance fails.
    const midWave = pricer.solve(
      10.5, FLOOR + 3, 10.5, 0, -1, 0, ground,
      30.5, FLOOR + 1, 30.5,
      BlockId.STONE, blockCost(BlockId.STONE), true, false,
    );
    expect(midWave.cost).toBe(blockCost(BlockId.STONE) * HORDE_COMBAT_PREMIUM);
    expect(midWave.refusal).toBe(PLACE_BROKE);

    // `Simulation.requestEdit` refuses a block inside a living body; so does
    // the ghost, which is the difference between a wall and a coffin.
    const inBody = pricer.solve(
      10.5, FLOOR + 3, 10.5, 0, -1, 0, ground,
      10.5, FLOOR + 1, 10.5,
      BlockId.STONE, HORDE_START_CREDITS, false, false,
    );
    expect(inBody.ok).toBe(false);
    expect(inBody.refusal).toBe(PLACE_IN_BODY);

    // A corpse builds nothing, and neither does a ray that leaves the world.
    const dead = pricer.solve(
      10.5, FLOOR + 3, 10.5, 0, -1, 0, ground,
      30.5, FLOOR + 1, 30.5,
      BlockId.STONE, HORDE_START_CREDITS, false, true,
    );
    expect(dead.ok).toBe(false);
  });

  it('refuses a cell that is already solid', () => {
    const pricer = new PlacementPricer();
    const filled = (_x: number, y: number, _z: number): number =>
      (y <= FLOOR + 1 ? BlockId.STONE : BlockId.AIR);
    // Aim upward at the underside of the ceiling block: the free face points
    // down, into more stone.
    const q = pricer.solve(
      10.5, FLOOR + 4, 10.5, 0, -1, 0, filled,
      30.5, FLOOR + 6, 30.5,
      BlockId.STONE, HORDE_START_CREDITS, false, false,
    );
    expect(q.hasHit).toBe(true);
    expect(q.ok).toBe(true);
    const under = pricer.solve(
      10.5, FLOOR - 2, 10.5, 0, 1, 0, filled,
      30.5, FLOOR + 6, 30.5,
      BlockId.STONE, HORDE_START_CREDITS, false, false,
    );
    expect(under.ok).toBe(false);
    expect(under.refusal).toBe(PLACE_OCCUPIED);
  });

  it('charges what it quoted, to the credit, through the real director', () => {
    const a = flatArena(9102);
    const before = a.horde.creditsOf(1);
    expect(before).toBe(HORDE_START_CREDITS);

    const pricer = new PlacementPricer();
    const world = a.world;
    const sample = (x: number, y: number, z: number): number => world.getBlock(x, y, z);
    const quote = pricer.solve(
      26.5, FLOOR + 4, 12.5, 0, -1, 0, sample,
      20.5, FLOOR + 1, 12.5,
      BlockId.STONE, before, false, false,
    );
    expect(quote.ok).toBe(true);

    world.setBlock(quote.x, quote.y, quote.z, BlockId.STONE, 1);
    tickOnce(a);

    expect(a.horde.creditsOf(1)).toBe(before - quote.cost);
    expect(a.horde.fort.hpAt(quote.x, quote.y, quote.z)).toBe(quote.hp);
  });

  it('and the block it could not pay for never survives the tick', () => {
    const a = flatArena(9103);
    const pricer = new PlacementPricer();
    const world = a.world;
    const sample = (x: number, y: number, z: number): number => world.getBlock(x, y, z);

    // Drain the wallet down to less than one obsidian block, then have the
    // client quote one. It refuses — and so, independently, does the server.
    const perBlock = blockCost(BlockId.OBSIDIAN);
    const affordable = Math.floor(HORDE_START_CREDITS / perBlock);
    for (let i = 0; i < affordable; i++) {
      world.setBlock(30, FLOOR + 1 + i, 12, BlockId.OBSIDIAN, 1);
    }
    tickOnce(a);
    const left = a.horde.creditsOf(1);
    expect(left).toBeLessThan(perBlock);

    const quote = pricer.solve(
      26.5, FLOOR + 4, 16.5, 0, -1, 0, sample,
      20.5, FLOOR + 1, 12.5,
      BlockId.OBSIDIAN, left, false, false,
    );
    expect(quote.ok).toBe(false);
    expect(quote.refusal).toBe(PLACE_BROKE);

    // Send it anyway, the way a desynced client would.
    world.setBlock(quote.x, quote.y, quote.z, BlockId.OBSIDIAN, 1);
    tickOnce(a);
    expect(world.getBlock(quote.x, quote.y, quote.z)).toBe(BlockId.AIR);
    expect(a.horde.creditsOf(1)).toBe(left);
  });
});
