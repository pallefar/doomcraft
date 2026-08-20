/**
 * DOOMCRAFT — HORDE, the authoritative half.
 *
 * The thesis (docs/MODES.md §3): waves of Doom enemies attack a position, and
 * between waves you fortify with blocks. The mode only exists if those two
 * halves *interlock*. Everything in this file is written against that one test.
 *
 * The interlock, concretely, is four rules that all point at the same voxel:
 *
 *   1. THE FIGHT COMES BACK TO THE SAME PLACE. A run has a single hold point,
 *      chosen once and never moved. Waves spawn on a ring around it, at
 *      compass GATES that are announced before the wave lands. A wall only
 *      matters if the next wave walks into it, so the anchor is fixed and the
 *      gates are telegraphed — that is what makes "where do I spend?" a
 *      question with a right answer.
 *   2. A WALL IS A THING THEY MUST SOLVE. `siegeStep` is the half the coarse
 *      flow field in bots.ts cannot do. The field routes around geometry it can
 *      see (4-block cells); a one-block-thick player wall usually falls between
 *      its samples. So every ground demon that stops making progress toward its
 *      target probes the voxels directly in front of it, tries to SKIRT the
 *      obstruction first, and if it is sealed in, winds up and HITS the block.
 *      Blocks have hit points (`FortLedger`), the hit points go down, and at
 *      zero the block is set to air through the normal `ServerWorld.setBlock`
 *      path — which journals it, streams a BLOCK_DELTA to every client, bumps
 *      `editSerial`, and therefore makes `NavField` re-flood through the hole
 *      it just made. Repath -> blocked -> breach -> repath, one closed loop.
 *   3. FLYERS ARE THE ANSWER TO WALLS. Cacodemons and Lost Souls never siege
 *      and never care: they hover at head height and cross a fortification as
 *      if it were not there. From wave 4 the composition puts them in on
 *      purpose, so "I am safe behind stone" has an expiry date.
 *   4. ONE CURRENCY. Kills pay credits; credits buy ammo, guns, armour, repairs
 *      AND every block you place. A block is not free, so every metre of wall
 *      is a rocket you did not buy. That is the decision the mode is made of,
 *      and it is enforced here, not in the UI: the director reads the world's
 *      block journal each tick, charges the placer, and REVERTS the placement
 *      when they cannot pay.
 *
 * This file wires into bots.ts, it does not replace it. `MonsterManager` keeps
 * ownership of monster steering, attacks and integration; the director owns
 * when/where/what spawns, and adds the block-siege behaviour on top by writing
 * the same public entity arrays the AI already uses.
 *
 * ---------------------------------------------------------------------------
 * WIRING (three lines, in a file this module deliberately does not own)
 *
 *   // server/src/room.ts, constructor:
 *   this.horde = plan.runWaveDirector ? new HordeDirector({ sim: this.sim,
 *      monsters: this.monsters, plan, emit: (k, p, a, b, c, t) => this.net.??? }) : null;
 *
 *   // server/src/room.ts, step(), immediately AFTER this.sim.stepTick(dtMs)
 *   // and BEFORE this.net.flush() — it must see this tick's kills and this
 *   // tick's block journal, and its entity-state writes must survive to the
 *   // snapshot:
 *   this.horde?.step(dtMs);
 *
 *   // wherever C2S_MODE.ACTION is decoded:
 *   this.horde?.onAction(conn.playerId, msg.action, msg.a, msg.b, msg.seq);
 *
 * ---------------------------------------------------------------------------
 * IMPORTS: only `@doomcraft/shared`, `@doomcraft/shared/modes` and this
 * package's own `./modes.js` are runtime imports; sim/bots/world are TYPE-only.
 * That is deliberate and load-bearing: `client/src/modes/horde/waveDirector.ts`
 * imports the wave curve and the price table straight from this module, exactly
 * as `client/src/net/client.ts` imports `moveStep` from `./sim.js`, so the
 * client's "what is coming next wave" forecast and the server's authoritative
 * spawn table can never drift apart. Keep it that way: no runtime import of
 * sim.js, bots.js or world.js belongs in this file.
 */

import {
  AMMO_MAX,
  AmmoType,
  BLOCK_HARDNESS,
  BLOCK_SOLID,
  BlockId,
  CHUNK_HEIGHT,
  EntityType,
  MAX_ARMOR,
  MAX_ENTITIES,
  MAX_HEALTH,
  RemoveReason,
  WEAPON_COUNT,
  WeaponId,
  ammoTypeOf,
  blockToChunk,
  clamp,
  getWeapon,
  grantWeapon,
  hash3i,
  ownsWeapon,
} from '@doomcraft/shared';
import {
  ModeAction,
  ModeEventKind,
  ModePhase,
  SKILL_ENEMY_BONUS,
  SKILL_ENEMY_INTERVAL,
  type ModeStateBuffer,
} from '@doomcraft/shared/modes';

import {
  ModeStateTracker,
  createModePlayerState,
  createModeRoomState,
  waveBudget,
  type ModePlayerState,
  type ModeRoomState,
  type ModeSimPlan,
} from './modes.js';

import type { MonsterManager } from './bots.js';
import type { PlayerEntity, Simulation } from './sim.js';

/* ------------------------------------------------------------------------ *
 * 1. The roster
 *
 * Horde-specific numbers for the five archetypes bots.ts already implements.
 * `siegeDamage === 0` means "this thing never attacks geometry", which is the
 * whole personality of the two flyers.
 * ------------------------------------------------------------------------ */

export const HORDE_ENEMY_COUNT = 5;

export interface HordeEnemyDef {
  /** Matches `EntityType`, and is also the roster index. */
  readonly type: EntityType;
  readonly key: string;
  readonly name: string;
  readonly plural: string;
  /** True for Cacodemon and Lost Soul: they cross fortifications. */
  readonly flying: boolean;
  /** 0 = fodder … 3 = boss. Drives the spawn order inside a wave. */
  readonly tier: number;
  /** Credits paid for a kill at wave 1, before the wave and skill scales. */
  readonly payout: number;
  /** Pressure weight, used for the wave's threat number. */
  readonly threat: number;
  /** Damage one swing does to a block. 0 = never sieges. */
  readonly siegeDamage: number;
  /** Milliseconds between swings at a block. */
  readonly siegeIntervalMs: number;
  /** Telegraph before the swing lands — the player can see the wind-up. */
  readonly siegeWindupMs: number;
  /** First wave this archetype may appear in. */
  readonly introWave: number;
  /** Packed 0xRRGGBB, matched to the client's MONSTER_LOOK bodies. */
  readonly colour: number;
}

function enemy(d: HordeEnemyDef): HordeEnemyDef { return Object.freeze(d); }

/** Indexed by `EntityType` for the five monsters. */
export const HORDE_ENEMIES: readonly HordeEnemyDef[] = Object.freeze([
  enemy({
    type: EntityType.IMP, key: 'imp', name: 'Imp', plural: 'Imps',
    flying: false, tier: 0, payout: 12, threat: 1.0,
    siegeDamage: 26, siegeIntervalMs: 620, siegeWindupMs: 220,
    introWave: 1, colour: 0x9c3a1c,
  }),
  enemy({
    type: EntityType.ZOMBIE, key: 'trooper', name: 'Trooper', plural: 'Troopers',
    flying: false, tier: 0, payout: 10, threat: 1.1,
    siegeDamage: 14, siegeIntervalMs: 820, siegeWindupMs: 180,
    introWave: 2, colour: 0x4d5a34,
  }),
  enemy({
    type: EntityType.CACODEMON, key: 'cacodemon', name: 'Cacodemon', plural: 'Cacodemons',
    flying: true, tier: 2, payout: 26, threat: 2.6,
    siegeDamage: 0, siegeIntervalMs: 0, siegeWindupMs: 0,
    introWave: 4, colour: 0xa02222,
  }),
  enemy({
    type: EntityType.BARON, key: 'baron', name: 'Baron', plural: 'Barons',
    flying: false, tier: 3, payout: 60, threat: 5.5,
    siegeDamage: 120, siegeIntervalMs: 1400, siegeWindupMs: 520,
    introWave: 7, colour: 0xc0a184,
  }),
  enemy({
    type: EntityType.LOST_SOUL, key: 'lost_soul', name: 'Lost Soul', plural: 'Lost Souls',
    flying: true, tier: 1, payout: 8, threat: 0.9,
    siegeDamage: 0, siegeIntervalMs: 0, siegeWindupMs: 0,
    introWave: 3, colour: 0xf0e2c0,
  }),
]);

/** Roster lookup. Returns undefined for pickups and unknown ids. */
export function hordeEnemy(type: number): HordeEnemyDef | undefined {
  return type >= 0 && type < HORDE_ENEMY_COUNT ? HORDE_ENEMIES[type] : undefined;
}
export function isFlyer(type: number): boolean {
  const d = hordeEnemy(type);
  return d !== undefined && d.flying;
}

/* ------------------------------------------------------------------------ *
 * 2. Gates — the telegraph
 *
 * Eight compass gates on a ring around the hold point. A wave lights a subset,
 * announced before the first demon spawns, so fortifying is a choice about
 * WHERE. Gate 0 is north (-z) and they run clockwise, matching the compass
 * strip the client draws.
 * ------------------------------------------------------------------------ */

export const HORDE_GATE_COUNT = 8;
export const HORDE_GATE_NAMES: readonly string[] = Object.freeze([
  'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW',
]);
export const HORDE_GATE_LONG_NAMES: readonly string[] = Object.freeze([
  'north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west',
]);
/** Metres from the hold point to the spawn ring. */
export const HORDE_GATE_RADIUS = 34;
/** Nothing may spawn closer to the hold than this. */
export const HORDE_HOLD_SAFE_RADIUS = 13;
/** …nor closer than this to any living player. */
export const HORDE_SPAWN_CLEARANCE = 11;

export function gateBearing(gate: number): number {
  return ((gate % HORDE_GATE_COUNT) + HORDE_GATE_COUNT) % HORDE_GATE_COUNT * (Math.PI * 2 / HORDE_GATE_COUNT);
}
export function gateOffsetX(gate: number, radius: number): number {
  return Math.sin(gateBearing(gate)) * radius;
}
export function gateOffsetZ(gate: number, radius: number): number {
  return -Math.cos(gateBearing(gate)) * radius;
}
export function gateIsHot(mask: number, gate: number): boolean {
  return (mask & (1 << gate)) !== 0;
}

/* ------------------------------------------------------------------------ *
 * 3. The curve
 *
 * "Escalating pressure rather than a bigger number" comes from five knobs
 * moving at once, not from `count++`:
 *
 *   count        how many
 *   composition  what kind — a new archetype changes the SHAPE of the threat
 *   gates        how many directions at once
 *   burst        how many arrive in one breath
 *   cadence      how fast the gaps between arrivals close
 *
 * The archetype ladder is the important half. Wave 1 is imps: they run at you.
 * Wave 2 adds hitscan Troopers, so standing in the open stops working. Wave 3
 * adds Lost Souls, which are fast and airborne. Wave 4 adds Cacodemons — the
 * wave that teaches that a wall is not a roof. Wave 5 is the first boss wave.
 * ------------------------------------------------------------------------ */

