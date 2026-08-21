/**
 * DOOMCRAFT — the tab can go away and the match survives.
 *
 * The bug this file locks down (docs/BUGS-FOUND.md §1): every packet the client
 * sent was paced by `requestAnimationFrame`, which a background tab throttles
 * to ~1 Hz and stops entirely when the tab is occluded. `reapTimeouts()` drops
 * any connection silent for `CLIENT_TIMEOUT_MS` (15 s). Alt-tab, take a call,
 * switch apps — fifteen seconds later you are out of the game.
 *
 * These tests run the REAL server room against the REAL NetClient over an
 * in-memory loopback, on a virtual clock, and simply never call `net.update()`
 * for thirty seconds — which is exactly what a browser does to a hidden tab.
 * The only thing still ticking is the keepalive clock, injected here so the
 * test drives it deterministically instead of waiting on a real Worker.
 *
 * The control case (`keepalive: null`) is not decoration: without it a green
 * result proves nothing, because it would also be green if the server's
 * timeout had quietly stopped working.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { C2S, CLIENT_TIMEOUT_MS, GameMode } from '@shared';
import { Room } from '@doomcraft/server/src/room.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';

import {
  KEEPALIVE_SILENCE_MS,
  KEEPALIVE_TICK_MS,
  MAX_PREDICT_STEPS,
  NetClient,
  RESUME_RESYNC_MS,
  type ClientTransport,
  type KeepaliveClock,
} from './client.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

/** A keepalive clock the test owns. Nothing fires unless the test says so. */
class ManualKeepaliveClock implements KeepaliveClock {
  intervalMs = 0;
  private onTick: (() => void) | null = null;
  private nextDueMs = Infinity;

  start(intervalMs: number, onTick: () => void): void {
    this.intervalMs = intervalMs;
    this.onTick = onTick;
    this.nextDueMs = 0;
  }

  stop(): void {
    this.onTick = null;
    this.nextDueMs = Infinity;
  }

  get running(): boolean { return this.onTick !== null; }

  /** Fire every tick that is due at `nowMs`. */
  advanceTo(nowMs: number): void {
    if (this.onTick === null) return;
    let guard = 0;
    while (nowMs >= this.nextDueMs && guard++ < 10_000) {
      this.nextDueMs += this.intervalMs;
      this.onTick();
    }
  }
}

/**
 * A loopback the client and the room both believe is a socket. Delivery is
 * synchronous — latency is not what these tests are about, and a queue would
 * only hide which side went quiet.
 */
class Loopback {
  readonly room: Room;
  readonly conn: ReturnType<Room['join']>;
  readonly client: ClientTransport;
  /** C2S message id -> count, so a test can see exactly what the client sent. */
  readonly sent = new Map<number, number>();

  private open = true;

