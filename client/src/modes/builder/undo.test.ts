/**
 * Builder — undo exactness and placement rules.
 *
 * The headline assertion is the one from the brief: **undo restores exactly the
 * prior state**. Not "restores air", not "restores approximately" — the whole
 * voxel map, cell for cell, compared against a snapshot taken before the edits.
 *
 * The placement half tests the three rules the bar gets wrong, measured off
 * `ref/mcclassic/`: the body check that stops you entombing yourself, the reach
 * measurement that has to agree with `ServerWorld.validateEdit` to the metre,
 * and the hold cadence that decides whether a held button builds or spams.
 */

import { describe, expect, it } from 'vitest';

import { BlockId, blockName, minimapColor } from '@shared/blocks';
import { PLAYER_HALF_WIDTH, PLAYER_HEIGHT, REACH_PLACE } from '@shared/constants';

import { EditHistory, EditKind, recordSingle } from './undo';
import { worldSwatch } from './builder';
import {
  BREAK_REPEAT_MS,
  EMPTY_BODIES,
  PLACE_REPEAT_MS,
  PlacementController,
  Refusal,
  cellOverlapsBody,
  createAimInput,
  createBuildTarget,
  computeTarget,
  colorLuminance,
  reachToCube,
  type BodyProbe,
  type PlacementSink,
} from './placement';
import { createVoxelHit } from '@shared/math';

/* ------------------------------------------------------------------------ *
 * A toy world: a flat stone floor at y = 20, air above it.
 * ------------------------------------------------------------------------ */

class ToyWorld {
  readonly cells = new Map<string, number>();

  constructor(floorY = 20) {
    for (let x = -8; x <= 8; x++) {
      for (let z = -8; z <= 8; z++) this.cells.set(key(x, floorY, z), BlockId.STONE);
    }
  }

  get(x: number, y: number, z: number): number {
    return this.cells.get(key(x, y, z)) ?? BlockId.AIR;
  }

  set(x: number, y: number, z: number, id: number): void {
    if (id === BlockId.AIR) this.cells.delete(key(x, y, z));
    else this.cells.set(key(x, y, z), id);
  }

  snapshot(): string {
    return Array.from(this.cells.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)).join('|');
  }
}

function key(x: number, y: number, z: number): string { return `${x},${y},${z}`; }

/* ------------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------------ */

