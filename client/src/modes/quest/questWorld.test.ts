/**
 * DOOMCRAFT — Quest: the room and the client must be in the SAME world.
 *
 * THE BUG. The owner played the live build and reported "seemed I was going
 * through walls". He was. A Quest level is a file, and it used to be blitted
 * into the CLIENT's voxel store only — `levelRuntime.place()`, relocated onto
 * whatever arena spawn the room handed out (`alignSpawnTo`). The room never saw
 * it: `Sim.applyInput` kept running `moveStep` against generated terrain, and
 * `NetClient.applyLocal` rewinds the predicted body onto the room's answer on
 * every snapshot whose error clears `RECONCILE_EPSILON`. So the room won every
 * argument about every wall, using hills and cliffs the player could not see.
 * Measured on e1m1-hangar: the two worlds agreed on ~20 % of their columns and
 * differed by up to 40 blocks. Where the room's ground sat BELOW the authored
 * floor it pulled the body down through it; where it sat above, it stopped the
 * body dead in an empty corridor and the replay shoved it into a wall.
 *
 * THE FIX. The room stamps the level into `ServerWorld` and pins the respawn to
 * the authored player start; `S2C_MODE.CONTEXT` carries a non-zero content hash
 * to say so, and the client then keeps the authored origin instead of
 * relocating. These tests drive the REAL `Room` and the REAL `NetClient` over an
 * in-memory loopback, through a REAL `C2S_MODE.SELECT`, with the REAL
 * `QuestLevelRuntime` doing the blit.
 *
 * The last test is the control, and it is not decoration: it reproduces the
 * original divergence on the same harness, so a green result above cannot be
 * green because the measurement stopped working.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BTN_SPRINT,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  GameMode,
  PLAYER_HALF_WIDTH,
  aabbHitsSolid,
  blockToChunk,
} from '@shared';
import { BlockId } from '@shared/blocks';
import { PacketWriter } from '@shared/protocol';
import {
  ModeAction,
  ModeId,
  createModeActionMessage,
  createModeSelectMessage,
  encodeModeAction,
  encodeModeSelect,
  type ModeContextMessage,
} from '@shared/modes';
import { DR_START_OPEN, compileLevel, parseLevelJson, primarySpawn, type Level } from '@shared/level';
import { Room } from '@doomcraft/server/src/room.js';
import type { ContentResolver } from '@doomcraft/server/src/modes.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';

import { NetClient, type ClientTransport } from '@/net/client';
import { QuestEvent, QuestLevelRuntime } from '@/modes/quest/levelRuntime';

/* ------------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------------ */

const REPO_ROOT = resolve(__dirname, '../../../..');

const levelCache = new Map<string, Level>();

function loadLevel(id: string): Level {
  const hit = levelCache.get(id);
  if (hit !== undefined) return hit;
  const raw = readFileSync(resolve(REPO_ROOT, 'content/levels', `${id}.json`), 'utf8');
  const src = parseLevelJson(raw);
  if (src === null) throw new Error(`cannot parse ${id}`);
  const level = compileLevel(src);
  levelCache.set(id, level);
  return level;
}

/**
 * The same `ContentResolver` shape the browser Worker installs, but synchronous
 * — the files are on disk here, so there is nothing to wait for.
 */
function diskLevels(ids: readonly string[]): ContentResolver {
  return {
    resolveId: (requested: string): string => (ids.includes(requested) ? requested : ids[0]),
    levelFor: (id: string): Level | null => (ids.includes(id) ? loadLevel(id) : null),
  };
}

/* ------------------------------------------------------------------------ *
 * Harness — real Room, real NetClient, one in-memory wire
 * ------------------------------------------------------------------------ */

interface Fixture {
  room: Room;
  net: NetClient;
  /** Every reconciliation the client was forced into, in metres of error. */
  readonly corrections: number[];
  /** The last `S2C_MODE.CONTEXT` the room sent, or null. */
  context: { levelId: string; contentHash: number } | null;
  frame(): void;
  play(frames: number): void;
  dispose(): void;
}

const live: Fixture[] = [];

