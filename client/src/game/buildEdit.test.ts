/**
 * DOOMCRAFT — the build sub-mode's touch gestures reach the edit path.
 *
 * The twin of the mobile-Builder bug (212b681), one layer down. The non-Builder
 * modes share `game.ts`'s own build path, and it read place/break straight off
 * `isDown(Fire)` / `isDown(AltFire)`. Nothing on the touch pad drives AltFire,
 * so a phone in deathmatch build mode could hold the FIRE disc to dig but had
 * no gesture that placed a block at all.
 *
 * `resolveBuildEdit` is the fix's decision, pulled out of `stepEdits` so it can
 * be driven by a real `InputManager` in node without a WebGL `Game`. These
 * tests stand up the exact touch scenario — build mode has taken Fire/AltFire,
 * and the pad drives them — and were proven RED against the pre-fix logic
 * (`wantBreak = buildMode && isDown(Fire)`, `wantPlace = isDown(AltFire)`),
 * where a taken action reads released and both the dig and the place vanish.
 */
import { describe, it, expect } from 'vitest';
import { InputAction } from '@shared/constants';
import { InputManager } from '../player/input';
import { resolveBuildEdit } from './buildEdit';

/**
 * A bare manager, no DOM attach: the touch surface and the taken-action mask
 * are pure method calls, and `update`/`endFrame` never touch `window`.
 */
function makeInput(): InputManager {
  const input = new InputManager({ controlScheme: 'modern' });
  input.enabled = true;
  return input;
}

/** What `game.ts` does when a touch player enters build mode. */
function takeForBuild(input: InputManager): void {
  input.setActionTaken(InputAction.Fire, true);
  input.setActionTaken(InputAction.AltFire, true);
}

describe('mobile build sub-mode reaches the edit path through the taken mask', () => {
  it('holding the FIRE disc digs, with the gun still holstered', () => {
    const input = makeInput();
    takeForBuild(input);

    input.touch.setButton(InputAction.Fire, true);   // the FIRE disc, held
    input.update();

    const intent = resolveBuildEdit(input, true, true);
    expect(intent.wantBreak).toBe(true);              // the dig runs
    expect(intent.wantPlace).toBe(false);
    expect(input.isDown(InputAction.Fire)).toBe(false); // ...but Fire reads released
  });

  it('a screen tap places a block — the gesture the pad had no way to reach', () => {
    const input = makeInput();
    takeForBuild(input);

    input.touch.tap(InputAction.Fire);                // a look-surface tap
    // The shipped order inside a fixed step: update() then endFrame(); the tap
    // has to survive the boundary that clears per-frame pulses.
    input.update();
    input.endFrame();

    const intent = resolveBuildEdit(input, true, true);
    expect(intent.wantPlace).toBe(true);              // the block lands
    expect(intent.wantBreak).toBe(false);
  });

  it('a tap while the dig is held is a mis-tap: dropped, never deferred', () => {
    const input = makeInput();
    takeForBuild(input);

    input.touch.setButton(InputAction.Fire, true);    // digging...
    input.touch.tap(InputAction.Fire);                // ...and a stray tap
    input.update();
    input.endFrame();

    const intent = resolveBuildEdit(input, true, true);
    expect(intent.wantBreak).toBe(true);
    expect(intent.wantPlace).toBe(false);
    // The tap was spent this step, not latched to place a phantom block later.
    expect(input.consumeTakenTap(InputAction.Fire)).toBe(false);
  });

  it('places only in build mode: a tap outside it is a shot, not a block', () => {
    const input = makeInput();
    takeForBuild(input);

    input.touch.tap(InputAction.Fire);
    input.update();
    input.endFrame();

    // buildMode off: the tap must not resolve to a placement.
    const intent = resolveBuildEdit(input, false, true);
    expect(intent.wantPlace).toBe(false);
    expect(intent.wantBreak).toBe(false);
  });

  it('desktop is untouched: nothing is taken, the tap path is off', () => {
    const input = makeInput();
    // Simulate a stray latched Fire tap with the action taken by something else…
    input.setActionTaken(InputAction.Fire, true);
    input.touch.tap(InputAction.Fire);
    input.update();
    input.endFrame();

    // …but `touchTaken` is false on desktop, so the tap must never place, and it
    // is left untouched for whoever actually owns it.
    const intent = resolveBuildEdit(input, true, false);
    expect(intent.wantPlace).toBe(false);
    expect(input.consumeTakenTap(InputAction.Fire)).toBe(true);
  });
});
