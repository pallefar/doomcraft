/**
 * DOOMCRAFT — keyboard tests, driven through the real listeners.
 *
 * The owner's report was "the navigation on the keyboard is off, should be like
 * the classic games". Testing the binding TABLES is not enough to answer that:
 * the tables were never the part that was broken at runtime. So these tests
 * attach a real `InputManager` to a stand-in window and dispatch real keydown /
 * keyup / mousedown / wheel events at it, then read the same getters
 * `game.ts` reads. Nothing reaches into the class to poke private state.
 *
 * The stand-in window exists because vitest runs in `node` here (see
 * vitest.config.ts) and `InputManager` only ever asks a listener target for
 * `addEventListener` / `removeEventListener`. Faking three methods is a truer
 * test than faking the manager.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { InputAction } from '@shared/constants';
import {
  TURN_RATE_SLOW, TURN_RATE_WALK, TURN_RATE_RUN, TURN_ACCEL_SECONDS,
  type CustomBindings,
} from '@shared/controls';
import { InputManager, bindingLabel, ACTIONS } from './input';

/* ------------------------------------------------------------------------ *
 * A window that is only what InputManager asks a window to be
 * ------------------------------------------------------------------------ */

interface FakeEvent {
  type: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
  [k: string]: unknown;
}

class FakeTarget {
  private readonly handlers = new Map<string, Array<(e: FakeEvent) => void>>();

  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    const list = this.handlers.get(type);
    if (list === undefined) this.handlers.set(type, [fn]);
    else list.push(fn);
  }

  removeEventListener(type: string, fn: (e: FakeEvent) => void): void {
    const list = this.handlers.get(type);
    if (list === undefined) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** Returns the event, so a test can assert on `defaultPrevented`. */
  dispatch(type: string, fields: Record<string, unknown> = {}): FakeEvent {
    const e: FakeEvent = {
      ...fields,
      type,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault(): void { e.defaultPrevented = true; },
      stopPropagation(): void { e.propagationStopped = true; },
      stopImmediatePropagation(): void { e.propagationStopped = true; },
    };
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(e);
    return e;
  }

  get listenerCount(): number {
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }
}

const DT = 1 / 60;

interface Rig {
  input: InputManager;
  win: FakeTarget;
  /** Press or release a key by KeyboardEvent.code. */
  key(code: string, down?: boolean): FakeEvent;
  mouse(button: number, down?: boolean): FakeEvent;
  wheel(deltaY: number): FakeEvent;
  /** One fixed step, exactly as `Game.fixedStep` runs it. Returns yaw radians. */
  step(dt?: number): number;
  /** Hold `code` for `steps` frames, summing the yaw the camera would receive. */
  hold(code: string, steps: number, dt?: number): number;
  done(): void;
}

let live: Rig | null = null;

function rig(scheme: 'modern' | 'classic' = 'modern', custom?: CustomBindings): Rig {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = doc;

  const input = new InputManager({ controlScheme: scheme, customBindings: custom });
  input.attach(null);
  input.enabled = true;

  const r: Rig = {
    input, win,
    key: (code, down = true) => win.dispatch(down ? 'keydown' : 'keyup', { code, repeat: false }),
    mouse: (button, down = true) => win.dispatch(down ? 'mousedown' : 'mouseup', { button }),
    wheel: (deltaY) => win.dispatch('wheel', { deltaY }),
    step(dt = DT) {
      // The shipped order, one frame boundary at a time: close the previous
      // frame's edges and pulses, poll, take the keyboard turn. The caller then
      // reads the axes exactly where `Game.fixedStep` reads them.
      input.endFrame();
      input.update();
      return input.turnDelta(dt);
    },
    hold(code, steps, dt = DT) {
      this.key(code, true);
      let yaw = 0;
      for (let i = 0; i < steps; i++) yaw += this.step(dt);
      this.key(code, false);
      return yaw;
    },
    done() {
      input.detach();
      delete g.window;
      delete g.document;
    },
  };
  live = r;
  return r;
}

afterEach(() => { live?.done(); live = null; });

/* ------------------------------------------------------------------------ *
 * 1. The arrows do something at all
 * ------------------------------------------------------------------------ */

