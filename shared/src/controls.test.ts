/**
 * DOOMCRAFT — control-scheme tests.
 *
 * The owner played the live build and reported: "the navigation on the keyboard
 * is off, should be like the classic games". This file pins the half of the fix
 * that is pure data — the two scheme tables, DOOM's three turn rates, and the
 * rule that decides what happens to a hand-rebound key when the scheme changes.
 *
 * Every DOOM number below is checked against id Software's released source
 * (`linuxdoom-1.10`), not against memory:
 *
 *   g_game.c  fixed_t angleturn[3] = {640, 1280, 320};   #define SLOWTURNTICS 6
 *   p_user.c  player->mo->angle += (cmd->angleturn<<16);
 *   m_misc.c  key_right/left = arrows, key_strafeleft ',', key_straferight '.',
 *             key_fire RCTRL, key_use ' ', key_strafe RALT, key_speed RSHIFT
 */
import { describe, it, expect } from 'vitest';
import { InputAction, DEFAULT_KEYBINDS } from './constants.ts';
import {
  CONTROL_SCHEMES, SCHEME_ALT_BINDINGS, SCHEME_LABELS, SCHEME_NOTES,
  TURN_RATE_SLOW, TURN_RATE_WALK, TURN_RATE_RUN, TURN_ACCEL_SECONDS,
  DOOM_TICRATE, DOOM_SLOWTURNTICS, angleturnToRadPerSec,
  keyboardTurnRate, resolveBindings, blankBindings,
  asControlScheme, sanitiseCustomBindings,
} from './controls.ts';

const DEG = 180 / Math.PI;

/* ------------------------------------------------------------------------ *
 * DOOM's turning, to the digit
 * ------------------------------------------------------------------------ */

describe('keyboard turn rates are DOOM\'s own angleturn table', () => {
  it('converts one angleturn unit through the BAM the engine actually used', () => {
    // cmd->angleturn << 16 into a 32-bit angle: one unit is 1/65536 of a turn,
    // applied once per tic at 35 Hz.
    expect(angleturnToRadPerSec(65536)).toBeCloseTo(2 * Math.PI * DOOM_TICRATE, 10);
  });

  it('walk turn is 123.05 deg/s — angleturn[0] = 640 at 35 tics', () => {
    expect(TURN_RATE_WALK * DEG).toBeCloseTo(123.046875, 6);
  });

  it('run turn is exactly double the walk turn — angleturn[1] = 1280', () => {
    expect(TURN_RATE_RUN * DEG).toBeCloseTo(246.09375, 6);
    expect(TURN_RATE_RUN).toBeCloseTo(TURN_RATE_WALK * 2, 12);
  });

  it('slow turn is exactly half the walk turn — angleturn[2] = 320', () => {
    expect(TURN_RATE_SLOW * DEG).toBeCloseTo(61.5234375, 6);
    expect(TURN_RATE_SLOW).toBeCloseTo(TURN_RATE_WALK / 2, 12);
  });

  it('is fast, not gentle: a half turn takes well under a second at a run', () => {
    expect(Math.PI / TURN_RATE_RUN).toBeLessThan(0.8);
  });
});

