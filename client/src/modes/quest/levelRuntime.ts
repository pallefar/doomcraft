/**
 * DOOMCRAFT — Quest: the authored-level runtime.
 *
 * Quest does NOT use the generated terrain path. A Quest level is a `Level`
 * decoded from `content/levels/*.json|dcl`, and this file is the machine that
 * turns that data into a world you can walk around in:
 *
 *   1. **Geometry.** The level's full-height 32x64x32 sections are blitted into
 *      the live voxel world. When the level sits on its authored coordinates
 *      that is one `slice()` per chunk; when it has been relocated (see
 *      `alignSpawnTo`) it is a per-voxel merge that keeps whatever the world
 *      already had outside the level's footprint. Either way the result is a
 *      set of world-space chunk arrays this object owns, so it can *re-assert*
 *      them one chunk per frame — a server that streams generated terrain over
 *      the top loses the argument within a quarter of a second, for a cost of
 *      one Map lookup and one identity compare per frame.
 *
 *   2. **The script.** Doors (with their key), switches (with their targets and
 *      the literal `exit`), secret sectors, pickups, the exit sector, and the
 *      authored enemy roster with its six trigger kinds. This is the whole of
 *      "keycards gate the level graph, secrets hide behind fake walls, a switch
 *      opens the exit" from docs/MODES.md §1, and it is deterministic and
 *      side-effect-free apart from the two sinks it is handed.
 *
 *   3. **The palette.** `LevelMeta` carries sky, fog and ambient per level, and
 *      that is how E1M4 gets to run at ambient 0.12 with a 30-block fog wall
 *      while E1M5 runs hot. Dark corridors against lit rooms is a *content*
 *      decision here, not a code one.
 *
 *   4. **The economy.** `fillPickupGrant` at the bottom of the file prices one
 *      pickup — Doom's clip of 10, box of 8 shells, the weapon that arrives
 *      loaded, the backpack — with the level file's own `amount` overriding
 *      every default and `SKILL_PICKUP_SCALE` doubling it on the easy skill.
 *      It is pure, so `quest.test.ts` can weigh the whole shipped campaign
 *      against the monster roster it ships.
 *
 * COST. Everything expensive happens in `place()`, which runs behind a loading
 * screen. `update()` allocates nothing: it walks fixed arrays, tests boxes with
 * integer compares, and does at most one line-of-sight raycast and one chunk
 * re-assert per call. No closures are created after construction.
 *
 * DEPENDENCIES. No DOM, no `three`, no `node:*` — the two sinks are declared
 * structurally. That is deliberate: this file is the part of Quest a unit test
 * can drive, and `quest.test.ts` does exactly that.
 */

import {
  CHUNK_HEIGHT,
  CHUNK_SIZE_MASK,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  REACH_INTERACT,
  WORLD_MAX_CHUNK,
  WORLD_MIN_CHUNK,
  blockToChunk,
  chunkKey,
  chunkKeyCX,
  chunkKeyCZ,
  voxelIndex,
} from '@shared/constants';
import { BLOCK_SOLID, BlockId } from '@shared/blocks';
import { createVoxelHit, type VoxelHit, raycastVoxels } from '@shared/math';
import {
  KeyColor,
  SKILL_PICKUP_SCALE,
  Skill,
  clampSkill,
  hasKey,
  keyBit,
  keyNameOf,
} from '@shared/modes';
import { AMMO_TYPE_COUNT, AmmoType, WEAPONS, WeaponId, ammoTypeOf } from '@shared/weapons';
import {
  DR_AUTO_CLOSE,
  DR_START_OPEN,
  DR_SWITCH_ONLY,
  EN_COUNTS_AS_KILL,
  EX_ENDS_EPISODE,
  PU_COUNTS_AS_ITEM,
  PickupKind,
  SW_ONCE,
  SpawnKind,
  TriggerKind,
  enemyAppearsAtSkill,
  levelTotals,
  pickupAppearsAtSkill,
  primarySpawn,
  type Level,
  type LevelPickup,
  type LevelTotals,
} from '@shared/level';

/* ------------------------------------------------------------------------ *
 * Sinks — declared structurally so this module imports nothing from the game
 * ------------------------------------------------------------------------ */

/**
 * The slice of the client's voxel plumbing the runtime writes through.
 * `quest.ts` implements it over `NetClient.world` + `ChunkRenderer` + the
 * minimap; `quest.test.ts` implements it over a plain Map.
 */
export interface QuestWorldSink {
  /** Live voxels for a chunk, or undefined when the chunk is not loaded. */
  chunkAt(cx: number, cz: number): Uint8Array | undefined;
  /** Install a whole chunk. The array is owned by the runtime; do not mutate. */
  putChunk(cx: number, cz: number, voxels: Uint8Array): void;
  /** Change one voxel (doors, switch faces). */
  setBlock(x: number, y: number, z: number, id: number): void;
  /** Read one voxel. Anything outside the loaded world should read as air. */
  getBlock(x: number, y: number, z: number): number;
}

/** Per-level lighting. Implemented over `VoxelMaterials` + `Skybox`. */
export interface QuestPaletteSink {
  /** 0..1 each. Quest runs dark so demons read bright. */
  setAmbient(ambient: number, sun: number): void;
  /** Packed 0xRRGGBB plus the near/far distances in metres. */
  setFog(color: number, nearMetres: number, farMetres: number): void;
  /** Packed 0xRRGGBB. `fog` must equal the fog colour or the horizon seams. */
  setSky(zenith: number, horizon: number, fog: number): void;
}

/* ------------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------------ */

export const enum QuestEvent {
  /** `index` = secret index. */
  SECRET_FOUND = 0,
  /** `index` = pickup index, `a` = KeyColor. */
  KEY_TAKEN = 1,
  /** `index` = pickup index. */
  ITEM_TAKEN = 2,
  /** `index` = door index, `a` = KeyColor the door wants. */
  DOOR_LOCKED = 3,
  /** `index` = door index. */
  DOOR_OPENED = 4,
  /** `index` = switch index. */
  SWITCH_THROWN = 5,
  /** `index` = enemy index, `a` = EntityType. */
  ENEMY_WOKE = 6,
  /** The exit switch has been thrown. */
  EXIT_ARMED = 7,
  /** The player stood in the exit sector with the exit live. */
  EXIT_REACHED = 8,
  /** A plain line for the log. `text` carries it. */
  MESSAGE = 9,
  /**
   * `index` = door index, `a` = rows now retracted into the lintel.
   *
   * The one runtime event that is not for the player: it fires on every frame a
   * door's VOXELS actually change, so the mode can tell a room that owns this
   * level to carve the same rows. Without it a room simulating the authored
   * geometry keeps a solid slab in an opened doorway, and the player walks into
   * a door they can see straight through. See `ModeAction.SET_DOOR`.
   */
  DOOR_ROWS = 10,
}

