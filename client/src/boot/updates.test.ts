/**
 * DOOMCRAFT — the service worker must not swap the bundle under a player.
 *
 * One rule, from `docs/INFRASTRUCTURE.md` §6:
 *
 *   > **Never activate a new bundle while `game.playing === true`.**
 *
 * A service worker that calls `skipWaiting()` on install — which is what every
 * tutorial tells you to write — activates the moment it finishes downloading.
 * In a shooter that means the tab reloads mid-firefight, and the player loses
 * the match, their killstreak and any reason to come back.
 *
 * The policy is therefore a plain object with injected seams, tested here under
 * node with no browser at all, and the worker file itself is read off disk and
 * checked for the one call that would undo all of it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UpdateReason } from '@shared/version';

import {
  SKIP_WAITING_MESSAGE,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateController,
  type RegistrationLike,
  type UpdateSnapshot,
  type WorkerLike,
} from './updates.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

class FakeWorker implements WorkerLike {
  readonly received: unknown[] = [];
  constructor(readonly label: string) {}
  postMessage(message: unknown): void { this.received.push(message); }
  get skipped(): boolean {
    return this.received.some((m) => (m as { type?: string })?.type === SKIP_WAITING_MESSAGE);
  }
}

class FakeRegistration implements RegistrationLike {
  waiting: WorkerLike | null = null;
  installing: WorkerLike | null = null;
  updates = 0;
  updateRejects = false;
  async update(): Promise<void> {
    this.updates++;
    if (this.updateRejects) throw new Error('offline');
  }
}

interface Rig {
  controller: UpdateController;
  reg: FakeRegistration;
  playing: { value: boolean };
  reloads: number[];
  states: UpdateSnapshot[];
  now: { ms: number };
  /** Simulate a deploy landing: a new worker installs and goes to `waiting`. */
  deploy(label: string): FakeWorker;
}

function rig(opts: { hadController?: boolean } = {}): Rig {
  const reg = new FakeRegistration();
  const playing = { value: false };
  const reloads: number[] = [];
  const states: UpdateSnapshot[] = [];
  const now = { ms: 0 };

  const controller = new UpdateController({
    isPlaying: () => playing.value,
    reload: () => { reloads.push(now.ms); },
    now: () => now.ms,
    hadController: () => opts.hadController ?? true,
    onState: (s) => { states.push(s); },
  });
  controller.attach(reg);

  const deploy = (label: string): FakeWorker => {
    const w = new FakeWorker(label);
    // The browser replaces whatever was waiting: a newer install supersedes an
    // older one, and the older worker is discarded outright.
    reg.waiting = w;
    controller.noteUpdateReady();
    return w;
  };

  return { controller, reg, playing, reloads, states, now, deploy };
}

/* ------------------------------------------------------------------------ *
 * The rule
 * ------------------------------------------------------------------------ */

