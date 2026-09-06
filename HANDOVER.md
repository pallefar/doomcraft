# Doomcraft — handover: where it stands, and what is left

Written 2026-09-05 (FOURTH session of the day). This one **closed the V4 arc
end to end (a through f)** and **finally ran the gauntlet, which is now 1/23**.

The two headline facts are uncomfortable and both are about instruments rather
than code. First: the gauntlet's very first output was evidence that this
project's own foundational document was wrong — `ref/BAR.md` had called gunfeel
"the single most winnable piece" on the strength of a clip in which the bar was
holding a SHOVEL. With a rifle the bar has muzzle flash, brass ejection, impact
decals, per-shot recoil, a reload animation and a crosshair that blooms 57%. Two
blind verdicts were correctly thrown away before one could stand. Second: almost
every defect worth finding this session was inside something meant to CATCH
defects — a probe that could not distinguish the state it was clearing, a
byte-cap example both candidate caps reject, a regex that cannot match the
identifier it guards, a proof obligation that passes with the bug live, and a
fairness disclosure that de-anonymised the blind it was protecting.

Previous handovers are in git history at `b77d907`, `56b23c5`, `108efa5`,
`9da410b`, `bfdc647`, `557c7b6`, `ee0991c`. §0 is restated because it keeps
earning it — **rules 35-38 are new and 38 changes how you write tests.**

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin: game, rooms,
  API, release tier, admin console at `/admin`. Railway project `doomcraft`,
  volume `/data`.
- **https://doomcraft.vercel.app** — static single-player, same bundle.
  **github.com/pallefar/doomcraft** — `main`.
- Owner seat claimed and durable: creds in `~/youtube/doomcraft-owner-credentials.txt`.
- CI: `tsc -b` + `vitest run` + `release:verify` on every push; all pushes green.
  Suite: **107 files / 2622 tests + 3 deliberate skips** (2026-09-05, third
  session). `release:verify` runs **17 checks** and emits 7 packs.
- **The live origin serves `weapons@2`** — the weapons ratchet widened from 13
  fields to 38 and the pack version moved. The live release is `revision 0,
  ordinal 1`, i.e. the COMPILED-IN builtin: no stored release document has ever
  been promoted, which is why the weapons bump orphaned nothing (§0 rule 34).
- Sponsors phase 2 (P2a log+report, P2b interstitial, P2c rewarded + Gate 5) is
  DONE and deployed; `sponsor_interstitial` / `sponsor_rewarded` are
  deliberately OFF, and flipping them is the user's launch call.

Read this, then `docs/VARIANTS.md` (the live arc — §7 now holds the three
decisions, taken today), `docs/SPONSORS.md`, `docs/ECONOMY.md`, `docs/PACKS.md`,
`ref/BAR.md`.

---

## 0. The rules this project learned expensively. Do not relearn them.

