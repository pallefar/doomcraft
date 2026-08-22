/**
 * DOOMCRAFT — the profile screen, decided here. No DOM in this file.
 *
 * `vitest.config.ts` sets `environment: 'node'` and there is no jsdom, so every
 * line that decides *what* the profile says lives here and is tested, and
 * `client/src/ui/profile.ts` only decides where the strings land. That split is
 * not a style preference: `client/src/ui/` shipped four files and zero tests
 * before this one, and the reason was that all four are `document`-shaped.
 *
 * FOUR RULES THIS FILE OBEYS
 *
 * 1. **Never read `save.profile.{xp, level, secondsPlayed, adsRemoved}`.**
 *    `createSaveFile()` sets them to 0/1/0/false and *nothing in the tree ever
 *    writes them again* — `grep -rn "save\.profile\." client/src` finds only
 *    `avatar`, `skin`, `name` and `lastMode`. The live counters are on the
 *    legacy flat `progress` blob, which is what the menu's stat strip prints.
 *    Rendering the SaveFile copies would put four permanent zeroes on the
 *    screen and they would look like a data-loss bug. `profileModel.test.ts`
 *    proves this with a Proxy that records every property read, not with a
 *    string scan that a rename would walk straight past.
 *
 * 2. **Every number is laundered through `safeInt`/`safeNum`.** A save is a
 *    JSON blob off the player's own disk. `migrateSave` is total, but `_unknown`
 *    carry-through and a half-written record mean a `NaN` can still reach here,
 *    and "NaN kills" on the one screen that exists to say "look what you did"
 *    is the worst possible bug. No `ProfileView` string may ever contain `NaN`,
 *    `Infinity` or `undefined`; the test asserts it over the whole rendered set.
 *
 * 3. **No mode literal, ever.** `shared/src/trust.test.ts` fails the build on
 *    any line in the tree pairing `ModeId.SOMETHING` with an economy word, and
 *    a profile screen is nothing but modes next to what they are worth. Every
 *    per-mode statement here comes from `MODE_KEYS`/`getMode()` by index, and
 *    what a match pays comes from `matchTypeSummary()` — which reads the trust
 *    table and is itself forbidden from naming a mode.
 *
 * 4. **`sourceNote` is never empty.** The player must always be able to answer
 *    "where does this come from and would I lose it". On the shipped static
 *    build the answer is "this device only", which is also the most honest
 *    conversion prompt in the product.
 */

import { levelForXp, xpForLevel, type SaveProgress } from '@shared/constants';
import { MODE_KEYS, getMode, isModeId, type ModeId } from '@shared/modes';
import {
  activeQuestSlot,
  kdr,
  plural,
  questCompletion,
  winRate,
  type BuilderWorld,
  type HordeMapRecord,
  type QuestSlot,
  type SaveFile,
} from '@shared/saves';
import { MatchType } from '@shared/trust';
import { WEAPON_NAMES } from '@shared/weapons';

import { economySurfacesOn } from '@/hud/hud';
import { defaultMatchTypeFor } from '@/ui/matchType';

/* ------------------------------------------------------------------------ *
 * The rendered shapes
 * ------------------------------------------------------------------------ */

export interface StatTile {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}

export interface ProfileRow {
  readonly left: string;
  readonly right: string;
  /** A detail line under its own heading row, rendered quieter. */
  readonly dim: boolean;
}

export interface ProfilePanel {
  readonly title: string;
  readonly rows: readonly ProfileRow[];
  /** '' when the panel is complete; otherwise why it is thin. Never omitted. */
  readonly caveat: string;
}

export interface AccountView {
  readonly linked: boolean;
  /** 'house' | 'workos' | ''. Empty until a CredentialProvider is bound. */
  readonly namespace: string;
  /**
   * VERBATIM from `CredentialProvider.authenticates` (docs/PLATFORM.md §2.4).
   * A recovery code proves possession, not identity, so the house provider
   * answers false and the sentence has to say so.
   */
  readonly authenticates: boolean;
  readonly sentence: string;
  readonly deviceCount: number;
}

export type ProfileSource = 'device' | 'server' | 'both';

