/**
 * 把 extension/ 同步到 dist/，供「加载解压缩的扩展」直接使用。
 *
 * 为什么保留 dist/：这个扩展没有构建步骤，dist/ 就是可直接加载的产物，
 * 与 extension/ 内容完全一致（仅不含 README.md 等文档）。
 * 用 `node tools/build-dist.js --check` 可以只校验两者是否一致（CI 用）。
 *
 * 用法：
 *   node tools/build-dist.js          同步
 *   node tools/build-dist.js --check  只校验，不一致则退出码 1
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist', '一键看图下载');
const SKIP = new Set(['README.md']);            // 文档不放进可加载目录，避免 Edge 对 .md 告警

const check = process.argv.includes('--check');

function walk(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(SRC, '').filter((f) => !SKIP.has(f) && !f.endsWith('.md'));

if (check) {
  const problems = [];
  for (const rel of files) {
    const a = path.join(SRC, rel);
    const b = path.join(DIST, rel);
    if (!fs.existsSync(b)) { problems.push(rel + ' 缺失'); continue; }
    if (!fs.readFileSync(a).equals(fs.readFileSync(b))) problems.push(rel + ' 内容不一致');
  }
  if (problems.length) {
    console.log('dist 与 extension 不一致：');
    problems.forEach((p) => console.log('  - ' + p));
    console.log('请运行：node tools/build-dist.js');
    process.exit(1);
  }
  console.log(`dist 与 extension 一致（${files.length} 个文件）`);
  process.exit(0);
}

// 同步
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const rel of files) {
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), dst);
}
console.log(`已同步 ${files.length} 个文件到 dist/一键看图下载/`);
