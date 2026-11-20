---
name: agentatlas-agent-runtime
description: "修改 agentatlas 的 LangGraph 工作流、Agent Profile、工具、审批、路由、子代理或记忆时使用；不用于纯前端、纯服务端点或发布部署改动。"
---

# Agentatlas Agent Runtime

## 开始前

1. 阅读项目根目录 `AGENTS.md` 的常驻红线。
2. 按任务读取 `.plans/development-docs/agent-orchestration.md`；涉及长期记忆时再读 `docs/memory-slot.md`。
3. 先确定受影响的 Profile：`general`、`estate`、`job`，以及它的工具 allowlist、审批表和记忆 scope。

## 不可破坏的边界

- `src/agent`、`src/memory`、`src/routing` 不得 import `src/server` 或 `src/client`。
- 工具只能装配到明确允许它的 Profile；不要恢复跨领域全局工具表。
- 执行命令、写文件、安装软件、发消息、控制电脑等改世界操作必须在 `src/agent/hitl.ts` 登记审批。
- 工具失败返回模型可读的中文错误，不要让异常穿透工作流。
- 子代理不得扩大主 Agent 赋予的工具集；委派必须保留最小权限。
- 长期记忆必须按 Profile scope 隔离；子 Agent 不直接写长期记忆。
- `src/agent/workflow.ts` 保持稳定门面，节点实现放在 `src/agent/workflow/nodes/`，图接线放在 `workflow/graph.ts`。

## 实施流程

1. 找到现有同领域实现、审批文案和测试，再决定最小改动面。
2. 同时检查工具定义、Profile allowlist、HITL 登记、模型提示词和图节点接线。
3. 修改 SSE 事件时，再使用 `$agentatlas-service-contract`；不要在这里复制事件协议。
4. 修改前端工具卡时，再使用 `$agentatlas-frontend`。
5. 新增能力必须说明何时使用、何时不使用，以及失败时的用户可见结果。

## 最低验证

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/unit/tool-isolation.test.ts tests/unit/tool-risk.test.ts tests/unit/permission.test.ts tests/unit/workflow.test.ts
```

再按领域补充：

- 子代理/路由：`tests/integration/subagents.test.ts`、`tests/unit/routing-*.test.ts`
- 记忆：`tests/unit/memory*.test.ts`
- 房产/求职：`tests/unit/tools-job.test.ts`、领域结果与审批测试
- SSE/HTTP 契约：`tests/integration/server.test.ts`、`tests/unit/stream.test.ts`

交付前仍要执行 `AGENTS.md` §7 的完整质量门。

## 收尾

- 更新 `README.md` 和 `.plans/development-docs/agent-wiki.md`。
- 若改变架构边界，更新 `tests/unit/architecture.test.ts`，不要用例外清单绕过。
- 提交信息遵循单行中文规范，不混入无关重构。
