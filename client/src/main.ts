/**
 * DOOMCRAFT — boot.
 *
 * Order of operations, and why:
 *
 *   1. The loading screen is already painted (it is inline in index.html), so
 *      this module's only job at t=0 is to start the *server* — the authoritative
 *      room runs in a Worker in this tab. Nothing waits on matchmaking.
 *   2. The renderer comes up while the world streams in. The first frame is
 *      drawn as soon as the spawn chunk is meshed, not when all 169 have landed.
 *   3. The menu opens over the LIVE game. It is not a screenshot and not a
 *      separate scene: the match is already running behind it, which is how a
 *      click on PLAY costs zero seconds. The bar takes ~25 s from click to
 *      shooting (ref/BAR.md weakness #5); we take one frame.
 *
 * The frame loop is here rather than in `Game` so a paused game still renders
 * (the menu background) while the simulation is idle.
 */

import {
  XP_PER_KILL, XP_PER_MINUTE, levelForXp,
  DOM_CANVAS_ID, DOM_HUD_ID, DOM_UI_ID, DOM_ADS_ID, DOM_BOOT_ID,
  DOM_BOOT_BAR_ID, DOM_BOOT_PCT_ID, DOM_BOOT_STATUS_ID,
  DEFAULT_SETTINGS, DEFAULT_PROGRESS, STORAGE_KEYS, SAVE_VERSION,
  AD_SLOT_IDS, IAP_PRICE_USD, IAP_PRODUCT_REMOVE_ADS,
  GAME_MODE_NAMES, GameMode, FOV_MIN, FOV_MAX,
  RENDER_DISTANCE_MIN, RENDER_DISTANCE_MAX,
  SENSITIVITY_MIN, SENSITIVITY_MAX,
  type GameSettings, type SaveProgress, type QualityPreset, type CrosshairStyle,
} from '@shared/constants';

import {
  MODE_KEYS,
  ModeId,
  encodeModeSelect,
  getMode,
  isModeId,
  legacyGameMode,
  modeFromKey,
} from '@shared/modes';
import { PacketWriter } from '@shared/protocol';
import {
  MemorySaveStorage,
  addBuilderWorld,
  loadSave,
  removeBuilderWorld,
  storeSave,
  type SaveFile,
  type SaveStorage,
} from '@shared/saves';

import { Game } from '@/game/game';
import {
  ModeRegistry,
  createEnterParams,
  paramsFromQuery,
  toModeSelectMessage,
  type ModeEnterParams,
  type ModeHost,
  type ModeScopeStats,
} from '@/modes/registry';
import {
  createModeSelect,
  levelRowFrom,
  worldRowsFrom,
  type ModeSelect,
  type ModeSelectLevel,
} from '@/ui/modeSelect';

/* ------------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------------ */

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { ...fallback };
    const parsed = JSON.parse(raw) as Partial<T>;
    return { ...fallback, ...parsed, version: SAVE_VERSION } as T;
  } catch {
    return { ...fallback };
  }
}

function saveJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

function deviceId(): string {
  const key = `${STORAGE_KEYS.progress}:device`;
  let id = '';
  try { id = localStorage.getItem(key) ?? ''; } catch { id = ''; }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(key, id); } catch { /* ignore */ }
  }
  return id;
}

/* ------------------------------------------------------------------------ *
 * Tiny DOM helpers
 * ------------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return b;
}

/* ------------------------------------------------------------------------ *
 * Shell styles
 * ------------------------------------------------------------------------ */

