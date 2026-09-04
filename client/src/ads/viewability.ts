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
  type: 'impression' | 'replay' | 'exposure' | 'rendered';
  /** Total exposure ms so far (exposure events only). */
  exposureMs: number;
}

/**
 * The terminal verdict for one fill, produced when the slot goes away.
 *
 * This is the row the whole §3.5 metric set was missing. Metric 6, Viewable
 * Rate, is 2/(2+3) — viewable over viewable plus MEASURED NON-VIEWABLE — and
 * with no way to record a measured failure the numerator and denominator were
 * the same number. That does not print a wrong rate so much as an unavailable
 * one, and a dashboard that shows 100% there is asserting something nobody
 * measured.
 *
 * `basis` is what keeps metric 4 (Undetermined) honest, and the distinction it
 * draws is the one caveat 6 exists to protect: **Undetermined is not
 * non-viewable.** A creative that never rendered was never measured and belongs
 * in bucket 4; a creative that rendered, was watched, and never met the bar is a
 * measured failure and belongs in bucket 3. Collapsing them flatters the
 * Measured Rate, which MRC asks us to maximise — exactly the wrong incentive.
 */
export interface SlotVerdict {
  qualified: boolean;
  basis: 'measured' | 'undetermined';
  /** Why, when the basis is undetermined. Empty when measured. */
  reason: string;
  exposureMs: number;
}

export interface GateState {
  visible: boolean;        // document.visibilityState === 'visible'
  focused: boolean;        // document.hasFocus()
  prerendering: boolean;   // IIG 3.1.5.1: pre-render must not count
  menuMode: boolean;       // the surface's own screen is up — `#ads[data-mode] === 'menu'` for
                           // the reserved slots; a first-party surface supplies its own answer
                           // (see ObserveSlotOptions.active)
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
  private renderedEmitted = false;
  private everLoaded = false;
  private lastExposureEmit = 0;
  private readonly emit: (e: MeterEvent) => void;

  constructor(emit: (e: MeterEvent) => void) {
    this.emit = emit;
  }

  update(nowMs: number, ratio: number, occluded: boolean, gates: GateState): void {
    /* RENDERED, once, the first time the creative is actually in the slot.
     *
     * This is the MRC "Total (rendered) impressions" denominator, and it has to
     * come from here: the server's `served` row records that a fill was
     * ALLOCATED, which is a different and larger number — the client may never
     * display it. Deliberately not gated on visibility or focus; rendering is
     * not viewing, and conflating them is what caveat 1 is about. */
    if (!this.renderedEmitted && gates.creativeLoaded) {
      this.renderedEmitted = true;
      this.everLoaded = true;
      this.emit({ type: 'rendered', exposureMs: 0 });
    }
    if (gates.creativeLoaded) this.everLoaded = true;
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

  /**
   * The terminal verdict for this fill. Call once, when the slot is torn down.
   *
   * A fill that never gets here at all — the player closes the tab mid-menu —
   * is Undetermined BY ABSENCE, and a reader counts it by subtracting verdicts
   * from `rendered` rows. That is a measured count of the unmeasured, which is
   * what metric 4 asks for; it is not a guess.
   */
  verdict(): SlotVerdict {
    const exposureMs = Math.round(this.exposureMs);
    if (this.impressionEmitted) return { qualified: true, basis: 'measured', reason: '', exposureMs };
    // Never rendered => never measurable. Undetermined, NOT a measured failure.
    if (!this.everLoaded) {
      return { qualified: false, basis: 'undetermined', reason: 'creative never rendered', exposureMs };
    }
    // Rendered, watched for the whole time the slot existed, never met the bar.
    return { qualified: false, basis: 'measured', reason: '', exposureMs };
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

export interface ObserveSlotOptions {
  now?: () => number;
  /**
   * Overrides the "the surface's own screen is up" gate. The default is the
   * §3.2 menu-slot gate — `#ads[data-mode] === 'menu'` — which is meaningless
   * for a first-party surface living in `#ui` or `#boot` (the S3 tile badge is
   * an exception: it IS on the menu screen and keeps the default). S4 passes
   * "the boot screen is still up", S12 "the intermission is open". Like every
   * gate it can only subtract: false stops the clock, nothing restarts it but
   * the surface actually being there.
   */
  active?: () => boolean;
}

export function observeSlot(
  el: HTMLElement,
  emit: (e: MeterEvent) => void,
  opts: ObserveSlotOptions = {},
): ObservedSlot {
  const now = opts.now ?? ((): number => performance.now());
  const meter = new SlotMeter(emit);
  let ratio = 0;
  let ioOccluded = false;
  let lastInputMs = now();

  const gates = (): GateState => ({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    prerendering: (document as { prerendering?: boolean }).prerendering === true,
    menuMode: opts.active !== undefined
      ? opts.active()
      : document.getElementById('ads')?.dataset.mode === 'menu',
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
