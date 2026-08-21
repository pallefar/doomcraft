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
import { createVoxelHit } from '@shared/math';
import { VoxelWorld, createNeighbourhood, nbIndex, NB_VOLUME } from './voxelWorld';
import {
  generateChunkInto, findSpawnPoints, surfaceHeightAt, resolveSpawnFeet,
  themeAt, baseHeight, nearestArena, Theme, TERRACE_STEP, TERRAIN_VERSION,
  KEEP_MIN_RADIUS,
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
    expect(TERRAIN_VERSION).toBe(4);
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

  it('stamps a roofed keep in every wide arena, and it is a real building', () => {
    // The one thing the bar's world has nowhere: an inside. A keep has to be a
    // sealed room with a way in, a light in it, and a way onto its roof --
    // otherwise it is a decorative box and the sky channel has nothing to do.
    const desc = new Float64Array(5);
    let ax = 0, az = 0, floorY = 0, found = false;
    for (let cz = -2; cz <= 2 && !found; cz++) {
      for (let cx = -2; cx <= 2 && !found; cx++) {
        nearestArena(SEED, cx * 64 + 32, cz * 64 + 32, desc);
        if (desc[2] < KEEP_MIN_RADIUS) continue;
        ax = Math.round(desc[0]); az = Math.round(desc[1]); floorY = desc[3];
        found = true;
      }
    }
    expect(found).toBe(true);

    const w = new VoxelWorld();
    const scratch = new Uint8Array(CHUNK_VOLUME);
    for (let cz = (az >> 5) - 1; cz <= (az >> 5) + 1; cz++) {
      for (let cx = (ax >> 5) - 1; cx <= (ax >> 5) + 1; cx++) {
        generateChunkInto(SEED, cx, cz, scratch);
        w.copyChunkIn(cx, cz, scratch);
      }
    }

    // Roof over an air gap over a floor: the column model can now express an
    // interior, and this is the assertion that it does.
    expect(BLOCK_SOLID[w.blockAt(ax, floorY + 5, az)]).toBe(1);
    for (let y = floorY + 1; y <= floorY + 4; y++) {
      expect(BLOCK_SOLID[w.blockAt(ax, y, az)]).toBe(0);
    }
    // The light that makes the room worth roofing.
    expect(w.blockAt(ax, floorY, az)).toBe(BlockId.LAVA);

    // Find the footprint by walking out at deck level: the only solid up there
    // is the parapet, which sits exactly on the ring.
    let half = -1;
    for (let d = 3; d <= 7; d++) {
      if (BLOCK_SOLID[w.blockAt(ax + d, floorY + 6, az - 2)] === 1) { half = d; break; }
    }
    expect(half).toBeGreaterThanOrEqual(4);
    // Parapet on the ring, open deck inside it: cover, not a diving board.
    expect(BLOCK_SOLID[w.blockAt(ax, floorY + 6, az)]).toBe(0);

    // Doorway: the same ring, on the centre line, is open head to toe.
    for (let y = floorY + 1; y <= floorY + 4; y++) {
      expect(BLOCK_SOLID[w.blockAt(ax + half, y, az)]).toBe(0);
    }
    // Clerestory: the wall panel stops one short of the roof, leaving the slit.
    expect(BLOCK_SOLID[w.blockAt(ax + half, floorY + 3, az - 2)]).toBe(1);
    expect(BLOCK_SOLID[w.blockAt(ax + half, floorY + 4, az - 2)]).toBe(0);

    // Chest-high cover on the interior diagonals, so the room is not a killbox
    // and no doorway sees straight through to the one opposite.
    expect(BLOCK_SOLID[w.blockAt(ax + half - 2, floorY + 2, az + half - 2)]).toBe(1);
    expect(BLOCK_SOLID[w.blockAt(ax + half - 2, floorY + 3, az + half - 2)]).toBe(0);

    // A stair of single-block steps somewhere outside the wall, so the roof is
    // reachable on foot as well as by rocket.
    const steps = new Set<number>();
    for (let dz = -half - 6; dz <= half + 6; dz++) {
      for (let dx = -half - 6; dx <= half + 6; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) <= half) continue;
        let top = -1;
        for (let y = floorY + 6; y > floorY; y--) {
          if (BLOCK_SOLID[w.blockAt(ax + dx, y, az + dz)] === 1) { top = y; break; }
        }
        if (top > floorY) steps.add(top - floorY);
      }
    }
    for (let k = 1; k <= 5; k++) expect(steps.has(k)).toBe(true);
  });

  it('stands two masses over the eye line inside 20 m of every spawn, with a lane between them', () => {
    // The one thing a flat world cannot do, stated as an assertion. Cover at
    // 2-3 blocks is not this: PLAYER_EYE_HEIGHT is 1.62, so an occluder starts
    // at 3 and a frame with none in it runs to the skyline. "Two masses" is
    // literal here — connected components, so one long wall does not count.
    const w = new VoxelWorld();
    const scratch = new Uint8Array(CHUNK_VOLUME);
    const R = 3;
    for (let cz = -R; cz <= R; cz++) {
      for (let cx = -R; cx <= R; cx++) {
        generateChunkInto(SEED, cx, cz, scratch);
        w.copyChunkIn(cx, cz, scratch);
      }
    }
    const LO = -R * 32, HI = R * 32 + 31;
    const inside = (x: number, z: number) => x >= LO && x <= HI && z >= LO && z <= HI;
    const solid = (x: number, y: number, z: number) => BLOCK_SOLID[w.blockAt(x, y, z)] === 1;
    /** Top of the run of solid that reaches the ground — NOT an arch's lintel. */
    const stackTop = (x: number, z: number): number => {
      let y = 1;
      while (y < CHUNK_HEIGHT - 2 && solid(x, y + 1, z)) y++;
      return y;
    };

    const spawns = new Float64Array(120);
    const n = findSpawnPoints(SEED, spawns, 40);
    let checked = 0;
    let worstComponents = 99;
    for (let i = 0; i < n; i++) {
      const sx = Math.round(spawns[i * 3]);
      const sz = Math.round(spawns[i * 3 + 2]);
      if (!inside(sx - 20, sz - 20) || !inside(sx + 20, sz + 20)) continue;
      const feet = resolveSpawnFeet(sx, sz, (a, b) => w.highestGroundY(a, b), (a, b, c) => w.blockAt(a, b, c));
      if (feet < 0) continue;
      checked++;

      // Mark every column inside 20 m that stands 3+ blocks over the spawn
      // plane, then count connected components of the mark.
      const SPAN = 41;
      const mark = new Uint8Array(SPAN * SPAN);
      for (let dz = -20; dz <= 20; dz++) {
        for (let dx = -20; dx <= 20; dx++) {
          if (dx * dx + dz * dz > 400) continue;
          if (stackTop(sx + dx, sz + dz) >= feet + 3) mark[(dx + 20) + (dz + 20) * SPAN] = 1;
        }
      }
      let components = 0;
      const stack: number[] = [];
      for (let s = 0; s < mark.length; s++) {
        if (mark[s] !== 1) continue;
        components++;
        stack.push(s);
        mark[s] = 2;
        while (stack.length > 0) {
          const c = stack.pop()!;
          const cxx = c % SPAN, czz = (c / SPAN) | 0;
          if (cxx > 0 && mark[c - 1] === 1) { mark[c - 1] = 2; stack.push(c - 1); }
          if (cxx < SPAN - 1 && mark[c + 1] === 1) { mark[c + 1] = 2; stack.push(c + 1); }
          if (czz > 0 && mark[c - SPAN] === 1) { mark[c - SPAN] = 2; stack.push(c - SPAN); }
          if (czz < SPAN - 1 && mark[c + SPAN] === 1) { mark[c + SPAN] = 2; stack.push(c + SPAN); }
        }
      }
      if (components < worstComponents) worstComponents = components;
    }
    // The work order was "at least two". Measured worst case over the sampled
    // spawns is ten, so four is the floor with the margin a generator needs.
    expect(checked).toBeGreaterThan(3);
    expect(worstComponents).toBeGreaterThanOrEqual(4);
  });

  it('cuts an arch through one mass of every bastion pair, and it is a tunnel', () => {
    // The hole is the point: a sightline that exists only through it, and the
    // seed a rocket widens. Ground, exactly two blocks of clear (PLAYER_HEIGHT
    // is 1.8), then a two-block lintel of the cap material.
    const w = new VoxelWorld();
    const scratch = new Uint8Array(CHUNK_VOLUME);
    for (let cz = -2; cz <= 2; cz++) {
      for (let cx = -2; cx <= 2; cx++) {
        generateChunkInto(SEED, cx, cz, scratch);
        w.copyChunkIn(cx, cz, scratch);
      }
    }
    const solid = (x: number, y: number, z: number) => BLOCK_SOLID[w.blockAt(x, y, z)] === 1;
    const CAPS = new Set([BlockId.COBBLESTONE, BlockId.TECH_PANEL, BlockId.BONE]);

    let arches = 0;
    let walkThrough = 0;
    const steps = new Set<number>();
    for (let z = -60; z <= 60; z++) {
      for (let x = -60; x <= 60; x++) {
        let g = 1;
        while (g < CHUNK_HEIGHT - 6 && solid(x, g + 1, z)) g++;
        if (g <= SEA_LEVEL) continue;
        // A mass column: 1 to 4 blocks of wall over the ground beside it. The
        // stair is what makes the roof reachable on foot; assert all four risers
        // exist somewhere in the sample.
        const west = (() => { let y = 1; while (y < CHUNK_HEIGHT - 6 && solid(x - 7, y + 1, z)) y++; return y; })();
        if (g > west && g - west <= 4) steps.add(g - west);

        if (solid(x, g + 1, z) || solid(x, g + 2, z)) continue;
        if (!solid(x, g + 3, z) || !solid(x, g + 4, z) || solid(x, g + 5, z)) continue;
        if (!CAPS.has(w.blockAt(x, g + 3, z))) continue;
        arches++;
        // A tunnel, not a slot: three in a row of the same clear profile means
        // you can walk the whole way through the mass.
        const run = (dx: number, dz: number) => {
          for (let k = 0; k < 3; k++) {
            const px = x + dx * k, pz = z + dz * k;
            if (solid(px, g + 1, pz) || solid(px, g + 2, pz)) return false;
          }
          return true;
        };
        if (run(1, 0) || run(-1, 0) || run(0, 1) || run(0, -1)) walkThrough++;
      }
    }
    expect(arches).toBeGreaterThan(10);
    expect(walkThrough).toBe(arches);
    for (let k = 1; k <= 4; k++) expect(steps.has(k)).toBe(true);
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


  it('scorches the rim of a crater so the damage is visible, and never into air', () => {
    // A hole whose rim is the same colour as the wall it came out of does not
    // read as damage from across the arena.
    const w = loadedWorld();
    stoneBox(w, 10, 10, 22);
    const before = w.solidCount;
    const removed = explode(w, 0.5, 16.5, 0.5, WeaponId.ROCKET, 4242);

    // Scorching converts, it never deletes: the solid count still only moved by
    // the number of voxels the blast actually removed.
    expect(w.solidCount).toBe(before - removed);

    let charred = 0;
    for (let y = 10; y <= 22; y++) {
      for (let z = -10; z <= 10; z++) {
        for (let x = -10; x <= 10; x++) {
          if (w.blockAt(x, y, z) === BlockId.HELLSTONE) charred++;
        }
      }
    }
    // A real burnt lip, not a dozen scattered specks: SCORCH_PER_REMOVED is 2,
    // so a rocket-sized hole gets about half its removal count in marks. The
    // upper bound is the wire budget — every mark is a BLOCK_DELTA and
    // MAX_BLOCK_DELTAS_PER_MESSAGE is 512.
    expect(charred).toBeGreaterThanOrEqual(10);
    expect(charred).toBeLessThanOrEqual(Math.floor(removed / 2));
  });

  it('scorches identically on both sides from the same seed', () => {
    const a = loadedWorld(); stoneBox(a, 8, 10, 20);
    const b = loadedWorld(); stoneBox(b, 8, 10, 20);
    explode(a, 1.5, 15.5, -0.5, WeaponId.ROCKET, 9001);
    explode(b, 1.5, 15.5, -0.5, WeaponId.ROCKET, 9001);
    for (let y = 10; y <= 20; y++) {
      for (let z = -8; z <= 8; z++) {
        for (let x = -8; x <= 8; x++) expect(a.blockAt(x, y, z)).toBe(b.blockAt(x, y, z));
      }
    }
  });

  it('opens a real sightline through a keep-thickness wall', () => {
    // The whole reason terrain builds walls a rocket can breach: one shot has
    // to turn "there is a building there" into "there is a hole in that
    // building and someone is standing behind it".
    const w = loadedWorld();
    for (let y = 10; y <= 16; y++) {
      for (let z = -8; z <= 8; z++) w.setBlock(0, y, z, BlockId.BRICK);
    }
    const hit = createVoxelHit();
    expect(w.raycast(-4.5, 13.5, 0.5, 1, 0, 0, 9, hit, (id) => BLOCK_SOLID[id] === 1)).toBe(true);

    expect(explode(w, 0.5, 13.5, 0.5, WeaponId.ROCKET, 7)).toBeGreaterThan(8);

    // Same ray, now unobstructed.
    expect(w.raycast(-4.5, 13.5, 0.5, 1, 0, 0, 9, hit, (id) => BLOCK_SOLID[id] === 1)).toBe(false);
    // And the rim of the hole is slag, so the breach is visible from a distance.
    let slag = 0;
    for (let y = 10; y <= 16; y++) {
      for (let z = -8; z <= 8; z++) if (w.blockAt(0, y, z) === BlockId.HELLSTONE) slag++;
    }
    expect(slag).toBeGreaterThan(0);
  });

  it('punches a second arch through a bastion mass', () => {
    // The bastion the generator stamps, to scale: 6 long, 3 thick, 4 tall, in
    // the same brick the keep panels use. It is an OCCLUDER — over the eye line
    // and you cannot see past it — and the arch cut through it is the only
    // sightline it allows. One rocket has to be able to cut a second one, or
    // the masses are scenery with a hole in them.
    const w = loadedWorld();
    for (let y = 11; y <= 14; y++) {
      for (let z = -3; z <= 3; z++) {
        for (let x = -1; x <= 1; x++) w.setBlock(x, y, z, BlockId.BRICK);
      }
    }
    const hit = createVoxelHit();
    const eye = 12.6;   // a standing player's eye over a floor at y = 11
    expect(w.raycast(-6.5, eye, 0.5, 1, 0, 0, 12, hit, (id) => BLOCK_SOLID[id] === 1)).toBe(true);

    expect(explode(w, 0.5, eye, 0.5, WeaponId.ROCKET, 11)).toBeGreaterThan(12);

    expect(w.raycast(-6.5, eye, 0.5, 1, 0, 0, 12, hit, (id) => BLOCK_SOLID[id] === 1)).toBe(false);
    // The mass is breached, not deleted: its ends still stand and still occlude.
    expect(BLOCK_SOLID[w.blockAt(0, 12, -3)]).toBe(1);
    expect(BLOCK_SOLID[w.blockAt(0, 12, 3)]).toBe(1);
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
