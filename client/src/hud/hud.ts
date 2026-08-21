/**
 * DOOMCRAFT — in-game HUD.
 *
 * Judged against ref/BAR.md. The bar's HUD (ref/voxiom/desktop-08-combat.png)
 * is competent: corners only, clean centre, minimap, armour/health bars with
 * numerals, a hotbar with a white selected outline, a chat/kill feed. It is not
 * beaten by adding furniture — it is beaten on **damage legibility**, which is
 * where it says nothing at all:
 *
 *   1. HEALTH READS AS A COLOUR, A LENGTH AND A WORD. The bar's health fill is
 *      green at 100 and green at 4. Ours is a three-state ramp — green / amber
 *      / red — whose label flips from HEALTH to CRITICAL, so the "about to die"
 *      read survives colour blindness and a phone screen in sunlight. Behind it
 *      a *damage ghost* drains a beat late, turning "I just lost 30" into a
 *      length you never have to read, and below 30 the frame edge throbs. The
 *      plate under all of it is opaque: the critical vignette is red and paints
 *      UNDER this cluster, and a translucent plate let that red wash straight
 *      through the one read-out that mattered. And because the corner is 700 px
 *      from where you are actually looking, below 30 a 30 px copy of the health
 *      bar appears directly under the reticle, scaled to the critical band so
 *      it is full at 30 and a sliver at 4 (`foveaHealthFrac`). Above 30 it does
 *      not exist, so the centre is empty in every frame where you are fine.
 *   2. DIRECTIONAL DAMAGE RIDES THE FRAME AND THE FOVEA, NEVER THE MID-FIELD.
 *      Bearings are stored as the *world* yaw the hit came from and
 *      re-projected every frame against the live camera, so the indicator
 *      slides around as you turn and sits dead ahead the moment you face the
 *      shooter. It is drawn twice: a blade on an ellipse inscribed in the
 *      viewport, which peripheral vision catches without a saccade, and a short
 *      arc inside the crosshair canvas, where the eye already is. Neither ever
 *      occupies the middle of the screen. Repeat hits from one bearing merge
 *      into one loud blade instead of stacking four faint ones. The bar has no
 *      damage direction of any kind.
 *   3. AMMO IS NEVER HUNTED FOR. Big magazine numeral, a per-round pip strip
 *      under it (countable without reading digits, and dark-tracked so it still
 *      counts over sunlit sand), a reserve line tinted by ammo type, hotbar
 *      slots that go dark red when that gun is dry, and — because the eye is at
 *      the crosshair, not the corner — the crosshair's dot goes amber on the
 *      last quarter of a magazine and the whole crosshair goes red when it is
 *      empty. Every slot also carries the reserve behind THAT gun, so "what can
 *      I switch to" is answered without switching to it; the bar prints a stack
 *      count in the same corner and that is the one idea of its worth taking.
 *   3b. THE HOTBAR IS SHAPES, NOT A WORD SEARCH. The bar's slots hold pictures
 *      of objects. Ours held seven three-letter codes — PST SHT CHG RKT PLS BFG
 *      SAW — at 10 px, which is unreadable at a glance on a desktop and simply
 *      unreadable on the 34 px slot a landscape phone gets. Every slot now
 *      carries a silhouette (`weaponGlyph`) drawn in `currentColor`, chosen to
 *      differ in outline rather than in detail, because at 23 px the detail is
 *      gone.
 *   4. THE CROSSHAIR TALKS. It breathes with the live weapon cone (the bar's is
 *      a dead static plus, weakness #3), pops a hit marker scaled by damage,
 *      golds on a headshot, flashes a red ring on a kill, and carries the
 *      reload sweep.
 *   5. IT SURVIVES A BRIGHT MAP. The bar keeps its HUD readable over a sunlit
 *      beach with solid dark plates. Every read-out here carries a two-stop
 *      black halo and the plates are opaque enough to hold, because a HUD that
 *      is only legible in a dark arena is not legible. The canvas read-outs get
 *      the same treatment the hard way: the reticle, the hit marker and the
 *      reload sweep are all CASED — a black keyline stroked first, the colour
 *      inside it — because a 2 px drop shadow is a grey smear that sunlit sand
 *      eats, and a white hit marker over white sand is no hit marker at all.
 *      The damage blades carry a dark ground under their hot core for the same
 *      reason: orange on a beach is orange on orange.
 *
 *   6. THE SIGHTLINE HAS A BUDGET, AND IT IS ENFORCED IN CODE. This is where
 *      the bar loses hardest and where a HUD most easily loses it back. voxiom
 *      prints "Waiting for players...(2/50)" at ~28 px cap height across
 *      478 px — roughly 19,000 px² of white glyph box — 180 px ABOVE its own
 *      crosshair, i.e. laid over the exact pixels you are aiming through
 *      (ref/voxiom/desktop-08-combat.png, x 483–961, y 251–291). Here the
 *      reticle owns a KEEP-OUT radius (`keepOutRadius`, a third of the short
 *      edge, ~300 px on a 1440×900 desktop and 138 px on a phone), and the
 *      only thing allowed inside it besides the crosshair is one 11 px
 *      letterspaced-caps plate whose TOP edge sits `statusDrop()` px BELOW the
 *      reticle — 120 px on desktop, ~1,600 px² of ink, a twelfth of the bar's,
 *      and off the aim line entirely. Below, never above: the eye tracks UP to
 *      targets. And it is not a convention that a later change can quietly
 *      break — every line is costed by `statusInk()` and `statusPlacement()`
 *      demotes anything over `SIGHTLINE_INK_BUDGET` into the top-left chip
 *      stack beside the match clock. A message cannot grow into a banner
 *      because the layout will not draw a banner. The one exception is death,
 *      which is also the one state with no aim line to protect: the crosshair
 *      is hidden while dead — you cannot shoot — so the death card may own the
 *      middle, and it is a plated card rather than loose display type.
 *
 *   7. THE TOP-CENTRE RAIL IS THREE CELLS, AND THAT IS A NUMBER IN THE CODE.
 *      The band above the crosshair is the only HUD surface that is not in a
 *      corner, so it is the only one that has to justify itself cell by cell,
 *      and it is where the last version of this HUD lost outright: six pills
 *      and twelve strings across ~650 px — ROUND 1 / TIME 7:43 / FRAG LIMIT
 *      0/30 / LEADER Marine 0 / YOU 0 / IN MATCH 1+5 — of which three said the
 *      same thing about the score from three angles and one ("1+5") could not
 *      be decoded at all. `RAIL_MAX_CELLS` is three, `railSpecs()` truncates to
 *      it and `MatchRail` builds from the truncated list, so a caller that adds
 *      a fourth cell gets three; the rail cannot grow back into a banner for
 *      the same reason the status line cannot, which is that the budget is
 *      enforced rather than requested. What survives is what only the
 *      top-centre can carry — the clock, your frags against the limit, the
 *      roster size — and it is ONE plate with hairline dividers, ~250 px wide,
 *      five strings. Leader and round are a RANKING, and a ranking is a sorted
 *      list, so they went to the Tab board, which already sorts by frags.
 *   8. ONE CONTAINER TREATMENT, DECLARED ONCE. Round 1 shipped five — a 6 px
 *      white-bordered minimap, 11 px dark pills, square 30%-white bars, a
 *      hard-edged 30%-white ammo box and an amber hotbar, each with its own
 *      background alpha — which read as five unrelated widgets sharing a
 *      screen and cost the eye a fixation deciding whether boxes that look
 *      different mean different things. Radius, keyline, plate fill and
 *      elevation are now four tokens on `#hud`, inherited by every plate here
 *      AND by every mode overlay, since they all scope under `#hud`. The one
 *      deliberate split is legibility, not style: `--dc-plate-solid` is opaque
 *      for the two read-outs the critical vignette paints under, `--dc-plate`
 *      is not for everything else. `hud.test.ts` walks the stylesheet and
 *      fails on any plate that hard-codes a radius or a keyline, because a
 *      token set that lives only in a comment has already drifted.
 *
 * And the centre stays clean: everything above lives in the corners, at the
 * frame edge, inside the 96 px crosshair canvas, on one small plate below the
 * keep-out, or on the three-cell rail. The keep-out radius is published on
 * `#hud` as `--dc-keepout` so mode overlays can anchor to it instead of
 * guessing an offset.
 *
 * COST. The HUD must not cost frames, so nothing here re-renders on a whim:
 *
 *   - every DOM node is created once at mount and afterwards only *mutated*,
 *     each behind a `!==` guard, so a steady frame writes zero DOM;
 *   - the crosshair canvas redraws only when a QUANTISED input actually
 *     changed (gap to the half-pixel, marker to the frame, reload to 1/36) —
 *     standing still with a full magazine costs nothing at all;
 *   - the damage blades write transform/opacity only while they are alive, and
 *     only when the projected angle moved more than 0.6°; once the last one has
 *     decayed the HUD is measured writing ZERO styles and ZERO canvas clears
 *     over a two-second window;
 *   - the minimap is a blit out of a pre-baked world image redrawn at 10 Hz —
 *     the column scan happens once per chunk on arrival, never per frame;
 *   - the scoreboard re-diffs at 5 Hz, not per frame;
 *   - no allocation in `update()` on an unchanged frame.
 */

import {
  MAX_HEALTH, MAX_ARMOR, InputAction,
  CHUNK_SIZE_X, CHUNK_SIZE_Z, CHUNK_HEIGHT,
  WORLD_MIN_BLOCK_X, WORLD_MIN_BLOCK_Z, WORLD_SIZE_BLOCKS,
  type CrosshairStyle,
} from '@shared/constants';
import { minimapColor, BLOCK_LIQUID } from '@shared/blocks';
import {
  WEAPON_COUNT, WEAPON_SHORT_NAMES, WEAPON_NAMES, AMMO_NAMES, AMMO_COLORS,
  AMMO_TYPE_COUNT, WEAPON_MAG_SIZE, ammoTypeOf, ownsWeapon,
} from '@shared/weapons';

/* ------------------------------------------------------------------------ *
 * Public state
 * ------------------------------------------------------------------------ */

/** Blip kinds drawn on the minimap, in draw order. */
export const BLIP_PICKUP = 0;
export const BLIP_PLAYER = 1;
export const BLIP_ENEMY = 2;

export const MAX_BLIPS = 64;
/** Scoreboard rows the HUD will render. */
export const MAX_BOARD_ROWS = 16;

/**
 * Everything the HUD draws. The game owns one of these and mutates it in
 * place; the HUD never keeps a reference to anything inside it.
 */
export interface HudState {
  health: number;
  armor: number;
  weapon: number;
  mag: number;
  reserve: number;
  /**
   * Reserve ammo per `AmmoType`, so the hotbar can grey out the guns you
   * cannot feed. A negative entry means "unknown" and is treated as not dry,
   * which is what a caller that never fills this array gets.
   */
  reserveByType: Int32Array;
  /** Bitmask of owned weapons — greys out hotbar slots. */
  owned: number;
  /** 0..1 live cone fraction; drives the dynamic crosshair. */
  spread: number;
  reloading: boolean;
  reloadFrac: number;

  kills: number;
  deaths: number;
  playersAlive: number;
  matchSeconds: number;

  dead: boolean;
  /** Centre status line. Empty hides it. */
  status: string;
  /** Small line under the status. */
  subStatus: string;

  fps: number;
  ping: number;
  showFps: boolean;

  /** Camera position and heading for the minimap. */
  camX: number;
  camZ: number;
  camYaw: number;

  /** Scoreboard rows, filled by the game while Tab is held. */
  boardOpen: boolean;
  boardCount: number;
  boardName: string[];
  boardKills: Int32Array;
  boardDeaths: Int32Array;
  boardPing: Int32Array;
  boardIsLocal: Uint8Array;

  /** Minimap blips, packed as [x, z, kind] triples in `blipCount` entries. */
  blipX: Float32Array;
  blipZ: Float32Array;
  blipKind: Uint8Array;
  blipCount: number;
}

export function createHudState(): HudState {
  const reserveByType = new Int32Array(AMMO_TYPE_COUNT);
  reserveByType.fill(-1);
  return {
    health: MAX_HEALTH, armor: 0, weapon: 0, mag: 0, reserve: 0, owned: 1,
    reserveByType,
    spread: 0, reloading: false, reloadFrac: 0,
    kills: 0, deaths: 0, playersAlive: 1, matchSeconds: 0,
    dead: false, status: '', subStatus: '',
    fps: 0, ping: 0, showFps: true,
    camX: 0, camZ: 0, camYaw: 0,
    boardOpen: false, boardCount: 0,
    boardName: new Array<string>(MAX_BOARD_ROWS).fill(''),
    boardKills: new Int32Array(MAX_BOARD_ROWS),
    boardDeaths: new Int32Array(MAX_BOARD_ROWS),
    boardPing: new Int32Array(MAX_BOARD_ROWS),
    boardIsLocal: new Uint8Array(MAX_BOARD_ROWS),
    blipX: new Float32Array(MAX_BLIPS),
    blipZ: new Float32Array(MAX_BLIPS),
    blipKind: new Uint8Array(MAX_BLIPS),
    blipCount: 0,
  };
}

export interface HudOptions {
  /** Force the touch layer on/off. Auto-detected from the pointer type. */
  touch?: boolean;
  crosshair?: CrosshairStyle;
  crosshairColor?: number;
  /** Called by the touch layer; wire straight to InputManager's TouchSurface. */
  touchSink?: HudTouchSink | null;
  /** Pause button (mobile) and the tab-scoreboard key hint. */
  onPause?: () => void;
  /**
   * `client/src/hud/mobile.ts` is mounting the real pad, so do not build the
   * built-in one. The `data-touch` / `data-portrait` attributes and the
   * short-viewport CSS below still apply — only the stick, glyphs and their
   * listeners are skipped, so two pads can never fight over the same pointer.
   */
  externalPad?: boolean;
}

/** The slice of `TouchSurface` the pad needs. `InputManager` satisfies it. */
export interface HudTouchSink {
  setMove(x: number, z: number): void;
  addLook(dxPx: number, dyPx: number): void;
  setButton(action: InputAction, down: boolean): void;
  tap(action: InputAction): void;
  reset(): void;
}

/* ------------------------------------------------------------------------ *
 * Pure read-out logic — no DOM, so it is unit-testable in node
 * ------------------------------------------------------------------------ */

export const HEALTH_TIER_OK = 0;
export const HEALTH_TIER_HURT = 1;
export const HEALTH_TIER_CRIT = 2;

/** Above this you are fine; at or below it the bar turns amber. */
export const HEALTH_HURT_AT = 60;
/** At or below this the bar turns red and the frame edge starts throbbing. */
export const HEALTH_CRIT_AT = 30;
/** At or below this the throb doubles in rate and depth. */
export const HEALTH_DIRE_AT = 12;

/**
 * The whole point of the ramp: the *colour alone* answers "am I about to die",
 * with no numeral read and no length comparison. The bar's health fill is the
 * same green at 100 and at 4.
 */
export function healthTier(hp: number): number {
  if (hp <= HEALTH_CRIT_AT) return HEALTH_TIER_CRIT;
  if (hp <= HEALTH_HURT_AT) return HEALTH_TIER_HURT;
  return HEALTH_TIER_OK;
}

export const AMMO_TIER_OK = 0;
export const AMMO_TIER_LOW = 1;
export const AMMO_TIER_EMPTY = 2;

/** Low at the last quarter of a magazine, empty at zero. Melee is never low. */
export function ammoTier(mag: number, magSize: number): number {
  if (magSize <= 0) return AMMO_TIER_OK;
  if (mag <= 0) return AMMO_TIER_EMPTY;
  const lowAt = Math.max(1, Math.ceil(magSize * 0.25));
  return mag <= lowAt ? AMMO_TIER_LOW : AMMO_TIER_OK;
}

/** The bottom-right numeral pair, decided without touching the DOM. */
export interface AmmoReadout {
  /** Big numeral: rounds in the magazine, or `∞` for a weapon that never empties. */
  clip: string;
  /** Second numeral: rounds in reserve. Empty when `pair` is false. */
  reserve: string;
  /** Whether there is a reserve to show at all — false for melee. */
  pair: boolean;
  /** Caption under the pair: what you are holding and what it eats. */
  caption: string;
}

/**
 * The single widest opening on the bar's HUD: voxiom shows **no ammunition
 * state anywhere** — its bottom-right corner is five voxel thumbnails and a
 * stack count (ref/voxiom/desktop-08-combat.png), so "can I keep firing" is
 * unanswerable without firing. Ours answers it, and answers the follow-up
 * ("and after this magazine?") in the same fixation, because clip and reserve
 * are one pair rather than two read-outs at two sizes in two places.
 *
 * Pure so the wording is testable in node: the DOM only ever transcribes what
 * this returns.
 */
