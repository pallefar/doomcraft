/**
 * DOOMCRAFT — which of the server's voxel changes get a sound.
 *
 * `Game.onBlocks` receives the authoritative block-delta stream: every other
 * player's dig, every explosion crater, every server-side edit — and the echo
 * of the local player's own edits, because the server broadcasts its journal to
 * every connection including the one that caused it (`server/src/net.ts`,
 * `sendBlockDeltas`). For a long time that stream made no sound at all: the
 * only calls to `sfx.blockBreak` / `blockPlace` anywhere in the client were in
 * `Game.stepEdits`, i.e. your own click, so somebody tunnelling through the
 * wall behind you was completely silent.
 *
 * Turning it on naively is worse than leaving it off, for two reasons that this
 * file exists to handle:
 *
 *  1. **Bursts.** A rocket crater changes forty-plus voxels in ONE tick. Forty
 *     copies of a sample started in the same millisecond is not forty impacts,
 *     it is one impact 32 dB too loud and comb-filtered. `sfx`'s own
 *     `GATE_BLOCK_MS` is a same-id retrigger gate and cannot help, because a
 *     crater spans several materials and therefore several sound ids.
 *
 *  2. **Echo.** Your own dig already made its noise at click time, with no
 *     network latency in it. Sounding the echo too gives every block you break
 *     a slapback one round trip later.
 *
 * So: at most one break and at most one place per message, the NEAREST of each,
 * never closer together than `gapMs`, and never for a voxel this client has
 * already sounded itself.
 *
 * It is a separate object from `Game` because it is the part with rules in it,
 * and rules that are not tested are wishes.
 */

/** Where the chosen sounds are written. -1 means "nothing to play". */
export interface EditAudioPick {
  /** Index into the delta arrays of the nearest voxel that became air. */
  breakIndex: number;
  /** Index into the delta arrays of the nearest voxel that became solid. */
  placeIndex: number;
}

export function createEditAudioPick(): EditAudioPick {
  return { breakIndex: -1, placeIndex: -1 };
}

export interface EditAudioOptions {
  /**
   * Shortest gap between two sounds out of this stream.
   *
   * Must stay under the game's own edit interval (140 ms) or a player digging
   * at the maximum rate the rules allow starts losing blocks; 60 ms collapses
   * everything one tick can produce and still passes every legal dig.
   */
  gapMs?: number;
  /** How long a self-made edit waits for its echo before it is forgotten. */
  ttlMs?: number;
  /** Ring size for outstanding self-edits. */
  capacity?: number;
}

const DEFAULT_GAP_MS = 60;
const DEFAULT_TTL_MS = 2000;
const DEFAULT_CAPACITY = 64;

/** Air. Kept local so this module does not drag the whole block table in. */
const AIR = 0;

export class EditAudioGate {
  readonly gapMs: number;
  readonly ttlMs: number;
  private readonly key: Float64Array;
  private readonly expiry: Float64Array;
  private count = 0;
  private lastPlayedMs = -Infinity;

  constructor(opts: EditAudioOptions = {}) {
    this.gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const cap = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.key = new Float64Array(cap);
    this.expiry = new Float64Array(cap);
  }

  /** Outstanding self-edits, for tests and for the debug overlay. */
  get pendingSelfEdits(): number { return this.count; }

  /** A new world: nothing that was true about the old one still is. */
  reset(): void {
    this.count = 0;
    this.lastPlayedMs = -Infinity;
  }

  /**
   * Record that the local player has already made this voxel's noise, so the
   * server's echo of it is swallowed exactly once.
   */
  noteSelf(x: number, y: number, z: number, nowMs: number): void {
    const k = voxelKey(x, y, z);
    // Compact out anything that expired while nothing was happening, and any
    // stale record of this same voxel — otherwise a ring full of dead keys
    // starts evicting live ones and other players' edits go quiet.
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.expiry[i] <= nowMs || this.key[i] === k) continue;
      this.key[n] = this.key[i];
      this.expiry[n] = this.expiry[i];
      n++;
    }
    if (n >= this.key.length) n = this.key.length - 1;
    this.key[n] = k;
    this.expiry[n] = nowMs + this.ttlMs;
    this.count = n + 1;
  }

  /**
   * Choose what one block-delta message should sound.
   *
   * `prev[i]` is the block that stood there before the message applied, which
   * a break needs because `ids[i]` is air and air has no material. Where the
   * two are equal nothing observable changed — that is also how the net client
   * reports a voxel whose chunk has not finished inflating, and a chunk the
   * player cannot see yet is not a chunk they should hear.
   *
   * Self-edits are consumed whether or not anything ends up being played, so a
   * suppressed burst cannot leave them behind to silence a later dig.
   *
   * Returns true when `out` names at least one sound to play.
   */
  pick(
    count: number,
    xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>,
    ids: ArrayLike<number>, prev: ArrayLike<number>,
    earX: number, earY: number, earZ: number,
    nowMs: number,
    out: EditAudioPick,
  ): boolean {
    out.breakIndex = -1;
    out.placeIndex = -1;
    let breakD = Infinity, placeD = Infinity;

    for (let i = 0; i < count; i++) {
      if (prev[i] === ids[i]) continue;
      if (this.consumeSelf(xs[i], ys[i], zs[i], nowMs)) continue;
      const dx = xs[i] + 0.5 - earX;
      const dy = ys[i] + 0.5 - earY;
      const dz = zs[i] + 0.5 - earZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (ids[i] === AIR) {
        // Nearest, not first: a crater's deltas arrive in world order, so
        // "first" routinely picks the far lip of the hole and then the gap
        // suppresses the block that went off at the player's feet.
        if (d2 < breakD) { breakD = d2; out.breakIndex = i; }
      } else if (d2 < placeD) { placeD = d2; out.placeIndex = i; }
    }

    if (out.breakIndex < 0 && out.placeIndex < 0) return false;
    if (nowMs - this.lastPlayedMs < this.gapMs) {
      out.breakIndex = -1;
      out.placeIndex = -1;
      return false;
    }
    this.lastPlayedMs = nowMs;
    return true;
  }

  /** True if this voxel is our own edit coming back. Consumes the record. */
  private consumeSelf(x: number, y: number, z: number, nowMs: number): boolean {
    if (this.count === 0) return false;
    const k = voxelKey(x, y, z);
    for (let i = 0; i < this.count; i++) {
      if (this.key[i] !== k) continue;
      const live = this.expiry[i] > nowMs;
      this.count--;
      this.key[i] = this.key[this.count];
      this.expiry[i] = this.expiry[this.count];
      return live;
    }
    return false;
  }
}

/**
 * One voxel as one exact number.
 *
 * Exact, not a hash: a collision here silences a real sound, and the world is
 * only 13x13 chunks, so +/-512 blocks horizontally and 64 vertically fits with
 * room to spare and the product stays far inside a double's integer range.
 */
export function voxelKey(x: number, y: number, z: number): number {
  return ((x + 512) * 1024 + (z + 512)) * 64 + (y & 63);
}
