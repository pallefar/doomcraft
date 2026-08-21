# DOOMCRAFT — Shared Contract

**Everything below is frozen.** Client, server and workers all code against this document
and the sources under `shared/src/`. If you need something that is not here, do not invent a
file in `shared/` — ask for the contract to be extended.

Source of truth, in order: `shared/src/*.ts` → this document.

---

## 0. How to import

| Where | Specifier | Notes |
|---|---|---|
| `client/**` | `import { X } from '@shared/constants'` | Vite alias + tsconfig `paths`. Per-module import tree-shakes best. **No `.ts` extension** — see below. |
| `client/**` | `import { X } from '@shared'` | Barrel. Fine for small files. |
| `client/**` worker files | same as above | Workers are `format: 'es'`; the alias resolves inside them too. |
| `server/**` | `import { X } from '@doomcraft/shared'` | Real package name via the workspace symlink. **Do not** use `@shared` on the server — `tsx watch server/src/index.ts` runs with the repo-root tsconfig, which has no `paths`. |
| `server/**` | `import { X } from '@doomcraft/shared/protocol'` | Sub-path export, maps to `shared/src/protocol.ts`. |

> **Corrected during integration.** This table used to say `'@shared/constants.ts'`.
> That specifier does not typecheck from `client/**`: `error TS5097 — an import
> path can only end with a '.ts' extension when 'allowImportingTsExtensions' is
> enabled`, and the client project cannot enable it because it emits
> declarations. Three separate agents hit it. Use `@shared/constants` (no
> extension) or the `@shared` barrel; both resolve under `tsc`, Vite and a bare
> `vitest` run.

Inside `shared/` itself, relative imports carry an explicit `.ts` extension
(`import { clamp } from './constants.ts'`). That is deliberate: `allowImportingTsExtensions`
+ `rewriteRelativeImportExtensions` are on, so `tsc` emits `./constants.js` into
`shared/dist/`, while plain `node` and `tsx` can execute `shared/src/*.ts` directly with no
build step. **Client and server code must not copy this style** — use the aliases above.

### Build / run

```
npx tsc -b --pretty false      # builds shared -> shared/dist (js + d.ts), then client, then server
npm run dev                    # tsx watch server + vite dev on :5173 (proxies /ws -> ws://localhost:8080)
npm run build                  # tsc -b && vite build  ->  <repo>/dist
```

`shared` must always compile clean. `client` and `server` emit to `client/dist` /
`server/dist` (type output only — the shipped bundle is `<repo>/dist`, produced by Vite).

---

## 1. `shared/src/constants.ts`

### Chunk / world geometry

| Symbol | Value | Meaning |
|---|---|---|
| `CHUNK_SIZE`, `CHUNK_SIZE_X`, `CHUNK_SIZE_Z` | `32` | Horizontal chunk edge, blocks. |
| `CHUNK_HEIGHT` | `64` | Chunks are full-height columns; there is no vertical chunking. |
| `CHUNK_SIZE_BITS` / `CHUNK_SIZE_MASK` | `5` / `31` | |
| `CHUNK_HEIGHT_BITS` / `CHUNK_HEIGHT_MASK` | `6` / `63` | |
| `CHUNK_AREA` | `1024` | |
| `CHUNK_VOLUME` | `65536` | One `Uint8Array(65536)` per chunk. Index fits a `Uint16`. |

```ts
voxelIndex(x, y, z): number      // x | (z << 5) | (y << 10)   -- LOCKED storage order
voxelIndexX(i): number
voxelIndexY(i): number
voxelIndexZ(i): number
inChunkBounds(x, y, z): boolean
blockToChunk(v): number          // v >> 5, correct for negatives
blockToLocal(v): number          // v & 31, correct for negatives
worldToBlock(v): number          // Math.floor
chunkKey(cx, cz): number         // int32 map key, valid for [-1024, 1023]
chunkKeyCX(key): number
chunkKeyCZ(key): number
chunkInWorld(cx, cz): boolean
blockInWorld(x, y, z): boolean
```

`voxelIndex` is x-fastest, then z, then y. **Every** mesher, worldgen pass, RLE encode and
neighbour lookup uses it. A horizontal slab is contiguous, which is what the greedy mesher sweeps.

World extent: `WORLD_RADIUS_CHUNKS = 6` → `WORLD_CHUNKS_PER_AXIS = 13`,
`WORLD_CHUNK_COUNT = 169`, `WORLD_MIN_CHUNK = -6`, `WORLD_MAX_CHUNK = 6`,
`WORLD_MIN_BLOCK_X = WORLD_MIN_BLOCK_Z = -192`, `WORLD_MAX_BLOCK_X = WORLD_MAX_BLOCK_Z = 223`,
`WORLD_SIZE_BLOCKS = 416`.

### Terrain bands (worldgen lives on the server; both sides need these)

`BEDROCK_LEVEL = 0`, `SEA_LEVEL = 26`, `TERRAIN_MIN_HEIGHT = 10`, `TERRAIN_MAX_HEIGHT = 54`,
`SOIL_DEPTH = 4`, `TERRAIN_FREQ = 1/190`, `TERRAIN_OCTAVES = 5`, `TERRAIN_LACUNARITY = 2.03`,
`TERRAIN_GAIN = 0.5`, `TERRAIN_DETAIL_FREQ = 1/42`, `TREE_DENSITY = 0.012`, `VENT_DENSITY = 0.0016`.

### Timing

`TICK_HZ = 20`, `TICK_MS = 50`, `TICK_DT = 0.05`, `SNAPSHOT_HZ = 20`, `SNAPSHOT_MS = 50`,
`INPUT_SEND_HZ = 60`, `INPUT_SEND_MS`, `INTERP_DELAY_MS = 100`, `MAX_EXTRAPOLATE_MS = 220`,
`SNAPSHOT_HISTORY = 32`, `PREDICTION_HISTORY = 128`, `LAG_COMP_MAX_MS = 250`,
`LAG_COMP_MAX_TICKS = 5`, `MAX_SUBSTEP_DT = 1/120`, `MAX_FRAME_DT = 0.1`,
`HEARTBEAT_MS = 1000`, `CLIENT_TIMEOUT_MS = 15000`, `RECONNECT_BACKOFF_MS = 1200`.

### Session limits

`MAX_PLAYERS = 32`, `MAX_ENTITIES = 256`, `MAX_PROJECTILES = 256`, `MAX_NAME_LENGTH = 20`,
`MAX_CHAT_LENGTH = 120`, `MAX_BLOCK_DELTAS_PER_MESSAGE = 512`, `MAX_EDITS_PER_SECOND = 20`,
`DEFAULT_SERVER_PORT = 8080`, `WS_PATH = '/ws'`, `BOT_FILL_TARGET = 6`, `BOT_SPAWN_DELAY_MS = 400`.

```ts
enum GameMode { DEATHMATCH = 0, HORDE = 1, SANDBOX = 2 }
GAME_MODE_NAMES: readonly string[]
DEFAULT_GAME_MODE = GameMode.DEATHMATCH
MATCH_DURATION_MS = 480000
SCORE_LIMIT = 30
```

### Player body

`PLAYER_WIDTH = 0.6`, `PLAYER_DEPTH = 0.6`, `PLAYER_HALF_WIDTH = 0.3`, `PLAYER_HEIGHT = 1.8`,
`PLAYER_CROUCH_HEIGHT = 1.15`, `PLAYER_EYE_HEIGHT = 1.62`, `PLAYER_EYE_HEIGHT_CROUCH = 0.98`,
`PLAYER_HEAD_MIN_Y = 1.42`, `PLAYER_HEAD_HALF_WIDTH = 0.22`, `COLLIDE_EPSILON = 1e-3`.

The AABB is `0.6 × 1.8 × 0.6`. Position is **feet centre**: `x`/`z` are the box centre,
`y` is the bottom plane. The head hitbox is the sub-box from `y + 1.42` to `y + 1.8`,
`±0.22` horizontally.

