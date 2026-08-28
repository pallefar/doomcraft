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
   magSize, reserveMax, reloadMs, splashRadius, splashDamage, terrainDamage,
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
- **The wire bill:** the client today learns only the folded u32 contentHash
  (SESSION_CONFIG, adopted without dispute — client.ts:1558-1568). A client
  whose bundle predates a variant table would mispredict spread/rpm/damage —
  rubber-banding ammo, wrong kill markers, silently dropped shots. So **the
  room SENDS its pinned variant table** in a new S2C message immediately after
  SESSION_CONFIG: `u8 count × (id slug, u8 base, then the whitelisted fields
  as a fixed-order record)`. Bounded: ≤64 variants × ~18 numbers. This is the
  §1.2 answer too — a variant table lands on the next ROOM, one clock, stated
  honestly. Protocol notes: `decodeSessionConfig` reads unconditionally with
  no `r.remaining` guard (protocol.ts:858-867) — the new message is a NEW
  opcode (not an append) to keep old decoders untouched, it moves the protocol
  fingerprint ratchet once, and it ships with a second golden vector.
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
| **V3 wire** | new S2C opcode carrying the room's table; arsenal applies it; local Worker fallback | golden vector for the new message; a mixed-version harness (old-bundle client vs variant room) showing adopt-and-predict-correctly |
| **V4 first content** | `slug-shotgun`, `burst-pistol` in a variants pack + `ItemKind.WEAPON_VARIANT` tokens + equip claim + craft recipe | the shipped-content bar: two-browser harness crafts a variant, equips it, fires it in a room, and the SERVER's kill log agrees with the client's prediction |
| **V5 standing gate** | ratchet closes: every variant in every installed pack passes bands + budget at gate AND at module load; the exemption list (if any) is empty | the wiring-ratchet end state — a green check that can fail, proven by seed-breaking once |

Each phase lands as its own green stage (suite + release:verify + harness),
per the standing push-at-every-stage rule. Phases V1–V2 are Mac-friendly;
V3–V4 want the two-browser harness this repo already runs headless.

## 6. Explicit non-goals

- No new weapon archetypes, no new `FireKind`, no behaviour in packs (Rule A).
- No straight upgrades — the power budget is the design, not a compliance box.
- No per-match balance flips: a variant table changes on the next ROOM, the
  one clock the pin already provides.
- No floor pickups of variants in this arc (the EF_SPAWN byte, §3).
- No touching `CONTENT_VERSION`'s compiled fallbacks — the static build and
  UPDATE_REQUIRED read them with no release in scope (PACKS.md §8.4).

## 7. Open decisions (for the user, before V2)

1. **The power-budget formula's weights** — sustained DPS vs range vs splash;
   the ±12% band is a starting proposal.
2. **Variant rarity ladder** — do variants start at uncommon (craft-only, per
   the craft fee table) or exist at common as drops-later?
3. **Competitive parity** — are variants ON in every mode from V4, or
   table-gated out of ranked-adjacent surfaces until the season rolls?
