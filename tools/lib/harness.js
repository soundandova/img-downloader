/**
 * 测试工具的共享启动器
 *
 * 为什么需要它：这些工具原本各自写死了浏览器可执行文件路径、项目根目录、临时 profile 目录，
 * 既不能跨平台，改一处也要改很多份。这里统一收口。
 *
 * 环境变量（都可选）：
 *   BROWSER_PATH   指定浏览器可执行文件；不设则自动查找 Edge / Chrome
 *   BROWSER_PORT   调试端口基数；不设则按工具名派生，避免并发冲突
 *   DOWNLOAD_DIR   下载目录；不设则用系统默认
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按平台找出可用的 Chromium 系浏览器（优先 Edge，其次 Chrome） */
function findBrowser() {
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) {
    return process.env.BROWSER_PATH;
  }
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const candidates = process.platform === 'win32'
    ? [
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        ]
      : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome，请用 BROWSER_PATH 环境变量指定可执行文件路径');
}

/** 下载目录（跨平台） */
function downloadsDir() {
  return process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads');
}

/** 简易 HTTP JSON 客户端（用于 DevTools 的 /json/* 接口） */
function httpJson(port, urlPath, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: method || 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('非 JSON 响应: ' + data.slice(0, 160))); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** 极简 CDP 客户端（Node 18+ 自带全局 WebSocket） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败: ' + url)));
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, timeoutMs || 300000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

/** 取 Runtime.evaluate 的返回值（CDP 在不同路径下会单层/双层包装） */
function evalValue(resp) {
  let r = resp && resp.result;
  if (r && r.result !== undefined && r.value === undefined) r = r.result;
  return r ? r.value : undefined;
}

/** 取 Runtime.evaluate 的返回值并 JSON.parse；非字符串时抛出带异常信息的错误 */
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

/**
 * 启动一个已加载本扩展的浏览器，返回 { proc, port, extId, swTarget, stop() }
 * @param {object} opts { port, profileName, headless, extraArgs }
 */
async function launchWithExtension(opts) {
  const o = opts || {};
  const browser = findBrowser();
  const port = o.port || parseInt(process.env.BROWSER_PORT, 10) || 9333;
  const profile = path.join(ROOT, o.profileName || '.dev-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check'
  ];
  if (o.headless !== false) args.push('--headless=new');
  if (o.extraArgs) args.push(...o.extraArgs);
  args.push('about:blank');

  const proc = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const t0 = Date.now();
  for (;;) {
    try { await httpJson(port, '/json/version'); break; } catch (e) {
      if (Date.now() - t0 > 30000) throw new Error('DevTools 端口未就绪；stderr: ' + stderr.slice(0, 500));
      await sleep(400);
    }
  }
  await sleep(2500);

  const list = await httpJson(port, '/json/list');
  const swTarget = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  let extId = null;
  if (swTarget) {
    const m = swTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//);
    if (m) extId = m[1];
  }

  return {
    proc,
    port,
    profile,
    extId,
    swTarget,
    stderr: () => stderr,
    openTab: (url) => httpJson(port, '/json/new?' + encodeURIComponent(url), 'PUT'),
    list: () => httpJson(port, '/json/list'),
    async stop() {
      try { proc.kill(); } catch (e) { /* 忽略 */ }
      await sleep(1200);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch (e) { /* 忽略 */ }
    }
  };
}

/** 简单的断言计数器 */
function createChecker() {
  const state = { pass: 0, fail: 0 };
  const check = (name, cond, detail) => {
    if (cond) { state.pass++; console.log(`  [PASS] ${name}`); }
    else { state.fail++; console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
  };
  return { state, check };
}

module.exports = {
  ROOT, EXT_DIR, sleep, findBrowser, downloadsDir, httpJson,
  CDP, evalValue, evalJson, launchWithExtension, createChecker
};
