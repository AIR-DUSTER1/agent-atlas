# agentatlas

> **当前状态：`0.9.0-beta.6` 开发预览版。**
> 项目仍有很多功能在完善，接口、数据格式和交互可能继续调整；暂不提供正式版本、Git tag、生产 SLA 或稳定兼容承诺。

一个基于 **LangGraph.js + TypeScript** 的可扩展 Agent 工具集，包含 Web、CLI 和 Electron 桌面壳。当前以通用 Agent 与房产 Agent 为基础，支持由主 Agent 动态赋予提示词和工具的生产级子代理委派。

![agentatlas 主界面](docs/screenshots/main-empty.png)

## 快速开始

环境要求：

- Node.js 24 推荐
- npm 11+
- 可选：Docker 24+、Chrome / Edge

```bash
npm install
cp .env.example .env      # Windows: Copy-Item .env.example .env
npm run web               # http://127.0.0.1:3000
```

不配置模型也能启动。此时使用本地 mock，工具调用、流式输出和审批流程仍可体验。

配置真实模型：

```dotenv
BASE_URL=https://your-gateway.example/v1
API_KEY=your-key
MODEL=your-model
AI_PROTOCOL=openai
```

也可以在页面左下角 **设置 → 模型与供应商** 中配置。修改模型列表前可先运行：

```bash
npm run models
```

其他入口：

```bash
npm run desktop    # Electron 桌面壳
npm start          # CLI 菜单
npm run demo:1     # 运行内置示例
docker compose up -d --build   # 本机 Docker 验收，需设置 AUTH_TOKEN
```

## 当前能力

| 模块 | 当前状态 |
|---|---|
| 通用 Agent | 需求理解、澄清、ReAct 工具循环、结果反思；**需求澄清一次可问多道题**（最多 4 道，逐题作答后一次性提交，缺多项信息时不必来回追问好几轮）；逻辑任务跨审批/澄清/继续累计工作台账，不限制任务时长与工具/模型调用次数，图执行以 1000 超步兜底 |
| 子代理委派 | 主 Agent 通过 `delegate_agent` 指定子代理、任务书、专项提示词与工具子集；子代理默认继承当前主对话模型，也可固定其他已配置模型；独立上下文、父请求取消透传、深度固定 1；可按领域继承提示词（如房产顾问工作流），并在结果里报告超出范围的部分供主 Agent 收尾 |
| 路由决策（默认关闭） | 每条消息先按「规则关键词 → 向量比对（需配置 RAG）→ 决策模型」挑子代理，任一层没把握就转成选项卡询问；模型层默认复用当前「供应商 × 模型」，本机零额外占用；可切换 `systemone` 协议服务或纯规则；聊天里显示可展开的路由卡（目标、依据、来源层、候选打分） |
| 电脑操作（Computer Use 插件） | 截图、点击、双击、右键、文本输入、组合按键与滚轮；仅 Windows，默认关闭，开启后仍受会话权限与高风险审批约束 |
| 模型韧性 | 408/429/5xx/超时/网络错误自动重试（默认 10 次），重试进度默认折叠并展示失败原因；思考型网关（DeepSeek 等）的多步续传自动回传 `reasoning_content`，网关不接受该字段时自动降级重试 |
| 租房 / 房产 Agent | 与通用 Agent 独立工具集、权限和审批边界 |
| 模型供应商 | 多供应商、多模型，支持 OpenAI / Responses / Anthropic / Gemini 协议 |
| 会话 | 新建会话独立开始、SSE 流式输出、多会话并行生成与分别停止、刷新恢复、导出、搜索与清理 |
| 审批与权限 | 人工审批、只读、自主风险评估、自动执行 |
| 记忆 | LangGraph checkpoint、可插拔长期记忆（本地 / HTTP）、Agent scope 隔离、相关性注入、上下文压缩 |
| 文件与项目 | 附件、本地项目系统目录选择、远程文件夹、文件搜索与读取 |
| 扩展 | 设置 → 插件统一启停 RAG / 贝壳 / Computer Use；设置 → 子代理支持搜索筛选，新增、编辑、启停、删除与模型覆盖；MCP（完整命令粘贴解析、Windows npx/npm 兼容、全局暂停、单服务器启停、JSON 导入、连接测试）；技能库（触发词/名称/ID 命中，每轮最多 2 个）；可搜索并管理自定义命令；第三方 Agent |
| 数据 | 本地 journal（usage 归并、截断可审计）、备份恢复、数据检查、使用统计 |
| 桌面端 | 本机便利壳，不是正式桌面发行版 |

