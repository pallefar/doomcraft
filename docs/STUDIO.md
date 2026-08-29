# Doomcraft — the Creator Studio

Requested, verbatim, 2026-08-24:

> *"lets add in to the pending plan and pack creator, where we can create new weapons, maps,
> quests, caractors expantion packs from the admin panel, so we need a creator studio. so we use
> claude code for platofrm upgrades but the creator studio to add more with the same engine"*

This is a decision document in the `docs/PACKS.md` tradition: every axis the request names is
enumerated and marked **SHIP**, **DRAFT-ONLY**, or **LATER**, with what decides it. The studio
does not replace the release machine — it FEEDS it. Nothing authored here reaches a player
without passing the same gate, review, approve and promote the deploy path uses.

---

## 0. The lane split, made precise

The request's own framing is the architecture:

| Lane | Who runs it | What moves | How it ships |
|---|---|---|---|
| **Platform** | Claude Code sessions | Engine, systems, protocol, BUILD-class content (weapon tables, character rigs, terrain) | a commit, a test suite, a deploy |
| **Creator Studio** | the operator, in the admin panel | DATA-class content on the same engine: levels, campaigns, items, quests | a new pack **version** on the volume → the release machine |

The boundary is `docs/PACKS.md` §1.1's class split, and it is load-bearing, not bureaucratic: a
weapon stat is compiled into the client's predictor and a terrain rule is executed identically by
the browser Worker and the server — those are code, and code ships through the platform lane with
its ratchets. A level, an episode order, an item table are files the engine already loads at
runtime — those are the studio's material.

## 1. The axes the request names

| Ask | Studio delivers | Verdict |
|---|---|---|
| **maps** | Quest **levels** — the level lab: author/paste level JSON, live-validate against the REAL `validateLevel` (reachability solve included), save as a NEW levels pack version | **SHIP** (v1) |
| **expansion packs** | The **assembler**: edit the episode manifest, validate its refs against a levels version, save as a new campaign version — then one click into the Review screen, because an expansion IS a release (`docs/PACKS.md` §1.2) | **SHIP** (v1) |
| *(implied: cosmetics)* | The **items editor**: the live items table, edited and saved as a new items version; the §7 dormanting count surfaces before the gate even runs | **SHIP** (v1) |
| **weapons** | The **variant designer**: author a stat table, see the field-level diff against the compiled weapons pack (`weaponsFingerprintInputs`), save as a DRAFT under `DOOMCRAFT_DATA/studio/` — the draft is a structured change request the platform lane applies | **DRAFT-ONLY**, honestly: the client predicts damage and spread from its own compiled copy (`docs/PACKS.md` §1.1); shipping a variant is a build change until the predictor is data-driven, which is a platform project |
| **characters** | The **look designer**: author a `CharacterLook` (tints, proportions, parts) as a draft with the same diff treatment against `charactersFingerprintInputs` | **DRAFT-ONLY**, same reason; `docs/PACKS.md` phase 6 is the measured path to characters-as-pack |
| **quests** | The **challenge board**: edit the quests manifest, CHECK it against the save's own two gates (the parser's Scrap caps, then item refs across every installed items version), save as a new quests version — `POST /api/admin/studio/quests` | **SHIP** (v1) — the order held: the ENGINE was a platform-lane project and it shipped before this editor did (`39bef19` before `a1c5906`; `docs/PACKS.md` §1.3), so the console never offered a switch with nothing behind it |

## 2. Rules inherited, and the one decision revised

- **Rule A holds**: everything the studio WRITES as live-able content is data. The two
  build-class designers emit drafts, never installed packs.
- **Rule B holds**: the author is the operator — env bearer or owner session, behind the same
  `AdminGate`, every save an audited admin action. No public authorship, no moderation pipeline.
- **Immutability holds**: a studio save mints a NEW version directory under
  `DOOMCRAFT_PACKS/<key>/<version>/` — never an in-place edit. A re-cut pack is a new version.
- **The gate holds**: a save that cannot pass its own pack's checks (`items.validate`,
  `levels.validate` with the reach solve, `campaign.refs`, `quests.validate` + `quests.refs`) is
  REFUSED at the route, with the refusal text verbatim. The two quests checks are the newest and
  are wired both ways: `checkQuestsValidate` (`server/src/gate.ts:342`) and `checkQuestsRefs`
  (`:356`) sit in the gate's check list at `:512-513` and in the server release gate at
  `server/src/packs.ts:967`, and `saveQuests` refuses at the route with the parser's own words
  (`server/src/studio.ts:278-281`). And an accepted save is still only INSTALLED — reaching a
  player takes draft → gate → approve → stage → promote, exactly as before.
- **REVISED from `docs/PACKS.md` §9/§10**: *"no pack upload path in the console"* was decided
  against a stranger-authorship threat (the moderation pipeline). The studio is the OPERATOR
  writing to their own volume through an authenticated, audited, gate-checked route — Rule B's
  trust model, unchanged. The §9 sentence stands for uploads by anyone else, forever.
- **A host without a writable packs root refuses studio saves** with the reason. The `content/`
  fallback is bundle-owned and never written. On Railway: `DOOMCRAFT_PACKS=/data/packs`, on the
  volume that already survives restarts.

## 3. Build order

- **S1 (this session): the write path + the tab.** `POST /api/admin/studio/items|level|campaign`
  (+ `/validate` dry-runs), draft designers for weapons/characters, the Studio screen in the
  console, tests for every refusal.
- **S2: quality of authoring.** In-panel level preview (top-down slice render), item palette
  swatches, campaign drag-ordering.
- **S3: the expansion one-click.** Assemble levels+campaign+items versions into a named release
  draft from the studio screen directly.
- **S4: challenges.** Platform lane builds the challenge engine (producers for `challengeIds`,
  evaluation in the guard, journal rows); then the studio gets the quest editor and
  `PackKind.QUESTS` gains its producer the honest way.

  **DONE** (`f2f365c` … `75c23b4`, 2026-08-28/29). The promise that mattered was **ENGINE before
  EDITOR**, and that is the order it shipped in. The pack half went first, which the plan above
  neither promised nor needed to. Five build commits and two review passes:
  - `f2f365c` — the shared challenge definitions (`shared/src/challenges.ts`: defs as data, one
    predicate, the Scrap caps), together with the quests `PackDef` and `questsPack()`.
  - `9d46c6d` — the release machinery: the inventory accessors, the `quests.validate` and
    `quests.refs` gate checks, and the `QUESTS` branch in `unsatisfied()`.
  - `39bef19` — the engine: `Room.challengeIdsFor` as the producer for `challengeIds`,
    `verifyChallengeIds` in the guard against the defs the session was **opened** with, and
    `settleChallenges` paying each completion once per UTC period with a `prize` journal row.
  - `7fc85bf` — the route and the player's board: `GET /api/challenges` and the section at the top
    of the Competitions tab.
  - `a1c5906` — the editor: `POST /api/admin/studio/quests` (+ `/validate`), the console's
    challenges card, guide 8.
  - `377c759` and `75c23b4` — two adversarial review passes over money paths. A completion becomes
    a durable DEBT before it becomes a payment; an item-bearing completion pays both halves or
    neither; an account merge carries the challenge receipts and debts; and a mode with
    `WinCondition.NONE` stops stamping a win. `docs/ECONOMY.md`'s challenges bullets carry the
    rules.

  The editor landed two commits after the engine, so the console never offered a switch with
  nothing behind it.
