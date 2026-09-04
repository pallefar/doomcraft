/**
 * DOOMCRAFT — everything the admin console displays, computed here.
 *
 * The console's markup lives in `./console.ts` as a template literal. That
 * string is outside `tsc` and outside `vitest`: nothing in it is typechecked,
 * nothing in it is covered, and a typo in it is a runtime error on the one page
 * that can drain a host. `docs/PLATFORM.md` §5.1 states the rule that follows,
 * and states it as a rule because it will otherwise erode:
 *
 *   > All decisions live in typed, tested modules; the HTML string is markup
 *   > and event wiring only. **Nothing that can be wrong may live in it.**
 *
 * So this file holds the redaction, the shaping, the aggregation and the
 * honesty list, and `console.ts` holds `innerHTML` and `addEventListener`.
 * The flag-document logic — the diff, the risk verdict, the confirm delay, the
 * warnings — is one level further out still, in `shared/src/flags.ts`, because
 * it is pure and belongs beside the document it edits.
 */

import { itemStateFor } from '@doomcraft/shared/items';
import { SERVER_FLAG_FOR } from '@doomcraft/shared/features';
import { exposureBp, onLadder, type FlagConfig } from '@doomcraft/shared/flags';
import { redactProfileKey } from '../adminAudit.js';
import type { AuditEntry } from '../entitlementGuard.js';
import type { ConnectionStats } from '../net.js';
import type { LedgerEntry } from '../journal.js';
import type { AdDayRollup } from '../adsRollup.js';
import type { StoredProfile } from '../persistence.js';

/* ------------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------------ */

/**
 * `guard.recent()` with the device ids taken out.
 *
 * The guard's ring holds a FULL device id on every row, and until this existed
 * `GET /api/admin/entitlement` returned it verbatim — so the surface built to
 * watch for somebody probing the reward gate was itself handing out the stable
 * identifier of every player who tripped it. `docs/PLATFORM.md` §5.7 requires
 * every admin serialiser to redact; this is the one for the guard.
 *
 * `sessionId` goes too. It is `"<room key>#<round>"` and a private room's key
 * IS its join code, so an audit row from a private match carried a live code
 * out of the same door `redactRoomRow` was written to close.
 */
export function redactGuardAudit(rows: readonly AuditEntry[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    ms: r.ms,
    device: r.deviceId === '' ? '' : redactProfileKey(r.deviceId),
    session: r.sessionId === '' ? '' : redactProfileKey(r.sessionId),
    code: r.code,
    reason: r.reason,
    trust: r.trust,
    stripped: r.stripped,
  }));
}

/** A journal page with the player id already reduced to eight characters. */
export function redactLedgerRows(rows: readonly LedgerEntry[]): Array<Record<string, unknown>> {
  return rows.map((e) => ({ ...e, playerId: redactProfileKey(e.playerId) }));
}

/**
 * A stored profile as an operator may see it.
 *
 * `publicProfile` is not this. It strips the three secrets and keeps the full
 * `deviceId`, which is right for the owner of that device asking about
 * themselves and wrong for a console. This drops the device id entirely, keeps
 * the numbers a support ticket is actually about, and names nothing else — an
 * allowlist, so a field added to `StoredProfile` tomorrow is absent here until
 * somebody decides it belongs.
 */
export function operatorProfileView(p: StoredProfile): Record<string, unknown> {
  return {
    key: redactProfileKey(p.deviceId),
    version: p.version,
    createdMs: p.createdMs,
    updatedMs: p.updatedMs,
    linked: p.accountId !== null,
    progress: {
      xp: p.progress.xp,
      level: p.progress.level,
      kills: p.progress.kills,
      deaths: p.progress.deaths,
      gamesPlayed: p.progress.gamesPlayed,
      secondsPlayed: p.progress.secondsPlayed,
    },
    economy: {
      scrap: p.economy.scrap,
      lifetimeScrap: p.economy.lifetimeScrap,
      day: p.economy.day,
      dayXp: p.economy.dayXp,
      dayScrap: p.economy.dayScrap,
      dayMatches: p.economy.dayMatches,
    },
    entitlements: { adsRemoved: p.entitlements.adsRemoved },
    stats: p.stats,
  };
}

/* ------------------------------------------------------------------------ *
 * Analytics, from data this process already had
 * ------------------------------------------------------------------------ */