/** One callback, no allocation. `text` is '' for events that carry no line. */
export type QuestEventSink = (kind: QuestEvent, index: number, a: number, text: string) => void;

/* ------------------------------------------------------------------------ *
 * Door state
 * ------------------------------------------------------------------------ */

export const DOOR_CLOSED = 0;
export const DOOR_OPENING = 1;
export const DOOR_OPEN = 2;
export const DOOR_CLOSING = 3;

/** Result codes from `use()`. */
export const USE_NOTHING = 0;
export const USE_SWITCH = 1;
export const USE_DOOR_OPENED = 2;
export const USE_DOOR_LOCKED = 3;
export const USE_ALREADY = 4;

/* ------------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------------ */

export interface QuestRuntimeOptions {
  level: Level;
  skill: number;
  world: QuestWorldSink;
  palette?: QuestPaletteSink | null;
  events?: QuestEventSink | null;
  /** Whole-block offset added to every authored coordinate. */
  originX?: number;
  originY?: number;
  originZ?: number;
  /** Radius in metres at which a pickup is collected. */
  pickupRadius?: number;
}

/** Where a player should appear, after the origin offset. */
export interface QuestSpawn { x: number; y: number; z: number; yaw: number }

/* ------------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------------ */

const NO_EVENTS: QuestEventSink = () => { /* the level runs fine unobserved */ };

/** Enemies whose line of sight is tested per frame. Sight is not urgent. */
const SIGHT_TESTS_PER_UPDATE = 2;
/** Chunks re-asserted per frame. 9..16 sections settle in a quarter second. */
const REASSERT_PER_UPDATE = 1;
/** Beyond this an authored enemy never wakes on sight. */
const MAX_SIGHT_RANGE = 44;

export class QuestLevelRuntime {
  readonly level: Level;
  readonly skill: Skill;
  readonly totals: LevelTotals;

  /** Origin offset applied to every authored coordinate, in blocks. */
  originX = 0;
  originY = 0;
  originZ = 0;

  /* --- live progress -------------------------------------------------- */
  /** Keycard bitmask; see `keyBit`. */
  keys = 0;
  kills = 0;
  items = 0;
  secrets = 0;
  /** True once the exit switch (if any) has been thrown. */
  exitArmed = false;
  /** True once the player has stood in a live exit sector. */
  exitReached = false;
  /** True when the exit ends the episode rather than loading a next level. */
  readonly endsEpisode: boolean;
  readonly nextLevelId: string;

  private readonly world: QuestWorldSink;
  private readonly palette: QuestPaletteSink | null;
  private readonly emit: QuestEventSink;
  private readonly pickupRadiusSq: number;

  /* --- placed geometry -------------------------------------------------- */
  /** World-space chunk arrays this runtime owns. Re-asserted round robin. */
  private readonly placed = new Map<number, Uint8Array>();
  private readonly placedKeys: number[] = [];
  private reassertCursor = 0;
  private placedOnce = false;

  /* --- doors ------------------------------------------------------------ */
  /** [x0,y0,z0,x1,y1,z1] per door, world space. */
  private readonly doorBox: Int32Array;
  private readonly doorState: Uint8Array;
  /** 0..1 animation progress. */
  private readonly doorT: Float32Array;
  /** Rows currently carved out of the door, counted from the top. */
  private readonly doorRows: Int16Array;
  /** Milliseconds an open auto-close door has left. */
  private readonly doorHold: Float32Array;
  /** Set when a switch has released a DR_SWITCH_ONLY door. */
  private readonly doorReleased: Uint8Array;

  /* --- switches ---------------------------------------------------------- */
  private readonly switchPos: Int32Array;   // x,y,z per switch
  private readonly switchThrown: Uint8Array;

  /* --- secrets / exit ---------------------------------------------------- */
  private readonly secretBox: Int32Array;   // x0,y0,z0,x1,y1,z1
  private readonly secretFound: Uint8Array;
  private readonly exitBox: Int32Array = new Int32Array(6);
  private readonly hasExit: boolean;

  /* --- pickups ----------------------------------------------------------- */
  /** Indices into `level.pickups` that exist at this skill. */
  private readonly pickupIndex: Int32Array;
  private readonly pickupPos: Float64Array;  // x,y,z per live pickup
  private readonly pickupTaken: Uint8Array;
  private readonly pickupCounts: Uint8Array; // 1 when it counts toward `items`

  /* --- enemies ----------------------------------------------------------- */
  /** Indices into `level.enemies` that exist at this skill. */
  private readonly enemyIndex: Int32Array;
  private readonly enemyPos: Float64Array;   // x,y,z per live enemy
  private readonly enemyAwake: Uint8Array;
  private readonly enemyDead: Uint8Array;
  private readonly enemyCounts: Uint8Array;
  private sightCursor = 0;

  /* --- scratch ----------------------------------------------------------- */
  private readonly hit: VoxelHit = createVoxelHit();
  private readonly sampleBlock: (x: number, y: number, z: number) => number;

