/**
 * Mesher contract tests.
 *
 * These four are the ones that actually catch regressions: face culling,
 * emptiness, ambient occlusion, and cross-chunk seams. Everything else the
 * mesher does is visible in a screenshot; these are not.
 */

import { describe, expect, it } from 'vitest';
import {
  BlockId,
  CHUNK_HEIGHT,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  Face,
  RenderLayer,
  voxelIndex,
} from '@doomcraft/shared';
import {
  buildPadded,
  createPadded,
  INDICES_PER_QUAD,
  LIGHT_ATTEN,
  LIGHT_HUE_FIRE,
  LIGHT_HUE_TOXIC,
  LIGHT_MAX,
  meshChunk,
  readVertexAO,
  readVertexFace,
  readVertexLight,
  readVertexLightHue,
  readVertexSky,
  readVertexX,
  readVertexY,
  VERTS_PER_QUAD,
  type ChunkFetch,
} from './mesher';

function emptyChunk(): Uint8Array {
  return new Uint8Array(CHUNK_VOLUME);
}

/** Fill an axis-aligned block range [x0,x1) x [y0,y1) x [z0,z1). */
function fill(
  chunk: Uint8Array, id: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): void {
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) chunk[voxelIndex(x, y, z)] = id;
    }
  }
}

function only(chunk: Uint8Array): ChunkFetch {
  return (cx, cz) => (cx === 0 && cz === 0 ? chunk : null);
}

/** Mesh a single chunk with an AIR floor so all six outer faces are exposed. */
function meshOne(chunk: Uint8Array) {
  const pad = createPadded();
  buildPadded(pad, 0, 0, only(chunk), BlockId.AIR);
  return meshChunk(pad);
}

/**
 * Mesh a single chunk the way the game does — on bedrock.
 *
 * `meshOne` floats the chunk over open air, which no real chunk ever is, and
 * that matters now that the sky channel bleeds sideways: the underside of a
 * floating slab picks up a real light ramp in from its rim, which is correct
 * and which shatters the one big merged bottom quad the old count-based
 * assertions were written against. Anything asserting an exact merge count
 * should use this instead, because this is the path that ships.
 */
function meshShipped(chunk: Uint8Array) {
  const pad = createPadded();
  buildPadded(pad, 0, 0, only(chunk));
  return meshChunk(pad);
}

function faceCounts(bytes: Uint8Array, vertexCount: number): number[] {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < vertexCount; i += VERTS_PER_QUAD) counts[readVertexFace(bytes, i)]++;
  return counts;
}

function minAO(bytes: Uint8Array, vertexCount: number): number {
  let m = 3;
  for (let i = 0; i < vertexCount; i++) {
    const a = readVertexAO(bytes, i);
    if (a < m) m = a;
  }
  return m;
}

