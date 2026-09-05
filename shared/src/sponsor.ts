/**
 * DOOMCRAFT — the sponsor platform's data model (docs/SPONSORS.md §2.1).
 *
 * Money is integer micros everywhere. Never a float.
 *
 * Phase 1 consumes the 2D-slot half of this file: the decide/event pipeline,
 * the cascade and the caps. The in-world surfaces keep their numbers here so
 * the enum is append-only from day one, but nothing serves them yet — a
 * SurfaceId is a catalogue entry, not a promise.
 */

import type { ModeId } from './modes.ts';

export const SPONSOR_SCHEMA_VERSION = 1;

/** Every sellable surface from §1. The console renders its catalogue off this enum. */
export enum SurfaceId {
  MENU_TOP = 0, MENU_SIDE = 1, MENU_BOTTOM = 2,        // S1
  MENU_BACKGROUND = 3, MODE_TILE = 4, BOOT_LINE = 5,   // S2, S3, S4
  PAUSE_LOCKUP = 6, STORE_SHELF = 7, EVENT_CARD = 8, COMMUNITY_TILE = 9,
  INTERSTITIAL = 10, REWARDED = 11, INTERMISSION_CARD = 12,
  WORLD_DECAL = 21, WORLD_BANNER = 22, ARENA_HOARDING = 23,
  WORLD_PROP = 24, FLOOR_SPRAY = 25,
  WEAPON_SKIN = 30, ITEM_DROP = 31, PICKUP_SKIN = 32,
  HORDE_WAVE = 33, QUEST_LEVEL = 34, VEHICLE = 35,
  TOURNAMENT = 40, LADDER = 41, PRIZE = 42, CHALLENGE = 43,
  SHARE_CARD = 50, LANDING_PAGE = 51,
}
// NOTE: no WORLD_MOSAIC. S14 is house art and is deliberately not a billable SurfaceId.

/** The phase-one set: already-existing DOM on screens where the renderer is idle. */
export const PHASE_ONE_SURFACES: readonly SurfaceId[] = Object.freeze([
  SurfaceId.MENU_TOP, SurfaceId.MENU_SIDE, SurfaceId.MENU_BOTTOM,
  SurfaceId.MODE_TILE, SurfaceId.BOOT_LINE, SurfaceId.INTERMISSION_CARD,
]);

/**
 * The surfaces a decide request may ask for TODAY.
 *
 * Phase one plus S10, the between-match interstitial. Kept separate from
 * `PHASE_ONE_SURFACES` rather than growing it, because that constant means
 * something specific — DOM that already exists on screens where the renderer is
 * idle — and the interstitial is not that.
 *
 * `REWARDED` joined it in P2c, once the Gate 5 handshake and the durable
 * per-day grant caps existed to stand behind it. A surface that is asked for
 * and not servable is REFUSED WITH A REASON, never dropped in silence.
 */
export const SERVABLE_SURFACES: readonly SurfaceId[] = Object.freeze([
  ...PHASE_ONE_SURFACES, SurfaceId.INTERSTITIAL, SurfaceId.REWARDED,
]);

/** The platform's own ceiling on interstitials per device per UTC day. */
export const AD_INTERSTITIALS_PER_DAY = 4;

/* -------------------------------------------------------------------------- *
 * S11 rewarded — Gate 5 (docs/SPONSORS.md §4.5)
 * -------------------------------------------------------------------------- */

/** How long the player must actually be there. The server times this itself. */
export const AD_REWARD_MIN_MS = 15_000;
/** Grants per account per UTC day. */
export const AD_REWARDS_PER_DAY = 4;
/** Minimum gap between two grants. */
export const AD_REWARD_MIN_GAP_MS = 180_000;
/**
 * Diminishing returns, ECONOMY.md's rule made concrete. Index = grants already
 * taken today, so the first pays 40 and the fifth pays nothing.
 */
export const AD_REWARD_SCRAP_LADDER: readonly number[] = Object.freeze([40, 30, 20, 10]);
/**
 * Accounts with less than this much server-recorded lifetime play are paid
 * ZERO. A fresh account that exists only to watch ads is the whole shape of
 * rewarded-video fraud, and playtime is the cheapest thing to require.
 */
