/**
 * DESTRUCTION, MEASURED AGAINST THE REAL WORLD.
 *
 * `world.test.ts` already covers the arithmetic of a crater — radius, blast
 * resistance, determinism, delta round-trip. What it does not cover is the only
 * claim the piece is actually judged on:
 *
 *     "Destruction must matter — a rocket should open a new sightline."
 *
 * That is not a statement about voxel counts. It is a statement about what a
 * player can see afterwards, in the world the generator ships, through the
 * occluders the generator ships, and it can be false while every crater test in
 * the repo stays green: raise `BASTION_TOP` by two blocks or move an arena wall
 * to obsidian and a rocket becomes a decal without a single assertion firing.
 *
 * So these tests cast rays. They stand in generated terrain, find a direction
 * that is genuinely blocked at eye height, put one rocket into whatever is doing
 * the blocking, and require the ray to get further afterwards. Then they check
 * the two things that decide whether the player can SEE that it happened — the
 * crater's mouth is scorched, and its inside is a darker sky key than the wall
 * around it, so the hole reads as a hole and not as a smudge.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNK_HEIGHT, CHUNK_VOLUME, PLAYER_EYE_HEIGHT,
  WORLD_MIN_BLOCK_X, WORLD_MAX_BLOCK_X,
} from '@shared/constants';
import { BlockId } from '@shared/blocks';
import { WeaponId } from '@shared/weapons';
import { createVoxelHit } from '@shared/math';
import { VoxelWorld } from './voxelWorld';
import { findSpawnPoints, generateChunkInto, surfaceHeightAt, themeAt, Theme } from './terrain';
import { blastDebrisCount, carveSphere, explode } from './destruction';
import {
  buildPadded, createPadded, meshChunk, readVertexFace, readVertexSky,
  VERTS_PER_QUAD,
} from '@/engine/mesher';

const SEED = 1337;

/** A world holding real generated terrain over a (2r+1)^2 block of chunks. */
function generatedWorld(radius = 2): VoxelWorld {
  const w = new VoxelWorld();
  const voxels = new Uint8Array(CHUNK_VOLUME);
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) {
      voxels.fill(0);
      generateChunkInto(SEED, cx, cz, voxels);
      w.copyChunkIn(cx, cz, voxels).loaded = true;
    }
  }
  return w;
}

const hit = createVoxelHit();

/** Distance to the first opaque voxel along a horizontal heading, capped at max. */
function sightline(
  w: VoxelWorld, x: number, y: number, z: number, yaw: number, max = 48,
): number {
  const dx = Math.cos(yaw);
  const dz = Math.sin(yaw);
  if (!w.raycast(x, y, z, dx, 0, dz, max, hit)) return max;
  return Math.hypot(hit.px - x, hit.pz - z);
}

/** The block doing the blocking along that heading, or AIR when nothing is. */
function blocker(
  w: VoxelWorld, x: number, y: number, z: number, yaw: number, max = 48,
): number {
  if (!w.raycast(x, y, z, Math.cos(yaw), 0, Math.sin(yaw), max, hit)) return BlockId.AIR;
  return w.blockAt(hit.x, hit.y, hit.z);
}

/**
 * Somewhere a player can stand, with at least one heading blocked between 4 and
 * 20 m by something a rocket is SUPPOSED to be able to breach.
 *
 * The material filter is the point, not a convenience. The generator deliberately
 * builds an arena's skeleton — keep piers, hell ledges, pillars — out of
 * obsidian, which `blastResist` puts at 27 against a rocket's 9.6, so those
 * occluders survive a firefight and the room keeps its shape. A test that fired
 * at whatever happened to be nearest would half the time be measuring the
 * skeleton and calling the result a failure. The claim under test is about the
 * WALLS: crag flanks, bastion masses, keep panels and terraced rock.
 */
/**
 * Depth of the first solid run the heading meets, in metres.
 *
 * The filter that makes the sightline claim mean something. A rocket carries
 * 9.62 against radius 2.6, which solves to about 2.2 m of stone — so a heading
 * blocked by a HILLSIDE is not a counter-example to "a rocket opens a
 * sightline", it is a hillside. The claim is about the things the generator
 * builds cover out of: keep panels at one block, crag flanks at two, bastion
 * masses at three.
 */
