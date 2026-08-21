/**
 * DOOMCRAFT — per-mode palette.
 *
 * Before this file the four modes shared one palette and only Quest could
 * change it, from its LevelMeta. Horde's "hell" was therefore not a palette at
 * all: it was the hurt flash left pinned at full by a wave that hits you more
 * often than the flash fades, multiplying every albedo by (1.55, 0.34, 0.28).
 * That reads as a red sheet stretched over the lens — the sky, the arena
 * ceiling and the floor all land within a few grey levels of each other, and
 * nothing that the surface atlas does survives it.
 *
 * The fix is to say the mood in the things that carry depth — the sky, the fog
 * colour, the light balance and a small grade — and to leave the albedo
 * multiplier almost alone. A palette here is:
 *
 *   - **sky + fog**, which are one decision. `fog` IS the sky's horizon colour;
 *     if they differ the render-distance boundary becomes a visible seam
 *     (skybox.ts says the same thing from the other side).
 *   - **fogStartFrac**, the share of the fog range that is completely clear
 *     air. This is the knob that decides whether distance reads as atmosphere
 *     or as a wash: fog measured from the eye had already taken a third of the
 *     contrast out of a wall at 60 m.
 *   - **light balance**, sky ambient against direct sun. More sun = harder
 *     shapes; more ambient = flatter and more legible.
 *   - **grade**, exposure / contrast / saturation, and a *small* standing tint.
 *
 * Quest is deliberately absent: it drives all of this per level through
 * QuestPaletteSink, and a table entry here would fight it.
 */

import {
  DOOM_FOG,
  DOOM_SKY_EMBER,
  DOOM_SKY_GROUND,
  DOOM_SKY_HIGH,
  DOOM_SKY_ZENITH,
} from './material';

export interface ModePalette {
  /** Packed 0xRRGGBB. Also the sky's horizon colour — they must be equal. */
  readonly fog: number;
  readonly skyZenith: number;
  readonly skyHigh: number;
  readonly skyGround: number;
  readonly ember: number;
  /** Higher = thinner hot band on the horizon. 30 is about one degree of sky. */
  readonly emberTightness: number;
  readonly sunGlow: number;
  /** Fraction of the fog range that is clear air. 0 = fog from the eye out. */
  readonly fogStartFrac: number;
  readonly ambient: number;
  readonly sun: number;
  readonly exposure: number;
  readonly contrast: number;
  readonly saturation: number;
  /**
   * Standing albedo multiplier, one per channel. Keep every channel inside
   * roughly 0.9 .. 1.1: uTint multiplies before exposure and the clamp, so a
   * bigger number clips the bright end into a single hue and a smaller one
   * pushes a dark palette under 8-bit quantisation.
   */
  readonly tint: readonly [number, number, number];
}

/** What every mode gets unless it says otherwise. Matches Game's own defaults. */
export const DEFAULT_PALETTE: ModePalette = Object.freeze({
  fog: DOOM_FOG,
  skyZenith: DOOM_SKY_ZENITH,
  skyHigh: DOOM_SKY_HIGH,
  skyGround: DOOM_SKY_GROUND,
  ember: DOOM_SKY_EMBER,
  emberTightness: 30,
  sunGlow: 1,
  fogStartFrac: 0.28,
  ambient: 0.60,
  sun: 0.40,
  exposure: 1.12,
  contrast: 0.14,
  saturation: 0.88,
  tint: [1, 1, 1] as const,
});

/**
 * Horde. Hell has to come from the sky and the air, because it has to survive
 * being looked at for twenty waves — and because a filter over the lens erases
 * exactly the surface detail the world is made of.
 *
 * So: a low burning sky with a wide ember band, a hot dark fog that the horizon
 * dissolves into, a harder sun so the fortifications throw readable faces, and
 * a warm push on the albedo that is measured rather than eyeballed. The arena
 * runs at a mean luminance near 45, so a (1.10, 0.955, 0.875) multiplier is
 * about 10 grey levels of red-over-blue — plainly warm, and small enough that
 * green and blue keep 96% and 88% of their range. The flash it replaces was
 * (1.55, 0.34, 0.28): 76 levels of red-over-blue with blue cut to a quarter,
 * which is a filter, not a palette. Measured over the middle 700 px of the
 * frame, mean red-minus-blue goes 146 -> 10 and mean saturation 0.78 -> 0.25.
 */
