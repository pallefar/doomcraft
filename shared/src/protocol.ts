/**
 * DOOMCRAFT — binary wire protocol.
 *
 * ArrayBuffer + DataView, little-endian, no JSON anywhere on the hot path.
 * Every message begins with one uint8 message id. Encoders write into a reusable
 * PacketWriter; decoders read from a reusable PacketReader into caller-owned
 * output objects, so a steady-state frame allocates nothing.
 *
 * Quantisation (fixed for the life of PROTOCOL_VERSION):
 *   position  int16  at 1/64 m   -> +/-512 m, 15.6 mm resolution
 *   velocity  int16  at 1/64 m/s
 *   yaw       uint16 over 2*PI   -> 0.0055 deg
 *   pitch     int16  over +/-PI/2
 *   unit axis int16  at 1/32767
 *   health    uint8
 */

import {
  MAX_PLAYERS, MAX_ENTITIES, MAX_PROJECTILES,
  MAX_NAME_LENGTH, MAX_CHAT_LENGTH, MAX_BLOCK_DELTAS_PER_MESSAGE,
  CHUNK_VOLUME,
} from './constants.ts';

/**
 * 1 -> 2: player appearance grew from one `skin` byte to a 4-byte packed avatar
 * (see client/src/characters/avatar.ts). It travels as a new player field bit,
 * PF_AVATAR, plus a trailing uint32 on HELLO and a new C2S.APPEARANCE message.
 * The spawn record is byte-identical to v1, but a v1 decoder cannot skip an
 * unknown field bit, so the version still had to move.
 *
 * 2 -> 3: the join burst is compressible. `S2C.CHUNK_Z` carries the same RLE
 * stream as `S2C.CHUNK` behind a raw-deflate frame, and `CAP_INFLATE` in HELLO
 * is how a client says it can unwrap one. Nothing about `S2C.CHUNK` changed —
 * a server that has no deflate available, or a client that cannot inflate,
 * keeps using it and the two paths are byte-identical once decoded.
 */
export const PROTOCOL_VERSION = 3;

/**
 * The OLDEST protocol this build still serves. Axis 1 of three — see
 * `shared/src/version.ts` for the other two and for why this is a window
 * rather than an equality test.
 *
 * Raising this is a deliberate act with a date attached: it strands every tab
 * that has not reloaded inside `PROTOCOL_WINDOW_DAYS`. Lowering it is free but
 * dishonest unless the older version genuinely still works — v2 does, because
 * v2 -> v3 hid entirely behind the `CAP_INFLATE` capability bit, and
 * `server/src/patch.test.ts` runs a real v2 handshake to keep that true.
 *
 * v1 is deliberately outside the window: a v1 decoder cannot skip the
 * `PF_AVATAR` field bit, so it would mis-parse every spawn record.
 */
export const PROTOCOL_MIN_SUPPORTED = 2;

/* ------------------------------------------------------------------------ *
 * Message ids
 * ------------------------------------------------------------------------ */

/** Client -> server. */
export enum C2S {
  HELLO = 1,
  INPUT = 2,
  BLOCK_EDIT = 3,
  CHAT = 4,
  RESPAWN = 5,
  PING = 6,
  /**
   * A live appearance change. The avatar editor is reachable from the pause
   * menu while the match is already connected, so the alternative would be
   * forcing a reconnect to change a colour.
   */
  APPEARANCE = 7,
}

/** Server -> client. */
export enum S2C {
  WELCOME = 1,
  CHUNK = 2,
  SNAPSHOT = 3,
  BLOCK_DELTA = 4,
  DAMAGE = 5,
  KILL = 6,
  CHAT = 7,
  PONG = 8,
  /**
   * A CHUNK whose RLE payload is raw-deflated. Sent only to a client that set
   * `CAP_INFLATE`, and only by a server that was handed a deflate function
   * (`setChunkCompressor` in server/src/net.ts). Same chunk, same RLE, ~3.8x
   * smaller on the wire.
   */
  CHUNK_Z = 9,
  /**
   * "I cannot serve you, and here is exactly why." Sent immediately before the
   * socket closes, so a client that IS new enough to decode it can show the
   * player a reason and take the right action instead of guessing at a close
   * code. See `shared/src/version.ts` for the reason codes.
   *
   * Additive, and therefore NOT a protocol bump: `client/src/net/client.ts`
   * has always had `default: break` on an unknown message id, so a v2 client
   * ignores this and falls back to the close code — which carries the same
   * verdict. Belt and braces, on purpose.
   */
  UPDATE_REQUIRED = 10,
  /**
   * The room's identity on the two axes that are not the protocol: which
   * content it is running, and which feature flags the SERVER resolved for
   * this player. Sent once, right after `WELCOME`.
   *
   * Flags are resolved server-side and told to the client — the client never
   * decides. That is what makes a flag a kill switch rather than a suggestion,
   * and it is why this rides the game socket instead of being a second HTTP
   * request per player (docs/INFRASTRUCTURE.md prices that mistake at
   * ~$10.8k/month).
   */
  SESSION_CONFIG = 11,
  /**
   * "This is what the round was worth, and this is what you now hold."
   *
   * Sent once per player per round, right after the server has written the
   * profile — so the numbers on it are what LANDED, after the trust table, the
   * per-match ceiling, the per-day cap and the diminishing-returns ladder have
   * all had their say. The client never computes any of it; it renders this.
   *
   * Additive, and therefore NOT a protocol bump: `protocolFingerprint()` lists
   * the ids frozen at v3 by name, and `client/src/net/client.ts` has always had
   * `default: break` on an unknown id, so a v2 client ignores this entirely.
   */
  MATCH_AWARD = 12,
  /**
   * The variant stat table this ROOM pinned, plus this player's resolved
   * per-weapon variant slots. Sent once, immediately after `SESSION_CONFIG`.
   *
   * The client does not merge this with anything: every whitelisted field
   * arrives at its EFFECTIVE value, so a variant's numbers come off the wire
   * rather than out of the receiving bundle's compiled table. What the wire
   * does NOT carry — `spreadAir`, `spreadRecovery`, `spreadCrouchScale`,
   * `reloadShellMs`, `knockback`, the feel fields — is still read from the
   * compiled archetype on both sides, exactly as it is for the base weapon
   * today. The wire narrows the trust surface to the 16 fields a variant may
   * move; it does not abolish it. See docs/VARIANTS.md 3.
   *
   * Additive, and therefore NOT a protocol bump, for the same two reasons
   * `MATCH_AWARD` was: `protocolFingerprint()` lists the ids frozen at v3 BY
   * NAME and stops at `s2c.chunkz`, and `client/src/net/client.ts` has always
   * had `default: break` on an unknown id. A client that predates this bit
   * also never sets `CAP_VARIANTS`, and a server that sees no `CAP_VARIANTS`
   * resolves every claim to the base — so the old bundle is not merely
   * ignorant of the message, it is genuinely playing the game it thinks it is.
   *
   * The layout is FROZEN. A later addition — V4 wants a display name for the
   * HUD and the killfeed — is a SEPARATE additive message, not a field
   * appended here: a v3 decoder handed `str name` after the id would read
   * "Slug"'s length byte as `base` and its four letters as the first float,
   * 1.1589780174433289e24, and never know.
   */
  VARIANT_TABLE = 13,
}

/* ------------------------------------------------------------------------ *
 * Bitfields
 * ------------------------------------------------------------------------ */

/** InputCommand.buttons */
export const BTN_FIRE = 1 << 0;
export const BTN_ALT_FIRE = 1 << 1;
export const BTN_JUMP = 1 << 2;
export const BTN_CROUCH = 1 << 3;
export const BTN_SPRINT = 1 << 4;
export const BTN_RELOAD = 1 << 5;
export const BTN_USE = 1 << 6;
export const BTN_MELEE = 1 << 7;
export const BTN_BUILD = 1 << 8;
export const BTN_NEXT_WEAPON = 1 << 9;
export const BTN_PREV_WEAPON = 1 << 10;
export const BTN_RESPAWN = 1 << 11;

/** Player movement / action state, one uint8 on the wire. */
export const PS_ON_GROUND = 1 << 0;
export const PS_CROUCHING = 1 << 1;
export const PS_SPRINTING = 1 << 2;
export const PS_DEAD = 1 << 3;
export const PS_IN_WATER = 1 << 4;
export const PS_FIRING = 1 << 5;
export const PS_RELOADING = 1 << 6;
export const PS_BOT = 1 << 7;

