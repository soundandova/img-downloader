/**
 * 一键看图下载 —— popup
 * 流程：扫描（含分页）→ 探测真实尺寸（Range）→ 过滤/勾选 → 下载或打包 ZIP
 */

const $ = (id) => document.getElementById(id);

const els = {
  ver: $('ver'),
  pageTitle: $('pageTitle'),
  minW: $('minW'),
  minH: $('minH'),
  onlyScope: $('onlyScope'),
  multiPage: $('multiPage'),
  pageCap: $('pageCap'),
  pageCapLabel: $('pageCapLabel'),
  pageConcurrency: $('pageConcurrency'),
  pageDelay: $('pageDelay'),
  probeConcurrency: $('probeConcurrency'),
  fetchRules: $('fetchRules'),
  useFolder: $('useFolder'),
  btnScan: $('btnScan'),
  btnZip: $('btnZip'),
  btnDl: $('btnDl'),
  selCount: $('selCount'),
  btnAll: $('btnAll'),
  btnNone: $('btnNone'),
  sortBy: $('sortBy'),
  filterType: $('filterType'),
  bar: $('bar'),
  status: $('status'),
  meta: $('meta'),
  grid: $('grid'),
  failBox: $('failBox'),
  failCount: $('failCount'),
  failList: $('failList'),
  btnCopyFail: $('btnCopyFail')
};

const state = {
  busy: false,
  job: null,           // 扫描结果
  pageStats: [],       // 每页抓取耗时/张数，用于定位慢页
  probed: new Map(),   // url -> {width,height,mime,bytes,format,failed,notImage,unknown}
  selected: new Set(), // url
  failures: [],
  probedOnce: false
};

const SETTINGS_KEY = 'imgd_settings_v1';

// ---------------------------------------------------------------------------
// 设置持久化
// ---------------------------------------------------------------------------

function readSettings() {
  return {
    minW: parseInt(els.minW.value, 10) || 0,
    minH: parseInt(els.minH.value, 10) || 0,
    onlyScope: els.onlyScope.checked,
    multiPage: els.multiPage.checked,
    pageCap: parseInt(els.pageCap.value, 10) || 60,
    pageConcurrency: parseInt(els.pageConcurrency.value, 10) || 4,
    pageDelay: parseInt(els.pageDelay.value, 10) || 0,
    probeConcurrency: parseInt(els.probeConcurrency.value, 10) || 6,
    fetchRules: els.fetchRules.checked,
    useFolder: els.useFolder.checked,
    sortBy: els.sortBy.value,
    filterType: els.filterType.value
  };
}

/** 当前应该发给后台的分页上限：1 = 只扫当前页 */
function currentMaxPages() {
  if (!els.multiPage.checked) return 1;
  const v = parseInt(els.pageCap.value, 10);
  return Math.max(2, Math.min(60, v || 60));
}

/** 抓取节奏参数 */
function currentTune() {
  const clamp = (el, lo, hi, dflt) => {
    const v = parseInt(el.value, 10);
    return Math.max(lo, Math.min(hi, isNaN(v) ? dflt : v));
  };
  return {
    concurrency: clamp(els.pageConcurrency, 1, 8, 4),
    delay: clamp(els.pageDelay, 0, 2000, 100),
    probeConcurrency: clamp(els.probeConcurrency, 1, 12, 6)
  };
}

/** 关闭「探测多页」时把上限输入一起禁用，避免误解 */
function syncPageCapUi() {
  const on = els.multiPage.checked;
  els.pageCap.disabled = !on;
  els.pageCapLabel.style.opacity = on ? '1' : '.45';
  els.pageCap.style.opacity = on ? '1' : '.45';
}

async function saveSettings() {
  try { await chrome.storage.local.set({ [SETTINGS_KEY]: readSettings() }); } catch (e) { /* 忽略 */ }
}

async function restoreSettings() {
  try {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    const s = r && r[SETTINGS_KEY];
    if (!s) return;
    if (typeof s.minW === 'number') els.minW.value = s.minW;
    if (typeof s.minH === 'number') els.minH.value = s.minH;
    if (typeof s.onlyScope === 'boolean') els.onlyScope.checked = s.onlyScope;
    if (typeof s.multiPage === 'boolean') els.multiPage.checked = s.multiPage;
    if (typeof s.pageCap === 'number' && s.pageCap >= 2) els.pageCap.value = Math.min(60, s.pageCap);
    if (typeof s.pageConcurrency === 'number') els.pageConcurrency.value = Math.max(1, Math.min(8, s.pageConcurrency));
    if (typeof s.pageDelay === 'number') els.pageDelay.value = Math.max(0, Math.min(2000, s.pageDelay));
    if (typeof s.probeConcurrency === 'number') els.probeConcurrency.value = Math.max(1, Math.min(12, s.probeConcurrency));
    if (typeof s.fetchRules === 'boolean') els.fetchRules.checked = s.fetchRules;
    if (typeof s.useFolder === 'boolean') els.useFolder.checked = s.useFolder;
    if (s.sortBy) els.sortBy.value = s.sortBy;
    if (s.filterType) els.filterType.value = s.filterType;
    syncPageCapUi();
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 与后台通信：send 先拿到 ACK，真实结果通过 runtime 广播的 result 事件回来
// ---------------------------------------------------------------------------

function waitForResult(type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('等待结果超时'));
    }, timeoutMs || 300000);
    function listener(msg) {
      if (!msg || msg.type !== 'result' || msg.forType !== type) return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(msg.result);
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

function onProgress(handler) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'progress' || msg.type === 'scan-progress' || msg.type === 'probe-progress') handler(msg);
  });
}

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (ack) => {
      void chrome.runtime.lastError;
      resolve(ack);
    });
  });
}

