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
