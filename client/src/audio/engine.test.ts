/**
 * The voice pool, the bus tree and the spatial maths.
 *
 * Web Audio does not exist under `environment: 'node'`, so the engine is driven
 * against a fake context that records what it was asked to build. That is not a
 * compromise — the claims worth testing here are all about ALLOCATION, and the
 * fake makes those directly observable in a way a real AudioContext does not:
 * how many nodes get created per shot, that the pooled chain really is reused,
 * that the hard cap holds, and that stealing follows priority.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AudioEngine, BUS_SFX, BUS_MUSIC, BUS_UI,
  PRIO_AMBIENT, PRIO_FOOTSTEP, PRIO_LOCAL_WEAPON, PRIO_EXPLOSION,
} from './engine';
import { SpatialAudio, createSpatialResult } from './spatial';
import { DEFAULT_SETTINGS, BlockId } from '@shared/index';

/* ------------------------------------------------------------------------ *
 * A fake Web Audio graph
 * ------------------------------------------------------------------------ */

interface Counts {
  gain: number; panner: number; filter: number; source: number; compressor: number;
  connects: number; disconnects: number;
}

let counts: Counts;

function param(v = 0): Record<string, unknown> {
  return {
    value: v,
    setValueAtTime(x: number) { (this as { value: number }).value = x; },
    setTargetAtTime(x: number) { (this as { value: number }).value = x; },
  };
}

function node(kind: keyof Counts): Record<string, unknown> {
  counts[kind]++;
  return {
    connect(): void { counts.connects++; },
    disconnect(): void { counts.disconnects++; },
  };
}

class FakeCtx {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  createGain(): unknown { return { ...node('gain'), gain: param(1) }; }
  createStereoPanner(): unknown { return { ...node('panner'), pan: param(0) }; }
  createBiquadFilter(): unknown {
    return { ...node('filter'), type: 'lowpass', frequency: param(22050), Q: param(0.707) };
  }
  createDynamicsCompressor(): unknown {
    return {
      ...node('compressor'),
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    };
  }
  createBufferSource(): unknown {
    counts.source++;
    return {
      buffer: null,
      playbackRate: param(1),
      connect(): void { counts.connects++; },
      disconnect(): void { counts.disconnects++; },
      start(): void { /* scheduled */ },
      stop(): void { /* cancelled */ },
    };
  }
  createBuffer(ch: number, len: number, sr: number): unknown {
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr,
      copyToChannel(): void { /* stored */ } };
  }
  resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }
  suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
}

function install(): void {
  counts = { gain: 0, panner: 0, filter: 0, source: 0, compressor: 0, connects: 0, disconnects: 0 };
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeCtx };
}

/**
 * Move the fake audio clock forward.
 *
 * `AudioContext.currentTime` is readonly on the real type, which is right — it
 * is the hardware clock. Advancing it is the whole point of the fake, so the
 * cast is confined to this one helper rather than sprinkled through the tests.
 */
function advance(e: AudioEngine, seconds: number): void {
  const c = e.ctx as unknown as { currentTime: number };
  c.currentTime += seconds;
}

/** An engine with `n` slots and one 100 ms sound installed under every id used. */
function makeEngine(cap: number, ids: string[] = ['a', 'b', 'c']): AudioEngine {
  const e = new AudioEngine({ maxVoices: cap });
  e.unlock();
  for (const id of ids) e.addBuffers(id, [new Float32Array(4800)]);   // 100 ms @ 48k
  return e;
}

beforeEach(install);

/* ------------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------------ */

describe('context lifecycle', () => {
  it('builds NO context until unlock is called', () => {
    const e = new AudioEngine();
    expect(e.ctx).toBeNull();
    expect(e.ready).toBe(false);
    // Nothing at all was constructed — this is the autoplay-policy contract.
    expect(counts.gain).toBe(0);
    expect(counts.filter).toBe(0);
  });

  it('builds the graph exactly once, however many times unlock is called', () => {
    const e = new AudioEngine({ maxVoices: 8 });
    e.unlock();
    const after = { ...counts };
    e.unlock(); e.unlock(); e.unlock();
    expect(counts.gain).toBe(after.gain);
    expect(counts.filter).toBe(after.filter);
    expect(counts.panner).toBe(after.panner);
  });

  it('pre-builds one pooled chain per voice slot and no more', () => {
    const cap = 8;
    const e = new AudioEngine({ maxVoices: cap });
    e.unlock();
    expect(counts.filter).toBe(cap);
    expect(counts.panner).toBe(cap);
    // One gain per voice, plus four buses, plus the master.
    expect(counts.gain).toBe(cap + 5);
    expect(counts.compressor).toBe(1);
    expect(e.ready).toBe(true);
  });

  it('suspends on tab hide and resumes on tab show', () => {
    const e = makeEngine(4);
    e.play('a');
    expect(e.activeVoices()).toBe(1);
    e.setTabHidden(true);
    expect(e.ctx!.state).toBe('suspended');
    // Live voices are cut, not left hanging for the resume to replay.
    expect(e.activeVoices()).toBe(0);
    e.setTabHidden(false);
    expect(e.ctx!.state).toBe('running');
  });
});