function makeFixture(seed: number, levels: ContentResolver | null): Fixture {
  let nowMs = 0;
  const now = (): number => nowMs;

  const room = new Room({
    seed,
    mode: GameMode.SANDBOX,
    botFill: 0,
    enemies: 0,
    eagerWorld: false,
    store: null,
    clock: now,
    levels,
    name: 'quest-world-test',
  });

  let open = true;
  let client!: ClientTransport;
  const serverSide: NetTransport = {
    get isOpen(): boolean { return open; },
    get bufferedAmount(): number { return 0; },
    send(data: Uint8Array): void { if (open) client.onmessage?.(data.slice()); },
    close(code = 1000, reason = ''): void {
      if (!open) return;
      open = false;
      client.onclose?.(code, reason);
    },
  };
  const conn = room.join(serverSide);
  client = {
    get readyState(): number { return open ? 1 : 3; },
    send(data: Uint8Array): void { if (open) room.receive(conn, data.slice()); },
    close(): void { open = false; },
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };

  const corrections: number[] = [];
  const fixture: Fixture = {
    room,
    net: null as unknown as NetClient,
    corrections,
    context: null,
    frame(): void {
      nowMs += 1000 / 60;
      room.advance(nowMs);
      fixture.net.update(1 / 60);
    },
    play(frames: number): void { for (let i = 0; i < frames; i++) fixture.frame(); },
    dispose(): void { fixture.net.dispose(); room.stop(); },
  };

  fixture.net = new NetClient({
    name: 'Marine',
    transport: client,
    autoReconnect: false,
    keepalive: null,
    wallClock: now,
    events: {
      onCorrection: (err: number): void => { corrections.push(err); },
      onModeContext: (c: ModeContextMessage): void => {
        fixture.context = { levelId: c.levelId, contentHash: c.contentHash };
      },
    },
  });
  fixture.net.connect();

  live.push(fixture);
  return fixture;
}

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose();
});

/* ------------------------------------------------------------------------ *
 * The client half of the campaign, exactly as `quest.ts` does it
 * ------------------------------------------------------------------------ */

const selectWriter = new PacketWriter(128);

function selectQuest(f: Fixture, levelId: string): void {
  const m = createModeSelectMessage();
  m.modeId = ModeId.QUEST;
  m.skill = 2;
  m.flags = 0;
  m.seed = 0;
  m.levelId = levelId;
  m.worldId = '';
  f.net.send(encodeModeSelect(selectWriter, m).copy());
}

function selectDeathmatch(f: Fixture): void {
  const m = createModeSelectMessage();
  m.modeId = ModeId.DEATHMATCH;
  m.skill = 2;
  m.flags = 0;
  m.seed = 0;
  m.levelId = '';
  m.worldId = '';
  f.net.send(encodeModeSelect(selectWriter, m).copy());
}

/**
 * A `QuestLevelRuntime` wired to the client's live voxel store, as `quest.ts`
 * wires it — including the one event that goes back upstream: a door whose
 * voxels moved has to move the room's voxels too.
 */
function runtimeFor(f: Fixture, level: Level): QuestLevelRuntime {
  const actionMsg = createModeActionMessage();
  const actionWriter = new PacketWriter(128);
  let seq = 1;
  return new QuestLevelRuntime({
    level,
    skill: 2,
    world: {
      chunkAt: (cx, cz) => f.net.world.chunkAt(cx, cz),
      putChunk: (cx, cz, voxels) => { f.net.world.putChunk(cx, cz, voxels); },
      setBlock: (x, y, z, id) => { f.net.world.setBlock(x, y, z, id); },
      getBlock: (x, y, z) => f.net.world.getBlock(x, y, z),
    },
    events: (kind, index, a) => {
      if (kind !== QuestEvent.DOOR_ROWS) return;
      if (f.context === null || f.context.contentHash === 0) return;
      const m = actionMsg;
      m.action = ModeAction.SET_DOOR;
      m.a = index; m.b = a;
      m.x = 0; m.y = 0; m.z = 0;
      m.seq = seq++;
      f.net.send(encodeModeAction(actionWriter, m).copy());
    },
  });
}

/**
 * `QuestMode.tryPlace`, reduced to the decision this file is about: place on
 * the authored origin when the room owns the geometry, relocate when it does
 * not.
 */
function placeLevel(f: Fixture, runtime: QuestLevelRuntime, level: Level): boolean {
  const roomOwns = f.context !== null && f.context.contentHash !== 0;
  const px = f.net.renderPos[0], py = f.net.renderPos[1], pz = f.net.renderPos[2];
  const authored = primarySpawn(level);
  const onSpawn = Math.abs(px - authored.x) < 3
    && Math.abs(pz - authored.z) < 3
    && Math.abs(py - authored.y) < 4;
  if (!roomOwns && !onSpawn) runtime.alignSpawnTo(px, py, pz);
  runtime.place();
  return roomOwns;
}

