/**
 * DOOMCRAFT — content-addressed creative storage (docs/SPONSORS.md §2.2,
 * the OPERATOR lane).
 *
 * What §2.2 specifies in full is the self-serve battery: a separate CDN
 * origin, sandboxed re-encode, OCR, classifiers. None of that is buildable
 * before the accounts and the domain exist, and none of it is needed while
 * the only writer is the operator over the audited admin surface (Rule B —
 * the same reduction PACKS §9 made in writing for the Studio). What ships
 * here is the part that is structural rather than defensive-in-depth:
 *
 *  - **Content address is the only address.** A creative is stored at
 *    `creatives/<sha256>.<ext>` and served at `/cdn/crv/<sha256>.<ext>`;
 *    there is no mutable URL and no in-place edit, so approve-then-swap is
 *    impossible by construction (§2.2 stage 3).
 *  - **The real MIME, from magic bytes.** The extension is never trusted;
 *    SVG and HTML have no magic that passes and are refused outright.
 *  - **Static means static.** Animated PNG (`acTL`) and animated WebP
 *    (VP8X animation bit) are refused for the display/image kinds.
 *  - **Exact sizes.** A display creative must be exactly one of the four
 *    IAB slot sizes; declared dimensions are read from the file's own
 *    header, never from the operator.
 *
 * Stated deviation, in writing: the files are served from THIS origin under
 * `/cdn/crv/` until a real CDN domain exists (blocked on the user's domain,
 * HANDOVER §5). "The game document never hosts a sponsor byte" therefore
 * holds for markup — creatives render as `<img src>` only — but not yet for
 * the origin itself.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------------ *
 * Header sniffing — pure, testable, no decoder
 * ------------------------------------------------------------------------ */

export interface SniffedImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
  animated: boolean;
}

/** The real format from magic bytes, or null. Null covers SVG/HTML by construction. */
export function sniffImage(bytes: Buffer): SniffedImage | null {
  if (bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    // PNG: IHDR is always the first chunk; acTL anywhere marks an APNG.
    return {
      mime: 'image/png', ext: 'png',
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
      animated: bytes.includes('acTL', 8, 'latin1'),
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // JPEG: walk segments to the first SOF marker carrying the frame size.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = bytes.readUInt16BE(i + 2);
      if (len < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          mime: 'image/jpeg', ext: 'jpg',
          height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7),
          animated: false,
        };
      }
      i += 2 + len;
    }
    return null;
  }
  if (bytes.length >= 30
    && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      // Extended header: canvas size is 24-bit little-endian minus one;
      // bit 1 of the flags byte is ANIMATION.
      const flags = bytes[20];
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { mime: 'image/webp', ext: 'webp', width: w, height: h, animated: (flags & 0x02) !== 0 };
    }
    if (chunk === 'VP8 ') {
      // Lossy: the frame header sits 3 bytes into the chunk payload after the
      // 3-byte frame tag and the 3-byte start code a4..a6 = 9d 01 2a.
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return {
        mime: 'image/webp', ext: 'webp',
        width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff,
        animated: false,
      };
    }
    if (chunk === 'VP8L') {
      const b = bytes.readUInt32LE(21);
      return {
        mime: 'image/webp', ext: 'webp',
        width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff),
        animated: false,
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * The §2.2 limits for the two kinds an operator can upload today
 * ------------------------------------------------------------------------ */

/** Exact slot sizes a `display` creative may be (§2.2 table). */
export const DISPLAY_SIZES: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [728, 90], [300, 250], [320, 50], [320, 100],
]);

export const DISPLAY_MAX_BYTES = 150 * 1024;
export const IMAGE_MAX_BYTES = 400 * 1024;

export type UploadKind = 'display' | 'image';

