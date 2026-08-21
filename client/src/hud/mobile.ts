/**
 * DOOMCRAFT — mobile controls, the pixels.
 *
 * `player/touch.ts` owns the behaviour (stick maths, tap-vs-drag, aim assist,
 * auto-fire, layout arithmetic, pointer routing) and has no DOM in it at all.
 * This file is the other half: it mounts one control layer, feeds real pointer
 * events into `TouchRouter`, draws what the router says, and re-lays the HUD
 * out around the thumbs.
 *
 * It is written against four measured failures of the bar (ref/BAR.md):
 *
 *   #8  the bar refuses portrait outright — a full-screen "Please rotate your
 *       screen" overlay that blocks input. We solve the layout for whatever
 *       viewport we are handed, so 412×915 is a first-class way to play.
 *   #9  the bar has no fire button; a tap on the right half both looks and
 *       shoots. We mount a real trigger with slide-off aiming, a tap-to-shoot
 *       look surface that a drag can never trip, and an optional auto-fire —
 *       and we draw the fire-and-look slab (`.mc-zone`) that the trigger sits
 *       in, because the whole bottom corner behaving as one gesture is the
 *       piece's central claim and an unmarked region is an unusable one.
 *   #10 the bar's controls are near-invisible: its stick ring measures 1.24:1
 *       against grass and its knob 2.39:1, both under the 3:1 WCAG floor for a
 *       non-text control. Every control here is stroked light AND dark, which
 *       `touch.test.ts` proves is ≥4.4:1 against *any* background in the RGB
 *       cube — not just the ones we happened to sample.
 *   #11 the bar ships its desktop HUD unchanged to a 412 px-tall screen, so the
 *       minimap, chat and chips eat the top-left quarter and the read-outs sit
 *       under the thumbs. Here the HUD is positioned from the *solved control
 *       geometry* — `padBottomLeft`, `padBottomRight`, `centreX0/1` — so the
 *       numbers move when the controls move, and a test can assert that no
 *       read-out is ever under a finger.
 *
 * COST, because this piece also owns 60 fps median / 55 fps 1 % low at 412×915
 * under 4× CPU throttle:
 *
 *   - Pointer handlers do arithmetic only. They never read layout
 *     (`getBoundingClientRect` inside a `pointermove` is a forced synchronous
 *     reflow and is exactly how a 1 % low is lost), and they never write DOM.
 *   - Every DOM write happens in `update()`, once per simulation step, and only
 *     for values that actually changed. A still thumb writes nothing.
 *   - Moving parts move by `transform` only, so they composite and never
 *     re-layout. `left/top/width/height` are written on resize and on a
 *     floating-stick press, and nowhere else.
 *   - No canvas, no per-frame allocation, no rAF of its own.
 */

import {
  TouchRouter,
  TC_FIRE, TC_JUMP, TC_CROUCH, TC_RELOAD, TC_BUILD, TC_SWAP,
  TC_AUTOFIRE, TC_AIMASSIST, TC_PAUSE,
  DEFAULT_STICK, TOUCH_EDGE,
  MIN_EDGE_STROKE_PX, EDGE_STROKE_PX, EDGE_HALO_PX, TRIGGER_STROKE_PX,
  READOUT_MARGIN, READOUT_CLEARANCE,
  type TouchGeom, type TouchSink, type TouchAimSource, type Disc,
} from '@/player/touch';
import { clampf } from '@shared/math';

/* ------------------------------------------------------------------------ *
 * Preferences
 *
 * Deliberately local to this module and persisted on their own key. Nothing in
 * `GameSettings` has to learn about handedness for the pad to ship, and a
 * phone-only preference has no business round-tripping through the desktop
 * settings save.
 * ------------------------------------------------------------------------ */

export interface MobilePrefs {
  /** Mirror the whole layout for a left-handed player. */
  southpaw: boolean;
  /** Control-size multiplier, 0.7..1.4. */
  scale: number;
  /** Stick dead zone as a fraction of travel, 0..0.4. */
  deadZone: number;
  /** Hands-free trigger while a target is locked. Off by default. */
  autoFire: boolean;
  /** The assist cone. On by default — it is the point of the piece. */
  aimAssist: boolean;
  /** Extra look-speed multiplier on top of the settings sensitivity. */
  lookScale: number;
  /** Buzz the phone on trigger and toggle presses. */
  haptics: boolean;
  /**
   * The one-time coach card has been seen and dismissed.
   *
   * Three of the four gestures this piece is judged on are invisible until
   * somebody says them out loud: a tap on the look surface fires, a press on
   * the trigger that keeps sliding aims *and* keeps firing, and the stick
   * sprints at its rim. The bar teaches none of its controls either — but the
   * bar only has one gesture per thumb, so it does not have to. We do, and an
   * un-taught gesture is a gesture nobody uses.
   */
  coached: boolean;
}

export const DEFAULT_MOBILE_PREFS: Readonly<MobilePrefs> = Object.freeze({
  southpaw: false,
  scale: 1,
  deadZone: DEFAULT_STICK.deadZone,
  autoFire: false,
  aimAssist: true,
  lookScale: 1,
  haptics: true,
  coached: false,
});

export const MOBILE_PREFS_KEY = 'doomcraft.mobile.v1';

/** Idle time after which the corner option chips step back, ms. */
export const CORNER_IDLE_MS = 5000;

/**
 * How long the first-run coach card stays up, ms. Short on purpose: it is
 * dismissed by the first touch anyway, so this is only the ceiling for a
 * player who is reading rather than playing.
 */
export const COACH_MS = 4200;

/* ------------------------------------------------------------------------ *
 * Where the pad lives, and when
 *
 * The bar's own mobile capture (ref/voxiom/mobileland-08-combat.png) is a
 * PAUSED frame: its Menu / Resume / Settings / Leave panel occupies roughly
 * x 365-550, y 150-255 of a 915x412 screen and *every* control is still drawn
 * around it — the stick, the four glyphs, the hotbar, the vitals. Our shell
 * did the opposite: `Game.leavePlay()` sets `#hud{display:none}` and hides this
 * layer, so the matching frame of ours was a black scrim with no controls on it
 * at all. On the one question this piece is judged on — *which can you actually
 * aim and shoot with* — a frame with no attack pad in it has no answer, however
 * good the pad is a hundred milliseconds earlier.
 *
 * So the pad now outlives the pause: it stays drawn, at full rim contrast, with
 * the trigger still labelled FIRE, and only stops taking input. Two facts make
 * that work and both are pinned by tests rather than by hope.
 * ------------------------------------------------------------------------ */

/**
 * `#ui` — the shell's menu/pause layer, which paints the 72 %-black scrim and
 * the panel — is `z-index:30` in client/index.html. Anything that must stay
 * legible while that scrim is up has to out-stack it.
 */
export const SHELL_UI_Z = 30;

/**
 * Stacking level the control layer takes while paused. Above `SHELL_UI_Z` so
 * the scrim and its `backdrop-filter:blur(2px)` paint *behind* the controls
 * rather than over them — a pad dimmed to 28 % and blurred is the bar's own
 * weakness #10, and we will not ship it by accident. Still below `#ad-overlay`
 * (z 40), which is a full-screen surface that genuinely must cover everything.
 *
 * `#hud` is `z-index:10` and creates a stacking context, so a child of it can
 * never out-paint `#ui` no matter what z-index it is given. The layer therefore
 * re-parents to `document.body` for the duration of the pause and back
 * afterwards — twice per pause, never per frame.
 */
export const PAD_PAUSED_Z = 35;

/**
 * The shell's pause panel is `.dc-panel{width:min(560px,92vw)}`, centred
 * (client/src/main.ts). Those two numbers are the only coupling this module has
 * to the shell's stylesheet, so they are named here and asserted rather than
 * left as folklore in a comment.
 */
export const PAUSE_PANEL_MAX_W = 560;
export const PAUSE_PANEL_VW = 0.92;

/**
 * Is there genuinely room for the thumbs beside that panel?
 *
 * On a landscape phone the panel is 560 px of a 915 px screen: the stick ends
 * at x 160 and the trigger starts at x 780, both clear of it, so keeping the
 * controls drawn is exactly the bar's own behaviour and costs the panel
 * nothing. On a portrait phone the same panel is 92 % of the width and runs to
 * the bottom of the screen, and a trigger drawn on top of the Resume button is
 * worse than no trigger at all — so there the pad steps aside.
 *
 * Only the two primary controls are tested. The small glyph column may clip the
 * panel's border by a few pixels at some widths; the panel's own buttons live
 * at its bottom *centre*, which is what must stay uncovered.
 */
