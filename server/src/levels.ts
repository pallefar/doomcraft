/**
 * DOOMCRAFT — level loading and serving.
 *
 * The contract from docs/MODES.md is that a new episode is a FILE, not a code
 * change. This module is the whole of that promise on the server side:
 *
 *   - it scans `content/levels/` at boot, taking `*.json` (hand-authored source)
 *     and `*.dcl` (already-compiled binary) alike,
 *   - it compiles, validates and caches each one, with the encoded bytes and
 *     their FNV-1a hash so clients can cache by content,
 *   - **a level that fails validation is never served.** `validateLevel` runs a
 *     real lock-and-key reachability solve; a map whose exit cannot be walked to
 *     is loaded, logged, listed as unplayable and refused at join,
 *   - it builds the manifest the mode select reads, grouped into episodes,
 *   - and it stamps a level's chunk sections straight into a `ServerWorld`,
 *     in place, so streaming an authored level to a client is the existing
 *     S2C.CHUNK message with nothing new bolted on.
 *
 * HTTP is exposed as a pure function (`handle`) returning a plain response
 * record, so `index.ts` mounts it in three lines and this file never imports
 * `node:http`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORLD_MIN_BLOCK_X,
  WORLD_MIN_BLOCK_Z,
  WORLD_SIZE_BLOCKS,
} from '@doomcraft/shared';
import {
  applyLevelToWorld,
  buildManifest,
  compileLevel,
  decodeLevel,
  encodeLevel,
  formatValidation,
  hashLevelBytes,
  isLevelBinary,
  levelTotals,
  manifestEntryFor,
  parseLevelJson,
  primarySpawn,
  validateLevel,
  type Level,
  type LevelApplyResult,
  type LevelManifest,
  type LevelManifestEntry,
  type LevelValidation,
  type LevelWorldTarget,
} from '@doomcraft/shared/level';
import { DEFAULT_SKILL, sanitiseContentId } from '@doomcraft/shared/modes';

/* ------------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------------ */

const here = fileURLToPath(import.meta.url);
/** server/src/levels.ts and server/dist/levels.js are both two directories down. */
const repoRoot = resolve(here, '..', '..', '..');

/** Where levels live unless `DOOMCRAFT_LEVELS` says otherwise. */
export const DEFAULT_LEVEL_DIR = resolve(process.env.DOOMCRAFT_LEVELS ?? join(repoRoot, 'content', 'levels'));

export const LEVEL_SOURCE_EXT = '.json';
export const LEVEL_BINARY_EXT = '.dcl';
/** Refuse anything larger than this so a bad file cannot exhaust memory. */
export const MAX_LEVEL_FILE_BYTES = 24 * 1024 * 1024;

/* ------------------------------------------------------------------------ *
 * A loaded level
 * ------------------------------------------------------------------------ */

export interface LoadedLevel {
  id: string;
  /** Absolute path it came from. */
  file: string;
  /** True when the file was JSON source rather than a compiled .dcl. */
  fromSource: boolean;
  level: Level;
  /** Encoded .dcl bytes — what `GET /api/levels/<id>/data` returns. */
  bytes: Uint8Array;
  contentHash: number;
  validation: LevelValidation;
  entry: LevelManifestEntry;
  /** Raw file text, kept only for JSON sources so an editor can round-trip. */
  source: string | null;
  loadedMs: number;
}

export interface LevelLibraryOptions {
  dir?: string;
  /** Skill the manifest totals are computed at. */
  manifestSkill?: number;
  /** Where load diagnostics go. Defaults to stderr. */
  log?: (line: string) => void;
  /** Serve levels that failed validation anyway. Only for the level editor. */
  allowInvalid?: boolean;
  clock?: () => number;
}

export interface LevelLoadProblem {
  file: string;
  id: string;
  message: string;
}

/* ------------------------------------------------------------------------ *
 * Library
 * ------------------------------------------------------------------------ */

