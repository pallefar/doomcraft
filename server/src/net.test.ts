/**
 * DOOMCRAFT — the snapshot must not pay rent on things that never move.
 *
 * The bug these tests lock down (docs/INFRASTRUCTURE.md §"The four facts",
 * fact 1): `sendSnapshot` used to set `entityMask = EF_SPAWN | EF_ALL`
 * unconditionally, so every one of a Deathmatch arena's ~33 stationary pickups
 * was retransmitted in full, 23 bytes each, twenty times a second, for the
 * entire match. That was 15.2 kB/s of the 16.0 kB/s a lone player received.
 *
 * Entity records are now delta-encoded against a per-connection baseline and an
 * unchanged entity is omitted from the snapshot entirely. Saving bytes is the
 * easy half; the hard half is that omission must never lose an event, so most
 * of what follows is about promptness and about slot recycling rather than
 * about size.
 *
 * Everything here drives the REAL `Room` (and therefore the real `Simulation`,
 * `NetHub` and `ServerWorld`) over an in-memory transport on a virtual clock,
 * and decodes the actual wire bytes with the actual decoder. No mocks, and in
 * particular no reimplementation of the encoder — a test that agreed with a
 * copy of the encoder would prove nothing about what a client receives.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  EF_HEALTH,
  EF_POS,
  EF_REMOVED,
  EF_SPAWN,
  EF_STATE,
  EF_YAW,
  EntityType,
  GameMode,
  MAX_ENTITIES,
  MAX_PROJECTILES,
  MAX_PLAYERS,
  PacketReader,
  PacketWriter,
  RemoveReason,
  S2C,
  SNAP_FULL,
  SnapshotBuffer,
  TICK_MS,
  decodeSnapshot,
  encodeHello,
  encodePing,
  quantizePos,
  readMessageId,
} from '@doomcraft/shared';

import { Room, PICKUP_RESPAWN_MS } from './room.js';
import { FULL_SNAPSHOT_INTERVAL_MS } from './net.js';
import type { Connection, NetTransport } from './net.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

/** One decoded entity record, for the fields its mask actually carried. */
interface EntityRecord {
  mask: number;
  x: number; y: number; z: number;
  type: number;
  health: number;
  state: number;
}

/** One decoded snapshot, flattened to plain data so assertions read like prose. */
interface Frame {
  bytes: number;
  tick: number;
  full: boolean;
  /** entity id -> mask, in wire order. */
  entities: Map<number, number>;
  records: Map<number, EntityRecord>;
}

/**
 * A recording socket. Snapshots are decoded as they leave the server, which is
 * the only place the question "what did this client actually get?" has an
 * answer — `conn.stats.bytesSent` lumps chunks in with everything else.
 */
class Recorder {
  readonly room: Room;
  readonly conn: Connection;
  readonly frames: Frame[] = [];
  /** Snapshot bytes only, so chunk streaming cannot flatter the number. */
  snapshotBytes = 0;
  private readonly buf = new SnapshotBuffer(MAX_PLAYERS, MAX_ENTITIES, MAX_PROJECTILES);
  private readonly reader = new PacketReader();
  private open = true;

  constructor(room: Room, name = 'Marine') {
    this.room = room;
    const self = this;
    const transport: NetTransport = {
      get isOpen(): boolean { return self.open; },
      get bufferedAmount(): number { return 0; },
      close(): void { self.open = false; },
      send(data: Uint8Array): void {
        if (!self.open) return;
        if (readMessageId(data) !== S2C.SNAPSHOT) return;
        self.snapshotBytes += data.length;
        self.record(data);
      },
    };
    this.conn = room.join(transport);

    const w = new PacketWriter(256);
    encodeHello(w, name, 0, 0, 0);
    room.receive(this.conn, w.copy());
  }

