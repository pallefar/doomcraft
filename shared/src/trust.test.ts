/**
 * DOOMCRAFT — the trust table is the only thing that decides what counts.
 *
 * Two claims, and the second is the one that matters in a year's time:
 *
 *   1. **The table is sound.** Every invariant in `checkTrustTable` holds for
 *      the real rows, and each invariant actually bites when a row breaks it —
 *      a check nobody has seen fail is a check nobody knows works.
 *   2. **Nothing else decides.** The enforcement (`entitlementGuard.ts`) and the
 *      display (`matchType.ts`) contain no mode literal at all, and no file in
 *      the tree hardcodes a mode's ranked-ness or reward set. The scan at the
 *      bottom of this file is what stops the policy leaking back out of the
 *      table one convenient `if` at a time.
 *
 * The scan is deliberately mechanical rather than clever: it greps source text.
 * A cleverer check that needs a parser is a check that gets deleted the first
 * time it is wrong.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MODES, ModeId } from './modes.ts';
import {
  DENY_ALL,
  MATCH_TYPE_COUNT,
  MatchType,
  PEER_MAX_PLAYERS,
  PEER_ROLLOUT,
  REWARD_ALL,
  REWARD_CASUAL,
  REWARD_ITEM_DROP,
  REWARD_NONE,
  REWARD_RANKED_RATING,
  REWARD_SCRAP,
  REWARD_STATS,
  REWARD_SPONSOR_PRIZE,
  REWARD_XP,
  SessionOrigin,
  TRUST_TABLE,
  Topology,
  WRITE_LOCAL_RECORD,
  WRITE_NONE,
  WRITE_PERSISTENT_WORLD,
  checkTrustTable,
  grantsAnything,
  isOffered,
  isParticipationControlled,
  matchTypesFor,
  peerHostableRows,
  resolveMatchType,
  sealSessionTrust,
  sessionMayGrant,
  sessionMayWrite,
  topologyForOrigin,
  trustPolicyFor,
  validateTrustTable,
  type TrustPolicy,
} from './trust.ts';

/* ------------------------------------------------------------------------ *
 * Repo layout
 * ------------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SOURCE_ROOTS = ['shared/src', 'client/src', 'server/src'];

/** The one file allowed to contain the policy. */
const TRUST_FILE = path.join('shared', 'src', 'trust.ts');
/** The two files that must enforce and display it without knowing any of it. */
const ENFORCEMENT_FILES = [
  path.join('server', 'src', 'entitlementGuard.ts'),
  path.join('client', 'src', 'ui', 'matchType.ts'),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function sourceFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const root of SOURCE_ROOTS) {
    for (const full of walk(path.join(REPO, root))) {
      const rel = path.relative(REPO, full);
      out.push({ rel, text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** A row with one field changed, for proving an invariant bites. */
function mutate(base: TrustPolicy, patch: Partial<TrustPolicy>): TrustPolicy {
  return Object.freeze({ ...base, ...patch });
}

function rowFor(modeId: ModeId, matchType: MatchType): TrustPolicy {
  const p = trustPolicyFor(modeId, matchType);
  expect(p).not.toBe(DENY_ALL);
  return p;
}

/* ------------------------------------------------------------------------ *
 * 1. The table is sound
 * ------------------------------------------------------------------------ */

describe('the shipped trust table', () => {
  it('passes every invariant', () => {
    expect(checkTrustTable(TRUST_TABLE)).toEqual([]);
    expect(() => { validateTrustTable(TRUST_TABLE); }).not.toThrow();
  });

  it('covers every mode, and every row is unique', () => {
    const seen = new Set<number>();
    for (const p of TRUST_TABLE) {
      const key = p.modeId * MATCH_TYPE_COUNT + p.matchType;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (const def of MODES) {
      expect(matchTypesFor(def.id).length).toBeGreaterThan(0);
    }
  });

  it('never grants anything from an untrusted topology — the whole point', () => {
    for (const p of TRUST_TABLE) {
      if (p.topology === Topology.SERVER_AUTHORITATIVE) continue;
      expect(p.grants).toBe(REWARD_NONE);
    }
  });

  it('never grants anything from a match the player picked the players for', () => {
    for (const p of TRUST_TABLE) {
      if (isParticipationControlled(p.matchType)) continue;
      expect(p.grants).toBe(REWARD_NONE);
    }
  });

  it('keeps rating, standings and prizes in the match types that carry them', () => {
    for (const p of TRUST_TABLE) {
      if ((p.grants & REWARD_RANKED_RATING) !== 0) {
        expect([MatchType.RANKED, MatchType.COMPETITION]).toContain(p.matchType);
      }
      if ((p.grants & REWARD_SPONSOR_PRIZE) !== 0) {
        expect(p.matchType).toBe(MatchType.COMPETITION);
      }
    }
  });

  it('peer-hosts only co-op modes, at the measured four-player ceiling', () => {
    const peers = peerHostableRows();
    expect(peers.length).toBeGreaterThan(0);
    for (const p of peers) {
      expect(p.maxPlayers).toBeLessThanOrEqual(PEER_MAX_PLAYERS);
      expect(p.grants).toBe(REWARD_NONE);
      // A peer host of a free-for-all mode plays at 0 ms against everybody else.
      expect(MODES[p.modeId].pvp).not.toBe(1 /* PvpPolicy.FREE_FOR_ALL */);
    }
  });

  it('keeps a persistent world on a host that will still be there tomorrow', () => {
    for (const p of TRUST_TABLE) {
      if ((p.writes & WRITE_PERSISTENT_WORLD) === 0) continue;
      expect(p.topology).toBe(Topology.SERVER_AUTHORITATIVE);
    }
  });

  it('gives every row a sentence the player can read before they commit', () => {
    for (const p of TRUST_TABLE) {
      expect(p.playerNote.length).toBeGreaterThan(20);
      expect(p.why.length).toBeGreaterThan(20);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Each invariant actually bites
 * ------------------------------------------------------------------------ */

describe('a bad edit to the table is refused', () => {
  const questPeer = rowFor(ModeId.QUEST, MatchType.PRIVATE);
  const dmRanked = rowFor(ModeId.DEATHMATCH, MatchType.RANKED);
  const dmPublic = rowFor(ModeId.DEATHMATCH, MatchType.PUBLIC);
  const builderPublic = rowFor(ModeId.BUILDER, MatchType.PUBLIC);

  it('refuses a peer-hosted row that pays XP', () => {
    const bad = mutate(questPeer, { grants: REWARD_XP });
    const problems = checkTrustTable([bad]);
    expect(problems.join('\n')).toMatch(/peer/i);
    expect(() => { validateTrustTable([bad]); }).toThrow(/unsound/);
  });

  it('refuses a local row that pays item drops', () => {
    const local = rowFor(ModeId.HORDE, MatchType.SOLO);
    const bad = mutate(local, { grants: REWARD_ITEM_DROP });
    expect(checkTrustTable([bad]).join('\n')).toMatch(/local|fabricate/i);
  });

  it('refuses a private row that pays, even hosted on our own servers', () => {
    const dmPrivate = rowFor(ModeId.DEATHMATCH, MatchType.PRIVATE);
    expect(dmPrivate.topology).toBe(Topology.SERVER_AUTHORITATIVE);
    const bad = mutate(dmPrivate, { grants: REWARD_CASUAL });
    expect(checkTrustTable([bad]).join('\n')).toMatch(/farm/i);
  });

  it('refuses a paying row that does not also grant REWARD_STATS', () => {
    // toMatchResult returns null without the stats block, AFTER the guard has
    // marked the device settled — such a row accepts, settles and pays
    // nothing, silently and unreplayably. Convention held this; now the
    // table does.
    const bad = mutate(dmPublic, { grants: (dmPublic.grants | REWARD_SCRAP) & ~REWARD_STATS });
    expect(checkTrustTable([bad]).join('\n')).toMatch(/REWARD_STATS/);
    expect(() => { validateTrustTable([bad]); }).toThrow(/unsound/);
  });

  it('refuses ranked rating in a casual queue', () => {
    const bad = mutate(dmPublic, { grants: dmPublic.grants | REWARD_RANKED_RATING });
    expect(checkTrustTable([bad]).join('\n')).toMatch(/ranked rating/i);
  });

  it('refuses a sponsor prize outside a scheduled event', () => {
    const bad = mutate(dmRanked, { grants: dmRanked.grants | REWARD_SPONSOR_PRIZE });
    expect(checkTrustTable([bad]).join('\n')).toMatch(/prize|standing/i);
  });

  it('refuses a persistent world owned by a peer', () => {
    const bad = mutate(builderPublic, { topology: Topology.PEER_HOSTED, grants: REWARD_NONE, maxPlayers: 4 });
    expect(checkTrustTable([bad]).join('\n')).toMatch(/persistent world/i);
  });

  it('refuses a peer room bigger than the measured ceiling', () => {
    const bad = mutate(questPeer, { maxPlayers: PEER_MAX_PLAYERS + 1 });
    expect(checkTrustTable([bad]).join('\n')).toMatch(/peer host/i);
  });

  it('refuses two rows for the same pair', () => {
    expect(checkTrustTable([questPeer, questPeer]).join('\n')).toMatch(/duplicate/i);
  });

  it('refuses a table with a mode missing', () => {
    expect(checkTrustTable([dmRanked]).join('\n')).toMatch(/no rows at all/i);
  });

  it('refuses a row with nothing to tell the player', () => {
    expect(checkTrustTable([mutate(dmRanked, { playerNote: '' })]).join('\n'))
      .toMatch(/playerNote/);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Lookup fails closed
 * ------------------------------------------------------------------------ */

describe('lookup', () => {
  it('returns DENY_ALL for a pair nobody wrote down', () => {
    // Quest has no ranked ladder, so this pair does not exist.
    expect(isOffered(ModeId.QUEST, MatchType.RANKED)).toBe(false);
    const p = trustPolicyFor(ModeId.QUEST, MatchType.RANKED);
    expect(p).toBe(DENY_ALL);
    expect(p.grants).toBe(REWARD_NONE);
    expect(p.topology).toBe(Topology.SERVER_AUTHORITATIVE);
  });

  it('returns DENY_ALL for nonsense rather than throwing', () => {
    expect(trustPolicyFor(-1, 0)).toBe(DENY_ALL);
    expect(trustPolicyFor(0, 99)).toBe(DENY_ALL);
    expect(trustPolicyFor(NaN, NaN)).toBe(DENY_ALL);
  });

  it('offers only what the table has rows for', () => {
    for (const def of MODES) {
      for (const t of matchTypesFor(def.id)) expect(isOffered(def.id, t)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 4. Sealing a session — the server decides, from how it was created
 * ------------------------------------------------------------------------ */

describe('sealSessionTrust', () => {
  it('maps every origin to exactly one topology, and an unknown one to untrusted', () => {
    expect(topologyForOrigin(SessionOrigin.CLIENT_WORKER)).toBe(Topology.CLIENT_LOCAL);
    expect(topologyForOrigin(SessionOrigin.PEER_HOST)).toBe(Topology.PEER_HOSTED);
    expect(topologyForOrigin(SessionOrigin.SERVER_MATCHMAKER)).toBe(Topology.SERVER_AUTHORITATIVE);
    expect(topologyForOrigin(99 as SessionOrigin)).not.toBe(Topology.SERVER_AUTHORITATIVE);
  });

  it('clamps the match type by origin, so a peer can never be ranked', () => {
    expect(resolveMatchType(SessionOrigin.PEER_HOST, MatchType.RANKED)).toBe(MatchType.PRIVATE);
    expect(resolveMatchType(SessionOrigin.PEER_HOST, MatchType.COMPETITION)).toBe(MatchType.PRIVATE);
    expect(resolveMatchType(SessionOrigin.CLIENT_WORKER, MatchType.COMPETITION)).toBe(MatchType.SOLO);
    expect(resolveMatchType(SessionOrigin.SERVER_INVITE, MatchType.RANKED)).toBe(MatchType.PRIVATE);
    // Only the scheduler opens a tournament.
    expect(resolveMatchType(SessionOrigin.SERVER_MATCHMAKER, MatchType.COMPETITION)).toBe(MatchType.PUBLIC);
    expect(resolveMatchType(SessionOrigin.SERVER_EVENT, MatchType.COMPETITION)).toBe(MatchType.COMPETITION);
  });

  it('a peer-hosted Horde session grants nothing however it was requested', () => {
    const t = sealSessionTrust(ModeId.HORDE, SessionOrigin.PEER_HOST, MatchType.RANKED);
    expect(t.matchType).toBe(MatchType.PRIVATE);
    expect(t.topology).toBe(Topology.PEER_HOSTED);
    expect(t.grants).toBe(REWARD_NONE);
    expect(sessionMayGrant(t, REWARD_XP)).toBe(false);
    expect(sessionMayGrant(t, REWARD_ITEM_DROP)).toBe(false);
  });

  it('a ranked Deathmatch on our servers grants rating and the rest', () => {
    const t = sealSessionTrust(ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.RANKED);
    expect(t.topology).toBe(Topology.SERVER_AUTHORITATIVE);
    expect(sessionMayGrant(t, REWARD_XP)).toBe(true);
    expect(sessionMayGrant(t, REWARD_RANKED_RATING)).toBe(true);
    expect(sessionMayGrant(t, REWARD_SPONSOR_PRIZE)).toBe(false);
  });

  it('strips the server-only writes from an untrusted session', () => {
    const t = sealSessionTrust(ModeId.BUILDER, SessionOrigin.CLIENT_WORKER, MatchType.PUBLIC);
    expect(sessionMayWrite(t, WRITE_PERSISTENT_WORLD)).toBe(false);
    expect(sessionMayWrite(t, WRITE_LOCAL_RECORD)).toBe(true);
  });

  it('falls back to something untrusted when the origin is garbage', () => {
    const t = sealSessionTrust(ModeId.DEATHMATCH, 99 as SessionOrigin, MatchType.COMPETITION);
    expect(t.grants).toBe(REWARD_NONE);
    expect(t.writes & ~WRITE_LOCAL_RECORD).toBe(WRITE_NONE);
  });

  it('does not let a mode id off the wire become a policy', () => {
    const t = sealSessionTrust(9999, SessionOrigin.SERVER_MATCHMAKER, MatchType.RANKED);
    // Falls back to a real mode rather than inventing a row.
    expect(MODES.some((m) => m.id === t.modeId)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The rollout note is a different question from the table
 * ------------------------------------------------------------------------ */

describe('the peer rollout note', () => {
  it('only ever names rows the table actually permits on a peer', () => {
    for (const note of PEER_ROLLOUT) {
      expect(trustPolicyFor(note.modeId, note.matchType).topology).toBe(Topology.PEER_HOSTED);
    }
  });

  it('covers every peer-hostable row, so none ships by accident', () => {
    for (const p of peerHostableRows()) {
      expect(PEER_ROLLOUT.some((n) => n.modeId === p.modeId && n.matchType === p.matchType)).toBe(true);
    }
  });

  it('recommends exactly one peer build today: co-op Quest', () => {
    const on = PEER_ROLLOUT.filter((n) => n.enabled);
    expect(on).toHaveLength(1);
    expect(on[0].modeId).toBe(ModeId.QUEST);
    expect(on[0].matchType).toBe(MatchType.PRIVATE);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. THE SCAN — no mode's policy is hardcoded anywhere else
 * ------------------------------------------------------------------------ */

describe('the trust table is the single source of truth', () => {
  const files = sourceFiles();

  it('found the tree', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.rel === TRUST_FILE)).toBe(true);
    for (const rel of ENFORCEMENT_FILES) {
      expect(files.some((f) => f.rel === rel)).toBe(true);
    }
  });

  it('declares the reward kinds in exactly one file', () => {
    const declaring = files
      .filter((f) => /^\s*export const REWARD_[A-Z_0-9]+\s*=/m.test(f.text))
      .map((f) => f.rel);
    expect(declaring).toEqual([TRUST_FILE]);
  });

  it('declares the topologies and match types in exactly one file', () => {
    const declaring = files
      .filter((f) => /^\s*export enum (Topology|MatchType|SessionOrigin)\b/m.test(f.text))
      .map((f) => f.rel);
    expect(declaring).toEqual([TRUST_FILE]);
  });

  it('keeps every mode literal out of the enforcement and the display', () => {
    for (const rel of ENFORCEMENT_FILES) {
      const f = files.find((x) => x.rel === rel)!;
      const hits = f.text.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter((x) => /\bModeId\.[A-Z_]+/.test(x.line));
      expect(hits.map((h) => `${rel}:${h.n} ${h.line.trim()}`)).toEqual([]);
    }
  });

  /**
   * The scan is scoped to the *economy* words on purpose. "Which modes may be
   * peer-hosted" is capped by the table anyway — `sealSessionTrust` zeroes the
   * grants of any session that did not run on our hardware, so a peer host that
   * booted the wrong mode still cannot pay anybody. "What a match is worth" has
   * no such backstop outside this table, so that is what is policed here.
   */
  it('never pairs a mode literal with a reward verdict anywhere in the tree', () => {
    const offenders: string[] = [];
    const economy = /rank|reward|grant|scrap|\bxp\b|entitle|payout|prize|leaderboard|drop/i;
    for (const f of files) {
      if (f.rel === TRUST_FILE || f.rel.endsWith('.test.ts')) continue;
      f.text.split('\n').forEach((line, i) => {
        if (!/\bModeId\.[A-Z_]+/.test(line)) return;
        if (!economy.test(line)) return;
        offenders.push(`${f.rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'read trustPolicyFor(modeId, matchType).grants instead of naming the mode',
    ).toEqual([]);
  });

  it('never declares its own list of which modes may be peer-hosted', () => {
    // `peerHostableRows()` is the answer. A second list is a second policy.
    const offenders: string[] = [];
    const declaration = /export\s+(const|function)\s+[A-Za-z_]*([Pp]eer|PEER)[A-Za-z_]*(Modes|MODES|Eligible|ELIGIBLE|Hostable|HOSTABLE|Allowed|ALLOWED)/;
    for (const f of files) {
      if (f.rel === TRUST_FILE || f.rel.endsWith('.test.ts')) continue;
      f.text.split('\n').forEach((line, i) => {
        if (declaration.test(line)) offenders.push(`${f.rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders, 'call peerHostableRows() from trust.ts').toEqual([]);
  });

  it('never hardcodes a ranked / peer-hosted boolean outside the table', () => {
    const offenders: string[] = [];
    const pattern = /\b(un)?ranked\s*[:=]\s*(true|false)|\bpeerHosted\s*[:=]|\brewardsCount\s*[:=]\s*(true|false)/i;
    for (const f of files) {
      if (f.rel === TRUST_FILE || f.rel.endsWith('.test.ts')) continue;
      f.text.split('\n').forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${f.rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('makes the enforcement and the display read the table', () => {
    for (const rel of ENFORCEMENT_FILES) {
      const f = files.find((x) => x.rel === rel)!;
      expect(f.text).toMatch(/from '@(doomcraft\/)?shared\/trust'/);
    }
  });

  it('leaves the rest of the tree free to keep its own mode branches', () => {
    // Sanity check on the scan itself: `modes.ts` is full of ModeId literals and
    // must stay that way. A scan that would fail there is a scan that is testing
    // the wrong thing.
    const modesFile = files.find((f) => f.rel === path.join('shared', 'src', 'modes.ts'))!;
    expect(/\bModeId\.[A-Z_]+/.test(modesFile.text)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * 7. The properties the rest of the code relies on
 * ------------------------------------------------------------------------ */

describe('derived predicates', () => {
  it('agrees with the raw masks', () => {
    for (const p of TRUST_TABLE) {
      expect(grantsAnything(p)).toBe(p.grants !== 0);
      expect((p.grants & ~REWARD_ALL)).toBe(0);
    }
  });

  it('offers at least one rewarding option in every mode that has an online queue', () => {
    for (const def of MODES) {
      const any = matchTypesFor(def.id).some((t) => grantsAnything(trustPolicyFor(def.id, t)));
      expect(any).toBe(true);
    }
  });
});
