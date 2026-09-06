/**
 * DOOMCRAFT — the release gate can refuse (docs/PACKS.md §4, Rule C).
 *
 * "A gate that cannot refuse is worse than no gate, because it manufactures
 * confidence." So the shape of every test here is the shape of §4's table:
 * for each check, feed it the exact input the doc says makes it fail, and
 * watch it fail. The green run over the real content/ tree comes last — a
 * pass only means something once every refusal has been demonstrated.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { compileLevel, parseLevelJson, validateLevel, type Level } from '@doomcraft/shared/level';
import {
  BUILTIN_FLAG_ORDER,
  BUILTIN_PACKS,
  MAX_PACK_INPUTS,
  PackKind,
  type PackVersion,
} from '@doomcraft/shared/packs';
import { weaponsFingerprintInputs } from '@doomcraft/shared/version';
import { parseChallengesManifest, type ChallengesManifest } from '@doomcraft/shared/challenges';
import { parseItemsManifest } from '@doomcraft/shared/items';

import {
  DECLARED_PERSIST_VERSION,
  DECLARED_SAVES_VERSION,
  checkCampaignRefs,
  checkFlagsOrder,
  checkLevelsCanonical,
  checkLevelsValidate,
  checkPackInputs,
  checkPacksDeclared,
  checkProtocolStable,
  checkQuestsRefs,
  checkQuestsValidate,
  checkSavesSchema,
  parseEpisodesManifest,
  checkVariantsValidate,
  runReleaseVerify,
  scanLevelDir,
} from './gate.js';
import { PERSIST_VERSION } from './persistence.js';
import { SAVES_VERSION } from '@doomcraft/shared/saves';

const here = fileURLToPath(import.meta.url);
const CONTENT_LEVELS = join(here, '..', '..', '..', 'content', 'levels');
const EPISODES = join(here, '..', '..', '..', 'content', 'episodes.json');

/*
 * The two things a legitimate ratchet bump moves, named ONCE.
 *
 * A weapons schema rewrite changes every input line and the pack's version;
 * nothing in this file may spell either out, or the bump lands on a wall of
 * red tests that are about the gate rather than about weapons. Everything
 * below derives its expectations from the running binary and the checked-in
 * declaration, so a bump updates them by moving the two names it already has
 * to move in shared/src/.
 */
const WEAPONS_COMPUTED = weaponsFingerprintInputs();
const WEAPONS_DECL = BUILTIN_PACKS.find((p) => p.key === 'weapons') as PackVersion;

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

/** A copy of the shipped campaign with an optional per-file text mutation. */
function fixtureDir(mutations: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-gate-'));
  tempDirs.push(dir);
  cpSync(CONTENT_LEVELS, dir, { recursive: true });
  for (const [name, mutate] of Object.entries(mutations)) {
    const file = join(dir, name);
    writeFileSync(file, mutate(readFileSync(file, 'utf8')), 'utf8');
  }
  return dir;
}

function realLevel(): Level {
  const src = parseLevelJson(readFileSync(join(CONTENT_LEVELS, 'e1m1-hangar.json'), 'utf8'));
  if (src === null) throw new Error('fixture level does not parse');
  return compileLevel(src);
}

/* ------------------------------------------------------------------------ *
 * Each check, refused by the input its own doc names
 * ------------------------------------------------------------------------ */

describe('packs.declared', () => {
  it('refuses a declared fingerprint one bit off from what this build computes', () => {
    const doctored = BUILTIN_PACKS.map((p) =>
      (p.key === 'weapons' ? { ...p, fingerprint: (p.fingerprint ^ 1) >>> 0 } : p));
    const checks = checkPacksDeclared(doctored);
    const weapons = checks.find((c) => c.id === 'packs.declared.weapons');
    expect(weapons?.ok).toBe(false);
    // Named from the declaration, not typed in: a legitimate ratchet bump
    // moves WEAPONS_PACK_VERSION and must not have to move this file too.
    expect(weapons?.detail).toContain(WEAPONS_DECL.label);
    // And the other two are untouched — per-pack refusal, not a blanket one.
    expect(checks.find((c) => c.id === 'packs.declared.core')?.ok).toBe(true);
    expect(checks.find((c) => c.id === 'packs.declared.characters')?.ok).toBe(true);
  });

  it('passes when the declarations match this build', () => {
    for (const c of checkPacksDeclared()) expect(c.ok, c.id).toBe(true);
  });
});