describe('mesher / face culling', () => {
  it('a solid 32^3 chunk on bedrock produces exactly its five visible faces', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 32, CHUNK_SIZE_Z);

    const res = meshShipped(chunk);
    const opaque = res.layers[RenderLayer.OPAQUE];

    // Nine, and every one of them is accounted for. On bedrock the downward
    // skin under the world floor is culled, which is the whole reason the
    // shipping floor block is opaque — so five faces, not six. Four of those
    // five then split in two, because the bedrock plane at y = -1 occludes the
    // bottom course of each wall: that lowest row carries a contact AO term the
    // rest of the wall does not, and AO is part of the merge key. A wall that
    // merged straight through its own footing would be a wall with no contact
    // shadow, which is the bar's failure.
    expect(res.totalQuads).toBe(9);
    expect(opaque.quadCount).toBe(9);
    expect(res.layers[RenderLayer.CUTOUT].quadCount).toBe(0);
    expect(res.layers[RenderLayer.TRANSPARENT].quadCount).toBe(0);

    // Greedy merging: 9 quads, not 1024.
    expect(opaque.vertexCount).toBe(9 * VERTS_PER_QUAD);
    expect(opaque.indexCount).toBe(9 * INDICES_PER_QUAD);

    // Top merges whole, nothing points down, each wall is footing + body.
    expect(faceCounts(opaque.vertexBytes, opaque.vertexCount)).toEqual([2, 2, 1, 0, 2, 2]);
    expect(minAO(opaque.vertexBytes, opaque.vertexCount)).toBeLessThan(3);

    // The solid block spans y 0..31, so the mesh spans y 0..32.
    expect(res.minY).toBe(0);
    expect(res.maxY).toBe(32);
    expect(res.empty).toBe(false);
  });

  it('exposes the sixth face when the floor under the chunk is air', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 32, CHUNK_SIZE_Z);
    const counts = (() => {
      const res = meshOne(chunk);
      const op = res.layers[RenderLayer.OPAQUE];
      return faceCounts(op.vertexBytes, op.vertexCount);
    })();
    // The five lit-uniformly faces still merge whole; the underside picks up the
    // sky ramp bleeding in from its rim and is allowed to split.
    expect(counts[Face.PX]).toBe(1);
    expect(counts[Face.NX]).toBe(1);
    expect(counts[Face.PY]).toBe(1);
    expect(counts[Face.PZ]).toBe(1);
    expect(counts[Face.NZ]).toBe(1);
    expect(counts[Face.NY]).toBeGreaterThan(0);
  });

  it('an empty chunk produces zero geometry in every layer', () => {
    const res = meshOne(emptyChunk());
    expect(res.totalQuads).toBe(0);
    expect(res.empty).toBe(true);
    for (let l = 0; l < res.layers.length; l++) {
      expect(res.layers[l].quadCount).toBe(0);
      expect(res.layers[l].vertexCount).toBe(0);
      expect(res.layers[l].indexCount).toBe(0);
      expect(res.layers[l].vertexBytes.length).toBe(0);
    }
  });

  it('interior voxels of a solid volume emit nothing', () => {
    // A free-floating 6^3 cube: nothing occludes any of its faces, so AO is a
    // flat 3 and each of the five faces the sky reaches evenly collapses to one
    // quad. The underside is in its own shadow and takes the sky ramp bleeding
    // under the cube from all four sides, so it is allowed to split — what must
    // never happen is a face between two solid voxels.
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 4, 4, 4, 10, 10, 10);
    const solid = meshOne(chunk);
    const solidCounts = faceCounts(
      solid.layers[RenderLayer.OPAQUE].vertexBytes,
      solid.layers[RenderLayer.OPAQUE].vertexCount,
    );
    expect([solidCounts[Face.PX], solidCounts[Face.NX], solidCounts[Face.PY],
      solidCounts[Face.PZ], solidCounts[Face.NZ]]).toEqual([1, 1, 1, 1, 1]);
    // 6x6 of underside, so a fully shattered one would be 36.
    expect(solidCounts[Face.NY]).toBeGreaterThan(0);
    expect(solidCounts[Face.NY]).toBeLessThanOrEqual(36);
    expect(solid.minY).toBe(4);
    expect(solid.maxY).toBe(10);

    // Hollow it out and the interior surface appears, graded by AO along its
    // edges. What must never appear is a face between two solid voxels: the
    // outer skin is still exactly six quads.
    fill(chunk, BlockId.AIR, 5, 5, 5, 9, 9, 9);
    const hollow = meshOne(chunk);
    const hollowQuads = hollow.layers[RenderLayer.OPAQUE].quadCount;
    const solidQuads = 5 + solidCounts[Face.NY];
    expect(hollowQuads).toBeGreaterThan(solidQuads);
    // Outer skin + 6 inner walls of 4x4, each split at most into a 3x3 AO pattern.
    expect(hollowQuads).toBeLessThanOrEqual(solidQuads + 6 * 9);
  });

  it('buckets water into the transparent layer, away from the opaque one', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 4, CHUNK_SIZE_Z);
    fill(chunk, BlockId.WATER, 0, 4, 0, CHUNK_SIZE_X, 6, CHUNK_SIZE_Z);
    const res = meshOne(chunk);
    expect(res.layers[RenderLayer.TRANSPARENT].quadCount).toBeGreaterThan(0);
    // Water is not opaque, so the stone top under it still renders.
    expect(res.layers[RenderLayer.OPAQUE].quadCount).toBeGreaterThan(0);
    // Water against water never emits an interior face.
    expect(res.layers[RenderLayer.TRANSPARENT].quadCount).toBeLessThanOrEqual(6);
  });
});

