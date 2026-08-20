/**
 * DOOMCRAFT — HORDE: the wave director, client half.
 *
 * The authoritative wave director lives in `server/src/horde.ts`. This module
 * is the half the player actually experiences: the curve made *legible*.
 *
 * It imports the composition function straight from the server module — the
 * same trick `client/src/net/client.ts` uses to share `moveStep` with the
 * authoritative simulation, and for the same reason. `composeWave` is pure and
 * deterministic in `(wave, skill, players, seed)`, and the client knows all
 * four (the seed arrives in WELCOME, the skill and wave in the mode state), so
 * the fortify window can show you EXACTLY what is coming: how many, of what,
 * and from which gates. There is one table, on the server, and no way for the
 * forecast to drift from the thing that actually spawns.
 *
 * That forecast is not decoration. It is the input to the only decision Horde
 * asks you to make. "Wave 8: 21 demons, 2 Cacodemons, gates N and SE" is what
 * turns "spend on killing power or on walls" from a shrug into a plan — you
 * wall the two gates that are lit, and you do not bother roofing anything until
 * the flyers show up.
 *
 * What this module owns:
 *   - the roster's display identity (name, colour, glyph, danger order),
 *   - `GateBeacons`, in-world light columns standing on the hot gates during
 *     the fortify window, so the telegraph exists in the world and not only in
 *     the HUD,
 *   - `WaveCompass`, a DOM ribbon that keeps those gates on screen once you are
 *     looking the other way,
 *   - `PressureModel`, which turns "how bad is it right now" into one 0..1
 *     number for the vignette, the banner colour and the audio bed.
 *
 * Performance: nothing in `update()` allocates. Strings are rebuilt only when
 * their inputs change, the beacons are eight pre-built meshes whose transforms
 * are mutated in place, and the compass writes a transform at most every 50 ms.
 */

import * as THREE from 'three';

import { TAU, wrapAngle } from '@shared/math';
import {
  HORDE_ENEMIES,
  HORDE_ENEMY_COUNT,
  HORDE_GATE_COUNT,
  HORDE_GATE_NAMES,
  HORDE_GATE_RADIUS,
  composeWave,
  createWaveComposition,
  gateBearing,
  gateIsHot,
  gateOffsetX,
  gateOffsetZ,
  type WaveComposition,
} from '@doomcraft/server/src/horde.js';

import type { ModeScope } from '@/modes/registry';

/* ------------------------------------------------------------------------ *
 * Roster presentation
 * ------------------------------------------------------------------------ */

export interface HordeRosterUi {
  readonly key: string;
  readonly name: string;
  readonly plural: string;
  /** Packed 0xRRGGBB, matched to the body colour game.ts draws them with. */
  readonly colour: number;
  /** Single glyph for the compact wave strip. */
  readonly glyph: string;
  readonly flying: boolean;
  /** One line of "what this changes about the fight". */
  readonly threatLine: string;
}

function ui(d: HordeRosterUi): HordeRosterUi { return Object.freeze(d); }

/** Indexed the same way `HORDE_ENEMIES` is: by EntityType. */
export const HORDE_ROSTER_UI: readonly HordeRosterUi[] = Object.freeze([
  ui({
    key: 'imp', name: 'Imp', plural: 'Imps', colour: 0x9c3a1c, glyph: '▲', flying: false,
    threatLine: 'Rushes you. Cheap, fast, and it will chew a wall to get in.',
  }),
  ui({
    key: 'trooper', name: 'Trooper', plural: 'Troopers', colour: 0x8d9a54, glyph: '▮', flying: false,
    threatLine: 'Hitscan. Standing in the open stops being an option.',
  }),
  ui({
    key: 'cacodemon', name: 'Cacodemon', plural: 'Cacodemons', colour: 0xd03434, glyph: '◉', flying: true,
    threatLine: 'Flies. Your wall is not a roof.',
  }),
  ui({
    key: 'baron', name: 'Baron', plural: 'Barons', colour: 0xc0a184, glyph: '✚', flying: false,
    threatLine: 'Wall-breaker. Takes a metre of stone down in seconds.',
  }),
  ui({
    key: 'lost_soul', name: 'Lost Soul', plural: 'Lost Souls', colour: 0xf0e2c0, glyph: '✦', flying: true,
    threatLine: 'Flies and charges. Nothing you build slows it down.',
  }),
]);