/** Snapshot header flags. */
export const SNAP_FULL = 1 << 0;
export const SNAP_MATCH_OVER = 1 << 1;

/** Player record field mask bits. */
export const PF_SPAWN = 1 << 0;    // payload: u8 nameLen, name bytes, u8 skin
export const PF_REMOVED = 1 << 1;  // no payload
export const PF_POS = 1 << 2;      // i16 x, i16 y, i16 z
export const PF_YAW = 1 << 3;      // u16
export const PF_PITCH = 1 << 4;    // i16
export const PF_VEL = 1 << 5;      // i16 vx, i16 vy, i16 vz
export const PF_HEALTH = 1 << 6;   // u8
export const PF_ARMOR = 1 << 7;    // u8
export const PF_WEAPON = 1 << 8;   // u8
export const PF_STATE = 1 << 9;    // u8 (PS_* bits)
export const PF_AMMO = 1 << 10;    // u16 mag, u16 reserve  (local player only)
export const PF_SCORE = 1 << 11;   // u16 kills, u16 deaths
export const PF_TEAM = 1 << 12;    // u8
export const PF_LOCAL = 1 << 13;   // no payload: this record is the receiving client
/**
 * u32 packed avatar — four outfit indices and two palette indices. It rides the
 * ordinary delta machinery rather than PF_SPAWN, which is what lets a player
 * change outfit mid-session without a reconnect and without an interpolation
 * reset. 4 bytes, sent on join and then only when it actually changes.
 */
export const PF_AVATAR = 1 << 14; // u32

/** Entity record field mask bits. */
export const EF_SPAWN = 1 << 0;    // u8 type, u8 variant
export const EF_REMOVED = 1 << 1;  // u8 reason
export const EF_POS = 1 << 2;      // i16 x, i16 y, i16 z
export const EF_YAW = 1 << 3;      // u16
export const EF_HEALTH = 1 << 4;   // u16
export const EF_STATE = 1 << 5;    // u8
export const EF_VEL = 1 << 6;      // i16 vx, i16 vy, i16 vz

/** Projectile record field mask bits. */
export const RF_SPAWN = 1 << 0;    // u8 weapon, u16 owner
export const RF_REMOVED = 1 << 1;  // u8 reason
export const RF_POS = 1 << 2;      // i16 x, i16 y, i16 z
export const RF_VEL = 1 << 3;      // i16 vx, i16 vy, i16 vz

/** DamageEvent.flags */
export const DMG_HEADSHOT = 1 << 0;
export const DMG_SPLASH = 1 << 1;
export const DMG_FATAL = 1 << 2;
export const DMG_SELF = 1 << 3;
export const DMG_FALL = 1 << 4;
export const DMG_ENVIRONMENT = 1 << 5;
/** Set when the receiving client is the victim; cleared when it is the attacker. */
export const DMG_YOU_ARE_VICTIM = 1 << 6;

/** KillEvent.flags */
export const KILL_HEADSHOT = 1 << 0;
export const KILL_MELEE = 1 << 1;
export const KILL_SELF = 1 << 2;
export const KILL_ENVIRONMENT = 1 << 3;

/** Client capability bits sent in HELLO. */
export const CAP_TOUCH = 1 << 0;
export const CAP_LOW_SPEC = 1 << 1;
export const CAP_ADS_REMOVED = 1 << 2;
export const CAP_RETURNING = 1 << 3;
/**
 * "I can inflate a raw-deflate stream off the main thread." Set only when the
 * client has both `DecompressionStream` and somewhere to run it. A server that
 * sees this bit may answer with `S2C.CHUNK_Z` instead of `S2C.CHUNK`; a server
 * that sees it and has no compressor simply ignores it.
 */
export const CAP_INFLATE = 1 << 4;
/**
 * "I understand `S2C.VARIANT_TABLE`, so you may resolve my variant claims."
 *
 * THIS BIT IS A SAFETY INTERLOCK, NOT AN OPTIMISATION. `onHello` checks the
 * protocol window and whether the host is draining, and nothing else —
 * `server/src/patch.test.ts` admits a client declaring content version 99 on
 * purpose. Without this bit a bundle that predates variants would be welcomed,
 * would ignore opcode 13, and would fire BASE stats while the server resolved
 * VARIANT stats: a four-shell shotgun variant would hand it eight shells and
 * a damage number 10% out on every pellet. So a connection that does not set
 * it has every claim resolved to `BASE_SLOT`, and that resolution happens
 * before the first magazine is filled.
 */
export const CAP_VARIANTS = 1 << 5;

/* ------------------------------------------------------------------------ *
 * Enums carried in payloads
 * ------------------------------------------------------------------------ */

export enum BlockAction {
  BREAK = 0,
  PLACE = 1,
}

export enum EntityType {
  IMP = 0,
  ZOMBIE = 1,
  CACODEMON = 2,
  BARON = 3,
  LOST_SOUL = 4,
  PICKUP_HEALTH = 16,
  PICKUP_ARMOR = 17,
  PICKUP_AMMO = 18,
  PICKUP_WEAPON = 19,
}

export enum RemoveReason {
  EXPIRED = 0,
  HIT_WORLD = 1,
  HIT_ENTITY = 2,
  KILLED = 3,
  PICKED_UP = 4,
  DESPAWNED = 5,
}

export enum ChatChannel {
  ALL = 0,
  TEAM = 1,
  SYSTEM = 2,
  KILLFEED = 3,
  TIP = 4,
}

/* ------------------------------------------------------------------------ *
 * Quantisation
 * ------------------------------------------------------------------------ */

export const POS_SCALE = 64;
export const POS_INV_SCALE = 1 / 64;
export const ANGLE_SCALE = 65536 / (Math.PI * 2);
export const ANGLE_INV_SCALE = (Math.PI * 2) / 65536;
export const PITCH_SCALE = 32767 / (Math.PI / 2);
export const PITCH_INV_SCALE = (Math.PI / 2) / 32767;
export const UNIT_SCALE = 32767;
export const UNIT_INV_SCALE = 1 / 32767;

export function quantizePos(m: number): number {
  const q = Math.round(m * POS_SCALE);
  return q < -32768 ? -32768 : q > 32767 ? 32767 : q;
}
export function dequantizePos(q: number): number { return q * POS_INV_SCALE; }

export function quantizeVel(mps: number): number {
  const q = Math.round(mps * POS_SCALE);
  return q < -32768 ? -32768 : q > 32767 ? 32767 : q;
}
export function dequantizeVel(q: number): number { return q * POS_INV_SCALE; }

export function quantizeAngle(rad: number): number {
  let a = rad % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return Math.round(a * ANGLE_SCALE) & 0xffff;
}
export function dequantizeAngle(q: number): number { return q * ANGLE_INV_SCALE; }

export function quantizePitch(rad: number): number {
  const q = Math.round(rad * PITCH_SCALE);
  return q < -32767 ? -32767 : q > 32767 ? 32767 : q;
}
export function dequantizePitch(q: number): number { return q * PITCH_INV_SCALE; }

export function quantizeUnit(v: number): number {
  const q = Math.round(v * UNIT_SCALE);
  return q < -32767 ? -32767 : q > 32767 ? 32767 : q;
}
export function dequantizeUnit(q: number): number { return q * UNIT_INV_SCALE; }

export function quantizeHealth(h: number): number {
  const q = Math.round(h);
  return q < 0 ? 0 : q > 255 ? 255 : q;
}

/* ------------------------------------------------------------------------ *
 * Reusable cursors
 * ------------------------------------------------------------------------ */

const textEncoder = /*#__PURE__*/ new TextEncoder();
const textDecoder = /*#__PURE__*/ new TextDecoder('utf-8');
const strScratch = new Uint8Array(1024);

/** Growable little-endian writer. One per connection; call reset() per message. */
export class PacketWriter {
  buffer: ArrayBuffer;
  view: DataView;
  bytes: Uint8Array;
  offset: number;