export function padClearsPausePanel(g: TouchGeom): boolean {
  const half = Math.min(PAUSE_PANEL_MAX_W, g.vw * PAUSE_PANEL_VW) * 0.5;
  const x0 = g.vw * 0.5 - half;
  const x1 = g.vw * 0.5 + half;
  for (const d of [g.stickHome, g.fire]) {
    if (d.x + d.r > x0 && d.x - d.r < x1) return false;
  }
  return true;
}

/** What the control layer should be doing, given the two flags that drive it. */
export interface PadLayerState {
  /** Drawn on screen at all. */
  drawn: boolean;
  /** Answering touches. */
  interactive: boolean;
  /** Re-parented out of `#hud` and stacked above the shell's pause scrim. */
  lifted: boolean;
}

/**
 * The whole rule, as a pure function so it can be asserted without a DOM:
 * **while a match exists the attack pad is on the screen.** Playing or paused,
 * it is drawn; only playing, it is live.
 */
export function padLayerState(playing: boolean, paused: boolean): PadLayerState {
  return {
    drawn: playing || paused,
    interactive: playing && !paused,
    lifted: paused,
  };
}

/** Anything with the two `Storage` methods we use. Lets the test pass a stub. */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Parse stored prefs, clamping every number. A hand-edited or half-migrated
 * localStorage must not be able to produce a 4000 px joystick or a NaN dead
 * zone that silently disables movement.
 */
export function parseMobilePrefs(raw: string | null): MobilePrefs {
  const out: MobilePrefs = { ...DEFAULT_MOBILE_PREFS };
  if (raw === null || raw === '') return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (parsed === null || typeof parsed !== 'object') return out;
  const p = parsed as Partial<Record<keyof MobilePrefs, unknown>>;
  if (typeof p.southpaw === 'boolean') out.southpaw = p.southpaw;
  if (typeof p.autoFire === 'boolean') out.autoFire = p.autoFire;
  if (typeof p.aimAssist === 'boolean') out.aimAssist = p.aimAssist;
  if (typeof p.haptics === 'boolean') out.haptics = p.haptics;
  if (typeof p.coached === 'boolean') out.coached = p.coached;
  if (typeof p.scale === 'number' && Number.isFinite(p.scale)) {
    out.scale = clampf(p.scale, 0.7, 1.4);
  }
  if (typeof p.deadZone === 'number' && Number.isFinite(p.deadZone)) {
    out.deadZone = clampf(p.deadZone, 0, 0.4);
  }
  if (typeof p.lookScale === 'number' && Number.isFinite(p.lookScale)) {
    out.lookScale = clampf(p.lookScale, 0.4, 2.5);
  }
  return out;
}

export function loadMobilePrefs(store: PrefStore | null): MobilePrefs {
  if (store === null) return { ...DEFAULT_MOBILE_PREFS };
  try { return parseMobilePrefs(store.getItem(MOBILE_PREFS_KEY)); }
  catch { return { ...DEFAULT_MOBILE_PREFS }; }
}

