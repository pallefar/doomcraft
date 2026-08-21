/**
 * DOOMCRAFT — BUILDER, the Minecraft world.
 *
 * Bar: Minecraft Classic, captured live into `ref/mcclassic/` by
 * `tools/capture-mc.mjs`. What that capture actually shows, and what this mode
 * therefore has to answer:
 *
 *   - One world, generated at load, with no name, no list, no save and no way
 *     back to it. There is no world browser in the bar because there are no
 *     worlds — just the one you are in. (`client/src/ui/worldBrowser.ts` and
 *     `server/src/worlds.ts` are the whole of our answer to that.)
 *   - A nine-slot hotbar with a pale outline on the selected cell, no names, no
 *     numbers and no counts (`mc-02-world.png`).
 *   - A "Select block" grid with no search, no categories and no keyboard
 *     (`mc-07-picker.png`).
 *   - A targeting highlight so faint it disappears against grass
 *     (`mc-04-highlight.png`), no dig progress of any kind
 *     (`mc-12-break-hold-*.png` are four identical frames), and no body check
 *     at all — three right-clicks at point blank buried the camera inside solid
 *     stone with no way to tell which way was out (`mc-10-tower.png`).
 *
 * This file is the mode shell: lifecycle, input ownership, the net edits, the
 * session save and the HUD. The feel lives in `placement.ts`, the palette in
 * `inventory.ts`, and the history in `undo.ts`.
 *
 * ## Two variants, one code path
 *
 * `creative` is the bar's game: infinite blocks, instant break, no fall damage
 * worth caring about. `survival` (the "survival-build" variant) turns on finite
 * stacks and hardness-timed digging. They differ by two booleans —
 * `Inventory.creative` and `PlacementController.instantBreak` — because a
 * second implementation of building is a second set of bugs.
 *
 * ## Owning the input
 *
 * `game.ts` has its own crude build path bound to the mouse (`stepEdits`), and
 * it is not this mode's file to change. Rather than double-place every click,
 * the mode *takes the actions*: `InputManager.setActionTaken(action, true)`
 * makes an action read released from every source at once, and the `ModeScope`
 * ledger hands it back on exit. Every button this mode wants is then read from
 * raw DOM events, which is also what makes the repeat cadence in
 * `placement.ts` exact rather than quantised to the 60 Hz fixed step.
 *
 * It used to blank the binding instead. That only ever cleared the PRIMARY
 * layer, and once a control scheme could hang a second key on an action — the
 * arrows move under Modern — a frozen body would have walked around under the
 * detached camera on the arrow keys.
 *
 * ## The free camera, honestly
 *
 * `MODES-API.md` §4.4 fixes the frame order as `registry.update()` ->
 * `game.tick()` -> `registry.render()`, and `Game.render` unconditionally calls
 * `camera.update(dt, driver)` from the predicted body and then `applyTo()`. A
 * mode therefore cannot own the camera for the frame that is about to be drawn
 * by writing to it from `update()`. The one seam that exists is the method
 * itself, so freecam installs a scoped override of `camera.update` that calls
 * the camera's own public `updateFree()` with the flown position, and the
 * ledger puts the original method back on exit.
 *
 * The body does **not** fly: the server owns it, and a client-authoritative fly
 * would be reconciled into the floor within two ticks. So while the camera is
 * detached the body stands still (its movement actions are taken too) and the
 * reach test still runs from the body's eye with the server's exact rule — you
 * can push the camera through a wall and build inside it, and the ghost turns
 * red the moment you drift past what the server would accept. Real flight is a
 * `sim.ts` change (a fly bit in `MoveState` honoured by `moveStep`); the mode
 * already sends `ModeAction.TOGGLE_FLIGHT` so that change would need no client
 * work at all.
 */

import type * as THREE from 'three';

import {
  InputAction,
  PLAYER_EYE_HEIGHT,
  PLAYER_EYE_HEIGHT_CROUCH,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  clamp,
} from '@shared/constants';
import { BlockId, blockName, minimapColor } from '@shared/blocks';
import { BlockAction } from '@shared/protocol';
import { PacketWriter } from '@shared/protocol';
import {
  ModeAction,
  ModeId,
  createModeActionMessage,
  encodeModeAction,
} from '@shared/modes';
import {
  MAX_SAVE_NAME,
  addBuilderWorld,
  findBuilderWorld,
  loadSave,
  recordBuilderSession,
  storeSave,
  type SaveStorage,
} from '@shared/saves';

import type { ModeContext, ModeFactory, ModeInstance } from '@/modes/registry';

