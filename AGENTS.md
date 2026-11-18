# AGENTS.md — agentatlas 常驻工程宪法

> 本文件是 L0 常驻红线，只放所有任务都必须遵守、且违反后会造成安全、数据、架构或交付事故的规则。
> 任务操作步骤放在 `.agents/skills/agentatlas-*`，长篇契约和命令手册放在 `docs/`，可自动判断的规则放在 `tests/`。
> 完整分层索引见 `docs/engineering-standards.md`；与本文件冲突时，以本文件为准。

## 1. 项目定位与产品边界

agentatlas 是 LangGraph.js（TypeScript）实现的本地优先 Agent 工作台，包含 Web、CLI、Electron 和单实例自托管部署。

- 未交付能力不得在 README「当前能力」中冒充已完成。
- 通用、房产、求职 Agent 必须保持 Profile、工具 allowlist、审批与记忆 scope 隔离。
- 当前生产边界是单实例、一个 `/data` 写者；不得暗示已支持多实例或集群高可用。

## 2. 规范分层与 Skill 路由

| 任务 | 使用 Skill | 权威文档 |
|---|---|---|
| LangGraph、Profile、工具、审批、路由、子代理、记忆 | `$agentatlas-agent-runtime` | `docs/agent-orchestration.md`、`docs/memory-slot.md` |
| HTTP、SSE、配置、持久化、认证、可观测性 | `$agentatlas-service-contract` | `docs/agent-orchestration.md`、`docs/security-and-tls.md` |
| Web UI、HTML、CSS、设置页、可访问性、浏览器构建 | `$agentatlas-frontend` | `docs/engineering-standards.md` |
| 版本、Docker、部署、备份恢复、生产发布 | `$agentatlas-release-ops` | `docs/versioning.md`、`docs/deployment.md` |

规则：

- 本文件始终生效；Skill 只补充任务流程，不得覆盖 L0 红线。
- 一个任务跨越多个领域时可以组合 Skill，但不得复制出第三套规则。
- 新增规则先分类：常驻红线、领域 Skill、深度文档或自动测试；禁止把长篇流程继续塞回本文件。

## 3. 技术栈红线

| 约束 | 说明 |
|---|---|
| TypeScript | `strict` + `NodeNext` + `noEmit`；服务端 ESM import 必须带 `.js` 后缀 |
| 后端 | `node:http` + SSE，零 Express/Fastify 等 Web 框架 |
| 前端 | 原生 TypeScript，禁止 React/Vue/Svelte、Vite/Webpack/Tailwind CLI 和 UI 框架 |
| 前端依赖 | 必须登记版本、许可证和体积，只能经 `src/client/vendor/*` wrapper 使用 |
| 服务端依赖 | 遵守运行时白名单；新增依赖前先证明标准库/现有依赖不可行 |
| 执行方式 | TS 使用 `tsx` 直跑；新增脚本必须能被 `tsx` 直接执行 |
| 可选前端能力 | 图表、Markdown、高亮必须动态加载且有降级路径，不得进入首屏启动闭包 |
| 可访问性 | 图标按钮和表单必须有可访问名称；正文对比度 ≥ 4.5:1；流式区使用 live region |

详细依赖登记和体积见 `docs/engineering-standards.md`。

## 4. 架构与目录边界

```text
src/agent/**      LangGraph、Profile、审批、路由；禁止 import server/client
src/memory/**     记忆领域；禁止 import server/client
src/routing/**    路由决策领域；禁止 import server/client
src/server/**     HTTP/SSE/持久化/运维；routes 不得直接操作 fs
src/client/**     前端；只能通过 /api/* 与服务端通信
src/client/vendor 第三方库唯一隔离层
src/versioning.ts 产品版本、构建标识与发布一致性权威工具
desktop/**        Electron 主进程与 preload
docs/**           用户与 operator 的深度契约
.plans/**         内部计划，gitignore，永不提交
```

必须保持：

- `src/agent/workflow.ts` 只做稳定 re-export 门面；节点在 `workflow/nodes/`，图接线在 `workflow/graph.ts`。
- `src/client/index.html` 只保留根壳、CSP、build-info 注入点和 include 清单；页面片段在 `pages/`。
- `src/client/core/state.ts` 是前端唯一可变状态源；不能让多个模块各存状态副本。
- 通用消息渲染不得 import 房产/求职实现；业务专属卡通过增强注册表注入。
- 单文件只做一件事；超过约 500 行时先判断是否混合了多个职责。

## 5. 代码风格

1. 注释统一中文，解释为什么、契约和踩过的坑；模块头必须有职责 banner。
2. 文件名小写连字符；函数动词开头；类型 PascalCase；常量全大写。
3. 请求和工具参数必须校验，错误信息中文且说明缺什么、怎么改。
4. 网络调用必须带 `AbortSignal.timeout(ms)`；后台 fire-and-forget 必须自行捕获异常。
5. 截断、条数、超时、递归等限制定义成模块顶部有注释的 `UPPER_SNAKE` 常量。
6. 不写无意义注释、装饰性 emoji、注释掉的代码块或静默吞错。

## 6. 横切红线

### 6.1 配置与密钥

- 配置优先级：`.env < .web-config.json < 运行中内存`。
- 写入只能走 `config-store.ts` 的 `mergeConfig`；运行时修改后必须 `await persist()`。
- API Key 只回传掩码；编辑留空表示保持，空串表示清除。
- `.env`、`.web-config.json`、`.setting/`、`data/` 和任何真实密钥永不入库。

