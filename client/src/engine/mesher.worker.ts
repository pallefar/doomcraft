/**
 * DOOMCRAFT — chunk meshing worker.
 *
 * The worker keeps its own mirror of the voxel world (one Uint8Array per chunk,
 * 64 KB each) so that meshing needs no data from the main thread at all: a mesh
 * request is four numbers. That matters because assembling the padded 34x66x34
 * neighbourhood touches ~76 000 bytes per chunk, and doing that on the main
 * thread would blow the 16.6 ms frame budget the moment terrain starts
 * streaming.
 *
 * Nothing large is ever copied across the boundary:
 *   - incoming voxel arrays arrive as transferred ArrayBuffers,
 *   - outgoing vertex/index buffers leave as transferred ArrayBuffers,
 *   - the main thread hands spent buffers back (MSG_RECYCLE) into a size-class
 *     free list, so a steady state of rocket craters re-meshing chunks every
 *     frame allocates nothing.
 */

import { blockToChunk, blockToLocal, chunkKey, CHUNK_VOLUME, voxelIndex } from '@doomcraft/shared';
import {
  buildPadded,
  createPadded,
  meshChunk,
  MSG_CHUNK,
  MSG_CLEAR,
  MSG_DROP,
  MSG_EDIT,
  MSG_MESH,
  MSG_RECYCLE,
  MSG_RESULT,
  VERTEX_STRIDE,
  type ChunkFetch,
  type MeshResultLayer,
  type MeshResultMessage,
  type MesherRequest,
} from './mesher';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Chunk key -> voxels. This worker's private mirror of the world. */
const chunks = new Map<number, Uint8Array>();
const pad = createPadded();

const fetchChunk: ChunkFetch = (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null;

/* ------------------------------------------------------------------------ *
 * Output buffer pool
 * ------------------------------------------------------------------------ */

const MIN_CLASS = 4096;
const MAX_PER_CLASS = 6;
const pool = new Map<number, ArrayBuffer[]>();

function sizeClass(bytes: number): number {
  let c = MIN_CLASS;
  while (c < bytes) c *= 2;
  return c;
}

function takeBuffer(bytes: number): ArrayBuffer {
  const cls = sizeClass(bytes);
  const list = pool.get(cls);
  if (list !== undefined && list.length > 0) {
    const b = list.pop();
    if (b !== undefined) return b;
  }
  return new ArrayBuffer(cls);
}

function giveBuffer(buf: ArrayBuffer): void {
  const n = buf.byteLength;
  // Only ever pool buffers this worker minted, i.e. power-of-two size classes.
  if (n < MIN_CLASS || (n & (n - 1)) !== 0) return;
  let list = pool.get(n);
  if (list === undefined) {
    list = [];
    pool.set(n, list);
  }
  if (list.length < MAX_PER_CLASS) list.push(buf);
}

/* ------------------------------------------------------------------------ *
 * Message pump
 * ------------------------------------------------------------------------ */

const outLayers: MeshResultLayer[] = [];
const transfer: ArrayBuffer[] = [];

function runMesh(cx: number, cz: number, job: number, floor: number): void {
  outLayers.length = 0;
  transfer.length = 0;

  const known = buildPadded(pad, cx, cz, fetchChunk, floor);
  let minY = 0;
  let maxY = 0;

  if (known) {
    const res = meshChunk(pad);
    minY = res.minY;
    maxY = res.maxY;
    for (let i = 0; i < res.layers.length; i++) {
      const l = res.layers[i];
      if (l.quadCount === 0) continue;

      const vBytes = l.vertexCount * VERTEX_STRIDE;
      const iBytes = l.indexCount * 4;
      const vBuf = takeBuffer(vBytes);
      const iBuf = takeBuffer(iBytes);
      new Uint8Array(vBuf, 0, vBytes).set(l.vertexBytes);
      new Uint32Array(iBuf, 0, l.indexCount).set(l.indices);

      outLayers.push({
        layer: l.layer,
        vertexCount: l.vertexCount,
        indexCount: l.indexCount,
        vertices: vBuf,
        indices: iBuf,
      });
      transfer.push(vBuf, iBuf);
    }
  }

  const msg: MeshResultMessage = {
    t: MSG_RESULT,
    cx, cz, job, minY, maxY,
    layers: outLayers.slice(),
  };
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = (ev: MessageEvent<MesherRequest>): void => {
  const m = ev.data;
  switch (m.t) {
    case MSG_CHUNK: {
      const voxels = new Uint8Array(m.buf);
      if (voxels.length === CHUNK_VOLUME) chunks.set(chunkKey(m.cx, m.cz), voxels);
      break;
    }
    case MSG_EDIT: {
      const c = chunks.get(chunkKey(blockToChunk(m.x), blockToChunk(m.z)));
      if (c !== undefined && m.y >= 0 && m.y < 64) {
        c[voxelIndex(blockToLocal(m.x), m.y, blockToLocal(m.z))] = m.id;
      }
      break;
    }
    case MSG_MESH:
      runMesh(m.cx, m.cz, m.job, m.floor);
      break;
    case MSG_DROP:
      chunks.delete(chunkKey(m.cx, m.cz));
      break;
    case MSG_RECYCLE:
      giveBuffer(m.buf);
      break;
    case MSG_CLEAR:
      chunks.clear();
      pool.clear();
      break;
    default:
      break;
  }
};
