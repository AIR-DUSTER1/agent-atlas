# 监控与告警

## 1. 探针与指标

| 端点 | 用途 | 建议 |
|---|---|---|
| `/healthz` | liveness | 3–5 次失败后重启；不检查外部依赖 |
| `/readyz` | readiness | 3 次失败后摘除流量；检查关闭状态与数据目录 |
| `/metrics` | Prometheus | 使用独立 `METRICS_TOKEN` 抓取 |
| `/api/diagnostics` | 人工诊断 | 仅管理员会话访问；看数据/依赖摘要 |

`/metrics` 主要指标：

- HTTP：`agent_http_requests_total`、`agent_http_request_duration_milliseconds`、`agent_http_inflight_requests`；
- SSE：活跃流、断开、流状态；
- 模型：错误数、供应商/模型、超时与状态；
- 工具与审批：审批次数、拒绝/完成；
- 外部依赖：资源队列、拒绝、熔断状态与失败；
- 进程：uptime、RSS、heap、event loop lag。

## 2. Prometheus 抓取

```yaml
scrape_configs:
  - job_name: langgraph-agent
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/agent-metrics-token
    static_configs:
      - targets: ["agent.example.com"]
```

`METRICS_TOKEN` 只授权 `/metrics`，不是控制面凭据。轮换后同步更新 secret 文件。

## 3. 建议告警

| 告警 | 条件示例 | 处置 |
|---|---|---|
| Agent down | `up == 0` 持续 2 分钟 | 查看容器状态、启动日志、端口 |
| Readiness 失败 | 黑盒探测 `/readyz` 非 200 | 查关闭状态、磁盘权限与写探针 |
| 磁盘水位 | 数据卷 > 80% 预警，> 90% 严重 | 清理日志归档、扩容、验证备份 |
| 事件循环延迟 | p99 > 500ms 持续 5 分钟 | 查大请求、同步 fs、资源争抢 |
| RSS 高位 | 接近容器上限 80% | 查长会话、历史、Node heap；准备重启 |
| 模型错误率 | 5xx/超时占比 > 10% 持续 10 分钟 | 切换供应商、检查网关状态 |
| 熔断开 | 状态值进入 open | 查看依赖、等待冷却、避免自动烧配额 |
| 认证风暴 | 429 或 auth fail 突增 | 检查来源 IP、代理日志、边缘限流 |
| 备份失败 | `data:check` / 备份任务非 0 | 查磁盘、权限、manifest、时间同步 |

## 4. 日志

stdout 为一行一个 JSON：

```json
{"requestId":"...","method":"POST","path":"/api/chat","status":200,"durationMs":1200,"event":"http_request","level":"info","time":"2026-10-28T00:00:00.000Z"}
```

要求：

- 采集 stdout/stderr，不把日志写回根文件系统；
- 以 `requestId` 关联响应头 `X-Request-Id`；
- 日志中不出现 prompt、工具结果、Cookie、Authorization 或 API Key；
- 生产 `LOG_LEVEL=info`，排障临时 `debug` 后及时恢复；
- 容器日志轮转由 compose 的 `max-size` / `max-file` 控制。

## 5. 审计

审计与普通日志分离，记录登录失败、外部 Agent、贝壳安装、审批与安全边界动作。达到阈值后轮转并生成 SHA-256 清单。

- 审计归档必须采集到独立留存系统；
- 不要用 `docker compose down -v` 或格式化卷清理审计；
- `data:check` 同时检查备份审计，不替代外部合规留存；
- 发现写入失败时按 runbook 处置，不要静默删除。

## 6. 客户端错误

前端只上报错误摘要、版本、视图名，不上报 stack、对话、附件或密钥。突发客户端错误应关联最近一次前端发布和 `APP_VERSION`。
