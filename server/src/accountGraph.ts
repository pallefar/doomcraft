/**
 * DOOMCRAFT — the account graph, sessions and socket tickets
 * (docs/PLATFORM.md §2.3, phase C4).
 *
 * Naming note, stated up front: PLATFORM §2.3 sketches this as
 * `server/src/accounts.ts`, but that name was taken by the ADMIN passphrase
 * accounts (`AccountStore`, 2026-08-22 — the console's owner rule) before
 * this phase landed. This file is the PLAYER identity graph; the two do not
 * share a record, a session table or a threat model, and merging them would
 * put "first signup becomes host owner" one refactor away from a player
 * route.
 *
 * The one rule that kills split-brain (§2.3): an account's
 * `primaryDeviceId` is THE storage key — set once at claim, never
 * reassigned by attach or merge. Every profile read and write goes through
 * `resolveProfileKey`; nothing may key a profile operation on "the device
 * that happens to be connected". The C4 threading makes that mechanical:
 * the WebSocket admit path sets `conn.deviceId` to the ticket's already-
 * resolved profile key, so every downstream payout, journal row,
 * entitlement participant and flag bucket keys per PERSON without touching
 * room.ts at all.
 *
 * Sessions and tickets are in-memory, like the admin console's
 * `SessionTable` and for the same stated reason: one box, one process, no
 * database (§10). Accounts themselves are durable — sharded JSON files plus
 * two index files, mirroring `JsonFileStore`'s shape.
 *
 * EVERY identity mutation runs inside `withGraphLock` — one process-wide
 * mutex, not a per-key lock. An attach touches a device index AND an
 * account record; two lock domains with no ordering deadlock the moment two
 * operations pick different pairs. Identity mutations are roughly one per
 * player per lifetime; a single mutex costs nothing and removes the entire
 * question (§2.3).
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AccountId, AgeBand, DeviceId, ModerationState, ProfileKey,
} from '@doomcraft/shared/identity';

import { randomCrockford, sha256Hex } from './credentials.js';

export const ACCOUNT_GRAPH_VERSION = 1;
export const MAX_LINKED_DEVICES = 8;

export const PLAYER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** §2.3: a SINGLE-USE, 120-second ticket for the WebSocket upgrade. */
export const TICKET_TTL_MS = 120_000;

export interface AccountRecord {
  version: number;
  accountId: AccountId;
  /** CredentialProvider.id that minted it. Decides the namespace. */
  provider: string;
  /** sha-256 hex of the recovery secret. Null for redirect providers. */
  secretHash: string | null;
  /**
   * THE STORAGE KEY. Set once at claim; never reassigned by attach or
   * merge — a merge moves state INTO it, it does not move the key.
   */
  primaryDeviceId: ProfileKey;
  /** Every device that has proven this credential. Append-only, capped. */
  devices: DeviceId[];
  ageBand: AgeBand;
  moderation: ModerationState;
  moderationReason: string;
  moderationUntilMs: number;
  mergesLifetime: number;
  mergesWindowStartMs: number;
  mergesInWindow: number;
  createdMs: number;
  lastSeenMs: number;
  _unknown?: Record<string, unknown>;
}

/** A 30-day API session. The clear token is returned once and forgotten. */
export interface PlayerSession {
  readonly tokenHash: string;
  readonly refreshHash: string;
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
  readonly issuedMs: number;
  readonly expiresMs: number;
}

export interface SocketTicket {
  readonly ticketHash: string;
  readonly profileKey: ProfileKey;
  readonly accountId: AccountId | null;
  readonly ageBand: AgeBand;
  readonly moderation: ModerationState;
  readonly expiresMs: number;
}

/* ------------------------------------------------------------------------ *
 * §3.2 — the decision table. Nine rows, no other outcomes, and PURE.
 * ------------------------------------------------------------------------ */

/** What the device brings to a sign-in. */
export interface DeviceStanding {
  /** 'claimed' = a home account exists; 'unclaimed' = an anonymous profile
   *  exists; 'none' = the device has never had a profile written. */
  kind: 'none' | 'unclaimed' | 'claimed';
  /** §3.1 countable() of the device's profile. Meaningless for 'none'. */
  countable: boolean;
  /** For kind 'claimed': is the home account the credential's account. */
  homeIsCredential: boolean;
}

