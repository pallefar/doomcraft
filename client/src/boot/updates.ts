/**
 * DOOMCRAFT — client delivery. One rule governs this file:
 *
 *   > **Never activate a new bundle while `game.playing === true`.**
 *
 * `docs/INFRASTRUCTURE.md` §6, "Client delivery: reload without the player
 * noticing". A deploy must not swap the bundle under a player mid-match, and
 * the only way to guarantee that is for the page — which is the only thing that
 * knows whether a match is running — to own activation.
 *
 * So `self.skipWaiting()` is **banned inside the service worker**. The worker
 * installs, precaches nothing it was not asked for, and then sits in `waiting`
 * indefinitely. It activates when, and only when, this page posts
 * `DC_SKIP_WAITING` to it, which happens at the next moment the player is not
 * in a match. `client/public/sw.js` states the same rule from the other side,
 * and `client/src/boot/updates.test.ts` fails if either half drifts.
 *
 * ## The four cases this has to get right
 *
 * 1. **Update lands mid-match.** Hold it. Swap at return-to-menu, in the
 *    "Restarting to update" beat, which is under 300 ms warm because every
 *    hashed asset is already in the cache.
 * 2. **TWO updates land during one long match.** The browser replaces the
 *    waiting worker when a newer one installs, so any reference this file kept
 *    to the first one is dead. `UpdateController` therefore stores no worker
 *    reference at all — only the fact that something is pending — and re-reads
 *    `registration.waiting` at the instant it swaps. That is the actual bug
 *    this class exists to avoid, and it has its own test.
 * 3. **First ever visit.** With no controller, a new worker activates
 *    immediately: `controllerchange` fires with nobody having asked for it.
 *    Reloading there would make every first visit flash. So a reload happens
 *    only when THIS page asked for the swap.
 * 4. **Protocol-breaking release.** The server refuses the connection with
 *    `UpdateReason.PROTOCOL_TOO_OLD` and the tab genuinely cannot play online
 *    until it reloads. Even then the rule holds: the swap waits for the player
 *    to be out of a match. It just does not ask permission when it gets there —
 *    a forced update takes the "later" button away, not the safety.
 */

import { UpdateReason, requiresClientReload } from '@shared/version';

/* ------------------------------------------------------------------------ *
 * The seams
 *
 * Everything the controller touches is an interface, because the whole point is
 * to test the policy — including "two deploys across one match" — under vitest's
 * node environment, where there is no `navigator.serviceWorker` to drive.
 * ------------------------------------------------------------------------ */

/** The bit of a `ServiceWorker` this file uses. */
export interface WorkerLike {
  postMessage(message: unknown): void;
}

/** The bit of a `ServiceWorkerRegistration` this file uses. */
export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  update(): Promise<unknown>;
}

export interface UpdateHost {
  /** True while the player is IN a match. The one input that matters. */
  isPlaying(): boolean;
  /** Reload the page. Called at most once per controller change. */
  reload(): void;
  /** Wall clock, ms. */
  now(): number;
  /**
   * True when this page was already under a service worker at boot. When it was
   * not, an activation is a first install and must never trigger a reload.
   */
  hadController(): boolean;
  /** Told when the visible state changes, so the shell can draw the prompt. */
  onState?(state: UpdateSnapshot): void;
}

export type UpdateState =
  /** Nothing waiting. */
  | 'idle'
  /** A check is in flight. */
  | 'checking'
  /** A new build is installed and waiting, and the player is free to take it. */
  | 'ready'
  /** A new build is waiting, but the player is in a match. Hold. */
  | 'held'
  /** We asked the waiting worker to take over; the reload is coming. */
  | 'swapping';

export interface UpdateSnapshot {
  state: UpdateState;
  /** True when this update cannot be declined — a protocol-breaking release. */
  forced: boolean;
  /** Why it is forced, if it is. */
  reason: UpdateReason;
}

