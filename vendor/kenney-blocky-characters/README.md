# Kenney "Blocky Characters" 2.0 — vendored

Source: https://kenney.nl/assets/blocky-characters
Licence: **CC0 1.0 Universal (public domain)** — see LICENSE-kenney-CC0.txt.
No attribution required, commercial use permitted. This matters: the game runs ads, and most
OpenGameArt/Freesound material is CC-BY or CC-BY-SA, which would impose attribution or share-alike
obligations. CC0 has neither.

## What is in here

18 rigged characters, GLB. Measured, not assumed:

- **72 triangles** per character. Trivially cheap.
- **1 material, 1 texture, 1 image** each — a single shared atlas.
- **6 meshes / 8 nodes** each — the model is modular, which is what makes avatar customisation
  possible (swap parts rather than swap whole characters).
- **27 animations** each, and they are exactly a shooter's needs:
  `idle, walk, sprint, die, pick-up, holding-right, holding-right-shoot, holding-both-shoot,
  attack-melee-right, attack-kick-right, interact-right, emote-yes, emote-no, sit, drive, static`
  (plus wheelchair variants).
- 111 KB per file, 2.0 MB for all 18.

## The constraint that governs how these are used

**6 meshes per character = 6 draw calls per character unless merged.** The engine's practical
ceiling is ~120 draw calls and Horde already sits at 124. Eight visible enemies at 6 calls each
would be 48 draw calls — that alone would blow the budget. Merge the 6 meshes into one at load,
share one material across all characters, and do not ship all 18.
