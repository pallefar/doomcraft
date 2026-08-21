/**
 * DOOMCRAFT — match type, said out loud.
 *
 * The trust table decides whether a match counts. This file makes sure the
 * player knows *before* they play it, not after.
 *
 * The failure this exists to prevent is specific: somebody plays co-op Horde
 * with three friends for an hour, watches the wave counter climb, and then
 * finds their account is exactly where it was. That is not a bug they will
 * report — it is a bug they will quit over, and it is entirely avoidable by
 * putting the truth on the screen at the three moments it matters.
 *
 *   1. **Choosing.** `MatchTypePicker` lists the match types a mode offers, each
 *      one labelled with who hosts it and what it pays. The rows come from
 *      `matchTypesFor()`, so a mode cannot offer something the table does not.
 *   2. **Committing.** `describeBeforePlay()` is one line under the play button.
 *      An unranked pick says so in the same glance as the word PLAY.
 *   3. **Playing.** `MatchTypeBadge` in `compact` form sits in the HUD for the
 *      whole match. An hour in, the answer is still on screen.
 *
 * Three rules this file follows, and `trust.test.ts` enforces the third:
 *
 *   - **Never say "rewards" when the answer is "no rewards".** The unranked
 *     state is the one that has to be unmissable, so it gets the amber chip and
 *     the explicit sentence, and the trusted state gets the quiet green one.
 *     Warnings that look like decoration get read as decoration.
 *   - **Name the host.** "Peer-hosted" and "On your device" are shown to the
 *     player, because "unranked" without a reason reads as an arbitrary
 *     punishment rather than a consequence of who is running the match.
 *   - **No mode literals.** Every string is derived from `trust.ts` and
 *     `modes.ts`. There is no `if (mode === HORDE)` anywhere below, so the UI
 *     cannot disagree with the enforcement.
 *
 * All CSS is scoped to `.dcmt-` and injected once, matching `modeSelect.ts`.
 * `document` is only touched inside methods, so this module is safe to import
 * under vitest's node environment.
 */

import { getMode, type ModeId } from '@shared/modes';
import {
  MATCH_TYPE_NAMES,
  MatchType,
  PEER_MAX_PLAYERS,
  REWARD_NONE,
  TOPOLOGY_NAMES,
  Topology,
  WRITE_LOCAL_RECORD,
  hasWrite,
  matchTypesFor,
  rewardNames,
  trustPolicyFor,
  type TrustPolicy,
} from '@shared/trust';

/* ------------------------------------------------------------------------ *
 * Pure summary — everything the UI renders comes from here
 * ------------------------------------------------------------------------ */

/** Which of the two visual states a row is in. There are only two. */
export type MatchTone = 'counts' | 'unranked';

export interface MatchTypeSummary {
  readonly modeId: ModeId;
  readonly matchType: MatchType;
  readonly policy: TrustPolicy;

  /** 'counts' | 'unranked'. Drives colour and icon; never invented locally. */
  readonly tone: MatchTone;
  /** "Ranked", "Private", "Solo" — the match type's own name. */
  readonly typeName: string;
  /** "Server-hosted", "Peer-hosted", "On your device". */
  readonly hostName: string;
  /** The single word on the chip: "COUNTS" or "UNRANKED". */
  readonly verdict: string;
  /** "Server-hosted · Ranked" — the chip's second line. */
  readonly chipLine: string;
  /** Reward display names this match pays, in table order. Empty when none. */
  readonly rewards: readonly string[];
  /** "XP, Scrap, Item drops" or "Nothing — this match does not count". */
  readonly rewardLine: string;
  /** The row's own sentence to the player. Never paraphrased here. */
  readonly playerNote: string;
  /** Non-empty only for an unranked row. The thing they must not miss. */
  readonly warning: string;
  /** Bodies this match accepts, for "up to 4 players". */
  readonly maxPlayers: number;
  /** True when the device still keeps a local record of the run. */
  readonly keepsLocalRecord: boolean;
}

const NOTHING = 'Nothing — this match does not count towards your account';

/**
 * Turn a (mode, match type) pair into every string the UI needs. Pure, so the
 * wording is testable without a DOM, and so there is exactly one place that
 * decides how the trust table reads in English.
 */
