/**
 * 最小验证：后台广播 scan-page / scan-image / scan-progress，弹窗能收到哪几种？
 * 目的：定位"后台发了但 popup 收不到"的原因（消息序列化 / 监听器 / 时序）
 * 用法：node tools/msg-probe.js
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
const USER = path.join(ROOT, '.msg-profile');
const PORT = 9338;
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

  const list = await httpJson('/json/list');
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  const extId = sw.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

  const popupTab = await httpJson('/json/new?' + encodeURIComponent(`chrome-extension://${extId}/popup.html`), 'PUT');
  const popup = await CDP.connect(popupTab.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  await sleep(1200);

  // 弹窗侧装一个计数器
  await popup.send('Runtime.evaluate', {
    expression: `(() => { self.__c = {}; self.__err = null;
      chrome.runtime.onMessage.addListener((m) => { if (m && m.type) self.__c[m.type] = (self.__c[m.type]||0)+1; });
      window.addEventListener('error', (e) => { self.__err = String(e.message); });
      return 'ok'; })()`,
    returnByValue: true
  });

  const swCdp = await CDP.connect(sw.webSocketDebuggerUrl);
  await swCdp.send('Runtime.enable');

  // 从后台依次广播四种事件
  const sent = await swCdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const out = [];
      const trySend = (payload) => {
        try { chrome.runtime.sendMessage(payload); out.push(payload.type + ':sent'); }
        catch (e) { out.push(payload.type + ':THROW ' + e.message); }
      };
      trySend({ type: 'scan-progress', processed: 1, queued: 2, total: 3, batch: 1 });
      await new Promise(r => setTimeout(r, 200));
      trySend({ type: 'scan-page', url: 'https://example.com/2/', ms: 123, images: 16, error: null });
      await new Promise(r => setTimeout(r, 200));
      trySend({ type: 'scan-image', url: 'https://example.com/a.webp', width: 1200, height: 1800, mime: 'image/webp', bytes: 12345 });
      await new Promise(r => setTimeout(r, 200));
      trySend({ type: 'probe-progress', done: 1, total: 3 });
      await new Promise(r => setTimeout(r, 500));
      return out.join(' | ');
    })()`,
    awaitPromise: true, returnByValue: true
  });
  let sr = sent.result;
  if (sr && sr.result !== undefined) sr = sr.result;
  console.log('后台发送记录:', sr && sr.value);

  const got = await popup.send('Runtime.evaluate', {
    expression: `JSON.stringify({ counts: self.__c || {}, err: self.__err })`,
    returnByValue: true
  });
  let gv = got.result;
  if (gv && gv.result !== undefined) gv = gv.result;
  console.log('弹窗收到统计:', gv && gv.value);

  const c = JSON.parse((gv && gv.value) || '{"counts":{}}').counts;
  for (const t of ['scan-progress', 'scan-page', 'scan-image', 'probe-progress']) {
    console.log(`  ${c[t] ? '[收到]' : '[丢失]'} ${t}`);
  }

  console.log('\n=== 第二阶段：走真实 UI 路径（点「扫描页面」按钮）===');
  // 先开目标页并激活
  const TARGET = process.argv[2] ||
    'https://everia.club/2026/10/05/flash-2026-08-04-%e3%83%95%e3%83%a9%e3%83%83%e3%82%b7%e3%83%a5-2026%e5%b9%b48%e6%9c%884%e6%97%a5%e5%8f%b7/';
  const TARGET_HOST = (() => { try { return new URL(TARGET).hostname; } catch (e) { return 'everia.club'; } })();
  await httpJson('/json/new?' + encodeURIComponent(TARGET), 'PUT');
  for (let i=0;i<40;i++){ await sleep(500); const tg=(await httpJson('/json/list')).find(t=>t.url&&t.url.indexOf('everia.club')>=0); if(tg) break; }
  await sleep(1500);

  const uiResult = await popup.send('Runtime.evaluate', {
    expression: `(async () => {
      self.__c = {}; self.__errs = []; self.__polls = 0; self.__applied = 0;
      window.addEventListener('error', (e) => { self.__errs.push('err:' + String(e.message)); });
      window.addEventListener('unhandledrejection', (e) => { self.__errs.push('rej:' + String(e.reason)); });
      const tabs = await chrome.tabs.query({});
      const TARGET_HOST = ${JSON.stringify(TARGET_HOST)};

      const t = tabs.find(x => x.url && x.url.indexOf(TARGET_HOST) >= 0);
      if (!t) return JSON.stringify({ error: 'no target tab' });
      await chrome.tabs.update(t.id, { active: true });

      document.getElementById('btnScan').click();
      const t0 = Date.now();
      const live = [];
      while (Date.now() - t0 < 120000) {
        await new Promise(r => setTimeout(r, 400));
        const st = self.__imgdTest.state;
        live.push({ t: Date.now() - t0, cards: document.querySelectorAll('.card').length, busy: st.busy });
        if (!st.busy) break;
      }

      const st = self.__imgdTest.state;
      return JSON.stringify({
        probedSize: st.probed.size,
        pageStats: st.pageStats.length,
        selected: st.selected.size,
        jobTotal: st.job ? st.job.images.length : 0,
        cards: document.querySelectorAll('.card').length,
        status: document.getElementById('status').textContent,
        meta: document.getElementById('meta').textContent,
        errs: self.__errs.slice(0, 8),
        live: live.filter((x,i)=>i%3===0||i===live.length-1).slice(0,10),
        elapsed: Date.now() - t0
      });
    })()`,
    awaitPromise: true, returnByValue: true
  });
  let ur = uiResult.result;
  if (ur && ur.result !== undefined) ur = ur.result;
  if (uiResult.exceptionDetails) {
    console.log('  UI 路径异常:', uiResult.exceptionDetails.text,
      (uiResult.exceptionDetails.exception || {}).description || '');
  } else {
    const u = (ur && typeof ur.value === 'string') ? JSON.parse(ur.value) : { error: '返回不是字符串: ' + JSON.stringify(ur).slice(0, 200) };
    if (u.error) {
      console.log('  失败:', u.error);
    } else {
      console.log('  probed =', u.probedSize, ' pageStats =', u.pageStats, ' selected =', u.selected, ' jobTotal =', u.jobTotal);
      console.log('  卡片 =', u.cards, ' 耗时 =', u.elapsed + 'ms');
      console.log('  状态栏 =', u.status);
      console.log('  统计行 =', u.meta);
      if (u.errs && u.errs.length) console.log('  JS 报错:', JSON.stringify(u.errs));
      console.log('  扫描期间卡片增长:');
      (u.live||[]).forEach(x=>console.log('    t='+x.t+'ms  cards='+x.cards+'  busy='+x.busy));
    }
  }

  // 取后台收到的消息日志（临时诊断）
  try {
    const rxQ = await swCdp.send('Runtime.evaluate', {
      expression: `JSON.stringify(self.__rxLog || [])`, returnByValue: true
    });
    let rv = rxQ.result; if (rv && rv.result !== undefined) rv = rv.result;
    const rx = JSON.parse((rv && rv.value) || '[]');
    const counts = {};
    for (const x of rx) { const t = String(x).split('@')[0]; counts[t] = (counts[t] || 0) + 1; }
    console.log('\n  后台实际收到的消息类型统计:', JSON.stringify(counts));
    console.log('  最后 12 条:', rx.slice(-12).join(', '));
  } catch (e) { console.log('  取后台日志失败:', e.message); }

  popup.close(); swCdp.close(); child.kill();
  await sleep(1200);
  try { fs.rmSync(USER, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch (e) { /* 忽略 */ }
})().catch((e) => { console.error('异常:', (e && e.stack) || e); process.exit(1); });
