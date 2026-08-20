# DOOMCRAFT — the mode framework API

**This document plus the seven source files it describes are the whole contract.** The four mode
builders (Quest, Builder, Horde, Deathmatch) code against this and nothing else. Everything here is
implemented, typechecked (`npx tsc -b` → 0) and covered by `shared/src/level.test.ts` (31 tests).

| File | Owns |
|---|---|
| `shared/src/modes.ts` | `ModeId`, the `MODES` rule table, skill, keycards, the protocol extension |
| `shared/src/level.ts` | the level format: source → compile → binary → validate |
| `shared/src/saves.ts` | per-mode save slots, schema v2, migration from v1 |
| `client/src/modes/registry.ts` | mode lifecycle, `ModeScope` teardown ledger, the active mode |
| `client/src/ui/modeSelect.ts` | the four tiles + level/world/skill pickers |
| `server/src/modes.ts` | sim plan, join routing, room config, the state sidecar |
| `server/src/levels.ts` | loading, validating, serving and stamping levels |
| `content/levels/e1m1-hangar.json` | a real playable level: keycard, locked door, secret, exit switch |

## 0. Import paths

```ts
// client/**
import { ModeId, MODES, getMode }        from '@shared/modes';
import { compileLevel, decodeLevel }     from '@shared/level';
import { loadSave, migrateSave }         from '@shared/saves';
import { ModeRegistry }                  from '@/modes/registry';
import { createModeSelect }              from '@/ui/modeSelect';

// server/**
import { ModeId, MODES, getMode }        from '@doomcraft/shared/modes';
import { validateLevel }                 from '@doomcraft/shared/level';
import { resolveModePlan, ModeRouter }   from './modes.js';
import { levelLibrary }                  from './levels.js';
```

These three modules are **not** in the `shared/src/index.ts` barrel — import them by sub-path. On the
server that is `@doomcraft/shared/modes`, which the package `exports` map resolves to
`shared/src/modes.ts` (the same mechanism `@doomcraft/shared/protocol` already uses).

---

# 1. `shared/src/modes.ts`

## 1.1 Identity

```ts
enum ModeId { QUEST = 0, BUILDER = 1, HORDE = 2, DEATHMATCH = 3 }
const MODE_COUNT = 4;
const MODE_KEYS: readonly string[];               // ['quest','builder','horde','deathmatch']
const MODE_MENU_ORDER: readonly ModeId[];         // [QUEST, HORDE, DEATHMATCH, BUILDER]

function modeFromKey(key: string): ModeId | -1;
function isModeId(v: number): v is ModeId;
function getMode(id: number): ModeDef;            // never throws; falls back to DEATHMATCH
function modeName(id: number): string;
function modeKey(id: number): string;
function legacyGameMode(id: number): GameMode;    // ModeId -> the frozen 3-way GameMode
```

`ModeId` is **not** `GameMode` from `constants.ts`. `GameMode` (`DEATHMATCH/HORDE/SANDBOX`) is the
frozen three-way switch `Room` already takes; `legacyGameMode()` maps across it so a `ModeId` can be
handed to the existing room constructor. Quest and Builder both map to `GameMode.SANDBOX`, and the
mode layer supplies the real rules on top.

## 1.2 The rule table

```ts
const MODES: readonly ModeDef[];   // indexed by ModeId
```

`ModeDef` fields, all `readonly`:

| Field | Type | Meaning |
|---|---|---|
| `id` `key` `name` `tagline` `blurb` `bar` `accent` | | identity + menu copy; `accent` is packed `0xRRGGBB` |
| `pvp` | `PvpPolicy` | `OFF` / `FREE_FOR_ALL` / `COOP` |
| `build` | `BuildPolicy` | `NONE` / `PHASED` / `FREE` / `CREATIVE` |
| `break` | `BreakPolicy` | `NONE` / `WEAPONS_ONLY` / `FULL` / `INSTANT` |
| `respawn` | `RespawnPolicy` | `INSTANT` / `DELAYED` / `NEXT_WAVE` / `CHECKPOINT` / `PERMADEATH` |
| `enemies` | `EnemyPolicy` | `NONE` / `AMBIENT` / `WAVES` / `AUTHORED` |
| `round` | `RoundStructure` | `ENDLESS` / `TIMED` / `WAVES` / `LEVEL` |
| `world` | `WorldSource` | `GENERATED` / `AUTHORED` / `PERSISTENT` |
| `inventory` | `InventoryStyle` | `PICKUP` / `LOADOUT` / `CREATIVE` |
| `win` | `WinCondition` | `NONE` / `EXIT_REACHED` / `SCORE_LIMIT` / `SURVIVE_WAVES` |
| `systems` | `number` | OR of the `SYS_*` bits |
| `botFill` `enemyBudget` `durationMs` `scoreLimit` `respawnDelayMs` | `number` | `-1` enemyBudget = the level decides; `0` duration/scoreLimit = none |
| `buildPhaseMs` `buildDuringCombat` `blockBudget` `finalWave` | | Horde; `finalWave` 0 = endless |
| `startWeaponMask` `startWeapon` `maxPlayers` `coopPlayers` | | `coopPlayers` 1 means no co-op |
| `needsLevelPicker` `needsWorldPicker` `needsSkillPicker` `ribbon` `badge` `creativeFlight` | | menu |

The four rows as shipped:

| | QUEST | BUILDER | HORDE | DEATHMATCH |
|---|---|---|---|---|
| bar | DOOM 1993 E1M1 | Minecraft Classic | DOOM pressure + our Builder | voxiom.io BR |
| pvp | `OFF` | `OFF` | `COOP` | `FREE_FOR_ALL` |
| build / break | `NONE` / `WEAPONS_ONLY` | `CREATIVE` / `INSTANT` | `PHASED` / `FULL` | `FREE` / `FULL` |
| respawn | `CHECKPOINT` | `INSTANT` | `NEXT_WAVE` | `DELAYED` (1400 ms) |
| enemies | `AUTHORED` | `NONE` | `WAVES` | `AMBIENT` (3) |
| round / win | `LEVEL` / `EXIT_REACHED` | `ENDLESS` / `NONE` | `WAVES` / `SURVIVE_WAVES` | `TIMED` / `SCORE_LIMIT` |
| world | `AUTHORED` | `PERSISTENT` | `GENERATED` | `GENERATED` |
| inventory | `PICKUP` | `CREATIVE` | `PICKUP` (+shotgun) | `PICKUP` |
| bots / max players | 0 / 4 | 0 / 16 | 0 / 4 | 6 / 32 |
| clock / score limit | — | — | — | 8 min / 30 |
| build phase / budget | — | — | 30 s / 120 blocks | — |
| pickers | level + skill | world | skill | — |
| ribbon | — | — | **MOST POPULAR** | — |

Derived predicates, so nobody re-derives them wrongly:

```ts
allowsPlacing(id) allowsBreaking(id) allowsPvp(id) allowsCoop(id)
usesAuthoredLevel(id) usesPersistentWorld(id) hasRoundClock(id) hasBuildPhase(id)
```

### The sim-system mask

```
SYS_BOTS SYS_MONSTERS SYS_MONSTER_DIRECTOR SYS_WAVE_DIRECTOR SYS_PICKUPS
SYS_ROUND_TIMER SYS_SCORE_LIMIT SYS_PVP_DAMAGE SYS_BLOCK_ECONOMY SYS_LEVEL_SCRIPT
SYS_WORLD_PERSISTENCE SYS_FALL_DAMAGE SYS_HAZARDS SYS_KILLFEED SYS_INTERMISSION
SYS_TERRAIN_DAMAGE
hasSystem(mask, bit): boolean
systemNames(mask): string[]        // cold path, for /api/status
SYS_NAMES: readonly string[]
```