/**
 * The half of `server/src/persistence.ts`'s `PublicProfile` this screen reads.
 *
 * Declared here and not imported, because `client/tsconfig.json` references
 * `shared` and nothing else — a client file that imports a server type does not
 * compile, and moving `StoredStats` into `shared/` to make it compile would put
 * the server's storage schema on the wire budget of every browser. The cost of
 * the restatement is drift, so `profileModel.test.ts` reads
 * `server/src/persistence.ts` and fails if a field named here is not a field
 * there.
 */
export interface RemoteStats {
  readonly matches: number;
  readonly wins: number;
  readonly kills: number;
  readonly deaths: number;
  readonly bestStreak: number;
  readonly damageDealt: number;
  readonly blocksPlaced: number;
  readonly blocksBroken: number;
  readonly secondsPlayed: number;
  readonly favouriteWeapon: number;
  readonly weaponKills: readonly number[];
  readonly lastSeenMs: number;
}

export interface RemoteEconomy {
  readonly scrap: number;
  readonly lifetimeScrap: number;
  readonly day: string;
  readonly dayXp: number;
  readonly dayScrap: number;
  readonly dayMatches: number;
}

export interface RemoteProfile {
  readonly updatedMs: number;
  readonly stats: RemoteStats;
  readonly economy: RemoteEconomy;
}

/** Which (mode, match type) the "what this is worth" notice is pointed at. */
export interface WorthPointer {
  readonly modeId: ModeId;
  readonly matchType: MatchType;
  /** "Deathmatch — what a match is worth". Built from `getMode().name`. */
  readonly heading: string;
}

export interface ProfileView {
  readonly name: string;
  readonly avatarPacked: number;
  /** "Marine since 14 Feb 2026", or an honest sentence when nothing is stored. */
  readonly since: string;
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForLevel: number;
  /** 0..1, clamped. Never NaN, including at the level cap where the span is 0. */
  readonly levelFraction: number;
  readonly tiles: readonly StatTile[];
  readonly panels: readonly ProfilePanel[];
  readonly account: AccountView;
  readonly source: ProfileSource;
  /** The provenance line under the header. NEVER empty. */
  readonly sourceNote: string;
  readonly economyVisible: boolean;
  readonly worth: WorthPointer;
}

export interface ProfileInputs {
  /** `shared/src/saves.ts` — the schema-versioned per-mode document. */
  readonly save: SaveFile;
  /** The legacy flat blob. The ONLY place the live counters are written. */
  readonly progress: SaveProgress;
  /** `GET /api/profile`, or null when there is no server (the static build). */
  readonly remote: RemoteProfile | null;
  /** `NetClient.balanceXp` / `.balanceScrap`. Null before a session settles. */
  readonly liveBalance: { readonly xp: number; readonly scrap: number } | null;
  /** `isEnabled(Feature.ECONOMY)` — a localStorage PREFERENCE, nothing more. */
  readonly economyProduct: boolean;
  /** `NetClient.flagBits` — what the SERVER resolved. The kill switch. */
  readonly flagBits: number;
  /**
   * null means "this build has no `CredentialProvider` bound", which is the
   * shipped static site and is the true answer rather than a placeholder —
   * `deviceOnlyAccount()` renders it. Nullable so the SHELL does not have to
   * import a value from this module to say "no accounts here": `main.ts` holds
   * `ProfileInputs` as a type only, which is what keeps the whole overlay in a
   * lazy chunk instead of on the boot path.
   */
  readonly account: AccountView | null;
  readonly nowMs: number;
}

/* ------------------------------------------------------------------------ *
 * Laundering
 * ------------------------------------------------------------------------ */

/**
 * Any non-finite number becomes 0, and anything past 2^53 is pinned there.
 *
 * The clamp is not decoration. `groupInt` works on `String(n)`, and
 * `(1e200).toString()` is `"1e+200"` — which the grouper would render as
 * `1,e+2,00`. Nobody reaches that with a real save, but the whole reason this
 * function exists is that the input is a JSON blob off the player's disk.
 */
export const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