export function ammoReadout(
  weapon: number, mag: number, reserve: number, reloading: boolean,
): AmmoReadout {
  const name = (WEAPON_NAMES[weapon] ?? '').toUpperCase();
  const type = ammoTypeOf(weapon);
  /* Melee is not "0 rounds" — printing a zero next to a chainsaw is the same
     lie the bar tells with its empty armour trough. It gets the one glyph that
     means "this never runs out" and no reserve at all. */
  if (magSizeOf(weapon) <= 0 || type === 0) {
    return { clip: '∞', reserve: '', pair: false, caption: join(name, 'MELEE') };
  }
  const ammo = (AMMO_NAMES[type] ?? '').toUpperCase();
  return {
    clip: String(Math.max(0, Math.round(mag))),
    reserve: String(Math.max(0, Math.round(reserve))),
    pair: true,
    caption: reloading ? 'RELOADING' : join(name, ammo),
  };
}

function join(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return `${a} · ${b}`;
}

/**
 * Opacity of the standing "about to die" edge throb, as a function of health
 * and wall-clock seconds. Zero above the critical threshold and zero at zero —
 * once you are dead the death card owns the screen and a pulsing vignette
 * behind it is noise.
 */
export function critVignette(hp: number, t: number): number {
  if (hp > HEALTH_CRIT_AT || hp <= 0) return 0;
  const dire = hp <= HEALTH_DIRE_AT;
  const base = dire ? 0.20 : 0.11;
  const amp = dire ? 0.20 : 0.13;
  const w = dire ? 7.4 : 4.4;
  return base + amp * (0.5 - 0.5 * Math.cos(t * w));
}

/** Half-gap in CSS pixels between the crosshair arms, for a given cone. */
export function crosshairGapFor(style: CrosshairStyle, spread: number): number {
  if (style === 'dot') return 0;
  const base = style === 'doom' ? 9 : 5;
  if (style === 'cross') return base;
  const s = spread < 0 ? 0 : spread > 1 ? 1 : spread;
  return base + s * 26;
}

/**
 * Distance from screen centre to the frame, along a bearing where 0 is
 * straight up and positive is clockwise — the ellipse inscribed in the
 * viewport, pulled in by `inset`.
 *
 * A damage indicator parked at a constant pixel radius is either mid-field on
 * a desktop or off-screen on a phone. Solving for the frame instead keeps the
 * blade in peripheral vision at every aspect ratio, which is the only place it
 * can be loud without competing with the crosshair.
 */
export function frameRadius(bearing: number, halfW: number, halfH: number, inset = 0): number {
  const hw = Math.max(1, halfW);
  const hh = Math.max(1, halfH);
  const sx = Math.sin(bearing) / hw;
  const sy = Math.cos(bearing) / hh;
  const r = 1 / Math.sqrt(sx * sx + sy * sy);
  const min = Math.min(hw, hh) * 0.35;
  return Math.max(min, r - inset);
}

/* ---- the sightline budget ------------------------------------------------
 * The single measured way the bar loses this piece, and the single way we can
 * lose it back. voxiom prints "Waiting for players...(2/50)" at ~28 px cap
 * height across 478 px — about 19,000 px² of white glyph box — 180 px ABOVE
 * its own crosshair (ref/voxiom/desktop-08-combat.png, x 483–961, y 251–291).
 * That is a banner laid over the exact pixels the player is looking through.
 *
 * So the reticle gets a KEEP-OUT: a radius around screen centre that belongs
 * to the crosshair and to nothing else. It cannot be a constant — 300 px is a
 * third of a 900 px desktop and three quarters of a 412 px phone — so it is a
 * fraction of the short edge, clamped, exactly like `frameRadius` above.
 *
 * Inside that radius a transient line is allowed one thing: to be tiny. The
 * status chip is 11 px letterspaced caps on an opaque plate whose TOP edge is
 * `statusDrop()` px BELOW the crosshair — below, because the eye tracks up to
 * enemies and down to the corners, never down through the aim line. And it is
 * BUDGETED: `statusInk()` costs the line in px² of glyph box and
 * `statusPlacement()` demotes anything over `SIGHTLINE_INK_BUDGET` into the
 * top-left chip stack beside the match clock. A message cannot grow into a
 * banner, because the layout refuses to draw a banner.
 */

/** Fraction of the short viewport edge the reticle owns outright. */
export const KEEP_OUT_FRAC = 0.334;
export const KEEP_OUT_MIN = 92;
export const KEEP_OUT_MAX = 300;

/**
 * Radius, in CSS px, around screen centre that only the crosshair may occupy.
 * 1440×900 → ~300, which is the number the frame was judged against; a
 * 412×915 phone → 138, because a literal 300 px there is most of the screen.
 */
export function keepOutRadius(vw: number, vh: number): number {
  const short = Math.min(Math.max(0, vw), Math.max(0, vh));
  const r = short * KEEP_OUT_FRAC;
  return r < KEEP_OUT_MIN ? KEEP_OUT_MIN : r > KEEP_OUT_MAX ? KEEP_OUT_MAX : r;
}

/** Fraction of the short edge between the crosshair and the status plate. */
export const STATUS_DROP_FRAC = 0.1334;
export const STATUS_DROP_MIN = 62;
export const STATUS_DROP_MAX = 120;

/**
 * CSS px from the crosshair centre down to the TOP edge of the status plate.
 * 1440×900 → 120. Always below, never above: the sightline above the reticle
 * is where the enemies are.
 */
export function statusDrop(vw: number, vh: number): number {
  const short = Math.min(Math.max(0, vw), Math.max(0, vh));
  const d = short * STATUS_DROP_FRAC;
  return d < STATUS_DROP_MIN ? STATUS_DROP_MIN : d > STATUS_DROP_MAX ? STATUS_DROP_MAX : d;
}

/* Type metrics of the two status lines, kept here rather than only in the CSS
   so the budget is computed from the same numbers that get rendered. */
export const STATUS_TYPE_PX = 11;
export const STATUS_TRACK_EM = 0.22;
export const STATUS_CAP_PX = 8;
export const SUB_TYPE_PX = 10;
export const SUB_TRACK_EM = 0.16;
export const SUB_CAP_PX = 7;
/** Mean advance of an uppercase monospace-ish glyph as a fraction of em. */
const GLYPH_ADVANCE_EM = 0.60;

/**
 * Ink a status would put on the sightline, in px² of glyph box — the same
 * measure the bar was costed with. voxiom's line: ~19,000. Ours must not
 * exceed `SIGHTLINE_INK_BUDGET`.
 */
export function statusInk(text: string, sub: string): number {
  const t = text.length * STATUS_TYPE_PX * (GLYPH_ADVANCE_EM + STATUS_TRACK_EM) * STATUS_CAP_PX;
  const s = sub.length * SUB_TYPE_PX * (GLYPH_ADVANCE_EM + SUB_TRACK_EM) * SUB_CAP_PX;
  return t + s;
}

/**
 * px² of glyph box a transient line may spend inside the keep-out. Set from
 * what a good HUD actually spends (~1,600), i.e. about 1/12th of the bar.
 */
export const SIGHTLINE_INK_BUDGET = 2000;

/** Nothing to say. */
export const STATUS_OFF = 0;
/** Small plate, `statusDrop()` px below the reticle. */
export const STATUS_SIGHTLINE = 1;
/** Too much ink for the sightline — goes to the top-left chip stack. */
export const STATUS_CORNER = 2;
/** Dead: there is no aim line to protect, so the card owns the middle. */
export const STATUS_DEATH = 3;

/**
 * Where a status line is allowed to be drawn.
 *
 * Death is the one state that may sit on the crosshair, because while you are
 * dead the crosshair is hidden — you cannot shoot, so there is no sightline to
 * keep clear. Every other message is either small enough for the plate under
 * the reticle or it is not centre-screen material at all.
 */
export function statusPlacement(text: string, sub: string, dead: boolean): number {
  if (text === '' && sub === '') return STATUS_OFF;
  if (dead) return STATUS_DEATH;
  return statusInk(text, sub) > SIGHTLINE_INK_BUDGET ? STATUS_CORNER : STATUS_SIGHTLINE;
}

/** One line for the corner chip, so the demoted form still reads as one fact. */
export function statusCornerText(text: string, sub: string): string {
  if (text === '') return sub.toUpperCase();
  if (sub === '') return text.toUpperCase();
  return `${text.toUpperCase()} · ${sub.toUpperCase()}`;
}

/* ---- the hotbar reads as objects, not as a word search --------------------
 * The bar's one genuinely good idea in the bottom-right corner is that its
 * five slots hold **pictures of things** — a shovel, a dirt block, three block
 * types (ref/voxiom/desktop-08-combat.png) — so "what am I holding and what
 * else have I got" is a shape read at any size. Ours used to hold `PST SHT
 * CHG RKT PLS BFG SAW`: seven three-letter codes at 10 px, which is a word
 * search, and at the 34 px slot a landscape phone gets it is not even legible
 * as text. Shape beats text at glance distance, so every slot now carries a
 * silhouette on a 24×24 grid, painted in `currentColor` so the selected slot's
 * inversion carries the glyph with it for free.
 *
 * They are deliberately unlike each other in GESTALT, not in detail — a long
 * twin tube, a barrel cluster with a drum, a warhead, a big orb, a toothed bar
 * — because at 23 px the detail is gone and only the outline survives.
 */
const WEAPON_GLYPHS: readonly string[] = Object.freeze([
  /* PISTOL — small L: slide, front sight, grip, trigger guard. */
  '<path d="M3 7h15v4H3z"/><path d="M15 4.6h2.2v2.4H15z"/>'
  + '<path d="M6 11h5l-2 8H4.4z"/><path d="M11 11h3.2v2.2H11z"/>',
  /* SHOTGUN — the only twin-tube silhouette, with a pump under it. The gap
     between the tubes is the whole read, so it is wider than it looks like it
     needs to be: at 23 px the two bars merge into one if it is not. */
  '<path d="M1 7.4h17v2.4H1z"/><path d="M1 11.2h17v2.4H1z"/>'
  + '<path d="M5.5 14h5.5v2.6H5.5z"/><path d="M18 6.8h3.2v7.6H18z"/>'
  + '<path d="M21.2 9L23 10.2v3.6l-1.8 1z"/>',
  /* CHAINGUN — three barrels and a drum. The drum is the tell. */
  '<path d="M2 6h11.5v2H2z"/><path d="M2 9.6h11.5v2H2z"/><path d="M2 13.2h11.5v2H2z"/>'
  + '<path d="M13.5 5h4.6v13h-4.6z"/><circle cx="19.6" cy="15.4" r="3.3"/>',
  /* ROCKET — a fat tube with a cone blast end and a top sight. */
  '<path d="M4 8h13.5v6H4z"/><path d="M4 6.6L0.8 11 4 15.4z"/>'
  + '<path d="M7 14h3.2v5.2H7z"/><path d="M9 5.4h5.4V8H9z"/>'
  + '<path d="M17.5 9.4h5v3.2h-5z"/>',
  /* PLASMA — the only glyph carrying a bolt. Energy, not a barrel. */
  '<path d="M2.4 7.6h12.2v7.6H2.4z"/><path d="M14.6 9.2h2.6v4.4h-2.6z"/>'
  + '<path d="M4.6 15.2h3.4v4.4H4.6z"/>'
  + '<path d="M19.4 4.4l-3 5.6h2.4l-2 6.6 5.4-7.4h-2.8l1.8-4.8z"/>',
  /* BFG — the biggest body on the strip, opening into a flare with an orb in
     it. A plain box plus a circle read as a camera; the flare reads as a gun. */
  '<path d="M1.4 7h11.2v8.6H1.4z"/><path d="M3.6 15.6h4.2v4.6H3.6z"/>'
  + '<path d="M3.2 4.4h7.4v2.6H3.2z"/>'
  + '<path d="M12.6 5.2l4.6 2.6v8l-4.6 2.6z"/><circle cx="19.4" cy="11.8" r="3.4"/>',
  /* CHAINSAW — the only toothed outline; nothing else can be mistaken for it. */
  '<path d="M1 6h7.2v9.4H1z"/>'
  + '<path d="M8.2 8.6h12.4a2.6 2.6 0 010 5.2H8.2z"/>'
  + '<path d="M9.2 8.6l1.3-2.2 1.3 2.2z"/><path d="M12.9 8.6l1.3-2.2 1.3 2.2z"/>'
  + '<path d="M16.6 8.6l1.3-2.2 1.3 2.2z"/>',
]);

/** A neutral box for a weapon id the arsenal does not define. */
export const WEAPON_GLYPH_FALLBACK = '<path d="M4 8h16v8H4z"/>';

/**
 * SVG body for a weapon's hotbar silhouette, on a 24×24 viewBox.
 *
 * Pure and markup-only so the shape set is testable in node: every weapon the
 * arsenal defines must have one, and an id it does not define must still
 * produce a drawable glyph rather than an empty tile.
 */
export function weaponGlyph(id: number): string {
  return WEAPON_GLYPHS[id] ?? WEAPON_GLYPH_FALLBACK;
}

/**
 * Length of the tiny health bar drawn just under the reticle, 0..1.
 *
 * "Am I about to die" is the one fact you cannot afford to travel 700 px to
 * the bottom-left corner for, and the critical vignette answers it only as a
 * MOOD — a red wash tells you things are bad, not that you are on 6. So below
 * the critical threshold the health bar gets a second, 30 px copy of itself
 * inside the crosshair canvas, scaled to the critical band rather than to full
 * health: at 30 hp it is full, at 6 hp it is a fifth, and above 30 it does not
 * exist at all, so the centre of the screen is empty in every frame where the
 * player is not dying. The bar shows nothing of the kind — its health fill is
 * the same green at 100 and at 4, in the corner, at 13 px.
 */
export function foveaHealthFrac(hp: number, dead: boolean): number {
  if (dead || hp <= 0 || hp > HEALTH_CRIT_AT) return 0;
  return hp / HEALTH_CRIT_AT;
}

/** `m:ss`, clamped at zero. */
export function formatClock(secs: number): string {
  const v = Math.max(0, Math.floor(secs));
  const m = Math.floor(v / 60);
  return `${m}:${String(v - m * 60).padStart(2, '0')}`;
}

/* ---- the match rail ------------------------------------------------------
 * The top-centre strip of match state. It is the one HUD surface that sits
 * above the sightline, so it is the one surface that has to be argued for
 * cell by cell, and the last round did not: it grew to six pills and twelve
 * strings across ~650 px (ROUND / TIME / FRAG LIMIT / LEADER / YOU / IN MATCH),
 * three of which encoded the same score state and one of which — "1+5" — was
 * not decodable at all.
 *
 * A comment asking the next change to be tasteful does not hold a budget, so
 * this is the same shape as `SIGHTLINE_INK_BUDGET`: a hard cap in code.
 * `RAIL_MAX_CELLS` is three, `railSpecs()` truncates to it, and `MatchRail`
 * builds from the truncated list — a caller that asks for a fourth cell gets
 * three, not four. Whatever the fourth thing is, it belongs to a corner or to
 * the Tab board, both of which are read on purpose rather than in peripheral
 * vision over the top of a fight.
 * ------------------------------------------------------------------------ */

/** Cells the top-centre rail will ever draw. Three, and it is enforced. */
export const RAIL_MAX_CELLS = 3;

export interface RailCellSpec {
  /**
   * Caps label above the value, or `''` for a value-only cell. Only the clock
   * earns a blank label: `7:43` in a match HUD does not need the word "time",
   * and every label is a string the eye has to skip past.
   */
  label: string;
  /** Extra class on the cell — `clock` and `you` are styled in CSS. */
  kind: string;
}

/**
 * The rail's cells, truncated to the budget. Pure so the cap is testable
 * without a DOM: `railSpecs(sixCells).length === RAIL_MAX_CELLS`.
 */
export function railSpecs(all: readonly RailCellSpec[]): RailCellSpec[] {
  return all.slice(0, RAIL_MAX_CELLS);
}

/**
 * Strings a rail built from `specs` puts above the sightline: one per non-empty
 * label plus one per value. This is the number the last round lost on — twelve
 * — and three labelled cells minus the clock's label is five.
 */
export function railStringCount(specs: readonly RailCellSpec[]): number {
  let n = 0;
  for (const s of railSpecs(specs)) n += s.label === '' ? 1 : 2;
  return n;
}

