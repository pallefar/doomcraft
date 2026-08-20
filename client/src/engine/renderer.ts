/**
 * DOOMCRAFT — WebGL renderer, camera and frame timing.
 *
 * The whole file exists to serve one number: 60 fps median and 55 fps 1% low at
 * 412x915 with a 4x CPU throttle. Everything here is chosen against that.
 *
 *  - antialias OFF. MSAA on a fragment-heavy voxel scene is the single most
 *    expensive box you can tick, and hard voxel edges are the art style.
 *  - pixel ratio capped at 2 on desktop and 1.5 on mobile, then multiplied by a
 *    render scale so quality presets and a dynamic-resolution controller have
 *    one knob each.
 *  - no stencil, no alpha, no depth preservation, no shadow maps, no tone
 *    mapping pass. The chunk shader writes final colour.
 *  - resize is driven by ResizeObserver, never by polling clientWidth in the
 *    frame loop: reading layout every frame is a forced reflow.
 *
 * `render(dt)` draws the world scene and then each registered overlay pass with
 * a cleared depth buffer, which is how the first-person viewmodel avoids
 * clipping into walls.
 */

import * as THREE from 'three';
import {
  FAR_PLANE,
  FOV_DEFAULT,
  NEAR_PLANE,
} from '@doomcraft/shared';
import { DOOM_FOG } from './material';

/** A pass drawn after the world with a fresh depth buffer (viewmodel, etc). */
export interface OverlayPass {
  render(renderer: THREE.WebGLRenderer, dt: number): void;
}

export interface GameRendererOptions {
  canvas: HTMLCanvasElement;
  /** Force the mobile pixel-ratio cap. Auto-detected from pointer type otherwise. */
  mobile?: boolean;
  fov?: number;
  near?: number;
  far?: number;
  renderScale?: number;
  clearColor?: number;
  /** Called when the drawing buffer changes size, in device pixels. */
  onResize?: (w: number, h: number) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

/* ------------------------------------------------------------------------ *
 * Frame statistics
 * ------------------------------------------------------------------------ */

const SAMPLE_COUNT = 256;

/**
 * A ring of frame times, plus the two numbers the performance contract is
 * written in. `onePercentLowFps` is computed the same way the capture harness
 * does it: the 99th percentile frame time, expressed as fps.
 */
export class FrameStats {
  private readonly samples = new Float32Array(SAMPLE_COUNT);
  private readonly sorted = new Float32Array(SAMPLE_COUNT);
  private head = 0;
  private filled = 0;
  /** Exponential moving average of the frame time, ms. */
  smoothedMs = 16.6;

  push(ms: number): void {
    this.samples[this.head] = ms;
    this.head = (this.head + 1) % SAMPLE_COUNT;
    if (this.filled < SAMPLE_COUNT) this.filled++;
    this.smoothedMs += (ms - this.smoothedMs) * 0.1;
  }

  get fps(): number {
    return this.smoothedMs > 0 ? 1000 / this.smoothedMs : 0;
  }

  /** Median frame time in ms; 0 before any samples land. */
  medianMs(): number {
    return this.percentileMs(0.5);
  }

  /** 1% low, i.e. fps at the 99th-percentile frame time. */
  onePercentLowFps(): number {
    const p99 = this.percentileMs(0.99);
    return p99 > 0 ? 1000 / p99 : 0;
  }

  percentileMs(p: number): number {
    const n = this.filled;
    if (n === 0) return 0;
    const s = this.sorted.subarray(0, n);
    s.set(this.samples.subarray(0, n));
    s.sort();
    const i = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
    return s[i];
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.smoothedMs = 16.6;
  }
}

/* ------------------------------------------------------------------------ *
 * GameRenderer
 * ------------------------------------------------------------------------ */

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly isMobile: boolean;
  readonly stats = new FrameStats();

  /** CSS pixels. */
  width = 1;
  height = 1;
  /** Device pixels actually rendered. */
  drawWidth = 1;
  drawHeight = 1;

  private readonly overlays: OverlayPass[] = [];
  private readonly opts: GameRendererOptions;
  private renderScale: number;
  private dprCap: number;
  private observer: ResizeObserver | null = null;
  private disposed = false;
  private baseFov: number;
  private fovBonus = 0;

