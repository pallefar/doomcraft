/**
 * DOOMCRAFT — mobile control tests.
 *
 * Every claim the mobile piece makes against ref/BAR.md is checked here as a
 * number, because "the controls are better" is not a reviewable statement:
 *
 *   #9  the bar has no fire button and shooting is a look-tap. `FirePad` has to
 *       hold a one-frame tap, has to keep firing through a slide-off, and must
 *       never turn a pure aiming drag into a shot.
 *   #9  no aim assist and no auto-fire. The cone must be bounded, must never
 *       overshoot, and must be completely inert outside its own cone/range.
 *   #10 near-invisible controls. Measured off the bar's own capture, its stick
 *       ring is 1.24:1 against grass. Ours is proved over the whole RGB cube.
 *   #11 the desktop HUD shipped to a 412 px-tall screen. The layout solver is
 *       swept across eight viewports for overlap, bounds and target size.
 */
import { describe, it, expect } from 'vitest';
import { DEG2RAD } from '@shared/math';
import {
  DEFAULT_STICK, createStickSample, resolveStick, ThumbStick,
  DragTracker, FirePad,
  aimAssist, createAimAssistOut, assistRangeWeight, DEFAULT_AIM_ASSIST,
  AutoFire, DEFAULT_AUTO_FIRE,
  createTouchGeom, solveTouchLayout, hitTest, touchDiscs, MIN_TOUCH_TARGET,
  MIN_ATTACK_PAD_D, MAX_ATTACK_PAD_D, MAX_ATTACK_REACH, attackReach,
  TC_STICK, TC_FIRE, TC_JUMP, TC_CROUCH, TC_RELOAD, TC_BUILD, TC_LOOK,
  TC_PAUSE, TC_AUTOFIRE, TC_AIMASSIST, TC_SWAP, TC_NONE,
  contrastRatio, edgeContrast, lightStrokeContrast, worstEdgeContrast, TOUCH_EDGE,
  TouchRouter, readoutRect, FIRE_SLIDE_GAIN, READOUT_MARGIN, READOUT_CLEARANCE,
  type TouchGeom, type Disc, type Rect,
  type TouchSink, type TouchAimSource, type TouchAimTarget,
} from './touch';
import { InputAction } from '@shared/constants';

/* ------------------------------------------------------------------------ *
 * Stick
 * ------------------------------------------------------------------------ */

describe('resolveStick', () => {
  const cfg = DEFAULT_STICK;
  const s = createStickSample();

  it('is dead at the centre', () => {
    resolveStick(0, 0, cfg, s);
    expect(s.magnitude).toBe(0);
    expect(s.live).toBe(false);
  });

  it('reads zero inside the dead zone but not just outside it', () => {
    resolveStick(cfg.radius * cfg.deadZone * 0.9, 0, cfg, s);
    expect(s.magnitude).toBe(0);
    expect(s.live).toBe(false);
    resolveStick(cfg.radius * (cfg.deadZone + 0.02), 0, cfg, s);
    expect(s.live).toBe(true);
    expect(s.magnitude).toBeGreaterThan(0);
  });

  it('leaves the dead zone continuously — no jump to a finite speed', () => {
    // The classic bad stick snaps from 0 to deadZone-worth of speed. Sample
    // just past the edge and the magnitude must still be tiny.
    resolveStick(cfg.radius * (cfg.deadZone + 0.001), 0, cfg, s);
    expect(s.magnitude).toBeLessThan(0.01);
  });

  it('saturates at the radius and never past it', () => {
    resolveStick(cfg.radius * 4, 0, cfg, s);
    expect(s.magnitude).toBeCloseTo(1, 6);
    expect(s.travel).toBeCloseTo(1, 6);
    expect(Math.hypot(s.knobX, s.knobY)).toBeCloseTo(cfg.radius, 6);
    expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('maps screen-up to forward', () => {
    resolveStick(0, -cfg.radius, cfg, s);
    expect(s.z).toBeGreaterThan(0.9);
    resolveStick(0, cfg.radius, cfg, s);
    expect(s.z).toBeLessThan(-0.9);
    resolveStick(cfg.radius, 0, cfg, s);
    expect(s.x).toBeGreaterThan(0.9);
  });

  it('latches sprint only at the detent — the bar has no such gesture', () => {
    resolveStick(cfg.radius * (cfg.detent - 0.05), 0, cfg, s);
    expect(s.sprint).toBe(false);
    resolveStick(cfg.radius * cfg.detent, 0, cfg, s);
    expect(s.sprint).toBe(true);
  });

  it('is monotonic in deflection', () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      resolveStick(cfg.radius * t, 0, cfg, s);
      expect(s.magnitude).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = s.magnitude;
    }
  });
});

describe('ThumbStick', () => {
  it('floats to the press point and keeps the ring on screen', () => {
    const st = new ThumbStick();
    st.setHome(90, 800, 40, 700, 200, 880);
    st.begin(1, 10, 950);            // corner press, outside the bounds box
    // The ring slides inboard so it is still drawable...
    expect(st.ringX).toBe(40);
    expect(st.ringY).toBe(880);
    // ...but the origin stays under the finger, so landing there does NOT
    // immediately sprint the player into the corner.
    expect(st.originX).toBe(10);
    expect(st.originY).toBe(950);
    expect(st.sample.magnitude).toBe(0);
    expect(st.sample.live).toBe(false);
  });

  it('releases back to home and zeroes the sample', () => {
    const st = new ThumbStick();
    st.setHome(90, 800, 40, 700, 200, 880);
    st.begin(1, 90, 800);
    st.move(90 + st.config.radius, 800);
    expect(st.sample.x).toBeGreaterThan(0.9);
    st.end();
    expect(st.active).toBe(false);
    expect(st.sample.x).toBe(0);
    expect(st.originX).toBe(90);
  });
});

/* ------------------------------------------------------------------------ *
 * Tap vs drag  (the bar makes these the same gesture)
 * ------------------------------------------------------------------------ */

describe('DragTracker', () => {
  it('calls a short still press a tap', () => {
    const d = new DragTracker();
    d.begin(1, 200, 200, 1000);
    d.move(203, 201);
    expect(d.end(1080)).toBe(true);
  });

  it('does not call an aiming drag a tap', () => {
    const d = new DragTracker();
    d.begin(1, 200, 200, 1000);
    for (let i = 1; i <= 10; i++) d.move(200 + i * 4, 200);
    expect(d.end(1080)).toBe(false);
  });

  it('does not call a long still press a tap', () => {
    const d = new DragTracker();
    d.begin(1, 200, 200, 1000);
    expect(d.end(1000 + DragTrackerMaxMs() + 1)).toBe(false);
  });
});

function DragTrackerMaxMs(): number { return 240; }

/* ------------------------------------------------------------------------ *
 * Fire pad — the control the bar simply does not have
 * ------------------------------------------------------------------------ */

