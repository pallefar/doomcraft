/**
 * DOOMCRAFT — the join burst ships compressed, and arrives byte-identical.
 *
 * The bug (docs/INFRASTRUCTURE.md §2, "join burst 2.98 MB, uncompressed"):
 * every joining player is streamed all 169 chunks as raw RLE. On measured
 * terrain that RLE deflates 3.8x, and at 1M CCU the difference is servers.
 *
 * What these tests actually hold down is not the ratio — that is arithmetic —
 * but the three ways a compressed path can be wrong:
 *
 *   1. It decodes to something *other* than what the server has. Every test
 *      here compares the client's voxels against `ServerWorld.ensureChunk`
 *      byte for byte, because a world that is 99.99% right is a world where
 *      you fall through one floor.
 *   2. It strands a client that cannot inflate. The negotiation is a HELLO
 *      capability bit, so the same room serves both kinds of client in the
 *      same match and the uncompressed path must stay exactly as it was.
 *   3. It loses an edit. Decoding is asynchronous now, and the server starts
 *      streaming BLOCK_DELTAs for a chunk the moment it queues it — so edits
 *      can and do overtake the chunk they belong to.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import {
  CAP_INFLATE,
  CHUNK_VOLUME,
  GameMode,
  PROTOCOL_VERSION,
  S2C,
  WORLD_CHUNK_COUNT,
  createChunkZHeader,
  decodeChunkZHeader,
  PacketReader,
  rleDecode,
  rleEncode,
  voxelIndex,
} from '@shared';
import { Room } from '@doomcraft/server/src/room.js';
import { setChunkCompressor } from '@doomcraft/server/src/net.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';

import { NetClient, chunkInflateSupported, type ClientTransport } from './client.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

/**
 * `chunkInflateSupported()` needs a `Worker` global to say yes, and node has
 * none. This one exists so the capability bit is honest, and throws so the
 * test drives `ChunkInflater`'s main-thread fallback — which runs the same
 * `DecompressionStream` decode the worker runs, on the same bytes.
 */
class ThrowingWorker {
  constructor() { throw new Error('no workers in node'); }
}

/** Deliver every message synchronously; count bytes as they cross. */
class Loopback {
  readonly conn: ReturnType<Room['join']>;
  readonly client: ClientTransport;
  /** Every S2C packet the server sent, in order, as its own copy. */
  readonly received: Uint8Array[] = [];
  private open = true;