**Rule: outside `shared/src/modes.ts` and `server/src/modes.ts`, never branch on the mode id to
decide behaviour.** Read the flag. If the flag you need is missing, add a field to `ModeDef` — that
is the whole point of the table.

## 1.3 Skill and keycards

```ts
enum Skill { TOO_YOUNG_TO_DIE, HEY_NOT_TOO_ROUGH, HURT_ME_PLENTY, ULTRA_VIOLENCE, NIGHTMARE }
const SKILL_COUNT = 5;
const SKILL_NAMES, SKILL_SHORT_NAMES: readonly string[];    // "Ultra-Violence" / "UV"
const DEFAULT_SKILL = Skill.HURT_ME_PLENTY;
function clampSkill(v: number): Skill;

const SKILL_DAMAGE_TAKEN:     Float32Array;  // [0.5, 0.75, 1, 1, 1]      multiply incoming damage
const SKILL_ENEMY_INTERVAL:   Float32Array;  // [1.6, 1.25, 1, 0.8, 0.55] multiply attack cadence
const SKILL_PICKUP_SCALE:     Float32Array;  // [2, 1.5, 1, 1, 1]         multiply pickup amounts
const SKILL_ENEMY_BONUS:      Float32Array;  // [0, 0, 0, 0.25, 0.6]      extra monsters, fraction
const SKILL_RESPAWN_MONSTERS: Uint8Array;    // [0,0,0,0,1]               Nightmare only
```

```ts
enum KeyColor { NONE = 0, BLUE = 1, YELLOW = 2, RED = 3 }
const KEY_NAMES: readonly string[];   // ['', 'Blue', 'Yellow', 'Red']
const KEY_COLORS: Uint32Array;        // packed 0xRRGGBB per colour
function keyBit(color: number): number;               // 0 for NONE
function hasKey(mask: number, color: number): boolean; // true for NONE
function keyNameOf(color: number): string;
```

The key ring is a **bitmask**, cleared at the start of every level (Doom's rule).

## 1.4 Protocol extension

Three new server→client ids and two client→server ids on the **existing** wire — same
`PacketWriter`/`PacketReader`, same little-endian layout, same one-uint8 message header. Ids start at
16 so `C2S` (1..6) and `S2C` (1..8) have room to grow.

```ts
enum C2S_MODE { SELECT = 16, ACTION = 17 }
enum S2C_MODE { STATE  = 16, EVENT  = 17, CONTEXT = 18 }
const MODE_PROTOCOL_VERSION = 1;
function isModeMessage(id: number): boolean;   // true for 16..18 — lets a dispatcher fall through
```

Route them with the existing `readMessageId(data)`.

### `C2S_MODE.SELECT` — mode select on join

```ts
interface ModeSelectMessage { modeId; skill; flags; seed; levelId; worldId }
createModeSelectMessage(): ModeSelectMessage
encodeModeSelect(w: PacketWriter, m: ModeSelectMessage): PacketWriter
decodeModeSelect(r: PacketReader, out: ModeSelectMessage): ModeSelectMessage
```

Layout: `u8 id, u8 protoVer, u8 modeId, u8 skill, u16 flags, u32 seed, str levelId, str worldId`.

`decodeModeSelect` **sanitises as it decodes**: an unknown mode becomes `DEATHMATCH`, skill is
clamped, and both ids go through `sanitiseContentId`. The result is always safe to act on — in
particular `"../../etc/passwd"` decodes as `"etcpasswd"`, so a level id can never be a path.

```ts
const MAX_CONTENT_ID_LENGTH = 48;
const CONTENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
function isContentId(v: string): boolean;
function sanitiseContentId(v: string): string;   // '' when nothing legal survives
```

Flags: `MSF_JOIN_EXISTING` `MSF_COOP` `MSF_NO_BOTS` `MSF_CONTINUE` `MSF_FRESH`.

Send it **after** `C2S.HELLO`; the server may also accept it at any time to change level or world.

### `C2S_MODE.ACTION` — the per-mode verbs

```ts
enum ModeAction {
  USE = 0,        // press the block you are looking at: switch, door, lever
  READY = 1,      // ready up / skip the build phase
  BUY = 2,        // Horde shop; a = item id, b = quantity
  UNDO = 3, REDO = 4,          // Builder
  NEXT_LEVEL = 5, RESTART = 6, // Quest intermission
  TOGGLE_FLIGHT = 7,           // Builder
  SET_SKILL = 8,               // only legal from an intermission
  WARP = 9,                    // Builder bookmark, a = index
}
interface ModeActionMessage { action; a; b; x; y; z; seq }
createModeActionMessage / encodeModeAction / decodeModeAction
```

Layout: `u8 id, u8 action, u16 a, u16 b, i16 x, u8 y, i16 z, u32 seq`.
`seq` comes back in `ModeStateBuffer.ackActionSeq`, so a client knows the server acted.

### `S2C_MODE.STATE` — the snapshot sidecar

The per-mode state does **not** change the SNAPSHOT layout. The server writes one STATE packet
immediately before the `S2C.SNAPSHOT` of the same tick, and only when a field changed. Fixed
`MODE_STATE_BYTES = 40` bytes including the id, so at 20 Hz the worst case is 800 B/s.

```ts
class ModeStateBuffer {
  modeId; phase; skill; flags;
  phaseMsLeft; elapsedMs;
  index; score;
  a; aTotal; b; bTotal; c; cTotal;
  budget; keys; lives; ackActionSeq;
  reset(): void;
  copyFrom(o: ModeStateBuffer): void;
}
function modeStateChanged(a, b): boolean;   // 100 ms granularity on the two clocks
encodeModeState(w, s) / decodeModeState(r, out)
```

Per-mode meaning of the generic fields:

| field | Quest | Builder | Horde | Deathmatch |
|---|---|---|---|---|
| `phase` | live / intermission | always live | build / live | waiting / live |
| `phaseMsLeft` | 0 | 0 | build window left | round clock left |
| `index` | level index in episode | 0 | wave number | round number |
| `score` | 0 | blocks placed | currency | leader's frags |
| `a` / `aTotal` | kills / total kills | 0 | wave kills / wave total | frags / limit |
| `b` / `bTotal` | items / total items | 0 | 0 | 0 |
| `c` / `cTotal` | secrets / total secrets | 0 | 0 | 0 |
| `budget` | 0 | 0 | blocks left to place | 0 |
| `keys` | keycard mask | 0 | 0 | 0 |
| `lives` | 255 (unlimited) | 255 | downs left | 255 |

Flags: `MST_PAUSED` `MST_LOCAL_FINISHED` `MST_OBJECTIVE_DONE` `MST_FAILED` `MST_CAN_BUILD`
`MST_WAVE_ACTIVE` `MST_EXIT_OPEN` `MST_MONSTERS_RESPAWN`.

`ModePhase` = `LOADING | WAITING | BUILD | LIVE | INTERMISSION | GAME_OVER` (`MODE_PHASE_NAMES`).

### `S2C_MODE.EVENT` — one-shots

```ts
enum ModeEventKind {
  SECRET_FOUND, KEY_TAKEN, DOOR_LOCKED, DOOR_OPENED, SWITCH_USED,
  WAVE_INCOMING, WAVE_CLEARED, BUILD_PHASE, LEVEL_COMPLETE, LEVEL_FAILED,
  PAYOUT, OBJECTIVE, WEAPON_TAKEN,
}
interface ModeEventMessage { kind; playerId; a; b; c; text }   // text ≤ MAX_MODE_EVENT_TEXT (96)
```

### `S2C_MODE.CONTEXT` — what is loaded

Sent once at join and again whenever the room changes level or world, so the client can fetch the
right content and theme the sky, fog and ambient light **before the first chunk lands**.

```ts
interface ModeContextMessage {
  modeId; skill; levelId; worldId; title;
  contentHash;      // FNV-1a of the encoded .dcl — a client cache can trust it
  parTimeSec; skyColor; fogColor; ambient; maxPlayers;
}
```

`ambient` is quantised to a byte on the wire; everything else is exact.

## 1.5 Rooms and intermission

```ts
function roomKeyFor(m: ModeSelectMessage): string;
//  quest     -> "quest:<levelId>:<skill>"
//  builder   -> "builder:<worldId>"
//  horde     -> "horde"
//  deathmatch-> "deathmatch"

interface IntermissionStats { levelId levelName kills killsTotal items itemsTotal
                              secrets secretsTotal timeSec parSec newRecord }
createIntermissionStats(): IntermissionStats
intermissionFromState(s, levelId, levelName, parSec, newRecord): IntermissionStats
percentOf(got, total): number      // integer 0..100; 100 when total is 0
formatTime(seconds): string        // "1:45"
```

---

# 2. `shared/src/level.ts` — THE LEVEL FORMAT

Three representations, one truth:

```
   *.json  ──parseLevelSource──▶ LevelSource ──compileLevel──▶ Level ──encodeLevel──▶ *.dcl
                                                                 ▲                      │
                                                                 └────decodeLevel───────┘
```

* **`LevelSource`** is what a human writes. Geometry is a list of **brushes** — nobody hand-writes
  589,824 voxels, and a brush list diffs readably in a pull request.
* **`Level`** is the runtime object. Brushes have been rasterised into a `LevelVolume` of full-height
  **32 × 64 × 32 sections that are byte-identical to an engine chunk**, so a section drops straight
  into `ServerWorld.chunks` and streams to clients over the *existing* `S2C.CHUNK` message. There is
  no new chunk protocol.
* **`.dcl`** is the compact binary: RLE'd sections (reusing `protocol.ts`'s run coder) plus a
  fixed-layout header and entity tables. Shipped E1M1: 9 sections, 248,439 solid voxels, **15.5 KB**.

