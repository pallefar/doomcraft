/**
 * World invariants the renderer, the netcode and the server all depend on.
 *
 * The padded-neighbourhood seams and the dirty fan-out are the two things a
 * mesher cannot work around if they are wrong, and worldgen determinism is what
 * lets the server ship chunks the client could have generated itself.
 */

import { describe, it, expect } from 'vitest';
import { CHUNK_VOLUME, CHUNK_HEIGHT, SEA_LEVEL } from '@shared/constants';
import { BlockId, BLOCK_SOLID } from '@shared/blocks';
import { WeaponId } from '@shared/weapons';
import { VoxelWorld, createNeighbourhood, nbIndex, NB_VOLUME } from './voxelWorld';
import {
  generateChunkInto, findSpawnPoints, surfaceHeightAt, resolveSpawnFeet,
  themeAt, baseHeight, Theme, TERRACE_STEP, TERRAIN_VERSION,
} from './terrain';
import {
  carveSphere, explode, breakBlock, placeBlock, DigController, applyServerDeltas,
} from './destruction';

const SEED = 1337;

function loadedWorld(radius = 1): VoxelWorld {
  const w = new VoxelWorld();
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) w.ensureChunk(cx, cz).loaded = true;
  }
  return w;
}

function stoneBox(w: VoxelWorld, r: number, y0: number, y1: number, id = BlockId.STONE): void {
  for (let y = y0; y <= y1; y++) {
    for (let z = -r; z <= r; z++) for (let x = -r; x <= r; x++) w.setBlock(x, y, z, id);
  }
}

/* ------------------------------------------------------------------------ */

