/**
 * DOOMCRAFT — the audio mix, its settings surface, and the accessibility rule.
 *
 * THE PANEL IS THE ONE THAT ALREADY EXISTS
 *
 * `client/src/main.ts` builds the pause/settings panel — a CSS grid with
 * `addSection`, `addSlider`, `addSelect` and `addToggle` around it, four
 * sections deep, and it is reached from both the menu and the pause screen. A
 * second settings panel for audio would be a second place to look, a second
 * thing to keep in sync and a second style to drift. So this file does not
 * build any DOM. It declares the rows it wants as data, main.ts hands it the
 * three functions it already has, and the audio rows appear inside the panel
 * that was already there.
 *
 * PERSISTENCE GOES THROUGH THE SAVE, NOT THROUGH THE SETTINGS KEY
 *
 * `GameSettings` on `doomcraft:settings` is loaded by a naive
 * `{...defaults, ...parsed}` spread with no migration chain — a field whose
 * meaning changes there can never be corrected. `shared/src/saves.ts` has the
 * versioned document and the migration chain, so the mix lives in
 * `SaveFile.audio` and arrived with a v3 -> v4 migration that carries the three
 * volume fields `GameSettings` had been storing, unread, since the spine was
 * written.
 *
 * AUTOPLAY AND FOCUS
 *
 * The gesture unlock belongs to `engine.ts` (`AudioEngine.unlock`) and
 * `main.ts`, which registers it on pointerdown, touchstart and keydown in the
 * CAPTURE phase so a handler that stops propagation cannot swallow it. What
 * lives here is the OTHER half, which is easy to get wrong in the opposite
 * direction: `AudioMixer` owns the focus rule, and it owns it alone. Hidden
 * always suspends the context — a backgrounded tab that keeps an audio thread
 * alive is a reason for a phone's OS to kill the page. Blurred-but-visible is
 * the case the toggle is about, and a player who alt-tabs to read something
 * with the game still on screen is entitled to keep hearing it. Those two
 * rules were briefly decided in two places, in `main.ts`'s visibilitychange
 * handler and here, and could contradict each other on a tab that was hidden
 * and unfocused at once.
 *
 * THE ACCESSIBILITY RULE, AND WHY IT IS HERE
 *
 * `monsters.ts` exists because in DOOM you locate an enemy by ear before you
 * see it. A game that makes hearing load-bearing owes a player who cannot hear
 * the same information by another route. `hud.ts` already has `DamageRing` — a
 * world-anchored, re-projected-every-frame directional indicator for damage —
 * so the visual alternative is not a new system, it is one more bearing kind on
 * the ring that is already correct. `threatCues` decides when it draws, and
 * `shouldShowThreat` below is that decision, kept pure so it is testable.
 */

import type { AudioSave } from '@shared/saves';

import type { MixBus } from './dsp';

/** The mix, as stored. Alias so callers do not reach into the save schema. */
export type AudioSettings = AudioSave;

/** Label for each bus, for the panel and for a test failure message. */
export const BUS_LABELS: Readonly<Record<MixBus, string>> = Object.freeze({
  master: 'Master volume',
  sfx: 'Sound effects',
  music: 'Music',
  ambience: 'Ambience',
  ui: 'Interface',
});

/* ------------------------------------------------------------------------ *
 * The mix
 * ------------------------------------------------------------------------ */

/**
 * Volume for a bus after `master` is folded in, on an audible curve.
 *
 * A slider that maps linearly to gain spends its top half doing nothing you can
 * hear and its bottom tenth doing everything. Squaring it is the cheap standard
 * fix and it is close enough to a 40 dB taper that the middle of the slider
 * lands where the ear expects. Zero is exactly zero — a slider at the bottom
 * must be silence, not -60 dB of hiss.
 */
export function taper(v: number): number {
  if (!(v > 0)) return 0;
  const x = v >= 1 ? 1 : v;
  return x * x;
}

/**
 * The effective gain of a bus once master is folded in — what the ear gets.
 *
 * Not what is written to the engine (master and the bus are separate gains
 * there and multiply on the audio thread); this is the composed value, and it
 * is what `busSilent` and the report are asking about.
 */
