/**
 * DOOMCRAFT — V4d on the server: the slot a kill reports is the slot the SHOT
 * WAS FIRED WITH, and the pool never lends it to the next kill.
 *
 * Two things this file is about, and both of them are ways to name a gun
 * nobody fired:
 *
 *   1. `Simulation.killEvents` is a POOL of 32 objects built once at
 *      construction and handed out again every tick (`clearEvents` only resets
 *      the counter). There are TWO producers — `killPlayer` and
 *      `damageEntity` — and a field either of them skips keeps the value the
 *      PREVIOUS occupant left in it.
 *   2. Shot identity PROPAGATES from the firing path. By the time a kill
 *      resolves the killer may be holding something else — a rocket has
 *      `projectileLifeMs` 4000 to be in the air across a switch, and a melee
 *      punch fires as `tryFire(p, CHAINSAW)` while the player holds a
 *      shotgun. Nothing may look an equipped slot up at kill time.
 *
 * Everything below reads the slot off the KILL PACKET the socket received, not
 * off a simulation field, so the encoder and the ninth byte are on the path.
 */

import { describe, expect, it } from 'vitest';

import {
  BlockId,
  CAP_VARIANTS,
  EntityType,
  GameMode,
  type KillEvent,
  PacketReader,
  PacketWriter,
  S2C,
  WeaponId,
  WEAPON_COUNT,
  createKillEvent,
  decodeKill,
  encodeHello,
} from '@doomcraft/shared';
import { parseVariantsManifest } from '@doomcraft/shared/variants';

import { Room } from './room.js';
import type { NetTransport } from './net.js';
import type { PlayerEntity } from './sim.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

class Sock implements NetTransport {
  readonly packets: Uint8Array[] = [];
  get isOpen(): boolean { return true; }
  get bufferedAmount(): number { return 0; }
  send(data: Uint8Array): void {
    if (data.length > 0 && data[0] === S2C.CHUNK) return;
    if (this.packets.length < 4096) this.packets.push(data.slice());
  }
  close(): void { /* nothing */ }
}

/** Slug shotgun in row 0 (slot 1), swift rocket in row 1 (slot 2). */
function manifest(): NonNullable<ReturnType<typeof parseVariantsManifest>['manifest']> {
  const parsed = parseVariantsManifest(JSON.stringify({
    variants: [
      {
        id: 'shotgun-slug', base: WeaponId.SHOTGUN, name: 'Slug Shotgun',
        over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 },
      },
      {
        id: 'rocket-swift', base: WeaponId.ROCKET, name: 'Swift Rocket',
        over: { damage: 82, rpm: 104, splashRadius: 3.8, projectileSpeed: 66 },
      },
    ],
  }));
  expect(parsed.errors).toEqual([]);
  expect(parsed.manifest).not.toBeNull();
  return parsed.manifest as NonNullable<typeof parsed.manifest>;
}

/** The slot map a real `variantClaims` would resolve: the slug and the swift. */
function claims(): Uint8Array {
  const s = new Uint8Array(WEAPON_COUNT);
  s[WeaponId.SHOTGUN] = 1;
  s[WeaponId.ROCKET] = 2;
  return s;
}

interface Fixture { room: Room; sock: Sock; p: PlayerEntity }

function build(): Fixture {
  const room = new Room({
    seed: 4242,
    mode: GameMode.SANDBOX,
    botFill: 0,
    enemies: 0,
    eagerWorld: false,
    store: null,
    clock: () => 0,
    variants: manifest(),
    variantClaims: () => claims(),
  });
  const sock = new Sock();
  const conn = room.join(sock);
  const w = new PacketWriter(256);
  encodeHello(w, 'Marine', 0, CAP_VARIANTS);
  room.receive(conn, w.copy());
  const p = room.sim.getPlayer(conn.playerId);
  expect(p, 'the shooter must be seated').toBeDefined();
  const player = p as PlayerEntity;
  // The claim really reached the body, or every assertion below is about the
  // base arsenal wearing a variant's name.
  expect(player.variantSlots[WeaponId.SHOTGUN]).toBe(1);
  expect(player.variantSlots[WeaponId.ROCKET]).toBe(2);
  expect(room.sim.statsFor(player, WeaponId.SHOTGUN).variantId).toBe('shotgun-slug');
  return { room, sock, p: player };
}

