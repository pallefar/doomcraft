/**
 * DOOMCRAFT — the §3.2 timer discipline, proven on the pure state machine:
 * continuous means continuous, the pixel test precedes the clock, one
 * impression per slot per session, replay cools off, and exposure is a
 * separate, non-consecutive accumulator.
 */

import { describe, expect, it } from 'vitest';

import { SlotMeter, gateOpen, type GateState, type MeterEvent } from './viewability';

const OPEN: GateState = {
  visible: true, focused: true, prerendering: false,
  menuMode: true, overlayOpen: false, creativeLoaded: true, msSinceInput: 0,
};

function meter(): { m: SlotMeter; events: MeterEvent[] } {
  const events: MeterEvent[] = [];
  return { m: new SlotMeter((e) => events.push(e)), events };
}

describe('the impression run', () => {
  it('emits exactly one impression after one continuous second at ratio >= 0.5', () => {
    const { m, events } = meter();
    for (let t = 0; t <= 1200; t += 100) m.update(t, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'impression').length).toBe(1);
    // And holding qualified longer does not double it.
    for (let t = 1300; t <= 5000; t += 100) m.update(t, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'impression').length).toBe(1);
  });

  it('0.4 s on / 0.1 s off / 0.4 s on accumulates ZERO impressions — no grace period', () => {
    const { m, events } = meter();
    for (let t = 0; t <= 400; t += 100) m.update(t, 1, false, OPEN);
    m.update(450, 0.2, false, OPEN);                    // dips below the ratio
    for (let t = 500; t <= 900; t += 100) m.update(t, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'impression').length).toBe(0);
    // But exposure DID accrue across both windows (looser test, separate clock).
    expect(m.flush()).toBeGreaterThan(700);
  });

  it('every gate can only subtract: focus loss mid-run resets it', () => {
    const { m, events } = meter();
    for (let t = 0; t <= 800; t += 100) m.update(t, 1, false, OPEN);
    m.update(900, 1, false, { ...OPEN, focused: false });
    for (let t = 1000; t <= 1800; t += 100) m.update(t, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'impression').length).toBe(0);
    m.update(2000, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'impression').length).toBe(1);
  });

  it('a replay needs the cool-off; occlusion gates like everything else', () => {
    const { m, events } = meter();
    for (let t = 0; t <= 1100; t += 100) m.update(t, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'impression').length).toBe(1);
    // A second qualifying run right away is inside the 30 s cool-off: no replay.
    for (let t = 1200; t <= 2400; t += 100) m.update(t, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'replay').length).toBe(0);
    // After the cool-off, a full new run emits exactly one replay.
    for (let t = 33_000; t <= 34_200; t += 100) m.update(t, 1, false, OPEN);
    expect(events.filter((e) => e.type === 'replay').length).toBe(1);
    // Occluded (IO v2 isVisible false) never qualifies.
    const { m: m2, events: e2 } = meter();
    for (let t = 0; t <= 2000; t += 100) m2.update(t, 1, true, OPEN);
    expect(e2.filter((e) => e.type === 'impression').length).toBe(0);
  });

  it('the idle gate is ours and it closes the run', () => {
    expect(gateOpen({ ...OPEN, msSinceInput: 61_000 })).toBe(false);
    const { m, events } = meter();
    for (let t = 0; t <= 2000; t += 100) m.update(t, 1, false, { ...OPEN, msSinceInput: 61_000 });
    expect(events.filter((e) => e.type === 'impression').length).toBe(0);
  });
});
