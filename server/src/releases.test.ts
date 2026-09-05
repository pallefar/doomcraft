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

import {
  BUILTIN_PACKS,
  PackKind,
  type GateReport,
  type PackVersion,
  type Release,
  type ReleaseDoc,
} from '@doomcraft/shared/packs';
import { weaponsFingerprintInputs } from '@doomcraft/shared/version';
import { SessionArsenal } from '@doomcraft/shared/arsenal';
import {
  CAP_VARIANTS, PacketReader, PacketWriter, S2C, encodeHello,
} from '@doomcraft/shared/protocol';
import {
  VARIANT_FIELDS, createVariantTableMessage, decodeVariantTable, overlaysFromWire,
  parseVariantsManifest, wireValuesFor,
} from '@doomcraft/shared/variants';
import { WEAPONS, WeaponId } from '@doomcraft/shared/weapons';

import { PackInventory, ReleaseService } from './packs.js';
import { Room } from './room.js';

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
/** A real, parseable variants manifest — the doc's own two V4 rows. */
const VARIANTS_JSON = JSON.stringify({
  variants: [
    {
      id: 'shotgun-slug', base: 1, name: 'Slug Shotgun',
      over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 },
    },
    { id: 'pistol-burst', base: 0, name: 'Burst Pistol', over: { rpm: 620, damage: 12 } },
  ],
});

function installVariants(root: string, version = 1, body = VARIANTS_JSON): void {
  mkdirSync(join(root, 'variants', String(version)), { recursive: true });
  writeFileSync(join(root, 'variants', String(version), 'variants.json'), body, 'utf8');
}