`decodeLevel(encodeLevel(l))` is **byte identical**, not merely close: every authored float goes out
as `f64`. A level that drifted on a round trip would play differently on the server than in the
editor.

## 2.1 Constants

```ts
LEVEL_MAGIC_BYTES         // 'D','C','L','1'
LEVEL_FORMAT_VERSION = 1  // decodeLevel refuses anything else
LEVEL_SOURCE_VERSION = 1
MAX_LEVEL_BRUSHES = 4096  MAX_LEVEL_ENTITIES = 1024  MAX_LEVEL_SECTIONS = 512
MAX_PATROL_POINTS = 32    MAX_SWITCH_TARGETS = 16    MAX_LEVEL_STRING = 4096
MAX_REACH_CELLS = 24_000_000   // above this the reachability solve is skipped with a warning
REACH_MAX_DROP = 16            // blocks the solver will walk off
REACH_USE_RADIUS = 4           // how close you must get to throw a switch
```

## 2.2 Authoring: the JSON source

Top level: `{ sourceVersion, meta, bounds, brushes[], spawns[], enemies[], pickups[], doors[],
switches[], secrets[], exit }`. Keys beginning `//` are ignored, so a level file can carry comments.

`parseLevelSource(input: unknown)` and `parseLevelJson(text: string)` **never throw**. Every field is
coerced, clamped and defaulted; unknown enum names fall back. Blocks, enemies, weapons, ammo and key
colours may be written as **names or numbers**:

```ts
blockIdFromName('tech_panel' | 'techpanel' | 19): number     blockNameOf(id): string
enemyTypeFromName('imp'|'zombie'|'cacodemon'|'baron'|'lost_soul'): number
pickupVariantFromName(kind, 'shotgun' | 'shells' | 'blue' | 'medikit' | 'green'): number
pickupVariantName(kind, variant): string
keyColorFromName('blue'): KeyColor
ENEMY_TYPE_NAMES  WEAPON_PICKUP_NAMES  AMMO_PICKUP_NAMES  KEY_PICKUP_NAMES  BRUSH_DIR_NAMES
```

### `meta`

```jsonc
"meta": {
  "id": "e1m1-hangar",            // lowercase slug; this is the level's identity everywhere
  "name": "Hangar",
  "episodeId": "e1", "episodeName": "Knee-Deep in the Blocks",
  "episodeIndex": 1, "levelIndex": 1,
  "author": "...", "description": "...",
  "parTimeSec": 105,              // the intermission grades against this
  "musicCue": "e1m1",
  "outsideBlock": "bedrock",      // everything outside the chunk rect
  "defaultSkill": 2,
  "palette": { "skyTop": "#120e18", "skyHorizon": "#2a1620", "fog": "#100d14",
               "fogNear": 18, "fogFar": 74, "ambient": 0.3, "sun": 0.42 }
}
```

Colours accept `"#rrggbb"` or a number. `ambient`/`sun` are 0..1.

### `bounds`

```jsonc
"bounds": { "minCX": 0, "minCZ": 0, "maxCX": 2, "maxCZ": 2 }
```

Inclusive **chunk** rect on the engine's grid, clamped to `WORLD_MIN_CHUNK..WORLD_MAX_CHUNK`.
Sections are always full height (`y` 0..63). A 3 × 3 rect is 96 × 64 × 96 blocks.

### `brushes` — the geometry

Applied in order; later brushes overwrite earlier ones.

```ts
enum BrushKind { BOX = 0, HOLLOW = 1, CYLINDER = 2, STAIRS = 3, CLEAR = 4 }
```

| Field | Meaning |
|---|---|
| `kind` | name or number |
| `block` | primary block (name or id) |
| `block2` / `floor` | HOLLOW floor material, STAIRS top tread; omit for "same as `block`" |
| `x` `y` `z` | minimum corner, world block coordinates |
| `w` `h` `d` | size in blocks, each ≥ 1 |
| `thickness` / `wall` | HOLLOW/CYLINDER wall thickness; **STAIRS rise per step** |
| `dir` / `axis` | STAIRS direction: `"+x"` `"-x"` `"+z"` `"-z"` (or 0..3) |
| `openTop` `openBottom` `openNX` `openPX` `openNZ` `openPZ` | HOLLOW: leave that face out — this is how rooms connect |
| `keepInterior` | HOLLOW: stamp the shell only |
| `onlyAir` | write only where the volume currently holds air |

Semantics:

* `BOX` — solid box of `block`.
* `CLEAR` — set the box to air.
* `HOLLOW` — fill the box, then carve the interior to air (unless `keepInterior`), leaving `thickness`
  walls. With `block2` set, the bottom `thickness` layers are repainted with it.
* `CYLINDER` — the ellipse inscribed in the box, extruded over `h`. `thickness > 0` makes it a tube.
* `STAIRS` — one column per step along `dir`, step *s* rising `(s+1) * thickness` blocks. `w` (for
  ±x) or `d` (for ±z) is the step count, and `h` must be at least `steps * thickness`.

The Doom way, and what E1M1 does: **brush 0 fills the whole volume with stone**, then every room is a
`CLEAR` carved out of that mass. A `CLEAR` inside solid rock can never leak into a void.

### `spawns`

```jsonc
{ "kind": "player" | "coop" | "deathmatch" | "teleport", "x": 16.5, "y": 8, "z": 10.5,
  "yaw": 3.14159, "index": 0 }
```

`y` is the **feet** cell; `x`/`z` are the AABB centre (so `.5` values sit in the middle of a block).
Yaw follows `shared/src/math.ts`: **0 looks down −Z**, `π/2` looks down −X, `π` looks down +Z.
`index` orders co-op and deathmatch starts.

### `enemies`

