/**
 * DOOMCRAFT — the glue.
 *
 * One object owns the renderer, the world mirror, the player rig, the weapon
 * runtime, the net client, the effects and the HUD, and wires them into a
 * single fixed-timestep loop:
 *
 *   accumulate real time -> N x fixedStep(1/60) -> net.update(dt) -> render(dt)
 *
 * The simulation rate is exactly the input rate (60 Hz) so one fixed step
 * produces exactly one input packet and one predicted movement step. Rendering
 * is decoupled: `NetClient` extrapolates the predicted body by the leftover
 * accumulator, and every visual system (viewmodel, fx, camera smoothing) runs
 * on the real frame delta, so a 144 Hz display is smooth and a 30 Hz one is
 * still correct.
 *
 * Ownership rules that matter:
 *   - `net.world` (ClientWorld) is the ONE authoritative voxel store on the
 *     client. ChunkRenderer keeps no voxels (its workers hold the mirror) and
 *     is fed from the net events. Nothing else copies the world.
 *   - Screen shake lives in `PlayerCamera` only; `Fx`'s own shake is disabled,
 *     otherwise the two stack and a rocket throws the camera twice as far.
 *   - Projectiles are drawn from the server's snapshot, never spawned locally,
 *     so a rocket exists exactly once.
 */

import * as THREE from 'three';

import {
  PLAYER_HALF_WIDTH, PLAYER_HEIGHT,
  PLAYER_EYE_HEIGHT, PLAYER_EYE_HEIGHT_CROUCH,
  RENDER_DISTANCE_CHUNKS_DESKTOP, RENDER_DISTANCE_CHUNKS_MOBILE,
  MAX_FRAME_DT, InputAction, REACH_BREAK, REACH_PLACE,
  GameMode, CHUNK_SIZE_X, CHUNK_SIZE_Z, chunkKey, blockToChunk,
  chunkKeyCX, chunkKeyCZ,
  SURFACE_DETAIL_SCALE, SURFACE_SEAM_SCALE,
  type GameSettings,
} from '@shared/constants';
import { type CustomBindings } from '@shared/controls';
import {
  BlockId, BLOCK_SOLID, BLOCK_LIQUID, minimapColor, PLACEABLE_BLOCKS,
} from '@shared/blocks';
import {
  WeaponId, WEAPON_COUNT, AMMO_TYPE_COUNT, getWeapon, ammoTypeOf, weaponFromSlot,
} from '@shared/weapons';
import {
  raycastVoxels, createVoxelHit, clampf, type VoxelHit,
} from '@shared/math';
import {
  BlockAction, EntityType, ChatChannel,
  BTN_FIRE, BTN_ALT_FIRE, BTN_BUILD, DMG_HEADSHOT, DMG_FATAL,
  type DamageEvent, type KillEvent, type ChatMessage,
} from '@shared/protocol';

import { GameRenderer } from '@/engine/renderer';
import { VoxelMaterials, DOOM_FOG } from '@/engine/material';
import { Skybox } from '@/engine/skybox';
import { ChunkRenderer } from '@/engine/chunkRenderer';
import { Fx } from '@/engine/fx';
import { Viewmodel, createViewmodelInput, type ViewmodelInput } from '@/engine/viewmodel';

import { PlayerCamera } from '@/player/camera';
import { InputManager } from '@/player/input';
import { resolveBuildEdit } from '@/game/buildEdit';

import {
  WeaponRuntime, createFireContext, createHitTargets, SWITCH_NONE,
  pushPlayerTarget, pushEntityTarget,
  type FireContext, type HitTargets, type WeaponFx,
} from '@/game/weapons';
import {
  EditAudioGate, createEditAudioPick,
} from '@/game/editAudio';

import { NetClient, type NetStatus } from '@/net/client';
import { ThirdPersonRenderer, loadCharacterAtlas } from '@/characters/thirdPerson';
import type { EnemyRenderer } from '@/characters/enemyRenderer';
import type { LocalServer } from '@/net/localServer';
import {
  GameSession,
  REMOTE_CONNECT_DEADLINE_MS,
  type SessionKind,
  type SessionState,
  type SessionTarget,
} from '@/net/session';

import {
  Hud, createHudState, economySurfacesOn,
  BLIP_ENEMY, BLIP_PLAYER, BLIP_PICKUP, MAX_BLIPS, MAX_BOARD_ROWS,
  type HudState,
} from '@/hud/hud';
import { Feature, isEnabled } from '@shared/features';
import { MobileControls } from '@/hud/mobile';

import { AudioEngine } from '@/audio/engine';
import { SpatialAudio } from '@/audio/spatial';
import { Sfx } from '@/audio/sfx';
import { ModeId } from '@shared/modes';
import { createAudioSave } from '@shared/saves';
import { Ambience, type LevelPalette } from '@/audio/ambience';
import { Music, trackFor } from '@/audio/music';
import { MonsterVoices, type CueEvent, type ListenerPose } from '@/audio/monsters';
import { shouldShowThreat, type AudioSettings } from '@/audio/settings';

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

/** Simulation rate. Equal to INPUT_SEND_HZ on purpose: one step, one packet. */
export const SIM_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

/** Entity state bits mirrored from server/src/sim.ts (value import avoided). */
const ES_DEAD = 1 << 3;
const ES_WINDUP = 1 << 6;

const EDIT_INTERVAL_MS = 140;

/** Metres in front of the eye where the world-space muzzle plume is spawned. */
const MUZZLE_STANDOFF = 0.7;
/**
 * Metres in front of the eye where a tracer starts. Further out than the plume
 * so the near end of the beam clears the gun instead of starting inside it, and
 * so the streak's own screen-space width floor has some depth to work with.
 */
const TRACER_STANDOFF = 0.95;
/** Scratch for the barrel position. Fx spawning must not allocate. */
const _muzzle = new THREE.Vector3();

/* ---- damage feedback ---------------------------------------------------- *
 * The full-screen part of "I am being hit" belongs to hud.hurt() — a radial
 * vignette that is transparent across the middle of the frame, so the thing you
 * are shooting at stays visible while the edges go red. These three numbers are
 * only the world's echo of it, and they are deliberately small: at HURT_MAX the
 * albedo multiplier is (1.14, 0.88, 0.83), a warm push of about a tenth of a
 * stop, not a colour filter. Sustained fire saturates at that value instead of
 * at a red sheet.
 * ------------------------------------------------------------------------- */
/* ---- death camera ------------------------------------------------------- */
/** Metres the boom pulls back off the corpse. */
const DEATH_BOOM = 3.8;
/** Rise, as a fraction of the boom, before normalisation. */
const DEATH_BOOM_RISE = 0.55;
/** Time constant of the pull-out, seconds. */
const DEATH_BOOM_TAU = 0.42;
/** Radians per second the camera drifts around the body. */
const DEATH_ORBIT_RATE = 0.20;
/** Metres above the corpse's feet the boom pivots about. */
const DEATH_PIVOT_Y = 1.0;
/** Metres above the corpse's feet the camera aims at. */
const DEATH_LOOK_Y = 0.70;
/** Metres of clearance kept off a wall the boom would otherwise enter. */
const DEATH_WALL_PAD = 0.45;
/** Seconds the body takes to fold onto the floor. */
const DEATH_COLLAPSE = 0.45;

/**
 * Metres of travel between footsteps.
 *
 * A stride, not a period. Sprinting covers ground faster and therefore steps
 * more often without a second timer, and the sprint stride is slightly LONGER
 * because a running gait genuinely reaches further per step — using the same
 * stride at a higher speed produces a machine-gun patter that reads as comic.
 */
const STEP_STRIDE_M = 2.1;
const STEP_STRIDE_SPRINT_M = 2.45;
const STEP_STRIDE_CROUCH_M = 1.5;

const HURT_MAX = 0.85;
const HURT_FADE_PER_SEC = 4.2;
/** Per-channel gain at hurtFlash == 1, as a delta from neutral. */
const HURT_WORLD = [0.165, -0.14, -0.20] as const;
/** The gun is closer to the eye, so it carries a little more of the flash. */
const HURT_VIEWMODEL = [0.22, -0.20, -0.27] as const;

/* Monster look-up: size and colour per EntityType, so the client never imports
 * the bot AI module (which would drag the whole server into the main bundle). */
interface ActorLook {
  halfW: number;
  height: number;
  body: number;
  trim: number;
  flying: boolean;
}
const MONSTER_LOOK: Record<number, ActorLook> = {
  [EntityType.IMP]: { halfW: 0.42, height: 1.75, body: 0x9c3a1c, trim: 0xffb03a, flying: false },
  [EntityType.ZOMBIE]: { halfW: 0.38, height: 1.8, body: 0x4d5a34, trim: 0xc8d24a, flying: false },
  [EntityType.CACODEMON]: { halfW: 0.85, height: 1.7, body: 0xa02222, trim: 0x66e0ff, flying: true },
  [EntityType.BARON]: { halfW: 0.62, height: 2.4, body: 0xc0a184, trim: 0x2fe06a, flying: false },
  [EntityType.LOST_SOUL]: { halfW: 0.35, height: 0.7, body: 0xf0e2c0, trim: 0xff7a1e, flying: true },
};
const PICKUP_COLOR: Record<number, number> = {
  [EntityType.PICKUP_HEALTH]: 0x22cc44,
  [EntityType.PICKUP_ARMOR]: 0x2f7fd0,
  [EntityType.PICKUP_AMMO]: 0xd8b23a,
  [EntityType.PICKUP_WEAPON]: 0xf0a020,
};

/**
 * A thing a MODE wants drawn on the ground — Quest's authored ammo boxes and
 * keycards, which live client-side and have no sim entity to ride in on.
 * Before this seam they were invisible 1.35 m trigger spheres, which is the
 * bug it exists to close. Drawn inside the actor batch, so a level's worth
 * of pickups costs zero extra draw calls.
 */
export interface GroundMarker {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  /** True renders a flat spinning card (keycards); false a supply cube. */
  readonly card: boolean;
}

/* ------------------------------------------------------------------------ *
 * Options / events
 * ------------------------------------------------------------------------ */

export interface GameEvents {
  onStatus?(status: NetStatus, detail?: string): void;
  /** 0..1 while the world streams, plus a human label. */
  onProgress?(progress: number, label: string): void;
  /** The world is drawable and the player exists: the menu may open. */
  onReady?(): void;
  /** The player died; `killer` is a display name. */
  onDeath?(killer: string): void;
  /** Pointer lock was lost while playing — open the pause menu. */
  onPauseRequested?(): void;
  onMatchOver?(): void;
  /** The client moved between the Worker room and a server, or fell back. */
  onSession?(state: SessionState): void;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hudRoot: HTMLElement;
  settings: GameSettings;
  name?: string;
  /** Packed avatar (client/src/characters/avatar.ts). 0 is the default marine. */
  avatar?: number;
  seed?: number;
  /** Legacy three-way `GameMode`, which is all the room constructor takes. */
  mode?: number;
  /**
   * The real four-way mode. Preferred over `mode`, which cannot express the
   * Quest/Builder split — `legacyGameMode` maps both onto `SANDBOX`.
   */
  modeId?: ModeId;
  bots?: number;
  enemies?: number;
  /** Force the touch HUD on. Auto-detected otherwise. */
  touch?: boolean;
  events?: GameEvents;

  /* --- online ---------------------------------------------------------- *
   * Empty by default, and that is load-bearing: the shipped static build has
   * no server, so an unconfigured client must never try to reach one. See
   * client/src/net/serverConfig.ts.
   * --------------------------------------------------------------------- */

  /** Game server origin. '' or absent = this build is offline-only. */
  serverUrl?: string;
  /** Stable per-device id, so a remote room can credit XP to the profile. */
  deviceId?: string;
  /** Pre-built session. Tests inject one; production lets Game build it. */
  session?: GameSession;
}

/**
 * How long `enterSession` waits for a new world before giving up on it.
 *
 * Generous, because the honest worst case is a cold room on a distant server
 * streaming its join burst over a phone connection. It is a backstop, not a
 * budget: the remote WELCOME deadline (`REMOTE_CONNECT_DEADLINE_MS`) is what
 * actually catches a dead server, six seconds earlier and without waiting for
 * any terrain at all.
 */
const SESSION_LIVE_TIMEOUT_MS = 12_000;

/**
 * Chunks that must have landed before a world counts as somewhere to stand.
 * The spawn neighbourhood is 3x3; this is the same bar `checkReady` uses.
 */
const MIN_LIVE_CHUNKS = 9;

/**
 * The best `ModeId` for a legacy `GameMode`.
 *
 * Lossy on purpose and only used as a fallback: `legacyGameMode` collapses
 * Quest and Builder onto `SANDBOX`, so the reverse cannot tell them apart and
 * picks Builder. Anything that knows the real mode passes `GameOptions.modeId`
 * instead, which every caller in this repo does.
 */
function modeIdFromLegacy(mode: number | undefined): ModeId {
  switch (mode) {
    case GameMode.HORDE: return ModeId.HORDE;
    case GameMode.SANDBOX: return ModeId.BUILDER;
    default: return ModeId.DEATHMATCH;
  }
}

/* ------------------------------------------------------------------------ *
 * Game
 * ------------------------------------------------------------------------ */

