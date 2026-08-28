/**
 * DOOMCRAFT — content packs.
 *
 * A pack is DATA, never code (docs/PACKS.md Rule A: both deployments ship
 * `script-src 'self'`, so a pack that carried logic would need a CSP hole).
 *
 * This file replaces nothing. `CONTENT_VERSION` (shared/src/version.ts) STAYS,
 * because three things read it before any release document exists: the
 * client's HELLO (client/src/net/client.ts), a refusal sent before a room is
 * chosen (server/src/net.ts), and the Room defaults that
 * client/src/net/localServer.ts relies on. See docs/PACKS.md D2.
 *
 * What lives here is identity and resolution — the enum, the fingerprint
 * carrier, the fold, and the pure per-room release resolver. The durable
 * release document service, the inventory and the gate that runs against a
 * host's disk are server code (phase 2); the offline gate is
 * `tools/release-verify.mjs` (phase 1).
 */

import { CONTENT_VERSION, fingerprint } from './version.ts';

/**
 * APPEND ONLY. A retired kind's number is burned — the same rule as a
 * FLAG_ORDER bit (shared/src/flags.ts) and for the same reason: the number is
 * the canonical fold order for packSetHash(), so reusing one silently
 * re-means every hash any host has ever reported.
 */
export enum PackKind {
  CORE = 0,
  WEAPONS = 1,
  LEVELS = 2,
  CAMPAIGN = 3,
  CHARACTERS = 4,
  /** Producer: shared/src/challenges.ts + content/quests.json — the S4 challenge engine. */
  QUESTS = 5,
  /** Producer: shared/src/items.ts + content/items.json. Ownership rule: docs/PACKS.md §7. */
  ITEMS = 6,
}

/** 'build' = compiled into the bundle. 'data' = files the server loads at runtime. */
export type PackClass = 'build' | 'data';

export interface PackDef {
  readonly kind: PackKind;
  /** Stable lowercase slug. Appears in every URL, hash input and audit line. */
  readonly key: string;
  readonly cls: PackClass;
  /** One line, rendered verbatim by the console. Same discipline as FlagDef.blastRadius. */
  readonly blastRadius: string;
}

export const PACKS: Readonly<Partial<Record<PackKind, PackDef>>> = Object.freeze({
  [PackKind.CORE]: {
    kind: PackKind.CORE, key: 'core', cls: 'build',
    blastRadius: 'Every match in the fleet. Tick rate, match length, score limit, gravity, move '
      + 'speed and the terrain generator — the client predicts all of them, so a change here is a '
      + 'client change too and it lands on the next page load, not the next room.',
  },
  [PackKind.WEAPONS]: {
    kind: PackKind.WEAPONS, key: 'weapons', cls: 'build',
    blastRadius: 'Time-to-kill in every NEW room. Rooms already running keep the table they were '
      + 'built with, so no in-flight match changes underneath a player.',
  },
  [PackKind.LEVELS]: {
    kind: PackKind.LEVELS, key: 'levels', cls: 'data',
    blastRadius: 'Quest only. A refused level is not offered at all; Deathmatch, Horde and '
      + 'Builder never read this pack.',
  },
  [PackKind.CAMPAIGN]: {
    kind: PackKind.CAMPAIGN, key: 'campaign', cls: 'data',
    blastRadius: 'The ORDER levels are played in and which episode they belong to. Cannot make a '
      + 'level unplayable, only unreachable from the campaign.',
  },
  [PackKind.CHARACTERS]: {
    kind: PackKind.CHARACTERS, key: 'characters', cls: 'build',
    blastRadius: 'How enemies look. Cosmetic and client-side: the server sends an EntityType byte '
      + 'and never reads this pack.',
  },
  [PackKind.QUESTS]: {
    kind: PackKind.QUESTS, key: 'quests', cls: 'data',
    blastRadius: 'Which daily/weekly challenges exist and what they pay. Progress and paid '
      + 'receipts live on the profile, so a re-cut mid-period deletes nobody\'s Scrap — a '
      + 'removed def simply stops accruing and paying from the next settlement.',
  },
  [PackKind.ITEMS]: {
    kind: PackKind.ITEMS, key: 'items', cls: 'data',
    blastRadius: 'What can drop, and what every already-owned item resolves to. REMOVING an id is '
      + 'the destructive direction: every owned copy goes dormant at the next read, silently, with '
      + 'no profile write to notice — the gate counts them (items.dormanted) and the Review screen '
      + 'renders the count.',
  },
});

