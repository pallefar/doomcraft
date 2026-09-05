Continue Doomcraft (~/youtube/doomcraft). Read HANDOVER.md §0 first — rules 29-35
are new and every one cost real time. `docs/VARIANTS.md` §5a is the live arc.
`ref/BAR.md` is the bar.

**NOTHING IS WAITING ON ME. The order below is decided. Start building.**

## Where it stands

V1-V3 are CLOSED. Their five loose ends are fixed, and so are nine more defects
that were found while closing them — six of those by putting plans to Codex
BEFORE writing code, which is the single highest-yield habit in this project.

**V4 is now FIVE sub-phases** (docs/VARIANTS.md §5a), because the review refused
it as one and broke nine of eleven clauses. Split into six-clause pieces it
scores four of six. A phase small enough to review is a phase that survives one.

**V4a is DONE and DEPLOYED** (`ef1100d`): `content/variants.json` ships two rows
— `shotgun-slug` and `rocket-swift` — the `content/` fallback exists with
packsRoot winning, the offline gate reads and emits kind 7, and a real client
gets both rows with all sixteen effective fields. Every player still resolves to
slot 0; nobody can own or equip anything yet.

## The order

1. **V4b — the ownership token.** `ItemKind.WEAPON_VARIANT`, `ItemDef.variantId`,
   items serialization. Put it to Codex as numbered clauses first. Known traps:
   - there are **NO `ITEMS_*` literals** — items are a dynamically fingerprinted
     DATA pack, so nothing to bump, but appending a field unconditionally
     changes every old item line AND the recomputed digests of already-installed
     items versions. Preserve legacy serialization for non-variants or handle
     that compatibility break explicitly;
   - the naive new line is **177 bytes** against the 160-byte cap;
   - `guessKind` splits an id on `-` and indexes `ITEM_KIND_NAMES`, so a token
     must be `weapon_variant-shotgun-slug` or it renders under "Skins";
   - do NOT add variants to the untradable pair — server trades check
     `def.tradable` and tradable variants already fit that policy;
   - `PackInventory.summary()` has no `variants` key, so the admin Inventory
     screen still cannot show the installed version that now always exists.
2. **V4c — the claim reaches the body.** The room is known BEFORE ticket
   redemption (`router.route` returns `{key, room}` before the await at
   `index.ts:4116`); resolve against THAT room's pinned ordering, not
   `releases.live()`, or a reversed row order grants the wrong gun.
   `equipVerdict` learns only an item's KIND today, so a shotgun token submitted
   for `variant:0` returns **200** while the arsenal serves pistol damage.
   **`trust.test.ts`'s scan does NOT cover variants** — its regex has no
   `variant` term, so §4's claimed protection does not exist. Build it.
3. **V4d — display truth.** The client holds no variant NAMES; a display name is
   a separate additive message. A 9th KILL byte is compatible, but the new
   decoder must accept 8-byte messages and RESET the reused event's slot.
4. **V4e — acquisition.** As specified, supply stays **0 forever**: initial
   supply 0, drops none, trading conserves, every craft needs three variants.
   Needs a distinct ENTRY recipe.
5. **An ACHIEVEMENT system.** Model it on `shared/src/challenges.ts` —
   `ChallengeDef` is `{id, name, blurb, period, stat, target, scrap, item}` and
   the condition is DATA, never a shipped predicate. Achievements are lifetime
   and one-shot rather than periodic. `StoredChallenges.owed`
   (`persistence.ts:196`) is the debt shape for anything banked in a session
   that may not pay it.
6. **THE GAUNTLET — still 0/23, still never run blind.** The harness works:
   `node tools/capture-ours.mjs` produced 86 frames this session and the twelve
   baseline points line up 1:1 with `ref/voxiom/desktop-*.png`. **A default run
   is HEADLESS, UNTHROTTLED and against the dev server — its 120 fps is a
   capture artifact this project has already been fooled by once.** A fair A/B
   needs `--headed --prod` with the same throttle on both sides, and the two
   lines kept apart: beating the bar is a 1% low above **53.8**; meeting spec is
   **55**, deliberately harder. Use `tools/blind.mjs` and let the critic score.
   Start with GUNFEEL — it is ref/BAR.md weakness #2, the most winnable piece,
   and `sim.ts:1698` still passes `flags = 0` for entity damage so a monster
   kill never shows the fatal hitmarker and a monster headshot never shows the
   headshot one. That is a gunfeel decision for a blind critic, not a
   correctness commit, which is why it was left.
7. Then the rest: portals/TWA, C7 analytics, the deathmatch share surface, and
   the two sponsor loose ends in HANDOVER §3.4.

## Standing rules — not optional

**Put every plan to Codex as numbered CLAUSES before a line is written**, and
require a closing section listing the clauses it judges CORRECT so a clean bill
is a visible judgement:

    codex exec --sandbox read-only --cd /Users/karstenhaldan/youtube/doomcraft - < plan.txt

It refuses plans, and it has twice found defects in code committed hours
earlier. Then verify every finding yourself, BOTH directions — two of its
constants this session were wrong.

**Write briefs from the CODE, not from a review.** Five of six briefs written
this session contained a claim the builder correctly overturned. End every brief
with an explicit instruction to report anything in it that is wrong; that
sentence is the highest-yield line in the template.

**Prove every regression test red with its fix reverted, and check WHAT went
red.** And ask of every assertion whether the quantity is produced BY the
mechanism under test or ALONGSIDE it. A scalar set beside a loop can be truthful
about a loop that is lying.

**The full suite runs when NO builder is in the tree, in either direction.**
Check `git status --short` first. Match `pgrep` on the repo path — another
session'"'"'s vitest on this machine will otherwise look like your own.

**Deploy verification, in preference order:** probe `/api/version` for a content
version only this commit declares; poll `railway deployment list` to SUCCESS
(never the CLI'"'"'s exit code); run `node tools/smoke-signal.mjs wss://<origin>`,
which as of `ef1100d` can finally SEE an empty table instead of just a sent
message; confirm `data.writable`. The Vercel bundle-hash rule does NOT reproduce
from this machine — HANDOVER §4 explains why and what replaces it.
`railway link` needs an interactive service prompt, so do not chain it in a
background command with output suppressed.

Owner seat: `~/youtube/doomcraft-owner-credentials.txt`. Sign in at
`/api/auth/signin` — there is no `/api/admin/signin`.
