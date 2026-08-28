/**
 * DOOMCRAFT — viral tier 1's three rules, each proven refusable: first-wins
 * attribution, conversion on ENGAGEMENT never signup, and the journal as
 * the payment — idempotent on the referred player forever. The caps and
 * the review queue are tested here because they ship WITH the feature.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { JsonJournal } from './journal.js';
import { MemoryStore } from './persistence.js';
import {
  CONVERT_SECONDS_PLAYED, REFERRAL_CONVERSIONS_PER_DAY, REFERRED_SCRAP, REFERRER_SCRAP,
  ReferralService,
} from './referrals.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-ref-'));
  tempDirs.push(d);
  return d;
}

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

async function rig(): Promise<{
  root: string; svc: ReferralService; store: MemoryStore; journal: JsonJournal;
  deps: { store: MemoryStore; journal: JsonJournal };
}> {
  const root = tempDir();
  const svc = new ReferralService(root, { clock: () => NOW });
  const store = new MemoryStore();
  const journal = new JsonJournal(root, { clock: () => NOW });
  await store.update('referrer-aaaa', () => { /* ensure exists */ });
  return { root, svc, store, journal, deps: { store, journal } };
}

async function makePlayed(store: MemoryStore, key: string, seconds: number, level = 1): Promise<void> {
  await store.update(key, (p) => {
    p.stats.secondsPlayed = seconds;
    p.progress.level = level;
  });
}

describe('attribution', () => {
  it('first wins forever; self-referral, unknown codes and veterans are refused', async () => {
    const { svc, store, deps } = await rig();
    const code = await svc.codeFor('referrer-aaaa', '1.2.3.4');
    expect(code).toMatch(/^RF[0-9A-Z]{6}$/);
    expect(await svc.codeFor('referrer-aaaa', '1.2.3.4')).toBe(code);   // idempotent

    expect((await svc.claim('referrer-aaaa', code, '9.9.9.9', deps)).ok).toBe(false);       // self
    expect((await svc.claim('friend-bbbb', 'RFNOSUCH', '9.9.9.9', deps)).ok).toBe(false);   // unknown

    await makePlayed(store, 'veteran-cccc', CONVERT_SECONDS_PLAYED + 1);
    const late = await svc.claim('veteran-cccc', code, '9.9.9.9', deps);
    expect(late).toEqual({ ok: false, reason: 'too-late' });            // not a coupon for veterans

    expect((await svc.claim('friend-bbbb', code, '9.9.9.9', deps)).ok).toBe(true);
    const second = await svc.claim('friend-bbbb', code, '9.9.9.9', deps);
    expect(second).toEqual({ ok: false, reason: 'already-attributed' });
  });
});

describe('conversion', () => {
  it('pays NOTHING before the engagement threshold, both sides through the journal after — and never twice', async () => {
    const { svc, store, journal, deps } = await rig();
    const code = await svc.codeFor('referrer-aaaa', '1.2.3.4');
    await svc.claim('friend-bbbb', code, '9.9.9.9', deps);

    await makePlayed(store, 'friend-bbbb', 60);
    expect(await svc.sweep('friend-bbbb', deps)).toBe('none');          // signup alone pays nobody

    await makePlayed(store, 'friend-bbbb', CONVERT_SECONDS_PLAYED);
    expect(await svc.sweep('friend-bbbb', deps)).toBe('paid');
    expect((await store.load('referrer-aaaa'))?.economy.scrap).toBe(REFERRER_SCRAP);
    expect((await store.load('friend-bbbb'))?.economy.scrap).toBe(REFERRED_SCRAP);

    // The idempotency that matters: sweep again, approve on top — no double.
    expect(await svc.sweep('friend-bbbb', deps)).toBe('none');
    await svc.approve('friend-bbbb', deps);
    expect((await store.load('referrer-aaaa'))?.economy.scrap).toBe(REFERRER_SCRAP);
    expect(await journal.has('referral', 'referral:friend-bbbb', 'referrer-aaaa')).toBe(true);
  });

  it('THE CRASH REPLAY: a lost state write cannot pay twice, because the journal is the memory', async () => {
    const { root, svc, store, deps } = await rig();
    const code = await svc.codeFor('referrer-aaaa', '1.2.3.4');
    await svc.claim('friend-bbbb', code, '9.9.9.9', deps);
    await makePlayed(store, 'friend-bbbb', CONVERT_SECONDS_PLAYED);
    // Snapshot the state doc BEFORE the payment, as a crash between the
    // journal append and the referrals.json persist would leave it.
    const stale = readFileSync(join(root, 'referrals.json'), 'utf8');
    expect(await svc.sweep('friend-bbbb', deps)).toBe('paid');
    writeFileSync(join(root, 'referrals.json'), stale, 'utf8');
    // The process restarts with the stale doc and replays the sweep.
    const replayed = new ReferralService(root, { clock: () => NOW });
    await replayed.sweep('friend-bbbb', deps);
    expect((await store.load('referrer-aaaa'))?.economy.scrap).toBe(REFERRER_SCRAP);
    expect((await store.load('friend-bbbb'))?.economy.scrap).toBe(REFERRED_SCRAP);
  });

  it('the day cap parks the Nth conversion in the review queue, and approve is the release valve', async () => {
    const { svc, store, deps } = await rig();
    const code = await svc.codeFor('referrer-aaaa', '1.2.3.4');
    for (let i = 0; i <= REFERRAL_CONVERSIONS_PER_DAY; i++) {
      const key = `friend-${String(i).padStart(4, '0')}`;
      await svc.claim(key, code, `8.8.${i}.1`, deps);
      await makePlayed(store, key, CONVERT_SECONDS_PLAYED);
    }
    let paid = 0; let queued = 0;
    for (let i = 0; i <= REFERRAL_CONVERSIONS_PER_DAY; i++) {
      const out = await svc.sweep(`friend-${String(i).padStart(4, '0')}`, deps);
      if (out === 'paid') paid++;
      if (out === 'queued') queued++;
    }
    expect(paid).toBe(REFERRAL_CONVERSIONS_PER_DAY);
    expect(queued).toBe(1);
    const queue = svc.reviewQueue();
    expect(queue.length).toBe(1);
    expect(await svc.approve(queue[0].referredKey, deps)).toBe(true);
    expect(svc.reviewQueue().length).toBe(0);
  });

  it('a claim from the code owner\'s own /24 converts into the QUEUE, never a silent payment', async () => {
    const { svc, store, deps } = await rig();
    const code = await svc.codeFor('referrer-aaaa', '10.1.2.3');
    await svc.claim('sock-puppet1', code, '10.1.2.99', deps);
    await makePlayed(store, 'sock-puppet1', CONVERT_SECONDS_PLAYED);
    expect(await svc.sweep('sock-puppet1', deps)).toBe('queued');
    expect(svc.reviewQueue()[0].attribution.review).toContain('own /24');
    expect((await store.load('referrer-aaaa'))?.economy.scrap).toBe(0);
  });
});