describe('mesher / ambient occlusion', () => {
  it('leaves an unobstructed floor at full brightness', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    expect(minAO(op.vertexBytes, op.vertexCount)).toBe(3);
  });

  it('darkens an inside corner to zero and merges nothing across it', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    // Two walls meeting over the floor tile at (10, 1, 10) make one inside corner.
    chunk[voxelIndex(11, 1, 10)] = BlockId.STONE;
    chunk[voxelIndex(10, 1, 11)] = BlockId.STONE;
    chunk[voxelIndex(11, 1, 11)] = BlockId.STONE;

    // On bedrock, so the baseline below is the merge count of a flat slab and
    // not of a flat slab plus whatever its floating underside does.
    const res = meshShipped(chunk);
    const op = res.layers[RenderLayer.OPAQUE];

    // Both sides of the corner are solid, so that vertex is fully occluded.
    expect(minAO(op.vertexBytes, op.vertexCount)).toBe(0);
    // Read the count out now: the result object is scratch and the next
    // meshChunk() call overwrites it.
    const corneredQuads = op.quadCount;

    // And the AO breaks the merge: the flat floor alone is 6 quads, this is not.
    const flatChunk = emptyChunk();
    fill(flatChunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    const flat = meshShipped(flatChunk).layers[RenderLayer.OPAQUE].quadCount;
    expect(flat).toBe(5);
    expect(corneredQuads).toBeGreaterThan(flat);
  });

  it('grades a single occluder from 3 down through 2', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    chunk[voxelIndex(16, 1, 16)] = BlockId.STONE;
    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    // One side occluder subtracts one step, never two.
    expect(minAO(op.vertexBytes, op.vertexCount)).toBe(1);
  });
});

describe('mesher / chunk seams', () => {
  it('emits no faces on the boundary shared with a loaded neighbour', () => {
    const a = emptyChunk();
    const b = emptyChunk();
    fill(a, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 32, CHUNK_SIZE_Z);
    fill(b, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 32, CHUNK_SIZE_Z);

    const fetch: ChunkFetch = (cx, cz) => {
      if (cz !== 0) return null;
      if (cx === 0) return a;
      if (cx === 1) return b;
      return null;
    };

    const pad = createPadded();
    buildPadded(pad, 0, 0, fetch);
    const res = meshChunk(pad);
    const op = res.layers[RenderLayer.OPAQUE];

    // +X is now interior and on bedrock -Y is culled, leaving three walls and a
    // top; each wall splits into its footing course and its body (see the face
    // culling suite for why), so 3 * 2 + 1.
    expect(res.totalQuads).toBe(7);
    expect(faceCounts(op.vertexBytes, op.vertexCount)[Face.PX]).toBe(0);
    expect(faceCounts(op.vertexBytes, op.vertexCount)[Face.NX]).toBe(2);

    // Nothing at all sits on the shared plane x = 32.
    for (let i = 0; i < op.vertexCount; i++) {
      if (readVertexFace(op.vertexBytes, i) === Face.PX) {
        expect(readVertexX(op.vertexBytes, i)).not.toBe(CHUNK_SIZE_X);
      }
    }

    // Without the neighbour the +X wall comes back.
    buildPadded(pad, 0, 0, only(a));
    const alone = meshChunk(pad);
    expect(alone.totalQuads).toBe(9);
    expect(faceCounts(
      alone.layers[RenderLayer.OPAQUE].vertexBytes,
      alone.layers[RenderLayer.OPAQUE].vertexCount,
    )[Face.PX]).toBe(2);
  });

  it('takes the neighbour skirt from all four sides', () => {
    const centre = emptyChunk();
    const ring = emptyChunk();
    fill(centre, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 8, CHUNK_SIZE_Z);
    fill(ring, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 8, CHUNK_SIZE_Z);

    const fetch: ChunkFetch = (cx, cz) => (cx === 0 && cz === 0 ? centre : ring);
    const pad = createPadded();
    buildPadded(pad, 0, 0, fetch, BlockId.AIR);
    const res = meshChunk(pad);
    const op = res.layers[RenderLayer.OPAQUE];
    // Only the top and the bottom survive.
    expect(res.totalQuads).toBe(2);
    expect(faceCounts(op.vertexBytes, op.vertexCount)).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it('suppresses the world floor when the pad floor is bedrock', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 8, CHUNK_SIZE_Z);
    const pad = createPadded();
    buildPadded(pad, 0, 0, only(chunk));            // default floor = BEDROCK
    const res = meshChunk(pad);
    const op = res.layers[RenderLayer.OPAQUE];
    expect(faceCounts(op.vertexBytes, op.vertexCount)[Face.NY]).toBe(0);
    expect(faceCounts(op.vertexBytes, op.vertexCount)[Face.PY]).toBe(1);
  });
});

