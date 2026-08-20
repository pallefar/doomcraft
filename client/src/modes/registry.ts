/**
 * DOOMCRAFT — the client mode registry.
 *
 * Four modes share one renderer, one net client, one HUD and one frame loop.
 * Switching between them must therefore be *exactly* reversible: whatever a
 * mode adds to the scene graph, to the DOM, to `window`, to a timer or to a
 * worker pool has to be gone the instant it exits, or the second visit costs
 * frame time the first one did not.
 *
 * The mechanism is `ModeScope`: a mode never cleans up by hand, it *registers*
 * every resource it creates and the registry unwinds the ledger in reverse on
 * exit. `scope.live` then reads zero, which is a thing a test can assert.
 *
 * Performance contract (ref/BAR.md): the per-frame path here is three null
 * checks and at most three virtual calls. Nothing in `update`, `fixedUpdate` or
 * `render` allocates — no closures, no spread, no array literals. All the
 * bookkeeping happens on enter and exit, which are cold.
 */

import type * as THREE from 'three';

import type { GameSettings } from '@shared/constants';
import {
  ModeId,
  MODE_KEYS,
  getMode,
  isModeId,
  clampSkill,
  createModeSelectMessage,
  DEFAULT_SKILL,
  MSF_COOP,
  MSF_CONTINUE,
  MSF_FRESH,
  MSF_NO_BOTS,
  type ModeDef,
  type ModeSelectMessage,
  type ModeStateBuffer,
  type ModeEventMessage,
  type ModeContextMessage,
  type ModeAction,
} from '@shared/modes';

import type { Game } from '@/game/game';

/* ------------------------------------------------------------------------ *
 * Parameters
 * ------------------------------------------------------------------------ */

/** Everything the app knows about the session a mode is being entered for. */
export interface ModeEnterParams {
  modeId: ModeId;
  skill: number;
  /** Quest level id, '' for the other modes. */
  levelId: string;
  /** Builder world id, '' for the other modes. */
  worldId: string;
  /** 0 lets the server pick. */
  seed: number;
  /** MSF_* bits from shared/src/modes.ts. */
  flags: number;
}

export function createEnterParams(modeId: ModeId = ModeId.DEATHMATCH): ModeEnterParams {
  return { modeId, skill: DEFAULT_SKILL, levelId: '', worldId: '', seed: 0, flags: 0 };
}

/** Copy without allocating a new object — used when re-entering the same mode. */
export function copyEnterParams(src: ModeEnterParams, dst: ModeEnterParams): void {
  dst.modeId = src.modeId;
  dst.skill = src.skill;
  dst.levelId = src.levelId;
  dst.worldId = src.worldId;
  dst.seed = src.seed;
  dst.flags = src.flags;
}

export function isCoop(p: ModeEnterParams): boolean { return (p.flags & MSF_COOP) !== 0; }
export function isContinue(p: ModeEnterParams): boolean { return (p.flags & MSF_CONTINUE) !== 0; }
export function isFresh(p: ModeEnterParams): boolean { return (p.flags & MSF_FRESH) !== 0; }
export function wantsNoBots(p: ModeEnterParams): boolean { return (p.flags & MSF_NO_BOTS) !== 0; }

/** Fill a wire message from the params, for `encodeModeSelect`. */
export function toModeSelectMessage(p: ModeEnterParams, out?: ModeSelectMessage): ModeSelectMessage {
  const m = out ?? createModeSelectMessage();
  m.modeId = p.modeId;
  m.skill = clampSkill(p.skill);
  m.flags = p.flags;
  m.seed = p.seed >>> 0;
  m.levelId = p.levelId;
  m.worldId = p.worldId;
  return m;
}

/** Inverse of `toModeSelectMessage`. */
export function fromModeSelectMessage(m: ModeSelectMessage, out?: ModeEnterParams): ModeEnterParams {
  const p = out ?? createEnterParams();
  p.modeId = m.modeId;
  p.skill = m.skill;
  p.flags = m.flags;
  p.seed = m.seed;
  p.levelId = m.levelId;
  p.worldId = m.worldId;
  return p;
}

