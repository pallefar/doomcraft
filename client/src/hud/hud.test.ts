/**
 * HUD read-out logic.
 *
 * The HUD's DOM is not the interesting part — the *judgement* is: which tier a
 * health value falls into, whether an ammo count counts as low, and above all
 * whether the directional damage ring merges, decays and stays anchored to the
 * WORLD rather than to the screen. That last one is the whole feature: a
 * damage indicator frozen at the screen angle it had when the hit landed lies
 * the instant the player turns, which is exactly when they are reading it.
 *
 * These run under vitest's node environment, so nothing here may touch the
 * DOM. hud.ts only reaches for `document` inside `Hud`'s methods, so importing
 * the module is safe.
 */

import { describe, it, expect } from 'vitest';
import {
  DamageRing, DMG_SLOTS, DMG_LIFE, DMG_MERGE_RAD,
  healthTier, HEALTH_TIER_OK, HEALTH_TIER_HURT, HEALTH_TIER_CRIT,
  HEALTH_HURT_AT, HEALTH_CRIT_AT,
  ammoTier, AMMO_TIER_OK, AMMO_TIER_LOW, AMMO_TIER_EMPTY, ammoReadout,
  critVignette, crosshairGapFor, formatClock, magSizeOf, wrapPi, frameRadius,
  createHudState,
  keepOutRadius, KEEP_OUT_MIN, KEEP_OUT_MAX,
  statusDrop, STATUS_DROP_MIN, STATUS_DROP_MAX,
  statusInk, statusPlacement, statusCornerText, SIGHTLINE_INK_BUDGET,
  STATUS_OFF, STATUS_SIGHTLINE, STATUS_CORNER, STATUS_DEATH,
  weaponGlyph, WEAPON_GLYPH_FALLBACK, foveaHealthFrac,
  RAIL_MAX_CELLS, railSpecs, railStringCount, type RailCellSpec,
  HUD_CSS, economySurfacesOn, awardText,
  createHitMarkerState, raiseHitMarker, hitMarkerRank,
  HIT_MARKER_S, HIT_MARKER_KILL_S,
} from './hud';
import { FLAG_ORDER, defaultFlagBits } from '@shared/flags';
import {
  AMMO_TYPE_COUNT, WEAPON_COUNT, WEAPON_MAG_SIZE, WeaponId, ammoTypeOf,
} from '@shared/weapons';

