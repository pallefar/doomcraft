/**
 * DOOMCRAFT — Builder undo / redo.
 *
 * The bar (Minecraft Classic, `ref/mcclassic/`) has **no undo at all**. Misplace
 * a block and your only recovery is to break it again, which is a second edit
 * with its own latency and its own chance of hitting the wrong face. Undo is
 * therefore free ground, and the only interesting question is how to make it
 * bounded, exact and allocation-free.
 *
 * Shape of the thing:
 *
 *   - History is a ring of **groups**. One click is one group; a drag that
 *     paints eleven blocks while the button is held is also one group, so undo
 *     reverses a gesture rather than a voxel.
 *   - Changes live in a separate **circular arena** of parallel typed arrays.
 *     A group is a (start, count) window into it. Nothing is allocated after
 *     construction: `record()` writes five array slots and returns.
 *   - Eviction is from the tail. When the arena is full the oldest group is
 *     dropped whole — never half a group, because half an undo is worse than
 *     no undo.
 *   - `undo()` replays a group backwards writing `prev`, `redo()` replays it
 *     forwards writing `next`. Both are exact: the arena stores the block id
 *     that was actually there, read from the world at record time, so undo
 *     restores the prior state rather than "air".
 *
 * Only the local player's own edits go in. Another builder's changes arrive as
 * server deltas and are none of our business to reverse — that is the rule the
 * mode enforces by simply never calling `record()` for them.
 *
 * This module imports nothing from three, the DOM or the net, which is what
 * makes it directly unit-testable.
 */

/* ------------------------------------------------------------------------ *
 * Sizing
 * ------------------------------------------------------------------------ */

/** Gestures kept. 256 clicks of history is far past what anyone scrolls back. */
export const DEFAULT_MAX_GROUPS = 256;
/**
 * Voxel changes kept, across all groups. 16384 * 8 bytes of typed array is
 * 128 KB, allocated once at mode entry and never grown.
 */
export const DEFAULT_MAX_CHANGES = 16384;

/** What produced a group. Shown in the undo toast so the player knows what went. */
export enum EditKind {
  PLACE = 0,
  BREAK = 1,
  FILL = 2,
  UNDO_OF_REMOTE = 3,
}

export const EDIT_KIND_NAMES: readonly string[] = ['Place', 'Break', 'Fill', 'Revert'];

export function editKindName(kind: number): string {
  return EDIT_KIND_NAMES[kind] ?? 'Edit';
}

/* ------------------------------------------------------------------------ *
 * Callback shapes
 * ------------------------------------------------------------------------ */

/**
 * How a reversed change is put back into the world. `id` is what the voxel must
 * become; `from` is what the history believes is there right now, which lets a
 * caller skip a write another player has already overwritten.
 */
export type ApplyChange = (x: number, y: number, z: number, id: number, from: number) => void;

export interface EditHistoryStats {
  groups: number;
  changes: number;
  /** Groups that can still be undone. */
  undoDepth: number;
  /** Groups that can still be redone. */
  redoDepth: number;
  /** Groups dropped because the arena filled. */
  evicted: number;
  /** Changes refused because a single group exceeded the arena. */
  overflowed: number;
  capacityGroups: number;
  capacityChanges: number;
}

export interface EditHistoryOptions {
  maxGroups?: number;
  maxChanges?: number;
}

/* ------------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------------ */

/**
 * A bounded undo/redo stack over voxel edits.
 *
 * Usage is always begin -> record* -> commit:
 *
 * ```ts
 *   history.begin(EditKind.PLACE);
 *   history.record(x, y, z, prevId, nextId);
 *   history.commit();
 * ```
 *
 * `commit()` on an empty group is a no-op, so a click that turned out to change
 * nothing does not consume a slot and does not make the next undo a no-op.
 */
export class EditHistory {
  private readonly capGroups: number;
  private readonly capChanges: number;

  /* change arena, circular */
  private readonly cx: Int16Array;
  private readonly cy: Uint8Array;
  private readonly cz: Int16Array;
  private readonly cPrev: Uint8Array;
  private readonly cNext: Uint8Array;
  /** Next write slot in the arena. */
  private head = 0;
  /** Occupied slots. */
  private used = 0;

  /* group ring */
  private readonly gStart: Int32Array;
  private readonly gCount: Int32Array;
  private readonly gKind: Uint8Array;
  private readonly gTime: Float64Array;
  /** Index of the oldest live group. */
  private tail = 0;
  /** Live groups. */
  private count = 0;
  /** Groups currently applied to the world; the rest are the redo tail. */
  private applied = 0;

