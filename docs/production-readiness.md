# Production Readiness Report — v1.1.0

> 结论：**Level 2 单实例自托管生产门禁通过**。本文记录的是当前代码树、生产镜像、自动化测试与演练证据；它不等于多租户 SaaS 或多副本高可用认证。
>
> 审计日期：2026-10-28
> 应用版本：`1.1.0`
> 证据 commit：`b9946a9341e5a9c7d97fa64448b8dce432bd5491`
> 目标形态：单实例 Web + `/data` 持久卷 + TLS 反向代理

## 1. 最终门禁

| 门 | 结果 | 证据 |
|---|---|---|
| Quality | PASS | `npm run typecheck`；`npm test` 284/284；client / desktop build 通过 |
| Browser E2E | PASS | Playwright 4/4：登录/退出、设置与供应商弹窗、会话恢复、审批折叠单头像、停止流、100KB 消息 |
| Security coverage | PASS | lines 99.11%、branches 95.18%、functions 100% |
| Persistence coverage | PASS | lines 99.43%、branches 91.48%、functions 100% |
| Auth route coverage | PASS | lines 95.55%、branches 86.11%、functions 100% |
| Dependency audit | PASS | production `high=0 critical=0`，moderate/low=0 |
| Data | PASS | `data:check`：config schema 3、journal 45/45、checkpoint 59/59 |
| Readiness | PASS | 生产模式 readiness 15/15 |
| Deployment | PASS | 多阶段镜像 smoke：健康、登录、metrics、注销、优雅停止全通过 |
| Docs | PASS | README、部署、TLS、备份恢复、升级回滚、监控、runbook、故障排查、支持策略已同步 |
| Boundaries | PASS | Agent 依赖方向、通用/房产工具隔离、routes 文件系统边界、CSP 守门全绿 |

## 2. 生产镜像证据

| 项目 | 值 |
|---|---|
| Local image | `langgraph-agent-demo:1.1.0` |
| OCI manifest list | `sha256:aab87bd69626301a0c4b696fd7e70f2dda26be2ad162f339ed0768c03a3a89ca` |
| Image size | `103,949,569` bytes（约 99.1 MiB） |
| Base image | `node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8` |
| Image revision label | `b9946a9341e5a9c7d97fa64448b8dce432bd5491` |
| `/healthz` | 200 |
| `/readyz` | 200 |
| 静态首页 / entry / vendor / styles | 200 |
| HttpOnly + SameSite=Strict 登录 | PASS |
| `/metrics` Bearer scrape | 200 |
| 注销 | 200 |
| 优雅停止 `server_stopped` | PASS |
| 运行面检查 | 无 Electron、TypeScript、tests、docs、desktop、src/client |

镜像 smoke 证据写入 `artifacts/image-smoke.json`，该目录不入库。

## 3. 供应链证据

- CycloneDX SBOM：`artifacts/sbom.cdx.json`
- SBOM 字节数：`42,248`
- SBOM SHA-256：`6840d54ebd5cd4e7a6d8ad65680748dd7727c3d65f87ae692e3ea1e15108aad0`
- 生产依赖审计：0 high / 0 critical
- CI 已配置：high/critical 阻断、dependency review、Trivy advisory、SBOM artifact、E2E artifact、image smoke artifact

本地未执行 registry push，因此上表记录的是本地 OCI manifest digest；正式发布后应由 registry 返回并记录 repository digest。

## 4. 故障与恢复演练

| 演练 | 结果 |
|---|---|
| config / journal / checkpoint 损坏 | PASS（坏行隔离或 fail-closed，测试覆盖） |
| 不可写数据路径（ENOTDIR） | PASS，写探针拒绝 |
| 备份篡改 | PASS，SHA-256 校验拒绝 |
| 恢复失败回滚 | PASS，恢复前自动快照，原数据不被破坏 |
| SSE 客户端中途断开 | PASS，取消生成、aborted 入档、断连指标递增、服务继续可用 |
| MCP 子进程死亡 | PASS，返回可读错误并转为 disconnected |
| 10 并发会话 / 100KB 消息 | PASS，mock 模式无真实模型消耗 |
| 1000 会话 / 30 天统计 | PASS，聚合耗时低于 3 秒阈值 |
| 镜像标签回滚 | PASS，prev → next → prev 三次启动均在同一数据卷上 ready |
| 优雅停止 | PASS，`server_stopped` 后退出码 0 |

镜像标签演练验证了 digest/tag 切换与数据卷复用；真实跨版本 schema 回滚仍应在上线环境按 `docs/upgrade-rollback.md` 使用旧/新镜像和升级前备份再演练一次。

## 5. 已知限制

- 单实例、单写者：同一 `/data` 不能启动多个容器。
- 无多用户账号、RBAC、按用户配额；共享访问令牌用户拥有相同控制面权限。
- 文件型持久化不是数据库集群；不提供跨区域复制。
- 桌面端未完成签名、自动更新和崩溃收集，生产交付以 Web + Docker 为准。
- 本次未执行 72 小时连续 soak、真实模型供应商付费回归、公网域名/TLS 反代实链与 registry 发布演练；这些属于具体部署环境的上线验收项。
- `DATA_KEY` 丢失无法解密配置，必须独立保管。
- 备份只解决数据恢复，不替代 TLS、主机补丁、供应商账户安全与监控值班。

## 6. 发布结论

代码、镜像、数据恢复、安全边界、自动化测试和运维文档已满足本项目定义的 Level 2 生产门槛。正式上线前，operator 仍需完成：

1. 在目标环境配置 TLS 域名与可信反向代理；
2. 运行一次受控真实模型对话和 provider 故障切换；
3. 将镜像推送到内部 registry 并固定 repository digest；
4. 在目标主机执行一次真实升级/回滚与异机备份恢复；
5. 接入 Prometheus、日志采集、磁盘和备份告警。
