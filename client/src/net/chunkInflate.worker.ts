/**
 * DOOMCRAFT — the chunk inflate worker.
 *
 * A joining client is sent the whole 169-chunk arena. On the wire that is
 * 2.99 MB uncompressed, or 0.79 MB once the server raw-deflates the RLE stream
 * (`S2C.CHUNK_Z`). Somebody has to inflate it, and it must not be the main
 * thread: this project spends its frame budget on rendering, and a 3 MB inflate
 * plus 169 RLE expansions is exactly the kind of work that turns a 16.7 ms
 * frame into a visible hitch during the one part of the session — the load —
 * where the player is already staring at a progress bar.
 *
 * The mesher already runs in a worker for the same reason. This is the same
 * discipline applied to the receive path.
 *
 * It does BOTH halves of the decode, not just the inflate: the RLE expansion
 * that `client.ts` used to run inline moves here too, so the main thread's
 * per-chunk cost drops from "inflate + RLE + a 64 KB allocation" to "take
 * ownership of a transferred buffer". Net main-thread work on the chunk path
 * goes *down* against the uncompressed path it replaces.
 *
 * Protocol (both directions transfer their buffer, so nothing is copied):
 *   page -> worker  { cx, cz, seq, rleLen, buf }   buf = raw-deflate bytes
 *   worker -> page  { cx, cz, seq, voxels }        voxels = CHUNK_VOLUME bytes
 *                   { cx, cz, seq, err }           decode failed, tell the page
 */

import { CHUNK_VOLUME, rleDecode } from '@shared';

export interface InflateRequest {
  cx: number;
  cz: number;
  /** Session epoch; echoed back so a stale result from a dead session is dropped. */
  seq: number;
  /** Byte length of the RLE stream once inflated. */
  rleLen: number;
  buf: ArrayBuffer;
}

export interface InflateResult {
  cx: number;
  cz: number;
  seq: number;
  /** Present on success. CHUNK_VOLUME bytes, in voxelIndex() order. */
  voxels?: ArrayBuffer;
  /** Present on failure. */
  err?: string;
}

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

/**
 * `DecompressionStream` is the browser's own zlib — no shipped inflate code, no
 * bytes on the critical path. The write side is deliberately not awaited: the
 * stream applies backpressure until the reader pulls, so awaiting the write
 * before starting to read deadlocks. Kick the write off, then drain.
 */
async function inflateRaw(src: Uint8Array, outLen: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  void writer.write(src).catch(() => { /* surfaces on the read side */ });
  void writer.close().catch(() => { /* ditto */ });

  const out = new Uint8Array(outLen);
  const reader = ds.readable.getReader();
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    // A server that lied about `rleLen` must not be able to write past the
    // buffer, and must not be able to make us grow one either.
    if (off + value.length > outLen) throw new Error('inflate overflow');
    out.set(value, off);
    off += value.length;
  }
  if (off !== outLen) throw new Error(`inflate short: ${off}/${outLen}`);
  return out;
}

/**
 * One at a time. Chunks arrive in bursts of up to a dozen per tick and each is
 * independent, so concurrency would buy nothing but a dozen simultaneous zlib
 * contexts and a dozen live 64 KB output arrays.
 */
let queue: Promise<void> = Promise.resolve();

async function handle(msg: InflateRequest): Promise<void> {
  try {
    const rle = await inflateRaw(new Uint8Array(msg.buf), msg.rleLen);
    const voxels = new Uint8Array(CHUNK_VOLUME);
    rleDecode(rle, 0, msg.rleLen, voxels);
    const result: InflateResult = { cx: msg.cx, cz: msg.cz, seq: msg.seq, voxels: voxels.buffer };
    scope.postMessage(result, [voxels.buffer]);
  } catch (e) {
    const result: InflateResult = {
      cx: msg.cx, cz: msg.cz, seq: msg.seq,
      err: e instanceof Error ? e.message : String(e),
    };
    scope.postMessage(result);
  }
}

scope.onmessage = (ev: { data: unknown }): void => {
  const msg = ev.data as InflateRequest | null;
  if (msg === null || typeof msg !== 'object' || !(msg.buf instanceof ArrayBuffer)) return;
  queue = queue.then(() => handle(msg));
};