### Movement — DOOM pace (bar weakness #1)

| Symbol | Value | |
|---|---|---|
| `GRAVITY` | `28.0` | m/s² |
| `TERMINAL_VELOCITY` | `78.0` | m/s |
| `SPEED_RUN` | `9.5` | m/s — the headline number, ~2.2× the bar |
| `SPEED_SPRINT` | `12.6` | |
| `SPEED_CROUCH` | `4.2` | |
| `SPEED_SWIM` | `4.6` | |
| `SPEED_AIR_MAX` | `9.5` | |
| `ACCEL_GROUND` | `95.0` | reaches `SPEED_RUN` in ~0.10 s → two ticks, reads as instant |
| `ACCEL_AIR` | `34.0` | |
| `FRICTION_GROUND` | `16.0` | |
| `FRICTION_AIR` | `0.0` | |
| `AIR_CONTROL` | `0.55` | |
| `JUMP_VELOCITY` | `8.9` | apex ≈ 1.41 m |
| `JUMP_COOLDOWN_MS` | `110` | |
| `COYOTE_TIME_MS` | `90` | |
| `JUMP_BUFFER_MS` | `110` | |
| `STEP_HEIGHT` | `1.05` | auto-steps a **full block** — deliberate break from the bar |
| `WATER_GRAVITY_SCALE` | `0.32` | |
| `WATER_DRAG` | `4.2` | |
| `WATER_JUMP_VELOCITY` | `4.6` | |
| `SWIM_UP_SPEED` | `4.0` | |
| `FALL_DAMAGE_MIN_SPEED` | `19.0` | m/s downward |
| `FALL_DAMAGE_PER_MPS` | `3.4` | |
| `FALL_DAMAGE_MAX` | `100` | |
| `VIEW_BOB_AMPLITUDE` | `0.035` | m at `SPEED_RUN` |
| `VIEW_BOB_HZ` | `2.05` | |
| `LAND_DIP_MAX` | `0.16` | |

### Combat

`MAX_HEALTH = 100`, `MAX_ARMOR = 100`, `MAX_OVERHEAL = 200`, `ARMOR_ABSORB = 0.33`,
`HEADSHOT_MULTIPLIER = 2.0`, `RESPAWN_DELAY_MS = 1400`, `SPAWN_PROTECTION_MS = 1200`,
`HITSCAN_MAX_DISTANCE = 220`, `KNOCKBACK_SCALE = 0.055`, `SELF_KNOCKBACK_SCALE = 0.085`,
`REACH_BREAK = 6.0`, `REACH_PLACE = 6.0`, `REACH_INTERACT = 4.0`,
`BLOCK_BREAK_BASE_MS = 220`, `BLOCK_PLACE_COOLDOWN_MS = 110`,
`LAVA_DAMAGE_PER_SEC = 22`, `DROWN_DAMAGE_PER_SEC = 6`, `BREATH_SECONDS = 14`,
`HEALTH_REGEN_DELAY_MS = 6000`, `HEALTH_REGEN_PER_SEC = 0` (Doom does not regen).

Damage order: `final = damageAtDistance(weapon, dist) * (headshot ? headshotMultiplier : 1)`,
then armour absorbs `ARMOR_ABSORB` of it while armour remains.

### Render budget (the measurable half of the bar)

`TARGET_FPS = 60`, `TARGET_FRAME_MS`, `TARGET_ONE_PCT_LOW_FPS = 55`,
`TIME_TO_INTERACTIVE_BUDGET_MS = 3000` (voxiom measured 3161 ms),
`RENDER_DISTANCE_CHUNKS_DESKTOP = 6`, `RENDER_DISTANCE_CHUNKS_MOBILE = 4`,
`RENDER_DISTANCE_MIN = 2`, `RENDER_DISTANCE_MAX = 8`,
`MESH_UPLOAD_BUDGET_MS = 3.0`, `MAX_MESH_UPLOADS_PER_FRAME = 2`, `MESH_JOBS_IN_FLIGHT = 4`,
`FOV_DEFAULT = 90`, `FOV_MIN = 70`, `FOV_MAX = 110`, `FOV_SPRINT_BONUS = 8`,
`NEAR_PLANE = 0.06`, `FAR_PLANE = 420`,
`SKY_COLOR = 0x6ea9e0`, `SKY_HORIZON_COLOR = 0x9fc9ef`, `FOG_COLOR = 0x8bb6dd`,
`FOG_NEAR_FRAC = 0.55`, `FOG_FAR_FRAC = 0.98`, `AO_STRENGTH = 0.42`,
`SUN_DIR_X/Y/Z = -0.42 / -0.82 / -0.39`, `AMBIENT_LIGHT = 0.46`, `SUN_LIGHT = 0.62`,
`HURT_FLASH_COLOR = 0xb01010`, `PICKUP_FLASH_COLOR = 0xf0d060`.

### Input

```ts
enum InputAction { MoveForward='moveForward', MoveBack, MoveLeft, MoveRight,
  TurnLeft, TurnRight, StrafeMod, Jump, Crouch,
  Sprint, Fire, AltFire, Reload, Use, Melee, BuildMode, NextWeapon, PrevWeapon,
  Slot1..Slot7, Chat, Scoreboard, Map, Menu }

DEFAULT_KEYBINDS: Readonly<Record<InputAction, string>>          // PRIMARY layer
SCHEME_ALT_BINDINGS: Readonly<Record<ControlScheme, PartialBindings>>   // ALT layer
```
Binding values are `KeyboardEvent.code` (`'KeyW'`), or `'Mouse0' | 'Mouse1' | 'Mouse2'`,
or `'WheelUp' | 'WheelDown'`.

**Two layers.** `DEFAULT_KEYBINDS` is the primary map and is IDENTICAL under both control
schemes — WASD and the mouse never move. A scheme owns only the second layer, so switching
one can never strand a player. A code is exclusive *within* a layer but may appear once in
each: under Classic, `Space` is `Jump` on the primary layer and DOOM's `use` on the alt one,
and pressing it does both.

**Control schemes** (`shared/src/controls.ts`), `GameSettings.controlScheme`:

| | `modern` (default) | `classic` |
| --- | --- | --- |
| Arrow Up / Down | move forward / back | move forward / back |
| Arrow Left / Right | strafe | **turn** |
| `,` / `.` | — | strafe left / right |
| Left Alt | — | strafe modifier: turn keys strafe while held |
| Left Ctrl | — | fire |
| Space | jump | jump **and** use |
| Right Shift | run | run |

Every number in the Classic column is DOOM 1993's, read out of id Software's released
`linuxdoom-1.10` (`m_misc.c` defaults, `g_game.c` `G_BuildTiccmd`, `p_user.c`), not from memory.

**Keyboard turning** — `InputManager.turnDelta(dt)` returns radians of yaw and the camera
applies them; nothing about a turn key reaches the wire. Two stages, no ramp between them,
straight off `angleturn[3] = {640, 1280, 320}` at 35 tics/s with `SLOWTURNTICS = 6`:

```ts
TURN_RATE_SLOW  =  61.523 deg/s    // the first 143 ms of any turn
TURN_RATE_WALK  = 123.047 deg/s
TURN_RATE_RUN   = 246.094 deg/s    // run doubles the turn as well as the legs
TURN_ACCEL_SECONDS = 5 / 35        // `turnheld` is bumped BEFORE the compare, so 5 tics
```

**Rebinding across a scheme switch** — `resolveBindings(scheme, custom)` owns the rule:
*a rebind pins its row; switching schemes rewrites only the rows you never touched.* Pinned
rows live on `STORAGE_KEYS.bindings` as `{primary,alt}`, separate from the settings blob;
"Reset controls" drops the pins. On a collision inside a layer, the pin wins and the
scheme's row is the one that loses its key.

