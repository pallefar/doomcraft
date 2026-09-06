Continue Doomcraft (~/youtube/doomcraft). Read HANDOVER.md §0 — **rules 35-38 are
new and every one cost real time**, and 38 is the one that changes how you write
tests. `ref/BAR.md` is the bar and it was WRONG about the bar until today.

**NOTHING IS WAITING ON ME. The order below is decided. Start building.**

## Where it stands

**THE V4 ARC IS COMPLETE AND LIVE — a through f.** A player can own a weapon
variant, equip it, fire it, see it named in the killfeed, craft one at the
bench, and click Equip on it. Every phase went to Codex as numbered clauses
before a line was written; every one is deployed and verified by probing a value
only that build emits.

**THE GAUNTLET IS 2/23 AND IT FINALLY RAN.** Gunfeel and HUD both won blind and
uncontaminated. Four verdicts were produced to get the first two: two were
correctly thrown away, once because the bar clip had a SHOVEL in it (rule 37)
and once because my own fairness note named architecture and mapped the labels
(CRITIC.md 2b). HUD is the more useful precedent — it won with NO BUILD ROUND,
judging our current HUD cold, which means judging a piece before building it is
a legitimate and cheap first move. MENUS was piece three and was in flight when
this was written; check `progress/state.json` and
`.../scratchpad/ab/menus-r1/` for where it got to.

Piece selection matters: prefer STILL pieces (full-page screenshots) while the
motion asymmetry below is unfixed, and re-capture the bar for the specific
question before judging — the reference has now been stale in OUR favour three
separate times.

**The gunfeel code is MERGED** (`52e8db8`; `main` and `gauntlet` now agree).
Both branches had appended a parameter to the SAME damage functions — gunfeel a
`flags` so a monster kill raises DMG_FATAL, V4d a `variantSlot` so the killfeed
names the gun — and the resolution is the union with both REQUIRED. After
resolving, the merged BODY was checked for evidence of each contribution, not
just for a clean `tsc`: a merge's characteristic failure is silently keeping one
side, and `e.variantSlot = variantSlot` on the pooled kill event is exactly the
assignment V4d's rule-38 proof exists to protect.

## The order

1. **The achievement system.** Model it on `shared/src/challenges.ts` —
   `ChallengeDef` is `{id, name, blurb, period, stat, target, scrap, item}` and
   the condition is DATA, never a shipped predicate. Achievements are lifetime
   and one-shot rather than periodic. `StoredChallenges.owed`
   (`persistence.ts`) is the debt shape for anything banked in a session that
   may not pay it. Note `CHALLENGE_STATS` deliberately excludes `seconds` —
   "a stat the player cannot fail to accumulate is a login reward wearing a
   challenge's name."
2. **THE GAUNTLET.** The apparatus is now trustworthy and the
   facts below are expensive. Keep going.
3. Then the rest: portals/TWA, C7 analytics, the deathmatch share surface, and
   the two sponsor loose ends in HANDOVER §3.4.

## Defects found and DELIBERATELY LEFT OPEN — fix or decide, do not rediscover

- **A pack version above 65535 silently disables EVERY item grant.**
  `PackInventory.itemsVersions()` accepts any integer >= 1 with no upper bound
  while `parseItemRef` is `^items@(\d{1,5}):` and caps at `0xffff`. Install
  `items/100000/items.json` and every ref the server mints is unparseable, so
  `grantDrops` silently drops match drops, challenge items, competition prizes
  AND craft output — no error anywhere. Pinned by a test (it is the lever V4e's
  fallback proof uses); the cap itself is unfixed.
- **`equippedSkin` and `title` are still reachable through `POST /api/profile`.**
  V4c added `variants` to `SERVER_OWNED_PROFILE_FIELDS` and left those two.
- **`craft.ts` clears `equippedSkin` on consuming a last copy but not a variant
  claim.** Read-time validation covers it today.
- **The `loadoutTab.ts` wiring proof is a SOURCE RATCHET, not behavioural.**
  There is no jsdom here and `LoadoutTab` needs a document plus three fetches.
  It discriminates on all three reverts but asserts the presence of a call, not
  its effect. A behavioural version needs `profile.test.ts`'s DOM-stub
  treatment extended.
