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
   *
   * V4a — WHAT THIS USED TO CHECK, AND WHY IT WAS WORTH NOTHING.
   *
   * Until now the whole of it was `if (d[0] === 13) seen = true`. HANDOVER §4
   * called this "the only check anywhere that can see a deployed binary whose
   * room factory forgot its pinned content", and it could not: a lone opcode
   * byte satisfies it, and so does a table with a count of zero — which is
   * PRECISELY the state a forgotten room factory produces. It proved the
   * message was SENT. That is this project's rule 25 in its other direction, a
   * gate that passes on nothing, sitting in the one place that was supposed to
   * catch nothing being served.
   *
   * WHY A CROSS-CHECK AND NOT A HARD-CODED COUNT. "Expect two rows" would be
   * wrong on every host that legitimately pins no variants pack — a local
   * `node server/dist/server.mjs` with a bare DOOMCRAFT_PACKS, a rollback to a
   * six-pack release — and a check that cannot pass is worth exactly what one
   * that cannot fail is worth; this file already carries that lesson in the
   * `/ws` block above it. So the tool asks the ORIGIN what it pins and
   * requires the wire to agree: `/api/version` reports the live release's pack
   * set, and a `variants@N` in it that is NOT in `unsatisfied` is exactly the
   * version `server/src/index.ts` resolves for every room it builds. Pinned
   * means the wire must carry rows; not pinned means it must not.
   *
   * WHAT IT DELIBERATELY DOES NOT TRY TO CHECK. The pack's digest and
   * fingerprint are computed over `variantsFingerprintInputs` — one line per
   * variant listing only the fields the author OVERRODE. The wire carries all
   * sixteen fields at their effective value for every row and no record of
   * which were overridden (that is decision 1 of the layout, argued at length
   * in shared/src/variants.ts), so the digest is not reconstructible from
   * these bytes and pretending otherwise would mint a check that fails on
   * correct data. The row COUNT is the strongest quantity both sides can
   * honestly speak about, and the wire's own values are checked for being
   * simulable rather than for being any particular number.
   */
  const HELLO_VARIANTS = Buffer.from('0103064d6172696e650431009999a0000100', 'hex');
  const S2C_VARIANT_TABLE = 13;
  const VARIANT_FIELD_COUNT = 16;
  const WEAPON_COUNT = 7;

  /**
   * The V3 layout, by hand: opcode, u8 count, then per row a u8-prefixed id,
   * a u8 base and sixteen little-endian f64s, then WEAPON_COUNT slot bytes.
   *
   * Hand-written because this tool runs under plain `node` against a DEPLOYED
   * origin and cannot import the repo's TypeScript. That is a real duplication
   * and the mitigation is that it is STRUCTURAL — lengths and widths, not
   * values — so it fails loudly on a layout change instead of drifting: a
   * moved field makes `end !== buf.length` and the row is refused.
   */
  function decodeVariantTable(buf) {
    if (buf.length < 2 || buf[0] !== S2C_VARIANT_TABLE) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 1;
    const count = buf[o]; o += 1;
    const rows = [];
    for (let i = 0; i < count; i++) {
      if (o >= buf.length) return null;
      const idLen = buf[o]; o += 1;
      if (o + idLen + 1 + VARIANT_FIELD_COUNT * 8 > buf.length) return null;
      const id = new TextDecoder().decode(buf.subarray(o, o + idLen)); o += idLen;
      const base = buf[o]; o += 1;
      const values = [];
      for (let f = 0; f < VARIANT_FIELD_COUNT; f++) { values.push(view.getFloat64(o, true)); o += 8; }
      rows.push({ id, base, values });
    }
    if (o + WEAPON_COUNT !== buf.length) return null;   // trailing slot map, exactly
    return { rows, slots: [...buf.subarray(o)] };
  }

  async function variantTableFrame(hello) {
    const ws = await open('/ws'); sockets.push(ws);
    let frame = null;
    ws.on('message', (d) => { if (d.length > 0 && d[0] === S2C_VARIANT_TABLE) frame = d; });
    ws.send(hello);
    await sleep(1200);
    return frame;
  }

  /* What the ORIGIN says it is serving. Unreachable is a FAILURE, not a
   * shrug: without it there is nothing to cross-check against and the wire
   * assertion collapses back into "a byte arrived". */
  const httpOrigin = BASE.replace(/^ws/, 'http').replace(/\/+$/, '');
  let pinnedVariants = null;
  let versionReadable = false;
  try {
    const v = await (await fetch(`${httpOrigin}/api/version`)).json();
    const packs = v?.release?.packs ?? [];
    const unsat = new Set(v?.release?.unsatisfied ?? []);
    pinnedVariants = packs
      .map((p) => p.label)
      .find((l) => typeof l === 'string' && l.startsWith('variants@') && !unsat.has(l)) ?? null;
    versionReadable = Array.isArray(packs);
  } catch {
    versionReadable = false;
  }
  check('the origin says which packs it is serving', versionReadable,
    versionReadable ? `variants: ${pinnedVariants ?? 'none pinned'}` : `${httpOrigin}/api/version unreadable`);

  const frame = await variantTableFrame(HELLO_VARIANTS);
  check('a client that sets CAP_VARIANTS is told the room\'s variant table', frame !== null);

  const table = frame === null ? null : decodeVariantTable(frame);
  check('that table DECODES as the V3 layout, whole', table !== null,
    frame === null ? 'no frame' : `${frame.length} bytes`);

  /* THE CROSS-CHECK. This is the assertion the old opcode test was pretending
   * to be, and it is symmetric on purpose: a host pinning variants@N that
   * serves nothing is the forgotten-room-factory bug, and a host pinning
   * nothing that serves rows is content nobody released. */
  if (versionReadable && table !== null) {
    const n = table.rows.length;
    check('the wire\'s variant table agrees with the release the origin pins',
      pinnedVariants === null ? n === 0 : n > 0,
      pinnedVariants === null
        ? `no variants pack pinned, ${n} row(s) on the wire`
        : `${pinnedVariants} pinned, ${n} row(s) on the wire: ${table.rows.map((r) => r.id).join(', ')}`);

    /* And every row has to be a stat line something could actually fire.
     * Subordinate to the count check above — on a host that legitimately
     * serves zero rows this passes over an empty list, which is why it is not
     * the one carrying the weight. */
    const bad = table.rows.filter((r) => r.id.length === 0 || r.base >= WEAPON_COUNT
      || r.values.some((x) => !Number.isFinite(x) || x < 0));
    check('every row on the wire carries a usable stat line', bad.length === 0,
      bad.length === 0 ? `${table.rows.length} row(s)` : bad.map((r) => r.id || '(unnamed)').join(', '));
  }

  check('a client that does not is told nothing it could not decode',
    (await variantTableFrame(HELLO)) === null);

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
