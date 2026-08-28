/**
 * DOOMCRAFT — the §3.2 decision table, the ticket discipline and the house
 * credential, proven row by row (docs/PLATFORM.md C4's test list).
 *
 * The row tests assert the resulting (session-account, D.home, D.claimed)
 * triple through the store's own probes: `accountForDevice` is D.home (null
 * = unclaimed), and `resolveProfileKey` is what a payout would bank to.
 */

import { describe, expect, it } from 'vitest';

import { asAccountId, asDeviceId } from '@doomcraft/shared/identity';

import {
  AccountGraph, MemoryGraphBackend, TICKET_TTL_MS, decideSignIn,
} from './accountGraph.js';
import { HouseCredentialProvider, formatHouseCode, normalizeHouseCode, sha256Hex } from './credentials.js';

const D = (s: string): ReturnType<typeof asDeviceId> => asDeviceId(s);

function graph(clockRef: { now: number } = { now: 1_000_000 }): AccountGraph {
  return new AccountGraph(new MemoryGraphBackend(), { clock: () => clockRef.now });
}

const CLAIM = { provider: 'house', secretHash: 'h1', credentialAccount: null } as const;

describe('the §3.2 decision table, all nine rows', () => {
  it('row 1: new credential, virgin device -> mint; the device is home and claimed', async () => {
    const g = graph();
    const out = await g.signIn({ ...CLAIM, deviceId: D('device-1a'), deviceHasProfile: false, deviceCountable: false });
    expect(out.kind).toBe('account');
    if (out.kind !== 'account') return;
    expect(out.decision.row).toBe(1);
    expect(out.account.primaryDeviceId).toBe('device-1a');
    expect((await g.accountForDevice(D('device-1a')))?.accountId).toBe(out.account.accountId);
  });

  it('row 2: unclaimed TRIVIAL profile -> claim silently, no question', async () => {
    const g = graph();
    const out = await g.signIn({ ...CLAIM, deviceId: D('device-2a'), deviceHasProfile: true, deviceCountable: false });
    if (out.kind !== 'account') throw new Error(out.kind);
    expect(out.decision.row).toBe(2);
    expect(out.account.primaryDeviceId).toBe('device-2a');
  });

  it('row 3, the family PC: an unclaimed COUNTABLE device returns ASK, never a silent claim', async () => {
    const g = graph();
    const out = await g.signIn({ ...CLAIM, deviceId: D('device-3a'), deviceHasProfile: true, deviceCountable: true });
    expect(out.kind).toBe('ask');
    // No writes happened: the brother's device still belongs to nobody.
    expect(await g.accountForDevice(D('device-3a'))).toBeNull();
  });

  it('row 3 answered: Keep binds the device; Start fresh mints P3 and leaves D.home unclaimed', async () => {
    const keep = graph();
    const kept = await keep.signIn({ ...CLAIM, deviceId: D('device-3b'), deviceHasProfile: true, deviceCountable: true, answer: 'keep' });
    if (kept.kind !== 'account') throw new Error(kept.kind);
    expect(kept.account.primaryDeviceId).toBe('device-3b');

    const fresh = graph();
    const minted = await fresh.signIn({ ...CLAIM, deviceId: D('device-3c'), deviceHasProfile: true, deviceCountable: true, answer: 'fresh' });
    if (minted.kind !== 'account') throw new Error(minted.kind);
    expect(minted.account.primaryDeviceId).not.toBe('device-3c');
    // The brother can still claim it: home unchanged, claimed still false.
    expect(await fresh.accountForDevice(D('device-3c'))).toBeNull();
  });

  it('row 4, the shared machine: a second credential on a CLAIMED device mints P3; D.home is frozen', async () => {
    const g = graph();
    const first = await g.signIn({ ...CLAIM, deviceId: D('device-4a'), deviceHasProfile: false, deviceCountable: false });
    if (first.kind !== 'account') throw new Error(first.kind);
    const second = await g.signIn({ provider: 'house', secretHash: 'h2', credentialAccount: null, deviceId: D('device-4a'), deviceHasProfile: true, deviceCountable: true });
    if (second.kind !== 'account') throw new Error(second.kind);
    expect(second.decision.row).toBe(4);
    expect(second.account.accountId).not.toBe(first.account.accountId);
    expect(second.account.primaryDeviceId).not.toBe('device-4a');
    // Sign-out falls back to the first player's home, byte-identical.
    expect((await g.accountForDevice(D('device-4a')))?.accountId).toBe(first.account.accountId);
    expect(await g.resolveProfileKey(D('device-4a'))).toBe(first.account.primaryDeviceId);
  });

  it('rows 5 and 6: a new device attaches and resolves to the ACCOUNT profile; re-sign-in is a no-op', async () => {
    const g = graph();
    const first = await g.signIn({ ...CLAIM, deviceId: D('device-5a'), deviceHasProfile: false, deviceCountable: false });
    if (first.kind !== 'account') throw new Error(first.kind);
    const id = first.account.accountId;
    const onB = await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: id, deviceId: D('device-5b'), deviceHasProfile: false, deviceCountable: false });
    if (onB.kind !== 'account') throw new Error(onB.kind);
    expect(onB.decision.row).toBe(5);
    expect(await g.resolveProfileKey(D('device-5b'))).toBe('device-5a');
    const again = await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: id, deviceId: D('device-5b'), deviceHasProfile: true, deviceCountable: true });
    if (again.kind !== 'account') throw new Error(again.kind);
    expect(again.decision.row).toBe(6);
  });

  it('rows 7 and 8: a trivial anonymous profile is absorbed silently; a countable one gets an OFFER, and decline attaches without it', async () => {
    const g = graph();
    const first = await g.signIn({ ...CLAIM, deviceId: D('device-7a'), deviceHasProfile: false, deviceCountable: false });
    if (first.kind !== 'account') throw new Error(first.kind);
    const id = first.account.accountId;

    const absorb = await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: id, deviceId: D('device-7b'), deviceHasProfile: true, deviceCountable: false });
    if (absorb.kind !== 'account') throw new Error(absorb.kind);
    expect(absorb.decision.row).toBe(7);

    const offered = await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: id, deviceId: D('device-8b'), deviceHasProfile: true, deviceCountable: true });
    expect(offered.kind).toBe('merge_offered');
    expect(await g.accountForDevice(D('device-8b'))).toBeNull();   // nothing written by an offer

    const declined = await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: id, deviceId: D('device-8b'), deviceHasProfile: true, deviceCountable: true, answer: 'decline' });
    if (declined.kind !== 'account') throw new Error(declined.kind);
    expect(await g.resolveProfileKey(D('device-8b'))).toBe('device-7a');
  });

  it('row 9: two CLAIMED players never auto-merge — session only, home untouched', async () => {
    const g = graph();
    const a = await g.signIn({ ...CLAIM, deviceId: D('device-9a'), deviceHasProfile: false, deviceCountable: false });
    const b = await g.signIn({ provider: 'house', secretHash: 'h2', credentialAccount: null, deviceId: D('device-9b'), deviceHasProfile: false, deviceCountable: false });
    if (a.kind !== 'account' || b.kind !== 'account') throw new Error('setup');
    const cross = await g.signIn({ provider: 'house', secretHash: 'h2', credentialAccount: b.account.accountId, deviceId: D('device-9a'), deviceHasProfile: true, deviceCountable: true });
    if (cross.kind !== 'account') throw new Error(cross.kind);
    expect(cross.decision.row).toBe(9);
    expect(cross.account.accountId).toBe(b.account.accountId);
    expect((await g.accountForDevice(D('device-9a')))?.accountId).toBe(a.account.accountId);
  });

  it('the device cap refuses the ninth device', async () => {
    const g = graph();
    const first = await g.signIn({ ...CLAIM, deviceId: D('device-c0'), deviceHasProfile: false, deviceCountable: false });
    if (first.kind !== 'account') throw new Error(first.kind);
    const id = first.account.accountId;
    for (let i = 1; i < 8; i++) {
      const out = await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: id, deviceId: D(`device-c${i}`), deviceHasProfile: false, deviceCountable: false });
      expect(out.kind).toBe('account');
    }
    const ninth = await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: id, deviceId: D('device-c8'), deviceHasProfile: false, deviceCountable: false });
    expect(ninth.kind).toBe('too_many_devices');
  });
});

