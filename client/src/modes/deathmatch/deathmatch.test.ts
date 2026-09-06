/**
 * DOOMCRAFT — Deathmatch, client-side unit tests.
 *
 * The authoritative half is covered in `server/src/deathmatch.test.ts` (instant
 * start, bot backfill, pickup claims). This file covers the two client pieces
 * that are pure logic and that a screenshot alone would not have caught:
 *
 *   - `ScoreRowBuffer`, which turns `NetClient.players` into board rows. That
 *     source is a FIXED array of MAX_PLAYERS slots with holes in it, and a
 *     board that renders the array instead of the occupied slots prints a wall
 *     of blank "DEAD" rows and buries the eight people actually playing. This
 *     was a real, shipped defect, found by looking at a 1440x900 capture of the
 *     Tab board, and the first test here is its regression.
 *   - `escapeHtml`, because killfeed rows are built with innerHTML and player
 *     names arrive over the wire.
 *
 * Both are DOM-free on purpose, so they run in vitest's default node
 * environment against exactly the code the browser loads.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  PS_BOT_BIT,
  PS_DEAD_BIT,
  ScoreRowBuffer,
  clockText,
  kdText,
  pingBars,
  pingText,
  scoreColour,
  type ScoreSource,
} from './scoreboard';
import {
  MULTI_KILL_NAMES,
  MULTI_KILL_WINDOW_MS,
  STREAK_MILESTONES,
  escapeHtml,
} from './killfeed';

/** One roster slot. Defaults to an EMPTY slot, which is the interesting case. */
function slot(over: Partial<ScoreSource> = {}): ScoreSource {
  return {
    id: 0, name: '', kills: 0, deaths: 0, state: 0, health: 100, active: false, ...over,
  };
}

/** A 32-slot roster with `n` occupied, mirroring `NetClient.players`. */
function roster(n: number, total = 32): ScoreSource[] {
  const out: ScoreSource[] = [];
  for (let i = 0; i < total; i++) {
    out.push(i < n
      ? slot({ id: i + 1, name: i === 0 ? 'Marine' : `BOT-${i}`, active: true,
        state: i === 0 ? 0 : PS_BOT_BIT })
      : slot());
  }
  return out;
}

describe('scoreboard rows', () => {
  it('renders the players, not the roster array', () => {
    const buf = new ScoreRowBuffer();
    const rows = buf.fill(roster(8), 1, 24);
    // Eight bodies in the match means eight rows. The other 24 slots are empty
    // seats, not dead players, and must never reach the board.
    expect(rows.length).toBe(8);
    for (const r of rows) {
      expect(r.id).toBeGreaterThan(0);
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  it('never emits a blank row even when a slot is occupied but unnamed', () => {
    const src = roster(4);
    // An occupied slot whose id has not landed yet: active, but not a player.
    src[9] = slot({ active: true, id: 0, name: '' });
    const rows = new ScoreRowBuffer().fill(src, 1, 20);
    expect(rows.length).toBe(4);
    expect(rows.some((r) => r.name === '')).toBe(false);
  });

  it('flags the local player and the bots correctly', () => {
    const rows = new ScoreRowBuffer().fill(roster(5), 1, 31);
    const me = rows.find((r) => r.id === 1);
    expect(me).toBeDefined();
    expect(me?.local).toBe(true);
    expect(me?.bot).toBe(false);
    expect(me?.ping).toBe(31);
    // A bot has no connection, so it carries no ping at all rather than a zero
    // that would render as a perfect four-bar score.
    expect(rows.filter((r) => r.bot).length).toBe(4);
    expect(rows.filter((r) => r.bot).every((r) => r.ping === 0)).toBe(true);
  });

  it('sorts by frags, then fewest deaths, then id — and holds still', () => {
    const src = roster(4);
    src[0].kills = 3; src[0].deaths = 5;   // id 1
    src[1].kills = 7; src[1].deaths = 2;   // id 2
    src[2].kills = 7; src[2].deaths = 1;   // id 3
    src[3].kills = 7; src[3].deaths = 1;   // id 4 — ties id 3 exactly
    const buf = new ScoreRowBuffer();
    const a = buf.fill(src, 1, 10).map((r) => r.id);
    expect(a).toEqual([3, 4, 2, 1]);
    // The id tiebreak is what stops the board reshuffling under a reader.
    const b = buf.fill(src, 1, 10).map((r) => r.id);
    expect(b).toEqual(a);
  });

  it('is allocation-stable: the pool is reused across fills', () => {
    const buf = new ScoreRowBuffer();
    const first = buf.fill(roster(8), 1, 10)[0];
    buf.fill(roster(8), 1, 10);
    // Same row objects, re-filled. Holding Tab for a match must not churn.
    expect(buf.rows[0]).toBe(first);
  });

  it('tracks streaks off the kill stream and wipes them on a new round', () => {
    const buf = new ScoreRowBuffer();
    buf.noteKill(2, 3, 4);
    expect(buf.fill(roster(4), 1, 10).find((r) => r.id === 2)?.streak).toBe(4);
    // Dying is the only thing that resets one.
    buf.noteKill(5, 2, 1);
    expect(buf.fill(roster(5), 1, 10).find((r) => r.id === 2)?.streak).toBe(0);
    buf.noteKill(2, 3, 6);
    buf.resetStreaks();
    expect(buf.fill(roster(4), 1, 10).find((r) => r.id === 2)?.streak).toBe(0);
  });

  it('reads a corpse from either the state bit or the health', () => {
    const src = roster(3);
    src[1].state |= PS_DEAD_BIT;
    src[2].health = 0;
    const rows = new ScoreRowBuffer().fill(src, 1, 10);
    expect(rows.find((r) => r.id === 2)?.dead).toBe(true);
    expect(rows.find((r) => r.id === 3)?.dead).toBe(true);
    expect(rows.find((r) => r.id === 1)?.dead).toBe(false);
  });

  it('finds a row by id, and refuses one that is not on the board', () => {
    const buf = new ScoreRowBuffer();
    buf.fill(roster(4), 1, 10);
    expect(buf.find(3)?.id).toBe(3);
    expect(buf.find(99)).toBeNull();
  });

  it('survives an entirely empty roster', () => {
    expect(new ScoreRowBuffer().fill(roster(0), 1, 10).length).toBe(0);
  });
});

describe('scoreboard formatting', () => {
  it('clamps and pads the clock', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(-5)).toBe('0:00');
    expect(clockText(9)).toBe('0:09');
    expect(clockText(477)).toBe('7:57');
    expect(clockText(3600)).toBe('60:00');
  });

  it('prints a K/D that never divides by zero', () => {
    expect(kdText(0, 0)).toBe('—');
    expect(kdText(3, 0)).toBe('3.0');
    expect(kdText(3, 2)).toBe('1.5');
  });

  it('gives an unmeasured ping no bars rather than four', () => {
    expect(pingBars(0)).toBe(-1);
    expect(pingText(0)).toBe('—');
    expect(pingBars(20)).toBe(4);
    expect(pingBars(300)).toBe(0);
    expect(pingText(28.4)).toBe('28ms');
  });

  it('hands out a stable colour for every slot index', () => {
    for (let i = -3; i < 20; i++) expect(scoreColour(i)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(scoreColour(1)).toBe(scoreColour(9));
  });
});

describe('killfeed text safety', () => {
  it('escapes a name that would otherwise be markup', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>'))
      .toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml('plain')).toBe('plain');
  });

  it('keeps the callout tables in the order the code indexes them', () => {
    expect(MULTI_KILL_NAMES[0]).toBe('DOUBLE KILL');
    expect(MULTI_KILL_WINDOW_MS).toBe(3000);
    for (let i = 1; i < STREAK_MILESTONES.length; i++) {
      expect(STREAK_MILESTONES[i - 1][0]).toBeGreaterThan(STREAK_MILESTONES[i][0]);
    }
  });
});