/** A boss wave every fifth wave. */
export const HORDE_BOSS_EVERY = 5;
/** Hard cap on how many bodies one wave may queue. */
export const HORDE_MAX_WAVE_SPAWNS = 60;
/** Hard cap on monsters alive at once, whatever the wave says. */
export const HORDE_MAX_ALIVE = 26;
/** Payout multiplier per skill — harder waves pay for themselves. */
export const HORDE_SKILL_PAYOUT: Float32Array = new Float32Array([0.8, 0.9, 1.0, 1.1, 1.25]);

export function bossWave(wave: number): boolean {
  return wave >= HORDE_BOSS_EVERY && wave % HORDE_BOSS_EVERY === 0;
}
/** Barons forced into a boss wave on top of the normal mix. */
export function bossCountFor(wave: number): number {
  if (!bossWave(wave)) return 0;
  return clamp(1 + Math.floor(wave / (HORDE_BOSS_EVERY * 2)), 1, 6);
}

/** Everything one wave is, in one flat reusable record. */
export class WaveComposition {
  wave = 0;
  /** Bodies queued for the whole wave. */
  total = 0;
  /** Per-archetype counts, indexed by `EntityType` / roster index. */
  readonly count = new Uint8Array(HORDE_ENEMY_COUNT);
  /** Spawn order, `total` entries of `EntityType`, light tiers first. */
  readonly order = new Uint8Array(HORDE_MAX_WAVE_SPAWNS);
  boss = false;
  bossCount = 0;
  /** Bit per archetype present. */
  archMask = 0;
  /** Bit per hot compass gate. */
  gateMask = 0;
  gateCount = 0;
  /** Monsters released per spawn beat. */
  burst = 1;
  /** Milliseconds between spawn beats. */
  spawnIntervalMs = 1500;
  /** 0..1 — extra attack cadence the director grants the whole wave. */
  aggression = 0;
  /** Monsters allowed on the map at once. */
  aliveCap = 8;
  /** Weighted danger, for the client's pressure read-out. */
  threat = 0;
  /** Credits every survivor is paid for clearing it. */
  payout = 0;

  reset(): void {
    this.wave = 0;
    this.total = 0;
    this.count.fill(0);
    this.order.fill(0);
    this.boss = false;
    this.bossCount = 0;
    this.archMask = 0;
    this.gateMask = 0;
    this.gateCount = 0;
    this.burst = 1;
    this.spawnIntervalMs = 1500;
    this.aggression = 0;
    this.aliveCap = 8;
    this.threat = 0;
    this.payout = 0;
  }

  copyFrom(o: WaveComposition): void {
    this.wave = o.wave;
    this.total = o.total;
    this.count.set(o.count);
    this.order.set(o.order);
    this.boss = o.boss;
    this.bossCount = o.bossCount;
    this.archMask = o.archMask;
    this.gateMask = o.gateMask;
    this.gateCount = o.gateCount;
    this.burst = o.burst;
    this.spawnIntervalMs = o.spawnIntervalMs;
    this.aggression = o.aggression;
    this.aliveCap = o.aliveCap;
    this.threat = o.threat;
    this.payout = o.payout;
  }

  /** How many of `type` this wave contains. */
  countOf(type: number): number {
    return type >= 0 && type < HORDE_ENEMY_COUNT ? this.count[type] : 0;
  }
  /** True when at least one flying archetype is in the mix. */
  get hasFlyers(): boolean {
    return this.count[EntityType.CACODEMON] > 0 || this.count[EntityType.LOST_SOUL] > 0;
  }
}

export function createWaveComposition(): WaveComposition { return new WaveComposition(); }

/** Reused by `composeWave`; the server is single threaded and so is a worker. */
const WEIGHT_SCRATCH = new Float64Array(HORDE_ENEMY_COUNT);
const FRACTION_SCRATCH = new Float64Array(HORDE_ENEMY_COUNT);

/**
 * THE CURVE. Pure, allocation-free and deterministic in `(wave, skill,
 * players, seed)`, which is why the client can render an exact forecast of the
 * next wave during the fortify window without the server sending one.
 */
export function composeWave(
  wave: number, skill: number, players: number, seed: number, out: WaveComposition,
): WaveComposition {
  const w = clamp(Math.round(wave) | 0, 1, 999);
  const sk = clamp(Math.round(skill) | 0, 0, 4);
  const heads = clamp(Math.round(players) | 0, 1, 4);

  out.reset();
  out.wave = w;

  /* --- how many --------------------------------------------------------- */
  const base = 4 + w * 1.8 + w * w * 0.06;
  const scaled = base * (1 + SKILL_ENEMY_BONUS[sk]) * (1 + 0.34 * (heads - 1));
  out.total = clamp(Math.round(scaled), 3, HORDE_MAX_WAVE_SPAWNS);

  /* --- what kind -------------------------------------------------------- */
  const weights = WEIGHT_SCRATCH;
  weights[EntityType.IMP] = Math.max(0.18, 1.0 - w * 0.030);
  weights[EntityType.ZOMBIE] = w >= 2 ? Math.min(0.42, 0.12 + w * 0.026) : 0;
  weights[EntityType.LOST_SOUL] = w >= 3 ? Math.min(0.30, 0.04 + w * 0.020) : 0;
  weights[EntityType.CACODEMON] = w >= 4 ? Math.min(0.26, 0.03 + w * 0.018) : 0;
  weights[EntityType.BARON] = w >= 7 ? Math.min(0.16, 0.01 + (w - 6) * 0.011) : 0;

  let sum = 0;
  for (let i = 0; i < HORDE_ENEMY_COUNT; i++) sum += weights[i];
  if (sum <= 0) { weights[EntityType.IMP] = 1; sum = 1; }

  let handed = 0;
  for (let i = 0; i < HORDE_ENEMY_COUNT; i++) {
    const raw = (out.total * weights[i]) / sum;
    const whole = Math.floor(raw);
    out.count[i] = whole;
    FRACTION_SCRATCH[i] = raw - whole;
    handed += whole;
  }
  // Largest remainder, so the counts always add up to `total` exactly.
  while (handed < out.total) {
    let best = -1;
    let bestFrac = -1;
    for (let i = 0; i < HORDE_ENEMY_COUNT; i++) {
      if (FRACTION_SCRATCH[i] > bestFrac) { bestFrac = FRACTION_SCRATCH[i]; best = i; }
    }
    if (best < 0) break;
    out.count[best]++;
    FRACTION_SCRATCH[best] = -1;
    handed++;
  }

  /* --- the boss --------------------------------------------------------- */
  out.boss = bossWave(w);
  out.bossCount = bossCountFor(w);
  if (out.bossCount > out.count[EntityType.BARON]) {
    let need = out.bossCount - out.count[EntityType.BARON];
    // Barons come out of the fodder budget, cheapest tier first, so a boss wave
    // is heavier without being longer.
    const donors = [EntityType.IMP, EntityType.ZOMBIE, EntityType.LOST_SOUL, EntityType.CACODEMON];
    for (let d = 0; d < donors.length && need > 0; d++) {
      const from = donors[d];
      // Never strip a donor to nothing before wave 3; a lone Baron is a duel,
      // not a horde.
      const spare = Math.max(0, out.count[from] - (w < 3 ? 0 : 1));
      const take = Math.min(spare, need);
      out.count[from] -= take;
      out.count[EntityType.BARON] += take;
      need -= take;
    }
    if (need > 0) {
      out.count[EntityType.BARON] += need;
      out.total = Math.min(HORDE_MAX_WAVE_SPAWNS, out.total + need);
    }
  }

  /* --- order: light first, heavy last, so a wave escalates inside itself -- */
  let cursor = 0;
  for (let tier = 0; tier <= 3 && cursor < out.total; tier++) {
    for (let i = 0; i < HORDE_ENEMY_COUNT && cursor < out.total; i++) {
      if (HORDE_ENEMIES[i].tier !== tier) continue;
      for (let n = 0; n < out.count[i] && cursor < out.total; n++) out.order[cursor++] = i;
    }
  }
  out.total = cursor;
  // A deterministic ripple so a wave is not a perfectly sorted parade.
  for (let i = 1; i < out.total; i++) {
    if ((hash3i(seed, w, i, 0x53b1) & 3) !== 0) continue;
    const a = out.order[i - 1];
    out.order[i - 1] = out.order[i];
    out.order[i] = a;
  }

  /* --- masks, cadence, pressure ---------------------------------------- */
  for (let i = 0; i < HORDE_ENEMY_COUNT; i++) {
    if (out.count[i] > 0) {
      out.archMask |= 1 << i;
      out.threat += out.count[i] * HORDE_ENEMIES[i].threat;
    }
  }

  out.gateCount = clamp(1 + Math.floor(w / 2), 1, HORDE_GATE_COUNT);
  let gate = hash3i(seed, w, 0x9a1, 0x40dc) % HORDE_GATE_COUNT;
  for (let i = 0; i < out.gateCount; i++) {
    // Step by 3 (co-prime with 8) so the hot gates spread instead of clumping.
    while (gateIsHot(out.gateMask, gate)) gate = (gate + 1) % HORDE_GATE_COUNT;
    out.gateMask |= 1 << gate;
    gate = (gate + 3) % HORDE_GATE_COUNT;
  }

  out.burst = clamp(1 + Math.floor(w / 4), 1, 5);
  out.spawnIntervalMs = Math.round(
    clamp(1500 - w * 55, 340, 1500) * SKILL_ENEMY_INTERVAL[sk],
  );
  out.aggression = clamp((w - 1) / 24, 0, 1);
  out.aliveCap = clamp(6 + Math.floor(w * 0.9), 6, HORDE_MAX_ALIVE);
  out.payout = 40 + w * 18;

  return out;
}

/** Threat of a composition relative to wave 1, for the client's pressure bar. */
export function waveThreat(c: WaveComposition): number { return c.threat; }

/* ------------------------------------------------------------------------ *
 * 4. The economy
 *
 * ONE currency. Blocks are priced against guns on purpose: a Rocket Launcher
 * is 700 credits, which is 175 stone blocks or 20 blocks of obsidian. There is
 * no separate "block budget" to spend first, so a wall is never free and the
 * question "kill it faster or keep it out longer" is asked with every credit.
 * ------------------------------------------------------------------------ */

export enum HordeItem {
  AMMO_BULLETS = 0,
  AMMO_SHELLS = 1,
  AMMO_ROCKETS = 2,
  AMMO_CELLS = 3,
  WEAPON_SHOTGUN = 4,
  WEAPON_CHAINGUN = 5,
  WEAPON_ROCKET = 6,
  WEAPON_PLASMA = 7,
  WEAPON_BFG = 8,
  MEDKIT = 9,
  ARMOR = 10,
  /** Restore every damaged block you own within `HORDE_REPAIR_RADIUS`. */
  REPAIR = 11,
  EXTRA_LIFE = 12,
}
export const HORDE_ITEM_COUNT = 13;

export interface HordeShopItem {
  readonly id: HordeItem;
  readonly name: string;
  readonly blurb: string;
  /** 0 means "priced at purchase time" (repairs). */
  readonly price: number;
  /** WeaponId granted, or -1. */
  readonly weapon: number;
  /** AmmoType refilled, or 0. */
  readonly ammo: number;
  /** Fraction of the reserve cap an ammo purchase hands over. */
  readonly ammoFraction: number;
  /** Health / armour granted. */
  readonly health: number;
  readonly armor: number;
  /** Only buyable during the fortify window. */
  readonly buildPhaseOnly: boolean;
}