const SHELL_CSS = `
#ui{font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#e8e6e3}
#ui button{font:inherit;cursor:pointer}
.dc-screen{position:absolute;inset:0;display:none;overflow:auto}
#ui[data-screen="menu"] .dc-menu{display:grid}
#ui[data-screen="paused"] .dc-pause-wrap{display:grid}
.dc-menu{place-items:center;background:
  radial-gradient(80% 62% at 50% 12%,rgba(24,10,6,.46),rgba(6,6,9,.74) 72%)}
.dc-menu-inner{width:min(940px,92vw);text-align:center;padding:18px 0 26px}
.dc-mark{font:900 clamp(44px,8.4vw,92px)/0.9 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.01em;margin:0;color:#f4f1ee;
  text-shadow:0 3px 0 #7a1a08,0 6px 0 #4a1005,0 16px 40px rgba(224,60,28,.4)}
.dc-mark span{color:#e03c1c}
.dc-tag{margin:8px 0 22px;font-size:12px;letter-spacing:.36em;text-transform:uppercase;color:#8a8078}
.dc-cta{display:inline-flex;align-items:center;gap:12px;padding:16px 44px;border:0;
  background:linear-gradient(180deg,#e03c1c,#8f1a08);color:#fff;font:800 20px/1 "Arial Black",Impact,sans-serif;
  letter-spacing:.14em;border-radius:3px;box-shadow:0 10px 30px rgba(224,60,28,.35);
  text-transform:uppercase}
.dc-cta:hover{filter:brightness(1.12)}
.dc-cta small{font:600 11px/1 system-ui;letter-spacing:.1em;opacity:.85}
.dc-modes{display:flex;gap:8px;justify-content:center;margin:18px 0 6px;flex-wrap:wrap}
.dc-mode{padding:8px 16px;border:1px solid rgba(255,255,255,.18);background:rgba(12,12,16,.7);
  color:#b4aea8;border-radius:2px;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.dc-mode.on{border-color:#f0a020;color:#f6e3c8;background:rgba(46,26,10,.8)}
.dc-row{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap}
.dc-ghost{padding:9px 18px;background:rgba(12,12,16,.72);border:1px solid rgba(255,255,255,.18);
  color:#cfc9c3;border-radius:2px;font-size:13px}
.dc-ghost:hover{border-color:rgba(255,255,255,.4)}
.dc-note{margin-top:16px;font-size:12px;color:#7d7873}
.dc-note b{color:#b4aea8}
.dc-stats{display:flex;gap:22px;justify-content:center;margin-top:18px;font-size:12px;color:#8a8078}
.dc-stats b{display:block;font-size:19px;color:#e8e6e3;font-variant-numeric:tabular-nums}

.dc-pause-wrap{place-items:center;background:rgba(6,6,9,.72);backdrop-filter:blur(2px)}
.dc-panel{width:min(560px,92vw);max-height:88vh;display:flex;flex-direction:column;
  background:rgba(12,12,16,.96);
  border:1px solid rgba(255,255,255,.14);border-radius:4px;padding:22px 24px;
  box-shadow:0 24px 60px rgba(0,0,0,.6)}
.dc-panel h2{margin:0 0 4px;font:800 22px/1.1 "Arial Black",Impact,sans-serif;letter-spacing:.06em}
.dc-panel p.sub{margin:0 0 18px;font-size:12px;color:#8a8078;letter-spacing:.08em;text-transform:uppercase}
.dc-set{display:grid;grid-template-columns:1fr 150px 52px;gap:9px 12px;align-items:center;
  font-size:13px;color:#b4aea8;overflow-y:auto;min-height:0;flex:1;
  padding-right:4px;scrollbar-width:thin}
.dc-set input[type=range]{width:100%;accent-color:#e03c1c}
.dc-set select{width:100%;background:#17171d;color:#e8e6e3;border:1px solid rgba(255,255,255,.18);
  padding:5px;border-radius:2px}
.dc-set .val{text-align:right;font-variant-numeric:tabular-nums;color:#e8e6e3}
.dc-set .chk{grid-column:2 / span 2;justify-self:end}
.dc-sec{margin:18px 0 8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6f6a66;
  border-top:1px solid rgba(255,255,255,.09);padding-top:12px}
.dc-actions{display:flex;gap:10px;margin-top:18px;flex:0 0 auto;
  border-top:1px solid rgba(255,255,255,.09);padding-top:16px}
.dc-actions button{flex:1;padding:11px}
.dc-primary{background:#e03c1c;border:0;color:#fff;font-weight:700;border-radius:2px}

.dc-ad-house{display:grid;place-items:center;width:100%;height:100%;text-align:center;
  background:linear-gradient(135deg,#141018,#1d1116);color:#9b9793;font-size:11px;line-height:1.4;
  letter-spacing:.06em}
.dc-ad-house b{display:block;color:#f0a020;font-size:13px;letter-spacing:.1em}
.dc-ad-house u{display:inline-block;margin-top:5px;color:#e8e6e3;text-decoration:none;
  border:1px solid rgba(255,255,255,.28);padding:3px 9px;border-radius:2px;cursor:pointer}

/* --- the mode layer ------------------------------------------------------ */
.dc-menu-inner{width:min(1080px,96vw)}
.dc-select{margin-top:14px}
/* The bar puts "Loading Terrain (100.00%)..." dead centre; so do we, and it is
   the one thing a mode is allowed to write into the middle of the screen. */
.dc-status{position:absolute;left:50%;top:calc(50% - 96px);transform:translateX(-50%);
  padding:5px 14px;border-radius:2px;background:rgba(8,8,11,.78);color:#e8e6e3;
  border:1px solid rgba(255,255,255,.13);white-space:nowrap;pointer-events:none;
  font:12px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  letter-spacing:.06em;z-index:6}
.dc-status[hidden]{display:none}
.dc-fault{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);
  max-width:min(680px,92vw);padding:8px 14px;border-radius:2px;
  background:rgba(30,6,4,.92);border:1px solid rgba(224,60,28,.65);color:#ffcabb;
  font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;z-index:9}
.dc-fault[hidden]{display:none}
`;

/* ------------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------------ */

const t0 = (window as unknown as { __DC_T0__?: number }).__DC_T0__ ?? performance.now();

const canvas = document.getElementById(DOM_CANVAS_ID) as HTMLCanvasElement | null;
const hudRoot = document.getElementById(DOM_HUD_ID);
const uiRoot = document.getElementById(DOM_UI_ID);
const adsRoot = document.getElementById(DOM_ADS_ID);
const boot = document.getElementById(DOM_BOOT_ID);
const bootBar = document.getElementById(DOM_BOOT_BAR_ID);
const bootPct = document.getElementById(DOM_BOOT_PCT_ID);
const bootStatus = document.getElementById(DOM_BOOT_STATUS_ID);

if (canvas === null || hudRoot === null || uiRoot === null) {
  throw new Error('DOOMCRAFT: index.html is missing #game / #hud / #ui');
}

const style = el('style');
style.textContent = SHELL_CSS;
document.head.appendChild(style);

const settings: GameSettings = loadJson<GameSettings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS as GameSettings);
const progress: SaveProgress = loadJson<SaveProgress>(STORAGE_KEYS.progress, DEFAULT_PROGRESS as SaveProgress);

const params = new URLSearchParams(location.search);
const autoplay = params.get('autoplay') === '1';
const forceTouch = params.get('touch') === '1';
const seedParam = params.get('seed');

