# Real bugs found while designing the sponsor system

Both verified by grep against the live source, both unrelated to advertising, both affecting every
player today. Cannot be fixed while the modes workflow holds `main.ts` — apply immediately after.

## 1. Backgrounding the tab for 15 s disconnects you from your match — HIGH

`client/src/main.ts:943` runs the network pump inside `requestAnimationFrame`. Browsers throttle
rAF to ~1 Hz in a background tab and stop it entirely in some conditions. The server
(`server/src/net.ts:340`) drops any client whose `lastRecvMs` exceeds
`CLIENT_TIMEOUT_MS = 15000` (`shared/src/constants.ts:146`). There is **no `setInterval` fallback
anywhere in the net path** — confirmed by grep.

So: alt-tab, take a call, or switch apps for fifteen seconds and you are kicked out of your game.
This is a bad bug on its own, and it is a hard blocker for any click-out ad flow.

**Fix:** drive the net pump from a `setInterval` (or a Worker timer, which browsers throttle less)
independent of rAF, and send a keepalive on `visibilitychange`.

## 2. No Content-Security-Policy anywhere — HIGH

`server/src/index.ts` sets no CSP header; grep finds no `Content-Security-Policy`, no helmet, no
`contentSecurityPolicy` in the whole server. Today that is ordinary hygiene debt. The moment we
serve third-party sponsor creative it becomes the control that stops a malicious or compromised
creative from executing in the game's origin.

**Fix:** a real CSP before any third-party content ships, with the creative sandbox as a separate
origin or a sandboxed iframe.

---

## 3. Buried in the ground after leaving Quest — FIXED, but not unit-testable

**Symptom.** Play Quest, return to the menu, start Horde / Deathmatch / Builder: you spawn inside
solid ground and cannot move, ever. Reachable from the most ordinary navigation path in the game.
This is very likely what the owner hit when they reported *"seemed I was going thriugh walls"*.

**Mechanism.** `server/src/room.ts`, `onModeSelect`. `clearAuthoredLevel()` regenerates the world
**and respawns every member**, and `Sim.spawnPlayer` reads `spawnAnchor ?? world.pickSpawn()`. The
anchor was cleared five lines *after* that call, so everyone was respawned onto the Quest level's
authored player start — a coordinate the freshly regenerated terrain had filled in solid.

**Fix.** Clear `sim.spawnAnchor` *before* `clearAuthoredLevel()`. One reorder.

**Evidence, since there is no unit test.** Measured on the real Room:
`Quest (16.5, 8, 10.5) buried=false → Deathmatch (16.5, 8, 10.5) buried=TRUE → Builder buried=TRUE`,
against a control of a fresh Deathmatch with no preceding Quest at `(41.5, 34, 94.5) buried=false`.
In the live browser: stuck at `(16.5, 8, 11.3)` inside block id 4, 0 m travelled in 9 s of held
sprint, 0 of 72 headings with any runway. With the reorder: `Quest → Deathmatch (95.5, 29, -29.5)
buried=false`.

**Why there is no unit test, stated plainly.** Without the real `LevelLibrary`, the room-level test
harness never stamps a level, so `clearAuthoredLevel()` early-returns and nothing is respawned.
Three test drafts were written and all three passed **with the bug still in the tree** — asserting
the symptom, then the cleared anchor, then the anchor observed at spawn time. A test that is green
in both directions is worse than no test: it would certify the bug as fixed. They were removed.

**Owed:** an integration test that boots the real server with levels loaded and walks
Quest → menu → Horde, asserting the body's own cells are not solid.

---

## 4. Builder and Horde rooms run a Deathmatch round timer, pay for idling, and then regenerate the world under you — MEDIUM, NOT FIXED

**Found while wiring the entitlement guard into `Room` (A1 task 1). STILL NOT FIXED after A1 task 3
(anti-farm), and deliberately so: changing round-timer semantics is a much larger change than either
of the ones it was found inside, and it would take the entitlement ledger's only session boundary
with it. What task 3 did instead was stop the defect paying anybody — see below.**

**Mechanism.** `Room.updateRound` (`server/src/room.ts:1233`) decrements `timeLeftMs` on every tick
in the `LIVE` branch (`room.ts:1244`) with **no reference to `plan.runRoundTimer`**, and calls
`endRound('time')` at zero (`room.ts:1248`). The `ENDED` branch then restarts the round eight
seconds later (`room.ts:1252` → `beginRound(true)` at `room.ts:1149`), which regenerates the terrain
at `room.ts:1164` (`this.world.reset(this.seed)`). Only Deathmatch declares `SYS_ROUND_TIMER`
(`shared/src/modes.ts:449`), and `plan.runRoundTimer` is read in exactly two other places —
`room.ts:508` (the `ModeAction.RESTART` handler) and `room.ts:932` (the mode-context sender) —
never by the round clock.