export interface Spread {
  readonly n: number;
  readonly total: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/** `p` in 0..1. Nearest-rank on a sorted copy; `n === 0` is all zeroes. */
export function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0, total: 0, p50: 0, p99: 0, max: 0 };
  let total = 0;
  for (const v of sorted) total += v;
  const at = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return { n, total, p50: at(0.5), p99: at(0.99), max: sorted[n - 1] };
}

/**
 * Per-connection counters rolled up per host.
 *
 * `ConnectionStats` (`server/src/net.ts`) is maintained live on every
 * connection and was **never aggregated and never served** — so the
 * reconciliation-correction signal `docs/INFRASTRUCTURE.md:573-585` calls the
 * metric nobody instruments was sitting in memory the whole time. This is four
 * lines of arithmetic over data the process already had, which is exactly the
 * kind of analytics that ships before a consent gate: no event is emitted, no
 * identifier is involved, nothing leaves the origin.
 */
export function connectionRollup(stats: readonly ConnectionStats[]): Record<string, unknown> {
  const pick = (f: (s: ConnectionStats) => number): Spread => spreadOf(stats.map(f));
  return {
    connections: stats.length,
    bytesSent: pick((s) => s.bytesSent),
    bytesReceived: pick((s) => s.bytesReceived),
    snapshotsSent: pick((s) => s.snapshotsSent),
    chunksSent: pick((s) => s.chunksSent),
    appliedInputs: pick((s) => s.appliedInputs),
    /* The three that mean something is wrong rather than something is busy. */
    droppedInputs: pick((s) => s.droppedInputs),
    rejectedEdits: pick((s) => s.rejectedEdits),
    violations: pick((s) => s.violations),
  };
}

/* ------------------------------------------------------------------------ *
 * What this console CANNOT do
 * ------------------------------------------------------------------------ */

export interface MissingCapability {
  readonly verb: string;
  /** What is missing, in one line an operator can act on. */
  readonly why: string;
  /** The phase in `docs/PLATFORM.md` §12 that builds it. */
  readonly when: string;
}

/**
 * The honest half of user management, and it is not decoration.
 *
 * `docs/PLATFORM.md` §5.6 walks every operator verb and finds that most of them
 * have **no storage behind them at all**: there is no moderation field on
 * `StoredProfile`, no `Room.kick`, no store method that adjusts a currency, no
 * `unlink` on the filesystem seam, and no way to enumerate players because
 * `readdir` is declared and never called. A console that renders those as
 * buttons is a console that lies about what it can do, and the operator finds
 * out at the moment they most need it to be true.
 *
 * So the console renders THIS list instead, verbatim, next to the lookup — and
 * a test asserts that every entry reaches the page. When one of these is built,
 * deleting its row here is part of building it.
 */
export const MISSING_CAPABILITIES: readonly MissingCapability[] = Object.freeze([
  // C6 (2026-08-28) deleted its rows on the way in, as building them
  // requires: ban (profile + account + live kick + ticket refusal), kick,
  // currency adjust (admin.adjust journal rows), entitlement flip and item
  // revoke are real now — /api/admin/player/*. C6.1 (same day) deleted
  // 'Undo a merge' (undoMerge over the merged/ archive + the journal pair,
  // /api/admin/merge/undo) and 'Reset progress' (archive-first, journalled,
  // /api/admin/player/reset-progress).
  Object.freeze({
    verb: 'Mute / shadowban',
    why: 'The ban is all-or-nothing today: there is no chat to mute and no reward-strip-but-admit '
      + 'path wired at the room. The moderation states exist on the account record; the enforcement '
      + 'shades do not.',
    when: 'with the social features that make them meaningful',
  }),
  Object.freeze({
    verb: 'Refund a real purchase',
    why: 'The entitlement FLIP is auditable now, but a money-out refund needs the provider that '
      + 'took the money in. No Paddle, no clawback.',
    when: 'C8 — the vendors',
  }),
  Object.freeze({
    verb: 'Export a player\'s data (DSAR)',
    why: 'publicProfile is a debug view, not an export: it omits the entire SaveFile, which is where '
      + 'the play history actually lives, and the server has never held one.',
    when: 'LATER — §9',
  }),
  Object.freeze({
    verb: 'Erase a player',
    why: 'The filesystem seam has no unlink. Erasure is a job across seven stores, not a button.',
    when: 'LATER — §9',
  }),
  Object.freeze({
    verb: 'List or search players',
    why: 'Structurally impossible: the profile store declares readdir and never calls it, so it cannot '
      + 'enumerate. Lookup is by exact device id only.',
    when: 'LATER — needs Postgres',
  }),
]);

