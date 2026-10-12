/**
 * 聚焦诊断：两个具体失败点
 *  A. 为什么文件名正则不匹配（打印 JSON.stringify 与逐条 test 结果）
 *  B. 为什么 ZIP 落成了随机 UUID 名字（对比 中文名 / ASCII 名 两种 filename）
 * 用法：node tools/diag.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { findBrowser, downloadsDir } = require('./lib/harness');

const EDGE = findBrowser();
const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const USER = path.join(ROOT, '.diag-profile');
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(p, m) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m || 'GET' }, (x) => {
      let d = ''; x.on('data', (c) => (d += c));
      x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0, 120))); } });
    });
    r.on('error', rej); r.end();
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error('ws fail')));
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((r) => { this.pending.set(id, r); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
}

(async () => {
  fs.rmSync(USER, { recursive: true, force: true });
  fs.mkdirSync(USER, { recursive: true });
  console.log('=== A. 正则匹配诊断（用 e2e 实际拿到的路径字符串）===');
  // 从下载目录里找真实样本（没有就跳过这一步）
  const dl = process.env.DOWNLOAD_DIR || path.join(require('os').homedir(), 'Downloads');
  const names = [];
  try {
    for (const dir of fs.readdirSync(dl)) {
      const full = path.join(dl, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) if (/\.(webp|png|jpe?g)$/i.test(f)) names.push(path.join(full, f));
      if (names.length) break;
    }
  } catch (e) { /* 忽略 */ }
  if (!names.length) console.log('  （下载目录里没有样本，跳过正则诊断）');
  const re = /[0-9][0-9][0-9]_GRA10V097_[0-9]+_1200x1800( \([0-9]+\))?\.webp$/;
  for (const n of names) {
    console.log('  name =', JSON.stringify(n));
    console.log('    test =', re.test(n), ' 尾部50字符 =', JSON.stringify(n.slice(-50)));
  }

  console.log('\n=== B. downloads 文件名行为诊断 ===');
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER}`,
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    '--no-first-run', '--headless=new', 'about:blank'
  ], { stdio: 'ignore' });

  for (let i = 0; i < 50; i++) { try { await httpJson('/json/version'); break; } catch (e) { await sleep(400); } }
  await sleep(2500);

  const list = await httpJson('/json/list');
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  if (!sw) { console.log('找不到 SW'); child.kill(); return; }
  const cdp = await CDP.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 1x1 PNG，用 data URL（注意：SW 里没有 createObjectURL，这本身就是那条约束的又一次印证）
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const expr = `(async () => {
    const url = 'data:image/png;base64,${pngB64}';
    const out = [];
    const tryOne = async (filename) => {
      const id = await new Promise(res => chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }, d => res(chrome.runtime.lastError ? 'ERR:' + chrome.runtime.lastError.message : d)));
      if (typeof id === 'string') { out.push({ asked: filename, got: null, state: 'REJECTED', err: id }); return; }
      await new Promise(r => setTimeout(r, 1500));
      const item = (await chrome.downloads.search({ id }))[0];
      out.push({ asked: filename, got: item ? item.filename : null, state: item ? item.state : null, err: item ? item.error : null, byExt: item ? item.byExtensionId : null });
    };
    await tryOne('测试目录/テスト_中文名前.png');
    await tryOne('ascii-folder/ascii-name.png');
    await tryOne('naïve – dash.png');
    await tryOne('plain.png');
    return JSON.stringify(out);
  })()`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    console.log('  求值异常:', r.exceptionDetails.text, (r.exceptionDetails.exception || {}).description || '');
    child.kill();
    return;
  }
  const val = r.result && r.result.value;
  if (val && typeof val === 'string') {
    const arr = JSON.parse(val);
    for (const x of arr) {
      const base = x.got ? x.got.split('\\').pop() : null;
      const dir = x.got ? x.got.split('\\').slice(-2, -1)[0] : null;
      console.log(`  请求名: ${JSON.stringify(x.asked)}`);
      console.log(`    实际: 目录=${JSON.stringify(dir)} 文件=${JSON.stringify(base)} state=${x.state}${x.err ? ' err=' + x.err : ''}`);
      console.log(`    保留原名? ${base && x.asked.endsWith(base) ? 'YES' : 'NO（被改写）'}`);
    }
  } else {
    console.log('  求值失败:', JSON.stringify(r).slice(0, 500));
  }
  child.kill();
})().catch((e) => { console.error('诊断异常:', e && e.stack || e); process.exit(1); });
