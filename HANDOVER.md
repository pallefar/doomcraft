# Doomcraft — handover: where it stands, and what is left

Written 2026-09-05 (second session of the day). This one did the VARIANTS arc's
phase V1 end to end — the `SessionArsenal` seam, both predictors moved onto it,
and a byte-compared lockstep golden proving the refactor changed nothing — and
then, on the strength of an adversarial review of the V2 PLAN, fixed three
things that were wrong before any of it started. The largest: **the two
predictors have never agreed about where pellets go**, by up to 10.2 degrees on
a shotgun. Previous handovers are in git history at `b77d907`, `56b23c5`,
`108efa5`, `9da410b`, `bfdc647`, `557c7b6`, `ee0991c`. §0 is restated because it
keeps earning it — rules 25–28 are new and all four cost real time today.

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin: game, rooms,
  API, release tier, admin console at `/admin`. Railway project `doomcraft`,
  volume `/data`.
- **https://doomcraft.vercel.app** — static single-player, same bundle.
  **github.com/pallefar/doomcraft** — `main`.
- Owner seat claimed and durable: creds in `~/youtube/doomcraft-owner-credentials.txt`.
- CI: `tsc -b` + `vitest run` + `release:verify` on every push; all pushes green.
  Suite: **103 files / 2453 tests + 3 deliberate skips**. `release:verify` runs
  15 checks and emits 7 packs.
- Sponsors phase 2 (P2a log+report, P2b interstitial, P2c rewarded + Gate 5) is
  DONE and deployed; `sponsor_interstitial` / `sponsor_rewarded` are
  deliberately OFF, and flipping them is the user's launch call.

Read this, then `docs/VARIANTS.md` (the live arc — §7 now holds the three
decisions, taken today), `docs/SPONSORS.md`, `docs/ECONOMY.md`, `docs/PACKS.md`,
`ref/BAR.md`.

---

## 0. The rules this project learned expensively. Do not relearn them.

1. **"It compiles and tests pass" is not evidence.** Demand an import trace PLUS a
   boot with a screenshot or a measurement. `client/src/ui/wiring.test.ts` fails
   the suite when a UI module ships to nobody.
2. **A green test that cannot fail is worse than no test.** Prove every regression
   test red with its fix reverted — and check WHAT goes red. It catches real
   mistakes every time it is applied: this session TWO of the new tests passed
   with their own fix removed and had to be rewritten (see rules 21 and 22).
3. **Measure, don't eyeball.**
4. **The bar is real and fetchable** (`ref/`). The gauntlet is still **0/23**.
5. **`shared/src/flags.ts` NUL bytes are FIXED** (escapes now) — plain `grep`
   works on it again. rg is still NOT installed on this machine.
6. **Simulated-failure tests must pick platform-identical failure inputs.**
7. **A gate that verifies the wrong tree is worse than no gate.**
8. **Workflow/worktree agents check out HEAD** — commit first, then audit.
9. **`MemoryStore.load` returns the live object** — snapshot before mutating.
   **Vercel deploys from the REPO ROOT only.**
10. **Railway volume was root-owned and ate six days of writes silently.** After
    ANY volume/deploy surgery, `curl /api/version | jq .data` must say
    `{"writable": true}`.
11. **A capture that cannot fail is rule 2 for screenshots.** When a screenshot is
    the proof, look at the screenshot.
12. **The admin console is TWO giant template literals** (`server/src/admin/
    console.ts`). No backticks, ever, in that file's embedded JS — and no `${`
    in static content. All maths goes server-side; the console renders numbers.
13. **Two stores, two durability models: flush before you conclude.** Profile
    writes debounce ~800ms; service docs write synchronously.
14. **`FlagService` is IN-MEMORY.** Production durability = the Railway env
    `DOOMCRAFT_FLAGS`, which FULL-REPLACES the document at boot. A flag flip is
    an env update with the WHOLE intended document.
15. **Menu-time flag bits lie.** Gate every menu-time surface on the cached
    `/api/flags?device=` probe (`probeServerFlags`).
16. **Two adjacent CLEAR carves have no wall between them.**
17. **NEW — the Railway CLI lies twice.** `railway up` prints "operation timed
    out" while the upload has in fact landed and is building; and
    `railway variables --set DOOMCRAFT_BUILD_ID=…` ON ITS OWN triggers a
    redeploy of the OLD build wearing the NEW build id, so `/api/version`'s
    `build.id` can be a lie. Verify a deploy by probing a route the new build
    ADDS, never by the build id. Uploads can also zombie in INITIALIZING for
    ~10 minutes; a fresh `railway up` supersedes them.