/** The two writes this console offers, and the one it deliberately does not. */
export const CONSOLE_WRITES: readonly string[] = Object.freeze([
  'Freeze all rollouts — one POST, reversible by unfreezing.',
  'Per-flag force / rollout, snapped to the docs/PATCHING.md ladder.',
]);

export function consoleCapabilities(): Record<string, unknown> {
  return {
    writes: CONSOLE_WRITES,
    missing: MISSING_CAPABILITIES,
    /* Drain has a route and no button. See console.ts for the argument. */
    drainIsCurlOnly: true,
  };
}

/* ------------------------------------------------------------------------ *
 * The lookup
 * ------------------------------------------------------------------------ */

export interface PlayerLookupInput {
  readonly key: string;
  readonly profile: StoredProfile | null;
  readonly rows: readonly LedgerEntry[];
  readonly sums: { fromDay: string; rows: number; xp: number; scrap: number };
  readonly liveItemIds: ReadonlySet<string>;
}

/**
 * One player, as much as this host can honestly say about them.
 *
 * `reconcile` is the point of it: the stored balance beside the sum of every
 * delta the journal holds. A divergence is the only evidence that a payout
 * moved a balance without being recorded, and it is invisible from either
 * number alone. `fromDay` is the oldest retained day — outside it the sum is a
 * lower bound and not a balance, and an operator must not read it as one.
 *
 * `profile: null` is normal on a fleet: rows and balances can live on different
 * boxes until there is one shared store. It is reported as "not on this host",
 * never as "no such player", because this process cannot tell the difference.
 */
export function playerLookup(input: PlayerLookupInput): Record<string, unknown> {
  const p = input.profile;
  const revoked = new Set((p?.moderation.revokedItems ?? []).map((r) => r.ref));
  return {
    key: redactProfileKey(input.key),
    onThisHost: p !== null,
    profile: p === null ? null : operatorProfileView(p),
    /* Item STATE is derived here, at read time, from the live release — the
     * §7 rule made visible: the same inventory reads differently after a
     * rollback, and nothing was written to make that happen. */
    inventory: p === null ? null : {
      equippedSkin: p.inventory.equippedSkin,
      title: p.inventory.title,
      items: p.inventory.items.map((it) => ({
        ref: it.ref, ms: it.ms, source: it.source,
        state: itemStateFor(it.ref, input.liveItemIds, revoked),
      })),
    },
    moderation: p === null ? null : {
      banned: p.moderation.banned,
      bannedUntilMs: p.moderation.bannedUntilMs,
      reason: p.moderation.reason,
      revokedItems: p.moderation.revokedItems.length,
    },
    ageBand: p?.ageBand ?? 'unknown',
    rows: redactLedgerRows(input.rows),
    reconcile: {
      fromDay: input.sums.fromDay,
      rows: input.sums.rows,
      xp: { stored: p === null ? null : p.progress.xp, journal: input.sums.xp },
      scrap: { stored: p === null ? null : p.economy.scrap, journal: input.sums.scrap },
    },
    missing: MISSING_CAPABILITIES,
  };
}

/* ------------------------------------------------------------------------ *
 * The flag registry, as a row an operator can act on
 * ------------------------------------------------------------------------ */

/**
 * Which client `Feature` each server flag drives — `SERVER_FLAG_FOR` inverted.
 *
 * Built from the map rather than restated, so the console cannot claim a
 * pairing the client does not actually make. It is the SAME object the browser
 * reads; `shared/src/features.ts` is the only place the two namespaces meet.
 */
export const CLIENT_FEATURE_FOR_FLAG: Readonly<Record<string, string>> = Object.freeze(
  ((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const feature of Object.keys(SERVER_FLAG_FOR)) {
      const key = SERVER_FLAG_FOR[feature as keyof typeof SERVER_FLAG_FOR];
      if (key !== null) out[key] = feature;
    }
    return out;
  })(),
);

