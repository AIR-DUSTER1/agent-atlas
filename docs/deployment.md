# 部署与运维总览

> 适用范围：**开发预览阶段的自托管与部署参考**。当前版本为 `0.9.0-beta.1`，不是正式发布版。
> 这些文档用于验证单实例部署、数据恢复和运维流程，不构成生产 SLA 或稳定兼容承诺。

## 文档导航

| 文档 | 适用场景 |
|---|---|
| [快速自托管](self-hosting.md) | 首次构建 / 拉取镜像、配置密钥、启动、验证 |
| [生产上线 Checklist](production-checklist.md) | 上线前逐项确认安全、数据、可观测性与回滚 |
| [安全与 TLS](security-and-tls.md) | Nginx / Caddy、Cookie、代理信任边界、监控令牌 |
| [备份与恢复](backup-restore.md) | 定期备份、离线副本、灾难恢复、数据校验 |
| [升级与回滚](upgrade-rollback.md) | digest 发布、迁移、失败回滚演练 |
| [监控与告警](monitoring.md) | Prometheus、日志、审计、诊断、建议告警 |
| [故障排查](troubleshooting.md) | 常见启动、认证、SSE、配置与容器问题 |
| [运维 Runbook](runbook.md) | 磁盘满、配置损坏、外部依赖故障等现场处置 |
| [支持策略](support.md) | 版本生命周期、兼容承诺、已知限制、安全报告 |

## 生产运行拓扑

```text
Browser
  │ HTTPS
  ▼
Nginx / Caddy（TLS、限流、SSE 不缓冲）
  │ HTTP 127.0.0.1:3000
  ▼
agent-tools 容器（非 root、只读根文件系统、PRODUCTION=1）
  │
  └── /data
      ├── web-config.json          # 敏感字段 AES-256-GCM 加密
      ├── sessions.ndjson          # 会话 journal
      ├── checkpoints.ndjson       # LangGraph 持久检查点
      ├── memories.json            # 跨会话记忆
      ├── skills/                  # 用户技能文档
      ├── audit.ndjson             # 安全审计
      ├── audit-archive*/          # 审计归档与哈希清单
      └── backups/                 # 校验清单 v2 + 保留策略
```

## 健康模型

| 端点 | 认证 | 含义 |
|---|---|---|
| `GET /healthz` | 无 | 进程与事件循环存活；不检查外部模型或磁盘 |
| `GET /readyz` | 无 | 未在关闭中，配置目录与 journal 目录可写 |
| `GET /metrics` | 用户会话或 `METRICS_TOKEN` | Prometheus 文本指标 |
| `GET /api/diagnostics` | 用户会话 | 数据、备份、审计与依赖摘要；不含路径明文和密钥 |

## 不可变部署边界

- 同一 `/data` 只能有一个写者；不要滚动启动两个实例。
- 生产镜像使用不可变 digest，不在服务器上执行 `docker build`。
- `PRODUCTION=1` 时缺少登录密钥、会话密钥、`DATA_KEY` 或真实模型配置会拒绝启动。
- 生产 Cookie 必须经 HTTPS；HTTP 下设置 `COOKIE_SECURE=false` 仅用于本地调试。
- `TRUST_PROXY=1` 只能在 Agent 前确实存在可信反向代理时设置。
- 桌面端是个人便利壳，不是生产部署形态。
