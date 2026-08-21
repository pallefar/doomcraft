/**
 * DOOMCRAFT — the local player's character.
 *
 * WHAT THE ASSET ACTUALLY IS, because it decides everything below.
 *
 * The brief for this system assumed the Kenney pack's "6 meshes, 8 nodes" meant
 * six interchangeable SHAPES. It does not. Measured across all 18 GLBs
 * (`tools/build-character-atlas.mjs` re-asserts it on every run):
 *
 *   - Every character is the same node tree:
 *         root -> leg-left, leg-right, torso -> arm-left, arm-right, head
 *   - Every character's POSITION and TEXCOORD_0 buffers are BYTE-IDENTICAL.
 *     One unique hash per part across all eighteen files.
 *   - The only thing that differs between character-a and character-r is the
 *     1024x1024 PNG the single material points at.
 *
 * So there is exactly one character mesh in this game, and an avatar is not a
 * bag of meshes — it is **four texture choices and two colours**:
 *
 *      head | torso | arms | legs        each picks one of 12 shipped outfits
 *      tint                              multiplies head + legs (skin/boots)
 *      accent                            multiplies torso + arms (the uniform)
 *
 * That is why the whole thing fits in a `uint32`, why it costs 4 bytes on the
 * wire exactly once per player, and why every remote player in a match still
 * draws in ONE instanced draw call: same geometry, same material, same texture,
 * and the outfit is a per-instance UV offset (see `thirdPerson.ts`).
 *
 * This module is pure data. No THREE, no DOM, no storage — so it is testable
 * and so the packing can be reasoned about without a GPU.
 */

import { RIG_DONORS } from './kenneyRig';

/* ------------------------------------------------------------------------ *
 * Zones — the four things a player can dress independently
 * ------------------------------------------------------------------------ */

/**
 * A zone is a group of the rig's six meshes that share one outfit choice.
 * Arms and legs are pairs: the pack ships `arm-left`/`arm-right` and
 * `leg-left`/`leg-right` as separate meshes, but they are two halves of one
 * garment and letting a player wear odd socks looks like a bug, not a feature.
 */
export enum Zone {
  HEAD = 0,
  TORSO = 1,
  ARMS = 2,
  LEGS = 3,
}

export const ZONE_COUNT = 4;

/** Display order and labels for the editor. Matches the shader's zone ids. */
export const ZONE_INFO: readonly { readonly zone: Zone; readonly label: string; readonly meshes: string }[] = [
  { zone: Zone.HEAD, label: 'Head', meshes: 'head' },
  { zone: Zone.TORSO, label: 'Torso', meshes: 'torso' },
  { zone: Zone.ARMS, label: 'Arms', meshes: 'arm-left + arm-right' },
  { zone: Zone.LEGS, label: 'Legs', meshes: 'leg-left + leg-right' },
];

/** How many outfits are shipped. 12 of Kenney's 18; see the roster in the tool. */
export const DONOR_COUNT = RIG_DONORS.length;

/** Human-readable outfit names, index-aligned with the atlas cells. */
export const DONOR_NAMES: readonly string[] = RIG_DONORS.map((d) => d.name);

/* ------------------------------------------------------------------------ *
 * Palette
 *
 * A tint MULTIPLIES the texture. That is the whole reason colour is free: no
 * second material, no second texture, no extra draw call — it rides in as an
 * instanced vertex attribute next to the transform.
 *
 * Every entry obeys the readability rule from ref/BAR.md and the DOOM capture:
 * a player must be brighter than the wall behind them. `DOOM_FOG` is 0x3b2a24,
 * relative luma 0.18, and that is what every distant surface converges to. No
 * tint here is allowed below 0.42 — more than twice the fog — so a tinted
 * player can never sink into the far wall. There is deliberately no black, no
 * navy and no dark green in this list: a "stealth" outfit that swallows the
 * silhouette is a competitive exploit, not a customisation. The unit test
 * enforces the floor rather than trusting this comment.
 * ------------------------------------------------------------------------ */

export interface AvatarColor {
  readonly hex: number;
  readonly name: string;
}

/** Multiplier colours. Index is what travels on the wire. */
export const AVATAR_PALETTE: readonly AvatarColor[] = Object.freeze([
  { hex: 0xffffff, name: 'None' },
  { hex: 0xf6d7b0, name: 'Bone' },
  { hex: 0xf2a03c, name: 'Amber' },
  { hex: 0xe8552f, name: 'Hellfire' },
  { hex: 0xd94f7a, name: 'Rose' },
  { hex: 0xb888f0, name: 'Violet' },
  { hex: 0x7fa8f5, name: 'Cobalt' },
  { hex: 0x62d0e8, name: 'Coolant' },
  { hex: 0x5fdba0, name: 'Toxin' },
  { hex: 0x9fd94f, name: 'Slime' },
  { hex: 0xd8d24a, name: 'Sulphur' },
  { hex: 0xc98f5a, name: 'Rust' },
  { hex: 0xa9b4c2, name: 'Steel' },
  { hex: 0xe0e6ef, name: 'Chrome' },
  { hex: 0xf58ba0, name: 'Flesh' },
  { hex: 0x8de0d2, name: 'Frost' },
]);