```jsonc
{ "id": "i-floor-1", "type": "imp", "x": 13.5, "y": 8, "z": 52.5, "yaw": 3.14159,
  "minSkill": 0, "maxSkill": 4,
  "trigger": "sight",            // always | sight | proximity | switch | area | door
  "radius": 15,                  // PROXIMITY
  "triggerId": "d-blue",         // SWITCH / AREA / DOOR — the classic ambush
  "ambush": true,                // wakes on sight only, ignores noise
  "pingpong": false,             // patrol back and forth instead of looping
  "countsAsKill": true,          // default true; clears it for scenery
  "patrol": [[16.5,8,33.5],[16.5,8,42.5]],
  "dropId": "k-blue" }           // spawn this pickup where it dies
```

`type` is one of `EntityType.IMP | ZOMBIE | CACODEMON | BARON | LOST_SOUL`. Runtime flags:
`EN_AMBUSH`, `EN_PATROL_PINGPONG`, `EN_COUNTS_AS_KILL`. `patrol` is flattened to
`[x,y,z, x,y,z, …]` in the compiled `LevelEnemy`.

### `pickups`

```jsonc
{ "id": "p-shotgun", "kind": "weapon", "variant": "shotgun", "amount": 0,
  "x": 24.5, "y": 8.1, "z": 50.5, "minSkill": 0, "maxSkill": 4,
  "countsAsItem": true, "secret": false, "noRespawn": false }
```

| `kind` | `variant` |
|---|---|
| `health` | `bonus` `stimpack` `medikit` `soulsphere` (0..3) |
| `armor` | `bonus` `green` `blue` (0..2) |
| `ammo` | `bullets` `shells` `rockets` `cells` (`AmmoType`) |
| `weapon` | `pistol` `shotgun` `chaingun` `rocket` `plasma` `bfg` `chainsaw` (`WeaponId`) |
| `key` | `blue` `yellow` `red` (`KeyColor`) |
| `backpack` | — |

`amount` 0 means "the kind's default". Flags: `PU_COUNTS_AS_ITEM` (default on except for keys),
`PU_IN_SECRET`, `PU_NO_RESPAWN`.

### `doors`, `switches`, `secrets`, `exit`

```jsonc
"doors": [{ "id": "d-blue", "x": 44, "y": 8, "z": 56, "w": 1, "h": 4, "d": 3,
            "key": "blue", "block": "metal", "frameBlock": "tech_panel",
            "openMs": 700, "stayMs": 0,
            "switchOnly": false, "startOpen": false, "autoClose": false, "secret": false,
            "lockedMessage": "You need the blue keycard." }],

"switches": [{ "id": "sw-exit", "x": 88, "y": 10, "z": 60,
               "face": 1,                  // blocks.ts Face, or -1 for any
               "block": "tech_panel", "activeBlock": "neon",
               "key": "none", "once": true, "hidden": false,
               "targets": ["exit"],        // door ids, and the literal "exit"
               "message": "The exit is live." }],

"secrets": [{ "id": "s-armoury", "x": 1, "y": 8, "z": 13, "w": 3, "h": 4, "d": 5,
              "message": "A secret is revealed!" }],

"exit": { "x": 84, "y": 8, "z": 58, "w": 4, "h": 3, "d": 5,
          "requiresSwitch": "sw-exit",     // "" = live from the start
          "nextLevelId": "",               // "" ends the episode
          "secret": false, "endsEpisode": true }
```

Door flags `DR_SWITCH_ONLY DR_START_OPEN DR_AUTO_CLOSE DR_SECRET`; switch flags `SW_ONCE SW_HIDDEN`;
exit flags `EX_SECRET EX_ENDS_EPISODE`.

`compileLevel` stamps every door's volume with its `block` after all brushes, so **a door always
physically exists** even if the author forgot to carve the hole. Switch anchors are likewise stamped
with their `block`. A `SW_HIDDEN` switch made of the surrounding wall material is exactly Doom's fake
wall — that is how E1M1's secret is hidden.

## 2.3 `LevelVolume`

```ts
class LevelVolume {
  constructor(minCX, minCZ, maxCX, maxCZ, outsideBlock = BlockId.BEDROCK);
  readonly minCX, minCZ, maxCX, maxCZ, outsideBlock;
  readonly sections: Map<number, Uint8Array>;   // chunkKey(cx,cz) -> Uint8Array(CHUNK_VOLUME)
  readonly solidAt: (x,y,z) => boolean;         // bound; hand it to the shared AABB/raycast helpers
  readonly getBlockAt: (x,y,z) => number;

  get chunkCount / sizeX / sizeZ / minX / maxX / minZ / maxZ;
  containsChunk(cx, cz) / contains(x, y, z);
  section(cx, cz) / ensureSection(cx, cz) / materialise();
  get(x, y, z) / set(x, y, z, id) / fillBox(x0,y0,z0,x1,y1,z1,id,onlyAir?);
  countSolid() / clone();
}
```

`get()` returns `outsideBlock` outside the rect and below `y = 0`, and `AIR` above `CHUNK_HEIGHT`, so
a level is a sealed room with no special case in the collision code. Voxels are indexed with
`voxelIndex(x, y, z)` — the same locked storage order as everything else.

## 2.4 Binary layout (`.dcl`)

```
'D''C''L''1'                                   4 bytes
u16 formatVersion, u16 reserved
meta:   str16 × 7 (id,name,episodeId,episodeName,author,description,musicCue)
        u8 episodeIndex, u8 levelIndex, u8 defaultSkill, u8 outsideBlock, u16 parTimeSec
        u32 skyTop, u32 skyHorizon, u32 fogColor
        f64 fogNear, f64 fogFar, f64 ambient, f64 sunLight
volume: i16 minCX, i16 minCZ, i16 maxCX, i16 maxCZ, u16 sectionCount
        per section: i16 cx, i16 cz, u8 kind
                     kind 0 (uniform): u8 blockId
                     kind 1 (RLE):     u32 byteLength, then rleEncodeInto() bytes
spawns:   u16 n, then { u8 kind, f64 x,y,z, f64 yaw, u16 index }
enemies:  u16 n, then { str16 id, u8 type, f64 x,y,z,yaw, u8 minSkill, u8 maxSkill,
                        u8 trigger, f64 radius, str16 triggerId,
                        u16 patrolPoints, f64×3 each, u16 flags, str16 dropId }
pickups:  u16 n, then { str16 id, u8 kind, u8 variant, u16 amount, f64 x,y,z,
                        u8 minSkill, u8 maxSkill, u16 flags }
doors:    u16 n, then { str16 id, i32 x,y,z, u16 w,h,d, u8 key, u8 block, i16 frameBlock,
                        u16 openMs, u16 stayMs, u16 flags, str16 lockedMessage }
switches: u16 n, then { str16 id, i32 x,y,z, i8 face, u8 block, u8 activeBlock, u8 key,
                        u16 flags, u16 targetCount, str16 each, str16 message }
secrets:  u16 n, then { str16 id, i32 x,y,z, u16 w,h,d, str16 message }
exit:     u8 present; if 1 { i32 x,y,z, u16 w,h,d, str16 requiresSwitch, str16 nextLevelId, u16 flags }
```

`str16` is a `u16` byte length followed by UTF-8 (the base protocol's `str` caps at 255 bytes; level
descriptions do not). Sections are written in ascending `chunkKey` order, which is what makes the
encoding deterministic and the round trip byte-exact. A whole-air chunk costs **5 bytes**.

