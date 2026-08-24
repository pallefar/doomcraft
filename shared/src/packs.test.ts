/**
 * DOOMCRAFT — content pack identity and release resolution.
 *
 * Ratchets and behaviour, same split as version.test.ts. The per-pack
 * fingerprint ratchets live there (core, weapons) and in
 * client/src/characters/characters.test.ts (characters); what lives here is
 * the fold, the resolver, and the invariants docs/PACKS.md commits to:
 * order-insensitivity, kind/version/fingerprint sensitivity, freeze ordering,
 * and the total-function fallback that keeps one bad document from becoming
 * a fleet-wide 503.
 */

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_CONTENT_HASH,
  BUILTIN_PACKS,
  BUILTIN_RELEASE,
  PACKS,
  PackKind,
  campaignPack,
  levelsPack,
  packBucket,
  packSetHash,
  releaseAt,
  resolveRelease,
  type PackVersion,
  type Release,
  type ReleaseDoc,
} from './packs.ts';
import {
  CONTENT_VERSION,
  coreFingerprintInputs,
  fingerprint,
  weaponsFingerprintInputs,
} from './version.ts';
import { charactersFingerprintInputs } from './characters.ts';

const pack = (kind: PackKind, version: number, fp: number): PackVersion => ({
  kind, key: `k${kind}`, version, fingerprint: fp, inputs: [], digest: '', label: `k${kind}@${version}`,
});

describe('packSetHash', () => {
  const a = pack(PackKind.CORE, 1, 0x1111);
  const b = pack(PackKind.WEAPONS, 2, 0x2222);
  const c = pack(PackKind.LEVELS, 3, 0x3333);

  it('is insensitive to the input array order', () => {
    expect(packSetHash([a, b, c], 1)).toBe(packSetHash([c, a, b], 1));
  });

  it('is sensitive to any pack\'s kind, version or fingerprint, and to the ordinal', () => {
    const base = packSetHash([a, b, c], 1);
    expect(packSetHash([pack(PackKind.CAMPAIGN, 1, 0x1111), b, c], 1)).not.toBe(base);
    expect(packSetHash([pack(PackKind.CORE, 9, 0x1111), b, c], 1)).not.toBe(base);
    expect(packSetHash([pack(PackKind.CORE, 1, 0x9999), b, c], 1)).not.toBe(base);
    expect(packSetHash([a, b, c], 2)).not.toBe(base);
  });
});

describe('the builtin release', () => {
  it('declares fingerprints AND input literals that match what this binary computes', () => {
    // The compiled-in half of gate check `packs.declared`, both directions:
    // the checked-in fingerprint must equal the FNV over the checked-in
    // inputs (self-consistency), and the checked-in inputs must equal what
    // the binary computes now — the literals are what let a firing ratchet
    // print a LINE DIFF instead of two hex numbers. When this fails, a pack
    // changed without its declaration moving: bump its version and paste the
    // new fingerprint and changed lines in shared/src/packs.ts, same commit.
    const computed: Record<number, readonly string[]> = {
      [PackKind.CORE]: coreFingerprintInputs(),
      [PackKind.WEAPONS]: weaponsFingerprintInputs(),
      [PackKind.CHARACTERS]: charactersFingerprintInputs(),
    };
    for (const p of BUILTIN_PACKS) {
      expect(fingerprint(p.inputs.join('|')), p.label).toBe(p.fingerprint);
      expect([...p.inputs], p.label).toEqual([...computed[p.kind]]);
    }
  });

  it('covers exactly the three build packs, each with a PackDef and a blast radius', () => {
    expect(BUILTIN_PACKS.map((p) => p.kind).sort((x, y) => x - y))
      .toEqual([PackKind.CORE, PackKind.WEAPONS, PackKind.CHARACTERS].sort((x, y) => x - y));
    for (const p of BUILTIN_PACKS) {
      const def = PACKS[p.kind];
      expect(def?.cls).toBe('build');
      expect(def?.key).toBe(p.key);
      expect((def?.blastRadius ?? '').length).toBeGreaterThan(0);
      expect(p.digest).toBe('');
    }
  });

  it('reserves QUESTS and ITEMS as numbers with NO PackDef', () => {
    // A green check on a pack kind with no content is exactly the green test
    // that cannot fail (docs/PACKS.md §1.3). The kinds exist; nothing else may.
    expect(PackKind.QUESTS).toBe(5);
    expect(PackKind.ITEMS).toBe(6);
    expect(PACKS[PackKind.QUESTS]).toBeUndefined();
    expect(PACKS[PackKind.ITEMS]).toBeUndefined();
  });

  it('is what a default room stamps on SESSION_CONFIG', () => {
    expect(BUILTIN_CONTENT_HASH).toBe(packSetHash(BUILTIN_PACKS, CONTENT_VERSION));
    expect(BUILTIN_RELEASE.ordinal).toBe(CONTENT_VERSION);
    expect(BUILTIN_RELEASE.revision).toBe(0);
    expect(BUILTIN_RELEASE.state).toBe('live');
  });
});

