/**
 * DOOMCRAFT — the reward path, end to end, on a real Room with a real store.
 *
 * `entitlementGuard.test.ts` already proves the guard decides correctly in
 * isolation. This file proves something different and, until now, untested:
 * that the guard is actually **in the path**. Every other room test in this
 * repo constructs a `Room` with `store: null`, so `persistMember` — the single
 * function that turns a match into XP — had zero end-to-end coverage. A payout
 * function nothing exercises is a payout function nobody knows the shape of.
 *
 * So every test here builds a Room with a real `MemoryStore` AND a real
 * `EntitlementGuard`, plays a round through `room.step()`, and then reads the
 * stored profile — the same object the HTTP profile API serves.
 *
 * The load-bearing one is "pays the same device once per round". Before the
 * guard was wired in, `endRound` paid every member and rebased their kill
 * counters but NOT `joinedMs`, and `onDisconnect` then called `persistMember`
 * again — so quitting during the 8 s end screen paid you a second full round.
 * Revert `room.ts` and that test reports `gamesPlayed === 2`.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  GameMode,
  PacketWriter,
  S2C,
  TICK_MS,
  XP_PER_KILL,
  XP_PER_MINUTE,
  XP_PER_WIN,
  encodeHello,
  encodeInput,
} from '@doomcraft/shared';
import { MatchType, SessionOrigin } from '@doomcraft/shared/trust';

import { Room, END_SCREEN_MS } from './room.js';
import {
  EntitlementGuard,
  RejectCode,
  SubmitterKind,
  emptyStats,
  toMatchResult,
} from './entitlementGuard.js';
import { JsonFileStore, MemoryStore } from './persistence.js';
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
    if (this.packets.length < 2048) this.packets.push(data.slice());
  }

  close(): void { this.open = false; }
}

interface Client {
  socket: FakeSocket;
  conn: ReturnType<Room['join']>;
  player: PlayerEntity;
  writer: PacketWriter;
  seq: number;
}

interface RoomSpec {
  store: MemoryStore | null;
  guard: EntitlementGuard | null;
  sessionOrigin?: SessionOrigin;
  sessionIntent?: MatchType;
  name?: string;
}

/**
 * A room shaped like the ones `index.ts` builds: server-hosted, a real store,
 * and (unless a test says otherwise) a real gate. No bots and no monsters, so
 * the only kills in the room are the ones a test puts there.
 */
function makeRoom(spec: RoomSpec): Room {
  return new Room({
    seed: 90210,
    mode: GameMode.DEATHMATCH,
    botFill: 0,
    enemies: 0,
    eagerWorld: false,
    clock: () => 0,
    name: spec.name ?? 'dm-public',
    store: spec.store,
    guard: spec.guard,
    sessionOrigin: spec.sessionOrigin,
    sessionIntent: spec.sessionIntent,
  });
}

/**
 * Attach and say HELLO — with the device id stamped on the connection FIRST,
 * because that is the real order: `index.ts` sets `conn.deviceId` from the
 * WebSocket query string before the socket has read a single byte, and the
 * room's participant set is written during HELLO.
 */
function join(room: Room, name: string, deviceId: string): Client {
  const socket = new FakeSocket();
  const conn = room.join(socket);
  conn.deviceId = deviceId;
  const writer = new PacketWriter(256);
  encodeHello(writer, name, 0, 0);
  room.receive(conn, writer.copy());
  const player = room.sim.getPlayer(conn.playerId);
  expect(player, 'HELLO did not produce a player').toBeDefined();
  return { socket, conn, player: player as PlayerEntity, writer, seq: 0 };
}

/**
 * Run whole ticks, keeping every client's connection alive.
 *
 * `NetHub.reapTimeouts` runs on every tick and drops a connection that has said
 * nothing for `CLIENT_TIMEOUT_MS` of ROOM time — which a multi-round test would
 * otherwise trip, disconnecting the player mid-test and paying them by the very
 * path under examination.
 */
function run(room: Room, clients: Client[], ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    if (i % 20 === 0) {
      for (const c of clients) {
        c.seq++;
        encodeInput(c.writer, c.seq, TICK_MS, 0, 0, 0, 0, 0, 0);
        room.receive(c.conn, c.writer.copy());
      }
    }
    room.step();
  }
}

/** End the round on the next tick, the way the match clock running out does. */
function endRoundNow(room: Room, clients: Client[]): void {
  room.timeLeftMs = 1;
  run(room, clients, 1);
}