**Taking an action from the player** — `InputManager.setActionTaken(action, on)`, not a
blanked binding. Blanking clears one layer only; the mask switches the action off at every
source (both key layers, the gamepad, the touch buttons). Builder's no-clip camera and
Horde's fortify cursor both go through it.

`MOUSE_RADIANS_PER_PIXEL = 0.0022`, `TOUCH_RADIANS_PER_PIXEL = 0.0042`,
`SENSITIVITY_MIN = 0.1`, `SENSITIVITY_MAX = 5.0`, `PITCH_LIMIT = PI/2 - 0.001`.

### DOM ids

`DOM_CANVAS_ID='game'`, `DOM_HUD_ID='hud'`, `DOM_UI_ID='ui'`, `DOM_ADS_ID='ads'`,
`DOM_BOOT_ID='boot'`, `DOM_BOOT_BAR_ID='boot-bar'`, `DOM_BOOT_PCT_ID='boot-pct'`,
`DOM_BOOT_STATUS_ID='boot-status'`.

### Monetisation

`AD_SLOT_TOP='ad-slot-top'`, `AD_SLOT_SIDE='ad-slot-side'`, `AD_SLOT_BOTTOM='ad-slot-bottom'`,
`AD_SLOT_IDS: readonly string[]`,
`AD_SLOT_SIZES: Record<string, readonly [dw, dh, mw, mh]>` (CSS px, must match `index.html`),
`AD_OVERLAY_ID='ad-overlay'`, `AD_INTERSTITIAL_MIN_INTERVAL_MS=180000`,
`AD_INTERSTITIAL_AFTER_DEATHS=3`, `AD_INTERSTITIAL_MAX_SECONDS=15`, `AD_REWARD_ARMOR=50`,
`IAP_PRODUCT_REMOVE_ADS='doomcraft.remove_ads'`, `IAP_PRICE_USD=4.99`.

### Persistence

```ts
STORAGE_PREFIX = 'doomcraft:'
STORAGE_KEYS = { settings, progress, purchase, bindings }   // fully-qualified localStorage keys
SAVE_VERSION = 1

type QualityPreset = 'low' | 'medium' | 'high'
type CrosshairStyle = 'cross' | 'dot' | 'doom' | 'dynamic'
type TouchLayout = 'right' | 'left'
type ControlScheme = 'modern' | 'classic'

interface GameSettings {
  version: number; fov: number; sensitivity: number; touchSensitivity: number; invertY: boolean;
  renderDistance: number; renderScale: number; quality: QualityPreset;
  ao: boolean; fog: boolean; viewBob: boolean; screenShake: number; fpsCounter: boolean;
  crosshair: CrosshairStyle; crosshairColor: number; hitMarkers: boolean;
  masterVolume: number; sfxVolume: number; musicVolume: number;
  autoSprint: boolean; toggleCrouch: boolean; controlScheme: ControlScheme;
  touchLayout: TouchLayout; vibration: boolean;
  showAds: boolean;
}
DEFAULT_SETTINGS: Readonly<GameSettings>
QUALITY_PRESETS: Readonly<Record<QualityPreset, Partial<GameSettings>>>

interface SaveProgress {
  version: number; name: string; skin: number; xp: number; level: number;
  kills: number; deaths: number; wins: number; gamesPlayed: number; bestKillstreak: number;
  blocksPlaced: number; blocksBroken: number; secondsPlayed: number;
  favouriteWeapon: number; lastSeed: number; adsRemoved: boolean;
}
DEFAULT_PROGRESS: Readonly<SaveProgress>

xpForLevel(level: number): number      // total XP needed to reach `level`; level 1 == 0
levelForXp(xp: number): number
XP_PER_KILL = 25, XP_PER_ASSIST = 8, XP_PER_WIN = 220, XP_PER_MINUTE = 12
```

`screenShake` is a 0..1 multiplier applied to every weapon's `shakeAmplitude`.
`showAds` is forced `false` once `IAP_PRODUCT_REMOVE_ADS` is owned.

### Misc

```ts
clamp(v, lo, hi): number
clamp01(v): number
```

---

## 2. `shared/src/blocks.ts`

```ts
enum BlockId {
  AIR=0, STONE, DIRT, GRASS, SAND, WATER, WOOD, LEAVES, METAL, LAVA, GLASS, BRICK,
  PLANKS, COBBLESTONE, SNOW, ICE, OBSIDIAN, GRAVEL, RUSTED_METAL, TECH_PANEL,
  HELLSTONE, BONE, SLIME, NEON, BEDROCK=24
}
BLOCK_COUNT = 25          // every lookup array is exactly this long
```

### Faces

```ts
enum Face { PX=0, NX=1, PY=2 /*top*/, NY=3 /*bottom*/, PZ=4, NZ=5 }
FACE_COUNT = 6
FACE_NORMALS: Int8Array          // 3 per face, in Face order
FACE_SHADE: Float32Array         // [0.78, 0.78, 1.0, 0.5, 0.66, 0.66]
FACE_OPPOSITE: Uint8Array        // [1,0,3,2,5,4]
FACE_AXIS: Uint8Array            // [0,0,1,1,2,2]
faceFromNormal(nx, ny, nz): number
```

### Render layers

```ts
enum RenderLayer { OPAQUE=0, CUTOUT=1 /*leaves*/, TRANSPARENT=2 /*water, glass, ice, slime*/ }
RENDER_LAYER_COUNT = 3
```
**One draw call per chunk per layer.** Three geometries per chunk, max.

### Authoring table (do not read this in the mesher)

```ts
interface BlockDef {
  id, name, solid, opaque, liquid, hardness,
  colorTop, colorSide, colorBottom,    // packed 0xRRGGBB
  emissive,                            // 0..15 light level
  layer: RenderLayer, alpha, damage,   // damage = HP/second on contact
  replaceable, placeable
}
BLOCKS: readonly BlockDef[]            // indexed by BlockId, frozen
```
`hardness < 0` means unbreakable (`AIR`, `WATER`, `LAVA`, `BEDROCK`).

### Hot lookups — typed arrays indexed by block id

```ts
BLOCK_FLAGS: Uint8Array        // BF_* bits
BLOCK_SOLID: Uint8Array        // 0 | 1
BLOCK_OPAQUE: Uint8Array
BLOCK_LIQUID: Uint8Array
BLOCK_LIGHT: Uint8Array        // 0..15
BLOCK_LAYER: Uint8Array        // RenderLayer
BLOCK_HARDNESS: Float32Array
BLOCK_ALPHA: Float32Array
BLOCK_DAMAGE: Float32Array
BLOCK_COLOR: Uint32Array       // [id*3 + 0|1|2] = top | side | bottom
BLOCK_FACE_COLOR: Uint32Array  // [id*6 + face]  -- one read per quad
BLOCK_FACE_SHADED: Uint32Array // [id*6 + face] with FACE_SHADE pre-applied
BLOCK_NAMES: string[]

BF_SOLID=1, BF_OPAQUE=2, BF_LIQUID=4, BF_EMISSIVE=8,
BF_REPLACEABLE=16, BF_PLACEABLE=32, BF_DAMAGING=64, BF_BREAKABLE=128
```

The mesher should index `BLOCK_SOLID` / `BLOCK_OPAQUE` / `BLOCK_FACE_SHADED` directly rather
than call the predicates — that is what they are for.

### Queries

```ts
isAir(id), isSolid(id), isOpaque(id), isLiquid(id), isEmissive(id),
isReplaceable(id), isPlaceable(id), isBreakable(id), isDamaging(id): boolean
blockLight(id), blockHardness(id), blockLayer(id), blockAlpha(id), blockDamage(id): number
blockName(id): string
blockDef(id): BlockDef
blockFaceColor(id, face): number      // packed 0xRRGGBB
blockFaceShaded(id, face): number
minimapColor(id): number              // the top face, unshaded

shouldRenderFace(self, neighbor): boolean
blockBreakMs(id, toolPower, baseMs): number   // Infinity when unbreakable
PLACEABLE_BLOCKS: readonly number[]           // build palette, hotbar order (21 entries)

packRGB(r, g, b), unpackR(c), unpackG(c), unpackB(c): number
shadeColor(color, mul): number
```

