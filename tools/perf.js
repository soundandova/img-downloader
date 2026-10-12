/**
 * 性能剖析：扫描各阶段到底花多少时间，瓶颈是网速还是别的
 *
 * 分三段计时，全部在真实页面上跑：
 *   1. 当前页注入采集（DOM 扫描）
 *   2. 分页抓取（7 页 HTML）
 *   3. 尺寸探测（Range 请求，纯延迟敏感）
 * 另外验证「探测多页」开关：maxPages=1 时不应该发出任何分页请求。
 *
 * 用法：node tools/perf.js
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
const USER = path.join(ROOT, '.perf-profile');
const PORT = 9336;
const TARGET = process.argv[2] || 'https://everia.club/2026/10/09/rina-saito-%e6%96%89%e8%97%a4%e9%87%8c%e5%a5%88-parade%e3%83%87%e3%82%b8%e3%82%bf%e3%83%ab%e3%83%95%e3%82%a9%e3%83%88%e3%83%96%e3%83%83%e3%82%af-%e3%81%9a%e3%81%a3%e3%81%a8%e8%a6%8b%e3%81%a4/';
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

  const sw = (await httpJson('/json/list')).find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  const extId = sw.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];
  const targetTab = await httpJson('/json/new?' + encodeURIComponent(TARGET), 'PUT');
  await sleep(4500);

  // ---- 先在 service worker 里直接跑 crawlPages，逐条记录进度回调，验证数字不会重叠 ----
  const swCdp = await CDP.connect(sw.webSocketDebuggerUrl);
  await swCdp.send('Runtime.enable');
  const crawlProbe = await swCdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const url = ${JSON.stringify(TARGET)};
      const samples = [];
      const pageTimes = [];
      const tStart = performance.now();
      const res = await crawlPages(url, 60, { concurrency: 4, delay: 0 },
        (processed, queued, total, batch) => {
          samples.push({ processed, queued, total, batch, at: Math.round(performance.now() - tStart) });
        },
        (page) => {
          pageTimes.push({ ms: page.ms, err: page.error || null, imgs: (page.images || []).length });
        });
      const wall = Math.round(performance.now() - tStart);
      const nums = res.pages.map(p => {
        const m = (p.pageUrl || '').match(/\\/(\\d+)\\/$/);
        return { n: m ? +m[1] : 1, imgs: (p.images || []).length, err: p.error || null };
      }).sort((a, b) => a.n - b.n);
      const maxNum = nums.reduce((m, x) => Math.max(m, x.n), 1);
      return JSON.stringify({
        pagesFound: res.pagesFound,
        discoveredFinal: res.pagesDiscovered,
        samples,
        pageTimes,
        wall,
        maxPageNumberSeen: maxNum,
        pageNumbers: nums,
        duplicatedFetches: res.duplicatedFetches,
        imgs: res.images.length
      });
    })()`,
    awaitPromise: true, returnByValue: true
  });
  let cp = crawlProbe.result;
  if (cp && cp.result !== undefined) cp = cp.result;
  if (crawlProbe.exceptionDetails) {
    console.log('crawl 探针异常:', crawlProbe.exceptionDetails.text,
      (crawlProbe.exceptionDetails.exception || {}).description || '');
  } else if (cp && typeof cp.value === 'string') {
    const c = JSON.parse(cp.value);
    console.log('=== 分页遍历（真实页面：' + c.pagesFound + ' 页，并发 4，间隔 0）===');
    console.log(`  总墙钟 ${c.wall}ms`);
    console.log('  单页响应时间（浏览器侧）:');
    c.pageTimes.forEach((p, i) => {
      console.log(`    第${i + 1}个返回: ${p.ms}ms  ${p.imgs} 张${p.err ? '  ERR=' + p.err : ''}` +
        (p.ms > 3000 ? '   <-- 站点慢页，拖住整批' : ''));
    });
    const slow = c.pageTimes.filter((p) => p.ms > 3000).length;
    const avg = Math.round(c.pageTimes.reduce((a, p) => a + p.ms, 0) / Math.max(1, c.pageTimes.length));
    console.log(`  平均 ${avg}ms/页，其中 >3s 的慢页 ${slow} 个`);
    console.log('  进度回调（时刻ms, 已处理/总数, 队列, 在飞）:');
    for (const s of c.samples) {
      console.log(`    t=${s.at}ms  ${s.processed}/${s.total}  队列=${s.queued}  本批在飞=${s.batch}` +
        (s.processed + s.queued + s.batch !== s.total ? '   <-- 数字不自洽!' : ''));
    }
    console.log('  实际抓到的页号:', c.pageNumbers.map((x) => x.n + (x.err ? '(ERR)' : '')).join(', '));
    console.log('  最大的页号 =', c.maxPageNumberSeen);
    const okFinal = c.discoveredFinal === c.pagesFound;
    const okConsistent = c.samples.every((s) => s.processed + s.queued + s.batch === s.total);
    const okNoDup = c.duplicatedFetches === 0;
    console.log(`  ${okFinal ? '[PASS]' : '[FAIL]'} 最终"累计发现"== 实际抓取页数（${c.discoveredFinal} vs ${c.pagesFound}）`);
    console.log(`  ${okConsistent ? '[PASS]' : '[FAIL]'} 每次进度回调都自洽：已处理 + 队列 + 在飞 == 总数`);
    console.log(`  ${c.pagesFound <= c.maxPageNumberSeen ? '[PASS]' : '[FAIL]'} 抓取页数未超过页面里最大的页号（${c.pagesFound} <= ${c.maxPageNumberSeen}）`);
    console.log(`  ${okNoDup ? '[PASS]' : '[FAIL]'} 没有任何页面被重复抓取（重复次数 ${c.duplicatedFetches}）`);
  }
  swCdp.close();

  const popupTab = await httpJson('/json/new?' + encodeURIComponent(`chrome-extension://${extId}/popup.html`), 'PUT');
  const popup = await CDP.connect(popupTab.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  await sleep(1500);

  const expr = `(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => x.url && x.url.indexOf('everia.club') >= 0);
    await chrome.tabs.update(t.id, { active: true });

    const wait = (type, ms) => new Promise((resolve, reject) => {
      const to = setTimeout(() => { chrome.runtime.onMessage.removeListener(l); reject(new Error('timeout ' + type)); }, ms);
      function l(m) { if (!m || m.type !== 'result' || m.forType !== type) return;
        clearTimeout(to); chrome.runtime.onMessage.removeListener(l); resolve(m.result); }
      chrome.runtime.onMessage.addListener(l);
    });
    const T = () => performance.now();

    // ---- A. 只扫当前页 ----
    let t0 = T();
    await chrome.runtime.sendMessage({ type: 'scan', maxPages: 1 });
    const onePage = await wait('scan', 120000);
    const tOnePage = T() - t0;

    // ---- A2. 上限 3 页（验证"多页但有上限"确实只抓 3 页）----
    t0 = T();
    await chrome.runtime.sendMessage({ type: 'scan', maxPages: 3 });
    const cap3 = await wait('scan', 120000);
    const tCap3 = T() - t0;

    // ---- B. 多页扫描（默认节奏）----
    t0 = T();
    await chrome.runtime.sendMessage({ type: 'scan', maxPages: 60 });
    const multi = await wait('scan', 180000);
    const tMulti = T() - t0;

    // ---- B2. 多页扫描（调快：并发 6 / 间隔 0）----
    t0 = T();
    await chrome.runtime.sendMessage({ type: 'scan', maxPages: 60, tune: { concurrency: 6, delay: 0 } });
    const fast = await wait('scan', 180000);
    const tFast = T() - t0;

    const urls = multi.images.map(i => i.url);

    // ---- C. 尺寸探测（分批计时，看单批延迟）----
    const batchTimes = [];
    for (let i = 0; i < Math.min(urls.length, 48); i += 6) {
      const b = urls.slice(i, i + 6);
      const s = T();
      await chrome.runtime.sendMessage({ type: 'probe', urls: b });
      await wait('probe', 60000);
      batchTimes.push(Math.round(T() - s));
    }

    return JSON.stringify({
      onePage: { ms: Math.round(tOnePage), pages: onePage.pagesFound, imgs: onePage.total, skipped: onePage.crawlSkipped },
      cap3: { ms: Math.round(tCap3), pages: cap3.pagesFound, imgs: cap3.total, capped: cap3.pagesCapped, cap: cap3.maxPages },
      multi: { ms: Math.round(tMulti), pages: multi.pagesFound, imgs: multi.total, discovered: multi.pagesDiscovered, crawlCount: multi.crawlCount },
      fast: { ms: Math.round(tFast), pages: fast.pagesFound, imgs: fast.total },
      probeBatches: batchTimes,
      probeBatchAvg: Math.round(batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length),
      probePerImage: Math.round(batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length / 6)
    });
  })()`;

  const r = await popup.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  let payload = r && r.result;
  if (payload && payload.result !== undefined) payload = payload.result; // 兼容两种嵌套层级
  if (r.exceptionDetails) {
    console.log('求值异常:', r.exceptionDetails.text, (r.exceptionDetails.exception || {}).description || '');
  } else if (!payload || typeof payload.value !== 'string') {
    console.log('未拿到结果，原始返回：', JSON.stringify(r).slice(0, 800));
  } else {
    const d = JSON.parse(payload.value);
    console.log('=== A. 只扫当前页（开关关闭，maxPages=1）===');
    console.log(`  耗时 ${d.onePage.ms} ms   抓到 ${d.onePage.imgs} 张   分页请求跳过 = ${d.onePage.skipped}`);
    console.log('\n=== A2. 上限 3 页（开关打开 + 上限设 3）===');
    console.log(`  耗时 ${d.cap3.ms} ms   实际处理 ${d.cap3.pages} 页   抓到 ${d.cap3.imgs} 张   命中上限 = ${d.cap3.capped}`);
    console.log(`  → 上限生效判定：${d.cap3.pages === 3 ? '✅ 只抓了 3 页' : '❌ 抓了 ' + d.cap3.pages + ' 页'}`);
    console.log('\n=== B. 多页扫描（默认节奏：并发 3 / 间隔 200ms）===');
    console.log(`  总耗时 ${d.multi.ms} ms   处理 ${d.multi.pages} 页   抓到 ${d.multi.imgs} 张   分页补充 ${d.multi.crawlCount} 张`);
    const perPage = Math.round((d.multi.ms - d.onePage.ms) / Math.max(1, d.multi.pages - 1));
    console.log(`  → 平均每多抓一页约 ${perPage} ms（含 200ms 固定间隔，实际网络约 ${perPage - 200} ms/页）`);
    console.log('\n=== B2. 多页扫描（调快：并发 6 / 间隔 0ms）===');
    console.log(`  总耗时 ${d.fast.ms} ms   处理 ${d.fast.pages} 页   抓到 ${d.fast.imgs} 张`);
    const speedup = d.multi.ms > 0 ? (d.multi.ms / Math.max(1, d.fast.ms)).toFixed(2) : '?';
    console.log(`  → 相比默认节奏快 ${speedup} 倍`);
    console.log('\n=== C. 尺寸探测（每组 6 张 Range 请求）===');
    console.log('  各组耗时(ms):', d.probeBatches.join(', '));
    console.log(`  平均每组 ${d.probeBatchAvg} ms  → 单张约 ${d.probePerImage} ms（6 并发，含请求排队）`);
    const est = Math.round(d.probePerImage * 121);
    console.log(`  按 121 张估算，探测阶段约 ${(est / 1000).toFixed(1)} 秒（6 并发下实际约 ${(est / 6 / 1000).toFixed(1)} 秒）`);
    console.log('\n=== 瓶颈判定 ===');
    console.log(`  扫描总计 ≈ ${(d.multi.ms / 1000).toFixed(1)} 秒：分页 ${((d.multi.ms - d.onePage.ms) / 1000).toFixed(1)}s + 当前页采集 ${(d.onePage.ms / 1000).toFixed(1)}s`);
    console.log('  探测阶段是 121 次独立小请求（每个 64KB），耗时由"请求数 × 单次往返延迟"决定');
    console.log('  而不是由带宽决定 —— 121×64KB 总共才 7.6MB，2 秒就能传完');
  }
  child.kill();
  await sleep(1500);
  try { fs.rmSync(USER, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch (e) { /* 浏览器还没退出干净，忽略 */ }
})().catch((e) => { console.error('perf 异常:', (e && e.stack) || e); process.exit(1); });
