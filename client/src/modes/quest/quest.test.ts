/**
 * DOOMCRAFT — Quest: the content gate and the level runtime.
 *
 * Three things are being proved here, and they are the three things that can
 * silently ruin a campaign:
 *
 *   1. **Every shipped level is finishable.** Each `content/levels/*.json`
 *      compiles, validates clean at all five skills, and its exit is reachable
 *      by the real lock-and-key flood in `shared/src/level.ts` — the one that
 *      walks standable cells, respects step-up, drops and closed doors, and
 *      iterates as keys and switches come within reach.
 *
 *   2. **The keycards are load-bearing.** For every keycard colour a level
 *      contains, deleting that colour's pickups must make the exit
 *      unreachable, and at runtime a locked door must refuse to open and stay
 *      physically solid until the card is held. A "locked" door you can walk
 *      through is the failure mode nobody notices until a speedrunner does.
 *
 *   3. **The ammo economy is real.** Every pickup is priced Doom's way, and
 *      every shipped level carries enough ammo to clear the roster it ships and
 *      not enough to ignore it — the guard-rail that stops "ammo starvation as
 *      pacing" from quietly becoming "a shooting gallery" as levels are added.
 *
 * The runtime half runs against a fake voxel world, which is why
 * `levelRuntime.ts` takes structural sinks and imports no DOM and no three.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CHUNK_HEIGHT,
  CHUNK_SIZE_MASK,
  CHUNK_VOLUME,
  blockToChunk,
  chunkKey,
  voxelIndex,
} from '@shared/constants';
import { BLOCK_SOLID, BlockId } from '@shared/blocks';
import {
  KeyColor,
  SKILL_COUNT,
  SKILL_PICKUP_SCALE,
  Skill,
  keyBit,
} from '@shared/modes';
import { AMMO_TYPE_COUNT, AmmoType, WeaponId } from '@shared/weapons';
import {
  PU_IN_SECRET,
  PickupKind,
  SpawnKind,
  compileLevel,
  enemyAppearsAtSkill,
  enemyTypeName,
  pickupAppearsAtSkill,
  decodeLevel,
  encodeLevel,
  levelTotals,
  parseLevelJson,
  primarySpawn,
  spawnsOfKind,
  validateLevel,
  type Level,
  type LevelSource,
} from '@shared/level';

import {
  DOOR_CLOSED,
  DOOR_OPEN,
  DOOR_OPENING,
  QUEST_START_BULLETS,
  QuestEvent,
  QuestLevelRuntime,
  USE_DOOR_LOCKED,
  USE_DOOR_OPENED,
  USE_SWITCH,
  createPickupGrant,
  fillPickupGrant,
  levelKeyMask,
  type QuestWorldSink,
} from '@/modes/quest/levelRuntime';

/* ------------------------------------------------------------------------ *
 * Content on disk
 * ------------------------------------------------------------------------ */

const CONTENT_DIR = fileURLToPath(new URL('../../../../content', import.meta.url));
const LEVEL_DIR = join(CONTENT_DIR, 'levels');

interface Shipped { id: string; file: string; text: string; source: LevelSource; level: Level }

const SHIPPED: Shipped[] = readdirSync(LEVEL_DIR)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((name) => {
    const file = join(LEVEL_DIR, name);
    const text = readFileSync(file, 'utf8');
    const source = parseLevelJson(text);
    if (source === null) throw new Error(`${name} is not valid JSON`);
    return { id: source.meta.id, file, text, source, level: compileLevel(source) };
  });

/** A fresh compile from disk — the strip-a-thing-and-revalidate helper. */
function reparse(s: Shipped): LevelSource {
  return parseLevelJson(s.text) as LevelSource;
}

interface EpisodeDoc {
  defaultEpisode?: unknown;
  episodes?: unknown;
}
const EPISODES = JSON.parse(readFileSync(join(CONTENT_DIR, 'episodes.json'), 'utf8')) as EpisodeDoc;