/** One pack at one version. This is what a release names. */
export interface PackVersion {
  readonly kind: PackKind;
  readonly key: string;
  /** Independent per kind. `weapons@4` and `levels@7` are unrelated numbers. u16. */
  readonly version: number;
  /** FNV-1a over `inputs`. The per-pack ratchet. */
  readonly fingerprint: number;
  /**
   * The EXACT strings the fingerprint was computed from, in canonical order.
   *
   * This is what makes a release REVIEWABLE instead of a hash the author is
   * told to paste in. The console diffs these line for line and renders
   * `- shotgun:8/9/2/90/…` / `+ shotgun:9/9/2/84/…` with no bespoke differ,
   * and the gate recomputes them from the running process.
   *
   * For a BUILTIN pack both `fingerprint` AND `inputs` are checked-in
   * literals — the author-time declaration. The gate recomputes the inputs
   * from the running binary and compares: agreement is check
   * `packs.declared`, and a drift prints as a LINE DIFF of these strings,
   * never as two bare hex numbers.
   */
  readonly inputs: readonly string[];
  /** sha256 hex of the canonical encoded bytes. Data packs only; '' for build packs. */
  readonly digest: string;
  /** 'levels@7'. The console never renders a bare number. */
  readonly label: string;
}

export const MAX_PACK_INPUTS = 512;
export const MAX_PACK_INPUT_BYTES = 160;
/** SessionConfigMessage.contentVersion is a u16 (shared/src/protocol.ts). */
export const MAX_ORDINAL = 0xffff;

/**
 * The room's content identity, replacing contentHashFor()'s job at the places
 * a room is built. Stays u32/FNV because that is the width of the wire field;
 * `digest` is the review-grade identity and lives in the release document and
 * in /api/version, never on the wire.
 *
 * ORDER: the fold is sensitive to `kind`, and the function sorts by `kind`
 * internally, so the INPUT ARRAY's order does not matter and the RESULT
 * changes if any pack's kind, version or fingerprint changes. Both halves are
 * asserted in shared/src/packs.test.ts.
 */
