/**
 * DOOMCRAFT — the local server.
 *
 * The whole authoritative stack (room.ts, sim.ts, world.ts, bots.ts, net.ts)
 * runs inside a module Web Worker and speaks the exact same binary protocol as
 * the real server, over postMessage instead of a socket. That gives us:
 *
 *   - single player and offline play with zero code duplication,
 *   - a match that is live the instant the worker boots — no matchmaking,
 *     which is how we beat the bar's ~25 s cold start,
 *   - one code path to debug: if it works locally it works online.
 *
 * This file is BOTH the main-thread API and the worker entry. It detects which
 * side it is on; the heavy server modules are behind a dynamic import so the
 * main-thread bundle never pays for them.
 */

import type { ClientTransport } from './client.js';

/* ------------------------------------------------------------------------ *
 * Wire between the page and the worker
 * ------------------------------------------------------------------------ */

interface StartMessage {
  t: 'start';
  seed?: number;
  mode?: number;
  botFill?: number;
  enemies?: number;
  latencyMs?: number;
  allWeapons?: boolean;
}
interface StopMessage { t: 'stop' }
interface StatusRequest { t: 'status' }
type ControlToWorker = StartMessage | StopMessage | StatusRequest;

interface ReadyMessage { t: 'ready' }
interface StatusMessage { t: 'status'; status: Record<string, unknown> }
interface ErrorMessage { t: 'error'; message: string }
type ControlToPage = ReadyMessage | StatusMessage | ErrorMessage;

export interface LocalServerOptions {
  seed?: number;
  /** GameMode. Defaults to deathmatch. */
  mode?: number;
  /** Bodies in the match, humans included. Defaults to BOT_FILL_TARGET. */
  botFill?: number;
  /** Doom monsters alive at once. -1 uses the mode default. */
  enemies?: number;
  /** Fake one-way latency in ms, for testing prediction. 0 by default. */
  latencyMs?: number;
  /** Spawn holding all seven weapons. Single player defaults to the arsenal. */
  allWeapons?: boolean;
  /** Skip the Worker and run the server on the main thread. */
  inline?: boolean;
  onStatus?(status: Record<string, unknown>): void;
  onError?(message: string): void;
}

export interface LocalServer {
  /** Hand this to `new NetClient({ transport })`. */
  readonly transport: ClientTransport;
  /** False when the Worker could not start and the server runs inline. */
  readonly inWorker: boolean;
  /** Ask the room for a status snapshot; the answer arrives via `onStatus`. */
  requestStatus(): void;
  stop(): void;
}

/* ------------------------------------------------------------------------ *
 * Environment detection
 * ------------------------------------------------------------------------ */

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

function detectWorkerScope(): WorkerScope | null {
  const g = globalThis as unknown as {
    DedicatedWorkerGlobalScope?: unknown;
    postMessage?: unknown;
    document?: unknown;
  };
  if (typeof g.document !== 'undefined') return null;
  if (typeof g.DedicatedWorkerGlobalScope === 'undefined') return null;
  if (typeof g.postMessage !== 'function') return null;
  return globalThis as unknown as WorkerScope;
}

/* ------------------------------------------------------------------------ *
 * Server side — shared by the worker and the inline fallback
 * ------------------------------------------------------------------------ */

/** The minimum the room's net layer needs from a socket. */
interface ServerSideTransport {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  readonly bufferedAmount: number;
}

interface RoomEndpoint {
  receive(bytes: Uint8Array): void;
  status(): Record<string, unknown>;
  stop(): void;
}

/**
 * Build a Room and wire one connection to it. `deliver` is called with every
 * packet the server produces; feed client packets back in with `receive`.
 */
async function createRoomEndpoint(
  options: StartMessage,
  deliver: (bytes: Uint8Array) => void,
): Promise<RoomEndpoint> {
  // Dynamic so the authoritative stack lands in its own chunk: a player who
  // only ever joins an online match never downloads the simulation.
  const { Room } = await import('@doomcraft/server/src/room.js');

  const latency = Math.max(0, options.latencyMs ?? 0);
  let open = true;
  const pending: Array<ReturnType<typeof setTimeout>> = [];

  const transport: ServerSideTransport = {
    get isOpen(): boolean { return open; },
    get bufferedAmount(): number { return 0; },
    send(data: Uint8Array): void {
      if (!open) return;
      // The buffer is reused by the writer, so copy before it leaves.
      const copy = data.slice();
      if (latency === 0) { deliver(copy); return; }
      const handle = setTimeout(() => {
        const i = pending.indexOf(handle);
        if (i >= 0) pending.splice(i, 1);
        if (open) deliver(copy);
      }, latency);
      pending.push(handle);
    },
    close(): void { open = false; },
  };

  const room = new Room({
    seed: options.seed,
    mode: options.mode,
    botFill: options.botFill,
    enemies: options.enemies,
    allWeapons: options.allWeapons,
    store: null,
    // Trickle the arena in from the spawn outward. Generating all 169 chunks
    // up front would blow the 3 s interactive budget on a phone.
    eagerWorld: false,
    clock: () => nowMs(),
    name: 'local',
  });
  const conn = room.join(transport);
  room.start();

  return {
    receive(bytes: Uint8Array): void {
      if (!open) return;
      if (latency === 0) { room.receive(conn, bytes); return; }
      const handle = setTimeout(() => {
        const i = pending.indexOf(handle);
        if (i >= 0) pending.splice(i, 1);
        if (open) room.receive(conn, bytes);
      }, latency);
      pending.push(handle);
    },
    status(): Record<string, unknown> { return room.status(); },
    stop(): void {
      open = false;
      for (const h of pending) clearTimeout(h);
      pending.length = 0;
      room.leave(conn);
      room.stop();
    },
  };
}