### 6.2 文件与网络安全

- 文件访问只走 `files.ts`：先 `resolve`，再 `assertAuthorized`，再处理二进制、超长截断和敏感路径。
- 外部 URL 必须经过统一 SSRF 防线；不得信任前端传来的路径、域名或协议。
- 日志不得记录 prompt、对话正文、Cookie、Authorization、Key 或未脱敏的用户资料。
- 用户内容不得直接拼进 `innerHTML`；使用 `textContent`、`h()` 或 DOMPurify 安全路径。

### 6.3 HTTP 与 SSE

- 新路由必须在 `index.ts` 的顺序分发中接入，保持 `readBody -> await 业务 -> writeHead`。
- async 业务在路由中必须 `await`；`JSON.stringify(Promise)` 会静默得到 `{}`，不能把 Promise 当数据返回。
- 新 SSE 事件必须同步：`server/events.ts`、产出端、`client/stream/events.ts`、`client/modules/types-api.ts`。
- 每轮结束必须发送 `task_usage`，位置在最后一条 `usage` 后、`done` 前；`usage` 不可替代任务累计。
- 会 `interrupt()` 的新节点必须处理无头模式，否则无人应答的批处理会挂起。

### 6.4 Agent、工具与审批

- 每个工具必须属于明确的 Profile allowlist；不得恢复跨领域全局工具表。
- 执行命令、写文件、安装、发消息、浏览器写操作、电脑控制等改世界动作必须在 `agent/hitl.ts` 登记审批。
- 工具失败返回模型可读的中文文本或 `{ error }`，不要 throw 穿透图。
- 子代理工具集只能缩小，不能扩大主 Agent 的授权。
- 记忆按 Profile scope 隔离；子代理不直接写长期记忆；敏感内容默认拒绝。

### 6.5 思考型网关

- DeepSeek 等思考网关的 `reasoning_content` 回传只能在 `reasoning-passthrough.ts` 与 `llm.ts` 的 fetch 边界实现。
- 只对 `protocol === "openai"` 生效；其他层只登记历史 reasoning，不重复实现透明回传。

### 6.6 扩展机制

| 机制 | 是否执行代码 | 风险边界 |
|---|---|---|
| `.setting/skills/*.md` | 否 | 只影响提示词 |
| `.setting/commands.json` | 否 | 只填提示词模板 |
| MCP Server | 是 | 第三方代码，工具默认登记审批 |
| Hook | 规划中 | 落地时默认关闭、授权、超时、递归和审计 |

能做成文档或模板的扩展，不得升级成可执行代码。

### 6.7 版本与发布

- `package.json.version` 是唯一产品版本源；前端、健康探针、镜像和文档必须使用同一 build-info。
- 不得手工维护前端日期版本；API 版本与数据 schema 版本独立于产品版本。
- 未经用户明确授权，不 push、不创建/移动 tag、不推送镜像、不修改生产环境。
- 生产镜像固定 digest；禁止 `latest`；发布规则见 `docs/versioning.md`。

## 7. 交付协议

### 7.1 质量门

```bash
npm run skills:check
npm run version:check
npm run typecheck
npm run build:client
npm run build:desktop
npm test
```

前端、部署或发布相关改动按 Skill 指引补充 E2E、审计、数据检查与镜像 smoke。存在阻断项时必须如实报告，不能用静态检查冒充运行验证。

### 7.2 文档同步

- 用户可见能力或使用方式变化：更新 `README.md`。
- 模块职责、调用链或踩坑变化：更新 `docs/agent-wiki.md`。
- 深度契约变化：更新对应 `docs/*.md`。
- 开发计划、攻面分析和交接：只写 `.plans/`，永不提交。
- 未完成能力不得写成已交付。

### 7.3 提交规范

整个提交信息只能一行：

```text
<type>: <中文主题概括>，<具体变更1>，<具体变更2>
```

- 类型后使用半角冒号加一个空格。
- 一个提交只表达一个主题；中文主题末尾不加句号。
- `refactor` 仅用于 5 个以上文件且改变架构/目录/技术方案；其余使用 `fix`。
- 禁止多行、正文式展开、空行分隔、序号列表和重复主题。
- 提交前清点 `git status` 与 `git diff`，不得包含密钥、临时文件、`.plans/`、构建产物或无关改动。

详细类型表和示例见 `docs/engineering-standards.md` §7。

## 8. 平台约束

- Windows PowerShell 5.1 的含中文脚本必须使用 UTF-8 BOM，或改为全英文。
- Windows 启动 `.cmd` 必须 `shell: true`；终止进程树使用 `taskkill /pid <pid> /T /F`。
- 后台服务测试每轮更换端口，结束后清理 node 孤儿和临时数据。
- 递归删除或移动前必须确认解析后的绝对路径位于目标工作区或明确临时目录。
- Web 端口 3000、桌面 3123，自动化使用 3456+，不得抢占用户日常进程。

## 9. 规范治理

新增或修改规范时：

1. 判断是否属于 L0、L1、L2 或 L3。
2. 能由测试稳定判断的，写测试，不只写文档。
3. 只在权威位置维护一次，其他地方链接引用。
4. 修改领域流程时同步对应 `agentatlas-*` Skill。
5. 修改 Skill 后运行 `npm run skills:check`，并确认描述能准确路由、不会吸引无关任务。