Thirty-nine is too many to read cold, so read these four first — they are the
ones that have cost the most, and every other rule is a special case of one of
them or an operational fact.

  **2 · A green test that cannot fail is worse than no test.** Its costumes:
     11 (a capture that cannot fail), 25 (a gate that cannot PASS),
     38 (a proof obligation that cannot DISCRIMINATE). Six gates in this repo
     were found green while testing nothing; one had signed off every deploy in
     the project's history.
  **33 · Write briefs from the CODE, not from prose.** Its costumes: 18 (agent
     prose needs a verifier), 23 (verify a second opinion in BOTH directions).
     Every runtime claim that entered a plan unexecuted this project has been
     wrong — from a handover, from another model, and from my own harness.
  **37 · A comparison only informs where both sides could plausibly win.** Its
     costumes: 3 (measure, don't eyeball), 28 (the instrument lies first),
     39 (the memory index leaks the answer). Three times the bar capture was
     stale in OUR favour.
  **29 · Two doors onto the same data must accept the SAME SET.** Its costumes:
     30 (rank the failure modes before choosing a side to tighten), 31 (a fix
     you order can open the hole next door).

Then, by theme:
  proofs losing their lever  21, 26, 27, 32
  the running system vs code 1, 34, 35
  platform and tooling       5, 8, 9, 10, 12, 13, 14, 15, 17, 19, 24
  domain facts              6, 7, 16, 20, 22, 36


1. **"It compiles and tests pass" is not evidence.** Demand an import trace PLUS a
   boot with a screenshot or a measurement. `client/src/ui/wiring.test.ts` fails
   the suite when a UI module ships to nobody.
2. **A green test that cannot fail is worse than no test.** Prove every regression
   test red with its fix reverted — and check WHAT goes red. It catches real
   mistakes every time it is applied: this session TWO of the new tests passed
   with their own fix removed and had to be rewritten (see rules 21 and 22).
3. **Measure, don't eyeball.**
4. **The bar is real and fetchable** (`ref/`) — AND IT WAS WRONG ABOUT ITSELF
   until 2026-09-05; see rule 37. The gauntlet is **1/23**: gunfeel won a blind,
   uncontaminated A/B, and HUD is piece two.
5. **RETIRED** (the `flags.ts` NUL bytes were fixed long ago and plain `grep`
   works). The one live fragment: **rg is still NOT installed on this machine.**
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

29. **NEW — TWO DOORS ONTO THE SAME DATA MUST BE PROVEN TO ACCEPT THE SAME SET,
    and "each one refuses bad input" is not that proof.** A strict `< 0` rail
    went onto the variant WIRE DECODER while the PARSER's band check tolerated
    `EPS = 1e-9`. So `spreadPerShot: -1e-10` parsed with zero errors,
    `variants.validate` said ok, and a real Room served **0 variant rows with
    slotCount 1** — a published pack serving nothing, no error anywhere. Every
    test exercised one door or the other; none tested the agreement. **The fix
    is not duplicating the checks: two copies drift.** The archetype-free rules
    now run as a CONTIGUOUS PREFIX in the same order on both sides — two lists
    agree by construction only when one is literally the prefix of the other.
    The invariant is a sweep over band edges, the epsilon boundary, zero, −0 and
    the representability limits (7616 probes; it named 108 leaks on the old code).

30. **NEW — rank failure modes before choosing which side to tighten. A gate
    that says GREEN while the runtime serves something else is the worst outcome
    available** — worse than a refusal, which is loud and fixable. That ordering
    made the PARSER the side that had to move. It is also why an unparseable
    newest pack now fails the gate instead of silently vanishing from the pack
    set — and why refusing to ASSEMBLE was rejected: `installedPacks()` feeds
    `hostFallback()` on the never-throws room path, and a content typo must not
    become an outage. Refuse where it is affordable — at publish, not at room
    build.

31. **NEW — a fix you order can open the hole next door.** Putting a variant's
    display `name` into its fingerprint inputs closed "approve one string, serve
    another" — and the pack digest is `inputs.join('\n')`, so a name carrying a
    NEWLINE would let a one-variant manifest hash exactly as a two-variant one.
    When you add a field to any serialized identity, ask what the SEPARATOR is,
    whether the new field can contain it, and what it makes newly reachable.
    Related: a free-form token in a delimited line is unambiguous only where it
    is TERMINAL, and that placement must be ASSERTED or the next person moves it.

32. **NEW — "I cannot prove this red" is an answer; faking one is not.** A rail
    unreachable on today's data has no red proof, and contriving an input the
    product cannot produce does not make one. Say so, keep the guard if it makes
    two paths agree by construction, and add a RATCHET test that fires the day
    the data moves close enough to make it live.

33. **NEW — write briefs from the CODE, not from a review. FIVE OF SIX briefs
    written on 2026-09-05 contained a claim the builder correctly overturned:**
    "sandbox and the tutorial call `grantAllWeapons`" (no caller exists);
    "hitscan is unaffected" (melee was wrong SYNCHRONOUSLY — a punch fires as
    `tryFire(p, CHAINSAW)` while you hold something else); "a value must survive
    its own narrowing" (false for f32 — `f32(4.4)` is 4.400000095367432, so the
    rule would refuse the compiled table itself); "the hitmarkers read this
    field" (they read flags and amount); plus two Codex constants relayed
    unchecked. Every brief now ends with an explicit instruction to report
    anything in it that is wrong, and that sentence is the highest-yield line in
    the template.

