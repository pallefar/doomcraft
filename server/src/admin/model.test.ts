/**
 * DOOMCRAFT — what the console displays, and the two things it must never do:
 * put a full identifier on the wire, and claim a power it does not have.
 */

import { describe, expect, it } from 'vitest';

import {
  CLIENT_FEATURE_FOR_FLAG,
  MISSING_CAPABILITIES,
  connectionRollup,
  consoleCapabilities,
  flagRegistryView,
  operatorProfileView,
  playerLookup,
  redactGuardAudit,
  redactLedgerRows,
  spreadOf,
} from './model.js';
import { RejectCode, type AuditEntry } from '../entitlementGuard.js';
import { createProfile, type StoredProfile } from '../persistence.js';
import { redactPlayerId, type LedgerEntry } from '../journal.js';
import type { ConnectionStats } from '../net.js';
import { FLAG_ORDER, createFlagConfig, type FlagConfig } from '@doomcraft/shared/flags';
import { Feature, SERVER_FLAG_FOR } from '@doomcraft/shared/features';

const DEVICE = 'device-abcdef0123';

function guardRow(over: Partial<AuditEntry> = {}): AuditEntry {
  return Object.freeze({
    ms: 1,
    sessionId: 'deathmatch~m4gic1#3',
    deviceId: DEVICE,
    code: RejectCode.NOT_A_PARTICIPANT,
    reason: 'not a participant',
    trust: 'ranked/server grants xp',
    stripped: Object.freeze(['xp']),
    ...over,
  });
}

function ledgerRow(): LedgerEntry {
  return Object.freeze({
    id: '01ABC', ms: 1, kind: 'match.payout', playerId: DEVICE,
    sourceId: 'host:room:deathmatch#1', currency: 'xp', delta: 10,
    balanceAfter: 10, actor: '', reason: 'match',
  }) as unknown as LedgerEntry;
}

function stats(over: Partial<ConnectionStats> = {}): ConnectionStats {
  return {
    droppedInputs: 0, rejectedEdits: 0, appliedInputs: 0, bytesSent: 0,
    bytesReceived: 0, messagesIn: 0, snapshotsSent: 0, chunksSent: 0, violations: 0,
    ...over,
  };
}

/* ------------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------------ */

describe('nothing leaves with a full identifier on it', () => {
  it('replaces the device id in every guard row with an eight-character handle', () => {
    const out = redactGuardAudit([guardRow()]);
    expect(JSON.stringify(out)).not.toContain(DEVICE);
    expect(out[0].device).toBe(redactPlayerId(DEVICE));
    expect(String(out[0].device).length).toBe(8);
  });

  /**
   * The one people miss. `sessionId` is `"<room key>#<round>"` and a PRIVATE
   * room's key IS its join code, so the refusal ring carried a live code out of
   * the same door `redactRoomRow` exists to close.
   */
  it('takes the sessionId too, because a private room key is a live join code', () => {
    const out = redactGuardAudit([guardRow()]);
    expect(JSON.stringify(out)).not.toContain('m4gic1');
    expect(JSON.stringify(out)).not.toContain('~');
  });

  it('keeps the parts an operator is actually looking at', () => {
    const out = redactGuardAudit([guardRow()]);
    expect(out[0].reason).toBe('not a participant');
    expect(out[0].stripped).toEqual(['xp']);
    expect(out[0].code).toBe(RejectCode.NOT_A_PARTICIPANT);
  });

  it('redacts the player id on a ledger page', () => {
    const out = redactLedgerRows([ledgerRow()]);
    expect(JSON.stringify(out)).not.toContain(DEVICE);
    expect(out[0].playerId).toBe(redactPlayerId(DEVICE));
  });

  /**
   * `publicProfile` is NOT this. It strips the three secrets and keeps the full
   * device id, which is right for the owner of that device and wrong for a
   * console. This is an allowlist, so a field added to `StoredProfile` tomorrow
   * is absent until somebody decides it belongs.
   */
  it('shows an operator a profile with no device id and no secret in it', () => {
    const p: StoredProfile = createProfile(DEVICE);
    p.accountSecret = 'a-secret-token';
    p.accountId = 'house:someone';
    p.entitlements.receipt = 'paddle-receipt-1234';
    const view = JSON.stringify(operatorProfileView(p));
    expect(view).not.toContain(DEVICE);
    expect(view).not.toContain('a-secret-token');
    expect(view).not.toContain('house:someone');
    expect(view).not.toContain('paddle-receipt-1234');
    // And it still says the thing a support ticket is about.
    expect(view).toContain('"linked":true');
    expect(view).toContain('"scrap"');
  });
});