export const PALETTE_COUNT = AVATAR_PALETTE.length;

/** Rec.709 relative luma of a packed 0xRRGGBB, 0..1. */
export function lumaOf(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The floor every palette entry must clear so a player never sinks into a wall. */
export const MIN_TINT_LUMA = 0.42;

/* ------------------------------------------------------------------------ *
 * The config
 * ------------------------------------------------------------------------ */

export interface AvatarConfig {
  /** One outfit index per Zone, length ZONE_COUNT. */
  zones: number[];
  /** Index into AVATAR_PALETTE — multiplies head and legs. */
  tint: number;
  /** Index into AVATAR_PALETTE — multiplies torso and arms. */
  accent: number;
}

/**
 * Outfit 0 is the Marine: green fatigues, the closest thing in Kenney's
 * catalogue to a Doom marine, and the one the game boots with.
 */
export function defaultAvatar(): AvatarConfig {
  return { zones: [0, 0, 0, 0], tint: 0, accent: 0 };
}

export function cloneAvatar(a: AvatarConfig): AvatarConfig {
  return { zones: a.zones.slice(0, ZONE_COUNT), tint: a.tint, accent: a.accent };
}

export function avatarsEqual(a: AvatarConfig, b: AvatarConfig): boolean {
  if (a.tint !== b.tint || a.accent !== b.accent) return false;
  for (let i = 0; i < ZONE_COUNT; i++) if (a.zones[i] !== b.zones[i]) return false;
  return true;
}

/* ------------------------------------------------------------------------ *
 * Wire + storage packing
 *
 *   bits  0..3   head outfit    (4 bits, 16 slots, 12 used)
 *   bits  4..7   torso outfit
 *   bits  8..11  arms outfit
 *   bits 12..15  legs outfit
 *   bits 16..20  tint index     (5 bits, 32 slots, 16 used)
 *   bits 21..25  accent index
 *   bits 26..31  reserved       (emote / hat / kill-effect later)
 *
 * 4 bytes, sent once per player in the PF_SPAWN payload. It is deliberately a
 * plain integer and not a struct: the server never has to understand an avatar,
 * only clamp it and hand it back out, so no server code needs to change when
 * the roster grows.
 * ------------------------------------------------------------------------ */

const ZONE_BITS = 4;
const ZONE_MASK = 0xf;
const TINT_SHIFT = 16;
const ACCENT_SHIFT = 21;
const COLOR_MASK = 0x1f;

/** Every bit this version of the game understands. */
export const AVATAR_WIRE_MASK = 0x03ffffff;
/** Bytes this costs on the wire, per player, once. */
export const AVATAR_WIRE_BYTES = 4;

export function packAvatar(a: AvatarConfig): number {
  let v = 0;
  for (let i = 0; i < ZONE_COUNT; i++) {
    v |= (wrapIndex(a.zones[i], DONOR_COUNT) & ZONE_MASK) << (i * ZONE_BITS);
  }
  v |= (wrapIndex(a.tint, PALETTE_COUNT) & COLOR_MASK) << TINT_SHIFT;
  v |= (wrapIndex(a.accent, PALETTE_COUNT) & COLOR_MASK) << ACCENT_SHIFT;
  return v >>> 0;
}

/**
 * Total: any uint32, any float, any NaN, any value from a future client with
 * bits we do not know, becomes a valid config. A hostile peer must not be able
 * to make our renderer index off the end of the atlas.
 */
export function unpackAvatar(packed: number, out?: AvatarConfig): AvatarConfig {
  const v = (Number.isFinite(packed) ? packed : 0) >>> 0;
  const cfg = out ?? { zones: [0, 0, 0, 0], tint: 0, accent: 0 };
  for (let i = 0; i < ZONE_COUNT; i++) {
    cfg.zones[i] = clampIndex((v >>> (i * ZONE_BITS)) & ZONE_MASK, DONOR_COUNT);
  }
  cfg.tint = clampIndex((v >>> TINT_SHIFT) & COLOR_MASK, PALETTE_COUNT);
  cfg.accent = clampIndex((v >>> ACCENT_SHIFT) & COLOR_MASK, PALETTE_COUNT);
  return cfg;
}

/** Out-of-range index from a stranger: fall back to 0 rather than wrapping. */
function clampIndex(v: number, count: number): number {
  return v >= 0 && v < count ? v : 0;
}

/** Out-of-range index from our own UI: wrap, so "next" cycles. */
function wrapIndex(v: number, count: number): number {
  if (!Number.isFinite(v)) return 0;
  const i = Math.round(v) % count;
  return i < 0 ? i + count : i;
}

/** Clamp a config in place. Cheap enough to run on every load. */
export function sanitiseAvatar(a: AvatarConfig): AvatarConfig {
  return unpackAvatar(packAvatar(a), a);
}

/* ------------------------------------------------------------------------ *
 * Legacy bridge
 * ------------------------------------------------------------------------ */

/**
 * v1/v2 saves and old clients carry a single `skin: u8` — an index into the six
 * flat marine colours `game.ts` used to draw. Nobody's identity is thrown away
 * on upgrade: the six old skins map onto six recognisably similar outfits, and
 * the old skin's colour becomes the accent.
 *
 * The mapping is deliberate, not modular arithmetic:
 *   0 green -> Marine,   1 purple -> Warden,  2 orange -> Timber
 *   3 blue  -> Enforcer, 4 red    -> Ranger,  5 grey   -> Sentry
 */
const LEGACY_SKIN_OUTFIT = [0, 9, 4, 1, 2, 8];
const LEGACY_SKIN_ACCENT = [0, 5, 2, 6, 3, 12];

export function avatarFromLegacySkin(skin: number): AvatarConfig {
  const k = Number.isFinite(skin) ? ((Math.round(skin) % 6) + 6) % 6 : 0;
  const outfit = LEGACY_SKIN_OUTFIT[k];
  return { zones: [outfit, outfit, outfit, outfit], tint: 0, accent: LEGACY_SKIN_ACCENT[k] };
}

/**
 * The reverse, for the `skin: u8` field that still exists in the protocol and
 * in `SaveProfile`. An old client seeing a new player must still see *a*
 * marine, so we hand it the nearest legacy colour rather than a zero.
 */
export function legacySkinFromAvatar(a: AvatarConfig): number {
  const outfit = wrapIndex(a.zones[Zone.TORSO], DONOR_COUNT);
  const k = LEGACY_SKIN_OUTFIT.indexOf(outfit);
  return k >= 0 ? k : outfit % 6;
}

/* ------------------------------------------------------------------------ *
 * Randomise
 * ------------------------------------------------------------------------ */

/**
 * The randomise button. Two rules keep the results wearable rather than
 * confetti:
 *   1. Arms usually match the torso — a mismatched sleeve reads as a glitch,
 *      so the split only happens a third of the time.
 *   2. Tint stays "None" most of the time. The Kenney art is already coloured;
 *      multiplying every roll by a strong hue turns the whole roster into one
 *      monochrome mush and destroys the between-player readability that is the
 *      point of having outfits at all.
 */
export function randomAvatar(rand: () => number = Math.random): AvatarConfig {
  const pick = (n: number): number => Math.min(n - 1, Math.floor(rand() * n));
  const torso = pick(DONOR_COUNT);
  const arms = rand() < 0.33 ? pick(DONOR_COUNT) : torso;
  const legs = rand() < 0.5 ? pick(DONOR_COUNT) : torso;
  return {
    zones: [pick(DONOR_COUNT), torso, arms, legs],
    tint: rand() < 0.25 ? pick(PALETTE_COUNT) : 0,
    accent: rand() < 0.55 ? pick(PALETTE_COUNT) : 0,
  };
}

/* ------------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------------ */

/**
 * What the editor prints under the model. A single-outfit avatar is called by
 * that outfit's name; a mix is called by its torso plus "Custom", because the
 * torso is the part you actually see across an arena.
 */
export function avatarLabel(a: AvatarConfig): string {
  const z = a.zones;
  const uniform = z[0] === z[1] && z[1] === z[2] && z[2] === z[3];
  const base = DONOR_NAMES[clampIndex(z[Zone.TORSO], DONOR_COUNT)] ?? 'Marine';
  if (uniform) return base;
  return `${base} · Custom`;
}

/* ------------------------------------------------------------------------ *
 * Save wiring
 *
 * The avatar is per-account progression, so it lives with the schema-versioned
 * saves in `shared/src/saves.ts` as `profile.avatar` — one number, migrated
 * from `profile.skin` by the v2 -> v3 migration. These two helpers are the only
 * place the client converts between the two representations, so a hard refresh
 * can never resurrect a half-written config.
 * ------------------------------------------------------------------------ */

/** Shape of the bits of `SaveFile` this module touches. Structural on purpose. */
export interface AvatarSaveLike {
  profile: { avatar: number; skin: number };
}

export function readAvatar(save: AvatarSaveLike): AvatarConfig {
  return unpackAvatar(save.profile.avatar);
}

/** Writes both the packed avatar and the legacy skin byte, so neither drifts. */
export function writeAvatar(save: AvatarSaveLike, a: AvatarConfig): void {
  save.profile.avatar = packAvatar(a);
  save.profile.skin = legacySkinFromAvatar(a);
}
