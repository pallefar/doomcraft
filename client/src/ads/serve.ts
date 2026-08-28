/**
 * DOOMCRAFT — the client half of the ad pipeline (docs/SPONSORS.md §2.4).
 *
 * One decision per slot per SCREEN ENTRY, cached for the visit — no timed
 * refresh while a player reads the menu. The server chooses every fill; this
 * module renders what it was handed, measures it with the §3.2 meter, and
 * reports events against the fill's nonce. With no server configured, no
 * flag, or ads removed, none of this runs and the menu is exactly what it
 * was before this file existed.
 *
 * Two kinds of surface flow through here, and the split matters (§3.2):
 *  - the three reserved `#ads` slots — genuine ad-network inventory, honest
 *    ids, blockable, measured under the menu gate;
 *  - the first-party text surfaces — the S3 mode-tile badge and the S4 boot
 *    line — which are content in `#ui`/`#boot`, direct-sold text only, never
 *    house-filled, and measured under the gate of the screen they live on.
 */

import { SurfaceId, type AdFill } from '@doomcraft/shared/sponsor';

import { detectBlocked, observeSlot, type ObservedSlot } from './viewability';

const SLOT_FOR_SURFACE: Readonly<Partial<Record<SurfaceId, string>>> = Object.freeze({
  [SurfaceId.MENU_TOP]: 'ad-slot-top',
  [SurfaceId.MENU_SIDE]: 'ad-slot-side',
  [SurfaceId.MENU_BOTTOM]: 'ad-slot-bottom',
});

/** The menu-entry decide set: the three reserved slots plus the S3 badge. */
export const MENU_DECIDE_SURFACES: readonly SurfaceId[] = Object.freeze([
  SurfaceId.MENU_TOP, SurfaceId.MENU_SIDE, SurfaceId.MENU_BOTTOM, SurfaceId.MODE_TILE,
]);

/**
 * What a first-party text surface may render, or null. S3 and S4 accept only
 * a direct-sold text creative with an actual line — there is no house filler
 * for either by design (a house badge on a mode tile would be self-promotion
 * wearing a disclosure label), and an asset kind cannot serve before §2.2.
 */
export function textFillOrNull(fill: AdFill | null | undefined): AdFill | null {
  if (fill === null || fill === undefined) return null;
  if (fill.source !== 'direct' || fill.kind !== 'text') return null;
  if (fill.text.length === 0) return null;
  return fill;
}

export interface AdPipelineOptions {
  /** '' = static build with no server: the pipeline never activates. */
  serverBase: string;
  deviceId: () => string;
  /** The server-resolved sponsor_slots kill switch. */
  enabled: () => boolean;
  adsRemoved: () => boolean;
  platform: 'desktop' | 'mobile';
  /**
   * S3: render the badge for a MODE_TILE fill and return the element for the
   * meter, or null to refuse (unknown tile, tile already carries a badge).
   * A refusal renders nothing and therefore counts nothing.
   */
  onModeTile?: (fill: AdFill) => HTMLElement | null;
  /** S3: take the badge down on menu exit. The next entry re-decides. */
  clearModeTile?: () => void;
  /** S4: the live `.boot-tip` element while the boot screen is up, else null. */
  bootTip?: () => HTMLElement | null;
}

export interface AdPipeline {
  onMenuEnter(): void;
  onMenuExit(): void;
  /**
   * Call once the server-resolved flags are known (SESSION_CONFIG) — the
   * earliest moment the kill switch is answerable. Idempotent. If the boot
   * screen is already gone by then, or the decide loses the race to it,
   * nothing is shown (§4.3: a sponsor line must never wait for the game).
   */
  onBootReady(): void;
}

interface WatchedFill {
  watched: ObservedSlot;
  fill: AdFill;
}

