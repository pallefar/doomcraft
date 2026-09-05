/**
 * DOOMCRAFT — the client half of the ad pipeline (docs/SPONSORS.md §2.4).
 *
 * One decision per slot per SCREEN ENTRY, cached for the visit — no timed
 * refresh while a player reads the menu. The server chooses every fill; this
 * module renders what it was handed, measures it with the §3.2 meter, and
 * reports events against the fill's nonce. With no server configured, no
 * flag, or ads removed, none of this runs and the menu is exactly what it
 * was before this file existed.
 *
 * Two kinds of surface flow through here, and the split matters (§3.2):
 *  - the three reserved `#ads` slots — genuine ad-network inventory, honest
 *    ids, blockable, measured under the menu gate;
 *  - the first-party text surfaces — the S3 mode-tile badge and the S4 boot
 *    line — which are content in `#ui`/`#boot`, direct-sold text only, never
 *    house-filled, and measured under the gate of the screen they live on.
 */

import {
  AD_INTERSTITIAL_AFTER_DEATHS, AD_INTERSTITIAL_MAX_SECONDS, AD_OVERLAY_ID,
} from '@doomcraft/shared/constants';
import { AD_MODE_UNKNOWN, SurfaceId, type AdFill } from '@doomcraft/shared/sponsor';

import { detectBlocked, observeSlot, type ObservedSlot } from './viewability';

const SLOT_FOR_SURFACE: Readonly<Partial<Record<SurfaceId, string>>> = Object.freeze({
  [SurfaceId.MENU_TOP]: 'ad-slot-top',
  [SurfaceId.MENU_SIDE]: 'ad-slot-side',
  [SurfaceId.MENU_BOTTOM]: 'ad-slot-bottom',
});

/** The menu-entry decide set: the three reserved slots plus the S3 badge. */
export const MENU_DECIDE_SURFACES: readonly SurfaceId[] = Object.freeze([
  SurfaceId.MENU_TOP, SurfaceId.MENU_SIDE, SurfaceId.MENU_BOTTOM, SurfaceId.MODE_TILE,
]);

/**
 * What a first-party text surface may render, or null. S3 and S4 accept only
 * a direct-sold text creative with an actual line — there is no house filler
 * for either by design (a house badge on a mode tile would be self-promotion
 * wearing a disclosure label), and an asset kind cannot serve before §2.2.
 */
export function textFillOrNull(fill: AdFill | null | undefined): AdFill | null {
  if (fill === null || fill === undefined) return null;
  if (fill.source !== 'direct' || fill.kind !== 'text') return null;
  if (fill.text.length === 0) return null;
  return fill;
}

/**
 * Does this fill render its OWN creative into the slot?
 *
 * A direct-sold display or text creative replaces what is there. A house fill
 * writes nothing on purpose — the house card is already rendered, already
 * labelled, and already the fallback by construction — and so does a direct
 * display whose bytes have not arrived.
 */
export function writesOwnCreative(fill: AdFill): boolean {
  if (fill.source !== 'direct') return false;
  if (fill.kind === 'text') return true;
  return fill.kind === 'display' && fill.assetUrl.length > 0;
}

/**
 * Must the slot be handed back to the house card BEFORE this fill is measured?
 *
 * True exactly when the slot still shows some other fill's creative and this
 * fill will not overwrite it. That is the state in which a meter attributes one
 * sponsor's pixels to another fill's nonce: visit one renders campaign A, visit
 * two is frequency-capped to HOUSE, A's art is still on screen, and the house
 * nonce collects A's exposure. The report then credits unsold inventory with a
 * sponsor's delivery and the sponsor's own numbers lose it.
 */
export function mustReleaseBefore(currentOwner: string, fill: AdFill): boolean {
  if (writesOwnCreative(fill)) return false;
  return currentOwner !== '' && currentOwner !== fill.nonce;
}

/**
 * Is this image completion stale — i.e. did the slot move on to another fill
 * while the bytes were in flight? A late `onload` from an earlier menu visit
 * must not drop its image into a later visit's slot.
 */
export function staleCompletion(currentOwner: string, fill: AdFill): boolean {
  return currentOwner !== fill.nonce;
}

/**
 * What the S10 interstitial renders, or null to refuse.
 *
 * Refuses HOUSE outright. The interstitial is the one surface that interrupts a
 * player who did not ask for anything, and interrupting them to show our own
 * card is pure cost with no revenue against it. The server already declines to
 * mint a house interstitial (the house floor is the menu slots and the
 * intermission card); this is the client refusing to render one if it ever
 * arrives, because a surface this intrusive should fail closed at both ends.
 */
export interface InterstitialModel {
  label: string;
  text: string;
  altText: string;
  /** Non-empty only for a display creative with an uploaded asset. */
  imgUrl: string;
  /** Non-empty only when the creative has a click destination. */
  href: string;
}

