/**
 * DOOMCRAFT — who wears what.
 *
 * Lives in shared/, not client/, because the characters PACK (docs/PACKS.md §1,
 * PackKind.CHARACTERS) needs its fingerprint recomputable in the SERVER
 * process — runGate runs in the process that would serve a release, and a
 * fingerprint the server cannot recompute is a gate check that cannot refuse.
 * Pure data and arithmetic; nothing here imports the renderer.
 *
 * Maps the five sim archetypes in server/src/bots.ts and the player to a look:
 * an atlas cell, a tint, a height, which limbs exist and how each limb is
 * stretched.
 *
 * WHY FIVE SKINS OUT OF EIGHTEEN
 *
 * The vendored pack is 2.0 MB for 18 characters that share byte-identical
 * geometry and byte-identical UVs — they are one mesh wearing 18 textures.
 * Shipping all of them would buy 13 skins nobody can name and cost more than
 * the whole rest of the character system put together. Cold transfer is
 * 5.06 MB against the bar's 12.6 MB and that gap is the competitive advantage
 * (ref/BAR.md); it is not there to be spent on spare civilians.
 *
 * Five is the number of things that must be told apart on sight: four monster
 * families plus the player. `tools/pack-characters.mjs` bakes those five into a
 * single 192x128 atlas — 8.9 KB, which is 1.4% of the 653 KB the same five
 * characters cost in raw vendored form.
 *
 * WHY SILHOUETTE COMES FROM PROPORTION, NOT FROM MODELS
 *
 * The DOOM readability rule (ref/BAR.md, ref/doom/doom-gameplay.webm) is that an
 * enemy is identified by its outline before its colour. One shared mesh cannot
 * give five outlines by itself, so the outline is authored here instead:
 *
 *   Imp        1.75 m, lean forward, long arms          — a lunging humanoid
 *   Trooper    1.80 m, upright, gun arm out             — the only one aiming
 *   Baron      2.40 m, torso 1.55x wide, huge shoulders — twice anything else
 *   Cacodemon  1.70 m, NO LEGS, fat cube torso, big head— a floating blob
 *   Lost Soul  0.70 m, HEAD ONLY                        — a flying skull
 *
 * Those five outlines survive being 30 px tall in a dark corridor, which a
 * recoloured copy of the same body would not.
 *
 * Tints multiply and are allowed above 1: the world grade deliberately
 * desaturates terrain (see client/src/engine/material.ts) so that "enemies are
 * the only saturated things on screen", and an enemy must read BRIGHTER than
 * its background.
 */

import { EntityType } from './protocol.ts';

/* ------------------------------------------------------------------ *
 * The rig
 * ------------------------------------------------------------------ */

/** Part order in the packed rig. Must match tools/pack-characters.mjs. */
export const PART_NAMES = ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'] as const;
export const PART_COUNT = PART_NAMES.length;

export const PART_LEG_LEFT = 0;
export const PART_LEG_RIGHT = 1;
export const PART_TORSO = 2;
export const PART_ARM_LEFT = 3;
export const PART_ARM_RIGHT = 4;
export const PART_HEAD = 5;

/** Every part visible. */
export const PARTS_ALL = 0b111111;
/** No legs — a body that floats. */
export const PARTS_NO_LEGS = PARTS_ALL & ~((1 << PART_LEG_LEFT) | (1 << PART_LEG_RIGHT));
/** A head and nothing else. */
export const PARTS_HEAD_ONLY = 1 << PART_HEAD;

/* ------------------------------------------------------------------ *
 * Skin atlas
 * ------------------------------------------------------------------ */

/** Atlas cell index. Must match the SKINS list in tools/pack-characters.mjs. */
export const SKIN_GHOUL = 0;
export const SKIN_TROOPER = 1;
export const SKIN_HAZARD = 2;
export const SKIN_CORE = 3;
export const SKIN_MARINE = 4;

export const ATLAS_COLS = 3;
export const ATLAS_ROWS = 2;