export class Game {
  readonly renderer: GameRenderer;
  readonly materials: VoxelMaterials;
  readonly sky: Skybox;
  readonly chunks: ChunkRenderer;
  readonly fx: Fx;
  /**
   * The audio stack.
   *
   * `audio` owns the context and the voice pool, `spatialAudio` turns a world
   * point into pan/gain/occlusion, and `sfx` is the catalogue plus the verbs
   * the rest of this class calls. No AudioContext exists until `unlockAudio`
   * is called from a real user gesture — see `main.ts`.
   */
  readonly audio: AudioEngine;
  /** Enemy vocalisations. Gameplay information, not decoration — see monsters.ts. */
  readonly monsters: MonsterVoices;
  /** Per-mode, per-level atmosphere driven by the level palette. */
  readonly ambience: Ambience;
  /** The Doom-idiom sequencer, with combat intensity. */
  readonly music: Music;
  readonly sfx: Sfx;
  private readonly spatialAudio: SpatialAudio;
  readonly viewmodel: Viewmodel;
  readonly camera: PlayerCamera;
  readonly input: InputManager;
  readonly weapons: WeaponRuntime;
  readonly hud: Hud;
  /** The touch pad, or null on a mouse-and-keyboard device. */
  readonly mobile: MobileControls | null;
  readonly net: NetClient;
  /**
   * Which authoritative room this client is talking to and how.
   *
   * `game.ts:446` used to call `createLocalServer()` unconditionally and hand
   * its transport to `NetClient`, so there was no branch to a server at all.
   * The session owns that branch now — see client/src/net/session.ts.
   */
  readonly session: GameSession;

  /**
   * The Worker room, when this session is in one. Null while remote.
   *
   * Kept because it was public surface before the session existed; the only
   * honest answer for a remote session is `null`, and every caller has to
   * handle that.
   */
  get server(): LocalServer | null { return this.session.localServer; }

  readonly hudState: HudState = createHudState();
  readonly events: GameEvents;

  /**
   * The player's own preference on seeing a balance, read ONCE.
   *
   * `isEnabled` hits localStorage, which is synchronous and must not be on the
   * frame path. The other half of the gate — the server's `economy_scrap` bit —
   * is a bit test on `net.flagBits` and is re-read every frame, so a room that
   * arrives with the switch off hides the chips the moment SESSION_CONFIG lands
   * without any event wiring.
   */
  readonly economyProduct: boolean = isEnabled(Feature.ECONOMY);

  /** True once the world is drawable and the local player exists. */
  ready = false;
  /** True while the player is driving. False in the menu / pause / boot. */
  playing = false;
  /** Wall-clock ms at which the game became interactive. */
  interactiveAtMs = 0;

  private settings: GameSettings;
  /** The session `connect()` brings up. Always local — see `connect()`. */
  private readonly bootTarget: SessionTarget;
  /** Timer id, non-null only while a remote session owes us a WELCOME. */
  private remoteWatchdog: number | null = null;
  /** True once any session has produced a WELCOME. */
  private netEverConnected = false;
  /** Bumped by every `enterSession`, so an overtaken switch bails out. */
  private sessionEpoch = 0;
  /** True while `enterSession`/`failOverToLocal` is tearing a session down. */
  private switching = false;
  private readonly touchMode: boolean;
  private readonly vmInput: ViewmodelInput = createViewmodelInput();
  private readonly fireCtx: FireContext = createFireContext();
  private readonly targets: HitTargets = createHitTargets();
  private readonly hit: VoxelHit = createVoxelHit();
  private readonly driver = {
    pos: new Float64Array(3),
    vel: new Float64Array(3),
    eyeY: 0,
    horizontalSpeed: 0,
    onGround: false,
    justLanded: false,
    landImpactSpeed: 0,
    crouching: false,
    sprinting: false,
  };

  /* actor rendering */
  private readonly actors: ActorRenderer;
  /**
   * Every remote player's body, in ONE instanced draw call. Separate from
   * `actors` because that batch is untextured boxes (monsters, pickups,
   * projectiles) and this one is the Kenney character rig with its own atlas.
   * Two draw calls total for everything that moves.
   */
  readonly characters: ThirdPersonRenderer;
  /**
   * The demons, as rigged bodies. One draw call for the whole cast.
   *
   * Null until `checkReady()` pulls it in. The whole subsystem — the renderer,
   * the animation state machine, the archetype registry and the glTF parser
   * behind them — is a dynamic import, because none of it is needed to reach
   * the menu and ref/BAR.md's 0.3 s time-to-interactive is the one thing this
   * feature is not allowed to spend. Measured, keeping it out of the entry
   * chunk is 16.8 KB gzipped; the GLTFLoader behind it is another 29.5 KB.
   */
  private demons: EnemyRenderer | null = null;
  /** The voxel sampler the ambience probe walks. Bound once, never allocated. */
  private readonly ambienceWorld = { getBlock: (x: number, y: number, z: number): number => this.sampleBlock(x, y, z) };
  /** Reused listener record — `listenerPose()` never allocates. */
  private readonly listener: ListenerPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private modeId: ModeId = ModeId.DEATHMATCH;
  private musicCue = '';
  private audioSettings: AudioSettings = createAudioSave();

  /* ---- projectile watch ------------------------------------------------ *
   * The server owns projectiles, so the client learns a rocket detonated by
   * watching one disappear out of the snapshot. Before this, it did not watch:
   * a rocket flew across the room as an unlit grey cube and then simply
   * stopped existing, with no fireball, no shockwave, no light and no shake —
   * three of the seven weapons had no impact feedback of any kind. These four
   * arrays are one frame of memory per projectile slot, which is all it takes
   * to turn "gone" into "went off, THERE".
   * ---------------------------------------------------------------------- */
  private projWatchLen = 0;
  private projWatchId = new Uint16Array(0);
  private projWatchWeapon = new Uint8Array(0);
  private projWatchPos = new Float32Array(0);

  /* loop */
  private accumulator = 0;
  private lastFrameMs = 0;
  private timeSeconds = 0;
  private wasOnGround = true;
  /**
   * Footstep cadence.
   *
   * Steps are driven by DISTANCE TRAVELLED, not by a timer: a timer makes a
   * crouch-walking player and a sprinting player step at the same rate, which
   * is the single most obvious way for footsteps to sound wrong. `stepAccum`
   * integrates horizontal speed and fires a step every `STEP_STRIDE_M`.
   */
  private stepAccum = 0;
  private lastSpin = 0;
  private wasFalling = false;
  private lastEditMs = -1e9;
  private buildMode = false;
  private buildBlockIndex = 0;
  /**
   * On touch, build mode takes Fire/AltFire so the pad's FIRE hold and screen
   * taps reach the edit path instead of a holstered gun (see `buildEdit.ts`).
   * Desktop never sets this — the mouse keeps driving `isDown()` unchanged.
   */
  private buildTouchTaken = false;
  private renderDistance: number;
  private matchSeconds = 0;
  private hurtFlash = 0;
  /** The live mode's standing grade, which the hurt flash rides on top of. */
  private readonly modeTint = new Float32Array([1, 1, 1]);
  private lastSlotSent = 0;
  private slotMismatchMs = 0;
  private wasDead = false;
  private disposed = false;

  /* ---- death camera ---------------------------------------------------- *
   * `characters/thirdPerson.ts` states plainly that this did not exist: on
   * death the camera stayed in the first-person rig and `hud.ts` painted a card
   * over whatever the corpse's eyes happened to be pointing at, which after a
   * rocket is usually a wall or the sky. It exists now, and it is the only
   * third-person view in the game — there is still no third-person PLAY mode
   * and nothing here makes one.
   *
   * It costs nothing when alive: the boom is `PlayerCamera.updateFree`, which
   * the boot drift already used, and the body rides in the character batch that
   * is already being drawn, so `characters.localBody` is zero extra draw calls.
   * ---------------------------------------------------------------------- */
  private deathCam = false;
  private deathTime = 0;
  private readonly deathAt = new Float64Array(3);
  private deathYaw = 0;
  /** The packed avatar the local player is wearing, for their own corpse. */
  private localAvatar = 0;

  /* streaming */
  private meshedSpawn = false;
  private readonly dirtyMinimap: number[] = [];

  /**
   * Which of the server's voxel changes get a sound — see `editAudio.ts`.
   *
   * Before this existed, `onBlocks` applied every block change in the match and
   * played nothing: other players' digging, explosion craters and every
   * server-side edit were silent, and the only world-edit sounds in the game
   * came from the local player's own click in `stepEdits`.
   */
  private readonly editAudio = new EditAudioGate();
  private readonly editAudioPick = createEditAudioPick();

  constructor(opts: GameOptions) {
    this.events = opts.events ?? {};
    this.settings = opts.settings;

    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.touchMode = opts.touch ?? coarse;

    /* ---- renderer ---------------------------------------------------- */
    this.renderer = new GameRenderer({
      canvas: opts.canvas,
      mobile: this.touchMode,
      fov: this.settings.fov,
      renderScale: this.settings.renderScale,
      clearColor: DOOM_FOG,
      onContextRestored: () => { this.chunks.clear(); this.resyncWorld(); },
    });

    this.materials = new VoxelMaterials({
      quality: this.settings.quality,
      ao: this.settings.ao,
      fog: this.settings.fog,
      // 'off' skips building the atlas at all, so a phone that never wants it
      // never pays the boot cost or the texture memory.
      texture: this.settings.surfaceDetail !== 'off',
    });
    // Doom is dark, but "dark" and "unreadable" are different things. The
    // shipped defaults render an obsidian wall at roughly #0e0c16, which is
    // black on a phone in daylight, so the light floor comes up and the
    // contrast curve comes down: the palette stays moody, the geometry stays
    // legible, and lava / muzzle flashes are still the only bright things.
    this.materials.setLightBalance(0.60, 0.40);
    this.materials.setExposure(1.12);
    this.materials.setContrast(0.14);
    this.materials.setSaturation(0.88);
    this.materials.setAoStrength(0.36);
    this.applySurfaceDetail(this.settings);

    this.sky = new Skybox();
    this.sky.addTo(this.renderer.scene);

    this.renderDistance = this.settings.renderDistance > 0
      ? this.settings.renderDistance
      : (this.touchMode ? RENDER_DISTANCE_CHUNKS_MOBILE : RENDER_DISTANCE_CHUNKS_DESKTOP);

    this.chunks = new ChunkRenderer(this.materials, {
      renderDistance: this.renderDistance,
      workerCount: meshWorkerCount(this.touchMode),
      maxUploadsPerFrame: 3,
      floorBlock: BlockId.BEDROCK,
    });
    this.chunks.attach(this.renderer.scene);
    this.materials.setFogFromRenderDistance(this.renderDistance);

    this.fx = new Fx(this.renderer.scene, { materials: this.materials });
    // One shake owner. PlayerCamera has it; Fx must not add a second.
    this.fx.setShakeScale(0);
    // Debris bounces off the world instead of sinking through it, and a crack
    // drawn on a face whose block has since been removed by anything at all —
    // a rocket, a server delta, another player — retires itself instead of
    // hanging in the air as an unanchored square.
    this.fx.setCollider((x, y, z) => BLOCK_SOLID[this.net.world.getBlock(x, y, z)] === 1);

    this.viewmodel = new Viewmodel({ fov: 68 });
    this.renderer.addOverlay(this.viewmodel);

    /* ---- player ------------------------------------------------------ */
    this.camera = new PlayerCamera();
    this.camera.baseFov = this.settings.fov;
    this.camera.sensitivity = this.settings.sensitivity;
    this.camera.touchSensitivity = this.settings.touchSensitivity;
    this.camera.invertY = this.settings.invertY;
    this.camera.shakeScale = this.settings.screenShake;
    this.camera.bobScale = this.settings.viewBob ? 1 : 0;

    this.input = new InputManager({
      target: opts.canvas,
      controlScheme: this.settings.controlScheme,
      toggleCrouch: this.settings.toggleCrouch,
      autoSprint: this.settings.autoSprint,
    });
    this.input.attach(opts.canvas);
    this.input.enabled = false;

    /* ---- HUD --------------------------------------------------------- */
    this.hud = new Hud(opts.hudRoot, {
      crosshair: this.settings.crosshair,
      crosshairColor: this.settings.crosshairColor,
      touchSink: this.input,
      onPause: () => this.events.onPauseRequested?.(),
      externalPad: this.touchMode,
    });
    this.hud.setTouchVisible(false);
    this.hud.setVisible(false);
    this.hudState.showFps = this.settings.fpsCounter;

    /* ---- mobile controls --------------------------------------------- *
     * Only built on a touch device, so a desktop player never pays for it and
     * never has a transparent capture surface over the canvas. The aim source
     * is assembled from `Game`'s existing public surface — no new engine hooks
     * were needed to make aim assist and auto-fire work. */
    this.mobile = this.touchMode
      ? new MobileControls({
        root: opts.hudRoot,
        sink: this.input,
        aim: {
          nearestEnemyAim: (out) => this.nearestEnemyAim(out),
          viewClearance: () => this.viewClearance(),
          addLookRadians: (yaw, pitch) => this.camera.addLook(yaw, pitch),
        },
        onPause: () => this.events.onPauseRequested?.(),
      })
      : null;

    /* ---- audio ------------------------------------------------------- *
     * Constructed, not started. `AudioEngine` builds no AudioContext until
     * `unlockAudio()` runs inside a user gesture, because a context created at
     * boot on iOS or Chrome comes up `suspended` and never recovers — the game
     * would be silent with nothing in the console to say why.
     *
     * The voice cap is halved on touch devices: a phone's audio thread shares a
     * core with the renderer, and past a dozen simultaneous voices nothing is
     * individually audible anyway, so the cap costs nothing and buys headroom. */
    this.audio = new AudioEngine({ maxVoices: this.touchMode ? 12 : 24 });
    this.spatialAudio = new SpatialAudio();
    this.spatialAudio.setWorld(this.sampleBlock, blockingSolid);
    this.spatialAudio.setFogFar(this.materials.fogFarDistance);
    this.sfx = new Sfx(this.audio, this.spatialAudio);
    this.audio.applySettings(this.settings);

    /* The three layers that are ABOUT the world rather than about the player's
       own actions. All three are constructed here and start nothing: the
       monster voices bake per archetype when one is first heard, and the bed
       and the sequencer wait for `unlockAudio()` like everything else.

       `onCue` is the accessibility seam. Every monster cue — including the ones
       the voice cap refused and the ones that happened while the context was
       suspended — arrives here with the bearing and whether it was audible, and
       `shouldShowThreat` decides whether the HUD draws it. A player who cannot
       hear the alert cry is not locked out of the mechanic that alert cries
       exist for. */
    this.monsters = new MonsterVoices(this.audio, {
      maxVoices: this.touchMode ? 4 : 6,
      onCue: (e) => this.onMonsterCue(e),
    });
    this.monsters.setSpatial(this.spatialAudio);
    this.ambience = new Ambience(this.audio);
    this.music = new Music(this.audio);

    /* ---- weapons ----------------------------------------------------- */
    this.weapons = new WeaponRuntime(this.buildWeaponFx(), this.camera, undefined);
    this.weapons.resetLoadout(ALL_WEAPONS_MASK);   // the local room grants the same set

    /* ---- actors ------------------------------------------------------ */
    this.actors = new ActorRenderer(this.renderer.scene);
    // Sharing the uniform OBJECTS, not their values: fog range, fog colour,
    // exposure, contrast, saturation and the mode/hurt tint all reach the
    // characters with no sync code, so they can never grade a frame behind the
    // wall behind them.
    this.characters = new ThirdPersonRenderer(this.renderer.scene, { grade: this.materials });
    // `demons` is built in checkReady(), off the critical path.

    /* ---- net --------------------------------------------------------- *
     * The transport is chosen per session, not once at construction. Boot is
     * always the Worker room — it is free, it is instant, and it is what the
     * menu renders behind — and `enterSession()` moves the client to a server
     * when a mode wants one. See client/src/net/session.ts for the policy.
     * ------------------------------------------------------------------- */
    this.bootTarget = {
      modeId: opts.modeId ?? modeIdFromLegacy(opts.mode),
      seed: opts.seed,
      botFill: opts.bots,
      enemies: opts.enemies ?? -1,
      allWeapons: true,
      // Boot never probes: the first frame must not wait on a network round
      // trip. `warmServer()` starts that in the background instead.
      force: 'local',
    };
    this.session = opts.session ?? new GameSession({
      serverUrl: opts.serverUrl,
      deviceId: opts.deviceId,
      onState: (state) => { this.onSessionState(state); },
    });

    this.localAvatar = (opts.avatar ?? 0) >>> 0;
    this.net = new NetClient({
      name: opts.name ?? 'Marine',
      avatar: opts.avatar ?? 0,
      // The factory, not a fixed transport: `NetClient` calls it on the first
      // connect AND on every reconnect, which is the seam that lets a session
      // move between the Worker and a socket without rebuilding the client.
      createTransport: () => this.session.createTransport(),
      autoReconnect: false,
      events: {
        onStatus: (s, d) => { this.onNetStatus(s, d); },
        onChunk: (cx, cz, voxels, received, total) => this.onChunk(cx, cz, voxels, received, total),
        onBlocks: (n, x, y, z, id, prev) => this.onBlocks(n, x, y, z, id, prev),
        onDamage: (e) => this.onDamage(e),
        onKill: (e) => this.onKill(e),
        onChat: (m) => this.onChat(m),
        /* The room's pinned variant table. Installed straight onto the
         * predictor, because the predictor is the only thing that reads it —
         * every firing-path lookup already goes through `weapons.stats()`. */
        onVariantTable: (arsenal, slots) => { this.weapons.adoptArsenal(arsenal, slots); },
        // A monster is killed and removed in the same server tick, so the only
        // notice the client ever gets that one died is this reason byte.
        onEntityGone: (v, reason) => {
          this.demons?.entityGone(v, reason);
          this.monsters.entityGone(v, reason, this.listenerPose());
        },
      },
    });
  }

