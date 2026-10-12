/**
 * 后台 parseListingHtml 的单元测试
 * 做法：把 background.js 里的真实函数源码抠出来求值（不复制逻辑，测的就是上线代码）
 *      再用真实保存的目标站点页面做断言
 * 用法：node tools/test-parser.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BG = path.join(__dirname, '..', 'extension', 'background.js');
const src = fs.readFileSync(BG, 'utf8');

// ---- 从 background.js 中提取待测函数（真源码，不是副本） ----
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('函数体未闭合: ' + name);
}

const fns = ['samePagerScope', 'decodeEntities', 'extFromUrl', 'sanitizeName', 'baseNameFromUrl', 'buildFileName', 'parseListingHtml'];
const IMAGE_EXT_LITERAL = "const IMAGE_EXT = ['jpg','jpeg','png','gif','webp','avif','bmp','svg','jfif','ico'];";
// pad 直接从源码抠，避免"测试桩写对了、源码写错了"这种被掩盖的 bug
const code = IMAGE_EXT_LITERAL + '\n' + extractFn('pad') + '\n' + fns.map(extractFn).join('\n\n');
const mod = new Function(`${code}; return { ${fns.join(', ')} };`)();
const { parseListingHtml, buildFileName, sanitizeName, extFromUrl, decodeEntities } = mod;

// ---- 断言工具 ----
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
}

// fixture 是从真实页面裁剪并脱敏后随仓库一起提交的（见 tools/make-fixtures.js），
// 这样测试不依赖任何外部站点、也不需要联网。
const FIXTURES = path.join(__dirname, 'fixtures');

console.log('\n=== 1. WordPress 结构解析（正文容器限定 + 跨域图床 + 分页块）===');
const html1 = fs.readFileSync(path.join(FIXTURES, 'wordpress-page1.html'), 'utf8');
const html2 = fs.readFileSync(path.join(FIXTURES, 'wordpress-page2.html'), 'utf8');

// 页面 URL 从 fixture 自身推导：fixture 里第一条分页链接就是 "/2/" 的地址。
// 这样 URL 与 fixture 内容永远自洽，改 fixture 不会让测试莫名失败。
const m2 = html1.match(/href="([^"]+\/2\/)"/);
if (!m2) {
  console.error('fixture 里找不到 /2/ 分页链接，无法推导页面 URL');
  process.exit(1);
}
const URL2 = m2[1];
const URL1 = URL2.replace(/2\/$/, '');

const r1 = parseListingHtml(html1, URL1);
const r2 = parseListingHtml(html2, URL2);

check('page1 抽到正文图 16 张', r1.images.length === 16, `实际 ${r1.images.length}`);
check('page2 抽到正文图 16 张', r2.images.length === 16, `实际 ${r2.images.length}`);
check('page1 首图是 _1.webp', /_1\.webp$/.test(r1.images[0].url), r1.images[0].url);
check('page1 末图是 _16.webp', /_16\.webp$/.test(r1.images[15].url), r1.images[15].url);
check('page2 首图是 _17.webp', /_17\.webp$/.test(r2.images[0].url), r2.images[0].url);
check('图片全部来自跨域图床 img.example.net', r1.images.every((i) => /img\.example\.net/.test(i.url)));
check('page1 页号解析为 1', r1.page === 1, String(r1.page));
check('page2 页号解析为 2', r2.page === 2, String(r2.page));
check('page1 发现 6 个后续分页链接（/2/ 到 /7/）', r1.nextPages.length === 6, `实际 ${r1.nextPages.length}`);
check('分页链接覆盖到最后一页 /7/', r1.nextPages.some((u) => /\/7\/$/.test(u)), r1.nextPages.join(' '));
check('分页链接都是同族同源', r1.nextPages.every((u) => u.startsWith('https://example.com/')), r1.nextPages[0]);
// 侧栏的 4 张相关文章缩略图必须被排除（这是"只算正文"的关键行为）
check('侧栏缩略图（other.example.net）未被算进正文',
  !r1.images.some((i) => /other\.example\.net/.test(i.url)),
  r1.images.filter((i) => /other\.example/.test(i.url)).map((i) => i.url).join(' '));
check('正文图与侧栏缩略图总数对得上（16 + 4 = 20）',
  (html1.match(/<img/g) || []).length === 20, String((html1.match(/<img/g) || []).length));
check('标题已解码 HTML 实体', r1.title.indexOf('&#') < 0 && r1.title.indexOf('–') >= 0, r1.title);

console.log('\n=== 2. 分页范围限制（不能爬到站内别的文章）===');
const foreign = 'https://example.com/2026/10/08/another-post/';
const same = mod.samePagerScope(URL1 + '3/', URL1);
const diff = mod.samePagerScope(foreign, URL1);
check('同族 /3/ 被接受', same === true);
check('其它文章被拒绝', diff === false);
check('首页自身被接受', mod.samePagerScope(URL1, URL1) === true);
check('完全无关的路径被拒绝', mod.samePagerScope('https://example.com/2026/10/08/x/2/', URL1) === false);

console.log('\n=== 3. 真实页面里不该出现的东西 ===');
check('没有 data: 内联图', !r1.images.some(i => i.url.startsWith('data:')));
check('没有重复 URL', new Set(r1.images.map(i => i.url)).size === r1.images.length);
check('全部是 http(s)', r1.images.every(i => /^https?:/.test(i.url)));

console.log('\n=== 4. 合成边界用例 ===');
const synthetic = `<!DOCTYPE html><html><head><title>Test &amp; Title &#8211; Site</title></head><body>
<div class="entry-content">
  <img src="/rel/a.jpg" width="800" height="600">
  <img src="https://cdn.example.com/b.png">
  <img src="data:image/gif;base64,R0lGOD" >
  <img src="https://cdn.example.com/b.png">
  <img src="//proto.example.com/c.webp">
</div>
<div class="page-links">Pages: <span class="post-page-numbers current">1</span>
  <a href="/post/2/">2</a> <a href="/post/3/">3</a> <a href="https://other.com/x/4/">4</a></div>
<div class="related-posts"><img src="https://cdn.example.com/related.jpg"></div>
</body></html>`;
const rs = parseListingHtml(synthetic, 'https://site.test/post/');
check('相对路径被补全为绝对 URL', rs.images.some(i => i.url === 'https://site.test/rel/a.jpg'));
check('协议相对 // 被补全', rs.images.some(i => i.url === 'https://proto.example.com/c.webp'));
check('data: 被跳过', !rs.images.some(i => i.url.startsWith('data:')));
check('同 URL 去重（b.png 只 1 次）', rs.images.filter(i => /b\.png$/.test(i.url)).length === 1);
check('related-posts 之后的图未被抓取', !rs.images.some(i => /related\.jpg$/.test(i.url)), JSON.stringify(rs.images.map(i=>i.url)));
check('只接受同族分页（丢掉 other.com）', rs.nextPages.length === 2 && rs.nextPages.every(u => u.indexOf('site.test') > 0), rs.nextPages.join(' '));
check('标题实体全部解码', rs.title === 'Test & Title – Site', rs.title);
check('width/height 属性被读入', rs.images[0].width === 800 && rs.images[0].height === 600);

console.log('\n=== 5. 文件名与目录名清洗 ===');
check('extFromUrl: .jpeg 归一为 jpg', extFromUrl('https://a/b.JPEG') === 'jpg', extFromUrl('https://a/b.JPEG'));
check('extFromUrl: 无扩展名返回空', extFromUrl('https://a/img/12345') === '', extFromUrl('https://a/img/12345'));
check('extFromUrl: 带 query 仍能取到', extFromUrl('https://a/b.webp?w=800') === 'webp', extFromUrl('https://a/b.webp?w=800'));
const jp = 'Rina Saito 斉藤里奈 – PARADE ずっと見つめていいですか？';
const clean = sanitizeName(jp, 'x', 80);
check('中文/日文标题被完整保留', clean === jp, clean);
check('非法字符被替换', sanitizeName('a/b\\c:d*e?f"g<h>i|j', 'x', 80) === 'a_b_c_d_e_f_g_h_i_j', sanitizeName('a/b\\c:d*e?f"g<h>i|j', 'x', 80));
check('超长被截断', sanitizeName('あ'.repeat(200), 'x', 80).length === 80);
check('空串回落默认值', sanitizeName('   ', 'fallback', 80) === 'fallback');
const fn = buildFileName({ url: 'https://reiobox.top/wp-content/uploads/2026/10/GRA10V097_1.webp', width: 1200, height: 1800, ext: 'webp' }, 0);
check('文件名 = 001_原名_宽x高.webp', fn === '001_GRA10V097_1_1200x1800.webp', fn);
check('序号恒为 3 位（第 9 张 = 009）',
  /^009_/.test(buildFileName({ url: 'https://a.com/x.jpg', ext: 'jpg' }, 8)),
  buildFileName({ url: 'https://a.com/x.jpg', ext: 'jpg' }, 8));
check('序号恒为 3 位（第 100 张 = 100）',
  /^100_/.test(buildFileName({ url: 'https://a.com/x.jpg', ext: 'jpg' }, 99)),
  buildFileName({ url: 'https://a.com/x.jpg', ext: 'jpg' }, 99));
const fn2 = buildFileName({ url: 'https://a.com/noext', width: 0, height: 0 }, 4);
check('无扩展名/无尺寸时：用末段名 + 序号 + 兜底 jpg', fn2 === '005_noext.jpg', fn2);
const fn3 = buildFileName({ url: 'https://a.com/img/12345', width: 640, height: 480, ext: '' }, 11);
check('无扩展名但有尺寸：仍带尺寸标签', fn3 === '012_12345_640x480.jpg', fn3);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