/* ------------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------------ */

/**
 * True when the player's box overlaps a solid voxel in the CLIENT's world.
 *
 * `aabbHitsSolid` is the collision kernel's own predicate, skin and all, so
 * "inside geometry" here means exactly what the simulation means by it — a body
 * resting flush against a wall is not inside it.
 */
function insideGeometry(net: NetClient): boolean {
  const p = net.predicted.pos;
  return aabbHitsSolid(p[0], p[1], p[2], PLAYER_HALF_WIDTH, net.predicted.height, net.world.solidAt);
}

interface Walk {
  corrections: number[];
  worstCorrection: number;
  insideFrames: number;
  /**
   * Largest single-frame move of the RENDERED body, metres. The camera reads
   * `renderPos`, so this is what the player actually sees — including the
   * step-up smoothing, which is the whole reason a 1.05 m step does not read as
   * a teleport.
   */
  worstJump: number;
  /** Largest single-frame move of the simulated body. Steps are allowed here. */
  worstBodyJump: number;
  distance: number;
}

/**
 * Sprint on `headings`, a few seconds each, and watch what the room does to the
 * body. This is the player's own report — "I was walking and I went through a
 * wall" — turned into numbers.
 */
function walkAround(f: Fixture, runtime: QuestLevelRuntime, headings: readonly number[], framesEach: number): Walk {
  f.corrections.length = 0;
  const out: Walk = {
    corrections: f.corrections,
    worstCorrection: 0, insideFrames: 0, worstJump: 0, worstBodyJump: 0, distance: 0,
  };
  const prevEye = [f.net.renderPos[0], f.net.renderPos[1], f.net.renderPos[2]];
  const prevBody = [f.net.predicted.pos[0], f.net.predicted.pos[1], f.net.predicted.pos[2]];

  f.net.setMove(0, 1);
  f.net.setButtons(BTN_SPRINT);
  for (const yaw of headings) {
    f.net.setLook(yaw, 0);
    for (let i = 0; i < framesEach; i++) {
      f.frame();
      runtime.reassert(4);
      if (insideGeometry(f.net)) out.insideFrames++;

      const e = f.net.renderPos;
      const eyeStep = Math.hypot(e[0] - prevEye[0], e[1] - prevEye[1], e[2] - prevEye[2]);
      if (eyeStep > out.worstJump) out.worstJump = eyeStep;
      prevEye[0] = e[0]; prevEye[1] = e[1]; prevEye[2] = e[2];

      const p = f.net.predicted.pos;
      const step = Math.hypot(p[0] - prevBody[0], p[1] - prevBody[1], p[2] - prevBody[2]);
      if (step > out.worstBodyJump) out.worstBodyJump = step;
      out.distance += step;
      prevBody[0] = p[0]; prevBody[1] = p[1]; prevBody[2] = p[2];
    }
  }
  f.net.setMove(0, 0);
  f.net.setButtons(0);
  for (const e of f.corrections) if (e > out.worstCorrection) out.worstCorrection = e;
  return out;
}

/**
 * Columns where the client's voxels and the room's voxels disagree, over the
 * chunks around the level's player start. This is the number that used to be
 * four fifths of the footprint.
 */
function voxelDisagreements(f: Fixture, level: Level): number {
  let bad = 0;
  const spawn = primarySpawn(level);
  const cx0 = blockToChunk(Math.floor(spawn.x)) - 4;
  const cz0 = blockToChunk(Math.floor(spawn.z)) - 4;
  for (let cz = cz0; cz <= cz0 + 8; cz++) {
    for (let cx = cx0; cx <= cx0 + 8; cx++) {
      const client = f.net.world.chunkAt(cx, cz);
      if (client === undefined) continue;
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
          const wx = cx * CHUNK_SIZE_X + lx;
          const wz = cz * CHUNK_SIZE_Z + lz;
          for (let y = 0; y < 40; y++) {
            if (f.net.world.solidAt(wx, y, wz) !== f.room.world.isSolid(wx, y, wz)) { bad++; y = 40; }
          }
        }
      }
    }
  }
  return bad;
}