import {
  BUILDER_TOOL_POWER,
  BreakProgressRing,
  BuildHighlight,
  Refusal,
  cellOverlapsBody,
  refusalText,
  type BodyProbe,
  type PlacementSink,
  PlacementController,
} from './placement';
import {
  BlockPicker,
  EMPTY_SLOT,
  HOTBAR_SLOTS,
  HotbarView,
  Inventory,
} from './inventory';
import { EditHistory, EditKind } from './undo';

/* ------------------------------------------------------------------------ *
 * Variant
 * ------------------------------------------------------------------------ */

export type BuilderVariant = 'creative' | 'survival';

/** Where the chosen variant is remembered, per world. */
export const VARIANT_KEY_PREFIX = 'doomcraft:builder:variant:';
/** Where the hotbar layout is remembered, per world. */
export const LAYOUT_KEY_PREFIX = 'doomcraft:builder:bar:';

/** Autosave cadence for the local session record. */
export const SESSION_SAVE_MS = 20_000;

/** How fast the detached camera flies, m/s, and the sprint multiplier. */
export const FREECAM_SPEED = 13;
export const FREECAM_SPRINT = 2.6;
/** Hard cap on how far the detached camera may drift from the body, metres. */
export const FREECAM_LEASH = 64;

/* ------------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------------ */

/** The two `Storage` methods this mode needs. Injectable for tests. */
export interface BuilderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BuilderOptions {
  /** Overrides the per-world remembered variant. */
  variant?: BuilderVariant;
  storage?: BuilderStorage | null;
}

function defaultStorage(): BuilderStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

/* ------------------------------------------------------------------------ *
 * Bindings the mode takes over
 * ------------------------------------------------------------------------ */

/**
 * Always taken: the two build buttons, the weapon wheel and the number row.
 * Builder has no weapons, so leaving these live only lets `game.ts` fire a
 * shotgun and place a second block on the same click.
 */
const TAKEN_ALWAYS: readonly InputAction[] = [
  InputAction.Fire, InputAction.AltFire, InputAction.BuildMode,
  InputAction.NextWeapon, InputAction.PrevWeapon,
  InputAction.Reload, InputAction.Melee,
  InputAction.Slot1, InputAction.Slot2, InputAction.Slot3, InputAction.Slot4,
  InputAction.Slot5, InputAction.Slot6, InputAction.Slot7,
];

/** Taken only while the camera is detached, so the body stays put. */
const TAKEN_FREECAM: readonly InputAction[] = [
  InputAction.MoveForward, InputAction.MoveBack,
  InputAction.MoveLeft, InputAction.MoveRight,
  InputAction.Jump, InputAction.Crouch, InputAction.Sprint,
];

/* ------------------------------------------------------------------------ *
 * HUD chrome
 * ------------------------------------------------------------------------ */

const CHROME_STYLE_ID = 'dc-builder-chrome-css';
const CHROME_CSS = `
.dcb-chips{position:absolute;left:50%;top:10px;transform:translateX(-50%);
  display:flex;flex-wrap:wrap;gap:6px;justify-content:center;pointer-events:none;
  font:11px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.dcb-chip{padding:5px 9px;border-radius:12px;background:rgba(8,8,11,.74);
  border:1px solid rgba(255,255,255,.12);color:#c9c4bf;white-space:nowrap}
.dcb-chip b{color:#f0e6da;font-weight:620}
.dcb-chip.hot{border-color:rgba(240,160,32,.6);color:#f0c98a}
.dcb-hint{position:absolute;left:50%;top:calc(50% + 34px);transform:translateX(-50%);
  padding:4px 10px;border-radius:3px;background:rgba(24,6,4,.82);color:#ffb9a6;
  border:1px solid rgba(224,60,28,.5);white-space:nowrap;pointer-events:none;
  font:12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  opacity:0;transition:opacity 110ms linear}
.dcb-hint.on{opacity:1}
.dcb-toast{position:absolute;left:50%;top:calc(50% - 74px);transform:translateX(-50%);
  padding:5px 12px;border-radius:3px;background:rgba(8,8,11,.82);color:#e8e6e3;
  border:1px solid rgba(255,255,255,.14);white-space:nowrap;pointer-events:none;
  font:12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  opacity:0;transition:opacity 130ms linear}
.dcb-toast.on{opacity:1}
`;

/**
 * Refcounted, not fire-and-forget. A mode's teardown has to be the exact
 * inverse of its setup — `tools/mode-loop.mjs` counts `<style>` tags before and
 * after and a stylesheet that outlives its mode shows up there as a leak, even
 * though it is only a kilobyte. Refcounting (rather than a plain remove) keeps
 * two Builder sessions in one page from pulling the sheet out from under each
 * other.
 */
let chromeUsers = 0;