`shouldRenderFace` is the single occlusion rule; client and server must not disagree:
air always draws, an opaque neighbour always hides, identical ids merge, two transparent
blocks merge.

---

## 3. `shared/src/weapons.ts`

```ts
enum WeaponId { PISTOL=0, SHOTGUN=1, CHAINGUN=2, ROCKET=3, PLASMA=4, BFG=5, CHAINSAW=6 }
WEAPON_COUNT = 7
enum AmmoType { NONE=0, BULLETS=1, SHELLS=2, ROCKETS=3, CELLS=4 }
AMMO_TYPE_COUNT = 5
enum FireKind { HITSCAN=0, PROJECTILE=1, MELEE=2 }
AMMO_NAMES: readonly string[]
AMMO_MAX: Uint16Array     // [0, 400, 80, 40, 400]  reserve cap by AmmoType
AMMO_START: Uint16Array   // [0, 120, 24,  8, 120]  reserve on spawn
AMMO_COLORS: Uint32Array  // HUD colour by AmmoType
```

### `WeaponDef` fields

`id, name, short, slot, kind, ammo`
`damage, pellets, headshotMultiplier`
`spread, spreadMax, spreadPerShot, spreadRecovery, spreadAir, spreadCrouchScale` (radians, half-angle)
`rpm, automatic, spinUpMs, spinDownMs`
`projectileSpeed, projectileGravity, projectileRadius, projectileLifeMs, projectileColor, projectileLight`
`splashRadius, splashDamage, selfDamageScale, selfKnockbackScale, terrainDamage`
`magSize, reserveMax, reloadMs, reloadShellMs` (`reloadShellMs > 0` ⇒ shell-by-shell reload)
`meleeRange`
`recoilPitch, recoilYaw, recoilRecovery` (camera punch, radians and 1/s)
`shakeAmplitude, shakeMs, shakeFrequency` (screen shake, metres of camera offset)
`viewKickX/Y/Z, viewKickPitch/Yaw/Roll, viewKickRecovery` (viewmodel impulse; +x right, +y up, +z toward player)
`muzzleIntensity, muzzleMs, muzzleColor, muzzleRadius`
`falloffStart, falloffEnd, falloffMin, falloffCurve`
`knockback` (m/s of impulse per point of damage)
`switchInMs, switchOutMs`
`crosshairGap` (base CSS px)

### The numbers

| | PISTOL | SHOTGUN | CHAINGUN | ROCKET | PLASMA | BFG | CHAINSAW |
|---|---|---|---|---|---|---|---|
| kind | hitscan | hitscan | hitscan | projectile | projectile | projectile | melee |
| ammo | bullets | shells | bullets | rockets | cells | cells | none |
| damage | 17 | 11 ×7 | 9 | 92 | 21 | 240 | 26 |
| spread → max | .010→.030 | .090 | .009→.055 | 0 | .014→.030 | 0 | 0 |
| rpm | 420 | 75 | 700 | 88 | 660 | 40 | 480 |
| auto | yes | no | yes | no | yes | no | yes |
| mag / reserve | 15 / 400 | 8 / 80 | 100 / 400 | 5 / 40 | 60 / 400 | 3 / 400 | – |
| reload ms | 850 | 2400 (400/shell) | 3200 | 2500 | 1900 | 3400 | – |
| splash r / dmg | – | – | – | 4.4 / 108 | 0.9 / 8 | 9.5 / 400 | – |
| self dmg × | – | – | – | 0.55 | 0 | 0.25 | – |
| proj speed | – | – | – | 46 | 92 | 32 | – |
| falloff | 26→70 → .55 | 9→28 → .30 | 22→64 → .50 | none | none | none | 2.0→2.6 |
| recoil pitch | .022 | .075 | .012 | .100 | .010 | .130 | .004 |
| shake amp / ms | .05 / 60 | .30 / 140 | .07 / 50 | .55 / 220 | .05 / 40 | .90 / 420 | .12 / 40 |
| terrain carve (blocks) | 0 | 0 | 0 | 2.6 | 0 | 5.5 | 0 |

Rockets and the BFG carve the world (`terrainDamage` in blocks of radius) and can be ridden
(`selfKnockbackScale`). That combination is the thing the bar cannot do.

### Derived hot tables

```ts
WEAPONS: readonly WeaponDef[]
WEAPON_NAMES, WEAPON_SHORT_NAMES: string[]
WEAPON_FIRE_INTERVAL_MS: Float32Array     // 60000 / rpm
WEAPON_DAMAGE: Float32Array
WEAPON_PELLETS, WEAPON_KIND, WEAPON_AMMO, WEAPON_AUTOMATIC: Uint8Array
WEAPON_MAG_SIZE: Uint16Array
WEAPON_SPLASH_RADIUS, WEAPON_SPLASH_DAMAGE, WEAPON_PROJECTILE_SPEED: Float32Array
WEAPON_BY_SLOT: Uint8Array                // index 1..7
```

### Functions

```ts
getWeapon(id): WeaponDef
weaponName(id): string
fireIntervalMs(id): number
isAutomatic(id) | isHitscan(id) | isProjectile(id) | isMelee(id): boolean
ammoTypeOf(id): number
ammoMax(type): number
weaponFromSlot(slot): number

damageFalloffScale(id, dist): number       // in [falloffMin, 1]
damageAtDistance(id, dist): number         // per pellet / per direct hit, before armour
splashDamageAt(id, dist): number           // quadratic falloff, 0 outside the radius
knockbackImpulse(id, damage): number

currentSpread(id, heatSpread, airborne, crouched): number
applyShotSpread(id, heatSpread): number    // call once per shot
recoverSpread(id, heatSpread, dt): number  // call each tick while not firing
spreadFraction(id, heatSpread): number     // 0..1, drives the dynamic crosshair

STARTING_WEAPONS: readonly number[]        // [PISTOL, CHAINSAW]
DEFAULT_WEAPON = WeaponId.PISTOL
STARTING_WEAPON_MASK: number
ALL_WEAPON_MASK: number
ownsWeapon(mask, id): boolean
grantWeapon(mask, id): number
nextWeapon(mask, from, dir): number        // dir >= 0 cycles up
```

Spread state is one number per player: the current cone half-angle in radians. The client
predicts it and the server recomputes it with the same two functions, so they never disagree.

---

## 4. `shared/src/math.ts`

Every function is allocation-free and deterministic. `NumArray = Float32Array | Float64Array | number[]`.

### Scalars

```ts
EPSILON = 1e-6, TAU, DEG2RAD, RAD2DEG
clampf(v, lo, hi), saturate(v), lerp(a, b, t), inverseLerp(a, b, v)
smoothstep(t), smootherstep(t), signf(v), approxEq(a, b, eps)
moveTowards(current, target, maxDelta)
expDecay(current, target, rate, dt)        // frame-rate independent approach
wrapAngle(a)        // -> [-PI, PI)
wrapAngle2Pi(a)     // -> [0, TAU)
angleDelta(a, b), lerpAngle(a, b, t)
```

### vec3 on flat arrays

