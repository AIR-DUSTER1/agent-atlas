<h1 align="center">agentatlas</h1>

<p align="center">
  <strong>本地优先、可扩展的多 Agent 工作台</strong><br>
  把模型、工具、审批、记忆与领域 Agent 放进同一个可审计的工作空间。
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="LangGraph.js" src="https://img.shields.io/badge/LangGraph.js-1.x-1C3C3C">
  <img alt="Hono" src="https://img.shields.io/badge/Hono-4.x-E36002">
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3.x-42B883">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-6.x-646CFF">
  <img alt="Version" src="https://img.shields.io/badge/version-0.9.0--beta.25-F59E0B">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2EA043">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#系统架构">系统架构</a> ·
  <a href="#外部程序对接">外部程序对接</a> ·
  <a href="#开发与测试">开发与测试</a> ·
  <a href="#文档">文档</a>
</p>

## 项目简介

agentatlas 是一个基于 **LangGraph.js + TypeScript** 构建的本地优先 Agent 工作台，提供 Web、CLI 和 Electron 三种入口。

它面向需要长期使用、可审计、可扩展 Agent 能力的开发者与专业用户：既可以在不配置模型密钥的情况下体验完整交互，也可以接入 OpenAI、Anthropic、Gemini 兼容网关、外部 MCP Server、RAG（支持本机 / 内网自建向量服务）和 HTTP 记忆服务。

- **Agent 隔离**：通用、房产、求职 Agent 使用独立工具集、审批边界与记忆作用域。
- **人工可控**：只读、审批、自主、自动四种权限模式，高风险操作在执行前拦截。
- **本地优先**：会话、检查点、记忆、审计与备份默认写入本地文件。
- **按需扩展**：插件、技能、自定义命令、MCP 与子代理均可在设置页管理；技能采用渐进式披露——紧凑目录常驻上下文，强相关自动加载全文，其余由模型按需 `use_skill` 取用，技能数量增长不推高每轮 token 开销。

## 核心能力

| 能力 | 说明 |
|---|---|
| Agent 编排 | 需求分析、自主流程、澄清、ReAct 工具循环与结果反思；复杂任务会生成可追踪的执行步骤，并在上下文条上方以默认折叠窗体展示 |
| 多 Agent | 通用、房产、求职三类独立 Agent；主 Agent 可向子代理动态授予模型、提示词和工具子集 |
| 工具系统 | 文件读写、终端、代码检索、RAG、Browser Use、Computer Use、MCP 与业务工具；求职采集支持右侧实时画面（逐平台进度 + 浏览器实况，登录扫码也可视） |
| 模型供应商 | 多供应商、多模型配置，支持 OpenAI Chat、Responses、Anthropic 与 Gemini 协议 |
| 会话与记忆 | 个性化默认上下文、SSE 流式输出、多会话并行、刷新后后台生成继续并恢复「生成中」与停止按钮、后台跑完自动重放消息区、审批决定受理即落档（刷新不重放过期审批卡）、上下文压缩、检查点和本地 / HTTP 长期记忆；上下文条精简展示占比、请求量、缓存与输出均速 |
| 安全与运维 | 高风险审批、审计日志、设备静默认证、用户名密码登录与多用户管理、本地访问密码锁、按设备隔离会话、配置加密、用量统计、备份恢复、Prometheus 指标与可选 LangSmith 链路追踪 |

## 界面预览

<p align="center">
  <img src="docs/screenshots/main-empty.png" alt="agentatlas 主界面" width="100%">
</p>

界面将 Agent 选择、会话管理、模型切换、权限控制与设置中心整合在同一工作台中。左下角设置页集中管理模型与供应商、插件、子代理、路由、记忆与个性化、统计、命令、技能和 MCP。

Browser Use 与 Computer Use 启用后作为平台能力提供给通用、房产和求职主 Agent；三个 Profile 的领域工具与记忆范围仍然独立，不会互相串用。Computer Use 仅在 Windows 本机桌面可用，Docker / 容器部署中固定禁用。