/** UV origin of an atlas cell. */
export function skinOffsetU(skin: number): number { return (skin % ATLAS_COLS) / ATLAS_COLS; }
export function skinOffsetV(skin: number): number { return ((skin / ATLAS_COLS) | 0) / ATLAS_ROWS; }

/* ------------------------------------------------------------------ *
 * Looks
 * ------------------------------------------------------------------ */

/**
 * Rig-node index of the stretch table. Node 0 is `root`, which carries no
 * geometry — stretching it only spreads its children (the legs and the torso),
 * which is how a Baron gets a wider stance without wider shins.
 */
export const NODE_ROOT = 0;
/** Rig-node index of a part. */
export function nodeOfPart(part: number): number { return part + 1; }
export const RIG_NODES = PART_COUNT + 1;

export interface CharacterLook {
  readonly name: string;
  readonly skin: number;
  /** Multiply, per channel. Values above 1 brighten; the material is unclamped. */
  readonly tint: readonly [number, number, number];
  /** Metres, sole of the foot to the crown, after the stretch is applied. */
  readonly height: number;
  /** Bitmask over PART_*. A missing part costs nothing: it is one fewer instance. */
  readonly parts: number;
  /**
   * Per-RIG-NODE (x, y, z) stretch, 21 numbers, indexed by NODE_ROOT /
   * nodeOfPart(). A node's stretch scales its own geometry AND the attachment
   * offset of its children, so widening a torso carries the shoulders outward
   * with it instead of burying the arms inside the chest.
   */
  readonly stretch: readonly number[];
  /** Forward torso lean, radians. Positive pitches the chest toward the target. */
  readonly lean: number;
  /** True if it carries a weapon: the upper body runs the holding/shooting overlay. */
  readonly armed: boolean;
  /** True if its attack is a swing rather than a shot. */
  readonly melee: boolean;
  /** Hovers: no foot contact, so locomotion never plays and the body bobs. */
  readonly hovers: boolean;
  /** Metres of vertical bob for a hoverer. */
  readonly bob: number;
  /** Metres the whole body floats above the entity's feet position. */
  readonly lift: number;
  /** Gait cadence multiplier — a heavy thing steps slower than a light one. */
  readonly cadence: number;
}

/**
 * Build a stretch table.
 *
 * BUG THIS FIXES. The table is documented as RIG-NODE indexed and is read that
 * way (`NODE_ROOT`, `nodeOfPart()`, 21 numbers for 7 nodes), but every look
 * below used to key it with the PART_* constants, which are off by one from the
 * node indices: `[PART_TORSO]` is 2 and node 2 is leg-right. The whole table
 * was therefore applied one node to the left. The Baron's 1.55x chest widened
 * its right shin, the Cacodemon's "fat cube torso" landed on its arms and its
 * torso got the arms' 0.62 SQUASH instead — so the one archetype whose entire
 * silhouette is "a floating ball" rendered as a shrunken box, and the outline
 * `registry.ts`'s own header promises did not exist.
 *
 * The keys are now written through `nodeOfPart()`, which is what the doc said
 * all along, and passing a raw part index is no longer possible to do by
 * accident because the parameter is typed as a node index.
 */
function stretch(nodes: Partial<Record<number, readonly [number, number, number]>>): number[] {
  const s = new Array<number>(RIG_NODES * 3).fill(1);
  for (const key of Object.keys(nodes)) {
    const i = Number(key);
    const v = nodes[i];
    if (v === undefined) continue;
    if (!Number.isInteger(i) || i < 0 || i >= RIG_NODES) {
      throw new RangeError(`stretch(): ${i} is not a rig node; use nodeOfPart()`);
    }
    s[i * 3] = v[0]; s[i * 3 + 1] = v[1]; s[i * 3 + 2] = v[2];
  }
  return s;
}

function look(l: CharacterLook): CharacterLook { return Object.freeze(l); }

