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
| **Creator Studio** | the operator, in the admin panel | DATA-class content on the same engine: levels, campaigns, items | a new pack **version** on the volume → the release machine |

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
| **quests** | Challenge packs — `PackKind.QUESTS` is a reserved number with NO producer because there is no challenge engine (`docs/PACKS.md` §1.3: `challengeIds` has a transport slot and zero producers). The ENGINE is a platform-lane project; the studio's quest editor follows it | **LATER** — building the editor first would be a console that lies |

## 2. Rules inherited, and the one decision revised

- **Rule A holds**: everything the studio WRITES as live-able content is data. The two
  build-class designers emit drafts, never installed packs.
- **Rule B holds**: the author is the operator — env bearer or owner session, behind the same
  `AdminGate`, every save an audited admin action. No public authorship, no moderation pipeline.
- **Immutability holds**: a studio save mints a NEW version directory under
  `DOOMCRAFT_PACKS/<key>/<version>/` — never an in-place edit. A re-cut pack is a new version.
- **The gate holds**: a save that cannot pass its own pack's checks (`items.validate`,
  `levels.validate` with the reach solve, `campaign.refs`) is REFUSED at the route, with the
  refusal text verbatim. And an accepted save is still only INSTALLED — reaching a player takes
  draft → gate → approve → stage → promote, exactly as before.
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
