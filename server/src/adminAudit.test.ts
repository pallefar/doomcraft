/**
 * DOOMCRAFT — the admin action log, and the two fields that make a row worth
 * having.
 *
 * The mutation guard is tested here as a pure function AND against the live
 * binary in `deploy.test.ts`. Both are needed and neither replaces the other:
 * this one can enumerate the refusals cheaply, and that one proves the route
 * actually calls it — which is the failure mode this repository keeps producing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdminAuditLog,
  MIN_ACTOR_CHARS,
  MIN_REASON_CHARS,
  MAX_STATE_CHARS,
  clampAction,
  isModerationVerb,
  parseAction,
  redactProfileKey,
  requireMutationFields,
  type AdminAction,
} from './adminAudit.js';
import { redactPlayerId } from './journal.js';

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-audit-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function row(over: Partial<AdminAction> = {}): Omit<AdminAction, 'id'> {
  return {
    ms: Date.UTC(2026, 7, 22, 9, 0, 0),
    actor: 'karsten',
    verb: 'flags.set',
    subject: 'economy_scrap',
    reason: 'stepping the rollout to 25 percent',
    before: '{"rolloutBp":500}',
    after: '{"rolloutBp":2500}',
    outcome: 'applied',
    requestId: 'abc123',
    ...over,
  };
}

/* ------------------------------------------------------------------------ *
 * The guard on every mutation
 * ------------------------------------------------------------------------ */