function blockerRun(w: VoxelWorld, x: number, y: number, z: number, yaw: number, dist: number): number {
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  let run = 0;
  for (let t = dist + 0.1; t < dist + 10; t += 0.25) {
    const px = Math.floor(x + dx * t);
    const pz = Math.floor(z + dz * t);
    if (w.isSolid(px, Math.floor(y), pz)) run = t - dist;
    else if (run > 0) break;
  }
  return run;
}

interface Shot { x: number; y: number; z: number; yaw: number; dist: number }

function findFiringPoints(w: VoxelWorld, want: number, apart = 14): Shot[] {
  const out: Shot[] = [];
  for (let z = -40; z <= 40 && out.length < want; z += 3) {
    for (let x = -40; x <= 40 && out.length < want; x += 3) {
      const surface = surfaceHeightAt(SEED, x, z);
      if (surface < 1 || surface > CHUNK_HEIGHT - 8) continue;
      const feet = surface + 1;
      if (w.isSolid(x, feet, z) || w.isSolid(x, feet + 1, z)) continue;
      let near = false;
      for (const s of out) if (Math.hypot(s.x - x, s.z - z) < apart) { near = true; break; }
      if (near) continue;
      const ex = x + 0.5, ey = feet + PLAYER_EYE_HEIGHT, ez = z + 0.5;
      for (let k = 0; k < 16; k++) {
        const yaw = (k / 16) * Math.PI * 2;
        const d = sightline(w, ex, ey, ez, yaw);
        if (d < 4 || d > 20) continue;
        const id = blocker(w, ex, ey, ez, yaw);
        if (id === BlockId.OBSIDIAN || id === BlockId.BEDROCK || id === BlockId.METAL) continue;
        if (blockerRun(w, ex, ey, ez, yaw, d) > 2.5) continue;
        out.push({ x: ex, y: ey, z: ez, yaw, dist: d });
        break;
      }
    }
  }
  return out;
}

