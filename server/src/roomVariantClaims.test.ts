/**
 * DOOMCRAFT — V4c at the room: the claim, the profile key, and the mode column.
 *
 * `room.modes.test.ts` already proves the arsenal reaches the loadout. This
 * file is about the three things V4c adds between a stored profile and that
 * arsenal: the resolver runs at HELLO against a REDEEMED identity, a claim the
 * room's table cannot satisfy costs the player the variant and not the match,
 * and whether the row may wear one at all is a column on the trust table.
 *
 * The claim function is spelled EXACTLY as the production room factory spells
 * it — `variantSlotsFor(store.peek(conn.deviceId), room.variantTable)` — so
 * `store.peek`, the room's own ordering and the `+ 1` are all on the path.
 */

import { describe, expect, it } from 'vitest';

import { CAP_VARIANTS, GameMode, WEAPON_COUNT, WeaponId } from '@doomcraft/shared';
import { encodeHello } from '@doomcraft/shared/protocol';
import { PacketWriter } from '@doomcraft/shared/protocol';
import { parseVariantsManifest } from '@doomcraft/shared/variants';
import { MatchType } from '@doomcraft/shared/trust';

import { Room } from './room.js';
import { MemoryStore, createProfile, grantDrops } from './persistence.js';
import { variantSlotsFor } from './variantClaims.js';
import type { Connection } from './net.js';
import type { PlayerEntity } from './sim.js';

const SLUG = 'items@1:weapon_variant-shotgun-slug';
const KEY = 'redeemed-profile-key';

/** A one-row table: the shotgun slug, exactly as content/variants.json has it. */
function slugManifest() {
  const parsed = parseVariantsManifest(JSON.stringify({
    variants: [{
      id: 'shotgun-slug', base: WeaponId.SHOTGUN, name: 'Slug Shotgun',
      over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 },
    }],
  }));
  expect(parsed.errors).toEqual([]);
  return parsed.manifest;
}

/** A table this player's claim CANNOT be satisfied from. */
function otherManifest() {
  const parsed = parseVariantsManifest(JSON.stringify({
    variants: [{
      id: 'rocket-swift', base: WeaponId.ROCKET, name: 'Swift Rocket',
      over: { damage: 82, rpm: 104, splashRadius: 3.8, projectileSpeed: 66 },
    }],
  }));
  expect(parsed.errors).toEqual([]);
  return parsed.manifest;
}

async function ownerStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  const p = createProfile(KEY);
  grantDrops(p, [SLUG], 'trade', 'seed', 1);
  p.inventory.variants[String(WeaponId.SHOTGUN)] = SLUG;
  await store.save(p);
  // `peek` is the synchronous door onHello uses; the upgrade handler's await
  // is what fills it. Assert it is filled, or every test below is measuring
  // the miss path.
  expect(store.peek(KEY)).not.toBeNull();
  return store;
}

interface Built { room: Room; seen: string[] }

function build(
  store: MemoryStore,
  manifest: ReturnType<typeof slugManifest>,
  intent: MatchType = MatchType.PUBLIC,
): Built {
  const seen: string[] = [];
  // eslint-disable-next-line prefer-const
  let room: Room;
  room = new Room({
    seed: 4242,
    mode: GameMode.DEATHMATCH,
    botFill: 0,
    enemies: 0,
    eagerWorld: false,
    store: null,
    clock: () => 0,
    sessionIntent: intent,
    variants: manifest,
    variantClaims: (conn: Connection) => {
      seen.push(conn.deviceId);
      return variantSlotsFor(store.peek(conn.deviceId), room.variantTable);
    },
  });
  return { room, seen };
}

/**
 * A join shaped like the real one: `room.join()` FIRST, the redeemed profile
 * key assigned onto the connection SECOND, HELLO third. That is the order the
 * upgrade handler produces, and the resolver has to be safe in it.
 */
function joinRedeemed(room: Room, deviceId: string, caps = CAP_VARIANTS): PlayerEntity {
  const socket = { send: () => {}, close: () => {}, get bufferedAmount() { return 0; } };
  const conn = room.join(socket as never);
  expect(conn.deviceId, 'a fresh connection has no identity at all').toBe('');
  conn.deviceId = deviceId;
  const w = new PacketWriter(256);
  encodeHello(w, 'Marine', 0, caps);
  room.receive(conn, w.copy());
  const p = room.sim.getPlayer(conn.playerId);
  expect(p).toBeDefined();
  return p as PlayerEntity;
}