function item(d: HordeShopItem): HordeShopItem { return Object.freeze(d); }

/** Indexed by `HordeItem`. */
export const HORDE_SHOP: readonly HordeShopItem[] = Object.freeze([
  item({
    id: HordeItem.AMMO_BULLETS, name: 'Bullets', blurb: '+50% bullet reserve',
    price: 30, weapon: -1, ammo: AmmoType.BULLETS, ammoFraction: 0.5,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.AMMO_SHELLS, name: 'Shells', blurb: '+50% shell reserve',
    price: 45, weapon: -1, ammo: AmmoType.SHELLS, ammoFraction: 0.5,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.AMMO_ROCKETS, name: 'Rockets', blurb: '+50% rocket reserve — also your demolition tool',
    price: 90, weapon: -1, ammo: AmmoType.ROCKETS, ammoFraction: 0.5,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.AMMO_CELLS, name: 'Cells', blurb: '+50% cell reserve',
    price: 60, weapon: -1, ammo: AmmoType.CELLS, ammoFraction: 0.5,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.WEAPON_SHOTGUN, name: 'Shotgun', blurb: 'Doorway weapon. Shreds inside 9 m',
    price: 200, weapon: WeaponId.SHOTGUN, ammo: AmmoType.SHELLS, ammoFraction: 0.35,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.WEAPON_CHAINGUN, name: 'Chaingun', blurb: '700 rpm. Holds a breach open',
    price: 350, weapon: WeaponId.CHAINGUN, ammo: AmmoType.BULLETS, ammoFraction: 0.35,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.WEAPON_ROCKET, name: 'Rocket Launcher', blurb: 'Blows holes in demons AND in your own walls',
    price: 700, weapon: WeaponId.ROCKET, ammo: AmmoType.ROCKETS, ammoFraction: 0.5,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.WEAPON_PLASMA, name: 'Plasma Rifle', blurb: 'Sustained damage, no splash. Safe indoors',
    price: 800, weapon: WeaponId.PLASMA, ammo: AmmoType.CELLS, ammoFraction: 0.35,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.WEAPON_BFG, name: 'BFG 9000', blurb: 'Deletes a boss wave. Deletes your keep too',
    price: 2200, weapon: WeaponId.BFG, ammo: AmmoType.CELLS, ammoFraction: 0.25,
    health: 0, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.MEDKIT, name: 'Medkit', blurb: '+50 health',
    price: 120, weapon: -1, ammo: 0, ammoFraction: 0,
    health: 50, armor: 0, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.ARMOR, name: 'Armour', blurb: '+75 armour',
    price: 180, weapon: -1, ammo: 0, ammoFraction: 0,
    health: 0, armor: 75, buildPhaseOnly: false,
  }),
  item({
    id: HordeItem.REPAIR, name: 'Repair Walls', blurb: 'Restore every damaged block within 14 m',
    price: 0, weapon: -1, ammo: 0, ammoFraction: 0,
    health: 0, armor: 0, buildPhaseOnly: true,
  }),
  item({
    id: HordeItem.EXTRA_LIFE, name: 'Resurrection', blurb: 'One more life for the run',
    price: 900, weapon: -1, ammo: 0, ammoFraction: 0,
    health: 0, armor: 0, buildPhaseOnly: true,
  }),
]);

export function shopItem(id: number): HordeShopItem | undefined {
  return id >= 0 && id < HORDE_ITEM_COUNT ? HORDE_SHOP[id] : undefined;
}

/** Credits per point of block hardness when a block is placed. */
export const HORDE_BLOCK_CREDITS_PER_HARDNESS = 3.4;
/** Hit points per point of block hardness. */
export const HORDE_HP_PER_HARDNESS = 90;
/** Placing while a wave is live costs this multiple. Fortify early or pay. */
export const HORDE_COMBAT_PREMIUM = 2;
/** A block you break yourself returns this fraction of its remaining value. */
export const HORDE_SALVAGE = 0.5;
/** Repair reach from the player, metres. */
export const HORDE_REPAIR_RADIUS = 14;
/** Credits a run starts with — enough for a starter wall, not for a gun. */
export const HORDE_START_CREDITS = 180;
/** Hard ceiling; the wire field is a uint16. */
export const HORDE_MAX_CREDITS = 9999;

/** What one block of `blockId` costs to place. Always at least 1. */
export function blockCost(blockId: number): number {
  const hardness = BLOCK_HARDNESS[blockId];
  if (hardness === undefined || hardness < 0) return 0;
  return Math.max(1, Math.round(hardness * HORDE_BLOCK_CREDITS_PER_HARDNESS));
}

/** Hit points a fresh block of `blockId` has against demon teeth. */
export function fortHpFor(blockId: number): number {
  const hardness = BLOCK_HARDNESS[blockId];
  if (hardness === undefined || hardness < 0) return 0;
  return Math.max(20, Math.round(hardness * HORDE_HP_PER_HARDNESS));
}

/** Credits to put `missing` hit points back into a block of `blockId`. */
export function repairCostFor(missing: number, maxHp: number, blockId: number): number {
  if (missing <= 0 || maxHp <= 0) return 0;
  const full = blockCost(blockId);
  return Math.max(1, Math.round((missing / maxHp) * full * 0.6));
}

/**
 * The wall palette, cheapest first. This is the decision made legible: dirt is
 * a speed bump, obsidian is a keep, and the client prints this table next to
 * your credit balance.
 */
export const HORDE_WALL_PALETTE: readonly number[] = Object.freeze([
  BlockId.DIRT, BlockId.SAND, BlockId.PLANKS, BlockId.STONE, BlockId.COBBLESTONE,
  BlockId.BRICK, BlockId.HELLSTONE, BlockId.RUSTED_METAL, BlockId.TECH_PANEL,
  BlockId.METAL, BlockId.OBSIDIAN,
]);

/* ------------------------------------------------------------------------ *
 * 5. Event sub-codes
 *
 * `ModeEventKind` has no BREACH, and shared/src/modes.ts is not this module's
 * to edit, so horde's own one-shots ride on `OBJECTIVE` with a sub-code in `c`
 * and a world position in `a`/`b` (biased so it fits a uint16). The client
 * imports these constants from here, so the two ends cannot disagree.
 * ------------------------------------------------------------------------ */

export const HORDE_COORD_BIAS = 1024;
export function encodeCoord(v: number): number { return clamp(Math.round(v) + HORDE_COORD_BIAS, 0, 65535); }
export function decodeCoord(v: number): number { return v - HORDE_COORD_BIAS; }

/** `c` values on a `ModeEventKind.OBJECTIVE` event. */
export const HORDE_EV_HOLD = 1;      // a/b = hold x/z, text = '' — sent once at run start
export const HORDE_EV_SIEGE = 2;     // a/b = block x/z — something is chewing a wall
export const HORDE_EV_BREACH = 3;    // a/b = block x/z — a wall block just died
export const HORDE_EV_DOWNED = 4;    // playerId is down, a = lives left
export const HORDE_EV_REVIVED = 5;   // playerId is back up
export const HORDE_EV_RUN_OVER = 6;  // a = wave reached, b = kills, c code

/** `b` values on a `ModeEventKind.PAYOUT` event — why credits moved. */
export const HORDE_PAY_KILL = 0;
export const HORDE_PAY_WAVE = 1;
export const HORDE_PAY_SPEND = 2;
export const HORDE_PAY_BLOCK = 3;
export const HORDE_PAY_REFUSED = 4;
export const HORDE_PAY_SALVAGE = 5;

export type HordeEmit = (
  kind: ModeEventKind, playerId: number, a: number, b: number, c: number, text: string,
) => void;

/* ------------------------------------------------------------------------ *
 * 6. The fortification ledger
 *
 * Vanilla voxels have no hit points; a block is there or it is not. Horde needs
 * the middle state, because "the wall is going" is the tension the whole mode
 * runs on. One record per block that has either been placed by a player or been
 * bitten by a demon; natural terrain is registered lazily the first time
 * something attacks it, so nothing is paid for until it matters.
 * ------------------------------------------------------------------------ */

export interface FortRecord {
  x: number;
  y: number;
  z: number;
  /** The block that was there when the record was made. */
  blockId: number;
  hp: number;
  maxHp: number;
  /** Player id that placed it, or 0 for natural terrain. */
  owner: number;
}

/** Packed voxel key. x,z in [-256, 255], y in [0, 64). */
export function fortKey(x: number, y: number, z: number): number {
  return (((x + 256) & 0x1ff) << 15) | ((y & 0x3f) << 9) | ((z + 256) & 0x1ff);
}

export interface FortStats {
  /** Records currently held. */
  blocks: number;
  /** Blocks a player actually paid for. */
  owned: number;
  hp: number;
  maxHp: number;
}

export class FortLedger {
  private readonly records = new Map<number, FortRecord>();
  /** Blocks destroyed by demons since the run began. */
  breaches = 0;
  /** Blocks players have paid for since the run began. */
  built = 0;

  get size(): number { return this.records.size; }

  /** Record a freshly placed block. Overwrites any stale record at the cell. */
  register(x: number, y: number, z: number, blockId: number, owner: number): FortRecord {
    const key = fortKey(x, y, z);
    const maxHp = fortHpFor(blockId);
    let rec = this.records.get(key);
    if (rec === undefined) {
      rec = { x, y, z, blockId, hp: maxHp, maxHp, owner };
      this.records.set(key, rec);
    } else {
      rec.x = x; rec.y = y; rec.z = z;
      rec.blockId = blockId;
      rec.hp = maxHp;
      rec.maxHp = maxHp;
      rec.owner = owner;
    }
    if (owner !== 0) this.built++;
    return rec;
  }

  get(x: number, y: number, z: number): FortRecord | undefined {
    return this.records.get(fortKey(x, y, z));
  }

  /** Remaining hit points, or -1 when the cell is not tracked. */
  hpAt(x: number, y: number, z: number): number {
    const rec = this.records.get(fortKey(x, y, z));
    return rec === undefined ? -1 : rec.hp;
  }

  forget(x: number, y: number, z: number): FortRecord | undefined {
    const key = fortKey(x, y, z);
    const rec = this.records.get(key);
    if (rec !== undefined) this.records.delete(key);
    return rec;
  }

  /**
   * Take `amount` off the block at these coordinates, registering it against
   * `blockId` first if it was untracked natural terrain. Returns the hit points
   * left, or -1 when the cell holds nothing breakable.
   */
  damage(x: number, y: number, z: number, blockId: number, amount: number): number {
    const maxHp = fortHpFor(blockId);
    if (maxHp <= 0) return -1;
    const key = fortKey(x, y, z);
    let rec = this.records.get(key);
    if (rec === undefined || rec.blockId !== blockId) {
      rec = { x, y, z, blockId, hp: maxHp, maxHp, owner: rec !== undefined ? rec.owner : 0 };
      this.records.set(key, rec);
    }
    rec.hp -= amount;
    if (rec.hp <= 0) {
      rec.hp = 0;
      this.records.delete(key);
      this.breaches++;
      return 0;
    }
    return rec.hp;
  }