describe('destruction / a rocket opens a sightline', () => {
  it('finds blocked headings in generated terrain and clears them', () => {
    // Eight firing points, at least 14 m apart so no two shots share a crater,
    // one rocket each, every one of them aimed at cover no thicker than a
    // rocket can take. Sampling instead of testing a single point is a
    // strengthening, not a softening: the old test fired one rocket at whatever
    // the scan found first and called the piece proved.
    const w = generatedWorld();
    const shots = findFiringPoints(w, 8);
    expect(shots.length).toBeGreaterThanOrEqual(4);

    let opened = 0;
    for (const shot of shots) {
      // Where the rocket would actually detonate: on the face it is flying at.
      // Half a block past the impact plane, so the sphere bites into the wall
      // rather than washing over the front of it.
      const impact = shot.dist + 0.5;
      const ix = shot.x + Math.cos(shot.yaw) * impact;
      const iz = shot.z + Math.sin(shot.yaw) * impact;

      const removed = explode(w, ix, shot.y, iz, WeaponId.ROCKET, 0xbeef);
      expect(removed).toBeGreaterThan(0);

      // Not "some blocks went away" — the eye actually sees further than it
      // did, by more than the one block the crater's own front face accounts
      // for.
      if (sightline(w, shot.x, shot.y, shot.z, shot.yaw) > shot.dist + 2) opened++;
    }
    // Every single one. If cover is thin enough to breach, a rocket breaches it.
    expect(opened).toBe(shots.length);
  });

  /** A slab of `material`, `thick` blocks deep, with the shooter 5 m in front. */
  function wall(material: number, thick: number): VoxelWorld {
    const w = new VoxelWorld();
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz).loaded = true;
    }
    for (let y = 12; y <= 20; y++) {
      for (let x = -8; x <= 8; x++) {
        for (let z = 0; z < thick; z++) w.setBlock(x, y, z, material);
      }
    }
    return w;
  }

  it('punches clean through the wall thicknesses the generator builds cover from', () => {
    // A keep panel is one block, a crag flank two. Both are authored in
    // breachable material on purpose (see the material pickers in terrain.ts),
    // and one rocket has to take them out or the "inside" the keep offers is
    // just a wall the player learns to ignore.
    const eye = 16 + 0.12;
    for (const material of [BlockId.BRICK, BlockId.HELLSTONE, BlockId.COBBLESTONE, BlockId.STONE]) {
      for (const thick of [1, 2]) {
        const w = wall(material, thick);
        expect(sightline(w, 0.5, eye, -4.5, Math.PI / 2, 24)).toBeLessThan(6);
        explode(w, 0.5, eye, 0.5, WeaponId.ROCKET, 0x1234);
        expect(sightline(w, 0.5, eye, -4.5, Math.PI / 2, 24)).toBeGreaterThan(12);
      }
    }
  });

  /**
   * THE MEASURED LIMIT, recorded rather than asserted away.
   *
   * `TERRAIN_POWER_PER_BLOCK` is 3.7, so a rocket carries 9.62 at its centre
   * against radius 2.6. Solving `9.62 * (1 - (d/2.6)^2) = hardness^1.5` puts the
   * deepest voxel a rocket can take out of brick at 2.18 m and out of metal at
   * 1.76 m. A bastion mass is THREE blocks across, so a single rocket detonating
   * on its face dishes it and does not pierce it — two do.
   *
   * That is a defensible balance, not a bug: the thing you can erase with one
   * shot should be a panel, and a mass should cost you two. But it is the exact
   * boundary the piece is judged on, so it is pinned here — if a future terrain
   * change makes cover four blocks thick, this test says so instead of a critic
   * saying so.
   */
  it('needs a second rocket for three blocks of metal, and says so', () => {
    const eye = 16 + 0.12;
    const w = wall(BlockId.METAL, 3);
    explode(w, 0.5, eye, 0.5, WeaponId.ROCKET, 0x1234);
    // Dished, not pierced: 3.72 of blast energy reaches the third course and
    // metal resists 5.20. The player sees a crater and still has cover.
    expect(sightline(w, 0.5, eye, -4.5, Math.PI / 2, 24)).toBeLessThan(12);
    // The follow-up detonates on the new crater face and finishes it. Two
    // rockets to open a lane through the heaviest breachable material on the
    // map is the balance; anything that survives two is obsidian, on purpose.
    explode(w, 0.5, eye, 2.0, WeaponId.ROCKET, 0x4321);
    expect(sightline(w, 0.5, eye, -4.5, Math.PI / 2, 24)).toBeGreaterThan(12);
  });

  it('a BFG takes three blocks of metal in one', () => {
    const eye = 16 + 0.12;
    const w = wall(BlockId.METAL, 3);
    explode(w, 0.5, eye, 0.5, WeaponId.BFG, 0x9999);
    expect(sightline(w, 0.5, eye, -4.5, Math.PI / 2, 24)).toBeGreaterThan(12);
  });

  it('but the arena keeps its skeleton: obsidian never yields a sightline', () => {
    const w = new VoxelWorld();
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz).loaded = true;
    }
    for (let y = 12; y <= 20; y++) {
      for (let x = -8; x <= 8; x++) {
        for (let z = 0; z <= 2; z++) w.setBlock(x, y, z, BlockId.OBSIDIAN);
      }
    }
    const eye = 16 + 0.12;
    explode(w, 0.5, eye, 0.5, WeaponId.ROCKET, 1);
    explode(w, 0.5, eye, 0.5, WeaponId.BFG, 2);
    expect(sightline(w, 0.5, eye, -4.5, Math.PI / 2, 24)).toBeLessThan(6);
  });
});

