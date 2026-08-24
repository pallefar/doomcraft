/**
 * DOOMCRAFT — the three version axes.
 *
 * `docs/INFRASTRUCTURE.md` §6 rule 0: there is no such thing as "the game
 * version". There are three axes with cadences two orders of magnitude apart,
 * and conflating them is what makes a deploy hurt.
 *
 *   | axis               | owns                          | cadence     | gates a connection?          |
 *   |--------------------|-------------------------------|-------------|------------------------------|
 *   | `PROTOCOL_VERSION` | wire layout, quantisation     | a few / yr  | YES — against a WINDOW       |
 *   | `CONTENT_VERSION`  | levels, weapon tables, modes  | weekly      | no — matches PER ROOM        |
 *   | `BUILD_ID`         | the client bundle hash        | daily       | NEVER — telemetry only       |
 *
 * The protocol axis lives in `protocol.ts`, next to the bytes it describes, so
 * that whoever changes a layout sees the number they have to move. This file
 * re-exports it so all three axes can be read in one place.
 *
 * ## Why a window and not equality
 *
 * `server/src/net.ts` used to compare `hello.protocolVersion !== PROTOCOL_VERSION`
 * and close the socket. Under that rule the first byte of a deploy is a
 * fleet-wide simultaneous logout: every connected client is one version behind
 * by definition the moment the new binary answers. A window makes the old
 * client a supported client for as long as the window says, which is what turns
 * a deploy from an outage into a background event.
 *
 * ## Sizing the window
 *
 * `PROTOCOL_WINDOW_DAYS` is the promise, not the mechanism: it is how long an
 * un-updated tab is guaranteed to keep working. INFRASTRUCTURE.md says to take
 * p99 session length and p99 days-since-last-visit off telemetry and set the
 * window at 3x the longer. There is no telemetry yet, so 14 is the published
 * placeholder and `docs/PATCHING.md` says out loud that it is a placeholder.
 * What matters is that the number is written down and that
 * `PROTOCOL_MIN_SUPPORTED` is only ever raised deliberately.
 *
 * ## What "supported" costs
 *
 * `PROTOCOL_MIN_SUPPORTED = 2` is not a promise made on paper. v2 -> v3 added
 * `S2C.CHUNK_Z` behind the `CAP_INFLATE` capability bit, so a v2 client simply
 * never sets the bit and the server never sends the compressed form: the two
 * are genuinely interoperable and `server/src/patch.test.ts` proves it by
 * running a v2 handshake against the real room. v1 is NOT in the window — a v1
 * decoder cannot skip the `PF_AVATAR` field bit, so it would mis-parse every
 * spawn record — and that is exactly the kind of break a window has to be
 * allowed to refuse.
 */

import {
  ANGLE_SCALE,
  C2S,
  CAP_INFLATE,
  PF_ALL,
  PITCH_SCALE,
  POS_SCALE,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  S2C,
  UNIT_SCALE,
  EF_ALL,
  RF_ALL,
} from './protocol.ts';
import { GRAVITY, MATCH_DURATION_MS, SCORE_LIMIT, SPEED_RUN, SPEED_SPRINT, TICK_MS } from './constants.ts';
import { TERRAIN_VERSION } from './terrain.ts';
import { WEAPONS } from './weapons.ts';

export { PROTOCOL_VERSION, PROTOCOL_MIN_SUPPORTED };

/* ------------------------------------------------------------------------ *
 * Axis 2 — content
 * ------------------------------------------------------------------------ */

/**
 * Levels, weapon damage, mode constants — everything a room and its players
 * must agree on but that no byte layout depends on.
 *
 * Bump this for ANY balance or content change. It never gates a connection: a
 * room pins the value it was constructed with and keeps serving it for its
 * whole life, so a balance patch reaches every NEW room immediately and no
 * in-flight match ever has its time-to-kill changed underneath it.
 */
export const CONTENT_VERSION = 1;

/**
 * The oldest content a live room may still be running.
 *
 * Rooms outlive a deploy on purpose (that is the drain), so the director has to
 * know how far back it is willing to keep routing rejoins. Beyond this, a room
 * is finished but not re-joinable.
 */
export const CONTENT_MIN_SUPPORTED = 1;

