/**
 * DOOMCRAFT — unified input.
 *
 * Three sources, one action table, one output struct:
 *   - keyboard + mouse under pointer lock, every action rebindable
 *   - gamepad (standard mapping) with deadzone and a squared response curve
 *   - touch, exposed as a small imperative surface the mobile-controls piece
 *     drives; this file deliberately draws no UI and owns no DOM of its own
 *
 * The output is `InputCommand` exactly as the protocol defines it, so the same
 * frame feeds local prediction and the wire with no translation layer in
 * between. Look deltas are kept OUT of the command (the command carries absolute
 * yaw/pitch) because the camera owns sensitivity and pitch clamping.
 *
 * Allocation: none per frame. Edge state lives in Uint8Arrays indexed by action.
 */

import {
  InputAction, DEFAULT_KEYBINDS,
} from '@shared/constants';
import {
  BTN_FIRE, BTN_ALT_FIRE, BTN_JUMP, BTN_CROUCH, BTN_SPRINT, BTN_RELOAD,
  BTN_USE, BTN_MELEE, BTN_BUILD, BTN_NEXT_WEAPON, BTN_PREV_WEAPON, BTN_RESPAWN,
  type InputCommand,
} from '@shared/protocol';

/* ------------------------------------------------------------------------ *
 * Action table
 * ------------------------------------------------------------------------ */

/** Every action, in a stable order. The index into this array is the action id. */
export const ACTIONS: readonly InputAction[] = Object.freeze(
  Object.values(InputAction) as InputAction[],
);
export const ACTION_COUNT = ACTIONS.length;

const ACTION_ID: Record<string, number> = Object.create(null);
for (let i = 0; i < ACTIONS.length; i++) ACTION_ID[ACTIONS[i]] = i;

/** Hotbar slot actions 1..7, indexed by slot number (index 0 unused). */
const SLOT_ACTIONS: readonly (InputAction | undefined)[] = Object.freeze([
  undefined,
  InputAction.Slot1, InputAction.Slot2, InputAction.Slot3, InputAction.Slot4,
  InputAction.Slot5, InputAction.Slot6, InputAction.Slot7,
]);

/** Numeric id of an action, or -1. */
export function actionId(action: InputAction | string): number {
  const v = ACTION_ID[action as string];
  return v === undefined ? -1 : v;
}

export type BindingMap = Record<InputAction, string>;

/** Mouse buttons and wheel are bound with these synthetic codes. */
export const MOUSE_CODES: readonly string[] = Object.freeze([
  'Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4',
]);
export const WHEEL_UP = 'WheelUp';
export const WHEEL_DOWN = 'WheelDown';

