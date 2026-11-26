# 部署与运维总览

> 适用范围：**开发预览阶段的自托管与部署参考**。当前版本为 `0.9.0-beta.20`，不是正式发布版。
> 这些文档用于验证单实例部署、数据恢复和运维流程，不构成生产 SLA 或稳定兼容承诺。

## 文档导航

| 文档 | 适用场景 |
|---|---|
| [快速自托管](self-hosting.md) | 首次构建 / 拉取镜像、配置密钥、启动、验证 |
| [PostgreSQL 多用户与 RLS](postgres-multitenant.md) | 多用户账号、userId、RLS、数据库部署与恢复 |
| [生产上线 Checklist](production-checklist.md) | 上线前逐项确认安全、数据、可观测性与回滚 |
| [安全与 TLS](security-and-tls.md) | Nginx / Caddy、Cookie、代理信任边界、监控令牌 |
| [备份与恢复](backup-restore.md) | 定期备份、离线副本、灾难恢复、数据校验 |
| [升级与回滚](upgrade-rollback.md) | digest 发布、迁移、失败回滚演练 |
| [监控与告警](monitoring.md) | Prometheus、日志、审计、诊断、建议告警 |
| [故障排查](troubleshooting.md) | 常见启动、认证、SSE、配置与容器问题 |
| [运维 Runbook](runbook.md) | 磁盘满、配置损坏、外部依赖故障等现场处置 |
| [支持策略](support.md) | 版本生命周期、兼容承诺、已知限制、安全报告 |


## 存储后端与登录形态

| 场景 | 后端 | 登录形态 | 说明 |
|---|---|---|---|
| 本地个人使用 / 桌面端 | `file`（默认） | 单用户免登；可选访问密码锁 | 零依赖开箱即用；密码锁在「设置 → 账号与安全」开启 |
| 本地多人共用一台机器 | `postgres` | 多用户强制登录 | 需自起 PostgreSQL，见 `docker run postgres` 单节 |
| 线上 / Docker 部署 | `postgres`（推荐） | 多用户强制登录 | 使用 `docker-compose.postgres.yml` 叠加层；用户管理与登录见下 |
| 线上坚持 file | `file` | 单用户 + 必须访问密码锁 | 启动时输出 `file_backend_in_production` 警告；多用户隔离不可用 |

多用户模式（`STATE_BACKEND=postgres`）下：

- 用户用「用户名 + 密码」登录；管理员在「设置 → 账号与安全」创建用户、重置密码、管理访问令牌。
- 首登或密码被重置后强制改密（`must_change_password`）；改密后所有会话与设备免登失效。
- 连续 10 次登录失败锁定账户 15 分钟；IP 维度另有 5 次 / 15 分钟限流。
- 忘记管理员密码：用 `BOOTSTRAP_ADMIN_USERNAME` 对应账户走「重置密码」，或用 `npm run user:create` 新建管理员。
- 文件模式的访问密码锁忘记时在本机运行 `npm run lock:clear`。

## 生产运行拓扑（文件后端）

```text
Browser
  │ HTTPS
  ▼
Nginx / Caddy（TLS、限流、SSE 不缓冲）
  │ HTTP 127.0.0.1:3000
  ▼
agentatlas 容器（非 root、只读根文件系统、PRODUCTION=1）
  │
  └── /data
      ├── web-config.json          # 敏感字段 AES-256-GCM 加密
      ├── sessions.ndjson          # 会话 journal
      ├── checkpoints.ndjson       # LangGraph 持久检查点
      ├── memory-store/            # 跨会话记忆 v3（事件 / 快照 / 向量索引）
      ├── skills/                  # 用户技能文档
      ├── audit.ndjson             # 安全审计
      ├── audit-archive*/          # 审计归档与哈希清单
      └── backups/                 # 校验清单 v2 + 保留策略
```

生产镜像固定设置 `BROWSER_USE_CONTAINER=1`。因此 Docker / 容器部署中 **Computer Use 始终禁用**：旧配置即使写成启用也会在启动时收敛为关闭，API 启用请求会被拒绝，设置页显示“Docker 部署不可用”。需要在 Windows 桌面直接控制本机时，请使用桌面版而不是容器版。

`BROWSER_USE_EXECUTABLE_PATH`、`BROWSER_USE_CONTAINER`、`JOB_BROWSER_HEADLESS` 是无头 Chromium 的 Browser Use / 求职采集参数，不是 Computer Use 运行时；它们本身不增加镜像层。Computer Use 工具实现也没有额外 npm 或原生依赖。若完全不需要无头浏览器，可使用 `--target minimal` 构建瘦镜像，但 Browser Use 和求职网页采集也会失去浏览器运行时；Computer Use 在任何容器目标中都不可用。

## 多用户生产拓扑

```text
Browser A / Browser B
        │ HTTPS
        ▼
Nginx / Caddy
        │
        ▼
agentatlas 容器（单实例）
        │
        ├── PostgreSQL
        │   ├── users / auth_tokens / devices
        │   ├── session_journal_events（user_id + RLS）
        │   ├── checkpoint_rows / checkpoint_writes（user_id + RLS）
        │   ├── projects / user_settings（user_id + RLS）
        │   └── audit_events（user_id + RLS）
        │
        └── /data
            ├── web-config.json          # 管理员级全局配置
            ├── memory-store/            # 当前仍为 user-scoped 文件
            ├── audit.ndjson
            └── backups/
```

数据库连接使用两个角色：`DATABASE_ADMIN_URL` 只用于迁移/bootstrap，`DATABASE_URL` 使用
`agent_app` 低权限角色并启用 RLS。角色权限、账号创建和 pg_dump 流程见
[PostgreSQL 多用户与 RLS](postgres-multitenant.md)。
## 健康模型

| 端点 | 认证 | 含义 |
|---|---|---|
| `GET /healthz` | 无 | 进程与事件循环存活；不检查外部模型或磁盘 |
| `GET /readyz` | 无 | 未在关闭中，配置目录与 journal 目录可写 |
| `GET /metrics` | 用户会话或 `METRICS_TOKEN` | Prometheus 文本指标 |
| `GET /api/version` | 用户会话 | 产品版本、渠道、提交、构建时间与 buildId |
| `GET /api/diagnostics` | 用户会话 | 数据、备份、审计与依赖摘要；不含路径明文和密钥 |

## 不可变部署边界

- 同一 `/data` 只能有一个写者；不要滚动启动两个实例。
- 生产镜像使用不可变 digest，不在服务器上执行 `docker build`。
- `PRODUCTION=1` 时缺少登录密钥、会话密钥、`DATA_KEY` 或真实模型配置会拒绝启动。
- 生产 Cookie 必须经 HTTPS；HTTP 下设置 `COOKIE_SECURE=false` 仅用于本地调试。
- `TRUST_PROXY=1` 只能在 Agent 前确实存在可信反向代理时设置。
- 桌面端是个人便利壳，不是生产部署形态。
