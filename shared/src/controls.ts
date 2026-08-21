/**
 * DOOMCRAFT — control schemes, and DOOM's keyboard turning.
 *
 * The owner's report was "the navigation on the keyboard is off, should be like
 * the classic games". Two separate faults sat behind that sentence:
 *
 *   1. the arrow keys were bound to NOTHING. `DEFAULT_KEYBINDS` covered WASD and
 *      stopped, so a player who reached for the arrows got silence.
 *   2. there was no way to ask for the classic layout at all — arrows that TURN
 *      rather than strafe, which is the half of DOOM modern players forget.
 *
 * ---------------------------------------------------------------------------
 * TWO LAYERS, NOT TWO KEYMAPS
 * ---------------------------------------------------------------------------
 * Bindings are resolved as two independent layers:
 *
 *   PRIMARY  `DEFAULT_KEYBINDS` — WASD, the mouse, R/E/V/B, the number row.
 *            IDENTICAL under both schemes. A Classic player never loses WASD or
 *            mouselook; a Modern player never loses anything either.
 *   ALT      `SCHEME_ALT_BINDINGS[scheme]` — the ONLY thing a preset changes.
 *
 * A code is exclusive WITHIN a layer, not across them. That is what lets Space
 * stay Jump on the primary layer while Classic hangs DOOM's `use` on the same
 * key: press Space in Classic and you jump AND open the door. DOOM has no jump,
 * so nothing is taken away, and opening a door mid-hop harms nobody.
 *
 * ---------------------------------------------------------------------------
 * WHAT DOOM ACTUALLY DID
 * ---------------------------------------------------------------------------
 * Not from memory — from id Software's released source, `linuxdoom-1.10`:
 *
 *   m_misc.c defaults:  key_right = KEY_RIGHTARROW   key_left  = KEY_LEFTARROW
 *                       key_up    = KEY_UPARROW      key_down  = KEY_DOWNARROW
 *                       key_strafeleft = ','         key_straferight = '.'
 *                       key_fire  = KEY_RCTRL        key_use   = ' '
 *                       key_strafe = KEY_RALT        key_speed = KEY_RSHIFT
 *
 *   g_game.c:           fixed_t angleturn[3] = {640, 1280, 320};  // + slow turn
 *                       #define SLOWTURNTICS 6
 *                       if (gamekeydown[key_right]) cmd->angleturn -= angleturn[tspeed];
 *                       if (strafe) { side += sidemove[speed]; }   // RALT held
 *   p_user.c:           player->mo->angle += (cmd->angleturn<<16);
 *
 * `angleturn << 16` is a BAM (2^32 == one full turn) applied once per tic at 35
 * tics/second, which is where every number below comes from. Nothing here is
 * "about right" — the three rates are DOOM's three rates.
 */

import { InputAction, DEFAULT_KEYBINDS, type ControlScheme } from './constants.ts';
import { TAU } from './math.ts';

/* ------------------------------------------------------------------------ *
 * DOOM's turning, verbatim
 * ------------------------------------------------------------------------ */

/** DOOM's fixed simulation rate. Every angleturn below is per tic at this rate. */
export const DOOM_TICRATE = 35;
/** `angleturn[3] = {640, 1280, 320}` — walk, run, slow. Units of BAM >> 16. */
export const DOOM_ANGLETURN_WALK = 640;
export const DOOM_ANGLETURN_RUN = 1280;
export const DOOM_ANGLETURN_SLOW = 320;
/** `#define SLOWTURNTICS 6`. */
export const DOOM_SLOWTURNTICS = 6;

/** One `angleturn` entry as radians per second at DOOM's tic rate. */
export function angleturnToRadPerSec(angleturn: number): number {
  // cmd->angleturn << 16 lands in a 32-bit angle, so one unit is 2^16 / 2^32
  // of a full turn == 1/65536.
  return (angleturn / 65536) * TAU * DOOM_TICRATE;
}