  constructor(capacity = 8192) {
    this.buffer = new ArrayBuffer(capacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    this.offset = 0;
  }

  reset(): this { this.offset = 0; return this; }

  /** Guarantee `n` more bytes of room. Grows by doubling; existing data is kept. */
  ensure(n: number): void {
    const need = this.offset + n;
    if (need <= this.buffer.byteLength) return;
    let cap = this.buffer.byteLength * 2;
    while (cap < need) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(this.bytes);
    this.buffer = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): void { this.ensure(1); this.view.setUint8(this.offset, v); this.offset += 1; }
  i8(v: number): void { this.ensure(1); this.view.setInt8(this.offset, v); this.offset += 1; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.offset, v, true); this.offset += 2; }
  i16(v: number): void { this.ensure(2); this.view.setInt16(this.offset, v, true); this.offset += 2; }
  u32(v: number): void { this.ensure(4); this.view.setUint32(this.offset, v >>> 0, true); this.offset += 4; }
  i32(v: number): void { this.ensure(4); this.view.setInt32(this.offset, v | 0, true); this.offset += 4; }
  f32(v: number): void { this.ensure(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; }
  f64(v: number): void { this.ensure(8); this.view.setFloat64(this.offset, v, true); this.offset += 8; }

  /** uint8 length prefix + UTF-8 bytes, truncated on a codepoint boundary. */
  str(s: string, maxBytes: number): void {
    const cap = maxBytes > 255 ? 255 : maxBytes;
    const res = textEncoder.encodeInto(s, strScratch);
    let n = res.written === undefined ? 0 : res.written;
    if (n > cap) {
      n = cap;
      while (n > 0 && (strScratch[n] & 0xc0) === 0x80) n--;
    }
    this.ensure(1 + n);
    this.view.setUint8(this.offset, n);
    this.offset += 1;
    this.bytes.set(strScratch.subarray(0, n), this.offset);
    this.offset += n;
  }

  raw(src: Uint8Array, srcOffset: number, length: number): void {
    this.ensure(length);
    this.bytes.set(src.subarray(srcOffset, srcOffset + length), this.offset);
    this.offset += length;
  }

  /** Zero-copy view of what has been written. Only valid until the next write. */
  slice(): Uint8Array { return this.bytes.subarray(0, this.offset); }
  /** Detached copy — use this whenever the buffer may outlive the next write. */
  copy(): Uint8Array { return this.bytes.slice(0, this.offset); }
  /** Detached ArrayBuffer copy, the shape `WebSocket.send` likes best. */
  toArrayBuffer(): ArrayBuffer { return this.buffer.slice(0, this.offset); }
}

/** Little-endian reader over a message. One per connection; call reset() per message. */
export class PacketReader {
  view: DataView;
  bytes: Uint8Array;
  offset: number;
  end: number;

  constructor(data?: ArrayBuffer | Uint8Array | DataView) {
    const empty = new ArrayBuffer(0);
    this.view = new DataView(empty);
    this.bytes = new Uint8Array(empty);
    this.offset = 0;
    this.end = 0;
    if (data) this.reset(data);
  }

  reset(data: ArrayBuffer | Uint8Array | DataView): this {
    if (data instanceof Uint8Array) {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof DataView) {
      this.view = data;
      this.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.view = new DataView(data);
      this.bytes = new Uint8Array(data);
    }
    this.offset = 0;
    this.end = this.view.byteLength;
    return this;
  }

  get remaining(): number { return this.end - this.offset; }