34. **NEW — read the code to find a MECHANISM; read the RUNNING SYSTEM to find
    out whether it APPLIES.** The `weapons@2` bump was called a blocking deploy
    hazard all session: a stored release naming `weapons@1` becomes
    unsatisfiable and the fallback is silent. The mechanism is real. But
    `/api/version` said `revision 0, ordinal 1`, and revision 0 is the
    compiled-in builtin that no document can ever assign — **no stored release
    was live, so there was nothing to orphan.** One `curl` would have settled it
    hours earlier. The hazard stays documented: it bites the first time somebody
    promotes a stored release and then ships a build-pack bump.

35. **NEW — and rule 34's own probe could not have told you.** `/api/version`
    publishes `ReleaseService.live()`, and `live()` returns `hostFallback()` —
    revision 0, `unsatisfied: []` — in BOTH of two very different worlds: no
    stored release exists at all, and a stored release exists that this host
    ALREADY cannot satisfy (`server/src/packs.ts:746`). Rule 34's conclusion
    was right and its evidence was compatible with the exact failure it was
    clearing. A post-fallback readout cannot separate "nothing configured"
    from "configured and already broken" — hiding that difference is what a
    fallback is FOR. The probe that settles it is `GET /api/admin/release`,
    which returns the raw `document`: on the live origin today `history: []`,
    `liveRevision: 0`, `pendingRevision: 0`, so the document is genuinely
    empty. Ask of every probe which distinct states it maps onto the same
    output, and whether the state you are trying to rule out is one of them.

36. **NEW — an effect that is both PREDICTED and ECHOED must MERGE, not
    assign.** The brief said `sim.ts` passes a literal 0 for flags on entity
    damage, "so a monster kill never shows the fatal hitmarker". True, and
    understated in a way that would have produced a wrong fix. The client
    PREDICTS the kill ring on the frame it fires, and `Hud.hitMarker` was a
    plain assignment — so the server's flagless echo of the PREVIOUS shot
    landed ~one RTT later and repainted it white, about 60 ms into a 460 ms
    ring, on every demon kill in the game. The marker was not missing, it was
    CANCELLED. Fixing only the server's flags leaves the identical class live
    for shotguns: one predicted 70-damage marker against seven 10-damage pellet
    echoes, which shrinks the marker's heft to a graze. The fix is a merge with
    a monotone order inside the effect's own lifetime — plain < headshot <
    kill, damage takes the max, a re-raise never shortens — and a clean slate
    when the timer expires, so the latch is a window and not a mode. "The
    server is authoritative" does not mean "the server's later message should
    overwrite" when the two messages describe DIFFERENT events. In the same
    pass: a monster headshot was never COMPUTED, so the client drew a gold
    marker AND a doubled damage number while the server applied single damage.
    **The code for this lives on the `gauntlet` branch, not on `main`** — it is
    the gunfeel piece's round-1 build and merges when that piece wins its blind
    A/B. The rule is what generalises; the diff is not on main yet.

37. **NEW — a comparison only carries information where BOTH SIDES COULD
    PLAUSIBLY WIN, and the bar has to be able to exhibit the thing under
    test.** The first blind A/B this project ever ran picked ours for gunfeel
    and then set `contaminated: true`, because the critic worked out which side
    was which from the content alone. Its sentence is the rule:
    **"B won a test the bar structurally could not sit."** It measured the
    reference clip — background pan of 1 px per sampled frame against ours at
    8-29 px, a player holding a SHOVEL, zero muzzle flashes and zero decals in
    twelve frames — for the question "which shot feels like it hit something".
    The bar had no shot. Winning that proves nothing about the build; it is a
    fact about the capture. `ref/voxiom/desktop-gameplay.webm` is still the
    right bar for movement and art and the wrong one for gunfeel;
    `ref/voxiom/desktop-gunfight.webm` was captured to replace it, with
    `desktop-gunfight-drive.json` recording how it was driven so the next
    person can tell what it can and cannot answer. Before trusting any A/B, ask
    what the BAR's frames actually contain for the specific question.