/*
 * The single CONTENT_FINGERPRINT constant is gone: content identity is
 * per-pack now (docs/PACKS.md phase 1). The declared values live on
 * `BUILTIN_PACKS` in `shared/src/packs.ts`; the input functions that recompute
 * them are below, and `npm run release:verify` plus the ratchet tests compare
 * the two. "Bump CONTENT_VERSION for any balance change" survives unchanged —
 * what changed is that a weapons edit now moves ONLY the weapons fingerprint,
 * which is what lets a levels release ship without implicating the gun tables.
 */

/* ------------------------------------------------------------------------ *
 * Axis 3 — build id
 * ------------------------------------------------------------------------ */

declare const __DC_BUILD_ID__: string | undefined;

/**
 * Declared BEFORE `BUILD_ID`, and it has to be.
 *
 * `BUILD_ID` is initialised at module load by calling `resolveBuildId()`, which
 * calls `sanitiseBuildId()`, which reads this. A `const` declared further down
 * the file is in its temporal dead zone at that moment and throws — and it
 * throws only on the path where `DOOMCRAFT_BUILD_ID` is actually set, which is
 * to say only in production. `server/src/deploy.test.ts` boots the real binary
 * with the variable set, which is how this was found.
 */
export const MAX_BUILD_ID_LENGTH = 32;

/**
 * The bundle identity. Stamped by the bundler (`define` in
 * `client/vite.config.ts`) or by the environment on the server, `'dev'` when
 * neither is present.
 *
 * **This never gates anything.** It exists so a crash report, a metric and a
 * support ticket can name the same bytes. If you ever find yourself writing
 * `if (buildId === ...)`, you wanted one of the other two axes.
 */
export const BUILD_ID: string = resolveBuildId();

function resolveBuildId(): string {
  try {
    if (typeof __DC_BUILD_ID__ === 'string' && __DC_BUILD_ID__.length > 0) return __DC_BUILD_ID__;
  } catch { /* not defined by the bundler; fall through */ }
  // `process` is reached through globalThis so this module still runs in a
  // Worker and in the browser, where `process` does not exist at all.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.DOOMCRAFT_BUILD_ID;
  if (typeof v === 'string' && v.length > 0) return sanitiseBuildId(v);
  return 'dev';
}

/** Build ids travel in a packet and in a header. Keep them boring. */
export function sanitiseBuildId(v: string): string {
  let out = '';
  for (let i = 0; i < v.length && out.length < MAX_BUILD_ID_LENGTH; i++) {
    const c = v[i];
    if (/[A-Za-z0-9._-]/.test(c)) out += c;
  }
  return out.length > 0 ? out : 'dev';
}

/* ------------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------------ */

/**
 * How long an un-updated client is promised it will keep working. Published in
 * `docs/PATCHING.md`; the drain deadline and the "keep the old hosts up" rule
 * are both derived from it.
 */
export const PROTOCOL_WINDOW_DAYS = 14;

/** Why a connection was refused. Travels as a `u8` in `S2C.UPDATE_REQUIRED`. */
export enum UpdateReason {
  NONE = 0,
  /** The client speaks a protocol older than this build still accepts. */
  PROTOCOL_TOO_OLD = 1,
  /** The client is NEWER than the server — a rollback, or a stale host. */
  PROTOCOL_TOO_NEW = 2,
  /** The room's content is older than this client can render, or vice versa. */
  CONTENT_UNAVAILABLE = 3,
  /** This host is draining: finish your match here, start the next elsewhere. */
  HOST_DRAINING = 4,
  /** Operator kill switch: this exact bundle is refused. */
  BUILD_REVOKED = 5,
}

/**
 * WebSocket close codes, in the 4000-4999 private range.
 *
 * The close code is the BELT and `S2C.UPDATE_REQUIRED` is the braces. A client
 * that predates `UPDATE_REQUIRED` cannot decode the message — it ignores the
 * unknown id — but every WebSocket client since the beginning of time can read
 * a close code and a reason string. So the reason is always sent twice, in two
 * forms, and the older form is the one that is guaranteed to land.
 */
export const CLOSE_PROTOCOL_TOO_OLD = 4001;
export const CLOSE_PROTOCOL_TOO_NEW = 4002;
export const CLOSE_CONTENT_UNAVAILABLE = 4003;
export const CLOSE_HOST_DRAINING = 4004;
export const CLOSE_BUILD_REVOKED = 4005;

