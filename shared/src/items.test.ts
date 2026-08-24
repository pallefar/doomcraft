/**
 * DOOMCRAFT — items: the parser refuses, the ref round-trips, and state is
 * derived, never stored (docs/PACKS.md §7, docs/ECONOMY.md Items).
 */

import { describe, expect, it } from 'vitest';

import {
  ItemKind,
  formatItemRef,
  itemStateFor,
  itemsFingerprintInputs,
  parseItemRef,
  parseItemsManifest,
} from './items.ts';

const good = (over: Record<string, unknown> = {}): string => JSON.stringify({
  items: [
    { id: 'skin-a', kind: 'skin', name: 'A', rarity: 'common', tradable: true, tint: [1, 1, 1] },
    { id: 'title-b', kind: 'title', name: 'B', rarity: 'rare', tradable: false, text: 'The B' },
    ...(Array.isArray(over.extra) ? over.extra : []),
  ],
});

describe('the manifest parser refuses instead of correcting', () => {
  it('parses a good manifest', () => {
    const r = parseItemsManifest(good());
    expect(r.errors).toEqual([]);
    expect(r.manifest?.items.length).toBe(2);
  });

  it('refuses a tradable title — proof of achievement, a trade would launder it', () => {
    const r = parseItemsManifest(JSON.stringify({
      items: [{ id: 'title-x', kind: 'title', name: 'X', rarity: 'epic', tradable: true, text: 'X' }],
    }));
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toContain('launder');
  });

  it('refuses a duplicate id, a non-canonical id, an unknown kind, an off-range tint, and a mute title', () => {
    for (const bad of [
      { id: 'skin-a', kind: 'skin', name: 'dup', rarity: 'common' },
      { id: 'Skin-B', kind: 'skin', name: 'case', rarity: 'common' },
      { id: 'skin-c', kind: 'hat', name: 'kind', rarity: 'common' },
      { id: 'skin-d', kind: 'skin', name: 'tint', rarity: 'common', tint: [9, 0, 0] },
      { id: 'title-c', kind: 'title', name: 'quiet', rarity: 'common', text: '' },
    ]) {
      const r = parseItemsManifest(good({ extra: [bad] }));
      if (bad.id === 'skin-d') {
        // An off-range tint is nulled, not fatal — the item still parses flat.
        expect(r.manifest?.items.find((i) => i.id === 'skin-d')?.tint).toBeNull();
      } else {
        expect(r.manifest, JSON.stringify(bad)).toBeNull();
      }
    }
  });
});

describe('refs and derived state', () => {
  it('round-trips a ref and refuses a malformed one', () => {
    const ref = formatItemRef(3, 'skin-a');
    expect(ref).toBe('items@3:skin-a');
    expect(parseItemRef(ref)).toEqual({ version: 3, localId: 'skin-a' });
    for (const bad of ['items@0:x', 'levels@1:x', 'items@1:UPPER', 'items@70000:x', 'junk']) {
      expect(parseItemRef(bad), bad).toBeNull();
    }
  });

  it('derives ACTIVE from the live pack, DORMANT from absence, REVOKED only from the operator', () => {
    const live = new Set(['skin-a']);
    const revoked = new Set(['items@1:skin-a']);
    expect(itemStateFor('items@1:skin-a', live, new Set())).toBe('active');
    // The granting VERSION is provenance: a v1 grant is active while the id
    // survives in the live pack, whatever version that is.
    expect(itemStateFor('items@9:skin-a', live, new Set())).toBe('active');
    expect(itemStateFor('items@1:skin-gone', live, new Set())).toBe('dormant');
    expect(itemStateFor('items@1:skin-a', live, revoked)).toBe('revoked');
    expect(itemStateFor('not-a-ref', live, new Set())).toBe('dormant');
  });

  it('fingerprint inputs are id-sorted so manifest order never moves the pack', () => {
    const a = parseItemsManifest(good()).manifest!;
    const swapped = parseItemsManifest(JSON.stringify({
      items: [
        { id: 'title-b', kind: 'title', name: 'B', rarity: 'rare', tradable: false, text: 'The B' },
        { id: 'skin-a', kind: 'skin', name: 'A', rarity: 'common', tradable: true, tint: [1, 1, 1] },
      ],
    })).manifest!;
    expect(itemsFingerprintInputs(a)).toEqual(itemsFingerprintInputs(swapped));
    expect(itemsFingerprintInputs(a)[1]).toContain('title-b');
    expect(ItemKind.TITLE).toBe(3);
  });
});
