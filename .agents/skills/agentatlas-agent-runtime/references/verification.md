# Agent Runtime 验证矩阵（按改动领域选测）

> 本文件是 `$agentatlas-agent-runtime` 的按需深入层：改动定型后再对照选测，
> 交付前仍要执行 `AGENTS.md` §7 的完整质量门；这里只解决「该补跑哪些领域回归」。

| 改动面 | 必补测试 |
|---|---|
| 子代理 / 路由 | `tests/integration/subagents.test.ts`、`tests/unit/routing-*.test.ts` |
| 长期记忆 / 记忆 slot | `tests/unit/memory*.test.ts`（记忆 HTTP 面再补 `tests/unit/memory-http.test.ts`） |
| 房产 / 求职领域工具 | `tests/unit/tools-job.test.ts`、领域结果与审批测试（estate-result、estate-tool-errors） |
| SSE 事件 / 图节点接线 | `tests/integration/server.test.ts`、`tests/unit/stream.test.ts`、`tests/unit/workflow-plan.test.ts` |
| 工具审批 / 权限模式 | `tests/unit/hitl*`（如存在）、`tests/unit/permission.test.ts`、`tests/unit/tool-risk.test.ts` |
| 检查点 / 会话恢复 | `tests/unit/checkpoint.test.ts`、`tests/unit/session-kinds.test.ts` |

选测原则：

1. 先跑本技能「最低验证」四件套，再按上表补领域回归——不要跳过最小集直接全量。
2. 新增 SSE 事件按 `$agentatlas-service-contract` 的四方同步清单核对，再回这里选测。
3. 改图接线（`workflow/graph.ts` 的节点/边）必须跑完整 `npm test`，不能只挑领域文件。