/**
 * One registry row plus the two things an operator needs and the registry does
 * not carry: how much of the player base it currently reaches, and whether a
 * player can override it in their own browser.
 *
 * The second one is `docs/PLATFORM.md` §5.5(b)'s rule made visible:
 *
 *   > A product gate decides whether a player is *shown* something and may be
 *   > overridden by that player. A kill switch decides whether the server
 *   > *does* something and may not. Any surface that costs money or grants
 *   > value requires BOTH.
 *
 * `client/src/hud/hud.ts`'s `economySurfacesOn` is the pattern — `product &&
 * flagOn(bits, 'economy_scrap')` — and a row this marks `maskable` is a row
 * where turning the flag ON still shows nothing to a player who turned the
 * product gate off in Settings. Turning it OFF is never maskable: the surfaces
 * require both, so the server's "no" always wins.
 */
export function flagRegistryView(
  registry: ReadonlyArray<Record<string, unknown>>,
  doc: FlagConfig,
): Array<Record<string, unknown>> {
  return registry.map((row) => {
    const key = typeof row.key === 'string' ? row.key : '';
    const feature = CLIENT_FEATURE_FOR_FLAG[key];
    return {
      ...row,
      reachBp: exposureBp(key, doc),
      onLadder: onLadder(typeof row.rolloutBp === 'number' ? row.rolloutBp : 0),
      clientFeature: feature ?? null,
      /* A player's own Settings toggle beats the server's YES, never its NO. */
      maskable: feature !== undefined,
    };
  });
}

/* ------------------------------------------------------------------------ *
 * The sponsor delivery report (docs/SPONSORS.md §3.5)
 * ------------------------------------------------------------------------ */

/**
 * A metric that may not be answerable, and says why when it is not.
 *
 * The §3.5 caveat block exists because a wrong number here is worse than no
 * number: a sponsor prices a buy off it. So every metric is either a value or
 * an explicit refusal carrying its reason, and the console prints an em-dash
 * plus that reason — never 0, and never 100%. The two are not the same failure:
 * a rate with an empty denominator is UNAVAILABLE, and printing 0 asserts a
 * measurement that was never taken.
 */
export interface Measured {
  value: number | null;
  /** Empty when `value` is a number. Printed verbatim beside the em-dash. */
  reason: string;
  /** True when the value is a floor rather than a total. */
  lowerBound?: boolean;
}

function has(value: number): Measured { return { value, reason: '' }; }
function no(reason: string): Measured { return { value: null, reason }; }

/** A rate, or the reason its denominator does not exist. */
function rate(numerator: number, denominator: number, reason: string): Measured {
  if (denominator <= 0) return no(reason);
  return has(Math.round((numerator / denominator) * 10000) / 100);
}

export interface AdReportInput {
  days: readonly AdDayRollup[];
  /** The oldest day with an aggregate, or '' when there is none. */
  fromDay: string;
  /** Days whose raw rows exist but have not been aggregated yet. */
  pendingDays: number;
  /** In-process counters, for the live half of the screen. */
  live: Record<string, number>;
}

/**
 * Build the delivery report.
 *
 * Everything the 2D DOM path can honestly answer is answered; everything that
 * needs the in-world ray pipeline is refused BY NAME, because §3.5 promises
 * those metrics and a blank row would read as zero rather than as absent.
 */