export const AD_REWARD_MIN_LIFETIME_SECONDS = 30 * 60;
/** Heartbeat cadence, and the arrival window a real 2 s beat can land in. */
export const AD_REWARD_BEAT_MS = 2_000;
export const AD_REWARD_BEAT_MIN_MS = 1_600;
export const AD_REWARD_BEAT_MAX_MS = 3_500;
/** Fraction of beats that must report the tab visible AND focused. */
export const AD_REWARD_FOCUS_RATIO = 0.8;

/** Why a claim was refused. `ok` is the only paying answer. */
export type RewardRefusal =
  | 'ok'
  | 'unknown-session'
  | 'already-claimed'
  | 'too-soon'
  | 'too-few-beats'
  | 'not-watched'
  | 'daily-cap'
  | 'gap'
  | 'too-new'
  | 'in-pvp';

export interface Sponsor {
  id: string;                       // 'spn_' + 12 hex
  legalName: string;
  displayName: string;
  countryCode: string;              // ISO-3166-1 alpha-2 — drives which ad rules apply
  contactEmail: string;
  verified: boolean;
  status: 'pending' | 'approved' | 'suspended';
  balanceMicros: number;            // PREPAID ONLY in v1. No invoicing, no credit.
}

export type CampaignStatus =
  | 'draft' | 'in_review' | 'rejected' | 'scheduled'
  | 'live' | 'paused' | 'exhausted' | 'ended';

export interface Targeting {
  modes: ModeId[];            // [] = all
  regions: string[];          // ISO-3166-1 alpha-2, [] = all. Resolved from request IP, never client-supplied.
  excludeRegions: string[];   // always beats `regions`
  platforms: ('desktop' | 'mobile')[];
  minAccountLevel: number;    // 0 = any
  ageBands: ('unknown' | 'u13' | '13_17' | '18plus')[];  // LEGAL GATE, not an optimisation lever
  levelIds: string[];
  weekdayMaskUtc: number;     // bit 0 = Sunday
  hourMaskUtc: number;        // 24 bits
}

export interface FrequencyCap {
  perSessionImpressions: number;
  perDayImpressions: number;
  minSecondsBetween: number;
  perDayInterstitials: number;   // PLATFORM ceiling, default 4, over any campaign's own number
}

export interface PlacementBinding {
  surface: SurfaceId;
  creativeIds: string[];      // rotation set; server picks round-robin per session
  weight: number;             // 1..100 relative share within the surface
  floorMicrosCpm: number;     // what a programmatic bid must beat to take this slot
}

export type CreativeKind =
  | 'display'    // S1, S12 — a static image at an exact IAB size
  | 'image'      // S2, S3, S8 — a shell image at a declared size
  | 'text'       // S4, S6, S7 — a string, no art at all
  | 'decal'      // becomes a GPU texture (phase 3)
  | 'palette'    // <=16 packed 0xRRGGBB, no art can be smuggled through this kind
  | 'video';     // S11 only

export interface Creative {
  id: string;
  sponsorId: string;
  kind: CreativeKind;
  status: 'uploaded' | 'scanning' | 'in_review' | 'approved' | 'rejected';
  sha256: string;             // CONTENT ADDRESS. Served path is /cdn/crv/<sha256>.<ext> and nothing else.
  mime: string;
  bytes: number;
  width: number;
  height: number;
  altText: string;            // REQUIRED — accessibility, and a moderation signal
  /** For kind 'text': the line itself. */
  text: string;
  clickUrl: string;           // https only; no redirector chains
  rejectReason: string;
}

export interface Campaign {
  schema: number;
  id: string;                 // 'cmp_' + 12 hex
  sponsorId: string;
  name: string;
  status: CampaignStatus;
  startMs: number;            // UTC ms, start inclusive
  endMs: number;              // end exclusive
  budgetMicros: number;
  dailyCapMicros: number;
  pacing: 'even' | 'asap';
  pricing: { model: 'cpm' | 'cpd' | 'flat'; bidMicros: number };
  targeting: Targeting;
  caps: FrequencyCap;
  placements: PlacementBinding[];
  disclosure: 'ad' | 'sponsored' | 'paid_partnership';
}

