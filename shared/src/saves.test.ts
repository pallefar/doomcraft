/**
 * DOOMCRAFT — a save survives meeting a build from the future, and a build
 * from the past.
 *
 * Two separate promises, and the second one is the one everybody forgets:
 *
 *   1. **Forward.** A player who last opened the game three releases ago must
 *      get every one of those releases applied in order, with nothing dropped
 *      on the way. Each individual step has a test somewhere; a MULTI-version
 *      jump is a different claim, because it is the only path where one
 *      migration's output becomes another's input, and it is the path a real
 *      returning player is actually on.
 *   2. **Backward.** `migrateSave` clamps every document to `SAVES_VERSION`,
 *      so a v5 save read by a rolled-back v4 client is rewritten as v4 — and
 *      the v5 fields are gone from the player's own machine, permanently.
 *      A rollback that destroys player data is worse than the bug it rolled
 *      back from, and a rollback is exactly the moment nobody is watching for
 *      it. `SaveFile._unknown` is the guard; these tests are what keep it.
 *
 * See `docs/PATCHING.md` and `docs/INFRASTRUCTURE.md` §6.
 */

import { describe, expect, it } from 'vitest';

import { ModeId } from './modes.ts';
import { WeaponId } from './weapons.ts';
import {
  KNOWN_SAVE_KEYS,
  LEGACY_AVATAR_BY_SKIN,
  MemorySaveStorage,
  SAVES_VERSION,
  SAVE_MIGRATIONS,
  SAVE_STORAGE_KEY,
  createSaveFile,
  loadSave,
  migrateSave,
  serialiseSave,
  storeSave,
} from './saves.ts';

/* ------------------------------------------------------------------------ *
 * Fixtures — documents as the shipping build of the day actually wrote them
 * ------------------------------------------------------------------------ */

/** The v1 flat `SaveProgress`: one set of counters that only meant deathmatch. */
function v1Document(): Record<string, unknown> {
  return {
    version: 1,
    name: 'Ranger', skin: 4, xp: 4820, level: 9, secondsPlayed: 7200,
    gamesPlayed: 41, wins: 12, kills: 388, deaths: 201, bestKillstreak: 14,
    favouriteWeapon: WeaponId.SHOTGUN,
    blocksPlaced: 1204, blocksBroken: 3310, lastSeed: 0x51ee7,
    adsRemoved: true,
  };
}

/**
 * A v2 document: per-mode saves exist, `profile.avatar` does not (that is v3),
 * and `audio` does not (that is v4). Two whole releases behind today.
 */
function v2Document(): Record<string, unknown> {
  return {
    version: 2,
    updatedMs: 1_700_000_000_000,
    profile: {
      name: 'Ranger', skin: 4, xp: 4820, level: 9, secondsPlayed: 7200,
      adsRemoved: true, createdMs: 1_600_000_000_000, lastMode: ModeId.HORDE,
    },
    quest: {
      activeSlot: 0,
      slots: [{
        id: 'slot-a', name: 'Knee Deep', skill: 3,
        episodeId: 'e1', levelId: 'e1m2-nuclear',
        createdMs: 1_650_000_000_000, updatedMs: 1_690_000_000_000,
        totalTimeSec: 5400, deaths: 22, completed: false,
        loadout: {
          health: 87, armor: 45,
          weaponMask: (1 << WeaponId.PISTOL) | (1 << WeaponId.SHOTGUN),
          weapon: WeaponId.SHOTGUN, ammo: [12, 40, 0, 0, 0], keys: 3, backpack: true,
        },
        levels: [{
          levelId: 'e1m1-hangar', completed: true, bestTimeSec: 214,
          kills: 30, killsTotal: 32, items: 8, itemsTotal: 10, secrets: 1, secretsTotal: 2,
          deaths: 4, attempts: 6, firstClearedMs: 1_660_000_000_000, lastPlayedMs: 1_680_000_000_000,
        }],
      }],
    },
    builder: {
      activeWorldId: 'world1',
      worlds: [{
        id: 'world1', name: 'My World', seed: 0x51ee7,
        createdMs: 1_600_000_000_000, updatedMs: 1_690_000_000_000,
        secondsPlayed: 3600, blocksPlaced: 1204, blocksBroken: 3310, editedChunks: 22,
        online: false, shareCode: '', swatch: 0x4fb84a,
      }],
    },
    horde: {
      bestWave: 17, bestScore: 91_400, runs: 23, totalKills: 1_902,
      totalBlocksPlaced: 640, lastSkill: 3, maps: [],
    },
    deathmatch: {
      matches: 41, wins: 12, kills: 388, deaths: 201, bestStreak: 14, headshots: 61,
      damageDealt: 91_000, secondsPlayed: 7200, favouriteWeapon: WeaponId.SHOTGUN,
      weaponKills: [10, 220, 40, 60, 30, 20, 8],
    },
    // The v2 build also stored the volume sliders on the settings blob, which
    // is where migrateV3toV4 goes looking for them.
    legacySettings: { masterVolume: 0.35, sfxVolume: 0.6, musicVolume: 0.1 },
  };
}

