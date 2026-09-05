/**
 * DOOMCRAFT — the Creator Studio's write path (docs/STUDIO.md S1).
 *
 * The operator authors DATA-class content from the admin panel; everything
 * here lands as a NEW pack version directory on the volume and still has to
 * walk draft → gate → approve → promote to reach a player. The two
 * build-class designers (weapons, characters) emit DRAFTS under
 * `DOOMCRAFT_DATA/studio/` — structured change requests for the platform
 * lane — never installed content (docs/STUDIO.md §2, Rule A).
 *
 * Every save validates with the SAME functions the gate runs, and a save
 * that would fail the gate is refused here, with the refusal verbatim — an
 * editor that lets you save what the machine will refuse is an editor that
 * wastes your evening.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compileLevel,
  formatValidation,
  parseLevelJson,
  validateLevel,
} from '@doomcraft/shared/level';
import { challengeGrantRefusal, parseItemsManifest, type ItemDef } from '@doomcraft/shared/items';
import { parseChallengesManifest } from '@doomcraft/shared/challenges';
import { sanitiseContentId } from '@doomcraft/shared/modes';
import {
  charactersFingerprintInputs,
} from '@doomcraft/shared/characters';
import { weaponsFingerprintInputs } from '@doomcraft/shared/version';

import { checkCampaignRefs, parseEpisodesManifest, scanLevelDir } from './gate.js';
import type { PackInventory } from './packs.js';

export interface StudioOptions {
  packsRoot: string | null;
  dataRoot: string;
  clock?: () => number;
}

export type StudioResult =
  | { ok: true; label: string; version: number; detail: string }
  | { ok: false; status: number; error: string };

export interface StudioStatus {
  writable: boolean;
  /** Why not, when not. Rendered verbatim. */
  reason: string;
  packsRoot: string | null;
  drafts: { file: string; kind: string; ms: number }[];
}

export class StudioService {
  private readonly inventory: PackInventory;
  private readonly packsRoot: string | null;
  private readonly draftsDir: string;
  private readonly clock: () => number;

  constructor(inventory: PackInventory, options: StudioOptions) {
    this.inventory = inventory;
    this.packsRoot = options.packsRoot;
    this.draftsDir = join(options.dataRoot, 'studio');
    this.clock = options.clock ?? (() => Date.now());
  }

  /* --- status ----------------------------------------------------------- */

