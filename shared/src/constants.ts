/**
 * DOOMCRAFT — shared constants.
 *
 * Every number that BOTH the client and the server must agree on lives here.
 * Nothing in this file allocates; everything is a primitive or a frozen typed array.
 *
 * Design note (see ref/BAR.md "Where the bar is weak" #1): voxiom.io moves at
 * Minecraft speed (~4.3 m/s). Doomcraft runs at 9.5 m/s with a ~0.1 s acceleration
 * ramp and a full-block step-up, which is roughly 2.2x the bar with no ramp felt.
 */

/* ------------------------------------------------------------------------ *
 * Chunk / world geometry
 * ------------------------------------------------------------------------ */

/** Horizontal chunk edge, in blocks (x and z). */
export const CHUNK_SIZE = 32;
export const CHUNK_SIZE_X = 32;
export const CHUNK_SIZE_Z = 32;
/** Vertical chunk extent, in blocks. Chunks are full-height columns. */
export const CHUNK_HEIGHT = 64;

export const CHUNK_SIZE_BITS = 5;
export const CHUNK_SIZE_MASK = 31;
export const CHUNK_HEIGHT_BITS = 6;
export const CHUNK_HEIGHT_MASK = 63;

/** 32 * 32 = 1024 */
export const CHUNK_AREA = CHUNK_SIZE_X * CHUNK_SIZE_Z;
/** 32 * 32 * 64 = 65536 — one Uint8Array per chunk, index fits in a Uint16. */
export const CHUNK_VOLUME = CHUNK_AREA * CHUNK_HEIGHT;

/**
 * Voxel storage order — LOCKED. Every mesher, worldgen pass, RLE encoder and
 * raycast in the project must use this and only this.
 *
 *   index = x | (z << 5) | (y << 10)
 *
 * i.e. x fastest, then z, then y. Y-major means a horizontal slab is contiguous,
 * which is what the greedy mesher sweeps.
 */
export function voxelIndex(x: number, y: number, z: number): number {
  return (x | (z << CHUNK_SIZE_BITS) | (y << (CHUNK_SIZE_BITS + CHUNK_SIZE_BITS))) >>> 0;
}
export function voxelIndexX(i: number): number { return i & CHUNK_SIZE_MASK; }
export function voxelIndexZ(i: number): number { return (i >>> CHUNK_SIZE_BITS) & CHUNK_SIZE_MASK; }
export function voxelIndexY(i: number): number { return (i >>> (CHUNK_SIZE_BITS + CHUNK_SIZE_BITS)) & CHUNK_HEIGHT_MASK; }

/** True when a local coordinate triple is inside a chunk. */
export function inChunkBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < CHUNK_SIZE_X && z >= 0 && z < CHUNK_SIZE_Z && y >= 0 && y < CHUNK_HEIGHT;
}

/** World block coord -> chunk coord (works for negatives). */
export function blockToChunk(v: number): number { return v >> CHUNK_SIZE_BITS; }
/** World block coord -> local coord inside its chunk (works for negatives). */
export function blockToLocal(v: number): number { return v & CHUNK_SIZE_MASK; }
/** Continuous world coord -> integer block coord. */
export function worldToBlock(v: number): number { return Math.floor(v); }

/**
 * Chunk coordinates packed into one int32 so Map<number, Chunk> beats Map<string, Chunk>.
 * Valid for cx, cz in [-1024, 1023].
 */
export const CHUNK_KEY_BIAS = 1024;
export const CHUNK_KEY_SHIFT = 11;
export const CHUNK_KEY_MASK = 2047;
export function chunkKey(cx: number, cz: number): number {
  return (((cx + CHUNK_KEY_BIAS) << CHUNK_KEY_SHIFT) | (cz + CHUNK_KEY_BIAS)) >>> 0;
}
export function chunkKeyCX(key: number): number { return (key >>> CHUNK_KEY_SHIFT) - CHUNK_KEY_BIAS; }
export function chunkKeyCZ(key: number): number { return (key & CHUNK_KEY_MASK) - CHUNK_KEY_BIAS; }

