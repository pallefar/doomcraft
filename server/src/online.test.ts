/**
 * DOOMCRAFT — can two clients actually play together?
 *
 * Every other server test drives a `Room` in-process. This one does not: it
 * spawns the REAL server binary, opens REAL WebSockets to it, and speaks the
 * REAL binary protocol, because the claim being defended is about wiring —
 * "`server/src/index.ts` hosts many rooms and two sockets that asked for the
 * same place end up in the same simulation" — and wiring is exactly the class
 * of thing an in-process unit test cannot prove. The bug this repo keeps
 * producing is code that compiles, passes tests, and is connected to nothing.
 *
 * What is asserted, in order of how much it matters:
 *
 *   1. Two sockets asking for Deathmatch land in ONE room and each one's
 *      snapshot contains the other player. That is "two browsers can play
 *      together", stated as a wire fact.
 *   2. A socket asking for Quest lands somewhere else. That is the router.
 *   3. A private code is honoured, and an invented one is refused at the
 *      upgrade rather than dropped into a public room.
 *   4. SIGTERM drains: health flips, new players are refused, the people
 *      already playing are not thrown out.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import {
  PacketReader,
  PacketWriter,
  S2C,
  SnapshotBuffer,
  decodeSnapshot,
  decodeWelcome,
  createWelcomeMessage,
  encodeHello,
  readMessageId,
} from '@doomcraft/shared';
import {
  ModeId,
  createModeSelectMessage,
  encodeModeSelect,
} from '@doomcraft/shared/modes';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => done(port));
    });
  });
}

interface Booted {
  origin: string;
  wsBase: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

let booted: Booted | null = null;

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-online-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-online-data-'));
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');

  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: staticRoot,
      DOOMCRAFT_DATA: dataRoot,
      // Bots are the instant-start mechanism, but they also make "who is in
      // this room" noisy. Off, so every body in a snapshot is a real socket.
      DOOMCRAFT_BOTS: '0',
      ...env,
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not come up');
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    await new Promise<void>((r) => { setTimeout(r, 120); });
  }

  const b: Booted = {
    origin,
    wsBase: `ws://127.0.0.1:${port}`,
    child,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((done) => { child.once('exit', () => done()); });
    },
  };
  booted = b;
  return b;
}

afterEach(async () => {
  await booted?.stop();
  booted = null;
});

/* ------------------------------------------------------------------------ *
 * A protocol client, thin enough to read in one sitting
 * ------------------------------------------------------------------------ */

class TestClient {
  readonly socket: WebSocket;
  readonly welcome = createWelcomeMessage();
  readonly snapshot = new SnapshotBuffer();
  private readonly reader = new PacketReader();
  private readonly writer = new PacketWriter(256);
  gotWelcome = false;
  snapshots = 0;
  closeCode = 0;
  /** Every distinct player id this client has ever been told about. */
  readonly seenPlayers = new Set<number>();

  constructor(url: string, readonly name: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.on('open', () => {
      this.socket.send(encodeHello(this.writer, this.name, 0, 0, 0).copy(), { binary: true });
    });
    this.socket.on('message', (data: Buffer) => { this.onBytes(new Uint8Array(data)); });
    this.socket.on('close', (code: number) => { this.closeCode = code; });
    this.socket.on('error', () => { /* asserted through state, not thrown */ });
  }

  private onBytes(bytes: Uint8Array): void {
    switch (readMessageId(bytes)) {
      case S2C.WELCOME:
        decodeWelcome(this.reader.reset(bytes), this.welcome);
        this.gotWelcome = true;
        break;
      case S2C.SNAPSHOT: {
        decodeSnapshot(this.reader.reset(bytes), this.snapshot);
        this.snapshots++;
        for (let i = 0; i < this.snapshot.playerCount; i++) {
          this.seenPlayers.add(this.snapshot.playerId[i]);
        }
        break;
      }
      default: break;
    }
  }

  /** Send the mode-select a real client sends on entering a mode. */
  selectMode(modeId: ModeId, levelId = ''): void {
    const m = createModeSelectMessage();
    m.modeId = modeId;
    m.skill = 2;
    m.levelId = levelId;
    this.socket.send(encodeModeSelect(new PacketWriter(96), m).copy(), { binary: true });
  }

  get playerId(): number { return this.welcome.playerId; }
  get open(): boolean { return this.socket.readyState === WebSocket.OPEN; }
  close(): void { try { this.socket.close(); } catch { /* already gone */ } }
}

async function until(what: () => boolean, timeoutMs = 15_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((r) => { setTimeout(r, 40); });
  }
}

async function json(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  return await res.json() as Record<string, unknown>;
}

/* ------------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------------ */