  /* -------------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------------- */

  /**
   * Bring the boot session up and connect to it.
   *
   * Always local, always synchronous, exactly as it was before there was a
   * choice: the menu renders a live match behind it and the measured 305 ms
   * time-to-interactive is not allowed to grow a network round trip. The probe
   * that decides whether online is available runs in parallel and is finished
   * long before anybody clicks Play.
   */
  connect(): void {
    void this.session.start(this.bootTarget).then(() => {
      if (!this.disposed) this.net.connect();
    });
    // Fire and forget: warms the health cache so `enterSession` is instant.
    void this.session.checkServer();
  }

  /**
   * Move this client to the room a mode wants — the Worker's or a server's.
   *
   * Resolves with where it actually landed, which is not always where it was
   * asked to go: an unreachable server resolves as `'local'` rather than
   * rejecting, because the fallback is a real match and not an error state.
   *
   * Switching is a disconnect and a reconnect by construction. There is no
   * in-place handover: the two rooms are different simulations with different
   * worlds and different player ids, so the client's world and meshes are
   * dropped and re-streamed. See the header of session.ts.
   */
  async enterSession(target: SessionTarget): Promise<SessionKind> {
    if (this.disposed) return this.session.kind;
    const sameLocal = this.session.kind === 'local'
      && !this.session.prefersRemote(target)
      && this.netEverConnected;
    // Staying in the Worker for a mode that was already in the Worker is the
    // overwhelmingly common case (Quest -> Builder -> Quest). Tearing the room
    // down and re-streaming 169 chunks to arrive back where we started would
    // be a visible, pointless stall, so the mode layer's own
    // `C2S_MODE.SELECT` handles it exactly as it always has.
    if (sameLocal) return 'local';

    /* Two fast clicks on two tiles must not leave two half-built sessions
     * racing each other onto one `NetClient`. `sessionEpoch` makes the later
     * call the only one that gets to connect; `switching` suppresses the
     * failover path below, because the `closed` status our own `disconnect()`
     * raises is not a server going away. */
    const epoch = ++this.sessionEpoch;
    this.switching = true;
    this.clearRemoteWatchdog();
    this.net.disconnect();
    this.dropWorld();
    const state = await this.session.start(target);
    if (this.disposed || epoch !== this.sessionEpoch) return state.kind;
    this.switching = false;
    // A new session is a new body with a new player id, so the shot counter
    // starts again exactly as the server's does. See WeaponRuntime.beginSession.
    this.weapons.beginSession();
    this.net.setAutoReconnect(this.session.wantsAutoReconnect);
    this.armRemoteWatchdog();
    this.net.connect();

    /* The switch is not finished when the socket is open — it is finished when
     * the NEW world has arrived. A mode's `enter()` reads `net.world` to place
     * its level and its props, so activating it against the empty store we just
     * cleared would put the player inside a void. Waiting here is what keeps
     * every mode's own code unchanged by the existence of a server. */
    if (!await this.waitUntilLive(SESSION_LIVE_TIMEOUT_MS)) {
      // Nothing arrived. If we were waiting on a server, stop waiting on it.
      if (epoch === this.sessionEpoch && this.session.kind === 'remote') {
        this.failOverToLocal('server did not answer');
        await this.waitUntilLive(SESSION_LIVE_TIMEOUT_MS);
      }
    }
    return this.session.kind;
  }

