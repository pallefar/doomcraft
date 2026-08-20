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
  type GameSettings,
} from '@shared/constants';
import {
  BlockId, BLOCK_SOLID, BLOCK_LIQUID, minimapColor, PLACEABLE_BLOCKS,
} from '@shared/blocks';
import {
  WeaponId, WEAPON_COUNT, getWeapon, ammoTypeOf, weaponFromSlot,
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

import {
  WeaponRuntime, createFireContext, createHitTargets, SWITCH_NONE,
  pushPlayerTarget, pushEntityTarget,
  type FireContext, type HitTargets, type WeaponFx,
} from '@/game/weapons';

import { NetClient, type NetStatus } from '@/net/client';
import { createLocalServer, type LocalServer } from '@/net/localServer';

import {
  Hud, createHudState, BLIP_ENEMY, BLIP_PLAYER, BLIP_PICKUP, MAX_BLIPS, MAX_BOARD_ROWS,
  type HudState,
} from '@/hud/hud';

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
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hudRoot: HTMLElement;
  settings: GameSettings;
  name?: string;
  seed?: number;
  mode?: number;
  bots?: number;
  enemies?: number;
  /** Force the touch HUD on. Auto-detected otherwise. */
  touch?: boolean;
  events?: GameEvents;
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
  readonly viewmodel: Viewmodel;
  readonly camera: PlayerCamera;
  readonly input: InputManager;
  readonly weapons: WeaponRuntime;
  readonly hud: Hud;
  readonly net: NetClient;
  readonly server: LocalServer;

  readonly hudState: HudState = createHudState();
  readonly events: GameEvents;

  /** True once the world is drawable and the local player exists. */
  ready = false;
  /** True while the player is driving. False in the menu / pause / boot. */
  playing = false;
  /** Wall-clock ms at which the game became interactive. */
  interactiveAtMs = 0;

  private settings: GameSettings;
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

  /* loop */
  private accumulator = 0;
  private lastFrameMs = 0;
  private timeSeconds = 0;
  private wasOnGround = true;
  private lastEditMs = -1e9;
  private buildMode = false;
  private buildBlockIndex = 0;
  private renderDistance: number;
  private matchSeconds = 0;
  private hurtFlash = 0;
  private lastSlotSent = 0;
  private slotMismatchMs = 0;
  private wasDead = false;
  private disposed = false;

  /* streaming */
  private meshedSpawn = false;
  private readonly dirtyMinimap: number[] = [];

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
    });
    this.hud.setTouchVisible(false);
    this.hud.setVisible(false);
    this.hudState.showFps = this.settings.fpsCounter;

    /* ---- weapons ----------------------------------------------------- */
    this.weapons = new WeaponRuntime(this.buildWeaponFx(), this.camera, undefined);
    this.weapons.resetLoadout(ALL_WEAPONS_MASK);   // the local room grants the same set

    /* ---- actors ------------------------------------------------------ */
    this.actors = new ActorRenderer(this.renderer.scene);

    /* ---- net --------------------------------------------------------- */
    this.server = createLocalServer({
      seed: opts.seed,
      mode: opts.mode ?? GameMode.DEATHMATCH,
      botFill: opts.bots,
      enemies: opts.enemies ?? -1,
      allWeapons: true,
      onError: (m) => { this.events.onStatus?.('error', m); },
    });

    this.net = new NetClient({
      name: opts.name ?? 'Marine',
      transport: this.server.transport,
      autoReconnect: false,
      events: {
        onStatus: (s, d) => this.events.onStatus?.(s, d),
        onChunk: (cx, cz, voxels, received, total) => this.onChunk(cx, cz, voxels, received, total),
        onBlocks: (n, x, y, z, id) => this.onBlocks(n, x, y, z, id),
        onDamage: (e) => this.onDamage(e),
        onKill: (e) => this.onKill(e),
        onChat: (m) => this.onChat(m),
      },
    });
  }

  /* -------------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------------- */

  connect(): void {
    this.net.connect();
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
    this.net.dispose();
    this.server.stop();
    this.input.detach();
    this.hud.dispose();
    this.actors.dispose();
    this.chunks.dispose();
    this.fx.dispose();
    this.viewmodel.dispose();
    this.sky.dispose();
    this.materials.dispose();
    this.renderer.dispose();
  }

  /* -------------------------------------------------------------------- *
   * Settings
   * -------------------------------------------------------------------- */

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

    this.renderer.setRenderScale(s.renderScale);
    this.materials.setQuality(s.quality);
    this.materials.setAoEnabled(s.ao);
    this.materials.setFogEnabled(s.fog);
    this.viewmodel.setBobEnabled(s.viewBob);

    const rd = clampInt(s.renderDistance, 2, 8);
    if (rd !== this.renderDistance) {
      this.renderDistance = rd;
      this.chunks.setRenderDistance(rd);
      this.materials.setFogFromRenderDistance(rd);
    }

    this.hud.setCrosshair(s.crosshair, s.crosshairColor);
    this.hudState.showFps = s.fpsCounter;
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

  private onBlocks(count: number, xs: Int16Array, ys: Uint8Array, zs: Int16Array, ids: Uint8Array): void {
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
  }

  /** After a context loss the workers keep their mirror; the meshes do not. */
  private resyncWorld(): void {
    for (const [key, voxels] of this.net.world.chunks) {
      this.chunks.setChunk(chunkKeyCX(key), chunkKeyCZ(key), voxels);
    }
  }

  private onDamage(e: DamageEvent): void {
    const me = this.net.playerId;
    if (e.victimId === me) {
      // dir points attacker -> victim, so the arrow points back along it.
      const yaw = Math.atan2(e.dirX, e.dirZ);
      this.hud.hurt(e.amount, yaw, this.camera.viewYaw);
      // uTint MULTIPLIES the albedo, so the rest value is (1,1,1) and a hurt
      // flash pushes red up and the other channels down. Setting it toward
      // zero paints the entire world black — which is exactly what a naive
      // "clear the tint" does, and it is not recoverable without a reset.
      this.hurtFlash = Math.min(1, this.hurtFlash + 0.35 + e.amount / 120);
    } else if (e.attackerId === me) {
      this.hud.hitMarker((e.flags & DMG_HEADSHOT) !== 0, (e.flags & DMG_FATAL) !== 0);
    }
  }

  private onKill(e: KillEvent): void {
    const killer = this.nameOf(e.killerId);
    const victim = e.victimId === 0 ? 'a demon' : this.nameOf(e.victimId);
    const weapon = getWeapon(e.weaponId).name;
    this.hud.pushFeed(`${killer}  ›${weapon}›  ${victim}`, 'k');
    if (e.victimId === this.net.playerId) {
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
      },
      muzzleFlash: (weaponId, x, y, z, dx, dy, dz): void => {
        // Spawn the plume at the muzzle, not at the eye: at the eye it sits
        // inside the 6 cm near plane and the player sees nothing at all.
        const d = MUZZLE_STANDOFF;
        this.fx.muzzleFlash(x + dx * d, y + dy * d, z + dz * d, dx, dy, dz, weaponId);
      },
      tracer: (_weaponId, x0, y0, z0, x1, y1, z1, color): void => {
        // Start the streak at the barrel. Fired from the eye it begins behind
        // the near plane, and a screen-space minimum width then paints a
        // 30-pixel searchlight across the frame instead of a tracer.
        let dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const len = Math.hypot(dx, dy, dz);
        if (len > MUZZLE_STANDOFF * 2) {
          dx /= len; dy /= len; dz /= len;
          const d = MUZZLE_STANDOFF;
          this.fx.tracer(x0 + dx * d, y0 + dy * d, z0 + dz * d, x1, y1, z1, color);
        } else {
          this.fx.tracer(x0, y0, z0, x1, y1, z1, color);
        }
      },
      impact: (x, y, z, nx, ny, nz, blockId): void => {
        this.fx.impact(x, y, z, nx, ny, nz, minimapColor(blockId), 1);
      },
      fleshImpact: (x, y, z, nx, ny, nz, _targetId, headshot): void => {
        this.fx.blood(x, y, z, -nx, -ny, -nz, headshot ? 1.6 : 1);
      },
      hitMarker: (_damage, headshot, killed): void => {
        if (this.settings.hitMarkers) this.hud.hitMarker(headshot, killed);
      },
      dryFire: (): void => { /* the click is audio-only; no visual */ },
      reloadStart: (weaponId, ms): void => { this.viewmodel.reload(ms); void weaponId; },
      switchStart: (_from, to): void => { this.viewmodel.setWeapon(to); },
    };
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
    input.update();

    const playing = this.playing && !this.net.local.dead;

    /* --- look --------------------------------------------------------- */
    if (this.playing) {
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

  /** Break / place, rate limited, predicted through the net client. */
  private stepEdits(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    const nowMs = this.timeSeconds * 1000;
    if (nowMs - this.lastEditMs < EDIT_INTERVAL_MS) return;
    const wantBreak = this.buildMode && this.input.isDown(InputAction.Fire);
    const wantPlace = this.input.isDown(InputAction.AltFire);
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
      if (this.net.requestEdit(BlockAction.BREAK, this.hit.x, this.hit.y, this.hit.z, 0)) {
        this.chunks.setBlock(this.hit.x, this.hit.y, this.hit.z, BlockId.AIR);
        this.fx.blockBreak(this.hit.x, this.hit.y, this.hit.z, id);
        this.camera.addShake(0.02, 60, 22);
        this.viewmodel.fire();
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

    if (this.ready) {
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
      this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3.4);
      const f = this.hurtFlash;
      this.materials.setTint(1 + f * 0.55, 1 - f * 0.66, 1 - f * 0.72);
      this.viewmodel.setTint(1 + f * 0.45, 1 - f * 0.5, 1 - f * 0.55);
      if (this.hurtFlash === 0) {
        this.materials.setTint(1, 1, 1);
        this.viewmodel.setTint(1, 1, 1);
      }
    }

    /* --- fx ------------------------------------------------------------- */
    this.fx.setViewportHeight(gr.drawHeight);
    this.fx.update(dt, gr.camera);
    this.materials.setTime(this.timeSeconds);

    /* --- world + actors -------------------------------------------------- */
    this.chunks.update(gr.camera);
    this.actors.update(net, this.timeSeconds);

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
    s.owned = w.owned;
    s.spread = w.spreadFraction;
    s.reloading = w.reloading;
    const def = getWeapon(w.current);
    s.reloadFrac = w.reloading && def.reloadMs > 0
      ? 1 - w.reloadRemainingMs / (def.reloadShellMs > 0 ? def.reloadShellMs : def.reloadMs)
      : 0;
    s.kills = net.local.kills;
    s.deaths = net.local.deaths;
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
      pushPlayerTarget(t, p.id, p.x, p.y, p.z, p.health > 0, p.team);
    }
    for (let i = 0; i < net.entities.length; i++) {
      const e = net.entities[i];
      if (!e.active || e.type > EntityType.LOST_SOUL) continue;
      if ((e.state & ES_DEAD) !== 0) continue;
      const look = MONSTER_LOOK[e.type];
      if (look === undefined) continue;
      pushEntityTarget(
        t, e.id, e.x, e.y, e.z, look.halfW, look.height,
        look.height * 0.78, look.halfW * 0.7, true, 254,
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
  }

  /* -------------------------------------------------------------------- *
   * Introspection — used by the capture harness and by the touch aim assist
   * -------------------------------------------------------------------- */

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

  update(net: NetClient, time: number): void {
    this.count = 0;

    for (let i = 0; i < net.players.length; i++) {
      const p = net.players[i];
      if (!p.active || p.id === net.playerId) continue;
      if (p.health <= 0) continue;
      this.drawMarine(p.x, p.y, p.z, p.yaw, p.pitch, time, p.skin);
    }

    for (let i = 0; i < net.entities.length; i++) {
      const e = net.entities[i];
      if (!e.active) continue;
      if (e.type >= EntityType.PICKUP_HEALTH) {
        this.drawPickup(e.x, e.y, e.z, e.type, time);
      } else if ((e.state & ES_DEAD) === 0) {
        this.drawMonster(e.x, e.y, e.z, e.yaw, e.type, e.state, time);
      }
    }

    for (let i = 0; i < net.projectiles.length; i++) {
      const p = net.projectiles[i];
      if (!p.active) continue;
      this.drawProjectile(p.x, p.y, p.z, p.weapon, time);
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

  /** A blocky marine: six boxes, legs swinging with the ground speed. */
  private drawMarine(
    x: number, y: number, z: number, yaw: number, pitch: number, time: number, skin: number,
  ): void {
    const body = MARINE_SKINS[skin % MARINE_SKINS.length];
    const trim = MARINE_TRIM[skin % MARINE_TRIM.length];
    const s = Math.sin(time * 7 + x) * 0.16;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    // Body-local (right, forward) -> world. Matches yawToRight / anglesToForward.
    const o = SCRATCH_OFFSET;

    this.box(x, y + 1.32, z, 0.52, 0.62, 0.34, yaw, body);              // torso
    this.box(x, y + 1.76, z, 0.36, 0.34, 0.36, yaw, trim);              // head
    offset(o, c, sn, 0.36, 0);
    this.box(x + o[0], y + 1.3 - s * 0.4, z + o[1], 0.18, 0.56, 0.2, yaw, body);
    offset(o, c, sn, -0.36, 0);
    this.box(x + o[0], y + 1.3 + s * 0.4, z + o[1], 0.18, 0.56, 0.2, yaw, body);
    offset(o, c, sn, 0.15, 0);
    this.box(x + o[0], y + 0.5 + s * 0.1, z + o[1], 0.2, 1.0, 0.22 + s * 0.1, yaw, 0x35323a);
    offset(o, c, sn, -0.15, 0);
    this.box(x + o[0], y + 0.5 - s * 0.1, z + o[1], 0.2, 1.0, 0.22 - s * 0.1, yaw, 0x35323a);
    // Muzzle stub, so you can read where a marine is aiming.
    offset(o, c, sn, 0.3, 0.42);
    this.box(x + o[0], y + 1.34 - pitch * 0.3, z + o[1], 0.12, 0.12, 0.5, yaw, 0x1c1a20);
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

const MARINE_SKINS = [0x3f6f42, 0x6a4b8f, 0x8f5a2a, 0x2f5f8f, 0x8f2f3f, 0x59606b];
const MARINE_TRIM = [0xd8c8a8, 0xc8a8d8, 0xe0c090, 0xa8c8e0, 0xe0a0a8, 0xc8cdd4];

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
