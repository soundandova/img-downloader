/**
 * 真机端到端验证（Edge + DevTools Protocol）
 *
 * 验证：
 *  1. 扩展能被 Edge 正常加载（manifest 无错）
 *  2. background service worker 起得来、内部函数与 JSZip 就位
 *  3. 在扩展上下文里调用真实 background：scan（注入采集 + 分页爬取）→ probe（Range 探测真实尺寸）
 *  4. 断言扫描结果与真实站点期望一致
 *
 * 用法：node tools/e2e.js [目标URL]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { findBrowser, downloadsDir } = require('./lib/harness');

const EDGE = findBrowser();
const EXT_DIR = path.join(__dirname, '..', 'extension');
const USER_DIR = path.join(__dirname, '..', '.e2e-profile');
const PORT = 9333;

const TARGET_URL = process.argv[2] && process.argv[2].indexOf('http') === 0 ? process.argv[2] :
  'https://everia.club/2026/10/09/rina-saito-%e6%96%89%e8%97%a4%e9%87%8c%e5%a5%88-parade%e3%83%87%e3%82%b8%e3%82%bf%e3%83%ab%e3%83%95%e3%82%a9%e3%83%88%e3%83%96%e3%83%83%e3%82%af-%e3%81%9a%e3%81%a3%e3%81%a8%e8%a6%8b%e3%81%a4/';
// --full：额外跑一次"全部图片"的真实 ZIP（用户实际会跑的那一次，约 35MB / 110+ 张）
const FULL = process.argv.includes('--full');
const TARGET_HOST = (() => { try { return new URL(TARGET_URL).hostname; } catch (e) { return 'everia.club'; } })();

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取 Runtime.evaluate 的返回值：CDP 在不同路径下会单层/双层包装，统一处理 */
function evalValue(resp) {
  let r = resp && resp.result;
  if (r && r.result !== undefined && r.value === undefined) r = r.result;
  return r ? r.value : undefined;
}

/** 取 Runtime.evaluate 的返回值并 JSON.parse（返回非字符串时给出明确错误） */
function evalJson(resp, what) {
  if (resp && resp.exceptionDetails) {
    throw new Error((what || '求值') + ' 抛异常: ' + resp.exceptionDetails.text + ' ' +
      ((resp.exceptionDetails.exception || {}).description || ''));
  }
  const v = evalValue(resp);
  if (typeof v !== 'string') {
    throw new Error((what || '求值') + ' 返回不是字符串: ' + JSON.stringify(v).slice(0, 200));
  }
  return JSON.parse(v);
}

function httpJson(urlPath, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: method || 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('not JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const openTab = (url) => httpJson('/json/new?' + encodeURIComponent(url), 'PUT');

async function waitForDevtools(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await httpJson('/json/version'); } catch (e) { await sleep(400); }
  }
  throw new Error('DevTools port not ready');
}

