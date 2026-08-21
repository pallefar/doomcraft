/**
 * DOOMCRAFT — the keepalive clock.
 *
 * This worker exists for exactly one reason: **a background tab's own timers
 * are not fast enough to keep a match alive.**
 *
 *   - `requestAnimationFrame` is throttled to ~1 Hz in a hidden tab and stops
 *     outright when the tab is occluded or the compositor gives up on it.
 *   - `setInterval` on the page is clamped to 1 Hz while hidden, and Chrome's
 *     *intensive* throttling drops that to **once per minute** after five
 *     minutes hidden (and after ~10 s for a page that has never been
 *     interacted with). `CLIENT_TIMEOUT_MS` is 15 s. One wake-up per minute
 *     loses the match four times over.
 *
 * Timers owned by a dedicated worker are exempt from intensive throttling —
 * that is the whole trick, and it is why this file is a worker and not three
 * lines of `setInterval` in client.ts. The page keeps a `setInterval` running
 * as well; if the worker fails to start (CSP, no `Worker`, an old embed) the
 * interval is still enough for the common alt-tab case, and the two together
 * are strictly better than either alone.
 *
 * The protocol is deliberately tiny — this thread must never do work:
 *   page → worker   { t: 'start', ms }   start/restart the tick
 *                   { t: 'stop' }        stop it
 *   worker → page   1                    a tick fired (a number, not an object,
 *                                        so nothing is allocated per tick)
 */

interface StartMessage { t: 'start'; ms: number }
interface StopMessage { t: 'stop' }
type ControlMessage = StartMessage | StopMessage;

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

let timer: ReturnType<typeof setInterval> | null = null;

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

scope.onmessage = (ev: { data: unknown }): void => {
  const msg = ev.data as ControlMessage | null;
  if (msg === null || typeof msg !== 'object') return;

  if (msg.t === 'start') {
    stop();
    const ms = Math.max(50, Math.min(60_000, Number(msg.ms) || 1000));
    timer = setInterval(() => { scope.postMessage(1); }, ms);
    return;
  }
  if (msg.t === 'stop') stop();
};