function acquireChrome(): void {
  if (typeof document === 'undefined') return;
  chromeUsers++;
  if (document.getElementById(CHROME_STYLE_ID) !== null) return;
  const st = document.createElement('style');
  st.id = CHROME_STYLE_ID;
  st.textContent = CHROME_CSS;
  document.head.appendChild(st);
}

function releaseChrome(): void {
  if (typeof document === 'undefined') return;
  chromeUsers = Math.max(0, chromeUsers - 1);
  if (chromeUsers > 0) return;
  document.getElementById(CHROME_STYLE_ID)?.remove();
}

/* ------------------------------------------------------------------------ *
 * The mode
 * ------------------------------------------------------------------------ */

export interface BuilderStats {
  variant: BuilderVariant;
  placed: number;
  broken: number;
  undoDepth: number;
  redoDepth: number;
  freecam: boolean;
  worldId: string;
  shareCode: string;
}

/**
 * Build the Builder. Exported separately from the `ModeFactory` so tests and
 * the shell can pass options without going through the registry.
 */
export function createBuilderMode(ctx: ModeContext, options: BuilderOptions = {}): ModeInstance {
  const { host, scope, params } = ctx;
  const game = host.game;
  const net = game.net;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;

  acquireChrome();
  scope.add(() => { releaseChrome(); });

  /* --- variant ------------------------------------------------------- */
  const worldKey = params.worldId === '' ? 'local' : params.worldId;
  let variant: BuilderVariant = options.variant ?? readVariant(storage, worldKey);

  /* --- state --------------------------------------------------------- */
  const inventory = new Inventory(variant === 'creative');
  inventory.fromLayout(readLayout(storage, worldKey));
  if (variant === 'survival') inventory.grantStarterKit();

  const history = new EditHistory();
  let replaying = false;
  let placedThisSession = 0;
  let brokenThisSession = 0;
  const touchedChunks = new Set<number>();
  const enteredAtMs = nowMs();

  let shareCode = '';
  let worldTitle = params.worldId === '' ? 'Local World' : params.worldId;
  let authoritativePlaced = 0;
  /** The save-file world this session is being written into. */
  let recordWorldId = params.worldId;

  /* --- freecam ------------------------------------------------------- */
  let freecam = false;
  let freeX = 0, freeY = 0, freeZ = 0;
  let freeInit = false;
  let cameraPatched = false;

  /* --- raw input ------------------------------------------------------ */
  const held = new Set<string>();
  let wantBreak = false;
  let wantPlace = false;

  /* --- bodies --------------------------------------------------------- */
  const bodies: BodyProbe = {
    occupied(x: number, y: number, z: number): boolean {
      // The local player first: it is the one you are about to entomb, and it
      // is the only body whose exact height we know (crouch changes it).
      const h = net.predicted.crouching ? net.predicted.height : PLAYER_HEIGHT;
      if (cellOverlapsBody(x, y, z, net.renderPos[0], net.renderPos[1], net.renderPos[2], PLAYER_HALF_WIDTH, h)) {
        return true;
      }
      const list = net.players;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p.active || p.isLocal) continue;
        // Remote heights are not on the wire, so assume the tall one. Being
        // conservative can only ever refuse an edit the server would have
        // allowed; the other way round costs a visible prediction rollback.
        if (cellOverlapsBody(x, y, z, p.x, p.y, p.z, PLAYER_HALF_WIDTH, PLAYER_HEIGHT)) return true;
      }
      return false;
    },
  };

  /* --- DOM ------------------------------------------------------------ */
  const chips = document.createElement('div');
  chips.className = 'dcb-chips';
  const chipWorld = chip(chips);
  const chipMode = chip(chips);
  const chipBlocks = chip(chips);
  const chipHistory = chip(chips);
  host.hudRoot.appendChild(chips);
  scope.addElement(chips);

  const hint = document.createElement('div');
  hint.className = 'dcb-hint';
  host.hudRoot.appendChild(hint);
  scope.addElement(hint);

  const toast = document.createElement('div');
  toast.className = 'dcb-toast';
  host.hudRoot.appendChild(toast);
  scope.addElement(toast);
  let toastUntil = 0;

  const hotbar = new HotbarView(host.hudRoot);
  scope.add(() => hotbar.dispose());

  const ring = new BreakProgressRing(host.hudRoot);
  scope.add(() => ring.dispose());

  const highlight = new BuildHighlight();
  scope.add(() => highlight.dispose());
  scope.addObject3D(highlight.group as unknown as THREE.Object3D, game.renderer.scene);

  const picker = new BlockPicker({
    root: host.uiRoot,
    inventory,
    onAssign: (slot, id) => {
      showToast(`Slot ${slot + 1}: ${blockName(id)}`);
      saveLayout();
    },
    onClose: () => {
      wantBreak = false;
      wantPlace = false;
      held.clear();
      host.suppressAutoPause?.(false);
      if (game.playing) game.input.requestPointerLock();
    },
  });
  scope.add(() => picker.dispose());

  /* --- the edit sink -------------------------------------------------- */
  const sink: PlacementSink = {
    breakBlock(x: number, y: number, z: number, blockId: number): boolean {
      const prev = net.world.getBlock(x, y, z);
      if (prev === BlockId.AIR) return false;
      if (!net.requestEdit(BlockAction.BREAK, x, y, z, 0)) return false;
      game.chunks.setBlock(x, y, z, BlockId.AIR);
      game.fx.blockBreak(x, y, z, prev);
      game.camera.addShake(0.014, 55, 24);
      if (!replaying) {
        history.begin(EditKind.BREAK, nowMs());
        history.record(x, y, z, prev, BlockId.AIR);
        history.commit();
        inventory.give(prev, 1);
        brokenThisSession++;
      }
      touchedChunks.add(chunkOf(x, z));
      void blockId;
      return true;
    },

    placeBlock(x: number, y: number, z: number, blockId: number): boolean {
      const prev = net.world.getBlock(x, y, z);
      if (!replaying && !inventory.has(blockId)) return false;
      if (!net.requestEdit(BlockAction.PLACE, x, y, z, blockId)) return false;
      game.chunks.setBlock(x, y, z, blockId);
      game.fx.impact(x + 0.5, y + 0.5, z + 0.5, 0, 1, 0, minimapColor(blockId), 0.35);
      if (!replaying) {
        history.begin(EditKind.PLACE, nowMs());
        history.record(x, y, z, prev, blockId);
        history.commit();
        inventory.take(blockId);
        placedThisSession++;
      }
      touchedChunks.add(chunkOf(x, z));
      return true;
    },

    digStage(x: number, y: number, z: number, blockId: number, stage: number): void {
      if (stage < 0) return;
      // A chip of the block's own colour every tenth of the dig — the thing
      // the bar has none of, and the cheapest possible version of it.
      game.fx.impact(x + 0.5, y + 0.5, z + 0.5, 0, 1, 0, minimapColor(blockId), 0.22);
    },
  };

  const placement = new PlacementController({
    getBlock: (x, y, z) => net.world.getBlock(x, y, z),
    bodies,
    sink,
    instantBreak: variant === 'creative',
    toolPower: BUILDER_TOOL_POWER,
  });

  /* --- helpers -------------------------------------------------------- */

  function nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function chip(parent: HTMLElement): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = 'dcb-chip';
    parent.appendChild(el);
    return el;
  }

  function chunkOf(x: number, z: number): number {
    return ((x >> 5) + 512) * 1024 + ((z >> 5) + 512);
  }

  function showToast(text: string): void {
    toast.textContent = text;
    toast.classList.add('on');
    toastUntil = nowMs() + 1500;
  }

  function saveLayout(): void {
    if (storage === null) return;
    try { storage.setItem(LAYOUT_KEY_PREFIX + worldKey, JSON.stringify(inventory.toLayout())); } catch { /* private mode */ }
  }

  function sendAction(action: ModeAction, a = 0, b = 0): void {
    const bytes = encodeAction(action, a, b);
    if (bytes !== null) host.send(bytes);
  }

  /* --- undo / redo ----------------------------------------------------- */

  function applyReverse(x: number, y: number, z: number, id: number, from: number): void {
    const current = net.world.getBlock(x, y, z);
    // Somebody else has since changed this cell. Their edit is newer and it is
    // not ours to stamp over, so skip it and keep the rest of the group.
    if (current !== from && current !== id) return;
    if (current === id) return;
    replaying = true;
    if (id === BlockId.AIR) sink.breakBlock(x, y, z, current);
    else sink.placeBlock(x, y, z, id);
    replaying = false;
  }

  function doUndo(): void {
    const label = history.undoLabel();
    const n = history.undo(applyReverse);
    if (n === 0) { showToast('Nothing to undo'); return; }
    sendAction(ModeAction.UNDO, n);
    showToast(`Undo ${label}`);
  }

  function doRedo(): void {
    const label = history.redoLabel();
    const n = history.redo(applyReverse);
    if (n === 0) { showToast('Nothing to redo'); return; }
    sendAction(ModeAction.REDO, n);
    showToast(`Redo ${label}`);
  }

  /* --- binding takeover ------------------------------------------------ */

  /**
   * Taken through `setActionTaken`, not by blanking the binding.
   *
   * Blanking only ever cleared the PRIMARY layer, and since a control scheme
   * gives actions a second key — the arrows move under Modern — a freecam that
   * blanked WASD would still have let the arrows walk the body around under the
   * detached camera. The mask switches the action off at every source: both key
   * layers, the pad and the touch buttons.
   */
  const heldTaken = new Set<InputAction>();
  function take(actions: readonly InputAction[]): void {
    for (const a of actions) {
      if (heldTaken.has(a)) continue;
      heldTaken.add(a);
      game.input.setActionTaken(a, true);
    }
  }
  function give(actions: readonly InputAction[]): void {
    for (const a of actions) {
      if (!heldTaken.delete(a)) continue;
      game.input.setActionTaken(a, false);
    }
  }

  /* --- freecam --------------------------------------------------------- */

  function setFreecam(on: boolean): void {
    if (freecam === on) return;
    freecam = on;
    placement.cancelDig();
    if (on) {
      freeX = net.renderPos[0];
      freeY = net.renderPos[1] + eyeHeight();
      freeZ = net.renderPos[2];
      freeInit = true;
      take(TAKEN_FREECAM);
      game.input.releaseAll();
      patchCamera();
      showToast('No-clip camera ON — WASD flies, Space/Shift up-down, F to land');
    } else {
      give(TAKEN_FREECAM);
      unpatchCamera();
      showToast('No-clip camera off');
    }
    sendAction(ModeAction.TOGGLE_FLIGHT, on ? 1 : 0);
  }

  function eyeHeight(): number {
    return net.predicted.crouching ? PLAYER_EYE_HEIGHT_CROUCH : PLAYER_EYE_HEIGHT;
  }

  type CameraUpdate = (dt: number, driver: unknown) => void;
  let originalCameraUpdate: CameraUpdate | null = null;

  function patchCamera(): void {
    if (cameraPatched) return;
    const cam = game.camera as unknown as { update: CameraUpdate; updateFree(dt: number, x: number, y: number, z: number): void };
    originalCameraUpdate = cam.update;
    cam.update = (dt: number, driver: unknown): void => {
      if (!freecam) { originalCameraUpdate?.call(cam, dt, driver); return; }
      cam.updateFree(dt, freeX, freeY, freeZ);
    };
    cameraPatched = true;
  }

  function unpatchCamera(): void {
    if (!cameraPatched) return;
    const cam = game.camera as unknown as { update: CameraUpdate };
    if (originalCameraUpdate !== null) cam.update = originalCameraUpdate;
    originalCameraUpdate = null;
    cameraPatched = false;
  }

  function flyCamera(dt: number): void {
    if (!freeInit) {
      freeX = net.renderPos[0];
      freeY = net.renderPos[1] + eyeHeight();
      freeZ = net.renderPos[2];
      freeInit = true;
    }
    const cam = game.camera;
    let f = 0, s = 0, u = 0;
    if (held.has('KeyW')) f += 1;
    if (held.has('KeyS')) f -= 1;
    if (held.has('KeyD')) s += 1;
    if (held.has('KeyA')) s -= 1;
    if (held.has('Space')) u += 1;
    if (held.has('KeyC') || held.has('ControlLeft')) u -= 1;
    if (f === 0 && s === 0 && u === 0) return;

    const speed = FREECAM_SPEED * (held.has('ShiftLeft') ? FREECAM_SPRINT : 1) * dt;
    freeX += (cam.forward[0] * f + cam.right[0] * s) * speed;
    freeY += (cam.forward[1] * f) * speed + u * speed;
    freeZ += (cam.forward[2] * f + cam.right[2] * s) * speed;

    // Leash it to the body. Not a gameplay rule — a guard against flying to the
    // edge of the world and streaming 169 chunks nobody asked for.
    const bx = net.renderPos[0], by = net.renderPos[1] + eyeHeight(), bz = net.renderPos[2];
    const dx = freeX - bx, dy = freeY - by, dz = freeZ - bz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > FREECAM_LEASH) {
      const k = FREECAM_LEASH / d;
      freeX = bx + dx * k;
      freeY = by + dy * k;
      freeZ = bz + dz * k;
    }
    freeY = clamp(freeY, 1, 120);
  }

  /* --- event handlers --------------------------------------------------- */

  function onPointerDown(ev: Event): void {
    const e = ev as MouseEvent;
    if (picker.isOpen) return;
    if (!game.playing) return;
    if (e.button === 0) { wantBreak = true; e.preventDefault(); }
    else if (e.button === 2) { wantPlace = true; e.preventDefault(); }
    else if (e.button === 1) {
      e.preventDefault();
      const t = placement.target;
      if (t.hit && inventory.pick(t.blockId)) {
        showToast(`Picked ${blockName(t.blockId)}`);
        saveLayout();
      }
    }
  }

  function onPointerUp(ev: Event): void {
    const e = ev as MouseEvent;
    if (e.button === 0) wantBreak = false;
    else if (e.button === 2) wantPlace = false;
  }

  function onWheel(ev: Event): void {
    if (picker.isOpen || !game.playing) return;
    const e = ev as WheelEvent;
    if (e.deltaY === 0) return;
    e.preventDefault();
    inventory.cycle(e.deltaY > 0 ? 1 : -1);
  }

  function onKeyDown(ev: Event): void {
    const e = ev as KeyboardEvent;
    if (e.repeat) { held.add(e.code); return; }
    held.add(e.code);
    if (picker.isOpen) return;

    if (e.code >= 'Digit1' && e.code <= 'Digit9') {
      inventory.select(Number(e.code.slice(5)) - 1);
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'KeyB':
      case 'KeyE':
        e.preventDefault();
        wantBreak = false; wantPlace = false;
        // Releasing the lock here is deliberate — tell the shell before it
        // happens or it pauses the game behind the palette.
        host.suppressAutoPause?.(true);
        game.input.exitPointerLock();
        picker.show();
        break;
      case 'KeyF':
        e.preventDefault();
        setFreecam(!freecam);
        break;
      case 'KeyZ':
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        break;
      case 'KeyY':
        e.preventDefault();
        doRedo();
        break;
      case 'KeyG':
        e.preventDefault();
        setVariant(variant === 'creative' ? 'survival' : 'creative');
        break;
      default:
        break;
    }
  }

  function onKeyUp(ev: Event): void {
    held.delete((ev as KeyboardEvent).code);
  }

  function onBlur(): void {
    held.clear();
    wantBreak = false;
    wantPlace = false;
    placement.cancelDig();
  }

  function setVariant(v: BuilderVariant): void {
    if (variant === v) return;
    variant = v;
    inventory.setCreative(v === 'creative');
    placement.instantBreak = v === 'creative';
    if (storage !== null) {
      try { storage.setItem(VARIANT_KEY_PREFIX + worldKey, v); } catch { /* private mode */ }
    }
    showToast(v === 'creative' ? 'Creative — infinite blocks, instant break' : 'Survival build — stacks and dig times');
  }

  /* --- HUD refresh (cold; only on change) -------------------------------- */

  let lastHint = -1;
  let lastPlaced = -1;
  let lastHistory = -1;
  let lastModeLabel = '';

  function refreshChips(): void {
    const placedShown = Math.max(placedThisSession, authoritativePlaced);
    if (placedShown !== lastPlaced) {
      lastPlaced = placedShown;
      chipBlocks.innerHTML = `<b>${placedShown}</b> placed · <b>${brokenThisSession}</b> broken`;
    }
    const hkey = history.groupCount * 1000 + (history.canUndo ? 1 : 0) * 100 + (history.canRedo ? 1 : 0);
    if (hkey !== lastHistory) {
      lastHistory = hkey;
      const s = history.stats();
      chipHistory.innerHTML = `Undo <b>${s.undoDepth}</b> · Redo <b>${s.redoDepth}</b>`;
    }
    const label = `${variant === 'creative' ? 'Creative' : 'Survival build'}${freecam ? ' · no-clip' : ''}`;
    if (label !== lastModeLabel) {
      lastModeLabel = label;
      chipMode.textContent = label;
      chipMode.classList.toggle('hot', freecam);
    }
  }

  function refreshWorldChip(): void {
    chipWorld.innerHTML = shareCode === ''
      ? `<b>${escapeHtml(worldTitle)}</b>`
      : `<b>${escapeHtml(worldTitle)}</b> · code <b>${escapeHtml(shareCode.toUpperCase())}</b>`;
  }

  function refreshHint(): void {
    const t = placement.target;
    // Show the reason the *pressed* button is refusing; when nothing is pressed
    // show the placement reason, because that is the one that surprises people.
    let r: Refusal = Refusal.NONE;
    if (wantBreak) r = t.breakRefusal;
    else if (wantPlace || t.hit) r = t.placeRefusal;
    if (r === Refusal.NO_TARGET) r = Refusal.NONE;
    if (r === lastHint) return;
    lastHint = r;
    if (r === Refusal.NONE) {
      hint.classList.remove('on');
      return;
    }
    hint.textContent = refusalText(r);
    hint.classList.add('on');
  }

  /* --- lifecycle --------------------------------------------------------- */

  const instance: ModeInstance = {
    id: ModeId.BUILDER,

    enter(): void {
      take(TAKEN_ALWAYS);
      scope.add(() => { give(TAKEN_ALWAYS); give(TAKEN_FREECAM); });

      // No gun in a building game. Removing the overlay pass is cheaper than
      // hiding it and cannot be re-enabled behind our back by game.render().
      game.renderer.removeOverlay(game.viewmodel);
      scope.add(() => { game.renderer.addOverlay(game.viewmodel); });

      // `game.ts` rewrites `hudState.owned` from the weapon runtime every
      // frame, so zeroing it here lasts exactly one frame. Hide the gun half of
      // the HUD outright instead — ammo readout and seven-slot hotbar both.
      const ownedBefore = game.hudState.owned;
      game.hudState.owned = 0;
      game.hud.setWeaponUiVisible(false);
      scope.add(() => {
        game.hudState.owned = ownedBefore;
        game.hud.setWeaponUiVisible(true);
      });

      scope.add(() => { unpatchCamera(); });
      scope.add(() => { host.suppressAutoPause?.(false); });

      const canvas = host.canvas;
      scope.addListener(canvas, 'pointerdown', onPointerDown as EventListener);
      scope.addListener(window, 'pointerup', onPointerUp as EventListener);
      scope.addListener(canvas, 'wheel', onWheel as EventListener, { passive: false });
      scope.addListener(window, 'keydown', onKeyDown as EventListener);
      scope.addListener(window, 'keyup', onKeyUp as EventListener);
      scope.addListener(window, 'blur', onBlur as EventListener);

      scope.addInterval(() => { flushSession(); }, SESSION_SAVE_MS);
      scope.add(() => { flushSession(); });

      refreshWorldChip();
      refreshChips();
      host.setStatus('');
      game.hud.pushFeed('Builder — LMB break, RMB place, B palette, Z undo, F no-clip camera', 's');
    },

    update(dt: number, now: number): void {
      const dtMs = dt * 1000;

      if (freecam) flyCamera(dt);

      const eyeY = net.renderPos[1] + eyeHeight();
      const aim = placement.aim;
      aim.eyeX = net.renderPos[0];
      aim.eyeY = eyeY;
      aim.eyeZ = net.renderPos[2];
      if (freecam) {
        aim.originX = freeX; aim.originY = freeY; aim.originZ = freeZ;
      } else {
        aim.originX = aim.eyeX; aim.originY = eyeY; aim.originZ = aim.eyeZ;
      }
      const f = game.camera.forward;
      aim.dirX = f[0]; aim.dirY = f[1]; aim.dirZ = f[2];
      aim.heldBlock = inventory.selectedBlock;
      aim.mayEdit = true;
      aim.hasStock = inventory.has(inventory.selectedBlock);

      placement.retarget();

      const active = game.playing && !picker.isOpen && !net.local.dead;
      placement.update(dtMs, active && wantBreak, active && wantPlace);

      highlight.sync(
        placement.target,
        placement.digProgress,
        active && placement.target.hit && aim.heldBlock !== EMPTY_SLOT,
        aim.heldBlock,
      );
      ring.set(placement.digProgress);
      hotbar.sync(inventory, now);
      refreshChips();
      refreshHint();

      if (toastUntil !== 0 && now > toastUntil) {
        toastUntil = 0;
        toast.classList.remove('on');
      }
    },

    onPause(paused: boolean): void {
      if (!paused) return;
      onBlur();
      if (picker.isOpen) picker.close();
    },

    onModeState(state): void {
      authoritativePlaced = state.score;
    },

    onModeContext(context): void {
      if (context.title !== '') worldTitle = context.title;
      if (context.worldId !== '') shareCode = context.worldId;
      refreshWorldChip();
    },

    onModeEvent(event): void {
      if (event.text !== '') showToast(event.text);
    },

    onAction(action): boolean {
      switch (action) {
        case ModeAction.UNDO: doUndo(); return true;
        case ModeAction.REDO: doRedo(); return true;
        case ModeAction.TOGGLE_FLIGHT: setFreecam(!freecam); return true;
        default: return false;
      }
    },

    exit(): void {
      onBlur();
      if (picker.isOpen) picker.close();
      unpatchCamera();
      saveLayout();
      flushSession();
    },
  };

  /* --- session persistence ------------------------------------------------ */

  let lastFlushPlaced = 0;
  let lastFlushBroken = 0;
  let lastFlushMs = enteredAtMs;

  function flushSession(): void {
    if (storage === null) return;
    const dPlaced = placedThisSession - lastFlushPlaced;
    const dBroken = brokenThisSession - lastFlushBroken;
    const t = nowMs();
    const seconds = Math.max(0, (t - lastFlushMs) / 1000);
    if (dPlaced === 0 && dBroken === 0 && seconds < 1) return;
    lastFlushPlaced = placedThisSession;
    lastFlushBroken = brokenThisSession;
    lastFlushMs = t;
    recordWorldId = writeSession(storage, recordWorldId, {
      seconds,
      placed: dPlaced,
      broken: dBroken,
      chunks: touchedChunks.size,
      shareCode,
      name: worldTitle,
      seed: params.seed,
    });
  }

  /** Live counters, for the pause screen and for tests. */
  (instance as ModeInstance & { stats(): BuilderStats }).stats = (): BuilderStats => ({
    variant,
    placed: placedThisSession,
    broken: brokenThisSession,
    undoDepth: history.stats().undoDepth,
    redoDepth: history.stats().redoDepth,
    freecam,
    worldId: params.worldId,
    shareCode,
  });

  return instance;
}

