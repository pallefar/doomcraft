/**
 * DOOMCRAFT — the ad platform's server half, phase 1 (docs/SPONSORS.md).
 *
 * Delivery is server-authoritative, mirroring ECONOMY.md decision 1: the
 * client never chooses a fill, never asserts an impression that counts, and
 * never asserts a click at all — a click HAPPENS when `/r/<clickId>` is
 * fetched (§4.5). Every counted event lands in an append-only NDJSON log
 * (`ads.jsonl`), because billing is a batch job over a log, never a live
 * counter (§3.7.5).
 *
 * Honest phase-1 limits, stated rather than papered over:
 *  - Campaigns come from `$DOOMCRAFT_DATA/sponsors.json`, operator-authored.
 *    There is no self-serve console and no asset pipeline yet, so campaigns
 *    whose creative kind needs an uploaded image ('display'/'image') are
 *    SKIPPED with a logged reason — text creatives and the house card are
 *    what can serve today. The machinery (decide → fill → measure → event →
 *    redirect) is the deliverable; §2.2 is the next stage.
 *  - Frequency caps and budget accrual are in-memory per process; a restart
 *    resets them. With no real campaigns booked this is acceptable and it
 *    avoids a third schema bump; the §2.1 profile-resident counters land
 *    with the vendor stage.
 *  - The §4.5 offer-card clickId TTL (120 s) applies to offer cards; a menu
 *    fill's clickId lives exactly as long as the fill's nonce, because a
 *    player may read the menu longer than two minutes and a dead link on a
 *    visible card is a broken promise.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AD_CLICKS_PER_SESSION,
  AD_CLICK_DEVICE_CREATIVE_HOURS,
  AD_CLICK_MIN_DWELL_MS,
  AD_CLICK_SUSPECT_DWELL_MS,
  DISCLOSURE_LABEL,
  SurfaceId,
  type AdEventType,
  type AdFill,
  type Campaign,
  type Creative,
  type Sponsor,
  AD_LOG_VERSION,
  AD_MODE_UNKNOWN,
} from '@doomcraft/shared/sponsor';

const FILL_TTL_MS = 10 * 60_000;
const SPONSORS_FILE = 'sponsors.json';
const LOG_FILE = 'ads.jsonl';

interface FillRecord {
  nonce: string;
  surface: SurfaceId;
  source: AdFill['source'];
  campaignId: string;
  creativeId: string;
  deviceHash: string;
  sessionId: string;
  expiresMs: number;
  impressionMs: number;
  exposureMs: number;
  counted: Set<string>;
  /* Captured at mint. A later `impression` or `exposure` row has no request to
   * read these off, and a dimension recovered by joining rows after the fact is
   * a dimension that goes missing the moment a row is lost. */
  mode: number;
  platform: string;
}

interface ClickRecord {
  clickId: string;
  nonce: string;
  target: string;
  used: boolean;
}

export interface DecideRequest {
  deviceId: string;
  sessionId: string;
  surfaces: SurfaceId[];
  mode: number;
  platform: 'desktop' | 'mobile';
}

export interface DecideContext {
  adsRemoved: boolean;
  ageBand: 'unknown' | 'u13' | '13-17' | '18plus';
  region: string;
}

export interface AdServiceOptions {
  clock?: () => number;
  /** HMAC key for click ids. Random per boot when unset — clickIds are short-lived. */
  secret?: Buffer;
  log?: (line: string) => void;
  /**
   * The §2.2 asset resolver: the servable `/cdn/crv/…` URL and the stored
   * file's REAL dimensions for a content hash, or null when nothing is
   * uploaded. Unset (no store, old deployments) every asset kind still
   * skips exactly as before §2.2 shipped.
   */
  assetFor?: (sha256: string) => { url: string; width: number; height: number } | null;
}

/**
 * The creative sizes each phase-one surface accepts per platform (§1a/§3.2:
 * the top and bottom slots are 728×90 desktop / 320×50-or-100 mobile, the
 * side slot is 300×250 and hidden below 900 px, the intermission card takes
 * the strip sizes). A display fill whose file is the wrong shape for THIS
 * player's slot is skipped — a stretched creative mismeasures, and the MRC
 * ratio would be computed against a box the art does not fill.
 */
