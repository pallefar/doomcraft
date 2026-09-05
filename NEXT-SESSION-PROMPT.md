Continue Doomcraft (~/youtube/doomcraft). Start by reading HANDOVER.md at the repo
root — it is the 2026-09-05 handover. Read §0 first: twenty-four rules, each of
which cost real time, and rules 21–24 are the newest. §1 is what shipped, §3 is
the work queue, §6 is what is deliberately still open. Follow the queue top-down
unless I redirect.

**THE FIRST THING IN THE QUEUE NEEDS ME, NOT YOU.** Read item 0 before planning.

0. **ASK ME THE THREE VARIANTS DECISIONS.** `docs/VARIANTS.md` §7 lists them
   verbatim, and the standing instruction is to ask rather than invent them:

   1. **The power-budget formula's weights** — sustained DPS vs range vs splash.
      The ±12% band is a starting proposal, not a decision.
   2. **The variant rarity ladder** — do variants start at uncommon (craft-only,
      per the craft fee table), or exist at common as drops-later?
   3. **Competitive parity** — are variants ON in every mode from V4, or
      table-gated out of ranked-adjacent surfaces until the season rolls?

   V1 (the SessionArsenal seam, with a byte-identical determinism proof) does
   NOT depend on any of them, so put the questions to me EARLY and then build V1
   while I answer rather than blocking on me. STOP before V2 until I have
   answered. Do not infer them from the docs — §7 exists because they are
   judgement calls I kept.

1. **SPONSORS PHASE 2 IS DONE. Do not rebuild any of it.** P2a (the ad log
   instrumented, day-sharded, aggregated into durable dailies, retention gated
   on aggregation, and the honest Delivery report), P2b (the S10 between-match
   interstitial) and P2c (S11 rewarded + the Gate 5 handshake, with grant caps
   on the PROFILE at PERSIST_VERSION 7) all shipped, deployed and verified in
   production. Commits: d42374b, 2c08f9e, f11e8d4, 9bb7e74, 74b5bcb, 2c4d498,
   d6c74ed, 2e2780c, 136620f, 7bd0274, baf2d3c, eb212df, 3dae9b2, fde6758.

   Two loose ends would finish the arc, both in §3 and §6, neither urgent:
   there is no screenshot harness for the REWARDED overlay (S10's is
   `tools/shot-interstitial.mjs`, and it should measure the same three things:
   focus lands somewhere usable, the cancel control works, and a completed watch
   actually pays), and there is no Basic Training drill for either sponsor
   surface — the PLAYER half of the standing tutorial directive. The admin half
   shipped as Guides 9.

   Everything else left in sponsors is the THIRD-PARTY half and is blocked on
   the ad-network/CMP accounts in §5. Account-shaped, not engineering-shaped.

2. **Then the gauntlet — still 0/23** (`ref/BAR.md`; the bar is real and
   fetchable). Then the deferred Deathmatch share surface (its scoreboard lives
   in pointer-events:none `#hud`, so it needs its own `#ui` element), then
   portals/TWA, then C7 analytics.

**USE CODEX, AND USE IT BEFORE THE CODE.** Its value last session was highest as
an adversarial DESIGN reviewer against a written plan plus the real source: it
overturned the central clause of the sponsors plan before a line was written
("emit a `rendered` event at mint" — wrong, a row minted server-side is
`served`, and calling it rendered recreates the exact conflation the spec
forbids), and it rated the retention ordering critical. Run it in parallel with
a Claude fan-out, never instead of one: two different models agreeing is a far
stronger signal than six agents of one model agreeing.

How to run it — the `codex:codex-rescue` subagent failed once with identical
flags (`failed to initialize in-process app-server client: Operation not
permitted`), so drive the CLI directly and write the prompt to a file, because
inline quoting mangles a long prompt:

    codex exec --sandbox read-only --cd /Users/karstenhaldan/youtube/doomcraft - < promptfile.txt

Give it the plan as numbered CLAUSES, tell it to attack each one, demand a
concrete failure scenario ending in a specific wrong number or broken behaviour,
and require a closing section listing the clauses it judges CORRECT — so a clean
bill is a visible judgement rather than silence. Then verify its findings the
way you verify everyone's (rule 23): it also reported one deliberate, documented
tradeoff as a defect.

**STANDING RULES.** Full suite green before any commit. Commit → push → redeploy
at every green stage (runbook is HANDOVER §4: Railway from a CLEAN WORKTREE,
and per rule 17 verify with a route or field the new build ADDS, never the build
id — the CLI's timeout is not a failure and the build id can name the wrong
build). Prove every new regression test red with its fix reverted, AND CHECK
WHAT GOES RED — that step caught five tests of mine that could not fail, and in
every case the revert staying GREEN was the finding. Verify a feature with a
boot and a screenshot or a measurement, never with green tests alone, and then
LOOK at the screenshot (it found three accessibility defects in the interstitial
that no unit test could). One commit per stage. Stage explicit paths when a
workflow is writing into the tree (rule 19). Ship the tutorial directive in the
same arc as the feature: a Basic Training drill for a player system, a Guides
card for an admin capability.

**Two things worth knowing before you start.** `server/src/accounts.test.ts >
signin > accepts the right passphrase` failed once in about six full-suite runs
and passes in isolation; it is recorded in §6 as an OBSERVED FLAKE, not
diagnosed, and the lead is that it may be the same family as the `ENOTEMPTY`
race I did fix — a spawned server child outliving the temp dir its suite
removes. And a schema-touching release can never be rolled back, so if you move
PERSIST_VERSION again, bump `DECLARED_PERSIST_VERSION` in `server/src/gate.ts`
in the same commit, deliberately; the gate will stop you otherwise, which is it
working.

The owner seat is claimed and durable (~/youtube/doomcraft-owner-credentials.txt).
Sign in for admin routes at `/api/auth/signin` — there is no `/api/admin/signin`.
