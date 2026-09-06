// Measure, per frame pair, how far the BACKGROUND pans and how far the HELD VIEWMODEL moves.
//
//   node tools/viewmodel-motion.mjs <video.webm> [--from s] [--to s]
//                                   [--bg x,y,w,h] [--gun x,y,w,h] [--maxdx n]
//
// ref/BAR.md's most-quoted claim about voxiom is "across 1.2 s of continuous mouselook the held
// shovel does not move one pixel". That is a measurement, so it needs an instrument that can FAIL.
// Two traps make the obvious instruments lie:
//
//  * a plain frame-difference over the viewmodel scores almost nothing whether it moved or not —
//    the gun body is a flat grey slab, so a 1 px shift of it changes almost no pixels. So this
//    also prints the difference the same box scores against ITSELF shifted one pixel, which is the
//    only number that makes the first one mean anything.
//  * a "dark pixels" silhouette mask is contaminated: voxiom's mortar lines and shaded brick are
//    as dark as the gun. So position is measured by ALIGNMENT, not by centroid — the (dx, dy) that
//    best lines a box up with the previous frame.
//
// Read it as: background box shifts by N px per frame (the camera is panning), viewmodel box shifts
// by M. M ~ 0 while N is large means the viewmodel is nailed to the camera.
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const [src] = argv;
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
if (!src) { console.error('usage: viewmodel-motion.mjs <video> [--from s] [--to s] [--bg x,y,w,h] [--gun x,y,w,h]'); process.exit(1); }
const nums = (s) => s.split(',').map(Number);
const BG = nums(arg('--bg', '100,540,700,160'));
const GUN = nums(arg('--gun', '900,560,350,200'));
const FROM = +arg('--from', 0), TO = +arg('--to', 1e9);
const W = +arg('--width', 1440), H = +arg('--height', 900);
const MAXDX = +arg('--maxdx', 30);
const MAXD2 = +arg('--maxd2', 12);

const ff = spawn('ffmpeg', ['-v', 'error', '-i', src, '-vf', `select='between(t,${FROM},${TO})',format=gray`,
  '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
const FRAME = W * H;
let acc = Buffer.alloc(0);
let prev = null;
const pans = [], gunDx = [], gunDy = [], gunMad = [], gunOnePx = [];

/** Mean |a - b| over `box` with b sampled at (+dx, +dy); `step` subsamples for speed. */
const sad = (a, b, [x0, y0, w, h], dx, dy, step, pad) => {
  let s = 0, n = 0;
  for (let y = y0 + pad; y < y0 + h - pad; y += step) {
    const row = y * W, row2 = (y + dy) * W;
    for (let x = x0 + pad; x < x0 + w - pad; x += step) { s += Math.abs(a[row + x] - b[row2 + x + dx]); n++; }
  }
  return s / n;
};

/* Template tracking: lock a small patch onto a landmark ON the weapon (the front sight post is
 * ideal — a dark shape against flat sky) and find where that patch is in every later frame. Its
 * screen position IS its position relative to the camera, because the camera is the screen. This
 * is the measurement the "does not move one pixel" claim needs, and unlike a frame difference it
 * reports WHERE, not merely THAT something changed. `lost` frames (best match far worse than the
 * reference) are frames where the landmark is not on screen at all — a reload animation, say. */
const TRACK = arg('--track', '') ? nums(arg('--track')) : null;
const TRACK_R = +arg('--trackr', 70);
const TRACK_REF = +arg('--trackref', 0);
let template = null;
const track = [];

/* The decisive one. The viewmodel is a dark silhouette and everything behind it — sky, wall,
 * grass — is lighter. So down a FIXED COLUMN, the first dark pixel is the top edge of the held
 * weapon, and its y is the weapon's position in that column to the pixel. If the weapon kicks,
 * sways or bobs, this number moves; if it is a billboard welded to the camera, it does not.
 * Nothing about the background can fake it: the background can only make the edge appear EARLIER
 * (a dark object passing behind), which shows up as an outlier, not as a wobble. */
const COLS = nums(arg('--cols', '1000,1100,1200,1300'));
const EDGE_THR = +arg('--edgethr', 80);
const EDGE_Y0 = +arg('--edgey0', 380);
const edges = COLS.map(() => []);
const topEdge = (f, x) => {
  for (let y = EDGE_Y0; y < H; y++) if (f[y * W + x] < EDGE_THR) return y;
  return -1;
};

ff.stdout.on('data', (chunk) => {
  acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
  while (acc.length >= FRAME) {
    const f = acc.subarray(0, FRAME);
    COLS.forEach((x, i) => edges[i].push(topEdge(f, x)));
    if (TRACK) {
      const [tx, ty, tw, th] = TRACK;
      const frameIdx = track.length;
      if (!template && frameIdx * (1 / 56) >= TRACK_REF) {
        template = new Uint8Array(tw * th);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) template[y * tw + x] = f[(ty + y) * W + tx + x];
      }
      if (template) {
        let best = Infinity, bx = 0, by = 0;
        for (let dy = -TRACK_R; dy <= TRACK_R; dy++) {
          for (let dx = -TRACK_R; dx <= TRACK_R; dx++) {
            let s = 0;
            for (let y = 0; y < th; y += 2) {
              const row = (ty + y + dy) * W + tx + dx;
              for (let x = 0; x < tw; x += 2) s += Math.abs(template[y * tw + x] - f[row + x]);
            }
            if (s < best) { best = s; bx = dx; by = dy; }
          }
        }
        track.push([bx, by, best / ((tw / 2) * (th / 2))]);
      }
    }
    if (prev) {
      let best = Infinity, bdx = 0;
      for (let dx = -MAXDX; dx <= MAXDX; dx++) {
        const s = sad(f, prev, BG, dx, 0, 2, MAXDX);
        if (s < best) { best = s; bdx = dx; }
      }
      pans.push(bdx);

      let gb = Infinity, gx = 0, gy = 0;
      for (let dy = -MAXD2; dy <= MAXD2; dy++) {
        for (let dx = -MAXD2; dx <= MAXD2; dx++) {
          const s = sad(f, prev, GUN, dx, dy, 3, MAXD2);
          if (s < gb) { gb = s; gx = dx; gy = dy; }
        }
      }
      gunDx.push(gx); gunDy.push(gy);
      gunMad.push(sad(f, prev, GUN, 0, 0, 1, MAXD2));
      gunOnePx.push(sad(f, f, GUN, 1, 0, 1, MAXD2));
    }
    prev = Buffer.from(f);
    acc = acc.subarray(FRAME);
  }
});
ff.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((r) => ff.on('close', r));

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (k) => s[Math.min(s.length - 1, Math.floor(s.length * k))];
  return { n: a.length, min: +q(0).toFixed(2), median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +q(1).toFixed(2), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) };
};
const moving = pans.map((p, i) => [Math.abs(p), i]).filter(([p]) => p > 0).map(([, i]) => i);
console.log(`file ${src}  window ${FROM}-${TO}s  pairs ${pans.length}`);
console.log('background pan px/frame  ', JSON.stringify(stat(pans.map(Math.abs))));
console.log('  ... over PANNING pairs ', JSON.stringify(stat(moving.map((i) => Math.abs(pans[i])))), `(${moving.length}/${pans.length} pairs)`);
console.log('  signed pan sample       ', pans.slice(0, 40).join(' '));
console.log('viewmodel best-align dx  ', JSON.stringify(stat(gunDx.map(Math.abs))));
console.log('viewmodel best-align dy  ', JSON.stringify(stat(gunDy.map(Math.abs))));
console.log('  ... over PANNING pairs ', JSON.stringify(stat(moving.map((i) => Math.abs(gunDx[i])))));
console.log('viewmodel MAD at dx=0    ', JSON.stringify(stat(gunMad)));
console.log('viewmodel MAD if 1px move', JSON.stringify(stat(gunOnePx)));
/* The clean subset: pairs where the background did NOT pan. Anything that changes inside the
 * viewmodel box across one of those pairs is the viewmodel itself moving — the world behind it
 * held still, so it cannot be borrowing the world's motion. */
