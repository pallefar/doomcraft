/**
 * DOOMCRAFT — audio engine.
 *
 * Context lifecycle, the bus tree, and a voice pool with a hard cap.
 *
 * ── Why the design is "bake once, then only ever start a buffer" ──────────
 *
 * The project budget is ~120 draw calls and 0.90 ms of main-thread frame time.
 * Web Audio's DSP runs on its own thread, but every node you CREATE and every
 * `connect()` you make is main-thread work on the render thread's behalf, and
 * that is where a naive audio layer eats a frame. Measured in headless Chrome
 * at 48 kHz, cost to start 300 voices:
 *
 *     PannerNode (HRTF)      + gain, built per voice   7.8 ms   26.0 us/voice
 *     PannerNode (equalpower)+ gain, built per voice   4.8 ms   16.0 us/voice
 *     StereoPanner + gain,          built per voice    5.4 ms   18.0 us/voice
 *     POOLED chain, only the BufferSource is new       1.6 ms    5.3 us/voice
 *
 * So the whole architecture follows from that last row. Every voice's
 * filter -> panner -> gain chain is built ONCE at unlock and lives forever; a
 * gunshot allocates a single `AudioBufferSourceNode`, points it at a
 * pre-rendered buffer, sets three AudioParams and starts it. At the 24-voice
 * cap a worst-case frame that fires every voice costs 0.13 ms, which is inside
 * the budget with room to spare. Building HRTF panners per shot instead would
 * cost 0.62 ms for the same 24 voices — two thirds of the entire frame budget,
 * for the panning alone.
 *
 * The same logic bans per-sound synthesis at runtime: `sfx.ts` bakes the whole
 * catalogue into AudioBuffers on unlock (see `prewarm`), so firing a weapon
 * never runs a filter, an envelope or an RNG.
 *
 * ── Autoplay and the tab ──────────────────────────────────────────────────
 *
 * No AudioContext is constructed until a real user gesture arrives. That is not
 * politeness: on iOS Safari and on Chrome an AudioContext created outside a
 * gesture starts `suspended`, and a game that builds one at boot and hopes gets
 * silence forever with no error. `unlock()` is the only thing that constructs
 * it, it is idempotent, and `main.ts` calls it from every plausible first
 * gesture. The context is then suspended when the tab hides — a backgrounded
 * tab that keeps a context running keeps the audio thread and its timers alive
 * for nothing.
 */

import type { GameSettings } from '@shared/constants';

/* ------------------------------------------------------------------------ *
 * Buses
 * ------------------------------------------------------------------------ */

export const BUS_SFX = 0;
export const BUS_MUSIC = 1;
export const BUS_UI = 2;
export const BUS_AMBIENCE = 3;
export const BUS_COUNT = 4;

export type BusId = 0 | 1 | 2 | 3;

/* ------------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------------ */

/**
 * Stealing order. When every voice is busy the engine drops the numerically
 * lowest priority, and among equals the one that started earliest.
 *
 * The ranking is a gameplay judgement, not an aesthetic one: the sounds that
 * carry INFORMATION the player acts on outrank the sounds that carry texture.
 * Losing a footstep costs nothing; losing the shot that killed you costs the
 * round. Your own weapon outranks everyone else's because it is the feedback
 * loop for the thing you are doing right now.
 */
export const PRIO_AMBIENT = 0;
export const PRIO_FOOTSTEP = 1;
export const PRIO_IMPACT = 2;
export const PRIO_BLOCK = 3;
export const PRIO_REMOTE_WEAPON = 4;
export const PRIO_PICKUP = 5;
export const PRIO_LOCAL_WEAPON = 6;
export const PRIO_DAMAGE = 7;
export const PRIO_EXPLOSION = 8;
export const PRIO_UI = 9;

/* ------------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------------ */