/** World is a square of chunks centred on chunk (0,0). */
export const WORLD_RADIUS_CHUNKS = 6;
export const WORLD_CHUNKS_PER_AXIS = WORLD_RADIUS_CHUNKS * 2 + 1;      // 13
export const WORLD_CHUNK_COUNT = WORLD_CHUNKS_PER_AXIS * WORLD_CHUNKS_PER_AXIS; // 169
export const WORLD_MIN_CHUNK = -WORLD_RADIUS_CHUNKS;                    // -6
export const WORLD_MAX_CHUNK = WORLD_RADIUS_CHUNKS;                     //  6
export const WORLD_MIN_BLOCK_X = WORLD_MIN_CHUNK * CHUNK_SIZE_X;        // -192
export const WORLD_MAX_BLOCK_X = WORLD_MAX_CHUNK * CHUNK_SIZE_X + CHUNK_SIZE_X - 1; // 223
export const WORLD_MIN_BLOCK_Z = WORLD_MIN_BLOCK_X;
export const WORLD_MAX_BLOCK_Z = WORLD_MAX_BLOCK_X;
export const WORLD_SIZE_BLOCKS = WORLD_CHUNKS_PER_AXIS * CHUNK_SIZE_X;  // 416

export function chunkInWorld(cx: number, cz: number): boolean {
  return cx >= WORLD_MIN_CHUNK && cx <= WORLD_MAX_CHUNK && cz >= WORLD_MIN_CHUNK && cz <= WORLD_MAX_CHUNK;
}
export function blockInWorld(x: number, y: number, z: number): boolean {
  return y >= 0 && y < CHUNK_HEIGHT &&
    x >= WORLD_MIN_BLOCK_X && x <= WORLD_MAX_BLOCK_X &&
    z >= WORLD_MIN_BLOCK_Z && z <= WORLD_MAX_BLOCK_Z;
}

/* ------------------------------------------------------------------------ *
 * Terrain shape (worldgen lives on the server, but both sides need the bands)
 * ------------------------------------------------------------------------ */

export const BEDROCK_LEVEL = 0;
export const SEA_LEVEL = 26;
export const TERRAIN_MIN_HEIGHT = 10;
export const TERRAIN_MAX_HEIGHT = 54;
/** Blocks of dirt/sand under the surface block before stone takes over. */
export const SOIL_DEPTH = 4;
/** Base horizontal frequency of the continent-scale fbm, in 1/blocks. */
export const TERRAIN_FREQ = 1 / 190;
export const TERRAIN_OCTAVES = 5;
export const TERRAIN_LACUNARITY = 2.03;
export const TERRAIN_GAIN = 0.5;
/** Frequency of the roughness layer that carves cliffs and ridges. */
export const TERRAIN_DETAIL_FREQ = 1 / 42;
/** Chance per surface column that a tree is rooted there (grass biomes). */
export const TREE_DENSITY = 0.012;
/** Chance per surface column of a hell-vent (lava pocket + hellstone). */
export const VENT_DENSITY = 0.0016;

/* ------------------------------------------------------------------------ *
 * Simulation timing
 * ------------------------------------------------------------------------ */

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;    // 50
export const TICK_DT = 1 / TICK_HZ;       // 0.05
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;

/** Client sends at most this many input packets per second. */
export const INPUT_SEND_HZ = 60;
export const INPUT_SEND_MS = 1000 / INPUT_SEND_HZ;
/** How far behind the newest snapshot remote entities are rendered. Two snapshots. */
export const INTERP_DELAY_MS = 100;
/** Never extrapolate a remote entity further than this past its last snapshot. */
export const MAX_EXTRAPOLATE_MS = 220;
/** Ring size of snapshots the server keeps per client for delta baselines. */
export const SNAPSHOT_HISTORY = 32;
/** Ring size of predicted client states kept for reconciliation. */
export const PREDICTION_HISTORY = 128;
/** Server rewinds hitboxes at most this far for lag compensation. */
export const LAG_COMP_MAX_MS = 250;
export const LAG_COMP_MAX_TICKS = 5;
/** Physics substep cap so a long frame cannot tunnel the player through a wall. */
export const MAX_SUBSTEP_DT = 1 / 120;
export const MAX_FRAME_DT = 0.1;

export const HEARTBEAT_MS = 1000;
export const CLIENT_TIMEOUT_MS = 15000;
export const RECONNECT_BACKOFF_MS = 1200;

/* ------------------------------------------------------------------------ *
 * Server / session limits
 * ------------------------------------------------------------------------ */

export const MAX_PLAYERS = 32;
export const MAX_ENTITIES = 256;
export const MAX_PROJECTILES = 256;
export const MAX_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 120;
export const MAX_BLOCK_DELTAS_PER_MESSAGE = 512;
export const MAX_EDITS_PER_SECOND = 20;
export const DEFAULT_SERVER_PORT = 8080;
export const WS_PATH = '/ws';
/** Bots the server fills a match with so play starts instantly (bar weakness #5). */
export const BOT_FILL_TARGET = 6;
export const BOT_SPAWN_DELAY_MS = 400;

