/**
 * 一键看图下载 —— 后台 service worker（经典脚本，非 module）
 * 无外部依赖：ZIP 逻辑在 popup 侧（见 popup.js），后台只负责扫描 / 尺寸探测 / 下载 / DNR
 *
 * 来自范本研究的四条硬约束（见 research/REPORT.md），其中前两条已在本机实测确认：
 *  1. service worker 里既没有 DOMParser 也没有 URL.createObjectURL
 *     → 每页 HTML 用正则解析；ZIP 交给 popup
 *  2. chrome.runtime.sendMessage 会把对象 JSON 序列化（JSZip 实例会丢原型）
 *     → 不要把带方法的对象跨上下文传递
 *  3. 尺寸过滤只做"已知才过滤"，未知尺寸放行并在 UI 标注，绝不静默丢图
 *  4. 文件名强制走 downloads.onDeterminingFilename，防止被 Content-Disposition 改名
 */

// 注意：后台不使用 JSZip（ZIP 在 popup 里做），故此处不 importScripts

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SESSION_KEY = 'imgd_job';
const FOLDER_KEY = 'imgd_folder';

const MAX_PAGES = 60;          // 分页上限，防跑飞
const PAGE_CONCURRENCY = 3;    // 分页并发
const PAGE_DELAY = 200;        // 分页间隔 ms
const PROBE_CONCURRENCY = 6;   // 尺寸探测并发
const PROBE_BYTES = 65536;     // Range 请求字节数
const PROBE_LIMIT = 800;       // 单次任务最多探测张数
const DL_CONCURRENCY = 3;      // 同时下载数
const DL_DELAY = 120;          // 下载间隔 ms
const DOWNLOAD_TIMEOUT = 120000;
const FOLDER_MAX = 80;         // 目录名长度上限

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'jfif', 'ico'];

const pendingPaths = new Map(); // url -> 期望文件名

/**
 * 下载/打包的进度状态（popup 轮询这个）
 *
 * 为什么不用 result 广播：实测 popup 里 chrome.runtime.onMessage 的监听器
 * 收不到这些广播（同一上下文里后装的监听器能收到、先装的收不到），表现为
 * "文件已经下载完了，但界面永远停在'正在下载… 3/3'，按钮也不解除禁用"。
 * 状态写 storage.local，popup 每 300ms 轮询一次，确定性可靠。
 */
const JOB_STATE_KEY = 'imgd_job_state';

async function setJobState(patch) {
  try {
    const cur = (await chrome.storage.local.get(JOB_STATE_KEY))[JOB_STATE_KEY] || {};
    await chrome.storage.local.set({ [JOB_STATE_KEY]: Object.assign(cur, patch, { at: Date.now() }) });
  } catch (e) { /* 忽略 */ }
}

async function clearJobState() {
  try { await chrome.storage.local.set({ [JOB_STATE_KEY]: null }); } catch (e) { /* 忽略 */ }
}

/**
 * 关于"扫描期实时进度"的取舍（实测结论，别再重复踩）：
 *  1) popup 里通过 chrome.runtime.onMessage 注册的监听器在扫描期的高频广播事件上**收不到**
 *     （同一上下文里后装的监听器能收到 90+ 次，先装的收 0 次）
 *  2) 改用轮询（storage.local 存进度面板）后，长扫描仍会失败：
 *     MV3 service worker 会在扫描途中被挂起重启（实测扫描 20 秒后轮询恒返回 null）
 *  3) 而快站点上扫描只要 1 秒左右，实时流式显示本来也没意义
 *  → 结论：不做实时流式，改为"扫描结束后一次性交付 + 每页耗时统计"。
 *     进度提示仍按"每页回来更新一次"，在最常见的 10 秒内扫描里足够用。
 */
// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad(n, size) {
  let s = String(n);
  // 注意：不能写成 while (size-- > s.length)——那是后缀自减，位宽会被算成 size-1
  while (s.length < size) s = '0' + s;
  return s;
}

/** 文件名清洗：保留中日文等 Unicode，只剔除文件系统非法字符 */
function sanitizeName(name, fallback, maxLen) {
  let s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .replace(/^[_\s.]+|[_\s.]+$/g, '');
  const cap = maxLen || 120;
  if (s.length > cap) s = s.slice(0, cap).trim();
  if (!s) s = fallback || 'untitled';
  return s;
}

