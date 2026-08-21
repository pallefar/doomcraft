/**
 * DOOMCRAFT — the room table and the directory over it.
 *
 * `ModeRouter` compiled, passed a typecheck and was referenced by nothing at
 * all before this file existed — including by any test. So this covers the
 * router itself as well as the directory, and it covers the two properties
 * that the server's whole capacity claim rests on:
 *
 *   1. **Two people who pick the same place land in the same room.** That is
 *      what makes a room key a room key. If it were false, "3,200 players per
 *      box" would be 3,200 people alone in 3,200 rooms.
 *   2. **A private code is unreachable by accident.** The key it mints must be
 *      one no public request can ever produce, or a stranger walks into a
 *      match that was supposed to be four friends.
 */

import { describe, expect, it } from 'vitest';
import { ModeId } from '@doomcraft/shared/modes';
import {
  ModeRouter,
  joinRequestFor,
  roomKeyForPlan,
  roomKeyForRequest,
  type ModeSimPlan,
  type RoomLike,
} from './modes.js';
import {
  PRIVATE_KEY_MARK,
  RoomDirectory,
  UnknownCodeError,
  joinRequestFromQuery,
  queryForRequest,
} from './directory.js';
import { seededRandom } from './worlds.js';

/* ------------------------------------------------------------------------ *
 * A room that is not a Room
 *
 * The router only needs `maxPlayers`, `humanCount`, `status()` and `stop()`,
 * and a real `Room` generates 169 chunks of terrain per instance. Using a fake
 * is not a shortcut — it is what lets this file assert on ROUTING rather than
 * on how fast a laptop can generate voxels.
 * ------------------------------------------------------------------------ */

class FakeRoom implements RoomLike {
  humanCount = 0;
  stopped = false;
  constructor(readonly key: string, readonly maxPlayers: number, readonly plan: ModeSimPlan) {}
  status(): Record<string, unknown> {
    return { name: this.key, players: this.humanCount + 2, bots: 2, state: 'live' };
  }
  stop(): void { this.stopped = true; }
}

function makeRouter(overrides: { maxRooms?: number; idleMs?: number; clock?: () => number } = {}): {
  router: ModeRouter<FakeRoom>;
  created: string[];
} {
  const created: string[] = [];
  const router = new ModeRouter<FakeRoom>({
    maxRooms: overrides.maxRooms ?? 8,
    idleMs: overrides.idleMs,
    clock: overrides.clock,
    create(key, plan, options): FakeRoom {
      created.push(key);
      return new FakeRoom(key, options.maxPlayers ?? plan.maxPlayers, plan);
    },
  });
  return { router, created };
}

/* ------------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------------ */

describe('ModeRouter: one process, many rooms', () => {
  it('creates a room on the first request and reuses it on the second', () => {
    const { router, created } = makeRouter();
    const a = router.route(joinRequestFor(ModeId.DEATHMATCH));
    const b = router.route(joinRequestFor(ModeId.DEATHMATCH));

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.room).toBe(a.room);
    expect(created).toEqual(['deathmatch']);
    expect(router.size).toBe(1);
  });

  it('puts two people who picked the same Quest level in the same room', () => {
    const { router } = makeRouter();
    const a = router.route(joinRequestFor(ModeId.QUEST, 'e1m1-hangar', '', 2));
    const b = router.route(joinRequestFor(ModeId.QUEST, 'e1m1-hangar', '', 2));
    expect(b.room).toBe(a.room);
  });

  it('keeps different levels, skills and worlds apart', () => {
    const { router } = makeRouter();
    const hangar = router.route(joinRequestFor(ModeId.QUEST, 'e1m1-hangar', '', 2));
    const nuclear = router.route(joinRequestFor(ModeId.QUEST, 'e1m2-nuclear', '', 2));
    const harder = router.route(joinRequestFor(ModeId.QUEST, 'e1m1-hangar', '', 4));
    const world1 = router.route(joinRequestFor(ModeId.BUILDER, '', 'world1'));
    const world2 = router.route(joinRequestFor(ModeId.BUILDER, '', 'world2'));

    const keys = new Set([hangar.key, nuclear.key, harder.key, world1.key, world2.key]);
    expect(keys.size).toBe(5);
    expect(hangar.key).toBe('quest:e1m1-hangar:2');
    expect(world1.key).toBe('builder:world1');
  });

  it('spills into a second instance when the first is full, not into a refusal', () => {
    const { router } = makeRouter();
    const first = router.route(joinRequestFor(ModeId.DEATHMATCH));
    first.room.humanCount = first.room.maxPlayers;

    const second = router.route(joinRequestFor(ModeId.DEATHMATCH));
    expect(second.created).toBe(true);
    expect(second.key).toBe('deathmatch#2');
    expect(second.room).not.toBe(first.room);
  });

  it('hands back the emptiest room rather than refusing when the cap is hit', () => {
    const { router } = makeRouter({ maxRooms: 2 });
    const a = router.route(joinRequestFor(ModeId.DEATHMATCH));
    a.room.humanCount = a.room.maxPlayers;
    const b = router.route(joinRequestFor(ModeId.DEATHMATCH));
    b.room.humanCount = b.room.maxPlayers;

    const third = router.route(joinRequestFor(ModeId.DEATHMATCH));
    expect(router.size).toBe(2);
    expect(third.created).toBe(false);
    // Both are equally full, so it is allowed to pick either — what matters is
    // that a player is never left without a room.
    expect([a.room, b.room]).toContain(third.room);
  });

  it('reaps an empty room after the idle window and leaves an occupied one', () => {
    let now = 0;
    const { router } = makeRouter({ idleMs: 1000, clock: () => now });
    const empty = router.route(joinRequestFor(ModeId.DEATHMATCH));
    const busy = router.route(joinRequestFor(ModeId.HORDE));
    busy.room.humanCount = 1;

    now = 999;
    expect(router.sweep()).toBe(0);

    now = 1001;
    expect(router.sweep()).toBe(1);
    expect(empty.room.stopped).toBe(true);
    expect(busy.room.stopped).toBe(false);
    expect(router.keys()).toEqual(['horde']);
  });

  it('stops every room on shutdown', () => {
    const { router } = makeRouter();
    const a = router.route(joinRequestFor(ModeId.DEATHMATCH));
    const b = router.route(joinRequestFor(ModeId.HORDE));
    router.stopAll();
    expect(a.room.stopped).toBe(true);
    expect(b.room.stopped).toBe(true);
    expect(router.size).toBe(0);
  });

  it('agrees with itself about what a plan is keyed as', () => {
    const { router } = makeRouter();
    const routed = router.route(joinRequestFor(ModeId.QUEST, 'e1m1-hangar', '', 3));
    // The room compares an incoming SELECT against this to decide whether it
    // names the place the room actually is (RoomOptions.lockMode). If the two
    // ever disagreed, a locked room would refuse its own mode.
    expect(roomKeyForPlan(routed.plan)).toBe(routed.key);
  });
});