  private record(data: Uint8Array): void {
    // A fresh buffer per frame: `decodeSnapshot` fills POSITIONALLY and leaves
    // unmasked fields untouched, so reusing one would let a previous record
    // bleed into this one — precisely the hazard the client had to be taught
    // about, and not something a test should reproduce by accident.
    const s = decodeSnapshot(this.reader.reset(data), this.buf);
    const entities = new Map<number, number>();
    const records = new Map<number, EntityRecord>();
    for (let i = 0; i < s.entityCount; i++) {
      entities.set(s.entityId[i], s.entityMask[i]);
      records.set(s.entityId[i], {
        mask: s.entityMask[i],
        x: s.entityX[i], y: s.entityY[i], z: s.entityZ[i],
        type: s.entityType[i], health: s.entityHealth[i], state: s.entityState[i],
      });
    }
    this.frames.push({
      bytes: data.length,
      tick: s.tick,
      full: (s.flags & SNAP_FULL) !== 0,
      entities,
      records,
    });
    this.buf.reset();
  }

  /**
   * A client that never speaks is reaped after CLIENT_TIMEOUT_MS (15 s), which
   * is shorter than a pickup respawn. The fixture beats this every tick so a
   * long test measures the snapshot path and not the timeout path.
   */
  heartbeat(nowMs: number): void {
    if (!this.open) return;
    const w = new PacketWriter(16);
    encodePing(w, nowMs >>> 0);
    this.room.receive(this.conn, w.copy());
  }

  clear(): void { this.frames.length = 0; this.snapshotBytes = 0; }
  get last(): Frame { return this.frames[this.frames.length - 1]; }
  /** Frames that were deltas — the steady-state case the bug lived in. */
  get deltas(): Frame[] { return this.frames.filter((f) => !f.full); }
}

interface Fixture {
  room: Room;
  rec: Recorder;
  /** Every recorder the fixture keeps alive; `addClient` appends. */
  readonly clients: Recorder[];
  addClient(name: string): Recorder;
  /**
   * Advance the virtual clock and tick the room. `beforeTick` runs immediately
   * before the step, `afterTick` immediately after the snapshot it produced.
   */
  run(ms: number, hooks?: { beforeTick?: () => void; afterTick?: () => void }): void;
  nowMs(): number;
  dispose(): void;
}

const live: Fixture[] = [];

function makeFixture(opts: { mode?: GameMode; enemies?: number } = {}): Fixture {
  let nowMs = 0;
  const room = new Room({
    seed: 90210,
    mode: opts.mode ?? GameMode.DEATHMATCH,
    botFill: 0,
    enemies: opts.enemies ?? 0,
    eagerWorld: false,
    store: null,
    clock: () => nowMs,
    name: 'net-delta-test',
  });
  const rec = new Recorder(room);
  const clients: Recorder[] = [rec];

  const fixture: Fixture = {
    room,
    rec,
    clients,
    nowMs: () => nowMs,
    addClient(name: string): Recorder {
      const c = new Recorder(room, name);
      clients.push(c);
      return c;
    },
    run(ms: number, hooks?: { beforeTick?: () => void; afterTick?: () => void }): void {
      const end = nowMs + ms;
      while (nowMs < end) {
        nowMs = Math.min(end, nowMs + TICK_MS);
        for (const c of clients) c.heartbeat(nowMs);
        hooks?.beforeTick?.();
        room.advance(nowMs);
        hooks?.afterTick?.();
      }
    },
    dispose(): void { room.stop(); },
  };
  live.push(fixture);
  return fixture;
}

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose();
});