export class LevelLibrary {
  readonly dir: string;
  private readonly manifestSkill: number;
  private readonly log: (line: string) => void;
  private readonly allowInvalid: boolean;
  private readonly clock: () => number;

  private readonly byId = new Map<string, LoadedLevel>();
  private manifestCache: LevelManifest | null = null;
  private manifestJsonCache: string | null = null;
  /** Files that could not be loaded at all — bad JSON, bad magic, too big. */
  readonly problems: LevelLoadProblem[] = [];

  constructor(options: LevelLibraryOptions = {}) {
    this.dir = resolve(options.dir ?? DEFAULT_LEVEL_DIR);
    this.manifestSkill = options.manifestSkill ?? DEFAULT_SKILL;
    this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
    this.allowInvalid = options.allowInvalid ?? false;
    this.clock = options.clock ?? (() => Date.now());
  }

  /* --- loading --------------------------------------------------------- */

  /** Scan the directory. Returns the number of levels that loaded and validated. */
  load(): number {
    this.byId.clear();
    this.problems.length = 0;
    this.manifestCache = null;
    this.manifestJsonCache = null;

    if (!existsSync(this.dir)) {
      this.log(`levels: ${this.dir} does not exist — no Quest content installed`);
      return 0;
    }

    let files: string[];
    try {
      files = readdirSync(this.dir).sort();
    } catch (e) {
      this.log(`levels: cannot read ${this.dir}: ${String(e)}`);
      return 0;
    }

    let ok = 0;
    for (const name of files) {
      const ext = extname(name).toLowerCase();
      if (ext !== LEVEL_SOURCE_EXT && ext !== LEVEL_BINARY_EXT) continue;
      if (name.startsWith('.') || name === 'manifest.json') continue;
      const file = join(this.dir, name);
      const loaded = this.loadFile(file);
      if (loaded === null) continue;
      const existing = this.byId.get(loaded.id);
      if (existing !== undefined) {
        // A .dcl and its .json source both present: the source wins, it is newer truth.
        if (existing.fromSource && !loaded.fromSource) continue;
      }
      this.byId.set(loaded.id, loaded);
      if (loaded.validation.ok) ok++;
    }

    for (const l of this.byId.values()) {
      if (!l.validation.ok) {
        this.log(`levels: REFUSING ${l.id} — ${formatValidation(l.id, l.validation)}`);
      } else if (l.validation.warnings.length > 0) {
        this.log(formatValidation(l.id, l.validation));
      }
    }
    this.log(`levels: ${ok}/${this.byId.size} playable from ${this.dir}`);
    return ok;
  }

  /** Reload from disk. Safe to call while rooms are running; they keep their copy. */
  reload(): number { return this.load(); }

  private loadFile(file: string): LoadedLevel | null {
    let size = 0;
    try { size = statSync(file).size; } catch { return null; }
    if (size > MAX_LEVEL_FILE_BYTES) {
      this.problems.push({ file, id: '', message: `file is ${size} bytes, over the ${MAX_LEVEL_FILE_BYTES} cap` });
      return null;
    }

    let raw: Buffer;
    try { raw = readFileSync(file); } catch (e) {
      this.problems.push({ file, id: '', message: `unreadable: ${String(e)}` });
      return null;
    }

    const bytesIn = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    let level: Level;
    let fromSource: boolean;
    let source: string | null = null;

    if (isLevelBinary(bytesIn)) {
      try {
        level = decodeLevel(bytesIn.slice());
      } catch (e) {
        this.problems.push({ file, id: '', message: `bad .dcl: ${String(e)}` });
        return null;
      }
      fromSource = false;
    } else {
      const text = raw.toString('utf8');
      const src = parseLevelJson(text);
      if (src === null) {
        this.problems.push({ file, id: '', message: 'not valid JSON and not a .dcl' });
        return null;
      }
      try {
        level = compileLevel(src);
      } catch (e) {
        this.problems.push({ file, id: '', message: `compile failed: ${String(e)}` });
        return null;
      }
      fromSource = true;
      source = text;
    }

    const id = sanitiseContentId(level.meta.id);
    if (id.length === 0) {
      this.problems.push({ file, id: level.meta.id, message: 'meta.id is missing or not a lowercase slug' });
      return null;
    }
    level.meta.id = id;

    const bytes = encodeLevel(level);
    const validation = validateLevel(level, level.meta.defaultSkill);
    const entry = manifestEntryFor(level, bytes, validation);

    return {
      id,
      file,
      fromSource,
      level,
      bytes,
      contentHash: hashLevelBytes(bytes),
      validation,
      entry,
      source,
      loadedMs: this.clock(),
    };
  }

