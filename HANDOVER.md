# Doomcraft — handover: where it stands, and what is left

Written 2026-08-29. This session shipped **Studio S4 — the challenge engine** end
to end (five stages), then put it through a 179-agent adversarial review and
fixed the sixteen findings that survived verification, then refreshed the three
docs that had started asserting the opposite of the tree. Previous handovers are
in git history at `56b23c5`, `108efa5`, `9da410b`, `bfdc647`, `557c7b6`. §0 is
restated because it keeps earning it — rules 17–20 are new.

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
  Suite: **97 files / 2304 tests + 3 deliberate skips**. `release:verify` runs 15
  checks and emits 7 packs.

Read this, then `docs/ECONOMY.md`, `docs/STUDIO.md`, `docs/PACKS.md` (all three
were refreshed this session and no longer lag), `docs/SPONSORS.md` (the next
arc), `docs/VARIANTS.md`, `ref/BAR.md`.

---

## 0. The rules this project learned expensively. Do not relearn them.

1. **"It compiles and tests pass" is not evidence.** Demand an import trace PLUS a
   boot with a screenshot or a measurement. `client/src/ui/wiring.test.ts` fails
   the suite when a UI module ships to nobody.
2. **A green test that cannot fail is worse than no test.** Prove every regression
   test red with its fix reverted — and check WHAT goes red. (This session: a
   revert made a *different* test red and that was the fix doing its job — see
   the Builder win bonus in §1.)
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

## 1. What this session shipped (all pushed, green, deployed)

| Commit | What |
|---|---|
| `f2f365c` | **Challenge definitions as data** — `shared/src/challenges.ts` (mode-blind stat predicates, a parser that refuses, UTC day + the repo's first ISO-week helper), `content/quests.json`, and `PackKind.QUESTS`'s PackDef + `questsPack()` producer. |
| `9d46c6d` | **The quests pack enters the release machine** — inventory accessors with the sha256 digest, `installedPacks`/`summary`, the `unsatisfied()` QUESTS branch (proven red FIRST: without it every release naming quests is silently unsatisfiable forever), DraftPicks, and the gate checks `quests.validate` + `quests.refs`. |
| `39bef19` | **The engine** — the room producer for `challengeIds`, `verifyChallengeIds` re-deriving every claimed id in the guard against the defs the session was OPENED with, `toMatchResult` carrying the ids plus the payment gates read off the sealed trust row, and `settleChallenges` paying inside the match-payout `store.update` with one `prize` journal row per completion. PERSIST_VERSION 5→6. |
| `7fc85bf` | **The board** — `GET /api/challenges` (period keys computed at REQUEST time, so a stale bucket renders zeroed rather than as yesterday's finished board) and the Challenges section inside the Competitions tab. |
| `a1c5906` | **The quest editor** — `StudioService.saveQuests` + the dry run, the console's challenges card, the expansion one-click's quests pick, and Guides card 8. |
| `377c759` | **Review fixes** — the owed-debt list, item-at-cap, the cap that evicted live receipts, the parser's pack-input byte cap, the kill switch on payment, the pin-time quests↔items re-check, trust-table rule 2b. |
| `75c23b4` | **Review, second pass** — Builder no longer mints fake wins (`WinCondition.NONE`), account merge carries challenge receipts and debts, `reset-progress` clears challenge state. |
| `5a8b90a` | **Ad delivery counters are not public** — `fills`/`impressions`/`billableClicks`/`liveCampaigns` were world-readable on `/api/status`. Found by the sponsors design panel while auditing something else. |
| `b453e8b` | **Docs refresh** — PACKS/STUDIO/ECONOMY no longer contradict the tree; every overtaken decision sentence preserved with a dated REVISED annotation. |

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

## 6. Findings raised but NOT acted on

The review's later rounds lost their refuters to a usage limit, so these were
never verified and are recorded rather than believed. Several are PRE-EXISTING,
not S4. Worth a look before trusting the money path further:
`Deploy-drain discards final-round settlements the journal already recorded`
(critical, `server/src/index.ts`), `Any transient read error mints a blank
profile that overwrites the real file` (`persistence.ts`), `Failed profile flush
is dropped from dirty — no retry`, `mid-round reconnect forfeits the round and
raises a fraud violation`, `Match-award packet's scrap delta stops reconciling
the moment a challenge pays`. Also unfixed and real: honest invite-room rounds
raise GRANTS_NOTHING violations that flood the audit ring (pre-S4, guard policy).