/** Every live pickup slot in the sim, as [slot, id] pairs. */
function pickupSlots(room: Room): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let e = 0; e < room.sim.entCapacity; e++) {
    if (room.sim.entActive[e] !== 1) continue;
    if (room.sim.entType[e] < EntityType.PICKUP_HEALTH) continue;
    out.push([e, room.sim.entId[e]]);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe('snapshot: stationary entities cost nothing', () => {
  it('stops re-sending pickups that have not moved', () => {
    const f = makeFixture();
    f.run(1000);
    const pickups = pickupSlots(f.room);
    expect(pickups.length).toBeGreaterThan(20);   // a real Deathmatch arena

    // Settle past the joining client's first full snapshot, then watch a window
    // that contains no full snapshot at all.
    f.run(FULL_SNAPSHOT_INTERVAL_MS);
    f.rec.clear();
    f.run(FULL_SNAPSHOT_INTERVAL_MS - 4 * TICK_MS);

    const deltas = f.rec.deltas;
    expect(deltas.length).toBeGreaterThan(30);

    // Not one of those frames may mention a pickup that did not change. Nothing
    // in this fixture picks anything up (no bots, one idle connection), so the
    // correct number of pickup records in a delta frame is zero.
    const liveIds = new Set(pickups.map(([, id]) => id));
    for (const frame of deltas) {
      for (const id of frame.entities.keys()) {
        expect(liveIds.has(id), `delta snapshot re-sent stationary pickup ${id}`).toBe(false);
      }
    }
  });

  it('still describes every pickup in the periodic full snapshot', () => {
    const f = makeFixture();
    f.run(1000);
    const pickups = pickupSlots(f.room);
    f.rec.clear();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 4 * TICK_MS);

    const fulls = f.rec.frames.filter((x) => x.full);
    expect(fulls.length).toBeGreaterThanOrEqual(1);
    const full = fulls[fulls.length - 1];
    for (const [slot, id] of pickups) {
      const r = full.records.get(id);
      expect(r, `full snapshot dropped pickup ${id}`).toBeDefined();
      // Baseline-free, so it must be self-describing and complete.
      expect(r!.mask & EF_SPAWN).toBeTruthy();
      expect(r!.mask & EF_POS).toBeTruthy();
      expect(quantizePos(r!.x)).toBe(quantizePos(f.room.sim.entX[slot]));
      expect(r!.type).toBe(f.room.sim.entType[slot]);
    }
  });

  it('costs measurably fewer bytes per second than a full re-send would', () => {
    const f = makeFixture();
    f.run(1000);
    const pickupCount = pickupSlots(f.room).length;
    f.rec.clear();

    const windowMs = 4 * FULL_SNAPSHOT_INTERVAL_MS;
    f.run(windowMs);
    const bytesPerSecond = f.rec.snapshotBytes / (windowMs / 1000);

    // The old encoder spent ~23 B per entity per snapshot at 20 Hz. Anything
    // near that number means the delta path silently stopped working.
    const oldPickupCost = pickupCount * 23 * (1000 / TICK_MS);
    expect(bytesPerSecond).toBeLessThan(oldPickupCost * 0.4);
  });
});

