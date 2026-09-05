// Regenerates progress/index.html from progress/state.json + whatever screenshots exist.
// Run: node progress/build.mjs   then republish the artifact with the same file path.
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/Users/karstenhaldan/youtube/doomcraft/progress';
const S = JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8'));

const dataUri = (p) => {
  try {
    const b = fs.readFileSync(p);
    const ext = path.extname(p).slice(1).replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${b.toString('base64')}`;
  } catch { return null; }
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ms = (v) => v == null ? '—' : v < 1000 ? `${Math.round(v)}<i>ms</i>` : `${(v / 1000).toFixed(2)}<i>s</i>`;
const mb = (v) => v == null ? '—' : `${(v / 1048576).toFixed(1)}<i>MB</i>`;
const num = (v, d = 1) => v == null ? '—' : Number(v).toFixed(d);

const VERDICT = {
  pending: ['PENDING', 'v-pending'],
  building: ['BUILDING', 'v-building'],
  lost: ['LOST', 'v-lost'],
  tied: ['TIED', 'v-tied'],
  won: ['WON', 'v-won'],
};

const STAGE = {
  pending: ['QUEUED', 'v-pending'],
  building: ['IN FLIGHT', 'v-building'],
  done: ['DONE', 'v-won'],
};

const won = S.pieces.filter((p) => p.verdict === 'won').length;
const stagesDone = (S.stages || []).filter((x) => x.state === 'done').length;

// A/B image pairs: bar frame vs our matching frame, when ours exists.
const pairs = [
  { label: 'In-game · desktop', bar: 'thumbs/desktop-08-combat.jpg', ours: 'thumbs/ours-08-combat.jpg' },
  { label: 'Mobile portrait — the bar refuses to play here', bar: 'thumbs/bar-mobile.jpg', ours: 'thumbs/ours-mobile.jpg' },
  { label: 'Menu', bar: 'thumbs/desktop-00-menu.jpg', ours: 'thumbs/ours-00-menu.jpg' },
].map((p) => ({ ...p, barSrc: dataUri(path.join(DIR, p.bar)), oursSrc: dataUri(path.join(DIR, p.ours)) }))
  .filter((p) => p.barSrc);

const html = `<title>Doomcraft Gauntlet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>
  /* Single committed visual world: a UAC facility status panel. Deliberately no light theme —
     every colour is painted explicitly so the page holds on either host ground. */
  :root{
    --ground:#131010; --panel:#1E1917; --panel-2:#282120; --sunk:#0C0A09;
    --rule:#463731; --rule-hi:#6B5347;
    --bone:#DED4C4; --bone-dim:#8E8175; --bone-faint:#5C5249;
    --hell:#E0431C; --tox:#86C232; --amber:#E5A02E; --steel:#5F8FA8;
    --sp:clamp(16px,2.2vw,28px);
    color-scheme:dark;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--ground); color:var(--bone);
    font-family:Barlow,"Helvetica Neue",Arial,sans-serif; font-size:15px; line-height:1.55;
    -webkit-font-smoothing:antialiased;
    background-image:
      radial-gradient(120% 80% at 50% -10%, rgba(224,67,28,.10), transparent 60%),
      repeating-linear-gradient(0deg, rgba(255,255,255,.014) 0 1px, transparent 1px 3px);
  }
  .wrap{max-width:1180px; margin:0 auto; padding:var(--sp) var(--sp) 72px; display:flex; flex-direction:column; gap:var(--sp)}
  h1,h2,h3{font-family:"Big Shoulders Display",Barlow,sans-serif; margin:0; text-wrap:balance; letter-spacing:.01em}

  /* --- Doom status bar --- */
  .statusbar{
    background:linear-gradient(#241D1A,#1A1513); border:2px solid var(--rule);
    border-top-color:var(--rule-hi); border-left-color:var(--rule-hi);
    display:grid; grid-template-columns:auto 1fr; gap:0;
  }
  .brand{padding:14px 22px 12px; border-right:2px solid var(--rule); display:flex; flex-direction:column; justify-content:center}
  .brand h1{
    font-size:clamp(38px,6vw,64px); font-weight:800; line-height:.82; text-transform:uppercase;
    color:var(--bone); text-shadow:3px 3px 0 var(--hell), 4px 4px 0 rgba(0,0,0,.55);
  }
  .brand .sub{font-family:"IBM Plex Mono",monospace; font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--bone-dim); margin-top:9px}
  .readouts{display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr))}
  .ro{padding:12px 16px 10px; border-right:1px solid rgba(0,0,0,.5); box-shadow:inset -1px 0 0 rgba(255,255,255,.04)}
  .ro:last-child{border-right:0; box-shadow:none}
  .ro .k{font-family:"IBM Plex Mono",monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--bone-faint); white-space:nowrap}
  .ro .v{font-family:"Big Shoulders Display",sans-serif; font-weight:700; font-size:34px; line-height:1.05; font-variant-numeric:tabular-nums; margin-top:2px}
  .ro .v i{font-style:normal; font-size:14px; font-family:Barlow,sans-serif; font-weight:500; color:var(--bone-dim); margin-left:2px}
  .ro .d{font-family:"IBM Plex Mono",monospace; font-size:10px; color:var(--bone-faint)}
  .c-bone{color:var(--bone)} .c-tox{color:var(--tox)} .c-hell{color:var(--hell)} .c-amber{color:var(--amber)} .c-steel{color:var(--steel)}

  .phasestrip{
    display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;
    background:var(--panel); border:1px solid var(--rule); border-left:4px solid var(--hell); padding:12px 16px;
  }
  .phasestrip .lbl{font-family:"IBM Plex Mono",monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:var(--bone-faint)}
  .phasestrip .now{font-family:"Big Shoulders Display",sans-serif; font-weight:700; font-size:24px; text-transform:uppercase; color:var(--bone)}
  .phasestrip .note{color:var(--bone-dim); font-size:14px}

  .cols{display:grid; grid-template-columns:1.55fr 1fr; gap:var(--sp); align-items:start}
  @media (max-width:900px){.cols{grid-template-columns:1fr}}

  section h2{font-size:22px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--bone)}
  .shead{display:flex; align-items:baseline; justify-content:space-between; gap:12px; border-bottom:1px solid var(--rule); padding-bottom:8px; margin-bottom:14px}
  .shead .meta{font-family:"IBM Plex Mono",monospace; font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--bone-faint)}

  /* --- the programme: the stages this session is working, above the gauntlet --- */
  .stages{display:flex; flex-direction:column; gap:6px}
  .stage{
    display:grid; grid-template-columns:auto 1fr auto; gap:14px; align-items:start;
    background:var(--panel); border:1px solid var(--rule); padding:12px 14px;
  }
  .stage.st-done{border-left:4px solid var(--tox)}
  .stage.st-building{border-left:4px solid var(--amber)}
  .stage.st-pending{border-left:4px solid var(--bone-faint); opacity:.66}
  .stage .ix{font-family:"IBM Plex Mono",monospace; font-size:10px; color:var(--hell); padding-top:5px}
  .stage .nm{font-family:"Big Shoulders Display",sans-serif; font-weight:700; font-size:20px; text-transform:uppercase; line-height:1}
  .stage .what{font-size:13px; color:var(--bone-dim); margin-top:4px; line-height:1.45}
  .stage .detail{font-family:"IBM Plex Mono",monospace; font-size:11px; color:var(--bone-faint); margin-top:5px}

  /* --- gauntlet board --- */
  .board{display:flex; flex-direction:column; gap:6px}
  .piece{
    display:grid; grid-template-columns:1fr auto auto; gap:12px; align-items:center;
    background:var(--panel); border:1px solid var(--rule); padding:11px 14px;
  }
  .piece.is-won{border-left:4px solid var(--tox)}
  .piece.is-lost{border-left:4px solid var(--hell)}
  .piece.is-building{border-left:4px solid var(--amber)}
  .piece.is-pending{border-left:4px solid var(--bone-faint); opacity:.72}
  .piece .nm{font-family:"Big Shoulders Display",sans-serif; font-weight:700; font-size:21px; text-transform:uppercase; line-height:1}
  .piece .note{font-size:13px; color:var(--bone-dim); margin-top:3px}
  .piece .gap{font-size:13px; color:var(--amber); margin-top:4px}
  .piece .gap b{font-family:"IBM Plex Mono",monospace; font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--bone-faint); font-weight:400; display:block}
  .rounds{font-family:"IBM Plex Mono",monospace; font-size:11px; color:var(--bone-faint); text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums}
  .chip{
    font-family:"IBM Plex Mono",monospace; font-size:10px; font-weight:600; letter-spacing:.14em;
    padding:5px 9px; border:1px solid currentColor; white-space:nowrap;
  }
  .v-pending{color:var(--bone-faint)} .v-building{color:var(--amber)}
  .v-lost{color:var(--hell)} .v-tied{color:var(--steel)} .v-won{color:var(--tox); background:rgba(134,194,50,.10)}

  /* --- dossier --- */
  .dossier{background:var(--panel); border:1px solid var(--rule); padding:16px}
  .kv{display:grid; grid-template-columns:1fr auto; gap:3px 12px; font-family:"IBM Plex Mono",monospace; font-size:12px; font-variant-numeric:tabular-nums}
  .kv dt{color:var(--bone-dim); padding:4px 0; border-bottom:1px dotted rgba(255,255,255,.07)}
  .kv dd{margin:0; padding:4px 0; text-align:right; border-bottom:1px dotted rgba(255,255,255,.07); color:var(--bone)}
  .kv dd i{font-style:normal; color:var(--bone-faint)}
  .weak{list-style:none; margin:14px 0 0; padding:0; display:flex; flex-direction:column; gap:7px; counter-reset:w}
  .weak li{counter-increment:w; display:grid; grid-template-columns:auto 1fr; gap:9px; font-size:13.5px; color:var(--bone-dim); line-height:1.45}
  .weak li::before{content:counter(w,decimal-leading-zero); font-family:"IBM Plex Mono",monospace; font-size:10px; color:var(--hell); padding-top:3px}
  .weak b{color:var(--bone); font-weight:600}

  /* --- A/B --- */
  .ab{display:grid; grid-template-columns:1fr 1fr; gap:10px}
  @media (max-width:620px){.ab{grid-template-columns:1fr}}
  .shot{background:var(--sunk); border:1px solid var(--rule); overflow:hidden}
  .shot img{display:block; width:100%; height:auto}
  .shot .cap{font-family:"IBM Plex Mono",monospace; font-size:10px; letter-spacing:.14em; text-transform:uppercase; padding:7px 10px; color:var(--bone-dim); border-top:1px solid var(--rule); display:flex; justify-content:space-between; gap:8px}
  .shot .empty{aspect-ratio:16/10; display:grid; place-items:center; color:var(--bone-faint); font-family:"IBM Plex Mono",monospace; font-size:11px; letter-spacing:.12em; text-align:center; padding:20px}

  /* --- log --- */
  .log{display:flex; flex-direction:column; gap:0; font-family:"IBM Plex Mono",monospace; font-size:12.5px}
  .log div{display:grid; grid-template-columns:56px 1fr; gap:12px; padding:7px 0; border-bottom:1px solid rgba(255,255,255,.055); color:var(--bone-dim)}
  .log div:first-child{color:var(--bone)}
  .log time{color:var(--hell)}

  footer{font-family:"IBM Plex Mono",monospace; font-size:11px; color:var(--bone-faint); letter-spacing:.08em; text-align:center; padding-top:8px}
  a{color:var(--steel)}
  a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--amber); outline-offset:2px}
  @media (prefers-reduced-motion:no-preference){
    .piece.is-building{animation:pulse 2.4s ease-in-out infinite}
    @keyframes pulse{0%,100%{border-left-color:var(--amber)}50%{border-left-color:#7a5518}}
  }
</style>

<div class="wrap">

  <div class="statusbar">
    <div class="brand">
      <h1>Doom<br>craft</h1>
      <div class="sub">Gauntlet vs ${esc(S.bar.name)}</div>
    </div>
    <div class="readouts">
      <div class="ro"><div class="k">Pieces won</div><div class="v ${won ? 'c-tox' : 'c-bone'}">${won}<i>/ ${S.pieces.length}</i></div><div class="d">blind A/B</div></div>
      <div class="ro"><div class="k">Our FPS</div><div class="v ${S.ours.fpsMedian >= 60 ? 'c-tox' : S.ours.fpsMedian ? 'c-amber' : 'c-bone'}">${num(S.ours.fpsMedian)}</div><div class="d">bar ${num(S.bar.fpsMedian)}</div></div>
      <div class="ro"><div class="k">1% low</div><div class="v ${S.ours.fps1pctLow >= 55 ? 'c-tox' : S.ours.fps1pctLow ? 'c-amber' : 'c-bone'}">${num(S.ours.fps1pctLow)}</div><div class="d">bar ${num(S.bar.fps1pctLow)}</div></div>
      <div class="ro"><div class="k">Interactive</div><div class="v ${S.ours.timeToInteractiveMs && S.ours.timeToInteractiveMs < S.bar.timeToInteractiveMs ? 'c-tox' : S.ours.timeToInteractiveMs ? 'c-amber' : 'c-bone'}">${ms(S.ours.timeToInteractiveMs)}</div><div class="d">bar ${(S.bar.timeToInteractiveMs / 1000).toFixed(2)}s</div></div>
      <div class="ro"><div class="k">Payload</div><div class="v c-bone">${mb(S.ours.transferBytesCold)}</div><div class="d">bar ${(S.bar.transferBytesCold / 1048576).toFixed(1)}MB</div></div>
    </div>
  </div>

  <div class="phasestrip">
    <span class="lbl">Phase</span>
    <span class="now">${esc(S.phase)}</span>
    <span class="note">${esc(S.phaseNote)}</span>
  </div>

  ${(S.stages || []).length ? `<section>
    <div class="shead"><h2>The programme</h2><span class="meta">${stagesDone}/${S.stages.length} closed · Codex reviews every plan before a line is written</span></div>
    <div class="stages">
      ${S.stages.map((x, i) => {
        const [txt, cls] = STAGE[x.state] || STAGE.pending;
        return `<div class="stage st-${x.state}">
        <div class="ix">${String(i + 1).padStart(2, '0')}</div>
        <div>
          <div class="nm">${esc(x.name)}</div>
          <div class="what">${esc(x.what)}</div>
          ${x.detail ? `<div class="detail">${esc(x.detail)}</div>` : ''}
        </div>
        <div class="chip ${cls}">${txt}</div>
      </div>`;
      }).join('\n      ')}
    </div>
  </section>` : ''}

  <div class="cols">
    <section>
      <div class="shead"><h2>The gauntlet</h2><span class="meta">builder → harsh critic → blind A/B → loop</span></div>
      <div class="board">
        ${S.pieces.map((p) => {
          const [txt, cls] = VERDICT[p.verdict] || VERDICT.pending;
          return `<div class="piece is-${p.verdict}">
          <div>
            <div class="nm">${esc(p.name)}</div>
            <div class="note">${esc(p.note)}</div>
            ${p.verdict !== 'pending' && p.gap ? `<div class="gap"><b>Biggest remaining gap</b>${esc(p.gap)}</div>` : ''}
          </div>
          <div class="rounds">${p.rounds} ${p.rounds === 1 ? 'round' : 'rounds'}</div>
          <div class="chip ${cls}">${txt}</div>
        </div>`;
        }).join('\n        ')}
      </div>
    </section>

    <section>
      <div class="shead"><h2>The bars</h2><span class="meta">measured ${esc(S.bar.capturedAt)}</span></div>
      ${(S.bars || []).length ? `<div class="dossier" style="margin-bottom:10px">
        ${S.bars.map((b) => `<div style="display:grid;grid-template-columns:auto 1fr;gap:9px;padding:5px 0;border-bottom:1px dotted rgba(255,255,255,.07)">
          <span class="chip ${b.captured ? 'v-won' : 'v-building'}" style="padding:2px 6px;font-size:9px">${b.captured ? 'CAPTURED' : 'PENDING'}</span>
          <span style="font-size:13px"><b style="font-family:'Big Shoulders Display',sans-serif;font-size:16px;text-transform:uppercase">${esc(b.name)}</b><br><span style="color:var(--bone-dim)">${esc(b.what)}</span></span>
        </div>`).join('')}
      </div>` : ''}
      <div class="dossier">
        <dl class="kv">
          <dt>Time to title</dt><dd>${S.bar.timeToTitleMs} <i>ms</i></dd>
          <dt>Time to interactive</dt><dd>${(S.bar.timeToInteractiveMs / 1000).toFixed(2)} <i>s</i></dd>
          <dt>Click → shooting</dt><dd>~${Math.round(S.bar.menuToIngameMs / 1000)} <i>s</i></dd>
          <dt>FPS median</dt><dd>${S.bar.fpsMedian}</dd>
          <dt>FPS 1% low</dt><dd>${S.bar.fps1pctLow}</dd>
          <dt>Cold payload</dt><dd>${(S.bar.transferBytesCold / 1048576).toFixed(1)} <i>MB</i></dd>
          <dt>Scripts loaded</dt><dd>${S.bar.scripts}</dd>
        </dl>
        <ol class="weak">
          <li><b>No pace.</b> Minecraft-speed movement in a shooter.</li>
          <li><b>No gunfeel.</b> No muzzle flash, no kick, no shake.</li>
          <li><b>Dead crosshair.</b> Static plus, no spread, no hitmarker.</li>
          <li><b>Flat lighting.</b> No AO, no fog — the beach reads as one mass.</li>
          <li><b>Slow cold open.</b> ~25 s of matchmaking before you shoot.</li>
          <li><b>Ads are menu-only.</b> Rewarded and interstitial surfaces unused.</li>
          <li><b>No enemies.</b> PvP-only; there is no horde to fall into.</li>
        </ol>
      </div>
    </section>
  </div>

  <section>
    <div class="shead"><h2>Blind A/B</h2><span class="meta">same harness · same viewport · labels stripped for the critic</span></div>
    ${pairs.map((p) => `<div style="margin-bottom:14px">
      <div class="ab">
        <figure class="shot" style="margin:0"><img src="${p.barSrc}" alt="${esc(p.label)} — reference"><figcaption class="cap"><span>${esc(p.label)}</span><span>A</span></figcaption></figure>
        ${p.oursSrc
          ? `<figure class="shot" style="margin:0"><img src="${p.oursSrc}" alt="${esc(p.label)} — ours"><figcaption class="cap"><span>${esc(p.label)}</span><span>B</span></figcaption></figure>`
          : `<div class="shot"><div class="empty">B — awaiting build</div><div class="cap"><span>${esc(p.label)}</span><span>B</span></div></div>`}
      </div>
    </div>`).join('\n    ')}
  </section>

  <section>
    <div class="shead"><h2>Run log</h2><span class="meta">newest first</span></div>
    <div class="log">
      ${[...S.log].reverse().map((l) => `<div><time>${esc(l.t)}</time><span>${esc(l.m)}</span></div>`).join('\n      ')}
    </div>
  </section>

  <footer>Updated ${esc(S.updated.replace('T', ' ').replace('Z', ' UTC'))} · exit condition is winning the blind comparison, not a round count</footer>
</div>
`;

fs.writeFileSync(path.join(DIR, 'index.html'), html);
console.log(`wrote index.html  ${(html.length / 1024).toFixed(0)} KB  ·  ${won}/${S.pieces.length} pieces won`);
