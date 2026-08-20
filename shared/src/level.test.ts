/**
 * DOOMCRAFT — level format, mode protocol and save migration.
 *
 * The two claims this file is here to keep honest:
 *
 *   1. `decodeLevel(encodeLevel(l))` is not "close enough", it is **byte
 *      identical**. Every authored float goes out as f64 for exactly this
 *      reason; a level that drifts on a round trip is a level that plays
 *      differently on the server than in the editor.
 *   2. `validateLevel` **refuses an unreachable exit**. Not by checking that a
 *      door exists — by walking the level. The fixtures below wall the exit
 *      off, then lock it behind a keycard with no key, then add the key back,
 *      and the solver has to be right all three times.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BlockId } from './blocks.ts';
import { CHUNK_VOLUME } from './constants.ts';
import { EntityType, PacketReader, PacketWriter } from './protocol.ts';
import { WeaponId } from './weapons.ts';
import {
  BrushKind,
  DR_SWITCH_ONLY,
  EN_COUNTS_AS_KILL,
  LEVEL_FORMAT_VERSION,
  LevelDecodeError,
  PickupKind,
  PU_COUNTS_AS_ITEM,
  SpawnKind,
  TriggerKind,
  compileLevel,
  createLevelBrush,
  createLevelSource,
  decodeLevel,
  encodeLevel,
  hashLevelBytes,
  isLevelBinary,
  levelTotals,
  parseLevelJson,
  primarySpawn,
  validateLevel,
  type Level,
  type LevelBrush,
  type LevelSource,
} from './level.ts';
import {
  KeyColor,
  ModeId,
  ModePhase,
  MODE_STATE_BYTES,
  ModeStateBuffer,
  Skill,
  createModeContextMessage,
  createModeEventMessage,
  createModeSelectMessage,
  decodeModeContext,
  decodeModeEvent,
  decodeModeSelect,
  decodeModeState,
  encodeModeContext,
  encodeModeEvent,
  encodeModeSelect,
  encodeModeState,
  modeStateChanged,
  roomKeyFor,
  sanitiseContentId,
} from './modes.ts';
import {
  SAVES_VERSION,
  createSaveFile,
  loadSave,
  MemorySaveStorage,
  migrateSave,
  recordDeathmatch,
  recordQuestLevel,
  beginQuest,
  storeSave,
  LEGACY_PROGRESS_KEY,
} from './saves.ts';

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

const E1M1_PATH = fileURLToPath(new URL('../../content/levels/e1m1-hangar.json', import.meta.url));

function brush(patch: Partial<LevelBrush>): LevelBrush {
  return { ...createLevelBrush(), ...patch };
}

interface TwoRoomOptions {
  /** How room A connects to room B. */
  link: 'open' | 'sealed' | 'blueDoor' | 'switchDoor';
  /** Place the blue keycard in room A. */
  key?: boolean;
  /** Place the switch that opens a `switchDoor`. */
  hasSwitch?: boolean;
  exit?: boolean;
  spawn?: boolean;
}

/**
 * A minimal but genuine level: one chunk of solid rock with two rooms carved
 * out of it, the spawn in A and the exit in B. Everything the reachability
 * solve cares about — floors, headroom, doors, keys, switches — is real.
 */
