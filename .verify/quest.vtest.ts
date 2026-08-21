/**
 * Independent re-run of the Diagnose-phase PRIMARY reproduction: in Quest, do
 * the room and the client still simulate two different worlds?
 *
 * Real `Room`, real `NetClient`, real in-memory wire, real `C2S_MODE.SELECT`,
 * real `QuestLevelRuntime` doing the blit. The last case is the CONTROL: the
 * same harness with a resolver that cannot hand the room the level, i.e. the
 * shipped-before behaviour. If the control does not reproduce the bug, the
 * measurement is broken and the green results above mean nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BTN_SPRINT, GameMode, PLAYER_HALF_WIDTH, aabbHitsSolid } from '@shared';
import { PacketWriter } from '@shared/protocol';
import {
  ModeAction, ModeId,
  createModeActionMessage, createModeSelectMessage,
  encodeModeAction, encodeModeSelect,
  type ModeContextMessage,
} from '@shared/modes';
import { compileLevel, parseLevelJson, primarySpawn, type Level } from '@shared/level';
import { Room } from '@doomcraft/server/src/room.js';
import type { ContentResolver } from '@doomcraft/server/src/modes.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';
import { NetClient, type ClientTransport } from '@/net/client';
import { QuestEvent, QuestLevelRuntime } from '@/modes/quest/levelRuntime';

const REPO = '/Users/karstenhaldan/youtube/doomcraft';
const cache = new Map<string, Level>();
function loadLevel(id: string): Level {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const src = parseLevelJson(readFileSync(resolve(REPO, 'content/levels', `${id}.json`), 'utf8'));
  if (src === null) throw new Error(`cannot parse ${id}`);
  const lv = compileLevel(src);
  cache.set(id, lv);
  return lv;
}

/** The resolver the browser Worker installs — the room can have the geometry. */
function fullResolver(ids: readonly string[]): ContentResolver {
  return {
    resolveId: (r: string): string => (ids.includes(r) ? r : ids[0]),
    levelFor: (id: string): Level | null => (ids.includes(id) ? loadLevel(id) : null),
  };
}
/** The SHIPPED-BEFORE resolver: knows the id, cannot hand over the voxels. */
function blindResolver(ids: readonly string[]): ContentResolver {
  return { resolveId: (r: string): string => (ids.includes(r) ? r : ids[0]) };
}

interface Fixture {
  room: Room; net: NetClient;
  corrections: number[];
  context: { levelId: string; contentHash: number } | null;
  frame(): void; dispose(): void;
}
const live: Fixture[] = [];
afterEach(() => { while (live.length > 0) live.pop()?.dispose(); });

function makeFixture(seed: number, levels: ContentResolver | null): Fixture {
  let nowMs = 0;
  const now = (): number => nowMs;
  const room = new Room({
    seed, mode: GameMode.SANDBOX, botFill: 0, enemies: 0,
    eagerWorld: false, store: null, clock: now, levels, name: 'verify',
  });
  let open = true;
  let client!: ClientTransport;
  const serverSide: NetTransport = {
    get isOpen(): boolean { return open; },
    get bufferedAmount(): number { return 0; },
    send(d: Uint8Array): void { if (open) client.onmessage?.(d.slice()); },
    close(code = 1000, reason = ''): void { if (!open) return; open = false; client.onclose?.(code, reason); },
  };
  const conn = room.join(serverSide);
  client = {
    get readyState(): number { return open ? 1 : 3; },
    send(d: Uint8Array): void { if (open) room.receive(conn, d.slice()); },
    close(): void { open = false; },
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };
  const corrections: number[] = [];
  const f: Fixture = {
    room, net: null as unknown as NetClient, corrections, context: null,
    frame(): void { nowMs += 1000 / 60; room.advance(nowMs); f.net.update(1 / 60); },
    dispose(): void { f.net.dispose(); room.stop(); },
  };
  f.net = new NetClient({
    name: 'Marine', transport: client, autoReconnect: false, keepalive: null, wallClock: now,
    events: {
      onCorrection: (e: number): void => { corrections.push(e); },
      onModeContext: (c: ModeContextMessage): void => { f.context = { levelId: c.levelId, contentHash: c.contentHash }; },
    },
  });
  f.net.connect();
  live.push(f);
  return f;
}

