# Doomcraft — progression, items, trading, virality, competitions

Requested 2026-08-20: *"add in point system, wepons, skins and other things that can be found, won
and traded, also create a viral sharing system that gives points and rewards, plus see if sponsors
will give awards and make compatetions etc. have it all build in"*

"Built in" is taken literally: points show in the HUD, items equip from the loadout, the share card
is on the end-of-match screen, competitions are a tab in the main menu. Nothing here is a bolt-on
web page beside the game.

---

## Three decisions made up front, because they change the architecture

**1. The server grants every reward. The client never does.**
Points, drops and progress are awarded by the authoritative sim from match results the client cannot
forge. A client that reports its own score is a client that farms infinite currency, and once items
are tradable that becomes a market for stolen value. The existing authoritative server already has
the hooks; rewards ride on the same trust boundary as damage.

**2. No loot boxes, and no buying tradable items with real money — by default.**
Tradable items are earned in play, won in competition, or awarded by a sponsor. The one real-money
purchase stays the ad-removal unlock already specced. Randomised paid rewards plus a player-to-player
market is a gambling-adjacent design that attracts real legal exposure in several markets, and it is
not something to switch on silently. It is buildable — the provider interface leaves room — but it is
the user's explicit call, not a default.

**3. Sponsors: I can build the whole platform, but I cannot get you a sponsor.**
Everything below — sponsored tournaments, funded prize pools, branded events, a sponsor console,
winner determination and prize claim — is real, working software. Whether a company signs a deal is a
business conversation outside this repo. The system is built so that when one does, it is
configuration rather than engineering.

> **STATUS 2026-08-29: "prize claim" is the one item in that list decided against rather than
> deferred.** Winner determination shipped — `finalise` (`server/src/competitions.ts:305`) ranks
> entrants and pays the table. A claim flow did not, and the Competitions section below records why
> in the same paragraph that revises its own bullet. Sponsored tournaments, funded prize pools and
> branded events are still spec: `competitions.ts` reads no sponsor anywhere. The sentence above is
> left as written, because it was a claim about what the platform can be built to do, not a
> shipping manifest — this line says which parts of it are code today.

---

## Points — two currencies, deliberately not one

- **XP** — monotonic, never spent, drives account level and unlock gates. Earned from time played,
  objectives, quest levels cleared, horde waves survived, deathmatch score.
- **Scrap** — the spendable currency. Earned from the same events at a lower rate, plus challenges
  and competitions. Spent on cosmetics, horde build materials, and crafting.

One currency collapses "how far have I come" into "what can I afford", and then every reward feels
like a paycheck. Two keeps progression legible.

Anti-farm: per-match and per-day caps, diminishing returns on repeat activity, zero reward from a
match a player joins after it is decided, and idle detection.

**As built.** Four rules in four files, each one where its facts are — a rule cannot be enforced in
a place that does not know the answer, and putting them together would mean passing the profile into
the room or the round state into the store.

| Rule | Numbers | Where |
|---|---|---|
| Per-match ceiling | 900 XP, 120 Scrap | `server/src/reward.ts` — the only place that knows what one round did |
| Minimum paid duration | 30 s | `server/src/reward.ts` — same fact |
| Idle detection | zero kills **and** deaths **and** damage **and** blocks placed **and** blocks broken pays nothing, whatever the clock says | `server/src/reward.ts` `playedIdle` |
| Per-day caps + diminishing returns | 6 000 XP / 800 Scrap a day; ladder `1×5 → 0.8×2 → 0.6×2 → 0.4 → 0.25 → 0.15`, indexed by matches already paid today, UTC midnight | `server/src/persistence.ts` `meterReward`, inside `applyMatchResult` — the only code that holds the profile **and** runs under the per-device lock |
| No reward for a match joined after it was decided | after the score limit is reached, past half the round, or once the round is over | `server/src/room.ts` `roundStillOpenToJoiners` — expressed as a refusal to **enrol**, because `SessionRecord.participants` has no join timestamp |
| One payout per device per round | — | the entitlement ledger's `settled` set |

The floor of the diminishing-returns ladder is 0.15 and never 0: a reward that silently becomes
nothing reads as a broken game rather than as a limit. A match that was worth nothing before
metering does not spend a rung, so browsing dead rooms costs a player nothing.

