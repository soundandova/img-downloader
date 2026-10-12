/**
 * 图片文件头解析器（Node 可测版本）
 * 与 extension/background.js 中的 parseImageSize 逻辑逐字一致，用于验证。
 * 用法：node tools/imagesize.js <url-or-file> [...]
 */
'use strict';
const fs = require('fs');
const https = require('https');
const http = require('http');

function parseImageSize(buf) {
  try {
    if (!buf || buf.length < 16) return null;
    const b = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength || buf.length);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { width: dv.getUint32(16), height: dv.getUint32(20), format: 'png' };
    }
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true), format: 'gif' };
    }
    if (b[0] === 0x42 && b[1] === 0x4d) {
      return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)), format: 'bmp' };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = dv.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7), format: 'jpeg' };
        }
        if (len < 2) break;
        i += 2 + len;
      }
      return null;
    }
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (fourcc === 'VP8 ') {
        for (let i = 20; i + 9 < b.length; i++) {
          if (b[i] === 0x9d && b[i + 1] === 0x01 && b[i + 2] === 0x2a) {
            return { width: dv.getUint16(i + 3, true) & 0x3fff, height: dv.getUint16(i + 5, true) & 0x3fff, format: 'webp' };
          }
        }
        return null;
      }
      if (fourcc === 'VP8L') {
        const bits = dv.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
      }
      if (fourcc === 'VP8X') {
        return {
          width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
          height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
          format: 'webp'
        };
      }
      return null;
    }
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      const str = String.fromCharCode.apply(null, b.subarray(0, Math.min(b.length, 4096)));
      let best = null;
      let idx = 0;
      while ((idx = str.indexOf('ispe', idx)) >= 0) {
        const p = idx - 4;
        if (p >= 0 && p + 16 <= b.length) {
          const w = dv.getUint32(p + 8);
          const h = dv.getUint32(p + 12);
          if (w > 0 && h > 0 && w < 100000 && h < 100000) {
            if (!best || w * h > best.width * best.height) best = { width: w, height: h, format: 'avif' };
          }
        }
        idx += 4;
      }
      return best;
    }
    const head = String.fromCharCode.apply(null, b.subarray(0, Math.min(b.length, 2048)));
    if (head.indexOf('<svg') >= 0) {
      const m = head.match(/viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
      const wm = head.match(/\bwidth\s*=\s*["'](\d+)/i);
      const hm = head.match(/\bheight\s*=\s*["'](\d+)/i);
      const w = m ? Math.round(parseFloat(m[1])) : (wm ? +wm[1] : 0);
      const h = m ? Math.round(parseFloat(m[2])) : (hm ? +hm[1] : 0);
      return { width: w, height: h, format: 'svg', vector: true };
    }
    return null;
  } catch (e) {
    return null;
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

function fetchRange(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { Range: `bytes=0-${maxBytes - 1}`, 'User-Agent': UA }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
  });
}

module.exports = { parseImageSize, fetchRange, UA };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (!args.length) {
      console.log('用法: node tools/imagesize.js <url|file> [...]');
      process.exit(1);
    }
    for (const a of args) {
      try {
        let buf, total = null, status = 'file';
        if (/^https?:/i.test(a)) {
          const r = await fetchRange(a, 65536);
          buf = r.buf; status = r.status;
          total = r.headers['content-range'] ? +r.headers['content-range'].split('/')[1] : buf.length;
        } else {
          buf = fs.readFileSync(a);
        }
        const s = parseImageSize(buf);
        const label = a.split('/').pop();
        if (s) {
          console.log(`${label.padEnd(24)} ${s.width}x${s.height}  [${s.format}]${s.vector ? ' 矢量' : ''}  status=${status}  取到=${buf.length}B  总大小=${total ? Math.round(total / 1024) + 'KB' : '-'}`);
        } else {
          console.log(`${label.padEnd(24)} 解析失败  status=${status}  取到=${buf.length}B`);
        }
      } catch (e) {
        console.log(`${a}  错误: ${e.message}`);
      }
    }
  })();
}