/* ------------------------------------------------------------------------ *
 * A voxel world that is just a Map
 * ------------------------------------------------------------------------ */

class FakeWorld implements QuestWorldSink {
  readonly chunks = new Map<number, Uint8Array>();
  putCount = 0;

  chunkAt(cx: number, cz: number): Uint8Array | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }
  putChunk(cx: number, cz: number, voxels: Uint8Array): void {
    this.chunks.set(chunkKey(cx, cz), voxels);
    this.putCount++;
  }
  setBlock(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    const c = this.chunks.get(chunkKey(blockToChunk(x), blockToChunk(z)));
    if (c === undefined) return;
    c[voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK)] = id;
  }
  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BlockId.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BlockId.AIR;
    const c = this.chunks.get(chunkKey(blockToChunk(x), blockToChunk(z)));
    if (c === undefined) return BlockId.AIR;
    return c[voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK)];
  }
}

interface Recorded { kind: QuestEvent; index: number; a: number; text: string }

function runtimeFor(level: Level, skill = Skill.HURT_ME_PLENTY): {
  runtime: QuestLevelRuntime; world: FakeWorld; events: Recorded[];
} {
  const world = new FakeWorld();
  const events: Recorded[] = [];
  const runtime = new QuestLevelRuntime({
    level, skill, world,
    events: (kind, index, a, text) => { events.push({ kind, index, a, text }); },
  });
  return { runtime, world, events };
}

/* ------------------------------------------------------------------------ *
 * 1. Every shipped level is finishable
 * ------------------------------------------------------------------------ */

describe('the shipped campaign', () => {
  it('ships more than one level', () => {
    expect(SHIPPED.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every level a unique, slug-shaped id', () => {
    const seen = new Set<string>();
    for (const s of SHIPPED) {
      expect(s.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,47}$/);
      expect(seen.has(s.id)).toBe(false);
      seen.add(s.id);
      // The file name and the id must agree or the loader picks the wrong one.
      expect(s.file.endsWith(`${s.id}.json`)).toBe(true);
    }
  });

  for (const s of SHIPPED) {
    describe(s.id, () => {
      it('validates clean at all five skills with a reachable exit', () => {
        for (let skill = 0; skill < SKILL_COUNT; skill++) {
          const v = validateLevel(s.level, skill);
          if (!v.ok) {
            throw new Error(
              `${s.id} @ skill ${skill}: ${v.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`,
            );
          }
          expect(v.reach.ran).toBe(true);
          expect(v.reach.exitReachable).toBe(true);
          expect(v.reach.visitedCells).toBeGreaterThan(200);
        }
      }, 30_000);

      it('has the pieces a Doom level needs', () => {
        expect(s.level.exit).not.toBeNull();
        expect(spawnsOfKind(s.level, SpawnKind.PLAYER).length).toBeGreaterThan(0);
        expect(s.level.meta.parTimeSec).toBeGreaterThan(0);
        expect(s.level.meta.name.length).toBeGreaterThan(0);
        expect(s.level.meta.episodeId.length).toBeGreaterThan(0);
        // At least one secret, always. This is the brief and it is also Doom.
        expect(s.level.secrets.length).toBeGreaterThanOrEqual(1);
        // Dark enough for a bright demon to read against it.
        expect(s.level.meta.ambient).toBeLessThanOrEqual(0.45);
      });

      it('escalates its monster count with skill', () => {
        const easy = levelTotals(s.level, Skill.TOO_YOUNG_TO_DIE).enemies;
        const hard = levelTotals(s.level, Skill.NIGHTMARE).enemies;
        expect(easy).toBeGreaterThan(0);
        expect(hard).toBeGreaterThan(easy);
      });

      it('round trips through the binary format byte for byte', () => {
        const bytes = encodeLevel(s.level);
        const again = encodeLevel(decodeLevel(bytes));
        expect(again.length).toBe(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
          if (again[i] !== bytes[i]) throw new Error(`byte ${i} differs`);
        }
      });

      it('needs its exit switch', () => {
        const requires = s.level.exit?.requiresSwitch ?? '';
        if (requires.length === 0) return;
        const src = reparse(s);
        src.switches = src.switches.filter((x) => x.id !== requires);
        const v = validateLevel(compileLevel(src), Skill.HURT_ME_PLENTY);
        expect(v.reach.exitReachable).toBe(false);
      }, 20_000);
    });
  }
});