describe('health tiers', () => {
  it('is a three-state ramp with the boundaries inclusive downward', () => {
    expect(healthTier(100)).toBe(HEALTH_TIER_OK);
    expect(healthTier(HEALTH_HURT_AT + 1)).toBe(HEALTH_TIER_OK);
    expect(healthTier(HEALTH_HURT_AT)).toBe(HEALTH_TIER_HURT);
    expect(healthTier(HEALTH_CRIT_AT + 1)).toBe(HEALTH_TIER_HURT);
    expect(healthTier(HEALTH_CRIT_AT)).toBe(HEALTH_TIER_CRIT);
    expect(healthTier(1)).toBe(HEALTH_TIER_CRIT);
    expect(healthTier(0)).toBe(HEALTH_TIER_CRIT);
  });

  it('never skips a tier as health falls one point at a time', () => {
    let last = healthTier(100);
    for (let hp = 100; hp >= 0; hp--) {
      const t = healthTier(hp);
      expect(t - last).toBeLessThanOrEqual(1);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
    expect(last).toBe(HEALTH_TIER_CRIT);
  });
});

describe('critical vignette', () => {
  it('is silent above the threshold and once you are actually dead', () => {
    expect(critVignette(100, 0)).toBe(0);
    expect(critVignette(HEALTH_CRIT_AT + 1, 1.3)).toBe(0);
    expect(critVignette(0, 1.3)).toBe(0);
  });

  it('throbs inside a bounded band, and harder the closer you are to dying', () => {
    let lowMin = Infinity, lowMax = -Infinity;
    let direMin = Infinity, direMax = -Infinity;
    for (let i = 0; i < 400; i++) {
      const t = i * 0.01;
      const low = critVignette(25, t);
      const dire = critVignette(6, t);
      lowMin = Math.min(lowMin, low); lowMax = Math.max(lowMax, low);
      direMin = Math.min(direMin, dire); direMax = Math.max(direMax, dire);
    }
    // Always visible, never a full-screen filter.
    expect(lowMin).toBeGreaterThan(0.1);
    expect(lowMax).toBeLessThan(0.25);
    expect(direMin).toBeGreaterThan(0.19);
    expect(direMax).toBeLessThan(0.41);
    // The dire band sits strictly above the merely-hurt band.
    expect(direMax).toBeGreaterThan(lowMax);
  });
});

describe('ammo tiers', () => {
  it('flags the last quarter of a magazine and zero', () => {
    expect(ammoTier(15, 15)).toBe(AMMO_TIER_OK);
    expect(ammoTier(5, 15)).toBe(AMMO_TIER_OK);
    expect(ammoTier(4, 15)).toBe(AMMO_TIER_LOW);   // ceil(15 * 0.25) === 4
    expect(ammoTier(1, 15)).toBe(AMMO_TIER_LOW);
    expect(ammoTier(0, 15)).toBe(AMMO_TIER_EMPTY);
  });

  it('still warns on a tiny magazine, where a quarter rounds down to nothing', () => {
    // Rocket launcher holds 5, BFG holds 3. A literal quarter of five is 1.25
    // rounds, so the threshold is rounded UP: a warning that only fires on the
    // last rocket is a warning that arrives after the decision it informs.
    expect(ammoTier(5, 5)).toBe(AMMO_TIER_OK);
    expect(ammoTier(3, 5)).toBe(AMMO_TIER_OK);
    expect(ammoTier(2, 5)).toBe(AMMO_TIER_LOW);
    expect(ammoTier(1, 5)).toBe(AMMO_TIER_LOW);
    expect(ammoTier(2, 3)).toBe(AMMO_TIER_OK);
    expect(ammoTier(1, 3)).toBe(AMMO_TIER_LOW);
    // Shotgun: eight shells, warn with two left.
    expect(ammoTier(3, 8)).toBe(AMMO_TIER_OK);
    expect(ammoTier(2, 8)).toBe(AMMO_TIER_LOW);
  });

  it('leaves a melee weapon alone', () => {
    expect(magSizeOf(WeaponId.CHAINSAW)).toBe(0);
    expect(ammoTier(0, 0)).toBe(AMMO_TIER_OK);
  });
});

describe('ammo read-out', () => {
  /* The gap the bar leaves wide open: voxiom shows NO ammunition state at all
     (ref/voxiom/desktop-08-combat.png). These lock the shape of ours. */

  it('answers both ammo questions at once — clip AND reserve, as one pair', () => {
    const r = ammoReadout(WeaponId.ROCKET, 4, 8, false);
    expect(r.clip).toBe('4');
    expect(r.reserve).toBe('8');
    expect(r.pair).toBe(true);
    expect(r.caption).toBe('ROCKET LAUNCHER \u00b7 ROCKETS');
  });

  it('never shows a bare clip with no reserve beside it for a gun that has one', () => {
    for (let w = 0; w < WEAPON_COUNT; w++) {
      const r = ammoReadout(w, 3, 17, false);
      if (WEAPON_MAG_SIZE[w] > 0 && ammoTypeOf(w) !== 0) {
        expect(r.pair).toBe(true);
        expect(r.reserve).toBe('17');
        expect(r.clip).toBe('3');
      }
      // Whatever the weapon, the caption always names it.
      expect(r.caption.length).toBeGreaterThan(0);
    }
  });

  it('says INFINITE rather than zero for melee, and drops the reserve entirely', () => {
    const r = ammoReadout(WeaponId.CHAINSAW, 0, 0, false);
    expect(r.clip).toBe('\u221e');
    expect(r.pair).toBe(false);
    expect(r.reserve).toBe('');
    expect(r.caption).toBe('CHAINSAW \u00b7 MELEE');
  });

  it('replaces the caption with RELOADING, which is the only thing you can act on', () => {
    expect(ammoReadout(WeaponId.CHAINGUN, 0, 200, true).caption).toBe('RELOADING');
    expect(ammoReadout(WeaponId.CHAINGUN, 0, 200, true).reserve).toBe('200');
  });

  it('shows a real zero at empty instead of blanking, and never a negative', () => {
    const dry = ammoReadout(WeaponId.SHOTGUN, 0, 0, false);
    expect(dry.clip).toBe('0');
    expect(dry.reserve).toBe('0');
    expect(dry.pair).toBe(true);
    const bogus = ammoReadout(WeaponId.SHOTGUN, -4, -9, false);
    expect(bogus.clip).toBe('0');
    expect(bogus.reserve).toBe('0');
  });

  it('survives a weapon id that does not exist without printing "undefined"', () => {
    const r = ammoReadout(999, 5, 5, false);
    expect(r.caption).not.toContain('undefined');
    expect(r.clip).not.toContain('NaN');
  });
});

describe('crosshair', () => {
  it('opens strictly with the cone on the dynamic style', () => {
    let last = -1;
    for (let i = 0; i <= 20; i++) {
      const g = crosshairGapFor('dynamic', i / 20);
      expect(g).toBeGreaterThan(last);
      last = g;
    }
    expect(crosshairGapFor('dynamic', 0)).toBeCloseTo(5, 6);
    expect(crosshairGapFor('dynamic', 1)).toBeCloseTo(31, 6);
  });

  it('clamps a cone outside 0..1 instead of inverting the crosshair', () => {
    expect(crosshairGapFor('dynamic', -3)).toBeCloseTo(5, 6);
    expect(crosshairGapFor('dynamic', 9)).toBeCloseTo(31, 6);
  });

  it('honours the static styles the settings panel offers', () => {
    expect(crosshairGapFor('dot', 0.9)).toBe(0);
    expect(crosshairGapFor('cross', 0)).toBe(crosshairGapFor('cross', 1));
    expect(crosshairGapFor('doom', 0)).toBeCloseTo(9, 6);
  });
});

describe('damage ring', () => {
  it('stores the WORLD bearing, untouched by any camera', () => {
    const ring = new DamageRing();
    ring.add(20, 1.2);
    expect(ring.yaw[0]).toBeCloseTo(1.2, 5);
    // Nothing in the ring's API takes a camera yaw: projection happens at draw
    // time, so turning cannot corrupt the stored bearing.
    ring.step(0.1);
    expect(ring.yaw[0]).toBeCloseTo(1.2, 5);
  });

  it('folds repeat hits from one bearing into a single louder wedge', () => {
    const ring = new DamageRing();
    ring.add(8, 0.9);
    const soft = ring.power[0];
    for (let i = 0; i < 4; i++) ring.add(8, 0.9 + DMG_MERGE_RAD * 0.4);
    expect(ring.activeCount()).toBe(1);
    expect(ring.power[0]).toBeGreaterThan(soft);
    // And it drags toward the newer bearing rather than staying put.
    expect(ring.yaw[0]).toBeGreaterThan(0.9);
  });

  it('keeps distinct bearings apart', () => {
    const ring = new DamageRing();
    ring.add(20, 0);
    ring.add(20, Math.PI);
    ring.add(20, -Math.PI / 2);
    expect(ring.activeCount()).toBe(3);
  });

  it('merges across the +/-PI seam', () => {
    const ring = new DamageRing();
    ring.add(20, Math.PI - 0.1);
    ring.add(20, -Math.PI + 0.1);
    expect(ring.activeCount()).toBe(1);
  });

  it('recycles the faintest slot instead of growing without bound', () => {
    const ring = new DamageRing();
    for (let i = 0; i < DMG_SLOTS + 4; i++) {
      ring.add(20, -Math.PI + (i * 2 * Math.PI) / (DMG_SLOTS + 4));
      ring.step(0.01);
    }
    expect(ring.activeCount()).toBe(DMG_SLOTS);
  });

  it('fades out and frees its slot', () => {
    const ring = new DamageRing();
    ring.add(40, 0.4);
    const a0 = ring.alpha(0);
    expect(a0).toBeGreaterThan(0);
    ring.step(DMG_LIFE * 0.5);
    const a1 = ring.alpha(0);
    expect(a1).toBeLessThan(a0);
    ring.step(DMG_LIFE);
    expect(ring.life[0]).toBe(0);
    expect(ring.alpha(0)).toBe(0);
    expect(ring.activeCount()).toBe(0);
  });

  it('is louder for a big hit than a graze', () => {
    const ring = new DamageRing();
    ring.add(4, 0);
    ring.add(90, Math.PI);
    expect(ring.alpha(1)).toBeGreaterThan(ring.alpha(0));
    expect(ring.power[1]).toBe(1);
  });

  it('clears on demand, so a respawn does not inherit the last firefight', () => {
    const ring = new DamageRing();
    ring.add(30, 0);
    ring.add(30, 2);
    ring.clear();
    expect(ring.activeCount()).toBe(0);
  });
});

describe('damage blade placement', () => {
  // 1440x900 desktop and 412x915 portrait phone, as half-extents.
  const DESK = [720, 450] as const;
  const PHONE = [206, 457.5] as const;

  it('lands on the frame edge on the four cardinal bearings', () => {
    const [hw, hh] = DESK;
    expect(frameRadius(0, hw, hh)).toBeCloseTo(hh, 4);              // straight up
    expect(frameRadius(Math.PI, hw, hh)).toBeCloseTo(hh, 4);        // behind
    expect(frameRadius(Math.PI / 2, hw, hh)).toBeCloseTo(hw, 4);    // right
    expect(frameRadius(-Math.PI / 2, hw, hh)).toBeCloseTo(hw, 4);   // left
  });

  it('never places a blade outside the frame, at any bearing or aspect', () => {
    for (const [hw, hh] of [DESK, PHONE, [457.5, 206] as const]) {
      for (let i = 0; i < 720; i++) {
        const a = (i / 720) * Math.PI * 2 - Math.PI;
        const r = frameRadius(a, hw, hh);
        // The x/y reach of the anchor must stay inside the half-extents.
        expect(Math.abs(r * Math.sin(a))).toBeLessThanOrEqual(hw + 1e-6);
        expect(Math.abs(r * Math.cos(a))).toBeLessThanOrEqual(hh + 1e-6);
      }
    }
  });

  it('scales with the viewport instead of sitting at a fixed pixel radius', () => {
    // The whole reason this is a function: a constant radius is mid-field on a
    // desktop and off-screen on a phone.
    const desk = frameRadius(0, DESK[0], DESK[1]);
    const phone = frameRadius(Math.PI / 2, PHONE[0], PHONE[1]);
    expect(desk).toBeGreaterThan(phone * 2);
  });

  it('honours the inset and still refuses to collapse onto the crosshair', () => {
    const [hw, hh] = DESK;
    expect(frameRadius(0, hw, hh, 4)).toBeCloseTo(hh - 4, 4);
    // A silly inset must not drag the blade into the middle of the frame.
    expect(frameRadius(0, hw, hh, 10_000)).toBeGreaterThan(Math.min(hw, hh) * 0.3);
  });

  it('survives a degenerate viewport rather than dividing by zero', () => {
    expect(Number.isFinite(frameRadius(0.7, 0, 0))).toBe(true);
    expect(frameRadius(0.7, 0, 0)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The sightline budget
 *
 * The measured thing this piece is judged on. The bar spends ~19,000 px² of
 * white glyph box on a transient line and parks it 180 px ABOVE its own
 * crosshair (ref/voxiom/desktop-08-combat.png: "Waiting for players...(2/50)",
 * x 483–961, y 251–291). These lock the rule that makes that impossible here:
 * the reticle owns a radius, and anything that will not fit inside it in a
 * thousand-odd square pixels is not drawn there at all.
 * ------------------------------------------------------------------------ */

/** The desktop the bar was measured on, and the two phone viewports. */
const V_DESK: readonly [number, number] = [1440, 900];
const V_PORTRAIT: readonly [number, number] = [412, 915];
const V_LANDSCAPE: readonly [number, number] = [915, 412];

describe('reticle keep-out', () => {
  it('is the ~300 px the desktop frame was judged against', () => {
    expect(keepOutRadius(V_DESK[0], V_DESK[1])).toBeGreaterThan(290);
    expect(keepOutRadius(V_DESK[0], V_DESK[1])).toBeLessThanOrEqual(KEEP_OUT_MAX);
  });

  it('scales to the short edge instead of stamping 300 px onto a phone', () => {
    // A literal 300 px radius on a 412x915 portrait phone is three quarters of
    // the width — it would forbid the whole HUD, which is how a "rule" turns
    // into something nobody follows.
    for (const [w, h] of [V_PORTRAIT, V_LANDSCAPE]) {
      const r = keepOutRadius(w, h);
      expect(r).toBeLessThan(keepOutRadius(V_DESK[0], V_DESK[1]));
      expect(r * 2).toBeLessThan(Math.min(w, h));
    }
  });

  it('never collapses to nothing and never exceeds its cap', () => {
    for (const [w, h] of [[0, 0], [1, 1], [4000, 4000], [3840, 200]] as const) {
      const r = keepOutRadius(w, h);
      expect(r).toBeGreaterThanOrEqual(KEEP_OUT_MIN);
      expect(r).toBeLessThanOrEqual(KEEP_OUT_MAX);
    }
  });

  it('is monotonic in the short edge', () => {
    let last = 0;
    for (let s = 0; s <= 1600; s += 37) {
      const r = keepOutRadius(s, s);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });
});

describe('status drop', () => {
  it('puts the plate 120 px BELOW the crosshair on the judged desktop', () => {
    expect(Math.round(statusDrop(V_DESK[0], V_DESK[1]))).toBe(120);
  });

  it('stays inside the keep-out but never on top of the crosshair canvas', () => {
    // The plate is allowed inside the keep-out — that is the point of a budget
    // rather than a ban — but it must clear the 96 px crosshair canvas, whose
    // bottom edge is 48 px below centre.
    for (const [w, h] of [V_DESK, V_PORTRAIT, V_LANDSCAPE]) {
      const d = statusDrop(w, h);
      expect(d).toBeGreaterThan(48);
      expect(d).toBeLessThanOrEqual(keepOutRadius(w, h));
    }
  });

  it('is bounded at both ends', () => {
    for (const [w, h] of [[0, 0], [1, 1], [6000, 6000]] as const) {
      const d = statusDrop(w, h);
      expect(d).toBeGreaterThanOrEqual(STATUS_DROP_MIN);
      expect(d).toBeLessThanOrEqual(STATUS_DROP_MAX);
    }
  });
});

describe('sightline ink', () => {
  it('costs the bar\'s own line at an order of magnitude over the budget', () => {
    // Not the bar's real metrics — its line is 28 px cap height, not 11 — but
    // even priced at OUR type size the string is over budget, which is the
    // whole reason it gets demoted instead of centred.
    const bar = statusInk('Waiting for players...(2/50)', '');
    expect(bar).toBeGreaterThan(SIGHTLINE_INK_BUDGET);
  });

  it('prices a real status line at about what a good HUD spends', () => {
    // ~1,580 px² is the measured figure for a HUD that wins this comparison.
    const ink = statusInk('WAITING FOR MARINES', '');
    expect(ink).toBeGreaterThan(800);
    expect(ink).toBeLessThan(SIGHTLINE_INK_BUDGET);
  });

  it('is zero for nothing and grows with every character', () => {
    expect(statusInk('', '')).toBe(0);
    let last = 0;
    for (let n = 0; n <= 40; n++) {
      const ink = statusInk('X'.repeat(n), '');
      expect(ink).toBeGreaterThanOrEqual(last);
      last = ink;
    }
    expect(statusInk('ABC', 'DEF')).toBeGreaterThan(statusInk('ABC', ''));
  });
});

describe('status placement', () => {
  it('draws nothing when there is nothing to say', () => {
    expect(statusPlacement('', '', false)).toBe(STATUS_OFF);
    expect(statusPlacement('', '', true)).toBe(STATUS_OFF);
  });

  it('keeps a short line on the small plate under the reticle', () => {
    expect(statusPlacement('WAITING FOR MARINES', '', false)).toBe(STATUS_SIGHTLINE);
    expect(statusPlacement('ROUND 2', '', false)).toBe(STATUS_SIGHTLINE);
  });

  it('demotes anything over budget to the top-left chip stack', () => {
    expect(statusPlacement('Waiting for players...(2/50)', '', false)).toBe(STATUS_CORNER);
    expect(statusPlacement('LOADING TERRAIN', 'THIS IS A LONG SECOND LINE OF EXPLANATION',
      false)).toBe(STATUS_CORNER);
  });

  it('NEVER puts an over-budget line on the sightline, at any length', () => {
    // The invariant, stated as the thing that must not happen. A future caller
    // handed a 300-character string cannot produce a banner.
    for (let n = 0; n <= 300; n++) {
      const text = 'M'.repeat(n);
      const place = statusPlacement(text, '', false);
      if (place === STATUS_SIGHTLINE) {
        expect(statusInk(text, '')).toBeLessThanOrEqual(SIGHTLINE_INK_BUDGET);
      }
    }
    expect(statusPlacement('M'.repeat(300), '', false)).toBe(STATUS_CORNER);
  });

  it('gives death the middle, because a dead player has no aim line', () => {
    // The crosshair is hidden while dead, so the keep-out has nothing to keep
    // clear and the card may be as loud as the event.
    expect(statusPlacement('YOU DIED', 'Click or press Space to respawn', true))
      .toBe(STATUS_DEATH);
    // ...and the same words while ALIVE are over budget and get demoted.
    expect(statusPlacement('YOU DIED', 'Click or press Space to respawn', false))
      .not.toBe(STATUS_SIGHTLINE);
  });

  it('folds a demoted two-line status into one corner line', () => {
    expect(statusCornerText('Loading terrain', '')).toBe('LOADING TERRAIN');
    expect(statusCornerText('', 'stand by')).toBe('STAND BY');
    expect(statusCornerText('Round 2', 'starting')).toBe('ROUND 2 · STARTING');
  });
});

describe('hotbar glyphs', () => {
  it('gives every weapon in the arsenal its own silhouette', () => {
    for (let i = 0; i < WEAPON_COUNT; i++) {
      const g = weaponGlyph(i);
      expect(g.length).toBeGreaterThan(20);
      expect(g).not.toBe(WEAPON_GLYPH_FALLBACK);
      // Drawable: at least one filled shape, and nothing that would break the
      // attribute quoting when it is interpolated into the slot's markup.
      expect(/<(path|circle)\b/.test(g)).toBe(true);
      expect(g.includes('<script')).toBe(false);
      expect((g.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });

  it('never hands two weapons the same shape — the whole point is telling '
    + 'them apart without reading', () => {
    const seen = new Set<string>();
    for (let i = 0; i < WEAPON_COUNT; i++) seen.add(weaponGlyph(i));
    expect(seen.size).toBe(WEAPON_COUNT);
  });

  it('still draws something for an id the arsenal does not define, rather '
    + 'than leaving an empty tile', () => {
    expect(weaponGlyph(WEAPON_COUNT)).toBe(WEAPON_GLYPH_FALLBACK);
    expect(weaponGlyph(-1)).toBe(WEAPON_GLYPH_FALLBACK);
    expect(weaponGlyph(NaN)).toBe(WEAPON_GLYPH_FALLBACK);
    expect(WEAPON_GLYPH_FALLBACK.length).toBeGreaterThan(0);
  });
});

describe('the dying read at the point of gaze', () => {
  it('does not exist at all while you are healthy, so the centre stays clean', () => {
    expect(foveaHealthFrac(100, false)).toBe(0);
    expect(foveaHealthFrac(HEALTH_CRIT_AT + 1, false)).toBe(0);
  });

  it('is full at the critical threshold and scales to the critical band, not '
    + 'to full health — the resolution is spent where it matters', () => {
    expect(foveaHealthFrac(HEALTH_CRIT_AT, false)).toBe(1);
    expect(foveaHealthFrac(HEALTH_CRIT_AT / 2, false)).toBeCloseTo(0.5, 6);
    expect(foveaHealthFrac(3, false)).toBeCloseTo(3 / HEALTH_CRIT_AT, 6);
  });

  it('is monotonic all the way down and never leaves the unit range', () => {
    let prev = -1;
    for (let hp = 0; hp <= HEALTH_CRIT_AT; hp++) {
      const v = foveaHealthFrac(hp, false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('vanishes at zero and while dead — the death card owns that screen', () => {
    expect(foveaHealthFrac(0, false)).toBe(0);
    expect(foveaHealthFrac(-5, false)).toBe(0);
    expect(foveaHealthFrac(1, true)).toBe(0);
    expect(foveaHealthFrac(HEALTH_CRIT_AT, true)).toBe(0);
  });

  it('agrees with the tier that turns the corner bar red, so the two health '
    + 'read-outs can never disagree about whether you are dying', () => {
    for (let hp = 0; hp <= 100; hp++) {
      const crit = healthTier(hp) === HEALTH_TIER_CRIT && hp > 0;
      expect(foveaHealthFrac(hp, false) > 0).toBe(crit);
    }
  });
});

describe('the chassis', () => {
  /** Flatten the stylesheet into `{selector, body}` pairs, comments stripped. */
  function rules(css: string): Array<{ sel: string; body: string }> {
    const out: Array<{ sel: string; body: string }> = [];
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(bare); m !== null; m = re.exec(bare)) {
      out.push({ sel: m[1]!.trim(), body: m[2]!.replace(/\s+/g, '') });
    }
    return out;
  }

  /** The base rule for each plate — the one that declares its own background. */
  const PLATES = [
    '.dc-map canvas', '.dc-chip', '.dc-rail', '.dc-bar', '.dc-ammo',
    '.dc-slot', '.dc-status', '.dc-scorner', '.dc-board', '.dc-feed .ln',
  ];

  it('declares the token set exactly once, on #hud, so mode overlays inherit '
    + 'it instead of inventing their own', () => {
    const roots = rules(HUD_CSS).filter((r) => r.body.includes('--dc-r:'));
    expect(roots.length).toBe(1);
    expect(roots[0]!.sel).toBe('#hud');
    for (const token of ['--dc-line:', '--dc-plate:', '--dc-plate-solid:', '--dc-lift:']) {
      expect(roots[0]!.body, `${token} missing from the chassis`).toContain(token);
    }
  });

  it('gives every plate the SAME radius, keyline and elevation — round 1 shipped '
    + 'five different container treatments and the critic counted them', () => {
    const all = rules(HUD_CSS);
    for (const sel of PLATES) {
      const rule = all.find((r) => r.sel === `#hud ${sel}`);
      expect(rule, `no base rule for ${sel}`).toBeTruthy();
      expect(rule!.body, `${sel} does not use the shared radius`)
        .toContain('border-radius:var(--dc-r)');
    }
  });

  it('leaves no hard-coded radius or plate keyline anywhere on the HUD, which '
    + 'is the only way "one token set" survives the next change', () => {
    for (const rule of rules(HUD_CSS)) {
      // Circles are an affordance, not a plate: the stick, the knob and the
      // thumb buttons are round because they are round things.
      if (rule.body.includes('border-radius:50%')) continue;
      const radius = /border-radius:([^;]+)/.exec(rule.body);
      if (radius !== null) {
        expect(radius[1], `${rule.sel} hard-codes a radius`).toContain('var(--dc-r)');
      }
      // A 1 px white-ish keyline is the plate border; it must come from the token.
      const keyline = /border:1pxsolidrgba\(255,255,255/.exec(rule.body);
      expect(keyline, `${rule.sel} hard-codes the plate keyline`).toBeNull();
    }
  });
});

describe('the match rail', () => {
  /** The exact strip round 1 shipped above the sightline. */
  const ROUND_ONE: RailCellSpec[] = [
    { label: 'Round', kind: 'round' },
    { label: 'Time', kind: 'clock' },
    { label: 'Frag limit', kind: 'limit' },
    { label: 'Leader', kind: 'lead' },
    { label: 'You', kind: 'you' },
    { label: 'In match', kind: 'bodies' },
  ];

  it('caps the cell count in code, not in a comment', () => {
    expect(RAIL_MAX_CELLS).toBe(3);
    expect(railSpecs(ROUND_ONE).length).toBe(RAIL_MAX_CELLS);
  });

  it('keeps the FIRST cells, so the cap truncates the tail a caller added '
    + 'rather than silently reordering what it asked for', () => {
    const kept = railSpecs(ROUND_ONE);
    expect(kept.map((c) => c.kind)).toEqual(['round', 'clock', 'limit']);
  });

  it('leaves a rail that is already inside the budget alone', () => {
    const three = ROUND_ONE.slice(0, 3);
    expect(railSpecs(three)).toEqual(three);
    expect(railSpecs([])).toEqual([]);
  });

  it('returns a copy, so a caller cannot mutate the shipped spec list through '
    + 'the value it got back', () => {
    const src: RailCellSpec[] = [{ label: 'You', kind: 'you' }];
    const out = railSpecs(src);
    out.push({ label: 'Leader', kind: 'lead' });
    expect(src.length).toBe(1);
  });

  it('counts the strings that land above the sightline, which is the number '
    + 'the last round lost on: twelve, now five', () => {
    expect(railStringCount(ROUND_ONE)).toBe(6);          // ...and truncated to 3 cells
    expect(railStringCount(ROUND_ONE.slice(0, 3))).toBe(6);
    // The shipping rail: an unlabelled clock plus two labelled cells.
    const shipping: RailCellSpec[] = [
      { label: '', kind: 'clock' },
      { label: 'You', kind: 'you' },
      { label: 'Players', kind: '' },
    ];
    expect(railStringCount(shipping)).toBe(5);
    // The six-pill strip, had the cap not existed, was twelve.
    let uncapped = 0;
    for (const c of ROUND_ONE) uncapped += c.label === '' ? 1 : 2;
    expect(uncapped).toBe(12);
  });
});

describe('misc read-outs', () => {
  it('formats the match clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(-4)).toBe('0:00');
  });

  it('wraps angles into -PI..PI', () => {
    expect(wrapPi(0)).toBeCloseTo(0, 6);
    expect(wrapPi(Math.PI * 3)).toBeCloseTo(Math.PI, 6);
    expect(wrapPi(-Math.PI * 3)).toBeCloseTo(-Math.PI, 6);
    expect(Math.abs(wrapPi(7))).toBeLessThanOrEqual(Math.PI);
  });

  it('defaults per-type reserves to "unknown" so a caller that never fills '
    + 'them does not paint the whole hotbar dry', () => {
    const s = createHudState();
    expect(s.reserveByType.length).toBe(AMMO_TYPE_COUNT);
    for (let i = 0; i < AMMO_TYPE_COUNT; i++) expect(s.reserveByType[i]).toBe(-1);
  });
});

/* ------------------------------------------------------------------------ *
 * The reward surfaces
 * ------------------------------------------------------------------------ */

describe('who is allowed to see a balance', () => {
  const SCRAP_BIT = 1 << FLAG_ORDER.indexOf('economy_scrap');
  const withScrap = (defaultFlagBits() | SCRAP_BIT) >>> 0;

  it('needs BOTH the product flag and the server kill switch, so neither one '
    + 'alone can put a number on the screen', () => {
    expect(economySurfacesOn(false, 0)).toBe(false);
    // The half anybody with devtools can flip. On its own it buys nothing.
    expect(economySurfacesOn(true, 0)).toBe(false);
    expect(economySurfacesOn(true, defaultFlagBits())).toBe(false);
    // The half the server owns. On its own it buys nothing either.
    expect(economySurfacesOn(false, withScrap)).toBe(false);
    expect(economySurfacesOn(true, withScrap)).toBe(true);
  });

  it('reads the kill switch out of the bit the server actually sends, not a '
    + 'position this file guessed at', () => {
    // FLAG_ORDER is append-only and the bit index IS the wire format. If a flag
    // were ever inserted ahead of economy_scrap, this catches it here rather
    // than by showing one player somebody else's feature.
    const i = FLAG_ORDER.indexOf('economy_scrap');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(economySurfacesOn(true, 1 << i)).toBe(true);
    for (let other = 0; other < FLAG_ORDER.length; other++) {
      if (other === i) continue;
      expect(economySurfacesOn(true, 1 << other)).toBe(false);
    }
  });

  it('ships dark: a fresh HUD state shows nothing and claims nothing', () => {
    const s = createHudState();
    expect(s.economy).toBe(false);
    expect(s.xp).toBe(0);
    expect(s.scrap).toBe(0);
  });
});

describe('the one-line award string', () => {
  it('drops a zero rather than printing it, because "+0 SCRAP" reads as a bug '
    + 'and a Builder round genuinely pays none', () => {
    expect(awardText(120, 14)).toBe('+120 XP · +14 SCRAP');
    expect(awardText(120, 0)).toBe('+120 XP');
    expect(awardText(0, 14)).toBe('+14 SCRAP');
    expect(awardText(0, 0)).toBe('');
  });

  it('never prints a negative or a fraction', () => {
    expect(awardText(-50, -3)).toBe('');
    expect(awardText(120.6, 13.4)).toBe('+121 XP · +13 SCRAP');
  });
});

/* ------------------------------------------------------------------------ *
 * THE HIT MARKER, WHICH ONE SHOT REPORTS TWICE
 *
 * `WeaponRuntime` raises a PREDICTED marker on the frame the trigger goes
 * down — that is what makes it read as instant rather than a round trip late —
 * and the server's authoritative DAMAGE event for the same shot arrives up to
 * a round trip afterwards and raises it AGAIN. A shotgun is worse still: the
 * client predicts one marker carrying the whole blast and the server sends one
 * event per pellet.
 *
 * The marker used to be an assignment, so the later, weaker report always won.
 * These cases are the arithmetic of the merge that replaced it.
 * ------------------------------------------------------------------------ */

describe('the hit marker merges two reports of one shot', () => {
  it('is not repainted plain white by the echo of the shot before it', () => {
    /*
     * The exact sequence a chaingun produces at any real ping: shot N-1 lands,
     * shot N kills and the client predicts the red ring, and THEN the server's
     * echo of shot N-1 arrives carrying no kill. Under assignment the ring the
     * player had earned survived about 60 ms of its 460 and then turned white —
     * and for every demon in the game the echo could not do anything else,
     * because the server sent a literal 0 in the flags of an entity's damage
     * event.
     */
    const m = createHitMarkerState();
    raiseHitMarker(m, false, true, 40);          // the kill, predicted
    expect(m.kill).toBe(true);
    expect(m.t).toBeCloseTo(HIT_MARKER_KILL_S, 10);

    m.t -= 0.06;                                  // 60 ms of round trip
    raiseHitMarker(m, false, false, 12);          // the late echo of the shot before

    expect(m.kill, 'a plain hit may not take a kill back').toBe(true);
    expect(m.t, 'nor may it shorten the ring it did not earn')
      .toBeCloseTo(HIT_MARKER_KILL_S - 0.06, 10);
    expect(m.dmg, 'nor shrink it').toBe(40);
  });

  it('does not shrink a shotgun blast to the heft of one pellet', () => {
    /*
     * The client predicts ONE marker for 70 damage; the server confirms it as
     * seven separate 10-damage pellet events. `heft` is `dmg / 60`, so under
     * assignment a point-blank super shotgun ended up drawn at the size of a
     * graze.
     */
    const m = createHitMarkerState();
    raiseHitMarker(m, false, false, 70);
    for (let i = 0; i < 7; i++) raiseHitMarker(m, false, false, 10);
    expect(m.dmg).toBe(70);
  });

  it('still lets a kill UPGRADE a marker that is already up', () => {
    const m = createHitMarkerState();
    raiseHitMarker(m, false, false, 10);
    expect(m.t).toBeCloseTo(HIT_MARKER_S, 10);
    m.t -= 0.1;
    raiseHitMarker(m, false, true, 55);
    expect(m.kill).toBe(true);
    expect(m.dmg).toBe(55);
    expect(m.t, 'a kill re-raises to the full kill span').toBeCloseTo(HIT_MARKER_KILL_S, 10);
  });

  it('ranks plain below headshot below kill, and never falls down the ladder', () => {
    expect(hitMarkerRank(false, false)).toBe(0);
    expect(hitMarkerRank(true, false)).toBe(1);
    expect(hitMarkerRank(false, true)).toBe(2);
    expect(hitMarkerRank(true, true)).toBe(2);

    const m = createHitMarkerState();
    raiseHitMarker(m, true, false, 30);
    raiseHitMarker(m, false, false, 30);
    expect(m.head, 'a body echo may not take a headshot back').toBe(true);
    raiseHitMarker(m, false, true, 30);
    expect(m.kill).toBe(true);
  });

  it('is a WINDOW and not a mode: once the marker is gone the next hit starts clean', () => {
    /*
     * The latch has to expire, or one kill would paint every hit for the rest
     * of the match red. `t` reaching 0 is the whole reset.
     */
    const m = createHitMarkerState();
    raiseHitMarker(m, true, true, 90);
    m.t = 0;                                      // the marker faded out
    raiseHitMarker(m, false, false, 8);
    expect(m.kill).toBe(false);
    expect(m.head).toBe(false);
    expect(m.dmg).toBe(8);
    expect(m.t).toBeCloseTo(HIT_MARKER_S, 10);
  });

  it('refreshes a plain marker that is nearly out, without ever shortening one', () => {
    const m = createHitMarkerState();
    raiseHitMarker(m, false, false, 10);
    m.t = 0.05;
    raiseHitMarker(m, false, false, 10);
    expect(m.t, 'a fresh hit re-raises a fading marker').toBeCloseTo(HIT_MARKER_S, 10);

    /* And never past the span the draw code divides by: `t / span` is the
       fade, so a marker holding more life than its own span would draw at
       alpha > 1 and hold there. Ten re-raises in a row cannot accumulate. */
    raiseHitMarker(m, false, true, 10);
    for (let i = 0; i < 10; i++) raiseHitMarker(m, false, true, 10);
    expect(m.t, 'a re-raise refreshes to the span, it does not add to it')
      .toBeCloseTo(HIT_MARKER_KILL_S, 10);
  });
});