export function interstitialModel(fill: AdFill | null | undefined): InterstitialModel | null {
  if (fill === null || fill === undefined) return null;
  if (fill.source !== 'direct') return null;
  const isDisplay = fill.kind === 'display' && fill.assetUrl.length > 0;
  const isText = fill.kind === 'text' && fill.text.length > 0;
  if (!isDisplay && !isText) return null;
  // Accessibility is an ANTI-FRAUD measure here as well as a legal one: a
  // creative nobody can describe is a creative nobody can prove was seen.
  if (isDisplay && fill.altText.length === 0) return null;
  return {
    label: fill.label || 'Sponsored',
    text: fill.text,
    altText: fill.altText,
    imgUrl: isDisplay ? fill.assetUrl : '',
    href: fill.clickUrl,
  };
}

/**
 * May the player dismiss the interstitial yet?
 *
 * From the FIRST SECOND, and that number is not a preference. The UK Age
 * Appropriate Design Code names "a countdown interstitial with a low-contrast
 * or delayed skip control" as a nudge pattern, and docs/SPONSORS.md §5.3 cites
 * it directly. A skip that appears late is the pattern being legislated against.
 */
export const AD_SKIP_ENABLED_AFTER_MS = 1_000;

export function skipAllowedAt(elapsedMs: number): boolean {
  return elapsedMs >= AD_SKIP_ENABLED_AFTER_MS;
}

/**
 * Should a between-match interstitial even be asked for?
 *
 * `adsRemoved` short-circuits BEFORE the decision call, which docs/SPONSORS.md
 * requires in as many words: the purchase buys silence on the network, so a
 * player who paid must not generate a decide at all, not merely be refused one.
 */
export function interstitialWanted(
  adsRemoved: boolean, flagOn: boolean, deathsSinceLast: number, afterDeaths: number,
): boolean {
  if (adsRemoved) return false;
  if (!flagOn) return false;
  return deathsSinceLast >= afterDeaths;
}

/**
 * What the S11 rewarded prompt offers, or null to refuse.
 *
 * Unlike the interstitial, a HOUSE fill is fine here and an absent fill is
 * fine too — because the reward is not the ad, it is the grant, and §1a is
 * explicit that a player who bought ads off must still see the button and be
 * paid ("included with your purchase — no video required"). Removing the
 * reward with the ads would make the $4.99 purchase leave them strictly worse
 * off, which is the worst possible shape for a monetisation design.
 */
export interface RewardOffer {
  /** Empty for the ad-free path: there is nothing to show, only a grant. */
  text: string;
  imgUrl: string;
  altText: string;
  label: string;
  /** True when the player owns ads-off and is paid without watching. */
  instant: boolean;
}

export function rewardOffer(fill: AdFill | null | undefined, adsRemoved: boolean): RewardOffer {
  if (adsRemoved) {
    return { text: '', imgUrl: '', altText: '', label: '', instant: true };
  }
  const f = fill ?? null;
  if (f === null) return { text: '', imgUrl: '', altText: '', label: '', instant: false };
  const isDisplay = f.kind === 'display' && f.assetUrl.length > 0;
  return {
    text: f.text,
    imgUrl: isDisplay ? f.assetUrl : '',
    altText: f.altText,
    label: f.label || 'Sponsored',
    instant: false,
  };
}

/** Seconds still to watch, for the countdown the player is promised. */
export function rewardSecondsLeft(elapsedMs: number, minMs: number): number {
  return Math.max(0, Math.ceil((minMs - elapsedMs) / 1000));
}

export interface AdPipelineOptions {
  /** '' = static build with no server: the pipeline never activates. */
  serverBase: string;
  deviceId: () => string;
  /** The server-resolved sponsor_slots kill switch. */
  enabled: () => boolean;
  adsRemoved: () => boolean;
  platform: 'desktop' | 'mobile';
  /**
   * S3: render the badge for a MODE_TILE fill and return the element for the
   * meter, or null to refuse (unknown tile, tile already carries a badge).
   * A refusal renders nothing and therefore counts nothing.
   */
  onModeTile?: (fill: AdFill) => HTMLElement | null;
  /** S3: take the badge down on menu exit. The next entry re-decides. */
  clearModeTile?: () => void;
  /** S4: the live `.boot-tip` element while the boot screen is up, else null. */
  bootTip?: () => HTMLElement | null;
  /**
   * Put the house creative back into any reserved slot that is empty.
   *
   * Needed because a direct-sold creative REPLACES the house card, and the
   * house card is the honest resting state of a slot. Without this, a slot that
   * once carried a sponsor keeps carrying it after the pipeline lets go — shown
   * to the player, measured for nobody, and available to be measured under the
   * NEXT fill's nonce. `main.ts`'s `fillAdSlots` is idempotent (it skips a slot
   * that has children), so this is safe to call whenever.
   */
  restoreHouse?: () => void;
  /** S10: the server-resolved `sponsor_interstitial` kill switch. */
  interstitialEnabled?: () => boolean;
  /** S10: deaths since the last interstitial — only the client can know this. */
  deathsSinceInterstitial?: () => number;
  /** S10: called when the overlay opens and closes, for render throttling. */
  onInterstitial?: (open: boolean) => void;
  /** S11: the server-resolved `sponsor_rewarded` kill switch. */
  rewardedEnabled?: () => boolean;
}

/**
 * What an INTERMISSION_CARD fill renders (S12), decided as pure data so a
 * DOM-less runner can prove the refusals. `href` is non-empty only for an
 * interactive mount — the deathmatch card lives in `#hud`, which is
 * `pointer-events:none` by contract, and an anchor nobody can click would
 * still read as one.
 */
