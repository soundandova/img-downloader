const { spawn } = require('child_process');
const http = require('http');
const path = require('path'), fs = require('fs');
const { findBrowser, downloadsDir } = require('./lib/harness');
const EDGE = findBrowser();
const ROOT = path.join(__dirname, '..');
const EXT=path.join(ROOT,'extension');
const USER=path.join(ROOT,'.probe-profile');
const PORT=9334;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpJson(p,m){return new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port:PORT,path:p,method:m||'GET'},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(new Error('not json: '+d.slice(0,120)))}})});r.on('error',rej);r.end();});}
(async()=>{
  console.log('EXT =', EXT, '存在:', fs.existsSync(path.join(EXT,'manifest.json')));
  fs.rmSync(USER,{recursive:true,force:true}); fs.mkdirSync(USER,{recursive:true});
  const child=spawn(EDGE,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${USER}`,`--load-extension=${EXT}`,`--disable-extensions-except=${EXT}`,'--no-first-run','--headless=new','--disable-features=msEdgeSidebarV2','about:blank'],{stdio:'ignore'});
  for(let i=0;i<50;i++){ try{ await httpJson('/json/version'); break;}catch(e){ await sleep(400);} }
  await sleep(3000);
  const list=await httpJson('/json/list');
  console.log('\n=== 目标列表 ===');
  list.forEach(t=>console.log(`  type=${t.type.padEnd(16)} ${t.url.slice(0,90)}`));
  const t=list.find(x=>x.type==='service_worker'&&x.url.includes('background.js')) || list.find(x=>x.type.includes('service'));
  if(!t){ console.log('\n找不到 SW 目标'); child.kill(); return; }
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r));
  let id=0; const pend=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  const send=(method,params)=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params:params||{}}));});
  await send('Runtime.enable');
  const r=await send('Runtime.evaluate',{expression:`JSON.stringify({
    selfType: self.constructor.name,
    hasURL: typeof URL,
    URLstatics: Object.getOwnPropertyNames(URL).join(','),
    hasCreateObjectURL: typeof URL.createObjectURL,
    hasBlob: typeof Blob,
    hasFileReader: typeof FileReader,
    hasOffscreenCanvas: typeof OffscreenCanvas,
    hasCreateImageBitmap: typeof createImageBitmap,
    hasDocument: typeof document,
    hasDOMParser: typeof DOMParser,
    hasJSZip: typeof JSZip
  })`,returnByValue:true});
  console.log('\n=== MV3 service worker 能力实测 ===');
  console.log(JSON.stringify(JSON.parse(r.result.result.value),null,1));
  child.kill();
  fs.rmSync(USER,{recursive:true,force:true});
})();