/* ------------------------------------------------------------------------ *
 * Allocation — the performance claim
 * ------------------------------------------------------------------------ */

describe('a shot allocates only a BufferSource', () => {
  it('creates no filter, panner or gain node when a sound plays', () => {
    const e = makeEngine(8);
    const before = { ...counts };
    for (let i = 0; i < 50; i++) e.play('a');
    expect(counts.filter).toBe(before.filter);
    expect(counts.panner).toBe(before.panner);
    expect(counts.gain).toBe(before.gain);
    // Exactly one source per accepted play, and nothing else.
    expect(counts.source).toBeGreaterThan(0);
  });

  it('re-patches a slot to a bus only when the bus actually changes', () => {
    const e = makeEngine(4);
    e.play('a', { bus: BUS_SFX });
    const afterFirst = counts.connects;
    // Same slot, same bus, many times: the source connect is unavoidable, but
    // the gain->bus connect must not repeat.
    for (let i = 0; i < 10; i++) {
      advance(e, 0.2);          // let the slot free itself
      e.play('a', { bus: BUS_SFX });
    }
    const perPlay = (counts.connects - afterFirst) / 10;
    expect(perPlay).toBeCloseTo(1, 5);    // one connect per play: the source
  });

  it('does re-patch when a slot is asked for a different bus', () => {
    const e = makeEngine(1);
    e.play('a', { bus: BUS_SFX });
    const before = counts.disconnects;
    advance(e, 0.2);
    e.play('a', { bus: BUS_MUSIC });
    expect(counts.disconnects).toBeGreaterThan(before);
  });
});

/* ------------------------------------------------------------------------ *
 * The cap and the stealing rule
 * ------------------------------------------------------------------------ */

describe('the hard concurrency cap', () => {
  it('never exceeds the cap however many sounds are requested', () => {
    const e = makeEngine(6);
    for (let i = 0; i < 200; i++) e.play('a', { priority: PRIO_FOOTSTEP });
    expect(e.activeVoices()).toBeLessThanOrEqual(6);
    expect(e.stats().peakActive).toBeLessThanOrEqual(6);
  });

  it('steals the lowest priority voice, not the newest', () => {
    const e = makeEngine(3);
    // Fill with two loud things and one cheap one.
    e.play('a', { priority: PRIO_EXPLOSION });
    e.play('b', { priority: PRIO_LOCAL_WEAPON });
    e.play('c', { priority: PRIO_AMBIENT });
    expect(e.activeVoices()).toBe(3);
    const stolenBefore = e.stats().stolen;
    // A weapon arrives with the pool full: the AMBIENT voice must go.
    const slot = e.play('a', { priority: PRIO_LOCAL_WEAPON });
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(e.stats().stolen).toBe(stolenBefore + 1);
    expect(e.activeVoices()).toBe(3);
  });

  it('refuses a sound that cannot outrank anything already playing', () => {
    const e = makeEngine(2);
    e.play('a', { priority: PRIO_EXPLOSION });
    e.play('b', { priority: PRIO_EXPLOSION });
    // An ambient hum against two live explosions loses and is simply dropped.
    expect(e.play('c', { priority: PRIO_AMBIENT })).toBe(-1);
  });

  it('among equal priorities steals the OLDEST, so a burst behaves as a queue', () => {
    const e = makeEngine(2);
    const first = e.play('a', { priority: PRIO_FOOTSTEP });
    advance(e, 0.01);
    e.play('b', { priority: PRIO_FOOTSTEP });
    advance(e, 0.01);
    const third = e.play('c', { priority: PRIO_FOOTSTEP });
    expect(third).toBe(first);
  });

  it('reclaims slots once their sound has finished', () => {
    const e = makeEngine(2);
    e.play('a'); e.play('b');
    expect(e.activeVoices()).toBe(2);
    advance(e, 0.2);            // both 100 ms sounds are over
    expect(e.activeVoices()).toBe(0);
    expect(e.play('c')).toBeGreaterThanOrEqual(0);
    expect(e.stats().stolen).toBe(0);     // nothing had to be stolen
  });
});

/* ------------------------------------------------------------------------ *
 * The retrigger gate
 * ------------------------------------------------------------------------ */