/** 61.5 deg/s — the first fifth of a second of any keyboard turn. */
export const TURN_RATE_SLOW = angleturnToRadPerSec(DOOM_ANGLETURN_SLOW);
/** 123.0 deg/s — a sustained walking turn. */
export const TURN_RATE_WALK = angleturnToRadPerSec(DOOM_ANGLETURN_WALK);
/** 246.1 deg/s — a sustained turn with run held. DOOM's Shift speeds the TURN too. */
export const TURN_RATE_RUN = angleturnToRadPerSec(DOOM_ANGLETURN_RUN);

/**
 * How long the slow stage lasts.
 *
 * `turnheld` is incremented BEFORE the `turnheld < SLOWTURNTICS` compare, so
 * tics 1..5 turn slowly and tic 6 is already at full rate. The real duration is
 * therefore FIVE tics, not six — 142.9 ms. Getting this off by one tic is the
 * difference between "snappy" and "sticky" on a tap-turn.
 */
export const TURN_ACCEL_SECONDS = (DOOM_SLOWTURNTICS - 1) / DOOM_TICRATE;

/**
 * Radians/second of keyboard turn, given how long the key has been held and
 * whether run is on. Two stages with a hard step between them — DOOM ramps
 * nothing, and a smoothed ramp reads as input lag.
 */
export function keyboardTurnRate(heldSeconds: number, running: boolean): number {
  if (heldSeconds < TURN_ACCEL_SECONDS) return TURN_RATE_SLOW;
  return running ? TURN_RATE_RUN : TURN_RATE_WALK;
}

/* ------------------------------------------------------------------------ *
 * The schemes
 * ------------------------------------------------------------------------ */

export const CONTROL_SCHEMES: readonly ControlScheme[] = Object.freeze(['modern', 'classic']);

export const SCHEME_LABELS: Readonly<Record<ControlScheme, string>> = Object.freeze({
  modern: 'Modern (WASD + mouselook)',
  classic: 'Classic (Doom)',
});

/** One line of prose per scheme, for the settings panel. */
export const SCHEME_NOTES: Readonly<Record<ControlScheme, string>> = Object.freeze({
  modern: 'Arrows move. Mouse turns.',
  classic: 'Arrows turn · , . strafe · Alt+arrows strafe · Ctrl fires · Space uses.',
});

export type BindingLayer = 'primary' | 'alt';
export type PartialBindings = Readonly<Partial<Record<InputAction, string>>>;

/**
 * The second layer, per scheme. This table IS the preset — nothing else about a
 * scheme exists, which is why switching one cannot strand a player with half a
 * keyboard.
 *
 * Modern and Classic agree on Up/Down (move) and on Shift (run). They disagree
 * on exactly one pair of keys, Left and Right, plus the four rows Classic adds
 * that Modern leaves unbound.
 */
export const SCHEME_ALT_BINDINGS: Readonly<Record<ControlScheme, PartialBindings>> = Object.freeze({
  modern: Object.freeze({
    [InputAction.MoveForward]: 'ArrowUp',
    [InputAction.MoveBack]: 'ArrowDown',
    // The disagreement: arrows STRAFE here...
    [InputAction.MoveLeft]: 'ArrowLeft',
    [InputAction.MoveRight]: 'ArrowRight',
    [InputAction.Sprint]: 'ShiftRight',
  }),
  classic: Object.freeze({
    [InputAction.MoveForward]: 'ArrowUp',
    [InputAction.MoveBack]: 'ArrowDown',
    // ...and TURN here. This one pair is the whole of "should be like the
    // classic games" — DOOM's key_left / key_right are turn keys.
    [InputAction.TurnLeft]: 'ArrowLeft',
    [InputAction.TurnRight]: 'ArrowRight',
    // key_strafeleft ',' / key_straferight '.'
    [InputAction.MoveLeft]: 'Comma',
    [InputAction.MoveRight]: 'Period',
    // key_strafe RALT — held, the turn keys strafe instead. Left Alt too: a
    // browser gives us AltLeft/AltRight as distinct codes and reaching for the
    // far Alt on a laptop is not a thing anyone does.
    [InputAction.StrafeMod]: 'AltLeft',
    // key_fire RCTRL, key_use ' ', key_speed RSHIFT.
    [InputAction.Fire]: 'ControlLeft',
    [InputAction.Use]: 'Space',
    [InputAction.Sprint]: 'ShiftRight',
  }),
});