/**
 * Wait for every queued profile write for this device.
 *
 * `persistMember` is fire-and-forget (`void this.persistMember(...)`), but its
 * `store.update` is enqueued synchronously on the store's per-device lock, so
 * queueing one more update behind it and awaiting that is a deterministic
 * barrier — no timers, no arbitrary tick counts.
 */
async function settled(store: MemoryStore, deviceId: string): Promise<void> {
  await store.update(deviceId, () => { /* barrier only */ });
}

/** What the room's own formula pays for this round. Unchanged by the guard. */
function expectedXp(kills: number, won: boolean, ticks: number): number {
  const seconds = (ticks * TICK_MS) / 1000;
  return Math.round(kills * XP_PER_KILL + (won ? XP_PER_WIN : 0) + (seconds / 60) * XP_PER_MINUTE);
}

const DEVICE = 'device-aaaa0001';
const OTHER_DEVICE = 'device-bbbb0002';
/** Ticks of play before the clock is forced out. One more tick ends the round. */
const PLAY_TICKS = 40;
const KILLS = 7;

/* ------------------------------------------------------------------------ *
 * 1. The money flows, and it flows through the guard
 * ------------------------------------------------------------------------ */

describe('a server-hosted public deathmatch', () => {
  it('pays XP through the guard, in the amount the room always paid', async () => {
    const store = new MemoryStore();
    const guard = new EntitlementGuard(() => 1_000);
    const room = makeRoom({ store, guard });

    const client = join(room, 'Marine', DEVICE);
    client.player.kills = KILLS;
    client.player.bestStreak = 4;

    run(room, [client], PLAY_TICKS);
    endRoundNow(room, [client]);
    await settled(store, DEVICE);

    const profile = await store.ensure(DEVICE);
    // The guard is the only producer of `MatchResult` now, so a non-zero xp
    // here is proof the submission was accepted — not merely that the old code
    // path still exists.
    expect(profile.progress.xp).toBe(expectedXp(KILLS, true, PLAY_TICKS + 1));
    expect(profile.progress.kills).toBe(KILLS);
    expect(profile.progress.wins).toBe(1);
    expect(profile.progress.gamesPlayed).toBe(1);
    expect(guard.status().accepted).toBe(1);
    expect(guard.status().rejected).toBe(0);
    // Nothing was stripped, so a healthy round writes no audit line at all.
    expect(guard.recent()).toEqual([]);
  });

  it('opens one ledger session per ROUND, named for the room and the round', () => {
    const store = new MemoryStore();
    const guard = new EntitlementGuard(() => 1_000);
    const room = makeRoom({ store, guard, name: 'dm~keyed' });

    const client = join(room, 'Marine', DEVICE);
    const record = guard.ledger.get(`dm~keyed#${room.round}`);

    expect(record, 'the room opened no session at all').not.toBeNull();
    expect(record?.participants.has(DEVICE)).toBe(true);
    expect(record?.trust.matchType).toBe(MatchType.PUBLIC);
    expect(record?.simulatedHere).toBe(true);
    run(room, [client], 2);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. THE ONE. One payout per device per round.
 * ------------------------------------------------------------------------ */

describe('the end-screen disconnect', () => {
  it('pays the same device once per round, not once per persistMember call', async () => {
    const store = new MemoryStore();
    const guard = new EntitlementGuard(() => 1_000);
    const room = makeRoom({ store, guard });

    const client = join(room, 'Marine', DEVICE);
    client.player.kills = KILLS;

    run(room, [client], PLAY_TICKS);
    endRoundNow(room, [client]);

    // The player closes the tab while the scoreboard is up. `onDisconnect` calls
    // `persistMember` a second time for a round that has already been settled.
    room.leave(client.conn);
    await settled(store, DEVICE);

    const profile = await store.ensure(DEVICE);
    expect(profile.progress.gamesPlayed).toBe(1);
    expect(profile.progress.kills).toBe(KILLS);
    expect(profile.progress.xp).toBe(expectedXp(KILLS, true, PLAY_TICKS + 1));
    expect(guard.status().accepted).toBe(1);

    // And the refusal is on the record rather than silently swallowed. The code
    // is ALREADY_SETTLED under this test's frozen clock; on a moving clock the
    // same submission lands after `closedMs` and reads SESSION_CLOSED. Either
    // way it is one line in the audit ring and zero extra XP.
    const audit = guard.recent();
    expect(audit).toHaveLength(1);
    expect(audit[0].code).toBe(RejectCode.ALREADY_SETTLED);
    expect(audit[0].deviceId).toBe(DEVICE);
  });

  it('pays a second round, because the session id carries the round number', async () => {
    const store = new MemoryStore();
    const guard = new EntitlementGuard(() => 1_000);
    const room = makeRoom({ store, guard });

    const client = join(room, 'Marine', DEVICE);
    client.player.kills = 2;
    run(room, [client], PLAY_TICKS);
    endRoundNow(room, [client]);

    // Sit through the end screen. `beginRound(true)` fires, which is the moment
    // a per-ROOM session id would have made round 2 a replay of round 1.
    run(room, [client], Math.ceil(END_SCREEN_MS / TICK_MS) + 2);
    expect(room.round).toBe(2);

    client.player.kills = 3;
    run(room, [client], PLAY_TICKS);
    endRoundNow(room, [client]);
    await settled(store, DEVICE);

    const profile = await store.ensure(DEVICE);
    expect(profile.progress.gamesPlayed).toBe(2);
    expect(profile.progress.kills).toBe(5);
    expect(guard.status().accepted).toBe(2);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. What the guard refuses, on the live room's own session
 * ------------------------------------------------------------------------ */

describe('a device the server never saw attach', () => {
  it('is refused for a session it was not in, however good its numbers look', () => {
    const store = new MemoryStore();
    const guard = new EntitlementGuard(() => 1_000);
    const room = makeRoom({ store, guard });

    const client = join(room, 'Marine', DEVICE);
    run(room, [client], 4);

    const verdict = guard.submit({
      sessionId: `${room.name}#${room.round}`,
      deviceId: OTHER_DEVICE,
      submittedBy: SubmitterKind.ROOM_SIM,
      xp: 100_000,
      stats: { ...emptyStats(), kills: 99, won: true },
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.code).toBe(RejectCode.NOT_A_PARTICIPANT);
    expect(verdict.violation).toBe(true);
    expect(toMatchResult(verdict)).toBeNull();
    expect(verdict.granted.xp).toBe(0);
  });
});

describe('a private room', () => {
  it('grants nothing, because the table says a coded room is unranked', async () => {
    const store = new MemoryStore();
    const guard = new EntitlementGuard(() => 1_000);
    const room = makeRoom({
      store,
      guard,
      name: 'dm~ABCD',
      sessionOrigin: SessionOrigin.SERVER_INVITE,
      sessionIntent: MatchType.PRIVATE,
    });

    const client = join(room, 'Marine', DEVICE);
    client.player.kills = KILLS;
    run(room, [client], PLAY_TICKS);
    endRoundNow(room, [client]);
    await settled(store, DEVICE);

    const profile = await store.ensure(DEVICE);
    expect(profile.progress.xp).toBe(0);
    expect(profile.progress.kills).toBe(0);
    expect(profile.progress.gamesPlayed).toBe(0);

    const audit = guard.recent();
    expect(audit).toHaveLength(1);
    expect(audit[0].code).toBe(RejectCode.GRANTS_NOTHING);
    expect(guard.status().accepted).toBe(0);
  });
});

describe('a room built without a gate', () => {
  it('writes nothing to a profile, even holding a real store', async () => {
    const store = new MemoryStore();
    const room = makeRoom({ store, guard: null });

    const client = join(room, 'Marine', DEVICE);
    client.player.kills = KILLS;
    run(room, [client], PLAY_TICKS);
    endRoundNow(room, [client]);
    await settled(store, DEVICE);

    // The browser worker's shape. `docs/ECONOMY.md` decision 1: a process that
    // cannot attest to a result may not pay for it, and "no guard" is exactly
    // that admission.
    const profile = await store.ensure(DEVICE);
    expect(profile.progress.xp).toBe(0);
    expect(profile.progress.gamesPlayed).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The store has to keep what the guard granted
 * ------------------------------------------------------------------------ */

describe('a payout landing while somebody reads the profile', () => {
  it('is not overwritten by the blank profile the reader was about to cache', async () => {
    // A COLD store, which is the shape that actually bites: the process has
    // just booted, nothing is cached, and the first match ends while the menu
    // fetches `/api/profile`. Both paths miss the cache, both go to disk, and
    // whichever writes the cache last used to win.
    const dir = mkdtempSync(joinPath(tmpdir(), 'dc-economy-store-'));
    const store = new JsonFileStore(dir);

    await Promise.all([
      store.update(DEVICE, (p) => { p.progress.gamesPlayed += 1; p.progress.xp += 400; }),
      store.ensure(DEVICE),
    ]);

    const profile = await store.ensure(DEVICE);
    expect(profile.progress.gamesPlayed).toBe(1);
    expect(profile.progress.xp).toBe(400);
    await store.close();
  });
});