18. **NEW — agent-written prose needs a verifier as much as agent-written code.**
    Two agents refreshed three docs and reported every claim verified; a third
    agent checking their work found fifteen real problems, including two FALSE
    claims and a `file:line` citation pointing at a closing brace. Never commit
    agent prose on the writer's own assurance.
19. **NEW — `git add -A` while a workflow writes into the same tree** commits a
    half-written file. Stage explicit paths, or wait for the workflow.
20. **NEW — money that cannot be paid yet needs a DEBT, not a counter.** A
    completion banked in a session that may not pay it must survive the period
    roll as a durable, period-stamped obligation. A counter gets wiped at UTC
    midnight and the player is silently robbed. `StoredChallenges.owed` is the
    shape; `settleChallenges` is the pattern.

21. **NEW — narrowing a flag does not fix the surface that consumed it.** The
    audit ring was flooded by honest refusals, so the fix looked like "stop
    calling them violations". My own new test then failed: the ring logs every
    REFUSAL, not every violation, so the rows were still pushed and an
    attacker's row was still evicted. When a finding names a downstream cost,
    ASSERT THE DOWNSTREAM COST — the eviction, not the flag.
22. **NEW — a multi-actor bug needs the other actors in its test.** The
    honest-reconnect test passed with its fix reverted, because with the room
    empty the round restarted and there was no collision to detect. It needed a
    second player who never leaves, plus an assertion that the session id did
    NOT change. A test whose scenario quietly fails to set up is rule 2 wearing
    a disguise.