export function matchTypeSummary(modeId: ModeId, matchType: MatchType): MatchTypeSummary {
  const policy = trustPolicyFor(modeId, matchType);
  const counts = policy.grants !== REWARD_NONE;
  const rewards = rewardNames(policy.grants);
  const hostName = TOPOLOGY_NAMES[policy.topology] ?? 'Unknown host';
  const typeName = MATCH_TYPE_NAMES[matchType] ?? 'Unknown';

  return Object.freeze({
    modeId,
    matchType,
    policy,
    tone: counts ? 'counts' : 'unranked',
    typeName,
    hostName,
    verdict: counts ? 'COUNTS' : 'UNRANKED',
    chipLine: `${hostName} · ${typeName}`,
    rewards: Object.freeze(rewards),
    rewardLine: rewards.length > 0 ? rewards.join(', ') : NOTHING,
    playerNote: policy.playerNote,
    warning: counts ? '' : warningFor(policy),
    maxPlayers: policy.maxPlayers,
    keepsLocalRecord: hasWrite(policy.writes, WRITE_LOCAL_RECORD),
  });
}

/**
 * The sentence an unranked row leads with. It names the *reason*, because
 * "unranked" on its own reads as a penalty and gets argued with; "another
 * player's computer is running this match" does not.
 */
function warningFor(policy: TrustPolicy): string {
  switch (policy.topology) {
    case Topology.PEER_HOSTED:
      return 'One of the players is hosting this match, so we cannot verify the result. '
        + 'No XP, Scrap, drops or leaderboard place.';
    case Topology.CLIENT_LOCAL:
      return 'This match runs entirely on your own device, so we cannot verify the result. '
        + 'No XP, Scrap, drops or leaderboard place.';
    default:
      return 'You chose who is in this match, so results are not counted. '
        + 'No XP, Scrap, drops or leaderboard place.';
  }
}

/** One line for under the play button. Short enough to actually be read. */
export function describeBeforePlay(modeId: ModeId, matchType: MatchType): string {
  const s = matchTypeSummary(modeId, matchType);
  if (s.tone === 'counts') return `${s.hostName} · rewards count`;
  return `${s.hostName} · unranked · no rewards`;
}

/** "Quest · Co-op · up to 4 players". For a lobby header. */
export function describeLobby(modeId: ModeId, matchType: MatchType): string {
  const s = matchTypeSummary(modeId, matchType);
  const players = s.maxPlayers > 1 ? `up to ${s.maxPlayers} players` : 'solo';
  return `${getMode(modeId).name} · ${s.typeName} · ${players}`;
}

/** Every match type a mode offers, summarised. Drives the picker. */
export function summariesFor(modeId: ModeId): MatchTypeSummary[] {
  return matchTypesFor(modeId).map((t) => matchTypeSummary(modeId, t));
}

/**
 * The match type to preselect: the best-rewarding one the mode offers, so the
 * default is never silently the one that pays nothing. A player who wants a
 * private game will go and pick it; a player who does not care should not be
 * quietly dropped into an unranked room.
 */
export function defaultMatchTypeFor(modeId: ModeId): MatchType {
  const all = summariesFor(modeId);
  let best: MatchTypeSummary | null = null;
  for (const s of all) {
    // Competition rooms are scheduled, never a default. Otherwise: most rewards win.
    if (s.matchType === MatchType.COMPETITION) continue;
    if (best === null || s.rewards.length > best.rewards.length) best = s;
  }
  return best !== null ? best.matchType : (all[0]?.matchType ?? MatchType.SOLO);
}

/* ------------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-matchtype-css';
let styleUsers = 0;

export const MATCH_TYPE_CSS = `
.dcmt{--dcmt-ink:#e8e6e3;--dcmt-dim:#938e89;--dcmt-line:rgba(255,255,255,.13);
  --dcmt-ok:#4fb84a;--dcmt-warn:#f0a020;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--dcmt-ink)}
.dcmt *{box-sizing:border-box}

/* ---- chip ---- */
.dcmt-chip{display:inline-flex;align-items:center;gap:8px;min-height:28px;padding:4px 10px;
  border:1px solid var(--dcmt-line);border-radius:2px;background:rgba(8,8,12,.72);
  font:600 11px/1.2 system-ui;letter-spacing:.07em;white-space:nowrap}