/* ------------------------------------------------------------------------ *
 * Query parsing — the routing decision arrives as a URL, not as a packet
 * ------------------------------------------------------------------------ */

describe('join requests travel in the socket URL', () => {
  it('reads mode, level, world and skill out of a query string', () => {
    const req = joinRequestFromQuery(new URLSearchParams('mode=quest&level=e1m1-hangar&skill=4'));
    expect(req.modeId).toBe(ModeId.QUEST);
    expect(req.levelId).toBe('e1m1-hangar');
    expect(req.skill).toBe(4);
  });

  it('falls back to deathmatch for anything it does not recognise', () => {
    for (const q of ['', 'mode=', 'mode=nonsense', 'mode=99', 'mode=../../etc/passwd']) {
      expect(joinRequestFromQuery(new URLSearchParams(q)).modeId).toBe(ModeId.DEATHMATCH);
    }
  });

  it('round-trips a request through its own query string', () => {
    const req = joinRequestFor(ModeId.QUEST, 'e1m3-toxin', '', 1);
    const back = joinRequestFromQuery(new URLSearchParams(queryForRequest(req)));
    expect(roomKeyForRequest(back)).toBe(roomKeyForRequest(req));
  });
});

/* ------------------------------------------------------------------------ *
 * The directory
 * ------------------------------------------------------------------------ */

function makeDirectory(clock: () => number = () => 0): {
  router: ModeRouter<FakeRoom>;
  directory: RoomDirectory<FakeRoom>;
} {
  const { router } = makeRouter({ clock });
  // Seeded, so the codes in these assertions are stable.
  const directory = new RoomDirectory<FakeRoom>({ source: router, clock, rand: seededRandom(7) });
  return { router, directory };
}

