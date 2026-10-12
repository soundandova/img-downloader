# 参与贡献

感谢你有兴趣改进这个项目。下面是几条约定，能让 PR 更快被合入。

## 开发环境

- **Node 18+**（测试工具用到全局 `WebSocket` 与 `fetch`）
- **Edge 或 Chrome**（测试工具会自动查找；也可用 `BROWSER_PATH` 指定）
- 扩展本体**零运行时依赖**，唯一第三方库是 `extension/lib/jszip.min.js`

修改 `extension/` 下的代码后：

```bash
node tools/build-dist.js    # 同步到 dist/extension/
```

然后在 `edge://extensions/` 点扩展卡片上的刷新 ↻ 生效。

## 提交 PR 前请先本地验证

```bash
node tools/fixture-site.js 8099                        # 另开一个终端
node tools/check-manifest.js                           # 清单与资源引用自检
node tools/test-parser.js                              # 解析器单测，应 39 项全过
node tools/e2e.js http://127.0.0.1:8099/article/1/     # 真机端到端，应 39 项全过
node tools/build-dist.js --check                       # dist 与 extension 应一致
```

CI（`.github/workflows/ci.yml`）会跑其中**不依赖浏览器**的部分：语法检查、清单自检、
解析器单测、`dist` 一致性。**真机端到端不在 CI 里跑**——它需要安装 Chrome，属于环境依赖较重的
检查，请你在本地跑过之后把输出贴在 PR 里。

涉及抓取性能或分页逻辑的改动，请再跑一次：

```bash
node tools/perf.js http://127.0.0.1:8099/article/1/
```

它的输出会校验几条容易写错的约束：

- `已处理 + 队列待抓 + 在飞 == 总页数`（三个数字不能互相重叠）
- 抓取页数不超过页面里出现过的最大页号
- **同一页不会被重复抓取**

## 代码约定

- 扩展代码是**经典脚本**（service worker 用 `importScripts`，popup 用普通 `<script>`），
  不要引入打包器或 ES module 语法到 `extension/` 里，保持"改完即生效、零构建"
- 注释用中文，写**为什么**而不是**是什么**；踩过的坑请把现象一起写进去
- 新增测试工具的浏览器启动逻辑请复用 `tools/lib/harness.js`，不要在工具里写死路径
- 不要在 `extension/` 里放 `.md` 等非运行文件：Edge 会对未打包扩展里的这类文件告警
  （文档放在仓库根目录）

## 报告抓不到图片的问题

请附上：

1. **页面 URL**
2. **分页方式**（`post-page-numbers` / `rel=next` / `?page=` / 无限滚动 / 无分页）
3. 你期望抓到的数量与实际抓到的数量
4. 如果方便，附上 `node tools/e2e.js <URL>` 的输出

## 不要提交

- `research/` 目录（含第三方扩展的反编译源码与站点快照，已加入 `.gitignore`）
- 任何个人路径、下载目录快照、cookie 或登录态
- `dist/*.zip` 等构建产物