  /* open group */
  private openStart = -1;
  private openCount = 0;
  private openKind: EditKind = EditKind.PLACE;
  private openTime = 0;

  private evicted = 0;
  private overflowed = 0;

  constructor(options: EditHistoryOptions = {}) {
    this.capGroups = Math.max(1, options.maxGroups ?? DEFAULT_MAX_GROUPS);
    this.capChanges = Math.max(this.capGroups, options.maxChanges ?? DEFAULT_MAX_CHANGES);

    this.cx = new Int16Array(this.capChanges);
    this.cy = new Uint8Array(this.capChanges);
    this.cz = new Int16Array(this.capChanges);
    this.cPrev = new Uint8Array(this.capChanges);
    this.cNext = new Uint8Array(this.capChanges);

    this.gStart = new Int32Array(this.capGroups);
    this.gCount = new Int32Array(this.capGroups);
    this.gKind = new Uint8Array(this.capGroups);
    this.gTime = new Float64Array(this.capGroups);
  }

  /* --- queries --------------------------------------------------------- */

  get canUndo(): boolean { return this.applied > 0; }
  get canRedo(): boolean { return this.applied < this.count; }
  get groupCount(): number { return this.count; }
  get changeCount(): number { return this.used; }
  get isOpen(): boolean { return this.openStart >= 0; }
  /** Changes recorded into the group currently open. */
  get openSize(): number { return this.openCount; }

  stats(): EditHistoryStats {
    return {
      groups: this.count,
      changes: this.used,
      undoDepth: this.applied,
      redoDepth: this.count - this.applied,
      evicted: this.evicted,
      overflowed: this.overflowed,
      capacityGroups: this.capGroups,
      capacityChanges: this.capChanges,
    };
  }

  /** Label of the group the next `undo()` would reverse, '' when there is none. */
  undoLabel(): string {
    if (this.applied === 0) return '';
    const g = this.ring(this.applied - 1);
    return `${editKindName(this.gKind[g])} x${this.gCount[g]}`;
  }

  /** Label of the group the next `redo()` would replay, '' when there is none. */
  redoLabel(): string {
    if (this.applied >= this.count) return '';
    const g = this.ring(this.applied);
    return `${editKindName(this.gKind[g])} x${this.gCount[g]}`;
  }

  /* --- recording -------------------------------------------------------- */

  /**
   * Open a group. An already-open group is committed first, so a caller that
   * loses track of its own pairing degrades to one-group-per-begin rather than
   * to corruption.
   */
  begin(kind: EditKind, nowMs = 0): void {
    if (this.openStart >= 0) this.commit();
    // A new edit invalidates the redo tail; do it now so the arena space the
    // dead groups hold is available to this group.
    this.dropRedoTail();
    this.openStart = this.head;
    this.openCount = 0;
    this.openKind = kind;
    this.openTime = nowMs;
  }

  /**
   * Record one voxel change. Returns false when the change was refused, which
   * happens only when a single group is larger than the whole arena.
   *
   * `prev` is what the voxel was; `next` is what it became. Both are read from
   * the world by the caller, never guessed here.
   */
  record(x: number, y: number, z: number, prev: number, next: number): boolean {
    if (this.openStart < 0) this.begin(EditKind.PLACE);
    if (prev === next) return true;

    // Make room. Evicting the oldest group can never touch the open group,
    // because the open group is the newest thing in the arena — unless the open
    // group alone has filled it, and then the edit is genuinely too big.
    while (this.used + this.openCount >= this.capChanges) {
      if (this.count === 0) { this.overflowed++; return false; }
      this.evictOldest();
    }

    const i = this.head;
    this.cx[i] = x;
    this.cy[i] = y;
    this.cz[i] = z;
    this.cPrev[i] = prev;
    this.cNext[i] = next;
    this.head = i + 1 === this.capChanges ? 0 : i + 1;
    this.openCount++;
    return true;
  }

  /**
   * Close the open group. Returns how many changes it holds; 0 means nothing
   * was recorded and no history slot was consumed.
   */
  commit(): number {
    const n = this.openCount;
    const start = this.openStart;
    this.openStart = -1;
    this.openCount = 0;
    if (start < 0 || n === 0) return 0;

    if (this.count === this.capGroups) this.evictOldest();

    const g = this.ring(this.count);
    this.gStart[g] = start;
    this.gCount[g] = n;
    this.gKind[g] = this.openKind;
    this.gTime[g] = this.openTime;
    this.count++;
    this.applied = this.count;
    this.used += n;
    return n;
  }