/**
 * How often the page looks for a new build while the player is in the menu.
 *
 * Only while in the menu. A check during a match would have the browser install
 * and precache a new bundle on the same connection and CPU the match is using,
 * to no purpose whatsoever, because the result could not be applied until the
 * match ended anyway.
 */
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;

/** The message the page posts to the waiting worker. The ONLY way it activates. */
export const SKIP_WAITING_MESSAGE = 'DC_SKIP_WAITING';

/* ------------------------------------------------------------------------ *
 * The controller
 * ------------------------------------------------------------------------ */

export class UpdateController {
  private readonly host: UpdateHost;
  private registration: RegistrationLike | null = null;
  /**
   * A new build is installed and waiting. Deliberately a BOOLEAN and not a
   * worker reference — see case 2 in the header comment.
   */
  private pending = false;
  private forced = false;
  private reason: UpdateReason = UpdateReason.NONE;
  private swapRequested = false;
  private reloaded = false;
  private lastCheckMs = -Number.MAX_SAFE_INTEGER;
  private checking = false;

  /** Swaps performed. Asserted by tests; it must be exactly one per update. */
  swaps = 0;
  /** Reloads performed. Must never exceed one. */
  reloads = 0;

  constructor(host: UpdateHost) {
    this.host = host;
  }

  attach(registration: RegistrationLike): void {
    this.registration = registration;
    // A worker may already be waiting from a previous visit — the update landed
    // while the tab was closed, so there was never an `updatefound` to hear.
    if (registration.waiting !== null) this.noteUpdateReady();
    else this.emit();
  }

  get snapshot(): UpdateSnapshot {
    return { state: this.state(), forced: this.forced, reason: this.reason };
  }

  private state(): UpdateState {
    if (this.swapRequested) return 'swapping';
    if (this.pending) return this.host.isPlaying() ? 'held' : 'ready';
    return this.checking ? 'checking' : 'idle';
  }

  /** A new build finished installing and is now waiting. */
  noteUpdateReady(): void {
    this.checking = false;
    // Already pending: this is the SECOND deploy inside one match. Nothing to
    // update except the clock — the pending flag already means "whatever is in
    // `registration.waiting` right now", which is the newer worker.
    this.pending = true;
    this.pump();
  }

  /**
   * The server refused this client because its bytes are too old. The update
   * stops being optional.
   *
   * It does NOT stop being safe: `pump()` still refuses to swap during a match.
   * A player mid-match on a build the server will not talk to is playing single
   * player, and taking that away from them to fix a multiplayer connection they
   * are not currently using would be strictly worse than waiting.
   */
  requireUpdate(reason: UpdateReason): void {
    if (!requiresClientReload(reason)) return;
    this.forced = true;
    this.reason = reason;
    this.pump();
  }

  /**
   * Re-evaluate. Call it whenever the answer to `isPlaying()` may have changed
   * — return-to-menu above all — and on a timer.
   *
   * A forced update applies itself here. An ordinary one only advertises
   * itself, and waits for `applyNow()`, because a player who has just walked
   * out of a match into the menu has not agreed to lose the page yet.
   */
  pump(): void {
    if (this.pending && this.forced && !this.host.isPlaying()) {
      this.applyNow();
      return;
    }
    this.emit();
  }

  /**
   * Take the waiting build. The user pressed "Restart to update", or a forced
   * update reached a safe moment.
   *
   * Returns true when the swap was actually requested. Refusing while playing
   * is not an error and not a queue: `pump()` will come back to it.
   */
  applyNow(): boolean {
    if (!this.pending || this.swapRequested) return false;
    /* THE RULE. Everything else in this file is plumbing around this line. */
    if (this.host.isPlaying()) { this.emit(); return false; }

    // Re-read at the instant of the swap. Two deploys during one match leave a
    // NEWER worker in `waiting` than the one that was there when `pending` was
    // first set, and a reference captured back then points at a worker the
    // browser has already discarded.
    const worker = this.registration?.waiting ?? null;
    if (worker === null) {
      // Installed, then gone: the browser dropped it, or another tab took it.
      // Not an error — go back to idle and let the next check find it again.
      this.pending = false;
      this.emit();
      return false;
    }

    this.swapRequested = true;
    this.swaps++;
    worker.postMessage({ type: SKIP_WAITING_MESSAGE });
    this.emit();
    return true;
  }