/** Human label for a binding code, for the settings screen. */
export function bindingLabel(code: string): string {
  if (code === '') return '—';
  if (code === WHEEL_UP) return 'Wheel Up';
  if (code === WHEEL_DOWN) return 'Wheel Down';
  if (code.startsWith('Mouse')) return `Mouse ${Number(code.slice(5)) + 1}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code === 'Space') return 'Space';
  if (code.endsWith('Left')) return `L ${code.slice(0, -4)}`;
  if (code.endsWith('Right')) return `R ${code.slice(0, -5)}`;
  return code;
}

/* ------------------------------------------------------------------------ *
 * Gamepad mapping
 * ------------------------------------------------------------------------ */

const PAD_DEADZONE = 0.18;
/** Standard-mapping button index -> action id, built once. */
const PAD_BUTTON_ACTION: Record<number, InputAction> = {
  0: InputAction.Jump,
  1: InputAction.Crouch,
  2: InputAction.Reload,
  3: InputAction.Use,
  4: InputAction.PrevWeapon,
  5: InputAction.NextWeapon,
  6: InputAction.AltFire,
  7: InputAction.Fire,
  9: InputAction.Menu,
  10: InputAction.Sprint,
  11: InputAction.Melee,
};
/** Radians per second of look at full right-stick deflection. */
export const PAD_LOOK_SPEED = 3.6;

function padAxis(v: number): number {
  const a = Math.abs(v);
  if (a < PAD_DEADZONE) return 0;
  const t = (a - PAD_DEADZONE) / (1 - PAD_DEADZONE);
  return (v < 0 ? -1 : 1) * t * t;
}

/* ------------------------------------------------------------------------ *
 * Touch surface
 * ------------------------------------------------------------------------ */

/**
 * The contract the mobile-controls piece codes against. It owns the joystick,
 * the fire pad and the glyph buttons; it calls into here and never touches the
 * keyboard path.
 *
 * The bar has no fire button at all — aiming and shooting are the same gesture
 * (ref/BAR.md weakness #9) — so `setButton(InputAction.Fire, true)` while the
 * look drag continues is an explicitly supported combination.
 */
export interface TouchSurface {
  /** Left stick, each axis -1..1. */
  setMove(x: number, z: number): void;
  /** Accumulate a look drag in CSS pixels. */
  addLook(dxPx: number, dyPx: number): void;
  /** Hold or release a virtual button. */
  setButton(action: InputAction, down: boolean): void;
  /** One-shot press: produces a press edge this frame and a release next frame. */
  tap(action: InputAction): void;
  /** Release everything — call on visibilitychange or when the pad unmounts. */
  reset(): void;
  /** True once any touch input has been seen. Drives touch vs mouse sensitivity. */
  readonly active: boolean;
}

/* ------------------------------------------------------------------------ *
 * Manager
 * ------------------------------------------------------------------------ */

export interface InputManagerOptions {
  /** Element that owns pointer lock. Usually the #game canvas. */
  target?: HTMLElement | null;
  bindings?: Partial<BindingMap>;
  /** Crouch is a toggle rather than a hold. */
  toggleCrouch?: boolean;
  /** Sprint whenever moving forward without holding the key. */
  autoSprint?: boolean;
}

export class InputManager implements TouchSurface {
  /** Live bindings, action -> code. Mutate through `setBinding`. */
  readonly bindings: BindingMap;

  /** Off means every action reads as released; the UI sets this for menus. */
  enabled = true;
  toggleCrouch = false;
  autoSprint = false;

  /** Accumulated mouse look, CSS pixels, cleared by `endFrame`. */
  lookDx = 0;
  lookDy = 0;
  /** Accumulated touch look, CSS pixels, cleared by `endFrame`. */
  touchLookDx = 0;
  touchLookDy = 0;
  /** Right-stick look, -1..1, sampled fresh each `update`. */
  stickLookX = 0;
  stickLookY = 0;

  /** True while the pointer is locked to the target element. */
  pointerLocked = false;
  /**
   * Accept raw mouse deltas even without pointer lock. Some environments never
   * grant it — a cross-origin embed, a kiosk, an automated capture run — and a
   * game that simply cannot be aimed there is worse than one that reads the
   * unlocked deltas. Off by default; the boot layer turns it on only after a
   * lock request has visibly failed.
   */
  unlockedLook = false;
  /** Set once any touch event has been routed through this manager. */
  active = false;
  /** True when a gamepad reported input this frame. */
  gamepadActive = false;

  /** Hotbar slot 0..8 chosen by the number keys / d-pad. Game logic may write it. */
  slot = 0;
  /** Set by the game layer while dead so the command carries BTN_RESPAWN. */
  requestRespawn = false;

  private readonly downState = new Uint8Array(ACTION_COUNT);
  private readonly pressEdge = new Uint8Array(ACTION_COUNT);
  private readonly releaseEdge = new Uint8Array(ACTION_COUNT);
  /** Sources are OR-ed so a key and a pad button do not fight over one action. */
  private readonly keyDown = new Uint8Array(ACTION_COUNT);
  private readonly padDown = new Uint8Array(ACTION_COUNT);
  private readonly touchDown = new Uint8Array(ACTION_COUNT);
  /** One-frame pulses: wheel notches and touch taps. */
  private readonly pulse = new Uint8Array(ACTION_COUNT);

  private readonly codeToAction = new Map<string, number>();

  private target: HTMLElement | null = null;
  private attached = false;
  private crouchLatched = false;

  private padMoveX = 0;
  private padMoveZ = 0;
  private touchMoveX = 0;
  private touchMoveZ = 0;

  private rebindAction = -1;
  private rebindDone: ((action: InputAction, code: string) => void) | null = null;
  /**
   * `navigator.getGamepads()` mints a fresh array on every call, so polling it
   * unconditionally allocates once per frame for the large majority of players
   * who never plug a pad in. Gate it on the connection event instead.
   */
  private padPresent = false;

  /* --- bound listeners, created once so detach really detaches --- */
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKey(e, true);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.handleKey(e, false);
  private readonly onMouseDown = (e: MouseEvent): void => this.handleMouse(e, true);
  private readonly onMouseUp = (e: MouseEvent): void => this.handleMouse(e, false);
  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (!this.pointerLocked && !this.unlockedLook) return;
    this.lookDx += e.movementX;
    this.lookDy += e.movementY;
  };
  private readonly onWheel = (e: WheelEvent): void => {
    const code = e.deltaY < 0 ? WHEEL_UP : WHEEL_DOWN;
    if (this.rebindAction >= 0) { this.finishRebind(code); e.preventDefault(); return; }
    if (!this.enabled) return;
    const id = this.codeToAction.get(code);
    if (id === undefined) return;
    // A wheel notch is a pulse: press this frame, release at endFrame.
    this.pulse[id] = 1;
    e.preventDefault();
  };
  private readonly onContextMenu = (e: Event): void => { e.preventDefault(); };
  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = typeof document !== 'undefined' && document.pointerLockElement === this.target;
    if (!this.pointerLocked) this.releaseAll();
  };
  private readonly onBlur = (): void => { this.releaseAll(); };
  private readonly onPadConnected = (): void => { this.padPresent = true; };
  private readonly onPadDisconnected = (): void => {
    this.padPresent = false;
    this.padDown.fill(0);
    this.padMoveX = 0; this.padMoveZ = 0;
    this.stickLookX = 0; this.stickLookY = 0;
  };
  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.hidden) this.releaseAll();
  };

  constructor(options: InputManagerOptions = {}) {
    this.bindings = { ...DEFAULT_KEYBINDS } as BindingMap;
    if (options.bindings) this.loadBindings(options.bindings);
    this.rebuildCodeMap();
    this.target = options.target ?? null;
    this.toggleCrouch = options.toggleCrouch ?? false;
    this.autoSprint = options.autoSprint ?? false;
  }

  /* -------------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------------- */

  attach(target?: HTMLElement | null): void {
    if (target !== undefined) this.target = target;
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp, { passive: true });
    window.addEventListener('mousedown', this.onMouseDown, { passive: false });
    window.addEventListener('mouseup', this.onMouseUp, { passive: true });
    window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onPadConnected);
    window.addEventListener('gamepaddisconnected', this.onPadDisconnected);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.target?.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    if (!this.attached || typeof window === 'undefined') return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onPadConnected);
    window.removeEventListener('gamepaddisconnected', this.onPadDisconnected);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.target?.removeEventListener('contextmenu', this.onContextMenu);
    this.releaseAll();
  }

  requestPointerLock(): void {
    const t = this.target;
    if (t === null || typeof document === 'undefined') return;
    if (document.pointerLockElement === t) return;
    const p = t.requestPointerLock() as unknown;
    if (p !== undefined && p !== null && typeof (p as Promise<void>).catch === 'function') {
      (p as Promise<void>).catch(() => { /* user gesture missing; the caller retries */ });
    }
  }

  exitPointerLock(): void {
    if (typeof document !== 'undefined' && document.pointerLockElement === this.target) {
      document.exitPointerLock();
    }
  }

  /** Drop every held key/button. Called on blur, pointer-lock loss and menus. */
  releaseAll(): void {
    this.keyDown.fill(0);
    this.padDown.fill(0);
    this.touchDown.fill(0);
    this.pulse.fill(0);
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (this.downState[i] !== 0) this.releaseEdge[i] = 1;
      this.downState[i] = 0;
    }
    this.padMoveX = 0; this.padMoveZ = 0;
    this.touchMoveX = 0; this.touchMoveZ = 0;
    this.lookDx = 0; this.lookDy = 0;
    this.touchLookDx = 0; this.touchLookDy = 0;
    this.stickLookX = 0; this.stickLookY = 0;
  }

  /* -------------------------------------------------------------------- *
   * Bindings
   * -------------------------------------------------------------------- */

  private rebuildCodeMap(): void {
    this.codeToAction.clear();
    for (let i = 0; i < ACTIONS.length; i++) {
      const code = this.bindings[ACTIONS[i]];
      if (code) this.codeToAction.set(code, i);
    }
  }

  setBinding(action: InputAction, code: string): void {
    // One code drives one action. Steal it from whoever had it.
    for (let i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i] !== action && this.bindings[ACTIONS[i]] === code) {
        this.bindings[ACTIONS[i]] = '';
      }
    }
    this.bindings[action] = code;
    this.rebuildCodeMap();
  }

  loadBindings(partial: Partial<BindingMap>): void {
    for (const key of Object.keys(partial)) {
      const a = key as InputAction;
      const v = partial[a];
      if (typeof v === 'string') this.bindings[a] = v;
    }
    this.rebuildCodeMap();
  }

  resetBindings(): void {
    for (const a of ACTIONS) this.bindings[a] = DEFAULT_KEYBINDS[a];
    this.rebuildCodeMap();
  }

  /**
   * Capture the next key, mouse button or wheel notch and bind it to `action`.
   * The captured event is swallowed, so the settings screen never also fires it.
   */
  beginRebind(action: InputAction, done?: (action: InputAction, code: string) => void): void {
    this.rebindAction = actionId(action);
    this.rebindDone = done ?? null;
    this.releaseAll();
  }

  cancelRebind(): void {
    this.rebindAction = -1;
    this.rebindDone = null;
  }

  get rebinding(): boolean { return this.rebindAction >= 0; }

  private finishRebind(code: string): void {
    const id = this.rebindAction;
    this.rebindAction = -1;
    const done = this.rebindDone;
    this.rebindDone = null;
    if (id < 0) return;
    const action = ACTIONS[id];
    this.setBinding(action, code);
    if (done) done(action, code);
  }

  /* -------------------------------------------------------------------- *
   * DOM handlers
   * -------------------------------------------------------------------- */

  private handleKey(e: KeyboardEvent, down: boolean): void {
    if (e.repeat) return;
    if (down && this.rebindAction >= 0) {
      if (e.code === 'Escape') this.cancelRebind();
      else this.finishRebind(e.code);
      e.preventDefault();
      return;
    }
    const id = this.codeToAction.get(e.code);
    if (id === undefined) return;
    // Tab and the digits must not scroll or move focus while playing.
    if (down && (e.code === 'Tab' || e.code === 'Space')) e.preventDefault();
    if (!this.enabled) { this.keyDown[id] = 0; return; }
    this.keyDown[id] = down ? 1 : 0;
    // Latch the press. A tap that goes down and up inside one frame — a
    // weapon-slot key on a fast keyboard, an automated key press, a mobile
    // browser coalescing events — leaves the polled state at 0 on both sides
    // of the frame boundary and the edge is never generated at all. The pulse
    // guarantees exactly one frame of "down" without affecting a real hold.
    if (down) this.pulse[id] = 1;
  }

  private handleMouse(e: MouseEvent, down: boolean): void {
    const code = `Mouse${e.button}`;
    if (down && this.rebindAction >= 0) { this.finishRebind(code); e.preventDefault(); return; }
    const id = this.codeToAction.get(code);
    if (id === undefined) return;
    if (!this.enabled) { this.keyDown[id] = 0; return; }
    this.keyDown[id] = down ? 1 : 0;
    if (down) this.pulse[id] = 1;
    if (down && e.button === 2) e.preventDefault();
  }

  /* -------------------------------------------------------------------- *
   * Touch surface
   * -------------------------------------------------------------------- */

  setMove(x: number, z: number): void {
    this.active = true;
    this.touchMoveX = x < -1 ? -1 : x > 1 ? 1 : x;
    this.touchMoveZ = z < -1 ? -1 : z > 1 ? 1 : z;
  }

  addLook(dxPx: number, dyPx: number): void {
    this.active = true;
    this.touchLookDx += dxPx;
    this.touchLookDy += dyPx;
  }

  setButton(action: InputAction, down: boolean): void {
    this.active = true;
    const id = actionId(action);
    if (id < 0) return;
    this.touchDown[id] = down ? 1 : 0;
  }

  tap(action: InputAction): void {
    this.active = true;
    const id = actionId(action);
    if (id < 0) return;
    this.pulse[id] = 1;
  }

  reset(): void {
    this.touchDown.fill(0);
    this.pulse.fill(0);
    this.touchMoveX = 0;
    this.touchMoveZ = 0;
    this.touchLookDx = 0;
    this.touchLookDy = 0;
  }

  /** The touch surface itself, for handing to the mobile-controls module. */
  get touch(): TouchSurface { return this; }

  /* -------------------------------------------------------------------- *
   * Per-frame
   * -------------------------------------------------------------------- */

  /**
   * Poll the gamepad and recompute edges. Call once per frame BEFORE reading
   * any action state, and call `endFrame` after the frame is done with it.
   */
  update(): void {
    this.pollGamepad();

    for (let i = 0; i < ACTION_COUNT; i++) {
      const now = this.enabled
        ? (this.keyDown[i] | this.padDown[i] | this.touchDown[i] | this.pulse[i])
        : 0;
      const was = this.downState[i];
      if (now !== 0 && was === 0) this.pressEdge[i] = 1;
      else if (now === 0 && was !== 0) this.releaseEdge[i] = 1;
      this.downState[i] = now;
    }

    if (this.toggleCrouch) {
      const id = actionId(InputAction.Crouch);
      if (id >= 0 && this.pressEdge[id] !== 0) this.crouchLatched = !this.crouchLatched;
    } else {
      this.crouchLatched = false;
    }
  }

  /** Clear per-frame edges and accumulators. Call after the frame is built. */
  endFrame(): void {
    this.pressEdge.fill(0);
    this.releaseEdge.fill(0);
    this.pulse.fill(0);
    this.lookDx = 0;
    this.lookDy = 0;
    this.touchLookDx = 0;
    this.touchLookDy = 0;
  }

  private pollGamepad(): void {
    if (!this.padPresent) return;
    this.padDown.fill(0);
    this.padMoveX = 0;
    this.padMoveZ = 0;
    this.stickLookX = 0;
    this.stickLookY = 0;
    this.gamepadActive = false;
    if (!this.enabled || typeof navigator === 'undefined' || !navigator.getGamepads) return;

    const pads = navigator.getGamepads();
    for (let p = 0; p < pads.length; p++) {
      const pad = pads[p];
      if (pad === null || !pad.connected) continue;

      const ax = padAxis(pad.axes[0] ?? 0);
      const az = padAxis(pad.axes[1] ?? 0);
      if (ax !== 0 || az !== 0) {
        this.padMoveX = ax;
        this.padMoveZ = -az;      // stick up is -1, forward is +1
        this.gamepadActive = true;
      }
      const lx = padAxis(pad.axes[2] ?? 0);
      const ly = padAxis(pad.axes[3] ?? 0);
      if (lx !== 0 || ly !== 0) {
        this.stickLookX = lx;
        this.stickLookY = ly;
        this.gamepadActive = true;
      }

      for (const key in PAD_BUTTON_ACTION) {
        const bi = Number(key);
        const btn = pad.buttons[bi];
        if (btn === undefined) continue;
        if (btn.pressed || btn.value > 0.4) {
          const id = actionId(PAD_BUTTON_ACTION[bi]);
          if (id >= 0) this.padDown[id] = 1;
          this.gamepadActive = true;
        }
      }
      // D-pad cycles the hotbar.
      const up = pad.buttons[12], down = pad.buttons[13];
      if (up?.pressed) { this.padDown[actionId(InputAction.PrevWeapon)] = 1; this.gamepadActive = true; }
      if (down?.pressed) { this.padDown[actionId(InputAction.NextWeapon)] = 1; this.gamepadActive = true; }
      break;   // first connected pad wins
    }
  }

  /* -------------------------------------------------------------------- *
   * Queries
   * -------------------------------------------------------------------- */

  isDown(action: InputAction): boolean {
    const id = ACTION_ID[action];
    return id !== undefined && this.downState[id] !== 0;
  }
  justPressed(action: InputAction): boolean {
    const id = ACTION_ID[action];
    return id !== undefined && this.pressEdge[id] !== 0;
  }
  justReleased(action: InputAction): boolean {
    const id = ACTION_ID[action];
    return id !== undefined && this.releaseEdge[id] !== 0;
  }

  /** Crouch after the toggle setting is applied. */
  get crouching(): boolean {
    return this.toggleCrouch ? this.crouchLatched : this.isDown(InputAction.Crouch);
  }

  /** Sprint after the auto-sprint setting is applied. */
  get sprinting(): boolean {
    if (this.isDown(InputAction.Sprint)) return true;
    return this.autoSprint && this.moveZ > 0.5;
  }

  /** Combined strafe axis, -1..1. Keyboard is digital, pad and touch analogue. */
  get moveX(): number {
    let v = 0;
    if (this.isDown(InputAction.MoveRight)) v += 1;
    if (this.isDown(InputAction.MoveLeft)) v -= 1;
    if (v === 0) v = this.padMoveX !== 0 ? this.padMoveX : this.touchMoveX;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /** Combined forward axis, -1..1, +1 forward. */
  get moveZ(): number {
    let v = 0;
    if (this.isDown(InputAction.MoveForward)) v += 1;
    if (this.isDown(InputAction.MoveBack)) v -= 1;
    if (v === 0) v = this.padMoveZ !== 0 ? this.padMoveZ : this.touchMoveZ;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /** Slot key pressed this frame, 1..7, or 0. */
  consumeSlotKey(): number {
    for (let s = 1; s <= 7; s++) {
      const a = SLOT_ACTIONS[s];
      if (a !== undefined && this.justPressed(a)) return s;
    }
    return 0;
  }

  /* -------------------------------------------------------------------- *
   * Output
   * -------------------------------------------------------------------- */

  /** BTN_* mask for the wire. Weapon-cycle bits are edge-triggered. */
  buttonsMask(): number {
    let b = 0;
    if (this.isDown(InputAction.Fire)) b |= BTN_FIRE;
    if (this.isDown(InputAction.AltFire)) b |= BTN_ALT_FIRE;
    if (this.isDown(InputAction.Jump)) b |= BTN_JUMP;
    if (this.crouching) b |= BTN_CROUCH;
    if (this.sprinting) b |= BTN_SPRINT;
    if (this.isDown(InputAction.Reload)) b |= BTN_RELOAD;
    if (this.isDown(InputAction.Use)) b |= BTN_USE;
    if (this.isDown(InputAction.Melee)) b |= BTN_MELEE;
    if (this.isDown(InputAction.BuildMode)) b |= BTN_BUILD;
    if (this.justPressed(InputAction.NextWeapon)) b |= BTN_NEXT_WEAPON;
    if (this.justPressed(InputAction.PrevWeapon)) b |= BTN_PREV_WEAPON;
    if (this.requestRespawn) b |= BTN_RESPAWN;
    return b;
  }

  /**
   * Fill an `InputCommand` for the wire and for local prediction. `yaw`/`pitch`
   * come from the camera because it owns sensitivity, inversion and clamping.
   */
  buildCommand(
    out: InputCommand,
    seq: number, dtMs: number,
    yaw: number, pitch: number,
    slot: number = this.slot,
  ): InputCommand {
    out.seq = seq;
    out.dtMs = dtMs;
    out.yaw = yaw;
    out.pitch = pitch;
    out.buttons = this.buttonsMask();
    out.moveX = this.moveX;
    out.moveZ = this.moveZ;
    out.slot = slot;
    return out;
  }

  /**
   * Fill the movement-only view the controller wants. Kept separate from
   * `buildCommand` so prediction can replay a decoded command directly.
   */
  writeMoveInput(
    out: { moveX: number; moveZ: number; yaw: number; pitch: number; jump: boolean; crouch: boolean; sprint: boolean },
    yaw: number, pitch: number,
  ): void {
    out.moveX = this.moveX;
    out.moveZ = this.moveZ;
    out.yaw = yaw;
    out.pitch = pitch;
    out.jump = this.isDown(InputAction.Jump);
    out.crouch = this.crouching;
    out.sprint = this.sprinting;
  }
}

/**
 * Decode a wire `InputCommand` into the controller's `MoveInput` shape. The
 * server calls the equivalent of this, so prediction replay must use it too
 * rather than reading the live keyboard.
 */
export function moveInputFromCommand(
  cmd: InputCommand,
  out: { moveX: number; moveZ: number; yaw: number; pitch: number; jump: boolean; crouch: boolean; sprint: boolean },
): void {
  out.moveX = cmd.moveX;
  out.moveZ = cmd.moveZ;
  out.yaw = cmd.yaw;
  out.pitch = cmd.pitch;
  out.jump = (cmd.buttons & BTN_JUMP) !== 0;
  out.crouch = (cmd.buttons & BTN_CROUCH) !== 0;
  out.sprint = (cmd.buttons & BTN_SPRINT) !== 0;
}
