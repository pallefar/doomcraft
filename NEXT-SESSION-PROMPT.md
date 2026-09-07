Continue Doomcraft (`~/youtube/doomcraft`). Read HANDOVER.md §0 — **rules 40-43
are new; 40 is the one I broke myself and 43 is the shape the whole last day
had.** Then run `node tools/deploy-drift.mjs` before believing anything below.

**NOTHING IS WAITING ON ME EXCEPT ONE DECISION (item 1). The order is decided.**

## Where it stands

**THE ACHIEVEMENT SYSTEM IS BUILT, DEPLOYED, AND DARK.** A1-A4 shipped; the
binary is live on both tiers at `b6fb3c5`; the flag `economy_achievements` is
OFF. Lifetime, one-shot and RETROACTIVE: progress reads `profile.stats`, so the
profile and the award cannot disagree in front of the player, while the PROMISE
is snapshotted at detection because the counter preserves the STAT and what a
player is owed is the DEF, which lives in a pack that can be re-cut.

**§3.3 IS EMPTY.** Every defect that section carried is fixed or corrected. Two
were live money bugs: a merged account paid the same daily twice, and a
challenge debt paying out an item no manifest defined and calling itself
settled. Three entries turned out to be WRONG ABOUT THEIR OWN SUBJECT and are
corrected in place, not deleted — read them, they are the argument for rule 42.

**The gauntlet is still 2/23** and is the next building work.

## The order

1. **THE FLAG FLIP — the user's call, not yours.** `economy_achievements` ON is
   a FULL-REPLACE `DOOMCRAFT_FLAGS` env document carrying ALL SIX rules (the
   live five are `economy_competitions`, `economy_items`, `economy_scrap`,
   `economy_trading`, `share_cards`); an admin-console flip dies at the next
   restart. It pays every already-qualifying player at their next settling
   match — `achievement.first-blood` is one kill, so effectively everybody —
   and the six awards total 975 Scrap. Ask before flipping. After it, watch
   `/api/admin/release` and the journal rather than assuming.

2. **THE GAUNTLET.** Prefer STILL pieces while the motion asymmetry below is
   unfixed. MENUS is BLOCKED not lost (rule 39). The ENEMIES piece lost two
   real defects last session — the Lost Soul's hitbox and melee headshots — so
   what is left there is about FEEL, which is what the gauntlet is for.

3. Then: portals/TWA, C7 analytics, the deathmatch share surface, the two
   sponsor loose ends in HANDOVER §3.

## How the last day went wrong, so you do not repeat it

- **I reported seven commits as "shipped" while none of them was deployed**,
  including a live money fix. `node tools/deploy-drift.mjs` exists because of
  that. Say WHICH state you mean: committed, pushed, or LIVE.
- **A defect list is a claim.** Three of §3's entries were wrong about their own
  subject. Re-measure the SHAPE and the WIDTH before designing a fix — one
  entry named a single enemy and the honest question ("how many of the five
  disagree, and on which axis") turned a guess into a one-line correction.
- **Fixing a bug retires whatever stood on it.** A test used an open defect as
  its FIXTURE; closing the defect made that test vacuous rather than red. Sweep
  tests, policies AND comments; grep for the symptom, not the code.
- **Ask which mechanism actually makes a thing safe.** Three separate times,
  something was protected by a comment claiming coverage rather than by code.

## The apparatus — every line here was paid for

- **Run gauntlet pieces ONE AT A TIME.** A headed 60 fps capture is a
  measurement on shared hardware.
- **Load-sensitive tests:** `client/src/audio/synth.test.ts`'s boot budget and
  three in `client/src/net/chunkz.test.ts` fail at load 30-70. **And a fifth of
  a different kind:** `server/src/accounts.test.ts`'s `afterAll` can fail
  `ENOTEMPTY` in a concurrent full run — teardown, not timing. Record the
  machine load beside any green-suite claim. Quiet baseline ~100-135 s.
- **`tools/capture-ours.mjs` CANNOT record video** — screenshots plus metrics.
- **OUR HUD CANNOT REACH A CANVAS RECORDING**, so every MOTION comparison
  silently handicaps us. STILL comparisons do not have this problem.
- `capture-ours.mjs` **reuses whatever already listens on its port** — pass
  `--port`, and `lsof -i` first.
- A default capture run reports ~120 fps median: an uncapped-vsync artifact.
  Use `--headed --prod`.
- The worktree is `~/youtube/doomcraft-gauntlet` (branch `gauntlet`). A blanket
  `node_modules` symlink ALIASES IT BACK to the main tree.

## Standing rules — not optional

**Put every plan to Codex as numbered CLAUSES before a line is written**, and
ask it the rule-38 question: *for each proof obligation, do the DEFECTIVE and
the CORRECT implementation produce the same asserted value on the input as
specified?* It refused the achievement plan twice and found a LIVE double-pay
by running the shipped code instead of reading the plan.

    codex exec --sandbox read-only --cd ~/youtube/doomcraft - < plan.txt

**Execute every runtime claim before it enters a plan — including the ones you
write in your own test comments.** "Revert X and this fails" is a to-do, not a
statement, until the revert has been run.

**Prove every regression test red with its fix reverted, and check WHAT went
red.** Roughly ten of my own tests have passed with their fix removed. When the
defect is something MISSING or an ORDERING, assert the STRUCTURE — a count, a
position, an identity; output assertions are blind to absent steps.

**Deploy verification, in order:** `git status` clean; CI green;
re-probe `GET /api/admin/release` for `history: []` IMMEDIATELY BEFORE (rule 35
— `/api/version` cannot tell you); `railway up --detach`; poll
`railway deployment list` to SUCCESS; then a CONTENT-DERIVED probe — a pack
digest that moved, or the served bundle hash. **NEVER `build.id`**: it read
`b453e8b` before and after three separate deploys in one day.

`railway link -p 32896841-c5c5-42ff-a408-a22a5807356b -e production -s doomcraft`
works non-interactively. Owner seat: `~/youtube/doomcraft-owner-credentials.txt`.
The admin bearer is the Railway env `DOOMCRAFT_ADMIN_TOKEN`, NOT in that file.