  status(): StudioStatus {
    const drafts: StudioStatus['drafts'] = [];
    if (existsSync(this.draftsDir)) {
      for (const name of readdirSync(this.draftsDir).sort().reverse().slice(0, 20)) {
        const m = /^(weapons|characters)-(\d+)\.json$/.exec(name);
        if (m !== null) drafts.push({ file: name, kind: m[1], ms: Number(m[2]) });
      }
    }
    if (this.packsRoot === null) {
      return {
        writable: false, packsRoot: null, drafts,
        reason: 'DOOMCRAFT_PACKS is not set. The content/ fallback is bundle-owned and never '
          + 'written — point DOOMCRAFT_PACKS at a directory on the persistent volume '
          + '(Railway: /data/packs) and restart.',
      };
    }
    try {
      mkdirSync(this.packsRoot, { recursive: true });
    } catch (e) {
      return {
        writable: false, packsRoot: this.packsRoot, drafts,
        reason: `DOOMCRAFT_PACKS (${this.packsRoot}) is not writable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { writable: true, packsRoot: this.packsRoot, drafts, reason: '' };
  }

  private root(): string | StudioResult {
    const st = this.status();
    if (!st.writable) return { ok: false, status: 409, error: st.reason };
    return this.packsRoot as string;
  }

  /** tmp-then-rename into a version directory that must not exist yet. */
  private writeVersioned(key: string, version: number, files: Record<string, string>): void {
    const dir = join(this.packsRoot as string, key, String(version));
    /* Immutability protects a version that EXISTS, not the empty directory a
     * torn save left behind: the version numbering counts a version only
     * once its manifest file is in it, so a crash between mkdir and rename
     * used to wedge the studio forever — every retry recomputed the same
     * number and hit this throw, with no way out but a shell on the volume. */
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw new Error(`${key}@${version} already exists — a version directory is immutable`);
    }
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const target = join(dir, name);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, target);
    }
  }

  /* --- items ------------------------------------------------------------ */

  saveItems(manifestText: string): StudioResult {
    const root = this.root();
    if (typeof root !== 'string') return root;
    const parsed = parseItemsManifest(manifestText);
    if (parsed.manifest === null) {
      return { ok: false, status: 400, error: `the manifest would fail items.validate: ${parsed.errors.join('; ')}` };
    }
    const versions = this.inventory.itemsVersions();
    const next = (versions.at(-1) ?? 0) + 1;
    // The §7 hazard, surfaced at SAVE time, before the gate even runs.
    const current = versions.length > 0 ? this.inventory.itemsAt(versions[versions.length - 1]) : null;
    const now = new Set(parsed.manifest.items.map((i) => i.id));
    const gone = (current?.manifest.items ?? []).map((i) => i.id).filter((id) => !now.has(id));
    try {
      this.writeVersioned('items', next, { 'items.json': manifestText });
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
    }
    return {
      ok: true, label: `items@${next}`, version: next,
      detail: gone.length === 0
        ? `${parsed.manifest.items.length} items`
        : `${parsed.manifest.items.length} items; REMOVES ${gone.length} id(s) (${gone.slice(0, 6).join(', ')}) — every owned copy goes dormant when this goes live`,
    };
  }

  /* --- levels ----------------------------------------------------------- */

  /** The level lab's dry-run: the REAL validator's full report, never a write. */
  validateLevelSource(sourceText: string): { ok: boolean; id: string; report: string; errors: string[] } {
    const src = parseLevelJson(sourceText);
    if (src === null) return { ok: false, id: '', report: '', errors: ['not valid level JSON'] };
    let level;
    try {
      level = compileLevel(src);
    } catch (e) {
      return { ok: false, id: '', report: '', errors: [`compile failed: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const id = sanitiseContentId(level.meta.id);
    if (id.length === 0) return { ok: false, id: '', report: '', errors: ['meta.id is missing or not a lowercase slug'] };
    level.meta.id = id;
    const validation = validateLevel(level, level.meta.defaultSkill);
    const reachSkipped = validation.warnings.some((w) => w.code === 'W_REACH_SKIPPED');
    return {
      // The GATE's standard, not the loader's: W_REACH_SKIPPED is fatal for a publish.
      ok: validation.ok && !reachSkipped,
      id,
      report: formatValidation(id, validation),
      errors: validation.ok && !reachSkipped ? [] : [formatValidation(id, validation)],
    };
  }

  /**
   * Save one level into a NEW levels version: every file of the current
   * newest version, plus (or replacing) this one. A levels pack is the SET —
   * a version directory always carries the whole campaign.
   */
  saveLevel(sourceText: string): StudioResult {
    const root = this.root();
    if (typeof root !== 'string') return root;
    const verdict = this.validateLevelSource(sourceText);
    if (!verdict.ok) {
      return { ok: false, status: 400, error: `the level would fail levels.validate: ${verdict.errors.join('; ')}` };
    }
    const versions = this.inventory.levelsVersions();
    const next = (versions.at(-1) ?? 0) + 1;
    const files: Record<string, string> = {};
    if (versions.length > 0) {
      const dir = this.inventory.levelsDirFor(versions[versions.length - 1]);
      if (dir !== null) {
        for (const f of scanLevelDir(dir)) {
          files[f.file.split('/').pop() as string] = Buffer.from(f.stored).toString('utf8');
        }
      }
    }
    files[`${verdict.id}.json`] = sourceText;
    try {
      this.writeVersioned('levels', next, files);
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
    }
    return {
      ok: true, label: `levels@${next}`, version: next,
      detail: `${Object.keys(files).length} level file(s); ${verdict.report}`,
    };
  }

  /* --- campaign --------------------------------------------------------- */

  saveCampaign(manifestText: string): StudioResult {
    const root = this.root();
    if (typeof root !== 'string') return root;
    const manifest = parseEpisodesManifest(manifestText);
    if (manifest === null) return { ok: false, status: 400, error: 'episodes manifest is not valid JSON' };
    const lv = this.inventory.levelsVersions();
    const levelsDir = lv.length > 0 ? this.inventory.levelsDirFor(lv[lv.length - 1]) : null;
    const installedIds = new Set(
      levelsDir === null ? [] : scanLevelDir(levelsDir).map((f) => f.id).filter((id) => id.length > 0),
    );
    const refs = checkCampaignRefs(manifest, installedIds);
    if (!refs.ok) {
      return { ok: false, status: 400, error: `the manifest would fail campaign.refs (against levels@${lv.at(-1) ?? '?'}): ${refs.detail}` };
    }
    const next = (this.inventory.campaignVersions().at(-1) ?? 0) + 1;
    try {
      this.writeVersioned('campaign', next, { 'episodes.json': manifestText });
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, label: `campaign@${next}`, version: next, detail: `${manifest.episodes.length} episode(s)` };
  }

  /* --- quests: the challenge board (docs/STUDIO.md S4) ------------------- */

  /**
   * The dry run the console's CHECK button calls — the same two gates a
   * save walks, no write, no audit row. The parser is the mint bound
   * (per-def and manifest Scrap caps), so a refusal here is the money
   * saying no, verbatim.
   */
  validateQuestsSource(text: string): { ok: boolean; detail: string } {
    const parsed = parseChallengesManifest(text);
    if (parsed.manifest === null) return { ok: false, detail: parsed.errors.join('; ') };
    /* Item refs are checked against EVERY installed items version, not just
     * the newest. The gate checks the pairing the DRAFT names, so refusing
     * an id that lives only in an older version would make a pairing the
     * gate would happily pass unauthorable — and the dormant direction
     * (an id dropped by a newer items cut) is legal by docs/PACKS.md §7. */
    const iv = this.inventory.itemsVersions();
    const known = new Map<string, ItemDef>();
    for (const v of iv) {
      for (const i of this.inventory.itemsAt(v)?.manifest.items ?? []) known.set(i.id, i);
    }
    const missing = parsed.manifest.challenges
      .filter((c) => c.item !== null && !known.has(c.item))
      .map((c) => `${c.id} pays "${c.item ?? ''}"`);
    if (missing.length > 0) {
      return {
        ok: false,
        detail: `would fail quests.refs — no installed items version (${iv.join(', ') || 'none'}) `
          + `carries: ${missing.join('; ')}`,
      };
    }
    /* The SECOND half of quests.refs, and it has to be here because this
     * function is a second door onto the same decision — it does its own id
     * lookup across every installed version rather than calling
     * checkQuestsRefs, so a rule added only to the gate would let the studio
     * bless a quests pack the release gate then refuses forever. Both doors
     * call `challengeGrantRefusal`, so the set each ACCEPTS agrees by
     * construction (HANDOVER §0 rule 29). */
    const forbidden: string[] = [];
    for (const c of parsed.manifest.challenges) {
      const def = c.item === null ? undefined : known.get(c.item);
      if (def === undefined) continue;
      const refusal = challengeGrantRefusal(def);
      if (refusal !== null) forbidden.push(`${c.id} pays ${refusal}`);
    }
    if (forbidden.length > 0) {
      return { ok: false, detail: `would fail quests.refs — ${forbidden.join('; ')}` };
    }
    const total = parsed.manifest.challenges.reduce((sum, c) => sum + c.scrap, 0);
    return {
      ok: true,
      detail: `${parsed.manifest.challenges.length} challenge(s), paying ${total} Scrap a full board`,
    };
  }

  saveQuests(manifestText: string): StudioResult {
    const root = this.root();
    if (typeof root !== 'string') return root;
    const verdict = this.validateQuestsSource(manifestText);
    if (!verdict.ok) {
      return { ok: false, status: 400, error: `the manifest would fail quests.validate: ${verdict.detail}` };
    }
    const next = (this.inventory.questsVersions().at(-1) ?? 0) + 1;
    try {
      this.writeVersioned('quests', next, { 'quests.json': manifestText });
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, label: `quests@${next}`, version: next, detail: verdict.detail };
  }

  /* --- the build-class designers: drafts, never packs -------------------- */

  saveDraft(kind: 'weapons' | 'characters', body: unknown): StudioResult & { diff?: string[] } {
    if (body === null || typeof body !== 'object') {
      return { ok: false, status: 400, error: 'the draft body must be a JSON object' };
    }
    const ms = this.clock();
    const file = `${kind}-${ms}.json`;
    try {
      mkdirSync(this.draftsDir, { recursive: true });
      const target = join(this.draftsDir, file);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      renameSync(tmp, target);
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
    }
    // What the platform lane would be changing: the compiled truth, as lines.
    const current = kind === 'weapons' ? weaponsFingerprintInputs() : charactersFingerprintInputs();
    return {
      ok: true, label: file, version: 0,
      detail: `draft saved under DOOMCRAFT_DATA/studio/ — a ${kind} change is BUILD-class `
        + '(the client predicts from its compiled tables), so this ships through the platform '
        + 'lane: hand the draft to a Claude Code session and it lands as a commit with the '
        + 'ratchets moved',
      diff: current,
    };
  }
}