// ---------------------------------------------------------------------------
// UI 工具
// ---------------------------------------------------------------------------

function setBusy(busy, text) {
  state.busy = busy;
  els.btnScan.disabled = busy;
  updateButtons();
  if (text) els.status.textContent = text;
}

function setBar(pct) {
  els.bar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
}

function setMeta(html) {
  els.meta.innerHTML = html || '';
}

function updateButtons() {
  const job = state.job;
  const has = !!(job && job.images && job.images.length);
  const sel = state.selected.size;
  els.selCount.textContent = String(sel);
  els.btnDl.disabled = state.busy || sel === 0;
  els.btnZip.disabled = state.busy || !has;

  // 按钮为什么是灰的，直接写在提示里，别让人猜
  if (state.busy) {
    els.btnZip.title = '正在忙，完成后可用';
  } else if (!has) {
    els.btnZip.title = '先点「扫描页面」';
  } else {
    const n = passingSelected().length;
    els.btnZip.title = n > 0
      ? `打包选中的 ${n} 张为 ZIP`
      : `打包全部通过尺寸过滤的 ${job.images.filter(imgPasses).length} 张为 ZIP`;
  }
  els.btnDl.title = state.busy ? '正在忙'
    : (sel === 0 ? '先在网格里勾选图片' : `逐张下载选中的 ${sel} 张`);
}

function humanBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return Math.round(n / 1024) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}

function domainOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return ''; }
}

function escapesHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function encodeUrlForCss(url) {
  return String(url).replace(/[\\"()\s]/g, (c) => encodeURIComponent(c));
}

// ---------------------------------------------------------------------------
// 过滤 / 排序
// ---------------------------------------------------------------------------

function imgPasses(img) {
  const minW = parseInt(els.minW.value, 10) || 0;
  const minH = parseInt(els.minH.value, 10) || 0;
  if (els.onlyScope.checked && img.inScope === false) return false;
  const p = state.probed.get(img.url);
  const w = (p && p.width) || img.width || 0;
  const h = (p && p.height) || img.height || 0;
  if (!w || !h) return true;             // 尺寸未知 → 放行（不静默丢图）
  if (minW && w < minW) return false;
  if (minH && h < minH) return false;
  return true;
}

function imgPassesUnknown(img) {
  const p = state.probed.get(img.url);
  const w = (p && p.width) || img.width || 0;
  const h = (p && p.height) || img.height || 0;
  return !w || !h;
}

function visibleImages() {
  const job = state.job;
  if (!job || !job.images) return [];
  const mode = els.filterType.value;
  let list = job.images.slice();
  if (mode === 'ok') list = list.filter(imgPasses);
  else if (mode === 'small') list = list.filter((i) => !imgPasses(i));
  else if (mode === 'unknown') list = list.filter(imgPassesUnknown);

  const sort = els.sortBy.value;
  const dimOf = (i) => {
    const p = state.probed.get(i.url);
    const w = (p && p.width) || i.width || 0;
    const h = (p && p.height) || i.height || 0;
    return w * h;
  };
  if (sort === 'size') list.sort((a, b) => dimOf(b) - dimOf(a));
  else if (sort === 'name') list.sort((a, b) => a.url.split('/').pop().localeCompare(b.url.split('/').pop()));
  else if (sort === 'domain') list.sort((a, b) => domainOf(a.url).localeCompare(domainOf(b.url)));
  else list.sort((a, b) => (a.page || 0) - (b.page || 0));
  return list;
}

function passingSelected() {
  const job = state.job;
  if (!job || !job.images) return [];
  return job.images.filter((i) => state.selected.has(i.url) && imgPasses(i));
}

// ---------------------------------------------------------------------------
// 网格渲染（keyed 增量更新，避免每次 progress 重建 DOM）
// ---------------------------------------------------------------------------

const cards = new Map(); // url -> element

function renderGrid() {
  const list = visibleImages();
  const wanted = new Set(list.map((i) => i.url));

  for (const [url, el] of cards) {
    if (!wanted.has(url)) { el.remove(); cards.delete(url); }
  }

  let anchor = null;
  for (const img of list) {
    let el = cards.get(img.url);
    if (!el) {
      el = buildCard(img);
      cards.set(img.url, el);
    }
    updateCard(el, img);
    // 保持顺序
    const next = anchor ? anchor.nextSibling : els.grid.firstChild;
    if (el !== next) els.grid.insertBefore(el, next);
    anchor = el;
  }
}

function buildCard(img) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.url = img.url;

  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.className = 'tick';

  const page = document.createElement('span');
  page.className = 'page';

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.loading = 'lazy';
  thumb.referrerPolicy = 'no-referrer';
  thumb.decoding = 'async';
  thumb.addEventListener('error', () => {
    thumb.replaceWith(Object.assign(document.createElement('div'), {
      className: 'broken', textContent: '预览失败'
    }));
  });

  const info = document.createElement('div');
  info.className = 'info';
  const size = document.createElement('span');
  size.className = 'size';
  const dom = document.createElement('span');
  dom.className = 'dom';
  info.append(size, dom);

  el.append(tick, page, thumb, info);

  el.addEventListener('click', (e) => {
    if (e.target === tick) return;
    tick.checked = !tick.checked;
    toggleSelect(img.url, tick.checked);
  });
  tick.addEventListener('change', () => toggleSelect(img.url, tick.checked));

  el._parts = { tick, page, thumb, size, dom };
  return el;
}

function updateCard(el, img) {
  const { tick, page, thumb, size, dom } = el._parts;
  if (!thumb.isConnected && !el.querySelector('.broken')) return; // 预览已失败
  if (!thumb.src) thumb.src = img.url;
  tick.checked = state.selected.has(img.url);
  el.classList.toggle('sel', tick.checked);
  el.classList.toggle('dim', !imgPasses(img));
  page.textContent = img.page ? 'P' + img.page : '';
  page.hidden = !img.page || img.page === 1;

  const p = state.probed.get(img.url);
  const w = (p && p.width) || img.width || 0;
  const h = (p && p.height) || img.height || 0;
  if (w && h) {
    size.textContent = w + '×' + h;
    size.classList.remove('unknown');
    size.title = [
      p && p.mime ? 'MIME: ' + p.mime : '',
      p && p.format ? '格式: ' + p.format : '',
      p && p.bytes ? '大小: ' + humanBytes(p.bytes) : ''
    ].filter(Boolean).join('\n');
  } else if (p && p.failed) {
    size.textContent = '探测失败';
    size.classList.add('unknown');
    size.title = 'Range 请求失败，按原尺寸放行';
  } else if (p && p.notImage) {
    size.textContent = '非图片';
    size.classList.add('unknown');
    size.title = p.mime || '';
  } else {
    size.textContent = '尺寸未知';
    size.classList.add('unknown');
    size.title = '尚未探测到真实尺寸';
  }
  dom.textContent = domainOf(img.url);
  dom.title = img.url;
}

function toggleSelect(url, on) {
  if (on) state.selected.add(url); else state.selected.delete(url);
  const el = cards.get(url);
  if (el) {
    el._parts.tick.checked = on;
    el.classList.toggle('sel', on);
  }
  updateButtons();
}

/** 把后台探测出的单张结果并入状态与网格 */


/** 轮询到的进度 -> 状态栏（数字互不重叠：已处理 + 队列 + 在飞 = 总数） */


// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

async function doScan() {
  if (state.busy) return;
  state.job = null;
  state.probed.clear();
  state.selected.clear();
  state.failures = [];
  state.probedOnce = false;
  state.pageStats = [];
  cards.clear();
  els.grid.innerHTML = '';
  els.failBox.hidden = true;
  setBar(0);
  setMeta('');
  setBusy(true, els.multiPage.checked ? '正在扫描当前页面…' : '正在扫描当前页面（仅本页）…');
  els.pageTitle.textContent = '—';

  try {
    const ack = await send('scan', { maxPages: currentMaxPages(), tune: currentTune() });
    if (!ack || !ack.ok) throw new Error('无法与后台通信');
    const res = await waitForResult('scan', 300000);
    if (!res || !res.ok) throw new Error((res && res.error) || '扫描失败');
    state.pageStats = res.pageStats || [];

    state.job = res;
    els.pageTitle.textContent = res.title || '(无标题)';
    els.pageTitle.title = res.pageUrl || '';

    const imgs = res.images || [];
    for (const i of imgs) {
      if (i.width && i.height) state.probed.set(i.url, { width: i.width, height: i.height });
    }

    const parts = [
      `共 <strong>${res.total}</strong> 张`,
      `当前页采集 ${res.domCount} 张`
    ];
    if (res.crawlSkipped) {
      parts.push('<span class="warn">未探测多页</span>');
    } else {
      parts.push(`分页抓取 ${res.pagesFound} 页`);
      if (res.crawlCount) parts.push(`补充 ${res.crawlCount} 张`);
    }
    if (res.pageErrors && res.pageErrors.length) {
      parts.push(`<span class="err">分页失败 ${res.pageErrors.length}</span>`);
    }
    if (res.pagesCapped) {
      parts.push(`<span class="warn">已达页数上限 ${res.maxPages}，还有未抓的分页</span>`);
    }
    if (res.injectError) parts.push(`<span class="warn">注入: ${escapesHtml(res.injectError)}</span>`);
    // 慢页提示：站点响应不稳定时，这是"为什么扫描慢"的直接答案
    const slowPages = (state.pageStats || []).filter((p) => p.ms > 3000);
    if (slowPages.length) {
      const worst = slowPages.reduce((a, b) => (b.ms > a.ms ? b : a));
      parts.push(`<span class="warn">有 ${slowPages.length} 页响应超 3 秒（最慢 ${(worst.ms / 1000).toFixed(1)}s，站点侧）</span>`);
    }
    setMeta(parts.join(' · '));
    setBar(30);

    if (!imgs.length) {
      setBusy(false, '没有找到图片');
      return;
    }

    setBusy(true, '正在探测真实尺寸…');
    await probeAll(imgs);

    applyAutoMin();
    renderGrid();
    autoSelect();
    // 关键：扫描成功路径必须解除 busy，否则两个按钮会永久禁用
    // （曾经的 bug：这里漏了复位，导致扫描一结束「打包 ZIP」就是灰的）
    setBusy(false);
    summarize();
    updateButtons();
  } catch (e) {
    setBusy(false, '扫描失败：' + ((e && e.message) || e));
    setBar(0);
  }
}

/** 用 Range 请求批量探测真实尺寸，分批发送以便实时刷新 */
async function probeAll(images) {
  const CHUNK = 40;
  const urls = images.map((i) => i.url);
  let done = 0;
  let truncated = false;

  for (let i = 0; i < urls.length; i += CHUNK) {
    const batch = urls.slice(i, i + CHUNK);
    const ack = await send('probe', { urls: batch, concurrency: currentTune().probeConcurrency });
    if (!ack || !ack.ok) continue;
    const res = await waitForResult('probe', 120000);
    if (!res || !res.ok) continue;
    if (res.truncated) truncated = true;
    for (const s of res.sizes || []) {
      const prev = state.probed.get(s.url) || {};
      state.probed.set(s.url, Object.assign({}, prev, s));
    }
    done += batch.length;
    setBar(30 + Math.round((done / urls.length) * 60));
    setBusy(true, `正在探测真实尺寸… ${done}/${urls.length}`);
    renderGrid();
  }
  state.probedOnce = true;
  if (truncated) {
    state.failures.push({ url: '(提示)', error: `图片数超过单次探测上限，部分未探测真实尺寸` });
  }
}

/** 首轮把最小尺寸默认设成"最小那张的尺寸"，让用户看到真实分布又不至于空手 */
function applyAutoMin() {
  const cur = parseInt(els.minW.value, 10) || 0;
  const curH = parseInt(els.minH.value, 10) || 0;
  if (cur || curH) return; // 用户已设置过，不要覆盖
  const sizes = [];
  for (const [, p] of state.probed) if (p.width && p.height) sizes.push(p);
  if (sizes.length < 3) return;
  sizes.sort((a, b) => a.width * a.height - b.height * b.width);
  const widest = Math.max(...sizes.map((s) => s.width));
  if (widest >= 800) {
    els.minW.value = 800;
    els.minH.value = 0;
    setBusy(true, '已按页面最大图自动填入最小宽度 800px（可改）');
  }
}

function autoSelect() {
  state.selected.clear();
  const list = visibleImages();
  for (const i of list) {
    if (imgPasses(i) && els.filterType.value !== 'small') state.selected.add(i.url);
  }
  updateButtons();
}

function summarize() {
  const job = state.job;
  if (!job) return;
  const total = job.images.length;
  const pass = job.images.filter(imgPasses).length;
  const unknown = job.images.filter(imgPassesUnknown).length;
  const small = total - pass - (job.images.filter((i) => !imgPasses(i) && !imgPassesUnknown(i)).length);
  const failCount = [...state.probed.values()].filter((p) => p.failed).length;
  const notImg = [...state.probed.values()].filter((p) => p.notImage).length;
  const bytes = [...state.probed.values()].reduce((a, p) => a + (p.bytes || 0), 0);

  const parts = [
    `<span class="ok">通过 ${pass}</span> / 共 ${total}`,
    `被过滤 ${total - pass - unknown}`,
    `尺寸未知 ${unknown}`
  ];
  if (notImg) parts.push(`<span class="warn">非图片 ${notImg}</span>`);
  if (failCount) parts.push(`<span class="warn">探测失败 ${failCount}</span>`);
  if (bytes) parts.push(`合计约 ${(bytes / 1048576).toFixed(1)}MB`);
  setMeta(parts.join(' · '));
  setBar(state.busy ? 95 : 100);
  if (!state.busy) els.status.textContent = `已就绪：选中 ${state.selected.size} 张可下载`;
}

// ---------------------------------------------------------------------------
// 下载 / 打包
// ---------------------------------------------------------------------------

function folderName() {
  const t = (state.job && state.job.title) || '';
  if (!els.useFolder.checked) return 'images';
  return t || 'images';
}

/**
 * 等一个后台作业结束：轮询存储里的作业状态，而不是等 result 广播。
 * 实测 result 广播在 popup 里收不到——表现为"文件已下完但界面永远停在'正在下载…'，
 * 按钮也不解除禁用"。轮询是确定性的。
 */
function startJobPolling(onTick) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const r = await send('pollJob');
      const job = r && r.job;
      if (job && typeof onTick === 'function') onTick(job);
      if (job && job.running === false) {
        stopped = true;
        clearInterval(timer);
      }
    } catch (e) { /* popup 关闭中 */ }
  }, 300);
  return () => { stopped = true; clearInterval(timer); };
}

