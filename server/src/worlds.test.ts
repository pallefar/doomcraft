/**
 * Persistent Builder worlds — the three promises from docs/MODES.md, tested.
 *
 *   1. a placed block survives save -> restart -> load,
 *   2. two clients editing the same world converge,
 *   3. permissions and share codes actually gate what they claim to.
 *
 * The restart test runs two *separate* `WorldStore` instances over one
 * `MemoryWorldFs`, which is exactly what a process restart looks like from the
 * store's point of view: nothing in memory, everything on disk. The replay
 * target is the real `ServerWorld`, not a stub, so the assertion is "the block
 * is there in the world the next player would walk into" rather than "the map
 * still has the key".
 */

import { describe, expect, it } from 'vitest';

import { BlockId } from '@doomcraft/shared';
import { ServerWorld } from './world.js';
import {
  CODE_LENGTH,
  MemoryWorldFs,
  PersistentWorld,
  WorldDeltaLog,
  WorldEditResult,
  WorldRole,
  WorldStore,
  cellX,
  cellY,
  cellZ,
  decodeWorld,
  encodeWorld,
  looksLikeCode,
  normaliseCode,
  packCell,
  readVarint,
  writeVarint,
  type WorldChange,
  type WorldVoxelTarget,
} from './worlds.js';

const SEED = 0xc0ffee;

/** A cell high above the terrain, so the generator definitely says AIR there. */
const AIR_X = 5;
const AIR_Y = 58;
const AIR_Z = -7;

function freshStore(fs: MemoryWorldFs, now = () => 1_000_000): WorldStore {
  return new WorldStore({ dir: '/worlds', fs, now, codeSeed: 7 });
}

/** A minimal voxel target, for the cases where a whole ServerWorld is overkill. */
class MapTarget implements WorldVoxelTarget {
  readonly cells = new Map<number, number>();
  readonly actors = new Map<number, number>();
  setBlock(x: number, y: number, z: number, id: number, by: number): boolean {
    const key = packCell(x, y, z);
    if (key < 0) return false;
    this.actors.set(key, by);
    if (this.cells.get(key) === id) return false;
    this.cells.set(key, id);
    return true;
  }
  getBlock(x: number, y: number, z: number): number {
    return this.cells.get(packCell(x, y, z)) ?? BlockId.AIR;
  }
}

/* ------------------------------------------------------------------------ *
 * Cell packing and varints
 * ------------------------------------------------------------------------ */

describe('cell packing', () => {
  it('round-trips every corner of the arena', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0], [-192, 1, -192], [223, 63, 223], [5, 58, -7], [-1, 32, 1],
    ];
    for (const [x, y, z] of cases) {
      const key = packCell(x, y, z);
      expect(key).toBeGreaterThanOrEqual(0);
      expect([cellX(key), cellY(key), cellZ(key)]).toEqual([x, y, z]);
    }
  });

  it('refuses cells outside the world', () => {
    expect(packCell(-193, 10, 0)).toBe(-1);
    expect(packCell(224, 10, 0)).toBe(-1);
    expect(packCell(0, -1, 0)).toBe(-1);
    expect(packCell(0, 64, 0)).toBe(-1);
  });
});

describe('varint', () => {
  it('round-trips the sizes the delta log produces', () => {
    const cur = { value: 0, offset: 0 };
    for (const v of [0, 1, 63, 127, 128, 300, 16383, 16384, 173056, 10_878_463]) {
      const buf: number[] = [];
      writeVarint(buf, v);
      readVarint(Uint8Array.from(buf), 0, cur);
      expect(cur.value).toBe(v);
      expect(cur.offset).toBe(buf.length);
    }
  });

  it('costs one byte for the adjacent cells a wall is made of', () => {
    const buf: number[] = [];
    for (let i = 0; i < 32; i++) writeVarint(buf, 1);
    expect(buf.length).toBe(32);
  });
});

/* ------------------------------------------------------------------------ *
 * The file format
 * ------------------------------------------------------------------------ */

