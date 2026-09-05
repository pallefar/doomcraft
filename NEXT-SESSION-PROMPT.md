Continue Doomcraft (~/youtube/doomcraft). Read HANDOVER.md first — §0 is the
rules that each cost real time, §3 is the queue, §6 is what is deliberately
open. `docs/VARIANTS.md` is the live arc. `ref/BAR.md` is the bar.

**NOTHING IS WAITING ON ME.** The order below is decided. Start building.

## The order

1. **Close V1–V3 out properly.** Five verified items, below.
2. **V4** — the first variant content.
3. **An ACHIEVEMENT system**, on top of everything else. New scope.
4. **Then the rest of the mapped-out queue**: the gauntlet (0/23), V5's
   standing gate, portals/TWA, C7 analytics, the deathmatch share surface,
   and the two sponsor loose ends in §3.4.

## 1. The V1–V3 closeout — all five verified in the working tree

- **The server has no pellet clamp.** `server/src/sim.ts:1092` loops
  `for (let i = 0; i < def.pellets; i++)` with no bound; the client clamps at
  `client/src/game/weapons.ts:1107` to `MAX_PELLETS = 16`, which is declared
  in the CLIENT and not shared. The two also read different sources — the
  server the `WeaponDef` double, the client `def.hot.pellets`, a **uint8**, so
  a pellet count of 256 would be 0 on one side and 256 on the other. The band
  (1..12, integer) makes it unreachable through a variant today; the band is
  data in a file and the clamp is not. Move `MAX_PELLETS` to shared and clamp
  both. **Check the lockstep golden does not move** — if reading `hot.pellets`
  on the server moves it, that is a behaviour change and it needs its own
  argument (rule 26).
- **`carveSphere` has no upper radius bound.** `server/src/world.ts:609`
  guards `radius <= 0` and nothing else. At 1e20, `y0 = Math.floor(cyf - 1e20)`
  is -1e20 and `for (let y = y0; y <= y1; y++)` **never advances**, because
  `-1e20 + 1 === -1e20`. One projectile blocks the event loop forever. NaN is
  not guarded either. `terrainDamage` is off the variant whitelist so nothing
  can reach it today — a defensive clamp still costs nothing.
- **`reserveMax` is read by NOTHING.** Declared at
  `shared/src/weapons.ts:119`, set on all seven weapons, and its only reader
  is `weaponsFingerprintInputs` (`shared/src/version.ts:356`). Reserve really
  comes from `AMMO_START` / `AMMO_MAX`. Either make it real or drop it — a
  field in the ratchet that changes nothing advertises a reserve-cap change
  that never happens.
- **THE WEAPONS RATCHET COVERS 13 FIELDS AND THE PREDICTORS READ MANY MORE.**
  `weaponsFingerprintInputs` lists damage, pellets, headshotMultiplier, rpm,
  magSize, reserveMax, reloadMs, splashRadius, splashDamage, terrainDamage,
  spread, spreadMax, spreadPerShot. It does NOT list `spreadAir`,
  `spreadRecovery`, `spreadCrouchScale`, `reloadShellMs`, `knockback`,
  `projectileSpeed`, `falloffStart/End/Min/Curve`, `automatic`, `spinUpMs`,
  `selfDamageScale`, `selfKnockbackScale` or `meleeRange` — every one of which
  a predictor reads. **This is what makes V3's guarantee smaller than it
  sounds** (HANDOVER §6): the wire carries the 16 whitelisted fields at their
  effective values, and everything else still comes out of each side's
  compiled table, unwatched. Measured: a client whose pistol `spreadAir` is
  0.028 against a server's 0.014 fires an airborne cold cone of
  0.03799999977648258 rad against the server's 0.02399999977648258, and no
  ratchet anywhere notices. Widening the list moves `WEAPONS_FINGERPRINT` and
  needs a weapons pack version bump in the same commit — that is the cost, and
  it is the right cost.
- **The horde SHOP delivery line has no test.** The code is right
  (`server/src/horde.ts:2054` already goes through `sim.statsFor`); the
  proven-red test only covers `equipStart` at :1054. Same one-line change,
  half the coverage.

## 2. V4 — the first content

`content/variants.json`, `ItemKind.WEAPON_VARIANT` tokens, the equip claim,
the craft recipe, the two-browser bar. The seams are already cut:
`RoomOptions.variantClaims` is where the profile's equipped claim goes in, and
`Room.onHello` already resolves it against `CAP_VARIANTS` and the room's slot
count before the first magazine is filled. V4 also owes three things named in
§3 and §6:

- the admin console has **no variants row** in its pack summary, so an
  operator cannot see installed versions;
- `maxBurstDamage` / `currentAmmoType` / `headshotScale` in
  `client/src/game/weapons.ts` still answer for the ARCHETYPE, so the HUD and
  killfeed show base numbers for an equipped variant;