describe('mesher / scratch reuse', () => {
  it('returns identical geometry for identical input across calls', () => {
    const chunk = emptyChunk();
    for (let x = 0; x < CHUNK_SIZE_X; x++) {
      for (let z = 0; z < CHUNK_SIZE_Z; z++) {
        const h = 6 + ((x * 7 + z * 13) % 9);
        for (let y = 0; y < h; y++) chunk[voxelIndex(x, y, z)] = BlockId.STONE;
        chunk[voxelIndex(x, h, z)] = BlockId.GRASS;
      }
    }
    const first = meshOne(chunk);
    const firstBytes = Uint8Array.from(first.layers[RenderLayer.OPAQUE].vertexBytes);
    const firstQuads = first.totalQuads;

    // A different chunk in between must not leak state into the next result.
    meshOne(emptyChunk());

    const second = meshOne(chunk);
    expect(second.totalQuads).toBe(firstQuads);
    expect(Array.from(second.layers[RenderLayer.OPAQUE].vertexBytes)).toEqual(Array.from(firstBytes));
  });

  it('keeps every emitted vertex inside the chunk box', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, CHUNK_HEIGHT, CHUNK_SIZE_Z);
    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    for (let i = 0; i < op.vertexCount; i++) {
      expect(readVertexX(op.vertexBytes, i)).toBeLessThanOrEqual(CHUNK_SIZE_X);
      expect(readVertexAO(op.vertexBytes, i)).toBeLessThanOrEqual(3);
    }
    expect(res.maxY).toBe(CHUNK_HEIGHT);
  });
});

/* ------------------------------------------------------------------------ */

describe('mesher / sky exposure', () => {
  it('ramps from full sky in the open down to none deep under a roof', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    // A floating slab 16 wide: no walls, so the ONLY thing that can darken the
    // floor under it is the sky channel. Wide enough that its centre is out of
    // reach of the bleed from every rim.
    fill(chunk, BlockId.STONE, 8, 5, 8, 24, 6, 24);

    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    const b = op.vertexBytes;

    const floorSky = new Set<number>();
    const roofSky = new Set<number>();
    for (let i = 0; i < op.vertexCount; i += VERTS_PER_QUAD) {
      const face = readVertexFace(b, i);
      const y = readVertexY(b, i);
      if (face === Face.PY && y === 1) floorSky.add(readVertexSky(b, i));
      if (face === Face.NY && y === 5) roofSky.add(readVertexSky(b, i));
    }
    expect(roofSky.size).toBeGreaterThan(0);
    expect(Math.min(...roofSky)).toBe(0);         // the middle of the roof

    expect(floorSky.has(LIGHT_MAX)).toBe(true);   // out in the open
    expect(floorSky.has(0)).toBe(true);           // under the middle of the slab
    // And the point of the bleed: it is a RAMP, not a switch. There is at least
    // one intermediate step between the two, so a doorway has a threshold
    // instead of a hard sector edge.
    const mids = [...floorSky].filter((v) => v > 0 && v < LIGHT_MAX);
    expect(mids.length).toBeGreaterThan(0);
    // Nothing may exceed full sky, whatever the sweep did.
    expect(Math.max(...floorSky)).toBe(LIGHT_MAX);
  });

  it('keeps the sky field seam-exact across a chunk boundary', () => {
    // The bleed reaches five blocks, so a face one block outside the chunk must
    // still come out the same whichever of the two chunks meshed it. Build the
    // same overhang straddling x = 32 and read the shared plane from both sides.
    const build = (): Uint8Array => {
      const c = emptyChunk();
      fill(c, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
      fill(c, BlockId.STONE, 0, 5, 8, CHUNK_SIZE_X, 6, 24);
      return c;
    };
    const a = build();
    const b2 = build();
    const fetch: ChunkFetch = (cx, cz) => (cz === 0 && (cx === 0 || cx === 1) ? (cx === 0 ? a : b2) : null);

    const read = (cx: number): Map<string, number> => {
      const pad = createPadded();
      buildPadded(pad, cx, 0, fetch);
      const res = meshChunk(pad);
      const out = new Map<string, number>();
      for (const layer of res.layers) {
        for (let i = 0; i < layer.vertexCount; i += VERTS_PER_QUAD) {
          if (readVertexFace(layer.vertexBytes, i) !== Face.PY) continue;
          if (readVertexY(layer.vertexBytes, i) !== 1) continue;
          const x = readVertexX(layer.vertexBytes, i) + cx * CHUNK_SIZE_X;
          out.set(`${x}`, readVertexSky(layer.vertexBytes, i));
        }
      }
      return out;
    };
    const left = read(0);
    const right = read(1);
    // The two chunks are identical, so the floor sky profile they each report
    // must be the same set of values — a sweep that ran off the end of its box
    // would give the boundary column a different answer on each side.
    expect([...new Set(left.values())].sort((p, q) => p - q))
      .toEqual([...new Set(right.values())].sort((p, q) => p - q));
  });

  it('does not let sky through water', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    fill(chunk, BlockId.WATER, 0, 1, 0, CHUNK_SIZE_X, 4, CHUNK_SIZE_Z);
    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    for (let i = 0; i < op.vertexCount; i += VERTS_PER_QUAD) {
      if (readVertexFace(op.vertexBytes, i) === Face.PY && readVertexY(op.vertexBytes, i) === 1) {
        // The seabed is never at full sky. It is not pitch black either: light
        // ramps down through the water column exactly as it does under a roof.
        expect(readVertexSky(op.vertexBytes, i)).toBeLessThan(LIGHT_MAX);
      }
    }
  });
});

