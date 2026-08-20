# Doomcraft — the modes, and what each one is judged against

A mode without a bar is a mode nobody can grade, so every mode here names a real, fetchable
opponent. Three bars, all captured live and sitting in `ref/`:

| Bar | Where | Captured | What it grades |
|---|---|---|---|
| **voxiom.io** | live site | `ref/voxiom/` | multiplayer voxel FPS, mobile, ads, menus, load time |
| **DOOM (1993)** | archive.org shareware, em-dosbox | `ref/doom/` | level design, enemies, gunfeel, readability, HUD |
| **Minecraft Classic** | classic.minecraft.net | `ref/mcclassic/` | building feel, block placement, creative inventory |

---

## 1. QUEST — the Doom campaign
**Bar: DOOM (1993), E1M1 "Hangar".** `ref/doom/doom-gameplay.webm`, `ref/doom/doom-03-combat.png`.

Hand-authored levels, not generated terrain. What E1M1 actually does, and what we must match:

- Opens on a **readable silhouette** — you know instantly where the floor, the wall and the exit are.
- **Dark corridors against lit rooms.** Enemies are brighter than their background, always. In the
  captured strip a Sergeant reads instantly in a near-black hallway. That contrast *is* the design.
- **Keycards and locked doors** as the spine of the level graph; **secrets** behind fake walls;
  a **switch that opens the exit**. Loops that bring you back through cleared space from a new angle.
- **Ammo starvation as pacing.** You are always slightly short, which forces weapon rotation.
- The intermission screen: kills %, items %, secrets %, time vs par.

Levels must be **data, not code** — a level format loaded at runtime so new episodes are content.
That is the "options to expand" requirement: a level editor and a JSON/binary level file, and the
game reads a manifest of episodes.

## 2. BUILDER — the Minecraft world
**Bar: Minecraft Classic.** Creative building, shared online worlds, persistent.

- Full block palette with a creative inventory, block picker, and stack management.
- Place/break with the correct **feel**: instant place, held-break with progress, face-targeting that
  matches where you are actually looking, and a highlight wireframe on the targeted block.
- **Multiplayer worlds** that persist — join a friend's world, both edit, both see it, it survives a
  restart. This is where the existing authoritative block-delta log earns its keep.
- Undo of your own last placements, and a flying/no-clip creative camera.

## 3. HORDE — the mode that justifies the mash-up
**Bar: DOOM's combat pressure + our own Builder.** No single shipped game is the reference, so this
one is graded on whether the two halves interlock rather than sit next to each other.

Waves of Doom enemies attack a position. **Between waves you fortify with blocks.** Walls you build
are walls they path around, break through, or fly over — and rockets (yours and theirs) blow your
fortifications open. This is the only mode where the building has a combat purpose and the combat has
a building answer. Nothing in voxiom does this, and it is the strongest original idea in the project.

Wave escalation, a build-phase timer, a currency earned from kills, and a run that ends.

## 4. DEATHMATCH — online PvP
**Bar: voxiom.io Battle Royale.** `ref/voxiom/desktop-08-combat.png`.

This is voxiom's home turf, so it is the hardest A/B. Instant start against bots that swap out for
humans as they arrive — the bar makes you wait ~25 s and that is its biggest own-goal. Rounds,
scoreboard, killfeed, respawn, weapon pickups.

## 5. CO-OP — a flag on Quest, not a fifth mode
Quest levels playable with friends over the same netcode. Deliberately *not* built as a separate
mode: once Quest and the authoritative sim exist, co-op is a spawn-count and a shared-progress
change. Building it as its own mode would duplicate the campaign for no gain.

---

## What this changes about the build

The spine already has terrain, weapons, enemies, destruction, netcode, HUD and saves. The mode layer
sits on top of it:

- a **level format + loader + editor** (Quest), which is also what makes the game expandable
- a **creative inventory + world persistence + world browser** (Builder)
- a **wave director + build phase + economy** (Horde)
- a **round/scoreboard/pickup layer** (Deathmatch)
- a **mode select** in the menu, and per-mode save slots

Generated terrain stays for Builder, Horde and Deathmatch. Quest uses authored levels only.