describe('data pack builders', () => {
  it('levelsPack sorts by id so scan order never moves the fingerprint', () => {
    const x = levelsPack([{ id: 'b', hash: 2 }, { id: 'a', hash: 1 }]);
    const y = levelsPack([{ id: 'a', hash: 1 }, { id: 'b', hash: 2 }]);
    expect(x.fingerprint).toBe(y.fingerprint);
    expect(x.inputs).toEqual(['a:00000001', 'b:00000002']);
  });

  it('campaignPack folds the order, the membership and the default pointer', () => {
    const m = { defaultEpisode: 'e1', episodes: [{ id: 'e1', levels: ['a', 'b'] }] };
    const base = campaignPack(m).fingerprint;
    expect(campaignPack({ ...m, defaultEpisode: 'e2' }).fingerprint).not.toBe(base);
    expect(campaignPack({ ...m, episodes: [{ id: 'e1', levels: ['b', 'a'] }] }).fingerprint).not.toBe(base);
  });
});

/* ------------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------------ */

const release = (revision: number, over: Partial<Release> = {}): Release => ({
  revision,
  state: 'live',
  ordinal: revision,
  packs: BUILTIN_PACKS,
  rolloutBp: 10000,
  baseRevision: 0,
  gate: null,
  createdMs: 0,
  publishedMs: 0,
  note: 'test',
  ...over,
});

const doc = (over: Partial<ReleaseDoc> = {}): ReleaseDoc => ({
  history: [],
  liveRevision: 0,
  pendingRevision: 0,
  frozen: false,
  revision: 1,
  ...over,
});

describe('resolveRelease', () => {
  it('is total: an unreachable liveRevision falls back to the builtin, never throws', () => {
    // One bad document must never become a 503 on every room creation
    // (docs/PACKS.md 8.3). liveRevision 7 with an empty history is exactly
    // the eviction bug the history cap could produce.
    const r = resolveRelease(doc({ liveRevision: 7 }), 'room', BUILTIN_RELEASE);
    expect(r).toBe(BUILTIN_RELEASE);
  });

  it('serves the live release when nothing is pending', () => {
    const live = release(3);
    const d = doc({ history: [live], liveRevision: 3 });
    expect(resolveRelease(d, 'room', BUILTIN_RELEASE)).toBe(live);
  });

  it('ignores a pending revision that is not actually staged', () => {
    const live = release(3);
    const draft = release(4, { state: 'draft' });
    const d = doc({ history: [live, draft], liveRevision: 3, pendingRevision: 4 });
    expect(resolveRelease(d, 'room', BUILTIN_RELEASE)).toBe(live);
  });

  it('freeze beats EVERY staged release, including one staged at 10000', () => {
    // The deliberate divergence from resolveFlag, where bp >= 10000
    // short-circuits before the freeze check. Here `staged` at 10000 is
    // still awaiting promote, and the panic button must be able to stop the
    // release that most needs stopping (docs/PACKS.md 8.2).
    const live = release(3);
    const staged = release(4, { state: 'staged', rolloutBp: 10000 });
    const d = doc({ history: [live, staged], liveRevision: 3, pendingRevision: 4, frozen: true });
    expect(resolveRelease(d, 'room', BUILTIN_RELEASE)).toBe(live);
    // And freeze leaves the LIVE release alone: unfreezing is not needed to serve.
    expect(resolveRelease(doc({ history: [live], liveRevision: 3, frozen: true }), 'r', BUILTIN_RELEASE)).toBe(live);
  });

  it('a staged release at 0 reaches nobody and at 10000 reaches every new room', () => {
    const live = release(3);
    const stagedOff = release(4, { state: 'staged', rolloutBp: 0 });
    const stagedFull = release(4, { state: 'staged', rolloutBp: 10000 });
    expect(resolveRelease(
      doc({ history: [live, stagedOff], liveRevision: 3, pendingRevision: 4 }), 'r', BUILTIN_RELEASE,
    )).toBe(live);
    expect(resolveRelease(
      doc({ history: [live, stagedFull], liveRevision: 3, pendingRevision: 4 }), 'r', BUILTIN_RELEASE,
    )).toBe(stagedFull);
  });

  it('buckets a partial rollout per ROOM instance id, deterministically', () => {
    const live = release(3);
    const staged = release(4, { state: 'staged', rolloutBp: 5000 });
    const d = doc({ history: [live, staged], liveRevision: 3, pendingRevision: 4 });
    // Deterministic: the same instance id always lands on the same side.
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(resolveRelease(d, id, BUILTIN_RELEASE)).toBe(resolveRelease(d, id, BUILTIN_RELEASE));
    }
    // And at bp 5000, ids land on BOTH sides — the bucket varies with the id.
    const sides = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
      .map((id) => resolveRelease(d, id, BUILTIN_RELEASE).revision));
    expect(sides.size).toBe(2);
  });

  it('packBucket spans the space and stays in 0..9999', () => {
    let min = 10000, max = -1;
    for (let i = 0; i < 500; i++) {
      const b = packBucket(`instance-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10000);
      min = Math.min(min, b); max = Math.max(max, b);
    }
    expect(max - min).toBeGreaterThan(5000);
  });

  it('releaseAt never resolves revision 0, which is the builtin\'s marker', () => {
    const d = doc({ history: [release(0)], liveRevision: 0 });
    expect(releaseAt(d, 0)).toBeNull();
  });
});