/**
 * The top-centre rail's DOM. One plate, hairline dividers, at most
 * `RAIL_MAX_CELLS` cells, every write guarded by a `!==` so a steady frame
 * costs nothing. Modes own the numbers; the HUD owns the shape, so a mode
 * cannot quietly reintroduce a six-pill strip by styling its own.
 */
export class MatchRail {
  readonly root: HTMLElement;
  private readonly cells: HTMLElement[] = [];
  private readonly values: HTMLElement[] = [];
  private readonly cached: string[] = [];
  private readonly flags: string[] = [];

  constructor(specs: readonly RailCellSpec[]) {
    const root = document.createElement('div');
    root.className = 'dc-rail';
    for (const spec of railSpecs(specs)) {
      const cell = document.createElement('div');
      cell.className = spec.kind === '' ? 'cell' : `cell ${spec.kind}`;
      if (spec.label !== '') {
        const i = document.createElement('i');
        i.textContent = spec.label;
        cell.appendChild(i);
      }
      const b = document.createElement('b');
      b.textContent = '';
      cell.appendChild(b);
      root.appendChild(cell);
      this.cells.push(cell);
      this.values.push(b);
      this.cached.push('');
      this.flags.push('');
    }
    this.root = root;
  }

  /** Cells actually built — never more than `RAIL_MAX_CELLS`. */
  get length(): number { return this.cells.length; }

  /** Write a cell's value. No-op when it already says that. */
  set(i: number, text: string): void {
    if (i < 0 || i >= this.values.length) return;
    if (this.cached[i] === text) return;
    this.values[i]!.textContent = text;
    this.cached[i] = text;
  }

  /**
   * Set a cell's state class (`'urgent'`, `'warm'` or `''`). One class at a
   * time on purpose: a cell has one state, and two competing highlights on the
   * one thing above the sightline is how a rail turns back into clutter.
   */
  flag(i: number, cls: string): void {
    if (i < 0 || i >= this.cells.length) return;
    if (this.flags[i] === cls) return;
    const cell = this.cells[i]!;
    if (this.flags[i] !== '') cell.classList.remove(this.flags[i]!);
    if (cls !== '') cell.classList.add(cls);
    this.flags[i] = cls;
  }
}

/* ---- directional damage --------------------------------------------------
 * The bar has nothing here at all, so the only way to lose this is to build
 * the naive version: one sprite per hit, frozen at the screen angle it had
 * when the hit landed. That version lies the instant you turn — which is the
 * exact moment the player is using it. This keeps WORLD yaw and re-projects
 * every frame, and merges repeat hits from one bearing so five bullets from
 * the left read as one loud wedge rather than five quiet ones.
 * ------------------------------------------------------------------------ */

export const DMG_SLOTS = 6;
/** Seconds a wedge lives after its last contributing hit. */
export const DMG_LIFE = 1.15;
/** Hits within this many radians of a live wedge fold into it. */
export const DMG_MERGE_RAD = 0.5;

/** Slots and lifetime for the THREAT ring — see `Hud.threat`. */
export const THREAT_SLOTS = 4;
/** Seconds a threat bearing lives. Longer than a hit: you have to turn onto it. */
export const THREAT_LIFE = 2.2;

export class DamageRing {
  /** World-space yaw the damage came FROM, per slot. */
  readonly yaw: Float32Array;
  /** Seconds of life left. Zero means the slot is free. */
  readonly life: Float32Array;
  /** 0..1 loudness, from the accumulated damage folded into the slot. */
  readonly power: Float32Array;

  /**
   * `slots` and `lifetime` are parameters so the THREAT ring can be the same
   * class rather than a copy of it. They default to the damage values, so every
   * existing call site is untouched.
   */
  constructor(readonly slots = DMG_SLOTS, readonly lifetime = DMG_LIFE) {
    this.yaw = new Float32Array(slots);
    this.life = new Float32Array(slots);
    this.power = new Float32Array(slots);
  }

  /** Record a hit. Returns the slot it landed in. */
  add(amount: number, worldYaw: number): number {
    const p = Math.min(1, 0.28 + Math.max(0, amount) / 65);
    for (let i = 0; i < this.slots; i++) {
      if (this.life[i] <= 0) continue;
      const d = wrapPi(worldYaw - this.yaw[i]);
      if (Math.abs(d) > DMG_MERGE_RAD) continue;
      // Drift the wedge a third of the way onto the newest hit rather than
      // snapping: a strafing attacker should drag it, not teleport it.
      this.yaw[i] = wrapPi(this.yaw[i] + d * 0.34);
      this.power[i] = Math.min(1, this.power[i] + p * 0.6);
      this.life[i] = this.lifetime;
      return i;
    }
    let slot = 0;
    let worst = Infinity;
    for (let i = 0; i < this.slots; i++) {
      if (this.life[i] <= 0) { slot = i; worst = -1; break; }
      if (this.life[i] < worst) { worst = this.life[i]; slot = i; }
    }
    this.yaw[slot] = wrapPi(worldYaw);
    this.power[slot] = p;
    this.life[slot] = this.lifetime;
    return slot;
  }

  step(dt: number): void {
    for (let i = 0; i < this.slots; i++) {
      const l = this.life[i];
      if (l <= 0) continue;
      this.life[i] = l > dt ? l - dt : 0;
    }
  }

  clear(): void {
    this.life.fill(0);
    this.power.fill(0);
  }

  /** How many wedges are currently alive. */
  activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.slots; i++) if (this.life[i] > 0) n++;
    return n;
  }

  /** 0..1 draw opacity for a slot: loudness × smoothstep fade. */
  alpha(i: number): number {
    const l = this.life[i];
    if (l <= 0) return 0;
    const t = l / this.lifetime;
    return (0.42 + 0.58 * this.power[i]) * (t * t * (3 - 2 * t));
  }
}

/* ------------------------------------------------------------------------ *
 * Styles — injected once, scoped by the #hud id
 * ------------------------------------------------------------------------ */

/**
 * The HUD's stylesheet, exported so `hud.test.ts` can hold the chassis to its
 * own promise: every plate on the HUD uses ONE radius, ONE keyline and ONE
 * fill, taken from the tokens on `#hud`. A design system that lives only in a
 * comment is a design system that has already drifted.
 */
