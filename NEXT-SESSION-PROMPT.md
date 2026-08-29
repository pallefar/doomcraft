Continue Doomcraft (~/youtube/doomcraft). Start by reading HANDOVER.md at the repo
root — it is the 2026-08-29 handover, rewritten at the end of the session that
shipped Studio S4 (the challenge engine) and then reviewed it hard. Read §0
first: rules 17–20 are new and each one cost real time. §1 is what shipped, §3
is the work queue in the order I decided, §6 is a list of findings that were
raised but NEVER verified. Follow the queue top-down unless I redirect.

0. FIRST, before any new feature: §6's unverified findings. The adversarial
   review's later rounds lost their refuters to a usage limit, so five money-path
   claims were written down rather than believed. One is critical-severity —
   "Deploy-drain discards final-round settlements the journal already recorded"
   (server/src/index.ts) — and this project deploys at every green stage, so if
   it is real it has been quietly losing settlements all along. Verify each claim
   against the source (a fan-out is right for this: one agent per claim, each
   returning a verdict with file:line evidence and a concrete failure scenario),
   then fix what survives, red-proof first. Several are PRE-EXISTING, not S4 —
   judge them on truth, not on provenance.

1. Sponsors phase 2 — but NOT the way its own doc orders it. A design panel
   established that the §3.5 dashboard is NOT buildable from ads.jsonl as it
   stands: `mint()` never appends, so "Total (rendered) impressions" has no
   denominator, and with no non-viewable event a Viewable Rate computed from the
   log prints 100% — the MRC-forbidden conflation the spec's own caveat block
   exists to prevent. So the order is:
   - P2a-0: instrument the log (nonce, mode, platform on every row; a `rendered`
     event at mint; a terminal per-fill verdict carrying `qualified`; a `basis`
     field so Undetermined is measured not guessed; day-shard + prune, because
     the log keeps device-hashed rows forever against a documented 30-day
     commitment).
   - P2a-1: the dashboard, honest by construction — unsupported metrics print an
     em-dash WITH THE REASON, never 0 and never 100%; PROVISIONAL banner (there
     is no settlement layer, and docs/SPONSORS.md:1338 wrongly claims one
     shipped); "billable" renamed provisionally-qualified; house/direct split;
     accidentalRate as a floor; a 2D-path caveat block, not the verbatim one.
   - P2b: S10 interstitial. The decide route silently drops SurfaceId.INTERSTITIAL
     and REWARDED, and FrequencyCap.perDayInterstitials is typed, defaulted and
     never read.
   - P2c: S11 rewarded + the Gate 5 handshake. Durable per-day grant caps go ON
     THE PROFILE (§0 rule 20's precedent), never in memory.
   The full evidence is in the sponsors-p2 memory and the scratchpad design brief
   the handover points at. Do not re-derive it; do challenge it.

2. Then the variants arc V1–V5 per docs/VARIANTS.md §5: V1 SessionArsenal seam
   (byte-identical determinism proof) → V2 schema + pack + power-budget. STOP
   before V2 — §7 leaves me three decisions (power-budget weights, variant rarity
   floor, competitive parity). Ask, don't assume.

3. Then the gauntlet (0/23), the deferred Deathmatch share surface (its scoreboard
   is pointer-events:none — it needs its own #ui element), and portals/TWA.

USE WORKFLOW LOOPS THROUGHOUT — an explicit opt-in for multi-agent orchestration
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
