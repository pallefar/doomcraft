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
