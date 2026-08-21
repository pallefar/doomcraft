/**
 * Gate 3 + 4 + 6, with a FRESH PAGE LOAD before every mode.
 *
 * Why: a separate, confirmed regression (leaving Quest for any other mode
 * respawns the body on the Quest player start, which the regenerated terrain
 * has filled in solid) makes any mode entered after Quest in the same tab
 * useless as a collision measurement. Reloading isolates each mode.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '/Users/karstenhaldan/youtube/doomcraft/.verify/shots';
fs.mkdirSync(OUT, { recursive: true });
const R = { modes: {}, walls: [], seams: [], controls: {}, ws: [], failed: [], errors: [] };

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') R.errors.push(m.text().slice(0, 140)); });
page.on('pageerror', (e) => R.errors.push('PAGEERROR ' + String(e).slice(0, 140)));
page.on('response', (r) => { if (r.status() >= 400) R.failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
await page.addInitScript(() => {
  window.__WS__ = [];
  const O = window.WebSocket;
  window.WebSocket = function (...a) { window.__WS__.push(String(a[0])); return new O(...a); };
  window.WebSocket.prototype = O.prototype;
});

const SAMPLER = () => {
  const HALF = 0.3, SKIN = 1e-3;
  const inside = (x, y, z, h, solid) => {
    for (let bx = Math.floor(x-HALF+SKIN); bx <= Math.floor(x+HALF-SKIN); bx++)
      for (let by = Math.floor(y+SKIN); by <= Math.floor(y+h-SKIN); by++)
        for (let bz = Math.floor(z-HALF+SKIN); bz <= Math.floor(z+HALF-SKIN); bz++)
          if (solid(bx,by,bz)) return [bx,by,bz];
    return null;
  };
  window.__runway = (yaw) => {
    const g = window.__DC__.game, s = g.net.world.solidAt;
    const p = g.net.predicted.pos, h = g.net.predicted.height;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    for (let t = 0.25; t <= 40; t += 0.25) if (inside(p[0]+dx*t, p[1], p[2]+dz*t, h, s)) return t;
    return 40;
  };
  window.__scan = () => { const o=[]; for (let k=0;k<72;k++){const y=(k/72)*Math.PI*2;o.push([y,window.__runway(y)]);} return o; };
  const P = { on:false, alive:0, deadF:0, embAlive:0, embDead:0, stalled:0, maxEyeJump:0, maxBodyJump:0,
    maxSpeed:0, dist:0, first:null, chunks:new Set(), deaths:0, minY:1e9, maxY:-1e9, seams:0 };
  window.__P__ = P;
  let pe=null, pb=null, wasDead=false, pcx=null;
  const tick = () => {
    requestAnimationFrame(tick);
    if (!P.on) { pe=null; pb=null; return; }
    const g = window.__DC__.game;
    if (!g?.playing) return;
    const dead = g.net.local.dead === true;
    if (dead && !wasDead) P.deaths++;
    wasDead = dead;
    const p=g.net.predicted.pos, v=g.net.predicted.vel, e=g.net.renderPos, h=g.net.predicted.height;
    const hit = inside(p[0],p[1],p[2],h,g.net.world.solidAt);
    if (dead) { P.deadF++; if (hit) P.embDead++; pe=null; pb=null; return; }
    P.alive++;
    if (p[1]<P.minY) P.minY=p[1];
    if (p[1]>P.maxY) P.maxY=p[1];
    if (hit) { P.embAlive++; if (!P.first) P.first={pos:[+p[0].toFixed(2),+p[1].toFixed(2),+p[2].toFixed(2)],cell:hit,block:g.net.world.getBlock(hit[0],hit[1],hit[2])}; }
    const sp = Math.hypot(v[0],v[2]);
    if (sp>P.maxSpeed) P.maxSpeed=sp;
    if (P.maxSpeed>10 && sp<1) P.stalled++;
    if (pe) { const j=Math.hypot(e[0]-pe[0],e[1]-pe[1],e[2]-pe[2]); if (j>P.maxEyeJump) P.maxEyeJump=j; }
    if (pb) { const j=Math.hypot(p[0]-pb[0],p[1]-pb[1],p[2]-pb[2]); if (j>P.maxBodyJump) P.maxBodyJump=j; P.dist+=j; }
    const cx = `${Math.floor(p[0]/32)},${Math.floor(p[2]/32)}`;
    if (pcx !== null && cx !== pcx) P.seams++;
    pcx = cx;
    P.chunks.add(cx);
    pe=[e[0],e[1],e[2]]; pb=[p[0],p[1],p[2]];
  };
  requestAnimationFrame(tick);
};
const reset = () => page.evaluate(() => { const P=window.__P__;
  Object.assign(P,{alive:0,deadF:0,embAlive:0,embDead:0,stalled:0,maxEyeJump:0,maxBodyJump:0,maxSpeed:0,
    dist:0,first:null,deaths:0,minY:1e9,maxY:-1e9,seams:0,on:true}); P.chunks=new Set(); });
const read = () => page.evaluate(() => { const P=window.__P__; P.on=false;
  return {alive:P.alive,deadF:P.deadF,embAlive:P.embAlive,embDead:P.embDead,stalled:P.stalled,
    maxEyeJump:+P.maxEyeJump.toFixed(3),maxBodyJump:+P.maxBodyJump.toFixed(3),maxSpeed:+P.maxSpeed.toFixed(2),
    dist:+P.dist.toFixed(1),first:P.first,chunks:P.chunks.size,seams:P.seams,deaths:P.deaths,
    minY:+P.minY.toFixed(2),maxY:+P.maxY.toFixed(2)}; });
const faceYaw = (y) => page.evaluate((v)=>{const g=window.__DC__.game;g.camera.addLook(v-g.camera.viewYaw,-g.camera.viewPitch);}, y);
async function hold(keys, ms) { for (const k of keys) await page.keyboard.down(k); await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k); await page.waitForTimeout(200); }

async function freshMode(mode, opts) {
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__DC__?.ready === true, null, { timeout: 60000 });
  await page.evaluate(SAMPLER);
  await page.evaluate(([m,o]) => window.__DC__.enterMode(m,o), [mode, opts ?? {}]);
  await page.waitForTimeout(3200);
  await page.evaluate(() => window.__DC__.play());
  await page.waitForTimeout(1500);
}

for (const [mode, opts] of [['quest', { level: 'e1m1-hangar', skill: 1 }], ['horde', {}], ['deathmatch', {}], ['builder', {}]]) {
  await freshMode(mode, opts);
  const st = await page.evaluate(() => ({...window.__DC__.stats(), key: window.__DC__.modeKey, screen: window.__DC__.screen}));
  await page.screenshot({ path: `${OUT}/g-mode-${mode}.png` });
  R.modes[mode] = { key: st.key, playing: st.playing, screen: st.screen, chunks: st.chunks,
    draws: st.drawCalls, tris: st.triangles, ents: st.entities, hp: st.health };
  console.log(`MODE ${mode}: key=${st.key} playing=${st.playing} screen=${st.screen} chunks=${st.chunks} draws=${st.drawCalls} tris=${st.triangles} ents=${st.entities} hp=${st.health}`);

  const rays = await page.evaluate(() => window.__scan());
  const runs = rays.filter(([,d]) => d >= 8 && d < 40).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const longest = rays.reduce((m,r)=> r[1]>m[1]?r:m, [0,0]);
  console.log(`  ${rays.filter(([,d])=>d>=8).length}/72 headings have >=8 m of runway; longest ${longest[1]} m`);
  let n=0;
  for (const [yaw, runway] of runs) {
    await faceYaw(yaw); await page.waitForTimeout(250);
    await reset();
    await hold(['ShiftLeft','KeyW'], 2600);
    const r = await read();
    r.mode=mode; r.yawDeg=Math.round(yaw*180/Math.PI); r.runway=runway;
    R.walls.push(r);
    console.log(`  WALL ${mode} yaw=${r.yawDeg} runway=${runway}m alive=${r.alive}f EMBEDDED=${r.embAlive} `
      + `stalledAtWall=${r.stalled}f maxSpeed=${r.maxSpeed} maxEyeJump=${r.maxEyeJump} maxBodyJump=${r.maxBodyJump} `
      + `dist=${r.dist} y=${r.minY}..${r.maxY} deaths=${r.deaths}` + (r.first?` FIRST=${JSON.stringify(r.first)}`:''));
    if (n<2) await page.screenshot({ path: `${OUT}/g-wall-${mode}-${r.yawDeg}.png` });
    n++;
  }
  await faceYaw(longest[0]); await page.waitForTimeout(250);
  await reset();
  await hold(['ShiftLeft','KeyW'], 9000);
  const s = await read();
  s.mode=mode; s.yawDeg=Math.round(longest[0]*180/Math.PI);
  R.seams.push(s);
  console.log(`  SEAM ${mode} yaw=${s.yawDeg} alive=${s.alive}f dist=${s.dist}m chunkCrossings=${s.seams} chunks=${s.chunks} `
    + `EMBEDDED=${s.embAlive} maxSpeed=${s.maxSpeed} maxEyeJump=${s.maxEyeJump} maxBodyJump=${s.maxBodyJump} y=${s.minY}..${s.maxY}`
    + (s.first?` FIRST=${JSON.stringify(s.first)}`:''));
  await page.screenshot({ path: `${OUT}/g-seam-${mode}.png` });
}

/* ------------------------------------------------------- gate 4 presets */
const snap = () => page.evaluate(() => { const g=window.__DC__.game;
  return { pos:[...g.net.predicted.pos].map(v=>+v.toFixed(3)), yaw:+g.camera.viewYaw.toFixed(4),
    shots:g.weapons.shotSeq, mag:g.net.local.mag }; });