export const HUD_CSS = `
/* ---- the chassis ----------------------------------------------------------
   ONE container treatment for the whole HUD, declared once on #hud so that
   mode overlays — which all scope their CSS under #hud — inherit it instead of
   inventing their own. The previous round shipped five: a 6 px-radius
   white-bordered minimap, 11 px dark pills, square 30%-white bars, a
   hard-edged 30%-white ammo box and an amber hotbar, each with its own
   background alpha. Five container treatments read as five unrelated widgets
   that happen to share a screen, and the eye spends its first fixation asking
   whether two boxes that look different mean different things. One radius, one
   keyline, one plate fill, one elevation: the HUD becomes a single object and
   the only thing left varying between corners is the READ-OUT, which is the
   only thing that should vary.

   --dc-plate is translucent and --dc-plate-solid is not. That is the one
   deliberate split, and it is a legibility rule rather than a style: the
   critical-health vignette paints UNDER the HUD, so the two read-outs it would
   wash through (health/armour and the ammo numerals) sit on their own black.
   Everything else may let the world through. */
#hud{--dc-r:3px;
  --dc-line:rgba(255,255,255,.22);
  --dc-line-soft:rgba(255,255,255,.11);
  --dc-line-hot:#ff6b42;
  --dc-plate:rgba(9,9,12,.86);
  --dc-plate-solid:#08080b;
  --dc-lift:0 2px 10px rgba(0,0,0,.55);
  --dc-ink:#e8e6e3;
  --dc-ink-dim:#8a847e;
  --dc-label:#6f6a66;
  --dc-track:.16em;
  --dc-accent:#f0a020;
  font:13px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dc-ink);
  -webkit-user-select:none;user-select:none}
#hud .dc-hide{display:none!important}
/* Every read-out carries its own dark halo. The bar survives a bright beach by
   putting solid dark plates behind everything (ref/voxiom/desktop-08-combat.png);
   a translucent panel over white sand does not. A two-stop shadow buys the same
   legibility for zero layout and zero extra nodes, and it is what keeps the
   corner text readable over sand, snow and sky as well as over a dark arena. */
#hud .dc-pad{position:absolute;pointer-events:none;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 8px rgba(0,0,0,.6)}

#hud .dc-map{top:12px;left:12px;width:168px}
#hud .dc-map canvas{display:block;width:168px;height:168px;border:1px solid var(--dc-line);
  border-radius:var(--dc-r);background:var(--dc-plate-solid);box-shadow:var(--dc-lift)}
#hud .dc-chips{display:flex;gap:6px;margin-top:7px}
#hud .dc-chip{display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:var(--dc-r);
  background:var(--dc-plate);border:1px solid var(--dc-line);font-size:12px;
  font-variant-numeric:tabular-nums}
#hud .dc-chip i{font-style:normal;opacity:.72;font-size:11px}
#hud .dc-chip b{display:none;font-weight:400;opacity:.72;font-size:10px}

/* ---- the match rail: three cells, one plate, and a cap in code -------------
   This is the surface the last round lost on. It shipped as SIX floating pills
   — ROUND 1 / TIME 7:43 / FRAG LIMIT 0/30 / LEADER Marine 0 / YOU 0 / IN MATCH
   1+5 — twelve strings across ~650 px, sitting directly above the sightline.
   Three of the six encoded the same score state from three angles and one of
   them ("1+5") was not decodable at all. Measured against this piece's own
   question — which tells you your state in a single glance — it was the single
   worst thing on the HUD: the most ink, the most strings, the least state.

   The rail now carries exactly what only the top-centre can carry, and nothing
   a corner or the Tab board carries better:

     - the clock, because time-left has no other home and is the one match fact
       you check on a rhythm rather than on an event;
     - YOU n/limit, ONE score cell that fuses the three overlapping ones: your
       frags and the number that ends the match, which is the pair you actually
       play against. Who is leading is a ranking question, and a ranking is a
       list, so it belongs to the Tab board — which already sorts by frags and
       puts the leader on row one;
     - PLAYERS n, the roster size, spelled out. "1+5" was a humans-plus-bots
       split nobody can decode mid-fight; the split is a lobby fact and it is
       already in the Tab board's footer, in words.

   Three cells is not a convention here, it is RAIL_MAX_CELLS and MatchRail
   will not build a fourth — the same way the sightline has SIGHTLINE_INK_BUDGET
   rather than a comment asking future changes to be tasteful. And it is ONE
   plate with hairline dividers rather than three plates with three gaps: one
   object the eye parses once, ~250 px wide instead of ~650, five strings
   instead of twelve, on the same radius/keyline/fill as every other plate on
   the HUD. */
#hud .dc-rail{position:absolute;left:50%;top:10px;transform:translateX(-50%);
  display:flex;align-items:stretch;pointer-events:none;white-space:nowrap;
  background:var(--dc-plate);border:1px solid var(--dc-line);border-radius:var(--dc-r);
  box-shadow:var(--dc-lift);text-shadow:0 1px 2px rgba(0,0,0,.9);overflow:hidden;
  font:12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;contain:layout style}
#hud .dc-rail .cell{display:flex;align-items:baseline;gap:7px;padding:6px 11px}
/* Hairlines, not gaps. A divider says "same object, next field"; a gap says
   "different object", which is the read the six pills gave by accident. */
#hud .dc-rail .cell+.cell{border-left:1px solid var(--dc-line-soft)}
#hud .dc-rail i{font-style:normal;font-size:9px;letter-spacing:var(--dc-track);
  color:var(--dc-label);text-transform:uppercase}
#hud .dc-rail b{font-weight:800;color:var(--dc-ink);font-variant-numeric:tabular-nums;
  font-size:13px}
/* The clock is the only cell without a label — a mm:ss in a match HUD needs no
   word — and it carries the weight, so the rail has a shape before it has text. */
#hud .dc-rail .clock{align-items:center}
#hud .dc-rail .clock b{font:800 19px/1 "Arial Black",Impact,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;letter-spacing:.02em}
#hud .dc-rail .you b{color:var(--dc-accent)}
/* Urgency lands on the cell, never on the whole plate: a flashing 250 px slab
   above the sightline is the clutter this rail exists to have removed. */
#hud .dc-rail .clock.urgent b{color:#ff6a48}
#hud .dc-rail .clock.urgent{background:rgba(48,10,6,.55);
  animation:dcurge 1s steps(2,end) infinite}
@keyframes dcurge{50%{background:rgba(48,10,6,0)}}
#hud .dc-rail .clock.warm b{color:#8fe08a}

#hud .dc-perf{top:12px;right:12px;text-align:right;font-size:12px;color:#b6b0aa;
  font-variant-numeric:tabular-nums;line-height:1.45}
#hud .dc-perf b{color:#e8e6e3;font-weight:700}

#hud .dc-feed{left:12px;bottom:118px;width:340px;display:flex;flex-direction:column;
  justify-content:flex-end;gap:3px}
#hud .dc-feed .ln{padding:3px 8px;border-radius:var(--dc-r);background:var(--dc-plate);
  border-left:2px solid #4a4a55;font-size:12px;opacity:1;transition:opacity .35s linear;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hud .dc-feed .ln.k{border-left-color:#e03c1c}
#hud .dc-feed .ln.j{border-left-color:#f0a020;color:#e2b782}
#hud .dc-feed .ln.s{border-left-color:#3a7fbe;color:#9fc3e2}
#hud .dc-feed .ln.out{opacity:0}
/* The hints are a first-fifteen-seconds affordance, not furniture. They fade
   themselves out so the corner is clean for the other 99% of the match. */
#hud .dc-hint{left:12px;bottom:96px;font-size:11px;color:#a49e98;letter-spacing:.02em;
  opacity:1;transition:opacity .9s linear}
#hud .dc-hint b{color:#e0dad4;font-weight:700;background:rgba(0,0,0,.55);
  padding:0 4px;border-radius:var(--dc-r)}

/* ---- vitals ---------------------------------------------------------------
   Deliberately unequal: health is twice the height of armour, so which bar is
   which is answered by SHAPE before you read either label. The bar gives both
   the same weight and makes you read "shield" vs "cross" icons to tell them
   apart (ref/voxiom/desktop-08-combat.png, bottom left). */
#hud .dc-vitals{left:12px;bottom:12px;width:252px}
/* Opaque, not translucent. The critical-health vignette is red and paints
   UNDER this cluster, so a 74%-alpha plate let the red wash straight through
   the health bar at exactly the moment the health bar is the only thing on
   screen that matters. It now sits on its own black. */
#hud .dc-bar{position:relative;border:1px solid var(--dc-line);border-radius:var(--dc-r);
  background:var(--dc-plate-solid);overflow:hidden;box-shadow:var(--dc-lift)}
#hud .dc-bar .ghost,#hud .dc-bar .fill{position:absolute;inset:0;width:100%;
  transform-origin:left center}
#hud .dc-bar .fill{transition:transform .1s linear}
/* The ghost is warm and bright enough to be its own band between the live fill
   and the empty track, so "I just lost 30" is a LENGTH, not a numeral read. */
#hud .dc-bar .ghost{background:rgba(255,138,96,.55)}
#hud .dc-bar .ticks{position:absolute;inset:0;
  background:repeating-linear-gradient(90deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) calc(25% - 1px),
    rgba(0,0,0,.62) calc(25% - 1px),rgba(0,0,0,.62) 25%)}
#hud .dc-bar .lbl{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:space-between;padding:0 9px;font-weight:700;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 6px rgba(0,0,0,.8);
  font-variant-numeric:tabular-nums}
#hud .dc-bar .lbl i{font-style:normal;opacity:.82;font-size:10px;letter-spacing:.14em}

#hud .dc-ap{height:19px;margin-bottom:5px}
#hud .dc-ap .fill{background:linear-gradient(180deg,#59a6e2,#22557f)}
#hud .dc-ap .ghost{display:none}
#hud .dc-ap .lbl{font-size:14px}
#hud .dc-ap .lbl i{font-size:10px}
/* Zero armour has to SAY zero armour. The bar draws 0/100 as an unfilled
   outlined rectangle (ref/voxiom/desktop-08-combat.png, bottom left) which
   reads as an empty container — a bar whose value has not loaded yet — rather
   than as a fact about the player. Ours goes hatched and drops the numeral, so
   there is no empty trough left to misread and the words carry the state. */
#hud .dc-ap[data-z="1"]{border-color:var(--dc-line-soft);
  background:repeating-linear-gradient(135deg,#0a0a0e 0 5px,#14141a 5px 10px)}
#hud .dc-ap[data-z="1"] .fill{display:none}
#hud .dc-ap[data-z="1"] .ticks{display:none}
#hud .dc-ap[data-z="1"] .lbl{color:#8a847e;justify-content:flex-start}
#hud .dc-ap[data-z="1"] .lbl i{opacity:1;font-size:11px}

/* Health is two and a half times the height of armour and carries the biggest
   numeral in the left half of the frame, so the hierarchy answers "how am I
   doing" before any reading happens at all. It is also sized against the
   magazine numeral in the OPPOSITE corner rather than against the armour bar
   above it: health at 26 px next to a 52 px clip count said, in type, that
   ammunition is the more important fact — which is backwards, because you can
   survive an empty magazine. The two numbers that decide a fight now read at
   comparable weight from opposite ends of the frame. */
#hud .dc-hp{height:38px}
#hud .dc-hp .fill{background:linear-gradient(180deg,#4cc46b,#2d8c47)}
#hud .dc-hp .lbl{font-size:31px}
#hud .dc-hp .lbl i{font-size:10px}
#hud .dc-hp[data-t="1"] .fill{background:linear-gradient(180deg,#ffbe37,#c9820f)}
#hud .dc-hp[data-t="2"] .fill{background:linear-gradient(180deg,#ff5a2e,#c81f08)}
#hud .dc-hp[data-t="2"]{border-color:var(--dc-line-hot);
  animation:dcpulse .62s steps(2,end) infinite}
#hud .dc-hp[data-t="2"] .lbl{color:#fff1ea}
#hud .dc-hp[data-t="2"] .lbl i{color:#ff9c7d;opacity:1}
@keyframes dcpulse{50%{box-shadow:0 0 0 2px rgba(255,88,48,.7),0 0 20px rgba(224,60,28,.55)}}

/* ---- ammo -----------------------------------------------------------------
   THE numeral pair. Clip and reserve sit side by side as "4 / 8" on their own
   opaque plate, parked directly on top of the hotbar, so the bottom-right
   corner answers "can I keep firing" and "will I still be firing in ten
   seconds" in one fixation and the bottom-left answers "am I about to die" in
   the other. The bar has no ammunition state at all — its bottom-right is five
   voxel thumbnails at roughly 15% luminance contrast over sand
   (ref/voxiom/desktop-08-combat.png) — so this is the widest opening on the
   whole HUD and it is worth a plate, not a scrim. The previous version floated
   this type on a radial gradient and let the reserve fall to 14 px, which is
   the same mistake the bar makes with its own 13 px bar values: a number you
   have to hunt for is a number you do not read mid-fight. */
#hud .dc-ammo{--dc-mag:52px;right:12px;bottom:64px;text-align:right;
  padding:6px 11px 8px;border:1px solid var(--dc-line);border-radius:var(--dc-r);
  background:var(--dc-plate-solid);box-shadow:var(--dc-lift)}
/* Rows are blocks and their contents are INLINE, so every row is placed by the
   cluster's own text-align. That is what lets the right-handed, left-handed
   and centred thumb-pad layouts each move one property and get a correct
   layout, instead of needing a justify-content per row per breakpoint. */
#hud .dc-ammo .nums{display:block;white-space:nowrap;font-variant-numeric:tabular-nums}
#hud .dc-ammo .mag{font:800 var(--dc-mag)/0.92 "Arial Black",Impact,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;text-shadow:0 2px 0 #4a1005,0 6px 16px rgba(0,0,0,.7)}
/* Reserve is set at 56% of the clip — about the cap-height of the health
   numeral in the opposite corner, so the three numbers that decide a fight are
   the three largest glyphs on the screen and they are all the same weight. */
#hud .dc-ammo .sep{font:700 calc(var(--dc-mag)*0.42)/1 "Arial Black",Impact,system-ui,sans-serif;
  color:#6e6862;margin:0 4px;text-shadow:0 1px 2px rgba(0,0,0,.9)}
#hud .dc-ammo .res{font:800 calc(var(--dc-mag)*0.56)/1 "Arial Black",Impact,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;color:#d2ccc6;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 3px 10px rgba(0,0,0,.6)}
/* The empty half of the round strip is DARK, not a white wash: a 17%-white pip
   on a sunlit sand wall is invisible, so "how many left" stopped being
   countable exactly where the bar's own maps are brightest. */
#hud .dc-ammo .rounds{display:block;height:8px;margin-top:7px;font-size:0}
#hud .dc-ammo .pips{display:inline-flex;vertical-align:top;gap:2px}
/* Square, like everything else. A 1 px radius on a 7 px pip was a sixth
   container treatment nobody asked for, and it read as a smudge. */
#hud .dc-ammo .pips i{display:block;width:7px;height:8px;
  background:rgba(6,6,9,.72);box-shadow:inset 0 0 0 1px rgba(255,255,255,.26)}
#hud .dc-ammo .pips i.on{background:#f2efec;box-shadow:inset 0 0 0 1px rgba(0,0,0,.55)}
#hud .dc-ammo .strip{display:inline-block;vertical-align:top;position:relative;width:118px;
  height:8px;overflow:hidden;
  background:rgba(6,6,9,.72);box-shadow:inset 0 0 0 1px rgba(255,255,255,.26)}
#hud .dc-ammo .strip s{position:absolute;inset:0;text-decoration:none;background:#f2efec;
  transform-origin:left center}
#hud .dc-ammo .wep{font-size:11px;letter-spacing:var(--dc-track);text-transform:uppercase;color:#ded8d2;
  margin-top:5px;white-space:nowrap}
#hud .dc-ammo.low .mag{color:#ffbe37}
#hud .dc-ammo.low .pips i.on,#hud .dc-ammo.low .strip s{background:#ffbe37}
/* An empty magazine gets the same throbbing plate edge as critical health,
   because it is the same class of fact: act now or die. Nothing else on the
   HUD pulses, so the two of them cannot be confused with decoration. */
#hud .dc-ammo.empty .mag{color:#ff5a2e}
#hud .dc-ammo.empty .pips i.on,#hud .dc-ammo.empty .strip s{background:#ff5a2e}
#hud .dc-ammo.empty{border-color:var(--dc-line-hot);animation:dcpulse .62s steps(2,end) infinite}
#hud .dc-ammo.rld .mag{color:#8b8681}
#hud .dc-ammo.rld .wep{color:var(--dc-accent)}
#hud .dc-ammo.rld .pips i.on,#hud .dc-ammo.rld .strip s{background:#f0a020}

/* ---- hotbar ---------------------------------------------------------------
   Slots hold SHAPES, not three-letter codes. The bar's slots hold pictures of
   objects and ours held PST SHT CHG RKT PLS BFG SAW — seven abbreviations at
   10 px, which is a word search at a glance and illegible outright on the
   34 px slot a landscape phone gets. The glyph inherits the slot's colour, so
   the selected slot's inversion takes the silhouette with it and no second rule
   has to be kept in sync. */
#hud .dc-hotbar{right:12px;bottom:12px;display:flex;gap:5px}
#hud .dc-slot{width:44px;height:44px;border:1px solid var(--dc-line);
  border-radius:var(--dc-r);background:var(--dc-plate);position:relative;
  display:grid;place-items:center;font-size:10px;letter-spacing:.06em;color:#cec8c2}
/* No drop-shadow filter here on purpose: the tile is already an opaque dark
   plate, so the shadow bought nothing and cost seven rasterised filter layers
   on a HUD whose whole cost story is that it does not repaint. */
#hud .dc-slot svg{display:block;width:27px;height:27px;fill:currentColor}
/* Lifted off the count so the two never share a pixel. */
#hud .dc-slot .g{transform:translateY(-3px)}
#hud .dc-slot .n{position:absolute;left:3px;top:2px;font-size:9px;color:#807a75}
/* The reserve behind every gun, not just the one in your hands. The bar prints
   a stack count in the same corner (ref/voxiom/desktop-08-combat.png, tile 2),
   and it is the one number that answers "which gun can I still switch to"
   without switching to it and pulling the trigger. */
#hud .dc-slot .ct{position:absolute;right:3px;bottom:4px;font-size:9px;line-height:1;
  color:#b6b0aa;font-variant-numeric:tabular-nums;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 4px rgba(0,0,0,.8)}
#hud .dc-slot .ct:empty{display:none}
/* The ammo-type stripe is the slot's colour key back to the reserve numeral in
   the ammo plate. At 2 px and 60% it was decoration; on the bottom edge at
   full strength it is a read. */
#hud .dc-slot .am{position:absolute;left:0;right:0;bottom:0;height:3px;opacity:.9}
#hud .dc-slot.dry{opacity:.62}
#hud .dc-slot.dry .am{background:#e03c1c!important;opacity:1}
#hud .dc-slot.dry svg{color:#b9695a}
#hud .dc-slot.dry .ct{color:#e07a5a}
/* The selected slot is a FILLED plate with near-black glyphs, not a hairline.
   The bar marks its active slot with a 2 px white outline over a translucent
   tile (ref/voxiom/desktop-08-combat.png, tile 3) and that outline vanishes
   against sand and snow. Inverting the tile — light plate, dark type, hard
   black keyline — is a VALUE contrast rather than a hue contrast, so it
   survives every terrain in shared/src/blocks.ts including the one hue it is
   closest to, lava. The keyline is what lava does not have. */
#hud .dc-slot.on{border-color:#ffd071;background:var(--dc-accent);color:#180d01;font-weight:700;
  box-shadow:0 0 0 2px rgba(0,0,0,.62),0 0 16px rgba(240,160,32,.42);opacity:1}
#hud .dc-slot.on .n{color:#3d2703;font-weight:700}
#hud .dc-slot.on .ct{color:#3a2402;text-shadow:none;font-weight:700}
#hud .dc-slot.on .am{opacity:1;box-shadow:0 0 0 1px rgba(0,0,0,.55)}
#hud .dc-slot.on.dry{opacity:1;background:#e6603c;border-color:#ff9c7d}
#hud .dc-slot.on.dry svg{color:#210802}
#hud .dc-slot.on.dry .ct{color:#320c02}
#hud .dc-slot.no{opacity:.3}
#hud .dc-slot.no .am{opacity:.2}

#hud .dc-cross{left:50%;top:50%;transform:translate(-50%,-50%)}

/* ---- status: the sightline budget -----------------------------------------
   The bar sets its transient line at 28 px cap height across 478 px and parks
   it 180 px ABOVE its own crosshair — ~19,000 px² of white glyph box directly
   on the aim line (ref/voxiom/desktop-08-combat.png). This is the same fact
   set at 11 px letterspaced caps on an opaque plate whose TOP edge is
   --dc-drop (120 px on desktop) BELOW the reticle: about 1,600 px², a
   twelfth of the ink, and off the sightline entirely. Below rather than above
   because the eye tracks UP to targets; the space under the crosshair is the
   cheapest real estate on the screen that is still inside the fovea.
   Anything that would not fit the budget never gets here at all —
   statusPlacement() sends it to .dc-scorner in the top-left instead. */
#hud .dc-status{left:50%;top:50%;transform:translateX(-50%);
  margin-top:var(--dc-drop,120px);text-align:center;max-width:min(300px,58vw);
  padding:4px 11px 5px;border-radius:var(--dc-r);background:var(--dc-plate-solid);
  border:1px solid var(--dc-line);box-shadow:var(--dc-lift)}
#hud .dc-status .t{font:700 11px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.22em;text-transform:uppercase;color:#cfc9c3;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hud .dc-status .s{font:400 10px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.16em;text-transform:uppercase;color:#8a847e;margin-top:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hud .dc-status .t:empty,#hud .dc-status .s:empty{display:none}
/* Dead is the one state with no aim line to protect: the crosshair is hidden
   because you cannot shoot, so the keep-out does not exist and the card may
   own the middle. It is still a CARD — an opaque plate with a hot edge — not
   26 px of Arial Black floating loose on the sky. */
#hud .dc-status[data-d="1"]{transform:translate(-50%,-50%);margin-top:0;
  max-width:min(420px,76vw);padding:13px 24px 14px;border-color:var(--dc-line-hot);
  box-shadow:0 0 0 1px rgba(0,0,0,.8),0 18px 46px rgba(0,0,0,.62)}
#hud .dc-status[data-d="1"] .t{font:800 30px/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.10em;color:#ff5a2e;text-shadow:0 2px 0 #4a1005,0 6px 20px rgba(0,0,0,.8)}
#hud .dc-status[data-d="1"] .s{font-size:11px;letter-spacing:.18em;color:#d2ccc6;margin-top:9px}
/* The demoted form: same words, no sightline cost, sitting under the match
   clock where a player already looks for match state. */
#hud .dc-scorner{display:none;width:max-content;max-width:min(300px,40vw);
  margin-top:6px;padding:3px 8px;border-radius:var(--dc-r);background:var(--dc-plate);
  border:1px solid var(--dc-line);font-size:10px;letter-spacing:.18em;
  text-transform:uppercase;color:#cfc9c3;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
#hud .dc-scorner.on{display:block}

#hud .dc-board{left:50%;top:50%;transform:translate(-50%,-50%);width:min(520px,86vw);
  background:rgba(10,10,14,.94);border:1px solid var(--dc-line);border-radius:var(--dc-r);
  padding:14px 16px;box-shadow:0 20px 50px rgba(0,0,0,.6)}
#hud .dc-board h3{margin:0 0 10px;font:800 15px/1 "Arial Black",Impact,sans-serif;
  letter-spacing:.14em;text-transform:uppercase;color:var(--dc-accent)}
#hud .dc-board table{width:100%;border-collapse:collapse;font-size:13px}
#hud .dc-board th{text-align:left;font-size:10px;letter-spacing:var(--dc-track);
  text-transform:uppercase;color:var(--dc-label);font-weight:600;padding-bottom:6px}
#hud .dc-board td{padding:3px 0;font-variant-numeric:tabular-nums;color:#cfc9c3}
#hud .dc-board td.n{width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hud .dc-board tr.me td{color:#f6e3c8;font-weight:700}
#hud .dc-board td.r{text-align:right}

/* ---- damage ---------------------------------------------------------------
   One vignette element, driven from max(hit flash, critical throb): the hit
   read and the "about to die" read share a layer so the HUD never stacks two
   full-screen overlays. Transparent across the middle 44% — the centre stays
   clean even while you are being shot. */
#hud .dc-hurt{inset:0;opacity:0;
  background:radial-gradient(122% 98% at 50% 50%,rgba(180,20,10,0) 44%,rgba(158,12,4,.92) 100%)}
/* The blades are anchored to the FRAME, not to a fixed pixel radius. A 174 px
   ring put solid triangles a third of the way in from the edge of a desktop
   window — mid-field furniture, which is exactly the clutter the bar avoids by
   living in its corners. Each blade's bright edge now lands on an ellipse
   inscribed in the viewport, so it reads as the rim of the screen catching
   fire on the bearing the shot came from and the middle stays empty. The
   container clips, so a blade rotated into a corner cannot escape the frame. */
#hud .dc-dmg{inset:0;overflow:hidden}
#hud .dc-dmg .hub{position:absolute;left:50%;top:50%;width:0;height:0}
/* The last layer paints BEHIND the other two: a soft dark halo the hot core
   sits inside. Orange on a sunlit beach is orange on orange — the blade read
   fine over dark rock and washed out over exactly the terrain the bar's own
   maps are made of. A dark ground under it is a value contrast, and unlike a
   drop-shadow filter it is a plain gradient the compositor already has. */
#hud .dc-dmg span{position:absolute;left:0;top:0;width:210px;height:46px;margin-left:-105px;
  transform-origin:50% 0;opacity:0;will-change:transform,opacity;
  background:
    radial-gradient(34% 16% at 50% 0%,rgba(255,255,252,.95) 0%,rgba(255,228,198,0) 100%),
    radial-gradient(48% 120% at 50% 0%,rgba(255,246,236,.96) 0%,rgba(255,186,124,.90) 13%,
      rgba(255,96,40,.68) 33%,rgba(214,34,10,.26) 62%,rgba(180,14,4,0) 100%),
    radial-gradient(50% 100% at 50% 0%,rgba(0,0,0,.52) 0%,rgba(0,0,0,.34) 40%,
      rgba(0,0,0,.12) 74%,rgba(0,0,0,0) 100%)}

/* A THREAT blade is the same geometry and a deliberately different read: cold
   instead of hot, a hairline instead of a wedge, and no white core. Being shot
   is orange and loud; something noticing you is a pale edge-light you catch in
   peripheral vision and can choose to turn onto. If these two looked alike the
   HUD would be telling one lie in two colours. */
#hud .dc-dmg span.thr{width:132px;height:30px;margin-left:-66px;
  background:
    radial-gradient(46% 110% at 50% 0%,rgba(214,244,255,.78) 0%,rgba(120,196,232,.52) 26%,
      rgba(52,132,178,.22) 60%,rgba(24,72,104,0) 100%),
    radial-gradient(52% 100% at 50% 0%,rgba(0,0,0,.46) 0%,rgba(0,0,0,.26) 46%,rgba(0,0,0,0) 100%)}

/* ---- touch ---- */
#hud .dc-touch{inset:0;pointer-events:none}
#hud .dc-stick{position:absolute;left:26px;bottom:26px;width:132px;height:132px;border-radius:50%;
  border:2px solid rgba(255,255,255,.30);background:rgba(10,10,14,.42);pointer-events:auto;
  touch-action:none}
#hud .dc-stick .knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;
  border-radius:50%;background:rgba(232,230,227,.55);border:2px solid rgba(255,255,255,.75);
  will-change:transform}
#hud .dc-look{position:absolute;right:0;top:0;bottom:0;width:58%;pointer-events:auto;touch-action:none}
#hud .dc-btn{position:absolute;border-radius:50%;pointer-events:auto;display:grid;place-items:center;
  background:rgba(12,12,16,.62);border:2px solid rgba(255,255,255,.34);color:#e8e6e3;
  font-size:11px;font-weight:700;letter-spacing:.04em;touch-action:none}
#hud .dc-btn.press{background:rgba(224,60,28,.55);border-color:var(--dc-accent)}
#hud .dc-fire{right:24px;bottom:110px;width:96px;height:96px;
  background:rgba(224,60,28,.34);border-color:rgba(240,160,32,.85);font-size:13px}
#hud .dc-jump{right:132px;bottom:150px;width:64px;height:64px}
#hud .dc-crouch{right:132px;bottom:74px;width:64px;height:64px}
#hud .dc-sprint{right:32px;bottom:22px;width:64px;height:64px}
#hud .dc-reload{right:112px;bottom:14px;width:56px;height:56px}
#hud .dc-build{left:34px;bottom:176px;width:56px;height:56px}
#hud .dc-pause{position:absolute;right:12px;top:12px;width:38px;height:38px;
  border-radius:var(--dc-r);pointer-events:auto;background:var(--dc-plate);
  border:1px solid var(--dc-line);
  display:grid;place-items:center;color:#e8e6e3;font-size:14px}

/* ---- short viewports: the bar ships its desktop HUD to a 412px phone ---- */
#hud[data-compact="1"] .dc-map canvas{width:104px;height:104px}
#hud[data-compact="1"] .dc-map{width:104px;top:8px;left:8px}
/* One row of short-labelled chips under the map instead of a three-high
   column. On a 412 px-tall landscape phone the column ate 70 px of the left
   edge for three numbers; the row costs 22 px and reads in the same glance. */
#hud[data-compact="1"] .dc-chips{flex-direction:row;gap:4px;margin-top:6px}
#hud[data-compact="1"] .dc-chip{padding:2px 6px;gap:4px;font-size:11px}
#hud[data-compact="1"] .dc-chip i{display:none}
#hud[data-compact="1"] .dc-chip b{display:inline}
/* The rail leaves the centre on a short screen. Measured, not guessed: at
   915x412 and at 412x915 the chat lane sits at the TOP, .dc-feed{top:8px;
   left:112..120px}, which is exactly where a centred rail lands — so keeping it
   centred is how you reproduce the bar's own mobile mistake (BAR.md #11),
   desktop furniture crammed into a quarter of the screen. It drops into the
   left gutter under the minimap instead: the map ends at y=112, the thumb stick
   starts at y=286, and the base HUD's own chip lane already reserves that band.
   It stays a ROW, not a column — a column ate 70 px of the left edge for three
   numbers, a row costs 22 px and reads in the same glance. */
#hud[data-compact="1"] .dc-rail{left:8px;top:116px;transform:none;font-size:10px}
#hud[data-compact="1"] .dc-rail .cell{padding:4px 8px;gap:5px}
#hud[data-compact="1"] .dc-rail b{font-size:11px}
#hud[data-compact="1"] .dc-rail .clock b{font-size:15px}
#hud[data-compact="1"] .dc-feed{bottom:auto;top:8px;left:120px;width:min(46vw,220px)}
#hud[data-compact="1"] .dc-hint{display:none}
#hud[data-compact="1"] .dc-vitals{width:min(52vw,214px);bottom:8px;left:8px}
#hud[data-compact="1"] .dc-ap{height:15px;margin-bottom:4px}
#hud[data-compact="1"] .dc-ap .lbl{font-size:12px}
#hud[data-compact="1"] .dc-hp{height:29px}
#hud[data-compact="1"] .dc-hp .lbl{font-size:22px}
/* --dc-mag drives the clip, the separator and the reserve together, so a
   breakpoint scales the numeral pair as a unit and can never leave the reserve
   larger than the clip it belongs to. */
#hud[data-compact="1"] .dc-ammo{--dc-mag:34px;bottom:48px;right:8px;padding:5px 9px 6px}
#hud[data-compact="1"] .dc-ammo .strip{width:88px}
#hud[data-compact="1"] .dc-ammo .wep{font-size:10px;letter-spacing:.10em}
#hud[data-compact="1"] .dc-hotbar{right:8px;bottom:8px;gap:3px}
#hud[data-compact="1"] .dc-slot{width:34px;height:34px;font-size:9px}
/* A 34 px slot cannot carry a silhouette AND a stack count AND an index. The
   silhouette is the one that still works at this size, so the count drops and
   the dry stripe keeps answering "can I switch to it". */
#hud[data-compact="1"] .dc-slot svg{width:23px;height:23px}
#hud[data-compact="1"] .dc-slot .g{transform:none}
#hud[data-compact="1"] .dc-slot .ct{display:none}
#hud[data-compact="1"] .dc-slot .n{left:2px;top:1px;font-size:8px}
#hud[data-compact="1"] .dc-dmg span{width:150px;height:42px;margin-left:-75px}
/* A phone has less sightline to spend, not more: the plate shrinks with the
   keep-out rather than keeping its desktop size on a quarter of the screen. */
#hud[data-compact="1"] .dc-status{max-width:min(230px,62vw);padding:3px 8px 4px}
#hud[data-compact="1"] .dc-status .t{font-size:10px;letter-spacing:.18em}
#hud[data-compact="1"] .dc-status .s{font-size:9px;letter-spacing:.13em;margin-top:2px}
#hud[data-compact="1"] .dc-status[data-d="1"]{padding:9px 16px 10px}
#hud[data-compact="1"] .dc-status[data-d="1"] .t{font-size:22px}
#hud[data-compact="1"] .dc-status[data-d="1"] .s{font-size:10px;margin-top:6px}
#hud[data-compact="1"] .dc-scorner{max-width:min(200px,44vw);font-size:9px;
  letter-spacing:.14em;margin-top:5px;padding:2px 6px}
/* The pause glyph owns the top-right corner on touch, so the perf read-out
   steps aside instead of printing underneath it. */
#hud[data-touch="1"] .dc-perf{right:58px}
/* Portrait. The bar refuses to run here at all (ref/BAR.md weakness #8), so
   the whole point is that this layout is not a squashed desktop: the read-outs
   sit ABOVE the thumb zone and nothing the player needs is under a finger. */
#hud[data-portrait="1"] .dc-vitals{bottom:198px;width:min(56vw,200px)}
#hud[data-portrait="1"] .dc-ammo{--dc-mag:32px;bottom:292px;right:8px}
#hud[data-portrait="1"] .dc-ammo .strip{width:80px}
#hud[data-portrait="1"] .dc-hotbar{bottom:252px;right:8px;gap:2px}
#hud[data-portrait="1"] .dc-slot{width:32px;height:32px}
#hud[data-portrait="1"] .dc-slot svg{width:22px;height:22px}
#hud[data-portrait="1"] .dc-feed{left:116px;width:min(52vw,220px);top:8px}
/* 412 px of width will not carry map + feed + perf + pause on one row, so in
   portrait the perf read-out drops under the pause glyph instead of printing
   through the kill feed. */
#hud[data-portrait="1"] .dc-perf{top:56px;right:12px}
#hud[data-portrait="1"] .dc-dmg span{width:132px;height:38px;margin-left:-66px}
#hud[data-portrait="1"] .dc-build{left:auto;right:126px;bottom:206px;width:52px;height:52px}
#hud[data-portrait="1"] .dc-fire{right:18px;bottom:96px;width:104px;height:104px}
#hud[data-portrait="1"] .dc-jump{right:130px;bottom:132px}
#hud[data-portrait="1"] .dc-crouch{right:130px;bottom:58px}
#hud[data-portrait="1"] .dc-sprint{right:26px;bottom:16px}
#hud[data-portrait="1"] .dc-reload{right:196px;bottom:36px}
#hud[data-portrait="1"] .dc-stick{left:18px;bottom:20px;width:126px;height:126px}

/* ---- short landscape WITH a thumb pad -------------------------------------
   915x412 is the bar's own mobile viewport, and it ships its desktop HUD there
   unchanged (ref/BAR.md weakness #11): the read-outs end up underneath the
   thumbs. Here the whole bottom-right quadrant belongs to the fire cluster, so
   the ammo and the hotbar move to the free centre column. */
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-hotbar{
  left:50%;right:auto;transform:translateX(-50%);bottom:6px;gap:3px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo{--dc-mag:28px;
  left:50%;right:auto;transform:translateX(-50%);bottom:46px;text-align:center;
  padding:4px 9px 5px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo .rounds{margin-top:4px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo .strip{width:76px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo .wep{display:none}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-vitals{
  left:150px;bottom:6px;width:170px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-feed{
  left:112px;width:min(40vw,220px);top:6px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-build{
  left:auto;right:214px;bottom:12px;width:48px;height:48px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-stick{
  left:14px;bottom:14px;width:112px;height:112px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-fire{
  right:14px;bottom:60px;width:86px;height:86px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-jump{right:106px;bottom:96px;width:56px;height:56px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-crouch{right:106px;bottom:30px;width:56px;height:56px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-sprint{right:20px;bottom:8px;width:52px;height:52px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-reload{right:168px;bottom:66px;width:48px;height:48px}

/* The urgent clock is the one thing on the rail that moves. Under reduced
   motion it keeps the colour and drops the blink — the state still reads. */
@media (prefers-reduced-motion:reduce){
  #hud .dc-rail .clock.urgent{animation:none;background:rgba(48,10,6,.55)}
}
`;

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

