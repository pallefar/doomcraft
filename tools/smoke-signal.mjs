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

  /* --- the game socket is untouched -------------------------------------
   *
   * A CONNECTION IS NOT A JOIN. This check used to open /ws, wait 400 ms and
   * assert that bytes had arrived — and it had been failing on every server
   * this repo has built for as long as anyone looked, because the server
   * deliberately says NOTHING until it hears a HELLO (see the reaper comment
   * at the /ws upgrade in server/src/index.ts: a room somebody is walking into
   * still has humanCount 0 for a few hundred milliseconds). So the check could
   * not pass, and a deploy gate that cannot pass is worth exactly as much as
   * one that cannot fail.
   *
   * It says HELLO now, using the frozen golden vector from
   * shared/src/version.test.ts — so a protocol change that moves that vector
   * moves this too, rather than leaving the tool quietly speaking a dialect
   * the server has stopped understanding.
   */
  const HELLO = Buffer.from('0103064d6172696e650411009999a0000100', 'hex');

  async function bytesAfter(send) {
    const ws = await open('/ws'); sockets.push(ws);
    let n = 0;
    ws.on('message', (d) => { n += d.length; });
    if (send !== null) ws.send(send);
    await sleep(send === null ? 400 : 1200);
    return n;
  }

  check('a socket that has not said HELLO is told nothing',
    (await bytesAfter(null)) === 0);
  // The negative control, and the reason the positive one below means
  // anything. Without it "the world arrived" is satisfied by a server that
  // sprays at any inbound byte, and the check would be measuring the socket
  // rather than the protocol. One junk byte gets nothing.
  check('a socket that says something unintelligible is told nothing',
    (await bytesAfter(Buffer.from([0xff]))) === 0);

  const worldBytes = await bytesAfter(HELLO);
  check('the game socket serves the world to a client that says HELLO',
    worldBytes > 0, `${worldBytes} bytes`);

  /* --- the room tells a capable client which variant table it pinned ----
   *
   * V3. This is the only place the wire is checked against a REAL deployed
   * origin, and it is worth a live check because the failure it catches is a
   * production-only one: a binary whose room factory never passes the pinned
   * variants manifest serves an empty table forever with the entire suite
   * green. `server/src/releases.test.ts` guards the source line; this guards
   * the running server.
   *
   * The HELLO is the frozen vector with ONE bit changed — caps 0x0011 ->
   * 0x0031, adding `CAP_VARIANTS` (1 << 5) — so if the golden moves, this
   * moves with it. And the negative control is the interlock itself: without
   * the bit the server must say nothing about variants at all, because a
   * client that cannot decode the message has already had every claim
   * resolved to the base.
   */
  const HELLO_VARIANTS = Buffer.from('0103064d6172696e650431009999a0000100', 'hex');
  const S2C_VARIANT_TABLE = 13;

  async function sawVariantTable(hello) {
    const ws = await open('/ws'); sockets.push(ws);
    let seen = false;
    ws.on('message', (d) => { if (d.length > 0 && d[0] === S2C_VARIANT_TABLE) seen = true; });
    ws.send(hello);
    await sleep(1200);
    return seen;
  }

  check('a client that sets CAP_VARIANTS is told the room\'s variant table',
    await sawVariantTable(HELLO_VARIANTS));
  check('a client that does not is told nothing it could not decode',
    !(await sawVariantTable(HELLO)));

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
