/**
 * DOOMCRAFT — the three tables that describe how big a monster is must agree.
 *
 * There are three, and none of them imports the others:
 *
 *   1. `server/src/bots.ts` MONSTERS — the SIM. `entHeight` is the hitscan
 *      AABB and the line-of-sight centre, so this is what a shot actually hits.
 *   2. `client/src/game/game.ts` MONSTER_LOOK — the CLIENT's hit target, which
 *      decides whether a hitmarker appears.
 *   3. `shared/src/characters.ts` LOOK_* — the RENDER, which is the only one
 *      of the three the player can see.
 *
 * Measured before this file existed: four of the five agreed exactly and the
 * LOST SOUL did not — sim 0.9, client 0.7, render 0.7. A shot at 0.8 m landed
 * on the server, produced no client marker, and hit nothing the player could
 * see. A hit with no visible cause reads as the game lying, and the sim was the
 * odd one out, so the sim moved: the hitbox follows the body, because a player
 * can only aim at what is drawn.
 *
 * WHY THIS IS A SOURCE SCAN. `MONSTER_LOOK` is module-private in a client file
 * that this test has no business importing — pulling `game.ts` in would drag
 * the renderer into a server test. The alternative is exporting an internal
 * purely so a test can read it, which makes the module worse to serve the test.
 * These are frozen constant tables with no behaviour to drive, so reading the
 * literals is reading the whole truth; `shared/src/trust.test.ts` scans the
 * tree on the same reasoning. If `MONSTER_LOOK` ever stops being a literal
 * table, the parse below finds nothing and the count assertion fails loudly
 * rather than silently passing on an empty set — which is the failure mode a
 * scan has to be built against.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lookForEntity } from '@doomcraft/shared/characters';
import { EntityType } from '@doomcraft/shared/protocol';

import { MONSTERS } from './bots.js';

const here = dirname(fileURLToPath(import.meta.url));
const GAME_TS = join(here, '..', '..', 'client', 'src', 'game', 'game.ts');

/** `MONSTER_LOOK`'s halfW/height, read out of the client source. */
function clientHitTable(): Map<string, { halfW: number; height: number }> {
  const src = readFileSync(GAME_TS, 'utf8');
  const start = src.indexOf('const MONSTER_LOOK');
  expect(start, 'MONSTER_LOOK is gone from game.ts — this scan is reading nothing').toBeGreaterThan(0);
  const block = src.slice(start, src.indexOf('const PICKUP_COLOR', start));
  const out = new Map<string, { halfW: number; height: number }>();
  for (const m of block.matchAll(/\[EntityType\.(\w+)\]:\s*\{\s*halfW:\s*([\d.]+),\s*height:\s*([\d.]+)/g)) {
    out.set(m[1], { halfW: Number(m[2]), height: Number(m[3]) });
  }
  return out;
}

const TYPE_NAME: Record<number, string> = {
  [EntityType.IMP]: 'IMP',
  [EntityType.ZOMBIE]: 'ZOMBIE',
  [EntityType.CACODEMON]: 'CACODEMON',
  [EntityType.BARON]: 'BARON',
  [EntityType.LOST_SOUL]: 'LOST_SOUL',
};

describe('the sim, the client hit target and the render agree on every monster', () => {
  it('parses a client table with an entry for every monster the server spawns', () => {
    /* The scan's own guard. A regex that matches nothing makes every
     * comparison below vacuously true, which is the exact failure this project
     * keeps finding — so the fixture is asserted before it is used. */
    const client = clientHitTable();
    expect(client.size).toBe(MONSTERS.length);
    for (const arch of MONSTERS) {
      expect(client.has(TYPE_NAME[arch.type]), `no client entry for ${TYPE_NAME[arch.type]}`).toBe(true);
    }
  });

  it('agrees on HEIGHT, which is the hitbox, the hitmarker and the body at once', () => {
    /* The defective implementation is the one that shipped: LOST_SOUL at 0.9
     * in the sim against 0.7 in the other two. */
    const client = clientHitTable();
    for (const arch of MONSTERS) {
      const name = TYPE_NAME[arch.type];
      const look = lookForEntity(arch.type);
      expect(look, `${name} has no render look`).not.toBeNull();
      expect(client.get(name)!.height, `${name}: sim ${arch.height} vs client hit target`)
        .toBe(arch.height);
      expect(look!.height, `${name}: sim ${arch.height} vs render look`).toBe(arch.height);
    }
  });

  it('agrees on HALF-WIDTH between the sim and the client hit target', () => {
    /* The render look carries no width — it is built from parts — so this pair
     * is the whole comparison there is for the horizontal axis. All five
     * already agreed; this pins them. */
    const client = clientHitTable();
    for (const arch of MONSTERS) {
      const name = TYPE_NAME[arch.type];
      expect(client.get(name)!.halfW, `${name}: sim halfW`).toBe(arch.halfW);
    }
  });
});
