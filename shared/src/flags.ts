/**
 * DOOMCRAFT — feature flags.
 *
 * `docs/INFRASTRUCTURE.md` §6, "Kill switches": every new feature ships behind a
 * flag, **defaulting off**, with a written blast radius, resolved **server-side**,
 * and the resolved value is told to the client — the client never decides.
 *
 * That last clause is the whole design. A flag the client evaluates is a
 * suggestion; a flag the server evaluates and transmits is a control. It is
 * also the only shape in which "turn the economy off, now, from a phone"
 * actually works.
 *
 * ## Why this is not a signed JSON blob at the edge
 *
 * INFRASTRUCTURE.md prices a per-player signed config document at roughly
 * $10,800/month at the target concurrency and rejects it. So flags reach a
 * player by two routes, neither of which is a per-player fetch on a timer:
 *
 *   1. **In-band, per connection.** The room resolves this player's flags once
 *      and stamps them into `S2C.SESSION_CONFIG` — 4 bytes on a packet that was
 *      already being sent. At 1M CCU that is 4 MB total, once, not a request
 *      rate. This is the authoritative path.
 *   2. **Once per boot, for the menu.** Everything the shell needs before it has
 *      a connection comes from one tiny `GET /api/flags` (a few hundred bytes,
 *      strong ETag, cacheable at the edge and by the service worker). One
 *      request per session, not one per minute per player.
 *
 * The config DOCUMENT — the thing an operator edits — is polled by the server
 * fleet, which is hundreds of boxes rather than a million browsers. That is the
 * entire cost difference.
 *
 * ## Landing a feature dark
 *
 * This file exists now, before the economy and the sponsor work, precisely so
 * those can land dark: merge the half-built feature behind an off flag, ship it
 * with every deploy, exercise it internally at `rolloutBp: 0` with an operator
 * `force`, then raise the rollout in stages. Nothing about turning it on is a
 * deploy. See `docs/PATCHING.md`.
 */

import { fingerprint } from './version.ts';

/* ------------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------------ */

/**
 * What kind of switch this is.
 *
 * - `feature` — a capability that did not exist before. MUST default off and
 *   MUST carry a written blast radius. `flags.test.ts` enforces both.
 * - `control` — an operational switch over behaviour that already shipped.
 *   May default on, because turning the SWITCH off is the change.
 */
export type FlagKind = 'feature' | 'control';

export interface FlagDef {
  readonly key: string;
  readonly kind: FlagKind;
  /** What it turns on, in one line. */
  readonly what: string;
  /**
   * What breaks if this is wrong, and who notices. Required for `feature`
   * flags: a flag with no stated blast radius is a flag nobody dares flip,
   * which is the same as not having one.
   */
  readonly blastRadius: string;
  readonly defaultOn: boolean;
}

/**
 * Bit order on the wire. **Append only.** A retired flag's bit is burned, never
 * reused — the same rule as a snapshot bitmask bit, and for the same reason: an
 * old client that still has the retired meaning compiled in would otherwise read
 * the new flag as the old feature.
 *
 * Bit i of `SessionConfigMessage.flags` is `FLAG_ORDER[i]`.
 */
export const FLAG_ORDER: readonly string[] = Object.freeze([
  'online_play',
  'economy_scrap',
  'economy_trading',
  'economy_competitions',
  'share_cards',
  'sponsor_slots',
  'sponsor_interstitial',
  'sponsor_rewarded',
  'ads_programmatic',
  'client_update_prompt',
]);

/** Bit 31 is reserved: see the note on `SessionConfigMessage.flags`. */
export const MAX_FLAG_BITS = 31;