describe('EditHistory', () => {
  it('undo restores exactly the prior state, cell for cell', () => {
    const world = new ToyWorld();
    const before = world.snapshot();
    const history = new EditHistory();

    // A realistic session: a wall, a hole through the floor, a re-place on top
    // of an existing block, and a break of something that was never air.
    const edits: Array<[number, number, number, number]> = [
      [0, 21, 0, BlockId.BRICK],
      [1, 21, 0, BlockId.BRICK],
      [2, 21, 0, BlockId.BRICK],
      [0, 20, 0, BlockId.AIR],        // dig the floor out
      [1, 20, 0, BlockId.AIR],
      [0, 21, 0, BlockId.GLASS],      // overwrite our own brick
      [3, 22, 3, BlockId.NEON],
      [2, 21, 0, BlockId.AIR],        // and take one back down
    ];
    for (const [x, y, z, id] of edits) {
      const prev = world.get(x, y, z);
      world.set(x, y, z, id);
      recordSingle(history, id === BlockId.AIR ? EditKind.BREAK : EditKind.PLACE, x, y, z, prev, id);
    }
    const after = world.snapshot();
    expect(after).not.toBe(before);
    expect(history.groupCount).toBe(edits.length);

    while (history.canUndo) history.undo((x, y, z, id) => world.set(x, y, z, id));
    expect(world.snapshot()).toBe(before);

    while (history.canRedo) history.redo((x, y, z, id) => world.set(x, y, z, id));
    expect(world.snapshot()).toBe(after);

    // And back again, twice, to prove the cursor is not one-way.
    while (history.canUndo) history.undo((x, y, z, id) => world.set(x, y, z, id));
    expect(world.snapshot()).toBe(before);
  });

  it('reverses a whole drag as one gesture', () => {
    const world = new ToyWorld();
    const before = world.snapshot();
    const history = new EditHistory();

    history.begin(EditKind.PLACE);
    for (let i = 0; i < 11; i++) {
      const prev = world.get(i, 21, 0);
      world.set(i, 21, 0, BlockId.PLANKS);
      history.record(i, 21, 0, prev, BlockId.PLANKS);
    }
    expect(history.commit()).toBe(11);
    expect(history.groupCount).toBe(1);

    expect(history.undo((x, y, z, id) => world.set(x, y, z, id))).toBe(11);
    expect(world.snapshot()).toBe(before);
    expect(history.canUndo).toBe(false);
  });

  it('replays a group backwards and redoes it forwards', () => {
    const history = new EditHistory();
    const order: number[] = [];
    history.begin(EditKind.FILL);
    for (let i = 0; i < 4; i++) history.record(i, 30, 0, BlockId.AIR, BlockId.STONE);
    history.commit();

    history.undo((x) => order.push(x));
    expect(order).toEqual([3, 2, 1, 0]);
    order.length = 0;
    history.redo((x) => order.push(x));
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('drops the redo tail as soon as a new edit lands', () => {
    const history = new EditHistory();
    recordSingle(history, EditKind.PLACE, 0, 21, 0, BlockId.AIR, BlockId.STONE);
    recordSingle(history, EditKind.PLACE, 1, 21, 0, BlockId.AIR, BlockId.STONE);
    history.undo(() => { /* discard */ });
    expect(history.canRedo).toBe(true);

    recordSingle(history, EditKind.PLACE, 2, 21, 0, BlockId.AIR, BlockId.BRICK);
    expect(history.canRedo).toBe(false);
    expect(history.groupCount).toBe(2);
    expect(history.stats().changes).toBe(2);
  });

  it('an empty group costs nothing', () => {
    const history = new EditHistory();
    history.begin(EditKind.PLACE);
    expect(history.commit()).toBe(0);
    expect(history.groupCount).toBe(0);
    expect(history.canUndo).toBe(false);

    // A no-op change (same block) is not history either.
    history.begin(EditKind.PLACE);
    history.record(0, 21, 0, BlockId.STONE, BlockId.STONE);
    expect(history.commit()).toBe(0);
    expect(history.groupCount).toBe(0);
  });

  it('is bounded: the oldest gestures are evicted whole, never in half', () => {
    const history = new EditHistory({ maxGroups: 8, maxChanges: 40 });
    for (let g = 0; g < 40; g++) {
      history.begin(EditKind.PLACE);
      for (let i = 0; i < 5; i++) history.record(g, 21, i, BlockId.AIR, BlockId.STONE);
      history.commit();
    }
    const stats = history.stats();
    expect(stats.groups).toBeLessThanOrEqual(8);
    expect(stats.changes).toBeLessThanOrEqual(40);
    expect(stats.evicted).toBeGreaterThan(0);

    // Whatever survived must still undo cleanly and completely.
    let undone = 0;
    while (history.canUndo) undone += history.undo(() => { /* discard */ });
    expect(undone).toBe(stats.changes);
    expect(history.stats().undoDepth).toBe(0);
  });

  it('survives an abort and keeps the arena consistent', () => {
    const history = new EditHistory({ maxGroups: 4, maxChanges: 16 });
    recordSingle(history, EditKind.PLACE, 0, 21, 0, BlockId.AIR, BlockId.STONE);
    history.begin(EditKind.PLACE);
    for (let i = 0; i < 6; i++) history.record(i, 22, 0, BlockId.AIR, BlockId.BRICK);
    history.abort();
    expect(history.groupCount).toBe(1);
    expect(history.stats().changes).toBe(1);
    recordSingle(history, EditKind.PLACE, 9, 21, 0, BlockId.AIR, BlockId.GLASS);
    expect(history.groupCount).toBe(2);
    let n = 0;
    while (history.canUndo) n += history.undo(() => { /* discard */ });
    expect(n).toBe(2);
  });

  it('labels what it is about to undo', () => {
    const history = new EditHistory();
    history.begin(EditKind.BREAK);
    history.record(0, 20, 0, BlockId.STONE, BlockId.AIR);
    history.record(1, 20, 0, BlockId.STONE, BlockId.AIR);
    history.commit();
    expect(history.undoLabel()).toBe('Break x2');
    history.undo(() => { /* discard */ });
    expect(history.redoLabel()).toBe('Break x2');
    expect(history.undoLabel()).toBe('');
  });
});

/* ------------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------------ */

describe('reach', () => {
  it('measures to the nearest point of the cube, like the server does', () => {
    // Directly above: the eye is 3 m over the top face of the cube at y = 20.
    expect(reachToCube(0.5, 24, 0.5, 0, 20, 0)).toBeCloseTo(3, 6);
    // Inside the cube: zero, never negative.
    expect(reachToCube(0.5, 20.5, 0.5, 0, 20, 0)).toBe(0);
    // Diagonally off a corner.
    expect(reachToCube(-1, 22, -1, 0, 20, 0)).toBeCloseTo(Math.sqrt(1 + 1 + 1), 6);
  });

  it('the centre-distance shortcut would refuse blocks the server accepts', () => {
    // The trap this mirrors: at the reach limit, measuring to the centre is up
    // to 0.87 m longer than measuring to the nearest face.
    const ex = 0, ey = 30, ez = 0;
    const x = 6, y = 30, z = 0;
    const nearest = reachToCube(ex, ey, ez, x, y, z);
    const centre = Math.hypot(x + 0.5 - ex, y + 0.5 - ey, z + 0.5 - ez);
    expect(nearest).toBeLessThanOrEqual(REACH_PLACE);
    expect(centre).toBeGreaterThan(REACH_PLACE);
  });
});

describe('body check', () => {
  it('refuses the cell a standing player occupies — the bar does not', () => {
    // Player feet at (0.5, 20, 0.5), 1.8 m tall.
    expect(cellOverlapsBody(0, 20, 0, 0.5, 20, 0.5, PLAYER_HALF_WIDTH, PLAYER_HEIGHT)).toBe(true);
    expect(cellOverlapsBody(0, 21, 0, 0.5, 20, 0.5, PLAYER_HALF_WIDTH, PLAYER_HEIGHT)).toBe(true);
    expect(cellOverlapsBody(0, 22, 0, 0.5, 20, 0.5, PLAYER_HALF_WIDTH, PLAYER_HEIGHT)).toBe(false);
    expect(cellOverlapsBody(1, 20, 0, 0.5, 20, 0.5, PLAYER_HALF_WIDTH, PLAYER_HEIGHT)).toBe(false);
    expect(cellOverlapsBody(0, 19, 0, 0.5, 20, 0.5, PLAYER_HALF_WIDTH, PLAYER_HEIGHT)).toBe(false);
  });
});

describe('computeTarget', () => {
  const world = new ToyWorld();
  const getBlock = (x: number, y: number, z: number): number => world.get(x, y, z);

  it('resolves the face under the crosshair and the cell a block would go in', () => {
    const aim = createAimInput();
    aim.eyeX = 0.5; aim.eyeY = 23; aim.eyeZ = 0.5;
    aim.originX = 0.5; aim.originY = 23; aim.originZ = 0.5;
    aim.dirX = 0; aim.dirY = -1; aim.dirZ = 0;
    aim.heldBlock = BlockId.BRICK;

    const t = computeTarget(aim, getBlock, EMPTY_BODIES, 3.2, createVoxelHit(), createBuildTarget());
    expect(t.hit).toBe(true);
    expect([t.x, t.y, t.z]).toEqual([0, 20, 0]);
    expect([t.nx, t.ny, t.nz]).toEqual([0, 1, 0]);
    expect([t.px, t.py, t.pz]).toEqual([0, 21, 0]);
    expect(t.canBreak).toBe(true);
    expect(t.canPlace).toBe(true);
  });

  it('refuses to put a block inside the player who is standing on it', () => {
    const aim = createAimInput();
    // Standing on the floor at y = 21, looking straight down at it.
    aim.eyeX = 0.5; aim.eyeY = 22.62; aim.eyeZ = 0.5;
    aim.originX = 0.5; aim.originY = 22.62; aim.originZ = 0.5;
    aim.dirX = 0; aim.dirY = -1; aim.dirZ = 0;
    aim.heldBlock = BlockId.STONE;

    const feet: BodyProbe = {
      occupied: (x, y, z) => cellOverlapsBody(x, y, z, 0.5, 21, 0.5, PLAYER_HALF_WIDTH, PLAYER_HEIGHT),
    };
    const t = computeTarget(aim, getBlock, feet, 3.2, createVoxelHit(), createBuildTarget());
    expect(t.hit).toBe(true);
    expect([t.px, t.py, t.pz]).toEqual([0, 21, 0]);
    expect(t.canPlace).toBe(false);
    expect(t.placeRefusal).toBe(Refusal.INSIDE_BODY);
    // Breaking the block under your feet is still allowed; falling is fine.
    expect(t.canBreak).toBe(true);
  });

  // Eye at 28.5 over a floor whose top face is y = 21 puts the entry point 7.5 m
  // out: past REACH_BREAK (6.0) but inside the ray's reach + 1.8 overshoot. The
  // overshoot exists because the server measures to the NEAREST point of the
  // cube, which a glancing ray can undershoot by up to the cube diagonal
  // (sqrt(3) = 1.73). Cast exactly to the reach instead and the last row of
  // legal blocks would silently refuse; cast much further and we would draw
  // highlights the server will never accept.
  it('refuses a target past the reach the server would allow', () => {
    const aim = createAimInput();
    aim.eyeX = 0.5; aim.eyeY = 28.5; aim.eyeZ = 0.5;
    aim.originX = 0.5; aim.originY = 28.5; aim.originZ = 0.5;
    aim.dirX = 0; aim.dirY = -1; aim.dirZ = 0;
    aim.heldBlock = BlockId.STONE;
    const t = computeTarget(aim, getBlock, EMPTY_BODIES, 3.2, createVoxelHit(), createBuildTarget());
    expect(t.hit).toBe(true);
    expect(t.canBreak).toBe(false);
    expect(t.breakRefusal).toBe(Refusal.OUT_OF_REACH);
    expect(t.placeRefusal).toBe(Refusal.OUT_OF_REACH);
  });

  it('refuses an empty hand and an already-occupied cell', () => {
    const aim = createAimInput();
    aim.eyeX = 0.5; aim.eyeY = 23; aim.eyeZ = 0.5;
    aim.originX = 0.5; aim.originY = 23; aim.originZ = 0.5;
    aim.dirX = 0; aim.dirY = -1; aim.dirZ = 0;

    aim.heldBlock = BlockId.AIR;
    let t = computeTarget(aim, getBlock, EMPTY_BODIES, 3.2, createVoxelHit(), createBuildTarget());
    expect(t.placeRefusal).toBe(Refusal.NOT_PLACEABLE);

    aim.heldBlock = BlockId.STONE;
    aim.hasStock = false;
    t = computeTarget(aim, getBlock, EMPTY_BODIES, 3.2, createVoxelHit(), createBuildTarget());
    expect(t.placeRefusal).toBe(Refusal.NO_STOCK);

    aim.hasStock = true;
    const filled = new ToyWorld();
    filled.set(0, 21, 0, BlockId.BRICK);
    t = computeTarget(aim, (x, y, z) => filled.get(x, y, z), EMPTY_BODIES, 3.2, createVoxelHit(), createBuildTarget());
    // The ray now stops on the brick, so the place cell is above it.
    expect([t.x, t.y, t.z]).toEqual([0, 21, 0]);
    expect([t.px, t.py, t.pz]).toEqual([0, 22, 0]);
    expect(t.canPlace).toBe(true);
  });
});

describe('PlacementController cadence', () => {
  function rig(instantBreak: boolean): {
    world: ToyWorld;
    controller: PlacementController;
    placed: number[][];
    broken: number[][];
  } {
    const world = new ToyWorld();
    const placed: number[][] = [];
    const broken: number[][] = [];
    const sink: PlacementSink = {
      breakBlock(x, y, z) { world.set(x, y, z, BlockId.AIR); broken.push([x, y, z]); return true; },
      placeBlock(x, y, z, id) { world.set(x, y, z, id); placed.push([x, y, z]); return true; },
    };
    const controller = new PlacementController({
      getBlock: (x, y, z) => world.get(x, y, z),
      bodies: EMPTY_BODIES,
      sink,
      instantBreak,
    });
    controller.aim.eyeX = 0.5; controller.aim.eyeY = 23.5; controller.aim.eyeZ = 0.5;
    controller.aim.originX = 0.5; controller.aim.originY = 23.5; controller.aim.originZ = 0.5;
    controller.aim.dirX = 0; controller.aim.dirY = -1; controller.aim.dirZ = 0;
    controller.aim.heldBlock = BlockId.BRICK;
    return { world, controller, placed, broken };
  }

  it('places on the press frame, then at the repeat rate — not at the frame rate', () => {
    const { controller, placed } = rig(true);
    controller.retarget();
    expect(controller.update(16, false, true)).toBe(1);   // the click
    expect(placed.length).toBe(1);

    // Sixty frames of holding still. Each new block becomes the next target, so
    // this is the tower case: it must run at PLACE_REPEAT_MS, not RETARGET.
    for (let i = 0; i < 60; i++) {
      controller.retarget();
      controller.update(16, false, true);
    }
    const elapsed = 16 * 61;
    const expected = 1 + Math.floor(elapsed / PLACE_REPEAT_MS);
    expect(placed.length).toBeGreaterThan(1);
    expect(placed.length).toBeLessThanOrEqual(expected + 1);
    // Sanity: at the frame rate this would be 61.
    expect(placed.length).toBeLessThan(20);
  });

  it('stays inside the server rate limit of twenty edits a second', () => {
    const { controller, placed } = rig(true);
    for (let ms = 0; ms < 1000; ms += 16) {
      controller.retarget();
      controller.update(16, false, true);
    }
    expect(placed.length).toBeLessThanOrEqual(20);
  });

  it('creative breaks instantly and repeats on the hold', () => {
    const { controller, broken, world } = rig(true);
    // ToyWorld's floor is one block thick, so digging straight down through it
    // would run out of targets after the first break and prove nothing about
    // the repeat. Sink a column under the crosshair: y = 20 down to 17 are the
    // four cells whose nearest face is inside REACH_BREAK from the eye at 23.5.
    for (let y = 12; y < 20; y++) world.set(0, y, 0, BlockId.STONE);
    controller.retarget();
    expect(controller.update(16, true, false)).toBe(1);
    expect(controller.digProgress).toBe(0);

    let frames = 0;
    for (let ms = 0; ms < 500; ms += 16) {
      controller.retarget();
      controller.update(16, true, false);
      frames++;
    }
    void frames;
    expect(broken.length).toBeGreaterThan(1);
    expect(broken.length).toBeLessThanOrEqual(2 + Math.ceil(500 / BREAK_REPEAT_MS));
  });

  it('survival digs on a timer scaled by hardness, and hopping the target resets it', () => {
    const { controller, broken } = rig(false);
    controller.retarget();
    // Stone is hardness 1.5; with the builder tool that is ~103 ms.
    expect(controller.target.breakMs).toBeGreaterThan(50);
    expect(controller.target.breakMs).toBeLessThan(200);

    controller.update(40, true, false);
    expect(controller.digProgress).toBeGreaterThan(0.2);
    expect(broken.length).toBe(0);

    // Look somewhere else: progress must not carry over.
    controller.aim.dirX = 1; controller.aim.dirY = -1;
    controller.retarget();
    expect(controller.digProgress).toBe(0);

    controller.aim.dirX = 0;
    controller.retarget();
    let guard = 0;
    while (broken.length === 0 && guard++ < 100) {
      controller.retarget();
      controller.update(16, true, false);
    }
    expect(broken.length).toBe(1);
    expect(guard).toBeLessThan(20);
  });

  it('never breaks and places on the same frame', () => {
    const { controller, placed, broken } = rig(true);
    controller.retarget();
    controller.update(16, true, true);
    expect(broken.length + placed.length).toBe(1);
    expect(placed.length).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Two defects that only a rendered frame could find, and their guards
 * ------------------------------------------------------------------------ */

describe('highlight contrast', () => {
  // BuildHighlight was first written with a fixed two-tone outline: a dark line
  // outside a light one. Rendering it in a real WebGL scene over a strip of
  // blocks running snow -> obsidian showed the flaw. `LineBasicMaterial`
  // ignores `linewidth` everywhere that matters, so both lines are one device
  // pixel and the 0.6% scale gap between them is sub-pixel past ~2 m — the two
  // tones collapse to one, and on snow that one was white on white.
  //
  // The fix swings the pair's opacities on the target's luminance. This test
  // guards the classifier, which is the part that can silently invert.
  it('sorts the palette into blocks that need a dark outline and blocks that need a light one', () => {
    const bright = [BlockId.SNOW, BlockId.BONE, BlockId.SAND, BlockId.ICE];
    const dark = [BlockId.OBSIDIAN, BlockId.TECH_PANEL, BlockId.HELLSTONE, BlockId.WOOD];
    // Assert on a name+verdict string rather than a bare number, so a failure
    // says "Bone wants light" instead of "expected 0.51 to be greater than
    // 0.52" and you know which block moved.
    const verdict = (id: number): string =>
      `${blockName(id)} wants ${colorLuminance(minimapColor(id)) > 0.52 ? 'dark' : 'light'}`;
    for (const id of bright) expect(verdict(id)).toBe(`${blockName(id)} wants dark`);
    for (const id of dark) expect(verdict(id)).toBe(`${blockName(id)} wants light`);
  });

  it('weights green over blue, so a green block counts as bright and a blue one does not', () => {
    // Averaging the channels instead would call both of these 0.33 and put the
    // outline the wrong way round on one of them.
    expect(colorLuminance(0x00ff00)).toBeGreaterThan(0.55);
    expect(colorLuminance(0x0000ff)).toBeLessThan(0.15);
    expect(colorLuminance(0x000000)).toBe(0);
    expect(colorLuminance(0xffffff)).toBe(1);
  });
});

describe('world swatches', () => {
  // The world browser's swatch column was five identical green squares,
  // because `builder.ts` stamped `minimapColor(GRASS)` onto every world. No
  // test could have caught that — "all rows the same colour" is not incorrect,
  // it is just useless — so it was found by rendering the list and looking.
  it('gives different worlds different colours, and the same world the same one every time', () => {
    const ids = ['w1', 'w2', 'cathedral', 'sky-fortress', 'tiny-test', 'hangar', 'abc', 'zzz'];
    const seen = new Set<number>();
    for (const id of ids) seen.add(worldSwatch(id, 1234));
    // Eight ids over a ten-colour table: collisions are expected, a single
    // bucket is the bug. Four distinct is comfortably past chance.
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect(worldSwatch('cathedral', 1234)).toBe(worldSwatch('cathedral', 1234));
    expect(worldSwatch('cathedral', 1234)).not.toBe(worldSwatch('cathedral', 9999));
    // Never black: the swatch is drawn on a near-black panel.
    for (const id of ids) expect(colorLuminance(worldSwatch(id, 7))).toBeGreaterThan(0.05);
  });
});