这些能力仍有未完成项，尤其是真实供应商兼容、复杂会话恢复、房产 Agent 数据链路和桌面端发行流程。

输入框上方的上下文容量条保留当前会话最近一次主模型请求的 input 用量（不重复叠加 output），分母使用当前模型窗口扣除输出预留与安全余量后的输入预算。历史拼接按 token 预算从新到旧装入，不再受固定 32 条 / 48k 字符限制；切换模型不清空历史，下一轮请求返回 usage 后再校正；缓存命中率统一保留一位小数。若旧上下文超过目标模型可用输入，会先压缩当前上下文，完整聊天记录仍保留。

## 能力路线

agentatlas 后续按“先读后写、先基础设施后业务”的顺序扩展：

| 能力 | 状态 | 说明 |
|---|---|---|
| Hook 生命周期扩展 | 规划中 | 会话 / 回合 / 工具 / 审批事件的可配置 Hook，默认关闭并纳入审计 |
| 电脑操作 Agent | 插件启停已落地 | 将电脑工具收敛为独立 profile，补齐停止、复核与窗口上下文 |
| 获取岗位信息 Agent | 规划中 | 以只读工具聚合岗位来源，保留来源、时间和原始链接，不补造字段 |
| 投递简历 Agent | 规划中 | 独立管理简历与投递记录；外发前强制确认，提交动作必须审批且幂等 |

四类能力的边界、建议模块和落地顺序见 [agentatlas 能力路线](docs/agentatlas-roadmap.md)。路线中的功能在实现与验收前不会出现在“当前能力”表里。

## Agent 隔离

项目刻意保留三套独立的 Agent 能力边界：

| Profile | 入口 | 工具与审批 |
|---|---|---|
| 通用 Agent | 新建对话 → 通用 Agent | 开发工具、文件、RAG、MCP、`general` scope 记忆与协作 |
| 房产 Agent | 新建对话 → 房产 Agent | 贝壳找房工具及对应审批，不加载开发工具；记忆使用独立 `estate` scope，默认不挂记忆工具 |
| 求职 Agent | 新建对话 → 求职岗位 Agent | job-hunter 四平台岗位工具及对应审批，不加载开发 / 找房工具；记忆使用独立 `job` scope |

未添加任何项目时，打开应用或点击「新建对话」会直接进入 Agent 选择页，三类 Agent 固定排在示例前面；已有的未归属会话仍可从侧栏打开。

隔离规则由 `src/agent/profile.ts`、各 profile 的工具 allowlist、审批登记和测试共同维护。通用 Agent 不能直接调用房产工具，房产 Agent 也不能调用终端、写文件等通用工具；插件停用后对应工具会从 allowlist 和审批表中同时移除。

## 子代理

设置 → **子代理** 管理可被主 Agent 委派的运行时子代理：

- 配置项只包含名称、用途说明、启停和模型，不把提示词固定成角色模板；
- 每次 `delegate_agent` 调用由主 Agent 提供完整任务书、专项提示词和工具子集；
- 子代理可使用当前安全目录内的工具，但不能再次委派；长期记忆读写仍由主 Agent 收口；
- 默认继承当前主对话的供应商与模型，也可固定到任意已配置的「供应商 × 模型」；
- 设置页按全部 / 已启用 / 已停用筛选，并显示模型可用性与运行状态；
- 聊天内委派卡在运行中展示目标子代理和授权工具，完成后展示模型、耗时、用量与工具轨迹；
- 每次执行使用独立 threadId / MemorySaver，父请求取消会终止子图，结果以结构化委派卡回填。

委派工具本身仍是审批项。默认审批模式下，用户在卡片里看到目标子代理、任务、工具列表和提示词摘要；批准后子代理在独立上下文中自动执行被授予的工具。