const selWriter = new PacketWriter(128);
function selectQuest(f: Fixture, levelId: string): void {
  const m = createModeSelectMessage();
  m.modeId = ModeId.QUEST; m.skill = 2; m.flags = 0; m.seed = 0;
  m.levelId = levelId; m.worldId = '';
  f.net.send(encodeModeSelect(selWriter, m).copy());
}

function runtimeFor(f: Fixture, level: Level): QuestLevelRuntime {
  const msg = createModeActionMessage();
  const w = new PacketWriter(128);
  let seq = 1;
  return new QuestLevelRuntime({
    level, skill: 2,
    world: {
      chunkAt: (cx, cz) => f.net.world.chunkAt(cx, cz),
      putChunk: (cx, cz, v) => { f.net.world.putChunk(cx, cz, v); },
      setBlock: (x, y, z, id) => { f.net.world.setBlock(x, y, z, id); },
      getBlock: (x, y, z) => f.net.world.getBlock(x, y, z),
    },
    events: (kind, index, a) => {
      if (kind !== QuestEvent.DOOR_ROWS) return;
      if (f.context === null || f.context.contentHash === 0) return;
      msg.action = ModeAction.SET_DOOR; msg.a = index; msg.b = a;
      msg.x = 0; msg.y = 0; msg.z = 0; msg.seq = seq++;
      f.net.send(encodeModeAction(w, msg).copy());
    },
  });
}

/** `QuestMode.tryPlace`, reduced to the one decision this file is about. */
function placeLevel(f: Fixture, rt: QuestLevelRuntime, level: Level): boolean {
  const roomOwns = f.context !== null && f.context.contentHash !== 0;
  const p = f.net.renderPos;
  const a = primarySpawn(level);
  const onSpawn = Math.abs(p[0] - a.x) < 3 && Math.abs(p[2] - a.z) < 3 && Math.abs(p[1] - a.y) < 4;
  if (!roomOwns && !onSpawn) rt.alignSpawnTo(p[0], p[1], p[2]);
  rt.place();
  return roomOwns;
}

function inside(net: NetClient): boolean {
  const p = net.predicted.pos;
  return aabbHitsSolid(p[0], p[1], p[2], PLAYER_HALF_WIDTH, net.predicted.height, net.world.solidAt);
}

interface Walk {
  corrections: number; worstCorrection: number;
  insideFrames: number; frames: number;
  worstEyeJump: number; distance: number; netDisplacement: number;
  roomOwns: boolean;
}

function walk(f: Fixture, rt: QuestLevelRuntime, level: Level, seconds: number, turn: boolean): Walk {
  f.corrections.length = 0;
  const roomOwns = placeLevel(f, rt, level);
  const start = [f.net.predicted.pos[0], f.net.predicted.pos[1], f.net.predicted.pos[2]];
  const prevEye = [f.net.renderPos[0], f.net.renderPos[1], f.net.renderPos[2]];
  const prevBody = [start[0], start[1], start[2]];
  const out: Walk = {
    corrections: 0, worstCorrection: 0, insideFrames: 0, frames: 0,
    worstEyeJump: 0, distance: 0, netDisplacement: 0, roomOwns,
  };
  f.net.setMove(0, 1);
  f.net.setButtons(BTN_SPRINT);
  const frames = Math.round(seconds * 60);
  let yaw = 0;
  for (let i = 0; i < frames; i++) {
    if (turn) { yaw += 0.012; f.net.setLook(yaw, 0); }
    f.frame();
    rt.reassert(4);
    out.frames++;
    if (inside(f.net)) out.insideFrames++;
    const e = f.net.renderPos;
    const ej = Math.hypot(e[0] - prevEye[0], e[1] - prevEye[1], e[2] - prevEye[2]);
    if (ej > out.worstEyeJump) out.worstEyeJump = ej;
    prevEye[0] = e[0]; prevEye[1] = e[1]; prevEye[2] = e[2];
    const p = f.net.predicted.pos;
    out.distance += Math.hypot(p[0] - prevBody[0], p[1] - prevBody[1], p[2] - prevBody[2]);
    prevBody[0] = p[0]; prevBody[1] = p[1]; prevBody[2] = p[2];
  }
  f.net.setMove(0, 0); f.net.setButtons(0);
  out.corrections = f.corrections.length;
  for (const c of f.corrections) if (c > out.worstCorrection) out.worstCorrection = c;
  const p = f.net.predicted.pos;
  out.netDisplacement = Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]);
  return out;
}

