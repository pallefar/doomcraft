# Doomcraft — handover: where it stands, and what is left

Written 2026-09-05. This session did two arcs. First it took the five money-path
claims that the S4
review recorded but never verified (old §6), put each one through TWO independent
passes — a per-claim Claude fan-out and a Codex run over all six — and found
**every one of them true**. Codex additionally found a money-loss bug that was in
nobody's list. All of it is fixed, deployed and pinned by tests proven red.
Previous handovers are in git history at `b77d907`, `56b23c5`, `108efa5`,
`9da410b`, `bfdc647`, `557c7b6`. §0 is restated because it keeps earning it —
rules 21–24 are new. Then it built **sponsors P2a end to end** — the ad log
instrumented, aggregated, retained, and rendered as an honest delivery report.

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin: game, rooms,
  API, release tier, admin console at `/admin` (Studio with a challenges card,
  Guides with eight walkthroughs). Railway project `doomcraft`, volume `/data`.
- **Daily/weekly challenges are LIVE**: `GET /api/challenges` serves the board,
  the profile overlay's Competitions tab renders it, and the quests pack
  (`quests@1`, 4 dailies + 3 weeklies) is in every room's pinned release.
- **https://doomcraft.vercel.app** — static single-player, same bundle.
  **github.com/pallefar/doomcraft** — `main`.
- Owner seat claimed and durable: creds in `~/youtube/doomcraft-owner-credentials.txt`.
- CI: `tsc -b` + `vitest run` + `release:verify` on every push; all pushes green.
  Suite: **100 files / 2409 tests + 3 deliberate skips**. `release:verify` runs 15
  checks and emits 7 packs.
- **S11 rewarded is BUILT** (flag `sponsor_rewarded`, defaultOn:false). Gate 5
  runs server-side: `/api/sponsor/reward/{start,beat,claim}`. Grant caps are ON
  THE PROFILE (PERSIST_VERSION 7) so a deploy cannot hand out a fresh four.
- **The S10 between-match interstitial is BUILT** (flag `sponsor_interstitial`,
  defaultOn:false — flipping it in production is the user's launch call). Fires
  after EVERY mode. Proof harness: `tools/shot-interstitial.mjs`.
- **Sponsor delivery is LIVE**: `GET /api/admin/ads` serves the §3.5 report from
  durable daily aggregates, and the console's new **Delivery** tab (under
  Analytics) renders it — every metric the log cannot support prints an em-dash
  and the reason, never a 0 and never a 100%.
- **`/api/version`'s `data` block now carries live durability signals** —
  `degraded`, `unflushed`, `quarantined`, `lostWrites` — beside the boot-time
  `writable`. They are also how you verify a deploy (rule 17).

Read this, then `docs/SPONSORS.md` (the next arc — and read §3 here before you
follow its ordering, which is wrong), `docs/ECONOMY.md`, `docs/STUDIO.md`,
`docs/PACKS.md` (refreshed 2026-08-29, still current), `docs/VARIANTS.md`,
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

## 1. What this session shipped (all pushed, green, deployed)

The whole of the old §6, verified twice and then fixed. Every fix has a
regression test proven red with **its own** fix reverted, and the revert is named
in the test body so the proof is cheap to repeat.