export interface CreativeRefusal { ok: false; status: number; error: string }
export interface CreativeAccepted {
  ok: true;
  sha256: string;
  url: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

/** Everything except the write: pure, so every refusal is provable in a runner. */
export function vetUpload(bytes: Buffer, kind: UploadKind): CreativeRefusal | (CreativeAccepted & { ext: string }) {
  if (bytes.length === 0) return { ok: false, status: 400, error: 'empty upload' };
  const sniffed = sniffImage(bytes);
  if (sniffed === null) {
    return { ok: false, status: 415, error: 'not a static PNG/JPEG/WebP — the real format is read from magic bytes, and SVG/HTML are refused outright (§2.2)' };
  }
  if (sniffed.animated) {
    return { ok: false, status: 415, error: `${sniffed.ext} is animated — display and image creatives are static only (§2.2)` };
  }
  if (kind === 'image' && sniffed.mime === 'image/jpeg') {
    return { ok: false, status: 415, error: 'kind image accepts PNG/WebP only (§2.2)' };
  }
  const cap = kind === 'display' ? DISPLAY_MAX_BYTES : IMAGE_MAX_BYTES;
  if (bytes.length > cap) {
    return { ok: false, status: 413, error: `${bytes.length} bytes > the ${cap} cap for kind ${kind} (§2.2)` };
  }
  if (kind === 'display'
    && !DISPLAY_SIZES.some(([w, h]) => w === sniffed.width && h === sniffed.height)) {
    return {
      ok: false, status: 422,
      error: `display must be exactly one of ${DISPLAY_SIZES.map(([w, h]) => `${w}x${h}`).join(', ')} — this file is ${sniffed.width}x${sniffed.height} by its own header`,
    };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    ok: true, sha256, ext: sniffed.ext,
    url: `/cdn/crv/${sha256}.${sniffed.ext}`,
    mime: sniffed.mime, bytes: bytes.length,
    width: sniffed.width, height: sniffed.height,
  };
}

/* ------------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------------ */

const EXTS = ['png', 'jpg', 'webp'] as const;
const MIME_FOR_EXT: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp',
});

export class CreativeStore {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = join(dataRoot.replace(/\/+$/, ''), 'creatives');
  }

  /** Vet and persist. Same bytes → same address; a different file is a different address. */
  put(bytes: Buffer, kind: UploadKind): CreativeRefusal | CreativeAccepted {
    const vetted = vetUpload(bytes, kind);
    if (!vetted.ok) return vetted;
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${vetted.sha256}.${vetted.ext}`);
    if (!existsSync(file)) writeFileSync(file, bytes);
    const { ext: _ext, ...accepted } = vetted;
    return accepted;
  }

  /** The servable file for a content hash, or null. The hash is the whole key. */
  resolve(sha256: string): { path: string; mime: string; url: string } | null {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    for (const ext of EXTS) {
      const path = join(this.dir, `${sha256}.${ext}`);
      if (existsSync(path)) return { path, mime: MIME_FOR_EXT[ext], url: `/cdn/crv/${sha256}.${ext}` };
    }
    return null;
  }

  /** `/cdn/crv/<sha>.<ext>` for an uploaded hash, or null when nothing is stored. */
  urlFor(sha256: string): string | null {
    return this.resolve(sha256)?.url ?? null;
  }

  /**
   * URL plus the dimensions read from the stored file's OWN header — never
   * from the booking document, which is operator-typed and can drift from
   * the bytes. Cached; the store is content-addressed so a hash's answer
   * can never change.
   */
  info(sha256: string): { url: string; width: number; height: number } | null {
    const cached = this.infoCache.get(sha256);
    if (cached !== undefined) return cached;
    const hit = this.resolve(sha256);
    let out: { url: string; width: number; height: number } | null = null;
    if (hit !== null) {
      try {
        const sniffed = sniffImage(readFileSync(hit.path));
        if (sniffed !== null) out = { url: hit.url, width: sniffed.width, height: sniffed.height };
      } catch { /* an unreadable file is an absent file */ }
    }
    this.infoCache.set(sha256, out);
    return out;
  }

  private readonly infoCache = new Map<string, { url: string; width: number; height: number } | null>();

  /** For the console: what the store holds. */
  list(): { sha256: string; ext: string; bytes: number }[] {
    if (!existsSync(this.dir)) return [];
    const out: { sha256: string; ext: string; bytes: number }[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      const m = /^([0-9a-f]{64})\.(png|jpg|webp)$/.exec(name);
      if (m === null) continue;
      out.push({ sha256: m[1], ext: m[2], bytes: statSync(join(this.dir, name)).size });
    }
    return out;
  }
}
