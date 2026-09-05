Continue Doomcraft (~/youtube/doomcraft). Start by reading HANDOVER.md at the repo
root — it is the 2026-09-04 handover, written at the end of the session that
verified and fixed the whole of the old §6 (the money-path findings the S4 review
never got to). Read §0 first: rules 21–23 are new, and two of them are about
tests that passed when they should not have. §1 is what shipped, §3 is the work
queue, §6 is what is deliberately still open. Follow the queue top-down unless I
redirect. **Sponsors phase 2 is the next arc.**

0. §6's unverified findings are DONE — do not redo them. All five were
   confirmed by two independent passes (a per-claim Claude fan-out and a Codex
   run over all six), Codex found a sixth nobody had, and every one is fixed,
   deployed and pinned by a test proven red with its own fix reverted. Commits
   `1d0ae7b`, `3de4329`, `ff12185`, `edbbe06`, `96d067a`. The critical claim was
   true: the drain detached players, which STARTS a payout, and then closed the
   store and exited while it was still in the air — the journal row landed and
   the balance did not, on every deploy. §6 now lists only what is deliberately
   still open; the reconnect grace window is the one real piece of work in it.

1. SPONSORS PHASE 2 IS DONE — do not rebuild it. P2a (instrumented log, daily
   aggregates, retention gated on aggregation, the honest Delivery report),
   P2b (S10 interstitial) and P2c (S11 rewarded, Gate 5, grant caps on the
   PROFILE at PERSIST_VERSION 7) all shipped, deployed and verified in
   production. Commits d42374b, 2c08f9e, f11e8d4, 9bb7e74, 74b5bcb, 2c4d498,
   d6c74ed, 2e2780c, 136620f, 7bd0274, baf2d3c, eb212df, 3dae9b2, fde6758.
   Two loose ends finish the arc and are in §3: no screenshot harness for the
   rewarded overlay, and no Basic Training drill for either sponsor surface
   (the admin half shipped as Guides 9). Everything else left in sponsors is the
   THIRD-PARTY half and needs the accounts in §5.

2. Then the variants arc V1–V5 per docs/VARIANTS.md §5: V1 SessionArsenal seam
   (byte-identical determinism proof) → V2 schema + pack + power-budget. STOP
   before V2 — §7 leaves me three decisions (power-budget weights, variant rarity
   floor, competitive parity). Ask, don't assume.

3. Then the gauntlet (0/23), the deferred Deathmatch share surface (its scoreboard
   is pointer-events:none — it needs its own #ui element), and portals/TWA.

USE WORKFLOW LOOPS THROUGHOUT — and USE CODEX AS ONE OF THE VOICES. Running a
Codex pass in parallel with the Claude fan-out is what caught the payout
`sourceId` bug last session, and it independently confirmed all six claims,
which is a much stronger signal than six agreeing agents from one model. It also
mis-reported one deliberate design decision as a defect, so verify its findings
the way you verify everyone's (rule 23). It is — an explicit opt-in for multi-agent orchestration
on every substantive arc. What actually worked last session, in this shape:
a parallel recon fan-out BEFORE each arc (map the seams, return file:line facts);
an adversarial DESIGN panel before building anything expensive (it killed the
sponsors dashboard before a line was written, and found a live production leak
while auditing something else); and an adversarial REVIEW after each
implementation lands — dimension finders, loop-until-dry, then 3 refuters per
finding with distinct lenses and majority-refute to kill. Two cautions learned
the hard way: a finding with ZERO votes is UNVERIFIED, not confirmed (split by
vote count before believing any "confirmed" list), and agent-written prose needs
a verifier pass exactly as much as agent-written code does.

Standing rules: full suite green before any commit; commit → push → redeploy at
every green stage (runbook is HANDOVER §4 — Railway from a clean worktree, and
per rule 17 verify with a route the build ADDS, never the build id, because the
CLI's timeout is not a failure and the build id can name the wrong build); prove
new regression tests red with the fix reverted — and check WHAT goes red; verify
features with a boot + screenshot or a measurement, never just green tests; one
commit per stage; stage explicit paths when a workflow is writing into the tree
(rule 19). Keep the standing tutorial directive: when a new player system or
admin capability ships, extend Basic Training (a new drill) or the console Guides
screen (a new card) in the same arc.

§5 carried over: what is blocked is account-shaped, not engineering-shaped — the
ad-network/CMP accounts gate only the THIRD-PARTY half of sponsors, so all of the
work above is unblocked; store fees gate the portals arc; variants V2 waits on my
three §7 answers. The owner seat is claimed and durable
(~/youtube/doomcraft-owner-credentials.txt).
