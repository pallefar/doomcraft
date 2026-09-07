# Doomcraft — handover: where it stands, and what is left

Written 2026-09-07. This one **built and deployed the achievement system
(A1-A4)** and then **emptied §3** — every open defect on the list is now fixed
or corrected. Two of the seven were live money bugs.

The uncomfortable through-line is one shape, found three times, months apart in
origin: **something protected by a CLAIM rather than by a mechanism** (rule 43).
A comment in `items.ts` asserting a neighbour was already fixed, which kept the
neighbour broken. An allowlist documenting itself as protecting a field while
the shape of a merge did the work. A test skipping the one case where the two
predictors diverged, with an aside saying there was nothing to check. Each held
for months, and each fell the moment somebody measured.

The second: **three §3 entries were wrong about their own subject** (rule 42),
so a fourth of the day's work was re-measuring the backlog rather than trusting
it. And I made rule 40 myself — seven commits, including the money fix, sat
undeployed all day while I reported each as shipped.

Previous handovers are in git history at `b77d907`, `56b23c5`, `108efa5`,
`9da410b`, `bfdc647`, `557c7b6`, `ee0991c`. §0 is restated because it keeps
earning it — **rules 40-43 are new; 40 is the one I broke myself, and 43 is the shape the whole day had.**

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin: game, rooms,
  API, release tier, admin console at `/admin`. Railway project `doomcraft`,
  volume `/data`.
- **https://doomcraft.vercel.app** — static single-player, same bundle.
  **github.com/pallefar/doomcraft** — `main`.
- Owner seat claimed and durable: creds in `~/youtube/doomcraft-owner-credentials.txt`.
- CI: `tsc -b` + `vitest run` + `release:verify` on every push; all pushes green.
  Suite: **118 files / 2865 tests + 3 deliberate skips** (2026-09-07).
  `release:verify` runs **17 checks** and emits 7 packs.
- **`node tools/deploy-drift.mjs`** answers "is what is LIVE this tree?" — both
  tiers were current at `b6fb3c5`. Do not infer it from `git status` (rule 40).
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
     you order can open the hole next door), 43 (a thing protected by a CLAIM
     rather than a mechanism — ask WHICH mechanism makes it safe).
  **26 · A change retires the proofs standing on the old behaviour.** Its
     costume: 41 (fixing a BUG does it too, and to policies and comments as
     well as tests).
  **40 · "Deployed" quietly becomes "committed".** `node tools/deploy-drift.mjs`
     before saying shipped, and say WHICH — committed, pushed, or live.
  **42 · A defect entry is a claim.** Re-measure its shape AND width before
     designing the fix; correct a wrong entry in place.

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

40. **NEW — "DEPLOYED" QUIETLY BECOMES "COMMITTED", and the state it hides is
    invisible from inside the repo.** I verified one deploy carefully, then
    fixed seven more things, committed and pushed each, reported each as
    shipped — and deployed none of them. One was a live money bug. Nothing was
    wrong with any single step; the word "shipped" covered two different states
    and nothing nagged, because what is actually running cannot be seen from a
    clean `git status`. **The fix is a command, not more discipline** — the
    runbook already described the check and I had followed it correctly twice
    that same day. `node tools/deploy-drift.mjs`, before saying shipped.
    And when reporting work, say WHICH: committed, pushed, or LIVE.

41. **NEW — FIXING A DEFECT RETIRES WHATEVER WAS STANDING ON IT.** Rule 26 said
    moving code behind a seam destroys a proof's lever; closing a BUG does the
    same, and wider. V4e's "a craft whose grant cannot deliver" test installed
    an items pack at version 100000 as its FIXTURE — a defect used to
    manufacture a separating input. The u16 ceiling fix made that host fall
    back to items@1, the craft succeed, and the test fail; had it not failed it
    would have sat there proving nothing. The sweep after closing a defect is
    three things, not one: the TESTS that used it as a fixture, the POLICIES
    that exist because of it (`achievements.ts` refused `wins` and had to be
    re-decided), and the COMMENTS citing it as a live reason. Grep for the
    SYMPTOM — the stat name, the magic number — not just the code you changed.

