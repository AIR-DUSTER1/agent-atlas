# 工程规范分层与权威索引

> 更新日期：2026-11-18
> 适用范围：agentatlas 全部代码、文档、测试、发布和运维工作。

项目规范不是越集中越好。agentatlas 采用四层结构：常驻红线、领域工作流、深度契约、自动门禁。这样既保证安全规则始终生效，也避免每个任务都加载与当前改动无关的细节。

## 1. 四层模型

| 层级 | 作用 | 存放位置 | 加载时机 |
|---|---|---|---|
| L0 宪法 | 所有任务都必须遵守的不可变红线 | `AGENTS.md` | 每次任务 |
| L1 领域 Skill | 某类改动的实施顺序、检查点和专项测试 | `.agents/skills/agentatlas-*` | 命中任务时 |
| L2 契约文档 | 深度协议、操作手册、故障与发布说明 | `docs/*.md` | Skill 按需引用 |
| L3 自动门禁 | 可由 typecheck、测试、CI 自动拒绝的规则 | `tests/**`、`.github/workflows/ci.yml` | 每次交付 |

原则：

- 安全、权限、路径、数据迁移、架构依赖等高风险红线必须留在 L0，不能只藏在按需 Skill 中。
- 只在某类改动中才需要的步骤放到 L1，避免常驻上下文膨胀。
- 长表格、历史原因、兼容细节和运维手册留在 L2，不放回 `AGENTS.md`。
- 能被测试稳定判断的规则必须进入 L3；文档不能替代门禁。

## 2. 当前规范清单

| 类别 | 核心规则 | 权威位置 | 自动门禁 |
|---|---|---|---|
| 产品边界 | 未交付能力不得写成当前能力；规划与交付分离 | `AGENTS.md`、`docs/agentatlas-roadmap.md` | 文档评审 |
| 技术栈 | TypeScript strict、NodeNext、ESM `.js` 后缀、零 Web 框架、无前端 UI 框架 | `AGENTS.md` | `npm run typecheck`、架构测试 |
| 依赖治理 | 服务端白名单；前端依赖登记版本、许可证、体积；只经 vendor wrapper | 本文 §3、`scripts/build-vendor.ts` | `audit:prod`、构建、架构测试 |
| 目录职责 | Agent / memory / routing 不依赖 server/client；routes 不经手 fs；前端只走 `/api` | 本文 §4、`AGENTS.md` | `architecture.test.ts`、`client-architecture.test.ts` |
| 代码风格 | 中文注释说明为什么；模块 banner；动词命名；输入校验；超时；常量即上限 | `AGENTS.md` | 类型检查、评审、专项测试 |
| 配置与密钥 | `.env < .web-config.json < 内存`；只走 `mergeConfig`；Key 只回掩码 | `AGENTS.md`、`docs/security-and-tls.md` | `config-crypto.test.ts`、路由集成测试 |
| 文件与网络安全 | resolve 后授权校验；SSRF 防线；敏感路径与二进制处理 | `AGENTS.md`、`docs/security-and-tls.md` | `files.test.ts`、`tools-web.test.ts`、安全测试 |
| Agent 与工具 | Profile allowlist；高风险 HITL；错误模型可读；记忆 scope 隔离 | `docs/agent-orchestration.md`、`docs/memory-slot.md` | `tool-isolation.test.ts`、`permission.test.ts`、architecture 测试 |
| HTTP / SSE | 零框架路由；事件四处同步；每轮 `task_usage`；认证与同源防线 | `AGENTS.md`、`docs/agent-orchestration.md` | `server.test.ts`、`stream.test.ts`、`security/http.test.ts` |
| 前端与 UI | 原生 TS、HTML include、CSS 分层、XSS 安全、可访问性、动态降级 | 本文 §5、`AGENTS.md` | `ui-styles.test.ts`、`a11y.test.ts`、E2E |
| 版本与发布 | SemVer、pre-1.0 beta/alpha 阶段、main 合并递增、package 单一来源、buildId、不可变 digest、发布质量门 | `docs/versioning.md` | `versioning.test.ts`、`release-check.test.ts`、`version:main-guard`、镜像 smoke |
| 文档同步 | README 用户视角；wiki 模块与踩坑；内部计划只进 `.plans/` | `AGENTS.md`、`docs/agent-wiki.md` | 评审 + 技能校验 |
| 提交规范 | 单行、`type: `、中文主题、一个提交一个主题、不混合无关变更 | 本文 §7 | 提交前自查 |
| 平台约束 | Windows PowerShell 编码、后台进程、端口、`.cmd` 启动与清理规则 | 本文 §8、`docs/troubleshooting.md` | 平台专项测试、人工验证 |