export function safeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_SAFE_COUNT, Math.min(MAX_SAFE_COUNT, Math.trunc(n)));
}

export function safeNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

export function safeText(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : fallback;
}

/**
 * `1,204`. Hand-rolled rather than `toLocaleString`, because a node build
 * without full ICU groups differently from a browser and a test that passes on
 * one machine and fails on another gets deleted rather than fixed.
 */
export function groupInt(v: unknown): string {
  const n = safeInt(v);
  const neg = n < 0;
  const digits = Math.abs(n).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

/** `4:07`, `1:02:13`. Seconds only; 0 is `0:00`, not ''. */
export function clockText(seconds: unknown): string {
  const total = Math.max(0, safeInt(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** `3 h 12 m` for a lifetime total, where `1:02:13` is unreadable. */
export function spanText(seconds: unknown): string {
  const total = Math.max(0, safeInt(seconds));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h === 0) return `${m} m`;
  return `${h} h ${m} m`;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** `14 Feb 2026`, UTC, hand-formatted for the same reason `groupInt` is. */
export function dateText(ms: unknown): string {
  const t = safeInt(ms);
  if (t <= 0) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `just now` / `4 h ago` / `3 days ago`. A future timestamp reads `just now`. */
export function agoText(thenMs: unknown, nowMs: unknown): string {
  const then = safeInt(thenMs);
  const now = safeInt(nowMs);
  if (then <= 0) return 'never';
  const secs = Math.floor((now - then) / 1000);
  if (secs < 90) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/* ------------------------------------------------------------------------ *
 * The level bar
 * ------------------------------------------------------------------------ */

/** The game's own ceiling: `levelForXp` (shared/src/constants.ts) stops here. */
export const MAX_LEVEL = 200;

export interface LevelBar {
  readonly level: number;
  readonly into: number;
  readonly span: number;
  /** 0..1. Never NaN, including when the span collapses. */
  readonly fraction: number;
}

/**
 * `into / span`, with the divide-by-zero answered rather than guarded around.
 *
 * Split out and exported because it is the only line in the level bar that can
 * put `NaN%` on the screen, and a guard a test cannot drive is a guard nobody
 * knows works. **`levelBar` cannot reach `span === 0` today** — `xpForLevel` is
 * a strictly increasing polynomial and `safeInt` pins its inputs inside 2^53,
 * so every span is positive. That is a property of today's curve, not of the
 * bar: give the game a real level cap where `xpForLevel(201) === xpForLevel(200)`
 * and this becomes the live path on the same day. So it is tested here, head on,
 * and `levelBar`'s own test asserts the span stays positive for every level the
 * game can currently produce.
 */
export function barFraction(into: unknown, span: unknown): number {
  const s = safeNum(span);
  if (!(s > 0)) return 1;
  const f = safeNum(into) / s;
  return Math.max(0, Math.min(1, safeNum(f)));
}

/** The level bar's arithmetic. Pure, so `profileModel.test.ts` can drive it. */
export function levelBar(xpTotal: unknown, levelIn: unknown): LevelBar {
  const xp = Math.max(0, safeInt(xpTotal));
  const level = Math.max(1, safeInt(levelIn) || levelForXp(xp));
  const floor = xpForLevel(level);
  const span = Math.max(0, safeInt(xpForLevel(level + 1) - floor));
  const into = Math.max(0, Math.min(span, safeInt(xp - floor)));
  return Object.freeze({ level, into, span, fraction: barFraction(into, span) });
}

/* ------------------------------------------------------------------------ *
 * The account view the shipped static build hands in
 * ------------------------------------------------------------------------ */

/**
 * What §2 looks like before any of §2 exists.
 *
 * This is not a placeholder to be quietly replaced — it is the true answer for
 * a device with no account, and it stays the answer for every player who never
 * links one. C4 replaces the *inputs*, not this function.
 */
export function deviceOnlyAccount(): AccountView {
  return Object.freeze({
    linked: false,
    namespace: '',
    authenticates: false,
    sentence: 'Not backed up — this device only. Clear your browser data and it is gone.',
    deviceCount: 1,
  });
}

/* ------------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------------ */

function row(left: string, right: string, dim = false): ProfileRow {
  return Object.freeze({ left, right, dim });
}

function panel(title: string, rows: readonly ProfileRow[], caveat: string): ProfilePanel {
  return Object.freeze({ title, rows: Object.freeze(rows.slice()), caveat });
}

/** The mode's display name, by index, so no literal is ever written. */
function modeNameAt(index: number): string {
  return isModeId(index) ? getMode(index).name : (MODE_KEYS[index] ?? 'Unknown');
}

const QUEST_INDEX = MODE_KEYS.indexOf('quest');
const BUILDER_INDEX = MODE_KEYS.indexOf('builder');
const HORDE_INDEX = MODE_KEYS.indexOf('horde');
const DEATHMATCH_INDEX = MODE_KEYS.indexOf('deathmatch');

/** Levels of one slot listed in the detail panel before it is truncated. */
export const MAX_LEVEL_ROWS = 12;

function questPanel(save: SaveFile): ProfilePanel {
  const slots: readonly QuestSlot[] = Array.isArray(save.quest?.slots) ? save.quest.slots : [];
  const rows = slots.map((slot) => {
    const levels = Array.isArray(slot.levels) ? slot.levels : [];
    let cleared = 0;
    for (const r of levels) if (r.completed === true) cleared++;
    const right = levels.length === 0
      ? `no levels played · ${plural(safeInt(slot.deaths), 'death')}`
      : `${safeInt(questCompletion(slot))}% · ${cleared}/${levels.length} levels`
        + ` · ${plural(safeInt(slot.deaths), 'death')}`;
    return row(safeText(slot.name, 'Campaign'), right);
  });
  return panel(
    modeNameAt(QUEST_INDEX),
    rows,
    rows.length === 0 ? 'No campaign started on this device yet.' : '',
  );
}

function questLevelPanel(save: SaveFile): ProfilePanel {
  const slot = activeQuestSlot(save);
  const levels = slot === null || !Array.isArray(slot.levels) ? [] : slot.levels;
  const played = levels.slice().sort((a, b) => safeInt(b.lastPlayedMs) - safeInt(a.lastPlayedMs));
  const shown = played.slice(0, MAX_LEVEL_ROWS);
  const rows = shown.map((r) => {
    const best = safeInt(r.bestTimeSec);
    const parts: string[] = [];
    parts.push(r.completed === true ? (best > 0 ? `best ${clockText(best)}` : 'cleared') : 'not cleared');
    parts.push(`${safeInt(r.kills)}/${safeInt(r.killsTotal)} kills`);
    parts.push(`${safeInt(r.secrets)}/${safeInt(r.secretsTotal)} secrets`);
    return row(safeText(r.levelId, 'level').toUpperCase(), parts.join(' · '), true);
  });
  let caveat = '';
  if (slot === null) caveat = 'No campaign is active, so there are no level records to show.';
  else if (rows.length === 0) caveat = `“${safeText(slot.name, 'Campaign')}” has no finished levels yet.`;
  else if (played.length > shown.length) {
    caveat = `Most recent ${shown.length} of ${played.length} levels in “${safeText(slot.name, 'Campaign')}”.`;
  }
  return panel(`${modeNameAt(QUEST_INDEX)} — level bests`, rows, caveat);
}

function builderPanel(save: SaveFile, nowMs: number): ProfilePanel {
  const worlds: readonly BuilderWorld[] = Array.isArray(save.builder?.worlds) ? save.builder.worlds : [];
  const byRecency = worlds.slice().sort((a, b) => safeInt(b.updatedMs) - safeInt(a.updatedMs));
  const rows = byRecency.map((w) => {
    const parts = [
      `${plural(safeInt(w.blocksPlaced), 'block')} placed`,
      `${plural(safeInt(w.editedChunks), 'chunk')} edited`,
      agoText(w.updatedMs, nowMs),
    ];
    if (w.online === true) parts.push('shared');
    return row(safeText(w.name, 'World'), parts.join(' · '));
  });
  return panel(
    modeNameAt(BUILDER_INDEX),
    rows,
    rows.length === 0 ? 'No worlds on this device yet.' : '',
  );
}

function hordePanel(save: SaveFile): ProfilePanel {
  const h = save.horde;
  const maps: readonly HordeMapRecord[] = Array.isArray(h?.maps) ? h.maps : [];
  const byWave = maps.slice().sort((a, b) => safeInt(b.bestWave) - safeInt(a.bestWave));
  const rows = byWave.map((m) => row(
    safeText(m.mapId, 'map').toUpperCase(),
    `wave ${safeInt(m.bestWave)} · ${groupInt(m.bestScore)} pts · ${clockText(m.bestTimeSec)}`,
  ));
  let caveat = '';
  if (rows.length === 0) {
    caveat = safeInt(h?.runs) > 0
      ? `${plural(safeInt(h.runs), 'run')} recorded, but none of them named a map.`
      : 'No runs on this device yet.';
  }
  return panel(modeNameAt(HORDE_INDEX), rows, caveat);
}

/**
 * The one panel whose source is not written by anything.
 *
 * `recordDeathmatch` (`shared/src/saves.ts`) is the only one of the four
 * per-mode recorders with **no caller** — Quest, Builder and Horde all write
 * their section from their mode, Deathmatch never did. So `save.deathmatch` is
 * `{matches: 0, …}` for every player forever, and the per-weapon histogram
 * docs/PLATFORM.md §6.2 calls "the one genuinely interesting panel already in
 * storage" is empty on every device in the world.
 *
 * The rule is not to render a structurally-zero field or to say in the UI that
 * it is not tracked yet. This panel does the second, and takes `progress` so it
 * can tell the player the difference between "you have not played" and "we are
 * not writing it down" — which are the same picture and very different bugs.
 */
function deathmatchPanel(save: SaveFile, progress: SaveProgress): ProfilePanel {
  const d = save.deathmatch;
  const kills: readonly number[] = Array.isArray(d?.weaponKills) ? d.weaponKills : [];
  const ranked = kills
    .map((n, i) => ({ i, n: safeInt(n) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const rows = ranked.map((x) => row(
    WEAPON_NAMES[x.i] ?? `Weapon ${x.i}`,
    plural(x.n, 'kill'),
  ));
  const matches = safeInt(d?.matches);
  if (matches > 0) {
    rows.unshift(row(
      'Record',
      `${plural(matches, 'match', 'matches')} · ${safeNum(winRate(d)).toFixed(0)}% won`
      + ` · ${safeNum(kdr(d)).toFixed(2)} K/D`,
    ));
  }
  const entered = safeInt(progress.gamesPlayed);
  let caveat = '';
  if (matches === 0 && entered === 0) caveat = 'No matches on this device yet.';
  else if (matches === 0) {
    caveat = `${plural(entered, 'match', 'matches')} entered on this device, but per-match`
      + ' records are not being written yet — so there is no per-weapon breakdown here.'
      + ' The counters above are live.';
  } else if (ranked.length === 0) caveat = 'Matches played, but no kills recorded per weapon yet.';
  return panel(modeNameAt(DEATHMATCH_INDEX), rows, caveat);
}

const NO_SERVER_CAVEAT =
  'Needs a server. This build talks to no host, so there is no account-side record to read.';

function lifetimePanel(remote: RemoteProfile | null, nowMs: number): ProfilePanel {
  if (remote === null) return panel('Lifetime — server record', [], NO_SERVER_CAVEAT);
  const s = remote.stats;
  const rows: ProfileRow[] = [
    row('Matches', `${groupInt(s.matches)} · ${groupInt(s.wins)} won`),
    row('Kills / deaths', `${groupInt(s.kills)} / ${groupInt(s.deaths)}`),
    row('Best streak', groupInt(s.bestStreak)),
    row('Damage dealt', groupInt(s.damageDealt)),
    row('Blocks', `${groupInt(s.blocksPlaced)} placed · ${groupInt(s.blocksBroken)} broken`),
    row('Time played', spanText(s.secondsPlayed)),
    row('Favourite weapon', WEAPON_NAMES[safeInt(s.favouriteWeapon)] ?? 'Unknown'),
    row('Last seen', agoText(s.lastSeenMs, nowMs)),
  ];
  const hist: readonly number[] = Array.isArray(s.weaponKills) ? s.weaponKills : [];
  const ranked = hist
    .map((n, i) => ({ i, n: safeInt(n) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  for (const x of ranked) rows.push(row(WEAPON_NAMES[x.i] ?? `Weapon ${x.i}`, plural(x.n, 'kill'), true));
  return panel(
    'Lifetime — server record',
    rows,
    ranked.length === 0 ? 'The server has no per-weapon kills for this account yet.' : '',
  );
}

/**
 * The currency panel.
 *
 * It deliberately does NOT print today's headroom against the daily caps, which
 * docs/PLATFORM.md §6.2 asks for: `DAY_XP_CAP`, `DAY_SCRAP_CAP` and `DR_LADDER`
 * are declared in `server/src/persistence.ts`, a client cannot import them, and
 * copying the numbers into the browser bundle would both publish the anti-farm
 * thresholds to the people they exist to stop and create a second source of
 * truth that drifts the first time they are tuned. What is shown instead is
 * what the SERVER already told this client it earned today — which is the same
 * information from the only side that is allowed to have an opinion.
 */
function balancePanel(
  remote: RemoteProfile | null,
  live: { readonly xp: number; readonly scrap: number } | null,
): ProfilePanel {
  const rows: ProfileRow[] = [];
  let caveat = '';
  if (live !== null) {
    rows.push(row('This session', `${groupInt(live.xp)} XP · ${groupInt(live.scrap)} Scrap granted`));
  }
  if (remote !== null) {
    const e = remote.economy;
    rows.push(row('Balance', `${groupInt(e.scrap)} Scrap`));
    rows.push(row('Earned all time', `${groupInt(e.lifetimeScrap)} Scrap`));
    rows.push(row(
      'Today',
      `${groupInt(e.dayXp)} XP · ${groupInt(e.dayScrap)} Scrap`
      + ` · ${plural(safeInt(e.dayMatches), 'match', 'matches')}`,
      true,
    ));
  } else {
    caveat = live === null
      ? NO_SERVER_CAVEAT
      : 'Session totals only. A balance that survives a refresh needs a server.';
  }
  return panel('Points and Scrap', rows, caveat);
}

function accountPanel(a: AccountView): ProfilePanel {
  const rows: ProfileRow[] = [
    row('Status', a.linked ? 'Linked' : 'Not linked'),
    row('Devices', groupInt(a.deviceCount)),
  ];
  if (a.linked) {
    rows.push(row('Provider', safeText(a.namespace, 'unknown')));
    rows.push(row(
      'Proves it is you',
      a.authenticates ? 'Yes — a real sign-in' : 'No — anyone holding the code has it',
    ));
  }
  return panel('Account', rows, a.sentence);
}

/* ------------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------------ */

/** True when this device has any history of its own worth calling "both". */
function hasLocalHistory(save: SaveFile, progress: SaveProgress): boolean {
  if (safeInt(progress.gamesPlayed) > 0) return true;
  if (safeInt(progress.kills) > 0) return true;
  if ((save.quest?.slots ?? []).length > 0) return true;
  if ((save.builder?.worlds ?? []).length > 0) return true;
  if (safeInt(save.horde?.runs) > 0) return true;
  if (safeInt(save.deathmatch?.matches) > 0) return true;
  return false;
}

const SOURCE_NOTES: Readonly<Record<ProfileSource, string>> = Object.freeze({
  device: 'Not backed up — this device only.',
  server: 'Server profile. Nothing has been played in this browser yet.',
  both: 'This device and the server. Where they disagree, the server is right.',
});

export function buildProfileView(i: ProfileInputs): ProfileView {
  const save = i.save;
  const progress = i.progress;

  /* --- header ------------------------------------------------------- */
  const name = safeText(save.profile.name, safeText(progress.name, 'Marine'));
  const avatarPacked = safeInt(save.profile.avatar) >>> 0;
  const created = dateText(save.profile.createdMs);
  const since = created === ''
    ? 'Marine — this browser did not record a start date'
    : `Marine since ${created}`;

  /* --- level -------------------------------------------------------- *
   * From `progress`, NOT from `save.profile`. See rule 1 at the top.    */
  const bar = levelBar(progress.xp, Math.min(MAX_LEVEL, safeInt(progress.level)));
  const level = bar.level;
  const span = bar.span;
  const into = bar.into;
  const levelFraction = bar.fraction;

  /* --- tiles -------------------------------------------------------- */
  const tiles: readonly StatTile[] = Object.freeze([
    Object.freeze({ label: 'Kills', value: groupInt(progress.kills), hint: 'across every mode' }),
    Object.freeze({ label: 'Deaths', value: groupInt(progress.deaths), hint: 'across every mode' }),
    Object.freeze({
      label: 'Matches',
      // NOT `${progress.wins} won`. `progress.wins` is declared in
      // `shared/src/constants.ts` and written by nothing in the tree — the same
      // permanent zero as `save.profile.xp`, and docs/PLATFORM.md §6.2 did not
      // catch this one. `gamesPlayed` is incremented at `startMode`, so the
      // honest word is "entered", not "played" and certainly not "won".
      value: groupInt(progress.gamesPlayed),
      hint: 'entered on this device',
    }),
    Object.freeze({
      label: 'Level',
      value: groupInt(level),
      hint: span === 0 ? 'at the cap' : `${groupInt(span - into)} XP to go`,
    }),
  ]);

  /* --- source ------------------------------------------------------- */
  const source: ProfileSource = i.remote === null
    ? 'device'
    : (hasLocalHistory(save, progress) ? 'both' : 'server');
  let sourceNote = SOURCE_NOTES[source];
  if (source !== 'device' && i.remote !== null) {
    sourceNote = `${sourceNote} Server last wrote ${agoText(i.remote.updatedMs, i.nowMs)}.`;
  }

  /* --- what a match is worth ---------------------------------------- */
  const lastMode = save.profile.lastMode;
  const modeIndex = isModeId(lastMode) ? lastMode : (DEATHMATCH_INDEX as ModeId);
  const worth: WorthPointer = Object.freeze({
    modeId: modeIndex,
    matchType: defaultMatchTypeFor(modeIndex),
    heading: `${modeNameAt(modeIndex)} — what a match is worth`,
  });

  /* --- panels ------------------------------------------------------- */
  const account = i.account ?? deviceOnlyAccount();
  const economyVisible = economySurfacesOn(i.economyProduct, i.flagBits);
  const panels: ProfilePanel[] = [
    questPanel(save),
    questLevelPanel(save),
    builderPanel(save, i.nowMs),
    hordePanel(save),
    deathmatchPanel(save, progress),
    lifetimePanel(i.remote, i.nowMs),
  ];
  if (economyVisible) panels.push(balancePanel(i.remote, i.liveBalance));
  panels.push(accountPanel(account));

  return Object.freeze({
    name,
    avatarPacked,
    since,
    level,
    xpIntoLevel: into,
    xpForLevel: span,
    levelFraction,
    tiles,
    panels: Object.freeze(panels),
    account,
    source,
    sourceNote,
    economyVisible,
    worth,
  });
}

/**
 * Every string a `ProfileView` will put on the screen, flattened.
 *
 * The "no NaN anywhere" assertion needs a total enumeration or it is a test of
 * whichever fields somebody remembered. Adding a rendered field without adding
 * it here is the failure mode, so `profile.ts` reads its text through the same
 * shapes this walks — `tiles`, `panels`, and the six header strings.
 */
export function renderedStrings(v: ProfileView): string[] {
  const out: string[] = [
    v.name, v.since, v.sourceNote, v.worth.heading,
    v.account.sentence, v.account.namespace,
    String(v.level), String(v.xpIntoLevel), String(v.xpForLevel), String(v.levelFraction),
  ];
  for (const t of v.tiles) out.push(t.label, t.value, t.hint);
  for (const p of v.panels) {
    out.push(p.title, p.caveat);
    for (const r of p.rows) out.push(r.left, r.right);
  }
  return out;
}
