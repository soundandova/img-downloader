/**
 * 本地分页测试站：复刻 everia.club 的结构，用于可复现验证（不依赖外网）
 *   · 文章第 1 页：正文 16 张图 + .page-links 分页到第 N 页（默认 8 页）
 *   · 每页 HTML 大小和真实站点同量级（约 250KB，用填充内容）
 *   · 可用 ?slow=N 让第 N 页延迟 9000ms，用于复现"慢页拖住整批"
 *   · 图片是真实 PNG（1200x1800 太大，用 64x96 小图，尺寸由服务端声明）
 * 用法：node tools/fixture-site.js [端口]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2], 10) || 8099;
const PAGES = 8;
const PER_PAGE = 16;

/** 生成一张真实 PNG（纯色），带指定尺寸 */
function makePng(w, h, r, g, b) {
  const zlib = require('zlib');
  const rowLen = w * 3 + 1;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const FILLER = '<p>' + '这是用于凑页面体积的填充文本，模拟真实站点每页约 250KB 的 HTML。'.repeat(120) + '</p>';
const IMG_W = 64, IMG_H = 96;
const pngCache = new Map();
function pngFor(n) {
  if (!pngCache.has(n)) pngCache.set(n, makePng(IMG_W, IMG_H, (n * 37) % 256, (n * 91) % 256, (n * 53) % 256));
  return pngCache.get(n);
}

function pageHtml(pageNo) {
  const start = (pageNo - 1) * PER_PAGE + 1;
  const figs = [];
  for (let i = start; i < start + PER_PAGE; i++) {
    figs.push(`<figure class="wp-block-image size-large"><img decoding="async" data-id="${1000 + i}" src="/images/pic_${i}.png" alt="" class="wp-image-${1000 + i}"/></figure>`);
  }
  // 分页块：与真实站点一致（列出全部页号，当前页用 span）
  const links = [];
  for (let p = 1; p <= PAGES; p++) {
    if (p === pageNo) links.push(`<span class="post-page-numbers current" aria-current="page"><span class="page-number">${p}</span></span>`);
    else links.push(`<a href="/article/${p}/" class="post-page-numbers"><span class="page-number">${p}</span></a>`);
  }
  // 侧栏"相关文章"缩略图（测试正文容器过滤是否生效）
  const related = [];
  for (let i = 0; i < 6; i++) {
    related.push(`<img post-id="${9000 + i}" width="360" height="540" src="/images/related_${i}.png" class="attachment-360x540 wp-post-image" loading="lazy" />`);
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>Fixture Gallery &#8211; 第 ${pageNo} 页</title></head><body>
<header><h1>Fixture Gallery</h1></header>
<article>
  <div class="entry-content">
    ${figs.join('\n')}
    ${FILLER}
    <div class="page-links">Pages: ${links.join(' ')}</div>
  </div>
</article>
<aside class="related-posts"><h2>相关文章</h2>${related.join('\n')}</aside>
<footer>fixture site</footer>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = u.pathname;

  const img = p.match(/^\/images\/(pic|related)_(\d+)\.png$/);
  if (img) {
    const buf = pngFor(parseInt(img[2], 10));
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
    return;
  }

  let pageNo = 1;
  if (p === '/' || p === '/article/' || p === '/article/1/') pageNo = 1;
  else {
    const m = p.match(/^\/article\/(\d+)\/$/);
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    pageNo = parseInt(m[1], 10);
  }
  if (pageNo < 1 || pageNo > PAGES) { res.writeHead(404); res.end('no such page'); return; }

  const slowPage = parseInt(u.searchParams.get('slow'), 10) || 0;
  const body = Buffer.from(pageHtml(pageNo), 'utf8');
  const send = () => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    res.end(body);
  };
  if (slowPage === pageNo) setTimeout(send, 9000);
  else send();
});

server.listen(PORT, '127.0.0.1', () => {
  const sample = Buffer.byteLength(pageHtml(1), 'utf8');
  console.log(`fixture 站点已启动: http://127.0.0.1:${PORT}/`);
  console.log(`  文章页: /article/1/ .. /article/${PAGES}/   每页 ${PER_PAGE} 张图`);
  console.log(`  单页 HTML 大小: ${Math.round(sample / 1024)}KB`);
  console.log(`  复现慢页: http://127.0.0.1:${PORT}/?slow=2`);
  console.log(`  图片: ${IMG_W}x${IMG_H} 真实 PNG`);
});
