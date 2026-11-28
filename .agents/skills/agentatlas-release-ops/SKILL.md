---
name: agentatlas-release-ops
description: "准备 agentatlas 版本发布、Docker 镜像、部署、升级回滚、备份恢复或生产质量门时使用；普通功能实现不应仅为运行测试而启用。"
---

# Agentatlas Release Ops

## 开始前

1. 阅读 `AGENTS.md`、`.plans/development-docs/versioning.md`、`docs/deployment.md` 和 `docs/production-checklist.md`。
2. 明确操作类型：仅验证、构建镜像、生成发布候选、部署、升级、回滚或恢复数据。
3. 未得到用户明确授权时，不 push、不创建或移动 tag、不推送镜像、不改生产环境。

## 发布红线

- `package.json.version` 是唯一产品版本源；产品版本、buildId、API 版本和 schema 版本分开。
- 每次合并到 `main` 都必须提升版本：beta/rc 线路递增 `N`，alpha 不得直接进入 `main`。
- 合并 `main` 前必须为同一候选 commit 取得完整 CI 证据：远端 `quality` / `e2e` / `image` 全绿，或在本地执行 `git fetch origin main && npm run ci:verify` 全通过；CI pending、失败或 Docker 不可用都禁止合并。
- `0.x.y` 是同一功能线的小功能点/修复，`0.x.0` 是新的大功能组且可能破坏兼容性；1.0 之后才按标准主版本升级。
- 发布 tag 只能是 `v<package.version>`，且只指向通过完整质量门的提交。
- 生产镜像必须固定 digest；禁止 `latest` 和浮动渠道标签。
- `IMAGE_VERSION`、OCI version、健康探针、`/api/version` 与页面 meta 必须一致。
- 生产必须启用认证、HTTPS、Cookie Secure、DATA_KEY、备份和只读根文件系统。
- 数据迁移和恢复前必须备份；恢复失败不得覆盖当前数据。
- 单实例文件型状态不可让两个进程同时写同一 `/data`。

## 验证顺序

`main` 合并前的单一入口是 `git fetch origin main && npm run ci:verify`——它完整复刻
GitHub CI；排查局部失败时可单独运行门禁命令，但**不能替代 ci:verify**（完整命令块见
`references/ci-evidence.md`）。Docker daemon 不可用时，明确报告阻断项，不得用静态检查冒充镜像验收。

## 按需深入（渐进式披露）

- 排查单个门禁失败 / 准备交付证据清单 → `references/ci-evidence.md`。
- 版本递增细则与镜像发布流程以 `.plans/development-docs/versioning.md`、
  `docs/deployment.md`、`docs/production-checklist.md` 为权威。

## 交付证据

记录版本、buildId、commit、镜像标签与 digest，以及真实执行过的命令和结果——
完整清单见 `references/ci-evidence.md`。若只完成代码改动而未发布，明确说明"未 push、未 tag、未部署"。