async function doDownload() {
  if (state.busy) return;
  const list = passingSelected();
  if (!list.length) {
    els.status.textContent = '没有选中的图片（或选中的都被尺寸过滤了）';
    return;
  }
  const folder = folderName();
  const dlStartAt = Date.now();
  setBusy(true, `正在下载 ${list.length} 张…`);
  setBar(0);
  els.failBox.hidden = true;
  state.failures = [];
  await send('clearJob');

  let stopPoll = () => {};
  try {
    const ack = await send('download', {
      job: { images: list.map((i) => ({ url: i.url, width: i.width, height: i.height, ext: i.ext })), folder },
      useFetchRules: els.fetchRules.checked
    });
    if (!ack || !ack.ok) throw new Error('无法与后台通信');

    let last = null;
    stopPoll = startJobPolling((job) => {
      last = job;
      const pct = job.total ? Math.round(((job.done || 0) / job.total) * 100) : 0;
      const extra = job.saving ? `，落盘 ${job.saving}/${job.savingTotal}` : '';
      els.status.textContent = `${job.status || '处理中'}… ${job.done || 0}/${job.total}${extra}` +
        (job.failed ? `（失败 ${job.failed}）` : '');
      setBar(pct);
    });

    // 等作业结束：以轮询到的状态为准，并有硬上限兜底
    // （后台若因任何原因没写终态，界面也不能永久卡在"正在下载…"）
    const t0 = Date.now();
    const HARD_LIMIT = Math.min(300000, Math.max(30000, list.length * 3000 + 20000));
    let ticks = 0;
    while (Date.now() - t0 < HARD_LIMIT) {
      await new Promise((r) => setTimeout(r, 300));
      ticks++;
      if (last && last.running === false) break;
      if (!state.busy) break;
      // 连续 40 次（约 12 秒）都没拿到任何状态 → 认为后台没在写，直接收尾
      if (!last && ticks >= 40) break;
    }
    setBusy(false, '');
    const job = last;
    if (!job) {
      // 后台没回写进度：不猜，直接从浏览器的下载记录里核实真实结果
      const since = dlStartAt;
      const verified = await new Promise((resolve) => {
        try {
          chrome.downloads.search({ startedAfter: new Date(since).toISOString(), limit: 200 }, (items) => {
            if (chrome.runtime.lastError || !items) return resolve(null);
            const mine = items.filter((d) => d.filename && d.filename.indexOf(folder) >= 0);
            const done = mine.filter((d) => d.state === 'complete');
            resolve({
              seen: mine.length,
              complete: done.length,
              failed: mine.filter((d) => d.state === 'interrupted').length,
              totalBytes: done.reduce((a, d) => a + (d.fileSize || 0), 0)
            });
          });
        } catch (e) { resolve(null); }
      });
      if (verified && verified.seen) {
        els.status.textContent = `完成：已核实 ${verified.complete} 个文件写入「${folder}」` +
          (verified.failed ? `，失败 ${verified.failed}` : '') +
          (verified.totalBytes ? `（共 ${(verified.totalBytes / 1048576).toFixed(1)}MB）` : '');
      } else {
        els.status.textContent = '已提交下载，但浏览器下载记录里暂未查到结果，请稍后查看下载目录';
      }
      setBar(100);
      return;
    }
    if (job.error) {
      els.status.textContent = '下载出错：' + job.error;
      return;
    }
    if (job.failed && job.failed.length) {
      state.failures = job.failed;
      renderFailures();
    }
    els.status.textContent = job.failed
      ? `部分失败：成功 ${job.completed}/${job.total}，失败 ${job.failed}`
      : `完成：${job.completed}/${job.total} 张已保存到「${job.folder}」` +
        (job.timing ? `（启动 ${job.timing.startMs}ms，等落盘 ${job.timing.waitMs}ms）` : '');
    setBar(100);
  } catch (e) {
    setBusy(false, '下载失败：' + ((e && e.message) || e));
  } finally {
    stopPoll();
  }
}