## 3. 前端依赖登记

新增依赖前先确认标准库、现有依赖或原生能力不能解决。只允许浏览器可直接加载的 ESM、许可证宽松的库；必须实测 esbuild 后的 raw/gzip 体积。

| 依赖 | 用途 | 许可证 | 体积（min / gzip） | 状态 |
|---|---|---|---|---|
| `chart.js` 4.6.1 | 统计页图表 | MIT | 201 KB / 69 KB | 已安装 |
| `lucide` 1.61.0 | 线性图标，按图标具名导入 | ISC | 23 KB / 4 KB | 已安装 |
| `marked` 18.1.1 | Markdown 解析，必须同批使用 DOMPurify | MIT | 45 KB / 14 KB | 已安装 |
| `dompurify` 3.4.17 | 渲染前 HTML 净化 | MPL-2.0 OR Apache-2.0 | 30 KB / 12 KB | 已安装 |
| `highlight.js` 11.12.0 | 按语言子包导入的代码高亮 | BSD-3-Clause | 67 KB / 22 KB | 已安装 |

### 3.1 服务端依赖登记

| 依赖 | 用途 | 约束 |
|---|---|---|
| `pg` | PostgreSQL 多租户持久化、RLS owner 事务 | 仅限 `src/server/persistence/**`、认证/迁移脚本；业务代码不得直接 `new Pool` |
| `@types/pg` | `pg` 类型声明 | 仅 devDependency |
新增 vendor 库时必须同步：`scripts/build-vendor.ts` 入口清单、`src/server/static.ts` 目录白名单、`src/client/vendor/*` wrapper、本文登记表和构建测试。

## 4. 目录与依赖方向

```text
src/
  config.ts / product.ts / versioning.ts / llm.ts
  tools-*.ts                   # 一个主题一个工具集
  agent/                       # LangGraph 图、Profile、审批、路由
    workflow.ts                # 只做稳定 re-export 门面
    workflow/                  # types/state/prompts/parsing/runtime/nodes/edges/graph
  memory/                      # Provider、scope、本地存储、召回
  routing/                     # 路由决策领域层
  server/                      # node:http、SSE、配置、持久化、运维
    routes/                    # HTTP 响应层
    persistence/               # schema 与迁移
  client/
    main.ts                    # 入口与 DOM 接线
    core/                      # state / api / dom / build-info
    pages/                     # 构建期 HTML 片段
    ui/                        # 无业务 DOM 原语
    render/ stream/ composer/  # 渲染、SSE、输入框
    views/ actions/ modules/   # 业务视图、动作、纯函数与协议类型
    vendor/                    # 第三方库唯一隔离层
    styles/                    # token / layout / surface / feature CSS
desktop/                       # Electron 主进程与 preload
docs/                          # 用户和 operator 可读文档
.plans/                        # 内部计划，永不提交
```

必须保持的依赖方向：

- `src/agent/**`、`src/memory/**`、`src/routing/**` 只能依赖 `src/` 顶层和 `@langchain/*`，不得依赖 server/client。
- `src/server/routes/**` 只做 HTTP 协议层，不直接操作文件系统；持久化经 service/store。
- `src/client/**` 只通过 `/api/*` 与服务端通信，不 import 服务端代码。
- 业务前端源码不能直接 import npm 前端库，只能使用 `vendor/*` wrapper。
- 通用消息渲染不得 import 房产或求职实现；业务卡通过增强注册表注入。
- `src/agent/workflow.ts` 保持薄门面；`index.html` 保持根壳和 include；`client/core/state.ts` 是唯一可变前端状态源。

## 5. 前端与 UI 细则

