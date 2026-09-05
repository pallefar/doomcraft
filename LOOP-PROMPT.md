Continue Doomcraft (~/youtube/doomcraft). Read NEXT-SESSION-PROMPT.md, then
HANDOVER.md §0 — rules 29-34 are new and every one cost real time. Work the order
NEXT-SESSION-PROMPT gives: finish V4 (V4b→V4e, docs/VARIANTS.md §5a), then the
achievement system, then THE GAUNTLET, then the rest of the mapped-out queue.

The bar is ref/BAR.md, and it is real and fetchable. voxiom.io for menu, HUD, ad
integration, terrain, load time and mobile; DOOM 1993 for movement, gunfeel and
enemies; Minecraft Classic for building. All three are captured in ref/ and
re-capturable with tools/capture-ref.mjs. Get the real frames and compare against
them directly, never against a description of them. The gauntlet is 0/23 and has
still never had a blind A/B run — that is the thing this project exists to win,
and it has been deferred five sessions running. Do not let it be deferred again.

Break each stage into the smallest pieces that can be built and judged on their
own. For each piece, fan out a builder and a separate critic with fresh context.
The critic runs the thing, puts it next to the bar blind with the labels stripped
(tools/blind.mjs), says which is better, and names the single biggest remaining
gap. Then it goes back to the builder.

The critic should be a harsh critic. Praise is not useful. If ours does not win,
it keeps going.

The measurable half is not negotiable and the critic checks it too: full suite
green and CAPTURED TO A FILE, release:verify 17/17, every regression test proven
red with its fix reverted AND what went red actually checked, and every plan put
to Codex as numbered clauses before a line is written. A green test that cannot
fail is worse than no test.

## What last session proved about that last rule — apply it from the first piece

SIX separate gates in this repo were found reporting green while testing
nothing: `d[0] === 13`, `0 == 0` on an empty manifest, a fingerprint compared
without its inputs, a check whose passing message said "none installed", a
byte-cap the offline gate never ran, and a pack version with no second source to
compare against. One of them had been signing off every deploy in this project's
history. They all read like assertions.

**The tell, and use it on every check you write or trust: ask what the WEAKEST
input is that still satisfies the predicate, and whether the product could ever
emit it.** If a check's passing message describes the ABSENCE of the thing it
validates, it is not a pass — it is a check that has never run.

Three more that cost real time and will again:

- **Ask of every assertion whether the quantity is produced BY the mechanism
  under test or ALONGSIDE it.** A scalar set beside a loop can be truthful about
  a loop that is lying. A critic broke one of my tests exactly this way.
- **Write briefs from the CODE, not from a review.** Five of six briefs last
  session contained a claim the builder correctly overturned. End every brief
  with an explicit instruction to report anything in it that is wrong — that
  sentence is the highest-yield line in the template.
- **When two paths validate the same data, the test is not "each refuses bad
  input" — it is that the SET each accepts is identical.** Two copies of a rule
  drift; make one list a literal prefix of the other. A strict rail added to one
  door against an EPS-tolerant check on the other shipped a gate-green pack that
  served a room with zero variants.

## Codex, and how to drive it

    codex exec --sandbox read-only --cd /Users/karstenhaldan/youtube/doomcraft - < plan.txt

Numbered CLAUSES, attack each one, demand a concrete failure scenario ending in
a specific wrong number, and REQUIRE a closing section listing the clauses it
judges CORRECT so a clean bill is a visible judgement. It refuses plans — it
refused V4 outright, breaking nine of eleven clauses — and it has twice found
defects in code committed hours earlier. Then verify every finding yourself,
BOTH directions: two of its constants last session were wrong.

Split anything it breaks badly. Eleven clauses as one phase scored 2 correct;
the same work as six-clause sub-phases scored 4. A phase small enough to review
is a phase that survives one.

## Operational rules that cost time last session

- The full suite runs when NO builder is in the tree, in EITHER direction —
  check `git status --short` first. Match `pgrep` on the repo path or another
  session's vitest looks like your own.
- Deploy verification, in preference order: probe `/api/version` for a content
  version only this commit declares; poll `railway deployment list` to SUCCESS,
  never the CLI's exit code; run `node tools/smoke-signal.mjs wss://<origin>`;
  confirm `data.writable`. The Vercel bundle-hash rule does NOT reproduce from
  this machine — HANDOVER §4 says why and what replaces it. `railway link` needs
  an interactive prompt, so never chain it with output suppressed.
- Read the code to find a MECHANISM; read the RUNNING SYSTEM to find whether it
  APPLIES. A deploy hazard I called blocking all session did not apply, and one
  `curl` would have settled it hours earlier.

/loop on each piece until the critic picks ours blind. Do not stop before that.

Keep progress/index.html updating as the work evolves so I can watch it, and
republish it to the same artifact URL.

Fan out subagents and ultracode.