/* ------------------------------------------------------------------------ *
 * Forward: the multi-version jump
 * ------------------------------------------------------------------------ */

describe('a two-version jump', () => {
  it('is actually two versions, or this test proves nothing', () => {
    // If a future release makes v2 adjacent to current, this fixture has to be
    // re-aged. Failing loudly here is better than quietly testing one step.
    expect(SAVES_VERSION - 2).toBeGreaterThanOrEqual(2);
    expect(SAVE_MIGRATIONS.length).toBeGreaterThanOrEqual(2);
  });

  it('runs every migration in the chain, in order', () => {
    const file = migrateSave(v2Document(), 1_800_000_000_000);
    expect(file.version).toBe(SAVES_VERSION);

    // v2 -> v3 gave the player an avatar derived from the skin they picked, so
    // a red player comes back red rather than as the default marine.
    expect(file.profile.avatar).toBe(LEGACY_AVATAR_BY_SKIN[4]);

    // v3 -> v4 added `audio` and carried the old volume sliders into it.
    expect(file.audio.master).toBeCloseTo(0.35, 6);
    expect(file.audio.sfx).toBeCloseTo(0.6, 6);
    expect(file.audio.music).toBeCloseTo(0.1, 6);
    // Fields the old document never had get this release's defaults, not zero.
    expect(file.audio.ambience).toBeGreaterThan(0);
    expect(['off', 'auto', 'on']).toContain(file.audio.threatCues);
  });

  it('loses nothing the player earned on the way through', () => {
    const file = migrateSave(v2Document(), 1_800_000_000_000);

    expect(file.profile.name).toBe('Ranger');
    expect(file.profile.xp).toBe(4820);
    expect(file.profile.level).toBe(9);
    expect(file.profile.adsRemoved).toBe(true);
    expect(file.profile.lastMode).toBe(ModeId.HORDE);

    expect(file.deathmatch.kills).toBe(388);
    expect(file.deathmatch.wins).toBe(12);
    expect(file.deathmatch.bestStreak).toBe(14);
    expect(file.deathmatch.weaponKills[1]).toBe(220);

    expect(file.horde.bestWave).toBe(17);
    expect(file.horde.bestScore).toBe(91_400);

    expect(file.builder.worlds.length).toBe(1);
    expect(file.builder.worlds[0].seed).toBe(0x51ee7);
    expect(file.builder.worlds[0].blocksPlaced).toBe(1204);

    // The deepest nesting in the format: a quest slot's per-level record.
    expect(file.quest.slots.length).toBe(1);
    const slot = file.quest.slots[0];
    expect(slot.skill).toBe(3);
    expect(slot.levelId).toBe('e1m2-nuclear');
    expect(slot.loadout.keys).toBe(3);
    expect(slot.loadout.backpack).toBe(true);
    expect(slot.levels[0].bestTimeSec).toBe(214);
    expect(slot.levels[0].secretsTotal).toBe(2);
  });

  it('is idempotent: migrating the result again changes nothing', () => {
    const once = migrateSave(v2Document(), 1_800_000_000_000);
    const twice = migrateSave(JSON.parse(JSON.stringify(serialiseSave(once))), 1_800_000_000_000);
    expect(twice).toEqual(once);
  });

  it('does the same over three versions, from the original flat v1', () => {
    const file = migrateSave(v1Document(), 1_800_000_000_000);
    expect(file.version).toBe(SAVES_VERSION);
    expect(file.profile.name).toBe('Ranger');
    expect(file.profile.avatar).toBe(LEGACY_AVATAR_BY_SKIN[4]);
    expect(file.deathmatch.kills).toBe(388);
    // v1's `lastSeed` became Builder's first world, so the player's terrain is
    // still there.
    expect(file.builder.worlds[0].seed).toBe(0x51ee7);
    expect(file.builder.worlds[0].blocksBroken).toBe(3310);
    expect(file.audio.master).toBeGreaterThan(0);
  });

  it('upgrades in place, through the storage the client actually uses', () => {
    // The real path: an old document in localStorage, a new build booting on
    // it, and the upgraded document written back.
    const storage = new MemorySaveStorage();
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(v2Document()));

    const loaded = loadSave(storage, 1_800_000_000_000);
    expect(loaded.version).toBe(SAVES_VERSION);
    expect(loaded.profile.xp).toBe(4820);

    expect(storeSave(storage, loaded, 1_800_000_001_000)).toBe(true);
    const written = JSON.parse(storage.getItem(SAVE_STORAGE_KEY) as string) as Record<string, unknown>;
    expect(written.version).toBe(SAVES_VERSION);
    expect(written.legacySettings).toBeUndefined();   // consumed by v3 -> v4

    // And a second boot on the upgraded document is a no-op.
    const again = loadSave(storage, 1_800_000_002_000);
    expect(again.profile.xp).toBe(4820);
    expect(again.audio.master).toBeCloseTo(0.35, 6);
  });
});

