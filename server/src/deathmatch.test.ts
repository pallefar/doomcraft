/**
 * DOOMCRAFT — Deathmatch director tests.
 *
 * Three claims, and they are the three the mode is sold on:
 *
 *   1. **Click-to-playable.** A room with zero humans in it is already a
 *      populated, furnished, scoring match. This is the answer to the bar's
 *      twenty-five second "Waiting for players...(2/50)" screen, so it is the
 *      first thing that gets asserted.
 *   2. **A human replaces a bot.** Joining mid-round takes a bot's seat, not a
 *      new one, and the round it joins is not disturbed: same round number,
 *      same clock, same body count, same scores on everyone else.
 *   3. **Pickups respawn on their timer and cannot be double-taken.** Two
 *      bodies standing on the same medikit produce exactly one heal.
 *
 * Everything runs twice where it matters: once against a hand-built fake sim
 * (fast, exact) and once against the real `Simulation` + `ServerWorld`, which
 * is what proves the structural interfaces in `deathmatch.ts` describe the real
 * engine and not a wish.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AMMO_START,
  AMMO_TYPE_COUNT,
  AmmoType,
  EntityType,
  MAX_ARMOR,
  MAX_HEALTH,
  RESPAWN_DELAY_MS,
  STARTING_WEAPON_MASK,
  TICK_MS,
  WEAPON_COUNT,
  ownsWeapon,
} from '@doomcraft/shared';
import { ModeId, ModePhase } from '@doomcraft/shared/modes';

import {
  DM_AUTO_RESPAWN_MS,
  DM_INTERMISSION_MS,
  DeathmatchDirector,
  DmPhase,
  DmPickupField,
  DmTake,
  applyPickupTo,
  pickupRespawnMs,
  type DmBody,
  type DmSim,
  type DmWorld,
} from './deathmatch.js';
import { createModeRoomState, joinRequestFor, resolveModePlan } from './modes.js';
import { Simulation } from './sim.js';
import { ServerWorld } from './world.js';

/* ------------------------------------------------------------------------ *
 * A fake simulation
 *
 * Small enough to reason about, faithful enough that the director cannot tell:
 * bodies are real records with the real fields, and the entity table behaves
 * like the real struct-of-arrays one.
 * ------------------------------------------------------------------------ */

class FakeBody implements DmBody {
  name = '';
  isBot = false;
  active = true;
  dead = false;
  health = MAX_HEALTH;
  armor = 0;
  weapon = 0;
  weaponMask = STARTING_WEAPON_MASK;
  kills = 0;
  deaths = 0;
  streak = 0;
  bestStreak = 0;
  damageDealt = 0;
  respawnAtMs = 0;
  spawnProtectUntilMs = 0;
  rttMs = 0;
  readonly pos = new Float64Array(3);
  readonly mag = new Uint16Array(WEAPON_COUNT);
  readonly reserve = new Uint16Array(AMMO_TYPE_COUNT);

  constructor(public id: number) {
    this.reserve.set(AMMO_START);
  }
}

const FAKE_ENT_CAPACITY = 64;

class FakeSim implements DmSim {
  nowMs = 0;
  readonly players: FakeBody[] = [];
  readonly entCapacity = FAKE_ENT_CAPACITY;
  readonly entActive = new Uint8Array(FAKE_ENT_CAPACITY);
  readonly entId = new Uint16Array(FAKE_ENT_CAPACITY);
  readonly entType = new Uint8Array(FAKE_ENT_CAPACITY);
  readonly entVariant = new Uint8Array(FAKE_ENT_CAPACITY);
  readonly entX = new Float64Array(FAKE_ENT_CAPACITY);
  readonly entY = new Float64Array(FAKE_ENT_CAPACITY);
  readonly entZ = new Float64Array(FAKE_ENT_CAPACITY);

  spawns = 0;
  private byId = new Map<number, FakeBody>();
  private nextEnt = 1;

  getPlayer(id: number): FakeBody | undefined { return this.byId.get(id); }

  addPlayer(id: number, name: string, _skin: number, isBot: boolean): FakeBody {
    const b = new FakeBody(id);
    b.name = name;
    b.isBot = isBot;
    this.players.push(b);
    this.byId.set(id, b);
    this.spawnPlayer(b);
    return b;
  }