/** `?mode=quest&level=e1m1-hangar&skill=3` -> params. Unknown values fall back. */
export function paramsFromQuery(search: string, fallback: ModeId = ModeId.DEATHMATCH): ModeEnterParams {
  const q = new URLSearchParams(search);
  const p = createEnterParams(fallback);
  const key = (q.get('mode') ?? '').toLowerCase();
  const idx = MODE_KEYS.indexOf(key);
  if (idx >= 0) p.modeId = idx as ModeId;
  const skill = Number(q.get('skill'));
  if (Number.isFinite(skill)) p.skill = clampSkill(skill);
  p.levelId = (q.get('level') ?? '').toLowerCase();
  p.worldId = (q.get('world') ?? '').toLowerCase();
  const seed = Number(q.get('seed'));
  if (Number.isFinite(seed)) p.seed = seed >>> 0;
  if (q.get('coop') === '1') p.flags |= MSF_COOP;
  return p;
}

/* ------------------------------------------------------------------------ *
 * Teardown ledger
 * ------------------------------------------------------------------------ */

interface DisposableLike { dispose?: () => void }

/**
 * The three-D bits of `THREE.Object3D` we touch, described structurally so this
 * module needs only a *type* import of three and adds nothing to the bundle.
 */
interface Object3DLike {
  parent: { remove(child: Object3DLike): void } | null;
  traverse(cb: (o: Object3DLike) => void): void;
  geometry?: DisposableLike;
  material?: DisposableLike | DisposableLike[];
}

type Teardown = () => void;

export interface ModeScopeStats {
  /** Resources still registered. Zero after `dispose()`. */
  live: number;
  listeners: number;
  timers: number;
  objects: number;
  workers: number;
  elements: number;
  /** Disposers that threw. A non-zero value here is a leak worth chasing. */
  errors: number;
}

/**
 * Every resource a mode creates is registered here and released in reverse
 * order on exit. A disposer that throws is recorded and skipped; one bad
 * teardown must never strand the rest of the ledger.
 */
export class ModeScope {
  private readonly teardowns: Teardown[] = [];
  private closed = false;
  private listenerCount = 0;
  private timerCount = 0;
  private objectCount = 0;
  private workerCount = 0;
  private elementCount = 0;
  private errorCount = 0;

  get disposed(): boolean { return this.closed; }
  get live(): number { return this.teardowns.length; }

  stats(): ModeScopeStats {
    return {
      live: this.teardowns.length,
      listeners: this.listenerCount,
      timers: this.timerCount,
      objects: this.objectCount,
      workers: this.workerCount,
      elements: this.elementCount,
      errors: this.errorCount,
    };
  }

  /** Register a bare teardown function. Returns it so callers can chain. */
  add(fn: Teardown): Teardown {
    if (this.closed) { this.runOne(fn); return fn; }
    this.teardowns.push(fn);
    return fn;
  }

  /** Register anything with a `dispose()` — three materials, HUD widgets, etc. */
  addDisposable(d: DisposableLike): void {
    this.add(() => { d.dispose?.(); });
  }

  /**
   * `addEventListener` that is guaranteed to come off again. Use this and never
   * the raw call — a stray listener on `window` outlives every mode switch.
   */
  addListener(
    target: EventTarget, type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    target.addEventListener(type, handler, options);
    this.listenerCount++;
    this.add(() => {
      target.removeEventListener(type, handler, options);
      this.listenerCount--;
    });
  }

