/**
 * 用 Chrome（扩展同一条网络通道）测分页抓取的真实耗时。
 * 客户端测不准无所谓 —— 关键是浏览器侧要多久。
 * 用法：node tools/page-cost-chrome.js [文章URL]
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
const USER = path.join(ROOT, '.cost-profile');
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = process.argv[2] ||
  'https://everia.club/2026/10/05/flash-2026-08-04-%e3%83%95%e3%83%a9%e3%83%83%e3%82%b7%e3%83%a5-2026%e5%b9%b48%e6%9c%884%e6%97%a5%e5%8f%b7/';

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
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }); }
  static connect(u) { return new Promise((res, rej) => { const ws = new WebSocket(u);
    ws.addEventListener('open', () => res(new CDP(ws))); ws.addEventListener('error', () => rej(new Error('ws fail'))); }); }
  send(method, params) { const id = ++this.id;
    return new Promise((r) => { this.pending.set(id, r); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

(async () => {
  fs.rmSync(USER, { recursive: true, force: true });
  fs.mkdirSync(USER, { recursive: true });
  const child = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER}`,
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, '--no-first-run', '--headless=new', 'about:blank'],
    { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await httpJson('/json/version'); break; } catch (e) { await sleep(400); } }
  await sleep(2500);

  const sw = (await httpJson('/json/list')).find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  const cdp = await CDP.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const expr = `(async () => {
    const BASE = ${JSON.stringify(BASE)};
    const pageUrl = (n) => n === 1 ? BASE : BASE.replace(/\\/$/, '') + '/' + n + '/';
    const time = async (url) => {
      const t0 = performance.now();
      try {
        const r = await fetch(url, { credentials: 'include' });
        const txt = await r.text();
        return { ms: Math.round(performance.now() - t0), status: r.status, kb: Math.round(txt.length / 1024) };
      } catch (e) {
        return { ms: Math.round(performance.now() - t0), status: 0, err: String(e && e.message || e) };
      }
    };

    // 1) 串行测 3 页：拿到干净的"单页响应时间"
    const serial = [];
    for (let i = 1; i <= 3; i++) serial.push(Object.assign({ page: i }, await time(pageUrl(i))));

    // 2) 并发 4 测 8 页：复刻扩展的分批行为，测总墙钟
    const t0 = performance.now();
    const marks = [];
    const urls = Array.from({ length: 8 }, (_, i) => pageUrl(i + 1));
    for (let i = 0; i < urls.length; i += 4) {
      const b = urls.slice(i, i + 4);
      const tb = performance.now();
      const rs = await Promise.all(b.map(time));
      marks.push({ batch: i / 4 + 1, ms: Math.round(performance.now() - tb), slowest: Math.max(...rs.map(r => r.ms)) });
    }
    const concurrentTotal = Math.round(performance.now() - t0);

    // 3) 并发 8 单轮
    const t1 = performance.now();
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => time(pageUrl(i + 1))));
    const singleRound = Math.round(performance.now() - t1);

    // 4) 一张图的 Range 探测耗时
    const imgUrl = (() => {
      return null; // 由外部传入更可靠，这里跳过
    })();

    return JSON.stringify({ serial, marks, concurrentTotal, singleRound, singleRoundSlowest: Math.max(...all.map(r => r.ms)) });
  })()`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  let payload = r && r.result;
  if (payload && payload.result !== undefined) payload = payload.result;
  if (r.exceptionDetails) {
    console.log('求值异常:', r.exceptionDetails.text, (r.exceptionDetails.exception || {}).description || '');
  } else if (payload && typeof payload.value === 'string') {
    const d = JSON.parse(payload.value);
    console.log('=== 1. 串行抓 3 页（浏览器侧真实响应时间）===');
    for (const s of d.serial) console.log(`  第${s.page}页: ${s.ms}ms  status=${s.status}  ${s.kb}KB${s.err ? '  ERR=' + s.err : ''}`);
    const avg = Math.round(d.serial.reduce((a, s) => a + s.ms, 0) / d.serial.length);
    console.log(`  平均 ${avg}ms/页`);
    console.log('\n=== 2. 复刻扩展逻辑：并发 4、分两批抓 8 页 ===');
    for (const m of d.marks) console.log(`  批${m.batch}: ${m.ms}ms（该批最慢 ${m.slowest}ms）`);
    console.log(`  总墙钟 ${d.concurrentTotal}ms`);
    console.log('\n=== 3. 并发 8 单轮抓 8 页（无批次屏障）===');
    console.log(`  总墙钟 ${d.singleRound}ms（最慢一页 ${d.singleRoundSlowest}ms）`);
    console.log('\n=== 结论 ===');
    console.log(`  单页响应约 ${avg}ms → 这是站点的固有成本，扩展改不动`);
    console.log(`  批次屏障造成的额外等待：${d.concurrentTotal - d.singleRound}ms`);
    console.log(`  8 页的理论下限 ≈ ${avg}ms（全部并发且站点不限速）`);
  }
  cdp.close();
  child.kill();
  await sleep(1200);
  try { fs.rmSync(USER, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch (e) { /* 忽略 */ }
})().catch((e) => { console.error('异常:', (e && e.stack) || e); process.exit(1); });