  constructor(opts: QuestRuntimeOptions) {
    const level = opts.level;
    this.level = level;
    this.skill = clampSkill(opts.skill);
    this.world = opts.world;
    this.palette = opts.palette ?? null;
    this.emit = opts.events ?? NO_EVENTS;
    this.originX = opts.originX ?? 0;
    this.originY = opts.originY ?? 0;
    this.originZ = opts.originZ ?? 0;
    const r = opts.pickupRadius ?? 1.35;
    this.pickupRadiusSq = r * r;
    this.totals = levelTotals(level, this.skill);
    this.sampleBlock = (x, y, z) => this.world.getBlock(x, y, z);

    /* --- doors ---------------------------------------------------------- */
    const nd = level.doors.length;
    this.doorBox = new Int32Array(nd * 6);
    this.doorState = new Uint8Array(nd);
    this.doorT = new Float32Array(nd);
    this.doorRows = new Int16Array(nd);
    this.doorHold = new Float32Array(nd);
    this.doorReleased = new Uint8Array(nd);

    /* --- switches -------------------------------------------------------- */
    const ns = level.switches.length;
    this.switchPos = new Int32Array(ns * 3);
    this.switchThrown = new Uint8Array(ns);

    /* --- secrets --------------------------------------------------------- */
    const nsec = level.secrets.length;
    this.secretBox = new Int32Array(nsec * 6);
    this.secretFound = new Uint8Array(nsec);

    /* --- pickups --------------------------------------------------------- */
    let np = 0;
    for (const p of level.pickups) if (pickupAppearsAtSkill(p, this.skill)) np++;
    this.pickupIndex = new Int32Array(np);
    this.pickupPos = new Float64Array(np * 3);
    this.pickupTaken = new Uint8Array(np);
    this.pickupCounts = new Uint8Array(np);
    let pi = 0;
    for (let i = 0; i < level.pickups.length; i++) {
      const p = level.pickups[i];
      if (!pickupAppearsAtSkill(p, this.skill)) continue;
      this.pickupIndex[pi] = i;
      this.pickupCounts[pi] = (p.flags & PU_COUNTS_AS_ITEM) !== 0 ? 1 : 0;
      pi++;
    }

    /* --- enemies ---------------------------------------------------------- */
    let ne = 0;
    for (const e of level.enemies) if (enemyAppearsAtSkill(e, this.skill)) ne++;
    this.enemyIndex = new Int32Array(ne);
    this.enemyPos = new Float64Array(ne * 3);
    this.enemyAwake = new Uint8Array(ne);
    this.enemyDead = new Uint8Array(ne);
    this.enemyCounts = new Uint8Array(ne);
    let ei = 0;
    for (let i = 0; i < level.enemies.length; i++) {
      const e = level.enemies[i];
      if (!enemyAppearsAtSkill(e, this.skill)) continue;
      this.enemyIndex[ei] = i;
      this.enemyCounts[ei] = (e.flags & EN_COUNTS_AS_KILL) !== 0 ? 1 : 0;
      ei++;
    }

    this.hasExit = level.exit !== null;
    this.endsEpisode = level.exit !== null && (level.exit.flags & EX_ENDS_EPISODE) !== 0;
    this.nextLevelId = level.exit === null ? '' : level.exit.nextLevelId;

    this.rebuildWorldSpace();
  }

  /* -------------------------------------------------------------------- *
   * Placement
   * -------------------------------------------------------------------- */

  /** Recompute every world-space box and position from the current origin. */
  private rebuildWorldSpace(): void {
    const ox = this.originX, oy = this.originY, oz = this.originZ;
    const level = this.level;

    for (let i = 0; i < level.doors.length; i++) {
      const d = level.doors[i];
      const b = i * 6;
      this.doorBox[b] = d.x + ox;
      this.doorBox[b + 1] = d.y + oy;
      this.doorBox[b + 2] = d.z + oz;
      this.doorBox[b + 3] = d.x + d.w - 1 + ox;
      this.doorBox[b + 4] = d.y + d.h - 1 + oy;
      this.doorBox[b + 5] = d.z + d.d - 1 + oz;
    }
    for (let i = 0; i < level.switches.length; i++) {
      const s = level.switches[i];
      this.switchPos[i * 3] = s.x + ox;
      this.switchPos[i * 3 + 1] = s.y + oy;
      this.switchPos[i * 3 + 2] = s.z + oz;
    }
    for (let i = 0; i < level.secrets.length; i++) {
      const s = level.secrets[i];
      const b = i * 6;
      this.secretBox[b] = s.x + ox;
      this.secretBox[b + 1] = s.y + oy;
      this.secretBox[b + 2] = s.z + oz;
      this.secretBox[b + 3] = s.x + s.w - 1 + ox;
      this.secretBox[b + 4] = s.y + s.h - 1 + oy;
      this.secretBox[b + 5] = s.z + s.d - 1 + oz;
    }
    const e = level.exit;
    if (e !== null) {
      this.exitBox[0] = e.x + ox;
      this.exitBox[1] = e.y + oy;
      this.exitBox[2] = e.z + oz;
      this.exitBox[3] = e.x + e.w - 1 + ox;
      this.exitBox[4] = e.y + e.h - 1 + oy;
      this.exitBox[5] = e.z + e.d - 1 + oz;
    }
    for (let i = 0; i < this.pickupIndex.length; i++) {
      const p = level.pickups[this.pickupIndex[i]];
      this.pickupPos[i * 3] = p.x + ox;
      this.pickupPos[i * 3 + 1] = p.y + oy;
      this.pickupPos[i * 3 + 2] = p.z + oz;
    }
    for (let i = 0; i < this.enemyIndex.length; i++) {
      const en = level.enemies[this.enemyIndex[i]];
      this.enemyPos[i * 3] = en.x + ox;
      this.enemyPos[i * 3 + 1] = en.y + oy;
      this.enemyPos[i * 3 + 2] = en.z + oz;
    }
  }

  /**
   * Choose an origin that drops the level's player start on `(px, pz)` and its
   * floor under `py`. Used only when nothing has placed the player inside the
   * level for us — an authoritative Quest room spawns at `spawnFor(id)` and the
   * origin stays at zero. Must be called before `place()`.
   */
  alignSpawnTo(px: number, py: number, pz: number): void {
    const spawn = primarySpawn(this.level);
    this.originX = Math.floor(px) - Math.floor(spawn.x);
    this.originZ = Math.floor(pz) - Math.floor(spawn.z);

    // Keep the whole authored column inside 0..63 so nothing is clipped away.
    let top = 0;
    const v = this.level.volume;
    for (const section of v.sections.values()) {
      for (let y = CHUNK_HEIGHT - 1; y > top; y--) {
        let used = false;
        const base = y << 10;
        for (let i = 0; i < 1024; i++) {
          if (section[base + i] !== 0) { used = true; break; }
        }
        if (used) { if (y > top) top = y; break; }
      }
    }
    const want = Math.floor(py) - Math.floor(spawn.y);
    const maxOffset = CHUNK_HEIGHT - 1 - top;
    this.originY = want < 0 ? 0 : want > maxOffset ? maxOffset : want;
    this.rebuildWorldSpace();
  }