/* ------------------------------------------------------------------------ *
 * Analytics from data the process already had
 * ------------------------------------------------------------------------ */

describe('the connection rollup', () => {
  it('is all zeroes for no connections rather than NaN or a crash', () => {
    expect(spreadOf([])).toEqual({ n: 0, total: 0, p50: 0, p99: 0, max: 0 });
    const out = connectionRollup([]);
    expect(out.connections).toBe(0);
    expect(JSON.stringify(out)).not.toContain('null');
    expect(JSON.stringify(out)).not.toContain('NaN');
  });

  it('takes the percentiles by nearest rank, so p99 of 100 samples is the 99th', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = spreadOf(values);
    expect(s.n).toBe(100);
    expect(s.total).toBe(5050);
    expect(s.p50).toBe(50);
    expect(s.p99).toBe(99);
    expect(s.max).toBe(100);
  });

  it('rolls up the three counters that mean something is WRONG, not busy', () => {
    const out = connectionRollup([
      stats({ bytesSent: 100, violations: 0, droppedInputs: 1 }),
      stats({ bytesSent: 900, violations: 7, droppedInputs: 3 }),
    ]) as Record<string, { total: number; max: number }>;
    expect(out.bytesSent.total).toBe(1000);
    expect(out.violations.max).toBe(7);
    expect(out.droppedInputs.total).toBe(4);
  });
});

/* ------------------------------------------------------------------------ *
 * The honesty list
 * ------------------------------------------------------------------------ */

