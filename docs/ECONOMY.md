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
| Per-day caps + diminishing returns | 6 000 XP / 800 Scrap a day; ladder `1×5 → 0.8 → 0.6 → 0.4 → 0.25 → 0.15`, indexed by matches already paid today, UTC midnight | `server/src/persistence.ts` `meterReward`, inside `applyMatchResult` — the only code that holds the profile **and** runs under the per-device lock |
| No reward for a match joined after it was decided | after the score limit is reached, past half the round, or once the round is over | `server/src/room.ts` `roundStillOpenToJoiners` — expressed as a refusal to **enrol**, because `SessionRecord.participants` has no join timestamp |
| One payout per device per round | — | the entitlement ledger's `settled` set |

The floor of the diminishing-returns ladder is 0.15 and never 0: a reward that silently becomes
nothing reads as a broken game rather than as a limit. A match that was worth nothing before
metering does not spend a rung, so browsing dead rooms costs a player nothing.

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

## Competitions

- **Seasons** with a ladder, seasonal rewards, and a reset.
- **Tournaments**: scheduled events, brackets or leaderboard format, entry rules, automatic winner
  determination from server-recorded results, and a prize claim flow.
- **Daily / weekly challenges** feeding Scrap and drops.
- **Sponsor console**: a sponsor defines an award, funds a prize pool, brands an event, and sees
  results. Sponsor-supplied art is **untrusted third-party content** — moderated, size- and
  format-limited, sandboxed, and never injected as markup into the game page. Same rule as the
  advertiser creative in the ad platform.

## Where it surfaces in the game

- HUD: Scrap and XP ticks on kill and objective.
- End-of-match: rewards earned, drops opened, share card, "beat my time" button.
- Menu: Loadout tab (equip skins/variants), Store tab (spend Scrap), Competitions tab, Trade tab,
  Profile with emblems, titles and trophies.
- Persistence: rides the existing schema-versioned save with server-side entitlements.