38. **NEW — A CLEAN REVIEW VALIDATES THE CLAUSES; WHETHER A PROOF OBLIGATION
    CAN DISCRIMINATE IS A SEPARATE PROPERTY, AND NOBODY WAS CHECKING IT.** The
    V4d plan passed an adversarial review 10 of 10, "BROKEN: None" — and one of
    its own proof obligations could not have caught the bug it was written for.
    It asked for "a pooled event reused across two kills with DIFFERENT SLOTS".
    The real defect is `if (variantSlot !== BASE_SLOT) e.variantSlot = slot`,
    and two NONZERO slots pass straight through it: 1 then 2 reports 1 then 2,
    correctly. The zero is the whole test — a base-weapon kill inheriting the
    previous variant kill's slot. Proven both ways in thirty seconds of node.

    This is the THIRD instance in one session of the instrument meant to catch a
    bug being unable to. The others: a 434-byte example offered as proof of a
    UTF-8 byte cap, which BOTH candidate caps reject and which therefore
    discriminates nothing (the row that separates them is 237 bytes / 93 code
    units); and `/\bvariant/i` proposed as the trust-scan term, which cannot
    match `ItemKind.WEAPON_VARIANT` because `_` is a regex word character.

    THE CHECK, and it is cheap: for every assertion, name the WEAKEST INPUT that
    still satisfies the predicate, then ask whether the defect survives it. If
    the defective implementation and the correct one produce the same value on
    your chosen input, the test is decoration. Write the input where they
    DIFFER, and say in the test why that input and not the obvious one.

39. **NEW — THE ASSISTANT'S OWN MEMORY INDEX IS A CONTAMINATION CHANNEL FOR
    BLIND EVALUATION, and no mask can close it.** The MENUS piece was judged
    four times and binned four times. The last critic opened nothing outside the
    blind directory, ran no greps, compared no timestamps — and identified both
    sides anyway, from **its own preloaded memory index**, which names this
    product's modes and level sources verbatim: "5 modes + 3 fetchable bars
    (voxiom, DOOM 1993, Minecraft Classic)", "Horde is the mode that justifies
    the mash-up", "Basic Training episode". Our menu renders exactly those
    strings — `HORDE`, `Bar: DOOM (1993) E1M1 "Hangar"`, `Basic Training I:
    Move` — so it read the labels off the screenshot and matched them against
    context it never asked for.

    Every subagent spawned from a session with that index boots with it.
    Widening `MENU_MASKS` cannot help, because **on this piece the content that
    identifies the product IS the content under review** — masking the mode grid
    destroys the thing being judged.

    SCOPE, checked rather than assumed: the leaked strings are all MENU-screen
    strings. The gunfeel contact sheets show a wall and a muzzle flash; the HUD
    frame shows a minimap, timer, health and ammo. Neither renders a mode name
    or a level title, and both of those critics reported `contaminated: false`
    unprompted — "I could argue either direction", "I hold no confident belief
    about the mapping". Those two verdicts stand.

    So: **a piece whose artifact displays proper nouns this project has written
    down cannot be blinded by a subagent of this session.** Judge menus, mode
    select, level select and anything else name-bearing from a session with the
    memory store detached, or accept that it is unscorable and say so. Do not
    re-run until a verdict happens to survive; four attempts is already three
    too many, and the fifth would not be evidence, it would be sampling.

## 1. What this session shipped (all pushed, green, deployed)

