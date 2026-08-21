/**
 * DOOMCRAFT — the locker. Where you dress your marine.
 *
 * WHAT THE RIG ACTUALLY EXPOSES, because the UI is only allowed to offer what
 * exists. Read straight out of `client/public/characters/cast.glb`:
 *
 *     nodes   character-a -> root -> [leg-left, leg-right, torso]
 *                                     torso   -> [arm-left, arm-right, head]
 *     meshes  6, one per node, 24 vertices each, ONE material, NO skins,
 *             NO baseColorTexture (the atlas is bound at runtime)
 *
 * There is no second head mesh, no alternate torso, no hat node. Every one of
 * Kenney's eighteen characters is that same tree with byte-identical POSITION
 * and TEXCOORD_0 buffers — `tools/build-character-atlas.mjs` re-asserts it on
 * every run. So "part swapping" on this rig cannot mean swapping geometry, and
 * a UI that offered a shape picker would be lying about the asset.
 *
 * What it genuinely means is what `characters/avatar.ts` already models: the
 * six meshes group into FOUR ZONES that can each wear a different one of the
 * twelve outfits packed into `c/kenney-chars.png`, plus two multiply colours.
 *
 *     head        head                     -> 1 of 12 outfits
 *     torso       torso                    -> 1 of 12
 *     arms        arm-left + arm-right     -> 1 of 12
 *     legs        leg-left + leg-right     -> 1 of 12
 *     tint        multiplies head + legs   -> 1 of 16 palette entries
 *     accent      multiplies torso + arms  -> 1 of 16
 *
 * 12^4 * 16^2 = 5.3 million marines out of one 65 KB atlas, and the whole
 * choice is a uint32 (`packAvatar`).
 *
 * THE DRAW-CALL RULE THIS SCREEN OBEYS
 *
 * `vendor/kenney-blocky-characters/README.md`: draw calls are the binding
 * budget and Horde already sits at ~124 against a ~120 practical ceiling. So
 * colour here is never a material. Both colours are per-instance multiply
 * attributes fed to the ONE shared character material in
 * `characters/thirdPerson.ts`; picking "Hellfire" costs zero draw calls, zero
 * textures and zero shader recompiles, in the preview and in the match alike.
 * The preview is a single `CharacterActor` — one InstancedMesh, one instance,
 * one draw call — plus one transparent floor disc.
 *
 * AND THE PAYLOAD RULE
 *
 * Nothing here is imported by the boot path except this module's own ~20 KB of
 * source. The atlas is fetched by `loadCharacterAtlas()`, which `game.ts`
 * already kicks off after first interactivity; if it has not landed the preview
 * draws in flat palette colour rather than blocking. No GLTFLoader is pulled in
 * — the geometry is baked into `characters/kenneyRig.ts` at build time.
 *
 * LIFETIME
 *
 * The WebGL context, the scene, the actor, the floor and the animation frame
 * are created on `open()` and destroyed on `close()`. Nothing survives a close
 * but the 12 cached thumbnail data URLs and the shared, module-level geometry
 * the rest of the game already holds. `forceContextLoss()` is called on the way
 * out so the browser reclaims the context immediately instead of when the GC
 * feels like it — a menu you can open and close forty times must not be able to
 * exhaust the ~16-context limit.
 */

import * as THREE from 'three';

import {
  AVATAR_PALETTE,
  DONOR_COUNT,
  DONOR_NAMES,
  PALETTE_COUNT,
  ZONE_COUNT,
  ZONE_INFO,
  Zone,
  avatarLabel,
  cloneAvatar,
  defaultAvatar,
  packAvatar,
  randomAvatar,
  unpackAvatar,
  type AvatarConfig,
} from '@/characters/avatar';
import {
  CHARACTER_SCALE,
  CharacterActor,
  ZONE_MESHES,
  loadCharacterAtlas,
} from '@/characters/thirdPerson';

/* ------------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------------ */

export interface AvatarEditorOptions {
  /** Where the overlay mounts. Must be a direct child slot of `#ui`. */
  root: HTMLElement;
  /** Packed avatar to open with. */
  initial?: number;
  /** Prefix for the atlas fetch; matches `loadCharacterAtlas`. */
  baseUrl?: string;
  /**
   * Every tweak, live. This is the hook that pushes the look to the server
   * mid-match (`Game.setAvatar`) and writes the save, so it fires on each
   * click rather than only on close.
   */
  onChange?(packed: number, cfg: AvatarConfig): void;
  /** Fired once when the screen closes, with the final look. */
  onClose?(packed: number, cfg: AvatarConfig): void;
}

/* ------------------------------------------------------------------------ *
 * Styles — one sheet, refcounted, scoped to `.dca-`
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-avatar-css';
let styleUsers = 0;

const CSS = `
.dca{--dca-ink:#e8e6e3;--dca-dim:#938e89;--dca-line:rgba(255,255,255,.13);
  --dca-panel:rgba(10,10,14,.86);--dca-hell:#e03c1c;
  position:absolute;inset:0;z-index:5;display:none;overflow:auto;overscroll-behavior:contain;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  color:var(--dca-ink);text-align:left;
  background:
    radial-gradient(78% 58% at 50% 0%,rgba(46,14,7,.62),rgba(0,0,0,0) 68%),
    rgba(5,5,8,.94);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
  padding:calc(24px + var(--safe-t,0px)) calc(22px + var(--safe-r,0px))
    calc(24px + var(--safe-b,0px)) calc(22px + var(--safe-l,0px))}
/* A modal, so it covers the reserved ad gutters the way the pause panel already
   does — but "safe center" rather than plain centring, so a shell taller than the
   viewport scrolls from its top edge instead of having it clipped away. */
