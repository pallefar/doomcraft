/**
 * DOOMCRAFT — 2D slot viewability, exactly as docs/SPONSORS.md §3.2 commits
 * to it: event-driven IntersectionObserver under the MRC exemption, a gate
 * set where every gate can only SUBTRACT, two independent accumulators
 * driven from monotonic performance.now() deltas, and "continuous" meaning
 * continuous — a flicker resets the run to zero, no grace, no debounce.
 *
 * The meter is split so the state machine is pure and testable: `SlotMeter`
 * never touches the DOM; `observeSlot` feeds it from IO + gate events.
 */

import {
  AD_IMPRESSION_COOLOFF_MS,
  AD_MENU_IDLE_MS,
  AD_VIEWABLE_MS,
  AD_VIEWABLE_RATIO,
} from '@doomcraft/shared/sponsor';

export interface MeterEvent {
  type: 'impression' | 'replay' | 'exposure';
  /** Total exposure ms so far (exposure events only). */
  exposureMs: number;
}

export interface GateState {
  visible: boolean;        // document.visibilityState === 'visible'
  focused: boolean;        // document.hasFocus()
  prerendering: boolean;   // IIG 3.1.5.1: pre-render must not count
  menuMode: boolean;       // #ads[data-mode] === 'menu'
  overlayOpen: boolean;    // #ad-overlay open covers the slots
  creativeLoaded: boolean;
  msSinceInput: number;    // ours, stricter than MRC (IIG §3.1.5.3)
}

export function gateOpen(g: GateState): boolean {
  return g.visible && g.focused && !g.prerendering && g.menuMode
    && !g.overlayOpen && g.creativeLoaded && g.msSinceInput < AD_MENU_IDLE_MS;
}

/**
 * The per-slot state machine. Feed it `update()` on every IO callback or
 * gate transition with the CURRENT ratio+gates and a monotonic now; it emits
 * at most one `impression` per session, `replay` for later runs (cooled off
 * per IIG §3.1.5.4), and keeps the exposure accumulator separate and
 * non-consecutive (IIG §3.2.10.2).
 */
export class SlotMeter {
  private runStartMs = -1;
  private lastCountMs = -1;
  private exposureMs = 0;
  private lastExposedMs = -1;
  private impressionEmitted = false;
  private lastExposureEmit = 0;
  private readonly emit: (e: MeterEvent) => void;

  constructor(emit: (e: MeterEvent) => void) {
    this.emit = emit;
  }

  update(nowMs: number, ratio: number, occluded: boolean, gates: GateState): void {
    // Exposure accrues on the pixel test alone, before qualification — it is
    // deliberately a different, looser quantity than the impression run.
    const exposed = ratio >= AD_VIEWABLE_RATIO && gates.visible && gates.menuMode;
    if (exposed) {
      if (this.lastExposedMs >= 0) this.exposureMs += Math.max(0, nowMs - this.lastExposedMs);
      this.lastExposedMs = nowMs;
      if (nowMs - this.lastExposureEmit >= 5_000) {
        this.lastExposureEmit = nowMs;
        this.emit({ type: 'exposure', exposureMs: Math.round(this.exposureMs) });
      }
    } else {
      this.lastExposedMs = -1;
    }

    // The pixel test PRECEDES the clock (MRC ordering): the run starts only
    // when ratio, occlusion and every gate qualify at once.
    const qualified = ratio >= AD_VIEWABLE_RATIO && !occluded && gateOpen(gates);
    if (!qualified) {
      this.runStartMs = -1; // any transition to not-qualified resets — no grace period
      return;
    }
    if (this.runStartMs < 0) this.runStartMs = nowMs;
    if (nowMs - this.runStartMs >= AD_VIEWABLE_MS) {
      if (!this.impressionEmitted) {
        this.impressionEmitted = true;
        this.lastCountMs = nowMs;
        this.emit({ type: 'impression', exposureMs: Math.round(this.exposureMs) });
      } else if (nowMs - this.lastCountMs >= AD_IMPRESSION_COOLOFF_MS) {
        this.lastCountMs = nowMs;
        this.emit({ type: 'replay', exposureMs: Math.round(this.exposureMs) });
      }
      this.runStartMs = -1; // one count per completed run
    }
  }

  /** Final flush for menu exit / page hide. */
  flush(): number {
    return Math.round(this.exposureMs);
  }
}

/* ------------------------------------------------------------------------ *
 * DOM wiring — one observer per slot, connected on menu entry only
 * ------------------------------------------------------------------------ */

export interface ObservedSlot {
  el: HTMLElement;
  meter: SlotMeter;
  disconnect(): void;
}

export function observeSlot(
  el: HTMLElement,
  emit: (e: MeterEvent) => void,
  now: () => number = () => performance.now(),
): ObservedSlot {
  const meter = new SlotMeter(emit);
  let ratio = 0;
  let ioOccluded = false;
  let lastInputMs = now();

  const gates = (): GateState => ({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    prerendering: (document as { prerendering?: boolean }).prerendering === true,
    menuMode: document.getElementById('ads')?.dataset.mode === 'menu',
    overlayOpen: document.getElementById('ad-overlay')?.dataset.open === '1',
    creativeLoaded: el.childElementCount > 0,
    msSinceInput: now() - lastInputMs,
  });

  const tick = (): void => { meter.update(now(), ratio, ioOccluded, gates()); };

  const OPTS: IntersectionObserverInit = { root: null, rootMargin: '0px', threshold: [0, 0.25, 0.5, 0.75, 1] };
  const v2 = 'isVisible' in IntersectionObserverEntry.prototype;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      ratio = entry.intersectionRatio;
      // IO v1 cannot see occlusion; v2 can. On v1 the overlay gate is our
      // self-occlusion model — disclosed as a model, not a measurement.
      ioOccluded = v2 ? (entry as unknown as { isVisible: boolean }).isVisible === false : false;
    }
    tick();
  }, v2
    // IO v2's fields are not in lib.dom yet; the runtime check above is the guard.
    ? ({ ...OPTS, trackVisibility: true, delay: 100 } as IntersectionObserverInit)
    : OPTS);
  io.observe(el);

  const onInput = (): void => { lastInputMs = now(); };
  const inputOpts = { passive: true, capture: true } as const;
  document.addEventListener('pointermove', onInput, inputOpts);
  document.addEventListener('pointerdown', onInput, inputOpts);
  document.addEventListener('keydown', onInput, inputOpts);
  document.addEventListener('wheel', onInput, inputOpts);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('focus', tick);
  window.addEventListener('blur', tick);
  // The watchdog that closes a run ending with no event — never rAF (§3.2.5).
  const watchdog = window.setInterval(tick, 250);

  return {
    el, meter,
    disconnect(): void {
      io.disconnect();
      window.clearInterval(watchdog);
      document.removeEventListener('pointermove', onInput, inputOpts);
      document.removeEventListener('pointerdown', onInput, inputOpts);
      document.removeEventListener('keydown', onInput, inputOpts);
      document.removeEventListener('wheel', onInput, inputOpts);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('blur', tick);
    },
  };
}

/**
 * The Blocked bucket (§3.2): one rAF after fill, menu only. A blocker hiding
 * a reserved `contain:strict` slot does no layout damage, but the impression
 * denominator silently under-reports unless we say so.
 */
export function detectBlocked(slot: HTMLElement): boolean {
  return slot.offsetParent === null
    || getComputedStyle(slot).display === 'none'
    || slot.clientHeight === 0;
}
