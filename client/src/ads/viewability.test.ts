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

/**
 * The terminal verdict, and the distinction the whole §3.5 metric set rests on.
 *
 * Caveat 6: "Undetermined is not viewable and is not billed." It is also not a
 * measured FAILURE. A creative that never rendered was never measured; a
 * creative that rendered and never met the bar was. Folding the first into the
 * second flatters the Measured Rate, which MRC explicitly asks measurers to
 * maximise — so the incentive runs the wrong way and the check has to be here.
 */
describe('the terminal verdict', () => {
  /**
   * RED WITHOUT THE FIX: make `verdict()` return basis 'measured' whenever no
   * impression was emitted. A slot whose creative never loaded is then reported
   * as a measured non-viewable, inflating both the Measured Rate and the
   * denominator of the Viewable Rate with something nobody measured.
   */
  it('a creative that never rendered is UNDETERMINED, not a measured failure', () => {
    const { m } = meter();
    m.update(0, 1, false, { ...OPEN, creativeLoaded: false });
    m.update(5_000, 1, false, { ...OPEN, creativeLoaded: false });

    const v = m.verdict();
    expect(v.qualified).toBe(false);
    expect(v.basis).toBe('undetermined');
    expect(v.reason).toContain('never rendered');
  });

  it('a creative that rendered but never qualified IS a measured failure', () => {
    const { m } = meter();
    // Rendered, but the window never had focus: watched the whole time, failed.
    m.update(0, 1, false, { ...OPEN, focused: false });
    m.update(5_000, 1, false, { ...OPEN, focused: false });

    const v = m.verdict();
    expect(v.qualified).toBe(false);
    expect(v.basis).toBe('measured');
  });

  it('a fill that met the bar is qualified', () => {
    const { m } = meter();
    m.update(0, 1, false, OPEN);
    m.update(5_000, 1, false, OPEN);

    const v = m.verdict();
    expect(v.qualified).toBe(true);
    expect(v.basis).toBe('measured');
  });

  /**
   * `rendered` is the MRC metric-1 denominator and must come from the client —
   * the server's `served` row records an ALLOCATION, which is a larger number.
   * Deliberately not gated on visibility or focus: rendering is not viewing,
   * and conflating them is what caveat 1 is about.
   */
  it('emits rendered once, on the creative arriving, regardless of visibility', () => {
    const { m, events } = meter();
    m.update(0, 0, true, { ...OPEN, creativeLoaded: true, visible: false, focused: false });
    m.update(1_000, 0, true, { ...OPEN, creativeLoaded: true, visible: false, focused: false });

    expect(events.filter((e) => e.type === 'rendered')).toHaveLength(1);
  });

  it('emits no rendered event when the creative never arrives', () => {
    const { m, events } = meter();
    m.update(0, 1, false, { ...OPEN, creativeLoaded: false });
    expect(events.some((e) => e.type === 'rendered')).toBe(false);
  });
});
