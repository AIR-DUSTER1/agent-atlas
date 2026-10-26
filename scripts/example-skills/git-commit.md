---
name: 写提交信息
description: 本仓库约定的 Git 提交信息格式
triggers: 提交信息, 写commit, commit message, 提交说明
---

# 写提交信息

本仓库的提交信息约定（与现有 git log 保持一致）：

- **一行中文短句**，不加 `feat:` / `fix:` 之类前缀。
- 说清「做了什么」；修 bug 时用「：」补原因，例如
  `修复 CI 测试竞态：检查点写出是 fire-and-forget，删临时目录前必须 flush`。
- 一次提交只做一件逻辑相邻的事，不混入无关改动。
- 提交前必须过质量门：`npm run typecheck`、`npm run check:size`、`npm test`。
- 提交前清点 `git status --short`，`\.plans/`、`.env`、`.web-config.json` 绝不入库。

## 反面例子

- ❌ `update files`（说不清做了什么）
- ❌ `fix: bug`（前缀 + 无信息量）
- ❌ 把格式化改动和功能改动塞进同一个提交