  /** Every damaged owned block within `radius` of a point, as a repair bill. */
  repairQuote(cx: number, cy: number, cz: number, radius: number, owner: number): { cost: number; blocks: number; hp: number } {
    const r2 = radius * radius;
    let cost = 0;
    let blocks = 0;
    let hp = 0;
    for (const rec of this.records.values()) {
      if (rec.owner !== owner && rec.owner !== 0) continue;
      if (rec.hp >= rec.maxHp) continue;
      const dx = rec.x + 0.5 - cx;
      const dy = rec.y + 0.5 - cy;
      const dz = rec.z + 0.5 - cz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const missing = rec.maxHp - rec.hp;
      cost += repairCostFor(missing, rec.maxHp, rec.blockId);
      hp += missing;
      blocks++;
    }
    return { cost, blocks, hp };
  }

  /** Apply the repair the quote described. Returns the blocks restored. */
  repairApply(cx: number, cy: number, cz: number, radius: number, owner: number): number {
    const r2 = radius * radius;
    let n = 0;
    for (const rec of this.records.values()) {
      if (rec.owner !== owner && rec.owner !== 0) continue;
      if (rec.hp >= rec.maxHp) continue;
      const dx = rec.x + 0.5 - cx;
      const dy = rec.y + 0.5 - cy;
      const dz = rec.z + 0.5 - cz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      rec.hp = rec.maxHp;
      n++;
    }
    return n;
  }

  stats(out?: FortStats): FortStats {
    const s = out ?? { blocks: 0, owned: 0, hp: 0, maxHp: 0 };
    s.blocks = 0; s.owned = 0; s.hp = 0; s.maxHp = 0;
    for (const rec of this.records.values()) {
      s.blocks++;
      if (rec.owner !== 0) s.owned++;
      s.hp += rec.hp;
      s.maxHp += rec.maxHp;
    }
    return s;
  }

  clear(): void {
    this.records.clear();
  }

  /**
   * Drop records whose voxel no longer matches — a rocket carved it, a player
   * dug it, or the round reset the world. Cheap enough to run once a second.
   */
  prune(getBlock: (x: number, y: number, z: number) => number, limit: number): number {
    let dropped = 0;
    for (const [key, rec] of this.records) {
      if (getBlock(rec.x, rec.y, rec.z) === rec.blockId) continue;
      this.records.delete(key);
      dropped++;
      if (dropped >= limit) break;
    }
    return dropped;
  }
}

/* ------------------------------------------------------------------------ *
 * 7. The director
 * ------------------------------------------------------------------------ */

/** Milliseconds a demon must fail to make progress before it blames a wall. */
export const SIEGE_STUCK_MS = 620;
/** Below this horizontal speed a demon that wants to move counts as blocked. */
export const SIEGE_STUCK_SPEED = 1.9;
/** How far in front of itself a demon looks for the thing in its way. */
export const SIEGE_REACH = 1.5;
/** How long a demon slides along a wall looking for the end of it. */
export const SIEGE_SKIRT_MS = 1500;
/** Lateral acceleration of that slide, m/s^2. */
export const SIEGE_SKIRT_ACCEL = 40;
/** Inside this distance it is fighting the player, not the wall. */
export const SIEGE_ENGAGE_DIST = 2.6;
/** Extra attack-cadence a fully aggressive wave grants (fraction of dt). */
export const HORDE_AGGRESSION_CADENCE = 0.6;
/** Metres of approach that count as "I found my way", cancelling a siege. */
export const SIEGE_PROGRESS = 1.5;
/** Milliseconds between "your wall is being chewed" pings. */
export const SIEGE_PING_MS = 900;

/** Siege state machine, one value per entity slot. */
export const SIEGE_FREE = 0;
export const SIEGE_SKIRT = 1;
export const SIEGE_BREACH = 2;

/** How far ahead a flyer notices a wall it needs to rise over. */
export const FLYER_PROBE_REACH = 3.0;
/** Metres of air a flyer wants above the thing it is crossing. */
export const FLYER_CLEARANCE = 1.6;
/** Vertical climb rate while crossing a fortification, m/s. */
export const FLYER_CLIMB_SPEED = 7.0;
/** Lives a run starts with, by skill. */
export const HORDE_LIVES: Uint8Array = new Uint8Array([5, 4, 3, 2, 1]);
/** The first fortify window is longer — you arrive with nothing built. */
export const HORDE_FIRST_BUILD_SCALE = 1.6;

export interface HordeDirectorOptions {
  sim: Simulation;
  monsters: MonsterManager;
  plan: ModeSimPlan;
  /** Room-wide event sink. Optional: the director is fully usable without one. */
  emit?: HordeEmit | null;
  /** Override the run seed. Defaults to `sim.seed`, which is what WELCOME carries. */
  seed?: number;
}

interface HordePlayerRun {
  id: number;
  credits: number;
  lives: number;
  downed: boolean;
  ready: boolean;
  /** Credits earned across the whole run, for the end card. */
  earned: number;
  spent: number;
  blocksPlaced: number;
  kills: number;
  state: ModePlayerState;
}

export interface HordeRunSummary {
  wave: number;
  waveReached: number;
  kills: number;
  score: number;
  creditsEarned: number;
  blocksPlaced: number;
  breaches: number;
  elapsedMs: number;
}

/**
 * Authoritative Horde. Owns the phase machine, the wave queue, spawn placement
 * and validation, the block economy and the siege behaviour that makes a
 * player-built wall a real obstacle rather than scenery.
 */
export class HordeDirector {
  readonly sim: Simulation;
  readonly monsters: MonsterManager;
  readonly plan: ModeSimPlan;
  readonly fort = new FortLedger();
  readonly composition: WaveComposition = createWaveComposition();
  /** The wave after this one — the client renders it during the fortify window. */
  readonly forecast: WaveComposition = createWaveComposition();

  phase: ModePhase = ModePhase.LOADING;
  wave = 0;
  waveKills = 0;
  runKills = 0;
  score = 0;
  elapsedMs = 0;
  buildMsLeft = 0;
  failed = false;

  /** The position every wave converges on. -1 until the first live player. */
  holdX = 0;
  holdY = -1;
  holdZ = 0;

  private readonly seed: number;
  private readonly emit: HordeEmit | null;
  private readonly players = new Map<number, HordePlayerRun>();
  private readonly room: ModeRoomState = createModeRoomState();
  private readonly tracker: ModeStateTracker;

  /* --- wave queue --- */
  private pending = 0;
  private orderCursor = 0;
  private spawnTimer = 0;
  private gateCursor = 0;

  /* --- per-entity-slot siege state, all preallocated --- */
  private readonly siegeMode = new Uint8Array(MAX_ENTITIES);
  private readonly siegeCd = new Float32Array(MAX_ENTITIES);
  private readonly siegeWindup = new Float32Array(MAX_ENTITIES);
  private readonly siegeX = new Int16Array(MAX_ENTITIES);
  private readonly siegeY = new Uint8Array(MAX_ENTITIES);
  private readonly siegeZ = new Int16Array(MAX_ENTITIES);
  private readonly stuckMs = new Float32Array(MAX_ENTITIES);
  private readonly lastDist = new Float32Array(MAX_ENTITIES);
  private readonly bestDist = new Float32Array(MAX_ENTITIES);
  private readonly siegeTarget = new Uint16Array(MAX_ENTITIES);
  private readonly skirtDir = new Int8Array(MAX_ENTITIES);
  private readonly skirtMs = new Float32Array(MAX_ENTITIES);
  private readonly skirtTried = new Uint8Array(MAX_ENTITIES);
  private readonly spawnGate = new Uint8Array(MAX_ENTITIES);

  /* --- death detection shadow, one tick behind --- */
  private readonly shadowId = new Uint16Array(MAX_ENTITIES);
  private readonly shadowType = new Uint8Array(MAX_ENTITIES);
  private readonly shadowKiller = new Uint16Array(MAX_ENTITIES);

  /* --- block journal cursor --- */
  private journalTick = -1;
  private journalCursor = 0;

  private siegePingMs = 0;
  private pruneMs = 0;
  /** Probe result, written by `probe()` and read by the caller. */
  private probeX = 0;
  private probeY = 0;
  private probeZ = 0;
  private probeId = 0;

  constructor(options: HordeDirectorOptions) {
    this.sim = options.sim;
    this.monsters = options.monsters;
    this.plan = options.plan;
    this.emit = options.emit ?? null;
    this.seed = (options.seed ?? this.sim.seed) >>> 0;
    this.tracker = new ModeStateTracker(this.plan);

    // The director owns spawning outright; the ambient population director in
    // bots.ts must not also be topping the map up behind our back.
    this.monsters.budget.target = 0;
    this.monsters.budget.spawnIntervalMs = this.plan.enemySpawnIntervalMs;
    this.monsters.budget.maxTier = 4;
    this.sim.defaultWeaponMask = this.plan.startWeaponMask;

    this.lastDist.fill(-1);
    this.bestDist.fill(-1);
    composeWave(1, this.plan.skill, 1, this.seed, this.forecast);
  }

  /* -------------------------------------------------------------- *
   * Membership
   * -------------------------------------------------------------- */

  addPlayer(id: number): void {
    if (this.players.has(id)) return;
    const run: HordePlayerRun = {
      id,
      credits: HORDE_START_CREDITS,
      lives: HORDE_LIVES[clamp(this.plan.skill, 0, 4)],
      downed: false,
      ready: false,
      earned: 0,
      spent: 0,
      blocksPlaced: 0,
      kills: 0,
      state: createModePlayerState(),
    };
    this.players.set(id, run);
    this.tracker.add(id);
    const p = this.sim.getPlayer(id);
    if (p !== undefined) this.equipStart(p);
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    this.tracker.remove(id);
  }

  /** The run loadout — the shotgun is the starting gun, everything else is bought. */
  private equipStart(p: PlayerEntity): void {
    p.weaponMask = this.plan.startWeaponMask;
    for (let i = 0; i < WEAPON_COUNT; i++) {
      if (ownsWeapon(p.weaponMask, i)) p.mag[i] = getWeapon(i).magSize;
    }
    if (ownsWeapon(p.weaponMask, this.plan.startWeapon)) p.weapon = this.plan.startWeapon;
  }

  creditsOf(id: number): number { return this.players.get(id)?.credits ?? 0; }
  livesOf(id: number): number { return this.players.get(id)?.lives ?? 0; }
  get playerCount(): number { return this.players.size; }
  get aliveMonsters(): number { return this.monsters.liveCount; }
  get pendingSpawns(): number { return this.pending; }
  get holdKnown(): boolean { return this.holdY >= 0; }

  /* -------------------------------------------------------------- *
   * The tick
   *
   * Call once per simulation tick, AFTER `sim.stepTick` and BEFORE
   * `net.flush()`. See the wiring note at the top of the file.
   * -------------------------------------------------------------- */