/* ------------------------------------------------------------------------ *
 * Backward: the downgrade guard
 * ------------------------------------------------------------------------ */

describe('a rollback does not destroy player data', () => {
  /** A document from one release in the future, as this build would meet it. */
  function futureDocument(): Record<string, unknown> {
    const base = serialiseSave(createSaveFile(1_800_000_000_000));
    return {
      ...base,
      version: SAVES_VERSION + 1,
      profile: { ...(base.profile as Record<string, unknown>), name: 'Ranger', xp: 5000 },
      // Two shapes of new-release data: a whole new top-level section, and a
      // scalar. Both are invisible to this build and both must come back.
      loadouts: { active: 'slug-shotgun', owned: ['slug-shotgun', 'burst-pistol'] },
      seasonId: 4,
    };
  }

  it('reads a newer document without falling over', () => {
    const file = migrateSave(futureDocument());
    expect(file.version).toBe(SAVES_VERSION);
    expect(file.profile.name).toBe('Ranger');
    expect(file.profile.xp).toBe(5000);
  });

  it('carries the unrecognised sections through untouched', () => {
    const file = migrateSave(futureDocument());
    expect(file._unknown).toBeDefined();
    expect(file._unknown?.loadouts).toEqual({ active: 'slug-shotgun', owned: ['slug-shotgun', 'burst-pistol'] });
    expect(file._unknown?.seasonId).toBe(4);
  });

  it('writes them back out at the top level, byte for byte', () => {
    const storage = new MemorySaveStorage();
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(futureDocument()));

    const rolledBack = loadSave(storage, 1_800_000_000_000);
    storeSave(storage, rolledBack, 1_800_000_100_000);

    const written = JSON.parse(storage.getItem(SAVE_STORAGE_KEY) as string) as Record<string, unknown>;
    // The next release, deployed again, finds its own data exactly where it
    // left it — not in a bag it has to know to look in.
    expect(written.loadouts).toEqual({ active: 'slug-shotgun', owned: ['slug-shotgun', 'burst-pistol'] });
    expect(written.seasonId).toBe(4);
    // And it can tell the document was downgraded and re-upgraded.
    expect(written.version).toBe(SAVES_VERSION);
  });

  it('survives two different old builds opening it in a row', () => {
    const storage = new MemorySaveStorage();
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(futureDocument()));
    for (let boot = 0; boot < 3; boot++) {
      const f = loadSave(storage, 1_800_000_000_000 + boot);
      storeSave(storage, f, 1_800_000_000_000 + boot);
    }
    const written = JSON.parse(storage.getItem(SAVE_STORAGE_KEY) as string) as Record<string, unknown>;
    expect(written.seasonId).toBe(4);
    // The bag itself is not written as a nested key: it was spread back out.
    expect(written._unknown).toBeUndefined();
  });

  it('never lets a stale unknown key shadow a field this build owns', () => {
    // The dangerous inverse: an old bag containing a key that a LATER release
    // promoted to a real field. The real field must win.
    const doc = {
      ...serialiseSave(createSaveFile(0)),
      _unknown: { profile: { name: 'HIJACKED' }, horde: 'nonsense' },
    };
    const file = migrateSave(doc);
    expect(file.profile.name).toBe('');
    const written = serialiseSave(file);
    expect((written.profile as Record<string, unknown>).name).toBe('');
    expect(typeof written.horde).toBe('object');
  });

  it('adds nothing to a document that has no unknown keys', () => {
    const file = migrateSave(serialiseSave(createSaveFile(0)));
    expect(file._unknown).toBeUndefined();
    expect(serialiseSave(file)._unknown).toBeUndefined();
  });

  it('keeps KNOWN_SAVE_KEYS honest against the real shape', () => {
    // A field added to `SaveFile` and forgotten here would round-trip through
    // `_unknown` and be written twice.
    for (const key of Object.keys(serialiseSave(createSaveFile(0)))) {
      expect(KNOWN_SAVE_KEYS).toContain(key);
    }
  });
});