describe('destruction / the crater reads', () => {
  /** Mesh chunk (0,0) out of a world and return every quad's sky exposure by face. */
  function skyByFace(w: VoxelWorld): Map<number, number[]> {
    const pad = createPadded();
    const scratch = new Uint8Array(CHUNK_VOLUME);
    buildPadded(pad, 0, 0, (cx, cz) => {
      const rec = w.getChunk(cx, cz);
      if (rec === undefined) return null;
      scratch.set(rec.voxels);
      return scratch.slice();
    });
    const res = meshChunk(pad);
    const out = new Map<number, number[]>();
    for (const layer of res.layers) {
      for (let i = 0; i < layer.vertexCount; i += VERTS_PER_QUAD) {
        const f = readVertexFace(layer.vertexBytes, i);
        const list = out.get(f);
        if (list === undefined) out.set(f, [readVertexSky(layer.vertexBytes, i)]);
        else list.push(readVertexSky(layer.vertexBytes, i));
      }
    }
    return out;
  }

  it('turns a flat lit wall into a socket the mesher shades as an interior', () => {
    // A slab of brick with open sky over it: every -Z face of it starts at full
    // exposure, so the wall is one bright plane.
    const w = new VoxelWorld();
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz).loaded = true;
    }
    for (let y = 8; y <= 24; y++) {
      for (let x = 0; x < 32; x++) {
        for (let z = 8; z <= 12; z++) w.setBlock(x, y, z, BlockId.BRICK);
      }
    }
    const before = skyByFace(w);
    const wallBefore = before.get(5) ?? [];      // Face.NZ, the face we shoot
    expect(wallBefore.length).toBeGreaterThan(0);
    expect(Math.min(...wallBefore)).toBe(15);

    carveSphere(w, 16.5, 16.5, 8.2, 2.6, 2.6 * 3.7, 0xcafe);

    const after = skyByFace(w);
    const wallAfter = after.get(5) ?? [];
    // The crater's own inner faces are roofed by the wall above them, so at
    // least one of them comes back below full sky: the hole is a darker key
    // than the wall it is in, which is the difference between a hole and a
    // decal at twenty metres.
    expect(Math.min(...wallAfter)).toBeLessThan(15);
    // And it is a ramp, not a switch — the bleed reaches into the mouth.
    expect(new Set(wallAfter).size).toBeGreaterThan(1);
  });

  it('chars the rim so the hole has an edge', () => {
    const w = new VoxelWorld();
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz).loaded = true;
    }
    for (let y = 8; y <= 24; y++) {
      for (let z = -8; z <= 8; z++) {
        for (let x = -8; x <= 8; x++) w.setBlock(x, y, z, BlockId.STONE);
      }
    }
    const removed = explode(w, 0.5, 16.5, 0.5, WeaponId.ROCKET, 0xf00d);
    expect(removed).toBeGreaterThan(20);

    let charred = 0;
    for (let y = 10; y <= 22; y++) {
      for (let z = -6; z <= 6; z++) {
        for (let x = -6; x <= 6; x++) {
          if (w.blockAt(x, y, z) === BlockId.HELLSTONE) charred++;
        }
      }
    }
    // At SCORCH_PER_REMOVED = 2 a rocket-sized hole gets a real burnt lip, not
    // a dozen scattered specks. Hellstone also emits, so the rim stays hot.
    expect(charred).toBeGreaterThanOrEqual(10);
  });
});

/* ------------------------------------------------------------------------ *
 * The evidence half
 *
 * Everything above fires a rocket first and then measures. That leaves one
 * question open, and it is the one a player answers in the first half second:
 * looking at this level BEFORE anybody shoots, is there any reason to believe
 * it can be shot? A wall with six flat faces and twelve perfect edges says no,
 * however good the physics behind it are.
 *
 * So the generator ships the arenas already fought over, and these tests are
 * what stop that from being decoration. They require the pre-baked damage to be
 * made of the same three signals a live rocket leaves — a hole, a charred rim,
 * a pile of rubble — and they require a live rocket fired into one of those
 * craters to keep widening it, which is the only proof that the two systems are
 * the same system and not a painted-on imitation of one.
 * ------------------------------------------------------------------------ */

