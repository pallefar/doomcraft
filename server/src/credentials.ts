/**
 * DOOMCRAFT — `CredentialProvider`, and the house default
 * (docs/PLATFORM.md §2.4).
 *
 * The house provider is honest about what it is: `authenticates: false`
 * means "this proves possession of a secret, not the identity of a human".
 * Its accounts are never eligible for an operator role, a prize payout or a
 * trade; the account panel prints a different sentence for the flag's two
 * values. What the recovery code DOES solve is the actual player-facing
 * problem: Safari ITP evicting script-written localStorage after 7 idle
 * days — a returning player on day 8 has silently lost everything.
 *
 * One flow pair covers both directions through `/api/account/begin` +
 * `/api/account/complete`:
 *
 *  - **Claim.** `begin()` mints a fresh code and returns it EXACTLY ONCE in
 *    the challenge; only its sha-256 is held. `complete(state, proof)` with
 *    the echoed code proves the caller actually received it (a blind
 *    cross-site POST cannot), and only then does an account exist.
 *  - **Sign-in.** `complete(state, proof)` with a DIFFERENT valid code is a
 *    sign-in with that credential — the §3.2 decision table takes it from
 *    there. The provider only answers "which account does this secret
 *    prove"; it never decides what happens to the device.
 *
 * `node:crypto` is deliberately absent: `globalThis.crypto` exists in Node
 * >= 19 and in every browser, so this file stays importable as types from
 * client code, same rule as persistence.ts.
 */

import type { AccountId, AgeBand, DeviceId } from '@doomcraft/shared/identity';

export interface LinkChallenge {
  readonly kind: 'code' | 'redirect';
  /** kind==='code' only, returned exactly once, never persisted in clear. */
  readonly code?: string;
  /** kind==='redirect' only: the provider's authorize URL. */
  readonly url?: string;
  readonly state: string;         // opaque, single-use, server-held
  readonly expiresMs: number;
}

export interface CredentialProvider {
  readonly id: string;

  /**
   * THE HONESTY FLAG. `false` means "possession of a secret, not the
   * identity of a human". A `false` provider's accounts are never eligible
   * for an operator role, a prize payout, or a trade.
   */
  readonly authenticates: boolean;

  begin(deviceId: DeviceId, nowMs: number): Promise<LinkChallenge>;
  /**
   * `proof` is the typed code (house) or the OAuth authorization code
   * (redirect providers). Null on ANY failure — never a reason a probe can
   * learn from.
   */
  complete(state: string, proof: string, nowMs: number)
    : Promise<HouseCompletion | null>;
  revoke(accountId: AccountId): Promise<void>;
}

/**
 * What a completed house challenge proves. `fresh` distinguishes "the
 * challenge's own new code was echoed back" (a claim — no account exists
 * yet; the caller mints one against `secretHash`) from "an existing code
 * signed in" (`accountId` names it).
 */
export type HouseCompletion =
  | { kind: 'claim'; deviceId: DeviceId; secretHash: string; label: string; ageBand: AgeBand }
  | { kind: 'signin'; secretHash: string };

export const CHALLENGE_TTL_MS = 10 * 60_000;

/**
 * HOUSE-XXXX-XXXX-XXXX-XXXX-XXXX — 20 Crockford-base32 chars (~100 bits),
 * five groups. (§2.4 shows four groups over a 20-char secret, which cannot
 * both hold; the 20 characters win, because 80 bits is not a number to
 * round down to for a credential with no reset path.)
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function formatHouseCode(raw: string): string {
  return `HOUSE-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}`;
}

/**
 * Typed codes arrive however humans type them: lowercase, spaced, with or
 * without the HOUSE- prefix, with the Crockford confusables (O→0, I/L→1).
 */
export function normalizeHouseCode(typed: string): string {
  return typed.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^HOUSE/, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomCrockford(chars: number): string {
  const bytes = new Uint8Array(chars);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < chars; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

interface HeldChallenge {
  deviceId: DeviceId;
  codeHash: string;
  expiresMs: number;
}

export class HouseCredentialProvider implements CredentialProvider {
  readonly id = 'house';
  readonly authenticates = false;

  private readonly challenges = new Map<string, HeldChallenge>();
  /** Resolves an existing (normalized) secret's hash to its account, or null. */
  private readonly lookupSecret: (secretHash: string) => Promise<AccountId | null>;

  constructor(lookupSecret: (secretHash: string) => Promise<AccountId | null>) {
    this.lookupSecret = lookupSecret;
  }

  async begin(deviceId: DeviceId, nowMs: number): Promise<LinkChallenge> {
    this.sweep(nowMs);
    const raw = randomCrockford(20);
    const state = randomCrockford(26);
    this.challenges.set(state, {
      deviceId,
      codeHash: await sha256Hex(raw),
      expiresMs: nowMs + CHALLENGE_TTL_MS,
    });
    return { kind: 'code', code: formatHouseCode(raw), state, expiresMs: nowMs + CHALLENGE_TTL_MS };
  }

  async complete(state: string, proof: string, nowMs: number): Promise<HouseCompletion | null> {
    const held = this.challenges.get(state);
    if (held === undefined || nowMs > held.expiresMs) return null;
    this.challenges.delete(state);           // single-use, taken or not
    const normalized = normalizeHouseCode(proof);
    if (normalized.length !== 20) return null;
    const proofHash = await sha256Hex(normalized);
    if (proofHash === held.codeHash) {
      return {
        kind: 'claim', deviceId: held.deviceId, secretHash: held.codeHash,
        label: 'Recovery code', ageBand: 'unknown',
      };
    }
    // Not the fresh code — is it an existing credential signing in?
    const existing = await this.lookupSecret(proofHash);
    return existing === null ? null : { kind: 'signin', secretHash: proofHash };
  }

  async revoke(_accountId: AccountId): Promise<void> {
    // House credentials are revoked in the store (the hash is deleted with
    // the account); the provider holds nothing durable.
  }

  private sweep(nowMs: number): void {
    if (this.challenges.size < 1024) return;
    for (const [state, held] of this.challenges) {
      if (nowMs > held.expiresMs) this.challenges.delete(state);
    }
  }
}
