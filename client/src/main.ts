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

import { Game } from '@/game/game';

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
let mode: number = GameMode.DEATHMATCH;

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

const modeRow = el('div', 'dc-modes');
const modeButtons: HTMLElement[] = [];
for (let i = 0; i < GAME_MODE_NAMES.length; i++) {
  const b = button(GAME_MODE_NAMES[i], 'dc-mode', () => selectMode(i));
  modeRow.appendChild(b);
  modeButtons.push(b);
}
menuInner.appendChild(modeRow);

const playBtn = button('Play', 'dc-cta', () => startPlaying());
playBtn.innerHTML = 'Play <small>instantly — bots are already fighting</small>';
menuInner.appendChild(playBtn);

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

function selectMode(m: number): void {
  mode = m;
  for (let i = 0; i < modeButtons.length; i++) modeButtons[i].classList.toggle('on', i === m);
}
selectMode(mode);

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
  if (autoplay) startPlaying();
  else setScreen('menu');
  const w = window as unknown as { __DC__?: Record<string, unknown> };
  if (w.__DC__ !== undefined) w.__DC__.interactiveAtMs = performance.now() - t0;
}

function startPlaying(): void {
  if (uiRoot!.dataset.screen === 'menu') {
    progress.gamesPlayed++;
    progressDirty = true;
  }
  setScreen('playing');
  game.enterPlay();
}

function openPause(): void {
  if (!game.playing) return;
  game.leavePlay();
  panelTitle.textContent = 'Paused';
  panelSub.textContent = 'The match keeps running';
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

function backToMenu(): void {
  game.leavePlay();
  progress.level = levelForXp(progress.xp);
  saveJson(STORAGE_KEYS.progress, progress);
  refreshStats();
  setScreen('menu');
}

setScreen('boot');

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

let raf = 0;
let lastFrameMs = 0;
function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  game.tick(now);
  const dt = lastFrameMs === 0 ? 0 : Math.min(0.25, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
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
  menu(): void { backToMenu(); },
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
