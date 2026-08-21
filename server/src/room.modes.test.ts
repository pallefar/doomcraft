/**
 * DOOMCRAFT — the room's half of the mode layer.
 *
 * The client mode registry is proved by `tools/mode-loop.mjs`, which drives the
 * real build and asserts that every mode's scope unwinds to nothing. This file
 * proves the other half: that a `C2S_MODE.SELECT` on the wire actually changes
 * what the room DOES, rather than only changing a label.
 *
 * Five claims, each of which was a real bug before it was a test:
 *
 *   1. Selecting Builder makes the world safe. Builder's definition has no
 *      monsters and no PvP, and until the room read that, a zombieman shot the
 *      player dead three seconds into a creative session.
 *   2. Selecting Horde builds a wave director and the director actually runs.
 *   3. `SPAWN_ENEMY` gives an authored Quest enemy a body — and is refused
 *      outright in every other mode, because it is a client asking the server
 *      to create an entity.
 *   4. `SET_SPAWN` pins the respawn to the authored player start, so dying in
 *      the campaign puts you back in the level instead of out on the terrain.
 *   5. The state sidecar is silent for Quest. The room does not own the level,
 *      so it has no kills/items/secrets to report and must not invent them.
 */

import { describe, expect, it } from 'vitest';
import {
  EntityType,
  GameMode,
  MAX_HEALTH,
  PacketWriter,
  S2C,
  TICK_MS,
  WeaponId,
  encodeHello,
  encodeInput,
} from '@doomcraft/shared';
import {
  ModeAction,
  ModeId,
  ModePhase,
  S2C_MODE,
  createModeActionMessage,
  createModeSelectMessage,
  encodeModeAction,
  encodeModeSelect,
} from '@doomcraft/shared/modes';

import { Room } from './room.js';
import type { NetTransport } from './net.js';
import type { PlayerEntity } from './sim.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

class FakeSocket implements NetTransport {
  open = true;
  readonly packets: Uint8Array[] = [];
  get isOpen(): boolean { return this.open; }
  get bufferedAmount(): number { return 0; }
  send(data: Uint8Array): void {
    if (data.length > 0 && data[0] === S2C.CHUNK) return;
    if (this.packets.length < 8192) this.packets.push(data.slice());
  }
  close(): void { this.open = false; }
}

interface Harness {
  room: Room;
  socket: FakeSocket;
  conn: ReturnType<Room['join']>;
  player: PlayerEntity;
  writer: PacketWriter;
  seq: number;
}

function makeRoom(seed = 4242): Room {
  return new Room({
    seed,
    mode: GameMode.DEATHMATCH,
    botFill: 0,
    enemies: 0,
    eagerWorld: false,
    store: null,
    clock: () => 0,
    allWeapons: true,
  });
}

function join(room: Room, name = 'Marine'): Harness {
  const socket = new FakeSocket();
  const conn = room.join(socket);
  const writer = new PacketWriter(256);
  encodeHello(writer, name, 0, 0);
  room.receive(conn, writer.copy());
  const player = room.sim.getPlayer(conn.playerId);
  expect(player).toBeDefined();
  return { room, socket, conn, player: player as PlayerEntity, writer, seq: 0 };
}

function selectMode(h: Harness, modeId: ModeId, levelId = '', skill = 2): void {
  const m = createModeSelectMessage();
  m.modeId = modeId;
  m.skill = skill;
  m.levelId = levelId;
  h.room.receive(h.conn, encodeModeSelect(h.writer, m).copy());
}

function action(
  h: Harness, act: ModeAction,
  a = 0, b = 0, x = 0, y = 0, z = 0, seq = 1,
): void {
  const m = createModeActionMessage();
  m.action = act;
  m.a = a; m.b = b; m.x = x; m.y = y; m.z = z; m.seq = seq;
  h.room.receive(h.conn, encodeModeAction(h.writer, m).copy());
}

function steps(room: Room, n: number): void {
  for (let i = 0; i < n; i++) room.step();
}

/**
 * Steps the room while the client keeps talking. A real client sends an input
 * command every tick; a harness that only calls `step()` looks like a hung
 * socket and the net layer reaps it after fifteen simulated seconds, which is
 * long enough that a three-round test hits it and a one-round test does not.
 */