/** The `ModeFactory` the shell registers for `ModeId.BUILDER`. */
export const builderMode: ModeFactory = (ctx) => createBuilderMode(ctx);

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

/**
 * One reused writer and one reused message: a mode action is a 14-byte packet
 * and there is no reason for it to allocate two objects every time.
 */
const actionWriter = new PacketWriter(32);
const actionMessage = createModeActionMessage();
let actionSeq = 0;

function encodeAction(action: ModeAction, a: number, b: number): Uint8Array | null {
  actionMessage.action = action;
  actionMessage.a = a;
  actionMessage.b = b;
  actionMessage.x = 0;
  actionMessage.y = 0;
  actionMessage.z = 0;
  actionMessage.seq = ++actionSeq;
  encodeModeAction(actionWriter, actionMessage);
  return actionWriter.copy();
}

/** What one autosave slice adds to the stored world record. */
interface SessionDelta {
  seconds: number;
  placed: number;
  broken: number;
  chunks: number;
  shareCode: string;
  name: string;
  seed: number;
}

/**
 * Fold a slice of this session into the local save and return the world id it
 * landed on — which may differ from the one passed in the first time, because
 * joining a friend's world by code means the browser has never seen it before
 * and has to make a row for it.
 *
 * Deltas rather than totals: two tabs on the same world then add up instead of
 * the second one clobbering the first.
 */
