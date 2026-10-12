/**
 * 扩展清单自检：确认 manifest 与 popup 引用的资源都存在，且 HTML 与 JS 的 id 一致。
 *
 * 这些错误在浏览器里往往只表现为"扩展加载失败"或"按钮点了没反应"，很难定位，
 * 所以在 CI 和提交前用脚本拦住。
 *
 * 用法：node tools/check-manifest.js      （有问题时退出码 1）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');
let bad = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'OK  ' : 'MISS'} ${msg}`);
  if (!cond) bad++;
};

// 1) manifest 本身可解析
let mf;
try {
  mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  console.log('OK   manifest.json 解析成功');
} catch (e) {
  console.error('MISS manifest.json 解析失败: ' + e.message);
  process.exit(1);
}

// 2) manifest 声明的资源都存在
const declared = [
  ...Object.values(mf.icons || {}),
  mf.action && mf.action.default_popup,
  mf.background && mf.background.service_worker
].filter(Boolean);
for (const r of declared) ok(fs.existsSync(path.join(EXT, r)), r + '（manifest 声明）');

// 3) popup.html 引用的资源都存在
const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^https?:/.test(m[1])) continue;
  ok(fs.existsSync(path.join(EXT, m[1])), m[1] + '（popup.html 引用）');
}

// 4) service worker 的 importScripts 目标存在
const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
for (const m of bg.matchAll(/importScripts\(([^)]+)\)/g)) {
  const r = m[1].replace(/['"]/g, '').trim();
  ok(fs.existsSync(path.join(EXT, r)), r + '（importScripts）');
}

// 5) HTML 的 id 与 JS 的取值必须对得上（拼错一个字母就静默失效）
const pjs = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const used = [...pjs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const missing = used.filter((i) => !ids.includes(i));
if (missing.length) {
  console.error('MISS popup.js 引用了 HTML 里不存在的 id: ' + missing.join(', '));
  bad += missing.length;
} else {
  console.log(`OK   ${used.length} 个 id 引用与 popup.html 一致`);
}
const unused = ids.filter((i) => !pjs.includes("'" + i + "'"));
if (unused.length) console.log('提示：HTML 里有未被 JS 使用的 id: ' + unused.join(', '));

// 6) manifest 关键字段的最低要求
ok(mf.manifest_version === 3, 'manifest_version 为 3');
ok(Array.isArray(mf.permissions) && mf.permissions.includes('downloads'), '声明了 downloads 权限');
ok(!!(mf.background && mf.background.service_worker), '声明了 service worker');
ok(!!(mf.action && mf.action.default_popup), '声明了默认弹窗');

if (bad) {
  console.error(`\n共 ${bad} 处问题`);
  process.exit(1);
}
console.log('\n清单自检通过');