// ---------------------------------------------------------------------------
// ZIP（整条流程都在 popup 里：抓取 → 组装 → 落盘）
//
// 为什么不能放后台（两条都是本机实测结论，Edge 154 / MV3）：
//   1) service worker 里 URL.createObjectURL 不存在，无法生成 blob URL 交给 downloads
//   2) chrome.runtime.sendMessage 会把对象 JSON 序列化，JSZip 实例传过去后原型丢失
// ---------------------------------------------------------------------------

/** 与后台 buildFileName 对齐的文件名（popup 侧独立实现，避免跨上下文传对象） */
function buildFileNameLocal(img, index) {
  const pad = (n, size) => { let s = String(n); while (s.length < size) s = '0' + s; return s; };
  let base = '';
  try {
    const seg = decodeURIComponent((new URL(img.url).pathname.split('/').pop() || '').trim());
    base = sanitizeName(seg.replace(/\.[A-Za-z0-9]{2,5}$/, ''), '', 70);
  } catch (e) { base = ''; }
  if (!base) base = 'image_' + pad(index + 1, 3);
  let ext = (img.ext || '').toLowerCase();
  if (!ext) { try { ext = (new URL(img.url).pathname.match(/\.([A-Za-z0-9]{2,5})$/) || [, ''])[1].toLowerCase(); } catch (e) { ext = ''; } }
  if (ext === 'jpeg') ext = 'jpg';
  if (!/^(jpg|png|gif|webp|avif|bmp|svg|jfif|ico)$/.test(ext)) ext = 'jpg';
  const sizeTag = img.width && img.height ? `_${img.width}x${img.height}` : '';
  const name = `${pad(index + 1, 3)}_${base}${sizeTag}.${ext}`;
  return name.length > 150 ? name.slice(0, 140) + '.' + ext : name;
}