const HORDE_PALETTE: ModePalette = Object.freeze({
  fog: 0x4a2419,
  skyZenith: 0x1a0e16,
  skyHigh: 0x3c1b1a,
  skyGround: 0x160b09,
  ember: 0xff5a1c,
  emberTightness: 19,
  sunGlow: 1.3,
  // Some warm depth outdoors, but the fortify ring is 20-30 m across and must
  // stay completely clear of it.
  fogStartFrac: 0.24,
  ambient: 0.56,
  sun: 0.44,
  exposure: 1.10,
  contrast: 0.16,
  // Up, not down. Saturation is the channel a red palette has left once the
  // luminance range is small, and it is what stops hell reading as one colour.
  saturation: 0.94,
  tint: [1.10, 0.955, 0.875] as const,
});

/**
 * Deathmatch. The arena is grey blocks on an orange checker floor and it is
 * read at range, so this is the mode that most wants air rather than fog: the
 * clear range goes out to a third of the fog distance, the shadow-crush comes
 * off the contrast curve, and exposure comes up a step so a grey face at 40 m
 * still has grey levels to spend on its surface.
 */
const DEATHMATCH_PALETTE: ModePalette = Object.freeze({
  ...DEFAULT_PALETTE,
  fogStartFrac: 0.34,
  exposure: 1.16,
  contrast: 0.11,
  saturation: 0.90,
});

/**
 * Builder. A tool: colours must be true, distance must be readable, and there
 * is nothing to be moody about. Longest clear range of the four.
 */
const BUILDER_PALETTE: ModePalette = Object.freeze({
  ...DEFAULT_PALETTE,
  fogStartFrac: 0.40,
  exposure: 1.14,
  contrast: 0.10,
  saturation: 0.95,
});

/**
 * By mode slug. `null` means "this mode owns its own palette, do not touch it"
 * — that is Quest, whose LevelMeta drives ambient, fog and sky per level.
 */
export const MODE_PALETTES: Readonly<Record<string, ModePalette | null>> = Object.freeze({
  quest: null,
  builder: BUILDER_PALETTE,
  horde: HORDE_PALETTE,
  deathmatch: DEATHMATCH_PALETTE,
});

/** Everything a palette needs to reach. Kept structural so Game stays untyped here. */
export interface PaletteTarget {
  readonly materials: {
    setFogColor(hex: number): void;
    setFogRange(startMetres: number, farMetres: number): void;
    setLightBalance(ambient: number, sun: number): void;
    setExposure(v: number): void;
    setContrast(v: number): void;
    setSaturation(v: number): void;
    readonly fogFarDistance: number;
  };
  readonly sky: {
    setColors(opts: {
      zenith?: number; high?: number; horizon?: number; ground?: number;
      ember?: number; emberTightness?: number; sunGlow?: number;
    }): void;
  };
  setModeTint(r: number, g: number, b: number): void;
}

/**
 * Apply one palette. The fog distance itself is not a palette value — it is set
 * from the render distance, which is a settings decision — so only the clear-air
 * share of it is taken from here.
 */
export function applyPalette(target: PaletteTarget, p: ModePalette): void {
  const far = target.materials.fogFarDistance;
  target.materials.setFogColor(p.fog);
  target.materials.setFogRange(far * p.fogStartFrac, far);
  target.materials.setLightBalance(p.ambient, p.sun);
  target.materials.setExposure(p.exposure);
  target.materials.setContrast(p.contrast);
  target.materials.setSaturation(p.saturation);
  target.sky.setColors({
    zenith: p.skyZenith,
    high: p.skyHigh,
    horizon: p.fog,
    ground: p.skyGround,
    ember: p.ember,
    emberTightness: p.emberTightness,
    sunGlow: p.sunGlow,
  });
  target.setModeTint(p.tint[0], p.tint[1], p.tint[2]);
}

/**
 * Apply the palette for a mode slug. An unknown slug gets the default.
 *
 * A `null` entry means the mode drives fog, sky colour and ambient itself, so
 * those are left alone — but only those. The ember shape, the sun glow and the
 * grade are still reset, because a mode that does not set them would otherwise
 * inherit them from whatever ran before it: Quest after Horde used to keep
 * Horde's wide burning ember band on E1M1's sky.
 */
export function applyModePalette(target: PaletteTarget, modeKey: string): void {
  const p = MODE_PALETTES[modeKey];
  if (p !== null) {
    applyPalette(target, p ?? DEFAULT_PALETTE);
    return;
  }
  const d = DEFAULT_PALETTE;
  target.sky.setColors({ emberTightness: d.emberTightness, sunGlow: d.sunGlow });
  target.materials.setExposure(d.exposure);
  target.materials.setContrast(d.contrast);
  target.materials.setSaturation(d.saturation);
  target.setModeTint(d.tint[0], d.tint[1], d.tint[2]);
}
