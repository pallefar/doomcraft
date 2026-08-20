/**
 * DOOMCRAFT — HORDE: the economy.
 *
 * There is ONE purse. Credits come off dead demons and go out through exactly
 * two doors: things that kill faster, and things that keep them out longer.
 * Nothing in this mode has a separate "block budget" to spend first, which is
 * the single decision the whole mode is built to ask:
 *
 *     700 credits is a Rocket Launcher, or it is 140 stone blocks —
 *     a three-high wall across two of the three gates the next wave lights.
 *
 * Both halves of that sentence are computed, not written. `evaluateTrade()`
 * prices the wall side in *gates you can actually close* and the gun side in
 * *seconds off the next wave's time-to-kill*, from the real wave the server is
 * about to spawn (`composeWave` is shared, so the forecast is the thing itself)
 * and the real weapon table. When one side is plainly better the readout says
 * so; the interesting part is that at most credit balances neither is, because
 * the two costs scale differently:
 *
 *   - Walls scale with FRONTAGE. Each extra hot gate is another ~19 blocks of
 *     three-high wall, and the wave lights `1 + floor(wave/2)` of them. By wave
 *     12 you cannot afford to close them all in anything, so walls stop being a
 *     roof and become a funnel — you close six gates and leave one open on
 *     purpose, in front of the chaingun.
 *   - Guns scale with HIT POINTS. The wave's total health roughly triples
 *     between wave 4 and wave 10, and there are only five guns to buy, so
 *     killing power saturates. After the Plasma Rifle the only thing left to
 *     buy is stone.
 *
 * ...and there is one hard asymmetry that keeps the wall side honest at the top
 * of the curve: **obsidian is the only blast-proof material in the palette.**
 * `ServerWorld.carveSphere` refuses to remove anything harder than 7.5, and
 * obsidian is 9. Every other wall — including metal — is opened by a rocket,
 * yours or a Baron's. Obsidian costs 6.2x what stone does per block, so the
 * question "can this wall survive splash?" costs exactly 6.2x, and that is a
 * decision and not a shopping list.
 *
 * WHAT IS IN HERE
 *   1. The wall stock      — the palette as a decision table, priced per gate
 *   2. Killing power       — DPS, wave hit points, time-to-kill
 *   3. The trade           — the two sides, quantified, in one struct
 *   4. The wallet          — the credit balance and a ring-buffered ledger
 *   5. The offers          — nine live shop rows, curated rather than listed
 *   6. Placement           — the client half of "a block is not free"
 *   7. The panels          — the armoury and the fortify rail
 *
 * WHAT IS NOT
 *   Authority. The server charges the purse (`HordeDirector.chargeJournal`
 *   walks the world's block journal every tick and REVERTS a placement the
 *   placer cannot pay for). Everything here is a prediction whose only job is
 *   to make the refusal never happen — a greyed-out ghost is a better answer
 *   than a block that appears and vanishes 60 ms later.
 *
 * PERFORMANCE. Nothing on the frame path allocates. `PlacementPricer` writes
 * into one reused quote, `Armoury.refresh` writes into nine reused offer
 * objects, and every DOM write is guarded by a cached previous value. The
 * panels are built once at enter and registered on the mode's `ModeScope`.
 */

import {
  AMMO_MAX,
  AMMO_NAMES,
  BLOCK_HARDNESS,
  BLOCK_NAMES,
  BLOCK_SOLID,
  BlockId,
  CHUNK_HEIGHT,
  EntityType,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  REACH_PLACE,
  FireKind,
  WEAPON_COUNT,
  WEAPON_DAMAGE,
  WEAPON_FIRE_INTERVAL_MS,
  WEAPON_KIND,
  WEAPON_PELLETS,
  WEAPON_SPLASH_DAMAGE,
  WEAPON_SPLASH_RADIUS,
  ammoTypeOf,
  minimapColor,
  createVoxelHit,
  isPlaceable,
  ownsWeapon,
  raycastVoxels,
  weaponName,
  type VoxelHit,
} from '@shared';
import { ModePhase } from '@shared/modes';

import {
  HORDE_COMBAT_PREMIUM,
  HORDE_ENEMIES,
  HORDE_ENEMY_COUNT,
  HORDE_GATE_COUNT,
  HORDE_SALVAGE,
  HORDE_SHOP,
  HORDE_WALL_PALETTE,
  HordeItem,
  blockCost,
  fortHpFor,
  type HordeShopItem,
  type WaveComposition,
} from '@doomcraft/server/src/horde.js';

/* ------------------------------------------------------------------------ *
 * 1. The wall stock
 * ------------------------------------------------------------------------ */

/**
 * `ServerWorld.carveSphere` skips any block harder than this, so a rocket
 * cannot open it. The constant is module-private over there; it is mirrored
 * here and asserted behaviourally in `server/src/horde.test.ts` ("obsidian
 * survives the blast that opens metal"), which is the only kind of assertion
 * worth making about a mirrored number.
 */
export const BLASTPROOF_HARDNESS = 7.5;

/**
 * A wall is built at arm's length from the hold, not on top of it — far enough
 * that a Baron's melee cannot reach you through it, close enough that one
 * chaingun covers the whole frontage.
 */
export const WALL_RADIUS = 8;
/** A wall you can neither jump nor step over. Three is the honest minimum. */
export const WALL_HEIGHT = 3;

/**
 * Blocks of frontage one compass gate needs at `WALL_RADIUS`: the arc of one
 * eighth of the ring, rounded up, times the wall height. ~19 at the defaults.
 */
export const BLOCKS_PER_GATE = Math.ceil(((2 * Math.PI * WALL_RADIUS) / HORDE_GATE_COUNT)) * WALL_HEIGHT;

export interface WallOption {
  readonly blockId: number;
  readonly name: string;
  /** Credits for one block, at the fortify-window price. */
  readonly cost: number;
  /** Hit points against demon teeth. */
  readonly hp: number;
  /** Packed 0xRRGGBB for the swatch. */
  readonly colour: number;
  /** Hit points per credit. Nearly flat across the palette, and that is the point. */
  readonly hpPerCredit: number;
  /** Credits to close one compass gate with a three-high wall. */
  readonly gateCost: number;
  /** Baron swings to open one block of it. */
  readonly baronSwings: number;
  /** Imp swings to open one block of it. */
  readonly impSwings: number;
  /** Seconds a Baron needs to chew one block, wind-up included. */
  readonly baronSeconds: number;
  /** True when a rocket cannot remove it. Obsidian only. */
  readonly blastproof: boolean;
  /** One line naming what this material is FOR. */
  readonly role: string;
}

function buildStock(): readonly WallOption[] {
  const baron = HORDE_ENEMIES[EntityType.BARON];
  const imp = HORDE_ENEMIES[EntityType.IMP];
  const out: WallOption[] = [];
  for (let i = 0; i < HORDE_WALL_PALETTE.length; i++) {
    const blockId = HORDE_WALL_PALETTE[i];
    const cost = blockCost(blockId);
    const hp = fortHpFor(blockId);
    if (cost <= 0 || hp <= 0 || !isPlaceable(blockId)) continue;
    const baronSwings = Math.max(1, Math.ceil(hp / baron.siegeDamage));
    const impSwings = Math.max(1, Math.ceil(hp / imp.siegeDamage));
    const blastproof = BLOCK_HARDNESS[blockId] > BLASTPROOF_HARDNESS;
    out.push(Object.freeze({
      blockId,
      name: BLOCK_NAMES[blockId] ?? 'Block',
      cost,
      hp,
      colour: minimapColor(blockId),
      hpPerCredit: hp / cost,
      gateCost: cost * BLOCKS_PER_GATE,
      baronSwings,
      impSwings,
      baronSeconds: (baronSwings * (baron.siegeIntervalMs + baron.siegeWindupMs)) / 1000,
      blastproof,
      role: blastproof
        ? 'Rocket-proof. The only thing splash will not open.'
        : cost <= 3
          ? 'Cheap frontage. Wall three gates, expect to rebuild.'
          : cost <= 7
            ? 'The workhorse. Buys a Baron two swings per block.'
            : 'Dense. Fewer blocks, more seconds, same credits.',
    }));
  }
  return Object.freeze(out);
}

