# LangSmith 链路追踪

> 当前版本：`0.9.0-beta.18`
> 状态：可选能力，默认关闭
> 适用范围：开发调试、评测和受控内部环境

LangSmith 追踪用于观察一轮 Agent 任务的执行瀑布图，包括 LangGraph 节点、工具调用和模型调用的耗时与层级。它不会改变模型收到的内容，也不会改变 SSE 事件、审批结果或本地会话记录。

## 1. 默认行为

默认配置为：

```text
TRACE_BACKEND=off
```

关闭时不会创建 LangSmith client，也不会发起 trace 上报请求。普通对话、指标、审计、统计和本地检查点保持原有行为。

## 2. 数据流向

开启 LangSmith 后，trace 数据从 agentatlas 服务端发送到配置的 HTTPS endpoint：

```text
Agent 图 / 工具 / 模型调用
          │
          ▼
 LangChainTracer callback
          │
          ▼
 LangSmith Client（异步批量上报）
          │
          ▼
 https://api.smith.langchain.com
```

trace 可以包含提示词、模型响应、工具入参和工具结果。**开启即表示允许这些内容发送到 LangSmith**。默认脱敏可以减少常见敏感值，但不能保证所有业务数据都不会出网；生产多用户环境应优先保持关闭或使用隔离的 LangSmith workspace。

## 3. 开启方式

### 3.1 设置页

进入左下角 **设置 → 链路追踪**：

1. 将上报后端切换为 `LangSmith`。
2. 填写 LangSmith API Key。
3. 确认项目名和 endpoint。
4. 保持“上报前脱敏”开启。
5. 保存配置，下一条新消息生效。

API Key 在页面和 API 中只显示掩码。编辑时留空表示保持原 Key；勾选“清除已保存的 API Key”后保存才会删除。

### 3.2 环境变量

也可以在 `.env` 中配置：

```dotenv
# 推荐使用 LangSmith SDK 标准开关
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=your-langsmith-api-key
LANGSMITH_PROJECT=agentatlas-local
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_AGENT_ID=agentatlas
LANGSMITH_AGENT_ENVIRONMENT=local
LANGSMITH_ANONYMIZE=true

# 兼容旧开关，二选一即可
# TRACE_BACKEND=langsmith
```

`LANGSMITH_TRACING=true` 会启用本应用的显式 callback 注入；本地开发建议使用独立 project（如 `agentatlas-local`），避免与 staging、production 的 trace 混在一起。应用会关闭 LangChain SDK 的全局自动 tracer，避免同一轮请求被重复上报。默认 `.env.example` 保持关闭，配置 API Key 后再显式开启。

配置优先级：

```text
.env < .web-config.json < 运行中内存
```

设置页保存的配置会持久化到 `.web-config.json`，并优先于 `.env`。

## 4. Trace metadata

每轮 trace 会带上以下内部 metadata，便于在 LangSmith 中筛选：

| metadata | 默认值 | 来源 |
|---|---|---|
| `sessionId` | 当前会话 id | 运行时自动注入 |
| `profileId` | 当前 Agent Profile | 运行时自动注入 |
| `agent_id` | `agentatlas` | `LANGSMITH_AGENT_ID` |
| `agent_environment` | `local` | `LANGSMITH_AGENT_ENVIRONMENT` |

这些字段只用于观测和定位，不包含用户资料、prompt 或 API Key。

## 5. 脱敏规则

默认脱敏在 LangSmith Client 上报边界执行，覆盖：

- 手机号：替换为 `<phone>`
- 18 位身份证：替换为 `<id-card>`
- 16–19 位银行卡号：替换为 `<card>`
- 常见 API Key、Token、密码和 Authorization 字段：使用 LangSmith SDK 内置凭据规则

脱敏只影响准备上报到 LangSmith 的副本，不影响模型实际输入、SSE 输出、journal 或本地记忆。

它不是完整性保证。若业务文本本身包含需要严格保密的数据，请不要开启追踪，或先使用脱敏后的独立测试数据。

## 6. Endpoint 与网络边界

LangSmith endpoint 必须满足：

- 使用 `https://`
- 不包含用户名或密码
- 不指向 `localhost`、环回地址、私有 IPv4 地址或私有 IPv6 字面量

校验失败时追踪会降级为关闭，并记录一条结构化 warning，不会中断主任务。官方默认地址：

```text
https://api.smith.langchain.com
```

## 7. 失败与降级

以下情况不会导致对话失败：

- 未配置 API Key
- endpoint 非法
- LangSmith client 或 tracer 初始化异常
- LangSmith 网络超时或上游不可用

主任务按原有路径继续执行；trace 只作为旁路观测。相同配置错误只记录一次 warning，避免每轮刷日志。

## 8. 与现有可观测能力的关系

| 能力 | 作用 |
|---|---|
| `/metrics` | 运行时计数、耗时、资源与服务指标 |
| `/api/diagnostics` | 数据、备份、审计和依赖状态摘要 |
| `task_usage` | 每轮任务的模型用量与工具调用汇总 |
| LangSmith | 单轮任务的节点 / 工具 / 模型调用瀑布图 |
| journal / checkpoint | 本地会话回放与跨轮次状态恢复 |

LangSmith 不替代本地审计和指标，也不参与 token 统计口径。

## 9. 关闭与回滚

在设置页将“上报后端”切换为“关闭（默认）”并保存即可停止新请求。已上报的历史 trace 由 LangSmith 平台管理，不会通过 agentatlas 自动删除。

如果只需要本地可观测性，请保持默认关闭；需要更完整的自托管追踪方案时，再评估后续 OTel / Langfuse 路线。

## 10. 故障排查

### 保存后显示 Key 未配置

确认输入框中的 Key 已填写，或检查 `.web-config.json` 是否被清空。Key 不会在 API 响应中回显。

### 端点校验失败

确认 endpoint 使用公网 HTTPS 地址，且没有把内部测试服务地址写入生产配置。

### 开启后主对话仍能完成，但 LangSmith 看不到 trace

检查服务端结构化日志中的 `trace_disabled` warning；确认网络可以访问 endpoint，并确认当前会话使用的是主 Agent，而不是不注入 trace 的 demo 或 CLI 路径。

### 脱敏结果不符合预期

关闭追踪，使用测试数据验证脱敏规则后再开启。若业务数据具有特殊格式，应在外部预处理，不能依赖正则脱敏作为唯一安全边界。