/**
 * Imp — the rusher. Lean, hunched, arms hanging long, and the only enemy that
 * closes at a sprint. Green ghoul skin pushed warm so it is not mistaken for
 * foliage.
 */
export const LOOK_IMP = look({
  name: 'Imp',
  skin: SKIN_GHOUL,
  tint: [1.30, 1.02, 0.86],
  height: 1.75,
  parts: PARTS_ALL,
  stretch: stretch({
    [nodeOfPart(PART_ARM_LEFT)]: [0.92, 1.22, 0.92],
    [nodeOfPart(PART_ARM_RIGHT)]: [0.92, 1.22, 0.92],
    [nodeOfPart(PART_TORSO)]: [0.94, 0.94, 0.94],
    [nodeOfPart(PART_HEAD)]: [1.05, 1.0, 1.05],
  }),
  lean: 0.20,
  armed: false,
  melee: true,
  hovers: false,
  bob: 0,
  lift: 0,
  cadence: 1.25,
});

/**
 * Trooper — the hitscan former human. Upright, uniformed, and the only body in
 * the cast that holds a weapon out in front of it. That gun arm is the read.
 */
export const LOOK_TROOPER = look({
  name: 'Trooper',
  skin: SKIN_TROOPER,
  tint: [1.34, 1.30, 1.10],
  height: 1.80,
  parts: PARTS_ALL,
  stretch: stretch({}),
  lean: 0.04,
  armed: true,
  melee: false,
  hovers: false,
  bob: 0,
  lift: 0,
  cadence: 1.0,
});

/**
 * Baron — the tank. 2.4 m and 1.55x across the chest, which at any distance is
 * simply the biggest thing in the room. Hazard-yellow armour: the brightest
 * skin in the pack on the slowest, most dangerous body.
 */
export const LOOK_BARON = look({
  name: 'Baron',
  skin: SKIN_HAZARD,
  tint: [1.06, 0.94, 0.82],
  height: 2.40,
  parts: PARTS_ALL,
  stretch: stretch({
    [nodeOfPart(PART_TORSO)]: [1.55, 1.02, 1.45],
    [nodeOfPart(PART_ARM_LEFT)]: [1.55, 1.06, 1.55],
    [nodeOfPart(PART_ARM_RIGHT)]: [1.55, 1.06, 1.55],
    [nodeOfPart(PART_LEG_LEFT)]: [1.35, 0.94, 1.35],
    [nodeOfPart(PART_LEG_RIGHT)]: [1.35, 0.94, 1.35],
    [nodeOfPart(PART_HEAD)]: [1.16, 1.0, 1.16],
  }),
  lean: 0.07,
  armed: true,
  melee: true,
  hovers: false,
  bob: 0,
  lift: 0,
  cadence: 0.62,
});

/**
 * Cacodemon — the flyer. No legs at all, a torso squashed into a cube and an
 * oversized head, so the outline is a floating ball with two stubs. Nothing
 * else in the cast is legless, which is the whole point.
 */
export const LOOK_CACODEMON = look({
  name: 'Cacodemon',
  skin: SKIN_CORE,
  tint: [1.45, 0.72, 0.62],
  height: 1.70,
  parts: PARTS_NO_LEGS,
  stretch: stretch({
    [nodeOfPart(PART_TORSO)]: [1.95, 1.42, 1.95],
    [nodeOfPart(PART_ARM_LEFT)]: [0.80, 0.62, 0.80],
    [nodeOfPart(PART_ARM_RIGHT)]: [0.80, 0.62, 0.80],
    [nodeOfPart(PART_HEAD)]: [1.42, 1.30, 1.42],
  }),
  lean: 0.0,
  armed: false,
  melee: false,
  hovers: true,
  bob: 0.22,
  lift: 0,
  cadence: 1.0,
});

/**
 * Lost Soul — a head and nothing else, at knee height, moving faster than
 * anything else alive. One instance per soul: the cheapest body in the game.
 */