const MAP_VIEW_BLOCKS = 104;   // world blocks across the minimap
const MAP_REDRAW_MS = 100;
const BOARD_REDIFF_MS = 200;
/** Rounds we are willing to draw as individual pips before switching to a bar. */
const MAX_PIPS = 16;
/** Seconds of visible play before the key hints fade themselves away. */
const HINT_SECONDS = 15;
/** How long the damage ghost sits at the old value before it starts draining. */
const GHOST_HOLD = 0.28;
/** CSS px the damage blade's bright edge sits inside the frame. */
const DMG_FRAME_INSET = 4;
/** CSS px from the crosshair centre to the fovea damage ticks. */
const FOVEA_RADIUS = 33;

/* ------------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------------ */

export class Hud {
  readonly root: HTMLElement;

  private readonly opts: HudOptions;
  private touchSink: HudTouchSink | null;
  private crosshairStyle: CrosshairStyle;
  private crosshairColor: number;

  /* dom */
  private elMapCanvas!: HTMLCanvasElement;
  private mapCtx!: CanvasRenderingContext2D;
  private elChipAlive!: HTMLElement;
  private elChipKills!: HTMLElement;
  private elChipTime!: HTMLElement;
  private elPerf!: HTMLElement;
  private elFeed!: HTMLElement;
  private elHint!: HTMLElement;
  private elVitalsHp!: HTMLElement;
  private elVitalsAp!: HTMLElement;
  private elHpFill!: HTMLElement;
  private elHpGhost!: HTMLElement;
  private elApFill!: HTMLElement;
  private elHpNum!: HTMLElement;
  private elHpLabel!: HTMLElement;
  private elApNum!: HTMLElement;
  private elApLabel!: HTMLElement;
  private elAmmo!: HTMLElement;
  private elMag!: HTMLElement;
  private elSep!: HTMLElement;
  private elPips!: HTMLElement;
  private readonly pips: HTMLElement[] = [];
  private elStrip!: HTMLElement;
  private elStripFill!: HTMLElement;
  private elRes!: HTMLElement;
  private elWep!: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly slotCounts: HTMLElement[] = [];
  private readonly slotAmmo = new Uint8Array(WEAPON_COUNT);
  private elHotbar!: HTMLElement;
  private elCross!: HTMLCanvasElement;
  private crossCtx!: CanvasRenderingContext2D;
  private elStatus!: HTMLElement;
  private elStatusT!: HTMLElement;
  private elStatusS!: HTMLElement;
  private elScorner!: HTMLElement;
  private elHurt!: HTMLElement;
  private elDmg!: HTMLElement;
  private readonly dmgWedges: HTMLElement[] = [];
  private readonly threatWedges: HTMLElement[] = [];
  private elBoard!: HTMLElement;
  private elBoardBody!: HTMLElement;
  private boardSig = '';
  private boardTimer = 0;
  private elTouch!: HTMLElement;
  private elStickKnob!: HTMLElement;

  /* world minimap image */
  private readonly mapImage: HTMLCanvasElement;
  private readonly mapImageCtx: CanvasRenderingContext2D;
  private readonly mapPixels: ImageData;
  private mapImageDirty = true;

  /* diff caches — a steady frame must write no DOM */
  private cHealth = -1; private cArmor = -1; private cMag = -1; private cRes = -1;
  private cWeapon = -1; private cOwned = -1; private cKills = -1; private cDeaths = -1;
  private cAlive = -1; private cTime = -1; private cStatus = ''; private cSub = '';
  private cStatusDead = false;
  private cFps = -1; private cPing = -1; private cPerfShown = true;
  private cTier = -1; private cAmmoCls = '';
  private cMagSize = -1; private cRounds = -1; private cReserveSig = -1;
  private cRld = -1; private cApZero = -1;
  private cBoardOpen = false; private cVig = -1; private cDead = false;
  private cGapQ = -1; private cHmQ = -1; private cRlQ = -2; private cEmptyQ = -1;
  private cCritQ = -2;
  private cGhost = -1;

  /* animation clocks */
  private mapTimer = 0;
  private hitMarkerT = 0;
  private hitMarkerHead = false;
  private hitMarkerKill = false;
  private hitMarkerDmg = 0;
  private hurtT = 0;
  private vigT = 0;
  private ghostHp = 1;
  private ghostHold = 0;
  private liveT = 0;
  private hintFaded = false;
  private hintTimer = 0;
  private feedCount = 0;
  private dpr = 1;
  private compact = false;
  private portrait = false;
  private visible = true;
  private disposed = false;

  /** Directional damage, world-anchored. */
  private readonly ring = new DamageRing();
  /**
   * Directional THREAT, world-anchored, on the same machinery.
   *
   * The audio layer locates monsters by ear (`client/src/audio/monsters.ts`),
   * which is a mechanic a player who cannot hear is simply locked out of. This
   * is the same information by another route: an alert cry, an attack windup or
   * a death puts a bearing here, and it is re-projected against the live camera
   * every frame exactly as the damage ring is, so turning onto it works.
   *
   * It is a SEPARATE ring and a separate visual, not a second colour on the
   * damage blades. "I am being shot from there" and "something noticed me over
   * there" are two different facts, and this HUD's own rule is that two
   * different facts must never look the same.
   */
  private readonly threatRing = new DamageRing(THREAT_SLOTS, THREAT_LIFE);
  /** Per-slot screen bearing / opacity / width, shared with the crosshair. */
  private readonly foveaRad = new Float32Array(DMG_SLOTS);
  private readonly foveaA = new Float32Array(DMG_SLOTS);
  private readonly foveaW = new Float32Array(DMG_SLOTS);
  private dmgSig = 0;
  private weaponUi = true;
  private cDmgSig = 1;
  private halfW = 640;
  private halfH = 400;
  private cKeepOut = -1;
  private readonly wedgeDeg = new Float32Array(DMG_SLOTS);
  private readonly wedgeWide = new Float32Array(DMG_SLOTS);
  private readonly wedgeAlpha = new Float32Array(DMG_SLOTS);
  private readonly thrDeg = new Float32Array(THREAT_SLOTS);
  private readonly thrAlpha = new Float32Array(THREAT_SLOTS);

