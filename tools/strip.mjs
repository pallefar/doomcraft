// Turn a gameplay recording into a contact sheet a critic can actually judge motion from.
//
//   node tools/strip.mjs <video.webm> <out.png> [cols] [rows] [startSec] [endSec]
//
// Stills cannot show pace, recoil, muzzle flash duration or animation follow-through. A tiled
// strip of consecutive frames can — it is the closest thing to watching it that fits in a review.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [src, out, colsArg, rowsArg, startArg, endArg] = process.argv.slice(2);
if (!src || !out) { console.error('usage: strip.mjs <video> <out.png> [cols] [rows] [start] [end]'); process.exit(1); }
const cols = +(colsArg || 4), rows = +(rowsArg || 3);
const n = cols * rows;

const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).toString().trim();
const start = startArg != null ? +startArg : Math.max(0, dur * 0.35);
const end = endArg != null ? +endArg : Math.min(dur, start + 4);
const span = Math.max(0.2, end - start);
// fps chosen so exactly n frames land in the window
const fps = n / span;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'strip-'));
execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-t', String(span), '-i', src,
  '-vf', `fps=${fps.toFixed(4)},scale=480:-1`, '-frames:v', String(n),
  path.join(tmp, 'f%03d.png')]);

const frames = fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
if (!frames.length) { console.error('no frames extracted'); process.exit(1); }
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, 'f%03d.png'),
  '-vf', `tile=${cols}x${Math.ceil(frames.length / cols)}:padding=4:margin=4:color=0x101010`,
  '-frames:v', '1', out]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${out}  ${frames.length} frames  ${start.toFixed(2)}s-${end.toFixed(2)}s of ${dur.toFixed(2)}s`);
