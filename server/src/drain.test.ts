/**
 * DOOMCRAFT — rooms are the deploy unit.
 *
 * The claim under test, from `docs/INFRASTRUCTURE.md` §6:
 *
 *   > New hosts start, old hosts are marked draining and accept no new rooms,
 *   > and existing matches run to completion. **Nobody is disconnected
 *   > mid-match, ever, because nothing a player is inside is ever restarted.**
 *
 * That is two properties and they pull in opposite directions, which is why
 * both are asserted against the same live object rather than separately:
 *
 *   - a draining host must create nothing new, and
 *   - a draining host must not touch what it already has.
 *
 * An implementation that satisfies only the first is a deploy that kicks
 * everybody; one that satisfies only the second is a rollout that never
 * finishes. The third property — the deadline — is what stops one AFK player in
 * a Builder world pinning an old binary online for a week.
 *
 * These drive the REAL `ModeRouter` with a fake room, because the room table
 * and its key scheme are exactly what the drain has to be correct about; the
 * simulation inside a room is not.
 */

import { describe, expect, it } from 'vitest';

import { ModeId } from '@doomcraft/shared/modes';

import { ModeRouter, type ModeJoinRequest, type RoomLike } from './modes.js';
import {
  DEFAULT_FORCE_MIGRATE_MS,
  HostDrainingError,
  HostLifecycle,
  HostState,
} from './deploy.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

class FakeRoom implements RoomLike {
  readonly maxPlayers = 4;
  humanCount = 0;
  stopped = false;
  constructor(readonly key: string) {}
  status(): Record<string, unknown> { return { humans: this.humanCount, stopped: this.stopped }; }
  stop(): void { this.stopped = true; }
}

interface Harness {
  router: ModeRouter<FakeRoom>;
  life: HostLifecycle;
  rooms: Map<string, FakeRoom>;
  now: { ms: number };
  drainedCalls: number[];
  /** Route a join, returning null when the host refused to create a room. */
  join(req: Partial<ModeJoinRequest>): FakeRoom | null;
}

function harness(forceMigrateMs = DEFAULT_FORCE_MIGRATE_MS): Harness {
  const now = { ms: 1_000_000 };
  const rooms = new Map<string, FakeRoom>();
  const drainedCalls: number[] = [];

  const life = new HostLifecycle({
    clock: () => now.ms,
    forceMigrateMs,
    liveRooms: () => [...rooms.values()]
      .filter((r) => !r.stopped)
      .map((r) => ({ key: r.key, humans: r.humanCount })),
    stopRoom: (key) => {
      const r = rooms.get(key);
      r?.stop();
      // Production wires this to the router's own sweep as well; here the
      // router keeps the slot and `HostLifecycle` remembers it is done with it,
      // which is the harder case for the lifecycle to get right.
    },
    onDrained: () => { drainedCalls.push(now.ms); },
  });

  const router = new ModeRouter<FakeRoom>({
    clock: () => now.ms,
    maxRooms: 8,
    // THE GATE. Wrapping the factory catches every path that can make a room,
    // including ones written after this test.
    create: life.guardCreate((key: string): FakeRoom => {
      const room = new FakeRoom(key);
      rooms.set(key, room);
      return room;
    }),
  });

  const join = (req: Partial<ModeJoinRequest>): FakeRoom | null => {
    const full: ModeJoinRequest = {
      modeId: ModeId.DEATHMATCH, skill: 2, levelId: '', worldId: '', seed: 7, flags: 0,
      ...req,
    };
    try {
      const routed = router.route(full);
      routed.room.humanCount++;
      return routed.room;
    } catch (err) {
      if (err instanceof HostDrainingError) return null;
      throw err;
    }
  };

  return { router, life, rooms, now, drainedCalls, join };
}

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe('a draining host accepts no new rooms', () => {
  it('creates rooms freely while admitting', () => {
    const h = harness();
    expect(h.join({ modeId: ModeId.DEATHMATCH })).not.toBeNull();
    expect(h.join({ modeId: ModeId.HORDE })).not.toBeNull();
    expect(h.router.size).toBe(2);
    expect(h.life.status).toBe(HostState.ADMITTING);
  });

  it('refuses to create one the moment it is draining', () => {
    const h = harness();
    h.join({ modeId: ModeId.DEATHMATCH });
    h.life.beginDrain();

    expect(h.join({ modeId: ModeId.HORDE })).toBeNull();
    expect(h.join({ modeId: ModeId.QUEST, levelId: 'e1m1-hangar' })).toBeNull();
    expect(h.router.size).toBe(1);
  });

  it('still lets a friend into a match that is already running here', () => {
    // The case a socket-level drain gets wrong: your friend is nine minutes
    // into a match on the old host, you click their invite, and a naive drain
    // turns you away from a room that is very much alive.
    const h = harness();
    const first = h.join({ modeId: ModeId.DEATHMATCH });
    h.life.beginDrain();

    const second = h.join({ modeId: ModeId.DEATHMATCH });
    expect(second).toBe(first);
    expect(first?.humanCount).toBe(2);
    expect(h.router.size).toBe(1);
  });

  it('refuses a SECOND instance of a shared key once the first is full', () => {
    // `#2` instances are new rooms, and a draining host makes none of them —
    // even though the key already exists.
    const h = harness();
    for (let i = 0; i < 4; i++) h.join({ modeId: ModeId.DEATHMATCH });
    const room = h.rooms.get('deathmatch');
    expect(room?.humanCount).toBe(4);

    h.life.beginDrain();
    expect(h.join({ modeId: ModeId.DEATHMATCH })).toBeNull();
    expect(h.router.size).toBe(1);
  });

  it('is idempotent: a second SIGTERM does not buy another 30 minutes', () => {
    const h = harness(60_000);
    h.join({});
    h.life.beginDrain();
    const deadline = h.life.deadlineMs;
    h.now.ms += 30_000;
    h.life.beginDrain();
    expect(h.life.deadlineMs).toBe(deadline);
  });
});