function report(tag: string, w: Walk): void {
  console.log(`  ${tag}: roomOwnsGeometry=${w.roomOwns} corrections=${w.corrections}/${w.frames}f `
    + `maxErr=${w.worstCorrection.toFixed(3)}m insideGeometry=${w.insideFrames}f `
    + `maxEyeJump=${w.worstEyeJump.toFixed(3)}m path=${w.distance.toFixed(1)}m net=${w.netDisplacement.toFixed(1)}m`);
}

const LEVELS = ['e1m1-hangar', 'e1m3-warrens'] as const;

describe('Quest: room and client simulate the SAME world', () => {
  for (const id of LEVELS) {
    for (const seed of [555, 90210, 4242]) {
      it(`${id} @ seed ${seed}: 10 s sprint, no rubber-band, never inside a wall`, () => {
        const f = makeFixture(seed, fullResolver([...LEVELS]));
        for (let i = 0; i < 90; i++) f.frame();
        selectQuest(f, id);
        for (let i = 0; i < 90; i++) f.frame();
        const level = loadLevel(id);
        const rt = runtimeFor(f, level);
        const w = walk(f, rt, level, 10, false);
        report(`${id}/${seed}`, w);
        expect(w.roomOwns, 'the room did not take ownership of the level').toBe(true);
        expect(w.insideFrames, 'body ended up inside solid level geometry').toBe(0);
        expect(w.worstCorrection, 'server dragged the body').toBeLessThan(0.5);
        expect(w.worstEyeJump, 'camera teleported').toBeLessThan(0.6);
      });
    }
  }

  it('e1m1 with a slow turn, 15 s', () => {
    const f = makeFixture(1234, fullResolver([...LEVELS]));
    for (let i = 0; i < 90; i++) f.frame();
    selectQuest(f, 'e1m1-hangar');
    for (let i = 0; i < 90; i++) f.frame();
    const level = loadLevel('e1m1-hangar');
    const w = walk(f, runtimeFor(f, level), level, 15, true);
    report('e1m1 slow-turn', w);
    expect(w.roomOwns).toBe(true);
    expect(w.insideFrames).toBe(0);
    expect(w.worstCorrection).toBeLessThan(0.5);
  });

  it('CONTROL: the same harness still reproduces the ORIGINAL bug when the room cannot get the level', () => {
    const bad: Walk[] = [];
    for (const seed of [555, 90210, 4242]) {
      const f = makeFixture(seed, blindResolver([...LEVELS]));
      for (let i = 0; i < 90; i++) f.frame();
      selectQuest(f, 'e1m1-hangar');
      for (let i = 0; i < 90; i++) f.frame();
      const level = loadLevel('e1m1-hangar');
      const w = walk(f, runtimeFor(f, level), level, 10, false);
      report(`CONTROL e1m1/${seed}`, w);
      bad.push(w);
    }
    // At least one seed must show the divergence, or the measurement is dead.
    const worstInside = Math.max(...bad.map((w) => w.insideFrames));
    const worstCorr = Math.max(...bad.map((w) => w.corrections));
    expect(bad.every((w) => w.roomOwns === false)).toBe(true);
    expect(worstInside + worstCorr, 'the control did NOT reproduce — the measurement is broken').toBeGreaterThan(5);
  });
});
