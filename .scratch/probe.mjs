import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT='/Users/karstenhaldan/youtube/doomcraft';
const PORT=5199;
function portOpen(p){return new Promise(r=>{const s=net.connect({port:p,host:'127.0.0.1'},()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.setTimeout(600,()=>{s.destroy();r(false)})})}
const vite=spawn('npx',['vite','--config','client/vite.config.ts','--port',String(PORT)],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
vite.stderr.on('data',d=>process.stderr.write('[vite] '+d));
for(let i=0;i<200;i++){if(await portOpen(PORT))break;await new Promise(r=>setTimeout(r,200));}
await new Promise(r=>setTimeout(r,600));

const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--use-gl=angle']});
const ctx=await browser.newContext({viewport:{width:1280,height:720}});
const page=await ctx.newPage();
const errs=[];
page.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,300))});
page.on('pageerror',e=>errs.push('PAGEERR '+String(e).slice(0,400)));
await page.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded'});
try{
await page.waitForFunction(()=>window.__DC__&&window.__DC__.ready===true,null,{timeout:60000});
}catch(e){
  console.log('READY FAIL', JSON.stringify(errs.slice(0,10),null,1));
  await page.screenshot({path:ROOT+'/.scratch/fail.png'});
  await browser.close(); vite.kill(); process.exit(1);
}
console.log('READY ok, levels=',JSON.stringify(await page.evaluate(()=>window.__DC__.levelIds())));
await page.waitForTimeout(1200);
await page.screenshot({path:ROOT+'/.scratch/menu.png'});

for (const m of ['quest','builder','horde','deathmatch']) {
  const t=Date.now();
  let got='';
  try { got = await page.evaluate((k)=>window.__DC__.enterMode(k), m); }
  catch(e){ got='THREW '+String(e).slice(0,200); }
  await page.waitForTimeout(2500);
  const st = await page.evaluate(()=>({mode:window.__DC__.modeStats(), g:window.__DC__.stats(),
    overlays: window.__DC__.game.renderer.overlays?.length ?? -1,
    vmVisible: window.__DC__.game.viewmodel.root?.visible,
    ents: window.__DC__.game.net.entities.filter(e=>e.active && e.type<=4).length,
  }));
  console.log(`== ${m} -> ${got} in ${Date.now()-t}ms`);
  console.log('   ', JSON.stringify(st.mode));
  console.log('   ', JSON.stringify(st.g));
  await page.screenshot({path:`${ROOT}/.scratch/mode-${m}.png`});
  await page.evaluate(()=>window.__DC__.leaveMode());
  await page.waitForTimeout(400);
  console.log('   after leave scope=', JSON.stringify(await page.evaluate(()=>window.__DC__.modeScope())));
}
console.log('ERRORS', JSON.stringify(errs.slice(0,15),null,1));
await browser.close(); vite.kill();