function pump(h: Harness, n: number): void {
  for (let i = 0; i < n; i++) {
    h.seq++;
    encodeInput(h.writer, h.seq, TICK_MS, h.player.yaw, 0, 0, 0, 0, 0);
    h.room.receive(h.conn, h.writer.copy());
    h.room.step();
  }
}

function monsterCount(room: Room): number {
  let n = 0;
  for (let i = 0; i < room.sim.entCapacity; i++) {
    if (room.sim.entActive[i] !== 1) continue;
    if (room.sim.entType[i] >= EntityType.PICKUP_HEALTH) continue;
    n++;
  }
  return n;
}

function countPackets(socket: FakeSocket, id: number): number {
  let n = 0;
  for (const p of socket.packets) if (p.length > 0 && p[0] === id) n++;
  return n;
}

/* ------------------------------------------------------------------------ *
 * 1. Builder is a sanctuary
 * ------------------------------------------------------------------------ */

describe('a mode selection changes what the room does', () => {
  it('Builder clears the demons and makes the builder unkillable', () => {
    const room = makeRoom();
    const h = join(room);

    // Put three demons in the room the hard way, so the test is not relying on
    // the ambient director having got round to it.
    const y = room.world.standableY(0, 0);
    expect(y).toBeGreaterThan(0);
    room.spawnMonster(EntityType.ZOMBIE, 2.5, y + 1, 0.5);
    room.spawnMonster(EntityType.IMP, -2.5, y + 1, 0.5);
    room.spawnMonster(EntityType.IMP, 0.5, y + 1, 3.5);
    expect(monsterCount(room)).toBe(3);

    selectMode(h, ModeId.BUILDER);
    steps(room, 2);

    expect(room.plan.modeId).toBe(ModeId.BUILDER);
    expect(monsterCount(room)).toBe(0);
    expect(room.monsters.budget.target).toBe(0);

    // Creative worlds have no fall damage and no lava burn either.
    expect(room.sim.fallDamageEnabled).toBe(false);
    expect(room.sim.hazardsEnabled).toBe(false);

    // And nothing that arrives late can hurt the builder.
    h.player.health = MAX_HEALTH;
    for (let i = 0; i < 40; i++) {
      room.sim.damagePlayer(h.player, 0, 25, WeaponId.PISTOL, 0, 0, 0, 1);
      room.step();
    }
    expect(h.player.dead).toBe(false);
    expect(h.player.health).toBe(MAX_HEALTH);
    room.stop();
  });

  it('leaving Builder hands mortality back', () => {
    const room = makeRoom();
    const h = join(room);

    selectMode(h, ModeId.BUILDER);
    steps(room, 2);
    expect(h.player.spawnProtectUntilMs).toBeGreaterThan(1e12);

    selectMode(h, ModeId.DEATHMATCH);
    steps(room, 2);
    expect(h.player.spawnProtectUntilMs).toBeLessThan(1e9);
    expect(room.sim.fallDamageEnabled).toBe(true);

    // Run the protection out, then prove damage lands again.
    steps(room, 120);
    h.player.health = MAX_HEALTH;
    room.sim.damagePlayer(h.player, 0, 30, WeaponId.PISTOL, 0, 0, 0, 1);
    expect(h.player.health).toBeLessThan(MAX_HEALTH);
    room.stop();
  });

  /* ---------------------------------------------------------------------- *
   * 2. Horde gets a director
   * ---------------------------------------------------------------------- */

  it('Horde builds a wave director, and the director runs the phase machine', () => {
    const room = makeRoom();
    const h = join(room);
    expect(room.horde).toBeNull();

    selectMode(h, ModeId.HORDE);
    steps(room, 4);

    const horde = room.horde;
    expect(horde).not.toBeNull();
    if (horde === null) return;

    // The hold point is chosen from the live player, once.
    steps(room, 20);
    expect(horde.holdY).toBeGreaterThanOrEqual(0);
    const heldX = horde.holdX;
    const heldZ = horde.holdZ;

    // The build phase is running and the credits are the director's, not ours.
    expect(horde.creditsOf(h.conn.playerId)).toBeGreaterThan(0);
    expect(horde.phase).toBe(ModePhase.BUILD);
    const clockAtStart = horde.buildMsLeft;
    expect(clockAtStart).toBeGreaterThan(0);

    pump(h, 40);
    expect(horde.buildMsLeft).toBeLessThan(clockAtStart);
    // The hold point never moves — the whole mode depends on that.
    expect(horde.holdX).toBe(heldX);
    expect(horde.holdZ).toBe(heldZ);

    // READY skips the fortify clock, which is what puts a wave on the map.
    action(h, ModeAction.READY, 0, 0, 0, 0, 0, 7);
    pump(h, 80);
    expect(horde.phase).toBe(ModePhase.LIVE);
    expect(horde.wave).toBeGreaterThanOrEqual(1);
    expect(monsterCount(room)).toBeGreaterThan(0);

    // The room stops running the director the moment the mode changes.
    selectMode(h, ModeId.DEATHMATCH);
    steps(room, 2);
    expect(room.horde).toBeNull();
    room.stop();
  });

  /* ---------------------------------------------------------------------- *
   * 3. SPAWN_ENEMY is Quest-only
   * ---------------------------------------------------------------------- */

  it('gives an authored Quest enemy a body, and refuses to in any other mode', () => {
    const room = makeRoom();
    const h = join(room);
    const y = room.world.standableY(8, 8);
    expect(y).toBeGreaterThan(0);

    // Deathmatch: a client asking for a monster is simply ignored.
    selectMode(h, ModeId.DEATHMATCH);
    steps(room, 2);
    const before = monsterCount(room);
    action(h, ModeAction.SPAWN_ENEMY, EntityType.IMP, 0, 8, y + 1, 8);
    steps(room, 2);
    expect(monsterCount(room)).toBe(before);

    // Quest: the same message produces exactly one demon.
    selectMode(h, ModeId.QUEST, 'e1m1-hangar');
    steps(room, 2);
    action(h, ModeAction.SPAWN_ENEMY, EntityType.IMP, 0, 8, y + 1, 8, 2);
    steps(room, 2);
    expect(monsterCount(room)).toBe(1);

    // A type that is not a monster is refused rather than spawned as a pickup.
    action(h, ModeAction.SPAWN_ENEMY, EntityType.PICKUP_WEAPON, 0, 9, y + 1, 9, 3);
    steps(room, 2);
    expect(monsterCount(room)).toBe(1);

    // And the roster is bounded: a client cannot ask for a hundred demons.
    for (let i = 0; i < 90; i++) {
      action(h, ModeAction.SPAWN_ENEMY, EntityType.ZOMBIE, 0, 8 + (i % 9), y + 1, 8, 10 + i);
    }
    steps(room, 2);
    expect(monsterCount(room)).toBeLessThanOrEqual(64);

    // Restarting the level takes the bodies away again.
    action(h, ModeAction.RESTART, 0, 0, 0, 0, 0, 999);
    steps(room, 2);
    expect(monsterCount(room)).toBe(0);
    room.stop();
  });

  /* ---------------------------------------------------------------------- *
   * 4. SET_SPAWN pins the campaign's restart point
   * ---------------------------------------------------------------------- */

  it('respawns a dead Quest player on the authored start, not on the arena', () => {
    const room = makeRoom();
    const h = join(room);
    selectMode(h, ModeId.QUEST, 'e1m1-hangar');
    steps(room, 2);

    const sx = 12;
    const sz = -20;
    const sy = room.world.standableY(sx, sz);
    expect(sy).toBeGreaterThan(0);
    action(h, ModeAction.SET_SPAWN, 90, 0, sx, sy, sz);
    steps(room, 2);
    expect(room.sim.spawnAnchor).not.toBeNull();

    // Die three times; land on the same authored tile every time.
    for (let round = 0; round < 3; round++) {
      h.player.spawnProtectUntilMs = 0;
      room.sim.damagePlayer(h.player, 0, 500, WeaponId.PISTOL, 0, 0, 0, 1);
      expect(h.player.dead).toBe(true);
      pump(h, 140);
      expect(h.player.dead).toBe(false);
      expect(h.player.pos[0]).toBeCloseTo(sx + 0.5, 5);
      expect(h.player.pos[2]).toBeCloseTo(sz + 0.5, 5);
    }

    // Deathmatch must not inherit the campaign's start.
    selectMode(h, ModeId.DEATHMATCH);
    steps(room, 2);
    expect(room.sim.spawnAnchor).toBeNull();
    room.stop();
  });

  /* ---------------------------------------------------------------------- *
   * 5. The sidecar tells the truth or says nothing
   * ---------------------------------------------------------------------- */

  it('sends a state sidecar for Deathmatch and stays silent for Quest', () => {
    const room = makeRoom();
    const h = join(room);

    selectMode(h, ModeId.DEATHMATCH);
    steps(room, 20);
    expect(countPackets(h.socket, S2C_MODE.STATE)).toBeGreaterThan(0);
    expect(countPackets(h.socket, S2C_MODE.CONTEXT)).toBeGreaterThan(0);

    h.socket.packets.length = 0;
    selectMode(h, ModeId.QUEST, 'e1m1-hangar');
    steps(room, 40);
    // The room streams generated terrain and has never heard of a keycard, so
    // it reports nothing rather than reporting the player count as the item
    // count — which is exactly what the campaign HUD printed before this test.
    expect(countPackets(h.socket, S2C_MODE.STATE)).toBe(0);
    room.stop();
  });

  it('reports humans and bodies the way the Deathmatch strip reads them', () => {
    const room = new Room({
      seed: 77, mode: GameMode.DEATHMATCH, botFill: 5, enemies: 0,
      eagerWorld: false, store: null, clock: () => 0,
    });
    const h = join(room, 'Human');
    selectMode(h, ModeId.DEATHMATCH);
    steps(room, 120);

    expect(room.humanCount).toBe(1);
    expect(room.sim.players.length).toBeGreaterThan(1);
    // `b` is humans and `bTotal` is bodies; the strip renders "1+N in match".
    const state = room.status();
    expect(state.humans).toBe(1);
    expect(state.modeKey).toBe('deathmatch');
    room.stop();
  });
});