function extFromUrl(url) {
  try {
    const seg = (new URL(url).pathname.split('/').pop() || '');
    const m = seg.match(/\.([A-Za-z0-9]{2,5})$/);
    if (!m) return '';
    const e = m[1].toLowerCase();
    return e === 'jpeg' ? 'jpg' : e;
  } catch (e) {
    return '';
  }
}

function baseNameFromUrl(url) {
  try {
    const seg = decodeURIComponent((new URL(url).pathname.split('/').pop() || '').trim());
    if (!seg) return '';
    return sanitizeName(seg.replace(/\.[A-Za-z0-9]{2,5}$/, ''), '', 70);
  } catch (e) {
    return '';
  }
}

/** 汇总文件名：序号 + base + 尺寸标签 + 扩展名（尺寸标签用于区分同图不同尺寸） */
function buildFileName(img, index) {
  const base = baseNameFromUrl(img.url) || `image_${pad(index + 1, 3)}`;
  let ext = (img.ext || extFromUrl(img.url) || 'jpg').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (IMAGE_EXT.indexOf(ext) < 0) ext = 'jpg';
  const sizeTag = img.width && img.height ? `_${img.width}x${img.height}` : '';
  const name = `${pad(index + 1, 3)}_${base}${sizeTag}.${ext}`;
  return name.length > 150 ? name.slice(0, 140) + '.' + ext : name;
}

// ---------------------------------------------------------------------------
// 图片文件头解析（真实尺寸）—— 已用 PNG/GIF/BMP/JPEG/渐进JPEG/EXIF缩略图/WebP(VP8,VP8L)/SVG 实测通过
// ---------------------------------------------------------------------------

function parseImageSize(buf) {
  try {
    if (!buf || buf.byteLength < 16) return null;
    const b = new Uint8Array(buf);
    const dv = new DataView(buf);

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
            return {
              width: dv.getUint16(i + 3, true) & 0x3fff,
              height: dv.getUint16(i + 5, true) & 0x3fff,
              format: 'webp'
            };
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
    // AVIF/HEIC
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      let best = null;
      const limit = Math.min(b.length, 4096);
      let head = '';
      for (let i = 0; i < limit; i++) head += String.fromCharCode(b[i]);
      let idx = 0;
      while ((idx = head.indexOf('ispe', idx)) >= 0) {
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
    // SVG
    const limit = Math.min(b.length, 2048);
    let head = '';
    for (let i = 0; i < limit; i++) head += String.fromCharCode(b[i]);
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

/** Range 请求取头部 64KB 解析尺寸；Range 不支持时退化为整图 */
async function probeSize(url) {
  const attempts = [
    { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, partial: true },
    { headers: {}, partial: false }
  ];
  for (const a of attempts) {
    try {
      const res = await fetch(url, { headers: a.headers, credentials: 'include' });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const buf = await res.arrayBuffer();
      const size = parseImageSize(buf);
      if (size && size.width > 0) {
        size.mime = type;
        size.bytes = a.partial
          ? (parseInt((res.headers.get('content-range') || '').split('/')[1] || '0', 10) || null)
          : buf.byteLength;
        return size;
      }
      if (type.indexOf('image/') === 0) {
        return { width: 0, height: 0, mime: type, unknown: true, bytes: buf.byteLength };
      }
      if (a.partial) continue;
      return { width: 0, height: 0, mime: type, notImage: true };
    } catch (e) {
      if (a.partial) continue;
      return null;
    }
  }
  return null;
}

/** 受限并发池（泳道补位），带进度回调 */
async function runPool(items, concurrency, delayMs, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const lanes = new Array(Math.max(1, Math.min(concurrency, items.length || 1))).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = null;
      }
      done++;
      if (onProgress && (done % 4 === 0 || done === items.length)) onProgress(done, items.length);
      if (delayMs) await sleep(delayMs);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ---------------------------------------------------------------------------
// DNR：只用于"抓原图/绕防盗链"开关；会话级规则，任务结束即清
// ---------------------------------------------------------------------------

const DNR_ID = 9101;

async function enableFetchRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_ID],
      addRules: [{
        id: DNR_ID,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'remove' },
            { header: 'sec-fetch-dest', operation: 'set', value: 'document' },
            { header: 'sec-fetch-mode', operation: 'set', value: 'navigate' },
            { header: 'sec-fetch-site', operation: 'set', value: 'none' }
          ]
        },
        condition: { resourceTypes: ['image', 'xmlhttprequest'], urlFilter: '*://*/*' }
      }]
    });
    return true;
  } catch (e) {
    console.warn('[imgd] 防盗链规则未启用:', e && e.message);
    return false;
  }
}

