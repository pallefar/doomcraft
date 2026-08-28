/**
 * DOOMCRAFT — §2.2's door, proven refusal by refusal. Every buffer here is a
 * hand-built header, because the sniffer reads headers and nothing else —
 * what matters is that the REAL magic bytes decide, never the extension or
 * the operator's word.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CreativeStore, DISPLAY_MAX_BYTES, sniffImage, vetUpload } from './creatives.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-crv-'));
  tempDirs.push(d);
  return d;
}

/* --- header builders ---------------------------------------------------- */

function png(width: number, height: number, apng = false): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = 6;
  if (apng) b.write('acTL', 40, 'latin1');
  return b;
}

function jpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  let i = 0;
  b[i++] = 0xff; b[i++] = 0xd8;                       // SOI
  b[i++] = 0xff; b[i++] = 0xe0; b.writeUInt16BE(16, i); i += 16;  // APP0
  b[i++] = 0xff; b[i++] = 0xc0; b.writeUInt16BE(17, i);           // SOF0
  b[i + 2] = 8;
  b.writeUInt16BE(height, i + 3);
  b.writeUInt16BE(width, i + 5);
  return b;
}

function webpX(width: number, height: number, animated = false): Buffer {
  const b = Buffer.alloc(48);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(40, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b[20] = animated ? 0x02 : 0x00;
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/* --- the sniffer --------------------------------------------------------- */

describe('sniffImage reads the file, not the label', () => {
  it('PNG, JPEG and WebP report their own header dimensions', () => {
    expect(sniffImage(png(728, 90))).toMatchObject({ ext: 'png', width: 728, height: 90, animated: false });
    expect(sniffImage(jpeg(300, 250))).toMatchObject({ ext: 'jpg', width: 300, height: 250 });
    expect(sniffImage(webpX(320, 50))).toMatchObject({ ext: 'webp', width: 320, height: 50, animated: false });
  });

  it('SVG and HTML have no magic that passes — refused outright', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
  });

  it('animation is read from the container: APNG acTL, WebP VP8X bit 1', () => {
    expect(sniffImage(png(728, 90, true))?.animated).toBe(true);
    expect(sniffImage(webpX(728, 90, true))?.animated).toBe(true);
  });
});

/* --- the vet -------------------------------------------------------------- */

describe('vetUpload holds the §2.2 line', () => {
  it('a display creative must be EXACTLY an IAB slot size, by its own header', () => {
    expect(vetUpload(png(728, 90), 'display').ok).toBe(true);
    const off = vetUpload(png(729, 90), 'display');
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error).toContain('729x90');
  });

  it('animated is refused for both kinds; jpeg is refused for kind image', () => {
    expect(vetUpload(png(728, 90, true), 'display').ok).toBe(false);
    expect(vetUpload(webpX(320, 50, true), 'display').ok).toBe(false);
    expect(vetUpload(jpeg(100, 100), 'image').ok).toBe(false);
  });

  it('the byte caps hold', () => {
    const fat = Buffer.concat([png(728, 90), Buffer.alloc(DISPLAY_MAX_BYTES)]);
    expect(vetUpload(fat, 'display').ok).toBe(false);
  });
});

/* --- the store ------------------------------------------------------------ */

describe('the content address is the only address', () => {
  it('put → resolve round-trips, and the URL is the sha256 of the bytes', () => {
    const store = new CreativeStore(tempDir());
    const bytes = png(728, 90);
    const put = store.put(bytes, 'display');
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(put.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(put.url).toBe(`/cdn/crv/${put.sha256}.png`);
    expect(store.resolve(put.sha256)?.mime).toBe('image/png');
    // info() reads the dimensions back from the stored file's own header.
    expect(store.info(put.sha256)).toEqual({ url: put.url, width: 728, height: 90 });
  });

  it('a hash nothing was stored for resolves to null, and a malformed hash never touches disk', () => {
    const store = new CreativeStore(tempDir());
    expect(store.resolve('ab'.repeat(32))).toBeNull();
    expect(store.resolve('../../../etc/passwd')).toBeNull();
    expect(store.info('ab'.repeat(32))).toBeNull();
  });
});
