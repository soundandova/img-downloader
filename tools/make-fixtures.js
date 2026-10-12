/**
 * 从真实站点页面生成精简的解析器测试 fixture（一次性维护脚本）。
 *
 * 为什么要它：解析器的关键是"能不能从真实页面结构里正确抽取正文图片与分页"，
 * 纯手写的合成 HTML 覆盖不到真实结构（嵌套 figure、混在正文里的广告 div、
 * 页脚的相关文章缩略图、URL 里带百分号编码等）。所以在仓库里保留两份
 * 从真实页面裁剪出来的 fixture，让测试离线可复现。
 *
 * 同时做脱敏：把源站与图床域名替换成 example 域名，
 * 保留 URL 路径与文件名结构（测试依赖这些）。这样仓库里不指向任何具体站点。
 *
 * 用法（源页面需先由 tools/fixture-site.js 之外的抓取步骤准备好，
 * 或从浏览器另存；脚本只在维护 fixture 时运行一次）：
 *   node tools/make-fixtures.js <page1.html> <page2.html>
 *
 * 生成：tools/fixtures/wordpress-page1.html、wordpress-page2.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures');

/** 把真实域名换成 example 域名，保留路径结构；顺带清掉广告/统计脚本 */
function anonymize(html) {
  let s = html
    .replace(/https?:\/\/everia\.club/gi, 'https://example.com')
    .replace(/https?:\/\/reiobox\.top/gi, 'https://img.example.net')
    .replace(/https?:\/\/karubox\.top/gi, 'https://other.example.net')
    // 站名出现在 <title> 里，一并去掉
    .replace(/Everia\.club/gi, 'Example Site')
    .replace(/everia\.club/gi, 'example.com')
    // 广告位（正文里混着 <div class="code-block"> + ad-provider 脚本，测试不需要）
    .replace(/<div[^>]*class="[^"]*code-block[^"]*"[\s\S]*?<\/div>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<ins[\s\S]*?<\/ins>/gi, '');
  // 其余外部域名统一成 example.org，避免 fixture 里出现第三方站点
  s = s.replace(/https?:\/\/([a-z0-9.-]+)/gi, (m, host) => {
    if (/example\.(com|net|org)$/i.test(host)) return m;
    return 'https://third-party.example.org';
  });
  return s;
}

/** 只保留测试需要的片段：正文容器、分页块、相关文章缩略图 */
function trim(html) {
  const parts = [];

  // 标题脱敏后再截断（只用于验证 HTML 实体被正确解码）
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) parts.push(`<title>${tm[1].trim()}</title>`);

  // 正文容器（解析器就是靠它划定范围）
  const em = html.match(/<div[^>]*class="[^"]*(?:entry-content|post-content|post-body)[^"]*"[^>]*>/i);
  if (em) {
    const start = html.indexOf(em[0]) + em[0].length;
    const rest = html.slice(start);
    // 到分页块为止
    const pm = rest.match(/<div[^>]*class="[^"]*page-links[^"]*"[^>]*>/i);
    let body = pm ? rest.slice(0, pm.index) : rest;
    // 去掉超长填充段落，避免 fixture 臃肿（解析器不依赖它们）
    body = body.replace(/<p>(?:(?!<\/p>)[\s\S]){4000,}?<\/p>/g, '<p>（此处省略超长正文，仅保留结构）</p>');
    parts.push(`<div class="entry-content">\n${body}\n</div>`);

    // 分页块
    if (pm) {
      const afterPage = rest.slice(pm.index);
      const pend = afterPage.indexOf('</div>');
      parts.push(afterPage.slice(0, pend + 6));
    }
  }

  // 侧栏（真实页面里相关文章缩略图在 <aside id="right-sidebar"> 内，
  // 位于正文容器之外。fixture 保留它，用来验证"正文外的图不会被抓"）
  const sm = html.match(/<aside[^>]*class="[^"]*(?:sidebar|widget-area)[^"]*"[^>]*>[\s\S]*?<\/aside>/i)
    || html.match(/<aside[^>]*id="[^"]*sidebar[^"]*"[^>]*>[\s\S]*?<\/aside>/i);
  if (sm) {
    // 只留里面的缩略图，丢掉侧栏的其它内容
    const thumbs = [...sm[0].matchAll(/<img[^>]*>/gi)].slice(0, 4).map((m) => m[0]);
    if (thumbs.length) {
      parts.push(`<aside id="right-sidebar" class="sidebar-container widget-area">\n${thumbs.join('\n')}\n</aside>`);
    }
  }

  return `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8">\n${parts[0] || ''}\n</head>\n<body>\n${parts.slice(1).join('\n\n')}\n</body>\n</html>\n`;
}

const inputs = process.argv.slice(2);
if (inputs.length < 2) {
  console.error('用法: node tools/make-fixtures.js <page1.html> <page2.html>');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const names = ['wordpress-page1.html', 'wordpress-page2.html'];
inputs.slice(0, 2).forEach((src, i) => {
  const raw = fs.readFileSync(src, 'utf8');
  const out = trim(anonymize(raw));
  const dst = path.join(OUT, names[i]);
  fs.writeFileSync(dst, out, 'utf8');
  const imgs = (out.match(/<img/g) || []).length;
  const pages = (out.match(/post-page-numbers/g) || []).length;
  console.log(`${names[i]}: ${Math.round(out.length / 1024)}KB  <img>×${imgs}  post-page-numbers×${pages}`);
});
console.log('\n已生成到', OUT);
