/**
 * DOOMCRAFT — simulation and network model tests.
 *
 * The four load-bearing claims:
 *   1. client prediction and the server agree after 200 identical inputs,
 *   2. lag compensation rewinds to the exact recorded history frame,
 *   3. a client claiming 3x speed gets ~1x of movement,
 *   4. a block edit beyond reach is refused.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_SOLID,
  BlockAction,
  BlockId,
  CHUNK_HEIGHT,
  GameMode,
  PLAYER_HEIGHT,
  PacketWriter,
  REACH_BREAK,
  S2C,
  SPEED_RUN,
  TICK_MS,
  encodeBlockEdit,
  encodeHello,
  encodeInput,
} from '@doomcraft/shared';
import { Room } from './room.js';
import { EditResult } from './sim.js';
import { LAG_HISTORY, PlayerEntity, createMoveState, moveStep, sampleHistory } from './sim.js';
import type { NetTransport } from './net.js';
import { NavField } from './bots.js';
import {
  MemoryStore,
  PERSIST_VERSION,
  createProfile,
  migrateProfile,
  serialiseProfile,
} from './persistence.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

class FakeSocket implements NetTransport {
  open = true;
  bytesSent = 0;
  chunkCount = 0;
  /** Non-chunk packets, so a test can assert on protocol traffic cheaply. */
  readonly packets: Uint8Array[] = [];

  get isOpen(): boolean { return this.open; }
  get bufferedAmount(): number { return 0; }

  send(data: Uint8Array): void {
    this.bytesSent += data.length;
    if (data.length > 0 && data[0] === S2C.CHUNK) { this.chunkCount++; return; }
    if (this.packets.length < 4096) this.packets.push(data.slice());
  }

  close(): void { this.open = false; }
}

interface Client {
  socket: FakeSocket;
  conn: ReturnType<Room['join']>;
  player: PlayerEntity;
  seq: number;
  writer: PacketWriter;
}

function makeRoom(seed = 12345, overrides: Partial<ConstructorParameters<typeof Room>[0]> = {}): Room {
  return new Room({
    seed,
    mode: GameMode.SANDBOX,
    botFill: 0,
    enemies: 0,
    eagerWorld: false,
    store: null,
    clock: () => 0,
    ...overrides,
  });
}

function join(room: Room, name: string): Client {
  const socket = new FakeSocket();
  const conn = room.join(socket);
  const writer = new PacketWriter(256);
  encodeHello(writer, name, 0, 0);
  room.receive(conn, writer.copy());
  const player = room.sim.getPlayer(conn.playerId);
  expect(player).toBeDefined();
  return { socket, conn, player: player as PlayerEntity, seq: 0, writer };
}

function sendInput(
  room: Room, c: Client, dtMs: number,
  yaw: number, pitch: number, buttons: number, moveX: number, moveZ: number, slot = 0,
): void {
  c.seq++;
  encodeInput(c.writer, c.seq, dtMs, yaw, pitch, buttons, moveX, moveZ, slot);
  room.receive(c.conn, c.writer.copy());
}

/** Find a level, dry, lava-free patch so a movement test cannot fall off a cliff. */
function findFlatSpot(room: Room): { x: number; y: number; z: number } {
  const world = room.world;
  let best: { x: number; y: number; z: number } | null = null;
  let bestVariance = Infinity;
  for (let z = -40; z <= 40; z += 4) {
    for (let x = -40; x <= 40; x += 4) {
      const centre = world.standableY(x, z);
      if (centre < 0) continue;
      let variance = 0;
      let ok = true;
      for (let dz = -6; dz <= 6 && ok; dz += 2) {
        for (let dx = -6; dx <= 6 && ok; dx += 2) {
          const h = world.surfaceY(x + dx, z + dz);
          if (h < 1) { ok = false; break; }
          const ground = world.getBlock(x + dx, h, z + dz);
          if (ground === BlockId.LAVA || ground === BlockId.WATER) { ok = false; break; }
          if (world.getBlock(x + dx, h + 1, z + dz) !== BlockId.AIR) { ok = false; break; }
          const d = h - (centre - 1);
          variance += d * d;
        }
      }
      if (!ok) continue;
      if (variance < bestVariance) {
        bestVariance = variance;
        best = { x: x + 0.5, y: centre, z: z + 0.5 };
      }
      if (bestVariance === 0) break;
    }
  }
  expect(best, 'the arena should contain at least one flat standable patch').not.toBeNull();
  return best as { x: number; y: number; z: number };
}

/** Any water or lava voxel in the generated world, for the unbreakable test. */
function findLiquid(room: Room): { x: number; y: number; z: number } | null {
  for (let z = -96; z <= 96; z += 3) {
    for (let x = -96; x <= 96; x += 3) {
      for (let y = 8; y <= 30; y++) {
        const id = room.world.getBlock(x, y, z);
        if (id === BlockId.WATER || id === BlockId.LAVA) return { x, y, z };
      }
    }
  }
  return null;
}