describe('FirePad', () => {
  it('holds a single-frame tap long enough to actually fire', () => {
    const p = new FirePad();
    p.begin(1, 300, 300, 1000);
    expect(p.firing).toBe(true);
    p.end(1002);                      // released 2 ms later, inside one frame
    expect(p.firing).toBe(true);      // still held
    p.tick(1050);
    expect(p.firing).toBe(true);
    p.tick(1090);
    expect(p.firing).toBe(false);
  });

  it('produces no look delta until the finger has really slid', () => {
    const p = new FirePad();
    p.begin(1, 300, 300, 0);
    expect(p.move(303, 300)).toBe(false);
    expect(p.dx).toBe(0);
    expect(p.aiming).toBe(false);
  });

  it('keeps the trigger held while the same thumb starts aiming', () => {
    const p = new FirePad();
    p.begin(1, 300, 300, 0);
    p.move(330, 300);                 // past the slide threshold
    expect(p.aiming).toBe(true);
    expect(p.firing).toBe(true);
    expect(p.dx).toBe(0);             // the threshold itself is swallowed
    p.move(350, 306);
    expect(p.dx).toBe(20);
    expect(p.dy).toBe(6);
    expect(p.firing).toBe(true);
  });

  it('drops the trigger on cancel, immediately', () => {
    const p = new FirePad();
    p.begin(1, 300, 300, 0);
    p.cancel();
    expect(p.firing).toBe(false);
    p.tick(10_000);
    expect(p.firing).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Aim assist
 * ------------------------------------------------------------------------ */

describe('aimAssist', () => {
  const cfg = DEFAULT_AIM_ASSIST;
  const out = createAimAssistOut();

  it('is completely inert outside the cone', () => {
    const ok = aimAssist(cfg.cone * 1.01, 0, 12, 30, 1 / 60, cfg, out);
    expect(ok).toBe(false);
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
    expect(out.friction).toBe(1);
  });

  it('is inert outside its range window at both ends', () => {
    expect(aimAssist(0.01, 0, cfg.minRange * 0.5, 30, 1 / 60, cfg, out)).toBe(false);
    expect(aimAssist(0.01, 0, cfg.maxRange + 1, 30, 1 / 60, cfg, out)).toBe(false);
    expect(assistRangeWeight(cfg.maxRange * 0.5, cfg)).toBeCloseTo(1, 6);
  });

  it('slows the look and pulls toward the target inside the cone', () => {
    const err = cfg.cone * 0.2;
    const ok = aimAssist(err, 0, 12, 30, 1 / 60, cfg, out);
    expect(ok).toBe(true);
    expect(out.friction).toBeLessThan(1);
    expect(out.friction).toBeGreaterThanOrEqual(1 - cfg.friction);
    expect(out.yaw).toBeGreaterThan(0);
    expect(out.yaw).toBeLessThanOrEqual(err);   // never past the target
  });

  it('never overshoots however long the step', () => {
    for (const dt of [1 / 60, 1 / 15, 0.5, 4]) {
      for (const err of [1e-6, 0.001, cfg.cone * 0.5, cfg.cone * 0.99]) {
        aimAssist(err, 0, 12, 1000, dt, cfg, out);
        expect(Math.abs(out.yaw)).toBeLessThanOrEqual(Math.abs(err) + 1e-12);
      }
    }
  });

  it('is modest: at most 105 deg/s of pull, and much less when the thumb is still', () => {
    const dt = 1;
    const err = cfg.cone * 1e-4;
    aimAssist(err, 0, 12, 1e6, dt, cfg, out);   // saturated drag
    const maxRate = (cfg.idleRate + cfg.dragRate) / DEG2RAD;
    expect(maxRate).toBeLessThanOrEqual(105);
    // Thumb dead still: only the idle drift, which is a fifth of that.
    const still = createAimAssistOut();
    aimAssist(cfg.cone * 0.5, 0, 12, 0, dt, cfg, still);
    expect(Math.abs(still.yaw)).toBeLessThan(cfg.idleRate * dt + 1e-9);
  });

  it('pulls hardest at the centre of the cone and fades to nothing at its edge', () => {
    const a = createAimAssistOut();
    const b = createAimAssistOut();
    aimAssist(cfg.cone * 0.05, 0, 12, 30, 1, cfg, a);
    aimAssist(cfg.cone * 0.98, 0, 12, 30, 1, cfg, b);
    expect(a.engaged).toBeGreaterThan(b.engaged);
    expect(b.engaged).toBeLessThan(0.05);
  });
});

/* ------------------------------------------------------------------------ *
 * Auto-fire
 * ------------------------------------------------------------------------ */

describe('AutoFire', () => {
  it('is off unless asked for', () => {
    const a = new AutoFire();
    expect(a.enabled).toBe(false);
    expect(a.update(true, 0, 5, true, 0)).toBe(false);
  });

  it('locks inside the lock angle and releases only past the wider release angle', () => {
    const a = new AutoFire();
    a.enabled = true;
    expect(a.update(true, DEFAULT_AUTO_FIRE.lock * 0.5, 10, true, 0)).toBe(true);
    // Between lock and release it must NOT chatter off.
    const between = (DEFAULT_AUTO_FIRE.lock + DEFAULT_AUTO_FIRE.release) / 2;
    expect(a.update(true, between, 10, true, 10)).toBe(true);
    // Past release, and past the hold, it lets go.
    a.update(true, DEFAULT_AUTO_FIRE.release * 2, 10, true, 20);
    expect(a.update(true, DEFAULT_AUTO_FIRE.release * 2, 10, true,
      20 + DEFAULT_AUTO_FIRE.holdMs + 1)).toBe(false);
  });

  it('never burns ammo into a wall or at nothing', () => {
    const a = new AutoFire();
    a.enabled = true;
    expect(a.update(true, 0, 10, false, 0)).toBe(false);
    expect(a.update(false, 0, 10, true, 0)).toBe(false);
    expect(a.update(true, 0, DEFAULT_AUTO_FIRE.maxRange + 1, true, 0)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------------ */

/** The viewports the layout has to survive, smallest first. */
const VIEWPORTS: Array<[number, number, string]> = [
  [412, 915, 'Pixel 7 portrait — the spec viewport'],
  [915, 412, 'Pixel 7 landscape — the bar\'s own mobile viewport'],
  [360, 640, 'small Android portrait'],
  [640, 360, 'small Android landscape'],
  [390, 844, 'iPhone 14 portrait'],
  [844, 390, 'iPhone 14 landscape'],
  [768, 1024, 'tablet portrait'],
  [1024, 768, 'tablet landscape'],
];

function overlap(a: Disc, b: Disc): number {
  return (a.r + b.r) - Math.hypot(a.x - b.x, a.y - b.y);
}

describe('solveTouchLayout', () => {
  const g = createTouchGeom();

  for (const [vw, vh, label] of VIEWPORTS) {
    describe(`${vw}x${vh} — ${label}`, () => {
      for (const southpaw of [false, true]) {
        it(`${southpaw ? 'southpaw' : 'right-handed'}: no control overlaps another`, () => {
          solveTouchLayout(vw, vh, { southpaw }, g);
          const discs = touchDiscs(g);
          for (let i = 0; i < discs.length; i++) {
            for (let j = i + 1; j < discs.length; j++) {
              const o = overlap(discs[i], discs[j]);
              expect(o, `disc ${i} vs ${j} overlaps by ${o.toFixed(1)}px`).toBeLessThanOrEqual(0);
            }
          }
        });

        it(`${southpaw ? 'southpaw' : 'right-handed'}: every control is on screen`, () => {
          solveTouchLayout(vw, vh, { southpaw }, g);
          for (const d of touchDiscs(g)) {
            expect(d.x - d.r).toBeGreaterThanOrEqual(0);
            expect(d.y - d.r).toBeGreaterThanOrEqual(0);
            expect(d.x + d.r).toBeLessThanOrEqual(vw);
            expect(d.y + d.r).toBeLessThanOrEqual(vh);
          }
          // and the stick can never be flung off the edge either
          expect(g.stickBounds.x0 - g.stickHome.r).toBeGreaterThanOrEqual(-g.stickHome.r * 0.35);
          expect(g.stickBounds.x1).toBeLessThanOrEqual(vw);
          expect(g.stickBounds.y1).toBeLessThanOrEqual(vh);
        });
      }

      it('every target clears the 44px minimum, and the trigger is far bigger', () => {
        solveTouchLayout(vw, vh, {}, g);
        for (const d of touchDiscs(g)) {
          expect(d.r * 2).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
        }
        // The bar's glyph buttons are ~40px. Ours are never smaller than that
        // and the fire pad is more than double.
        expect(g.fire.r * 2).toBeGreaterThanOrEqual(84);
      });

      it('the stick zone contains the stick and no right-hand control', () => {
        solveTouchLayout(vw, vh, {}, g);
        const z = g.stickZone;
        expect(g.stickHome.x).toBeGreaterThanOrEqual(z.x0);
        expect(g.stickHome.x).toBeLessThanOrEqual(z.x1);
        expect(g.stickHome.y).toBeGreaterThanOrEqual(z.y0);
        for (const d of [g.fire, g.jump, g.crouch, g.pause, g.autoFire, g.aimAssist]) {
          const inside = d.x + d.r > z.x0 && d.x - d.r < z.x1
            && d.y + d.r > z.y0 && d.y - d.r < z.y1;
          expect(inside, 'a right-hand control leaks into the stick zone').toBe(false);
        }
      });

      it('reserves an honest read-out band — the HUD is told where the thumbs are', () => {
        solveTouchLayout(vw, vh, {}, g);
        // Both bands are real, and neither swallows the viewport.
        expect(g.padBottomLeft).toBeGreaterThan(0);
        expect(g.padBottomRight).toBeGreaterThan(0);
        expect(g.padBottomLeft).toBeLessThan(vh * 0.55);
        expect(g.padBottomRight).toBeLessThan(vh * 0.55);
        // Nothing the thumbs own may poke above the band it declared.
        const leftDiscs = g.stickHome.x < vw / 2
          ? [g.stickHome] : [g.fire, g.jump, g.crouch];
        for (const d of leftDiscs) {
          expect(vh - (d.y - d.r)).toBeLessThanOrEqual(g.padBottomLeft + 0.001);
        }
      });
    });
  }

  it('mirrors cleanly for a left-handed player', () => {
    const r = createTouchGeom();
    const l = createTouchGeom();
    solveTouchLayout(412, 915, { southpaw: false }, r);
    solveTouchLayout(412, 915, { southpaw: true }, l);
    expect(l.stickHome.x).toBeCloseTo(412 - r.stickHome.x, 6);
    expect(l.fire.x).toBeCloseTo(412 - r.fire.x, 6);
    expect(l.stickHome.x).toBeGreaterThan(412 / 2);
    expect(l.fire.x).toBeLessThan(412 / 2);
    expect(l.padBottomLeft).toBeCloseTo(r.padBottomRight, 6);
    expect(l.padBottomRight).toBeCloseTo(r.padBottomLeft, 6);
  });

  it('scales the controls without breaking the layout', () => {
    const g2 = createTouchGeom();
    for (const scale of [0.8, 1, 1.2, 1.4]) {
      solveTouchLayout(412, 915, { scale }, g2);
      const discs = touchDiscs(g2);
      for (let i = 0; i < discs.length; i++) {
        for (let j = i + 1; j < discs.length; j++) {
          expect(overlap(discs[i], discs[j]), `scale ${scale}`).toBeLessThanOrEqual(0);
        }
        expect(discs[i].x - discs[i].r).toBeGreaterThanOrEqual(0);
        expect(discs[i].y + discs[i].r).toBeLessThanOrEqual(915);
      }
    }
  });

  /* ---------------------------------------------------------------------- *
   * The attack pad
   *
   * The one control the bar does not have at all, pinned to the pixel. Its
   * mobile capture puts three ~44 px movement glyphs down the right edge and a
   * near-invisible dig glyph beside them, and leaves the bottom-right corner —
   * where a right thumb actually rests — as bare world geometry. These are the
   * assertions that stop us ever drifting into the same shape.
   * ---------------------------------------------------------------------- */
  it('parks a big attack pad exactly where a right thumb rests', () => {
    const g2 = createTouchGeom();
    solveTouchLayout(915, 412, {}, g2);

    // Bottom-right quadrant, inside the arc a thumb sweeps from the corner.
    expect(g2.fire.x).toBeGreaterThan(915 * 0.82);
    expect(g2.fire.y).toBeGreaterThan(412 * 0.68);
    expect(Math.hypot(915 - g2.fire.x, 412 - g2.fire.y)).toBeLessThan(140);

    // Big enough to hit without looking, and it IS the trigger that answers.
    expect(g2.fire.r * 2).toBeGreaterThanOrEqual(MIN_ATTACK_PAD_D);
    expect(g2.fire.r * 2).toBeLessThanOrEqual(128);
    expect(hitTest(g2, 840, 340)).toBe(TC_FIRE);

    // And it is the largest button on the screen by a clear margin — no other
    // verb may ever read as the primary one.
    for (const d of touchDiscs(g2)) {
      if (d === g2.fire || d === g2.stickHome) continue;
      expect(g2.fire.r).toBeGreaterThan(d.r * 1.6);
    }
  });

  /* ----------------------------------------------------------------------
   * Reach — the number the trigger actually lives or dies by
   *
   * Size and contrast are necessary and not sufficient: a big, bright button
   * you have to regrip the phone to press is still a button you do not press
   * mid-fight. The bar's landscape capture is the worked example. Its only
   * attack affordance, the dig glyph, sits at (712, 262) on a 915x412 screen
   * while the right thumb pivots around (855, 400) — sixty px in from the
   * right edge, twelve up from the bottom — so its reach is 199 px, out past
   * every one of its own four movement glyphs. Ours has to beat that by a mile
   * at every viewport, both handednesses, and the whole control-size slider.
   * -------------------------------------------------------------------- */

  /** The bar's dig glyph and the thumb pivot, both read off its own capture. */
  const BAR_ATTACK = { x: 712, y: 262 };
  const BAR_PIVOT = { x: 855, y: 400 };
  const BAR_REACH = Math.hypot(BAR_ATTACK.x - BAR_PIVOT.x, BAR_ATTACK.y - BAR_PIVOT.y);

  it('measures the bar: its only attack control is 199px from the thumb', () => {
    expect(BAR_REACH).toBeGreaterThan(195);
    expect(BAR_REACH).toBeLessThan(203);
  });

  it('puts the trigger under the resting thumb, not across the screen', () => {
    const g2 = createTouchGeom();
    solveTouchLayout(915, 412, {}, g2);

    // The pivot the solver publishes is the one measured off the bar's frame.
    expect(g2.thumbPivot.x).toBeCloseTo(BAR_PIVOT.x, 6);
    expect(g2.thumbPivot.y).toBeCloseTo(BAR_PIVOT.y, 6);

    const reach = attackReach(g2);
    expect(reach).toBeLessThanOrEqual(MAX_ATTACK_REACH);
    // Not merely "within reach": the resting thumb is already ON the pad, so
    // the gesture is a press rather than a move-then-press.
    expect(reach).toBeLessThanOrEqual(g2.fire.r);
    expect(hitTest(g2, g2.thumbPivot.x, g2.thumbPivot.y, 0)).toBe(TC_FIRE);
    // And it is a rout, not a win on points.
    expect(reach * 3).toBeLessThan(BAR_REACH);
  });

  it('keeps that reach at every viewport, hand and control size', () => {
    const g2 = createTouchGeom();
    for (const [vw, vh, label] of VIEWPORTS) {
      for (const scale of [0.7, 0.85, 1, 1.2, 1.4]) {
        for (const southpaw of [false, true]) {
          solveTouchLayout(vw, vh, { scale, southpaw }, g2);
          const reach = attackReach(g2);
          const where = `${label} @${scale}${southpaw ? ' southpaw' : ''}`;
          expect(reach, where).toBeLessThanOrEqual(MAX_ATTACK_REACH);
          expect(g2.fire.r * 2, where).toBeGreaterThanOrEqual(70);
          expect(g2.fire.r * 2, where).toBeLessThanOrEqual(MAX_ATTACK_PAD_D);
          // The pivot is on the same side as the trigger, whichever hand.
          const nearRight = g2.thumbPivot.x > vw * 0.5;
          expect(nearRight, where).toBe(!southpaw);
          // A press at the pivot is a shot, always.
          expect(hitTest(g2, g2.thumbPivot.x, g2.thumbPivot.y, 0), where).toBe(TC_FIRE);
        }
      }
    }
  });

  it('keeps the pivot on the trigger through a notch and a home bar', () => {
    const g2 = createTouchGeom();
    solveTouchLayout(915, 412, { safeLeft: 44, safeRight: 44, safeBottom: 21 }, g2);
    expect(g2.thumbPivot.x).toBeCloseTo(915 - 44 - 60, 6);
    expect(g2.thumbPivot.y).toBeCloseTo(412 - 21 - 12, 6);
    expect(attackReach(g2)).toBeLessThanOrEqual(MAX_ATTACK_REACH);
    expect(hitTest(g2, g2.thumbPivot.x, g2.thumbPivot.y, 0)).toBe(TC_FIRE);
  });

  it('never lets the trigger shrink below the attack-pad floor', () => {
    // Every viewport in the sweep, and the whole control-size slider. A player
    // who shrinks the controls still has to be able to shoot; the movement
    // glyphs may get small, the trigger may not.
    const g2 = createTouchGeom();
    for (const [vw, vh] of VIEWPORTS) {
      for (const scale of [0.7, 0.85, 1, 1.2, 1.4]) {
        for (const southpaw of [false, true]) {
          solveTouchLayout(vw, vh, { scale, southpaw }, g2);
          expect(g2.fire.r * 2, `${vw}x${vh} @${scale}`)
            .toBeGreaterThanOrEqual(MIN_ATTACK_PAD_D);
          const discs = touchDiscs(g2);
          for (let i = 0; i < discs.length; i++) {
            expect(discs[i].x - discs[i].r).toBeGreaterThanOrEqual(0);
            expect(discs[i].y - discs[i].r).toBeGreaterThanOrEqual(0);
            expect(discs[i].x + discs[i].r).toBeLessThanOrEqual(vw);
            expect(discs[i].y + discs[i].r).toBeLessThanOrEqual(vh);
            for (let j = i + 1; j < discs.length; j++) {
              expect(overlap(discs[i], discs[j]),
                `${vw}x${vh} @${scale}: disc ${i} vs ${j}`).toBeLessThanOrEqual(0);
            }
          }
        }
      }
    }
  });

  it('honours safe-area insets', () => {
    const g2 = createTouchGeom();
    solveTouchLayout(915, 412, { safeLeft: 44, safeRight: 44, safeBottom: 21 }, g2);
    expect(g2.stickHome.x - g2.stickHome.r).toBeGreaterThanOrEqual(44);
    expect(g2.fire.x + g2.fire.r).toBeLessThanOrEqual(915 - 44);
    expect(g2.fire.y + g2.fire.r).toBeLessThanOrEqual(412 - 21);
  });
});

/* ------------------------------------------------------------------------ *
 * The corner read-outs — weakness #11, and the version of it we committed
 * ourselves
 *
 * The bar ships its desktop HUD to a 412 px-tall screen. We re-laid ours out
 * around the thumbs and then made the same mistake by a different route: the
 * ammo plate was pinned above the FULL height of the trigger cluster, which
 * includes an inboard glyph column that is nowhere near the corner the plate
 * sits in. On the bar's own 915x412 viewport that floated the plate 205 px up
 * — half the screen — with nothing underneath it.
 *
 * `padEdge*` is the band measured against the outer column only, and
 * `readoutWidth*` is the width that band is honest for. The pair is only worth
 * anything if it is actually disjoint from the controls, so that is what gets
 * asserted, across every viewport, both hands and the whole size slider.
 * ------------------------------------------------------------------------ */

/** Overlap depth of a disc and an axis-aligned box, px. Positive means a hit. */
function discRectOverlap(d: Disc, r: Rect): number {
  const cx = Math.max(r.x0, Math.min(d.x, r.x1));
  const cy = Math.max(r.y0, Math.min(d.y, r.y1));
  return d.r - Math.hypot(d.x - cx, d.y - cy);
}

describe('corner read-outs', () => {
  const g = createTouchGeom();
  const box: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  /** A phone ammo plate: 26px numeral, round strip, weapon line, padding. */
  const PLATE_H = 80;

  for (const [vw, vh, label] of VIEWPORTS) {
    for (const southpaw of [false, true]) {
      for (const scale of [0.7, 1, 1.4]) {
        const hand = southpaw ? 'southpaw' : 'right-handed';
        it(`${vw}x${vh} ${hand} @${scale}x: neither plate lands on a control`, () => {
          solveTouchLayout(vw, vh, { southpaw, scale }, g);
          for (const side of [0, 1] as Array<0 | 1>) {
            readoutRect(g, side, PLATE_H, box);
            expect(box.x0, 'a read-out starts off the left edge').toBeGreaterThanOrEqual(0);
            expect(box.x1, 'a read-out runs off the right edge').toBeLessThanOrEqual(vw);
            expect(box.y0, 'a read-out is pushed off the top').toBeGreaterThanOrEqual(0);
            for (const d of touchDiscs(g)) {
              const over = discRectOverlap(d, box);
              expect(over, `${vw}x${vh} ${hand} @${scale}x: side ${side} plate sits `
                + `${over.toFixed(1)}px into the control at `
                + `(${d.x.toFixed(0)},${d.y.toFixed(0)})`).toBeLessThanOrEqual(0);
            }
          }
        });

        it(`${vw}x${vh} ${hand} @${scale}x: the two plates never meet`, () => {
          solveTouchLayout(vw, vh, { southpaw, scale }, g);
          const a: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
          const b: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
          readoutRect(g, 0, PLATE_H, a);
          readoutRect(g, 1, PLATE_H, b);
          const apart = a.x1 <= b.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
          expect(apart, `${vw}x${vh} ${hand} @${scale}x: the vitals and the ammo `
            + `plate are printed on top of each other`).toBe(true);
        });
      }
    }
  }

  it('lifts the ammo plate off the floor without floating it up the screen', () => {
    // The number the fix exists for. 915x412 is the bar's own mobile viewport.
    solveTouchLayout(915, 412, {}, g);
    expect(g.padBottomRight).toBeGreaterThan(190);      // the full cluster is tall
    expect(g.padEdgeRight).toBeLessThan(g.padBottomRight - 50);
    // …and the plate now sits in the bottom third, which is what "corner
    // read-out" has to mean on a 412 px-tall screen.
    expect(g.padEdgeRight + READOUT_CLEARANCE).toBeLessThan(412 * 0.4);
    // The band still clears the trigger and the primary glyph column.
    for (const d of [g.fire, g.jump, g.crouch]) {
      expect(412 - (d.y - d.r)).toBeLessThanOrEqual(g.padEdgeRight + 1e-6);
    }
  });

  it('mirrors the bands and the widths with the hand', () => {
    const r = createTouchGeom();
    const l = createTouchGeom();
    solveTouchLayout(915, 412, { southpaw: false }, r);
    solveTouchLayout(915, 412, { southpaw: true }, l);
    expect(l.padEdgeLeft).toBeCloseTo(r.padEdgeRight, 6);
    expect(l.padEdgeRight).toBeCloseTo(r.padEdgeLeft, 6);
    expect(l.readoutWidthLeft).toBeCloseTo(r.readoutWidthRight, 6);
    expect(l.readoutWidthRight).toBeCloseTo(r.readoutWidthLeft, 6);
  });

  it('always leaves a read-out at least one touch target wide', () => {
    for (const [vw, vh] of VIEWPORTS) {
      solveTouchLayout(vw, vh, {}, g);
      expect(g.readoutWidthLeft).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(g.readoutWidthRight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(READOUT_MARGIN).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The sprint detent, drawn
 * ------------------------------------------------------------------------ */

describe('the sprint detent is a control, not a secret', () => {
  const g = createTouchGeom();

  it('publishes the exact radius the maths latches on', () => {
    for (const [vw, vh] of VIEWPORTS) {
      solveTouchLayout(vw, vh, {}, g);
      const cfg = { ...DEFAULT_STICK, radius: g.stickTravel };
      const s = createStickSample();
      // One pixel inside the drawn ring: walking. On it: running. If the ring
      // and the latch could drift apart, the drawn threshold would be a lie.
      resolveStick(g.detentR - 1, 0, cfg, s);
      expect(s.sprint, `${vw}x${vh} sprints before the drawn ring`).toBe(false);
      resolveStick(g.detentR, 0, cfg, s);
      expect(s.sprint, `${vw}x${vh} does not sprint at the drawn ring`).toBe(true);
    }
  });

  it('draws the ring inside the base and outside the dead zone', () => {
    for (const [vw, vh] of VIEWPORTS) {
      solveTouchLayout(vw, vh, {}, g);
      expect(g.detentR).toBeGreaterThan(g.deadR);
      expect(g.detentR).toBeLessThanOrEqual(g.stickTravel);
      expect(g.detentR).toBeLessThan(g.stickHome.r);
    }
  });

  it('follows the dead-zone slider without ever crossing it', () => {
    solveTouchLayout(412, 915, { deadZone: 0.4 }, g);
    expect(g.deadR).toBeCloseTo(g.stickTravel * 0.4, 6);
    expect(g.detentR).toBeGreaterThan(g.deadR);
  });
});

/* ------------------------------------------------------------------------ *
 * The floating stick actually floats
 * ------------------------------------------------------------------------ */

describe('the stick grab zone', () => {
  const g = createTouchGeom();

  it('gives a thumb that lands short of the stick real headroom', () => {
    // The point of a floating origin is that you do not have to find the puck.
    // The zone used to be cut off just under the utility row on a portrait
    // phone — 2px of headroom above the drawn base at 412x915 — so a thumb that
    // landed a centimetre high became a look-drag, i.e. the player looked at
    // the sky instead of backing out of a fight.
    for (const [vw, vh, label] of VIEWPORTS) {
      solveTouchLayout(vw, vh, {}, g);
      const stickTop = g.stickHome.y - g.stickHome.r;
      const headroom = stickTop - g.stickZone.y0;
      expect(headroom, `${label}: only ${headroom.toFixed(1)}px above the stick`)
        .toBeGreaterThanOrEqual(g.stickHome.r * 0.45);
    }
  });

  it('still hands a press on a utility glyph to the glyph, not the stick', () => {
    // Which is why the headroom is safe: `hitTest` resolves buttons first, so
    // the zone is allowed to run underneath the utility row.
    solveTouchLayout(412, 915, {}, g);
    for (const d of [g.reload, g.build, g.swap]) {
      expect(hitTest(g, d.x, d.y)).not.toBe(TC_STICK);
    }
    // And the gaps between those glyphs are covered by their own slop rather
    // than leaking to the stick: neighbouring chips are 2r+10 apart with r+6
    // of reach each, so 12 > 10 and there is no seam.
    const midpoint = (g.reload.x + g.build.x) * 0.5;
    expect(hitTest(g, midpoint, g.reload.y)).not.toBe(TC_STICK);
  });

  it('floats the origin to a thumb that lands above the drawn base', () => {
    const sink = new FakeSink();
    const r = new TouchRouter(sink);
    const g2 = r.resize(412, 915, {});
    // Four pixels inside the top of the zone — 78 px above the drawn base, and
    // outboard of the utility row, which owns its own presses.
    const y = g2.stickZone.y0 + 4;
    expect(y).toBeLessThan(g2.stickHome.y - g2.stickHome.r - 40);
    expect(hitTest(g2, 30, y)).toBe(TC_STICK);
    expect(r.down(1, 30, y, 0)).toBe(TC_STICK);
    // A press is zero deflection wherever it lands — it must not lurch.
    expect(sink.moveX).toBe(0);
    expect(sink.moveZ).toBe(0);
    r.move(1, 30, y - g2.stickTravel);
    expect(sink.moveZ).toBeGreaterThan(0.8);
  });
});

/* ------------------------------------------------------------------------ *
 * Slide-off gain
 * ------------------------------------------------------------------------ */

describe('slide-off aiming has the travel it needs', () => {
  it('turns further per pixel from the trigger than from the look surface', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;

    // The measurement the gain exists for: the trigger's centre is a fraction
    // of the look surface's width from the edge it has to drag towards.
    const rightRoom = 915 - g.fire.x;
    expect(rightRoom).toBeLessThan(g.stickZone.x1 * 0.25);

    expect(hitTest(g, 400, 100)).toBe(TC_LOOK);
    r.down(1, 400, 100, 0);            // look surface
    sink.clearLook();
    r.move(1, 460, 100);
    const lookDx = sink.lookDx;

    r.up(1, 500);
    r.down(2, g.fire.x, g.fire.y, 600);
    r.move(2, g.fire.x - 20, g.fire.y);   // past the slide threshold, swallowed
    sink.clearLook();
    r.move(2, g.fire.x - 80, g.fire.y);
    const slideDx = Math.abs(sink.lookDx);

    expect(lookDx).toBeCloseTo(60, 6);
    expect(slideDx).toBeCloseTo(60 * FIRE_SLIDE_GAIN, 6);
    // Modest: it is a nudge, not a second sensitivity setting.
    expect(FIRE_SLIDE_GAIN).toBeGreaterThan(1);
    expect(FIRE_SLIDE_GAIN).toBeLessThan(2);
  });

  it('still fires while it does it', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;
    r.down(1, g.fire.x, g.fire.y, 0);
    r.move(1, g.fire.x - 90, g.fire.y - 30);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
    expect(r.firePad.aiming).toBe(true);
  });
});

describe('hitTest', () => {
  const g = createTouchGeom();

  it('routes every control centre to itself', () => {
    solveTouchLayout(412, 915, {}, g);
    expect(hitTest(g, g.fire.x, g.fire.y)).toBe(TC_FIRE);
    expect(hitTest(g, g.jump.x, g.jump.y)).toBe(TC_JUMP);
    expect(hitTest(g, g.crouch.x, g.crouch.y)).toBe(TC_CROUCH);
    expect(hitTest(g, g.reload.x, g.reload.y)).toBe(TC_RELOAD);
    expect(hitTest(g, g.build.x, g.build.y)).toBe(TC_BUILD);
    expect(hitTest(g, g.pause.x, g.pause.y)).toBe(TC_PAUSE);
    expect(hitTest(g, g.autoFire.x, g.autoFire.y)).toBe(TC_AUTOFIRE);
    expect(hitTest(g, g.aimAssist.x, g.aimAssist.y)).toBe(TC_AIMASSIST);
    expect(hitTest(g, g.stickHome.x, g.stickHome.y)).toBe(TC_STICK);
  });

  it('gives the middle of the screen to look, not to a button', () => {
    solveTouchLayout(915, 412, {}, g);
    expect(hitTest(g, 915 * 0.5, 412 * 0.35)).toBe(TC_LOOK);
    expect(hitTest(g, 915 * 0.72, 412 * 0.2)).toBe(TC_LOOK);
  });

  it('never returns two different controls for one point', () => {
    // Exhaustive over a 4px grid: hitTest is a function, so this only fails
    // if the discs overlap — which is exactly the regression to catch.
    for (const [vw, vh] of VIEWPORTS) {
      solveTouchLayout(vw, vh, {}, g);
      const discs = touchDiscs(g);
      for (let y = 0; y < vh; y += 4) {
        for (let x = 0; x < vw; x += 4) {
          let n = 0;
          for (const d of discs) {
            if (Math.hypot(x - d.x, y - d.y) <= d.r) n++;
          }
          expect(n, `${vw}x${vh} at ${x},${y} is inside ${n} controls`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Contrast — weakness #10, as a measurement
 * ------------------------------------------------------------------------ */

/**
 * Pixels read straight out of ref/voxiom/mobileland-08-combat.png by sampling
 * annuli around the bar's joystick at (148.3, 248.3), excluding the tree
 * trunks so the comparison is against the grass it actually sits on.
 */
const BAR = {
  ringInside: [116, 126, 97] as const,   // its base disc, just inside the edge
  ringOutside: [101, 112, 69] as const,  // grass, just outside the edge
  knob: [178, 178, 178] as const,
};

/**
 * The bar's four glyph buttons, each as (fill, backdrop). Sampled off the same
 * capture by averaging the annulus r=14..20 inside each glyph and r=30..36
 * outside it, so "fill" is the button's own wash and "backdrop" is the world
 * immediately around it — the two colours whose ratio IS the button's edge.
 *
 * The pair matters because it kills the obvious rebuttal, "it is only
 * low-contrast because the terrain is bright". Two of these four sit on a dark
 * tree trunk and they are no better: an unstroked translucent fill takes its
 * luminance from whatever is behind it, so it can never separate from it.
 */
const BAR_GLYPHS: Array<[readonly [number, number, number],
  readonly [number, number, number], string]> = [
  [[141, 140, 106], [116, 118, 81], 'dig — its only attack control, on grass'],
  [[129, 134, 96], [107, 114, 59], 'crouch, on grass'],
  [[87, 73, 65], [54, 35, 24], 'sprint, on a dark tree trunk'],
  [[83, 75, 65], [65, 58, 33], 'jump, on a dark tree trunk'],
];

/** Backgrounds a control has to survive, from the two captured bars. */
const BACKGROUNDS: Array<[number, number, number, string]> = [
  [101, 112, 69, 'voxiom grass'],
  [160, 151, 128, 'voxiom sand/sky, brightest 5%'],
  [110, 160, 210, 'sky blue'],
  [196, 120, 86, 'doomcraft brick'],
  [232, 228, 220, 'blown-out highlight'],
  [20, 18, 26, 'dark corridor'],
];

describe('control contrast', () => {
  it('measures the bar: its stick ring is invisible and its knob is under WCAG', () => {
    const ring = contrastRatio(...BAR.ringInside, ...BAR.ringOutside);
    const knob = contrastRatio(...BAR.knob, ...BAR.ringOutside);
    expect(ring).toBeLessThan(1.3);      // 1.24:1 — you cannot see it
    expect(knob).toBeLessThan(3);        // 2.39:1 — under the 3:1 floor
  });

  it('beats it on every background sampled from either capture', () => {
    const barRing = contrastRatio(...BAR.ringInside, ...BAR.ringOutside);
    for (const [r, g, b, name] of BACKGROUNDS) {
      const ours = edgeContrast(r, g, b);
      expect(ours, name).toBeGreaterThanOrEqual(3);
      expect(ours / barRing, name).toBeGreaterThan(2.5);
    }
  });

  it('measures every one of the bar\'s buttons, bright backdrop and dark', () => {
    // Not one of the four clears 1.8:1, and the dark-backdrop pair is no better
    // than the bright one. This is what an unstroked translucent fill buys.
    for (const [fill, bg, name] of BAR_GLYPHS) {
      const edge = contrastRatio(...fill, ...bg);
      expect(edge, name).toBeLessThan(1.8);
    }
  });

  it('beats every one of them on its own backdrop, with the white stroke alone', () => {
    // The strong form of the claim: on each of those four backdrops, our LIGHT
    // stroke on its own — no help from the dark halo — clears the 3:1 WCAG
    // floor for a non-text control, and beats that button's own edge by 3x.
    // It can only be stated because the stroke is fully opaque: white sits at
    // L = 1.0 no matter what is behind it.
    for (const [fill, bg, name] of BAR_GLYPHS) {
      const theirs = contrastRatio(...fill, ...bg);
      const ours = lightStrokeContrast(...bg);
      expect(ours, name).toBeGreaterThanOrEqual(3);
      expect(ours / theirs, name).toBeGreaterThan(3);
    }
    // The exact figure the work order asked for, on the brightest grass any of
    // the bar's controls sits on: a fully opaque white ring reads 5.13:1.
    expect(lightStrokeContrast(107, 114, 59)).toBeGreaterThan(5.1);
  });

  it('strokes in fully opaque ink, so the terrain cannot dilute the boundary', () => {
    // The palette is the claim. A stroke at 96% alpha is 4% terrain, and 4% of
    // a sunlit cliff is the difference between a guarantee and an average.
    expect(TOUCH_EDGE.lightA).toBe(1);
    expect(TOUCH_EDGE.darkA).toBe(1);
  });

  it('is provably visible on ANY background, not just the sampled ones', () => {
    // A single-tone outline always has a background that kills it. A light+dark
    // pair does not, and with opaque ink the floor is exactly the luminance
    // where white and black are equally bad: (L+0.05)^2 = 1.05*0.05, i.e.
    // L = 0.1791, giving 0.2291/0.05 = 4.583:1. Nothing in the cube is worse.
    const worst = worstEdgeContrast(TOUCH_EDGE, 17);
    expect(worst).toBeGreaterThanOrEqual(4.55);
    expect(worst).toBeLessThanOrEqual(4.59);
    // Opaque is strictly better than the 0.96/0.90 pair this replaced.
    const translucent = { ...TOUCH_EDGE, lightA: 0.96, darkA: 0.9 };
    expect(worst).toBeGreaterThan(worstEdgeContrast(translucent, 17));
  });

  it('shows why a single-tone outline is not good enough', () => {
    const whiteOnly = { ...TOUCH_EDGE, darkR: 255, darkG: 255, darkB: 255, darkA: 0.96 };
    expect(worstEdgeContrast(whiteOnly, 17)).toBeLessThan(1.4);
  });
});

/* ------------------------------------------------------------------------ *
 * Router — the two-thumb firefight, replayed in node
 *
 * This is the section that answers the question the piece is judged on: can
 * you actually aim and shoot, one thumb per side? The bar cannot, because it
 * has no fire button and its right thumb's one gesture has to mean both.
 * ------------------------------------------------------------------------ */

class FakeSink implements TouchSink {
  moveX = 0;
  moveZ = 0;
  lookDx = 0;
  lookDy = 0;
  readonly down = new Set<InputAction>();
  readonly taps: InputAction[] = [];
  resets = 0;

  setMove(x: number, z: number): void { this.moveX = x; this.moveZ = z; }
  addLook(dx: number, dy: number): void { this.lookDx += dx; this.lookDy += dy; }
  setButton(a: InputAction, d: boolean): void { if (d) this.down.add(a); else this.down.delete(a); }
  tap(a: InputAction): void { this.taps.push(a); }
  reset(): void { this.resets++; }

  clearLook(): void { this.lookDx = 0; this.lookDy = 0; }
}

/** A target dead ahead at 10 m with a clear line to it, unless told otherwise. */
class FakeAim implements TouchAimSource {
  has = true;
  yaw = 0;
  pitch = 0;
  dist = 10;
  clearance = 24;
  pulls = 0;
  totalYaw = 0;

  nearestEnemyAim(out: TouchAimTarget): boolean {
    if (!this.has) return false;
    out.yaw = this.yaw; out.pitch = this.pitch; out.dist = this.dist;
    return true;
  }
  viewClearance(): number { return this.clearance; }
  addLookRadians(yaw: number, pitch: number): void {
    this.pulls++;
    this.totalYaw += yaw;
    void pitch;
  }
}

/** 915x412 — the bar's own mobile viewport, so the comparison is like for like. */
function landscapeRouter(sink: FakeSink, southpaw = false): TouchRouter {
  const r = new TouchRouter(sink);
  r.resize(915, 412, { southpaw });
  return r;
}

describe('TouchRouter: one thumb per side', () => {
  it('drives the stick and the trigger from two fingers at once', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;

    // Left thumb lands in the stick zone and pushes forward-left.
    expect(r.down(1, g.stickHome.x, g.stickHome.y, 0)).toBe(TC_STICK);
    r.move(1, g.stickHome.x - g.stickTravel, g.stickHome.y - g.stickTravel);
    expect(sink.moveX).toBeLessThan(-0.4);
    expect(sink.moveZ).toBeGreaterThan(0.4);

    // Right thumb lands on the trigger. Both fingers are live.
    expect(r.down(2, g.fire.x, g.fire.y, 0)).toBe(TC_FIRE);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
    expect(r.stick.active).toBe(true);

    // And it keeps aiming while it holds the trigger — the combination the bar
    // physically cannot offer, because its aim gesture IS its fire gesture.
    sink.clearLook();
    r.move(2, g.fire.x - 40, g.fire.y - 6);
    r.move(2, g.fire.x - 70, g.fire.y - 10);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
    expect(sink.lookDx).toBeLessThan(-20);
    // …while the stick has not moved a pixel.
    expect(sink.moveX).toBeLessThan(-0.4);
  });

  it('never fires from an aiming drag, and always fires from a tap', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);

    // A long drag across the look surface: aim only.
    expect(r.down(1, 500, 150, 0)).toBe(TC_LOOK);
    for (let i = 1; i <= 10; i++) r.move(1, 500 + i * 9, 150);
    r.up(1, 300);
    expect(sink.taps).toHaveLength(0);
    expect(sink.down.has(InputAction.Fire)).toBe(false);
    expect(sink.lookDx).toBeGreaterThan(80);

    // A short still press on the same surface: exactly one shot, no look.
    sink.clearLook();
    r.down(2, 500, 150, 400);
    r.up(2, 480);
    expect(sink.taps).toEqual([InputAction.Fire]);
    expect(sink.lookDx).toBe(0);
  });

  it('holds the trigger through a slide-off and drops it on release', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;

    r.down(1, g.fire.x, g.fire.y, 1000);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
    r.move(1, g.fire.x - 60, g.fire.y - 30);
    expect(r.firePad.aiming).toBe(true);
    expect(sink.down.has(InputAction.Fire)).toBe(true);

    r.up(1, 1200);
    r.update(1 / 60, 1200, null, true);
    expect(sink.down.has(InputAction.Fire)).toBe(false);
  });

  it('holds a tap shorter than one frame long enough to actually fire', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;
    r.down(1, g.fire.x, g.fire.y, 1000);
    r.up(1, 1004);                       // press and release inside 4 ms
    r.update(1 / 60, 1010, null, true);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
    r.update(1 / 60, 1100, null, true);  // past the 90 ms minimum hold
    expect(sink.down.has(InputAction.Fire)).toBe(false);
  });

  it('routes every glyph to its action and lets go on release', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;

    expect(r.down(1, g.jump.x, g.jump.y, 0)).toBe(TC_JUMP);
    expect(sink.down.has(InputAction.Jump)).toBe(true);
    r.up(1, 10);
    expect(sink.down.has(InputAction.Jump)).toBe(false);

    expect(r.down(2, g.crouch.x, g.crouch.y, 0)).toBe(TC_CROUCH);
    expect(sink.down.has(InputAction.Crouch)).toBe(true);
    r.up(2, 10);

    expect(r.down(3, g.reload.x, g.reload.y, 0)).toBe(TC_RELOAD);
    expect(sink.down.has(InputAction.Reload)).toBe(true);
    r.up(3, 10);

    // Build and weapon-swap are one-shots, not holds: a held BUILD would keep
    // asserting the build bit on the wire for as long as the thumb rested.
    expect(r.down(4, g.build.x, g.build.y, 0)).toBe(TC_BUILD);
    expect(r.down(5, g.swap.x, g.swap.y, 0)).toBe(TC_SWAP);
    expect(sink.taps).toEqual([InputAction.BuildMode, InputAction.NextWeapon]);
    expect(sink.down.has(InputAction.BuildMode)).toBe(false);
  });

  it('sprints from the stick detent alone — no button, no second thumb', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;
    r.down(1, g.stickHome.x, g.stickHome.y, 0);
    r.move(1, g.stickHome.x, g.stickHome.y - g.stickTravel * 0.5);
    expect(sink.down.has(InputAction.Sprint)).toBe(false);
    r.move(1, g.stickHome.x, g.stickHome.y - g.stickTravel * 1.5);
    expect(sink.down.has(InputAction.Sprint)).toBe(true);
    r.up(1, 10);
    expect(sink.down.has(InputAction.Sprint)).toBe(false);
    expect(sink.moveZ).toBe(0);
  });

  it('lets go of a button the thumb rolled off, instead of sticking it down', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;
    r.down(1, g.crouch.x, g.crouch.y, 0);
    expect(sink.down.has(InputAction.Crouch)).toBe(true);
    r.move(1, g.crouch.x, g.crouch.y - g.crouch.r * 4);
    expect(sink.down.has(InputAction.Crouch)).toBe(false);
    expect(r.held).toBe(0);
  });

  it('ignores a resting palm in a zone another finger already owns', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;
    r.down(1, g.stickHome.x, g.stickHome.y, 0);
    expect(r.down(2, g.stickHome.x + 20, g.stickHome.y + 20, 0)).toBe(TC_NONE);
    r.down(3, 500, 150, 0);
    expect(r.down(4, 520, 160, 0)).toBe(TC_NONE);
    // …and the extra fingers cannot then steal the real ones' moves.
    r.move(2, g.stickHome.x + 60, g.stickHome.y);
    expect(sink.moveX).toBe(0);
  });

  it('drops everything on releaseAll — no key survives a pause', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;
    r.down(1, g.stickHome.x, g.stickHome.y, 0);
    r.move(1, g.stickHome.x + g.stickTravel, g.stickHome.y);
    r.down(2, g.fire.x, g.fire.y, 0);
    r.down(3, g.jump.x, g.jump.y, 0);
    expect(sink.down.size).toBeGreaterThan(0);

    r.releaseAll();
    expect(sink.down.size).toBe(0);
    expect(sink.moveX).toBe(0);
    expect(r.held).toBe(0);
    expect(r.firing).toBe(false);
    expect(r.stick.active).toBe(false);
  });

  it('mirrors for a left-handed player: the stick moves under the other thumb', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink, true);
    const g = r.geom;
    expect(g.stickHome.x).toBeGreaterThan(915 / 2);
    expect(g.fire.x).toBeLessThan(915 / 2);
    expect(r.down(1, g.stickHome.x, g.stickHome.y, 0)).toBe(TC_STICK);
    expect(r.down(2, g.fire.x, g.fire.y, 0)).toBe(TC_FIRE);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
  });

  it('floats the stick to wherever the thumb landed', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const g = r.geom;
    const x = g.stickZone.x1 - 20;
    const y = g.vh - 30;
    r.down(1, x, y, 0);
    // The press itself is zero deflection, wherever it landed…
    expect(sink.moveX).toBe(0);
    expect(sink.moveZ).toBe(0);
    // …and the ring stays on screen even though the origin is in the corner.
    expect(r.stick.ringX).toBeLessThanOrEqual(g.stickBounds.x1);
    expect(r.stick.ringY).toBeLessThanOrEqual(g.stickBounds.y1);
  });
});

describe('TouchRouter: aim assist and auto-fire', () => {
  it('does nothing at all while no thumb is on the glass', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const aim = new FakeAim();
    aim.yaw = 3 * DEG2RAD;
    for (let i = 0; i < 30; i++) r.update(1 / 60, i * 16, aim, true);
    expect(aim.pulls).toBe(0);
    expect(r.engaged).toBe(0);
    expect(r.friction).toBe(1);
  });

  it('pulls toward the target and slows the look while a thumb is aiming', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const aim = new FakeAim();
    aim.yaw = 3 * DEG2RAD;

    r.down(1, 500, 150, 0);
    r.move(1, 480, 150);
    r.update(1 / 60, 16, aim, true);
    expect(aim.pulls).toBeGreaterThan(0);
    expect(aim.totalYaw).toBeGreaterThan(0);            // toward the target
    expect(aim.totalYaw).toBeLessThan(aim.yaw);         // never past it
    expect(r.engaged).toBeGreaterThan(0);
    expect(r.friction).toBeLessThan(1);

    // The friction is then actually applied to the player's own drag.
    sink.clearLook();
    r.move(1, 380, 150);
    expect(Math.abs(sink.lookDx)).toBeLessThan(100);
    expect(Math.abs(sink.lookDx)).toBeGreaterThan(0);
  });

  it('is inert when switched off, however good the shot is', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    r.aimAssistEnabled = false;
    const aim = new FakeAim();
    r.down(1, 500, 150, 0);
    r.move(1, 480, 150);
    r.update(1 / 60, 16, aim, true);
    expect(aim.pulls).toBe(0);
    expect(r.friction).toBe(1);
    sink.clearLook();
    r.move(1, 460, 150);
    expect(sink.lookDx).toBe(-20);                       // unattenuated
  });

  it('never assists a paused game', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const aim = new FakeAim();
    r.down(1, 500, 150, 0);
    r.update(1 / 60, 16, aim, false);
    expect(aim.pulls).toBe(0);
  });

  it('auto-fire holds the trigger hands-free, and only on a real lock', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const aim = new FakeAim();
    r.autoFireEnabled = true;

    // Dead ahead, in range, nothing in the way: fire, with no finger down.
    r.update(1 / 60, 16, aim, true);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
    expect(r.locked).toBe(true);

    // Turn away past the release angle and it lets go (after the hold window).
    aim.yaw = 30 * DEG2RAD;
    r.update(1 / 60, 32, aim, true);
    r.update(1 / 60, 400, aim, true);
    expect(sink.down.has(InputAction.Fire)).toBe(false);
  });

  it('auto-fire never shoots a wall, and never shoots at nothing', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const aim = new FakeAim();
    r.autoFireEnabled = true;

    aim.clearance = 3;                    // a wall between us and the target
    r.update(1 / 60, 16, aim, true);
    expect(sink.down.has(InputAction.Fire)).toBe(false);

    aim.clearance = 24;
    aim.has = false;                      // nothing alive to shoot
    r.update(1 / 60, 32, aim, true);
    expect(sink.down.has(InputAction.Fire)).toBe(false);
  });

  it('auto-fire still lets a distant target be shot once the probe saturates', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const aim = new FakeAim();
    r.autoFireEnabled = true;
    aim.dist = 38;                        // beyond the clearance probe's reach
    aim.clearance = 24;                   // nothing solid anywhere in front
    r.update(1 / 60, 16, aim, true);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
  });

  it('is off by default — nobody is opted into a robot', () => {
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    const aim = new FakeAim();
    expect(r.autoFireEnabled).toBe(false);
    r.update(1 / 60, 16, aim, true);
    expect(sink.down.has(InputAction.Fire)).toBe(false);
  });

  it('the option chips toggle, and report the toggle', () => {
    const sink = new FakeSink();
    const toggles: Array<[number, boolean]> = [];
    const r = new TouchRouter(sink, { onToggle: (c, on) => { toggles.push([c, on]); } });
    r.resize(915, 412, {});
    const g = r.geom;
    r.down(1, g.autoFire.x, g.autoFire.y, 0);
    r.down(2, g.aimAssist.x, g.aimAssist.y, 0);
    expect(r.autoFireEnabled).toBe(true);
    expect(r.aimAssistEnabled).toBe(false);
    expect(toggles).toEqual([[TC_AUTOFIRE, true], [TC_AIMASSIST, false]]);
  });

  it('the pause glyph pauses and nothing else', () => {
    const sink = new FakeSink();
    let paused = 0;
    const r = new TouchRouter(sink, { onPause: () => { paused++; } });
    r.resize(915, 412, {});
    expect(r.down(1, r.geom.pause.x, r.geom.pause.y, 0)).toBe(TC_PAUSE);
    expect(paused).toBe(1);
    expect(sink.down.size).toBe(0);
    expect(sink.taps).toHaveLength(0);
  });
});

describe('TouchRouter: portrait, which the bar refuses outright', () => {
  it('plays at 412x915: stick, trigger and look all reachable', () => {
    const sink = new FakeSink();
    const r = new TouchRouter(sink);
    const g = r.resize(412, 915, {});

    expect(r.down(1, g.stickHome.x, g.stickHome.y, 0)).toBe(TC_STICK);
    r.move(1, g.stickHome.x + g.stickTravel, g.stickHome.y);
    expect(sink.moveX).toBeGreaterThan(0.5);

    expect(r.down(2, g.fire.x, g.fire.y, 0)).toBe(TC_FIRE);
    expect(sink.down.has(InputAction.Fire)).toBe(true);

    // The top two thirds of a portrait screen are a look surface, not chrome.
    expect(hitTest(g, 206, 300)).toBe(TC_LOOK);
    r.down(3, 206, 300, 0);
    r.move(3, 246, 320);
    expect(sink.lookDx).toBeGreaterThan(0);
  });

  it('keeps both thumbs clear of the read-out bands in portrait', () => {
    const sink = new FakeSink();
    const r = new TouchRouter(sink);
    const g = r.resize(412, 915, {});
    expect(g.padBottomLeft).toBeGreaterThan(0);
    expect(g.padBottomRight).toBeGreaterThan(0);
    expect(g.padBottomLeft + 1).toBeLessThan(915 * 0.5);
  });
});

describe('TouchRouter: the trigger survives the sink being cleared behind it', () => {
  it('re-asserts a held trigger after an external release-all', () => {
    // `InputManager.releaseAll()` fires on window blur and on pointer-lock loss
    // and wipes every held button. The pad is not told. A purely change-gated
    // write would leave the player holding a trigger that does nothing.
    const sink = new FakeSink();
    const r = landscapeRouter(sink);
    r.down(1, r.geom.fire.x, r.geom.fire.y, 0);
    expect(sink.down.has(InputAction.Fire)).toBe(true);

    sink.down.clear();                       // the blur
    r.update(1 / 60, 16, null, true);
    expect(sink.down.has(InputAction.Fire)).toBe(true);
  });

  it('still writes nothing at all on a still frame with the trigger up', () => {
    const sink = new FakeSink();
    let writes = 0;
    const counting: TouchSink = {
      setMove: (x, z) => { writes++; sink.setMove(x, z); },
      addLook: (x, y) => { writes++; sink.addLook(x, y); },
      setButton: (a, d) => { writes++; sink.setButton(a, d); },
      tap: (a) => { writes++; sink.tap(a); },
      reset: () => { writes++; sink.reset(); },
    };
    const r = new TouchRouter(counting);
    r.resize(915, 412, {});
    r.update(1 / 60, 16, null, true);
    writes = 0;
    for (let i = 0; i < 60; i++) r.update(1 / 60, 32 + i * 16, null, true);
    expect(writes).toBe(0);
  });
});