export function busGain(s: AudioSettings, bus: MixBus): number {
  const raw = bus === 'master' ? s.master
    : bus === 'sfx' ? s.sfx
      : bus === 'music' ? s.music
        : bus === 'ambience' ? s.ambience
          : s.ui;
  if (raw <= 0 || s.master <= 0) return 0;
  const v = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
  const m = s.master >= 1 ? 1 : s.master;
  return bus === 'master' ? m * m : v * v * (m * m);
}

/**
 * Should a threat cue be drawn on the HUD?
 *
 * `heard` is whether the sound actually reached the mix — false when the voice
 * cap refused it, when the context is suspended, or when the SFX bus is at
 * zero. The rule reads exactly as the setting is documented:
 *
 *   off  — never.
 *   auto — only when the player did not get the sound.
 *   on   — always, because a player who cannot hear is not served by a
 *          heuristic about whether the sound was audible.
 */
export function shouldShowThreat(s: AudioSettings, heard: boolean): boolean {
  if (s.threatCues === 'off') return false;
  if (s.threatCues === 'on') return true;
  return !heard;
}

/* ------------------------------------------------------------------------ *
 * Applying the mix
 * ------------------------------------------------------------------------ */

/**
 * What `AudioMixer` needs of `AudioEngine`.
 *
 * Structural, and every member optional except the two volume setters, so the
 * mixer works against a stub in a test and against the real engine in the game
 * without either of them importing the other.
 */
export interface MixTarget {
  setMasterVolume(v: number): void;
  /** Bus ids are engine.ts's BUS_SFX 0, BUS_MUSIC 1, BUS_UI 2, BUS_AMBIENCE 3. */
  setBusVolume(bus: number, v: number): void;
  /** Suspends the context and stops every voice. */
  setTabHidden?(hidden: boolean): void;
}

/** engine.ts's bus ids. */
const BUS_ID: Readonly<Record<string, number>> = Object.freeze({ sfx: 0, music: 1, ui: 2, ambience: 3 });

/**
 * Pushes the mix onto the engine, and owns the focus rule.
 *
 * `master` goes to `setMasterVolume` and the other four to `setBusVolume`,
 * which means the taper below is applied ONCE per slider and the engine's own
 * multiplication does the rest. Applying master to each bus as well would
 * square it.
 */
export class AudioMixer {
  private readonly engine: MixTarget;
  private settings: AudioSettings;
  private hidden = false;
  private blurred = false;
  private detach: (() => void) | null = null;

  constructor(engine: MixTarget, settings: AudioSettings) {
    this.engine = engine;
    this.settings = settings;
  }

  get current(): AudioSettings { return this.settings; }

  /**
   * True while the mix is being silenced by the focus rule.
   *
   * HIDDEN always silences, whatever the toggle says: a backgrounded tab that
   * keeps an AudioContext running keeps the audio thread and its timers alive
   * for nothing, and on a phone that is a reason for the OS to kill the page.
   * BLURRED-but-still-visible is the case the toggle is actually about — an
   * alt-tab on a desktop with the game still on screen — and a player who wants
   * to keep hearing it while they read something else is entitled to.
   */
  get muted(): boolean { return this.hidden || (this.blurred && this.settings.muteOnBlur); }

  /** Re-read the settings and push them at the engine. Idempotent and cheap. */
  apply(settings: AudioSettings = this.settings): void {
    this.settings = settings;
    this.engine.setMasterVolume(this.muted ? 0 : taper(settings.master));
    this.engine.setBusVolume(BUS_ID.sfx, taper(settings.sfx));
    this.engine.setBusVolume(BUS_ID.music, taper(settings.music));
    this.engine.setBusVolume(BUS_ID.ambience, taper(settings.ambience));
    this.engine.setBusVolume(BUS_ID.ui, taper(settings.ui));
    /* Suspending is not the same as turning the gain to zero, and it is the one
       that matters on a phone: a suspended context stops the audio thread, so a
       backgrounded tab stops costing battery instead of quietly mixing silence.
       The master ducks as well, so a browser that refuses the suspend still
       goes quiet. */
    this.engine.setTabHidden?.(this.muted);
  }

