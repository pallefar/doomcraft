/**
 * DOOMCRAFT — the share card: a real PNG (decoded, not just signature-
 * sniffed), deterministic bytes, and THE S36 RULE proven at the pixel
 * level — a sponsor lockup changes NOTHING above the bottom strip, and an
 * ad-free card (empty lockup) still renders the house wordmark there.
 */

import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  CARD_H, CARD_W, LOCKUP_H,
  encodePng, renderShareCard, textWidth,
} from './shareCard.js';

/** Parse the one-IDAT PNG this encoder writes back into raw RGB rows. */
function decode(png: Buffer): { w: number; h: number; px: Uint8Array } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let at = 8;
  let w = 0, h = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(2);
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    at += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat));
  expect(rows.length).toBe(h * (w * 3 + 1));
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    expect(rows[y * (w * 3 + 1)]).toBe(0);   // filter: none
    px.set(rows.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
  }
  return { w, h, px };
}

const INPUT = {
  name: 'Marine', modeName: 'Deathmatch',
  headline: '18 KILLS · VICTORY', subline: '+320 XP · +41 SCRAP · 6:12 PLAYED',
  refCode: 'RF3XK2QZ', host: 'doomcraft.vercel.app', lockupText: '',
};

describe('the card', () => {
  it('is a decodable 1200×630 truecolour PNG, deterministic to the byte', () => {
    const a = renderShareCard(INPUT);
    const b = renderShareCard(INPUT);
    expect(a.equals(b)).toBe(true);
    const img = decode(a);
    expect(img.w).toBe(CARD_W);
    expect(img.h).toBe(CARD_H);
    // Not a blank rectangle: the accent band is there and ink was laid.
    expect(img.px[0]).toBe(0xf0);
    let inked = 0;
    for (let i = 0; i < img.px.length; i += 3) if (img.px[i] > 0xd0) inked++;
    expect(inked).toBeGreaterThan(2_000);
  });

  it('THE S36 RULE: a lockup changes no pixel above the bottom strip', () => {
    const bare = decode(renderShareCard(INPUT));
    const sponsored = decode(renderShareCard({ ...INPUT, lockupText: 'MEGACORP · PLAY FREE' }));
    const gameplayBytes = (CARD_H - LOCKUP_H) * CARD_W * 3;
    expect(Buffer.from(sponsored.px.subarray(0, gameplayBytes))
      .equals(Buffer.from(bare.px.subarray(0, gameplayBytes)))).toBe(true);
    // And it DID change the strip — the test must be able to fail.
    expect(Buffer.from(sponsored.px.subarray(gameplayBytes))
      .equals(Buffer.from(bare.px.subarray(gameplayBytes)))).toBe(false);
    // The strip is inside the 12% cap.
    expect(LOCKUP_H / CARD_H).toBeLessThanOrEqual(0.12);
  });

  it('the ad-free card still carries the house wordmark in the strip', () => {
    const img = decode(renderShareCard(INPUT));
    const stripStart = (CARD_H - LOCKUP_H) * CARD_W * 3;
    let inkedInStrip = 0;
    for (let i = stripStart; i < img.px.length; i += 3) if (img.px[i] > 0x60) inkedInStrip++;
    expect(inkedInStrip).toBeGreaterThan(100);
  });

  it('hostile input cannot break the renderer: junk glyphs, huge strings, empty code', () => {
    const png = renderShareCard({
      name: '≈≈≈\n<script>alert(1)</script>'.repeat(20),
      modeName: 'x'.repeat(500),
      headline: '💀'.repeat(100),
      subline: '',
      refCode: '',
      host: 'h'.repeat(300),
      lockupText: 'l'.repeat(300),
    });
    const img = decode(png);
    expect(img.w).toBe(CARD_W);
  });

  it('textWidth and encodePng hold their contracts', () => {
    expect(textWidth('', 4)).toBe(0);
    expect(textWidth('AB', 2)).toBe((2 * 6 - 1) * 2);
    const tiny = encodePng({ w: 2, h: 2, px: new Uint8Array(12).fill(0x80) });
    const img = decode(tiny);
    expect(img.w).toBe(2);
    expect(img.px[0]).toBe(0x80);
  });
});
