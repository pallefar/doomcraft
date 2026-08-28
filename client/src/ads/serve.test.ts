/**
 * DOOMCRAFT — the client pipeline's pure decisions (docs/SPONSORS.md §1a, §2.4).
 * The DOM halves are screenshot-verified on a booted host; what is provable in
 * a DOM-less runner is the refusal logic the first-party surfaces hang on, and
 * the decide set the menu entry actually requests.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { SurfaceId, type AdFill } from '@doomcraft/shared/sponsor';

import { MENU_DECIDE_SURFACES, createAdPipeline, interCardModel, textFillOrNull } from './serve';

function fill(over: Partial<AdFill> = {}): AdFill {
  return {
    surface: SurfaceId.MODE_TILE, source: 'direct', creativeId: 'crv_1', kind: 'text',
    assetUrl: '', clickUrl: '', altText: '', text: 'CubeRealm — voxel worlds, free',
    label: 'Sponsored', modeId: 2, nonce: 'n1', expiresMs: 1,
    ...over,
  };
}

describe('the first-party text gate (S3 badge, S4 boot line)', () => {
  it('accepts exactly a direct-sold text creative with a line', () => {
    expect(textFillOrNull(fill())).not.toBeNull();
  });

  it('refuses house — these surfaces have no house filler by design', () => {
    expect(textFillOrNull(fill({ source: 'house' }))).toBeNull();
  });

  it('refuses asset kinds — nothing can render an image before §2.2', () => {
    expect(textFillOrNull(fill({ kind: 'display' }))).toBeNull();
    expect(textFillOrNull(fill({ kind: 'image' }))).toBeNull();
  });

  it('refuses an empty line, a missing fill, and an absent decide', () => {
    expect(textFillOrNull(fill({ text: '' }))).toBeNull();
    expect(textFillOrNull(null)).toBeNull();
    expect(textFillOrNull(undefined)).toBeNull();
  });
});

describe('the S12 card model', () => {
  const inter = (over: Partial<AdFill> = {}): AdFill =>
    fill({ surface: SurfaceId.INTERMISSION_CARD, clickUrl: '/r/abc', modeId: -1, ...over });

  it('a direct text fill carries its disclosure label, and a click only on an interactive mount', () => {
    const m = interCardModel(inter(), true);
    expect(m).toEqual({ kind: 'text', label: 'Sponsored', text: inter().text, href: '/r/abc', src: '' });
    // The deathmatch board is #hud, pointer-events none — an anchor there
    // would render as a link nobody can follow.
    expect(interCardModel(inter(), false)?.href).toBe('');
  });

  it('a house fill renders the house card, never a click', () => {
    const m = interCardModel(inter({ source: 'house', text: '', label: '' }), true);
    expect(m?.kind).toBe('house');
    expect(m?.href).toBe('');
  });

  it('refuses the wrong surface, an asset kind, and an empty decide', () => {
    expect(interCardModel(fill(), true)).toBeNull();                       // MODE_TILE is not a card
    expect(interCardModel(inter({ kind: 'display' }), true)).toBeNull();   // §2.2 has not shipped
    expect(interCardModel(undefined, true)).toBeNull();
  });
});

describe('the kill-switch probe — the 1a inertness defect', () => {
  const g = globalThis as Record<string, unknown>;
  const realFetch = g.fetch;
  const realLocation = g.location;
  afterEach(() => { g.fetch = realFetch; g.location = realLocation; });

  it('a menu entry whose session bits CANNOT know the flag still asks /api/flags and then decides', async () => {
    // The 1a shape: the menu session is the local worker, whose flag bits
    // never carry sponsor_slots — enabled() is false forever, and the old
    // guard made that terminal. The pipeline must ask the server itself.
    const calls: string[] = [];
    g.location = { origin: 'http://game.test' };
    g.fetch = (url: unknown): Promise<unknown> => {
      calls.push(String(url));
      const body = String(url).includes('/api/flags')
        ? { flags: { sponsor_slots: true } }
        : { fills: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    };
    const pipe = createAdPipeline({
      serverBase: '', deviceId: () => 'd', enabled: () => false,
      adsRemoved: () => false, platform: 'desktop',
    });
    pipe.onMenuEnter();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((u) => u.includes('/api/flags'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/ads/decide'))).toBe(true);
  });

  it('a flag the server also says is OFF still kills everything — no decide, ever', async () => {
    const calls: string[] = [];
    g.location = { origin: 'http://game.test' };
    g.fetch = (url: unknown): Promise<unknown> => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: { sponsor_slots: false } }) });
    };
    const pipe = createAdPipeline({
      serverBase: '', deviceId: () => 'd', enabled: () => false,
      adsRemoved: () => false, platform: 'desktop',
    });
    pipe.onMenuEnter();
    const dispose = pipe.intermissionCard({ appendChild: () => {} } as unknown as HTMLElement, {
      mode: 0, interactive: true, active: () => true,
    });
    await new Promise((r) => setTimeout(r, 10));
    dispose();
    expect(calls.filter((u) => u.includes('/api/ads/decide'))).toEqual([]);
  });
});

describe('the menu-entry decide set', () => {
  it('requests the three reserved slots AND the S3 mode-tile badge', () => {
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MENU_TOP);
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MENU_SIDE);
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MENU_BOTTOM);
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MODE_TILE);
  });

  it('does NOT request the boot line or the intermission card there — those decide at their own moments', () => {
    expect(MENU_DECIDE_SURFACES).not.toContain(SurfaceId.BOOT_LINE);
    expect(MENU_DECIDE_SURFACES).not.toContain(SurfaceId.INTERMISSION_CARD);
  });
});
