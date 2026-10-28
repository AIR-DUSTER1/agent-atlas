> 当前为开发预览阶段（`0.9.0-beta.1`）。本 Checklist 用于部署前自检，不代表正式生产发布。

# 生产上线 Checklist

> 任一 **阻断项** 未完成时，不应把服务暴露到公网。级别定义：P0 = 拒绝上线，P1 = 上线前完成，P2 = 首个维护窗口完成。

## 安全

- [ ] **P0** `PRODUCTION=1`、`NODE_ENV=production`。
- [ ] **P0** `AUTH_TOKEN`、`SESSION_SECRET`、`DATA_KEY` 均为随机值且不在仓库中。
- [ ] **P0** `COOKIE_SECURE=true`，浏览器只通过 HTTPS 访问。
- [ ] **P0** `TRUST_PROXY=1` 仅在可信反向代理后启用，代理覆盖而非透传客户端伪造的转发头。
- [ ] **P0** 容器端口只绑定 `127.0.0.1`，公网入口由 TLS 反代承担。
- [ ] **P1** `METRICS_TOKEN` 独立于 `AUTH_TOKEN`，只用于 `/metrics`。
- [ ] **P1** 反向代理不记录 `Authorization` / `Cookie`；管理入口启用网络访问控制。
- [ ] **P1** 镜像使用 digest，Trivy 或其他扫描器无未处置 high/critical。
- [ ] **P1** 备份中的敏感字段仍为密文，`DATA_KEY` 单独保管。
- [ ] **P2** 定期审查登录失败、跨站拒绝、角色权限与审批日志。

## 数据与恢复

- [ ] **P0** `/data` 位于持久卷，备份前确认磁盘空间和水位告警。
- [ ] **P0** 已成功创建一份 v2 备份并通过 manifest/SHA-256 校验。
- [ ] **P0** 已完成一次“备份 → 隔离副本 → 恢复 → 数据检查”演练。
- [ ] **P0** `DATA_KEY` 已有离线/密钥系统副本。
- [ ] **P1** 配置、journal、checkpoint、memory、audit、skills 全部落在 `/data`。
- [ ] **P1** 备份保留最近 N 份与最近 N 天每日最后一份，并至少保留一份异机副本。
- [ ] **P1** 升级前自动备份，升级后运行 `data:check`。
- [ ] **P2** 定期验证恢复后的旧会话可读、审批状态正确、长期记忆可召回。

## 可观测性

- [ ] **P1** `/healthz` 用于 liveness，`/readyz` 用于 readiness，并设置 3 次以上失败阈值。
- [ ] **P1** Prometheus 使用 `METRICS_TOKEN` 抓取 `/metrics`。
- [ ] **P1** 告警覆盖：进程不可用、readiness 失败、磁盘水位、事件循环延迟、模型错误率、熔断 open、认证风暴。
- [ ] **P1** stdout JSON 日志被采集并设置保留期。
- [ ] **P1** 审计归档与 SHA-256 清单有独立留存，不与普通调试日志一起清理。
- [ ] **P2** 客户端错误上报有采样/告警阈值，且确认不含对话与密钥。

## 部署与资源

- [ ] **P0** 单实例部署；没有两个进程同时写同一个 `/data`。
- [ ] **P0** 镜像版本与 digest 已记入发布记录。
- [ ] **P0** 已保存上一可用镜像 digest 和对应数据备份。
- [ ] **P1** CPU / 内存限制已设置；容器重启策略为 `unless-stopped`。
- [ ] **P1** `stop_grace_period` 大于应用 10 秒排空超时。
- [ ] **P1** 根文件系统只读、`cap_drop: ALL`、`no-new-privileges`。
- [ ] **P1** 标准备份、恢复、升级和回滚步骤由非开发者演练通过。

## 质量门

- [ ] **P0** `npm run typecheck` 通过。
- [ ] **P0** `npm test` 通过。
- [ ] **P0** `npm run e2e` 通过。
- [ ] **P0** `npm run coverage:security && npm run coverage:persistence && npm run coverage:routes` 通过。
- [ ] **P0** `npm run audit:prod` 无 high/critical。
- [ ] **P0** `npm run image:smoke` 通过并保存 `artifacts/image-smoke.json`。
- [ ] **P0** SBOM 已归档并记录 SHA-256。
- [ ] **P1** `npm run build:client` 与 `npm run build:desktop` 通过；生产交付以镜像为准。