function packsRoot(secondVersion = false, withVariants = false): string {
  const root = tempDir('dc-packs-');
  cpSync(CONTENT_LEVELS, join(root, 'levels', '1'), { recursive: true });
  mkdirSync(join(root, 'campaign', '1'), { recursive: true });
  cpSync(EPISODES, join(root, 'campaign', '1', 'episodes.json'));
  mkdirSync(join(root, 'items', '1'), { recursive: true });
  cpSync(join(repoRoot, 'content', 'items.json'), join(root, 'items', '1', 'items.json'));
  if (withVariants) installVariants(root);
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
    // The build packs carry their declared VERSIONS, which move whenever a
    // ratchet fires — `weapons@2` since the fingerprint widened on 2026-09-05.
    // Spelling them out here made a legitimate pack bump fail a test about
    // whether an unconfigured deploy finds its data packs, which is a
    // different claim. The KINDS are the claim; the versions come from the
    // declaration.
    const declared = new Map(BUILTIN_PACKS.map((p) => [p.key, p.label]));
    expect(packs.map((p) => p.label).sort()).toEqual([
      'campaign@1', declared.get('characters'), declared.get('core'),
      'items@1', 'levels@1', 'quests@1', 'variants@1', declared.get('weapons'),
    ].sort());
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
    // The quests branch — the S4 lesson: a data kind with NO branch in
    // unsatisfied() is silently unsatisfiable forever, so the branch is
    // proven able to say both yes and no before anything serves it.
    const quests = inv.questsAt(1)!.pack;
    const questsGhost = { ...quests, version: 9, label: 'quests@9' };
    const questsTampered = { ...quests, digest: 'f'.repeat(64) };
    expect(inv.unsatisfied(release([quests]))).toEqual([]);
    expect(inv.unsatisfied(release([questsGhost]))).toEqual(['quests@9']);
    expect(inv.unsatisfied(release([questsTampered]))).toEqual(['quests@1']);
  });

  it('satisfies an INSTALLED variants pack — the only way its branch is visible', () => {
    /*
     * Read this before changing it. The fallthrough at the bottom of
     * `unsatisfied()` already pushes any kind with no branch, so a
     * NOT-installed variants pack reads as unsatisfied with or without the
     * branch — an assertion on that case cannot fail and would be rule 2 in a
     * disguise. The branch is only observable in the positive direction: an
     * installed pack must come back SATISFIED. Delete the branch and this line
     * goes red, which is exactly the S4 lesson the fallthrough's own comment
     * records.
     */
    const root = packsRoot(false, true);
    const inv = new PackInventory({ packsRoot: root, log: () => {} });
    const variants = inv.variantsAt(1)!.pack;
    expect(variants.label).toBe('variants@1');
    const release = (packs: Release['packs'][number][]): Release => ({
      revision: 1, state: 'live', ordinal: 2, rolloutBp: 10000, baseRevision: 0,
      gate: null, createdMs: 0, publishedMs: 0, note: '', packs,
    } as Release);
    expect(inv.unsatisfied(release([variants]))).toEqual([]);
    expect(inv.unsatisfied(release([{ ...variants, version: 9, label: 'variants@9' }]))).toEqual(['variants@9']);
    expect(inv.unsatisfied(release([{ ...variants, digest: 'f'.repeat(64) }]))).toEqual(['variants@1']);
  });

  it('refuses to install a variants manifest the schema rejects', () => {
    // A straight upgrade — better on every axis, worse on none.
    const root = packsRoot();
    installVariants(root, 1, JSON.stringify({
      variants: [{ id: 'cheat', base: 0, name: 'Cheat', over: { damage: 40 } }],
    }));
    const inv = new PackInventory({ packsRoot: root, log: () => {} });
    // `variantsAt` is the load-bearing one: null means it can never be drafted
    // and can never gate green. `variantsVersions` still LISTS it, exactly as
    // `itemsVersions` lists an items version whose manifest does not parse —
    // the directory is on disk and the operator should see that it is there
    // and unusable, rather than have it vanish.
    expect(inv.variantsAt(1)).toBeNull();
    expect(inv.variantsVersions()).toEqual([1]);
    expect(inv.itemsVersions().length, 'the same shape items has').toBeGreaterThan(0);
  });

  it('carries an installed variants pack in the boot identity', () => {
    // `installedPacks()` is where `createDraft` starts before applying picks,
    // so a kind missing from it is silently DROPPED from the next routine
    // draft — a live variants pack would vanish from the following release
    // without anyone asking for that.
    const inv = new PackInventory({ packsRoot: packsRoot(false, true), log: () => {} });
    expect(inv.installedPacks().map((p) => p.label)).toContain('variants@1');
  });

  /*
   * REPLACES 'has no variants until one is installed — V2 ships the binary,
   * not content'. That test asserted `variantsVersions()` was `[]` on a host
   * with a packs root but no variants directory, and its premise expired in
   * V4a: `content/variants.json` IS variants@1 now, exactly as
   * `content/items.json` is items@1. Deleting it outright would have thrown
   * away the property it was really guarding — that a host answers about
   * variants the same way it answers about every other data kind — so it is
   * rewritten to assert the new answer rather than removed.
   */
  it('falls back to content/variants.json as version 1, like every other data kind', () => {
    const unconfigured = new PackInventory({ packsRoot: null, log: () => {} });
    expect(unconfigured.variantsVersions()).toEqual([1]);
    expect(unconfigured.variantsAt(1)?.pack.label).toBe('variants@1');
    expect(unconfigured.variantsAt(1)?.manifest.variants.length).toBeGreaterThan(0);
    expect(unconfigured.installedPacks().map((p) => p.label)).toContain('variants@1');
    // A packs root with no variants directory still resolves the bundled one:
    // the fallback is the FLOOR for every host, not a special case of "no
    // DOOMCRAFT_PACKS at all". That is what `itemsFileFor` does above it.
    const halfPopulated = new PackInventory({ packsRoot: packsRoot(), log: () => {} });
    expect(halfPopulated.variantsVersions()).toEqual([1]);
    expect(halfPopulated.variantsAt(1)).not.toBeNull();
  });

  /*
   * PACKSROOT PRECEDENCE. Written the way the failure would actually arrive:
   * the operator installs a variants@1 of their own and the bundled file must
   * not shadow it. Reverse the two branches in `variantsFileFor` and this
   * host serves the repo's two-row pack under the label of the operator's
   * one-row pack — a green gate over content nobody approved, which is the
   * worst outcome this system has. The counts are deliberately DIFFERENT so
   * one can be seen to lose; equal counts would make the assertion pass under
   * either order.
   */
  it('prefers an INSTALLED variants@1 over the bundled one, never the reverse', () => {
    const root = packsRoot();
    installVariants(root, 1, JSON.stringify({
      variants: [{ id: 'pistol-burst', base: 0, name: 'Burst Pistol', over: { rpm: 620, damage: 12 } }],
    }));
    const inv = new PackInventory({ packsRoot: root, log: () => {} });
    const at = inv.variantsAt(1);
    expect(at?.manifest.variants.map((v) => v.id)).toEqual(['pistol-burst']);

    // And the two are not interchangeable at the same version number: the
    // digests differ, so a release pinned to one is REFUSED on a host that
    // resolves the other rather than silently served the substitute.
    const bundled = new PackInventory({ packsRoot: null, log: () => {} }).variantsAt(1);
    expect(bundled).not.toBeNull();
    expect(at!.pack.digest).not.toBe(bundled!.pack.digest);
    const release = {
      revision: 1, state: 'live', ordinal: 2, rolloutBp: 10000, baseRevision: 0,
      gate: null, createdMs: 0, publishedMs: 0, note: '', packs: [bundled!.pack],
    } as unknown as Release;
    expect(inv.unsatisfied(release)).toEqual(['variants@1']);
  });
});

/* ------------------------------------------------------------------------ *
 * The PRODUCTION gate, which is not the same code as gate.ts
 * ------------------------------------------------------------------------ */

