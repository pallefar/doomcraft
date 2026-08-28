/**
 * DOOMCRAFT — the S2 preview renderer, proven at the pixel level.
 *
 * The shareCard S36 precedent: when an image is the product, the test reads
 * the image. The PNG is decoded for real (inflate + filter-0 rows) and the
 * assertions are about pixels a broken renderer would get wrong: the spawn
 * marker is GREEN at the spawn, a wall column is dark, a walkable column
 * wears its floor's colour, and the legend strip is not empty.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREVIEW_SCALE, renderLevelPreview } from './studioPreview.js';
import { compileLevel, parseLevelJson, primarySpawn, type Level } from '@doomcraft/shared/level';

const here = dirname(fileURLToPath(import.meta.url));

function load(id: string): Level {
  const text = readFileSync(join(here, '..', '..', 'content', 'levels', `${id}.json`), 'utf8');
  const src = parseLevelJson(text);
  if (src === null) throw new Error(`${id} unparseable`);
  return compileLevel(src);
}

/** Decode our own filter-0 PNG back to raw RGB rows. */
function decode(png: Buffer): { w: number; h: number; at: (x: number, y: number) => [number, number, number] } {
  expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  // Collect IDAT chunks.
  const idat: Buffer[] = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + w * 3;
  expect(raw.length).toBe(stride * h);
  for (let y = 0; y < h; y++) expect(raw[y * stride]).toBe(0); // filter 0 only
  return {
    w, h,
    at(x: number, y: number): [number, number, number] {
      const i = y * stride + 1 + x * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    },
  };
}

describe('renderLevelPreview', () => {
  it('renders a 96-block level at 5px/block with the legend strip', () => {
    const img = decode(renderLevelPreview(load('tut-01-basic-training')));
    expect(img.w).toBe(96 * PREVIEW_SCALE);
    expect(img.h).toBe(96 * PREVIEW_SCALE + 26);
  });

  it('draws the spawn GREEN, walls dark, and walkable floor in its own colour', () => {
    const level = load('tut-01-basic-training');
    const img = decode(renderLevelPreview(level));
    const s = PREVIEW_SCALE;
    const sp = primarySpawn(level);
    const [r, g, b] = img.at(Math.round(sp.x * s), Math.round(sp.z * s));
    expect(g).toBeGreaterThan(150);       // the marker is green…
    expect(g).toBeGreaterThan(r + 40);    // …and green DOMINATES
    expect(g).toBeGreaterThan(b + 40);

    // (1,1) is solid rock at walking height — a wall pixel, dark.
    const wall = img.at(1 * s + 2, 1 * s + 2);
    expect(Math.max(...wall)).toBeLessThan(90);

    // The middle of the spawn hall (48, 20) is walkable and BRIGHTER than the wall.
    const floor = img.at(48 * s, 20 * s);
    expect(Math.max(...floor)).toBeGreaterThan(Math.max(...wall));
  });

  it('marks enemies red on a level that has them, and the legend is not empty', () => {
    const level = load('tut-02-live-fire');
    const img = decode(renderLevelPreview(level));
    const s = PREVIEW_SCALE;
    const e = level.enemies[0];
    const [r, g, b] = img.at(Math.round(e.x * s), Math.round(e.z * s));
    expect(r).toBeGreaterThan(150);
    expect(r).toBeGreaterThan(g + 60);
    expect(r).toBeGreaterThan(b + 60);

    // Legend strip: at least one non-background pixel (the swatches + text).
    let lit = 0;
    for (let x = 0; x < img.w; x += 3) {
      const [lr, lg, lb] = img.at(x, img.h - 14);
      if (lr + lg + lb > 40) lit++;
    }
    expect(lit).toBeGreaterThan(5);
  });

  it('every shipped level renders without throwing', () => {
    for (const id of ['e1m1-hangar', 'e1m2-coolant', 'e1m3-warrens', 'e1m4-blackout', 'e1m5-furnace', 'e1m6-throne', 'tut-03-locks-and-keys']) {
      const png = renderLevelPreview(load(id));
      expect(png.length).toBeGreaterThan(1000);
    }
  });
});
