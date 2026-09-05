Continue Doomcraft (~/youtube/doomcraft). Read HANDOVER.md first — §0 is
twenty-eight rules that each cost real time, and 25–28 are the newest. §3 is the
queue, §6 is what is deliberately open. Follow the queue unless I redirect.

**NOTHING IS WAITING ON ME.** Every decision V3 and V4 need is taken and written
down (docs/VARIANTS.md §7, and §6 of the handover). Start building.

## 1. V3 — the wire. This is the whole job.

V1 (the `SessionArsenal` seam) and V2 (the schema, `PackKind.VARIANTS = 7`, both
gates) are shipped and LIVE. V3 tells a client which table its room pinned.

The plan below was put to Codex as numbered clauses BEFORE any code, and it
returned a clean bill on C1, C2, C3, C4, C7, C8 and C9's requirement. Build it:

- **`S2C.VARIANT_TABLE = 13`**, appended. It is ADDITIVE: `protocolFingerprint()`
  in shared/src/version.ts lists frozen ids BY NAME and stops at `s2c.chunkz`,
  and client.ts has `default: break`. No PROTOCOL_VERSION bump, no ratchet move.
  **docs/VARIANTS.md §3 says the opposite and is wrong** — that is the third
  false claim found in that document; fix the line while you are there.
  Add `expect(S2C.VARIANT_TABLE).toBe(13)` beside the MATCH_AWARD assertion in
  shared/src/version.test.ts.
- **Format:** `u8 count`, then per variant `str id`, `u8 base`, then the
  EFFECTIVE value of all 16 whitelisted fields as f32 in `VARIANT_FIELDS` order.
  Effective values, not a present/absent mask, so the client never combines the
  wire with its own compiled table. Max packet measured at 7 554 bytes.
- **THE SERVER MUST BUILD ITS ARSENAL FROM THE BYTES IT SENDS.** `w.f32()`
  narrows; if the server keeps the manifest's doubles and the client decodes
  float32, the two disagree in the eighth digit on every variant number — the
  exact bug class of `fc01475`. Encode, decode, and build BOTH arsenals from the
  decoded values. Codex walked a real number through and confirmed this is
  sufficient: 4.4 → 4.400000095367432 → `hot.splashRadius` identical on both.
- **Send once, immediately after SESSION_CONFIG** (server/src/net.ts ~:657,
  where `encodeSessionConfig` already goes out). Once per connection is correct:
  a room pins its release for life, reconnects get the same table, and a
  promotion only affects NEW rooms.
- **`CAP_VARIANTS = 1 << 5`** in HELLO, and the server resolves every claim to
  `BASE_SLOT` for a connection that did not set it. There is NO existing content
  barrier — `onHello` checks only the protocol window and draining, and
  patch.test.ts explicitly admits a client declaring content version 99. Without
  the cap bit an old bundle is admitted, ignores opcode 13, and fires base stats
  while the server resolves variant stats. Resolve the fallback BEFORE the first
  magazine fill.
- **The per-player equipped slot map rides the SAME message** (my decision):
  the server already resolves claims at spawn, so send the resolved per-weapon
  slots. Without it `variantSlots` is all zeros on both sides and V3 cannot
  demonstrate anything. This is the one place V3 reaches into V4's surface, on
  purpose, so V4 adds ownership rather than ownership plus a handoff.
- **The local Worker** (client/src/net/localServer.ts) keeps working with ZERO
  fetches and the compiled arsenal.
- **A golden wire vector**, in the style of shared/src/version.test.ts's.

**FOLD THE AUTHORITATIVE SHOT NUMBER IN WHILE YOU ARE THERE.** §6's headline
finding: the two schedule shots on different clocks and cannot be reconciled by
formula (I tried; it made a pistol fire its second round 17 ms after its first).
Once the shot COUNTS differ, `shotSeed(ownerId, shotSeq, pellet)` reseeds every
later shot, so the bit-identical cone proof holds only for a GIVEN shot number.
The server telling the client which shot it resolved is the fix, it is wire
work, and V3 is the wire.

Then **V4**: `content/variants.json`, `ItemKind.WEAPON_VARIANT` tokens, the
equip claim, the craft recipe, and the two-browser bar. V4 also owes the two
things V2 deliberately left, both named in §3: the admin console has no variants
row in its pack summary, and `maxBurstDamage` / `currentAmmoType` /
`headshotScale` in client/src/game/weapons.ts still answer for the archetype, so
the HUD and killfeed would show base numbers for an equipped variant.

## 2. Use Codex, and use it BEFORE the code.

It has now overturned a central design clause three sessions running, and this
session it found EIGHT things — including three defects in code committed hours
earlier. Drive the CLI directly; the subagent has failed with identical flags:

    codex exec --sandbox read-only --cd /Users/karstenhaldan/youtube/doomcraft - < promptfile.txt

Write the prompt to a file. Give it the plan as numbered CLAUSES, tell it to
attack each one, demand a concrete failure scenario ending in a specific wrong
number, and REQUIRE a closing section listing the clauses it judges CORRECT so a
clean bill is a visible judgement. **Attack the CLAIM your artifact makes, not
just the code** — that sentence is what found a 10.2° pellet disagreement that
had existed for the life of the project. Then verify every finding yourself,
both directions (rule 23): this session all reproduced, but it also corrected me
on a countable fact in passing.

## 3. Standing rules.

Full suite green before any commit — and CAPTURE IT TO A FILE, because two
load-sensitive flakes (`synth.test.ts` boot budget, `chunkz.test.ts` compression
ratio) appeared once under load and passed in isolation, joining the known
`accounts.test.ts` one in §6. Commit → push → redeploy at every green stage.

Prove every regression test red with its fix reverted AND CHECK WHAT GOES RED.
It caught four of my own tests today, twice at one level up: a check whose tests
called it directly stayed green when its WIRING was deleted, and a switch test
could not be made to fail at all because the cone recovers away the difference.

**Verifying a deploy when the build adds no route:** rule 17 leaves nothing to
probe and `build.id` is a lie (it read `b453e8b` for a tree at `e950dc4`).
Compare the SERVED BUNDLE'S CONTENT HASH —
`curl -s <origin>/ | grep -o 'a/index-[A-Za-z0-9_-]*\.js'` — against your own
`vite build` output. Vite hashes by content, so it cannot be faked.

Railway from a CLEAN WORKTREE (HANDOVER §4). `release:verify` is 16 checks.
Remember there are TWO gates: `runReleaseVerify()` over the tree and
`ReleaseService.runGate()` over a draft, and adding a check to one does not add
it to the other.

Owner seat: `~/youtube/doomcraft-owner-credentials.txt`. Sign in at
`/api/auth/signin` — there is no `/api/admin/signin`.