/** The palette, cheapest first, priced as a decision. */
export const WALL_STOCK: readonly WallOption[] = buildStock();

const WALL_BY_BLOCK = new Map<number, WallOption>();
for (let i = 0; i < WALL_STOCK.length; i++) WALL_BY_BLOCK.set(WALL_STOCK[i].blockId, WALL_STOCK[i]);

export function wallOptionOf(blockId: number): WallOption | undefined {
  return WALL_BY_BLOCK.get(blockId);
}
export function wallIndexOf(blockId: number): number {
  for (let i = 0; i < WALL_STOCK.length; i++) if (WALL_STOCK[i].blockId === blockId) return i;
  return -1;
}

/** The default selection: the cheapest material that is not literally dirt. */
export const DEFAULT_WALL_INDEX = Math.max(0, wallIndexOf(BlockId.STONE));

/** Blocks of `option` that `credits` buys at the given phase price. */
export function blocksFor(credits: number, option: WallOption, combat: boolean): number {
  const unit = option.cost * (combat ? HORDE_COMBAT_PREMIUM : 1);
  return unit <= 0 ? 0 : Math.floor(credits / unit);
}

/** Whole compass gates `credits` closes with `option`, to one decimal. */
export function gatesClosable(credits: number, option: WallOption): number {
  return option.gateCost <= 0 ? 0 : credits / option.gateCost;
}

/* ------------------------------------------------------------------------ *
 * 2. Killing power
 * ------------------------------------------------------------------------ */

/**
 * Monster hit points, mirrored from `MONSTERS` in server/src/bots.ts and
 * indexed by `EntityType`. bots.ts imports the whole simulation at runtime and
 * has no business in a page bundle, so the five numbers live here and
 * `server/src/horde.test.ts` asserts them against the real table — the same
 * discipline horde.ts uses for the `ES_*` entity-state bits.
 */
export const HORDE_ENEMY_HEALTH: Uint16Array = new Uint16Array([60, 48, 170, 340, 32]);

/** Extra bodies a blast is assumed to catch, from its radius. Capped at four. */
export function splashCluster(radius: number): number {
  return radius <= 0 ? 0 : Math.min(4, radius / 2);
}

/**
 * Damage per second a weapon delivers TO A WAVE — which is not the same number
 * as its single-target DPS, and using the wrong one here would price the whole
 * arsenal wrong.
 *
 *   - **Melee scores zero.** The Chainsaw's 208 dps is real and is the second
 *     highest in the game, but it is delivered at 1.5 m to one body at a time.
 *     Against nineteen demons walking in from four compass gates it is not a
 *     rate of clearing anything, and letting it into the maximum would make
 *     every purchase in the shop look like a downgrade.
 *   - **Splash counts.** A rocket is 92 direct and 108 more inside 4.4 m; a BFG
 *     is 240 direct and 400 inside 9.5 m. That is precisely what a 700- and a
 *     2200-credit gun are FOR in this mode, and ignoring it would say the
 *     Plasma Rifle beats both.
 */
export function hordeDps(weapon: number): number {
  const interval = WEAPON_FIRE_INTERVAL_MS[weapon];
  if (interval <= 0) return 0;
  if (WEAPON_KIND[weapon] === FireKind.MELEE) return 0;
  const direct = WEAPON_DAMAGE[weapon] * Math.max(1, WEAPON_PELLETS[weapon]);
  const splash = WEAPON_SPLASH_DAMAGE[weapon] * splashCluster(WEAPON_SPLASH_RADIUS[weapon]);
  return ((direct + splash) * 1000) / interval;
}

/** The best wave-clearing rate an arsenal can put out. */
export function bestDps(weaponMask: number): number {
  let best = 0;
  for (let w = 0; w < WEAPON_COUNT; w++) {
    if (!ownsWeapon(weaponMask, w)) continue;
    const dps = hordeDps(w);
    if (dps > best) best = dps;
  }
  return best;
}

/** Total hit points a composed wave puts on the field. */
export function waveHitPoints(c: WaveComposition): number {
  let hp = 0;
  for (let i = 0; i < HORDE_ENEMY_COUNT; i++) hp += c.countOf(i) * HORDE_ENEMY_HEALTH[i];
  return hp;
}

/** Fraction of a wave's hit points that arrives on wings and ignores walls. */
export function flyerShare(c: WaveComposition): number {
  let total = 0;
  let flying = 0;
  for (let i = 0; i < HORDE_ENEMY_COUNT; i++) {
    const hp = c.countOf(i) * HORDE_ENEMY_HEALTH[i];
    total += hp;
    if (HORDE_ENEMIES[i].flying) flying += hp;
  }
  return total <= 0 ? 0 : flying / total;
}

/* ------------------------------------------------------------------------ *
 * 3. The trade
 * ------------------------------------------------------------------------ */

/** Both sides of the only question this mode asks, in comparable units. */
export interface TradeReadout {
  credits: number;
  /** Gates the wave will light. */
  gates: number;
  /** Gates `credits` closes in the selected material. */
  gatesAffordable: number;
  /** Credits needed to close every lit gate in the selected material. */
  gatesFullCost: number;
  /** Blocks of the selected material `credits` buys right now. */
  blocks: number;
  /** Best unowned weapon `credits` covers, or -1. */
  gunId: number;
  gunPrice: number;
  /** Seconds the wave takes to kill with what you own now. */
  ttkNow: number;
  /** Seconds it would take with that gun in hand. */
  ttkWithGun: number;
  /** Share of the wave's hit points that flies over any wall, 0..1. */
  flyers: number;
  /** Which side is currently the better buy: -1 walls, 0 neither, 1 guns. */
  lean: number;
  /** One line, ready to print. */
  line: string;
}

export function createTradeReadout(): TradeReadout {
  return {
    credits: 0, gates: 0, gatesAffordable: 0, gatesFullCost: 0, blocks: 0,
    gunId: -1, gunPrice: 0, ttkNow: 0, ttkWithGun: 0, flyers: 0, lean: 0, line: '',
  };
}

/** The gun offers, cheapest first — used for both the trade and the shop. */
const GUN_ITEMS: readonly HordeShopItem[] = Object.freeze(
  HORDE_SHOP.filter((s) => s.weapon >= 0).slice().sort((a, b) => a.price - b.price),
);

/**
 * Price both halves of the decision against the wave that is actually coming.
 *
 * The `lean` is deliberately shy of a recommendation. It only calls a side when
 * the numbers are lopsided: walls when you cannot yet close half the lit gates
 * and the wave is mostly ground, guns when the wave is mostly flyers (a wall is
 * worth nothing against a Cacodemon) or when your arsenal has not moved in a
 * while. Anywhere in between it says so, because "either is defensible" is the
 * honest answer and the mode is more interesting when the player picks.
 */