export enum GameMode {
  DEATHMATCH = 0,
  HORDE = 1,
  SANDBOX = 2,
}
export const GAME_MODE_NAMES: readonly string[] = ['Deathmatch', 'Horde', 'Sandbox'];
export const DEFAULT_GAME_MODE = GameMode.DEATHMATCH;
export const MATCH_DURATION_MS = 8 * 60 * 1000;
export const SCORE_LIMIT = 30;

/* ------------------------------------------------------------------------ *
 * Player body + movement (DOOM pace)
 * ------------------------------------------------------------------------ */

export const PLAYER_WIDTH = 0.6;
export const PLAYER_DEPTH = 0.6;
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_CROUCH_HEIGHT = 1.15;
/** Feet-relative camera height. */
export const PLAYER_EYE_HEIGHT = 1.62;
export const PLAYER_EYE_HEIGHT_CROUCH = 0.98;
/** Head hitbox: a box from PLAYER_HEAD_MIN_Y to PLAYER_HEIGHT, used for headshots. */
export const PLAYER_HEAD_MIN_Y = 1.42;
export const PLAYER_HEAD_HALF_WIDTH = 0.22;
/** Skin width kept between the AABB and any solid face after a sweep resolve. */
export const COLLIDE_EPSILON = 1e-3;

export const GRAVITY = 28.0;              // m/s^2 — snappier than Minecraft's ~32 arc, no float
export const TERMINAL_VELOCITY = 78.0;    // m/s

export const SPEED_RUN = 9.5;             // m/s — the headline number
export const SPEED_SPRINT = 12.6;
export const SPEED_CROUCH = 4.2;
export const SPEED_SWIM = 4.6;
export const SPEED_AIR_MAX = 9.5;

export const ACCEL_GROUND = 95.0;         // reaches SPEED_RUN in ~0.10 s: two ticks, reads as instant
export const ACCEL_AIR = 34.0;
export const FRICTION_GROUND = 16.0;
export const FRICTION_AIR = 0.0;
/** Fraction of ground steering authority retained mid-air. */
export const AIR_CONTROL = 0.55;

export const JUMP_VELOCITY = 8.9;         // apex ~1.41 m under GRAVITY: clears a block with headroom
export const JUMP_COOLDOWN_MS = 110;
export const COYOTE_TIME_MS = 90;
export const JUMP_BUFFER_MS = 110;
/**
 * Auto step-up height. 1.05 m means you run up single blocks without jumping —
 * a deliberate break from the bar (Minecraft/voxiom use 0.6) so the pace never stalls.
 */
export const STEP_HEIGHT = 1.05;
export const STEP_MAX_SPEED_SCALE = 1.0;

export const WATER_GRAVITY_SCALE = 0.32;
export const WATER_DRAG = 4.2;
export const WATER_JUMP_VELOCITY = 4.6;
export const SWIM_UP_SPEED = 4.0;

export const FALL_DAMAGE_MIN_SPEED = 19.0;   // m/s downward before it hurts
export const FALL_DAMAGE_PER_MPS = 3.4;
export const FALL_DAMAGE_MAX = 100;

/** Viewmodel/camera bob amplitude at SPEED_RUN, metres. */
export const VIEW_BOB_AMPLITUDE = 0.035;
export const VIEW_BOB_HZ = 2.05;
export const LAND_DIP_MAX = 0.16;

/* ------------------------------------------------------------------------ *
 * Combat
 * ------------------------------------------------------------------------ */

export const MAX_HEALTH = 100;
export const MAX_ARMOR = 100;
/** Health pickups can push you over MAX_HEALTH up to here (Doom soulsphere rule). */
export const MAX_OVERHEAL = 200;
/** Fraction of incoming damage armour eats while it lasts (Doom green armour). */
export const ARMOR_ABSORB = 0.33;
export const HEADSHOT_MULTIPLIER = 2.0;
export const RESPAWN_DELAY_MS = 1400;
export const SPAWN_PROTECTION_MS = 1200;
export const HITSCAN_MAX_DISTANCE = 220;
export const KNOCKBACK_SCALE = 0.055;      // m/s of impulse per point of damage
export const SELF_KNOCKBACK_SCALE = 0.085; // rocket jumping