function sanitizeName(name, fallback, maxLen) {
  let s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .replace(/^[_\s.]+|[_\s.]+$/g, '');
  const cap = maxLen || 120;
  if (s.length > cap) s = s.slice(0, cap).trim();
  return s || fallback || 'untitled';
}

/** 并发池：抓取图片字节，带进度 */
async function fetchAllBuffers(images, concurrency, onProgress) {
  const out = new Array(images.length);
  const failures = [];
  let cursor = 0, done = 0, bytes = 0;
  const lanes = new Array(Math.min(concurrency, images.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= images.length) return;
      const img = images[i];
      try {
        const res = await fetch(img.url, { credentials: 'include' });
        if (!res.ok) { failures.push({ url: img.url, error: 'HTTP ' + res.status }); }
        else {
          const type = (res.headers.get('content-type') || '').toLowerCase();
          if (type.indexOf('text/html') >= 0) {
            failures.push({ url: img.url, error: '返回 HTML 而非图片（防盗链）' });
          } else {
            const buf = await res.arrayBuffer();
            if (!buf || buf.byteLength < 100) failures.push({ url: img.url, error: '内容为空' });
            else { out[i] = { img, buf }; bytes += buf.byteLength; }
          }
        }
      } catch (e) {
        failures.push({ url: img.url, error: (e && e.message) || '抓取失败' });
      }
      done++;
      if (done % 3 === 0 || done === images.length) {
        onProgress(done, images.length, bytes, failures.length);
      }
    }
  });
  await Promise.all(lanes);
  return { buffers: out, failures, bytes };
}