describe('the production gate and pack kind 7', () => {
  it('REFUSES a draft whose variants pack is gone by the time the gate runs', async () => {
    /*
     * The finding this test exists for: `runReleaseVerify()` in gate.ts and
     * `ReleaseService.runGate()` in packs.ts are two separate implementations,
     * and a check added to the first is not added to the second. Before the
     * variants block existed in runGate, a candidate naming kind 7 gated GREEN
     * and then fell back at serve time — a green review and the wrong game.
     *
     * Drafted while installed, then removed from disk before the gate runs,
     * which is the realistic shape: a draft names a version and the gate is
     * the thing that re-reads the host.
     */
    const root = packsRoot(false, true);
    const { svc } = service(root);
    let doc = svc.document();
    expect((await svc.createDraft(doc.revision, { variants: 1 })).ok).toBe(true);

    rmSync(join(root, 'variants', '1'), { recursive: true });

    doc = svc.document();
    const gated = await svc.gateDraft(doc.revision);
    expect(gated.ok).toBe(true);
    const report = gated.ok ? gated.release?.gate : null;
    expect(report?.ok, 'the production gate must not pass an uninstallable kind 7').toBe(false);
    /*
     * WHICH REFUSAL, AND WHY IT MOVED IN V4a. Deleting `variants/1` used to
     * leave the host with no version 1 at all, so the row read "is not
     * installed on this host". `content/variants.json` is now the version-1
     * FLOOR, so the host resolves a variants@1 again — a DIFFERENT one, whose
     * digest is not the digest the draft recorded — and the refusal lands on
     * the digest branch instead.
     *
     * The property under test is unchanged and the fallback does not weaken
     * it: the gate must not go green over a kind 7 whose approved bytes are
     * gone. Asserting the exact sentence rather than merely `ok === false`
     * keeps that honest — a refusal for some unrelated reason would satisfy
     * the boolean and tell us nothing.
     */
    expect(JSON.stringify(report?.checks)).toContain('variants@1: digest mismatch');
  });

  it('and says "not installed" when the version has no bundled floor under it', async () => {
    /*
     * The other half of the branch above, kept alive because V4a moved the
     * version-1 case off it. Only version 1 falls back to `content/`, so a
     * draft pinned to variants@2 that vanishes lands on the "not installed"
     * message — and if that message ever stops being reachable, this goes red
     * rather than the string quietly becoming dead code.
     */
    const root = packsRoot(false, true);
    installVariants(root, 2);
    const { svc } = service(root);
    let doc = svc.document();
    expect((await svc.createDraft(doc.revision, { variants: 2 })).ok).toBe(true);

    rmSync(join(root, 'variants', '2'), { recursive: true });

    doc = svc.document();
    const gated = await svc.gateDraft(doc.revision);
    const report = gated.ok ? gated.release?.gate : null;
    expect(report?.ok).toBe(false);
    expect(JSON.stringify(report?.checks)).toContain('variants@2 is not installed on this host');
  });

  it('passes a draft naming a variants pack it DOES have, and says how many parsed', async () => {
    const root = packsRoot(false, true);
    const { svc } = service(root);
    const doc = svc.document();
    expect((await svc.createDraft(doc.revision, { variants: 1 })).ok).toBe(true);
    const drafted = svc.document();
    const draft = drafted.history.find((r) => r.state === 'draft');
    expect(draft?.packs.some((p) => p.label === 'variants@1')).toBe(true);

    const gated = await svc.gateDraft(drafted.revision);
    const report = gated.ok ? gated.release?.gate : null;
    expect(report?.ok, JSON.stringify(report?.checks)).toBe(true);
    const json = JSON.stringify(report?.checks);
    expect(json).toContain('variants.validate');
    expect(json).toContain('2 variant(s) parse, band and budget');
  });

  /*
   * An INVALID NEWEST version of a data kind.
   *
   * `installedPacks()` resolved each data kind by trying only the newest
   * installed version and omitting the kind entirely when it failed to parse.
   * Install a good variants@1 and a bad variants@2 and an ordinary draft
   * therefore carried NO kind 7 at all — so `runGate`'s whole variants block,
   * `variants.dormanted` included, was skipped, and the gate returned OK for a
   * release that serves no variants and loses the perfectly good variants@1.
   *
   * That is the exact failure the "the pack disappears after drafting" test
   * above cannot see: this one happens BEFORE the draft is assembled.
   */
  const BROKEN_VARIANTS_JSON = JSON.stringify({
    variants: [{ id: 'cheat', base: 0, name: 'Cheat', over: { damage: 40 } }],
  });

  it('REFUSES the gate when an installed variants version does not parse', async () => {
    const root = packsRoot(false, true);
    installVariants(root, 2, BROKEN_VARIANTS_JSON);
    const { svc, inv } = service(root);
    // The premise: version 2 is on disk, is listed, and cannot be read.
    expect(inv.variantsVersions()).toEqual([1, 2]);
    expect(inv.variantsAt(2)).toBeNull();

    let doc = svc.document();
    expect((await svc.createDraft(doc.revision)).ok).toBe(true);   // no picks: the ORDINARY draft
    doc = svc.document();
    const gated = await svc.gateDraft(doc.revision);
    const report = gated.ok ? gated.release?.gate : null;
    expect(report?.ok, `the gate must not go green over an unreadable pack: ${JSON.stringify(report?.checks)}`).toBe(false);
    const parse = report?.checks.find((c) => c.id === 'packs.parse');
    expect(parse?.ok).toBe(false);
    expect(parse?.detail).toContain('variants@2');
  });

  it('keeps the newest variants version that DOES parse in the boot identity', () => {
    const root = packsRoot(false, true);
    installVariants(root, 2, BROKEN_VARIANTS_JSON);
    const inv = new PackInventory({ packsRoot: root, log: () => {} });
    /*
     * Dropping kind 7 would leave an unconfigured host — and every Rule E
     * fallback — serving NO variants at all, which is a bigger loss than the
     * version that failed to install. The good version is what this host can
     * actually serve, so it is what it reports serving.
     */
    const labels = inv.installedPacks().map((p) => p.label);
    expect(labels).toContain('variants@1');
    expect(labels).not.toContain('variants@2');
  });

  it('has the same hole for items, and the same check closes it', async () => {
    const root = packsRoot();
    mkdirSync(join(root, 'items', '2'), { recursive: true });
    writeFileSync(join(root, 'items', '2', 'items.json'), '{ not json', 'utf8');
    const { svc, inv } = service(root);
    expect(inv.itemsVersions()).toEqual([1, 2]);
    expect(inv.itemsAt(2)).toBeNull();
    expect(inv.installedPacks().map((p) => p.label)).toContain('items@1');

    let doc = svc.document();
    expect((await svc.createDraft(doc.revision)).ok).toBe(true);
    doc = svc.document();
    const gated = await svc.gateDraft(doc.revision);
    const report = gated.ok ? gated.release?.gate : null;
    expect(report?.ok).toBe(false);
    expect(report?.checks.find((c) => c.id === 'packs.parse')?.detail).toContain('items@2');
  });

  it('still gates GREEN, and still serves kind 7, when the newest version is valid', async () => {
    /*
     * A gate that cannot pass is worth what one that cannot fail is worth.
     * Two valid versions installed: the draft must pick the newest, the gate
     * must go green, and `unsatisfied` must agree the host can serve exactly
     * what the draft names — the check above refuses ambiguity, not variants.
     */
    const root = packsRoot(false, true);
    installVariants(root, 2);
    const { svc, inv } = service(root);
    let doc = svc.document();
    expect((await svc.createDraft(doc.revision)).ok).toBe(true);
    doc = svc.document();
    const draft = doc.history.find((r) => r.state === 'draft');
    expect(draft?.packs.map((p) => p.label)).toContain('variants@2');

    const gated = await svc.gateDraft(doc.revision);
    const report = gated.ok ? gated.release?.gate : null;
    expect(report?.ok, JSON.stringify(report?.checks)).toBe(true);
    expect(report?.checks.find((c) => c.id === 'packs.parse')?.ok).toBe(true);
    const json = JSON.stringify(report?.checks);
    expect(json).toContain('2 variant(s) parse, band and budget');

    const reviewed = svc.document().history.find((r) => r.state === 'review');
    expect(inv.unsatisfied(reviewed as Release)).toEqual([]);
  });

  it('refuses to DRAFT a variants version this host does not have', async () => {
    const { svc } = service(packsRoot());
    const doc = svc.document();
    const r = await svc.createDraft(doc.revision, { variants: 9 });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : '').toContain('variants@9 is not installed on this host');
  });
});

