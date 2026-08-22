/**
 * DOOMCRAFT — does the ROOM hold the same level file the client does?
 *
 * `S2C_MODE.CONTEXT` carries `contentHash`: the FNV-1a of the exact level bytes
 * the room stamped into its own world, with 0 reserved for "this room is
 * running generated terrain" (`server/src/room.ts`, `stampedLevelHash` in
 * `shared/src/level.ts`).
 *
 * Quest tested that `u32` **against zero**:
 *
 *     if (!this.placed) this.roomOwnsLevel = context.contentHash !== 0;
 *
 * so a host running an edited `e1m1-hangar.json` and a client on the bundled
 * copy both concluded they agreed. The client then blits ITS level into the
 * voxel store and `levelRuntime` re-asserts those chunks one per frame, while
 * the room goes on colliding the player against a different set of walls and
 * wins every argument. That is the same "I was going through walls" failure the
 * handshake was built to end, one level of indirection further in — and it is
 * silent, because both sides believe they are right.
 *
 * The comparison is here, away from the DOM, for two reasons: `vitest` runs
 * `environment: 'node'` so anything that needs a `document` cannot be tested at
 * all, and this is the only part of the decision that has any logic in it.
 *
 * There are exactly three answers and each one has a different consequence, so
 * a boolean cannot carry them.
 */

import { stampedLevelHash, type Level } from '@shared/level';

export const enum LevelAgreement {
  /**
   * The room has no copy of this level (`contentHash === 0`). The client's blit
   * is the only copy there is, so it relocates the level onto the spawn it got
   * and warns the player that movement may fight the walls. Unchanged, shipped
   * behaviour, and the reason this is not simply an error.
   */
  CLIENT_ONLY = 0,
  /** The room stamped THESE bytes. Both simulations are the same level. */
  AGREED = 1,
  /**
   * The room stamped a DIFFERENT build of this level id. Blitting now would
   * paint one level over another; the only safe move is to refuse.
   */
  MISMATCH = 2,
}

/**
 * The number this client would stamp for the level it is holding.
 *
 * Same function the room uses, including the fold of 0 to 1, so the two cannot
 * drift apart. Encoding a level is not free (it is the whole file), which is
 * why the mode computes this once at construction and not per CONTEXT packet.
 */
export function ownLevelHash(level: Level): number {
  return stampedLevelHash(level);
}

/**
 * Compare what the room says it stamped against what this client is holding.
 *
 * `ownHash` of 0 means the client could not compute one; treated as CLIENT_ONLY
 * rather than as a mismatch, because refusing to play on our own bug is worse
 * than the fallback we shipped for a year.
 */
export function levelAgreement(roomHash: number, ownHash: number): LevelAgreement {
  const room = roomHash >>> 0;
  const own = ownHash >>> 0;
  if (room === 0) return LevelAgreement.CLIENT_ONLY;
  if (own === 0) return LevelAgreement.CLIENT_ONLY;
  return room === own ? LevelAgreement.AGREED : LevelAgreement.MISMATCH;
}

/** One line for the feed, naming both hashes so a bug report can be acted on. */
export function mismatchLine(levelId: string, roomHash: number, ownHash: number): string {
  return `This room is running a different build of ${levelId} `
    + `(room ${(roomHash >>> 0).toString(16)}, ours ${(ownHash >>> 0).toString(16)}). `
    + 'Not loading our copy over it.';
}