export const REACH_BREAK = 6.0;
export const REACH_PLACE = 6.0;
export const REACH_INTERACT = 4.0;
/** Milliseconds to break a block of hardness 1.0 with the default tool. */
export const BLOCK_BREAK_BASE_MS = 220;
export const BLOCK_PLACE_COOLDOWN_MS = 110;

export const LAVA_DAMAGE_PER_SEC = 22;
export const DROWN_DAMAGE_PER_SEC = 6;
export const BREATH_SECONDS = 14;
export const HEALTH_REGEN_DELAY_MS = 6000;
export const HEALTH_REGEN_PER_SEC = 0;     // Doom does not regen; pickups only

/* ------------------------------------------------------------------------ *
 * Rendering budget (the measurable half of the bar)
 * ------------------------------------------------------------------------ */

export const TARGET_FPS = 60;
export const TARGET_FRAME_MS = 1000 / TARGET_FPS;
export const TARGET_ONE_PCT_LOW_FPS = 55;
/** Hard interactive budget, ms. voxiom.io measured 3161 ms; we must beat it. */
export const TIME_TO_INTERACTIVE_BUDGET_MS = 3000;

export const RENDER_DISTANCE_CHUNKS_DESKTOP = 6;
export const RENDER_DISTANCE_CHUNKS_MOBILE = 4;
export const RENDER_DISTANCE_MIN = 2;
export const RENDER_DISTANCE_MAX = 8;
/** Wall-clock the main thread may spend uploading finished chunk meshes per frame. */
export const MESH_UPLOAD_BUDGET_MS = 3.0;
export const MAX_MESH_UPLOADS_PER_FRAME = 2;
/** Chunk mesh jobs allowed in flight in the worker pool. */
export const MESH_JOBS_IN_FLIGHT = 4;

export const FOV_DEFAULT = 90;
export const FOV_MIN = 70;
export const FOV_MAX = 110;
/** Extra FOV added at SPEED_SPRINT — the speed cue Doom sells pace with. */
export const FOV_SPRINT_BONUS = 8;
export const NEAR_PLANE = 0.06;
export const FAR_PLANE = 420;

/** Packed 0xRRGGBB. Sky is flatter and colder than the bar's, so fog reads. */
export const SKY_COLOR = 0x6ea9e0;
export const SKY_HORIZON_COLOR = 0x9fc9ef;
export const FOG_COLOR = 0x8bb6dd;
/** Fog begins at this fraction of the render distance and is full at 1.0. */
export const FOG_NEAR_FRAC = 0.55;
export const FOG_FAR_FRAC = 0.98;
/** Bar weakness #4: voxiom has no AO and the beach reads as one mass. */
export const AO_STRENGTH = 0.42;
/** Normalised sun direction, world space, pointing FROM the sun TO the scene. */
export const SUN_DIR_X = -0.42;
export const SUN_DIR_Y = -0.82;
export const SUN_DIR_Z = -0.39;
export const AMBIENT_LIGHT = 0.46;
export const SUN_LIGHT = 0.62;
export const HURT_FLASH_COLOR = 0xb01010;
export const PICKUP_FLASH_COLOR = 0xf0d060;

/* ------------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------------ */

export enum InputAction {
  MoveForward = 'moveForward',
  MoveBack = 'moveBack',
  MoveLeft = 'moveLeft',
  MoveRight = 'moveRight',
  Jump = 'jump',
  Crouch = 'crouch',
  Sprint = 'sprint',
  Fire = 'fire',
  AltFire = 'altFire',
  Reload = 'reload',
  Use = 'use',
  Melee = 'melee',
  BuildMode = 'buildMode',
  NextWeapon = 'nextWeapon',
  PrevWeapon = 'prevWeapon',
  Slot1 = 'slot1',
  Slot2 = 'slot2',
  Slot3 = 'slot3',
  Slot4 = 'slot4',
  Slot5 = 'slot5',
  Slot6 = 'slot6',
  Slot7 = 'slot7',
  Chat = 'chat',
  Scoreboard = 'scoreboard',
  Map = 'map',
  Menu = 'menu',
}