  /**
   * Resolve once the current session has a world and a body in it.
   *
   * Polled rather than event-driven: "live" is a conjunction of three separate
   * signals (net status, chunk count, and the spawn actually existing) that
   * arrive in no fixed order, and a 60 ms poll against the frame loop that is
   * already running is both simpler and impossible to deadlock. Returns false
   * on the deadline instead of throwing — a timeout here is a fallback, not an
   * error.
   */
  private async waitUntilLive(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (this.disposed) return false;
      if (this.net.status === 'playing' && this.net.world.chunkCount >= MIN_LIVE_CHUNKS) return true;
      if (performance.now() >= deadline) return false;
      await new Promise<void>((done) => { setTimeout(done, 60); });
    }
  }

  /**
   * Forget the world we were in.
   *
   * Two different servers do not share a seed, and `NetClient.resetSession`
   * deliberately keeps the voxel store across a reconnect (a reconnect to the
   * SAME room must not re-download 169 chunks). Moving between rooms is the
   * case where that is wrong, and it is the only one, so the drop lives here
   * rather than in the net layer.
   */
  private dropWorld(): void {
    this.net.world.clear();
    this.chunks.clear();
    this.hud.clearFeed();
    // Voxel coordinates from the old world mean nothing in the new one, and a
    // stale self-edit record would silence the first dig at the same spot.
    this.editAudio.reset();
  }

  /* -------------------------------------------------------------------- *
   * The fallback watchdog
   *
   * "Offline must keep working" has a second half that is easy to miss: a
   * server that ACCEPTS the socket and then says nothing is worse than one
   * that refuses it, because the refusal is instant and the silence is a
   * spinner. `NetClient` on its own would sit in `reconnecting` forever. So a
   * remote session gets one deadline to produce a WELCOME, and misses it into
   * the Worker room instead.
   * -------------------------------------------------------------------- */

  private armRemoteWatchdog(): void {
    this.clearRemoteWatchdog();
    if (this.session.kind !== 'remote') return;
    this.remoteWatchdog = setTimeout(() => {
      this.remoteWatchdog = null;
      this.failOverToLocal('server did not answer');
    }, REMOTE_CONNECT_DEADLINE_MS) as unknown as number;
  }

  private clearRemoteWatchdog(): void {
    if (this.remoteWatchdog === null) return;
    clearTimeout(this.remoteWatchdog as unknown as ReturnType<typeof setTimeout>);
    this.remoteWatchdog = null;
  }

  /** Give up on the server and bring the Worker room up in its place. */
  private failOverToLocal(reason: string): void {
    if (this.disposed || this.switching) return;
    this.clearRemoteWatchdog();
    if (!this.session.fallBackToLocal(reason)) return;
    this.switching = true;
    this.net.disconnect();
    this.dropWorld();
    this.switching = false;
    this.net.setAutoReconnect(false);
    this.net.connect();
  }

  private onNetStatus(status: NetStatus, detail?: string): void {
    // WELCOME landed: the server is real and the deadline has been met.
    if (status === 'loading' || status === 'playing') {
      this.netEverConnected = true;
      this.clearRemoteWatchdog();
    }
    /* A remote session that closes for good — refused, 1013 server full, a
     * protocol mismatch — must not leave the player staring at a dead menu.
     * `switching` excludes the `closed` we raise ourselves while moving between
     * sessions, which is not a server going away and must not be reported as
     * one (nor spend the single fallback this session is allowed). */
    if (!this.switching && this.session.kind === 'remote' && (status === 'closed' || status === 'error')) {
      this.failOverToLocal(detail !== undefined && detail.length > 0 ? detail : 'server closed the connection');
      return;
    }
    this.events.onStatus?.(status, detail);
  }

  private onSessionState(state: SessionState): void {
    this.events.onSession?.(state);
  }

  /** Enter play: pointer lock, input on, HUD live. */
  enterPlay(): void {
    if (!this.ready || this.disposed) return;
    this.playing = true;
    this.input.enabled = true;
    this.input.releaseAll();
    this.hud.setVisible(true);
    this.hud.layout();
    this.hud.setTouchVisible(this.touchMode);
    this.mobile?.setVisible(this.touchMode);
    if (!this.touchMode) this.input.requestPointerLock();
    this.camera.resetTransients();
  }

  /** Leave play for a menu. Keeps rendering; stops driving. */
  leavePlay(): void {
    this.playing = false;
    this.hud.setVisible(false);
    this.input.enabled = false;
    this.input.releaseAll();
    this.input.exitPointerLock();
    this.hud.setTouchVisible(false);
    this.mobile?.setVisible(false);
    this.net.setButtons(0);
    this.net.setMove(0, 0);
  }

  /**
   * Some environments (embedded frames, automation) never grant pointer lock.
   * Rather than a dead game, accept raw mouse deltas without it.
   */
  allowUnlockedLook(on: boolean): void {
    this.input.unlockedLook = on;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRemoteWatchdog();
    this.net.dispose();
    this.session.dispose();
    this.input.detach();
    this.mobile?.dispose();
    this.hud.dispose();
    this.actors.dispose();
    this.characters.dispose();
    this.demons?.dispose();
    this.chunks.dispose();
    this.audio.dispose();
    this.fx.dispose();
    this.viewmodel.dispose();
    this.sky.dispose();
    this.materials.dispose();
    this.renderer.dispose();
  }

  /* -------------------------------------------------------------------- *
   * Settings
   * -------------------------------------------------------------------- */

  /**
   * The rows the player rebound by hand. Sparse, and NOT part of `GameSettings`
   * — it persists on its own key so a settings reset does not wipe a keymap and
   * a keymap reset does not wipe the settings.
   */
  private customBindings: CustomBindings = {};

  /**
   * Replace the pinned rows and re-resolve both binding layers against the live
   * scheme. The settings panel calls this after every rebind.
   */
  setCustomBindings(custom: CustomBindings): void {
    this.customBindings = custom;
    this.input.applyControlScheme(this.settings.controlScheme, custom);
  }

  applySettings(s: GameSettings): void {
    this.settings = s;
    this.camera.baseFov = s.fov;
    this.camera.sensitivity = s.sensitivity;
    this.camera.touchSensitivity = s.touchSensitivity;
    this.camera.invertY = s.invertY;
    this.camera.shakeScale = s.screenShake;
    this.camera.bobScale = s.viewBob ? 1 : 0;
    this.input.toggleCrouch = s.toggleCrouch;
    this.input.autoSprint = s.autoSprint;
    // Both binding layers are rebuilt from (scheme + the player's pinned rows),
    // so a scheme switch and a rebind can never disagree about what is bound.
    this.input.applyControlScheme(s.controlScheme, this.customBindings);

    this.renderer.setRenderScale(s.renderScale);
    this.materials.setQuality(s.quality);
    this.applySurfaceDetail(s);
    this.materials.setAoEnabled(s.ao);
    this.materials.setFogEnabled(s.fog);
    this.viewmodel.setBobEnabled(s.viewBob);

    const rd = clampInt(s.renderDistance, 2, 8);
    if (rd !== this.renderDistance) {
      this.renderDistance = rd;
      this.chunks.setRenderDistance(rd);
      this.materials.setFogFromRenderDistance(rd);
      // The audio horizon follows the fog. A sound arriving clearly from a
      // place the renderer has hidden behind fog is a bug you hear before you
      // can explain it, so the two distances are never allowed to diverge.
      this.spatialAudio.setFogFar(this.materials.fogFarDistance);
    }

    this.hud.setCrosshair(s.crosshair, s.crosshairColor);
    this.hudState.showFps = s.fpsCounter;
    this.audio.applySettings(s);
  }

  /* -------------------------------------------------------------------- *
   * Audio lifecycle
   * -------------------------------------------------------------------- */

  /**
   * Start (or resume) audio. MUST be called from inside a user-gesture handler.
   *
   * Idempotent and cheap after the first success, so `main.ts` can call it from
   * every plausible first gesture — click, touch, keydown — without having to
   * work out which one the player will actually use. That matters more than it
   * looks: get this wrong and the game is silent on iOS and on Chrome with no
   * error anywhere to explain it.
   *
   * The catalogue bake is queued here rather than run here; `render()` spends
   * it a few milliseconds per frame so the click that starts the match does not
   * also stall it.
   */
  unlockAudio(): boolean {
    const ok = this.audio.unlock();
    if (ok) {
      this.audio.applySettings(this.settings);
      this.sfx.beginBake();
      /* Both of these schedule against `ctx.currentTime`, so they cannot start
         before the clock is running — a bed started against a suspended context
         arrives all at once the instant it resumes. */
      this.ambience.start();
      this.music.setTrack(trackFor(this.modeId, this.musicCue));
      this.music.start();
    }
    return ok;
  }

  /**
   * Point the world-audio layers at a level.
   *
   * The palette has been on `LevelMeta` since the level format was written and
   * `musicCue` is documented there as "key the audio layer looks up"; nothing
   * read either until now.
   */
  setLevelAudio(palette: LevelPalette, mode: ModeId, musicCue: string): void {
    this.modeId = mode;
    this.musicCue = musicCue;
    this.ambience.setLevel(palette, mode);
    this.music.setTrack(trackFor(mode, musicCue));
    this.monsters.stopAll();
    this.hud.clearThreats();
  }

  /**
   * Master switch for the three WORLD audio layers.
   *
   * Exists so `tools/audio-world-bench.mjs` can measure a control run in which
   * every other system is bit-for-bit identical and only this feature is off.
   * A bench that compares two different builds is comparing two different
   * builds, which is how a frame cost gets attributed to the wrong thing.
   */
  worldAudioEnabled = true;

  /** What the active mode wants drawn on the ground. See `GroundMarker`. */
  private groundMarkers: readonly GroundMarker[] = [];

  /**
   * Replace the mode's ground markers. Pass `[]` on teardown — the array is
   * read every frame until then. Quest calls this after placement and after
   * every pickup, so the marker set is always exactly the untaken set.
   */
  setGroundMarkers(markers: readonly GroundMarker[]): void {
    this.groundMarkers = markers;
  }

  /** The audio mix and the accessibility rule. Owned by main.ts, read here. */
  setAudioSettings(a: AudioSettings): void { this.audioSettings = a; }

  /**
   * Where the fog goes total, metres.
   *
   * The ambience bed uses it as the size of the room, which is the same number
   * the renderer uses to decide you cannot see across it. A level you cannot
   * see across and a level that sounds enormous would be two different rooms.
   */
  get fogFarMetres(): number { return this.materials.fogFarDistance; }

  /** Eye and view yaw — the same listener `spatial.ts` gets. */
  private listenerPose(): ListenerPose {
    const p = this.listener;
    p.x = this.camera.eyeX; p.y = this.camera.eyeY; p.z = this.camera.eyeZ;
    p.yaw = this.camera.viewYaw;
    return p;
  }

  /**
   * A monster made a noise. Draw it when the player would not have heard it.
   *
   * The threat ring is world-anchored and re-projected every frame by the HUD,
   * so the bearing stays true while the player turns onto it — which is the
   * entire point, and the reason this is a bearing rather than an icon.
   */
  private onMonsterCue(e: CueEvent): void {
    if (!shouldShowThreat(this.audioSettings, e.heard)) return;
    // Loudness is zero for a cue that never sounded, so fall back to distance:
    // the visual must not be invisible precisely when it is the only channel.
    const power = e.heard
      ? Math.min(1, 0.3 + e.loudness * 0.7)
      : Math.min(1, 0.3 + 0.7 * Math.max(0, 1 - e.distance / 70));
    this.hud.threat(e.yaw, power);
  }

  /**
   * How much trouble the player is in, 0..1, for the music.
   *
   * Deliberately crude and deliberately cheap: the count of living monsters
   * inside the fog, weighted by how close the nearest one is, plus a large
   * term for being hurt. A threat model with more opinions in it would need
   * tuning per mode; this one only has to be monotone in "am I in a fight",
   * because `music.ts` quantises it to four tiers with hysteresis and only
   * looks at it on a bar line.
   */
  private computeThreat(): number {
    const net = this.net;
    let near = 0;
    let nearest = Infinity;
    const ex = this.camera.eyeX; const ez = this.camera.eyeZ;
    for (let i = 0; i < net.entities.length; i++) {
      const e = net.entities[i];
      if (!e.active || e.type >= EntityType.PICKUP_HEALTH) continue;
      const dx = e.x - ex; const dz = e.z - ez;
      const d2 = dx * dx + dz * dz;
      if (d2 > 90 * 90) continue;
      near++;
      if (d2 < nearest) nearest = d2;
    }
    if (near === 0) return 0;
    const dist = Math.sqrt(nearest);
    const proximity = Math.max(0, 1 - dist / 60);
    const crowd = Math.min(1, near / 8);
    const hurt = 1 - Math.max(0, Math.min(1, net.local.health / 100));
    return Math.min(1, 0.18 + 0.42 * proximity + 0.34 * crowd + 0.28 * hurt);
  }

  /** Tab visibility. Suspends the context so a hidden tab costs nothing. */
  setAudioHidden(hidden: boolean): void { this.audio.setTabHidden(hidden); }

  /**
   * The surface atlas escape hatch, in one place.
   *
   * `setSurfaceDetail`, `setSeamStrength` and the `texture:` option all existed
   * and nothing called any of them, so `setQuality` moved MAX_LIGHTS and left a
   * low-end phone paying full price for the texture path. This is the wiring:
   * the preset picks a global scale, and `off` drops the shader define outright
   * rather than multiplying a fetch by zero.
   */
  private applySurfaceDetail(s: GameSettings): void {
    const preset = s.surfaceDetail;
    this.materials.setTextureEnabled(preset !== 'off');
    this.materials.setSurfaceDetail(SURFACE_DETAIL_SCALE[preset]);
    this.materials.setSeamStrength(0.12 * SURFACE_SEAM_SCALE[preset]);
  }

  /* -------------------------------------------------------------------- *
   * Net events
   * -------------------------------------------------------------------- */

  private onChunk(cx: number, cz: number, voxels: Uint8Array, received: number, total: number): void {
    this.chunks.setChunk(cx, cz, voxels);
    this.hud.updateMinimapChunk(cx, cz, voxels);
    this.events.onProgress?.(
      Math.min(1, received / Math.max(1, total)),
      `Streaming terrain ${received}/${total}`,
    );
  }

  /**
   * The server's voxel changes: mesh them, repaint the minimap, and — the part
   * that did not exist — make them audible.
   *
   * `EditAudioGate` owns the rules (nearest of each kind, one break and one
   * place per message at most, never inside 60 ms, never our own echo); this
   * only has to hand it the deltas and play what comes back.
   */
  private onBlocks(
    count: number, xs: Int16Array, ys: Uint8Array, zs: Int16Array, ids: Uint8Array,
    prev: Uint8Array,
  ): void {
    const dirty = this.dirtyMinimap;
    dirty.length = 0;
    for (let i = 0; i < count; i++) {
      const x = xs[i], y = ys[i], z = zs[i];
      this.chunks.setBlock(x, y, z, ids[i]);
      const key = chunkKey(blockToChunk(x), blockToChunk(z));
      if (dirty.indexOf(key) < 0 && dirty.length < 24) dirty.push(key);
    }
    for (let i = 0; i < dirty.length; i++) {
      const key = dirty[i];
      const cx = chunkKeyCX(key);
      const cz = chunkKeyCZ(key);
      const v = this.net.world.chunkAt(cx, cz);
      if (v !== undefined) this.hud.updateMinimapChunk(cx, cz, v);
    }

    const ear = this.net.renderPos;
    const pick = this.editAudioPick;
    if (!this.editAudio.pick(
      count, xs, ys, zs, ids, prev, ear[0], ear[1], ear[2], performance.now(), pick,
    )) return;
    if (pick.breakIndex >= 0) {
      const i = pick.breakIndex;
      // The material is the block that WAS there. `ids[i]` is AIR, and
      // `materialOf(AIR)` is dirt, so passing it would make every remote dig —
      // through stone, through glass, through metal — sound like a flowerbed.
      this.sfx.blockBreak(xs[i] + 0.5, ys[i] + 0.5, zs[i] + 0.5, prev[i]);
    }
    if (pick.placeIndex >= 0) {
      const i = pick.placeIndex;
      this.sfx.blockPlace(xs[i] + 0.5, ys[i] + 0.5, zs[i] + 0.5);
    }
  }

  /** After a context loss the workers keep their mirror; the meshes do not. */
  private resyncWorld(): void {
    for (const [key, voxels] of this.net.world.chunks) {
      this.chunks.setChunk(chunkKeyCX(key), chunkKeyCZ(key), voxels);
    }
  }

  /* -------------------------------------------------------------------- *
   * Grade
   * -------------------------------------------------------------------- */

  /**
   * The live mode's standing colour grade, as an albedo multiplier. This is the
   * ONLY thing besides the hurt flash that is allowed to touch uTint, and the
   * two compose rather than overwrite each other — a mode that set a warm grade
   * used to have it wiped the first time the player was hit, and restored to
   * neutral (not to its own value) when the flash ran out.
   *
   * Keep it near 1. uTint multiplies the albedo before exposure and the clamp,
   * so a channel much above 1 clips the bright end and collapses hue, and a
   * channel much below 1 takes a dark palette under 8-bit quantisation.
   */
  setModeTint(r: number, g: number, b: number): void {
    this.modeTint[0] = clampf(r, 0.5, 1.5);
    this.modeTint[1] = clampf(g, 0.5, 1.5);
    this.modeTint[2] = clampf(b, 0.5, 1.5);
    this.applyTint();
  }

  private applyTint(): void {
    const f = this.hurtFlash;
    const t = this.modeTint;
    this.materials.setTint(
      t[0] * (1 + f * HURT_WORLD[0]),
      t[1] * (1 + f * HURT_WORLD[1]),
      t[2] * (1 + f * HURT_WORLD[2]),
    );
    this.viewmodel.setTint(
      t[0] * (1 + f * HURT_VIEWMODEL[0]),
      t[1] * (1 + f * HURT_VIEWMODEL[1]),
      t[2] * (1 + f * HURT_VIEWMODEL[2]),
    );
  }

  private onDamage(e: DamageEvent): void {
    const me = this.net.playerId;
    if (e.victimId === me) {
      // dir points attacker -> victim, so the arrow points back along it.
      const yaw = Math.atan2(e.dirX, e.dirZ);
      this.hud.hurt(e.amount, yaw, this.camera.viewYaw);
      // The damage READ is hud.hurt(): a radial vignette that is fully
      // transparent across the middle 42% of the frame plus a directional
      // arrow. This is only the world's share of it — a warm push, not a
      // filter. It used to add 0.35 per hit against a 3.4/s fade, so anything
      // hitting more often than every 300 ms pinned it at full and multiplied
      // the whole albedo by (1.55, 0.34, 0.28): red clipped, green and blue
      // were cut to a third, and a Horde wave turned the screen into one flat
      // orange sheet. Rising per hit is right; reaching a lens filter is not.
      this.hurtFlash = Math.min(HURT_MAX, this.hurtFlash + 0.14 + e.amount / 260);
      // Fatal damage is the death cry's job, not the hurt cry's — playing both
      // on the killing blow gives a doubled voice on the one event that most
      // needs to be clean.
      if ((e.flags & DMG_FATAL) === 0) this.sfx.hurt(e.amount);
    } else if (e.attackerId === me) {
      this.hud.hitMarker((e.flags & DMG_HEADSHOT) !== 0, (e.flags & DMG_FATAL) !== 0, e.amount);
    }
  }

  private onKill(e: KillEvent): void {
    const killer = this.nameOf(e.killerId);
    const victim = e.victimId === 0 ? 'a demon' : this.nameOf(e.victimId);
    const weapon = getWeapon(e.weaponId).name;
    this.hud.pushFeed(`${killer}  ›${weapon}›  ${victim}`, 'k');
    if (e.victimId === this.net.playerId) {
      this.sfx.death();
      this.events.onDeath?.(killer);
      this.hudState.status = 'YOU DIED';
      this.hudState.subStatus = 'Click or press Space to respawn';
    }
  }

  private onChat(m: ChatMessage): void {
    const kind = m.channel === ChatChannel.SYSTEM ? 'j' : m.channel === ChatChannel.TIP ? 's' : 's';
    const who = m.senderId === 0 ? '' : `${this.nameOf(m.senderId)}: `;
    this.hud.pushFeed(`${who}${m.text}`, kind);
  }

  private nameOf(id: number): string {
    if (id === 0) return 'Hell';
    const p = this.net.playerById(id);
    return p === undefined || p.name === '' ? `#${id}` : p.name;
  }

  /* -------------------------------------------------------------------- *
   * Weapon feedback adapter
   * -------------------------------------------------------------------- */

  private buildWeaponFx(): WeaponFx {
    return {
      fire: (weaponId: number): void => {
        this.viewmodel.fire(weaponId);
        // The gunshot rides the SAME hook as the viewmodel kick, so the sound
        // and the recoil can never drift apart by a frame — which is exactly
        // the desync `ref/BAR.md` calls out as "no audio punch" in the bar.
        this.sfx.weaponFire(weaponId, this.weapons.spin);
      },
      muzzleFlash: (weaponId, x, y, z, dx, dy, dz): void => {
        // Out of the BARREL, not out of the crosshair. `muzzleWorld` returns the
        // world point that lands on the same pixel as the drawn gun, which is
        // both where a flash belongs and — since it is no longer on the aim
        // axis — no longer a wash over the thing being shot at. See the block
        // comment on Viewmodel.muzzleWorld.
        const m = this.viewmodel.muzzleWorld(
          x, y, z, dx, dy, dz, MUZZLE_STANDOFF, _muzzle, this.renderer.camera.fov,
        );
        this.fx.muzzleFlash(m.x, m.y, m.z, dx, dy, dz, weaponId);
      },
      tracer: (_weaponId, x0, y0, z0, x1, y1, z1, color): void => {
        // Same barrel, and for the same reason twice over: a streak fired from
        // the eye along the view axis projects to a POINT at the crosshair and
        // cannot be seen by the person who fired it.
        let dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-4) return;
        dx /= len; dy /= len; dz /= len;
        // Point blank: a barrel further out than the wall would give a beam
        // that runs BACKWARDS from the muzzle. Halve into the gap instead.
        const stand = len < TRACER_STANDOFF * 2 ? len * 0.5 : TRACER_STANDOFF;
        const m = this.viewmodel.muzzleWorld(
          x0, y0, z0, dx, dy, dz, stand, _muzzle, this.renderer.camera.fov,
        );
        this.fx.tracer(m.x, m.y, m.z, x1, y1, z1, color);
      },
      impact: (x, y, z, nx, ny, nz, blockId): void => {
        // The blockId goes through as well as the colour: Fx uses it to bite a
        // crack out of the struck face, so a wall that has been shot at looks
        // shot at rather than merely marked.
        this.fx.impact(x, y, z, nx, ny, nz, minimapColor(blockId), 1, blockId);
        // Positioned, and gated: a shotgun reports seven of these in one frame
        // and they must collapse to one impact rather than seven stacked copies.
        this.sfx.impact(x, y, z, blockId);
      },
      blockStrike: (x, y, z, nx, ny, nz, blockId, _weaponId, power): void => {
        this.fx.blockStrike(x, y, z, nx, ny, nz, blockId, power);
        this.viewmodel.bite(0.35 + 0.5 * power);
        this.sfx.impact(x, y, z, blockId, 0.6 + 0.4 * power);
      },
      fleshImpact: (x, y, z, nx, ny, nz, _targetId, headshot): void => {
        this.fx.blood(x, y, z, -nx, -ny, -nz, headshot ? 1.6 : 1);
        this.sfx.flesh(x, y, z, headshot);
      },
      hitMarker: (damage, headshot, killed): void => {
        // The marker scales with damage, so a graze and a slug do not read the
        // same. `hud.hitMarker` treats the third argument as optional.
        if (this.settings.hitMarkers) this.hud.hitMarker(headshot, killed, damage);
      },
      hitConfirm: (x, y, z, nx, ny, nz, damage, headshot, killed): void => {
        this.fx.hitConfirm(x, y, z, nx, ny, nz, damage, headshot, killed);
        // A kill is a different jolt, not a bigger one — see Viewmodel.hitConfirm.
        this.viewmodel.hitConfirm(killed ? 1 : clampf(0.22 + damage / 90, 0, 1), killed);
      },
      dryFire: (weaponId): void => { this.sfx.weaponDry(weaponId); },
      reloadStart: (weaponId, ms): void => {
        this.viewmodel.reload(ms);
        this.sfx.weaponReload(weaponId);
      },
      // Shell-by-shell weapons (the shotgun) get one click PER SHELL, which is
      // what makes a partial reload audibly different from a full one.
      reloadShell: (weaponId): void => { this.sfx.weaponReload(weaponId); },
      switchStart: (_from, to): void => {
        this.viewmodel.setWeapon(to);
        this.sfx.weaponSwitch(to);
      },
      // The chaingun's barrels coming up to speed. Fired once on the way up,
      // not every frame the spin value changes.
      spin: (weaponId, value): void => {
        if (weaponId === WeaponId.CHAINGUN && value > 0.04 && this.lastSpin <= 0.04) {
          this.sfx.chaingunSpin();
        }
        this.lastSpin = value;
      },
    };
  }

  /* -------------------------------------------------------------------- *
   * Movement audio
   * -------------------------------------------------------------------- */

  /**
   * Footsteps, jumps and landings.
   *
   * Steps are driven by DISTANCE, not by a clock. A timer gives a
   * crouch-walking player and a sprinting player the same cadence, which is the
   * most obvious way for footsteps to sound wrong; integrating horizontal speed
   * and firing every `STEP_STRIDE_M` means the cadence falls out of the
   * movement code for free and stays correct for every speed the player can
   * reach, including the ones added later.
   *
   * The material comes from the block BELOW the feet, sampled once per step
   * rather than once per frame — one voxel lookup every ~0.4 s is free, and
   * sampling per frame would be 60x the cost for an answer that cannot change
   * faster than a stride.
   */
  private updateMovementAudio(dt: number, d: typeof this.driver): void {
    if (!this.playing || this.net.local.dead) { this.stepAccum = 0; return; }

    /* --- jump: the frame the feet leave a surface with upward velocity --- */
    if (!d.onGround && this.wasFalling === false && d.vel[1] > 0.5) {
      this.sfx.jump();
      this.wasFalling = true;
    }
    if (d.onGround) this.wasFalling = false;

    /* --- landing --- */
    if (d.justLanded) {
      // `landImpact` is the speed the body arrived at, which is exactly the
      // right input: a step off a kerb and a four-storey drop are the same
      // EVENT and must not be the same SOUND.
      this.sfx.land(d.landImpactSpeed);
      // Reset the stride so the first step after a landing is a full stride
      // away rather than firing immediately on top of the landing thump.
      this.stepAccum = 0;
      return;
    }

    /* --- footsteps --- */
    if (!d.onGround) { this.stepAccum = 0; return; }
    const speed = d.horizontalSpeed;
    if (speed < 0.6) { this.stepAccum = 0; return; }

    this.stepAccum += speed * dt;
    const stride = d.crouching ? STEP_STRIDE_CROUCH_M
      : d.sprinting ? STEP_STRIDE_SPRINT_M : STEP_STRIDE_M;
    if (this.stepAccum < stride) return;
    this.stepAccum -= stride;

    // One block below the feet. `pos` is feet centre, so a small bias keeps the
    // sample inside the block being stood on rather than on the boundary.
    const bx = Math.floor(d.pos[0]);
    const by = Math.floor(d.pos[1] - 0.2);
    const bz = Math.floor(d.pos[2]);
    const below = this.sampleBlock(bx, by, bz);
    this.sfx.footstep(below, d.sprinting && !d.crouching);
  }

  /* -------------------------------------------------------------------- *
   * Projectiles in flight, and the moment they stop being in flight
   * -------------------------------------------------------------------- */

  /**
   * Give every live projectile its trail and its light, and detonate the ones
   * that vanished since last frame.
   *
   * The server never sends "this rocket exploded" — it just stops including the
   * projectile in the snapshot and sends the block deltas and damage events the
   * blast produced. So the detonation point is the LAST position we saw, which
   * is accurate to one snapshot of dead reckoning and is the difference between
   * a fireball at the wall and no fireball at all.
   *
   * A slot can also be recycled by a different projectile in the same frame, so
   * the id is compared as well as the active flag — otherwise a busy Horde wave
   * silently swallows detonations.
   */
  private trackProjectiles(dt: number): void {
    const list = this.net.projectiles;
    if (list.length !== this.projWatchLen) {
      this.projWatchLen = list.length;
      this.projWatchId = new Uint16Array(list.length);
      this.projWatchWeapon = new Uint8Array(list.length);
      this.projWatchPos = new Float32Array(list.length * 3);
    }

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const had = this.projWatchId[i];
      const gone = had !== 0 && (!p.active || p.id !== had);
      if (gone) {
        this.detonateAt(
          this.projWatchWeapon[i],
          this.projWatchPos[i * 3], this.projWatchPos[i * 3 + 1], this.projWatchPos[i * 3 + 2],
        );
      }

      if (!p.active) {
        this.projWatchId[i] = 0;
        continue;
      }

      const speed = Math.hypot(p.vx, p.vy, p.vz);
      if (speed > 1e-3) {
        this.fx.projectileTrail(
          p.x, p.y, p.z, p.vx / speed, p.vy / speed, p.vz / speed, p.weapon, dt,
        );
      }
      this.projWatchId[i] = p.id;
      this.projWatchWeapon[i] = p.weapon;
      this.projWatchPos[i * 3] = p.x;
      this.projWatchPos[i * 3 + 1] = p.y;
      this.projWatchPos[i * 3 + 2] = p.z;
    }
  }

  /**
   * The blast, and the camera's share of it.
   *
   * Shake is scaled by distance because a rocket going off across the arena and
   * one going off at your feet are the same event to the server and very much
   * not the same event to you. `PlayerCamera` owns shake (Fx's own is disabled),
   * so the amplitude is routed there rather than through `Fx.addShake`.
   */
  private detonateAt(weaponId: number, x: number, y: number, z: number): void {
    const def = getWeapon(weaponId);
    const radius = def.splashRadius > 0 ? def.splashRadius : 1.2;

    // Lay the scorch against the ground under the burst unless there is a wall
    // right beside it — a mark floating in mid-air is worse than no mark.
    let nx = 0, ny = 1, nz = 0;
    if (raycastVoxels(
      x, y, z, 0, -1, 0, radius * 0.9, this.sampleBlock, blockingSolid, this.hit,
    )) {
      nx = this.hit.nx; ny = this.hit.ny; nz = this.hit.nz;
    }
    this.fx.explosionFor(weaponId, x, y, z, nx, ny, nz);
    this.sfx.explosion(x, y, z, radius);

    const dx = x - this.camera.eyeX;
    const dy = y - this.camera.eyeY;
    const dz = z - this.camera.eyeZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Inverse-square would make anything past 10 m produce nothing; a linear
    // rolloff over three splash radii keeps a distant rocket felt as a thump.
    const falloff = clampf(1 - dist / (radius * 3 + 8), 0, 1);
    if (falloff > 0.02) {
      this.camera.addShake(
        (0.14 + radius * 0.06) * falloff * falloff,
        200 + radius * 20,
        18,
      );
      if (falloff > 0.55) this.camera.addFovPunch(-1.6 * falloff, 6);
    }
  }

  /* -------------------------------------------------------------------- *
   * The loop
   * -------------------------------------------------------------------- */

  /** Drive one animation frame. `nowMs` is the rAF timestamp. */
  tick(nowMs: number): void {
    if (this.disposed) return;
    if (this.lastFrameMs === 0) this.lastFrameMs = nowMs;
    let dt = (nowMs - this.lastFrameMs) / 1000;
    this.lastFrameMs = nowMs;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    this.timeSeconds += dt;
    if (this.playing) this.matchSeconds += dt;

    /* --- fixed-rate simulation ---------------------------------------- */
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= SIM_DT;
      steps++;
      this.fixedStep(SIM_DT);
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    /* --- prediction + interpolation ----------------------------------- */
    this.net.update(dt);

    /* --- presentation -------------------------------------------------- */
    this.render(dt);

    if (!this.ready) this.checkReady();
  }

  /** One 1/60 s slice: input, weapons, and exactly one command to the server. */
  private fixedStep(dt: number): void {
    const input = this.input;

    /* --- touch controls ------------------------------------------------
       Before `input.update()`, so a trigger press, an auto-fire lock or a
       tap-to-shoot pulse produced by the pad is folded into this step's edges
       rather than the next one's. It is also the only place the pad writes
       DOM: its pointer handlers do arithmetic and nothing else. */
    if (this.mobile !== null) {
      this.mobile.update(dt, performance.now(), this.playing && !this.net.local.dead);
    }

    input.update();

    const playing = this.playing && !this.net.local.dead;

    /* --- look ---------------------------------------------------------
       `turnDelta` is polled unconditionally, playing or not: it owns the
       held-time ramp behind DOOM's two-stage keyboard turn, and a step that
       skipped it would leave a stale ramp for the next turn. It returns 0
       under the Modern scheme, where nothing is bound to the turn actions. */
    const keyTurn = input.turnDelta(dt);
    if (this.playing) {
      if (keyTurn !== 0) this.camera.addLook(keyTurn, 0);
      if (input.lookDx !== 0 || input.lookDy !== 0) {
        this.camera.addLookPixels(input.lookDx, input.lookDy, false);
      }
      if (input.touchLookDx !== 0 || input.touchLookDy !== 0) {
        this.camera.addLookPixels(input.touchLookDx, input.touchLookDy, true);
      }
      if (input.stickLookX !== 0 || input.stickLookY !== 0) {
        this.camera.addLookStick(input.stickLookX, input.stickLookY, 3.6, dt);
      }
    }

    /* --- weapon selection --------------------------------------------- */
    if (playing) {
      const slotKey = input.consumeSlotKey();
      if (slotKey > 0) {
        this.buildMode = false;
        this.weapons.switchTo(weaponFromSlot(slotKey));
      }
      if (input.justPressed(InputAction.NextWeapon)) this.weapons.cycle(1);
      if (input.justPressed(InputAction.PrevWeapon)) this.weapons.cycle(-1);
      if (input.justPressed(InputAction.BuildMode)) {
        this.buildMode = !this.buildMode;
        this.hud.pushFeed(this.buildMode ? 'Build mode ON — LMB digs, RMB places' : 'Build mode off', 's');
      }
      if (input.isDown(InputAction.Reload)) this.weapons.startReload();
      if (this.buildMode) {
        if (input.justPressed(InputAction.NextWeapon)) this.cycleBuildBlock(1);
        if (input.justPressed(InputAction.PrevWeapon)) this.cycleBuildBlock(-1);
      }
    }

    this.syncBuildTake();

    /* --- aim ----------------------------------------------------------- */
    const eyeX = this.driver.pos[0];
    const eyeY = this.driver.eyeY;
    const eyeZ = this.driver.pos[2];
    const f = this.camera.forward;

    /* --- weapon runtime (client-side feel; the server owns damage) ----- */
    const ctx = this.fireCtx;
    ctx.nowMs = this.timeSeconds * 1000;
    ctx.ox = eyeX; ctx.oy = eyeY; ctx.oz = eyeZ;
    ctx.dx = f[0]; ctx.dy = f[1]; ctx.dz = f[2];
    ctx.firing = playing && !this.buildMode && input.isDown(InputAction.Fire);
    ctx.altFiring = playing && input.isDown(InputAction.AltFire);
    ctx.airborne = !this.net.predicted.onGround;
    ctx.crouched = this.net.predicted.crouching;
    ctx.ownerId = this.net.playerId;
    ctx.world = this.worldAdapter;
    ctx.targets = this.refillTargets();
    ctx.team = 255;
    this.weapons.update(dt, ctx);

    /* --- world edits ---------------------------------------------------- */
    if (playing) this.stepEdits(eyeX, eyeY, eyeZ, f[0], f[1], f[2]);

    /* --- respawn -------------------------------------------------------- */
    if (this.net.local.dead && this.playing
      && (input.isDown(InputAction.Jump) || input.isDown(InputAction.Fire))) {
      this.net.requestRespawn();
    }

    /* --- the command ---------------------------------------------------- */
    let buttons = playing ? input.buttonsMask() : 0;
    if (this.buildMode) buttons &= ~(BTN_FIRE | BTN_ALT_FIRE);
    if (this.buildMode) buttons |= BTN_BUILD;
    this.net.setButtons(buttons);
    this.net.setMove(playing ? input.moveX : 0, playing ? input.moveZ : 0);
    // Fire along the VIEW angles: recoil moves the crosshair, so the server has
    // to shoot where the crosshair is, not where the un-kicked aim was.
    this.net.setLook(this.camera.viewYaw, this.camera.viewPitch);
    this.lastSlotSent = this.buildMode ? 7 : this.weapons.current;
    this.net.setSlot(this.lastSlotSent);

    input.endFrame();
  }

  /**
   * Keep Fire/AltFire taken exactly while a touch player is in build mode and
   * in control, so the control pad's gestures reach `stepEdits` (a taken action
   * reads released from every source, then back through
   * `takenHeld`/`consumeTakenTap`). Released while dead so the FIRE disc still
   * respawns, and never taken on desktop (`touchMode` false) so the mouse path
   * is byte-for-byte unchanged. Toggled only on transition — re-asserting it
   * would clear the tap latch a step before `stepEdits` consumes it.
   */
  private syncBuildTake(): void {
    const want = this.touchMode && this.buildMode
      && this.playing && !this.net.local.dead;
    if (want === this.buildTouchTaken) return;
    this.buildTouchTaken = want;
    this.input.setActionTaken(InputAction.Fire, want);
    this.input.setActionTaken(InputAction.AltFire, want);
  }

  /** Break / place, rate limited, predicted through the net client. */
  private stepEdits(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    const nowMs = this.timeSeconds * 1000;
    if (nowMs - this.lastEditMs < EDIT_INTERVAL_MS) return;
    const { wantBreak, wantPlace } = resolveBuildEdit(this.input, this.buildMode, this.buildTouchTaken);
    if (!wantBreak && !wantPlace) return;

    const reach = wantBreak ? REACH_BREAK : REACH_PLACE;
    const ok = raycastVoxels(
      ox, oy, oz, dx, dy, dz, reach,
      this.sampleBlock, blockingForEdit, this.hit,
    );
    if (!ok) return;
    this.lastEditMs = nowMs;

    if (wantBreak) {
      const id = this.hit.block;
      if (id === BlockId.BEDROCK || id === BlockId.AIR) return;
      // Where the ray actually met the face, so the dust and the light land at
      // the aim point instead of at the middle of a block that is already gone.
      const cx = ox + dx * this.hit.distance;
      const cy = oy + dy * this.hit.distance;
      const cz = oz + dz * this.hit.distance;
      // The bite lands BEFORE the break: one frame of cracked face and dust at
      // the contact point is the difference between a block that was broken and
      // a block that vanished.
      this.fx.blockStrike(cx, cy, cz, this.hit.nx, this.hit.ny, this.hit.nz, id, 0.55);
      this.viewmodel.bite(0.6);
      if (this.net.requestEdit(BlockAction.BREAK, this.hit.x, this.hit.y, this.hit.z, 0)) {
        this.chunks.setBlock(this.hit.x, this.hit.y, this.hit.z, BlockId.AIR);
        this.fx.blockBreak(
          this.hit.x, this.hit.y, this.hit.z, id,
          cx, cy, cz, this.hit.nx, this.hit.ny, this.hit.nz,
        );
        this.camera.addShake(0.02, 60, 22);
        this.viewmodel.fire();
        this.sfx.blockBreak(cx, cy, cz, id);
        this.editAudio.noteSelf(this.hit.x, this.hit.y, this.hit.z, performance.now());
      }
      return;
    }

    const px = this.hit.x + this.hit.nx;
    const py = this.hit.y + this.hit.ny;
    const pz = this.hit.z + this.hit.nz;
    if (py < 0 || py > 63) return;
    // Never seal yourself inside the block you are standing in.
    const feet = this.driver.pos;
    if (boxOverlaps(feet[0], feet[1], feet[2], PLAYER_HALF_WIDTH, PLAYER_HEIGHT, px, py, pz)) return;
    const block = PLACEABLE_BLOCKS[this.buildBlockIndex] ?? BlockId.STONE;
    if (this.net.requestEdit(BlockAction.PLACE, px, py, pz, block)) {
      this.chunks.setBlock(px, py, pz, block);
      this.fx.impact(px + 0.5, py + 0.5, pz + 0.5, 0, 1, 0, minimapColor(block), 0.4);
      this.viewmodel.fire();
      this.sfx.blockPlace(px + 0.5, py + 0.5, pz + 0.5);
      this.editAudio.noteSelf(px, py, pz, performance.now());
    }
  }

  private cycleBuildBlock(dir: number): void {
    const n = PLACEABLE_BLOCKS.length;
    this.buildBlockIndex = (this.buildBlockIndex + dir + n) % n;
  }

  /* -------------------------------------------------------------------- *
   * Render
   * -------------------------------------------------------------------- */

  private render(dt: number): void {
    const net = this.net;
    const gr = this.renderer;

    /* --- camera driver from the predicted body ------------------------- */
    const d = this.driver;
    d.pos[0] = net.renderPos[0];
    d.pos[1] = net.renderPos[1];
    d.pos[2] = net.renderPos[2];
    d.vel[0] = net.predicted.vel[0];
    d.vel[1] = net.predicted.vel[1];
    d.vel[2] = net.predicted.vel[2];
    d.eyeY = net.renderPos[1] + (net.predicted.crouching ? PLAYER_EYE_HEIGHT_CROUCH : PLAYER_EYE_HEIGHT);
    d.horizontalSpeed = Math.hypot(d.vel[0], d.vel[2]);
    d.onGround = net.predicted.onGround;
    d.crouching = net.predicted.crouching;
    d.sprinting = net.predicted.sprinting;
    d.justLanded = d.onGround && !this.wasOnGround;
    d.landImpactSpeed = net.predicted.landImpact;
    this.wasOnGround = d.onGround;

    /* --- audio ---------------------------------------------------------- *
     * Everything the audio layer needs per frame, in one place and in this
     * order: keep baking if there is anything left, move the listener, then
     * emit the movement sounds that depend on the driver state just computed.
     */
    if (this.audio.ready) {
      // A slice of synthesis, not the whole catalogue. See `Sfx.bakeStep`.
      if (!this.sfx.bakeComplete) this.sfx.bakeStep();
      // One demon species a frame, for the same reason and at the same cost:
      // the alternative is paying ten milliseconds on the frame the first Imp
      // of the match arrives, which is a frame that already has an Imp in it.
      else if (this.worldAudioEnabled && !this.monsters.primeComplete) this.monsters.primeStep();

      // The listener is the EYE and the VIEW yaw — not the feet and not the
      // body yaw. Panning off the body would make sounds swing when the
      // player turns their head while strafing, which reads as a bug.
      this.spatialAudio.setListener(
        this.camera.eyeX, this.camera.eyeY, this.camera.eyeZ, this.camera.viewYaw,
      );
      this.spatialAudio.beginFrame(this.timeSeconds * 1000);
      this.updateMovementAudio(dt, d);

      /* The three world layers, in the one place, after the listener has moved.
         None of them allocates and none of them schedules a node: the monster
         pass is a walk over at most 256 flat-array entries, the bed writes four
         gains only when a target actually moved, and the sequencer runs on its
         own timer entirely off this thread of control. */
      if (this.worldAudioEnabled) {
        this.monsters.update(dt, this.listenerPose(), this.net.entities);
        this.ambience.update(dt, this.camera.eyeX, this.camera.eyeY, this.camera.eyeZ, this.ambienceWorld);
        this.music.setThreat(this.computeThreat());
      }
    }

    if (this.ready && this.playing && net.local.dead) {
      this.updateDeathCamera(dt, net);
    } else if (this.ready) {
      if (this.deathCam) {
        this.deathCam = false;
        this.characters.localBody = null;
        // Hand the look back where the player was facing when they died, not
        // wherever the orbit happened to stop, or every respawn starts with the
        // camera pointing somewhere the player never chose.
        this.camera.setAngles(this.deathYaw, 0);
        this.camera.resetTransients();
      }
      this.camera.update(dt, d);
    } else {
      // Boot / menu: a slow drift over the arena so the first frame is alive.
      this.camera.yaw += dt * 0.06;
      this.camera.pitch = -0.12;
      this.camera.updateFree(dt, d.pos[0], d.eyeY + 1.2, d.pos[2]);
    }
    this.camera.applyTo(gr.camera);

    /* --- viewmodel ------------------------------------------------------ */
    const vm = this.vmInput;
    vm.yaw = this.camera.viewYaw;
    vm.pitch = this.camera.viewPitch;
    vm.speed = d.horizontalSpeed;
    vm.grounded = d.onGround;
    vm.sprinting = d.sprinting;
    vm.crouching = d.crouching;
    vm.inWater = net.predicted.inWater;
    vm.firing = this.fireCtx.firing;
    vm.reloading = this.weapons.reloading;
    if (d.justLanded) vm.landImpact = clampf(d.landImpactSpeed / 16, 0, 1);
    this.viewmodel.setEnabled(this.playing && !net.local.dead);
    // resetLoadout() (respawn) moves the runtime's weapon without going through
    // switchTo, so the switchStart hook never fires and the model would keep
    // whatever was in hand when you died. One comparison per frame closes it.
    if (this.weapons.switchPhase === SWITCH_NONE && this.viewmodel.weaponId !== this.weapons.current) {
      this.viewmodel.setWeapon(this.weapons.current, true);
    }
    this.viewmodel.update(dt, vm);

    /* --- hurt flash ------------------------------------------------------ */
    if (this.hurtFlash > 0) {
      this.hurtFlash = Math.max(0, this.hurtFlash - dt * HURT_FADE_PER_SEC);
      this.applyTint();
    }

    /* --- fx ------------------------------------------------------------- */
    this.fx.setViewportHeight(gr.drawHeight);
    this.trackProjectiles(dt);
    this.fx.update(dt, gr.camera);
    this.materials.setTime(this.timeSeconds);

    /* --- world + actors -------------------------------------------------- */
    this.chunks.update(gr.camera);
    // While the rig is still in flight (or if it 404s) `demons.ready` is false
    // and ActorRenderer keeps drawing monsters as boxes, so a slow fetch
    // degrades to exactly the game that shipped before, not to an empty arena.
    const rigged = this.demons !== null && this.demons.ready;
    this.actors.update(net, this.timeSeconds, !rigged, this.groundMarkers);
    this.demons?.update(net, gr.camera, dt, this.timeSeconds);
    this.characters.update(net, this.timeSeconds);

    gr.render(dt);

    this.updateHud(dt);
  }

  /* -------------------------------------------------------------------- *
   * HUD feed
   * -------------------------------------------------------------------- */

  private updateHud(dt: number): void {
    const s = this.hudState;
    const net = this.net;
    const w = this.weapons;

    this.reconcileLoadout();

    s.health = net.local.health;
    s.armor = net.local.armor;
    s.weapon = w.current;
    s.mag = w.magazine;
    s.reserve = w.reserveAmmo;
    // Per-type reserves so the HUD hotbar can mark the guns you cannot feed.
    for (let i = 0; i < AMMO_TYPE_COUNT; i++) s.reserveByType[i] = w.reserve[i];
    s.owned = w.owned;
    // The TRUE cone, not just the heat: a crosshair that stays tight while you
    // are airborne is telling the player something that is not so.
    s.spread = w.liveSpreadFraction(!this.net.predicted.onGround, this.net.predicted.crouching);
    s.reloading = w.reloading;
    const def = getWeapon(w.current);
    s.reloadFrac = w.reloading && def.reloadMs > 0
      ? 1 - w.reloadRemainingMs / (def.reloadShellMs > 0 ? def.reloadShellMs : def.reloadMs)
      : 0;
    s.kills = net.local.kills;
    s.deaths = net.local.deaths;
    /* Server truth, straight through. `net.sessionXp` moves only in
       `NetClient.onMatchAward`; the offline localStorage ledger in main.ts is a
       different number for a different purpose and never reaches this line. */
    s.economy = economySurfacesOn(this.economyProduct, net.flagBits);
    s.xp = net.sessionXp;
    s.scrap = net.sessionScrap;
    s.dead = net.local.dead;
    s.fps = 1 / Math.max(1e-3, dt);
    s.ping = net.rttMs;
    s.matchSeconds = this.matchSeconds;

    let alive = 0;
    for (let i = 0; i < net.players.length; i++) if (net.players[i].active) alive++;
    s.playersAlive = alive;

    if (!net.local.dead && s.status === 'YOU DIED') { s.status = ''; s.subStatus = ''; }

    s.camX = this.driver.pos[0];
    s.camZ = this.driver.pos[2];
    s.camYaw = this.camera.viewYaw;

    /* blips */
    let n = 0;
    for (let i = 0; i < net.players.length && n < MAX_BLIPS; i++) {
      const p = net.players[i];
      if (!p.active || p.id === net.playerId) continue;
      s.blipX[n] = p.x; s.blipZ[n] = p.z; s.blipKind[n] = BLIP_PLAYER; n++;
    }
    for (let i = 0; i < net.entities.length && n < MAX_BLIPS; i++) {
      const e = net.entities[i];
      if (!e.active || (e.state & ES_DEAD) !== 0) continue;
      const pickup = e.type >= EntityType.PICKUP_HEALTH;
      s.blipX[n] = e.x; s.blipZ[n] = e.z;
      s.blipKind[n] = pickup ? BLIP_PICKUP : BLIP_ENEMY;
      n++;
    }
    s.blipCount = n;

    /* scoreboard, only while Tab is held */
    s.boardOpen = this.playing && this.input.isDown(InputAction.Scoreboard);
    if (s.boardOpen) {
      const board = net.scoreboard();
      const rows = Math.min(board.length, MAX_BOARD_ROWS);
      for (let i = 0; i < rows; i++) {
        const p = board[i];
        s.boardName[i] = p.name === '' ? `#${p.id}` : p.name;
        s.boardKills[i] = p.kills;
        s.boardDeaths[i] = p.deaths;
        s.boardPing[i] = p.id === net.playerId ? Math.round(net.rttMs) : 0;
        s.boardIsLocal[i] = p.id === net.playerId ? 1 : 0;
      }
      s.boardCount = rows;
    }

    this.hud.update(s, dt);
  }

  /**
   * The server owns ammo. The client runtime predicts it so the counter drops
   * on the shot frame instead of a round trip later; this pulls it back into
   * line whenever the two have drifted by more than a rounding error, and
   * refills the whole loadout on respawn.
   */
  private reconcileLoadout(): void {
    const net = this.net;
    const w = this.weapons;

    if (net.local.dead !== this.wasDead) {
      this.wasDead = net.local.dead;
      if (!net.local.dead) {
        w.resetLoadout(ALL_WEAPONS_MASK);
        w.switchTo(net.local.weapon);
        this.camera.resetTransients();
        this.hudState.status = '';
        this.hudState.subStatus = '';
      }
    }
    if (net.local.dead || net.status !== 'playing') return;
    if (w.reloading || w.switchPhase !== SWITCH_NONE) return;

    // Following the server's weapon blindly fights the player: the server is a
    // round trip behind, so for ~100 ms after pressing 4 it still reports the
    // pistol and the correction yanks the rocket back out of your hands. Only
    // follow once the server has acknowledged the slot we actually asked for —
    // or after a second, which means it refused and the client is wrong.
    if (net.local.weapon !== w.current && w.pending < 0) {
      if (net.local.weapon === this.lastSlotSent) {
        w.switchTo(net.local.weapon);
        this.slotMismatchMs = 0;
      } else {
        this.slotMismatchMs += SIM_DT * 1000;
        if (this.slotMismatchMs > 1000) {
          w.switchTo(net.local.weapon);
          this.slotMismatchMs = 0;
        }
      }
    } else {
      this.slotMismatchMs = 0;
    }
    const id = w.current;
    if (net.local.weapon === id && Math.abs(net.local.mag - w.mag[id]) > 2) {
      w.mag[id] = net.local.mag;
    }
    const type = ammoTypeOf(id);
    if (type !== 0 && Math.abs(net.local.reserve - w.reserve[type]) > 2) {
      w.reserve[type] = net.local.reserve;
    }
  }

  /* -------------------------------------------------------------------- *
   * Hit targets
   * -------------------------------------------------------------------- */

  private refillTargets(): HitTargets {
    const t = this.targets;
    t.count = 0;
    const net = this.net;
    for (let i = 0; i < net.players.length; i++) {
      const p = net.players[i];
      if (!p.active || p.id === net.playerId) continue;
      // Health goes in so WeaponRuntime can predict a KILL on the same frame
      // as the shot instead of waiting for the server's DMG_FATAL.
      pushPlayerTarget(t, p.id, p.x, p.y, p.z, p.health > 0, p.team, p.health);
    }
    for (let i = 0; i < net.entities.length; i++) {
      const e = net.entities[i];
      if (!e.active || e.type > EntityType.LOST_SOUL) continue;
      if ((e.state & ES_DEAD) !== 0) continue;
      const look = MONSTER_LOOK[e.type];
      if (look === undefined) continue;
      pushEntityTarget(
        t, e.id, e.x, e.y, e.z, look.halfW, look.height,
        look.height * 0.78, look.halfW * 0.7, true, 254, e.health,
      );
    }
    return t;
  }

  /* -------------------------------------------------------------------- *
   * Readiness
   * -------------------------------------------------------------------- */

  private checkReady(): void {
    if (this.net.status !== 'playing' && this.net.status !== 'loading') return;
    if (this.net.world.chunkCount < 9) return;
    const cx = Math.floor(this.driver.pos[0] / CHUNK_SIZE_X);
    const cz = Math.floor(this.driver.pos[2] / CHUNK_SIZE_Z);
    if (!this.meshedSpawn) {
      this.meshedSpawn = this.chunks.isMeshed(cx, cz);
      if (!this.meshedSpawn) return;
    }
    if (this.net.status !== 'playing') return;
    this.ready = true;
    this.interactiveAtMs = performance.now();
    this.hudState.status = '';
    this.hudState.subStatus = '';
    this.events.onProgress?.(1, 'Ready');
    this.events.onReady?.();

    // Outfits, 65 KB, requested here and nowhere earlier: the page is now
    // interactive and the menu is up, and ref/BAR.md's 0.3 s vs 3.16 s
    // time-to-interactive advantage is the one thing this feature is not
    // allowed to spend. Until it lands, characters draw in flat palette colour
    // with the same silhouette and the same one draw call.
    void loadCharacterAtlas().catch(() => { /* flat colours are a fine fallback */ });
    // The demon rig, on the same trigger and for the same reason. Until it
    // lands, `ActorRenderer` keeps drawing monsters as boxes — the game that
    // shipped before — so nothing is missing from the arena at any point.
    void import('@/characters/enemyRenderer').then(({ EnemyRenderer }) => {
      if (this.disposed || this.demons !== null) return;
      // Sharing the world material's uniform OBJECTS, not their values: fog
      // range and colour reach the demons with no sync code, so an Imp at 70 m
      // sits in the same haze as the wall behind it rather than pasted on it.
      this.demons = new EnemyRenderer(this.renderer.scene, {
        worldUniforms: this.materials.uniforms,
        groundBelow: (x, y, z) => this.groundBelow(x, y, z),
      });
    }).catch(() => { /* boxes are a complete game */ });
  }

  /**
   * Change the local player's appearance mid-session. Six bytes on the wire,
   * and only when it actually changed — the avatar editor is a live preview and
   * calls this on every click.
   */
  setAvatar(packedAvatar: number, legacySkin: number): void {
    this.localAvatar = packedAvatar >>> 0;
    this.net.setAvatar(packedAvatar, legacySkin);
  }

  /* -------------------------------------------------------------------- *
   * Introspection — used by the capture harness and by the touch aim assist
   * -------------------------------------------------------------------- */

  /* -------------------------------------------------------------------- *
   * Death camera
   * -------------------------------------------------------------------- */

  /**
   * Pull back off your own corpse and drift around it.
   *
   * Three constraints decide the shape of this:
   *   - The boom must not go through a wall, or dying with your back to one
   *     puts the camera inside the rock and the card floats on grey. It is
   *     raycast against the same voxel world the weapons use and clamped short.
   *   - The body has to be THERE to look at. `characters.localBody` puts the
   *     local marine into the batch that already draws every remote player, so
   *     this whole feature adds zero draw calls.
   *   - Respawn has to be instant. Nothing here holds the input: `game.tick`
   *     still watches for fire/jump and calls `requestRespawn`.
   */
  private updateDeathCamera(dt: number, net: NetClient): void {
    if (!this.deathCam) {
      this.deathCam = true;
      this.deathTime = 0;
      this.deathAt[0] = net.renderPos[0];
      this.deathAt[1] = net.renderPos[1];
      this.deathAt[2] = net.renderPos[2];
      this.deathYaw = this.camera.yaw;
    }
    this.deathTime += dt;

    const t = this.deathTime;
    const bx = this.deathAt[0];
    const by = this.deathAt[1];
    const bz = this.deathAt[2];

    // The body: collapses over the same 0.45 s the boom takes to pull out, so
    // the fall and the reveal are one movement rather than two.
    this.characters.localBody = {
      x: bx, y: by, z: bz,
      yaw: this.deathYaw, pitch: 0,
      avatar: this.localAvatar,
      dead: clampf(t / DEATH_COLLAPSE, 0, 1),
    };

    // Ease out, so it drifts to a stop instead of arriving and sitting still.
    const ease = 1 - Math.exp(-t / DEATH_BOOM_TAU);
    const orbit = this.deathYaw + DEATH_ORBIT_RATE * t;
    const want = DEATH_BOOM * ease;
    const pivotY = by + DEATH_PIVOT_Y;

    // Backwards along the orbit yaw, and up. Engine forward is
    // (-sin yaw, ., -cos yaw), so "behind" is (+sin yaw, ., +cos yaw).
    const dx = Math.sin(orbit);
    const dz = Math.cos(orbit);
    const dy = DEATH_BOOM_RISE;
    const len = Math.hypot(dx, dy, dz);
    let reach = want;
    if (raycastVoxels(bx, pivotY, bz, dx / len, dy / len, dz / len,
      want + DEATH_WALL_PAD, this.sampleBlock, blockingSolid, this.hit)) {
      reach = Math.max(0.35, this.hit.distance - DEATH_WALL_PAD);
    }
    const cx = bx + (dx / len) * reach;
    const cy = pivotY + (dy / len) * reach;
    const cz = bz + (dz / len) * reach;

    // Look back down at the body.
    const lx = bx - cx, ly = (by + DEATH_LOOK_Y) - cy, lz = bz - cz;
    this.camera.setAngles(Math.atan2(-lx, -lz), Math.atan2(ly, Math.hypot(lx, lz)));
    this.camera.updateFree(dt, cx, cy, cz);
  }

  /**
   * What the character systems actually cost this frame. `draws` is the honest
   * headline: one call for every demon on screen plus one for every remote
   * player, never one per body.
   */
  characterStats(): { draws: number; instances: number; bodies: number; rigReady: boolean } {
    const d = this.demons;
    return {
      draws: (d?.drawCalls ?? 0) + this.characters.drawCalls,
      instances: d?.instanceCount ?? 0,
      bodies: d?.bodyCount ?? 0,
      rigReady: d?.ready ?? false,
    };
  }

  /**
   * World Y of the first solid surface below a point. Used once per dead
   * Cacodemon, so it can fall out of the sky instead of hanging there.
   */
  private groundBelow(x: number, y: number, z: number): number {
    const ok = raycastVoxels(
      x, y, z, 0, -1, 0, 48, this.sampleBlock, blockingSolid, this.hit,
    );
    return ok ? y - this.hit.distance : -Infinity;
  }

  /** Distance to the first solid voxel straight ahead, in metres. */
  viewClearance(): number {
    const f = this.camera.forward;
    const ok = raycastVoxels(
      this.driver.pos[0], this.driver.eyeY, this.driver.pos[2],
      f[0], f[1], f[2], 24, this.sampleBlock, blockingSolid, this.hit,
    );
    return ok ? this.hit.distance : 24;
  }

  /**
   * Angles from the current view to the nearest live enemy. Returns false when
   * there is nothing to shoot. The touch build uses this for its aim-assist
   * cone; the capture harness uses it to point the camera at the fight the way
   * a player would.
   */
  nearestEnemyAim(out: { yaw: number; pitch: number; dist: number }): boolean {
    const px = this.driver.pos[0];
    const py = this.driver.eyeY;
    const pz = this.driver.pos[2];
    let best = -1;
    let bestD = Infinity;
    let bx = 0, by = 0, bz = 0;

    for (let i = 0; i < this.net.entities.length; i++) {
      const e = this.net.entities[i];
      if (!e.active || e.type > EntityType.LOST_SOUL) continue;
      if ((e.state & ES_DEAD) !== 0) continue;
      const d = (e.x - px) ** 2 + (e.z - pz) ** 2;
      if (d < bestD) { bestD = d; best = i; bx = e.x; by = e.y + 1; bz = e.z; }
    }
    for (let i = 0; i < this.net.players.length; i++) {
      const p = this.net.players[i];
      if (!p.active || p.id === this.net.playerId || p.health <= 0) continue;
      const d = (p.x - px) ** 2 + (p.z - pz) ** 2;
      if (d < bestD) { bestD = d; best = 1000 + i; bx = p.x; by = p.y + 1.4; bz = p.z; }
    }
    if (best < 0) return false;

    const dx = bx - px, dy = by - py, dz = bz - pz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.asin(clampf(dy / len, -1, 1));
    let dyaw = yaw - this.camera.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    out.yaw = dyaw;
    out.pitch = pitch - this.camera.pitch;
    out.dist = len;
    return true;
  }

  /** Pixels of pointer travel per radian of turn, at the live sensitivity. */
  get pixelsPerRadian(): number {
    return 1 / (0.0022 * Math.max(0.1, this.camera.sensitivity));
  }

  /* -------------------------------------------------------------------- *
   * World adapter for the weapon runtime
   * -------------------------------------------------------------------- */

  /**
   * `WeaponRuntime` only needs a voxel raycast. `ClientWorld` is the single
   * store; this adapter presents it in the shape the runtime asks for, so no
   * second copy of the world exists on the client.
   */
  private readonly sampleBlock = (x: number, y: number, z: number): number =>
    this.net.world.getBlock(x, y, z);

  private readonly worldAdapter = {
    raycast: (
      ox: number, oy: number, oz: number,
      dx: number, dy: number, dz: number,
      maxDist: number, out: VoxelHit,
      blocking?: (id: number) => boolean,
    ): boolean => raycastVoxels(
      ox, oy, oz, dx, dy, dz, maxDist,
      this.sampleBlock, blocking ?? blockingSolid, out,
    ),
  };
}