describe('the service worker does not activate during play', () => {
  it('holds an update that lands mid-match', () => {
    const r = rig();
    r.playing.value = true;
    const w = r.deploy('build-2');

    expect(w.skipped).toBe(false);
    expect(r.controller.swaps).toBe(0);
    expect(r.controller.snapshot.state).toBe('held');
  });

  it('refuses an explicit applyNow() while playing', () => {
    // Even if the shell mistakenly offers the button during a match, the
    // controller is the thing that says no.
    const r = rig();
    r.playing.value = true;
    const w = r.deploy('build-2');

    expect(r.controller.applyNow()).toBe(false);
    expect(w.skipped).toBe(false);
    expect(r.controller.swaps).toBe(0);
  });

  it('swaps at return-to-menu, once', () => {
    const r = rig();
    r.playing.value = true;
    const w = r.deploy('build-2');

    r.playing.value = false;
    r.controller.pump();
    expect(r.controller.snapshot.state).toBe('ready');
    // Advertised, not applied: leaving a match is not consent to lose the page.
    expect(w.skipped).toBe(false);

    expect(r.controller.applyNow()).toBe(true);
    expect(w.skipped).toBe(true);
    expect(r.controller.swaps).toBe(1);

    // A second press is a no-op, not a second swap.
    expect(r.controller.applyNow()).toBe(false);
    expect(r.controller.swaps).toBe(1);
  });

  it('never checks for an update during a match', () => {
    // Installing a bundle costs the same connection and CPU the match is using,
    // and the result could not be applied until the match ended anyway.
    const r = rig();
    r.playing.value = true;
    void r.controller.check(true);
    expect(r.reg.updates).toBe(0);

    r.playing.value = false;
    void r.controller.check(true);
    expect(r.reg.updates).toBe(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Two deploys across one match — the case that breaks naive implementations
 * ------------------------------------------------------------------------ */

describe('a player who stays in one match across two deploys', () => {
  it('takes the NEWEST build, exactly once', () => {
    const r = rig();
    r.playing.value = true;

    const first = r.deploy('build-2');
    const second = r.deploy('build-3');

    // Neither ran while the match was live.
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(false);
    expect(r.controller.snapshot.state).toBe('held');

    r.playing.value = false;
    expect(r.controller.applyNow()).toBe(true);

    // The stale worker is never messaged: the browser discarded it when the
    // newer one installed, and a captured reference would have posted into the
    // void and left the tab running the old bundle forever.
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(r.controller.swaps).toBe(1);
  });

  it('survives three deploys and a mid-match forced update', () => {
    const r = rig();
    r.playing.value = true;
    r.deploy('build-2');
    r.controller.requireUpdate(UpdateReason.PROTOCOL_TOO_OLD);
    r.deploy('build-3');
    const last = r.deploy('build-4');

    // Forced or not, nothing moved while the match was live.
    expect(r.controller.swaps).toBe(0);
    expect(r.controller.snapshot.forced).toBe(true);
    expect(r.controller.snapshot.state).toBe('held');

    r.playing.value = false;
    r.controller.pump();
    expect(last.skipped).toBe(true);
    expect(r.controller.swaps).toBe(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Forced updates
 * ------------------------------------------------------------------------ */

describe('a protocol-breaking release', () => {
  it('applies itself the moment the player is out of a match', () => {
    const r = rig();
    const w = r.deploy('build-2');
    r.playing.value = true;
    r.controller.requireUpdate(UpdateReason.PROTOCOL_TOO_OLD);
    expect(w.skipped).toBe(false);

    r.playing.value = false;
    r.controller.pump();
    expect(w.skipped).toBe(true);
    expect(r.controller.snapshot.forced).toBe(true);
  });

  it('ignores a reason that is not about this tab\'s bytes', () => {
    // "The server is older than you" is a routing problem. Reloading the client
    // cannot fix it and would only lose the player their menu state.
    const r = rig();
    const w = r.deploy('build-2');
    r.controller.requireUpdate(UpdateReason.PROTOCOL_TOO_NEW);
    expect(r.controller.snapshot.forced).toBe(false);
    expect(w.skipped).toBe(false);

    r.controller.requireUpdate(UpdateReason.HOST_DRAINING);
    expect(r.controller.snapshot.forced).toBe(false);
  });

  it('does nothing at all when there is no new build to take', () => {
    const r = rig();
    r.controller.requireUpdate(UpdateReason.BUILD_REVOKED);
    expect(r.controller.swaps).toBe(0);
    expect(r.reloads.length).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The reload
 * ------------------------------------------------------------------------ */

describe('the reload after a controller change', () => {
  it('happens once, and only for a swap this page asked for', () => {
    const r = rig();
    r.deploy('build-2');
    r.controller.applyNow();

    r.controller.onControllerChange();
    expect(r.reloads.length).toBe(1);

    // A second event — another tab, a re-activation — must not reload again.
    r.controller.onControllerChange();
    expect(r.reloads.length).toBe(1);
  });

  it('does NOT reload on a first install', () => {
    // No previous controller: the worker activates immediately and
    // `controllerchange` fires with nobody having asked. Reloading here would
    // flash every first visit for no reason at all.
    const r = rig({ hadController: false });
    r.controller.onControllerChange();
    expect(r.reloads.length).toBe(0);

    r.deploy('build-2');
    r.controller.applyNow();
    r.controller.onControllerChange();
    expect(r.reloads.length).toBe(0);
  });

  it('does not reload for a controller change nobody requested', () => {
    const r = rig();
    r.deploy('build-2');
    r.controller.onControllerChange();
    expect(r.reloads.length).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------------ */

describe('edges', () => {
  it('picks up a worker that was already waiting when the tab opened', () => {
    // The update landed while the tab was closed, so there was never an
    // `updatefound` event to hear.
    const reg = new FakeRegistration();
    const w = new FakeWorker('build-2');
    reg.waiting = w;
    const controller = new UpdateController({
      isPlaying: () => false,
      reload: () => { /* unused */ },
      now: () => 0,
      hadController: () => true,
    });
    controller.attach(reg);
    expect(controller.snapshot.state).toBe('ready');
    expect(controller.applyNow()).toBe(true);
    expect(w.skipped).toBe(true);
  });

  it('recovers when the waiting worker disappears before the swap', () => {
    const r = rig();
    r.deploy('build-2');
    r.reg.waiting = null;
    expect(r.controller.applyNow()).toBe(false);
    expect(r.controller.snapshot.state).toBe('idle');
  });

  it('rate-limits the periodic check but honours a forced one', () => {
    const r = rig();
    void r.controller.check();
    expect(r.reg.updates).toBe(1);
    void r.controller.check();
    expect(r.reg.updates).toBe(1);

    r.now.ms += UPDATE_CHECK_INTERVAL_MS + 1;
    void r.controller.check();
    expect(r.reg.updates).toBe(2);

    void r.controller.check(true);
    expect(r.reg.updates).toBe(3);
  });

  it('treats an offline check as a non-event', async () => {
    const r = rig();
    r.reg.updateRejects = true;
    await r.controller.check(true);
    expect(r.controller.snapshot.state).toBe('idle');
  });

  it('notices a build that was waiting before the check ran', async () => {
    const r = rig();
    r.reg.waiting = new FakeWorker('build-2');
    await r.controller.check(true);
    expect(r.controller.snapshot.state).toBe('ready');
  });
});

/* ------------------------------------------------------------------------ *
 * The worker file itself
 *
 * The policy above is only worth anything if the shipped worker actually leaves
 * activation to the page. `sw.js` is plain JavaScript in `public/`, so nothing
 * type-checks it and nothing imports it — these read the bytes that ship.
 * ------------------------------------------------------------------------ */

const swSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'sw.js'),
  'utf8',
);

/** Source with comments stripped, so prose about skipWaiting is not code. */
const swCode = swSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('client/public/sw.js', () => {
  it('calls skipWaiting exactly once', () => {
    const calls = swCode.match(/skipWaiting\s*\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it('calls it only from the message handler, never from install', () => {
    const install = /addEventListener\(\s*'install'[\s\S]*?\n\}\);/.exec(swCode);
    expect(install).not.toBeNull();
    expect((install as RegExpExecArray)[0]).not.toContain('skipWaiting');

    const message = /addEventListener\(\s*'message'[\s\S]*?\n\}\);/.exec(swCode);
    expect(message).not.toBeNull();
    expect((message as RegExpExecArray)[0]).toContain('skipWaiting');
  });

  it('gates that call on the page\'s message, not on anything it decides itself', () => {
    expect(swCode).toContain(SKIP_WAITING_MESSAGE);
  });

  it('never caches the document', () => {
    // The CSP nonce is minted per response and stamped into the HTML as it is
    // served (server/src/index.ts). A cached document carries a nonce that does
    // not match the response header, and every inline style and the boot script
    // are blocked — the game boots to a blank page. It is also how a client
    // gets pinned to an old bundle, because index.html is the pointer to the
    // hashed assets.
    const fetchHandler = /addEventListener\(\s*'fetch'[\s\S]*$/.exec(swCode);
    expect(fetchHandler).not.toBeNull();
    const body = (fetchHandler as RegExpExecArray)[0];
    // The navigate/document case must return before any respondWith.
    const guard = body.indexOf('navigate');
    const firstRespond = body.indexOf('respondWith');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstRespond);
  });

  it('leaves the API and the game socket alone', () => {
    expect(swCode).toContain("'/api/'");
    expect(swCode).toContain("'/ws'");
  });
});