  constructor(room: Room) {
    this.room = room;

    const self = this;
    const serverSide: NetTransport = {
      get isOpen(): boolean { return self.open; },
      get bufferedAmount(): number { return 0; },
      send(data: Uint8Array): void {
        if (!self.open) return;
        self.client.onmessage?.(data.slice());
      },
      close(code = 1000, reason = ''): void {
        if (!self.open) return;
        self.open = false;
        self.client.onclose?.(code, reason);
      },
    };
    this.conn = room.join(serverSide);

    this.client = {
      get readyState(): number { return self.open ? 1 : 3; },
      send(data: Uint8Array): void {
        if (!self.open) return;
        const id = data.length > 0 ? data[0] : 0;
        self.sent.set(id, (self.sent.get(id) ?? 0) + 1);
        self.room.receive(self.conn, data.slice());
      },
      close(): void { self.open = false; },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
  }

  count(id: C2S): number { return this.sent.get(id) ?? 0; }
  resetCounts(): void { this.sent.clear(); }
  get connected(): boolean { return this.open && !this.conn.closed; }
}

interface Fixture {
  room: Room;
  link: Loopback;
  net: NetClient;
  clock: ManualKeepaliveClock;
  /** Virtual wall clock, in ms. Both the room and the client read it. */
  now(): number;
  /** Advance the world without rendering: the room ticks, the client does not. */
  runHidden(durationMs: number): void;
  /** One rendered frame at 60 Hz. */
  frame(): void;
  dispose(): void;
}

const live: Fixture[] = [];

function makeFixture(opts: { keepalive?: boolean } = {}): Fixture {
  const withKeepalive = opts.keepalive ?? true;
  let nowMs = 0;
  const now = (): number => nowMs;

  const room = new Room({
    seed: 4242,
    mode: GameMode.SANDBOX,
    botFill: 0,
    enemies: 0,
    eagerWorld: false,
    store: null,
    clock: now,
    name: 'keepalive-test',
  });

  const link = new Loopback(room);
  const clock = new ManualKeepaliveClock();
  const net = new NetClient({
    name: 'Marine',
    transport: link.client,
    autoReconnect: false,
    keepalive: withKeepalive ? clock : null,
    wallClock: now,
  });

  net.connect();

  const fixture: Fixture = {
    room,
    link,
    net,
    clock,
    now,
    frame(): void {
      nowMs += 1000 / 60;
      room.advance(nowMs);
      clock.advanceTo(nowMs);
      net.update(1 / 60);
    },
    runHidden(durationMs: number): void {
      const end = nowMs + durationMs;
      // 100 ms is finer than every deadline in play (the 15 s reap, the ~3 s
      // keepalive, the 1 s clock) and coarse enough to keep the test quick.
      while (nowMs < end) {
        nowMs = Math.min(end, nowMs + 100);
        room.advance(nowMs);
        clock.advanceTo(nowMs);
        // net.update() is deliberately NOT called: that is what "hidden" means.
      }
    },
    dispose(): void {
      net.dispose();
      room.stop();
    },
  };

  live.push(fixture);
  return fixture;
}

/** Get to a live, spawned match the way the real client does. */
function playFor(f: Fixture, frames: number): void {
  for (let i = 0; i < frames; i++) f.frame();
}

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose();
});

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe('background tab keepalive', () => {
  it('the server really does reap a client that stops sending — the control', () => {
    const f = makeFixture({ keepalive: false });
    playFor(f, 60);
    expect(f.link.connected).toBe(true);

    f.runHidden(30_000);

    expect(f.link.connected).toBe(false);
    expect(f.room.net.connections).not.toContain(f.link.conn);
  });

  it('a client that stops rendering for 30 s stays connected', () => {
    const f = makeFixture();
    playFor(f, 60);
    expect(f.link.connected).toBe(true);
    const beforeHidden = f.net.keepalivesSent;

    // Thirty seconds with no frames at all: twice the 15 s timeout.
    f.runHidden(30_000);

    expect(f.link.connected).toBe(true);
    expect(f.link.conn.closed).toBe(false);
    expect(f.room.net.connections).toContain(f.link.conn);
    expect(f.net.status).not.toBe('closed');

    // ...and it stayed connected because keepalives went out, not because the
    // reaper was asleep.
    const sent = f.net.keepalivesSent - beforeHidden;
    expect(sent).toBeGreaterThanOrEqual(Math.floor(30_000 / KEEPALIVE_SILENCE_MS) - 1);
    expect(f.now() - f.link.conn.lastRecvMs).toBeLessThan(CLIENT_TIMEOUT_MS);
  });

  it('survives five minutes hidden, the case a 1/minute throttle would lose', () => {
    const f = makeFixture();
    playFor(f, 60);

    f.runHidden(300_000);

    expect(f.link.connected).toBe(true);
    expect(f.net.status).not.toBe('closed');
  });

  it('keeps the socket quiet while the tab is visible', () => {
    const f = makeFixture();
    playFor(f, 60);
    const before = f.net.keepalivesSent;

    // Five seconds of ordinary rendering — longer than KEEPALIVE_SILENCE_MS.
    playFor(f, 300);

    // 60 Hz input already refreshes the server's timer; the keepalive must not
    // add a single packet on the hot path.
    expect(f.net.keepalivesSent).toBe(before);
  });

  it('sends an immediate keepalive on the visibilitychange edge', () => {
    const f = makeFixture();
    playFor(f, 60);
    f.link.resetCounts();

    // The socket was busy one frame ago, so the periodic check would decline.
    expect(f.net.keepaliveTick()).toBe(false);
    // The hidden edge forces it, restarting the server's 15 s window now.
    expect(f.net.keepaliveTick(true)).toBe(true);
    expect(f.link.count(C2S.PING)).toBe(1);
  });

  it('stops the clock when the client disconnects', () => {
    const f = makeFixture();
    playFor(f, 60);
    expect(f.clock.running).toBe(true);

    f.net.disconnect();

    expect(f.clock.running).toBe(false);
    expect(f.net.keepaliveTick(true)).toBe(false);
  });

  it('starts a keepalive interval short enough to beat the server timeout', () => {
    const f = makeFixture();
    expect(f.clock.intervalMs).toBe(KEEPALIVE_TICK_MS);
    expect(KEEPALIVE_TICK_MS).toBeLessThan(CLIENT_TIMEOUT_MS);
    // Four keepalives may be lost to throttling before the server gives up.
    expect(KEEPALIVE_SILENCE_MS * 4).toBeLessThan(CLIENT_TIMEOUT_MS);
  });
});