/**
 * A level, dry spot with eight blocks of head-room AND a clear four-metre lane
 * along -x, so a shot fired UPWARD or WESTWARD hits what it is aimed at.
 *
 * The arena is a Doom level, not a plain: it carries cover, and a hitscan test
 * that only checks its own column fires into a wall and asserts nothing. The
 * lane is checked at every height the shooter's eye and the victim's body
 * occupy, not just at the feet.
 */
function findOpenSpot(room: Room): { x: number; y: number; z: number } {
  const world = room.world;
  for (let z = -40; z <= 40; z += 2) {
    for (let x = -40; x <= 40; x += 2) {
      const y = world.standableY(x, z);
      if (y < 1) continue;
      const h = world.surfaceY(x, z);
      if (world.getBlock(x, h, z) === BlockId.LAVA) continue;
      if (world.getBlock(x, h, z) === BlockId.WATER) continue;
      let clear = true;
      for (let dy = 1; dy <= 8 && clear; dy++) {
        if (world.getBlock(x, h + dy, z) !== BlockId.AIR) clear = false;
      }
      for (let dx = 1; dx <= 4 && clear; dx++) {
        if (world.standableY(x - dx, z) !== y) { clear = false; break; }
        for (let dy = 1; dy <= 3; dy++) {
          if (world.getBlock(x - dx, h + dy, z) !== BlockId.AIR) { clear = false; break; }
        }
      }
      if (clear) return { x: x + 0.5, y, z: z + 0.5 };
    }
  }
  throw new Error('the arena should contain one open standable lane');
}

function placeAt(p: PlayerEntity, at: { x: number; y: number; z: number }): void {
  p.pos[0] = at.x; p.pos[1] = at.y; p.pos[2] = at.z;
  p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
  p.onGround = true;
  p.spawnProtectUntilMs = 0;
  p.nextFireMs = 0;
  p.weaponMask = 0xff;
}

/** Every KILL packet this socket has been sent, decoded. */
function kills(sock: Sock): KillEvent[] {
  return sock.packets
    .filter((pk) => pk[0] === S2C.KILL)
    .map((pk) => decodeKill(new PacketReader(pk), createKillEvent()));
}

/* ------------------------------------------------------------------------ *
 * 1. The pool
 * ------------------------------------------------------------------------ */

