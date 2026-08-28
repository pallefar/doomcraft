/**
 * DOOMCRAFT — the client half of the ad pipeline (docs/SPONSORS.md §2.4).
 *
 * One decision per slot per SCREEN ENTRY, cached for the visit — no timed
 * refresh while a player reads the menu. The server chooses every fill; this
 * module renders what it was handed, measures it with the §3.2 meter, and
 * reports events against the fill's nonce. With no server configured, no
 * flag, or ads removed, none of this runs and the menu is exactly what it
 * was before this file existed.
 */

import { SurfaceId, type AdFill } from '@doomcraft/shared/sponsor';

import { detectBlocked, observeSlot, type ObservedSlot } from './viewability';

const SLOT_FOR_SURFACE: Readonly<Partial<Record<SurfaceId, string>>> = Object.freeze({
  [SurfaceId.MENU_TOP]: 'ad-slot-top',
  [SurfaceId.MENU_SIDE]: 'ad-slot-side',
  [SurfaceId.MENU_BOTTOM]: 'ad-slot-bottom',
});

export interface AdPipelineOptions {
  /** '' = static build with no server: the pipeline never activates. */
  serverBase: string;
  deviceId: () => string;
  /** The server-resolved sponsor_slots kill switch. */
  enabled: () => boolean;
  adsRemoved: () => boolean;
  platform: 'desktop' | 'mobile';
}

export interface AdPipeline {
  onMenuEnter(): void;
  onMenuExit(): void;
}

export function createAdPipeline(opts: AdPipelineOptions): AdPipeline {
  const sessionId = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  let observed: ObservedSlot[] = [];
  let fills: AdFill[] = [];
  let inMenu = false;

  const api = (path: string): string => `${opts.serverBase}${path}`;

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

  function applyFill(fill: AdFill): void {
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

    const watched = observeSlot(slot, (e) => {
      post('/api/ads/event', { nonce: fill.nonce, type: e.type, ms: Date.now(), exposureMs: e.exposureMs });
    });
    observed.push(watched);

    // The Blocked bucket: one rAF after fill, never in the frame loop.
    requestAnimationFrame(() => {
      if (detectBlocked(slot)) {
        post('/api/ads/event', { nonce: fill.nonce, type: 'blocked', ms: Date.now() });
      }
    });
  }

  return {
    onMenuEnter(): void {
      if (inMenu) return;
      inMenu = true;
      if (opts.serverBase === '' && location.origin === 'null') return;
      if (!opts.enabled() || opts.adsRemoved()) return;
      void fetch(api('/api/ads/decide'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: opts.deviceId(),
          sessionId,
          surfaces: [SurfaceId.MENU_TOP, SurfaceId.MENU_SIDE, SurfaceId.MENU_BOTTOM],
          mode: 0,
          platform: opts.platform,
        }),
      }).then(async (res) => {
        if (!res.ok || !inMenu) return;
        const body = await res.json() as { fills: AdFill[] };
        fills = Array.isArray(body.fills) ? body.fills : [];
        for (const fill of fills) applyFill(fill);
      }).catch(() => { /* no server, no pipeline — the house card stands */ });
    },

    onMenuExit(): void {
      if (!inMenu) return;
      inMenu = false;
      for (let i = 0; i < observed.length; i++) {
        const exposureMs = observed[i].meter.flush();
        const fill = fills[i];
        if (fill !== undefined && exposureMs > 0) {
          post('/api/ads/event', { nonce: fill.nonce, type: 'exposure', ms: Date.now(), exposureMs }, true);
        }
        observed[i].disconnect();
      }
      observed = [];
      fills = [];
    },
  };
}
