import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/karstenhaldan/youtube/doomcraft/dist';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
// Deliberately DUMB static hosting: no meta tag stamped, no /ws route, nothing
// server-side at all. This is what doomcraft.vercel.app is.
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let p = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
server.listen(5199, '127.0.0.1', () => console.log('static dist on http://127.0.0.1:5199'));