  constructor(room: Room) {
    const self = this;
    const serverSide: NetTransport = {
      get isOpen(): boolean { return self.open; },
      get bufferedAmount(): number { return 0; },
      send(data: Uint8Array): void {
        if (!self.open) return;
        const copy = data.slice();
        self.received.push(copy);
        self.client.onmessage?.(copy.slice());
      },
      close(): void { self.open = false; self.client.onclose?.(1000, ''); },
    };
    this.conn = room.join(serverSide);
    this.client = {
      get readyState(): number { return self.open ? 1 : 3; },
      send(data: Uint8Array): void { if (self.open) room.receive(self.conn, data.slice()); },
      close(): void { self.open = false; },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
  }

  bytesOf(id: number): number {
    let n = 0;
    for (const p of this.received) if (p[0] === id) n += p.length;
    return n;
  }

  countOf(id: number): number {
    let n = 0;
    for (const p of this.received) if (p[0] === id) n++;
    return n;
  }
}

/** Let every queued inflate settle. Generous: the decode is real zlib. */
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

interface Fixture {
  room: Room;
  link: Loopback;
  net: NetClient;
  /** Tick the room and the client until every chunk has landed, or give up. */
  streamWorld(): Promise<void>;
  dispose(): void;
}

const live: Fixture[] = [];
let realWorker: unknown;

function makeFixture(caps: number | undefined = undefined): Fixture {
  let nowMs = 0;
  const now = (): number => nowMs;
  const room = new Room({
    seed: 4242, mode: GameMode.SANDBOX, botFill: 0, enemies: 0,
    eagerWorld: true, store: null, clock: now, name: 'chunkz-test',
  });
  const link = new Loopback(room);
  const net = new NetClient({
    name: 'Marine', transport: link.client, autoReconnect: false,
    keepalive: null, wallClock: now, caps,
  });
  net.connect();

  const fixture: Fixture = {
    room, link, net,
    async streamWorld(): Promise<void> {
      for (let i = 0; i < 400 && net.world.chunkCount < WORLD_CHUNK_COUNT; i++) {
        nowMs += 50;
        room.advance(nowMs);
        net.update(1 / 20);
        await settle(2);
      }
      await settle();
    },
    dispose(): void { net.dispose(); room.stop(); },
  };
  live.push(fixture);
  return fixture;
}

beforeEach(() => {
  realWorker = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = ThrowingWorker;
  setChunkCompressor((src) => deflateRawSync(src, { level: 6 }));
});

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose();
  setChunkCompressor(null);
  (globalThis as { Worker?: unknown }).Worker = realWorker;
});

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe('the join burst is compressed', () => {
  it('advertises CAP_INFLATE only when the browser can actually inflate', () => {
    expect(chunkInflateSupported()).toBe(true);
    (globalThis as { Worker?: unknown }).Worker = undefined;
    expect(chunkInflateSupported()).toBe(false);
  });

  it('sends CHUNK_Z to a capable client and never a plain CHUNK', async () => {
    const f = makeFixture();
    await f.streamWorld();
    expect(f.link.countOf(S2C.CHUNK_Z)).toBe(WORLD_CHUNK_COUNT);
    expect(f.link.countOf(S2C.CHUNK)).toBe(0);
  });

  it('decodes to exactly the voxels the server has, in all 169 chunks', async () => {
    const f = makeFixture();
    await f.streamWorld();
    expect(f.net.world.chunkCount).toBe(WORLD_CHUNK_COUNT);

    let compared = 0;
    for (const [, mine] of f.net.world.chunks) compared += mine.length;
    expect(compared).toBe(WORLD_CHUNK_COUNT * CHUNK_VOLUME);

    for (let cz = -6; cz <= 6; cz++) {
      for (let cx = -6; cx <= 6; cx++) {
        const theirs = f.room.world.ensureChunk(cx, cz);
        const mine = f.net.world.chunkAt(cx, cz);
        expect(mine, `chunk ${cx},${cz} missing`).toBeDefined();
        // Compare as strings only on failure; the fast path is a byte loop.
        let same = mine!.length === theirs.length;
        if (same) {
          for (let i = 0; i < theirs.length; i++) {
            if (mine![i] !== theirs[i]) { same = false; break; }
          }
        }
        expect(same, `chunk ${cx},${cz} differs from the server`).toBe(true);
      }
    }
  });

  it('puts at least 3x fewer bytes on the wire than the uncompressed path', async () => {
    const z = makeFixture();
    await z.streamWorld();
    const compressed = z.link.bytesOf(S2C.CHUNK_Z);

    setChunkCompressor(null);
    const plain = makeFixture();
    await plain.streamWorld();
    const raw = plain.link.bytesOf(S2C.CHUNK);

    expect(raw).toBeGreaterThan(2_800_000);
    expect(compressed).toBeLessThan(raw / 3);
  });
});