function nowMs(): number {
  const perf = (globalThis as unknown as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/* ------------------------------------------------------------------------ *
 * Worker entry
 * ------------------------------------------------------------------------ */

function bootWorker(scope: WorkerScope): void {
  let endpoint: RoomEndpoint | null = null;
  let starting = false;

  const post = (msg: ControlToPage): void => { scope.postMessage(msg); };

  scope.onmessage = (ev: { data: unknown }): void => {
    const data = ev.data;

    if (data instanceof ArrayBuffer) {
      endpoint?.receive(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      endpoint?.receive(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      return;
    }

    const control = data as ControlToWorker;
    if (!control || typeof control !== 'object') return;

    switch (control.t) {
      case 'start': {
        if (endpoint || starting) return;
        starting = true;
        createRoomEndpoint(control, (bytes) => {
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          scope.postMessage(buffer, [buffer]);
        }).then((ep) => {
          endpoint = ep;
          starting = false;
          post({ t: 'ready' });
        }).catch((err: unknown) => {
          starting = false;
          post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
        });
        break;
      }
      case 'stop':
        endpoint?.stop();
        endpoint = null;
        break;
      case 'status':
        if (endpoint) post({ t: 'status', status: endpoint.status() });
        break;
      default:
        break;
    }
  };
}

const WORKER_SCOPE = detectWorkerScope();
if (WORKER_SCOPE !== null) bootWorker(WORKER_SCOPE);

/* ------------------------------------------------------------------------ *
 * Main-thread API
 * ------------------------------------------------------------------------ */

class LocalTransport implements ClientTransport {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((data: ArrayBuffer | Uint8Array) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  /** Packets sent before the server said it was ready. */
  private readonly queued: Uint8Array[] = [];
  private sink: ((bytes: Uint8Array) => void) | null = null;

  attach(sink: (bytes: Uint8Array) => void): void {
    this.sink = sink;
    this.readyState = 1;
    for (const q of this.queued) sink(q);
    this.queued.length = 0;
    this.onopen?.();
  }

  send(data: Uint8Array): void {
    if (this.readyState > 1) return;
    const copy = data.slice();
    if (this.sink) this.sink(copy);
    else if (this.queued.length < 256) this.queued.push(copy);
  }

  deliver(bytes: ArrayBuffer | Uint8Array): void {
    this.onmessage?.(bytes);
  }

  close(code = 1000, reason = 'local server stopped'): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.sink = null;
    this.onclose?.(code, reason);
  }

  fail(message: string): void {
    this.onerror?.(new Error(message));
  }
}

/**
 * Start the authoritative server for this tab.
 *
 * The returned transport is already usable: packets sent before the worker
 * finishes booting are queued and replayed, so the caller can construct the
 * NetClient and call `connect()` immediately.
 */
export function createLocalServer(options: LocalServerOptions = {}): LocalServer {
  const transport = new LocalTransport();
  const start: StartMessage = {
    t: 'start',
    seed: options.seed,
    mode: options.mode,
    botFill: options.botFill,
    enemies: options.enemies,
    latencyMs: options.latencyMs,
    allWeapons: options.allWeapons,
  };

  let worker: Worker | null = null;
  let inlineEndpoint: RoomEndpoint | null = null;
  let stopped = false;

  const runInline = (): void => {
    void createRoomEndpoint(start, (bytes) => {
      if (!stopped) transport.deliver(bytes);
    }).then((ep) => {
      if (stopped) { ep.stop(); return; }
      inlineEndpoint = ep;
      transport.attach((bytes) => ep.receive(bytes));
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      options.onError?.(message);
      transport.fail(message);
    });
  };

  if (options.inline) {
    runInline();
  } else {
    try {
      worker = new Worker(new URL('./localServer.ts', import.meta.url), {
        type: 'module',
        name: 'doomcraft-local-server',
      });
      worker.onmessage = (ev: MessageEvent): void => {
        const data = ev.data as unknown;
        if (data instanceof ArrayBuffer) { transport.deliver(data); return; }
        const control = data as ControlToPage;
        if (!control || typeof control !== 'object') return;
        if (control.t === 'ready') {
          const w = worker;
          if (!w) return;
          transport.attach((bytes) => {
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            w.postMessage(buffer, [buffer]);
          });
        } else if (control.t === 'status') {
          options.onStatus?.(control.status);
        } else if (control.t === 'error') {
          options.onError?.(control.message);
          transport.fail(control.message);
        }
      };
      worker.onerror = (ev: ErrorEvent): void => {
        options.onError?.(ev.message || 'worker error');
        // A worker that cannot start must not cost the player the match.
        if (!inlineEndpoint && !stopped) {
          worker?.terminate();
          worker = null;
          runInline();
        }
      };
      worker.postMessage(start);
    } catch (err) {
      worker = null;
      options.onError?.(err instanceof Error ? err.message : String(err));
      runInline();
    }
  }

  return {
    transport,
    get inWorker(): boolean { return worker !== null; },
    requestStatus(): void {
      if (worker) worker.postMessage({ t: 'status' } satisfies StatusRequest);
      else if (inlineEndpoint) options.onStatus?.(inlineEndpoint.status());
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      transport.close(1000, 'local server stopped');
      if (worker) {
        try { worker.postMessage({ t: 'stop' } satisfies StopMessage); } catch { /* gone */ }
        worker.terminate();
        worker = null;
      }
      if (inlineEndpoint) { inlineEndpoint.stop(); inlineEndpoint = null; }
    },
  };
}
