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
  MAX_RELEASE_HISTORY,
  PACKS,
  PackKind,
  campaignPack,
  itemsPack,
  levelsPack,
  packSetHash,
  questsPack,
  releaseAt,
  variantsPack,
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
import { formatValidation, type Level } from '@doomcraft/shared/level';
import {
  ItemKind,
  ItemRarity,
  formatItemRef,
  itemsFingerprintInputs,
  parseItemsManifest,
  type ItemsManifest,
} from '@doomcraft/shared/items';
import {
  challengesFingerprintInputs,
  parseChallengesManifest,
  type ChallengesManifest,
} from '@doomcraft/shared/challenges';
import {
  parseVariantsManifest,
  variantsFingerprintInputs,
  type VariantsManifest,
} from '@doomcraft/shared/variants';

import {
  DEFAULT_EPISODES_FILE,
  DEFAULT_ITEMS_FILE,
  DEFAULT_QUESTS_FILE,
  DEFAULT_VARIANTS_FILE,
  campaignDigest,
  checkCampaignRefs,
  checkFlagsOrder,
  checkLevelsCanonical,
  checkLevelsValidate,
  checkPackInputs,
  checkPacksDeclared,
  checkPacksInstalled,
  checkPacksUnique,
  checkProtocolStable,
  checkQuestsRefs,
  checkQuestsValidate,
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
  /** The version-1 fallback for items. Defaults to `content/items.json`. */
  itemsFallbackFile?: string;
  /** The version-1 fallback for variants. Defaults to `content/variants.json`. */
  variantsFallbackFile?: string;
  /** The version-1 fallback for quests. Defaults to `content/quests.json`. */
  questsFallbackFile?: string;
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
  private readonly itemsFallbackFile: string;
  private readonly variantsFallbackFile: string;
  private readonly questsFallbackFile: string;
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
    this.itemsFallbackFile = resolve(options.itemsFallbackFile ?? DEFAULT_ITEMS_FILE);
    this.variantsFallbackFile = resolve(options.variantsFallbackFile ?? DEFAULT_VARIANTS_FILE);
    this.questsFallbackFile = resolve(options.questsFallbackFile ?? DEFAULT_QUESTS_FILE);
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

  itemsFileFor(version: number): string | null {
    if (this.packsRoot !== null) {
      const file = join(this.packsRoot, 'items', String(version), 'items.json');
      if (existsSync(file)) return file;
    }
    if (version === 1 && existsSync(this.itemsFallbackFile)) return this.itemsFallbackFile;
    return null;
  }

  itemsVersions(): number[] {
    const out = new Set<number>();
    if (existsSync(this.itemsFallbackFile)) out.add(1);
    if (this.packsRoot !== null) {
      const root = join(this.packsRoot, 'items');
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          const v = Number(name);
          if (Number.isInteger(v) && v >= 1 && this.itemsFileFor(v) !== null) out.add(v);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  itemsAt(version: number): { pack: PackVersion; manifest: ItemsManifest } | null {
    const file = this.itemsFileFor(version);
    if (file === null) return null;
    const parsed = parseItemsManifest(readFileSync(file, 'utf8'));
    if (parsed.manifest === null) return null;
    const inputs = itemsFingerprintInputs(parsed.manifest);
    const base = itemsPack(inputs, version);
    const digest = createHash('sha256').update(inputs.join('\n'), 'utf8').digest('hex');
    return { pack: { ...base, digest }, manifest: parsed.manifest };
  }

  /**
   * V4a: `content/variants.json` IS variants@1, exactly as `content/items.json`
   * is items@1.
   *
   * THIS METHOD USED TO HAVE NO FALLBACK, AND THE REASON HAS EXPIRED. V2
   * shipped the BINARY that understands kind 7 and no content, because the
   * variants-aware binary had to be live BEFORE any release could name kind 7:
   * a host that predated it cannot satisfy the pack, so it Rule-E-falls-back
   * to the previous release on every room, silently. The deployed origin now
   * reports `weapons@2` — that condition is satisfied — so the bundled content
   * can ship and an unconfigured deploy (no DOOMCRAFT_PACKS, which is what
   * Railway runs) serves real variants instead of an empty table.
   *
   * PACKSROOT WINS, AND THE ORDER IS NOT A STYLE CHOICE. It is copied from
   * `itemsFileFor` above for one measured reason: with the fallback first, an
   * installed `variants/1/variants.json` — the operator's own pack, minted by
   * the Studio and walked through the release machine — would be SHADOWED by
   * whatever this repo happens to bundle. Measured with the two branches
   * swapped: a host with a one-row installed `variants@1` resolves this
   * repo's TWO rows instead, under the operator's own label and under a green
   * gate, because both are called version 1 and only the loser is the one
   * anybody approved. The installed bytes are the ones with a release
   * document behind them; the bundled file is the floor for a host that has
   * none. `releases.test.ts` pins the order with counts that differ, so the
   * assertion cannot pass under either branch order.
   *
   * Note that the two are NOT interchangeable even at the same version number:
   * their digests differ, so `unsatisfied()` still refuses a release pinned to
   * one when the host resolves the other, and `runGate` prints a digest
   * mismatch rather than quietly serving the substitute.
   */
  variantsFileFor(version: number): string | null {
    if (this.packsRoot !== null) {
      const file = join(this.packsRoot, 'variants', String(version), 'variants.json');
      if (existsSync(file)) return file;
    }
    if (version === 1 && existsSync(this.variantsFallbackFile)) return this.variantsFallbackFile;
    return null;
  }

  variantsVersions(): number[] {
    const out = new Set<number>();
    if (existsSync(this.variantsFallbackFile)) out.add(1);
    if (this.packsRoot !== null) {
      const root = join(this.packsRoot, 'variants');
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          const v = Number(name);
          if (Number.isInteger(v) && v >= 1 && this.variantsFileFor(v) !== null) out.add(v);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  variantsAt(version: number): { pack: PackVersion; manifest: VariantsManifest } | null {
    const file = this.variantsFileFor(version);
    if (file === null) return null;
    const parsed = parseVariantsManifest(readFileSync(file, 'utf8'));
    if (parsed.manifest === null) return null;
    const inputs = variantsFingerprintInputs(parsed.manifest);
    const base = variantsPack(inputs, version);
    const digest = createHash('sha256').update(inputs.join('\n'), 'utf8').digest('hex');
    return { pack: { ...base, digest }, manifest: parsed.manifest };
  }

  questsFileFor(version: number): string | null {
    if (this.packsRoot !== null) {
      const file = join(this.packsRoot, 'quests', String(version), 'quests.json');
      if (existsSync(file)) return file;
    }
    if (version === 1 && existsSync(this.questsFallbackFile)) return this.questsFallbackFile;
    return null;
  }

  questsVersions(): number[] {
    const out = new Set<number>();
    if (existsSync(this.questsFallbackFile)) out.add(1);
    if (this.packsRoot !== null) {
      const root = join(this.packsRoot, 'quests');
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          const v = Number(name);
          if (Number.isInteger(v) && v >= 1 && this.questsFileFor(v) !== null) out.add(v);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  questsAt(version: number): { pack: PackVersion; manifest: ChallengesManifest } | null {
    const file = this.questsFileFor(version);
    if (file === null) return null;
    const parsed = parseChallengesManifest(readFileSync(file, 'utf8'));
    if (parsed.manifest === null) return null;
    const inputs = challengesFingerprintInputs(parsed.manifest);
    const base = questsPack(inputs, version);
    // The digest is what makes /api/version render this as a DATA pack —
    // cls is inferred from `digest.length > 0`, same as items.
    const digest = createHash('sha256').update(inputs.join('\n'), 'utf8').digest('hex');
    return { pack: { ...base, digest }, manifest: parsed.manifest };
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
    const levels = this.newestParsing(this.levelsVersions(), (v) => this.levelsPackAt(v));
    if (levels !== null) out.push(levels);
    const campaign = this.newestParsing(this.campaignVersions(), (v) => this.campaignAt(v));
    if (campaign !== null) out.push(campaign.pack);
    const items = this.newestParsing(this.itemsVersions(), (v) => this.itemsAt(v));
    if (items !== null) out.push(items.pack);
    const quests = this.newestParsing(this.questsVersions(), (v) => this.questsAt(v));
    if (quests !== null) out.push(quests.pack);
    // The NEWEST installed variants pack, exactly as every other data kind.
    // Omitting it meant an ordinary draft — which starts from this set —
    // silently dropped a live variants pack from the next release.
    const variants = this.newestParsing(this.variantsVersions(), (v) => this.variantsAt(v));
    if (variants !== null) out.push(variants.pack);
    return out;
  }

  /**
   * The newest installed version of a data kind that ACTUALLY PARSES — not
   * simply the newest installed one.
   *
   * The difference is a real defect this closed. Each kind used to try the
   * highest version number on disk and, when it came back null, emit no pack
   * of that kind at all. So a good variants@1 beside a schema-refused
   * variants@2 produced a set with NO kind 7 in it, and everything downstream
   * read that as "this host has no variants": an ordinary draft carried no
   * kind 7, `runGate` skipped its entire variants block — `variants.validate`
   * and `variants.dormanted` included — and the gate returned OK for a release
   * that serves no variants at all. A green gate over a release that will
   * serve something else is the worst outcome this system has.
   *
   * Skipping to the newest readable version is the honest answer for THIS
   * method, because this method's whole job is to say what this host can
   * serve — and it can still serve variants@1. It must also stay total:
   * `hostFallback()` sits on the never-throws room-resolution path (8.3), so
   * an unreadable file on disk must not be able to make a room unresolvable.
   * A content typo is not an outage.
   *
   * The LOUD half of the answer lives where a refusal is affordable instead:
   * `unparseable()` below, read by the publish gate. Falling back silently
   * would ship variants@1 under a green gate while the operator believed they
   * were shipping the variants@2 they had just installed, which is the same
   * lie wearing a different hat.
   */
  private newestParsing<T>(versions: number[], at: (version: number) => T | null): T | null {
    for (let i = versions.length - 1; i >= 0; i--) {
      const got = at(versions[i]);
      if (got !== null) return got;
    }
    return null;
  }

  /**
   * Every installed data-pack version whose bytes are on disk and whose
   * manifest does not parse. The gate refuses on a non-empty answer.
   *
   * WHY THIS REFUSES FOR EVERY INSTALLED VERSION AND NOT ONLY THE ONE THE
   * DRAFT NAMES. Scoping it to the draft would leave the hole open in the one
   * case that matters most: when EVERY installed version of a kind is
   * unreadable, the draft names no version of that kind, so a draft-scoped
   * check has nothing to fire on and the gate goes green over a kind the host
   * has content for and cannot read. A version kept on disk is also a
   * rollback target — `unsatisfied()` re-parses it — so an unparseable one is
   * not merely unshippable, it is unrollbackable-to, and there is no state in
   * which keeping it is worth anything. The remedy is one action (fix the
   * file or delete the directory) and the row names the exact label.
   */
  unparseable(): { kind: PackKind; version: number; label: string }[] {
    const out: { kind: PackKind; version: number; label: string }[] = [];
    const kinds: Array<[PackKind, number[], (v: number) => unknown | null]> = [
      [PackKind.LEVELS, this.levelsVersions(), (v) => this.levelsPackAt(v)],
      [PackKind.CAMPAIGN, this.campaignVersions(), (v) => this.campaignAt(v)],
      [PackKind.ITEMS, this.itemsVersions(), (v) => this.itemsAt(v)],
      [PackKind.QUESTS, this.questsVersions(), (v) => this.questsAt(v)],
      [PackKind.VARIANTS, this.variantsVersions(), (v) => this.variantsAt(v)],
    ];
    for (const [kind, versions, at] of kinds) {
      for (const version of versions) {
        if (at(version) !== null) continue;
        out.push({ kind, version, label: `${PACKS[kind]?.key ?? 'pack'}@${version}` });
      }
    }
    return out;
  }

  /**
   * What the Inventory screen renders: every installed version of every data
   * pack, with each refused member and the reason, straight from the
   * library's own diagnostics. A version with any refused member cannot pass
   * the gate, and the row says so before the operator tries.
   */
  summary(): {
    levels: { version: number; total: number; playable: number; fingerprint: number; digest: string; refused: { id: string; detail: string }[] }[];
    campaign: { version: number; episodes: number; fingerprint: number; digest: string }[];
    items: { version: number; count: number; fingerprint: number; digest: string }[];
    quests: { version: number; count: number; fingerprint: number; digest: string }[];
  } {
    const levels = this.levelsVersions().map((version) => {
      const record = this.recordFor(version);
      const lib = record?.library ?? null;
      const refused: { id: string; detail: string }[] = [];
      if (lib !== null) {
        for (const l of lib.all()) {
          if (!l.validation.ok) refused.push({ id: l.id, detail: formatValidation(l.id, l.validation) });
        }
        for (const pr of lib.problems) refused.push({ id: pr.id || pr.file, detail: pr.message });
      }
      return {
        version,
        total: lib?.size ?? 0,
        playable: lib?.playableCount ?? 0,
        fingerprint: record?.pack?.fingerprint ?? 0,
        digest: record?.pack?.digest ?? '',
        refused,
      };
    });
    const campaign = this.campaignVersions().map((version) => {
      const c = this.campaignAt(version);
      return {
        version,
        episodes: c?.manifest.episodes.length ?? 0,
        fingerprint: c?.pack.fingerprint ?? 0,
        digest: c?.pack.digest ?? '',
      };
    });
    const items = this.itemsVersions().map((version) => {
      const i = this.itemsAt(version);
      return {
        version,
        count: i?.manifest.items.length ?? 0,
        fingerprint: i?.pack.fingerprint ?? 0,
        digest: i?.pack.digest ?? '',
      };
    });
    const quests = this.questsVersions().map((version) => {
      const q = this.questsAt(version);
      return {
        version,
        count: q?.manifest.challenges.length ?? 0,
        fingerprint: q?.pack.fingerprint ?? 0,
        digest: q?.pack.digest ?? '',
      };
    });
    return { levels, campaign, items, quests };
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
      if (p.kind === PackKind.ITEMS) {
        const installed = this.itemsAt(p.version);
        if (installed === null || (p.digest.length > 0 && installed.pack.digest !== p.digest)) out.push(p.label);
        continue;
      }
      if (p.kind === PackKind.QUESTS) {
        const installed = this.questsAt(p.version);
        if (installed === null || (p.digest.length > 0 && installed.pack.digest !== p.digest)) out.push(p.label);
        continue;
      }
      if (p.kind === PackKind.VARIANTS) {
        const installed = this.variantsAt(p.version);
        if (installed === null || (p.digest.length > 0 && installed.pack.digest !== p.digest)) out.push(p.label);
        continue;
      }
      // A data kind with no branch above is PERMANENTLY unsatisfiable —
      // every release naming it silently Rule-E-falls-back forever. Adding a
      // pack kind means adding its branch here FIRST (the S4 lesson).
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

/**
 * S3: the expansion one-click's selection — a specific installed version per
 * data pack, and the name the draft will carry into review. Absent fields
 * mean "newest installed", which is what createDraft always did.
 */
export interface DraftPicks {
  levels?: number;
  campaign?: number;
  items?: number;
  quests?: number;
  variants?: number;
  note?: string;
}

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
   *
   * S3, the expansion one-click: `picks` may name a SPECIFIC installed
   * version per data pack (a refused pick refuses the draft — never a silent
   * fallback to newest), and `note` names the expansion on the draft itself,
   * so the Review screen shows what the bundle IS before anyone approves it.
   */
  createDraft(ifRevision: number, picks: DraftPicks = {}): Promise<ReleaseResult> {
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
      let packs = this.inventory.installedPacks();
      const pickOf: Array<[PackKind, number | undefined, (v: number) => PackVersion | null]> = [
        [PackKind.LEVELS, picks.levels, (v) => this.inventory.levelsPackAt(v)],
        [PackKind.CAMPAIGN, picks.campaign, (v) => this.inventory.campaignAt(v)?.pack ?? null],
        [PackKind.ITEMS, picks.items, (v) => this.inventory.itemsAt(v)?.pack ?? null],
        [PackKind.QUESTS, picks.quests, (v) => this.inventory.questsAt(v)?.pack ?? null],
        [PackKind.VARIANTS, picks.variants, (v) => this.inventory.variantsAt(v)?.pack ?? null],
      ];
      for (const [kind, want, resolve] of pickOf) {
        if (want === undefined) continue;
        const resolved = resolve(want);
        if (resolved === null) {
          return { ok: false, status: 400, doc: this.doc, error: `${PACKS[kind]?.key ?? 'pack'}@${want} is not installed on this host` };
        }
        packs = [...packs.filter((p) => p.kind !== kind), resolved];
      }
      const revision = this.doc.revision + 1;
      const draft: Release = {
        revision,
        state: 'draft',
        ordinal,
        packs,
        rolloutBp: 0,
        baseRevision: this.doc.liveRevision,
        gate: null,
        createdMs: this.clock(),
        publishedMs: 0,
        note: (picks.note ?? '').slice(0, 120),
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

    /*
     * packs.inputs — the caps, and the SAME code gate.ts runs.
     *
     * This used to be an inline loop here and nowhere else, which made the
     * offline gate structurally unable to see a 161-byte input line: it
     * passed `npm run release:verify` and CI and was refused only here, by
     * the operator's publish attempt. §0's rule cuts both ways — a check that
     * lives only in the ONLINE gate is as split as one that lives only in the
     * offline one. `checkPackInputs` is the single implementation now, and it
     * returns a passing row when nothing is over, so the report can show the
     * caps were measured rather than showing nothing at all.
     */
    checks.push(...checkPackInputs(draft.packs));

    /*
     * packs.parse — no installed version of any data kind is unreadable.
     *
     * The hazard is not that an unreadable pack ships; it cannot ship, because
     * nothing can name it. The hazard is that it makes the KIND vanish.
     * `installedPacks()` — which every ordinary draft starts from — used to
     * drop a kind whose newest version failed to parse, so a good variants@1
     * beside a refused variants@2 produced a draft with no kind 7, and the
     * variants block below (validate AND dormanted) never ran. The gate said
     * OK about a release that served no variants at all, and the operator who
     * had just installed variants@2 was told everything was fine.
     * `newestParsing` now keeps variants@1, which fixes what gets SERVED; this
     * check is what makes the situation visible instead of merely survivable,
     * because the operator's intent was variants@2 and a silent downgrade
     * under a green gate is the same lie in the other direction.
     *
     * Not in `runReleaseVerify()` deliberately: that gate runs over the TREE
     * (content/), which has no versioned pack root to scan, so there is no
     * second copy of this check to drift from. Every check that CAN live in
     * both still does — see the `packs.inputs` note above.
     */
    const unreadable = this.inventory.unparseable();
    checks.push(unreadable.length === 0
      ? { id: 'packs.parse', ok: true, detail: '' }
      : {
        id: 'packs.parse',
        ok: false,
        detail: `installed but unreadable: ${unreadable.map((u) => u.label).join(', ')} — `
          + `this host cannot serve or roll back to ${unreadable.length === 1 ? 'it' : 'them'}, `
          + `and while ${unreadable.length === 1 ? 'it is' : 'they are'} on disk the newest version `
          + `of ${unreadable.length === 1 ? 'that kind' : 'those kinds'} is not what a draft names. `
          + `Fix the manifest or remove the version directory.`,
      });

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

    /*
     * variants.validate / packs.installed / variants.dormanted.
     *
     * THIS BLOCK, NOT ONLY THE ONE IN gate.ts. `runReleaseVerify()` and this
     * method are two different implementations of "the gate": the first is
     * what `npm run release:verify` and CI run over the TREE, and this one is
     * what the admin console runs over a DRAFT. A check added to gate.ts is
     * not added here, and a review found a candidate naming kind 7 gating
     * GREEN through this path and then falling back at serve time.
     */
    const variantsDecl = draft.packs.find((p) => p.kind === PackKind.VARIANTS);
    if (variantsDecl !== undefined) {
      const installed = this.inventory.variantsAt(variantsDecl.version);
      if (installed === null) {
        checks.push({
          id: 'packs.installed',
          ok: false,
          detail: `${variantsDecl.label} is not installed on this host (or its manifest does not parse)`,
        });
      } else {
        if (variantsDecl.digest.length > 0 && installed.pack.digest !== variantsDecl.digest) {
          checks.push({ id: 'packs.installed', ok: false, detail: `${variantsDecl.label}: digest mismatch` });
        }
        checks.push({ id: 'variants.validate', ok: true, detail: `${installed.manifest.variants.length} variant(s) parse, band and budget` });

        // The same forward-publish hazard items has, with a milder landing:
        // a removed variant's owned copies go dormant AND the room resolves
        // the equipped claim to the BASE weapon, so the player keeps firing —
        // just not the gun they bought. Counted, never refused.
        const baseDecl = base.packs.find((p) => p.kind === PackKind.VARIANTS);
        const baseInstalled = baseDecl === undefined ? null : this.inventory.variantsAt(baseDecl.version);
        const now = new Set(installed.manifest.variants.map((v) => v.id));
        const gone = baseInstalled === null
          ? []
          : baseInstalled.manifest.variants.map((v) => v.id).filter((id) => !now.has(id));
        checks.push({
          id: 'variants.dormanted',
          ok: true,
          detail: gone.length === 0
            ? ''
            : `${gone.length} variant id(s) from ${baseDecl?.label} are absent from ${variantsDecl.label} — `
              + `every owned copy goes dormant and its holder falls back to the base weapon: `
              + `${gone.slice(0, 8).join(', ')}${gone.length > 8 ? '…' : ''}`,
        });
      }
    }

    const itemsDecl = draft.packs.find((p) => p.kind === PackKind.ITEMS);
    if (itemsDecl !== undefined) {
      const installed = this.inventory.itemsAt(itemsDecl.version);
      if (installed === null) {
        checks.push({ id: 'packs.installed', ok: false, detail: `${itemsDecl.label} is not installed on this host (or its manifest does not parse)` });
      } else {
        if (itemsDecl.digest.length > 0 && installed.pack.digest !== itemsDecl.digest) {
          checks.push({ id: 'packs.installed', ok: false, detail: `${itemsDecl.label}: digest mismatch` });
        }
        /*
         * items.dormanted — docs/PACKS.md §7's named hazard: the FORWARD
         * publish is the destructive direction. Every id present in the base
         * release's items pack and absent here goes dormant in every
         * inventory that holds it, silently, at the next read. Not a
         * refusal — the operator may mean it — but the count is in the
         * report and the Review screen renders it, so it cannot be missed.
         */
        const baseItems = base.packs.find((p) => p.kind === PackKind.ITEMS);
        const baseInstalled = baseItems === undefined ? null : this.inventory.itemsAt(baseItems.version);
        const now = new Set(installed.manifest.items.map((i) => i.id));
        const gone = baseInstalled === null
          ? []
          : baseInstalled.manifest.items.map((i) => i.id).filter((id) => !now.has(id));
        checks.push({
          id: 'items.dormanted',
          ok: true,
          detail: gone.length === 0
            ? ''
            : `${gone.length} item id(s) from ${baseItems?.label} are absent from ${itemsDecl.label} — every owned copy goes dormant at the next read: ${gone.slice(0, 8).join(', ')}${gone.length > 8 ? '…' : ''}`,
        });
      }
    }

    const questsDecl = draft.packs.find((p) => p.kind === PackKind.QUESTS);
    if (questsDecl !== undefined) {
      const installed = this.inventory.questsAt(questsDecl.version);
      if (installed === null) {
        checks.push({ id: 'packs.installed', ok: false, detail: `${questsDecl.label} is not installed on this host (or its manifest does not parse)` });
      } else {
        if (questsDecl.digest.length > 0 && installed.pack.digest !== questsDecl.digest) {
          checks.push({ id: 'packs.installed', ok: false, detail: `${questsDecl.label}: digest mismatch` });
        }
        // Item refs are checked against the ITEMS version THIS DRAFT names,
        // not the newest installed: the release is the pairing that ships.
        // (No separate quests.validate here — questsAt returning non-null IS
        // the parse; a re-parse of the same bytes is a check that cannot fail.)
        const draftItems = itemsDecl === undefined ? null : this.inventory.itemsAt(itemsDecl.version);
        checks.push(checkQuestsRefs(installed.manifest, draftItems?.manifest ?? null));
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

/**
 * The drop roll: at most one item per paying round, weighted by rarity.
 * Pure — the caller supplies the randomness — so the weights are testable
 * and the distribution cannot quietly change with a refactor. Idle rounds
 * never reach this (reward.ts zeroes drops with everything else).
 */
export const DROP_CHANCE = 0.22;
export const DROP_RARITY_WEIGHTS: readonly number[] = Object.freeze([60, 25, 10, 4, 1]);

export function rollMatchDrops(
  manifest: ItemsManifest, version: number, rand: () => number,
): string[] {
  if (manifest.items.length === 0) return [];
  if (rand() >= DROP_CHANCE) return [];
  // Weight only the rarities that actually have items, so a pack with no
  // relics cannot roll one and silently drop nothing.
  const byRarity = new Map<ItemRarity, typeof manifest.items[number][]>();
  for (const item of manifest.items) {
    // Titles and trophies never DROP — they are earned (challenges, prizes).
    // Nor do weapon VARIANTS: docs/VARIANTS.md §7.2 makes them craft-only, and
    // this loop skipped only TITLE and TROPHY, so the two V4b tokens were
    // eligible from the moment they entered the manifest. Measured against a
    // manifest whose only droppable rows were the two tokens, every one of the
    // 902 drops in 4000 seeded rounds returned a variant ref.
    if (item.kind === ItemKind.TITLE || item.kind === ItemKind.TROPHY) continue;
    if (item.kind === ItemKind.WEAPON_VARIANT) continue;
    const list = byRarity.get(item.rarity) ?? [];
    list.push(item);
    byRarity.set(item.rarity, list);
  }
  let total = 0;
  for (const [rarity] of byRarity) total += DROP_RARITY_WEIGHTS[rarity] ?? 0;
  if (total <= 0) return [];
  let pick = rand() * total;
  for (const [rarity, list] of byRarity) {
    pick -= DROP_RARITY_WEIGHTS[rarity] ?? 0;
    if (pick < 0) {
      const item = list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
      return [formatItemRef(version, item.id)];
    }
  }
  return [];
}

/** The wire identity of a release, shared by the factory and /api/version. */
export function releaseContentHash(release: Release): number {
  return packSetHash(release.packs, release.ordinal);
}

/** sha256 helper kept for parity with gate.ts (unused externally today). */
export function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
