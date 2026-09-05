/**
 * DOOMCRAFT — the release gate, offline half (docs/PACKS.md §4, phase 1).
 *
 * The operator is one person. Anything whose only enforcement is careful
 * reading is theatre (Rule C), so every check here can say NO without the
 * author's cooperation, and each one's doc names the input that makes it
 * fail. `npm run release:verify` (tools/release-verify.mjs) is the CLI face;
 * phase 2's `runGate` will run the same checks inside the process that would
 * serve the release.
 *
 * What is deliberately NOT here: NSFW classifiers, OCR, perceptual hashing,
 * decompression-bomb sandboxing. Those defend against a stranger who paid you
 * (docs/SPONSORS.md §2.2); nobody uploads here but the author (Rule B).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { charactersFingerprintInputs } from '@doomcraft/shared/characters';
import { FLAG_ORDER } from '@doomcraft/shared/flags';
import {
  compileLevel,
  decodeLevel,
  encodeLevel,
  isLevelBinary,
  parseLevelJson,
  validateLevel,
  type Level,
} from '@doomcraft/shared/level';
import { parseItemsManifest, itemsFingerprintInputs, type ItemsManifest } from '@doomcraft/shared/items';
import {
  challengesFingerprintInputs,
  parseChallengesManifest,
  type ChallengesManifest,
} from '@doomcraft/shared/challenges';
import { sanitiseContentId } from '@doomcraft/shared/modes';
import { parseVariantsManifest, variantsFingerprintInputs } from '@doomcraft/shared/variants';
import {
  BUILTIN_FLAG_ORDER,
  itemsPack,
  questsPack,
  variantsPack,
  BUILTIN_PACKS,
  BUILTIN_PROTOCOL_FINGERPRINT,
  MAX_PACK_INPUTS,
  MAX_PACK_INPUT_BYTES,
  PackKind,
  campaignPack,
  levelsPack,
  type GateCheck,
  type GateReport,
  type PackDiff,
  type PackVersion,
} from '@doomcraft/shared/packs';
import { SAVES_VERSION } from '@doomcraft/shared/saves';
import {
  coreFingerprintInputs,
  fingerprint,
  protocolFingerprint,
  weaponsFingerprintInputs,
} from '@doomcraft/shared/version';

import { DEFAULT_LEVEL_DIR, MAX_LEVEL_FILE_BYTES } from './levels.js';
import { PERSIST_VERSION } from './persistence.js';

const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(here, '..', '..', '..');
export const DEFAULT_EPISODES_FILE = join(repoRoot, 'content', 'episodes.json');
export const DEFAULT_ITEMS_FILE = join(repoRoot, 'content', 'items.json');
export const DEFAULT_QUESTS_FILE = join(repoRoot, 'content', 'quests.json');
/**
 * V4a. There deliberately was NO default here through V2 and V3: the pack
 * parser, the wire and both gates shipped with no content at all, because the
 * variants-aware BINARY had to be live before any release could name kind 7 —
 * a host that predated it would have Rule-E-fallen-back to the previous
 * release, silently, on every room. The deployed origin reports `weapons@2`,
 * so that condition is satisfied and the tree can carry the content.
 */
export const DEFAULT_VARIANTS_FILE = join(repoRoot, 'content', 'variants.json');

/**
 * The schema versions this release was authored against. When either moves,
 * `saves.schema` refuses until these are bumped DELIBERATELY in the same
 * commit — because a release that touches the profile shape can never be
 * rolled back (docs/PACKS.md §7, GateReport.schemaTouching), and that
 * property must be chosen, not discovered.
 */
export const DECLARED_PERSIST_VERSION = 7;
export const DECLARED_SAVES_VERSION = 4;

/* ------------------------------------------------------------------------ *
 * One loaded level file, the gate's own view
 *
 * The gate scans the directory ITSELF rather than through LevelLibrary,
 * because the library's byId map silently keeps one winner per id — which is
 * exactly what makes a duplicate-id collision invisible to it, and
 * `packs.unique` exists to see it.
 * ------------------------------------------------------------------------ */

export interface GateLevelFile {
  readonly file: string;
  readonly id: string;
  readonly fromSource: boolean;
  readonly level: Level | null;
  /** Canonical encoded bytes (our own encoder's output). Null when unloadable. */
  readonly bytes: Uint8Array | null;
  /** Raw bytes as stored on disk. */
  readonly stored: Uint8Array;
  readonly error: string;
}