/* ------------------------------------------------------------------------ *
 * Resolving a scheme against the player's own rebinds
 * ------------------------------------------------------------------------ */

/**
 * The rebinds a player made by hand. Sparse on purpose: only the rows they
 * actually touched are in here, which is what makes the rule below possible.
 */
export interface CustomBindings {
  primary?: PartialBindings;
  alt?: PartialBindings;
}

export interface ResolvedBindings {
  primary: Record<InputAction, string>;
  alt: Record<InputAction, string>;
}

/**
 * THE DOCUMENTED RULE, and the one the tests pin:
 *
 *   **A rebind pins its row. Switching schemes rewrites only the rows you never
 *   touched.**
 *
 * So if you move Fire to `KeyF`, Fire stays on `KeyF` through every future
 * scheme switch — Classic will not drag it back onto Ctrl. Everything you did
 * NOT rebind follows the scheme as normal. "Reset controls" drops the pins and
 * hands the scheme back its whole table.
 *
 * Exclusivity is per layer and the pin wins: if your custom code collides with
 * a scheme code in the same layer, the scheme's row is the one that loses its
 * key, never yours.
 */
export function resolveBindings(scheme: ControlScheme, custom: CustomBindings = {}): ResolvedBindings {
  const primary = { ...DEFAULT_KEYBINDS } as Record<InputAction, string>;
  const alt = blankBindings();
  const schemeAlt = SCHEME_ALT_BINDINGS[scheme] ?? SCHEME_ALT_BINDINGS.modern;
  for (const action of Object.keys(schemeAlt) as InputAction[]) {
    alt[action] = schemeAlt[action] ?? '';
  }
  overlay(primary, custom.primary);
  overlay(alt, custom.alt);
  return { primary, alt };
}

/** Every action mapped to `''`. */
export function blankBindings(): Record<InputAction, string> {
  const out = {} as Record<InputAction, string>;
  for (const action of Object.values(InputAction)) out[action] = '';
  return out;
}

/**
 * Write the pinned rows over a resolved layer, stealing each code from whoever
 * the scheme had given it to. Applied last, so the pin always wins.
 */
function overlay(layer: Record<InputAction, string>, pins: PartialBindings | undefined): void {
  if (pins === undefined) return;
  for (const key of Object.keys(pins) as InputAction[]) {
    const code = pins[key];
    if (typeof code !== 'string') continue;
    if (!(key in layer)) continue;          // an action this build no longer has
    if (code !== '') {
      for (const other of Object.keys(layer) as InputAction[]) {
        if (other !== key && layer[other] === code) layer[other] = '';
      }
    }
    layer[key] = code;
  }
}

/**
 * Which scheme a stored settings value names, defaulting to Modern. Settings
 * come out of localStorage, which is user-writable, so this is a gate and not a
 * cast.
 */
export function asControlScheme(raw: unknown): ControlScheme {
  return raw === 'classic' ? 'classic' : 'modern';
}

/**
 * Narrow an untrusted `{primary,alt}` blob from localStorage down to rows this
 * build recognises, with codes short enough to be a key name.
 */
export function sanitiseCustomBindings(raw: unknown): CustomBindings {
  const rec = (raw !== null && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  return { primary: sanitiseLayer(rec.primary), alt: sanitiseLayer(rec.alt) };
}

function sanitiseLayer(raw: unknown): PartialBindings {
  const out: Partial<Record<InputAction, string>> = {};
  if (raw === null || typeof raw !== 'object') return out;
  const rec = raw as Record<string, unknown>;
  const known = new Set<string>(Object.values(InputAction));
  for (const key of Object.keys(rec)) {
    if (!known.has(key)) continue;
    const v = rec[key];
    if (typeof v === 'string' && v.length <= 24) out[key as InputAction] = v;
  }
  return out;
}