  /** True when a world position is inside the placed level's chunk footprint. */
  coversBlock(x: number, y: number, z: number): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    return this.placed.has(chunkKey(blockToChunk(x), blockToChunk(z)));
  }

  /**
   * Blit the level into the world. Cold path — this is the loading screen. When
   * the origin is chunk-aligned and unshifted vertically it is one `slice()`
   * per section; otherwise it merges per voxel over whatever is already there.
   */
  place(): void {
    const v = this.level.volume;
    const ox = this.originX, oy = this.originY, oz = this.originZ;
    const aligned = (ox & CHUNK_SIZE_MASK) === 0 && (oz & CHUNK_SIZE_MASK) === 0 && oy === 0;

    this.placed.clear();
    this.placedKeys.length = 0;
    this.reassertCursor = 0;

    if (aligned) {
      const dcx = ox >> 5;
      const dcz = oz >> 5;
      for (const [key, section] of v.sections) {
        const cx = chunkKeyCX(key) + dcx;
        const cz = chunkKeyCZ(key) + dcz;
        if (cx < WORLD_MIN_CHUNK || cx > WORLD_MAX_CHUNK) continue;
        if (cz < WORLD_MIN_CHUNK || cz > WORLD_MAX_CHUNK) continue;
        this.placed.set(chunkKey(cx, cz), section.slice());
      }
    } else {
      for (const [key, section] of v.sections) {
        const bx = chunkKeyCX(key) * CHUNK_SIZE_X + ox;
        const bz = chunkKeyCZ(key) * CHUNK_SIZE_Z + oz;
        for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
          const wz = bz + lz;
          const tcz = blockToChunk(wz);
          if (tcz < WORLD_MIN_CHUNK || tcz > WORLD_MAX_CHUNK) continue;
          const dz = wz & CHUNK_SIZE_MASK;
          for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
            const wx = bx + lx;
            const tcx = blockToChunk(wx);
            if (tcx < WORLD_MIN_CHUNK || tcx > WORLD_MAX_CHUNK) continue;
            const dst = this.ensurePlaced(tcx, tcz);
            const dx = wx & CHUNK_SIZE_MASK;
            const srcCol = lx | (lz << 5);
            const dstCol = dx | (dz << 5);
            for (let ly = 0; ly < CHUNK_HEIGHT; ly++) {
              const wy = ly + oy;
              if (wy < 0 || wy >= CHUNK_HEIGHT) continue;
              dst[dstCol | (wy << 10)] = section[srcCol | (ly << 10)];
            }
          }
        }
      }
    }

    for (const key of this.placed.keys()) this.placedKeys.push(key);
    this.placedKeys.sort((a, b) => a - b);

    for (const key of this.placedKeys) {
      const arr = this.placed.get(key) as Uint8Array;
      this.world.putChunk(chunkKeyCX(key), chunkKeyCZ(key), arr);
    }

    // Doors that start open have already been carved by `compileLevel`; the
    // rest are stamped shut, which is what the blit just wrote.
    for (let i = 0; i < this.level.doors.length; i++) {
      const d = this.level.doors[i];
      if ((d.flags & DR_START_OPEN) !== 0) {
        this.doorState[i] = DOOR_OPEN;
        this.doorT[i] = 1;
        this.doorRows[i] = d.h;
      }
    }

    this.applyPalette();
    this.wakeAlwaysEnemies();
    this.placedOnce = true;
  }

  private ensurePlaced(cx: number, cz: number): Uint8Array {
    const key = chunkKey(cx, cz);
    let arr = this.placed.get(key);
    if (arr !== undefined) return arr;
    const existing = this.world.chunkAt(cx, cz);
    arr = existing === undefined ? new Uint8Array(CHUNK_VOLUME) : existing.slice();
    this.placed.set(key, arr);
    return arr;
  }

  /**
   * Push one owned chunk back into the world if something replaced it. A server
   * still streaming generated terrain cannot win: it gets overwritten within
   * `placedKeys.length` frames, at a cost of one Map lookup per frame.
   */
  reassert(count = REASSERT_PER_UPDATE): void {
    const n = this.placedKeys.length;
    if (n === 0) return;
    for (let i = 0; i < count; i++) {
      const key = this.placedKeys[this.reassertCursor];
      this.reassertCursor = this.reassertCursor + 1 >= n ? 0 : this.reassertCursor + 1;
      const cx = chunkKeyCX(key);
      const cz = chunkKeyCZ(key);
      const mine = this.placed.get(key) as Uint8Array;
      if (this.world.chunkAt(cx, cz) !== mine) this.world.putChunk(cx, cz, mine);
    }
  }

  private applyPalette(): void {
    const p = this.palette;
    if (p === null) return;
    const m = this.level.meta;
    p.setAmbient(m.ambient, m.sunLight);
    p.setFog(m.fogColor, m.fogNear, m.fogFar);
    p.setSky(m.skyTop, m.skyHorizon, m.fogColor);
  }

  /** The player start, in world space. */
  spawn(out?: QuestSpawn): QuestSpawn {
    const s = primarySpawn(this.level);
    const o = out ?? { x: 0, y: 0, z: 0, yaw: 0 };
    o.x = s.x + this.originX;
    o.y = s.y + this.originY;
    o.z = s.z + this.originZ;
    o.yaw = s.yaw;
    return o;
  }

  /**
   * Where authored enemy `i` actually stands, in world space — after any
   * `alignSpawnTo` relocation. The mode needs this to ask the room for a body:
   * the coordinates in the level file are level-local, and a room that does not
   * know about levels has moved the whole thing onto the player.
   */
  enemyWorldPos(i: number, out: Float64Array): boolean {
    if (i < 0 || i >= this.enemyIndex.length) return false;
    const j = i * 3;
    out[0] = this.enemyPos[j];
    out[1] = this.enemyPos[j + 1];
    out[2] = this.enemyPos[j + 2];
    return true;
  }

  /** Co-op start `index`, falling back to the player start. */
  coopSpawn(index: number, out?: QuestSpawn): QuestSpawn {
    const o = out ?? { x: 0, y: 0, z: 0, yaw: 0 };
    let best: { x: number; y: number; z: number; yaw: number } | null = null;
    let seen = -1;
    for (const s of this.level.spawns) {
      if (s.kind !== SpawnKind.COOP) continue;
      seen++;
      if (seen === index) { best = s; break; }
      if (best === null) best = s;
    }
    if (best === null) return this.spawn(out);
    o.x = best.x + this.originX;
    o.y = best.y + this.originY;
    o.z = best.z + this.originZ;
    o.yaw = best.yaw;
    return o;
  }

  /* -------------------------------------------------------------------- *
   * Per-frame
   * -------------------------------------------------------------------- */

  /**
   * Advance doors, test the player against secret sectors, pickups and the
   * exit, and wake the enemies whose triggers have fired. Allocation free.
   *
   * `px/py/pz` is the player's FEET position; `py + 1` is used for volume tests
   * so a sector one block high still catches a standing marine.
   */
  update(dtSeconds: number, px: number, py: number, pz: number): void {
    if (!this.placedOnce) return;
    const dtMs = dtSeconds * 1000;

    this.stepDoors(dtMs);
    this.testSecrets(px, py, pz);
    this.testPickups(px, py, pz);
    this.testEnemyTriggers(px, py, pz);
    this.testExit(px, py, pz);
    this.reassert(REASSERT_PER_UPDATE);
  }

  private stepDoors(dtMs: number): void {
    const doors = this.level.doors;
    for (let i = 0; i < doors.length; i++) {
      const state = this.doorState[i];
      if (state === DOOR_CLOSED) continue;

      const d = doors[i];
      const openMs = d.openMs > 0 ? d.openMs : 1;

      if (state === DOOR_OPENING) {
        this.doorT[i] = Math.min(1, this.doorT[i] + dtMs / openMs);
        this.syncDoorVoxels(i);
        if (this.doorT[i] >= 1) {
          this.doorState[i] = DOOR_OPEN;
          this.doorHold[i] = d.stayMs;
        }
        continue;
      }

      if (state === DOOR_OPEN) {
        if ((d.flags & DR_AUTO_CLOSE) === 0 || d.stayMs <= 0) continue;
        this.doorHold[i] -= dtMs;
        if (this.doorHold[i] <= 0) this.doorState[i] = DOOR_CLOSING;
        continue;
      }

      // DOOR_CLOSING
      this.doorT[i] = Math.max(0, this.doorT[i] - dtMs / openMs);
      this.syncDoorVoxels(i);
      if (this.doorT[i] <= 0) this.doorState[i] = DOOR_CLOSED;
    }
  }

  /**
   * A voxel door "opens" by retracting into its own lintel: rows vanish from
   * the top down, which reads as a Doom door rising and costs one write per
   * voxel only on the frames a row actually changes.
   */
  private syncDoorVoxels(i: number): void {
    const d = this.level.doors[i];
    const b = i * 6;
    const y0 = this.doorBox[b + 1];
    const y1 = this.doorBox[b + 4];
    const height = y1 - y0 + 1;
    const want = Math.round(this.doorT[i] * height);
    const have = this.doorRows[i];
    if (want === have) return;

    const x0 = this.doorBox[b], x1 = this.doorBox[b + 3];
    const z0 = this.doorBox[b + 2], z1 = this.doorBox[b + 5];

    if (want > have) {
      for (let r = have; r < want; r++) {
        const y = y1 - r;
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) this.world.setBlock(x, y, z, BlockId.AIR);
        }
      }
    } else {
      for (let r = have - 1; r >= want; r--) {
        const y = y1 - r;
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) this.world.setBlock(x, y, z, d.block);
        }
      }
    }
    this.doorRows[i] = want;
    // Only on a frame that really moved voxels — `want === have` returned above.
    this.emit(QuestEvent.DOOR_ROWS, i, want, '');
  }

  private testSecrets(px: number, py: number, pz: number): void {
    const n = this.level.secrets.length;
    for (let i = 0; i < n; i++) {
      if (this.secretFound[i] === 1) continue;
      const b = i * 6;
      if (!insideBox(this.secretBox, b, px, py, pz)) continue;
      this.secretFound[i] = 1;
      this.secrets++;
      this.emit(QuestEvent.SECRET_FOUND, i, 0, this.level.secrets[i].message);
    }
  }

  private testPickups(px: number, py: number, pz: number): void {
    const n = this.pickupIndex.length;
    const pos = this.pickupPos;
    for (let i = 0; i < n; i++) {
      if (this.pickupTaken[i] === 1) continue;
      const j = i * 3;
      const dy = pos[j + 1] - py;
      if (dy < -1.6 || dy > 2.4) continue;
      const dx = pos[j] - px;
      const dz = pos[j + 2] - pz;
      if (dx * dx + dz * dz > this.pickupRadiusSq) continue;
      this.takePickup(i);
    }
  }

  private takePickup(i: number): void {
    this.pickupTaken[i] = 1;
    const p = this.level.pickups[this.pickupIndex[i]];
    if (this.pickupCounts[i] === 1) this.items++;
    if (p.kind === PickupKind.KEY && p.variant !== KeyColor.NONE) {
      this.keys |= keyBit(p.variant);
      this.emit(QuestEvent.KEY_TAKEN, i, p.variant, `Picked up the ${keyNameOf(p.variant).toLowerCase()} keycard.`);
      return;
    }
    this.emit(QuestEvent.ITEM_TAKEN, i, p.kind, '');
  }

  private testExit(px: number, py: number, pz: number): void {
    if (!this.hasExit || this.exitReached) return;
    if (!this.exitArmed) return;
    if (!insideBox(this.exitBox, 0, px, py, pz)) return;
    this.exitReached = true;
    this.emit(QuestEvent.EXIT_REACHED, 0, this.endsEpisode ? 1 : 0, '');
  }

  /* -------------------------------------------------------------------- *
   * Enemy triggers
   * -------------------------------------------------------------------- */

  private wakeAlwaysEnemies(): void {
    for (let i = 0; i < this.enemyIndex.length; i++) {
      const e = this.level.enemies[this.enemyIndex[i]];
      if (e.trigger === TriggerKind.ALWAYS) this.wakeEnemy(i);
    }
  }

  private wakeEnemy(i: number): void {
    if (this.enemyAwake[i] === 1 || this.enemyDead[i] === 1) return;
    this.enemyAwake[i] = 1;
    const e = this.level.enemies[this.enemyIndex[i]];
    this.emit(QuestEvent.ENEMY_WOKE, i, e.type, '');
  }

  private testEnemyTriggers(px: number, py: number, pz: number): void {
    const n = this.enemyIndex.length;
    if (n === 0) return;
    const pos = this.enemyPos;

    for (let i = 0; i < n; i++) {
      if (this.enemyAwake[i] === 1 || this.enemyDead[i] === 1) continue;
      const e = this.level.enemies[this.enemyIndex[i]];
      if (e.trigger !== TriggerKind.PROXIMITY) continue;
      const j = i * 3;
      const dx = pos[j] - px;
      const dy = pos[j + 1] - py;
      const dz = pos[j + 2] - pz;
      const r = e.triggerRadius;
      if (dx * dx + dy * dy + dz * dz <= r * r) this.wakeEnemy(i);
    }

    // Sight is the expensive one, so it is rationed: a couple of raycasts a
    // frame walks the whole roster several times a second, which is well
    // inside human reaction time and costs nothing measurable.
    for (let t = 0; t < SIGHT_TESTS_PER_UPDATE; t++) {
      const i = this.sightCursor;
      this.sightCursor = this.sightCursor + 1 >= n ? 0 : this.sightCursor + 1;
      if (this.enemyAwake[i] === 1 || this.enemyDead[i] === 1) continue;
      const e = this.level.enemies[this.enemyIndex[i]];
      if (e.trigger !== TriggerKind.SIGHT) continue;
      const j = i * 3;
      const dx = pos[j] - px;
      const dy = pos[j + 1] + 1 - (py + 1.6);
      const dz = pos[j + 2] - pz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > MAX_SIGHT_RANGE * MAX_SIGHT_RANGE) continue;
      const dist = Math.sqrt(distSq);
      if (dist < 1e-3) { this.wakeEnemy(i); continue; }
      const ok = raycastVoxels(
        px, py + 1.6, pz, dx / dist, dy / dist, dz / dist, dist - 0.5,
        this.sampleBlock, blockingSolid, this.hit,
      );
      if (!ok) this.wakeEnemy(i);
    }
  }

  /** Wake every enemy waiting on a switch or a door id. */
  private wakeByTrigger(kind: TriggerKind, id: string): void {
    for (let i = 0; i < this.enemyIndex.length; i++) {
      if (this.enemyAwake[i] === 1 || this.enemyDead[i] === 1) continue;
      const e = this.level.enemies[this.enemyIndex[i]];
      if (e.trigger === kind && e.triggerId === id) this.wakeEnemy(i);
    }
  }

  /**
   * Record a kill. When a world position is given the nearest live authored
   * placement within `radius` is the one that died, so the roster stays honest
   * even though the monster bodies belong to the sim.
   */
  notifyKill(x = NaN, y = NaN, z = NaN, radius = 6): boolean {
    const n = this.enemyIndex.length;
    if (Number.isFinite(x)) {
      let best = -1;
      let bestD = radius * radius;
      for (let i = 0; i < n; i++) {
        if (this.enemyDead[i] === 1) continue;
        const j = i * 3;
        const dx = this.enemyPos[j] - x;
        const dy = this.enemyPos[j + 1] - y;
        const dz = this.enemyPos[j + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        this.enemyDead[best] = 1;
        if (this.enemyCounts[best] === 1 && this.kills < this.totals.enemies) this.kills++;
        return true;
      }
    }
    // No match: still count it, capped at the authored total so the
    // intermission can never read over 100%.
    if (this.kills < this.totals.enemies) { this.kills++; return true; }
    return false;
  }

  /* -------------------------------------------------------------------- *
   * Use — switches and doors
   * -------------------------------------------------------------------- */

  /**
   * The USE verb. Casts up to `REACH_INTERACT` metres from the eye and acts on
   * whatever it lands on: a switch anchor, or any voxel inside a door volume.
   * Returns one of the `USE_*` codes.
   */
  use(
    eyeX: number, eyeY: number, eyeZ: number,
    dirX: number, dirY: number, dirZ: number,
  ): number {
    if (!raycastVoxels(
      eyeX, eyeY, eyeZ, dirX, dirY, dirZ, REACH_INTERACT,
      this.sampleBlock, blockingSolid, this.hit,
    )) return USE_NOTHING;

    const hx = this.hit.x, hy = this.hit.y, hz = this.hit.z;
    let r = this.useAt(hx, hy, hz);
    if (r !== USE_NOTHING) return r;

    // A door's frame trim is what you are usually looking at; probe one voxel
    // further along the ray so aiming at the seam still works.
    r = this.useAt(hx - this.hit.nx, hy - this.hit.ny, hz - this.hit.nz);
    return r;
  }

  /** Act on one specific block. Exposed so a test can drive the script. */
  useAt(x: number, y: number, z: number): number {
    for (let i = 0; i < this.level.switches.length; i++) {
      if (this.switchPos[i * 3] !== x) continue;
      if (this.switchPos[i * 3 + 1] !== y) continue;
      if (this.switchPos[i * 3 + 2] !== z) continue;
      return this.throwSwitch(i);
    }
    for (let i = 0; i < this.level.doors.length; i++) {
      const b = i * 6;
      if (x < this.doorBox[b] || x > this.doorBox[b + 3]) continue;
      if (y < this.doorBox[b + 1] || y > this.doorBox[b + 4]) continue;
      if (z < this.doorBox[b + 2] || z > this.doorBox[b + 5]) continue;
      return this.openDoor(i);
    }
    return USE_NOTHING;
  }

  /** Throw a switch by id. Returns a `USE_*` code. */
  throwSwitchId(id: string): number {
    for (let i = 0; i < this.level.switches.length; i++) {
      if (this.level.switches[i].id === id) return this.throwSwitch(i);
    }
    return USE_NOTHING;
  }

  private throwSwitch(i: number): number {
    const s = this.level.switches[i];
    if (this.switchThrown[i] === 1 && (s.flags & SW_ONCE) !== 0) return USE_ALREADY;
    if (!hasKey(this.keys, s.key)) {
      this.emit(QuestEvent.DOOR_LOCKED, -1, s.key,
        `The panel is locked. You need the ${keyNameOf(s.key).toLowerCase()} keycard.`);
      return USE_DOOR_LOCKED;
    }

    this.switchThrown[i] = 1;
    this.world.setBlock(this.switchPos[i * 3], this.switchPos[i * 3 + 1], this.switchPos[i * 3 + 2], s.activeBlock);
    this.emit(QuestEvent.SWITCH_THROWN, i, 0, s.message);

    for (const target of s.targets) {
      if (target === 'exit') {
        if (!this.exitArmed) {
          this.exitArmed = true;
          this.emit(QuestEvent.EXIT_ARMED, i, 0, '');
        }
        continue;
      }
      for (let d = 0; d < this.level.doors.length; d++) {
        if (this.level.doors[d].id !== target) continue;
        this.doorReleased[d] = 1;
        this.openDoor(d, true);
      }
    }
    this.wakeByTrigger(TriggerKind.SWITCH, s.id);
    return USE_SWITCH;
  }

  /**
   * Try to open a door. `bySwitch` bypasses the DR_SWITCH_ONLY check because a
   * switch has already granted permission.
   */
  openDoor(i: number, bySwitch = false): number {
    const d = this.level.doors[i];
    const state = this.doorState[i];
    if (state === DOOR_OPEN || state === DOOR_OPENING) return USE_ALREADY;

    if (!bySwitch) {
      if ((d.flags & DR_SWITCH_ONLY) !== 0 && this.doorReleased[i] === 0) {
        // A secret door reads as ordinary wall: say nothing at all.
        return USE_NOTHING;
      }
      if (!hasKey(this.keys, d.key)) {
        const msg = d.lockedMessage.length > 0
          ? d.lockedMessage
          : `You need the ${keyNameOf(d.key).toLowerCase()} keycard.`;
        this.emit(QuestEvent.DOOR_LOCKED, i, d.key, msg);
        return USE_DOOR_LOCKED;
      }
    }

    this.doorState[i] = DOOR_OPENING;
    this.emit(QuestEvent.DOOR_OPENED, i, d.key, '');
    this.wakeByTrigger(TriggerKind.DOOR, d.id);
    return USE_DOOR_OPENED;
  }

  /** True when this door would open for the keys currently held. */
  canOpenDoor(i: number): boolean {
    const d = this.level.doors[i];
    if ((d.flags & DR_SWITCH_ONLY) !== 0) return this.doorReleased[i] === 1;
    return hasKey(this.keys, d.key);
  }

  /* -------------------------------------------------------------------- *
   * Introspection — the HUD, the intermission and the tests read these
   * -------------------------------------------------------------------- */

  get placedChunkCount(): number { return this.placedKeys.length; }
  get doorCount(): number { return this.level.doors.length; }
  get switchCount(): number { return this.level.switches.length; }
  get enemyCount(): number { return this.enemyIndex.length; }
  get pickupCount(): number { return this.pickupIndex.length; }

  /**
   * The authored record behind live pickup `i`, or null. Returned by reference
   * so the caller can read `kind`, `variant` and `amount` without allocating —
   * that is how `quest.ts` turns a collected pickup into ammo.
   */
  pickupAt(i: number): LevelPickup | null {
    if (i < 0 || i >= this.pickupIndex.length) return null;
    return this.level.pickups[this.pickupIndex[i]];
  }

  doorStateOf(i: number): number { return this.doorState[i]; }
  switchThrownAt(i: number): boolean { return this.switchThrown[i] === 1; }
  secretFoundAt(i: number): boolean { return this.secretFound[i] === 1; }
  pickupTakenAt(i: number): boolean { return this.pickupTaken[i] === 1; }
  enemyAwakeAt(i: number): boolean { return this.enemyAwake[i] === 1; }
  enemyDeadAt(i: number): boolean { return this.enemyDead[i] === 1; }
  hasKeyColor(color: number): boolean { return hasKey(this.keys, color); }

  /** Keycard colours this level actually contains, for the HUD's key row. */
  keyColoursPresent(): number {
    let mask = 0;
    for (let i = 0; i < this.pickupIndex.length; i++) {
      const p = this.level.pickups[this.pickupIndex[i]];
      if (p.kind === PickupKind.KEY) mask |= keyBit(p.variant);
    }
    for (const d of this.level.doors) mask |= keyBit(d.key);
    return mask;
  }

  /**
   * The single line the HUD shows as the current objective. Deliberately
   * derived rather than authored: it can never drift from the level graph.
   */
  objective(): string {
    if (this.exitReached) return 'LEVEL COMPLETE';
    if (this.exitArmed || !this.needsExitSwitch()) return 'REACH THE EXIT';

    // Name the first key a locked door still wants and we do not hold.
    for (const d of this.level.doors) {
      if (d.key === KeyColor.NONE) continue;
      if (hasKey(this.keys, d.key)) continue;
      return `FIND THE ${keyNameOf(d.key).toUpperCase()} KEYCARD`;
    }
    return 'FIND THE EXIT SWITCH';
  }

  private needsExitSwitch(): boolean {
    const e = this.level.exit;
    return e !== null && e.requiresSwitch.length > 0;
  }

  /* -------------------------------------------------------------------- *
   * Restart
   * -------------------------------------------------------------------- */

  /**
   * Put the level back exactly as it was authored — Doom's death behaviour, and
   * the CHECKPOINT respawn policy from the mode table. Re-blits the geometry,
   * so every door is shut and every switch is cold again.
   */
  reset(): void {
    this.keys = 0;
    this.kills = 0;
    this.items = 0;
    this.secrets = 0;
    this.exitArmed = false;
    this.exitReached = false;
    this.doorState.fill(DOOR_CLOSED);
    this.doorT.fill(0);
    this.doorRows.fill(0);
    this.doorHold.fill(0);
    this.doorReleased.fill(0);
    this.switchThrown.fill(0);
    this.secretFound.fill(0);
    this.pickupTaken.fill(0);
    this.enemyAwake.fill(0);
    this.enemyDead.fill(0);
    this.sightCursor = 0;
    this.place();
  }

  /** Drop the owned chunk copies. The world keeps whatever is in it. */
  dispose(): void {
    this.placed.clear();
    this.placedKeys.length = 0;
    this.placedOnce = false;
  }
}

