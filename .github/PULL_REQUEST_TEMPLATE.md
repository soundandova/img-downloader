## 这个 PR 做了什么

<!-- 一句话说明改动内容与动机 -->

## 类型

- [ ] 修复 bug
- [ ] 新功能
- [ ] 性能改进
- [ ] 文档 / 测试工具
- [ ] 其它：

## 本地验证

- [ ] `node tools/test-parser.js` 全过
- [ ] `node tools/e2e.js http://127.0.0.1:8099/article/1/` 全过（本地 fixture 站点）
- [ ] `node tools/build-dist.js --check` 通过

涉及分页抓取、并发或进度统计的改动，请再附上：

- [ ] `node tools/perf.js <URL>` 的输出（它会校验"已处理 + 队列 + 在飞 == 总页数"以及"同一页不被重复抓取"）

## 抓不到的页面（如适用）

- 页面 URL：
- 分页方式（`post-page-numbers` / `rel=next` / `?page=` / 无限滚动 / 无分页）：
- 期望数量 vs 实际数量：

## 备注

<!-- 已知问题、取舍、后续计划 -->