export type SignInDecision =
  | { row: 1; kind: 'mint' }
  | { row: 2; kind: 'claim_silently' }
  | { row: 3; kind: 'ask' }               // §3.2.1: Keep it / Start fresh
  | { row: 4; kind: 'shared_machine' }    // mint P3; D.home UNCHANGED
  | { row: 5; kind: 'new_device' }
  | { row: 6; kind: 'idempotent' }
  | { row: 7; kind: 'absorb' }            // trivial: nothing to lose
  | { row: 8; kind: 'offer_merge' }       // decline -> row 5
  | { row: 9; kind: 'signin_only' };      // NEVER auto-merge two claimed

/** What `AccountGraph.signIn` answers a route with. */
export type SignInOutcome =
  | { kind: 'account'; decision: SignInDecision; account: AccountRecord }
  | { kind: 'ask'; decision: SignInDecision }
  | { kind: 'merge_offered'; decision: SignInDecision; account: AccountRecord }
  | { kind: 'too_many_devices'; decision: SignInDecision };

export function decideSignIn(credentialHasAccount: boolean, device: DeviceStanding): SignInDecision {
  if (!credentialHasAccount) {
    if (device.kind === 'none') return { row: 1, kind: 'mint' };
    if (device.kind === 'claimed') return { row: 4, kind: 'shared_machine' };
    // Row 3 is the row that ruins games: an unclaimed device with countable
    // state gets a QUESTION, never a silent claim — claiming wrongly loses
    // 40 hours; not claiming costs a fresh start that is reversible.
    return device.countable ? { row: 3, kind: 'ask' } : { row: 2, kind: 'claim_silently' };
  }
  if (device.kind === 'none') return { row: 5, kind: 'new_device' };
  if (device.kind === 'claimed') {
    return device.homeIsCredential
      ? { row: 6, kind: 'idempotent' }
      : { row: 9, kind: 'signin_only' };
  }
  return device.countable ? { row: 8, kind: 'offer_merge' } : { row: 7, kind: 'absorb' };
}

/** §3.1 countable(P) — the only predicate that asks a human a question. */
export function countableProfile(p: {
  progress: { xp: number; gamesPlayed: number };
  economy?: { lifetimeScrap: number };
  stats?: { matches: number };
  entitlements: { adsRemoved: boolean };
} | null): boolean {
  if (p === null) return false;
  return p.progress.xp > 0 || p.progress.gamesPlayed > 0
    || (p.economy?.lifetimeScrap ?? 0) > 0
    || (p.stats?.matches ?? 0) > 0
    || p.entitlements.adsRemoved;
}

/* ------------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------------ */

export interface GraphBackend {
  loadAll(): Promise<AccountRecord[]>;
  saveAccount(record: AccountRecord): Promise<void>;
}

/** Tests, and any host that wants amnesia. */
export class MemoryGraphBackend implements GraphBackend {
  async loadAll(): Promise<AccountRecord[]> { return []; }
  async saveAccount(_record: AccountRecord): Promise<void> { /* nothing */ }
}

/** `<dataRoot>/accounts/<2-hex-shard>/<id>.json`, mirroring JsonFileStore. */
export class JsonGraphBackend implements GraphBackend {
  private readonly root: string;
  constructor(dataRoot: string) {
    this.root = join(dataRoot.replace(/\/+$/, ''), 'accounts');
  }

  async loadAll(): Promise<AccountRecord[]> {
    const out: AccountRecord[] = [];
    let shards: string[];
    try { shards = await readdir(this.root); } catch { return out; }
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      let files: string[];
      try { files = await readdir(join(this.root, shard)); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(await readFile(join(this.root, shard, file), 'utf8')) as AccountRecord;
          if (typeof raw.accountId === 'string' && typeof raw.primaryDeviceId === 'string') out.push(raw);
        } catch { /* one unreadable record must not take identity down */ }
      }
    }
    return out;
  }

  async saveAccount(record: AccountRecord): Promise<void> {
    const opaque = record.accountId.replace(/^[a-z]+:/, '');
    const shard = opaque.slice(0, 2).padEnd(2, '0').toLowerCase().replace(/[^0-9a-f]/g, '0');
    const dir = join(this.root, shard);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${record.accountId.replace(/[^A-Za-z0-9_:-]/g, '')}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, file);
  }
}

export interface AccountGraphOptions {
  clock?: () => number;
}

