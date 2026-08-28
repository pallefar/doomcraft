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
  SENSITIVITY_MIN, SENSITIVITY_MAX, InputAction,
  type GameSettings, type SaveProgress, type QualityPreset, type CrosshairStyle,
  type SurfaceDetailPreset,
} from '@shared/constants';
import {
  CONTROL_SCHEMES, SCHEME_LABELS, SCHEME_NOTES,
  asControlScheme, sanitiseCustomBindings,
  type CustomBindings, type BindingLayer,
} from '@shared/controls';
import { bindingLabel } from '@/player/input';

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
import { resolveServerUrl } from '@/net/serverConfig';
import { createAdPipeline } from '@/ads/serve';
import { flagOn } from '@doomcraft/shared/flags';
import type { SessionState } from '@/net/session';
import {
  createPrivateRoom,
  listRooms,
  resolveCode,
  type RoomRow,
} from '@/net/matchmaker';
import { AudioMixer, mountAudioSettings } from '@/audio/settings';
import {
  Feature,
  applyServerFlags,
  featureFlagsFromBits,
  isEnabled,
  setOverride,
} from '@shared/features';
import { DEFAULT_PALETTE, MODE_PALETTES, applyModePalette, applyPalette } from '@/engine/palette';
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
import { avatarButtonLabel, createAvatarEditor, type AvatarEditor } from '@/ui/avatarEditor';
/* TYPE-ONLY, both of them, and that is the point: `verbatimModuleSyntax` is
 * false, so these are erased and the profile overlay reaches the browser only
 * through the `import('@/ui/profile')` below. It is 36 kB of source — a third of
 * it `matchType.ts`, which was tree-shaken away entirely while it was orphaned —
 * and no player pays for it until they press the button. */
import type { ProfileScreen } from '@/ui/profile';
import type { ProfileInputs } from '@/ui/profileModel';
import { installUpdates, shouldPromptUpdate, type UpdateSnapshot } from '@/boot/updates';
import { UpdateReason } from '@shared/version';
import { AVATAR_PALETTE, legacySkinFromAvatar, unpackAvatar, writeAvatar } from '@/characters/avatar';

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
/* The locker is a feature, not a preference: it gets the accent and a swatch of
   whatever the player is currently wearing. */
