/**
 * 分页抓取成本分析：找出"卡在进度"的真实原因
 *   1. 单页 HTML 的 TTFB / 总耗时 / 大小
 *   2. 并发 4 抓 8 页需要几轮、每轮多久（复刻扩展当前逻辑）
 *   3. 页面里是否包含"全部页号"（若是，可少抓很多页来发现分页）
 * 用法：node tools/page-cost.js [文章URL]
 */
'use strict';
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const BASE = process.argv[2] ||
  'https://everia.club/2026/10/05/flash-2026-08-04-%e3%83%95%e3%83%a9%e3%83%83%e3%82%b7%e3%83%a5-2026%e5%b9%b48%e6%9c%884%e6%97%a5%e5%8f%b7/';

function timedGet(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    let ttfb = 0;
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } }, (res) => {
      ttfb = Date.now() - t0;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode, ttfb, total: Date.now() - t0,
          bytes: body.length, headers: res.headers, body
        });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, ttfb: 0, total: Date.now() - t0, bytes: 0, headers: {}, body: Buffer.alloc(0) }));
    req.setTimeout(20000, () => req.destroy(new Error('TIMEOUT')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('文章:', BASE);
  const m = BASE.match(/\/(\d+)\/?$/);
  const pageUrl = (n) => (n === 1 ? BASE : BASE.replace(/\/$/, '') + '/' + n + '/');

  console.log('\n=== 1. 单页 HTML 成本（串行 5 次，看波动）===');
  const times = [];
  for (let i = 0; i < 5; i++) {
    const r = await timedGet(pageUrl(1));
    times.push(r);
    console.log(`  #${i + 1}  status=${r.status}${r.error ? '  ERR=' + r.error : ''}  TTFB=${r.ttfb}ms  总耗时=${r.total}ms  大小=${Math.round(r.bytes / 1024)}KB  ` +
      `cf-cache=${r.headers['cf-cache-status'] || '-'}  cache-control=${r.headers['cache-control'] || '-'}`);
    await sleep(120);
  }
  const avg = Math.round(times.reduce((a, r) => a + r.total, 0) / times.length);
  const avgTtfb = Math.round(times.reduce((a, r) => a + r.ttfb, 0) / times.length);
  console.log(`  平均：TTFB ${avgTtfb}ms  总 ${avg}ms  → 服务器生成 HTML 约 ${avgTtfb}ms，其余是传输`);

  console.log('\n=== 2. 页面里是否列出"全部页号"（决定能否少抓页来发现分页）===');
  const html = times[0].body.toString('utf8');
  const block = html.match(/<div[^>]*class="[^"]*page-links[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (block) {
    const nums = [...block[1].matchAll(/class="page-number">(\d+)</g)].map((x) => +x[1]);
    console.log('  page-links 里出现的页号:', nums.join(', '));
    console.log('  → 最大页号 =', Math.max(...nums), '（页数 = 最大页号）');
    console.log('  → 关键：第 1 页就给出了全部页号，不需要靠"抓每一页去发现下一页"');
  } else {
    console.log('  未找到 page-links，分页可能是 rel=next 链式（必须逐页发现）');
  }

  console.log('\n=== 3. 复刻当前逻辑：并发 4 抓 8 页 ===');
  const pages = Array.from({ length: 8 }, (_, i) => pageUrl(i + 1));
  let done = 0;
  const t0 = Date.now();
  const wallMarks = [];
  for (let i = 0; i < pages.length; i += 4) {
    const batch = pages.slice(i, i + 4);
    const tBatch = Date.now();
    const res = await Promise.all(batch.map(timedGet));
    done += batch.length;
    wallMarks.push({ batch: i / 4 + 1, ms: Date.now() - tBatch, done, ttfbMax: Math.max(...res.map((r) => r.ttfb)) });
    await sleep(100); // 复刻 PAGE_DELAY 默认值
  }
  const total = Date.now() - t0;
  console.log('  每批耗时（含 100ms 间隔）:');
  for (const w of wallMarks) console.log(`    批${w.batch}: ${w.ms}ms  累计已处理 ${w.done}/8  该批最慢 TTFB=${w.ttfbMax}ms`);
  console.log(`  8 页总计 ${total}ms（平均 ${Math.round(total / 8)}ms/页）`);
  console.log(`  → 界面在此期间只有 ${wallMarks.length} 次更新，所以"卡住"= 一整批（约 ${Math.round(total / wallMarks.length)}ms）没有新数字`);

  console.log('\n=== 4. 优化空间估算 ===');
  const perPage = avg;
  console.log(`  当前每页 1 次请求（约 ${perPage}ms）且有轮次屏障`);
  console.log(`  若改为"第 1 页拿到全部页号 + 无屏障并发"：`);
  const ideal = Math.ceil(8 / 6) * avg + avgTtfb;
  console.log(`    8 页理论耗时 ≈ ${ideal}ms（并发 6、单轮拉完），无中间屏障`);
  console.log(`    收益：少等 ${Math.max(0, total - ideal)}ms，且界面能逐页递增而不是整批跳变`);
})().catch((e) => { console.error('分析异常:', (e && e.stack) || e); process.exit(1); });