export interface AudioEngineOptions {
  /**
   * Hard concurrency cap. Desktop 24, mobile 12 — a phone's audio thread is
   * both slower and sharing a core with the renderer, and past a dozen
   * simultaneous voices nothing is individually audible anyway.
   */
  maxVoices?: number;
  /** Suppress synthesis while still doing every scheduling call. Bench hook. */
  silent?: boolean;
}

/** What `play` needs to know beyond which sound to make. */
export interface PlayOptions {
  bus?: BusId;
  /** Linear gain multiplier applied on top of the bus. */
  gain?: number;
  /** Playback-rate multiplier. 1 = as baked. Cheap pitch variation. */
  rate?: number;
  /** -1 hard left .. +1 hard right. */
  pan?: number;
  /** Stealing rank. See the PRIO_ constants. */
  priority?: number;
  /**
   * Lowpass in Hz applied to this voice. `spatial.ts` uses it for occlusion;
   * 0 or omitted leaves the filter wide open and costs nothing extra, because
   * the node is pooled and already in the chain either way.
   */
  lowpass?: number;
  /** Seconds to wait before the voice starts, on the audio clock. */
  delay?: number;
}

/** Runtime counters, surfaced through `window.__DC__.audioStats()`. */
export interface AudioStats {
  state: string;
  active: number;
  peakActive: number;
  cap: number;
  started: number;
  stolen: number;
  droppedByGate: number;
  buffers: number;
  bakeMs: number;
}

/* ------------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------------ */

const DEFAULT_MAX_VOICES = 24;

export class AudioEngine {
  ctx: AudioContext | null = null;

  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private readonly busGain: (GainNode | null)[] = [null, null, null, null];

  /** Pooled per-voice chains. Index is the voice slot. */
  private vFilter: BiquadFilterNode[] = [];
  private vPan: StereoPannerNode[] = [];
  private vGain: GainNode[] = [];
  private vSrc: (AudioBufferSourceNode | null)[] = [];
  /** Which bus each slot is currently patched into, so we only re-connect on change. */
  private vBus: Int8Array = new Int8Array(0);

  /** Slot bookkeeping, as flat arrays so allocation is zero per shot. */
  private vPriority: Int16Array = new Int16Array(0);
  private vEndsAt: Float64Array = new Float64Array(0);
  private vStartedAt: Float64Array = new Float64Array(0);

  private cap = DEFAULT_MAX_VOICES;
  private silent = false;
  private unlocked = false;
  private suspendedByTab = false;

  /** Baked PCM, keyed by sound id; each entry is that sound's variant set. */
  private readonly buffers = new Map<string, AudioBuffer[]>();

  /** Per-sound-id last-start time, the retrigger gate. */
  private readonly lastStart = new Map<string, number>();

  private volMaster = 0.8;
  private readonly volBus = new Float32Array([1, 0.5, 1, 1]);

  private statStarted = 0;
  private statStolen = 0;
  private statGated = 0;
  private statPeak = 0;
  private bakeMs = 0;

  constructor(opts: AudioEngineOptions = {}) {
    // Floor of 1, not 4: a caller that asks for a small pool should get the
    // pool it asked for. Silently rounding up made a two-slot engine behave as
    // a four-slot one, which is exactly the kind of quiet disagreement between
    // the stated and actual cap that a voice-stealing bug hides inside.
    this.cap = Math.max(1, Math.floor(opts.maxVoices ?? DEFAULT_MAX_VOICES));
    this.silent = opts.silent === true;
  }

  /* -------------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------------- */

  get ready(): boolean { return this.unlocked && this.ctx !== null; }

