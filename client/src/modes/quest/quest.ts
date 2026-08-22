/**
 * DOOMCRAFT — QUEST. The Doom campaign.
 *
 * Bar: DOOM (1993), E1M1 "Hangar" (ref/doom/). What that level actually does,
 * and what this mode reproduces:
 *
 *   - **Hand-authored levels, never generated terrain.** A Quest level is a
 *     file. `levelRuntime.ts` blits its voxels into the world and keeps them
 *     there; the procedural terrain path is not used at all.
 *   - **Keycards gate the level graph.** Three colours, real doors, and a HUD
 *     row that tells you at a glance which one you are missing.
 *   - **Secrets behind fake walls.** A hidden switch made of the surrounding
 *     wall block opens a `switchOnly` door, and standing in the sector behind
 *     it fires Doom's sting.
 *   - **A switch opens the exit.** The exit sector is inert until its switch is
 *     thrown, which is why every shipped level fails validation if you delete
 *     that switch.
 *   - **Dark corridors against lit rooms.** Per-level ambient, fog colour and
 *     fog distance come out of `LevelMeta`, so E1M4 runs at ambient 0.12 with a
 *     30-block fog wall and E1M5 runs hot. The contrast is content. Monsters are
 *     drawn unlit, so darkening the world darkens everything *except* them —
 *     which is the whole of "enemies are brighter than their background".
 *   - **Ammo starvation as pacing.** Quest takes the sandbox's all-seven-guns
 *     loadout away and runs Doom's: a pistol, a chainsaw and fifty rounds, and
 *     every other weapon lying in the level. See `loadoutMask` and
 *     `fillPickupGrant` in `levelRuntime.ts`; the campaign's actual ammo-to-
 *     monster-health curve is asserted in `quest.test.ts`.
 *   - **The intermission.** Kills %, items %, secrets %, time versus par,
 *     counted up with a tick. `intermission.ts`.
 *
 * WHERE AUTHORITY LIVES. The server owns bodies, damage and monsters; this mode
 * owns the *level script* — doors, switches, keycards, secrets, the exit and the
 * objective. It announces itself with `C2S_MODE.SELECT` and mirrors every USE
 * upstream as a `C2S_MODE.ACTION`, and the moment a Quest-aware room answers
 * with `S2C_MODE.STATE` the server's counters win. Until then the mode is fully
 * playable on its own against the local worker server, which is the difference
 * between "a campaign" and "a campaign once somebody wires the room".
 *
 * CONTENT, NOT CODE. Levels are discovered three ways, in order: the server's
 * `/api/levels` manifest, an `import.meta.glob` over `content/levels/*.json`
 * (one lazily-loaded chunk per level, ~3 KB gzipped, nothing downloaded until
 * Quest is played), and a plain fetch. Adding a level is adding a file in all
 * three paths — there is no list of level ids in this file.
 *
 * ...and the first of those three is SKIPPED ENTIRELY when no server is
 * configured. The shipped static build has none (see `net/serverConfig.ts`),
 * so probing `/api/levels` there is not a fallback, it is two guaranteed 404s
 * and two red console lines on every campaign launch — the page already knows
 * the answer before it asks. `levelApiBase()` below is that knowledge, and it
 * is the same `resolveServerUrl()` the session uses, so a build that DOES have
 * a server still asks it, and asks it on the server's own origin rather than
 * on the static host that is only serving the bundle.
 *
 * COST. `update` walks fixed arrays and re-asserts one chunk; nothing here
 * allocates per frame. Everything expensive is in `enter`, behind the loading
 * status line.
 */

import {
  InputAction,
  PLAYER_EYE_HEIGHT,
} from '@shared/constants';
import { EntityType, PacketWriter } from '@shared/protocol';
import {
  C2S_MODE,
  ModeAction,
  ModeEventKind,
  ModeId,
  ModePhase,
  SKILL_PICKUP_SCALE,
  SKILL_SHORT_NAMES,
  clampSkill,
  createIntermissionStats,
  createModeActionMessage,
  createModeSelectMessage,
  encodeModeAction,
  encodeModeSelect,
  formatTime,
  getMode,
  type ModeContextMessage,
  type ModeEventMessage,
  type ModeStateBuffer,
} from '@shared/modes';
import { ALL_WEAPON_MASK, AMMO_TYPE_COUNT, AmmoType, ownsWeapon } from '@shared/weapons';
import {
  compileLevel,
  decodeLevel,
  isLevelBinary,
  parseLevelJson,
  primarySpawn,
  type Level,
} from '@shared/level';
import {
  beginQuest,
  loadSave,
  questLevelRecord,
  recordQuestLevel,
  storeSave,
  type SaveFile,
  type SaveStorage,
} from '@shared/saves';

import { DOOM_FOG, DOOM_SKY_GROUND, DOOM_SKY_HIGH, DOOM_SKY_ZENITH } from '@/engine/material';
import { apiUrl, resolveServerUrl } from '@/net/serverConfig';

import type { ModeContext, ModeFactory, ModeInstance } from '@/modes/registry';
import {
  QUEST_START_BULLETS,
  QuestEvent,
  QuestLevelRuntime,
  USE_DOOR_LOCKED,
  USE_NOTHING,
  createPickupGrant,
  fillPickupGrant,
  type QuestPaletteSink,
  type QuestPickupGrant,
  type QuestSpawn,
  type QuestWorldSink,
} from '@/modes/quest/levelRuntime';
import { QuestHud } from '@/modes/quest/hud';
import { QuestIntermission } from '@/modes/quest/intermission';
import { economySurfacesOn } from '@/hud/hud';

/* ------------------------------------------------------------------------ *
 * Content discovery
 *
 * No level id appears anywhere in this file. Both maps are built by the
 * bundler from what is actually on disk, so a new .json is a new lazy chunk
 * and a new campaign entry with no code change.
 * ------------------------------------------------------------------------ */