describe('what the console cannot do', () => {
  it('names every verb that STILL has no storage behind it — C6/C6.1 built theirs out of the list', () => {
    const verbs = MISSING_CAPABILITIES.map((m) => m.verb.toLowerCase()).join(' | ');
    for (const needle of ['mute', 'refund', 'export', 'erase', 'list']) {
      expect(verbs, `${needle} is not named as impossible`).toContain(needle);
    }
    // And the built ones are GONE — a capability list that still claims ban
    // is impossible after C6, or a merge undo after C6.1, is the same lie
    // in the other direction.
    for (const built of ['ban /', 'kick one', 'adjust a currency', 'undo a merge', 'reset progress']) {
      expect(verbs, `${built} is still listed as impossible`).not.toContain(built);
    }
  });

  it('gives every one of them a reason and a phase, so the list is actionable', () => {
    for (const m of MISSING_CAPABILITIES) {
      expect(m.why.length, `${m.verb} has no reason`).toBeGreaterThan(40);
      expect(m.when.length, `${m.verb} has no phase`).toBeGreaterThan(1);
    }
  });

  it('ships the list with every player lookup, so no screen can render without it', () => {
    const out = playerLookup({
      key: DEVICE, profile: null, rows: [],
      sums: { fromDay: '', rows: 0, xp: 0, scrap: 0 },
      liveItemIds: new Set<string>(),
    });
    expect((out.missing as unknown[]).length).toBe(MISSING_CAPABILITIES.length);
  });

  it('claims exactly two writes, and says drain is not one of them', () => {
    const caps = consoleCapabilities();
    expect((caps.writes as string[]).length).toBe(2);
    expect(caps.drainIsCurlOnly).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * The lookup
 * ------------------------------------------------------------------------ */

describe('one player', () => {
  it('says "not on this host" rather than "no such player", because it cannot tell', () => {
    const out = playerLookup({
      key: DEVICE, profile: null, rows: [],
      sums: { fromDay: '', rows: 0, xp: 0, scrap: 0 },
      liveItemIds: new Set<string>(),
    });
    expect(out.onThisHost).toBe(false);
    expect(out.profile).toBeNull();
    const rec = out.reconcile as { xp: { stored: number | null } };
    expect(rec.xp.stored).toBeNull();
  });

  it('puts the stored balance beside the journal sum, which is the only way a gap is visible', () => {
    const p = createProfile(DEVICE);
    p.progress.xp = 500;
    p.economy.scrap = 40;
    const out = playerLookup({
      key: DEVICE, profile: p, rows: [ledgerRow()],
      sums: { fromDay: '2026-08-01', rows: 3, xp: 480, scrap: 40 },
      liveItemIds: new Set<string>(),
    });
    const rec = out.reconcile as {
      xp: { stored: number; journal: number }; scrap: { stored: number; journal: number };
      fromDay: string;
    };
    expect(rec.xp.stored).toBe(500);
    expect(rec.xp.journal).toBe(480);
    expect(rec.scrap.stored).toBe(rec.scrap.journal);
    // Without `fromDay` a truncated sum reads as a discrepancy.
    expect(rec.fromDay).toBe('2026-08-01');
  });

  it('never puts the device id it was handed back on the wire', () => {
    const out = playerLookup({
      key: DEVICE, profile: createProfile(DEVICE), rows: [ledgerRow()],
      sums: { fromDay: '', rows: 1, xp: 0, scrap: 0 },
      liveItemIds: new Set<string>(),
    });
    expect(JSON.stringify(out)).not.toContain(DEVICE);
  });
});

/* ------------------------------------------------------------------------ *
 * The registry row
 * ------------------------------------------------------------------------ */

describe('the flag registry as a row an operator can act on', () => {
  const registry = FLAG_ORDER.map((key, bit) => ({ key, bit, rolloutBp: 0, force: null }));

  it('inverts SERVER_FLAG_FOR rather than restating it', () => {
    expect(CLIENT_FEATURE_FOR_FLAG.online_play).toBe(Feature.ONLINE_MULTIPLAYER);
    expect(CLIENT_FEATURE_FOR_FLAG.economy_scrap).toBe(Feature.ECONOMY);
    // A feature mapped to null must not appear on any flag row.
    expect(Object.values(CLIENT_FEATURE_FOR_FLAG)).not.toContain(Feature.SHARED_WORLDS);
    // Every non-null pairing round-trips.
    for (const f of Object.keys(SERVER_FLAG_FOR) as Feature[]) {
      const key = SERVER_FLAG_FOR[f];
      if (key === null) continue;
      expect(CLIENT_FEATURE_FOR_FLAG[key]).toBe(f);
    }
  });

  it('marks the rows a player can mask in their own browser, and only those', () => {
    const rows = flagRegistryView(registry, createFlagConfig());
    const byKey = new Map(rows.map((r) => [r.key as string, r]));
    expect(byKey.get('economy_scrap')?.maskable).toBe(true);
    expect(byKey.get('economy_scrap')?.clientFeature).toBe(Feature.ECONOMY);
    expect(byKey.get('sponsor_slots')?.maskable).toBe(false);
    expect(byKey.get('sponsor_slots')?.clientFeature).toBeNull();
  });

  it('states the reach a flag currently has, including the default-on one', () => {
    const rows = flagRegistryView(registry, createFlagConfig());
    const byKey = new Map(rows.map((r) => [r.key as string, r]));
    // No rule and defaultOn: true. Rendering 0% here would talk somebody into
    // "turning on" something that is already live for everybody.
    expect(byKey.get('client_update_prompt')?.reachBp).toBe(10000);
    expect(byKey.get('economy_scrap')?.reachBp).toBe(0);
  });

  it('says when a rollout is off the ladder, per row', () => {
    const doc: FlagConfig = { ...createFlagConfig(), rules: { economy_scrap: { force: null, rolloutBp: 5000 } } };
    const rows = flagRegistryView(
      FLAG_ORDER.map((key, bit) => ({ key, bit, rolloutBp: doc.rules[key]?.rolloutBp ?? 0, force: null })),
      doc,
    );
    const byKey = new Map(rows.map((r) => [r.key as string, r]));
    expect(byKey.get('economy_scrap')?.onLadder).toBe(false);
    expect(byKey.get('share_cards')?.onLadder).toBe(true);
  });
});