  /**
   * `navigator.serviceWorker.controller` changed: the new build is in charge.
   *
   * Reload only if THIS page asked for it. A first install activates with no
   * controller and no request, and reloading there would flash every first
   * visit for nothing.
   */
  onControllerChange(): void {
    if (this.reloaded) return;
    if (!this.swapRequested) return;
    if (!this.host.hadController()) return;
    this.reloaded = true;
    this.reloads++;
    this.host.reload();
  }

  /**
   * Ask the browser to look for a new build. Never during a match: installing
   * a bundle costs the same connection and CPU the match is using, and the
   * result could not be applied until the match ended anyway.
   */
  async check(force = false): Promise<void> {
    const reg = this.registration;
    if (reg === null || this.swapRequested) return;
    if (this.host.isPlaying()) return;
    const now = this.host.now();
    if (!force && now - this.lastCheckMs < UPDATE_CHECK_INTERVAL_MS) return;
    this.lastCheckMs = now;
    this.checking = true;
    this.emit();
    try {
      await reg.update();
    } catch {
      // Offline, or the server is down. Neither is a problem: the game runs
      // entirely client-side, and the check comes round again.
    }
    this.checking = false;
    // `updatefound` reports a NEW install; a worker that was already waiting
    // before this check does not fire it again, so look directly as well.
    if (reg.waiting !== null) this.noteUpdateReady();
    else this.emit();
  }

  private emit(): void {
    this.host.onState?.(this.snapshot);
  }
}

/* ------------------------------------------------------------------------ *
 * Wiring to the real browser
 * ------------------------------------------------------------------------ */

export interface InstallUpdatesOptions {
  isPlaying(): boolean;
  onState?(state: UpdateSnapshot): void;
  /** Path to the worker. Root-scoped so it can serve the whole app. */
  scriptUrl?: string;
}

/**
 * Register the service worker and return the controller, or `null` where
 * service workers do not exist (an insecure origin, a private-mode browser, an
 * old WebView). Every one of those keeps a fully working game — the worker is
 * a delivery optimisation, never a dependency.
 */
export function installUpdates(options: InstallUpdatesOptions): UpdateController | null {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const loc = (globalThis as { location?: Location }).location;
  if (nav === undefined || !('serviceWorker' in nav)) return null;
  // A worker needs a secure context. `localhost` counts; a plain-http LAN
  // address for phone testing does not, and must not throw.
  if (loc !== undefined && loc.protocol !== 'https:' && loc.hostname !== 'localhost' && loc.hostname !== '127.0.0.1') {
    return null;
  }

  const container = nav.serviceWorker;
  const hadController = container.controller !== null;

  const controller = new UpdateController({
    isPlaying: options.isPlaying,
    reload: () => { (globalThis as { location?: Location }).location?.reload(); },
    now: () => Date.now(),
    hadController: () => hadController,
    onState: options.onState,
  });

  container.addEventListener('controllerchange', () => { controller.onControllerChange(); });

  // `updateViaCache: 'none'` so the worker SCRIPT itself is never served from
  // the HTTP cache. Without it a stale sw.js can pin a fleet to an old delivery
  // policy for up to 24 hours, which is the one file where that is fatal.
  void container.register(options.scriptUrl ?? '/sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      controller.attach(reg as unknown as RegistrationLike);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (installing === null) return;
        installing.addEventListener('statechange', () => {
          // 'installed' with a controller present means "waiting". Without one
          // it means "this is the first install", which is not an update.
          if (installing.state === 'installed' && container.controller !== null) {
            controller.noteUpdateReady();
          }
        });
      });
    })
    .catch(() => { /* no worker; the game is unaffected */ });

  return controller;
}