  /**
   * Build (or resume) the context. MUST be called from inside a user-gesture
   * handler the first time; safe and cheap to call on every gesture after.
   *
   * Returns true once the context is running.
   */
  unlock(): boolean {
    if (this.ctx === null) {
      type Ctor = typeof AudioContext;
      const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (Ctor === undefined) return false;
      try {
        // `interactive` asks the platform for the shortest output buffer it
        // will give us. A gunshot that arrives 40 ms after the muzzle flash
        // reads as broken sync, and latency is the one audio quality the
        // player feels rather than hears.
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return false;
      }
      this.buildGraph();
    }
    const ctx = this.ctx;
    if (ctx === null) return false;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* gesture will retry */ });
    this.unlocked = ctx.state !== 'closed';
    return ctx.state === 'running';
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (ctx === null) return;

    /* master -> limiter -> destination */
    const master = ctx.createGain();
    master.gain.value = this.volMaster;

    // A shotgun, two explosions and a chaingun can be in flight together and
    // each one is normalised to near full scale on its own. Without a limiter
    // that sums past 1.0 and the output clips into digital distortion, which
    // is a different and much worse sound than the deliberate saturation baked
    // into the samples. Fast attack so a transient is caught, 250 ms release so
    // it recovers between shots instead of pumping the whole mix.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    master.connect(limiter);
    limiter.connect(ctx.destination);
    this.master = master;
    this.limiter = limiter;

    for (let b = 0; b < BUS_COUNT; b++) {
      const g = ctx.createGain();
      g.gain.value = this.volBus[b];
      g.connect(master);
      this.busGain[b] = g;
    }

    /* the pooled voice chains — built once, reused forever */
    this.vFilter = new Array<BiquadFilterNode>(this.cap);
    this.vPan = new Array<StereoPannerNode>(this.cap);
    this.vGain = new Array<GainNode>(this.cap);
    this.vSrc = new Array<AudioBufferSourceNode | null>(this.cap).fill(null);
    this.vBus = new Int8Array(this.cap).fill(-1);
    this.vPriority = new Int16Array(this.cap);
    this.vEndsAt = new Float64Array(this.cap);
    this.vStartedAt = new Float64Array(this.cap);

    for (let i = 0; i < this.cap; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 22050;
      f.Q.value = 0.707;
      const p = ctx.createStereoPanner();
      const g = ctx.createGain();
      g.gain.value = 0;
      f.connect(p);
      p.connect(g);
      this.vFilter[i] = f;
      this.vPan[i] = p;
      this.vGain[i] = g;
      // Deliberately NOT connected to a bus yet: the first play on each slot
      // patches it, and after that it only re-patches when the bus changes.
    }
  }

  /** Hide/show handling. Call from `visibilitychange`. */
  setTabHidden(hidden: boolean): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    if (hidden) {
      if (ctx.state === 'running') {
        this.suspendedByTab = true;
        this.stopAll();
        void ctx.suspend().catch(() => { /* nothing to do */ });
      }
      return;
    }
    if (this.suspendedByTab) {
      this.suspendedByTab = false;
      void ctx.resume().catch(() => { /* a later gesture will */ });
    }
  }

  /** Cut every live voice without tearing the graph down. */
  stopAll(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    for (let i = 0; i < this.cap; i++) {
      const s = this.vSrc[i];
      if (s === null) continue;
      try { s.stop(); } catch { /* already stopped */ }
      this.vSrc[i] = null;
      this.vEndsAt[i] = 0;
    }
  }

  dispose(): void {
    this.stopAll();
    const ctx = this.ctx;
    this.ctx = null;
    this.unlocked = false;
    this.buffers.clear();
    if (ctx !== null) void ctx.close().catch(() => { /* already gone */ });
  }

  /* -------------------------------------------------------------------- *
   * Settings
   * -------------------------------------------------------------------- */

  /**
   * Wire the bus tree to the player's settings.
   *
   * `GameSettings` already carried `masterVolume`, `sfxVolume` and
   * `musicVolume` before there was an engine to consume them. UI and ambience
   * do not have their own sliders, and inventing two would mean bumping
   * `SAVE_VERSION` and migrating every stored profile for two controls nobody
   * asked for — so UI rides the SFX slider (it is feedback, and a player who
   * turns effects down means the clicks too) and ambience rides it at a fixed
   * discount, being the one bus that should never compete with a gunshot.
   */
  applySettings(s: GameSettings): void {
    this.volMaster = clamp01(s.masterVolume);
    this.volBus[BUS_SFX] = clamp01(s.sfxVolume);
    this.volBus[BUS_MUSIC] = clamp01(s.musicVolume);
    this.volBus[BUS_UI] = clamp01(s.sfxVolume);
    this.volBus[BUS_AMBIENCE] = clamp01(s.sfxVolume) * 0.55;
    this.pushVolumes();
  }

  setMasterVolume(v: number): void { this.volMaster = clamp01(v); this.pushVolumes(); }
  setBusVolume(bus: BusId, v: number): void { this.volBus[bus] = clamp01(v); this.pushVolumes(); }

  private pushVolumes(): void {
    const ctx = this.ctx;
    if (ctx === null || this.master === null) return;
    const t = ctx.currentTime;
    // A ramp, not a jump: setting `.value` on a running graph steps the sample
    // stream and a step is a click. 20 ms is inaudible as a fade and completely
    // removes the discontinuity.
    this.master.gain.setTargetAtTime(this.silent ? 0 : this.volMaster, t, 0.02);
    for (let b = 0; b < BUS_COUNT; b++) {
      this.busGain[b]?.gain.setTargetAtTime(this.volBus[b], t, 0.02);
    }
  }

  /** Bench hook: keep every scheduling call, produce no sound. */
  setSilent(v: boolean): void { this.silent = v; this.pushVolumes(); }

  /* -------------------------------------------------------------------- *
   * Buffers
   * -------------------------------------------------------------------- */

  /**
   * Install a baked variant set under `id`. `pcm` is mono; the panner makes it
   * stereo, so storing one channel halves both the bake cost and the memory.
   */
  addBuffers(id: string, pcm: Float32Array[]): void {
    const ctx = this.ctx;
    if (ctx === null || pcm.length === 0) return;
    const out: AudioBuffer[] = [];
    for (let i = 0; i < pcm.length; i++) {
      const src = pcm[i];
      const b = ctx.createBuffer(1, src.length, ctx.sampleRate);
      b.copyToChannel(src, 0);
      out.push(b);
    }
    this.buffers.set(id, out);
  }

  hasBuffer(id: string): boolean { return this.buffers.has(id); }

  /**
   * The gain node a bus feeds into.
   *
   * `play()` covers one-shots, which is nearly everything. It cannot cover a
   * SUSTAINED source: an ambience bed loops for the length of a level and a
   * music sequencer owns its own scheduling, and neither should be competing
   * for slots in a voice pool sized for gunfire. `ambience.ts` and `music.ts`
   * connect their own nodes here instead, so they ride the bus volume and the
   * limiter exactly like everything else while staying out of the pool.
   * Returns null before `unlock()` has built the graph.
   */
  busNode(bus: BusId): AudioNode | null { return this.busGain[bus]; }
  get bufferCount(): number { return this.buffers.size; }
  get sampleRate(): number { return this.ctx?.sampleRate ?? 48000; }
  noteBakeMs(ms: number): void { this.bakeMs = ms; }

  /* -------------------------------------------------------------------- *
   * Playback
   * -------------------------------------------------------------------- */

  /**
   * Start one voice. Returns the slot, or -1 when nothing was played.
   *
   * `minGapMs` is the retrigger gate and it matters more than it looks: a
   * shotgun resolves seven pellets in one frame and each one reports an impact.
   * Seven copies of the same 40 ms sample started in the same millisecond do
   * not sound seven times bigger — they sum to a single sample played at
   * roughly 17 dB louder, which is comb-filtered, clipped and wrong. The gate
   * collapses them to one, which is also what the original does.
   */
  play(id: string, opts: PlayOptions = {}, minGapMs = 0): number {
    const ctx = this.ctx;
    if (ctx === null || !this.unlocked || ctx.state !== 'running') return -1;
    const set = this.buffers.get(id);
    if (set === undefined || set.length === 0) return -1;

    const now = ctx.currentTime;
    if (minGapMs > 0) {
      const last = this.lastStart.get(id);
      if (last !== undefined && (now - last) * 1000 < minGapMs) { this.statGated++; return -1; }
    }

    const priority = opts.priority ?? PRIO_IMPACT;
    const slot = this.alloc(priority, now);
    if (slot < 0) { this.statGated++; return -1; }

    const buf = set.length === 1 ? set[0] : set[(Math.random() * set.length) | 0];
    const rate = opts.rate ?? 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    const bus = (opts.bus ?? BUS_SFX) as BusId;
    if (this.vBus[slot] !== bus) {
      // Re-patching is rare (a slot usually keeps serving the same bus), which
      // is exactly why it is guarded — `connect`/`disconnect` are the costly
      // calls in the measurement at the top of this file.
      if (this.vBus[slot] >= 0) this.vGain[slot].disconnect();
      const target = this.busGain[bus];
      if (target === null) return -1;
      this.vGain[slot].connect(target);
      this.vBus[slot] = bus;
    }

    const lp = opts.lowpass ?? 0;
    const f = this.vFilter[slot];
    // 22050 is "open": above the 5512 Hz band limit baked into every sample, so
    // the filter is a no-op rather than a colour when nothing occludes.
    f.frequency.setValueAtTime(lp > 0 ? lp : 22050, now);

    this.vPan[slot].pan.setValueAtTime(clampPan(opts.pan ?? 0), now);
    this.vGain[slot].gain.setValueAtTime(Math.max(0, opts.gain ?? 1), now);

    src.connect(f);
    const startAt = now + Math.max(0, opts.delay ?? 0);
    src.start(startAt);

    const prev = this.vSrc[slot];
    if (prev !== null) { try { prev.stop(); } catch { /* raced to its end */ } }
    this.vSrc[slot] = src;
    this.vPriority[slot] = priority;
    this.vStartedAt[slot] = startAt;
    this.vEndsAt[slot] = startAt + buf.duration / Math.max(0.01, rate);
    // `onended` is a per-voice closure allocation, which is exactly the kind of
    // per-shot garbage this engine refuses to make. Slots are reclaimed by
    // comparing `vEndsAt` against the clock in `alloc`, which is free.

    this.lastStart.set(id, now);
    this.statStarted++;
    return slot;
  }

  /**
   * Find a slot: a finished one, else the lowest-priority live one, else -1.
   *
   * One linear pass over at most 24 entries of flat typed arrays. Sorting or a
   * heap would be a worse trade at this size and would allocate.
   */
  private alloc(priority: number, now: number): number {
    let free = -1;
    let victim = -1;
    let victimPrio = priority;
    let victimStart = Infinity;
    let live = 0;

    for (let i = 0; i < this.cap; i++) {
      if (this.vEndsAt[i] <= now) { if (free < 0) free = i; continue; }
      live++;
      const p = this.vPriority[i];
      // Strictly lower priority is stolen outright; an equal priority is stolen
      // only if it is older, so a burst of same-rank sounds behaves as a FIFO
      // rather than letting the first one hold a slot for its whole tail.
      if (p < victimPrio || (p === victimPrio && this.vStartedAt[i] < victimStart)) {
        victim = i; victimPrio = p; victimStart = this.vStartedAt[i];
      }
    }
    if (live > this.statPeak) this.statPeak = live;
    if (free >= 0) return free;
    if (victim >= 0) { this.statStolen++; return victim; }
    return -1;
  }

  /** Live voice count, for the HUD and the bench. */
  activeVoices(): number {
    const ctx = this.ctx;
    if (ctx === null) return 0;
    const now = ctx.currentTime;
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.vEndsAt[i] > now) n++;
    return n;
  }

  stats(): AudioStats {
    return {
      state: this.ctx?.state ?? 'none',
      active: this.activeVoices(),
      peakActive: this.statPeak,
      cap: this.cap,
      started: this.statStarted,
      stolen: this.statStolen,
      droppedByGate: this.statGated,
      buffers: this.buffers.size,
      bakeMs: +this.bakeMs.toFixed(2),
    };
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampPan(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }
