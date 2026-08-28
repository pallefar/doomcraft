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

export type AdEventType = 'impression' | 'replay' | 'exposure' | 'blocked' | 'click' | 'decide';