export function rosterUi(type: number): HordeRosterUi {
  return type >= 0 && type < HORDE_ENEMY_COUNT ? HORDE_ROSTER_UI[type] : HORDE_ROSTER_UI[0];
}

/** Archetype indices present in a mask, heaviest first. Fills `out`, returns n. */
const DANGER_ORDER: readonly number[] = Object.freeze([3, 2, 4, 1, 0]);
export function archetypesInMask(mask: number, out: number[]): number {
  let n = 0;
  for (let i = 0; i < DANGER_ORDER.length; i++) {
    const type = DANGER_ORDER[i];
    if ((mask & (1 << type)) !== 0) out[n++] = type;
  }
  out.length = n;
  return n;
}

/* ------------------------------------------------------------------------ *
 * Forecast
 * ------------------------------------------------------------------------ */

/** Reusable composition for "what is coming next", owned by the caller. */
export function createForecast(): WaveComposition { return createWaveComposition(); }

/**
 * The exact wave the server will spawn. Same function, same seed, same answer —
 * the client is not guessing.
 */
export function forecastWave(
  wave: number, skill: number, players: number, seed: number, out: WaveComposition,
): WaveComposition {
  return composeWave(wave, skill, players, seed, out);
}

/** "21 demons · 2 Cacodemons · 1 Baron" */
export function describeComposition(c: WaveComposition): string {
  let out = `${c.total} demon${c.total === 1 ? '' : 's'}`;
  for (let i = 0; i < DANGER_ORDER.length; i++) {
    const type = DANGER_ORDER[i];
    const n = c.countOf(type);
    if (n <= 0) continue;
    if (HORDE_ENEMIES[type].tier < 2) continue;
    const r = rosterUi(type);
    out += ` · ${n} ${n === 1 ? r.name : r.plural}`;
  }
  return out;
}

/** The one line that says what is DIFFERENT about this wave. */
export function waveHeadline(next: WaveComposition, previous: WaveComposition | null): string {
  if (next.boss) return 'BOSS WAVE';
  if (previous !== null) {
    for (let i = 0; i < DANGER_ORDER.length; i++) {
      const type = DANGER_ORDER[i];
      if (next.countOf(type) > 0 && previous.countOf(type) === 0) {
        return `${rosterUi(type).plural.toUpperCase()} INCOMING`;
      }
    }
  }
  if (next.hasFlyers) return 'FLYERS IN THE MIX';
  return 'INCOMING';
}

/** Names of the lit gates, e.g. "N · SE". */
export function gateLabel(mask: number): string {
  let out = '';
  for (let g = 0; g < HORDE_GATE_COUNT; g++) {
    if (!gateIsHot(mask, g)) continue;
    out += out.length === 0 ? HORDE_GATE_NAMES[g] : ` · ${HORDE_GATE_NAMES[g]}`;
  }
  return out.length === 0 ? '—' : out;
}

/* ------------------------------------------------------------------------ *
 * In-world telegraph
 * ------------------------------------------------------------------------ */

/** Height of a gate beacon, metres. */
const BEACON_HEIGHT = 26;
const BEACON_WIDTH = 1.4;
const RING_SEGMENTS = 48;

/**
 * Eight light columns standing on the spawn ring, lit for the gates this wave
 * uses. During the fortify window they pulse; when the wave lands they fade to
 * a steady marker so you can still read where the pressure is coming from.
 *
 * Every mesh is created once at enter and registered on the mode's scope, so
 * the geometry and the material are disposed on exit whatever happens.
 */
