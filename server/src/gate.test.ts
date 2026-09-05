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
import { BUILTIN_FLAG_ORDER, BUILTIN_PACKS, PackKind, type PackVersion } from '@doomcraft/shared/packs';
import { parseChallengesManifest } from '@doomcraft/shared/challenges';
import { parseItemsManifest } from '@doomcraft/shared/items';

import {
  DECLARED_PERSIST_VERSION,
  DECLARED_SAVES_VERSION,
  checkCampaignRefs,
  checkFlagsOrder,
  checkLevelsCanonical,
  checkLevelsValidate,
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
    expect(weapons?.detail).toContain('weapons@1');
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
      'packs.installed', 'packs.unique', 'levels.validate', 'levels.canonical',
      'campaign.refs', 'quests.validate', 'quests.refs', 'variants.validate',
      'protocol.stable', 'flags.order', 'saves.schema', 'gate.nonempty',
    ]) expect(ids).toContain(required);
    // The pack set is the three build packs plus the four data packs, digests on.
    expect(packs.map((p) => p.key).sort())
      .toEqual(['campaign', 'characters', 'core', 'items', 'levels', 'quests', 'weapons']);
    expect(packs.find((p) => p.key === 'levels')?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(packs.find((p) => p.key === 'campaign')?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(packs.find((p) => p.key === 'quests')?.digest).toMatch(/^[0-9a-f]{64}$/);
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
    const doctored = BUILTIN_PACKS.map((p) => (p.key === 'weapons'
      ? {
        ...p,
        fingerprint: (p.fingerprint ^ 1) >>> 0,
        inputs: p.inputs.map((l, i) => (i === 0 ? l.replace(':17/', ':18/') : l)),
      }
      : p));
    const bad = checkPacksDeclared(doctored).find((c) => c.id === 'packs.declared.weapons');
    expect(bad?.ok).toBe(false);
    // The declared line (18) shows as removed, the computed line (17) as added.
    expect(bad?.detail).toContain('- 0:18/');
    expect(bad?.detail).toContain('+ 0:17/');
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
