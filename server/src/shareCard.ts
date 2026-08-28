/**
 * DOOMCRAFT — the share card: a server-rendered 1200×630 PNG from match
 * data (docs/ECONOMY.md "Viral sharing"; docs/SPONSORS.md S36). The
 * referral loop is live but had no shareable artefact — this is the
 * artefact.
 *
 * Zero dependencies BY DESIGN: the PNG is written by hand (IHDR/IDAT/IEND
 * over `node:zlib`), the text is a 5×7 pixel font scaled in integer steps
 * — which is not a compromise, it is the voxel game's own aesthetic on the
 * card. Server CPU only, no client frames (S36's budget column).
 *
 * THE S36 RULE, enforced by construction: everything third-party lives in
 * `lockupText`, drawn ONLY inside the bottom strip (`LOCKUP_H` = 72 px =
 * 11.4% of the card, under the ≤12% cap), and the caller passes '' for an
 * ad-free player — that player is doing us a favour; the house wordmark is
 * all their card carries. `shareCard.test.ts` proves the strip: rendering
 * with and without a lockup differs in no pixel above `H - LOCKUP_H`.
 */

import { deflateSync } from 'node:zlib';

export const CARD_W = 1200;
export const CARD_H = 630;
/** 72 / 630 = 11.4% — inside S36's 12% cap, always the bottom strip. */
export const LOCKUP_H = 72;

/* ------------------------------------------------------------------------ *
 * The 5×7 font — uppercase, digits, and the card's punctuation
 * ------------------------------------------------------------------------ */

/** Each glyph: 7 rows, 5 bits per row, MSB left. */
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  '·': [0, 0, 0x0c, 0x0c, 0, 0, 0],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
  '=': [0, 0, 0x1f, 0, 0x1f, 0, 0],
  ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
};

/** Advance = 5 px glyph + 1 px gap, times scale. */
export function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : (text.length * 6 - 1) * scale;
}

/* ------------------------------------------------------------------------ *
 * A tiny RGB canvas
 * ------------------------------------------------------------------------ */

export class Raster {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number) {
    this.px = new Uint8Array(w * h * 3);
  }

  fill(x0: number, y0: number, w: number, h: number, rgb: number): void {
    const r = (rgb >>> 16) & 0xff, g = (rgb >>> 8) & 0xff, b = rgb & 0xff;
    const x1 = Math.min(this.w, x0 + w), y1 = Math.min(this.h, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      let i = (y * this.w + Math.max(0, x0)) * 3;
      for (let x = Math.max(0, x0); x < x1; x++) {
        this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b;
        i += 3;
      }
    }
  }

  /** Uppercases; unknown glyphs render as blanks rather than throwing. */
  text(x: number, y: number, s: string, scale: number, rgb: number): void {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const rows = GLYPHS[ch];
      if (rows !== undefined) {
        for (let ry = 0; ry < 7; ry++) {
          for (let rx = 0; rx < 5; rx++) {
            if (((rows[ry] >> (4 - rx)) & 1) === 1) {
              this.fill(cx + rx * scale, y + ry * scale, scale, scale, rgb);
            }
          }
        }
      }
      cx += 6 * scale;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * PNG encoding — IHDR + one IDAT + IEND, filter 0 rows
 * ------------------------------------------------------------------------ */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

export function encodePng(raster: { w: number; h: number; px: Uint8Array }): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(raster.w, 0);
  ihdr.writeUInt32BE(raster.h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  const rows = Buffer.alloc(raster.h * (raster.w * 3 + 1));
  for (let y = 0; y < raster.h; y++) {
    const at = y * (raster.w * 3 + 1);
    rows[at] = 0;   // filter: none
    rows.set(raster.px.subarray(y * raster.w * 3, (y + 1) * raster.w * 3), at + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/* ------------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------------ */

export interface ShareCardInput {
  /** Display name; clamped and uppercased by the renderer. */
  name: string;
  /** 'DEATHMATCH' | 'QUEST' | 'HORDE' | ... — the mode's display name. */
  modeName: string;
  /** The headline stat line, already composed: '18 KILLS · 4 DEATHS'. */
  headline: string;
  /** A second, quieter line: '+320 XP · +41 SCRAP', or ''. */
  subline: string;
  /** The player's referral code, or '' when referrals are unavailable. */
  refCode: string;
  /** Where the card points, no scheme: 'doomcraft.vercel.app'. */
  host: string;
  /**
   * S36: the sponsor lockup, bottom strip ONLY. '' for an ad-free player —
   * their card carries the house wordmark and nothing else.
   */
  lockupText: string;
}

const BG = 0x101014;
const PANEL = 0x1a1a20;
const ACCENT = 0xf0a020;
const INK = 0xe8e6e3;
const DIM = 0x8a857f;
const STRIP = 0x0a0a0d;

function clampText(s: string, max: number): string {
  const t = s.replace(/[\r\n]/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…`.replace('…', '') : t;
}

/** Deterministic: same input, same bytes — the test relies on it. */
export function renderShareCard(input: ShareCardInput): Buffer {
  const c = new Raster(CARD_W, CARD_H);
  c.fill(0, 0, CARD_W, CARD_H, BG);

  // A faint voxel grid, so the card reads as the game and not a slide.
  for (let gy = 0; gy < CARD_H; gy += 42) c.fill(0, gy, CARD_W, 1, 0x16161b);
  for (let gx = 0; gx < CARD_W; gx += 42) c.fill(gx, 0, 1, CARD_H, 0x16161b);

  // Top accent band + wordmark.
  c.fill(0, 0, CARD_W, 10, ACCENT);
  c.text(48, 44, 'DOOMCRAFT', 6, INK);
  const mode = clampText(input.modeName, 18);
  c.text(CARD_W - 48 - textWidth(mode, 4), 52, mode, 4, ACCENT);

  // The player and what they did.
  c.text(48, 150, clampText(input.name, 20), 5, DIM);
  c.text(48, 220, clampText(input.headline, 24), 8, INK);
  if (input.subline.length > 0) c.text(48, 310, clampText(input.subline, 34), 4, ACCENT);

  // The call to action: the code IS the loop.
  const code = clampText(input.refCode, 10);
  if (code.length > 0) {
    const boxW = Math.max(300, textWidth(code, 8) + 64);
    const boxX = CARD_W - 48 - boxW;
    c.fill(boxX, 392, boxW, 118, PANEL);
    c.fill(boxX, 392, boxW, 4, ACCENT);
    c.text(boxX + 32, 412, 'PLAY WITH ME', 3, DIM);
    c.text(boxX + 32, 444, code, 8, INK);
    // Scale 3 keeps the longest host/?REF=CODE clear of the code box.
    c.text(48, 460, clampText(`${input.host}/?REF=${code}`, 40), 3, INK);
  } else {
    c.text(48, 460, clampText(input.host, 40), 3, INK);
  }

  // S36: the bottom strip, and nothing third-party above it — ever.
  c.fill(0, CARD_H - LOCKUP_H, CARD_W, LOCKUP_H, STRIP);
  c.fill(0, CARD_H - LOCKUP_H, CARD_W, 2, 0x26262c);
  c.text(48, CARD_H - LOCKUP_H + 24, 'DOOMCRAFT · FREE IN THE BROWSER', 3, DIM);
  const lockup = clampText(input.lockupText, 36);
  if (lockup.length > 0) {
    c.text(CARD_W - 48 - textWidth(lockup, 3), CARD_H - LOCKUP_H + 24, lockup, 3, INK);
  }

  return encodePng(c);
}