describe('a draining host finishes the matches it has', () => {
  it('does not stop a room with a player in it', () => {
    const h = harness();
    const room = h.join({ modeId: ModeId.DEATHMATCH });
    h.life.beginDrain();

    // Half an hour of ticks would exceed the deadline; stay well inside it.
    for (let i = 0; i < 20; i++) { h.now.ms += 1000; h.life.tick(); }

    expect(room?.stopped).toBe(false);
    expect(h.life.status).toBe(HostState.DRAINING);
    expect(h.life.forcedPlayers).toBe(0);
  });

  it('drains only when the last player has left of their own accord', () => {
    const h = harness();
    const room = h.join({ modeId: ModeId.DEATHMATCH }) as FakeRoom;
    h.life.beginDrain();

    h.now.ms += 5000;
    h.life.tick();
    expect(h.life.drained).toBe(false);

    // The match ends. Nobody was disconnected — the count went to zero because
    // the players left.
    room.humanCount = 0;

    h.now.ms += 1000;
    expect(h.life.tick()).toBe(true);
    expect(room.stopped).toBe(true);
    expect(h.life.status).toBe(HostState.DRAINED);
    expect(h.life.forcedPlayers).toBe(0);
    expect(h.drainedCalls.length).toBe(1);
  });

  it('reaps an EMPTY room immediately, so a quiet host drains in seconds', () => {
    const h = harness();
    const busy = h.join({ modeId: ModeId.DEATHMATCH }) as FakeRoom;
    const idle = h.join({ modeId: ModeId.HORDE }) as FakeRoom;
    idle.humanCount = 0;

    h.life.beginDrain();
    expect(idle.stopped).toBe(true);
    expect(busy.stopped).toBe(false);
    expect(h.life.drained).toBe(false);
  });

  it('drains instantly when there was nothing running at all', () => {
    const h = harness();
    h.life.beginDrain();
    expect(h.life.status).toBe(HostState.DRAINED);
    expect(h.drainedCalls.length).toBe(1);
  });

  it('fires onDrained exactly once, however often it is ticked', () => {
    const h = harness();
    const room = h.join({}) as FakeRoom;
    h.life.beginDrain();
    room.humanCount = 0;
    for (let i = 0; i < 5; i++) { h.now.ms += 100; h.life.tick(); }
    expect(h.drainedCalls.length).toBe(1);
  });
});

describe('the drain is bounded', () => {
  it('force-migrates whatever is left at the deadline, and counts the cost', () => {
    const h = harness(30 * 60_000);
    const room = h.join({}) as FakeRoom;
    room.humanCount = 3;
    h.life.beginDrain();

    h.now.ms += 29 * 60_000;
    expect(h.life.tick()).toBe(false);
    expect(room.stopped).toBe(false);

    h.now.ms += 61_000;
    expect(h.life.tick()).toBe(true);
    expect(room.stopped).toBe(true);
    expect(h.life.forcedRooms).toBe(1);
    // The number that matters: how many players this deploy actually
    // interrupted. If it is ever non-zero in production, the budget is wrong.
    expect(h.life.forcedPlayers).toBe(3);
  });

  it('reports a deadline that counts down and then stops at zero', () => {
    const h = harness(10_000);
    h.join({});
    expect(h.life.msUntilDeadline()).toBe(-1);
    h.life.beginDrain();
    expect(h.life.msUntilDeadline()).toBe(10_000);
    h.now.ms += 4000;
    expect(h.life.msUntilDeadline()).toBe(6000);
    h.now.ms += 60_000;
    expect(h.life.msUntilDeadline()).toBe(0);
  });
});

describe('the report a rollout is watched through', () => {
  it('says admitting, draining, then drained', () => {
    const h = harness();
    const room = h.join({}) as FakeRoom;
    room.humanCount = 2;
    expect(h.life.report()).toMatchObject({ state: 'admitting', admitting: true, rooms: 1, humans: 2 });

    h.life.beginDrain();
    expect(h.life.report()).toMatchObject({ state: 'draining', admitting: false, rooms: 1, humans: 2 });

    room.humanCount = 0;
    h.life.tick();
    expect(h.life.report()).toMatchObject({ state: 'drained', rooms: 0, humans: 0, forcedPlayers: 0 });
  });
});
