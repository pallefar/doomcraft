/**
 * The rules for sounding the server's block-delta stream.
 *
 * This is the guard on a bug that shipped: `Game.onBlocks` — the authoritative
 * voxel stream carrying every other player's dig, every explosion crater and
 * every server-side edit — applied all of them and played nothing. The only
 * `sfx.blockBreak` / `blockPlace` calls in the whole client were in
 * `Game.stepEdits`, i.e. the local player's own click.
 *
 * Every test below fails against the naive fix as well as against the old
 * silence, which is the point: "play a sound for each delta" turns one rocket
 * into forty simultaneous voices and doubles every dig you make yourself.
 */
import { describe, it, expect } from 'vitest';
import { EditAudioGate, createEditAudioPick, voxelKey } from './editAudio';

const AIR = 0;
const STONE = 1;

/** One delta message, in the shape `NetClient` hands over. */
function msg(rows: Array<[number, number, number, number, number]>): {
  count: number; xs: number[]; ys: number[]; zs: number[]; ids: number[]; prev: number[];
} {
  return {
    count: rows.length,
    xs: rows.map((r) => r[0]),
    ys: rows.map((r) => r[1]),
    zs: rows.map((r) => r[2]),
    ids: rows.map((r) => r[3]),
    prev: rows.map((r) => r[4]),
  };
}

function run(
  gate: EditAudioGate, m: ReturnType<typeof msg>, nowMs: number,
  ear: [number, number, number] = [0, 0, 0],
): { played: boolean; breakIndex: number; placeIndex: number } {
  const out = createEditAudioPick();
  const played = gate.pick(
    m.count, m.xs, m.ys, m.zs, m.ids, m.prev, ear[0], ear[1], ear[2], nowMs, out,
  );
  return { played, breakIndex: out.breakIndex, placeIndex: out.placeIndex };
}

describe('voxelKey', () => {
  it('is exact — a collision would silence a real edit', () => {
    const seen = new Set<number>();
    for (let x = -40; x <= 40; x += 7) {
      for (let z = -40; z <= 40; z += 7) {
        for (let y = 0; y < 64; y += 3) {
          const k = voxelKey(x, y, z);
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
    }
  });

  it('separates neighbours on every axis', () => {
    const k = voxelKey(10, 20, 30);
    expect(voxelKey(11, 20, 30)).not.toBe(k);
    expect(voxelKey(10, 21, 30)).not.toBe(k);
    expect(voxelKey(10, 20, 31)).not.toBe(k);
  });
});

describe('another player digging is audible', () => {
  it('sounds a break that this client did not make', () => {
    const g = new EditAudioGate();
    const r = run(g, msg([[4, 10, 0, AIR, STONE]]), 1000);
    expect(r.played).toBe(true);
    expect(r.breakIndex).toBe(0);
    expect(r.placeIndex).toBe(-1);
  });

  it('sounds a place, separately from a break', () => {
    const g = new EditAudioGate();
    const r = run(g, msg([[4, 10, 0, STONE, AIR]]), 1000);
    expect(r.played).toBe(true);
    expect(r.breakIndex).toBe(-1);
    expect(r.placeIndex).toBe(0);
  });

  it('lets a break and a place in the same message both speak', () => {
    const g = new EditAudioGate();
    const r = run(g, msg([[4, 10, 0, AIR, STONE], [5, 10, 0, STONE, AIR]]), 1000);
    expect(r.breakIndex).toBe(0);
    expect(r.placeIndex).toBe(1);
  });

  it('keeps up with a player digging at the maximum legal rate', () => {
    // EDIT_INTERVAL_MS is 140. Every one of these must be heard.
    const g = new EditAudioGate();
    let heard = 0;
    for (let i = 0; i < 8; i++) {
      if (run(g, msg([[i, 10, 0, AIR, STONE]]), 1000 + i * 140).played) heard++;
    }
    expect(heard).toBe(8);
  });

  it('says nothing when nothing changed', () => {
    const g = new EditAudioGate();
    // prev === id: either a no-op, or a voxel whose chunk is still inflating.
    expect(run(g, msg([[4, 10, 0, STONE, STONE]]), 1000).played).toBe(false);
  });
});

describe('a crater is one sound, not fifty', () => {
  const crater = (): ReturnType<typeof msg> => {
    const rows: Array<[number, number, number, number, number]> = [];
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) rows.push([20 + x, 12, 20 + z, AIR, STONE]);
    }
    return msg(rows);
  };

  it('collapses 49 voxels changed in one tick to a single break', () => {
    const g = new EditAudioGate();
    const r = run(g, crater(), 1000);
    expect(r.played).toBe(true);
    // One index, not a list: the caller can only play what it is handed.
    expect(r.breakIndex).toBeGreaterThanOrEqual(0);
    expect(r.placeIndex).toBe(-1);
  });

  it('picks the voxel NEAREST the listener, not the first in journal order', () => {
    const g = new EditAudioGate();
    const m = crater();
    // Stand at the far corner of the crater; journal order starts at the near
    // one, so "first" and "nearest" are different indices and the difference is
    // audible — the sound would come from the wrong side of the hole.
    const ear: [number, number, number] = [23.5, 12.5, 23.5];
    const r = run(g, m, 1000, ear);
    expect(r.breakIndex).toBe(m.count - 1);
  });

  it('suppresses the follow-up messages a big crater arrives in', () => {
    const g = new EditAudioGate();
    // One tick's worth of edits can exceed MAX_BLOCK_DELTAS_PER_MESSAGE and
    // arrive as several messages in the same pump.
    expect(run(g, crater(), 1000).played).toBe(true);
    expect(run(g, crater(), 1000).played).toBe(false);
    expect(run(g, crater(), 1002).played).toBe(false);
    expect(run(g, crater(), 1059).played).toBe(false);
    expect(run(g, crater(), 1060).played).toBe(true);
  });
});

