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

**Found while wiring the entitlement guard into `Room` (A1 task 1). Deliberately left alone:
changing round-timer semantics is a much larger change than the one it was found inside.**

**Mechanism.** `Room.updateRound` (`server/src/room.ts`) decrements `timeLeftMs` on every tick in
the `LIVE` branch with **no reference to `plan.runRoundTimer`**. Only Deathmatch declares
`SYS_ROUND_TIMER` (`shared/src/modes.ts`), and `plan.runRoundTimer` is read in exactly two other
places — the `ModeAction.RESTART` handler and the mode-context sender — never by the round clock.

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

**Not the fix that was applied.** A1 handles idle farming with per-day caps, diminishing returns
and a minimum paid duration rather than by touching the round clock, because gating `updateRound`
on `plan.runRoundTimer` changes what a Horde room *is* (Horde would then have no round boundary at
all, and `endRound` is the only thing that closes a ledger session).

**Fix, when someone takes it:** gate both the countdown and the `beginRound(true)` restart on
`plan.runRoundTimer`, and give the modes that opt out an explicit session-close path so the
entitlement ledger still has a round boundary to settle against.

**Related, same handler, also not fixed:** `ModeAction.RESTART` calls `beginRound(true)` for any
mode with `runRoundTimer`, straight off a client message. In a Deathmatch room that is a client
regenerating everybody's terrain on request.

---

## 5. A finished match could be erased by somebody opening the profile page — FIXED

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

**Fix.** `ensure` returns a cache hit without locking (that object is the one `update` mutates
anyway) and takes the per-device lock on a miss, re-reading under it. `update` and `linkAccount`
already hold that lock, so they call a private `ensureLocked` — `withLock` is not reentrant and the
naive version deadlocks on itself.

**Test.** `server/src/economy.test.ts`, "a payout landing while somebody reads the profile". Cold
`JsonFileStore`, `update` and `ensure` started in the same tick. Red before the fix
(`expected +0 to be 1`), green after, and the live end-to-end test in `online.test.ts` stopped
flaking.

**`MemoryStore` does not have this bug** — its `ensure` has no `await` before `cache.set`, so there
is no window to interleave in. It is left alone deliberately rather than "fixed" symmetrically.