  /** Throw away the open group and the arena space it took. */
  abort(): void {
    if (this.openStart < 0) return;
    this.head = this.openStart;
    this.openStart = -1;
    this.openCount = 0;
  }

  /* --- undo / redo ------------------------------------------------------ */

  /**
   * Reverse the newest applied group, newest change first. Returns the number
   * of voxels written back, 0 when there was nothing to undo.
   */
  undo(apply: ApplyChange): number {
    if (this.openStart >= 0) this.commit();
    if (this.applied === 0) return 0;
    const g = this.ring(this.applied - 1);
    const start = this.gStart[g];
    const n = this.gCount[g];
    for (let k = n - 1; k >= 0; k--) {
      const i = this.arena(start + k);
      apply(this.cx[i], this.cy[i], this.cz[i], this.cPrev[i], this.cNext[i]);
    }
    this.applied--;
    return n;
  }

  /** Replay the oldest undone group, oldest change first. */
  redo(apply: ApplyChange): number {
    if (this.openStart >= 0) this.commit();
    if (this.applied >= this.count) return 0;
    const g = this.ring(this.applied);
    const start = this.gStart[g];
    const n = this.gCount[g];
    for (let k = 0; k < n; k++) {
      const i = this.arena(start + k);
      apply(this.cx[i], this.cy[i], this.cz[i], this.cNext[i], this.cPrev[i]);
    }
    this.applied++;
    return n;
  }

  /**
   * Walk the changes of the group `depth` steps back from the present without
   * mutating anything. `depth` 0 is the group the next `undo()` would reverse.
   * Returns false when there is no such group.
   */
  inspect(depth: number, visit: (x: number, y: number, z: number, prev: number, next: number) => void): boolean {
    const idx = this.applied - 1 - depth;
    if (idx < 0 || idx >= this.count) return false;
    const g = this.ring(idx);
    const start = this.gStart[g];
    const n = this.gCount[g];
    for (let k = 0; k < n; k++) {
      const i = this.arena(start + k);
      visit(this.cx[i], this.cy[i], this.cz[i], this.cPrev[i], this.cNext[i]);
    }
    return true;
  }

  clear(): void {
    this.head = 0;
    this.used = 0;
    this.tail = 0;
    this.count = 0;
    this.applied = 0;
    this.openStart = -1;
    this.openCount = 0;
  }

  /* --- internals -------------------------------------------------------- */

  /** Ring index of the `n`th live group, 0 == oldest. */
  private ring(n: number): number {
    const i = this.tail + n;
    return i >= this.capGroups ? i - this.capGroups : i;
  }

  private arena(i: number): number {
    return i >= this.capChanges ? i - this.capChanges : i;
  }

  private evictOldest(): void {
    if (this.count === 0) return;
    const g = this.tail;
    this.used -= this.gCount[g];
    if (this.used < 0) this.used = 0;
    this.tail = g + 1 === this.capGroups ? 0 : g + 1;
    this.count--;
    if (this.applied > this.count) this.applied = this.count;
    else if (this.applied > 0) this.applied--;
    this.evicted++;
  }

  /**
   * Drop every group above the applied cursor. Their arena space is at the head
   * end, so freeing it is a rewind of `head` rather than a compaction.
   */
  private dropRedoTail(): void {
    if (this.applied >= this.count) return;
    let freed = 0;
    for (let n = this.applied; n < this.count; n++) freed += this.gCount[this.ring(n)];
    const first = this.ring(this.applied);
    this.head = this.gStart[first];
    this.used -= freed;
    if (this.used < 0) this.used = 0;
    this.count = this.applied;
  }
}

/* ------------------------------------------------------------------------ *
 * Convenience
 * ------------------------------------------------------------------------ */

/**
 * Record a single-voxel gesture in one call. The overwhelmingly common case —
 * one click, one block — and it keeps the mode's edit path to a single line.
 */
export function recordSingle(
  history: EditHistory, kind: EditKind,
  x: number, y: number, z: number, prev: number, next: number, nowMs = 0,
): boolean {
  history.begin(kind, nowMs);
  const ok = history.record(x, y, z, prev, next);
  history.commit();
  return ok;
}