const SLOT_SIZES: Readonly<Partial<Record<SurfaceId, {
  desktop: ReadonlyArray<readonly [number, number]>;
  mobile: ReadonlyArray<readonly [number, number]>;
}>>> = Object.freeze({
  [SurfaceId.MENU_TOP]: { desktop: [[728, 90]], mobile: [[320, 50], [320, 100]] },
  [SurfaceId.MENU_BOTTOM]: { desktop: [[728, 90]], mobile: [[320, 50], [320, 100]] },
  [SurfaceId.MENU_SIDE]: { desktop: [[300, 250]], mobile: [] },
  [SurfaceId.INTERMISSION_CARD]: { desktop: [[728, 90]], mobile: [[320, 50], [320, 100]] },
});

export function displayFits(
  surface: SurfaceId, platform: 'desktop' | 'mobile', width: number, height: number,
): boolean {
  const sizes = SLOT_SIZES[surface]?.[platform];
  if (sizes === undefined) return false;
  return sizes.some(([w, h]) => w === width && h === height);
}

export class AdService {
  private readonly root: string;
  private readonly clock: () => number;
  private readonly secret: Buffer;
  private readonly logErr: (line: string) => void;
  private readonly assetFor: AdServiceOptions['assetFor'];

  private sponsors: Sponsor[] = [];
  private campaigns: Campaign[] = [];
  private creatives = new Map<string, Creative>();

  private readonly fills = new Map<string, FillRecord>();
  private readonly clicks = new Map<string, ClickRecord>();
  /** `${deviceHash}|${campaignId}` → per-device pacing state. In-memory, stated. */
  private readonly freq = new Map<string, { day: string; dayCount: number; lastMs: number; bySession: Map<string, number> }>();
  /** `${deviceHash}|${creativeId}` → last billable click ms. */
  private readonly clickDedup = new Map<string, number>();
  private readonly sessionClicks = new Map<string, number>();
  private spentMicros = new Map<string, number>();

  readonly counters = {
    decides: 0, fills: 0, houseFills: 0, impressions: 0, replays: 0,
    blocked: 0, clicks: 0, billableClicks: 0, refusedEvents: 0,
    /**
     * Rows the log FAILED to persist. Non-zero means the counters above and the
     * log disagree, and the log is the billing substrate — so this number is
     * the difference between "we served 1,000 impressions" and "we can PROVE we
     * served 1,000 impressions". It used to be unobservable: the write was
     * wrapped in a bare `catch {}` while the counter had already moved.
     */
    logWriteFailures: 0,
  };

  /**
   * Rows accumulated during one public call, flushed as ONE append.
   *
   * `append()` is `appendFileSync` on the serving path, and a single `decide()`
   * mints up to eight fills. A row per mint would multiply synchronous writes
   * on the request that has to answer fastest. Buffering per call keeps exactly
   * the durability the log had before (still written before the response) while
   * keeping it to one syscall per API call rather than one per row.
   */
  private rows: string[] = [];

  /** Groups one decision's skip rows with the fill it did or did not produce. */
  private decisionId = '';

  constructor(dataRoot: string, options: AdServiceOptions = {}) {
    this.root = dataRoot.replace(/\/+$/, '');
    this.clock = options.clock ?? (() => Date.now());
    this.secret = options.secret ?? randomBytes(32);
    this.logErr = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
    this.assetFor = options.assetFor;
    this.loadCampaigns();
  }

  /* --- campaign inventory ----------------------------------------------- */