*Corrected 2026-08-29:* the ladder above used to be written `1×5 → 0.8 → 0.6 → …`, one rung each.
`DR_LADDER` has twelve rungs and repeats the middle two — `[1,1,1,1,1, 0.8,0.8, 0.6,0.6, 0.4,
0.25, 0.15]`, `server/src/persistence.ts` — so the eleventh paid match of a day is worth a quarter,
not the ninth. The code is the source; this table now copies it.

`meterReward` is no longer the only mint. Challenge payouts (below) and competition prizes credit
Scrap directly and deliberately skip the meter — a prize table an operator wrote, or a challenge
board the release gate passed, is already a bounded promise, and metering it would turn a
first-place finish into a silent rounding error. Their bound is the manifest, not the day: 500
Scrap per definition and 2 000 across the whole board, refused by the parser
(`shared/src/challenges.ts` `MAX_CHALLENGE_SCRAP` / `MAX_CHALLENGE_TOTAL_SCRAP`).

Idle detection is also what makes the unfixed Builder/Horde round-timer defect
(`docs/BUGS-FOUND.md` §4) safe to leave alone: those rooms run an eight-minute Deathmatch clock
nobody asked for, and an AFK player in one now earns exactly zero instead of a full round's XP.
Deaths count as activity on purpose — being repeatedly killed is playing badly, not idling, and a
currency that punishes it teaches people to hide.

## Items

| Kind | What it is | Tradable |
|---|---|---|
| **Weapon variants** | Alternate stats within a weapon family — a slug shotgun, a burst pistol. Sidegrades, never straight upgrades. | Yes |
| **Skins** | Weapon and player-model finishes, rendered as palette swaps + emissive masks so they cost nothing at runtime. | Yes |
| **Emblems / sprays** | Profile badge, and a spray you can stamp on a voxel wall. | Yes |
| **Trails / effects** | Rocket trails, impact colours. | Yes |
| **Titles** | Earned strings shown by your name. | **No** — proof of achievement, so a trade would launder it. |
| **Competition trophies** | Awarded by a tournament or a sponsor. | **No**, same reason. |

Rarity: Common / Uncommon / Rare / Epic / Relic. Sources: play drops, challenge completion,
competition prizes, sponsor awards, crafting from Scrap + duplicates.

**Cosmetics must never cost frames.** Skins are palette + mask, not new geometry or new draw calls.
The performance contract (60 fps median / 53.8+ 1% low at 915×412 under 4× throttle) applies to a
player wearing the rarest item in the game.

**As built.** The catalogue is data — `content/items.json`, shipped as the items pack — and the
"no trade" rule in the table above is enforced at parse time rather than at trade time:
`shared/src/items.ts` refuses `tradable: true` on a Title or a Trophy with an error naming the
reason. A rule the parser holds cannot be forgotten by a caller.

| Verb | Where | What it does |
|---|---|---|
| `POST /api/equip` | `server/src/index.ts`, `equipVerdict`/`applyEquip` in `server/src/persistence.ts` | Sets the `skin` and `title` slots, plus one `variant:<baseWeaponId>` slot per weapon (V4c). A variant slot names the BASE WEAPON and stores the owned REF, never a table row — which row of which table that becomes is decided per room. Both claims land or neither does — validation and write share one `store.update` callback, so a concurrent settlement cannot un-own an item between the check and the claim, and a refusal on the second slot does not leave the first written |
| `GET /api/variants` | `server/src/index.ts` | The live variants pack as `{version, variants: [{id, base, name}]}`, or `{version: 0, variants: []}` when none is live. Public and unflagged like `/api/items`; the Loadout tab needs it to name a weapon-variant token's equip slot, because the base weapon is not on the `ItemDef` (V4f) |
| `POST /api/craft` | `server/src/craft.ts` | Three duplicate copies of one item plus a Scrap fee become the item the player **chose**: same kind, exactly one rarity up. Fee by TARGET rarity — Uncommon 50, Rare 150, Epic 400, Relic 1000. There is no Common target: nothing crafts down |

Equipping stores a **claim**, not a state. `inventory.equippedSkin` and `inventory.title` are
re-derived through `itemStateFor` by every surface that wears them, so an item whose pack was
rolled back goes dark and lights up again with no write — but the claim is still validated at the
door, because equipping a Title into the skin slot would render nothing forever and read as a lost
item.

Crafting is **deterministic on purpose**: the player names the target. A random outcome would be a
loot box with extra steps, and decision 2 above says no loot boxes — so a craft is a purchase whose
price includes proof you played. Only the tradable kinds craft (skins, emblems, trails), for the
same reason they trade; copies sitting on a live trade's table cannot be consumed, because a copy
must never be in two stories at once. The fee is the journal's first `'spend'` rows — the kind was
declared in `LedgerKind` from the start, nothing had written one until this route, and nothing else
writes one yet (`server/src/index.ts:2969` is the only site in the tree) — debited under the same
per-device lock that moves the balance and idempotent on the client's nonce, so a crash-replayed
craft consumes and grants nothing twice.

## Trading

Player-to-player, server-authoritative, with the failure modes designed for rather than discovered:

- **Two-sided escrow.** Both parties offer, both items lock, both confirm, and the confirm resets
  whenever either side changes the offer. This is the specific defence against the classic
  swap-at-the-last-instant scam.
- **Atomic settlement** — the transfer either fully applies or fully rolls back; no half-trades.
- **Full audit log** of every transfer, so a disputed or exploited trade can be traced and reversed.
- **Cooldowns**: newly acquired items are untradable for a period; new accounts cannot trade at all.
  Both exist to make item-laundering across throwaway accounts unprofitable.
- **No trading of Titles or trophies** (see above).

**As built.** `server/src/trades.ts` behind `POST /api/trade/{open,join,offer,confirm,cancel}` and
`GET /api/trade/{mine,state}`, gated on `economy_trading`, with `client/src/ui/tradeTab.ts` as the
face. The five bullets above, in the code:

| Bullet | Numbers | Where |
|---|---|---|
| Two-sided escrow | Both confirms reset on **either** side's offer change | `trades.ts` `offer()` — the reset lives in the engine, not in a caller, so no route can forget it |
| Atomic settlement | `'settling'` + a per-side inventory snapshot reaches disk before any profile is touched; `recover()` finishes a torn settlement at boot | `trades.ts` `settle()` / `recover()` |
| Full audit log | every state change appended to `trades.jsonl` | `trades.ts` `audit()` |
| Cooldowns | 48 h per item (a traded-in item lands with a fresh timestamp, so laundering costs a cooldown per hop), 72 h account age **and** 5 matches played before an account may trade at all | `TRADE_ITEM_COOLDOWN_MS`, `TRADE_MIN_ACCOUNT_AGE_MS`, `TRADE_MIN_MATCHES` |
| No Titles or trophies | the tradable check reads the live definition, never the client's claim | `trades.ts`, against the parser rule in `shared/src/items.ts` |

Escrow is never forever: a trade nobody touches for 15 minutes expires, at most 6 items go on a
side, and one player may hold 3 live trades. The ACTIVE-state check runs at **offer and again at
confirm** — a release rollback, an operator revoke, or the same copy being offered in a second
trade can all happen between the two, and `confirm()` revalidates both sides from scratch rather
than settling half a deal.

Two things the spec did not say and the code had to decide. First, **the confirm reset is visible**:
when a poll (not the player's own click) reveals that this player's confirm has vanished,
`tradeTab.ts` says *"The offer changed — both confirms were reset. Check the deal again before
confirming."* A silently unticked box reads as a lost click, or worse, as the scam the reset exists
to prevent. Second, **`store.flush()` runs before the doc says `'settled'`**: the production store
debounces profile writes by ~800 ms, so marking a trade settled first would let a crash void or
half-apply a settlement the trade file swears is finished. The flush is the barrier.

## Viral sharing

- **Share cards.** At the end of a match the server renders a genuinely shareable image — your best
  moment, kills, wave reached, level time vs par, with a join code. Generated server-side from match
  data so it cannot be faked.
- **Referral links.** Attribution on signup, reward on *engagement* — the referred player has to
  actually reach a play threshold before either side is paid. Rewarding raw signups is what makes a
  referral system a bot farm.
- **Fraud controls, non-negotiable**: reward caps per account and per period, self-referral
  detection, device and network heuristics, and a review queue for outliers. Build these with the
  feature, not after it goes wrong.
- **Challenges to share**: "beat my time" links that drop the recipient straight into the same level
  with the sender's ghost time to beat.

**As built — three of the four.** The share card and the referral loop are live; "beat my time"
links are not built and remain spec.

*Share cards.* `GET /api/share/card` renders the caller's last paying round as a 1200×630 PNG
server-side, gated on `share_cards`, with `client/src/ui/shareCard.ts` as the button — it hands the
bytes to `navigator.share` where the browser has a share sheet, and otherwise downloads the PNG and
puts the referral link on the clipboard. It appears on the Quest intermission, the Horde run card
and in the profile overlay. **Zero dependencies by design**: `server/src/shareCard.ts` writes the
PNG by hand (IHDR/IDAT/IEND over `node:zlib`) and draws text from a 5×7 pixel font scaled in
integer steps, which is not a compromise — it is the voxel game's own aesthetic on the card. Server
CPU only, no client frames. Any sponsor lockup is confined to a 72 px bottom strip (11.4% of the
card, inside the ≤12% cap in `docs/SPONSORS.md` S36), and an ad-free player's card carries the
house wordmark and nothing else — that player is doing us a favour.

*Referrals.* `server/src/referrals.ts` behind `GET /api/referral/mine` and `POST
/api/referral/claim`. The three rules the spec named are the three rules the code holds:
attribution is **first-wins forever** (a second claim changes nothing); conversion is
**engagement, never signup** — 30 minutes of paid play (`stats.secondsPlayed`, which only match
payouts move) or account level 5, both measured server-side; and the payment **is** the journal,
`kind: 'referral'`, `sourceId: referral:<referredKey>`, so a conversion can never pay twice
whatever crashes or replays. 100 Scrap to the referrer, 50 to the referred. The fraud controls
shipped with it rather than after it: 5 conversions per referrer per day, over which a conversion
**parks in a review queue instead of paying**; a claim from the code owner's own `/24` is accepted
but marked, and a marked conversion parks the same way; self-referral refused at claim; and a
player already past the engagement threshold cannot be recruited at all — attribution is for new
players, not a coupon for veterans. Parked conversions are an operator decision, not a black hole:
`reviewQueue()` lists them and `approve()` pays one. The conversion check rides
`onProfilePersisted`, fire-and-forget, because a referral must never delay or break a payout.

## Competitions

- **Seasons** with a ladder, seasonal rewards, and a reset.
- **Tournaments**: scheduled events, brackets or leaderboard format, entry rules, automatic winner
  determination from server-recorded results, and a prize claim flow.
- **Daily / weekly challenges** feeding Scrap and drops.
- **Sponsor console**: a sponsor defines an award, funds a prize pool, brands an event, and sees
  results. Sponsor-supplied art is **untrusted third-party content** — moderated, size- and
  format-limited, sandboxed, and never injected as markup into the game page. Same rule as the
  advertiser creative in the ad platform.

**As built — seasons, tournaments and challenges.** `server/src/competitions.ts` rides the same
seam referrals do: `onProfilePersisted`, after every paying round, with zero `room.ts` changes.

*Seasons.* 28 days, rolling, and they **run with no operator attention at all**: finalising one
mints the next, and a player is auto-enrolled by their first paying round inside the window.
Standings pay the top ten — 500 / 300 / 200 / 150 / 100 / 100 / 100 / 50 / 50 / 50 Scrap.

*Tournaments* are operator-created, because creating one is where the prize table is decided and
the finaliser pays that table automatically without asking anybody again. That is why
`POST /api/admin/competitions/create` **confirm-gates** like the C6 verbs and writes an audit row
either way, and why cancel is a separate verb — cancelling pays nobody, which is exactly what
distinguishes it from letting an event end. Entry is explicit (`POST /api/competitions/enter`) with
the `minLevel` rule checked at the door. The bounds are in `createTournament`: 10 minutes to 30
days long, at most 100 paid ranks, no rank over 100 000 Scrap, and at most 4 winner items, granted
to rank 1 only.

Two places the build diverged from the bullet, both deliberate. **The format is the leaderboard,
not a bracket** — a bracket needs seeded pairings and a re-entrant match schedule, neither of which
the room has, and the points ladder is the format that falls out of a counter the server already
keeps honest. **There is no prize claim flow**: finalisation pushes the prize into the profile
rather than parking it behind a button. A claim step adds a way to win and never collect, and the
push is already idempotent without one — but for a reason worth stating exactly, because the
journal is not it. `finalise` is reached from one call site, guarded on `c.state === 'running'`
(`server/src/competitions.ts:195`), and it writes `placements` and flips the state to `'finalised'`
**before** it pays a single player (`:312-314`), so the transition is one-shot and durable in the
competition document. What the journal adds is the retry window inside that one run: `has('prize',
prize:<id>, <player>)` is checked first inside each `store.update` (`:327`), and its memory is the
journal's ~48 h dedup window, not eternity (`server/src/journal.ts:453-465` seeds only today and
yesterday, `:473-476` evicts the rest). An item prize carries a third, fully durable guard — the
`sourceId` already sitting in the inventory (`competitions.ts:328`). That is the property a claim
flow was there to provide. *This paragraph revises two sentences: the Competitions bullet above
("and a prize claim flow") and decision 3's "winner determination and prize claim" at the top of
this document.*

The ladder's arithmetic is **state-based, not event-based**, and that is the whole design: an
entrant's points are the growth of `progress.xp` — a monotonic counter only match payouts move —
since the baseline snapshotted at enrolment. There is no per-match event to double-count, to lose
in a crash, or to replay, and the watermark moves in the same doc write as the points. Each sweep's
increment is clamped to `MATCH_XP_CAP` (900) and the excess is *forgotten*, so a mid-season account
merge — which legitimately jumps `xp` by a pre-season amount — smuggles at most one match's worth of
points into a ladder, once, rather than amortised across every later round.

Prizes pay **only** through the journal, `kind: 'prize'`, `sourceId: prize:<competitionId>`, so a
retry inside a finalisation run cannot pay a player twice; the *forever* half of that guarantee is
the state flip described above, not the journal, whose dedup memory spans about 48 hours. Item
prizes ride the same tag through the inventory's provenance and are checked before granting, which
is the half of the check that is durable in the profile. Accrual is gated on nothing at all —
the `economy_competitions` flag hides the *surfaces*, because `shared/src/flags.ts` says a flag
flip must never lose a season.

**Daily / weekly challenges — the engine (Studio S4).** This bullet was the last unbuilt line in
this section. It is now the sharpest example in the repo of the "definitions are data" rule.

- **The definitions are a pack.** `content/quests.json` (`shared/src/challenges.ts` parses it),
  released and versioned like every other pack, edited in the console's Studio → challenges card
  and shipped through the same gate → approve → stage → promote walk as levels and items. The
  bundle ships seven: four dailies and three weeklies, one of which also pays a Title. A challenge
  is a **pure predicate over stats** — `kills`, `wins`, `bestStreak`, `damageDealt`, `blocksPlaced`,
  `blocksBroken` — and never over a mode. `seconds` is deliberately absent: time passes for an idle
  player too, and a stat you cannot fail to accumulate is a login reward wearing a challenge's name.
  `bestStreak` folds as a **max** across the period, not a sum — two matches with a 4-streak do not
  make an 8-streak — and every other stat folds as a sum. `wins` is only stamped by a mode that has
  a win condition: `endRound` reads it off the mode DESCRIPTOR (`const winnable`,
  `server/src/room.ts:1292`), so Builder — `WinCondition.NONE` — no longer records its kill leader
  as a winner. That was a cosmetic stat inflation until a challenge paid for `wins`; it became
  money the moment this engine landed.
- **Trust decides who banks.** Progress accrues only in sessions whose trust row grants
  `REWARD_CHALLENGE`. That is eight of the sixteen rows in `TRUST_TABLE` (`shared/src/trust.ts`):
  all four PUBLIC rows (Quest, Builder, Horde, Deathmatch), all three COMPETITION rows (Quest,
  Horde, Deathmatch — Builder has none), and Deathmatch RANKED. The other eight — every SOLO and
  every PRIVATE row — grant `REWARD_NONE`, so solo and invite-only matches bank **nothing**, which
  is the same boundary that already governs XP and drops rather than a second one invented for
  challenges. In practice only PUBLIC banks today: the live server opens every room with
  `sessionIntent: isInvite ? MatchType.PRIVATE : MatchType.PUBLIC` (`server/src/index.ts:974`, the
  only `new Room(...)` outside tests and the in-tab worker), so no RANKED or COMPETITION session
  exists yet — and `resolveMatchType` would clamp a COMPETITION intent from the matchmaker down to
  PUBLIC anyway (`shared/src/trust.ts:225`); only the event-scheduler origin passes one through,
  and there is no scheduler.