const dAng = (a,b) => { let d=((b-a)*180)/Math.PI; while(d>180)d-=360; while(d<-180)d+=360; return +d.toFixed(1); };

for (const scheme of ['modern','classic']) {
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__DC__?.ready === true, null, { timeout: 60000 });
  await page.evaluate(SAMPLER);
  // set the scheme through the REAL settings <select> before entering a match
  const bind = await page.evaluate((s) => {
    const sel = [...document.querySelectorAll('select')].find((e)=>[...e.options].map(o=>o.value).join(',')==='modern,classic');
    sel.value = s; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const i = window.__DC__.game.input;
    return { select: sel.value, scheme: i.controlScheme, alt: {...i.altBindings} };
  }, scheme);
  await page.evaluate(() => window.__DC__.enterMode('deathmatch', {}));
  await page.waitForTimeout(3200);
  await page.evaluate(() => window.__DC__.play());
  await page.waitForTimeout(1500);
  const rays = await page.evaluate(() => window.__scan());
  const open = rays.reduce((m,r)=> r[1]>m[1]?r:m, [0,0]);
  const res = { select: bind.select, scheme: bind.scheme, runway: open[1],
    alt: { fwd: bind.alt.moveForward, left: bind.alt.moveLeft, right: bind.alt.moveRight,
      turnL: bind.alt.turnLeft, turnR: bind.alt.turnRight, fire: bind.alt.fire }, tests: {} };
  console.log(`\nCONTROLS ${scheme}: settings select="${bind.select}" input scheme="${bind.scheme}" runway=${open[1]}m`);
  console.log(`  alt layer: fwd=${bind.alt.moveForward} left=${bind.alt.moveLeft} right=${bind.alt.moveRight} turnL=${bind.alt.turnLeft||'(unbound)'} turnR=${bind.alt.turnRight||'(unbound)'} fire=${bind.alt.fire||'(unbound)'}`);

  for (const code of ['ArrowUp','ArrowLeft','ArrowRight']) {
    await faceYaw(open[0]); await page.waitForTimeout(300);
    const a = await snap(); await hold([code], 1200); const b = await snap();
    res.tests[code] = { movedM: +Math.hypot(b.pos[0]-a.pos[0], b.pos[2]-a.pos[2]).toFixed(2), turnedDeg: dAng(a.yaw,b.yaw) };
    console.log(`  ${code}: moved ${res.tests[code].movedM} m, turned ${res.tests[code].turnedDeg} deg`);
  }
  await faceYaw(open[0]); await page.waitForTimeout(300);
  const a = await snap(); await hold(['ControlLeft'], 900); const b = await snap();
  res.tests.ControlLeft = { shots: b.shots-a.shots, mag: `${a.mag}->${b.mag}` };
  console.log(`  ControlLeft: ${b.shots-a.shots} shots, mag ${a.mag} -> ${b.mag}`);
  if (scheme === 'classic') {
    for (const [label, keys] of [['Alt+ArrowLeft',['AltLeft','ArrowLeft']],['Comma',['Comma']],['Period',['Period']]]) {
      await faceYaw(open[0]); await page.waitForTimeout(300);
      const c = await snap(); await hold(keys, 1200); const d = await snap();
      res.tests[label] = { movedM: +Math.hypot(d.pos[0]-c.pos[0], d.pos[2]-c.pos[2]).toFixed(2), turnedDeg: dAng(c.yaw,d.yaw) };
      console.log(`  ${label}: moved ${res.tests[label].movedM} m, turned ${res.tests[label].turnedDeg} deg`);
    }
  }
  await page.screenshot({ path: `${OUT}/g-controls-${scheme}.png` });
  R.controls[scheme] = res;
  R.ws = await page.evaluate(() => window.__WS__);
}
console.log('\nWEBSOCKETS on the static build:', JSON.stringify(R.ws));
console.log('FAILED REQUESTS:', JSON.stringify([...new Set(R.failed)]));
fs.writeFileSync(`${OUT}/gate-report.json`, JSON.stringify(R, null, 1));
await browser.close();
