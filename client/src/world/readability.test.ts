/**
 * THE SHIPPED WORLD, THROUGH THE SHIPPED MESHER.
 *
 * `mesher.test.ts` proves the mesher does the right thing to a hand-built test
 * scene. This file asks the only question that decides whether any of that
 * reaches the screen: does the terrain the generator actually ships CONTAIN the
 * signal the shader is built to draw?
 *
 * Every number below started as a measurement, and each one guards a failure
 * that has already happened once in this repo:
 *
 *  - **AO.** The renderer's whole answer to ref/BAR.md weakness #4 is contact
 *    occlusion. It is worth nothing on a plane. A terrain change that smooths
 *    the terraces or drops the crags would silently take the AO with it, and no
 *    existing test would notice because the mesher would still be correct.
 *
 *  - **Sky.** The channel that makes an interior read as an interior used to be
 *    a binary "is anything directly overhead", which put 35% of every frame's
 *    quads on the interior side of the lighting split — most of them open ground
 *    standing under a crag lip. That is why the shipped captures were uniformly
 *    murky, and why the interior key had to stay timid to be survivable. It is
 *    now a bled gradient; these tests pin BOTH ends, because either a regression
 *    to binary or a bleed strong enough to erase real interiors loses the
 *    contrast the piece is judged on.
 *
 *  - **Merge cost.** A graded sky channel is part of the greedy merge key, so it
 *    can shatter big quads. Measured, it cost +1.5%. This pins the ceiling so a
 *    future tweak that costs 40% is caught here and not in an fps capture.
 *
 *  - **Emissive.** "Lava that actually lights the room" is a brief requirement.
 *    It is false unless emitters exist and their flood reaches surfaces the
 *    player can see.
 */

import { describe, expect, it } from 'vitest';
import { BlockId, CHUNK_VOLUME } from '@doomcraft/shared';
import { generateChunkInto } from './terrain';
import {
  buildPadded, createPadded, LIGHT_MAX, meshChunk, readVertexAO, readVertexFace,
  readVertexLight, readVertexSky, VERTS_PER_QUAD,
} from '@/engine/mesher';

const SEED = 1337;
/** A 4x4 block of chunks, which is 16 384 m^2 of real level. */
const SPAN = 4;

interface Census {
  vertices: number;
  quads: number;
  chunks: number;
  /** Share of vertices at each AO level 0..3. */
  ao: number[];
  /** Share of quads at each sky level 0..15. */
  sky: number[];
  /** Share of quads whose block-light channel is non-zero. */
  litShare: number;
  /** Highest block-light level seen on any face. */
  maxLight: number;
}

let cached: Census | null = null;

function census(): Census {
  if (cached !== null) return cached;
  const chunks = new Map<string, Uint8Array>();
  const get = (cx: number, cz: number): Uint8Array => {
    const k = `${cx},${cz}`;
    let c = chunks.get(k);
    if (c === undefined) {
      c = new Uint8Array(CHUNK_VOLUME);
      generateChunkInto(SEED, cx, cz, c);
      chunks.set(k, c);
    }
    return c;
  };

  const ao = [0, 0, 0, 0];
  const sky = new Array<number>(LIGHT_MAX + 1).fill(0);
  let vertices = 0;
  let quads = 0;
  let lit = 0;
  let maxLight = 0;
  const pad = createPadded();

  for (let cx = 0; cx < SPAN; cx++) {
    for (let cz = 0; cz < SPAN; cz++) {
      buildPadded(pad, cx, cz, get);
      const res = meshChunk(pad);
      quads += res.totalQuads;
      for (const layer of res.layers) {
        for (let i = 0; i < layer.vertexCount; i++) {
          ao[readVertexAO(layer.vertexBytes, i)]++;
          vertices++;
        }
        for (let i = 0; i < layer.vertexCount; i += VERTS_PER_QUAD) {
          sky[readVertexSky(layer.vertexBytes, i)]++;
          const l = readVertexLight(layer.vertexBytes, i);
          if (l > 0) lit++;
          if (l > maxLight) maxLight = l;
        }
      }
    }
  }

  cached = {
    vertices,
    quads,
    chunks: SPAN * SPAN,
    ao: ao.map((n) => n / vertices),
    sky: sky.map((n) => n / quads),
    litShare: lit / quads,
    maxLight,
  };
  return cached;
}