/* ------------------------------------------------------------------------ *
 * The ammo economy
 *
 * docs/MODES.md §1 lists "ammo starvation as pacing — you are always slightly
 * short, which forces weapon rotation" as one of the things E1M1 does that we
 * must match, and it is the one that decides whether a Quest level is a level
 * or a corridor with decorations in it. The default sandbox loadout is the
 * opposite of that: it hands out all seven weapons and 120 bullets, 24 shells,
 * 8 rockets and 120 cells on every spawn, which makes every ammo box in every
 * level noise.
 *
 * So Quest runs Doom's economy instead. You start with a pistol, a chainsaw and
 * fifty rounds; every other weapon is a pickup lying in the level; and the box
 * of shells behind the blue door is the reason you go through the blue door.
 *
 * The numbers below are Doom's, and the *authored* `amount` on a pickup always
 * wins over them — a level file can hand out a 40-round box where the default
 * clip is 10 without touching code. `SKILL_PICKUP_SCALE` doubles ammo on
 * I'm Too Young To Die exactly as Doom does.
 *
 * This lives here, not in `quest.ts`, for one reason: no DOM and no `three`, so
 * `quest.test.ts` can assert the whole campaign's economy against the monster
 * roster it ships. It is pure and it allocates only the message string.
 * ------------------------------------------------------------------------ */