export class AccountGraph {
  private readonly backend: GraphBackend;
  private readonly clock: () => number;

  private readonly accounts = new Map<AccountId, AccountRecord>();
  /** deviceId -> home account. Written ONLY when a claim freezes the home. */
  private readonly homeByDevice = new Map<string, AccountId>();
  /** secretHash -> account, for house sign-ins. */
  private readonly bySecret = new Map<string, AccountId>();

  private readonly sessions = new Map<string, PlayerSession>();
  private readonly byRefresh = new Map<string, string>();     // refreshHash -> tokenHash
  private readonly tickets = new Map<string, SocketTicket>();

  private chain: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void>;

  constructor(backend: GraphBackend, options: AccountGraphOptions = {}) {
    this.backend = backend;
    this.clock = options.clock ?? (() => Date.now());
    this.loaded = this.loadAll();
  }

  private async loadAll(): Promise<void> {
    for (const record of await this.backend.loadAll()) this.index(record);
  }

  private index(record: AccountRecord): void {
    this.accounts.set(record.accountId, record);
    if (record.secretHash !== null) this.bySecret.set(record.secretHash, record.accountId);
    for (const device of record.devices) {
      // The home index is rebuilt from the records' own device lists; a
      // device attached to two records would be a corrupted graph, and the
      // first loaded wins deterministically (sorted shard walk).
      if (!this.homeByDevice.has(device)) this.homeByDevice.set(device, record.accountId);
    }
  }