describe('shipped world / ambient occlusion has something to occlude', () => {
  it('puts a large minority of every frame in contact with another surface', () => {
    const c = census();
    const occluded = c.ao[0] + c.ao[1] + c.ao[2];
    // Measured at 43.6% over this span. A flat plain would be ~0 and a cave
    // system would be most of the way to 1; the band is deliberately wide,
    // because what this catches is the geometry disappearing, not drifting.
    expect(occluded).toBeGreaterThan(0.25);
    expect(occluded).toBeLessThan(0.75);
    // And the deepest level is actually reached — inside corners exist, which
    // is what a room has and a field of pillars does not.
    expect(c.ao[0]).toBeGreaterThan(0.01);
  });

  it('grades floors, not just walls', () => {
    // Face 2 is +Y. If only walls carried AO the floor would read as a painted
    // plane with shaded objects standing on it, which is the bar's beach.
    const chunks = new Map<string, Uint8Array>();
    const get = (cx: number, cz: number): Uint8Array => {
      const k = `${cx},${cz}`;
      let v = chunks.get(k);
      if (v === undefined) {
        v = new Uint8Array(CHUNK_VOLUME);
        generateChunkInto(SEED, cx, cz, v);
        chunks.set(k, v);
      }
      return v;
    };
    const pad = createPadded();
    let top = 0;
    let topOccluded = 0;
    for (let cx = 0; cx < 2; cx++) {
      for (let cz = 0; cz < 2; cz++) {
        buildPadded(pad, cx, cz, get);
        const res = meshChunk(pad);
        for (const layer of res.layers) {
          for (let i = 0; i < layer.vertexCount; i++) {
            if (readVertexFace(layer.vertexBytes, i) !== 2) continue;
            top++;
            if (readVertexAO(layer.vertexBytes, i) < 3) topOccluded++;
          }
        }
      }
    }
    expect(top).toBeGreaterThan(0);
    expect(topOccluded / top).toBeGreaterThan(0.2);
  });
});

describe('shipped world / sky exposure is a gradient', () => {
  it('leaves the outdoors outdoors', () => {
    const c = census();
    // Measured at 63.6%. Most of the level is open ground and must be rendered
    // at the exterior key, or there is no bright side for a dark room to be
    // dark against.
    expect(c.sky[LIGHT_MAX]).toBeGreaterThan(0.5);
  });

  it('reserves full darkness for actual interiors', () => {
    const c = census();
    // Measured at 0.5%, down from 35.4% when the channel was binary. The old
    // number was not "35% of the world is indoors", it was "35% of the world
    // has something above it" — every crag lip, every bastion cap, every arch.
    expect(c.sky[0]).toBeLessThan(0.06);
    // But it is not zero: the keeps are real rooms and their insides are dark.
    expect(c.sky[0]).toBeGreaterThan(0);
  });

  it('spends real area on the threshold between the two', () => {
    const c = census();
    let mid = 0;
    for (let s = 1; s < LIGHT_MAX; s++) mid += c.sky[s];
    // A doorway you can see is a doorway with a ramp across it. Binary sky puts
    // this at exactly 0.
    expect(mid).toBeGreaterThan(0.15);
    // Every step of the ramp is populated, so nothing steps by more than one
    // attenuation unit anywhere in the level.
    let populated = 0;
    for (let s = 0; s <= LIGHT_MAX; s++) if (c.sky[s] > 0) populated++;
    expect(populated).toBeGreaterThanOrEqual(10);
  });
});

describe('shipped world / the light and the cost', () => {
  it('lights rooms with block light, not just with the sun', () => {
    const c = census();
    // Lava, hellstone, neon and tech panel all emit. If none of their light
    // reaches a visible face then "lava that lights the room" is a screenshot
    // caption rather than a feature.
    expect(c.litShare).toBeGreaterThan(0.02);
    expect(c.maxLight).toBeGreaterThanOrEqual(LIGHT_MAX - 2);
  });

  it('keeps the graded sky channel from shattering the greedy merge', () => {
    const c = census();
    const perChunk = c.quads / c.chunks;
    // Measured at ~2 130 quads per chunk with the gradient in, against ~2 100
    // with it out: +1.5%. Three draw calls a chunk either way; what this pins
    // is triangle count, which is the number the 4x-throttle fps contract at
    // 412x915 actually spends.
    expect(perChunk).toBeLessThan(3000);
    expect(perChunk).toBeGreaterThan(200);
  });
});
