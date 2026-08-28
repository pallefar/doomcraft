/**
 * DOOMCRAFT — Studio S2: the in-panel level preview.
 *
 * A top-down SLICE at the level's own walking height, not a roof view — a
 * carved level photographed from above is a featureless slab of stone, so the
 * render answers the question the author is actually asking: where can the
 * player WALK, what stands in the way, and where did I put everything.
 *
 * Colours come from the real block palette (`BLOCK_COLOR`), so the floor the
 * author painted is the floor they see; walls are the same block darkened.
 * Every entity is a marker in the colour the game itself uses for it (keys
 * and key doors wear their KeyColor). Rendered with the shareCard raster and
 * PNG encoder — zero dependencies, exactly like the card.
 *
 * The slice height is derived from the PRIMARY SPAWN's feet, because that is
 * the one height every playable level must have an answer for.
 */

import { BLOCK_COLOR, BlockId } from '@doomcraft/shared/blocks';
import {
  PickupKind,
  primarySpawn,
  type Level,
} from '@doomcraft/shared/level';
import { KeyColor } from '@doomcraft/shared/modes';

import { Raster, encodePng } from './shareCard.js';

/** Pixels per block. 96-block levels render at 480px. */
export const PREVIEW_SCALE = 5;
/** The legend strip under the map. */
const LEGEND_H = 26;

const WALL = 0x3a3f47;
const PIT = 0x07070a;
const SPAWN = 0x39e75f;
const ENEMY = 0xe03c1c;
const PICKUP = 0xf0c860;
const SWITCH = 0xff8c1a;
const SECRET = 0xb06ce8;
const EXIT = 0xe8e6e3;
const KEY_RGB: Readonly<Record<number, number>> = Object.freeze({
  [KeyColor.BLUE]: 0x3d8bff,
  [KeyColor.YELLOW]: 0xffd94a,
  [KeyColor.RED]: 0xff4a3d,
});

function shade(rgb: number, mul: number): number {
  const r = Math.min(255, Math.round(((rgb >>> 16) & 0xff) * mul));
  const g = Math.min(255, Math.round(((rgb >>> 8) & 0xff) * mul));
  const b = Math.min(255, Math.round((rgb & 0xff) * mul));
  return (r << 16) | (g << 8) | b;
}

function blockTopColor(id: number): number {
  return BLOCK_COLOR[id * 3] ?? 0x808080;
}

export function renderLevelPreview(level: Level): Buffer {
  const v = level.volume;
  const s = PREVIEW_SCALE;
  const w = v.sizeX * s;
  const h = v.sizeZ * s + LEGEND_H;
  const raster = new Raster(w, h);
  raster.fill(0, 0, w, h, PIT);

  const feetY = Math.max(1, Math.round(primarySpawn(level).y));
  const px = (x: number): number => (x - v.minX) * s;
  const pz = (z: number): number => (z - v.minZ) * s;

  /* ---- the slice ---- */
  for (let z = v.minZ; z <= v.maxZ; z++) {
    for (let x = v.minX; x <= v.maxX; x++) {
      const atFeet = v.getBlockAt(x, feetY, z);
      const atEye = v.getBlockAt(x, feetY + 1, z);
      let rgb: number;
      if (atFeet !== BlockId.AIR || atEye !== BlockId.AIR) {
        rgb = shade(blockTopColor(atFeet !== BlockId.AIR ? atFeet : atEye), 0.35) || WALL;
      } else {
        // Walkable: colour of the first solid below the feet, or a pit.
        let floor = -1;
        for (let y = feetY - 1; y >= 0; y--) {
          const b = v.getBlockAt(x, y, z);
          if (b !== BlockId.AIR) { floor = b; break; }
        }
        rgb = floor < 0 ? PIT : shade(blockTopColor(floor), 0.9);
      }
      raster.fill(px(x), pz(z), s, s, rgb);
    }
  }

  /* ---- footprints first, markers on top ---- */
  for (const d of level.doors) {
    const rgb = KEY_RGB[d.key] ?? 0x9aa4b0;
    raster.fill(px(d.x), pz(d.z), d.w * s, d.d * s, rgb);
  }
  for (const sec of level.secrets) {
    // Outline only — a filled purple slab would hide what is inside it.
    const x0 = px(sec.x), z0 = pz(sec.z), sw = sec.w * s, sd = sec.d * s;
    raster.fill(x0, z0, sw, 2, SECRET);
    raster.fill(x0, z0 + sd - 2, sw, 2, SECRET);
    raster.fill(x0, z0, 2, sd, SECRET);
    raster.fill(x0 + sw - 2, z0, 2, sd, SECRET);
  }
  if (level.exit !== null) {
    const e = level.exit;
    const x0 = px(e.x), z0 = pz(e.z), ew = e.w * s, ed = e.d * s;
    raster.fill(x0, z0, ew, 2, EXIT);
    raster.fill(x0, z0 + ed - 2, ew, 2, EXIT);
    raster.fill(x0, z0, 2, ed, EXIT);
    raster.fill(x0 + ew - 2, z0, 2, ed, EXIT);
    raster.text(x0 + 3, z0 + 3, 'EXIT', 1, EXIT);
  }

  const dot = (x: number, z: number, rgb: number, r = s): void => {
    raster.fill(Math.round(px(x) - r / 2 + s / 2), Math.round(pz(z) - r / 2 + s / 2), r, r, rgb);
  };
  for (const sp of level.spawns) dot(sp.x, sp.z, SPAWN, s + 2);
  for (const e of level.enemies) dot(e.x, e.z, ENEMY);
  for (const p of level.pickups) {
    const keyColour = KEY_RGB[p.variant];
    dot(p.x, p.z, p.kind === PickupKind.KEY && keyColour !== undefined ? keyColour : PICKUP, s - 1);
  }
  for (const sw of level.switches) dot(sw.x + 0.5, sw.z + 0.5, SWITCH, s + 1);

  /* ---- legend ---- */
  const ly = v.sizeZ * s + 8;
  let lx = 8;
  const item = (rgb: number, label: string): void => {
    raster.fill(lx, ly, 8, 8, rgb);
    raster.text(lx + 12, ly, label, 1, 0x9d968f);
    lx += 12 + label.length * 6 + 14;
  };
  item(SPAWN, 'SPAWN');
  item(ENEMY, 'ENEMY');
  item(PICKUP, 'PICKUP');
  item(SWITCH, 'SWITCH');
  item(SECRET, 'SECRET');
  item(EXIT, 'EXIT');

  return encodePng(raster);
}
