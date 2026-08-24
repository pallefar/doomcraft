/**
 * DOOMCRAFT — the server reads a release (docs/PACKS.md phase 2).
 *
 * Two things live here and they are deliberately separate:
 *
 *   - `PackInventory` — what is INSTALLED on this host: versioned data-pack
 *     directories under `DOOMCRAFT_PACKS/<key>/<version>/`, falling back to
 *     `content/` as version 1 so an unconfigured deploy behaves exactly as
 *     today. It hands rooms a frozen, version-bound `ContentResolver`
 *     (docs/PACKS.md 8.9: a room's resolver is consulted again mid-life when
 *     the campaign advances, so it must never change under a running room).
 *
 *   - `ReleaseService` — which installed versions are LIVE, and when. The
 *     durable release document with the three things `FlagService`
 *     deliberately lacks (§5.1): tmp-then-rename durability under
 *     `DOOMCRAFT_DATA`, compare-and-swap on `revision` with 409, and an
 *     append-only audit line per accepted transition in `release.jsonl`.
 *
 * Rule E everywhere: refusing a release is always safer than refusing a
 * player. A host that cannot satisfy a release keeps serving the previous
 * one and says so in `/api/version`; it never exits and never closes a
 * socket (8.6 — a crash-loop takes down the console that would fix it).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  BUILTIN_PACKS,
  MAX_ORDINAL,
  MAX_PACK_INPUTS,
  MAX_PACK_INPUT_BYTES,
  MAX_RELEASE_HISTORY,
  PACKS,
  PackKind,
  campaignPack,
  levelsPack,
  packSetHash,
  releaseAt,
  resolveRelease,
  type GateCheck,
  type GateReport,
  type PackDiff,
  type PackVersion,
  type Release,
  type ReleaseDoc,
  type ReleaseState,
} from '@doomcraft/shared/packs';
import { CONTENT_VERSION } from '@doomcraft/shared/version';
import type { Level } from '@doomcraft/shared/level';

import {
  DEFAULT_EPISODES_FILE,
  campaignDigest,
  checkCampaignRefs,
  checkFlagsOrder,
  checkLevelsCanonical,
  checkLevelsValidate,
  checkPacksDeclared,
  checkPacksInstalled,
  checkPacksUnique,
  checkProtocolStable,
  checkSavesSchema,
  levelsDigest,
  parseEpisodesManifest,
  scanLevelDir,
  type EpisodesManifest,
} from './gate.js';
import { DEFAULT_LEVEL_DIR, LevelLibrary } from './levels.js';
import { validateLevel } from '@doomcraft/shared/level';
import type { ContentResolver } from './modes.js';

/* ------------------------------------------------------------------------ *
 * Inventory
 * ------------------------------------------------------------------------ */

export interface PackInventoryOptions {
  /** `DOOMCRAFT_PACKS`. Null/unset: the `content/` fallback only. */
  packsRoot?: string | null;
  /** The version-1 fallback for levels. Defaults to `content/levels`. */
  levelsFallbackDir?: string;
  /** The version-1 fallback for the campaign. Defaults to `content/episodes.json`. */
  episodesFallbackFile?: string;
  log?: (line: string) => void;
}

interface LevelsVersionRecord {
  version: number;
  dir: string;
  library: LevelLibrary | null;
  pack: PackVersion | null;
}

export class PackInventory {
  private readonly packsRoot: string | null;
  private readonly levelsFallbackDir: string;
  private readonly episodesFallbackFile: string;
  private readonly log: (line: string) => void;

  /**
   * Loaded levels versions, at most two retained (live + previous — the
   * rollback requirement, and half the code of four). A version's directory
   * is immutable by convention (a re-cut pack is a NEW version, never an
   * in-place edit), so a loaded record is never reloaded.
   */
  private readonly loaded = new Map<number, LevelsVersionRecord>();

  constructor(options: PackInventoryOptions = {}) {
    this.packsRoot = options.packsRoot ?? null;
    this.levelsFallbackDir = resolve(options.levelsFallbackDir ?? DEFAULT_LEVEL_DIR);
    this.episodesFallbackFile = resolve(options.episodesFallbackFile ?? DEFAULT_EPISODES_FILE);
    this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
  }