describe('the kill-event pool never lends a slot to the next kill', () => {
  /*
   * TWO KILLS, DIFFERENT SLOTS, THE SAME POOLED OBJECT. `clearEvents` resets
   * `killCount` and nothing else, so kill two lands in the object kill one
   * used. The second kill is by the BASE pistol, which is the case that
   * corrupts: a producer that writes the slot only when there IS one leaves
   * the slug's 1 sitting in the field and the feed calls a pistol kill a
   * shotgun variant.
   */
  it('a slug kill then a base-pistol kill report 1 and then 0', () => {
    const f = build();
    const spot = findOpenSpot(f.room);
    for (let i = 0; i < 20; i++) f.room.step();
    placeAt(f.p, spot);

    const pooled = f.room.sim.killEvents[0];

    // Straight up, at a demon hovering three metres overhead. Nothing else is
    // on the ray, and a slug is 62 damage against 20 health.
    f.p.pitch = Math.PI / 2;
    f.p.yaw = 0;
    const demon1 = f.room.sim.spawnEntity(
      EntityType.IMP, spot.x, spot.y + 3, spot.z, 20, 0.5, 1.7, true,
    );
    expect(demon1).toBeGreaterThanOrEqual(0);
    f.p.weapon = WeaponId.SHOTGUN;
    f.p.mag[WeaponId.SHOTGUN] = 8;
    expect(f.room.sim.tryFire(f.p, WeaponId.SHOTGUN)).toBe(true);
    expect(f.room.sim.killCount, 'the slug must actually have killed it').toBe(1);
    expect(f.room.sim.killEvents[0]).toBe(pooled);
    f.room.step();

    placeAt(f.p, spot);
    f.p.pitch = Math.PI / 2;
    const demon2 = f.room.sim.spawnEntity(
      EntityType.IMP, spot.x, spot.y + 3, spot.z, 8, 0.5, 1.7, true,
    );
    expect(demon2).toBeGreaterThanOrEqual(0);
    f.p.weapon = WeaponId.PISTOL;
    f.p.mag[WeaponId.PISTOL] = 12;
    expect(f.room.sim.tryFire(f.p, WeaponId.PISTOL)).toBe(true);
    expect(f.room.sim.killCount, 'the pistol must actually have killed it').toBe(1);
    expect(
      f.room.sim.killEvents[0],
      'the second kill has to REUSE the first kill\'s object or this proves nothing',
    ).toBe(pooled);
    f.room.step();

    const seen = kills(f.sock).filter((e) => e.victimId === 0);
    expect(seen).toHaveLength(2);
    expect(seen[0].weaponId).toBe(WeaponId.SHOTGUN);
    expect(seen[0].variantSlot).toBe(1);
    expect(seen[1].weaponId).toBe(WeaponId.PISTOL);
    expect(seen[1].variantSlot, 'the base pistol is slot 0, not the slug\'s 1').toBe(0);

    f.room.stop();
  });

  /*
   * THE OTHER PRODUCER. `killPlayer` and `damageEntity` write into the same
   * pool from two different places, so a fix applied to one of them leaves the
   * other lending its predecessor's slot. This walks a PLAYER kill through the
   * object a DEMON kill just used.
   */
  it('a player kill after a demon kill reports its own slot, not the demon\'s', () => {
    const f = build();
    const spot = findOpenSpot(f.room);
    for (let i = 0; i < 20; i++) f.room.step();
    placeAt(f.p, spot);

    // A demon killed by the SLUG fills pool slot 0 with a 1.
    f.p.pitch = Math.PI / 2;
    f.p.yaw = 0;
    expect(f.room.sim.spawnEntity(
      EntityType.IMP, spot.x, spot.y + 3, spot.z, 20, 0.5, 1.7, true,
    )).toBeGreaterThanOrEqual(0);
    f.p.weapon = WeaponId.SHOTGUN;
    f.p.mag[WeaponId.SHOTGUN] = 8;
    expect(f.room.sim.tryFire(f.p, WeaponId.SHOTGUN)).toBe(true);
    expect(f.room.sim.killEvents[0].variantSlot).toBe(1);
    f.room.step();

    // Now a PLAYER, killed by the base chainsaw. Different producer, same
    // pooled object.
    const victim = f.room.sim.addPlayer(4242, 'Target', 0, true);
    expect(victim).toBeDefined();
    const v = victim as PlayerEntity;
    placeAt(f.p, spot);
    v.pos[0] = spot.x + 1.0; v.pos[1] = spot.y; v.pos[2] = spot.z;
    v.health = 5;
    v.spawnProtectUntilMs = 0;
    f.p.pitch = 0;
    f.p.yaw = Math.PI / 2;                     // forward = (-sin, 0, -cos) = (-1, 0, 0)
    v.pos[0] = spot.x - 1.0;
    f.p.weapon = WeaponId.CHAINSAW;
    expect(f.room.sim.tryFire(f.p, WeaponId.CHAINSAW)).toBe(true);
    expect(v.dead, 'the saw must actually have killed them').toBe(true);
    expect(f.room.sim.killEvents[0].variantSlot, 'the base chainsaw is slot 0').toBe(0);
    f.room.step();

    const seen = kills(f.sock);
    const onPlayer = seen.filter((e) => e.victimId === v.id);
    expect(onPlayer).toHaveLength(1);
    expect(onPlayer[0].weaponId).toBe(WeaponId.CHAINSAW);
    expect(onPlayer[0].variantSlot).toBe(0);

    f.room.stop();
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Shot identity propagates
 * ------------------------------------------------------------------------ */

describe('the slot a kill reports is the slot the SHOT was fired with', () => {
  /*
   * The rocket case, and it is the one `projVariant` was built for: fire, put
   * the launcher away, and let the round land. A kill-time read of the
   * killer's equipped slot answers about the CHAINSAW — slot 0 — while the
   * thing that killed was a swift rocket in slot 2.
   */
  it('a rocket that lands after a weapon switch still names its own slot', () => {
    const f = build();
    const spot = findOpenSpot(f.room);
    for (let i = 0; i < 20; i++) f.room.step();
    placeAt(f.p, spot);

    const demon = f.room.sim.spawnEntity(
      EntityType.IMP, spot.x + 1.2, spot.y, spot.z, 20, 0.4, 1.7, false,
    );
    expect(demon).toBeGreaterThanOrEqual(0);

    f.p.weapon = WeaponId.ROCKET;
    f.p.mag[WeaponId.ROCKET] = 5;
    f.p.pitch = -Math.PI / 2;                  // straight down, at his own feet
    expect(f.room.sim.tryFire(f.p, WeaponId.ROCKET)).toBe(true);

    // The switch, while the round is in the air. This line is the test.
    f.p.weapon = WeaponId.CHAINSAW;
    expect(f.p.variantSlots[WeaponId.CHAINSAW], 'the gun he is now holding is on the base')
      .toBe(0);

    for (let i = 0; i < 20; i++) f.room.step();
    expect(f.p.weapon).toBe(WeaponId.CHAINSAW);
    expect(f.p.kills, 'the rocket has to have actually killed the demon').toBe(1);

    const seen = kills(f.sock).filter((e) => e.victimId === 0);
    expect(seen).toHaveLength(1);
    expect(seen[0].weaponId).toBe(WeaponId.ROCKET);
    expect(seen[0].variantSlot, 'the swift rocket is slot 2, the held chainsaw is 0')
      .toBe(2);

    f.room.stop();
  });

  /*
   * The SYNCHRONOUS version of the same mistake, and the reason "hitscan is
   * unaffected" is false: a melee punch fires as `tryFire(p, CHAINSAW)` while
   * the player is still HOLDING the slug shotgun. A kill-time read of
   * `variantSlots[p.weapon]` answers 1 and the feed calls a saw kill a Slug
   * Shotgun — with no switch anywhere and nothing in flight.
   */
  it('a chainsaw punch thrown while HOLDING the slug reports the saw\'s slot', () => {
    const f = build();
    const spot = findOpenSpot(f.room);
    for (let i = 0; i < 20; i++) f.room.step();
    placeAt(f.p, spot);

    const victim = f.room.sim.addPlayer(4243, 'Target', 0, true);
    const v = victim as PlayerEntity;
    v.pos[0] = spot.x - 1.0; v.pos[1] = spot.y; v.pos[2] = spot.z;
    v.health = 5;
    v.spawnProtectUntilMs = 0;

    f.p.weapon = WeaponId.SHOTGUN;             // still held, and still slot 1
    f.p.pitch = 0;
    f.p.yaw = Math.PI / 2;
    expect(f.p.variantSlots[f.p.weapon]).toBe(1);
    expect(f.room.sim.tryFire(f.p, WeaponId.CHAINSAW)).toBe(true);
    expect(v.dead).toBe(true);
    f.room.step();

    const onPlayer = kills(f.sock).filter((e) => e.victimId === v.id);
    expect(onPlayer).toHaveLength(1);
    expect(onPlayer[0].weaponId).toBe(WeaponId.CHAINSAW);
    expect(
      onPlayer[0].variantSlot,
      'the punch is a chainsaw shot; the shotgun he is holding is irrelevant to it',
    ).toBe(0);

    f.room.stop();
  });

  /* And the positive: a hitscan slug kill on a PLAYER carries slot 1. */
  it('a slug shotgun kill on a player carries the slug\'s slot', () => {
    const f = build();
    const spot = findOpenSpot(f.room);
    for (let i = 0; i < 20; i++) f.room.step();
    placeAt(f.p, spot);

    const victim = f.room.sim.addPlayer(4244, 'Target', 0, true);
    const v = victim as PlayerEntity;
    v.pos[0] = spot.x - 1.5; v.pos[1] = spot.y; v.pos[2] = spot.z;
    v.health = 40;
    v.spawnProtectUntilMs = 0;

    f.p.weapon = WeaponId.SHOTGUN;
    f.p.mag[WeaponId.SHOTGUN] = 8;
    f.p.pitch = 0;
    f.p.yaw = Math.PI / 2;
    expect(f.room.sim.tryFire(f.p, WeaponId.SHOTGUN)).toBe(true);
    expect(v.dead, 'a 62-damage slug against 40 health').toBe(true);
    f.room.step();

    const onPlayer = kills(f.sock).filter((e) => e.victimId === v.id);
    expect(onPlayer).toHaveLength(1);
    expect(onPlayer[0].weaponId).toBe(WeaponId.SHOTGUN);
    expect(onPlayer[0].variantSlot).toBe(1);

    f.room.stop();
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The room tells its clients what those rows are CALLED
 * ------------------------------------------------------------------------ */

describe('the room publishes its names in its own row order', () => {
  it('aligns the names with the entries, not with the manifest', () => {
    const f = build();
    expect(f.room.variantTable.map((e) => e.id))
      .toEqual(['shotgun-slug', 'rocket-swift']);
    expect(f.room.variantNameTable)
      .toEqual([
        { id: 'shotgun-slug', name: 'Slug Shotgun' },
        { id: 'rocket-swift', name: 'Swift Rocket' },
      ]);
    f.room.stop();
  });

  it('sends VARIANT_NAMES right after VARIANT_TABLE, and only to a client that '
    + 'declared CAP_VARIANTS', () => {
    const f = build();
    const ids = f.sock.packets.map((p) => p[0]);
    const table = ids.indexOf(S2C.VARIANT_TABLE);
    const names = ids.indexOf(S2C.VARIANT_NAMES);
    expect(table).toBeGreaterThanOrEqual(0);
    expect(names).toBe(table + 1);

    // A bundle that predates variants has had every claim resolved to the base
    // and would have nothing to name.
    const old = new Sock();
    const conn = f.room.join(old);
    const w = new PacketWriter(256);
    encodeHello(w, 'Old', 0, 0);
    f.room.receive(conn, w.copy());
    expect(old.packets.map((p) => p[0])).not.toContain(S2C.VARIANT_NAMES);
    expect(old.packets.map((p) => p[0])).not.toContain(S2C.VARIANT_TABLE);

    f.room.stop();
  });

  it('a room with no variants sends neither message', () => {
    const room = new Room({
      seed: 99, mode: GameMode.SANDBOX, botFill: 0, enemies: 0,
      eagerWorld: false, store: null, clock: () => 0,
    });
    const sock = new Sock();
    const conn = room.join(sock);
    const w = new PacketWriter(256);
    encodeHello(w, 'Marine', 0, CAP_VARIANTS);
    room.receive(conn, w.copy());
    expect(room.variantNameTable).toEqual([]);
    expect(sock.packets.map((p) => p[0])).not.toContain(S2C.VARIANT_NAMES);
    room.stop();
  });
});