describe('the claim reaches the body at HELLO', () => {
  it('serves the slug to the owner — 62 x 1, not the base 11 x 7', async () => {
    const store = await ownerStore();
    const { room, seen } = build(store, slugManifest());
    const p = joinRedeemed(room, KEY);

    // The resolver ran with the REDEEMED key and not the pre-ticket ''. Both
    // are asserted, because seeing '' would resolve to the base and the
    // damage assertion below would then be about the wrong thing.
    expect(seen).toEqual([KEY]);

    const eff = room.sim.statsFor(p, WeaponId.SHOTGUN);
    expect(eff.damage, 'the base shotgun is 11 x 7').toBe(62);
    expect(eff.pellets).toBe(1);
    expect(eff.variantId).toBe('shotgun-slug');
    // The first magazine was filled through the same seam, one line earlier —
    // which is why the slot is resolved BEFORE addPlayer.
    expect(p.variantSlots[WeaponId.SHOTGUN]).toBe(1);
  });

  it('serves the BASE to a client that never declared CAP_VARIANTS', async () => {
    const store = await ownerStore();
    const { room } = build(store, slugManifest());
    const p = joinRedeemed(room, KEY, 0);
    expect(room.sim.statsFor(p, WeaponId.SHOTGUN).damage).toBe(11);
  });

  it('serves the BASE to a connection with no ticket, and still seats them', async () => {
    const store = await ownerStore();
    const { room, seen } = build(store, slugManifest());
    const p = joinRedeemed(room, '');
    expect(seen).toEqual(['']);
    expect(room.sim.statsFor(p, WeaponId.SHOTGUN).damage).toBe(11);
    expect(room.humanCount).toBe(1);
  });

  /*
   * RULE E, one level down: refusing the ROOM is worse than serving the base.
   * The player owns the slug and this room's release does not contain it.
   */
  it('starts the room and seats the player when the claim names a row this table lacks', async () => {
    const store = await ownerStore();
    const { room } = build(store, otherManifest());
    const p = joinRedeemed(room, KEY);
    expect(room.humanCount).toBe(1);
    expect(room.variantTable.map((e) => e.id)).toEqual(['rocket-swift']);
    expect(room.sim.statsFor(p, WeaponId.SHOTGUN).damage).toBe(11);
    expect(room.sim.statsFor(p, WeaponId.SHOTGUN).pellets).toBe(7);
    // The row that IS here is still available to anyone who owns it — the
    // room did not fall back to the compiled arsenal wholesale.
    expect(room.sim.arsenal.slotCount).toBe(2);
    expect(room.sim.arsenal.statsFor(WeaponId.ROCKET, 1).damage).toBe(82);
  });
});

describe('mode eligibility is a COLUMN, not an if (docs/VARIANTS.md 7.3)', () => {
  it('wears the variant in a casual row and the base in a ranked-adjacent one', async () => {
    const store = await ownerStore();

    const casual = build(store, slugManifest(), MatchType.PUBLIC);
    expect(room62(casual.room, store)).toBe(62);

    const ranked = build(store, slugManifest(), MatchType.RANKED);
    expect(room62(ranked.room, store)).toBe(11);

    // And the profile still holds the claim: a gated row does not clear it,
    // it just does not resolve it. The next casual match lights it back up.
    expect(store.peek(KEY)?.inventory.variants).toEqual({ 1: SLUG });
  });

  function room62(room: Room, _store: MemoryStore): number {
    const p = joinRedeemed(room, KEY);
    return room.sim.statsFor(p, WeaponId.SHOTGUN).damage;
  }
});

describe('the slot map the room SENDS matches the slots it resolved', () => {
  it('is WEAPON_COUNT bytes with the slug on the shotgun and zero elsewhere', async () => {
    const store = await ownerStore();
    const { room } = build(store, slugManifest());
    const p = joinRedeemed(room, KEY);
    expect(p.variantSlots).toHaveLength(WEAPON_COUNT);
    expect([...p.variantSlots]).toEqual(
      [...new Array<number>(WEAPON_COUNT)].map((_, i) => (i === WeaponId.SHOTGUN ? 1 : 0)),
    );
  });
});
