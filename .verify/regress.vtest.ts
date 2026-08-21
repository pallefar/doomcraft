/**
 * REGRESSION found in the browser: after a Quest session, entering any other
 * mode in the same room buries the player inside the regenerated terrain and
 * they cannot move. Reproduced here on the real `Room`, and localised.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameMode, PLAYER_HALF_WIDTH, aabbHitsSolid } from '@shared';
import { PacketWriter } from '@shared/protocol';
import { ModeId, createModeSelectMessage, encodeModeSelect } from '@shared/modes';
import { compileLevel, parseLevelJson, type Level } from '@shared/level';
import { Room } from '@doomcraft/server/src/room.js';
import type { ContentResolver } from '@doomcraft/server/src/modes.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';
import { NetClient, type ClientTransport } from '@/net/client';

const REPO = '/Users/karstenhaldan/youtube/doomcraft';
function loadLevel(id: string): Level {
  const src = parseLevelJson(readFileSync(resolve(REPO, 'content/levels', `${id}.json`), 'utf8'));
  if (src === null) throw new Error('parse');
  return compileLevel(src);
}
const resolver: ContentResolver = {
  resolveId: (r) => r,
  levelFor: (id) => (id === 'e1m1-hangar' ? loadLevel(id) : null),
};

function makeRoom() {
  let nowMs = 0;
  const now = (): number => nowMs;
  const room = new Room({ seed: 1234, mode: GameMode.SANDBOX, botFill: 0, enemies: 0,
    eagerWorld: false, store: null, clock: now, levels: resolver, name: 'regress' });
  let open = true;
  let client!: ClientTransport;
  const t: NetTransport = {
    get isOpen() { return open; }, get bufferedAmount() { return 0; },
    send(d: Uint8Array) { if (open) client.onmessage?.(d.slice()); },
    close() { open = false; },
  };
  const conn = room.join(t);
  client = {
    get readyState(): number { return open ? 1 : 3; },
    send(d: Uint8Array): void { if (open) room.receive(conn, d.slice()); },
    close(): void { open = false; },
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };
  const net = new NetClient({ name: 'Marine', transport: client, autoReconnect: false,
    keepalive: null, wallClock: now, events: {} });
  net.connect();
  const w = new PacketWriter(256);
  const select = (modeId: number, levelId: string): void => {
    const m = createModeSelectMessage();
    m.modeId = modeId; m.skill = 2; m.flags = 0; m.seed = 0; m.levelId = levelId; m.worldId = '';
    net.send(encodeModeSelect(w, m).copy());
  };
  const advance = (ms: number): void => {
    for (let i = 0; i < ms / 16.67; i++) { nowMs += 1000 / 60; room.advance(nowMs); net.update(1 / 60); }
  };
  return { room, select, advance, conn, net };
}

const buried = (room: Room): { buried: boolean; pos: number[] } => {
  const sim = (room as unknown as { sim: { players: { pos: Float64Array; height: number }[] } }).sim;
  const p = sim.players[0];
  const world = (room as unknown as { world: { solidAt: (x: number, y: number, z: number) => boolean } }).world;
  return {
    buried: aabbHitsSolid(p.pos[0], p.pos[1], p.pos[2], PLAYER_HALF_WIDTH, 1.8, world.solidAt),
    pos: [+p.pos[0].toFixed(2), +p.pos[1].toFixed(2), +p.pos[2].toFixed(2)],
  };
};

describe('leaving Quest for another mode', () => {
  it('does NOT bury the player in the regenerated terrain', () => {
    const r = makeRoom();
    r.advance(1000);
    r.select(ModeId.QUEST, 'e1m1-hangar');
    r.advance(1000);
    const inQuest = buried(r.room);
    console.log(`  in Quest:            pos=${JSON.stringify(inQuest.pos)} buried=${inQuest.buried}`);

    r.select(ModeId.DEATHMATCH, '');
    r.advance(1000);
    const afterDm = buried(r.room);
    console.log(`  after -> Deathmatch: pos=${JSON.stringify(afterDm.pos)} buried=${afterDm.buried}`);

    r.select(ModeId.BUILDER, '');
    r.advance(1000);
    const afterB = buried(r.room);
    console.log(`  after -> Builder:    pos=${JSON.stringify(afterB.pos)} buried=${afterB.buried}`);

    expect(inQuest.buried, 'buried inside the authored level itself').toBe(false);
    expect(afterDm.buried, 'BURIED after leaving Quest for Deathmatch').toBe(false);
    expect(afterB.buried, 'BURIED after leaving Quest for Builder').toBe(false);
  });

  it('control: Deathmatch entered WITHOUT a preceding Quest spawns clear', () => {
    const r = makeRoom();
    r.advance(1000);
    r.select(ModeId.DEATHMATCH, '');
    r.advance(1000);
    const b = buried(r.room);
    console.log(`  fresh Deathmatch:    pos=${JSON.stringify(b.pos)} buried=${b.buried}`);
    expect(b.buried).toBe(false);
  });
});