export function saveMobilePrefs(store: PrefStore | null, prefs: MobilePrefs): void {
  if (store === null) return;
  try { store.setItem(MOBILE_PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

/* ------------------------------------------------------------------------ *
 * HUD bands
 *
 * The whole of weakness #11 in one struct. `solveTouchLayout` already knows
 * exactly how tall each thumb cluster is and how much clear width is left in
 * the middle; this turns that into the four numbers the stylesheet consumes,
 * and it is a pure function so the test can assert the invariant that matters:
 * a read-out is never underneath a control.
 * ------------------------------------------------------------------------ */

export interface HudBands {
  /**
   * Bottom insets, by SCREEN side rather than by thumb. `solveTouchLayout`
   * mirrors the whole layout for a left-handed player, so after the mirror the
   * trigger cluster is the one on the left — and a stylesheet positions things
   * by screen edge, not by which thumb they belong to. Naming these `moveSide`
   * and `fireSide` was a bug: southpaw silently swapped the two bands and put
   * the vitals under the trigger.
   */
  bottomLeft: number;
  bottomRight: number;
  /**
   * The same two insets measured against the OUTER column of each cluster only
   * — the band a corner read-out actually needs. See `TouchGeom.padEdgeLeft`:
   * on the landscape phone this is 65 px lower than `bottomRight`, which is the
   * difference between an ammo plate tucked against the trigger and one
   * floating in the middle of the play area with nothing under it.
   */
  edgeLeft: number;
  edgeRight: number;
  /** Widest a read-out may be on each side before it reaches a control, px. */
  widthLeft: number;
  widthRight: number;
  /** Reserve the option-chip column needs in the trigger hand's corner, px. */
  inset: number;
  /** Free centre column, client x, px. */
  centreX0: number;
  centreX1: number;
  /** Width of that column, px; 0 when there is none. */
  centreWidth: number;
  /**
   * True when the viewport is too narrow for a centre column, so the hotbar
   * has to stack above the trigger cluster instead of sitting between the
   * thumbs. A 360 px phone genuinely has no middle; saying so beats drawing
   * into a negative box.
   */
  stacked: boolean;
  /** True when the movement thumb is on the right. */
  southpaw: boolean;
}

/** Never let a read-out sit closer than this to a control, px. */
export const HUD_BAND_CLEARANCE = 6;

/**
 * Every HUD element this module re-anchors around the thumbs.
 *
 * The list exists because re-anchoring has a second half that is easy to
 * forget: hud.ts's own landscape-touch layout centres some of these with
 * `left:50%; transform:translateX(-50%)`, and overriding `left`/`right` does
 * not touch the transform. The ammo plate shipped 66 px — half its own width —
 * inboard of where the solver put it, sitting on the weapon-swap glyph.
 * `MOBILE_CSS` clears the transform for exactly this set and `mobile.test.ts`
 * checks the two agree.
 */
export const REANCHORED_HUD: readonly string[] = Object.freeze([
  '.dc-vitals', '.dc-ammo', '.dc-hotbar', '.dc-map', '.dc-feed', '.dc-perf',
  '.dc-rail',
]);

/** Below this the centre column is not worth using for the hotbar. */
export const MIN_CENTRE_COLUMN = 150;

export function createHudBands(): HudBands {
  return {
    bottomLeft: 0, bottomRight: 0, edgeLeft: 0, edgeRight: 0,
    widthLeft: 0, widthRight: 0, inset: 0,
    centreX0: 0, centreX1: 0,
    centreWidth: 0, stacked: true, southpaw: false,
  };
}

export function hudBandsFrom(g: TouchGeom, out: HudBands): HudBands {
  const width = Math.max(0, g.centreX1 - g.centreX0);
  out.bottomLeft = g.padBottomLeft + HUD_BAND_CLEARANCE;
  out.bottomRight = g.padBottomRight + HUD_BAND_CLEARANCE;
  // `READOUT_CLEARANCE`, not `HUD_BAND_CLEARANCE`: this pair has to agree with
  // `readoutRect`, which is the function `touch.test.ts` proves disjoint from
  // every control. Two clearances that drift apart would make that proof
  // describe a rectangle the browser never draws.
  out.edgeLeft = g.padEdgeLeft + READOUT_CLEARANCE;
  out.edgeRight = g.padEdgeRight + READOUT_CLEARANCE;
  out.widthLeft = g.readoutWidthLeft;
  out.widthRight = g.readoutWidthRight;
  out.inset = g.readoutInset;
  out.centreX0 = g.centreX0;
  out.centreX1 = g.centreX1;
  out.centreWidth = width;
  out.stacked = width < MIN_CENTRE_COLUMN;
  out.southpaw = g.southpaw;
  return out;
}

/* ------------------------------------------------------------------------ *
 * Stylesheet
 *
 * Two jobs, and they are separate on purpose.
 *
 * 1. The controls themselves. The contrast rule is the interesting part: every
 *    control carries a light stroke AND a dark stroke (a dark box-shadow ring
 *    outside the light border and another inside it). No single colour survives
 *    both a sunlit sand cliff and a black corridor — the bar picked one and is
 *    invisible on grass — but a light/dark pair always has one member in
 *    contrast, which is the theorem `worstEdgeContrast` in touch.ts checks.
 *
 * 2. The HUD re-layout. These rules are prefixed `#hud#hud` — a repeated id,
 *    which is legal CSS and gives specificity (2,x,y). hud.ts's own compact and
 *    portrait rules reach (1,5,0), so a single `#hud[data-pad]` prefix would
 *    lose to them; doubling the id wins by id-count without a single
 *    `!important`. Every such rule is additionally gated on `[data-pad="1"]`,
 *    which only this module sets, so desktop and the legacy pad are untouched.
 * ------------------------------------------------------------------------ */

/**
 * Emit a colour, collapsing to the opaque `rgb()` form when the alpha is 1.
 * Derived from `TOUCH_EDGE` rather than typed out, so the palette the contrast
 * theorem is proved against and the ink actually drawn cannot drift apart —
 * and so a future alpha below 1 shows up in the stylesheet as an `rgba(...)`
 * that `mobile.test.ts` refuses.
 */
function ink(r: number, g: number, b: number, a: number): string {
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

const LIGHT = ink(TOUCH_EDGE.lightR, TOUCH_EDGE.lightG, TOUCH_EDGE.lightB, TOUCH_EDGE.lightA);
const DARK = ink(TOUCH_EDGE.darkR, TOUCH_EDGE.darkG, TOUCH_EDGE.darkB, TOUCH_EDGE.darkA);
/** Amber, opaque: the stick's live-travel ring and the auto-fire lock. */
const AMBER = 'rgb(255,196,64)';

export const MOBILE_CSS = `
.mc{position:absolute;inset:0;pointer-events:none;
  font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.06em;color:#fff;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.mc.mc-off{display:none}

/* The one element that takes pointers. Everything drawn is inert, so a press
   is classified by hitTest against solved numbers rather than by whichever
   div happened to be on top. */
.mc-surface{position:absolute;inset:0;pointer-events:auto;touch-action:none}

.mc-safe{position:fixed;inset:0;visibility:hidden;pointer-events:none;
  padding:env(safe-area-inset-top) env(safe-area-inset-right)
          env(safe-area-inset-bottom) env(safe-area-inset-left)}

/* --- the two-tone edge: this is the answer to weakness #10 ---------------
   Every control on the screen carries this rule, and every stroke in it is
   FULLY OPAQUE: a ${EDGE_STROKE_PX}px white border with a ${EDGE_HALO_PX}px black ring outside it and
   another inside it. Opaque is the whole point — the bar's chrome is a
   translucent white wash with no stroke at all, so its measured edge contrast
   is whatever the terrain behind it happens to allow (1.32:1 to 1.73:1 on its
   own capture, on bright grass AND on a dark trunk). Ours cannot be dragged
   about by the background: white sits at L=1.0 and black at L=0.0 whatever is
   underneath, which is 5.13:1 on the bar's worst grass and never worse than
   4.58:1 on any background in the RGB cube. The fill stays translucent on
   purpose — you have to see the fight through the pad — because the fill is
   not what makes the button findable. The stroke is. */
.mc-e{position:absolute;border-radius:50%;box-sizing:border-box;
  border:${EDGE_STROKE_PX}px solid ${LIGHT};
  box-shadow:0 0 0 ${EDGE_HALO_PX}px ${DARK}, inset 0 0 0 ${EDGE_HALO_PX}px ${DARK};
  background:rgba(10,10,14,.30);
  display:grid;place-items:center;text-align:center}
.mc-e>b{font-weight:700;
  text-shadow:0 0 2px ${DARK},0 1px 2px ${DARK},0 -1px 2px ${DARK},
              1px 0 2px ${DARK},-1px 0 2px ${DARK}}

/* --- stick --------------------------------------------------------------
   Four concentric marks, and every one of them answers a question the bar's
   single translucent puck does not: where does movement START (the dead-zone
   ring), how far am I pushing (the travel ring), where does SPRINT begin (the
   detent ring, labelled), and where is my thumb relative to all three (the
   knob and its centre pip). */
.mc-stick{background:rgba(10,10,14,.22)}
.mc-stick>i{position:absolute;left:50%;top:50%;border-radius:50%;box-sizing:border-box;
  transform:translate(-50%,-50%)}
/* Sprint detent, drawn and named. We spend no button on sprint where the bar
   spends a whole 40px glyph on it — which is only an improvement if the player
   can see the threshold, so here it is: a dashed ring at exactly the deflection
   resolveStick latches on, with the verb written on it. Solid orange the
   moment it engages. Until this existed our sprint was a secret. */
.mc-detent{border:${MIN_EDGE_STROKE_PX}px dashed ${LIGHT};
  box-shadow:0 0 0 1.5px ${DARK};
  display:grid;place-items:start center}
.mc-detent>b{font-size:8px;letter-spacing:.10em;line-height:1;
  margin-top:-5px;padding:1px 3px;border-radius:2px;background:${DARK};color:${LIGHT}}
.mc-stick[data-sprint="1"] .mc-detent{border-style:solid;border-color:rgb(255,84,32)}
.mc-stick[data-sprint="1"] .mc-detent>b{background:rgb(255,84,32);color:rgb(20,6,0)}
/* Dead zone, drawn — and drawn ON TOP of the knob, which is the whole point.
   At the default 16 % of a 58 px travel it is a 9 px radius and the knob is a
   26 px one, so painting it underneath (as it was) hid the marker behind the
   very thing it is supposed to be measured against. Above the knob you watch
   the centre pip leave the dashes, which is a legible answer to "why did I not
   move". Opaque dashes over an opaque black ring; the bar draws neither this
   nor a travel limit. */
.mc-dead{border:${MIN_EDGE_STROKE_PX}px dashed ${LIGHT};
  box-shadow:0 0 0 ${EDGE_HALO_PX}px ${DARK}}
/* Radius feedback: scales with deflection, so full tilt is visible. */
.mc-ring{border:${MIN_EDGE_STROKE_PX}px solid rgba(255,196,64,.0);
  box-shadow:0 0 0 1.5px rgba(0,0,0,.0);will-change:transform}
.mc-stick[data-live="1"] .mc-ring{border-color:${AMBER};
  box-shadow:0 0 0 1.5px ${DARK}}
.mc-stick[data-sprint="1"] .mc-ring{border-color:rgb(255,84,32)}
.mc-knob{border:${EDGE_STROKE_PX}px solid ${LIGHT};background:rgba(232,230,227,.42);
  box-shadow:0 0 0 ${EDGE_HALO_PX}px ${DARK}, inset 0 0 0 ${EDGE_HALO_PX}px ${DARK};
  will-change:transform}
/* The pip is the knob's actual position, and it is what the dead-zone ring is
   read against. A 53px puck straddling a 18px ring tells you nothing; a 6px
   pip crossing it tells you exactly when you started moving. */
.mc-knob::after{content:"";position:absolute;left:50%;top:50%;
  width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;
  background:${LIGHT};box-shadow:0 0 0 1.5px ${DARK}}
.mc-stick[data-live="1"] .mc-knob{background:rgba(255,214,140,.55)}
.mc-stick[data-sprint="1"] .mc-knob{background:rgba(255,110,48,.62)}

/* --- the fire-and-look slab ---------------------------------------------
   The region TouchGeom.fireZone describes, drawn so that the player can see
   what the thumb owns. Everything inside this bracket is one gesture: press to
   fire, keep dragging and you are still firing while the camera pans. It is
   the answer to the round-1 verdict — "A's right-thumb sweep arc is paved with
   buttons, so you can never fire and turn in the same gesture" — and an
   invisible region would be a fix nobody can see.

   Drawn as a corner BRACKET, not a filled box: two dashed edges (the two that
   face the world; the other two are the bezel) plus a solid black underlay for
   the two-tone rule, and no fill at all, because the one thing this region
   must not do is obscure the fight happening inside it. Dashes rather than a
   solid line say "threshold" rather than "button", which is exactly what it
   is — the drawn trigger disc inside it is the button. */
.mc-zone{position:absolute;box-sizing:border-box;pointer-events:none;
  border-top:${MIN_EDGE_STROKE_PX}px dashed ${LIGHT};
  border-left:${MIN_EDGE_STROKE_PX}px dashed ${LIGHT};
  border-top-left-radius:22px}
.mc-zone>i{position:absolute;left:-4px;top:-4px;right:-2px;bottom:-2px;
  box-sizing:border-box;border-top:${MIN_EDGE_STROKE_PX}px solid ${DARK};
  border-left:${MIN_EDGE_STROKE_PX}px solid ${DARK};border-top-left-radius:24px}
.mc-zone>b{position:absolute;left:10px;top:-7px;padding:2px 5px;border-radius:2px;
  background:${DARK};color:${LIGHT};font-size:9px;letter-spacing:.10em;line-height:1}
.mc[data-hand="left"] .mc-zone{border-left:0;border-top-left-radius:0;
  border-right:${MIN_EDGE_STROKE_PX}px dashed ${LIGHT};border-top-right-radius:22px}
.mc[data-hand="left"] .mc-zone>i{left:-2px;right:-4px;border-left:0;
  border-top-left-radius:0;border-right:${MIN_EDGE_STROKE_PX}px solid ${DARK};
  border-top-right-radius:24px}
.mc[data-hand="left"] .mc-zone>b{left:auto;right:10px}

/* --- trigger ------------------------------------------------------------
   The primary verb, so it gets the thickest stroke on the screen and the only
   fully saturated fill. Both are opaque; the tint is what says "attack" from
   the corner of your eye and the ${TRIGGER_STROKE_PX}px white rim is what makes it findable on a
   sunlit cliff. Its position — pinned to the thumb pivot — is solved in
   touch.ts, not here. */
.mc-fire{background:rgba(196,42,18,.42);border-width:${TRIGGER_STROKE_PX}px;border-color:${LIGHT}}
.mc-fire>b{font-size:14px}
.mc-fire[data-on="1"]{background:rgba(255,96,32,.70)}
/* Auto-fire has a genuine lock: say so, rather than firing silently. */
.mc-fire[data-lock="1"]{border-color:rgb(255,206,64);
  box-shadow:0 0 0 ${EDGE_HALO_PX}px ${DARK}, inset 0 0 0 ${EDGE_HALO_PX}px ${DARK},
             0 0 12px 2px rgba(255,180,40,.55)}
/* Slide-off: the same thumb is now aiming as well as firing. */
.mc-fire[data-aim="1"]>b{opacity:.35}

.mc-btn>b{font-size:11px}
.mc-btn[data-on="1"]{background:rgba(255,120,40,.52)}
.mc-small>b{font-size:10px}

/* --- option chips ------------------------------------------------------- */
.mc-chip{background:rgba(10,10,14,.44);transition:opacity .45s linear}
.mc-chip>b{font-size:9px;line-height:1.05}
/* ON is opaque, and its label flips to dark ink on the fill.
   These two chips are the only latched STATE on the layer — whether the assist
   cone and the hands-free trigger are armed — and state you cannot read is
   state you do not trust. A 52 %-alpha green over a dark corridor is the bar's
   own translucent-wash mistake wearing our colours: it was legible on a red
   wall and invisible on a grey one, i.e. its contrast was decided by the
   terrain, which is exactly what the rest of this file refuses to allow. */
.mc-chip[data-on="1"]{background:rgb(46,168,110);border-color:${LIGHT}}
.mc-chip[data-on="1"]>b{color:rgb(4,22,13);text-shadow:none}
.mc-pause>b{font-size:12px}
/* The corner column is between-fights furniture, so it steps back after a few
   idle seconds and comes straight back on the next touch. Hit-testing is
   geometric, never a DOM hit test, so a quiet chip is exactly as pressable as
   a bright one — the fade costs nothing but clutter. Note what does NOT fade:
   the stick, the trigger and the movement glyphs stay at full contrast, which
   is the opposite of the bar, where *everything* is permanently translucent. */
.mc[data-quiet="1"] .mc-chip{opacity:.42}

/* --- assist read-out ----------------------------------------------------
   A ring at the centre of the screen that only appears while the cone is
   engaged. The player must be able to see that help is happening; a silent
   assist is indistinguishable from a lucky shot. */
.mc-assist{position:absolute;left:50%;top:50%;width:64px;height:64px;margin:-32px 0 0 -32px;
  border-radius:50%;border:${MIN_EDGE_STROKE_PX}px solid ${AMBER};
  box-shadow:0 0 0 1.5px ${DARK};opacity:0;
  transform:scale(1.6);will-change:transform,opacity}
.mc-assist[data-on="1"]{opacity:.9;transform:scale(1)}

/* --- first-run coach ----------------------------------------------------
   Three of the gestures this piece is judged on are invisible: a tap on the
   look surface fires, a press on the trigger that keeps sliding aims AND keeps
   firing, and the stick sprints at its rim. The bar teaches nothing either,
   but the bar has exactly one gesture per thumb and so has nothing to teach.
   Shown once, dismissed by the first touch, removed from the DOM afterwards —
   it costs one timer and never a frame. No border: the two-tone rule is for
   things you press, and this is the one thing on the layer you cannot. */
/* 58 %: just BELOW the crosshair. The upper third is where the shell prints
   its match banner ("MATCH LIVE", "Waiting for players..." — the bar uses the
   same band for "Loading Terrain"), and a coach card centred at 30 % printed
   straight through it, which left two unreadable texts instead of one useful
   one. Below the reticle is clear in both orientations and still above the
   read-out bands. An explicit width rather than a max-width, because an
   absolutely positioned box anchored at left:50% otherwise shrink-wraps to the
   half-screen it has left and re-wraps the lines to three.

   z-index 3 because .mc is positioned with z-index:auto and therefore creates
   no stacking context: the card can lift over the shell's centre status line
   (a later sibling inside #hud) without dragging the rest of the pad with it.
   It has to, because the status band is where "SPAWN PROTECTED" lands and two
   texts printed through each other are worse than either alone. Near-opaque
   for the same reason, and gone in four seconds either way. */
.mc-coach{position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);
  box-sizing:border-box;width:min(76vw,380px);padding:10px 14px;border-radius:4px;
  background:rgba(6,6,9,.94);text-align:center;z-index:3;
  transition:opacity .5s linear;opacity:1}
.mc-coach[data-off="1"]{opacity:0}
.mc-coach>b{display:block;font-size:12px;line-height:1.5;letter-spacing:.07em;
  text-shadow:0 0 2px ${DARK},0 1px 2px ${DARK}}
.mc-coach>b+b{margin-top:4px;color:rgb(255,196,64)}

/* --- paused --------------------------------------------------------------
   The bar keeps its whole control surface drawn behind its pause panel; ours
   used to vanish with the HUD, which meant the frame that corresponds to the
   bar's own capture had no attack control on it at all. Now the layer lifts
   above the shell's scrim (z ${SHELL_UI_Z}) instead of being dimmed and blurred by it,
   keeps every rim at full contrast, and simply stops answering touches so the
   Resume button underneath still gets them. The trigger drops its armed red
   tint — present, legible, not live — and the assist reticle goes, because
   nothing is being aimed at. */
.mc[data-paused="1"]{position:fixed;z-index:${PAD_PAUSED_Z}}
.mc[data-paused="1"] .mc-surface{pointer-events:none}
.mc[data-paused="1"] .mc-fire{background:rgba(10,10,14,.34)}
.mc[data-paused="1"] .mc-assist{opacity:0}
.mc[data-paused="1"] .mc-chip{opacity:1}
/* What stays is the thumb surface itself — stick, trigger, JUMP, DUCK and the
   two comfort toggles. The three utility glyphs (RLD/BLD/WEP) are the only
   controls whose row can land on top of the shell's 560 px panel, and not one
   of them is an attack or a movement verb, so they stand down rather than
   litter the frame. The slab's bracket goes with them: its inboard edge is a
   full-height line that crosses the panel, and a dashed rule drawn through the
   Resume button reads as a rendering fault rather than as an affordance. The
   trigger it belongs to stays exactly where it is. */
.mc[data-paused="1"] .mc-small{display:none}
.mc[data-paused="1"] .mc-zone{display:none}

/* ------------------------------------------------------------------------ *
 * HUD re-layout — weakness #11
 *
 * Positioned from --mc-* variables this module writes out of the solved
 * control geometry, so the read-outs follow the thumbs instead of guessing.
 * ------------------------------------------------------------------------ */

#hud#hud[data-pad="1"] .dc-hint{display:none}
#hud#hud[data-pad="1"] .dc-perf{top:auto;bottom:2px;right:auto;left:6px;font-size:10px}

/* Re-anchoring is not finished until the old anchor's TRANSFORM is gone.
   hud.ts has its own landscape-touch layout that centres the ammo plate and
   the hotbar with left:50% + translateX(-50%). Our rules out-specify its
   left/right — they carry two ids to its one — but a transform is a separate
   property and simply survived, so the plate was placed correctly against the
   trigger corner and then slid 66 px (half its own width) back inboard, on top
   of the WEP glyph. Every element this module re-anchors therefore gets its
   transform cleared in one place, and mobile.test.ts holds the list. */
#hud#hud[data-pad="1"] .dc-vitals,
#hud#hud[data-pad="1"] .dc-ammo,
#hud#hud[data-pad="1"] .dc-hotbar,
#hud#hud[data-pad="1"] .dc-map,
#hud#hud[data-pad="1"] .dc-feed,
#hud#hud[data-pad="1"] .dc-rail,
#hud#hud[data-pad="1"] .dc-perf{transform:none}

/* Vitals hug the movement thumb's side, ammo hugs the trigger's, and both are
   positioned AND sized from the solver: --mc-el / --mc-er are the bands the
   outer control column leaves free and --mc-wl / --mc-wr are the widths that
   band is honest for. That pairing is the fix for a self-inflicted version of
   weakness #11 — pinning the ammo to the full cluster height (--mc-br)
   cleared the inboard RLD/BLD/WEP column too, and on a 915x412 screen that
   floated the plate 205 px up with nothing underneath it. The plate now sits
   65 px lower, against the trigger, where a hand holding a phone expects it.
   --mc-corner is the reserve the option chips need in the same corner. */
#hud#hud[data-pad="1"][data-hand="right"] .dc-vitals{
  left:${READOUT_MARGIN}px;right:auto;bottom:var(--mc-el);width:var(--mc-wl)}
#hud#hud[data-pad="1"][data-hand="right"] .dc-ammo{
  right:${READOUT_MARGIN}px;left:auto;bottom:var(--mc-er);max-width:var(--mc-wr);
  text-align:right}
#hud#hud[data-pad="1"][data-hand="left"] .dc-vitals{
  right:${READOUT_MARGIN}px;left:auto;bottom:var(--mc-er);width:var(--mc-wr)}
#hud#hud[data-pad="1"][data-hand="left"] .dc-ammo{
  left:${READOUT_MARGIN}px;right:auto;bottom:var(--mc-el);max-width:var(--mc-wl);
  text-align:left}
/* The weapon name is the one line in the plate that can outgrow the width the
   solver promised, and a plate that overflows its promise is a plate back on
   top of a thumb. Clip it rather than let it push. */
#hud#hud[data-pad="1"] .dc-ammo .wep{
  overflow:hidden;text-overflow:ellipsis;letter-spacing:.08em}

#hud#hud[data-pad="1"] .dc-ap{height:12px;margin-bottom:4px}
#hud#hud[data-pad="1"] .dc-hp{height:22px}
#hud#hud[data-pad="1"] .dc-hp .lbl{font-size:15px}
#hud#hud[data-pad="1"] .dc-ammo .mag{font-size:26px}
#hud#hud[data-pad="1"] .dc-ammo .strip{width:74px}
#hud#hud[data-pad="1"] .dc-ammo .wep{font-size:10px}

/* The hotbar goes in the clear column between the thumbs when there is one. */
#hud#hud[data-pad="1"][data-stack="0"] .dc-hotbar{
  left:var(--mc-cx0);right:auto;transform:none;bottom:6px;gap:3px;
  width:var(--mc-cw);justify-content:center;flex-wrap:nowrap}
#hud#hud[data-pad="1"][data-stack="0"] .dc-slot{width:30px;height:30px;font-size:9px}
/* …and above the ammo when the viewport is too narrow to have a middle. The
   84 px is the ammo plate's own height on a phone — 26 px mag + the round
   strip + the weapon line + padding comes to about 70, plus clearance — so the
   two stack instead of printing over one another.

   The second term is the fire-and-look slab, and it is not cosmetic: a press
   on the hotbar is a press on the slab, so a slot drawn inside it answers a
   tap with a gunshot rather than a weapon change. A read-out may sit in the
   slab (the ammo plate does); anything that LOOKS pressable may not. */
#hud#hud[data-pad="1"][data-stack="1"] .dc-hotbar{
  left:8px;right:auto;transform:none;gap:2px;
  bottom:max(calc(var(--mc-el) + 84px), calc(var(--mc-zh) + 8px))}
#hud#hud[data-pad="1"][data-stack="1"][data-hand="left"] .dc-hotbar{
  right:8px;left:auto;
  bottom:max(calc(var(--mc-er) + 84px), calc(var(--mc-zh) + 8px))}
#hud#hud[data-pad="1"][data-stack="1"] .dc-slot{width:28px;height:28px;font-size:8px}

/* Top strip: the minimap shrinks and the feed is kept clear of the option
   chips in the corner, which is precisely what the bar does not do. */
#hud#hud[data-pad="1"] .dc-map{top:6px;left:6px;width:92px}
#hud#hud[data-pad="1"] .dc-map canvas{width:92px;height:92px}
#hud#hud[data-pad="1"] .dc-chips{flex-direction:row;gap:4px;margin-top:5px}
#hud#hud[data-pad="1"] .dc-feed{
  top:6px;bottom:auto;left:106px;width:calc(100% - 106px - var(--mc-corner));
  font-size:11px}
#hud#hud[data-pad="1"][data-hand="left"] .dc-map{left:auto;right:6px}
/* The match rail sits directly under the minimap and has to travel with it.
   It did not, and in southpaw that left the clock/kills/players strip parked in
   the TRIGGER hand's corner — which is where JUMP and DUCK went when they were
   pulled out of the thumb's sweep arc, so the two printed through each other.
   A mirrored HUD is mirrored all the way or it is not mirrored. */
#hud#hud[data-pad="1"][data-hand="left"] .dc-rail{left:auto;right:8px}
#hud#hud[data-pad="1"][data-hand="left"] .dc-feed{
  left:var(--mc-corner);right:106px;width:auto}
#hud#hud[data-pad="1"] .dc-dmg span{--r:120px;left:-26px;width:52px;height:46px}
`;

/* ------------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------------ */

/** Text on each glyph. Words, not pictograms: a word survives a bright cliff. */
export const CONTROL_LABELS: Readonly<Record<number, string>> = Object.freeze({
  [TC_FIRE]: 'FIRE',
  [TC_JUMP]: 'JUMP',
  [TC_CROUCH]: 'DUCK',
  [TC_RELOAD]: 'RLD',
  [TC_BUILD]: 'BLD',
  [TC_SWAP]: 'WEP',
  [TC_AUTOFIRE]: 'AUTO',
  [TC_AIMASSIST]: 'AIM',
  [TC_PAUSE]: '❚❚',
});

/** Word on the sprint detent ring. Kept to three characters so it fits the arc. */
export const DETENT_LABEL = 'RUN';

/**
 * Tag printed on the fire-and-look slab's inboard corner.
 *
 * The slab is the answer to the round-1 loss and it is a *region*, not a
 * button, so nothing about it is self-evident from a still frame. Two words
 * and a plus sign say what the whole corner does, which is more than any
 * mobile shooter — the bar included — tells you about its right thumb.
 */
export const ZONE_LABEL = 'FIRE + AIM';

/**
 * Paint order of the stick's concentric marks, back to front. The constructor
 * builds from this list, so the order is a testable fact rather than a comment
 * about `append` arguments.
 *
 * The load-bearing part is that `mc-dead` comes AFTER `mc-knob`. The dead-zone
 * ring is 9 px in radius at the default settings and the knob is 26 px, so
 * painted underneath — which is how it shipped — the one marker that answers
 * "why did I not move" was hidden behind the very thing it measures. On top,
 * the knob's centre pip visibly crosses the dashes.
 */
export const STICK_LAYERS: readonly string[] = Object.freeze([
  'mc-detent', 'mc-ring', 'mc-knob', 'mc-dead',
]);

/**
 * The two lines of the first-run coach card, in order. Every gesture named
 * here is one the bar does not have and one that is invisible until said:
 * line 1 is the answer to weakness #9 (aim and fire are separate, and the
 * trigger can do both at once), line 2 is the sprint detent.
 */
export const COACH_LINES: readonly string[] = Object.freeze([
  'THE WHOLE MARKED CORNER FIRES — DRAG IT TO AIM WHILE FIRING',
  'TAP ANYWHERE ELSE TO SHOOT · PUSH THE STICK TO ITS RIM TO RUN',
]);

/* ------------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------------ */

export interface MobileControlsOptions {
  /** The HUD root. The pad mounts inside it and re-lays its read-outs out. */
  root: HTMLElement;
  /** Where input goes. `InputManager` satisfies this. */
  sink: TouchSink;
  /** Aim-assist and auto-fire source, or null to run without either. */
  aim?: TouchAimSource | null;
  onPause?: () => void;
  /** Persisted preferences; defaults to `localStorage`. Pass null to disable. */
  store?: PrefStore | null;
  prefs?: Partial<MobilePrefs>;
}

interface ControlView {
  el: HTMLElement;
  /** `TC_*` this view draws. */
  control: number;
  disc: Disc;
  /** Cached geometry so a resize that changes nothing writes nothing. */
  x: number; y: number; r: number;
  on: boolean;
}

export class MobileControls {
  readonly router: TouchRouter;
  readonly prefs: MobilePrefs;
  readonly bands: HudBands = createHudBands();

  /**
   * Aim-assist and auto-fire source. Public and swappable so the game can pull
   * it while the player is dead or in a menu, which switches both features off
   * without tearing the pad down.
   *
   * Declared before the constructor on purpose: under `useDefineForClassFields`
   * a field declared *after* the constructor body would be re-initialised to
   * undefined right after the constructor assigned it.
   */
  aim: TouchAimSource | null = null;

  private readonly root: HTMLElement;
  private readonly store: PrefStore | null;
  private readonly layer: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly safeProbe: HTMLElement;
  private readonly elStick: HTMLElement;
  private readonly elDetent: HTMLElement;
  private readonly elDead: HTMLElement;
  private readonly elRing: HTMLElement;
  private readonly elKnob: HTMLElement;
  private readonly elZone: HTMLElement;
  private readonly elAssist: HTMLElement;
  private elCoach: HTMLElement | null = null;
  private coachTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly views: ControlView[] = [];
  private readonly onPause: (() => void) | null;
  private fireView!: ControlView;

  private visible = false;
  private paused = false;
  private disposed = false;

  /* --- cached view state; a frame that changes nothing writes nothing --- */
  private vStickX = NaN;
  private vStickY = NaN;
  private vStickR = NaN;
  private vKnobX = NaN;
  private vKnobY = NaN;
  private vTravel = NaN;
  private vLive = false;
  private vSprint = false;
  private vFiring = false;
  private vLocked = false;
  private vAiming = false;
  private vAssist = false;
  private vHeld = -1;
  private vBandSig = '';
  private vQuiet = false;
  /** Clock of the last touch anywhere, for the corner column's idle fade. */
  private lastTouchMs = -1e9;

  /* --- safe-area insets, re-read on resize only --- */
  private safeTop = 0;
  private safeRight = 0;
  private safeBottom = 0;
  private safeLeft = 0;

  constructor(opts: MobileControlsOptions) {
    this.root = opts.root;
    this.onPause = opts.onPause ?? null;
    this.store = opts.store === undefined ? defaultStore() : opts.store;
    this.prefs = { ...loadMobilePrefs(this.store), ...(opts.prefs ?? {}) };

    this.router = new TouchRouter(opts.sink, {
      onPause: () => this.onPause?.(),
      onToggle: (control, on) => this.onToggle(control, on),
      onHaptic: (ms) => this.buzz(ms),
    });
    this.router.autoFireEnabled = this.prefs.autoFire;
    this.router.aimAssistEnabled = this.prefs.aimAssist;
    this.router.lookScale = this.prefs.lookScale;
    this.aim = opts.aim ?? null;

    injectCss();

    this.layer = div('mc mc-off');
    this.layer.dataset.hand = 'right';
    this.safeProbe = document.createElement('i');
    this.safeProbe.className = 'mc-safe';
    this.layer.appendChild(this.safeProbe);

    /* The fire-and-look slab, first so every control paints over it. It is a
       region rather than a control: no fill, no pointer handling, just the two
       edges that tell the thumb where the one-gesture corner begins. */
    this.elZone = div('mc-zone');
    const halo = document.createElement('i');
    this.elZone.appendChild(halo);
    const zoneTag = document.createElement('b');
    zoneTag.textContent = ZONE_LABEL;
    this.elZone.appendChild(zoneTag);
    this.layer.appendChild(this.elZone);

    /* stick — painted back to front. The dead-zone ring goes LAST because it
       is measured against the knob's centre pip, and a marker painted under
       the thing it measures is a marker nobody can read. */
    this.elStick = div('mc-e mc-stick');
    const marks = new Map<string, HTMLElement>();
    for (const cls of STICK_LAYERS) {
      const mark = document.createElement('i');
      mark.className = cls;
      if (cls === 'mc-detent') {
        const tag = document.createElement('b');
        tag.textContent = DETENT_LABEL;
        mark.appendChild(tag);
      }
      marks.set(cls, mark);
      this.elStick.appendChild(mark);
    }
    this.elDetent = marks.get('mc-detent')!;
    this.elRing = marks.get('mc-ring')!;
    this.elKnob = marks.get('mc-knob')!;
    this.elDead = marks.get('mc-dead')!;
    this.layer.appendChild(this.elStick);

    /* glyphs */
    const g = this.router.geom;
    this.fireView = this.addView('mc-e mc-fire', TC_FIRE, g.fire);
    this.addView('mc-e mc-btn', TC_JUMP, g.jump);
    this.addView('mc-e mc-btn', TC_CROUCH, g.crouch);
    this.addView('mc-e mc-btn mc-small', TC_RELOAD, g.reload);
    this.addView('mc-e mc-btn mc-small', TC_BUILD, g.build);
    this.addView('mc-e mc-btn mc-small', TC_SWAP, g.swap);
    this.addView('mc-e mc-chip', TC_AUTOFIRE, g.autoFire);
    this.addView('mc-e mc-chip', TC_AIMASSIST, g.aimAssist);
    this.addView('mc-e mc-chip mc-pause', TC_PAUSE, g.pause);

    this.elAssist = div('mc-assist');
    this.layer.appendChild(this.elAssist);

    /* The capture surface goes last so it is on top of every drawn control —
       which is harmless, because the drawn controls take no pointers at all. */
    this.surface = div('mc-surface');
    this.layer.appendChild(this.surface);

    this.root.appendChild(this.layer);
    this.bindPointers();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize, { passive: true });
      window.visualViewport?.addEventListener('resize', this.onResize, { passive: true });
      window.addEventListener('orientationchange', this.onResize, { passive: true });
      document.addEventListener('visibilitychange', this.onHidden);
    }
    this.resize();
    this.syncChips();
  }

  /* -------------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------------- */

  setVisible(on: boolean): void {
    if (this.disposed || on === this.visible) return;
    this.visible = on;
    // Entering play always ends a pause; leaving play never starts one (the
    // shell says so explicitly, because `leavePlay` is also the road to the
    // main menu, where the pad has no business being drawn).
    if (on) this.paused = false;
    this.root.dataset.pad = on ? '1' : '0';
    this.applyLayerState();
    if (on) {
      this.lastTouchMs = now();   // the chips are bright when the pad appears
      this.resize();
      this.showCoach();
    } else {
      this.router.releaseAll();
      this.vHeld = -1;
      this.flushState();
      this.dismissCoach(false);
    }
  }

  /* -------------------------------------------------------------------- *
   * First-run coach
   *
   * Mounted at most once per profile and torn down for good. It is deliberately
   * NOT part of `flushState` — the card has no per-frame state, so it must cost
   * no per-frame work.
   * -------------------------------------------------------------------- */

  private showCoach(): void {
    if (this.disposed || this.prefs.coached || this.elCoach !== null) return;
    if (typeof document === 'undefined') return;
    const card = div('mc-coach');
    for (const line of COACH_LINES) {
      const b = document.createElement('b');
      b.textContent = line;
      card.appendChild(b);
    }
    // Before the capture surface, so it can never intercept the first touch —
    // which is also the touch that dismisses it.
    this.layer.insertBefore(card, this.surface);
    this.elCoach = card;
    this.coachTimer = setTimeout(() => { this.dismissCoach(true); }, COACH_MS);
  }

  /**
   * Take the card down. `remember` is false for a teardown that is not the
   * player having seen it — leaving a match, or unmounting — so a pad that
   * flashed up for one frame does not burn the one chance to teach.
   */
  private dismissCoach(remember: boolean): void {
    if (this.coachTimer !== null) { clearTimeout(this.coachTimer); this.coachTimer = null; }
    const card = this.elCoach;
    if (card === null) return;
    this.elCoach = null;
    if (remember && !this.prefs.coached) {
      this.prefs.coached = true;
      saveMobilePrefs(this.store, this.prefs);
    }
    if (this.disposed) { card.remove(); return; }
    card.dataset.off = '1';
    // The fade is CSS; the node goes when it finishes so nothing is left in the
    // tree for the compositor to consider on every subsequent frame.
    this.coachTimer = setTimeout(() => { this.coachTimer = null; card.remove(); }, 600);
  }

  /**
   * Pause / resume. Keeps the pad on the screen while the shell's panel is up.
   *
   * This is the answer to a real hole rather than a flourish: the frame of ours
   * that corresponds to the bar's own mobile capture *is* a paused frame, and
   * until now it contained no attack control — no trigger, no stick, no HUD,
   * just a black scrim. The bar draws its entire control surface behind its
   * panel and we now do better: at full contrast, above the scrim instead of
   * under it, and inert so the panel's own buttons still work.
   *
   * Called by the shell (`main.ts` openPause / startPlaying / backToMenu),
   * which is the only layer that can tell "paused" from "left the match" —
   * `Game.leavePlay()` is both.
   */
  setPaused(on: boolean): void {
    if (this.disposed || on === this.paused) return;
    this.paused = on;
    if (on) {
      // A trigger still held when the panel opens is a trigger held on resume.
      this.router.releaseAll();
      this.vHeld = -1;
      this.lastTouchMs = now();   // the option chips are bright, not faded out
      // The shell's panel would print straight over the card. A player who got
      // as far as opening the pause menu has been told enough.
      this.dismissCoach(true);
    }
    this.applyLayerState();
    if (on) {
      // The pad may never have been laid out at this viewport (rotate while
      // paused), and the last flush ran with the fingers still down.
      this.resize();
      this.flushState();
    }
  }

  /**
   * Push `visible` + `paused` at the DOM. The re-parent is the only unusual
   * part and it is unavoidable: `#hud` is a stacking context at z-index 10, so
   * no z-index on a descendant can lift it over `#ui`'s scrim at 30, and
   * `leavePlay` sets `#hud{display:none}` besides.
   */
  private applyLayerState(): void {
    // A paused pad is only drawn where it does not cover the shell's panel.
    const s = padLayerState(this.visible, this.paused && padClearsPausePanel(this.router.geom));
    this.layer.classList.toggle('mc-off', !s.drawn);
    this.layer.dataset.paused = s.lifted ? '1' : '0';
    const host = s.lifted ? liftHost(this.root) : this.root;
    if (this.layer.parentElement !== host) host.appendChild(this.layer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dismissCoach(false);
    this.router.releaseAll();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onResize);
      window.visualViewport?.removeEventListener('resize', this.onResize);
      window.removeEventListener('orientationchange', this.onResize);
      document.removeEventListener('visibilitychange', this.onHidden);
    }
    this.layer.remove();
    delete this.root.dataset.pad;
  }

  /* -------------------------------------------------------------------- *
   * Preferences
   * -------------------------------------------------------------------- */

  setPrefs(patch: Partial<MobilePrefs>): void {
    let relayout = false;
    if (patch.southpaw !== undefined && patch.southpaw !== this.prefs.southpaw) {
      this.prefs.southpaw = patch.southpaw; relayout = true;
    }
    if (patch.scale !== undefined) {
      const v = clampf(patch.scale, 0.7, 1.4);
      if (v !== this.prefs.scale) { this.prefs.scale = v; relayout = true; }
    }
    if (patch.deadZone !== undefined) {
      const v = clampf(patch.deadZone, 0, 0.4);
      if (v !== this.prefs.deadZone) { this.prefs.deadZone = v; relayout = true; }
    }
    if (patch.autoFire !== undefined) {
      this.prefs.autoFire = patch.autoFire;
      this.router.autoFireEnabled = patch.autoFire;
    }
    if (patch.aimAssist !== undefined) {
      this.prefs.aimAssist = patch.aimAssist;
      this.router.aimAssistEnabled = patch.aimAssist;
    }
    if (patch.lookScale !== undefined) {
      this.prefs.lookScale = clampf(patch.lookScale, 0.4, 2.5);
      this.router.lookScale = this.prefs.lookScale;
    }
    if (patch.haptics !== undefined) this.prefs.haptics = patch.haptics;
    if (patch.coached !== undefined) {
      this.prefs.coached = patch.coached;
      // Clearing it is the "show me the hints again" path: bring the card back
      // now rather than on the next match, so the setting is its own preview.
      if (!patch.coached && this.visible) this.showCoach();
      else if (patch.coached) this.dismissCoach(false);
    }

    saveMobilePrefs(this.store, this.prefs);
    this.syncChips();
    if (relayout) this.resize();
  }

  private onToggle(control: number, on: boolean): void {
    if (control === TC_AUTOFIRE) this.prefs.autoFire = on;
    else if (control === TC_AIMASSIST) this.prefs.aimAssist = on;
    saveMobilePrefs(this.store, this.prefs);
    this.syncChips();
  }

  private syncChips(): void {
    for (const v of this.views) {
      const on = v.control === TC_AUTOFIRE ? this.router.autoFireEnabled
        : v.control === TC_AIMASSIST ? this.router.aimAssistEnabled
          : null;
      if (on === null) continue;
      if (v.on !== on) { v.on = on; v.el.dataset.on = on ? '1' : '0'; }
    }
  }

  /* -------------------------------------------------------------------- *
   * Layout
   * -------------------------------------------------------------------- */

  private readonly onResize = (): void => { this.resize(); };

  private readonly onHidden = (): void => {
    if (typeof document !== 'undefined' && document.hidden) this.router.releaseAll();
  };

  /**
   * Re-solve and re-place. Runs on resize, rotate and preference change — never
   * per frame, which is why reading the safe-area probe here is free.
   */
  resize(): void {
    if (this.disposed) return;
    this.readSafeArea();
    const vw = viewportWidth();
    const vh = viewportHeight();

    const g = this.router.resize(vw, vh, {
      safeLeft: this.safeLeft,
      safeRight: this.safeRight,
      safeTop: this.safeTop,
      safeBottom: this.safeBottom,
      southpaw: this.prefs.southpaw,
      scale: this.prefs.scale,
      deadZone: this.prefs.deadZone,
    });

    for (const v of this.views) place(v);
    this.placeStick(g.stickHome.x, g.stickHome.y, g.stickHome.r);
    this.placeZone(g);

    // A dead zone dialled to zero has no threshold to draw, and a 1 px dashed
    // ring reads as dirt on the screen rather than as information.
    const dead = g.deadR;
    this.elDead.style.display = dead >= 3 ? '' : 'none';
    this.elDead.style.width = `${(dead * 2).toFixed(1)}px`;
    this.elDead.style.height = `${(dead * 2).toFixed(1)}px`;
    this.elDetent.style.width = `${(g.detentR * 2).toFixed(1)}px`;
    this.elDetent.style.height = `${(g.detentR * 2).toFixed(1)}px`;
    this.elRing.style.width = `${(g.stickTravel * 2).toFixed(1)}px`;
    this.elRing.style.height = `${(g.stickTravel * 2).toFixed(1)}px`;
    this.elKnob.style.width = `${(g.knobR * 2).toFixed(1)}px`;
    this.elKnob.style.height = `${(g.knobR * 2).toFixed(1)}px`;
    this.vTravel = NaN;   // force the ring scale to be rewritten

    this.applyBands(g);
    // A rotate while paused changes whether the pad fits beside the panel.
    if (this.paused) this.applyLayerState();
  }

  /**
   * Publish the solved geometry to the HUD stylesheet. This is the fix for
   * weakness #11: the read-outs are placed by where the controls ended up, not
   * by a hand-tuned pixel that was right on one phone.
   */
  private applyBands(g: TouchGeom): void {
    const b = hudBandsFrom(g, this.bands);
    const corner = b.inset;
    const sig = `${b.bottomLeft.toFixed(1)}|${b.bottomRight.toFixed(1)}|`
      + `${b.edgeLeft.toFixed(1)}|${b.edgeRight.toFixed(1)}|`
      + `${b.widthLeft.toFixed(1)}|${b.widthRight.toFixed(1)}|`
      + `${b.centreX0.toFixed(1)}|${b.centreWidth.toFixed(1)}|`
      + `${b.stacked ? 1 : 0}|${b.southpaw ? 1 : 0}|${corner.toFixed(1)}`;
    if (sig === this.vBandSig) return;
    this.vBandSig = sig;

    const s = this.root.style;
    // Screen-relative, to match the stylesheet's `left:`/`right:` rules.
    s.setProperty('--mc-bl', `${b.bottomLeft.toFixed(1)}px`);
    s.setProperty('--mc-br', `${b.bottomRight.toFixed(1)}px`);
    s.setProperty('--mc-el', `${b.edgeLeft.toFixed(1)}px`);
    s.setProperty('--mc-er', `${b.edgeRight.toFixed(1)}px`);
    s.setProperty('--mc-wl', `${b.widthLeft.toFixed(1)}px`);
    s.setProperty('--mc-wr', `${b.widthRight.toFixed(1)}px`);
    s.setProperty('--mc-cx0', `${b.centreX0.toFixed(1)}px`);
    s.setProperty('--mc-cx1', `${b.centreX1.toFixed(1)}px`);
    s.setProperty('--mc-cw', `${b.centreWidth.toFixed(1)}px`);
    s.setProperty('--mc-corner', `${corner.toFixed(1)}px`);
    this.root.dataset.stack = b.stacked ? '1' : '0';
    this.root.dataset.hand = b.southpaw ? 'left' : 'right';
  }

  /**
   * Draw the fire-and-look slab where the solver put it.
   *
   * Resize only — the region never moves per frame. The handedness goes on the
   * LAYER rather than on the HUD root because the layer re-parents to `body`
   * while the game is paused, and a bracket that flips to the wrong corner the
   * moment the pause panel opens would be worse than not drawing it.
   */
  private placeZone(g: TouchGeom): void {
    const z = g.fireZone;
    const st = this.elZone.style;
    st.left = `${z.x0.toFixed(1)}px`;
    st.top = `${z.y0.toFixed(1)}px`;
    st.width = `${(z.x1 - z.x0).toFixed(1)}px`;
    st.height = `${(z.y1 - z.y0).toFixed(1)}px`;
    const hand = g.southpaw ? 'left' : 'right';
    if (this.layer.dataset.hand !== hand) this.layer.dataset.hand = hand;
    // The HUD needs the slab's height too: nothing that looks pressable may be
    // drawn inside a region where a press is a gunshot.
    this.root.style.setProperty('--mc-zh', `${(z.y1 - z.y0).toFixed(1)}px`);
  }

  private placeStick(x: number, y: number, r: number): void {
    if (x === this.vStickX && y === this.vStickY && r === this.vStickR) return;
    this.vStickX = x; this.vStickY = y; this.vStickR = r;
    const st = this.elStick.style;
    st.left = `${(x - r).toFixed(1)}px`;
    st.top = `${(y - r).toFixed(1)}px`;
    st.width = `${(r * 2).toFixed(1)}px`;
    st.height = `${(r * 2).toFixed(1)}px`;
  }

  private readSafeArea(): void {
    if (typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(this.safeProbe);
    this.safeTop = px(cs.paddingTop);
    this.safeRight = px(cs.paddingRight);
    this.safeBottom = px(cs.paddingBottom);
    this.safeLeft = px(cs.paddingLeft);
  }

  /* -------------------------------------------------------------------- *
   * Pointers
   *
   * Four listeners on one element, all `passive:false` because a touch that
   * scrolls the page is a touch that did not aim. Handlers do arithmetic only.
   * -------------------------------------------------------------------- */

  private bindPointers(): void {
    const s = this.surface;
    // One clock. `PointerEvent.timeStamp` is *usually* the same origin as
    // performance.now(), but it is not universally so, and the fire pad's
    // minimum hold and auto-fire's release window both subtract one from the
    // other. Reading the clock ourselves costs a nanosecond and removes the
    // whole class of bug.
    s.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      this.lastTouchMs = now();
      // A player who is already playing does not need to be told how.
      if (this.elCoach !== null) this.dismissCoach(true);
      if (this.router.down(e.pointerId, e.clientX, e.clientY, this.lastTouchMs) !== 0) {
        try { s.setPointerCapture(e.pointerId); } catch { /* already gone */ }
      }
    }, { passive: false });

    s.addEventListener('pointermove', (e: PointerEvent) => {
      // Coalesced events are the browser telling us it batched several samples
      // into one callback. Replaying them costs nothing here (the router is
      // pure arithmetic and the DOM is written once per frame regardless) and
      // it is the difference between a smooth flick and a stair-stepped one.
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      if (list !== null && list.length > 1) {
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          this.router.move(e.pointerId, c.clientX, c.clientY);
        }
      } else {
        this.router.move(e.pointerId, e.clientX, e.clientY);
      }
      e.preventDefault();
    }, { passive: false });

    const up = (e: PointerEvent): void => {
      this.router.up(e.pointerId, now());
      e.preventDefault();
    };
    s.addEventListener('pointerup', up, { passive: false });
    s.addEventListener('pointercancel', (e: PointerEvent) => {
      this.router.cancel(e.pointerId);
    }, { passive: false });
    s.addEventListener('contextmenu', (e: Event) => { e.preventDefault(); });
  }

  private buzz(ms: number): void {
    if (!this.prefs.haptics) return;
    if (typeof navigator === 'undefined') return;
    const n = navigator as Navigator & { vibrate?: (p: number) => boolean };
    try { n.vibrate?.(ms); } catch { /* unsupported */ }
  }

  /* -------------------------------------------------------------------- *
   * Per-step
   * -------------------------------------------------------------------- */

  /**
   * Advance the controls and repaint what changed. Call once per simulation
   * step from the game loop; it is the only place this module writes DOM.
   */
  update(dt: number, nowMs: number, playing: boolean): void {
    if (this.disposed || !this.visible) return;
    this.router.update(dt, nowMs, this.aim, playing);
    this.flushState(nowMs);
  }

  private flushState(nowMs: number = now()): void {
    const r = this.router;
    const stick = r.stick;
    const s = stick.sample;

    /* Floating origin: the ring follows the thumb. One layout write per press,
       not per move — `ringX/ringY` only change on `begin`. */
    if (stick.active) this.placeStick(stick.ringX, stick.ringY, this.vStickR);
    else this.placeStick(r.geom.stickHome.x, r.geom.stickHome.y, r.geom.stickHome.r);

    if (s.knobX !== this.vKnobX || s.knobY !== this.vKnobY) {
      this.vKnobX = s.knobX;
      this.vKnobY = s.knobY;
      this.elKnob.style.transform =
        `translate(calc(-50% + ${s.knobX.toFixed(1)}px),calc(-50% + ${s.knobY.toFixed(1)}px))`;
    }
    const travel = s.travel < 0.06 ? 0.06 : s.travel;
    if (travel !== this.vTravel) {
      this.vTravel = travel;
      this.elRing.style.transform = `translate(-50%,-50%) scale(${travel.toFixed(3)})`;
    }
    if (s.live !== this.vLive) {
      this.vLive = s.live;
      this.elStick.dataset.live = s.live ? '1' : '0';
    }
    if (s.sprint !== this.vSprint) {
      this.vSprint = s.sprint;
      this.elStick.dataset.sprint = s.sprint ? '1' : '0';
    }

    const fire = this.fireView;
    if (r.firing !== this.vFiring) {
      this.vFiring = r.firing;
      fire.el.dataset.on = r.firing ? '1' : '0';
    }
    if (r.locked !== this.vLocked) {
      this.vLocked = r.locked;
      fire.el.dataset.lock = r.locked ? '1' : '0';
    }
    if (r.firePad.aiming !== this.vAiming) {
      this.vAiming = r.firePad.aiming;
      fire.el.dataset.aim = r.firePad.aiming ? '1' : '0';
    }

    const assistOn = r.engaged > 0.15;
    if (assistOn !== this.vAssist) {
      this.vAssist = assistOn;
      this.elAssist.dataset.on = assistOn ? '1' : '0';
    }

    if (r.held !== this.vHeld) {
      const changed = this.vHeld < 0 ? ~0 : (r.held ^ this.vHeld);
      this.vHeld = r.held;
      for (const v of this.views) {
        // The trigger draws `firing` (which auto-fire also drives) and the two
        // option chips draw their own latched state, so neither follows `held`.
        if (v.control === TC_FIRE || v.control === TC_AUTOFIRE
          || v.control === TC_AIMASSIST) continue;
        const bit = 1 << v.control;
        if ((changed & bit) === 0) continue;
        v.el.dataset.on = (r.held & bit) !== 0 ? '1' : '0';
      }
    }

    const quiet = (nowMs - this.lastTouchMs) > CORNER_IDLE_MS;
    if (quiet !== this.vQuiet) {
      this.vQuiet = quiet;
      this.layer.dataset.quiet = quiet ? '1' : '0';
    }
  }

  /* -------------------------------------------------------------------- *
   * Construction helpers
   * -------------------------------------------------------------------- */

  private addView(cls: string, control: number, disc: Disc): ControlView {
    const el = div(cls);
    const label = document.createElement('b');
    label.textContent = CONTROL_LABELS[control] ?? '';
    el.appendChild(label);
    el.dataset.on = '0';
    this.layer.appendChild(el);
    const view: ControlView = { el, control, disc, x: NaN, y: NaN, r: NaN, on: false };
    this.views.push(view);
    return view;
  }
}