/* --- saves ------------------------------------------------------------- *
 * One document holds all four modes' progress (`shared/src/saves.ts`). It is
 * separate from the legacy `progress` blob above, which the menu's stat strip
 * and the ad entitlement still read, and which migrates into it on first load.
 * --------------------------------------------------------------------- */

const saveStorage: SaveStorage = (() => {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* private mode */ }
  return new MemorySaveStorage();
})();

let save: SaveFile = loadSave(saveStorage, Date.now());

function flushSave(): void { storeSave(saveStorage, save, Date.now()); }

/* --- which mode are we booting into? ----------------------------------- *
 * `?mode=` wins (that is how the capture harness enters a mode), then the last
 * mode this device played, then Deathmatch — the instant-start mode, which is
 * the one that answers the bar's 25-second wait.
 * --------------------------------------------------------------------- */

const bootParams: ModeEnterParams = paramsFromQuery(
  location.search,
  isModeId(save.profile.lastMode) ? save.profile.lastMode : ModeId.DEATHMATCH,
);
/** The params the next Play will use. The picker writes into this. */
const pendingParams: ModeEnterParams = createEnterParams(bootParams.modeId);
pendingParams.skill = bootParams.skill;
pendingParams.levelId = bootParams.levelId;
pendingParams.worldId = bootParams.worldId;
pendingParams.seed = bootParams.seed;
pendingParams.flags = bootParams.flags;

const mode: number = legacyGameMode(bootParams.modeId);

const game = new Game({
  canvas,
  hudRoot,
  settings,
  name: progress.name || 'Marine',
  seed: seedParam !== null ? Number(seedParam) >>> 0 : undefined,
  mode,
  bots: 8,
  enemies: 12,
  touch: forceTouch ? true : undefined,
  events: {
    onProgress: (p, label) => setBootProgress(p, label),
    onReady: () => onReady(),
    onDeath: () => { /* the HUD prints the prompt */ },
    onPauseRequested: () => openPause(),
    onStatus: (s, d) => {
      if (s === 'error') setBootProgress(0, `Error: ${d ?? 'unknown'}`);
    },
  },
});

game.connect();

/* ------------------------------------------------------------------------ *
 * Loading screen
 * ------------------------------------------------------------------------ */

let bootShown = true;
let lastPct = -1;

function setBootProgress(p: number, label: string): void {
  if (!bootShown) return;
  const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
  if (pct !== lastPct) {
    lastPct = pct;
    if (bootBar !== null) bootBar.style.width = `${pct}%`;
    if (bootPct !== null) bootPct.textContent = `${pct}%`;
  }
  if (bootStatus !== null && bootStatus.textContent !== label) bootStatus.textContent = label;
}

function hideBoot(): void {
  if (!bootShown || boot === null) return;
  bootShown = false;
  boot.classList.add('is-done');
  window.setTimeout(() => { boot.hidden = true; }, 320);
}

/* ------------------------------------------------------------------------ *
 * Menu
 * ------------------------------------------------------------------------ */

const menu = el('div', 'dc-screen dc-menu');
const menuInner = el('div', 'dc-menu-inner');
menu.appendChild(menuInner);

const mark = el('h1', 'dc-mark');
mark.innerHTML = 'DOOM<span>CRAFT</span>';
menuInner.appendChild(mark);
menuInner.appendChild(el('p', 'dc-tag', 'Rip and build · voxel arena · no install'));

/**
 * The mode picker. Four tiles, an inline picker per mode and one Play button —
 * `client/src/ui/modeSelect.ts` owns all of it. The shell's only jobs are to
 * feed it content (levels, worlds, the save) and to turn its `onPlay` into a
 * registry activation.
 */
const selectMount = el('div', 'dc-select');
menuInner.appendChild(selectMount);

const modeSelect: ModeSelect = createModeSelect({
  root: selectMount,
  save,
  initialMode: bootParams.modeId,
  worlds: worldRowsFrom(save),
  onPlay: (p) => { void startMode(p); },
  onModeChange: (m) => { pendingParams.modeId = m; },
  onCreateWorld: (name, seed) => {
    const w = addBuilderWorld(save, name, seed >>> 0, Date.now());
    flushSave();
    modeSelect.setWorlds(worldRowsFrom(save));
    return w.id;
  },
  onDeleteWorld: (id) => {
    if (!removeBuilderWorld(save, id)) return;
    flushSave();
    modeSelect.setWorlds(worldRowsFrom(save));
  },
});

const statRow = el('div', 'dc-stats');
const statKills = el('span', undefined);
statKills.innerHTML = `<b>${progress.kills}</b>KILLS`;
const statDeaths = el('span', undefined);
statDeaths.innerHTML = `<b>${progress.deaths}</b>DEATHS`;
const statGames = el('span', undefined);
statGames.innerHTML = `<b>${progress.gamesPlayed}</b>MATCHES`;
const statLevel = el('span', undefined);
statLevel.innerHTML = `<b>${progress.level}</b>LEVEL`;
statRow.append(statKills, statDeaths, statGames, statLevel);
menuInner.appendChild(statRow);

const menuRow = el('div', 'dc-row');
menuRow.appendChild(button('Settings', 'dc-ghost', () => openSettings('menu')));
const removeAdsBtn = button(`Remove ads — $${IAP_PRICE_USD.toFixed(2)}`, 'dc-ghost', () => purchaseRemoveAds());
menuRow.appendChild(removeAdsBtn);
menuInner.appendChild(menuRow);

menuInner.appendChild(el(
  'p', 'dc-note',
  'WASD move · Shift sprint · Space jump · LMB fire · RMB place a block · B build mode · Esc menu',
));