export function packSetHash(packs: readonly PackVersion[], ordinal: number): number {
  let h = Math.imul(ordinal >>> 0, 0x9e3779b1) >>> 0;
  for (const p of [...packs].sort((a, b) => a.kind - b.kind)) {
    h = Math.imul(h ^ (p.kind >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (p.version >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (p.fingerprint >>> 0), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------------ *
 * The release document — types now, service in phase 2
 * ------------------------------------------------------------------------ */

export type ReleaseState =
  | 'draft'        // assembled from what is installed; nothing has been checked
  | 'review'       // the gate has run; `gate` holds the verdict and the diff
  | 'staged'       // approved; being served to some fraction of NEW ROOMS
  | 'live'         // the terminal operator decision. Every new room, and freeze-proof
  | 'rolled_back'  // was live, is not any more; kept in `history` forever
  | 'superseded';

export interface GateCheck {
  /** Stable id: 'packs.declared', 'levels.validate'. The console groups on it. */
  readonly id: string;
  readonly ok: boolean;
  /** Why, in one line. Rendered verbatim. Empty when ok. */
  readonly detail: string;
}

export interface PackDiff {
  readonly key: string;
  readonly from: string;              // 'weapons@3', or '' when the pack is new
  readonly to: string;                // 'weapons@4'
  /** Line diff of PackVersion.inputs, prefixed '+ ' / '- ', capped. */
  readonly changes: readonly string[];
}

export interface GateReport {
  readonly ok: boolean;
  readonly ranMs: number;
  /** Failures first. An EMPTY list is a FAILURE, never a pass (check `gate.nonempty`). */
  readonly checks: readonly GateCheck[];
  readonly diff: readonly PackDiff[];
  /** True when PERSIST_VERSION or SAVES_VERSION moved. Disables rollback forever. */
  readonly schemaTouching: boolean;
}

export interface Release {
  /** Server-assigned, strictly increasing. The CAS token for every mutation. */
  readonly revision: number;
  readonly state: ReleaseState;
  /** The wire's u16 `contentVersion`. Strictly increasing across live releases. */
  readonly ordinal: number;
  readonly packs: readonly PackVersion[];
  /** Fraction of NEW ROOMS built from this release, 0..10000. */
  readonly rolloutBp: number;
  /** The revision a room falls back to when this one is not selected. */
  readonly baseRevision: number;
  readonly gate: GateReport | null;
  readonly createdMs: number;
  readonly publishedMs: number;
  /** The operator's one line. <= 200 chars. REQUIRED to leave 'review'. */
  readonly note: string;
}

export interface ReleaseDoc {
  /**
   * Newest last, capped at MAX_RELEASE_HISTORY. The cap NEVER evicts
   * `liveRevision`, `pendingRevision`, or any `baseRevision` reachable from
   * either — see docs/PACKS.md D6. An unreachable-live document is the one
   * input that could take room creation down fleet-wide.
   */
  readonly history: readonly Release[];
  readonly liveRevision: number;
  /** The revision being staged, or 0. At most ONE at a time, deliberately. */
  readonly pendingRevision: number;
  /** Same word as FlagConfig.frozen, DIFFERENT terminal state — docs/PACKS.md D5. */
  readonly frozen: boolean;
  /** Bumped on every accepted mutation. The CAS token. */
  readonly revision: number;
}

export const MAX_RELEASE_HISTORY = 32;

/** The release at a revision, or null. */
export function releaseAt(doc: ReleaseDoc, revision: number): Release | null {
  if (revision <= 0) return null;
  for (const r of doc.history) if (r.revision === revision) return r;
  return null;
}

/**
 * Which release THIS room is built from. Called exactly ONCE per room, inside
 * the factory, and the answer is pinned into the Room's readonly fields.
 *
 * `fallback` is BUILTIN_RELEASE — the release this binary itself declares. It
 * is a parameter and not an import so that this function is TOTAL: it can
 * never return null and can never throw. A throw here propagates out of
 * `lifecycle.guardCreate` through `ModeRouter.route` and becomes a 503 on
 * EVERY upgrade — one bad document would stop room creation fleet-wide, on a
 * host whose console is served by the same process.
 */
export function resolveRelease(
  doc: ReleaseDoc, roomInstanceId: string, fallback: Release,
): Release {
  const live = releaseAt(doc, doc.liveRevision) ?? fallback;
  if (doc.pendingRevision === 0) return live;
  const pending = releaseAt(doc, doc.pendingRevision);
  if (pending === null || pending.state !== 'staged') return live;
  /*
   * FREEZE BEATS EVERY STAGED RELEASE, INCLUDING ONE AT 10000.
   *
   * This is a DELIBERATE divergence from resolveFlag (shared/src/flags.ts),
   * where `bp >= 10000` short-circuits before the freeze check. There, 10000
   * IS the terminal operator decision. Here it is not: `staged` at 10000 is
   * still a release awaiting `promote`, and a human may be asleep between the
   * two. Copying the flag ordering would give a panic button that cannot stop
   * the release that most needs stopping. The terminal state here is `live`,
   * and a live release is what the freeze falls back TO.
   */
  if (doc.frozen) return live;
  if (pending.rolloutBp <= 0) return live;
  if (pending.rolloutBp >= 10000) return pending;
  return packBucket(roomInstanceId) < pending.rolloutBp ? pending : live;
}

/**
 * A room's stable bucket, 0..9999.
 *
 * NOT flagBucket (shared/src/flags.ts) and NOT hostBucket. Both are keyed on
 * a PLAYER. A player-keyed pack rollout puts two players in one room on two
 * different weapon tables — exactly the desync the per-room pin exists to
 * prevent, and `ModeRouter.route` routes both players into the same slot by
 * design.
 *
 * `roomInstanceId` MUST be minted in the factory with randomBytes — never the
 * room KEY (roughly four bases plus `#n` suffixes under MAX_ROOMS, so a 1%
 * rollout over ~36 fixed strings selects the same zero rooms forever) and
 * never `options.seed` (client-supplied, and undefined-at-factory for a
 * normal client). docs/PACKS.md 8.1.
 */
export function packBucket(roomInstanceId: string): number {
  return fingerprint(`pack ${roomInstanceId}`) % 10000;
}

/* ------------------------------------------------------------------------ *
 * The compiled-in release — what a host with no release document serves
 * ------------------------------------------------------------------------ */

/**
 * DECLARED per-pack identity of THIS build. Both the fingerprints AND the
 * input strings are checked-in literals on purpose: the input lists are what
 * make a firing ratchet print a field-level LINE DIFF instead of two hex
 * numbers — without them the old inputs live nowhere and no diff is possible
 * (docs/PACKS.md: the reviewable artifact is the diff, not the hash). When a
 * ratchet fails: read the diff `npm run release:verify` prints, decide
 * whether you meant to change that pack, bump its VERSION here, and paste
 * the new fingerprint and changed input lines — in the same commit.
 */
export const CORE_PACK_VERSION = 1;
export const CORE_FINGERPRINT = 0xc1ddfbcb;
export const CORE_INPUTS: readonly string[] = Object.freeze([
  'tick=50',
  'match=480000',
  'score=30',
  'g=28',
  'run=9.5',
  'sprint=12.6',
  'terrain=5',
]);

export const WEAPONS_PACK_VERSION = 1;
export const WEAPONS_FINGERPRINT = 0x1834e116;
export const WEAPONS_INPUTS: readonly string[] = Object.freeze([
  '0:17/1/2/420/15/400/850/0/0/0/0.01/0.03/0.006',
  '1:11/7/1.6/75/8/80/2400/0/0/0/0.09/0.11/0.01',
  '2:9/1/1.8/700/100/400/3200/0/0/0/0.009/0.055/0.0038',
  '3:92/1/1/88/5/40/2500/4.4/108/2.6/0/0/0',
  '4:21/1/1.4/660/60/400/1900/0.9/8/0/0.014/0.03/0.0016',
  '5:240/1/1/40/3/400/3400/9.5/400/5.5/0/0/0',
  '6:26/1/1.3/480/0/0/0/0/0/0/0/0/0',
]);

export const CHARACTERS_PACK_VERSION = 1;
export const CHARACTERS_FINGERPRINT = 0xe2ae60ab;
export const CHARACTERS_INPUTS: readonly string[] = Object.freeze([
  'rig=leg-left,leg-right,torso,arm-left,arm-right,head',
  'atlas=3x2',
  'Imp:0/1.3,1.02,0.86/1.75/63/1,1,1,1,1,1,1,1,1,0.94,0.94,0.94,0.92,1.22,0.92,0.92,1.22,0.92,1.05,1,1.05/0.2/010/0/0/1.25',
  'Trooper:1/1.34,1.3,1.1/1.8/63/1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1/0.04/100/0/0/1',
  'Baron:2/1.06,0.94,0.82/2.4/63/1,1,1,1.35,0.94,1.35,1.35,0.94,1.35,1.55,1.02,1.45,1.55,1.06,1.55,1.55,1.06,1.55,1.16,1,1.16/0.07/110/0/0/0.62',
  'Cacodemon:3/1.45,0.72,0.62/1.7/60/1,1,1,1,1,1,1,1,1,1.95,1.42,1.95,0.8,0.62,0.8,0.8,0.62,0.8,1.42,1.3,1.42/0/001/0.22/0/1',
  'Lost Soul:2/1.55,1.3,0.8/0.7/32/1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1/0/011/0.14/0/1',
  'Marine:4/1.14,1.14,1.14/1.8/63/1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1/0/100/0/0/1',
]);

/**
 * The FLAG_ORDER this release was authored against (gate check `flags.order`).
 * A checked-in COPY on purpose: the live order in shared/src/flags.ts must
 * START with exactly this list — appending is legal, inserting or reordering
 * re-means every bit an old client has compiled in. When you append a flag,
 * append it here too, in the same commit.
 */
export const BUILTIN_FLAG_ORDER: readonly string[] = Object.freeze([
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
]);

/** The protocol fingerprint this release was authored against (gate check `protocol.stable`). */
export const BUILTIN_PROTOCOL_FINGERPRINT = 0x04e8d61f;

function builtinPack(kind: PackKind, version: number, declared: number, inputs: readonly string[]): PackVersion {
  const def = PACKS[kind];
  if (def === undefined) throw new Error(`no PackDef for kind ${kind}`);
  return Object.freeze({
    kind,
    key: def.key,
    version,
    fingerprint: declared >>> 0,
    inputs: Object.freeze([...inputs]),
    digest: '',
    label: `${def.key}@${version}`,
  });
}

/**
 * The three build packs compiled into this binary. Data packs (levels,
 * campaign) are files discovered at runtime and are appended by the host that
 * loaded them — see `levelsPack()` and server/src/index.ts.
 */
export const BUILTIN_PACKS: readonly PackVersion[] = Object.freeze([
  builtinPack(PackKind.CORE, CORE_PACK_VERSION, CORE_FINGERPRINT, CORE_INPUTS),
  builtinPack(PackKind.WEAPONS, WEAPONS_PACK_VERSION, WEAPONS_FINGERPRINT, WEAPONS_INPUTS),
  builtinPack(PackKind.CHARACTERS, CHARACTERS_PACK_VERSION, CHARACTERS_FINGERPRINT, CHARACTERS_INPUTS),
]);

/**
 * The release this binary declares, and the total-function fallback for
 * `resolveRelease`. Revision 0 marks it as compiled-in: no document ever
 * assigns revision 0, so it can never collide with a stored release.
 */
export const BUILTIN_RELEASE: Release = Object.freeze({
  revision: 0,
  state: 'live' as const,
  ordinal: CONTENT_VERSION,
  packs: BUILTIN_PACKS,
  rolloutBp: 10000,
  baseRevision: 0,
  gate: null,
  createdMs: 0,
  publishedMs: 0,
  note: 'compiled-in',
});

/**
 * What `contentHashFor()` with no level hashes used to be: the content
 * identity of a room built from this binary alone. The in-browser room
 * (client/src/net/localServer.ts) and the Room/net defaults use it.
 */
export const BUILTIN_CONTENT_HASH: number = packSetHash(BUILTIN_PACKS, CONTENT_VERSION);

/* ------------------------------------------------------------------------ *
 * Data packs a host assembles from what it loaded
 * ------------------------------------------------------------------------ */

/**
 * The levels pack a host is actually serving, folded from every installed
 * level's own content hash. Sorted by id inside, so directory scan order can
 * never move the fingerprint. This is the successor of the level-hash fold
 * that `contentHashFor(levelHashes)` used to do — same purpose (two hosts on
 * the same CONTENT_VERSION with different files on disk must differ in
 * /api/version), now carried by a pack with a reviewable input list.
 *
 * `digest` is left '' here: sha256 over the canonical bytes needs node:crypto
 * and belongs to the server-side inventory (phase 2) and the verify tool.
 */
export function levelsPack(
  entries: readonly { id: string; hash: number }[], version = 1,
): PackVersion {
  // Code-unit comparison, NOT localeCompare: ids are [a-z0-9_-] and this
  // fingerprint must agree across hosts regardless of their locale — a
  // collation-dependent sort is a false mixed-fleet alarm waiting to happen.
  const inputs = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => `${e.id}:${(e.hash >>> 0).toString(16).padStart(8, '0')}`);
  return Object.freeze({
    kind: PackKind.LEVELS,
    key: 'levels',
    version,
    fingerprint: fingerprint(inputs.join('|')),
    inputs: Object.freeze(inputs),
    digest: '',
    label: `levels@${version}`,
  });
}

/**
 * The items pack, from an items manifest's canonical input lines (one per
 * item, id-sorted — shared/src/items.ts). Digest is filled by the server
 * inventory and the verify tool, same as levels.
 */
export function itemsPack(inputs: readonly string[], version = 1): PackVersion {
  return Object.freeze({
    kind: PackKind.ITEMS,
    key: 'items',
    version,
    fingerprint: fingerprint(inputs.join('|')),
    inputs: Object.freeze([...inputs]),
    digest: '',
    label: `items@${version}`,
  });
}

/**
 * The quests pack: challenge definitions, from a challenges manifest's
 * canonical input lines (one per def, id-sorted — shared/src/challenges.ts).
 * Digest is filled by the server inventory and the verify tool, same as
 * levels and items.
 */
export function questsPack(inputs: readonly string[], version = 1): PackVersion {
  return Object.freeze({
    kind: PackKind.QUESTS,
    key: 'quests',
    version,
    fingerprint: fingerprint(inputs.join('|')),
    inputs: Object.freeze([...inputs]),
    digest: '',
    label: `quests@${version}`,
  });
}

/**
 * The campaign pack: the ORDER, from content/episodes.json. Inputs are one
 * line per episode plus the default pointer, so the console diff of a
 * re-ordered episode reads as exactly that.
 */
export function campaignPack(
  manifest: {
    readonly defaultEpisode: string;
    readonly episodes: readonly { readonly id: string; readonly levels: readonly string[] }[];
  },
  version = 1,
): PackVersion {
  const inputs = [
    `default=${manifest.defaultEpisode}`,
    ...manifest.episodes.map((e) => `${e.id}:${e.levels.join(',')}`),
  ];
  return Object.freeze({
    kind: PackKind.CAMPAIGN,
    key: 'campaign',
    version,
    fingerprint: fingerprint(inputs.join('|')),
    inputs: Object.freeze(inputs),
    digest: '',
    label: `campaign@${version}`,
  });
}