describe('packs.installed and packs.unique, over a real directory scan', () => {
  it('refuses a file the decoder cannot load', () => {
    const dir = fixtureDir({ 'e1m2-coolant.json': (t) => t.slice(0, 40) });
    const { report } = runReleaseVerify({ levelsDir: dir, episodesFile: EPISODES });
    const c = report.checks.find((x) => x.id === 'packs.installed');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('e1m2-coolant.json');
    expect(report.ok).toBe(false);
  });

  it('refuses two different files providing the same content id', () => {
    const dir = fixtureDir();
    // The doc's own input: add e1m1-hangar's id to a second file.
    cpSync(join(dir, 'e1m1-hangar.json'), join(dir, 'zz-duplicate.json'));
    const { report } = runReleaseVerify({ levelsDir: dir, episodesFile: EPISODES });
    const c = report.checks.find((x) => x.id === 'packs.unique');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('e1m1-hangar');
    expect(report.ok).toBe(false);
  });
});

describe('levels.validate', () => {
  it('refuses a level whose exit was moved outside the volume', () => {
    const dir = fixtureDir({
      'e1m1-hangar.json': (t) => {
        const src = JSON.parse(t) as { exit: { x: number } };
        src.exit.x = 10_000;
        return JSON.stringify(src);
      },
    });
    const { report } = runReleaseVerify({ levelsDir: dir, episodesFile: EPISODES });
    const c = report.checks.find((x) => x.id === 'levels.validate');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('e1m1-hangar');
  });

  it('treats W_REACH_SKIPPED as fatal even when the loader would serve the level', () => {
    // The REAL validator, the REAL warning, and validation.ok === true — the
    // exact state the loader ships and the gate must refuse. The volume is
    // the real e1m1 volume behind a proxy that reports a size past
    // MAX_REACH_CELLS, which is precisely "too large for the solve": the
    // solve reads sizeX/sizeZ, gives up before touching a cell, and every
    // other check sees the true, in-world, valid geometry.
    const level = realLevel();
    const bigVolume = new Proxy(level.volume, {
      get(target, prop, receiver) {
        if (prop === 'sizeX' || prop === 'sizeZ') return 100_000;
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const spoofed = { ...level, volume: bigVolume } as Level;
    const validation = validateLevel(spoofed, spoofed.meta.defaultSkill);
    expect(validation.ok).toBe(true); // the loader WOULD serve this
    expect(validation.warnings.some((w) => w.code === 'W_REACH_SKIPPED')).toBe(true);

    const check = checkLevelsValidate([{ id: 'e1m1-hangar', validation }]);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('W_REACH_SKIPPED');

    // And the untampered level passes the same check, so the refusal above
    // is the warning's doing and nothing else's.
    const clean = checkLevelsValidate([
      { id: 'e1m1-hangar', validation: validateLevel(level, level.meta.defaultSkill) },
    ]);
    expect(clean.ok).toBe(true);
  });
});

describe('levels.canonical', () => {
  it('refuses a stored .dcl that is not the canonical encoding of its own parse', () => {
    const files = scanLevelDir(CONTENT_LEVELS);
    const real = files.find((f) => f.id === 'e1m1-hangar');
    expect(real?.bytes).not.toBeNull();
    const bytes = real!.bytes!;
    // A hand-edited .dcl: same parse, one trailing byte the encoder never wrote.
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    const doctored = { ...real!, fromSource: false, stored: padded };
    const check = checkLevelsCanonical([doctored]);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('canonical');
  });

  it('passes the shipped campaign', () => {
    expect(checkLevelsCanonical(scanLevelDir(CONTENT_LEVELS)).ok).toBe(true);
  });
});

describe('campaign.refs', () => {
  const installed = new Set(['e1m1-hangar', 'e1m2-coolant']);

  it('refuses a manifest naming a level that is not installed', () => {
    const c = checkCampaignRefs({
      defaultEpisode: 'e1',
      episodes: [{ id: 'e1', levels: ['e1m1-hangar', 'e9m9-ghost'] }],
    }, installed);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('e9m9-ghost');
  });

  it('refuses two episodes declaring the same id, and a dangling default', () => {
    expect(checkCampaignRefs({
      defaultEpisode: 'e1',
      episodes: [{ id: 'e1', levels: [] }, { id: 'e1', levels: [] }],
    }, installed).ok).toBe(false);
    expect(checkCampaignRefs({
      defaultEpisode: 'e7',
      episodes: [{ id: 'e1', levels: [] }],
    }, installed).ok).toBe(false);
  });

  it('refuses a missing or unparsable manifest, and passes the real one', () => {
    expect(checkCampaignRefs(null, installed).ok).toBe(false);
    expect(parseEpisodesManifest('not json')).toBeNull();
    const real = parseEpisodesManifest(readFileSync(EPISODES, 'utf8'));
    const ids = new Set(scanLevelDir(CONTENT_LEVELS).map((f) => f.id));
    expect(checkCampaignRefs(real, ids).ok).toBe(true);
  });
});

describe('protocol.stable and flags.order', () => {
  it('refuses a protocol fingerprint the release was not authored against', () => {
    const c = checkProtocolStable(0x12345678);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('PROTOCOL change');
  });

  it('refuses an INSERTED flag, a reorder, and a removal — and allows an append', () => {
    const declared = BUILTIN_FLAG_ORDER;
    const inserted = [declared[0], 'brand_new_flag', ...declared.slice(1)];
    expect(checkFlagsOrder(inserted, declared).ok).toBe(false);
    const reordered = [...declared.slice(1), declared[0]];
    expect(checkFlagsOrder(reordered, declared).ok).toBe(false);
    expect(checkFlagsOrder(declared.slice(0, -1), declared).ok).toBe(false);
    expect(checkFlagsOrder([...declared, 'appended_flag'], declared).ok).toBe(true);
    expect(checkFlagsOrder(undefined, declared).ok).toBe(true);
  });
});

describe('saves.schema', () => {
  it('is green exactly because the declared pair tracks the live pair', () => {
    // The refusal path cannot be exercised without editing a live constant —
    // which is the point: when PERSIST_VERSION or SAVES_VERSION moves, this
    // test AND release:verify go red until DECLARED_* moves with them,
    // deliberately, in the same commit.
    expect(DECLARED_PERSIST_VERSION).toBe(PERSIST_VERSION);
    expect(DECLARED_SAVES_VERSION).toBe(SAVES_VERSION);
    const { check, schemaTouching } = checkSavesSchema();
    expect(check.ok).toBe(true);
    expect(schemaTouching).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The quests checks — refusals first, per the file header
 * ------------------------------------------------------------------------ */

describe('quests.validate and quests.refs can refuse', () => {
  const questDef = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'daily.kill-5', period: 'daily', stat: 'kills', target: 5, scrap: 10,
    name: 'Five', blurb: 'Take down five.', ...over,
  });

  it('quests.validate surfaces the parser refusal verbatim — the scrap cap is a money bound', () => {
    const c = checkQuestsValidate(JSON.stringify({ challenges: [questDef({ scrap: 9999 })] }));
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('MAX_CHALLENGE_SCRAP');
    expect(checkQuestsValidate(null).ok).toBe(true); // no manifest — nothing to check
    expect(checkQuestsValidate(JSON.stringify({ challenges: [questDef()] })).ok).toBe(true);
  });

  it('quests.refs refuses an item id the paired items manifest does not carry', () => {
    const quests = parseChallengesManifest(JSON.stringify({
      challenges: [questDef({ item: 'skin-ghost' })],
    })).manifest;
    const items = parseItemsManifest(JSON.stringify({
      items: [{ id: 'skin-a', kind: 'skin', name: 'A', rarity: 'common' }],
    })).manifest;
    const bad = checkQuestsRefs(quests, items);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('skin-ghost');
    // No items manifest at all: an item-paying def dangles just the same.
    expect(checkQuestsRefs(quests, null).ok).toBe(false);
    // And the honest pass: the id exists.
    const good = parseChallengesManifest(JSON.stringify({
      challenges: [questDef({ item: 'skin-a' })],
    })).manifest;
    expect(checkQuestsRefs(good, items).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * The full run
 * ------------------------------------------------------------------------ */

describe('runReleaseVerify over the shipped tree', () => {
  it('passes, with every check present and failures-first ordering intact', () => {
    const { report, packs } = runReleaseVerify();
    expect(report.ok).toBe(true);
    expect(report.schemaTouching).toBe(false);
    const ids = report.checks.map((c) => c.id);
    for (const required of [
      'packs.declared.core', 'packs.declared.weapons', 'packs.declared.characters',
      'packs.inputs',
      'packs.installed', 'packs.unique', 'levels.validate', 'levels.canonical',
      'campaign.refs', 'quests.validate', 'quests.refs', 'variants.validate',
      'protocol.stable', 'flags.order', 'saves.schema', 'gate.nonempty',
    ]) expect(ids).toContain(required);
    // The pack set is the three build packs plus the FIVE data packs, digests on.
    expect(packs.map((p) => p.key).sort())
      .toEqual(['campaign', 'characters', 'core', 'items', 'levels', 'quests', 'variants', 'weapons']);
    expect(packs.find((p) => p.key === 'levels')?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(packs.find((p) => p.key === 'campaign')?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(packs.find((p) => p.key === 'quests')?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  /*
   * V4a — THE DEFAULT, AND WHY ITS ABSENCE WAS INVISIBLE.
   *
   * `variants.validate` has been in the required-id list above since V2 and
   * has been passing all along — on the string "no variants manifest
   * installed — nothing to check", because `runReleaseVerify` defaulted
   * `variantsFile` to '' and `tools/release-verify.mjs` (the CLI, and what CI
   * runs on every push) passes no options at all. Presence in a report is not
   * evidence that anything was read. The two assertions the old test could
   * not make are the two below: the check must not be the null-manifest
   * PASS, and the pack must be in the released set so `checkPackInputs` binds
   * on its lines.
   *
   * Revert either half of the fix and exactly one of them goes red, which is
   * what makes them two assertions instead of one.
   */
  it('reads content/variants.json BY DEFAULT and puts kind 7 in the released set', () => {
    const { report, packs } = runReleaseVerify();
    const check = report.checks.find((c) => c.id === 'variants.validate');
    expect(check?.ok).toBe(true);
    expect(check?.detail, 'variants.validate passed on NO manifest — the default never took')
      .not.toContain('no variants manifest installed');

    const vp = packs.find((p) => p.key === 'variants');
    expect(vp, 'the released set carries no variants pack').toBeDefined();
    expect(vp?.label).toBe('variants@1');
    expect(vp?.digest).toMatch(/^[0-9a-f]{64}$/);
    // Non-empty, said out loud: an empty manifest parses clean and would give
    // a pack with zero input lines that still satisfies every check above.
    expect(vp!.inputs.length, 'the variants pack shipped with no rows').toBeGreaterThan(0);
    expect(vp!.inputs.length).toBe(2);
    // The lines are what an operator reviews, so name them.
    expect(vp!.inputs.some((l) => l.startsWith('shotgun-slug:1/'))).toBe(true);
    expect(vp!.inputs.some((l) => l.startsWith('rocket-swift:3/'))).toBe(true);

    // And `packs.inputs` measured it: the pack is in the list that check is
    // handed, which is the whole reason it is pushed above the check list.
    expect(report.checks.find((c) => c.id === 'packs.inputs')?.ok).toBe(true);
  });

  it('one changed byte in one level file moves the levels pack fingerprint', () => {
    // The same property /api/version's one-byte test proves end-to-end, held
    // at the pack layer: a host with a DIFFERENT file, not a corrupt one, is
    // the one that silently splits a fleet.
    const a = runReleaseVerify({ levelsDir: fixtureDir(), episodesFile: EPISODES });
    const b = runReleaseVerify({
      levelsDir: fixtureDir({ 'e1m1-hangar.json': (t) => t.replace('"name": "Hangar"', '"name": "Hangbr"') }),
      episodesFile: EPISODES,
    });
    expect(b.report.ok).toBe(true);
    const la = a.packs.find((p) => p.key === 'levels')!;
    const lb = b.packs.find((p) => p.key === 'levels')!;
    expect(la.fingerprint).not.toBe(lb.fingerprint);
    expect(la.digest).not.toBe(lb.digest);
    // And the build packs did not move: the split is doing its job.
    expect(a.packs.find((p) => p.key === 'weapons')!.fingerprint)
      .toBe(b.packs.find((p) => p.key === 'weapons')!.fingerprint);
  });
});

/* ------------------------------------------------------------------------ *
 * Audit regressions — each of these was a live finding, kept red-provable
 * ------------------------------------------------------------------------ */

describe('the gate hashes the SAME bytes the loader serves', () => {
  it('sanitises meta.id before encoding, exactly as the loader does', async () => {
    // The audit proved a mixed-case meta.id split the two identities:
    // gate 0x362f68ce vs loader 0x5f5ffaae for the same file. The reviewed
    // release identity MUST be the served one.
    const dir = fixtureDir({
      'e1m1-hangar.json': (t) => t.replace('"id": "e1m1-hangar"', '"id": "E1M1-Hangar"'),
    });
    const scanned = scanLevelDir(dir).find((f) => basename(f.file) === 'e1m1-hangar.json');
    expect(scanned?.id).toBe('e1m1-hangar');

    const { LevelLibrary } = await import('./levels.js');
    const lib = new LevelLibrary({ dir, log: () => {} });
    lib.load();
    const served = lib.get('e1m1-hangar');
    expect(served).not.toBeNull();
    // Same id, same bytes, same hash — the whole point.
    expect(fnvBytes(scanned!.bytes!)).toBe(served!.contentHash);
  });

  it('refuses a file over the cap the loader enforces, instead of certifying it', () => {
    const dir = fixtureDir();
    // 25 MB of JSON the loader will refuse by size before even parsing.
    writeFileSync(join(dir, 'zz-bomb.json'), '{"pad":"' + 'x'.repeat(25 * 1024 * 1024) + '"}');
    const { report } = runReleaseVerify({ levelsDir: dir, episodesFile: EPISODES });
    const c = report.checks.find((x) => x.id === 'packs.installed');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('zz-bomb.json');
    expect(c?.detail).toContain('cap');
  });
});

describe('packs.declared refuses what it cannot verify', () => {
  it('refuses a declared pack of a kind this binary has no inputs for', () => {
    // A SYNTHETIC kind: every real PackKind has a producer now (QUESTS was
    // the fixture here until S4 graduated it), so the premise 'a kind this
    // binary cannot verify' needs a number the enum never minted.
    const bogus: PackVersion = {
      kind: 99 as PackKind, key: 'mystery', version: 1, fingerprint: 0xdead,
      inputs: [], digest: '', label: 'mystery@1',
    };
    const checks = checkPacksDeclared([...BUILTIN_PACKS, bogus]);
    const bad = checks.filter((c) => !c.ok);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0].detail).toContain('cannot be verified');
  });

  it('refuses duplicate kinds and an incomplete build-pack set', () => {
    const dupe = checkPacksDeclared([...BUILTIN_PACKS, BUILTIN_PACKS[0]]);
    expect(dupe.some((c) => !c.ok && c.detail.includes('share kind'))).toBe(true);
    const partial = checkPacksDeclared(BUILTIN_PACKS.slice(0, 2));
    expect(partial.some((c) => !c.ok && c.detail.includes('expected the 3 build packs'))).toBe(true);
  });

  it('prints a real line diff when a declaration drifts, not two hex numbers', () => {
    // The mutation is a SUFFIX rather than a field edit spelled out here, so
    // the weapons input schema can be rewritten wholesale without this test
    // needing to know a single thing about its shape. The property under test
    // is "the changed line is rendered on both sides", not "17 becomes 18".
    const declaredFirst = `${WEAPONS_COMPUTED[0]}#drift`;
    const doctored = BUILTIN_PACKS.map((p) => (p.key === 'weapons'
      ? {
        ...p,
        fingerprint: (p.fingerprint ^ 1) >>> 0,
        inputs: p.inputs.map((l, i) => (i === 0 ? `${l}#drift` : l)),
      }
      : p));
    const bad = checkPacksDeclared(doctored).find((c) => c.id === 'packs.declared.weapons');
    expect(bad?.ok).toBe(false);
    // The declared line shows as removed, the computed one as added.
    expect(bad?.detail).toContain(`- ${declaredFirst}`);
    expect(bad?.detail).toContain(`+ ${WEAPONS_COMPUTED[0]}`);
  });
});

/* ------------------------------------------------------------------------ *
 * The declaration's OTHER half, and the caps — in the OFFLINE gate
 * ------------------------------------------------------------------------ */

describe('packs.declared checks the declared INPUT LINES, not only the number', () => {
  it('REFUSES a declaration whose fingerprint is right and whose input lines lie', () => {
    /*
     * The review's exact input, and the reason this check exists at all.
     * `p.inputs` was read for ONE purpose — rendering the failure diff — and
     * compared against nothing, so a weapons declaration carrying this
     * build's fingerprint over the single line `0:lies` returned ok from both
     * gates. shared/src/packs.ts keeps those literals precisely so a firing
     * ratchet prints a field-level diff instead of two hex numbers, and calls
     * the diff "the reviewable artifact". An unverified literal makes that
     * artifact a claim about the previous build that nothing ever tested.
     */
    const declaredPacks = BUILTIN_PACKS.map((p) => (p.key === 'weapons'
      ? { ...p, inputs: ['0:lies'] } : p));
    const { report } = runReleaseVerify({ levelsDir: CONTENT_LEVELS, episodesFile: EPISODES, declaredPacks });
    const weapons = report.checks.find((c) => c.id === 'packs.declared.weapons');
    expect(weapons?.ok, JSON.stringify(report.checks)).toBe(false);
    // Which of the two halves is wrong, because the remedies differ: this one
    // is "paste the lines", not "recompute the hash".
    expect(weapons?.detail).toContain('INPUT LINES');
    expect(weapons?.detail).toContain('- 0:lies');
    expect(weapons?.detail).toContain(`+ ${WEAPONS_COMPUTED[0]}`);
    expect(report.ok).toBe(false);
    // Per-pack, as the fingerprint half already was.
    expect(report.checks.find((c) => c.id === 'packs.declared.core')?.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'packs.declared.characters')?.ok).toBe(true);
  });

  it('REFUSES this build\'s own lines declared in the WRONG ORDER', () => {
    // The set difference is empty here, so the naive diff would have printed
    // nothing at all — and the fingerprint folds `inputs.join('|')`, which
    // makes a reorder a genuinely different pack. A comparison by set would
    // call these two lists equal and pass.
    expect(WEAPONS_COMPUTED.length, 'a one-line pack cannot be reordered').toBeGreaterThan(1);
    const swapped = [WEAPONS_COMPUTED[1], WEAPONS_COMPUTED[0], ...WEAPONS_COMPUTED.slice(2)];
    const declaredPacks = BUILTIN_PACKS.map((p) => (p.key === 'weapons' ? { ...p, inputs: swapped } : p));
    const { report } = runReleaseVerify({ levelsDir: CONTENT_LEVELS, episodesFile: EPISODES, declaredPacks });
    const weapons = report.checks.find((c) => c.id === 'packs.declared.weapons');
    expect(weapons?.ok).toBe(false);
    expect(weapons?.detail).toContain('different ORDER');
    expect(weapons?.detail).toContain('position 0');
  });

  it('tells the operator when only the FINGERPRINT is wrong, so they do not hunt for a diff', () => {
    // The other quadrant, and the other remedy. Lines correct, hex mistyped.
    const declaredPacks = BUILTIN_PACKS.map((p) => (p.key === 'weapons'
      ? { ...p, fingerprint: (p.fingerprint ^ 1) >>> 0 } : p));
    const weapons = checkPacksDeclared(declaredPacks).find((c) => c.id === 'packs.declared.weapons');
    expect(weapons?.ok).toBe(false);
    expect(weapons?.detail).toContain('only the declared fingerprint is wrong');
    expect(weapons?.detail).not.toContain('INPUT LINES');
  });

  it('still PASSES the declaration this build actually ships', () => {
    // The other half of the bar: a check that cannot pass is worth what one
    // that cannot fail is worth. This is the line a legitimate ratchet bump
    // must leave green.
    for (const c of checkPacksDeclared()) expect(c.ok, `${c.id}: ${c.detail}`).toBe(true);
  });
});

describe('packs.inputs — the caps, in the gate that runs over the TREE', () => {
  /**
   * A 161-byte input line used to pass `runReleaseVerify()` outright: the
   * ONLY enforcement of MAX_PACK_INPUT_BYTES anywhere was an inline loop in
   * `ReleaseService.runGate()`. So `npm run release:verify` and CI said yes,
   * and the refusal arrived later from the other gate, at the moment someone
   * tried to publish. Both gates call the same helper now.
   *
   * 161 and 160 rather than 400 and 10: a cap is only enforced if it is
   * enforced AT the cap.
   */
  const over = `${'x'.repeat(155)}:1/2/3`;
  const under = over.slice(1);

  const verifyWith = (inputs: readonly string[]): ReturnType<typeof runReleaseVerify> => runReleaseVerify({
    levelsDir: CONTENT_LEVELS,
    episodesFile: EPISODES,
    declaredPacks: BUILTIN_PACKS.map((p) => (p.key === 'weapons' ? { ...p, inputs } : p)),
  });

  it('REFUSES a 161-byte declared line and accepts the 160-byte one', () => {
    expect(Buffer.byteLength(over, 'utf8')).toBe(161);
    expect(Buffer.byteLength(under, 'utf8')).toBe(160);

    const bad = verifyWith([...WEAPONS_COMPUTED, over]).report;
    const cap = bad.checks.find((c) => c.id === 'packs.inputs');
    expect(cap?.ok, JSON.stringify(bad.checks.map((c) => c.id))).toBe(false);
    expect(cap?.detail).toContain('input line over 160 bytes');
    expect(bad.ok).toBe(false);

    // One byte shorter and the CAP is satisfied. (The declaration still
    // drifts — an extra line is an extra line — so this asserts the cap
    // check alone, which is the one under test.)
    const fine = verifyWith([...WEAPONS_COMPUTED, under]).report;
    expect(fine.checks.find((c) => c.id === 'packs.inputs')?.ok).toBe(true);
  });

  it('counts bytes, not characters, so a multi-byte line cannot slip past', () => {
    // 160 characters, 320 bytes. A `.length` check would pass this.
    const wide = 'é'.repeat(160);
    expect(wide.length).toBe(160);
    expect(Buffer.byteLength(wide, 'utf8')).toBe(320);
    const cap = verifyWith([...WEAPONS_COMPUTED, wide]).report.checks.find((c) => c.id === 'packs.inputs');
    expect(cap?.ok).toBe(false);
  });

  it('REFUSES a pack over the input COUNT cap, and says one thing per pack', () => {
    const many = Array.from({ length: MAX_PACK_INPUTS + 1 }, (_, i) => `${i}:x`);
    const pack: PackVersion = {
      kind: PackKind.LEVELS, key: 'levels', version: 1, fingerprint: 0,
      inputs: many, digest: '', label: 'levels@1',
    };
    // The same pack handed in twice — which is what the offline gate does,
    // once from the declaration and once from the set it would release.
    const checks = checkPackInputs([pack, pack]);
    expect(checks.length).toBe(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].id).toBe('packs.inputs');
    expect(checks[0].detail).toContain(`over the ${MAX_PACK_INPUTS} cap`);
  });

  it('reports GREEN over the shipped tree, so the check is seen to pass', () => {
    const { report } = runReleaseVerify();
    const cap = report.checks.find((c) => c.id === 'packs.inputs');
    expect(cap, JSON.stringify(report.checks.map((c) => c.id))).toBeDefined();
    expect(cap?.ok).toBe(true);
  });
});

describe('campaign.refs refuses a non-canonical manifest id', () => {
  it('does not helpfully sanitise an id the client will match raw', () => {
    const c = checkCampaignRefs({
      defaultEpisode: 'e1',
      episodes: [{ id: 'e1', levels: ['E1M1-Hangar'] }],
    }, new Set(['e1m1-hangar']));
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('not a canonical id');
  });
});

/** FNV-1a over bytes, mirroring hashLevelBytes, local to the tests. */
function fnvBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------------ *
 * variants.validate — the TREE side of the gate
 *
 * The other side is `ReleaseService.runGate` in server/src/packs.ts, which is
 * a separate implementation over a DRAFT and does not see anything exported
 * from gate.ts. Both are needed and both are tested; see
 * server/src/releases.test.ts for the draft side.
 * ------------------------------------------------------------------------ */

describe('variants.validate', () => {
  it('passes when no variants manifest is installed', () => {
    // V2 ships the BINARY that understands kind 7 and no content, which is
    // also the deploy order the pack requires.
    const c = checkVariantsValidate(null);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('nothing to check');
  });

  it('passes a real manifest', () => {
    const c = checkVariantsValidate(JSON.stringify({
      variants: [{ id: 'pistol-burst', base: 0, name: 'Burst Pistol', over: { rpm: 620, damage: 12 } }],
    }));
    expect(c.ok, c.detail).toBe(true);
  });

  it('IS WIRED INTO runReleaseVerify, not merely exported', () => {
    /*
     * Rule 2, one level up. The three cases above call `checkVariantsValidate`
     * directly, so deleting its line from `runReleaseVerify`'s check list left
     * every one of them green — the CHECK was proven and its WIRING was not.
     * These two go through the real entry point.
     */
    const dir = mkdtempSync(join(tmpdir(), 'dc-variants-'));
    const good = join(dir, 'ok.json');
    writeFileSync(good, JSON.stringify({
      variants: [{ id: 'pistol-burst', base: 0, name: 'Burst Pistol', over: { rpm: 620, damage: 12 } }],
    }), 'utf8');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({
      variants: [{ id: 'cheat', base: 0, name: 'Cheat', over: { damage: 40 } }],
    }), 'utf8');

    const okRun = runReleaseVerify({ variantsFile: good });
    expect(okRun.report.checks.find((c) => c.id === 'variants.validate')?.ok).toBe(true);

    const badRun = runReleaseVerify({ variantsFile: bad });
    const check = badRun.report.checks.find((c) => c.id === 'variants.validate');
    expect(check, 'variants.validate never reached the report').toBeDefined();
    expect(check?.ok).toBe(false);
    expect(badRun.report.ok, 'a refused variant must fail the whole gate').toBe(false);
  });

  it('surfaces the parser\'s refusal verbatim', () => {
    const straightUpgrade = checkVariantsValidate(JSON.stringify({
      variants: [{ id: 'cheat', base: 0, name: 'Cheat', over: { damage: 40 } }],
    }));
    expect(straightUpgrade.ok).toBe(false);
    expect(straightUpgrade.detail).toMatch(/power budget|every axis/);

    const hazard = checkVariantsValidate(JSON.stringify({
      variants: [{ id: 'crater', base: 3, name: 'Crater', over: { terrainDamage: 1e20 } }],
    }));
    expect(hazard.ok).toBe(false);
    expect(hazard.detail).toContain('terrainDamage');
  });
});

/* ------------------------------------------------------------------------ *
 * V4b — the fourth supply path, which nothing else could see
 * ------------------------------------------------------------------------ */

describe('quests.refs refuses a challenge that would MINT a weapon variant', () => {
  /*
   * Clause 20, repaired. Supply was argued to be zero from `CRAFTABLE_KINDS`,
   * `rollMatchDrops` and trading — and `ChallengeDef.item` walked straight
   * past all three. It is an items-manifest LOCAL id that `settleChallenges`
   * turns into `items@<v>:<id>` with `source: 'challenge'`, and this check
   * only ever asked whether the id EXISTS, never what KIND it is.
   *
   * REPRODUCED on the unfixed code, end to end: the quests manifest below
   * parsed with zero errors, `quests.refs` returned `ok: true`, and the
   * settlement would have granted `items@1:weapon_variant-shotgun-slug`.
   */
  const questDef = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'daily.kill-5', period: 'daily', stat: 'kills', target: 5, scrap: 10,
    name: 'Five', blurb: 'Take down five.', ...over,
  });

  const ITEMS = parseItemsManifest(JSON.stringify({
    items: [
      { id: 'skin-a', kind: 'skin', name: 'A', rarity: 'common', tradable: true },
      {
        id: 'weapon_variant-shotgun-slug', kind: 'weapon_variant', name: 'Slug Shotgun',
        rarity: 'uncommon', tradable: true, variantId: 'shotgun-slug',
      },
    ],
  })).manifest;

  const paying = (item: string): ChallengesManifest =>
    parseChallengesManifest(JSON.stringify({ challenges: [questDef({ item })] })).manifest!;

  it('fails, and the check that fails is quests.refs and not another one', () => {
    // The parser has no opinion — the id is a canonical slug and the def pays
    // something, so nothing upstream of the reference gate objects.
    const parsed = parseChallengesManifest(JSON.stringify({
      challenges: [questDef({ item: 'weapon_variant-shotgun-slug' })],
    }));
    expect(parsed.errors).toEqual([]);
    expect(checkQuestsValidate(JSON.stringify({
      challenges: [questDef({ item: 'weapon_variant-shotgun-slug' })],
    })).ok, 'quests.validate must stay GREEN — this is a reference rule, not a schema rule').toBe(true);

    const c = checkQuestsRefs(paying('weapon_variant-shotgun-slug'), ITEMS);
    expect(c.id).toBe('quests.refs');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('craft-only');
    expect(c.detail).toContain('weapon_variant-shotgun-slug');
    // It is NOT the dangling-id message: the id is right there in the manifest.
    expect(c.detail).not.toContain('not in the items manifest');
  });

  it('still passes every kind a challenge is allowed to pay', () => {
    for (const item of ['skin-a']) {
      expect(checkQuestsRefs(paying(item), ITEMS).ok, item).toBe(true);
    }
    // And the dangling-id refusal is untouched.
    const ghost = checkQuestsRefs(paying('skin-ghost'), ITEMS);
    expect(ghost.ok).toBe(false);
    expect(ghost.detail).toContain('not in the items manifest');
  });
});