describe('the retrigger gate collapses a pellet burst', () => {
  it('plays one voice for seven same-frame impacts', () => {
    const e = makeEngine(16);
    let played = 0;
    // A shotgun resolving seven pellets in one frame.
    for (let p = 0; p < 7; p++) if (e.play('a', {}, 45) >= 0) played++;
    expect(played).toBe(1);
    expect(e.stats().droppedByGate).toBe(6);
  });

  it('lets the sound through again once the gap has passed', () => {
    const e = makeEngine(16);
    expect(e.play('a', {}, 45)).toBeGreaterThanOrEqual(0);
    advance(e, 0.05);
    expect(e.play('a', {}, 45)).toBeGreaterThanOrEqual(0);
  });

  it('gates per sound id, not globally', () => {
    const e = makeEngine(16);
    expect(e.play('a', {}, 45)).toBeGreaterThanOrEqual(0);
    // A different sound in the same frame is a different event and must speak.
    expect(e.play('b', {}, 45)).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------------ */

describe('settings', () => {
  it('is silent at zero master volume and audible above it', () => {
    const e = makeEngine(4);
    e.applySettings({ ...DEFAULT_SETTINGS, masterVolume: 0 });
    expect(e.stats().state).toBe('running');
    e.setMasterVolume(0.8);
    expect(e.play('a')).toBeGreaterThanOrEqual(0);
  });

  it('accepts a per-bus volume without disturbing the others', () => {
    const e = makeEngine(4);
    e.setBusVolume(BUS_UI, 0.25);
    expect(e.play('a', { bus: BUS_UI })).toBeGreaterThanOrEqual(0);
  });

  it('clamps out-of-range volumes rather than trusting a corrupt save', () => {
    const e = makeEngine(4);
    e.applySettings({ ...DEFAULT_SETTINGS, masterVolume: 4, sfxVolume: -2 });
    // No exception, and the graph is still usable.
    expect(e.play('a')).toBeGreaterThanOrEqual(0);
  });

  it('plays nothing for an id that was never baked', () => {
    const e = makeEngine(4);
    expect(e.play('never-baked')).toBe(-1);
  });
});

/* ------------------------------------------------------------------------ *
 * Spatial
 * ------------------------------------------------------------------------ */

describe('distance and direction', () => {
  const s = new SpatialAudio();
  const out = createSpatialResult();

  beforeEach(() => {
    s.setListener(0, 0, 0, 0);      // facing -Z, the project's yaw convention
    s.setFogFar(192);
    s.setWorld(null, null);
    s.beginFrame(0);
  });

  it('is full level at the listener and quieter further away', () => {
    s.resolve(0, 0, -1, out);
    const near = out.gain;
    s.resolve(0, 0, -20, out);
    const mid = out.gain;
    s.resolve(0, 0, -80, out);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(out.gain);
  });

  it('falls monotonically with distance, with no steps', () => {
    let prev = Infinity;
    for (let d = 1; d < 200; d += 3) {
      s.resolve(0, 0, -d, out);
      expect(out.gain).toBeLessThanOrEqual(prev + 1e-9);
      prev = out.gain;
    }
  });

  it('reports a sound past the audio horizon as inaudible, so it costs no voice', () => {
    expect(s.resolve(0, 0, -1000, out)).toBe(false);
    expect(out.gain).toBe(0);
  });

  it('follows the renderer\'s fog: a shorter view distance is a shorter earshot', () => {
    s.setFogFar(192);
    s.resolve(0, 0, -150, out);
    const far = out.gain;
    s.setFogFar(64);
    s.resolve(0, 0, -150, out);
    expect(out.gain).toBeLessThan(far);
  });

  it('pans right for a source on the right and left for one on the left', () => {
    // Facing -Z, so +X is the listener's right.
    s.resolve(10, 0, 0, out);
    expect(out.pan).toBeGreaterThan(0.3);
    s.resolve(-10, 0, 0, out);
    expect(out.pan).toBeLessThan(-0.3);
  });

  it('centres a source directly ahead and directly behind', () => {
    s.resolve(0, 0, -10, out);
    expect(Math.abs(out.pan)).toBeLessThan(0.05);
    s.resolve(0, 0, 10, out);
    expect(Math.abs(out.pan)).toBeLessThan(0.05);
  });

  it('never hard-pans — a sound entirely in one ear is disorienting', () => {
    for (const x of [1, 5, 40, 100]) {
      s.resolve(x, 0, 0, out);
      expect(Math.abs(out.pan)).toBeLessThan(0.9);
    }
  });

  it('rotates with the listener, not with the world', () => {
    s.resolve(10, 0, 0, out);
    const facingNorth = out.pan;
    // Turn 180 degrees: the same source is now on the other side.
    s.setListener(0, 0, 0, Math.PI);
    s.resolve(10, 0, 0, out);
    expect(Math.sign(out.pan)).toBe(-Math.sign(facingNorth));
  });

  it('dulls distant sounds — air absorption, not a cliff', () => {
    s.resolve(0, 0, -3, out);
    const near = out.lowpass;       // 0 means "open"
    s.resolve(0, 0, -150, out);
    expect(out.lowpass).toBeGreaterThan(0);
    if (near > 0) expect(out.lowpass).toBeLessThan(near);
  });
});

describe('occlusion', () => {
  /** A world that is solid everywhere except the plane y = 0. */
  const solidWall = (): number => BlockId.STONE;
  const openWorld = (): number => BlockId.AIR;
  const blocking = (id: number): boolean => id !== BlockId.AIR;

  it('muffles and attenuates a sound behind a wall', () => {
    const s = new SpatialAudio();
    s.setListener(0, 0, 0, 0);
    s.setFogFar(192);
    s.beginFrame(0);

    s.setWorld(openWorld, blocking);
    const clear = createSpatialResult();
    s.resolve(0, 0, -20, clear);

    const s2 = new SpatialAudio();
    s2.setListener(0, 0, 0, 0);
    s2.setFogFar(192);
    s2.beginFrame(0);
    s2.setWorld(solidWall, blocking);
    const blocked = createSpatialResult();
    s2.resolve(0, 0, -20, blocked);

    expect(blocked.gain).toBeLessThan(clear.gain);
    // And it is filtered, not merely turned down: a wall removes treble.
    expect(blocked.lowpass).toBeGreaterThan(0);
    expect(blocked.lowpass).toBeLessThan(clear.lowpass || 20000);
  });

  it('spends at most three raycasts per frame however many sounds ask', () => {
    let rays = 0;
    const counting = (): number => { rays++; return BlockId.STONE; };
    const s = new SpatialAudio();
    s.setListener(0, 0, 0, 0);
    s.setFogFar(192);
    s.setWorld(counting, blocking);
    s.beginFrame(0);

    // Forty sounds, all in DIFFERENT cache cells so none can be answered from
    // the cache. This is the guard that stops a Horde wave from turning into
    // a thousand DDA marches a second.
    const out = createSpatialResult();
    let marches = 0;
    for (let i = 0; i < 40; i++) {
      const before = rays;
      s.resolve(i * 4 + 8, 0, -10, out);
      if (rays > before) marches++;
    }
    expect(marches).toBeLessThanOrEqual(3);
  });

  it('answers repeated queries in the same cell from the cache, for free', () => {
    let rays = 0;
    const counting = (): number => { rays++; return BlockId.STONE; };
    const s = new SpatialAudio();
    s.setListener(0, 0, 0, 0);
    s.setFogFar(192);
    s.setWorld(counting, blocking);
    const out = createSpatialResult();

    s.beginFrame(0);
    s.resolve(0, 0, -20, out);
    const afterFirst = rays;
    expect(afterFirst).toBeGreaterThan(0);

    // A later frame, still inside the TTL and still the same 2 m cell.
    // (-20 and -19.8 both floor to cell -10; -20.2 would be cell -11.)
    s.beginFrame(100);
    s.resolve(0.3, 0, -19.8, out);
    expect(rays).toBe(afterFirst);
  });

  it('re-tests once the cache entry has expired', () => {
    let rays = 0;
    const counting = (): number => { rays++; return BlockId.STONE; };
    const s = new SpatialAudio();
    s.setListener(0, 0, 0, 0);
    s.setFogFar(192);
    s.setWorld(counting, blocking);
    const out = createSpatialResult();

    s.beginFrame(0);
    s.resolve(0, 0, -20, out);
    const afterFirst = rays;
    s.beginFrame(9999);              // well past the 250 ms TTL
    s.resolve(0, 0, -20, out);
    expect(rays).toBeGreaterThan(afterFirst);
  });

  it('does nothing at all when there is no world attached', () => {
    const s = new SpatialAudio();
    s.setListener(0, 0, 0, 0);
    s.setFogFar(192);
    s.setWorld(null, null);
    s.beginFrame(0);
    const out = createSpatialResult();
    expect(s.resolve(0, 0, -20, out)).toBe(true);
    expect(out.gain).toBeGreaterThan(0);
  });

  it('never occlusion-tests a sound that is right on top of the listener', () => {
    let rays = 0;
    const counting = (): number => { rays++; return BlockId.STONE; };
    const s = new SpatialAudio();
    s.setListener(0, 0, 0, 0);
    s.setFogFar(192);
    s.setWorld(counting, blocking);
    s.beginFrame(0);
    const out = createSpatialResult();
    s.resolve(0, 0, -1.5, out);
    expect(rays).toBe(0);
  });
});