/** Values are KeyboardEvent.code, or 'Mouse0'/'Mouse1'/'Mouse2', or 'WheelUp'/'WheelDown'. */
export const DEFAULT_KEYBINDS: Readonly<Record<InputAction, string>> = Object.freeze({
  [InputAction.MoveForward]: 'KeyW',
  [InputAction.MoveBack]: 'KeyS',
  [InputAction.MoveLeft]: 'KeyA',
  [InputAction.MoveRight]: 'KeyD',
  [InputAction.Jump]: 'Space',
  [InputAction.Crouch]: 'KeyC',
  [InputAction.Sprint]: 'ShiftLeft',
  [InputAction.Fire]: 'Mouse0',
  [InputAction.AltFire]: 'Mouse2',
  [InputAction.Reload]: 'KeyR',
  [InputAction.Use]: 'KeyE',
  [InputAction.Melee]: 'KeyV',
  [InputAction.BuildMode]: 'KeyB',
  [InputAction.NextWeapon]: 'WheelDown',
  [InputAction.PrevWeapon]: 'WheelUp',
  [InputAction.Slot1]: 'Digit1',
  [InputAction.Slot2]: 'Digit2',
  [InputAction.Slot3]: 'Digit3',
  [InputAction.Slot4]: 'Digit4',
  [InputAction.Slot5]: 'Digit5',
  [InputAction.Slot6]: 'Digit6',
  [InputAction.Slot7]: 'Digit7',
  [InputAction.Chat]: 'Enter',
  [InputAction.Scoreboard]: 'Tab',
  [InputAction.Map]: 'KeyM',
  [InputAction.Menu]: 'Escape',
});

/** Radians of yaw per pixel of mouse movement at sensitivity 1.0. */
export const MOUSE_RADIANS_PER_PIXEL = 0.0022;
export const TOUCH_RADIANS_PER_PIXEL = 0.0042;
export const SENSITIVITY_MIN = 0.1;
export const SENSITIVITY_MAX = 5.0;
export const PITCH_LIMIT = Math.PI / 2 - 0.001;

/* ------------------------------------------------------------------------ *
 * UI / DOM contract (client/index.html owns these ids)
 * ------------------------------------------------------------------------ */

export const DOM_CANVAS_ID = 'game';
export const DOM_HUD_ID = 'hud';
export const DOM_UI_ID = 'ui';
export const DOM_ADS_ID = 'ads';
export const DOM_BOOT_ID = 'boot';
export const DOM_BOOT_BAR_ID = 'boot-bar';
export const DOM_BOOT_PCT_ID = 'boot-pct';
export const DOM_BOOT_STATUS_ID = 'boot-status';

/* ------------------------------------------------------------------------ *
 * Monetisation — three reserved slots, zero layout shift (bar's ads are layout)
 * ------------------------------------------------------------------------ */

export const AD_SLOT_TOP = 'ad-slot-top';
export const AD_SLOT_SIDE = 'ad-slot-side';
export const AD_SLOT_BOTTOM = 'ad-slot-bottom';
export const AD_SLOT_IDS: readonly string[] = Object.freeze([AD_SLOT_TOP, AD_SLOT_SIDE, AD_SLOT_BOTTOM]);
/** [desktopW, desktopH, mobileW, mobileH] per slot, in CSS px. Must match index.html. */
export const AD_SLOT_SIZES: Readonly<Record<string, readonly [number, number, number, number]>> = Object.freeze({
  [AD_SLOT_TOP]: [728, 90, 320, 50],
  [AD_SLOT_SIDE]: [300, 250, 300, 250],
  [AD_SLOT_BOTTOM]: [728, 90, 320, 100],
});
export const AD_OVERLAY_ID = 'ad-overlay';
export const AD_INTERSTITIAL_MIN_INTERVAL_MS = 180_000;
export const AD_INTERSTITIAL_AFTER_DEATHS = 3;
export const AD_INTERSTITIAL_MAX_SECONDS = 15;
export const AD_REWARD_ARMOR = 50;
export const IAP_PRODUCT_REMOVE_ADS = 'doomcraft.remove_ads';
export const IAP_PRICE_USD = 4.99;

/* ------------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------------ */

export const STORAGE_PREFIX = 'doomcraft:';
export const STORAGE_KEYS = Object.freeze({
  settings: STORAGE_PREFIX + 'settings',
  progress: STORAGE_PREFIX + 'progress',
  purchase: STORAGE_PREFIX + 'purchase',
  bindings: STORAGE_PREFIX + 'bindings',
});
export const SAVE_VERSION = 1;

export type QualityPreset = 'low' | 'medium' | 'high';

/**
 * How much of the procedural surface atlas to draw.
 *
 * `off` drops the USE_TEXTURE define entirely — no atlas fetch, no derivatives,
 * no seam — which is the only version of "turn it down" that actually gives a
 * weak GPU its fragment budget back. `low` keeps the pattern at roughly half
 * strength for a mid-range phone; `full` is the authored look.
 */
export type SurfaceDetailPreset = 'off' | 'low' | 'full';