  u8(): number { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  i8(): number { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  i32(): number { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }

  str(): string {
    const n = this.u8();
    const s = n === 0 ? '' : textDecoder.decode(this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return s;
  }

  /** Zero-copy view of `length` bytes; advances the cursor. */
  rawView(length: number): Uint8Array {
    const v = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return v;
  }

  skip(n: number): void { this.offset += n; }
}

/** Peek the message id without constructing a reader. */
export function readMessageId(data: ArrayBuffer | Uint8Array | DataView): number {
  if (data instanceof Uint8Array) return data.length > 0 ? data[0] : 0;
  if (data instanceof DataView) return data.byteLength > 0 ? data.getUint8(0) : 0;
  return data.byteLength > 0 ? new Uint8Array(data, 0, 1)[0] : 0;
}

/* ------------------------------------------------------------------------ *
 * Run-length coding for chunk voxel arrays
 * ------------------------------------------------------------------------ */

/** One run is 3 bytes: u8 blockId, u16 count. */
export const RLE_RUN_BYTES = 3;

/** Upper bound on the encoded size of `voxelCount` voxels. */
export function rleMaxBytes(voxelCount: number): number { return voxelCount * RLE_RUN_BYTES; }

/**
 * Encode `src` into `dst` starting at `dstOffset`. Returns bytes written.
 * `dst` must have at least rleMaxBytes(src.length) bytes of room.
 */
export function rleEncodeInto(src: Uint8Array, dst: Uint8Array, dstOffset: number): number {
  const n = src.length;
  let o = dstOffset;
  let i = 0;
  while (i < n) {
    const id = src[i];
    let run = 1;
    i++;
    while (i < n && src[i] === id && run < 65535) { run++; i++; }
    dst[o] = id;
    dst[o + 1] = run & 0xff;
    dst[o + 2] = (run >>> 8) & 0xff;
    o += 3;
  }
  return o - dstOffset;
}

/** Convenience wrapper that allocates an exactly sized result. Cold path only. */
export function rleEncode(src: Uint8Array): Uint8Array {
  const scratch = new Uint8Array(rleMaxBytes(src.length));
  const n = rleEncodeInto(src, scratch, 0);
  return scratch.slice(0, n);
}

/**
 * Decode `srcLength` bytes of runs starting at `srcOffset` into `dst`.
 * Returns the number of voxels written. Stops early if `dst` fills up.
 */
export function rleDecode(src: Uint8Array, srcOffset: number, srcLength: number, dst: Uint8Array): number {
  const end = srcOffset + srcLength;
  const cap = dst.length;
  let o = 0;
  let i = srcOffset;
  while (i + 2 < end && o < cap) {
    const id = src[i];
    let run = src[i + 1] | (src[i + 2] << 8);
    i += 3;
    if (o + run > cap) run = cap - o;
    if (id === 0) { o += run; continue; }   // dst is expected to arrive zeroed
    dst.fill(id, o, o + run);
    o += run;
  }
  return o;
}

/* ------------------------------------------------------------------------ *
 * C2S messages
 * ------------------------------------------------------------------------ */

export interface HelloMessage {
  protocolVersion: number;
  name: string;
  /** Legacy one-byte appearance. Superseded by `avatar`; still sent. */
  skin: number;
  caps: number;
  /**
   * Packed appearance: four outfit indices and two palette indices in one
   * uint32. The server never interprets it — it clamps it, stores it and mirrors
   * it back out in PF_SPAWN — so the roster can grow without a server change.
   */
  avatar: number;
  /**
   * The `CONTENT_VERSION` this client's bundle carries. `0` means "did not
   * say" — every client older than the patch system, and every tool that
   * builds a HELLO by hand.
   *
   * It is advisory. Content is server truth: the room answers with the version
   * it is actually running in `S2C.SESSION_CONFIG`, and the client adopts it.
   * This field exists so the server can log the spread across a fleet and so a
   * room can refuse a client whose content is too old to render it at all.
   */
  contentVersion: number;
}
export function createHelloMessage(): HelloMessage {
  return { protocolVersion: PROTOCOL_VERSION, name: '', skin: 0, caps: 0, avatar: 0, contentVersion: 0 };
}
export function encodeHello(
  w: PacketWriter, name: string, skin: number, caps: number, avatar = 0, contentVersion = 0,
): PacketWriter {
  w.reset();
  w.u8(C2S.HELLO);
  w.u8(PROTOCOL_VERSION);
  w.str(name, MAX_NAME_LENGTH * 4);
  w.u8(skin & 0xff);
  w.u16(caps & 0xffff);
  w.u32(avatar >>> 0);
  w.u16(contentVersion & 0xffff);
  return w;
}
export function decodeHello(r: PacketReader, out: HelloMessage): HelloMessage {
  r.u8(); // message id
  out.protocolVersion = r.u8();
  out.name = r.str();
  out.skin = r.u8();
  out.caps = r.u16();
  // Trailing fields, each guarded by what is left in the packet. This is THE
  // pattern (docs/INFRASTRUCTURE.md §6 rule 1): a HELLO written by anything
  // that predates the avatar still decodes, it just arrives wearing the default
  // marine and declaring no content version. Append here, never insert.
  out.avatar = r.remaining >= 4 ? r.u32() : 0;
  out.contentVersion = r.remaining >= 2 ? r.u16() : 0;
  return out;
}

/** One tick of player intent. 16 bytes on the wire. */
export interface InputCommand {
  seq: number;
  /** Milliseconds this input covers. */
  dtMs: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /** -1..1 strafe, +1 is right. */
  moveX: number;
  /** -1..1 forward, +1 is forward. */
  moveZ: number;
  /** Hotbar slot 0..8: 0..6 are weapons, 7..8 are build slots. */
  slot: number;
}
export function createInputCommand(): InputCommand {
  return { seq: 0, dtMs: 0, yaw: 0, pitch: 0, buttons: 0, moveX: 0, moveZ: 0, slot: 0 };
}
export function encodeInput(
  w: PacketWriter, seq: number, dtMs: number, yaw: number, pitch: number,
  buttons: number, moveX: number, moveZ: number, slot: number,
): PacketWriter {
  w.reset();
  w.u8(C2S.INPUT);
  w.u32(seq);
  w.u16(dtMs < 0 ? 0 : dtMs > 65535 ? 65535 : Math.round(dtMs));
  w.u16(quantizeAngle(yaw));
  w.i16(quantizePitch(pitch));
  w.u16(buttons & 0xffff);
  w.i8(Math.round(moveX * 127));
  w.i8(Math.round(moveZ * 127));
  w.u8(slot & 0xff);
  return w;
}
export function encodeInputCommand(w: PacketWriter, c: InputCommand): PacketWriter {
  return encodeInput(w, c.seq, c.dtMs, c.yaw, c.pitch, c.buttons, c.moveX, c.moveZ, c.slot);
}
export function decodeInput(r: PacketReader, out: InputCommand): InputCommand {
  r.u8();
  out.seq = r.u32();
  out.dtMs = r.u16();
  out.yaw = dequantizeAngle(r.u16());
  out.pitch = dequantizePitch(r.i16());
  out.buttons = r.u16();
  out.moveX = r.i8() / 127;
  out.moveZ = r.i8() / 127;
  out.slot = r.u8();
  return out;
}

export interface BlockEditCommand {
  seq: number;
  action: BlockAction;
  x: number;
  y: number;
  z: number;
  blockId: number;
}
export function createBlockEditCommand(): BlockEditCommand {
  return { seq: 0, action: BlockAction.BREAK, x: 0, y: 0, z: 0, blockId: 0 };
}
export function encodeBlockEdit(
  w: PacketWriter, seq: number, action: number, x: number, y: number, z: number, blockId: number,
): PacketWriter {
  w.reset();
  w.u8(C2S.BLOCK_EDIT);
  w.u8(action & 0xff);
  w.u8(blockId & 0xff);
  w.u8(y & 0xff);
  w.i16(x);
  w.i16(z);
  w.u32(seq);
  return w;
}
export function decodeBlockEdit(r: PacketReader, out: BlockEditCommand): BlockEditCommand {
  r.u8();
  out.action = r.u8();
  out.blockId = r.u8();
  out.y = r.u8();
  out.x = r.i16();
  out.z = r.i16();
  out.seq = r.u32();
  return out;
}

export function encodeChatC2S(w: PacketWriter, text: string): PacketWriter {
  w.reset();
  w.u8(C2S.CHAT);
  w.str(text, MAX_CHAT_LENGTH);
  return w;
}
export function decodeChatC2S(r: PacketReader): string {
  r.u8();
  return r.str();
}

/** 6 bytes: the whole appearance, and the only message that ever carries it. */
export function encodeAppearance(w: PacketWriter, skin: number, avatar: number): PacketWriter {
  w.reset();
  w.u8(C2S.APPEARANCE);
  w.u8(skin & 0xff);
  w.u32(avatar >>> 0);
  return w;
}
export interface AppearanceMessage { skin: number; avatar: number; }
export function createAppearanceMessage(): AppearanceMessage { return { skin: 0, avatar: 0 }; }
export function decodeAppearance(r: PacketReader, out: AppearanceMessage): AppearanceMessage {
  r.u8();
  out.skin = r.u8();
  out.avatar = r.u32();
  return out;
}

export function encodeRespawn(w: PacketWriter): PacketWriter {
  w.reset();
  w.u8(C2S.RESPAWN);
  return w;
}

export function encodePing(w: PacketWriter, clientTimeMs: number): PacketWriter {
  w.reset();
  w.u8(C2S.PING);
  w.u32(clientTimeMs >>> 0);
  return w;
}
export function decodePing(r: PacketReader): number {
  r.u8();
  return r.u32();
}

/* ------------------------------------------------------------------------ *
 * S2C messages
 * ------------------------------------------------------------------------ */

export interface WelcomeMessage {
  protocolVersion: number;
  playerId: number;
  seed: number;
  tickRate: number;
  worldRadiusChunks: number;
  chunkSize: number;
  chunkHeight: number;
  maxPlayers: number;
  gameMode: number;
  serverTimeMs: number;
  /** Total chunks the server intends to stream, so the loader can show progress. */
  chunkCount: number;
}
export function createWelcomeMessage(): WelcomeMessage {
  return {
    protocolVersion: PROTOCOL_VERSION, playerId: 0, seed: 0, tickRate: 0,
    worldRadiusChunks: 0, chunkSize: 0, chunkHeight: 0, maxPlayers: 0,
    gameMode: 0, serverTimeMs: 0, chunkCount: 0,
  };
}
export function encodeWelcome(
  w: PacketWriter, playerId: number, seed: number, tickRate: number,
  worldRadiusChunks: number, chunkSize: number, chunkHeight: number,
  maxPlayers: number, gameMode: number, serverTimeMs: number, chunkCount: number,
): PacketWriter {
  w.reset();
  w.u8(S2C.WELCOME);
  w.u8(PROTOCOL_VERSION);
  w.u16(playerId);
  w.u32(seed);
  w.u8(tickRate);
  w.u8(worldRadiusChunks);
  w.u8(chunkSize);
  w.u8(chunkHeight);
  w.u8(maxPlayers);
  w.u8(gameMode);
  w.u32(serverTimeMs >>> 0);
  w.u16(chunkCount);
  return w;
}
export function decodeWelcome(r: PacketReader, out: WelcomeMessage): WelcomeMessage {
  r.u8();
  out.protocolVersion = r.u8();
  out.playerId = r.u16();
  out.seed = r.u32();
  out.tickRate = r.u8();
  out.worldRadiusChunks = r.u8();
  out.chunkSize = r.u8();
  out.chunkHeight = r.u8();
  out.maxPlayers = r.u8();
  out.gameMode = r.u8();
  out.serverTimeMs = r.u32();
  out.chunkCount = r.u16();
  return out;
}

/* ------------------------------------------------------------------------ *
 * Patch-system messages
 *
 * Both are additive and neither moved a byte of anything that existed, so
 * neither cost a `PROTOCOL_VERSION` bump. That is the point of the exercise:
 * a bump strands tabs, so the protocol is designed so that most changes do not
 * need one. See docs/PATCHING.md for the rule and its four escape hatches.
 * ------------------------------------------------------------------------ */

/** How much of a rejection detail string ever reaches the wire. */
export const MAX_UPDATE_DETAIL_LENGTH = 96;
/** How much of a build id ever reaches the wire. */
export const MAX_BUILD_ID_BYTES = 32;

export interface UpdateRequiredMessage {
  /** `UpdateReason` from shared/src/version.ts. */
  reason: number;
  /** The protocol this host speaks, and the oldest it accepts. */
  serverProtocol: number;
  serverMinProtocol: number;
  /** The content this host is on, for a client deciding what to refetch. */
  contentVersion: number;
  /** Short, human, safe to show. Never trusted as markup. */
  detail: string;
}
export function createUpdateRequiredMessage(): UpdateRequiredMessage {
  return { reason: 0, serverProtocol: 0, serverMinProtocol: 0, contentVersion: 0, detail: '' };
}
export function encodeUpdateRequired(
  w: PacketWriter, reason: number, serverProtocol: number, serverMinProtocol: number,
  contentVersion: number, detail: string,
): PacketWriter {
  w.reset();
  w.u8(S2C.UPDATE_REQUIRED);
  w.u8(reason & 0xff);
  w.u8(serverProtocol & 0xff);
  w.u8(serverMinProtocol & 0xff);
  w.u16(contentVersion & 0xffff);
  w.str(detail, MAX_UPDATE_DETAIL_LENGTH);
  return w;
}
export function decodeUpdateRequired(r: PacketReader, out: UpdateRequiredMessage): UpdateRequiredMessage {
  r.u8();
  out.reason = r.u8();
  out.serverProtocol = r.u8();
  out.serverMinProtocol = r.u8();
  out.contentVersion = r.u16();
  out.detail = r.str();
  return out;
}

export interface SessionConfigMessage {
  serverProtocol: number;
  serverMinProtocol: number;
  /** The content version THIS ROOM is running, pinned at its construction. */
  contentVersion: number;
  /** Hash of the exact tables plus levels the room loaded. */
  contentHash: number;
  /**
   * Feature flags, resolved server-side for this player. Bit i is the flag at
   * index i of `FLAG_ORDER` in shared/src/flags.ts.
   *
   * When a 33rd flag is needed, append a second `u32` guarded by
   * `r.remaining >= 4` — do not widen this one.
   */
  flags: number;
  /** Telemetry only. Never branch on it. */
  buildId: string;
}
export function createSessionConfigMessage(): SessionConfigMessage {
  return {
    serverProtocol: 0, serverMinProtocol: 0, contentVersion: 0,
    contentHash: 0, flags: 0, buildId: '',
  };
}
export function encodeSessionConfig(
  w: PacketWriter, serverProtocol: number, serverMinProtocol: number,
  contentVersion: number, contentHash: number, flags: number, buildId: string,
): PacketWriter {
  w.reset();
  w.u8(S2C.SESSION_CONFIG);
  w.u8(serverProtocol & 0xff);
  w.u8(serverMinProtocol & 0xff);
  w.u16(contentVersion & 0xffff);
  w.u32(contentHash >>> 0);
  w.u32(flags >>> 0);
  w.str(buildId, MAX_BUILD_ID_BYTES);
  return w;
}
export function decodeSessionConfig(r: PacketReader, out: SessionConfigMessage): SessionConfigMessage {
  r.u8();
  out.serverProtocol = r.u8();
  out.serverMinProtocol = r.u8();
  out.contentVersion = r.u16();
  out.contentHash = r.u32();
  out.flags = r.u32();
  out.buildId = r.str();
  return out;
}

/**
 * What one round paid, and what the profile holds now.
 *
 * `xp`/`scrap` are the DELTA this round produced *after* every server-side
 * reduction; `totalXp`/`totalScrap` are the balances the server just wrote. The
 * client renders both and computes neither — `docs/ECONOMY.md` decision 1.
 *
 * `code` is the entitlement guard's `RejectCode`, 0 = accepted. It rides along
 * so a client can eventually say WHY a match paid nothing ("this room is
 * private") instead of showing a silent zero. Nothing branches on it yet.
 */
export interface MatchAwardMessage {
  xp: number;
  scrap: number;
  totalXp: number;
  totalScrap: number;
  code: number;
}
export function createMatchAwardMessage(): MatchAwardMessage {
  return { xp: 0, scrap: 0, totalXp: 0, totalScrap: 0, code: 0 };
}
/**
 * Clamped rather than masked. `x & 0xffff` turns 70 000 into 4 464, which is a
 * plausible-looking lie about money; `Math.min` turns it into the ceiling,
 * which is visibly wrong and therefore reportable.
 */
export function encodeMatchAward(
  w: PacketWriter, xp: number, scrap: number,
  totalXp: number, totalScrap: number, code: number,
): PacketWriter {
  w.reset();
  w.u8(S2C.MATCH_AWARD);
  w.u16(clampU(xp, 0xffff));
  w.u16(clampU(scrap, 0xffff));
  w.u32(clampU(totalXp, 0xffffffff));
  w.u32(clampU(totalScrap, 0xffffffff));
  w.u8(clampU(code, 0xff));
  return w;
}
export function decodeMatchAward(r: PacketReader, out: MatchAwardMessage): MatchAwardMessage {
  r.u8();
  out.xp = r.u16();
  out.scrap = r.u16();
  out.totalXp = r.u32();
  out.totalScrap = r.u32();
  out.code = r.u8();
  return out;
}

function clampU(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.round(v);
  return n < 0 ? 0 : n > max ? max : n;
}

export interface ChunkMessage {
  cx: number;
  cz: number;
  /** Always CHUNK_VOLUME long, in voxelIndex() order. Reused across messages. */
  voxels: Uint8Array;
}
export function createChunkMessage(): ChunkMessage {
  return { cx: 0, cz: 0, voxels: new Uint8Array(CHUNK_VOLUME) };
}
export function encodeChunk(w: PacketWriter, cx: number, cz: number, voxels: Uint8Array): PacketWriter {
  w.reset();
  w.u8(S2C.CHUNK);
  w.i16(cx);
  w.i16(cz);
  const lenOffset = w.offset;
  w.u32(0);
  w.ensure(rleMaxBytes(voxels.length));
  const written = rleEncodeInto(voxels, w.bytes, w.offset);
  w.offset += written;
  w.view.setUint32(lenOffset, written, true);
  return w;
}
export function decodeChunk(r: PacketReader, out: ChunkMessage): ChunkMessage {
  r.u8();
  out.cx = r.i16();
  out.cz = r.i16();
  const len = r.u32();
  out.voxels.fill(0);
  rleDecode(r.bytes, r.offset, len, out.voxels);
  r.offset += len;
  return out;
}

/**
 * Header size of both CHUNK and CHUNK_Z: id + cx + cz + length. CHUNK_Z carries
 * one extra uint32 (the inflated length) so the receiver can hand `rleDecode` a
 * length without trusting the inflate to have produced one.
 */
export const CHUNK_HEADER_BYTES = 9;
export const CHUNK_Z_HEADER_BYTES = 13;

/**
 * The compressed twin of `encodeChunk`. `z` is the raw-deflate of exactly the
 * `rleLen` bytes `rleEncodeInto` would have written — so a receiver inflates,
 * then runs the *same* `rleDecode` the uncompressed path runs. Splitting it
 * this way is what lets the server cache the finished packet: the deflate is
 * per chunk, not per client.
 */
export function encodeChunkZ(
  w: PacketWriter, cx: number, cz: number, rleLen: number, z: Uint8Array,
): PacketWriter {
  w.reset();
  w.u8(S2C.CHUNK_Z);
  w.i16(cx);
  w.i16(cz);
  w.u32(rleLen >>> 0);
  w.u32(z.length >>> 0);
  w.raw(z, 0, z.length);
  return w;
}

export interface ChunkZHeader {
  cx: number;
  cz: number;
  /** Byte length of the RLE stream once inflated. */
  rleLen: number;
  /** Byte length of the deflate stream that follows the header. */
  zLen: number;
}
export function createChunkZHeader(): ChunkZHeader {
  return { cx: 0, cz: 0, rleLen: 0, zLen: 0 };
}
/** Reads the header and leaves `r.offset` on the first deflate byte. */
export function decodeChunkZHeader(r: PacketReader, out: ChunkZHeader): ChunkZHeader {
  r.u8();
  out.cx = r.i16();
  out.cz = r.i16();
  out.rleLen = r.u32();
  out.zLen = r.u32();
  return out;
}

export interface BlockDelta {
  x: number; y: number; z: number; id: number;
}
/** Batched authoritative world edits. */
export class BlockDeltaBuffer {
  count = 0;
  /** Last block-edit seq from this client the server has applied. */
  ackEditSeq = 0;
  readonly x: Int16Array;
  readonly y: Uint8Array;
  readonly z: Int16Array;
  readonly id: Uint8Array;
  readonly capacity: number;

  constructor(capacity: number = MAX_BLOCK_DELTAS_PER_MESSAGE) {
    this.capacity = capacity;
    this.x = new Int16Array(capacity);
    this.y = new Uint8Array(capacity);
    this.z = new Int16Array(capacity);
    this.id = new Uint8Array(capacity);
  }
  reset(): void { this.count = 0; }
  /** Returns false when full. */
  push(x: number, y: number, z: number, id: number): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.id[i] = id;
    return true;
  }
}
export function encodeBlockDeltas(w: PacketWriter, b: BlockDeltaBuffer): PacketWriter {
  w.reset();
  w.u8(S2C.BLOCK_DELTA);
  w.u32(b.ackEditSeq >>> 0);
  w.u16(b.count);
  for (let i = 0; i < b.count; i++) {
    w.i16(b.x[i]);
    w.u8(b.y[i]);
    w.i16(b.z[i]);
    w.u8(b.id[i]);
  }
  return w;
}
export function decodeBlockDeltas(r: PacketReader, out: BlockDeltaBuffer): BlockDeltaBuffer {
  r.u8();
  out.ackEditSeq = r.u32();
  const n = r.u16();
  out.count = 0;
  for (let i = 0; i < n; i++) {
    const x = r.i16();
    const y = r.u8();
    const z = r.i16();
    const id = r.u8();
    out.push(x, y, z, id);
  }
  return out;
}

export interface DamageEvent {
  attackerId: number;
  victimId: number;
  amount: number;
  weaponId: number;
  flags: number;
  /** Unit direction from attacker to victim — drives the directional hurt indicator. */
  dirX: number; dirY: number; dirZ: number;
  healthAfter: number;
  armorAfter: number;
}
export function createDamageEvent(): DamageEvent {
  return { attackerId: 0, victimId: 0, amount: 0, weaponId: 0, flags: 0, dirX: 0, dirY: 0, dirZ: 0, healthAfter: 0, armorAfter: 0 };
}
export function encodeDamage(
  w: PacketWriter, attackerId: number, victimId: number, amount: number, weaponId: number,
  flags: number, dirX: number, dirY: number, dirZ: number, healthAfter: number, armorAfter: number,
): PacketWriter {
  w.reset();
  w.u8(S2C.DAMAGE);
  w.u16(attackerId);
  w.u16(victimId);
  w.u8(amount < 0 ? 0 : amount > 255 ? 255 : Math.round(amount));
  w.u8(weaponId & 0xff);
  w.u8(flags & 0xff);
  w.i16(quantizeUnit(dirX));
  w.i16(quantizeUnit(dirY));
  w.i16(quantizeUnit(dirZ));
  w.u8(quantizeHealth(healthAfter));
  w.u8(quantizeHealth(armorAfter));
  return w;
}
export function decodeDamage(r: PacketReader, out: DamageEvent): DamageEvent {
  r.u8();
  out.attackerId = r.u16();
  out.victimId = r.u16();
  out.amount = r.u8();
  out.weaponId = r.u8();
  out.flags = r.u8();
  out.dirX = dequantizeUnit(r.i16());
  out.dirY = dequantizeUnit(r.i16());
  out.dirZ = dequantizeUnit(r.i16());
  out.healthAfter = r.u8();
  out.armorAfter = r.u8();
  return out;
}

export interface KillEvent {
  killerId: number;
  victimId: number;
  weaponId: number;
  flags: number;
  /** The killer's streak after this kill. */
  killerStreak: number;
}
export function createKillEvent(): KillEvent {
  return { killerId: 0, victimId: 0, weaponId: 0, flags: 0, killerStreak: 0 };
}
export function encodeKill(
  w: PacketWriter, killerId: number, victimId: number, weaponId: number, flags: number, killerStreak: number,
): PacketWriter {
  w.reset();
  w.u8(S2C.KILL);
  w.u16(killerId);
  w.u16(victimId);
  w.u8(weaponId & 0xff);
  w.u8(flags & 0xff);
  w.u8(killerStreak > 255 ? 255 : killerStreak);
  return w;
}
export function decodeKill(r: PacketReader, out: KillEvent): KillEvent {
  r.u8();
  out.killerId = r.u16();
  out.victimId = r.u16();
  out.weaponId = r.u8();
  out.flags = r.u8();
  out.killerStreak = r.u8();
  return out;
}

export interface ChatMessage {
  senderId: number;
  channel: ChatChannel;
  text: string;
}
export function createChatMessage(): ChatMessage {
  return { senderId: 0, channel: ChatChannel.ALL, text: '' };
}
export function encodeChatS2C(w: PacketWriter, senderId: number, channel: number, text: string): PacketWriter {
  w.reset();
  w.u8(S2C.CHAT);
  w.u16(senderId);
  w.u8(channel & 0xff);
  w.str(text, MAX_CHAT_LENGTH * 2);
  return w;
}
export function decodeChatS2C(r: PacketReader, out: ChatMessage): ChatMessage {
  r.u8();
  out.senderId = r.u16();
  out.channel = r.u8();
  out.text = r.str();
  return out;
}

export interface PongMessage {
  clientTimeMs: number;
  serverTimeMs: number;
  tick: number;
}
export function createPongMessage(): PongMessage {
  return { clientTimeMs: 0, serverTimeMs: 0, tick: 0 };
}
export function encodePong(w: PacketWriter, clientTimeMs: number, serverTimeMs: number, tick: number): PacketWriter {
  w.reset();
  w.u8(S2C.PONG);
  w.u32(clientTimeMs >>> 0);
  w.u32(serverTimeMs >>> 0);
  w.u32(tick >>> 0);
  return w;
}
export function decodePong(r: PacketReader, out: PongMessage): PongMessage {
  r.u8();
  out.clientTimeMs = r.u32();
  out.serverTimeMs = r.u32();
  out.tick = r.u32();
  return out;
}

/* ------------------------------------------------------------------------ *
 * Snapshots
 * ------------------------------------------------------------------------ */

/**
 * Struct-of-arrays snapshot. The server fills one per outgoing snapshot and
 * keeps one per client as the delta baseline; the client decodes into one and
 * applies it to its interpolation buffers. Nothing here allocates after
 * construction.
 */
export class SnapshotBuffer {
  tick = 0;
  /** 0 means this snapshot is absolute. */
  baselineTick = 0;
  /** Last input seq from the receiving client that the server simulated. */
  ackInputSeq = 0;
  /** Last block-edit seq from the receiving client that the server applied. */
  ackEditSeq = 0;
  flags = 0;
  /** Entity id of the receiving client. */
  localId = 0;

  playerCount = 0;
  readonly playerId: Uint16Array;
  readonly playerMask: Uint16Array;
  readonly playerX: Float32Array;
  readonly playerY: Float32Array;
  readonly playerZ: Float32Array;
  readonly playerVX: Float32Array;
  readonly playerVY: Float32Array;
  readonly playerVZ: Float32Array;
  readonly playerYaw: Float32Array;
  readonly playerPitch: Float32Array;
  readonly playerHealth: Uint8Array;
  readonly playerArmor: Uint8Array;
  readonly playerWeapon: Uint8Array;
  readonly playerState: Uint8Array;
  readonly playerMag: Uint16Array;
  readonly playerReserve: Uint16Array;
  readonly playerKills: Uint16Array;
  readonly playerDeaths: Uint16Array;
  readonly playerTeam: Uint8Array;
  readonly playerSkin: Uint8Array;
  /** Packed avatar, sent once per player with PF_SPAWN. 4 bytes, not a blob. */
  readonly playerAvatar: Uint32Array;
  readonly playerName: string[];

  entityCount = 0;
  readonly entityId: Uint16Array;
  readonly entityMask: Uint16Array;
  readonly entityType: Uint8Array;
  readonly entityVariant: Uint8Array;
  readonly entityX: Float32Array;
  readonly entityY: Float32Array;
  readonly entityZ: Float32Array;
  readonly entityVX: Float32Array;
  readonly entityVY: Float32Array;
  readonly entityVZ: Float32Array;
  readonly entityYaw: Float32Array;
  readonly entityHealth: Uint16Array;
  readonly entityState: Uint8Array;
  readonly entityReason: Uint8Array;

  projectileCount = 0;
  readonly projId: Uint16Array;
  readonly projMask: Uint16Array;
  readonly projWeapon: Uint8Array;
  readonly projOwner: Uint16Array;
  readonly projX: Float32Array;
  readonly projY: Float32Array;
  readonly projZ: Float32Array;
  readonly projVX: Float32Array;
  readonly projVY: Float32Array;
  readonly projVZ: Float32Array;
  readonly projReason: Uint8Array;

  readonly maxPlayers: number;
  readonly maxEntities: number;
  readonly maxProjectiles: number;

  constructor(maxPlayers = MAX_PLAYERS, maxEntities = MAX_ENTITIES, maxProjectiles = MAX_PROJECTILES) {
    this.maxPlayers = maxPlayers;
    this.maxEntities = maxEntities;
    this.maxProjectiles = maxProjectiles;

    this.playerId = new Uint16Array(maxPlayers);
    this.playerMask = new Uint16Array(maxPlayers);
    this.playerX = new Float32Array(maxPlayers);
    this.playerY = new Float32Array(maxPlayers);
    this.playerZ = new Float32Array(maxPlayers);
    this.playerVX = new Float32Array(maxPlayers);
    this.playerVY = new Float32Array(maxPlayers);
    this.playerVZ = new Float32Array(maxPlayers);
    this.playerYaw = new Float32Array(maxPlayers);
    this.playerPitch = new Float32Array(maxPlayers);
    this.playerHealth = new Uint8Array(maxPlayers);
    this.playerArmor = new Uint8Array(maxPlayers);
    this.playerWeapon = new Uint8Array(maxPlayers);
    this.playerState = new Uint8Array(maxPlayers);
    this.playerMag = new Uint16Array(maxPlayers);
    this.playerReserve = new Uint16Array(maxPlayers);
    this.playerKills = new Uint16Array(maxPlayers);
    this.playerDeaths = new Uint16Array(maxPlayers);
    this.playerTeam = new Uint8Array(maxPlayers);
    this.playerSkin = new Uint8Array(maxPlayers);
    this.playerAvatar = new Uint32Array(maxPlayers);
    this.playerName = new Array<string>(maxPlayers).fill('');

    this.entityId = new Uint16Array(maxEntities);
    this.entityMask = new Uint16Array(maxEntities);
    this.entityType = new Uint8Array(maxEntities);
    this.entityVariant = new Uint8Array(maxEntities);
    this.entityX = new Float32Array(maxEntities);
    this.entityY = new Float32Array(maxEntities);
    this.entityZ = new Float32Array(maxEntities);
    this.entityVX = new Float32Array(maxEntities);
    this.entityVY = new Float32Array(maxEntities);
    this.entityVZ = new Float32Array(maxEntities);
    this.entityYaw = new Float32Array(maxEntities);
    this.entityHealth = new Uint16Array(maxEntities);
    this.entityState = new Uint8Array(maxEntities);
    this.entityReason = new Uint8Array(maxEntities);

    this.projId = new Uint16Array(maxProjectiles);
    this.projMask = new Uint16Array(maxProjectiles);
    this.projWeapon = new Uint8Array(maxProjectiles);
    this.projOwner = new Uint16Array(maxProjectiles);
    this.projX = new Float32Array(maxProjectiles);
    this.projY = new Float32Array(maxProjectiles);
    this.projZ = new Float32Array(maxProjectiles);
    this.projVX = new Float32Array(maxProjectiles);
    this.projVY = new Float32Array(maxProjectiles);
    this.projVZ = new Float32Array(maxProjectiles);
    this.projReason = new Uint8Array(maxProjectiles);
  }

  /** Clear the record counts. Backing arrays keep their contents. */
  reset(): void {
    this.playerCount = 0;
    this.entityCount = 0;
    this.projectileCount = 0;
    this.flags = 0;
  }

  /** Slot index of `id`, or -1. */
  indexOfPlayer(id: number): number {
    const n = this.playerCount;
    for (let i = 0; i < n; i++) if (this.playerId[i] === id) return i;
    return -1;
  }
  indexOfEntity(id: number): number {
    const n = this.entityCount;
    for (let i = 0; i < n; i++) if (this.entityId[i] === id) return i;
    return -1;
  }
  indexOfProjectile(id: number): number {
    const n = this.projectileCount;
    for (let i = 0; i < n; i++) if (this.projId[i] === id) return i;
    return -1;
  }

  /** Append an empty player record. Returns its slot index, or -1 when full. */
  addPlayer(id: number): number {
    if (this.playerCount >= this.maxPlayers) return -1;
    const i = this.playerCount++;
    this.playerId[i] = id;
    this.playerMask[i] = 0;
    return i;
  }
  addEntity(id: number): number {
    if (this.entityCount >= this.maxEntities) return -1;
    const i = this.entityCount++;
    this.entityId[i] = id;
    this.entityMask[i] = 0;
    return i;
  }
  addProjectile(id: number): number {
    if (this.projectileCount >= this.maxProjectiles) return -1;
    const i = this.projectileCount++;
    this.projId[i] = id;
    this.projMask[i] = 0;
    return i;
  }
}

/**
 * Fields of player slot `ni` in `next` that differ, after quantisation, from
 * slot `bi` in `base`. PF_SPAWN, PF_REMOVED, PF_LOCAL and PF_AMMO are policy
 * bits the caller ORs in; everything else is decided here so that the encoder
 * and the baseline never disagree about what "changed" means.
 */
export function playerDeltaMask(base: SnapshotBuffer, bi: number, next: SnapshotBuffer, ni: number): number {
  let mask = 0;
  if (quantizePos(base.playerX[bi]) !== quantizePos(next.playerX[ni]) ||
      quantizePos(base.playerY[bi]) !== quantizePos(next.playerY[ni]) ||
      quantizePos(base.playerZ[bi]) !== quantizePos(next.playerZ[ni])) mask |= PF_POS;
  if (quantizeAngle(base.playerYaw[bi]) !== quantizeAngle(next.playerYaw[ni])) mask |= PF_YAW;
  if (quantizePitch(base.playerPitch[bi]) !== quantizePitch(next.playerPitch[ni])) mask |= PF_PITCH;
  if (quantizeVel(base.playerVX[bi]) !== quantizeVel(next.playerVX[ni]) ||
      quantizeVel(base.playerVY[bi]) !== quantizeVel(next.playerVY[ni]) ||
      quantizeVel(base.playerVZ[bi]) !== quantizeVel(next.playerVZ[ni])) mask |= PF_VEL;
  if (base.playerHealth[bi] !== next.playerHealth[ni]) mask |= PF_HEALTH;
  if (base.playerArmor[bi] !== next.playerArmor[ni]) mask |= PF_ARMOR;
  if (base.playerWeapon[bi] !== next.playerWeapon[ni]) mask |= PF_WEAPON;
  if (base.playerState[bi] !== next.playerState[ni]) mask |= PF_STATE;
  if (base.playerMag[bi] !== next.playerMag[ni] || base.playerReserve[bi] !== next.playerReserve[ni]) mask |= PF_AMMO;
  if (base.playerKills[bi] !== next.playerKills[ni] || base.playerDeaths[bi] !== next.playerDeaths[ni]) mask |= PF_SCORE;
  if (base.playerTeam[bi] !== next.playerTeam[ni]) mask |= PF_TEAM;
  if (base.playerAvatar[bi] !== next.playerAvatar[ni]) mask |= PF_AVATAR;
  return mask;
}

/** Every field bit a full (baseline-free) player record must carry. */
export const PF_ALL = PF_POS | PF_YAW | PF_PITCH | PF_VEL | PF_HEALTH | PF_ARMOR |
  PF_WEAPON | PF_STATE | PF_SCORE | PF_TEAM | PF_AVATAR;
export const EF_ALL = EF_POS | EF_YAW | EF_HEALTH | EF_STATE | EF_VEL;
export const RF_ALL = RF_POS | RF_VEL;

/** Copy one player record between snapshot buffers (used to roll the baseline forward). */
export function copyPlayerRecord(src: SnapshotBuffer, si: number, dst: SnapshotBuffer, di: number): void {
  dst.playerId[di] = src.playerId[si];
  dst.playerX[di] = src.playerX[si];
  dst.playerY[di] = src.playerY[si];
  dst.playerZ[di] = src.playerZ[si];
  dst.playerVX[di] = src.playerVX[si];
  dst.playerVY[di] = src.playerVY[si];
  dst.playerVZ[di] = src.playerVZ[si];
  dst.playerYaw[di] = src.playerYaw[si];
  dst.playerPitch[di] = src.playerPitch[si];
  dst.playerHealth[di] = src.playerHealth[si];
  dst.playerArmor[di] = src.playerArmor[si];
  dst.playerWeapon[di] = src.playerWeapon[si];
  dst.playerState[di] = src.playerState[si];
  dst.playerMag[di] = src.playerMag[si];
  dst.playerReserve[di] = src.playerReserve[si];
  dst.playerKills[di] = src.playerKills[si];
  dst.playerDeaths[di] = src.playerDeaths[si];
  dst.playerTeam[di] = src.playerTeam[si];
  dst.playerSkin[di] = src.playerSkin[si];
  dst.playerAvatar[di] = src.playerAvatar[si];
  dst.playerName[di] = src.playerName[si];
}

export function encodeSnapshot(w: PacketWriter, s: SnapshotBuffer): PacketWriter {
  w.reset();
  w.u8(S2C.SNAPSHOT);
  w.u32(s.tick >>> 0);
  w.u32(s.baselineTick >>> 0);
  w.u32(s.ackInputSeq >>> 0);
  w.u32(s.ackEditSeq >>> 0);
  w.u16(s.localId);
  w.u8(s.flags & 0xff);

  w.u8(s.playerCount);
  for (let i = 0; i < s.playerCount; i++) {
    const m = s.playerMask[i];
    w.u16(s.playerId[i]);
    w.u16(m);
    if (m & PF_SPAWN) {
      w.str(s.playerName[i], MAX_NAME_LENGTH * 4);
      w.u8(s.playerSkin[i]);
    }
    if (m & PF_POS) {
      w.i16(quantizePos(s.playerX[i]));
      w.i16(quantizePos(s.playerY[i]));
      w.i16(quantizePos(s.playerZ[i]));
    }
    if (m & PF_YAW) w.u16(quantizeAngle(s.playerYaw[i]));
    if (m & PF_PITCH) w.i16(quantizePitch(s.playerPitch[i]));
    if (m & PF_VEL) {
      w.i16(quantizeVel(s.playerVX[i]));
      w.i16(quantizeVel(s.playerVY[i]));
      w.i16(quantizeVel(s.playerVZ[i]));
    }
    if (m & PF_HEALTH) w.u8(s.playerHealth[i]);
    if (m & PF_ARMOR) w.u8(s.playerArmor[i]);
    if (m & PF_WEAPON) w.u8(s.playerWeapon[i]);
    if (m & PF_STATE) w.u8(s.playerState[i]);
    if (m & PF_AMMO) { w.u16(s.playerMag[i]); w.u16(s.playerReserve[i]); }
    if (m & PF_SCORE) { w.u16(s.playerKills[i]); w.u16(s.playerDeaths[i]); }
    if (m & PF_TEAM) w.u8(s.playerTeam[i]);
    if (m & PF_AVATAR) w.u32(s.playerAvatar[i]);
  }

  w.u16(s.entityCount);
  for (let i = 0; i < s.entityCount; i++) {
    const m = s.entityMask[i];
    w.u16(s.entityId[i]);
    w.u16(m);
    if (m & EF_SPAWN) { w.u8(s.entityType[i]); w.u8(s.entityVariant[i]); }
    if (m & EF_REMOVED) w.u8(s.entityReason[i]);
    if (m & EF_POS) {
      w.i16(quantizePos(s.entityX[i]));
      w.i16(quantizePos(s.entityY[i]));
      w.i16(quantizePos(s.entityZ[i]));
    }
    if (m & EF_YAW) w.u16(quantizeAngle(s.entityYaw[i]));
    if (m & EF_HEALTH) w.u16(s.entityHealth[i]);
    if (m & EF_STATE) w.u8(s.entityState[i]);
    if (m & EF_VEL) {
      w.i16(quantizeVel(s.entityVX[i]));
      w.i16(quantizeVel(s.entityVY[i]));
      w.i16(quantizeVel(s.entityVZ[i]));
    }
  }

  w.u16(s.projectileCount);
  for (let i = 0; i < s.projectileCount; i++) {
    const m = s.projMask[i];
    w.u16(s.projId[i]);
    w.u16(m);
    if (m & RF_SPAWN) { w.u8(s.projWeapon[i]); w.u16(s.projOwner[i]); }
    if (m & RF_REMOVED) w.u8(s.projReason[i]);
    if (m & RF_POS) {
      w.i16(quantizePos(s.projX[i]));
      w.i16(quantizePos(s.projY[i]));
      w.i16(quantizePos(s.projZ[i]));
    }
    if (m & RF_VEL) {
      w.i16(quantizeVel(s.projVX[i]));
      w.i16(quantizeVel(s.projVY[i]));
      w.i16(quantizeVel(s.projVZ[i]));
    }
  }
  return w;
}

/**
 * Decode into `out`. Only the fields whose mask bit is set were transmitted;
 * every other field in that record keeps whatever value the buffer already held,
 * so `out` must be the same buffer the caller applies to its baseline.
 */
export function decodeSnapshot(r: PacketReader, out: SnapshotBuffer): SnapshotBuffer {
  r.u8();
  out.tick = r.u32();
  out.baselineTick = r.u32();
  out.ackInputSeq = r.u32();
  out.ackEditSeq = r.u32();
  out.localId = r.u16();
  out.flags = r.u8();

  const pc = r.u8();
  out.playerCount = pc > out.maxPlayers ? out.maxPlayers : pc;
  for (let i = 0; i < pc; i++) {
    const id = r.u16();
    const m = r.u16();
    const k = i < out.maxPlayers ? i : out.maxPlayers - 1;
    out.playerId[k] = id;
    out.playerMask[k] = m;
    if (m & PF_SPAWN) {
      out.playerName[k] = r.str();
      out.playerSkin[k] = r.u8();
    }
    if (m & PF_POS) {
      out.playerX[k] = dequantizePos(r.i16());
      out.playerY[k] = dequantizePos(r.i16());
      out.playerZ[k] = dequantizePos(r.i16());
    }
    if (m & PF_YAW) out.playerYaw[k] = dequantizeAngle(r.u16());
    if (m & PF_PITCH) out.playerPitch[k] = dequantizePitch(r.i16());
    if (m & PF_VEL) {
      out.playerVX[k] = dequantizeVel(r.i16());
      out.playerVY[k] = dequantizeVel(r.i16());
      out.playerVZ[k] = dequantizeVel(r.i16());
    }
    if (m & PF_HEALTH) out.playerHealth[k] = r.u8();
    if (m & PF_ARMOR) out.playerArmor[k] = r.u8();
    if (m & PF_WEAPON) out.playerWeapon[k] = r.u8();
    if (m & PF_STATE) out.playerState[k] = r.u8();
    if (m & PF_AMMO) { out.playerMag[k] = r.u16(); out.playerReserve[k] = r.u16(); }
    if (m & PF_SCORE) { out.playerKills[k] = r.u16(); out.playerDeaths[k] = r.u16(); }
    if (m & PF_TEAM) out.playerTeam[k] = r.u8();
    if (m & PF_AVATAR) out.playerAvatar[k] = r.u32();
  }

  const ec = r.u16();
  out.entityCount = ec > out.maxEntities ? out.maxEntities : ec;
  for (let i = 0; i < ec; i++) {
    const id = r.u16();
    const m = r.u16();
    const k = i < out.maxEntities ? i : out.maxEntities - 1;
    out.entityId[k] = id;
    out.entityMask[k] = m;
    if (m & EF_SPAWN) { out.entityType[k] = r.u8(); out.entityVariant[k] = r.u8(); }
    if (m & EF_REMOVED) out.entityReason[k] = r.u8();
    if (m & EF_POS) {
      out.entityX[k] = dequantizePos(r.i16());
      out.entityY[k] = dequantizePos(r.i16());
      out.entityZ[k] = dequantizePos(r.i16());
    }
    if (m & EF_YAW) out.entityYaw[k] = dequantizeAngle(r.u16());
    if (m & EF_HEALTH) out.entityHealth[k] = r.u16();
    if (m & EF_STATE) out.entityState[k] = r.u8();
    if (m & EF_VEL) {
      out.entityVX[k] = dequantizeVel(r.i16());
      out.entityVY[k] = dequantizeVel(r.i16());
      out.entityVZ[k] = dequantizeVel(r.i16());
    }
  }

  const rc = r.u16();
  out.projectileCount = rc > out.maxProjectiles ? out.maxProjectiles : rc;
  for (let i = 0; i < rc; i++) {
    const id = r.u16();
    const m = r.u16();
    const k = i < out.maxProjectiles ? i : out.maxProjectiles - 1;
    out.projId[k] = id;
    out.projMask[k] = m;
    if (m & RF_SPAWN) { out.projWeapon[k] = r.u8(); out.projOwner[k] = r.u16(); }
    if (m & RF_REMOVED) out.projReason[k] = r.u8();
    if (m & RF_POS) {
      out.projX[k] = dequantizePos(r.i16());
      out.projY[k] = dequantizePos(r.i16());
      out.projZ[k] = dequantizePos(r.i16());
    }
    if (m & RF_VEL) {
      out.projVX[k] = dequantizeVel(r.i16());
      out.projVY[k] = dequantizeVel(r.i16());
      out.projVZ[k] = dequantizeVel(r.i16());
    }
  }
  return out;
}