- **The guard re-derives every claim.** The room attaches the ids its round contributed to; the
  entitlement guard keeps only those whose definition exists in *that session's recorded pack* and
  whose predicate the sanitised stats actually satisfy, using the same `challengeContribution`
  function the room used. One predicate, three callers, zero modes.
- **Payment happens inside the match payout.** `settleChallenges` runs in the same `store.update`
  callback as `applyMatchResult`, under the same per-device lock, off one wall clock — so the
  counter, the receipt, the Scrap, the item and the journal row commit or vanish together, and a
  midnight straddle cannot split a receipt from its idempotency key. The row is `kind: 'prize'`,
  `sourceId: challenge:<id>:<periodKey>`, and its `delta` is the **observed** movement read back
  off the balance, never the amount asked for — the `MAX_SCRAP_BALANCE` clamp is allowed to bite
  and the row has to say so. Once per UTC day, or per ISO week (Monday-start).
- **A completion that cannot be paid becomes a DEBT.** Public Builder grants challenge progress but
  deliberately not Scrap — its trust row is `REWARD_XP | REWARD_CHALLENGE | REWARD_STATS |
  REWARD_TRADE_UNLOCK` (`shared/src/trust.ts:521`) — so a challenge finished there would otherwise
  be earned and lost. Instead it lands on the profile's period-stamped `owed` list **before**
  anything is paid (`server/src/persistence.ts:912-917`, ahead of the `mayPayScrap` return), and is
  paid at the first settlement that may. This is what makes the midnight roll safe: wiping the
  counters at UTC midnight cannot eat a completion earned at 23:50 in a room that was not allowed
  to pay it. A debt carries its earning period with it, so paying yesterday's does not mark today's
  copy of the same challenge done (`:927-929`). The list is capped at 32 entries
  (`MAX_CHALLENGE_OWED`), which is four full boards.
- **Item rewards pay both halves or neither.** `grantDrops` refuses at the inventory cap and
  reports what actually landed; a completion whose item does not land keeps the **whole** thing
  owed — no Scrap, no receipt, no journal row — rather than writing a receipt for an item that
  silently evaporated (`server/src/persistence.ts:937-941`). The line above it defers, rather than
  drops, a completion whose item cannot be minted because `economy_items` is off (`:932`, fed by
  `server/src/room.ts:1595`).