/** Rounds in the pistol on the first frame of a campaign. Doom's number. */
export const QUEST_START_BULLETS = 50;

/** Default rounds per ammo pickup when the level does not say, by AmmoType. */
const AMMO_DEFAULT: readonly number[] = [0, 10, 4, 1, 20];
/** Rounds bundled with a weapon pickup, indexed by WeaponId. */
const WEAPON_BUNDLE: readonly number[] = [20, 8, 20, 2, 40, 40, 0];
/** Doom's backpack: one clip of everything. Indexed by AmmoType. */
const BACKPACK: readonly number[] = [0, 10, 4, 1, 20];
/** Health per variant: bonus, stimpack, medikit, soulsphere. */
const HEALTH_AMOUNT: readonly number[] = [1, 10, 25, 100];
/** Armour per variant: bonus, green, blue. */
const ARMOR_AMOUNT: readonly number[] = [1, 100, 200];

const HEALTH_LINE: readonly string[] = [
  'Picked up a health bonus.',
  'Picked up a stimpack.',
  'Picked up a medikit.',
  'Supercharge!',
];
const ARMOR_LINE: readonly string[] = [
  'Picked up an armour bonus.',
  'Picked up the armour.',
  'Picked up the megaarmour!',
];
const AMMO_LINE: readonly string[] = ['', 'bullets', 'shells', 'rockets', 'cells'];