So a Builder world or a Horde run with one human in it:

1. counts down the 8-minute Deathmatch clock (`MATCH_DURATION_MS`),
2. calls `endRound('time')`, which pays every member a Deathmatch-shaped `MatchResult`,
3. shows the 8 s end screen, then calls `beginRound(true)` — which **regenerates the terrain**
   (`world.reset(seed)`), throwing away whatever the player built.

**Two separate defects, and only one of them is about money.** The world regeneration is the bad
one: it is a Builder player losing their work on a timer nobody set. The payout is the milder one,
and the trust table already limits it — `BUILDER/PUBLIC` grants `XP | CHALLENGE | STATS |
TRADE_UNLOCK` and explicitly no Scrap and no drops, precisely because "Builder hands out infinite
blocks and has no failure state, so any per-action payout is an idle farm". But XP for standing
still is still XP for standing still.

**Not the fix that was applied — and what was.** A1 task 3 leaves the clock exactly where it is and
refuses to pay for the thing the clock enables. Four rules, none of which touches round semantics:

| Rule | Where it lives |
|---|---|
| A round in which the player did nothing at all — no kills, no deaths, no damage, no blocks placed or broken — is worth zero however long it ran. **This is the one that closes the Builder/Horde AFK farm.** | `server/src/reward.ts:125` `playedIdle`, applied at `reward.ts:137` `roundPays` |
| A round shorter than 30 s is worth zero. | `server/src/reward.ts:109` `MIN_PAID_SECONDS` |
| Per-match ceilings of 900 XP / 120 Scrap. | `server/src/reward.ts:98` |
| Per-day caps and a diminishing-returns ladder, metered under the profile lock. | `server/src/persistence.ts:508` `DR_LADDER`, `:545` `meterReward` |

So a Builder player who stands still for the whole unasked-for eight minutes now earns nothing at
all rather than a full round's XP, and the world still gets regenerated under them. **The bad half
of this defect — losing what you built to a timer nobody set — is untouched.**

Gating `updateRound` on `plan.runRoundTimer` is still the real fix and is still not taken, because
it changes what a Horde room *is*: Horde would then have no round boundary at all, and `endRound`
is the only thing that closes a ledger session.

**Fix, when someone takes it:** gate both the countdown and the `beginRound(true)` restart on
`plan.runRoundTimer`, and give the modes that opt out an explicit session-close path so the
entitlement ledger still has a round boundary to settle against.

**Related, same handler, also not fixed:** `ModeAction.RESTART` calls `beginRound(true)` for any
mode with `runRoundTimer`, straight off a client message. In a Deathmatch room that is a client
regenerating everybody's terrain on request.

---

## 5. A finished match could be erased by somebody opening the profile page — HALF FIXED, THEN FIXED

**Found by the live-server test added with the entitlement guard, which was flaky in roughly one
full-suite run in three. The flake was the bug.**

**Symptom.** A player finishes a match. The entitlement guard accepts the result
(`/api/status`.entitlement reports `accepted: 1`, `codes: {OK: 1}`), `applyMatchResult` runs, the
device is marked settled — and `GET /api/profile` returns `gamesPlayed: 0`. The match is gone, and
because the guard settles once per session, replaying it is refused. Silent, permanent loss.

**Mechanism.** `JsonFileStore.update` takes a per-device lock. `JsonFileStore.ensure` did not.

```
payout:  update() -> lock -> ensure() -> load() -> await ready() -> await readFile() -> ENOENT
                                      -> createProfile() -> cache.set -> mutate -> save
reader:  ensure()          -> load() -> await ready() -> await readFile() -> ENOENT
                                      -> createProfile() -> cache.set        <-- blank, last, wins
```

Two `await`s inside the cache-miss path is all the window it takes. Reproduced **12 times out of
12** against a cold store — which is precisely the production shape: the process has just started,
nothing is cached, and the first match ends while a menu fetches the profile. Against a warm cache
it never fires, which is why nothing had noticed.

**First fix (incomplete).** `ensure` returns a cache hit without locking (that object is the one
`update` mutates anyway) and takes the per-device lock on a miss, re-reading under it. `update` and
`linkAccount` already hold that lock, so they call a private `ensureLocked` — `withLock` is not
reentrant and the naive version deadlocks on itself.

**Test.** `server/src/economy.test.ts`, "a payout landing while somebody reads the profile". Cold
`JsonFileStore`, `update` and `ensure` started in the same tick. Red before the fix
(`expected +0 to be 1`), green after, and the live end-to-end test in `online.test.ts` stopped
flaking.