  loadCampaigns(): void {
    const file = join(this.root, SPONSORS_FILE);
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        sponsors?: Sponsor[]; campaigns?: Campaign[]; creatives?: Creative[];
      };
      this.sponsors = Array.isArray(raw.sponsors) ? raw.sponsors : [];
      this.campaigns = Array.isArray(raw.campaigns) ? raw.campaigns : [];
      this.creatives = new Map((Array.isArray(raw.creatives) ? raw.creatives : []).map((c) => [c.id, c]));
    } catch (e) {
      // A broken booking file must not take ads down to zero — the house
      // cascade still fills, and the operator sees the line.
      this.logErr(`ads: ${file} is unreadable (${e instanceof Error ? e.message : String(e)}); serving house only`);
      this.sponsors = []; this.campaigns = []; this.creatives = new Map();
    }
  }

  /* --- decide ------------------------------------------------------------ */

  decide(req: DecideRequest, ctx: DecideContext): AdFill[] {
    this.counters.decides++;
    this.sweep();
    // The purchase buys silence on the network: no cascade, no fill, no log row.
    if (ctx.adsRemoved) return [];
    const now = this.clock();
    const out: AdFill[] = [];
    const deviceHash = hashDevice(req.deviceId);
    /* One id for this whole decision. Several candidate SKIPS and at most one
     * `served` row can belong to one surface's decision, and without this a
     * reader counting `decide` rows would report four "requests" where there
     * was one. It is not the nonce: a skip happens before any fill exists. */
    this.decisionId = randomBytes(6).toString('hex');
    for (const surface of req.surfaces.slice(0, 8)) {
      const fill = this.decideOne(surface, req, ctx, deviceHash, now);
      if (fill !== null) out.push(fill);
    }
    this.flushRows();
    return out;
  }

  private decideOne(
    surface: SurfaceId, req: DecideRequest, ctx: DecideContext, deviceHash: string, now: number,
  ): AdFill | null {
    // 1-2. Direct-sold, one pass: live, in-window, targeted, capped, funded.
    const eligible: { campaign: Campaign; creative: Creative; assetUrl: string; weight: number }[] = [];
    for (const c of this.campaigns) {
      if (c.status !== 'live' || now < c.startMs || now >= c.endMs) continue;
      const binding = c.placements.find((p) => p.surface === surface);
      if (binding === undefined) continue;
      if (surface === SurfaceId.MODE_TILE && c.targeting.modes.length === 0) {
        // A badge with no tile is unplaceable — refused, never guessed.
        this.append({ ms: now, type: 'decide', surface, note: `skip ${c.id}: a MODE_TILE badge must name its tile in targeting.modes`, decisionId: this.decisionId, mode: req.mode, platform: req.platform });
        continue;
      }
      if (!this.targets(c, req, ctx, surface)) continue;
      if (!this.underCaps(c, deviceHash, req.sessionId, now)) continue;
      if ((this.spentMicros.get(c.id) ?? 0) >= c.budgetMicros) continue;
      const creative = this.rotate(binding.creativeIds, req.sessionId);
      if (creative === null) continue;
      if (creative.status !== 'approved') continue;
      let assetUrl = '';
      if (creative.kind === 'video') {
        // Rewarded/interstitial video is phase 2 and its overlay does not exist.
        this.append({ ms: now, type: 'decide', surface, note: `skip ${c.id}: kind video needs phase 2`, decisionId: this.decisionId, mode: req.mode, platform: req.platform });
        continue;
      }
      if (creative.kind === 'image') {
        // The image kind belongs to S2/S3/S8 shell surfaces, none of which is
        // a phase-one surface — nothing can render it yet.
        this.append({ ms: now, type: 'decide', surface, note: `skip ${c.id}: kind image has no phase-one surface`, decisionId: this.decisionId, mode: req.mode, platform: req.platform });
        continue;
      }
      if (creative.kind === 'display') {
        // §2.2: the content hash is the only address, and the stored file's
        // own header — never the booking document — says what shape it is.
        const asset = this.assetFor?.(creative.sha256) ?? null;
        if (asset === null) {
          this.append({ ms: now, type: 'decide', surface, note: `skip ${c.id}: no uploaded asset for ${creative.sha256.slice(0, 12) || '(no sha256)'}`, decisionId: this.decisionId, mode: req.mode, platform: req.platform });
          continue;
        }
        if (!displayFits(surface, req.platform, asset.width, asset.height)) {
          this.append({ ms: now, type: 'decide', surface, note: `skip ${c.id}: ${asset.width}x${asset.height} does not fit surface ${surface} on ${req.platform}`, decisionId: this.decisionId, mode: req.mode, platform: req.platform });
          continue;
        }
        assetUrl = asset.url;
      }
      eligible.push({ campaign: c, creative, assetUrl, weight: Math.max(1, Math.min(100, binding.weight)) });
    }
    if (eligible.length > 0) {
      const pick = weightedPick(eligible, deviceHash + String(surface));
      return this.mint(surface, 'direct', pick.campaign, pick.creative, deviceHash, req.sessionId, now, pick.assetUrl, req.mode, req.platform);
    }
    // 3. Programmatic: no network integration exists; nothing to offer the slot to.
    // 4. House — the guaranteed floor, MENU slots and the intermission card only.
    if (surface === SurfaceId.MENU_TOP || surface === SurfaceId.MENU_SIDE
      || surface === SurfaceId.MENU_BOTTOM || surface === SurfaceId.INTERMISSION_CARD) {
      this.counters.houseFills++;
      return this.mint(surface, 'house', null, null, deviceHash, req.sessionId, now, '', req.mode, req.platform);
    }
    return null;
  }

  private targets(c: Campaign, req: DecideRequest, ctx: DecideContext, surface: SurfaceId): boolean {
    const t = c.targeting;
    if (t.platforms.length > 0 && !t.platforms.includes(req.platform)) return false;
    // MODE_TILE is decided from the menu, where `req.mode` is whatever tile is
    // preselected: for that surface `targeting.modes` NAMES the tile the badge
    // sits on (§1a S3) instead of filtering on the mode being played.
    if (surface !== SurfaceId.MODE_TILE && t.modes.length > 0 && !t.modes.includes(req.mode)) return false;
    if (t.excludeRegions.includes(ctx.region)) return false;
    if (t.regions.length > 0 && !t.regions.includes(ctx.region)) return false;
    // The LEGAL gate, fail-closed: a campaign that names age bands serves only
    // players whose band is IN the list — an unknown-age player sees it only
    // if the campaign explicitly accepts 'unknown'.
    if (t.ageBands.length > 0) {
      const band = ctx.ageBand === '13-17' ? '13_17' : ctx.ageBand;
      if (!t.ageBands.includes(band as typeof t.ageBands[number])) return false;
    }
    const now = new Date(this.clock());
    if (t.weekdayMaskUtc !== 0 && ((t.weekdayMaskUtc >>> now.getUTCDay()) & 1) === 0) return false;
    if (t.hourMaskUtc !== 0 && ((t.hourMaskUtc >>> now.getUTCHours()) & 1) === 0) return false;
    return true;
  }

  private underCaps(c: Campaign, deviceHash: string, sessionId: string, now: number): boolean {
    const key = `${deviceHash}|${c.id}`;
    const state = this.freq.get(key);
    if (state === undefined) return true;
    const day = utcDay(now);
    if (state.day === day && c.caps.perDayImpressions > 0 && state.dayCount >= c.caps.perDayImpressions) return false;
    if (c.caps.minSecondsBetween > 0 && now - state.lastMs < c.caps.minSecondsBetween * 1000) return false;
    const inSession = state.bySession.get(sessionId) ?? 0;
    if (c.caps.perSessionImpressions > 0 && inSession >= c.caps.perSessionImpressions) return false;
    return true;
  }

  private rotate(creativeIds: string[], sessionId: string): Creative | null {
    if (creativeIds.length === 0) return null;
    const i = fnv(sessionId) % creativeIds.length;
    return this.creatives.get(creativeIds[i]) ?? null;
  }

  private mint(
    surface: SurfaceId, source: AdFill['source'],
    campaign: Campaign | null, creative: Creative | null,
    deviceHash: string, sessionId: string, now: number, assetUrl = '',
    mode: number = AD_MODE_UNKNOWN, platform = '',
  ): AdFill {
    const nonce = randomBytes(12).toString('hex');
    const record: FillRecord = {
      nonce, surface, source,
      campaignId: campaign?.id ?? '',
      creativeId: creative?.id ?? 'house-remove-ads',
      deviceHash, sessionId,
      expiresMs: now + FILL_TTL_MS,
      impressionMs: 0, exposureMs: 0, counted: new Set(),
      mode, platform,
    };
    this.fills.set(nonce, record);
    this.counters.fills++;

    /* THE ROW THAT DID NOT EXIST. A successful decide used to write nothing at
     * all, so the log held only refusals and there was no denominator for
     * anything. It is `served`, NOT `rendered`: this is a server-side
     * allocation and the client may never display it. What it can be divided
     * into is fill and house share; what it must NEVER be presented as is the
     * MRC "Total (rendered) impressions", which requires the creative to have
     * begun rendering and can only come from the client. */
    this.append({
      ms: now, type: 'served', nonce, surface, source,
      campaignId: record.campaignId, creativeId: record.creativeId,
      device: deviceHash, sessionId, mode, platform,
      decisionId: this.decisionId,
    });

    let clickUrl = '';
    if (creative !== null && creative.clickUrl.startsWith('https://')) {
      const clickId = this.mintClickId(record, creative.clickUrl);
      clickUrl = `/r/${clickId}`;
    }
    return {
      surface, source,
      creativeId: record.creativeId,
      kind: creative?.kind ?? 'text',
      assetUrl,
      clickUrl,
      altText: creative?.altText ?? '',
      text: creative?.text ?? '',
      label: campaign === null ? '' : DISCLOSURE_LABEL[campaign.disclosure],
      modeId: surface === SurfaceId.MODE_TILE && campaign !== null
        ? (campaign.targeting.modes[0] ?? -1)
        : -1,
      nonce,
      expiresMs: record.expiresMs,
    };
  }

  private mintClickId(record: FillRecord, target: string): string {
    const payload = `${record.nonce}|${record.creativeId}|${record.deviceHash}|${record.sessionId}|${this.clock()}`;
    const clickId = createHmac('sha256', this.secret).update(payload).digest('base64url').slice(0, 32);
    this.clicks.set(clickId, { clickId, nonce: record.nonce, target, used: false });
    return clickId;
  }

  /* --- events ------------------------------------------------------------ */

  event(nonce: string, type: AdEventType, ms: number, exposureMs = 0): { ok: boolean; reason: string } {
    const now = this.clock();
    const fill = this.fills.get(nonce);
    if (fill === undefined || now > fill.expiresMs) {
      this.counters.refusedEvents++;
      return { ok: false, reason: 'unknown or expired nonce' };
    }
    if (type === 'impression' || type === 'replay' || type === 'blocked') {
      if (fill.counted.has(type)) {
        this.counters.refusedEvents++;
        return { ok: false, reason: `${type} already counted for this fill` };
      }
      fill.counted.add(type);
      if (type === 'impression') {
        fill.impressionMs = now;
        this.counters.impressions++;
        this.accrue(fill);
      }
      if (type === 'replay') this.counters.replays++;
      if (type === 'blocked') this.counters.blocked++;
      this.append({
        ms: now, type, nonce, surface: fill.surface, source: fill.source,
        campaignId: fill.campaignId, creativeId: fill.creativeId,
        device: fill.deviceHash, sessionId: fill.sessionId,
        mode: fill.mode, platform: fill.platform,
      });
      this.flushRows();
      return { ok: true, reason: '' };
    }
    if (type === 'exposure') {
      // Accumulates monotonically; the final flush wins. Logged once at expiry
      // would lose crash cases, so every update rewrites the in-memory number
      // and the log row carries the running total.
      const clamped = Math.max(fill.exposureMs, Math.min(exposureMs, now - (fill.expiresMs - FILL_TTL_MS)));
      fill.exposureMs = clamped;
      this.append({
        ms: now, type, nonce, surface: fill.surface, source: fill.source,
        campaignId: fill.campaignId, creativeId: fill.creativeId,
        device: fill.deviceHash, sessionId: fill.sessionId, exposureMs: clamped,
        mode: fill.mode, platform: fill.platform,
      });
      this.flushRows();
      return { ok: true, reason: '' };
    }
    this.counters.refusedEvents++;
    return { ok: false, reason: 'unknown event type' };
  }

  /** Impression accrual against the campaign's CPM budget. */
  private accrue(fill: FillRecord): void {
    if (fill.campaignId === '') return;
    const c = this.campaigns.find((x) => x.id === fill.campaignId);
    if (c === undefined) return;
    if (c.pricing.model === 'cpm') {
      this.spentMicros.set(c.id, (this.spentMicros.get(c.id) ?? 0) + Math.floor(c.pricing.bidMicros / 1000));
    }
    const key = `${fill.deviceHash}|${c.id}`;
    const day = utcDay(this.clock());
    const state = this.freq.get(key) ?? { day, dayCount: 0, lastMs: 0, bySession: new Map<string, number>() };
    if (state.day !== day) { state.day = day; state.dayCount = 0; }
    state.dayCount++;
    state.lastMs = this.clock();
    state.bySession.set(fill.sessionId, (state.bySession.get(fill.sessionId) ?? 0) + 1);
    this.freq.set(key, state);
  }

  /* --- the redirector (§4.5) --------------------------------------------- */

  redirect(clickId: string): { target: string; billable: boolean; reason: string } | null {
    const record = this.clicks.get(clickId);
    if (record === undefined) return null;
    const fill = this.fills.get(record.nonce);
    const now = this.clock();
    // The HUMAN always gets through — a 302 is never withheld from a person.
    // What varies is whether the click COUNTS.
    let billable = true;
    let reason = '';
    if (record.used) { billable = false; reason = 'clickId already used'; }
    else if (fill === undefined || now > fill.expiresMs) { billable = false; reason = 'fill expired'; }
    else if (fill.impressionMs === 0) {
      // Gate 1: no impression on record — the server's own derivation never
      // qualified one — so the click is invalid unconditionally.
      billable = false; reason = 'no impression precedes this click';
    } else {
      const dwell = now - fill.impressionMs;
      if (dwell < AD_CLICK_MIN_DWELL_MS) { billable = false; reason = `dwell ${dwell}ms < ${AD_CLICK_MIN_DWELL_MS}ms`; }
      else if (dwell < AD_CLICK_SUSPECT_DWELL_MS) { billable = false; reason = `suspect dwell ${dwell}ms`; }
      if (billable) {
        const dedupKey = `${fill.deviceHash}|${fill.creativeId}`;
        const last = this.clickDedup.get(dedupKey) ?? 0;
        if (now - last < AD_CLICK_DEVICE_CREATIVE_HOURS * 3_600_000) { billable = false; reason = '1 billable per device+creative per 24h'; }
        const inSession = this.sessionClicks.get(fill.sessionId) ?? 0;
        if (billable && inSession >= AD_CLICKS_PER_SESSION) { billable = false; reason = 'session billable-click cap'; }
        if (billable) {
          this.clickDedup.set(dedupKey, now);
          this.sessionClicks.set(fill.sessionId, inSession + 1);
        }
      }
    }
    record.used = true;
    this.counters.clicks++;
    if (billable) this.counters.billableClicks++;
    this.append({
      ms: now, type: 'click', nonce: record.nonce,
      surface: fill?.surface ?? -1, source: fill?.source ?? 'house',
      campaignId: fill?.campaignId ?? '', creativeId: fill?.creativeId ?? '',
      device: fill?.deviceHash ?? '', sessionId: fill?.sessionId ?? '',
      mode: fill?.mode ?? AD_MODE_UNKNOWN, platform: fill?.platform ?? '',
      billable, reason,
    });
    this.flushRows();
    return { target: record.target, billable, reason };
  }

  /* --- plumbing ----------------------------------------------------------- */

  status(): Record<string, number> {
    return { ...this.counters, liveCampaigns: this.campaigns.filter((c) => c.status === 'live').length };
  }

  /**
   * Stage one row. Every row is stamped with the schema version and the two
   * dimensions the dashboard needs and could never recover later.
   */
  private append(row: Record<string, unknown>): void {
    this.rows.push(JSON.stringify({ v: AD_LOG_VERSION, ...row }));
  }

  /**
   * Write the staged rows, or say loudly that we could not.
   *
   * Serving still wins over logging — an unwritable disk must not take ads down
   * — but the failure is now COUNTED and logged instead of vanishing into a
   * bare catch. A log that silently drops rows while the in-memory counters
   * keep climbing is not an accounting substrate, it is a rumour.
   */
  private flushRows(): void {
    if (this.rows.length === 0) return;
    const batch = this.rows;
    this.rows = [];
    try {
      mkdirSync(this.root, { recursive: true });
      appendFileSync(join(this.root, LOG_FILE), batch.join('\n') + '\n', 'utf8');
    } catch (err) {
      this.counters.logWriteFailures += batch.length;
      this.logErr(`ads: FAILED to persist ${batch.length} log row(s): ${(err as Error)?.message ?? ''}`);
    }
  }

  private sweep(): void {
    if (this.fills.size < 4096) return;
    const now = this.clock();
    for (const [nonce, fill] of this.fills) {
      if (now > fill.expiresMs) this.fills.delete(nonce);
    }
    for (const [id, click] of this.clicks) {
      const fill = this.fills.get(click.nonce);
      if (fill === undefined) this.clicks.delete(id);
    }
  }
}

/** Devices in the ad log are ALWAYS the redacted 8-char handle, never raw. */
function hashDevice(deviceId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function weightedPick<T extends { weight: number }>(list: T[], seed: string): T {
  let total = 0;
  for (const e of list) total += e.weight;
  let pick = fnv(seed) % total;
  for (const e of list) {
    pick -= e.weight;
    if (pick < 0) return e;
  }
  return list[list.length - 1];
}