/** 极简 CDP 客户端（Node 24 自带全局 WebSocket） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')));
        else resolve(msg.result);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error('WS connect failed')));
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 240000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

function findExtensionId(userDir) {
  const prefs = path.join(userDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefs)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(prefs, 'utf8'));
    const settings = (j.extensions && j.extensions.settings) || {};
    for (const [id, v] of Object.entries(settings)) {
      const p = (v && v.path) || '';
      if (p && path.resolve(p).toLowerCase() === path.resolve(EXT_DIR).toLowerCase()) return id;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

(async () => {
  console.log('=== E2E (Edge + CDP) ===');
  console.log('extension:', EXT_DIR);
  console.log('target   :', TARGET_URL);

  rmrf(USER_DIR);
  fs.mkdirSync(USER_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    'about:blank'
  ];

  const child = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let version;
  try {
    version = await waitForDevtools(30000);
    console.log('\nbrowser:', version.Browser);
  } catch (e) {
    console.log('[FAIL] DevTools not ready:', e.message);
    console.log(stderr.slice(0, 2000));
    child.kill();
    process.exit(1);
  }

  await sleep(2500);

  console.log('\n=== 1. extension load ===');
  const targets = await httpJson('/json/list');
  const swTarget = targets.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  let extId = null;
  if (swTarget) {
    const m = swTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//);
    if (m) extId = m[1];
  }
  if (!extId) extId = findExtensionId(USER_DIR);
  check('extension loaded by Edge (got id)', !!extId, extId || 'not found');
  if (extId) console.log('      ext id:', extId);
  check('background service worker running', !!swTarget, swTarget ? swTarget.url : 'no service_worker target');

  console.log('\n=== 2. service worker sanity ===');
  if (swTarget) {
    const cdp = await CDP.connect(swTarget.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `(() => ({
        hasJSZip: typeof JSZip !== 'undefined',
        jsZipVer: (typeof JSZip !== 'undefined' && JSZip.version) || null,
        hasParse: typeof parseImageSize === 'function',
        hasProbe: typeof probeSize === 'function',
        hasCrawl: typeof crawlPages === 'function',
        hasCollector: typeof collectPageInDom === 'function',
        hasListing: typeof parseListingHtml === 'function'
      }))()`,
      returnByValue: true
    });
    const v = evalValue(probe) || {};
    check('SW does not load JSZip (ZIP lives in popup)', v.hasJSZip === false, JSON.stringify(v));
    check('parseImageSize defined', v.hasParse === true);
    check('probeSize defined', v.hasProbe === true);
    check('crawlPages defined', v.hasCrawl === true);
    check('collectPageInDom defined', v.hasCollector === true);
    check('parseListingHtml defined', v.hasListing === true);

    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const sizeTest = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const bin = atob('${pngB64}');
        const u8 = new Uint8Array(bin.length);
        for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
        const s = parseImageSize(u8.buffer);
        return s ? (s.width + 'x' + s.height + ':' + s.format) : 'null';
      })()`,
      returnByValue: true
    });
    check('SW-side PNG parse = 1x1:png', evalValue(sizeTest) === '1x1:png', String(evalValue(sizeTest)));
    cdp.close();
  }

  console.log('\n=== 3. open target page ===');
  const pageTarget = await openTab(TARGET_URL);
  check('target page opened', !!pageTarget.webSocketDebuggerUrl, pageTarget.url);
  const page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  // 站点响应不稳（实测单页 350ms ~ 12s），所以轮询等图片真的出现，而不是死等固定时长
  let pi = { title: '', imgs: 0 };
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const pageInfo = await page.send('Runtime.evaluate', {
      expression: `JSON.stringify({title: document.title, imgs: document.images.length, ready: document.readyState})`,
      returnByValue: true
    });
    pi = evalJson(pageInfo, '页面信息');
    if (pi.imgs > 0) break;
  }
  console.log('      title:', pi.title);
  console.log('      <img>:', pi.imgs, ' readyState:', pi.ready);
  check('target page rendered <img>', pi.imgs > 0, String(pi.imgs));

  console.log('\n=== 4. run real scan + probe in extension context ===');
  check('have extension id', !!extId);
  if (extId) {
    const popupTab = await openTab(`chrome-extension://${extId}/popup.html`);
    const popup = await CDP.connect(popupTab.webSocketDebuggerUrl);
    await popup.send('Runtime.enable');
    await sleep(1500);

    const okCtx = await popup.send('Runtime.evaluate', {
      expression: `typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id`,
      returnByValue: true
    });
    check('popup page has chrome.runtime (extension context)', evalValue(okCtx) === true);

    console.log('\n=== 4a. 真实点击 UI（验证按钮不再卡灰）===');
    // 监听后台广播的所有事件，确认 scan-page / scan-image 真的发出来了
    await popup.send('Runtime.evaluate', {
      expression: `(() => {
        self.__evt = { counts: {}, firstAt: {} };
        self.__imgdCounts = {};
        self.__imgdErrs = [];
        window.addEventListener('error', (e) => { self.__imgdErrs.push(String(e.message)); });
        window.addEventListener('unhandledrejection', (e) => { self.__imgdErrs.push('rej: ' + String(e.reason)); });
        const t0 = Date.now();
        chrome.runtime.onMessage.addListener((m) => {
          if (!m || !m.type) return;
          self.__evt.counts[m.type] = (self.__evt.counts[m.type] || 0) + 1;
          if (!self.__evt.firstAt[m.type]) self.__evt.firstAt[m.type] = Date.now() - t0;
        });
        return 'listening';
      })()`,
      returnByValue: true
    });
    // 把目标页激活，然后像用户一样点「扫描页面」按钮，等它跑完
    const beforeState = await popup.send('Runtime.evaluate', {
      expression: `(async () => {
        const TARGET_HOST = ${JSON.stringify(TARGET_HOST)};
        const all = await chrome.tabs.query({});
        const target = all.find(t => t.url && t.url.indexOf(TARGET_HOST) >= 0);
        if (target) await chrome.tabs.update(target.id, { active: true });
        return JSON.stringify({
          scanDisabled: document.getElementById('btnScan').disabled,
          zipDisabled: document.getElementById('btnZip').disabled,
          dlDisabled: document.getElementById('btnDl').disabled
        });
      })()`,
      awaitPromise: true, returnByValue: true
    });
    const bs = evalJson(beforeState, '按钮状态');
    console.log('      扫描前按钮状态:', JSON.stringify(bs));
    check('初始状态：ZIP 灰（还没扫描）', bs.zipDisabled === true);

    // 点击「扫描页面」并等待结束
    const clickScan = await popup.send('Runtime.evaluate', {
      expression: `(async () => {
        document.getElementById('btnScan').click();
        const t0 = Date.now();
        while (Date.now() - t0 < 300000) {
          await new Promise(r => setTimeout(r, 300));
          if (!self.__imgdTest.state.busy) break;
        }
        const s = self.__imgdTest.state;
        // 注意：注入的字符串是模板字面量，正则里的 \\/ 和 \\d 会被当转义序列吃掉，
        // 导致注入代码语法错误。这里改用不含反斜杠的写法。
        const pageDetail = (s.pageStats || []).map((p) => {
          const parts = String(p.url || '').split('/').filter(Boolean);
          const last = parts[parts.length - 1] || '1';
          const n = parseInt(last, 10);
          return { page: isNaN(n) ? 1 : n, imgs: p.images, ms: p.ms, err: p.error || null };
        });
        return JSON.stringify({
          busy: s.busy,
          total: s.job ? s.job.images.length : 0,
          selected: s.selected.size,
          cards: document.querySelectorAll('.card').length,
          status: document.getElementById('status').textContent,
          zipDisabled: document.getElementById('btnZip').disabled,
          dlDisabled: document.getElementById('btnDl').disabled,
          zipTitle: document.getElementById('btnZip').title,
          pageStats: (s.pageStats || []).length,
          pageDetail,
          slowPages: (s.pageStats || []).filter((p) => p.ms > 3000).length,
          meta: document.getElementById('meta').textContent,
          elapsedMs: Date.now() - t0
        });
      })()`,
      awaitPromise: true, returnByValue: true
    });
    const as = evalJson(clickScan, '扫描结果');
    console.log('      扫描后按钮状态: ZIP disabled=' + as.zipDisabled + '  下载 disabled=' + as.dlDisabled);
    console.log('      网格卡片数 =', as.cards, ' 选中 =', as.selected);
    console.log('      扫描总耗时 =', as.elapsedMs + 'ms', ' 页级统计条数 =', as.pageStats, ' 慢页 =', as.slowPages);
    console.log('      每页抓到张数:', (as.pageDetail || []).map((p) => 'p' + p.page + ':' + p.imgs + (p.err ? '(ERR)' : '')).join(' '));
    console.log('      状态栏 =', as.status);
    console.log('      统计行 =', as.meta);
    check('扫描完成后 busy 已复位', as.busy === false, String(as.busy));
    check('扫描后「打包 ZIP」变为可用', as.zipDisabled === false, 'ZIP 仍禁用');
    check('扫描后「下载选中」变为可用', as.dlDisabled === false, '下载仍禁用');
    check('网格渲染出卡片', as.cards > 0, String(as.cards));
    check('默认已自动勾选', as.selected > 0, String(as.selected));
    check('页级耗时统计已上报（可定位慢页）', as.pageStats >= 1, String(as.pageStats));

    // 说明：早先这里靠 chrome.runtime.sendMessage 的 result 广播来收结果，实测该通道
    // 在本机不可靠（同一上下文里后装的监听器收得到、先装的收不到）。所以下载/打包改为
    // 通过**真实按钮**驱动 + 轮询 popup 状态 + 最后查 downloads 表来验证。
    // 点击「下载选中」，然后由宿主侧分次轮询状态（避免单次 CDP 调用被长任务拖超时）
    const dlStart = await popup.send('Runtime.evaluate', {
      expression: `(() => {
        const st = self.__imgdTest.state;
        const keep = new Set((st.job ? st.job.images : []).slice(0, 3).map(i => i.url));
        st.selected.clear();
        for (const u of keep) st.selected.add(u);
        document.getElementById('status').textContent = '__PRE__';
        self.__imgdTest.els.btnDl.click();
        return JSON.stringify({ selected: st.selected.size });
      })()`,
      returnByValue: true
    });
    const dlStarted = evalJson(dlStart, '下载启动');
    check('已把选中数收窄到 3 张', dlStarted.selected === 3, String(dlStarted.selected));

    let dlStatus = '';
    let dlFailed = 0;
    const dlT0 = Date.now();
    let dlSawBusy = false;
    while (Date.now() - dlT0 < 300000) {
      await sleep(500);
      const s = await popup.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          busy: self.__imgdTest.state.busy,
          status: document.getElementById('status').textContent,
          failed: (self.__imgdTest.state.failures || []).length
        })`,
        returnByValue: true
      });
      const v = evalJson(s, '下载状态');
      dlStatus = v.status;
      dlFailed = v.failed;
      if (v.busy) dlSawBusy = true;
      if (dlSawBusy && !v.busy) break;
      if (!dlSawBusy && v.status !== '__PRE__' && !v.busy && /完成|失败|保存/.test(v.status)) break;
    }
    const dl = { selected: dlStarted.selected, status: dlStatus, failed: dlFailed, elapsed: Date.now() - dlT0 };
    console.log('      逐张下载:', JSON.stringify(dl));
    check('逐张下载完成且无失败',
      dlFailed === 0 && /完成|已保存/.test(dl.status), JSON.stringify(dl));

    // 打包 ZIP 同理
    const zipStart = await popup.send('Runtime.evaluate', {
      expression: `(() => {
        const st = self.__imgdTest.state;
        const keep = new Set((st.job ? st.job.images : []).slice(0, 3).map(i => i.url));
        st.selected.clear();
        for (const u of keep) st.selected.add(u);
        document.getElementById('status').textContent = '__PRE__';
        self.__imgdTest.els.btnZip.click();
        return 'ok';
      })()`,
      returnByValue: true
    });
    void zipStart;
    let zrStatus = '';
    let zrFailed = 0;
    const zrT0 = Date.now();
    let zrSawBusy = false;
    while (Date.now() - zrT0 < 300000) {
      await sleep(500);
      const s = await popup.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          busy: self.__imgdTest.state.busy,
          status: document.getElementById('status').textContent,
          failed: (self.__imgdTest.state.failures || []).length
        })`,
        returnByValue: true
      });
      const v = evalJson(s, '打包状态');
      zrStatus = v.status;
      zrFailed = v.failed;
      if (v.busy) zrSawBusy = true;
      if (zrSawBusy && !v.busy) break;
      if (!zrSawBusy && v.status !== '__PRE__' && !v.busy && /ZIP|失败|完成/.test(v.status)) break;
    }
    const zr = { status: zrStatus, failed: zrFailed, elapsed: Date.now() - zrT0 };
    console.log('      打包 ZIP:', JSON.stringify(zr));
    check('打包 ZIP 完成且无失败',
      zrFailed === 0 && /ZIP 已生成/.test(zr.status), JSON.stringify(zr));

    // 再从 popup 里跑一次完整取值，供下面的断言使用（title/页数/尺寸等）
    const drive = `
      (async () => {
        const TARGET_HOST = ${JSON.stringify(TARGET_HOST)};
        const all = await chrome.tabs.query({});
        const target = all.find(t => t.url && t.url.indexOf(TARGET_HOST) >= 0);
        if (!target) return { error: 'target tab not found: ' + all.map(t=>t.url).join(' | ') };
        await chrome.tabs.update(target.id, { active: true });
        const wait = (type, ms) => new Promise((resolve, reject) => {
          const t = setTimeout(() => { chrome.runtime.onMessage.removeListener(l); reject(new Error('timeout ' + type)); }, ms);
          function l(m) {
            if (!m || m.type !== 'result' || m.forType !== type) return;
            clearTimeout(t); chrome.runtime.onMessage.removeListener(l); resolve(m.result);
          }
          chrome.runtime.onMessage.addListener(l);
        });
        await chrome.runtime.sendMessage({ type: 'scan' });
        const scan = await wait('scan', 180000);
        if (!scan || !scan.ok) return { error: (scan && scan.error) || 'scan failed' };
        const urls = scan.images.map(i => i.url);

        // 只探测前 8 张，够验证 Range 解析
        await chrome.runtime.sendMessage({ type: 'probe', urls: urls.slice(0, 8) });
        const probe = await wait('probe', 120000);

        // 在扩展上下文里直接 fetch 一张图，验证 CORS/凭据是否放行（ZIP 路径依赖这一点）
        let fetchTest = 'not-run';
        try {
          const r = await fetch(urls[0], { credentials: 'include' });
          const b = await r.arrayBuffer();
          fetchTest = r.status + ':' + (r.headers.get('content-type') || '') + ':' + b.byteLength;
        } catch (e) { fetchTest = 'ERROR ' + (e && e.message); }

        const folder = scan.title;
        const everyImg = scan.images.map(i => ({ url: i.url, width: i.width || 1200, height: i.height || 1800, ext: 'webp' }));

        // 注：逐张下载与 3 张 ZIP 已在上面的按钮路径里验证过；这里只补 --full 的整篇 ZIP

        // --full 时再跑一次真实规模（全部图片），这是"用户实际会跑的那一次"
        let full = null;
        if (${FULL}) {
          const t0 = Date.now();
          const f = await self.__imgdTest.buildZipInPopup(everyImg, folder, () => {});
          // 只回传摘要：完整结果对象太大，CDP 的 returnByValue 传不回来（会变成空对象）
          full = {
            ok: !!f.ok,
            error: f.error || null,
            count: f.count || 0,
            sizeMB: f.sizeMB || 0,
            bytes: f.bytes || 0,
            name: f.zipName || null,
            failures: (f.failures || []).length,
            firstFailures: (f.failures || []).slice(0, 3),
            seconds: Math.round((Date.now() - t0) / 1000)
          };
        }

        return {
          title: scan.title, pagesFound: scan.pagesFound, domCount: scan.domCount,
          discovered: scan.pagesDiscovered, capped: scan.pagesCapped,
          crawlCount: scan.crawlCount, total: scan.total, pageErrors: scan.pageErrors,
          injectError: scan.injectError, first3: urls.slice(0, 3), last1: urls.slice(-1),
          probeSizes: (probe && probe.sizes) ? probe.sizes.map(s => s.url.split('/').pop() + '=' + s.width + 'x' + s.height + (s.failed ? '(FAIL)' : '')) : [],
          fetchTest,
          full
        };
      })()
    `;
    // 发之前先在本地做一次语法预检：注入字符串若语法有误，这里能给出确切行号
    try {
      // eslint-disable-next-line no-new-func
      new Function('return ' + drive);
    } catch (e) {
      console.log('      [driver] 注入字符串语法错误:', e.message);
      const lines = drive.split('\n');
      lines.forEach((l, i) => { if (i < 60) console.log('        ' + (i + 1) + ': ' + l.slice(0, 110)); });
      throw new Error('注入字符串语法错误: ' + e.message);
    }
    const scanRes = await popup.send('Runtime.evaluate', {
      expression: drive, awaitPromise: true, returnByValue: true
    });
    if (scanRes.exceptionDetails) {
      // 定位注入代码的语法/运行错误：把出错行上下文打出来
      const lines = drive.split('\n');
      const ln = (scanRes.exceptionDetails.lineNumber || 0);
      console.log('      [driver] 注入代码异常在第', ln + 1, '行附近:');
      for (let i = Math.max(0, ln - 2); i < Math.min(lines.length, ln + 3); i++) {
        console.log('        ' + (i + 1) + ': ' + lines[i].slice(0, 120));
      }
    }
    const r = evalValue(scanRes) || {};
    if (r.error || (!r.title && !r.total)) {
      check('scan call succeeded', false,
        (r.error || '返回值异常') + '  exc=' + JSON.stringify(scanRes.exceptionDetails || {}).slice(0, 300));
    } else {
      console.log('      title   :', r.title);
      console.log('      pages   :', r.pagesFound);
      console.log('      dom     :', r.domCount);
      console.log('      crawl   :', r.crawlCount);
      console.log('      total   :', r.total);
      console.log('      last1   :', (r.last1 || []).join(''));
      console.log('      probe   :', (r.probeSizes || []).join(', '));
      console.log('      fetch   :', r.fetchTest);
      if (r.injectError) console.log('      injectErr:', r.injectError);
      if (r.pageErrors && r.pageErrors.length) console.log('      pageErrors:', JSON.stringify(r.pageErrors).slice(0, 300));

      // 断言按目标站点参数化：真实站点 7 页 x16 张（站点偶尔会在页首重复上一页末图，
      // 也会偶发返回短页，所以这里用"每页 >=8 张"而不是死抠最后一张的编号）
      const isFixture = /127\.0\.0\.1|localhost/.test(TARGET_URL);
      const EXP = isFixture
        ? { pages: 8, perPage: 16, dom: 16, crawl: 112, total: 128, sizeRe: /64x96$/, imgRe: /^200:image\/png/, folder: 'Fixture Gallery', ext: 'png' }
        : { pages: 7, perPage: 16, dom: 16, crawl: 96, total: 112, sizeRe: /1200x1800$/, imgRe: /^200:image\/webp/, folder: 'Rina Saito', ext: 'webp' };
      console.log('      目标类型:', isFixture ? '本地 fixture' : '真实站点', '| 期望页数', EXP.pages);

      const shortPages = (as.pageDetail || []).filter((p) => !p.err && p.imgs < 8);
      if (shortPages.length) {
        console.log('      ⚠ 有分页返回的图片偏少（站点侧偶发）:',
          shortPages.map((p) => 'p' + p.page + ':' + p.imgs).join(' '));
      }
      check('每页都抓到图片（无空页）', shortPages.length === 0,
        shortPages.map((p) => 'p' + p.page + ':' + p.imgs).join(' '));

      check('crawled ' + EXP.pages + ' pages', r.pagesFound === EXP.pages, String(r.pagesFound));
      // 发现总数不能把"正在抓的那一批"重复计数（曾因此把 6 页显示成"约 11 页"）
      check('pagesDiscovered == pagesFound（无重复计数）',
        r.discovered === r.pagesFound,
        'discovered=' + r.discovered + ' pagesFound=' + r.pagesFound);
      check('page-1 DOM injection found images', r.domCount >= EXP.dom, String(r.domCount));
      check('pagination fetched >= ' + EXP.crawl + ' images', r.crawlCount >= EXP.crawl, String(r.crawlCount));
      check('total >= ' + EXP.total + ' images', r.total >= EXP.total, String(r.total));
      check('real sizes probed (8/8)',
        (r.probeSizes || []).length === 8 && r.probeSizes.every((s) => EXP.sizeRe.test(s)),
        (r.probeSizes || []).join(', '));
      check('no pagination errors', !r.pageErrors || r.pageErrors.length === 0, JSON.stringify(r.pageErrors || []));
      check('no inject error', !r.injectError, r.injectError || '');

      check('SW fetch of image host works (no CORS block)',
        EXP.imgRe.test(String(r.fetchTest)), String(r.fetchTest));

      if (FULL) {
        const f = r.full || {};
        console.log('\n=== 4b. 真实规模（全部图片）===');
        console.log('      zip     : ok=' + f.ok + ' count=' + f.count + ' ' + f.sizeMB + 'MB  用时 ' + f.seconds + 's' +
          (f.error ? ' ERR=' + f.error : ''));
        console.log('      failures:', (f.failures || []).length);
        check('FULL: zip built for all images', f.ok === true, String(f.error || ''));
        check('FULL: zip contains >= ' + EXP.total + ' files', (f.count || 0) >= EXP.total, String(f.count));
        if (!isFixture) check('FULL: zip size >= 25MB', (f.sizeMB || 0) >= 25, String(f.sizeMB));
        check('FULL: no fetch failures', (f.failures || []).length === 0,
          JSON.stringify((f.failures || []).slice(0, 5)));
      }
    }
    popup.close();

    console.log('\n=== 5. downloads on disk ===');
    const sw2Target = (await httpJson('/json/list'))
      .find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
    if (sw2Target) {
      const sw2 = await CDP.connect(sw2Target.webSocketDebuggerUrl);
      await sw2.send('Runtime.enable');
      await sleep(2500);
      const items = await sw2.send('Runtime.evaluate', {
        expression: `(async () => {
          const list = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 12 });
          const byExt = (s) => s.filename.split('.').pop().toLowerCase();
          const saved = await Promise.all(list.map(async d => {
            let size = 0;
            try { size = (await chrome.downloads.search({ id: d.id }))[0].fileSize || 0; } catch(e){}
            return { file: d.filename, state: d.state, bytes: d.fileSize || size, err: d.error || null };
          }));
          return JSON.stringify(saved);
        })()`,
        awaitPromise: true, returnByValue: true
      });
      const saved = evalValue(items) ? JSON.parse(evalValue(items)) : [];
      saved.forEach((s) => console.log(`      [${s.state}] ${s.bytes}B  ${s.file}${s.err ? '  ERR=' + s.err : ''}`));

      const isFixture = /127\.0\.0\.1|localhost/.test(TARGET_URL);
      const DL_EXT = isFixture ? 'png' : 'webp';
      const DL_NAME_RE = isFixture ? /[0-9][0-9][0-9]_pic_[0-9]+_64x96( \([0-9]+\))?\.png$/ : /[0-9][0-9][0-9]_GRA10V097_[0-9]+_1200x1800( \([0-9]+\))?\.webp$/;
      const FOLDER_RE = isFixture ? /Fixture Gallery/ : /Rina Saito/;
      const imgs = saved.filter((s) => new RegExp('\\.' + DL_EXT + '$', 'i').test(s.file));
      const zips = saved.filter((s) => /\.zip$/i.test(s.file));
      check('3 image files recorded complete', imgs.filter((s) => s.state === 'complete').length === 3,
        JSON.stringify(imgs.map((s) => s.state + ' ' + s.file)));
      check('images land in title-named folder',
        imgs.length > 0 && imgs.every((s) => FOLDER_RE.test(s.file)),
        imgs.map((s) => s.file).join(' | '));
      check('filenames forced by onDeterminingFilename (NNN_ + size tag)',
        imgs.length > 0 && imgs.every((s) => DL_NAME_RE.test(s.file)),
        imgs.map((s) => s.file).join(' | '));
      check('at least one zip recorded complete', zips.some((s) => s.state === 'complete'),
        JSON.stringify(zips));
      check('zip filename = page title',
        zips.some((s) => FOLDER_RE.test(s.file)), zips.map((s) => s.file).join(' | '));
      sw2.close();
    } else {
      check('service worker still reachable for download verification', false, 'no SW target');
    }
  }

  console.log('\n=== browser stderr (extension-related) ===');
  const errLines = stderr.split('\n').filter((l) =>
    /imgd|Uncaught|extension error/i.test(l) && !/DevTools listening|GPU|gpu_|voice_transcription/i.test(l)
  ).slice(0, 15);
  if (errLines.length) errLines.forEach((l) => console.log('      ' + l.trim().slice(0, 200)));
  else console.log('      (none)');
  check('no uncaught extension errors in stderr',
    !errLines.some((l) => /Uncaught|imgd/i.test(l)), errLines.join(' | ').slice(0, 300));

  page.close();
  child.kill();
  await sleep(800);

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('E2E crashed:', (e && e.stack) || e);
  process.exit(2);
});