export function createAdPipeline(opts: AdPipelineOptions): AdPipeline {
  const sessionId = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  let menuWatched: WatchedFill[] = [];
  let bootWatched: WatchedFill | null = null;
  let bootTried = false;
  let inMenu = false;
  let menuDecided = false;
  let flagProbe: Promise<boolean> | null = null;

  const api = (path: string): string => `${opts.serverBase}${path}`;
  const offline = (): boolean => opts.serverBase === '' && location.origin === 'null';

  /**
   * Is sponsor_slots on? The session bits answer instantly when they say yes —
   * but on the MENU they come from the local boot session (a Worker), which
   * never carries the flag, so "the bits say no" really means "the bits cannot
   * know". One GET of the server's own `/api/flags` per page answers it; the
   * kill switch still kills, because a killed flag is false in BOTH sources.
   */
  function enabledNow(): Promise<boolean> {
    if (opts.enabled()) return Promise.resolve(true);
    if (flagProbe === null) {
      flagProbe = fetch(api('/api/flags'))
        .then(async (res) => {
          if (!res.ok) return false;
          const body = await res.json() as { flags?: Record<string, unknown> };
          return body.flags?.sponsor_slots === true;
        })
        .catch(() => false);
    }
    return flagProbe;
  }

  function post(path: string, body: unknown, useBeacon = false): void {
    const json = JSON.stringify(body);
    if (useBeacon && 'sendBeacon' in navigator) {
      navigator.sendBeacon(api(path), new Blob([json], { type: 'application/json' }));
      return;
    }
    void fetch(api(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json,
      keepalive: true,
    }).catch(() => { /* a lost event is a lost event; it can only under-count */ });
  }

  function decide(surfaces: readonly SurfaceId[]): Promise<AdFill[]> {
    return fetch(api('/api/ads/decide'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: opts.deviceId(),
        sessionId,
        surfaces,
        mode: 0,
        platform: opts.platform,
      }),
    }).then(async (res) => {
      if (!res.ok) return [];
      const body = await res.json() as { fills: AdFill[] };
      return Array.isArray(body.fills) ? body.fills : [];
    });
  }

  function watch(el: HTMLElement, fill: AdFill, active?: () => boolean): WatchedFill {
    const watched = observeSlot(el, (e) => {
      post('/api/ads/event', { nonce: fill.nonce, type: e.type, ms: Date.now(), exposureMs: e.exposureMs });
    }, active === undefined ? {} : { active });
    return { watched, fill };
  }

  function flush(entry: WatchedFill): void {
    const exposureMs = entry.watched.meter.flush();
    if (exposureMs > 0) {
      post('/api/ads/event', { nonce: entry.fill.nonce, type: 'exposure', ms: Date.now(), exposureMs }, true);
    }
    entry.watched.disconnect();
  }

  function flushBoot(): void {
    if (bootWatched === null) return;
    flush(bootWatched);
    bootWatched = null;
  }

  function applyFill(fill: AdFill): void {
    if (fill.surface === SurfaceId.MODE_TILE) {
      const line = textFillOrNull(fill);
      if (line === null) return;
      const badge = opts.onModeTile?.(line) ?? null;
      if (badge === null) return;
      menuWatched.push(watch(badge, fill));
      return;
    }

    const slotId = SLOT_FOR_SURFACE[fill.surface];
    if (slotId === undefined) return;
    const slot = document.getElementById(slotId);
    if (slot === null) return;

    // A direct-sold TEXT creative replaces the house card for this visit.
    // House fills leave the existing card exactly as it is — it is already
    // rendered, already labelled, and already the fallback by construction.
    if (fill.source === 'direct' && fill.kind === 'text') {
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      const card = document.createElement(fill.clickUrl.length > 0 ? 'a' : 'div');
      card.className = 'dc-ad-house';
      if (card instanceof HTMLAnchorElement && fill.clickUrl.length > 0) {
        card.href = api(fill.clickUrl);
        card.target = '_blank';
        card.rel = 'noopener';
      }
      const inner = document.createElement('div');
      const label = document.createElement('b');
      label.textContent = fill.label || 'Sponsored';
      inner.appendChild(label);
      inner.appendChild(document.createTextNode(fill.text));
      card.appendChild(inner);
      slot.appendChild(card);
    }

    menuWatched.push(watch(slot, fill));

    // The Blocked bucket: one rAF after fill, never in the frame loop.
    requestAnimationFrame(() => {
      if (detectBlocked(slot)) {
        post('/api/ads/event', { nonce: fill.nonce, type: 'blocked', ms: Date.now() });
      }
    });
  }

  function menuDecide(): void {
    if (menuDecided || offline() || opts.adsRemoved()) return;
    void enabledNow().then((on) => {
      if (!on || !inMenu || menuDecided || opts.adsRemoved()) return;
      menuDecided = true;
      decide(MENU_DECIDE_SURFACES).then((fills) => {
        if (!inMenu) return;
        for (const fill of fills) applyFill(fill);
      }).catch(() => { /* no server, no pipeline — the house card stands */ });
    });
  }

  return {
    onMenuEnter(): void {
      // The boot line's run ends where the menu begins, whatever else happens.
      flushBoot();
      if (inMenu) return;
      inMenu = true;
      menuDecide();
    },

    onMenuExit(): void {
      if (!inMenu) return;
      inMenu = false;
      menuDecided = false;
      for (const entry of menuWatched) flush(entry);
      menuWatched = [];
      opts.clearModeTile?.();
    },

    onBootReady(): void {
      // Flags just became answerable (or at least askable). Two things may
      // have been waiting: a menu entry that raced ahead of SESSION_CONFIG
      // (the first visit always does — onReady fires before the socket
      // settles), and the boot line below.
      if (inMenu && !menuDecided) menuDecide();
      if (bootTried) return;
      bootTried = true;
      if (offline() || opts.adsRemoved()) return;
      if ((opts.bootTip?.() ?? null) === null) return;  // boot already over
      void enabledNow().then((on) => {
        if (!on || (opts.bootTip?.() ?? null) === null) return Promise.resolve<AdFill[]>([]);
        return decide([SurfaceId.BOOT_LINE]);
      }).then((fills) => {
        const fill = textFillOrNull(fills[0]);
        if (fill === null || fill.surface !== SurfaceId.BOOT_LINE) return;
        const tip = opts.bootTip?.() ?? null;
        if (tip === null) return;  // the decide lost the race to the boot — show nothing
        while (tip.firstChild) tip.removeChild(tip.firstChild);
        const label = document.createElement('b');
        label.textContent = fill.label || 'Sponsored';
        tip.appendChild(label);
        tip.appendChild(document.createTextNode(`  ${fill.text}`));
        // Text only, no click-out: A1 needs >=6 s of boot left (§4.2) and our
        // boot is ~366 ms — the line is presence, not a navigation target.
        bootWatched = watch(tip, fill, () => (opts.bootTip?.() ?? null) !== null);
      }).catch(() => { /* no line is the correct fallback */ });
    },
  };
}