export class GateBeacons {
  readonly group = new THREE.Group();
  private readonly pillars: THREE.Mesh[] = [];
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private readonly ring: THREE.Mesh;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private mask = 0;
  private boss = false;
  /** 0 = dormant, 1 = wave about to land. */
  private urgency = 0;
  private phaseT = 0;
  private holdY = 0;

  constructor(scene: THREE.Object3D, scope: ModeScope) {
    this.group.name = 'horde-gates';
    this.group.visible = false;
    this.group.matrixAutoUpdate = true;

    for (let g = 0; g < HORDE_GATE_COUNT; g++) {
      const geometry = new THREE.BoxGeometry(BEACON_WIDTH, 1, BEACON_WIDTH);
      const material = new THREE.MeshBasicMaterial({
        color: 0xf0a020,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.scale.y = BEACON_HEIGHT;
      mesh.position.set(
        gateOffsetX(g, HORDE_GATE_RADIUS),
        BEACON_HEIGHT * 0.5,
        gateOffsetZ(g, HORDE_GATE_RADIUS),
      );
      this.pillars.push(mesh);
      this.materials.push(material);
      this.group.add(mesh);
    }

    const ringGeometry = new THREE.RingGeometry(HORDE_GATE_RADIUS - 0.4, HORDE_GATE_RADIUS + 0.4, RING_SEGMENTS);
    ringGeometry.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xf0a020,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    this.ring = new THREE.Mesh(ringGeometry, this.ringMaterial);
    this.ring.frustumCulled = false;
    this.ring.position.y = 0.08;
    this.group.add(this.ring);

    scope.addObject3D(this.group, scene as THREE.Object3D);
  }

  /** Park the whole telegraph on the run's hold point. */
  setHold(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.holdY = y;
    this.group.visible = true;
  }

  /** Light the gates this wave will use. */
  setMask(mask: number, boss: boolean): void {
    if (this.mask === mask && this.boss === boss) return;
    this.mask = mask;
    this.boss = boss;
    const colour = boss ? 0xe03c1c : 0xf0a020;
    for (let g = 0; g < HORDE_GATE_COUNT; g++) {
      const hot = gateIsHot(mask, g);
      this.pillars[g].visible = hot;
      this.materials[g].color.setHex(colour);
    }
    this.ringMaterial.color.setHex(colour);
  }

  /** 1 while fortifying (pulse hard), 0 once the wave is on the ground. */
  setUrgency(v: number): void {
    this.urgency = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.phaseT += dt * (1.4 + this.urgency * 3.4);
    if (this.phaseT > TAU) this.phaseT -= TAU;
    const pulse = 0.5 + 0.5 * Math.sin(this.phaseT);
    const base = 0.10 + this.urgency * 0.22;
    const opacity = base + pulse * (0.06 + this.urgency * 0.20);
    for (let g = 0; g < HORDE_GATE_COUNT; g++) {
      if (!this.pillars[g].visible) continue;
      this.materials[g].opacity = opacity;
    }
    this.ringMaterial.opacity = 0.05 + this.urgency * 0.10 + pulse * 0.03;
    void this.holdY;
  }

  hide(): void {
    this.group.visible = false;
  }
}

/* ------------------------------------------------------------------------ *
 * HUD compass
 * ------------------------------------------------------------------------ */

/** Update the compass transform at most this often. */
const COMPASS_INTERVAL_MS = 50;

/**
 * A ribbon across the top of the screen with a tick per compass gate. The lit
 * ones glow, and the whole strip slides with the camera so "north-east" is
 * always where north-east actually is. Once you turn to face your walls you can
 * still see which side is about to be hit.
 */
export class WaveCompass {
  readonly element: HTMLElement;
  private readonly ticks: HTMLElement[] = [];
  private mask = 0;
  private sinceMs = 0;
  private lastDeg = 9999;
  private lit = false;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'dch-compass';
    for (let g = 0; g < HORDE_GATE_COUNT; g++) {
      const tick = document.createElement('div');
      tick.className = 'dch-tick';
      tick.textContent = HORDE_GATE_NAMES[g];
      this.element.appendChild(tick);
      this.ticks.push(tick);
    }
  }

  setMask(mask: number): void {
    if (this.mask === mask) return;
    this.mask = mask;
    for (let g = 0; g < HORDE_GATE_COUNT; g++) {
      this.ticks[g].classList.toggle('hot', gateIsHot(mask, g));
    }
  }

  setLit(on: boolean): void {
    if (this.lit === on) return;
    this.lit = on;
    this.element.classList.toggle('armed', on);
  }

  /**
   * `camYaw` uses the project's convention: 0 looks down -Z, which is gate 0.
   * Each tick sits at its own bearing relative to where the camera is pointing,
   * with +-180 degrees spread across the full strip.
   */
  update(dtMs: number, camYaw: number): void {
    this.sinceMs += dtMs;
    if (this.sinceMs < COMPASS_INTERVAL_MS) return;
    this.sinceMs = 0;
    const deg = Math.round((camYaw * 180) / Math.PI);
    if (deg === this.lastDeg) return;
    this.lastDeg = deg;
    for (let g = 0; g < HORDE_GATE_COUNT; g++) {
      const rel = wrapAngle(gateBearing(g) - camYaw);
      const pct = 50 + (rel / Math.PI) * 50;
      const tick = this.ticks[g];
      tick.style.left = `${pct.toFixed(1)}%`;
      // Fade the ones behind you rather than hiding them: a gate at your back
      // is the one you most need to know about.
      const facing = 1 - Math.abs(rel) / Math.PI;
      tick.style.opacity = (0.28 + facing * 0.72).toFixed(2);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Pressure
 * ------------------------------------------------------------------------ */

export const PRESSURE_STAGES: readonly string[] = Object.freeze([
  'CLEAR', 'BUILDING', 'HEAVY', 'CRITICAL',
]);

/**
 * One number for "how bad is it". Built from four things that all move for
 * different reasons, so late waves feel different rather than merely longer:
 * how much of the wave is still standing, how close the nearest demon is to the
 * hold, whether anything is currently eating your wall, and the wave's own
 * weighted threat relative to the first one.
 */
export class PressureModel {
  /** 0..1, smoothed. */
  value = 0;
  /** Index into PRESSURE_STAGES. */
  stage = 0;
  /** True while something is chewing on a fortification. */
  underSiege = false;

  private target = 0;
  private remaining = 0;
  private total = 1;
  private threatScale = 1;
  private nearest = 999;
  private siegeMs = 0;

  reset(): void {
    this.value = 0;
    this.target = 0;
    this.stage = 0;
    this.remaining = 0;
    this.total = 1;
    this.threatScale = 1;
    this.nearest = 999;
    this.siegeMs = 0;
    this.underSiege = false;
  }

  /** Wave facts from the authoritative state sidecar. */
  setWave(killed: number, total: number, threat: number, baseThreat: number): void {
    this.total = total > 0 ? total : 1;
    this.remaining = Math.max(0, this.total - killed);
    this.threatScale = baseThreat > 0 ? Math.min(3, threat / baseThreat) : 1;
  }

  /** Metres from the hold to the closest live demon. */
  setNearest(distance: number): void {
    this.nearest = distance;
  }

  /** Called when a BREACH or SIEGE event lands. */
  pingSiege(): void {
    this.siegeMs = 2600;
  }

  update(dtMs: number): void {
    if (this.siegeMs > 0) this.siegeMs -= dtMs;
    this.underSiege = this.siegeMs > 0;

    const alive = this.remaining / this.total;
    const proximity = this.nearest >= 60 ? 0 : 1 - this.nearest / 60;
    let t = alive * 0.45 + proximity * 0.35;
    t *= 0.6 + this.threatScale * 0.4;
    if (this.underSiege) t += 0.25;
    this.target = t < 0 ? 0 : t > 1 ? 1 : t;

    // Rises fast, falls slow: relief should be earned.
    const rate = this.target > this.value ? 3.2 : 0.9;
    const k = Math.min(1, (dtMs / 1000) * rate);
    this.value += (this.target - this.value) * k;

    this.stage = this.value > 0.78 ? 3 : this.value > 0.46 ? 2 : this.value > 0.12 ? 1 : 0;
  }

  get stageName(): string { return PRESSURE_STAGES[this.stage]; }
}

/* ------------------------------------------------------------------------ *
 * The view that ties them together
 * ------------------------------------------------------------------------ */

export interface WaveDirectorViewOptions {
  scene: THREE.Object3D;
  scope: ModeScope;
  /** Where the compass ribbon mounts. */
  hudRoot: HTMLElement;
}

/**
 * Everything the mode needs to render the wave, behind one small surface. The
 * mode owns the banner text; this owns the world telegraph, the compass and the
 * pressure curve.
 */
export class WaveDirectorView {
  readonly beacons: GateBeacons;
  readonly compass: WaveCompass;
  readonly pressure = new PressureModel();
  /** The wave the server is running, or the one it is about to run. */
  readonly current: WaveComposition = createWaveComposition();
  /** The wave after that — what the fortify window is spending against. */
  readonly next: WaveComposition = createWaveComposition();

  private seed = 0;
  private skill = 2;
  private players = 1;
  private currentWave = -1;
  private nextWave = -1;
  private baseThreat = 1;

  constructor(options: WaveDirectorViewOptions) {
    this.beacons = new GateBeacons(options.scene, options.scope);
    this.compass = new WaveCompass();
    options.hudRoot.appendChild(this.compass.element);
    options.scope.addElement(this.compass.element);
    composeWave(1, 2, 1, 0, this.current);
    this.baseThreat = Math.max(1, this.current.threat);
  }

  /** The three inputs the forecast needs, from WELCOME and the mode state. */
  configure(seed: number, skill: number, players: number): void {
    if (this.seed === seed && this.skill === skill && this.players === players) return;
    this.seed = seed;
    this.skill = skill;
    this.players = Math.max(1, players);
    this.currentWave = -1;
    this.nextWave = -1;
    composeWave(1, this.skill, this.players, this.seed, this.current);
    this.baseThreat = Math.max(1, this.current.threat);
  }

  /** Recompute the two compositions when the wave number moves. */
  setWave(wave: number): void {
    if (wave !== this.currentWave) {
      this.currentWave = wave;
      composeWave(Math.max(1, wave), this.skill, this.players, this.seed, this.current);
    }
    const upcoming = Math.max(1, wave + 1);
    if (upcoming !== this.nextWave) {
      this.nextWave = upcoming;
      composeWave(upcoming, this.skill, this.players, this.seed, this.next);
    }
  }

  setHold(x: number, y: number, z: number): void {
    this.beacons.setHold(x, y, z);
  }

  /**
   * `building` is true during the fortify window, when the beacons should show
   * the wave that is COMING; false in combat, when they show the wave that is
   * already here.
   */
  setPhase(building: boolean, urgency: number): void {
    const c = building ? this.next : this.current;
    this.beacons.setMask(c.gateMask, c.boss);
    this.beacons.setUrgency(building ? urgency : 0.1);
    this.compass.setMask(c.gateMask);
    this.compass.setLit(building);
  }

  /** Trust the server's own masks over the forecast when they disagree. */
  applyAuthoritativeGates(gateMask: number, boss: boolean): void {
    this.beacons.setMask(gateMask, boss);
    this.compass.setMask(gateMask);
  }

  update(dtMs: number, camYaw: number): void {
    const dt = dtMs / 1000;
    this.beacons.update(dt);
    this.compass.update(dtMs, camYaw);
    this.pressure.update(dtMs);
  }

  /** Threat of wave 1 at this skill and player count — the pressure baseline. */
  get pressureBaseline(): number { return this.baseThreat; }
}