**`MemoryStore` does not have this bug** — its `ensure` has no `await` before `cache.set`, so there
is no window to interleave in. It is left alone deliberately rather than "fixed" symmetrically.

### 5b. …and the lock was put on the wrong function. Reopened, then closed properly.

**This section said FIXED for one commit and was wrong, so the correction lives here rather than in
a new section — a "FIXED" that was only half true is worse than an open bug, because it is the
reason nobody looks again.**

The lock went on `ensure()`. But `ensure` and `ensureLocked` **both delegate to `load()`**, and
`load()` is the function that does `this.cache.set(deviceId, profile)` after two `await`s. Guarding
the caller and not the writer left every other path into `load` racing exactly as before:

```
payout:  update() -> LOCK -> ensureLocked -> load -> readFile ->  mutate -> save -> cache.set
reader:  load()             (NO LOCK)              -> readFile .................. -> cache.set
                                                      ^ resolves LAST, caching the pre-match
                                                        profile over the paid one
```

`resolveAccount()` called `load()` directly. And the S0 change that stopped `GET /api/profile`
creating files (`store.ensure` -> `store.load`, so an unauthenticated GET is no longer an
unauthenticated disk write) pointed the **busiest read path in the server** straight at it.

**Proven against the real binary, not argued.** Twenty pre-seeded profiles, cold cache, one
`POST /api/profile` and one `GET /api/profile` fired at the same instant per device:

```
$ node h2-race.mjs race <dataRoot> http://127.0.0.1:8794 20     # lock on ensure() only
  round 0  device-race00000: LOST — cache="Original" disk="Original"
  round 1  device-race00001: LOST — cache="Original" disk="Original"
  round 13 device-race00013: LOST — cache="Original" disk="Original"
  round 16 device-race00016: LOST — cache="Original" disk="Original"
  round 19 device-race00019: LOST — cache="Original" disk="Original"
  5/20 writes lost

$ node h2-race.mjs race <dataRoot> http://127.0.0.1:8795 20     # lock on load()
  0/20 writes lost
```

`disk="Original"` is the part that matters: `markDirty` had already named the device, so the 800 ms
debounce flushed the loss to the file. `reviewSubmission` had already stamped `record.settled`, so
the match could not be replayed.

**Real fix.** The lock is on `load()` — the writer — with a private `loadLocked()` for the callers
that already hold it (`ensureLocked`). `loadLocked` re-checks the cache both before and *after* its
`await`s, so a live entry always wins over a copy read from disk; the second check is belt and
braces against `save()`, which is public and writes the cache without the lock. A cache hit still
skips the lock entirely, so the common path is unchanged.

**Test.** `server/src/economy.test.ts`, "is not overwritten by an UNLOCKED reader whose disk read
lands last". The earlier test fires both halves and hopes — which is why it never caught this: real
scheduling happens to favour the writer. The new one hands the store an `FsLike` whose `readFile`
resolves on command *and snapshots the file bytes when the read is issued*, so the ordering in the
diagram above is produced deliberately rather than waited for. Red before the fix
(`the payout was overwritten in the cache: expected +0 to be 1`), green after.

---

## 6. The reward journal's idempotency key, as specified, would have refused most payouts — DESIGN BUG, FOUND BEFORE IT SHIPPED

Not a bug in code that ran. A bug in `docs/PLATFORM.md` §4.2–4.3, caught while building it, and
recorded here because the design document is now wrong on paper in two places and the next reader
needs to know which one won.

**What the document specifies.** *"Idempotent on `(kind, sourceId)`"*, with
`` sourceId = `${HOST_ID}:${sessionId}` `` and `` sessionId = `${room.name}#${round}` ``.

**Three separate collisions, in increasing order of how much money they lose.**

1. **Both currencies of one payout share the key.** A payout writes an XP row and a Scrap row. Under
   `(kind, sourceId)` the second is a duplicate of the first, so exactly half of every player's
   money never reaches the journal. Caught by the §4.4 invariant on the Scrap currency — the one
   collision the specified test would have found.
2. **Every player in a round shares the key.** `sessionId` names a ROUND, and a round pays everyone
   in the room. The first player paid claims the key and the other 31 are refused. And because the
   claim has to gate the *mutation* — a journal that declines to record a payout while
   `applyMatchResult` runs anyway is a journal that lies about a balance it watched change — those
   31 players are not paid at all. `server/src/economy.test.ts`, "records one row per currency,
   summing to exactly what was stored", is red under the document's key: two players in one round,
   two rows instead of four.
3. **A reaped room's replacement reuses the key.** `HOST_ID` fixes the restart case the document
   names. It does not fix the case the document does not: `ModeRouter` reaps an empty room and
   builds another under the same key, whose rounds start at 1 again. `"deathmatch#1"` therefore
   names two different matches on one host on one day. `server/src/economy.test.ts`, "pays a NEW
   room that reuses the key and starts at round 1 again", is red under `${hostId}:${sessionId}`:
   one row where there should be two, and a player silently unpaid for a whole match.