/**
 * Find a straight, level, obstacle-free run of `length` blocks and the yaw that
 * follows it.
 *
 * The arena is a Doom level, not a plain: height is terraced in 3-block risers
 * and every arena carries cover, so "flat 13x13 patch, now sprint 19 m north"
 * is not a safe assumption — it walks into a wall. A movement-speed test has to
 * pick its lane first.
 */
function findRunway(room: Room, length: number): { x: number; y: number; z: number; yaw: number } {
  const world = room.world;
  // yaw -> unit forward, matching anglesToForward: forward = (-sin, 0, -cos).
  const dirs = [
    { yaw: 0, dx: 0, dz: -1 },
    { yaw: Math.PI, dx: 0, dz: 1 },
    { yaw: Math.PI / 2, dx: -1, dz: 0 },
    { yaw: -Math.PI / 2, dx: 1, dz: 0 },
  ];
  for (let z = -96; z <= 96; z += 2) {
    for (let x = -96; x <= 96; x += 2) {
      const centre = world.standableY(x, z);
      if (centre < 0) continue;
      for (const d of dirs) {
        let ok = true;
        // Against the PREVIOUS step, not against the start. Measuring from the
        // start accepted a two-block crate eight metres down the lane — its
        // standable surface is +1 from the floor either side of it, so the
        // window was satisfied by a wall the runner cannot step over.
        let prev = centre;
        for (let i = 1; i <= length && ok; i++) {
          let mid = prev;
          for (let w = -1; w <= 1 && ok; w++) {
            const px = x + d.dx * i + (d.dx === 0 ? w : 0);
            const pz = z + d.dz * i + (d.dz === 0 ? w : 0);
            const y = world.standableY(px, pz);
            if (y < 0 || Math.abs(y - prev) > 1) ok = false;
            if (w === 0) mid = y;
          }
          prev = mid;
        }
        if (ok) return { x: x + 0.5, y: centre, z: z + 0.5, yaw: d.yaw };
      }
    }
  }
  throw new Error(`no clear ${length}-block runway in the arena`);
}

function placeAt(p: PlayerEntity, spot: { x: number; y: number; z: number; yaw?: number }): void {
  p.pos[0] = spot.x; p.pos[1] = spot.y; p.pos[2] = spot.z;
  p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
  p.yaw = spot.yaw ?? 0; p.pitch = 0;
  p.onGround = true;
  p.crouching = false;
  p.height = PLAYER_HEIGHT;
  p.jumpCooldown = 0;
  p.coyote = 0;
  p.jumpBuffer = 0;
  p.spawnProtectUntilMs = Number.POSITIVE_INFINITY;
  p.health = 100;
}

/** The exact command stream both sides replay. Values sit on the wire grid. */
function commandAt(i: number): { moveX: number; moveZ: number; buttons: number; yaw: number } {
  const moveX = Math.round(Math.cos(i * 0.11) * 127) / 127;
  const moveZ = Math.round(Math.sin(i * 0.15) * 127) / 127;
  const buttons = i % 37 === 0 ? 4 /* BTN_JUMP */ : 0;
  return { moveX, moveZ, buttons, yaw: 0 };
}

/* ------------------------------------------------------------------------ *
 * 1. Prediction agrees with the server
 * ------------------------------------------------------------------------ */