describe('terrain', () => {
  it('is deterministic in the seed alone', () => {
    const a = new Uint8Array(CHUNK_VOLUME);
    const b = new Uint8Array(CHUNK_VOLUME);
    generateChunkInto(SEED, 3, -2, a);
    generateChunkInto(SEED + 1, 0, 0, b);        // clobber the lattice caches
    generateChunkInto(SEED, 3, -2, b);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    expect(TERRAIN_VERSION).toBe(1);
  });

  it('quantises the base height into 3-block terraces', () => {
    // Terracing is what makes a cliff read as level geometry instead of a ramp.
    let onStep = 0;
    let total = 0;
    for (let z = -180; z < 200; z += 7) {
      for (let x = -180; x < 200; x += 7) {
        if (Math.round(baseHeight(SEED, x, z)) % TERRACE_STEP === 0) onStep++;
        total++;
      }
    }
    expect(onStep / total).toBeGreaterThan(0.85);
  });

  it('caps every chunk with bedrock and keeps everything inside the column', () => {
    const c = new Uint8Array(CHUNK_VOLUME);
    generateChunkInto(SEED, 0, 0, c);
    let bedrock = 0;
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 32; x++) {
        if (c[x | (z << 5)] === BlockId.BEDROCK) bedrock++;
        // Nothing may reach the ceiling, or the mesher has no air neighbour up there.
        expect(c[x | (z << 5) | ((CHUNK_HEIGHT - 1) << 10)]).toBe(BlockId.AIR);
      }
    }
    expect(bedrock).toBe(1024);
  });

  it('builds all three themes and puts lava in the world', () => {
    let out = 0, tech = 0, hell = 0;
    for (let z = -190; z < 210; z += 6) {
      for (let x = -190; x < 210; x += 6) {
        const t = themeAt(SEED, x, z);
        if (t === Theme.OUTLAND) out++; else if (t === Theme.TECH) tech++; else hell++;
      }
    }
    expect(out).toBeGreaterThan(0);
    expect(tech).toBeGreaterThan(0);
    expect(hell).toBeGreaterThan(0);

    const c = new Uint8Array(CHUNK_VOLUME);
    let lava = 0;
    let structural = 0;
    for (let cz = -4; cz <= 4 && lava === 0; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        generateChunkInto(SEED, cx, cz, c);
        for (let i = 0; i < CHUNK_VOLUME; i++) {
          const v = c[i];
          if (v === BlockId.LAVA) lava++;
          else if (v === BlockId.METAL || v === BlockId.BRICK || v === BlockId.TECH_PANEL ||
                   v === BlockId.OBSIDIAN || v === BlockId.HELLSTONE) structural++;
        }
      }
    }
    expect(lava).toBeGreaterThan(0);
    expect(structural).toBeGreaterThan(1000);
  });

  it('produces spawn points that resolve to standable ground', () => {
    const spawns = new Float64Array(60);
    const n = findSpawnPoints(SEED, spawns, 20);
    expect(n).toBeGreaterThan(4);

    const w = new VoxelWorld();
    const scratch = new Uint8Array(CHUNK_VOLUME);
    const scx = Math.round(spawns[0]) >> 5;
    const scz = Math.round(spawns[2]) >> 5;
    for (let cz = scz - 2; cz <= scz + 2; cz++) {
      for (let cx = scx - 2; cx <= scx + 2; cx++) {
        generateChunkInto(SEED, cx, cz, scratch);
        w.copyChunkIn(cx, cz, scratch);
      }
    }

    let ok = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.round(spawns[i * 3]);
      const z = Math.round(spawns[i * 3 + 2]);
      if ((x >> 5) < scx - 2 || (x >> 5) > scx + 2 || (z >> 5) < scz - 2 || (z >> 5) > scz + 2) continue;
      const feet = resolveSpawnFeet(x, z, (a, b) => w.highestGroundY(a, b), (a, b, c) => w.blockAt(a, b, c));
      if (feet < 0) continue;
      ok++;
      expect(BLOCK_SOLID[w.blockAt(x, feet - 1, z)]).toBe(1);
      expect(w.blockAt(x, feet, z)).toBe(BlockId.AIR);
      expect(w.blockAt(x, feet + 1, z)).toBe(BlockId.AIR);
      expect(feet).toBeGreaterThan(SEA_LEVEL);
    }
    expect(ok).toBeGreaterThan(0);
  });

  it('agrees between the point query and the batch generator', () => {
    const c = new Uint8Array(CHUNK_VOLUME);
    generateChunkInto(SEED, -2, 1, c);
    for (let lz = 1; lz < 32; lz += 9) {
      for (let lx = 1; lx < 32; lx += 9) {
        const h = surfaceHeightAt(SEED, -2 * 32 + lx, 1 * 32 + lz);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(CHUNK_HEIGHT);
      }
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('voxelWorld', () => {
  it('extracts a padded neighbourhood with the right seams', () => {
    const w = loadedWorld();
    w.setBlock(0, 5, 0, BlockId.STONE);
    w.setBlock(-1, 5, -1, BlockId.BRICK);      // -X-Z corner column
    w.setBlock(-1, 5, 0, BlockId.METAL);       // -X face
    w.setBlock(32, 5, 0, BlockId.SAND);        // +X face
    w.setBlock(0, 5, 32, BlockId.WOOD);        // +Z face
    w.setBlock(0, 5, -1, BlockId.GLASS);       // -Z face
    w.setBlock(31, 7, 31, BlockId.NEON);

    const nb = createNeighbourhood();
    expect(nb.length).toBe(NB_VOLUME);
    expect(w.extractNeighbourhood(0, 0, nb)).toBe(true);

    expect(nb[nbIndex(0, 5, 0)]).toBe(BlockId.STONE);
    expect(nb[nbIndex(-1, 5, -1)]).toBe(BlockId.BRICK);
    expect(nb[nbIndex(-1, 5, 0)]).toBe(BlockId.METAL);
    expect(nb[nbIndex(32, 5, 0)]).toBe(BlockId.SAND);
    expect(nb[nbIndex(0, 5, 32)]).toBe(BlockId.WOOD);
    expect(nb[nbIndex(0, 5, -1)]).toBe(BlockId.GLASS);
    expect(nb[nbIndex(31, 7, 31)]).toBe(BlockId.NEON);
    // Under the world is bedrock so no downward faces are emitted; above is air.
    expect(nb[nbIndex(0, -1, 0)]).toBe(BlockId.BEDROCK);
    expect(nb[nbIndex(0, CHUNK_HEIGHT, 0)]).toBe(BlockId.AIR);
    expect(w.hasAllNeighbours(0, 0)).toBe(true);
  });

  it('reports a missing neighbour so the scheduler can defer', () => {
    const w = new VoxelWorld();
    w.ensureChunk(0, 0).loaded = true;
    expect(w.hasAllNeighbours(0, 0)).toBe(false);
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz).loaded = true;
    expect(w.hasAllNeighbours(0, 0)).toBe(true);
  });

  it('fans dirt out to exactly the chunks a border edit can change', () => {
    const w = loadedWorld();
    const out = new Int32Array(16);
    w.takeDirty(out, 16);
    w.setBlock(10, 5, 10, BlockId.STONE);
    expect(w.takeDirty(out, 16)).toBe(1);
    w.setBlock(0, 5, 0, BlockId.STONE);          // corner: self + 3
    expect(w.takeDirty(out, 16)).toBe(4);
    w.setBlock(0, 5, 10, BlockId.STONE);         // -X edge: self + 1
    expect(w.takeDirty(out, 16)).toBe(2);
    expect(w.dirtyCount).toBe(0);
  });

  it('keeps solidCount, maxY and the lookup cache honest', () => {
    const w = loadedWorld(0);
    const rec = w.getChunk(0, 0)!;
    w.setBlock(1, 20, 1, BlockId.STONE);
    w.setBlock(2, 30, 2, BlockId.STONE);
    expect(rec.solidCount).toBe(2);
    expect(rec.maxY).toBe(30);
    expect(w.solidCount).toBe(2);
    expect(w.highestSolidY(2, 2)).toBe(30);
    w.setBlock(2, 30, 2, BlockId.AIR);
    expect(rec.maxY).toBe(20);
    expect(w.solidCount).toBe(1);
  });

  it('closes the arena: out of world and below y=0 are solid, above is not', () => {
    const w = new VoxelWorld();
    expect(w.solidAt(0, -1, 0)).toBe(true);
    expect(w.solidAt(w.maxBlockX + 1, 10, 0)).toBe(true);
    expect(w.solidAt(0, CHUNK_HEIGHT, 0)).toBe(false);
    expect(w.blockAt(0, -1, 0)).toBe(BlockId.BEDROCK);
  });
});

/* ------------------------------------------------------------------------ */

describe('destruction', () => {
  it('a rocket opens a real hole in stone', () => {
    const w = loadedWorld();
    stoneBox(w, 10, 10, 22);
    const before = w.solidCount;
    const removed = explode(w, 0.5, 16.5, 0.5, WeaponId.ROCKET, 4242);
    expect(removed).toBeGreaterThan(40);
    expect(w.solidCount).toBe(before - removed);
    expect(w.blockAt(0, 16, 0)).toBe(BlockId.AIR);
    // Every removed voxel is inside the stated radius.
    for (let y = 10; y <= 22; y++) {
      for (let z = -10; z <= 10; z++) {
        for (let x = -10; x <= 10; x++) {
          if (w.blockAt(x, y, z) !== BlockId.AIR) continue;
          const d = Math.hypot(x + 0.5 - 0.5, y + 0.5 - 16.5, z + 0.5 - 0.5);
          expect(d).toBeLessThanOrEqual(2.6);
        }
      }
    }
  });

  it('obsidian is blast-proof and bedrock is untouchable', () => {
    const w = loadedWorld();
    stoneBox(w, 8, 10, 20, BlockId.OBSIDIAN);
    expect(explode(w, 0.5, 15.5, 0.5, WeaponId.ROCKET, 1)).toBe(0);
    expect(explode(w, 0.5, 15.5, 0.5, WeaponId.BFG, 1)).toBe(0);
    stoneBox(w, 8, 10, 20, BlockId.BEDROCK);
    expect(carveSphere(w, 0.5, 15.5, 0.5, 6, 100, 1)).toBe(0);
  });

  it('a BFG crater dwarfs a rocket crater', () => {
    function crater(weapon: number): number {
      const w = loadedWorld();
      stoneBox(w, 12, 4, 28);
      return explode(w, 0.5, 16.5, 0.5, weapon, 77);
    }
    expect(crater(WeaponId.BFG)).toBeGreaterThan(crater(WeaponId.ROCKET) * 4);
  });

  it('carves identically on both sides from the same seed', () => {
    const a = loadedWorld(); stoneBox(a, 8, 10, 20);
    const b = loadedWorld(); stoneBox(b, 8, 10, 20);
    expect(carveSphere(a, 1.5, 15.5, -0.5, 3.2, 5, 9001))
      .toBe(carveSphere(b, 1.5, 15.5, -0.5, 3.2, 5, 9001));
    for (let y = 10; y <= 20; y++) {
      for (let z = -8; z <= 8; z++) {
        for (let x = -8; x <= 8; x++) expect(a.blockAt(x, y, z)).toBe(b.blockAt(x, y, z));
      }
    }
  });

  it('digs a stone block in hardness x base time', () => {
    const w = loadedWorld(0);
    w.setBlock(1, 5, 1, BlockId.STONE);
    const dig = new DigController();
    let ms = 0;
    let broke = false;
    const stages: number[] = [];
    const fx = { digProgress(_x: number, _y: number, _z: number, _p: number, s: number) { stages.push(s); } };
    while (!broke && ms < 2000) { broke = dig.update(w, true, true, 1, 5, 1, 16, fx); ms += 16; }
    expect(broke).toBe(true);
    expect(ms).toBeGreaterThan(320);      // 1.5 hardness * 220 ms
    expect(ms).toBeLessThan(360);
    expect(stages.filter((s) => s >= 0).length).toBeGreaterThan(5);
    expect(breakBlock(w, 1, 5, 1)).toBe(BlockId.STONE);
    expect(breakBlock(w, 1, 5, 1)).toBe(0);
  });

  it('abandons a dig when the target changes', () => {
    const w = loadedWorld(0);
    w.setBlock(1, 5, 1, BlockId.STONE);
    w.setBlock(2, 5, 1, BlockId.STONE);
    const dig = new DigController();
    for (let i = 0; i < 10; i++) dig.update(w, true, true, 1, 5, 1, 16);
    expect(dig.progress).toBeGreaterThan(0.3);
    dig.update(w, true, true, 2, 5, 1, 16);
    expect(dig.progress).toBeLessThan(0.1);
    expect(dig.x).toBe(2);
  });

  it('will not place into a body, into a solid, or an unplaceable id', () => {
    const w = loadedWorld(0);
    const occupied = (x: number, y: number, z: number) => x === 2 && y === 3 && z === 2;
    expect(placeBlock(w, 2, 3, 2, BlockId.STONE, occupied)).toBe(false);
    expect(placeBlock(w, 3, 3, 2, BlockId.STONE, occupied)).toBe(true);
    expect(placeBlock(w, 3, 3, 2, BlockId.BRICK, occupied)).toBe(false);
    expect(placeBlock(w, 4, 3, 2, BlockId.BEDROCK, occupied)).toBe(false);
    expect(placeBlock(w, 4, 3, 2, BlockId.WATER, occupied)).toBe(false);
  });

  it('applies server deltas without re-running placement rules', () => {
    const w = loadedWorld(0);
    w.setBlock(4, 4, 4, BlockId.STONE);
    const xs = new Int16Array([4, 5]);
    const ys = new Uint8Array([4, 4]);
    const zs = new Int16Array([4, 4]);
    const ids = new Uint8Array([BlockId.AIR, BlockId.BEDROCK]);
    expect(applyServerDeltas(w, 2, xs, ys, zs, ids)).toBe(2);
    expect(w.blockAt(4, 4, 4)).toBe(BlockId.AIR);
    expect(w.blockAt(5, 4, 4)).toBe(BlockId.BEDROCK);
  });
});