async function disableFetchRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_ID] });
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 页内扫描（注入的真函数；必须自包含）
// ---------------------------------------------------------------------------

/**
 * 在页面里收集图片。返回 { href, title, images[] }。
 * 覆盖 6 类来源：img.currentSrc / picture/source[srcset] / CSS 背景 / video poster / 懒加载属性 / a[href] 直链
 */
function collectPageInDom() {
  const out = { href: location.href, title: document.title || '', images: [], error: null, scope: '' };
  try {
    const abs = (s) => { try { return new URL(s, location.href).href; } catch (e) { return ''; } };
    const extOf = (u) => {
      try {
        const m = new URL(u).pathname.match(/\.([A-Za-z0-9]{2,5})$/);
        return m ? m[1].toLowerCase() : '';
      } catch (e) { return ''; }
    };

    const scope = document.querySelector('.entry-content, .post-content, article, main, #content') ||
                  document.body || document.documentElement;
    out.scope = scope.className || scope.tagName;

    const seen = new Set();
    const push = (rawUrl, el) => {
      const url = abs(rawUrl || '');
      if (!url || !/^https?:/i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      let w = 0, h = 0;
      if (el && el.tagName === 'IMG') {
        w = el.naturalWidth || parseInt(el.getAttribute('width') || '0', 10) || 0;
        h = el.naturalHeight || parseInt(el.getAttribute('height') || '0', 10) || 0;
      }
      out.images.push({
        url,
        ext: extOf(url),
        width: w,
        height: h,
        alt: el ? (el.getAttribute('alt') || '').trim() : '',
        inScope: !!(el && scope.contains(el)),
        page: 1
      });
    };

    // 1) <img>：优先 currentSrc（srcset 的浏览器选择结果）
    const imgs = document.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const cand = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (cand && cand.indexOf('data:') === 0) continue;
      push(cand, img);
    }

    // 2) <source srcset>：取声明里最大的一档
    const sources = document.querySelectorAll('picture source[srcset], source[srcset]');
    for (let i = 0; i < sources.length; i++) {
      const raw = sources[i].getAttribute('srcset') || '';
      let best = '', bestW = -1;
      const parts = raw.split(',');
      for (let j = 0; j < parts.length; j++) {
        const t = parts[j].trim();
        if (!t) continue;
        const seg = t.split(/\s+/);
        const u = seg[0];
        let w = 0;
        if (seg[1]) {
          const m = seg[1].match(/^(\d+)(w|x)$/);
          if (m) w = parseInt(m[1], 10) * (m[2] === 'x' ? 1000 : 1);
        }
        if (w > bestW) { bestW = w; best = u; }
      }
      if (best) push(best, null);
    }

    // 3) CSS 背景图（限定正文容器 + 上限，避免全站 computedStyle 的性能坑）
    const bgNodes = scope.querySelectorAll('*');
    const limit = Math.min(bgNodes.length, 5000);
    for (let i = 0; i < limit; i++) {
      const el = bgNodes[i];
      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage; } catch (e) { continue; }
      if (!bg || bg === 'none' || bg.indexOf('url(') < 0) continue;
      const re = /url\((['"]?)([^'")]+)\1\)/g;
      let m;
      while ((m = re.exec(bg))) push(m[2], null);
    }

    // 4) 视频封面
    const vids = document.querySelectorAll('video[poster]');
    for (let i = 0; i < vids.length; i++) push(vids[i].getAttribute('poster'), null);

    // 5) 懒加载属性兜底
    const lazy = scope.querySelectorAll('[data-src],[data-original],[data-lazy-src],[data-echo]');
    for (let i = 0; i < lazy.length; i++) {
      const el = lazy[i];
      push(el.getAttribute('data-src') || el.getAttribute('data-original') ||
           el.getAttribute('data-lazy-src') || el.getAttribute('data-echo'), null);
    }

    // 6) <a> 直链（仅图片后缀）
    const anchors = scope.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length; i++) {
      const u = abs(anchors[i].getAttribute('href'));
      if (!u) continue;
      if (!/\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i.test(u)) continue;
      push(u, null);
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 分页 HTML 解析（service worker 无 DOMParser → 正则；已用真实页面验证）
// ---------------------------------------------------------------------------

function samePagerScope(candidate, currentUrl) {
  try {
    const a = new URL(candidate);
    const b = new URL(currentUrl);
    if (a.origin !== b.origin) return false;
    // 先做原始比较（避免 new URL().href 的百分号解码差异造成误判），再做归一化比较
    if (a.pathname === b.pathname) return true;
    const norm = (p) => p.replace(/\/\d+\/?$/, '/');
    return norm(a.pathname) === norm(b.pathname);
  } catch (e) {
    return false;
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&hellip;/g, '…').replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“');
}

/** 从一页 HTML 里抽出：标题、分页 URL、正文图片 URL */
function parseListingHtml(html, pageUrl) {
  // 标题
  let title = '';
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) title = decodeEntities(tm[1]).replace(/\s+/g, ' ').trim();

  // 正文范围：entry-content / post-content，否则全文
  let body = html;
  const em = html.match(/<div[^>]*class="[^"]*(?:entry-content|post-content|post-body)[^"]*"[^>]*>/i);
  if (em) {
    const start = html.indexOf(em[0]) + em[0].length;
    const rest = html.slice(start);
    const endMatch = rest.match(/<div[^>]*class="[^"]*(?:page-links|post-navigation|related-posts|comments-area|share)[^"]*"/i);
    body = endMatch ? rest.slice(0, endMatch.index) : rest;
  }

  // 图片（正文范围内）
  const images = [];
  const seen = new Set();
  const imgRe = /<img\b[^>]*>/gi;
  let im;
  while ((im = imgRe.exec(body))) {
    const tag = im[0];
    const sm = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!sm) continue;
    const raw = sm[1];
    if (!raw || raw.indexOf('data:') === 0) continue;
    let url;
    try { url = new URL(decodeEntities(raw), pageUrl).href; } catch (e) { continue; }
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const wm = tag.match(/\bwidth\s*=\s*["'](\d+)["']/i);
    const hm = tag.match(/\bheight\s*=\s*["'](\d+)["']/i);
    images.push({
      url,
      ext: extFromUrl(url),
      width: wm ? +wm[1] : 0,
      height: hm ? +hm[1] : 0,
      alt: '',
      inScope: true,
      page: 0
    });
  }

  // 分页链接：WordPress page-links 优先，再吃 rel=next 与 .../数字/ 形态
  const pageUrls = new Set();
  const blockRe = /<div[^>]*class="[^"]*page-links[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let bm;
  while ((bm = blockRe.exec(html))) {
    const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
    let hm2;
    while ((hm2 = hrefRe.exec(bm[1]))) {
      try {
        const u = new URL(decodeEntities(hm2[1]), pageUrl).href;
        if (samePagerScope(u, pageUrl)) pageUrls.add(u);
      } catch (e) { /* 忽略 */ }
    }
  }
  const nextRe = /<a\b[^>]*rel\s*=\s*["'][^"']*\bnext\b[^"']*["'][^>]*href\s*=\s*["']([^"']+)["']/gi;
  let nm;
  while ((nm = nextRe.exec(html))) {
    try {
      const u = new URL(decodeEntities(nm[1]), pageUrl).href;
      if (samePagerScope(u, pageUrl)) pageUrls.add(u);
    } catch (e) { /* 忽略 */ }
  }
  // 兜底：同族 .../数字/ 链接
  const allHref = /href\s*=\s*["']([^"']+)["']/gi;
  let ah;
  while ((ah = allHref.exec(html))) {
    const raw = decodeEntities(ah[1]);
    if (!/\/\d+\/?$/.test(raw)) continue;
    try {
      const u = new URL(raw, pageUrl).href;
      if (samePagerScope(u, pageUrl)) pageUrls.add(u);
    } catch (e) { /* 忽略 */ }
  }

  const curMatch = new URL(pageUrl).pathname.match(/\/(\d+)\/?$/);
  const page = curMatch ? +curMatch[1] : 1;
  for (const img of images) img.page = page;

  return { title, pageUrl, page, images, nextPages: [...pageUrls] };
}

/**
 * BFS 遍历分页；maxPages 由用户设置控制（1 = 只扫当前页）
 *
 * 并发模型：泳道补位（没有批次屏障）。
 * 实测目标站点单页响应在 350ms ~ 6s 之间剧烈波动，若按"一次取 N 页、等整批回来"来做，
 * 最慢的那一页会把整批空转拖住（实测因此多等近 10 秒）。这里改成任一泳道空出就立刻补位。
 */
async function crawlPages(startUrl, maxPages, tune, onProgress, onPageDone) {
  const cap = Math.max(1, Math.min(MAX_PAGES, parseInt(maxPages, 10) || MAX_PAGES));
  const concurrency = Math.max(1, Math.min(8, parseInt(tune && tune.concurrency, 10) || PAGE_CONCURRENCY));
  const delayMs = Math.max(0, Math.min(2000, (tune && tune.delay != null) ? parseInt(tune.delay, 10) : PAGE_DELAY)) || 0;
  const visited = new Set([startUrl]);      // 见过的页（含已抓完和在飞的）
  const fetching = new Set();               // 在飞
  const queue = [startUrl];                 // 待抓（取出即出队）
  const fetchedUrls = [];                   // 实际发出过请求的 URL（含重复），用于检测重复抓取
  const pages = [];
  let allImages = [];
  let title = '';
  let doneCount = 0;
  let pending = 0;

  const report = () => {
    // 三个数字互不重叠：已处理 + 队列待抓 + 在飞 = 总数
    if (onProgress) onProgress(doneCount, queue.length, visited.size, fetching.size);
  };
  const settle = () => new Promise((resolve) => {
    let finished = false;
    const pump = () => {
      if (finished) return;
      while (fetching.size < concurrency && queue.length) {
        const u = queue.shift();
        fetching.add(u);
        fetchedUrls.push(u);
        const t0 = Date.now();
        const task = (async () => {
          try {
            const res = await fetch(u, { credentials: 'include' });
            if (!res.ok) return { pageUrl: u, error: 'HTTP ' + res.status, images: [], ms: Date.now() - t0 };
            const html = await res.text();
            const parsed = parseListingHtml(html, u);
            parsed.htmlBytes = html.length;
            parsed.ms = Date.now() - t0;
            return parsed;
          } catch (e) {
            return { pageUrl: u, error: (e && e.message) || '请求失败', images: [], ms: Date.now() - t0 };
          }
        })();

        task.then((r) => {
          if (r.title && !title) title = r.title;
          if (r.images && r.images.length) allImages = allImages.concat(r.images);
          for (const nx of (r.nextPages || [])) {
            if (!visited.has(nx) && visited.size < cap) {
              visited.add(nx);
              queue.push(nx);
            }
          }
          if (onPageDone) onPageDone(r);
          return r;
        }).catch(() => null).then((r) => {
          fetching.delete(u);
          doneCount++;
          pages.push(r || { pageUrl: u, error: '未知错误', images: [] });
          report();
          if (delayMs) setTimeout(pump, delayMs); else pump();
        });
      }
      // 泳道已空且无待抓 → 全部完成（在同一轮里判空，避免竞态）
      if (fetching.size === 0 && queue.length === 0 && !finished) {
        finished = true;
        resolve();
      }
    };
    pump();
  });

  await settle();

  return {
    title,
    pages,
    images: allImages,
    pagesFound: fetchedUrls.length,
    pagesDiscovered: visited.size,
    capped: queue.length > 0,
    cap,
    duplicatedFetches: fetchedUrls.length - new Set(fetchedUrls).size,
    // 每页耗时/张数/错误：popup 用它提示"哪一页慢"，这是"扫描卡住"的直接答案
    pageStats: pages.map((p) => ({
      url: p.pageUrl, ms: p.ms || 0,
      images: (p.images || []).length, error: p.error || null
    }))
  };
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

function downloadOne(url, filename) {
  return new Promise((resolve) => {
    try {
      pendingPaths.set(url, filename);
      // 注意：这里的 filename 只用于 onDeterminingFilename 的 suggest()，不交给 downloads.download()
      // （带目录的 filename 会被 downloads.download() 丢弃，见 registerPath 分支的说明）
      chrome.downloads.download({ url, conflictAction: 'uniquify', saveAs: false }, (id) => {
        if (chrome.runtime.lastError || id == null) {
          pendingPaths.delete(url);
          resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || '下载未启动' });
        } else {
          resolve({ ok: true, id });
        }
      });
    } catch (e) {
      pendingPaths.delete(url);
      resolve({ ok: false, error: (e && e.message) || '异常' });
    }
  });
}

/**
 * 等下载落盘：轮询 downloads.search，而不是只等 downloads.onChanged
 *
 * 实测（Edge 154 / headless）：onChanged 事件在本机不可靠——3 张小图的下载，
 * 文件其实瞬间就写完了，但 onChanged 迟迟不来，导致一直等到 180 秒超时才返回。
 * 轮询是确定性的，并且能顺手区分 complete / interrupted。
 */
async function waitForDownloads(ids, onProgress) {
  if (!ids.length) return { failedIds: [] };
  const state = new Map();
  for (const id of ids) state.set(id, 'in_progress');
  const t0 = Date.now();
  let done = 0;

  while (Date.now() - t0 < DOWNLOAD_TIMEOUT) {
    const pending = [...state.entries()].filter(([, s]) => s === 'in_progress').map(([id]) => id);
    if (!pending.length) break;
    try {
      const items = await chrome.downloads.search({ ids: pending });
      for (const it of items) {
        if (!it || !state.has(it.id)) continue;
        if (it.state && it.state !== 'in_progress') {
          state.set(it.id, it.state);
          done++;
          if (onProgress) onProgress(done, ids.length);
        }
      }
    } catch (e) { /* 查询失败就下一轮再试 */ }
    if ([...state.values()].every((s) => s !== 'in_progress')) break;
    await sleep(200);
  }

  return { failedIds: [...state.entries()].filter(([, s]) => s !== 'complete').map(([id]) => id) };
}

async function runDownloadJob(job, send) {
  const imgs = job.images || [];
  if (!imgs.length) return { ok: false, error: '没有可下载的图片' };
  const folder = sanitizeName(job.folder, 'images', FOLDER_MAX);
  const T0 = Date.now();
  const timing = {};

  await setJobState({ kind: 'download', running: true, done: 0, total: imgs.length, failed: 0, status: '正在下载', startedAt: T0 });

  const failed = [];
  let finished = 0;
  let okCount = 0;

  const results = await runPool(imgs, DL_CONCURRENCY, DL_DELAY, async (img, i) => {
    const path = `${folder}/${buildFileName(img, i)}`;
    const r = await downloadOne(img.url, path);
    if (!r.ok) failed.push({ url: img.url, error: r.error });
    finished++;
    setJobState({ done: finished, failed: failed.length, status: '正在下载' });
    send({ type: 'progress', phase: 'download', done: finished, total: imgs.length, failed: failed.length });
    return r;
  }, null);
  timing.startMs = Date.now() - T0;

  const ids = results.filter((r) => r && r.ok).map((r) => r.id);
  okCount = ids.length;

  const waited = await waitForDownloads(ids, (d, t) => {
    setJobState({ done: finished, saving: d, savingTotal: t, failed: failed.length, status: '正在写入磁盘' });
    send({ type: 'progress', phase: 'saving', done: d, total: t, failed: failed.length });
  });
  timing.waitMs = Date.now() - T0 - timing.startMs;
  for (const id of waited.failedIds) {
    try {
      const [item] = await chrome.downloads.search({ id });
      if (item) failed.push({ url: item.url, error: item.error || '下载被中断' });
    } catch (e) { /* 忽略 */ }
  }
  timing.totalMs = Date.now() - T0;

  const result = {
    ok: failed.length === 0,
    folder,
    total: imgs.length,
    started: okCount,
    completed: okCount - waited.failedIds.length,
    failed,
    timing
  };
  await setJobState({
    kind: 'download', running: false, status: failed.length ? '部分失败' : '完成',
    done: imgs.length, failed: failed.length, folder,
    completed: result.completed, total: imgs.length, timing
  });
  return result;
}

/** popup 轮询下载/打包进度（替代不可靠的 result 广播） */
async function getJobState() {
  try {
    const r = await chrome.storage.local.get(JOB_STATE_KEY);
    return { ok: true, job: (r && r[JOB_STATE_KEY]) || null };
  } catch (e) {
    return { ok: false, job: null, error: (e && e.message) || '读取失败' };
  }
}

// ---------------------------------------------------------------------------
// ZIP —— 已移除
// ---------------------------------------------------------------------------
// 实测结论（Edge 154 / MV3，两条都是运行时验证过的）：
//   1) service worker 里 URL.createObjectURL / revokeObjectURL 不存在
//      （URL 上只有 length,name,prototype,canParse,parse），也没有 document / DOMParser
//   2) chrome.runtime.sendMessage 会把对象 JSON 序列化 —— JSZip 实例传过去后
//      原型丢失，变成 { files: {...} }，调用 generateAsync 报 "is not a function"
// 因此 ZIP 的抓取、组装、落盘三件事全部放在 popup 里做（见 popup.js 的 buildZipInPopup）。
// 后台只为 popup 提供 DNR 开关与通用工具。

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
  });
}

function isRestricted(url) {
  return !url || !/^https?:/i.test(url) || /^https:\/\/(chromewebstore|microsoftedge\.microsoft)\./i.test(url);
}

async function handleMessage(msg, send) {
  try {
    return await handleMessageInner(msg, send);
  } catch (e) {
    return { ok: false, error: 'handler-exception: ' + ((e && e.message) || String(e)), stack: String((e && e.stack) || '').slice(0, 400) };
  }
}

async function handleMessageInner(msg, send) {
  switch (msg && msg.type) {
    case 'scan': {
      const tab = await getActiveTab();
      if (!tab || !tab.id) return { ok: false, error: '找不到当前标签页' };
      if (isRestricted(tab.url)) {
        return { ok: false, error: '当前页面不支持扫描（浏览器内部页 / 扩展商店页）' };
      }

      // 1) 当前页：注入扫描，能拿到 naturalWidth（最准）
      let dom = null;
      let injectError = null;
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: collectPageInDom
        });
        dom = res && res.result;
      } catch (e) {
        injectError = (e && e.message) || '注入失败';
      }

      const startUrl = (dom && dom.href) || tab.url;

      // 2) 分页：拉 HTML 解析（站点无关，有分页链接就跟随）
      //    crawlPages: 1 页 = 只扫当前页；其余数字 = 页数上限
      const cap = Math.max(1, Math.min(MAX_PAGES, parseInt(msg.maxPages, 10) || MAX_PAGES));
      const tune = msg.tune || {};
      const probeConc = Math.max(1, Math.min(12, parseInt(tune.probeConcurrency, 10) || PROBE_CONCURRENCY));

      // 站点响应时间可能极不稳定（实测同一页 434ms ~ 12.6s），所以：
      //   · 分页抓取用泳道补位（无批次屏障），慢页不会拖住其它页
      //   · 每抓完一页就立刻把该页的图送进探测队列，探测与分页抓取重叠进行
      const probeQueue = [];
      let probeRunning = false;
      let probeDone = 0;
      let probeTotalSeen = 0;
      let probeIndex = 0;

      const pumpProbe = async () => {
        if (probeRunning) return;
        probeRunning = true;
        try {
          while (probeIndex < probeQueue.length) {
            const chunk = probeQueue.slice(probeIndex, probeIndex + 24);
            probeIndex += chunk.length;
            await runPool(chunk, probeConc, 0, async (u) => {
              const s = await probeSize(u);
              probeDone++;
              return s;
            });
          }
        } finally {
          probeRunning = false;
        }
      };

      const enqueueProbe = (urls) => {
        for (const u of urls) {
          if (probeQueue.indexOf(u) < 0) probeQueue.push(u);
        }
        probeTotalSeen = probeQueue.length;
        pumpProbe(); // 不 await：与分页抓取并行
      };

      // 当前页（DOM 版已有尺寸的就不用再探测）
      const domImgs = (dom && dom.images) || [];
      enqueueProbe(domImgs.filter((i) => !(i.width && i.height)).map((i) => i.url));

      let crawl;
      if (cap === 1) {
        crawl = { title: '', pages: [], images: [], pagesFound: 1, pagesDiscovered: 1, capped: false, cap: 1, skipped: true };
      } else {
        crawl = await crawlPages(
          startUrl, cap, tune,
          null,   // 进度不再实时推送（见文件顶部"关于扫描期实时进度的取舍"）
          (page) => {
            // 一页到手就立刻送去探测
            const urls = (page.images || []).filter((i) => !(i.width && i.height)).map((i) => i.url);
            if (urls.length) enqueueProbe(urls);
          }
        );
      }

      // 等剩余探测跑完
      await pumpProbe();
      while (probeRunning || probeIndex < probeQueue.length) await sleep(120);

      // 3) 合并：当前页 DOM 版优先（带真实尺寸），分页版补充
      const merged = [];
      const seen = new Set();
      for (const i of (dom && dom.images) || []) {
        if (!seen.has(i.url)) { seen.add(i.url); i.source = 'dom'; merged.push(i); }
      }
      for (const i of crawl.images) {
        if (!seen.has(i.url)) { seen.add(i.url); i.source = 'page'; merged.push(i); }
      }

      const title = decodeEntities((dom && dom.title) || crawl.title || tab.title || '').trim();

      return {
        ok: true,
        tabId: tab.id,
        pageUrl: startUrl,
        title,
        scope: (dom && dom.scope) || '',
        maxPages: crawl.cap,
        crawlSkipped: !!crawl.skipped,
        pagesFound: crawl.pagesFound,
        pagesDiscovered: crawl.pagesDiscovered,
        pagesCapped: !!crawl.capped,
        pageErrors: crawl.pages.filter((p) => p.error).map((p) => ({ url: p.pageUrl, error: p.error })),
        pageStats: crawl.pageStats || [],
        domCount: (dom && dom.images.length) || 0,
        crawlCount: crawl.images.length,
        total: merged.length,
        images: merged,
        injectError
      };
    }





    case 'probe': {
      const all = msg.urls || [];
      const urls = all.slice(0, PROBE_LIMIT);
      const probeConc = Math.max(1, Math.min(12, parseInt(msg.concurrency, 10) || PROBE_CONCURRENCY));
      const sizes = await runPool(urls, probeConc, 0, async (u) => {
        const s = await probeSize(u);
        if (!s) return { url: u, width: 0, height: 0, failed: true };
        if (s.notImage) return { url: u, width: 0, height: 0, notImage: true, mime: s.mime || '' };
        return {
          url: u, width: s.width || 0, height: s.height || 0,
          mime: s.mime || '', bytes: s.bytes || null,
          format: s.format || '', vector: !!s.vector, unknown: !!s.unknown
        };
      }, (d, t) => send({ type: 'probe-progress', done: d, total: t }));
      return { ok: true, sizes, truncated: all.length > PROBE_LIMIT, limit: PROBE_LIMIT, requested: all.length };
    }

    case 'download': {
      const useRules = !!msg.useFetchRules;
      if (useRules) await enableFetchRules();
      try {
        const r = await runDownloadJob(msg.job || {}, send);
        if (msg.job && msg.job.folder) {
          await chrome.storage.local.set({ [FOLDER_KEY]: msg.job.folder }).catch(() => {});
        }
        return r;
      } catch (e) {
        // 任何异常都要写成终态，否则 popup 会一直停在"正在下载…"（实测踩过）
        await setJobState({
          kind: 'download', running: false, status: '异常',
          error: (e && e.message) || String(e)
        });
        return { ok: false, error: (e && e.message) || String(e) };
      } finally {
        if (useRules) await disableFetchRules();
      }
    }

    case 'zip': {
      // ZIP 实际在 popup 里完成（见 popup.js），这里已不再处理
      // ZIP 已迁至 popup（见上方说明）：后台不再处理，直接明确报错而不是静默失败
      return { ok: false, error: 'ZIP 由 popup 侧处理，后台不再提供该指令' };
    }

    case 'registerPath': {
      // 实测（Edge 154）：chrome.downloads.download() 的 filename 参数**不接受带目录的路径**，
      // 传 "目录/文件名.png" 会被丢弃目录并把文件名替换成默认名。
      // 目录必须通过 downloads.onDeterminingFilename 的 suggest() 给出，故这里先登记映射。
      if (msg.url && msg.path) pendingPaths.set(msg.url, msg.path);
      return { ok: true };
    }

    case 'setJobState': {
      await setJobState(msg.patch || {});
      return { ok: true };
    }

    case 'clearJob': {
      await clearJobState();
      return { ok: true };
    }

    case 'pollJob': {
      return await getJobState();
    }

    case 'openFolder': {
      try {
        const folder = sanitizeName(msg.folder || '', '', FOLDER_MAX);
        if (folder) {
          const items = await chrome.downloads.search({
            filenameRegex: folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            limit: 1,
            orderBy: ['-startTime']
          });
          if (items && items[0]) { chrome.downloads.show(items[0].id); return { ok: true }; }
        }
        chrome.downloads.showDefaultFolder();
        return { ok: true, fallback: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || '打开失败' };
      }
    }

    default:
      return { ok: false, error: '未知指令: ' + (msg && msg.type) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  try { (self.__rxLog = self.__rxLog || []).push(msg.type + '@' + Date.now()); if (self.__rxLog.length > 200) self.__rxLog.shift(); } catch (e) {}
  if (msg.type === 'progress' || msg.type === 'result' || msg.type === 'scan-progress' ||
      msg.type === 'probe-progress' || msg.type === 'scan-page' || msg.type === 'scan-image') return;

  const send = (payload) => {
    try { chrome.runtime.sendMessage(payload); } catch (e) { /* popup 已关闭 */ }
  };
  // 先 ACK，长任务随后用 send 推事件（MV3 长任务会超出消息通道寿命）
  sendResponse({ ok: true, accepted: msg.type });
  handleMessage(msg, send)
    .then((result) => send({ type: 'result', forType: msg.type, result }))
    .catch((e) => send({ type: 'result', forType: msg.type, result: { ok: false, error: (e && e.message) || String(e) } }));
  return true;
});

// 文件名强制：防止被服务器 Content-Disposition 改名
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const want = pendingPaths.get(item.url);
  if (want) {
    pendingPaths.delete(item.url);
    suggest({ filename: want, conflictAction: 'uniquify' });
  } else {
    suggest();
  }
});