  addTimeout(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.timerCount--;
      fn();
    }, ms);
    this.timerCount++;
    this.add(() => { window.clearTimeout(id); });
    return id;
  }

  addInterval(fn: () => void, ms: number): number {
    const id = window.setInterval(fn, ms);
    this.timerCount++;
    this.add(() => { window.clearInterval(id); this.timerCount--; });
    return id;
  }

  /** An AbortController that fires when the mode exits. */
  addAbort(): AbortController {
    const ac = new AbortController();
    this.add(() => { if (!ac.signal.aborted) ac.abort(); });
    return ac;
  }

  /**
   * Attach an object to the scene graph and guarantee it is detached AND its
   * GPU resources are released on exit. Geometry and materials are disposed
   * across the whole subtree, which is the leak the renderer actually notices.
   */
  addObject3D(object: THREE.Object3D, parent?: THREE.Object3D): void {
    const o = object as unknown as Object3DLike;
    if (parent !== undefined) (parent as unknown as { add(c: Object3DLike): void }).add(o);
    this.objectCount++;
    this.add(() => {
      const p = o.parent;
      if (p !== null) p.remove(o);
      o.traverse((child) => {
        child.geometry?.dispose?.();
        const mat = child.material;
        if (mat === undefined) return;
        if (Array.isArray(mat)) { for (const m of mat) m.dispose?.(); } else { mat.dispose?.(); }
      });
      this.objectCount--;
    });
  }

  /** Terminate a worker on exit. Modes that spawn their own pool must use this. */
  addWorker(worker: Worker): void {
    this.workerCount++;
    this.add(() => { worker.terminate(); this.workerCount--; });
  }

  /** Remove a DOM node on exit. Also covers injected `<style>` tags. */
  addElement(node: Element): void {
    this.elementCount++;
    this.add(() => { node.remove(); this.elementCount--; });
  }

  private runOne(fn: Teardown): void {
    try { fn(); } catch { this.errorCount++; }
  }

  /** Idempotent. Runs every teardown in reverse registration order. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (let i = this.teardowns.length - 1; i >= 0; i--) this.runOne(this.teardowns[i]);
    this.teardowns.length = 0;
  }
}

/* ------------------------------------------------------------------------ *
 * Mode interface
 * ------------------------------------------------------------------------ */

/** What the app provides to every mode. Implemented by main.ts. */
export interface ModeHost {
  readonly game: Game;
  /** `#ui` — menus, overlays, mode-specific panels. Children opt into pointer events. */
  readonly uiRoot: HTMLElement;
  /** `#hud` — crosshair, bars, hotbar. Never interactive. */
  readonly hudRoot: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly settings: GameSettings;
  /** Send a already-encoded packet to the server. */
  send(bytes: Uint8Array): void;
  /** Centre-screen status line, the "Loading Terrain (100%)" surface. */
  setStatus(text: string): void;
  /** Ask the shell to leave to the main menu (the mode failed, or the run ended). */
  requestExit(reason: string): void;
  /**
   * Losing pointer lock normally means the player walked away, so the shell
   * opens the pause menu. A mode that releases the lock ON PURPOSE — to show a
   * palette, a shop, an intermission — must say so first, or the shell pauses
   * the game on top of the panel the mode just opened.
   */
  suppressAutoPause?(on: boolean): void;
}

/**
 * A live mode. Every hook is optional — a mode that only needs a HUD overlay
 * implements `enter`, `render` and nothing else.
 */
export interface ModeInstance {
  readonly id: ModeId;
  /** Called once, after the scope exists. May be async (fetching a level). */
  enter?(): void | Promise<void>;
  /** Called once, before the scope is unwound. Flush saves here. */
  exit?(): void | Promise<void>;
  /** Fixed-step, same cadence as the sim. */
  fixedUpdate?(dt: number, tick: number): void;
  /** Once per frame, before the scene is drawn. */
  update?(dt: number, nowMs: number): void;
  /** Once per frame, after the scene is drawn. `alpha` is the interpolation t. */
  render?(alpha: number): void;
  onModeState?(state: ModeStateBuffer): void;
  onModeEvent?(event: ModeEventMessage): void;
  onModeContext?(context: ModeContextMessage): void;
  onResize?(width: number, height: number): void;
  onPause?(paused: boolean): void;
  /** Return true to swallow a local action so the shell does not also handle it. */
  onAction?(action: ModeAction, a: number, b: number): boolean;
}

