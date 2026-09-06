# Doomcraft — the weapon-variant engine (scoping)

Written 2026-08-28, at the start of the background arc HANDOVER §3.3 opened. This
document scopes making weapon stats DATA-driven on both predictors so that weapon
VARIANTS — sidegrade stat tables like a slug shotgun or a burst pistol — can ship
as pack content, be owned as items, and land as the finish tier of `/api/craft`.
Nothing in this file is built yet. Line anchors are working-tree positions on the
day of writing; re-locate by content, never by number (PACKS.md §0's own rule).

## 0. The objection this document answers

Two texts declined this project on purpose, and both said why:

- `docs/PACKS.md` §1.1: *"`WEAPON_COUNT = 7` sizes 11 typed arrays at module
  load; `ALL_WEAPON_MASK` rides in the ownership bitmask; `WEAPONS` is imported
  by room.ts, deathmatch.ts, horde.ts, persistence.ts and the client — and the
  client **predicts** damage and spread from its own compiled copy. Making that
  per-session means all of it becomes dynamic and the predictor becomes
  data-driven. That is a real project and it is not this one."*
- `shared/src/items.ts` header: *"Weapon VARIANTS — sidegrade stat tables — are
  deliberately absent … shipping variants means making the predictor
  data-driven, which is a different project."*

This is that different project. The objection is answered by shrinking it: NOT
"make weapons data" (the typed arrays, the mask, the wire ids and the seven
archetypes all stay compiled) but "make a bounded OVERLAY on the compiled table
data" — and prove at every step that a session with zero variants behaves
byte-identically to today.

## 1. What a variant is — and is not

A variant is a **named override set applied to one base `WeaponId`**:

```
VariantDef {
  id:      'shotgun-slug'          // content-id slug, globally unique
  base:    WeaponId.SHOTGUN        // the archetype it modifies
  name:    'Slug Shotgun'
  over:    { pellets: 1, damage: 62, spread: 0.012, spreadMax: 0.03,
             falloffEnd: 44, rpm: 42 }   // ONLY whitelisted fields
}
```

Locked decisions, each with its reason:

1. **A variant is never a new `WeaponId`.** New ids burst the 7-bit ownership
   mask (`weapons.ts:461-467`), resize 11 typed arrays, move the HELLO caps and
   the weapons fingerprint at once (§1.1's exact numbers). An overlay on a base
   id touches none of that: slot, HUD glyph, ammo type, viewmodel and audio
   identity all stay the base's.
2. **`over` may name only whitelisted fields.** The whitelist is the 13
   gameplay fields `weaponsFingerprintInputs()` already ratchets
   (`shared/src/version.ts:351-362`: damage, pellets, headshotMultiplier, rpm,
   magSize, reloadMs, splashRadius, splashDamage, terrainDamage,
   spread, spreadMax, spreadPerShot) **plus** the falloff quartet and
   projectileSpeed. Feel fields (recoil, shake, viewkick, muzzle, switch
   times) are NOT variant-able: they are the archetype's identity, they are
   outside today's fingerprint ratchet, and a variant that changes how firing
   FEELS is a new weapon wearing a costume. This closes the recon finding that
   the ratchet covers 13 of ~60 fields — the variant surface IS the ratchet
   surface, extended deliberately, never accidentally.
3. **Every field is clamped to a per-field band** (e.g. rpm within ×0.3..×1.6
   of base, damage within ×0.25..×2.5, pellets 1..12). Bands are data in the
   same file as the parser, and the parser REFUSES out-of-band values —
   refusals, not corrections, exactly as `parseItemsManifest` does.
4. **Sidegrade is PROVEN, not asserted.** A scalar power budget
   `powerScore(def)` (sustained DPS × effective-range factor × splash factor —
   the exact formula is part of the pack schema, versioned with it) must land
   within ±12% of the base weapon's score for every variant, at parse time and
   in the gate. The proof style is `crafting.test.ts`'s: an adversarial test
   that mutates ONE field of a real variant into an upgrade and watches the
   check bite, plus load-time validation as the end state (`trust.ts:997`
   pattern — a bad table fails the first import, not the first firefight).
5. **No new behaviour, ever** (Rule A: a pack is data, never code — CSP
   `script-src 'self'` on both topologies). A variant that needs a new
   `FireKind` or a new projectile behaviour is BUILD-class and the console
   must say so. Numbers over the compiled schema, nothing else.

## 2. The one seam, and both predictors

Today both predictors read module-level tables and shared pure functions —
and the shared functions are the sync contract (the same cone regenerates from
`(ownerId, shotSeq)` on both sides):

> **This paragraph was FALSE when it was written, and is true as of `fc01475`
> (2026-09-05).** The cone did not regenerate on both sides: the server read it
> after the shot had bloomed it, seeded once per shot from a hash that included
> the ROOM seed the client never receives, and never spread projectiles at all.
> Measured divergence on a shotgun before the fix: up to 10.2°, 5.4 m apart at
> 30 m. `client/src/game/agreement.test.ts` is what now holds this sentence to
> account, and `shotSeed` has moved into `shared/src/weapons.ts` so there is one
> copy of the rule rather than two.

- client: `client/src/game/weapons.ts` — `WeaponRuntime` (fire loop at
  :684-803, hitscan :982-1064, projectile :1118-1145, reload/switch, and the
  lockstep comment at :748-752 naming sim.ts as its mirror).
- server: `server/src/sim.ts` — `applyWeaponIntent` :869-956, `tryFire`
  :974-1027, `resolveHitscan` :1043-1117, projectile step + detonate.
- both call `currentSpread/applyShotSpread/recoverSpread/damageAtDistance/
  splashDamageAt/knockbackImpulse` from `shared/src/weapons.ts` :383-442.

**The seam:** a `SessionArsenal` object — `statsFor(weaponId, variantSlot):
EffectiveWeapon` — constructed once per session/room from (compiled base table
+ the room's pinned variant table + each player's equipped variant claims).
Both predictors take it as a constructor argument instead of importing the
module tables directly at the ~20 call sites the recon enumerated. The local
Worker (`client/src/net/localServer.ts`) constructs it from the compiled
fallback exactly as it constructs rooms from `BUILTIN_CONTENT_HASH` today —
the static Vercel build is outside the release mechanism (PACKS.md §8.8) and
must keep working with zero fetches.

**Phase-V1 invariant, the whole point:** with zero variants installed,
`SessionArsenal.statsFor(id, 0)` returns the identical object the module table
holds, and a determinism harness (fixed seed, scripted inputs, both predictors)
proves the refactor changed NOTHING — the bench.py-style proof that a pure
plumbing change is pure.

## 3. Delivery: the pack, the pin, the wire

- **New pack kind `VARIANTS = 7`** (append-only enum, `shared/src/packs.ts`
  :22-38 — kind numbers are burned forever because `packSetHash` folds them).
  Class **data** (`checkPacksDeclared` refuses a 4th build pack — gate.ts
  :162-210), digest = sha256 of canonical bytes (fill it in the producer;
  `/api/version` renders `''` as "build"), fingerprint inputs = one canonical
  line per variant over every whitelisted field, so the console diff shows
  exactly which number moved.
- **Deploy order is load-bearing:** `PackInventory.unsatisfied()` pushes
  UNKNOWN kinds as unsatisfied (`server/src/packs.ts:379,402`), so any release
  naming kind 7 is refused by a binary that predates it (Rule E — the host
  silently serves the previous release). The variants-aware BINARY must be
  live before the first variants RELEASE is approved. The gate needs a
  `variants.validate` block copying `checkItemsValidate`'s optional-manifest
  pattern ("no variants manifest installed — nothing to check" passes).
- **Rooms already pin:** the factory resolves a release per `roomInstanceId`
  (`server/src/index.ts:952-989`) and the bucket is room-keyed precisely so
  two tables can never meet in one room. Variants inherit this for free.
- **The wire bill** — BUILT, phase V3. The client today learns only the folded
  u32 contentHash (SESSION_CONFIG, adopted without dispute). A client whose
  bundle predates a variant table would mispredict spread/rpm/damage —
  rubber-banding ammo, wrong kill markers, silently dropped shots. So **the
  room SENDS its pinned variant table** in `S2C.VARIANT_TABLE = 13`,
  immediately after SESSION_CONFIG:
  `u8 count × (str id, u8 base, 16 × f64), then u8 slot[WEAPON_COUNT]`.
  Bounded at 11 401 bytes. Four things about it, each with a reason:

  - **Effective values, not a present/absent mask.** Every row carries all 16
    whitelisted fields at the value the variant actually fires with, so the
    receiver never combines the wire with its own compiled table for any of
    them. That is a NARROWING of the trust surface, not its abolition — the
    ~25 fields a variant may not move are still compiled on both sides (see
    §6's open item).
  - **f64, not f32.** A row carries fields the variant inherited rather than
    overrode. Narrowed to float32 a rocket variant that moves only `rpm` would
    arrive with splashRadius 4.400000095367432 instead of 4.4, and
    `detonate()` tests that double; a shotgun variant that moves magazine and
    damage would inherit headshotMultiplier 1.600000023841858 and pay
    16.00000023841858 for a headshot pellet instead of 16.
  - **Both ends build their arsenal from the decoded bytes**, the server
    included. Lossless at f64 and therefore free, which is the point: it makes
    "both predictors read the same numbers" structural rather than a fact
    about today's field widths.
  - **`CAP_VARIANTS = 1 << 5`.** `onHello` checks the protocol window and
    draining and nothing else, so without the bit an old bundle is welcomed,
    ignores opcode 13 and fires base stats against variant resolution. A
    connection that does not set it has every claim resolved to `BASE_SLOT`,
    before the first magazine is filled.

  **This message is ADDITIVE and moves no ratchet.** An earlier draft of this
  section claimed it "moves the protocol fingerprint ratchet once"; that was
  FALSE. `protocolFingerprint()` lists the ids frozen at v3 BY NAME and its
  S2C list stops at `s2c.chunkz`, `client.ts` has always had `default: break`,
  and only `cap.inflate` of the capability bits is named — so opcode 13 and
  `CAP_VARIANTS` are both free. `PROTOCOL_VERSION` stays 3 and
  `PROTOCOL_MIN_SUPPORTED` stays 2. It ships with a golden vector all the
  same. (This is the third false claim found in this document; §2's cone
  paragraph and §5's ratchet row were the other two.)

  The LAYOUT IS FROZEN. V4 wants a display name for the HUD and the killfeed;
  that is a SEPARATE additive message, not a field appended here. A v3 decoder
  handed `str name` after the id would read "Slug"'s length byte as `base` and
  its four letters as the first float, 1.1589780174433289e24, and never know.
- **Pickups of variants are OUT of scope for the first arc:** the `EF_SPAWN`
  u8 `variant` byte already MEANS `WeaponId` for weapon pickups
  (level.ts:154-162, deathmatch.ts:296-315) — expressing "a slug shotgun on
  the floor" needs a widened field and a protocol move. Variants are acquired
  by CRAFTING and TRADING first; floor pickups are a later, separate decision.

## 4. Ownership and acquisition

Two packs' concerns, kept apart on purpose:

- **The stat table** (what a variant DOES) is the variants pack, above.
- **The ownership token** (who HAS one) is the existing items machinery:
  `ItemKind.WEAPON_VARIANT` joins the items manifest, `tradable: true`
  (trust.ts:241 already promises weapon variants trade), each def carrying
  `variantId` naming a variants-pack entry. Ownership state stays derived
  (`itemStateFor`, §7): pull the variant from the live pack and every owned
  copy goes dormant at the next read — no profile write, same as skins.
  A dormant or revoked variant is never applied by the arsenal: the room
  checks the claim against ITS pinned release at spawn, the same moment it
  already resolves loadout masks.
- **Equipping** is a per-weapon claim beside `equippedSkin` —
  `inventory.variants: { [weaponId]: ref }` — written through `/api/equip`'s
  existing validate-then-write shape (slot `variant:<weaponId>`).
- **Crafting is the finish tier** the handover named: `/api/craft` learns a
  second recipe shape — N duplicates of a weapon-variant item + fee → the
  chosen next-rarity variant — through the exact route/journal/idempotency
  machinery shipped on 2026-08-28 (`server/src/craft.ts`). Deterministic,
  same as cosmetics: no rolls, no boxes.
- **Mode availability is table-driven, never an `if`:** trust.test.ts's tree
  scan fails any line pairing a `ModeId` literal with an economy word (incl.
  'drop') — if a mode must exclude variants (competitive parity), that is a
  column on the trust/mode table, not a branch.

## 5. The ratchet plan (the shrink-to-standing-gate pattern, third use)

| Phase | Ships | The proof that phase must carry |
|---|---|---|
| **V1 seam** | `SessionArsenal` + both predictors take it; zero variants exist | determinism harness: fixed-seed scripted session on BOTH predictors, byte-compared against pre-refactor recordings; suite + bench untouched-green |
| **V2 schema + pack** | `shared/src/variants.ts` parser (whitelist, bands, refusals), `PackKind.VARIANTS`, producer + gate `variants.validate`, power-budget check | crafting.test.ts-style adversarial proof: mutate one real row into an upgrade → the budget check bites; load-time validation on import |
| **V3 wire** — DONE | `S2C.VARIANT_TABLE = 13` + `CAP_VARIANTS`, the room's table and the player's resolved slots; both predictors build from the decoded bytes; local Worker unchanged | golden vector; `client/src/net/variantWire.test.ts` runs a real Room, a real `NetClient` and a real `WeaponRuntime` and compares the effective weapon field for field — every OTHER test in the repo passes with the client's `case S2C.VARIANT_TABLE` deleted, which is why that one exists |
| **V4 first content** | `slug-shotgun`, `burst-pistol` in a variants pack + `ItemKind.WEAPON_VARIANT` tokens + equip claim + craft recipe | the shipped-content bar: two-browser harness crafts a variant, equips it, fires it in a room, and the SERVER's kill log agrees with the client's prediction |
| **V5 standing gate** | ratchet closes: every variant in every installed pack passes bands + budget at gate AND at module load; the exemption list (if any) is empty | the wiring-ratchet end state — a green check that can fail, proven by seed-breaking once |

Each phase lands as its own green stage (suite + release:verify + harness),
per the standing push-at-every-stage rule. Phases V1–V2 are Mac-friendly;
V3–V4 want the two-browser harness this repo already runs headless.

## 5a. V4 IS FIVE SUB-PHASES, and why (decided 2026-09-05, third session)

V4 was written as one phase — content, the ownership token, the equip claim, the
killfeed, the display readers and crafting — and put to an adversarial review as
eleven numbered clauses before a line was written. The review refused it:

> "I would not approve V4 as written."

Nine of the eleven were broken, and FOUR of the findings were not about the plan
at all but about shipped code (they are fixed: see `9f3b472`, `d3528a1`). The
conclusion that matters for this document is the one about SHAPE: a phase whose
plan can be broken in nine places is a phase too big to judge. Each of the five
concerns below has its own failure modes, its own proof, and its own way of
being silently wrong.

- **V4a — the pack reaches a room.** `content/variants.json`; a `content/`
  fallback in `PackInventory` (packsRoot winning, because a fallback-first
  implementation lets a bundled six-shell definition replace an installed
  four-shell `variants@1` and serve 6 instead of 4); `runReleaseVerify` reading
  and EMITTING the variants pack. Ends when a production room hands a capable
  client a non-empty table. **No ownership, no equip — every player stays at
  slot 0.**
- **V4b — the ownership token.** `ItemKind.WEAPON_VARIANT`, `ItemDef.variantId`,
  and items-manifest serialization. Landmines: there are NO `ITEMS_*` literals
  (items are a dynamically fingerprinted DATA pack); appending a field
  unconditionally changes every old item line and the recomputed digests of
  already-installed items versions; the naive new line is 177 bytes against a
  160-byte cap; and `guessKind` splits an id on `-` and indexes
  `ITEM_KIND_NAMES`, so a token must be `weapon_variant-shotgun-slug` or it
  renders under "Skins".
- **V4c — the claim reaches the body.** `inventory.variants`, `/api/equip`, and
  `RoomOptions.variantClaims`. The room is known BEFORE ticket redemption
  (`router.route` returns `{key, room}` before the await), and the claim must
  resolve against THAT room's pinned ordering rather than `releases.live()`, or
  a reversed row order grants 6 shells instead of 4. `equipVerdict` learns only
  an item's KIND today, so it must follow `ref -> ItemDef.variantId ->
  VariantDef.base`; a shotgun token submitted for `variant:0` currently returns
  200 while the arsenal resolves pistol damage 17. Mode eligibility is a COLUMN
  on the trust table — and note that `trust.test.ts`'s scan does NOT cover it:
  its regex is `rank|reward|grant|scrap|xp|entitle|payout|prize|leaderboard|drop`
  with no `variant` term, so the protection §4 claims does not exist yet.
- **V4d — display truth.** The killfeed cannot tell two shotgun variants apart,
  and the client holds no variant NAMES (`VariantWireEntry` carries id, base and
  values only), so a display name is a separate additive message. A 9th KILL
  byte is compatible — an old decoder reads all five fields and leaves one byte
  unread — but a new decoder must accept 8-byte messages and RESET the reused
  event's slot, or it retains the previous kill's. Shot identity must PROPAGATE
  from the firing path, not be looked up at kill time.
- **V4e — acquisition. SHIPPED.** §7.2 says craft-only, uncommon floor. As
  written that was unreachable: initial supply 0, drops supply none, trading
  conserves, and every craft needed three variants, so supply stayed 0 forever.
  The ENTRY recipe closes it — three duplicates of one COMMON cosmetic plus the
  50-Scrap uncommon fee become one chosen UNCOMMON weapon-variant token — and it
  extends §7.2 rather than contradicting it: acquisition is still at the bench
  and the floor is still uncommon. What it took:
  - **Two kind sets, not one.** `CRAFTABLE_KINDS` is checked against the
    SOURCE, so adding `WEAPON_VARIANT` to it would have made variants craft
    into each other. `CRAFT_TARGET_KINDS` is the output side; the kind rule
    bends one way and only for a COMMON source.
  - **The COMMON restriction is explicit**, not a consequence of the rarity+1
    rule. Without it an UNCOMMON cosmetic reaches a RARE variant the day one
    exists — the ladder V4e puts out of scope.
  - **One mint door.** `VARIANT_MINT_SOURCES = {'craft'}` in `persistence.ts`;
    'drop', 'challenge' and 'prize' still mint none, and it is an allow-list so
    a sixth call site inherits the refusal.
  - **Two live bugs fixed on the way.** `craftTargetsFor` took the RAW copy
    count and no Scrap balance, so the tab offered an enabled Craft button
    against a server that answered 400 (`GET /api/profile` now carries the
    escrow's `reserved` map for it); and the craft route reported
    `landed[0]?.ref ?? plan.targetRef`, i.e. the ref it had NOT delivered, when
    the grant wrote nothing. The route now asks `grantRefusal` before it spends
    anything. `server/src/craftAgreement.test.ts` runs both real
    implementations and asserts SET EQUALITY, not a subset.
  - Still out of scope: floor pickups (§3's `EF_SPAWN`) and any rarity above
    uncommon.
- **V4f — the equip button.** V4c landed the server half of the variant slot
  and only that half: `EquipSlot`, `variantSlotWeaponId` and `equipVerdict`'s
  `ref -> ItemDef.variantId -> VariantDef.base` walk were live, while
  `loadoutModel.ts` still mapped `WEAPON_VARIANT` to a null slot. A player
  could craft a token (V4e) and had no way to wear it. What it took:
  - **`GET /api/variants`**, mirroring `/api/items`: `{version, variants:
    [{id, base, name}]}`, and `{version: 0, variants: []}` when no pack is
    live. The tab cannot compute the slot without it — `/api/items` carries
    `variantId` and no base — and the in-room `S2C.VARIANT_TABLE` is out of
    reach because the Loadout tab is a MENU surface. It publishes strictly less
    than that wire message already gives any CAP_VARIANTS client.
  - **The slot is the ITEM's, not the KIND's.** `SLOT_FOR_KIND` has no
    `WEAPON_VARIANT` entry, deliberately: one constant there hands every token
    the same gun, and `variant:0` for a shotgun token is answered "that variant
    is for weapon 1, not weapon 0". Each row computes `variant:<base>` from the
    `/api/variants` map, and a token the map does not name gets NO action
    rather than a button that always 400s.
  - **Equipped-ness is a REF comparison.** `inventory.variants` is keyed by the
    base weapon and valued by the owned ref; comparing on the variant id or the
    localId lights every copy the player holds, including refs from a different
    items version that the server equips separately.
  - **Two doors were dropping the claim map.** The profile decoder in
    `loadoutTab.ts` never carried `inventory.variants`, so no row could read as
    Equipped; and the 200 branch of `equip()` rebuilt the inventory from
    `equippedSkin` and `title` alone, so a SUCCESSFUL variant equip repainted
    from stale claims and the button flipped straight back to "Equip".
    `POST /api/equip` had been answering with the whole map since V4c.
  - `server/src/equipAgreement.test.ts` runs both real implementations and
    compares (ref, slot) PAIRS. A set of slot NAMES does not discriminate: a
    build that swaps the two bundled tokens produces the identical set
    `{skin, title, variant:1, variant:3}` while the server answers the first
    click 400.

Each sub-phase goes to the review as its own numbered clauses before it is
built. V4a's are in `.verify/plans/S3-v4a.txt`.

## 6. Explicit non-goals

- No new weapon archetypes, no new `FireKind`, no behaviour in packs (Rule A).
- No straight upgrades — the power budget is the design, not a compliance box.
- No per-match balance flips: a variant table changes on the next ROOM, the
  one clock the pin already provides.
- No floor pickups of variants in this arc (the EF_SPAWN byte, §3).
- No touching `CONTENT_VERSION`'s compiled fallbacks — the static build and
  UPDATE_REQUIRED read them with no release in scope (PACKS.md §8.4).

## 7. Decisions (taken by the user, 2026-09-05)

These were held open on purpose — they are judgement calls, not derivations,
and §7 existed so nobody would infer them from the rest of the document. All
three are now answered. The wording below is the decision; the notes under each
are what the decision obliges the code to do.

### 7.1 The power budget — DPS-dominant, ±12% band

```
budget(v) = 0.50·dps + 0.20·range + 0.15·splash + 0.15·handling
pass if |budget(v) − budget(base)| / budget(base) ≤ 0.12
```

`dps` is sustained (damage × pellets ÷ fire interval, magazine and reload time
folded in — a variant that trades magazine size for rate of fire must pay for
it). `range` is the effective-range integral the falloff curve already
describes (`falloffStart`, `falloffEnd`, `falloffMin`, `falloffCurve`), not
`falloffEnd` alone. `splash` is radius × centre damage. `handling` is reload
plus spread recovery plus switch time. Each term is normalised against the
BASE weapon, so the budget is a ratio and a pistol and a BFG are scored on the
same scale.

**The band alone is not the rule.** A weighted sum with a ±12% band admits an
"everything up 10%" variant, which §6 forbids in words — no straight upgrades.
So the V2 check is two refusals, not one: the budget band above, AND a
**strict-dominance refusal** — a variant may not be better than or equal to its
base on every axis at once. The second is what makes the first a design rather
than a compliance box.

**Refined 2026-09-05, after the V2 plan was reviewed against the real weapon
table.** The formula above cannot be applied to all seven archetypes as
written, and the user's decision on how to repair it is **per-archetype axes
and measured currency**:

1. **An axis whose BASE value is zero is dropped, and its weight redistributed
   across the axes that survive.** Four of the seven weapons have no splash at
   all, so `splash / base_splash` is 0/0 — and `Math.abs(NaN) <= 0.12` is
   FALSE, so a naive implementation would refuse every pistol, shotgun,
   chaingun and chainsaw variant ever written rather than accept a bad one. The
   chainsaw has `magSize` 0 and `reloadMs` 0 and produces a NaN DPS the same
   way.
2. **An axis is chargeable only where it actually reaches that archetype's
   firing path.** Otherwise the budget accepts payment in currency the engine
   does not spend:
   - **Range is not an axis for PROJECTILE weapons.** A projectile's direct
     damage is stored at spawn (`projDamage`) and falloff is never applied to
     it, so a plasma variant can "pay" with `falloffStart: 0, falloffMin: 0`,
     score a budget of exactly 1.0, and collect a 20% real damage increase.
   - **`reloadMs` is not an axis for SHELL-RELOADERS.** The shotgun reloads on
     `reloadShellMs`; doubling `reloadMs` from 2400 to 4800 lowers the computed
     DPS from 70 to 55 and changes the actual reload by nothing at all.
3. **Every whitelisted field is banded**, not just the twelve the first plan
   named. `terrainDamage` was unbanded and goes straight to
   `world.carveSphere`, whose `for (let y = y0; y <= y1; y++)` never advances
   when `y0` is -1e20 — because `-1e20 + 1 === -1e20` — so one projectile from
   a variant carrying a finite, in-budget, dominance-clean `terrainDamage: 1e20`
   blocks the server's event loop forever.
4. **Counts are refused unless INTEGER**, not merely in band. `pellets: 1.5`
   sits inside 1..12 and makes the server fire twice while the client fires
   once; `magSize: 7.5` makes a reload transfer 0.5 rounds, which the typed
   arrays resolve as destroying one reserve round and loading none.

### 7.2 Rarity — uncommon floor, craft-only

Variants start at **uncommon**. There is no common tier: a tier defined in the
pack with no route to obtain it is a hole in the inventory UI, and the ladder
can grow upward later without a schema move. The only acquisition route in this
arc is the craft bench (N duplicates + fee, per the craft fee table in
`server/src/craft.ts`); trading follows from `tradable: true` and needs no new
route. Floor pickups stay out of scope (§3, the `EF_SPAWN` byte).

### 7.3 Competitive parity — table-gated out of ranked-adjacent

Variants are ON in Quest, Horde and casual surfaces from V4, and OFF in the
ranked-adjacent ones until a season rolls. Per §4 this is a **column on the
trust/mode table** (`variantsAllowed`), never an `if` — `trust.test.ts`'s tree
scan fails any line pairing a `ModeId` literal with an economy word, and that
scan is the thing keeping this honest. The room checks the claim against its
pinned release at spawn, in the same place it already resolves loadout masks;
a mode that does not allow variants resolves every claim to slot 0.
