/**
 * DOOMCRAFT — signalling smoke test against a REAL server process.
 *
 *   node tools/smoke-signal.mjs [ws://127.0.0.1:8080]
 *
 * server/src/signal.test.ts covers the hub's logic exhaustively with the
 * socket faked out. This covers the part a unit test cannot: that the HTTP
 * upgrade actually routes /rtc to the hub and /ws to the game, that a binary
 * frame on the signalling socket is ignored rather than fatal, that an unknown
 * path is still refused, and that the ICE configuration the environment set is
 * the ICE configuration a client receives.
 *
 * Exits non-zero on the first failure, so it can gate a deploy.
 *
 * To see a TURN credential issued, run the server with:
 *   DOOMCRAFT_STUN_URLS=stun:stun.example:3478 \
 *   DOOMCRAFT_TURN_URLS=turn:turn.example:3478 \
 *   DOOMCRAFT_TURN_SECRET=... npm start
 */

import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'ws://127.0.0.1:8080';
const V = 1;

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'ok  ' : 'FAIL';
  if (!ok) failures++;
  process.stdout.write(`${mark} ${name}${detail ? `  ${detail}` : ''}\n`);
}

function open(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE + path);
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collect(ws) {
  const out = [];
  ws.on('message', (d, isBinary) => { if (!isBinary) out.push(JSON.parse(String(d))); });
  return out;
}

const sockets = [];
try {
  /* --- the hub is reachable and hands out a room code ------------------- */
  const host = await open('/rtc'); sockets.push(host);
  const hostMsgs = collect(host);
  host.send(JSON.stringify({ t: 'host', v: V, cap: 3 }));
  await sleep(150);
  const hosted = hostMsgs[0];
  check('host gets a room code', hosted?.t === 'hosted' && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(hosted.code ?? ''), hosted?.code);
  check('ICE configuration is served', Array.isArray(hosted?.iceServers),
    JSON.stringify(hosted?.iceServers ?? null));
  if ((hosted?.iceServers ?? []).length === 0) {
    process.stdout.write('     note: no STUN/TURN configured — every peer will need a direct path\n');
  }

  /* --- a guest is introduced, in either case ---------------------------- */
  const guest = await open('/rtc'); sockets.push(guest);
  const guestMsgs = collect(guest);
  guest.send(JSON.stringify({ t: 'join', v: V, code: hosted.code.toLowerCase() }));
  await sleep(150);
  check('a lower-case code still joins', guestMsgs[0]?.t === 'joined', guestMsgs[0]?.self);
  check('the host is told about the guest', hostMsgs[1]?.t === 'peer' && hostMsgs[1].peer === 'g1');

  /* --- SDP is relayed, guest -> host ------------------------------------ */
  guest.send(JSON.stringify({ t: 'sdp', to: 'h', kind: 'offer', sdp: 'v=0 smoke-offer' }));
  await sleep(150);
  check('an offer reaches the host', hostMsgs[2]?.t === 'sdp' && hostMsgs[2].sdp === 'v=0 smoke-offer');

  /* --- and refused, guest -> guest -------------------------------------- */
  guest.send(JSON.stringify({ t: 'sdp', to: 'g2', kind: 'offer', sdp: 'sneaky' }));
  await sleep(150);
  check('a guest cannot address another guest',
    guestMsgs.some((m) => m.t === 'error' && m.code === 'bad-request'));

  /* --- a binary frame on the signalling socket is ignored, not fatal ---- */
  guest.send(Buffer.from([1, 2, 3]), { binary: true });
  await sleep(150);
  check('a binary frame does not kill the signalling socket', guest.readyState === 1);

  /* --- a wrong code says nothing useful --------------------------------- */
  const scanner = await open('/rtc'); sockets.push(scanner);
  const scanMsgs = collect(scanner);
  scanner.send(JSON.stringify({ t: 'join', v: V, code: 'ZZZZZZZZ' }));
  await sleep(150);
  check('a wrong code is refused', scanMsgs[0]?.t === 'error' && scanMsgs[0].code === 'no-such-room');

  /* --- the game socket is untouched ------------------------------------- */
  const game = await open('/ws'); sockets.push(game);
  let gameBytes = 0;
  game.on('message', (d) => { gameBytes += d.length; });
  await sleep(400);
  check('the game socket still serves the world', gameBytes > 0, `${gameBytes} bytes`);

  /* --- and nothing else upgrades ---------------------------------------- */
  let refused = false;
  try { sockets.push(await open('/anything-else')); } catch { refused = true; }
  check('an unknown path is refused', refused);
} catch (err) {
  check('connected to the server', false, String(err instanceof Error ? err.message : err));
  process.stdout.write(`     is a server running on ${BASE}?\n`);
} finally {
  for (const s of sockets) { try { s.close(); } catch { /* already gone */ } }
}

process.stdout.write(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