export function evaluateTrade(
  credits: number, next: WaveComposition, weaponMask: number, wall: WallOption, out: TradeReadout,
  gateCount = 0,
): TradeReadout {
  out.credits = credits;
  // The server's own mask wins when the mode has one; the forecast's count is
  // the fallback before the first sidecar lands.
  out.gates = gateCount > 0 ? gateCount : next.gateCount;
  out.gatesFullCost = wall.gateCost * out.gates;
  out.gatesAffordable = gatesClosable(credits, wall);
  out.blocks = blocksFor(credits, wall, false);
  out.flyers = flyerShare(next);

  // The best buy is the biggest jump in wave-clearing rate you can afford, not
  // the most expensive thing on the shelf. Without this the readout offers the
  // Chaingun at 350 and then has to admit it takes zero seconds off the wave,
  // because the Pistol already out-damages it against a single body.
  const now = bestDps(weaponMask);
  out.gunId = -1;
  out.gunPrice = 0;
  let bestGain = 0;
  for (let i = 0; i < GUN_ITEMS.length; i++) {
    const g = GUN_ITEMS[i];
    if (ownsWeapon(weaponMask, g.weapon) || g.price > credits) continue;
    const gain = hordeDps(g.weapon) - now;
    if (gain > bestGain) { bestGain = gain; out.gunId = g.weapon; out.gunPrice = g.price; }
  }
  if (out.gunId < 0) {
    // Nothing affordable is an upgrade; name the cheapest thing still missing
    // so the ladder is visible even when the answer is "buy stone".
    for (let i = 0; i < GUN_ITEMS.length; i++) {
      const g = GUN_ITEMS[i];
      if (ownsWeapon(weaponMask, g.weapon) || g.price > credits) continue;
      out.gunId = g.weapon;
      out.gunPrice = g.price;
      break;
    }
  }

  const hp = waveHitPoints(next);
  out.ttkNow = now > 0 ? hp / now : 0;
  const withGun = out.gunId >= 0 ? Math.max(now, hordeDps(out.gunId)) : now;
  out.ttkWithGun = withGun > 0 ? hp / withGun : out.ttkNow;

  const coverage = out.gates > 0 ? out.gatesAffordable / out.gates : 1;
  const saved = out.ttkNow - out.ttkWithGun;
  // True when the purse covers the whole frontage AND the gun on top of it —
  // which happens, and pretending otherwise would be a lie dressed as tension.
  const both = out.gunId >= 0 && credits >= out.gatesFullCost + out.gunPrice;

  if (both) {
    out.lean = 0;
  } else if (out.flyers >= 0.45) {
    out.lean = 1;
  } else if (coverage < 0.5 && out.flyers < 0.25) {
    out.lean = -1;
  } else if (saved >= out.ttkNow * 0.28 && coverage >= 0.75) {
    out.lean = 1;
  } else {
    out.lean = 0;
  }

  const hasGun = out.gunId >= 0;
  const gunText = hasGun ? `${weaponName(out.gunId)} (${out.gunPrice})` : '';
  const gunPhrase = hasGun ? `the ${gunText}` : 'nothing new in the rack';
  const gateWord = `gate${out.gates === 1 ? '' : 's'}`;
  const wallText = out.gatesAffordable >= out.gates
    ? `all ${out.gates} ${gateWord} in ${wall.name.toLowerCase()}`
    : `${out.gatesAffordable.toFixed(1)} of ${out.gates} ${gateWord} in ${wall.name.toLowerCase()}`;

  if (both) {
    out.line = `Both: ${out.gates} ${gateWord} of ${wall.name.toLowerCase()} `
      + `(${out.gatesFullCost}) and ${gunPhrase}.`;
  } else if (out.lean > 0 && out.flyers >= 0.45) {
    out.line = `${Math.round(out.flyers * 100)}% of this wave flies. Buy ${gunPhrase}, not the wall.`;
  } else if (out.lean > 0) {
    out.line = `${gunText} takes ${Math.round(saved)}s off the wave. You can already wall ${wallText}.`;
  } else if (out.lean < 0) {
    out.line = `You can only wall ${wallText}. Close the gates before you shop.`;
  } else if (hasGun) {
    out.line = `${wallText}, or ${gunPhrase}. Either is defensible.`;
  } else {
    out.line = `${wallText}. Nothing left in the rack worth the credits.`;
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * 4. The wallet
 * ------------------------------------------------------------------------ */

/** Why credits moved. Mirrors the `HORDE_PAY_*` sub-codes on the wire. */
export const LEDGER_REASONS: readonly string[] = Object.freeze([
  'Kill', 'Wave clear', 'Purchase', 'Block', 'Refused', 'Salvage',
]);

/** Entries kept for the floating credit feed. */
export const LEDGER_SLOTS = 6;

/**
 * The balance plus a ring of recent movements. The balance itself is
 * authoritative (`ModeStateBuffer.budget`); the ring exists so the HUD can show
 * *why* it moved, which is what turns a number into feedback.
 */
export class HordeWallet {
  credits = 0;
  /** Signed change on the last `apply`. */
  lastDelta = 0;
  /** Everything paid in over the run. */
  earned = 0;
  /** Everything paid out over the run. */
  spent = 0;
  /** Of `spent`, how much went into walls. */
  onWalls = 0;
  /** Of `spent`, how much went into the armoury. */
  onArsenal = 0;
  blocksPlaced = 0;
  /** Purchases the server refused for want of funds. */
  refusals = 0;

  private readonly amount = new Int32Array(LEDGER_SLOTS);
  private readonly reason = new Uint8Array(LEDGER_SLOTS);
  private readonly bornMs = new Float64Array(LEDGER_SLOTS);
  private head = 0;
  private count = 0;

  reset(): void {
    this.credits = 0;
    this.lastDelta = 0;
    this.earned = 0;
    this.spent = 0;
    this.onWalls = 0;
    this.onArsenal = 0;
    this.blocksPlaced = 0;
    this.refusals = 0;
    this.head = 0;
    this.count = 0;
  }

  /** Authoritative balance from the state sidecar. */
  apply(credits: number): void {
    this.lastDelta = credits - this.credits;
    this.credits = credits;
  }

  /**
   * A `PAYOUT` event. `amount` is always positive on the wire; `reason` says
   * which direction it went. Returns false for a reason that changes nothing.
   */
  note(amount: number, reason: number, nowMs: number): boolean {
    const a = Math.abs(Math.round(amount));
    switch (reason) {
      case 0: case 1: case 5:
        this.earned += a;
        break;
      case 2:
        this.spent += a;
        this.onArsenal += a;
        break;
      case 3:
        this.spent += a;
        this.onWalls += a;
        this.blocksPlaced++;
        break;
      case 4:
        this.refusals++;
        break;
      default:
        return false;
    }
    const signed = (reason === 2 || reason === 3) ? -a : (reason === 4 ? 0 : a);
    const slot = this.head;
    this.amount[slot] = signed;
    this.reason[slot] = reason & 7;
    this.bornMs[slot] = nowMs;
    this.head = (this.head + 1) % LEDGER_SLOTS;
    if (this.count < LEDGER_SLOTS) this.count++;
    return true;
  }

  get entries(): number { return this.count; }
  /** `i` = 0 is the newest. */
  entryAmount(i: number): number { return this.amount[this.slot(i)]; }
  entryReason(i: number): number { return this.reason[this.slot(i)]; }
  entryAgeMs(i: number, nowMs: number): number { return nowMs - this.bornMs[this.slot(i)]; }

  private slot(i: number): number {
    return (this.head - 1 - i + LEDGER_SLOTS * 2) % LEDGER_SLOTS;
  }
}

/* ------------------------------------------------------------------------ *
 * 5. The offers
 * ------------------------------------------------------------------------ */

/** Rows the armoury shows. Nine, so every one has a digit. */
export const OFFER_SLOTS = 9;

export interface ShopOffer {
  /** 1..9, the key that buys it. */
  slot: number;
  /** `HordeItem`, or -1 for an empty row. */
  itemId: number;
  name: string;
  sub: string;
  price: number;
  /** True when the balance covers it. */
  affordable: boolean;
  /** False when buying it would do nothing (full reserve, owned gun, no damage). */
  useful: boolean;
  /** Why the row is dead, or ''. */
  reason: string;
  /** 0 ammo, 1 medical, 2 weapon, 3 keep. Drives the swatch colour. */
  group: number;
}

function emptyOffer(slot: number): ShopOffer {
  return { slot, itemId: -1, name: '—', sub: '', price: 0, affordable: false, useful: false, reason: '', group: 0 };
}

/** What the armoury needs to know about the shopper. Reused, never allocated. */
export interface ShopperState {
  credits: number;
  weaponMask: number;
  health: number;
  armor: number;
  /** Reserve ammo, indexed by AmmoType. */
  reserve: Uint16Array;
  phase: ModePhase;
  /** Live quote from `FortLedger.repairQuote`, mirrored client-side by count. */
  repairCost: number;
  repairBlocks: number;
  lives: number;
}

export function createShopperState(): ShopperState {
  return {
    credits: 0, weaponMask: 0, health: 100, armor: 0,
    reserve: new Uint16Array(5), phase: ModePhase.LOADING,
    repairCost: 0, repairBlocks: 0, lives: 3,
  };
}

/**
 * Nine live rows rather than a thirteen-row list.
 *
 * A shop is a decision surface, not an inventory dump. Four ammo rows and two
 * medical rows are always there because they are always the right answer to
 * *something*. The two weapon rows are chosen live — the cheapest gun you do
 * not own, and the best gun the balance already covers — so the arsenal ladder
 * shows you the next rung and the top rung you have earned, and never eleven
 * things you cannot buy. Row nine is the keep: repairs while there is damage to
 * repair, a resurrection when there is not.
 *
 * The full price ladder is still visible: `ArmouryPanel` prints every gun and
 * its price in the arsenal strip, greyed until it is reachable. Nothing is
 * hidden; only the *buyable* rows get a digit.
 */
export class Armoury {
  readonly offers: ShopOffer[] = [];
  /** The mask the last `refresh` saw, so the arsenal strip can grey what is owned. */
  lastMask = 0;

  constructor() {
    for (let i = 0; i < OFFER_SLOTS; i++) this.offers.push(emptyOffer(i + 1));
  }

  refresh(s: ShopperState): void {
    const build = s.phase === ModePhase.BUILD;
    this.lastMask = s.weaponMask;

    this.fill(0, HordeItem.AMMO_BULLETS, s, 0);
    this.fill(1, HordeItem.AMMO_SHELLS, s, 0);
    this.fill(2, HordeItem.AMMO_ROCKETS, s, 0);
    this.fill(3, HordeItem.AMMO_CELLS, s, 0);
    this.fill(4, HordeItem.MEDKIT, s, 1);
    this.fill(5, HordeItem.ARMOR, s, 1);

    /* --- the two live weapon rows --- */
    let cheapest = -1;
    let best = -1;
    for (let i = 0; i < GUN_ITEMS.length; i++) {
      const g = GUN_ITEMS[i];
      if (ownsWeapon(s.weaponMask, g.weapon)) continue;
      if (cheapest < 0) cheapest = g.id;
      if (g.price <= s.credits) best = g.id;
    }
    if (best === cheapest) {
      best = -1;
      for (let i = 0; i < GUN_ITEMS.length; i++) {
        const g = GUN_ITEMS[i];
        if (ownsWeapon(s.weaponMask, g.weapon) || g.id === cheapest) continue;
        best = g.id;
        break;
      }
    }
    this.fill(6, cheapest, s, 2);
    this.fill(7, best, s, 2);

    /* --- the keep --- */
    if (build && s.repairBlocks > 0) this.fill(8, HordeItem.REPAIR, s, 3);
    else this.fill(8, HordeItem.EXTRA_LIFE, s, 3);
  }

  offerAt(slot1to9: number): ShopOffer | null {
    const i = slot1to9 - 1;
    if (i < 0 || i >= OFFER_SLOTS) return null;
    const o = this.offers[i];
    return o.itemId < 0 ? null : o;
  }

  private fill(index: number, itemId: number, s: ShopperState, group: number): void {
    const o = this.offers[index];
    o.group = group;
    if (itemId < 0) {
      o.itemId = -1; o.name = 'Arsenal complete'; o.sub = 'Nothing left to buy but stone';
      o.price = 0; o.affordable = false; o.useful = false; o.reason = '';
      return;
    }
    const def = HORDE_SHOP[itemId];
    o.itemId = itemId;
    o.name = def.name;
    o.sub = def.blurb;
    o.reason = '';
    o.useful = true;

    if (def.id === HordeItem.REPAIR) {
      // Priced by the server at the moment of purchase — only it knows which
      // of your blocks are damaged and by how much. The client offers the row
      // and reports what it has seen chewed, and the server sends the bill.
      o.price = s.repairCost;
      o.name = 'Repair Walls';
      o.sub = s.repairBlocks > 0
        ? `At least ${s.repairBlocks} wall${s.repairBlocks === 1 ? '' : 's'} took teeth this run`
        : 'Restore every damaged block within 14 m';
      o.useful = s.phase === ModePhase.BUILD;
      if (!o.useful) o.reason = 'Fortify window only';
      o.affordable = s.credits > 0;
      if (o.affordable && !o.useful && o.reason.length === 0) o.reason = 'No effect';
      return;
    }
    if (def.id === HordeItem.EXTRA_LIFE) {
      o.price = def.price;
      o.sub = `You have ${s.lives} left`;
      o.useful = s.phase === ModePhase.BUILD;
      if (!o.useful) o.reason = 'Fortify window only';
    } else if (def.weapon >= 0) {
      const owned = ownsWeapon(s.weaponMask, def.weapon);
      o.price = owned ? Math.round(def.price * 0.25) : def.price;
      if (owned) { o.sub = 'Owned — tops the reserve up'; }
    } else if (def.ammo !== 0) {
      o.price = def.price;
      const cap = AMMO_MAX[def.ammo];
      const have = s.reserve[def.ammo];
      o.sub = `${have} / ${cap} ${AMMO_NAMES[def.ammo].toLowerCase()}`;
      o.useful = have < cap;
      if (!o.useful) o.reason = 'Reserve full';
      else if (!this.ownsUserOf(s.weaponMask, def.ammo)) {
        // Buying a gun hands over 35% of its reserve, so cells before a plasma
        // rifle are money set on fire. Greyed, not hidden: it is the ladder.
        o.useful = false;
        o.reason = 'No gun takes it yet';
      }
    } else {
      o.price = def.price;
      if (def.health > 0) {
        o.useful = s.health < 100;
        o.sub = `Health ${Math.round(s.health)} / 100`;
        if (!o.useful) o.reason = 'Already whole';
      } else if (def.armor > 0) {
        o.useful = s.armor < 200;
        o.sub = `Armour ${Math.round(s.armor)}`;
        if (!o.useful) o.reason = 'Armour full';
      }
    }
    o.affordable = o.price > 0 && o.price <= s.credits;
    if (o.affordable && !o.useful && o.reason.length === 0) o.reason = 'No effect';
  }

  private ownsUserOf(mask: number, ammo: number): boolean {
    for (let w = 0; w < 7; w++) {
      if (ownsWeapon(mask, w) && ammoTypeOf(w) === ammo) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------------ *
 * 6. Placement
 * ------------------------------------------------------------------------ */

/** Why a placement is refused. */
export const PLACE_OK = 0;
export const PLACE_NO_TARGET = 1;
export const PLACE_OUT_OF_WORLD = 2;
export const PLACE_OCCUPIED = 3;
export const PLACE_IN_BODY = 4;
export const PLACE_BROKE = 5;
export const PLACE_DEAD = 6;

export const PLACE_REFUSALS: readonly string[] = Object.freeze([
  '', 'No surface', 'Out of the world', 'Occupied', 'You are standing there', 'Not enough credits', 'You are down',
]);

/** One reusable placement solution. */
export interface PlaceQuote {
  /** True when a block would actually go down. */
  ok: boolean;
  /** PLACE_* code. */
  refusal: number;
  /** Cell the block would occupy. */
  x: number; y: number; z: number;
  /** Cell the crosshair is on — the salvage target. */
  hitX: number; hitY: number; hitZ: number;
  hitBlock: number;
  /** True when the crosshair is on something. */
  hasHit: boolean;
  /** Credits this placement costs, premium included. */
  cost: number;
  /** Credits a salvage of `hitBlock` would return, best case. */
  salvage: number;
  /** Hit points the placed block would have. */
  hp: number;
}

export function createPlaceQuote(): PlaceQuote {
  return {
    ok: false, refusal: PLACE_NO_TARGET,
    x: 0, y: 0, z: 0, hitX: 0, hitY: 0, hitZ: 0, hitBlock: 0, hasHit: false,
    cost: 0, salvage: 0, hp: 0,
  };
}

/** Blocks a placement ray stops on: anything solid. Matches the server's rule. */
function blocksTheRay(id: number): boolean {
  return BLOCK_SOLID[id] === 1;
}

/**
 * The client half of "a block is not free".
 *
 * Runs the same three tests the server runs — `ServerWorld.validateEdit`'s
 * world bounds, reach-to-nearest-face and occupancy, plus `Simulation`'s
 * body-overlap rule — and then adds the one the server adds on top in Horde:
 * can you pay for it. The answer drives the ghost's colour, so the refusal is
 * visible a frame before the click rather than a hundred milliseconds after it.
 */
export class PlacementPricer {
  readonly quote: PlaceQuote = createPlaceQuote();
  private readonly hit: VoxelHit = createVoxelHit();

  /**
   * `getBlock` is the client world sampler; `bodyX/Y/Z` is the local player's
   * feet centre. Returns the quote it just wrote.
   */
  solve(
    eyeX: number, eyeY: number, eyeZ: number,
    dirX: number, dirY: number, dirZ: number,
    getBlock: (x: number, y: number, z: number) => number,
    bodyX: number, bodyY: number, bodyZ: number,
    blockId: number, credits: number, combat: boolean, dead: boolean,
  ): PlaceQuote {
    const q = this.quote;
    q.ok = false;
    q.hasHit = false;
    q.cost = blockCost(blockId) * (combat ? HORDE_COMBAT_PREMIUM : 1);
    q.hp = fortHpFor(blockId);
    q.salvage = 0;

    if (dead) { q.refusal = PLACE_DEAD; return q; }

    if (!raycastVoxels(eyeX, eyeY, eyeZ, dirX, dirY, dirZ, REACH_PLACE, getBlock, blocksTheRay, this.hit)) {
      q.refusal = PLACE_NO_TARGET;
      return q;
    }

    q.hasHit = true;
    q.hitX = this.hit.x; q.hitY = this.hit.y; q.hitZ = this.hit.z;
    q.hitBlock = this.hit.block;
    const salvageOption = wallOptionOf(this.hit.block);
    if (salvageOption !== undefined) {
      q.salvage = Math.max(0, Math.round(salvageOption.cost * HORDE_SALVAGE));
    }

    const px = this.hit.x + this.hit.nx;
    const py = this.hit.y + this.hit.ny;
    const pz = this.hit.z + this.hit.nz;
    q.x = px; q.y = py; q.z = pz;

    if (py < 1 || py >= CHUNK_HEIGHT) { q.refusal = PLACE_OUT_OF_WORLD; return q; }
    if (BLOCK_SOLID[getBlock(px, py, pz)] === 1) { q.refusal = PLACE_OCCUPIED; return q; }

    // Simulation.requestEdit's body test, exactly: a block may not appear
    // inside a living body, and the block you are standing in is the one you
    // are most likely to aim at while panicking.
    if (px + 1 > bodyX - PLAYER_HALF_WIDTH && px < bodyX + PLAYER_HALF_WIDTH
      && pz + 1 > bodyZ - PLAYER_HALF_WIDTH && pz < bodyZ + PLAYER_HALF_WIDTH
      && py + 1 > bodyY && py < bodyY + PLAYER_HEIGHT) {
      q.refusal = PLACE_IN_BODY;
      return q;
    }

    if (q.cost > credits) { q.refusal = PLACE_BROKE; return q; }

    q.refusal = PLACE_OK;
    q.ok = true;
    return q;
  }
}

/* ------------------------------------------------------------------------ *
 * 7. The panels
 * ------------------------------------------------------------------------ */

export const ECONOMY_STYLE_ID = 'dc-horde-economy-css';

const CSS = `
.dche,.dche *{box-sizing:border-box}
.dche{--gold:#f0a020;--bad:#e03c1c;--ok:#7fc96a;
  font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  color:#c9c4bf;-webkit-user-select:none;user-select:none}
.dche b{color:#f4ece0;font-weight:650}

/* ---- fortify rail: always on, bottom centre ---- */
.dche-rail{position:absolute;left:50%;bottom:96px;transform:translateX(-50%);
  display:flex;align-items:flex-end;gap:4px;pointer-events:none;
  max-width:min(96vw,560px);flex-wrap:nowrap;overflow:hidden}
.dche-rail.off{display:none}
.dche-cell{min-width:52px;padding:5px 6px 4px;border-radius:3px;text-align:center;
  background:rgba(8,8,11,.78);border:1px solid rgba(255,255,255,.10);
  transition:border-color .08s linear,background .08s linear}
.dche-cell.sel{border-color:var(--gold);background:rgba(38,24,6,.9)}
.dche-cell.poor{opacity:.42}
.dche-sw{height:12px;border-radius:2px;margin-bottom:4px;
  box-shadow:inset 0 -4px 0 rgba(0,0,0,.28)}
.dche-nm{display:block;font-size:10px;letter-spacing:.02em;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dche-ct{display:block;font-size:11px;color:var(--gold);font-weight:650}
.dche-cell.sel .dche-nm{color:#f4ece0}
.dche-cell .dche-bp{display:block;font-size:9px;color:#8ecbff;letter-spacing:.06em}

/* ---- wallet ---- */
.dche-wallet{position:absolute;right:12px;bottom:104px;width:186px;text-align:right;
  pointer-events:none;transition:opacity .1s linear}
.dche-wallet.hidden{opacity:0}
.dche-bal{font:600 26px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--gold);
  text-shadow:0 2px 0 rgba(0,0,0,.6)}
.dche-bal small{font-size:11px;letter-spacing:.14em;color:#8c8781;display:block;
  font-weight:500;margin-bottom:2px}
.dche-trade{margin-top:5px;font-size:11px;color:#a49e97;line-height:1.3}
.dche-trade.walls{color:#f0c98a}
.dche-trade.guns{color:#8ecbff}
.dche-feed{margin-top:6px;display:flex;flex-direction:column;align-items:flex-end;gap:1px;
  height:74px;justify-content:flex-end;overflow:hidden}
.dche-fl{font:600 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.dche-fl.up{color:var(--ok)}
.dche-fl.dn{color:#e0a08a}
.dche-fl.no{color:var(--bad)}
.dche-fl i{font-style:normal;color:#7d7873;font-size:10px;margin-left:5px}

/* ---- armoury ---- */
.dche-shop{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(94vw,720px);max-height:min(90vh,680px);display:flex;flex-direction:column;
  background:rgba(10,9,11,.95);border:1px solid rgba(240,160,32,.34);border-radius:5px;
  box-shadow:0 18px 60px rgba(0,0,0,.66);pointer-events:auto;overflow:hidden}
.dche-shop.off{display:none}
.dche-head{display:flex;align-items:baseline;gap:10px;padding:10px 14px 8px;
  border-bottom:1px solid rgba(255,255,255,.09);flex:0 0 auto}
.dche-head h3{margin:0;font-size:13px;letter-spacing:.16em;color:#f4ece0;font-weight:650}
.dche-head .c{margin-left:auto;font:650 20px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--gold)}
.dche-head .h{font-size:11px;color:#7d7873}
.dche-tl{padding:7px 14px;font-size:11.5px;color:#c0b9b1;
  border-bottom:1px solid rgba(255,255,255,.07);background:rgba(240,160,32,.06);flex:0 0 auto}
.dche-cols{display:flex;gap:0;min-height:0;flex:1 1 auto;overflow:hidden}
.dche-col{flex:1 1 50%;min-width:0;display:flex;flex-direction:column;overflow-y:auto;
  padding:8px 0 10px}
.dche-col+.dche-col{border-left:1px solid rgba(255,255,255,.08)}
.dche-ch{padding:2px 14px 6px;font-size:10px;letter-spacing:.15em;color:#7d7873}
.dche-row{display:flex;align-items:center;gap:9px;padding:6px 14px;cursor:pointer;
  border-left:2px solid transparent}
.dche-row:hover{background:rgba(255,255,255,.045)}
.dche-row.sel{border-left-color:var(--gold);background:rgba(240,160,32,.10)}
.dche-row.dead{opacity:.34;cursor:default}
.dche-row.poor .p{color:var(--bad)}
.dche-k{flex:0 0 17px;height:17px;border-radius:2px;background:rgba(255,255,255,.09);
  color:#b9b3ac;font:600 10px/17px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center}
.dche-row.g0 .dche-k{background:rgba(240,200,96,.22);color:#f0c860}
.dche-row.g1 .dche-k{background:rgba(127,201,106,.20);color:#9fd98e}
.dche-row.g2 .dche-k{background:rgba(224,60,28,.22);color:#f09a86}
.dche-row.g3 .dche-k{background:rgba(80,168,240,.20);color:#8ecbff}
.dche-t{flex:1 1 auto;min-width:0}
.dche-t em{display:block;font-style:normal;font-size:12px;color:#e8e1d8;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dche-t em u{text-decoration:none;margin-left:6px;padding:1px 5px;border-radius:2px;
  font-size:9px;letter-spacing:.1em;background:rgba(80,168,240,.18);color:#8ecbff;
  vertical-align:1px}
.dche-t span{display:block;font-size:10.5px;color:#8c8781;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dche-row .p{flex:0 0 auto;font:650 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--gold)}
.dche-sw2{flex:0 0 16px;height:16px;border-radius:2px;
  box-shadow:inset 0 -5px 0 rgba(0,0,0,.3)}
.dche-ladder{padding:6px 14px 0;display:flex;flex-wrap:wrap;gap:4px}
.dche-lp{font-size:10px;padding:2px 5px;border-radius:2px;background:rgba(255,255,255,.06);
  color:#6f6a65;white-space:nowrap}
.dche-lp.own{background:rgba(127,201,106,.16);color:#9fd98e}
.dche-lp.can{background:rgba(240,160,32,.16);color:#f0c98a}
.dche-foot{padding:7px 14px;border-top:1px solid rgba(255,255,255,.09);
  font-size:10.5px;color:#7d7873;display:flex;gap:14px;flex-wrap:wrap;flex:0 0 auto}
.dche-foot b{color:#b9b3ac}

@media (max-width:700px){
  .dche-shop{width:96vw;max-height:88vh}
  .dche-cols{flex-direction:column;overflow-y:auto}
  .dche-col+.dche-col{border-left:none;border-top:1px solid rgba(255,255,255,.08)}
  /* Narrow enough that the rail reaches the right edge, so the wallet stacks
     above it instead of sitting on top of the last two swatches. */
  .dche-wallet{width:150px;bottom:150px}
  .dche-bal{font-size:21px}
  .dche-feed{height:52px}
  .dche-rail{bottom:78px}
  .dche-cell{min-width:44px}
}
@media (max-height:520px){
  .dche-rail{bottom:64px}
  .dche-wallet{bottom:64px}
  .dche-feed{height:44px}
}
`;

/** Install the shared stylesheet once. Returns the element, or null if present. */
export function installEconomyStyle(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null;
  if (document.getElementById(ECONOMY_STYLE_ID) !== null) return null;
  const el = document.createElement('style');
  el.id = ECONOMY_STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
  return el;
}

function div(cls: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (parent !== undefined) parent.appendChild(d);
  return d;
}

function hex(colour: number): string {
  return `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`;
}

/* ---- the rail ---------------------------------------------------------- */

/**
 * The wall palette as a strip above the hotbar. Five materials at a time —
 * the selection plus its neighbours — because eleven swatches is a menu and
 * three is a choice. Each cell carries the price and how many blocks the
 * balance buys, so the trade is on screen without opening anything.
 */
export class FortifyRail {
  readonly element: HTMLElement;
  private readonly cells: HTMLElement[] = [];
  private readonly swatches: HTMLElement[] = [];
  private readonly names: HTMLElement[] = [];
  private readonly costs: HTMLElement[] = [];
  private readonly tags: HTMLElement[] = [];
  private readonly shown: number[] = [];
  private cSelected = -1;
  private cCredits = -1;
  private cCombat = false;
  private cVisible = false;

  /** How many cells the rail shows. Odd, so the selection sits in the middle. */
  static readonly WIDTH = 5;

  constructor() {
    this.element = div('dche dche-rail off');
    for (let i = 0; i < FortifyRail.WIDTH; i++) {
      const cell = div('dche-cell', this.element);
      this.swatches.push(div('dche-sw', cell));
      const nm = document.createElement('em');
      nm.className = 'dche-nm';
      cell.appendChild(nm);
      const ct = document.createElement('em');
      ct.className = 'dche-ct';
      cell.appendChild(ct);
      const tag = document.createElement('em');
      tag.className = 'dche-bp';
      cell.appendChild(tag);
      this.cells.push(cell);
      this.names.push(nm);
      this.costs.push(ct);
      this.tags.push(tag);
      this.shown.push(-1);
    }
  }

  setVisible(on: boolean): void {
    if (this.cVisible === on) return;
    this.cVisible = on;
    this.element.classList.toggle('off', !on);
  }

  /** Redraw only when the window, the balance or the phase price moved. */
  update(selected: number, credits: number, combat: boolean): void {
    if (selected === this.cSelected && credits === this.cCredits && combat === this.cCombat) return;
    this.cSelected = selected;
    this.cCredits = credits;
    this.cCombat = combat;

    const n = WALL_STOCK.length;
    const half = (FortifyRail.WIDTH - 1) >> 1;
    let first = selected - half;
    if (first < 0) first = 0;
    if (first > n - FortifyRail.WIDTH) first = Math.max(0, n - FortifyRail.WIDTH);

    for (let i = 0; i < FortifyRail.WIDTH; i++) {
      const idx = first + i;
      const cell = this.cells[i];
      if (idx >= n) { cell.style.display = 'none'; continue; }
      cell.style.display = '';
      const opt = WALL_STOCK[idx];
      const unit = opt.cost * (combat ? HORDE_COMBAT_PREMIUM : 1);
      if (this.shown[i] !== idx) {
        this.shown[i] = idx;
        this.swatches[i].style.background = hex(opt.colour);
        this.names[i].textContent = opt.name;
        this.tags[i].textContent = opt.blastproof ? 'BLASTPROOF' : '';
      }
      this.costs[i].textContent = `${unit}`;
      cell.classList.toggle('sel', idx === selected);
      cell.classList.toggle('poor', unit > credits);
    }
  }
}

/* ---- the armoury ------------------------------------------------------- */

export interface ArmouryPanelOptions {
  /** Fired by a digit key or a tap. `itemId` is a `HordeItem`. */
  onBuy(itemId: number, quantity: number): void;
  /** Fired by a tap on a wall row or a wheel notch. */
  onSelectWall(index: number): void;
  onClose(): void;
}

/**
 * Two columns, one purse. The left column is everything that kills faster, the
 * right column is everything that keeps them out longer, and the balance sits
 * above both with the trade spelled out under it. The layout IS the argument:
 * you cannot look at what a Rocket Launcher costs without the price of a
 * three-high wall being on the same screen.
 */
export class ArmouryPanel {
  readonly element: HTMLElement;
  private readonly opts: ArmouryPanelOptions;
  private readonly balance: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly tradeLine: HTMLElement;
  private readonly rows: HTMLElement[] = [];
  private readonly rowName: HTMLElement[] = [];
  private readonly rowSub: HTMLElement[] = [];
  private readonly rowPrice: HTMLElement[] = [];
  private readonly wallRows: HTMLElement[] = [];
  private readonly wallSub: HTMLElement[] = [];
  private readonly wallPrice: HTMLElement[] = [];
  private readonly ladder: HTMLElement;
  private readonly ladderPills: HTMLElement[] = [];
  private readonly foot: HTMLElement;

  private cBalance = -1;
  private cTrade = '';
  private cLean = 99;
  private cFoot = '';
  private open = false;
  private readonly cRow: string[] = [];
  private readonly cWallRow: string[] = [];
  private readonly rowItemId = new Int8Array(OFFER_SLOTS).fill(-1);

  constructor(options: ArmouryPanelOptions) {
    this.opts = options;
    this.element = div('dche dche-shop off');

    const head = div('dche-head', this.element);
    const h3 = document.createElement('h3');
    h3.textContent = 'ARMOURY';
    head.appendChild(h3);
    this.hint = div('h', head);
    this.hint.textContent = '1–9 buy · wheel picks a wall · X closes';
    this.balance = div('c', head);
    this.balance.textContent = '0';

    this.tradeLine = div('dche-tl', this.element);
    this.tradeLine.textContent = '';

    const cols = div('dche-cols', this.element);

    /* ---- left: killing power ---- */
    const left = div('dche-col', cols);
    div('dche-ch', left).textContent = 'KILLING POWER';
    for (let i = 0; i < OFFER_SLOTS; i++) {
      const row = div('dche-row', left);
      const k = div('dche-k', row);
      k.textContent = `${i + 1}`;
      const t = div('dche-t', row);
      const em = document.createElement('em');
      const sp = document.createElement('span');
      t.appendChild(em);
      t.appendChild(sp);
      const p = div('p', row);
      row.addEventListener('click', () => { this.buyRow(i); });
      this.rows.push(row);
      this.rowName.push(em);
      this.rowSub.push(sp);
      this.rowPrice.push(p);
      this.cRow.push('');
    }
    this.ladder = div('dche-ladder', left);
    for (let i = 0; i < GUN_ITEMS.length; i++) {
      const pill = div('dche-lp', this.ladder);
      this.ladderPills.push(pill);
    }

    /* ---- right: the keep ---- */
    const right = div('dche-col', cols);
    div('dche-ch', right).textContent = 'THE KEEP · ONE BLOCK, ONE PRICE';
    for (let i = 0; i < WALL_STOCK.length; i++) {
      const opt = WALL_STOCK[i];
      const row = div('dche-row', right);
      const sw = div('dche-sw2', row);
      sw.style.background = hex(opt.colour);
      const t = div('dche-t', row);
      const em = document.createElement('em');
      em.textContent = opt.name;
      if (opt.blastproof) {
        const badge = document.createElement('u');
        badge.textContent = 'BLASTPROOF';
        em.appendChild(badge);
      }
      const sp = document.createElement('span');
      t.appendChild(em);
      t.appendChild(sp);
      const p = div('p', row);
      row.addEventListener('click', () => { this.opts.onSelectWall(i); });
      this.wallRows.push(row);
      this.wallSub.push(sp);
      this.wallPrice.push(p);
      this.cWallRow.push('');
    }

    this.foot = div('dche-foot', this.element);
  }

  setOpen(on: boolean): void {
    if (this.open === on) return;
    this.open = on;
    this.element.classList.toggle('off', !on);
  }
  get isOpen(): boolean { return this.open; }

  /** Buy by digit. Returns true when a row consumed the key. */
  pressDigit(digit: number): boolean {
    if (!this.open) return false;
    return this.buyRow(digit - 1);
  }

  private buyRow(index: number): boolean {
    if (index < 0 || index >= OFFER_SLOTS) return false;
    const id = this.rowItemId[index];
    if (id < 0) return false;
    this.opts.onBuy(id, 1);
    return true;
  }

  /**
   * Redraw. Every write is guarded by a cached string, so an open armoury on a
   * static balance costs nine string compares a frame and no layout at all.
   */
  update(
    armoury: Armoury, trade: TradeReadout, wallIndex: number, credits: number,
    combat: boolean, next: WaveComposition, wallet: HordeWallet,
  ): void {
    if (!this.open) return;

    if (credits !== this.cBalance) {
      this.cBalance = credits;
      this.balance.textContent = `${credits}`;
    }
    if (trade.line !== this.cTrade) {
      this.cTrade = trade.line;
      this.tradeLine.textContent = trade.line;
    }
    if (trade.lean !== this.cLean) {
      this.cLean = trade.lean;
      this.tradeLine.classList.toggle('walls', trade.lean < 0);
      this.tradeLine.classList.toggle('guns', trade.lean > 0);
    }

    for (let i = 0; i < OFFER_SLOTS; i++) {
      const o = armoury.offers[i];
      this.rowItemId[i] = o.itemId;
      const price = o.itemId < 0 ? '' : o.price > 0 ? `${o.price}` : '—';
      const sub = o.reason.length > 0 ? o.reason : o.sub;
      const sig = `${o.itemId}|${o.name}|${sub}|${price}|${o.affordable ? 1 : 0}|${o.useful ? 1 : 0}`;
      if (sig === this.cRow[i]) continue;
      this.cRow[i] = sig;
      const row = this.rows[i];
      this.rowName[i].textContent = o.name;
      this.rowSub[i].textContent = sub;
      this.rowPrice[i].textContent = price;
      row.className = `dche-row g${o.group}`
        + (o.itemId < 0 || !o.useful ? ' dead' : '')
        + (!o.affordable && o.itemId >= 0 ? ' poor' : '');
    }

    for (let i = 0; i < GUN_ITEMS.length; i++) {
      const g = GUN_ITEMS[i];
      const pill = this.ladderPills[i];
      const own = ownsWeapon(armoury.lastMask, g.weapon);
      const can = !own && g.price <= credits;
      const text = own ? `${g.name} ✓` : `${g.name} ${g.price}`;
      if (pill.textContent !== text) pill.textContent = text;
      const cls = `dche-lp${own ? ' own' : can ? ' can' : ''}`;
      if (pill.className !== cls) pill.className = cls;
    }

    for (let i = 0; i < WALL_STOCK.length; i++) {
      const opt = WALL_STOCK[i];
      const unit = opt.cost * (combat ? HORDE_COMBAT_PREMIUM : 1);
      // Every number here moves between rows. "gates you can close" does not
      // once you are rich, so it lives in the trade line at the top and the
      // rows carry the three things that actually separate the materials:
      // how much a demon has to chew through, how long that takes it, and what
      // a whole gate of the stuff costs.
      const sub = `${opt.hp} hp · ${opt.baronSeconds.toFixed(1)}s per block`
        + ` · ${opt.gateCost} cr a gate`;
      const sig = `${sub}|${unit}|${wallIndex === i ? 1 : 0}|${unit > credits ? 1 : 0}`;
      if (sig === this.cWallRow[i]) continue;
      this.cWallRow[i] = sig;
      this.wallSub[i].textContent = sub;
      this.wallPrice[i].textContent = `${unit}`;
      this.wallRows[i].className = 'dche-row'
        + (wallIndex === i ? ' sel' : '')
        + (unit > credits ? ' poor' : '');
    }

    const foot = `Next wave ${next.wave} · ${next.total} demons · ${trade.gates} gate`
      + `${trade.gates === 1 ? '' : 's'} · ${Math.round(trade.flyers * 100)}% airborne`
      + `   |   Earned ${wallet.earned} · walls ${wallet.onWalls} · arsenal ${wallet.onArsenal}`
      + (combat ? `   |   COMBAT PRICE: blocks cost ${HORDE_COMBAT_PREMIUM}x` : '');
    if (foot !== this.cFoot) {
      this.cFoot = foot;
      this.foot.textContent = foot;
    }
  }
}

/* ---- the wallet strip -------------------------------------------------- */

/**
 * The balance, the trade under it, and a short feed of what just moved. This is
 * the surface that is up during the fight, so it says only three things and one
 * of them is the reason the number changed.
 */
export class WalletStrip {
  readonly element: HTMLElement;
  private cHidden = false;
  private readonly value: HTMLElement;
  private readonly trade: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly lines: HTMLElement[] = [];
  private readonly amounts: HTMLElement[] = [];
  private readonly tags: HTMLElement[] = [];
  private cValue = -1;
  private cTrade = '';
  private cLean = 99;
  private readonly cLine: string[] = [];
  private readonly cOpacity: string[] = [];
  private readonly cAmount = new Int32Array(LEDGER_SLOTS).fill(0x7fffffff);
  private readonly cReason = new Int32Array(LEDGER_SLOTS).fill(-1);

  constructor() {
    this.element = div('dche dche-wallet');
    const bal = div('dche-bal', this.element);
    const cap = document.createElement('small');
    cap.textContent = 'CREDITS';
    bal.appendChild(cap);
    this.value = document.createElement('span');
    this.value.textContent = '0';
    bal.appendChild(this.value);
    this.trade = div('dche-trade', this.element);
    this.feed = div('dche-feed', this.element);
    for (let i = 0; i < LEDGER_SLOTS; i++) {
      const l = div('dche-fl', this.feed);
      l.style.display = 'none';
      const amount = document.createElement('span');
      const tag = document.createElement('i');
      l.appendChild(amount);
      l.appendChild(tag);
      this.lines.push(l);
      this.amounts.push(amount);
      this.tags.push(tag);
      this.cLine.push('');
      this.cOpacity.push('');
    }
  }

  /** The armoury and the run card both print the balance; two is one too many. */
  setHidden(hidden: boolean): void {
    if (this.cHidden === hidden) return;
    this.cHidden = hidden;
    this.element.classList.toggle('hidden', hidden);
  }

  update(wallet: HordeWallet, trade: TradeReadout, nowMs: number): void {
    if (this.cHidden) return;
    if (wallet.credits !== this.cValue) {
      this.cValue = wallet.credits;
      this.value.textContent = `${wallet.credits}`;
    }
    if (trade.line !== this.cTrade) {
      this.cTrade = trade.line;
      this.trade.textContent = trade.line;
    }
    if (trade.lean !== this.cLean) {
      this.cLean = trade.lean;
      this.trade.classList.toggle('walls', trade.lean < 0);
      this.trade.classList.toggle('guns', trade.lean > 0);
    }

    const n = wallet.entries;
    for (let i = 0; i < LEDGER_SLOTS; i++) {
      const el = this.lines[i];
      if (i >= n) {
        if (this.cLine[i] !== '') {
          this.cLine[i] = '';
          this.cAmount[i] = 0x7fffffff;
          el.style.display = 'none';
        }
        continue;
      }
      const age = wallet.entryAgeMs(i, nowMs);
      if (age > 4200) {
        if (this.cLine[i] !== '') {
          this.cLine[i] = '';
          this.cAmount[i] = 0x7fffffff;
          el.style.display = 'none';
        }
        continue;
      }
      const amount = wallet.entryAmount(i);
      const reason = wallet.entryReason(i);
      // Two integers rather than the string they would concatenate into: this
      // runs six times a frame for the whole run.
      if (amount !== this.cAmount[i] || reason !== this.cReason[i]) {
        this.cAmount[i] = amount;
        this.cReason[i] = reason;
        this.cLine[i] = 'x';
        el.style.display = '';
        const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
        this.amounts[i].textContent = reason === 4 ? 'NO FUNDS' : `${sign}${Math.abs(amount)}`;
        this.tags[i].textContent = LEDGER_REASONS[reason] ?? '';
        el.className = `dche-fl ${reason === 4 ? 'no' : amount >= 0 ? 'up' : 'dn'}`;
      }
      const opacity = age > 3200 ? `${(1 - (age - 3200) / 1000).toFixed(2)}` : '1';
      if (opacity !== this.cOpacity[i]) { this.cOpacity[i] = opacity; el.style.opacity = opacity; }
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Small shared helpers the mode prints
 * ------------------------------------------------------------------------ */

/** "5 credits · 135 hp · 2 Baron swings" for the ghost's price tag. */
export function priceTag(option: WallOption, combat: boolean): string {
  const unit = option.cost * (combat ? HORDE_COMBAT_PREMIUM : 1);
  return `${option.name} · ${unit} cr · ${option.hp} hp${combat ? ' · COMBAT PRICE' : ''}`;
}