.dca.is-open{display:grid;place-items:safe center;align-content:safe center}
.dca *{box-sizing:border-box}
@media (max-width:900px){
  .dca{padding:calc(12px + var(--safe-t,0px)) calc(11px + var(--safe-r,0px))
    calc(12px + var(--safe-b,0px)) calc(11px + var(--safe-l,0px))}
}
@media (max-height:560px){ .dca{padding:8px 14px calc(10px + var(--safe-b,0px))} }

.dca-shell{width:min(1060px,100%);margin:0 auto;display:flex;flex-direction:column;gap:11px}

/* ---- header ---- */
.dca-head{display:flex;align-items:center;gap:14px}
.dca-head div{flex:1;min-width:0}
.dca-head h2{margin:0;font:900 clamp(20px,3vw,30px)/0.95 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.06em;text-transform:uppercase;color:#f4f1ee;
  text-shadow:0 2px 0 #6d1707,0 10px 26px rgba(224,60,28,.30)}
.dca-head h2 span{color:var(--dca-hell)}
.dca-head p{margin:5px 0 0;font-size:11px;letter-spacing:.2em;text-transform:uppercase;
  color:#6f6a66;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dca-x{width:44px;height:44px;flex:0 0 44px;border:1px solid var(--dca-line);border-radius:3px;
  background:rgba(255,255,255,.04);color:#b4aea8;font:400 20px/1 system-ui;cursor:pointer}
.dca-x:hover{border-color:rgba(255,255,255,.42);color:#fff}

/* ---- body ---- */
.dca-body{display:grid;grid-template-columns:minmax(290px,372px) 1fr;gap:11px;align-items:stretch}
/* Both columns share one fixed height so that switching from a tall tab to a
   short one cannot resize the preview under the player's cursor. */
@media (min-width:821px){ .dca-stage,.dca-panel{height:clamp(360px,58vh,500px);min-height:0} }
@media (max-width:820px){ .dca-body{grid-template-columns:1fr} }

/* ---- stage ---- */
.dca-stage{position:relative;overflow:hidden;border:1px solid var(--dca-line);border-radius:4px;
  min-height:430px;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;
  /* The first layer is a soft-box behind the model, and it is not decoration:
     the Cultist and Enforcer outfits are near-black, and on a black stage the
     silhouette they are chosen for disappears. */
  background:
    radial-gradient(44% 38% at 50% 42%,rgba(132,122,148,.28),rgba(0,0,0,0) 74%),
    radial-gradient(62% 40% at 50% 106%,rgba(224,60,28,.26),rgba(0,0,0,0) 72%),
    radial-gradient(94% 62% at 50% -12%,rgba(255,216,176,.14),rgba(0,0,0,0) 64%),
    linear-gradient(180deg,rgba(22,21,28,.86),rgba(8,8,12,.94))}
.dca-stage.is-drag{cursor:grabbing}
.dca-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.dca-grain{position:absolute;inset:0;pointer-events:none;opacity:.5;
  background:repeating-linear-gradient(0deg,rgba(255,255,255,.028) 0 1px,rgba(0,0,0,0) 1px 3px)}
.dca-plate{position:absolute;left:0;right:0;bottom:0;padding:34px 14px 12px;pointer-events:none;
  background:linear-gradient(0deg,rgba(4,4,7,.90),rgba(4,4,7,0))}
.dca-plate b{display:block;font:800 17px/1.1 "Arial Black",Impact,sans-serif;letter-spacing:.05em;
  text-transform:uppercase;color:#f4f1ee}
.dca-plate span{display:block;margin-top:4px;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:#8d8781;font-variant-numeric:tabular-nums}
.dca-tools{position:absolute;top:9px;right:9px;display:flex;flex-direction:column;gap:6px;z-index:2}
.dca-tool{width:40px;height:40px;border:1px solid var(--dca-line);border-radius:3px;
  background:rgba(8,8,12,.74);color:#b4aea8;font:700 13px/1 system-ui;cursor:pointer;
  display:grid;place-items:center;letter-spacing:.04em}
.dca-tool:hover{border-color:rgba(255,255,255,.42);color:#fff}
.dca-tool[aria-pressed="true"]{border-color:var(--dca-hell);color:#ffd9cd;background:rgba(224,60,28,.22)}
.dca-drag{position:absolute;left:12px;top:12px;font-size:9px;letter-spacing:.15em;
  text-transform:uppercase;color:#6b6660;pointer-events:none}
.dca-tool.dca-word{font-size:8.5px;letter-spacing:.06em}

/* ---- panel ---- */
.dca-panel{display:flex;flex-direction:column;min-height:430px;overflow:hidden;
  background:var(--dca-panel);border:1px solid var(--dca-line);border-radius:4px}
.dca-tabs{display:flex;border-bottom:1px solid var(--dca-line);background:rgba(255,255,255,.02);
  overflow-x:auto;scrollbar-width:none}
.dca-tabs::-webkit-scrollbar{display:none}
.dca-tab{flex:1 0 auto;min-width:76px;min-height:50px;padding:8px 9px;cursor:pointer;
  background:none;border:0;border-bottom:2px solid transparent;color:#8d8781;text-align:center;
  font:700 10.5px/1.2 system-ui;letter-spacing:.15em;text-transform:uppercase}
.dca-tab b{display:block;margin-top:4px;font:600 10.5px/1.2 system-ui;letter-spacing:.01em;
  text-transform:none;color:#5f5a56;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dca-tab:hover{color:#d8d3ce}
.dca-tab[aria-selected="true"]{color:#f6f3f0;border-bottom-color:var(--dca-hell);
  background:rgba(224,60,28,.11)}
.dca-tab[aria-selected="true"] b{color:#e3a897}
.dca-dot{display:inline-block;width:9px;height:9px;border-radius:50%;vertical-align:-1px;
  margin-right:5px;border:1px solid rgba(0,0,0,.55);box-shadow:0 0 0 1px rgba(255,255,255,.16)}

.dca-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:11px}
.dca-lab{margin:0 0 7px;font-size:9.5px;letter-spacing:.21em;text-transform:uppercase;color:#6f6a66}
.dca-lab em{font-style:normal;color:#4f4b47;letter-spacing:.09em}
.dca-lab + .dca-lab{margin-top:14px}

.dca-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:7px}
.dca-chip{position:relative;display:flex;flex-direction:column;align-items:stretch;padding:0 0 6px;
  cursor:pointer;color:#a8a29c;font:inherit;border-radius:3px;
  background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.015));
  border:1px solid var(--dca-line);transition:border-color .1s ease,transform .1s ease}
.dca-chip:hover{border-color:rgba(255,255,255,.36);color:#e8e6e3;transform:translateY(-1px)}
.dca-chip:focus-visible{outline:2px solid #fff;outline-offset:2px}
.dca-chip[aria-pressed="true"]{border-color:var(--dca-hell);color:#ffe2d8;
  background:linear-gradient(180deg,rgba(224,60,28,.24),rgba(224,60,28,.06));
  box-shadow:0 0 0 1px var(--dca-hell),0 8px 20px rgba(0,0,0,.5)}
.dca-thumb{position:relative;width:100%;aspect-ratio:3 / 4;
  background-size:contain;background-position:center bottom;background-repeat:no-repeat;
  image-rendering:pixelated}
.dca-thumb::before{content:"";position:absolute;inset:0;z-index:-1;
  background:radial-gradient(56% 34% at 50% 88%,rgba(224,60,28,.26),rgba(0,0,0,0) 72%)}
.dca-nogl{position:absolute;left:0;right:0;top:44%;padding:0 22px;text-align:center;
  font-size:11.5px;line-height:1.6;color:#8d8781;pointer-events:none}
.dca-chip span{display:block;padding:0 4px;font:600 10.5px/1.25 system-ui;letter-spacing:.05em;
  text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dca-chip i{position:absolute;top:4px;left:5px;font:700 9px/1 system-ui;font-style:normal;
  color:#57524e;font-variant-numeric:tabular-nums}
.dca-chip[aria-pressed="true"] i{color:#ffb9a6}

.dca-sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px}
.dca-swatch{position:relative;min-height:50px;padding:6px 7px;display:flex;align-items:flex-end;
  cursor:pointer;border:1px solid rgba(0,0,0,.5);border-radius:3px;
  font:700 9px/1.1 system-ui;letter-spacing:.07em;text-transform:uppercase;color:rgba(12,8,6,.72)}
.dca-swatch:focus-visible{outline:2px solid #fff;outline-offset:2px}
.dca-swatch[aria-pressed="true"]{box-shadow:0 0 0 2px #08080b,0 0 0 4px var(--dca-hell)}
.dca-swatch[aria-pressed="true"]::after{content:"";position:absolute;top:5px;right:6px;
  width:7px;height:7px;border-radius:50%;background:#0c0806}
.dca-none{background-image:linear-gradient(135deg,rgba(0,0,0,.24) 46%,rgba(0,0,0,0) 46%,
  rgba(0,0,0,0) 54%,rgba(0,0,0,.24) 54%)}

/* ---- footer ---- */
.dca-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dca-btn{min-height:46px;padding:12px 18px;cursor:pointer;border-radius:2px;
  border:1px solid var(--dca-line);background:rgba(255,255,255,.05);color:#e8e6e3;
  font:700 12px/1 system-ui;letter-spacing:.13em;text-transform:uppercase}
.dca-btn:hover{border-color:rgba(255,255,255,.42)}
.dca-done{margin-left:auto;border:0;padding:12px 40px;font-size:15px;letter-spacing:.16em;
  font-family:"Arial Black",Impact,sans-serif;
  background:linear-gradient(180deg,var(--dca-hell),#8f1a08);color:#fff;
  box-shadow:0 8px 24px rgba(224,60,28,.32)}
.dca-done:hover{filter:brightness(1.13)}
.dca-cost{flex:1 0 100%;order:9;margin:2px 0 0;font-size:10px;letter-spacing:.1em;color:#514d4a}
.dca-cost b{color:#7e7873;font-weight:700}

@media (max-width:560px){
  .dca-shell{gap:9px}
  .dca-stage{min-height:300px}
  .dca-panel{min-height:0}
  .dca-scroll{max-height:44vh}
  .dca-grid{grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px}
  .dca-sw{grid-template-columns:repeat(auto-fill,minmax(64px,1fr))}
  .dca-head h2{font-size:21px}
  .dca-head p{font-size:9.5px;letter-spacing:.13em}
  .dca-btn{flex:1;padding:12px 8px;letter-spacing:.08em}
  .dca-done{margin-left:0;flex:1.5;padding:13px 12px}
}
@media (max-height:560px){
  .dca-body{grid-template-columns:minmax(220px,300px) 1fr}
  .dca-stage,.dca-panel{min-height:250px}
  .dca-head p,.dca-cost{display:none}
  .dca-head h2{font-size:18px}
}
@media (prefers-reduced-motion:reduce){
  .dca-chip,.dca-chip:hover{transition:none;transform:none}
}

/* The shell sets \`#ui button{font:inherit}\` (client/src/main.ts), and an id in
   the selector outranks any number of classes — so every button rule above
   silently lost its typography. Restate it at id specificity. These are
   duplicates on purpose: the class rules above still stand on their own if this
   component is ever mounted outside #ui. */
#ui .dca-x{font:400 20px/1 system-ui}
#ui .dca-tool{font:700 14px/1 system-ui;letter-spacing:.04em}
#ui .dca-tool.dca-word{font:700 8.5px/1 system-ui;letter-spacing:.06em}
#ui .dca-tab{font:700 10.5px/1.2 system-ui;letter-spacing:.15em}
#ui .dca-swatch{font:700 9px/1.1 system-ui;letter-spacing:.07em}
#ui .dca-btn{font:700 12px/1 system-ui;letter-spacing:.13em}
#ui .dca-done{font:800 15px/1 "Arial Black",Impact,sans-serif;letter-spacing:.16em}
@media (max-width:560px){
  #ui .dca-btn{letter-spacing:.08em}
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) === null) {
    const node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = CSS;
    document.head.appendChild(node);
  }
  styleUsers++;
}

function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
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

function hexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------------ *
 * The floor pad
 *
 * One transparent disc: concentric hell-orange rings that fade out, plus a
 * baked contact shadow under the boots so the marine is standing on something
 * rather than hovering in a void. Cheap enough to be beneath discussion — it
 * is 64 triangles in a context nothing else is using.
 * ------------------------------------------------------------------------ */

const PAD_VERT = /* glsl */ `
varying vec2 vXz;
void main() {
  vXz = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PAD_FRAG = /* glsl */ `
varying vec2 vXz;
uniform float uTime;
void main() {
  float r = length(vXz);
  if (r > 1.0) discard;
  float fade = 1.0 - smoothstep(0.20, 1.0, r);
  float rings = smoothstep(0.80, 1.0, abs(sin(r * 21.0 - uTime * 0.6)));
  float shadow = 1.0 - smoothstep(0.0, 0.30, r);
  vec3 col = mix(vec3(0.30, 0.09, 0.04), vec3(1.0, 0.44, 0.20), rings);
  col = mix(col, vec3(0.0), shadow * 0.92);
  float a = fade * (0.11 + rings * 0.34);
  a = max(a, shadow * 0.62);
  gl_FragColor = vec4(col, a);
}
`;

/* ------------------------------------------------------------------------ *
 * Thumbnails
 *
 * Twelve 132x176 renders of the actual rig wearing each outfit, taken once per
 * page load through the preview's own context and cached as data URLs. This is
 * the alternative to cropping the atlas: an atlas cell is an unwrapped UV sheet
 * and looks like a texture sheet, not like a marine. A real render of the real
 * mesh is what a player can actually recognise on the chip.
 * ------------------------------------------------------------------------ */

const THUMB_W = 132;
const THUMB_H = 176;
const thumbCache = new Map<number, string>();

/* ------------------------------------------------------------------------ *
 * Camera framing
 * ------------------------------------------------------------------------ */

/** Orbit target: mid-chest of a 1.8 m model, so the head is not at the edge. */
const LOOK_Y = 0.82;
const DIST_MIN = 2.5;
const DIST_MAX = 9.5;
const DIST_DEFAULT = 5.45;
const PITCH_MIN = -0.30;
const PITCH_MAX = 0.62;
/** Turntable speed, rad/s, and how long a touch suspends it. */
const SPIN_RATE = 0.22;
const SPIN_RESUME = 3.5;

type TabId = number;
/** Tabs 0..3 are the four zones; tab 4 is the palette. */
const TAB_COLOR = ZONE_COUNT;

/* ------------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------------ */

export class AvatarEditor {
  private readonly opts: AvatarEditorOptions;
  private readonly baseUrl: string;

  /* --- state --- */
  private cfg: AvatarConfig;
  private opened = false;
  private destroyed = false;
  private tab: TabId = Zone.TORSO;

  /* --- dom --- */
  private readonly rootEl: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private readonly plateName: HTMLElement;
  private readonly plateSub: HTMLElement;
  private readonly tabsEl: HTMLDivElement;
  private readonly scrollEl: HTMLDivElement;
  private readonly walkBtn: HTMLButtonElement;
  private readonly tabBtns: HTMLButtonElement[] = [];

  /* --- three --- */
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private actor: CharacterActor | null = null;
  private pad: THREE.Mesh | null = null;
  private padMat: THREE.ShaderMaterial | null = null;
  private raf = 0;
  /** True only while `teardown3D` is deliberately dropping the context. */
  private losing = false;
  private lastMs = 0;
  private elapsed = 0;
  private ro: ResizeObserver | null = null;

  /* --- orbit --- */
  private yaw = -0.58;
  private pitch = 0.07;
  private dist = DIST_DEFAULT;
  private spinIdle = 0;
  private walking = false;

  /* --- pointers --- */
  private readonly drags = new Map<number, { x: number; y: number }>();
  private pinch = 0;

  constructor(opts: AvatarEditorOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl ?? '';
    this.cfg = unpackAvatar(opts.initial ?? 0);
    ensureStyle();

    /* ---- shell ---- */
    this.rootEl = el('div', 'dca');
    this.rootEl.setAttribute('role', 'dialog');
    this.rootEl.setAttribute('aria-modal', 'true');
    this.rootEl.setAttribute('aria-label', 'Marine locker');
    const shell = el('div', 'dca-shell');
    this.rootEl.appendChild(shell);

    /* ---- header ---- */
    const head = el('div', 'dca-head');
    const titles = el('div');
    const h2 = el('h2');
    h2.innerHTML = 'LOCK<span>ER</span>';
    titles.appendChild(h2);
    titles.appendChild(el('p', undefined, 'Four zones · twelve outfits · sixteen colours'));
    head.appendChild(titles);
    const x = el('button', 'dca-x', '✕');
    x.type = 'button';
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close locker');
    x.addEventListener('click', () => this.close());
    head.appendChild(x);
    shell.appendChild(head);

    /* ---- body ---- */
    const body = el('div', 'dca-body');
    shell.appendChild(body);

    this.stageEl = el('div', 'dca-stage');
    body.appendChild(this.stageEl);
    this.stageEl.appendChild(el('div', 'dca-grain'));
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches;
    const hint = el('div', 'dca-drag',
      coarse ? 'Drag to turn · pinch to zoom' : 'Drag to turn · scroll to zoom');
    this.stageEl.appendChild(hint);

    const tools = el('div', 'dca-tools');
    this.walkBtn = this.toolBtn(tools, 'WALK', 'Walk on the spot', () => {
      this.walking = !this.walking;
      this.walkBtn.setAttribute('aria-pressed', String(this.walking));
    });
    this.walkBtn.classList.add('dca-word');
    this.walkBtn.setAttribute('aria-pressed', 'false');
    this.toolBtn(tools, '+', 'Zoom in', () => this.zoomBy(-0.7));
    this.toolBtn(tools, '−', 'Zoom out', () => this.zoomBy(0.7));
    this.toolBtn(tools, '↺', 'Reset the view', () => {
      this.yaw = -0.58; this.pitch = 0.07; this.dist = DIST_DEFAULT; this.spinIdle = 0;
    });
    this.stageEl.appendChild(tools);

    const plate = el('div', 'dca-plate');
    this.plateName = el('b', undefined, 'Marine');
    this.plateSub = el('span', undefined, '');
    plate.append(this.plateName, this.plateSub);
    this.stageEl.appendChild(plate);

    this.bindStageInput();

    /* ---- panel ---- */
    const panel = el('div', 'dca-panel');
    body.appendChild(panel);

    this.tabsEl = el('div', 'dca-tabs');
    this.tabsEl.setAttribute('role', 'tablist');
    panel.appendChild(this.tabsEl);
    for (const info of ZONE_INFO) this.addTab(info.zone, info.label);
    this.addTab(TAB_COLOR, 'Colour');

    this.scrollEl = el('div', 'dca-scroll');
    panel.appendChild(this.scrollEl);

    /* ---- footer ---- */
    const foot = el('div', 'dca-foot');
    shell.appendChild(foot);
    foot.appendChild(this.footBtn('Randomise', () => {
      this.cfg = randomAvatar();
      this.commit();
      this.paint();
    }));
    foot.appendChild(this.footBtn('Reset', () => {
      this.cfg = defaultAvatar();
      this.commit();
      this.paint();
    }));
    const done = this.footBtn('Done', () => this.close());
    done.classList.add('dca-done');
    foot.appendChild(done);
    const cost = el('p', 'dca-cost');
    cost.innerHTML =
      'Every outfit and colour shares one mesh, one texture and one material — '
      + '<b>one draw call for the whole cast</b>, and <b>4 bytes</b> of your look on the wire.';
    foot.appendChild(cost);

    opts.root.appendChild(this.rootEl);
    this.paint();
  }

  /* -------------------------------------------------------------------- *
   * Public surface
   * -------------------------------------------------------------------- */

  get isOpen(): boolean { return this.opened; }
  get packed(): number { return packAvatar(this.cfg); }

  /** Replace the look without firing `onChange` — for a save reload. */
  setAvatar(packed: number): void {
    this.cfg = unpackAvatar(packed);
    this.actor?.setAvatar(packAvatar(this.cfg));
    this.paint();
  }

  open(): void {
    if (this.opened || this.destroyed) return;
    this.opened = true;
    this.rootEl.classList.add('is-open');
    this.rootEl.scrollTop = 0;
    this.stageEl.querySelector('.dca-nogl')?.remove();
    this.build3D();
    this.paint();
    // The atlas is 65 KB and is usually already in flight from game.ts. Until
    // it lands the preview is flat palette colour, which is not an error state.
    void loadCharacterAtlas(this.baseUrl)
      .then(() => { if (this.opened) this.buildThumbs(); })
      .catch(() => { /* flat colours are a fine fallback */ });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.rootEl.classList.remove('is-open');
    this.teardown3D();
    this.opts.onClose?.(packAvatar(this.cfg), cloneAvatar(this.cfg));
  }

  toggle(): void { if (this.opened) this.close(); else this.open(); }

  /** Full teardown: GL context, listeners, DOM and the stylesheet. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.opened) {
      this.opened = false;
      this.rootEl.classList.remove('is-open');
      this.teardown3D();
    }
    this.rootEl.remove();
    releaseStyle();
  }

  /* -------------------------------------------------------------------- *
   * DOM construction helpers
   * -------------------------------------------------------------------- */

  private toolBtn(
    parent: HTMLElement, label: string, title: string, onClick: () => void,
  ): HTMLButtonElement {
    const b = el('button', 'dca-tool', label);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    parent.appendChild(b);
    return b;
  }

  private footBtn(label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', 'dca-btn', label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
  }

  private addTab(id: TabId, label: string): void {
    const b = el('button', 'dca-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.tab = String(id);
    b.innerHTML = `${label}<b></b>`;
    b.addEventListener('click', () => {
      this.tab = id;
      this.paint();
      this.scrollEl.scrollTop = 0;
    });
    this.tabsEl.appendChild(b);
    this.tabBtns.push(b);
  }

  /* -------------------------------------------------------------------- *
   * Paint
   * -------------------------------------------------------------------- */

  private commit(): void {
    const packed = packAvatar(this.cfg);
    this.actor?.setAvatar(packed);
    this.opts.onChange?.(packed, cloneAvatar(this.cfg));
  }

  private paint(): void {
    /* --- tabs --- */
    for (const b of this.tabBtns) {
      const id = Number(b.dataset.tab);
      b.setAttribute('aria-selected', String(id === this.tab));
      const sub = b.querySelector('b');
      if (sub === null) continue;
      if (id === TAB_COLOR) {
        sub.innerHTML =
          `<i class="dca-dot" style="background:${hexCss(AVATAR_PALETTE[this.cfg.tint].hex)}"></i>`
          + `<i class="dca-dot" style="background:${hexCss(AVATAR_PALETTE[this.cfg.accent].hex)}"></i>`;
      } else {
        sub.textContent = DONOR_NAMES[this.cfg.zones[id]] ?? '—';
      }
    }

    /* --- plate --- */
    this.plateName.textContent = avatarLabel(this.cfg);
    this.plateSub.textContent =
      `${AVATAR_PALETTE[this.cfg.tint].name} skin · ${AVATAR_PALETTE[this.cfg.accent].name} kit`;

    /* --- body --- */
    this.scrollEl.textContent = '';
    if (this.tab === TAB_COLOR) this.paintColors();
    else this.paintOutfits(this.tab as Zone);
  }

  private paintOutfits(zone: Zone): void {
    const lab = el('p', 'dca-lab');
    // The mesh list comes from the rig, not from a label typed here.
    lab.innerHTML = `Outfit <em>— ${ZONE_MESHES[zone].join(' + ')}</em>`;
    this.scrollEl.appendChild(lab);

    const grid = el('div', 'dca-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', `${ZONE_INFO[zone].label} outfit`);
    for (let i = 0; i < DONOR_COUNT; i++) {
      const chip = el('button', 'dca-chip');
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(this.cfg.zones[zone] === i));
      chip.setAttribute('aria-pressed', String(this.cfg.zones[zone] === i));
      const thumb = el('div', 'dca-thumb');
      const url = thumbCache.get(i);
      if (url !== undefined) thumb.style.backgroundImage = `url(${url})`;
      chip.appendChild(thumb);
      chip.appendChild(el('span', undefined, DONOR_NAMES[i]));
      const idx = el('i', undefined, String(i + 1).padStart(2, '0'));
      chip.appendChild(idx);
      chip.addEventListener('click', () => {
        this.cfg.zones[zone] = i;
        this.commit();
        this.paint();
      });
      grid.appendChild(chip);
    }
    this.wireArrows(grid);
    this.scrollEl.appendChild(grid);

    const all = el('button', 'dca-btn', 'Apply to every zone');
    all.type = 'button';
    all.style.cssText = 'margin-top:11px;width:100%;min-height:42px;font-size:11px';
    all.addEventListener('click', () => {
      const pick = this.cfg.zones[zone];
      for (let z = 0; z < ZONE_COUNT; z++) this.cfg.zones[z] = pick;
      this.commit();
      this.paint();
    });
    this.scrollEl.appendChild(all);
  }

  private paintColors(): void {
    this.scrollEl.appendChild(this.swatchRow(
      'Skin tint', 'head + legs', this.cfg.tint,
      (i) => { this.cfg.tint = i; this.commit(); this.paint(); },
    ));
    this.scrollEl.appendChild(this.swatchRow(
      'Kit accent', 'torso + arms', this.cfg.accent,
      (i) => { this.cfg.accent = i; this.commit(); this.paint(); },
    ));
    const note = el('p', 'dca-lab');
    note.style.cssText = 'margin-top:14px;line-height:1.6;letter-spacing:.05em;text-transform:none';
    note.textContent =
      'Colours multiply the outfit rather than replace it, and none of them is '
      + 'dark enough to hide in: the palette floor is more than twice the brightness '
      + 'of the far-wall fog, so a marine can never sink into a corridor.';
    this.scrollEl.appendChild(note);
  }

  private swatchRow(
    title: string, sub: string, selected: number, onPick: (i: number) => void,
  ): HTMLElement {
    const wrap = el('div');
    const lab = el('p', 'dca-lab');
    lab.innerHTML = `${title} <em>— ${sub}</em>`;
    wrap.appendChild(lab);
    const grid = el('div', 'dca-sw');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', title);
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const c = AVATAR_PALETTE[i];
      const b = el('button', i === 0 ? 'dca-swatch dca-none' : 'dca-swatch', c.name);
      b.type = 'button';
      b.style.backgroundColor = hexCss(c.hex);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === selected));
      b.setAttribute('aria-pressed', String(i === selected));
      b.addEventListener('click', () => onPick(i));
      grid.appendChild(b);
    }
    this.wireArrows(grid);
    wrap.appendChild(grid);
    return wrap;
  }

  /** Left/Right/Up/Down move focus inside a chip or swatch grid. */
  private wireArrows(grid: HTMLElement): void {
    grid.addEventListener('keydown', (e: KeyboardEvent) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      const items = Array.from(grid.children) as HTMLElement[];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      items[(at + step + items.length) % items.length].focus();
    });
  }

  /* -------------------------------------------------------------------- *
   * Stage input — mouse, wheel, and multi-touch
   * -------------------------------------------------------------------- */

  private zoomBy(d: number): void {
    this.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, this.dist + d));
    this.spinIdle = SPIN_RESUME;
  }

  private bindStageEnd = (e: PointerEvent): void => {
    this.drags.delete(e.pointerId);
    if (this.drags.size < 2) this.pinch = 0;
    if (this.drags.size === 0) this.stageEl.classList.remove('is-drag');
  };

  private bindStageInput(): void {
    const s = this.stageEl;

    s.addEventListener('pointerdown', (e: PointerEvent) => {
      // The zoom/walk/reset buttons live inside the stage. Capturing their
      // pointer would retarget the pointerup and swallow the click.
      if ((e.target as HTMLElement | null)?.closest('button') !== null) return;
      s.setPointerCapture(e.pointerId);
      this.drags.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.spinIdle = SPIN_RESUME;
      s.classList.add('is-drag');
      e.preventDefault();
    });

    s.addEventListener('pointermove', (e: PointerEvent) => {
      const prev = this.drags.get(e.pointerId);
      if (prev === undefined) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      this.spinIdle = SPIN_RESUME;

      if (this.drags.size >= 2) {
        // Two fingers: pinch is the zoom, and the drag is ignored so the model
        // does not lurch while the fingers converge.
        const pts = Array.from(this.drags.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.pinch > 0) this.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, this.dist * (this.pinch / Math.max(1, d))));
        this.pinch = d;
        return;
      }
      // 0.011 rad/px puts a full turn at ~570 px of travel, which is one
      // comfortable swipe on a 412 px phone and one lazy drag on desktop.
      this.yaw -= dx * 0.011;
      this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch + dy * 0.006));
    });

    s.addEventListener('pointerup', this.bindStageEnd);
    s.addEventListener('pointercancel', this.bindStageEnd);
    s.addEventListener('lostpointercapture', this.bindStageEnd);

    s.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.zoomBy(Math.sign(e.deltaY) * 0.42);
    }, { passive: false });

    // Dragging is a view control, not a text selection.
    s.addEventListener('dragstart', (e) => e.preventDefault());
  }

  /* -------------------------------------------------------------------- *
   * The preview — built on open, destroyed on close
   * -------------------------------------------------------------------- */

  private build3D(): void {
    if (this.renderer !== null) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        // The thumbnail pass reads the canvas back with drawImage; without this
        // some drivers hand back a cleared buffer.
        preserveDrawingBuffer: true,
        powerPreference: 'low-power',
      });
    } catch {
      // No second context available (an old phone, or too many live contexts).
      // The rest of the screen still works: the chips carry names, the palette
      // carries colours, and the result is visible in the match itself.
      this.showNoGl('The live preview needs a second WebGL context and this browser '
        + 'will not give one out. Your choices below still apply in the match.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    // Chrome drops the OLDEST live context when a page asks for one too many.
    // If the browser takes this one back, stop rendering into it rather than
    // spraying GL errors once a frame, and say so on the stage.
    renderer.domElement.addEventListener('webglcontextlost', (e) => {
      // NOT during our own forceContextLoss(): preventDefault() on that event
      // tells the browser we intend to restore, which is exactly the opposite
      // of what teardown wants and leaves the context reserved.
      if (this.losing || !this.opened) return;
      e.preventDefault();
      if (this.raf !== 0) { cancelAnimationFrame(this.raf); this.raf = 0; }
      this.showNoGl('The browser reclaimed the preview\u2019s graphics context. '
        + 'Close and reopen the locker to get it back — your choices are already saved.');
    });
    this.stageEl.insertBefore(renderer.domElement, this.stageEl.firstChild);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(26, 1, 0.05, 60);

    const actor = new CharacterActor(scene, { actorGain: 1.26, actorFog: 0 });
    // The match's grade is deliberately desaturated so enemies are the only
    // saturated things on screen. A shop is the opposite problem: the player is
    // choosing a colour and must see the colour they are choosing.
    const u = actor.batch.material.uniforms;
    u.uSaturation.value = 1.0;
    u.uContrast.value = 0.14;
    u.uFogDensity.value = 0;
    actor.setAvatar(packAvatar(this.cfg));
    this.actor = actor;

    this.padMat = new THREE.ShaderMaterial({
      vertexShader: PAD_VERT,
      fragmentShader: PAD_FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const pad = new THREE.Mesh(new THREE.CircleGeometry(1.45, 48), this.padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.002;
    pad.renderOrder = -1;
    scene.add(pad);
    this.pad = pad;

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.stageEl);
    }

    this.lastMs = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private showNoGl(text: string): void {
    let n = this.stageEl.querySelector<HTMLElement>('.dca-nogl');
    if (n === null) {
      n = el('p', 'dca-nogl');
      this.stageEl.appendChild(n);
    }
    n.textContent = text;
  }

  private teardown3D(): void {
    if (this.raf !== 0) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.ro?.disconnect();
    this.ro = null;

    this.actor?.dispose();
    this.actor = null;

    if (this.pad !== null) {
      this.pad.removeFromParent();
      this.pad.geometry.dispose();
      this.pad = null;
    }
    this.padMat?.dispose();
    this.padMat = null;

    this.scene?.clear();
    this.scene = null;
    this.camera = null;

    const r = this.renderer;
    if (r !== null) {
      this.losing = true;
      r.dispose();
      // Hand the context back now rather than at the GC's convenience: a menu
      // that can be opened forty times must not walk into the browser's
      // ~16-live-context ceiling.
      r.forceContextLoss();
      r.domElement.remove();
      this.renderer = null;
      this.losing = false;
    }
    this.drags.clear();
    this.pinch = 0;
    this.stageEl.classList.remove('is-drag');
  }

  private resize(): void {
    const r = this.renderer;
    const cam = this.camera;
    if (r === null || cam === null) return;
    const w = Math.max(1, Math.round(this.stageEl.clientWidth));
    const h = Math.max(1, Math.round(this.stageEl.clientHeight));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }

  private readonly frame = (nowMs: number): void => {
    this.raf = 0;
    if (!this.opened) return;
    const r = this.renderer;
    const scene = this.scene;
    const cam = this.camera;
    const actor = this.actor;
    if (r === null || scene === null || cam === null || actor === null) return;

    const dt = this.lastMs === 0 ? 0 : Math.min(0.1, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    this.elapsed += dt;

    // Turntable, suspended while the player is driving it and for a moment
    // after, so their chosen angle is not stolen back the instant they let go.
    if (this.spinIdle > 0) this.spinIdle = Math.max(0, this.spinIdle - dt);
    else this.yaw += SPIN_RATE * dt;

    cam.position.set(
      0,
      LOOK_Y + Math.sin(this.pitch) * this.dist,
      Math.cos(this.pitch) * this.dist,
    );
    cam.lookAt(0, LOOK_Y, 0);

    // The model turns, not the camera: `aShade` is a baked per-vertex face ramp
    // so the two are visually identical, and turning the model keeps the floor
    // pad's rings square to the viewer.
    actor.update(this.elapsed, dt, this.yaw + Math.PI, this.walking ? 1 : 0, CHARACTER_SCALE);
    if (this.padMat !== null) this.padMat.uniforms.uTime.value = this.elapsed;

    r.render(scene, cam);
    this.raf = requestAnimationFrame(this.frame);
  };

  /* -------------------------------------------------------------------- *
   * Thumbnails
   * -------------------------------------------------------------------- */

  private buildThumbs(): void {
    if (thumbCache.size >= DONOR_COUNT) { this.applyThumbs(); return; }
    const r = this.renderer;
    const scene = this.scene;
    const actor = this.actor;
    if (r === null || scene === null || actor === null) return;

    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx === null) return;
    ctx.canvas.width = THUMB_W;
    ctx.canvas.height = THUMB_H;

    const cam = new THREE.PerspectiveCamera(21, THUMB_W / THUMB_H, 0.05, 40);
    cam.position.set(1.30, 1.58, 5.42);
    cam.lookAt(0, 0.94, 0);

    const padWasVisible = this.pad !== null && this.pad.visible;
    if (this.pad !== null) this.pad.visible = false;
    const dpr = r.getPixelRatio();

    try {
      r.setPixelRatio(1);
      r.setSize(THUMB_W, THUMB_H, false);
      for (let i = 0; i < DONOR_COUNT; i++) {
        actor.setAvatar(packAvatar({ zones: [i, i, i, i], tint: 0, accent: 0 }));
        // dt 0: the shared phase accumulator must come out of this untouched.
        actor.update(0.55, 0, Math.PI, 0, CHARACTER_SCALE);
        r.render(scene, cam);
        ctx.clearRect(0, 0, THUMB_W, THUMB_H);
        ctx.drawImage(r.domElement, 0, 0, THUMB_W, THUMB_H);
        thumbCache.set(i, ctx.canvas.toDataURL('image/png'));
      }
    } catch {
      thumbCache.clear();   // a tainted or lost context: chips stay text-only
    } finally {
      if (this.pad !== null) this.pad.visible = padWasVisible;
      actor.setAvatar(packAvatar(this.cfg));
      r.setPixelRatio(dpr);
      this.resize();
    }
    this.applyThumbs();
  }

  /** Paint cached thumbnails into whatever chips are currently on screen. */
  private applyThumbs(): void {
    const chips = this.scrollEl.querySelectorAll<HTMLElement>('.dca-chip');
    chips.forEach((chip, i) => {
      const url = thumbCache.get(i);
      const thumb = chip.querySelector<HTMLElement>('.dca-thumb');
      if (url !== undefined && thumb !== null) thumb.style.backgroundImage = `url(${url})`;
    });
  }
}

/* ------------------------------------------------------------------------ *
 * Factory + the label the menu button wears
 * ------------------------------------------------------------------------ */

export function createAvatarEditor(opts: AvatarEditorOptions): AvatarEditor {
  return new AvatarEditor(opts);
}

/** "Locker · Marine" — what the main-menu button says about your current look. */
export function avatarButtonLabel(packed: number): string {
  return `Locker · ${avatarLabel(unpackAvatar(packed))}`;
}
