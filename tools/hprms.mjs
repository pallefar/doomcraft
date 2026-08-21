/**
 * DOOMCRAFT — high-pass surface-detail metric.
 *
 * The one number this whole texture round is judged on: the RMS of a 3x3
 * high-pass residual, in ABSOLUTE 8-bit grey levels, over a matched flat patch.
 *
 *     residual(x,y) = I(x,y) - mean(3x3 neighbourhood centred on x,y)
 *     score         = sqrt(mean(residual^2))
 *
 * Why this operator and not a variance or a stddev: it is exactly zero on any
 * LINEAR ramp, so a lit wall's falloff, a fog gradient and a sky gradient all
 * score 0.000 while real surface texture does not. That property is what makes
 * "the bar's sky scores 0.000" a meaningful calibration rather than a
 * coincidence, and it is why a patch does not have to be perfectly uniform to
 * be usable.
 *
 * Absolute levels, not Weber contrast, is the entire point of the exercise: a
 * percentage modulation of a dark albedo lands under one grey level and the
 * texture is present in the maths and absent on the screen.
 *
 * Exports a dependency-free 8-bit PNG reader so the same code measures a
 * reference capture from disk and our own readPixels buffer from the GPU.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ *
 * Minimal PNG reader — 8-bit, non-interlaced, greyscale / RGB / RGBA.
 * ------------------------------------------------------------------ */

export function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);

  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null;
  let trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`${file}: only 8-bit PNGs (got ${depth})`);
  if (interlace !== 0) throw new Error(`${file}: interlaced PNGs unsupported`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`${file}: colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = src;
    src += stride;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= channels && y > 0 ? out[up + x - channels] : 0;
      const v = raw[row + x];
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${file}: bad row filter ${filter}`);
      }
      out[dst + x] = r & 0xff;
    }
  }

  // Normalise everything to RGBA8.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else {
      const p = out[i] * 3;
      r = palette[p]; g = palette[p + 1]; b = palette[p + 2];
      if (trns !== null && out[i] < trns.length) a = trns[out[i]];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, data: rgba };
}

/* ------------------------------------------------------------------ *
 * The metric
 * ------------------------------------------------------------------ */

/** Rec.601 luma, in 8-bit levels, as a Float64Array. */
export function luma(img) {
  const { width, height, data } = img;
  const l = new Float64Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) {
    l[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return l;
}

/**
 * High-pass 3x3 residual RMS over the rect, in grey levels, plus the patch's
 * mean luminance. The 3x3 window is read from the FULL image so the rect edge
 * is not a discontinuity, which means the rect must sit one pixel inside.
 */
export function highPassRms(img, l, x0, y0, w, h) {
  const { width, height } = img;
  let sum = 0, sq = 0, mean = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    if (y < 1 || y >= height - 1) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 1 || x >= width - 1) continue;
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * width + x;
        acc += l[row - 1] + l[row] + l[row + 1];
      }
      const r = l[y * width + x] - acc / 9;
      sum += r; sq += r * r; mean += l[y * width + x]; n++;
    }
  }
  if (n === 0) return { rms: 0, mean: 0, n: 0 };
  return { rms: Math.sqrt(sq / n), mean: mean / n, n };
}

/**
 * Is this rect a usable "flat patch"? A patch is only comparable if the thing
 * under it is one continuous surface: no block silhouette, no HUD, no enemy.
 * A plane fit catches all three — an edge leaves a residual a lit gradient does
 * not — and the chroma spread catches a patch that straddles two materials of
 * the same brightness.
 */
export function planarity(img, l, x0, y0, w, h) {
  const { width, data } = img;
  let n = 0, sx = 0, sy = 0, sl = 0, sxx = 0, sxy = 0, syy = 0, sxl = 0, syl = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const v = l[y * width + x];
      const u = x - x0, t = y - y0;
      n++; sx += u; sy += t; sl += v;
      sxx += u * u; sxy += u * t; syy += t * t; sxl += u * v; syl += t * v;
    }
  }
  // Solve the 3x3 normal equations for [a b c] in l = a*u + b*t + c.
  const m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const rhs = [sxl, syl, sl];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    [m[i], m[p]] = [m[p], m[i]]; [rhs[i], rhs[p]] = [rhs[p], rhs[i]];
    if (Math.abs(m[i][i]) < 1e-9) return { residual: 1e9, chroma: 1e9 };
    for (let k = i + 1; k < 3; k++) {
      const f = m[k][i] / m[i][i];
      for (let j = i; j < 3; j++) m[k][j] -= f * m[i][j];
      rhs[k] -= f * rhs[i];
    }
  }
  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = rhs[i];
    for (let j = i + 1; j < 3; j++) s -= m[i][j] * c[j];
    c[i] = s / m[i][i];
  }
  let sq = 0, chroma = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = y * width + x;
      const r = l[i] - (c[0] * (x - x0) + c[1] * (y - y0) + c[2]);
      sq += r * r;
      const rr = data[i * 4], gg = data[i * 4 + 1], bb = data[i * 4 + 2];
      const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
      chroma += mx - mn;
    }
  }
  return { residual: Math.sqrt(sq / n), chroma: chroma / n };
}
