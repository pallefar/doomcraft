/**
 * DOOMCRAFT — the room, as sound.
 *
 * WHAT DRIVES IT: THE PALETTE THAT IS ALREADY THERE
 *
 * `shared/src/level.ts` has carried `skyTop`, `skyHorizon`, `fogColor`,
 * `fogNear`, `fogFar` and `ambient` since the level format was written, and the
 * six shipped levels use the full range of them:
 *
 *   level            skyTop     ambient  fogFar   reading
 *   e1m1-hangar      #120e18    0.30     74       cold, industrial, roomy
 *   e1m2-coolant     #0d1017    0.32     82       cold, blue, the most open
 *   e1m3-warrens     #100c10    0.26     66       neutral, close
 *   e1m4-blackout    #050508    0.12     30       nearly black, nearly blind
 *   e1m5-furnace     #2a0d06    0.30     78       HOT, red
 *   e1m6-throne      #360a06    0.22     62       hottest, and dark with it
 *
 * That is a complete atmosphere specification and nothing was reading it. Three
 * numbers come straight out of it and drive the whole bed:
 *
 *   HEAT   = how far the sky's hue leans to red. e1m6 is 0.95, e1m2 is 0.0.
 *            Heat buys lava rumble and furnace roar and spends wind.
 *   DARK   = 1 - ambient, normalised. e1m4 is nearly 1. Dark lowers the whole
 *            bed and narrows it, because a room you cannot see across should
 *            sound like a room that is holding its breath — and because a quiet
 *            bed is what leaves headroom for the thing that is about to
 *            growl at you out of it.
 *   ROOM   = fogFar. 30 m is a corridor, 82 m is a hall. It sets the room
 *            tone's centre frequency and its resonance: small rooms ring
 *            higher and tighter.
 *
 * The other two inputs are the world itself — how much lava is near, and how
 * much sky is overhead — sampled on a 5 Hz timer, never per frame.
 *
 * SEAMS
 *
 * A looping noise bed that clicks once every eight seconds is worse than
 * silence, because the ear locks onto it and never lets go. Crossfading the
 * tail over the head is the usual dodge and it audibly ducks. Every loop here
 * is built by `bakeLoop`, which sums sinusoids at exact integer multiples of
 * 1/length: the waveform and all its derivatives match across the wrap by
 * construction, so there is no seam to hide. `audio.test.ts` measures the wrap
 * discontinuity against the largest step inside the buffer and holds it under
 * one part in twenty.
 *
 * COST
 *
 * Four looping `AudioBufferSourceNode`s and four gains, created once and never
 * again. Nothing is scheduled per frame; `update()` writes a gain only when a
 * target has actually moved, which for a stationary player is never. The bake
 * is about 25 ms of one-off arithmetic for all four layers, at 11 kHz, off the
 * first frame.
 */

import { BlockId } from '@shared/blocks';
import { ModeId } from '@shared/modes';

import { BAKE_RATE, bakeLoop, bandSpectrum, resampleTo } from './dsp';

/* ------------------------------------------------------------------------ *
 * What a sustained source needs of the engine
 *
 * `engine.play()` is a one-shot allocator over a pooled voice chain sized for
 * gunfire. A bed that loops for a whole level is not a one-shot and must not be
 * competing for those slots, so it owns four nodes of its own and hangs them on
 * the ambience bus — which means it still rides the bus volume, the master and
 * the limiter, and still goes away when the tab is hidden.
 * ------------------------------------------------------------------------ */

/** `BUS_AMBIENCE` in engine.ts, mirrored rather than imported. */
const BUS_AMBIENCE = 3;

export interface SustainTarget {
  /** False until a user gesture has built and resumed the context. */
  readonly ready: boolean;
  readonly ctx: AudioContext | null;
  readonly sampleRate: number;
  /** The gain node for a bus, or null before the graph exists. */
  busNode(bus: number): AudioNode | null;
}

/* ------------------------------------------------------------------------ *
 * The atmosphere, as three numbers
 * ------------------------------------------------------------------------ */

/** Exactly the fields `LevelMeta` and `ModeContextMessage` already carry. */
export interface LevelPalette {
  /** Packed 0xRRGGBB. */
  skyTop: number;
  /** Packed 0xRRGGBB. */
  fogColor: number;
  /** 0..1. */
  ambient: number;
  /** Metres; fog is total at this range. */
  fogFar: number;
}

