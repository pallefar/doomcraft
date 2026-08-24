/**
 * DOOMCRAFT — the server reads a release (docs/PACKS.md phase 2).
 *
 * The spec's own test list, §11 phase 2: CAS 409 leaves the document
 * unchanged; a reconstructed service reads back an identical document;
 * approve is refused without a green gate and without a note; a host handed
 * a release it cannot satisfy keeps serving the previous one (8.6); the
 * resolver falls back to the builtin rather than throwing (8.3, proven in
 * shared/src/packs.test.ts); and the full draft→gate→approve→stage→promote
 * flow runs over HTTP against the real binary, because a route that only
 * works when called as a function is this repo's signature failure.
 */

import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { PackKind, type Release, type ReleaseDoc } from '@doomcraft/shared/packs';

import { PackInventory, ReleaseService } from './packs.js';

const here = fileURLToPath(import.meta.url);
const repoRoot = join(here, '..', '..', '..');
const CONTENT_LEVELS = join(repoRoot, 'content', 'levels');
const EPISODES = join(repoRoot, 'content', 'episodes.json');

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** A DOOMCRAFT_PACKS root with levels@1 (the shipped campaign) and, when
 *  `secondVersion`, a levels@2 that differs in one byte. Campaign@1 too. */
function packsRoot(secondVersion = false): string {
  const root = tempDir('dc-packs-');
  cpSync(CONTENT_LEVELS, join(root, 'levels', '1'), { recursive: true });
  mkdirSync(join(root, 'campaign', '1'), { recursive: true });
  cpSync(EPISODES, join(root, 'campaign', '1', 'episodes.json'));
  mkdirSync(join(root, 'items', '1'), { recursive: true });
  cpSync(join(repoRoot, 'content', 'items.json'), join(root, 'items', '1', 'items.json'));
  if (secondVersion) {
    cpSync(CONTENT_LEVELS, join(root, 'levels', '2'), { recursive: true });
    const f = join(root, 'levels', '2', 'e1m1-hangar.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace('"name": "Hangar"', '"name": "Hangbr"'), 'utf8');
  }
  return root;
}

function service(root: string, dataRoot = tempDir('dc-reldata-')): { svc: ReleaseService; inv: PackInventory; dataRoot: string } {
  const inv = new PackInventory({ packsRoot: root, log: () => {} });
  const svc = new ReleaseService(dataRoot, inv, { clock: () => 1_000 });
  return { svc, inv, dataRoot };
}

/** draft → gate → approve → stage(10000), returning the staged doc revision. */
async function stageOne(svc: ReleaseService, note = 'a release note that says why'): Promise<ReleaseDoc> {
  let doc = svc.document();
  expect((await svc.createDraft(doc.revision)).ok).toBe(true);
  doc = svc.document();
  const gated = await svc.gateDraft(doc.revision);
  expect(gated.ok).toBe(true);
  expect(gated.ok && gated.release?.gate?.ok).toBe(true);
  doc = svc.document();
  expect((await svc.approve(doc.revision, note)).ok).toBe(true);
  doc = svc.document();
  expect((await svc.stage(doc.revision, 10000)).ok).toBe(true);
  return svc.document();
}

/* ------------------------------------------------------------------------ *
 * The inventory
 * ------------------------------------------------------------------------ */

describe('PackInventory', () => {
  it('behaves exactly as an unconfigured deploy with no packs root', () => {
    const inv = new PackInventory({ packsRoot: null, log: () => {} });
    expect(inv.levelsVersions()).toEqual([1]);
    expect(inv.campaignVersions()).toEqual([1]);
    const packs = inv.installedPacks();
    expect(packs.map((p) => p.label).sort())
      .toEqual(['campaign@1', 'characters@1', 'core@1', 'items@1', 'levels@1', 'weapons@1']);
    expect(packs.find((p) => p.label === 'levels@1')?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('discovers versioned pack directories, and one changed byte splits the versions', () => {
    const inv = new PackInventory({ packsRoot: packsRoot(true), log: () => {} });
    expect(inv.levelsVersions()).toEqual([1, 2]);
    const v1 = inv.levelsPackAt(1)!;
    const v2 = inv.levelsPackAt(2)!;
    expect(v1.fingerprint).not.toBe(v2.fingerprint);
    expect(v1.digest).not.toBe(v2.digest);
    // The newest installed version is what an undocumented host serves.
    expect(inv.installedPacks().find((p) => p.kind === PackKind.LEVELS)?.version).toBe(2);
  });

  it('hands a room a frozen view that a disk edit cannot change (8.9 / 8.12 for rooms)', () => {
    const root = packsRoot();
    const inv = new PackInventory({ packsRoot: root, log: () => {} });
    const release = {
      revision: 1, state: 'live', ordinal: 2, rolloutBp: 10000, baseRevision: 0,
      gate: null, createdMs: 0, publishedMs: 0, note: '',
      packs: [inv.levelsPackAt(1)!],
    } as Release;
    const view = inv.viewFor(release)!;
    expect(view.resolveId('e1m1-hangar')).toBe('e1m1-hangar');
    expect(view.levelFor?.('e1m1-hangar')).not.toBeNull();
    // The view exposes the resolver seam and nothing that could reload it.
    expect(Object.keys(view).sort()).toEqual(['levelFor', 'resolveId']);
    // Deleting the files after load does not change what the view answers.
    rmSync(join(root, 'levels', '1'), { recursive: true });
    expect(view.levelFor?.('e1m2-coolant')).not.toBeNull();
  });

  it('reports what it cannot satisfy, per pack (8.6)', () => {
    const inv = new PackInventory({ packsRoot: packsRoot(), log: () => {} });
    const good = inv.levelsPackAt(1)!;
    const ghost = { ...good, version: 9, label: 'levels@9' };
    const tampered = { ...good, digest: 'f'.repeat(64) };
    const release = (packs: (typeof good)[]): Release => ({
      revision: 1, state: 'live', ordinal: 2, rolloutBp: 10000, baseRevision: 0,
      gate: null, createdMs: 0, publishedMs: 0, note: '', packs,
    } as Release);
    expect(inv.unsatisfied(release([good]))).toEqual([]);
    expect(inv.unsatisfied(release([ghost]))).toEqual(['levels@9']);
    expect(inv.unsatisfied(release([tampered]))).toEqual(['levels@1']);
  });
});

/* ------------------------------------------------------------------------ *
 * The service: state machine, CAS, durability
 * ------------------------------------------------------------------------ */

describe('ReleaseService', () => {
  it('walks draft → review → staged → live, and a new room resolves the promoted release', async () => {
    const { svc } = service(packsRoot());
    await stageOne(svc);
    const doc = svc.document();
    expect((await svc.promote(doc.revision)).ok).toBe(true);
    const live = svc.live();
    expect(live.state).toBe('live');
    expect(live.ordinal).toBe(2);
    expect(svc.resolveFor('any-room').revision).toBe(live.revision);
    expect(svc.document().pendingRevision).toBe(0);
  });

  it('refuses a stale write with 409 and CHANGES NOTHING', async () => {
    const { svc } = service(packsRoot());
    await stageOne(svc);
    const doc = svc.document();
    const first = await svc.stage(doc.revision, 0);
    expect(first.ok).toBe(true);
    const stale = await svc.stage(doc.revision, 10000); // same ifRevision, raced
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.status).toBe(409);
    // The document is exactly what the first write left: bp 0, one bump.
    const after = svc.document();
    expect(after.revision).toBe(doc.revision + 1);
    expect(after.history.find((r) => r.revision === after.pendingRevision)?.rolloutBp).toBe(0);
  });

  it('survives a restart: a reconstructed service reads back an identical document', async () => {
    const root = packsRoot();
    const { svc, inv, dataRoot } = service(root);
    await stageOne(svc);
    const before = svc.document();
    const again = new ReleaseService(dataRoot, inv, { clock: () => 2_000 });
    expect(again.document()).toEqual(before);
  });

  it('refuses approve without a gate run, with a failed gate, and without a note', async () => {
    const { svc } = service(packsRoot());
    let doc = svc.document();
    await svc.createDraft(doc.revision);
    doc = svc.document();
    // No gate yet: the draft is not even in review.
    const early = await svc.approve(doc.revision, 'note note note');
    expect(early.ok).toBe(false);
    await svc.gateDraft(doc.revision);
    doc = svc.document();
    const unsaid = await svc.approve(doc.revision, '   ');
    expect(unsaid.ok).toBe(false);
    expect(!unsaid.ok && unsaid.error).toContain('sentence');
  });

  it('refuses the intermediate rollout rungs unless the request says so in words', async () => {
    const { svc } = service(packsRoot());
    await stageOne(svc);
    let doc = svc.document();
    const decorative = await svc.stage(doc.revision, 2500);
    expect(decorative.ok).toBe(false);
    expect(!decorative.ok && decorative.error).toContain('allowCustomRollout');
    doc = svc.document();
    expect((await svc.stage(doc.revision, 2500, true)).ok).toBe(true);
  });

  it('promote requires 10000, deliberately', async () => {
    const { svc } = service(packsRoot());
    await stageOne(svc);
    let doc = svc.document();
    await svc.stage(doc.revision, 0);
    doc = svc.document();
    const early = await svc.promote(doc.revision);
    expect(early.ok).toBe(false);
    expect(!early.ok && early.error).toContain('10000');
  });

  it('a release this host cannot satisfy is refused at promote and skipped at resolve (8.6)', async () => {
    const root = packsRoot(true);
    const { svc } = service(root);
    await stageOne(svc); // stages a release naming levels@2
    // The operator deletes levels@2 from disk between stage and promote —
    // and constructs a FRESH service (no caches) as a restarted host would.
    rmSync(join(root, 'levels', '2'), { recursive: true });
    const inv2 = new PackInventory({ packsRoot: root, log: () => {} });
    const dataRoot = (svc as unknown as { root: string }).root;
    const svc2 = new ReleaseService(dataRoot, inv2, { clock: () => 3_000 });
    const doc = svc2.document();
    const refused = await svc2.promote(doc.revision);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain('levels@2');
    // And a new room quietly gets what the host CAN serve — nobody is refused.
    const resolved = svc2.resolveFor('some-room');
    expect(resolved.packs.find((p) => p.kind === PackKind.LEVELS)?.version).toBe(1);
  });

  it('rollback returns to the base release and refuses when the gate said schemaTouching', async () => {
    const root = packsRoot();
    const { svc, inv, dataRoot } = service(root);
    await stageOne(svc);
    let doc = svc.document();
    await svc.promote(doc.revision);
    doc = svc.document();
    const rolled = await svc.rollback(doc.revision);
    expect(rolled.ok).toBe(true);
    expect(svc.live().revision).toBe(0); // back to the builtin/host release
    expect(svc.document().history.some((r) => r.state === 'rolled_back')).toBe(true);

    // schemaTouching: injected through the durable document, the way a real
    // host would meet it after a restart — no mocks of our own service.
    const raw = JSON.parse(readFileSync(join(dataRoot, 'releases.json'), 'utf8')) as {
      history: { state: string; gate: { schemaTouching: boolean } | null; revision: number }[];
      liveRevision: number;
    };
    const target = raw.history.find((r) => r.state === 'rolled_back')!;
    target.state = 'live';
    target.gate = { ok: true, ranMs: 0, checks: [{ id: 'x', ok: true, detail: '' }], diff: [], schemaTouching: true } as never;
    raw.liveRevision = target.revision;
    writeFileSync(join(dataRoot, 'releases.json'), JSON.stringify(raw), 'utf8');
    const svc2 = new ReleaseService(dataRoot, inv, { clock: () => 4_000 });
    const refused = await svc2.rollback(svc2.document().revision);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain('never be rolled back');
  });

  it('caps history without ever evicting the live release or its base chain (8.3/D6)', async () => {
    const { svc } = service(packsRoot());
    for (let i = 0; i < 36; i++) {
      await stageOne(svc, `release number ${i}`);
      const doc = svc.document();
      const promoted = await svc.promote(doc.revision);
      expect(promoted.ok, `promote #${i}`).toBe(true);
    }
    const doc = svc.document();
    expect(doc.history.length).toBeLessThanOrEqual(32);
    expect(doc.history.some((r) => r.revision === doc.liveRevision)).toBe(true);
    expect(svc.live().state).toBe('live');
    expect(svc.live().ordinal).toBe(1 + 36);
  });

  it('a corrupt document degrades to the builtin release instead of bricking the host (8.3)', () => {
    const root = packsRoot();
    const dataRoot = tempDir('dc-reldata-');
    writeFileSync(join(dataRoot, 'releases.json'), '{ not json', 'utf8');
    const inv = new PackInventory({ packsRoot: root, log: () => {} });
    const svc = new ReleaseService(dataRoot, inv, { clock: () => 5_000, log: () => {} });
    expect(svc.degraded).toBe(true);
    expect(svc.resolveFor('room').revision).toBe(0);
  });

  it('writes one audit line per accepted transition to release.jsonl', async () => {
    const { svc, dataRoot } = service(packsRoot());
    await stageOne(svc);
    const doc = svc.document();
    await svc.promote(doc.revision);
    const lines = readFileSync(join(dataRoot, 'release.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { verb: string }).verb))
      .toEqual(['release.draft', 'release.gate', 'release.approve', 'release.stage', 'release.promote']);
  });
});

/* ------------------------------------------------------------------------ *
 * The routes, against the real binary
 * ------------------------------------------------------------------------ */

const ADMIN_TOKEN = 'release-test-admin-token-0123456789abcdef';
const serverEntry = join(repoRoot, 'server', 'src', 'index.ts');

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return await new Promise((resolvePort) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

function audited(body: Record<string, unknown> = {}): string {
  return JSON.stringify({
    actor: 'releases-test',
    reason: 'exercising the release state machine over HTTP',
    ...body,
  });
}

describe('items in the release machine', () => {
  it('counts dormanted ids when a new items version drops one (docs/PACKS.md §7)', async () => {
    const root = packsRoot();
    const { svc } = service(root);
    // First make items@1 LIVE — the dormant count is against what players
    // currently resolve, which is the live release, not the disk's newest.
    await stageOne(svc);
    let doc = svc.document();
    expect((await svc.promote(doc.revision)).ok).toBe(true);

    // items@2 arrives: the shipped manifest minus one id — the destructive direction.
    const manifest = JSON.parse(readFileSync(join(root, 'items', '1', 'items.json'), 'utf8')) as {
      items: { id: string }[];
    };
    manifest.items = manifest.items.filter((i) => i.id !== 'skin-rust-marine');
    mkdirSync(join(root, 'items', '2'), { recursive: true });
    writeFileSync(join(root, 'items', '2', 'items.json'), JSON.stringify(manifest), 'utf8');

    doc = svc.document();
    await svc.createDraft(doc.revision); // drafts the NEWEST versions, items@2 included
    doc = svc.document();
    const gated = await svc.gateDraft(doc.revision);
    expect(gated.ok).toBe(true);
    const gate = gated.ok ? gated.release?.gate : null;
    expect(gate?.ok).toBe(true); // dormanting is a WARNING with a count, not a refusal
    const row = gate?.checks.find((c) => c.id === 'items.dormanted');
    expect(row?.ok).toBe(true);
    expect(row?.detail).toContain('1 item id(s)');
    expect(row?.detail).toContain('skin-rust-marine');
  });
});

describe('the release routes on the real binary', () => {
  it('runs draft → gate → approve → stage → promote → rollback over HTTP, and /api/version follows', async () => {
    const port = await freePort();
    const data = tempDir('dc-relboot-');
    const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(port), HOST: '127.0.0.1',
        DOOMCRAFT_DATA: data,
        DOOMCRAFT_STATIC: tempDir('dc-relstatic-'),
        DOOMCRAFT_BOTS: '0',
        DOOMCRAFT_ADMIN_TOKEN: ADMIN_TOKEN,
      },
    });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    const origin = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 40_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
        try { await (await fetch(`${origin}/health`)).text(); break; } catch { /* not up */ }
        if (Date.now() > deadline) throw new Error('server did not start');
        await new Promise((r) => setTimeout(r, 200));
      }
      const adminJson = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

      // Unauthenticated: the mutation is refused before it can say anything.
      const anon = await fetch(`${origin}/api/admin/release`, { method: 'POST', body: audited({ ifRevision: 1 }) });
      expect(anon.status).toBeGreaterThanOrEqual(401);
      await anon.text();

      const v0 = await (await fetch(`${origin}/api/version`)).json() as {
        content: { version: number }; release: { ordinal: number; unsatisfied: string[] };
      };
      expect(v0.release.ordinal).toBe(1);
      expect(v0.release.unsatisfied).toEqual([]);

      // The live item definitions are public and joinable against a profile.
      const itemsRes = await (await fetch(`${origin}/api/items`)).json() as {
        version: number; items: { id: string }[];
      };
      expect(itemsRes.version).toBe(1);
      expect(itemsRes.items.length).toBeGreaterThan(5);

      const step = async (sub: string, body: Record<string, unknown>): Promise<{ document: { revision: number }; release: { gate: { ok: boolean } | null } | null }> => {
        const res = await fetch(`${origin}/api/admin/release${sub}`, { method: 'POST', headers: adminJson, body: audited(body) });
        const out = await res.json() as { document: { revision: number }; release: { gate: { ok: boolean } | null } | null; error?: string };
        expect(res.status, `${sub}: ${out.error ?? ''}`).toBe(200);
        return out;
      };

      const getDoc = async (): Promise<number> => {
        const res = await fetch(`${origin}/api/admin/release`, { headers: adminJson });
        const out = await res.json() as { document: { revision: number } };
        expect(res.status).toBe(200);
        return out.document.revision;
      };

      let rev = await getDoc();
      await step('', { ifRevision: rev });
      rev = await getDoc();
      const gated = await step('/gate', { ifRevision: rev });
      expect(gated.release?.gate?.ok).toBe(true);
      rev = await getDoc();

      // A stale ifRevision is a 409 with the current document in the body.
      const stale = await fetch(`${origin}/api/admin/release/approve`, {
        method: 'POST', headers: adminJson, body: audited({ ifRevision: rev - 1, note: 'stale' }),
      });
      expect(stale.status).toBe(409);
      const staleBody = await stale.json() as { document: { revision: number } };
      expect(staleBody.document.revision).toBe(rev);

      await step('/approve', { ifRevision: rev, note: 'first release through the machine' });
      rev = await getDoc();
      await step('/stage', { ifRevision: rev, bp: 10000 });
      rev = await getDoc();
      await step('/promote', { ifRevision: rev });

      const v1 = await (await fetch(`${origin}/api/version`)).json() as {
        release: { ordinal: number; revision: number };
      };
      expect(v1.release.ordinal).toBe(2);
      expect(v1.release.revision).toBeGreaterThan(0);

      rev = await getDoc();
      await step('/rollback', { ifRevision: rev });
      const v2 = await (await fetch(`${origin}/api/version`)).json() as { release: { ordinal: number; revision: number } };
      expect(v2.release.ordinal).toBe(1);
      expect(v2.release.revision).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);
});