const still = pans.map((p, i) => [p, i]).filter(([p]) => p === 0).map(([, i]) => i);
if (still.length) {
  console.log(`still-camera pairs (${still.length}/${pans.length}):`);
  console.log('  viewmodel best-align dx', JSON.stringify(stat(still.map((i) => Math.abs(gunDx[i])))));
  console.log('  viewmodel best-align dy', JSON.stringify(stat(still.map((i) => Math.abs(gunDy[i])))));
  console.log('  viewmodel MAD at dx=0  ', JSON.stringify(stat(still.map((i) => gunMad[i]))));
  console.log('  1px-move equivalent    ', JSON.stringify(stat(still.map((i) => gunOnePx[i]))));
}
/* And the subset that actually tests the claim: pairs where the camera DID pan. A viewmodel that
 * changes nothing here, while the world behind it slides sideways, is welded to the camera. */
if (moving.length) {
  console.log(`panning pairs (${moving.length}/${pans.length}):`);
  console.log('  viewmodel MAD at dx=0  ', JSON.stringify(stat(moving.map((i) => gunMad[i]))));
  console.log('  1px-move equivalent    ', JSON.stringify(stat(moving.map((i) => gunOnePx[i]))));
}
if (TRACK && track.length) {
  const good = track.filter((t) => t[2] < 18);
  const lost = track.length - good.length;
  const xs = good.map((t) => t[0]), ys = good.map((t) => t[1]);
  const rng = (a) => `${Math.min(...a)}..${Math.max(...a)} (${Math.max(...a) - Math.min(...a)} px)`;
  console.log(`viewmodel landmark tracked in ${good.length}/${track.length} frames (${lost} lost: landmark off-screen / occluded)`);
  console.log(`  landmark x offset from reference: ${rng(xs)}`);
  console.log(`  landmark y offset from reference: ${rng(ys)}`);
  const dx = [], dy = [];
  for (let i = 1; i < track.length; i++) {
    if (track[i][2] >= 18 || track[i - 1][2] >= 18) continue;
    dx.push(Math.abs(track[i][0] - track[i - 1][0])); dy.push(Math.abs(track[i][1] - track[i - 1][1]));
  }
  console.log('  landmark |dx| per frame', JSON.stringify(stat(dx)));
  console.log('  landmark |dy| per frame', JSON.stringify(stat(dy)));
  console.log('  first 60 (x,y):', track.slice(0, 60).map((t) => (t[2] < 18 ? `${t[0]},${t[1]}` : 'lost')).join(' '));
}
COLS.forEach((x, i) => {
  const v = edges[i].filter((y) => y > 0);
  const s = [...v].sort((a, b) => a - b);
  const mode = s[s.length >> 1];
  const off = v.filter((y) => y !== mode).length;
  console.log(`viewmodel top edge @x=${x}: median y=${mode}, range ${s[0]}..${s[s.length - 1]}, `
    + `${off}/${v.length} frames off the median, values ${v.slice(0, 30).join(',')}`);
});