/* ------------------------------------------------------------------------ *
 * Actor rendering
 * ------------------------------------------------------------------------ */

const ACTOR_CAPACITY = 640;

/**
 * Every body in the world — remote players, demons, pickups, projectiles —
 * drawn as boxes out of ONE instanced mesh, so the whole cast costs a single
 * draw call. Faces carry a baked shade in the vertex colour and the per-actor
 * tint arrives as the instance colour; the two multiply, which gives the same
 * stepped voxel lighting the terrain has without a second shader.
 */
class ActorRenderer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private count = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // Bake the face shade: +Y bright, sides stepped, -Y dark.
    const shade = [0.78, 0.78, 1.0, 0.5, 0.66, 0.66];
    const colors = new Float32Array(geo.attributes.position.count * 3);
    for (let face = 0; face < 6; face++) {
      const s = shade[face];
      for (let v = 0; v < 4; v++) {
        const i = (face * 4 + v) * 3;
        colors[i] = s; colors[i + 1] = s; colors[i + 2] = s;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, ACTOR_CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'actors';
    const instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ACTOR_CAPACITY * 3), 3);
    instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = instanceColor;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  /**
   * @param boxMonsters draw demons as the old box stack. False once
   *   `EnemyRenderer` has its rig, which is the normal case; true only while
   *   the 47 KB is in flight or if it failed to arrive.
   */
  update(net: NetClient, time: number, boxMonsters: boolean, markers: readonly GroundMarker[]): void {
    this.count = 0;

    for (let i = 0; i < net.players.length; i++) {
      const p = net.players[i];
      if (!p.active || p.id === net.playerId) continue;
      // A dead marine drops the gun. The body itself keeps being drawn by the
      // character rig, which folds it onto the floor.
      if (p.health <= 0) continue;
      this.drawMarine(p.x, p.y, p.z, p.yaw, p.pitch, time, p.skin);
    }

    for (let i = 0; i < net.entities.length; i++) {
      const e = net.entities[i];
      if (!e.active) continue;
      if (e.type >= EntityType.PICKUP_HEALTH) {
        this.drawPickup(e.x, e.y, e.z, e.type, time);
      } else if (boxMonsters && (e.state & ES_DEAD) === 0) {
        this.drawMonster(e.x, e.y, e.z, e.yaw, e.type, e.state, time);
      }
    }

    for (let i = 0; i < net.projectiles.length; i++) {
      const p = net.projectiles[i];
      if (!p.active) continue;
      this.drawProjectile(p.x, p.y, p.z, p.weapon, time);
    }

    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      this.drawMarker(m.x, m.y, m.z, m.color, m.card, time);
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  private box(
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    yaw: number, color: number,
  ): void {
    if (this.count >= ACTOR_CAPACITY) return;
    const i = this.count++;
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(this.up, yaw);
    this.scale.set(sx, sy, sz);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
    this.color.setHex(color);
    this.mesh.setColorAt(i, this.color);
  }

  /**
   * The weapon a marine is holding, and nothing else.
   *
   * The body used to be six coloured boxes drawn here. It is now the Kenney
   * character rig in `characters/thirdPerson.ts`, which draws every player in
   * one instanced call with their chosen outfit. What stays here is the gun:
   * it rides in this batch because this batch is already being drawn, so the
   * stub is free, and because it is the one part of a marine that is not
   * customisable.
   *
   * It sits in the right hand, which the rig holds forward at ARM_HOLD and
   * pitches with the owner's aim, so the two agree about where the muzzle is.
   */
  private drawMarine(
    x: number, y: number, z: number, yaw: number, pitch: number, _time: number, _skin: number,
  ): void {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const o = SCRATCH_OFFSET;
    offset(o, c, sn, 0.34, 0.46);
    this.box(x + o[0], y + 1.16 + pitch * 0.34, z + o[1], 0.11, 0.11, 0.52, yaw, 0x1c1a20);
  }

  private drawMonster(
    x: number, y: number, z: number, yaw: number, type: number, state: number, time: number,
  ): void {
    const look = MONSTER_LOOK[type];
    if (look === undefined) return;
    const windup = (state & ES_WINDUP) !== 0;
    // The telegraph is the thing that makes them dodgeable — make it visible.
    const flash = windup ? 0.5 + 0.5 * Math.sin(time * 34) : 0;
    const body = windup ? mixHex(look.body, 0xffe08a, flash * 0.75) : look.body;
    const bob = look.flying ? Math.sin(time * 2.4 + x) * 0.22 : 0;
    const gait = look.flying ? 0 : Math.sin(time * 8 + z) * 0.14;

    if (type === EntityType.CACODEMON) {
      this.box(x, y + 0.85 + bob, z, look.halfW * 2, look.height * 0.92, look.halfW * 2, yaw, body);
      this.box(x - Math.sin(yaw) * look.halfW, y + 0.95 + bob, z - Math.cos(yaw) * look.halfW,
        0.42, 0.42, 0.3, yaw, look.trim);
      this.box(x, y + 0.2 + bob, z, look.halfW * 1.2, 0.3, look.halfW * 1.2, yaw, mixHex(body, 0x000000, 0.35));
      return;
    }
    if (type === EntityType.LOST_SOUL) {
      this.box(x, y + 0.4 + bob, z, 0.5, 0.5, 0.5, yaw, body);
      this.box(x, y + 0.72 + bob, z, 0.34, 0.3, 0.34, yaw, look.trim);
      return;
    }

    const h = look.height;
    const w = look.halfW * 2;
    this.box(x, y + h * 0.62, z, w * 0.95, h * 0.44, w * 0.62, yaw, body);           // torso
    this.box(x, y + h * 0.9, z, w * 0.62, h * 0.2, w * 0.62, yaw, look.trim);        // head
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const armX = w * 0.62;
    this.box(x + armX * c, y + h * 0.6 + gait * 0.4, z - armX * sn, w * 0.26, h * 0.4, w * 0.26, yaw, body);
    this.box(x - armX * c, y + h * 0.6 - gait * 0.4, z + armX * sn, w * 0.26, h * 0.4, w * 0.26, yaw, body);
    const legX = w * 0.26;
    this.box(x + legX * c, y + h * 0.2 + gait, z - legX * sn, w * 0.3, h * 0.42, w * 0.3, yaw, mixHex(body, 0x000000, 0.4));
    this.box(x - legX * c, y + h * 0.2 - gait, z + legX * sn, w * 0.3, h * 0.42, w * 0.3, yaw, mixHex(body, 0x000000, 0.4));
  }

  private drawPickup(x: number, y: number, z: number, type: number, time: number): void {
    const color = PICKUP_COLOR[type] ?? 0xffffff;
    const spin = time * 1.7;
    const bob = Math.sin(time * 2.2 + x) * 0.12;
    this.box(x, y + 0.45 + bob, z, 0.42, 0.42, 0.42, spin, color);
    this.box(x, y + 0.45 + bob, z, 0.5, 0.14, 0.14, spin, 0xf4f2ee);
  }

  /**
   * A mode's ground marker — Quest's authored ammo boxes and keycards.
   * Same body language as `drawPickup` (spin + bob says "collectable"), a
   * different silhouette per family: supplies are a cube under a white bar,
   * a keycard is a flat spinning card, unmistakable from across a room.
   */
  private drawMarker(x: number, y: number, z: number, color: number, card: boolean, time: number): void {
    const spin = time * 1.7;
    const bob = Math.sin(time * 2.2 + x) * 0.12;
    if (card) {
      this.box(x, y + 0.55 + bob, z, 0.46, 0.3, 0.06, spin, color);
      this.box(x, y + 0.62 + bob, z, 0.2, 0.1, 0.075, spin, 0xf4f2ee);
      return;
    }
    this.box(x, y + 0.45 + bob, z, 0.42, 0.42, 0.42, spin, color);
    this.box(x, y + 0.45 + bob, z, 0.5, 0.14, 0.14, spin, 0xf4f2ee);
  }

  private drawProjectile(x: number, y: number, z: number, weapon: number, time: number): void {
    const def = getWeapon(weapon);
    const c = def.projectileColor;
    const s = weapon === WeaponId.BFG ? 0.9 : weapon === WeaponId.ROCKET ? 0.34 : 0.22;
    this.box(x, y, z, s, s, s, time * 6, c);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

const SCRATCH_OFFSET = new Float64Array(2);

/** Rotate a body-local (right, forward) offset into world x/z. */
function offset(out: Float64Array, cosYaw: number, sinYaw: number, right: number, fwd: number): void {
  out[0] = right * cosYaw - fwd * sinYaw;
  out[1] = -right * sinYaw - fwd * cosYaw;
}


/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function clampInt(v: number, lo: number, hi: number): number {
  const i = Math.round(v);
  return i < lo ? lo : i > hi ? hi : i;
}

function blockingSolid(id: number): boolean {
  return BLOCK_SOLID[id] === 1;
}

/** Break/place targets: solids and liquids stop the ray, air does not. */
function blockingForEdit(id: number): boolean {
  return BLOCK_SOLID[id] === 1 || BLOCK_LIQUID[id] === 1;
}

function boxOverlaps(
  px: number, py: number, pz: number, halfW: number, height: number,
  bx: number, by: number, bz: number,
): boolean {
  return px + halfW > bx && px - halfW < bx + 1
    && py + height > by && py < by + 1
    && pz + halfW > bz && pz - halfW < bz + 1;
}

/**
 * Mesher pool size. The brief calls for `hardwareConcurrency - 1` capped at 4;
 * each worker keeps its own voxel mirror (~11 MB for the whole arena), so a
 * phone is held to two of them rather than paying 44 MB for meshing that a
 * mobile render distance does not need.
 */
function meshWorkerCount(mobile: boolean): number {
  const cores = typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : 4;
  const want = Math.max(1, Math.min(4, cores - 1));
  return mobile ? Math.min(2, want) : want;
}

/** Every weapon; the local room grants the same set server-side. */
export const ALL_WEAPONS_MASK = (1 << WEAPON_COUNT) - 1;