export const CLOSE_CODE_BY_REASON: Readonly<Record<UpdateReason, number>> = Object.freeze({
  [UpdateReason.NONE]: 1000,
  [UpdateReason.PROTOCOL_TOO_OLD]: CLOSE_PROTOCOL_TOO_OLD,
  [UpdateReason.PROTOCOL_TOO_NEW]: CLOSE_PROTOCOL_TOO_NEW,
  [UpdateReason.CONTENT_UNAVAILABLE]: CLOSE_CONTENT_UNAVAILABLE,
  [UpdateReason.HOST_DRAINING]: CLOSE_HOST_DRAINING,
  [UpdateReason.BUILD_REVOKED]: CLOSE_BUILD_REVOKED,
});

/** True when a client speaking `v` can be served by this build. */
export function isProtocolSupported(v: number, min = PROTOCOL_MIN_SUPPORTED, cur = PROTOCOL_VERSION): boolean {
  return Number.isInteger(v) && v >= min && v <= cur;
}

export interface ProtocolVerdict {
  ok: boolean;
  reason: UpdateReason;
  closeCode: number;
  /** Short, human, and safe to show in a dialog. */
  detail: string;
}

const VERDICT_OK: ProtocolVerdict = Object.freeze({
  ok: true, reason: UpdateReason.NONE, closeCode: 1000, detail: '',
});

/**
 * The whole handshake decision, in one total function so the server has no
 * room to phrase it differently than the tests do.
 *
 * "Too new" is a real case and it is not the client's fault: it happens during
 * a rollback, and to the unlucky client that hit an old host through a stale
 * DNS answer. It gets its own reason so the client can retry the director
 * rather than nagging the player to update to a build they already have.
 */
export function checkProtocol(
  v: number, min = PROTOCOL_MIN_SUPPORTED, cur = PROTOCOL_VERSION,
): ProtocolVerdict {
  if (isProtocolSupported(v, min, cur)) return VERDICT_OK;
  if (!Number.isInteger(v) || v < min) {
    return {
      ok: false,
      reason: UpdateReason.PROTOCOL_TOO_OLD,
      closeCode: CLOSE_PROTOCOL_TOO_OLD,
      detail: `client protocol ${fmt(v)} is older than the supported window (${min}-${cur})`,
    };
  }
  return {
    ok: false,
    reason: UpdateReason.PROTOCOL_TOO_NEW,
    closeCode: CLOSE_PROTOCOL_TOO_NEW,
    detail: `client protocol ${fmt(v)} is newer than this host (${min}-${cur})`,
  };
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(v | 0) : 'unknown';
}

/**
 * What the player is told, per reason. The client shows this; nothing branches
 * on the string.
 */
export const UPDATE_REASON_TEXT: Readonly<Record<UpdateReason, string>> = Object.freeze({
  [UpdateReason.NONE]: '',
  [UpdateReason.PROTOCOL_TOO_OLD]: 'This tab is running an old version of Doomcraft. Reload to keep playing online.',
  [UpdateReason.PROTOCOL_TOO_NEW]: 'That server is running an older version. Finding you another one…',
  [UpdateReason.CONTENT_UNAVAILABLE]: 'This match needs content your build does not have. Reload to fetch it.',
  [UpdateReason.HOST_DRAINING]: 'This server is going down for an update. Your next match starts on the new one.',
  [UpdateReason.BUILD_REVOKED]: 'This build has been withdrawn. Reload to get the current one.',
});

/**
 * True when the reason means "the bytes in this tab are wrong" — i.e. the
 * client must reload even if it costs the player their place.
 *
 * This is the ONE path that is allowed to override the service worker's
 * never-activate-while-playing rule, and only after the match is over: see
 * `client/src/boot/updates.ts`.
 */
export function requiresClientReload(reason: UpdateReason): boolean {
  return reason === UpdateReason.PROTOCOL_TOO_OLD
    || reason === UpdateReason.CONTENT_UNAVAILABLE
    || reason === UpdateReason.BUILD_REVOKED;
}

/* ------------------------------------------------------------------------ *
 * Fingerprints — the part CI enforces
 * ------------------------------------------------------------------------ */