23. **NEW — a second opinion needs verifying too, in both directions.** Codex
    confirmed all six claims independently and found a real bug nobody had
    (the payout `sourceId`). It also reported the journal's claim-before-write
    as a defect — it is a deliberate, documented tradeoff ("a lost row is a
    counter; a double payout is money") with counters already on two routes.
    Rule 18 is about agent PROSE; this is the same rule for agent FINDINGS.

24. **NEW — a `pairs()`-style render of an empty object is a broken table, not
    an empty one**, and backticks in `console.ts` terminate the template literal
    EVEN INSIDE A COMMENT (rule 12 applies to prose too). Both were found by
    looking at the screenshot and at the compiler, not at the test result.

25. **NEW — a gate that cannot PASS is worth exactly what one that cannot fail
    is worth.** `tools/smoke-signal.mjs` advertises itself as a deploy gate and
    its last check had been red on every build this repo ever produced: it
    opened `/ws`, waited 400 ms and asserted bytes had arrived, and the server
    deliberately says nothing until it hears a HELLO. Rule 2 has a mirror image
    and this is it.

26. **NEW — moving code behind a seam DESTROYS the lever your failure proof was
    using.** The instant `sim.ts` stopped reading `WEAPON_DAMAGE`, the tests
    that proved the lockstep golden could fail by poking that array went green
    for the wrong reason. The new lever has to be the seam itself: hand the
    session a different table and watch the shots move. Whenever you put an
    indirection in front of something, go and look at whatever was proving that
    thing was observed.

27. **NEW — "nothing moved" is not "they agree."** The lockstep golden
    concatenates a server track and a client track and compares the pair
    against history. That proves neither drifted. It never once asserted that
    corresponding shots MATCH — and they did not, by up to 10.2° on a shotgun,
    for the life of the project. Codex found this by attacking the claim rather
    than the code. If two things are supposed to agree, assert that they agree.

28. **NEW — your measuring instrument has precision too, and it lies first.**
    The agreement test failed by "0.01°" on every weapon while printing
    identical components, because `acos` has an infinite derivative at 1 and
    float noise in a dot product becomes 1.4e-4 radians of imaginary
    disagreement. Then it failed by 2e-8 because `ShotReport`'s direction
    arrays are Float32Arrays — the client's OBSERVATION channel is lossy even
    where its arithmetic is not. Only the third reading was about pellets.
    Before believing a small discrepancy, check the instrument.

## 1. What this session shipped (all pushed, green, deployed)

| Commit | What |
|---|---|
| `a120c24` | **The three VARIANTS §7 decisions, asked and written down.** DPS-dominant budget (0.50 dps / 0.20 range / 0.15 splash / 0.15 handling) at ±12%, an uncommon craft-only rarity floor, and variants table-gated OUT of ranked-adjacent modes. Plus the observation the user's own preview surfaced: a weighted sum at ±12% admits an "everything up 10%" variant, so §6's no-straight-upgrades rule needs a SECOND refusal — strict dominance — which is now part of the decision. |
| `7de757c` | **V1a — the lockstep determinism harness and its golden, minted pre-refactor.** Both shipping predictors, one script, two arenas, the same `ServerWorld` and the same shared `raycastVoxels`. Three things it took: the trigger has to be PULSED (a held trigger fires a semi-auto exactly once, so the first script recorded four pistol shots against four hundred chaingun ones); the chainsaw needs its OWN arena (2.6 m reach, so at seven metres the whole melee path went unwatched — and running all seven weapons at two metres instead recorded a rocket detonating in the shooter's face); and a respawn puts the victim on top of the shooter under a shield `resolveMelee` refuses. |
| `dd28363` | **V1b — `SessionArsenal`, with the two representations kept APART.** `weapons.ts` holds every weapon twice — doubles in `WEAPONS[i]`, narrowed values in the derived hot tables — and the narrowing is lossy for six of them (rocket splashRadius 4.4 → 4.400000095367432, and 60000/rpm for four weapons). The shipping code reads BOTH, three lines apart. `EffectiveWeapon` therefore carries the def's doubles AND a `hot` record, and unifying them is a separate change with its own argument. The test caught a bare range check letting `1.5` index a hole in the table. |
| `786c350` | **V1c — the server predictor fires from the arsenal.** Every reader on the firing path goes through `sim.statsFor(p, weaponId)`; zero module-table reads remain. A projectile now remembers the slot it was FIRED with, because a rocket in flight outlives a weapon switch. `SessionArsenal.from` landed here rather than in V2 because rule 26 demanded it. **The golden did not move.** |
| `e950dc4` | **V1d — the client predictor too. V1 closes.** `rt.stats(weaponId)` is the mirror of `sim.statsFor`. The failure proof became symmetric: an empty override changes nothing on either side, +1 pistol damage and +20 chaingun rpm move both, a one-centimetre splash radius moves only the server, a wider cone moves only the client. **The golden still did not move.** Verified in the real app — muzzle flash, tracer, an open dynamic crosshair, 13/20 magazine pips. |
| `949512f` | **A deploy gate that could not pass** (rule 25). And the first fix for it was ALSO wrong — it went green with the HELLO truncated to nonsense — so it now carries a negative control: one junk byte must be told nothing. |
| `1b7af11` | **Two live bugs the V2 plan review found in shipped code.** `parseItemsManifest('null')` threw a TypeError past every caller instead of refusing (the `root.items` access sits outside the try; `parseChallengesManifest` had it identically). And `HordeDirector.equipStart` refilled magazines from the compiled table on the JOIN path, after `spawnPlayer` had filled them through the arsenal — so a shotgun variant that pays for its damage with a smaller magazine would enter Horde holding the base's eight shells. Proven red at "expected 8 to be 4". |
| `b3902e0` | **V2a — the variant schema.** Three refusals: whitelist+bands, the ±12% budget, and strict dominance. PER-ARCHETYPE AXES, per the user's decision: an axis is scored only where it is LIVE, so nothing is 0/0, and an override of a field that archetype's firing path never reads is REFUSED rather than priced at zero. Two bands were doing balance work and refusing the document's own §1 slug shotgun — `damage` is now a wide rail with the real bound on the PAYLOAD (damage × pellets), and the cone rails go to a tenth. Proven red five ways. |
| `883d875` | **V2b — `PackKind.VARIANTS = 7`, its inventory branch, and BOTH gates.** `runReleaseVerify()` and `ReleaseService.runGate()` are separate implementations and the review found a candidate naming kind 7 gating GREEN through the second; reverting the new block reproduces it word for word. The inventory branch is only visible in the POSITIVE direction (the fallthrough already reports an unhandled kind), and the test says so at length. Rule 2 caught the wiring one level up: the check's own tests called it directly, so removing it from the gate's list left them all green. |
| `8c6f196` | **Three defects in V2, found reviewing the V3 PLAN against it.** An inherited property (`over: {"toString": 1}`) threw a TypeError out of BOTH validation paths, because `BANDS.toString` finds Object.prototype's method and is not undefined — `Object.hasOwn` now. `terrainDamage` was banded but charged by no axis, so 2.6 m -> 3.9 m of carve radius cost nothing; it is off the whitelist entirely (16 fields), which also removes the `carveSphere` hazard rather than banding it. And the PRODUCTION draft route dropped `picks.variants` while every service-level test passed — the same lesson one commit later — with `installedPacks()` omitting it too, so a routine draft would have silently dropped a live variants pack. |
| `c1a426b` | **Three more predictor disagreements fixed; the fourth named as unfixable.** A Float32Array damage tally drew kill markers for 99.99999904632568 damage. A weapon switch cleared the cone on the server and not the client (0.036 vs 0.010 rad). A pooled body inherited the last occupant's `shotSeq`. The fourth — the two schedule shots on DIFFERENT CLOCKS — cannot be reconciled by matching a formula, and trying made it worse. See §6. |
| `fc01475` | **THE BIG ONE: the two predictors now agree about where pellets go.** Five separate causes, each proven red alone — the cone was read AFTER the shot bloomed it (0.53° on a shotgun); the seeding schemes were unrelated and the server's used the ROOM seed the client never receives (6.6°); the server did not spread projectiles at all (0.75°, plasma only); the client's accumulated cone was float32 against the server's double (8.3e-9); and the shot counter wrapped on one side only (65 536 shots in, every cone diverges). `agreement.test.ts` is the assertion the golden never was, and the golden moved DELIBERATELY: 135 damage rows → 102, 10 kills → 14, and the pistol and shotgun now finish people they never used to. |

## 2. Architecture delta

```
THE VARIANTS SEAM (new, phase V1)
  shared/src/arsenal.ts      SessionArsenal.statsFor(weaponId, variantSlot) -> EffectiveWeapon
                             EffectiveWeapon = WeaponDef's doubles + a `hot` record holding the
                             SAME narrowed values the derived tables hold (they differ; on purpose)
                             SessionArsenal.from(overlays)  assembly only — validation is V2's
                             *Of() twins of the sync-contract functions; the id-taking originals
                             in weapons.ts are untouched and still serve ~100 display call sites
  server: Simulation(world, seed, arsenal = BASE_ARSENAL)   sim.statsFor(p, weaponId)
          PlayerEntity.variantSlots : Uint8Array(WEAPON_COUNT)
          Simulation.projVariant    : the slot a round in flight was FIRED with
          room.ts:409               THE V4 WIRING POINT — the pinned release becomes an arsenal here
  client: WeaponRuntime(fx, camera, projectiles, arsenal = BASE_ARSENAL)   rt.stats(weaponId)
          WeaponRuntime.variantSlots : the mirror of PlayerEntity's

THE SYNC CONTRACT (now actually one)
  shared/src/weapons.ts  shotSeed(ownerId, shotSeq, pellet)   moved here from the client
                         nextShotSeq(seq)                     16-bit wrap, one rule for both
  both predictors: read the cone, fire, THEN bloom; reseed PER PELLET; spread projectiles too
  client WeaponRuntime.heat is Float64Array, matching the server's double heatSpread

THE PROOFS
  client/src/game/lockstep.harness.ts  both predictors, one script, two arenas, one world
  client/src/game/lockstep.golden.txt.gz  gzipped recording; digest pinned inline in the test
  client/src/game/lockstep.test.ts     "nothing moved", + the gate proven able to fail
  client/src/game/agreement.test.ts    "and they AGREE" — the assertion the golden never was
```

## 3. What is left — decided order

0. **V2 IS DONE and the binary is LIVE** (`b3902e0`, `883d875`, deployed
   2026-09-05). That matters beyond "a stage finished": the pack kind's own
   rule is that the variants-aware BINARY must be live before any release names
   kind 7, or a host that predates it silently serves the previous release. It
   is. `release:verify` is 17 checks now and reports
   `variants.validate — no variants manifest installed`.

   **V3 IS DONE and deployed** (`6529e82`, `aeff8e2`, 2026-09-05):
   `S2C.VARIANT_TABLE = 13` and `CAP_VARIANTS = 1 << 5`, both additive; the
   room's table at effective values in f64 plus the player's resolved slot
   map; both ends building their arsenal from the decoded bytes; the pinned
   manifest resolved in the room factory; a golden vector; and a live deploy
   gate that a real origin passes. The authoritative shot number that was
   planned as its second half was CUT — see §6, where the three findings are.

   **V4 is the first content** — `content/variants.json`,
   `ItemKind.WEAPON_VARIANT` tokens, the equip claim (it feeds
   `RoomOptions.variantClaims`, which V3 built and left returning nothing),
   the craft recipe, and the two-browser bar. Two things V4 owes that V2
   deliberately did not build, plus the four §6 items V3 added:

   - **the admin console cannot see variants.** `PackInventory`'s summary maps
     items and quests into the packs screen and variants is not in it, so an
     operator has no way to look at installed versions. Harmless while no
     content exists; not harmless the day it does.
   - **the display readers still answer for the archetype.**
     `maxBurstDamage`, `currentAmmoType` and `headshotScale` in
     client/src/game/weapons.ts take a weapon id, so the HUD and killfeed will
     show base numbers for an equipped variant. They cannot be wrong until a
     variant exists.

1. ~~**V2 of the variants arc, and its plan needs rewriting before it is built.**~~
   DONE — kept below because the review findings it records are still the
   reason the code looks the way it does.
   The plan was put to Codex as twelve numbered clauses before a line was
   written, exactly as the standing rule says, and it came back with enough to
   block. §6 carries the findings; the two the user has already ruled on are
   settled (see below). What V2 must now be:

   - a `shared/src/variants.ts` parser modelled on `parseItemsManifest` **but
     not copied from it** — the null-root bug is fixed there now, and the copy
     would have inherited it;
   - a whitelist that BANDS EVERY FIELD IT ADMITS. The plan banded 12 of 18.
     The six unbanded ones include `terrainDamage`, which is passed straight to
     `world.carveSphere`, whose `for (let y = y0; y <= y1; y++)` never advances
     when `y0` is -1e20 because `-1e20 + 1 === -1e20`. One projectile would
     block the event loop forever;
   - INTEGER refusals, not just numeric bands. `pellets: 1.5` is inside 1..12
     and makes the server fire twice while the client fires once;
     `magSize: 7.5` makes a reload destroy a reserve round and load nothing;
   - **the budget, per the user's decision of 2026-09-05: per-archetype axes
     and measured currency.** An axis whose BASE value is zero is dropped and
     its weight redistributed (four of seven weapons have zero splash, so
     `splash/base_splash` is 0/0, and `Math.abs(NaN) <= 0.12` is false — the
     check would refuse every pistol variant rather than accept it). And an
     axis is only chargeable where it actually reaches that archetype's firing
     path: range is NOT an axis for projectile weapons (direct damage is stored
     at spawn and never has falloff applied — Codex built a plasma variant
     scoring exactly 1.0 while gaining 20% real damage), and `reloadMs` is not
     one for shell-reloaders (the shotgun reloads on `reloadShellMs`, so
     doubling `reloadMs` costs nothing at all);
   - `PackKind.VARIANTS = 7` **with its `PackInventory.unsatisfied()` branch in
     the same commit**, and — separately — the production release gate wired.
     `runReleaseVerify()` in gate.ts and `ReleaseService.runGate()` in packs.ts
     are two different implementations; adding a check to the first does not
     add it to the second, and a candidate naming kind 7 currently gates GREEN
     and then falls back at serve time;
   - a canonical fingerprint line that fits the gate's 160-byte cap.

2. **The gauntlet — 0/23.** Then portals/TWA, C7 analytics.
3. **Deathmatch share surface** — needs its own `#ui` element.
4. **The sponsors loose ends**: no screenshot harness for the REWARDED overlay
   (S10's is `tools/shot-interstitial.mjs`), and no Basic Training drill for
   either sponsor surface — the PLAYER half of the standing tutorial directive.
   The admin half shipped as Guides 9.

## 4. Deploy runbook (follow exactly)

- **Vercel (static): from the REPO ROOT** — `npx vercel --prod --yes`.
- **Railway (origin):** from a CLEAN WORKTREE at HEAD: `git worktree add <tmp>
  HEAD && cd <tmp> && railway link --project doomcraft --service doomcraft &&
  railway up --detach`, then POLL `railway deployment list --json` until the
  newest is SUCCESS. Rule 17: the CLI's timeout message is not a failure, and
  the build id is not proof.
- **Verify THREE things**: newest deployment == SUCCESS; a route the new build
  ADDS answers; `curl /api/version | jq .data` → `{"writable": true}`.
- **WHEN THE BUILD ADDS NO ROUTE** — a refactor, a fix — rule 17 leaves you with
  nothing to probe, and `build.id` is a lie (it is a Railway env var and was
  reading `b453e8b` for a tree whose HEAD was `e950dc4`; on 2026-09-05 it still
  read `b453e8b` for a tree at `6529e82`). Use the SERVED BUNDLE'S CONTENT HASH
  instead: `curl -s <origin>/ | grep -o 'a/index-[A-Za-z0-9_-]*\.js'` must equal
  the `dist/a/index-*.js` your own `vite build` just produced. Vite hashes by
  content, so it is falsifiable and it cannot be faked by a redeploy of the old
  build.
- **CORRECTION 2026-09-05 — that rule as written CANNOT PASS ON VERCEL.**
  `client/vite.config.ts` defines `__DC_BUILD_ID__` from
  `DOOMCRAFT_BUILD_ID ?? VERCEL_GIT_COMMIT_SHA.slice(0,12) ?? 'dev'`, so the
  build id is IN the bundle and a Vercel build can never hash-match a plain
  local one. Reproduce the define and it matches exactly:

      DOOMCRAFT_BUILD_ID=$(git rev-parse HEAD | cut -c1-12) \
        npx vite build --config client/vite.config.ts

  Railway builds in Docker with neither variable set, so it falls to `'dev'`
  and a plain `npm run build` DOES match it. Both were verified this way today
  — Vercel `index-1hTZaGmG.js`, Railway `index-Bc3PgK_D.js`, each equal to the
  local build made with the same define.
- **Flag changes**: update the Railway env `DOOMCRAFT_FLAGS` with the FULL
  document (rule 14). Currently forces the five economy flags.
  `sponsor_interstitial` / `sponsor_rewarded` are deliberately OFF — flipping
  them is the user's launch call, not an engineering gate.
- **`node tools/smoke-signal.mjs wss://<origin>` is a LIVE gate and it runs
  against production.** It now includes the V3 wire: a HELLO with
  `CAP_VARIANTS` must be answered with opcode 13, and one without it must not
  be. That is the only check anywhere that can see a deployed binary whose room
  factory forgot to pass its pinned variants manifest. Proven able to fail by
  clearing the bit in the tool's own HELLO.
- Proof harnesses: `tools/shot-challenges.mjs` (the board, with the wire read
  back), `shot-loadout.mjs`, `shot-trade.mjs`, `shot-competitions.mjs`,
  `shot-share.mjs`, `shot-tutorial.mjs`, `shot-console.mjs <tab>`.

## 5. Blocked on the user, not on engineering

A domain · AdSense/GAM + a games ad network + a CMP (before any third-party tag;
this gates only the third-party half of sponsors — the first-party work above is
not blocked) · WorkOS / Paddle / PostHog accounts · ElevenLabs key · legal review
before real-money prizes · Play Console $25 / Apple Developer $99 / Steamworks
$100 · a Mac with Xcode · GTA mode has no obtainable bar.
## 6. What is deliberately still open

Findings this session produced and chose NOT to act on, so none is mistaken for
oversight.

**THE SHOT CLOCKS DIVERGE, AND THE CONE SEED RIDES ON THEM. Read this before
V3 or V4 promises anything about prediction.**

The server schedules on a tick (`nextFireMs = now + interval`); the client
accumulates into a per-frame cooldown. Neither is wrong and they cannot be made
to agree by matching a formula — porting the client's carry-the-overshoot rule
to the server let a pistol fire its second round 17 ms after its first, because
that difference is only an overshoot while the trigger is held.

**CORRECTION, 2026-09-05 (V3): the "20 ms tick" this paragraph used to name is
NOT production.** `TICK_MS` is 50 (20 Hz, shared/src/constants.ts) and
`Room.step` uses it; 20 is `agreement.test.ts`'s own harness constant. The
measured "three rounds against four over a 40-tick burst" is therefore a
statement about the harness, not about a shipping room. The PHENOMENON is real
— two different quantisations of the same fire interval — but the ratio has not
been measured at 50 ms.

The consequence is bigger than one shot, because the cone seed is
`shotSeed(ownerId, shotSeq, pellet)` — once the counts differ, every later shot
is seeded differently on the two sides. **The bit-identical cone proof in
`agreement.test.ts` holds FOR A GIVEN SHOT NUMBER; the numbers themselves
drift.** `compareShots` therefore compares per BURST, checks the magazine by
RATE and the sequence by BOUND, and says so where it asserts.

**AND "the server tells the client which shot it resolved" IS NOT THE FIX. This
was V3's planned second half and it was CUT, before any of it was written, on
three findings that were then reproduced here.**

1. **An in-order acknowledgement reuses a seed.** The client predicts shots 1
   and 2; the ack for shot 1 arrives and assigns `shotSeq = 1`; the next
   `fireOnce()` pre-increments to 2 **again**. For owner 1, pellet 0, that
   re-uses seed 3087140845 where the next local shot should have used
   1394675828. No reordering required.
2. **No assignment rule using only the two counters can be right.** Client at
   3 receives ack 4. Its next shot is 5 — which matches the server only if the
   server is still at 4. If the server has already resolved 5 and that ack is
   in flight, the server's next is 6. The client cannot tell those two
   histories apart.
3. **The decisive one: aligning the COUNT does not align the CONE.** Three
   pistol shots leave `heatSpread` at 0.027999999999999997; four leave 0.03.
   Advancing the counter from 3 to 4 does not apply the missing bloom, so both
   sides can agree on shot 5 and still hand `currentSpreadOf` different heat.
   The shot number was never the only state that drifted.

   (Also: `deathmatch.ts:752` reads `weapons.shotSeq` ticking as a first-shot
   timer, so an authoritative assignment would stamp a first-shot time for a
   runtime that never fired.)

A real reconciliation needs an authoritative simulation/input boundary and
enough weapon state to replay outstanding prediction, or authoritative shot
effects. A counter is not that design. Until somebody builds it the server is
authoritative and the client's tracer pattern is cosmetic after the first
divergence — which is what this section said before, and is still true.

**From the V2 plan review (Codex, before any code was written).** Every one
below was independently reproduced here before being written down — rule 23.

- **`reserveMax` is read by NOTHING.** It is declared on `WeaponDef`, set on all
  seven weapons, and its only reader is `weaponsFingerprintInputs`. Reserve
  actually comes from `AMMO_START` / `AMMO_MAX`. If V2 admits it to the variant
  whitelist, a variant can pay budget for a field that changes nothing while
  moving the pack fingerprint — the console diff would advertise a reserve-cap
  change that never happens. Either drop it from the whitelist or make it real.
- **`variantSlots` is delivered by nothing.** V3 sends the room's TABLE; the
  per-player equipped CLAIM has no carrier, so both sides sit at slot 0. The
  user's decision of 2026-09-05 is that V3 delivers it too — the server-resolved
  per-weapon slot map rides the same message — so V4 adds ownership rather than
  ownership plus a handoff.
- **The server has no pellet clamp.** `client/src/game/weapons.ts` clamps to
  `MAX_PELLETS` (16); `sim.ts` loops `i < def.pellets` with no bound. Nothing
  can reach it today (max is 7) and V2's band contains it — but the band is
  data in a file and the clamp is not.
- **`ShotReport`'s direction arrays are Float32Arrays** and their own comment
  says "the netcode layer replays these". Anything replaying a shot from a
  report is replaying a narrowed vector, which the server — now exact — will
  not reproduce. Worth a look before V4's kill-log agreement bar.
- **The decoder accepts a TRUNCATED hello and issues a welcome anyway.** Same
  leniency family as `decodeSessionConfig` reading with no `r.remaining` guard.
  Tightening it is a protocol move with its own golden vectors.
- **`carveSphere` has no radius sanity bound.** See §3; V2's band is the fix
  being planned, but a defensive clamp in `world.ts` would cost nothing.
- **The horde SHOP delivery line is unpinned.** `equipStart` is covered by a
  proven-red test; the shop's identical one-line change has no test of its own.

**From the V3 plan review (Codex, before any code was written).** Every one
below was independently reproduced here before being written down — rule 23.

- **THE WIRE NARROWS THE TRUST SURFACE; IT DOES NOT ABOLISH IT.** V3's plan
  claimed that sending effective values means "the client never combines the
  wire with its own compiled table". That is true of the 16 whitelisted
  fields and FALSE of everything else: `SessionArsenal.from` spreads the
  decoded overlay over the receiver's own `WEAPONS[base]`, so `spreadAir`,
  `spreadRecovery`, `spreadCrouchScale`, `reloadShellMs`, `knockback` and the
  feel fields still come out of the bundle. A client whose pistol `spreadAir`
  is 0.028 against a server's 0.014 fires an airborne cold cone of
  0.03799999977648258 rad against the server's 0.02399999977648258, and no
  field on this wire touches it. **Worse: that divergence is invisible to
  `weaponsFingerprintInputs()`, which lists 13 fields and does not list
  `spreadAir` either.** Slot 0 is entirely compiled, as it always was. Closing
  it is a content-ratchet change — widen the weapons fingerprint, bump the
  weapons pack — and it is a real one, not V3's.
- **The room factory is where this class of bug lives.** `8c6f196` was the
  production draft route dropping `picks.variants` while every service-level
  test passed. V3 has the same shape one layer on: an installed, approved
  variants pack that never reaches `new Room(...)` makes every room serve an
  empty table forever with the whole suite green. Proven: removing the line
  from index.ts fails exactly ONE test in the repo, and it is a source scan.
- **`CAP_VARIANTS` is not optional and the ordering is not either.**
  `NetHub.onHello -> Room.onHello -> Simulation.addPlayer -> spawnPlayer ->
  first magazine fill` all happens before `host.onHello` returns, so a slot
  written after that call is a slot that arrived after the magazine it was
  meant to size. `addPlayer` takes the slots now.
- **A mid-session slot map is NOT covered by the release pin.** The TABLE is
  immutable for the life of a room; eligibility is not. An unlocked room still
  takes a `C2S_MODE.SELECT` (`Room.applyPlan`), so §7.3's `variantsAllowed`
  column can change under a live connection, and V4's revocation rule can too.
  V3 sends once because every slot is 0 today; the encoder is written to be
  sent again and the client's adoption is atomic and idempotent, which is what
  V4 needs. **What adoption CANNOT repair mid-match**, and why it is a
  session-initialisation act only: `cooldownMs` was accumulated from the old
  fire interval, `reloadRemainingMs` from the old reload time (start a base
  pistol reload, adopt a `reloadMs: 1000` variant, and 850 ms of the old one
  is still ticking), reserve ammunition is already spent, projectiles in
  flight carry the old numbers, and re-deriving the loadout manufactures ammo.
- **`S2C.SNAPSHOT` is UNRELIABLE and opcode 13 is RELIABLE**, so on the WebRTC
  peer topology a snapshot can precede the table and the client can be
  `playing` before it has adopted. Pre-existing — SESSION_CONFIG's flag bits
  have exactly the same property — and harmless while every slot is 0. V4 must
  distinguish "table pending" from "a server too old to send one"
  (`NetClient.variantsAdopted` is the flag, and it is not yet a gate).
- **V4's killfeed needs more than a name.** `S2C.KILL` carries a weapon id and
  `game.ts` calls `getWeapon(e.weaponId).name`, so two shotgun variants arrive
  as the same weapon. The killing shot's variant identity has to travel too —
  and the display readers `maxBurstDamage` / `currentAmmoType` /
  `headshotScale` still answer for the archetype (§3).

**Carried forward.**

- **A reconnecting player still loses their post-reconnect earnings.** The fix
  is a feature: hold the membership in a 30–60 s "awaiting reconnect" grace
  window keyed on `deviceId`, re-attach with `joinedMs`/`baseKills` intact, and
  settle only on expiry or `endRound`.
- **The 32-bit device hash is a floor, not an identity**; orientation is never
  captured, so §3.5's mobile-portrait split is refused by name rather than
  approximated.
- **The interstitial's daily cap is in memory** — conservative for a cap that
  protects a player, and NOT acceptable for a rewarded grant, which is why P2c
  put those on the profile.
- **The journal claims its idempotency key BEFORE the write.** A deliberate,
  documented tradeoff ("a lost row is a counter; a double payout is money").
  Recorded so it is not re-raised. See rule 23.
- **`docs/SPONSORS.md:1338` claims a settlement layer shipped. It did not.**
- **OBSERVED FLAKE, not diagnosed.** `server/src/accounts.test.ts > signin`
  failed once in roughly six full-suite runs on 2026-09-05 and passes in
  isolation. It did NOT recur in the six full runs of this session, and this
  session's runs were captured to files precisely so the next one is not lost
  again. Still worth a real look before it is trusted as a gate.