describe('two-stage accelerative turning', () => {
  it('starts slow — a tap turn must not fling the view', () => {
    expect(keyboardTurnRate(0, false)).toBe(TURN_RATE_SLOW);
    expect(keyboardTurnRate(0, true)).toBe(TURN_RATE_SLOW);
  });

  it('steps up at DOOM\'s boundary and does not ramp through it', () => {
    // The step is a step. DOOM interpolates nothing, and a smoothed ramp reads
    // as input lag on a game whose whole feel is 2x Minecraft.
    const justBefore = keyboardTurnRate(TURN_ACCEL_SECONDS - 1e-6, false);
    const justAfter = keyboardTurnRate(TURN_ACCEL_SECONDS + 1e-6, false);
    expect(justBefore).toBe(TURN_RATE_SLOW);
    expect(justAfter).toBe(TURN_RATE_WALK);
  });

  it('holds the slow stage for five tics, not six', () => {
    // `turnheld` is bumped BEFORE the `turnheld < SLOWTURNTICS` compare, so tic
    // 6 is already at full rate. Off by one tic here is the difference between
    // snappy and sticky.
    expect(TURN_ACCEL_SECONDS).toBeCloseTo((DOOM_SLOWTURNTICS - 1) / DOOM_TICRATE, 12);
    expect(TURN_ACCEL_SECONDS).toBeCloseTo(0.142857, 5);
  });

  it('run speeds the TURN as well as the legs, once past the slow stage', () => {
    expect(keyboardTurnRate(1, true)).toBe(TURN_RATE_RUN);
    expect(keyboardTurnRate(1, false)).toBe(TURN_RATE_WALK);
  });
});

/* ------------------------------------------------------------------------ *
 * The two schemes
 * ------------------------------------------------------------------------ */