/* ------------------------------------------------------------------------ *
 * 2. Keycards are load-bearing
 * ------------------------------------------------------------------------ */

describe('keycard doors', () => {
  it('every level with a keycard cannot be finished without it', () => {
    let checked = 0;
    for (const s of SHIPPED) {
      const colours = new Set<number>();
      for (const p of s.level.pickups) {
        if (p.kind === PickupKind.KEY && p.variant !== KeyColor.NONE) colours.add(p.variant);
      }
      for (const colour of colours) {
        const src = reparse(s);
        src.pickups = src.pickups.filter(
          (p) => !(p.kind === PickupKind.KEY && p.variant === colour),
        );
        const v = validateLevel(compileLevel(src), Skill.HURT_ME_PLENTY);
        if (v.reach.exitReachable) {
          throw new Error(`${s.id}: the exit is still reachable without the ${colour} keycard`);
        }
        checked++;
      }
    }
    // Six shipped levels, one to three colours each: this must not silently
    // pass because nothing was examined.
    expect(checked).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it('refuses to open, and stays solid, until the card is held', () => {
    for (const s of SHIPPED) {
      const locked = s.level.doors.find((d) => d.key !== KeyColor.NONE);
      if (locked === undefined) continue;

      const { runtime, world, events } = runtimeFor(s.level);
      runtime.place();

      const cx = locked.x + ((locked.w / 2) | 0);
      const cy = locked.y;
      const cz = locked.z + ((locked.d / 2) | 0);

      // Closed doors are stamped into the volume by compileLevel.
      expect(BLOCK_SOLID[world.getBlock(cx, cy, cz)]).toBe(1);

      expect(runtime.canOpenDoor(s.level.doors.indexOf(locked))).toBe(false);
      expect(runtime.useAt(cx, cy, cz)).toBe(USE_DOOR_LOCKED);
      expect(events.some((e) => e.kind === QuestEvent.DOOR_LOCKED)).toBe(true);

      // Ten seconds of updates must not move it one voxel.
      for (let i = 0; i < 600; i++) runtime.update(1 / 60, cx, cy, cz + 3);
      expect(runtime.doorStateOf(s.level.doors.indexOf(locked))).toBe(DOOR_CLOSED);
      expect(BLOCK_SOLID[world.getBlock(cx, cy, cz)]).toBe(1);

      // Now hand over the card.
      runtime.keys |= keyBit(locked.key);
      expect(runtime.canOpenDoor(s.level.doors.indexOf(locked))).toBe(true);
      expect(runtime.useAt(cx, cy, cz)).toBe(USE_DOOR_OPENED);
      expect(runtime.doorStateOf(s.level.doors.indexOf(locked))).toBe(DOOR_OPENING);

      for (let i = 0; i < 240; i++) runtime.update(1 / 60, cx, cy, cz + 3);
      expect(runtime.doorStateOf(s.level.doors.indexOf(locked))).toBe(DOOR_OPEN);
      expect(world.getBlock(cx, cy, cz)).toBe(BlockId.AIR);
    }
  });

  it('reports the missing colour as the objective', () => {
    for (const s of SHIPPED) {
      const locked = s.level.doors.find((d) => d.key !== KeyColor.NONE);
      if (locked === undefined) continue;
      const { runtime } = runtimeFor(s.level);
      runtime.place();
      expect(runtime.objective()).toContain('KEYCARD');
    }
  });

  it('knows which colours a level uses', () => {
    for (const s of SHIPPED) {
      const { runtime } = runtimeFor(s.level);
      expect(runtime.keyColoursPresent()).toBe(levelKeyMask(s.level));
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The episode manifest
 * ------------------------------------------------------------------------ */

describe('content/episodes.json', () => {
  const episodes = Array.isArray(EPISODES.episodes) ? EPISODES.episodes : [];

  it('lists episodes', () => {
    expect(episodes.length).toBeGreaterThan(0);
  });

  it('only names levels that exist, and names every level that exists', () => {
    const onDisk = new Set(SHIPPED.map((s) => s.id));
    const listed = new Set<string>();
    for (const raw of episodes) {
      const ep = raw as { id?: unknown; levels?: unknown };
      const ids = Array.isArray(ep.levels) ? ep.levels : [];
      for (const id of ids) {
        expect(typeof id).toBe('string');
        expect(onDisk.has(id as string)).toBe(true);
        expect(listed.has(id as string)).toBe(false);
        listed.add(id as string);
      }
    }
    for (const id of onDisk) expect(listed.has(id)).toBe(true);
  });

  it('agrees with the level files about which episode they are in', () => {
    for (const raw of episodes) {
      const ep = raw as { id?: unknown; levels?: unknown };
      const ids = Array.isArray(ep.levels) ? ep.levels : [];
      for (const id of ids) {
        const s = SHIPPED.find((x) => x.id === id);
        expect(s?.level.meta.episodeId).toBe(ep.id);
      }
    }
  });

  it('runs its levels in ascending levelIndex order', () => {
    for (const raw of episodes) {
      const ep = raw as { levels?: unknown };
      const ids = Array.isArray(ep.levels) ? ep.levels : [];
      let last = -1;
      for (const id of ids) {
        const s = SHIPPED.find((x) => x.id === id);
        const idx = s?.level.meta.levelIndex ?? -1;
        expect(idx).toBeGreaterThan(last);
        last = idx;
      }
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The runtime
 * ------------------------------------------------------------------------ */

describe('QuestLevelRuntime', () => {
  const sample = SHIPPED[0];

  it('blits the level into the world and leaves the spawn standable', () => {
    const { runtime, world } = runtimeFor(sample.level);
    runtime.place();

    expect(runtime.placedChunkCount).toBe(sample.level.volume.chunkCount);
    for (const [key, section] of sample.level.volume.sections) {
      const mine = world.chunks.get(key);
      expect(mine).toBeDefined();
      expect((mine as Uint8Array).length).toBe(CHUNK_VOLUME);
      for (let i = 0; i < CHUNK_VOLUME; i += 997) {
        expect((mine as Uint8Array)[i]).toBe(section[i]);
      }
    }

    const spawn = runtime.spawn();
    const sx = Math.floor(spawn.x), sy = Math.floor(spawn.y), sz = Math.floor(spawn.z);
    expect(BLOCK_SOLID[world.getBlock(sx, sy, sz)]).toBe(0);
    expect(BLOCK_SOLID[world.getBlock(sx, sy + 1, sz)]).toBe(0);
    expect(BLOCK_SOLID[world.getBlock(sx, sy - 1, sz)]).toBe(1);
  });

  it('re-asserts a chunk that something else overwrote', () => {
    const { runtime, world } = runtimeFor(sample.level);
    runtime.place();
    const key = [...world.chunks.keys()][0];
    const mine = world.chunks.get(key) as Uint8Array;

    world.chunks.set(key, new Uint8Array(CHUNK_VOLUME));
    // One chunk per call, round robin: a full lap always puts it back.
    for (let i = 0; i < runtime.placedChunkCount + 1; i++) runtime.reassert(1);
    expect(world.chunks.get(key)).toBe(mine);
  });

  it('relocates the level so the authored start lands on the player', () => {
    const { runtime, world } = runtimeFor(sample.level);
    const authored = primarySpawn(sample.level);
    runtime.alignSpawnTo(140.5, 26, -70.5);
    runtime.place();

    const spawn = runtime.spawn();
    expect(Math.floor(spawn.x)).toBe(140);
    expect(Math.floor(spawn.z)).toBe(-71);
    expect(spawn.y).toBeGreaterThanOrEqual(authored.y);
    // And the relocated floor really is under the relocated start.
    const sx = Math.floor(spawn.x), sy = Math.floor(spawn.y), sz = Math.floor(spawn.z);
    expect(BLOCK_SOLID[world.getBlock(sx, sy, sz)]).toBe(0);
    expect(BLOCK_SOLID[world.getBlock(sx, sy - 1, sz)]).toBe(1);
    // Nothing may be pushed out of the 0..63 column.
    expect(runtime.originY).toBeGreaterThanOrEqual(0);
  });

  it('collects a pickup, banks the keycard and counts the item', () => {
    const level = sample.level;
    const key = level.pickups.find((p) => p.kind === PickupKind.KEY);
    expect(key).toBeDefined();
    const k = key as NonNullable<typeof key>;

    const { runtime, events } = runtimeFor(level);
    runtime.place();
    expect(runtime.hasKeyColor(k.variant)).toBe(false);

    runtime.update(1 / 60, k.x, k.y - 0.1, k.z);
    expect(runtime.hasKeyColor(k.variant)).toBe(true);
    expect(events.some((e) => e.kind === QuestEvent.KEY_TAKEN)).toBe(true);
    // Keys are not items in Doom's tally, and the shipped levels say so.
    expect(runtime.items).toBe(0);

    const item = level.pickups.find((p) => p.kind !== PickupKind.KEY);
    expect(item).toBeDefined();
    const it2 = item as NonNullable<typeof item>;
    runtime.update(1 / 60, it2.x, it2.y - 0.1, it2.z);
    expect(runtime.items).toBe(1);
  });

  it('fires the secret sting exactly once per sector', () => {
    const level = sample.level;
    const secret = level.secrets[0];
    const { runtime, events } = runtimeFor(level);
    runtime.place();

    const x = secret.x + secret.w / 2;
    const y = secret.y;
    const z = secret.z + secret.d / 2;
    for (let i = 0; i < 10; i++) runtime.update(1 / 60, x, y, z);

    expect(runtime.secrets).toBe(1);
    expect(events.filter((e) => e.kind === QuestEvent.SECRET_FOUND).length).toBe(1);
  });

  it('keeps the exit inert until its switch is thrown', () => {
    for (const s of SHIPPED) {
      const exit = s.level.exit;
      if (exit === null || exit.requiresSwitch.length === 0) continue;

      const { runtime, events } = runtimeFor(s.level);
      runtime.place();

      const ex = exit.x + exit.w / 2;
      const ey = exit.y;
      const ez = exit.z + exit.d / 2;
      for (let i = 0; i < 30; i++) runtime.update(1 / 60, ex, ey, ez);
      expect(runtime.exitArmed).toBe(false);
      expect(runtime.exitReached).toBe(false);

      expect(runtime.throwSwitchId(exit.requiresSwitch)).toBe(USE_SWITCH);
      expect(runtime.exitArmed).toBe(true);
      expect(events.some((e) => e.kind === QuestEvent.EXIT_ARMED)).toBe(true);

      runtime.update(1 / 60, ex, ey, ez);
      expect(runtime.exitReached).toBe(true);
    }
  });

  it('opens a secret door only through its hidden switch', () => {
    for (const s of SHIPPED) {
      const idx = s.level.doors.findIndex((d) => d.key === KeyColor.NONE && (d.flags & 1) !== 0);
      if (idx < 0) continue;
      const door = s.level.doors[idx];
      const opener = s.level.switches.find((sw) => sw.targets.indexOf(door.id) >= 0);
      if (opener === undefined) continue;

      const { runtime } = runtimeFor(s.level);
      runtime.place();
      // A fake wall says nothing at all when you push on it.
      expect(runtime.useAt(door.x, door.y, door.z)).toBe(0);
      expect(runtime.doorStateOf(idx)).toBe(DOOR_CLOSED);

      expect(runtime.throwSwitchId(opener.id)).toBe(USE_SWITCH);
      expect(runtime.doorStateOf(idx)).toBe(DOOR_OPENING);
    }
  });

  it('puts the level back exactly as authored on reset', () => {
    const level = sample.level;
    const exit = level.exit;
    expect(exit).not.toBeNull();
    const { runtime, world } = runtimeFor(level);
    runtime.place();

    const locked = level.doors.find((d) => d.key !== KeyColor.NONE);
    const key = level.pickups.find((p) => p.kind === PickupKind.KEY);
    if (locked !== undefined && key !== undefined) {
      runtime.update(1 / 60, key.x, key.y - 0.1, key.z);
      runtime.useAt(locked.x, locked.y, locked.z);
      for (let i = 0; i < 240; i++) runtime.update(1 / 60, key.x, key.y - 0.1, key.z);
      expect(world.getBlock(locked.x, locked.y, locked.z)).toBe(BlockId.AIR);
    }
    runtime.throwSwitchId((exit as NonNullable<typeof exit>).requiresSwitch);
    expect(runtime.exitArmed).toBe(true);

    runtime.reset();

    expect(runtime.keys).toBe(0);
    expect(runtime.items).toBe(0);
    expect(runtime.secrets).toBe(0);
    expect(runtime.exitArmed).toBe(false);
    expect(runtime.exitReached).toBe(false);
    if (locked !== undefined) {
      expect(runtime.doorStateOf(level.doors.indexOf(locked))).toBe(DOOR_CLOSED);
      expect(BLOCK_SOLID[world.getBlock(locked.x, locked.y, locked.z)]).toBe(1);
    }
  });

  it('never counts more kills than the level contains', () => {
    const { runtime } = runtimeFor(sample.level);
    runtime.place();
    for (let i = 0; i < runtime.totals.enemies + 25; i++) runtime.notifyKill();
    expect(runtime.kills).toBe(runtime.totals.enemies);
  });

  it('wakes an authored ambush when its door opens', () => {
    for (const s of SHIPPED) {
      const waiting = s.level.enemies.findIndex((e) => e.trigger === 5 && e.triggerId.length > 0);
      if (waiting < 0) continue;
      const target = s.level.enemies[waiting];
      const doorIdx = s.level.doors.findIndex((d) => d.id === target.triggerId);
      if (doorIdx < 0) continue;

      const { runtime, events } = runtimeFor(s.level, Skill.HURT_ME_PLENTY);
      runtime.place();
      const before = events.filter((e) => e.kind === QuestEvent.ENEMY_WOKE).length;
      runtime.keys = 0xff;
      expect(runtime.openDoor(doorIdx)).toBe(USE_DOOR_OPENED);
      const after = events.filter((e) => e.kind === QuestEvent.ENEMY_WOKE).length;
      expect(after).toBeGreaterThan(before);
      return;
    }
    throw new Error('no shipped level has a door-triggered ambush');
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The ammo economy
 *
 * docs/MODES.md §1 names "ammo starvation as pacing" as one of the five things
 * E1M1 does that Quest must match, and it is the one that is easiest to ship
 * broken: a level whose boxes of shells are decoration plays exactly like a
 * level with no boxes of shells in it.
 *
 * So the pricing is asserted directly, and then the whole shipped campaign is
 * weighed against the monster roster it ships. The second test is a real
 * guard-rail for a modder: drop in a level with seven barons and one clip and
 * it fails, and so does a level that hands you nine hundred cells.
 * ------------------------------------------------------------------------ */

/**
 * Damage per ROUND for the weapon a player actually spends that ammo type
 * from — chaingun, shotgun at a working distance with most of the cone on the
 * target, rocket, plasma. Deliberately not the best case: the shotgun's 7 x 11
 * only lands in full at point-blank, and pricing shells at 77 would make every
 * level look twice as rich as it plays.
 */
const DAMAGE_PER_ROUND: readonly number[] = [0, 9, 31, 92, 21];
/** Rounds that hit something. Doom players are not perfect and neither are we. */
const HIT_RATE = 0.5;
/**
 * Monster health, mirroring `MONSTERS` in server/src/bots.ts. Duplicated on
 * purpose: importing the server's bot table would drag the whole `Simulation`
 * into a client test to read five numbers.
 */
const MONSTER_HP: Readonly<Record<string, number>> = {
  imp: 60, zombie: 48, cacodemon: 170, baron: 340, lost_soul: 32,
};

/** Every round the level hands out at `skill`, including the campaign start. */
function ammoBudget(level: Level, skill: Skill): Int32Array {
  const grant = createPickupGrant();
  const total = new Int32Array(AMMO_TYPE_COUNT);
  total[AmmoType.BULLETS] = Math.round(QUEST_START_BULLETS * SKILL_PICKUP_SCALE[skill]);
  for (const p of level.pickups) {
    if (!pickupAppearsAtSkill(p, skill)) continue;
    fillPickupGrant(p, skill, grant);
    for (let t = 1; t < AMMO_TYPE_COUNT; t++) total[t] += grant.ammo[t];
  }
  return total;
}

function budgetDamage(level: Level, skill: Skill): number {
  const ammo = ammoBudget(level, skill);
  let dmg = 0;
  for (let t = 1; t < AMMO_TYPE_COUNT; t++) dmg += ammo[t] * DAMAGE_PER_ROUND[t];
  return dmg * HIT_RATE;
}

function rosterHealth(level: Level, skill: Skill): number {
  let hp = 0;
  for (const e of level.enemies) {
    if (!enemyAppearsAtSkill(e, skill)) continue;
    hp += MONSTER_HP[enemyTypeName(e.type)] ?? 60;
  }
  return hp;
}

describe('the ammo economy', () => {
  it('prices every pickup kind the way Doom does', () => {
    const g = createPickupGrant();
    const at = (kind: PickupKind, variant: number, amount = 0): typeof g =>
      fillPickupGrant({
        id: '', kind, variant, amount, x: 0, y: 0, z: 0, minSkill: 0, maxSkill: 4, flags: 0,
      }, Skill.HURT_ME_PLENTY, g);

    // A clip is 10 rounds; a box is whatever the level says.
    expect(at(PickupKind.AMMO, AmmoType.BULLETS).ammo[AmmoType.BULLETS]).toBe(10);
    expect(at(PickupKind.AMMO, AmmoType.BULLETS, 40).ammo[AmmoType.BULLETS]).toBe(40);
    expect(at(PickupKind.AMMO, AmmoType.SHELLS).ammo[AmmoType.SHELLS]).toBe(4);
    expect(at(PickupKind.AMMO, AmmoType.ROCKETS).ammo[AmmoType.ROCKETS]).toBe(1);
    expect(at(PickupKind.AMMO, AmmoType.CELLS).ammo[AmmoType.CELLS]).toBe(20);

    // A weapon arrives with rounds in it, and says so loudly.
    const shotgun = at(PickupKind.WEAPON, WeaponId.SHOTGUN);
    expect(shotgun.weapon).toBe(WeaponId.SHOTGUN);
    expect(shotgun.ammo[AmmoType.SHELLS]).toBe(8);
    expect(shotgun.loud).toBe(true);
    expect(shotgun.message).toContain('shotgun');

    // The backpack is one clip of everything.
    const pack = at(PickupKind.BACKPACK, 0);
    for (let t = 1; t < AMMO_TYPE_COUNT; t++) expect(pack.ammo[t]).toBeGreaterThan(0);

    // Health and armour are priced but not granted here — the server owns them.
    expect(at(PickupKind.HEALTH, 2).health).toBe(25);
    expect(at(PickupKind.ARMOR, 2).armor).toBe(200);
    expect(at(PickupKind.HEALTH, 2).weapon).toBe(-1);

    // A key is a key.
    expect(at(PickupKind.KEY, KeyColor.RED).key).toBe(KeyColor.RED);
  });

  it("doubles ammo on I'm Too Young To Die and nothing else", () => {
    const g = createPickupGrant();
    const box = { id: '', kind: PickupKind.AMMO, variant: AmmoType.SHELLS, amount: 8,
      x: 0, y: 0, z: 0, minSkill: 0, maxSkill: 4, flags: 0 };
    expect(fillPickupGrant(box, Skill.TOO_YOUNG_TO_DIE, g).ammo[AmmoType.SHELLS]).toBe(16);
    expect(fillPickupGrant(box, Skill.HURT_ME_PLENTY, g).ammo[AmmoType.SHELLS]).toBe(8);
    expect(fillPickupGrant(box, Skill.NIGHTMARE, g).ammo[AmmoType.SHELLS]).toBe(8);

    const kit = { ...box, kind: PickupKind.HEALTH, variant: 2, amount: 0 };
    expect(fillPickupGrant(kit, Skill.TOO_YOUNG_TO_DIE, g).health)
      .toBe(fillPickupGrant(kit, Skill.NIGHTMARE, g).health);
  });

  it('refuses to throw on a level file that is wrong', () => {
    const g = createPickupGrant();
    const junk = fillPickupGrant({
      id: '', kind: 99 as PickupKind, variant: -7, amount: -3,
      x: 0, y: 0, z: 0, minSkill: 0, maxSkill: 4, flags: 0,
    }, 9 as Skill, g);
    expect(junk.weapon).toBe(-1);
    expect(junk.message).toBe('');
    for (let t = 0; t < AMMO_TYPE_COUNT; t++) expect(junk.ammo[t]).toBe(0);
  });

  it('hands the level runtime back the record behind a collected pickup', () => {
    const s = SHIPPED[0];
    const { runtime } = runtimeFor(s.level);
    expect(runtime.pickupAt(-1)).toBeNull();
    expect(runtime.pickupAt(runtime.pickupCount)).toBeNull();
    for (let i = 0; i < runtime.pickupCount; i++) {
      const p = runtime.pickupAt(i);
      expect(p).not.toBeNull();
      expect(s.level.pickups.indexOf(p as never)).toBeGreaterThanOrEqual(0);
    }
  });

  for (const s of SHIPPED) {
    describe(s.id, () => {
      it('ships enough ammo to clear its roster, and not much more', () => {
        for (const skill of [Skill.ULTRA_VIOLENCE, Skill.NIGHTMARE]) {
          const ratio = budgetDamage(s.level, skill) / Math.max(1, rosterHealth(s.level, skill));
          // Below 1.0 the level cannot be finished with the ammo in it.
          expect(ratio).toBeGreaterThan(1.0);
          // Above 4.0 nothing forces a weapon rotation and the pacing is gone.
          expect(ratio).toBeLessThan(4.0);
        }
      });

      it('gets tighter as the skill goes up', () => {
        const easy = budgetDamage(s.level, Skill.TOO_YOUNG_TO_DIE) / Math.max(1, rosterHealth(s.level, Skill.TOO_YOUNG_TO_DIE));
        const hard = budgetDamage(s.level, Skill.NIGHTMARE) / Math.max(1, rosterHealth(s.level, Skill.NIGHTMARE));
        expect(hard).toBeLessThan(easy);
      });

      it('makes you find a second weapon', () => {
        const guns = s.level.pickups.filter((p) => p.kind === PickupKind.WEAPON);
        expect(guns.length).toBeGreaterThan(0);
        // Starting the campaign with it would defeat the point of finding it.
        for (const gun of guns) expect(gun.variant).not.toBe(WeaponId.PISTOL);
      });

      it('carries a backpack or a bulk cache somewhere off the critical path', () => {
        const bonus = s.level.pickups.filter(
          (p) => p.kind === PickupKind.BACKPACK || (p.flags & PU_IN_SECRET) !== 0,
        );
        expect(bonus.length).toBeGreaterThan(0);
      });
    });
  }
});