const BUNDLED_LEVELS = import.meta.glob(
  '../../../../content/levels/*.json',
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

const BUNDLED_EPISODES = import.meta.glob(
  '../../../../content/episodes.json',
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

/**
 * The origin that serves `/api/levels`, or '' when this build has no server.
 *
 * Resolved once and cached, because the answer cannot change inside a session
 * (`resolveServerUrl` reads the query string, localStorage and a meta tag that
 * the document was served with) and because it is on the path to the campaign
 * loading. '' is the shipped static build and is the ONLY reason this function
 * exists: it is what turns "fetch and fall back" into "do not fetch".
 *
 * Injectable so a test can exercise both sides without a DOM; `null` restores
 * the real resolver.
 */
let levelApiBaseOverride: string | null = null;
let levelApiBaseCache: string | null = null;

export function setLevelApiBase(base: string | null): void {
  levelApiBaseOverride = base;
  levelApiBaseCache = null;
}

function levelApiBase(): string {
  if (levelApiBaseOverride !== null) return levelApiBaseOverride;
  if (levelApiBaseCache === null) {
    try { levelApiBaseCache = resolveServerUrl(); } catch { levelApiBaseCache = ''; }
  }
  return levelApiBaseCache;
}

/** `../../../../content/levels/e1m2-coolant.json` -> `e1m2-coolant`. */
function idFromPath(path: string): string {
  const slash = path.lastIndexOf('/');
  const name = slash < 0 ? path : path.slice(slash + 1);
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

export interface QuestEpisode {
  id: string;
  name: string;
  index: number;
  tagline: string;
  /** Level ids in run order. Ids with no file are dropped at load. */
  levels: string[];
}

export interface QuestCatalog {
  episodes: QuestEpisode[];
  /** Every level id that can actually be loaded, in run order then discovery order. */
  order: string[];
  /** Display names when the server manifest supplied them. */
  names: Map<string, string>;
  defaultEpisode: string;
}

let catalogPromise: Promise<QuestCatalog> | null = null;

/** Read the episode manifest + whatever the server knows. Cached per session. */
export function questCatalog(): Promise<QuestCatalog> {
  if (catalogPromise === null) catalogPromise = buildCatalog();
  return catalogPromise;
}

async function buildCatalog(): Promise<QuestCatalog> {
  const available = new Set<string>();
  for (const path of Object.keys(BUNDLED_LEVELS)) available.add(idFromPath(path));

  const names = new Map<string, string>();
  const episodes: QuestEpisode[] = [];
  let defaultEpisode = '';

  /* --- the authored order ---------------------------------------------- */
  const epPath = Object.keys(BUNDLED_EPISODES)[0];
  if (epPath !== undefined) {
    try {
      const doc = JSON.parse(await BUNDLED_EPISODES[epPath]()) as unknown;
      const root = asRecord(doc);
      defaultEpisode = typeof root.defaultEpisode === 'string' ? root.defaultEpisode : '';
      const list = Array.isArray(root.episodes) ? root.episodes : [];
      for (const raw of list) {
        const e = asRecord(raw);
        const ids: string[] = [];
        for (const l of Array.isArray(e.levels) ? e.levels : []) {
          if (typeof l === 'string') ids.push(l);
        }
        episodes.push({
          id: typeof e.id === 'string' ? e.id : '',
          name: typeof e.name === 'string' ? e.name : '',
          index: typeof e.index === 'number' ? e.index : episodes.length + 1,
          tagline: typeof e.tagline === 'string' ? e.tagline : '',
          levels: ids,
        });
      }
    } catch { /* a broken manifest must not cost the player the campaign */ }
  }

  /* --- enrich from the server, when there is one ------------------------ *
   * `base === ''` is the shipped static build. There is no server, there was
   * never going to be one, and a request here would be a 404 the player can
   * see in devtools — so it is not made. The bundled levels are the campaign.
   * --------------------------------------------------------------------- */
  const base = levelApiBase();
  if (base.length > 0) {
    try {
      const res = await fetch(apiUrl(base, '/api/levels'), { headers: { accept: 'application/json' } });
      if (res.ok) {
        const manifest = asRecord(await res.json());
        for (const raw of Array.isArray(manifest.levels) ? manifest.levels : []) {
          const l = asRecord(raw);
          const id = typeof l.id === 'string' ? l.id : '';
          if (id.length === 0) continue;
          if (l.valid !== false) available.add(id);
          if (typeof l.name === 'string' && l.name.length > 0) names.set(id, l.name);
        }
      }
    } catch { /* the server is configured but not answering: bundled it is */ }
  }

  /* --- run order --------------------------------------------------------- */
  const order: string[] = [];
  const seen = new Set<string>();
  for (const ep of episodes) {
    ep.levels = ep.levels.filter((id) => available.has(id));
    for (const id of ep.levels) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of [...available].sort()) {
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  if (defaultEpisode.length === 0) defaultEpisode = episodes[0]?.id ?? 'e1';

  return { episodes, order, names, defaultEpisode };
}

/** The level after `id` in the campaign, or '' at the end of the episode. */
export function nextLevelIn(catalog: QuestCatalog, id: string, fallback: string): string {
  for (const ep of catalog.episodes) {
    const i = ep.levels.indexOf(id);
    if (i < 0) continue;
    return i + 1 < ep.levels.length ? ep.levels[i + 1] : '';
  }
  const j = catalog.order.indexOf(id);
  if (j >= 0 && j + 1 < catalog.order.length) return catalog.order[j + 1];
  return fallback;
}

export function episodeOf(catalog: QuestCatalog, id: string): QuestEpisode | null {
  for (const ep of catalog.episodes) if (ep.levels.indexOf(id) >= 0) return ep;
  return catalog.episodes[0] ?? null;
}

/**
 * Fetch and compile one level. The server's compiled `.dcl` wins because it is
 * the exact bytes the room is running; the bundled source is the offline path.
 */
export async function loadQuestLevel(id: string, signal?: AbortSignal): Promise<Level> {
  const problems: string[] = [];

  // Same rule as the manifest above: no configured server, no request. On the
  // static build the bundled source below is not a fallback, it is the path.
  const base = levelApiBase();
  if (base.length > 0) {
    try {
      const res = await fetch(apiUrl(base, `/api/levels/${encodeURIComponent(id)}/data`), { signal });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (isLevelBinary(bytes)) return decodeLevel(bytes);
        problems.push('the server returned something that is not a .dcl');
      } else {
        problems.push(`/api/levels returned ${res.status}`);
      }
    } catch (e) {
      if (signal?.aborted === true) throw e;
      problems.push('the level server did not answer');
    }
  }

  for (const path of Object.keys(BUNDLED_LEVELS)) {
    if (idFromPath(path) !== id) continue;
    const src = parseLevelJson(await BUNDLED_LEVELS[path]());
    if (src !== null) return compileLevel(src);
    problems.push('the bundled source did not parse');
  }

  try {
    const res = await fetch(`/content/levels/${encodeURIComponent(id)}.json`, { signal });
    if (res.ok) {
      const src = parseLevelJson(await res.text());
      if (src !== null) return compileLevel(src);
    }
  } catch { /* fall through to the error below */ }

  throw new Error(`Quest: cannot load level "${id}" (${problems.join('; ') || 'not found'})`);
}

/* ------------------------------------------------------------------------ *
 * Mode
 * ------------------------------------------------------------------------ */

const PHASE_LOADING = 0;
const PHASE_LIVE = 1;
const PHASE_DEAD = 2;
const PHASE_INTERMISSION = 3;

/** Entity state bit mirrored from server/src/sim.ts, as game.ts already does. */
const ES_DEAD = 1 << 3;

/** Monster slots tracked for kill attribution. More than any level ships. */
const MONSTER_SLOTS = 256;

/**
 * How long placement waits for the room to answer "do you own this level?"
 *
 * The answer decides WHERE the level goes, and getting it wrong is the bug this
 * whole handshake exists for: a room that simulates the authored geometry and a
 * client that relocated it are two different worlds, and the room wins every
 * argument about every wall. The room holds its `S2C_MODE.CONTEXT` back while a
 * level is loading, so this only ever expires against a room too old to answer
 * — and then the old relocate-onto-my-spawn behaviour is the right fallback.
 */
const ROOM_CONTEXT_WAIT_S = 3;
/**
 * ...and how long it then waits for the room to put the body on the authored
 * player start before opening the level anyway. Placement is correct either
 * way (the room's coordinates are the room's coordinates); this is only so the
 * campaign does not open with the camera out on the arena.
 */
const AUTHORED_SPAWN_WAIT_S = 2;

class QuestMode implements ModeInstance {
  readonly id = ModeId.QUEST;

  private readonly ctx: ModeContext;
  private readonly level: Level;
  private readonly levelId: string;
  private readonly catalog: QuestCatalog;
  private readonly runtime: QuestLevelRuntime;
  private readonly hud: QuestHud;

  private intermission: QuestIntermission | null = null;
  private phase = PHASE_LOADING;

  /* --- run state -------------------------------------------------------- */
  private elapsed = 0;
  /** `net.sessionXp` / `sessionScrap` at `enter()`. See the note there. */
  private awardMarkXp = 0;
  private awardMarkScrap = 0;
  private deaths = 0;
  private placed = false;
  private wasDead = false;
  private paused = false;
  private useWasDown = false;
  private actionSeq = 1;

  /* --- who owns the geometry -------------------------------------------- *
   * A Quest level is a FILE, and until the room could read that file too the
   * campaign was played in two different worlds: the client blitted the level
   * into its own voxel store and relocated it onto whatever arena spawn it got,
   * while the room went on colliding the body against generated terrain. The
   * room's reconciliation wins, so the player was dragged through authored
   * floors and stopped dead in empty corridors — "I was going through walls".
   *
   * `S2C_MODE.CONTEXT` now says which it is. A non-zero `contentHash` means the
   * ROOM stamped this level into its own world, and then the authored
   * coordinates are the only placement the two simulations can agree on.
   * ---------------------------------------------------------------------- */
  private contextSeen = false;
  private roomOwnsLevel = false;
  /** Seconds spent waiting for that answer, and then for the authored spawn. */
  private placeWait = 0;

  /* --- server authority --------------------------------------------------- */
  private serverDriven = false;
  private srvKills = 0; private srvKillsTotal = 0;
  private srvItems = 0; private srvItemsTotal = 0;
  private srvSecrets = 0; private srvSecretsTotal = 0;
  private srvKeys = 0;

  /* --- kill attribution ---------------------------------------------------- */
  private readonly monsterSlot = new Map<number, number>();
  private readonly monsterPos = new Float32Array(MONSTER_SLOTS * 3);
  private monsterCursor = 0;

  /* --- the loadout Quest owns ------------------------------------------------ */
  /**
   * Weapons Quest says you hold. The base game hands out all seven on every
   * spawn (`game.ts` -> `resetLoadout(ALL_WEAPONS_MASK)`), which is right for a
   * sandbox and wrong for a campaign, so while Quest is live this mask is the
   * truth and `enforceLoadout` clamps the runtime back to it every frame. That
   * is also why it is a clamp and not a one-shot: it has to win whichever order
   * the host happens to call `game.tick` and `registry.update` in.
   */
  private loadoutMask = 0;

  /* --- scratch (never reallocated) ------------------------------------------ */
  private readonly writer = new PacketWriter(128);
  private readonly selectMsg = createModeSelectMessage();
  private readonly actionMsg = createModeActionMessage();
  private readonly eye = new Float64Array(3);
  private readonly enemyScratch = new Float64Array(3);
  private readonly spawnScratch: QuestSpawn = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly grant: QuestPickupGrant = createPickupGrant();

  constructor(ctx: ModeContext, level: Level, catalog: QuestCatalog) {
    this.ctx = ctx;
    this.level = level;
    this.levelId = level.meta.id;
    this.catalog = catalog;

    const game = ctx.host.game;
    const skill = clampSkill(ctx.params.skill);

    /* --- sinks ---------------------------------------------------------- */
    const world: QuestWorldSink = {
      chunkAt: (cx, cz) => game.net.world.chunkAt(cx, cz),
      putChunk: (cx, cz, voxels) => {
        game.net.world.putChunk(cx, cz, voxels);
        game.chunks.setChunk(cx, cz, voxels);
        game.hud.updateMinimapChunk(cx, cz, voxels);
      },
      setBlock: (x, y, z, id) => {
        game.net.world.setBlock(x, y, z, id);
        game.chunks.setBlock(x, y, z, id);
      },
      getBlock: (x, y, z) => game.net.world.getBlock(x, y, z),
    };

    const palette: QuestPaletteSink = {
      setAmbient: (ambient, sun) => { game.materials.setLightBalance(ambient, sun); },
      setFog: (color, _near, far) => {
        game.materials.setFogColor(color);
        game.materials.setFogFar(far);
      },
      setSky: (zenith, horizon, fog) => {
        game.sky.setColors({ zenith, high: horizon, horizon: fog, ground: fog, ember: horizon });
      },
    };

    this.runtime = new QuestLevelRuntime({
      level,
      skill,
      world,
      palette,
      events: (kind, index, a, text) => { this.onRuntimeEvent(kind, index, a, text); },
    });

    /* The audio half of the same palette.
     *
     * `palette` above hands the RENDERER the sky, the fog and the ambient; this
     * hands the same three numbers to the ambience bed, which turns them into
     * heat, darkness and room size. It has to be done here and not from the
     * room's `ModeContextMessage`, because a Quest level lives on the CLIENT —
     * the server has a manifest, not a level, and its context message fills
     * skyColor with the mode's UI accent and ambient with a flat 0.6. Driving
     * the bed off that made every level in the campaign measure as hot, bright
     * and identical, including e1m4-blackout, which is none of those things.
     *
     * `musicCue` comes across too. It has been on `LevelMeta` since the level
     * format was written, documented there as "key the audio layer looks up",
     * populated in all six shipped levels and read by nothing until now. */
    game.setLevelAudio(
      {
        skyTop: level.meta.skyTop,
        fogColor: level.meta.fogColor,
        ambient: level.meta.ambient,
        fogFar: level.meta.fogFar,
      },
      ModeId.QUEST,
      level.meta.musicCue,
    );

    /* --- HUD ------------------------------------------------------------- */
    this.hud = new QuestHud({
      root: ctx.host.hudRoot,
      keyMask: this.runtime.keyColoursPresent(),
      parTimeSec: level.meta.parTimeSec,
    });
    ctx.scope.add(() => { this.hud.destroy(); });
    ctx.scope.addListener(window, 'resize', () => { this.hud.layout(); }, { passive: true });

    /* --- palette restore -------------------------------------------------- */
    ctx.scope.add(() => {
      game.materials.setLightBalance(0.60, 0.40);
      game.materials.setFogColor(DOOM_FOG);
      game.materials.setFogFromRenderDistance(game.chunks.currentRenderDistance);
      game.sky.setColors({
        zenith: DOOM_SKY_ZENITH, high: DOOM_SKY_HIGH, horizon: DOOM_FOG, ground: DOOM_SKY_GROUND,
      });
    });
    ctx.scope.add(() => { this.runtime.dispose(); });

    /* --- loadout restore ---------------------------------------------------- */
    // Quest is the only mode that takes weapons away, so it is the only mode
    // that owes the next one its kit back.
    ctx.scope.add(() => { game.weapons.resetLoadout(ALL_WEAPON_MASK); });

    this.hud.setObjective('LOADING');
    this.hud.setTally(0, this.runtime.totals.enemies, 0, this.runtime.totals.items, 0, this.runtime.totals.secrets);
  }

  /* -------------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------------- */

  enter(): void {
    const host = this.ctx.host;
    host.setStatus(`${this.level.meta.name} — ${SKILL_SHORT_NAMES[this.runtime.skill]}`);
    // Where the session's server-granted totals stood when this level started.
    // The intermission shows the DIFFERENCE, so "+120 XP" means this level and
    // not "everything since you opened the tab". Subtracting two numbers the
    // server sent is not computing a balance; inventing either of them would be.
    this.awardMarkXp = host.game.net.sessionXp;
    this.awardMarkScrap = host.game.net.sessionScrap;
    this.sendSelect();
    this.markAttempt();
  }

  exit(): void {
    this.intermission?.destroy();
    this.intermission = null;
  }

  onPause(paused: boolean): void {
    this.paused = paused;
  }

  onResize(width: number, height: number): void {
    this.hud.layout(width, height);
  }

  /* -------------------------------------------------------------------- *
   * Frame
   * -------------------------------------------------------------------- */

  update(dt: number, _nowMs: number): void {
    const game = this.ctx.host.game;

    if (this.phase === PHASE_INTERMISSION) {
      this.intermission?.update(dt);
      this.hud.update(dt);
      return;
    }

    if (!this.placed) {
      this.tryPlace(dt);
      this.hud.update(dt);
      return;
    }

    const px = game.net.renderPos[0];
    const py = game.net.renderPos[1];
    const pz = game.net.renderPos[2];

    if (!this.paused) {
      this.elapsed += dt;
      this.enforceLoadout();
      this.runtime.update(dt, px, py, pz);
      this.trackKills();
      this.pollUse();
    } else {
      // Still hold the geometry down while the pause menu is open: a server
      // that keeps streaming must not repaint the level with terrain.
      this.runtime.reassert(1);
    }

    this.trackDeath();
    this.syncHud();
    this.hud.update(dt);

    if (this.runtime.exitReached && this.phase !== PHASE_INTERMISSION) this.finishLevel();
  }

  /* -------------------------------------------------------------------- *
   * Placement
   * -------------------------------------------------------------------- */

  /**
   * Stamp the level as soon as the player exists, on coordinates the ROOM
   * agrees with.
   *
   * Two cases, and the distinction is the whole fix for "I was going through
   * walls":
   *
   *   - **The room owns the level** (`roomOwnsLevel`). Its world already holds
   *     these voxels at their authored coordinates, so the origin stays at
   *     zero. Relocating here would produce two different worlds and the room's
   *     reconciliation would drag the body through the level's floors. We wait
   *     a moment for the room's respawn to land on the authored player start so
   *     the level opens where it was authored to open — but we place either
   *     way, because agreeing with the room matters more than the view.
   *   - **The room does not** (an old room, or one with no copy of the file).
   *     Then the client's blit is the only level there is, and relocating it
   *     onto our spawn is what makes the campaign playable at all.
   */
  private tryPlace(dt: number): void {
    const game = this.ctx.host.game;
    if (game.net.status !== 'playing') return;
    if (game.net.world.chunkCount === 0) return;

    const px = game.net.renderPos[0];
    const py = game.net.renderPos[1];
    const pz = game.net.renderPos[2];
    if (px === 0 && py === 0 && pz === 0) return;

    this.placeWait += dt;
    // Placing before the room has answered risks placing it in the wrong place.
    if (!this.contextSeen && this.placeWait < ROOM_CONTEXT_WAIT_S) return;

    const authored = primarySpawn(this.level);
    const onSpawn = Math.abs(px - authored.x) < 3
      && Math.abs(pz - authored.z) < 3
      && Math.abs(py - authored.y) < 4;

    if (this.roomOwnsLevel) {
      if (!onSpawn && this.placeWait < AUTHORED_SPAWN_WAIT_S) return;
    } else if (!onSpawn) {
      this.runtime.alignSpawnTo(px, py, pz);
    }

    this.runtime.place();
    this.placed = true;
    this.phase = PHASE_LIVE;

    // "Opens on a readable silhouette" (docs/MODES.md §1) is not an accident in
    // E1M1 — you are pointed down the room at the corridor mouth. Every level
    // file authors that heading; honouring it is the difference between opening
    // on the level and opening on a wall.
    const spawn = this.runtime.spawn(this.spawnScratch);
    game.camera.setAngles(spawn.yaw, 0);
    this.sendSpawnAnchor(spawn);

    this.applyLoadout();

    this.ctx.host.setStatus('');
    game.hud.pushFeed(
      `${this.level.meta.episodeName} · ${this.level.meta.name} — ${SKILL_SHORT_NAMES[this.runtime.skill]}`,
      'j',
    );
    if (this.level.meta.description.length > 0) game.hud.pushFeed(this.level.meta.description, 's');
    game.hud.pushFeed('Press E to use switches and doors.', 's');

    /* The room could not take the level over, so it is still simulating its own
     * terrain under our feet and its reconciliation will win every argument
     * about every wall. Say so. "You went through a wall and nobody told you
     * why" is the failure this whole handshake exists to end; when the fallback
     * is genuinely unavoidable, the least it owes the player is a reason. */
    if (!this.roomOwnsLevel) {
      game.hud.pushFeed('This room has no copy of the level — movement may fight the walls.', 'k');
    }
  }

  /* -------------------------------------------------------------------- *
   * Loadout — see `loadoutMask`
   * -------------------------------------------------------------------- */

  /**
   * Doom's campaign start: a pistol, a chainsaw and fifty rounds. Everything
   * else in the level is a pickup, which is what makes the boxes of shells
   * behind the blue door worth the trip.
   */
  private applyLoadout(): void {
    const w = this.ctx.host.game.weapons;
    const def = getMode(ModeId.QUEST);
    this.loadoutMask = def.startWeaponMask;
    w.resetLoadout(this.loadoutMask);
    // resetLoadout hands out the sandbox reserve, which is a different game.
    for (let t = 0; t < AMMO_TYPE_COUNT; t++) w.reserve[t] = 0;
    w.addAmmo(
      AmmoType.BULLETS,
      Math.round(QUEST_START_BULLETS * SKILL_PICKUP_SCALE[this.runtime.skill]),
    );
    if (ownsWeapon(this.loadoutMask, def.startWeapon)) w.switchTo(def.startWeapon);
  }

  /**
   * One integer compare on a steady frame. It only does work when something
   * outside the mode has widened the mask — which is exactly what the host's
   * respawn path does, and exactly what must not survive into a campaign.
   */
  private enforceLoadout(): void {
    const w = this.ctx.host.game.weapons;
    if (w.owned === this.loadoutMask) return;
    if ((w.owned & ~this.loadoutMask) === 0) {
      // Narrower than we think: follow it rather than hand weapons back.
      this.loadoutMask = w.owned;
      return;
    }
    w.owned = this.loadoutMask;
    if (!ownsWeapon(this.loadoutMask, w.current)) w.switchTo(getMode(ModeId.QUEST).startWeapon);
  }

  /**
   * Turn a collected pickup into ammo, a weapon or a line of text.
   *
   * Weapons and ammo are client-owned (`WeaponRuntime`), so Quest applies them
   * itself and the result is authoritative. Health and armour are NOT: they
   * arrive in the snapshot from the server, so the grant's `health`/`armor` are
   * reported rather than applied, and a Quest-aware room is what makes a
   * medikit heal. Counting the item and printing Doom's line still happens
   * either way, so the intermission's items% is right today.
   */
  private applyPickup(index: number): void {
    const p = this.runtime.pickupAt(index);
    if (p === null) return;
    const game = this.ctx.host.game;
    const w = game.weapons;
    const g = fillPickupGrant(p, this.runtime.skill, this.grant);

    if (g.weapon >= 0) {
      this.loadoutMask |= 1 << g.weapon;
      const isNew = !ownsWeapon(w.owned, g.weapon);
      w.grant(g.weapon, false);
      // Doom puts a weapon you did not have into your hands.
      if (isNew) w.switchTo(g.weapon);
    }
    for (let t = 1; t < AMMO_TYPE_COUNT; t++) {
      if (g.ammo[t] > 0) w.addAmmo(t, g.ammo[t]);
    }

    if (g.message.length === 0) return;
    if (g.loud) this.hud.toast(g.message);
    game.hud.pushFeed(g.message, 's');
  }

  /* -------------------------------------------------------------------- *
   * Input — USE
   * -------------------------------------------------------------------- */

  /**
   * Edge-detect USE off the shared `InputManager` rather than adding a second
   * key listener, so a rebound USE key works here for free. `isDown` is stable
   * across the frame; the per-frame edge flags are cleared inside `game.tick`
   * and would be gone by the time a mode runs.
   */
  private pollUse(): void {
    const game = this.ctx.host.game;
    const down = game.playing && game.input.isDown(InputAction.Use);
    if (down === this.useWasDown) return;
    this.useWasDown = down;
    if (!down) return;

    game.net.eyePosition(this.eye);
    const f = game.camera.forward;
    const result = this.runtime.use(this.eye[0], this.eye[1], this.eye[2], f[0], f[1], f[2]);
    if (result === USE_NOTHING) return;

    // Mirror upstream so a Quest-aware room performs the same act on its copy.
    this.sendAction(ModeAction.USE, 0, 0,
      Math.round(this.eye[0]), Math.round(this.eye[1]), Math.round(this.eye[2]));
    if (result === USE_DOOR_LOCKED) game.camera.addShake(0.03, 70, 18);
  }

  /* -------------------------------------------------------------------- *
   * Kills and death
   * -------------------------------------------------------------------- */

  /**
   * The monster bodies belong to the sim, so a kill is observed rather than
   * caused: any tracked monster that goes dead or inactive since last frame
   * died, and its last known position tells the runtime which authored
   * placement it was. Allocation is bounded to one Map insert per new monster.
   */
  private trackKills(): void {
    const entities = this.ctx.host.game.net.entities;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (e.type > EntityType.LOST_SOUL) continue;
      const alive = e.active && (e.state & ES_DEAD) === 0;
      const slot = this.monsterSlot.get(e.id);
      if (alive) {
        let s = slot;
        if (s === undefined) {
          s = this.monsterCursor;
          this.monsterCursor = this.monsterCursor + 1 >= MONSTER_SLOTS ? 0 : this.monsterCursor + 1;
          this.monsterSlot.set(e.id, s);
        }
        const j = s * 3;
        this.monsterPos[j] = e.x;
        this.monsterPos[j + 1] = e.y;
        this.monsterPos[j + 2] = e.z;
        continue;
      }
      if (slot === undefined) continue;
      this.monsterSlot.delete(e.id);
      const j = slot * 3;
      this.runtime.notifyKill(this.monsterPos[j], this.monsterPos[j + 1], this.monsterPos[j + 2]);
    }
  }

  private trackDeath(): void {
    const game = this.ctx.host.game;
    const dead = game.net.local.dead;
    if (dead === this.wasDead) return;
    this.wasDead = dead;

    if (dead) {
      this.deaths++;
      this.phase = PHASE_DEAD;
      this.hud.banner('YOU DIED', 'The level restarts from the beginning — press Space or fire');
      game.hud.pushFeed('You died. Restarting the level.', 'k');
      return;
    }

    // RespawnPolicy.CHECKPOINT: Doom puts the level back exactly as authored —
    // every door shut, every switch cold, every pickup back on the floor, and
    // you back on the pistol. Keeping the shotgun you found would make dying
    // free, which is the one thing the campaign cannot afford.
    this.hud.clearBanner();
    this.phase = PHASE_LIVE;
    this.elapsed = 0;
    this.monsterSlot.clear();
    this.runtime.reset();
    this.applyLoadout();
    const respawn = this.runtime.spawn(this.spawnScratch);
    game.camera.setAngles(respawn.yaw, 0);
    // `reset()` re-arms every trigger, so every authored enemy will be asked
    // for again. Tell the room to clear the bodies from the last life first.
    this.sendAction(ModeAction.RESTART, 0, 0, 0, 0, 0);
    this.sendSpawnAnchor(respawn);
    this.hud.setKeys(0);
    this.hud.setExitOpen(false);
  }

  /* -------------------------------------------------------------------- *
   * HUD
   * -------------------------------------------------------------------- */

  private syncHud(): void {
    const r = this.runtime;
    if (this.serverDriven) {
      this.hud.setKeys(this.srvKeys);
      this.hud.setTally(
        this.srvKills, this.srvKillsTotal,
        this.srvItems, this.srvItemsTotal,
        this.srvSecrets, this.srvSecretsTotal,
      );
    } else {
      this.hud.setKeys(r.keys);
      this.hud.setTally(
        r.kills, r.totals.enemies,
        r.items, r.totals.items,
        r.secrets, r.totals.secrets,
      );
    }
    this.hud.setObjective(r.objective());
    this.hud.setExitOpen(r.exitArmed);
    this.hud.setTime(this.elapsed);
  }

  /* -------------------------------------------------------------------- *
   * Runtime events
   * -------------------------------------------------------------------- */

  private onRuntimeEvent(kind: QuestEvent, index: number, a: number, text: string): void {
    const game = this.ctx.host.game;
    switch (kind) {
      case QuestEvent.SECRET_FOUND:
        this.hud.flashSecret(text, this.runtime.secrets, this.runtime.totals.secrets);
        game.hud.pushFeed(text.length > 0 ? text : 'A secret is revealed!', 's');
        game.camera.addShake(0.015, 40, 12);
        break;
      case QuestEvent.KEY_TAKEN:
        this.hud.toast(text);
        game.hud.pushFeed(text, 'j');
        break;
      case QuestEvent.ITEM_TAKEN:
        this.applyPickup(index);
        break;
      case QuestEvent.DOOR_LOCKED:
        this.hud.toast(text, true);
        break;
      case QuestEvent.SWITCH_THROWN:
        if (text.length > 0) { this.hud.toast(text); game.hud.pushFeed(text, 'j'); }
        game.camera.addShake(0.025, 60, 16);
        break;
      case QuestEvent.EXIT_ARMED:
        this.hud.toast('The exit is open.');
        game.hud.pushFeed('The exit is open.', 'j');
        break;
      case QuestEvent.DOOR_OPENED:
        if (a !== 0) game.camera.addShake(0.02, 50, 14);
        break;
      case QuestEvent.DOOR_ROWS:
        // A room that is simulating this level has to carve the same rows, or
        // the doorway we can see through is still a wall to it. A room that is
        // not drops the action — see `ModeAction.SET_DOOR`.
        if (this.roomOwnsLevel) this.sendAction(ModeAction.SET_DOOR, index, a, 0, 0, 0);
        break;
      case QuestEvent.ENEMY_WOKE:
        this.requestEnemyBody(index, a);
        break;
      case QuestEvent.EXIT_REACHED:
        break;
      case QuestEvent.MESSAGE:
        if (text.length > 0) game.hud.pushFeed(text, 's');
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------------- *
   * Completion
   * -------------------------------------------------------------------- */

  private finishLevel(): void {
    const game = this.ctx.host.game;
    this.phase = PHASE_INTERMISSION;
    game.leavePlay();
    this.hud.clearBanner();
    this.hud.setObjective('LEVEL COMPLETE');

    const r = this.runtime;
    const stats = createIntermissionStats();
    stats.levelId = this.levelId;
    stats.levelName = this.level.meta.name;
    stats.kills = this.serverDriven ? this.srvKills : r.kills;
    stats.killsTotal = this.serverDriven ? this.srvKillsTotal : r.totals.enemies;
    stats.items = this.serverDriven ? this.srvItems : r.items;
    stats.itemsTotal = this.serverDriven ? this.srvItemsTotal : r.totals.items;
    stats.secrets = this.serverDriven ? this.srvSecrets : r.secrets;
    stats.secretsTotal = this.serverDriven ? this.srvSecretsTotal : r.totals.secrets;
    stats.timeSec = Math.round(this.elapsed);
    stats.parSec = this.level.meta.parTimeSec;

    const next = nextLevelIn(this.catalog, this.levelId, r.nextLevelId);
    const endsEpisode = next.length === 0 || r.endsEpisode;
    stats.newRecord = this.recordResult(stats, endsEpisode ? '' : next);

    const episode = episodeOf(this.catalog, this.levelId);
    const inter = new QuestIntermission({
      root: this.ctx.host.uiRoot,
      stats,
      episodeName: episode?.name ?? this.level.meta.episodeName,
      nextLevelName: this.catalog.names.get(next) ?? prettyId(next),
      endsEpisode,
      // Both gates, resolved once by the HUD's own helper. An offline run has
      // no server, so the room reports the kill switch off and no rows appear.
      economy: economySurfacesOn(game.economyProduct, game.net.flagBits),
      xp: Math.max(0, game.net.sessionXp - this.awardMarkXp),
      scrap: Math.max(0, game.net.sessionScrap - this.awardMarkScrap),
      onAdvance: () => { this.advance(next, endsEpisode); },
      onRestart: () => { this.restart(); },
      onQuit: () => { this.ctx.host.requestExit('quest-quit'); },
    });
    this.intermission = inter;
    this.ctx.scope.add(() => { inter.destroy(); });

    game.hud.pushFeed(
      `${this.level.meta.name} finished in ${formatTime(stats.timeSec)} (par ${formatTime(stats.parSec)})`,
      'j',
    );
  }

  private advance(next: string, endsEpisode: boolean): void {
    if (endsEpisode || next.length === 0) {
      this.ctx.host.requestExit('quest-episode-complete');
      return;
    }
    const params = { ...this.ctx.params, levelId: next };
    void this.ctx.registry.activate(params);
  }

  private restart(): void {
    const params = { ...this.ctx.params, levelId: this.levelId };
    void this.ctx.registry.activate(params);
  }

  /* -------------------------------------------------------------------- *
   * Saves
   * -------------------------------------------------------------------- */

  private storage(): SaveStorage | null {
    try {
      const ls = window.localStorage;
      return ls === null ? null : ls;
    } catch { return null; }
  }

  /** Count the attempt the moment the level starts, the way Doom's stats do. */
  private markAttempt(): void {
    const store = this.storage();
    if (store === null) return;
    try {
      const now = Date.now();
      const save = loadSave(store, now);
      const slot = beginQuest(save, this.level.meta.episodeId, this.levelId, this.runtime.skill, now);
      questLevelRecord(slot, this.levelId);
      storeSave(store, save, now);
    } catch { /* a save that will not write must never break the level */ }
  }

  private recordResult(
    stats: ReturnType<typeof createIntermissionStats>,
    nextLevelId: string,
  ): boolean {
    const store = this.storage();
    if (store === null) return false;
    try {
      const now = Date.now();
      const save: SaveFile = loadSave(store, now);
      const slot = beginQuest(save, this.level.meta.episodeId, this.levelId, this.runtime.skill, now);
      const record = recordQuestLevel(save, slot, {
        levelId: this.levelId,
        completed: true,
        timeSec: stats.timeSec,
        kills: stats.kills,
        killsTotal: stats.killsTotal,
        items: stats.items,
        itemsTotal: stats.itemsTotal,
        secrets: stats.secrets,
        secretsTotal: stats.secretsTotal,
        deaths: this.deaths,
        nextLevelId,
      }, now);
      storeSave(store, save, now);
      return record;
    } catch {
      return false;
    }
  }

  /* -------------------------------------------------------------------- *
   * Mode protocol
   * -------------------------------------------------------------------- */

  private sendSelect(): void {
    const m = this.selectMsg;
    m.modeId = ModeId.QUEST;
    m.skill = this.runtime.skill;
    m.flags = this.ctx.params.flags;
    m.seed = 0;
    m.levelId = this.levelId;
    m.worldId = '';
    this.ctx.host.send(encodeModeSelect(this.writer, m).copy());
  }

  /**
   * An authored enemy has woken: ask the room for a body at the place the level
   * actually put it. The room owns the monster from that moment — its AI, its
   * damage, its death — and `trackKills` picks the death back up off the
   * snapshot and books it against this authored slot. That round trip is what
   * makes the campaign's kill tally the same number the arena's is.
   */
  private requestEnemyBody(index: number, type: number): void {
    if (!this.runtime.enemyWorldPos(index, this.enemyScratch)) return;
    this.sendAction(
      ModeAction.SPAWN_ENEMY, type, 0,
      Math.round(this.enemyScratch[0]),
      Math.round(this.enemyScratch[1]),
      Math.round(this.enemyScratch[2]),
    );
  }

  /**
   * Pin the room's respawn to the authored player start. The level may have
   * been relocated onto wherever we happened to spawn (`alignSpawnTo`), so this
   * is sent after `place()` rather than read out of the level file.
   */
  private sendSpawnAnchor(spawn: QuestSpawn): void {
    const deg = Math.round((spawn.yaw * 180) / Math.PI);
    this.sendAction(
      ModeAction.SET_SPAWN, ((deg % 360) + 360) % 360, 0,
      Math.round(spawn.x), Math.round(spawn.y), Math.round(spawn.z),
    );
  }

  private sendAction(action: ModeAction, a: number, b: number, x: number, y: number, z: number): void {
    const m = this.actionMsg;
    m.action = action;
    m.a = a; m.b = b;
    m.x = x; m.y = y < 0 ? 0 : y > 255 ? 255 : y; m.z = z;
    m.seq = this.actionSeq++;
    this.ctx.host.send(encodeModeAction(this.writer, m).copy());
    void C2S_MODE.ACTION;
  }

  onModeState(state: ModeStateBuffer): void {
    if (state.modeId !== ModeId.QUEST) return;
    this.serverDriven = true;
    this.srvKills = state.a; this.srvKillsTotal = state.aTotal;
    this.srvItems = state.b; this.srvItemsTotal = state.bTotal;
    this.srvSecrets = state.c; this.srvSecretsTotal = state.cTotal;
    this.srvKeys = state.keys;
    if (state.elapsedMs > 0) this.elapsed = state.elapsedMs / 1000;
    if (state.phase === ModePhase.INTERMISSION && this.phase !== PHASE_INTERMISSION) {
      this.runtime.exitReached = true;
    }
  }

  onModeContext(context: ModeContextMessage): void {
    if (context.modeId !== ModeId.QUEST) return;
    if (context.levelId.length === 0 || context.levelId === this.levelId) {
      // The room has answered the only question placement is waiting on. A
      // non-zero content hash is its statement that its own world IS this
      // level; zero means the client's blit is the only copy there is.
      this.contextSeen = true;
      // Never downgrade after the level is on the ground: re-placing would
      // reset every door and switch the player has already used.
      if (!this.placed) this.roomOwnsLevel = context.contentHash !== 0;
      return;
    }
    // The room is running a different level than we loaded — follow it.
    const params = { ...this.ctx.params, levelId: context.levelId, skill: context.skill };
    void this.ctx.registry.activate(params);
  }

  onModeEvent(event: ModeEventMessage): void {
    const game = this.ctx.host.game;
    switch (event.kind) {
      case ModeEventKind.SECRET_FOUND:
        this.hud.flashSecret(event.text, event.a, event.b);
        break;
      case ModeEventKind.DOOR_LOCKED:
        this.hud.toast(event.text, true);
        break;
      case ModeEventKind.KEY_TAKEN:
      case ModeEventKind.SWITCH_USED:
      case ModeEventKind.OBJECTIVE:
        if (event.text.length > 0) { this.hud.toast(event.text); game.hud.pushFeed(event.text, 'j'); }
        break;
      default:
        if (event.text.length > 0) game.hud.pushFeed(event.text, 's');
        break;
    }
  }

  onAction(action: ModeAction): boolean {
    if (action === ModeAction.RESTART) { this.restart(); return true; }
    if (action === ModeAction.NEXT_LEVEL) {
      this.intermission?.advance();
      return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------------ */

/**
 * Register with `registry.register(ModeId.QUEST, questMode)`.
 *
 * The level is fetched here rather than in `enter` so a level that cannot load
 * never installs a half-live mode: the registry unwinds the scope and reports
 * through `onError` instead.
 */
export const questMode: ModeFactory = async (ctx: ModeContext): Promise<ModeInstance> => {
  const abort = ctx.scope.addAbort();
  ctx.host.setStatus('Loading level…');

  const catalog = await questCatalog();
  let id = ctx.params.levelId;
  if (id.length === 0 || catalog.order.indexOf(id) < 0) {
    id = catalog.order[0] ?? id;
  }
  if (id.length === 0) throw new Error('Quest: no levels are installed');

  const level = await loadQuestLevel(id, abort.signal);
  if (level.exit === null) throw new Error(`Quest: level "${id}" has no exit`);

  return new QuestMode(ctx, level, catalog);
};

/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

function asRecord(v: unknown): Record<string, unknown> {
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
}

/** `e1m3-warrens` -> `E1M3 Warrens`, for when no manifest supplied a name. */
export function prettyId(id: string): string {
  if (id.length === 0) return '';
  return id.split('-').map((part, i) => (
    i === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
  )).join(' ');
}

/** Eye height used when a caller needs the view origin without a NetClient. */
export const QUEST_EYE_HEIGHT = PLAYER_EYE_HEIGHT;