```ts
v3set(o, oi, x, y, z)            v3copy(o, oi, a, ai)          v3zero(o, oi)
v3add(o, oi, a, ai, b, bi)       v3sub(...)                    v3scale(o, oi, a, ai, s)
v3addScaled(o, oi, a, ai, b, bi, s)                            v3lerp(o, oi, a, ai, b, bi, t)
v3dot(a, ai, b, bi): number      v3cross(o, oi, a, ai, b, bi)
v3lenSq(a, ai), v3len(a, ai), v3distSq(a, ai, b, bi), v3dist(a, ai, b, bi): number
v3normalize(o, oi, a, ai): number      // returns the original length
v3clampLength(o, oi, max)

anglesToForward(o, oi, yaw, pitch)     // yaw 0 looks down -Z, +yaw turns right
yawToRight(o, oi, yaw)
forwardToAngles(o, oi, x, y, z)        // writes [yaw, pitch]
coneSpread(o, oi, dx, dy, dz, spread, r1, r2)   // r1,r2 uniform [0,1) from a seeded PRNG
```

`coneSpread` produces a unit vector inside a cone of half-angle `spread`. Pass PRNG output
so the server can reproduce the client's pellet pattern exactly.

### AABB vs voxel field

```ts
type SolidAt = (x: number, y: number, z: number) => boolean

HIT_NX=1, HIT_PX=2, HIT_NY=4 /*grounded*/, HIT_PY=8 /*ceiling*/, HIT_NZ=16, HIT_PZ=32, HIT_STEPPED=64

aabbHitsSolid(x, y, z, halfW, height, solid): boolean
isGrounded(pos, halfW, tolerance, solid): boolean
moveAABB(pos, vel, halfW, height, dt, stepHeight, solid): number   // returns HIT_* flags
rayAABB(ox,oy,oz, dx,dy,dz, minx,miny,minz, maxx,maxy,maxz, maxDist): number  // t, or -1
raySphere(ox,oy,oz, dx,dy,dz, cx,cy,cz, radius, maxDist): number              // t, or -1
```

**`moveAABB` is THE collision routine.** `pos` is `[x, y, z]` (feet centre) and is updated in
place; `vel` is `[vx, vy, vz]` and has the colliding components zeroed. It substeps at 0.4 m
so nothing tunnels, resolves Y then X then Z, and auto-steps up to `stepHeight` when the box
is standing on ground. Client prediction and server simulation must both call it with
identical arguments.

### DDA voxel raycast (Amanatides & Woo)

```ts
interface VoxelHit {
  hit: boolean;
  x, y, z: number;        // block coordinates of the hit voxel
  nx, ny, nz: number;     // face normal, points back along the ray
  distance: number;       // metres from the origin
  block: number;          // block id, 0 on a miss
  px, py, pz: number;     // exact contact point
  steps: number;
}
createVoxelHit(): VoxelHit
scratchVoxelHit: VoxelHit                 // module-level scratch for one-at-a-time callers
raycastVoxels(ox,oy,oz, dx,dy,dz, maxDist, getBlock, isBlocking, out): boolean
```

To place a block: target voxel is `(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz)`.
To break: `(hit.x, hit.y, hit.z)`. Capped at 512 voxel steps.

### PRNG and hashing

```ts
mulberry32(seed): () => number       // floats in [0,1)
class Rng {
  constructor(seed: number)
  reseed(seed): void
  next(): number                     // [0,1)
  int(n): number                     // [0, n)
  range(lo, hi): number
  signed(): number                   // [-1, 1)
  bool(p): boolean
  fork(salt): Rng
}
hashInt(x): number                   // unsigned 32-bit avalanche
hash2i(x, y, seed), hash3i(x, y, z, seed): number    // unsigned 32-bit
hash2f(x, y, seed), hash3f(x, y, z, seed): number    // [0,1)
seedChannel(seed, channel): number   // derive an independent seed stream
```

### Noise (terrain basis — identical on client and server)

```ts
valueNoise2(x, y, seed): number                                    // [-1, 1]
valueNoise3(x, y, z, seed): number                                 // [-1, 1]
fbm2(x, y, seed, octaves, lacunarity, gain): number                // [-1, 1], normalised
fbm3(x, y, z, seed, octaves, lacunarity, gain): number
ridged2(x, y, seed, octaves, lacunarity, gain): number             // [0, 1]
warpedFbm2(x, y, seed, octaves, warp): number
```

Hashing is `Math.imul`-based, so identical results in every JS engine. **Worldgen itself
belongs to the server** — it streams chunks to the client, which never generates terrain.
Use `seedChannel(seed, n)` to keep height, biome, cave and decoration noise independent.

---

## 4b. `shared/src/terrain.ts` — worldgen (added during integration)

Worldgen was originally written twice: `client/src/world/terrain.ts` (arenas,
terraces, three themes) and `server/src/world.ts` (warped fbm beach). Two
descriptions of the level is one too many — the client's offline sandbox and the
authoritative server would disagree about every voxel — so the generator was
promoted into `shared/src/terrain.ts` and both sides now call it.

```ts
TERRAIN_VERSION = 1                       // server asserts on this at import
enum Theme { OUTLAND = 0, TECH = 1, HELL = 2 }
generateChunkInto(seed, cx, cz, out: Uint8Array): void   // out is zeroed first
generateChunk(seed, cx, cz): Uint8Array
baseHeight(seed, x, z) / surfaceHeightAt(seed, x, z) / themeAt(seed, x, z)
findSpawnPoints(seed, out: Float64Array, count, minCell?, maxCell?): number
resolveSpawnFeet(x, z, highestGroundY, blockAt): number
nearestArena(seed, x, z, out: Float64Array)   // [cx, cz, radius, floorY, theme]
resetTerrainCaches()
```

`client/src/world/terrain.ts` is now a re-export of this module.
`server/src/world.ts` calls `generateChunkInto` and `surfaceHeightAt`, then
stamps its own arena furniture (platforms, towers, cover) on the terraced ground
*between* arenas and rebuilds its surface index.

---

## 5. `shared/src/protocol.ts`

Binary, little-endian, one `uint8` message id first.

```ts
PROTOCOL_VERSION       = 3      // what this build speaks
PROTOCOL_MIN_SUPPORTED = 2      // the oldest it still SERVES — a window, not equality

enum C2S { HELLO=1, INPUT=2, BLOCK_EDIT=3, CHAT=4, RESPAWN=5, PING=6, APPEARANCE=7 }
enum S2C { WELCOME=1, CHUNK=2, SNAPSHOT=3, BLOCK_DELTA=4, DAMAGE=5, KILL=6, CHAT=7, PONG=8,
           CHUNK_Z=9, UPDATE_REQUIRED=10, SESSION_CONFIG=11 }
readMessageId(data: ArrayBuffer | Uint8Array | DataView): number
```

**A connection is gated against the WINDOW, never against equality** — `checkProtocol()` in
`shared/src/version.ts` is the single place that rule is written, and `server/src/net.ts` calls it.
Strict equality made every deploy a fleet-wide simultaneous logout. `docs/PATCHING.md` §1.

**An unknown message id is IGNORED, on both sides.** That is load-bearing, not sloppiness: it is what
lets a message id be appended without a version bump, which is how `UPDATE_REQUIRED` and
`SESSION_CONFIG` shipped at protocol 3. Do not turn either `default: break` into an error.

**Trailing fields are appended and guarded by `r.remaining >= k`, never inserted.** `decodeHello`
does this twice (`avatar`, then `contentVersion`). Renumbering an id, reordering a bitmask bit or
moving a quantisation constant is a real break: bump `PROTOCOL_VERSION`, update this section, and
update the ratchet in `shared/src/version.test.ts` in the same commit.

### Quantisation

| Quantity | Wire | Scale | Functions |
|---|---|---|---|
| position | `int16` | 1/64 m (±512 m) | `quantizePos` / `dequantizePos` |
| velocity | `int16` | 1/64 m/s | `quantizeVel` / `dequantizeVel` |
| yaw | `uint16` | 2π / 65536 | `quantizeAngle` / `dequantizeAngle` |
| pitch | `int16` | ±π/2 | `quantizePitch` / `dequantizePitch` |
| unit axis | `int16` | 1/32767 | `quantizeUnit` / `dequantizeUnit` |
| health / armour | `uint8` | 1 | `quantizeHealth` |