/**
 * What one pickup is worth. `ammo` is indexed by `AmmoType` and is refilled in
 * place, so a caller keeps one of these for the whole level and never allocates
 * on the collection path.
 */
export interface QuestPickupGrant {
  /** Rounds to add, indexed by AmmoType. Index 0 is always zero. */
  readonly ammo: Int32Array;
  /** WeaponId to grant, or -1. */
  weapon: number;
  /** Health points. The SERVER owns health, so this is advisory — see below. */
  health: number;
  /** Armour points. Server-owned in the same way. */
  armor: number;
  /** KeyColor, or `KeyColor.NONE`. */
  key: number;
  /** Doom's pickup line, or '' for a pickup that says nothing. */
  message: string;
  /** True when this is worth a centre-screen call-out rather than a log line. */
  loud: boolean;
}

export function createPickupGrant(): QuestPickupGrant {
  return {
    ammo: new Int32Array(AMMO_TYPE_COUNT),
    weapon: -1, health: 0, armor: 0, key: KeyColor.NONE, message: '', loud: false,
  };
}

/**
 * Price one pickup, at one skill, into `out`. Total: an unknown kind or a
 * nonsense variant yields an empty grant rather than throwing, because a level
 * file is content and content is allowed to be wrong.
 */
export function fillPickupGrant(p: LevelPickup, skill: Skill, out: QuestPickupGrant): QuestPickupGrant {
  out.ammo.fill(0);
  out.weapon = -1;
  out.health = 0;
  out.armor = 0;
  out.key = KeyColor.NONE;
  out.message = '';
  out.loud = false;

  const scale = SKILL_PICKUP_SCALE[clampSkill(skill)];

  switch (p.kind) {
    case PickupKind.AMMO: {
      const type = p.variant >= 1 && p.variant < AMMO_TYPE_COUNT ? p.variant : AmmoType.BULLETS;
      const base = p.amount > 0 ? p.amount : AMMO_DEFAULT[type];
      const n = Math.max(1, Math.round(base * scale));
      out.ammo[type] = n;
      out.message = `Picked up ${n} ${AMMO_LINE[type]}.`;
      return out;
    }

    case PickupKind.WEAPON: {
      const id = p.variant >= 0 && p.variant < WEAPON_BUNDLE.length ? p.variant : WeaponId.SHOTGUN;
      out.weapon = id;
      const type = ammoTypeOf(id);
      const base = p.amount > 0 ? p.amount : WEAPON_BUNDLE[id];
      if (type !== AmmoType.NONE && base > 0) out.ammo[type] = Math.max(1, Math.round(base * scale));
      out.message = `You got the ${WEAPONS[id].name.toLowerCase()}!`;
      out.loud = true;
      return out;
    }

    case PickupKind.BACKPACK: {
      for (let t = 1; t < AMMO_TYPE_COUNT; t++) {
        out.ammo[t] = Math.max(1, Math.round((p.amount > 0 ? p.amount : BACKPACK[t]) * scale));
      }
      out.message = 'Picked up a backpack full of ammo!';
      out.loud = true;
      return out;
    }

    case PickupKind.HEALTH: {
      const v = p.variant >= 0 && p.variant < HEALTH_AMOUNT.length ? p.variant : 1;
      out.health = p.amount > 0 ? p.amount : HEALTH_AMOUNT[v];
      out.message = HEALTH_LINE[v];
      out.loud = v === 3;
      return out;
    }

    case PickupKind.ARMOR: {
      const v = p.variant >= 0 && p.variant < ARMOR_AMOUNT.length ? p.variant : 1;
      out.armor = p.amount > 0 ? p.amount : ARMOR_AMOUNT[v];
      out.message = ARMOR_LINE[v];
      out.loud = v === 2;
      return out;
    }

    case PickupKind.KEY: {
      out.key = p.variant;
      out.message = `Picked up the ${keyNameOf(p.variant).toLowerCase()} keycard.`;
      out.loud = true;
      return out;
    }

    default:
      return out;
  }
}

/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

function blockingSolid(id: number): boolean {
  return BLOCK_SOLID[id] === 1;
}

/**
 * Point-in-box with a marine-sized fudge: the sector must catch a player whose
 * feet are on its floor and whose head is a block and a half above it, which is
 * how Doom's sector triggers behave.
 */
function insideBox(box: Int32Array, base: number, x: number, y: number, z: number): boolean {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  if (fx < box[base] || fx > box[base + 3]) return false;
  if (fz < box[base + 2] || fz > box[base + 5]) return false;
  const fy = Math.floor(y);
  return fy >= box[base + 1] - 1 && fy <= box[base + 4] + 1;
}

/** Convenience for callers that only have a `Level` and want its key colours. */
export function levelKeyMask(level: Level): number {
  let mask = 0;
  for (const p of level.pickups) if (p.kind === PickupKind.KEY) mask |= keyBit(p.variant);
  for (const d of level.doors) mask |= keyBit(d.key);
  return mask;
}

/** Total voxels the level will write, for a loading progress bar. */
export function levelVoxelCount(level: Level): number {
  return level.volume.chunkCount * CHUNK_VOLUME;
}