/** 抓取 → 组装 → 生成 blob → downloads 落盘 */
async function buildZipInPopup(images, folder, onProgress) {
  if (typeof JSZip === 'undefined') {
    return { ok: false, error: 'JSZip 未加载（lib/jszip.min.js 缺失？）' };
  }
  if (!images.length) return { ok: false, error: '没有可打包的图片' };

  onProgress({ phase: 'zip-fetch', done: 0, total: images.length });
  const { buffers, failures, bytes } = await fetchAllBuffers(images, 4, (d, t, b, f) => {
    onProgress({ phase: 'zip-fetch', done: d, total: t, mb: Math.round(b / 1048576 * 10) / 10, failed: f });
  });

  const zip = new JSZip();
  const used = new Set();
  let index = 0;
  for (const item of buffers) {
    if (!item) continue;
    let name = buildFileNameLocal(item.img, index);
    while (used.has(name)) name = name.replace(/(\.\w+)$/, `_${index}$1`);
    used.add(name);
    index++;
    zip.file(name, item.buf, { compression: 'STORE' }); // 图片已压缩，STORE 省 CPU
  }

  if (index === 0) {
    return { ok: false, error: '所有图片都抓取失败，ZIP 未生成', failures };
  }

  const zipName = sanitizeName(folder, 'images', 80) + '.zip';
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE' },
    (meta) => onProgress({ phase: 'zip-build', done: Math.round(meta.percent), total: 100 })
  );
  const blobUrl = URL.createObjectURL(blob);

  // 关键：filename 只传「文件名」，不能带目录（带目录会被丢弃并替换成默认名，已实测）。
  // 目录由后台的 onDeterminingFilename: suggest({filename}) 给，所以先把映射登记过去。
  await send('registerPath', { url: blobUrl, path: zipName }).catch(() => {});
  await new Promise((r) => setTimeout(r, 60)); // 让后台先把映射落进 Map

  const id = await new Promise((resolve) => {
    chrome.downloads.download(
      { url: blobUrl, filename: zipName, conflictAction: 'uniquify', saveAs: false },
      (d) => resolve(chrome.runtime.lastError ? null : d)
    );
  });
  setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* 忽略 */ } }, 180000);

  return {
    ok: !!id,
    error: id ? null : 'ZIP 下载未启动（可能被浏览器拦截）',
    zipName,
    count: index,
    bytes,
    sizeMB: Math.round(blob.size / 1048576 * 10) / 10,
    failures
  };
}

async function doZip() {
  if (state.busy) return;
  const job = state.job;
  if (!job || !job.images.length) {
    els.status.textContent = '请先点「扫描页面」';
    return;
  }
  // 优先打包"勾选的"，没勾选就打包"全部通过尺寸过滤的"
  const picked = passingSelected();
  const list = picked.length ? picked : job.images.filter(imgPasses);
  if (!list.length) {
    els.status.textContent = '没有通过尺寸过滤的图片，请把「最小尺寸」调小一些';
    return;
  }
  if (!picked.length) {
    els.status.textContent = `未勾选任何图片，改为打包全部通过过滤的 ${list.length} 张…`;
  }
  const folder = folderName();
  await send('clearJob');
  setBusy(true, `正在抓取 ${list.length} 张准备打包…`);
  setBar(0);
  els.failBox.hidden = true;
  state.failures = [];

  try {
    const out = await buildZipInPopup(
      list.map((i) => ({ url: i.url, width: i.width, height: i.height, ext: i.ext })),
      folder,
      (p) => {
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        if (p.phase === 'zip-fetch') {
          els.status.textContent = `正在抓取图片… ${p.done}/${p.total}` +
            (p.mb ? `（已抓 ${p.mb}MB）` : '') + (p.failed ? `，失败 ${p.failed}` : '');
        } else {
          els.status.textContent = `正在压缩… ${p.done}%`;
        }
        setBar(pct);
        // ZIP 在 popup 里做，状态由这里写回后台，便于统一轮询观察
        send('setJobState', {
          kind: 'zip', running: true,
          status: p.phase === 'zip-fetch' ? '正在抓取图片' : '正在压缩',
          done: p.done, total: p.total, failed: p.failed || 0
        });
      }
    );
    send('setJobState', {
      kind: 'zip', running: false, status: out.ok ? '完成' : '失败',
      done: list.length, total: list.length,
      failed: (out.failures || []).length, folder, zipName: out.zipName
    });

    setBusy(false, '');
    if (out.failures && out.failures.length) {
      state.failures = out.failures;
      renderFailures();
    }
    if (out.ok) {
      els.status.textContent = `ZIP 已生成：${out.zipName}（${out.count} 张，${out.sizeMB}MB）`;
      setBar(100);
    } else {
      els.status.textContent = '打包失败：' + (out.error || '未知原因');
      setBar(0);
    }
  } catch (e) {
    setBusy(false, '打包失败：' + ((e && e.message) || e));
  }
}