/* ------------------------------------------------------------------------ *
 * The declaration's OTHER half, and the caps — in the ONLINE gate
 * ------------------------------------------------------------------------ */

/**
 * Doctor the pending draft inside the DURABLE document and hand back a fresh
 * service reading it.
 *
 * `createDraft` assembles build packs straight out of `BUILTIN_PACKS`, so it
 * can never produce a declaration that disagrees with this binary — which is
 * exactly why the hole below survived: nothing a test could reach through the
 * happy path could express it. A release document on disk CAN, and that is
 * not a contrivance; it is a document written by another binary, or by a hand
 * with a text editor and the volume mounted, and `runGate` re-reads the
 * document every time it runs. Same route the schemaTouching rollback test
 * above uses, for the same reason.
 */
function doctorDraft(
  dataRoot: string,
  inv: PackInventory,
  mutate: (packs: PackVersion[]) => PackVersion[],
): ReleaseService {
  const file = join(dataRoot, 'releases.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as ReleaseDoc;
  const draft = raw.history.find((r) => r.state === 'draft');
  expect(draft, 'no draft in the durable document to doctor').toBeDefined();
  const doctored = { ...(draft as Release), packs: mutate([...(draft as Release).packs]) };
  const history = raw.history.map((r) => (r.revision === doctored.revision ? doctored : r));
  writeFileSync(file, JSON.stringify({ ...raw, history }), 'utf8');
  return new ReleaseService(dataRoot, inv, { clock: () => 2_000, log: () => {} });
}

/** The gate report from gating whatever draft is pending. */
async function gateReport(svc: ReleaseService): Promise<GateReport> {
  const gated = await svc.gateDraft(svc.document().revision);
  expect(gated.ok, 'gateDraft itself failed, which is not what these tests are about').toBe(true);
  const report = gated.ok ? gated.release?.gate : null;
  expect(report, 'the gate produced no report').not.toBeNull();
  return report as GateReport;
}

describe('the ONLINE gate checks the declared input lines, not only the number', () => {
  it('REFUSES a draft whose weapons fingerprint is right and whose input lines lie', async () => {
    /*
     * The reviewer's exact input, on the service half of §0's two-gate split.
     * `p.inputs` used to be read for one purpose — rendering a failure diff —
     * and compared against nothing, so a declaration carrying this binary's
     * fingerprint over the single line `0:lies` gated GREEN. The declaration
     * is the only record of what the previous build declared; if it can lie,
     * the line diff a firing ratchet prints is not evidence of anything.
     */
    const { svc, inv, dataRoot } = service(packsRoot());
    expect((await svc.createDraft(svc.document().revision)).ok).toBe(true);
    const svc2 = doctorDraft(dataRoot, inv, (packs) => packs.map((p) => (p.kind === PackKind.WEAPONS
      ? { ...p, inputs: ['0:lies'] } : p)));

    const report = await gateReport(svc2);
    const weapons = report.checks.find((c) => c.id === 'packs.declared.weapons');
    expect(weapons?.ok, JSON.stringify(report.checks)).toBe(false);
    expect(weapons?.detail).toContain('INPUT LINES');
    expect(weapons?.detail).toContain('- 0:lies');
    // The first line THIS build computes, whatever it is after a schema bump.
    expect(weapons?.detail).toContain(`+ ${weaponsFingerprintInputs()[0]}`);
    expect(report.ok).toBe(false);
    // Per-pack, not a blanket refusal: the other two declarations are intact.
    expect(report.checks.find((c) => c.id === 'packs.declared.core')?.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'packs.declared.characters')?.ok).toBe(true);
  });

  it('REFUSES a 161-byte input line, and passes the 160-byte one beside it', async () => {
    /*
     * The service gate already refused this before `checkPackInputs` existed,
     * so this is a NON-REGRESSION test rather than a red proof of the split:
     * the split was that `runReleaseVerify()` had no length check at all (see
     * gate.test.ts). It still goes red on its own terms — delete the byte-cap
     * branch inside `checkPackInputs` and both gates stop refusing — which is
     * the property that matters now that one helper serves both.
     *
     * 161 and 160 rather than 400 and 10, because a cap is only enforced if
     * it is enforced AT the cap, and an off-by-one here is silent forever.
     */
    const { svc, inv, dataRoot } = service(packsRoot());
    expect((await svc.createDraft(svc.document().revision)).ok).toBe(true);
    const at160 = `${'x'.repeat(155)}:1/2/3`; // 161 bytes; its 160-byte sibling below
    expect(Buffer.byteLength(at160, 'utf8')).toBe(161);
    const svc2 = doctorDraft(dataRoot, inv, (packs) => packs.map((p) => (p.kind === PackKind.LEVELS
      ? { ...p, inputs: [...p.inputs, at160] } : p)));

    const report = await gateReport(svc2);
    const cap = report.checks.find((c) => c.id === 'packs.inputs');
    expect(cap?.ok, JSON.stringify(report.checks)).toBe(false);
    expect(cap?.detail).toContain('input line over 160 bytes');
    expect(report.ok).toBe(false);

    // And the boundary from the legal side, on a fresh document: 160 bytes
    // passes, so the refusal above is the cap and not "any long line".
    const { svc: svcB, inv: invB, dataRoot: rootB } = service(packsRoot());
    expect((await svcB.createDraft(svcB.document().revision)).ok).toBe(true);
    const svcB2 = doctorDraft(rootB, invB, (packs) => packs.map((p) => (p.kind === PackKind.LEVELS
      ? { ...p, inputs: [...p.inputs, at160.slice(1)] } : p)));
    expect(Buffer.byteLength(at160.slice(1), 'utf8')).toBe(160);
    const okReport = await gateReport(svcB2);
    expect(okReport.checks.find((c) => c.id === 'packs.inputs')?.ok).toBe(true);
  });

  it('reports packs.inputs GREEN on an honest draft, so the check is seen to pass', async () => {
    // The old inline loop pushed a check ONLY when something was over a cap,
    // so `packs.inputs` never appeared in a passing report and no operator
    // could tell "measured and fine" from "never measured". A gate that
    // cannot be seen to pass is worth what one that cannot fail is worth.
    const { svc } = service(packsRoot());
    expect((await svc.createDraft(svc.document().revision)).ok).toBe(true);
    const report = await gateReport(svc);
    const cap = report.checks.find((c) => c.id === 'packs.inputs');
    expect(cap, JSON.stringify(report.checks.map((c) => c.id))).toBeDefined();
    expect(cap?.ok).toBe(true);
    expect(report.ok).toBe(true);
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

describe('the expansion one-click (S3): a draft from PICKED versions', () => {
  it('drafts the picked older version, carries the name, and refuses the uninstalled', async () => {
    const root = packsRoot(true); // levels@1 and levels@2 both installed
    const { svc } = service(root);
    let doc = svc.document();

    // The default is still the newest…
    expect((await svc.createDraft(doc.revision)).ok).toBe(true);
    doc = svc.document();
    const newest = doc.history.find((r) => r.state === 'draft') as Release;
    expect(newest.packs.find((p) => p.kind === PackKind.LEVELS)?.version).toBe(2);

    // …but a pick names levels@1 exactly, and the note names the expansion.
    const picked = await svc.createDraft(doc.revision, { levels: 1, note: 'Expansion One: Basic Training' });
    expect(picked.ok).toBe(true);
    doc = svc.document();
    const draft = doc.history.find((r) => r.state === 'draft') as Release;
    expect(draft.packs.find((p) => p.kind === PackKind.LEVELS)?.version).toBe(1);
    expect(draft.note).toBe('Expansion One: Basic Training');
    // The other data packs still ride at their newest installed versions.
    expect(draft.packs.find((p) => p.kind === PackKind.ITEMS)?.version).toBe(1);

    // A pick of something not on this host is a refusal, never a fallback.
    doc = svc.document();
    const missing = await svc.createDraft(doc.revision, { items: 9 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('items@9');
  });
});

describe('the draft route passes through every pick the service accepts', () => {
  /*
   * A SOURCE SCAN, in the style of trust.test.ts's, and it is here because of
   * how the gap it closes was made. `ReleaseService.createDraft` learned
   * `picks.variants` and every service-level test passed — while the HTTP
   * handler in server/src/index.ts, which is the only way the admin console
   * can ever call it, silently dropped the field. A release drafted through
   * the product would contain no variants pack however hard you asked.
   *
   * This scans rather than boots because the value is in catching the CLASS:
   * the next pack kind will add a `DraftPicks` field too, and the person
   * adding it will not read this file.
   */
  it('names every DraftPicks field in the POST /api/admin/release handler', () => {
    const picksSrc = readFileSync(join(repoRoot, 'server', 'src', 'packs.ts'), 'utf8');
    const block = /export interface DraftPicks \{([\s\S]*?)\}/.exec(picksSrc);
    expect(block, 'DraftPicks moved — update this scan').not.toBeNull();
    const fields = [...(block as RegExpExecArray)[1].matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]);
    expect(fields).toContain('variants');
    expect(fields.length).toBeGreaterThanOrEqual(5);

    const routeSrc = readFileSync(join(repoRoot, 'server', 'src', 'index.ts'), 'utf8');
    const call = /createDraft\(ifRevision, \{([\s\S]*?)\}\)/.exec(routeSrc);
    expect(call, 'the draft route moved — update this scan').not.toBeNull();
    const passed = (call as RegExpExecArray)[1];
    for (const f of fields) {
      expect(passed, `POST /api/admin/release drops picks.${f}`).toContain(`${f}:`);
    }
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

/* ------------------------------------------------------------------------ *
 * The pinned variant table actually reaches the room (V3)
 *
 * `8c6f196` fixed the production draft route dropping `picks.variants` while
 * every service-level test passed. This is the same hazard one layer further
 * on: an installed, approved variants pack that never reaches `new Room(...)`
 * makes every room serve an empty table forever, and every unit test in the
 * repo stays green while it happens.
 * ------------------------------------------------------------------------ */

describe('a release\'s variants pack reaches the room that pinned it', () => {
  it('an installed manifest becomes a room arsenal with real slots', () => {
    const inv = new PackInventory({ packsRoot: packsRoot(false, true), log: () => {} });
    const at = inv.variantsAt(1);
    expect(at, 'variants@1 not installed').not.toBeNull();
    expect(at!.manifest.variants).toHaveLength(2);

    const room = new Room({
      seed: 1, botFill: 0, enemies: 0, eagerWorld: false, store: null,
      clock: () => 0, name: 'pinned', variants: at!.manifest,
    });
    try {
      // Decoded from the bytes the room will send, not from the manifest.
      expect(room.variantTable.map((v) => v.id)).toEqual(['shotgun-slug', 'pistol-burst']);
      // Two variants -> the base plus two slots.
      expect(room.sim.arsenal.slotCount).toBe(3);
      expect(room.sim.arsenal.statsFor(1, 1).variantId).toBe('shotgun-slug');
      expect(room.sim.arsenal.statsFor(1, 1).pellets).toBe(1);
      expect(room.sim.arsenal.statsFor(0, 2).variantId).toBe('pistol-burst');
      expect(room.sim.arsenal.statsFor(0, 2).rpm).toBe(620);
    } finally { room.stop(); }
  });

  it('and the room FACTORY passes it, which no behavioural test can see', () => {
    // The gap this guards is the one that has bitten this repo twice: the
    // wiring, not the thing being wired. `server/src/index.ts` builds every
    // production room; if its options object stops naming `variants`, the two
    // assertions above still pass, the whole suite still passes, and every
    // real room silently serves an empty table. There is no lighter way to see
    // that than to look at the line — booting the binary is a child process
    // and a minute.
    const src = readFileSync(join(repoRoot, 'server', 'src', 'index.ts'), 'utf8');
    expect(src, 'index.ts no longer resolves the release\'s variants pack')
      .toMatch(/inventory\.variantsAt\(variantsVersion\)/);
    const from = src.indexOf('const room = new Room({');
    expect(from, 'the room factory moved').toBeGreaterThan(0);
    // The options object's own close, at its own indent — the inner arrow
    // callbacks close at deeper ones, so this really is the end of the call.
    const roomCall = src.slice(from, src.indexOf('\n    });', from));
    expect(roomCall, 'new Room(...) no longer passes `variants`').toMatch(/^ {6}variants,$/m);
  });
});

/* ------------------------------------------------------------------------ *
 * V4a — the BUNDLED pack reaches a real client over a real socket
 *
 * Everything above this line proves the machine works when a test hands it a
 * manifest. This proves the machine works on the tree as shipped: no
 * DOOMCRAFT_PACKS, no release document, no picks — the state a Railway deploy
 * actually boots in — and the content that reaches the client is
 * `content/variants.json`.
 *
 * WHY THE OBVIOUS VERSION OF THIS TEST IS WORTHLESS, MEASURED.
 *
 * The natural shape is: boot, connect with CAP_VARIANTS, assert the received
 * rows equal the manifest's rows and that `slotCount === variants.length + 1`.
 * Replace the manifest with `{"variants":[]}` and every one of those passes.
 * It parses with ZERO errors, `variants.validate` says ok, and then:
 *
 *     Room.variantTable.length:       0
 *     arsenal.slotCount:              1
 *     received rows == manifest rows: true      <-- 0 == 0
 *     slotCount == variants.length+1: true      <-- 1 == 0+1
 *
 * Both comparisons are between two quantities that go to zero TOGETHER, so
 * they are satisfied by a room serving nothing. That is rule 25 in its other
 * direction — a gate that passes on nothing — and it is exactly the failure
 * this whole arc exists to prevent, rebuilt as the test that was supposed to
 * catch it.
 *
 * So the numbers below are LITERAL. Two rows, these two ids, these two bases.
 * A denominator that can go to zero is never allowed to be the whole of an
 * assertion; the sixteen-field comparison against the parsed file rides on top
 * of literals that pin the count first.
 *
 * WHICH ARSENAL IS BEING INSPECTED. A socket exposes the TABLE and the claim
 * bytes; it does not expose `room.sim.arsenal`, and asserting on an arsenal
 * this process built from the same file the server read would prove nothing
 * about the server. So the client half is reconstructed the way
 * `NetClient.onVariantTable` reconstructs it — `SessionArsenal.from(
 * overlaysFromWire(decoded.variants))` — from the bytes that came off the
 * wire. The SERVER half stays where it is, in the `new Room(...)` test above.
 *
 * Display names are deliberately NOT compared: they are not on this protocol
 * (the row is an id, a base and sixteen f64s), and asserting a name here would
 * be asserting a token that travels by some other route.
 * ------------------------------------------------------------------------ */

describe('V4a: the bundled variants pack reaches a real client', () => {
  it('serves both bundled variants, every effective field, to a CAP_VARIANTS socket', async () => {
    const bundledText = readFileSync(join(repoRoot, 'content', 'variants.json'), 'utf8');
    const bundled = parseVariantsManifest(bundledText);
    expect(bundled.errors, 'content/variants.json does not parse').toEqual([]);
    expect(bundled.manifest, 'content/variants.json does not parse').not.toBeNull();
    const defs = bundled.manifest!.variants;

    // THE PREMISE, STATED AS LITERALS. If the pack is emptied, this is where
    // the test goes red — before anything is booted and before any comparison
    // whose two sides could vanish together.
    expect(defs.length, 'the bundled pack must carry content, not an empty array').toBe(2);
    expect(defs.map((v) => v.id)).toEqual(['shotgun-slug', 'rocket-swift']);
    expect(defs.map((v) => v.base)).toEqual([WeaponId.SHOTGUN, WeaponId.ROCKET]);

    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      DOOMCRAFT_DATA: tempDir('dc-v4adata-'),
      DOOMCRAFT_STATIC: tempDir('dc-v4astatic-'),
      DOOMCRAFT_BOTS: '0',
    };
    // The whole point is the UNCONFIGURED host — content/ as version 1. An
    // ambient packs root would silently make this a test of somebody's volume.
    delete env.DOOMCRAFT_PACKS;
    const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env,
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

      // The host pins it with no release document and no picks: this is the
      // boot identity, which is what `hostFallback()` hands every room.
      const version = await (await fetch(`${origin}/api/version`)).json() as {
        release: { packs: { label: string; cls: string }[]; unsatisfied: string[] };
      };
      expect(version.release.packs.map((p) => p.label)).toContain('variants@1');
      expect(version.release.unsatisfied).toEqual([]);

      const frames = await helloAndCollect(port, CAP_VARIANTS);
      const raw = frames.find((f) => f.length > 0 && f[0] === S2C.VARIANT_TABLE);
      expect(raw, 'no S2C.VARIANT_TABLE arrived at all').toBeDefined();

      const decoded = decodeVariantTable(
        new PacketReader(raw as Uint8Array), createVariantTableMessage(),
      );
      expect(decoded, 'the room sent a VARIANT_TABLE this client refuses').not.toBeNull();
      const rows = decoded!.variants;

      // NON-EMPTINESS, SAID OUT LOUD AND FIRST. Everything below it is a
      // comparison, and a comparison is only worth what its operands are.
      expect(rows.length, 'the room served an EMPTY table').toBeGreaterThan(0);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.id)).toEqual(['shotgun-slug', 'rocket-swift']);
      expect(rows.map((r) => r.base)).toEqual([WeaponId.SHOTGUN, WeaponId.ROCKET]);

      // All sixteen effective fields, in VARIANT_FIELDS order, per row. f64 is
      // lossless both ways, so this is exact equality and not a tolerance.
      for (let i = 0; i < defs.length; i++) {
        const expected = wireValuesFor(defs[i]);
        expect(expected.length).toBe(VARIANT_FIELDS.length);
        for (let f = 0; f < VARIANT_FIELDS.length; f++) {
          expect(rows[i].values[f], `${rows[i].id}.${VARIANT_FIELDS[f]}`).toBe(expected[f]);
        }
      }

      // The CLIENT's arsenal, rebuilt from the bytes exactly as
      // `NetClient.onVariantTable` rebuilds it. Slot 0 is the untouched
      // archetype; row i is slot i+1.
      const arsenal = SessionArsenal.from(overlaysFromWire(rows));
      expect(arsenal.slotCount).toBe(3);
      expect(arsenal.statsFor(WeaponId.SHOTGUN, 1).variantId).toBe('shotgun-slug');
      expect(arsenal.statsFor(WeaponId.SHOTGUN, 1).pellets).toBe(1);
      expect(arsenal.statsFor(WeaponId.ROCKET, 2).variantId).toBe('rocket-swift');
      expect(arsenal.statsFor(WeaponId.ROCKET, 2).projectileSpeed).toBe(66);
      // And slot 0 is still the compiled archetype on the same client, which
      // is what "every player stays at slot 0 in V4a" rests on.
      expect(arsenal.statsFor(WeaponId.SHOTGUN, 0).pellets).toBe(WEAPONS[WeaponId.SHOTGUN].pellets);

      // The interlock, on the same booted host: a client that does not set the
      // bit is told nothing it could not decode.
      const plain = await helloAndCollect(port, 0);
      expect(plain.some((f) => f.length > 0 && f[0] === S2C.VARIANT_TABLE)).toBe(false);
      expect(plain.length, 'the control socket got no world at all — it proves nothing')
        .toBeGreaterThan(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);
});

/** HELLO on a real /ws socket, then every binary frame that arrives in 1.5 s. */
async function helloAndCollect(port: number, caps: number): Promise<Uint8Array[]> {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Uint8Array[] = [];
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('socket did not open')), 10_000);
    ws.on('open', () => { clearTimeout(timer); res(); });
    ws.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
  ws.on('message', (d: Buffer) => { frames.push(new Uint8Array(d)); });
  // `encodeHello`, not a frozen hex string: a protocol change must move this
  // with it rather than leaving the test speaking a dialect the server has
  // stopped understanding.
  const w = encodeHello(new PacketWriter(256), 'v4a-probe', 0, caps);
  ws.send(w.copy());
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  return frames;
}

describe('V4b moves items@1\'s digest, and the host says so out loud', () => {
  /*
   * Clause 17(b). V4b changes BOTH the content of `content/items.json` (two
   * ownership tokens) and the SERIALIZATION of every item line (the variantId
   * column), and `itemsAt()` recomputes the fingerprint AND the sha256 from
   * the file on every load — so no version bump can dodge it and the same
   * version number legitimately gets a new digest.
   *
   * What makes that safe is a fact about the RUNNING HOST, not about the code:
   * `GET /api/admin/release` on the live origin returns `history: []`,
   * `liveRevision: 0`, `pendingRevision: 0`, so no stored release document
   * records an items digest at all. `/api/version` could not have told us
   * that — it publishes the post-fallback view, which is identical for an
   * empty document and for a stored release this host already cannot satisfy
   * (HANDOVER §0 rule 35). RE-PROBE `/api/admin/release` immediately before
   * the deploy, not only now.
   *
   * This test asserts the MECHANISM that fact makes irrelevant today: pin a
   * release to the pre-V4b digest and the host reports it unsatisfiable rather
   * than serving it. The digest below is the real one the live origin reports
   * for items@1 as this was written.
   */
  const PRE_V4B_ITEMS_DIGEST =
    '61be01e94291a5ef8a87bcf4d8d713910ab8e987d2f1e8e166818688f6c8b1fe';

  it('reports exactly ["items@1"] for a release recorded against the OLD items digest', () => {
    const { inv } = service(packsRoot());
    const now = inv.itemsAt(1);
    expect(now, 'items@1 stopped parsing').not.toBeNull();
    expect(now!.pack.digest, 'the serialization did NOT move — this test is asleep')
      .not.toBe(PRE_V4B_ITEMS_DIGEST);

    const stored: Release = {
      revision: 4, state: 'live', ordinal: 1,
      packs: inv.installedPacks().map((p) => (
        p.kind === PackKind.ITEMS ? { ...p, digest: PRE_V4B_ITEMS_DIGEST } : p
      )),
      rolloutBp: 10000, baseRevision: 0, gate: null,
      createdMs: 0, publishedMs: 0, note: 'recorded before V4b',
    };
    expect(inv.unsatisfied(stored)).toEqual(['items@1']);

    // The control: the same release carrying TODAY's digest is satisfiable,
    // so the refusal above is about the digest and not about the fixture.
    const current: Release = { ...stored, packs: inv.installedPacks() };
    expect(inv.unsatisfied(current)).toEqual([]);
  });

  it('carries the two V4b ownership tokens in the bundled items@1', () => {
    const { inv } = service(packsRoot());
    const ids = inv.itemsAt(1)!.manifest.items.map((i) => i.id);
    expect(ids).toContain('weapon_variant-shotgun-slug');
    expect(ids).toContain('weapon_variant-rocket-swift');
  });
});