uiRoot.appendChild(menu);


/* ------------------------------------------------------------------------ *
 * Pause + settings panel
 * ------------------------------------------------------------------------ */

const pauseWrap = el('div', 'dc-screen dc-pause-wrap');
const panel = el('div', 'dc-panel');
pauseWrap.appendChild(panel);
uiRoot.appendChild(pauseWrap);

const panelTitle = el('h2', undefined, 'Paused');
const panelSub = el('p', 'sub', 'The match keeps running');
panel.append(panelTitle, panelSub);

const setGrid = el('div', 'dc-set');
panel.appendChild(setGrid);

const actions = el('div', 'dc-actions');
panel.appendChild(actions);

let settingsReturn: 'menu' | 'game' = 'game';

function addSection(title: string): void {
  const s = el('div', 'dc-sec', title);
  s.style.gridColumn = '1 / -1';
  setGrid.appendChild(s);
}

function addSlider(
  label: string, min: number, max: number, step: number,
  get: () => number, set: (v: number) => void, fmt: (v: number) => string,
): void {
  setGrid.appendChild(el('label', undefined, label));
  const input = el('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(get());
  const val = el('span', 'val', fmt(get()));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    val.textContent = fmt(v);
    applySettings();
  });
  setGrid.append(input, val);
}

function addSelect(label: string, options: string[], get: () => string, set: (v: string) => void): void {
  setGrid.appendChild(el('label', undefined, label));
  const sel = el('select');
  for (const o of options) {
    const opt = el('option', undefined, o);
    opt.value = o;
    sel.appendChild(opt);
  }
  sel.value = get();
  sel.addEventListener('change', () => { set(sel.value); applySettings(); });
  const spacer = el('span', 'val');
  setGrid.append(sel, spacer);
}

function addToggle(label: string, get: () => boolean, set: (v: boolean) => void): void {
  setGrid.appendChild(el('label', undefined, label));
  const wrap = el('span', 'chk');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = get();
  input.addEventListener('change', () => { set(input.checked); applySettings(); });
  wrap.appendChild(input);
  setGrid.appendChild(wrap);
}

addSection('Controls');
addSlider('Mouse sensitivity', SENSITIVITY_MIN, SENSITIVITY_MAX, 0.05,
  () => settings.sensitivity, (v) => { settings.sensitivity = v; }, (v) => v.toFixed(2));
addSlider('Touch sensitivity', SENSITIVITY_MIN, SENSITIVITY_MAX, 0.05,
  () => settings.touchSensitivity, (v) => { settings.touchSensitivity = v; }, (v) => v.toFixed(2));
addToggle('Invert look', () => settings.invertY, (v) => { settings.invertY = v; });
addToggle('Toggle crouch', () => settings.toggleCrouch, (v) => { settings.toggleCrouch = v; });
addToggle('Auto sprint', () => settings.autoSprint, (v) => { settings.autoSprint = v; });

addSection('Display');
addSlider('Field of view', FOV_MIN, FOV_MAX, 1,
  () => settings.fov, (v) => { settings.fov = v; }, (v) => `${v.toFixed(0)}°`);
addSlider('Render distance', RENDER_DISTANCE_MIN, RENDER_DISTANCE_MAX, 1,
  () => settings.renderDistance, (v) => { settings.renderDistance = v; }, (v) => `${v.toFixed(0)}`);
addSlider('Render scale', 0.5, 1.25, 0.05,
  () => settings.renderScale, (v) => { settings.renderScale = v; }, (v) => `${Math.round(v * 100)}%`);
addSelect('Quality', ['low', 'medium', 'high'],
  () => settings.quality, (v) => { settings.quality = v as QualityPreset; });
addToggle('Ambient occlusion', () => settings.ao, (v) => { settings.ao = v; });
addToggle('Fog', () => settings.fog, (v) => { settings.fog = v; });
addToggle('FPS counter', () => settings.fpsCounter, (v) => { settings.fpsCounter = v; });

addSection('Feel');
addSlider('Screen shake', 0, 1.5, 0.05,
  () => settings.screenShake, (v) => { settings.screenShake = v; }, (v) => `${Math.round(v * 100)}%`);
addToggle('View bob', () => settings.viewBob, (v) => { settings.viewBob = v; });
addSelect('Crosshair', ['cross', 'dot', 'doom', 'dynamic'],
  () => settings.crosshair, (v) => { settings.crosshair = v as CrosshairStyle; });
addToggle('Hit markers', () => settings.hitMarkers, (v) => { settings.hitMarkers = v; });

const resumeBtn = button('Resume', 'dc-primary', () => closePause());
const menuBtn = button('Leave match', 'dc-ghost', () => backToMenu());
actions.append(resumeBtn, menuBtn);

function applySettings(): void {
  game.applySettings(settings);
  saveJson(STORAGE_KEYS.settings, settings);
}

/* ------------------------------------------------------------------------ *
 * The mode layer
 *
 * Four modes, one renderer, one net client, one frame loop. `ModeRegistry`
 * owns the switch; every resource a mode creates is registered in its scope and
 * unwound in reverse on exit, so `registry.scopeStats().live` reads zero
 * between modes — which is a thing the harness asserts, not a thing we hope.
 *
 * Factories are dynamic imports on purpose. A player who only ever plays
 * Deathmatch never downloads the campaign, the level compiler or the creative
 * inventory; the boot bundle stays the boot bundle.
 * ------------------------------------------------------------------------ */

