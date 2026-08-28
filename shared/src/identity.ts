/**
 * DOOMCRAFT — the identity vocabulary, in one place (docs/PLATFORM.md §2.2).
 *
 * Branded on purpose — and the brand is NOT the firewall.
 *
 * A brand stops `string -> DeviceId`; it does not stop `DeviceId -> string`,
 * so any `props: Record<string, string>` would happily swallow one. The
 * structural defence against docs/INFRASTRUCTURE.md ("one analytics SDK
 * initialised with the wrong user id and you have shared a persistent
 * identifier for a child with an ad network") is the closed event union of
 * PLATFORM §7.1. The brand's job is to make the CI scan mechanical instead
 * of a matter of taste.
 */

export type DeviceId = string & { readonly __dc_device: unique symbol };

/** ALWAYS `<namespace>:<opaque>`. Minted server-side. NEVER read from a body. */
export type AccountId = string & { readonly __dc_account: unique symbol };

/**
 * The key a profile file is stored under and a payout is banked to. Today it
 * is a device id string; after PLATFORM §2.3 it is the account's
 * `primaryDeviceId`. Distinct type so no code can key a write on "the device
 * that connected".
 */
export type ProfileKey = string & { readonly __dc_profile: unique symbol };

export const ACCOUNT_NAMESPACES = Object.freeze(['house', 'workos', 'steam'] as const);
export type AccountNamespace = typeof ACCOUNT_NAMESPACES[number];

/**
 * Four states, and `unknown` is one of them.
 * docs/INFRASTRUCTURE.md: never widen this to a boolean. A boolean makes "we
 * have not asked" indistinguishable from "adult", which is the exact failure
 * that section is written about.
 */
export type AgeBand = 'unknown' | 'u13' | '13_17' | '18plus';

export type ModerationState = 'clear' | 'muted' | 'shadowbanned' | 'banned';

export function asDeviceId(raw: string): DeviceId { return raw as DeviceId; }
export function asProfileKey(raw: string): ProfileKey { return raw as ProfileKey; }
export function asAccountId(raw: string): AccountId { return raw as AccountId; }
