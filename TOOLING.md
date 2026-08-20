# Tooling invariants — do not break these

`playwright@1.62.1` is a required root devDependency. It is not optional test scaffolding: it is
how this project measures itself against the bar. Never remove it from package.json.

- `tools/capture-ref.mjs`  captures the BAR (voxiom.io). Needs **headed** Chrome + the persistent
  profile at `tools/.profile` — voxiom sits behind Cloudflare and headless gets blocked.
- `tools/capture-ours.mjs` captures OURS with the same viewports, screenshot points and metrics.
- `tools/blind.mjs`        builds a masked, neutrally-named A/B pair for a critic.
- `progress/build.mjs`     regenerates the live progress page from `progress/state.json`.

If you change a capture script, change both so the comparison stays apples-to-apples.