```ts
encodeLevel(level: Level, writer?: PacketWriter): Uint8Array   // pass a writer to reuse the buffer
decodeLevel(bytes: Uint8Array | ArrayBuffer): Level            // throws LevelDecodeError
isLevelBinary(bytes: Uint8Array): boolean                      // cheap magic sniff
hashLevelBytes(bytes: Uint8Array): number                      // FNV-1a, the content hash
class LevelDecodeError extends Error { readonly code: string }
//   E_MAGIC  E_VERSION  E_SECTIONS  E_SECTION_KIND  E_TRUNCATED
```

## 2.5 Validation — including the unreachable exit

```ts
validateLevel(level: Level, skill = Skill.HURT_ME_PLENTY): LevelValidation
solveReachability(level: Level, skill: number): ReachabilityReport
formatValidation(id: string, r: LevelValidation): string

interface LevelValidation { ok: boolean; errors: LevelIssue[]; warnings: LevelIssue[];
                            reach: ReachabilityReport; totals: LevelTotals }
interface LevelIssue { code: string; message: string; subject?: string }
interface ReachabilityReport { ran; exitReachable; visitedCells; keysFound; switchesFound;
                               unreachablePickups; unreachableSecrets; passes }
```

`ok` is `errors.length === 0`. **Warnings never block a level; errors always do.**

### How the reachability solve actually works

Not a graph of declared connections — a walk of the geometry.

1. Rasterise the volume into a byte grid: `solid`, `open`, `liquid`, or `door + index`.
2. Flood the **standable** cells from the player spawn. A cell is standable when it and the cell
   above are passable and the cell below is solid (or liquid — you can wade). Neighbours are the four
   horizontal directions with a **step up of 1**, level, or a **drop of up to `REACH_MAX_DROP`**;
   a step up also needs headroom over your own head. A closed door is a wall.
3. Collect every key within a cell of the flood and throw every switch within `REACH_USE_RADIUS`
   whose own key requirement is met. Throwing a switch opens the doors it names.
4. If anything new was collected, **flood again**. Repeat to a fixpoint.
5. The exit is reachable when the flood entered its sector **and** `requiresSwitch` was thrown.

This is directional, so a one-way drop is modelled correctly — E1M1's catwalk can drop you back into
the start room but you cannot climb up it, which is what makes its blue door a real lock.

Errors: `E_NO_ID` `E_BAD_BOUNDS` `E_OUT_OF_WORLD` `E_EMPTY` `E_DUP_ID` `E_DOOR_NO_ID`
`E_SWITCH_NO_ID` `E_BAD_TARGET` `E_SWITCH_OUTSIDE` `E_MISSING_KEY` `E_NO_SPAWN` `E_SPAWN_OUTSIDE`
`E_SPAWN_SOLID` `E_ENEMY_OUTSIDE` `E_ENEMY_TRIGGER` `E_PICKUP_OUTSIDE` `E_NO_EXIT` `E_EXIT_OUTSIDE`
`E_EXIT_SWITCH` `E_SPAWN_SEALED` **`E_EXIT_UNREACHABLE`**.

Warnings: `W_NO_NAME` `W_NO_PAR` `W_ENEMY_IN_SOLID` `W_PICKUP_IN_SOLID` `W_SECRET_UNREACHABLE`
`W_PICKUP_UNREACHABLE` `W_NO_SECRETS` `W_SWITCH_NO_TARGET` `W_REACH_SKIPPED`.

Cost: ~90 ms for the 3 × 3-chunk E1M1, per skill, on load only.

## 2.6 Queries, manifest, world stamping

```ts
enemyAppearsAtSkill(e, skill) / pickupAppearsAtSkill(p, skill)
levelTotals(level, skill): { enemies, items, secrets }     // the intermission denominators
spawnsOfKind(level, kind): LevelSpawn[]                    // sorted by index
primarySpawn(level): LevelSpawn                            // never null
findDoor(level, id) / findSwitch(level, id)

manifestEntryFor(level, bytes, validation): LevelManifestEntry
buildManifest(entries, nowMs): LevelManifest               // grouped into episodes
LEVEL_MANIFEST_VERSION = 1
levelToSourceSkeleton(level): LevelSource                  // entities only; brushes come back empty

interface LevelWorldTarget {                               // ServerWorld satisfies this structurally
  ensureChunk(cx, cz): Uint8Array;
  readonly surface: Int16Array;
  generation: number; editSerial: number;
}
applyLevelToWorld(level, world, minBlockX, minBlockZ, worldSizeBlocks): LevelApplyResult
```