- **the killfeed needs more than a name.** `S2C.KILL` carries a weapon id and
  `game.ts` calls `getWeapon(e.weaponId).name`, so two shotgun variants arrive
  as the same weapon. The killing shot's variant identity has to travel too.
  Per the V3 review, a display name is a SEPARATE additive message — opcode
  13's layout is frozen, and a `str name` appended to it would make a shipped
  V3 client read "Slug"'s length byte as `base` and its letters as the first
  float, 1.1589780174433289e24, silently.

Mid-session slot changes are NOT covered by the release pin: the table is
pinned for the life of a room, eligibility is not, and an unlocked room still
takes a `C2S_MODE.SELECT`. V3's encoder is written to be sent again and the
client's adoption is atomic and idempotent — but `adoptArsenal` is a SESSION
INITIALISATION act and says in its own comment what it cannot repair
(`cooldownMs`, `reloadRemainingMs`, spent reserve, projectiles in flight).
V4 needs an authoritative loadout boundary before it changes a slot on a live
player.

## 3. The achievement system — new, and it does not exist yet

Design it against what is already there rather than beside it: `ItemKind`,
the quests/challenges pack (`shared/src/challenges.ts`,
`server/src/challengeSettlement.ts`), the reward journal, the profile store,
and the admin console's Guides. Read `docs/ECONOMY.md` and `docs/PACKS.md`
before choosing a shape. The rules that will bite:

- **the server grants every reward** — a client that computes a balance is a
  client that can be argued with;
- **an achievement banked in a session that may not pay it needs a DEBT, not
  a counter** (rule 20 — `StoredChallenges.owed` is the shape);
- **a pack is data, never code** (Rule A, CSP `script-src 'self'`), so an
  achievement's CONDITION has to be expressible in the schema, not a
  predicate somebody ships;
- **mode availability is a column on the trust/mode table, never an `if`** —
  `trust.test.ts`'s tree scan fails any line pairing a `ModeId` literal with
  an economy word;
- and the standing tutorial directive: ship the player-facing surface AND the
  admin how-to alongside it.

## 4. Standing rules — these are not optional

Full suite green before any commit AND CAPTURED TO A FILE (three
load-sensitive flakes have appeared once each and passed in isolation:
`accounts.test.ts > signin`, `synth.test.ts` boot budget, `chunkz.test.ts`
compression ratio). `release:verify` is 17 checks and there are TWO gates —
`runReleaseVerify()` over the tree and `ReleaseService.runGate()` over a
draft — and adding a check to one does not add it to the other.
Commit → push → redeploy at every green stage.

**Prove every regression test red with its fix reverted, AND CHECK WHAT GOES
RED.** This is the rule that keeps paying. In V3, deleting one `case` from
`client/src/net/client.ts` left 43 shared codec tests, 32 version tests and 22
server tests ALL GREEN while a player fired eight shells at 11 damage against
the server's four at 10 — only the end-to-end test caught it. And removing the
room factory's `variants` line fails exactly one test in the repo, a source
scan, because no behavioural test can see a factory that forgot.

**Use Codex, and use it BEFORE the code.** It has overturned a central design
clause four sessions running; in V3 it killed the planned second half of the
phase outright. Drive the CLI directly — the subagent has failed with
identical flags:

    codex exec --sandbox read-only --cd /Users/karstenhaldan/youtube/doomcraft - < promptfile.txt

Give it the plan as numbered CLAUSES, tell it to attack each one, demand a
concrete failure scenario ending in a specific wrong number, and REQUIRE a
closing section listing the clauses it judges CORRECT so a clean bill is a
visible judgement. **Attack the CLAIM the artifact makes, not just the code.**
Then verify every finding yourself, both directions (rule 23) — in V3 all of
them reproduced, and its prescribed remedy for one of them was still wrong for
the phase.

**Deploys.** Railway from a CLEAN WORKTREE at HEAD (§4). Verify by the SERVED
BUNDLE'S CONTENT HASH, never `build.id` — it read `b453e8b` for a tree at
`6529e82`. On Vercel that comparison **cannot pass** unless you reproduce the
build id, because `__DC_BUILD_ID__` is inside the bundle being hashed:

    DOOMCRAFT_BUILD_ID=$(git rev-parse HEAD | cut -c1-12) \
      npx vite build --config client/vite.config.ts

Railway sets neither variable and falls to `'dev'`, so a plain `npm run build`
matches it. And `node tools/smoke-signal.mjs wss://<origin>` runs against
PRODUCTION — it is the only gate that can see a deployed binary whose room
factory forgot to pass its pinned content.

Owner seat: `~/youtube/doomcraft-owner-credentials.txt`. Sign in at
`/api/auth/signin` — there is no `/api/admin/signin`.