- **The Lost Soul has three different sizes** — `bots.ts` spawns it 0.9 m,
  `MONSTER_LOOK` gives the client hit target 0.7 m, `drawMonster` renders a
  0.5 m cube spanning 0.15-0.65. A shot at 0.8 m damages it on the server,
  produces no client marker, and hits nothing the player can see. Belongs to the
  ENEMIES gauntlet piece.
- **Melee headshots are client-only, for players too.** `resolveMelee` is a cone
  test with no head box on either branch.

## The gauntlet apparatus — every line here was paid for

- **Run pieces ONE AT A TIME.** A headed 60 fps capture is a measurement on
  shared hardware. Concurrent captures, or a full suite run during one, corrupt
  the frame times the critic reads.
- **Four tests are LOAD-SENSITIVE**: `client/src/audio/synth.test.ts`'s boot
  budget and three in `client/src/net/chunkz.test.ts`. At load average 30-70
  they fail; alone they pass 51/51 in 12 s. A green suite claim needs the
  machine load recorded beside it. Quiet-machine baseline: ~95-137 s for the
  whole suite.
- **`tools/capture-ours.mjs` CANNOT record video** — no `reccanvas` import
  anywhere; it is screenshots plus metrics. A motion piece needs a separate
  recorder.
- **OUR HUD CANNOT REACH A CANVAS RECORDING.** Our crosshair, hitmarker, ammo,
  health and minimap are separate elements that `canvas.captureStream()` misses;
  the bar renders its crosshair and minimap INTO its canvas. So every MOTION
  comparison silently handicaps us, and the hitmarker the gunfeel round built is
  invisible in its own A/B. STILL comparisons (full-page screenshots) do not
  have this problem — that is why HUD was chosen as piece two.
- `capture-ours.mjs` **reuses whatever already listens on its port** — always
  pass `--port`, and `lsof -i` it first, or you will photograph another tree.
- A default capture run is headless, unthrottled, dev-server, and reports
  ~120 fps median. **That is an uncapped-vsync artifact, not a frame cost.**
  Use `--headed --prod`.
- The neutral A/B metrics keys are NOT the keys either side emits. Both store
  `tTitle`, `tPlayable`, `bytes` and a nested `fps{}`. Map them or you write
  nulls and void the measurement half in silence.
- **A metrics key that is null on one side and populated on the other is itself
  a de-blinding channel.** Fill both or null both.
- The worktree is at `~/youtube/doomcraft-gauntlet` (branch `gauntlet`). A
  blanket `node_modules` symlink ALIASES IT BACK TO THE MAIN TREE, because the
  workspace links are relative — build a real dir of per-entry symlinks with a
  real `@doomcraft/` pointing inside the worktree.

## Standing rules — not optional

**Put every plan to Codex as numbered CLAUSES before a line is written**, and
require a closing list of the clauses it judges CORRECT:

    codex exec --sandbox read-only --cd /Users/karstenhaldan/youtube/doomcraft - < plan.txt

**And ask it the rule-38 question every time:** *for each proof obligation, do
the DEFECTIVE and the CORRECT implementation produce the same asserted value on
the input as specified?* Asked on V4e it found four of six obligations were
decoration. On V4f, three of five. It costs one sentence.

**Execute every runtime claim before it enters a plan.** Three of my claims were
overturned this session and all three were sentences I READ rather than RAN —
one from Codex, one from my own harness, one from this project's own handover.

**Write briefs from the CODE**, and end every brief telling the agent to report
anything in it that is wrong. That sentence caught something in every single
brief this session.

**Prove every regression test red with its fix reverted, check WHAT went red,
and report what the defective build produced on that same input.**

**Deploy verification, in order:** `git status` clean (a builder mid-edit means
`railway up` uploads half-written code); CI green; `railway up --detach`; poll
`railway deployment list` to SUCCESS; then probe a value only the new build
emits — never the build id, which lies. Re-probe `GET /api/admin/release` for
`history: []` immediately before, because `/api/version` CANNOT tell you that
(rule 35). Then `tools/smoke-signal.mjs` and `data.writable`.

`railway link -p 32896841-c5c5-42ff-a408-a22a5807356b -e production -s doomcraft`
works non-interactively, contrary to the older note.

Owner seat: `~/youtube/doomcraft-owner-credentials.txt`, sign in at
`/api/auth/signin`.
