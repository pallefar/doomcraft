/**
 * DOOMCRAFT — chunk geometry manager.
 *
 * Owns the worker pool, the GPU geometry for every visible chunk, the upload
 * budget and the culling. One draw call per chunk per render layer, never more.
 *
 * Notable choices:
 *
 *  - **The main thread never stores voxels.** The workers keep the mirror. This
 *    class holds only render state, so the world/physics owner can keep the one
 *    authoritative copy without us doubling 11 MB of it.
 *
 *  - **A precomputed distance-sorted spiral** replaces a per-frame sort. Walking
 *    chunks in spiral order around the camera gives, for free: render-distance
 *    culling, a near-to-far draw order for early-z, a far-to-near order for the
 *    transparent pass, and a nearest-first mesh job queue.
 *
 *  - **Meshes carry their own baked matrices** (`matrixAutoUpdate` and
 *    `matrixWorldAutoUpdate` both off) and `frustumCulled = false`, because this
 *    class culls against a tight chunk AABB instead of three's loose bounding
 *    sphere, and because a chunk never moves.
 *
 *  - **Buffers go home.** Once a geometry is replaced or dropped, its ArrayBuffers
 *    are handed back to a worker two frames later and re-enter its free list, so
 *    a firefight that re-meshes chunks continuously does not churn the heap.
 */

import * as THREE from 'three';
import {
  blockToChunk,
  chunkKey,
  chunkKeyCX,
  chunkKeyCZ,
  CHUNK_HEIGHT,
  CHUNK_SIZE_MASK,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  MAX_MESH_UPLOADS_PER_FRAME,
  MESH_JOBS_IN_FLIGHT,
  MESH_UPLOAD_BUDGET_MS,
  RENDER_DISTANCE_CHUNKS_DESKTOP,
  RENDER_DISTANCE_MAX,
  RenderLayer,
  RENDER_LAYER_COUNT,
  BlockId,
} from '@doomcraft/shared';
import {
  MSG_CHUNK,
  MSG_CLEAR,
  MSG_DROP,
  MSG_EDIT,
  MSG_MESH,
  MSG_RECYCLE,
  MSG_RESULT,
  VA_COLOR_OFFSET,
  VA_DATA_OFFSET,
  VA_POSFACE_OFFSET,
  VERTEX_STRIDE,
  type MeshResultLayer,
  type MeshResultMessage,
} from './mesher';
import type { VoxelMaterials } from './material';

/* ------------------------------------------------------------------------ *
 * Distance-sorted spiral
 * ------------------------------------------------------------------------ */

const SPIRAL_R = RENDER_DISTANCE_MAX;
const SPIRAL_SIDE = SPIRAL_R * 2 + 1;
const SPIRAL_COUNT = SPIRAL_SIDE * SPIRAL_SIDE;
/** dx, dz pairs ordered by squared distance from the centre. */
const SPIRAL_DX = new Int8Array(SPIRAL_COUNT);
const SPIRAL_DZ = new Int8Array(SPIRAL_COUNT);
/** Chebyshev ring index of each entry, so a render-distance test is one compare. */
const SPIRAL_RING = new Uint8Array(SPIRAL_COUNT);
/**
 * One past the last spiral index that can hold a chunk within Chebyshev ring r.
 * The spiral is ordered by EUCLIDEAN distance, so ring 4 entries such as (0,4)
 * sort ahead of ring 3 entries such as (3,3) -- stopping at the first
 * out-of-range ring would silently drop the diagonal corners of the square.
 */
const SPIRAL_END = new Uint16Array(SPIRAL_R + 1);

{
  const order: number[] = [];
  for (let i = 0; i < SPIRAL_COUNT; i++) order.push(i);
  const dxOf = (i: number): number => (i % SPIRAL_SIDE) - SPIRAL_R;
  const dzOf = (i: number): number => Math.floor(i / SPIRAL_SIDE) - SPIRAL_R;
  order.sort((a, b) => {
    const da = dxOf(a) * dxOf(a) + dzOf(a) * dzOf(a);
    const db = dxOf(b) * dxOf(b) + dzOf(b) * dzOf(b);
    return da - db;
  });
  for (let i = 0; i < SPIRAL_COUNT; i++) {
    const k = order[i];
    const dx = dxOf(k);
    const dz = dzOf(k);
    SPIRAL_DX[i] = dx;
    SPIRAL_DZ[i] = dz;
    SPIRAL_RING[i] = Math.max(Math.abs(dx), Math.abs(dz));
  }
  for (let r = 0; r <= SPIRAL_R; r++) {
    let end = 0;
    for (let i = 0; i < SPIRAL_COUNT; i++) if (SPIRAL_RING[i] <= r) end = i + 1;
    SPIRAL_END[r] = end;
  }
}