describe('decideSignIn is total', () => {
  it('answers every combination with exactly one of the nine rows', () => {
    const rows = new Set<number>();
    for (const cred of [false, true]) {
      for (const kind of ['none', 'unclaimed', 'claimed'] as const) {
        for (const countable of [false, true]) {
          for (const homeIsCredential of [false, true]) {
            rows.add(decideSignIn(cred, { kind, countable, homeIsCredential }).row);
          }
        }
      }
    }
    expect([...rows].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('the socket ticket (§2.3)', () => {
  it('is single-use: the second redemption of the same string returns null', async () => {
    const g = graph();
    const ticket = await g.mintDeviceTicket(D('device-t1'));
    expect((await g.redeemTicket(ticket))?.profileKey).toBe('device-t1');
    expect(await g.redeemTicket(ticket)).toBeNull();
  });

  it('an expired ticket returns null', async () => {
    const clock = { now: 1_000_000 };
    const g = graph(clock);
    const ticket = await g.mintDeviceTicket(D('device-t2'));
    clock.now += TICKET_TTL_MS + 1;
    expect(await g.redeemTicket(ticket)).toBeNull();
  });

  it("a ticket carries the ACCOUNT's profile key — player X's ticket can never bank to player Y", async () => {
    const g = graph();
    const x = await g.signIn({ ...CLAIM, deviceId: D('device-tx'), deviceHasProfile: false, deviceCountable: false });
    const y = await g.signIn({ provider: 'house', secretHash: 'h2', credentialAccount: null, deviceId: D('device-ty'), deviceHasProfile: false, deviceCountable: false });
    if (x.kind !== 'account' || y.kind !== 'account') throw new Error('setup');
    // X signs in on a second device; the ticket minted THERE still resolves
    // to X's file — and never to Y's, whatever device string is involved.
    await g.signIn({ provider: 'house', secretHash: 'h1', credentialAccount: x.account.accountId, deviceId: D('device-tz'), deviceHasProfile: false, deviceCountable: false });
    const ticket = await g.mintDeviceTicket(D('device-tz'));
    const redeemed = await g.redeemTicket(ticket);
    expect(redeemed?.profileKey).toBe(x.account.primaryDeviceId);
    expect(redeemed?.profileKey).not.toBe(y.account.primaryDeviceId);
  });
});

describe('player sessions', () => {
  it('opens, resolves, refreshes with rotation, and revokes', async () => {
    const g = graph();
    const out = await g.signIn({ ...CLAIM, deviceId: D('device-s1'), deviceHasProfile: false, deviceCountable: false });
    if (out.kind !== 'account') throw new Error(out.kind);
    const opened = await g.openSession(out.account.accountId, D('device-s1'));
    expect((await g.resolveSession(opened.token))?.accountId).toBe(out.account.accountId);

    const rotated = await g.refreshSession(opened.refresh);
    expect(rotated).not.toBeNull();
    // The old pair is dead either way.
    expect(await g.resolveSession(opened.token)).toBeNull();
    expect(await g.refreshSession(opened.refresh)).toBeNull();

    await g.revokeAll(out.account.accountId);
    expect(await g.resolveSession(rotated!.token)).toBeNull();
  });
});

describe('the house credential (§2.4)', () => {
  it('claim roundtrip: the challenge code, echoed however a human types it, proves receipt', async () => {
    const provider = new HouseCredentialProvider(async () => null);
    const challenge = await provider.begin(D('device-h1'), 1000);
    expect(challenge.code).toMatch(/^HOUSE(-[0-9A-Z]{4}){5}$/);
    const typed = challenge.code!.toLowerCase().replace(/-/g, ' ');
    const done = await provider.complete(challenge.state, typed, 2000);
    expect(done?.kind).toBe('claim');
  });

  it('the state is single-use and expires; a wrong code answers null, never a reason', async () => {
    const provider = new HouseCredentialProvider(async () => null);
    const c1 = await provider.begin(D('device-h2'), 1000);
    expect(await provider.complete(c1.state, 'HOUSE-0000-0000-0000-0000-0000', 2000)).toBeNull();
    // Consumed by the failed attempt: even the right code is now refused.
    expect(await provider.complete(c1.state, c1.code!, 2000)).toBeNull();
    const c2 = await provider.begin(D('device-h2'), 1000);
    expect(await provider.complete(c2.state, c2.code!, c2.expiresMs + 1)).toBeNull();
  });

  it('an EXISTING code signs in as that account; confusables normalise (O->0, l->1)', async () => {
    const secret = 'ABCD1234ABCD1234ABCD';
    const hash = await sha256Hex(secret);
    const provider = new HouseCredentialProvider(async (h) => (h === hash ? asAccountId('house:known') : null));
    const challenge = await provider.begin(D('device-h3'), 1000);
    const mistyped = formatHouseCode(secret).replace(/0/g, 'O').replace(/1/g, 'l');
    const done = await provider.complete(challenge.state, mistyped, 2000);
    expect(done).toEqual({ kind: 'signin', secretHash: hash });
    expect(normalizeHouseCode('house 0O0O')).toBe('0000');
  });
});