  /** Directory for a levels version, or null when not installed. */
  levelsDirFor(version: number): string | null {
    if (version === 1 && this.packsRoot === null) {
      return existsSync(this.levelsFallbackDir) ? this.levelsFallbackDir : null;
    }
    if (this.packsRoot === null) return null;
    const dir = join(this.packsRoot, 'levels', String(version));
    if (existsSync(dir)) return dir;
    // Version 1 falls back to content/ even when a packs root exists, so a
    // half-populated volume still behaves like an unconfigured deploy.
    if (version === 1 && existsSync(this.levelsFallbackDir)) return this.levelsFallbackDir;
    return null;
  }

  episodesFileFor(version: number): string | null {
    if (this.packsRoot !== null) {
      const file = join(this.packsRoot, 'campaign', String(version), 'episodes.json');
      if (existsSync(file)) return file;
    }
    if (version === 1 && existsSync(this.episodesFallbackFile)) return this.episodesFallbackFile;
    return null;
  }

  /** Every installed levels version, ascending. */
  levelsVersions(): number[] {
    const out = new Set<number>();
    if (existsSync(this.levelsFallbackDir)) out.add(1);
    if (this.packsRoot !== null) {
      const root = join(this.packsRoot, 'levels');
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          const v = Number(name);
          if (Number.isInteger(v) && v >= 1 && this.levelsDirFor(v) !== null) out.add(v);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  campaignVersions(): number[] {
    const out = new Set<number>();
    if (existsSync(this.episodesFallbackFile)) out.add(1);
    if (this.packsRoot !== null) {
      const root = join(this.packsRoot, 'campaign');
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          const v = Number(name);
          if (Number.isInteger(v) && v >= 1 && this.episodesFileFor(v) !== null) out.add(v);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  private recordFor(version: number): LevelsVersionRecord | null {
    const cached = this.loaded.get(version);
    if (cached !== undefined) return cached;
    const dir = this.levelsDirFor(version);
    if (dir === null) return null;

    const library = new LevelLibrary({ dir, log: this.log });
    library.load();
    const files = scanLevelDir(dir);
    const served = files.filter((f): f is typeof f & { bytes: Uint8Array } => f.bytes !== null && f.id.length > 0);
    // The loader's source-wins shadow rule, mirrored from the gate.
    const winners = new Map<string, { id: string; bytes: Uint8Array; fromSource: boolean }>();
    for (const f of served) {
      const prev = winners.get(f.id);
      if (prev !== undefined && prev.fromSource && !f.fromSource) continue;
      winners.set(f.id, { id: f.id, bytes: f.bytes, fromSource: f.fromSource });
    }
    const list = [...winners.values()];
    const base = levelsPack(
      list.map((f) => ({ id: f.id, hash: fnvOf(f.bytes) })), version,
    );
    const pack: PackVersion = { ...base, digest: levelsDigest(list) };

    const record: LevelsVersionRecord = { version, dir, library, pack };
    this.loaded.set(version, record);
    this.evictBeyondTwo(version);
    return record;
  }

  /**
   * Keep at most the two most-recently-USED versions in memory. A version a
   * live room still holds keeps working — the room owns its resolver — this
   * only bounds what future rooms can be built from without a re-scan.
   */
  private evictBeyondTwo(justUsed: number): void {
    if (this.loaded.size <= 2) return;
    for (const key of this.loaded.keys()) {
      if (key !== justUsed && this.loaded.size > 2) this.loaded.delete(key);
    }
  }

  /** The installed levels pack at a version, digest included. Null when absent. */
  levelsPackAt(version: number): PackVersion | null {
    return this.recordFor(version)?.pack ?? null;
  }

  campaignAt(version: number): { pack: PackVersion; manifest: EpisodesManifest } | null {
    const file = this.episodesFileFor(version);
    if (file === null) return null;
    const manifest = parseEpisodesManifest(readFileSync(file, 'utf8'));
    if (manifest === null) return null;
    const base = campaignPack(manifest, version);
    return { pack: { ...base, digest: campaignDigest(manifest) }, manifest };
  }

  /**
   * The pack set this host would serve with no release document: the build
   * packs this binary declares plus the NEWEST installed data packs. This is
   * the boot identity `/api/version` and default rooms report.
   */
  installedPacks(): PackVersion[] {
    const out: PackVersion[] = [...BUILTIN_PACKS];
    const lv = this.levelsVersions();
    if (lv.length > 0) {
      const p = this.levelsPackAt(lv[lv.length - 1]);
      if (p !== null) out.push(p);
    }
    const cv = this.campaignVersions();
    if (cv.length > 0) {
      const c = this.campaignAt(cv[cv.length - 1]);
      if (c !== null) out.push(c.pack);
    }
    return out;
  }

  /**
   * A frozen, version-bound `ContentResolver` for a release (8.9). The room
   * re-reads it when the campaign advances, so it exposes exactly the two
   * methods a room uses and nothing that could change what they answer.
   */
  viewFor(release: Release): ContentResolver | null {
    const declared = release.packs.find((p) => p.kind === PackKind.LEVELS);
    const version = declared?.version ?? (this.levelsVersions().at(-1) ?? 1);
    const record = this.recordFor(version);
    if (record === null || record.library === null) return null;
    const lib = record.library;
    return Object.freeze({
      resolveId: (requested: string): string => lib.resolveId(requested),
      levelFor: (id: string): Level | null => lib.getPlayable(id),
    });
  }

  /**
   * What this host CANNOT satisfy about a release: a data pack version that
   * is not installed or whose recomputed digest differs from the declared
   * one, or a build pack that does not match this binary. Rule E: the caller
   * keeps serving the previous release and reports these labels.
   */
  unsatisfied(release: Release): string[] {
    const out: string[] = [];
    for (const p of release.packs) {
      const def = PACKS[p.kind];
      if (def === undefined) { out.push(p.label); continue; }
      if (def.cls === 'build') {
        const mine = BUILTIN_PACKS.find((b) => b.kind === p.kind);
        if (mine === undefined || mine.fingerprint !== p.fingerprint || mine.version !== p.version) {
          out.push(p.label);
        }
        continue;
      }
      if (p.kind === PackKind.LEVELS) {
        const installed = this.levelsPackAt(p.version);
        if (installed === null || (p.digest.length > 0 && installed.digest !== p.digest)) out.push(p.label);
        continue;
      }
      if (p.kind === PackKind.CAMPAIGN) {
        const installed = this.campaignAt(p.version);
        if (installed === null || (p.digest.length > 0 && installed.pack.digest !== p.digest)) out.push(p.label);
        continue;
      }
      out.push(p.label);
    }
    return out;
  }
}

/* ------------------------------------------------------------------------ *
 * The release service
 * ------------------------------------------------------------------------ */

export interface ReleaseServiceOptions {
  clock?: () => number;
  log?: (line: string) => void;
}

export type ReleaseResult =
  | { ok: true; doc: ReleaseDoc; release?: Release }
  | { ok: false; status: number; error: string; doc: ReleaseDoc };

const DOC_FILE = 'releases.json';
const AUDIT_FILE = 'release.jsonl';

export class ReleaseService {
  private readonly root: string;
  private readonly inventory: PackInventory;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private doc: ReleaseDoc;
  /** Serialises mutations; CAS makes racing tabs SAFE, this makes them ORDERED. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Set when the disk refuses; the document degrades to memory, stated loudly. */
  degraded = false;

  constructor(dataRoot: string, inventory: PackInventory, options: ReleaseServiceOptions = {}) {
    this.root = dataRoot.replace(/\/+$/, '');
    this.inventory = inventory;
    this.clock = options.clock ?? (() => Date.now());
    this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
    this.doc = emptyDoc();
    this.loadSync();
  }

  /* --- persistence ------------------------------------------------------ */

  private loadSync(): void {
    const file = join(this.root, DOC_FILE);
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ReleaseDoc;
      this.doc = sanitiseDoc(parsed);
    } catch (e) {
      // A corrupt document must not brick the host (8.3): the builtin
      // fallback keeps rooms coming; the operator sees this line and the
      // degraded flag. The file is NOT overwritten until the next accepted
      // mutation, so the evidence survives.
      this.degraded = true;
      this.log(`releases: ${file} is unreadable (${e instanceof Error ? e.message : String(e)}); serving the builtin release`);
    }
  }

  private persist(): void {
    const file = join(this.root, DOC_FILE);
    try {
      mkdirSync(this.root, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.doc), 'utf8');
      renameSync(tmp, file);
      this.degraded = false;
    } catch (e) {
      this.degraded = true;
      this.log(`releases: cannot persist ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private auditLine(entry: Record<string, unknown>): void {
    try {
      mkdirSync(this.root, { recursive: true });
      appendFileSync(join(this.root, AUDIT_FILE), JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* An unwritable audit file must not block the transition itself; the
       * admin action log carries a second copy of every mutation. */
    }
  }

  /* --- reads ------------------------------------------------------------ */

  document(): ReleaseDoc { return this.doc; }

  /**
   * The release this HOST falls back to: the binary's builtin packs plus the
   * newest installed data packs — exactly the boot identity an unconfigured
   * deploy has served since phase 1. Rebuilt per call so a draft assembled
   * after a pack install sees the new state; cheap because the inventory
   * caches loaded versions.
   */
  hostFallback(): Release {
    return Object.freeze({
      revision: 0,
      state: 'live' as ReleaseState,
      ordinal: CONTENT_VERSION,
      packs: this.inventory.installedPacks(),
      rolloutBp: 10000,
      baseRevision: 0,
      gate: null,
      createdMs: 0,
      publishedMs: 0,
      note: 'compiled-in + installed data packs',
    });
  }

  /**
   * The release the fleet-agreement number describes: live, pending excluded,
   * with the same Rule-E fallback as room resolution. What `/api/version`
   * publishes and what every new room gets once nothing is staged.
   */
  live(): Release {
    const live = releaseAt(this.doc, this.doc.liveRevision);
    if (live === null) return this.hostFallback();
    return this.inventory.unsatisfied(live).length === 0 ? live : this.hostFallback();
  }

  /** Which release a NEW room is built from. Total; never throws (8.3). */
  resolveFor(roomInstanceId: string): Release {
    const release = resolveRelease(this.doc, roomInstanceId, this.hostFallback());
    // Rule E, applied at the last moment: a resolved release this host
    // cannot satisfy falls back to what it CAN serve. The pending/live
    // document states are the operator's intent; the bytes on disk are the
    // constraint, and refusing the release beats refusing the room.
    if (release.revision !== 0 && this.inventory.unsatisfied(release).length > 0) {
      const live = releaseAt(this.doc, this.doc.liveRevision);
      if (live !== null && live !== release && this.inventory.unsatisfied(live).length === 0) return live;
      return this.hostFallback();
    }
    return release;
  }

  /* --- mutations -------------------------------------------------------- */

  private mutate<T>(fn: () => T): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private cas(ifRevision: number): ReleaseResult | null {
    if (!Number.isInteger(ifRevision) || ifRevision !== this.doc.revision) {
      return {
        ok: false, status: 409, doc: this.doc,
        error: `revision conflict: document is at ${this.doc.revision}, request expected ${ifRevision}`,
      };
    }
    return null;
  }

  private accept(next: ReleaseDoc, verb: string, release: Release | null, detail: string): void {
    this.doc = Object.freeze({ ...next, revision: this.doc.revision + 1 });
    this.persist();
    this.auditLine({
      ms: this.clock(),
      verb,
      docRevision: this.doc.revision,
      revision: release?.revision ?? 0,
      ordinal: release?.ordinal ?? 0,
      state: release?.state ?? '',
      rolloutBp: release?.rolloutBp ?? 0,
      note: release?.note ?? '',
      detail,
    });
  }

  /**
   * Assemble a draft from what is installed. An existing draft/review is
   * superseded — it was assembled from the same inventory and holds nothing
   * a re-assembly cannot reproduce; the one-at-a-time rule is what keeps
   * "what would ship" a question with one answer.
   */
  createDraft(ifRevision: number): Promise<ReleaseResult> {
    return this.mutate(() => {
      const conflict = this.cas(ifRevision);
      if (conflict !== null) return conflict;
      if (this.doc.pendingRevision !== 0) {
        return { ok: false, status: 409, doc: this.doc, error: 'a staged release is pending; promote it, stage it to 0 and roll it back, or rollback first' };
      }
      const live = releaseAt(this.doc, this.doc.liveRevision);
      const ordinal = (live?.ordinal ?? CONTENT_VERSION) + 1;
      if (ordinal > MAX_ORDINAL) {
        return { ok: false, status: 400, doc: this.doc, error: `ordinal ${ordinal} exceeds the wire's u16` };
      }
      const revision = this.doc.revision + 1;
      const draft: Release = {
        revision,
        state: 'draft',
        ordinal,
        packs: this.inventory.installedPacks(),
        rolloutBp: 0,
        baseRevision: this.doc.liveRevision,
        gate: null,
        createdMs: this.clock(),
        publishedMs: 0,
        note: '',
      };
      const history = this.doc.history
        .map((r) => (r.state === 'draft' || r.state === 'review' ? { ...r, state: 'superseded' as ReleaseState } : r));
      const next = capHistory({ ...this.doc, history: [...history, draft] });
      this.accept(next, 'release.draft', draft, draft.packs.map((p) => p.label).join(' '));
      return { ok: true, doc: this.doc, release: draft };
    });
  }

  /** Run the gate on the draft, in THIS process, against THIS disk. draft→review. */
  gateDraft(ifRevision: number): Promise<ReleaseResult> {
    return this.mutate(() => {
      const conflict = this.cas(ifRevision);
      if (conflict !== null) return conflict;
      const draft = this.doc.history.find((r) => r.state === 'draft' || r.state === 'review');
      if (draft === undefined) return { ok: false, status: 404, doc: this.doc, error: 'no draft to gate' };
      const live = releaseAt(this.doc, this.doc.liveRevision) ?? this.hostFallback();
      const gate = this.runGate(draft, live);
      const next = replaceRelease(this.doc, draft.revision, { ...draft, state: 'review', gate });
      this.accept(next, 'release.gate', { ...draft, state: 'review', gate }, gate.ok ? 'gate ok' : `gate REFUSED: ${gate.checks.filter((c) => !c.ok).map((c) => c.id).join(',')}`);
      return { ok: true, doc: this.doc, release: releaseAt(this.doc, draft.revision) ?? undefined };
    });
  }

  /** review→staged at bp 0. Refused without a green gate and a human sentence. */
  approve(ifRevision: number, note: string): Promise<ReleaseResult> {
    return this.mutate(() => {
      const conflict = this.cas(ifRevision);
      if (conflict !== null) return conflict;
      const review = this.doc.history.find((r) => r.state === 'review');
      if (review === undefined) return { ok: false, status: 404, doc: this.doc, error: 'no reviewed release to approve' };
      if (review.gate === null || !review.gate.ok) {
        return { ok: false, status: 409, doc: this.doc, error: 'the gate has not passed — approval is refused by the server, not the panel' };
      }
      const trimmed = note.trim();
      if (trimmed.length === 0) return { ok: false, status: 400, doc: this.doc, error: 'a release with no sentence saying why is not a release' };
      if (trimmed.length > 200) return { ok: false, status: 400, doc: this.doc, error: 'note is over 200 characters' };
      if (this.doc.pendingRevision !== 0) return { ok: false, status: 409, doc: this.doc, error: 'another release is already staged' };
      const staged: Release = { ...review, state: 'staged', rolloutBp: 0, note: trimmed };
      const next = replaceRelease({ ...this.doc, pendingRevision: review.revision }, review.revision, staged);
      this.accept(next, 'release.approve', staged, trimmed);
      return { ok: true, doc: this.doc, release: staged };
    });
  }

  /**
   * Move the staged release's rollout. 0 and 10000 are the two honest rungs
   * on one host (§5.2: with one long-lived room per key, the intermediate
   * rungs reach zero rooms for hours and a decorative percentage is worse
   * than none) — anything else needs `allowCustomRollout`, same rule as the
   * flags route.
   */
  stage(ifRevision: number, bp: number, allowCustomRollout = false): Promise<ReleaseResult> {
    return this.mutate(() => {
      const conflict = this.cas(ifRevision);
      if (conflict !== null) return conflict;
      const staged = releaseAt(this.doc, this.doc.pendingRevision);
      if (staged === null || staged.state !== 'staged') return { ok: false, status: 404, doc: this.doc, error: 'no staged release' };
      if (!Number.isInteger(bp) || bp < 0 || bp > 10000) return { ok: false, status: 400, doc: this.doc, error: 'rolloutBp must be an integer 0..10000' };
      if (bp !== 0 && bp !== 10000 && !allowCustomRollout) {
        return {
          ok: false, status: 400, doc: this.doc,
          error: 'intermediate rungs are decorative on one host (one long-lived room per key) — resend with allowCustomRollout: true if you mean it',
        };
      }
      const moved: Release = { ...staged, rolloutBp: bp };
      this.accept(replaceRelease(this.doc, staged.revision, moved), 'release.stage', moved, `bp ${staged.rolloutBp} -> ${bp}`);
      return { ok: true, doc: this.doc, release: moved };
    });
  }

  /** staged@10000 → live. The previous live → superseded. */
  promote(ifRevision: number): Promise<ReleaseResult> {
    return this.mutate(() => {
      const conflict = this.cas(ifRevision);
      if (conflict !== null) return conflict;
      const staged = releaseAt(this.doc, this.doc.pendingRevision);
      if (staged === null || staged.state !== 'staged') return { ok: false, status: 404, doc: this.doc, error: 'no staged release' };
      if (staged.rolloutBp !== 10000) return { ok: false, status: 409, doc: this.doc, error: `staged at ${staged.rolloutBp} bp — promote requires 10000, deliberately: live is the terminal, freeze-proof state` };
      const unsat = this.inventory.unsatisfied(staged);
      if (unsat.length > 0) return { ok: false, status: 409, doc: this.doc, error: `this host cannot satisfy: ${unsat.join(', ')}` };
      const promoted: Release = { ...staged, state: 'live', publishedMs: this.clock() };
      let history = this.doc.history.map((r) =>
        (r.revision === this.doc.liveRevision && r.state === 'live' ? { ...r, state: 'superseded' as ReleaseState } : r));
      history = history.map((r) => (r.revision === promoted.revision ? promoted : r));
      const next = capHistory({ ...this.doc, history, liveRevision: promoted.revision, pendingRevision: 0 });
      this.accept(next, 'release.promote', promoted, `live at ordinal ${promoted.ordinal}`);
      return { ok: true, doc: this.doc, release: promoted };
    });
  }

  /**
   * live → rolled_back; the base release becomes live again. Refused under
   * §5's three rules, each with the exact reason on the refusal — the panel
   * renders the string instead of a button.
   */
  rollback(ifRevision: number): Promise<ReleaseResult> {
    return this.mutate(() => {
      const conflict = this.cas(ifRevision);
      if (conflict !== null) return conflict;
      const live = releaseAt(this.doc, this.doc.liveRevision);
      if (live === null || live.state !== 'live') return { ok: false, status: 404, doc: this.doc, error: 'no live release to roll back' };
      if (live.gate?.schemaTouching === true) {
        return { ok: false, status: 409, doc: this.doc, error: 'this release moved PERSIST/SAVES — a schema-touching release can never be rolled back (a v(n-1) host has no _unknown bag; rewritten balances are gone for good)' };
      }
      const target = live.baseRevision === 0 ? this.hostFallback() : releaseAt(this.doc, live.baseRevision);
      if (target === null) return { ok: false, status: 409, doc: this.doc, error: `base revision ${live.baseRevision} is no longer in history` };
      for (const p of target.packs) {
        const def = PACKS[p.kind];
        if (def?.cls === 'build') {
          const mine = BUILTIN_PACKS.find((b) => b.kind === p.kind);
          if (mine === undefined || mine.fingerprint !== p.fingerprint) {
            return { ok: false, status: 409, doc: this.doc, error: `rollback requires redeploying build ${p.label}` };
          }
        }
      }
      const unsat = this.inventory.unsatisfied(target).filter((label) => !label.startsWith('core@') && !label.startsWith('weapons@') && !label.startsWith('characters@'));
      if (unsat.length > 0) {
        return { ok: false, status: 409, doc: this.doc, error: `the rollback target's data packs are no longer installed: ${unsat.join(', ')}` };
      }
      const rolled: Release = { ...live, state: 'rolled_back' };
      let history = this.doc.history.map((r) => (r.revision === live.revision ? rolled : r));
      if (target.revision !== 0) {
        history = history.map((r) => (r.revision === target.revision ? { ...r, state: 'live' as ReleaseState } : r));
      }
      const next = { ...this.doc, history, liveRevision: target.revision };
      this.accept(next, 'release.rollback', rolled, `live is now ${target.revision === 0 ? 'the builtin release' : `revision ${target.revision}`}`);
      return { ok: true, doc: this.doc, release: rolled };
    });
  }

  /** The panic switch. Same word as the flag freeze, different terminal state (D5). */
  setFrozen(ifRevision: number, frozen: boolean): Promise<ReleaseResult> {
    return this.mutate(() => {
      const conflict = this.cas(ifRevision);
      if (conflict !== null) return conflict;
      if (this.doc.frozen === frozen) return { ok: true, doc: this.doc };
      this.accept({ ...this.doc, frozen }, frozen ? 'release.freeze' : 'release.unfreeze', null, frozen ? 'staged releases stop reaching new rooms' : 'staged releases resume');
      return { ok: true, doc: this.doc };
    });
  }

  /* --- the in-process gate ---------------------------------------------- */

  /**
   * `runGate(inventory, draft, base)` from docs/PACKS.md §4: runs in the
   * process that would serve the release, against the bytes on this host's
   * disk and the fingerprints compiled into this binary. `gate.nonempty` is
   * load-bearing here — the check list is assembled dynamically per pack.
   */
  private runGate(draft: Release, base: Release): GateReport {
    const t0 = this.clock();
    const checks: GateCheck[] = [];

    checks.push(...checkPacksDeclared(draft.packs.filter((p) => PACKS[p.kind]?.cls === 'build')));

    for (const p of draft.packs) {
      if (p.inputs.length > MAX_PACK_INPUTS) {
        checks.push({ id: 'packs.inputs', ok: false, detail: `${p.label} has ${p.inputs.length} inputs, over the ${MAX_PACK_INPUTS} cap` });
      }
      const oversize = p.inputs.find((l) => Buffer.byteLength(l, 'utf8') > MAX_PACK_INPUT_BYTES);
      if (oversize !== undefined) {
        checks.push({ id: 'packs.inputs', ok: false, detail: `${p.label} input line over ${MAX_PACK_INPUT_BYTES} bytes: ${oversize.slice(0, 40)}…` });
      }
    }

    const levelsDecl = draft.packs.find((p) => p.kind === PackKind.LEVELS);
    let installedIds = new Set<string>();
    if (levelsDecl !== undefined) {
      const dir = this.inventory.levelsDirFor(levelsDecl.version);
      if (dir === null) {
        checks.push({ id: 'packs.installed', ok: false, detail: `${levelsDecl.label} is not installed on this host` });
      } else {
        const files = scanLevelDir(dir);
        checks.push(checkPacksInstalled(files, dir));
        checks.push(checkPacksUnique(files));
        const served = files.filter((f): f is typeof f & { level: Level; bytes: Uint8Array } => f.level !== null && f.bytes !== null && f.id.length > 0);
        const winners = new Map<string, { id: string; bytes: Uint8Array; fromSource: boolean }>();
        for (const f of served) {
          const prev = winners.get(f.id);
          if (prev !== undefined && prev.fromSource && !f.fromSource) continue;
          winners.set(f.id, { id: f.id, bytes: f.bytes, fromSource: f.fromSource });
        }
        installedIds = new Set(winners.keys());
        checks.push(checkLevelsValidate(served.map((f) => ({ id: f.id, validation: validateLevel(f.level, f.level.meta.defaultSkill) }))));
        checks.push(checkLevelsCanonical(files));
        if (levelsDecl.digest.length > 0) {
          // Recomputed from THIS scan of the disk, never from a cached
          // record: the byte edit between approval and serve is exactly what
          // this check exists to see (docs/PACKS.md 8.12), and a cache would
          // hold the pre-edit truth.
          const fresh = levelsDigest([...winners.values()]);
          if (fresh !== levelsDecl.digest) {
            checks.push({ id: 'packs.installed', ok: false, detail: `${levelsDecl.label}: the bytes on disk are not the declared bytes (digest mismatch)` });
          }
        }
      }
    }

    const campaignDecl = draft.packs.find((p) => p.kind === PackKind.CAMPAIGN);
    if (campaignDecl !== undefined) {
      const installed = this.inventory.campaignAt(campaignDecl.version);
      if (installed === null) {
        checks.push({ id: 'packs.installed', ok: false, detail: `${campaignDecl.label} is not installed on this host` });
      } else {
        checks.push(checkCampaignRefs(installed.manifest, installedIds));
        if (campaignDecl.digest.length > 0 && installed.pack.digest !== campaignDecl.digest) {
          checks.push({ id: 'packs.installed', ok: false, detail: `${campaignDecl.label}: digest mismatch` });
        }
      }
    }

    checks.push(checkProtocolStable());
    checks.push(checkFlagsOrder());
    const saves = checkSavesSchema();
    checks.push(saves.check);

    if (!Number.isInteger(draft.ordinal) || draft.ordinal <= base.ordinal || draft.ordinal > MAX_ORDINAL) {
      checks.push({ id: 'ordinal.monotonic', ok: false, detail: `ordinal ${draft.ordinal} must be > ${base.ordinal} and <= ${MAX_ORDINAL}` });
    } else {
      checks.push({ id: 'ordinal.monotonic', ok: true, detail: '' });
    }

    checks.push(checks.length === 0
      ? { id: 'gate.nonempty', ok: false, detail: 'the gate ran no checks — an empty list is a failure, never a pass' }
      : { id: 'gate.nonempty', ok: true, detail: '' });

    const failures = checks.filter((c) => !c.ok);
    return {
      ok: failures.length === 0,
      ranMs: this.clock() - t0,
      checks: [...failures, ...checks.filter((c) => c.ok)],
      diff: diffPacks(draft.packs, base.packs),
      schemaTouching: saves.schemaTouching,
    };
  }
}

/* ------------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------------ */

function emptyDoc(): ReleaseDoc {
  return Object.freeze({ history: [], liveRevision: 0, pendingRevision: 0, frozen: false, revision: 1 });
}

function sanitiseDoc(input: ReleaseDoc): ReleaseDoc {
  const history = Array.isArray(input.history) ? input.history : [];
  return Object.freeze({
    history,
    liveRevision: Number.isInteger(input.liveRevision) ? input.liveRevision : 0,
    pendingRevision: Number.isInteger(input.pendingRevision) ? input.pendingRevision : 0,
    frozen: input.frozen === true,
    revision: Number.isInteger(input.revision) && input.revision >= 1 ? input.revision : 1,
  });
}

function replaceRelease(doc: ReleaseDoc, revision: number, next: Release): ReleaseDoc {
  return { ...doc, history: doc.history.map((r) => (r.revision === revision ? next : r)) };
}

/**
 * The history cap that never evicts what resolution can still reach (D6):
 * the live revision, the pending revision, any in-flight draft/review/staged
 * release, and the baseRevision chain from live and pending. An
 * unreachable-live document is the one input that could take room creation
 * down fleet-wide.
 *
 * The chain is every previous live release, so on a long-lived host it IS
 * the history and the cap would dead-end (the first version of this
 * function did exactly that, and evicted the just-created draft as the only
 * "expendable" entry). So when everything left is chain, the chain is
 * trimmed from its DEEPEST ancestor and the release that pointed at it is
 * re-based onto revision 0 — the builtin release. Rolling back past the
 * horizon lands on the compiled-in content, which is Rule E's floor, not a
 * hole.
 */
function capHistory(doc: ReleaseDoc): ReleaseDoc {
  if (doc.history.length <= MAX_RELEASE_HISTORY) return doc;
  let history = [...doc.history];
  const byRev = (rev: number): Release | undefined => history.find((r) => r.revision === rev);

  const keep = new Set<number>();
  const walk = (rev: number): void => {
    while (rev !== 0 && !keep.has(rev)) {
      keep.add(rev);
      rev = byRev(rev)?.baseRevision ?? 0;
    }
  };
  walk(doc.liveRevision);
  walk(doc.pendingRevision);
  for (const r of history) {
    if (r.state === 'draft' || r.state === 'review' || r.state === 'staged') keep.add(r.revision);
  }

  // First: everything outside the protected set, oldest first.
  for (let i = 0; i < history.length && history.length > MAX_RELEASE_HISTORY; ) {
    if (keep.has(history[i].revision)) { i++; continue; }
    history.splice(i, 1);
  }

  // Then: trim the chain's tail. The deepest ancestor is a release whose own
  // base is 0 (or already gone) and which nothing needs except as a rollback
  // target several steps back — the one thing the cap is allowed to forget.
  while (history.length > MAX_RELEASE_HISTORY) {
    const deepest = history.find((r) =>
      r.revision !== doc.liveRevision
      && r.revision !== doc.pendingRevision
      && r.state !== 'draft' && r.state !== 'review' && r.state !== 'staged'
      && (r.baseRevision === 0 || byRev(r.baseRevision) === undefined)
      && history.some((c) => c.baseRevision === r.revision));
    if (deepest === undefined) break; // nothing safely trimmable; oversize beats unreachable-live
    history = history
      .filter((r) => r.revision !== deepest.revision)
      .map((r) => (r.baseRevision === deepest.revision ? { ...r, baseRevision: 0 } : r));
  }
  return { ...doc, history };
}

function diffPacks(to: readonly PackVersion[], from: readonly PackVersion[]): PackDiff[] {
  const out: PackDiff[] = [];
  for (const p of to) {
    const base = from.find((b) => b.kind === p.kind);
    const removed = base === undefined ? [] : base.inputs.filter((l) => !p.inputs.includes(l));
    const added = p.inputs.filter((l) => base === undefined || !base.inputs.includes(l));
    const changes = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].slice(0, 40);
    if (base !== undefined && changes.length === 0 && base.label === p.label) continue;
    out.push({ key: p.key, from: base?.label ?? '', to: p.label, changes });
  }
  return out;
}

/** FNV-1a over bytes — hashLevelBytes' arithmetic. */
function fnvOf(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The wire identity of a release, shared by the factory and /api/version. */
export function releaseContentHash(release: Release): number {
  return packSetHash(release.packs, release.ordinal);
}

/** sha256 helper kept for parity with gate.ts (unused externally today). */
export function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
