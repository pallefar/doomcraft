# Doomcraft — handover: where it stands, and what is left

Written 2026-09-04. This session took the five money-path claims that the S4
review recorded but never verified (old §6), put each one through TWO independent
passes — a per-claim Claude fan-out and a Codex run over all six — and found
**every one of them true**. Codex additionally found a money-loss bug that was in
nobody's list. All of it is fixed, deployed and pinned by tests proven red.
Previous handovers are in git history at `b77d907`, `56b23c5`, `108efa5`,
`9da410b`, `bfdc647`, `557c7b6`. §0 is restated because it keeps earning it —
rules 21–23 are new.

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
  Suite: **98 files / 2320 tests + 3 deliberate skips**. `release:verify` runs 15
  checks and emits 7 packs.
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
| `96d067a` | **A store that cannot write now says so.** `JsonFileStore.degraded` was set in four places and read in none. `/api/version`'s `data` gains `degraded`, `unflushed`, `quarantined`, `lostWrites`. |

## 2. Architecture delta

```
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

**The item that used to sit above this list — §6's unverified findings — is
DONE.** All six were confirmed by two independent passes and fixed; §6 below now
holds only what is deliberately still open. Sponsors phase 2 is next.

1. **Sponsors phase 2.** The design panel found the §3.5 dashboard **is not
   buildable from `ads.jsonl` as it stands** — `mint()` never appends, so
   "Total (rendered) impressions" has no denominator, and with no non-viewable
   event a Viewable Rate from the log prints **100%**, the MRC-forbidden
   conflation the spec's own caveat block exists to prevent. So:
   - **P2a-0 — instrument the log first.** `nonce`, `mode`, `platform` on every
     row; a `rendered` event at mint (the missing denominator); a terminal
     per-fill verdict carrying `qualified`; a `basis` field so Undetermined is
     measured, not guessed; day-shard + prune (the log currently keeps
     device-hashed rows forever, breaching the doc's own 30-day commitment).
   - **P2a-1 — the dashboard, honest by construction.** Unsupported metrics
     print an em-dash WITH THE REASON, never 0 and never 100%. PROVISIONAL
     banner (no settlement layer exists — `docs/SPONSORS.md:1338` claims item 8
     shipped and is WRONG); `billable` renamed "provisionally qualified";
     house/direct split; accidentalRate as a floor; a 2D-path caveat block.
   - **P2b — S10 interstitial.** Note `index.ts`'s decide filter silently drops
     `SurfaceId.INTERSTITIAL`/`REWARDED`, and `FrequencyCap.perDayInterstitials`
     is typed, defaulted and never read.
   - **P2c — S11 rewarded + the Gate 5 handshake.** Durable per-day grant caps
     belong ON THE PROFILE (rule 20's precedent), never in memory.
   Full evidence: the `sponsors-p2` memory and the scratchpad design brief.
2. **The variants arc, V1–V5** (`docs/VARIANTS.md` §5). **Three §7 decisions
   wait on the user before V2** (power-budget weights, variant rarity floor,
   competitive parity) — ask, do not assume.
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
$100 · a Mac with Xcode · GTA mode has no obtainable bar · **VARIANTS.md §7's
three decisions** before variants V2.

## 6. What is deliberately still open

The five claims this section used to list are fixed (§1). What follows is what
this session found and chose NOT to build, so it is not mistaken for oversight.

- **A reconnecting player still loses their post-reconnect earnings.** The false
  fraud violation is fixed; the value loss is not. A dropped socket settles the
  player immediately (right — a rage-quitter must not go unpaid), and the ledger
  has no un-settle, so the second segment of their round cannot be paid without
  breaking the one-payout-per-device invariant that stops double payment.
  THE FIX IS A FEATURE, not a patch: hold the membership in a short
  "awaiting reconnect" grace window (30–60 s) keyed on `deviceId`, re-attach the
  returning connection to the existing `Membership` with its `joinedMs` and
  `baseKills` intact, and settle only on grace expiry or `endRound`. That also
  recovers the player id, streak and seconds accrual they currently lose.
  Deliberately not attempted in the same commit as a set of money-path fixes.
- **The journal claims its idempotency key BEFORE the write** (`journal.ts:510`),
  so an EIO during append leaves money moved with no audit row. Codex reported
  this as a defect; it is not. The comment above it argues the tradeoff — "a lost
  row is a counter; a double payout is money" — and `failed`/`degraded` are
  already exposed on two routes. Recorded so the next reviewer does not re-raise
  it. See rule 23.
- **`FrequencyCap.perDayInterstitials` is typed, defaulted and never read**, and
  the decide route silently drops `SurfaceId.INTERSTITIAL`/`REWARDED`. Both are
  sponsors P2b's problem, noted in §3.
- **`docs/SPONSORS.md:1338` claims a settlement layer shipped. It did not.**
  Fix it when P2a-1 puts the PROVISIONAL banner in.
