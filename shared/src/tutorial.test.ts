/**
 * DOOMCRAFT — the Basic Training episode's content contract.
 *
 * Tutorial levels are pure content (Rule A), which means every failure mode is
 * SILENT: a missing file is skipped (quest.ts:270), broken JSON is dropped
 * (main.ts discoverLevels), a typo'd field becomes a default, and the episode
 * truth is split three ways (picker groups by level meta; run order comes from
 * episodes.json; the server groups from meta again). This file makes each of
 * those failures loud, and it holds the tutorial to a STRICTER standard than
 * the campaign: a reachability solve that was skipped, or a lesson checkpoint
 * the player cannot walk into, is not a warning here — a tutorial whose
 * coaching text cannot fire teaches nobody.
 *
 * Proven able to fail: walling off tut-01's south corridor turns this red
 * with E_EXIT_UNREACHABLE + W_SECRET_UNREACHABLE (the lesson behind the wall).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { compileLevel, parseLevelJson, validateLevel, type Level } from './level.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(HERE, '..', '..', 'content');

interface EpisodeEntry { id: string; name: string; index: number; levels: string[] }

const episodes = JSON.parse(readFileSync(path.join(CONTENT, 'episodes.json'), 'utf8')) as {
  episodes: EpisodeEntry[];
};
const tut = episodes.episodes.find((e) => e.id === 'tut');

function loadLevel(id: string): Level {
  const text = readFileSync(path.join(CONTENT, 'levels', `${id}.json`), 'utf8');
  const src = parseLevelJson(text);
  if (src === null) throw new Error(`${id}.json is not a parseable level`);
  return compileLevel(src);
}

describe('the Basic Training episode entry', () => {
  it('exists, sorts FIRST, and is the drill order the levels themselves claim', () => {
    expect(tut).toBeDefined();
    expect(tut!.index).toBe(0); // episodeIndex 0 = first in the picker AND the fresh-save default
    expect(tut!.levels.length).toBeGreaterThanOrEqual(3);
  });

  it('every listed id has a bundled file, and every tut-* file is listed', () => {
    const listed = new Set(tut!.levels);
    for (const id of listed) {
      // readFileSync throws loudly if the file the manifest names is missing.
      expect(() => readFileSync(path.join(CONTENT, 'levels', `${id}.json`), 'utf8')).not.toThrow();
    }
    const onDisk = readdirSync(path.join(CONTENT, 'levels'))
      .filter((n) => n.startsWith('tut-') && n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''));
    for (const id of onDisk) {
      expect(listed.has(id), `${id}.json is on disk but not in the tut episode — it would play by deep link and hide from the menu`).toBe(true);
    }
  });

  it('each level\'s own meta agrees with its manifest placement — the truth is split three ways', () => {
    tut!.levels.forEach((id, i) => {
      const level = loadLevel(id);
      expect(level.meta.episodeId, `${id} episodeId`).toBe('tut');
      expect(level.meta.episodeIndex, `${id} episodeIndex`).toBe(0);
      expect(level.meta.levelIndex, `${id} levelIndex vs manifest order`).toBe(i + 1);
    });
  });

  it('the drills chain: each exit names the next level, and the last ends the episode', () => {
    tut!.levels.forEach((id, i) => {
      const level = loadLevel(id);
      expect(level.exit, `${id} has no exit`).not.toBeNull();
      const last = i === tut!.levels.length - 1;
      if (last) expect(level.exit!.nextLevelId).toBe('');
      else expect(level.exit!.nextLevelId).toBe(tut!.levels[i + 1]);
    });
  });
});

describe('every drill passes validation at TUTORIAL standard', () => {
  // Stricter than the gate: reach-skip and any unreachable lesson are FATAL.
  const FATAL_WARNINGS = new Set(['W_REACH_SKIPPED', 'W_SECRET_UNREACHABLE']);

  it('compiles, solves, and every lesson checkpoint is walkable', () => {
    for (const id of tut!.levels) {
      const level = loadLevel(id);
      const v = validateLevel(level, level.meta.defaultSkill);
      expect(v.ok, `${id}: ${v.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`).toBe(true);
      const fatal = v.warnings.filter((w) => FATAL_WARNINGS.has(w.code));
      expect(fatal, `${id}: ${fatal.map((w) => `${w.code} ${w.message}`).join('; ')}`).toEqual([]);
    }
  });

  it('every authored text surface actually says something', () => {
    for (const id of tut!.levels) {
      const level = loadLevel(id);
      expect(level.meta.description.trim().length, `${id} description is the first feed line`).toBeGreaterThan(20);
      for (const s of level.secrets) {
        expect(s.message.trim().length, `${id}/${s.id}: a lesson with no text teaches nothing`).toBeGreaterThan(0);
      }
      for (const sw of level.switches) {
        expect(sw.message.trim().length, `${id}/${sw.id}: a silent switch reads as a bug`).toBeGreaterThan(0);
      }
      for (const d of level.doors.filter((dr) => dr.key !== 0)) {
        expect(d.lockedMessage.trim().length, `${id}/${d.id}: a locked door must say what it wants`).toBeGreaterThan(0);
      }
    }
  });

  it('the first drill risks nothing: no enemies before the player can aim', () => {
    const first = loadLevel(tut!.levels[0]);
    expect(first.enemies.length).toBe(0);
  });
});
