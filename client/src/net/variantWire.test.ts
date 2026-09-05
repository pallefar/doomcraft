/**
 * DOOMCRAFT — V3: the room's variant table, end to end, through the real wire.
 *
 * WHY THIS FILE EXISTS AND THE UNIT TESTS DO NOT COVER IT.
 *
 * The codec tests in `shared/src/variants.test.ts` build two arsenals from the
 * same bytes and prove they agree. The server tests prove a connection without
 * `CAP_VARIANTS` is resolved to the base. Every one of them passes with
 * `case S2C.VARIANT_TABLE:` deleted from `client/src/net/client.ts` — the
 * message is encoded, sent, and dropped on the floor, and a player fires eight
 * shells at 11 damage while the server resolves four at 10.
 *
 * That is the wiring failure rule 2 keeps catching one level up (HANDOVER
 * rules 2, 21, 26), so this test takes the whole path: a REAL `Room` with a
 * REAL parsed manifest, a REAL `NetClient` over a pumped link, the real
 * dispatch, and a real `WeaponRuntime` adopting what arrives — and then
 * compares the effective weapon the CLIENT will fire with against the one the
 * SERVER will resolve, field for field.
 */
import { describe, expect, it } from 'vitest';
import { ALL_WEAPON_MASK, PacketReader, S2C, WEAPON_COUNT, WEAPONS, WeaponId, readMessageId } from '@shared';
import {
  bandEdgesFor, createVariantTableMessage, decodeVariantTable, parseVariantsManifest,
  type VariantsManifest,
} from '@shared/variants';
import { Room } from '@doomcraft/server/src/room.js';
import type { NetTransport } from '@doomcraft/server/src/net.js';
import { NetClient } from './client.js';
import type { ClientTransport } from './transport.js';
import { WeaponRuntime } from '../game/weapons.js';

/**
 * Four shells instead of eight, ten damage instead of eleven. Both fields move
 * so the test cannot pass by accident on a magazine that happened to match,
 * and `magSize: 4` ALONE is refused by the schema's strict-dominance rule (a
 * smaller magazine with everything else intact scores handling ×1.167 and
 * nothing worse), so the damage cut is load-bearing, not decoration.
 */
const MANIFEST = parseVariantsManifest(JSON.stringify({
  variants: [
    { id: 'four-shell', base: WeaponId.SHOTGUN, name: 'Four Shell', over: { magSize: 4, damage: 10 } },
  ],
}));