/* ------------------------------------------------------------------------ *
 * V4d — the display path is WIRED, not merely written
 *
 * `variantWeaponName` is a pure function on `NetClient` and both renderers
 * reach it through an injected callback, so nothing in this repo's type
 * system or test suite notices if a call site is deleted: the feed goes back
 * to saying "Shotgun" and every other test stays green. That is rule 1's
 * exact shape, so the three touch points are asserted as SOURCE — the same
 * thing `client/src/ui/wiring.test.ts` does for the profile overlay.
 *
 * There is no jsdom in this repo, so a `Killfeed.push` DOM test would mean
 * hand-building `innerHTML`, `classList` and `setAttribute`; these three lines
 * are what that test would be checking and they cost nothing to keep true.
 * ------------------------------------------------------------------------ */

describe('the killfeed is wired to the room\'s variant names', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));

  function src(file: string): string {
    return readFileSync(path.join(HERE, file), 'utf8');
  }

  it('the feed row asks its injected label for the gun the SHOT was fired with', () => {
    const s = src('killfeed.ts');
    expect(s).toContain('this.opts.weaponLabel?.(e.weaponId, e.variantSlot)');
    // And the fallback is still the archetype, never a blank.
    expect(s).toContain('?? weaponName(e.weaponId)');
  });

  it('deathmatch supplies that label from the net client, not from a compiled '
    + 'or live table', () => {
    const s = src('deathmatch.ts');
    expect(s).toContain(
      'weaponLabel: (weaponId, slot) => this.host.game.net.variantWeaponName(weaponId, slot)',
    );
    // The death screen names the same gun the feed does.
    expect(s).toContain('this.lastKillerVariant = e.variantSlot;');
    expect(s).toContain(
      'this.host.game.net.variantWeaponName(this.lastKillerWeapon, this.lastKillerVariant)',
    );
  });

  it('the base HUD feed names it too, and no longer reads the compiled table', () => {
    const s = readFileSync(
      path.join(HERE, '..', '..', 'game', 'game.ts'), 'utf8',
    );
    const onKill = s.slice(s.indexOf('private onKill(e: KillEvent)'));
    const body = onKill.slice(0, onKill.indexOf('\n  }\n'));
    expect(body).toContain('this.net.variantWeaponName(e.weaponId, e.variantSlot)');
    expect(body, 'the compiled name would ignore the variant entirely')
      .not.toContain('getWeapon(e.weaponId).name');
  });
});