export interface Atmosphere {
  /** 0..1 — how far the palette leans to fire. */
  heat: number;
  /** 0..1 — how black the level is. */
  dark: number;
  /** 0..1 — how big the space reads, from fogFar. */
  room: number;
}

/** Fog ranges seen across the shipped levels, used to normalise `room`. */
const FOG_TIGHT = 28;
const FOG_OPEN = 90;

/**
 * Reduce a palette to the three numbers the bed actually uses.
 *
 * `heat` is deliberately not "how red is it" — e1m4's near-black #050508 is
 * 0.5% redder than it is blue and would read as slightly warm on a naive
 * red-minus-blue. It is chroma-weighted, so a colour with almost no saturation
 * contributes almost no heat however its channels happen to sit.
 */
export function atmosphereOf(p: LevelPalette): Atmosphere {
  const r = ((p.skyTop >> 16) & 0xff) / 255;
  const g = ((p.skyTop >> 8) & 0xff) / 255;
  const b = (p.skyTop & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  // Positive when red leads blue, scaled by how saturated the colour is at all.
  const lean = max > 1e-6 ? (r - b) / max : 0;
  const heat = clamp01(lean * (chroma > 0.02 ? 1 : chroma / 0.02) * 1.6);
  const dark = clamp01(1 - p.ambient / 0.45);
  const room = clamp01((p.fogFar - FOG_TIGHT) / (FOG_OPEN - FOG_TIGHT));
  return { heat, dark, room };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Sub-millisecond clock where there is one; `Date.now` rounds a 0.4 ms bake to 0. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ------------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------------ */

export const LAYER_ROOM = 0;
export const LAYER_MACHINE = 1;
export const LAYER_LAVA = 2;
export const LAYER_WIND = 3;
export const LAYER_COUNT = 4;

export const LAYER_NAMES: readonly string[] = Object.freeze(['room', 'machine', 'lava', 'wind']);

/** Seconds of loop per layer. Prime-ish lengths so two layers never re-align. */
const LAYER_SECONDS: readonly number[] = Object.freeze([6.1, 7.3, 4.7, 5.3]);

/**
 * Level a layer sits at when fully on. These are the mix, and they are set so
 * the WHOLE bed at maximum is quieter than one monster growl: ambience that
 * competes with a cue is ambience that has broken the game it decorates.
 */
const LAYER_MAX: readonly number[] = Object.freeze([0.30, 0.22, 0.34, 0.26]);

/** Seconds a layer takes to reach a new target. Slow: nothing here should pop. */
const LAYER_GLIDE = 1.6;

/* ------------------------------------------------------------------------ *
 * World sampling
 * ------------------------------------------------------------------------ */

/** All this module needs of the voxel world. `ClientWorld` satisfies it. */
export interface AmbienceWorld {
  getBlock(x: number, y: number, z: number): number;
}

/** How often the world is sampled, seconds. Never per frame. */
export const SAMPLE_PERIOD = 0.2;

/** Rings, in metres, that the lava probe walks. */
const PROBE_RINGS: readonly number[] = Object.freeze([2, 6, 12, 20]);
/** Weight per ring — near lava is loud, far lava is a rumble. */
const RING_WEIGHT: readonly number[] = Object.freeze([1.0, 0.62, 0.3, 0.12]);
const PROBE_DIRS = 8;
/** Vertical offsets probed at each ring, metres from the eye. */
const PROBE_DY: readonly number[] = Object.freeze([-3, -1, 1]);

/**
 * Lava exposure (0..1) and sky openness (0..1) around a point.
 *
 * 96 `getBlock` calls, five times a second: 480 array reads per second against
 * a frame budget measured in draw calls. `ClientWorld.getBlock` caches the last
 * chunk it touched, and this walks rings so consecutive probes usually land in
 * the same chunk.
 */
export function probeWorld(world: AmbienceWorld, x: number, y: number, z: number): { lava: number; open: number } {
  let lava = 0;
  let lavaMax = 0;
  for (let r = 0; r < PROBE_RINGS.length; r++) {
    const rad = PROBE_RINGS[r];
    const w = RING_WEIGHT[r];
    for (let d = 0; d < PROBE_DIRS; d++) {
      const a = (d / PROBE_DIRS) * Math.PI * 2;
      const px = Math.round(x + Math.cos(a) * rad);
      const pz = Math.round(z + Math.sin(a) * rad);
      for (let k = 0; k < PROBE_DY.length; k++) {
        const py = Math.round(y + PROBE_DY[k]);
        lavaMax += w;
        if (world.getBlock(px, py, pz) === BlockId.LAVA) lava += w;
      }
    }
  }

  // Openness: is there sky straight up, and up-and-out at the middle ring?
  let open = 0;
  let openMax = 0;
  for (let d = 0; d < PROBE_DIRS; d++) {
    const a = (d / PROBE_DIRS) * Math.PI * 2;
    const px = Math.round(x + Math.cos(a) * 6);
    const pz = Math.round(z + Math.sin(a) * 6);
    openMax++;
    let blocked = false;
    for (let h = 3; h <= 21; h += 6) {
      if (world.getBlock(px, Math.round(y) + h, pz) !== BlockId.AIR) { blocked = true; break; }
    }
    if (!blocked) open++;
  }

  return {
    // The square root makes a little lava audible rather than needing a lake.
    lava: lavaMax > 0 ? Math.sqrt(clamp01(lava / lavaMax) * 3.2) : 0,
    open: openMax > 0 ? open / openMax : 0,
  };
}

/* ------------------------------------------------------------------------ *
 * The bed
 * ------------------------------------------------------------------------ */

export interface AmbienceOptions {
  /** Seed for the loop bakes. Only tests need this. */
  seed?: number;
  /** Skip the bake and run headless. The mix is still computed and readable. */
  silent?: boolean;
}

interface LayerNode {
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
  /** Where the gain is now, and where it is heading. */
  level: number;
  target: number;
}

export class Ambience {
  private readonly engine: SustainTarget;
  private readonly opts: AmbienceOptions;
  private readonly layers: LayerNode[] = [];

  private atmos: Atmosphere = { heat: 0, dark: 0, room: 0.5 };
  private mode: ModeId = ModeId.DEATHMATCH;
  private lava = 0;
  private open = 0;
  private sampleAt = 0;
  private clock = 0;
  private started = false;
  private disposed = false;

  /**
   * Baked layers, keyed by the atmosphere they were baked for.
   *
   * A restart must not re-bake. `unlockAudio()` is deliberately idempotent and
   * is called from EVERY user gesture (iOS can drop a context when the app is
   * backgrounded), so without this a player who clicks twice pays for the bed
   * twice — measured at 105 ms for the four layers, which is a visible hitch to
   * spend on a buffer that is already in memory.
   */
  private readonly cache = new Map<string, Float32Array>();

  /** Bakes performed. One per layer, ever. */
  bakes = 0;
  /** Milliseconds the four bakes cost, all told. */
  bakeMs = 0;

  constructor(engine: SustainTarget, opts: AmbienceOptions = {}) {
    this.engine = engine;
    this.opts = opts;
    for (let i = 0; i < LAYER_COUNT; i++) {
      this.layers.push({ src: null, gain: null, level: 0, target: 0 });
    }
  }

  /**
   * Point the bed at a level.
   *
   * Cheap when the atmosphere has not really moved, which is the common case —
   * a room re-sending its context, or a mode change inside the same level. When
   * it HAS moved the loops are rebuilt, because the palette does not only set
   * how loud each layer is: it sets the room tone's centre frequency and the
   * machinery's fundamental, and a bed that only re-mixes would play e1m1's
   * room in e1m5's furnace.
   */
  setLevel(palette: LevelPalette, mode: ModeId): void {
    const next = atmosphereOf(palette);
    const moved = Math.abs(next.heat - this.atmos.heat) > 0.08
      || Math.abs(next.dark - this.atmos.dark) > 0.08
      || Math.abs(next.room - this.atmos.room) > 0.08;
    this.atmos = next;
    this.mode = mode;
    if (moved && this.started) { this.cache.clear(); this.stop(); this.start(); }
  }

  /** The three derived numbers, for the test and for the debug overlay. */
  get atmosphere(): Atmosphere { return this.atmos; }

  /** Current mix, 0..1 per layer. Readable without an AudioContext. */
  levelOf(layer: number): number { return this.layers[layer]?.level ?? 0; }
  targetOf(layer: number): number { return this.layers[layer]?.target ?? 0; }

  /**
   * One frame.
   *
   * The world probe runs on its own 5 Hz clock; the gains glide toward their
   * targets and are only WRITTEN when they actually moved, so a player standing
   * still in a room they have been in for a minute costs four float compares.
   */
  update(dt: number, x: number, y: number, z: number, world: AmbienceWorld | null): void {
    if (this.disposed) return;
    this.clock += dt;

    if (world !== null && this.clock >= this.sampleAt) {
      this.sampleAt = this.clock + SAMPLE_PERIOD;
      const p = probeWorld(world, x, y, z);
      // Smooth the probe, or walking past a doorway steps the lava bed.
      this.lava += (p.lava - this.lava) * 0.35;
      this.open += (p.open - this.open) * 0.35;
    }

    this.computeTargets();

    const k = dt > 0 ? 1 - Math.exp(-dt / LAYER_GLIDE) : 0;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const L = this.layers[i];
      const next = L.level + (L.target - L.level) * k;
      if (Math.abs(next - L.level) < 1e-4 && Math.abs(L.target - L.level) < 1e-4) continue;
      L.level = next;
      if (L.gain !== null) L.gain.gain.value = next * LAYER_MAX[i];
    }
  }

  /**
   * Build the four loops and start them. Must be called on a user gesture —
   * `start()` on a suspended context schedules against a clock that is not
   * moving, and the bed arrives all at once when the context resumes.
   */
  start(): void {
    if (this.disposed || this.started || this.opts.silent === true) return;
    if (!this.engine.ready) return;
    const ctx = this.engine.ctx;
    const bus = this.engine.busNode(BUS_AMBIENCE);
    if (ctx === null || bus === null) return;
    this.started = true;
    const rate = this.engine.sampleRate;
    const seed = this.opts.seed ?? 0xa11b1e;
    const t0 = now();
    for (let i = 0; i < LAYER_COUNT; i++) {
      /* Resampled with `wrap` on. A loop's last sample's right-hand neighbour
         is its FIRST sample; interpolating against a zero there would put back
         the exact discontinuity `bakeLoop` exists to avoid. */
      const key = `${i}:${rate}:${this.atmos.heat.toFixed(2)}:${this.atmos.dark.toFixed(2)}:${this.atmos.room.toFixed(2)}`;
      let data = this.cache.get(key);
      if (data === undefined) {
        data = resampleTo(bakeLayer(i, this.atmos, seed + i * 977), BAKE_RATE, rate, true);
        this.cache.set(key, data);
        this.bakes++;
      }
      const buf = ctx.createBuffer(1, data.length, rate);
      buf.copyToChannel(data, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // Detune each layer a hair so four loops of prime-ish length never
      // re-align into an audible period.
      src.playbackRate.value = 1 + (i - 1.5) * 0.004;
      const gain = ctx.createGain();
      gain.gain.value = this.layers[i].level * LAYER_MAX[i];
      src.connect(gain).connect(bus);
      src.start();
      this.layers[i].src = src;
      this.layers[i].gain = gain;
    }
    this.bakeMs += now() - t0;
  }

  stop(): void {
    for (const L of this.layers) {
      if (L.src !== null) { try { L.src.stop(); } catch { /* ignore */ } try { L.src.disconnect(); } catch { /* ignore */ } }
      if (L.gain !== null) { try { L.gain.disconnect(); } catch { /* ignore */ } }
      L.src = null; L.gain = null; L.level = 0; L.target = 0;
    }
    this.started = false;
  }

  dispose(): void { this.stop(); this.cache.clear(); this.disposed = true; }

  /* ---- the mix ------------------------------------------------------- */

  /**
   * Where each layer wants to be, 0..1, from the atmosphere, the mode and the
   * world probe.
   *
   * Split out and pure so the test can drive a whole level's worth of
   * atmospheres through it without an `AudioContext`, which is the only way to
   * assert the thing that actually matters — that e1m5-furnace and e1m2-coolant
   * do not sound the same.
   */
  private computeTargets(): void {
    const a = this.atmos;
    const t = ambienceMix(a, this.mode, this.lava, this.open);
    for (let i = 0; i < LAYER_COUNT; i++) this.layers[i].target = t[i];
  }
}

/**
 * The mix rule, as a pure function of the four inputs.
 *
 * Exported because this is the part with an opinion in it, and an opinion in a
 * codebase should be testable.
 */
export function ambienceMix(a: Atmosphere, mode: ModeId, lava: number, open: number): number[] {
  const out = [0, 0, 0, 0];

  /* Room tone is always there. Dark levels get LESS of it, not more: the bed
     has to leave headroom for the thing you are straining to hear. */
  out[LAYER_ROOM] = 0.55 + 0.30 * (1 - a.dark) + 0.15 * a.room;

  /* Machinery is the cold, industrial half of the palette, and Horde leans on
     it because Horde is a siege and a siege should sound mechanical. */
  const industrial = (1 - a.heat) * (0.35 + 0.4 * a.room);
  out[LAYER_MACHINE] = industrial * (mode === ModeId.HORDE ? 1.35 : mode === ModeId.BUILDER ? 0.35 : 1);

  /* Lava is mostly proximity — you should hear the lake before you fall in it —
     with a floor from the palette, so a furnace level hums even in a room that
     happens to have no lava in it. */
  out[LAYER_LAVA] = clamp01(lava * 0.85 + a.heat * 0.35);

  /* Wind needs sky. A hot level's wind is a draught off a furnace, so heat does
     not silence it, it just stops it being the airy version. */
  out[LAYER_WIND] = clamp01(open * (0.5 + 0.5 * a.room) * (1 - 0.35 * a.heat));

  /* Builder is a sandbox, not a haunting. Everything comes down and the wind
     comes up: the mode where you stand still and place blocks for an hour is
     the mode where a menacing drone becomes unbearable. */
  if (mode === ModeId.BUILDER) {
    out[LAYER_ROOM] *= 0.7;
    out[LAYER_LAVA] *= 0.8;
    out[LAYER_WIND] = clamp01(out[LAYER_WIND] * 1.25 + 0.15);
  }

  for (let i = 0; i < LAYER_COUNT; i++) out[i] = clamp01(out[i]);
  return out;
}

/* ------------------------------------------------------------------------ *
 * The bakes
 * ------------------------------------------------------------------------ */

/**
 * Build one layer's loop. Pure, deterministic, and returns 11,025 Hz samples.
 *
 * The spectra are shaped by the atmosphere, so the bed is not a fixed sound
 * with a volume knob on it: a tight room's tone is centred an octave above a
 * hall's, and a hot level's machinery is a lower, slower thing than a coolant
 * plant's.
 */
export function bakeLayer(layer: number, a: Atmosphere, seed: number): Float32Array {
  const seconds = LAYER_SECONDS[layer];
  switch (layer) {
    case LAYER_ROOM: {
      /* Room tone: a narrow band of near-pink noise. `room` sets the centre —
         a 30 m corridor rings around 190 Hz, a 90 m hall down at 90 — and
         `dark` narrows it, which is what makes a black level sound like it is
         listening to you. */
      const centre = 190 - 100 * a.room;
      const width = 1.9 - 0.7 * a.dark;
      return bakeLoop(seconds, bandSpectrum(centre / width, centre * width, 0.9), seed, 200);
    }
    case LAYER_MACHINE: {
      /* Distant machinery: a low band plus a slow beat. The beat is not an LFO
         on a gain — it is baked in, as a pair of partials a fraction of a hertz
         apart, so it costs nothing at run time and cannot drift out of the
         loop's period. */
      const base = 58 + 34 * (1 - a.heat);
      const spec = bandSpectrum(base * 0.5, base * 5.5, 1.35);
      const data = bakeLoop(seconds, (hz) => {
        let w = spec(hz);
        // Emphasise the harmonic series of the plant's fundamental.
        const k = hz / base;
        const near = Math.abs(k - Math.round(k));
        if (Math.round(k) >= 1 && near < 0.06) w *= 3.4;
        return w;
      }, seed, 240);
      return data;
    }
    case LAYER_LAVA: {
      /* Lava: a sub rumble welded to a crackle band. The crackle is baked as a
         high band whose partials are randomised in phase — over a 4.7 s loop
         that reads as irregular spitting rather than as a tone, and it never
         needs a scheduler. */
      return bakeLoop(seconds, (hz) => {
        if (hz < 24) return 0;
        if (hz < 90) return 1.5 / Math.pow(hz / 24, 0.4);        // the rumble
        if (hz < 700) return 0.22 / Math.pow(hz / 90, 1.1);      // body
        if (hz < 4200) return 0.5 / Math.pow(hz / 700, 0.55);    // the crackle
        return 0;
      }, seed, 260);
    }
    default: {
      /* Wind: broad, gently tilted, with the low end rolled off so it reads as
         air moving rather than as a rumble. Nothing about it is level-specific
         except how much of it you get, which is the world probe's job. */
      return bakeLoop(seconds, (hz) => {
        if (hz < 55) return 0;
        if (hz > 3600) return 0;
        return 1 / Math.pow(hz / 55, 0.78);
      }, seed, 220);
    }
  }
}