function writeSession(storage: SaveStorage, worldId: string, d: SessionDelta): string {
  const now = Date.now();
  const save = loadSave(storage, now);
  let world = worldId === '' ? null : findBuilderWorld(save, worldId);
  if (world === null) {
    world = addBuilderWorld(save, d.name === '' ? 'New World' : d.name, d.seed, now);
    if (worldId !== '') world.id = worldId;
  }
  save.builder.activeWorldId = world.id;
  recordBuilderSession(save, {
    worldId: world.id,
    secondsPlayed: d.seconds,
    blocksPlaced: d.placed,
    blocksBroken: d.broken,
    editedChunks: d.chunks,
  }, now);
  if (d.shareCode !== '') { world.shareCode = d.shareCode; world.online = true; }
  if (d.name !== '') world.name = d.name.slice(0, MAX_SAVE_NAME);
  world.swatch = worldSwatch(world.id, world.seed);
  storeSave(storage, save, now);
  return world.id;
}

/** Blocks the world-list swatch is drawn from. Chosen to be separable at 26 px. */
const SWATCH_BLOCKS: readonly number[] = [
  BlockId.GRASS, BlockId.SAND, BlockId.BRICK, BlockId.TECH_PANEL, BlockId.NEON,
  BlockId.OBSIDIAN, BlockId.ICE, BlockId.HELLSTONE, BlockId.PLANKS, BlockId.METAL,
];

