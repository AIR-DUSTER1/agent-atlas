# 开发预览验证快照

> 版本：`0.9.0-beta.17`
> 状态：**pre-1.0 开发预览**
> 日期：2026-11-19

这是一份开发阶段的自动化与基础设施验证记录，**不是正式生产认证，也不是发布声明**。项目仍有很多功能需要完善，接口、数据 schema 和交互都可能变化。

## 已验证

| 项目 | 结果 |
|---|---|
| TypeScript typecheck | 通过（后端 + 前端 + 桌面端） |
| Node 单元 / 集成 / 安全 / 故障 / 负载测试 | 654 / 654 通过 |
| Playwright 浏览器主流程 | 36 / 36 通过 |
| 关键模块覆盖率门禁 | 通过 |
| 生产依赖 high / critical 审计 | 0 个阻断项 |
| Docker 多阶段镜像 smoke | 健康、版本接口、登录、指标、注销和优雅停止通过；只读容器内 Chrome Headless Shell 双 BrowserContext、Cookie 隔离、持久化上下文与截图通过 |
| 镜像体积预算 | 默认镜像 Docker Desktop 显示 897 MB、rootfs 630.7 MiB；`minimal` target 489 MB 且确认不含浏览器；默认门禁上限 700 MiB |
| 贝壳 CLI Linux 接入 | 容器内按官方 manifest 安装 `linux/amd64` v0.2.28，SHA-256、tar 解压、0755 权限与 `beike --version` 通过 |
| 版本身份检查 | package、lock、README、部署文档与 build-info 一致 |
| 数据检查 | 配置、journal、checkpoint 和备份校验通过 |
| 镜像标签切换演练 | 同一数据卷上 prev → next → prev 可启动 |

## 尚未完成或未验证

- 用户指出的产品功能缺口仍在继续完善。
- 真实模型供应商的长期兼容与付费配额回归。
- 目标域名、真实 TLS 反向代理和公网链路。
- 72 小时以上连续运行与容量 soak。
- 桌面安装包、签名、自动更新和崩溃收集。
- 移动端、复杂长会话和全部房产数据链路。
- 非 `linux/amd64` 镜像；当前内置 Chrome Headless Shell 的 Docker 构建会明确拒绝其它架构。
- 招聘平台的交互式扫码登录仍需要可见浏览器或预置持久化 `.profile`；容器内求职采集使用无头 profile，不会把二维码窗口投射到 Web 页面。
- 正式发布 Git tag、生产 SLA 和稳定兼容承诺。

## 当前结论

代码已有较完整的工程门禁，但产品能力仍处于开发预览阶段。自动化通过只能说明当前测试范围没有回归，不能替代真实用户验收、目标环境部署和长期稳定性验证。


## 工程规范分层验证

| 指标 | 结果 |
|---|---|
| `AGENTS.md` 常驻体积 | 24,418 → 9,991 bytes（-59.1%） |
| 领域 Skill | 4 个，总计 9,718 bytes，按任务加载 |
| Skill 发现 | `codex debug prompt-input` 已识别项目 Skill 根目录与四个 Skill |
| 渐进加载 | 前端任务可见 Skill 描述，但未加载完整前端 Skill 正文 |
| Skill Creator 校验 | 4 / 4 通过 |
| 项目分层校验 | `npm run skills:check` 通过 |
| 分层回归测试 | `project-skills.test.ts` 与架构、版本测试共 32 / 32 通过 |
| 全量回归 | 654 / 654 通过 |