Constants: `POS_SCALE=64`, `POS_INV_SCALE`, `ANGLE_SCALE`, `ANGLE_INV_SCALE`,
`PITCH_SCALE`, `PITCH_INV_SCALE`, `UNIT_SCALE`, `UNIT_INV_SCALE`.

### Cursors

```ts
class PacketWriter {
  constructor(capacity = 8192)
  buffer: ArrayBuffer; view: DataView; bytes: Uint8Array; offset: number
  reset(): this
  ensure(n): void                       // grows by doubling; invalidates old view/bytes refs
  u8 i8 u16 i16 u32 i32 f32 f64 (v: number): void
  str(s: string, maxBytes: number): void        // uint8 length + UTF-8, cut on a codepoint boundary
  raw(src: Uint8Array, srcOffset, length): void
  slice(): Uint8Array                   // zero-copy, valid only until the next write
  copy(): Uint8Array                    // detached copy
  toArrayBuffer(): ArrayBuffer          // detached copy, best shape for WebSocket.send
}

class PacketReader {
  constructor(data?: ArrayBuffer | Uint8Array | DataView)
  view: DataView; bytes: Uint8Array; offset: number; end: number
  reset(data): this
  get remaining(): number
  u8 i8 u16 i16 u32 i32 f32 f64 (): number
  str(): string
  rawView(length): Uint8Array           // zero-copy
  skip(n): void
}
```

Rule: `ws.send(writer.copy())` on the server (Node `ws` may queue), `ws.send(writer.slice())`
is fine in the browser only when the socket is `OPEN` and the same buffer is not rewritten
before the call returns — when in doubt use `copy()`.

### Bitfields

```
buttons        BTN_FIRE=1, BTN_ALT_FIRE=2, BTN_JUMP=4, BTN_CROUCH=8, BTN_SPRINT=16,
               BTN_RELOAD=32, BTN_USE=64, BTN_MELEE=128, BTN_BUILD=256,
               BTN_NEXT_WEAPON=512, BTN_PREV_WEAPON=1024, BTN_RESPAWN=2048
player state   PS_ON_GROUND=1, PS_CROUCHING=2, PS_SPRINTING=4, PS_DEAD=8,
               PS_IN_WATER=16, PS_FIRING=32, PS_RELOADING=64, PS_BOT=128
snapshot       SNAP_FULL=1, SNAP_MATCH_OVER=2
damage flags   DMG_HEADSHOT=1, DMG_SPLASH=2, DMG_FATAL=4, DMG_SELF=8, DMG_FALL=16,
               DMG_ENVIRONMENT=32, DMG_YOU_ARE_VICTIM=64
kill flags     KILL_HEADSHOT=1, KILL_MELEE=2, KILL_SELF=4, KILL_ENVIRONMENT=8
hello caps     CAP_TOUCH=1, CAP_LOW_SPEC=2, CAP_ADS_REMOVED=4, CAP_RETURNING=8,
               CAP_INFLATE=16
```

```ts
enum BlockAction { BREAK=0, PLACE=1 }
enum EntityType { IMP=0, ZOMBIE=1, CACODEMON=2, BARON=3, LOST_SOUL=4,
                  PICKUP_HEALTH=16, PICKUP_ARMOR=17, PICKUP_AMMO=18, PICKUP_WEAPON=19 }
enum RemoveReason { EXPIRED=0, HIT_WORLD=1, HIT_ENTITY=2, KILLED=3, PICKED_UP=4, DESPAWNED=5 }
enum ChatChannel { ALL=0, TEAM=1, SYSTEM=2, KILLFEED=3, TIP=4 }
```

### C2S messages

| Msg | Layout | Bytes |
|---|---|---|
| `HELLO` | `u8 id, u8 version, str name, u8 skin, u16 caps` | ~8 + name |
| `INPUT` | `u8 id, u32 seq, u16 dtMs, u16 yaw, i16 pitch, u16 buttons, i8 moveX, i8 moveZ, u8 slot` | **16** |
| `BLOCK_EDIT` | `u8 id, u8 action, u8 blockId, u8 y, i16 x, i16 z, u32 seq` | **12** |
| `CHAT` | `u8 id, str text` | 2 + text |
| `RESPAWN` | `u8 id` | 1 |
| `PING` | `u8 id, u32 clientTimeMs` | 5 |

```ts
interface HelloMessage { protocolVersion, name, skin, caps, avatar, contentVersion }
createHelloMessage(): HelloMessage
encodeHello(w, name, skin, caps, avatar = 0, contentVersion = 0): PacketWriter
decodeHello(r, out): HelloMessage

interface InputCommand { seq, dtMs, yaw, pitch, buttons, moveX, moveZ, slot }
createInputCommand(): InputCommand
encodeInput(w, seq, dtMs, yaw, pitch, buttons, moveX, moveZ, slot): PacketWriter
encodeInputCommand(w, c: InputCommand): PacketWriter
decodeInput(r, out): InputCommand

interface BlockEditCommand { seq, action, x, y, z, blockId }
createBlockEditCommand(): BlockEditCommand
encodeBlockEdit(w, seq, action, x, y, z, blockId): PacketWriter
decodeBlockEdit(r, out): BlockEditCommand

encodeChatC2S(w, text): PacketWriter        decodeChatC2S(r): string
encodeRespawn(w): PacketWriter
encodePing(w, clientTimeMs): PacketWriter   decodePing(r): number
```

`moveX` / `moveZ` are `-1..1` (`+moveX` = strafe right, `+moveZ` = forward), quantised to
`int8/127`. `slot` 0..6 selects a weapon, 7..8 select build slots.

### S2C messages

```ts
interface WelcomeMessage {
  protocolVersion, playerId, seed, tickRate, worldRadiusChunks, chunkSize, chunkHeight,
  maxPlayers, gameMode, serverTimeMs, chunkCount
}
createWelcomeMessage(): WelcomeMessage
encodeWelcome(w, playerId, seed, tickRate, worldRadiusChunks, chunkSize, chunkHeight,
              maxPlayers, gameMode, serverTimeMs, chunkCount): PacketWriter
decodeWelcome(r, out): WelcomeMessage
```
Layout: `u8 id, u8 version, u16 playerId, u32 seed, u8 tickRate, u8 worldRadius, u8 chunkSize,
u8 chunkHeight, u8 maxPlayers, u8 gameMode, u32 serverTimeMs, u16 chunkCount` — 20 bytes.
`chunkCount` lets the loading screen show real progress.

```ts
interface ChunkMessage { cx, cz, voxels: Uint8Array /* CHUNK_VOLUME */ }
createChunkMessage(): ChunkMessage
encodeChunk(w, cx, cz, voxels): PacketWriter
decodeChunk(r, out): ChunkMessage
```
Layout: `u8 id, i16 cx, i16 cz, u32 rleByteLength, <runs>`. A typical terrain chunk is about
6 KB for 65536 voxels (~9%).

**RLE format** — one run is 3 bytes: `u8 blockId, u16 count` (LE), runs capped at 65535.
```ts
RLE_RUN_BYTES = 3
rleMaxBytes(voxelCount): number                                  // voxelCount * 3
rleEncodeInto(src: Uint8Array, dst: Uint8Array, dstOffset): number   // bytes written
rleEncode(src: Uint8Array): Uint8Array                           // allocates; cold path only
rleDecode(src, srcOffset, srcLength, dst): number                // voxels written
```
`rleDecode` skips id 0 runs, so **`dst` must arrive zeroed** (`decodeChunk` does this for you).

#### `CHUNK_Z` — the same chunk, raw-deflated