/** Centre-screen status line — the surface the bar uses for "Loading Terrain". */
const statusLine = el('div', 'dc-status');
statusLine.hidden = true;
hudRoot.appendChild(statusLine);

/** A mode that fails to start says so on screen rather than in the console. */
const faultLine = el('div', 'dc-fault');
faultLine.hidden = true;
uiRoot.appendChild(faultLine);

function showFault(text: string): void {
  faultLine.textContent = text;
  faultLine.hidden = text.length === 0;
}

const host: ModeHost = {
  game,
  uiRoot,
  hudRoot,
  canvas,
  settings,
  send(bytes: Uint8Array): void { game.net.send(bytes); },
  setStatus(text: string): void {
    statusLine.textContent = text;
    statusLine.hidden = text.length === 0;
  },
  requestExit(reason: string): void {
    if (reason.length > 0) game.hud.pushFeed(reason, 's');
    void backToMenu();
  },
  suppressAutoPause(on: boolean): void { autoPauseSuppressed = on; },
};

/** See `ModeHost.suppressAutoPause`. Cleared on every mode exit. */
let autoPauseSuppressed = false;

const registry = new ModeRegistry(host, {
  onEntered: (id) => {
    showFault('');
    save.profile.lastMode = id;
    flushSave();
  },
  onExited: (_id, stats) => {
    autoPauseSuppressed = false;
    // A disposer that threw is a leak with a name. Surface it; never swallow it.
    if (stats.errors > 0) showFault(`Mode teardown reported ${stats.errors} failing disposer(s).`);
  },
  onError: (id, error) => {
    const msg = error instanceof Error ? error.message : String(error);
    showFault(`${getMode(id).name} could not start: ${msg}`);
    host.setStatus('');
  },
});

registry.register(ModeId.QUEST, async (ctx) => (await import('@/modes/quest/quest')).questMode(ctx));
registry.register(ModeId.BUILDER, async (ctx) => (await import('@/modes/builder/builder')).builderMode(ctx));
registry.register(ModeId.HORDE, async (ctx) => (await import('@/modes/horde/horde')).createHordeMode(ctx));
registry.register(
  ModeId.DEATHMATCH,
  async (ctx) => (await import('@/modes/deathmatch/deathmatch')).createDeathmatchMode(ctx),
);

/* --- the wire ---------------------------------------------------------- *
 * `Game` owns the NetClient; the three mode messages are handed straight to
 * whichever mode is live. A room that never sends them costs nothing.
 * --------------------------------------------------------------------- */
game.net.events.onModeState = (state) => { registry.dispatchState(state); };
game.net.events.onModeEvent = (event) => { registry.dispatchEvent(event); };
game.net.events.onModeContext = (context) => { registry.dispatchContext(context); };

/* ------------------------------------------------------------------------ *
 * Quest level discovery for the picker
 *
 * The picker needs names and denominators before anything is loaded, and the
 * campaign must stay data: this reads the same `content/levels/*.json` the mode
 * does, but only the `meta` block and the array lengths — no compile, no
 * validation, no voxels. Six small parses, off the boot critical path.
 * ------------------------------------------------------------------------ */