function twoRoomLevel(opts: TwoRoomOptions): LevelSource {
  const src = createLevelSource();
  src.meta.id = 'test-two-room';
  src.meta.name = 'Two Rooms';
  src.meta.episodeId = 'test';
  src.meta.parTimeSec = 30;
  src.minCX = 0; src.minCZ = 0; src.maxCX = 0; src.maxCZ = 0;

  src.brushes.push(brush({ kind: BrushKind.BOX, block: BlockId.STONE, x: 0, y: 0, z: 0, w: 32, h: 21, d: 32 }));
  src.brushes.push(brush({ kind: BrushKind.CLEAR, x: 2, y: 6, z: 2, w: 10, h: 5, d: 10 }));
  src.brushes.push(brush({ kind: BrushKind.CLEAR, x: 20, y: 6, z: 2, w: 10, h: 5, d: 10 }));
  if (opts.link !== 'sealed') {
    src.brushes.push(brush({ kind: BrushKind.CLEAR, x: 12, y: 6, z: 6, w: 8, h: 3, d: 3 }));
  }

  if (opts.spawn !== false) {
    src.spawns.push({ kind: SpawnKind.PLAYER, x: 5.5, y: 6, z: 5.5, yaw: 0, index: 0 });
  }

  if (opts.link === 'blueDoor' || opts.link === 'switchDoor') {
    src.doors.push({
      id: 'd-gate',
      x: 12, y: 6, z: 6, w: 1, h: 3, d: 3,
      key: opts.link === 'blueDoor' ? KeyColor.BLUE : KeyColor.NONE,
      block: BlockId.METAL,
      frameBlock: -1,
      openMs: 700,
      stayMs: 0,
      flags: opts.link === 'switchDoor' ? DR_SWITCH_ONLY : 0,
      lockedMessage: '',
    });
  }
  if (opts.key === true) {
    src.pickups.push({
      id: 'k-blue', kind: PickupKind.KEY, variant: KeyColor.BLUE, amount: 0,
      x: 8.5, y: 6.1, z: 8.5, minSkill: 0, maxSkill: 4, flags: 0,
    });
  }
  if (opts.hasSwitch === true) {
    src.switches.push({
      id: 'sw-gate', x: 2, y: 8, z: 5, face: -1,
      block: BlockId.TECH_PANEL, activeBlock: BlockId.NEON, key: KeyColor.NONE,
      targets: ['d-gate'], flags: 0, message: '',
    });
  }
  src.secrets.push({ id: 's-1', x: 9, y: 6, z: 9, w: 2, h: 2, d: 2, message: 'secret' });

  if (opts.exit !== false) {
    src.exit = {
      x: 25, y: 6, z: 5, w: 3, h: 3, d: 3,
      requiresSwitch: '', nextLevelId: '', flags: 0,
    };
  }
  return src;
}

/** Every field a round trip has to preserve, flattened for a single compare. */
function levelFingerprint(l: Level): unknown {
  const sections: Array<[number, string]> = [];
  for (const [key, bytes] of [...l.volume.sections].sort((a, b) => a[0] - b[0])) {
    let sum = 0;
    let nonAir = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0) { nonAir++; sum = (sum + bytes[i] * (i + 1)) >>> 0; }
    }
    sections.push([key, `${nonAir}:${sum}`]);
  }
  return {
    meta: l.meta,
    bounds: [l.volume.minCX, l.volume.minCZ, l.volume.maxCX, l.volume.maxCZ],
    outside: l.volume.outsideBlock,
    sections,
    spawns: l.spawns,
    enemies: l.enemies,
    pickups: l.pickups,
    doors: l.doors,
    switches: l.switches,
    secrets: l.secrets,
    exit: l.exit,
  };
}

/* ------------------------------------------------------------------------ *
 * Binary format
 * ------------------------------------------------------------------------ */