  constructor(opts: GameRendererOptions) {
    this.opts = opts;
    this.canvas = opts.canvas;
    this.isMobile = opts.mobile ?? detectMobile();
    this.dprCap = this.isMobile ? 1.5 : 2;
    this.renderScale = opts.renderScale ?? 1;
    this.baseFov = opts.fov ?? FOV_DEFAULT;

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.autoClear = false;
    this.renderer.sortObjects = true;
    this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = false;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(opts.clearColor ?? DOOM_FOG, 1);

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    // No THREE.Fog: the chunk shader owns fog so it can be exp2 and radial.
    this.scene.fog = null;

    this.camera = new THREE.PerspectiveCamera(
      this.baseFov, 1, opts.near ?? NEAR_PLANE, opts.far ?? FAR_PLANE,
    );
    this.camera.rotation.order = 'YXZ';   // yaw then pitch, no roll surprises
    this.scene.add(this.camera);

    this.attachEvents();
    this.resize();
  }

  /* -- sizing ------------------------------------------------------------ */

  private attachEvents(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.canvas);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize, { passive: true });
    }
    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
  }

  private readonly onWindowResize = (): void => { this.resize(); };

  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.opts.onContextLost?.();
  };

  private readonly onRestored = (): void => {
    this.opts.onContextRestored?.();
  };

  /**
   * Re-read the canvas box and resize the drawing buffer. Cheap to call: it
   * bails out when nothing changed.
   */
  resize(): void {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 1));
    const cssH = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 1));
    const dpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      this.dprCap,
    ) * this.renderScale;

    const dw = Math.max(1, Math.round(cssW * dpr));
    const dh = Math.max(1, Math.round(cssH * dpr));
    if (dw === this.drawWidth && dh === this.drawHeight && cssW === this.width && cssH === this.height) {
      return;
    }

    this.width = cssW;
    this.height = cssH;
    this.drawWidth = dw;
    this.drawHeight = dh;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    this.opts.onResize?.(dw, dh);
  }

  /** 0.5 .. 1.0 typically. Multiplies the capped device pixel ratio. */
  setRenderScale(scale: number): void {
    const s = Math.max(0.4, Math.min(1.5, scale));
    if (s === this.renderScale) return;
    this.renderScale = s;
    this.forceResize();
  }

  get currentRenderScale(): number {
    return this.renderScale;
  }

  /** Override the device-pixel-ratio ceiling (2 desktop / 1.5 mobile). */
  setPixelRatioCap(cap: number): void {
    const c = Math.max(1, Math.min(3, cap));
    if (c === this.dprCap) return;
    this.dprCap = c;
    this.forceResize();
  }

  private forceResize(): void {
    this.drawWidth = -1;
    this.drawHeight = -1;
    this.resize();
  }

  /* -- camera ------------------------------------------------------------ */

  setFov(degrees: number): void {
    this.baseFov = degrees;
    this.applyFov();
  }

  /** Additive FOV, used for the sprint punch. Set every frame; it is cheap. */
  setFovBonus(degrees: number): void {
    if (Math.abs(degrees - this.fovBonus) < 0.01) return;
    this.fovBonus = degrees;
    this.applyFov();
  }

  private applyFov(): void {
    const f = this.baseFov + this.fovBonus;
    if (Math.abs(this.camera.fov - f) < 0.001) return;
    this.camera.fov = f;
    this.camera.updateProjectionMatrix();
  }

  setFar(metres: number): void {
    if (this.camera.far === metres) return;
    this.camera.far = metres;
    this.camera.updateProjectionMatrix();
  }

  /* -- overlays ---------------------------------------------------------- */

  addOverlay(pass: OverlayPass): void {
    if (this.overlays.indexOf(pass) === -1) this.overlays.push(pass);
  }

  removeOverlay(pass: OverlayPass): void {
    const i = this.overlays.indexOf(pass);
    if (i >= 0) this.overlays.splice(i, 1);
  }

  /* -- the frame --------------------------------------------------------- */

  /**
   * Draw one frame. `dt` is seconds since the previous frame; it is forwarded
   * to overlay passes and used only for statistics here.
   */
  render(dt: number): void {
    if (this.disposed) return;
    const t0 = performance.now();

    const r = this.renderer;
    r.info.reset();
    r.clear(true, true, false);
    r.render(this.scene, this.camera);

    for (let i = 0; i < this.overlays.length; i++) {
      r.clearDepth();
      this.overlays[i].render(r, dt);
    }

    this.stats.push(performance.now() - t0);
  }

  /** GPU-side draw counters for the last frame. */
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  get triangles(): number {
    return this.renderer.info.render.triangles;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWindowResize);
    }
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.overlays.length = 0;
    this.renderer.dispose();
  }
}

function detectMobile(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
}
