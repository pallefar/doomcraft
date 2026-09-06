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
  'economy_items',
  'economy_achievements',
]);

/** Bit 31 is reserved: see the note on `SessionConfigMessage.flags`. */
export const MAX_FLAG_BITS = 31;

export const FLAGS: Readonly<Record<string, FlagDef>> = Object.freeze({
  economy_achievements: {
    key: 'economy_achievements',
    kind: 'feature',
    what: 'Lifetime one-shot achievements: the settlement that pays them and the board that shows them.',
    blastRadius: 'It gates PAYMENT and the SURFACE. It does NOT gate progress, and saying otherwise '
      + 'would mislead the person most likely to read this: an achievement measures the lifetime stat '
      + 'block, which `applyMatchResult` writes on every settled match whatever this flag says. So play '
      + 'during a disabled period still counts, and turning it back on pays what was earned meanwhile. '
      + 'Receipts live on the profile, so turning it off deletes nobody\'s award. Like every other '
      + 'reward bit it is read off the connection\'s handshake copy, so a player already in a match '
      + 'keeps the value they joined with.',
    defaultOn: false,
  },
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
  economy_items: {
    key: 'economy_items',
    kind: 'feature',
    what: 'Item drops at match end, from the live release\'s items pack (docs/ECONOMY.md Items).',
    blastRadius: 'New drops only. Nothing already owned appears or vanishes with this switch — '
      + 'ownership is derived from the live RELEASE, not from the flag — and no client surface '
      + 'ships yet, so off is exactly today\'s behaviour.',
    defaultOn: false,
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

/* ------------------------------------------------------------------------ *
 * Editing the document
 * ------------------------------------------------------------------------ */

/** Why a write was refused: what the caller expected, and what is actually here. */
export interface FlagWriteConflict {
  expected: number;
  actual: number;
}

export interface FlagWrite {
  /** False only for a compare-and-swap miss. A malformed patch is not an error. */
  ok: boolean;
  /** The document that should now be in force. **Unchanged** when `ok` is false. */
  document: FlagConfig;
  conflict: FlagWriteConflict | null;
  /** Rule keys this patch actually named, in `FLAG_ORDER`. For the audit line. */
  touched: readonly string[];
}

/**
 * Apply an operator's PATCH to the live document. Pure: it reads `current` and
 * returns the next one.
 *
 * This exists because `parseFlagConfig` is a **full replace** — it starts from
 * `createFlagConfig()`, whose `rules` are `{}` — and `docs/PATCHING.md` has
 * always prescribed the freeze as
 *
 *     curl -X POST .../api/admin/flags -d '{"revision":9,"frozen":true}'
 *
 * which under a full replace **deletes every force and every rolloutBp on the
 * host**. The documented emergency command was the most destructive request in
 * the API, and the test that "covered" freeze re-sent the whole rules block, so
 * the shape the document prescribes was never once exercised.
 *
 * The rules, each of which exists because its absence is a way to lose a flag:
 *
 *   - **Absent means unchanged.** `frozen`, `revision` and every rule key not
 *     named in the patch keep the value they have.
 *   - **A named rule is merged field by field.** `{"economy_scrap":{"force":true}}`
 *     leaves that flag's `rolloutBp` alone; it does not reset it to 0.
 *   - **`null` deletes**, and it is the only way to delete: `{"share_cards":null}`
 *     drops the rule so the flag falls back to its registry default. Deletion by
 *     omission is exactly the bug above, so it is not offered.
 *   - **`expectRevision` is a compare-and-swap.** When present and unequal to
 *     the live `revision`, nothing is applied and `conflict` says what was
 *     found — two operators editing at once cannot silently clobber each other,
 *     which is what "revision is clamped and never compared" allowed.
 *   - **An accepted write always moves the revision.** With no explicit
 *     `revision` it is `current.revision + 1`, so the CAS token cannot stand
 *     still while the document changes underneath it.
 *
 * Unknown flag keys are dropped, as `parseFlagConfig` drops them: only
 * `FLAG_ORDER` is iterated, so `__proto__` can never name a rule.
 */
export function nextFlagDocument(current: FlagConfig, patch: unknown): FlagWrite {
  const raw = (typeof patch === 'object' && patch !== null)
    ? patch as Record<string, unknown> : {};
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(raw, k);

  if (has('expectRevision')) {
    const want = raw.expectRevision;
    const n = typeof want === 'number' && Number.isFinite(want) ? Math.round(want) : Number.NaN;
    if (!Number.isFinite(n) || n !== current.revision) {
      return {
        ok: false,
        document: current,
        conflict: { expected: Number.isFinite(n) ? n : -1, actual: current.revision },
        touched: [],
      };
    }
  }

  const next: FlagConfig = {
    revision: has('revision')
      ? clampInt(raw.revision, current.revision, 0, 1e9)
      : Math.min(current.revision + 1, 1e9),
    frozen: has('frozen') ? raw.frozen === true : current.frozen,
    rules: {},
  };
  for (const key of FLAG_ORDER) {
    const rule = current.rules[key];
    if (rule !== undefined) next.rules[key] = { force: rule.force, rolloutBp: rule.rolloutBp };
  }

  const touched: string[] = [];
  const rules = (typeof raw.rules === 'object' && raw.rules !== null)
    ? raw.rules as Record<string, unknown> : {};
  for (const key of FLAG_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(rules, key)) continue;
    const r = rules[key];
    touched.push(key);
    if (r === null) { delete next.rules[key]; continue; }
    if (typeof r !== 'object') continue;
    const rr = r as Record<string, unknown>;
    const prior = next.rules[key] ?? { force: null, rolloutBp: 0 };
    next.rules[key] = {
      force: Object.prototype.hasOwnProperty.call(rr, 'force')
        ? (rr.force === true ? true : rr.force === false ? false : null)
        : prior.force,
      rolloutBp: Object.prototype.hasOwnProperty.call(rr, 'rolloutBp')
        ? clampInt(rr.rolloutBp, prior.rolloutBp, 0, 10000)
        : prior.rolloutBp,
    };
  }

  return { ok: true, document: next, conflict: null, touched };
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
 *
 * The separator is written as the escape `\u0000` rather than as a literal NUL
 * byte, and that is not cosmetic: one raw NUL anywhere in a file makes `grep`
 * treat the file as binary and skip ALL of it silently — no match, no warning,
 * exit 0. Two of them lived here, so anyone grepping this file for a flag key
 * was told it did not exist. Same bytes into `fingerprint`, same buckets, and
 * the file is searchable again.
 */
export function flagBucket(flagKey: string, stableId: string): number {
  return fingerprint(`${flagKey}\u0000${stableId}`) % 10000;
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
  return fingerprint(`host\u0000${stableId}`) % 10000;
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

/* ------------------------------------------------------------------------ *
 * Reviewing a write before it fires
 *
 * Everything below exists so that the admin console's HTML can stay dumb.
 * `server/src/admin/console.ts` is a template literal: it is outside `tsc` and
 * outside `vitest`, so it is the one surface in this repo where "it compiles
 * and the tests pass" is not even on offer. The rule that follows from that,
 * stated once here and enforced by keeping these functions pure:
 *
 *   **Nothing that can be WRONG may live in the HTML.** The panel renders a
 *   diff, a risk verdict, a delay and a warning list; it computes none of them.
 * ------------------------------------------------------------------------ */

/**
 * `docs/PATCHING.md` §5's rollout ladder, and the ONLY five values a rollout
 * may take without an explicit override.
 *
 * `docs/PLATFORM.md` §5.8 item 4: "A rollout you cannot type freehand is a
 * rollout you cannot fat-finger from 500 to 5000." The ladder is enforced on
 * the SERVER (`POST /api/admin/flags` refuses an off-ladder value unless the
 * body carries `allowCustomRollout: true`), not merely offered as five buttons
 * in a panel — a guard that lives only in the UI is a guard an operator with
 * curl does not have.
 */
export const ROLLOUT_LADDER: readonly number[] = Object.freeze([0, 100, 500, 2500, 10000]);

/** True when this basis-point value is one of the five rungs. */
export function onLadder(bp: number): boolean {
  return ROLLOUT_LADDER.includes(bp);
}

/** The nearest rung, for a stepper that cannot land between two of them. */
export function snapToLadder(bp: number): number {
  const n = Number.isFinite(bp) ? Math.round(bp) : 0;
  let best = ROLLOUT_LADDER[0];
  let bestGap = Math.abs(n - best);
  for (const rung of ROLLOUT_LADDER) {
    const gap = Math.abs(n - rung);
    // `<` and not `<=`: a tie goes to the LOWER rung, because the tie only ever
    // happens on the way up and less exposure is the safer half of a mistake.
    if (gap < bestGap) { best = rung; bestGap = gap; }
  }
  return best;
}

/**
 * How much of the player base this flag reaches under this document, in basis
 * points, with the freeze taken into account.
 *
 * This is `resolveFlag` read as a population rather than as one player, and it
 * has to match it exactly or every risk verdict below is a guess. The three
 * cases people get wrong, all of them straight out of `resolveFlag`:
 *
 *   - **No rule at all is not zero.** It is the flag's `defaultOn`, and
 *     `client_update_prompt` ships ON.
 *   - **A rule with `force: null, rolloutBp: 0` IS zero**, even for a flag
 *     whose default is on. Writing the rule is how you turn a default off
 *     without forcing it.
 *   - **The freeze only touches a PARTIAL rollout**, and it sends it to the
 *     flag's default — which for a `defaultOn` flag is UP, not down. Freezing
 *     is not universally a reduction and this function will say so.
 */
export function exposureBp(key: string, cfg: FlagConfig): number {
  const def = FLAGS[key];
  if (def === undefined) return 0;
  const rule = cfg.rules[key];
  if (rule === undefined) return def.defaultOn ? 10000 : 0;
  if (rule.force === true) return 10000;
  if (rule.force === false) return 0;
  if (rule.rolloutBp <= 0) return 0;
  if (rule.rolloutBp >= 10000) return 10000;
  return cfg.frozen ? (def.defaultOn ? 10000 : 0) : rule.rolloutBp;
}

/** One line of a human-readable diff between two documents. */
export interface FlagDiffRow {
  /** The flag key, or `''` for a document-level field. */
  readonly key: string;
  readonly field: 'force' | 'rolloutBp' | 'frozen' | 'revision' | 'rule';
  readonly before: string;
  readonly after: string;
  /** Change in reach, in basis points. Positive means more players. */
  readonly exposureDeltaBp: number;
}

function forceText(v: boolean | null | undefined): string {
  return v === true ? 'ON (forced)' : v === false ? 'OFF (forced)' : 'defer to rollout';
}

/**
 * What changed, field by field, in `FLAG_ORDER`.
 *
 * Written for a human about to press a button, so a rule that appears or
 * disappears is one row saying so rather than two rows about fields that had
 * no previous value.
 */
export function diffFlagDocuments(before: FlagConfig, after: FlagConfig): FlagDiffRow[] {
  const out: FlagDiffRow[] = [];
  if (before.frozen !== after.frozen) {
    out.push({
      key: '', field: 'frozen',
      before: String(before.frozen), after: String(after.frozen),
      exposureDeltaBp: 0,
    });
  }
  if (before.revision !== after.revision) {
    out.push({
      key: '', field: 'revision',
      before: String(before.revision), after: String(after.revision),
      exposureDeltaBp: 0,
    });
  }
  for (const key of FLAG_ORDER) {
    const a = before.rules[key];
    const b = after.rules[key];
    const delta = exposureBp(key, after) - exposureBp(key, before);
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined) {
      const had = a ?? b as FlagRule;
      out.push({
        key, field: 'rule',
        before: a === undefined ? 'no rule (registry default)' : `${forceText(had.force)}, ${had.rolloutBp} bp`,
        after: b === undefined ? 'no rule (registry default)' : `${forceText(had.force)}, ${had.rolloutBp} bp`,
        exposureDeltaBp: delta,
      });
      continue;
    }
    if (a.force !== b.force) {
      out.push({ key, field: 'force', before: forceText(a.force), after: forceText(b.force), exposureDeltaBp: delta });
    }
    if (a.rolloutBp !== b.rolloutBp) {
      out.push({
        key, field: 'rolloutBp',
        before: `${a.rolloutBp} bp`, after: `${b.rolloutBp} bp`,
        exposureDeltaBp: a.force === null && b.force === null ? delta : 0,
      });
    }
  }
  // The freeze moves reach without touching a single rule, so a freeze-only
  // write would otherwise diff as one boolean and look like nothing.
  if (before.frozen !== after.frozen) {
    for (const key of FLAG_ORDER) {
      const delta = exposureBp(key, after) - exposureBp(key, before);
      if (delta === 0) continue;
      if (out.some((r) => r.key === key)) continue;
      out.push({
        key, field: 'frozen',
        before: `${exposureBp(key, before)} bp reach`,
        after: `${exposureBp(key, after)} bp reach`,
        exposureDeltaBp: delta,
      });
    }
  }
  return out;
}

/**
 * Which way a write moves the blast radius.
 *
 * `expands` is the direction that needs a delay; `reduces` is the incident
 * response and must never be delayed. See `confirmDelayMs`.
 */
export type FlagWriteRisk = 'expands' | 'reduces' | 'neutral';

export function flagWriteRisk(before: FlagConfig, after: FlagConfig): FlagWriteRisk {
  let up = 0;
  let down = 0;
  for (const key of FLAG_ORDER) {
    const delta = exposureBp(key, after) - exposureBp(key, before);
    if (delta > 0) up += delta;
    else if (delta < 0) down -= delta;
  }
  if (up > 0) return 'expands';
  return down > 0 ? 'reduces' : 'neutral';
}

/** The mandatory pause between arming a write and being allowed to fire it. */
export const CONFIRM_DELAY_MS = 60_000;

/**
 * How long the operator must wait between arming and confirming.
 *
 * **This is a deliberate departure from `docs/PLATFORM.md` §5.8, which asks for
 * "60 s for a flag at ≤500 bp" without saying which direction.** A blanket
 * delay puts the emergency stop behind a minute-long countdown, and the switch
 * an operator reaches for at 3 a.m. is always the one that turns something OFF.
 * Delaying that is not caution, it is an outage extended by policy.
 *
 * So the pause is on EXPANSION only. Anything that reaches more players waits;
 * anything that reaches fewer — a force-off, a rollout stepped down, the
 * freeze — fires as soon as the operator has typed the subject back. Both paths
 * still write the same audit row with the same required `reason`.
 */
export function confirmDelayMs(risk: FlagWriteRisk): number {
  return risk === 'expands' ? CONFIRM_DELAY_MS : 0;
}

/** A write, reviewed: what it does, what it costs, and what to be afraid of. */
export interface FlagPlan {
  /** False only for a compare-and-swap miss; the document is then unchanged. */
  readonly ok: boolean;
  readonly document: FlagConfig;
  readonly conflict: FlagWriteConflict | null;
  readonly touched: readonly string[];
  readonly diff: readonly FlagDiffRow[];
  /** Rendered inline by the console, never behind a hover. */
  readonly warnings: readonly string[];
  readonly risk: FlagWriteRisk;
  readonly delayMs: number;
  /** Rule keys whose resulting `rolloutBp` is not one of the five rungs. */
  readonly offLadder: readonly string[];
  /**
   * The string the operator must type back before the write is allowed —
   * `docs/PLATFORM.md` §5.8 item 2, the control that makes `rm -rf` survivable.
   */
  readonly subject: string;
}

/**
 * Review a patch without applying it: the exact document to submit, a diff, and
 * the warnings that belong in the confirm dialog.
 *
 * Pure, and that is the whole point of it existing. `POST /api/admin/flags/plan`
 * is this function over HTTP; the console renders what it returns and posts
 * `document` back verbatim under `rules`, so the risky logic is tested here
 * rather than being untested JavaScript inside an HTML string.
 */
export function planFlagWrite(current: FlagConfig, patch: unknown): FlagPlan {
  const write = nextFlagDocument(current, patch);
  if (!write.ok) {
    return {
      ok: false, document: write.document, conflict: write.conflict, touched: [],
      diff: [], warnings: ['Somebody else edited this document. Reload before writing.'],
      risk: 'neutral', delayMs: 0, offLadder: [], subject: '',
    };
  }
  const diff = diffFlagDocuments(current, write.document);
  const risk = flagWriteRisk(current, write.document);
  const offLadder: string[] = [];
  for (const key of write.touched) {
    const rule = write.document.rules[key];
    if (rule !== undefined && !onLadder(rule.rolloutBp)) offLadder.push(key);
  }

  const warnings: string[] = [];
  /* The two the console must print, and they are not hypothetical: `FlagService`
   * holds the document in one process's memory and `load()` reads
   * `DOOMCRAFT_FLAGS` at boot, so this write survives exactly as long as the
   * process does. */
  warnings.push(
    'This write reaches ONE process. Every other host in the fleet keeps the document it has, '
    + 'and this host reverts to its DOOMCRAFT_FLAGS boot document when it restarts.',
  );
  if (current.frozen !== write.document.frozen) {
    warnings.push(write.document.frozen
      ? 'FREEZE: every PARTIAL rollout (0 < bp < 10000) now resolves to the flag\'s registry default. '
        + 'Finished rollouts and explicit force values are left exactly as they are.'
      : 'UNFREEZE: every partial rollout resumes bucketing players again, at the value it still holds.');
  }
  for (const key of write.touched) {
    const def = FLAGS[key];
    if (def === undefined) continue;
    const delta = exposureBp(key, write.document) - exposureBp(key, current);
    if (delta <= 0) continue;
    // Verbatim, inline, never behind a hover: shared/src/flags.test.ts holds
    // `blastRadius` above 40 characters precisely so a human dares flip the
    // switch, and hiding it defeats the registry.
    warnings.push(`${key} — BLAST RADIUS: ${def.blastRadius}`);
  }
  for (const key of offLadder) {
    warnings.push(
      `${key} is being set to ${write.document.rules[key]?.rolloutBp ?? 0} bp, which is not on the `
      + `${ROLLOUT_LADDER.join(' / ')} ladder. A custom rollout needs its own reason.`,
    );
  }
  // Freezing can RAISE reach for a flag whose registry default is on. Nobody
  // expects the emergency stop to turn something on, so it is named.
  if (write.document.frozen && !current.frozen) {
    for (const key of FLAG_ORDER) {
      if (exposureBp(key, write.document) > exposureBp(key, current)) {
        warnings.push(`${key} REACHES MORE PLAYERS after this freeze: its registry default is ON, `
          + 'and freezing sends a partial rollout to the default.');
      }
    }
  }

  return {
    ok: true,
    document: write.document,
    conflict: null,
    touched: write.touched,
    diff,
    warnings,
    risk,
    delayMs: confirmDelayMs(risk),
    subject: write.touched.length === 1 ? write.touched[0] : `revision ${current.revision}`,
    offLadder,
  };
}

/**
 * What a caller with NO IDENTITY resolves to.
 *
 * `GET /api/flags` has no device id for a menu that has not connected yet, and
 * it used to hash the literal string `'anonymous'` for all of them. That is
 * precisely the failure `server/src/deploy.ts`'s `stableIdFor` says it is
 * avoiding on the socket path: one bucket for the whole anonymous population
 * turns a 1% rollout into an all-or-nothing coin flip on all of them, decided
 * once, at random, by the flag key — and it lands the same way on every host in
 * the fleet, forever, because the hash has no per-process input.
 *
 * The answer is NOT `defaultFlagBits()`, which `docs/PLATFORM.md` §5.5(d)
 * proposes. That throws away the operator's explicit decisions along with the
 * gamble: a `force: false` kill switch pulled at 3 a.m. would still show the
 * feature to every device-less caller, which is the opposite of what the switch
 * is for. What must not happen is the GAMBLE, not the document.
 *
 * So: resolve the real document with the freeze rule applied. A force is
 * honoured, a finished rollout (10000) is honoured, an empty one (0) is
 * honoured, and only a PARTIAL rollout — the one case that needs a player to
 * bucket — falls back to the flag's registry default. That is `frozen`'s
 * existing, tested meaning, reused rather than restated, and it makes the
 * result independent of the stable id, which is the property that matters when
 * there isn't one.
 */
export function anonymousFlagBits(cfg: FlagConfig): number {
  return resolveFlagBits({ ...cfg, frozen: true }, '');
}
