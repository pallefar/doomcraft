/**
 * The durability layer, pinned.
 *
 * Every test here corresponds to a claim that HANDOVER.md §6 recorded as
 * "raised but never verified" — and that two independent verification passes
 * (a Claude fan-out and a Codex run) then confirmed against this source. Each
 * one was proven red with its fix reverted; the reverts are named in the test
 * bodies so the next person can repeat the proof cheaply.
 */
import { describe, expect, it } from 'vitest';
import { JsonFileStore, createProfile, isMissingFile } from './persistence.js';
import type { FsLike } from './persistence.js';

function enoent(): NodeJS.ErrnoException {
  const e = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  return e;
}

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/**
 * A fake volume with per-path failure injection. `readFail`/`writeFail` name a
 * path SUFFIX so a test can break exactly one profile and leave the rest of the
 * volume healthy — which is the shape the real incident had (one root-owned
 * shard directory, everything else fine).
 */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const readFail = new Map<string, NodeJS.ErrnoException>();
  const writeFail = new Map<string, NodeJS.ErrnoException>();
  const renamed: string[] = [];
  const fs: FsLike = {
    async mkdir(): Promise<unknown> { return undefined; },
    async readFile(path: string): Promise<string> {
      for (const [suffix, err] of readFail) if (path.endsWith(suffix)) throw err;
      const t = files.get(path);
      if (t === undefined) throw enoent();
      return t;
    },
    async writeFile(path: string, data: string): Promise<void> {
      for (const [suffix, err] of writeFail) if (path.endsWith(suffix)) throw err;
      files.set(path, data);
    },
    async rename(from: string, to: string): Promise<void> {
      const v = files.get(from);
      if (v === undefined) throw enoent();
      files.set(to, v);
      files.delete(from);
      renamed.push(to);
    },
    async readdir(): Promise<string[]> { return []; },
  };
  return { fs, files, readFail, writeFail, renamed };
}

function store(fs: FsLike): JsonFileStore {
  const s = new JsonFileStore('/fake', 0);
  (s as unknown as { fs: FsLike }).fs = fs;
  return s;
}

const DEVICE = 'devabc';
const PATH = '/fake/profiles/de/devabc.json';

/** A real, valuable profile sitting on disk. */
function richProfile(): string {
  const p = createProfile(DEVICE);
  p.progress.xp = 41_000;
  p.economy.scrap = 9_999;
  p.accountId = 'acct-1';
  p.accountSecret = 'secret-1';
  return JSON.stringify(p);
}

describe('isMissingFile discriminates errno, not message', () => {
  it('is true ONLY for a real ENOENT errno', () => {
    expect(isMissingFile(enoent())).toBe(true);
    expect(isMissingFile(errno('EACCES'))).toBe(false);
    expect(isMissingFile(errno('EIO'))).toBe(false);
    // The trap this guards: a fake that merely SAYS ENOENT is not an ENOENT.
    expect(isMissingFile(new Error('ENOENT'))).toBe(false);
  });
});

describe('a present-but-unreadable profile is never overwritten', () => {
  /**
   * RED WITHOUT THE FIX: revert `loadLocked`'s errno split (catch everything and
   * `return null`). `ensureLocked` then mints a blank, marks it dirty, and the
   * flush renames it over the real file — this expectation flips to a blank.
   */
  it('survives EACCES: the rich bytes stay on disk, no blank is written', async () => {
    const v = fakeFs({ [PATH]: richProfile() });
    v.readFail.set('devabc.json', errno('EACCES'));
    const s = store(v.fs);

    const p = await s.ensure(DEVICE);
    // The session still works — the player is not thrown out of their match.
    expect(p.deviceId).toBe(DEVICE);
    expect(p.economy.scrap).toBe(0);

    await s.flush();
    await s.close();

    // But the DISK still holds the real profile, untouched.
    const onDisk = JSON.parse(v.files.get(PATH) ?? '{}') as { economy?: { scrap?: number } };
    expect(onDisk.economy?.scrap).toBe(9_999);
    expect(v.renamed).not.toContain(PATH);
    expect(s.degraded).toBe(true);
    expect(s.quarantined()).toContain(DEVICE);
  });

  /**
   * RED WITHOUT THE FIX: revert the non-object guard in `loadLocked`.
   * `migrateProfile(null)` returns a FULLY BLANK profile that looks like a
   * successful read — it does not even take the catch — so the store caches it,
   * marks it dirty, and writes the blank back with no error anywhere.
   */
  it('survives corruption that PARSES: `null` is not a profile', async () => {
    const v = fakeFs({ [PATH]: 'null' });
    const s = store(v.fs);

    await s.ensure(DEVICE);
    await s.flush();

    expect(v.files.get(PATH)).toBe('null');
    expect(s.quarantined()).toContain(DEVICE);
  });

  it('still mints a genuinely new player on a real ENOENT', async () => {
    const v = fakeFs();
    const s = store(v.fs);
    await s.ensure('newdev');
    await s.flush();
    expect(v.files.has('/fake/profiles/ne/newdev.json')).toBe(true);
    expect(s.quarantined()).toEqual([]);
  });
});