/** Multiplier handed to `VoxelMaterials.setSurfaceDetail`. */
export const SURFACE_DETAIL_SCALE: Readonly<Record<SurfaceDetailPreset, number>> = Object.freeze({
  off: 0,
  low: 0.55,
  full: 1,
});

/** How dark the per-block groove goes at each preset. */
export const SURFACE_SEAM_SCALE: Readonly<Record<SurfaceDetailPreset, number>> = Object.freeze({
  off: 0,
  low: 0.75,
  full: 1,
});
export type CrosshairStyle = 'cross' | 'dot' | 'doom' | 'dynamic';
export type TouchLayout = 'right' | 'left';

export interface GameSettings {
  version: number;
  fov: number;
  sensitivity: number;
  touchSensitivity: number;
  invertY: boolean;
  renderDistance: number;
  renderScale: number;
  quality: QualityPreset;
  /** Procedural surface atlas: off / low / full. */
  surfaceDetail: SurfaceDetailPreset;
  ao: boolean;
  fog: boolean;
  viewBob: boolean;
  screenShake: number;      // 0..1 multiplier on every weapon's shake amplitude
  fpsCounter: boolean;
  crosshair: CrosshairStyle;
  crosshairColor: number;   // packed 0xRRGGBB
  hitMarkers: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  autoSprint: boolean;
  toggleCrouch: boolean;
  touchLayout: TouchLayout;
  vibration: boolean;
  showAds: boolean;         // forced false once the remove-ads product is owned
}

export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  version: SAVE_VERSION,
  fov: FOV_DEFAULT,
  sensitivity: 1.0,
  touchSensitivity: 1.0,
  invertY: false,
  renderDistance: RENDER_DISTANCE_CHUNKS_DESKTOP,
  renderScale: 1.0,
  quality: 'high' as QualityPreset,
  surfaceDetail: 'full' as SurfaceDetailPreset,
  ao: true,
  fog: true,
  viewBob: true,
  screenShake: 1.0,
  fpsCounter: false,
  crosshair: 'dynamic' as CrosshairStyle,
  crosshairColor: 0xffffff,
  hitMarkers: true,
  masterVolume: 0.8,
  sfxVolume: 1.0,
  musicVolume: 0.5,
  autoSprint: false,
  toggleCrouch: false,
  touchLayout: 'right' as TouchLayout,
  vibration: true,
  showAds: true,
});

/** Quality preset -> the settings fields it overrides. */
export const QUALITY_PRESETS: Readonly<Record<QualityPreset, Partial<GameSettings>>> = Object.freeze({
  low: { renderDistance: 3, renderScale: 0.7, ao: false, fog: true, viewBob: false, surfaceDetail: 'low' },
  medium: { renderDistance: 4, renderScale: 0.85, ao: true, fog: true, viewBob: true, surfaceDetail: 'full' },
  high: { renderDistance: 6, renderScale: 1.0, ao: true, fog: true, viewBob: true, surfaceDetail: 'full' },
});

export interface SaveProgress {
  version: number;
  name: string;
  skin: number;
  xp: number;
  level: number;
  kills: number;
  deaths: number;
  wins: number;
  gamesPlayed: number;
  bestKillstreak: number;
  blocksPlaced: number;
  blocksBroken: number;
  secondsPlayed: number;
  favouriteWeapon: number;
  lastSeed: number;
  adsRemoved: boolean;
}

export const DEFAULT_PROGRESS: Readonly<SaveProgress> = Object.freeze({
  version: SAVE_VERSION,
  name: '',
  skin: 0,
  xp: 0,
  level: 1,
  kills: 0,
  deaths: 0,
  wins: 0,
  gamesPlayed: 0,
  bestKillstreak: 0,
  blocksPlaced: 0,
  blocksBroken: 0,
  secondsPlayed: 0,
  favouriteWeapon: 0,
  lastSeed: 0,
  adsRemoved: false,
});

/** Total XP required to reach `level`. Level 1 costs 0. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  const n = level - 1;
  return (60 * n * (n + 1)) / 2 + 67 * n;
}
/** Level implied by a total XP amount. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (level < 200 && xpForLevel(level + 1) <= xp) level++;
  return level;
}
export const XP_PER_KILL = 25;
export const XP_PER_ASSIST = 8;
export const XP_PER_WIN = 220;
export const XP_PER_MINUTE = 12;

/* ------------------------------------------------------------------------ *
 * Small shared numeric helpers used by both sides
 * ------------------------------------------------------------------------ */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