export interface InterCardModel {
  kind: 'house' | 'text' | 'img';
  label: string;
  /** The line for text cards; the alt text for img cards. */
  text: string;
  href: string;
  /** `/cdn/crv/…` for img cards, '' otherwise (§2.2). */
  src: string;
}

export function interCardModel(fill: AdFill | null | undefined, interactive: boolean): InterCardModel | null {
  if (fill === null || fill === undefined) return null;
  if (fill.surface !== SurfaceId.INTERMISSION_CARD) return null;
  if (fill.source === 'house') {
    return { kind: 'house', label: 'DOOMCRAFT', text: 'Sponsor-free results for ad-free players.', href: '', src: '' };
  }
  if (fill.source === 'direct' && fill.kind === 'display' && fill.assetUrl.length > 0) {
    return {
      kind: 'img',
      label: fill.label || 'Sponsored',
      text: fill.altText,
      href: interactive && fill.clickUrl.length > 0 ? fill.clickUrl : '',
      src: fill.assetUrl,
    };
  }
  const line = textFillOrNull(fill);
  if (line === null) return null;
  return {
    kind: 'text',
    label: line.label || 'Sponsored',
    text: line.text,
    href: interactive && line.clickUrl.length > 0 ? line.clickUrl : '',
    src: '',
  };
}

export interface IntermissionCardOptions {
  /** The mode whose intermission this is — campaign mode-targeting applies. */
  mode: number;
  /**
   * Whether the mount can take a click. Quest's intermission is in `#ui`
   * (yes); the deathmatch scoreboard is in `#hud`, never interactive (no).
   */
  interactive: boolean;
  /** The §3.2 screen gate: is the intermission actually open right now. */
  active: () => boolean;
}

export interface AdPipeline {
  onMenuEnter(): void;
  onMenuExit(): void;
  /**
   * Call once the server-resolved flags are known (SESSION_CONFIG) — the
   * earliest moment the kill switch is answerable. Idempotent. If the boot
   * screen is already gone by then, or the decide loses the race to it,
   * nothing is shown (§4.3: a sponsor line must never wait for the game).
   */
  onBootReady(): void;
  /**
   * S12 — one decision per intermission, rendered into `mount`, measured
   * until the returned disposer runs (which also flushes exposure and empties
   * the mount). Ads-off / removed / flag-off return a working no-op disposer.
   */
  intermissionCard(mount: HTMLElement, options: IntermissionCardOptions): () => void;
  /**
   * S10 — offer a between-match interstitial; resolves to whether one opened.
   * Every refusal path resolves false, so a caller can always await it without
   * a branch and without a try.
   */
  maybeInterstitial(): Promise<boolean>;
  /**
   * S11 — render the rewarded button into `mount`; the disposer removes it.
   * Refusals (flag off, offline) render nothing and return a working no-op.
   */
  rewardButton(mount: HTMLElement, onResult?: (r: { ok: boolean; reason: string; scrap: number }) => void): () => void;
  /** Close an open interstitial from outside (pause, teardown, route change). */
  closeInterstitial(): void;
}

interface WatchedFill {
  watched: ObservedSlot;
  fill: AdFill;
}