describe('RoomDirectory: a list, a code, and never a queue', () => {
  it('lists public rooms busiest first', () => {
    const { router, directory } = makeDirectory();
    const dm = router.route(joinRequestFor(ModeId.DEATHMATCH));
    const horde = router.route(joinRequestFor(ModeId.HORDE));
    // Horde caps at 4 (shared/src/modes.ts), so 3 is a busy-but-open room.
    dm.room.humanCount = 2;
    horde.room.humanCount = 3;

    const rows = directory.list();
    expect(rows.map((r) => r.key)).toEqual(['horde', 'deathmatch']);
    expect(rows[0].humans).toBe(3);
    expect(rows[0].open).toBe(true);
    expect(rows[0].bots).toBe(true);
  });

  it('filters the list by mode', () => {
    const { router, directory } = makeDirectory();
    router.route(joinRequestFor(ModeId.DEATHMATCH));
    router.route(joinRequestFor(ModeId.HORDE));
    expect(directory.list(ModeId.HORDE).map((r) => r.key)).toEqual(['horde']);
  });

  it('marks a full room closed instead of hiding it', () => {
    const { router, directory } = makeDirectory();
    const dm = router.route(joinRequestFor(ModeId.DEATHMATCH));
    dm.room.humanCount = dm.room.maxPlayers;
    expect(directory.list()[0].open).toBe(false);
  });

  it('mints a private key no public request can produce', () => {
    const { directory } = makeDirectory();
    const reservation = directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH));
    expect(reservation).not.toBeNull();
    expect(reservation!.key).toContain(PRIVATE_KEY_MARK);
    expect(reservation!.key.startsWith('deathmatch~')).toBe(true);
    // The public key for the same request is a strict prefix, never equal.
    expect(reservation!.key).not.toBe(roomKeyForRequest(joinRequestFor(ModeId.DEATHMATCH)));
    expect(RoomDirectory.isPrivateKey(reservation!.key)).toBe(true);
  });

  it('builds nothing when a code is minted — a copied code costs no CPU', () => {
    const { router, directory } = makeDirectory();
    directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH));
    expect(router.size).toBe(0);
  });

  it('never lists a private room', () => {
    const { router, directory } = makeDirectory();
    const reservation = directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH))!;
    const routed = router.route(reservation.req, reservation.key);
    routed.room.humanCount = 3;

    expect(router.keys()).toContain(reservation.key);
    expect(directory.list().map((r) => r.key)).not.toContain(reservation.key);
    expect(directory.list()).toHaveLength(0);
  });

  it('resolves a code typed with spaces and dashes and the wrong case', () => {
    const { directory } = makeDirectory();
    const reservation = directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH))!;
    const noisy = `${reservation.code.slice(0, 2).toUpperCase()} ${reservation.code.slice(2, 4)}-${reservation.code.slice(4)}`;
    expect(directory.resolveCode(noisy)?.key).toBe(reservation.key);
  });

  it('refuses a code it never minted rather than silently going public', () => {
    const { directory } = makeDirectory();
    expect(directory.resolveCode('zzzzzz')).toBeNull();
    expect(() => directory.quickplay(joinRequestFor(ModeId.DEATHMATCH), 'zzzzzz'))
      .toThrow(UnknownCodeError);
  });

  it('keeps a code alive while its room exists and forgets it after the TTL', () => {
    let now = 0;
    const { router } = makeRouter({ clock: () => now });
    const directory = new RoomDirectory<FakeRoom>({
      source: router, clock: () => now, rand: seededRandom(3), reservationTtlMs: 60_000,
    });

    const used = directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH))!;
    const unused = directory.createPrivate(joinRequestFor(ModeId.HORDE))!;
    router.route(used.req, used.key);

    now = 60_001;
    expect(directory.sweep()).toBe(1);
    expect(directory.resolveCode(used.code)).not.toBeNull();
    expect(directory.resolveCode(unused.code)).toBeNull();
  });

  it('reports the room a socket will actually land in, and whether it is fresh', () => {
    const { router, directory } = makeDirectory();
    const cold = directory.quickplay(joinRequestFor(ModeId.DEATHMATCH));
    expect(cold.fresh).toBe(true);
    expect(cold.key).toBeNull();
    expect(cold.ws).toBe('/ws?mode=deathmatch');

    const dm = router.route(joinRequestFor(ModeId.DEATHMATCH));
    dm.room.humanCount = 4;
    const warm = directory.quickplay(joinRequestFor(ModeId.DEATHMATCH));
    expect(warm.fresh).toBe(false);
    expect(warm.key).toBe('deathmatch');
    expect(warm.humans).toBe(4);
  });

  it('points quickplay at the next instance once the first is full', () => {
    const { router, directory } = makeDirectory();
    const first = router.route(joinRequestFor(ModeId.DEATHMATCH));
    first.room.humanCount = first.room.maxPlayers;
    router.route(joinRequestFor(ModeId.DEATHMATCH));   // creates #2

    expect(directory.quickplay(joinRequestFor(ModeId.DEATHMATCH)).key).toBe('deathmatch#2');
  });

  it('puts the code, not the mode, in a private ticket URL', () => {
    const { directory } = makeDirectory();
    const reservation = directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH))!;
    const ticket = directory.quickplay(reservation.req, reservation.code);
    expect(ticket.ws).toBe(`/ws?code=${reservation.code}`);
    expect(ticket.code).toBe(reservation.code);
  });

  it('stops minting codes past the cap instead of growing without bound', () => {
    const { router } = makeRouter();
    const directory = new RoomDirectory<FakeRoom>({
      source: router, clock: () => 0, rand: seededRandom(11), maxPrivate: 2,
    });
    expect(directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH))).not.toBeNull();
    expect(directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH))).not.toBeNull();
    expect(directory.createPrivate(joinRequestFor(ModeId.DEATHMATCH))).toBeNull();
    expect(directory.privateCount).toBe(2);
  });
});