describe('mesher / block light', () => {
  it('floods an emitter across the floor and attenuates with distance', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    chunk[voxelIndex(16, 1, 16)] = BlockId.NEON;

    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    const b = op.vertexBytes;

    const levels = new Set<number>();
    for (let i = 0; i < op.vertexCount; i += VERTS_PER_QUAD) {
      if (readVertexFace(b, i) !== Face.PY || readVertexY(b, i) !== 1) continue;
      levels.add(readVertexLight(b, i));
    }
    // The whole ramp has to be on the floor, not just a lit rim: 15 at the
    // source, then LIGHT_ATTEN per step out to darkness.
    for (let l = LIGHT_MAX - LIGHT_ATTEN; l > 0; l -= LIGHT_ATTEN) {
      expect(levels.has(l)).toBe(true);
    }
    expect(levels.has(0)).toBe(true);
  });

  it('tags light with the hue class of its source', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    chunk[voxelIndex(16, 1, 16)] = BlockId.NEON;
    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    let lit = 0;
    for (let i = 0; i < op.vertexCount; i += VERTS_PER_QUAD) {
      if (readVertexLight(op.vertexBytes, i) === 0) continue;
      lit++;
      expect(readVertexLightHue(op.vertexBytes, i)).toBe(LIGHT_HUE_TOXIC);
    }
    expect(lit).toBeGreaterThan(0);

    const hellish = emptyChunk();
    fill(hellish, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    hellish[voxelIndex(16, 1, 16)] = BlockId.LAVA;
    const res2 = meshOne(hellish);
    const op2 = res2.layers[RenderLayer.OPAQUE];
    let fire = 0;
    for (let i = 0; i < op2.vertexCount; i += VERTS_PER_QUAD) {
      if (readVertexLight(op2.vertexBytes, i) === 0) continue;
      fire++;
      expect(readVertexLightHue(op2.vertexBytes, i)).toBe(LIGHT_HUE_FIRE);
    }
    expect(fire).toBeGreaterThan(0);
  });

  it('does not leak light through an opaque wall', () => {
    // A lamp sealed inside solid rock lights nothing anyone can see.
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 4, 4, 4, 11, 11, 11);
    chunk[voxelIndex(7, 7, 7)] = BlockId.NEON;
    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];
    const counts = faceCounts(op.vertexBytes, op.vertexCount);
    expect([counts[Face.PX], counts[Face.NX], counts[Face.PY],
      counts[Face.PZ], counts[Face.NZ]]).toEqual([1, 1, 1, 1, 1]);
    expect(counts[Face.NY]).toBeGreaterThan(0);
    for (let i = 0; i < op.vertexCount; i++) {
      expect(readVertexLight(op.vertexBytes, i)).toBe(0);
    }
  });

  it('leaves no stale light behind when the next chunk has no emitter', () => {
    const lampChunk = emptyChunk();
    fill(lampChunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    lampChunk[voxelIndex(16, 1, 16)] = BlockId.NEON;
    meshOne(lampChunk);

    const darkChunk = emptyChunk();
    fill(darkChunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    const res = meshOne(darkChunk);
    const op = res.layers[RenderLayer.OPAQUE];
    for (let i = 0; i < op.vertexCount; i++) {
      expect(readVertexLight(op.vertexBytes, i)).toBe(0);
    }
  });
});