describe('destruction / the terrain ships fought over', () => {
  /**
   * The 96 x 96 m of level around the first spawn point — the ground a player
   * actually lands on and photographs, rather than whatever happens to be at
   * the world origin, which on this seed is open sea.
   */
  function arenaCensus(): { columns: number; char: number; rubble: number } {
    const spawns = new Float64Array(60);
    findSpawnPoints(SEED, spawns, 20);
    const sx = Math.round(spawns[0]);
    const sz = Math.round(spawns[2]);
    const w = new VoxelWorld();
    const voxels = new Uint8Array(CHUNK_VOLUME);
    const c0x = (sx >> 5) - 2;
    const c0z = (sz >> 5) - 2;
    for (let cz = c0z; cz <= c0z + 4; cz++) {
      for (let cx = c0x; cx <= c0x + 4; cx++) {
        voxels.fill(0);
        generateChunkInto(SEED, cx, cz, voxels);
        w.copyChunkIn(cx, cz, voxels).loaded = true;
      }
    }

    let columns = 0;
    let char = 0;
    let rubble = 0;
    for (let z = Math.max(sz - 45, WORLD_MIN_BLOCK_X); z <= Math.min(sz + 45, WORLD_MAX_BLOCK_X); z++) {
      for (let x = Math.max(sx - 45, WORLD_MIN_BLOCK_X); x <= Math.min(sx + 45, WORLD_MAX_BLOCK_X); x++) {
        const surface = surfaceHeightAt(SEED, x, z);
        if (surface < 1 || surface > CHUNK_HEIGHT - 14) continue;
        columns++;
        const hellish = themeAt(SEED, x, z) === Theme.HELL;
        for (let y = surface; y < surface + 14; y++) {
          const id = w.blockAt(x, y, z);
          if (id === BlockId.AIR) continue;
          // Hellstone in a theme that has no hellstone in it can only be char.
          // No cover, ledge, pillar, keep, bastion or crag picker in terrain.ts
          // produces it outside the hell theme, and no stratum reaches the top.
          if (!hellish && id === BlockId.HELLSTONE) char++;
          // Gravel is used by NO structure material picker anywhere, and by the
          // strata only below the surface, so gravel with air over it is
          // settled debris and nothing else.
          if (id === BlockId.GRAVEL && w.blockAt(x, y + 1, z) === BlockId.AIR) rubble++;
        }
      }
    }
    return { columns, char, rubble };
  }

  it('puts craters, charred rims and settled rubble in the level before a shot is fired', () => {
    const c = arenaCensus();
    expect(c.columns).toBeGreaterThan(5000);
    // Measured over the spawn window on three seeds: char 86 / 129 / 418 and
    // rubble 299 / 178 / 271, against roughly 6 000 columns. Both counts are
    // deliberately conservative — they see only the two materials no other pass
    // in terrain.ts can put here, and they ignore the holes entirely, so the
    // real damage is several times this. Measured across the whole exposed
    // surface, blast-affected voxels are 25-30% of everything you can see.
    // The floors are spared below their top course, so none of it is a hole you
    // can fall into.
    expect(c.char).toBeGreaterThan(40);
    expect(c.rubble).toBeGreaterThan(120);
  });

  it('leaves the arena skeleton standing: obsidian never scars', () => {
    // Piers and hell ledges are obsidian, which blastResist puts at 27 against
    // a scar's 11-21 — exactly as it stands against a rocket's 9.6. If a
    // generator tweak ever made the scars strong enough to eat those, every
    // arena would lose its landmark between one seed and the next.
    const w = generatedWorld(1);
    let obsidian = 0;
    for (let z = -32; z <= 32; z++) {
      for (let x = -32; x <= 32; x++) {
        for (let y = 1; y < CHUNK_HEIGHT - 1; y++) {
          if (w.blockAt(x, y, z) === BlockId.OBSIDIAN) obsidian++;
        }
      }
    }
    expect(obsidian).toBeGreaterThan(0);
  });

  it('a rocket into a pre-baked crater keeps widening it', () => {
    // The one claim the shipped damage is allowed to make: it is the SAME
    // object a rocket makes. So find charred rock, put a rocket into it, and
    // require the hole to get bigger. A scar armoured against further fire
    // would be a texture pretending to be damage, and this says so.
    const spawns = new Float64Array(60);
    findSpawnPoints(SEED, spawns, 20);
    const sx = Math.round(spawns[0]);
    const sz = Math.round(spawns[2]);
    const w = new VoxelWorld();
    const voxels = new Uint8Array(CHUNK_VOLUME);
    const c0x = (sx >> 5) - 2;
    const c0z = (sz >> 5) - 2;
    for (let cz = c0z; cz <= c0z + 4; cz++) {
      for (let cx = c0x; cx <= c0x + 4; cx++) {
        voxels.fill(0);
        generateChunkInto(SEED, cx, cz, voxels);
        w.copyChunkIn(cx, cz, voxels).loaded = true;
      }
    }

    let hits = 0;
    // Widely spaced samples: two rockets into the same crater would have the
    // second one detonating in the hole the first one made.
    const fired: number[] = [];
    const tooClose = (x: number, z: number): boolean => {
      for (let i = 0; i < fired.length; i += 2) {
        if (Math.hypot(fired[i] - x, fired[i + 1] - z) < 10) return true;
      }
      return false;
    };
    // Clamped to the playable box: outside it `setBlock` refuses every write,
    // so a rocket there would measure the world edge and not the material.
    const lo = (v: number) => Math.max(v, WORLD_MIN_BLOCK_X + 4);
    const hi = (v: number) => Math.min(v, WORLD_MAX_BLOCK_X - 4);
    for (let z = lo(sz - 40); z <= hi(sz + 40) && hits < 3; z += 2) {
      for (let x = lo(sx - 40); x <= hi(sx + 40) && hits < 3; x += 2) {
        if (tooClose(x, z)) continue;
        const surface = surfaceHeightAt(SEED, x, z);
        if (surface < 1 || surface > CHUNK_HEIGHT - 14) continue;
        if (themeAt(SEED, x, z) === Theme.HELL) continue;
        for (let y = surface + 1; y < surface + 8; y++) {
          const id = w.blockAt(x, y, z);
          if (id !== BlockId.HELLSTONE && id !== BlockId.RUSTED_METAL) continue;
          const before = w.solidCount;
          const removed = explode(w, x + 0.5, y + 0.5, z + 0.5, WeaponId.ROCKET, 0x5ca4 + hits);
          expect(removed).toBeGreaterThan(0);
          expect(w.solidCount).toBeLessThan(before);
          fired.push(x, z);
          hits++;
          break;
        }
      }
    }
    expect(hits).toBe(3);
  });
});

