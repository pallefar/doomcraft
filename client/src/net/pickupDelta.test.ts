/**
 * DOOMCRAFT — a pickup taken and respawned must reach EVERY client promptly.
 *
 * The end-to-end half of the entity-delta change in `server/src/net.ts`. The
 * server-side tests in `server/src/net.test.ts` reach into the sim and call
 * `removeEntity` directly; this one does not touch the sim's entity API at all.
 * A real player body is walked onto a real pickup, the sim's own overlap test
 * takes it, and the room's own 22 s timer puts it back — with TWO real
 * `NetClient`s attached, because a per-connection baseline is exactly the kind
 * of state that can be right for one client and wrong for another.
 *
 * Two things are asserted that a size test would never catch:
 *   - both clients stop drawing the taken pickup inside 200 ms, not at the next
 *     3 s full snapshot;
 *   - the respawn is carried by a DELTA snapshot. If it only ever arrived on
 *     the periodic full, the delta encoder would be losing spawns and the 3 s
 *     safety net would be hiding it.
 */
import { describe, expect, it } from 'vitest';
import {
  EntityType, GameMode, MAX_ENTITIES, MAX_PLAYERS, MAX_PROJECTILES,
  PacketReader, S2C, SNAP_FULL, SnapshotBuffer, decodeSnapshot, readMessageId,
} from '@shared';
import { Room, PICKUP_RESPAWN_MS } from '@doomcraft/server/src/room.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';
import { NetClient } from './client.js';
import type { ClientTransport } from './transport.js';