| Commit | What |
|---|---|
| `2111f94` | **V4b — the ownership token, and the five doors that mint an inventory.** `ItemKind.WEAPON_VARIANT = 5`, `ItemDef.variantId`, and a parser BICONDITIONAL making the id prefix a rule rather than a convention. It also fixed a LIVE defect that was the bug `8c6f196` fixed in variants and never fixed in items: the kind/rarity lookups admitted `Object.prototype` members, so `kind:"constructor"` parsed with zero errors, `ItemDef.kind` became a FUNCTION, and `constructor` and `toString` emitted the IDENTICAL fingerprint line — two manifests, one digest. Five paths mint an inventory and three would have handed out variants on day one; the fix is mint-vs-transfer, not a blanket refusal, because trade settlement goes through the same chokepoint. |
| `4bec466` | **BAR.md corrected — the bar has a gun.** Re-captured in Capture The Gems, which hands you a rifle at spawn. `tools/capture-ref-gunfight.mjs` and `tools/viewmodel-motion.mjs` are new; the latter exists because the obvious instruments lie — a plain frame-difference scored 3.3× for the shovel and 3.25× for the rifle, identical, because both boxes contain panning background. |
| `8a61206` | **V4c — the claim reaches the body.** 23 red proofs, one honestly reported as STAYING GREEN. My own plan contained the slot off-by-one it existed to prevent, and my proposed trust-scan guard (`/\bvariant/i`) could never have matched `WEAPON_VARIANT`. The builder then overturned the repair with two verified false positives and found that `ModeId.RANKED*` self-matches the economy regex. |
| `7109306` | **THE GAUNTLET SCORES ITS FIRST POINT — gunfeel, blind and uncontaminated.** Our shot lights the room; the bar's does not. Verified independently: per-tile left-region mean luminance swings +36.2% across our twelve frames, phase-locked to the shot cadence, against +1.6% for the bar, whose wall is flat to within one luminance level. |
| `2f47842` | **V4d — the killfeed names the gun that fired.** A 9th KILL byte plus `S2C.VARIANT_NAMES = 14`. The plan passed review 10/10 and one of its obligations was VACUOUS — the origin of rule 38. |
| `4a45544` | **V4e — the entry recipe.** §7.2 was circular: a variant craft needs three variants and supply was zero. Also fixed a LIVE bug (the craft UI offered what the server refused, because `craftTargetsFor` took raw copies with no escrow and no balance) and deleted a latent trap (`crafted = landed[0]?.ref ?? v.plan.targetRef` reported an item never delivered). |
| `baebe22` | **V4f — the equip button.** V4c had landed only the server half. `GET /api/variants` mirrors `/api/items`. Two more live bugs between the claim and the screen: the profile decoder dropped `inventory.variants`, and a SUCCESSFUL equip repainted from the claims it had just replaced so the button flipped straight back. |
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

**V4 (a-f), all shipped and live.** The seam below is unchanged; this is what
now rides on it.

```
THE VARIANT AS A THING A PLAYER OWNS
  shared/src/items.ts    ItemKind.WEAPON_VARIANT = 5, ItemDef.variantId
                         BICONDITIONAL: kind === WEAPON_VARIANT iff
                         id === "weapon_variant-<variantId>"  — so the kind is
                         readable off a REF with no pack registry, which is what
                         lets grantDrops decide without an async lookup
  persistence.ts         StoredInventory.variants: Record<baseWeaponId, ref>
                         EquipSlot = 'skin' | 'title' | `variant:${number}`
                         TRANSFER_SOURCES = {'trade'}  — an ALLOW-list, default
                         refuse, so a sixth call site inherits the safe side
                         VARIANT_MINT_SOURCES = {'craft'}  — V4e opens exactly
                         one door
  room.ts                variantClaims(conn) -> Uint8Array, supplied by the ROOM
                         FACTORY; resolves rowIndex + 1 against THIS room's
                         variantEntries, re-checking ownership, revocation and
                         presence at every join
  protocol.ts            KILL gains a 9th byte (the slot the shot was FIRED
                         with); S2C.VARIANT_NAMES = 14 carries id -> name
  index.ts               GET /api/variants mirrors /api/items: {id, base, name}
                         — strictly less than the in-room wire already gives

  THE OFF-BY-ONE THAT IS THE WHOLE THING: SessionArsenal.from increments `slot`
  BEFORE filling, so overlay row i is slot i+1 and slot 0 is the compiled base.
  Every slot contains every weapon; only the overlay's own base differs in its
  slot. So writing rowIndex instead of rowIndex+1 serves the BASE weapon —
  silently. Assert the DAMAGE the arsenal serves, never a slot number.
```

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

**V4 IS DONE (a through f) AND LIVE.** Everything that section used to describe
has shipped, so it is gone; the arc is in §1 and in git.

1. **The achievement system.** Model it on `shared/src/challenges.ts` —
   `ChallengeDef` is `{id, name, blurb, period, stat, target, scrap, item}` and
   the condition is DATA, never a shipped predicate. Achievements are lifetime
   and one-shot rather than periodic. `StoredChallenges.owed` is the debt shape
   for anything banked in a session that may not pay it (rule 20).
   `CHALLENGE_STATS` deliberately excludes `seconds`, because "a stat the player
   cannot fail to accumulate is a login reward wearing a challenge's name."