export function createAdPipeline(opts: AdPipelineOptions): AdPipeline {
  const sessionId = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  let menuWatched: WatchedFill[] = [];
  let bootWatched: WatchedFill | null = null;
  let bootTried = false;
  let inMenu = false;
  let menuDecided = false;
  let flagProbe: Promise<Record<string, unknown>> | null = null;

  const api = (path: string): string => `${opts.serverBase}${path}`;
  const offline = (): boolean => opts.serverBase === '' && location.origin === 'null';

  /**
   * Is sponsor_slots on? The session bits answer instantly when they say yes —
   * but on the MENU they come from the local boot session (a Worker), which
   * never carries the flag, so "the bits say no" really means "the bits cannot
   * know". One GET of the server's own `/api/flags` per page answers it; the
   * kill switch still kills, because a killed flag is false in BOTH sources.
   */
  /**
   * ONE probe, shared. Rule 15: menu-time flag bits lie, so every sponsor
   * surface is gated on the server's answer — but a second surface must not
   * mean a second cache, or the two can disagree about the same fetch.
   */
  function serverFlags(): Promise<Record<string, unknown>> {
    if (flagProbe === null) {
      flagProbe = fetch(api('/api/flags'))
        .then(async (res) => {
          if (!res.ok) return {};
          const body = await res.json() as { flags?: Record<string, unknown> };
          return body.flags ?? {};
        })
        .catch(() => ({}));
    }
    return flagProbe;
  }

  function flagOnNow(name: string, local: boolean): Promise<boolean> {
    if (local) return Promise.resolve(true);
    return serverFlags().then((f) => f[name] === true);
  }

  function enabledNow(): Promise<boolean> {
    return flagOnNow('sponsor_slots', opts.enabled());
  }

  function post(path: string, body: unknown, useBeacon = false): void {
    const json = JSON.stringify(body);
    if (useBeacon && 'sendBeacon' in navigator) {
      navigator.sendBeacon(api(path), new Blob([json], { type: 'application/json' }));
      return;
    }
    void fetch(api(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json,
      keepalive: true,
    }).catch(() => { /* a lost event is a lost event; it can only under-count */ });
  }

  /**
   * `AD_MODE_UNKNOWN`, never 0. `ModeId.QUEST` IS 0, so defaulting to it made a
   * menu decision — which has no play mode at all — indistinguishable from a
   * Quest one, and every menu impression would have been reported as Quest
   * reach. The dashboard's mode breakdown is only worth printing if the absence
   * of a mode is representable.
   */
  function decide(surfaces: readonly SurfaceId[], mode: number = AD_MODE_UNKNOWN): Promise<AdFill[]> {
    return fetch(api('/api/ads/decide'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: opts.deviceId(),
        sessionId,
        surfaces,
        mode,
        platform: opts.platform,
      }),
    }).then(async (res) => {
      if (!res.ok) return [];
      const body = await res.json() as { fills: AdFill[] };
      return Array.isArray(body.fills) ? body.fills : [];
    });
  }

  function watch(el: HTMLElement, fill: AdFill, active?: () => boolean): WatchedFill {
    const watched = observeSlot(el, (e) => {
      post('/api/ads/event', { nonce: fill.nonce, type: e.type, ms: Date.now(), exposureMs: e.exposureMs });
    }, active === undefined ? {} : { active });
    return { watched, fill };
  }

  function flush(entry: WatchedFill): void {
    const exposureMs = entry.watched.meter.flush();
    if (exposureMs > 0) {
      post('/api/ads/event', { nonce: entry.fill.nonce, type: 'exposure', ms: Date.now(), exposureMs }, true);
    }
    /* The terminal verdict, and the reason this slot's teardown is worth a
     * network call: without it the log records viewable impressions and nothing
     * else, so Viewable Rate has no denominator and Non-Viewable is a bucket
     * that can never be filled. Sent with `keepalive` (the `true`), because the
     * commonest teardown is the player leaving. */
    const v = entry.watched.meter.verdict();
    post('/api/ads/event', {
      nonce: entry.fill.nonce, type: 'verdict', ms: Date.now(),
      exposureMs: v.exposureMs, qualified: v.qualified, basis: v.basis, reason: v.reason,
    }, true);
    entry.watched.disconnect();
  }

  function flushBoot(): void {
    if (bootWatched === null) return;
    flush(bootWatched);
    bootWatched = null;
  }

  /**
   * THE SLOT SAYS WHOSE PIXELS IT IS SHOWING.
   *
   * A direct creative replaces the house card, and nothing used to put the
   * house card back. So: visit one renders campaign A; the player leaves; on
   * visit two A is frequency-capped and the server allocates HOUSE — and
   * because a house fill deliberately leaves existing content alone, A's art is
   * still on screen while a new observer measures it under the HOUSE nonce.
   * The report then attributes a sponsor's exposure to unsold inventory, and
   * the sponsor's own numbers lose it. A late `img.onload` from an earlier
   * visit could land in a later visit's slot the same way.
   *
   * The marker makes that impossible to express: content is stamped with the
   * nonce that wrote it, a stale completion is dropped, and a fill that writes
   * nothing refuses to be measured over somebody else's creative.
   */
  function ownedBy(slot: HTMLElement): string {
    return slot.dataset.adFill ?? '';
  }

  function releaseSlot(slot: HTMLElement): void {
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    delete slot.dataset.adFill;
  }

  /** Hand every reserved slot back to the house card. */
  function releaseAllSlots(): void {
    for (const id of Object.values(SLOT_FOR_SURFACE)) {
      const slot = id === undefined ? null : document.getElementById(id);
      if (slot !== null && ownedBy(slot) !== '') releaseSlot(slot);
    }
    opts.restoreHouse?.();
  }

  function applyFill(fill: AdFill): void {
    if (fill.surface === SurfaceId.MODE_TILE) {
      const line = textFillOrNull(fill);
      if (line === null) return;
      const badge = opts.onModeTile?.(line) ?? null;
      if (badge === null) return;
      menuWatched.push(watch(badge, fill));
      return;
    }

    const slotId = SLOT_FOR_SURFACE[fill.surface];
    if (slotId === undefined) return;
    const slot = document.getElementById(slotId);
    if (slot === null) return;

    // A direct-sold DISPLAY creative (§2.2): the slot empties NOW — measuring
    // the direct fill's nonce over the house art would be dishonest — and the
    // <img> lands only when its bytes have (creativeLoaded gates on children,
    // and "a creative that failed to load is not an impression", §3.2.6).
    // Never innerHTML: sponsor art is an src assignment, nothing else.
    if (fill.source === 'direct' && fill.kind === 'display' && fill.assetUrl.length > 0) {
      releaseSlot(slot);
      slot.dataset.adFill = fill.nonce;
      const img = document.createElement('img');
      img.className = 'dc-ad-img';
      img.alt = fill.altText;
      img.decoding = 'async';
      img.onload = (): void => {
        // Identity, not just emptiness: a completion from an EARLIER visit
        // would otherwise drop its bytes into a later visit's slot.
        if (!inMenu || slot.childElementCount > 0 || staleCompletion(ownedBy(slot), fill)) return;
        if (fill.clickUrl.length > 0) {
          const a = document.createElement('a');
          a.className = 'dc-ad-imglink';
          a.href = api(fill.clickUrl);
          a.target = '_blank';
          a.rel = 'noopener';
          a.appendChild(img);
          slot.appendChild(a);
        } else {
          slot.appendChild(img);
        }
      };
      img.src = api(fill.assetUrl);
    }

    // A direct-sold TEXT creative replaces the house card for this visit.
    // House fills leave the existing card exactly as it is — it is already
    // rendered, already labelled, and already the fallback by construction.
    if (fill.source === 'direct' && fill.kind === 'text') {
      releaseSlot(slot);
      slot.dataset.adFill = fill.nonce;
      const card = document.createElement(fill.clickUrl.length > 0 ? 'a' : 'div');
      card.className = 'dc-ad-house';
      if (card instanceof HTMLAnchorElement && fill.clickUrl.length > 0) {
        card.href = api(fill.clickUrl);
        card.target = '_blank';
        card.rel = 'noopener';
      }
      const inner = document.createElement('div');
      const label = document.createElement('b');
      label.textContent = fill.label || 'Sponsored';
      inner.appendChild(label);
      inner.appendChild(document.createTextNode(fill.text));
      card.appendChild(inner);
      slot.appendChild(card);
    }

    /* A fill that wrote no content of its own must not be measured over the
     * previous fill's creative. Hand the slot back to the house card first —
     * then what the meter sees belongs to this fill, whatever it is. */
    if (mustReleaseBefore(ownedBy(slot), fill)) {
      releaseSlot(slot);
      opts.restoreHouse?.();
    }

    menuWatched.push(watch(slot, fill));

    // The Blocked bucket: one rAF after fill, never in the frame loop.
    requestAnimationFrame(() => {
      if (detectBlocked(slot)) {
        post('/api/ads/event', { nonce: fill.nonce, type: 'blocked', ms: Date.now() });
      }
    });
  }

  /* ---- S10: the between-match interstitial ------------------------------ */

  let interOpen = false;
  let interWatched: WatchedFill | null = null;
  let interTimer = 0;
  let interReturnFocus: HTMLElement | null = null;
  let interSkipReady = false;

  function closeInterstitial(): void {
    if (!interOpen) return;
    interOpen = false;
    window.removeEventListener('keydown', onKeyDown, true);
    if (interTimer !== 0) { clearInterval(interTimer); interTimer = 0; }
    const host = document.getElementById(AD_OVERLAY_ID);
    if (host !== null) {
      host.dataset.open = '0';
      host.setAttribute('aria-hidden', 'true');
      host.removeAttribute('role');
      host.removeAttribute('aria-modal');
      host.removeAttribute('tabindex');
      while (host.firstChild) host.removeChild(host.firstChild);
    }
    if (interWatched !== null) { flush(interWatched); interWatched = null; }
    opts.onInterstitial?.(false);
    // Give the keyboard back to whatever had it. A modal that leaves focus on a
    // removed node strands a keyboard user on nothing at all.
    interReturnFocus?.focus?.();
    interReturnFocus = null;
  }

  function openInterstitial(fill: AdFill, model: InterstitialModel): void {
    const host = document.getElementById(AD_OVERLAY_ID);
    if (host === null || interOpen) return;
    interOpen = true;
    interSkipReady = false;
    interReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    while (host.firstChild) host.removeChild(host.firstChild);
    // Announced, not just visible. §5.5(10): the interstitial must be
    // keyboard-dismissible AND screen-reader-announced.
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', model.label + ' — press Escape to dismiss');
    host.setAttribute('aria-hidden', 'false');

    const card = document.createElement('div');
    card.className = 'dc-inter';

    const tag = document.createElement('b');
    tag.className = 'dc-inter-label';
    tag.textContent = model.label;
    card.appendChild(tag);

    const body = document.createElement(model.href.length > 0 ? 'a' : 'div');
    body.className = 'dc-inter-body';
    if (body instanceof HTMLAnchorElement && model.href.length > 0) {
      body.href = api(model.href);
      body.target = '_blank';
      body.rel = 'noopener';
    }
    if (model.imgUrl.length > 0) {
      const img = document.createElement('img');
      img.className = 'dc-inter-img';
      img.alt = model.altText;
      img.decoding = 'async';
      img.src = api(model.imgUrl);
      body.appendChild(img);
    } else {
      body.textContent = model.text;
    }
    card.appendChild(body);

    /* The skip control. Present from the first frame, high-contrast, and a real
     * <button> so it is in the tab order — a control a keyboard user cannot
     * reach is also a control we cannot prove a human used, which makes this an
     * anti-fraud measure as much as an accessibility one (§5.5(10)). */
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'dc-inter-skip';
    skip.textContent = 'Skip';
    skip.disabled = true;
    skip.addEventListener('click', () => { closeInterstitial(); });
    card.appendChild(skip);

    /* The countdown is its OWN line, never the button's label.
     *
     * "Skip (14s)" on the button reads as "wait fourteen seconds to skip" —
     * which is the delayed-skip pattern the Age Appropriate Design Code names,
     * accidentally described in words even though the control is live. The
     * button says what pressing it does; this says what happens if nobody does.
     * Found by looking at the screenshot. */
    const auto = document.createElement('div');
    auto.className = 'dc-inter-auto';
    card.appendChild(auto);

    host.appendChild(card);
    host.dataset.open = '1';
    window.addEventListener('keydown', onKeyDown, true);
    opts.onInterstitial?.(true);
    /* Focus the DIALOG first, not the button.
     *
     * The skip starts disabled for its first second, and a disabled button
     * cannot take focus — so focusing it here left the keyboard on nothing at
     * all, which is the precise harm §5.5(10) is about. The screenshot harness
     * caught it: `document.activeElement` was the body. So the container takes
     * focus (announcing the dialog), and focus moves to the skip the moment it
     * becomes usable. */
    host.tabIndex = -1;
    host.focus();

    interWatched = watch(host, fill, () => true);

    const startedMs = Date.now();
    const maxMs = AD_INTERSTITIAL_MAX_SECONDS * 1000;
    const tick = (): void => {
      const elapsed = Date.now() - startedMs;
      const left = Math.max(0, Math.ceil((maxMs - elapsed) / 1000));
      auto.textContent = left > 0 ? 'Closes automatically in ' + String(left) + 's' : '';
      if (skipAllowedAt(elapsed)) {
        const justEnabled = skip.disabled;
        skip.disabled = false;
        interSkipReady = true;
        // Hand the keyboard over exactly once, at the moment it can be used.
        if (justEnabled && interOpen) skip.focus();
      }
      if (elapsed >= maxMs) closeInterstitial();
    };
    interTimer = window.setInterval(tick, 250) as unknown as number;
    tick();
  }

  /**
   * The overlay owns the keyboard while it is up.
   *
   * In CAPTURE phase, and stopping propagation, for two reasons. The game binds
   * keys globally and swallowed Enter — so the focused, enabled, high-contrast
   * skip button could not actually be operated by a keyboard, which is the
   * §5.5(10) failure exactly (and, since a control we cannot prove a human used
   * is an anti-fraud hole, not only an accessibility one). The screenshot
   * harness caught it; no unit test could have. And a modal that lets the game
   * act on input behind it is not a modal.
   *
   * Every dismissal path obeys the same clock as the button.
   */
  function onKeyDown(e: KeyboardEvent): void {
    if (!interOpen) return;
    const dismiss = e.key === 'Escape' || e.key === 'Enter' || e.key === ' ';
    if (!dismiss) return;
    e.preventDefault();
    e.stopPropagation();
    if (!interSkipReady) return;
    closeInterstitial();
  }

  /* ---- S11: the rewarded watch ------------------------------------------ */

  async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(api(path), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), keepalive: true,
      });
      if (!res.ok) return {};
      return await res.json() as Record<string, unknown>;
    } catch { return {}; }
  }

  /**
   * Run one rewarded watch, start to grant.
   *
   * The client never asserts that it watched: it opens a session, sends
   * heartbeats the server may refuse, and asks. Every early exit resolves with
   * a reason, so the caller renders an outcome rather than a silence.
   */
  async function runReward(): Promise<{ ok: boolean; reason: string; scrap: number }> {
    const adsRemoved = opts.adsRemoved();
    const started = await postJson('/api/sponsor/reward/start', { deviceId: opts.deviceId() });
    if (started.ok !== true) return { ok: false, reason: 'unavailable', scrap: 0 };
    const rewardId = String(started.rewardId ?? '');
    const minMs = typeof started.minMs === 'number' ? started.minMs : 15_000;
    const beatMs = typeof started.beatMs === 'number' ? started.beatMs : 2_000;

    /* The ad-free path claims IMMEDIATELY. There is no video, so there is
     * nothing to watch and nothing to wait for; the server still applies every
     * cap, so this is faster, not freer. */
    if (adsRemoved) {
      const paid = await postJson('/api/sponsor/reward/claim', { deviceId: opts.deviceId(), rewardId });
      return {
        ok: paid.ok === true,
        reason: String(paid.reason ?? ''),
        scrap: typeof paid.scrap === 'number' ? paid.scrap : 0,
      };
    }

    const fills = await decide([SurfaceId.REWARDED]).catch(() => []);
    const offer = rewardOffer(fills[0], false);
    const watched = await openReward(offer, fills[0] ?? null, minMs, beatMs, rewardId);
    if (!watched) return { ok: false, reason: 'cancelled', scrap: 0 };

    const paid = await postJson('/api/sponsor/reward/claim', { deviceId: opts.deviceId(), rewardId });
    return {
      ok: paid.ok === true,
      reason: String(paid.reason ?? ''),
      scrap: typeof paid.scrap === 'number' ? paid.scrap : 0,
    };
  }

  /**
   * Show the watch and resolve true only if it ran to the end.
   *
   * A CANCEL control is present throughout and never disabled. This is
   * player-initiated, so requiring the full watch to be PAID is legitimate —
   * but requiring it to be endured is not, and a modal with no way out is a
   * trap whatever it is offering.
   */
  function openReward(
    offer: RewardOffer, fill: AdFill | null, minMs: number, beatMs: number, rewardId: string,
  ): Promise<boolean> {
    const host = document.getElementById(AD_OVERLAY_ID);
    if (host === null || interOpen) return Promise.resolve(false);
    interOpen = true;
    interSkipReady = false;
    interReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    while (host.firstChild) host.removeChild(host.firstChild);
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Rewarded ad — press Escape to cancel');
    host.setAttribute('aria-hidden', 'false');

    const card = document.createElement('div');
    card.className = 'dc-inter';
    if (offer.label.length > 0) {
      const tag = document.createElement('b');
      tag.className = 'dc-inter-label';
      tag.textContent = offer.label;
      card.appendChild(tag);
    }
    const body = document.createElement('div');
    body.className = 'dc-inter-body';
    if (offer.imgUrl.length > 0) {
      const img = document.createElement('img');
      img.className = 'dc-inter-img';
      img.alt = offer.altText;
      img.decoding = 'async';
      img.src = api(offer.imgUrl);
      body.appendChild(img);
    } else {
      body.textContent = offer.text.length > 0 ? offer.text : 'Your reward is on its way.';
    }
    card.appendChild(body);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dc-inter-skip';
    cancel.textContent = 'Cancel';
    card.appendChild(cancel);

    const note = document.createElement('div');
    note.className = 'dc-inter-auto';
    card.appendChild(note);

    host.appendChild(card);
    host.dataset.open = '1';
    host.tabIndex = -1;
    host.focus();
    opts.onInterstitial?.(true);

    if (fill !== null) interWatched = watch(host, fill, () => true);

    return new Promise<boolean>((resolve) => {
      const startedMs = Date.now();
      let seq = 0;
      let settled = false;
      const finish = (paid: boolean): void => {
        if (settled) return;
        settled = true;
        window.removeEventListener('keydown', onRewardKey, true);
        cancel.removeEventListener('click', onCancel);
        closeInterstitial();
        resolve(paid);
      };
      const onCancel = (): void => { finish(false); };
      function onRewardKey(e: KeyboardEvent): void {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
      cancel.addEventListener('click', onCancel);
      window.addEventListener('keydown', onRewardKey, true);

      const tick = (): void => {
        const elapsed = Date.now() - startedMs;
        const left = rewardSecondsLeft(elapsed, minMs);
        note.textContent = left > 0 ? 'Reward in ' + String(left) + 's' : 'Claiming…';
        if (elapsed >= minMs) { if (interTimer !== 0) { clearInterval(interTimer); interTimer = 0; } finish(true); }
      };
      interTimer = window.setInterval(tick, 250) as unknown as number;
      tick();

      /* Heartbeats the SERVER may refuse. `visible && focused` is reported, not
       * asserted: the server counts how many beats said yes and applies its own
       * threshold. */
      const beat = window.setInterval(() => {
        if (settled) { clearInterval(beat); return; }
        seq++;
        void postJson('/api/sponsor/reward/beat', {
          rewardId, deviceId: opts.deviceId(), seq,
          visible: document.visibilityState === 'visible',
          focused: document.hasFocus(),
        });
      }, beatMs);
      window.setTimeout(() => { clearInterval(beat); }, minMs + 10_000);
    });
  }

  function menuDecide(): void {
    if (menuDecided || offline() || opts.adsRemoved()) return;
    void enabledNow().then((on) => {
      if (!on || !inMenu || menuDecided || opts.adsRemoved()) return;
      menuDecided = true;
      decide(MENU_DECIDE_SURFACES).then((fills) => {
        if (!inMenu) return;
        for (const fill of fills) applyFill(fill);
      }).catch(() => { /* no server, no pipeline — the house card stands */ });
    });
  }

  return {
    /**
     * S10: offer a between-match interstitial. Returns whether one opened.
     *
     * Called from `backToMenu()`, i.e. after EVERY mode — the operator's call.
     * The gates are layered on purpose: `adsRemoved` short-circuits BEFORE the
     * decide (the purchase buys silence on the network, not a polite refusal),
     * then the kill switch, then deaths-since-last, which only the client can
     * know. The server independently enforces the 180 s interval and the
     * four-a-day platform ceiling, so a client that lies about deaths still
     * cannot exceed what a player is allowed to be shown.
     */
    async maybeInterstitial(): Promise<boolean> {
      if (interOpen || offline()) return false;
      if (!interstitialWanted(
        opts.adsRemoved(), true,
        opts.deathsSinceInterstitial?.() ?? 0, AD_INTERSTITIAL_AFTER_DEATHS,
      )) return false;
      const on = await flagOnNow('sponsor_interstitial', opts.interstitialEnabled?.() ?? false);
      if (!on || opts.adsRemoved()) return false;
      const fills = await decide([SurfaceId.INTERSTITIAL]).catch(() => []);
      const model = interstitialModel(fills[0]);
      if (model === null || fills[0] === undefined) return false;
      openInterstitial(fills[0], model);
      return true;
    },

    /** Close it from outside — the pause menu, a route change, a teardown. */
    closeInterstitial(): void { closeInterstitial(); },

    /**
     * S11 — render the rewarded button into `mount`, returning a disposer.
     *
     * The button is shown to a player who bought ads off as well; §1a is
     * explicit that removing the reward with the ads makes the purchase leave
     * them strictly worse off. Their claim skips the video and pays instantly,
     * and the server still applies every cap.
     */
    rewardButton(mount: HTMLElement, onResult?: (r: { ok: boolean; reason: string; scrap: number }) => void): () => void {
      let disposed = false;
      let btn: HTMLButtonElement | null = null;
      void flagOnNow('sponsor_rewarded', opts.rewardedEnabled?.() ?? false).then((on) => {
        if (!on || disposed || offline()) return;
        const b = document.createElement('button');
        btn = b;
        b.type = 'button';
        b.className = 'dc-reward-btn';
        b.textContent = opts.adsRemoved() ? 'Claim bonus Scrap' : 'Watch for bonus Scrap';
        b.addEventListener('click', () => {
          if (b.disabled) return;
          b.disabled = true;
          b.textContent = 'Working…';
          void runReward().then((r) => {
            if (disposed) return;
            b.disabled = false;
            b.textContent = r.ok
              ? '+' + String(r.scrap) + ' Scrap'
              : (r.reason === 'cancelled' ? 'Watch for bonus Scrap' : 'Not available');
            onResult?.(r);
          });
        });
        mount.appendChild(b);
      });
      return (): void => {
        disposed = true;
        if (btn !== null && btn.parentNode !== null) btn.parentNode.removeChild(btn);
      };
    },

    onMenuEnter(): void {
      // The boot line's run ends where the menu begins, whatever else happens.
      flushBoot();
      if (inMenu) return;
      inMenu = true;
      menuDecide();
    },

    onMenuExit(): void {
      if (!inMenu) return;
      inMenu = false;
      menuDecided = false;
      for (const entry of menuWatched) flush(entry);
      menuWatched = [];
      opts.clearModeTile?.();
      /* The resting state of a slot is the house card. A sponsor's creative
       * left standing after the pipeline lets go is shown to the player,
       * measured for nobody, and waiting to be measured under the next fill. */
      releaseAllSlots();
    },

    onBootReady(): void {
      // Flags just became answerable (or at least askable). Two things may
      // have been waiting: a menu entry that raced ahead of SESSION_CONFIG
      // (the first visit always does — onReady fires before the socket
      // settles), and the boot line below.
      if (inMenu && !menuDecided) menuDecide();
      if (bootTried) return;
      bootTried = true;
      if (offline() || opts.adsRemoved()) return;
      if ((opts.bootTip?.() ?? null) === null) return;  // boot already over
      void enabledNow().then((on) => {
        if (!on || (opts.bootTip?.() ?? null) === null) return Promise.resolve<AdFill[]>([]);
        return decide([SurfaceId.BOOT_LINE]);
      }).then((fills) => {
        const fill = textFillOrNull(fills[0]);
        if (fill === null || fill.surface !== SurfaceId.BOOT_LINE) return;
        const tip = opts.bootTip?.() ?? null;
        if (tip === null) return;  // the decide lost the race to the boot — show nothing
        while (tip.firstChild) tip.removeChild(tip.firstChild);
        const label = document.createElement('b');
        label.textContent = fill.label || 'Sponsored';
        tip.appendChild(label);
        tip.appendChild(document.createTextNode(`  ${fill.text}`));
        // Text only, no click-out: A1 needs >=6 s of boot left (§4.2) and our
        // boot is ~366 ms — the line is presence, not a navigation target.
        bootWatched = watch(tip, fill, () => (opts.bootTip?.() ?? null) !== null);
      }).catch(() => { /* no line is the correct fallback */ });
    },

    intermissionCard(mount: HTMLElement, options: IntermissionCardOptions): () => void {
      let disposed = false;
      let entry: WatchedFill | null = null;
      if (!offline() && !opts.adsRemoved()) {
        void enabledNow().then(async (on) => {
          if (!on || disposed) return;
          const fills = await decide([SurfaceId.INTERMISSION_CARD], options.mode);
          if (disposed) return;
          const model = interCardModel(fills[0], options.interactive);
          if (model === null) return;
          const card = document.createElement(model.href.length > 0 ? 'a' : 'div');
          card.className = 'dc-inter-card';
          if (card instanceof HTMLAnchorElement) {
            card.href = api(model.href);
            card.target = '_blank';
            card.rel = 'noopener';
          }
          const label = document.createElement('b');
          label.textContent = model.label;
          card.appendChild(label);
          if (model.kind === 'img') {
            const img = document.createElement('img');
            img.alt = model.text;
            img.decoding = 'async';
            // Mounted only once loaded, so the meter's creativeLoaded gate
            // (children of the mount) tells the truth (§3.2.6).
            img.onload = (): void => { if (!disposed) mount.appendChild(card); };
            img.src = api(model.src);
            card.appendChild(img);
          } else {
            card.appendChild(document.createTextNode(model.text));
            mount.appendChild(card);
          }
          entry = watch(mount, fills[0], options.active);
        }).catch(() => { /* no card is the correct fallback */ });
      }
      return () => {
        if (disposed) return;
        disposed = true;
        if (entry !== null) flush(entry);
        entry = null;
        while (mount.firstChild) mount.removeChild(mount.firstChild);
      };
    },
  };
}