describe('client prediction vs authoritative simulation', () => {
  it('agrees on position after 200 identical inputs (< 1 cm drift)', () => {
    const room = makeRoom(0xd00d);
    const client = join(room, 'Predictor');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);

    // The predictor: the client's own MoveState, driven by the very same
    // `moveStep` the server runs, against the same voxels.
    const predicted = createMoveState();
    predicted.pos[0] = spot.x; predicted.pos[1] = spot.y; predicted.pos[2] = spot.z;
    predicted.onGround = true;
    predicted.height = PLAYER_HEIGHT;

    const DT = 16;
    const TOTAL = 200;
    let sent = 0;
    for (let tick = 0; tick < 90 && sent < TOTAL; tick++) {
      for (let k = 0; k < 3 && sent < TOTAL; k++) {
        const c = commandAt(sent);
        sendInput(room, client, DT, c.yaw, 0, c.buttons, c.moveX, c.moveZ);
        sent++;
      }
      room.step();
    }
    // Drain whatever is still queued.
    for (let tick = 0; tick < 40 && client.conn.qCount > 0; tick++) room.step();

    for (let i = 0; i < TOTAL; i++) {
      const c = commandAt(i);
      predicted.yaw = c.yaw;
      moveStep(predicted, c.moveX, c.moveZ, c.buttons, DT / 1000, room.world);
    }

    expect(client.player.lastInputSeq).toBe(TOTAL);
    expect(client.conn.qCount).toBe(0);
    expect(client.player.dead).toBe(false);

    const dx = predicted.pos[0] - client.player.pos[0];
    const dy = predicted.pos[1] - client.player.pos[1];
    const dz = predicted.pos[2] - client.player.pos[2];
    const drift = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(drift).toBeLessThan(0.01);
    room.stop();
  });

  it('reproduces the same path from the same start with no world changes', () => {
    const room = makeRoom(777);
    const spot = findFlatSpot(room);
    const a = createMoveState();
    const b = createMoveState();
    for (const m of [a, b]) {
      m.pos[0] = spot.x; m.pos[1] = spot.y; m.pos[2] = spot.z;
      m.onGround = true;
    }
    for (let i = 0; i < 120; i++) {
      const c = commandAt(i);
      a.yaw = c.yaw; b.yaw = c.yaw;
      moveStep(a, c.moveX, c.moveZ, c.buttons, 0.016, room.world);
      moveStep(b, c.moveX, c.moveZ, c.buttons, 0.016, room.world);
    }
    expect(a.pos[0]).toBe(b.pos[0]);
    expect(a.pos[1]).toBe(b.pos[1]);
    expect(a.pos[2]).toBe(b.pos[2]);
    room.stop();
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Lag compensation
 * ------------------------------------------------------------------------ */

describe('lag compensation', () => {
  it('rewinds to the exact frame that was recorded at that time', () => {
    const p = new PlayerEntity();
    p.reset();
    const out = new Float64Array(4);

    // 20 frames, 50 ms apart, moving 1 m per frame along +x.
    for (let i = 0; i < 20; i++) {
      p.pos[0] = i;
      p.pos[1] = 40;
      p.pos[2] = -i * 0.5;
      p.pushHistory(i * TICK_MS);
    }

    // Sampling exactly on a recorded stamp returns that frame untouched.
    for (let i = 0; i < 20; i++) {
      expect(sampleHistory(p, i * TICK_MS, out)).toBe(true);
      expect(out[0]).toBeCloseTo(i, 6);
      expect(out[2]).toBeCloseTo(-i * 0.5, 6);
    }

    // Halfway between two frames interpolates.
    sampleHistory(p, 5 * TICK_MS + TICK_MS / 2, out);
    expect(out[0]).toBeCloseTo(5.5, 6);

    // Before the oldest and after the newest clamp instead of extrapolating.
    sampleHistory(p, -10_000, out);
    expect(out[0]).toBeCloseTo(0, 6);
    sampleHistory(p, 10_000, out);
    expect(out[0]).toBeCloseTo(19, 6);
  });

  it('keeps exactly LAG_HISTORY frames and drops the oldest', () => {
    const p = new PlayerEntity();
    p.reset();
    const out = new Float64Array(4);
    for (let i = 0; i < LAG_HISTORY * 2; i++) {
      p.pos[0] = i;
      p.pushHistory(i * TICK_MS);
    }
    expect(p.histCount).toBe(LAG_HISTORY);
    const oldestFrame = LAG_HISTORY * 2 - LAG_HISTORY;
    sampleHistory(p, 0, out);
    expect(out[0]).toBeCloseTo(oldestFrame, 6);
  });

  it('rewinding a live simulation lands on the position from that tick', () => {
    const room = makeRoom(4242);
    const client = join(room, 'Target');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);

    const stamps: Array<{ t: number; x: number; z: number }> = [];
    for (let tick = 0; tick < 24; tick++) {
      sendInput(room, client, 50, 0, 0, 0, 0, 1);
      room.step();
      stamps.push({ t: room.sim.nowMs, x: client.player.pos[0], z: client.player.pos[2] });
    }

    const out = new Float64Array(4);
    // 200 ms of rewind must land on the frame from four ticks ago.
    const target = stamps[stamps.length - 5];
    expect(sampleHistory(client.player, target.t, out)).toBe(true);
    expect(out[0]).toBeCloseTo(target.x, 4);
    expect(out[2]).toBeCloseTo(target.z, 4);
    // And it must NOT be where the player is now.
    expect(Math.abs(out[2] - client.player.pos[2])).toBeGreaterThan(0.2);
    room.stop();
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Speed hacking
 * ------------------------------------------------------------------------ */

describe('anti-cheat: input time budget', () => {
  it('a client claiming 3x speed only gets about 1x of movement', () => {
    const room = makeRoom(909);
    const honest = join(room, 'Honest');
    const cheater = join(room, 'Cheater');
    // 40 ticks of running is ~19 m, so the lane has to be at least that long.
    const spot = findRunway(room, 24);
    placeAt(honest.player, spot);
    placeAt(cheater.player, spot);

    const startX = spot.x;
    const startZ = spot.z;
    const TICKS = 40;
    for (let tick = 0; tick < TICKS; tick++) {
      // Honest: three 16 ms commands per 50 ms tick — real time.
      for (let k = 0; k < 3; k++) sendInput(room, honest, 16, spot.yaw, 0, 0, 0, 1);
      // Cheat: nine, i.e. three seconds of physics per second of wall clock.
      for (let k = 0; k < 9; k++) sendInput(room, cheater, 16, spot.yaw, 0, 0, 0, 1);
      room.step();
    }

    const honestDist = Math.hypot(honest.player.pos[0] - startX, honest.player.pos[2] - startZ);
    const cheatDist = Math.hypot(cheater.player.pos[0] - startX, cheater.player.pos[2] - startZ);

    // Sanity: the honest client actually moved at roughly running speed.
    const seconds = (TICKS * TICK_MS) / 1000;
    expect(honestDist).toBeGreaterThan(SPEED_RUN * seconds * 0.5);

    // The cheat buys at most the INPUT_TIME_SCALE headroom, not 3x.
    expect(cheatDist).toBeLessThan(honestDist * 1.25);
    expect(cheater.conn.stats.droppedInputs).toBeGreaterThan(0);
    expect(honest.conn.stats.droppedInputs).toBe(0);
    room.stop();
  });

  it('clamps an oversized dt and an out-of-range move vector', () => {
    const room = makeRoom(31337);
    const client = join(room, 'Liar');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);

    // dtMs 5000 and a move vector of length 3 — both nonsense.
    for (let tick = 0; tick < 10; tick++) {
      sendInput(room, client, 5000, 0, 0, 0, 0, 1);
      room.step();
    }
    const dist = Math.hypot(client.player.pos[0] - spot.x, client.player.pos[2] - spot.z);
    // 10 ticks of 50 ms at 9.5 m/s is under 5 m, whatever the client claimed.
    expect(dist).toBeLessThan(SPEED_RUN * 0.5 * 1.4);
    expect(client.conn.stats.violations).toBeGreaterThan(0);
    room.stop();
  });

  it('ignores replayed and out-of-order input sequences', () => {
    const room = makeRoom(5150);
    const client = join(room, 'Replayer');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);

    const w = new PacketWriter(64);
    for (let i = 0; i < 20; i++) {
      // Always sequence 1: only the first one may count.
      encodeInput(w, 1, 16, 0, 0, 0, 0, 1, 0);
      room.receive(client.conn, w.copy());
    }
    room.step();
    expect(client.conn.stats.appliedInputs).toBe(1);
    expect(client.conn.stats.droppedInputs).toBe(19);
    room.stop();
  });
});

/* ------------------------------------------------------------------------ *
 * 4. Block edits
 * ------------------------------------------------------------------------ */

describe('block edit validation', () => {
  it('rejects an edit beyond reach and accepts one inside it', () => {
    const room = makeRoom(2468);
    const client = join(room, 'Builder');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    const p = client.player;

    const bx = Math.floor(spot.x);
    const bz = Math.floor(spot.z);
    const groundY = room.world.surfaceY(bx, bz);

    // Far away: well past REACH_BREAK in a straight line.
    const farX = bx + Math.ceil(REACH_BREAK) + 6;
    const before = room.world.getBlock(farX, groundY, bz);
    expect(room.sim.requestEdit(p, BlockAction.BREAK, farX, groundY, bz, 0, 1))
      .toBe(EditResult.OUT_OF_REACH);
    expect(room.world.getBlock(farX, groundY, bz)).toBe(before);

    // Right under the player's feet: comfortably inside reach.
    expect(room.sim.requestEdit(p, BlockAction.BREAK, bx, groundY, bz, 0, 2))
      .toBe(EditResult.OK);
    expect(room.world.getBlock(bx, groundY, bz)).toBe(BlockId.AIR);
    expect(p.blocksBroken).toBe(1);
    room.stop();
  });

  it('rejects an out-of-reach edit that arrives over the wire and reports it', () => {
    const room = makeRoom(1357);
    const client = join(room, 'Reacher');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);

    const bx = Math.floor(spot.x) + 40;
    const bz = Math.floor(spot.z);
    const by = Math.max(1, room.world.surfaceY(bx, bz));
    const before = room.world.getBlock(bx, by, bz);

    const w = new PacketWriter(64);
    encodeBlockEdit(w, 1, BlockAction.BREAK, bx, by, bz, 0);
    room.receive(client.conn, w.copy());

    expect(room.world.getBlock(bx, by, bz)).toBe(before);
    expect(client.conn.stats.rejectedEdits).toBe(1);
    // The client is told the truth about that voxel so its prediction unwinds.
    const correction = client.socket.packets.find((p) => p[0] === S2C.BLOCK_DELTA);
    expect(correction).toBeDefined();
    room.stop();
  });

  it('refuses unbreakable blocks, out-of-world targets and occupied placements', () => {
    const room = makeRoom(80085);
    const client = join(room, 'Vandal');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    const p = client.player;
    const bx = Math.floor(spot.x);
    const bz = Math.floor(spot.z);

    // The bedrock floor sits at y = 0, below the editable range entirely.
    p.pos[1] = 1;
    expect(room.sim.requestEdit(p, BlockAction.BREAK, bx, 0, bz, 0, 1)).toBe(EditResult.OUT_OF_WORLD);
    expect(room.sim.requestEdit(p, BlockAction.BREAK, bx, CHUNK_HEIGHT + 3, bz, 0, 2)).toBe(EditResult.OUT_OF_WORLD);

    // Liquids have negative hardness: they cannot be dug out.
    const liquid = findLiquid(room);
    if (liquid) {
      p.pos[0] = liquid.x + 0.5; p.pos[1] = liquid.y + 1; p.pos[2] = liquid.z + 0.5;
      expect(room.sim.requestEdit(p, BlockAction.BREAK, liquid.x, liquid.y, liquid.z, 0, 5))
        .toBe(EditResult.UNBREAKABLE);
    }

    placeAt(p, spot);
    const groundY = room.world.surfaceY(bx, bz);
    expect(BLOCK_SOLID[room.world.getBlock(bx, groundY, bz)]).toBe(1);
    // Placing into a solid voxel is refused.
    expect(room.sim.requestEdit(p, BlockAction.PLACE, bx, groundY, bz, BlockId.STONE, 3))
      .toBe(EditResult.OCCUPIED);
    // And a block may not appear inside the player standing there.
    expect(room.sim.requestEdit(p, BlockAction.PLACE, bx, groundY + 1, bz, BlockId.STONE, 4))
      .toBe(EditResult.BLOCKED_BY_ENTITY);
    room.stop();
  });

  it('rate limits a client that spams edits', () => {
    const room = makeRoom(24680);
    const client = join(room, 'Spammer');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    const p = client.player;
    const bx = Math.floor(spot.x);
    const bz = Math.floor(spot.z);
    const y = room.world.surfaceY(bx, bz);

    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = room.sim.requestEdit(p, BlockAction.BREAK, bx + (i % 5), y - (i % 3), bz + ((i / 5) | 0) % 5, 0, i + 1);
      if (r === EditResult.RATE_LIMITED) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    room.stop();
  });
});

/* ------------------------------------------------------------------------ *
 * Room, world and bots
 * ------------------------------------------------------------------------ */

describe('room lifecycle', () => {
  it('is playable immediately: bots are present and the spawn area exists', () => {
    const room = new Room({
      seed: 991, mode: GameMode.DEATHMATCH, botFill: 6, enemies: 2,
      eagerWorld: false, store: null, clock: () => 0,
    });
    // A few ticks is all the bot fill needs; no 25 second matchmaking wait.
    for (let i = 0; i < 60; i++) room.step();
    expect(room.sim.players.length).toBeGreaterThanOrEqual(4);
    expect(room.world.generatedChunks).toBeGreaterThan(20);

    const client = join(room, 'Human');
    expect(client.player).toBeDefined();
    expect(room.humanCount).toBe(1);
    for (let i = 0; i < 20; i++) room.step();
    // A human never displaces the population: bots make room instead.
    expect(room.sim.players.length).toBeLessThanOrEqual(6);
    expect(room.status().state).toBe('live');
    room.stop();
  });

  it('streams chunks to a joining client and finishes the world', () => {
    const room = makeRoom(31415);
    const client = join(room, 'Loader');
    for (let i = 0; i < 200; i++) room.step();
    expect(client.socket.chunkCount).toBeGreaterThan(100);
    expect(room.world.isComplete).toBe(true);
    room.stop();
  });

  it('carves terrain with a rocket and tells the client about it', () => {
    const room = makeRoom(6162);
    const client = join(room, 'Rocketeer');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    for (let i = 0; i < 30; i++) room.step();       // let the chunks stream out

    const before = room.world.editSerial;
    // Fire a rocket straight down at the floor.
    const p = client.player;
    p.weaponMask = 0xff;
    p.weapon = 3;                                    // WeaponId.ROCKET
    p.mag[3] = 5;
    p.nextFireMs = 0;
    p.pitch = -Math.PI / 2;
    room.sim.tryFire(p, 3);
    for (let i = 0; i < 20; i++) room.step();

    expect(room.world.editSerial).toBeGreaterThan(before);
    const deltas = client.socket.packets.filter((pk) => pk[0] === S2C.BLOCK_DELTA);
    expect(deltas.length).toBeGreaterThan(0);
    room.stop();
  });

  it('emits damage and kill events when a player dies', () => {
    const room = makeRoom(5959);
    const attacker = join(room, 'Attacker');
    const victim = join(room, 'Victim');
    const spot = findFlatSpot(room);
    placeAt(attacker.player, spot);
    placeAt(victim.player, { x: spot.x + 3, y: spot.y, z: spot.z });
    victim.player.spawnProtectUntilMs = 0;

    room.sim.damagePlayer(victim.player, attacker.player.id, 250, 0, 0, 1, 0, 0);
    expect(victim.player.dead).toBe(true);
    expect(attacker.player.kills).toBe(1);
    room.step();

    const kills = attacker.socket.packets.filter((p) => p[0] === S2C.KILL);
    expect(kills.length).toBe(1);
    const dmg = victim.socket.packets.filter((p) => p[0] === S2C.DAMAGE);
    expect(dmg.length).toBeGreaterThan(0);
    room.stop();
  });

  it('respawns a dead player after the delay', () => {
    const room = makeRoom(1010);
    const client = join(room, 'Phoenix');
    client.player.spawnProtectUntilMs = 0;
    room.sim.damagePlayer(client.player, 0, 500, 0, 0, 0, 1, 0);
    expect(client.player.dead).toBe(true);
    for (let i = 0; i < 60; i++) room.step();
    expect(client.player.dead).toBe(false);
    expect(client.player.health).toBe(100);
    room.stop();
  });
});

describe('doom mechanics', () => {
  it('a rocket at your feet launches you and hurts but does not kill', () => {
    const room = makeRoom(70707);
    const client = join(room, 'Jumper');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    for (let i = 0; i < 20; i++) room.step();
    placeAt(client.player, spot);

    const p = client.player;
    p.weaponMask = 0xff;
    p.weapon = 3;                                   // WeaponId.ROCKET
    p.mag[3] = 5;
    p.nextFireMs = 0;
    p.spawnProtectUntilMs = 0;
    p.pitch = -Math.PI / 2;                          // straight down
    room.sim.tryFire(p, 3);
    for (let i = 0; i < 6; i++) room.step();

    expect(p.dead).toBe(false);
    expect(p.health).toBeLessThan(100);
    // A rocket jump is worth real height, not a hop.
    expect(p.pos[1]).toBeGreaterThan(spot.y + 1.0);
    // And it carved the ground it went off.
    expect(room.world.getBlock(Math.floor(spot.x), Math.floor(spot.y) - 1, Math.floor(spot.z)))
      .toBe(BlockId.AIR);
    room.stop();
  });

  it('being killed by a demon is not scored as a suicide', () => {
    const room = makeRoom(80808);
    const client = join(room, 'Snack');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    client.player.spawnProtectUntilMs = 0;
    client.player.kills = 3;

    // attackerId 0 is how a monster, lava or a long fall deals damage.
    room.sim.damagePlayer(client.player, 0, 500, 0, 0, 0, 1, 0);
    expect(client.player.dead).toBe(true);
    expect(client.player.deaths).toBe(1);
    expect(client.player.kills).toBe(3);
    room.stop();
  });

  it('armour absorbs its share and then stops', () => {
    const room = makeRoom(90909);
    const client = join(room, 'Armoured');
    const p = client.player;
    p.spawnProtectUntilMs = 0;
    p.health = 100;
    p.armor = 100;
    room.sim.damagePlayer(p, 0, 100, 0, 0, 0, 1, 0);
    // ARMOR_ABSORB is 0.33: 33 to the vest, 67 to the ribs.
    expect(p.armor).toBeCloseTo(67, 3);
    expect(p.health).toBeCloseTo(33, 3);
    room.stop();
  });
});

describe('monsters', () => {
  it('spawns Doom archetypes that move toward the player', () => {
    const room = new Room({
      seed: 424242, mode: GameMode.HORDE, botFill: 0, enemies: 4,
      eagerWorld: false, store: null, clock: () => 0,
    });
    const client = join(room, 'Bait');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    for (let i = 0; i < 40; i++) { sendInput(room, client, 50, 0, 0, 0, 0, 0); room.step(); }

    const slot = room.spawnMonster(0 /* IMP */, spot.x + 26, spot.y + 1, spot.z);
    expect(slot).toBeGreaterThanOrEqual(0);
    const startDist = Math.hypot(room.sim.entX[slot] - spot.x, room.sim.entZ[slot] - spot.z);

    for (let i = 0; i < 80; i++) { sendInput(room, client, 50, 0, 0, 0, 0, 0); room.step(); }
    if (room.sim.entActive[slot] === 1) {
      const endDist = Math.hypot(room.sim.entX[slot] - client.player.pos[0], room.sim.entZ[slot] - client.player.pos[2]);
      expect(endDist).toBeLessThan(startDist);
    }
    room.stop();
  });

  it('builds a navigation field that reaches the player', () => {
    const room = makeRoom(777001);
    for (let i = 0; i < 200; i++) room.step();       // finish the world
    const client = join(room, 'Beacon');
    const spot = findFlatSpot(room);
    placeAt(client.player, spot);
    for (let i = 0; i < 10; i++) { sendInput(room, client, 50, 0, 0, 0, 0, 0); room.step(); }

    const nav = room.monsters.nav;
    expect(nav.distanceAt(spot.x, spot.z)).toBe(0);
    const dir = new Float64Array(2);
    let reachable = 0;
    for (let r = 4; r <= 24; r += 4) {
      if (nav.distanceAt(spot.x + r, spot.z) >= 0) reachable++;
    }
    expect(reachable).toBeGreaterThan(0);
    expect(nav.direction(spot.x + 8, spot.z, dir) || nav.distanceAt(spot.x + 8, spot.z) <= 0).toBe(true);
    room.stop();
  });
});

describe('world generation', () => {
  it('is deterministic for a seed', () => {
    const a = makeRoom(0xbeef);
    const b = makeRoom(0xbeef);
    const ca = a.world.ensureChunk(0, 0);
    const cb = b.world.ensureChunk(0, 0);
    expect(ca.length).toBe(cb.length);
    let diff = 0;
    for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) diff++;
    expect(diff).toBe(0);
    a.stop(); b.stop();
  });

  it('lays down bedrock and keeps the arena sealed', () => {
    const room = makeRoom(0xf00d);
    expect(room.world.getBlock(0, 0, 0)).toBe(BlockId.BEDROCK);
    expect(room.world.getBlock(0, -1, 0)).toBe(BlockId.BEDROCK);
    expect(room.world.getBlock(100000, 30, 0)).toBe(BlockId.BEDROCK);
    expect(room.world.getBlock(0, CHUNK_HEIGHT + 1, 0)).toBe(BlockId.AIR);
    room.stop();
  });

  it('keeps the nav grid dimensions sane', () => {
    expect(NavField.cellOf(1e9, 0)).toBe(-1);
    expect(NavField.cellOf(0, 0)).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------------ */

describe('persistence', () => {
  it('migrates a version 1 record to the current schema', async () => {
    const legacy = {
      version: 1,
      deviceId: 'legacy-device-01',
      progress: { name: 'Old', xp: 900, kills: 12 },
      settings: { fov: 103, hitMarkers: false },
      entitlements: true,
    };
    const migrated = migrateProfile(legacy, 'legacy-device-01');
    expect(migrated.version).toBe(PERSIST_VERSION);
    expect(migrated.progress.name).toBe('Old');
    expect(migrated.progress.xp).toBe(900);
    expect(migrated.progress.level).toBeGreaterThan(1);
    expect(migrated.settings.fov).toBe(103);
    expect(migrated.settings.hitMarkers).toBe(false);
    expect(migrated.entitlements.adsRemoved).toBe(true);
    expect(migrated.settings.showAds).toBe(false);
    expect(migrated.loadout.weapons.length).toBeGreaterThan(0);
    expect(migrated.stats.weaponKills.length).toBeGreaterThan(0);
  });

  it('rejects junk without throwing', () => {
    const p = migrateProfile({ progress: 'nope', settings: 42, stats: null }, 'junk-device-1');
    expect(p.progress.xp).toBe(0);
    expect(p.settings.fov).toBeGreaterThan(0);
  });

  /*
   * The two below are the ones that actually police a schema bump. The v1 test
   * above passes on ANY 3->4 step, including one that drops every field it was
   * supposed to add, because all it reads is `migrated.version`. A version
   * number is not evidence that the data survived.
   */

  it('gives a version 3 record an empty economy section and keeps its xp', () => {
    const v3 = {
      version: 3,
      deviceId: 'v3-device-0001',
      progress: { name: 'Sarge', xp: 900, kills: 12 },
      stats: { matches: 4, kills: 12, secondsPlayed: 600 },
      entitlements: { adsRemoved: false, product: null, receipt: null, purchasedMs: 0 },
    };
    const migrated = migrateProfile(v3, 'v3-device-0001');

    expect(migrated.version).toBe(4);
    expect(migrated.economy.scrap).toBe(0);
    expect(migrated.economy.lifetimeScrap).toBe(0);
    expect(migrated.economy.day).toBe('');
    // Nothing that was already there may be collateral damage of the bump.
    expect(migrated.progress.xp).toBe(900);
    expect(migrated.progress.kills).toBe(12);
    expect(migrated.stats.matches).toBe(4);
    expect(migrated.stats.secondsPlayed).toBe(600);
  });

  /**
   * THE ONE THAT CATCHES THE WHITELIST TRAP.
   *
   * `migrateProfile` does not patch the object it is given — it rebuilds a
   * fresh literal from `createProfile()` defaults and copies across only the
   * fields that literal names. So adding a `MIGRATIONS` step is a no-op on its
   * own: the step writes `raw.economy`, the literal never reads it, and every
   * balance in the fleet is silently zeroed on the next disk read while
   * `expect(migrated.version).toBe(PERSIST_VERSION)` stays green.
   *
   * Two passes, because one pass is what a profile gets on every single load.
   */
  it('round-trips a version 4 balance through repeated loads', () => {
    const v4 = {
      version: 4,
      deviceId: 'v4-device-0001',
      progress: { xp: 1200 },
      economy: { scrap: 500, lifetimeScrap: 4321, day: '2026-08-22', dayXp: 700, dayScrap: 90, dayMatches: 3 },
    };

    const once = migrateProfile(v4, 'v4-device-0001');
    expect(once.economy.scrap).toBe(500);
    expect(once.economy.lifetimeScrap).toBe(4321);
    expect(once.economy.day).toBe('2026-08-22');
    expect(once.economy.dayXp).toBe(700);
    expect(once.economy.dayScrap).toBe(90);
    expect(once.economy.dayMatches).toBe(3);

    // A load of what the last save wrote. This is the real shape: the file on
    // disk is the output of the previous migration, not the fixture above.
    const twice = migrateProfile(JSON.parse(JSON.stringify(serialiseProfile(once))), 'v4-device-0001');
    expect(twice.economy.scrap).toBe(500);
    expect(twice.economy.lifetimeScrap).toBe(4321);
    expect(twice.progress.xp).toBe(1200);
    expect(twice.version).toBe(PERSIST_VERSION);
  });

  it('clamps a stored balance instead of trusting the number on disk', () => {
    const p = migrateProfile({
      version: 4,
      economy: { scrap: -50, lifetimeScrap: Number.NaN, day: '2026-08-22-and-then-some', dayXp: 1e12 },
    }, 'v4-device-0002');
    expect(p.economy.scrap).toBe(0);
    expect(p.economy.lifetimeScrap).toBe(0);
    expect(p.economy.day).toBe('2026-08-22');
    expect(p.economy.dayXp).toBeLessThanOrEqual(6_000);
  });

  /**
   * The downgrade guard. `migrateProfile` stamps `PERSIST_VERSION` on
   * everything it reads, which is right for reading and destructive for
   * writing: without a bag for the fields it does not recognise, a v5 profile
   * opened once by a rolled-back v4 server comes back as a v4 profile with the
   * v5 fields gone from the player's account for good. `SaveFile._unknown` has
   * done this for the browser's local save since it shipped; profiles had
   * nothing, which is precisely how a rollback would have eaten every Scrap
   * balance this commit introduces.
   */
  it('carries a future version\'s fields through untouched instead of eating them', () => {
    const fromTheFuture = {
      version: 99,
      deviceId: 'future-device-01',
      progress: { xp: 10 },
      economy: { scrap: 7 },
      inventory: { items: ['skin.gold'], slots: 12 },
      seasonPass: 'season-4',
    };

    const read = migrateProfile(fromTheFuture, 'future-device-01');
    expect(read.version).toBe(PERSIST_VERSION);
    expect(read.economy.scrap).toBe(7);
    expect(read._unknown).toEqual({ inventory: { items: ['skin.gold'], slots: 12 }, seasonPass: 'season-4' });

    // And back out at the TOP level, where the newer build will look for it —
    // not nested inside a `_unknown` key it has never heard of.
    const written = serialiseProfile(read);
    expect(written.inventory).toEqual({ items: ['skin.gold'], slots: 12 });
    expect(written.seasonPass).toBe('season-4');
    expect(written._unknown).toBeUndefined();
    expect(written.version).toBe(PERSIST_VERSION);

    // Surviving two old builds in a row, which is what a bad week looks like.
    const again = serialiseProfile(migrateProfile(JSON.parse(JSON.stringify(written)), 'future-device-01'));
    expect(again.seasonPass).toBe('season-4');
  });

  it('never lets a carried unknown key overwrite a field this build owns', () => {
    const p = createProfile('shadow-device-01');
    p.progress.xp = 4242;
    p._unknown = { progress: { xp: 0 }, version: 1 };
    const written = serialiseProfile(p);
    expect((written.progress as { xp: number }).xp).toBe(4242);
    expect(written.version).toBe(PERSIST_VERSION);
  });

  it('grants the ad-free entitlement and never takes it from the client', async () => {
    const store = new MemoryStore();
    const p1 = await store.ensure('device-abcdef12');
    expect(p1.entitlements.adsRemoved).toBe(false);
    const p2 = await store.grantEntitlement('device-abcdef12', 'doomcraft.remove_ads', 'receipt-1');
    expect(p2.entitlements.adsRemoved).toBe(true);
    expect(p2.settings.showAds).toBe(false);
    const p3 = await store.grantEntitlement('device-abcdef12', 'not.a.product', null);
    expect(p3.entitlements.product).toBe('doomcraft.remove_ads');
  });

  it('links an account and only resolves it with the right secret', async () => {
    const store = new MemoryStore();
    await store.ensure('device-linkable1');
    const { secret } = await store.linkAccount('device-linkable1', 'account-1');
    expect(await store.resolveAccount('account-1', secret)).not.toBeNull();
    expect(await store.resolveAccount('account-1', 'wrong')).toBeNull();
    expect(await store.resolveAccount('nope', secret)).toBeNull();
  });
});