2. **The gauntlet — 2/23.** Gunfeel and HUD are won. MENUS IS BLOCKED, not
   lost: it was judged four times and binned four times, the last three because
   a subagent boots with the memory index that names this product's modes and
   bars (rule 39). Judge name-bearing screens from a session with the memory
   store detached, or record them unscorable. Its work order is already written
   and side-neutral: **our biggest button is pre-armed with a 0-enemy movement
   tutorial, and two of the four front cards read "COMING SOON · 2026" and do
   nothing when pressed.** Prefer STILL pieces while the motion asymmetry in
   `NEXT-SESSION-PROMPT.md` is unfixed.

3. **Defects found and deliberately left open. Fix or decide — do not
   rediscover.**
   - **A pack version above 65535 silently disables EVERY item grant.**
     `itemsVersions()` accepts any integer >= 1; `parseItemRef` is
     `^items@(\d{1,5}):` and caps at `0xffff`. Install `items/100000/` and
     drops, challenge items, prizes and craft output all vanish with no error.
     Pinned by a test; the cap itself is unfixed.
   - `equippedSkin` and `title` are still reachable through
     `POST /api/profile`. V4c added `variants` to `SERVER_OWNED_PROFILE_FIELDS`
     and left those two.
   - `craft.ts` clears `equippedSkin` on consuming a last copy but not a variant
     claim (read-time validation covers it).
   - The `loadoutTab.ts` wiring proof is a SOURCE RATCHET, not behavioural.
   - **The Lost Soul has three different sizes** — spawned 0.9 m, client hit
     target 0.7 m, rendered 0.5 m. You can hit it where nothing is drawn.
     Belongs to the ENEMIES piece.
   - Melee headshots are client-only, for players too.

4. **Then:** portals/TWA, C7 analytics, the deathmatch share surface (needs its
   own `#ui` element), and the two sponsor loose ends — no screenshot harness
   for the REWARDED overlay (S10's is `tools/shot-interstitial.mjs`), and no
   Basic Training drill for either sponsor surface, which is the PLAYER half of
   the standing tutorial directive. The admin half shipped as Guides 9.

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

- **CORRECTION 2026-09-05 (third session) — THE VERCEL HASH RULE DID NOT PASS,
  AND NOT FOR THE REASON ABOVE.** The define was reproduced correctly: the
  served bundle contains this commit's build id `50ad6594c3d5`. The two bundles
  are the same byte length and share a byte-identical vendor chunk
  (`three-CmnXx9-3.js`); they differ ONLY in the hashes of our own chunks
  (`level-B2xvsNXZ` vs `level-Dhl7N7Nz`, `room-CaXatawB` vs `room-DO7X7EBO`).
  The local build is deterministic across repeated runs and identical for
  `npx vite build` and `npm run build`, so this is **Rollup chunk hashing
  differing between Vercel's Linux builder and arm64 macOS** — not a
  build-input difference, and not reproducible from this machine.

  **USE THIS INSTEAD, and it is a better proof:** read the commit's build id out
  of the SERVED bundle.

      B=$(git rev-parse HEAD | cut -c1-12)
      S=$(curl -s https://doomcraft.vercel.app/ | grep -o 'a/index-[A-Za-z0-9_-]*\.js')
      curl -s "https://doomcraft.vercel.app/$S" | grep -c "$B"

  The id is injected from the build environment, so a stale build cannot contain
  it. That names the COMMIT directly instead of proving it by proxy.

- **THE ORIGIN HAS A BETTER TELL THAN ANY HASH: a pack version only this commit
  declares.** With the weapons ratchet widened, `curl /api/version` showing
  **`weapons@2`** in the pack set is direct, falsifiable proof the new binary is
  live. Whenever a deploy moves a content version, probe THAT rather than
  `build.id` (which lies) or a bundle hash (which may not reproduce).

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

**THE SHOT CLOCKS DIVERGE, AND THE CONE SEED RIDES ON THEM.** (V3 and V4 have
since shipped and did NOT promise anything about prediction; this remains open
and unfixable by matching a formula. Read it before anything else does.)

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