describe('level binary format', () => {
  it('round-trips a synthetic level with every field intact', () => {
    const src = twoRoomLevel({ link: 'blueDoor', key: true });
    // Load it up with awkward values: irrational angles, deep patrols, unicode.
    src.meta.author = 'Δ tester';
    src.meta.description = 'A room, a door, a room. ✓';
    src.meta.musicCue = 'test/cue';
    src.meta.ambient = 0.3141592653589793;
    src.meta.fogNear = 12.345678901234567;
    src.meta.sunLight = 2 / 3;
    src.enemies.push({
      id: 'e-1', type: EntityType.CACODEMON,
      x: 22.25, y: 7.5, z: 4.125, yaw: Math.PI / 3,
      minSkill: 1, maxSkill: 4,
      trigger: TriggerKind.PROXIMITY, triggerRadius: 13.75, triggerId: '',
      patrol: [22.25, 7.5, 4.125, 26.5, 7.5, 9.75, 21.0, 6.0, 3.5],
      flags: EN_COUNTS_AS_KILL, dropId: 'k-blue',
    });
    src.pickups.push({
      id: 'p-1', kind: PickupKind.WEAPON, variant: WeaponId.ROCKET, amount: 1,
      x: 24.5, y: 6.1, z: 8.5, minSkill: 0, maxSkill: 4, flags: PU_COUNTS_AS_ITEM,
    });

    const level = compileLevel(src);
    const bytes = encodeLevel(level);

    expect(isLevelBinary(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(16);

    const decoded = decodeLevel(bytes);
    expect(levelFingerprint(decoded)).toEqual(levelFingerprint(level));

    // Not merely equal — re-encoding must produce the identical byte stream.
    const again = encodeLevel(decoded);
    expect(again.length).toBe(bytes.length);
    expect(hashLevelBytes(again)).toBe(hashLevelBytes(bytes));
    for (let i = 0; i < bytes.length; i++) {
      if (again[i] !== bytes[i]) throw new Error(`byte ${i} differs: ${bytes[i]} -> ${again[i]}`);
    }
  });

  it('round-trips the shipped E1M1 byte for byte', () => {
    const src = parseLevelJson(readFileSync(E1M1_PATH, 'utf8'));
    expect(src).not.toBeNull();
    const level = compileLevel(src as LevelSource);
    const bytes = encodeLevel(level);
    const decoded = decodeLevel(bytes);
    const again = encodeLevel(decoded);

    expect(again.length).toBe(bytes.length);
    expect(hashLevelBytes(again)).toBe(hashLevelBytes(bytes));
    expect(levelFingerprint(decoded)).toEqual(levelFingerprint(level));
    // 9 chunks of authored geometry in a level small enough to ship over a modem.
    expect(decoded.volume.chunkCount).toBe(9);
    expect(bytes.length).toBeLessThan(256 * 1024);
  });

  it('preserves voxels exactly, section by section', () => {
    const level = compileLevel(twoRoomLevel({ link: 'open' }));
    const decoded = decodeLevel(encodeLevel(level));
    expect(decoded.volume.sections.size).toBe(level.volume.sections.size);
    for (const [key, before] of level.volume.sections) {
      const after = decoded.volume.sections.get(key);
      expect(after).toBeDefined();
      expect((after as Uint8Array).length).toBe(CHUNK_VOLUME);
      for (let i = 0; i < CHUNK_VOLUME; i++) {
        if ((after as Uint8Array)[i] !== before[i]) {
          throw new Error(`voxel ${i} of section ${key}: ${before[i]} -> ${(after as Uint8Array)[i]}`);
        }
      }
    }
  });

  it('rejects a buffer that is not a level', () => {
    expect(() => decodeLevel(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(LevelDecodeError);
    expect(isLevelBinary(new Uint8Array([0x44, 0x43, 0x4c, 0x30, 0, 0]))).toBe(false);
  });

  it('rejects a level written by a newer format version', () => {
    const bytes = encodeLevel(compileLevel(twoRoomLevel({ link: 'open' })));
    // Bytes 4..5 are the little-endian format version.
    bytes[4] = LEVEL_FORMAT_VERSION + 7;
    let caught: unknown = null;
    try { decodeLevel(bytes); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LevelDecodeError);
    expect((caught as LevelDecodeError).code).toBe('E_VERSION');
  });

  it('encodes a uniform section in a handful of bytes', () => {
    const src = createLevelSource();
    src.meta.id = 'empty';
    src.meta.name = 'Empty';
    src.minCX = 0; src.minCZ = 0; src.maxCX = 1; src.maxCZ = 1;
    const level = compileLevel(src);
    expect(level.volume.chunkCount).toBe(4);
    // Four all-air chunks: the whole file is header plus four 5-byte records.
    expect(encodeLevel(level).length).toBeLessThan(512);
  });
});

/* ------------------------------------------------------------------------ *
 * Validation and reachability
 * ------------------------------------------------------------------------ */

describe('level validation', () => {
  it('accepts a level whose exit can be walked to', () => {
    const level = compileLevel(twoRoomLevel({ link: 'open' }));
    const v = validateLevel(level, Skill.HURT_ME_PLENTY);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.reach.ran).toBe(true);
    expect(v.reach.exitReachable).toBe(true);
    expect(v.reach.visitedCells).toBeGreaterThan(100);
  });

  it('REJECTS a level whose exit is walled off', () => {
    const level = compileLevel(twoRoomLevel({ link: 'sealed' }));
    const v = validateLevel(level, Skill.HURT_ME_PLENTY);
    expect(v.ok).toBe(false);
    expect(v.reach.exitReachable).toBe(false);
    expect(v.errors.map((e) => e.code)).toContain('E_EXIT_UNREACHABLE');
    // The spawn room is still walkable — this is not a "nothing loaded" false alarm.
    expect(v.reach.visitedCells).toBeGreaterThan(50);
  });

  it('REJECTS a locked exit when the key does not exist', () => {
    const level = compileLevel(twoRoomLevel({ link: 'blueDoor', key: false }));
    const v = validateLevel(level, Skill.HURT_ME_PLENTY);
    expect(v.ok).toBe(false);
    const codes = v.errors.map((e) => e.code);
    expect(codes).toContain('E_MISSING_KEY');
    expect(codes).toContain('E_EXIT_UNREACHABLE');
    expect(v.reach.keysFound).toEqual([]);
  });

  it('accepts the same locked exit once the key is placed', () => {
    const level = compileLevel(twoRoomLevel({ link: 'blueDoor', key: true }));
    const v = validateLevel(level, Skill.HURT_ME_PLENTY);
    expect(v.errors).toEqual([]);
    expect(v.reach.exitReachable).toBe(true);
    expect(v.reach.keysFound).toEqual([KeyColor.BLUE]);
    expect(v.reach.passes).toBeGreaterThan(1);
  });

  it('follows a switch-only door only when the switch is in reach', () => {
    const withSwitch = validateLevel(compileLevel(twoRoomLevel({ link: 'switchDoor', hasSwitch: true })), 2);
    expect(withSwitch.reach.exitReachable).toBe(true);
    expect(withSwitch.reach.switchesFound).toContain('sw-gate');

    const withoutSwitch = validateLevel(compileLevel(twoRoomLevel({ link: 'switchDoor', hasSwitch: false })), 2);
    expect(withoutSwitch.reach.exitReachable).toBe(false);
    expect(withoutSwitch.errors.map((e) => e.code)).toContain('E_EXIT_UNREACHABLE');
  });

  it('rejects a level with no spawn and a level with no exit', () => {
    const noSpawn = validateLevel(compileLevel(twoRoomLevel({ link: 'open', spawn: false })), 2);
    expect(noSpawn.errors.map((e) => e.code)).toContain('E_NO_SPAWN');

    const noExit = validateLevel(compileLevel(twoRoomLevel({ link: 'open', exit: false })), 2);
    expect(noExit.errors.map((e) => e.code)).toContain('E_NO_EXIT');
  });

  it('rejects a spawn buried in rock', () => {
    const src = twoRoomLevel({ link: 'open' });
    src.spawns[0] = { kind: SpawnKind.PLAYER, x: 16.5, y: 2, z: 16.5, yaw: 0, index: 0 };
    const v = validateLevel(compileLevel(src), 2);
    expect(v.errors.map((e) => e.code)).toContain('E_SPAWN_SOLID');
  });

  it('rejects a switch wired to a door that does not exist', () => {
    const src = twoRoomLevel({ link: 'open' });
    src.switches.push({
      id: 'sw-ghost', x: 2, y: 8, z: 5, face: -1,
      block: BlockId.TECH_PANEL, activeBlock: BlockId.NEON, key: KeyColor.NONE,
      targets: ['d-nope'], flags: 0, message: '',
    });
    const v = validateLevel(compileLevel(src), 2);
    expect(v.errors.map((e) => e.code)).toContain('E_BAD_TARGET');
  });

  it('warns about a secret nobody can enter', () => {
    const src = twoRoomLevel({ link: 'open' });
    src.secrets.push({ id: 's-buried', x: 16, y: 2, z: 16, w: 2, h: 2, d: 2, message: '' });
    const v = validateLevel(compileLevel(src), 2);
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain('W_SECRET_UNREACHABLE');
  });
});

describe('the shipped E1M1', () => {
  const src = parseLevelJson(readFileSync(E1M1_PATH, 'utf8')) as LevelSource;
  const level = compileLevel(src);

  it('validates at every skill', () => {
    for (let skill = 0; skill < 5; skill++) {
      const v = validateLevel(level, skill);
      if (!v.ok) throw new Error(`skill ${skill}: ${v.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`);
      expect(v.reach.exitReachable).toBe(true);
    }
  });

  it('has the pieces a Doom level needs', () => {
    expect(level.meta.id).toBe('e1m1-hangar');
    expect(level.meta.parTimeSec).toBeGreaterThan(0);
    expect(primarySpawn(level).kind).toBe(SpawnKind.PLAYER);

    // A keycard, a door that wants it, a secret, and a switch that arms the exit.
    expect(level.pickups.some((p) => p.kind === PickupKind.KEY && p.variant === KeyColor.BLUE)).toBe(true);
    expect(level.doors.some((d) => d.key === KeyColor.BLUE)).toBe(true);
    expect(level.secrets.length).toBeGreaterThan(0);
    expect(level.exit).not.toBeNull();
    expect(level.exit?.requiresSwitch).toBe('sw-exit');
    expect(level.switches.some((s) => s.id === 'sw-exit' && s.targets.includes('exit'))).toBe(true);

    const totals = levelTotals(level, Skill.HURT_ME_PLENTY);
    expect(totals.enemies).toBeGreaterThan(4);
    expect(totals.items).toBeGreaterThan(4);
    expect(totals.secrets).toBe(1);
  });

  it('gates the exit behind the blue keycard', () => {
    const stripped = parseLevelJson(readFileSync(E1M1_PATH, 'utf8')) as LevelSource;
    stripped.pickups = stripped.pickups.filter((p) => p.kind !== PickupKind.KEY);
    const v = validateLevel(compileLevel(stripped), Skill.HURT_ME_PLENTY);
    expect(v.reach.exitReachable).toBe(false);
    expect(v.errors.map((e) => e.code)).toContain('E_EXIT_UNREACHABLE');
  });

  it('gates the exit behind the exit switch', () => {
    const stripped = parseLevelJson(readFileSync(E1M1_PATH, 'utf8')) as LevelSource;
    stripped.switches = stripped.switches.filter((s) => s.id !== 'sw-exit');
    const v = validateLevel(compileLevel(stripped), Skill.HURT_ME_PLENTY);
    expect(v.reach.exitReachable).toBe(false);
  });

  it('scales its monster count with skill', () => {
    const easy = levelTotals(level, Skill.TOO_YOUNG_TO_DIE).enemies;
    const hard = levelTotals(level, Skill.NIGHTMARE).enemies;
    expect(hard).toBeGreaterThan(easy);
  });
});

/* ------------------------------------------------------------------------ *
 * Mode protocol
 * ------------------------------------------------------------------------ */

describe('mode protocol', () => {
  const w = new PacketWriter(1024);
  const r = new PacketReader();

  it('round-trips a mode select', () => {
    const out = createModeSelectMessage();
    out.modeId = ModeId.QUEST;
    out.skill = Skill.ULTRA_VIOLENCE;
    out.flags = 0b1010;
    out.seed = 0xdeadbeef;
    out.levelId = 'e1m1-hangar';
    out.worldId = '';
    const back = decodeModeSelect(r.reset(encodeModeSelect(w, out).copy()), createModeSelectMessage());
    expect(back).toEqual(out);
  });

  it('sanitises a hostile level id off the wire', () => {
    const out = createModeSelectMessage();
    out.modeId = ModeId.QUEST;
    out.levelId = '../../etc/passwd';
    const back = decodeModeSelect(r.reset(encodeModeSelect(w, out).copy()), createModeSelectMessage());
    expect(back.levelId).toBe('etcpasswd');
    expect(sanitiseContentId('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitiseContentId('..')).toBe('');
    expect(sanitiseContentId('E1M1 Hangar!')).toBe('e1m1hangar');
  });

  it('round-trips the state sidecar', () => {
    const s = new ModeStateBuffer();
    s.modeId = ModeId.HORDE;
    s.phase = ModePhase.BUILD;
    s.skill = Skill.HURT_ME_PLENTY;
    s.flags = 0x1234;
    s.phaseMsLeft = 29_500;
    s.elapsedMs = 412_000;
    s.index = 7;
    s.score = 1240;
    s.a = 31; s.aTotal = 44;
    s.b = 3; s.bTotal = 9;
    s.c = 1; s.cTotal = 2;
    s.budget = 118;
    s.keys = 0b101;
    s.lives = 2;
    s.ackActionSeq = 90_000;

    const encoded = encodeModeState(w, s);
    expect(encoded.offset).toBe(MODE_STATE_BYTES);
    const back = decodeModeState(r.reset(encoded.copy()), new ModeStateBuffer());
    expect(back).toEqual(s);
    expect(modeStateChanged(back, s)).toBe(false);

    back.index = 8;
    expect(modeStateChanged(back, s)).toBe(true);
  });

  it('does not resend the state for a clock that moved less than 100 ms', () => {
    const a = new ModeStateBuffer();
    const b = new ModeStateBuffer();
    a.elapsedMs = 1000;
    b.elapsedMs = 1049;
    expect(modeStateChanged(a, b)).toBe(false);
    b.elapsedMs = 1150;
    expect(modeStateChanged(a, b)).toBe(true);
  });

  it('round-trips events and context', () => {
    const e = createModeEventMessage();
    e.kind = 8;
    e.playerId = 42;
    e.a = 100; e.b = 50; e.c = 3;
    e.text = 'Hangar cleared';
    expect(decodeModeEvent(r.reset(encodeModeEvent(w, e).copy()), createModeEventMessage())).toEqual(e);

    const c = createModeContextMessage();
    c.modeId = ModeId.QUEST;
    c.skill = Skill.NIGHTMARE;
    c.levelId = 'e1m1-hangar';
    c.title = 'Hangar';
    c.contentHash = 0xfeedface;
    c.parTimeSec = 105;
    c.skyColor = 0x120e18;
    c.fogColor = 0x100d14;
    c.ambient = 0.3;
    c.maxPlayers = 4;
    const back = decodeModeContext(r.reset(encodeModeContext(w, c).copy()), createModeContextMessage());
    expect(back.levelId).toBe(c.levelId);
    expect(back.contentHash).toBe(c.contentHash);
    expect(back.skyColor).toBe(c.skyColor);
    // Ambient is quantised to a byte on the wire; everything else is exact.
    expect(Math.abs(back.ambient - c.ambient)).toBeLessThan(1 / 255);
  });

  it('keys rooms so two players who pick the same content meet', () => {
    const a = createModeSelectMessage();
    a.modeId = ModeId.QUEST; a.levelId = 'e1m1-hangar'; a.skill = 3;
    const b = createModeSelectMessage();
    b.modeId = ModeId.QUEST; b.levelId = 'e1m1-hangar'; b.skill = 3;
    const c = createModeSelectMessage();
    c.modeId = ModeId.QUEST; c.levelId = 'e1m1-hangar'; c.skill = 4;
    expect(roomKeyFor(a)).toBe(roomKeyFor(b));
    expect(roomKeyFor(a)).not.toBe(roomKeyFor(c));
  });
});

/* ------------------------------------------------------------------------ *
 * Saves
 * ------------------------------------------------------------------------ */

describe('save migration', () => {
  it('survives garbage', () => {
    for (const junk of [undefined, null, 0, '', 'not json', '{', [], { version: 'x' }]) {
      const s = migrateSave(junk, 1000);
      expect(s.version).toBe(SAVES_VERSION);
      expect(Array.isArray(s.quest.slots)).toBe(true);
      expect(s.deathmatch.weaponKills.length).toBe(7);
    }
  });

  it('carries a v1 progress blob into the v2 sections without losing a number', () => {
    const v1 = {
      version: 1, name: 'Marine', skin: 3, xp: 900, level: 5,
      kills: 240, deaths: 88, wins: 12, gamesPlayed: 40, bestKillstreak: 9,
      blocksPlaced: 1500, blocksBroken: 300, secondsPlayed: 7200,
      favouriteWeapon: 1, lastSeed: 12345, adsRemoved: true,
    };
    const s = migrateSave(v1, 2000);
    expect(s.version).toBe(SAVES_VERSION);
    expect(s.profile.name).toBe('Marine');
    expect(s.profile.adsRemoved).toBe(true);
    expect(s.deathmatch.kills).toBe(240);
    expect(s.deathmatch.deaths).toBe(88);
    expect(s.deathmatch.matches).toBe(40);
    expect(s.deathmatch.bestStreak).toBe(9);
    expect(s.builder.worlds.length).toBe(1);
    expect(s.builder.worlds[0].seed).toBe(12345);
    expect(s.builder.worlds[0].blocksPlaced).toBe(1500);
  });

  it('is idempotent on a v2 document', () => {
    const first = migrateSave({ version: 1, kills: 7, deaths: 2 }, 3000);
    const second = migrateSave(JSON.parse(JSON.stringify(first)), 3000);
    expect(second).toEqual(first);
  });

  it('reads a legacy key when no v2 document exists', () => {
    const store = new MemorySaveStorage();
    store.setItem(LEGACY_PROGRESS_KEY, JSON.stringify({ name: 'Old', kills: 5, gamesPlayed: 3 }));
    const s = loadSave(store, 4000);
    expect(s.profile.name).toBe('Old');
    expect(s.deathmatch.kills).toBe(5);
  });

  it('stores and reloads a campaign', () => {
    const store = new MemorySaveStorage();
    const save = createSaveFile(5000);
    const slot = beginQuest(save, 'e1', 'e1m1-hangar', Skill.ULTRA_VIOLENCE, 5000);
    recordQuestLevel(save, slot, {
      levelId: 'e1m1-hangar', completed: true, timeSec: 94,
      kills: 10, killsTotal: 12, items: 14, itemsTotal: 16, secrets: 1, secretsTotal: 1,
      deaths: 2, nextLevelId: '',
    }, 5000);
    recordDeathmatch(save, {
      kills: 11, deaths: 4, won: true, bestStreak: 5, headshots: 3,
      damageDealt: 1800, secondsPlayed: 300, weaponKills: [1, 4, 6, 0, 0, 0, 0],
    }, 5000);
    expect(storeSave(store, save, 5000)).toBe(true);

    const back = loadSave(store, 6000);
    expect(back.quest.slots.length).toBe(1);
    expect(back.quest.slots[0].levels[0].completed).toBe(true);
    expect(back.quest.slots[0].levels[0].bestTimeSec).toBe(94);
    expect(back.quest.slots[0].completed).toBe(true);
    expect(back.deathmatch.kills).toBe(11);
    expect(back.deathmatch.favouriteWeapon).toBe(WeaponId.CHAINGUN);
  });
});