/**
 * 6. Leaving Quest for any other mode must not bury the player in the ground.
 *
 * This was a real, shipped-for-minutes regression and the 1462-test suite was
 * blind to it. `onModeSelect` cleared the authored-level spawn anchor AFTER
 * calling `clearAuthoredLevel()` — but that call regenerates the world and
 * respawns every member, and `Sim.spawnPlayer` reads
 * `spawnAnchor ?? world.pickSpawn()`. So everyone was respawned onto the Quest
 * level's authored player start, which the freshly generated terrain had since
 * filled in solid: buried, unable to move, on the most ordinary navigation path
 * in the game (Quest → menu → Horde).
 *
 * The assertion is deliberately about the WORLD, not about a coordinate: a
 * spawn is only valid if the body's own cells are not solid. A test that
 * hard-coded the expected position would have passed straight through this bug.
 */
/*
 * NOT TESTED HERE, DELIBERATELY — see docs/BUGS-FOUND.md §3.
 *
 * The "buried in the ground after Quest -> Horde" regression is an ordering bug
 * in `Room.onModeSelect`, and it is NOT reproducible at this layer. Without the
 * real `LevelLibrary`, `selectMode(h, ModeId.QUEST, 'e1m1-hangar')` never stamps
 * a level, so `clearAuthoredLevel()` returns at its first line, no respawn ever
 * happens, and every assertion about where the player lands is vacuous.
 *
 * Three drafts of a test were written here and all three passed with the bug
 * still in the tree — asserting the symptom, then the cleared anchor, then the
 * anchor observed at spawn time. Each was green in both directions, which makes
 * them worse than nothing: they would have certified the bug as fixed.
 *
 * Coverage for this belongs in an integration test that boots the real server
 * with real levels loaded. Until that exists, the evidence for the fix is the
 * counterfactual recorded in docs/BUGS-FOUND.md.
 */