  /* --- queries ---------------------------------------------------------- */

  get size(): number { return this.byId.size; }
  get playableCount(): number {
    let n = 0;
    for (const l of this.byId.values()) if (l.validation.ok) n++;
    return n;
  }

  has(id: string): boolean { return this.byId.has(sanitiseContentId(id)); }

  /** The loaded record, valid or not. */
  get(id: string): LoadedLevel | null {
    return this.byId.get(sanitiseContentId(id)) ?? null;
  }

  /** The compiled level, but only when it is safe to play. */
  getPlayable(id: string): Level | null {
    const l = this.get(id);
    if (l === null) return null;
    if (!l.validation.ok && !this.allowInvalid) return null;
    return l.level;
  }

  /** Every level in load order, valid first. */
  all(): LoadedLevel[] {
    return [...this.byId.values()].sort(
      (a, b) => (a.entry.episodeIndex - b.entry.episodeIndex)
        || (a.entry.levelIndex - b.entry.levelIndex)
        || a.id.localeCompare(b.id),
    );
  }

  /** The first playable level of the lowest-numbered episode. '' when empty. */
  firstPlayableId(): string {
    for (const l of this.all()) if (l.validation.ok || this.allowInvalid) return l.id;
    return '';
  }

  /** Resolve a requested id to something that can actually be played. */
  resolveId(requested: string): string {
    const id = sanitiseContentId(requested);
    if (id.length > 0) {
      const l = this.byId.get(id);
      if (l !== null && l !== undefined && (l.validation.ok || this.allowInvalid)) return id;
    }
    return this.firstPlayableId();
  }

  /** What the exit points at, resolved and validated. '' ends the episode. */
  nextLevelId(id: string): string {
    const l = this.get(id);
    if (l === null || l.level.exit === null) return '';
    const next = sanitiseContentId(l.level.exit.nextLevelId);
    if (next.length === 0) return '';
    const target = this.byId.get(next);
    return target !== undefined && (target.validation.ok || this.allowInvalid) ? next : '';
  }

  manifest(): LevelManifest {
    if (this.manifestCache === null) {
      this.manifestCache = buildManifest(this.all().map((l) => l.entry), this.clock());
    }
    return this.manifestCache;
  }

  manifestJson(): string {
    if (this.manifestJsonCache === null) this.manifestJsonCache = JSON.stringify(this.manifest());
    return this.manifestJsonCache;
  }

  /** Totals at a specific skill, for the intermission denominators. */
  totalsFor(id: string, skill: number): { enemies: number; items: number; secrets: number } | null {
    const level = this.getPlayable(id);
    return level === null ? null : levelTotals(level, skill);
  }

  /* --- world integration -------------------------------------------------- */

  /**
   * Stamp a level's sections into a live world. Returns null when the level is
   * unknown or unplayable, so a caller cannot accidentally start a room on a
   * map with an unreachable exit.
   */
  applyTo(id: string, world: LevelWorldTarget): LevelApplyResult | null {
    const level = this.getPlayable(id);
    if (level === null) return null;
    return applyLevelToWorld(level, world, WORLD_MIN_BLOCK_X, WORLD_MIN_BLOCK_Z, WORLD_SIZE_BLOCKS);
  }