export function adReport(input: AdReportInput): Record<string, unknown> {
  const t = {
    served: 0, rendered: 0, viewable: 0, nonViewable: 0, undetermined: 0,
    renderedWithoutVerdict: 0, exposureMs: 0, straddled: 0, unversioned: 0,
    sessions: 0, devices: 0, rows: 0,
  };
  const bySource: Record<string, number> = {};
  const byCampaign: Record<string, number> = {};
  const bySurface: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const merge = (into: Record<string, number>, from: Record<string, number>): void => {
    for (const k of Object.keys(from)) into[k] = (into[k] ?? 0) + from[k];
  };
  for (const d of input.days) {
    t.served += d.served; t.rendered += d.rendered; t.viewable += d.viewable;
    t.nonViewable += d.nonViewable; t.undetermined += d.undetermined;
    t.renderedWithoutVerdict += d.renderedWithoutVerdict;
    t.exposureMs += d.exposureMs; t.straddled += d.straddled;
    t.unversioned += d.unversioned; t.sessions += d.sessions;
    t.devices += d.devices; t.rows += d.rows;
    merge(bySource, d.bySource); merge(byCampaign, d.byCampaign);
    merge(bySurface, d.bySurface); merge(byPlatform, d.byPlatform);
    merge(byMode, d.byMode);
  }

  const measured = t.viewable + t.nonViewable;
  const NO_3D = 'needs the in-world measurement pipeline (phase 3); no 2D DOM slot produces it';

  return {
    /* Nothing here is settled. §3.7.5's item 8 settlement layer does NOT exist,
     * so no figure on this screen is an invoice — and docs/SPONSORS.md:1338
     * claims otherwise and is wrong. */
    provisional: true,
    /* The window this actually covers, derived from the aggregates that exist
     * rather than from a configured range — the `journal.fromDay` precedent. */
    fromDay: input.fromDay,
    days: input.days.length,
    pendingDays: input.pendingDays,

    counts: {
      /* SERVER-SIDE ALLOCATION. Not an impression, not a rendered impression:
       * the client may never have displayed it. */
      served: t.served,
      /* §3.5 metric 1, and it is the client that attests it. */
      rendered: t.rendered,
      viewable: t.viewable,
      nonViewable: t.nonViewable,
      undetermined: t.undetermined,
      undeterminedByAbsence: t.renderedWithoutVerdict,
    },

    rates: {
      /* Metric 5 = (2+3)/1. Target >95%. */
      measuredRate: t.rendered > 0
        ? has(Math.round((measured / t.rendered) * 10000) / 100)
        : no('no rendered impressions in this window'),
      /* Metric 6 = 2/(2+3). NOT viewable/rendered — MRC explicitly forbids
       * quoting the viewable share of Total as the Viewable Rate, and with no
       * measured failures recorded the honest answer is that it is unavailable,
       * never 100%. */
      viewableRate: rate(t.viewable, measured, 'nothing was measured in this window: no viewable and no measured-non-viewable impressions'),
      /* Metric 7, all three side by side so the conflation is impossible. */
      distributionOfRendered: t.rendered > 0 ? {
        viewable: Math.round((t.viewable / t.rendered) * 10000) / 100,
        nonViewable: Math.round((t.nonViewable / t.rendered) * 10000) / 100,
        undetermined: Math.round((t.undetermined / t.rendered) * 10000) / 100,
      } : null,
    },

    exposure: {
      /* IIG §3.2.10.2 Total Exposure Time. Max-per-nonce within each day, so a
       * fill that straddled midnight contributes only its part. */
      totalMs: t.straddled > 0
        ? { value: t.exposureMs, reason: `${t.straddled} fill(s) span more than one day shard, so this is a floor`, lowerBound: true }
        : has(t.exposureMs),
      medianViewableMs: no('exposure is accrued as a running total per fill, not as per-tick samples, so a median cannot be derived'),
      meanViewableMs: no('same: no per-fill qualified-time distribution is recorded'),
      sustainedViews4s: no('requires a continuous 4s qualified run to be recorded; the meter records only that a run completed'),
    },

    /* The quality-of-exposure block §3.5 promises. Named and refused, because a
     * missing row reads as zero and these are the numbers that justify pricing
     * an in-world surface above a banner. */
    quality: {
      screenCoverageP50: no(NO_3D), screenCoverageP90: no(NO_3D),
      viewAngleBuckets: no(NO_3D), distanceDistribution: no(NO_3D),
      skewRatio: no(NO_3D), occludedSplit: no(NO_3D),
    },

    audience: {
      /* Labelled exactly as §3.5 requires: session-uniques, never person-uniques. */
      sessionUniques: has(t.sessions),
      deviceHandles: { value: t.devices, reason: 'an 8-hex 32-bit hash: distinct handles, a floor on distinct devices', lowerBound: true },
      personUniques: no('we do not identify people; §3.5 requires this be reported as session-uniques'),
      frequencyDistribution: no('per-device impression counts are not carried in the daily aggregate'),
      byMode, byPlatform,
      mobilePortrait: no('orientation is not captured at observation time; `platform` is a coarse-pointer classification only'),
    },

    inventory: {
      /* With nothing booked, every impression is unsold house inventory, and
       * saying so is the difference between a report and a sales sheet. */
      direct: bySource.direct ?? 0,
      house: bySource.house ?? 0,
      byCampaign, bySurface,
    },

    /* Rows written before the instrumentation. Reported apart, never blended:
     * they carry no nonce, so they cannot answer any of the above. */
    preInstrumentationRows: t.unversioned,
    live: input.live,
  };
}