describe('snapshot: omission never loses an event', () => {
  it('delivers a taken pickup on the very next snapshot', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const [slot, id] = pickupSlots(f.room)[0];

    f.rec.clear();
    f.room.sim.removeEntity(slot, RemoveReason.PICKED_UP);
    f.run(TICK_MS);

    expect(f.rec.frames.length).toBe(1);
    const mask = f.rec.frames[0].entities.get(id);
    expect(mask, 'a picked-up entity was not announced').toBeDefined();
    expect(mask! & EF_REMOVED).toBeTruthy();
  });

  it('delivers a respawned pickup as a complete, self-describing record', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const [slot, oldId] = pickupSlots(f.room)[0];
    const gone = new Set([oldId]);

    f.room.sim.removeEntity(slot, RemoveReason.PICKED_UP);
    f.run(TICK_MS);

    // Wait out the respawn timer, then find the frame that announced the new
    // occupant. It must arrive with EF_SPAWN even though it stands in exactly
    // the same place, in what is very likely the same sim slot, as the one that
    // was just removed: the baseline is keyed by slot, and a recycled slot that
    // inherited its predecessor's baseline would be omitted and never drawn.
    f.rec.clear();
    f.run(PICKUP_RESPAWN_MS + 20 * TICK_MS);

    let spawned: { id: number; mask: number } | null = null;
    for (const frame of f.rec.frames) {
      if (frame.full) continue;                       // a full snapshot proves nothing here
      for (const [id, mask] of frame.entities) {
        if (gone.has(id) || (mask & EF_REMOVED) !== 0) continue;
        if ((mask & EF_SPAWN) !== 0) { spawned = { id, mask }; break; }
      }
      if (spawned) break;
    }
    expect(spawned, 'the respawned pickup never reached the client').not.toBeNull();
    expect(spawned!.id).not.toBe(oldId);
    expect(spawned!.mask & EF_POS).toBeTruthy();

    // And it is really on the map again.
    const slots = pickupSlots(f.room).map(([, id]) => id);
    expect(slots).toContain(spawned!.id);
  });

  it('delivers a state change on a pickup that never moves', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const [slot, id] = pickupSlots(f.room)[0];

    f.rec.clear();
    // Nothing in Deathmatch flips a pickup's state bits today, which is exactly
    // why it needs a test: the day something does, "it never changes" must not
    // be baked into the encoder.
    f.room.sim.entState[slot] = 0x20;
    f.run(TICK_MS);

    const r = f.rec.frames[0].records.get(id);
    expect(r, 'a state change on a stationary entity was swallowed').toBeDefined();
    expect(r!.mask & EF_STATE).toBeTruthy();
    expect(r!.state).toBe(0x20);
    // ...and only that field was paid for.
    expect(r!.mask & EF_POS).toBeFalsy();

    // The change is sent once, not every tick from now on.
    f.rec.clear();
    f.run(10 * TICK_MS);
    for (const frame of f.rec.deltas) expect(frame.entities.has(id)).toBe(false);
  });

  it('delivers a moved pickup, and only the field that moved', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const [slot, id] = pickupSlots(f.room)[0];

    f.rec.clear();
    f.room.sim.entX[slot] += 5;
    f.run(TICK_MS);

    const r = f.rec.frames[0].records.get(id);
    expect(r).toBeDefined();
    expect(r!.mask & EF_POS).toBeTruthy();
    expect(r!.mask & EF_HEALTH).toBeFalsy();
    expect(quantizePos(r!.x)).toBe(quantizePos(f.room.sim.entX[slot]));
  });

  it('ignores sub-quantum jitter, exactly as the player encoder does', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const [slot, id] = pickupSlots(f.room)[0];

    f.rec.clear();
    // 1/64 m is one wire step; a hundredth of that must cost nothing.
    f.room.sim.entX[slot] += 1 / 6400;
    f.run(10 * TICK_MS);
    for (const frame of f.rec.deltas) expect(frame.entities.has(id)).toBe(false);
  });

  it('re-describes everything after resetWorldStreams (round restart)', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const pickups = pickupSlots(f.room);

    f.rec.clear();
    f.room.net.resetWorldStreams();
    f.run(2 * TICK_MS);

    const first = f.rec.frames[0];
    expect(first.full).toBe(true);
    for (const [, id] of pickups) {
      expect(first.entities.get(id), `pickup ${id} missing after a restart`).toBeDefined();
      expect(first.entities.get(id)! & EF_SPAWN).toBeTruthy();
    }
  });

  it('re-describes every entity when a lossy peer asks for a resync', () => {
    // The peer-host WebRTC transport carries snapshots on an UNRELIABLE
    // channel. Its repair for a dropped datagram is `conn.baselineTick = 0`
    // (client/src/net/localServer.ts `resyncPeer`), which has to land on the
    // `full` test in sendSnapshot. Before entities were delta-coded a lost
    // record healed itself on the next tick; now this is the only repair, so
    // it gets a test of its own rather than riding on resetWorldStreams.
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const pickups = pickupSlots(f.room);

    f.rec.clear();
    f.rec.conn.baselineTick = 0;
    f.run(TICK_MS);

    const frame = f.rec.frames[0];
    expect(frame.full).toBe(true);
    for (const [, id] of pickups) {
      const mask = frame.entities.get(id);
      expect(mask, `resync did not re-describe pickup ${id}`).toBeDefined();
      expect(mask! & EF_SPAWN).toBeTruthy();
      expect(mask! & EF_POS).toBeTruthy();
    }
  });

  it('gives a late joiner every entity, not just the ones that moved', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 2000);
    const pickups = pickupSlots(f.room);

    // Second client, long after the first one's baseline went quiet.
    const late = f.addClient('Latecomer');
    f.run(2 * TICK_MS);

    const first = late.frames[0];
    expect(first.full).toBe(true);
    for (const [, id] of pickups) {
      expect(first.entities.get(id), `late joiner never heard about pickup ${id}`).toBeDefined();
    }
  });
});