describe('one process, many rooms, over a real socket', () => {
  it('puts two Deathmatch sockets in the same room and shows each the other', async () => {
    const srv = await boot();

    const a = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'AlphaMarine');
    const b = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'BetaMarine');
    await until(() => a.gotWelcome && b.gotWelcome, 20_000, 'both welcomes');

    // Distinct bodies in one simulation.
    expect(a.playerId).toBeGreaterThan(0);
    expect(b.playerId).toBeGreaterThan(0);
    expect(a.playerId).not.toBe(b.playerId);
    // Same world: the seed is per-room, so equal seeds mean one room.
    expect(a.welcome.seed).toBe(b.welcome.seed);

    // THE claim: each one's snapshot stream contains the other player.
    await until(
      () => a.seenPlayers.has(b.playerId) && b.seenPlayers.has(a.playerId),
      20_000,
      'each client to see the other',
    );

    const rooms = await json(`${srv.origin}/api/rooms`);
    const rows = rooms.rooms as Array<Record<string, unknown>>;
    const deathmatch = rows.find((r) => r.key === 'deathmatch');
    expect(deathmatch).toBeDefined();
    expect(deathmatch!.humans).toBe(2);

    const board = await json(`${srv.origin}/api/scoreboard?room=deathmatch`);
    const names = (board.scoreboard as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain('AlphaMarine');
    expect(names).toContain('BetaMarine');

    a.close();
    b.close();
  }, 60_000);

  it('routes a different mode to a different room', async () => {
    const srv = await boot();
    const dm = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'Dm');
    const horde = new TestClient(`${srv.wsBase}/ws?mode=horde`, 'Horde');
    await until(() => dm.gotWelcome && horde.gotWelcome, 20_000, 'both welcomes');

    const status = await json(`${srv.origin}/api/status`);
    const rooms = status.rooms as Array<Record<string, unknown>>;
    const keys = rooms.map((r) => r.key);
    expect(keys).toContain('deathmatch');
    expect(keys).toContain('horde');
    // One human each, in two separate simulations.
    expect(rooms.find((r) => r.key === 'deathmatch')!.humans).toBe(1);
    expect(rooms.find((r) => r.key === 'horde')!.humans).toBe(1);

    /* Neither can see the other's body. Player ids are allocated per ROOM and
     * both start at 1, so comparing ids across rooms would compare two
     * different players who happen to share a number — the count is the honest
     * assertion, and it is 1 because DOOMCRAFT_BOTS=0 in this fixture. */
    await until(() => dm.snapshots > 3 && horde.snapshots > 3, 20_000, 'snapshots');
    expect(dm.snapshot.playerCount).toBe(1);
    expect(horde.snapshot.playerCount).toBe(1);
    expect(dm.seenPlayers.size).toBe(1);
    expect(horde.seenPlayers.size).toBe(1);

    dm.close();
    horde.close();
  }, 60_000);

  it('honours a private code and refuses an invented one', async () => {
    const srv = await boot();
    const made = await (await fetch(`${srv.origin}/api/rooms/private`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'deathmatch' }),
    })).json() as { code: string };
    expect(made.code).toMatch(/^[a-z0-9]{6}$/);

    const a = new TestClient(`${srv.wsBase}/ws?code=${made.code}`, 'Friend1');
    const b = new TestClient(`${srv.wsBase}/ws?code=${made.code}`, 'Friend2');
    await until(() => a.gotWelcome && b.gotWelcome, 20_000, 'both welcomes');
    await until(
      () => a.seenPlayers.has(b.playerId) && b.seenPlayers.has(a.playerId),
      20_000,
      'friends to see each other',
    );

    // The private room is not in the public list, so a stranger cannot find it.
    const rooms = await json(`${srv.origin}/api/rooms`);
    const keys = (rooms.rooms as Array<Record<string, unknown>>).map((r) => r.key);
    expect(keys.some((k) => String(k).includes('~'))).toBe(false);

    // A code nobody minted is refused at the upgrade, not silently made public.
    const bogus = new TestClient(`${srv.wsBase}/ws?code=zzzzzz`, 'Stranger');
    await until(() => !bogus.open && !bogus.gotWelcome, 15_000, 'the bogus code to be refused');
    expect(bogus.gotWelcome).toBe(false);

    a.close();
    b.close();
  }, 60_000);

  it('will not let one joiner reconfigure the room everybody else is in', async () => {
    /* An operator bot fill that is NOT the mode default (`BOT_FILL_TARGET` is
     * 6), so a room re-planned from a client's `SELECT` is visible as the
     * population climbing to 6 instead of staying at 2. */
    const srv = await boot({ DOOMCRAFT_BOTS: '2' });

    const resident = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'Resident');
    await until(() => resident.gotWelcome, 20_000, 'welcome');
    const before = await json(`${srv.origin}/api/status`);
    const beforeRoom = (before.rooms as Array<Record<string, unknown>>)
      .find((r) => r.key === 'deathmatch')!;
    expect(beforeRoom.modeKey).toBe('deathmatch');

    /* The client-side mode layer sends a `SELECT` on entering a mode, and
     * `Room.onModeSelect` has always reconfigured the whole room from it. With
     * many rooms in one process that is an authority hole: this socket asking
     * for Quest would take the Deathmatch away from everyone in it.
     * `RoomOptions.lockMode` is what closes it. */
    const intruder = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'Intruder');
    await until(() => intruder.gotWelcome, 20_000, 'welcome');
    intruder.selectMode(ModeId.QUEST, 'e1m1-hangar');
    // Long enough for `maintainBots` to have spawned a body on a re-planned room.
    await new Promise<void>((r) => { setTimeout(r, 2500); });

    const after = await json(`${srv.origin}/api/status`);
    const afterRoom = (after.rooms as Array<Record<string, unknown>>)
      .find((r) => r.key === 'deathmatch')!;
    expect(afterRoom.modeKey).toBe('deathmatch');
    /* And the operator's bot fill survived it. A `SELECT` re-planned from the
     * client's message would have replaced `DOOMCRAFT_BOTS=2` with the mode
     * default of 6 — and would have honoured the client's `flags`, which
     * include `MSF_NO_BOTS`, letting one player empty a public arena. */
    expect(afterRoom.players).toBe(2);
    expect(afterRoom.bots).toBe(0);
    // And the resident is still in a live match, not in somebody's Quest.
    expect(resident.open).toBe(true);

    resident.close();
    intruder.close();
  }, 60_000);

  it('answers quickplay with a joinable URL and the room population', async () => {
    const srv = await boot();
    const cold = await json(`${srv.origin}/api/quickplay?mode=deathmatch`);
    const coldTicket = cold.ticket as Record<string, unknown>;
    expect(coldTicket.ws).toBe('/ws?mode=deathmatch');

    const a = new TestClient(`${srv.wsBase}${String(coldTicket.ws)}`, 'Quick');
    await until(() => a.gotWelcome, 20_000, 'welcome');

    const warm = await json(`${srv.origin}/api/quickplay?mode=deathmatch`);
    const warmTicket = warm.ticket as Record<string, unknown>;
    expect(warmTicket.fresh).toBe(false);
    expect(warmTicket.humans).toBe(1);

    a.close();
  }, 60_000);

  it('refuses a socket from an origin that is not on the allowlist', async () => {
    const srv = await boot({ DOOMCRAFT_ORIGINS: 'https://doomcraft.example' });

    const evil = new WebSocket(`${srv.wsBase}/ws?mode=deathmatch`, { origin: 'https://evil.example' });
    let refused = false;
    evil.on('error', () => { refused = true; });
    evil.on('unexpected-response', () => { refused = true; });
    await until(() => refused, 10_000, 'the upgrade to be refused');

    // The allowed origin still gets in.
    const good = new WebSocket(`${srv.wsBase}/ws?mode=deathmatch`, { origin: 'https://doomcraft.example' });
    let opened = false;
    good.on('open', () => { opened = true; });
    await until(() => opened, 10_000, 'the allowed origin to connect');
    good.close();
  }, 60_000);
});