export const LOOK_LOST_SOUL = look({
  name: 'Lost Soul',
  skin: SKIN_HAZARD,
  tint: [1.55, 1.30, 0.80],
  height: 0.70,
  parts: PARTS_HEAD_ONLY,
  stretch: stretch({ [nodeOfPart(PART_HEAD)]: [1.0, 1.0, 1.0] }),
  lean: 0.0,
  armed: false,
  melee: true,
  hovers: true,
  bob: 0.14,
  lift: 0,
  cadence: 1.0,
});

/** The player and every other marine. Team colour rides on top as a tint. */
export const LOOK_MARINE = look({
  name: 'Marine',
  skin: SKIN_MARINE,
  tint: [1.14, 1.14, 1.14],
  height: 1.80,
  parts: PARTS_ALL,
  stretch: stretch({}),
  lean: 0.0,
  armed: true,
  melee: false,
  hovers: false,
  bob: 0,
  lift: 0,
  cadence: 1.0,
});

export const LOOKS: readonly CharacterLook[] = Object.freeze([
  LOOK_IMP, LOOK_TROOPER, LOOK_BARON, LOOK_CACODEMON, LOOK_LOST_SOUL, LOOK_MARINE,
]);

/**
 * Archetype -> look. Keyed by EntityType so the client never imports the bot AI
 * (which would drag the whole server simulation into the main bundle).
 */
const BY_ENTITY_TYPE: Record<number, CharacterLook> = {
  [EntityType.IMP]: LOOK_IMP,
  [EntityType.ZOMBIE]: LOOK_TROOPER,
  [EntityType.CACODEMON]: LOOK_CACODEMON,
  [EntityType.BARON]: LOOK_BARON,
  [EntityType.LOST_SOUL]: LOOK_LOST_SOUL,
};

/** The look for a monster EntityType, or null if that type has no body. */
export function lookForEntity(type: number): CharacterLook | null {
  return BY_ENTITY_TYPE[type] ?? null;
}

/**
 * Team/skin colour for a marine, as a tint multiplied over LOOK_MARINE. The
 * hues are the ones the box renderer already used, so a returning player sees
 * the same colours they had.
 */
export const MARINE_TEAM_TINT: readonly (readonly [number, number, number])[] = Object.freeze([
  [0.72, 1.30, 0.80],
  [1.12, 0.82, 1.36],
  [1.42, 1.02, 0.66],
  [0.74, 1.06, 1.46],
  [1.48, 0.78, 0.86],
  [1.06, 1.10, 1.18],
]);

export function marineTint(skinIndex: number): readonly [number, number, number] {
  return MARINE_TEAM_TINT[((skinIndex % MARINE_TEAM_TINT.length) + MARINE_TEAM_TINT.length) % MARINE_TEAM_TINT.length];
}

/* ------------------------------------------------------------------ *
 * The pack fingerprint — docs/PACKS.md, PackKind.CHARACTERS
 * ------------------------------------------------------------------ */

/**
 * The exact strings the characters fingerprint is computed from, in canonical
 * order. One line per look plus the rig facts a look's numbers only mean
 * anything relative to. These are what `PackVersion.inputs` stores and what
 * the release console line-diffs — change a tint and the diff names the look.
 *
 * The table is a parameter so a test can prove independence (a changed look
 * moves this fingerprint and no other) without editing the module.
 */
export function charactersFingerprintInputs(looks: readonly CharacterLook[] = LOOKS): string[] {
  const parts: string[] = [
    `rig=${PART_NAMES.join(',')}`,
    `atlas=${ATLAS_COLS}x${ATLAS_ROWS}`,
  ];
  for (const l of looks) {
    parts.push(
      `${l.name}:${l.skin}/${l.tint.join(',')}/${l.height}/${l.parts}`
      + `/${l.stretch.join(',')}/${l.lean}`
      + `/${l.armed ? 1 : 0}${l.melee ? 1 : 0}${l.hovers ? 1 : 0}`
      + `/${l.bob}/${l.lift}/${l.cadence}`,
    );
  }
  return parts;
}