42. **NEW — THREE §3 ENTRIES IN ONE DAY WERE WRONG ABOUT THEIR OWN SUBJECT.**
    `equippedSkin`/`title` were NOT reachable through `POST /api/profile`; the
    fingerprint fix did NOT need its own release (the fix was already in the
    tree, in `items.ts`, and moved no digest); the Lost Soul's "0.5 m cube
    spanning 0.15-0.65" was not reproducible, and the real defect was one axis
    of one enemy out of five. A defect entry records what somebody believed
    under time pressure, usually without measuring. **Re-measure the SHAPE and
    the WIDTH before designing the fix** — entry three named one enemy, and the
    honest question ("how many of the five disagree, and on which axis") turned
    a guess into a one-line correction plus a ratchet. Correct the entry IN
    PLACE rather than deleting it, so the next reader sees it was checked.

43. **NEW — THE RECURRING SHAPE OF THE WHOLE DAY: a thing protected by a CLAIM
    rather than by a mechanism.** Three times, months apart in origin.
    `items.ts` said its encoder fix "matches variantsFingerprintInputs and
    challengesFingerprintInputs" — true of variants, false of challenges, and
    that clause is what kept the neighbour broken. The profile allowlist
    documented itself as protecting `equippedSkin` while the shape of the merge
    was doing the work — one `p.inventory = incoming.inventory` from being gone.
    `agreement.test.ts` skipped melee with the aside "melee has no cone on
    either side", false of the server, and melee is exactly where the two
    predictors diverged. **A skip comment is load-bearing documentation: write
    what the test CANNOT cover, never a claim that there is nothing to cover.**
    When something is safe, ask WHICH mechanism makes it safe, and whether that
    is the mechanism whose job it is.

## 1. What this session shipped (all pushed, green; both tiers LIVE)

Verify with `node tools/deploy-drift.mjs` rather than trusting this table.

| Commit | What |
|---|---|
| `ef32f72` | **A LIVE DOUBLE-PAY.** `settleChallenges` asked the journal and never asked `done`, and the journal's key ends in the PROFILE KEY — so a receipt earned as device B protects nothing once the player is A. An account merge builds exactly that pair. Measured through the real merge: A owes `daily.kill-25`, B was paid it today, merge, settle, and A is credited 25 Scrap for a completion the human was already paid for. |
| `69dfe3b` `50543bf` `b161e20` `1f1ef1f` `633971a` | **The achievement system, A1-A4.** Lifetime, one-shot, RETROACTIVE. Progress reads `profile.stats` — one number, so the profile and the award cannot disagree in front of the player — but the PROMISE is snapshotted at detection, because the counter preserves the STAT and what a player is owed is the DEF, which lives in a pack that can be re-cut. Three wire states, not a boolean: `earned` is reachable in ordinary play and gets its own words. A2b also fixed a regression `ef32f72` had created — see §0 rule 31. |
| `46b354a` | **The u16 pack-version ceiling, at all three doors.** `items/100000/` was legal to install and unreadable by `parseItemRef`, so every minted ref was refused by the reader and drops, challenge items, achievement awards, prizes and craft output silently stopped landing. Discovery, lookup and the MINT — the mint worst, because a pack past the ceiling is installed, immutable and invisible with the operator told the save succeeded. |
| `618056b` | **A challenge debt paid an item nothing defines**, and called itself settled — 100 Scrap, a receipt, and an item `itemStateFor` calls DORMANT. A debt outlives its def and the loop walks `owed`, not `defs`. |
| `bca9cfa` | Wearable claims refused BY NAME, and a §3 entry corrected as false. |
| `c14d0b5` | **A round nobody scored in has no winner.** A lone idle player was crowned at 0 kills and credited a lifetime win. `wins` becomes priceable as a consequence — nothing prices it yet. |
| `3550036` | **Two free-form tokens, one fingerprint** — and the fix was already in the tree. A refusal, not a re-encoding, so no digest moved. |
| `b845410` | **The Lost Soul's hitbox follows its body**, plus a ratchet over all three size tables. |
| `1f1056c` | **Melee stops predicting a headshot the server never scores.** `agreement.test.ts` skipped melee, which is how it survived. |
| `b841a1f` `15687c4` | **`tools/deploy-drift.mjs`** — "is what is LIVE the tree I am standing in?", one command, exits non-zero on drift. It caught its own first commit crying drift for a docs-only change and was narrowed. |
| `b6fb3c5` | **An achievement pays through a REAL round**, which nothing proved until now — and the ordering is pinned: hoist the block above `applyMatchResult` and the award goes unpaid. |

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