/** Get to a live match: connected, spawned, terrain streaming. */
function reachPlaying(f: Fixture): void {
  for (let i = 0; i < 600 && (f.net.status !== 'playing' || f.net.world.chunkCount === 0); i++) f.frame();
  expect(f.net.status).toBe('playing');
}

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

const HEADINGS = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, -Math.PI / 2, -Math.PI / 4, 2.6];

describe('Quest: the room simulates the level the player is looking at', () => {
  it('stamps the level into the room world and pins the spawn to the authored start', () => {
    const level = loadLevel('e1m1-hangar');
    const f = makeFixture(90210, diskLevels(['e1m1-hangar']));
    reachPlaying(f);

    selectQuest(f, 'e1m1-hangar');
    f.play(20);

    // The room says, on the wire, that its own world is this level.
    expect(f.room.authoredLevelId).toBe('e1m1-hangar');
    expect(f.context?.levelId).toBe('e1m1-hangar');
    expect(f.context?.contentHash).not.toBe(0);

    // ...and it put the body on the level's player start, not on an arena.
    const spawn = primarySpawn(level);
    expect(Math.abs(f.net.renderPos[0] - spawn.x)).toBeLessThan(3);
    expect(Math.abs(f.net.renderPos[2] - spawn.z)).toBeLessThan(3);
    expect(Math.abs(f.net.renderPos[1] - spawn.y)).toBeLessThan(4);
  });

  it('client and room agree voxel for voxel once the level is placed', () => {
    const level = loadLevel('e1m1-hangar');
    const f = makeFixture(90210, diskLevels(['e1m1-hangar']));
    reachPlaying(f);
    selectQuest(f, 'e1m1-hangar');
    f.play(20);

    const runtime = runtimeFor(f, level);
    expect(placeLevel(f, runtime, level)).toBe(true);
    f.play(60);

    expect(voxelDisagreements(f, level)).toBe(0);
  });

  it.each(['e1m1-hangar', 'e1m3-warrens'])(
    'sprinting through %s never rubber-bands and never ends up inside the level',
    (id) => {
      const level = loadLevel(id);
      const f = makeFixture(1234, diskLevels([id]));
      reachPlaying(f);
      selectQuest(f, id);
      f.play(20);

      const runtime = runtimeFor(f, level);
      expect(placeLevel(f, runtime, level)).toBe(true);
      f.play(30);

      const walk = walkAround(f, runtime, HEADINGS, 90);

      // Zero is the honest bar here: the client runs the room's own `moveStep`
      // against the room's own voxels, so anything at all means the two worlds
      // have drifted apart again.
      expect(walk.corrections.length).toBe(0);
      expect(walk.worstCorrection).toBe(0);
      expect(walk.insideFrames).toBe(0);
      // The camera never teleports. A sprint covers 0.21 m per frame at 60 Hz;
      // a rubber-band or an unsmoothed 1.05 m auto step-up covers far more.
      expect(walk.worstJump).toBeLessThan(0.35);
      // ...and it really did walk: a test that never moved would also pass.
      expect(walk.distance).toBeGreaterThan(20);
    },
  );

  it('gives the world back when the player leaves the campaign', () => {
    const f = makeFixture(90210, diskLevels(['e1m1-hangar']));
    reachPlaying(f);
    selectQuest(f, 'e1m1-hangar');
    f.play(20);
    expect(f.room.authoredLevelId).toBe('e1m1-hangar');

    selectDeathmatch(f);
    f.play(20);

    // Otherwise the next Deathmatch is played inside E1M1.
    expect(f.room.authoredLevelId).toBe('');
    expect(f.context?.contentHash).toBe(0);
  });

  it('holds its answer until a lazily-loaded level has landed', async () => {
    // This is the SHIPPED path. The browser Worker knows every level id from
    // the bundler but fetches the bytes one at a time, so the room cannot say
    // whether it owns the geometry the instant a `SELECT` arrives — and the
    // client uses that answer to decide where to put the level. Answering "no"
    // and correcting later would place the level in the wrong world first.
    const id = 'e1m1-hangar';
    let loaded = false;
    const lazy: ContentResolver = {
      resolveId: (): string => id,
      levelFor: (): Level | null => (loaded ? loadLevel(id) : null),
      requestLevel: async (): Promise<void> => {
        await new Promise<void>((done) => { setTimeout(done, 0); });
        loaded = true;
      },
    };

    const f = makeFixture(90210, lazy);
    reachPlaying(f);
    expect(f.context).toBeNull();

    selectQuest(f, id);
    f.play(4);
    // Still nothing: the room has not decided, so it has not spoken.
    expect(f.context).toBeNull();
    expect(f.room.authoredLevelId).toBe('');

    await new Promise<void>((done) => { setTimeout(done, 1); });
    f.play(10);

    expect(f.room.authoredLevelId).toBe(id);
    expect(f.context?.levelId).toBe(id);
    expect(f.context?.contentHash).not.toBe(0);

    const level = loadLevel(id);
    const runtime = runtimeFor(f, level);
    expect(placeLevel(f, runtime, level)).toBe(true);
    f.play(30);
    expect(voxelDisagreements(f, level)).toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * The other half of "I went through that wall"
   * ---------------------------------------------------------------- */

  it('auto-steps a full block, and the camera climbs it instead of teleporting', () => {
    const level = loadLevel('e1m1-hangar');
    const f = makeFixture(90210, diskLevels(['e1m1-hangar']));
    reachPlaying(f);
    selectQuest(f, 'e1m1-hangar');
    f.play(20);
    const runtime = runtimeFor(f, level);
    expect(placeLevel(f, runtime, level)).toBe(true);
    f.play(30);

    // A waist-high wall three metres down the room the level points you at,
    // put into BOTH worlds so nothing here is measuring desync.
    const yaw = primarySpawn(level).yaw;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    const startY = f.net.predicted.pos[1];
    const floorY = Math.floor(startY + 0.05);
    for (let along = 3; along <= 4; along++) {
      for (let across = -3; across <= 3; across++) {
        const x = Math.round(f.net.predicted.pos[0] + dx * along - dz * across);
        const z = Math.round(f.net.predicted.pos[2] + dz * along + dx * across);
        f.room.world.setBlock(x, floorY, z, BlockId.STONE, 0);
        f.net.world.setBlock(x, floorY, z, BlockId.STONE);
      }
    }

    f.net.setLook(yaw, 0);
    f.net.setMove(0, 1);
    f.net.setButtons(BTN_SPRINT);
    f.corrections.length = 0;

    let bodyRise = 0;
    let worstEyeRise = 0;
    let highestEyeY = f.net.renderPos[1];
    let prevBodyY = f.net.predicted.pos[1];
    let prevEyeY = f.net.renderPos[1];
    for (let i = 0; i < 90; i++) {
      f.frame();
      runtime.reassert(4);
      const b = f.net.predicted.pos[1] - prevBodyY;
      if (b > bodyRise) bodyRise = b;
      const e = f.net.renderPos[1] - prevEyeY;
      if (e > worstEyeRise) worstEyeRise = e;
      if (f.net.renderPos[1] > highestEyeY) highestEyeY = f.net.renderPos[1];
      prevBodyY = f.net.predicted.pos[1];
      prevEyeY = f.net.renderPos[1];
    }
    f.net.setMove(0, 0);
    f.net.setButtons(0);

    // `STEP_HEIGHT = 1.05` is a deliberate break from the bar (docs/CONTRACT.md
    // §11): a whole block is walked up, in one tick, with no jump. Untouched.
    expect(bodyRise).toBeGreaterThan(0.9);
    // The EYE is what the player judges. It used to take the same metre in a
    // single frame, which reads as being teleported through the wall.
    expect(worstEyeRise).toBeLessThan(0.25);
    // ...and it did climb: the eye must not simply be stuck a metre low. It
    // ends the run back on the floor, having walked off the far side of the
    // two-block-deep wall, so the top of the arc is what is checked.
    expect(highestEyeY).toBeGreaterThan(startY + 0.8);
    // Both worlds have the wall, so nothing above is a reconciliation artefact.
    expect(f.corrections.length).toBe(0);
  });

  it('opens a door in BOTH worlds — the wall you can see through is not a wall', () => {
    // The nastiest case the moment the room started simulating the level: a
    // voxel door opens by deleting itself into its own lintel, and that carve
    // used to happen only in the client's store. The room would have kept a
    // solid slab in an open doorway — a wall you can see straight through and
    // are shoved back out of. `ModeAction.SET_DOOR` closes it.
    const id = 'e1m1-hangar';
    const level = loadLevel(id);
    const f = makeFixture(90210, diskLevels([id]));
    reachPlaying(f);
    selectQuest(f, id);
    f.play(20);

    const runtime = runtimeFor(f, level);
    expect(placeLevel(f, runtime, level)).toBe(true);
    f.play(20);

    // The one door in E1M1 that opens without a keycard: the secret.
    const index = level.doors.findIndex((d) => (d.flags & DR_START_OPEN) === 0);
    expect(index).toBeGreaterThanOrEqual(0);
    const door = level.doors[index];
    const mx = door.x + Math.floor(door.w / 2);
    const my = door.y;
    const mz = door.z + Math.floor(door.d / 2);

    // Shut, both worlds agree it is a wall.
    expect(f.net.world.solidAt(mx, my, mz)).toBe(true);
    expect(f.room.world.isSolid(mx, my, mz)).toBe(true);

    // Throw it, and run the level script the way `quest.ts` runs it.
    runtime.openDoor(index, true);
    for (let i = 0; i < 120; i++) {
      f.frame();
      runtime.update(1 / 60, f.net.predicted.pos[0], f.net.predicted.pos[1], f.net.predicted.pos[2]);
    }

    expect(f.net.world.solidAt(mx, my, mz)).toBe(false);
    expect(f.room.world.isSolid(mx, my, mz)).toBe(false);

    // ...every row of it, not just the one the middle happens to be on.
    for (let y = door.y; y < door.y + door.h; y++) {
      for (let z = door.z; z < door.z + door.d; z++) {
        for (let x = door.x; x < door.x + door.w; x++) {
          expect(f.room.world.isSolid(x, y, z)).toBe(f.net.world.solidAt(x, y, z));
        }
      }
    }
  });

  it('shuts the doors again when the level restarts', () => {
    // A restart is a fresh mode instance: the client's level script re-arms
    // every trigger and blits every door shut. The room has to repaint too, or
    // the second attempt is played against the first attempt's open doors.
    const id = 'e1m1-hangar';
    const level = loadLevel(id);
    const f = makeFixture(90210, diskLevels([id]));
    reachPlaying(f);
    selectQuest(f, id);
    f.play(20);

    const first = runtimeFor(f, level);
    placeLevel(f, first, level);
    f.play(20);

    const index = level.doors.findIndex((d) => (d.flags & DR_START_OPEN) === 0);
    const door = level.doors[index];
    const mx = door.x + Math.floor(door.w / 2);
    const mz = door.z + Math.floor(door.d / 2);

    first.openDoor(index, true);
    for (let i = 0; i < 120; i++) {
      f.frame();
      first.update(1 / 60, f.net.predicted.pos[0], f.net.predicted.pos[1], f.net.predicted.pos[2]);
    }
    expect(f.room.world.isSolid(mx, door.y, mz)).toBe(false);

    // Restart: `QuestMode.restart()` re-activates the mode, which re-sends
    // `C2S_MODE.SELECT` for the same level and builds a new runtime.
    selectQuest(f, id);
    f.play(20);
    const second = runtimeFor(f, level);
    placeLevel(f, second, level);
    f.play(20);

    expect(f.room.world.isSolid(mx, door.y, mz)).toBe(true);
    expect(f.net.world.solidAt(mx, door.y, mz)).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * The control
   * ---------------------------------------------------------------- */

  it('CONTROL: a room without the level is exactly the bug that was reported', () => {
    const level = loadLevel('e1m1-hangar');
    // No resolver — this is the shipped behaviour before the fix: the campaign
    // painted onto the client only, relocated onto the arena spawn.
    const f = makeFixture(90210, null);
    reachPlaying(f);
    selectQuest(f, 'e1m1-hangar');
    f.play(20);

    expect(f.room.authoredLevelId).toBe('');
    expect(f.context?.contentHash).toBe(0);

    const runtime = runtimeFor(f, level);
    expect(placeLevel(f, runtime, level)).toBe(false);
    f.play(30);

    const walk = walkAround(f, runtime, HEADINGS, 90);

    // The measurement above is not vacuous: on the same harness, with the same
    // inputs, a room that has never heard of the level rubber-bands the player
    // and puts him inside the walls he can see.
    expect(walk.corrections.length).toBeGreaterThan(0);
    expect(walk.insideFrames).toBeGreaterThan(0);
  });
});