describe('coming back from the background', () => {
  it('does not replay the gap as input', () => {
    const f = makeFixture();
    playFor(f, 60);
    f.runHidden(30_000);
    f.link.resetCounts();

    // The browser hands back one frame carrying the whole absence. Even
    // unclamped, the client must not turn 30 s into 1800 commands.
    f.net.resumeFromBackground();
    f.net.update(30);

    expect(f.link.count(C2S.INPUT)).toBeLessThanOrEqual(MAX_PREDICT_STEPS);
    expect(f.link.connected).toBe(true);
  });

  it('re-syncs the interpolation clock instead of easing across the gap', () => {
    const f = makeFixture();
    playFor(f, 60);
    const offsetWhilePlaying = f.net.debugClockOffsetMs;
    expect(f.net.debugClockReady).toBe(true);

    f.runHidden(30_000);
    f.net.resumeFromBackground();

    // Dropped, so the first snapshot back snaps the offset rather than
    // crawling toward it at 5% a frame for the next few seconds.
    expect(f.net.debugClockReady).toBe(false);

    playFor(f, 10);
    expect(f.net.debugClockReady).toBe(true);
    // The room ran the whole time it was hidden, so the offset must have moved.
    expect(Math.abs(f.net.debugClockOffsetMs - offsetWhilePlaying)).toBeGreaterThan(1000);
  });

  it('leaves a tab flick alone — the re-sync is gated on the render gap', () => {
    const f = makeFixture();
    playFor(f, 60);
    expect(f.net.debugClockReady).toBe(true);

    // Hidden and back inside one frame, which is what a Ctrl-Tab bounce or a
    // dismissed notification looks like. rAF never stopped.
    f.net.keepaliveTick(true);
    f.frame();
    expect(f.net.renderGapMs).toBeLessThan(RESUME_RESYNC_MS);
    f.net.resumeFromBackground();

    // Nothing was stale, so nothing was thrown away: wiping the interpolation
    // rings here would freeze every remote player for two snapshots.
    expect(f.net.debugClockReady).toBe(true);
  });

  it('keeps the session: same player, same world, no reconnect', () => {
    const f = makeFixture();
    playFor(f, 60);
    const id = f.net.playerId;
    const chunks = f.net.world.chunkCount;
    expect(id).toBeGreaterThan(0);

    f.runHidden(30_000);
    f.net.resumeFromBackground();
    playFor(f, 30);

    expect(f.net.playerId).toBe(id);
    expect(f.net.world.chunkCount).toBeGreaterThanOrEqual(chunks);
    expect(f.net.status).toBe('playing');
  });
});