describe('a failed write stays dirty and is retried', () => {
  /**
   * RED WITHOUT THE FIX: restore `this.dirty.clear()` before the write loop.
   * The id is gone from `dirty` the moment the flush starts, so the recovered
   * volume is never written to and the payout dies at exit.
   */
  it('re-writes a profile whose first flush failed, once the disk recovers', async () => {
    const v = fakeFs();
    const s = store(v.fs);

    const p = await s.ensure(DEVICE);
    p.economy.scrap = 500;
    await s.save(p);

    v.writeFail.set('devabc.json.tmp', errno('EACCES'));
    await s.flush();

    expect(v.files.has(PATH)).toBe(false);
    expect(s.degraded).toBe(true);
    // The crucial property: it is STILL owed.
    expect(s.unflushed).toBe(1);

    v.writeFail.clear();
    await s.flush();

    const onDisk = JSON.parse(v.files.get(PATH) ?? '{}') as { economy?: { scrap?: number } };
    expect(onDisk.economy?.scrap).toBe(500);
    expect(s.unflushed).toBe(0);
  });

  /**
   * RED WITHOUT THE FIX: restore the `dirty.clear()` in the `ready()` catch.
   * A store that cannot reach the disk at all used to DISCARD every pending
   * payout rather than hold it.
   */
  it('holds the dirty set when the volume cannot be reached at all', async () => {
    const s = new JsonFileStore('/fake', 0);
    // No `fs` injected and `ready()` will try a real import against /fake —
    // force the failure deterministically instead.
    (s as unknown as { ready: () => Promise<FsLike> }).ready = () => Promise.reject(errno('EIO'));
    const p = createProfile(DEVICE);
    p.economy.scrap = 77;
    await s.save(p);
    await s.flush();
    expect(s.degraded).toBe(true);
    expect(s.unflushed).toBe(1);
  });
});

describe('close() is a real barrier', () => {
  /**
   * RED WITHOUT THE FIX: revert `flush()` to `if (dirty.size === 0) return;
   * return this.flushOnce();`. Because an id now stays dirty until its rename
   * lands, a second caller sees it still there and starts a SECOND write of the
   * same `.tmp` path while the first is in the air — two writers, two renames,
   * racing over one temp file. The join is what serialises them.
   */
  it('a second flush joins the one in flight instead of racing it', async () => {
    const v = fakeFs();
    let inFlight = 0;
    let overlapped = false;
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const racy: FsLike = {
      ...v.fs,
      async writeFile(path: string, data: string): Promise<void> {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await gate;
        await v.fs.writeFile(path, data, 'utf8');
        inFlight--;
      },
    };
    const s = store(racy);

    const p = await s.ensure(DEVICE);
    p.economy.scrap = 123;
    await s.save(p);

    const first = s.flush();
    const second = s.flush();
    release();
    await Promise.all([first, second]);

    expect(overlapped).toBe(false);
    expect(v.files.has(PATH)).toBe(true);
    expect(s.unflushed).toBe(0);
  });

  /**
   * RED WITHOUT THE FIX: restore `if (this.closed) return;` at the top of
   * `markDirty`. A settlement that lands microseconds after the drain closed the
   * store was dropped in total silence — no counter, no log, no dirty entry.
   */
  it('a write that lands after close() is COUNTED, not silently discarded', async () => {
    const v = fakeFs();
    const s = store(v.fs);
    await s.close();

    const p = createProfile(DEVICE);
    p.economy.scrap = 42;
    await s.save(p);

    expect(s.postCloseWrites).toBe(1);
    expect(s.unflushed).toBe(1);
  });
});
