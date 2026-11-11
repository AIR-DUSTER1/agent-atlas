# 记忆与个性化

本文说明当前版本的个性化上下文与长期记忆：个性化上下文默认注入，长期记忆默认本地可用，也可以切换到外部 HTTP 服务。它与 RAG、MCP 和 LangGraph checkpoint 属于不同能力层级：

| 能力 | 解决的问题 |
|---|---|
| LangGraph checkpoint | 同一会话跨轮次、跨重启的图状态 |
| 个性化上下文 | 每轮稳定注入用户背景、协作偏好与输出要求，不依赖检索 |
| 长期记忆插槽 | 跨会话保存用户偏好、项目事实和纠错 |
| RAG | 检索外部文档与知识库 |
| MCP | 接入会执行代码的外部工具 |

## 1. 默认形态

不配置任何外部服务时，应用使用 `LocalMemoryProvider`。v3 存储目录：

```text
.setting/memory-store/
  manifest.json
  scopes/
    local--general/
      snapshot-*.json
      events-*.ndjson
      index/vectors.json
    local--estate/
    local--job/
```

旧版 `.setting/memories.json`（v1 数组 / v2 对象）首次启动时自动迁移，原文件保留为 `memories.json.v2-backup`。`MEMORY_STORE_DIR` 可以覆盖默认目录。

本地记忆具备以下能力：

- 按 Agent scope 分目录追加事件，达到阈值后生成快照并切换 manifest，避免每次全量重写。
- v1 / v2 自动迁移到 v3；manifest 或回放损坏时 fail-closed，只读而不覆盖原文。
- 同 scope + 同 key 的新内容保留 superseded 历史；完全相同内容只刷新确认时间。
- 每轮最多注入 8 条、总计 2400 字符；查询为空时不盲注入。
- 默认拒绝密钥、令牌、密码、私钥、手机号和身份证号。PII 只能显式允许后保存，密钥始终拒绝。
- 5 万条规模基准：`npm run memory:bench`。

## 2. 自动沉淀与生命周期

自动沉淀在对话成功结束后异步执行，不阻塞回答：

| 模式 | 行为 |
|---|---|
| `off` | 不自动提取 |
| `confirm` | 候选进入待确认列表，不参与注入 |
| `smart` | 高置信、非身份类候选自动激活；其余等待确认 |

安全约束：

- 只处理用户明确表达的长期偏好、项目事实或纠错；工具输出和助手中自述不作为唯一依据。
- 每轮默认最多 3 条、每小时最多 20 条。
- 身份类信息始终需要人工确认；secret 始终拒绝，PII 默认拒绝。
- 候选不参与检索和注入，确认后才成为 active。
- 本地 Provider 才支持自动沉淀；HTTP Provider 没有统一候选契约时跳过，避免绕过确认直接写入。

生命周期：

```text
candidate → active → stale → archived
                 ↘ superseded
```

- 偏好、项目事实、纠错、身份分别有独立有效期。
- 到期 active 自动转 stale；默认宽限 30 天后归档。
- 读取与 6 小时后台维护都会推进 TTL；stale / archived 默认不注入。
- 每个 scope 的 active 与历史数量都有上限，淘汰时优先清理最老历史版本。

## 3. 语义召回

默认仍使用零依赖词法召回。启用 OpenAI 兼容 Embedding 后：

1. 保存或确认记忆时异步构建向量索引；
2. 查询时同时获取词法候选与向量候选；
3. 使用 RRF 融合，并叠加置信度、人工确认与最近使用权重；
4. 外部服务超时、坏响应、维度不一致或索引未建好时，自动降级为词法结果；
5. 索引文件按 scope 存储，模型名或维度变化后视为失效并可手动重建。

Embedding API Key 与 HTTP 记忆 Key 一样只显示掩码；不会出现在配置 API、诊断接口或日志中。

## 4. Agent 隔离

记忆按 scope 强隔离：

```json
{ "profileId": "general", "userId": "local" }
{ "profileId": "estate", "userId": "local" }
{ "profileId": "job", "userId": "local" }
```

- 通用 Agent 使用 `general`。
- 租房 / 房产 Agent 使用 `estate`。
- 求职 Agent 使用 `job`。
- 三个 Agent 没有隐式共享 scope。
- 租房与求职 Agent 默认不挂载 `memory_save` / `memory_recall` 工具；自动沉淀也只会写自己的 scope。
- 子 Agent 不挂载长期记忆工具，避免后台任务污染用户记忆。