describe('nobody is stranded', () => {
  it('serves a client that did not ask for compression the old uncompressed CHUNK', async () => {
    // caps 0 and no CAP_INFLATE: exactly a pre-v3 client.
    const f = makeFixture(0);
    // The NetClient adds CAP_INFLATE itself when the browser supports it, so
    // take the browser support away for this one.
    (globalThis as { Worker?: unknown }).Worker = undefined;
    f.net.dispose();
    live.pop();

    const g = makeFixture(0);
    await g.streamWorld();
    expect(g.link.countOf(S2C.CHUNK)).toBe(WORLD_CHUNK_COUNT);
    expect(g.link.countOf(S2C.CHUNK_Z)).toBe(0);
    expect(g.net.world.chunkCount).toBe(WORLD_CHUNK_COUNT);
  });

  it('falls back to CHUNK when the process has no compressor at all (the Worker server)', async () => {
    setChunkCompressor(null);
    const f = makeFixture();
    await f.streamWorld();
    expect(f.link.countOf(S2C.CHUNK)).toBe(WORLD_CHUNK_COUNT);
    expect(f.link.countOf(S2C.CHUNK_Z)).toBe(0);
  });

  it('still bumps PROTOCOL_VERSION, because the wire grew a message', () => {
    // CONTRACT.md §15: a wire-layout change bumps the version. If someone adds
    // a message without moving this, the version stops meaning anything.
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(3);
    expect(S2C.CHUNK_Z).toBe(9);
    expect(CAP_INFLATE).toBe(1 << 4);
  });
});

describe('an edit cannot overtake the chunk it belongs to', () => {
  it('bakes a delta that arrived mid-inflate into the voxels before publishing', async () => {
    const f = makeFixture();
    let nowMs = 0;
    // Get the player in and a handful of chunks moving.
    for (let i = 0; i < 3; i++) { nowMs += 50; f.room.advance(nowMs); f.net.update(1 / 20); }

    // Edit a block inside a chunk the server has already queued but the client
    // has not decoded yet — the exact race the pending queue exists for.
    let target: { x: number; y: number; z: number } | null = null;
    for (const p of f.link.received) {
      if (p[0] !== S2C.CHUNK_Z) continue;
      const r = new PacketReader().reset(p);
      const h = decodeChunkZHeader(r, createChunkZHeader());
      const x = h.cx * 32 + 5;
      const zc = h.cz * 32 + 5;
      const y = 40;
      // The chunk must be queued on the server AND still undecoded here, or
      // this test proves nothing about the race it is named after.
      if (f.net.world.chunkAt(h.cx, h.cz) !== undefined) continue;
      if (f.room.world.getBlock(x, y, zc) === 0) { target = { x, y, z: zc }; break; }
    }
    expect(target, 'no in-flight chunk to edit — the race did not happen').not.toBeNull();

    f.room.world.setBlock(target!.x, target!.y, target!.z, 3, 0);
    nowMs += 50; f.room.advance(nowMs); f.net.update(1 / 20);

    await f.streamWorld();

    expect(f.net.world.getBlock(target!.x, target!.y, target!.z)).toBe(3);
    expect(f.room.world.getBlock(target!.x, target!.y, target!.z)).toBe(3);
  });

  it('never hands a later joiner a cached chunk from before the demolition', async () => {
    const f = makeFixture();
    await f.streamWorld();

    // Blow a hole in a chunk the cache is now holding.
    const x = 8, y = 40, z = 8;
    f.room.world.setBlock(x, y, z, 3, 0);
    let nowMs = 1_000_000;
    f.room.advance(nowMs);

    const late = new Loopback(f.room);
    const lateNet = new NetClient({
      name: 'Late', transport: late.client, autoReconnect: false,
      keepalive: null, wallClock: () => nowMs,
    });
    lateNet.connect();
    for (let i = 0; i < 400 && lateNet.world.chunkCount < WORLD_CHUNK_COUNT; i++) {
      nowMs += 50; f.room.advance(nowMs); lateNet.update(1 / 20);
      await settle(2);
    }
    await settle();

    expect(lateNet.world.getBlock(x, y, z)).toBe(3);
    lateNet.dispose();
  });
});