describe('the scheme tables', () => {
  it('offers exactly the two schemes, both named and both explained', () => {
    expect([...CONTROL_SCHEMES]).toEqual(['modern', 'classic']);
    for (const s of CONTROL_SCHEMES) {
      expect(SCHEME_LABELS[s].length).toBeGreaterThan(0);
      expect(SCHEME_NOTES[s].length).toBeGreaterThan(0);
    }
  });

  it('Modern: arrows move, and Left/Right STRAFE', () => {
    const m = SCHEME_ALT_BINDINGS.modern;
    expect(m[InputAction.MoveForward]).toBe('ArrowUp');
    expect(m[InputAction.MoveBack]).toBe('ArrowDown');
    expect(m[InputAction.MoveLeft]).toBe('ArrowLeft');
    expect(m[InputAction.MoveRight]).toBe('ArrowRight');
    // Nothing keyboard-turns in Modern; the mouse does that.
    expect(m[InputAction.TurnLeft]).toBeUndefined();
    expect(m[InputAction.TurnRight]).toBeUndefined();
  });

  it('Classic: DOOM\'s m_misc.c defaults, row for row', () => {
    const c = SCHEME_ALT_BINDINGS.classic;
    expect(c[InputAction.MoveForward]).toBe('ArrowUp');        // key_up
    expect(c[InputAction.MoveBack]).toBe('ArrowDown');         // key_down
    expect(c[InputAction.TurnLeft]).toBe('ArrowLeft');         // key_left  — TURN
    expect(c[InputAction.TurnRight]).toBe('ArrowRight');       // key_right — TURN
    expect(c[InputAction.MoveLeft]).toBe('Comma');             // key_strafeleft ','
    expect(c[InputAction.MoveRight]).toBe('Period');           // key_straferight '.'
    expect(c[InputAction.StrafeMod]).toBe('AltLeft');          // key_strafe RALT
    expect(c[InputAction.Fire]).toBe('ControlLeft');           // key_fire RCTRL
    expect(c[InputAction.Use]).toBe('Space');                  // key_use ' '
    expect(c[InputAction.Sprint]).toBe('ShiftRight');          // key_speed RSHIFT
    // The arrows must not ALSO strafe, or Classic is just Modern with extras.
    expect(c[InputAction.MoveLeft]).not.toBe('ArrowLeft');
    expect(c[InputAction.MoveRight]).not.toBe('ArrowRight');
  });

  it('changes only genuinely conflicting rows — the schemes agree elsewhere', () => {
    const m = SCHEME_ALT_BINDINGS.modern;
    const c = SCHEME_ALT_BINDINGS.classic;
    const differing = (Object.values(InputAction) as InputAction[])
      .filter((a) => (m[a] ?? '') !== (c[a] ?? ''));
    expect(differing.sort()).toEqual([
      InputAction.Fire, InputAction.MoveLeft, InputAction.MoveRight,
      InputAction.StrafeMod, InputAction.TurnLeft, InputAction.TurnRight,
      InputAction.Use,
    ].sort());
    // Forward/back and run are the same key under both — nobody relearns those.
    expect(m[InputAction.MoveForward]).toBe(c[InputAction.MoveForward]);
    expect(m[InputAction.MoveBack]).toBe(c[InputAction.MoveBack]);
    expect(m[InputAction.Sprint]).toBe(c[InputAction.Sprint]);
  });

  it('never gives one code two actions inside a layer', () => {
    for (const scheme of CONTROL_SCHEMES) {
      const seen = new Map<string, InputAction>();
      const table = SCHEME_ALT_BINDINGS[scheme];
      for (const action of Object.keys(table) as InputAction[]) {
        const code = table[action] ?? '';
        if (code === '') continue;
        expect(seen.has(code), `${scheme}: ${code} bound twice`).toBe(false);
        seen.set(code, action);
      }
    }
  });

  it('leaves the arrows dead in the shipped defaults — the reported bug', () => {
    // This is the assertion that would have failed before the fix: nothing in
    // DEFAULT_KEYBINDS is an arrow, which is why pressing one did nothing.
    const primaries = Object.values(DEFAULT_KEYBINDS);
    expect(primaries.some((c) => c.startsWith('Arrow'))).toBe(false);
    // ...and the assertion that says the arrows are alive now, under BOTH.
    for (const scheme of CONTROL_SCHEMES) {
      const codes = Object.values(SCHEME_ALT_BINDINGS[scheme]);
      for (const arrow of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
        expect(codes, `${scheme} leaves ${arrow} dead`).toContain(arrow);
      }
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Both schemes live at once
 * ------------------------------------------------------------------------ */

describe('resolveBindings — the two layers', () => {
  it('keeps WASD and the mouse identical under both schemes', () => {
    const modern = resolveBindings('modern');
    const classic = resolveBindings('classic');
    expect(classic.primary).toEqual(modern.primary);
    expect(classic.primary[InputAction.MoveForward]).toBe('KeyW');
    expect(classic.primary[InputAction.MoveLeft]).toBe('KeyA');
    expect(classic.primary[InputAction.Fire]).toBe('Mouse0');
  });

  it('lets one code sit on both layers — Space jumps AND opens a door', () => {
    const { primary, alt } = resolveBindings('classic');
    expect(primary[InputAction.Jump]).toBe('Space');
    expect(alt[InputAction.Use]).toBe('Space');
    // DOOM has no jump, so nothing was taken away to make room for `use`.
  });

  it('blankBindings covers every action this build has', () => {
    const blank = blankBindings();
    for (const a of Object.values(InputAction)) expect(blank[a]).toBe('');
  });
});

/* ------------------------------------------------------------------------ *
 * THE DOCUMENTED RULE: a rebind pins its row
 * ------------------------------------------------------------------------ */

describe('a hand-rebound row survives a scheme switch', () => {
  it('keeps a custom primary key through every switch', () => {
    const custom = { primary: { [InputAction.Fire]: 'KeyF' }, alt: {} };
    for (const scheme of CONTROL_SCHEMES) {
      const r = resolveBindings(scheme, custom);
      expect(r.primary[InputAction.Fire]).toBe('KeyF');
    }
  });

  it('keeps a custom ALT key even where the scheme wants that row', () => {
    // Turn left is the row Classic cares most about. Pin it to Q and Classic
    // must not drag it back onto ArrowLeft.
    const custom = { alt: { [InputAction.TurnLeft]: 'KeyQ' } };
    const classic = resolveBindings('classic', custom);
    expect(classic.alt[InputAction.TurnLeft]).toBe('KeyQ');
    expect(classic.alt[InputAction.TurnRight]).toBe('ArrowRight');   // untouched row follows the scheme
    // Switching to Modern and back leaves the pin exactly where it was.
    expect(resolveBindings('modern', custom).alt[InputAction.TurnLeft]).toBe('KeyQ');
    expect(resolveBindings('classic', custom).alt[InputAction.TurnLeft]).toBe('KeyQ');
  });

  it('rewrites only the rows you never touched', () => {
    const custom = { alt: { [InputAction.Fire]: 'KeyG' } };
    const modern = resolveBindings('modern', custom);
    const classic = resolveBindings('classic', custom);
    expect(modern.alt[InputAction.Fire]).toBe('KeyG');
    expect(classic.alt[InputAction.Fire]).toBe('KeyG');          // pinned: Ctrl does NOT take it
    expect(modern.alt[InputAction.MoveLeft]).toBe('ArrowLeft');  // unpinned: follows the scheme
    expect(classic.alt[InputAction.TurnLeft]).toBe('ArrowLeft');
  });

  it('the pin wins the collision — the scheme\'s row is the one that loses', () => {
    // Ask for ArrowLeft on `use`, in Classic, where the scheme wants it for turn.
    const custom = { alt: { [InputAction.Use]: 'ArrowLeft' } };
    const r = resolveBindings('classic', custom);
    expect(r.alt[InputAction.Use]).toBe('ArrowLeft');
    expect(r.alt[InputAction.TurnLeft]).toBe('');
    // Still one code, one action, within the layer.
    const codes = Object.values(r.alt).filter((c) => c !== '');
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('a pinned empty string is a real unbinding, not a missing entry', () => {
    const r = resolveBindings('classic', { alt: { [InputAction.Fire]: '' } });
    expect(r.alt[InputAction.Fire]).toBe('');
  });

  it('dropping the pins hands the whole table back to the scheme', () => {
    const pinned = resolveBindings('classic', { alt: { [InputAction.TurnLeft]: 'KeyQ' } });
    const reset = resolveBindings('classic');
    expect(pinned.alt[InputAction.TurnLeft]).toBe('KeyQ');
    expect(reset.alt[InputAction.TurnLeft]).toBe('ArrowLeft');
  });

  it('does not mutate the frozen scheme tables while resolving', () => {
    resolveBindings('classic', { alt: { [InputAction.TurnLeft]: 'KeyQ' } });
    expect(SCHEME_ALT_BINDINGS.classic[InputAction.TurnLeft]).toBe('ArrowLeft');
  });
});

/* ------------------------------------------------------------------------ *
 * Untrusted input — settings and keymaps both come out of localStorage
 * ------------------------------------------------------------------------ */

describe('gates on stored values', () => {
  it('falls back to Modern for anything that is not the word classic', () => {
    expect(asControlScheme('classic')).toBe('classic');
    expect(asControlScheme('modern')).toBe('modern');
    for (const junk of [undefined, null, 0, {}, 'CLASSIC', 'doom', []]) {
      expect(asControlScheme(junk)).toBe('modern');
    }
  });

  it('drops unknown actions and over-long codes from a stored keymap', () => {
    const c = sanitiseCustomBindings({
      primary: { [InputAction.Fire]: 'KeyF', notAnAction: 'KeyZ', [InputAction.Jump]: 'x'.repeat(64) },
      alt: { [InputAction.TurnLeft]: 'KeyQ' },
    });
    expect(c.primary?.[InputAction.Fire]).toBe('KeyF');
    expect((c.primary as Record<string, string>).notAnAction).toBeUndefined();
    expect(c.primary?.[InputAction.Jump]).toBeUndefined();
    expect(c.alt?.[InputAction.TurnLeft]).toBe('KeyQ');
  });

  it('survives junk where the blob should be', () => {
    for (const junk of [null, undefined, 7, 'nope', []]) {
      const c = sanitiseCustomBindings(junk);
      expect(c.primary).toEqual({});
      expect(c.alt).toEqual({});
    }
  });
});
