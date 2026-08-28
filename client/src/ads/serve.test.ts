/**
 * DOOMCRAFT — the client pipeline's pure decisions (docs/SPONSORS.md §1a, §2.4).
 * The DOM halves are screenshot-verified on a booted host; what is provable in
 * a DOM-less runner is the refusal logic the first-party surfaces hang on, and
 * the decide set the menu entry actually requests.
 */

import { describe, expect, it } from 'vitest';

import { SurfaceId, type AdFill } from '@doomcraft/shared/sponsor';

import { MENU_DECIDE_SURFACES, textFillOrNull } from './serve';

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
