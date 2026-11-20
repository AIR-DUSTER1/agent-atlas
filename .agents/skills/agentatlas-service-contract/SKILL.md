---
name: agentatlas-service-contract
description: "修改 agentatlas 的 HTTP 路由、SSE 事件、配置持久化、认证安全、迁移或可观测性契约时使用；不用于仅 Agent 图或仅前端样式改动。"
---

# Agentatlas Service Contract

## 开始前

1. 阅读项目根目录 `AGENTS.md` 与 `.plans/development-docs/agent-orchestration.md`。
2. 涉及登录、TLS、Cookie、CORS 或代理时读取 `docs/security-and-tls.md`。
3. 涉及备份、迁移、指标或故障处置时读取对应部署文档，不凭记忆设计。

## 不可破坏的契约

- 后端保持 `node:http` 零框架；路由写在既有顺序 `if` 分发中。
- 新接口遵循：`readBody -> await 业务 -> writeHead -> end`，失败返回中文 4xx。
- 配置写入只走 `config-store.ts` 的 `mergeConfig` 与 `persist`；API Key 只回掩码。
- 文件访问只走 `files.ts`：先 resolve，再 `assertAuthorized`，再做二进制、截断和敏感路径检查。
- SSE 新事件必须同步 `server/events.ts`、事件产出端、`client/stream/events.ts` 与 `modules/types-api.ts`。
- 每轮结束必须发 `task_usage`，位置在最后一条 `usage` 之后、`done` 之前。
- 新增 schema 必须向前迁移；未来版本 fail-closed；journal/checkpoint 坏行隔离。
- 日志和指标不得记录 prompt、对话正文、Cookie、Authorization、Key 或高基数正文标签。

## 实施流程

1. 先找现有同域模块、路由和集成测试，保持一个模块一个职责。
2. HTTP、持久化、事件和前端状态只在必要层改动，不把业务写进 `index.ts`。
3. 认证、限流、同源校验和错误响应复用现有防线。
4. 新接口同时补成功、400/401/404、超限或坏 JSON 路径。
5. 事件或图节点发生变化时，再使用 `$agentatlas-agent-runtime`。
6. 前端事件消费发生变化时，再使用 `$agentatlas-frontend`。

## 最低验证

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/integration/server.test.ts tests/security/http.test.ts tests/unit/architecture.test.ts
```

按改动补充 persistence、auth、stream、observability、release-check 测试。涉及部署面时使用 `$agentatlas-release-ops`。

## 收尾

- 更新 README 的外部契约和 `.plans/development-docs/agent-wiki.md`。
- 新接口必须在临时端口做成功与失败路径手测，不消耗真实模型配额。
- 任何新增例外必须有测试和书面理由，不得静默加入放行列表。
