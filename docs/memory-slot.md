# 长期记忆插槽

本文说明当前版本的长记忆功能：默认本地可用，也可以切换到外部 HTTP 服务。它与 RAG、MCP 和 LangGraph checkpoint 是四种不同能力：

| 能力 | 解决的问题 |
|---|---|
| LangGraph checkpoint | 同一会话跨轮次、跨重启的图状态 |
| 长期记忆插槽 | 跨会话保存用户偏好、项目事实和纠错 |
| RAG | 检索外部文档与知识库 |
| MCP | 接入会执行代码的外部工具 |

## 1. 默认形态

不配置任何外部服务时，应用使用 `LocalMemoryProvider`，数据写入：

```text
.setting/memories.json
```

本地记忆具备以下能力：

- 原子写入与串行更新，并发保存不会互相覆盖。
- v1 数组格式自动迁移到 v2 对象格式。
- 损坏文件改名隔离为 `memories.json.corrupt-<timestamp>`，服务从空记忆启动。
- 未来版本文件 fail-closed，不覆盖原始数据。
- 同一 Agent scope + 同一主题的新内容保留历史版本；完全相同的重复内容只刷新时间。
- 每轮最多注入 8 条、总计 2400 字符；查询为空时不会盲注入。
- 默认拒绝密钥、令牌、密码、私钥、手机号和身份证号。PII 只能在设置页显式允许后由用户手动保存，密钥始终拒绝。

## 2. Agent 隔离

记忆按 scope 物理隔离：

```json
{ "profileId": "general", "userId": "local" }
{ "profileId": "estate", "userId": "local" }
```

- 通用 Agent 只能读写 `general`。
- 租房 / 房产 Agent 使用独立 `estate` scope。
- 两个 Agent 没有隐式共享 scope。
- 租房 Agent 默认不挂载 `memory_save` / `memory_recall` 工具。
- 子 Agent 不挂载长期记忆工具，避免后台任务污染用户记忆。

设置页可切换 scope 查看和管理条目。导入“替换”只替换当前 scope，不会删除另一个 Agent 的数据。

## 3. 设置页

入口：左下角 **设置 → 长期记忆**。

页面分为三块：

1. **存储提供方**：切换内置本地或 HTTP 外部 Provider，查看健康、延迟、本地文件状态、active / 历史条数。
2. **HTTP 外部记忆**：配置预设、Base URL、认证、超时、召回上限、Hindsight bank 和读写开关，并支持连接测试。
3. **记忆条目管理**：按 scope 查看、筛选、添加、删除、历史版本、导出与导入。

API Key 保存后只显示掩码。编辑其他字段时留空表示保持原 Key；勾选“清除已保存的 API Key”才会删除。

## 4. 配置结构

配置保存在 `.web-config.json` 的 `memory` 键：

```json
{
  "memory": {
    "activeProvider": "local",
    "local": { "allowPII": false },
    "http": {
      "enabled": false,
      "preset": "generic",
      "baseURL": "",
      "authMode": "bearer",
      "apiKey": "",
      "timeoutMs": 8000,
      "searchLimit": 8,
      "writeEnabled": true,
      "banks": { "general": "", "estate": "" }
    }
  }
}
```

没有 `memory` 键时按上述默认值运行。`apiKey` 由配置存储的敏感字段加密机制保护，不会通过管理 API 回传明文。

## 5. Generic HTTP 契约

Generic Provider 支持以下最小契约。

### 5.1 健康检查

```http
GET /health
```

```json
{ "status": "ok" }
```

### 5.2 检索

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

### 5.3 保存

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

### 5.4 列表

设置页管理外部 Provider 时使用：

```http
GET /memories?profileId=general&userId=local&history=1
```

响应形状与检索相同：`{ "records": [...] }`。`history` 可选，表示外部服务若支持也应返回历史版本。

### 5.5 删除

```http
DELETE /memories/mem-123
```

```json
{ "ok": true }
```

### 5.6 认证

`authMode=bearer` 时请求带：

```http
Authorization: Bearer <API_KEY>
```

外部服务返回 401 / 403 时，界面显示鉴权失败；不会回显响应正文或凭据。

## 6. Hindsight 预设

`preset=hindsight` 时使用 bank 映射：

```text
general → http.banks.general
estate  → http.banks.estate
```

两个 bank 必须不同。Hindsight 模式要求分别填写两个 bank，保存配置时会拒绝共用或留空。

| 操作 | 请求 |
|---|---|
| health | `GET /health` |
| 检索 | `POST /v1/default/banks/{bank}/memories/recall`，请求体 `{ "query": "...", "limit": 8 }` |
| 保存 | `POST /v1/default/banks/{bank}/memories`，请求体包含 `content`、`tags`、`metadata` |
| 删除 | 当前不支持，设置页会显示只读 / 不支持删除 |

保存时 `metadata` 包含 `key`、`source`、`profileId`、`userId`。检索响应可返回 `memories`、`results`、`items` 或 `records` 数组；服务端只按白名单转换需要的字段。

## 7. 故障与降级

- 外部检索失败：返回空记忆并标记 degraded，聊天继续。
- 外部保存失败：工具返回中文错误，不穿透 LangGraph 图。
- 外部健康失败：设置页和诊断显示不可用，不影响 `/readyz`。
- 请求超时：默认 8 秒，可配置 500ms～30 秒。
- 连续 3 次失败：熔断 30 秒，之后自动半开探测。
- 响应超过 512KB：中止读取并降级。
- HTTP 重定向：拒绝跟随，避免认证头或请求被转移到非预期地址。

外部 Provider 不会自动把失败写入本地，避免两边状态漂移。需要本地归档时使用设置页的“导出本地快照”。

## 8. 导入与导出

导出文件是 schema v2 JSON：

```json
{
  "schemaVersion": 2,
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

## 9. 指标与诊断

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
```

指标只带 provider、profile、操作、结果等低基数标签，不含记忆正文、完整提示词、URL、Cookie 或 API Key。

`GET /api/diagnostics` 会返回记忆数据健康、schemaVersion、Provider 状态和配置摘要；`GET /api/memory/status` 返回更完整的插槽运行状态。HTTP 记忆故障不会让 `/readyz` 失败。

## 10. 备份与恢复

`npm run backup` 会包含 `memories.json`，manifest 标记 `schemaVersion: 2`。恢复后：

- v1 备份会在首次加载时自动迁移到 v2。
- 损坏副本保留为 `.corrupt-*`，不进入备份，也不会覆盖原文件。
- 备份恢复只写磁盘；当前进程仍使用旧内存状态，需重启服务后完全生效。

## 11. 故障排查

| 现象 | 排查 |
|---|---|
| 设置页提示 HTTP 不可用 | 检查 Base URL、网络、认证方式和 `/health` |
| 返回 401 / 403 | 重新填写 API Key；留空会保留旧 Key |
| Hindsight 保存配置失败 | 确认 `general` / `estate` bank 都已填写且不同 |
| 记忆没有注入 | 当前查询必须与 key、标签或内容相关；空查询不注入 |
| 导入了另一 Agent 的数据 | 导入固定重写为目标 scope，请先选择正确 Agent 范围 |
| 备份恢复后列表没变化 | 重启服务；恢复不热替换所有内存单例 |
| 敏感内容无法保存 | 密钥永远拒绝；PII 需在设置页显式允许 PII |