/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

function place(v: ControlView): void {
  const d = v.disc;
  if (d.x === v.x && d.y === v.y && d.r === v.r) return;
  v.x = d.x; v.y = d.y; v.r = d.r;
  const st = v.el.style;
  st.left = `${(d.x - d.r).toFixed(1)}px`;
  st.top = `${(d.y - d.r).toFixed(1)}px`;
  st.width = `${(d.r * 2).toFixed(1)}px`;
  st.height = `${(d.r * 2).toFixed(1)}px`;
}

/**
 * Where the layer goes while it has to out-stack the pause scrim. `body` is a
 * child of the root stacking context, which is the only place `PAD_PAUSED_Z`
 * means anything; falls back to the HUD root if there is no body to speak of.
 */
function liftHost(fallback: HTMLElement): HTMLElement {
  if (typeof document === 'undefined') return fallback;
  return document.body ?? fallback;
}

function div(cls: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function viewportWidth(): number {
  if (typeof window === 'undefined') return 412;
  return Math.round(window.visualViewport?.width ?? window.innerWidth);
}

function viewportHeight(): number {
  if (typeof window === 'undefined') return 915;
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

function defaultStore(): PrefStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

function injectCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('dc-mobile-css') !== null) return;
  const style = document.createElement('style');
  style.id = 'dc-mobile-css';
  style.textContent = MOBILE_CSS;
  document.head.appendChild(style);
}