## 求职岗位 Agent

从 [job-hunter](https://github.com/AIR-DUSTER1/job-hunter) 技能封装而来，是一个**独立的会话形态**（新建对话 → 求职岗位 Agent），与通用 / 房产 Agent 工具集和记忆 scope 都隔离。

**能力**：

| 工具 | 作用 | 是否审批 |
|---|---|---|
| `job_collect` | 四平台采集 + 规则打分 + 外包识别 + 导出 Excel | ✅ 会访问招聘站点，约 3-5 分钟 |
| `job_query` | 在已有清单里按关键词/城市/分数/状态筛选 | ❌ 纯本地 |
| `job_enrich` | 补 JD 全文、地址、HR 活跃 | ✅ 会逐条打开岗位页 |
| `job_summary` | 清单概览（总数、外包数、方向/平台分布） | ❌ 纯本地 |

**使用流程**：

1. 「设置 → 插件 → 求职岗位」点「管理数据源」，确认环境就绪（技能目录 / Python 3.10+ / DrissionPage + openpyxl）；
2. 点对应平台的「登录」按钮扫码 —— **BOSS直聘必须登录**，未登录时列表页会被安全校验拦截，一条都拿不到；
3. 回到会话，Agent 会先一次问清**岗位方向 + 城市 + 期望月薪 + 工作年限**四项，再调 `job_collect`；
4. 采集完成后 Agent 给结论（总数、外包条数、方向分布、Top 5），Excel 在数据目录的 `out/` 下。

求职会话和通用 / 房产会话一样，输入框上方有**权限切换**（只读 / 审批 / 自主 / 自动）：
默认「审批」下采集与补详情都会先弹审批卡；切到「只读」时这两个工具会被直接拒绝执行，
只剩 `job_query` / `job_summary` 和计算器可用。

**为什么采集和补详情要分开**：站点风控看的是短时间内请求总量。采集列表每个关键词只要 1-2 次请求，补详情要逐条打开岗位页；混在一起跑大概率被限流。Agent 的提示词里明确要求「刚采集完不要立刻补详情，隔几分钟再补」。

**支持的城市**（技能内置站点编码）：青岛、济南、北京、上海、深圳、杭州、成都。其它城市需要先在技能里补 `CITY_*`，Agent 会如实说明而不是瞎猜。

**数据目录**：默认 `<技能目录>/job-data`，存登录态（`.profile/`）和产出（`out/`）。可用 `JOBHUNT_HOME` 或设置页指定 —— 不设置会写进技能目录，升级技能时登录态就丢了。Excel 里的「投递状态」是下拉框，改动下次采集时**增量合并保留**。

**环境要求**：Python 3.10+（技能用了 `X | None` 联合类型，3.9 运行时会报 `TypeError`）、`DrissionPage==4.1.1.4`、`openpyxl==3.1.5`，以及一个 Chrome 或 Edge（DrissionPage 会自己拉起）。

## 路由决策

设置 → **路由决策** 开启后，每条消息在进入执行前会先判断「该交给哪个子代理」。**默认关闭**，不开启时行为与之前完全一致。

分层管道（任一层都可以弃权，弃权不是错误而是降级）：

| 层 | 做什么 | 代价 |
|---|---|---|
| L1 规则匹配 | 按子代理的「路由名片」关键词与负向词打分；分数足够高且明显领先就直接派发 | 纯本地，< 5 ms，零算力 |
| L2 向量比对 | 仅在**已配置 RAG** 时启用：用专用 `agent-routing` 集合检索候选；未配置则整层跳过 | 一次向量检索 |
| L3 决策模型 | 让模型在候选里选一个，并用置信度与分差守卫判断是否可靠 | 一次短请求 |

守卫规则：目标不在候选白名单、置信度低于阈值、两个候选太接近、或请求同时涉及**两个以上不同子代理**，都会转成一张选项卡请你确认，而不是猜。确认后不再重新路由。

**三种后端**（设置页可切换）：

| 后端 | 说明 | 本机占用 |
|---|---|---|
| `openai-compat`（默认） | 复用已配置的「供应商 × 模型」发一次短请求；也可指向局域网里另一台机器上的 Ollama / vLLM | 0 |
| `systemone` | 对接实现 `POST /v1/systemone` 概率协议的决策服务（Jev-Style / OpenJev 等），返回校准过的概率分布 | 取决于服务部署位置 |
| `rules-only` | 只跑规则层，完全不调模型 | 0 |

**给子代理配路由名片**：设置 → 子代理 → 配置，在「路由名片」里填关键词、类别、适用与不适用场景。关键词或类别**都为空**的子代理不参与自动路由（它是兜底型角色，不会被自动选中）。设置页的「试跑」可以用一段样例请求看它会派给谁，并列出各候选的规则分。

**行为边界**：

- 程序化路由派发只授予**只读工具**；需要写操作时子代理会把需求写进「超出范围」，由主 Agent 走原有审批流程完成，不会绕过审批；
- 子代理报告「超出范围」后最多重新路由一次（设置页可调，上限 3），且不会回到已经试过的子代理；
- 一次请求拆出超过 20 个意图时，会先归并大类再列子任务，生成计划卡片等你确认后才执行；
- 路由失败（模型超时、网关报错、坏输出）一律降级为「当前 Agent 处理」，不会让对话中断。

**隐私口径**：只用 API 后端时，发送给模型的内容仅限**用户本轮消息 + 子代理名称与适用场景**，不包含对话历史、附件内容或工具结果。若要求数据不出本机，请选 `systemone` 指向本机/内网服务，或改用 `rules-only`。

## 技术栈与结构

- `node:http` + SSE，无 Express / Fastify
- 原生 TypeScript 前端，无 React / Vue、无整体打包器
- LangGraph.js 管理 Agent 图与持久检查点
- Electron 仅作为桌面便利壳
- 文件型持久化：配置、journal、checkpoint、记忆和审计

```text
src/
  agent/       LangGraph 图、profile、权限和审批边界
  tools*.ts    基础、开发、RAG、房产、电脑控制和协作工具
  server/      HTTP/SSE、配置、会话、持久化、观测与运维
  client/      原生 TypeScript 前端
  cli.ts       CLI 入口
desktop/       Electron 主进程与 preload
tests/         单元、集成、安全、E2E、故障和负载测试
docs/          用户文档与运维参考
```

详细模块说明见 [docs/agent-wiki.md](docs/agent-wiki.md)。

## 配置与数据

配置来源优先级：

```text
.env  <  .web-config.json  <  运行中内存设置
```

本地默认数据目录：

```text
.setting/
  sessions.ndjson       会话 journal
  checkpoints.ndjson    LangGraph 检查点
  memories.json         长期记忆（schema v2，可导出 / 导入）
  skills/               技能文档
  audit.ndjson          安全审计
```

容器默认使用 `/data`。

常用环境变量：

| 变量 | 说明 |
|---|---|
| `BASE_URL` / `API_KEY` / `MODEL` | 模型网关配置 |
| `AI_PROTOCOL` | `openai` / `openai-responses` / `anthropic` / `gemini` |
| `HOST` / `PORT` | 默认 `127.0.0.1:3000` |
| `AUTH_TOKEN` | 开启登录认证 |
| `PRODUCTION` | 设为 `1` 时启用更严格的生产环境门禁 |
| `SESSION_SECRET` | 生产模式所需的会话签名密钥 |
| `DATA_KEY` | 生产模式所需的配置加密主密钥 |
| `METRICS_TOKEN` | 仅用于 `/metrics` 的只读抓取令牌 |
| `MODEL_REQUEST_TIMEOUT_MS` | 单次模型 HTTP 请求超时，默认 90 秒；审批与工具等待不受此值影响 |
| `MODEL_REQUEST_RETRIES` | 可重试模型错误（408/429/5xx/超时/网络）自动重试次数，默认 10 |
| `MODEL_CONCURRENCY_PER_PROVIDER` | 每个供应商同时进行的模型轮数上限，默认 5（1–50）；超出后进入队列 |
| `MODEL_QUEUE_WAIT_MS` | 并发占满时的排队等待上限，默认 10000 毫秒；超过回 429 + `Retry-After` |

`.env`、`.web-config.json`、`.setting/` 和 `data/` 已加入 gitignore，不要提交。

## 外部程序对接（/api/chat）

Web 界面之外，任何脚本或评测框架都可以直接用 SSE 驱动一轮对话。请求体除 `sessionId`、`message`、`files` 外还支持一个开关：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `headless` | boolean | `false` | 无头模式：需求澄清不再挂起等人，而是采用首个候选选项作为假设继续执行，并把假设写进事件流与工作台账 |

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id>","message":"帮我算一下 17×23","headless":true}'
```

与 token 统计和落地判断相关的两类事件：

| 事件 | 何时发送 | 语义 |
|---|---|---|
| `usage` | 每次模型调用（可能多条，流式分片会合并） | 单次调用的用量快照；同一次调用按 `callId` 归并 |
| `task_usage` | 每轮结束前一条，位于最后一条 `usage` 之后、`done` 之前 | **任务累计用量**：`inputTokens` / `outputTokens` / `toolCalls` / `modelCalls` / `activeMs`；下游统计取这一条即可 |

无头模式自动做假设时，事件流里会出现一条 `clarification_note`，携带原问题（`question`）与被采用的假设（`assumption`），便于调用方判断假设是否合理。

并发方面：单会话同一时刻只允许一条流，超出发送间隔会被拒绝；供应商级并发占满时请求会排队，排队超时返回 **HTTP 429** 与 `Retry-After`（可重试），而不是把它当成请求错误。可以用 `MODEL_CONCURRENCY_PER_PROVIDER` 和 `MODEL_QUEUE_WAIT_MS` 调整。

## 开发与测试

```bash
npm run typecheck       # 三套 TypeScript 配置
npm test                # 单元 / 集成 / 安全 / 故障 / 负载
npm run e2e             # Playwright 浏览器主流程
npm run build:client    # 前端 TS → 浏览器 ESM
npm run build:desktop   # Electron 主进程与 preload
npm run audit:prod      # 生产依赖 high / critical 阻断
npm run data:check      # 配置、journal、checkpoint 与备份检查
```

CI 还包含覆盖率门禁、SBOM、依赖审查和镜像 smoke。当前自动化通过不代表产品功能已经完整，也不构成正式发布承诺。

## 已知限制

- 项目仍是 `pre-1.0` 开发版，暂不打正式 tag。
- API、配置字段、数据 schema 和前端交互仍可能变化。
- 子代理只支持一级父子委派，不实时转发子代理内部 token 流，也没有常驻任务队列或跨进程 worker。
- 单实例、单写者，不支持多副本或共享数据卷。
- 没有多用户账号、RBAC、租户隔离和配额体系。
- 外部模型、MCP、RAG、HTTP 记忆、贝壳 CLI 的可用性取决于第三方服务；HTTP 记忆故障会降级但不阻断聊天。
- 真实供应商、复杂长会话、移动端和桌面安装包仍有待持续完善。
- Electron 桌面壳未完成代码签名、自动更新和崩溃收集。
- 生产相关脚本和文档是“部署前准备”，不是正式生产支持承诺。

## 文档

- [Agent Wiki](docs/agent-wiki.md) —— 架构、模块、调用链与踩坑
- [能力路线](docs/agentatlas-roadmap.md) —— Hook、电脑操作、岗位获取与简历投递的规划边界
- [长期记忆插槽](docs/memory-slot.md) —— 本地 / HTTP Provider、Generic 与 Hindsight 契约、导入导出和故障排查
- [部署与运维总览](docs/deployment.md) —— 自托管、TLS、监控和运维入口
- [开发预览验证快照](docs/readiness-snapshot.md) —— 当前自动化与基础设施验证记录
- [备份与恢复](docs/backup-restore.md)
- [升级与回滚](docs/upgrade-rollback.md)
- [故障排查](docs/troubleshooting.md)
- [支持边界](docs/support.md)
- [请求编排](docs/agent-orchestration.md) / [与 ZCode 对比](docs/agent-orchestration-vs-zcode.md)

## License

MIT