const MENU_LEVEL_SOURCES = import.meta.glob(
  '../../content/levels/*.json',
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

function levelIdFromPath(path: string): string {
  const slash = path.lastIndexOf('/');
  const name = slash < 0 ? path : path.slice(slash + 1);
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

async function discoverLevels(): Promise<ModeSelectLevel[]> {
  const rows: ModeSelectLevel[] = [];
  for (const path of Object.keys(MENU_LEVEL_SOURCES)) {
    const fallbackId = levelIdFromPath(path);
    try {
      const doc = JSON.parse(await MENU_LEVEL_SOURCES[path]()) as Record<string, unknown>;
      const meta = (doc.meta ?? {}) as Record<string, unknown>;
      const len = (k: string): number => (Array.isArray(doc[k]) ? (doc[k] as unknown[]).length : 0);
      const str = (k: string, d: string): string =>
        (typeof meta[k] === 'string' && (meta[k] as string).length > 0 ? meta[k] as string : d);
      const num = (k: string, d: number): number => (typeof meta[k] === 'number' ? meta[k] as number : d);
      rows.push(levelRowFrom({
        id: str('id', fallbackId),
        name: str('name', fallbackId),
        episodeId: str('episodeId', 'e1'),
        episodeName: str('episodeName', 'Episode 1'),
        episodeIndex: num('episodeIndex', 1),
        levelIndex: num('levelIndex', rows.length + 1),
        parTimeSec: num('parTimeSec', 0),
        enemies: len('enemies'),
        items: len('pickups'),
        secrets: len('secrets'),
        valid: true,
      }, save));
    } catch {
      // A level file that will not parse is not offered. It is not a crash.
    }
  }
  rows.sort((a, b) => (a.episodeIndex - b.episodeIndex) || (a.levelIndex - b.levelIndex));
  return rows;
}

/* ------------------------------------------------------------------------ *
 * Screens
 * ------------------------------------------------------------------------ */

type Screen = 'boot' | 'menu' | 'playing' | 'paused';

function setScreen(s: Screen): void {
  uiRoot!.dataset.screen = s;
  if (adsRoot !== null) {
    adsRoot.dataset.mode = settings.showAds === false || progress.adsRemoved
      ? 'off'
      : s === 'playing' ? 'game' : 'menu';
  }
}

function onReady(): void {
  hideBoot();
  fillAdSlots();
  void discoverLevels().then((rows) => { modeSelect.setLevels(rows); });
  if (autoplay) void startMode(bootParams);
  else setScreen('menu');
  const w = window as unknown as { __DC__?: Record<string, unknown> };
  if (w.__DC__ !== undefined) w.__DC__.interactiveAtMs = performance.now() - t0;
}

/** Reused across every mode switch; the shell must not allocate to send. */
const selectWriter = new PacketWriter(96);

function announceMode(p: ModeEnterParams): void {
  game.net.send(encodeModeSelect(selectWriter, toModeSelectMessage(p)).copy());
}

/**
 * Enter a mode and start playing it. One promise chain: the registry serialises
 * activations internally, so two fast clicks on two tiles cannot leave two
 * modes half-alive.
 */
async function startMode(p: ModeEnterParams): Promise<void> {
  if (!game.ready) return;
  if (uiRoot!.dataset.screen === 'menu') {
    progress.gamesPlayed++;
    progressDirty = true;
  }
  pendingParams.modeId = p.modeId;
  pendingParams.skill = p.skill;
  pendingParams.levelId = p.levelId;
  pendingParams.worldId = p.worldId;
  pendingParams.seed = p.seed;
  pendingParams.flags = p.flags;

  modeSelect.setBusy(true, `Starting ${getMode(p.modeId).name}…`);
  setScreen('playing');
  game.enterPlay();
  registry.setPaused(false);

  // The last mode's kill feed is not this mode's news.
  game.hud.clearFeed();

  /* Tell the room before the mode comes up. Three of the four modes also send
   * their own `SELECT` from `enter()`; that duplicate is free (the room only
   * re-streams the world when the mode id actually changes), and doing it here
   * as well is what covers the fourth — and any mode added later that forgets. */
  announceMode(pendingParams);

  try {
    await registry.activate(pendingParams);
  } finally {
    modeSelect.setBusy(false);
  }
  registry.resize(canvas!.clientWidth, canvas!.clientHeight);
}

/** Resume the mode that is already active, or start the pending one. */
function startPlaying(): void {
  if (registry.activeId >= 0) {
    setScreen('playing');
    game.enterPlay();
    registry.setPaused(false);
    return;
  }
  void startMode(pendingParams);
}

function openPause(): void {
  if (!game.playing) return;
  game.leavePlay();
  registry.setPaused(true);
  panelTitle.textContent = 'Paused';
  panelSub.textContent = `${registry.activeId >= 0 ? getMode(registry.activeId).name : 'The match'} keeps running`;
  resumeBtn.textContent = 'Resume';
  menuBtn.textContent = 'Leave match';
  settingsReturn = 'game';
  setScreen('paused');
}

function closePause(): void {
  if (settingsReturn === 'menu') { setScreen('menu'); return; }
  startPlaying();
}

function openSettings(from: 'menu' | 'game'): void {
  settingsReturn = from;
  panelTitle.textContent = 'Settings';
  panelSub.textContent = from === 'menu' ? 'Applies immediately' : 'The match keeps running';
  resumeBtn.textContent = from === 'menu' ? 'Back' : 'Resume';
  menuBtn.textContent = from === 'menu' ? 'Close' : 'Leave match';
  setScreen('paused');
}

/**
 * Leave to the menu. The mode is torn down completely — not paused — which is
 * the whole point of the scope ledger: the next mode starts on a clean scene
 * graph, a clean `#hud`, no stray listeners and no orphaned workers.
 */
async function backToMenu(): Promise<void> {
  game.leavePlay();
  host.setStatus('');
  await registry.deactivate();
  progress.level = levelForXp(progress.xp);
  saveJson(STORAGE_KEYS.progress, progress);
  save = loadSave(saveStorage, Date.now());
  modeSelect.setSave(save);
  modeSelect.setWorlds(worldRowsFrom(save));
  refreshStats();
  setScreen('menu');
}

setScreen('boot');

window.addEventListener('resize', () => {
  registry.resize(canvas!.clientWidth, canvas!.clientHeight);
}, { passive: true });

/* ------------------------------------------------------------------------ *
 * Global input that the game itself must not swallow
 * ------------------------------------------------------------------------ */

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (game.playing) { openPause(); e.preventDefault(); }
    else if (uiRoot!.dataset.screen === 'paused') { closePause(); e.preventDefault(); }
    return;
  }
  if (!game.ready) return;
  if (uiRoot!.dataset.screen === 'menu' && (e.code === 'Enter' || e.code === 'Space')) {
    startPlaying();
    e.preventDefault();
  }
});

// Losing pointer lock (alt-tab, Esc) means the player is no longer driving.
document.addEventListener('pointerlockchange', () => {
  if (autoPauseSuppressed) return;
  if (document.pointerLockElement === null && game.playing && !unlockedLookMode) openPause();
});

/**
 * Pointer lock is not always available (cross-origin embeds, automation).
 * Ask once; if the browser has not granted it shortly after the click, switch
 * to reading unlocked mouse deltas so the game is still playable.
 */
let unlockedLookMode = false;
canvas.addEventListener('click', () => {
  if (!game.ready) return;
  if (uiRoot!.dataset.screen === 'menu') { startPlaying(); return; }
  if (game.playing && document.pointerLockElement === null && !unlockedLookMode) {
    window.setTimeout(() => {
      if (document.pointerLockElement === null && game.playing) {
        unlockedLookMode = true;
        game.allowUnlockedLook(true);
      }
    }, 400);
  }
});

window.addEventListener('blur', () => { if (game.playing) openPause(); });

