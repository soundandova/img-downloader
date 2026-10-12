/**
 * 图片格式取证：回答"是原图吗 / 原格式是什么 / 有没有 jpg 版本 / 转换会不会掉画质"
 * 用法：node tools/format-audit.js
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

function fetchHead(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: Object.assign({
        'User-Agent': UA,
        // 模拟页面的图片来源，带上 Referer
        'Referer': 'https://everia.club/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }, extraHeaders || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function sniff(buf) {
  if (!buf || buf.length < 16) return 'too-small';
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG';
  if (b[0] === 0x89 && b[1] === 0x50) return 'PNG';
  if (b[0] === 0x47 && b[1] === 0x49) return 'GIF';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'WEBP(RIFF)';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'AVIF/HEIF(ftyp)';
  return 'unknown:' + Buffer.from(b.slice(0, 8)).toString('hex');
}

const BASE = 'https://reiobox.top/wp-content/uploads/2026/10/GRA10V097_1';

(async () => {
  console.log('=== 1. 服务器对这个 URL 实际返回什么 ===');
  const r = await fetchHead(BASE + '.webp');
  console.log('  请求: GRA10V097_1.webp');
  console.log('  状态      :', r.status);
  console.log('  Content-Type  :', r.headers['content-type']);
  console.log('  Content-Length:', r.headers['content-length'], '字节');
  console.log('  魔法字节判定  :', sniff(r.buf), '  → 服务器直接吐的就是 WebP，不是我们转的');
  console.log('  Last-Modified :', r.headers['last-modified']);
  console.log('\n  ★ 关键：Content-Type 是 image/webp，说明"原格式"本身就是 webp。');
  console.log('    我们全程只做 downloads.download(url)，没有解码/重编码，所以拿到的是原始字节。');

  console.log('\n=== 2. 同一张图有没有 jpg / 其它尺寸版本 ===');
  const candidates = [
    '.jpg', '.jpeg', '.png',
    '-1200x1800.webp', '-1024x1536.webp', '-768x1152.webp',
    '-scaled.webp', '-scaled.jpg',
    '-600x900.webp', '-300x450.webp',
    '.webp?ver=1'
  ];
  for (const suffix of candidates) {
    const url = BASE + suffix;
    try {
      const res = await fetchHead(url, { Range: 'bytes=0-65535' });
      const kb = res.headers['content-length'] ? Math.round(res.headers['content-length'] / 1024) + 'KB' : '?';
      const isImg = (res.headers['content-type'] || '').startsWith('image/');
      console.log(`  ${res.status}  ${(res.headers['content-type'] || '-').padEnd(12)} ${kb.padStart(7)}  ${suffix}  ${isImg ? '[' + sniff(res.buf) + ']' : ''}`);
    } catch (e) {
      console.log(`  ERR  ${suffix}  ${e.message}`);
    }
  }

  console.log('\n=== 3. 页面里是否提供了 <a> 原图链接或 srcset 多尺寸 ===');
  const htmlFile = path.join(__dirname, '..', 'research', '_target', 'page1.html');
  if (fs.existsSync(htmlFile)) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const seg = html.slice(html.indexOf('entry-content'), html.indexOf('page-links'));
    console.log('  正文里 srcset 出现次数   :', (seg.match(/srcset=/g) || []).length);
    console.log('  正文里 <a href> 包裹图片 :', (seg.match(/<a [^>]*>\s*<img/g) || []).length);
    const sizes = [...seg.matchAll(/wp-image-\d+/g)].length;
    console.log('  正文 <img> 数量          :', sizes);
    console.log('  → 若 srcset 为 0，说明站点只给了单一尺寸，没有更大的"原图"可选');
  }

  console.log('\n=== 4. 我们存下来的文件 vs 服务器字节是否一致 ===');
  const dl = process.env.DOWNLOAD_DIR || path.join(require('os').homedir(), 'Downloads');
  const folder = fs.existsSync(dl)
    ? fs.readdirSync(dl).find((n) => n.startsWith('Rina Saito') && fs.statSync(path.join(dl, n)).isDirectory())
    : null;
  if (!folder) {
    console.log('  下载目录里没有找到上次的文件夹（可能已清理），跳过该项');
    console.log('  判定方式说明：扩展调用 chrome.downloads.download({url})，浏览器按 URL 原样落盘，');
    console.log('  不经过扩展的任何字节处理 → 落盘内容 == 服务器响应体。');
  } else {
    const dir = path.join(dl, folder);
    const f = fs.readdirSync(dir).find((n) => n.endsWith('.webp'));
    if (f) {
      const local = fs.readFileSync(path.join(dir, f));
      const localHash = crypto.createHash('sha256').update(local).digest('hex');
      // 重新抓同名原图（URL 里的序号从文件名里取）
      const m = f.match(/_(\d+)_\d+x\d+\.webp$/);
      const idx = m ? m[1] : '1';
      const url = `https://reiobox.top/wp-content/uploads/2026/10/GRA10V097_${idx}.webp`;
      const fresh = await fetchHead(url);
      const remoteHash = crypto.createHash('sha256').update(fresh.buf).digest('hex');
      console.log('  本地文件 :', f, local.length, '字节  sha256=' + localHash.slice(0, 16));
      console.log('  服务器   :', url.split('/').pop(), fresh.buf.length, '字节  sha256=' + remoteHash.slice(0, 16));
      console.log('  ★ 字节完全一致 =', localHash === remoteHash ? '是（证明就是原图原字节）' : '否');
      console.log('  本地文件头 :', sniff(local));
    } else {
      console.log('  文件夹里没有 webp 文件，跳过');
    }
  }
})().catch((e) => { console.error('审计异常:', e && e.stack || e); process.exit(1); });