```ts
CHUNK_HEADER_BYTES = 9          // id, cx, cz, len
CHUNK_Z_HEADER_BYTES = 13       // id, cx, cz, rleLen, zLen
encodeChunkZ(w, cx, cz, rleLen, z: Uint8Array): PacketWriter
interface ChunkZHeader { cx, cz, rleLen, zLen }
createChunkZHeader(): ChunkZHeader
decodeChunkZHeader(r, out): ChunkZHeader     // leaves r.offset on the first deflate byte
```
Layout: `u8 id, i16 cx, i16 cz, u32 rleByteLength, u32 deflateByteLength, <deflate-raw>`.
The compressed payload is `deflateRaw` of **exactly** the byte range `encodeChunk` would have
written, so a receiver inflates to `rleLen` bytes and then runs the same `rleDecode`. On measured
terrain that is **3.79x** smaller: 2.99 MB -> 0.79 MB for the 169-chunk join burst.

**Negotiated, never assumed.** The server sends `CHUNK_Z` only to a connection whose HELLO set
`CAP_INFLATE`, and only when the process registered a compressor
(`setChunkCompressor` in `server/src/net.ts` — the browser's local-server Worker does not, so
single player still receives plain `CHUNK`). A client sets `CAP_INFLATE` only when it has both
`DecompressionStream('deflate-raw')` and a `Worker` to run it in. Everything else keeps the
uncompressed path, unchanged. `decodeChunkZHeader` deliberately does not inflate: on the client
the inflate and the RLE expansion both belong in `client/src/net/chunkInflate.worker.ts`, off the
main thread.

The server caches the finished `CHUNK_Z` packet per chunk per room and drops it whenever that
chunk's voxels change, so the deflate is paid once and every later joiner gets a `send`.

#### `SESSION_CONFIG` — the two version axes that are not the protocol

```ts
interface SessionConfigMessage {
  serverProtocol, serverMinProtocol, contentVersion, contentHash, flags, buildId
}
createSessionConfigMessage(): SessionConfigMessage
encodeSessionConfig(w, serverProtocol, serverMinProtocol, contentVersion, contentHash,
                    flags, buildId): PacketWriter
decodeSessionConfig(r, out): SessionConfigMessage
```
Layout: `u8 id, u8 serverProtocol, u8 serverMinProtocol, u16 contentVersion, u32 contentHash,
u32 flags, str buildId` — 13 bytes plus the build id. Sent **once**, immediately after `WELCOME`.

`contentVersion` and `contentHash` are the ROOM's, pinned when it was constructed, so a room that
outlives a deploy keeps serving what its players joined for. `flags` is the feature-flag bitmask
**resolved server-side for this player** — bit *i* is `FLAG_ORDER[i]` in `shared/src/flags.ts`, and
the client never resolves a flag itself. A 33rd flag appends a second `u32` guarded by
`r.remaining >= 4`; this one is never widened. `buildId` is telemetry and gates nothing.

#### `UPDATE_REQUIRED` — a refusal the client can act on

```ts
interface UpdateRequiredMessage {
  reason, serverProtocol, serverMinProtocol, contentVersion, detail
}
createUpdateRequiredMessage(): UpdateRequiredMessage
encodeUpdateRequired(w, reason, serverProtocol, serverMinProtocol, contentVersion,
                     detail): PacketWriter
decodeUpdateRequired(r, out): UpdateRequiredMessage
```
Layout: `u8 id, u8 reason, u8 serverProtocol, u8 serverMinProtocol, u16 contentVersion,
str detail` — 6 bytes plus the detail (≤ 96). Sent immediately **before** the close, never after.

`reason` is `UpdateReason` (`shared/src/version.ts`). The same verdict also travels as the
**WebSocket close code** (4001 too old, 4002 too new, 4003 content, 4004 draining, 4005 revoked),
because a client old enough to need this message is by definition too old to decode it. `detail` is
diagnostic; what a player is shown comes from the client's own `UPDATE_REASON_TEXT`, so a server can
never put a string on a player's screen.

```ts
interface BlockDelta { x, y, z, id }
class BlockDeltaBuffer {
  constructor(capacity = MAX_BLOCK_DELTAS_PER_MESSAGE)
  count: number; ackEditSeq: number; capacity: number
  x: Int16Array; y: Uint8Array; z: Int16Array; id: Uint8Array
  reset(): void
  push(x, y, z, id): boolean       // false when full
}
encodeBlockDeltas(w, b): PacketWriter
decodeBlockDeltas(r, out): BlockDeltaBuffer
```
Layout: `u8 id, u32 ackEditSeq, u16 count, count × (i16 x, u8 y, i16 z, u8 blockId)` — 6 bytes
per edit. `ackEditSeq` is the newest edit seq from this client the server has applied; the
client drops predicted edits up to and including it.

```ts
interface DamageEvent { attackerId, victimId, amount, weaponId, flags, dirX, dirY, dirZ,
                        healthAfter, armorAfter }
createDamageEvent(): DamageEvent
encodeDamage(w, attackerId, victimId, amount, weaponId, flags, dirX, dirY, dirZ,
             healthAfter, armorAfter): PacketWriter
decodeDamage(r, out): DamageEvent

interface KillEvent { killerId, victimId, weaponId, flags, killerStreak }
createKillEvent(): KillEvent
encodeKill(w, killerId, victimId, weaponId, flags, killerStreak): PacketWriter
decodeKill(r, out): KillEvent

interface ChatMessage { senderId, channel, text }
createChatMessage(): ChatMessage
encodeChatS2C(w, senderId, channel, text): PacketWriter
decodeChatS2C(r, out): ChatMessage

interface PongMessage { clientTimeMs, serverTimeMs, tick }
createPongMessage(): PongMessage
encodePong(w, clientTimeMs, serverTimeMs, tick): PacketWriter
decodePong(r, out): PongMessage
```
`DamageEvent` is sent to the victim (with `DMG_YOU_ARE_VICTIM`) and to the attacker (without
it) so the attacker can draw a hit marker. `dirX/Y/Z` is the unit vector from attacker to
victim — the directional hurt indicator.

### Snapshots

```
u8  S2C.SNAPSHOT
u32 tick
u32 baselineTick        (0 = absolute / full)
u32 ackInputSeq         last input from THIS client the server simulated
u32 ackEditSeq          last block edit from THIS client the server applied
u16 localId             entity id of THIS client
u8  flags               SNAP_*
u8  playerCount   , then playerCount   × { u16 id, u16 mask, <fields> }
u16 entityCount   , then entityCount   × { u16 id, u16 mask, <fields> }
u16 projectileCount,then projectileCount × { u16 id, u16 mask, <fields> }
```

Field masks (payload appears in bit order, low to high):

| Player bit | Payload |
|---|---|
| `PF_SPAWN` (1) | `str name`, `u8 skin` |
| `PF_REMOVED` (2) | – |
| `PF_POS` (4) | `i16 x, i16 y, i16 z` |
| `PF_YAW` (8) | `u16` |
| `PF_PITCH` (16) | `i16` |
| `PF_VEL` (32) | `i16 vx, i16 vy, i16 vz` |
| `PF_HEALTH` (64) | `u8` |
| `PF_ARMOR` (128) | `u8` |
| `PF_WEAPON` (256) | `u8` |
| `PF_STATE` (512) | `u8` (PS_* bits) |
| `PF_AMMO` (1024) | `u16 mag, u16 reserve` — local player only |
| `PF_SCORE` (2048) | `u16 kills, u16 deaths` |
| `PF_TEAM` (4096) | `u8` |
| `PF_LOCAL` (8192) | – (this record is you) |

| Entity bit | Payload | | Projectile bit | Payload |
|---|---|---|---|---|
| `EF_SPAWN` (1) | `u8 type, u8 variant` | | `RF_SPAWN` (1) | `u8 weapon, u16 owner` |
| `EF_REMOVED` (2) | `u8 reason` | | `RF_REMOVED` (2) | `u8 reason` |
| `EF_POS` (4) | `i16 ×3` | | `RF_POS` (4) | `i16 ×3` |
| `EF_YAW` (8) | `u16` | | `RF_VEL` (8) | `i16 ×3` |
| `EF_HEALTH` (16) | `u16` | | | |
| `EF_STATE` (32) | `u8` | | | |
| `EF_VEL` (64) | `i16 ×3` | | | |