/** FNV-1a over UTF-16 code units. Small, stable, and not a security control. */
export function fingerprint(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Everything whose byte position or numeric meaning is frozen for the life of
 * `PROTOCOL_VERSION`.
 *
 * INFRASTRUCTURE.md §6 rule 2: "never renumber a message id, reorder a bitmask
 * bit, or change a quantisation constant without a version bump — add a test
 * that fails if the constants move." This is that test's input. It deliberately
 * does NOT include anything additive: appending a new message id at the end is
 * legal and must not trip the ratchet, so ids enter the string by NAME=VALUE
 * for the ids that existed at the frozen version, listed explicitly.
 */
export function protocolFingerprint(): number {
  const parts = [
    // Quantisation. Changing any of these silently teleports every player.
    `pos=${POS_SCALE}`, `ang=${ANGLE_SCALE}`,
    `pitch=${PITCH_SCALE}`, `unit=${UNIT_SCALE}`,
    // Message ids that shipped in the frozen version.
    `c2s.hello=${C2S.HELLO}`, `c2s.input=${C2S.INPUT}`, `c2s.edit=${C2S.BLOCK_EDIT}`,
    `c2s.chat=${C2S.CHAT}`, `c2s.respawn=${C2S.RESPAWN}`, `c2s.ping=${C2S.PING}`,
    `c2s.appearance=${C2S.APPEARANCE}`,
    `s2c.welcome=${S2C.WELCOME}`, `s2c.chunk=${S2C.CHUNK}`, `s2c.snapshot=${S2C.SNAPSHOT}`,
    `s2c.blocks=${S2C.BLOCK_DELTA}`, `s2c.damage=${S2C.DAMAGE}`, `s2c.kill=${S2C.KILL}`,
    `s2c.chat=${S2C.CHAT}`, `s2c.pong=${S2C.PONG}`, `s2c.chunkz=${S2C.CHUNK_Z}`,
    // Bitmask widths. A retired bit is burned, never reused, so the ALL masks
    // are the thing that must not shrink or shuffle.
    `pf=${PF_ALL}`, `ef=${EF_ALL}`, `rf=${RF_ALL}`, `cap.inflate=${CAP_INFLATE}`,
  ];
  return fingerprint(parts.join('|'));
}

/**
 * What used to be one `contentFingerprint()` is two input lists, split along
 * the pack boundary (docs/PACKS.md §1): the mode constants that decide when a
 * match ends are CORE, the weapon tables a balance patch touches are WEAPONS.
 * Every string is byte-identical to what the joint function produced, plus one
 * addition: `terrain=` joins core, because the arena generator was in no
 * fingerprint at all — a voxel-moving change was invisible to every ratchet
 * (docs/PACKS.md §1.4: the whole maps-as-a-pack intervention is this line).
 *
 * The input STRINGS are exported, not just the hash, because they are what
 * `PackVersion.inputs` stores and what the release console line-diffs: the
 * reviewable artifact is the diff, never the number.
 */
export function coreFingerprintInputs(): string[] {
  return [
    `tick=${TICK_MS}`, `match=${MATCH_DURATION_MS}`, `score=${SCORE_LIMIT}`,
    `g=${GRAVITY}`, `run=${SPEED_RUN}`, `sprint=${SPEED_SPRINT}`,
    `terrain=${TERRAIN_VERSION}`,
  ];
}

/**
 * The weapons table is a parameter so a test can prove the independence claim
 * — one changed field moves this fingerprint and no other — without editing
 * this module. Callers never pass it.
 */
export function weaponsFingerprintInputs(weapons: typeof WEAPONS = WEAPONS): string[] {
  const parts: string[] = [];
  for (const w of weapons) {
    parts.push(
      `${w.id}:${w.damage}/${w.pellets}/${w.headshotMultiplier}/${w.rpm}`
      + `/${w.magSize}/${w.reserveMax}/${w.reloadMs}`
      + `/${w.splashRadius}/${w.splashDamage}/${w.terrainDamage}`
      + `/${w.spread}/${w.spreadMax}/${w.spreadPerShot}`,
    );
  }
  return parts;
}

export function coreFingerprint(): number {
  return fingerprint(coreFingerprintInputs().join('|'));
}

export function weaponsFingerprint(weapons: typeof WEAPONS = WEAPONS): number {
  return fingerprint(weaponsFingerprintInputs(weapons).join('|'));
}