.dcmt-chip[data-tone="counts"]{border-color:rgba(79,184,74,.55);background:rgba(79,184,74,.12)}
.dcmt-chip[data-tone="unranked"]{border-color:rgba(240,160,32,.6);background:rgba(240,160,32,.13)}
.dcmt-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:var(--dcmt-dim)}
.dcmt-chip[data-tone="counts"] .dcmt-dot{background:var(--dcmt-ok)}
.dcmt-chip[data-tone="unranked"] .dcmt-dot{background:var(--dcmt-warn)}
.dcmt-verdict{font-weight:800;letter-spacing:.13em}
.dcmt-chip[data-tone="counts"] .dcmt-verdict{color:#a6e7a2}
.dcmt-chip[data-tone="unranked"] .dcmt-verdict{color:#ffcf87}
.dcmt-host{color:var(--dcmt-dim);font-weight:600}
.dcmt-chip[data-compact="true"]{min-height:22px;padding:2px 7px;font-size:9.5px;gap:5px}
.dcmt-chip[data-compact="true"] .dcmt-host{display:none}

/* ---- notice ---- */
.dcmt-notice{display:flex;gap:10px;padding:10px 12px;border-radius:3px;
  border:1px solid var(--dcmt-line);background:rgba(255,255,255,.03)}
.dcmt-notice[data-tone="unranked"]{border-color:rgba(240,160,32,.45);background:rgba(240,160,32,.09)}
.dcmt-notice[data-tone="counts"]{border-color:rgba(79,184,74,.35);background:rgba(79,184,74,.07)}
.dcmt-bar{width:3px;border-radius:2px;flex:0 0 3px;background:var(--dcmt-warn)}
.dcmt-notice[data-tone="counts"] .dcmt-bar{background:var(--dcmt-ok)}
.dcmt-notice-body{display:flex;flex-direction:column;gap:3px;min-width:0}
.dcmt-notice-head{font:700 11px/1.2 system-ui;letter-spacing:.14em;text-transform:uppercase}
.dcmt-notice[data-tone="unranked"] .dcmt-notice-head{color:#ffcf87}
.dcmt-notice[data-tone="counts"] .dcmt-notice-head{color:#a6e7a2}
.dcmt-notice-text{font-size:12px;color:#b4aea8;line-height:1.45}
.dcmt-rewards{font-size:11px;color:var(--dcmt-dim);letter-spacing:.03em}
.dcmt-rewards b{color:#d4cfc9;font-weight:600}

/* ---- picker ---- */
.dcmt-picker{display:flex;flex-direction:column;gap:6px}
.dcmt-opt{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:11px;
  width:100%;min-height:52px;padding:9px 12px;text-align:left;cursor:pointer;
  background:rgba(255,255,255,.025);border:1px solid transparent;border-radius:3px;
  color:inherit;font:inherit}
.dcmt-opt:hover{background:rgba(255,255,255,.06)}
.dcmt-opt:focus-visible{outline:2px solid #fff;outline-offset:2px}
.dcmt-opt[aria-checked="true"]{border-color:rgba(255,255,255,.34);background:rgba(255,255,255,.07)}
.dcmt-opt[aria-checked="true"][data-tone="counts"]{border-color:var(--dcmt-ok);
  background:rgba(79,184,74,.12)}
.dcmt-opt[aria-checked="true"][data-tone="unranked"]{border-color:var(--dcmt-warn);
  background:rgba(240,160,32,.11)}
.dcmt-opt-main{min-width:0}
.dcmt-opt-name{display:block;font:700 13px/1.15 system-ui;letter-spacing:.04em;color:#e8e6e3}
.dcmt-opt-sub{display:block;margin-top:2px;font-size:10.5px;color:#77726d;
  overflow:hidden;text-overflow:ellipsis}
.dcmt-opt-pay{text-align:right;font:600 10px/1.3 system-ui;letter-spacing:.09em;
  text-transform:uppercase;white-space:nowrap}
.dcmt-opt[data-tone="counts"] .dcmt-opt-pay{color:#a6e7a2}
.dcmt-opt[data-tone="unranked"] .dcmt-opt-pay{color:#ffcf87}

@media (max-width:560px){
  .dcmt-opt{grid-template-columns:auto 1fr;row-gap:4px}
  .dcmt-opt-pay{grid-column:2;text-align:left}
}
@media (prefers-reduced-motion:reduce){
  .dcmt-opt{transition:none}
}
`;

function ensureStyle(): void {
  let node = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (node === null) {
    node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = MATCH_TYPE_CSS;
    document.head.appendChild(node);
  }
  styleUsers++;
}
function releaseStyle(): void {
  styleUsers--;
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}

/* ------------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ------------------------------------------------------------------------ *
 * The chip — for the HUD and the lobby header
 * ------------------------------------------------------------------------ */

export interface MatchTypeBadgeOptions {
  modeId: ModeId;
  matchType: MatchType;
  /** Drop the host name and shrink. For the in-match HUD corner. */
  compact?: boolean;
}

/**
 * A one-line chip: a coloured dot, COUNTS or UNRANKED, and who is hosting.
 *
 * Mount the compact form in the HUD and leave it there for the whole match.
 * It is four words and it removes an entire class of complaint.
 */
export class MatchTypeBadge {
  readonly element: HTMLElement;

  private readonly verdictEl: HTMLElement;
  private readonly hostEl: HTMLElement;
  private summary: MatchTypeSummary;
  private destroyed = false;

  constructor(opts: MatchTypeBadgeOptions) {
    ensureStyle();
    this.summary = matchTypeSummary(opts.modeId, opts.matchType);

    const root = el('span', 'dcmt dcmt-chip');
    root.dataset.compact = opts.compact === true ? 'true' : 'false';
    root.appendChild(el('span', 'dcmt-dot'));
    this.verdictEl = el('span', 'dcmt-verdict');
    this.hostEl = el('span', 'dcmt-host');
    root.appendChild(this.verdictEl);
    root.appendChild(this.hostEl);
    this.element = root;
    this.paint();
  }

  /** Re-point at another (mode, match type). Cheap; no re-allocation. */
  update(modeId: ModeId, matchType: MatchType): void {
    if (this.destroyed) return;
    this.summary = matchTypeSummary(modeId, matchType);
    this.paint();
  }

  private paint(): void {
    const s = this.summary;
    this.element.dataset.tone = s.tone;
    this.verdictEl.textContent = s.verdict;
    this.hostEl.textContent = s.chipLine;
    // The accessible name carries the whole truth, because the chip is short
    // and a screen reader user gets no colour at all.
    this.element.setAttribute('role', 'status');
    this.element.setAttribute(
      'aria-label',
      `${s.chipLine}. ${s.tone === 'counts' ? `Rewards: ${s.rewardLine}.` : s.warning}`,
    );
    this.element.title = s.tone === 'counts' ? `Rewards: ${s.rewardLine}` : s.warning;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    releaseStyle();
  }
}

/* ------------------------------------------------------------------------ *
 * The notice — the block above the play button
 * ------------------------------------------------------------------------ */

/**
 * The full-sentence version, for the moment of commitment. Shows the row's own
 * `playerNote` verbatim — the wording lives in the trust table so that changing
 * a policy and changing what the player is told are the same edit.
 */
export class MatchTypeNotice {
  readonly element: HTMLElement;

  private readonly headEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly rewardEl: HTMLElement;
  private destroyed = false;

  constructor(modeId: ModeId, matchType: MatchType) {
    ensureStyle();
    const root = el('div', 'dcmt dcmt-notice');
    root.appendChild(el('span', 'dcmt-bar'));
    const body = el('div', 'dcmt-notice-body');
    this.headEl = el('div', 'dcmt-notice-head');
    this.textEl = el('div', 'dcmt-notice-text');
    this.rewardEl = el('div', 'dcmt-rewards');
    body.appendChild(this.headEl);
    body.appendChild(this.textEl);
    body.appendChild(this.rewardEl);
    root.appendChild(body);
    this.element = root;
    this.update(modeId, matchType);
  }

  update(modeId: ModeId, matchType: MatchType): void {
    if (this.destroyed) return;
    const s = matchTypeSummary(modeId, matchType);
    this.element.dataset.tone = s.tone;
    this.headEl.textContent = `${s.verdict} · ${s.chipLine}`;
    this.textEl.textContent = s.tone === 'counts' ? s.playerNote : s.warning;

    this.rewardEl.replaceChildren();
    this.rewardEl.appendChild(el('span', undefined, 'You earn: '));
    this.rewardEl.appendChild(el('b', undefined, s.rewardLine));
    if (s.tone === 'unranked' && s.keepsLocalRecord) {
      this.rewardEl.appendChild(el('span', undefined, ' · your best time is still saved on this device'));
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    releaseStyle();
  }
}

/* ------------------------------------------------------------------------ *
 * The picker
 * ------------------------------------------------------------------------ */

export interface MatchTypePickerOptions {
  modeId: ModeId;
  /** Preselected type. Defaults to `defaultMatchTypeFor(modeId)`. */
  selected?: MatchType;
  /** Types the player cannot pick right now, e.g. no scheduled event. */
  disabled?: readonly MatchType[];
  onChange?(matchType: MatchType, summary: MatchTypeSummary): void;
}

/**
 * A radio group over the match types a mode offers. Each row names the host and
 * what it pays, so the unranked choice is a choice rather than a surprise.
 *
 * The rows come from `matchTypesFor()`. A mode cannot show an option the trust
 * table has no row for, and a row added to the table appears here with no edit.
 */
export class MatchTypePicker {
  readonly element: HTMLElement;

  private readonly opts: MatchTypePickerOptions;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly types: MatchType[] = [];
  private selected: MatchType;
  private destroyed = false;

  constructor(opts: MatchTypePickerOptions) {
    ensureStyle();
    this.opts = opts;

    const root = el('div', 'dcmt dcmt-picker');
    root.setAttribute('role', 'radiogroup');
    root.setAttribute('aria-label', `${getMode(opts.modeId).name} match type`);

    const summaries = summariesFor(opts.modeId);
    const disabled = new Set(opts.disabled ?? []);
    this.selected = opts.selected !== undefined && summaries.some((s) => s.matchType === opts.selected)
      ? opts.selected
      : defaultMatchTypeFor(opts.modeId);

    for (const s of summaries) {
      const b = el('button', 'dcmt-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.tone = s.tone;
      b.disabled = disabled.has(s.matchType);

      b.appendChild(el('span', 'dcmt-dot'));

      const main = el('span', 'dcmt-opt-main');
      main.appendChild(el('span', 'dcmt-opt-name', s.typeName));
      main.appendChild(el('span', 'dcmt-opt-sub', s.playerNote));
      b.appendChild(main);

      b.appendChild(el('span', 'dcmt-opt-pay', s.tone === 'counts' ? 'Rewards count' : 'No rewards'));
      b.setAttribute('aria-label', `${s.typeName}. ${s.chipLine}. ${s.tone === 'counts'
        ? `Rewards: ${s.rewardLine}.` : s.warning}`);

      b.addEventListener('click', () => { this.select(s.matchType); });
      root.appendChild(b);
      this.buttons.push(b);
      this.types.push(s.matchType);
    }

    root.addEventListener('keydown', (ev: KeyboardEvent) => { this.onKey(ev); });

    this.element = root;
    this.paint();
  }

  get value(): MatchType { return this.selected; }

  select(matchType: MatchType): void {
    if (this.destroyed) return;
    const i = this.types.indexOf(matchType);
    if (i < 0 || this.buttons[i].disabled) return;
    if (this.selected === matchType) return;
    this.selected = matchType;
    this.paint();
    this.opts.onChange?.(matchType, matchTypeSummary(this.opts.modeId, matchType));
  }

  private onKey(ev: KeyboardEvent): void {
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1
      : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    ev.preventDefault();
    const n = this.types.length;
    let i = this.types.indexOf(this.selected);
    for (let tries = 0; tries < n; tries++) {
      i = (i + step + n) % n;
      if (!this.buttons[i].disabled) { this.select(this.types[i]); this.buttons[i].focus(); return; }
    }
  }

  private paint(): void {
    for (let i = 0; i < this.buttons.length; i++) {
      const on = this.types[i] === this.selected;
      this.buttons[i].setAttribute('aria-checked', on ? 'true' : 'false');
      this.buttons[i].tabIndex = on ? 0 : -1;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    releaseStyle();
  }
}

/* ------------------------------------------------------------------------ *
 * Peer-host eligibility, said in plain words
 * ------------------------------------------------------------------------ */

/**
 * Why this device is or is not allowed to host a peer match. A player whose
 * phone is refused as host deserves a reason, and "your phone will drop the
 * match when a call comes in" is a reason they will accept.
 */
export interface HostEligibility {
  readonly eligible: boolean;
  readonly reason: string;
}

export interface HostProbe {
  /** True for a phone or a tablet. iOS suspends background JS within seconds. */
  isMobile: boolean;
  /** Measured uplink in bits/s, or 0 when unknown. */
  uplinkBps?: number;
}

/**
 * The hard rule from `docs/P2P.md`: **a phone is never a host, at any size.**
 * Not bandwidth — a backgrounded desktop tab keeps ticking because the room
 * runs in a dedicated Worker, but iOS Safari suspends background JS in seconds,
 * so one incoming call ends the match for everybody in the room.
 */
export function describeHostEligibility(probe: HostProbe): HostEligibility {
  if (probe.isMobile) {
    return {
      eligible: false,
      reason: 'Phones cannot host: a call or switching apps would end the match for everyone. '
        + `You can still join a friend's game, up to ${PEER_MAX_PLAYERS} players.`,
    };
  }
  const up = probe.uplinkBps ?? 0;
  if (up > 0 && up < 3_000_000) {
    return {
      eligible: false,
      reason: 'Your upload speed is too low to host. You can still join a friend\'s game.',
    };
  }
  return { eligible: true, reason: `You can host, up to ${PEER_MAX_PLAYERS} players.` };
}