/* ------------------------------------------------------------------------ *
 * Ads — reserved slots, filled with a house creative
 * ------------------------------------------------------------------------ */

function fillAdSlots(): void {
  if (adsRoot === null) return;
  for (const id of AD_SLOT_IDS) {
    const slot = document.getElementById(id);
    if (slot === null || slot.childElementCount > 0) continue;
    const house = el('div', 'dc-ad-house');
    house.innerHTML =
      '<div><b>DOOMCRAFT</b>This slot is reserved at first paint, so filling it '
      + 'never shifts the layout.<u>Remove ads</u></div>';
    house.addEventListener('click', () => purchaseRemoveAds());
    slot.appendChild(house);
  }
}

async function purchaseRemoveAds(): Promise<void> {
  removeAdsBtn.textContent = 'Purchasing…';
  const body = JSON.stringify({ deviceId: deviceId(), product: IAP_PRODUCT_REMOVE_ADS });
  const urls = ['/api/entitlement', `${location.protocol}//${location.hostname}:8080/api/entitlement`];
  let granted = false;
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!res.ok) continue;
      const json = await res.json() as { granted?: boolean };
      granted = json.granted === true;
      break;
    } catch { /* try the next endpoint */ }
  }
  progress.adsRemoved = granted || progress.adsRemoved;
  settings.showAds = !progress.adsRemoved;
  saveJson(STORAGE_KEYS.progress, progress);
  saveJson(STORAGE_KEYS.settings, settings);
  removeAdsBtn.textContent = progress.adsRemoved
    ? 'Ads removed — thank you'
    : `Remove ads — $${IAP_PRICE_USD.toFixed(2)}`;
  setScreen((uiRoot!.dataset.screen ?? 'menu') as Screen);
}

if (progress.adsRemoved) {
  settings.showAds = false;
  removeAdsBtn.textContent = 'Ads removed — thank you';
}

/* ------------------------------------------------------------------------ *
 * Saved progress
 *
 * The server owns the authoritative profile (and the entitlement), but a player
 * who never links an account still expects their kill count to be there
 * tomorrow. Counters are diffed off the live scoreboard and written back at
 * most once every few seconds.
 * ------------------------------------------------------------------------ */

let lastKills = 0;
let lastDeaths = 0;
let playedSeconds = 0;
let saveTimer = 0;
let progressDirty = false;

function accumulateProgress(dt: number): void {
  if (!game.playing) return;
  playedSeconds += dt;

  const k = game.net.local.kills;
  const d = game.net.local.deaths;
  if (k > lastKills) {
    const gained = k - lastKills;
    progress.kills += gained;
    progress.xp += XP_PER_KILL * gained;
    progressDirty = true;
  }
  if (d > lastDeaths) {
    progress.deaths += d - lastDeaths;
    progressDirty = true;
  }
  lastKills = k;
  lastDeaths = d;

  if (playedSeconds >= 60) {
    const minutes = Math.floor(playedSeconds / 60);
    playedSeconds -= minutes * 60;
    progress.secondsPlayed += minutes * 60;
    progress.xp += XP_PER_MINUTE * minutes;
    progressDirty = true;
  }

  saveTimer += dt;
  if (progressDirty && saveTimer > 5) {
    saveTimer = 0;
    progressDirty = false;
    progress.level = levelForXp(progress.xp);
    progress.lastSeed = game.net.seed;
    saveJson(STORAGE_KEYS.progress, progress);
    refreshStats();
  }
}

function refreshStats(): void {
  statKills.innerHTML = `<b>${progress.kills}</b>KILLS`;
  statDeaths.innerHTML = `<b>${progress.deaths}</b>DEATHS`;
  statGames.innerHTML = `<b>${progress.gamesPlayed}</b>MATCHES`;
  statLevel.innerHTML = `<b>${progress.level}</b>LEVEL`;
}

/* ------------------------------------------------------------------------ *
 * Frame loop
 * ------------------------------------------------------------------------ */

/**
 * One loop drives the game and the mode. Order matters:
 *
 *   1. `game.tick` runs the fixed simulation, reconciles the prediction and
 *      draws the scene. Everything the mode reads — `net.renderPos`, the
 *      snapshot, the chunk store — is current after it returns.
 *   2. `registry.fixedUpdate` at the sim's own 1/60 cadence, from an
 *      accumulator kept here so a mode's fixed step is not tied to the frame.
 *   3. `registry.update` then `registry.render`, both once per frame.
 *
 * Nothing in this function allocates.
 */
const MODE_FIXED_DT = 1 / 60;
const MODE_MAX_FIXED_STEPS = 5;

let raf = 0;
let lastFrameMs = 0;
let modeAccumulator = 0;
let modeTick = 0;

function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  game.tick(now);

  const dt = lastFrameMs === 0 ? 0 : Math.min(0.25, (now - lastFrameMs) / 1000);
  lastFrameMs = now;

  if (registry.activeId >= 0) {
    modeAccumulator += dt;
    let steps = 0;
    while (modeAccumulator >= MODE_FIXED_DT && steps < MODE_MAX_FIXED_STEPS) {
      modeAccumulator -= MODE_FIXED_DT;
      steps++;
      modeTick++;
      registry.fixedUpdate(MODE_FIXED_DT, modeTick);
    }
    if (steps === MODE_MAX_FIXED_STEPS) modeAccumulator = 0;
    registry.update(dt, now);
    registry.render(modeAccumulator / MODE_FIXED_DT);
  } else {
    modeAccumulator = 0;
  }

  accumulateProgress(dt);
}
raf = requestAnimationFrame(frame);

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(raf);
  saveJson(STORAGE_KEYS.settings, settings);
  saveJson(STORAGE_KEYS.progress, progress);
});