- 前端 TypeScript 必须完整类型化；构建产物进入 `src/server/public/`，不得手改。
- CSS 入口显式加载所有拆分文件；禁止单体 `style.css`、隐式 `@import` 和循环引用。
- 可选能力（图表、Markdown、高亮）必须动态加载，初始化失败继续提供安全 fallback。
- 用户可见文本不得进入 `innerHTML` 模板；优先 `textContent`、`h()`、DOMPurify 白名单。
- 可访问性最低要求：可聚焦、键盘可达、可见焦点、窗体语义、图标按钮可读、对比度 ≥ 4.5:1、live region。
- 页面修改需检查桌面宽屏、窄屏、设置页、弹窗 Esc/遮罩关闭、流式状态和 reduced-motion。
- 版本 meta 由 `npm run build:client` 注入，前端源码禁止手工日期版本。

## 6. 通用交付检查单

所有代码改动至少完成：

1. 确认改动属于哪个领域，并加载对应 `agentatlas-*` Skill。
2. 找到现有同域基线、共享原语、测试和文档，不另造平行实现。
3. 检查安全边界：认证、审批、路径、SSRF、密钥、日志脱敏。
4. 检查数据边界：旧字段兼容、schema 迁移、失败回滚。
5. 检查契约边界：HTTP、SSE、类型、前端消费、桌面端兼容。
6. 运行最小验证，再运行 `AGENTS.md` 的完整质量门。
7. 更新 README 与 `docs/agent-wiki.md`；内部计划只写 `.plans/`。
8. 清点 `git diff`，删除调试代码、临时文件、真实密钥和构建产物。
9. 按单行中文规范提交，一个提交只表达一个主题。

## 7. 提交规范

```text
<type>: <中文主题概括>，<具体变更1>，<具体变更2>，<具体变更3>
```

允许类型：

| 类型 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复、补漏、小范围调整 |
| `refactor` | 5 个以上文件的结构调整或架构/技术方案变化 |
| `style` | 纯样式调整 |
| `i18n` | 国际化 |
| `chore` | 构建、依赖、工具、仓库规范、文档治理 |

强制规则：

- 整条提交信息只能一行，使用半角冒号加一个空格。
- 主题使用中文，末尾不加句号。
- 禁止空行、正文式展开、序号列表和重复主题。
- 不满足 `refactor` 全部条件时使用 `fix`。
- 提交前不得包含 `.env`、`.web-config.json`、`.setting/`、`.plans/`、构建产物或临时密钥。

## 8. 平台与环境坑

- PowerShell 5.1 默认 GBK：含中文脚本必须 UTF-8 BOM，或改全英文。
- Windows 启动 `.cmd`（如 npx）必须 `shell: true`；终止进程树使用 `taskkill /pid <pid> /T /F`。
- 后台服务测试每轮更换端口；结束后按命令行匹配清理 node 孤儿。
- PowerShell 中不要用 curl 手拼复杂 JSON；使用 `Invoke-RestMethod` 或项目测试 helper。
- Web 固定端口 3000、桌面 3123；自动化测试使用 3456+。
- 递归删除或移动前必须先解析并确认绝对路径位于目标工作区或明确临时目录内。

## 9. 规范维护

新增规则时先分类：

- 所有任务都必须遵守且违反会造成安全/数据/架构事故 → `AGENTS.md`。
- 仅一类任务需要的步骤 → 对应 `.agents/skills/agentatlas-*`。
- 长篇协议、命令示例、历史原因和运维手册 → `docs/`。
- 可稳定自动判断 → `tests/` 或 CI。

禁止同时在 `AGENTS.md`、Skill、Wiki 中复制同一长篇规则。Skill 应引用权威文档，并只保留当前任务真正需要的决策信息。

## 10. 当前领域 Skill

| Skill | 适用任务 | 不适用 |
|---|---|---|
| `agentatlas-agent-runtime` | LangGraph、Profile、工具、审批、路由、子代理、记忆 | 纯 UI、纯 endpoints、发布 |
| `agentatlas-service-contract` | HTTP、SSE、配置、持久化、认证、可观测性 | 纯 Agent 图、纯样式 |
| `agentatlas-frontend` | Web UI、HTML、CSS、设置页、可访问性、浏览器构建 | 后端契约、版本发布 |
| `agentatlas-release-ops` | 版本、镜像、部署、备份、生产质量门 | 普通功能开发 |

使用 `npm run skills:check` 校验 Skill 结构、大小、路由与权威文件链接。
