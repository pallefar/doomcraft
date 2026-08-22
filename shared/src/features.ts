/**
 * Feature gates.
 *
 * The first customer is online multiplayer: it is built but not finished, the live site is a static
 * single-player build, and until a server is actually running the menu must not claim otherwise.
 *
 * THIS IS A PRODUCT GATE, NOT A SECURITY BOUNDARY. The override below lives in localStorage, so
 * anyone with devtools can flip it. That is fine for "coming soon" — the worst outcome is that a
 * curious player turns on a mode that then cannot reach a server and falls back to bots. It would
 * NOT be fine for anything that grants rewards or spends money; those are gated server-side in
 * `server/src/entitlementGuard.ts` against `shared/src/trust.ts`, and must stay there.
 *
 * Resolution order, first match wins:
 *   1. `?ff_<flag>=on|off` in the URL       — one-off, for testing a build without persisting
 *   2. localStorage `dc.ff.<flag>`           — the admin switch in Settings writes here
 *   3. the server's flag payload, when online (set via `applyServerFlags`)
 *   4. `DEFAULTS` below
 */

import { FLAG_ORDER, flagOn } from './flags.ts';

export const enum Feature {
  /** Remote servers, matchmaking, and playing with other humans. */
  ONLINE_MULTIPLAYER = 'onlineMultiplayer',
  /** Persistent shared Builder worlds — needs the same server as multiplayer. */
  SHARED_WORLDS = 'sharedWorlds',
  /**
   * The reward surfaces: the XP/Scrap chips on the HUD and the amounts on the
   * end-of-match panels.
   *
   * A PRODUCT gate and nothing more. It decides whether a player is SHOWN a
   * balance; it cannot decide whether one is granted, because it lives in this
   * tab's localStorage. The grant is gated twice on the far side — the trust
   * table via `server/src/entitlementGuard.ts`, and the server-resolved
   * `economy_scrap` kill switch in `shared/src/flags.ts`, which the surfaces
   * ALSO require. Turning this on against a server that has the kill switch off
   * shows nothing, which is the correct answer.
   */
  ECONOMY = 'economy',
}

/** Shipped defaults. All off: two want a server to talk to, the third wants one to pay. */
const DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  [Feature.ONLINE_MULTIPLAYER]: false,
  [Feature.SHARED_WORLDS]: false,
  [Feature.ECONOMY]: false,
});

/** What the badge says on a gated tile. Kept here so it is changed in one place. */
export const COMING_SOON_BADGE = 'COMING SOON · 2026';

const STORE_PREFIX = 'dc.ff.';
let serverFlags: Record<string, boolean> = {};

/** Applied when a server connection reports its flag payload. Server wins over the default. */
export function applyServerFlags(flags: Readonly<Record<string, boolean>>): void {
  serverFlags = { ...flags };
}

function readUrlOverride(flag: string): boolean | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get(`ff_${flag}`);
  if (v === null) return null;
  return v === 'on' || v === '1' || v === 'true';
}

function readStoredOverride(flag: string): boolean | null {
  try {
    const v = localStorage.getItem(STORE_PREFIX + flag);
    return v === null ? null : v === '1';
  } catch { return null; }        // private mode / storage disabled
}

export function isEnabled(flag: Feature | string): boolean {
  const url = readUrlOverride(flag);
  if (url !== null) return url;
  const stored = readStoredOverride(flag);
  if (stored !== null) return stored;
  if (Object.prototype.hasOwnProperty.call(serverFlags, flag)) return serverFlags[flag] === true;
  return DEFAULTS[flag] === true;
}

/** The admin switch. Passing null clears the override and returns to the default. */
export function setOverride(flag: Feature | string, on: boolean | null): void {
  try {
    if (on === null) localStorage.removeItem(STORE_PREFIX + flag);
    else localStorage.setItem(STORE_PREFIX + flag, on ? '1' : '0');
  } catch { /* storage unavailable; the override simply does not persist */ }
}

/** True when the player has explicitly overridden this flag either way. */
export function hasOverride(flag: Feature | string): boolean {
  return readUrlOverride(flag) !== null || readStoredOverride(flag) !== null;
}

/** Convenience: is online play available at all right now? */
export function onlineAvailable(): boolean { return isEnabled(Feature.ONLINE_MULTIPLAYER); }

/* ------------------------------------------------------------------------ *
 * The bridge to the SERVER's flags
 *
 * Step 3 of the resolution order at the top of this file — "the server's flag
 * payload, when online" — has never once executed. `applyServerFlags` had ZERO
 * callers repo-wide, and it could not have worked if it had one: it takes a
 * record keyed by `Feature` ids (`onlineMultiplayer`, `economy`) and the only
 * producer in the tree, `FlagService.resolveFor()`, hands back one keyed by
 * `FLAG_ORDER` names (`online_play`, `economy_scrap`). The two namespaces had
 * never met, so a wired-up call would have written keys nothing ever reads.
 *
 * The map below is the only bridge between them, which is what makes each pair
 * a decision somebody made rather than a coincidence of two strings looking
 * alike.
 * ------------------------------------------------------------------------ */

/**
 * `Feature` -> the server flag that decides it, or `null` for "no server flag
 * exists yet".
 *
 * `null` is a real answer and not a gap to be filled in later: the console
 * prints "no server flag" for that row rather than a value, and
 * `applyServerFlags` writes no key for it, so `isEnabled` falls through to
 * `DEFAULTS` exactly as it did before. A `Feature` added without a decision
 * here fails `shared/src/features.test.ts`.
 */
export const SERVER_FLAG_FOR: Readonly<Record<Feature, string | null>> = Object.freeze({
  [Feature.ONLINE_MULTIPLAYER]: 'online_play',
  /* No server flag: shared Builder worlds are gated by whether this host has a
   * world store at all, not by a rollout. Adding one is a `FLAG_ORDER` append. */
  [Feature.SHARED_WORLDS]: null,
  [Feature.ECONOMY]: 'economy_scrap',
});

/**
 * Translate the server's answer into the namespace `isEnabled` reads.
 *
 * Unmapped features are OMITTED rather than set to false: an absent key means
 * "the server said nothing", which is the only honest thing to say about a
 * feature with no server flag, and it is what keeps `DEFAULTS` reachable.
 */
export function featureFlagsFromServer(
  server: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const feature of Object.keys(SERVER_FLAG_FOR) as Feature[]) {
    const key = SERVER_FLAG_FOR[feature];
    if (key === null) continue;
    if (!Object.prototype.hasOwnProperty.call(server, key)) continue;
    out[feature] = server[key] === true;
  }
  return out;
}

/**
 * The same, straight off the `u32` that rides `S2C.SESSION_CONFIG`.
 *
 * This is the live path: the bits are already on a packet the client was going
 * to receive anyway, so wiring the bridge here costs no request. A flag the
 * server does not know about reads as false through `flagOn`, which is why the
 * mask is expanded against `FLAG_ORDER` first rather than being probed key by
 * key — a key that is not in `FLAG_ORDER` must not silently become `false` when
 * the truthful answer is "this build has no such flag".
 */
export function featureFlagsFromBits(bits: number): Record<string, boolean> {
  const resolved: Record<string, boolean> = {};
  for (const key of FLAG_ORDER) resolved[key] = flagOn(bits, key);
  return featureFlagsFromServer(resolved);
}