/* ------------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------------ */

interface ChunkRecord {
  key: number;
  cx: number;
  cz: number;
  /** A worker has this chunk's voxels. */
  loaded: boolean;
  /** Needs re-meshing. */
  dirty: boolean;
  /** Job id currently in flight, 0 when idle. Stale results are dropped. */
  job: number;
  /** Has produced at least one mesh (used for loading progress). */
  meshed: boolean;
  minY: number;
  maxY: number;
  meshes: (THREE.Mesh | null)[];
}

export interface ChunkRendererStats {
  loadedChunks: number;
  meshedChunks: number;
  dirtyChunks: number;
  jobsInFlight: number;
  pendingUploads: number;
  visibleChunks: number;
  drawCalls: number;
  triangles: number;
  lastUploadMs: number;
  workerCount: number;
}

export interface ChunkRendererOptions {
  workerCount?: number;
  maxUploadsPerFrame?: number;
  uploadBudgetMs?: number;
  jobsInFlight?: number;
  renderDistance?: number;
  /** Block filling the y = -1 plane so the world floor emits no skin. */
  floorBlock?: number;
  /** Fired once per finished mesh. Useful for a loading bar. */
  onMeshed?: (cx: number, cz: number, quads: number) => void;
}

interface PendingUpload {
  record: ChunkRecord;
  msg: MeshResultMessage;
}

/* ------------------------------------------------------------------------ *
 * ChunkRenderer
 * ------------------------------------------------------------------------ */

export class ChunkRenderer {
  /** Opaque + cutout chunk meshes, ordered near to far. */
  readonly solidGroup = new THREE.Group();
  /** Transparent chunk meshes, ordered far to near. */
  readonly transparentGroup = new THREE.Group();

  readonly stats: ChunkRendererStats = {
    loadedChunks: 0, meshedChunks: 0, dirtyChunks: 0, jobsInFlight: 0,
    pendingUploads: 0, visibleChunks: 0, drawCalls: 0, triangles: 0,
    lastUploadMs: 0, workerCount: 0,
  };

  private readonly materials: VoxelMaterials;
  private readonly workers: Worker[] = [];
  private readonly records = new Map<number, ChunkRecord>();
  private readonly pending: PendingUpload[] = [];

  private readonly maxUploads: number;
  private readonly uploadBudgetMs: number;
  private readonly maxJobs: number;
  private readonly floorBlock: number;
  private readonly onMeshed: ((cx: number, cz: number, quads: number) => void) | null;

  private renderDistance: number;
  private jobSeq = 1;
  private jobsInFlight = 0;
  private nextWorker = 0;
  private disposed = false;

  // Recycling: buffers wait two frames so no in-flight draw can reference them.
  private recycleNow: ArrayBuffer[] = [];
  private recycleNext: ArrayBuffer[] = [];

  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly cullBox = new THREE.Box3();
  private readonly cullMin = new THREE.Vector3();
  private readonly cullMax = new THREE.Vector3();

  constructor(materials: VoxelMaterials, opts: ChunkRendererOptions = {}) {
    this.materials = materials;
    this.maxUploads = opts.maxUploadsPerFrame ?? MAX_MESH_UPLOADS_PER_FRAME;
    this.uploadBudgetMs = opts.uploadBudgetMs ?? MESH_UPLOAD_BUDGET_MS;
    this.maxJobs = opts.jobsInFlight ?? MESH_JOBS_IN_FLIGHT;
    this.floorBlock = opts.floorBlock ?? BlockId.BEDROCK;
    this.renderDistance = opts.renderDistance ?? RENDER_DISTANCE_CHUNKS_DESKTOP;
    this.onMeshed = opts.onMeshed ?? null;

    this.solidGroup.name = 'chunks';
    this.transparentGroup.name = 'chunks-transparent';
    for (const g of [this.solidGroup, this.transparentGroup]) {
      g.matrixAutoUpdate = false;
      g.matrixWorldAutoUpdate = false;
    }

    const cores = typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
    const want = opts.workerCount ?? (cores >= 8 ? 2 : 1);
    for (let i = 0; i < Math.max(1, want); i++) this.workers.push(this.spawnWorker());
    this.stats.workerCount = this.workers.length;
  }