| Commit | What |
|---|---|
| `1d0ae7b` | **The durability layer.** (a) A transient read error minted a blank profile and renamed it over the real file — one bare catch collapsed ENOENT, EACCES, EIO and a parse failure into "new player". Only an ENOENT *errno* is absence now; anything else QUARANTINES the device (a working profile in memory, never a write) so the bytes survive for recovery. A file that parses to a non-object is quarantined too — that path did not even take the catch. (b) A failed flush was dropped from `dirty` and never retried, while `flush()` still resolved — which is what made it dangerous, because `trades.ts:623` awaits `flush()` to know a swap is durable before stamping it 'settled'. Ids now clear only after their `rename`. (c) A post-`close()` write was discarded in silence; it is counted and logged. |
| `3de4329` | **The critical one: the drain raced its own settlements.** `shutdown()` detached every player — each detach STARTS a payout several awaits deep — then ran `flush()` (empty dirty set, instant), `close()`, `process.exit(0)`. The journal row landed; the balance did not. Rooms now track in-flight settlements and expose `quiesce()`; shutdown awaits them, bounded by `DOOMCRAFT_SETTLE_DRAIN_MS`. The deploy deadline also now ENDS the round instead of only stopping its clock. **Plus Codex's find:** `payoutSourceId()` was evaluated INSIDE the deferred `store.update` callback, reading a `sessionId` that `beginRound` replaces — so a late settlement journalled round N under N+1's key and round N+1's real payout was then refused as a duplicate. Pinned at submission time. |
| `ff12185` | **The fraud log stops accusing honest players.** `GRANTS_NOTHING` flagged a violation on `wanted !== 0`, and `wanted` is never 0 (every submission must carry `stats`), so friends in a private room minted a violation each per round. `ALREADY_SETTLED` did the same to any honest mid-round reconnect. And the ring itself logged every REFUSAL, so honest traffic evicted real attacks from a 256-row buffer — it now logs suspicion. Two existing tests updated (invariants kept, plus a direct replay so the guard's own check is still proven). |
| `edbbe06` | **The award packet stops understating the round.** `landed` came from `applyMatchResult` alone, so a challenge prize appeared in `totalScrap` but not in the delta beside it — a first daily completion could count "+0 Scrap" on a round that paid 40. Display only; the ledger and balance were always right. |
| `d42374b` | **Sponsors P2a-0: the log becomes readable by a billing job.** `served` rows at mint (a successful decide wrote NOTHING before, so no metric had a denominator); `nonce` on every fill-scoped row (exposure rows carry a RUNNING TOTAL, so without it two fills are indistinguishable from one); `v`/`mode`/`platform`; `decisionId` (a `decide` row is a REFUSAL, not a decision); write failures counted instead of swallowed; rows batched per call so `appendFileSync` is not multiplied on the serving path. **Codex, run over the plan BEFORE any code, overturned its central clause** — a row written at mint is `served`, not `rendered`; the client may never display it, and calling it rendered recreates the conflation §3.5 forbids. |
| `2c08f9e` | **P2a-0b: non-viewable becomes recordable.** Client-attested `rendered` (metric 1's denominator, deliberately NOT gated on visibility — rendering is not viewing) and a terminal `verdict` carrying `qualified` + `basis`. The basis is load-bearing: rendered-and-failed is a MEASURED failure (bucket 3); never-rendered is UNDETERMINED (bucket 4); no verdict at all is undetermined BY ABSENCE. Folding 4 into 3 flatters the Measured Rate that MRC asks us to maximise. |
| `f11e8d4` | **P2a-0c: aggregate first, then prune.** Codex's critical finding. Day-sharded rows, a durable per-day aggregate, and a prune that REFUSES to delete a day with no aggregate — retention runs on a timer and the billing job runs on nobody's schedule, so that race has one winner. Exposure is max-per-nonce, straddling fills make the day a lower bound. |
| `9bb7e74` `74b5bcb` `2c4d498` | **P2a-1: the delivery report and its screen.** `GET /api/admin/ads` over the aggregates; a Delivery console tab. Every unsupported metric is an em-dash WITH ITS REASON. Viewable Rate with no measured failures is *unavailable*, not 100%. The phase-3 in-world metrics are refused BY NAME so a blank does not read as zero. PROVISIONAL banner; house/direct split; session-uniques, never person-uniques. |
| `d6c74ed` | **A slot is never measured over another fill's creative.** Two pre-existing defects Codex found while attacking the P2a design, both of which P2b would have multiplied. A direct creative REPLACED the house card and nothing put it back, so on the next visit — with that campaign now capped and HOUSE allocated — the old art was still on screen while a new observer measured it under the house nonce, crediting unsold inventory with a sponsor's exposure. A slot now declares whose pixels it is showing. Also: the client defaulted `mode` to 0 and `ModeId.QUEST` IS 0, so every menu impression would have been reported as Quest reach. |
| `2e2780c` | **P2b (server): the interstitial is admitted, and rationed.** `SERVABLE_SURFACES` = phase one + S10; `perDayInterstitials` — typed, defaulted and read by nothing since it was written — is now a real platform ceiling across ALL campaigns (two campaigns each under their own cap still add up), plus the 180 s interval, both refused with the reason in the log. Counted on SERVE, not impression. A surface this build cannot serve is refused and counted instead of dropped in silence. |
| `136620f` | **P2b (client): the interstitial, and a skip a keyboard can actually press.** THREE defects the screenshot harness found and no unit test could: the skip starts disabled so `focus()` left the keyboard on nothing; the game binds keys globally and SWALLOWED Enter, so the focused high-contrast skip could not be operated at all; and "Skip (14s)" reads as "wait 14 seconds to skip" — the AADC's named pattern, described in words even though the control was live. |
| `7bd0274` | **The site promises the reporting we actually ship.** "reported to you line by line" was false — the report is daily aggregates, and the in-world half is phase 3. |
| `baf2d3c` | **P2c (1/n): Gate 5's rules, and caps that survive a deploy.** PERSIST_VERSION 6→7, `DECLARED_PERSIST_VERSION` bumped in the same commit as the gate demands. The server's own clock, one beat per 2s in a [1.6s, 3.5s] ARRIVAL window (which is what defeats a burst faking elapsed time), four fifths visible+focused, 4/day 180s apart 40/30/20/10, zero under 30min lifetime play, zero in PvP, Scrap never XP. The ad-free player is paid without a session — and the CAP checks sit before the WATCH checks so they are still capped, or the purchase becomes a scrap tap. |
| `eb212df` | **P2c (2/n): the handshake over the wire.** `settleAdReward` mirrors `settleChallenges` — journal idempotency first, row appended inside the same locked section. PvP is read from the ROOM TABLE, never the request. The session is marked spent only after the grant is durable. R38 is why the ownership tests exist: removing the device check from `RewardSessions.get` broke nothing, so a leaked reward id was a claim on another player's watch. |
| `3dae9b2` | **P2c (3/n): the rewarded watch and its button.** On the QUEST intermission (`#ui`, clickable); deathmatch gets none (`#hud` is pointer-events:none). HOUSE is accepted here unlike the interstitial — the reward is the GRANT, not the ad. Cancel is never disabled: requiring the full watch to be PAID is fine, requiring it to be endured is not. |
| `fde6758` | **Guides 9 — how to run the sponsor surfaces.** The standing tutorial directive. States which cap survives a deploy and which does not, and the ad-free rule. |
| `96d067a` | **A store that cannot write now says so.** `JsonFileStore.degraded` was set in four places and read in none. `/api/version`'s `data` gains `degraded`, `unflushed`, `quarantined`, `lostWrites`. |

## 2. Architecture delta

```
ads log:    <data>/ads/<day>.jsonl         day-sharded; `served` at mint, `nonce` on every
                                           fill-scoped row, v/mode/platform/decisionId
ads roll:   <data>/ads-daily/<day>.json    written once, kept indefinitely, the prune's gate
rollup:     server/src/adsRollup.ts        rollupRows (pure) + rollupPending + pruneRaw
report:     admin/model.ts adReport        Measured = value | null + REASON; never 0, never 100%
route:      GET /api/admin/ads             read-only, no audit row, reads aggregates not raw
screen:     console.ts tab 'delivery'      em-dash + reason; PROVISIONAL; caveat block
meter:      client/ads/viewability.ts      emits `rendered` + terminal `verdict{qualified,basis}`

challenges: shared/src/challenges.ts    defs as data + challengeContribution (ONE predicate,
                                        three callers: room producer, guard, settlement)
pack:       PackKind.QUESTS = 5         data class; content/quests.json is the v1 fallback
producer:   room.ts challengeIdsFor     gated on the member's economy_competitions bit
guard:      verifyChallengeIds          re-derives from the session's OPENED-with defs
payout:     persistence.ts settleChallenges   debt -> has-first -> credit -> row, one lock
state:      StoredProfile.challenges    {day, week, counts, done, owed}  (PERSIST 6)
route:      GET /api/challenges         view-time period roll; never writes
studio:     POST /api/admin/studio/quests (+ /validate)   mints quests@<n+1>
```

## 3. What is left — decided order

**SPONSORS PHASE 2 IS DONE** to the limit of what is unblocked — P2a (the log
instrumented, aggregated, retained and rendered), P2b (the S10 interstitial) and
P2c (S11 rewarded + Gate 5) — as is §6's list of unverified findings, all six of
which were true. **The queue starts at the variants arc, which needs three
answers from you before V2.**

1. **Sponsors phase 2, continued.**
   - ~~P2a-0 / P2a-1 / P2b~~ — SHIPPED.
   - ~~P2c — S11 rewarded + Gate 5~~ — SHIPPED (server, client, guide).
     **What is NOT done and should finish the arc:** there is no screenshot
     harness for the rewarded overlay (S10's is `tools/shot-interstitial.mjs`
     and the rewarded one should measure the same three things — focus, the
     cancel control, and that a completed watch actually pays); and there is no
     Basic Training drill for either sponsor surface, which is the PLAYER half
     of the standing tutorial directive. The admin half shipped as Guides 9.
   - Sponsors is otherwise done to the limit of what is unblocked: everything
     remaining is the THIRD-PARTY half, which needs the ad-network/CMP accounts
     in §5.

2. **The variants arc, V1–V5** (`docs/VARIANTS.md` §5). The three §7 decisions
   are TAKEN (2026-09-05): DPS-dominant budget at ±12% **plus** a
   strict-dominance refusal, an uncommon craft-only floor, and variants
   table-gated out of ranked-adjacent modes. §7 now records them in full.
3. **The gauntlet — 0/23.** Then portals/TWA, C7 analytics.
4. **Deathmatch share surface** — needs its own `#ui` element; the scoreboard
   lives in pointer-events:none `#hud`.

## 4. Deploy runbook (follow exactly)

- **Vercel (static): from the REPO ROOT** — `npx vercel --prod --yes`.
- **Railway (origin):** from a CLEAN WORKTREE at HEAD: `git worktree add <tmp>
  HEAD && cd <tmp> && railway link --project doomcraft --service doomcraft &&
  railway up --detach`, then POLL `railway deployment list --json` until the
  newest is SUCCESS. Rule 17: the CLI's timeout message is not a failure, and
  the build id is not proof.
- **Verify THREE things**: newest deployment == SUCCESS; a route the new build
  ADDS answers; `curl /api/version | jq .data` → `{"writable": true}`.
- **Flag changes**: update the Railway env `DOOMCRAFT_FLAGS` with the FULL
  document (rule 14). Currently forces the five economy flags.
  `sponsor_interstitial` / `sponsor_rewarded` are deliberately OFF — flipping
  them is the user's launch call, not an engineering gate.
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
oversight. The three Codex findings against the existing ad path that used to
head this list are FIXED (`d6c74ed`), and the false site claim with them
(`7bd0274`).

- **The 32-bit device hash is a floor, not an identity.** At a million devices
  the expected distinct-hash count is ~999,884, and two colliding devices share
  frequency caps and click dedup. The delivery report labels the count a floor
  and refuses person-uniques outright; a real audience number needs a wider
  pseudonymous id and server-issued sessions, which is a schema change.
- **Orientation is never captured.** `platform` is a coarse-pointer
  classification, so §3.5's "mobile portrait broken out" — named in the doc as
  our differentiator against the bar — is refused on the screen rather than
  approximated. Capturing it means recording viewport shape at observation time.
- **The interstitial's daily cap is in memory**, like every other cap in
  `ads.ts`, so a restart forgives the day's count and this project deploys
  often. That is the conservative direction for a cap that protects a PLAYER,
  and it keeps one cap machine rather than two. It is NOT acceptable for a
  rewarded grant, which is money — see P2c in §3.
- **No screenshot harness for the rewarded overlay, and no Basic Training drill
  for either sponsor surface.** Both are named in §3; the second is the player
  half of the standing tutorial directive and the admin half already shipped.
- **A reconnecting player still loses their post-reconnect earnings.** The false
  fraud violation is fixed; the value loss is not. A dropped socket settles the
  player immediately (right — a rage-quitter must not go unpaid), and the ledger
  has no un-settle, so the second segment cannot be paid without breaking the
  one-payout-per-device invariant. THE FIX IS A FEATURE: hold the membership in
  a 30–60 s "awaiting reconnect" grace window keyed on `deviceId`, re-attach the
  returning connection with its `joinedMs`/`baseKills` intact, and settle only
  on expiry or `endRound`.
- **The journal claims its idempotency key BEFORE the write** (`journal.ts:510`),
  so an EIO during append leaves money moved with no audit row. Codex reported
  this as a defect; it is not. The comment above it argues the tradeoff — "a
  lost row is a counter; a double payout is money" — and `failed`/`degraded` are
  already exposed on two routes. Recorded so it is not re-raised. See rule 23.
- **`docs/SPONSORS.md:1338` claims a settlement layer shipped. It did not.** The
  delivery report is flagged PROVISIONAL for exactly this reason; fix the line.
- **OBSERVED FLAKE, not diagnosed.** `server/src/accounts.test.ts > signin >
  accepts the right passphrase and refuses a wrong one` failed once in roughly
  six full-suite runs on 2026-09-05, and passes in isolation every time. It uses
  `CHEAP` scrypt (N=16) and a fresh temp root per test, so neither KDF cost nor
  shared state is the obvious cause, and the error text was not captured. Worth
  a real look before it is trusted as a gate — a flaky test in the auth path
  quietly weakens "full suite green before any commit".