/** What the server hands the client. The client NEVER chooses a fill. */
export interface AdFill {
  surface: SurfaceId;
  source: 'direct' | 'programmatic' | 'house';
  creativeId: string;
  kind: CreativeKind;
  /** '' for house and text fills; a /cdn/crv/ path once the asset pipeline exists. */
  assetUrl: string;
  /** '' when the fill has no click-out; otherwise ALWAYS a same-origin /r/<clickId>. */
  clickUrl: string;
  altText: string;
  text: string;
  label: string;              // "Ad" | "Sponsored" | "Paid partnership" — from Campaign.disclosure
  /**
   * MODE_TILE only: the ModeId whose tile carries the badge, taken from the
   * campaign's `targeting.modes[0]` (for that surface the list NAMES the tile
   * rather than filtering on the mode being played — the decide happens from
   * the menu). -1 for every other surface.
   */
  modeId: number;
  nonce: string;              // single-use per event type, server-issued
  expiresMs: number;
}

export const DISCLOSURE_LABEL: Readonly<Record<Campaign['disclosure'], string>> = Object.freeze({
  ad: 'Ad',
  sponsored: 'Sponsored',
  paid_partnership: 'Paid partnership',
});

/* ------------------------------------------------------------------------ *
 * The measurement constants the client meter and the server share
 * ------------------------------------------------------------------------ */

/** MRC display: >=50% of pixels for >=1 continuous second. */
export const AD_VIEWABLE_RATIO = 0.5;
export const AD_VIEWABLE_MS = 1000;
/** Ours, stricter (IIG §3.1.5.3): a menu idle past this stops counting. */
export const AD_MENU_IDLE_MS = 60_000;
/** IIG §3.1.5.4 Cool Off: later runs emit `replay` no sooner than this. */
export const AD_IMPRESSION_COOLOFF_MS = 30_000;
/** Click dwell gates (§4.5 Gate 2). */
export const AD_CLICK_MIN_DWELL_MS = 300;
export const AD_CLICK_SUSPECT_DWELL_MS = 1000;
/** Billable-click caps (§4.5 Gate 4). */
export const AD_CLICKS_PER_SESSION = 3;
export const AD_CLICK_DEVICE_CREATIVE_HOURS = 24;

export type AdEventType =
  | 'impression' | 'replay' | 'exposure' | 'blocked' | 'click' | 'decide'
  /** The creative began to render. The MRC metric-1 denominator; client-only. */
  | 'rendered'
  /** One fill's terminal measurement outcome. Carries `qualified` and `basis`. */
  | 'verdict';

/* -------------------------------------------------------------------------- *
 * The ad log's row schema (§3.7.5: "billing is a batch job over the log")
 * -------------------------------------------------------------------------- */

/**
 * Row types in `ads.jsonl`.
 *
 * `served` is SERVER-SIDE ALLOCATION and is deliberately NOT called "rendered".
 * A fill is minted inside `decide()`; the client may never display it. The MRC
 * metric "Total (rendered) impressions" requires that the creative BEGAN TO
 * RENDER, which only the client can attest — so `served` is the denominator for
 * fill/serve rates and for nothing else. Naming it `rendered` would recreate,
 * one layer along, exactly the conflation §3.5's caveat block exists to forbid.
 *
 * `decide` rows are REFUSALS ONLY (a candidate that was skipped). They are not
 * a decision stream: several skips and one `served` can all belong to the same
 * decision, which is what `decisionId` is for.
 */
export type AdLogType = AdEventType | 'served';

/**
 * The schema version stamped on every row.
 *
 * Rows written before this existed carry no `v` and no `nonce`, and cannot be
 * repaired retroactively — an exposure row from then cannot be attributed to a
 * fill. A reader MUST treat unversioned rows as a separate, poorer population
 * and say so, rather than blending them into a total that implies they are
 * comparable. `AD_LOG_V1_FROM_MS` is unknown per deployment; the reader
 * discovers the cutover by the first versioned row it sees.
 */
export const AD_LOG_VERSION = 1;

/**
 * Fields every versioned row carries.
 *
 * `mode` is the play mode the request declared, or `AD_MODE_UNKNOWN` — never 0,
 * because `ModeId.QUEST` IS 0 and a missing mode logged as 0 would silently
 * report every menu impression as Quest.
 */
export interface AdLogBase {
  v: number;
  ms: number;
  type: AdLogType;
  surface: number;
  mode: number;
  platform: string;
}

/** No mode was declared. Distinct from `ModeId.QUEST`, which is 0. */
export const AD_MODE_UNKNOWN = -1;