/**
 * A stable colour per world.
 *
 * This used to be `minimapColor(GRASS)` for every world, which rendered the
 * world browser's swatch column as five identical green squares — a decoration
 * carrying zero bits. Found by rendering the list and looking at it, not by any
 * test, because nothing about "all rows the same colour" is incorrect.
 *
 * FNV-1a over the id (falling back to the seed for a world that has not been
 * named yet) so the colour is stable across sessions and across devices: your
 * cathedral is the same obsidian square on your phone as on your desktop.
 */
export function worldSwatch(id: string, seed: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = (h ^ (seed >>> 0)) >>> 0;
  return minimapColor(SWATCH_BLOCKS[h % SWATCH_BLOCKS.length]);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

function readVariant(storage: BuilderStorage | null, worldKey: string): BuilderVariant {
  if (storage === null) return 'creative';
  let v: string | null = null;
  try { v = storage.getItem(VARIANT_KEY_PREFIX + worldKey); } catch { v = null; }
  return v === 'survival' ? 'survival' : 'creative';
}

function readLayout(storage: BuilderStorage | null, worldKey: string): number[] | null {
  if (storage === null) return null;
  let raw: string | null = null;
  try { raw = storage.getItem(LAYOUT_KEY_PREFIX + worldKey); } catch { raw = null; }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out = new Array<number>(HOTBAR_SLOTS);
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const v = parsed[i];
      out[i] = typeof v === 'number' ? v : EMPTY_SLOT;
    }
    return out;
  } catch { return null; }
}
