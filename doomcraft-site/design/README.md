# Doomcraft site — design canvas source

Four Design Component artboards + `canvas.json`, the source of the canvas at
https://claude.ai/code/artifact/bf7c1453-9cff-4780-967b-0f6cd7b4dfd9

- `Main.dc.html`     homepage, desktop 1440 — animated hero (CSS only; `motion` tweak turns it off)
- `SignIn.dc.html`   sign-in over the dimmed game — name + passphrase (the real auth), device progress claimed
- `Sponsors.dc.html` sponsor page — phase-one surfaces + measurement promise from docs/SPONSORS.md, apply form
- `Mobile.dc.html`   homepage at 412 px

Images referenced by filename live one directory up (`../ours-*.jpg`). `[BRACKETS]` in the copy are
real facts not yet known (live count, rate card, contact email, build id, news) — fill before shipping.
The HTML actually served at doomcraft-site.vercel.app is `../index.html`; this is the design, not the build.