/* ------------------------------------------------------------------------ *
 * Automation surface
 *
 * tools/capture-ours.mjs drives the real build through this, so the A/B runs
 * against the shipping code path rather than a test harness.
 * ------------------------------------------------------------------------ */

(window as unknown as { __DC__: Record<string, unknown> }).__DC__ = {
  version: 1,
  t0,
  interactiveAtMs: 0,
  game,
  get ready(): boolean { return game.ready; },
  get playing(): boolean { return game.playing; },
  get screen(): string { return uiRoot!.dataset.screen ?? ''; },
  play(): void { startPlaying(); },
  pause(): void { openPause(); },
  menu(): Promise<void> { return backToMenu(); },

  /* --- the mode layer, for tools/capture-ours.mjs --------------------- */

  /** Mode slugs in registry order: quest, builder, horde, deathmatch. */
  modeKeys: MODE_KEYS.slice(),
  /** The live mode's slug, or '' between modes. */
  get modeKey(): string {
    return registry.activeId < 0 ? '' : MODE_KEYS[registry.activeId];
  },
  get switching(): boolean { return registry.switching; },
  /**
   * Enter a mode by slug and wait until it is live. Returns the slug that is
   * actually running, so a harness cannot mistake a failed activation for a
   * successful one.
   */
  async enterMode(key: string, opts?: {
    level?: string; world?: string; skill?: number; seed?: number;
  }): Promise<string> {
    const id = modeFromKey(String(key ?? '').toLowerCase());
    if (id < 0 || !isModeId(id)) throw new Error(`unknown mode "${String(key)}"`);
    const p = createEnterParams(id);
    if (opts?.level !== undefined) p.levelId = String(opts.level).toLowerCase();
    if (opts?.world !== undefined) p.worldId = String(opts.world).toLowerCase();
    if (opts?.skill !== undefined) p.skill = Number(opts.skill) | 0;
    if (opts?.seed !== undefined) p.seed = Number(opts.seed) >>> 0;
    await startMode(p);
    return registry.activeId < 0 ? '' : MODE_KEYS[registry.activeId];
  },
  /** Tear the live mode down and go back to the picker. */
  async leaveMode(): Promise<void> { await backToMenu(); },
  /**
   * Resources the ACTIVE mode still holds. After `leaveMode()` every field is
   * zero — that is the leak assertion the mode-switch loop makes.
   */
  modeScope(): ModeScopeStats { return registry.scopeStats(); },
  modeStats(): Record<string, unknown> {
    const r = registry.stats();
    const scope = registry.scopeStats();
    return {
      activeKey: r.activeKey,
      activations: r.activations,
      teardownErrors: r.teardownErrors,
      liveResources: r.liveResources,
      registered: registry.registered().map((i) => MODE_KEYS[i]),
      scope,
      fault: faultLine.hidden ? '' : (faultLine.textContent ?? ''),
      status: statusLine.hidden ? '' : (statusLine.textContent ?? ''),
      sceneChildren: game.renderer.scene.children.length,
      hudChildren: hudRoot.childElementCount,
      uiChildren: uiRoot.childElementCount,
      modeStateSeen: game.net.modeStateSeen,
      modeStatePhase: game.net.modeState.phase,
      modeStateIndex: game.net.modeState.index,
      modeStateMode: MODE_KEYS[game.net.modeState.modeId] ?? '',
    };
  },
  /** Levels the picker is offering, for a harness that must not hardcode ids. */
  levelIds(): string[] {
    return Object.keys(MENU_LEVEL_SOURCES).map(levelIdFromPath).sort();
  },
  unlockedLook(on: boolean): void { unlockedLookMode = on; game.allowUnlockedLook(on); },
  /** Freeze look/move so a harness can warp the pointer without turning. */
  suspendInput(on: boolean): void {
    game.input.enabled = !on && game.playing;
    if (on) game.input.releaseAll();
  },
  view(): { yaw: number; pitch: number } {
    return { yaw: game.camera.viewYaw, pitch: game.camera.viewPitch };
  },
  /** Metres to the wall straight ahead — a harness should not shoot its own nose. */
  clearance(): number { return game.viewClearance(); },
  pixelsPerRadian(): number { return game.pixelsPerRadian; },
  /** Pointer travel, in pixels, that would put the crosshair on the nearest enemy. */
  aimPixels(): { x: number; y: number; dist: number } | null {
    const out = { yaw: 0, pitch: 0, dist: 0 };
    if (!game.nearestEnemyAim(out)) return null;
    const k = game.pixelsPerRadian;
    return { x: -out.yaw * k, y: -out.pitch * k, dist: out.dist };
  },
  stats(): Record<string, number | string | boolean> {
    return {
      status: game.net.status,
      chunks: game.net.world.chunkCount,
      meshed: game.chunks.stats.meshedChunks,
      visible: game.chunks.stats.visibleChunks,
      drawCalls: game.renderer.drawCalls,
      triangles: game.renderer.triangles,
      workers: game.chunks.stats.workerCount,
      players: game.net.players.filter((p) => p.active).length,
      entities: game.net.entities.filter((e) => e.active).length,
      health: game.net.local.health,
      weapon: game.net.local.weapon,
      medianMs: game.renderer.stats.medianMs(),
      onePctLowFps: game.renderer.stats.onePercentLowFps(),
      ready: game.ready,
      playing: game.playing,
    };
  },
};