describe('your own dig is not heard twice', () => {
  it('swallows the echo of an edit this client already sounded', () => {
    const g = new EditAudioGate();
    g.noteSelf(4, 10, 0, 1000);
    // The server echoes it back one round trip later — far past the 60 ms gap,
    // so nothing but the self-edit record can stop it.
    expect(run(g, msg([[4, 10, 0, AIR, STONE]]), 1120).played).toBe(false);
  });

  it('swallows it exactly once — breaking the same voxel later still speaks', () => {
    const g = new EditAudioGate();
    g.noteSelf(4, 10, 0, 1000);
    expect(run(g, msg([[4, 10, 0, AIR, STONE]]), 1120).played).toBe(false);
    // Somebody places a block back there and breaks it again.
    expect(run(g, msg([[4, 10, 0, STONE, AIR]]), 1300).played).toBe(true);
  });

  it('does not swallow a DIFFERENT voxel', () => {
    const g = new EditAudioGate();
    g.noteSelf(4, 10, 0, 1000);
    expect(run(g, msg([[5, 10, 0, AIR, STONE]]), 1120).played).toBe(true);
  });

  it('forgets an edit the server never acknowledged', () => {
    const g = new EditAudioGate({ ttlMs: 500 });
    g.noteSelf(4, 10, 0, 1000);
    // Rejected: no echo ever arrives. Long after, somebody else digs there.
    expect(run(g, msg([[4, 10, 0, AIR, STONE]]), 2000).played).toBe(true);
  });

  it('consumes self-edits even inside a suppressed burst', () => {
    // Otherwise a rate-limited message leaves the record behind and it goes on
    // to silence a genuine edit at the same voxel much later.
    const g = new EditAudioGate();
    g.noteSelf(9, 10, 9, 1000);
    run(g, msg([[1, 10, 1, AIR, STONE]]), 1000);          // spends the gap
    run(g, msg([[9, 10, 9, AIR, STONE]]), 1010);          // suppressed by it
    expect(g.pendingSelfEdits).toBe(0);
    expect(run(g, msg([[9, 10, 9, AIR, STONE]]), 1200).played).toBe(true);
  });

  it('does not let a full ring of stale keys evict live ones', () => {
    const g = new EditAudioGate({ capacity: 4, ttlMs: 100 });
    for (let i = 0; i < 4; i++) g.noteSelf(i, 10, 0, 1000);
    // All four expire; a fifth arrives and must not be crowded out.
    g.noteSelf(99, 10, 0, 1200);
    expect(g.pendingSelfEdits).toBe(1);
    expect(run(g, msg([[99, 10, 0, AIR, STONE]]), 1250).played).toBe(false);
  });
});

describe('a new world starts clean', () => {
  it('drops self-edit records and the gap when the world is replaced', () => {
    const g = new EditAudioGate();
    g.noteSelf(4, 10, 0, 1000);
    expect(run(g, msg([[1, 10, 1, AIR, STONE]]), 1000).played).toBe(true);
    g.reset();
    expect(g.pendingSelfEdits).toBe(0);
    // Same coordinates, new terrain, and no leftover gap.
    expect(run(g, msg([[4, 10, 0, AIR, STONE]]), 1001).played).toBe(true);
  });
});
