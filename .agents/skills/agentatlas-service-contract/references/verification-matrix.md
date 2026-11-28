# Service Contract 验证矩阵（按改动面选测）

> 本文件是 `$agentatlas-service-contract` 的按需深入层：改动定型后再对照选测。
> 最低验证四件套（server.test / http.test / architecture / typecheck）见 SKILL.md。

| 改动面 | 必补测试 |
|---|---|
| 持久化 / 迁移 / journal | `tests/unit/persistence-migrations.test.ts`、`tests/unit/restore.test.ts`、`tests/unit/upgrade-fixtures.test.ts` |
| 认证 / 会话 / 密码 | `tests/unit/auth-session.test.ts`、`tests/unit/user-auth.test.ts`、`tests/unit/local-lock.test.ts`、`tests/coverage/`（auth 覆盖率） |
| SSE 事件 / 流式 | `tests/unit/stream.test.ts`、`tests/integration/fault-injection.test.ts`（断连/停止语义） |
| 可观测性 / 指标 | `tests/unit/observability.test.ts`、`tests/unit/logging.test.ts`、`tests/unit/trace*.test.ts` |
| 配置 / 加密 | `tests/unit/config-crypto.test.ts`、`tests/unit/backup.test.ts`、`tests/unit/backup-crypto-state.test.ts` |
| 限流 / 资源桶 | `tests/unit/limits.test.ts`、`tests/unit/run-registry.test.ts`、`tests/unit/model-retry.test.ts` |
| 发布一致性 | `tests/unit/release-check.test.ts`、`tests/unit/versioning.test.ts`（涉及部署面时走 `$agentatlas-release-ops`） |

手测要求：

1. 新接口必须在临时端口（3456+）做成功与失败路径手测：成功 200、400/401/404、
   超限与坏 JSON 各一遍；mock 模式（`API_KEY=""` + `*_FILE` env 指临时文件）不耗真实配额。
2. 新 SSE 事件手测时核对四方同步：`server/events.ts`、产出端、`client/stream/events.ts`、
   `client/modules/types-api.ts`，缺一方就是静默丢事件。
3. 迁移类改动先在临时数据目录验证 `db:migrate` / journal 回放，再谈发布。