  /* touch */
  private stickId = -1;
  private stickCx = 0;
  private stickCz = 0;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;

  constructor(root: HTMLElement, opts: HudOptions = {}) {
    this.root = root;
    this.opts = opts;
    this.touchSink = opts.touchSink ?? null;
    this.crosshairStyle = opts.crosshair ?? 'dynamic';
    this.crosshairColor = opts.crosshairColor ?? 0xffffff;
    this.wedgeDeg.fill(9999);
    this.thrDeg.fill(9999);

    this.mapImage = document.createElement('canvas');
    this.mapImage.width = WORLD_SIZE_BLOCKS;
    this.mapImage.height = WORLD_SIZE_BLOCKS;
    const mic = this.mapImage.getContext('2d', { alpha: false });
    if (mic === null) throw new Error('2d context unavailable');
    this.mapImageCtx = mic;
    this.mapImageCtx.fillStyle = '#0c0b0e';
    this.mapImageCtx.fillRect(0, 0, WORLD_SIZE_BLOCKS, WORLD_SIZE_BLOCKS);
    this.mapPixels = this.mapImageCtx.createImageData(CHUNK_SIZE_X, CHUNK_SIZE_Z);

    this.build();
    this.layout();
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  /* -------------------------------------------------------------------- *
   * Construction
   * -------------------------------------------------------------------- */

  private build(): void {
    if (document.getElementById('dc-hud-css') === null) {
      const style = document.createElement('style');
      style.id = 'dc-hud-css';
      style.textContent = HUD_CSS;
      document.head.appendChild(style);
    }
    const root = this.root;
    root.textContent = '';

    /* Damage feedback goes in FIRST so it paints UNDER the read-outs: being
       shot must never make the health numeral harder to read. */
    this.elHurt = div('dc-pad dc-hurt');
    root.appendChild(this.elHurt);
    this.elDmg = div('dc-pad dc-dmg');
    const hub = div('hub');
    for (let i = 0; i < DMG_SLOTS; i++) {
      const a = document.createElement('span');
      hub.appendChild(a);
      this.dmgWedges.push(a);
    }
    /* Threat blades are appended AFTER the damage blades so a bearing you are
       being shot from paints over a bearing something merely growled from. */
    for (let i = 0; i < THREAT_SLOTS; i++) {
      const a = document.createElement('span');
      a.className = 'thr';
      hub.appendChild(a);
      this.threatWedges.push(a);
    }
    this.elDmg.appendChild(hub);
    root.appendChild(this.elDmg);

    /* minimap + chips */
    const map = div('dc-pad dc-map');
    this.elMapCanvas = document.createElement('canvas');
    const mc = this.elMapCanvas.getContext('2d', { alpha: false });
    if (mc === null) throw new Error('2d context unavailable');
    this.mapCtx = mc;
    map.appendChild(this.elMapCanvas);
    const chips = div('dc-chips');
    this.elChipAlive = chip(chips, 'ALIVE', 'ALV', '1');
    this.elChipKills = chip(chips, 'KILLS', 'K/D', '0');
    this.elChipTime = chip(chips, 'TIME', 'T', '0:00');
    map.appendChild(chips);
    /* Where an over-budget status line goes instead of onto the sightline:
       one more chip in the top-left stack, directly under the match clock. */
    this.elScorner = div('dc-scorner');
    map.appendChild(this.elScorner);
    root.appendChild(map);

    /* perf */
    this.elPerf = div('dc-pad dc-perf');
    root.appendChild(this.elPerf);

    /* kill feed + hints */
    this.elFeed = div('dc-pad dc-feed');
    root.appendChild(this.elFeed);
    this.elHint = div('dc-pad dc-hint');
    this.elHint.innerHTML = '<b>WASD</b> move &nbsp;<b>Shift</b> sprint &nbsp;<b>RMB</b> place'
      + ' &nbsp;<b>1-7</b> weapon &nbsp;<b>Tab</b> scores';
    root.appendChild(this.elHint);

    /* vitals */
    const vitals = div('dc-pad dc-vitals');
    const ap = div('dc-bar dc-ap');
    this.elApFill = div('fill');
    const apl = div('lbl');
    this.elApLabel = document.createElement('i');
    this.elApLabel.textContent = 'ARMOR';
    apl.appendChild(this.elApLabel);
    this.elApNum = document.createElement('span');
    this.elApNum.textContent = '0';
    apl.appendChild(this.elApNum);
    ap.dataset.z = '1';
    ap.append(this.elApFill, div('ticks'), apl);

    const hp = div('dc-bar dc-hp');
    hp.dataset.t = '0';
    this.elHpGhost = div('ghost');
    this.elHpFill = div('fill');
    const hpl = div('lbl');
    this.elHpLabel = document.createElement('i');
    this.elHpLabel.textContent = 'HEALTH';
    hpl.appendChild(this.elHpLabel);
    this.elHpNum = document.createElement('span');
    this.elHpNum.textContent = String(MAX_HEALTH);
    hpl.appendChild(this.elHpNum);
    hp.append(this.elHpGhost, this.elHpFill, div('ticks'), hpl);

    vitals.append(ap, hp);
    this.elVitalsAp = ap;
    this.elVitalsHp = hp;
    root.appendChild(vitals);

    /* ammo: the clip/reserve numeral pair, per-round pips, weapon caption.
       Clip and reserve share one row so they read as a single fact ("4 of 8
       left") instead of two numbers in different places at different sizes. */
    this.elAmmo = div('dc-pad dc-ammo');
    const nums = div('nums');
    this.elMag = document.createElement('span');
    this.elMag.className = 'mag';
    this.elMag.textContent = '0';
    this.elSep = document.createElement('span');
    this.elSep.className = 'sep';
    this.elSep.textContent = '/';
    this.elRes = document.createElement('span');
    this.elRes.className = 'res';
    this.elRes.textContent = '0';
    nums.append(this.elMag, this.elSep, this.elRes);
    const rounds = div('rounds');
    this.elPips = div('pips');
    for (let i = 0; i < MAX_PIPS; i++) {
      const p = document.createElement('i');
      this.elPips.appendChild(p);
      this.pips.push(p);
    }
    this.elStrip = div('strip');
    this.elStripFill = document.createElement('s');
    this.elStrip.appendChild(this.elStripFill);
    rounds.append(this.elPips, this.elStrip);
    this.elWep = div('wep');
    this.elWep.textContent = '';
    this.elAmmo.append(nums, rounds, this.elWep);
    root.appendChild(this.elAmmo);

    /* hotbar: a silhouette, an index digit, the reserve behind that gun, and
       an ammo-type stripe that colour-keys the slot to the reserve numeral in
       the plate above it. The glyph markup is written once here and never
       touched again — only the count text and two class flags move. */
    const bar = div('dc-pad dc-hotbar');
    for (let i = 0; i < WEAPON_COUNT; i++) {
      const s = div('dc-slot');
      s.title = WEAPON_NAMES[i] ?? WEAPON_SHORT_NAMES[i] ?? '';
      const n = div('n');
      n.textContent = String(i + 1);
      const g = div('g');
      g.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${weaponGlyph(i)}</svg>`;
      const ct = div('ct');
      const am = div('am');
      const type = ammoTypeOf(i);
      this.slotAmmo[i] = type;
      am.style.background = type === 0
        ? 'rgba(255,255,255,.22)'
        : `#${(AMMO_COLORS[type] ?? 0x888888).toString(16).padStart(6, '0')}`;
      s.append(n, g, ct, am);
      bar.appendChild(s);
      this.slots.push(s);
      this.slotCounts.push(ct);
    }
    this.elHotbar = bar;
    root.appendChild(bar);

    /* crosshair */
    this.elCross = document.createElement('canvas');
    this.elCross.className = 'dc-pad dc-cross';
    const cc = this.elCross.getContext('2d');
    if (cc === null) throw new Error('2d context unavailable');
    this.crossCtx = cc;
    root.appendChild(this.elCross);

    /* status */
    this.elStatus = div('dc-pad dc-status');
    this.elStatusT = div('t');
    this.elStatusS = div('s');
    this.elStatus.append(this.elStatusT, this.elStatusS);
    this.elStatus.classList.add('dc-hide');
    this.elStatus.dataset.d = '0';
    root.appendChild(this.elStatus);

    /* scoreboard */
    this.elBoard = div('dc-pad dc-board dc-hide');
    const bt = document.createElement('h3');
    bt.textContent = 'Scoreboard';
    const table = document.createElement('table');
    const head = document.createElement('tr');
    head.innerHTML = '<th>Marine</th><th style="text-align:right">Kills</th>'
      + '<th style="text-align:right">Deaths</th><th style="text-align:right">Ping</th>';
    const body = document.createElement('tbody');
    table.append(head, body);
    this.elBoardBody = body;
    this.elBoard.append(bt, table);
    root.appendChild(this.elBoard);

    /* touch */
    this.elTouch = div('dc-pad dc-touch');
    this.buildTouch(this.elTouch);
    root.appendChild(this.elTouch);
  }

  private buildTouch(host: HTMLElement): void {
    // Created first and unconditionally so `setTouchVisible` never has to test
    // for its existence, then dropped on the floor when the mobile-controls
    // module owns the pad.
    this.elStickKnob = div('knob');
    if (this.opts.externalPad === true) return;

    const stick = div('dc-stick');
    stick.appendChild(this.elStickKnob);
    host.appendChild(stick);

    const look = div('dc-look');
    host.appendChild(look);

    const fire = btn('dc-btn dc-fire', 'FIRE');
    const jump = btn('dc-btn dc-jump', 'JUMP');
    const crouch = btn('dc-btn dc-crouch', 'CRCH');
    const sprint = btn('dc-btn dc-sprint', 'RUN');
    const reload = btn('dc-btn dc-reload', 'RLD');
    const build = btn('dc-btn dc-build', 'BLD');
    host.append(fire, jump, crouch, sprint, reload, build);

    const pause = btn('dc-pause', '❚❚');
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.opts.onPause?.();
    });
    host.appendChild(pause);

    this.bindHold(fire, InputAction.Fire);
    this.bindHold(jump, InputAction.Jump);
    this.bindHold(crouch, InputAction.Crouch);
    this.bindHold(sprint, InputAction.Sprint);
    this.bindHold(reload, InputAction.Reload);
    this.bindHold(build, InputAction.BuildMode);