class Link {
  open = true;
  conn;
  client: ClientTransport;
  readonly sent: Uint8Array[] = [];
  constructor(readonly room: Room) {
    const self = this;
    const serverSide: NetTransport = {
      get isOpen(): boolean { return self.open; },
      get bufferedAmount(): number { return 0; },
      close(): void { self.open = false; },
      send(data: Uint8Array): void {
        if (!self.open) return;
        self.sent.push(data.slice());
        self.client.onmessage?.(data.slice());
      },
    };
    this.conn = room.join(serverSide);
    this.client = {
      get readyState(): number { return self.open ? 1 : 3; },
      send(data: Uint8Array): void { if (self.open) self.room.receive(self.conn, data.slice()); },
      close(): void { self.open = false; },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
  }
}

function roomWithVariants(): Room {
  expect(MANIFEST.errors).toEqual([]);
  const claims = new Uint8Array(WEAPON_COUNT);
  claims[WeaponId.SHOTGUN] = 1;
  return new Room({
    seed: 4242, botFill: 0, enemies: 0, eagerWorld: false, store: null,
    clock: () => 0, name: 'variants',
    // The shotgun has to be IN HAND for a magazine to mean anything: the
    // starting mask is pistol + chainsaw, and an unowned weapon's magazine is
    // zero on both sides for a reason that has nothing to do with variants.
    allWeapons: true,
    variants: MANIFEST.manifest,
    variantClaims: () => claims,
  });
}

describe('a room tells its clients which table it pinned', () => {
  it('a real client adopts it and predicts the variant, not the archetype', () => {
    const room = roomWithVariants();
    try {
      const link = new Link(room);
      const rt = new WeaponRuntime();
      let nowMs = 0;
      const net = new NetClient({
        name: 'Marine', transport: link.client as never, autoReconnect: false,
        keepalive: null, wallClock: () => nowMs,
        // Exactly the line game.ts has. If it is removed, this test fails and
        // no other one does.
        events: { onVariantTable: (arsenal, slots) => { rt.adoptArsenal(arsenal, slots); } },
      });
      // A session begins on the compiled table and is told otherwise.
      rt.beginSession();
      rt.resetLoadout(ALL_WEAPON_MASK);
      expect(rt.stats(WeaponId.SHOTGUN).variantId).toBe('');

      net.connect();
      for (let i = 0; i < 20; i++) { nowMs += 1000 / 60; room.advance(nowMs); net.update(1 / 60); }

      // 1. The message actually went out, once.
      expect(link.sent.filter((m) => readMessageId(m) === S2C.VARIANT_TABLE)).toHaveLength(1);

      // 2. The client adopted it.
      expect(net.variantsAdopted).toBe(true);
      expect([...rt.variantSlots]).toEqual([0, 1, 0, 0, 0, 0, 0]);

      // 3. The client's stats for the shotgun ARE the server's, field for
      //    field — the doubles the falloff and detonation paths read and the
      //    narrowed `hot` reads the damage and fire-rate paths read.
      const player = room.sim.players.find((p) => !p.isBot);
      expect(player, 'no human body').toBeDefined();
      const server = room.sim.statsFor(player!, WeaponId.SHOTGUN);
      const client = rt.stats(WeaponId.SHOTGUN);
      expect(client.variantId).toBe('four-shell');
      expect(server.variantId).toBe('four-shell');
      for (const k of Object.keys(server) as (keyof typeof server)[]) {
        if (k === 'hot') continue;
        expect(Object.is(server[k], client[k]), `field ${String(k)}`).toBe(true);
      }
      for (const k of Object.keys(server.hot) as (keyof typeof server.hot)[]) {
        expect(Object.is(server.hot[k], client.hot[k]), `hot.${String(k)}`).toBe(true);
      }
      expect(client.damage).toBe(10);
      expect(client.magSize).toBe(4);

      // 4. The FIRST MAGAZINE, on both sides. `spawnPlayer` fills the server's
      //    through `statsFor` and `adoptArsenal` re-derives the client's; a
      //    client that adopted the table and kept its magazines would hold the
      //    archetype's eight shells of a gun that only carries four.
      expect(player!.mag[WeaponId.SHOTGUN]).toBe(4);
      expect(rt.mag[WeaponId.SHOTGUN]).toBe(4);
    } finally { room.stop(); }
  });

  it('a client that never hears the message keeps the compiled table', () => {
    // The reverse-version case: this bundle understands opcode 13, but the
    // room it just joined has no variants to send. Nothing may be adopted, and
    // nothing may be left over from the last room either.
    const room = new Room({
      seed: 4242, botFill: 0, enemies: 0, eagerWorld: false, store: null,
      clock: () => 0, name: 'plain', allWeapons: true,
    });
    try {
      const link = new Link(room);
      const rt = new WeaponRuntime();
      let nowMs = 0;
      const net = new NetClient({
        name: 'Marine', transport: link.client as never, autoReconnect: false,
        keepalive: null, wallClock: () => nowMs,
        events: { onVariantTable: (arsenal, slots) => { rt.adoptArsenal(arsenal, slots); } },
      });
      rt.beginSession();
      rt.resetLoadout(ALL_WEAPON_MASK);
      net.connect();
      for (let i = 0; i < 20; i++) { nowMs += 1000 / 60; room.advance(nowMs); net.update(1 / 60); }

      expect(link.sent.filter((m) => readMessageId(m) === S2C.VARIANT_TABLE)).toHaveLength(1);
      const table = decodeVariantTable(
        new PacketReader(link.sent.find((m) => readMessageId(m) === S2C.VARIANT_TABLE)!),
        createVariantTableMessage(),
      );
      expect(table?.variants).toEqual([]);
      expect([...rt.variantSlots]).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(rt.stats(WeaponId.SHOTGUN).variantId).toBe('');
      expect(rt.mag[WeaponId.SHOTGUN]).toBe(8);
    } finally { room.stop(); }
  });

  it('a session that ends drops the table it was told', () => {
    // THE REVERSE-VERSION FAILURE. The runtime outlives the connection
    // (`game.ts enterSession` keeps it), so a player who used the four-shell
    // shotgun and then reconnected to a server too old to send opcode 13 would
    // keep resolving slot 1 forever — predicting four shells and 10 damage
    // against that server's eight and 11, with no message ever contradicting
    // it, because the contradiction is a message that never arrives.
    const room = roomWithVariants();
    try {
      const link = new Link(room);
      const rt = new WeaponRuntime();
      let nowMs = 0;
      const net = new NetClient({
        name: 'Marine', transport: link.client as never, autoReconnect: false,
        keepalive: null, wallClock: () => nowMs,
        events: { onVariantTable: (arsenal, slots) => { rt.adoptArsenal(arsenal, slots); } },
      });
      rt.beginSession();
      rt.resetLoadout(ALL_WEAPON_MASK);
      net.connect();
      for (let i = 0; i < 20; i++) { nowMs += 1000 / 60; room.advance(nowMs); net.update(1 / 60); }
      expect(rt.stats(WeaponId.SHOTGUN).variantId).toBe('four-shell');

      rt.beginSession();
      expect(rt.stats(WeaponId.SHOTGUN).variantId).toBe('');
      expect([...rt.variantSlots]).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(rt.stats(WeaponId.SHOTGUN).damage).toBe(11);
    } finally { room.stop(); }
  });
});

/* ------------------------------------------------------------------------ *
 * A MANIFEST THE PARSER ACCEPTS MUST REACH A REAL ROOM
 *
 * Moved here from `shared/src/variants.test.ts` on 2026-09-05, and the move is
 * the point: that file is in `shared`, and reaching for `Room` pulled ELEVEN
 * server modules into shared's composite program to typecheck one test. A
 * package that everything else depends on should not depend on the server, and
 * this file already drives a real `Room` over a pumped link for exactly this
 * kind of end-to-end claim — it already pays the cost, so the test belongs
 * where the cost already is.
 *
 * What it proves is the invariant the codec sweep in `shared` cannot see: the
 * parser, the release gate, the wire and the ROOM all accept the same set. The
 * regression that produced it — a row the parser blessed and the wire refused,
 * leaving a published pack serving an empty table — is described in full at
 * the head of the sweep in `shared/src/variants.test.ts`.
 * ------------------------------------------------------------------------ */

const NEAR_ZERO = {
  id: 'near-zero', base: WeaponId.SHOTGUN, name: 'Near Zero',
  over: { magSize: 4, damage: 10, spreadPerShot: -1e-10 },
};

/** The shipped pair from `server/src/releases.test.ts:43-51` — known good. */
const SHIPPED = [
  {
    id: 'shotgun-slug', base: WeaponId.SHOTGUN, name: 'Slug Shotgun',
    over: { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03, falloffEnd: 44, rpm: 42 },
  },
  { id: 'pistol-burst', base: WeaponId.PISTOL, name: 'Burst Pistol', over: { rpm: 620, damage: 12 } },
];

function roomFor(manifest: VariantsManifest): Room {
  return new Room({
    seed: 4242, botFill: 0, enemies: 0, eagerWorld: false, store: null,
    clock: () => 0, name: 'variants-e2e', allWeapons: true, variants: manifest,
  });
}

/** The same row with the sign taken off. Legal, and it has to stay legal. */
const NEAR_ZERO_LEGAL = { ...NEAR_ZERO, id: 'near-zero-legal', over: { ...NEAR_ZERO.over, spreadPerShot: 1e-10 } };

describe('a manifest the parser accepts reaches a real Room', () => {
  it('THE REGRESSION: the near-zero row is refused at the door, because a room silently empties it', () => {
    /*
     * THE COST FIRST, and measured through the real thing rather than argued.
     * The manifest is hand-built here — the parser is deliberately out of the
     * loop — so this half stays true whatever the parser decides, and says
     * what the room DOES with a row the wire will refuse:
     * `decodeRoomVariantTable` reads `decoded === null ? [] : ...`
     * (`server/src/room.ts:137`), so the operator gets a published variants
     * pack, a green `variants.validate`, an empty table, and no error
     * anywhere. That is strictly worse than a refused manifest, which is loud
     * and fixable.
     */
    const room = roomFor({ variants: [NEAR_ZERO] });
    try {
      expect(room.variantTable, 'a room CAN serve an empty table for a row the wire refuses')
        .toHaveLength(0);
      expect(room.sim.arsenal.slotCount, 'every player is on the base arsenal').toBe(1);
      expect(room.sim.arsenal.statsFor(WeaponId.SHOTGUN, 1).variantId).toBe('');
    } finally { room.stop(); }

    // So the parser — the door that has both the authority to judge and the
    // error strings to explain itself — must never bless it.
    const parsed = parseVariantsManifest(JSON.stringify({ variants: [NEAR_ZERO] }));
    expect(
      parsed.manifest,
      'the parser blessed a row this test just measured a room to serve as NOTHING',
    ).toBeNull();
    expect(parsed.errors.join(' | ')).toContain('spreadPerShot -1e-10 is negative');
  });

  it('the near-zero row really is inside the EPS hole and not merely small', () => {
    // Otherwise the case above could be biting for some unrelated reason.
    // -1e-10 is negative, and it is inside the band's tolerance of its own
    // floor — which is the whole disagreement: `valueBandError` forgives it
    // and `negativeValueError` does not.
    const [lo] = bandEdgesFor(WEAPONS[WeaponId.SHOTGUN], 'spreadPerShot');
    expect(lo).toBe(0);
    expect(-1e-10 < 0).toBe(true);
    expect(-1e-10 < lo - 1e-9, 'the band would have caught it without the EPS slack').toBe(false);
  });

  for (const [label, variants] of [
    ['the shipped pair', SHIPPED],
    ['the same near-zero row with the sign off', [NEAR_ZERO_LEGAL]],
    ['all three together', [...SHIPPED, NEAR_ZERO_LEGAL]],
  ] as [string, { id: string; base: number }[]][]) {
    it(`${label}: parses, and the room fires exactly what the pack declares`, () => {
      // The other half of the bar. A rail that refuses everything is worth
      // what one that refuses nothing is worth, and `+1e-10` proves the fix
      // is about the SIGN and not about small numbers.
      const parsed = parseVariantsManifest(JSON.stringify({ variants }));
      // The release gate is this one line — `server/src/gate.ts:462`. If it
      // says ok, an operator has been told the pack is publishable.
      expect(parsed.errors, 'the fixture must parse; the gate would say ok').toEqual([]);
      expect(parsed.manifest).not.toBeNull();

      const room = roomFor(parsed.manifest!);
      try {
        expect(room.variantTable, 'the room published a pack and pinned NOTHING')
          .toHaveLength(variants.length);
        expect(room.sim.arsenal.slotCount).toBe(variants.length + 1);
        for (let i = 0; i < variants.length; i++) {
          expect(room.variantTable[i].id).toBe(variants[i].id);
          expect(room.sim.arsenal.statsFor(variants[i].base, i + 1).variantId).toBe(variants[i].id);
        }
      } finally { room.stop(); }
    });
  }
});
