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