  removePlayer(id: number): void {
    const b = this.byId.get(id);
    if (b === undefined) return;
    this.byId.delete(id);
    const i = this.players.indexOf(b);
    if (i >= 0) this.players.splice(i, 1);
    b.active = false;
  }

  spawnPlayer(p: DmBody): void {
    this.spawns++;
    p.dead = false;
    p.health = MAX_HEALTH;
    p.armor = 0;
    p.respawnAtMs = 0;
  }

  spawnPickup(type: number, x: number, y: number, z: number, variant: number): number {
    for (let i = 0; i < FAKE_ENT_CAPACITY; i++) {
      if (this.entActive[i] === 1) continue;
      this.entActive[i] = 1;
      this.entId[i] = this.nextEnt++;
      this.entType[i] = type;
      this.entVariant[i] = variant;
      this.entX[i] = x; this.entY[i] = y; this.entZ[i] = z;
      return i;
    }
    return -1;
  }

  removeEntity(slot: number, _reason: number): void {
    if (slot < 0 || slot >= FAKE_ENT_CAPACITY) return;
    this.entActive[slot] = 0;
  }

  /** Slot of a live pickup by entity id, or -1. Test helper. */
  slotOf(entityId: number): number {
    for (let i = 0; i < FAKE_ENT_CAPACITY; i++) {
      if (this.entActive[i] === 1 && this.entId[i] === entityId) return i;
    }
    return -1;
  }

  liveEntities(): number {
    let n = 0;
    for (let i = 0; i < FAKE_ENT_CAPACITY; i++) if (this.entActive[i] === 1) n++;
    return n;
  }
}

/** A flat, fully known world so the pickup layout always succeeds. */
const FLAT_WORLD: DmWorld = {
  standableY: (): number => 30,
  surfaceKnown: (): number => 29,
};

function makePlan(overrides: Parameters<typeof resolveModePlan>[1] = {}) {
  return resolveModePlan(joinRequestFor(ModeId.DEATHMATCH), overrides);
}

function makeDirector(opts: {
  botFill?: number;
  pickupCount?: number;
  durationMs?: number;
  scoreLimit?: number;
  maxPlayers?: number;
} = {}): { dir: DeathmatchDirector; sim: FakeSim; botsAdded: number[]; botsRemoved: number[] } {
  const sim = new FakeSim();
  const botsAdded: number[] = [];
  const botsRemoved: number[] = [];
  const dir = new DeathmatchDirector({
    plan: makePlan(),
    sim,
    world: FLAT_WORLD,
    seed: 1337,
    botFill: opts.botFill ?? 6,
    pickupCount: opts.pickupCount ?? 12,
    durationMs: opts.durationMs,
    scoreLimit: opts.scoreLimit,
    maxPlayers: opts.maxPlayers,
    onBotAdded: (id): void => { botsAdded.push(id); },
    onBotRemoved: (id): void => { botsRemoved.push(id); },
  });
  return { dir, sim, botsAdded, botsRemoved };
}

/** Advance both the director and the fake sim clock by `ms`, one tick at a time. */
function advance(dir: DeathmatchDirector, sim: FakeSim, ms: number): void {
  const ticks = Math.max(1, Math.round(ms / TICK_MS));
  for (let i = 0; i < ticks; i++) {
    sim.nowMs += TICK_MS;
    dir.step(TICK_MS);
  }
}

/* ------------------------------------------------------------------------ *
 * 1. Click-to-playable
 * ------------------------------------------------------------------------ */

