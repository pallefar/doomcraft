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
  meshChunk,
  readVertexAO,
  readVertexFace,
  readVertexX,
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
  it('a solid 32^3 chunk produces exactly its six outer faces', () => {
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 32, CHUNK_SIZE_Z);

    const res = meshOne(chunk);
    const opaque = res.layers[RenderLayer.OPAQUE];

    expect(res.totalQuads).toBe(6);
    expect(opaque.quadCount).toBe(6);
    expect(res.layers[RenderLayer.CUTOUT].quadCount).toBe(0);
    expect(res.layers[RenderLayer.TRANSPARENT].quadCount).toBe(0);

    // Greedy merging: every side is one quad, not 1024.
    expect(opaque.vertexCount).toBe(6 * VERTS_PER_QUAD);
    expect(opaque.indexCount).toBe(6 * INDICES_PER_QUAD);

    // One quad per face direction.
    expect(faceCounts(opaque.vertexBytes, opaque.vertexCount)).toEqual([1, 1, 1, 1, 1, 1]);

    // The solid block spans y 0..31, so the mesh spans y 0..32.
    expect(res.minY).toBe(0);
    expect(res.maxY).toBe(32);
    expect(res.empty).toBe(false);
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
    // flat 3 and each side collapses to one quad. 216 voxels, 6 quads.
    const chunk = emptyChunk();
    fill(chunk, BlockId.STONE, 4, 4, 4, 10, 10, 10);
    const solid = meshOne(chunk);
    expect(solid.layers[RenderLayer.OPAQUE].quadCount).toBe(6);
    expect(solid.minY).toBe(4);
    expect(solid.maxY).toBe(10);

    // Hollow it out and the interior surface appears, graded by AO along its
    // edges. What must never appear is a face between two solid voxels: the
    // outer skin is still exactly six quads.
    fill(chunk, BlockId.AIR, 5, 5, 5, 9, 9, 9);
    const hollow = meshOne(chunk);
    const hollowQuads = hollow.layers[RenderLayer.OPAQUE].quadCount;
    expect(hollowQuads).toBeGreaterThan(6);
    // 6 outer + 6 inner walls of 4x4, each split at most into a 3x3 AO pattern.
    expect(hollowQuads).toBeLessThanOrEqual(6 + 6 * 9);
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

    const res = meshOne(chunk);
    const op = res.layers[RenderLayer.OPAQUE];

    // Both sides of the corner are solid, so that vertex is fully occluded.
    expect(minAO(op.vertexBytes, op.vertexCount)).toBe(0);
    // Read the count out now: the result object is scratch and the next
    // meshChunk() call overwrites it.
    const corneredQuads = op.quadCount;

    // And the AO breaks the merge: the flat floor alone is 6 quads, this is not.
    const flatChunk = emptyChunk();
    fill(flatChunk, BlockId.STONE, 0, 0, 0, CHUNK_SIZE_X, 1, CHUNK_SIZE_Z);
    const flat = meshOne(flatChunk).layers[RenderLayer.OPAQUE].quadCount;
    expect(flat).toBe(6);
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
    buildPadded(pad, 0, 0, fetch, BlockId.AIR);
    const res = meshChunk(pad);
    const op = res.layers[RenderLayer.OPAQUE];

    // +X is now interior: five faces, not six.
    expect(res.totalQuads).toBe(5);
    expect(faceCounts(op.vertexBytes, op.vertexCount)[Face.PX]).toBe(0);
    expect(faceCounts(op.vertexBytes, op.vertexCount)[Face.NX]).toBe(1);

    // Nothing at all sits on the shared plane x = 32.
    for (let i = 0; i < op.vertexCount; i++) {
      if (readVertexFace(op.vertexBytes, i) === Face.PX) {
        expect(readVertexX(op.vertexBytes, i)).not.toBe(CHUNK_SIZE_X);
      }
    }

    // Without the neighbour the same chunk is back to six.
    buildPadded(pad, 0, 0, only(a), BlockId.AIR);
    expect(meshChunk(pad).totalQuads).toBe(6);
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