describe('snapshot: moving entities still stream', () => {
  it('sends EF_POS on the very tick a monster crosses a wire quantum', () => {
    const f = makeFixture({ mode: GameMode.HORDE, enemies: 4 });
    f.run(8000);                                  // let the wave manager place demons

    /** id -> the exact triple `encodeSnapshot` would put on the wire. */
    const monsterIds = (): Map<number, string> => {
      const m = new Map<number, string>();
      for (let e = 0; e < f.room.sim.entCapacity; e++) {
        if (f.room.sim.entActive[e] !== 1) continue;
        if (f.room.sim.entType[e] >= EntityType.PICKUP_HEALTH) continue;
        m.set(f.room.sim.entId[e],
          `${quantizePos(f.room.sim.entX[e])},${quantizePos(f.room.sim.entY[e])},${quantizePos(f.room.sim.entZ[e])}`);
      }
      return m;
    };
    expect(monsterIds().size).toBeGreaterThan(0);

    f.rec.clear();
    const perTick: Array<Map<number, string>> = [monsterIds()];
    f.run(40 * TICK_MS, { afterTick: () => perTick.push(monsterIds()) });

    // One sim state per frame, in step. Anything else and the comparison below
    // would be comparing a monster against a different tick's position.
    expect(perTick.length).toBe(f.rec.frames.length + 1);

    let moves = 0;
    for (let k = 0; k < f.rec.frames.length; k++) {
      const before = perTick[k];
      const after = perTick[k + 1];
      const frame = f.rec.frames[k];
      for (const [id, qpos] of after) {
        const was = before.get(id);
        if (was === undefined || was === qpos) continue;   // did not cross a quantum
        moves++;
        const mask = frame.entities.get(id);
        expect(mask, `monster ${id} moved on tick ${k} and was not in that snapshot`).toBeDefined();
        expect(mask! & EF_POS, `monster ${id} moved but EF_POS was withheld`).toBeTruthy();
      }
    }
    // The invariant above is vacuous if nothing ever moved.
    expect(moves).toBeGreaterThan(10);
  });

  it('keeps streaming an entity that is teleported every single tick', () => {
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const [slot, id] = pickupSlots(f.room)[0];
    const x0 = f.room.sim.entX[slot];

    f.rec.clear();
    let step = 0;
    f.run(30 * TICK_MS, { beforeTick: () => { f.room.sim.entX[slot] = x0 + (++step) * 0.25; } });

    expect(f.rec.frames.length).toBe(30);
    for (const frame of f.rec.frames) {
      const mask = frame.entities.get(id);
      expect(mask, 'a moving entity was omitted').toBeDefined();
      expect(mask! & EF_POS).toBeTruthy();
    }
    // And the last one the client saw is where the server actually put it.
    expect(quantizePos(f.rec.last.records.get(id)!.x)).toBe(quantizePos(f.room.sim.entX[slot]));
  });

  it('never spends bytes on a pickup\'s decorative yaw', () => {
    // `Simulation.stepPickups` spins every pickup's yaw every tick and no
    // client reads it — pickups are drawn spinning off the renderer's own
    // clock. Left in the delta it would make each pickup a 6-byte record 20x/s
    // and give back most of what this change saves.
    const f = makeFixture();
    f.run(FULL_SNAPSHOT_INTERVAL_MS + 1000);
    const pickupIds = new Set(pickupSlots(f.room).map(([, id]) => id));

    f.rec.clear();
    f.run(2 * FULL_SNAPSHOT_INTERVAL_MS);

    for (const frame of f.rec.frames) {
      for (const [id, mask] of frame.entities) {
        if (!pickupIds.has(id)) continue;
        expect(mask & EF_YAW, `pickup ${id} paid for yaw`).toBe(0);
      }
    }
  });
});

describe('snapshot: two clients keep independent baselines', () => {
  it('does not let one client\'s baseline satisfy another\'s', () => {
    const f = makeFixture();
    f.run(1000);
    const [slot, id] = pickupSlots(f.room)[0];

    // A second client joins mid-match and is still inside its own full-snapshot
    // window when the entity changes. Both must be told.
    const second = f.addClient('Second');
    f.run(4 * TICK_MS);

    f.rec.clear();
    second.clear();
    f.room.sim.entX[slot] += 3;
    f.run(TICK_MS);

    expect(f.rec.frames[0].entities.get(id)! & EF_POS).toBeTruthy();
    const secondMask = second.frames[0].entities.get(id);
    expect(secondMask, 'second client never heard the move').toBeDefined();
    expect(secondMask! & EF_POS).toBeTruthy();
  });
});