/** What a factory receives. */
export interface ModeContext {
  readonly host: ModeHost;
  readonly def: ModeDef;
  /** Live params object — the registry mutates it in place on re-entry. */
  readonly params: ModeEnterParams;
  readonly scope: ModeScope;
  readonly registry: ModeRegistry;
}

export type ModeFactory = (ctx: ModeContext) => ModeInstance | Promise<ModeInstance>;

/* ------------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------------ */

export interface ModeRegistryEvents {
  /** Fires after the new mode's `enter` resolves. */
  onEntered?(id: ModeId, params: ModeEnterParams): void;
  /** Fires after the previous mode's scope has been unwound. */
  onExited?(id: ModeId, stats: ModeScopeStats): void;
  /** A factory or an `enter` threw. The registry is left with no active mode. */
  onError?(id: ModeId, error: unknown): void;
}

export interface ModeRegistryStats {
  activations: number;
  /** Resources whose teardown threw, across every mode this session. */
  teardownErrors: number;
  /** Resources still held by the ACTIVE mode. */
  liveResources: number;
  activeKey: string;
}

/**
 * Owns the active mode and the switch between modes. Every mutation is
 * serialised through one promise chain, so two rapid clicks on two different
 * tiles can never leave two modes half-alive at once.
 */
export class ModeRegistry {
  readonly host: ModeHost;
  readonly events: ModeRegistryEvents;

  private readonly factories = new Map<ModeId, ModeFactory>();
  private current: ModeInstance | null = null;
  private currentId: ModeId | -1 = -1;
  private scope: ModeScope | null = null;
  private readonly currentParams: ModeEnterParams = createEnterParams();
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private activations = 0;
  private teardownErrors = 0;
  private destroyed = false;
  private paused = false;

  constructor(host: ModeHost, events: ModeRegistryEvents = {}) {
    this.host = host;
    this.events = events;
  }

  /* --- registration --------------------------------------------------- */

  register(id: ModeId, factory: ModeFactory): void {
    if (!isModeId(id)) throw new Error(`ModeRegistry: ${String(id)} is not a ModeId`);
    this.factories.set(id, factory);
  }

  unregister(id: ModeId): void { this.factories.delete(id); }
  has(id: ModeId): boolean { return this.factories.has(id); }
  registered(): ModeId[] { return [...this.factories.keys()].sort((a, b) => a - b); }

  /* --- state ------------------------------------------------------------ */

  get active(): ModeInstance | null { return this.current; }
  get activeId(): ModeId | -1 { return this.currentId; }
  get activeDef(): ModeDef | null { return this.currentId < 0 ? null : getMode(this.currentId); }
  get params(): Readonly<ModeEnterParams> { return this.currentParams; }
  /** True while an activate/deactivate is in flight. */
  get switching(): boolean { return this.pending > 0; }
  get isPaused(): boolean { return this.paused; }

  stats(): ModeRegistryStats {
    return {
      activations: this.activations,
      teardownErrors: this.teardownErrors,
      liveResources: this.scope === null ? 0 : this.scope.live,
      activeKey: this.currentId < 0 ? '' : MODE_KEYS[this.currentId],
    };
  }

  /** Resource counters for the active mode. Zero for every field means clean. */
  scopeStats(): ModeScopeStats {
    return this.scope === null
      ? { live: 0, listeners: 0, timers: 0, objects: 0, workers: 0, elements: 0, errors: 0 }
      : this.scope.stats();
  }

  /* --- switching --------------------------------------------------------- */