  /** Add both groups to a scene. */
  attach(scene: THREE.Scene): void {
    scene.add(this.solidGroup);
    scene.add(this.transparentGroup);
  }

  private spawnWorker(): Worker {
    const w = new Worker(new URL('./mesher.worker.ts', import.meta.url), {
      type: 'module',
      name: 'dc-mesher',
    });
    w.onmessage = (ev: MessageEvent<MeshResultMessage>): void => this.onResult(ev.data);
    w.onerror = (ev: ErrorEvent): void => {
      console.error('[mesher] worker error', ev.message);
    };
    return w;
  }

  /* -- data in ----------------------------------------------------------- */

  /**
   * Publish a chunk's voxels. The array is copied once per worker and
   * transferred, so the caller keeps ownership of `voxels`.
   *
   * Marks the chunk and its eight neighbours dirty: a neighbour's boundary
   * faces are only correct once both sides are known.
   */
  setChunk(cx: number, cz: number, voxels: Uint8Array): void {
    if (this.disposed || voxels.length !== CHUNK_VOLUME) return;
    for (let i = 0; i < this.workers.length; i++) {
      const copy = voxels.slice().buffer;
      this.workers[i].postMessage({ t: MSG_CHUNK, cx, cz, buf: copy }, [copy]);
    }
    const rec = this.record(cx, cz);
    rec.loaded = true;
    rec.dirty = true;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = this.records.get(chunkKey(cx + dx, cz + dz));
        if (n !== undefined && n.loaded) n.dirty = true;
      }
    }
  }

  /** True once this chunk's voxels have been published to the workers. */
  hasChunk(cx: number, cz: number): boolean {
    const r = this.records.get(chunkKey(cx, cz));
    return r !== undefined && r.loaded;
  }

  /** True once this chunk has produced geometry at least once. */
  isMeshed(cx: number, cz: number): boolean {
    const r = this.records.get(chunkKey(cx, cz));
    return r !== undefined && r.meshed;
  }

  /**
   * Apply one block change in WORLD coordinates. Dirties the owning chunk plus
   * any neighbour whose skirt contains this voxel.
   */
  setBlock(x: number, y: number, z: number, id: number): void {
    if (this.disposed || y < 0 || y >= CHUNK_HEIGHT) return;
    for (let i = 0; i < this.workers.length; i++) {
      this.workers[i].postMessage({ t: MSG_EDIT, x, y, z, id });
    }
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    this.dirty(cx, cz);
    const lx = x & CHUNK_SIZE_MASK;
    const lz = z & CHUNK_SIZE_MASK;
    const onMinX = lx === 0, onMaxX = lx === CHUNK_SIZE_X - 1;
    const onMinZ = lz === 0, onMaxZ = lz === CHUNK_SIZE_Z - 1;
    if (onMinX) this.dirty(cx - 1, cz);
    if (onMaxX) this.dirty(cx + 1, cz);
    if (onMinZ) this.dirty(cx, cz - 1);
    if (onMaxZ) this.dirty(cx, cz + 1);
    if (onMinX && onMinZ) this.dirty(cx - 1, cz - 1);
    if (onMaxX && onMinZ) this.dirty(cx + 1, cz - 1);
    if (onMinX && onMaxZ) this.dirty(cx - 1, cz + 1);
    if (onMaxX && onMaxZ) this.dirty(cx + 1, cz + 1);
  }

  /** Force a re-mesh, e.g. after a bulk edit applied through setBlock's siblings. */
  markDirty(cx: number, cz: number): void {
    this.dirty(cx, cz);
  }

  private dirty(cx: number, cz: number): void {
    const r = this.records.get(chunkKey(cx, cz));
    if (r !== undefined && r.loaded) r.dirty = true;
  }

  private record(cx: number, cz: number): ChunkRecord {
    const key = chunkKey(cx, cz);
    let r = this.records.get(key);
    if (r === undefined) {
      r = {
        key, cx, cz,
        loaded: false, dirty: false, job: 0, meshed: false,
        minY: 0, maxY: CHUNK_HEIGHT,
        meshes: [null, null, null],
      };
      this.records.set(key, r);
    }
    return r;
  }

  /** Drop a chunk entirely: geometry, worker mirror, record. */
  removeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const r = this.records.get(key);
    if (r === undefined) return;
    this.freeMeshes(r);
    this.records.delete(key);
    for (let i = 0; i < this.workers.length; i++) {
      this.workers[i].postMessage({ t: MSG_DROP, cx, cz });
    }
  }

  /** Drop everything. Keeps the workers alive. */
  clear(): void {
    for (const r of this.records.values()) this.freeMeshes(r);
    this.records.clear();
    this.pending.length = 0;
    this.jobsInFlight = 0;
    for (let i = 0; i < this.workers.length; i++) {
      this.workers[i].postMessage({ t: MSG_CLEAR });
    }
  }

  setRenderDistance(chunks: number): void {
    this.renderDistance = Math.max(1, Math.min(RENDER_DISTANCE_MAX, Math.round(chunks)));
  }

  get currentRenderDistance(): number {
    return this.renderDistance;
  }

  /* -- worker results ---------------------------------------------------- */

  private onResult(msg: MeshResultMessage): void {
    if (this.disposed || msg.t !== MSG_RESULT) return;
    this.jobsInFlight--;
    const rec = this.records.get(chunkKey(msg.cx, msg.cz));
    if (rec === undefined || rec.job !== msg.job) {
      // Stale: the chunk was dropped or re-queued. Return the memory.
      for (let i = 0; i < msg.layers.length; i++) {
        this.recycleNext.push(msg.layers[i].vertices, msg.layers[i].indices);
      }
      return;
    }
    rec.job = 0;
    this.pending.push({ record: rec, msg });
  }

  /* -- per frame --------------------------------------------------------- */

  /**
   * Pump the pipeline: uploads, culling, ordering, new jobs. Call once per frame
   * before rendering, with the camera already positioned for this frame.
   */
  update(camera: THREE.PerspectiveCamera): void {
    if (this.disposed) return;

    const camChunkX = Math.floor(camera.position.x / CHUNK_SIZE_X);
    const camChunkZ = Math.floor(camera.position.z / CHUNK_SIZE_Z);

    this.flushRecycle();
    this.drainUploads();
    this.cullAndOrder(camera, camChunkX, camChunkZ);
    this.dispatch(camChunkX, camChunkZ);
    this.refreshStats();
  }

  private flushRecycle(): void {
    const list = this.recycleNow;
    for (let i = 0; i < list.length; i++) {
      const buf = list[i];
      const w = this.workers[this.nextWorker];
      this.nextWorker = (this.nextWorker + 1) % this.workers.length;
      try {
        w.postMessage({ t: MSG_RECYCLE, buf }, [buf]);
      } catch {
        // A detached buffer just means it already went home. Nothing to do.
      }
    }
    list.length = 0;
    this.recycleNow = this.recycleNext;
    this.recycleNext = list;
  }

  private drainUploads(): void {
    const t0 = performance.now();
    let done = 0;
    while (this.pending.length > 0 && done < this.maxUploads) {
      const item = this.pending.shift();
      if (item === undefined) break;
      this.applyMesh(item.record, item.msg);
      done++;
      if (performance.now() - t0 >= this.uploadBudgetMs) break;
    }
    this.stats.lastUploadMs = performance.now() - t0;
  }

  private applyMesh(rec: ChunkRecord, msg: MeshResultMessage): void {
    rec.minY = msg.minY;
    rec.maxY = msg.maxY;

    // Layers absent from the message are now empty and must lose their mesh.
    let present = 0;
    for (let i = 0; i < msg.layers.length; i++) present |= 1 << msg.layers[i].layer;
    for (let l = 0; l < RENDER_LAYER_COUNT; l++) {
      if ((present & (1 << l)) === 0) this.freeMesh(rec, l);
    }

    for (let i = 0; i < msg.layers.length; i++) {
      const layer = msg.layers[i];
      const geo = this.buildGeometry(layer, msg.minY, msg.maxY);
      const existing = rec.meshes[layer.layer];
      if (existing !== null) {
        this.recycleGeometry(existing.geometry);
        existing.geometry.dispose();
        existing.geometry = geo;
      } else {
        const mesh = new THREE.Mesh(geo, this.materials.byLayer(layer.layer));
        mesh.name = `chunk ${rec.cx},${rec.cz} L${layer.layer}`;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldAutoUpdate = false;
        mesh.matrix.makeTranslation(rec.cx * CHUNK_SIZE_X, 0, rec.cz * CHUNK_SIZE_Z);
        mesh.matrixWorld.copy(mesh.matrix);
        mesh.raycast = noRaycast;
        rec.meshes[layer.layer] = mesh;
      }
    }

    rec.meshed = true;
    if (this.onMeshed !== null) {
      let quads = 0;
      for (let i = 0; i < msg.layers.length; i++) quads += msg.layers[i].indexCount / 6;
      this.onMeshed(rec.cx, rec.cz, quads);
    }
  }

  private buildGeometry(
    layer: MeshResultLayer, minY: number, maxY: number,
  ): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const verts = new Uint8Array(layer.vertices, 0, layer.vertexCount * VERTEX_STRIDE);
    const ib = new THREE.InterleavedBuffer(verts, VERTEX_STRIDE);
    ib.setUsage(THREE.StaticDrawUsage);
    g.setAttribute('aPosFace', new THREE.InterleavedBufferAttribute(ib, 4, VA_POSFACE_OFFSET, false));
    g.setAttribute('aData', new THREE.InterleavedBufferAttribute(ib, 4, VA_DATA_OFFSET, false));
    g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(ib, 4, VA_COLOR_OFFSET, true));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(layer.indices, 0, layer.indexCount), 1));

    // Bake the bounds: three would otherwise scan the vertex buffer, and it
    // cannot anyway because there is no attribute called `position`.
    const box = new THREE.Box3(
      new THREE.Vector3(0, minY, 0),
      new THREE.Vector3(CHUNK_SIZE_X, maxY, CHUNK_SIZE_Z),
    );
    g.boundingBox = box;
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    g.boundingSphere = sphere;
    return g;
  }

  private cullAndOrder(camera: THREE.PerspectiveCamera, camChunkX: number, camChunkZ: number): void {
    // Cull against where the camera is NOW, not where it was when three last
    // rendered. Screen shake moves the camera after the controller runs, so a
    // stale matrixWorldInverse pops chunks in at the edge of the view.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    const solid = this.solidGroup.children;
    const trans = this.transparentGroup.children;
    solid.length = 0;
    trans.length = 0;

    const rd = this.renderDistance;
    let visible = 0;
    let draws = 0;
    let tris = 0;

    // Near to far. Opaque wants this for early-z.
    const end = SPIRAL_END[rd];
    for (let s = 0; s < end; s++) {
      if (SPIRAL_RING[s] > rd) continue;
      const rec = this.records.get(chunkKey(camChunkX + SPIRAL_DX[s], camChunkZ + SPIRAL_DZ[s]));
      if (rec === undefined || !rec.meshed) continue;
      if (!this.inFrustum(rec)) continue;
      visible++;
      const opaque = rec.meshes[RenderLayer.OPAQUE];
      const cutout = rec.meshes[RenderLayer.CUTOUT];
      if (opaque !== null) { solid.push(opaque); draws++; tris += triCount(opaque); }
      if (cutout !== null) { solid.push(cutout); draws++; tris += triCount(cutout); }
    }

    // Far to near. Alpha blending demands the opposite order.
    for (let s = end - 1; s >= 0; s--) {
      if (SPIRAL_RING[s] > rd) continue;
      const rec = this.records.get(chunkKey(camChunkX + SPIRAL_DX[s], camChunkZ + SPIRAL_DZ[s]));
      if (rec === undefined || !rec.meshed) continue;
      const t = rec.meshes[RenderLayer.TRANSPARENT];
      if (t === null) continue;
      if (!this.inFrustum(rec)) continue;
      trans.push(t);
      draws++;
      tris += triCount(t);
    }

    this.stats.visibleChunks = visible;
    this.stats.drawCalls = draws;
    this.stats.triangles = tris;
  }

  private inFrustum(rec: ChunkRecord): boolean {
    const ox = rec.cx * CHUNK_SIZE_X;
    const oz = rec.cz * CHUNK_SIZE_Z;
    this.cullMin.set(ox, rec.minY, oz);
    this.cullMax.set(ox + CHUNK_SIZE_X, rec.maxY, oz + CHUNK_SIZE_Z);
    this.cullBox.set(this.cullMin, this.cullMax);
    return this.frustum.intersectsBox(this.cullBox);
  }

  private dispatch(camChunkX: number, camChunkZ: number): void {
    const rd = this.renderDistance;
    // One extra ring: a chunk at the edge of the view needs its neighbour's
    // voxels to have been meshed before the player walks into it.
    const limit = Math.min(RENDER_DISTANCE_MAX, rd + 1);
    const end = SPIRAL_END[limit];
    for (let s = 0; s < end && this.jobsInFlight < this.maxJobs; s++) {
      if (SPIRAL_RING[s] > limit) continue;
      const rec = this.records.get(chunkKey(camChunkX + SPIRAL_DX[s], camChunkZ + SPIRAL_DZ[s]));
      if (rec === undefined || !rec.loaded || !rec.dirty || rec.job !== 0) continue;
      rec.dirty = false;
      rec.job = this.jobSeq++;
      const w = this.workers[this.nextWorker];
      this.nextWorker = (this.nextWorker + 1) % this.workers.length;
      w.postMessage({
        t: MSG_MESH, cx: rec.cx, cz: rec.cz, job: rec.job, floor: this.floorBlock,
      });
      this.jobsInFlight++;
    }
  }

  private refreshStats(): void {
    let loaded = 0;
    let meshed = 0;
    let dirty = 0;
    for (const r of this.records.values()) {
      if (r.loaded) loaded++;
      if (r.meshed) meshed++;
      if (r.dirty) dirty++;
    }
    this.stats.loadedChunks = loaded;
    this.stats.meshedChunks = meshed;
    this.stats.dirtyChunks = dirty;
    this.stats.jobsInFlight = this.jobsInFlight;
    this.stats.pendingUploads = this.pending.length;
  }

  /* -- teardown ---------------------------------------------------------- */

  private recycleGeometry(g: THREE.BufferGeometry): void {
    const attr = g.getAttribute('aPosFace');
    if (attr !== undefined && (attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
      const data = (attr as THREE.InterleavedBufferAttribute).data;
      this.recycleNext.push(data.array.buffer as ArrayBuffer);
    }
    const index = g.getIndex();
    if (index !== null) this.recycleNext.push(index.array.buffer as ArrayBuffer);
  }

  private freeMesh(rec: ChunkRecord, layer: number): void {
    const mesh = rec.meshes[layer];
    if (mesh === null) return;
    this.recycleGeometry(mesh.geometry);
    mesh.geometry.dispose();
    rec.meshes[layer] = null;
  }

  private freeMeshes(rec: ChunkRecord): void {
    for (let l = 0; l < RENDER_LAYER_COUNT; l++) this.freeMesh(rec, l);
    rec.meshed = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.records.values()) this.freeMeshes(r);
    this.records.clear();
    this.solidGroup.children.length = 0;
    this.transparentGroup.children.length = 0;
    this.pending.length = 0;
    this.recycleNow.length = 0;
    this.recycleNext.length = 0;
    for (let i = 0; i < this.workers.length; i++) this.workers[i].terminate();
    this.workers.length = 0;
  }

  /** Debug helper: every chunk this renderer knows about, as packed keys. */
  keys(): number[] {
    return Array.from(this.records.keys());
  }

  /** Debug helper: unpack a key produced by `keys()`. */
  static unpackKey(key: number): [number, number] {
    return [chunkKeyCX(key), chunkKeyCZ(key)];
  }
}

function triCount(mesh: THREE.Mesh): number {
  const idx = mesh.geometry.getIndex();
  return idx === null ? 0 : idx.count / 3;
}

function noRaycast(): void {
  // Chunk geometry has no `position` attribute; voxel picking goes through
  // raycastVoxels() against the authoritative voxel store, not through three.
}