describe('requireMutationFields', () => {
  it('refuses a body with no actor at all', () => {
    const v = requireMutationFields({ reason: 'a perfectly adequate statement of reasons' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('actor');
  });

  it('refuses a reason shorter than the minimum — "fix" is not a statement of reasons', () => {
    const v = requireMutationFields({ actor: 'me', reason: 'fix' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('reason');
  });

  it('counts the reason AFTER trimming, so whitespace is not a reason', () => {
    const spaces = ' '.repeat(MIN_REASON_CHARS + 5);
    const v = requireMutationFields({ actor: 'me', reason: spaces });
    expect(v.ok).toBe(false);
  });

  it('counts the reason after stripping control characters, so a tab run is not one either', () => {
    // Control characters become spaces and then trim away. A row padded with
    // control characters would otherwise satisfy a length check and read as
    // empty in every viewer.
    const v = requireMutationFields({ actor: 'me', reason: '\t\n\r'.repeat(20) });
    expect(v.ok).toBe(false);
  });

  it('refuses a body that is not an object at all', () => {
    expect(requireMutationFields(null).ok).toBe(false);
    expect(requireMutationFields('actor=me&reason=because').ok).toBe(false);
    expect(requireMutationFields(42).ok).toBe(false);
  });

  it('accepts the minimum and hands back the trimmed values', () => {
    const v = requireMutationFields({
      actor: '  ka  ',
      reason: `  ${'x'.repeat(MIN_REASON_CHARS)}  `,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.actor).toBe('ka');
      expect(v.value.actor.length).toBe(MIN_ACTOR_CHARS);
      expect(v.value.reason.length).toBe(MIN_REASON_CHARS);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------------ */

describe('the row', () => {
  it('uses the JOURNAL\'s redactor, so there are not two of them', () => {
    // `journal.ts` says in its own source that when this file landed its
    // `redactProfileKey` must BE that function. An admin surface with two
    // redactors is an admin surface where one of them is wrong.
    expect(redactProfileKey('device-abcdef01')).toBe(redactPlayerId('device-abcdef01'));
    expect(redactProfileKey('device-abcdef01').length).toBe(8);
  });

  it('caps before/after at 2 KB per side, so one row can never matter', () => {
    const huge = 'x'.repeat(MAX_STATE_CHARS * 3);
    const a = clampAction(row({ before: huge, after: huge }) as AdminAction);
    expect(a.before.length).toBe(MAX_STATE_CHARS);
    expect(a.after.length).toBe(MAX_STATE_CHARS);
  });

  it('never lets a newline into a field, because the file is line-delimited', () => {
    const a = clampAction(row({ reason: 'line one\nline two' }) as AdminAction);
    expect(a.reason).not.toContain('\n');
  });

  it('round-trips through NDJSON', () => {
    const a = clampAction(row() as AdminAction);
    expect(parseAction(JSON.stringify(a))).toEqual(a);
  });

  it('returns null for a torn line rather than throwing', () => {
    expect(parseAction('{"id":"01ABC","ms":1,"ver')).toBeNull();
    expect(parseAction('')).toBeNull();
    expect(parseAction('null')).toBeNull();
    expect(parseAction('{"id":"01ABC"}')).toBeNull();
  });

  it('knows a moderation verb from an operational one', () => {
    expect(isModerationVerb('player.ban')).toBe(true);
    expect(isModerationVerb('flags.set')).toBe(false);
    expect(isModerationVerb('drain')).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The log
 * ------------------------------------------------------------------------ */

describe('the log on disk', () => {
  it('writes real NDJSON a restarted process reads back', async () => {
    const dir = tempRoot();
    const log = new AdminAuditLog(dir);
    const a = await log.record(row());
    await log.record(row({ subject: 'share_cards', ms: row().ms + 1000 }));
    await log.close();

    const files = readdirSync(join(dir, 'audit'));
    expect(files).toEqual(['2026-08-22.ndjson']);
    const text = readFileSync(join(dir, 'audit', files[0]), 'utf8');
    expect(text.split('\n').filter((l) => l.length > 0).length).toBe(2);

    const fresh = new AdminAuditLog(dir);
    const back = await fresh.read(0, 50);
    expect(back.length).toBe(2);
    expect(back[0].subject).toBe('share_cards');   // newest first
    expect(back[1].id).toBe(a.id);
    await fresh.close();
  });

  it('gives every row a sortable, unique id even inside one millisecond', async () => {
    const dir = tempRoot();
    const log = new AdminAuditLog(dir);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await log.record(row())).id);
    await log.close();
    expect(new Set(ids).size).toBe(40);
    expect([...ids].sort()).toEqual(ids);
  });

  it('survives a TORN write: the rows in front of it are still readable', async () => {
    const dir = tempRoot();
    const log = new AdminAuditLog(dir);
    await log.record(row());
    await log.close();
    // A process killed mid-write leaves a line with no newline on the end.
    const file = join(dir, 'audit', '2026-08-22.ndjson');
    writeFileSync(file, readFileSync(file, 'utf8') + '{"id":"01TORN","ms":178739', 'utf8');

    const next = new AdminAuditLog(dir);
    await next.record(row({ subject: 'after-the-tear', ms: row().ms + 1 }));
    const back = await next.read(0, 50);
    await next.close();
    // Two whole rows: the one before the tear and the one after it. Without the
    // blank-line guard the new append concatenates onto the partial line and
    // BOTH are lost, not one.
    expect(back.map((r) => r.subject)).toEqual(['after-the-tear', 'economy_scrap']);
  });

  it('never throws when the write fails — an action that happened is still an action', async () => {
    // A read-only root: `ready()` fails, every record is counted as failed, and
    // the caller still gets its row back. Turning this into a 500 would leave
    // the operator believing the action did not fire.
    const log = new AdminAuditLog('/proc/definitely-not-writable');
    const a = await log.record(row());
    expect(a.actor).toBe('karsten');
    expect(log.status().failed).toBeGreaterThan(0);
  });

  it('pages newest-first and stops at the limit', async () => {
    const dir = tempRoot();
    const log = new AdminAuditLog(dir);
    for (let i = 0; i < 12; i++) await log.record(row({ subject: `s${i}`, ms: row().ms + i }));
    const page = await log.read(0, 5);
    await log.close();
    expect(page.length).toBe(5);
    expect(page[0].subject).toBe('s11');
  });

  it('honours `since`, so a console polls instead of re-reading', async () => {
    const dir = tempRoot();
    const log = new AdminAuditLog(dir);
    await log.record(row({ subject: 'old', ms: row().ms }));
    await log.record(row({ subject: 'new', ms: row().ms + 60_000 }));
    const page = await log.read(row().ms + 1, 50);
    await log.close();
    expect(page.map((r) => r.subject)).toEqual(['new']);
  });
});

/* ------------------------------------------------------------------------ *
 * Retention, and the conflict resolved where it was created
 * ------------------------------------------------------------------------ */

describe('retention', () => {
  it('drops an expired day whole when nothing on it is a moderation record', async () => {
    const dir = tempRoot();
    let now = Date.UTC(2026, 7, 22, 9, 0, 0);
    const log = new AdminAuditLog(dir, { clock: () => now, days: 2 });
    await log.record(row({ ms: now }));
    now += 5 * 86_400_000;
    await log.record(row({ ms: now, subject: 'today' }));
    expect(await log.sweep()).toBe(1);
    const left = await log.read(0, 50);
    await log.close();
    expect(left.map((r) => r.subject)).toEqual(['today']);
    expect(readdirSync(join(dir, 'audit'))).toEqual(['2026-08-27.ndjson']);
  });

  /**
   * THE ONE THAT MAKES THE SPLIT REAL.
   *
   * `docs/INFRASTRUCTURE.md:851` — a ban that deletes itself is an exploit — so
   * a moderation row outlives the retention window. The day file is the storage
   * unit and is NOT the retention unit, which is why the sweep rewrites rather
   * than unlinking: a file holding one ban must not be deleted because the flag
   * writes next to it aged out.
   */
  it('KEEPS the moderation rows on an expired day and drops only the rest', async () => {
    const dir = tempRoot();
    let now = Date.UTC(2026, 7, 22, 9, 0, 0);
    const log = new AdminAuditLog(dir, { clock: () => now, days: 2 });
    await log.record(row({ ms: now, verb: 'flags.set', subject: 'economy_scrap' }));
    await log.record(row({ ms: now + 1, verb: 'player.ban', subject: 'deadbeef' }));
    now += 30 * 86_400_000;
    expect(await log.sweep()).toBe(1);
    const left = await log.read(0, 50);
    await log.close();
    expect(left.map((r) => r.verb)).toEqual(['player.ban']);
    // The day file is still there, holding only the record that may not go.
    expect(readdirSync(join(dir, 'audit'))).toEqual(['2026-08-22.ndjson']);
  });

  it('erases an operational row for a subject and PSEUDONYMISES the moderation one', async () => {
    const dir = tempRoot();
    const log = new AdminAuditLog(dir);
    await log.record(row({ subject: 'deadbeef', verb: 'currency.adjust' }));
    await log.record(row({ subject: 'deadbeef', verb: 'player.ban', ms: row().ms + 1 }));
    await log.record(row({ subject: 'cafebabe', verb: 'currency.adjust', ms: row().ms + 2 }));
    expect(await log.forget('deadbeef')).toBe(1);
    const left = await log.read(0, 50);
    await log.close();
    expect(left.map((r) => `${r.verb}:${r.subject}`).sort())
      .toEqual(['currency.adjust:cafebabe', 'player.ban:deadbeef']);
    const ban = left.find((r) => r.verb === 'player.ban');
    expect(ban?.actor).toBe('deleted');
    expect(ban?.before).toBe('');
  });
});