describe('the arrow keys are bound', () => {
  it('MODERN: the arrows move — up/down forward-back, left/right STRAFE', () => {
    const r = rig('modern');
    r.key('ArrowUp'); r.step();
    expect(r.input.moveZ).toBe(1);
    r.key('ArrowUp', false); r.key('ArrowDown'); r.step();
    expect(r.input.moveZ).toBe(-1);
    r.key('ArrowDown', false); r.key('ArrowLeft'); r.step();
    expect(r.input.moveX).toBe(-1);
    r.key('ArrowLeft', false); r.key('ArrowRight'); r.step();
    expect(r.input.moveX).toBe(1);
  });

  it('MODERN: an arrow produces movement and no turn', () => {
    const r = rig('modern');
    r.key('ArrowLeft');
    expect(r.step()).toBe(0);
    expect(r.input.moveX).toBe(-1);
  });

  it('CLASSIC: up/down still move, left/right TURN instead of strafing', () => {
    const r = rig('classic');
    r.key('ArrowUp'); r.step();
    expect(r.input.moveZ).toBe(1);
    r.key('ArrowUp', false); r.step();

    r.key('ArrowLeft');
    const yaw = r.step();
    expect(yaw).toBeGreaterThan(0);         // +yaw is a LEFT turn
    expect(r.input.moveX).toBe(0);          // and it is not a strafe
  });

  it('CLASSIC: right turns the other way', () => {
    const r = rig('classic');
    r.key('ArrowRight');
    expect(r.step()).toBeLessThan(0);
    expect(r.input.moveX).toBe(0);
  });

  it('swallows the browser default so the page does not scroll under the game', () => {
    // A Classic player holds Left for a full second. Without this the page
    // behind the canvas scrolls instead.
    const r = rig('classic');
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']) {
      expect(r.key(code).defaultPrevented, code).toBe(true);
      r.key(code, false);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Both schemes live at once
 * ------------------------------------------------------------------------ */

describe('nobody loses their keyboard when the scheme changes', () => {
  it('WASD moves under BOTH schemes', () => {
    for (const scheme of ['modern', 'classic'] as const) {
      const r = rig(scheme);
      r.key('KeyW'); r.step();
      expect(r.input.moveZ, scheme).toBe(1);
      r.key('KeyW', false); r.key('KeyA'); r.step();
      expect(r.input.moveX, scheme).toBe(-1);
      r.key('KeyA', false); r.key('KeyD'); r.step();
      expect(r.input.moveX, scheme).toBe(1);
      r.done(); live = null;
    }
  });

  it('the mouse still fires under Classic, alongside Ctrl', () => {
    const r = rig('classic');
    r.mouse(0); r.step();
    expect(r.input.isDown(InputAction.Fire)).toBe(true);
    r.mouse(0, false); r.step();
    r.key('ControlLeft'); r.step();
    expect(r.input.isDown(InputAction.Fire)).toBe(true);
  });

  it('Ctrl does NOT fire under Modern', () => {
    const r = rig('modern');
    r.key('ControlLeft'); r.step();
    expect(r.input.isDown(InputAction.Fire)).toBe(false);
  });

  it('CLASSIC: Space jumps and opens a door on the same press', () => {
    // Space is Jump on the primary layer and DOOM's `use` on the alt one. A
    // code is exclusive within a layer, not across them, which is the whole
    // reason Classic can have `use` on Space without losing jump.
    const r = rig('classic');
    r.key('Space'); r.step();
    expect(r.input.isDown(InputAction.Jump)).toBe(true);
    expect(r.input.isDown(InputAction.Use)).toBe(true);
    r.key('Space', false); r.step();
    expect(r.input.isDown(InputAction.Jump)).toBe(false);
    expect(r.input.isDown(InputAction.Use)).toBe(false);
  });

  it('MODERN: Space only jumps', () => {
    const r = rig('modern');
    r.key('Space'); r.step();
    expect(r.input.isDown(InputAction.Jump)).toBe(true);
    expect(r.input.isDown(InputAction.Use)).toBe(false);
  });

  it('CLASSIC: , and . strafe, exactly as key_strafeleft/right did', () => {
    const r = rig('classic');
    r.key('Comma'); r.step();
    expect(r.input.moveX).toBe(-1);
    r.key('Comma', false); r.key('Period'); r.step();
    expect(r.input.moveX).toBe(1);
  });

  it('CLASSIC: either Shift runs', () => {
    const r = rig('classic');
    r.key('ShiftLeft'); r.step();
    expect(r.input.sprinting).toBe(true);
    r.key('ShiftLeft', false); r.step();
    r.key('ShiftRight'); r.step();
    expect(r.input.sprinting).toBe(true);
  });

  it('a live switch re-resolves both layers with nothing left behind', () => {
    const r = rig('modern');
    r.key('ArrowLeft'); r.step();
    expect(r.input.moveX).toBe(-1);
    r.key('ArrowLeft', false); r.step();

    r.input.applyControlScheme('classic');
    r.key('ArrowLeft');
    const yaw = r.step();
    expect(yaw).toBeGreaterThan(0);
    expect(r.input.moveX).toBe(0);       // no longer a strafe
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The turn itself
 * ------------------------------------------------------------------------ */

describe('keyboard turning has DOOM\'s feel, not just DOOM\'s keys', () => {
  it('opens at the slow rate and steps up after ~143 ms', () => {
    const r = rig('classic');
    r.key('ArrowLeft');
    const first = r.step();
    expect(first / DT).toBeCloseTo(TURN_RATE_SLOW, 6);

    // Walk on past the boundary.
    let t = DT;
    let rate = 0;
    while (t < TURN_ACCEL_SECONDS + 4 * DT) {
            rate = r.step() / DT;
      t += DT;
    }
    expect(rate).toBeCloseTo(TURN_RATE_WALK, 6);
  });

  it('a one-second hold turns a bit under a third of a circle at a walk', () => {
    const r = rig('classic');
    const yaw = r.hold('ArrowLeft', 60);
    // Analytically: a full second at the walk rate, less what the slow stage
    // gave up. Compared loosely because the stage boundary lands inside a
    // frame, so one 16 ms step is at the "wrong" rate either way.
    const ideal = TURN_RATE_WALK - TURN_ACCEL_SECONDS * (TURN_RATE_WALK - TURN_RATE_SLOW);
    expect(yaw).toBeCloseTo(ideal, 1);
    expect(yaw * 180 / Math.PI).toBeGreaterThan(110);
    expect(yaw * 180 / Math.PI).toBeLessThan(120);
  });

  it('run turns twice as fast once past the slow stage', () => {
    const r = rig('classic');
    r.key('ShiftRight');
    r.key('ArrowRight');
    let last = 0;
    for (let i = 0; i < 30; i++) { last = r.step(); }
    expect(Math.abs(last) / DT).toBeCloseTo(TURN_RATE_RUN, 6);
  });

  it('resets the ramp between turns — a tap is always a tap', () => {
    const r = rig('classic');
    r.hold('ArrowLeft', 40);                 // long enough to reach full rate
    r.step();            // one frame with nothing held
    r.key('ArrowLeft');
    expect(r.step() / DT).toBeCloseTo(TURN_RATE_SLOW, 6);
  });

  it('both turn keys at once cancel, exactly as -= and += did', () => {
    const r = rig('classic');
    r.key('ArrowLeft'); r.key('ArrowRight');
    expect(r.step()).toBe(0);
  });

  it('turns nothing at all under Modern', () => {
    const r = rig('modern');
    for (const code of ['ArrowLeft', 'ArrowRight']) {
      r.key(code);
      expect(r.step()).toBe(0);
      r.key(code, false);
          }
  });

  it('is frame-rate independent — the yaw per second is the yaw per second', () => {
    const at = (dt: number, seconds: number): number => {
      const r = rig('classic');
      const yaw = r.hold('ArrowLeft', Math.round(seconds / dt), dt);
      r.done(); live = null;
      return yaw;
    };
    // Two very different frame budgets over the same wall-clock second. Only
    // the one quantised slow/fast boundary may differ — under half a degree.
    const drift = Math.abs(at(1 / 144, 1) - at(1 / 30, 1)) * 180 / Math.PI;
    expect(drift).toBeLessThan(1);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. DOOM's strafe modifier
 * ------------------------------------------------------------------------ */

describe('Alt makes the turn keys strafe — G_BuildTiccmd\'s `if (strafe)`', () => {
  it('turns the arrows into strafe while it is held, and back after', () => {
    const r = rig('classic');
    r.key('AltLeft');
    r.key('ArrowRight');
    expect(r.step()).toBe(0);              // no turn...
    expect(r.input.moveX).toBe(1);         // ...a strafe instead
    
    r.key('AltLeft', false);
    expect(r.step()).toBeLessThan(0);      // turning again
    expect(r.input.moveX).toBe(0);
  });

  it('strafes left on the left arrow', () => {
    const r = rig('classic');
    r.key('AltLeft'); r.key('ArrowLeft'); r.step();
    expect(r.input.moveX).toBe(-1);
  });

  it('never turns and strafes on the same frame', () => {
    const r = rig('classic');
    r.key('AltLeft'); r.key('ArrowLeft'); r.key('ArrowRight');
    expect(r.step()).toBe(0);
    expect(r.input.moveX).toBe(0);         // opposed strafes cancel too
  });

  it('does nothing in Modern, where Alt is unbound', () => {
    const r = rig('modern');
    r.key('AltLeft'); r.key('ArrowRight'); r.step();
    expect(r.input.strafeModifier).toBe(false);
    expect(r.input.moveX).toBe(1);         // still a plain strafe
  });

  it('keeps accumulating the turn ramp while strafing, as DOOM did', () => {
    // `turnheld += ticdup` runs before the strafe branch, so letting go of Alt
    // mid-turn does not restart the ramp.
    const r = rig('classic');
    r.key('AltLeft'); r.key('ArrowLeft');
    for (let i = 0; i < 30; i++) { r.step(); }
    r.key('AltLeft', false);
    expect(r.step() / DT).toBeCloseTo(TURN_RATE_WALK, 6);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. Rebinding on top of a scheme
 * ------------------------------------------------------------------------ */

describe('rebinding still works, on either layer', () => {
  it('captures the next key and swallows it whole', () => {
    const r = rig('modern');
    let got = '';
    r.input.beginRebind(InputAction.Fire, 'primary', (_a, code) => { got = code; });
    const e = r.key('KeyF');
    expect(got).toBe('KeyF');
    expect(e.defaultPrevented).toBe(true);
    // Swallowed for real: the shell's own window listeners must not also see it.
    expect(e.propagationStopped).toBe(true);
    expect(r.input.binding(InputAction.Fire)).toBe('KeyF');
    expect(r.input.rebinding).toBe(false);
  });

  it('captures a mouse button and a wheel notch too', () => {
    const r = rig('modern');
    r.input.beginRebind(InputAction.Melee, 'primary');
    r.mouse(1);
    expect(r.input.binding(InputAction.Melee)).toBe('Mouse1');
    r.input.beginRebind(InputAction.Jump, 'alt');
    r.wheel(-1);
    expect(r.input.binding(InputAction.Jump, 'alt')).toBe('WheelUp');
  });

  it('Escape cancels and tells the caller, without binding anything', () => {
    const r = rig('modern');
    let seen: string | null = null;
    r.input.beginRebind(InputAction.Fire, 'primary', (_a, code) => { seen = code; });
    const e = r.key('Escape');
    expect(seen).toBe('');                                  // the cancel signal
    expect(r.input.binding(InputAction.Fire)).toBe('Mouse0');  // untouched
    expect(r.input.rebinding).toBe(false);
    expect(e.propagationStopped).toBe(true);                // panel stays open
  });

  it('steals the code from whoever held it, within that layer only', () => {
    const r = rig('classic');
    r.input.beginRebind(InputAction.Melee, 'alt');
    r.key('ArrowLeft');
    expect(r.input.binding(InputAction.Melee, 'alt')).toBe('ArrowLeft');
    expect(r.input.binding(InputAction.TurnLeft, 'alt')).toBe('');
    // The primary layer is untouched by an alt-layer steal.
    expect(r.input.binding(InputAction.Melee, 'primary')).toBe('KeyV');
  });

  it('a rebind takes effect on the very next key press', () => {
    const r = rig('modern');
    r.input.beginRebind(InputAction.Jump, 'primary');
    r.key('KeyJ');
    r.key('KeyJ'); r.step();
    expect(r.input.isDown(InputAction.Jump)).toBe(true);
  });
});

describe('a rebind survives a scheme switch — the documented rule', () => {
  it('keeps a pinned row while the untouched rows follow the scheme', () => {
    const custom: CustomBindings = { alt: { [InputAction.TurnLeft]: 'KeyQ' } };
    const r = rig('classic', custom);

    // The pin is live: Q turns left, the arrow no longer does.
    r.key('KeyQ');
    expect(r.step()).toBeGreaterThan(0);
    r.key('KeyQ', false); r.step();
    r.key('ArrowLeft');
    expect(r.step()).toBe(0);
    r.key('ArrowLeft', false); r.step();

    // Switch away and back. The pin is still the pin.
    r.input.applyControlScheme('modern', custom);
    r.input.applyControlScheme('classic', custom);
    expect(r.input.binding(InputAction.TurnLeft, 'alt')).toBe('KeyQ');
    r.key('KeyQ');
    expect(r.step()).toBeGreaterThan(0);
    // ...and the row nobody touched moved with the scheme.
    expect(r.input.binding(InputAction.TurnRight, 'alt')).toBe('ArrowRight');
  });

  it('resetBindings drops the pins and hands the scheme its table back', () => {
    const r = rig('classic', { alt: { [InputAction.TurnLeft]: 'KeyQ' } });
    expect(r.input.binding(InputAction.TurnLeft, 'alt')).toBe('KeyQ');
    r.input.resetBindings();
    expect(r.input.binding(InputAction.TurnLeft, 'alt')).toBe('ArrowLeft');
    expect(r.input.controlScheme).toBe('classic');
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Nothing else broke
 * ------------------------------------------------------------------------ */

describe('the other input paths are untouched', () => {
  it('the touch surface still drives the axes and the buttons', () => {
    const r = rig('classic');
    r.input.setMove(0.5, -0.25);
    r.input.setButton(InputAction.Fire, true);
    r.step();
    expect(r.input.moveX).toBeCloseTo(0.5, 6);
    expect(r.input.moveZ).toBeCloseTo(-0.25, 6);
    expect(r.input.isDown(InputAction.Fire)).toBe(true);
    expect(r.input.active).toBe(true);
  });

  it('a touch tap still produces exactly one frame of down', () => {
    const r = rig('classic');
    // The pad writes its taps at the top of the fixed step — after the previous
    // frame was closed and before `update()` — so drive it in that order here.
    r.input.endFrame();
    r.input.tap(InputAction.Reload);
    r.input.update();
    expect(r.input.justPressed(InputAction.Reload)).toBe(true);
    r.step();
    expect(r.input.isDown(InputAction.Reload)).toBe(false);
  });

  it('a held Alt does not eat an analogue strafe from the pad or the pad-less touch stick', () => {
    const r = rig('classic');
    r.key('AltLeft');
    r.input.setMove(-0.8, 0);
    r.step();
    expect(r.input.moveX).toBeCloseTo(-0.8, 6);
  });

  it('detaches cleanly — every listener it added, it removes', () => {
    const r = rig('modern');
    expect(r.win.listenerCount).toBeGreaterThan(0);
    r.input.detach();
    expect(r.win.listenerCount).toBe(0);
    r.input.attach(null);                // re-attachable, for the next mode
    expect(r.win.listenerCount).toBeGreaterThan(0);
  });

  it('releases a held turn key on blur instead of spinning forever', () => {
    const r = rig('classic');
    r.key('ArrowLeft');
    r.step();
    r.win.dispatch('blur');
    expect(r.step()).toBe(0);
  });

  it('reads every action as released while disabled', () => {
    const r = rig('classic');
    r.key('ArrowLeft'); r.key('KeyW');
    r.input.enabled = false;
    expect(r.step()).toBe(0);
    expect(r.input.moveZ).toBe(0);
  });
});

describe('a mode taking an action takes BOTH layers', () => {
  it('kills the alt key too — the freecam body must not walk on the arrows', () => {
    // Builder's no-clip camera takes the movement actions. Before the second
    // layer existed it did that by blanking the binding, which would have left
    // the arrows walking the body around under a detached camera.
    const r = rig('modern');
    r.input.setActionTaken(InputAction.MoveLeft, true);
    r.key('KeyA'); r.step();
    expect(r.input.moveX).toBe(0);
    r.key('KeyA', false); r.step();
    r.key('ArrowLeft'); r.step();
    expect(r.input.moveX).toBe(0);
    expect(r.input.isActionTaken(InputAction.MoveLeft)).toBe(true);
  });

  it('kills Classic\'s Ctrl-fire when Horde takes the fire action', () => {
    const r = rig('classic');
    r.input.setActionTaken(InputAction.Fire, true);
    r.key('ControlLeft'); r.step();
    expect(r.input.isDown(InputAction.Fire)).toBe(false);
    r.mouse(0); r.step();
    expect(r.input.isDown(InputAction.Fire)).toBe(false);
  });

  it('hands it straight back, with the key still physically held', () => {
    const r = rig('modern');
    r.key('KeyW');
    r.input.setActionTaken(InputAction.MoveForward, true);
    r.step();
    expect(r.input.moveZ).toBe(0);
        r.input.setActionTaken(InputAction.MoveForward, false);
    r.step();
    expect(r.input.moveZ).toBe(1);
  });

  it('leaves every other action alone', () => {
    const r = rig('modern');
    r.input.setActionTaken(InputAction.MoveForward, true);
    r.key('KeyD'); r.step();
    expect(r.input.moveX).toBe(1);
  });
});

/* ------------------------------------------------------------------------ *
 * 6b. A taken action must stay readable BY THE MODE THAT TOOK IT
 *
 * The mobile-builder regression: on a phone every pointer lands on the touch
 * overlay, which drives InputActions — and Builder had taken Fire, which made
 * the action read released from every source for everyone, Builder included.
 * The whole mobile capture ran with "0 placed · 0 broken". These tests pin the
 * read-back path: raw held state through the mask, and taps latched across the
 * frame boundary (modes update after `game.tick`, which has already cleared
 * the per-frame pulses by then).
 * ------------------------------------------------------------------------ */

describe('a taken action is still readable by the mode that took it', () => {
  it('reads a held touch button through the mask, without leaking to the game', () => {
    const r = rig('modern');
    r.input.setActionTaken(InputAction.Fire, true);
    r.input.touch.setButton(InputAction.Fire, true);
    r.step();
    expect(r.input.isDown(InputAction.Fire)).toBe(false);   // the shotgun stays holstered
    expect(r.input.takenHeld(InputAction.Fire)).toBe(true); // the dig still runs
    r.input.touch.setButton(InputAction.Fire, false);
    r.step();
    expect(r.input.takenHeld(InputAction.Fire)).toBe(false);
  });

  it('latches a tap across the frame boundary that clears pulses', () => {
    const r = rig('modern');
    r.input.setActionTaken(InputAction.Fire, true);
    r.input.touch.tap(InputAction.Fire);
    // The shipped order inside game.tick: update() then endFrame(); only THEN
    // does the mode's update run. The tap has to survive both.
    r.input.update();
    r.input.endFrame();
    expect(r.input.consumeTakenTap(InputAction.Fire)).toBe(true);
    expect(r.input.consumeTakenTap(InputAction.Fire)).toBe(false); // consumed once
  });

  it('latches a wheel notch into a taken action — Builder\'s hotbar wheel', () => {
    const r = rig('modern');
    r.input.setActionTaken(InputAction.NextWeapon, true);
    r.wheel(120); // WheelDown is NextWeapon in the default table
    r.input.update();
    r.input.endFrame();
    expect(r.input.consumeTakenTap(InputAction.NextWeapon)).toBe(true);
  });

  it('does not latch for actions nobody took, and clears on hand-back', () => {
    const r = rig('modern');
    r.input.touch.tap(InputAction.Fire); // not taken: this is the game's press
    r.input.update();
    expect(r.input.isDown(InputAction.Fire)).toBe(true);
    r.input.endFrame();
    expect(r.input.consumeTakenTap(InputAction.Fire)).toBe(false);

    r.input.setActionTaken(InputAction.Fire, true);
    r.input.touch.tap(InputAction.Fire);
    r.input.update();
    r.input.endFrame();
    r.input.setActionTaken(InputAction.Fire, false); // mode exits before consuming
    expect(r.input.consumeTakenTap(InputAction.Fire)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 7. What the settings panel prints
 * ------------------------------------------------------------------------ */

describe('bindingLabel', () => {
  it('names the classic keys the way DOOM\'s manual did', () => {
    expect(bindingLabel('Comma')).toBe(',');
    expect(bindingLabel('Period')).toBe('.');
    expect(bindingLabel('ControlLeft')).toBe('L Ctrl');
    expect(bindingLabel('AltLeft')).toBe('L Alt');
    expect(bindingLabel('ShiftRight')).toBe('R Shift');
    expect(bindingLabel('ArrowLeft')).toBe('Left');
    expect(bindingLabel('Space')).toBe('Space');
  });

  it('still names everything it named before', () => {
    expect(bindingLabel('')).toBe('—');
    expect(bindingLabel('KeyW')).toBe('W');
    expect(bindingLabel('Digit3')).toBe('3');
    expect(bindingLabel('Mouse0')).toBe('Mouse 1');
    expect(bindingLabel('WheelUp')).toBe('Wheel Up');
    expect(bindingLabel('Numpad5')).toBe('Num 5');
  });

  it('gives every action in every scheme a printable label', () => {
    for (const scheme of ['modern', 'classic'] as const) {
      const r = rig(scheme);
      for (const a of ACTIONS) {
        for (const layer of ['primary', 'alt'] as const) {
          const label = bindingLabel(r.input.binding(a, layer));
          expect(label.length, `${scheme}/${a}/${layer}`).toBeGreaterThan(0);
        }
      }
      r.done(); live = null;
    }
  });
});