## 快速开始

### 环境要求

- Node.js 24 推荐
- npm 11+
- 可选：Docker 24+、Chrome / Edge（桌面端；Docker 生产镜像已内置无头浏览器）

### 本地启动

```bash
npm install
npm run web
```

打开 <http://127.0.0.1:3000>。

未配置可用供应商或 API Key 时，模型供应商列表保持为空，应用自动进入本地 mock。你仍然可以体验会话、流式输出、工具调用、执行流程和人工审批。

### 接入真实模型

推荐在页面左下角进入 **设置 → 模型与供应商**，添加供应商和模型后再回到会话。

点击「获取列表」会打开多选弹窗：可以搜索模型、全选或全不选、只看已选，分组确认后一次性应用新增与移除。

也可以复制环境变量模板并填写网关信息：

```bash
# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

```dotenv
BASE_URL=https://your-gateway.example/v1
API_KEY=your-api-key
MODEL=your-model
AI_PROTOCOL=openai
```

`AI_PROTOCOL` 支持 `openai`、`openai-responses`、`anthropic` 和 `gemini`。查看网关支持的模型：

```bash
npm run models
```

## 使用方式

1. 点击 **新建对话**，选择通用、房产或求职 Agent。
2. 在输入框附加项目文件、本地文件或远程文件夹，或使用 `@` 搜索项目文件。
3. 根据任务风险切换会话权限：**只读 / 审批 / 自主 / 自动**。
4. 长任务使用 `/goal <任务描述>` 进入连续执行模式。
5. 鼠标移到消息上会显示纯图标复制按钮，可复制用户输入、AI 总结或压缩摘要；操作区与用量保持同一行，思考过程使用无边框箭头展开，流式阶段显示「思考中」状态，工具卡直接显示原始工具名。
6. 打开左下角设置，管理模型、插件、子代理、记忆与个性化、技能、MCP 与使用统计。
7. 房产 Agent 首次使用时，在「设置 → 插件 → 找房数据源」手动打开一次官方登录页；扫码成功后点页面 Key 右侧的「复制」，再点「从剪贴板读取」并保存。登录链接与 CLI 共用宿主真实提供的 `BEIKE_SOURCE`，未设置时回退 `workbuddy`；服务端会用官方 MCP `tools/list` 做业务校验。鉴权失败会展开登录卡并给出下一步说明，不会静默中断。贝壳目前会按调用方 User-Agent 限制部分 Key：WorkBuddy 签发的 Key 需在 WorkBuddy 内使用，不能直接拿到独立 agentatlas 复用。
9. 求职 Agent 首次使用时，在「设置 → 插件 → 求职岗位」检查浏览器并登录 BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘（采集前需确认岗位方向、城市、期望月薪与工作年限四项）。**采集前会自动做登录预检**：BOSS直聘与智联招聘未登录时直接中止并提示去登录，因为未登录时薪资会全部为空、排序不可信；确需先看大概可显式跳过预检。各平台登录方式不同——BOSS 扫码，智联只有手机号 + 短信验证码（页面上没有二维码）。
10. 采集结果会先做相关性过滤与 JD 清洗再入库：讲师、售前、产品经理等非目标岗位即使命中关键词也会被剔除（**按目标方向自适应**，你搜「产品经理」时该词不再生效），所以任何职业方向都能用；JD 尾部的「去App 与BOSS随时沟通」「工作地址」「相似职位」等页面文案会被清掉，避免抄进招呼语。同义方向（Agent开发 / 智能体开发 / 大模型开发）归并为同一方向，只占一页 Excel。
11. 交付的 Excel 含「招呼语」「职位描述」「岗位ID」列：职位描述是清洗后的 JD 全文（行高固定，文本完整保留），岗位ID 是招呼语回写的稳定定位键。招呼语闭环：先由 Agent 生成画像模板 `profile.md`（在求职数据目录，请补全真实经历与量化成果），再导出待写清单并逐条撰写 ≤200 字开场白，写回后进入 Excel 的「招呼语」列。导出时会自动合并同一公司在多个平台发布的重复岗位、有 JD 的排前面；写回时会检查「混入页面文案 / 敬语开头 / 写薪资期望 / 过短」四类质量问题并点名提示。招呼语与投递状态、备注一样在再次采集时增量保留，写回操作执行前会请求审批。

### 房源 Excel 下载契约

| 方法 | 路径 | 鉴权 | 成功响应 |
|---|---|---|---|
| `GET` | `/api/estate/exports/{uuid}` | 与其它 `/api/*` 相同：会话 Cookie；Bearer 部署时也可用 Bearer | `200` + `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`，`Content-Disposition: attachment; filename*=UTF-8''<文件名的 URL 编码>`，正文为 `.xlsx` 字节 |

`uuid` 由 `house_search` 自动导出或 `house_export` 生成；不存在的文件返回 `404 {"error":"Excel 对比文件不存在或已清理，请重新生成"}`。下载地址只接受服务端生成的 UUID，不能把路径参数替换成任意本地文件。


## 系统架构

```mermaid
flowchart LR
    UI["Vue 3 + Pinia Web / CLI / Desktop"] --> APP["Hono App + Middleware"]
    APP --> ROUTES["领域路由 + streamSSE"]
    ROUTES --> WF["LangGraph Agent Workflow"]
    WF --> PROFILE["Agent Profile 边界"]
    PROFILE --> GENERAL["通用 Agent"]
    PROFILE --> ESTATE["房产 Agent"]
    PROFILE --> JOB["求职 Agent"]
    WF --> SUBAGENT["动态子代理"]
    WF --> TOOLS["工具层"]
    TOOLS --> DEV["文件 / 终端 / 浏览器 / 电脑控制"]
    TOOLS --> EXT["RAG / MCP / 技能 / 自定义命令"]
    WF --> MODEL["多供应商模型层"]
    ROUTES --> DATA["会话 / 个性化 / 记忆 / 审计 / 统计"]
    DATA --> STORE[("本地文件、PostgreSQL 或 Docker 数据卷")]
```

设计原则：

- Agent Profile 决定可调用工具和审批项，通用 Agent 与业务 Agent 不共享越界能力。
- 只读工具直接执行，会改变外部状态的工具必须经过权限策略或人工审批。
- 模型、工具、审批结果和关键副作用进入会话回放、journal 或审计链路。
- Hono 统一承载路由、SSE 与认证、安全头、限流、请求上下文等中间件；领域层不依赖 Hono 或 Vue。

## 技术栈

| 层级 | 技术选型 |
|---|---|
| Agent Runtime | LangGraph.js、TypeScript strict、NodeNext |
| Service | Hono、`@hono/node-server`、`zValidator` 兼容请求校验、`streamSSE` |
| Frontend | Vue 3 SFC、Pinia、antdv-next、Vite；保留现有 CSS token 体系 |
| Desktop | Electron 桌面壳 |
| Storage | JSONL journal / checkpoint、长期记忆目录、加密配置、PostgreSQL 多用户、备份 |
| Test | Node Test、Vitest、Playwright、故障注入、安全与负载测试 |
| Deploy | Docker Compose、TLS 反向代理、Prometheus 指标 |

## 项目结构

```text
src/
  agent/          LangGraph 图、Agent Profile、权限与工具边界
    workflow.ts   稳定的工作流公共门面
    workflow/     状态、提示词、解析、运行时、节点、边与图装配
  client/
    views/       页面目录；每页 SFC、legacy 桥与 Vue 挂载模块同目录
    stores/      Pinia 状态切片
    modules/     协议类型与无框架纯函数
    core/        API、DOM 与共享状态兼容层
    stream/      SSE 解析、消息事件与会话回合
    render/      Markdown、工具卡与业务增强渲染
    ui/          Vue/legacy 共享交互原语
    styles/      token、页面样式与设置分区样式
  server/
    index.ts     进程启动、监听与优雅退出
    app.ts       Hono 应用组装、中间件栈与路由挂载
    routes/      按领域拆分的 HTTP 端点
    persistence/ journal、checkpoint、迁移与多用户存储
    security/    认证、设备身份、限流与密码学
    observability/ 指标、日志、诊断与追踪
  tools-*.ts      各领域工具集
  llm.ts          多协议模型工厂
  config.ts       运行时配置
  cli.ts          CLI 入口

desktop/          Electron 主进程与 preload
docs/             功能介绍、部署、记忆、安全与运维文档
tests/            单元、Vue 组件、集成、安全、E2E、故障与负载测试
scripts/          构建、检查、备份与发布辅助脚本
```

维护边界：`src/client/index.html` 是唯一 Vite 入口，页面片段与 `scripts/compose-html.ts` 已退役；`npm run build:client` 由 `scripts/build-web.ts` 负责注入构建身份、校验 CSP、调用 Vite 并复制分层样式。`src/client/views/` 根目录不得放文件，新页面必须使用 Vue SFC；`src/server/app.ts` 负责 Hono 路由组装，`src/server/index.ts` 主要负责启动、监听与优雅退出。`src/agent/workflow.ts` 继续作为稳定公共门面，具体节点在 `src/agent/workflow/nodes/`。

## 访问与设备隔离

- 本机 `127.0.0.1` 直连自动建立设备会话，不再弹出令牌框。
- 公网新设备首次输入一次 `AUTH_TOKEN`，之后设备 Cookie 自动续期；短期会话过期不会要求重新输入。
- 会话、审批记录、导出、统计与 Browser Use 都按设备隔离；拿到其他设备的 `sessionId` 也无法读取。
- 浏览器无法读取真实 MAC，因此这里使用服务端签名的设备 Cookie，而不是伪造“MAC 认证”。清除站点数据或换浏览器会生成新设备身份。

## PostgreSQL 多用户模式

默认 `STATE_BACKEND=file` 仍适合本地/桌面端。需要多个真实用户互不可见时，启用：

```env
STATE_BACKEND=postgres
DATABASE_URL=postgresql://agent_app:APP_PASSWORD@postgres:5432/agentatlas
DATABASE_ADMIN_URL=postgresql://agent:ADMIN_PASSWORD@postgres:5432/agentatlas
```

- **数据库模式一律强制登录**（与 `AUTH_TOKEN` 是否为空无关），首次打开页面即弹「用户名 + 密码」登录页，不再是令牌配对框。
- 首次启动会自动给 `admin` 建一个初始密码：设了 `BOOTSTRAP_ADMIN_PASSWORD` 就用它（弱密码启动即报错），否则生成随机密码写入 `<数据目录>/bootstrap-admin-password.txt`（0600），也可用 `BOOTSTRAP_ADMIN_PASSWORD_FILE` 指向挂载的 secret 文件。密码只在该文件里，不进日志。
- 首次登录强制改密；之后一切以用户名密码为准，`AUTH_TOKEN` 只作为运维救援通道。
- 用户用「用户名 + 密码」登录；管理员在「设置 → 账号与安全」创建用户、重置密码、管理访问令牌（CLI 通道 `npm run user:create -- --name Alice` 仍可用）。
- 首登或密码被重置后强制改密；修改密码会使该用户全部会话与设备免登失效。
- 连续 10 次登录失败锁定账户 15 分钟；IP 维度另有 5 次 / 15 分钟限流。
- 会话、审批、checkpoint、项目和统计由 `userId` 隔离，数据库表启用 RLS。
- 供应商、插件、MCP、技能、备份和诊断配置只允许管理员修改。
- 当前仍是单实例运行，SSE、限流和内存流锁尚未迁移到多实例。

文件模式的本地访问密码锁在「设置 → 账号与安全」开启：设置后新设备配对需输入访问密码；忘记密码在本机运行 `npm run lock:clear`。

完整部署、角色权限、备份和回滚说明见 [PostgreSQL 多用户与 RLS](docs/postgres-multitenant.md)。
## 配置说明

常用环境变量：

| 变量 | 说明 |
|---|---|
| `BASE_URL` / `API_KEY` / `MODEL` | 模型网关地址、密钥与默认模型 |
| `AI_PROTOCOL` | `openai` / `openai-responses` / `anthropic` / `gemini` |
| `HOST` / `PORT` | 监听地址与端口，默认 `127.0.0.1:3000` |
| `AUTH_TOKEN` | 文件模式为首次配对令牌；PostgreSQL 模式为运维救援密钥（登录本身用用户名密码） |
| `BOOTSTRAP_ADMIN_USERNAME` | bootstrap 管理员登录名，默认 `admin` |
| `BOOTSTRAP_ADMIN_NAME` | bootstrap 管理员显示名，默认「管理员」 |
| `BOOTSTRAP_ADMIN_PASSWORD` / `_FILE` | PostgreSQL 模式首次启动的初始管理员密码（不设则随机生成写 0600 文件） |
| `STATE_BACKEND` / `DATABASE_URL` / `DATABASE_ADMIN_URL` | 可选 PostgreSQL 多用户后端与迁移/运行角色 |
| `PRODUCTION` | 设为 `1` 时启用生产启动门禁 |
| `SESSION_SECRET` / `DATA_KEY` | 生产会话与设备凭据签名、配置加密密钥 |
| `DEVICE_TTL_DAYS` | 已配对设备凭据有效期，默认 180 天（1–365） |
| `METRICS_TOKEN` | Prometheus 指标端点的只读令牌 |
| `MODEL_REQUEST_TIMEOUT_MS` | 单次模型请求超时，默认 90 秒；审批与工具等待不受此值影响 |
| `MODEL_REQUEST_RETRIES` | 可重试模型错误的自动重试次数，默认 10 |
| `MODEL_CONCURRENCY_PER_PROVIDER` | 每个供应商同时进行的模型轮数上限，默认 5（1–50） |
| `MODEL_QUEUE_WAIT_MS` | 并发占满时的排队等待上限，默认 10000 毫秒；超过回 429 + `Retry-After` |
| `BROWSER_USE_EXECUTABLE_PATH` | 指定浏览器路径；桌面端未设置时自动探测，生产镜像默认指向内置 Chrome Headless Shell |
| `BROWSER_USE_CONTAINER` | 仅隔离容器内设为 `1`，追加 `--no-sandbox` / `--disable-gpu`；桌面端不要设置 |
| `MEMORY_STORE_DIR` | 长期记忆 v3 目录；默认 `.setting/memory-store`，测试与容器可覆盖 |
| `JOB_DATA_DIR` | 求职数据根目录；本地留空为 `.setting/job-data`，容器默认 `/data/job-data` |
| `JOB_BROWSER_HEADLESS` | 求职采集无头模式；显式 `1` / `0` 覆盖，Linux 无显示服务器时自动无头 |
| `BEIKE_INSTALL_DIR` | 贝壳 CLI 自动安装目录；容器默认 `/data/tools/beike` |
| `BEIKE_USER_HOME` | 贝壳 CLI 的 HOME；Key 保存到 `<HOME>/.beike/BEIKE_MCP_API_KEY`，容器默认 `/data/beike-home` |
| `BEIKE_CLI_PATH` | 可选；指定已授权、已挂载的官方 `beike` 二进制，优先级最高 |
| `BEIKE_SOURCE` | 贝壳来源标识；登录链接与 CLI 调用保持一致，默认 `workbuddy` |
| `MAP_PROVIDER` | 结论地图提供方：`amap` / `tencent` / `baidu` / `osm` / `custom`，默认 `amap` |
| `AMAP_WEB_SERVICE_KEY` | 高德 Web 服务 Key；仅服务端静态地图代理使用，不下发浏览器，失败自动回退原生瓦片 |
| `TENCENT_MAP_KEY` | 腾讯位置服务 WebService Key；仅服务端静态图代理使用，按服务器出口 IP 设置白名单 |
| `BAIDU_MAP_AK` | 百度地图服务端 AK；仅服务端静态图代理使用，按服务器出口 IP 设置白名单 |
| `MAP_TILE_URL` | 自定义/覆盖瓦片模板，支持 `{s}`、`{x}`、`{y}`、`{z}` |
| `MAP_COORDINATE_SYSTEM` / `MAP_PROJECTION` / `MAP_Y_AXIS` | 坐标系（`wgs84`/`gcj02`/`bd09`）、投影（`web-mercator`/`baidu`）与 y 轴（`xyz`/`tms`） |

完整样例见 [.env.example](.env.example) 和 [production.env.example](production.env.example)。

## Docker 部署

本机构建验收：

```powershell
$env:AUTH_TOKEN = "replace-with-a-long-random-token"
docker compose up -d --build
```

生产镜像默认内置 Chrome Headless Shell，镜像 smoke 会在只读容器内验证两个隔离 BrowserContext、Cookie 隔离、持久化上下文和真实截图。本次 Docker Desktop 验收为 `docker images` 897 MB / rootfs 630.7 MiB；预算门禁默认 700 MiB。明确不使用 Browser Use 时可构建无浏览器瘦镜像：

```bash
docker build --target minimal -t agentatlas:minimal .
```

正式部署、TLS、密钥生成、监控和回滚流程参见：

- [自托管指南](docs/self-hosting.md)
- [生产检查单](docs/production-checklist.md)
- [安全与 TLS](docs/security-and-tls.md)
- [备份与恢复](docs/backup-restore.md)

## 外部程序对接

Web 界面之外，脚本或评测框架可以直接用 SSE 驱动一轮对话。

```bash
# 1) 建会话（返回 session.id）
curl -X POST http://127.0.0.1:3000/api/sessions \
  -H 'Content-Type: application/json' -d '{"kind":"agent"}'

# 2) 发消息并消费 SSE
curl -N -X POST http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id>","message":"帮我算一下 17×23","headless":true}'
```

请求体除 `sessionId`、`message`、`files` 外还支持：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `headless` | boolean | `false` | 无头模式：需求澄清不挂起等人，采用首个候选选项作为假设继续，并把假设写进事件流 |
| `continuous` | boolean | `false` | 连续工作模式：任务未完成就持续回炉，等价于界面里的 `/goal` |

与统计和落地判断相关的事件：

| 事件 | 何时发送 | 语义 |
|---|---|---|
| `usage` | 每次模型调用（可能多条，流式分片会合并） | 单次调用用量快照，同一次调用按 `callId` 归并 |
| `task_usage` | 每轮结束前一条，位于最后一条 `usage` 之后、`done` 之前 | **任务累计用量**：`inputTokens` / `outputTokens` / `toolCalls` / `modelCalls` / `activeMs`；下游统计取这一条即可 |
| `clarification_note` | 无头模式自动做假设时 | 携带原问题 `question` 与被采用的假设 `assumption`，便于调用方判断假设是否合理 |

并发语义：单会话同一时刻只允许一条流；供应商级并发占满时请求进入队列，排队超时返回 **HTTP 429** 与 `Retry-After`（可重试，不要当成请求错误）。可用 `MODEL_CONCURRENCY_PER_PROVIDER` 与 `MODEL_QUEUE_WAIT_MS` 调整。

## 版本与发布

当前为 `0.9.0-beta.25` 开发预览。`package.json.version` 是唯一产品版本源，前端、健康探针、诊断和镜像都使用自动生成的构建身份，不再手工维护日期版本。

```text
0.9.0-beta.25 · 构建标识由当前提交自动生成
```

- 每次合并到 `main` 都必须提升版本：beta/rc 线路递增 `N`，alpha 不得直接进入 `main`。
- `0.7.x` 是同一功能线的小功能点/修复；`0.x.0` 是新的大功能组，可能包含破坏性调整；`x.0.0` 才是正式主版本。
- 当前阶段不创建 Git tag；达到发布条件后使用 `v0.9.0-beta.25` 形式。
- `/healthz`、`/readyz` 与 `/api/version` 会返回版本、渠道、提交和 buildId。
- 生产镜像使用不可变 digest，不使用 `latest`。
- 版本规则由 `npm run version:check` 与 `npm run version:main-guard` 执行；开发规范维护在 `.plans/development-docs/versioning.md`（不提交）。

## 开发与测试

```bash
npm run typecheck       # 后端、Vue 前端与桌面端三套 TypeScript 检查
npm test                # Node Test 单元、集成、安全、故障与负载测试
npm run test:vue        # Vitest + Vue Test Utils 组件测试
npm run e2e             # Playwright 浏览器主流程
npm run browser:smoke   # 当前环境 Chrome 的多上下文、Cookie 隔离与持久化 smoke
npm run build:client    # Vite 构建浏览器产物并执行 CSP/资产自检
npm run build:desktop   # 构建 Electron 主进程、启动原语与 preload
npm run desktop         # 启动桌面端；自动处理端口冲突与退出清理
npm run audit:prod      # 检查生产依赖高危漏洞
npm run data:check      # 校验配置、journal、checkpoint 与备份
npm run version:check   # 校验产品版本、构建身份与文档是否漂移
npm run version:main-guard # main 合并前校验 beta/rc 递增与 alpha 隔离（需 VERSION_BASE_REF）
npm run skills:check    # 校验 AGENTS 常驻预算与项目级 Skill 分层
```

提交前至少执行：

```bash
npm run typecheck
npm test
npm run build:client
```

## 文档

| 文档 | 内容 |
|---|---|
| [功能 Wiki](docs/product-wiki.md) | 当前版本功能地图、操作路径、扩展能力与能力边界 |
| [LangSmith 链路追踪](docs/langsmith-tracing.md) | 可选追踪配置、数据流向、脱敏范围与关闭方式 |
| [记忆与个性化](docs/memory-slot.md) | 个性化默认上下文、本地 / HTTP Provider、作用域与故障排查 |
| [部署与运维](docs/deployment.md) | 自托管、监控、升级与运行手册 |
| [快速自托管](docs/self-hosting.md) | 准备生产环境、启动、自检与数据目录 |
| [安全与 TLS](docs/security-and-tls.md) | 设备身份、反向代理、TLS 与数据边界 |
| [备份与恢复](docs/backup-restore.md) | 备份、校验、恢复与灾难恢复顺序 |
| [监控与告警](docs/monitoring.md) | 探针、Prometheus、日志与审计 |
| [故障排查](docs/troubleshooting.md) | 启动、登录、SSE、配置与数据问题 |
| [升级与回滚](docs/upgrade-rollback.md) | 发布约定、升级步骤与回滚决策 |
| [PostgreSQL 多用户](docs/postgres-multitenant.md) | userId、RLS、角色、备份与验收 |
| [生产检查单](docs/production-checklist.md) | 上线前安全、数据、资源与质量门 |
| [运行手册](docs/runbook.md) | 磁盘、配置、MCP、认证与 SSE 故障处置 |
| [支持边界](docs/support.md) | 支持范围、安全报告与维护责任 |

## 贡献

1. 修改前阅读 [AGENTS.md](AGENTS.md)，按任务加载 `.agents/skills/agentatlas-*`；开发设计、评测和工程规范维护在本地 `.plans/development-docs/`，不提交。
2. 一个提交只处理一个主题，提交信息保持单行中文格式。
3. 新功能同步补充类型、审批边界、测试与用户文档。
4. 不提交 `.env`、`.web-config.json`、`.setting/`、`data/` 或任何真实密钥。

## License

MIT