.dc-locker{display:inline-flex;align-items:center;gap:9px;min-height:44px;
  border-color:rgba(224,60,28,.55);color:#f1e3de;background:rgba(46,14,7,.62)}
.dc-locker:hover{border-color:#e03c1c;background:rgba(66,18,8,.75)}
.dc-locker i{width:11px;height:11px;border-radius:50%;flex:0 0 11px;
  box-shadow:0 0 0 1px rgba(0,0,0,.6),0 0 0 2px rgba(255,255,255,.18)}
.dc-note{margin-top:16px;font-size:12px;color:#7d7873}
/* --- online strip. Only in the DOM when a server is configured. --- */
.dc-online{display:flex;gap:8px;justify-content:center;align-items:center;margin-top:14px;flex-wrap:wrap}
.dc-online b{font:700 11px/1 system-ui;letter-spacing:.16em;text-transform:uppercase}
.dc-online .dc-dot{width:8px;height:8px;border-radius:50%;background:#6b6660;flex:0 0 8px}
.dc-online[data-kind="remote"] .dc-dot{background:#4fb84a;box-shadow:0 0 8px rgba(79,184,74,.8)}
.dc-online[data-kind="local"] .dc-dot{background:#8a8078}
.dc-online[data-kind="down"] .dc-dot{background:#e03c1c}
.dc-online span{font-size:12px;color:#9d968f}
.dc-code{width:118px;padding:8px 10px;background:rgba(12,12,16,.72);
  border:1px solid rgba(255,255,255,.18);color:#e6e1dc;border-radius:2px;
  font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase}
.dc-rooms{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:8px}
.dc-room{padding:6px 12px;background:rgba(12,12,16,.72);border:1px solid rgba(255,255,255,.14);
  color:#c7c1bb;border-radius:2px;font-size:12px}
.dc-room:hover{border-color:rgba(255,255,255,.4)}
.dc-room[disabled]{opacity:.4}
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
/* Key rows: label in column 1, the two binding layers sharing columns 2-3.
   The grid template is left alone so these rows line up with every slider. */
.dc-set .dc-keys{grid-column:2 / span 2;display:flex;gap:6px}
.dc-set .dc-key{flex:1 1 0;min-width:0;background:#17171d;color:#e8e6e3;
  border:1px solid rgba(255,255,255,.18);border-radius:2px;padding:5px 4px;
  font:inherit;font-size:12px;text-align:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dc-set .dc-key.empty{color:#5f5a56}
.dc-set .dc-key.listening{border-color:#e03c1c;color:#ffb9a6;background:#24100c}
.dc-set .dc-key.scheme{border-style:dashed}
.dc-note{grid-column:1 / -1;margin:2px 0 6px;font-size:11.5px;line-height:1.5;color:#8a8078}
.dc-note b{color:#c9c4bf;font-weight:600}
.dc-row-btn{grid-column:1 / -1;justify-self:start;background:transparent;
  border:1px solid rgba(255,255,255,.2);color:#c9c4bf;border-radius:2px;padding:6px 12px;
  font:inherit;font-size:12px}
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

/* --- the mode layer ------------------------------------------------------ *
 * The ad slots are LAYOUT, not overlay (ref/BAR.md: "the ads are part of the
 * layout... the page does not reflow when they fill" — that is the bar's one
 * clear win and the thing we are matching). The #ads root sits under #ui, so the
 * menu has to leave their gutters alone rather than paint over them: 728x90 top
 * and bottom, 300x250 on the right above 900px. The reservation is
 * unconditional — it is there whether a creative loads or not, which is what
 * makes filling a slot cost zero layout shift.
 * ------------------------------------------------------------------------ */
.dc-menu{padding:calc(106px + var(--safe-t,0px)) 20px calc(106px + var(--safe-b,0px));
  place-items:safe center}
@media (min-width:901px){ .dc-menu{padding-right:calc(326px + var(--safe-r,0px))} }
/* The right-only reservation puts the menu ~150px left of the viewport's
   centerline, which reads as a bug, not a layout. Once the viewport can
   afford the rail's width on BOTH sides, mirror it so the menu sits on the
   true center; below that, maximum room still beats symmetry. */
@media (min-width:1360px){ .dc-menu{padding-left:calc(326px + var(--safe-l,0px))} }
@media (max-width:900px){
  .dc-menu{padding-top:calc(66px + var(--safe-t,0px));
    padding-bottom:calc(116px + var(--safe-b,0px))}
}
/* The picker is the headline on this screen; the wordmark yields to it. */
#ui[data-screen="menu"] .dc-mark{font-size:clamp(30px,4.6vw,52px)}
#ui[data-screen="menu"] .dc-tag{margin:6px 0 10px}
.dc-menu-inner{width:min(1080px,100%);padding:0 0 calc(106px + var(--safe-b,0px))}
.dc-select{margin-top:6px}
.dc-stats{margin-top:14px}
.dc-row{margin-top:12px}

/* A 900 px-tall laptop, minus 212 px of reserved ad gutter, leaves 688 px. The
   picker is designed for more than that, so on a short viewport it goes compact
   rather than pushing Play below the fold — the one thing a menu may never do.
   Higher specificity than the .dcm- rules on purpose: modeSelect injects its sheet
   after this one, so equal specificity would lose. */
@media (min-width:901px) and (max-height:1000px){
  #ui[data-screen="menu"] .dc-mark{font-size:clamp(26px,3.2vw,34px)}
  #ui[data-screen="menu"] .dc-tag{display:none}
  #ui .dcm-head h2{font-size:17px}
  #ui .dcm-head p{display:none}
  #ui .dcm-art{height:78px}
  #ui .dcm-art svg{width:96px;height:70px}
  #ui .dcm-tile{min-height:176px}
  #ui .dcm-tag{min-height:2.2em}
  #ui .dcm-panel-body{max-height:min(29vh,232px);min-height:110px}
  #ui .dcm-blurb{margin-bottom:8px}
  #ui .dcm{gap:10px}
  /* The shell's own strip below the picker gives up its height first: the
     control hints are printed in-game anyway, and the counters read fine small. */
  #ui[data-screen="menu"] .dc-note{display:none}
  #ui[data-screen="menu"] .dc-stats{margin-top:10px;gap:18px;font-size:10px}
  #ui[data-screen="menu"] .dc-stats b{font-size:15px}
  #ui[data-screen="menu"] .dc-row{margin-top:8px}
  #ui[data-screen="menu"] .dc-ghost{padding:6px 14px;font-size:12px}
}

/* A landscape phone: 412 px tall, one 320x50 banner reserved at the bottom and
   nothing else (see index.html). The picker already has a row-shaped tile
   layout for narrow screens; a short-and-wide screen wants the same shape for
   the opposite reason, so it borrows it. */
@media (max-height:560px){
  .dc-menu{padding:8px 16px 0;place-items:safe center}
  #ui[data-screen="menu"] .dc-note{display:none}
  .dc-menu-inner{padding-bottom:calc(62px + var(--safe-b,0px))}
  #ui[data-screen="menu"] .dc-mark,
  #ui[data-screen="menu"] .dc-tag,
  #ui[data-screen="menu"] .dc-stats,
  #ui .dcm-head{display:none}
  #ui .dcm{gap:8px}
  #ui .dcm-tile{flex-direction:row;min-height:0}
  #ui .dcm-art{height:auto;width:66px;flex:0 0 66px;border-bottom:0;
    border-right:1px solid rgba(255,255,255,.13)}
  #ui .dcm-art svg{width:52px;height:42px}
  #ui .dcm-body{padding:6px 8px;gap:2px}
  #ui .dcm-name{font-size:12px}
  #ui .dcm-tag{min-height:0;font-size:10px;line-height:1.25}
  #ui .dcm-save{padding-top:4px}
  #ui .dcm-save b{font-size:11px}
  #ui .dcm-save span{font-size:9.5px}
  #ui .dcm-panel-body{max-height:132px;min-height:52px}
  /* No room for the pitch, and the badge lands on top of the mode's own name
     once the tile is a row. Both are decoration here; the picker is not. */
  #ui .dcm-blurb,#ui .dcm-badge{display:none}
  /* Settings lives in the pause menu and the ad creative carries its own
     "Remove ads" button, so they are the first things worth 40 px. The locker
     stays: it is the only way into the avatar editor, and a landscape phone is
     still a phone that wants a marine of its own. */
  #ui[data-screen="menu"] .dc-row > :not(.dc-locker){display:none}
  #ui[data-screen="menu"] .dc-row{margin-top:6px}
}
/* The bar puts "Loading Terrain (100.00%)..." 180 px ABOVE its crosshair, on
   the aim line. This is the same fact 120 px BELOW it, matching the HUD's own
   --dc-drop (client/src/hud/hud.ts, the sightline budget): small, plated,
   letterspaced, and never over the pixels the player is aiming through.
   Renamed off .dc-status because that selector is unscoped and the HUD owns
   a .dc-status of its own — an unscoped rule reaching into #hud is exactly
   how a banner grows back onto the sightline by accident. */
.dc-boot-line{position:absolute;left:50%;top:calc(50% + 120px);transform:translateX(-50%);
  padding:4px 11px 5px;border-radius:2px;background:#08080b;color:#cfc9c3;
  border:1px solid rgba(255,255,255,.22);white-space:nowrap;pointer-events:none;
  font:700 11px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  text-transform:uppercase;letter-spacing:.22em;
  box-shadow:0 2px 10px rgba(0,0,0,.55);z-index:6}
.dc-boot-line[hidden]{display:none}
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
settings.controlScheme = asControlScheme(settings.controlScheme);
const progress: SaveProgress = loadJson<SaveProgress>(STORAGE_KEYS.progress, DEFAULT_PROGRESS as SaveProgress);

/**
 * The rows the player rebound by hand — sparse, and stored apart from
 * `settings` on `STORAGE_KEYS.bindings`. Its own key because a keymap and a
 * settings blob have different lifetimes: resetting one must not clear the
 * other, and this one carries no `version` field for `loadJson` to stamp.
 */
let customBindings: CustomBindings = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.bindings);
    return raw === null ? { primary: {}, alt: {} } : sanitiseCustomBindings(JSON.parse(raw));
  } catch {
    return { primary: {}, alt: {} };
  }
})();

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

/**
 * The avatar editor. Declared here, built further down once `#ui` exists, and
 * nullable only so `setScreen()` — which runs during boot — can safely ask it
 * to shut without tripping over its own initialisation order.
 */
let avatarEditor: AvatarEditor | null = null;

/**
 * The profile overlay. Same nullable-until-built discipline as the locker, and
 * for the same reason: `setScreen()` runs during boot and asks both of them to
 * shut before either exists.
 *
 * It is deliberately NOT a fifth `Screen` value. `boot/updates.ts` watches
 * `#ui[data-screen]` through a `MutationObserver` and can answer a change with
 * `location.reload()`; a profile screen wired into that machine would be a
 * profile screen that occasionally throws the player out of the menu.
 */
let profileScreen: ProfileScreen | null = null;

/**
 * Where the game server is, if anywhere.
 *
 * Empty on the shipped static build, and everything downstream is written so
 * that empty is a first-class answer rather than a failure: see
 * `client/src/net/serverConfig.ts` and `client/src/net/session.ts`.
 */
const serverUrl = resolveServerUrl();

/* The ad pipeline (docs/SPONSORS.md phase 1). Inert unless a server is
 * configured AND the server-resolved sponsor_slots switch is on AND ads are
 * not removed — in every other case the menu is byte-identical to before. */
const adPipeline = createAdPipeline({
  serverBase: serverUrl,
  deviceId: () => deviceId(),
  enabled: () => flagOn(game.net.flagBits, 'sponsor_slots'),
  adsRemoved: () => progress.adsRemoved || settings.showAds === false,
  platform: matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
});

/**
 * Declared before `new Game` on purpose.
 *
 * `Game.connect()` starts the boot session, and a LOCAL session settles
 * synchronously — the callback fires before `connect()` returns. Anything this
 * handler touches therefore has to already exist, or boot dies in a temporal
 * dead zone before the first frame. `onlineReady` is the same guard for the
 * menu strip, which is built further down.
 */
let sessionState: SessionState = {
  kind: 'local', url: '', reason: 'starting', fellBack: false, health: null,
};
let onlineReady = false;
/** The code the next Play will join with, or '' for public matchmaking. */
let pendingCode = '';

const game = new Game({
  canvas,
  hudRoot,
  settings,
  name: progress.name || 'Marine',
  avatar: save.profile.avatar >>> 0,
  seed: seedParam !== null ? Number(seedParam) >>> 0 : undefined,
  mode,
  modeId: bootParams.modeId,
  serverUrl,
  deviceId: deviceId(),
  bots: 8,
  enemies: 12,
  touch: forceTouch ? true : undefined,
  events: {
    onProgress: (p, label) => setBootProgress(p, label),
    onReady: () => onReady(),
    onDeath: () => { /* the HUD prints the prompt */ },
    onPauseRequested: () => openPause(),
    onSession: (state) => { onSessionState(state); },
    onStatus: (s, d) => {
      if (s === 'error') setBootProgress(0, `Error: ${d ?? 'unknown'}`);
    },
  },
});

// The scheme itself came in through `settings`; this hands over the rows the
// player pinned by hand, which outlive every scheme switch.
game.setCustomBindings(customBindings);

game.connect();

/* ------------------------------------------------------------------------ *
 * Online status
 *
 * One line of text and nothing else. The session decides where a match runs
 * (session.ts); this only reports it, because a player who is quietly playing
 * offline because a server was down deserves to know why the scoreboard has
 * bots in it.
 * ------------------------------------------------------------------------ */

function onSessionState(state: SessionState): void {
  sessionState = state;
  renderOnlineStatus();
}

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
  onModeChange: (m) => {
    pendingParams.modeId = m;
    /* Picking a mode is an unambiguous "public match of THIS mode". A join code
     * overrides the mode entirely server-side (a code names one room), so a
     * code left pending here would send the player somewhere they did not
     * choose — and the client-side mode layer would come up as Deathmatch over
     * a room the server is running as Quest. */
    if (pendingCode.length > 0) {
      pendingCode = '';
      if (onlineReady) codeInput.value = '';
      renderOnlineStatus();
    }
  },
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

/* ------------------------------------------------------------------------ *
 * The online strip
 *
 * Built ONLY when a server is configured. On the shipped static build
 * `serverUrl` is '' and none of this reaches the DOM, so the offline menu is
 * byte-for-byte what it was — no dead "Online" button that cannot work, no
 * request to a host that does not exist.
 *
 * What it does: report where the current session is, let a player paste a join
 * code, mint a private room, and list the rooms that have people in them. The
 * room list is a convenience; nothing here is on the path to playing, because
 * `/ws?mode=deathmatch` already lands in a live room with bots in it. See
 * server/src/directory.ts.
 * ------------------------------------------------------------------------ */

const onlineStrip = el('div', 'dc-online');
const onlineDot = el('i', 'dc-dot');
const onlineText = el('span', undefined, 'Offline');
const codeInput = document.createElement('input');
codeInput.className = 'dc-code';
codeInput.placeholder = 'CODE';
codeInput.maxLength = 10;
codeInput.spellcheck = false;
codeInput.autocomplete = 'off';
const roomsRow = el('div', 'dc-rooms');

function renderOnlineStatus(): void {
  if (!onlineReady) return;
  const s = sessionState;
  const kind = s.kind === 'remote' ? 'remote' : (s.fellBack ? 'down' : 'local');
  onlineStrip.dataset.kind = kind;
  const suffix = pendingCode.length > 0 ? ` · code ${pendingCode.toUpperCase()}` : '';
  onlineText.textContent = s.kind === 'remote'
    ? `Online — ${s.reason}${suffix}`
    : `${s.fellBack ? 'Offline — ' : 'Local — '}${s.reason}${suffix}`;
}

async function refreshRoomList(): Promise<void> {
  if (serverUrl.length === 0) return;
  let rows: RoomRow[] = [];
  try { rows = await listRooms(serverUrl); } catch { rows = []; }
  roomsRow.replaceChildren();
  const withPeople = rows.filter((r) => r.humans > 0).slice(0, 6);
  if (withPeople.length === 0) {
    roomsRow.appendChild(el('span', undefined, 'No one online yet — you will play against bots.'));
    return;
  }
  for (const r of withPeople) {
    const b = button(`${r.mode} · ${r.humans}/${r.maxPlayers}`, 'dc-room', () => {
      pendingCode = '';
      codeInput.value = '';
      const id = r.modeId;
      if (isModeId(id)) {
        pendingParams.modeId = id;
        pendingParams.levelId = r.levelId;
        pendingParams.worldId = r.worldId;
        pendingParams.skill = r.skill;
      }
      void startMode(pendingParams);
    });
    if (!r.open) b.disabled = true;
    roomsRow.appendChild(b);
  }
}

if (serverUrl.length > 0) {
  onlineStrip.append(onlineDot, onlineText, codeInput);
  onlineStrip.appendChild(button('Join code', 'dc-ghost', () => { void joinByCode(); }));
  onlineStrip.appendChild(button('Create private', 'dc-ghost', () => { void makePrivateRoom(); }));
  onlineStrip.appendChild(button('Refresh', 'dc-ghost', () => { void refreshRoomList(); }));
  menuInner.appendChild(onlineStrip);
  menuInner.appendChild(roomsRow);
  onlineReady = true;
  renderOnlineStatus();
  void refreshRoomList();
}

/**
 * Resolve a typed code BEFORE opening a socket, so a typo is a sentence in the
 * menu rather than a failed connection behind a spinner.
 */
async function joinByCode(): Promise<void> {
  const typed = codeInput.value.trim();
  if (typed.length === 0) return;
  onlineText.textContent = 'Looking up that code…';
  const ticket = await resolveCode(serverUrl, typed);
  if (ticket === null) {
    onlineText.textContent = 'No room with that code.';
    return;
  }
  pendingCode = ticket.code ?? typed;
  if (isModeId(ticket.modeId)) pendingParams.modeId = ticket.modeId;
  pendingParams.levelId = ticket.levelId;
  pendingParams.worldId = ticket.worldId;
  renderOnlineStatus();
  void startMode(pendingParams);
}

/** Mint a code for friends. Nothing is built server-side until one joins. */
async function makePrivateRoom(): Promise<void> {
  onlineText.textContent = 'Creating a private room…';
  const made = await createPrivateRoom(serverUrl, {
    modeId: pendingParams.modeId,
    levelId: pendingParams.levelId,
    worldId: pendingParams.worldId,
    skill: pendingParams.skill,
  });
  if (made === null) {
    onlineText.textContent = 'Could not create a private room.';
    return;
  }
  pendingCode = made.code;
  codeInput.value = made.code.toUpperCase();
  renderOnlineStatus();
  onlineText.textContent = `Private room ${made.code.toUpperCase()} — share the code, then press Play.`;
}

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
const lockerBtn = button('', 'dc-ghost dc-locker', () => openLocker());
const lockerDot = el('i');
const lockerLabel = el('span', undefined, 'Locker');
lockerBtn.append(lockerDot, lockerLabel);
menuRow.appendChild(lockerBtn);
menuRow.appendChild(button('Profile', 'dc-ghost', () => { void openProfile(); }));
menuRow.appendChild(button('Settings', 'dc-ghost', () => openSettings('menu')));
const removeAdsBtn = button(`Remove ads — $${IAP_PRICE_USD.toFixed(2)}`, 'dc-ghost', () => purchaseRemoveAds());
menuRow.appendChild(removeAdsBtn);
menuInner.appendChild(menuRow);

menuInner.appendChild(el(
  'p', 'dc-note',
  'WASD or arrows move · Shift sprint · Space jump · LMB fire · RMB place a block'
  + ' · B build mode · Esc menu — classic Doom keys in Settings › Control scheme',
));

uiRoot.appendChild(menu);

/* ------------------------------------------------------------------------ *
 * The locker — `client/src/ui/avatarEditor.ts`
 *
 * Built once and kept, but it owns no GPU resources while closed: its preview
 * context, scene and animation frame are created by `open()` and destroyed by
 * `close()`. Every tweak writes straight through to the schema-versioned save
 * AND to the live connection, so the look survives a hard refresh and the other
 * players in the room see the change without a reconnect.
 * ------------------------------------------------------------------------ */

function refreshLockerButton(): void {
  const cfg = unpackAvatar(save.profile.avatar);
  lockerLabel.textContent = avatarButtonLabel(save.profile.avatar);
  // The dot wears the accent — the colour that dresses the torso and arms, and
  // therefore the one you actually read across an arena.
  const hex = AVATAR_PALETTE[cfg.accent].hex;
  lockerDot.style.background = `#${hex.toString(16).padStart(6, '0')}`;
}

avatarEditor = createAvatarEditor({
  root: uiRoot,
  initial: save.profile.avatar,
  onChange: (packed, cfg) => {
    writeAvatar(save, cfg);
    flushSave();
    game.setAvatar(packed, legacySkinFromAvatar(cfg));
    refreshLockerButton();
  },
  onClose: () => {
    modeSelect.setSave(save);
    refreshLockerButton();
  },
});

function openLocker(): void {
  // Two overlays at z-index 5 would stack; the second one to open wins the
  // clicks and the first keeps a GL context alive behind it.
  profileScreen?.close();
  avatarEditor?.setAvatar(save.profile.avatar);
  avatarEditor?.open();
}

refreshLockerButton();


/* ------------------------------------------------------------------------ *
 * The profile — `client/src/ui/profile.ts`
 *
 * Everything it shows is already in this scope: `save` is the schema-versioned
 * per-mode document, `progress` is the legacy flat blob that holds the only
 * live counters, and the balances are whatever the SERVER last granted this
 * session. There is no new plumbing and no new storage key.
 *
 * `inputs` is a callback rather than a value because both of those move while
 * the overlay is shut. `remote` is null and stays null until C4 binds an
 * account: this build talks to no host for a profile, and the model renders
 * that as a sentence rather than as a row of zeroes.
 * ------------------------------------------------------------------------ */

function profileInputs(): ProfileInputs {
  return {
    save,
    progress,
    remote: null,
    liveBalance: { xp: game.net.balanceXp, scrap: game.net.balanceScrap },
    // The same `economyProduct` the HUD chips read, not a second `isEnabled`
    // call — one surface deciding differently from another is the bug.
    economyProduct: game.economyProduct,
    flagBits: game.net.flagBits,
    // No CredentialProvider is bound on this build. The model renders that as
    // a sentence; it is the true answer, not a placeholder.
    account: null,
    nowMs: Date.now(),
  };
}

/** In flight, so a double-click builds one overlay rather than two. */
let profileLoading: Promise<ProfileScreen> | null = null;

async function openProfile(): Promise<void> {
  // Two overlays at z-index 5 would stack; the second to open wins the clicks
  // and the first keeps its resources alive behind it.
  avatarEditor?.close();
  if (profileScreen === null) {
    profileLoading ??= import('@/ui/profile')
      .then((m) => m.createProfileScreen({ root: uiRoot!, inputs: profileInputs }));
    try {
      profileScreen = await profileLoading;
    } catch {
      // A chunk that will not load is not a crash. The player is on the menu
      // with a button that did nothing, which is recoverable; a thrown promise
      // out of a click handler is not.
      profileLoading = null;
      return;
    }
  }
  profileScreen.open();
}


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

/**
 * `labels` is optional: without it the option text is the value, which is what
 * every existing row wants ('low' / 'medium' / 'high'). The control scheme is
 * the first row that needs a human name over a stored id, so it passes one
 * rather than growing a second select builder.
 */
function addSelect(
  label: string, options: string[], get: () => string, set: (v: string) => void,
  labels?: Readonly<Record<string, string>>, after?: () => void,
): void {
  setGrid.appendChild(el('label', undefined, label));
  const sel = el('select');
  for (const o of options) {
    const opt = el('option', undefined, labels?.[o] ?? o);
    opt.value = o;
    sel.appendChild(opt);
  }
  sel.value = get();
  sel.addEventListener('change', () => { set(sel.value); applySettings(); after?.(); });
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

/* --- the keyboard ------------------------------------------------------- *
 * The owner played the live build and said the keyboard navigation was off and
 * "should be like the classic games". Two things were true: the arrow keys were
 * bound to nothing at all, and there was no way to ask for DOOM's layout, where
 * Left/Right TURN rather than strafe.
 *
 * The scheme select drives the alt binding layer only, so WASD and mouselook
 * are identical under both and switching can never strand anyone. Every row
 * below can still be rebound on top of a scheme, and a row you rebind is pinned
 * — the next scheme switch leaves it exactly where you put it.
 * ---------------------------------------------------------------------- */
addSelect('Control scheme', [...CONTROL_SCHEMES],
  () => settings.controlScheme,
  (v) => { settings.controlScheme = asControlScheme(v); },
  SCHEME_LABELS, () => { refreshSchemeNote(); refreshBindRows(); });

const schemeNote = el('p', 'dc-note');
setGrid.appendChild(schemeNote);
function refreshSchemeNote(): void {
  schemeNote.textContent = SCHEME_NOTES[settings.controlScheme];
}
refreshSchemeNote();

const keyNote = el('p', 'dc-note');
keyNote.innerHTML = 'Left column is the <b>primary</b> key — the same under both schemes.'
  + ' Right is the <b>second</b> key, the one the scheme sets.'
  + ' Click either to rebind, <b>Esc</b> to cancel, right-click to clear.';
setGrid.appendChild(keyNote);

/**
 * One row per action: the primary key, then the key the scheme adds.
 *
 * `Menu` is deliberately absent. Escape is the only way out of a pointer-locked
 * game and out of a half-finished rebind, and a player who binds it to a key
 * they then forget has no way back.
 */
const BIND_ROWS: ReadonlyArray<readonly [InputAction, string]> = Object.freeze([
  [InputAction.MoveForward, 'Move forward'],
  [InputAction.MoveBack, 'Move back'],
  [InputAction.MoveLeft, 'Strafe left'],
  [InputAction.MoveRight, 'Strafe right'],
  [InputAction.TurnLeft, 'Turn left'],
  [InputAction.TurnRight, 'Turn right'],
  [InputAction.StrafeMod, 'Strafe modifier'],
  [InputAction.Jump, 'Jump'],
  [InputAction.Crouch, 'Crouch'],
  [InputAction.Sprint, 'Run'],
  [InputAction.Fire, 'Fire'],
  [InputAction.AltFire, 'Place block'],
  [InputAction.Reload, 'Reload'],
  [InputAction.Use, 'Use / open'],
  [InputAction.Melee, 'Melee'],
  [InputAction.BuildMode, 'Build mode'],
  [InputAction.NextWeapon, 'Next weapon'],
  [InputAction.PrevWeapon, 'Previous weapon'],
  [InputAction.Slot1, 'Weapon 1'],
  [InputAction.Slot2, 'Weapon 2'],
  [InputAction.Slot3, 'Weapon 3'],
  [InputAction.Slot4, 'Weapon 4'],
  [InputAction.Slot5, 'Weapon 5'],
  [InputAction.Slot6, 'Weapon 6'],
  [InputAction.Slot7, 'Weapon 7'],
  [InputAction.Chat, 'Chat'],
  [InputAction.Scoreboard, 'Scoreboard'],
  [InputAction.Map, 'Map'],
]);

/** Every key button on screen, so a rebind can redraw the row it stole from. */
const bindButtons: Array<{ btn: HTMLButtonElement; action: InputAction; layer: BindingLayer }> = [];

/**
 * A rebind ends on a MOUSE press as often as a key press, and the `click` that
 * follows that press lands right back on the button that armed it. Without a
 * short deadline, binding Fire to Mouse 1 immediately re-arms the same row and
 * the panel never lets go.
 */
let rebindSettledAt = 0;

function refreshBindRows(): void {
  for (const row of bindButtons) drawKeyButton(row.btn, row.action, row.layer);
}

function drawKeyButton(btn: HTMLButtonElement, action: InputAction, layer: BindingLayer): void {
  const code = game.input.binding(action, layer);
  btn.textContent = bindingLabel(code);
  btn.className = 'dc-key'
    + (code === '' ? ' empty' : '')
    + (layer === 'alt' ? ' scheme' : '');
  btn.title = layer === 'alt'
    ? 'Second key — the control scheme fills this in'
    : 'Primary key';
}

/** Pin one row so every future scheme switch leaves it alone. */
function pinBinding(action: InputAction, code: string, layer: BindingLayer): void {
  const next: CustomBindings = {
    primary: { ...(customBindings.primary ?? {}) },
    alt: { ...(customBindings.alt ?? {}) },
  };
  const pins = (layer === 'alt' ? next.alt : next.primary) as Record<string, string>;
  pins[action] = code;
  customBindings = next;
  game.setCustomBindings(customBindings);
  saveJson(STORAGE_KEYS.bindings, customBindings);
}

function keyButton(action: InputAction, layer: BindingLayer): HTMLButtonElement {
  const btn = el('button', 'dc-key');
  btn.type = 'button';
  drawKeyButton(btn, action, layer);
  bindButtons.push({ btn, action, layer });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (performance.now() - rebindSettledAt < 250) return;
    if (game.input.rebinding) { game.input.cancelRebind(); refreshBindRows(); return; }
    btn.className = 'dc-key listening';
    btn.textContent = 'Press…';
    // `code === ''` is the cancel path — Escape, which must not pin anything.
    game.input.beginRebind(action, layer, (a, code, l) => {
      rebindSettledAt = performance.now();
      if (code !== '') pinBinding(a, code, l);
      refreshBindRows();
    });
  });

  // Right-click clears the row, and pins the clear so a scheme switch does not
  // quietly hand the key back.
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (game.input.rebinding) game.input.cancelRebind();
    pinBinding(action, '', layer);
    refreshBindRows();
  });
  return btn;
}

for (const [action, label] of BIND_ROWS) {
  setGrid.appendChild(el('label', undefined, label));
  const keys = el('span', 'dc-keys');
  keys.append(keyButton(action, 'primary'), keyButton(action, 'alt'));
  setGrid.appendChild(keys);
}

setGrid.appendChild(button('Reset controls', 'dc-row-btn', () => {
  if (game.input.rebinding) game.input.cancelRebind();
  customBindings = { primary: {}, alt: {} };
  game.setCustomBindings(customBindings);
  saveJson(STORAGE_KEYS.bindings, customBindings);
  refreshBindRows();
}));

/* --- the audio mix ------------------------------------------------------ *
 * `save.audio` is the versioned home of the five volumes, the mute-on-blur rule
 * and the threat-indicator setting; the v3 -> v4 migration carried across the
 * three volume fields `GameSettings` had been storing, unread, since the spine
 * was written. The mixer pushes them at the engine and owns the focus rule.
 * --------------------------------------------------------------------- */
const audioMixer = new AudioMixer(game.audio, save.audio);
/* One owner for the focus rule. `visibilitychange` below no longer touches the
   engine: hidden always suspends (battery), blurred-but-visible suspends only
   when the player left "Mute when unfocused" on, and both decisions live in one
   place instead of being half here and half in the mixer. */
audioMixer.attach(window, document);

/* Audio and Accessibility.
 *
 * `mountAudioSettings` does not build any DOM: it is handed the four builders
 * this panel already has and calls them, so the audio rows are the same grid,
 * the same styling and the same save path as the mouse sensitivity. Building a
 * second settings surface for audio would be a second place to look and a
 * second style to drift. */
mountAudioSettings({
  section: addSection,
  slider: addSlider,
  toggle: addToggle,
  select: addSelect,
}, () => save.audio);

addSection('Display');
addSlider('Field of view', FOV_MIN, FOV_MAX, 1,
  () => settings.fov, (v) => { settings.fov = v; }, (v) => `${v.toFixed(0)}°`);
addSlider('Render distance', RENDER_DISTANCE_MIN, RENDER_DISTANCE_MAX, 1,
  () => settings.renderDistance, (v) => { settings.renderDistance = v; }, (v) => `${v.toFixed(0)}`);
addSlider('Render scale', 0.5, 1.25, 0.05,
  () => settings.renderScale, (v) => { settings.renderScale = v; }, (v) => `${Math.round(v * 100)}%`);
addSelect('Quality', ['low', 'medium', 'high'],
  () => settings.quality, (v) => { settings.quality = v as QualityPreset; });
addSelect('Surface detail', ['off', 'low', 'full'],
  () => settings.surfaceDetail, (v) => { settings.surfaceDetail = v as SurfaceDetailPreset; });
addToggle('Ambient occlusion', () => settings.ao, (v) => { settings.ao = v; });
addToggle('Fog', () => settings.fog, (v) => { settings.fog = v; });
addToggle('FPS counter', () => settings.fpsCounter, (v) => { settings.fpsCounter = v; });

/* Touch controls.
 *
 * Only built when the pad exists, so a desktop settings screen does not grow a
 * section about thumbs. The bar's mobile pause menu is three plain buttons —
 * Resume / Settings / Leave — with nothing about the controls in it at all
 * (ref/BAR.md), and it has no handedness, no control size and no dead zone to
 * offer in the first place. Each of these writes through
 * `MobileControls.setPrefs`, which persists on its own key and re-solves the
 * layout immediately, so the change is visible behind the pause panel. */
if (game.mobile !== null) {
  const pad = game.mobile;
  addSection('Touch controls');
  addToggle('Left-handed', () => pad.prefs.southpaw, (v) => pad.setPrefs({ southpaw: v }));
  addSlider('Control size', 0.7, 1.4, 0.05,
    () => pad.prefs.scale, (v) => pad.setPrefs({ scale: v }), (v) => `${Math.round(v * 100)}%`);
  addSlider('Stick dead zone', 0, 0.4, 0.02,
    () => pad.prefs.deadZone, (v) => pad.setPrefs({ deadZone: v }),
    (v) => `${Math.round(v * 100)}%`);
  addSlider('Look speed', 0.4, 2.5, 0.05,
    () => pad.prefs.lookScale, (v) => pad.setPrefs({ lookScale: v }), (v) => `${v.toFixed(2)}x`);
  addToggle('Aim assist', () => pad.prefs.aimAssist, (v) => pad.setPrefs({ aimAssist: v }));
  addToggle('Auto fire', () => pad.prefs.autoFire, (v) => pad.setPrefs({ autoFire: v }));
  addToggle('Vibration', () => pad.prefs.haptics, (v) => pad.setPrefs({ haptics: v }));
}

addSection('Feel');
addSlider('Screen shake', 0, 1.5, 0.05,
  () => settings.screenShake, (v) => { settings.screenShake = v; }, (v) => `${Math.round(v * 100)}%`);
addToggle('View bob', () => settings.viewBob, (v) => { settings.viewBob = v; });
addSelect('Crosshair', ['cross', 'dot', 'doom', 'dynamic'],
  () => settings.crosshair, (v) => { settings.crosshair = v as CrosshairStyle; });
addToggle('Hit markers', () => settings.hitMarkers, (v) => { settings.hitMarkers = v; });



/* Admin.
 *
 * Online multiplayer is built but not finished, so it ships gated and the mode tiles say
 * "COMING SOON · 2026" instead of claiming a server that is not there. This switch opens the gate.
 *
 * It is a PRODUCT gate, not a security boundary — the override lives in localStorage and anyone
 * with devtools can flip it. That is acceptable here because the worst case is a player enabling a
 * mode that then finds no server and falls back to bots. Anything that grants rewards or spends
 * money is gated server-side instead (server/src/entitlementGuard.ts against shared/src/trust.ts).
 *
 * Toggling reloads, because the mode tiles, their taglines and the transport choice are all read
 * once at construction. A reload from the menu costs ~300 ms and is honest; re-plumbing every one
 * of those to be live-reactive for a switch used a handful of times would not pay.
 */
addSection('Admin');
addToggle('Online multiplayer',
  () => isEnabled(Feature.ONLINE_MULTIPLAYER),
  (on) => {
    setOverride(Feature.ONLINE_MULTIPLAYER, on);
    setOverride(Feature.SHARED_WORLDS, on);
    location.reload();
  });
/* The reward surfaces ship dark. This switch only decides whether the numbers are
 * SHOWN — the server decides whether they exist, twice over (the trust table, and the
 * `economy_scrap` kill switch it resolves per player). With this on and that off, the
 * chips stay hidden and that is the correct answer, not a bug. */
addToggle('Economy (points & scrap)',
  () => isEnabled(Feature.ECONOMY),
  (on) => {
    setOverride(Feature.ECONOMY, on);
    location.reload();
  });


const resumeBtn = button('Resume', 'dc-primary', () => closePause());
const menuBtn = button('Leave match', 'dc-ghost', () => backToMenu());
actions.append(resumeBtn, menuBtn);

/**
 * Deferred save write.
 *
 * A range input fires `input` on every pixel of a drag, and `SaveFile` is the
 * whole document — profile, six campaign slots, twenty-four builder worlds and
 * their records. Serialising all of that on every pointer move to persist a
 * volume slider is a stutter you can feel in the panel. The mix reaches the
 * ENGINE immediately (five gain writes, free); only the localStorage write
 * waits for the drag to stop.
 */
let saveFlushTimer: ReturnType<typeof setTimeout> | null = null;
function flushSaveSoon(): void {
  if (saveFlushTimer !== null) clearTimeout(saveFlushTimer);
  saveFlushTimer = setTimeout(() => { saveFlushTimer = null; flushSave(); }, 400);
}

function applySettings(): void {
  game.applySettings(settings);
  saveJson(STORAGE_KEYS.settings, settings);
  // The mix lives in the versioned save, not in the settings blob.
  audioMixer.apply(save.audio);
  game.setAudioSettings(save.audio);
  flushSaveSoon();
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
const statusLine = el('div', 'dc-boot-line');
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
/*
 * THE SERVER'S FLAGS, ADOPTED. Step 3 of the resolution order in
 * `shared/src/features.ts` — "the server's flag payload, when online" — has
 * never executed in a shipped build: `applyServerFlags` had zero callers
 * repo-wide, and it took a record keyed by `Feature` ids while the only
 * producer handed back one keyed by `FLAG_ORDER` names. This is the call, and
 * `featureFlagsFromBits` is the bridge.
 *
 * Here rather than in a fetch on boot because the bits are already on a packet
 * this client was going to receive anyway — 4 bytes on `S2C.SESSION_CONFIG` —
 * so wiring it costs no request. It is deliberately NOT a kill switch: a
 * player's own localStorage override still beats it, by design, because these
 * are product gates. Anything that grants value is gated a second time on the
 * server-resolved bits (`economySurfacesOn`), which no browser can override.
 */
game.net.events.onSessionConfig = (config) => {
  applyServerFlags(featureFlagsFromBits(config.flags));
};
game.net.events.onModeState = (state) => { registry.dispatchState(state); };
game.net.events.onModeEvent = (event) => { registry.dispatchEvent(event); };
game.net.events.onModeContext = (context) => {
  registry.dispatchContext(context);
  /* Atmosphere for the three modes that do not have an authored level.
   *
   * NOT from `ModeContextMessage`. Its skyColor/fogColor/ambient fields read
   * like the palette and are not one: `server/src/room.ts` fills them with the
   * mode's UI ACCENT colour and a hard-coded ambient of 0.6, which made every
   * mode measure as maximally hot and maximally bright. The real look of a
   * non-Quest mode is `MODE_PALETTES`, which is what the renderer is actually
   * showing, so that is what the bed is told.
   *
   * Quest is excluded on purpose. Its level lives on the client and
   * `modes/quest/quest.ts` hands the audio layer the authored `LevelMeta`
   * directly, including the `musicCue` the wire has no field for. */
  if (context.modeId === ModeId.QUEST) return;
  const p = MODE_PALETTES[MODE_KEYS[context.modeId]] ?? DEFAULT_PALETTE;
  game.setLevelAudio(
    { skyTop: p.skyZenith, fogColor: p.fog, ambient: p.ambient, fogFar: game.fogFarMetres },
    context.modeId,
    '',
  );
};

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
  // The locker is an overlay above every screen, so nothing else can be trusted
  // to have taken it down. Leaving it up would keep a second GL context alive
  // for the whole match.
  if (s !== 'menu') { avatarEditor?.close(); profileScreen?.close(); }
  uiRoot!.dataset.screen = s;
  if (adsRoot !== null) {
    const mode = settings.showAds === false || progress.adsRemoved
      ? 'off'
      : s === 'playing' ? 'game' : 'menu';
    adsRoot.dataset.mode = mode;
    if (mode === 'menu') adPipeline.onMenuEnter();
    else adPipeline.onMenuExit();
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

  const wantsRemote = game.session.prefersRemote({
    modeId: p.modeId,
    worldId: p.worldId,
    code: pendingCode.length > 0 ? pendingCode : undefined,
  });
  modeSelect.setBusy(
    true,
    wantsRemote ? 'Finding a match…' : `Starting ${getMode(p.modeId).name}…`,
  );

  /* --- pick the room this mode plays in -------------------------------- *
   * The only await between the click and the match, and it is skipped
   * entirely for the offline build (`prefersRemote` is false with no server
   * configured, so `enterSession` returns without touching the network) and
   * for a mode that was already local. When it does run, the health answer is
   * normally already cached from boot — see `GameSession.checkServer`.
   *
   * It cannot reject: an unreachable server resolves as a local session, which
   * is a real match against bots, not an error screen.
   * -------------------------------------------------------------------- */
  const kind = await game.enterSession({
    modeId: p.modeId,
    levelId: p.levelId,
    worldId: p.worldId,
    skill: p.skill,
    code: pendingCode.length > 0 ? pendingCode : undefined,
    seed: p.seed,
    allWeapons: true,
  });
  /* A code that WORKED is kept, so leaving to the menu and pressing Play again
   * rejoins the same friends. A code that landed us in the Worker room did not
   * work — the room is gone, or the server is — and keeping it would make every
   * later Play retry a dead room. */
  if (kind === 'local') pendingCode = '';

  setScreen('playing');
  game.enterPlay();
  registry.setPaused(false);

  // The last mode's kill feed is not this mode's news.
  game.hud.clearFeed();

  /* Tell the room before the mode comes up. Three of the four modes also send
   * their own `SELECT` from `enter()`; that duplicate is free (the room only
   * re-streams the world when the mode id actually changes), and doing it here
   * as well is what covers the fourth — and any mode added later that forgets.
   *
   * On a REMOTE session the room was already chosen from the socket URL and is
   * locked (`RoomOptions.lockMode`), so this `SELECT` cannot reconfigure a room
   * full of other players — the server answers it with the room's real context
   * and changes nothing. It still matters: that context reply is how the mode
   * layer learns which level it is standing in. */
  announceMode(pendingParams);

  try {
    await registry.activate(pendingParams);
  } finally {
    modeSelect.setBusy(false);
  }
  // After activate, never before: activate() tears the previous mode down
  // first, and a teardown that restores the shared palette would otherwise
  // land on top of the incoming mode's. Quest is skipped here — it sets sky,
  // fog and ambient per level from its own LevelMeta during activate.
  applyModePalette(game, MODE_KEYS[pendingParams.modeId] ?? '');
  registry.resize(canvas!.clientWidth, canvas!.clientHeight);
}

/** Resume the mode that is already active, or start the pending one. */
function startPlaying(): void {
  // The touch pad stays drawn behind the pause panel (see MobileControls.
  // setPaused); hand it back to the HUD before the match takes it live again.
  game.mobile?.setPaused(false);
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
  // `leavePlay` is also the road to the main menu, so it hides the pad
  // unconditionally. Only the shell knows this particular exit is a pause, and
  // on a phone the controls must survive it — the bar keeps its whole control
  // surface drawn behind its own pause panel, and a frame of ours with no
  // trigger in it cannot answer "which can you aim and shoot with".
  game.mobile?.setPaused(true);
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
  game.mobile?.setPaused(false);   // no thumbs on the main menu
  host.setStatus('');
  await registry.deactivate();
  // The world keeps rendering behind the menu, so it must not keep the last
  // mode's grade — including whatever the hurt flash was holding when we left.
  applyPalette(game, DEFAULT_PALETTE);
  progress.level = levelForXp(progress.xp);
  saveJson(STORAGE_KEYS.progress, progress);
  save = loadSave(saveStorage, Date.now());
  modeSelect.setSave(save);
  if (serverUrl.length > 0) void refreshRoomList();
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
    if (avatarEditor?.isOpen === true) { avatarEditor.close(); e.preventDefault(); }
    // Before `openPause()`, or an overlay opened over a running match cannot be
    // dismissed at all: Escape would pause the game behind it and leave it up.
    else if (profileScreen?.isOpen === true) { profileScreen.close(); e.preventDefault(); }
    else if (game.playing) { openPause(); e.preventDefault(); }
    else if (uiRoot!.dataset.screen === 'paused') { closePause(); e.preventDefault(); }
    return;
  }
  if (!game.ready) return;
  // Space is "start the match" on the menu, and it must not fire through an
  // open locker — the player is pressing buttons in a dialog, not queueing up.
  if (avatarEditor?.isOpen === true || profileScreen?.isOpen === true) return;
  if (uiRoot!.dataset.screen === 'menu' && (e.code === 'Enter' || e.code === 'Space')) {
    startPlaying();
    e.preventDefault();
  }
});

/* ------------------------------------------------------------------------ *
 * Audio unlock
 *
 * Browsers will not let a page make noise until the user has interacted with
 * it. An AudioContext constructed outside a gesture comes up `suspended` on
 * Chrome and on iOS Safari and never starts on its own, so a game that builds
 * one at boot is permanently silent with nothing in the console to say why.
 *
 * So: no context exists until one of these fires. All three input families are
 * covered because we cannot know which one the player will use first — a
 * desktop player clicks, a phone player touches, and a player who tabs in and
 * presses Space to start would otherwise reach the match before audio existed.
 *
 * Registered in the CAPTURE phase so a handler that stops propagation (the
 * pause menu, the avatar editor) cannot swallow the unlock, and `once` is NOT
 * used: iOS can drop a context again when the app is backgrounded through the
 * app switcher, and `unlockAudio()` is idempotent and cheap, so letting every
 * gesture re-assert it is the robust choice rather than a wasteful one.
 * ------------------------------------------------------------------------ */

const unlockAudio = (): void => {
  game.unlockAudio();
  // Push the saved mix the moment the graph exists; the engine's own defaults
  // are not the player's.
  audioMixer.apply(save.audio);
  game.setAudioSettings(save.audio);
};
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('touchstart', unlockAudio, { capture: true, passive: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

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
  if (avatarEditor?.isOpen === true || profileScreen?.isOpen === true) return;
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

/* ------------------------------------------------------------------------ *
 * The net pump is NOT the frame loop
 *
 * `frame()` above is the only thing that calls `game.tick`, and `game.tick` is
 * the only thing that calls `net.update` — so every packet this client sends
 * used to be paced by `requestAnimationFrame`. A hidden tab throttles rAF to
 * ~1 Hz and stops it outright when the tab is occluded, and the server drops a
 * connection it has not heard from for CLIENT_TIMEOUT_MS (15 s). Alt-tab for
 * fifteen seconds and you lost the match.
 *
 * The keepalive now runs on a clock the frame loop does not own — a Worker
 * timer with a page interval beside it, started by `NetClient.connect()` (see
 * `client/src/net/client.ts`, "Keepalive"). The frame loop is untouched.
 *
 * The two edges are wired here because only the page can see them:
 *
 *   hidden   send a keepalive NOW, so the server's 15 s window restarts at the
 *            moment the tab goes away rather than up to a second later.
 *   visible  re-sync before the first frame back. Without this the client
 *            would come back holding a stale clock offset and interpolation
 *            rings older than MAX_EXTRAPOLATE_MS, and would spend its first
 *            frames replaying accumulated input the player never gave.
 * ------------------------------------------------------------------------ */

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    game.net.keepaliveTick(true);
    // The audio side of this is `audioMixer`'s: it listens for the same event
    // and suspends the context, because "hidden" and "unfocused" are two rules
    // that must not be decided in two places.
    return;
  }
  game.net.resumeFromBackground();
  // The frame clock must not see the whole absence as one delta.
  lastFrameMs = 0;
  modeAccumulator = 0;
  // Some browsers cancel a pending rAF callback when a tab is occluded rather
  // than merely throttling it. Re-arm on the way back, or the loop is dead.
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
});

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(raf);
  game.net.keepaliveTick(true);
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
  /** The avatar editor, for tools/capture-ours.mjs and the leak assertion. */
  openLocker(): void { openLocker(); },
  closeLocker(): void { avatarEditor?.close(); },
  get lockerOpen(): boolean { return avatarEditor?.isOpen === true; },
  /** The profile overlay, for tools/capture-ours.mjs. */
  openProfile(): Promise<void> { return openProfile(); },
  closeProfile(): void { profileScreen?.close(); },
  get profileOpen(): boolean { return profileScreen?.isOpen === true; },
  /** What the overlay is currently showing. Read-only; never a recovery code. */
  profileView(): unknown { return profileScreen?.view ?? null; },
  get avatar(): number { return save.profile.avatar >>> 0; },
  setAvatarPacked(v: number): void {
    avatarEditor?.setAvatar(v >>> 0);
    save.profile.avatar = v >>> 0;
    flushSave();
    refreshLockerButton();
  },

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
  /** Voice-pool and bake telemetry, for `tools/audio-bench.mjs`. */
  audioStats(): Record<string, number | string | boolean> {
    return { ...game.audio.stats(), bakeProgress: +game.sfx.bakeProgress.toFixed(3) };
  },
  /**
   * Bench hook: keep every scheduling call and every voice allocation, but
   * synthesise nothing. This is what makes the A/B in `tools/audio-bench.mjs`
   * honest — it isolates the MAIN-THREAD cost of the audio layer from the
   * cost of the audio thread actually making sound.
   */
  audioSilence(on: boolean): void { game.audio.setSilent(on); },
  /**
   * Measure the MAIN-THREAD cost of starting `n` voices through the real
   * graph — the number the whole engine design turns on.
   *
   * Deliberately unthrottled and unspaced, so the pool saturates after the
   * first `cap` calls and every subsequent call also pays for a steal. That is
   * the worst case, not the typical one.
   */
  audioVoiceCost(n: number): Record<string, number | string> {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) game.sfx.weaponFire(1);
    const ms = performance.now() - t0;
    const st = game.audio.stats();
    return {
      calls: n,
      totalMs: +ms.toFixed(3),
      usPerVoice: +((ms * 1000) / n).toFixed(2),
      stolen: st.stolen,
      peakActive: st.peakActive,
      cap: st.cap,
    };
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
      audioVoices: game.audio.activeVoices(),
      onePctLowFps: game.renderer.stats.onePercentLowFps(),
      charDraws: game.characterStats().draws,
      charInstances: game.characterStats().instances,
      charBodies: game.characterStats().bodies,
      rigReady: game.characterStats().rigReady,
      ready: game.ready,
      playing: game.playing,
    };
  },
  /**
   * The three world-audio layers, for `tools/audio-world-bench.mjs`.
   *
   * Kept separate from `stats()` so the frame-cost numbers stay a flat record
   * of numbers and the harness that reads them does not have to learn a shape.
   */
  /**
   * Force the accessibility setting from the harness.
   *
   * `tools/`-side verification of the threat indicator needs it on regardless
   * of whether the cue was audible, and a harness that clicks through a
   * settings panel to get there is a harness that breaks when the panel moves.
   */
  setThreatCues(v: 'off' | 'auto' | 'on'): void {
    save.audio.threatCues = v;
    game.setAudioSettings(save.audio);
    flushSaveSoon();
  },
  /** Bench control: turn the three world-audio layers off without a rebuild. */
  audioWorldEnabled(on: boolean): void {
    game.worldAudioEnabled = on;
    if (!on) { game.music.stop(); game.ambience.stop(); game.monsters.stopAll(); }
  },
  audioWorld(): Record<string, number | string> {
    const a = game.ambience.atmosphere;
    return {
      monsterVoices: game.monsters.voiceCount,
      monsterPlayed: game.monsters.played,
      monsterSuppressed: game.monsters.suppressed,
      monsterBakeMs: game.monsters.bakeMs,
      ambienceBakes: game.ambience.bakes,
      ambienceBakeMs: game.ambience.bakeMs,
      heat: Number(a.heat.toFixed(3)),
      dark: Number(a.dark.toFixed(3)),
      room: Number(a.room.toFixed(3)),
      musicTrack: game.music.currentTrack?.id ?? '-',
      musicTier: game.music.currentTier,
      musicThreat: Number(game.music.currentThreat.toFixed(3)),
      musicScheduled: game.music.scheduled,
      musicSounded: game.music.sounded,
      musicBakeMs: game.music.bakeMs,
    };
  },
};


/* ------------------------------------------------------------------------ *
 * Client delivery — the service worker, and the one rule it obeys
 *
 *   > Never activate a new bundle while `game.playing === true`.
 *
 * Answered here with the superset `game.playing || screen === 'paused'`, since
 * `openPause()` calls `leavePlay()` and the match behind the pause menu is
 * still running. Stronger than the rule, never weaker.
 *
 * docs/INFRASTRUCTURE.md §6, and docs/PATCHING.md for the whole procedure. The
 * policy lives in `client/src/boot/updates.ts` and is tested there; this is the
 * mount, and it is deliberately the last thing in the file so that nothing the
 * game needs can ever be blocked behind it.
 *
 * It hooks nothing in the shell. `#ui[data-screen]` is already the shell's
 * published state (docs/CONTRACT.md §6), so observing that attribute tells the
 * controller when the player left a match without a single call site having to
 * remember to say so — and a call site that forgets is exactly how a rule like
 * this rots.
 * ------------------------------------------------------------------------ */

const updates = installUpdates({
  /*
   * "In a match", which is a bigger set than `game.playing`.
   *
   * `openPause()` calls `game.leavePlay()`, so `game.playing` is false the
   * whole time the pause menu is up — and the match behind it is still running,
   * still on the server, still costing the player the round if the tab
   * reloads. The rule is never to swap under a player who is in a match, so the
   * predicate has to be the superset. It is still strictly stronger than
   * "`game.playing === true`": everything that rule refuses, this refuses too.
   */
  isPlaying: () => game.playing || uiRoot!.dataset.screen === 'paused',
  /*
   * With the prompt off the controller applies the update itself at the next
   * safe moment rather than waiting for a button nobody can press. See
   * `UpdateHost.promptAllowed`.
   */
  promptAllowed: () => game.net.flag('client_update_prompt'),
  onState: (state) => { renderUpdatePrompt(state); },
});

let updateCard: HTMLDivElement | null = null;

function renderUpdatePrompt(state: UpdateSnapshot): void {
  // The prompt itself is behind a flag (`client_update_prompt`, a CONTROL flag
  // shipped ON), so a release that ships a broken card can have it taken away
  // without a deploy. The SWAP is not behind the flag: with the prompt off
  // `UpdateController.pump()` applies the update itself at the next safe
  // moment, so the player is not asked rather than not updated.
  const show = shouldPromptUpdate(
    state,
    game.net.flag('client_update_prompt'),
    uiRoot!.dataset.screen ?? '',
  );

  if (!show) {
    updateCard?.remove();
    updateCard = null;
    return;
  }
  if (updateCard !== null) return;

  const card = el('div', 'dc-update');
  card.style.position = 'absolute';
  card.style.right = '16px';
  card.style.bottom = '16px';
  card.style.zIndex = '30';
  card.style.display = 'flex';
  card.style.gap = '10px';
  card.style.alignItems = 'center';
  card.style.padding = '10px 12px';
  card.style.borderRadius = '8px';
  card.style.background = 'var(--panel)';
  card.style.border = '1px solid var(--line)';
  card.style.font = '13px/1.3 inherit';
  card.appendChild(el('span', undefined, state.forced ? 'Update required' : 'Update ready'));
  card.appendChild(button('Restart', 'dc-ghost', () => {
    // "Restarting to update": the swap is instant and the reload is warm,
    // because every hashed asset the next build shares is already cached.
    updates?.applyNow();
  }));
  updateCard = card;
  uiRoot!.appendChild(card);
}

if (updates !== null) {
  const controller = updates;

  /* Leaving a match is the moment the rule is about. The shell publishes the
   * transition as `#ui[data-screen]`, so this needs no hook inside it. */
  new MutationObserver(() => {
    controller.pump();
    // Only ever checks while out of a match; `check()` enforces that itself.
    void controller.check();
  }).observe(uiRoot!, { attributes: true, attributeFilter: ['data-screen'] });

  /* The backstop. A tab left open for a week in the menu still finds a new
   * build, and a forced update still lands even if the screen never changes. */
  const updateTimer = window.setInterval(() => {
    // A server that refused us for being too old turns the update from an offer
    // into a requirement. `NetClient` keeps the reason sticky across the close,
    // which is why this can be read on a timer rather than needing a callback
    // threaded through the game's event table.
    if (game.net.updateReason !== UpdateReason.NONE) {
      controller.requireUpdate(game.net.updateReason);
    }
    controller.pump();
    void controller.check();
  }, 60_000);
  window.addEventListener('pagehide', () => { window.clearInterval(updateTimer); });
}