Convenience masks: `PF_ALL`, `EF_ALL`, `RF_ALL` (every field bit a baseline-free record must carry).

```ts
class SnapshotBuffer {
  constructor(maxPlayers = MAX_PLAYERS, maxEntities = MAX_ENTITIES, maxProjectiles = MAX_PROJECTILES)

  tick, baselineTick, ackInputSeq, ackEditSeq, flags, localId: number

  playerCount: number
  playerId, playerMask: Uint16Array
  playerX, playerY, playerZ, playerVX, playerVY, playerVZ, playerYaw, playerPitch: Float32Array
  playerHealth, playerArmor, playerWeapon, playerState, playerTeam, playerSkin: Uint8Array
  playerMag, playerReserve, playerKills, playerDeaths: Uint16Array
  playerName: string[]

  entityCount: number
  entityId, entityMask, entityHealth: Uint16Array
  entityType, entityVariant, entityState, entityReason: Uint8Array
  entityX, entityY, entityZ, entityVX, entityVY, entityVZ, entityYaw: Float32Array

  projectileCount: number
  projId, projMask, projOwner: Uint16Array
  projWeapon, projReason: Uint8Array
  projX, projY, projZ, projVX, projVY, projVZ: Float32Array

  maxPlayers, maxEntities, maxProjectiles: number

  reset(): void                    // zeroes the counts, keeps the arrays
  indexOfPlayer(id) | indexOfEntity(id) | indexOfProjectile(id): number   // -1 when absent
  addPlayer(id) | addEntity(id) | addProjectile(id): number               // slot index, -1 when full
}

encodeSnapshot(w, s: SnapshotBuffer): PacketWriter
decodeSnapshot(r, out: SnapshotBuffer): SnapshotBuffer
playerDeltaMask(base: SnapshotBuffer, bi: number, next: SnapshotBuffer, ni: number): number
copyPlayerRecord(src, si, dst, di): void
```

Struct-of-arrays, allocation-free after construction. The **server** keeps one
`SnapshotBuffer` per connection as the delta baseline plus one scratch buffer for the outgoing
frame; `playerDeltaMask` compares **quantised** values, so "changed" means the same thing to
both sides and sub-quantum jitter costs zero bytes. `PF_SPAWN`, `PF_REMOVED`, `PF_LOCAL` and
`PF_AMMO` are policy bits the server ORs in itself.

**Who is sent, and what absence means.** Players and projectiles appear in **every** snapshot, so
for those two a missing record still means *gone*. **Entities do not**: they are delta-coded
against a per-connection baseline (`Connection.entBase*`, keyed by sim slot and validated by
`knownEntityGen`) and an entity whose quantised state has not changed since that client's last
snapshot is **omitted entirely** — a missing entity record means *unchanged*, never *removed*.
Removal is only ever `EF_REMOVED`. A client must therefore apply **only** the fields whose mask bit
is set (`decodeSnapshot` fills its buffer positionally, so an unmasked field holds whatever entity
occupied that record index last time) and may prune unseen entities **only** on a `SNAP_FULL`
snapshot, which does enumerate every entity. Two consequences worth knowing:

- A pickup's `EF_YAW` is never transmitted. `Simulation.stepPickups` spins it server-side and no
  client reads it; the renderer spins pickups off its own clock.
- The per-connection baseline advances at **send** time, not on an ack, which is exact on `ws` and
  on the Worker MessagePort. The peer-host WebRTC transport carries snapshots on an unreliable
  channel and repairs a detected gap by setting `conn.baselineTick = 0` (a full snapshot). That
  repair is load-bearing: an omitted entity or a dropped `EF_REMOVED` is no longer self-healing on
  the next tick.

The **client** decodes into one long-lived `SnapshotBuffer`: only fields whose mask bit is set
were transmitted, every other field keeps its previous value — so decode into the buffer that
already holds the last known state, then apply it to the interpolation ring.

A full snapshot of two players (one complete + one partial) is 75 bytes.

---

## 6. `client/index.html` — the DOM contract

Layers, z-order, and who owns what:

| Element | z | Owner | Notes |
|---|---|---|---|
| `<canvas id="game">` | 0 | renderer | `position: fixed; inset: 0`. Set `width`/`height` in device pixels yourself; CSS keeps it full-bleed. `tabindex="0"` so it can hold focus for pointer lock. |
| `#hud` | 10 | HUD | `pointer-events: none`, `contain: layout style`. Has `data-mode` (`idle` initially). |
| `#ads` | 20 | ads | `data-mode="menu" \| "game" \| "off"`. Slots vanish in `game`/`off`. |
| `#ui` | 30 | menus | `pointer-events: none`; direct children get `auto` automatically. Has `data-screen="boot"`. |
| `#ad-overlay` | 40 | ads | Fullscreen interstitial / rewarded surface. Show with `data-open="1"`. |
| `#boot` | 100 | loader | Loading screen, painted before any script. |

Ad slots (children of `#ads`, class `.ad-slot`):

| id | desktop | mobile (≤900 px) |
|---|---|---|
| `#ad-slot-top` | 728×90, top centre | 320×50 |
| `#ad-slot-side` | 300×250, right centre | hidden |
| `#ad-slot-bottom` | 728×90, bottom centre | 320×100 |

Each slot is a hard-sized box with `contain: strict` and carries `data-w`/`data-h` and
`data-w-mobile`/`data-h-mobile`. **Filling a slot cannot reflow anything.** Sizes are mirrored
in `AD_SLOT_SIZES`; change both or neither.

Boot screen elements: `#boot` (add class `is-done` to fade, then set `hidden`),
`#boot-bar` (set `style.width = pct + '%'`), `#boot-pct`, `#boot-status`.

`window.__DC_T0__` is a `performance.now()` stamp taken before the module script — use it to
measure time-to-interactive against the 3.00 s budget.

Everything is inline: no webfonts, no external stylesheets, no third-party script tags in the
document. The bundle is the only network dependency of the first frame.

---

## 7. `client/vite.config.ts` — facts other agents rely on

- `root` = `client/`, `base` = `'./'`.
- Aliases: `@shared` → `shared/src/index.ts`, `@shared/*` → `shared/src/*`, `@/*` → `client/src/*`.
- `build.target = 'esnext'`, output `<repo>/dist`, assets under `dist/a/`.
- `worker.format = 'es'` — write workers as `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`.
- `three` is force-split into its own chunk.
- Dev server: port **5173**, `strictPort`, host exposed, `/ws` proxied to `ws://localhost:8080` with `ws: true`. Connect to `` `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` `` and it works in dev and in production.
- `server.fs.allow` includes the repo root so `shared/src` is servable in dev.

---

## 8. Rules

1. **Only the contract owner edits `shared/`.** Everyone else imports.
2. No allocation in per-frame or per-tick paths. Reuse `PacketWriter`, `PacketReader`,
   `SnapshotBuffer`, `InputCommand`, `VoxelHit`. Every decode function takes an `out` argument
   for exactly this reason.
3. Typed arrays over object arrays anywhere a loop runs more than a few hundred times.
4. Positions are metres, angles are radians, times are milliseconds unless a name says
   otherwise (`*Ms` suffix = milliseconds, bare `dt` = seconds).
5. The voxel index order, the quantisation scales and `shouldRenderFace` are load-bearing for
   determinism. Changing any of them is a protocol break: bump `PROTOCOL_VERSION`.
6. Client prediction and server simulation call the **same** functions — `moveAABB`,
   `applyShotSpread`, `recoverSpread`, `currentSpread`, `damageAtDistance`, `coneSpread` — with
   the same inputs. Do not reimplement any of them locally.