describe('SIGTERM drains instead of dropping the match', () => {
  it('flips health, refuses new players, and leaves the live ones playing', async () => {
    // A long drain budget, so the assertions land while the window is open.
    const srv = await boot({ DOOMCRAFT_DRAIN_MS: '20000' });

    const playing = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'StillHere');
    await until(() => playing.gotWelcome, 20_000, 'welcome');
    const before = playing.snapshots;

    srv.child.kill('SIGTERM');

    // 1. Readiness flips, with a body that says why.
    let health: Record<string, unknown> = {};
    for (let i = 0; i < 100 && health.draining !== true; i++) {
      try { health = await json(`${srv.origin}/health`); } catch { /* closing */ }
      if (health.draining === true) break;
      await new Promise<void>((r) => { setTimeout(r, 60); });
    }
    expect(health.draining).toBe(true);
    expect(health.ok).toBe(false);

    // 2. The player who was already in the match keeps getting snapshots.
    expect(playing.open).toBe(true);
    await until(() => playing.snapshots > before + 3, 10_000, 'the match to keep ticking');

    // 3. A new player is refused rather than joining a host that is going away.
    const late = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'TooLate');
    await until(() => !late.open && !late.gotWelcome, 10_000, 'the late joiner to be refused');
    expect(late.gotWelcome).toBe(false);

    playing.close();
  }, 90_000);

  it('closes the stragglers with 1001 once the drain budget runs out', async () => {
    const srv = await boot({ DOOMCRAFT_DRAIN_MS: '300' });
    const playing = new TestClient(`${srv.wsBase}/ws?mode=deathmatch`, 'Straggler');
    await until(() => playing.gotWelcome, 20_000, 'welcome');

    srv.child.kill('SIGTERM');
    await until(() => playing.closeCode !== 0, 20_000, 'the socket to be closed');
    // 1001 "going away" — the code a client reads as "reconnect, do not panic".
    expect(playing.closeCode).toBe(1001);
  }, 90_000);
});
