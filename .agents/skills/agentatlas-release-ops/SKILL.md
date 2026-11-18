---
name: agentatlas-release-ops
description: "准备 agentatlas 版本发布、Docker 镜像、部署、升级回滚、备份恢复或生产质量门时使用；普通功能实现不应仅为运行测试而启用。"
---

# Agentatlas Release Ops

## 开始前

1. 阅读 `AGENTS.md`、`docs/versioning.md`、`docs/deployment.md` 和 `docs/production-checklist.md`。
2. 明确操作类型：仅验证、构建镜像、生成发布候选、部署、升级、回滚或恢复数据。
3. 未得到用户明确授权时，不 push、不创建或移动 tag、不推送镜像、不改生产环境。

## 发布红线

- `package.json.version` 是唯一产品版本源；产品版本、buildId、API 版本和 schema 版本分开。
- 发布 tag 只能是 `v<package.version>`，且只指向通过完整质量门的提交。
- 生产镜像必须固定 digest；禁止 `latest` 和浮动渠道标签。
- `IMAGE_VERSION`、OCI version、健康探针、`/api/version` 与页面 meta 必须一致。
- 生产必须启用认证、HTTPS、Cookie Secure、DATA_KEY、备份和只读根文件系统。
- 数据迁移和恢复前必须备份；恢复失败不得覆盖当前数据。
- 单实例文件型状态不可让两个进程同时写同一 `/data`。

## 验证顺序

```bash
npm run skills:check
npm run version:check
npm run typecheck
npm run build:client
npm run build:desktop
npm test
npm run e2e
npm run audit:prod
npm run data:check
npm run image:smoke
```

按发布影响补充 SBOM、覆盖率、备份恢复和镜像 digest 记录。Docker daemon 不可用时，明确报告阻断项，不得用静态检查冒充镜像验收。

## 交付证据

- 记录版本、buildId、commit、镜像标签与 digest。
- 记录真实执行过的命令和结果，不只引用文档。
- 版本或部署行为变化时更新 `docs/versioning.md`、部署文档和 `docs/readiness-snapshot.md`。
- 若只完成代码改动而未发布，明确说明“未 push、未 tag、未部署”。