export const FLAGS: Readonly<Record<string, FlagDef>> = Object.freeze({
  online_play: {
    key: 'online_play',
    kind: 'feature',
    what: 'The client connects to a remote room host instead of the in-browser local server.',
    blastRadius: 'Everyone who enters a match while it is on. Off = today\'s shipped behaviour, '
      + 'which is a complete single-player game, so the failure mode is "no multiplayer", not "no game".',
    defaultOn: false,
  },
  economy_scrap: {
    key: 'economy_scrap',
    kind: 'feature',
    what: 'Scrap accrual, the Store tab and spending (docs/ECONOMY.md).',
    blastRadius: 'Player balances. Turning it OFF mid-season must not delete a balance — the ledger '
      + 'keeps accruing server-side and only the surfaces hide, so the switch is reversible.',
    defaultOn: false,
  },
  economy_trading: {
    key: 'economy_trading',
    kind: 'feature',
    what: 'Player-to-player escrow trading.',
    blastRadius: 'Item ownership, i.e. the highest-stakes thing in the game. An in-flight trade must '
      + 'settle or roll back atomically when this goes off; it must never leave an item in escrow.',
    defaultOn: false,
  },
  economy_competitions: {
    key: 'economy_competitions',
    kind: 'feature',
    what: 'Seasons, tournaments, daily/weekly challenges.',
    blastRadius: 'Ladder standings and prize eligibility. Off mid-season hides the tab; it does not '
      + 'stop the server recording results, so a season is never lost to a flag flip.',
    defaultOn: false,
  },
  share_cards: {
    key: 'share_cards',
    kind: 'feature',
    what: 'Server-rendered end-of-match share image with a join code.',
    blastRadius: 'One button on the results screen, plus whatever the image renderer costs. Lowest-risk '
      + 'flag on the list and therefore a good first one to exercise the rollout ladder with.',
    defaultOn: false,
  },
  sponsor_slots: {
    key: 'sponsor_slots',
    kind: 'feature',
    what: 'Creative in the three reserved menu slots and the mode-tile badge (SPONSORS.md S1/S3/S4).',
    blastRadius: 'The menu only — the slots are `display:none` during play by construction. A bad '
      + 'creative cannot shift game layout because the boxes are reserved at first paint.',
    defaultOn: false,
  },
  sponsor_interstitial: {
    key: 'sponsor_interstitial',
    kind: 'feature',
    what: 'The between-match interstitial overlay (SPONSORS.md S10).',
    blastRadius: 'The most intrusive surface in the product and the one most likely to draw complaints. '
      + 'Between matches only; never during play. Expect to use this switch in anger.',
    defaultOn: false,
  },
  sponsor_rewarded: {
    key: 'sponsor_rewarded',
    kind: 'feature',
    what: 'Opt-in rewarded video (SPONSORS.md S11).',
    blastRadius: 'Player-initiated only. Note SPONSORS.md §S11: an ad-free player must still get the '
      + 'reward, so turning this off has to hide the offer, not the reward.',
    defaultOn: false,
  },
  ads_programmatic: {
    key: 'ads_programmatic',
    kind: 'feature',
    what: 'Third-party network fill, as opposed to house creative in the same slots.',
    blastRadius: 'Third-party script in the page. This is the flag the CSP argument in docs/DEPLOY.md '
      + 'is about: it must not be turned on while the game is served from a host that cannot mint a '
      + 'per-response nonce.',
    defaultOn: false,
  },
  client_update_prompt: {
    key: 'client_update_prompt',
    kind: 'control',
    what: 'Show the "update ready" card at return-to-menu when a new build is waiting.',
    blastRadius: 'The prompt only, and this is enforced rather than asserted: with it off, '
      + '`UpdateController.pump()` applies the waiting build itself at the next moment the player '
      + 'is out of a match (client/src/boot/updates.ts), so the player is not ASKED rather than not '
      + 'updated. Turn it off if a release ships a broken prompt. Shipped ON — a control flag over '
      + 'behaviour that already exists, so turning the switch off is the change.',
    defaultOn: true,
  },
});

/* ------------------------------------------------------------------------ *
 * The operator's document
 * ------------------------------------------------------------------------ */

export interface FlagRule {
  /**
   * Operator override. `true` forces on, `false` forces off (this is the kill
   * switch for a feature already at 100%), `null` defers to the rollout.
   */
  force: boolean | null;
  /** Staged rollout, in basis points: 0 = nobody, 10000 = everybody. */
  rolloutBp: number;
}

export interface FlagConfig {
  /** Bumped by whoever edits the document. Only used for logging and ETags. */
  revision: number;
  /**
   * **Freeze all rollouts** — INFRASTRUCTURE.md's one toggle, reachable from a
   * phone.
   *
   * A frozen fleet resolves every PARTIAL rollout (0 < bp < 10000) to the flag's
   * default, and leaves the finished ones alone. That is the behaviour you
   * actually want at 3 a.m.: stop everything mid-experiment, without also
   * switching off a feature that has been fully live for a month and that half
   * the product now depends on. To turn a finished feature off you use its
   * `force: false`, deliberately, one flag at a time.
   */
  frozen: boolean;
  rules: Record<string, FlagRule>;
}

export function createFlagConfig(): FlagConfig {
  return { revision: 0, frozen: false, rules: {} };
}

/**
 * Total parser. Anything unrecognised is dropped, anything out of range is
 * clamped, and it never throws — an operator's typo must not take the fleet
 * down, it must leave the fleet on the previous document's meaning.
 */