  step(dtMs: number): void {
    this.elapsedMs += dtMs;

    this.reapDeaths();
    this.chargeJournal();

    if (!this.ensureHold()) {
      this.phase = ModePhase.LOADING;
      this.publish();
      return;
    }

    if (this.phase === ModePhase.LOADING) this.beginBuildPhase(true);

    switch (this.phase) {
      case ModePhase.BUILD:
        this.stepBuildPhase(dtMs);
        break;
      case ModePhase.LIVE:
        this.stepWave(dtMs);
        break;
      default:
        break;
    }

    this.stepDowned();
    this.siegeStep(dtMs);
    this.aggressionStep(dtMs);
    this.shadowStep();

    this.pruneMs -= dtMs;
    if (this.pruneMs <= 0) {
      this.pruneMs = 1000;
      this.fort.prune(this.sim.world.getBlockAt, 64);
    }
    if (this.siegePingMs > 0) this.siegePingMs -= dtMs;

    this.publish();
  }

  /* -------------------------------------------------------------- *
   * The hold point
   * -------------------------------------------------------------- */

  /**
   * Pick the position the run defends, once. Everything else — gates, spawn
   * ring, revive point, the value of a wall — hangs off this never moving.
   */
  private ensureHold(): boolean {
    if (this.holdY >= 0) return true;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (let i = 0; i < this.sim.players.length; i++) {
      const p = this.sim.players[i];
      if (!p.active || p.dead) continue;
      sx += p.pos[0];
      sz += p.pos[2];
      n++;
    }
    if (n === 0) return false;
    const cx = Math.round(sx / n);
    const cz = Math.round(sz / n);
    const world = this.sim.world;
    for (let r = 0; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = cx + dx * 2;
          const z = cz + dz * 2;
          if (!world.hasChunk(blockToChunk(x), blockToChunk(z))) continue;
          const y = world.standableY(x, z);
          if (y < 0) continue;
          this.holdX = x + 0.5;
          this.holdY = y;
          this.holdZ = z + 0.5;
          this.emitEvent(ModeEventKind.OBJECTIVE, 0,
            encodeCoord(this.holdX), encodeCoord(this.holdZ), HORDE_EV_HOLD,
            'Hold this position');
          return true;
        }
      }
    }
    return false;
  }

  /* -------------------------------------------------------------- *
   * Phases
   * -------------------------------------------------------------- */

  private beginBuildPhase(first: boolean): void {
    this.phase = ModePhase.BUILD;
    const base = this.plan.buildPhaseMs > 0 ? this.plan.buildPhaseMs : 30_000;
    this.buildMsLeft = Math.round(first ? base * HORDE_FIRST_BUILD_SCALE : base);
    for (const run of this.players.values()) run.ready = false;
    composeWave(this.wave + 1, this.plan.skill, Math.max(1, this.players.size), this.seed, this.forecast);
    this.emitEvent(ModeEventKind.BUILD_PHASE, 0,
      Math.round(this.buildMsLeft / 1000), this.wave + 1, this.forecast.gateMask, '');
  }

  private stepBuildPhase(dtMs: number): void {
    this.buildMsLeft -= dtMs;
    let allReady = this.players.size > 0;
    for (const run of this.players.values()) {
      if (!run.ready) { allReady = false; break; }
    }
    if (allReady && this.buildMsLeft > 900) this.buildMsLeft = 900;
    if (this.buildMsLeft > 0) return;
    this.buildMsLeft = 0;
    this.beginWave();
  }

  private beginWave(): void {
    this.wave++;
    this.waveKills = 0;
    composeWave(this.wave, this.plan.skill, Math.max(1, this.players.size), this.seed, this.composition);
    this.pending = this.composition.total;
    this.orderCursor = 0;
    this.spawnTimer = 900;
    this.gateCursor = 0;
    this.phase = ModePhase.LIVE;

    // Everyone with a life left is back on their feet for the fight.
    for (const run of this.players.values()) {
      if (run.downed && run.lives > 0) this.revive(run);
    }

    this.emitEvent(ModeEventKind.WAVE_INCOMING, 0,
      this.wave, this.composition.total,
      (this.composition.archMask & 0x1f) | (this.composition.boss ? 1 << 5 : 0) | (this.composition.gateMask << 6),
      this.composition.boss ? 'BOSS WAVE' : '');
  }

  private stepWave(dtMs: number): void {
    this.spawnPump(dtMs);
    if (this.pending > 0 || this.monsters.liveCount > 0) return;
    this.endWave();
  }

  private endWave(): void {
    const payout = this.composition.payout;
    for (const run of this.players.values()) {
      if (run.lives <= 0) continue;
      this.pay(run, payout, HORDE_PAY_WAVE);
    }
    this.score += Math.round(this.composition.threat * 10);
    this.emitEvent(ModeEventKind.WAVE_CLEARED, 0, this.wave, this.waveKills, payout, '');

    if (this.plan.finalWave > 0 && this.wave >= this.plan.finalWave) {
      this.phase = this.plan.runIntermission ? ModePhase.INTERMISSION : ModePhase.GAME_OVER;
      this.room.objectiveDone = true;
      this.emitEvent(ModeEventKind.LEVEL_COMPLETE, 0, this.wave, this.runKills, this.score, '');
      return;
    }
    this.beginBuildPhase(false);
  }

  /** End the run. Nothing restarts it but an explicit `restart()`. */
  private endRun(): void {
    if (this.failed) return;
    this.failed = true;
    this.phase = ModePhase.GAME_OVER;
    this.room.failed = true;
    this.emitEvent(ModeEventKind.LEVEL_FAILED, 0, this.wave, this.runKills, this.score, '');
    this.emitEvent(ModeEventKind.OBJECTIVE, 0, this.wave, this.runKills, HORDE_EV_RUN_OVER, 'Overrun');
  }

  /** Wipe the run back to wave 0 and a fresh fortify window. */
  restart(): void {
    this.fort.clear();
    this.wave = 0;
    this.waveKills = 0;
    this.runKills = 0;
    this.score = 0;
    this.elapsedMs = 0;
    this.pending = 0;
    this.failed = false;
    this.room.failed = false;
    this.room.objectiveDone = false;
    for (const run of this.players.values()) {
      run.credits = HORDE_START_CREDITS;
      run.lives = HORDE_LIVES[clamp(this.plan.skill, 0, 4)];
      run.downed = false;
      run.ready = false;
      run.earned = 0;
      run.spent = 0;
      run.blocksPlaced = 0;
      run.kills = 0;
      const p = this.sim.getPlayer(run.id);
      if (p !== undefined) { this.equipStart(p); this.revive(run); }
    }
    this.beginBuildPhase(true);
  }

  /* -------------------------------------------------------------- *
   * Spawning — placement and validation
   * -------------------------------------------------------------- */

  private spawnPump(dtMs: number): void {
    if (this.pending <= 0) return;
    this.spawnTimer -= dtMs;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = this.composition.spawnIntervalMs;

    const headroom = this.composition.aliveCap - this.monsters.liveCount;
    if (headroom <= 0) return;
    let releases = Math.min(this.composition.burst, headroom, this.pending);
    while (releases > 0) {
      if (!this.spawnNext()) break;
      releases--;
    }
  }

  /** Release the next queued body at a validated point on a hot gate. */
  private spawnNext(): boolean {
    if (this.pending <= 0 || this.orderCursor >= this.composition.total) return false;
    const type = this.composition.order[this.orderCursor];
    const def = hordeEnemy(type);
    if (def === undefined) { this.orderCursor++; this.pending--; return false; }

    const gate = def.flying
      // Flyers come over the top from anywhere; the gates are a ground concept.
      ? (hash3i(this.seed, this.wave, this.orderCursor, 0x71c3) % HORDE_GATE_COUNT)
      : this.nextHotGate();

    const slot = this.placeSpawn(def, gate);
    if (slot < 0) return false;               // retry on the next beat

    this.spawnGate[slot] = gate;
    this.orderCursor++;
    this.pending--;
    return true;
  }

  private nextHotGate(): number {
    const mask = this.composition.gateMask;
    if (mask === 0) return 0;
    for (let i = 0; i < HORDE_GATE_COUNT; i++) {
      const g = (this.gateCursor + i) % HORDE_GATE_COUNT;
      if (gateIsHot(mask, g)) {
        this.gateCursor = (g + 1) % HORDE_GATE_COUNT;
        return g;
      }
    }
    return 0;
  }

  /**
   * Spawn validation. A point is only good if the chunk exists, the column can
   * hold a body, it is outside the hold's safe radius, and no living player is
   * standing on top of it. Twelve jittered tries around the gate, then give up
   * for this beat rather than teleport something into a player's face.
   */
  private placeSpawn(def: HordeEnemyDef, gate: number): number {
    const world = this.sim.world;
    const baseX = this.holdX + gateOffsetX(gate, HORDE_GATE_RADIUS);
    const baseZ = this.holdZ + gateOffsetZ(gate, HORDE_GATE_RADIUS);

    for (let attempt = 0; attempt < 12; attempt++) {
      const h = hash3i(this.seed ^ 0x2f1a, this.wave * 97 + this.orderCursor, attempt, 0x51b7);
      const jitterX = ((h & 0xff) / 255 - 0.5) * 12;
      const jitterZ = (((h >>> 8) & 0xff) / 255 - 0.5) * 12;
      const x = Math.round(baseX + jitterX);
      const z = Math.round(baseZ + jitterZ);

      if (!world.hasChunk(blockToChunk(x), blockToChunk(z))) continue;
      const y = world.standableY(x, z);
      if (y < 0) continue;
      if (y + 3 >= CHUNK_HEIGHT) continue;

      const hdx = x + 0.5 - this.holdX;
      const hdz = z + 0.5 - this.holdZ;
      if (hdx * hdx + hdz * hdz < HORDE_HOLD_SAFE_RADIUS * HORDE_HOLD_SAFE_RADIUS) continue;

      let tooClose = false;
      for (let i = 0; i < this.sim.players.length; i++) {
        const p = this.sim.players[i];
        if (!p.active || p.dead) continue;
        const dx = p.pos[0] - (x + 0.5);
        const dz = p.pos[2] - (z + 0.5);
        if (dx * dx + dz * dz < HORDE_SPAWN_CLEARANCE * HORDE_SPAWN_CLEARANCE) { tooClose = true; break; }
      }
      if (tooClose) continue;

      const spawnY = def.flying ? y + 2.4 : y;
      const slot = this.monsters.spawnAt(def.type, x + 0.5, spawnY, z + 0.5);
      if (slot < 0) return -1;
      this.clearSiegeSlot(slot);
      return slot;
    }
    return -1;
  }

  /* -------------------------------------------------------------- *
   * Kills and payouts
   * -------------------------------------------------------------- */

  /**
   * Compare this tick's entity table against the shadow taken at the end of the
   * previous tick. A slot that changed identity held a monster that is gone;
   * `sim.removedEntity*` (still un-drained at this point in the tick) says
   * whether it was killed or culled, and the shadow's last attacker — which
   * `Simulation.damageEntity` writes into `entTarget` — says who gets paid.
   */
  private reapDeaths(): void {
    const sim = this.sim;
    for (let slot = 0; slot < MAX_ENTITIES; slot++) {
      const was = this.shadowId[slot];
      if (was === 0) continue;
      if (sim.entActive[slot] === 1 && sim.entId[slot] === was) continue;

      this.shadowId[slot] = 0;
      const type = this.shadowType[slot];
      const def = hordeEnemy(type);
      this.clearSiegeSlot(slot);
      if (def === undefined) continue;

      let reason = RemoveReason.DESPAWNED;
      for (let r = 0; r < sim.removedEntityCount; r++) {
        if (sim.removedEntityId[r] === was) { reason = sim.removedEntityReason[r]; break; }
      }

      if (reason !== RemoveReason.KILLED) {
        // Culled for being stranded: hand the body back to the queue so the
        // wave still has to be fought, it does not just evaporate.
        if (this.phase === ModePhase.LIVE && this.orderCursor > 0) {
          this.orderCursor--;
          this.pending++;
        }
        continue;
      }

      this.waveKills++;
      this.runKills++;
      this.score += def.payout;
      const killer = this.players.get(this.shadowKiller[slot]);
      if (killer !== undefined) {
        killer.kills++;
        const amount = Math.round(
          def.payout * (1 + this.wave * 0.03) * HORDE_SKILL_PAYOUT[clamp(this.plan.skill, 0, 4)],
        );
        this.pay(killer, amount, HORDE_PAY_KILL);
      }
    }
  }

  /** Snapshot the live monsters so the next tick can spot the ones that died. */
  private shadowStep(): void {
    const sim = this.sim;
    for (let slot = 0; slot < MAX_ENTITIES; slot++) {
      if (sim.entActive[slot] !== 1 || sim.entType[slot] >= EntityType.PICKUP_HEALTH) {
        this.shadowId[slot] = 0;
        continue;
      }
      this.shadowId[slot] = sim.entId[slot];
      this.shadowType[slot] = sim.entType[slot];
      // damageEntity() parks the last attacker here; a monster that has never
      // been hit keeps whatever it was hunting, which is the same player.
      this.shadowKiller[slot] = sim.entTarget[slot];
    }
  }

  private pay(run: HordePlayerRun, amount: number, reason: number): void {
    if (amount === 0) return;
    const before = run.credits;
    run.credits = clamp(run.credits + amount, 0, HORDE_MAX_CREDITS);
    const delta = run.credits - before;
    if (delta > 0) run.earned += delta;
    else run.spent -= delta;
    this.emitEvent(ModeEventKind.PAYOUT, run.id, Math.abs(delta), reason, run.credits, '');
  }

  /* -------------------------------------------------------------- *
   * The block economy — charged off the world's own journal
   * -------------------------------------------------------------- */

  /**
   * Every voxel the world changed this tick, with the player id that caused it.
   * Placements are charged and registered as fortification; a player who cannot
   * pay has the placement REVERTED, which streams the correction straight back
   * through the normal block-delta path. Breaks by the owner salvage part of the
   * value back. Changes with no player behind them (rocket carve, a demon
   * finishing a wall) simply retire the record.
   */
  private chargeJournal(): void {
    const world = this.sim.world;
    const journal = world.journal;
    if (this.journalTick !== this.sim.tick) {
      this.journalTick = this.sim.tick;
      this.journalCursor = 0;
    }
    // `journal.count` grows while we walk it — a refused placement writes its
    // own revert into the same journal. Those land with `by === 0` and are
    // handled by the world branch below, so re-reading the bound is correct.
    for (let i = this.journalCursor; i < journal.count; i++) {
      const by = journal.by[i];
      const id = journal.id[i];
      const x = journal.x[i];
      const y = journal.y[i];
      const z = journal.z[i];
      const run = by !== 0 ? this.players.get(by) : undefined;

      if (run === undefined) {
        if (id === BlockId.AIR) this.fort.forget(x, y, z);
        continue;
      }

      if (id !== BlockId.AIR) {
        const cost = blockCost(id) * (this.phase === ModePhase.LIVE ? HORDE_COMBAT_PREMIUM : 1);
        if (cost > run.credits) {
          world.setBlock(x, y, z, BlockId.AIR, 0);
          this.fort.forget(x, y, z);
          this.emitEvent(ModeEventKind.PAYOUT, run.id, cost, HORDE_PAY_REFUSED, run.credits, '');
          continue;
        }
        run.credits -= cost;
        run.spent += cost;
        run.blocksPlaced++;
        this.fort.register(x, y, z, id, run.id);
        this.emitEvent(ModeEventKind.PAYOUT, run.id, cost, HORDE_PAY_BLOCK, run.credits, '');
        continue;
      }

      const rec = this.fort.forget(x, y, z);
      if (rec !== undefined && rec.owner !== 0) {
        const refund = Math.max(0, Math.round(blockCost(rec.blockId) * (rec.hp / rec.maxHp) * HORDE_SALVAGE));
        if (refund > 0) this.pay(run, refund, HORDE_PAY_SALVAGE);
      }
    }
    this.journalCursor = journal.count;
  }

  /* -------------------------------------------------------------- *
   * Downed players — RespawnPolicy.NEXT_WAVE without touching sim.ts
   * -------------------------------------------------------------- */

  private stepDowned(): void {
    let anyUp = false;
    let anyPlayer = false;
    for (const run of this.players.values()) {
      const p = this.sim.getPlayer(run.id);
      if (p === undefined || !p.active) continue;
      anyPlayer = true;

      if (p.dead) {
        if (!run.downed) {
          run.downed = true;
          run.lives = Math.max(0, run.lives - 1);
          this.emitEvent(ModeEventKind.OBJECTIVE, run.id, run.lives, 0, HORDE_EV_DOWNED, '');
        }
        // Hold the body down: Simulation.stepTick respawns at `respawnAtMs`,
        // and in Horde you are out until the wave ends.
        p.respawnAtMs = this.sim.nowMs + 3_600_000;
        continue;
      }

      anyUp = true;
      if (run.downed) run.downed = false;
    }
    if (anyPlayer && !anyUp && !this.failed && this.phase === ModePhase.LIVE) this.endRun();
  }

  /**
   * Stand a downed player back up at the hold, keeping everything they bought.
   * Deliberately NOT `Simulation.spawnPlayer`, which resets the weapon mask and
   * would confiscate the rocket launcher they spent a whole wave earning.
   */
  private revive(run: HordePlayerRun): void {
    const p = this.sim.getPlayer(run.id);
    if (p === undefined) return;
    run.downed = false;
    p.dead = false;
    p.health = MAX_HEALTH;
    p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
    p.pos[0] = this.holdX;
    p.pos[1] = this.holdY + 0.05;
    p.pos[2] = this.holdZ;
    p.onGround = true;
    p.crouching = false;
    p.spawnProtectUntilMs = this.sim.nowMs + 2500;
    p.respawnAtMs = this.sim.nowMs;
    p.breath = 14;
    p.histCount = 0;
    p.histHead = 0;
    p.pushHistory(this.sim.nowMs);
    this.emitEvent(ModeEventKind.OBJECTIVE, run.id, run.lives, 0, HORDE_EV_REVIVED, '');
  }

  /* -------------------------------------------------------------- *
   * THE INTERLOCK — geometry as an enemy of the pathfinder
   * -------------------------------------------------------------- */

  /**
   * Everything the coarse flow field cannot express.
   *
   * `NavField` samples one column per 4x4 block cell, so it sees a bunker but
   * routinely misses a one-block-thick wall — and even when it does see one, a
   * monster with line of sight beelines and ignores the field entirely. The
   * result either way is a demon grinding its face against something a player
   * built. This turns that grind into the mode's core loop:
   *
   *   no progress for SIEGE_STUCK_MS
   *     -> probe the voxels between me and my target
   *     -> if the wall has an end nearby, SLIDE along it (repath, locally)
   *     -> otherwise wind up, telegraph, and hit the block until it dies
   *
   * Flyers return immediately: a wall is not their problem.
   */
  private siegeStep(dtMs: number): void {
    const sim = this.sim;
    const dt = dtMs / 1000;
    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (sim.entActive[i] !== 1) continue;
      const type = sim.entType[i];
      if (type >= EntityType.PICKUP_HEALTH) continue;
      const def = hordeEnemy(type);
      if (def === undefined) continue;

      if (def.flying || def.siegeDamage <= 0) {
        // Cacodemons and Lost Souls are the answer to a wall. They never stall,
        // never probe for something to bite and can never take a hit point off
        // a block — they climb the fortification's own height and cross it.
        if (this.siegeMode[i] !== SIEGE_FREE) this.clearSiegeSlot(i);
        const flyTarget = this.nearestTarget(i);
        if (flyTarget !== null) this.flyOver(i, flyTarget.pos[0], flyTarget.pos[2], dt);
        continue;
      }

      const target = this.nearestTarget(i);
      if (target === null) { this.clearSiegeSlot(i); continue; }

      const ex = sim.entX[i];
      const ez = sim.entZ[i];
      const tdx = target.pos[0] - ex;
      const tdz = target.pos[2] - ez;
      const dist = Math.sqrt(tdx * tdx + tdz * tdz);

      // A new victim invalidates every "am I getting closer" measurement.
      if (this.siegeTarget[i] !== target.id) {
        this.siegeTarget[i] = target.id;
        this.clearSiegeSlot(i);
        this.bestDist[i] = dist;
      }

      // Inside this range it is fighting the player, not the geometry.
      if (dist <= SIEGE_ENGAGE_DIST) {
        if (this.siegeMode[i] !== SIEGE_FREE) this.clearSiegeSlot(i);
        this.bestDist[i] = dist;
        this.lastDist[i] = dist;
        continue;
      }

      // Real progress cancels everything: the demon found its way.
      if (this.bestDist[i] < 0 || dist < this.bestDist[i] - SIEGE_PROGRESS) {
        this.bestDist[i] = dist;
        this.skirtTried[i] = 0;
        if (this.siegeMode[i] !== SIEGE_FREE) this.clearSiegeSlot(i);
      }

      switch (this.siegeMode[i]) {
        case SIEGE_BREACH:
          this.stepBreach(i, def, dtMs, target.pos[0], target.pos[2]);
          break;
        case SIEGE_SKIRT:
          this.stepSkirt(i, dtMs, dt, target.pos[0], target.pos[2]);
          break;
        default:
          this.stepBlocked(i, dtMs, dist, target.pos[0], target.pos[2]);
          break;
      }
      this.lastDist[i] = dist;
    }
  }

  /**
   * Free running. Watch for a demon that wants to move and is not moving, and
   * decide what is in its way.
   */
  private stepBlocked(i: number, dtMs: number, dist: number, tx: number, tz: number): void {
    const sim = this.sim;
    const vx = sim.entVX[i];
    const vz = sim.entVZ[i];
    const speed = Math.sqrt(vx * vx + vz * vz);
    const prev = this.lastDist[i];
    const stalled = speed < SIEGE_STUCK_SPEED || (prev >= 0 && dist > prev - 0.03);

    if (this.siegeCd[i] > 0) this.siegeCd[i] -= dtMs;
    if (!stalled) {
      this.stuckMs[i] = Math.max(0, this.stuckMs[i] - dtMs * 2);
      return;
    }

    this.stuckMs[i] += dtMs;
    if (this.stuckMs[i] < SIEGE_STUCK_MS) return;

    if (!this.probe(i, tx, tz)) {
      // Stuck on something that is not geometry — a ledge, a pile of bodies.
      // bots.ts already hops out of those; leave it be.
      this.stuckMs[i] = 0;
      return;
    }

    // Walls have ends. Try to find this one's before resorting to teeth.
    if (this.skirtTried[i] === 0) {
      const dir = this.chooseSkirt(i, tx, tz);
      this.skirtTried[i] = 1;
      if (dir !== 0) {
        this.skirtDir[i] = dir;
        this.skirtMs[i] = SIEGE_SKIRT_MS;
        this.siegeMode[i] = SIEGE_SKIRT;
        return;
      }
    }

    this.siegeMode[i] = SIEGE_BREACH;
    this.siegeWindup[i] = 0;
    this.stuckMs[i] = 0;
  }

  /** Shoulder along the obstruction, looking for the end of it. */
  private stepSkirt(i: number, dtMs: number, dt: number, tx: number, tz: number): void {
    this.skirtMs[i] -= dtMs;
    this.applySkirt(i, tx, tz, dt);
    if (this.skirtMs[i] > 0) return;
    // The wall had no end within reach. Commit on the next tick.
    this.skirtMs[i] = 0;
    this.siegeMode[i] = SIEGE_FREE;
    this.stuckMs[i] = SIEGE_STUCK_MS;
  }

  /**
   * Committed. Wind up (visible to the player through ES_WINDUP), swing, take a
   * bite out of the block, and when it dies put a hole in the world through the
   * ordinary `setBlock` path so every downstream system — the block-delta
   * stream, the mesher, the nav field — reacts on its own.
   */
  private stepBreach(i: number, def: HordeEnemyDef, dtMs: number, tx: number, tz: number): void {
    const sim = this.sim;
    sim.entState[i] |= ES_ALERT_BIT;

    if (this.siegeWindup[i] > 0) {
      this.siegeWindup[i] -= dtMs;
      sim.entState[i] |= ES_WINDUP_BIT;
      const hold = Math.max(0, this.siegeWindup[i]) + 40;
      if (sim.entAttackCd[i] < hold) sim.entAttackCd[i] = hold;
      if (this.siegeWindup[i] > 0) return;
      this.siegeWindup[i] = 0;
      sim.entState[i] &= ~ES_WINDUP_BIT;
      this.strike(i, def);
      return;
    }

    if (this.siegeCd[i] > 0) { this.siegeCd[i] -= dtMs; return; }

    // Line up the next swing. Nothing left to hit means the way is open.
    if (!this.probe(i, tx, tz)) {
      this.clearSiegeSlot(i);
      return;
    }
    this.siegeX[i] = this.probeX;
    this.siegeY[i] = this.probeY;
    this.siegeZ[i] = this.probeZ;
    this.siegeWindup[i] = def.siegeWindupMs;
    this.siegeCd[i] = def.siegeIntervalMs + def.siegeWindupMs;
    sim.entState[i] |= ES_WINDUP_BIT;
    // Stop bots.ts starting a player attack inside our wind-up window.
    const hold = def.siegeWindupMs + 40;
    if (sim.entAttackCd[i] < hold) sim.entAttackCd[i] = hold;

    if (this.siegePingMs <= 0) {
      this.siegePingMs = SIEGE_PING_MS;
      this.emitEvent(ModeEventKind.OBJECTIVE, 0,
        encodeCoord(this.probeX), encodeCoord(this.probeZ), HORDE_EV_SIEGE, '');
    }
  }

  /** The swing lands. This is where a wall loses hit points. */
  private strike(i: number, def: HordeEnemyDef): void {
    const sim = this.sim;
    sim.entState[i] |= ES_ATTACK_BIT;

    const bx = this.siegeX[i];
    const by = this.siegeY[i];
    const bz = this.siegeZ[i];
    const world = sim.world;
    const id = world.getBlock(bx, by, bz);
    if (BLOCK_SOLID[id] !== 1 || BLOCK_HARDNESS[id] < 0) return;

    const left = this.fort.damage(bx, by, bz, id, def.siegeDamage);
    if (left !== 0) return;

    // The wall is gone. Going through ServerWorld.setBlock is the point: it
    // journals the change, ships a BLOCK_DELTA to every client, and bumps
    // editSerial, which is what makes NavField re-flood through the new hole.
    world.setBlock(bx, by, bz, BlockId.AIR, 0);
    this.emitEvent(ModeEventKind.OBJECTIVE, 0,
      encodeCoord(bx), encodeCoord(bz), HORDE_EV_BREACH, '');
  }

  /**
   * FLYERS IGNORE IT.
   *
   * bots.ts parks a flyer at head height above its target, which is *below* the
   * top of a serious wall — so without this it would press its face against the
   * same stone the ground demons are chewing, and the mode's one hard counter
   * to fortification would not exist. When geometry is in front of a flyer it
   * simply climbs that geometry's own height and keeps coming.
   */
  private flyOver(i: number, tx: number, tz: number, dt: number): void {
    const sim = this.sim;
    // Probe across the flyer's OWN body band, not a walker's feet-and-chest:
    // a flyer that has already risen most of the way still has its belly in the
    // wall, and it has to keep climbing until the whole box is clear.
    const h = sim.entHeight[i];
    if (!this.probe(i, tx, tz, FLYER_PROBE_REACH, 0.15, Math.max(0.3, h - 0.15))) return;
    const world = sim.world;
    const ey = sim.entY[i];
    const from = Math.max(1, Math.floor(ey) - 2);
    const to = Math.min(CHUNK_HEIGHT - 2, Math.floor(ey) + 9);
    let top = -1;
    for (let y = from; y <= to; y++) {
      if (world.isSolid(this.probeX, y, this.probeZ)) top = y;
    }
    if (top < 0) return;
    const wantY = Math.min(CHUNK_HEIGHT - 4, top + FLYER_CLEARANCE);
    if (ey >= wantY) return;
    sim.entY[i] = Math.min(wantY, ey + FLYER_CLIMB_SPEED * dt);
    if (sim.entVY[i] < 0) sim.entVY[i] = 0;
    sim.entState[i] |= ES_MOVING_BIT | ES_ALERT_BIT;
  }

  /**
   * The first solid, breakable voxel between this monster and its target,
   * within `reach`. Feet height is tested before chest height so the first hole
   * a demon makes is one it can walk through.
   */
  private probe(
    i: number, tx: number, tz: number,
    reach = SIEGE_REACH, low = 0.55, high = 1.35,
  ): boolean {
    const sim = this.sim;
    const ex = sim.entX[i];
    const ey = sim.entY[i];
    const ez = sim.entZ[i];
    let dx = tx - ex;
    let dz = tz - ez;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-4) return false;
    dx /= d;
    dz /= d;

    const world = sim.world;
    const start = sim.entHalfW[i] + 0.2;
    const end = sim.entHalfW[i] + reach;
    for (let s = start; s <= end; s += 0.35) {
      const px = ex + dx * s;
      const pz = ez + dz * s;
      for (let h = 0; h < 2; h++) {
        const by = Math.floor(ey + (h === 0 ? low : high));
        if (by < 1 || by >= CHUNK_HEIGHT) continue;
        const bx = Math.floor(px);
        const bz = Math.floor(pz);
        const id = world.getBlock(bx, by, bz);
        if (BLOCK_SOLID[id] !== 1) continue;
        if (BLOCK_HARDNESS[id] < 0) continue;      // bedrock is not on the menu
        this.probeX = bx;
        this.probeY = by;
        this.probeZ = bz;
        this.probeId = id;
        return true;
      }
    }
    return false;
  }

  /**
   * Is there an open side within five metres that gets us closer? Returns -1 or
   * +1 for the lateral direction to slide, or 0 for "this thing is sealed".
   */
  private chooseSkirt(i: number, tx: number, tz: number): number {
    const sim = this.sim;
    const ex = sim.entX[i];
    const ey = sim.entY[i];
    const ez = sim.entZ[i];
    let dx = tx - ex;
    let dz = tz - ez;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d;
    dz /= d;
    const px = -dz;
    const pz = dx;

    const here = this.monsters.nav.distanceAt(ex, ez);
    let best = 0;
    let bestScore = 0;
    for (let s = -1; s <= 1; s += 2) {
      let run = 0;
      for (let r = 1.5; r <= 5.0; r += 1.0) {
        const cx = ex + px * s * r;
        const cz = ez + pz * s * r;
        if (this.bodyBlocked(cx, ey, cz)) break;
        run = r;
      }
      if (run < 2.5) continue;
      const nx = ex + px * s * run;
      const nz = ez + pz * s * run;
      const there = this.monsters.nav.distanceAt(nx, nz);
      const opens = there >= 0 && (here < 0 || there < here);
      const score = run + (opens ? 10 : 0);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /**
   * Nudge a blocked monster sideways. bots.ts re-accelerates toward its own
   * wish every tick, so this reads as a demon shouldering along the wall rather
   * than teleporting — and it costs one add per axis, no re-implementation of
   * the steering it already owns.
   */
  private applySkirt(i: number, tx: number, tz: number, dt: number): void {
    const sim = this.sim;
    const dir = this.skirtDir[i];
    if (dir === 0) return;
    let dx = tx - sim.entX[i];
    let dz = tz - sim.entZ[i];
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d;
    dz /= d;
    const push = SIEGE_SKIRT_ACCEL * dt * dir;
    sim.entVX[i] += -dz * push;
    sim.entVZ[i] += dx * push;
    sim.entState[i] |= ES_MOVING_BIT;
  }

  private bodyBlocked(x: number, y: number, z: number): boolean {
    const world = this.sim.world;
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    return world.isSolid(bx, Math.floor(y + 0.55), bz) || world.isSolid(bx, Math.floor(y + 1.35), bz);
  }

  private clearSiegeSlot(i: number): void {
    this.siegeMode[i] = SIEGE_FREE;
    this.siegeCd[i] = 0;
    this.siegeWindup[i] = 0;
    this.stuckMs[i] = 0;
    this.lastDist[i] = -1;
    this.bestDist[i] = -1;
    this.skirtDir[i] = 0;
    this.skirtMs[i] = 0;
    this.skirtTried[i] = 0;
  }

  /** True while this monster is committed to breaking a block. Tests read it. */
  isBreaching(slot: number): boolean { return this.siegeMode[slot] === SIEGE_BREACH; }
  /** Slots currently chewing on geometry. */
  get breachingCount(): number {
    let n = 0;
    for (let i = 0; i < MAX_ENTITIES; i++) if (this.siegeMode[i] === SIEGE_BREACH) n++;
    return n;
  }

  /** Nearest living player, preferring the one this monster already hunts. */
  private nearestTarget(i: number): PlayerEntity | null {
    const sim = this.sim;
    const current = sim.entTarget[i] !== 0 ? sim.getPlayer(sim.entTarget[i]) : undefined;
    if (current !== undefined && current.active && !current.dead) return current;
    let best: PlayerEntity | null = null;
    let bestD = Infinity;
    for (let p = 0; p < sim.players.length; p++) {
      const o = sim.players[p];
      if (!o.active || o.dead) continue;
      const dx = o.pos[0] - sim.entX[i];
      const dz = o.pos[2] - sim.entZ[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /**
   * The aggression knob. Late waves do not just send more bodies, they send
   * bodies that swing sooner: the archetype cooldown in bots.ts is drained
   * faster without touching a single one of its numbers.
   */
  private aggressionStep(dtMs: number): void {
    const a = this.composition.aggression;
    if (a <= 0 || this.phase !== ModePhase.LIVE) return;
    const bonus = dtMs * a * HORDE_AGGRESSION_CADENCE;
    const sim = this.sim;
    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (sim.entActive[i] !== 1) continue;
      if (sim.entType[i] >= EntityType.PICKUP_HEALTH) continue;
      if (this.siegeMode[i] === SIEGE_BREACH) continue;   // never rush our own wind-up
      const cd = sim.entAttackCd[i];
      if (cd > 0) sim.entAttackCd[i] = cd > bonus ? cd - bonus : 0;
    }
  }

  /* -------------------------------------------------------------- *
   * Actions from the client
   * -------------------------------------------------------------- */

  /** Returns true when the action was recognised and consumed. */
  onAction(playerId: number, action: number, a: number, b: number, seq: number): boolean {
    const run = this.players.get(playerId);
    if (run === undefined) return false;
    run.state.ackActionSeq = seq >>> 0;

    switch (action) {
      case ModeAction.READY:
        run.ready = true;
        return true;
      case ModeAction.BUY:
        return this.buy(run, a, Math.max(1, b | 0));
      case ModeAction.RESTART:
        if (this.phase === ModePhase.GAME_OVER || this.phase === ModePhase.INTERMISSION) {
          this.restart();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** Spend credits. Every branch either charges and delivers, or does neither. */
  private buy(run: HordePlayerRun, itemId: number, quantity: number): boolean {
    const def = shopItem(itemId);
    if (def === undefined) return false;
    if (def.buildPhaseOnly && this.phase !== ModePhase.BUILD) return false;
    const p = this.sim.getPlayer(run.id);
    if (p === undefined || p.dead) return false;

    if (def.id === HordeItem.REPAIR) {
      const quote = this.fort.repairQuote(p.pos[0], p.pos[1], p.pos[2], HORDE_REPAIR_RADIUS, run.id);
      if (quote.blocks === 0 || quote.cost > run.credits) {
        this.emitEvent(ModeEventKind.PAYOUT, run.id, quote.cost, HORDE_PAY_REFUSED, run.credits, '');
        return false;
      }
      this.fort.repairApply(p.pos[0], p.pos[1], p.pos[2], HORDE_REPAIR_RADIUS, run.id);
      this.pay(run, -quote.cost, HORDE_PAY_SPEND);
      return true;
    }

    if (def.id === HordeItem.EXTRA_LIFE) {
      if (def.price > run.credits) {
        this.emitEvent(ModeEventKind.PAYOUT, run.id, def.price, HORDE_PAY_REFUSED, run.credits, '');
        return false;
      }
      run.lives++;
      this.pay(run, -def.price, HORDE_PAY_SPEND);
      return true;
    }

    // Weapons are a one-off; buying one you own is an ammo purchase instead.
    let price = def.price;
    if (def.weapon >= 0 && ownsWeapon(p.weaponMask, def.weapon)) price = Math.round(def.price * 0.25);

    const units = clamp(quantity, 1, 5);
    let bought = 0;
    for (let n = 0; n < units; n++) {
      if (price > run.credits) break;
      if (!this.deliver(p, def)) break;
      this.pay(run, -price, HORDE_PAY_SPEND);
      bought++;
      if (def.weapon >= 0) { price = Math.round(def.price * 0.25); }
    }
    if (bought === 0) {
      this.emitEvent(ModeEventKind.PAYOUT, run.id, price, HORDE_PAY_REFUSED, run.credits, '');
      return false;
    }
    return true;
  }

  /** Hand the goods over. Returns false when the purchase would be wasted. */
  private deliver(p: PlayerEntity, def: HordeShopItem): boolean {
    let did = false;
    if (def.weapon >= 0 && !ownsWeapon(p.weaponMask, def.weapon)) {
      p.weaponMask = grantWeapon(p.weaponMask, def.weapon);
      p.mag[def.weapon] = getWeapon(def.weapon).magSize;
      this.emitEvent(ModeEventKind.WEAPON_TAKEN, p.id, def.weapon, 0, 0, def.name);
      did = true;
    }
    if (def.ammo !== AmmoType.NONE && def.ammoFraction > 0) {
      const cap = AMMO_MAX[def.ammo];
      if (p.reserve[def.ammo] < cap) {
        p.reserve[def.ammo] = Math.min(cap, p.reserve[def.ammo] + Math.ceil(cap * def.ammoFraction));
        did = true;
      }
    }
    if (def.health > 0 && p.health < MAX_HEALTH) {
      p.health = Math.min(MAX_HEALTH, p.health + def.health);
      did = true;
    }
    if (def.armor > 0 && p.armor < MAX_ARMOR) {
      p.armor = Math.min(MAX_ARMOR, p.armor + def.armor);
      did = true;
    }
    if (!did && def.weapon >= 0) {
      // Owned weapon, full reserve: refuse rather than take the money.
      const t = ammoTypeOf(def.weapon);
      if (t !== AmmoType.NONE && p.reserve[t] < AMMO_MAX[t]) {
        p.reserve[t] = AMMO_MAX[t];
        did = true;
      }
    }
    return did;
  }

  /* -------------------------------------------------------------- *
   * The wire
   * -------------------------------------------------------------- */

  /**
   * Horde's reading of the 40-byte state sidecar. `b`/`bTotal`/`c` carry the
   * hold point (biased into a uint16) and `cTotal` the gate + archetype masks,
   * because the client cannot draw a compass, a spawn beacon or a "return to
   * the hold" arrow without them, and those fields are unused by this mode
   * otherwise. No new protocol, no change to a file this module does not own.
   */
  private publish(): void {
    const c = this.composition;
    this.room.phase = this.phase;
    this.room.phaseMsLeft = this.phase === ModePhase.BUILD ? Math.max(0, this.buildMsLeft) : 0;
    this.room.elapsedMs = this.elapsedMs;
    this.room.index = this.wave;
    this.room.score = this.score;
    this.room.a = this.waveKills;
    this.room.aTotal = this.phase === ModePhase.LIVE ? c.total : this.forecast.total;
    this.room.b = encodeCoord(this.holdX);
    this.room.bTotal = encodeCoord(this.holdZ);
    this.room.c = clamp(Math.round(this.holdY), 0, 255);
    this.room.cTotal = ((this.phase === ModePhase.LIVE ? c.gateMask : this.forecast.gateMask) & 0xff)
      | (((this.phase === ModePhase.LIVE ? c.archMask : this.forecast.archMask) & 0x1f) << 8)
      | ((this.phase === ModePhase.LIVE ? c.boss : this.forecast.boss) ? 1 << 13 : 0);
    this.room.waveActive = this.phase === ModePhase.LIVE;

    for (const run of this.players.values()) {
      run.state.budget = clamp(run.credits, 0, 65535);
      run.state.lives = clamp(run.lives, 0, 254);
      run.state.keys = 0;
      run.state.finished = run.lives <= 0;
    }
  }

  /**
   * The sidecar for one client, or null when nothing changed since the last
   * one. Call from the net layer immediately before that client's SNAPSHOT.
   */
  composeState(playerId: number): ModeStateBuffer | null {
    const run = this.players.get(playerId);
    if (run === undefined) return null;
    return this.tracker.compose(playerId, this.room, run.state);
  }

  /** Force the next `composeState` for this client to emit. */
  invalidate(playerId: number): void { this.tracker.invalidate(playerId); }

  summary(): HordeRunSummary {
    let credits = 0;
    let blocks = 0;
    for (const run of this.players.values()) { credits += run.earned; blocks += run.blocksPlaced; }
    return {
      wave: this.wave,
      waveReached: this.wave,
      kills: this.runKills,
      score: this.score,
      creditsEarned: credits,
      blocksPlaced: blocks,
      breaches: this.fort.breaches,
      elapsedMs: this.elapsedMs,
    };
  }

  status(): Record<string, unknown> {
    return {
      phase: this.phase,
      wave: this.wave,
      pending: this.pending,
      alive: this.monsters.liveCount,
      waveKills: this.waveKills,
      runKills: this.runKills,
      score: this.score,
      buildMsLeft: Math.max(0, Math.round(this.buildMsLeft)),
      hold: this.holdY >= 0 ? [this.holdX, this.holdY, this.holdZ] : null,
      gates: this.composition.gateMask,
      fortBlocks: this.fort.size,
      fortBuilt: this.fort.built,
      breaches: this.fort.breaches,
      players: this.players.size,
    };
  }

  private emitEvent(kind: ModeEventKind, playerId: number, a: number, b: number, c: number, text: string): void {
    if (this.emit === null) return;
    this.emit(kind, playerId, a, b, c, text);
  }
}

/* ------------------------------------------------------------------------ *
 * Entity state bits.
 *
 * Mirrored from server/src/sim.ts rather than imported: this module keeps its
 * runtime import list to `@doomcraft/shared` + `./modes.js` so the client can
 * import the wave curve without dragging the simulation into the page bundle.
 * The values are asserted against sim.ts in server/src/horde.test.ts.
 * ------------------------------------------------------------------------ */

export const ES_MOVING_BIT = 1 << 0;
export const ES_ATTACK_BIT = 1 << 1;
export const ES_ALERT_BIT = 1 << 5;
export const ES_WINDUP_BIT = 1 << 6;

/* ------------------------------------------------------------------------ *
 * Small pure helpers the client shares
 * ------------------------------------------------------------------------ */

/** "19 demons · 3 Barons" style summary of a composition. */
export function describeWave(c: WaveComposition): string {
  let out = `${c.total} demon${c.total === 1 ? '' : 's'}`;
  for (let i = HORDE_ENEMY_COUNT - 1; i >= 0; i--) {
    const n = c.count[i];
    if (n <= 0) continue;
    const def = HORDE_ENEMIES[i];
    if (def.tier < 2) continue;
    out += ` · ${n} ${n === 1 ? def.name : def.plural}`;
  }
  return out;
}

/** Names of the hot gates, e.g. "N, SE, W". */
export function describeGates(mask: number): string {
  let out = '';
  for (let g = 0; g < HORDE_GATE_COUNT; g++) {
    if (!gateIsHot(mask, g)) continue;
    out += out.length === 0 ? HORDE_GATE_NAMES[g] : `, ${HORDE_GATE_NAMES[g]}`;
  }
  return out;
}

/**
 * What `credits` is worth, spelled out as the choice the mode is about. The
 * client prints this under the wallet so the trade is never implicit.
 */
export function affordanceLine(credits: number): string {
  const stone = Math.floor(credits / Math.max(1, blockCost(BlockId.STONE)));
  const obsidian = Math.floor(credits / Math.max(1, blockCost(BlockId.OBSIDIAN)));
  let gun = '';
  for (let i = HORDE_SHOP.length - 1; i >= 0; i--) {
    const s = HORDE_SHOP[i];
    if (s.weapon < 0 || s.price > credits) continue;
    gun = s.name;
    break;
  }
  const walls = `${stone} stone / ${obsidian} obsidian`;
  return gun.length > 0 ? `${walls} — or a ${gun}` : walls;
}

/** Blocks of `blockId` `credits` will buy, at the current phase's price. */
export function blocksAffordable(credits: number, blockId: number, combat: boolean): number {
  const unit = blockCost(blockId) * (combat ? HORDE_COMBAT_PREMIUM : 1);
  return unit <= 0 ? 0 : Math.floor(credits / unit);
}

/** Wave budget from the shared plan helper, exposed so the client can preview it. */
export function waveTargetFor(plan: ModeSimPlan, wave: number): number {
  return waveBudget(plan, wave).target;
}