**§3.3 IS EMPTY.** Every defect this section carried is fixed or corrected, and
the corrections are recorded in place rather than deleted, so you can see which
entries were wrong and how (rule 42). Do not read that as "the code is clean" —
read it as "this list is spent, and the next one comes from measuring".

1. **THE FLAG. `economy_achievements` is OFF and the flip is the user's call.**
   It is a FULL-REPLACE `DOOMCRAFT_FLAGS` env document carrying ALL SIX rules —
   the live five are `economy_competitions`, `economy_items`, `economy_scrap`,
   `economy_trading`, `share_cards` — because an admin-console flip dies at the
   next restart (rule 14). The moment it lands, every player whose LIFETIME
   stats already qualify is paid at their next settling match:
   `achievement.first-blood` is one kill, so that is effectively everybody, and
   the six awards total 975 Scrap. That is the retroactive design working, and
   it is a one-way door for anyone it pays.

2. **The gauntlet — 2/23.** Gunfeel and HUD are won. MENUS is BLOCKED, not lost
   (rule 39: a subagent boots with the memory index, which names this product's
   modes and bars). Judge name-bearing screens from a session with the memory
   store detached, or record them unscorable. Prefer STILL pieces while the
   motion asymmetry in `NEXT-SESSION-PROMPT.md` is unfixed. The ENEMIES piece
   now has two fewer real defects under it — the Lost Soul's hitbox and melee
   headshots were both closed today, so what remains there is genuinely about
   feel rather than about bugs.

3. **Then:** portals/TWA, C7 analytics, the deathmatch share surface (needs its
   own `#ui` element), and the two sponsor loose ends — no screenshot harness
   for the REWARDED overlay (S10's is `tools/shot-interstitial.mjs`), and no
   Basic Training drill for either sponsor surface, which is the PLAYER half of
   the standing tutorial directive. The admin half shipped as Guides 9.

4. **Known and deliberately not fixed:**
   - `craft.ts` clears `equippedSkin` on consuming a last copy but not a variant
     claim (read-time validation covers it).
   - The `loadoutTab.ts` wiring proof is a SOURCE RATCHET, not behavioural.
   - **A fifth load-sensitive test, of a new kind:** `accounts.test.ts`'s
     `afterAll` can fail `ENOTEMPTY` removing its temp dir during a concurrent
     full run; it passes 30/30 alone at load 55. TEARDOWN, not timing — the
     other four are timing. Do not write off a green-suite claim over it.

## 4. Deploy runbook (follow exactly)

- **FIRST, AND AT ANY TIME: `node tools/deploy-drift.mjs`.** Answers "is what is
  LIVE the tree I am standing in?" in one command, exits non-zero on drift.
  It exists because on 2026-09-07 the origin ran SEVEN COMMITS BEHIND for most
  of a day and one of them fixed a live money bug — pushed, CI green, and
  "deployed" had quietly become "committed". It does NOT ask the server what
  commit it is, because the server does not know and answers wrongly: `build.id`
  read `b453e8b` before and after three separate deploys that day (rule 17).
  Railway is checked by SERVED BUNDLE HASH against a local `npm run build`;
  Vercel by reading THIS COMMIT'S ID out of the served bundle, because the two
  builds are not reproducible the same way. `--no-build` reuses `dist/`.

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