  /**
   * Tear down whatever is running and bring up `params.modeId`. Safe to call
   * while a previous switch is still resolving; calls run strictly in order.
   */
  activate(params: ModeEnterParams): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.pending++;
    this.chain = this.chain.then(
      () => this.runActivate(params),
      () => this.runActivate(params),
    ).then(
      () => { this.pending--; },
      () => { this.pending--; },
    );
    return this.chain;
  }

  /** Tear down the active mode and leave the registry empty. */
  deactivate(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.pending++;
    this.chain = this.chain.then(
      () => this.runDeactivate(),
      () => this.runDeactivate(),
    ).then(
      () => { this.pending--; },
      () => { this.pending--; },
    );
    return this.chain;
  }

  private async runDeactivate(): Promise<void> {
    const inst = this.current;
    const id = this.currentId;
    const scope = this.scope;
    this.current = null;
    this.currentId = -1;
    this.scope = null;
    if (inst !== null && inst.exit !== undefined) {
      try { await inst.exit(); } catch (e) { this.events.onError?.(id as ModeId, e); }
    }
    if (scope !== null) {
      scope.dispose();
      const s = scope.stats();
      this.teardownErrors += s.errors;
      if (id !== -1) this.events.onExited?.(id, s);
    }
  }

  private async runActivate(params: ModeEnterParams): Promise<void> {
    await this.runDeactivate();
    if (this.destroyed) return;

    const id = isModeId(params.modeId) ? params.modeId : ModeId.DEATHMATCH;
    const factory = this.factories.get(id);
    if (factory === undefined) {
      this.events.onError?.(id, new Error(`no factory registered for mode "${MODE_KEYS[id]}"`));
      return;
    }

    copyEnterParams(params, this.currentParams);
    this.currentParams.modeId = id;
    this.currentParams.skill = clampSkill(this.currentParams.skill);

    const scope = new ModeScope();
    const ctx: ModeContext = {
      host: this.host,
      def: getMode(id),
      params: this.currentParams,
      scope,
      registry: this,
    };

    let instance: ModeInstance;
    try {
      instance = await factory(ctx);
    } catch (e) {
      scope.dispose();
      this.teardownErrors += scope.stats().errors;
      this.events.onError?.(id, e);
      return;
    }

    this.scope = scope;
    this.current = instance;
    this.currentId = id;

    if (instance.enter !== undefined) {
      try {
        await instance.enter();
      } catch (e) {
        // A mode that cannot start must not stay half-installed.
        this.current = null;
        this.currentId = -1;
        this.scope = null;
        scope.dispose();
        this.teardownErrors += scope.stats().errors;
        this.events.onError?.(id, e);
        return;
      }
    }

    this.activations++;
    if (this.paused) instance.onPause?.(true);
    this.events.onEntered?.(id, this.currentParams);
  }

  /* --- per-frame dispatch (hot) ------------------------------------------ */

  fixedUpdate(dt: number, tick: number): void {
    const m = this.current;
    if (m !== null && m.fixedUpdate !== undefined) m.fixedUpdate(dt, tick);
  }

  update(dt: number, nowMs: number): void {
    const m = this.current;
    if (m !== null && m.update !== undefined) m.update(dt, nowMs);
  }

  render(alpha: number): void {
    const m = this.current;
    if (m !== null && m.render !== undefined) m.render(alpha);
  }

  /* --- event dispatch (cold) --------------------------------------------- */

  dispatchState(state: ModeStateBuffer): void {
    const m = this.current;
    if (m !== null && m.onModeState !== undefined) m.onModeState(state);
  }

  dispatchEvent(event: ModeEventMessage): void {
    const m = this.current;
    if (m !== null && m.onModeEvent !== undefined) m.onModeEvent(event);
  }

  dispatchContext(context: ModeContextMessage): void {
    const m = this.current;
    if (m !== null && m.onModeContext !== undefined) m.onModeContext(context);
  }

  dispatchAction(action: ModeAction, a = 0, b = 0): boolean {
    const m = this.current;
    if (m !== null && m.onAction !== undefined) return m.onAction(action, a, b);
    return false;
  }

  resize(width: number, height: number): void {
    const m = this.current;
    if (m !== null && m.onResize !== undefined) m.onResize(width, height);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    const m = this.current;
    if (m !== null && m.onPause !== undefined) m.onPause(paused);
  }

  /** Final teardown. The registry refuses further activations afterwards. */
  async dispose(): Promise<void> {
    if (this.destroyed) return;
    await this.deactivate();
    this.destroyed = true;
    this.factories.clear();
  }
}