- **An account merge carries the receipts and the debts.** The journal's idempotency key ends in
  the **profile key**, so a receipt earned on the absorbed device stops protecting anything the
  moment the player is the surviving profile — without this the same daily could pay a second time
  in one period across a device link. `applyMergeFields` (`server/src/merge.ts:138-159`) unions the
  `done` receipts for a period the two profiles share, takes the **max** of each counter rather
  than the sum (the progress is one person's, not two), and unions `owed` so a merge cannot swallow
  a debt. The mirror-image rule holds for the operator's reset-progress verb, which now clears
  `challenges` with the rest of the profile (`server/src/index.ts:3310`): leaving the counters up
  let pre-reset play mint post-reset Scrap at the next settlement.
- **The mint bound is the parser.** Challenge payouts skip the daily meter (above), so the ceiling
  is the manifest the release gate accepted: 500 Scrap per definition, 2 000 across the board, and
  at most 8 definitions — the whole active set has to fit one result submission. The gate also
  cross-checks every `item` a challenge pays against the paired items manifest, so renaming an item
  and forgetting the quests pack fails the release rather than the player.

The **kill switch is real on both halves**: `economy_competitions` gates the producer in the room
*and* the payer in the settlement. Gating only the producer would leave an operator who pulled the
flag over a mispriced definition still paying every player already sitting at target. Item rewards
additionally ride `economy_items`, exactly as match drops do — one flag, one meaning, wherever an
item is minted.

**The sponsored half of this section is still spec.** `competitions.ts` reads no sponsor anywhere:
a funded prize pool today is an operator typing a prize table into the create verb, and there is no
branded event. The untrusted-art rule above is the one part that shipped, and it shipped next door
— `server/src/creatives.ts` and the sha256-bound `sponsors.json` approval flow in the ad platform
(`docs/SPONSORS.md`), which is the same rule applied to the same kind of content.

## Achievements — lifetime, one-shot, retroactive

Daily and weekly challenges measure A MATCH. Achievements measure A CAREER, and that difference
runs deeper than the period field.

**Progress is `profile.stats`, not a counter of their own.** The profile already keeps a lifetime
stat block and already shows it to the player, so an achievement reads that. A second counter would
accrue under different gates and the two would disagree on the same screen — "1,000 kills" on one
panel and "940 / 1000" on the next. That is a DISPLAY argument and only that; it is not an
anti-farm argument, and the first draft of this design mistook it for one.

**Which stats may be priced, and why the list is short.** `shared/src/achievements.ts` admits
`kills`, `bestStreak`, `damageDealt`, `blocksPlaced` and `blocksBroken`, and the rule is that every
unit of the lifetime total must have required an action the simulation observed. `matches` and
`secondsPlayed` increment for a round in which the player did nothing. So, measured, does `wins`:
`applyMatchResult` with `{kills:0, deaths:0, won:true, damageDealt:0, blocks:0, seconds:12}` gives
`roundPays = false` and zero Scrap, and still moves `stats.wins` to 1, because `endRound` can crown
a sole player at zero kills. A hundred of those are a hundred lifetime wins for a hundred rounds of
idling. Challenges never see it — `buildSubmission` zeroes `challengeIds` when `roundPays` is false
— but the lifetime block does, so `wins` is refused by the parser rather than by convention.
`deaths` is out on product grounds: a reward for dying pays people to die.

**They are RETROACTIVE, and that is deliberate.** Adding an achievement pays every player who
already qualifies, at their next settling match, all at once. A career award that ignores the
career is an insult. The bound is `MAX_ACHIEVEMENT_TOTAL_SCRAP` per manifest, and the profile's
receipt ceiling across all manifests ever.

**The promise is snapshotted, because the counter preserves the STAT and not the DEF.** A
completion earned in a session that may not pay (public Builder grants progress but not Scrap) is
written to `achievements.owed` with the reward AS IT STOOD WHEN EARNED. Re-price the def, raise its
target out of reach, or remove it entirely, and the promise still pays what it promised. Without
that, a re-cut between earning and paying would silently revoke an award.

**The receipt outranks the debt, with no period to scope it by.** An achievement is earned once,
ever, so `achievement:<id>` is the whole idempotency source. A profile holding both a receipt and a
debt for one award — which is what an account merge produces — discharges the debt and pays
nothing. The journal cannot see that case on its own: its key ends in the PROFILE KEY, so a receipt
earned on another device protects nothing after a merge.

**Three consequences that read backwards until you see the key.**

- A merge unions achievement receipts UNCONDITIONALLY, where it unions challenge receipts only
  within a matching period.
- `reset-progress` CLEARS challenge state and KEEPS achievement receipts. Clearing them would let
  the same award pay again once the journal's ~48 h memory forgets it — a mint by reset.
- A merge that would overflow either ceiling is refused whole, before anything is debited.
  Truncating a receipt re-opens a paid award; truncating a promise cancels an earned one.

**What the player sees.** Three states, not two: `locked`, `earned` and `paid`. `earned` is
reachable in ordinary play — the award is won and payment waits for a session allowed to grant
Scrap — so it gets its own words rather than a bar stuck at 100%. An award whose definition has
been retired still appears, because an award the player cannot see is an award they will believe
they lost.

## Where it surfaces in the game

- HUD: Scrap and XP ticks on kill and objective.
- End-of-match: rewards earned, drops opened, share card, "beat my time" button.
- Menu: Loadout tab (equip skins/variants), Store tab (spend Scrap), Competitions tab, Trade tab,
  Profile with emblems, titles and trophies.
- Persistence: rides the existing schema-versioned save with server-side entitlements.

**As built, and shipping dark.** The client never computes any of this. `S2C.MATCH_AWARD` (id 12,
appended — `protocolFingerprint()` did not move) carries the delta *after* the trust table, the
per-match ceiling, the day cap and the ladder have all had their say, plus the balances the server
just wrote; `NetClient.onMatchAward` is the only writer of the four fields the surfaces read.

| Surface | Where | Note |
|---|---|---|
| Two more `.dc-chip` plates under the minimap, `XP` and `SCRAP` | `client/src/hud/hud.ts` | Reuses the existing chip helper, so no new CSS rule and nothing for `hud.test.ts`'s plate scan to catch |
| Two more counted rows on the Quest intermission | `client/src/modes/quest/intermission.ts` `intermissionRows` | The DELTA since the level started, so "+120 XP" means this level |
| `+120 XP · +14 SCRAP` on the Deathmatch scoreboard's footer line | `client/src/modes/deathmatch/deathmatch.ts` `fillHeader` | Deathmatch hides `.dc-chips` outright (`#hud[data-dm="1"]`), so the chips are not an option there; a real end-of-match card is A2 |

**Two flags, and the surfaces need both.** `Feature.ECONOMY` (`shared/src/features.ts`, default
**false**, admin switch in Settings › Admin) is the product gate and lives in localStorage, so
anyone with devtools can flip it — which is why it is only ever ANDed with `economy_scrap`, the
server-resolved kill switch that arrives on `S2C.SESSION_CONFIG`. `economySurfacesOn()` is the one
place the two meet. The accrual is gated on **neither**: `shared/src/flags.ts` says turning
`economy_scrap` off must hide the surfaces and never delete a balance.

The in-tab Worker room answers `economy_scrap` from the page's own product flag
(`localServer.ts` `localFlagBits`). It is not a second party — it runs in this tab, it has
`store: null`, and it grants nothing — so the chips it unlocks read `XP 0 · SCRAP 0`, which is
exactly the truth about an offline match.

**As built — the menu, three tabs of four.** The bullet above says "Menu"; the tabs actually live
in the **profile overlay** (`client/src/ui/profile.ts`), because that is where a player already
goes to look at what they own. The strip is hidden outright until the server grants at least one
tab — one `GET /api/flags` per page (`probeServerFlags`), shared by every tab and by the share
button, so a static build with no server shows no strip rather than three tabs that 404.

| Tab | Flag | Where |
|---|---|---|
| Loadout — balances, and every owned item in sections by kind (Skins, Titles, Emblems, Trails, Trophies, Weapon Variants), equipping through `POST /api/equip` and crafting through `POST /api/craft` | `economy_items` | `client/src/ui/loadoutTab.ts` |
| Trade — the escrow table, both offers, both confirms | `economy_trading` | `client/src/ui/tradeTab.ts` |
| Competitions — running seasons and tournaments, standings, Enter, **and the Challenges board** | `economy_competitions` | `client/src/ui/competitionsTab.ts` |
| Store — spend Scrap | — | **not built** |

`economyTabsFor` (`client/src/ui/loadoutModel.ts`) is the single place a flag becomes a tab.

The Challenges board is a section at the top of the Competitions tab, fed by `GET /api/challenges`
— which derives the period keys at **request** time, so a stored bucket left over from an older
period answers zeroed counts and an empty done-list. Yesterday's finished board never renders as
today's, and a read never writes the profile. Each row carries the definition's name and blurb, a
progress bar, and what it pays. Under them sits the one line that teaches the whole trust rule in a
player's words: *"Daily challenges reset at midnight UTC, weeklies on Monday. Progress counts in
public online matches — solo and private games do not bank. Rewards land with a match payout."*

**Two gaps, stated plainly.** There is **no Store tab**, so `POST /api/craft` is currently the only
way a player can *spend* Scrap — the sole `'spend'` emitter in the journal, against four ways a
player **earns** it (match payouts, challenges, competition prizes, referrals) and two more the
system or the operator can move it by: `admin.adjust`, up to ±100 000 Scrap under the operator verb
(`server/src/index.ts:3255`; the same kind carries the negative row reset-progress writes at
`:3315`), and `merge.credit`, which moves a balance onto the surviving profile of an account link
(`server/src/merge.ts:288`). Each of those six writes a `LedgerKind` row
(`server/src/journal.ts:58-61`) — five distinct kinds, because challenges and competition prizes
both write `'prize'` — and only the first four are things a player can go and do. Horde build materials and cosmetics bought
outright, both named in the Points section above, have no route. The `economy_scrap` registry entry
still describes itself as "Scrap accrual, the Store tab and spending", which is the flag naming its
eventual job rather than its current one. The second gap is the **"beat my time" button**, already
recorded in the Viral section above, which owns it: what is missing beyond the share card is a link
that carries a level id plus the sender's clear time and drops the recipient into that level with
the time to beat.