  /** §2.3: one global mutex for every identity mutation. */
  withGraphLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => this.loaded).then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async ready(): Promise<void> { return this.loaded; }

  /* --- reads ------------------------------------------------------------ */

  async get(id: AccountId): Promise<AccountRecord | null> {
    await this.loaded;
    return this.accounts.get(id) ?? null;
  }

  async accountForDevice(deviceId: DeviceId): Promise<AccountRecord | null> {
    await this.loaded;
    const id = this.homeByDevice.get(deviceId);
    return id === undefined ? null : this.accounts.get(id) ?? null;
  }

  async accountForSecretHash(secretHash: string): Promise<AccountId | null> {
    await this.loaded;
    return this.bySecret.get(secretHash) ?? null;
  }

  /**
   * THE ONE RESOLVER. deviceId -> the profile file to read and write.
   * Returns the device's own id when it belongs to no account.
   */
  async resolveProfileKey(deviceId: DeviceId): Promise<ProfileKey> {
    const home = await this.accountForDevice(deviceId);
    return home === null ? (deviceId as string as ProfileKey) : home.primaryDeviceId;
  }

  /* --- mutations (all inside the graph lock) ---------------------------- */

  /**
   * Rows 1/2: mint an account whose home IS this device. Row 2 is the claim
   * of an existing unclaimed profile — same write, the profile file simply
   * already has state.
   */
  private async mintForDeviceUnlocked(provider: string, secretHash: string | null, deviceId: DeviceId): Promise<AccountRecord> {
    const record = this.blankRecord(provider, secretHash, deviceId as string as ProfileKey);
    record.devices = [deviceId];
    this.index(record);
    this.homeByDevice.set(deviceId, record.accountId);
    await this.backend.saveAccount(record);
    return record;
  }

  /**
   * Rows 3-"Start fresh" and 4: mint an account with a FRESH synthetic
   * profile key. The device's home is deliberately NOT touched — the
   * brother can still claim it (§3.2).
   */
  private async mintDetachedUnlocked(provider: string, secretHash: string | null): Promise<AccountRecord> {
    const syntheticKey = `p-${randomCrockford(24).toLowerCase()}` as ProfileKey;
    const record = this.blankRecord(provider, secretHash, syntheticKey);
    this.index(record);
    await this.backend.saveAccount(record);
    return record;
  }

  /** Rows 5/7: this device now belongs to the credential's account. */
  private async attachDeviceUnlocked(id: AccountId, deviceId: DeviceId): Promise<'ok' | 'already' | 'too_many_devices'> {
    const record = this.accounts.get(id);
    if (record === undefined) throw new Error(`no such account ${id}`);
    if (record.devices.includes(deviceId)) return 'already';
    if (record.devices.length >= MAX_LINKED_DEVICES) return 'too_many_devices';
    record.devices.push(deviceId);
    record.lastSeenMs = this.clock();
    this.homeByDevice.set(deviceId, id);
    await this.backend.saveAccount(record);
    return 'ok';
  }

  /* --- §3.2, executed --------------------------------------------------- */

  /**
   * The whole decision-and-write, atomically under the graph lock. The
   * caller supplies what only it can know — which account the credential
   * proved (null for a fresh claim) and whether the raw device's profile
   * file exists and is countable — and this method is the ONLY writer for
   * a sign-in, so no route can improvise row semantics.
   */
  signIn(args: {
    provider: string;
    secretHash: string | null;
    /** The credential's account, or null when the credential is new. */
    credentialAccount: AccountId | null;
    deviceId: DeviceId;
    deviceHasProfile: boolean;
    deviceCountable: boolean;
    /** Row 3's second round trip; row 8's decline. */
    answer?: 'keep' | 'fresh' | 'decline';
  }): Promise<SignInOutcome> {
    return this.withGraphLock(async () => {
      const home = this.homeByDevice.get(args.deviceId);
      const homeRecord = home === undefined ? null : this.accounts.get(home) ?? null;
      const standing: DeviceStanding = {
        kind: homeRecord !== null ? 'claimed' : args.deviceHasProfile ? 'unclaimed' : 'none',
        countable: args.deviceCountable,
        homeIsCredential: homeRecord !== null && homeRecord.accountId === args.credentialAccount,
      };
      const decision = decideSignIn(args.credentialAccount !== null, standing);
      const credential = args.credentialAccount === null
        ? null : this.accounts.get(args.credentialAccount) ?? null;

      switch (decision.kind) {
        case 'mint':
        case 'claim_silently': {
          const account = await this.mintForDeviceUnlocked(args.provider, args.secretHash, args.deviceId);
          return { kind: 'account', decision, account };
        }
        case 'ask': {
          if (args.answer === 'keep') {
            const account = await this.mintForDeviceUnlocked(args.provider, args.secretHash, args.deviceId);
            return { kind: 'account', decision, account };
          }
          if (args.answer === 'fresh') {
            const account = await this.mintDetachedUnlocked(args.provider, args.secretHash);
            return { kind: 'account', decision, account };
          }
          return { kind: 'ask', decision };
        }
        case 'shared_machine': {
          // Row 4: D.home UNCHANGED, forever. Only the session is P3's.
          const account = await this.mintDetachedUnlocked(args.provider, args.secretHash);
          return { kind: 'account', decision, account };
        }
        case 'new_device':
        case 'absorb': {
          if (credential === null) throw new Error('row 5/7 with no credential account');
          const attached = await this.attachDeviceUnlocked(credential.accountId, args.deviceId);
          if (attached === 'too_many_devices') return { kind: 'too_many_devices', decision };
          return { kind: 'account', decision, account: credential };
        }
        case 'idempotent':
        case 'signin_only': {
          // Row 6 is a no-op; row 9 NEVER auto-merges two claimed players —
          // the session rides the credential, the device's home is untouched.
          if (credential === null) throw new Error('row 6/9 with no credential account');
          return { kind: 'account', decision, account: credential };
        }
        case 'offer_merge': {
          if (credential === null) throw new Error('row 8 with no credential account');
          if (args.answer === 'decline') {
            // Decline -> row 5 treatment (§3.2): the device joins the
            // account; the anonymous profile file stays on disk, unmerged.
            const attached = await this.attachDeviceUnlocked(credential.accountId, args.deviceId);
            if (attached === 'too_many_devices') return { kind: 'too_many_devices', decision };
            return { kind: 'account', decision, account: credential };
          }
          // The merge EXECUTION is phase C5; C4 only ever offers.
          return { kind: 'merge_offered', decision, account: credential };
        }
      }
    });
  }

  moderate(id: AccountId, state: ModerationState, reason: string, untilMs: number): Promise<void> {
    return this.withGraphLock(async () => {
      const record = this.accounts.get(id);
      if (record === undefined) return;
      record.moderation = state;
      record.moderationReason = reason;
      record.moderationUntilMs = untilMs;
      await this.backend.saveAccount(record);
    });
  }

  private blankRecord(provider: string, secretHash: string | null, primary: ProfileKey): AccountRecord {
    const now = this.clock();
    return {
      version: ACCOUNT_GRAPH_VERSION,
      accountId: `${provider}:${randomCrockford(24).toLowerCase()}` as AccountId,
      provider, secretHash,
      primaryDeviceId: primary,
      devices: [],
      ageBand: 'unknown', moderation: 'clear', moderationReason: '', moderationUntilMs: 0,
      mergesLifetime: 0, mergesWindowStartMs: 0, mergesInWindow: 0,
      createdMs: now, lastSeenMs: now,
    };
  }

  /* --- sessions ---------------------------------------------------------- */

  async openSession(id: AccountId, deviceId: DeviceId): Promise<{ token: string; refresh: string; expiresMs: number }> {
    const now = this.clock();
    const token = randomCrockford(40);
    const refresh = randomCrockford(40);
    const session: PlayerSession = {
      tokenHash: await sha256Hex(token),
      refreshHash: await sha256Hex(refresh),
      accountId: id, deviceId,
      issuedMs: now, expiresMs: now + PLAYER_SESSION_TTL_MS,
    };
    this.sessions.set(session.tokenHash, session);
    this.byRefresh.set(session.refreshHash, session.tokenHash);
    return { token, refresh, expiresMs: session.expiresMs };
  }

  async resolveSession(token: string): Promise<PlayerSession | null> {
    const hash = await sha256Hex(token);
    const session = this.sessions.get(hash);
    if (session === undefined) return null;
    if (this.clock() > session.expiresMs) {
      this.sessions.delete(hash);
      this.byRefresh.delete(session.refreshHash);
      return null;
    }
    return session;
  }

  /** dc_rt: the refresh rotates BOTH tokens; the old pair dies either way. */
  async refreshSession(refresh: string): Promise<{ token: string; refresh: string; expiresMs: number } | null> {
    const refreshHash = await sha256Hex(refresh);
    const tokenHash = this.byRefresh.get(refreshHash);
    if (tokenHash === undefined) return null;
    const session = this.sessions.get(tokenHash);
    this.byRefresh.delete(refreshHash);
    this.sessions.delete(tokenHash);
    if (session === undefined || this.clock() > session.issuedMs + REFRESH_TTL_MS) return null;
    return this.openSession(session.accountId, session.deviceId);
  }

  async revokeAll(id: AccountId): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.accountId === id) {
        this.sessions.delete(hash);
        this.byRefresh.delete(session.refreshHash);
      }
    }
  }

  /* --- socket tickets ----------------------------------------------------- */

  /** For a signed-in session: the profile key is the ACCOUNT's, always. */
  async mintSessionTicket(session: PlayerSession): Promise<string> {
    const account = await this.get(session.accountId);
    if (account === null) throw new Error('session names a missing account');
    return this.mintTicket(account.primaryDeviceId, account.accountId, account.ageBand, account.moderation);
  }

  /**
   * For the anonymous ~90%: the ticket carries the device's RESOLVED profile
   * key, so a claimed device's socket banks to the account file even when
   * nobody typed a code this session.
   */
  async mintDeviceTicket(deviceId: DeviceId): Promise<string> {
    const home = await this.accountForDevice(deviceId);
    return this.mintTicket(
      home === null ? (deviceId as string as ProfileKey) : home.primaryDeviceId,
      home?.accountId ?? null,
      home?.ageBand ?? 'unknown',
      home?.moderation ?? 'clear',
    );
  }

  private async mintTicket(
    profileKey: ProfileKey, accountId: AccountId | null,
    ageBand: AgeBand, moderation: ModerationState,
  ): Promise<string> {
    this.sweepTickets();
    const ticket = randomCrockford(32);
    const record: SocketTicket = {
      ticketHash: await sha256Hex(ticket),
      profileKey, accountId, ageBand, moderation,
      expiresMs: this.clock() + TICKET_TTL_MS,
    };
    this.tickets.set(record.ticketHash, record);
    return ticket;
  }

  /** Single-use: the second redemption of the same ticket returns null. */
  async redeemTicket(ticket: string): Promise<SocketTicket | null> {
    const hash = await sha256Hex(ticket);
    const record = this.tickets.get(hash);
    if (record === undefined) return null;
    this.tickets.delete(hash);
    return this.clock() > record.expiresMs ? null : record;
  }

  private sweepTickets(): void {
    if (this.tickets.size < 4096) return;
    const now = this.clock();
    for (const [hash, t] of this.tickets) {
      if (now > t.expiresMs) this.tickets.delete(hash);
    }
  }
}