class Link {
  open = true;
  conn;
  client: ClientTransport;
  /** tick -> was that snapshot a full one */
  readonly seenIds = new Map<number, { firstMs: number; full: boolean }>();
  private readonly buf = new SnapshotBuffer(MAX_PLAYERS, MAX_ENTITIES, MAX_PROJECTILES);
  private readonly reader = new PacketReader();
  constructor(readonly room: Room, private readonly now: () => number) {
    const self = this;
    const serverSide: NetTransport = {
      get isOpen(): boolean { return self.open; },
      get bufferedAmount(): number { return 0; },
      close(): void { self.open = false; },
      send(data: Uint8Array): void {
        if (!self.open) return;
        if (readMessageId(data) === S2C.SNAPSHOT) {
          const s = decodeSnapshot(self.reader.reset(data), self.buf);
          const full = (s.flags & SNAP_FULL) !== 0;
          for (let i = 0; i < s.entityCount; i++) {
            const id = s.entityId[i];
            if (!self.seenIds.has(id)) self.seenIds.set(id, { firstMs: self.now(), full });
          }
        }
        self.client.onmessage?.(data.slice());
      },
    };
    this.conn = room.join(serverSide);
    this.client = {
      get readyState(): number { return self.open ? 1 : 3; },
      send(data: Uint8Array): void { if (self.open) self.room.receive(self.conn, data.slice()); },
      close(): void { self.open = false; },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
  }
}

describe('VERIFY: a pickup taken and respawned reaches every client promptly', () => {
  it('two independent clients both lose it and both get it back, off a delta snapshot', () => {
    let nowMs = 0;
    const now = (): number => nowMs;
    const room = new Room({
      seed: 4242, mode: GameMode.DEATHMATCH, botFill: 0, enemies: 0,
      eagerWorld: false, store: null, clock: now, name: 'verify',
    });
    const links = [new Link(room, now), new Link(room, now)];
    const nets = links.map((l) => new NetClient({
      name: 'Marine', transport: l.client as never, autoReconnect: false,
      keepalive: null, wallClock: now,
    }));
    for (const n of nets) n.connect();
    const frame = (): void => {
      nowMs += 1000 / 60;
      room.advance(nowMs);
      for (const n of nets) n.update(1 / 60);
    };
    const run = (ms: number): void => { const end = nowMs + ms; while (nowMs < end) frame(); };

    run(4000);

    // Find a live pickup and a real player, then walk the player onto it.
    const sim = room.sim;
    let slot = -1;
    for (let e = 0; e < sim.entCapacity; e++) {
      if (sim.entActive[e] === 1
          && (sim.entType[e] === EntityType.PICKUP_HEALTH || sim.entType[e] === EntityType.PICKUP_ARMOR)) {
        slot = e; break;
      }
    }
    expect(slot).toBeGreaterThanOrEqual(0);
    const id = sim.entId[slot];
    const px = sim.entX[slot], py = sim.entY[slot], pz = sim.entZ[slot];

    // Both clients are drawing it.
    for (const n of nets) {
      expect(n.entities.find((v) => v.active && v.id === id), 'pickup missing before take').toBeDefined();
    }

    // Teleport a live player body onto the pickup — the sim's own overlap test
    // is what takes it, nothing here calls removeEntity.
    const p = sim.players.find((x) => x.active && !x.dead);
    expect(p, 'no live player').toBeDefined();
    // Health/armour have to be missing for the pickup to be taken at all.
    p!.health = 20;
    p!.armor = 0;
    const place = (): void => {
      p!.pos[0] = px; p!.pos[1] = py - p!.height * 0.5 + 0.35; p!.pos[2] = pz;
    };
    place();

    const takeStart = nowMs;
    let takenAt = -1;
    for (let i = 0; i < 120 && takenAt < 0; i++) {
      place();
      frame();
      if (sim.entActive[slot] !== 1 || sim.entId[slot] !== id) takenAt = nowMs;
    }
    expect(takenAt, 'the sim never took the pickup').toBeGreaterThan(0);

    // Both clients must drop it within a couple of ticks, not at the 3 s full.
    run(200);
    for (let i = 0; i < nets.length; i++) {
      expect(nets[i].entities.find((v) => v.active && v.id === id),
        `client ${i} still draws a taken pickup`).toBeUndefined();
    }
    expect(nowMs - takeStart).toBeLessThan(3000);

    // Respawn.
    // Move the player off, so it cannot be taken again the instant it returns.
    p!.pos[0] = px + 30; p!.pos[2] = pz + 30;
    p!.health = 100; p!.armor = 100;
    const idsBefore = new Set<number>();
    for (let e = 0; e < sim.entCapacity; e++) {
      if (sim.entActive[e] === 1 && sim.entType[e] >= EntityType.PICKUP_HEALTH) idsBefore.add(sim.entId[e]);
    }
    const respawnDeadline = nowMs + PICKUP_RESPAWN_MS + 4000;
    let newId = -1;
    while (nowMs < respawnDeadline && newId < 0) {
      frame();
      p!.pos[0] = px + 30; p!.pos[2] = pz + 30;
      for (let e = 0; e < sim.entCapacity; e++) {
        if (sim.entActive[e] !== 1 || sim.entType[e] < EntityType.PICKUP_HEALTH) continue;
        if (!idsBefore.has(sim.entId[e])) { newId = sim.entId[e]; break; }
      }
    }
    expect(newId, 'the pickup never respawned server-side').toBeGreaterThan(0);
    const respawnMs = nowMs;

    run(300);
    for (let i = 0; i < nets.length; i++) {
      const v = nets[i].entities.find((x) => x.active && x.id === newId);
      expect(v, `client ${i} never got the respawned pickup`).toBeDefined();
      const seen = links[i].seenIds.get(newId);
      expect(seen, `client ${i}: respawn never crossed the wire`).toBeDefined();
      // Promptness: within 200 ms of the server creating it, and it must be a
      // DELTA snapshot that carried it, not the 3 s safety net.
      expect(seen!.firstMs - respawnMs, `client ${i}: respawn was late`).toBeLessThan(200);
      expect(seen!.full, `client ${i}: respawn only arrived via the full snapshot`).toBe(false);
    }

    for (const n of nets) n.dispose();
    room.stop();
  });
});