    /* left stick */
    const onStick = (e: PointerEvent): void => {
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const max = r.width / 2 - 8;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > max) { dx = dx / len * max; dy = dy / len * max; }
      this.stickCx = dx / max;
      this.stickCz = -dy / max;
      this.elStickKnob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
      this.touchSink?.setMove(this.stickCx, this.stickCz);
    };
    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      onStick(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      e.preventDefault();
      onStick(e);
    });
    const endStick = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.stickCx = 0; this.stickCz = 0;
      this.elStickKnob.style.transform = 'translate(0px,0px)';
      this.touchSink?.setMove(0, 0);
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    /* right half: look drag. The bar has no fire button at all and makes the
       look drag double as the trigger (weakness #9); here they are separate. */
    look.addEventListener('pointerdown', (e) => {
      if (this.lookId >= 0) return;
      e.preventDefault();
      this.lookId = e.pointerId;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
      look.setPointerCapture(e.pointerId);
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      e.preventDefault();
      this.touchSink?.addLook(e.clientX - this.lookX, e.clientY - this.lookY);
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    });
    const endLook = (e: PointerEvent): void => {
      if (e.pointerId !== this.lookId) return;
      this.lookId = -1;
    };
    look.addEventListener('pointerup', endLook);
    look.addEventListener('pointercancel', endLook);
  }

  private bindHold(el: HTMLElement, action: InputAction): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('press');
      this.touchSink?.setButton(action, true);
    });
    const up = (e: PointerEvent): void => {
      if (!el.classList.contains('press')) return;
      e.preventDefault();
      el.classList.remove('press');
      this.touchSink?.setButton(action, false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  /* -------------------------------------------------------------------- *
   * Configuration
   * -------------------------------------------------------------------- */

  setTouchSink(sink: HudTouchSink | null): void { this.touchSink = sink; }

  setTouchVisible(on: boolean): void {
    this.elTouch.classList.toggle('dc-hide', !on);
    this.root.dataset.touch = on ? '1' : '0';
    if (!on) {
      this.touchSink?.reset();
      this.stickId = -1;
      this.lookId = -1;
      this.elStickKnob.style.transform = 'translate(0px,0px)';
    }
  }

  setCrosshair(style: CrosshairStyle, color: number): void {
    this.crosshairStyle = style;
    this.crosshairColor = color;
    this.cGapQ = -1;   // force a redraw
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.style.display = on ? '' : 'none';
  }

  /* -------------------------------------------------------------------- *
   * Events
   * -------------------------------------------------------------------- */

  /** One kill-feed / chat / system line. `kind`: 'k' kill, 'j' join, 's' system. */
  pushFeed(text: string, kind: 'k' | 'j' | 's' = 's'): void {
    const ln = document.createElement('div');
    ln.className = `ln ${kind}`;
    ln.textContent = text;
    this.elFeed.appendChild(ln);
    this.feedCount++;
    while (this.feedCount > 6) {
      const first = this.elFeed.firstElementChild;
      if (first === null) break;
      first.remove();
      this.feedCount--;
    }
    window.setTimeout(() => { ln.classList.add('out'); }, 6500);
    window.setTimeout(() => {
      if (ln.parentNode !== null) { ln.remove(); this.feedCount--; }
    }, 7200);
  }

  /** Drop every line. A mode switch must not leave the last mode talking. */
  clearFeed(): void {
    while (this.elFeed.firstChild !== null) this.elFeed.firstChild.remove();
    this.feedCount = 0;
  }

  /**
   * Show or hide the gun half of the HUD — the ammo readout and the seven-slot
   * hotbar. Builder has no weapons, so leaving "120 BULLETS / PISTOL" on screen
   * over a block palette is just a lie in the corner of the frame.
   */
  setWeaponUiVisible(on: boolean): void {
    this.elAmmo.style.display = on ? '' : 'none';
    this.elHotbar.style.display = on ? '' : 'none';
    /* The crosshair carries the ammo warning, so it has to go quiet too. In
       Builder the state still holds the last gun's empty magazine, and a red
       "you are out" crosshair over a block palette is a lie in the middle of
       the frame. */
    this.weaponUi = on;
    this.cGapQ = -1;
  }

  /**
   * A shot connected. Drives the crosshair pop — the bar has no equivalent.
   * `damage` scales the marker, so a chip and a shotgun slug do not read the
   * same; it is optional so older callers keep working.
   */
  hitMarker(headshot: boolean, killed: boolean, damage = 0): void {
    this.hitMarkerT = killed ? 0.46 : 0.28;
    this.hitMarkerHead = headshot;
    this.hitMarkerKill = killed;
    this.hitMarkerDmg = damage;
    this.cHmQ = -1;
  }

  /**
   * Took damage. `dirYaw` is the WORLD yaw the hit came from; it is stored in
   * world space and re-projected against the live camera every frame, so the
   * wedge tracks the threat while you turn onto it. `camYaw` is accepted for
   * call-site compatibility and deliberately unused.
   */
  hurt(amount: number, dirYaw: number, camYaw: number): void {
    void camYaw;
    this.hurtT = Math.max(this.hurtT, Math.min(0.62, 0.2 + amount / 90));
    this.ring.add(amount, dirYaw);
  }

  /* -------------------------------------------------------------------- *
   * Minimap source
   * -------------------------------------------------------------------- */

  /**
   * Bake one chunk into the world minimap image. Called once when a chunk
   * arrives and again when a delta lands, never per frame.
   */
  updateMinimapChunk(cx: number, cz: number, voxels: Uint8Array): void {
    const px = this.mapPixels;
    const data = px.data;
    let p = 0;
    for (let z = 0; z < CHUNK_SIZE_Z; z++) {
      for (let x = 0; x < CHUNK_SIZE_X; x++) {
        let color = 0x0c0b0e;
        let shade = 1;
        const col = x | (z << 5);
        for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
          const id = voxels[col | (y << 10)];
          if (id === 0) continue;
          color = minimapColor(id);
          // Height shading gives the flat top-down map some relief.
          shade = 0.55 + 0.45 * (y / (CHUNK_HEIGHT - 1));
          if (BLOCK_LIQUID[id] === 1) shade *= 0.85;
          break;
        }
        data[p] = Math.min(255, ((color >> 16) & 0xff) * shade);
        data[p + 1] = Math.min(255, ((color >> 8) & 0xff) * shade);
        data[p + 2] = Math.min(255, (color & 0xff) * shade);
        data[p + 3] = 255;
        p += 4;
      }
    }
    const ox = cx * CHUNK_SIZE_X - WORLD_MIN_BLOCK_X;
    const oz = cz * CHUNK_SIZE_Z - WORLD_MIN_BLOCK_Z;
    if (ox < 0 || oz < 0 || ox + CHUNK_SIZE_X > WORLD_SIZE_BLOCKS || oz + CHUNK_SIZE_Z > WORLD_SIZE_BLOCKS) return;
    this.mapImageCtx.putImageData(px, ox, oz);
    this.mapImageDirty = true;
  }

  /* -------------------------------------------------------------------- *
   * Per-frame
   * -------------------------------------------------------------------- */

  update(s: HudState, dt: number): void {
    if (this.disposed) return;

    const hp = Math.max(0, Math.round(s.health));

    /* --- health: numeral, length, TIER COLOUR, and the damage ghost ----- */
    const hpFrac = Math.min(1, hp / MAX_HEALTH);
    if (hp !== this.cHealth) {
      if (hp < this.cHealth && this.cHealth >= 0) this.ghostHold = GHOST_HOLD;
      this.cHealth = hp;
      this.elHpNum.textContent = String(hp);
      this.elHpFill.style.transform = `scaleX(${hpFrac.toFixed(3)})`;
      const tier = healthTier(hp);
      if (tier !== this.cTier) {
        this.cTier = tier;
        this.elVitalsHp.dataset.t = String(tier);
        /* Colour alone is a guess for the ~8% of players who cannot separate
           the red ramp from the amber one. The word changes too, so the
           "about to die" read survives colour blindness and a washed-out
           phone screen in sunlight. */
        this.elHpLabel.textContent = tier === HEALTH_TIER_CRIT ? 'CRITICAL' : 'HEALTH';
      }
    }
    /* The ghost holds the pre-hit value for a beat and then drains onto the
       live one. It is the difference between "I am on 48" and "I just lost 30",
       and it costs one transform write per frame for about half a second. */
    if (this.ghostHp < hpFrac) {
      this.ghostHp = hpFrac;
      this.ghostHold = 0;
    } else if (this.ghostHp > hpFrac) {
      if (this.ghostHold > 0) {
        this.ghostHold -= dt;
      } else {
        this.ghostHp += (hpFrac - this.ghostHp) * Math.min(1, dt * 7.5);
        if (this.ghostHp - hpFrac < 0.004) this.ghostHp = hpFrac;
      }
    }
    if (Math.abs(this.ghostHp - this.cGhost) > 0.003) {
      this.cGhost = this.ghostHp;
      this.elHpGhost.style.transform = `scaleX(${this.ghostHp.toFixed(3)})`;
    }

    /* --- armour, including the state the bar gets wrong ------------------
       Zero armour is a FACT, not a missing value. The bar renders 0/100 as an
       outlined empty trough, which is indistinguishable from a bar that has
       not been filled in yet; here the trough goes hatched, the numeral drops
       out and the label reads NO ARMOR, so the only thing left in the widget
       is the sentence. */
    const ap = Math.max(0, Math.round(s.armor));
    if (ap !== this.cArmor) {
      this.cArmor = ap;
      this.elApFill.style.transform = `scaleX(${Math.min(1, ap / MAX_ARMOR).toFixed(3)})`;
      const zero = ap > 0 ? 0 : 1;
      if (zero !== this.cApZero) {
        this.cApZero = zero;
        this.elVitalsAp.dataset.z = zero === 1 ? '1' : '0';
        this.elApLabel.textContent = zero === 1 ? 'NO ARMOR' : 'ARMOR';
      }
      this.elApNum.textContent = zero === 1 ? '' : String(ap);
    }

    /* --- ammo ---------------------------------------------------------- */
    const magSize = WEAPON_MAG_SIZE[s.weapon] ?? 0;
    if (magSize !== this.cMagSize) {
      this.cMagSize = magSize;
      const usePips = magSize > 0 && magSize <= MAX_PIPS;
      for (let i = 0; i < MAX_PIPS; i++) {
        this.pips[i].style.display = usePips && i < magSize ? '' : 'none';
      }
      this.elPips.style.display = usePips ? '' : 'none';
      this.elStrip.style.display = magSize > MAX_PIPS ? '' : 'none';
      this.cRounds = -1;
    }
    /* While reloading the pip strip fills up instead of showing the stale
       count: "how long until I can shoot" is the question being asked. */
    const rounds = s.reloading
      ? Math.round(magSize * Math.max(0, Math.min(1, s.reloadFrac)))
      : s.mag;
    if (rounds !== this.cRounds) {
      this.cRounds = rounds;
      if (magSize > 0 && magSize <= MAX_PIPS) {
        for (let i = 0; i < magSize; i++) this.pips[i].classList.toggle('on', i < rounds);
      } else if (magSize > 0) {
        this.elStripFill.style.transform = `scaleX(${(rounds / magSize).toFixed(3)})`;
      }
    }
    /* The clip/reserve pair, the reserve's colour and the caption are one
       write, gated on the four inputs that can move it. An unchanged frame
       still touches nothing and allocates nothing. */
    const rld = s.reloading ? 1 : 0;
    if (s.mag !== this.cMag || s.reserve !== this.cRes || s.weapon !== this.cWeapon
      || rld !== this.cRld) {
      this.cMag = s.mag; this.cRes = s.reserve; this.cRld = rld;
      const r = ammoReadout(s.weapon, s.mag, s.reserve, s.reloading);
      this.elMag.textContent = r.clip;
      this.elRes.textContent = r.reserve;
      this.elWep.textContent = r.caption;
      const vis = r.pair ? '' : 'none';
      this.elSep.style.display = vis;
      this.elRes.style.display = vis;
      /* The reserve numeral is painted in its own pickup colour, so the
         caption's ammo word and the world's ammo crates agree at a glance —
         except at zero, where it turns alarm-red. "Reload and carry on" and
         "there is no more of this ammo anywhere on you" are different facts
         and the bar answers neither of them. */
      const type = ammoTypeOf(s.weapon);
      this.elRes.style.color = s.reserve <= 0
        ? '#ff5a2e'
        : `#${(AMMO_COLORS[type] ?? 0xd2ccc6).toString(16).padStart(6, '0')}`;
    }
    /* Reloading outranks empty: the plate throbs red only while the magazine
       is empty AND nothing is being done about it. A reload already in flight
       is the answer to that alarm, not another instance of it. */
    const aTier = s.reloading ? AMMO_TIER_OK : ammoTier(s.mag, magSize);
    const ammoCls = 'dc-pad dc-ammo'
      + (aTier === AMMO_TIER_EMPTY ? ' empty' : aTier === AMMO_TIER_LOW ? ' low' : '')
      + (s.reloading ? ' rld' : '');
    if (ammoCls !== this.cAmmoCls) {
      this.cAmmoCls = ammoCls;
      this.elAmmo.className = ammoCls;
    }
    if (s.weapon !== this.cWeapon) {
      this.cWeapon = s.weapon;
      for (let i = 0; i < this.slots.length; i++) this.slots[i].classList.toggle('on', i === s.weapon);
    }

    /* Hotbar: owned, selected, and DRY. Knowing which gun still has ammo is
       part of "what is my state", and it is the one thing you otherwise have
       to discover by switching to it and pulling the trigger. */
    let sig = s.weapon * 31 + (s.mag > 0 ? 1 : 0);
    for (let i = 0; i < AMMO_TYPE_COUNT; i++) sig = (sig * 8191 + (s.reserveByType[i] | 0)) | 0;
    if (sig !== this.cReserveSig || s.owned !== this.cOwned) {
      this.cReserveSig = sig;
      this.cOwned = s.owned;
      for (let i = 0; i < this.slots.length; i++) {
        const owned = ownsWeapon(s.owned, i);
        const type = this.slotAmmo[i];
        const reserve = type === 0 ? 1 : s.reserveByType[type];
        const loaded = i === s.weapon && s.mag > 0;
        this.slots[i].classList.toggle('no', !owned);
        this.slots[i].classList.toggle('dry', owned && reserve === 0 && !loaded);
        /* Melee has no reserve and an unfilled table (-1) means "unknown", so
           both print nothing rather than a zero that would read as "dry". */
        const ct = owned && type !== 0 && reserve >= 0 ? String(reserve) : '';
        if (this.slotCounts[i].textContent !== ct) this.slotCounts[i].textContent = ct;
      }
    }

    /* --- chips --------------------------------------------------------- */
    if (s.playersAlive !== this.cAlive) {
      this.cAlive = s.playersAlive;
      this.elChipAlive.textContent = String(s.playersAlive);
    }
    if (s.kills !== this.cKills || s.deaths !== this.cDeaths) {
      this.cKills = s.kills; this.cDeaths = s.deaths;
      this.elChipKills.textContent = `${s.kills}/${s.deaths}`;
    }
    const secs = Math.max(0, Math.floor(s.matchSeconds));
    if (secs !== this.cTime) {
      this.cTime = secs;
      this.elChipTime.textContent = formatClock(secs);
    }

    /* --- perf ---------------------------------------------------------- */
    if (s.showFps !== this.cPerfShown) {
      this.cPerfShown = s.showFps;
      this.elPerf.classList.toggle('dc-hide', !s.showFps);
    }
    if (s.showFps) {
      const fps = Math.round(s.fps);
      const ping = Math.round(s.ping);
      if (fps !== this.cFps || ping !== this.cPing) {
        this.cFps = fps; this.cPing = ping;
        this.elPerf.innerHTML = `<b>${fps}</b> fps<br>${ping} ms`;
      }
    }

    /* --- status: routed through the sightline budget --------------------
       Nothing writes to the middle of the screen without first being costed.
       A short line gets the 11 px plate 120 px UNDER the reticle; a long one
       is demoted to the top-left chip stack; death — the only state with no
       aim line to protect, because the crosshair is hidden — gets the card.
       Guarded by the same `!==` diff as everything else, so a steady frame
       still writes zero DOM. */
    if (s.status !== this.cStatus || s.subStatus !== this.cSub || s.dead !== this.cStatusDead) {
      this.cStatus = s.status;
      this.cSub = s.subStatus;
      this.cStatusDead = s.dead;
      const place = statusPlacement(s.status, s.subStatus, s.dead);
      const centred = place === STATUS_SIGHTLINE || place === STATUS_DEATH;
      if (centred) {
        this.elStatusT.textContent = s.status;
        this.elStatusS.textContent = s.subStatus;
      }
      this.elStatus.dataset.d = place === STATUS_DEATH ? '1' : '0';
      this.elStatus.classList.toggle('dc-hide', !centred);
      this.elScorner.textContent = place === STATUS_CORNER
        ? statusCornerText(s.status, s.subStatus) : '';
      this.elScorner.classList.toggle('on', place === STATUS_CORNER);
    }

    /* --- key hints fade themselves out --------------------------------- */
    if (this.visible && !this.hintFaded) {
      this.liveT += dt;
      if (this.liveT >= HINT_SECONDS) {
        this.hintFaded = true;
        this.elHint.style.opacity = '0';
        this.hintTimer = window.setTimeout(() => { this.elHint.classList.add('dc-hide'); }, 1000);
      }
    }

    /* --- damage: one vignette, two sources ----------------------------- */
    if (s.dead !== this.cDead) {
      this.cDead = s.dead;
      if (s.dead) this.ring.clear();
      /* No trigger, no reticle. Hiding it while dead is honest — you cannot
         shoot — and it is what lets the death card sit in the middle without
         breaking the keep-out: there is no sightline left to keep clear. */
      this.elCross.classList.toggle('dc-hide', s.dead);
    }
    if (this.hurtT > 0) {
      this.hurtT -= dt;
      if (this.hurtT < 0) this.hurtT = 0;
    }
    this.vigT += dt;
    const crit = s.dead ? 0 : critVignette(hp, this.vigT);
    const vig = this.hurtT > crit ? this.hurtT : crit;
    if (Math.abs(vig - this.cVig) > 0.012) {
      this.cVig = vig;
      this.elHurt.style.opacity = vig.toFixed(2);
    }
    this.ring.step(dt);
    this.threatRing.step(dt);
    this.renderDamageRing(s.camYaw);
    this.renderThreatRing(s.camYaw);

    /* --- crosshair ------------------------------------------------------ */
    if (this.hitMarkerT > 0) {
      this.hitMarkerT -= dt;
      if (this.hitMarkerT < 0) this.hitMarkerT = 0;
    }
    const gap = crosshairGapFor(this.crosshairStyle, s.spread);
    /* The ammo state the crosshair carries is the ammo state you can act on:
       EMPTY says "you are pulling a dead trigger", LOW says "decide now". Both
       are answered where the eye already is, so ammo is never hunted for. */
    const aim = s.reloading || !this.weaponUi ? AMMO_TIER_OK : ammoTier(s.mag, magSize);
    const gapQ = Math.round(gap * 2);
    const hmQ = this.hitMarkerT > 0 ? Math.ceil(this.hitMarkerT * 60) : 0;
    const rlQ = s.reloading ? Math.round(Math.max(0, Math.min(1, s.reloadFrac)) * 36) : -1;
    /* The dying bar is driven by the health INTEGER, not by the vignette's
       clock, so it costs a redraw only when the number itself moves. Standing
       still on 9 hp still writes nothing. */
    const critQ = s.dead || hp > HEALTH_CRIT_AT ? -1 : hp;
    if (gapQ !== this.cGapQ || hmQ !== this.cHmQ || rlQ !== this.cRlQ
      || aim !== this.cEmptyQ || this.dmgSig !== this.cDmgSig || critQ !== this.cCritQ) {
      this.cGapQ = gapQ; this.cHmQ = hmQ; this.cRlQ = rlQ; this.cEmptyQ = aim;
      this.cDmgSig = this.dmgSig; this.cCritQ = critQ;
      this.drawCrosshair(gapQ / 2, s, aim);
    }

    /* --- scoreboard ----------------------------------------------------- */
    if (s.boardOpen !== this.cBoardOpen) {
      this.cBoardOpen = s.boardOpen;
      this.elBoard.classList.toggle('dc-hide', !s.boardOpen);
      this.boardTimer = BOARD_REDIFF_MS;
    }
    if (s.boardOpen) {
      this.boardTimer += dt * 1000;
      if (this.boardTimer >= BOARD_REDIFF_MS) {
        this.boardTimer = 0;
        this.drawBoard(s);
      }
    }

    /* --- minimap -------------------------------------------------------- */
    this.mapTimer += dt * 1000;
    if (this.mapTimer >= MAP_REDRAW_MS) {
      this.mapTimer = 0;
      this.drawMinimap(s);
    }
  }

  /**
   * Project every live wedge against the CURRENT camera. This is the whole
   * value of the feature: turn toward the shooter and the blade slides around
   * the frame to the top edge, so "where is it" and "am I facing it yet" are
   * the same read.
   *
   * Two surfaces, one bearing. The blade rides the FRAME, where peripheral
   * vision picks it up without a saccade, and a matching tick rides the
   * crosshair canvas, where the eye already is. Neither ever occupies the
   * mid-field. Writes nothing for a slot whose angle and opacity held still.
   */
  /**
   * Something out there announced itself.
   *
   * `dirYaw` is the WORLD yaw from the player toward it, the same convention
   * `hurt()` takes, and `power` is 0..1 — for an audio cue that is the loudness
   * the ear would have got, so a Baron roaring at 60 m draws a fainter bearing
   * than a Lost Soul shrieking at 8.
   *
   * Whether this is CALLED is `settings.threatCues`' decision, made in
   * `client/src/audio/settings.ts` by `shouldShowThreat`. The HUD does not have
   * an opinion about who can hear; it draws what it is told to draw.
   */
  threat(dirYaw: number, power = 0.6): void {
    // DamageRing.add() maps `amount` to power via 0.28 + amount/65; invert it
    // so a caller working in 0..1 gets the 0..1 it asked for.
    this.threatRing.add(Math.max(0, (power - 0.28) * 65), dirYaw);
  }

  /** Drop every threat bearing — a respawn, a level change, a mode exit. */
  clearThreats(): void { this.threatRing.clear(); }

  /**
   * Threat blades. Frame only, deliberately.
   *
   * Damage gets both the frame blade AND the fovea ticks on the crosshair,
   * because being shot is the thing you must not have to look for. A threat
   * bearing gets the frame and stops there: the crosshair is where you are
   * aiming, and putting a second class of tick on it would trade the clarity of
   * the damage read for information you have a whole screen edge to show.
   */
  private renderThreatRing(camYaw: number): void {
    const ring = this.threatRing;
    for (let i = 0; i < THREAT_SLOTS; i++) {
      const el = this.threatWedges[i];
      const a = ring.alpha(i) * 0.82;
      if (a <= 0.004) {
        if (this.thrAlpha[i] !== 0) { this.thrAlpha[i] = 0; el.style.opacity = '0'; }
        continue;
      }
      const rad = -wrapPi(ring.yaw[i] - camYaw);
      const deg = rad * 180 / Math.PI;
      if (Math.abs(deg - this.thrDeg[i]) > 0.6) {
        this.thrDeg[i] = deg;
        const r = frameRadius(rad, this.halfW, this.halfH, DMG_FRAME_INSET + 6);
        el.style.transform = `rotate(${deg.toFixed(1)}deg) translateY(${(-r).toFixed(0)}px)`;
      }
      if (Math.abs(a - this.thrAlpha[i]) > 0.02) {
        this.thrAlpha[i] = a;
        el.style.opacity = a.toFixed(2);
      }
    }
  }

  private renderDamageRing(camYaw: number): void {
    const ring = this.ring;
    let sig = 0;
    for (let i = 0; i < DMG_SLOTS; i++) {
      const el = this.dmgWedges[i];
      const a = ring.alpha(i);
      if (a <= 0.004) {
        this.foveaA[i] = 0;
        if (this.wedgeAlpha[i] !== 0) {
          this.wedgeAlpha[i] = 0;
          el.style.opacity = '0';
        }
        continue;
      }
      const rad = -wrapPi(ring.yaw[i] - camYaw);
      const deg = rad * 180 / Math.PI;
      const wide = 0.66 + 0.62 * ring.power[i];
      this.foveaRad[i] = rad;
      this.foveaA[i] = a;
      this.foveaW[i] = wide;
      sig = (sig * 131 + Math.round(deg / 2.5) + 512) | 0;
      sig = (sig * 131 + Math.round(a * 14)) | 0;
      if (Math.abs(deg - this.wedgeDeg[i]) > 0.6 || this.wedgeWide[i] !== wide) {
        this.wedgeDeg[i] = deg;
        this.wedgeWide[i] = wide;
        const r = frameRadius(rad, this.halfW, this.halfH, DMG_FRAME_INSET);
        el.style.transform = `rotate(${deg.toFixed(1)}deg) translateY(${(-r).toFixed(0)}px)`
          + ` scaleX(${wide.toFixed(2)})`;
      }
      if (Math.abs(a - this.wedgeAlpha[i]) > 0.02) {
        this.wedgeAlpha[i] = a;
        el.style.opacity = a.toFixed(2);
      }
    }
    this.dmgSig = sig;
  }

  /** Rebuild the table only when a number in it actually changed. */
  private drawBoard(s: HudState): void {
    let sig = '';
    for (let i = 0; i < s.boardCount; i++) {
      sig += `${s.boardName[i]}|${s.boardKills[i]}|${s.boardDeaths[i]}|${s.boardPing[i]};`;
    }
    if (sig === this.boardSig) return;
    this.boardSig = sig;
    let html = '';
    for (let i = 0; i < s.boardCount; i++) {
      html += `<tr class="${s.boardIsLocal[i] === 1 ? 'me' : ''}">`
        + `<td class="n">${escapeHtml(s.boardName[i])}</td>`
        + `<td class="r">${s.boardKills[i]}</td>`
        + `<td class="r">${s.boardDeaths[i]}</td>`
        + `<td class="r">${s.boardPing[i]}</td></tr>`;
    }
    this.elBoardBody.innerHTML = html;
  }

  /**
   * Short arcs on the crosshair canvas, one per live damage bearing.
   *
   * The frame blades tell peripheral vision THAT something hit you; these tell
   * the fovea WHERE from, without moving the eye off the target. Each arc is
   * cased in black first so it survives a bright sand wall as well as a dark
   * corridor, and the whole thing is skipped outright when nothing is alive.
   */
  private drawFoveaDamage(ctx: CanvasRenderingContext2D, c: number, d: number): void {
    const r = FOVEA_RADIUS * d;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 0;
    for (let i = 0; i < DMG_SLOTS; i++) {
      const a = this.foveaA[i];
      if (a <= 0.05) continue;
      // Canvas angles start at +x; the ring's bearings start at "up".
      const mid = this.foveaRad[i] - Math.PI / 2;
      const half = 0.19 + 0.15 * this.foveaW[i];
      const w = (2.0 + 1.8 * this.foveaW[i]) * d;
      ctx.globalAlpha = Math.min(1, a * 0.95);
      ctx.strokeStyle = 'rgba(0,0,0,.62)';
      ctx.lineWidth = w + 2.4 * d;
      ctx.beginPath();
      ctx.arc(c, c, r, mid - half, mid + half);
      ctx.stroke();
      ctx.strokeStyle = '#ff6b32';
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(c, c, r, mid - half, mid + half);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawCrosshair(gap: number, s: HudState, ammo: number): void {
    const ctx = this.crossCtx;
    const size = this.elCross.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const d = this.dpr;
    const c = size / 2;
    const empty = ammo === AMMO_TIER_EMPTY;
    /* Out of ammo is answered AT THE POINT OF GAZE. You never look away from
       the crosshair to find out why the gun stopped. */
    const col = empty ? '#ff4a28' : `#${this.crosshairColor.toString(16).padStart(6, '0')}`;
    /* The last quarter of a magazine warns without changing the crosshair's
       SHAPE — the dot goes amber, so the aiming picture is untouched while the
       eye still gets the message. */
    const dotCol = empty ? '#ff4a28' : ammo === AMMO_TIER_LOW ? '#ffb42a' : col;

    /* Damage arrives here too. These ticks live inside the crosshair canvas
       and only exist while a wedge is alive, so the centre of the frame is
       empty in every steady-state frame and loud in the half-second after a
       hit — the bar shows nothing at all in either case. */
    this.drawFoveaDamage(ctx, c, d);

    /* CASED, not shadowed. A 2 px drop shadow is a grey smear that a sunlit
       sand wall or a bright sky eats outright — which is exactly the terrain
       the bar's own maps are made of — and a crosshair you cannot see is the
       one HUD failure that costs you the fight. Every stroke is laid down
       twice: a hard black keyline first at +2.4 px, then the colour inside it.
       That is a VALUE contrast, so it holds against white sand, black rock and
       orange lava alike, and it costs one extra stroke on a redraw that only
       happens when something actually moved. */
    ctx.lineCap = 'butt';
    ctx.shadowBlur = 0;
    ctx.globalAlpha = empty ? 0.78 : 1;
    const CASE = 'rgba(0,0,0,.82)';

    if (this.crosshairStyle === 'dot') {
      ctx.fillStyle = CASE;
      ctx.beginPath();
      ctx.arc(c, c, 2.9 * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = dotCol;
      ctx.beginPath();
      ctx.arc(c, c, 1.6 * d, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const len = (this.crosshairStyle === 'doom' ? 11 : 8) * d;
      const g = gap * d;
      const w = (this.crosshairStyle === 'doom' ? 2.6 : 2.2) * d;
      ctx.beginPath();
      ctx.moveTo(c, c - g); ctx.lineTo(c, c - g - len);
      ctx.moveTo(c, c + g); ctx.lineTo(c, c + g + len);
      ctx.moveTo(c - g, c); ctx.lineTo(c - g - len, c);
      ctx.moveTo(c + g, c); ctx.lineTo(c + g + len, c);
      ctx.strokeStyle = CASE;
      ctx.lineWidth = w + 2.4 * d;
      ctx.stroke();
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.stroke();
      /* 'cross' has no dot of its own, but a warning dot appearing inside the
         gap is itself the signal, so every style can carry the low read. */
      if (this.crosshairStyle !== 'cross' || dotCol !== col) {
        ctx.fillStyle = CASE;
        ctx.fillRect(c - 2.4 * d, c - 2.4 * d, 4.8 * d, 4.8 * d);
        ctx.fillStyle = dotCol;
        ctx.fillRect(c - 1.2 * d, c - 1.2 * d, 2.4 * d, 2.4 * d);
      }
    }
    ctx.globalAlpha = 1;

    /* --- the dying read, at the point of gaze --------------------------
       Health lives 700 px away in the bottom-left corner, and the critical
       vignette only says "bad", not "6". Under the critical threshold a 30 px
       copy of the health bar appears directly under the reticle, scaled to the
       critical band so it is FULL at 30 and a sliver at 4 — you watch yourself
       die without ever leaving the target. Above the threshold it does not
       exist, so this costs the clean centre nothing in the 90% of frames where
       the player is fine. It is a rectangle, deliberately: the reload sweep
       and the damage bearings are arcs, and two different facts must never
       share a shape. */
    const crit = foveaHealthFrac(this.cHealth, s.dead);
    if (crit > 0) {
      const bw = 30 * d;
      const bh = 4 * d;
      const bx = c - bw / 2;
      const by = c + 26 * d;
      ctx.fillStyle = CASE;
      ctx.fillRect(bx - 1.6 * d, by - 1.6 * d, bw + 3.2 * d, bh + 3.2 * d);
      ctx.fillStyle = 'rgba(60,10,4,.92)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#ff3b18';
      ctx.fillRect(bx, by, Math.max(2 * d, bw * crit), bh);
    }

    /* hit marker — scaled by damage, gold on a headshot, red ring on a kill */
    if (this.hitMarkerT > 0) {
      const span = this.hitMarkerKill ? 0.46 : 0.28;
      const t = Math.min(1, this.hitMarkerT / span);
      const heft = Math.min(1, this.hitMarkerDmg / 60);
      const r = (6 + heft * 4 + (1 - t) * 7) * d;
      const tick = (4 + heft * 3) * d;
      ctx.shadowBlur = 0;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      const hw = (this.hitMarkerKill ? 2.8 : 2) * d;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const sx = i & 1 ? 1 : -1;
        const sy = i & 2 ? 1 : -1;
        ctx.moveTo(c + sx * r, c + sy * r);
        ctx.lineTo(c + sx * (r + tick), c + sy * (r + tick));
      }
      /* A white hit marker over white sand is no hit marker at all, and "did
         that shot land" is the question the whole crosshair exists to answer.
         Cased like the reticle itself. */
      ctx.strokeStyle = CASE;
      ctx.lineWidth = hw + 2.2 * d;
      ctx.stroke();
      ctx.strokeStyle = this.hitMarkerKill ? '#ff3b18' : this.hitMarkerHead ? '#ffd24a' : '#ffffff';
      ctx.lineWidth = hw;
      ctx.stroke();
      if (this.hitMarkerKill) {
        ctx.globalAlpha = Math.min(1, t) * 0.65;
        ctx.lineWidth = 1.6 * d;
        ctx.beginPath();
        ctx.arc(c, c, (10 + (1 - t) * 16) * d, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /* reload ring — cased, for the same reason the reticle is */
    if (s.reloading) {
      ctx.shadowBlur = 0;
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI * 2 * Math.min(1, Math.max(0, s.reloadFrac));
      ctx.beginPath();
      ctx.arc(c, c, 20 * d, a0, a1);
      ctx.strokeStyle = CASE;
      ctx.lineWidth = 4.7 * d;
      ctx.stroke();
      ctx.strokeStyle = '#f0a020';
      ctx.lineWidth = 2.5 * d;
      ctx.stroke();
    }
  }

  private drawMinimap(s: HudState): void {
    const ctx = this.mapCtx;
    const size = this.elMapCanvas.width;
    const half = size / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c0b0e';
    ctx.fillRect(0, 0, size, size);

    const scale = size / MAP_VIEW_BLOCKS;
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(half, half);
    // North-up map, player arrow rotates. Simpler to read than a spinning map.
    ctx.imageSmoothingEnabled = false;
    const px = s.camX - WORLD_MIN_BLOCK_X;
    const pz = s.camZ - WORLD_MIN_BLOCK_Z;
    ctx.drawImage(
      this.mapImage,
      px - MAP_VIEW_BLOCKS / 2, pz - MAP_VIEW_BLOCKS / 2, MAP_VIEW_BLOCKS, MAP_VIEW_BLOCKS,
      -half, -half, size, size,
    );

    /* blips */
    for (let i = 0; i < s.blipCount; i++) {
      const bx = (s.blipX[i] - s.camX) * scale;
      const bz = (s.blipZ[i] - s.camZ) * scale;
      if (bx * bx + bz * bz > half * half) continue;
      const kind = s.blipKind[i];
      ctx.fillStyle = kind === BLIP_ENEMY ? '#ff4a22' : kind === BLIP_PLAYER ? '#63d0ff' : '#f0d060';
      const r = kind === BLIP_PICKUP ? 1.8 : 2.8;
      ctx.beginPath();
      ctx.arc(bx, bz, r * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    /* player arrow */
    ctx.rotate(-s.camYaw);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.lineWidth = 1 * this.dpr;
    const a = 6 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.72, a * 0.8);
    ctx.lineTo(0, a * 0.35);
    ctx.lineTo(-a * 0.72, a * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    /* frame */
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.lineWidth = 1 * this.dpr;
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.stroke();
    this.mapImageDirty = false;
  }

  /* -------------------------------------------------------------------- *
   * Layout
   * -------------------------------------------------------------------- */

  private readonly onResize = (): void => { this.layout(); };

  layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    /* The damage blades are placed against the frame, so a resize has to move
       them; forcing the angle cache stale is what re-seats them next frame. */
    this.halfW = w / 2;
    this.halfH = h / 2;
    this.wedgeDeg.fill(9999);
    this.thrDeg.fill(9999);
    /* The keep-out is published as a custom property, not kept private, so a
       mode overlay that wants to celebrate a kill can anchor to the same
       radius instead of guessing a pixel offset and landing on the reticle. */
    const keep = Math.round(keepOutRadius(w, h));
    if (keep !== this.cKeepOut) {
      this.cKeepOut = keep;
      this.root.style.setProperty('--dc-keepout', `${keep}px`);
      this.root.style.setProperty('--dc-drop', `${Math.round(statusDrop(w, h))}px`);
    }
    const compact = h < 560 || w < 760;
    const portrait = h > w;
    if (compact !== this.compact) {
      this.compact = compact;
      this.root.dataset.compact = compact ? '1' : '0';
    }
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      this.root.dataset.portrait = portrait ? '1' : '0';
    }

    const mapCss = compact ? 104 : 168;
    const mapPx = Math.round(mapCss * this.dpr);
    if (this.elMapCanvas.width !== mapPx) {
      this.elMapCanvas.width = mapPx;
      this.elMapCanvas.height = mapPx;
      const c = this.elMapCanvas.getContext('2d', { alpha: false });
      if (c !== null) this.mapCtx = c;
    }

    const crossCss = 96;
    const crossPx = Math.round(crossCss * this.dpr);
    if (this.elCross.width !== crossPx) {
      this.elCross.width = crossPx;
      this.elCross.height = crossPx;
      this.elCross.style.width = `${crossCss}px`;
      this.elCross.style.height = `${crossCss}px`;
    }
    this.cGapQ = -1;
    this.mapTimer = MAP_REDRAW_MS;
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    if (this.hintTimer !== 0) { window.clearTimeout(this.hintTimer); this.hintTimer = 0; }
    this.root.textContent = '';
  }
}

/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

function div(cls: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function btn(cls: string, label: string): HTMLElement {
  const b = document.createElement('div');
  b.className = cls;
  b.textContent = label;
  return b;
}

/**
 * A chip carries both its full label and a short one. Which shows is pure CSS,
 * so a viewport change costs no DOM write — and a 412 px phone gets three
 * chips on ONE row instead of a three-deep column down the left edge.
 */
function chip(host: HTMLElement, label: string, shortLabel: string, value: string): HTMLElement {
  const c = div('dc-chip');
  const i = document.createElement('i');
  i.textContent = label;
  const b = document.createElement('b');
  b.textContent = shortLabel;
  const v = document.createElement('span');
  v.textContent = value;
  c.append(i, b, v);
  host.appendChild(c);
  return v;
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ));
}

export function wrapPi(a: number): number {
  const TAU = Math.PI * 2;
  let v = a % TAU;
  if (v > Math.PI) v -= TAU;
  else if (v < -Math.PI) v += TAU;
  return v;
}

/** Magazine capacity for a weapon, for the HUD's `mag / size` display. */
export function magSizeOf(weaponId: number): number {
  return WEAPON_MAG_SIZE[weaponId] ?? 0;
}