  /**
   * Wire the focus rule. Returns a disposer.
   *
   * `visibilitychange` is the one that fires when a phone is locked or a tab is
   * switched; `blur`/`focus` catch a desktop alt-tab that leaves the tab
   * visible. Both are needed and neither is sufficient.
   */
  attach(target: Window & typeof globalThis, doc: Document): () => void {
    this.detach?.();
    const onVis = (): void => { this.hidden = doc.visibilityState === 'hidden'; this.apply(); };
    const onBlur = (): void => { this.blurred = true; this.apply(); };
    const onFocus = (): void => { this.blurred = false; this.hidden = doc.visibilityState === 'hidden'; this.apply(); };
    doc.addEventListener('visibilitychange', onVis);
    target.addEventListener('blur', onBlur);
    target.addEventListener('focus', onFocus);
    const off = (): void => {
      doc.removeEventListener('visibilitychange', onVis);
      target.removeEventListener('blur', onBlur);
      target.removeEventListener('focus', onFocus);
      this.detach = null;
    };
    this.detach = off;
    return off;
  }

  dispose(): void { this.detach?.(); }
}

/* ------------------------------------------------------------------------ *
 * The panel rows
 * ------------------------------------------------------------------------ */

/**
 * The three builders main.ts already has, as an interface.
 *
 * Passing them in rather than importing main.ts is what keeps this file free of
 * DOM and testable, and it is what stops the audio rows from being a second
 * panel: they are literally built by the panel's own functions.
 */
export interface SettingsPanel {
  section(title: string): void;
  slider(label: string, min: number, max: number, step: number,
    get: () => number, set: (v: number) => void, fmt: (v: number) => string): void;
  toggle(label: string, get: () => boolean, set: (v: boolean) => void): void;
  select(label: string, options: string[], get: () => string, set: (v: string) => void): void;
}

/** One row, as data, so the test can assert the surface without a DOM. */
export interface AudioRow {
  readonly kind: 'slider' | 'toggle' | 'select';
  readonly label: string;
  readonly section: string;
}

/** Every row this module adds, in order. The test asserts against this. */
export const AUDIO_ROWS: readonly AudioRow[] = Object.freeze([
  { kind: 'slider', label: BUS_LABELS.master, section: 'Audio' },
  { kind: 'slider', label: BUS_LABELS.sfx, section: 'Audio' },
  { kind: 'slider', label: BUS_LABELS.music, section: 'Audio' },
  { kind: 'slider', label: BUS_LABELS.ambience, section: 'Audio' },
  { kind: 'slider', label: BUS_LABELS.ui, section: 'Audio' },
  { kind: 'toggle', label: 'Mute when unfocused', section: 'Audio' },
  { kind: 'select', label: 'Threat indicators', section: 'Accessibility' },
]);

const PERCENT = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Add the audio rows to the existing panel.
 *
 * There is no `onChange` parameter on purpose: main.ts's own `addSlider` /
 * `addToggle` / `addSelect` already call `applySettings()` on every edit, so
 * the mix persists through the identical path as the mouse sensitivity. A
 * second change hook here would be a second save path for one panel.
 */
export function mountAudioSettings(panel: SettingsPanel, get: () => AudioSettings): void {
  panel.section('Audio');
  panel.slider(BUS_LABELS.master, 0, 1, 0.05, () => get().master, (v) => { get().master = v; }, PERCENT);
  panel.slider(BUS_LABELS.sfx, 0, 1, 0.05, () => get().sfx, (v) => { get().sfx = v; }, PERCENT);
  panel.slider(BUS_LABELS.music, 0, 1, 0.05, () => get().music, (v) => { get().music = v; }, PERCENT);
  panel.slider(BUS_LABELS.ambience, 0, 1, 0.05, () => get().ambience, (v) => { get().ambience = v; }, PERCENT);
  panel.slider(BUS_LABELS.ui, 0, 1, 0.05, () => get().ui, (v) => { get().ui = v; }, PERCENT);
  panel.toggle('Mute when unfocused', () => get().muteOnBlur, (v) => { get().muteOnBlur = v; });

  /* Accessibility gets its own section rather than being a seventh audio row.
     The setting a player needs when they cannot hear the game must be findable
     by someone who is not looking under "Audio", because "Audio" is the one
     heading they have no reason to open. */
  panel.section('Accessibility');
  panel.select('Threat indicators', ['off', 'auto', 'on'],
    () => get().threatCues,
    (v) => { get().threatCues = (v === 'off' || v === 'on') ? v : 'auto'; });
}