设置页可切换 scope 查看和管理条目。导入“替换”只替换当前 scope，不会删除其他 Agent 的数据。

## 5. 设置页

入口：左下角 **设置 → 记忆与个性化**。

页面分为：

1. **个性化上下文**：一段稳定的个人背景、协作偏好和输出要求，默认启用并逐轮注入，不占用记忆条目。
2. **存储提供方**：本地 / HTTP Provider、健康、延迟、active、候选、历史与索引状态。
3. **HTTP 外部记忆**：预设、Base URL、认证、超时、召回上限、Hindsight bank 和写入开关。
4. **自动沉淀与生命周期**：模式、频率、有效期和保留上限。
5. **语义召回**：Embedding Base URL、模型、Key、维度、阈值、连接测试与索引重建。
6. **记忆条目管理**：按 scope 查看、筛选、删除、历史、导出与导入，以及候选确认 / 拒绝。

手动新增记忆表单和 `POST /api/memories` 已移除。长期记忆只来自自动沉淀、对话内记忆工具或导入迁移，避免用户维护大量碎片条目。API Key 保存后只显示掩码。编辑其他字段时留空表示保持原 Key；勾选“清除已保存的 API Key”才会删除。

## 6. 配置结构

配置保存在 `.web-config.json` 的 `memory` 键：

```json
{
  "memory": {
    "activeProvider": "local",
    "local": { "allowPII": false },
    "personalization": { "enabled": true, "text": "" },
    "http": {
      "enabled": false,
      "preset": "generic",
      "baseURL": "",
      "authMode": "bearer",
      "apiKey": "",
      "timeoutMs": 8000,
      "searchLimit": 8,
      "writeEnabled": true,
      "banks": { "general": "", "estate": "", "job": "" }
    },
    "distillation": { "mode": "smart", "maxPerTurn": 3, "hourlyLimit": 20 },
    "embedding": {
      "enabled": false,
      "baseURL": "",
      "model": "",
      "apiKey": "",
      "timeoutMs": 8000,
      "dimensions": 0,
      "minSimilarity": 0.25
    },
    "retention": {
      "activePerScope": 2000,
      "historyPerScope": 5000,
      "staleGraceDays": 30,
      "preferenceDays": 180,
      "projectFactDays": 120,
      "correctionDays": 365,
      "identityDays": 365
    }
  }
}
```

没有 `memory` 键时按上述默认值运行；旧配置缺少新字段也会自动补默认值，不需要手工迁移。
## 7. Generic HTTP 契约

Generic Provider 支持以下最小契约。

### 7.1 健康检查

```http
GET /health
```

```json
{ "status": "ok" }
```

### 7.2 检索

```http
POST /memories/search
Content-Type: application/json

{
  "scope": { "profileId": "general", "userId": "local" },
  "query": "回答风格",
  "limit": 8
}
```

```json
{
  "records": [
    {
      "externalId": "mem-123",
      "key": "回答风格",
      "content": "结论先行，少用列表",
      "tags": ["preference"],
      "source": "user",
      "updatedAt": 1760000000000
    }
  ]
}
```

### 7.3 保存

```http
POST /memories
Content-Type: application/json

{
  "scope": { "profileId": "general", "userId": "local" },
  "key": "回答风格",
  "content": "结论先行，少用列表",
  "tags": ["preference"],
  "source": "agent"
}
```

```json
{ "externalId": "mem-123", "duplicated": false }
```

### 7.4 列表

设置页管理外部 Provider 时使用：

```http
GET /memories?profileId=general&userId=local&history=1
```

响应形状与检索相同：`{ "records": [...] }`。`history` 可选，表示外部服务若支持也应返回历史版本。

### 7.5 删除

```http
DELETE /memories/mem-123
```

```json
{ "ok": true }
```

### 7.6 认证

`authMode=bearer` 时请求带：

```http
Authorization: Bearer <API_KEY>
```

外部服务返回 401 / 403 时，界面显示鉴权失败；不会回显响应正文或凭据。

## 8. Hindsight 预设

`preset=hindsight` 时使用 bank 映射：

```text
general → http.banks.general
estate  → http.banks.estate
```

三个 bank 必须互不相同。Hindsight 模式要求分别填写 general / estate / job bank，保存配置时会拒绝共用或留空。

