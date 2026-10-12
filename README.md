# 一键看图下载 · Img Downloader

> 一个用于 **Microsoft Edge / Chrome** 的 Manifest V3 扩展：一键抓取当前网页（**含分页**）的所有图片，按**真实尺寸**过滤后下载到以页面标题命名的文件夹，或打包为同名 ZIP。

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![No build step](https://img.shields.io/badge/build-none%20required-brightgreen)]()

[English](README.en.md)

---

## 它解决什么问题

常见的"图片批量下载"扩展大多只扫当前页面的 `<img>` 标签，遇到下面这些情况就抓不全或抓错：

- **一篇文章分成很多页**（WordPress 的 `post-page-numbers`、`/2/`、`rel=next`、`?page=2`…），只能手动翻页一张张下
- **响应式图片**（`srcset`）拿到的是小图而不是大图
- **图片托管在另一个域**，或者带防盗链
- **下载的文件名一团糟**：被服务器的 `Content-Disposition` 改名、中文名变空、全堆在一个目录里

这个扩展针对这些真实问题做了处理，并且**尽可能少要权限**。

## 特性

- **整篇抓取**：自动识别分页并遍历全文（默认开启，可关闭或限制页数上限）
- **真实尺寸过滤**：对每张图发 `Range: bytes=0-65535`，**只取 64KB 解析图片文件头**拿到真实宽高（PNG / JPEG / GIF / BMP / WebP 三种变体 / AVIF / HEIC / SVG），不下载整图就能判断要不要
- **尺寸未知的图不丢弃**：只过滤"已知尺寸且小于阈值"的，未知的放行并在界面标注
- **多来源覆盖**：`img.currentSrc`、`srcset` 取最大档、`picture/source`、CSS `background-image`、`video[poster]`、懒加载属性、`a[href]` 直链
- **文件名可靠**：`downloads.onDeterminingFilename` 强制命名（`001_原名_1200x1800.webp`），不被服务器改名；中文/日文完整保留
- **按页面标题归档**：`下载\<页面标题>\...` 或 `下载\<页面标题>.zip`
- **原始字节保存**：不做解码/重编码，拿到的就是服务器上的原文件
- **可选绕防盗链**：需要时临时启用 `declarativeNetRequest` 规则移除 `Referer`，任务结束即撤销
- **完全离线**：无遥测、无外部请求、不申请 `webRequest` / `nativeMessaging` 等权限

## 安装

### 方式一：直接加载（推荐，无需构建）

1. 克隆或下载本仓库
2. 打开 `edge://extensions/`（Chrome 为 `chrome://extensions/`）
3. 左下角开启「**开发人员模式**」
4. 点「**加载解压缩的扩展**」，选择 **`dist/一键看图下载`** 目录
   > 判断标准：选中的目录里应当**直接能看到 `manifest.json`**
5. 图标默认收在拼图菜单里：点地址栏右侧 🧩 → 找到「一键看图下载」→ 点眼睛图标固定到工具栏

### 方式二：从源码加载

直接用 `extension/` 目录，内容与 `dist/` 一致（仅多一份 README）。

```bash
node tools/build-dist.js          # 修改 extension/ 后同步到 dist/
node tools/build-dist.js --check  # 只校验两者是否一致（CI 用）
```

## 用法

1. 打开目标页面，点扩展图标
2. 点「**扫描页面**」：
   - 注入采集当前页（能读 `naturalWidth`，尺寸最准）
   - 顺着分页链接抓取整篇文章的每一页
   - 对每张图做 Range 尺寸探测，并自动填一个最小尺寸建议
3. 在缩略图网格里核对（显示尺寸/格式/体积/来源域名，可排序筛选）
4. 二选一：
   - 「**下载选中**」→ `下载\<页面标题>\001_原名_1200x1800.webp`
   - 「**打包 ZIP**」→ `下载\<页面标题>.zip`

### 设置项

| 开关 | 默认 | 说明 |
|---|---|---|
| 最小尺寸 | 自动建议 | 宽高都满足才通过；`0` 表示不限 |
| 只算正文 | 关 | 只在正文容器（`.entry-content` / `article` / `main`…）里找图，排除侧栏缩略图 |
| 探测多页 | **开** | 关闭后只扫当前页，一个分页请求都不发 |
| 上限 N 页 | 60 | 多页探测的页数上限（含当前页） |
| 绕防盗链 | 关 | 图床返回 403 或 HTML 时开启 |
| 建同名文件夹 | 开 | 逐张下载时按页面标题建子目录 |
| 分页并发 | 4 | 同时抓几页 |
| 页间隔 | 0ms | 每批分页之间的等待；默认 0，因为并发本身已限制频率 |
| 尺寸探测并发 | 6 | 同时探测几张图的真实尺寸 |

## 开发

无构建步骤，改完代码在 `edge://extensions/` 点卡片上的刷新 ↻ 即可。

```bash
# 依赖：Node 18+（用到全局 WebSocket 与 fetch）。扩展本体零依赖。
# 唯一的第三方库是打包内置的 lib/jszip.min.js（JSZip 3.10.1）

# 本地分页测试站：8 页 × 16 张真实 PNG，可模拟慢页，不依赖外网
node tools/fixture-site.js 8099

node tools/test-parser.js                              # 解析器单测（39 项）
node tools/e2e.js http://127.0.0.1:8099/article/1/     # 真机端到端（39 项）
node tools/e2e.js <任意文章URL>                         # 对着真实站点跑
node tools/e2e.js --full                               # 追加整篇 ZIP 验证
node tools/perf.js [URL]                               # 分阶段计时 + 进度数字自洽性断言
```

测试工具会自动查找本机的 Edge 或 Chrome。可用环境变量覆盖：

| 变量 | 用途 |
|---|---|
| `BROWSER_PATH` | 指定浏览器可执行文件 |
| `BROWSER_PORT` | DevTools 端口 |
| `DOWNLOAD_DIR` | 下载目录（涉及文件落盘的工具用） |

### 目录结构

```
extension/               扩展本体（Edge 直接加载这个目录也行）
  manifest.json          MV3 清单
  background.js          service worker：页内采集注入 / 分页爬取 / 尺寸探测 / 下载队列 / 文件名强制
  popup.html|css|js      界面 + ZIP 全流程
  lib/jszip.min.js       JSZip 3.10.1（唯一第三方库）
  icons/                 16 / 48 / 128 图标
dist/一键看图下载/        可直接加载的发布副本（由 tools/build-dist.js 同步）
tools/                   开发与验证工具（见上）
```

## 已知限制

- 分页只跟进**同一路径族**的链接（`/post/2/`、`/post/3/`…），不会爬到站内其它文章
- 单次最多探测 800 张图的真实尺寸，超出部分按"尺寸未知"放行
- **打包 ZIP 期间不要关闭弹窗**：ZIP 在 popup 里完成（这样可以省掉 `offscreen` 权限），关掉会中断；此时可改用「下载选中」
- 纯 CSS 背景图只扫描正文容器内的前 5000 个元素
- 不采集 `iframe` 内的图片（未开启 `all_frames`）
- 需要登录/付费的内容能否下载取决于你浏览器里已有的会话
- 部分站点的分页章节会在页首重复上一页末图，或偶发返回较短的分页，扩展按实际情况抓取

## 权限说明

| 权限 | 用途 |
|---|---|
| `activeTab`、`tabs` | 读取当前标签页地址、仅在点击时注入采集脚本 |
| `scripting` | 按需注入页内采集函数（扩展不常驻任何内容脚本） |
| `storage` | 保存界面设置与任务进度 |
| `downloads` | 保存图片与 ZIP，并强制文件名 |
| `declarativeNetRequest` | 仅在开启「绕防盗链」时使用，会话级规则、任务结束即撤销 |
| `host_permissions: <all_urls>` | 跨域读取分页 HTML 与图片字节以判断尺寸 |

扩展**不发起任何外部网络请求**，无遥测、无统计、无远程配置。

## 设计取舍

- **不用 `webRequest` 嗅探**：省掉一个常驻监听权限。代价是抓不到"从未进入 DOM 的图片"（预加载、虚拟滚动列表）
- **ZIP 放在 popup 而不是 service worker**：MV3 的 service worker 里没有 `URL.createObjectURL`，放 popup 可以省掉 `offscreen` 权限
- **进度用轮询而不是消息广播**：实测 `chrome.runtime.onMessage` 的广播与 `downloads.onChanged` 在本机会丢事件（详见 `extension/README.md` 的"踩坑"一节），轮询确定可靠
- **默认页间隔 0ms**：并发泳道本身已限制请求频率，再加固定间隔只是白等

## 参与贡献

欢迎提交 Issue 与 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

如果遇到抓不到的页面，请在 Issue 里附上**页面 URL 与分页方式**（`post-page-numbers` / `rel=next` / `?page=` / 无限滚动），这样最容易定位。

## 免责声明

本工具仅用于下载你有权获取的内容。请遵守目标网站的服务条款与著作权法，并注意请求频率。使用者需自行承担合规责任。

## 许可证

[MIT](LICENSE)