export function scanLevelDir(dir: string): GateLevelFile[] {
  if (!existsSync(dir)) return [];
  const out: GateLevelFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const ext = extname(name).toLowerCase();
    if (ext !== '.json' && ext !== '.dcl') continue;
    if (name.startsWith('.') || name === 'manifest.json') continue;
    const file = join(dir, name);
    const raw = readFileSync(file);
    const stored = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    let level: Level | null = null;
    let fromSource = false;
    let error = '';
    // The SAME cap the loader enforces (server/src/levels.ts). Without it the
    // gate certifies a level the host will silently refuse — the exact
    // gate-passes-what-the-loader-refuses inversion packs.installed exists
    // to prevent. Found by the phase-1 audit.
    if (stored.length > MAX_LEVEL_FILE_BYTES) {
      error = `file is ${stored.length} bytes, over the ${MAX_LEVEL_FILE_BYTES} cap the loader enforces`;
    } else {
      try {
        if (isLevelBinary(stored)) {
          level = decodeLevel(stored.slice());
        } else {
          const src = parseLevelJson(raw.toString('utf8'));
          if (src === null) throw new Error('not valid JSON and not a .dcl');
          level = compileLevel(src);
          fromSource = true;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const id = level === null ? '' : sanitiseContentId(level.meta.id);
    // Mirror the loader EXACTLY: it writes the sanitised id back BEFORE
    // encoding (levels.ts), so the id is inside the bytes it hashes. Hash
    // different bytes here and the reviewed identity is not the served one —
    // proven by the audit with a mixed-case meta.id splitting the two hashes.
    if (level !== null && id.length > 0) level.meta.id = id;
    out.push({
      file,
      id,
      fromSource,
      level,
      bytes: level === null ? null : encodeLevel(level),
      stored,
      error: level !== null && id.length === 0 ? 'meta.id is missing or not a lowercase slug' : error,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * The checks. Each doc comment names the input that makes it fail.
 * ------------------------------------------------------------------------ */

const ok = (id: string): GateCheck => ({ id, ok: true, detail: '' });
const fail = (id: string, detail: string): GateCheck => ({ id, ok: false, detail });

/**
 * `packs.declared` — the keystone. Fails when a build pack's declared
 * fingerprint differs from the one THIS process computes now, OR when its
 * declared INPUT LINES differ from the ones this build computes. Input that
 * makes it fail: edit one weapon field without bumping the declaration in
 * shared/src/packs.ts. Its limit is stated honestly in docs/PACKS.md 8.5:
 * for build packs it refuses a release authored against a different binary,
 * never a balance change already compiled in — the review of a balance
 * change is the input diff, read by a human.
 *
 * WHY THE INPUT LINES ARE CHECKED AND NOT MERELY PRINTED. Until this was
 * fixed, `p.inputs` was read for one purpose only — rendering the failure
 * diff — and never compared against anything. A review handed both gates a
 * weapons declaration whose `inputs` were the single line `0:lies` while
 * leaving the declared fingerprint correct, and both returned ok. That is
 * not a cosmetic hole. shared/src/packs.ts says the input lists are
 * checked-in literals ON PURPOSE, because "the input lists are what make a
 * firing ratchet print a field-level LINE DIFF instead of two hex numbers"
 * and "the reviewable artifact is the diff, never the number". An unchecked
 * literal means the ratchet's one deliverable — the diff an operator reads
 * to decide whether they meant the change — can be a lie about what the
 * previous build declared, while the check that is supposed to be watching
 * the declaration prints ok. A green check that cannot fail is worse than no
 * check; this one could not fail on the half of the declaration the whole
 * mechanism exists to produce.
 *
 * WHY IT IS THE SAME CHECK ID, NOT A NEW ONE. A pack gets one verdict.
 * `GateCheck.id` is what the console groups on, and `packs.declared.<key>`
 * IS the per-pack row; minting a second id would let one pack render green
 * and red at once in the same report, and would leave every existing
 * consumer that matches on `packs.declared.` blind to the new refusal. The
 * remedy genuinely differs between the two halves, so the DETAIL differs
 * instead — it names which of the fingerprint and the lines is wrong, and
 * the fp-agrees-lines-lie case says outright that the declaration is
 * internally inconsistent, because that is the one an operator will not
 * guess.
 */
export function checkPacksDeclared(declared: readonly PackVersion[] = BUILTIN_PACKS): GateCheck[] {
  const computed: Partial<Record<PackKind, readonly string[]>> = {
    [PackKind.CORE]: coreFingerprintInputs(),
    [PackKind.WEAPONS]: weaponsFingerprintInputs(),
    [PackKind.CHARACTERS]: charactersFingerprintInputs(),
  };
  const out: GateCheck[] = [];
  // A declared list this check cannot fully verify is REFUSED, never skipped:
  // silently passing an unknown kind would let a doctored release document
  // sail through phase 2's runGate with zero scrutiny (audit finding). And a
  // duplicate kind would quietly break packSetHash's order-insensitivity.
  const seen = new Set<PackKind>();
  let buildChecked = 0;
  for (const p of declared) {
    if (seen.has(p.kind)) {
      out.push(fail('packs.declared', `two declared packs share kind ${p.kind} (${p.label}) — a pack set names one version per kind`));
      continue;
    }
    seen.add(p.kind);
    const inputs = computed[p.kind];
    if (inputs === undefined) {
      out.push(fail('packs.declared',
        `${p.label}: this binary has no compiled-in inputs for kind ${p.kind} — `
        + 'a build pack it cannot recompute, or a data pack in the declared list; '
        + 'refusing is safer than passing what cannot be verified'));
      continue;
    }
    buildChecked++;
    const now = fingerprint(inputs.join('|'));
    const fpAgrees = now === (p.fingerprint >>> 0);
    // ORDER-SENSITIVE, element by element, because the fingerprint folds
    // `inputs.join('|')` — a reordered list is a different pack even when it
    // is the same SET of lines, and a set comparison would call that equal.
    const linesAgree = p.inputs.length === inputs.length
      && p.inputs.every((l, i) => l === inputs[i]);
    if (fpAgrees && linesAgree) {
      out.push(ok(`packs.declared.${p.key}`));
      continue;
    }
    const diff = linesAgree ? '' : inputLineDiff(p.inputs, inputs);
    if (!fpAgrees) {
      out.push(fail(
        `packs.declared.${p.key}`,
        `${p.label} declares ${hex(p.fingerprint)} but this build computes ${hex(now)}; `
        + `bump ${p.key.toUpperCase()}_PACK_VERSION and paste the new fingerprint and input lines in shared/src/packs.ts, in the same commit`
        // The lines already being right narrows the remedy to one field, so
        // say so: this is a mistyped hex paste, not a content change, and
        // telling the operator to re-paste the lines would send them looking
        // for a diff that does not exist.
        + (linesAgree
          ? ' | the declared input lines ARE this build\'s — only the declared fingerprint is wrong, so recompute it rather than editing the lines'
          : diff),
      ));
      continue;
    }
    // Fingerprint agrees, lines do not. The declaration is self-contradictory:
    // the hex says "this build" and the literals say something else, so the
    // literals cannot be what the hex was computed from. This is the shape a
    // doctored release document takes, and it is also what a half-finished
    // ratchet bump looks like (fingerprint pasted, lines forgotten). Either
    // way the artifact the ratchet exists to print is worthless until the
    // lines are the ones the fingerprint covers.
    out.push(fail(
      `packs.declared.${p.key}`,
      `${p.label}: the declared fingerprint ${hex(p.fingerprint)} agrees with this build but the declared INPUT LINES do not — `
      + 'the declaration is internally inconsistent, so the line diff a firing ratchet prints from it would be a LIE about what the previous build declared; '
      + `paste this build's input lines into ${p.key.toUpperCase()}_INPUTS in shared/src/packs.ts (the fingerprint is already correct)`
      + diff,
    ));
  }
  if (buildChecked !== 3) {
    out.push(fail('packs.declared', `expected the 3 build packs (core, weapons, characters) in the declared list, verified ${buildChecked}`));
  }
  return out;
}

/**
 * `packs.inputs` — every input line of every pack this release names is
 * inside `MAX_PACK_INPUTS` and `MAX_PACK_INPUT_BYTES`. Input that makes it
 * fail: a 161-byte declared input line, or a 513th line.
 *
 * WHY THIS IS A SHARED HELPER AND NOT TWO COPIES. The caps are declared in
 * shared/src/packs.ts and, until this landed, were enforced in exactly ONE
 * place: the loop inside `ReleaseService.runGate()`. `runReleaseVerify()` —
 * the gate `npm run release:verify` and CI run over the TREE — had no length
 * check at all, so a 161-byte line compiled into WEAPONS_INPUTS passed the
 * offline gate and was refused only later, by the online one, at the moment
 * an operator was trying to publish. That is §0's standing hazard in this
 * repo (two gates, and a check added to one is not added to the other) with
 * the arrow pointing the unhelpful way: the cheap gate says yes and the
 * expensive one says no. Duplicating the loop into gate.ts would have been
 * the next instance of the same defect, so both gates now call this, and the
 * failure ids and detail strings are BYTE-IDENTICAL to what the service gate
 * emitted before — anything downstream matching on `packs.inputs` keeps
 * matching.
 *
 * Unlike the old loop this returns a check when everything is in range. A
 * check that only ever appears in a report when it is failing can never be
 * seen to pass, and a gate that cannot pass is worth what one that cannot
 * fail is worth. Identical failure details are collapsed, because the
 * offline gate hands this both the declared list and the pack set it would
 * release — the same pack twice, and one pack deserves one line.
 */
export function checkPackInputs(packs: readonly PackVersion[]): GateCheck[] {
  const out: GateCheck[] = [];
  const said = new Set<string>();
  const refuse = (detail: string): void => {
    if (said.has(detail)) return;
    said.add(detail);
    out.push(fail('packs.inputs', detail));
  };
  for (const p of packs) {
    if (p.inputs.length > MAX_PACK_INPUTS) {
      refuse(`${p.label} has ${p.inputs.length} inputs, over the ${MAX_PACK_INPUTS} cap`);
    }
    // BYTES, not characters: the cap is a wire/storage budget and one emoji
    // in a pack name is four of them (shared/src/challenges.ts makes the same
    // point about MAX_CHALLENGE_INPUT_BYTES, which mirrors this constant).
    const oversize = p.inputs.find((l) => Buffer.byteLength(l, 'utf8') > MAX_PACK_INPUT_BYTES);
    if (oversize !== undefined) {
      refuse(`${p.label} input line over ${MAX_PACK_INPUT_BYTES} bytes: ${oversize.slice(0, 40)}…`);
    }
  }
  return out.length > 0 ? out : [ok('packs.inputs')];
}

/**
 * `packs.installed` — every level file on disk loads. Input that makes it
 * fail: a corrupt or truncated file, or bytes the decoder refuses.
 */
export function checkPacksInstalled(files: readonly GateLevelFile[], dir: string): GateCheck {
  const bad = files.filter((f) => f.level === null || f.error.length > 0);
  if (files.length === 0) return fail('packs.installed', `no levels found under ${dir}`);
  if (bad.length === 0) return ok('packs.installed');
  return fail('packs.installed', bad.map((f) => `${basename(f.file)}: ${f.error}`).join('; '));
}

/**
 * `packs.unique` — no two DIFFERENT files provide the same content id. A
 * .json and the .dcl it compiled to may share an id (the loader's
 * source-wins rule); two distinct sources may not. Input that makes it
 * fail: add e1m1-hangar's id to a second level file.
 */
export function checkPacksUnique(files: readonly GateLevelFile[]): GateCheck {
  const byId = new Map<string, Set<string>>();
  for (const f of files) {
    if (f.id.length === 0) continue;
    const stems = byId.get(f.id) ?? new Set<string>();
    stems.add(basename(f.file, extname(f.file)));
    byId.set(f.id, stems);
  }
  const dupes = [...byId.entries()].filter(([, stems]) => stems.size > 1);
  if (dupes.length === 0) return ok('packs.unique');
  return fail('packs.unique', dupes
    .map(([id, stems]) => `id "${id}" is provided by ${[...stems].join(' AND ')}`).join('; '));
}

/**
 * `levels.validate` — every level validates, and `W_REACH_SKIPPED` is FATAL
 * here even though the loader treats it as a warning. For a publish, "the
 * reachability solve did not run" is a refusal, not a note — that asymmetry
 * is what makes this a check that can fail rather than a restatement of one
 * that already passed. Input that makes it fail: a level with an unreachable
 * exit, or one whose volume exceeds MAX_REACH_CELLS.
 *
 * (Today no in-world level can exceed the solve cap — 13x13 chunks tops out
 * near 11M cells against the 24M cap — so the skip arrives only alongside an
 * out-of-world error. The check still refuses on the warning itself, so the
 * day either constant moves, the gate does not quietly start passing
 * unverified exits.)
 */
export function checkLevelsValidate(
  levels: readonly { id: string; validation: ReturnType<typeof validateLevel> }[],
): GateCheck {
  const bad: string[] = [];
  for (const l of levels) {
    if (!l.validation.ok) {
      bad.push(`${l.id}: ${l.validation.errors.map((e) => e.code).join(',')}`);
      continue;
    }
    if (l.validation.warnings.some((w) => w.code === 'W_REACH_SKIPPED')) {
      bad.push(`${l.id}: W_REACH_SKIPPED — the exit was never verified, which a publish may not ignore`);
    }
  }
  return bad.length === 0 ? ok('levels.validate') : fail('levels.validate', bad.join('; '));
}

/**
 * `levels.canonical` — the bytes we would serve are bytes our own encoder
 * produced. For a .dcl: re-encoding the parse must reproduce the stored file
 * exactly (input that makes it fail: hand-edit a .dcl). For a .json source:
 * the encoder's output must survive its own decode-encode round trip.
 */
export function checkLevelsCanonical(files: readonly GateLevelFile[]): GateCheck {
  const bad: string[] = [];
  for (const f of files) {
    if (f.level === null || f.bytes === null) continue;
    if (!f.fromSource && !bytesEqual(f.bytes, f.stored)) {
      bad.push(`${basename(f.file)}: stored .dcl is not the canonical encoding of its own parse`);
      continue;
    }
    try {
      const again = encodeLevel(decodeLevel(f.bytes.slice()));
      if (!bytesEqual(again, f.bytes)) bad.push(`${basename(f.file)}: encode∘decode is not stable`);
    } catch (e) {
      bad.push(`${basename(f.file)}: canonical bytes do not decode: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return bad.length === 0 ? ok('levels.canonical') : fail('levels.canonical', bad.join('; '));
}

export interface EpisodesManifest {
  readonly defaultEpisode: string;
  readonly episodes: readonly { readonly id: string; readonly levels: readonly string[] }[];
}

export function parseEpisodesManifest(text: string): EpisodesManifest | null {
  try {
    const root = JSON.parse(text) as Record<string, unknown>;
    const eps = Array.isArray(root.episodes) ? root.episodes : [];
    return {
      defaultEpisode: typeof root.defaultEpisode === 'string' ? root.defaultEpisode : '',
      episodes: eps.map((e: Record<string, unknown>) => ({
        id: typeof e.id === 'string' ? e.id : '',
        levels: Array.isArray(e.levels) ? e.levels.filter((l): l is string => typeof l === 'string') : [],
      })),
    };
  } catch {
    return null;
  }
}

/**
 * `items.validate` — the items manifest parses and every refusal the parser
 * can make is surfaced verbatim. Input that makes it fail: a tradable title,
 * a duplicate id, an off-range tint.
 */
export function checkItemsValidate(text: string | null): GateCheck {
  if (text === null) return { id: 'items.validate', ok: true, detail: 'no items manifest installed — nothing to check' };
  const parsed = parseItemsManifest(text);
  if (parsed.manifest !== null) return ok('items.validate');
  return fail('items.validate', parsed.errors.join('; '));
}

/**
 * `variants.validate` — the variants manifest parses, and every band, budget
 * and dominance refusal is surfaced verbatim. Optional-manifest shape, like
 * items and quests: no manifest installed is a PASS, because V2 ships the
 * binary that understands kind 7 and no content at all.
 *
 * NOTE that this is only HALF the gate. `ReleaseService.runGate` in
 * server/src/packs.ts is a separate implementation that runs over a DRAFT in
 * the admin console and does not see anything exported from here; its variants
 * block is the other half, and both are needed.
 *
 * Input that makes it fail: a variant outside a band, one that is better than
 * its base on every axis, a fractional pellet count, or an override of a field
 * that archetype's firing path never reads.
 */
export function checkVariantsValidate(text: string | null): GateCheck {
  if (text === null) return { id: 'variants.validate', ok: true, detail: 'no variants manifest installed — nothing to check' };
  const parsed = parseVariantsManifest(text);
  if (parsed.manifest !== null) return ok('variants.validate');
  return fail('variants.validate', parsed.errors.join('; '));
}

/**
 * `quests.validate` — the challenges manifest parses and every refusal the
 * parser can make is surfaced verbatim. Input that makes it fail: a def over
 * the scrap cap, a duplicate id, a period the id contradicts.
 */
export function checkQuestsValidate(text: string | null): GateCheck {
  if (text === null) return { id: 'quests.validate', ok: true, detail: 'no quests manifest installed — nothing to check' };
  const parsed = parseChallengesManifest(text);
  if (parsed.manifest !== null) return ok('quests.validate');
  return fail('quests.validate', parsed.errors.join('; '));
}

/**
 * `quests.refs` — every item a challenge pays exists in the items manifest
 * it ships beside. The settlement formats the full `items@<v>:<id>` ref at
 * grant time from the room's pinned items version, so a dangling local id
 * would mint dormant-from-birth rewards; a PUBLISH refuses it. Input that
 * makes it fail: rename an item and forget the quests manifest.
 */
export function checkQuestsRefs(
  manifest: ChallengesManifest | null, items: ItemsManifest | null,
): GateCheck {
  if (manifest === null) return ok('quests.refs');
  const itemIds = new Set((items?.items ?? []).map((i) => i.id));
  const bad: string[] = [];
  for (const c of manifest.challenges) {
    if (c.item !== null && !itemIds.has(c.item)) {
      bad.push(`${c.id} pays "${c.item}", which is not in the items manifest`);
    }
  }
  return bad.length === 0 ? ok('quests.refs') : fail('quests.refs', bad.join('; '));
}

/**
 * `campaign.refs` — the manifest names only levels that exist, and no two
 * episodes share an id. The RUNTIME skips a dangling id so a work-in-progress
 * entry never breaks the campaign; a PUBLISH refuses it, same asymmetry as
 * `levels.validate`. Input that makes it fail: rename a level and forget the
 * manifest.
 */
export function checkCampaignRefs(
  manifest: EpisodesManifest | null, installedIds: ReadonlySet<string>,
): GateCheck {
  if (manifest === null) return fail('campaign.refs', 'episodes.json is missing or not valid JSON');
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const e of manifest.episodes) {
    if (e.id.length === 0) bad.push('an episode has no id');
    else if (seen.has(e.id)) bad.push(`two episodes declare the id "${e.id}"`);
    seen.add(e.id);
    for (const id of e.levels) {
      // The manifest's consumer is the CLIENT, and it matches ids with raw
      // string comparison — a non-canonical entry that the gate helpfully
      // sanitised into a match would still dangle at runtime. Refuse it.
      if (id !== sanitiseContentId(id)) {
        bad.push(`${e.id} names "${id}", which is not a canonical id (want "${sanitiseContentId(id)}")`);
      } else if (!installedIds.has(id)) {
        bad.push(`${e.id} names "${id}", which is not installed`);
      }
    }
  }
  if (manifest.defaultEpisode.length > 0 && !seen.has(manifest.defaultEpisode)) {
    bad.push(`defaultEpisode "${manifest.defaultEpisode}" is not an episode`);
  }
  return bad.length === 0 ? ok('campaign.refs') : fail('campaign.refs', bad.join('; '));
}

/**
 * `protocol.stable` — a content release may not move the wire. Input that
 * makes it fail: move a quantisation scale in a "content" change.
 */
export function checkProtocolStable(declared: number = BUILTIN_PROTOCOL_FINGERPRINT): GateCheck {
  const now = protocolFingerprint();
  return now === (declared >>> 0)
    ? ok('protocol.stable')
    : fail('protocol.stable',
      `protocolFingerprint() is ${hex(now)}, release was authored against ${hex(declared)} — `
      + 'this is a PROTOCOL change wearing a content release\'s clothes');
}

/**
 * `flags.order` — the live FLAG_ORDER must START with the declared baseline,
 * unchanged. Appending is legal; inserting or reordering re-means every bit
 * an old client has compiled in. Input that makes it fail: insert a flag
 * rather than append one.
 */
export function checkFlagsOrder(
  live: readonly string[] = FLAG_ORDER, declared: readonly string[] = BUILTIN_FLAG_ORDER,
): GateCheck {
  if (live.length < declared.length) {
    return fail('flags.order', `FLAG_ORDER lost entries: ${declared.length} declared, ${live.length} live — a retired flag's bit is burned, never removed`);
  }
  for (let i = 0; i < declared.length; i++) {
    if (live[i] !== declared[i]) {
      return fail('flags.order', `bit ${i} is "${live[i]}", release was authored against "${declared[i]}" — append flags, never insert`);
    }
  }
  return ok('flags.order');
}

/**
 * `saves.schema` — PERSIST_VERSION or SAVES_VERSION moved. Not a veto on the
 * change; a veto on the change arriving UNDECLARED, because it disables
 * rollback forever and that must be chosen. Input that makes it fail: any
 * profile-shape change without bumping the DECLARED_* pair in gate.ts.
 */
export function checkSavesSchema(): { check: GateCheck; schemaTouching: boolean } {
  const moved = PERSIST_VERSION !== DECLARED_PERSIST_VERSION || SAVES_VERSION !== DECLARED_SAVES_VERSION;
  if (!moved) return { check: ok('saves.schema'), schemaTouching: false };
  return {
    schemaTouching: true,
    check: fail('saves.schema',
      `schema moved (persist ${DECLARED_PERSIST_VERSION}→${PERSIST_VERSION}, saves ${DECLARED_SAVES_VERSION}→${SAVES_VERSION}); `
      + 'a schema-touching release can NEVER be rolled back — bump DECLARED_* in server/src/gate.ts deliberately, in the same commit'),
  };
}

/* ------------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------------ */

export interface VerifyOptions {
  levelsDir?: string;
  episodesFile?: string;
  itemsFile?: string;
  questsFile?: string;
  variantsFile?: string;
  declaredPacks?: readonly PackVersion[];
  declaredProtocol?: number;
  declaredFlagOrder?: readonly string[];
  clock?: () => number;
}

export interface VerifyResult {
  report: GateReport;
  /** The pack set this working tree would release, data packs included. */
  packs: PackVersion[];
}

export function runReleaseVerify(options: VerifyOptions = {}): VerifyResult {
  const t0 = (options.clock ?? Date.now)();
  const dir = resolve(options.levelsDir ?? DEFAULT_LEVEL_DIR);
  const episodesFile = options.episodesFile ?? DEFAULT_EPISODES_FILE;
  const declared = options.declaredPacks ?? BUILTIN_PACKS;

  const files = scanLevelDir(dir);
  const loaded = files.filter((f): f is GateLevelFile & { level: Level; bytes: Uint8Array } =>
    f.level !== null && f.bytes !== null && f.id.length > 0);

  // The loader's source-wins rule: a .json shadows the .dcl with its stem.
  const winners = new Map<string, GateLevelFile & { level: Level; bytes: Uint8Array }>();
  for (const f of loaded) {
    const prev = winners.get(f.id);
    if (prev !== undefined && prev.fromSource && !f.fromSource) continue;
    winners.set(f.id, f);
  }
  const served = [...winners.values()];
  const installedIds = new Set(served.map((f) => f.id));

  const manifestText = existsSync(episodesFile) ? readFileSync(episodesFile, 'utf8') : '';
  const manifest = manifestText.length > 0 ? parseEpisodesManifest(manifestText) : null;
  const itemsFile = options.itemsFile ?? DEFAULT_ITEMS_FILE;
  const itemsText = existsSync(itemsFile) ? readFileSync(itemsFile, 'utf8') : null;
  const parsedItems = itemsText === null ? null : parseItemsManifest(itemsText).manifest;
  /*
   * V4a: read by DEFAULT, like items and quests and unlike every earlier
   * revision of this line.
   *
   * `tools/release-verify.mjs` — the CLI face, and what CI runs on every push
   * — passes no options at all, so while this defaulted to `''` the entire
   * variants half of the offline gate was reachable only from a test that
   * chose to reach it. `variants.validate` printed "no variants manifest
   * installed — nothing to check" against a tree that had one, and the pack
   * never entered the released set, so `packs.inputs` never measured its
   * lines. Both are the same defect: a check that only a test can run is not
   * a gate.
   */
  const variantsFile = options.variantsFile ?? DEFAULT_VARIANTS_FILE;
  const variantsText = variantsFile !== '' && existsSync(variantsFile)
    ? readFileSync(variantsFile, 'utf8') : null;
  const parsedVariants = variantsText === null ? null : parseVariantsManifest(variantsText).manifest;
  const questsFile = options.questsFile ?? DEFAULT_QUESTS_FILE;
  const questsText = existsSync(questsFile) ? readFileSync(questsFile, 'utf8') : null;
  const parsedQuests = questsText === null ? null : parseChallengesManifest(questsText).manifest;

  // The pack set this tree would release: the build packs AS THIS BINARY
  // COMPUTES THEM (declared version, computed fingerprint + inputs — so the
  // diff against the declaration shows real lines when they drift) plus the
  // data packs this tree installs.
  //
  // Assembled BEFORE the check list, not after, because `packs.inputs` has to
  // see it: the caps bind on the lines that would actually ship, and a data
  // pack's lines are computed from content/ rather than declared anywhere.
  const computedInputs: Partial<Record<PackKind, readonly string[]>> = {
    [PackKind.CORE]: coreFingerprintInputs(),
    [PackKind.WEAPONS]: weaponsFingerprintInputs(),
    [PackKind.CHARACTERS]: charactersFingerprintInputs(),
  };
  const computedBuild: PackVersion[] = declared
    .filter((p) => computedInputs[p.kind] !== undefined)
    .map((p) => {
      const inputs = computedInputs[p.kind] as readonly string[];
      return {
        ...p,
        fingerprint: fingerprint(inputs.join('|')),
        inputs: Object.freeze([...inputs]),
      };
    });
  const lv = levelsPack(served.map((f) => ({ id: f.id, hash: fnvOf(f.bytes) })));
  const lvWithDigest: PackVersion = { ...lv, digest: levelsDigest(served) };
  const packs: PackVersion[] = [...computedBuild, lvWithDigest];
  if (manifest !== null) {
    const cp = campaignPack(manifest);
    packs.push({ ...cp, digest: sha256(Buffer.from(canonicalManifest(manifest), 'utf8')) });
  }
  if (parsedItems !== null) {
    const inputs = itemsFingerprintInputs(parsedItems);
    const ip = itemsPack(inputs);
    packs.push({ ...ip, digest: sha256(Buffer.from(inputs.join('\n'), 'utf8')) });
  }
  if (parsedQuests !== null) {
    const inputs = challengesFingerprintInputs(parsedQuests);
    const qp = questsPack(inputs);
    packs.push({ ...qp, digest: sha256(Buffer.from(inputs.join('\n'), 'utf8')) });
  }
  /*
   * Kind 7 joins the released set, and it has to happen HERE — above the
   * check list — for the reason the block comment above `computedInputs`
   * gives: `checkPackInputs` binds on the lines that would actually ship, and
   * a data pack's lines are computed from content/ rather than declared
   * anywhere. Pushed after the checks and every variant line would be exempt
   * from the 160-byte cap in this gate while `ReleaseService.runGate` still
   * enforced it — the cheap gate saying yes and the expensive one saying no,
   * which is the exact asymmetry `checkPackInputs` was extracted to close.
   *
   * `parseVariantsManifest` refuses a line over `MAX_VARIANT_INPUT_BYTES`
   * itself, so a manifest that reaches here is already under the cap and this
   * looks redundant. It is not: that constant is declared in
   * shared/src/variants.ts and mirrors `MAX_PACK_INPUT_BYTES` by assertion,
   * the pack LABEL is not part of what the parser measures, and a check that
   * is correct only while two constants happen to agree is a check that stops
   * being correct silently.
   */
  if (parsedVariants !== null) {
    const inputs = variantsFingerprintInputs(parsedVariants);
    const vp = variantsPack(inputs);
    packs.push({ ...vp, digest: sha256(Buffer.from(inputs.join('\n'), 'utf8')) });
  }

  const checks: GateCheck[] = [
    ...checkPacksDeclared(declared),
    // BOTH lists. The DECLARED literals in shared/src/packs.ts are where an
    // over-long line is actually pasted, and the RELEASED set is what the
    // service gate later measures — checking only one of the two would leave
    // whichever half was skipped enforced nowhere until publish time.
    // Identical failures collapse inside the helper, so a green tree, where
    // the two lists agree by construction, still prints one row.
    ...checkPackInputs([...declared, ...packs]),
    checkPacksInstalled(files, dir),
    checkPacksUnique(files),
    checkLevelsValidate(served.map((f) => ({ id: f.id, validation: validateLevel(f.level, f.level.meta.defaultSkill) }))),
    checkLevelsCanonical(files),
    checkCampaignRefs(manifest, installedIds),
    checkItemsValidate(itemsText),
    checkVariantsValidate(variantsText),
    checkQuestsValidate(questsText),
    checkQuestsRefs(parsedQuests, parsedItems),
    checkProtocolStable(options.declaredProtocol),
    checkFlagsOrder(FLAG_ORDER, options.declaredFlagOrder),
  ];
  const saves = checkSavesSchema();
  checks.push(saves.check);
  checks.push(checks.length === 0
    ? fail('gate.nonempty', 'the gate ran no checks — an empty list is a failure, never a pass')
    : ok('gate.nonempty'));

  const diff = diffAgainstDeclared(packs, declared);
  const failures = checks.filter((c) => !c.ok);
  const report: GateReport = {
    ok: failures.length === 0,
    ranMs: (options.clock ?? Date.now)() - t0,
    checks: [...failures, ...checks.filter((c) => c.ok)],
    diff,
    schemaTouching: saves.schemaTouching,
  };
  return { report, packs };
}

/* ------------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------------ */

function hex(v: number): string { return `0x${(v >>> 0).toString(16).padStart(8, '0')}`; }

/**
 * The reviewable half of a `packs.declared` refusal: what the declaration
 * says, minus what this build computes, as ` | - old | + new` lines.
 *
 * Only ever called when the two lists actually differ. The set difference is
 * the useful rendering in the overwhelming case (a field changed), but it
 * can come back EMPTY on a real difference — the same lines in a different
 * order, or one line repeated a different number of times, both of which
 * move the fingerprint because it folds the join. The old code appended
 * nothing in that case and printed two hex numbers, which is precisely what
 * the input lists exist to avoid, so the fallbacks below name the first
 * position that disagrees instead.
 */
function inputLineDiff(declared: readonly string[], computed: readonly string[]): string {
  const removed = declared.filter((l) => !computed.includes(l));
  const added = computed.filter((l) => !declared.includes(l));
  if (removed.length + added.length > 0) {
    return ` | ${[...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].slice(0, 6).join(' | ')}`;
  }
  const n = Math.min(declared.length, computed.length);
  for (let i = 0; i < n; i++) {
    if (declared[i] !== computed[i]) {
      return ` | the same lines in a different ORDER, which the fingerprint folds: position ${i} declares "${declared[i]}", this build computes "${computed[i]}"`;
    }
  }
  return ` | the declared list is ${declared.length} line(s), this build computes ${computed.length}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/** FNV-1a over bytes — hashLevelBytes' arithmetic, kept local to avoid a wide import. */
function fnvOf(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** sha256 over one line per level, `id:sha256(bytes)`, sorted by id. */
export function levelsDigest(served: readonly { id: string; bytes: Uint8Array }[]): string {
  const lines = [...served]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => `${f.id}:${sha256(f.bytes)}`);
  return sha256(Buffer.from(lines.join('\n'), 'utf8'));
}

export function campaignDigest(m: EpisodesManifest): string {
  return sha256(Buffer.from(canonicalManifest(m), 'utf8'));
}

function canonicalManifest(m: EpisodesManifest): string {
  return JSON.stringify({
    defaultEpisode: m.defaultEpisode,
    episodes: m.episodes.map((e) => ({ id: e.id, levels: [...e.levels] })),
  });
}

function diffAgainstDeclared(packs: readonly PackVersion[], declared: readonly PackVersion[]): PackDiff[] {
  const out: PackDiff[] = [];
  for (const p of packs) {
    const base = declared.find((d) => d.kind === p.kind);
    const from = base === undefined ? '' : base.label;
    const removed = base === undefined ? [] : base.inputs.filter((l) => !p.inputs.includes(l));
    const added = p.inputs.filter((l) => base === undefined || !base.inputs.includes(l));
    const changes = [
      ...removed.map((l) => `- ${l}`),
      ...added.map((l) => `+ ${l}`),
    ].slice(0, 40);
    // A build pack whose declaration matches computes no changes; data packs
    // are always "new" against the compiled-in release, which is honest: the
    // binary does not carry them.
    if (base !== undefined && changes.length === 0 && from === p.label) continue;
    out.push({ key: p.key, from, to: p.label, changes });
  }
  return out;
}