describe('click-to-playable', () => {
  it('start() leaves a populated, furnished match with zero humans present', () => {
    const { dir, sim, botsAdded } = makeDirector({ botFill: 6, pickupCount: 12 });

    expect(dir.bodyCount).toBe(0);
    dir.start();

    // Populated: six bodies exist and every one of them is a bot.
    expect(dir.humanCount).toBe(0);
    expect(dir.botCount).toBe(6);
    expect(dir.bodyCount).toBe(6);
    expect(sim.players.length).toBe(6);
    expect(botsAdded.length).toBe(6);
    expect(sim.players.every((p) => p.isBot)).toBe(true);

    // Furnished: every pickup spot exists AND is on the floor as a live entity.
    expect(dir.pickups.count).toBe(12);
    expect(dir.pickups.availableCount).toBe(12);
    expect(sim.liveEntities()).toBe(12);

    // Playable, but the round clock has not started for an audience of bots.
    expect(dir.phase).toBe(DmPhase.WARMUP);
    expect(dir.round).toBe(0);
    expect(dir.timeLeftMs).toBe(dir.durationMs);
  });

  it('holds the clock and never ends the round while nobody is watching', () => {
    const { dir, sim } = makeDirector({ botFill: 4, durationMs: 4000, scoreLimit: 3 });
    dir.start();

    // Bots trade frags for well past both the clock and the frag limit.
    sim.players[0].kills = 99;
    advance(dir, sim, 30_000);

    expect(dir.phase).toBe(DmPhase.WARMUP);
    expect(dir.round).toBe(0);
    expect(dir.timeLeftMs).toBe(4000);
    expect(dir.matchOver).toBe(false);
    // …and it is still populated, so the first human still walks into a fight.
    expect(dir.botCount).toBe(4);
  });

  it('reports a playable warmup through the mode-state sidecar', () => {
    const { dir } = makeDirector({ botFill: 6, pickupCount: 8 });
    dir.start();
    const state = dir.roomState(createModeRoomState());

    expect(state.phase).toBe(ModePhase.WAITING);
    expect(state.bTotal).toBe(6);      // bodies in the arena
    expect(state.b).toBe(0);           // humans
    expect(state.cTotal).toBe(8);      // pickup spots
    expect(state.c).toBe(8);           // …all of them on the floor
    expect(state.failed).toBe(false);
  });

  it('starts the round the instant the first human arrives, no waiting', () => {
    const { dir, sim } = makeDirector({ botFill: 6 });
    dir.start();

    const join = dir.joinHuman(900, 'Marine');
    expect(join).not.toBeNull();
    expect(join?.startedRound).toBe(true);
    // No tick has been taken between the join and being live.
    expect(dir.phase).toBe(DmPhase.LIVE);
    expect(dir.round).toBe(1);
    expect(sim.getPlayer(900)?.dead).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Bot backfill
 * ------------------------------------------------------------------------ */

describe('bot backfill', () => {
  it('a joining human replaces a bot rather than adding a slot', () => {
    const { dir, sim, botsRemoved } = makeDirector({ botFill: 6 });
    dir.start();
    expect(dir.bodyCount).toBe(6);

    const join = dir.joinHuman(900, 'Marine');
    expect(join).not.toBeNull();
    expect(join!.replacedBotId).not.toBe(0);

    expect(dir.bodyCount).toBe(6);       // the arena did not grow
    expect(dir.humanCount).toBe(1);
    expect(dir.botCount).toBe(5);
    expect(botsRemoved).toEqual([join!.replacedBotId]);
    // The sacrificed bot's body is really gone, not just unseated.
    expect(sim.getPlayer(join!.replacedBotId)).toBeUndefined();
    expect(sim.players.length).toBe(6);
  });

  it('keeps replacing bots until the fill is exhausted, then adds seats', () => {
    const { dir } = makeDirector({ botFill: 3, maxPlayers: 8 });
    dir.start();
    expect(dir.botCount).toBe(3);

    for (let i = 0; i < 3; i++) {
      const r = dir.joinHuman(900 + i, `H${i}`);
      expect(r!.replacedBotId).not.toBe(0);
      expect(dir.bodyCount).toBe(3);
    }
    expect(dir.botCount).toBe(0);
    expect(dir.humanCount).toBe(3);

    // Bots are all gone: the fourth human is a genuinely new seat.
    const fourth = dir.joinHuman(910, 'H3');
    expect(fourth!.replacedBotId).toBe(0);
    expect(dir.bodyCount).toBe(4);
    expect(dir.humanCount).toBe(4);
  });

  it('a mid-round join does not disturb the match', () => {
    const { dir, sim } = makeDirector({ botFill: 6, durationMs: 120_000, scoreLimit: 30 });
    dir.start();
    dir.joinHuman(900, 'First');
    expect(dir.round).toBe(1);

    // Ten seconds of play, with frags on the board.
    advance(dir, sim, 10_000);
    const bots = sim.players.filter((p) => p.isBot);
    bots[0].kills = 4;
    bots[1].kills = 2;
    const humanBody = sim.getPlayer(900)!;
    humanBody.kills = 3;
    advance(dir, sim, 200);

    const roundBefore = dir.round;
    const clockBefore = dir.timeLeftMs;
    const elapsedBefore = dir.elapsedMs;
    const bodiesBefore = dir.bodyCount;
    const scoresBefore = new Map(sim.players.map((p) => [p.id, p.kills] as const));

    const join = dir.joinHuman(901, 'Second');
    expect(join).not.toBeNull();
    expect(join!.startedRound).toBe(false);
    expect(join!.replacedBotId).not.toBe(0);

    // Round, clock and body count untouched.
    expect(dir.round).toBe(roundBefore);
    expect(dir.timeLeftMs).toBe(clockBefore);
    expect(dir.elapsedMs).toBe(elapsedBefore);
    expect(dir.bodyCount).toBe(bodiesBefore);
    expect(dir.humanCount).toBe(2);

    // Every surviving body kept its score to the frag.
    for (const p of sim.players) {
      if (p.id === 901) continue;
      expect(p.kills).toBe(scoresBefore.get(p.id) ?? 0);
    }
    // …and the newcomer starts from zero.
    expect(dir.scoreboard().find((r) => r.id === 901)?.score).toBe(0);
  });

  it('never unseats the bot that is winning', () => {
    const { dir, sim } = makeDirector({ botFill: 4 });
    dir.start();
    const bots = sim.players.filter((p) => p.isBot);
    // Give one bot a commanding lead and make the rest look expendable.
    bots[2].kills = 12;
    for (const b of bots) if (b !== bots[2]) b.dead = true;
    advance(dir, sim, TICK_MS);          // let the director notice the leader

    const leaderId = bots[2].id;
    const join = dir.joinHuman(900, 'Marine');
    expect(join!.replacedBotId).not.toBe(leaderId);
    expect(sim.getPlayer(leaderId)).toBeDefined();
  });

  it('parks the clock again when the last human leaves and keeps the bots', () => {
    const { dir, sim } = makeDirector({ botFill: 5 });
    dir.start();
    dir.joinHuman(900, 'Marine');
    advance(dir, sim, 2000);
    expect(dir.phase).toBe(DmPhase.LIVE);

    dir.leave(900);
    expect(dir.phase).toBe(DmPhase.WARMUP);
    advance(dir, sim, 3000);
    // Bots are backfilled straight away so the room is never empty.
    expect(dir.bodyCount).toBe(5);
    expect(dir.humanCount).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Pickups
 * ------------------------------------------------------------------------ */

describe('pickups', () => {
  let sim: FakeSim;
  let field: DmPickupField;

  beforeEach(() => {
    sim = new FakeSim();
    field = new DmPickupField(7, 0);
  });

  function bodyAt(id: number, x: number, y: number, z: number): FakeBody {
    const b = new FakeBody(id);
    b.pos[0] = x; b.pos[1] = y; b.pos[2] = z;
    return b;
  }

  it('cannot be taken twice — two bodies on one medikit produce one heal', () => {
    const spot = field.push(10, 30, 10);
    spot.type = EntityType.PICKUP_HEALTH;
    spot.variant = 0;
    spot.respawnMs = pickupRespawnMs(spot.type, spot.variant);
    field.spawnDue(sim, 0);
    expect(spot.entityId).toBeGreaterThanOrEqual(0);
    expect(sim.liveEntities()).toBe(1);

    const a = bodyAt(1, 10, 30, 10);
    const b = bodyAt(2, 10, 30, 10);
    a.health = 50;
    b.health = 50;

    expect(field.tryTake(spot.index, a, 0, sim)).toBe(DmTake.TAKEN);
    expect(field.tryTake(spot.index, b, 0, sim)).toBe(DmTake.ALREADY_TAKEN);

    expect(a.health).toBe(75);
    expect(b.health).toBe(50);            // the loser gets nothing at all
    expect(spot.takenCount).toBe(1);
    expect(spot.takenBy).toBe(1);
    expect(sim.liveEntities()).toBe(0);   // and there is nothing left to walk over
  });

  it('respawns on its own timer, not before', () => {
    const spot = field.push(0, 30, 0);
    spot.type = EntityType.PICKUP_AMMO;
    spot.variant = AmmoType.SHELLS;
    spot.respawnMs = 15_000;
    field.spawnDue(sim, 0);

    const a = bodyAt(1, 0, 30, 0);
    a.reserve[AmmoType.SHELLS] = 0;
    expect(field.tryTake(spot.index, a, 1000, sim)).toBe(DmTake.TAKEN);
    expect(spot.readyAtMs).toBe(1000 + 15_000);

    // One millisecond early is still gone.
    field.update(sim, 15_999);
    expect(field.availableCount).toBe(0);
    expect(field.tryTake(spot.index, a, 15_999, sim)).toBe(DmTake.ALREADY_TAKEN);

    // On the timer it is back, and claimable again.
    field.update(sim, 16_000);
    expect(field.availableCount).toBe(1);
    expect(sim.liveEntities()).toBe(1);
    a.reserve[AmmoType.SHELLS] = 0;
    expect(field.tryTake(spot.index, a, 16_000, sim)).toBe(DmTake.TAKEN);
    expect(spot.takenCount).toBe(2);
  });

  it('arms the timer when the simulation itself consumes the pickup', () => {
    const spot = field.push(0, 30, 0);
    spot.type = EntityType.PICKUP_ARMOR;
    spot.variant = 0;
    spot.respawnMs = 25_000;
    field.spawnDue(sim, 0);

    // The sim's own proximity sweep removes the entity behind the director's back.
    sim.removeEntity(sim.slotOf(spot.entityId), 0);
    field.update(sim, 5000);
    expect(spot.entityId).toBe(-1);
    expect(spot.readyAtMs).toBe(30_000);

    field.update(sim, 30_000);
    expect(spot.entityId).toBeGreaterThanOrEqual(0);
  });

  it('refuses a claim that is out of reach or would do nothing', () => {
    const spot = field.push(0, 30, 0);
    spot.type = EntityType.PICKUP_HEALTH;
    spot.variant = 0;
    field.spawnDue(sim, 0);

    const far = bodyAt(1, 9, 30, 0);
    expect(field.tryTake(spot.index, far, 0, sim)).toBe(DmTake.TOO_FAR);

    const full = bodyAt(2, 0, 30, 0);
    full.health = MAX_HEALTH;
    expect(field.tryTake(spot.index, full, 0, sim)).toBe(DmTake.NO_EFFECT);
    // A refused claim leaves it on the floor for somebody who can use it.
    expect(field.availableCount).toBe(1);

    const hurt = bodyAt(3, 0, 30, 0);
    hurt.health = 10;
    expect(field.tryTake(spot.index, hurt, 0, sim)).toBe(DmTake.TAKEN);

    expect(field.tryTake(999, hurt, 0, sim)).toBe(DmTake.UNKNOWN);
  });

  it('per-class timers follow Doom rhythm, not one global number', () => {
    expect(pickupRespawnMs(EntityType.PICKUP_AMMO, 1)).toBeLessThan(
      pickupRespawnMs(EntityType.PICKUP_ARMOR, 0));
    expect(pickupRespawnMs(EntityType.PICKUP_HEALTH, 1)).toBeGreaterThan(
      pickupRespawnMs(EntityType.PICKUP_HEALTH, 0));
    expect(pickupRespawnMs(EntityType.PICKUP_WEAPON, 3)).toBe(25_000);
  });

  it('applies weapon pickups the way the simulation does', () => {
    const b = new FakeBody(1);
    expect(ownsWeapon(b.weaponMask, 1)).toBe(false);
    expect(applyPickupTo(b, EntityType.PICKUP_WEAPON, 1)).toBe(true);
    expect(ownsWeapon(b.weaponMask, 1)).toBe(true);
    // Second time: no new weapon, but a top-up of its ammo.
    b.reserve[AmmoType.SHELLS] = 0;
    expect(applyPickupTo(b, EntityType.PICKUP_WEAPON, 1)).toBe(true);
    expect(b.reserve[AmmoType.SHELLS]).toBeGreaterThan(0);

    b.armor = MAX_ARMOR;
    expect(applyPickupTo(b, EntityType.PICKUP_ARMOR, 0)).toBe(false);
  });

  it('keeps the arena furnished through a whole match', () => {
    const { dir, sim } = makeDirector({ botFill: 2, pickupCount: 10 });
    dir.start();
    expect(dir.pickups.availableCount).toBe(10);

    // Strip the floor bare, then let the timers do their work.
    for (let i = 0; i < dir.pickups.count; i++) {
      const s = dir.pickups.spot(i)!;
      const slot = sim.slotOf(s.entityId);
      if (slot >= 0) sim.removeEntity(slot, 0);
    }
    advance(dir, sim, TICK_MS);
    expect(dir.pickups.availableCount).toBe(0);

    advance(dir, sim, 46_000);
    expect(dir.pickups.availableCount).toBe(10);
  });
});

/* ------------------------------------------------------------------------ *
 * Rounds
 * ------------------------------------------------------------------------ */

describe('rounds', () => {
  it('ends on the frag limit and rolls into the next round', () => {
    const { dir, sim } = makeDirector({ botFill: 4, scoreLimit: 5, durationMs: 600_000 });
    dir.start();
    dir.joinHuman(900, 'Marine');
    expect(dir.round).toBe(1);

    sim.getPlayer(900)!.kills = 5;
    advance(dir, sim, TICK_MS * 2);
    expect(dir.phase).toBe(DmPhase.INTERMISSION);
    expect(dir.matchOver).toBe(true);
    expect(dir.leader).toBe(900);
    expect(dir.leaderFrags).toBe(5);

    advance(dir, sim, DM_INTERMISSION_MS + TICK_MS);
    expect(dir.phase).toBe(DmPhase.LIVE);
    expect(dir.round).toBe(2);
    expect(dir.leaderFrags).toBe(0);           // scores wiped for the new round
    expect(dir.timeLeftMs).toBeGreaterThan(600_000 - TICK_MS * 4);
  });

  it('ends on the clock', () => {
    const { dir, sim } = makeDirector({ botFill: 2, scoreLimit: 0, durationMs: 3000 });
    dir.start();
    dir.joinHuman(900, 'Marine');
    advance(dir, sim, 3200);
    expect(dir.phase).toBe(DmPhase.INTERMISSION);
    expect(dir.timeLeftMs).toBe(0);
  });

  it('stands a corpse back up by itself rather than leaving it dead', () => {
    const { dir, sim } = makeDirector({ botFill: 2 });
    dir.start();
    dir.joinHuman(900, 'Marine');
    const body = sim.getPlayer(900)!;

    body.dead = true;
    body.respawnAtMs = sim.nowMs + RESPAWN_DELAY_MS;

    // Too early: the respawn floor is a real floor.
    expect(dir.requestRespawn(900)).toBe(false);
    advance(dir, sim, RESPAWN_DELAY_MS - TICK_MS);
    expect(body.dead).toBe(true);

    // Asking once eligible works immediately.
    advance(dir, sim, TICK_MS * 2);
    expect(dir.requestRespawn(900) || !body.dead).toBe(true);

    // And a player who never asks still gets up.
    body.dead = true;
    body.respawnAtMs = sim.nowMs + RESPAWN_DELAY_MS;
    advance(dir, sim, RESPAWN_DELAY_MS + DM_AUTO_RESPAWN_MS + TICK_MS * 2);
    expect(body.dead).toBe(false);
  });

  it('ranks the scoreboard by frags with the leader flagged', () => {
    const { dir, sim } = makeDirector({ botFill: 4 });
    dir.start();
    dir.joinHuman(900, 'Marine');
    const bots = sim.players.filter((p) => p.isBot);
    bots[0].kills = 2;
    bots[1].kills = 7;
    sim.getPlayer(900)!.kills = 4;
    advance(dir, sim, TICK_MS);

    const rows = dir.scoreboard();
    expect(rows.length).toBe(4);
    expect(rows[0].id).toBe(bots[1].id);
    expect(rows[0].leader).toBe(true);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].id).toBe(900);
    expect(rows[1].bot).toBe(false);
    expect(rows[3].score).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The real engine
 *
 * Everything above runs against a fake. This one runs the same director
 * against `Simulation` and `ServerWorld` so the structural interfaces in
 * deathmatch.ts are checked against the shipping classes at runtime, not only
 * by the compile-time assertions in that file.
 * ------------------------------------------------------------------------ */

describe('against the real simulation', () => {
  it('furnishes and populates a real world with nobody watching', () => {
    const world = new ServerWorld(4242);
    world.generateAll();
    const sim = new Simulation(world, 4242);

    const dir = new DeathmatchDirector({
      plan: makePlan(),
      sim,
      world,
      seed: 4242,
      botFill: 6,
      pickupCount: 16,
    });
    dir.start();

    expect(dir.botCount).toBe(6);
    expect(sim.players.length).toBe(6);
    expect(dir.pickups.count).toBe(16);
    expect(dir.pickups.availableCount).toBe(16);

    // Every spot is a live entity in the real entity table, on real ground.
    let live = 0;
    for (let i = 0; i < sim.entCapacity; i++) {
      if (sim.entActive[i] === 1 && sim.entType[i] >= EntityType.PICKUP_HEALTH) live++;
    }
    expect(live).toBe(16);
    for (let i = 0; i < dir.pickups.count; i++) {
      const s = dir.pickups.spot(i)!;
      expect(world.standableY(Math.floor(s.x), Math.floor(s.z))).toBeGreaterThanOrEqual(0);
    }
  });

  it('hands a real bot body over to a real human', () => {
    const world = new ServerWorld(99);
    world.generateAll();
    const sim = new Simulation(world, 99);
    const dir = new DeathmatchDirector({
      plan: makePlan(), sim, world, seed: 99, botFill: 6, pickupCount: 8,
    });
    dir.start();
    const before = sim.players.length;

    const join = dir.joinHuman(4001, 'Doomguy');
    expect(join!.replacedBotId).not.toBe(0);
    expect(sim.players.length).toBe(before);
    expect(sim.getPlayer(4001)?.isBot).toBe(false);
    expect(sim.getPlayer(join!.replacedBotId)).toBeUndefined();

    // A real spawn: on the ground, alive, holding the starting loadout.
    const body = sim.getPlayer(4001)!;
    expect(body.dead).toBe(false);
    expect(body.health).toBe(MAX_HEALTH);
    expect(body.pos[1]).toBeGreaterThan(0);
    expect(ownsWeapon(body.weaponMask, 0)).toBe(true);
  });

  it('a real pickup can only be consumed once', () => {
    const world = new ServerWorld(5150);
    world.generateAll();
    const sim = new Simulation(world, 5150);
    const dir = new DeathmatchDirector({
      plan: makePlan(), sim, world, seed: 5150, botFill: 0, pickupCount: 4,
    });
    dir.start();

    const spot = dir.pickups.spot(0)!;
    spot.type = EntityType.PICKUP_HEALTH;
    spot.variant = 0;

    const a = sim.addPlayer(1, 'A', 0, false);
    const b = sim.addPlayer(2, 'B', 0, false);
    for (const p of [a, b]) {
      p.pos[0] = spot.x; p.pos[1] = spot.y; p.pos[2] = spot.z;
      p.health = 40;
      p.dead = false;
    }

    expect(dir.pickups.tryTake(0, a, sim.nowMs, sim)).toBe(DmTake.TAKEN);
    expect(dir.pickups.tryTake(0, b, sim.nowMs, sim)).toBe(DmTake.ALREADY_TAKEN);
    expect(a.health).toBe(65);
    expect(b.health).toBe(40);

    // The entity really left the real table, so the sim's own sweep finds nothing.
    let found = false;
    for (let i = 0; i < sim.entCapacity; i++) {
      if (sim.entActive[i] === 1 && sim.entId[i] === spot.entityId) found = true;
    }
    expect(found).toBe(false);
  });
});