**What shipped.** The idempotency key is the triple `(kind, sourceId, playerId)`, length-prefixed so
a room key containing `~`, `:` or `#` cannot forge another one. `append` takes the whole movement
GROUP — both currencies — and claims that one key for it. And `sourceId` is
`` `${hostId}:${roomInstanceId}:${sessionId}` ``, where `roomInstanceId` is minted in the `Room`
constructor and never reused.

**Why the invariant test alone would not have caught the second one.** A player refused a payout has
no rows *and* no balance, so `Σ delta == balance` still holds for them. The invariant is blind to a
*refused* payout and only catches a *misrecorded* one. `server/src/journal.test.ts` therefore counts
the rows as well: `expect(j.status().appended).toBe(payouts * 2)`, which fails with
`expected 20000 to be 50000` under the document's key.

## 7. Three more fields that read zero forever, and the profile screen is what found them — MEDIUM, TWO NAMED, ONE FIXED

`docs/PLATFORM.md` §0.1 and §13 item 9 already record one of these: `SaveFile.profile.{xp, level,
secondsPlayed, adsRemoved}` are set by `createSaveFile()` and written by nothing, so any UI that
renders them shows a permanent zero. The fix given there is "do not render those four fields", and
that is a fix for four fields.

Building the profile screen — the first surface in the game that reads the save for *display* rather
than for resume — turned up three more of exactly the same shape. The general check that finds them
is mechanical and lives in `client/src/ui/profileModel.test.ts`:

> Every `progress.<field>` this screen renders must have a writer in `client/src/main.ts`, and every
> `record*` exported from `shared/src/saves.ts` must have a caller under `client/src`.

Run over the source, it produced three names in one pass.

**1. `recordDeathmatch` has no caller anywhere.** `shared/src/saves.ts:1077`. `recordQuestLevel`
(`quest.ts:1089`), `recordBuilderSession` (`builder.ts:974`) and `recordHordeRun` (`horde.ts:1311`)
are all called from their modes; this one never was. So `save.deathmatch` — `matches`, `wins`,
`bestStreak`, `headshots`, `damageDealt` and the `weaponKills[]` histogram — is `{0, 0, …}` on every
device that has ever run this game. `docs/PLATFORM.md` §6.2 names that histogram as the profile's
one genuinely interesting panel and cites `saves.ts:172` as its source; the source is never written.

*Status: NAMED, NOT FIXED.* The panel renders no rows and a sentence saying per-match records are not
being written, rather than a column of zeroes that reads as data loss. Wiring it properly needs
`deathmatch.ts` to accumulate per-weapon kills, a best streak and headshots across a match, which is
a mode change. It is listed in `UNWRITTEN` in `profileModel.test.ts`, with the reason, and the test
fails if a fifth recorder ever joins it unnamed **or** if `recordDeathmatch` gains a caller and
nobody takes it off the list.

**2. `progress.wins` is never written — and it was one line from shipping.** `progress.gamesPlayed++`
fires in `startMode`; `kills`, `deaths`, `xp`, `level` and `secondsPlayed` are written by the save
loop. `wins`, `bestKillstreak`, `blocksPlaced`, `blocksBroken` and `favouriteWeapon` are written by
nothing. The first draft of the Matches tile read `hint: \`${groupInt(progress.wins)} won\``, which
would have put a permanent **"0 won"** under everybody's match count. *Status: FIXED before it
shipped.* The hint now says `entered on this device`, which is also the honest word for a counter
incremented at `startMode` rather than at a result.

**3. There is no name entry anywhere in the shipped UI.** Neither `progress.name` nor
`save.profile.name` is assigned by any file under `client/src`. `main.ts` reads
`name: progress.name || 'Marine'` into `new Game(...)`, so **every player in this game is called
Marine** — in the scoreboard, on the wire, and in the profile header. It renders as a sensible
default rather than as a zero, which is why nobody noticed. *Status: NAMED, NOT FIXED*, in
`UNWRITTEN_PROGRESS`. Adding an editor means deciding whether a mid-session rename reaches the room,
and `Game` has no `setName` — that is a protocol question, not a profile-screen one.

**The lesson worth keeping.** The screenshot found the first of these, not the test suite: the
Matches tile said `1` while the Deathmatch panel said "No matches on this device yet", one above the
other, and the contradiction was visible in a way that 1,700 green tests were not. The test that
generalises it was written afterwards and is red against each of the three. **A screen is a
different kind of assertion about the data than a test is, and this repo had never made one.**