| 操作 | 请求 |
|---|---|
| health | `GET /health` |
| 检索 | `POST /v1/default/banks/{bank}/memories/recall`，请求体 `{ "query": "...", "limit": 8 }` |
| 保存 | `POST /v1/default/banks/{bank}/memories`，请求体包含 `content`、`tags`、`metadata` |
| 删除 | 当前不支持，设置页会显示只读 / 不支持删除 |

保存时 `metadata` 包含 `key`、`source`、`profileId`、`userId`。检索响应可返回 `memories`、`results`、`items` 或 `records` 数组；服务端只按白名单转换需要的字段。

## 9. 故障与降级

- 外部检索失败：返回空记忆并标记 degraded，聊天继续。
- 外部保存失败：工具返回中文错误，不穿透 LangGraph 图。
- 外部健康失败：设置页和诊断显示不可用，不影响 `/readyz`。
- 请求超时：默认 8 秒，可配置 500ms～30 秒。
- 连续 3 次失败：熔断 30 秒，之后自动半开探测。
- 响应超过 512KB：中止读取并降级。
- HTTP 重定向：拒绝跟随，避免认证头或请求被转移到非预期地址。

外部 Provider 不会自动把失败写入本地，避免两边状态漂移。需要本地归档时使用设置页的“导出本地快照”。

## 10. 导入与导出

导出文件是 schema v3 JSON：

```json
{
  "schemaVersion": 3,
  "exportedAt": 1760000000000,
  "scope": { "profileId": "general", "userId": "local" },
  "memories": []
}
```

导入规则：

- 单次最多 1000 条。
- 导入前整批校验，任何一条含密钥会拒绝整批。
- 手机号 / 身份证默认拒绝；先在设置页显式允许 PII。
- 合并模式按主题把原有 active 版本转为 superseded。
- 替换模式只替换当前 scope，另一个 Agent 不变。
- 来源统一标记为 `import`。
- 更高 schema 版本 fail-closed。

## 11. 指标与诊断

Prometheus 指标：

```text
memory_save_total
memory_save_failed_total
memory_recall_total
memory_recall_hit_total
memory_recall_results_total
memory_injected_total
memory_provider_latency_milliseconds
memory_provider_degraded_total
memory_sensitive_blocked_total
memory_provider_health
memory_distillation_candidate_total
memory_distillation_auto_saved_total
memory_distillation_model_failed_total
memory_lifecycle_maintenance_failed_total
```

指标只带 provider、profile、操作、结果等低基数标签，不含记忆正文、完整提示词、URL、Cookie 或 API Key。

`GET /api/diagnostics` 会返回记忆数据健康、schemaVersion、Provider 状态和配置摘要；`GET /api/memory/status` 返回更完整的插槽运行状态。HTTP 记忆故障不会让 `/readyz` 失败。

## 12. 备份与恢复

`npm run backup` 会递归包含 `memory-store/` 下的 manifest、scope 快照、事件日志与向量索引，并单独保留可能存在的旧 `memories.json`。恢复后：

- v3 目录直接恢复；旧 v1 / v2 文件在首次加载时自动迁移。
- 每个记忆文件的路径、大小与 SHA-256 都写入备份 manifest；恢复前整批校验。
- 损坏副本保留为 `.corrupt-*`，不进入备份，也不会覆盖原文件。
- 备份恢复只写磁盘；当前进程仍使用旧内存状态，需重启服务后完全生效。

## 13. 故障排查

| 现象 | 排查 |
|---|---|
| 设置页提示 HTTP 不可用 | 检查 Base URL、网络、认证方式和 `/health` |
| 返回 401 / 403 | 重新填写 API Key；留空会保留旧 Key |
| Hindsight 保存配置失败 | 确认 `general` / `estate` / `job` bank 都已填写且三者不同 |
| 记忆没有注入 | 当前查询必须与 key、标签或内容相关；空查询不注入；候选 / stale / archived 默认不注入 |
| 语义召回显示降级 | 检查 Embedding URL、模型、维度和 Key，并在设置页重建当前 Agent 索引 |
| 自动沉淀没有生成候选 | 确认模式不是“关闭”，本轮包含明确记忆表达，且当前使用本地 Provider |
| 导入了另一 Agent 的数据 | 导入固定重写为目标 scope，请先选择正确 Agent 范围 |
| 备份恢复后列表没变化 | 重启服务；恢复不热替换所有内存单例 |
| 敏感内容无法保存 | 密钥永远拒绝；PII 需在设置页显式允许 PII |