`applyLevelToWorld` writes each section **in place** into the live chunk array (never replacing it,
so the world's internal chunk cache stays valid) and rebuilds the topmost-solid `surface` cache for
every column it touched. Chunks the level does not cover are untouched, so a level can be stamped
into generated terrain or into an empty world. Use `LevelLibrary.applyTo` on the server, which binds
the world constants for you.

> **Trap.** `ServerWorld.surfaceY` / `standableY` mean "the topmost solid block in this column", which
> for an *indoor* authored level is the rock above the ceiling, not the floor you walk on. Stamping
> E1M1 gives `surfaceY(16, 10) === 30` even though the floor is at `y = 7`. Never place a player, a
> monster or a pickup in a Quest level with `standableY` — use the level's own `spawns`, `enemies` and
> `pickups`, or `LevelLibrary.spawnFor(id)`. The surface cache is still rebuilt correctly and is still
> what the mesher and the minimap want; it just is not a floor finder indoors.

---

# 3. `shared/src/saves.ts`

```ts
const SAVES_VERSION = 2;                 // v1 = the flat SaveProgress in constants.ts
const SAVE_STORAGE_KEY   = 'doomcraft:saves';
const LEGACY_PROGRESS_KEY = 'doomcraft:progress';
```

```ts
interface SaveFile { version; updatedMs; profile; quest; builder; horde; deathmatch }
```

| Section | Contents |
|---|---|
| `profile` | `name skin xp level secondsPlayed adsRemoved createdMs lastMode` |
| `quest` | `activeSlot` + up to `MAX_QUEST_SLOTS` (6) `QuestSlot`s |
| `builder` | `activeWorldId` + up to `MAX_BUILDER_WORLDS` (24) `BuilderWorld`s |
| `horde` | `bestWave bestScore runs totalKills totalBlocksPlaced lastSkill maps[]` |
| `deathmatch` | `matches wins kills deaths bestStreak headshots damageDealt secondsPlayed favouriteWeapon weaponKills[7]` |

`QuestSlot` = `{ id name skill episodeId levelId createdMs updatedMs totalTimeSec deaths completed
loadout levels[] }` where `QuestLoadout` is what the marine carries **between** levels
(`health armor weaponMask weapon ammo[5] keys backpack` — Doom keeps the arsenal, drops the keys) and
each `QuestLevelRecord` is `{ levelId completed bestTimeSec kills killsTotal items itemsTotal
secrets secretsTotal deaths attempts firstClearedMs lastPlayedMs }`.

`BuilderWorld` = `{ id name seed createdMs updatedMs secondsPlayed blocksPlaced blocksBroken
editedChunks online shareCode swatch }`.

## 3.1 Migration

```ts
migrateSave(input: unknown, nowMs = 0): SaveFile
SAVE_MIGRATIONS: readonly SaveMigration[]     // [{ from: 1, to: 2, apply }]
toLegacyProgress(save): SaveProgress          // rebuild a v1 blob for code still on v1
```

**`migrateSave` is total.** `undefined`, a string, `[]`, a half-written v2 with a corrupt array — it
returns a valid `SaveFile` every time, and a migration that itself throws costs the player only that
section. v1 → v2 keeps every number: identity moves to `profile`, combat counters to `deathmatch`,
and `lastSeed`/`blocksPlaced`/`blocksBroken` become the player's first Builder world so their terrain
is still there. Adding v3 is one entry in `SAVE_MIGRATIONS` plus a bump of `SAVES_VERSION`.

## 3.2 Storage and updaters

```ts
interface SaveStorage { getItem(key): string | null; setItem(key, value): void }
class MemorySaveStorage implements SaveStorage        // tests, private mode, the server
loadSave(storage, nowMs?): SaveFile                   // reads the v1 key when no v2 doc exists
storeSave(storage, save, nowMs?): boolean             // false when the storage refused
```

Nothing in this module touches `localStorage`, `fetch` or the DOM — inject the storage.

```ts
// Quest
activeQuestSlot(save): QuestSlot | null
beginQuest(save, episodeId, levelId, skill, nowMs): QuestSlot   // reuses a matching slot
questLevelRecord(slot, levelId): QuestLevelRecord
recordQuestLevel(save, slot, result: QuestLevelResult, nowMs): boolean   // true on a personal best
questCompletion(slot): number                          // percent
isLevelCleared(save, episodeId, levelId): boolean

// Builder
findBuilderWorld(save, id) / addBuilderWorld(save, name, seed, nowMs)
removeBuilderWorld(save, id) / recordBuilderSession(save, result, nowMs)
builderWorldsByRecency(save): BuilderWorld[]

// Horde / Deathmatch
recordHordeRun(save, result: HordeRunResult, nowMs): boolean    // true on a new best wave
recordDeathmatch(save, result: DeathmatchResult, nowMs): void
kdr(d): number / winRate(d): number

// Menu
summariseSaves(save): ModeSaveSummary[]   // { modeId, headline, detail, canContinue } per mode
```

`recordQuestLevel` keeps the **best** of every counter and the **fastest** clear, advances
`slot.levelId` to `result.nextLevelId`, and marks the slot complete when the exit ends the episode.

---

# 4. `client/src/modes/registry.ts`

## 4.1 Params

```ts
interface ModeEnterParams { modeId; skill; levelId; worldId; seed; flags }
createEnterParams(modeId?) / copyEnterParams(src, dst)
isCoop(p) / isContinue(p) / isFresh(p) / wantsNoBots(p)
toModeSelectMessage(p, out?) : ModeSelectMessage       // ready for encodeModeSelect
fromModeSelectMessage(m, out?) : ModeEnterParams
paramsFromQuery(location.search, fallback?) : ModeEnterParams
//   ?mode=quest&level=e1m1-hangar&skill=3&seed=123&coop=1
```

## 4.2 `ModeScope` — the teardown ledger

**A mode never cleans up by hand.** It registers every resource it creates and the registry unwinds
the ledger in reverse on exit. `scope.stats().live` then reads zero, which is a thing a test can
assert. This is the entire answer to "switching modes does not leak geometry, workers, listeners or
entities".

```ts
class ModeScope {
  add(fn: () => void): () => void;
  addDisposable(d: { dispose?(): void }): void;
  addListener(target, type, handler, options?): void;   // use this, never raw addEventListener
  addTimeout(fn, ms): number;  addInterval(fn, ms): number;
  addAbort(): AbortController;                          // aborts on exit — for fetch()
  addObject3D(object: THREE.Object3D, parent?): void;   // detaches AND disposes the whole subtree
  addWorker(worker: Worker): void;                      // terminated
  addElement(node: Element): void;                      // removed, incl. injected <style>
  dispose(): void;                                      // idempotent, reverse order
  get disposed / get live;
  stats(): { live, listeners, timers, objects, workers, elements, errors };
}
```

`addObject3D` traverses the subtree on teardown and calls `dispose()` on every `geometry` and every
`material` (array materials included) — that is the leak the renderer actually notices. A disposer
that throws is counted in `errors` and skipped; one bad teardown never strands the rest.

The module has only a **type** import of `three`, so it adds nothing to the bundle.

## 4.3 The mode interface

```ts
interface ModeHost {                     // implemented by the shell (main.ts)
  readonly game: Game;
  readonly uiRoot: HTMLElement;          // #ui
  readonly hudRoot: HTMLElement;         // #hud
  readonly canvas: HTMLCanvasElement;
  readonly settings: GameSettings;
  send(bytes: Uint8Array): void;
  setStatus(text: string): void;
  requestExit(reason: string): void;
}

interface ModeContext { host; def: ModeDef; params: ModeEnterParams; scope: ModeScope; registry }
type ModeFactory = (ctx: ModeContext) => ModeInstance | Promise<ModeInstance>;

interface ModeInstance {
  readonly id: ModeId;
  enter?(): void | Promise<void>;        // may be async — fetching a level, say
  exit?(): void | Promise<void>;         // flush saves here; the scope unwinds after
  fixedUpdate?(dt: number, tick: number): void;    // sim cadence
  update?(dt: number, nowMs: number): void;        // per frame, before the draw
  render?(alpha: number): void;                    // per frame, after the draw
  onModeState?(state: ModeStateBuffer): void;
  onModeEvent?(event: ModeEventMessage): void;
  onModeContext?(context: ModeContextMessage): void;
  onResize?(width: number, height: number): void;
  onPause?(paused: boolean): void;
  onAction?(action: ModeAction, a: number, b: number): boolean;   // true swallows it
}
```

Every hook is optional. `ctx.params` is a **live object** the registry mutates in place on re-entry —
read it, do not hold a copy.

## 4.4 `ModeRegistry`

```ts
class ModeRegistry {
  constructor(host: ModeHost, events?: ModeRegistryEvents);
  register(id, factory) / unregister(id) / has(id) / registered(): ModeId[];

  get active: ModeInstance | null;  get activeId: ModeId | -1;  get activeDef: ModeDef | null;
  get params: Readonly<ModeEnterParams>;  get switching: boolean;  get isPaused: boolean;
  stats(): ModeRegistryStats;  scopeStats(): ModeScopeStats;

  activate(params: ModeEnterParams): Promise<void>;
  deactivate(): Promise<void>;
  dispose(): Promise<void>;

  fixedUpdate(dt, tick) / update(dt, nowMs) / render(alpha);        // hot
  dispatchState(s) / dispatchEvent(e) / dispatchContext(c);
  dispatchAction(action, a?, b?): boolean;
  resize(w, h) / setPaused(paused);
}
interface ModeRegistryEvents { onEntered?(id, params); onExited?(id, stats); onError?(id, error) }
```

Every mutation is serialised through one promise chain, so two rapid clicks on two different tiles
can never leave two modes half-alive. A factory or an `enter` that throws leaves the registry with
**no** active mode and its scope already unwound, and reports through `onError`.

Per-frame cost is three null checks and at most three virtual calls. `update`, `fixedUpdate` and
`render` must not allocate: no closures, no spread, no array literals. All bookkeeping is on enter
and exit, which are cold.

### Wiring it up (the shell's side)

```ts
const registry = new ModeRegistry(host, { onError: (id, e) => console.error(id, e) });
registry.register(ModeId.QUEST, questMode);
registry.register(ModeId.BUILDER, builderMode);
registry.register(ModeId.HORDE, hordeMode);
registry.register(ModeId.DEATHMATCH, deathmatchMode);

await registry.activate(select.params);       // from the mode select

// in the frame loop, around the existing game.tick():
registry.update(dt, nowMs);
game.tick(nowMs);
registry.render(alpha);

// in the net dispatcher:
const id = readMessageId(data);
if (isModeMessage(id)) {
  switch (id) {
    case S2C_MODE.STATE:   registry.dispatchState(decodeModeState(reader.reset(data), stateBuf)); break;
    case S2C_MODE.EVENT:   registry.dispatchEvent(decodeModeEvent(reader.reset(data), eventBuf)); break;
    case S2C_MODE.CONTEXT: registry.dispatchContext(decodeModeContext(reader.reset(data), ctxBuf)); break;
    default: break;
  }
  return;
}
```

### Writing a mode

```ts
export const hordeMode: ModeFactory = (ctx) => {
  const banner = document.createElement('div');
  ctx.host.uiRoot.appendChild(banner);
  ctx.scope.addElement(banner);                        // removed on exit
  ctx.scope.addListener(window, 'keydown', onKey);     // detached on exit

  const mesh = new THREE.Mesh(geo, mat);
  ctx.scope.addObject3D(mesh, ctx.host.game.renderer.scene);   // detached + disposed on exit

  return {
    id: ModeId.HORDE,
    onModeState(s) { banner.textContent = `Wave ${s.index} — ${s.a}/${s.aTotal}`; },
  };
};
```

---

# 5. `client/src/ui/modeSelect.ts`

Judged against `ref/voxiom/desktop-00-menu.png`: big mode tiles with voxel thumbnails, a red
"Most Popular" ribbon, an inline picker, and a play affordance that never moves. The thumbnails are
inline **SVG isometric voxels** — no images, no network, no layout shift, crisp at any DPI. All CSS
is scoped to `.dcm-` and injected once (refcounted, so `destroy()` is complete).

```ts
createModeSelect(opts: ModeSelectOptions): ModeSelect

interface ModeSelectOptions {
  root: HTMLElement;                 // where it mounts, usually the menu screen inside #ui
  save?: SaveFile | null;
  levels?: ModeSelectLevel[];
  worlds?: ModeSelectWorld[];
  initialMode?: ModeId;              // defaults to save.profile.lastMode, else QUEST
  botOptions?: number[];             // Deathmatch bot chips, default [0, 4, 8, 16]
  onPlay(params: ModeEnterParams): void;
  onModeChange?(mode: ModeId): void;
  onCreateWorld?(name: string, seed: number): string;   // return the new id, or '' to refuse
  onDeleteWorld?(id: string): void;
}

class ModeSelect {
  readonly element: HTMLElement;
  setLevels(levels) / setWorlds(worlds) / setSave(save);
  setBusy(busy: boolean, label?: string);      // greys the CTA while a room spins up
  select(mode: ModeId, notify: boolean);
  get params(): ModeEnterParams;               // what the CTA would fire with right now
  play() / focus() / destroy();
}
```

Row shapes and the two adapters that build them:

```ts
interface ModeSelectLevel { id name episodeId episodeName episodeIndex levelIndex parTimeSec
                            enemies items secrets cleared bestTimeSec bestKills bestSecrets playable }
interface ModeSelectWorld { id name seed updatedMs blocksPlaced online swatch }

levelRowFrom(manifestEntry, save): ModeSelectLevel   // folds the manifest and the save together
worldRowsFrom(save): ModeSelectWorld[]
hashString(s): number                                 // so "hangar" works as a world seed
```

Behaviour worth knowing:

* Quest resumes at `save.quest.slots[activeSlot].levelId` when that level is installed, and sets
  `MSF_CONTINUE` on the params when it does; otherwise it picks the first playable level.
* A level whose manifest entry has `valid: false` is rendered disabled with "failed validation".
* Builder with no world selected sets `MSF_FRESH`; Deathmatch with 0 bots sets `MSF_NO_BOTS`.
* `onCreateWorld` returns the new world's id and the component selects it, but the shell owns the
  save, so it must follow up with `select.setWorlds(worldRowsFrom(save))` to redraw the list.
* Keyboard: `1`–`4` and ←/→ pick a mode, ↑/↓ move through the level list, `Enter` plays.
* Responsive at 4 / 2 / 1 columns; every hit target is at least 44 px tall on a phone; the picker is
  a fixed-height scroller so filling it cannot shift the reserved ad slots.

```ts
const select = createModeSelect({
  root: menuScreen,
  save,
  levels: manifest.levels.map((e) => levelRowFrom(e, save)),
  worlds: worldRowsFrom(save),
  onPlay: async (params) => { select.setBusy(true); await registry.activate(params); select.setBusy(false); },
  onCreateWorld: (name, seed) => addBuilderWorld(save, name, seed, Date.now()).id,
});
```

---

# 6. `server/src/modes.ts`

## 6.1 Join

```ts
interface ModeJoinRequest { modeId; skill; levelId; worldId; seed; flags }
sanitiseJoin(msg: ModeSelectMessage, levels?: ContentResolver | null): ModeJoinRequest
joinRequestFor(modeId, levelId?, worldId?, skill?, seed?): ModeJoinRequest
toSelectMessage(req): ModeSelectMessage
interface ContentResolver { resolveId(requested: string): string }   // LevelLibrary satisfies this
```

`decodeModeSelect` already made the strings safe slugs; `sanitiseJoin` decides whether the **content
exists**, dropping a request for a missing level onto one that is installed and clearing `levelId`
for modes that do not use authored levels.

## 6.2 The sim plan

```ts
resolveModePlan(req: ModeJoinRequest, overrides?: ModePlanOverrides): ModeSimPlan
describePlan(plan): Record<string, unknown>          // for /api/status
```

`ModeSimPlan` is a flat, all-`readonly` struct — the room reads booleans, never the mode id:

```
runBots runMonsters runMonsterDirector runWaveDirector runPickups runRoundTimer
runScoreLimit runBlockEconomy runLevelScript runWorldPersistence runIntermission
allowPvp allowFriendlyFire allowPlacing allowBreaking instantBreak allowTerrainDamage
fallDamage hazards killfeed creativeFlight
botFill enemyBudget enemySpawnIntervalMs enemyMaxTier monstersRespawn
durationMs scoreLimit respawnPolicy respawnDelayMs buildPhaseMs buildDuringCombat
blockBudget finalWave maxPlayers startWeaponMask startWeapon grantAllWeapons
worldSource levelId worldId seed skill coop fresh
```

Skill is already folded in: `enemyBudget` carries `SKILL_ENEMY_BONUS`, `enemySpawnIntervalMs` carries
`SKILL_ENEMY_INTERVAL`, and `monstersRespawn` is Nightmare's rule. `enemyBudget` is `-1` for an
authored level, meaning "the level file decides".

`ModePlanOverrides` = `{ botFill? enemyBudget? durationMs? scoreLimit? maxPlayers? buildPhaseMs?
blockBudget? grantAllWeapons? seed? }`.

## 6.3 Room configuration

```ts
roomOptionsFor(plan, extra?): RoomOptions            // hand straight to new Room(...)
applyMonsterBudget(plan, budget: MonsterBudgetLike)  // MonsterManager.budget satisfies this
waveBudget(plan, wave): { target, maxTier, payout }
buildPhaseBudget(plan, wave): number
canPlaceBlock(plan, phase: ModePhase, budgetLeft): boolean
canDamagePlayer(plan, attackerId, victimId): boolean // self-damage always applies (rocket jumps)
nextPhase(plan, current, { worldReady, humans, objectiveDone, failed, buildMsLeft }): ModePhase
roundClockMs(plan, elapsedMs): number
clearKeys(): number / grantKey(mask, colour): number
DEFAULT_JOIN / defaultPlan(overrides?)
```

`roomOptionsFor` sets `eagerWorld: false` for authored levels — generating all 169 chunks first would
only be thrown away by the level stamp.

## 6.4 Join routing

```ts
class ModeRouter<T extends RoomLike> {
  constructor(options: ModeRouterOptions<T>);
  route(req: ModeJoinRequest): RoutedRoom<T>;
  routeMessage(msg: ModeSelectMessage): RoutedRoom<T>;
  get(key) / planOf(key) / keys() / get size;
  touch(key) / sweep(): number / stopAll() / status();
}
interface RoomLike { readonly maxPlayers: number; readonly humanCount: number;
                     status(): Record<string, unknown>; stop(): void }
interface ModeRouterOptions<T> { create(key, plan, options: RoomOptions): T;
                                 clock?; idleMs?; maxRooms?; overrides?; levels? }
interface RoutedRoom<T> { key: string; room: T; plan: ModeSimPlan; created: boolean }
DEFAULT_ROOM_IDLE_MS = 120_000;  DEFAULT_MAX_ROOMS = 32;
```

One key per playable place (`roomKeyFor`), with a `#2`, `#3`… suffix when the first instance is full.
Because Quest is keyed by level + skill and Builder by world, **two people who pick the same content
land in the same session** — that is co-op, with no extra machinery. `sweep()` stops and forgets
rooms that have had no humans for `idleMs`; call it on a timer. `Room` satisfies `RoomLike`
structurally, so this file never imports it at runtime.

```ts
const router = new ModeRouter<Room>({
  levels: levelLibrary(),
  create: (key, plan, opts) => {
    const room = new Room({ ...opts, store, clock: () => Date.now(), name: key });
    if (plan.worldSource === WorldSource.AUTHORED) levelLibrary().applyTo(plan.levelId, room.world);
    applyMonsterBudget(plan, room.monsters.budget);
    room.start();
    return room;
  },
});
const { room, plan } = router.routeMessage(select);
```

## 6.5 The state sidecar

```ts
class ModeStateTracker {
  constructor(plan: ModeSimPlan);
  add(playerId) / remove(playerId) / clear() / invalidate(playerId);
  compose(playerId, room: ModeRoomState, player: ModePlayerState): ModeStateBuffer | null;
}
interface ModeRoomState { phase phaseMsLeft elapsedMs index score a aTotal b bTotal c cTotal
                          objectiveDone exitOpen waveActive failed }
interface ModePlayerState { keys budget lives ackActionSeq finished }
createModeRoomState() / createModePlayerState()
```

`compose` returns the buffer **only when something changed**, else `null` — send a packet exactly
when it is non-null. Two buffers per client, reused forever; nothing allocates after `add()`. The
`MST_*` flags are derived here, including `MST_CAN_BUILD` from `canPlaceBlock`.

```ts
// once per tick, per connection, just before the snapshot:
const s = tracker.compose(conn.playerId, roomState, playerState);
if (s !== null) conn.send(encodeModeState(writer, s).slice());
conn.send(encodeSnapshot(writer, snapshot).slice());
```

---

# 7. `server/src/levels.ts`

```ts
levelLibrary(options?): LevelLibrary      // the process-wide instance, loaded on first use
resetLevelLibrary(): void                 // tests
class LevelLibrary {
  constructor(options?: LevelLibraryOptions);   // { dir? manifestSkill? log? allowInvalid? clock? }
  readonly dir: string;
  readonly problems: LevelLoadProblem[];        // files that would not load at all
  load(): number / reload(): number;            // returns the playable count
  get size / get playableCount;
  has(id) / get(id): LoadedLevel | null / getPlayable(id): Level | null;
  all(): LoadedLevel[] / firstPlayableId(): string / resolveId(requested): string;
  nextLevelId(id): string;                      // resolved and validated; '' ends the episode
  manifest(): LevelManifest / manifestJson(): string;
  totalsFor(id, skill);
  applyTo(id, world: LevelWorldTarget): LevelApplyResult | null;
  spawnFor(id): { x, y, z, yaw } | null;
  handle(pathname, method, ifNoneMatch?): LevelHttpResponse | null;
}
DEFAULT_LEVEL_DIR      // <repo>/content/levels, or $DOOMCRAFT_LEVELS
MAX_LEVEL_FILE_BYTES = 24 MiB
```

`load()` scans the directory and takes `*.json` (authoring source) and `*.dcl` (compiled binary)
alike; when both exist for one id the source wins. Each is compiled, validated at its
`defaultSkill`, encoded, hashed, and turned into a manifest entry.

**A level that fails validation is never served.** `getPlayable`, `applyTo` and `resolveId` all
refuse it, `GET .../data` answers `409` with the error list, and the manifest entry carries
`valid: false` plus `problems[]` so the mode select can grey the row. `allowInvalid: true` is for the
level editor only.

## HTTP

`handle()` returns `null` when the path is not its own, so `index.ts` falls through to the static
handler. It never imports `node:http`.

| Route | Returns |
|---|---|
| `GET /api/levels` | the manifest, grouped into episodes |
| `GET /api/levels/<id>` | `{ entry, playable, errors, warnings, reach, source }` |
| `GET /api/levels/<id>/data` | the `.dcl` bytes; `ETag` = content hash, `max-age=300`, `304` honoured |
| `GET /api/levels/<id>/source` | the authoring JSON, when the level came from one |

```ts
// in index.ts's handleApi, before the static fallback:
const lv = levelLibrary().handle(url.pathname, req.method ?? 'GET', req.headers['if-none-match']);
if (lv !== null) {
  const body = typeof lv.body === 'string' ? Buffer.from(lv.body, 'utf8') : Buffer.from(lv.body);
  res.writeHead(lv.status, { ...lv.headers, 'content-length': String(body.length) });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
```

---

# 8. `content/levels/e1m1-hangar.json`

A real, playable, validating level — the proof the format works and the thing the Quest builder loads
on day one. Compiles to 9 sections / 248,439 solid voxels / **15.5 KB** of `.dcl`, and validates
clean at all five skills.

```
  R1 start hangar   x  5..27  z  5..27   floor y7   ceiling y18
  C1 dark corridor  x 15..17  z 28..44   floor y7   ceiling y13   ← dark against lit, on purpose
  R2 hangar floor   x  5..43  z 45..75   floor y7   ceiling y21   ← the blue keycard, a lava vent
  D1 BLUE DOOR      x 44      z 56..58   y 8..11
  C2 airlock        x 45..55  z 56..58                            ← an imp ambushes when D1 opens
  R3 east wing      x 57..87  z 45..75   floor y7   ceiling y21   ← the exit and its switch
  C3 return duct    x 71..73  z 25..44
  R4 catwalk hall   x 29..73  z 17..24   stairs up to y13 at the west end
  W1 one-way window x 28      z 19..21   y 14..16  → a 6-block drop back into R1
  S1 secret alcove  x  1.. 3  z 13..17   behind a fake wall opened by a hidden switch
```

The loop runs **one way**. You cannot climb from R1 into R4, so the exit in R3 is behind the blue
door and nothing else; the catwalk is the shortcut home through cleared space, exactly as E1M1 does
it. `shared/src/level.test.ts` proves it: delete the keycard and the exit becomes unreachable
(3,214 walkable cells drop to 1,799), delete the exit switch and it is unreachable again.

Contents: 13 enemy placements across five skills (7 at ITYTD, 13 at Nightmare), 16 items, 1 secret
holding the rocket launcher and blue armour, a keycard, a locked door, a hidden switch, and an exit
switch.

**Adding a level is adding a file.** Drop a `.json` in `content/levels/`, give it a unique
`meta.id` and an `episodeId`, and it appears in the manifest, in the mode select and on the server —
with no code change anywhere.

---

# 9. Verification

```
npx tsc -b        # exit 0
npx vitest run    # 109 passed (31 of them in shared/src/level.test.ts)
```

`shared/src/level.test.ts` covers: byte-exact round trips of a synthetic level and of the shipped
E1M1, voxel-for-voxel section equality, rejection of bad magic and of a future format version, the
five-byte uniform section, the reachability solver across walled / key-locked / key-present /
switch-locked variants, `E_NO_SPAWN` / `E_NO_EXIT` / `E_SPAWN_SOLID` / `E_BAD_TARGET`, the E1M1
key and switch gates, every mode-protocol message round trip (including `MODE_STATE_BYTES`), path
traversal in a level id, room keying, and save migration from v1 and from garbage.