export function parseFlagConfig(input: unknown): FlagConfig {
  const out = createFlagConfig();
  const raw = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};
  out.revision = clampInt(raw.revision, 0, 0, 1e9);
  out.frozen = raw.frozen === true;
  const rules = (typeof raw.rules === 'object' && raw.rules !== null)
    ? raw.rules as Record<string, unknown> : {};
  for (const key of FLAG_ORDER) {
    const r = rules[key];
    if (typeof r !== 'object' || r === null) continue;
    const rr = r as Record<string, unknown>;
    out.rules[key] = {
      force: rr.force === true ? true : rr.force === false ? false : null,
      rolloutBp: clampInt(rr.rolloutBp, 0, 0, 10000),
    };
  }
  return out;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
}

/**
 * A strong ETag for the document, so `/api/flags` answers 304 for the whole
 * fleet between edits. Cheap to compute and stable across processes.
 */
export function flagConfigETag(cfg: FlagConfig): string {
  const parts: string[] = [`r${cfg.revision}`, cfg.frozen ? 'frozen' : 'live'];
  for (const key of FLAG_ORDER) {
    const rule = cfg.rules[key];
    if (rule === undefined) continue;
    parts.push(`${key}=${rule.force === null ? '-' : rule.force ? '1' : '0'}@${rule.rolloutBp}`);
  }
  return `"f${fingerprint(parts.join('|')).toString(16)}"`;
}

/* ------------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------------ */

/**
 * A player's stable bucket for one flag, 0..9999.
 *
 * Salted **by flag key**, so a player who lands outside the 1% of one rollout is
 * not systematically outside the 1% of every other one. That is different from
 * version routing (`hostBucket` below), which is deliberately UNsalted so a
 * player stays on the same build across matches.
 */
export function flagBucket(flagKey: string, stableId: string): number {
  return fingerprint(`${flagKey} ${stableId}`) % 10000;
}

/**
 * A player's stable bucket for staged VERSION rollout, 0..9999.
 *
 * INFRASTRUCTURE.md §6: "assigned by a stable hash of playerId so a player does
 * not flap between versions between matches". No salt, one bucket per player
 * for the whole fleet, so internal -> 1% -> 5% -> 25% -> 100% is a monotonically
 * growing set of players and nobody is ever moved backwards.
 */
export function hostBucket(stableId: string): number {
  return fingerprint(`host ${stableId}`) % 10000;
}

/** True when this player gets this flag under this config. */
export function resolveFlag(key: string, cfg: FlagConfig, stableId: string): boolean {
  const def = FLAGS[key];
  if (def === undefined) return false;
  const rule = cfg.rules[key];
  if (rule === undefined) return def.defaultOn;
  // An explicit operator decision is never overridden by the freeze: the freeze
  // stops experiments, it does not undo a human's deliberate act.
  if (rule.force !== null) return rule.force;
  if (rule.rolloutBp <= 0) return false;
  if (rule.rolloutBp >= 10000) return true;
  if (cfg.frozen) return def.defaultOn;
  return flagBucket(key, stableId) < rule.rolloutBp;
}

/** Every flag, resolved, as a `u32` bitmask ready for `S2C.SESSION_CONFIG`. */
export function resolveFlagBits(cfg: FlagConfig, stableId: string): number {
  let bits = 0;
  for (let i = 0; i < FLAG_ORDER.length && i < MAX_FLAG_BITS; i++) {
    if (resolveFlag(FLAG_ORDER[i], cfg, stableId)) bits |= (1 << i);
  }
  return bits >>> 0;
}

/** Read one flag out of a resolved bitmask. The client's only flag API. */
export function flagOn(bits: number, key: string): boolean {
  const i = FLAG_ORDER.indexOf(key);
  if (i < 0 || i >= MAX_FLAG_BITS) return false;
  return ((bits >>> i) & 1) === 1;
}

/** The whole mask as a record, for the menu and for `/api/flags`. */
export function unpackFlags(bits: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (let i = 0; i < FLAG_ORDER.length && i < MAX_FLAG_BITS; i++) {
    out[FLAG_ORDER[i]] = ((bits >>> i) & 1) === 1;
  }
  return out;
}

/**
 * The defaults, as a mask. What a client resolves to when it has no connection
 * and no `/api/flags` answer — an offline tab, or a static deploy with no server
 * at all, which is exactly what ships today.
 */
export function defaultFlagBits(): number {
  let bits = 0;
  for (let i = 0; i < FLAG_ORDER.length && i < MAX_FLAG_BITS; i++) {
    if (FLAGS[FLAG_ORDER[i]]?.defaultOn === true) bits |= (1 << i);
  }
  return bits >>> 0;
}
