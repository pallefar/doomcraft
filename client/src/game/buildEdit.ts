/**
 * DOOMCRAFT — the build sub-mode's two gestures, resolved from the input layer.
 *
 * The non-Builder modes (Deathmatch, Horde, Quest) share `game.ts`'s own crude
 * build path: `BuildMode` toggles `buildMode`, and inside it Fire digs while
 * AltFire places. On a phone every pointer lands on the control pad, which
 * drives InputActions — and nothing on the pad drives AltFire at all, so a
 * mobile player in build mode could hold the FIRE disc to dig but had no way to
 * place a single block. That is the exact twin of the mobile-Builder bug fixed
 * in 212b681, one layer down: Builder took the actions and read them back;
 * game.ts's default path never did.
 *
 * The fix mirrors Builder. While a touch player is in build mode `game.ts`
 * takes Fire/AltFire off the InputManager (a taken action reads released from
 * every source), and the pad is read back through the mask — the FIRE disc
 * (held) digs, a screen tap places, the pocket-builder convention. Desktop
 * never takes the actions (`touchTaken` is false there), so the mouse buttons
 * read through `isDown()` exactly as before, byte for byte.
 *
 * Pulled out of `Game.stepEdits` as a pure function so the wiring is unit
 * tested without standing up a WebGL `Game`: `buildEdit.test.ts` drives a real
 * `InputManager` through the taken-action mask and asserts the pad reaches both
 * the dig and the place path.
 */
import { InputAction } from '@shared/constants';

/** The slice of `InputManager` this decision reads. */
export interface BuildEditInput {
  isDown(action: InputAction): boolean;
  takenHeld(action: InputAction): boolean;
  consumeTakenTap(action: InputAction): boolean;
}

export interface BuildEditIntent {
  /** Dig the targeted block this step. */
  wantBreak: boolean;
  /** Place a block against the targeted face this step. */
  wantPlace: boolean;
}

/**
 * Resolve dig/place for one step of `stepEdits`.
 *
 * @param buildMode   the mode's build toggle is on
 * @param touchTaken  build mode has taken Fire/AltFire for the touch pad
 *
 * When the pad owns the actions the touch tap is consumed here unconditionally,
 * so a latched tap is spent this step whether or not it is acted on — it can
 * never carry over to become a phantom placement a second later. A tap on the
 * same step the dig button is held is a mis-tap and is dropped, matching the
 * both-buttons rule the placement path keeps. On desktop `touchTaken` is false,
 * so this collapses to the original two lines: `buildMode && isDown(Fire)` for
 * the dig, `isDown(AltFire)` for the place.
 */
export function resolveBuildEdit(
  input: BuildEditInput,
  buildMode: boolean,
  touchTaken: boolean,
): BuildEditIntent {
  const wantBreak = buildMode && (touchTaken
    ? input.takenHeld(InputAction.Fire)
    : input.isDown(InputAction.Fire));
  const placeTap = touchTaken && buildMode && input.consumeTakenTap(InputAction.Fire);
  const wantPlace = (touchTaken
    ? input.takenHeld(InputAction.AltFire)
    : input.isDown(InputAction.AltFire))
    || (placeTap && !wantBreak);
  return { wantBreak, wantPlace };
}
