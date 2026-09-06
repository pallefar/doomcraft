/**
 * DOOMCRAFT — the Creator Studio refuses what the gate would refuse
 * (docs/STUDIO.md §2: an editor that lets you save what the machine will
 * refuse is an editor that wastes your evening).
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { ItemKind } from '@doomcraft/shared/items';
import { parseChallengesManifest } from '@doomcraft/shared/challenges';

import { checkQuestsRefs } from './gate.js';
import { PackInventory } from './packs.js';
import { StudioService } from './studio.js';

const here = fileURLToPath(import.meta.url);
const repoRoot = join(here, '..', '..', '..');

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function studioWith(packsRoot: string | null): { studio: StudioService; inv: PackInventory } {
  const inv = new PackInventory({ packsRoot, log: () => {} });
  const studio = new StudioService(inv, { packsRoot, dataRoot: tempDir('dc-studio-data-'), clock: () => 1_000 });
  return { studio, inv };
}

function seededRoot(): string {
  const root = tempDir('dc-studio-packs-');
  cpSync(join(repoRoot, 'content', 'levels'), join(root, 'levels', '1'), { recursive: true });
  mkdirSync(join(root, 'campaign', '1'), { recursive: true });
  cpSync(join(repoRoot, 'content', 'episodes.json'), join(root, 'campaign', '1', 'episodes.json'));
  mkdirSync(join(root, 'items', '1'), { recursive: true });
  cpSync(join(repoRoot, 'content', 'items.json'), join(root, 'items', '1', 'items.json'));
  return root;
}

describe('the studio without a writable packs root', () => {
  it('refuses every save with the reason, and says so in status', () => {
    const { studio } = studioWith(null);
    expect(studio.status().writable).toBe(false);
    expect(studio.status().reason).toContain('DOOMCRAFT_PACKS');
    const r = studio.saveItems('{"items":[]}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('DOOMCRAFT_PACKS');
  });
});

describe('the items editor', () => {
  it('mints the next version and names what the save REMOVES', () => {
    const root = seededRoot();
    const { studio, inv } = studioWith(root);
    const manifest = JSON.parse(readFileSync(join(root, 'items', '1', 'items.json'), 'utf8')) as {
      items: { id: string }[];
    };
    manifest.items = manifest.items.filter((i) => i.id !== 'skin-rust-marine');
    const r = studio.saveItems(JSON.stringify(manifest));
    expect(r.ok).toBe(true);
    expect(r.ok && r.label).toBe('items@2');
    expect(r.ok && r.detail).toContain('REMOVES 1');
    expect(r.ok && r.detail).toContain('skin-rust-marine');
    expect(inv.itemsVersions()).toEqual([1, 2]);
    // Immutability: saving again mints 3, never rewrites 2.
    const again = studio.saveItems(JSON.stringify(manifest));
    expect(again.ok && again.label).toBe('items@3');
  });

  it('refuses a manifest the gate would refuse, verbatim', () => {
    const { studio } = studioWith(seededRoot());
    const r = studio.saveItems(JSON.stringify({
      items: [{ id: 'title-x', kind: 'title', name: 'X', rarity: 'epic', tradable: true, text: 'X' }],
    }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('items.validate');
    expect(!r.ok && r.error).toContain('launder');
  });
});

describe('the level lab', () => {
  const goodLevel = (): string => readFileSync(join(repoRoot, 'content', 'levels', 'e1m1-hangar.json'), 'utf8');

  it('validates with the REAL validator and refuses an unreachable exit at save', () => {
    const { studio } = studioWith(seededRoot());
    const broken = ((): string => {
      const src = JSON.parse(goodLevel()) as { exit: { x: number }; meta: { id: string } };
      src.exit.x = 10_000;
      src.meta.id = 'e9m9-broken';
      return JSON.stringify(src);
    })();
    const dry = studio.validateLevelSource(broken);
    expect(dry.ok).toBe(false);
    expect(dry.report.length).toBeGreaterThan(0);
    const r = studio.saveLevel(broken);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('levels.validate');
  });

  it('saves an edited level as a NEW version carrying the whole set', () => {
    const root = seededRoot();
    const { studio, inv } = studioWith(root);
    const edited = goodLevel().replace('"name": "Hangar"', '"name": "Hangar MkII"');
    const r = studio.saveLevel(edited);
    expect(r.ok).toBe(true);
    expect(r.ok && r.label).toBe('levels@2');
    // The new version is the SET: all six levels, with e1m1 replaced.
    const dir = join(root, 'levels', '2');
    expect(existsSync(join(dir, 'e1m6-throne.json'))).toBe(true);
    expect(readFileSync(join(dir, 'e1m1-hangar.json'), 'utf8')).toContain('Hangar MkII');
    const v2 = inv.levelsPackAt(2)!;
    expect(v2.fingerprint).not.toBe(inv.levelsPackAt(1)!.fingerprint);
  });
});

describe('the campaign assembler and the designers', () => {
  it('refuses a manifest naming a ghost level, saves a valid one as the next version', () => {
    const root = seededRoot();
    const { studio } = studioWith(root);
    const manifest = JSON.parse(readFileSync(join(root, 'campaign', '1', 'episodes.json'), 'utf8')) as {
      episodes: { levels: string[] }[];
    };
    const ghost = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    ghost.episodes[0].levels.push('e9m9-ghost');
    const bad = studio.saveCampaign(JSON.stringify(ghost));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('e9m9-ghost');
    const good = studio.saveCampaign(JSON.stringify(manifest));
    expect(good.ok && good.label).toBe('campaign@2');
  });

  it('a weapons draft lands under studio/ with the compiled diff, and NO pack version', () => {
    const root = seededRoot();
    const { studio, inv } = studioWith(root);
    const r = studio.saveDraft('weapons', { pistol: { damage: 18 } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.detail).toContain('platform');
    expect(r.diff?.length).toBeGreaterThan(0);
    expect(studio.status().drafts.length).toBe(1);
    // The one thing that must NOT have happened: an installed weapons pack.
    expect(existsSync(join(root, 'weapons'))).toBe(false);
    expect(inv.installedPacks().some((p) => p.key === 'weapons' && p.digest !== '')).toBe(false);
  });
});

describe('the challenge board editor (S4)', () => {
  const board = (defs: Record<string, unknown>[]): string => JSON.stringify({ challenges: defs });
  const def = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'daily.kill-5', period: 'daily', stat: 'kills', target: 5, scrap: 10,
    name: 'Five', blurb: 'Take down five.', ...over,
  });

  it('refuses without a writable packs root, with the reason', () => {
    const { studio } = studioWith(null);
    const r = studio.saveQuests(board([def()]));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('DOOMCRAFT_PACKS');
  });

  it('refuses what the parser refuses, verbatim — the money caps included', () => {
    const { studio } = studioWith(seededRoot());
    const over = studio.saveQuests(board([def({ scrap: 9999 })]));
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toContain('MAX_CHALLENGE_SCRAP');
    // And the dry run says the same thing without writing anything.
    const dry = studio.validateQuestsSource(board([def({ scrap: 9999 })]));
    expect(dry.ok).toBe(false);
    expect(dry.detail).toContain('MAX_CHALLENGE_SCRAP');
  });

  it('refuses an item reward the items manifest does not carry', () => {
    const { studio } = studioWith(seededRoot());
    const r = studio.saveQuests(board([def({ item: 'skin-ghost' })]));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('quests.refs');
    expect(!r.ok && r.error).toContain('skin-ghost');
  });

  it('accepts an item id that lives only in an OLDER items version — the gate checks the pairing the DRAFT names', () => {
    const root = seededRoot();
    const { studio } = studioWith(root);
    // items@2 drops title-knee-deep (the dormant direction, gate-legal).
    const manifest = JSON.parse(readFileSync(join(root, 'items', '1', 'items.json'), 'utf8')) as {
      items: { id: string }[];
    };
    manifest.items = manifest.items.filter((i) => i.id !== 'title-knee-deep');
    expect(studio.saveItems(JSON.stringify(manifest)).ok).toBe(true);
    // A quests version paying it is still authorable: a draft pinning
    // items@1 is a pairing runGate would pass.
    const r = studio.saveQuests(board([def({ item: 'title-knee-deep' })]));
    expect(r.ok).toBe(true);
    // An id in NO installed version is still refused, naming what it looked in.
    const ghost = studio.saveQuests(board([def({ item: 'skin-ghost' })]));
    expect(ghost.ok).toBe(false);
    expect(!ghost.ok && ghost.error).toContain('no installed items version');
  });

  it('recovers from a torn save: an EMPTY version directory is not an immutable version', () => {
    const root = seededRoot();
    const { studio } = studioWith(root);
    // The crash shape: mkdir succeeded, the manifest never landed.
    mkdirSync(join(root, 'quests', '2'), { recursive: true });
    const r = studio.saveQuests(board([def()]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.label).toBe('quests@2');
    // A version that really exists is still immutable.
    expect(() => studio.saveQuests(board([def()]))).not.toThrow();
  });

  it('mints the next quests version; immutability mints again, never rewrites', () => {
    const { studio, inv } = studioWith(seededRoot());
    const r = studio.saveQuests(board([def({ item: 'title-knee-deep' })]));
    expect(r.ok).toBe(true);
    // The seeded root has no quests dir, so the content/ fallback is v1 and
    // the first save mints 2.
    expect(r.ok && r.label).toBe('quests@2');
    expect(r.ok && r.detail).toContain('1 challenge(s)');
    expect(inv.questsVersions()).toEqual([1, 2]);
    const again = studio.saveQuests(board([def()]));
    expect(again.ok && again.label).toBe('quests@3');
  });
});

describe('V4b: the studio and the gate agree about what a challenge may pay', () => {
  const board = (defs: Record<string, unknown>[]): string => JSON.stringify({ challenges: defs });
  const def = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'daily.kill-5', period: 'daily', stat: 'kills', target: 5, scrap: 10,
    name: 'Five', blurb: 'Take down five.', ...over,
  });

  it('refuses a challenge paying a weapon_variant, in the CHECK button and at save', () => {
    /*
     * `validateQuestsSource` is a SECOND DOOR onto quests.refs: it does its own
     * id lookup across every installed items version rather than calling
     * `checkQuestsRefs`, so a rule added only to the release gate would let the
     * studio bless a quests pack the gate then refuses forever — the editor
     * that lies, HANDOVER §0 rule 29. Both doors call `challengeGrantRefusal`.
     */
    const { studio } = studioWith(seededRoot());
    const dry = studio.validateQuestsSource(board([def({ item: 'weapon_variant-shotgun-slug' })]));
    expect(dry.ok).toBe(false);
    expect(dry.detail).toContain('quests.refs');
    expect(dry.detail).toContain('craft-only');
    // Not the dangling-id message: the id IS in the installed items manifest.
    expect(dry.detail).not.toContain('no installed items version');

    const saved = studio.saveQuests(board([def({ item: 'weapon_variant-shotgun-slug' })]));
    expect(saved.ok).toBe(false);
    expect(!saved.ok && saved.error).toContain('craft-only');
  });

  it('accepts EXACTLY the set the release gate accepts, id by id', () => {
    /*
     * The rule-29 assertion proper: not "each door refuses bad input" but
     * "the set each door ACCEPTS is identical". Swept over every id in the
     * bundled items manifest, so the day a kind is added the sweep covers it.
     */
    const root = seededRoot();
    const { studio, inv } = studioWith(root);
    const items = inv.itemsAt(1)!.manifest;
    expect(items.items.some((i) => i.kind === ItemKind.WEAPON_VARIANT)).toBe(true);

    const ids = [...items.items.map((i) => i.id), 'skin-ghost'];
    for (const id of ids) {
      const src = board([def({ item: id })]);
      const studioOk = studio.validateQuestsSource(src).ok;
      const gateOk = checkQuestsRefs(parseChallengesManifest(src).manifest, items).ok;
      expect(studioOk, `studio and gate disagree about "${id}"`).toBe(gateOk);
    }
    // …and the sweep is not vacuous: it contains at least one of each verdict.
    const verdicts = ids.map((id) => studio.validateQuestsSource(board([def({ item: id })])).ok);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it('accepts exactly the same set for ACHIEVEMENTS, id by id', () => {
    /*
     * The same rule-29 sweep on the other payer. `validateQuestsSource` has
     * THREE loops over the manifest — the dangling-id lookup, the forbidden-
     * kind check, and the Scrap summary — and each one had to learn about
     * achievements separately. A door that walked only two of them would
     * disagree with the gate on a subset of ids, which is precisely what a
     * per-id sweep sees and a single hand-picked case does not.
     */
    const root = seededRoot();
    const { studio, inv } = studioWith(root);
    const items = inv.itemsAt(1)!.manifest;

    const withAchievement = (item: string): string => JSON.stringify({
      challenges: [{
        id: 'daily.kill-5', period: 'daily', stat: 'kills', target: 5, scrap: 10,
        name: 'Five', blurb: 'Take down five.',
      }],
      achievements: [{
        id: 'achievement.a1', stat: 'kills', target: 1000, scrap: 100,
        item, name: 'A', blurb: 'b',
      }],
    });

    const ids = [...items.items.map((i) => i.id), 'skin-ghost'];
    for (const id of ids) {
      const src = withAchievement(id);
      const studioOk = studio.validateQuestsSource(src).ok;
      const gateOk = checkQuestsRefs(parseChallengesManifest(src).manifest, items).ok;
      expect(studioOk, `studio and gate disagree about achievement item "${id}"`).toBe(gateOk);
    }
    const verdicts = ids.map((id) => studio.validateQuestsSource(withAchievement(id)).ok);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it('tells the operator what the achievements cost, and that it is once per player', () => {
    /* The summary is what an operator reads before pressing SAVE, and the two
     * halves are not the same kind of money: a challenge board pays its total
     * EVERY period, an achievement set pays its total once per player, ever.
     * A summary that counted only challenges would understate a publish by
     * however much the achievements are worth. */
    const { studio } = studioWith(seededRoot());
    const src = JSON.stringify({
      challenges: [{
        id: 'daily.kill-5', period: 'daily', stat: 'kills', target: 5, scrap: 10,
        name: 'Five', blurb: 'Take down five.',
      }],
      achievements: [
        { id: 'achievement.a1', stat: 'kills', target: 1000, scrap: 250, name: 'A', blurb: 'b' },
        { id: 'achievement.a2', stat: 'bestStreak', target: 15, scrap: 150, name: 'B', blurb: 'b' },
      ],
    });
    const dry = studio.validateQuestsSource(src);
    expect(dry.ok, dry.detail).toBe(true);
    expect(dry.detail).toContain('1 challenge(s), paying 10 Scrap a full board');
    expect(dry.detail).toContain('2 achievement(s), paying 400 Scrap once per player, ever');
  });
});