  /**
   * `ContentResolver.levelFor` — hand a room the level so it can simulate it.
   *
   * Everything is already in memory (the whole campaign is loaded at boot), so
   * there is no `requestLevel` to go with it: a level this server has is a
   * level a room can have synchronously, inside `applyPlan`.
   */
  levelFor(id: string): Level | null {
    return this.getPlayable(id);
  }

  /** Where a player should appear in this level. Null when unknown. */
  spawnFor(id: string): { x: number; y: number; z: number; yaw: number } | null {
    const level = this.getPlayable(id);
    if (level === null) return null;
    const s = primarySpawn(level);
    return { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
  }

  /* --- HTTP ---------------------------------------------------------------- */

  /**
   * Route a request. Returns null when the path is not ours, so `index.ts` can
   * fall through to the static handler.
   *
   *   GET /api/levels               the manifest
   *   GET /api/levels/<id>          one entry plus its validation report
   *   GET /api/levels/<id>/data     the .dcl bytes (ETag = content hash)
   *   GET /api/levels/<id>/source   the authoring JSON, when the level came from one
   */
  handle(pathname: string, method: string, ifNoneMatch?: string): LevelHttpResponse | null {
    if (pathname !== '/api/levels' && !pathname.startsWith('/api/levels/')) return null;
    if (method !== 'GET' && method !== 'HEAD') {
      return jsonResponse(405, { error: 'method not allowed' });
    }

    if (pathname === '/api/levels' || pathname === '/api/levels/') {
      return {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        },
        body: this.manifestJson(),
      };
    }

    const rest = pathname.slice('/api/levels/'.length);
    const slash = rest.indexOf('/');
    const rawId = slash < 0 ? rest : rest.slice(0, slash);
    const tail = slash < 0 ? '' : rest.slice(slash + 1);
    const id = sanitiseContentId(decodeURIComponentSafe(rawId));
    if (id.length === 0) return jsonResponse(400, { error: 'bad level id' });

    const loaded = this.byId.get(id);
    if (loaded === undefined) return jsonResponse(404, { error: 'no such level', id });

    if (tail === '') {
      return jsonResponse(200, {
        entry: loaded.entry,
        playable: loaded.validation.ok || this.allowInvalid,
        errors: loaded.validation.errors,
        warnings: loaded.validation.warnings,
        reach: loaded.validation.reach,
        source: loaded.fromSource,
      });
    }

    if (tail === 'data') {
      if (!loaded.validation.ok && !this.allowInvalid) {
        return jsonResponse(409, {
          error: 'level failed validation and will not be served',
          id,
          errors: loaded.validation.errors,
        });
      }
      const etag = `"${loaded.contentHash.toString(16)}"`;
      if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
        return { status: 304, headers: { etag, 'access-control-allow-origin': '*' }, body: '' };
      }
      return {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(loaded.bytes.length),
          'cache-control': 'public, max-age=300',
          etag,
          'x-doomcraft-level': id,
          'access-control-allow-origin': '*',
        },
        body: loaded.bytes,
      };
    }

    if (tail === 'source') {
      if (loaded.source === null) return jsonResponse(404, { error: 'this level ships as binary only', id });
      return {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        },
        body: loaded.source,
      };
    }

    return jsonResponse(404, { error: 'no such level resource', id, resource: tail });
  }
}

/* ------------------------------------------------------------------------ *
 * HTTP plumbing (framework free)
 * ------------------------------------------------------------------------ */

export interface LevelHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

function jsonResponse(status: number, body: unknown): LevelHttpResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function decodeURIComponentSafe(v: string): string {
  try { return decodeURIComponent(v); } catch { return ''; }
}

/* ------------------------------------------------------------------------ *
 * Process-wide instance
 * ------------------------------------------------------------------------ */

let shared: LevelLibrary | null = null;

/** The library `index.ts` and the rooms share. Loaded on first use. */
export function levelLibrary(options?: LevelLibraryOptions): LevelLibrary {
  if (shared === null) {
    shared = new LevelLibrary(options);
    shared.load();
  }
  return shared;
}

/** Drop the shared library, for tests. */
export function resetLevelLibrary(): void { shared = null; }