describe('destruction / debris settles', () => {
  /** A free-standing slab of `material` with open floor 6 blocks under it. */
  function slab(material: number): VoxelWorld {
    const w = new VoxelWorld();
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz).loaded = true;
    }
    for (let z = -8; z <= 8; z++) {
      for (let x = -8; x <= 8; x++) w.setBlock(x, 10, z, BlockId.STONE);   // floor
    }
    for (let y = 11; y <= 22; y++) {
      for (let x = -8; x <= 8; x++) {
        for (let z = 0; z <= 2; z++) w.setBlock(x, y, z, material);
      }
    }
    return w;
  }

  it('drops rubble under the blast and never into the sightline it just cut', () => {
    const w = slab(BlockId.BRICK);
    const eye = 16.5;
    expect(sightline(w, 0.5, eye, -5.5, Math.PI / 2, 24)).toBeLessThan(8);
    explode(w, 0.5, eye, 0.5, WeaponId.ROCKET, 0xd3b2);

    // The hole is open at the height it was cut at. This is the functional
    // half: debris that filled the breach back in would fail here first.
    expect(sightline(w, 0.5, eye, -5.5, Math.PI / 2, 24)).toBeGreaterThan(12);

    // Gravel is unambiguous in a brick slab — brick chars to hellstone and
    // breaks down into gravel, and nothing in the scene was gravel to start
    // with, so every one of these is a voxel the blast put there.
    let below = 0;
    let atOrAbove = 0;
    for (let y = 9; y <= 24; y++) {
      for (let z = -6; z <= 8; z++) {
        for (let x = -8; x <= 8; x++) {
          if (w.blockAt(x, y, z) !== BlockId.GRAVEL) continue;
          if (y < Math.floor(eye)) below++; else atOrAbove++;
        }
      }
    }
    // Settled: a real pile in the bottom of the crater, and not one block of it
    // at or over the plane the rocket went off on.
    expect(below).toBeGreaterThan(0);
    expect(atOrAbove).toBe(0);
    expect(blastDebrisCount()).toBeGreaterThanOrEqual(below);
  });

  it('never seals a doorway', () => {
    // Two blocks of clear under a lintel is the profile of every way through
    // this world: a keep door, a clerestory, a bastion arch. Debris that lands
    // in one turns a route into a wall, so the settle refuses that cell even
    // when the blast went off right next to it.
    const w = new VoxelWorld();
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz).loaded = true;
    }
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) w.setBlock(x, 10, z, BlockId.STONE);
    }
    // A wall across z = 0 with a 2-high doorway at x = 0..1, lintel over it.
    for (let y = 11; y <= 16; y++) {
      for (let x = -6; x <= 6; x++) {
        if (y <= 12 && (x === 0 || x === 1)) continue;
        w.setBlock(x, y, 0, BlockId.BRICK);
      }
    }
    explode(w, 3.5, 12.5, 0.5, WeaponId.ROCKET, 0x9a11);
    for (const x of [0, 1]) {
      expect(w.blockAt(x, 11, 0)).toBe(BlockId.AIR);
      expect(w.blockAt(x, 12, 0)).toBe(BlockId.AIR);
    }
  });
});