function renderFailures() {
  els.failBox.hidden = state.failures.length === 0;
  els.failCount.textContent = String(state.failures.length);
  els.failList.innerHTML = state.failures.slice(0, 200).map((f) =>
    `<li>${escapesHtml(f.url)} — ${escapesHtml(f.error)}</li>`
  ).join('');
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bind() {
  els.btnScan.addEventListener('click', doScan);
  els.btnDl.addEventListener('click', doDownload);
  els.btnZip.addEventListener('click', doZip);

  els.btnAll.addEventListener('click', () => {
    for (const i of visibleImages()) if (imgPasses(i)) state.selected.add(i.url);
    refreshAllCards();
    updateButtons();
    summarize();
  });
  els.btnNone.addEventListener('click', () => {
    state.selected.clear();
    refreshAllCards();
    updateButtons();
    summarize();
  });

  for (const el of [els.minW, els.minH]) {
    el.addEventListener('change', () => {
      renderGrid();
      autoSelectIfNeeded();
      summarize();
      saveSettings();
    });
  }
  els.onlyScope.addEventListener('change', () => {
    renderGrid(); autoSelectIfNeeded(); summarize(); saveSettings();
  });
  els.sortBy.addEventListener('change', () => { renderGrid(); saveSettings(); });
  els.filterType.addEventListener('change', () => { renderGrid(); summarize(); saveSettings(); });
  els.multiPage.addEventListener('change', () => { syncPageCapUi(); saveSettings(); });
  els.pageCap.addEventListener('change', () => {
    const v = Math.max(2, Math.min(60, parseInt(els.pageCap.value, 10) || 60));
    els.pageCap.value = v;
    saveSettings();
  });
  els.fetchRules.addEventListener('change', saveSettings);
  els.useFolder.addEventListener('change', saveSettings);
  for (const el of [els.pageConcurrency, els.pageDelay, els.probeConcurrency]) {
    el.addEventListener('change', () => {
      const t = currentTune();
      els.pageConcurrency.value = t.concurrency;
      els.pageDelay.value = t.delay;
      els.probeConcurrency.value = t.probeConcurrency;
      saveSettings();
    });
  }

  for (const [id, val] of [['preset1000', 1000], ['preset1200', 1200], ['preset0', 0]]) {
    $(id).addEventListener('click', () => {
      els.minW.value = val;
      renderGrid(); autoSelectIfNeeded(); summarize(); saveSettings();
    });
  }

  els.btnCopyFail.addEventListener('click', async () => {
    const text = state.failures.map((f) => `${f.url}\t${f.error}`).join('\n');
    try { await navigator.clipboard.writeText(text); els.status.textContent = '失败清单已复制'; }
    catch (e) { els.status.textContent = '复制失败'; }
  });

  onProgress((msg) => {
    try {
      handleBgEvent(msg);
    } catch (e) {
      // 广播型事件里抛错会被 Chrome 静默吞掉，这里必须自己兜住并留痕
      if (self.__imgdErrs) self.__imgdErrs.push('handler:' + msg.type + ':' + ((e && e.message) || e));
      console.error('[imgd] 处理后台事件出错', msg && msg.type, e);
    }
  });
}

function handleBgEvent(msg) {
  if (self.__imgdCounts) self.__imgdCounts[msg.type] = (self.__imgdCounts[msg.type] || 0) + 1;
  // 只处理下载/打包进度；扫描进度改为结束后一次性交付（原因见 background.js 顶部说明）
  if (msg.type === 'progress') {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
    const label = {
      download: '正在下载', saving: '正在写入磁盘',
      'zip-fetch': '正在抓取图片', 'zip-build': '正在压缩'
    }[msg.phase] || '处理中';
    const extra = msg.mb ? `（已抓 ${msg.mb}MB）` : '';
    const fail = msg.failed ? `，失败 ${msg.failed}` : '';
    els.status.textContent = `${label}… ${msg.done}/${msg.total}${extra}${fail}`;
    setBar(pct);
  }
}

function refreshAllCards() {
  for (const [url, el] of cards) {
    const img = (state.job.images || []).find((i) => i.url === url);
    if (img) updateCard(el, img);
  }
}

/** 尺寸阈值变化后：把新通过但未勾过的图自动勾上（保持用户手动取消的不复活） */
const userUnchecked = new Set();
function autoSelectIfNeeded() {
  for (const i of visibleImages()) {
    if (imgPasses(i) && !userUnchecked.has(i.url)) state.selected.add(i.url);
    if (!imgPasses(i)) state.selected.delete(i.url);
  }
  updateButtons();
}

// 记录用户主动取消的图，避免被自动勾选覆盖
document.addEventListener('change', (e) => {
  const tick = e.target;
  if (!tick.classList || !tick.classList.contains('tick')) return;
  const card = tick.closest('.card');
  if (!card) return;
  if (tick.checked) userUnchecked.delete(card.dataset.url);
  else userUnchecked.add(card.dataset.url);
}, true);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function init() {
  els.ver.textContent = 'v' + chrome.runtime.getManifest().version;
  await restoreSettings();
  bind();

  // 测试钩子：供 tools/e2e.js 驱动真实流程（不参与正常使用）
  self.__imgdTest = {
    doScan,
    doDownload,
    doZip,
    buildZipInPopup,
    buildFileNameLocal,
    state,
    els,
    visibleImages,
    imgPasses
  };

  try {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab && tab.title) els.pageTitle.textContent = tab.title;
  } catch (e) { /* 忽略 */ }

  // 弹窗打开时保证按钮不是"卡在灰"的状态
  syncPageCapUi();
  setBusy(false);
  updateButtons();
})();