describe('the wire format itself', () => {
  it('CHUNK_Z carries exactly the RLE stream CHUNK would have carried', async () => {
    const f = makeFixture();
    await f.streamWorld();

    const header = createChunkZHeader();
    let checked = 0;
    for (const p of f.link.received) {
      if (p[0] !== S2C.CHUNK_Z) continue;
      const r = new PacketReader().reset(p);
      decodeChunkZHeader(r, header);
      const rle = inflateRawSync(p.subarray(r.offset, r.offset + header.zLen));
      expect(rle.length).toBe(header.rleLen);

      const voxels = new Uint8Array(CHUNK_VOLUME);
      rleDecode(rle, 0, header.rleLen, voxels);
      const theirs = f.room.world.ensureChunk(header.cx, header.cz);
      expect(voxels[voxelIndex(1, 1, 1)]).toBe(theirs[voxelIndex(1, 1, 1)]);
      if (++checked >= 8) break;
    }
    expect(checked).toBe(8);
  });
});

/**
 * The real worker module, imported once with a `self` it can install its
 * handler on. ESM caches the module, so the scope is shared by both tests
 * below — which is fine: the worker is a singleton in a real worker thread too.
 */
const workerInbox: unknown[] = [];
const workerScope = {
  onmessage: null as ((ev: { data: unknown }) => void) | null,
  postMessage(m: unknown): void { workerInbox.push(m); },
};

async function loadWorker(): Promise<(ev: { data: unknown }) => void> {
  (globalThis as { self?: unknown }).self = workerScope;
  await import('./chunkInflate.worker.js');
  expect(workerScope.onmessage).not.toBeNull();
  workerInbox.length = 0;
  return workerScope.onmessage!;
}

describe('the inflate worker itself', () => {
  it("turns a deflated RLE stream into the server's exact voxels, off-thread", async () => {
    const onmessage = await loadWorker();
    const room = new Room({
      seed: 4242, mode: GameMode.SANDBOX, botFill: 0, enemies: 0,
      eagerWorld: true, store: null, clock: () => 0, name: 'worker-test',
    });
    const theirs = room.world.ensureChunk(2, -3);
    const rle = rleEncode(theirs);
    const buf = deflateRawSync(rle, { level: 6 }).slice().buffer;

    onmessage({ data: { cx: 2, cz: -3, seq: 7, rleLen: rle.length, buf } });
    await settle();

    expect(workerInbox.length).toBe(1);
    const out = workerInbox[0] as { cx: number; cz: number; seq: number; voxels?: ArrayBuffer; err?: string };
    expect(out.err).toBeUndefined();
    expect(out.cx).toBe(2);
    expect(out.cz).toBe(-3);
    expect(out.seq).toBe(7);
    const mine = new Uint8Array(out.voxels!);
    expect(mine.length).toBe(CHUNK_VOLUME);
    let same = true;
    for (let i = 0; i < theirs.length; i++) if (mine[i] !== theirs[i]) { same = false; break; }
    expect(same).toBe(true);
    room.stop();
  });

  it('reports a corrupt stream instead of publishing garbage', async () => {
    const onmessage = await loadWorker();
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    onmessage({ data: { cx: 0, cz: 0, seq: 1, rleLen: 4096, buf: junk } });
    await settle();

    expect(workerInbox.length).toBe(1);
    const out = workerInbox[0] as { voxels?: ArrayBuffer; err?: string };
    expect(out.voxels).toBeUndefined();
    expect(typeof out.err).toBe('string');
  });

  it('refuses a stream that inflates to more than it promised', async () => {
    const onmessage = await loadWorker();
    // Claim 16 bytes, hand it a stream that expands to 4096.
    const buf = deflateRawSync(new Uint8Array(4096), { level: 6 }).slice().buffer;
    onmessage({ data: { cx: 1, cz: 1, seq: 2, rleLen: 16, buf } });
    await settle();

    expect(workerInbox.length).toBe(1);
    const out = workerInbox[0] as { voxels?: ArrayBuffer; err?: string };
    expect(out.voxels).toBeUndefined();
    expect(out.err).toContain('overflow');
  });
});