describe('world file', () => {
  function build(): PersistentWorld {
    const fs = new MemoryWorldFs();
    const store = freshStore(fs);
    const w = store.create({ name: 'Codec', ownerId: 'alice', seed: SEED });
    expect(w).not.toBeNull();
    const world = w as PersistentWorld;
    for (let i = 0; i < 40; i++) {
      world.applyEdit('alice', i - 10, 20 + (i % 5), 3, BlockId.STONE + (i % 4), 1);
    }
    world.applyEdit('alice', AIR_X, AIR_Y, AIR_Z, BlockId.NEON, 1);
    return world;
  }

  it('re-encodes byte for byte after a decode', () => {
    const world = build();
    const a = encodeWorld(world);
    const back = decodeWorld(a);
    const b = encodeWorld(back);
    expect(b.length).toBe(a.length);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('preserves every delta, the metadata and the share code', () => {
    const world = build();
    const back = decodeWorld(encodeWorld(world));
    expect(back.meta.id).toBe(world.meta.id);
    expect(back.meta.name).toBe('Codec');
    expect(back.meta.ownerId).toBe('alice');
    expect(back.meta.seed).toBe(SEED);
    expect(back.code).toBe(world.code);
    expect(back.log.size).toBe(world.log.size);
    world.log.forEachSorted((key, id) => {
      expect(back.log.get(key)).toBe(id);
    });
  });

  it('rejects a file that is not ours', () => {
    expect(() => decodeWorld(Uint8Array.from([1, 2, 3, 4, 0, 0, 0, 0, 0, 0]))).toThrow(/DCW1/);
  });

  it('costs two bytes per voxel for a wall and under five for scattered edits', () => {
    // A wall: contiguous cells, one builder. Gap 1, id byte, no actor byte.
    const store = freshStore(new MemoryWorldFs());
    const wall = store.create({ name: 'Wall', ownerId: 'alice', seed: SEED }) as PersistentWorld;
    for (let x = -60; x < 60; x++) {
      for (let y = 30; y < 38; y++) wall.applyEdit('alice', x, y, 4, BlockId.BRICK, 1);
    }
    const wallBytes = encodeWorld(wall);
    const wallOverhead = JSON.stringify(wall.meta).length + 14;
    expect(wall.log.size).toBe(120 * 8);
    expect((wallBytes.length - wallOverhead) / wall.log.size).toBeLessThanOrEqual(2.05);

    // The pathological case: edits scattered across the whole height, so every
    // gap is a three-byte varint. Still comfortably better than a flat record.
    const world = build();
    const bytes = encodeWorld(world);
    const overhead = JSON.stringify(world.meta).length + 14;
    expect((bytes.length - overhead) / world.log.size).toBeLessThan(5);
  });
});

/* ------------------------------------------------------------------------ *
 * 1. A placed block survives save -> restart -> load
 * ------------------------------------------------------------------------ */

describe('restart survival', () => {
  it('a block placed before a restart is still there after it', async () => {
    const fs = new MemoryWorldFs();

    // --- session one -----------------------------------------------------
    const storeA = freshStore(fs);
    await storeA.load();
    const created = storeA.create({ name: 'Persistence', ownerId: 'alice', seed: SEED });
    expect(created).not.toBeNull();
    const worldA = created as PersistentWorld;
    const id = worldA.id;
    const code = worldA.code;

    // The generator says this cell is empty sky; assert that before we build
    // in it, or the test would pass on a world that was never edited.
    const pristine = new ServerWorld(SEED);
    expect(pristine.getBlock(AIR_X, AIR_Y, AIR_Z)).toBe(BlockId.AIR);

    expect(worldA.applyEdit('alice', AIR_X, AIR_Y, AIR_Z, BlockId.OBSIDIAN, 1_000_001))
      .toBe(WorldEditResult.OK);
    expect(worldA.dirty).toBe(true);

    const saved = await storeA.flush();
    expect(saved).toBe(1);
    expect(worldA.dirty).toBe(false);
    // Atomic: the temp file must not survive the rename.
    expect([...fs.files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
    expect(fs.files.has(`/worlds/${id}.dcw`)).toBe(true);

    // --- the process dies here -------------------------------------------

    // --- session two -----------------------------------------------------
    const storeB = freshStore(fs);
    const n = await storeB.load();
    expect(n).toBe(1);

    const worldB = storeB.get(id);
    expect(worldB).not.toBeNull();
    const reloaded = worldB as PersistentWorld;
    expect(reloaded.blockAt(AIR_X, AIR_Y, AIR_Z)).toBe(BlockId.OBSIDIAN);
    expect(reloaded.meta.ownerId).toBe('alice');
    expect(reloaded.roleOf('alice')).toBe(WorldRole.OWNER);
    expect(reloaded.code).toBe(code);
    expect(storeB.byCode(code)?.id).toBe(id);

    // And the thing that actually matters: the next player walks into a world
    // that has the block in it.
    const live = new ServerWorld(SEED);
    expect(live.getBlock(AIR_X, AIR_Y, AIR_Z)).toBe(BlockId.AIR);
    const applied = reloaded.applyTo(live);
    expect(applied).toBe(1);
    expect(live.getBlock(AIR_X, AIR_Y, AIR_Z)).toBe(BlockId.OBSIDIAN);
  });

  it('survives a restart with a thousand edits and a break among them', async () => {
    const fs = new MemoryWorldFs();
    const storeA = freshStore(fs);
    await storeA.load();
    const world = storeA.create({ name: 'Big', ownerId: 'alice', seed: SEED }) as PersistentWorld;

    for (let i = 0; i < 1000; i++) {
      const x = (i % 40) - 20;
      const z = ((i / 40) | 0) - 12;
      expect(world.applyEdit('alice', x, 50, z, BlockId.PLANKS, 1_000_000 + i)).toBe(WorldEditResult.OK);
    }
    // Dig one back out again. A break is a delta too, not the absence of one.
    expect(world.applyEdit('alice', 0, 50, -12, BlockId.AIR, 1_002_000)).toBe(WorldEditResult.OK);
    await storeA.flush();

    const storeB = freshStore(fs);
    await storeB.load();
    const back = storeB.get(world.id) as PersistentWorld;
    expect(back.log.size).toBe(1000);
    expect(back.blockAt(0, 50, -12)).toBe(BlockId.AIR);
    expect(back.blockAt(1, 50, -12)).toBe(BlockId.PLANKS);

    const live = new ServerWorld(SEED);
    back.applyTo(live);
    expect(live.getBlock(1, 50, -12)).toBe(BlockId.PLANKS);
    expect(live.getBlock(0, 50, -12)).toBe(BlockId.AIR);
  });

  it('autosaves a dirty world once the debounce window has passed', async () => {
    const fs = new MemoryWorldFs();
    let clock = 0;
    const store = new WorldStore({ dir: '/worlds', fs, now: () => clock, autosaveMs: 1000, codeSeed: 3 });
    await store.load();
    const world = store.create({ name: 'Auto', ownerId: 'alice', seed: SEED }) as PersistentWorld;
    world.applyEdit('alice', 1, 40, 1, BlockId.STONE, clock);

    clock = 500;
    expect(store.pump(clock)).toEqual([]);
    clock = 1600;
    expect(store.pump(clock)).toEqual([world.id]);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.files.has(`/worlds/${world.id}.dcw`)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Two clients editing converge
 * ------------------------------------------------------------------------ */

describe('two clients converge', () => {
  it('interleaved edits from two builders produce one identical world for both', () => {
    const fs = new MemoryWorldFs();
    const store = freshStore(fs);
    const world = store.create({ name: 'Shared', ownerId: 'alice', seed: SEED }) as PersistentWorld;
    world.join('bob', 'Bob', 1);          // defaultRole is BUILDER
    expect(world.roleOf('bob')).toBe(WorldRole.BUILDER);

    // Both clients start from the same generated terrain.
    const alice = new MapTarget();
    const bob = new MapTarget();

    // Alice and Bob type over each other, including on the same cell twice.
    const script: Array<[string, number, number, number, number]> = [
      ['alice', 0, 40, 0, BlockId.STONE],
      ['bob', 1, 40, 0, BlockId.BRICK],
      ['alice', 1, 40, 0, BlockId.GLASS],     // conflict: alice overwrites bob
      ['bob', 2, 40, 0, BlockId.METAL],
      ['alice', 2, 40, 0, BlockId.AIR],       // conflict: alice breaks bob's block
      ['bob', 2, 40, 0, BlockId.NEON],        // conflict: bob wins, he was last
      ['bob', 0, 41, 0, BlockId.PLANKS],
      ['alice', 0, 42, 0, BlockId.SNOW],
    ];
    for (const [who, x, y, z, id] of script) {
      expect(world.applyEdit(who, x, y, z, id, 2)).toBe(WorldEditResult.OK);
    }

    // The server streams the log to both of them. Each replays independently.
    world.applyTo(alice);
    world.applyTo(bob);

    expect(alice.cells.size).toBe(bob.cells.size);
    for (const [key, id] of alice.cells) expect(bob.cells.get(key)).toBe(id);

    // Last write wins, per cell.
    expect(world.blockAt(1, 40, 0)).toBe(BlockId.GLASS);
    expect(world.blockAt(2, 40, 0)).toBe(BlockId.NEON);
    expect(alice.getBlock(2, 40, 0)).toBe(BlockId.NEON);
    expect(bob.getBlock(1, 40, 0)).toBe(BlockId.GLASS);
    // Five distinct cells were touched; forty-odd writes did not become forty entries.
    expect(world.log.size).toBe(5);
  });

  it('a client that missed the middle of the session catches up from the log', () => {
    const fs = new MemoryWorldFs();
    const store = freshStore(fs);
    const world = store.create({ name: 'Catchup', ownerId: 'alice', seed: SEED }) as PersistentWorld;
    world.join('bob', 'Bob', 1);

    const alice = new MapTarget();
    const bob = new MapTarget();

    world.applyEdit('alice', 0, 40, 0, BlockId.STONE, 1);
    world.applyTo(alice);
    world.applyTo(bob);
    const bobSerial = world.log.serial;

    // Bob's socket stalls. Alice keeps building.
    for (let i = 1; i <= 12; i++) world.applyEdit('alice', i, 40, 0, BlockId.BRICK, 2);
    world.applyTo(alice);

    // Bob comes back and asks for everything after the serial he last saw.
    const missed: WorldChange[] = [];
    const head = world.log.drainSince(bobSerial, missed);
    expect(head).toBe(world.log.serial);
    expect(missed.length).toBe(12);
    for (const c of missed) bob.setBlock(c.x, c.y, c.z, c.id, 0);

    expect(bob.cells.size).toBe(alice.cells.size);
    for (const [key, id] of alice.cells) expect(bob.cells.get(key)).toBe(id);
  });

  it('reports -1 when the catch-up ring no longer reaches back that far', () => {
    const log = new WorldDeltaLog();
    for (let i = 0; i < 6000; i++) log.set(i, BlockId.STONE, 1);
    const out: WorldChange[] = [];
    expect(log.drainSince(0, out)).toBe(-1);
    expect(log.drainSince(log.serial - 10, out)).toBe(log.serial);
    expect(out.length).toBe(10);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Permissions and codes
 * ------------------------------------------------------------------------ */

describe('permissions', () => {
  function setup(): { store: WorldStore; world: PersistentWorld } {
    const store = freshStore(new MemoryWorldFs());
    const world = store.create({
      name: 'Locked', ownerId: 'alice', seed: SEED, defaultRole: WorldRole.VISITOR,
    }) as PersistentWorld;
    return { store, world };
  }

  it('a visitor may look but not build', () => {
    const { world } = setup();
    expect(world.roleOf('carol')).toBe(WorldRole.VISITOR);
    expect(world.applyEdit('carol', 0, 40, 0, BlockId.STONE, 1)).toBe(WorldEditResult.NO_PERMISSION);
    expect(world.log.size).toBe(0);
  });

  it('the owner can promote a visitor to a builder, and then they can build', () => {
    const { store, world } = setup();
    expect(store.setRole(world.id, 'carol', WorldRole.BUILDER, 'bob')).toBe(false);
    expect(store.setRole(world.id, 'carol', WorldRole.BUILDER, 'alice')).toBe(true);
    expect(world.applyEdit('carol', 0, 40, 0, BlockId.STONE, 1)).toBe(WorldEditResult.OK);
  });

  it('the owner cannot be demoted, and only the owner renames or deletes', async () => {
    const { store, world } = setup();
    store.setRole(world.id, 'bob', WorldRole.BUILDER, 'alice');
    expect(store.setRole(world.id, 'alice', WorldRole.VISITOR, 'alice')).toBe(false);
    expect(world.roleOf('alice')).toBe(WorldRole.OWNER);
    expect(store.rename(world.id, 'Bobs Now', 'bob')).toBe(false);
    expect(store.rename(world.id, 'Alices Still', 'alice')).toBe(true);
    expect(world.meta.name).toBe('Alices Still');
    expect(await store.remove(world.id, 'bob')).toBe(false);
    expect(await store.remove(world.id, 'alice')).toBe(true);
    expect(store.get(world.id)).toBeNull();
  });

  it('refuses edits outside the world and on the bedrock floor', () => {
    const { world } = setup();
    store_setBuilder(world);
    expect(world.applyEdit('carol', 0, 0, 0, BlockId.STONE, 1)).toBe(WorldEditResult.OUT_OF_WORLD);
    expect(world.applyEdit('carol', 9999, 40, 0, BlockId.STONE, 1)).toBe(WorldEditResult.OUT_OF_WORLD);
    expect(world.applyEdit('carol', 0, 40, 0, BlockId.WATER, 1)).toBe(WorldEditResult.NOT_PLACEABLE);
  });

  function store_setBuilder(world: PersistentWorld): void {
    world.setRole('carol', WorldRole.BUILDER, 'alice', 1);
  }
});

describe('share codes', () => {
  it('are six characters with no confusable letters', () => {
    const store = freshStore(new MemoryWorldFs());
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const w = store.create({ name: `W${i}`, ownerId: 'alice', seed: i }) as PersistentWorld;
      expect(w.code.length).toBe(CODE_LENGTH);
      expect(looksLikeCode(w.code)).toBe(true);
      expect(/[01ilo]/.test(w.code)).toBe(false);
      expect(seen.has(w.code)).toBe(false);
      seen.add(w.code);
    }
  });

  it('reads a code back in any case and spacing', () => {
    const store = freshStore(new MemoryWorldFs());
    const w = store.create({ name: 'Coded', ownerId: 'alice', seed: 1 }) as PersistentWorld;
    const pretty = `${w.code.slice(0, 3).toUpperCase()} ${w.code.slice(3).toUpperCase()}`;
    expect(normaliseCode(pretty)).toBe(w.code);
    expect(store.resolve(pretty.toLowerCase().replace(' ', ''))?.id).toBe(w.id);
    expect(store.resolve(w.id)?.id).toBe(w.id);
    expect(store.resolve('zzzzzz')).toBeNull();
  });

  it('refuses a code with a letter the alphabet does not contain', () => {
    expect(normaliseCode('abcdio')).toBe('');
    expect(normaliseCode('abcde')).toBe('');
    expect(normaliseCode('abcdefg')).toBe('');
  });
});

/* ------------------------------------------------------------------------ *
 * Duplicate + HTTP
 * ------------------------------------------------------------------------ */

describe('duplicate and HTTP', () => {
  it('duplicates the whole log under a new id and a new code', () => {
    const store = freshStore(new MemoryWorldFs());
    const src = store.create({ name: 'Original', ownerId: 'alice', seed: SEED }) as PersistentWorld;
    for (let i = 0; i < 20; i++) src.applyEdit('alice', i, 40, 0, BlockId.BRICK, 1);
    const copy = store.duplicate(src.id, '', 'alice') as PersistentWorld;
    expect(copy.id).not.toBe(src.id);
    expect(copy.code).not.toBe(src.code);
    expect(copy.meta.name).toBe('Original copy');
    expect(copy.log.size).toBe(src.log.size);
    expect(copy.blockAt(7, 40, 0)).toBe(BlockId.BRICK);
    // And they are independent afterwards.
    copy.applyEdit('alice', 7, 40, 0, BlockId.AIR, 2);
    expect(src.blockAt(7, 40, 0)).toBe(BlockId.BRICK);
  });

  it('serves the list, creates, renames and refuses a stranger', async () => {
    const store = freshStore(new MemoryWorldFs());
    expect(await store.handle('/api/levels', 'GET', '', 'alice')).toBeNull();

    const made = await store.handle('/api/worlds', 'POST', JSON.stringify({ name: 'Via HTTP' }), 'alice');
    expect(made?.status).toBe(201);
    const id = (JSON.parse(String(made?.body)) as { world: { id: string } }).world.id;

    const list = await store.handle('/api/worlds', 'GET', '', 'alice');
    expect(list?.status).toBe(200);
    expect((JSON.parse(String(list?.body)) as { worlds: unknown[] }).worlds.length).toBe(1);

    const patchedByStranger = await store.handle(`/api/worlds/${id}`, 'PATCH', JSON.stringify({ name: 'Mine' }), 'mallory');
    expect(patchedByStranger?.status).toBe(403);

    const patched = await store.handle(`/api/worlds/${id}`, 'PATCH', JSON.stringify({ name: 'Renamed' }), 'alice');
    expect(patched?.status).toBe(200);
    expect(store.get(id)?.meta.name).toBe('Renamed');

    expect((await store.handle('/api/worlds/nope', 'GET', '', 'alice'))?.status).toBe(404);
    expect((await store.handle('/api/worlds', 'PUT', '', 'alice'))?.status).toBe(405);
  });

  it('a level-style path traversal cannot escape the world directory', async () => {
    const store = freshStore(new MemoryWorldFs());
    const res = await store.handle('/api/worlds/..%2F..%2Fetc%2Fpasswd', 'GET', '', 'alice');
    expect(res?.status).toBe(404);
    expect(String(res?.body)).not.toContain('/etc');
  });
});
