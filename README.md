# LangGraph Agent 工作台

一个用 **LangGraph.js**（TypeScript）搭建的**可正常使用的 Agent Web 应用 + 桌面端**：
多轮对话、需求理解与澄清、📎 文件上下文（项目文件 / 远程文件夹 / 本地上传）、多供应商模型切换、
上下文用量与缓存监控、高风险操作人工审批、📚 外部 RAG 知识库 —— 与正常 Agent 产品的使用逻辑一致。

项目同时内置 **5 个学习示例**（基础 ReAct / 对话记忆 / 人工审批 / 多 Agent 协作 / 并行 map-reduce），
其中前 4 个可在新建对话与欢迎页选择，Demo 5 通过 CLI 运行：默认走通用 Agent，
想观察某个特定图结构的运行方式时再选对应示例。每个示例文件都带详细中文注释。

> 📖 **完整学习文档见 [`docs/agent-wiki.md`](docs/agent-wiki.md)** —— 核心概念讲解、
> 模块功能详解、示例的调用链分析（含实测日志）、从零自建 Agent 模板。
>
> 🧭 **端到端编排见 [`docs/agent-orchestration.md`](docs/agent-orchestration.md)** ——
> 从 HTTP 请求、选图、需求理解 / 澄清、ReAct 工具循环、结果反思、人工审批到 SSE、
> 持久化与上下文压缩。

## 快速开始

```bash
npm install
cp .env.example .env        # 填入你的 BASE_URL / API_KEY / MODEL
npm run models              # 先确认网关支持哪些模型（防止 400 报错）
npm run web                 # 启动 Web 界面 → http://localhost:3000
npm run desktop             # 或启动桌面端（Electron 壳，默认端口 3123）
npm test                    # 单元 / 集成 / 安全测试（node:test，全程 mock，不耗真实配额）

# 或容器部署（需要 Docker；先设置 AUTH_TOKEN，详见 docs/deployment.md）
docker compose up -d --build
```

> 💡 **没有 API Key？** 也能跑：未配置 `API_KEY` 时自动进入**模拟模式** ——
> 模型决策由本地脚本编排，但工具调用、流式输出、人工审批等交互全部真实可玩。
> 也可以不建 `.env`，启动后在网页右上角 **⚙ 设置** 里添加供应商并填入 Key。

## Web 界面（参考 ZCode）

```bash
npm run web                 # http://localhost:3000（PORT 环境变量可改端口）
```

- **左侧会话栏**：多会话管理，每个会话绑定一个 Demo（图实例 + thread_id）；
- **模型切换与思考等级**：顶栏 ▾ 按供应商分组列出**所有**已添加的模型，点一行即切换；
  菜单顶部是当前模型的「思考等级」档位（档位随供应商划分方式变化，见下文）；
- **流式回答**：token 级打字机输出 + Markdown 渲染（表格 / 代码块 / 引用）；
- **工具调用卡片**：参数随模型生成逐字流出，完成后展示结果，可展开查看（同 ZCode 的工具块）；
- **节点徽章**：`🧭 analyze` / `❓ clarify` / `🧠 agent` / `🔧 tools` / `🔎 review` /
  `👔 supervisor` / `🔍 researcher/agent`，图的执行轨迹一目了然；
- **项目文件夹（本地 / 云端）**：侧栏「项目 ▾」可选项目，会话按项目分组显示；
  项目分两类并用样式区分 —— **💻 本地**（服务器上的目录）与
  **☁️ 云端**（Git 仓库地址，添加时自动 `git clone --depth 1` 到本地缓存，
  支持一键 `git pull` 刷新，删除时清理缓存）；新建对话归属当前项目；
- **文件上下文（📎）**：给消息附加文件，三种来源 ——
  **项目文件**（浏览项目目录树勾选，位置下拉带 💻/☁️ 标记）、
  **远程文件夹**（授权服务器上的任意目录）、
  **本地上传 / 拖拽 / 粘贴**（支持文本文件与**图片**，服务部署在云端时从本机选择）；
  发送时服务端读取内容（授权校验 + 防路径穿越 + 超长截断）拼进消息，
  模型直接基于文件内容回答；输入框还支持 **`/` 命令**（当前为「压缩上下文」：
  把旧对话压成摘要后继续，节省上下文）与 **`@` 文件搜索**（直接搜项目/已授权目录，
  最多展示 20 个结果，选中即加入附件）；
- **图片与多模态**：粘贴 / 拖拽 / 上传的图片以缩略 chip 展示，发送时转为
  `image_url` 内容块进入消息 —— 仅当启用中的模型勾选了「多模态」；
  纯文本模型附加图片会得到明确提示；
- **上下文容量与缓存占比**：输入框上方实时显示 `上下文 1.7k / 131k（1.3%）` 容量条
  与绿色 `缓存命中 62%`，每个助手回合末尾还有 `↑ 输入 · ↓ 输出 · 缓存 N%` 小字 ——
  数据来自模型响应的 `usage`（含提示词缓存命中），分母来自模型上下文窗口：
  可在设置里**手动输入**，留空则自动读取网关 `/models` 的 `context_length`；
- **人工审批（示例 3）**：发送邮件前弹出审批卡，批准/拒绝按钮对应 `Command({ resume })`；
- **需求理解与澄清（默认 / 房产 Agent）**：先判断请求是否明确；缺少关键信息时弹出
  2–4 个选项 + 自定义输入，选择后继续执行；最终回答会做一次反思，明显遗漏时
  带反馈重答一次（最多一次）。Mock 模式不经过该流程，需配置真实模型观察；
- **停止按钮**：随时中断生成（AbortSignal 直通模型请求）。

### 在界面里管理供应商与模型（多供应商 × 多模型 + 思考等级）

点右上角 **⚙ 设置**（或顶栏的模型按钮 ▾ / 侧栏底部的模型名），无需改 `.env`、无需重启：

- **多供应商**：可添加任意多个供应商档案（名称 + 网关地址 + API Key + 协议），
  列表中一键「启用」切换；
- **一个供应商挂多个模型**：同一个网关（一套 BASE_URL + Key）往往提供好几个模型
  （如 DeepSeek 官方同时有 `deepseek-flash` 与 `deepseek-v4-pro`）。
  在供应商表单的「模型列表」里可以加任意多个模型，每个模型独立配置
  **显示名 / 多模态 / 上下文窗口 / 思考等级**；
- **模型切换**：顶栏 **▾** 直接列出「所有供应商的所有模型」（按供应商分组，✓ 标注当前模型），
  点任意一行即切换 —— 同一个网关下的第二个模型不再需要另建一个供应商；
- **从网关列表添加**：点「获取列表 / 测试连接」会把 `{BASE_URL}/models` 返回的模型
  全部平铺成可点击的 chips（带上下文窗口 / 多模态 / 是否支持推理标记），点一下即添加，
  也可以直接手输模型名；
- **请求协议**：支持四种 AI 请求格式，适配中转站的多协议路由 ——
  `OpenAI Chat Completions`（默认）、`OpenAI Responses API`、
  `Anthropic Messages 原生`（如 DeepSeek 的 `https://api.deepseek.com/anthropic`）、
  `Gemini 原生 generateContent`；非 openai 协议的「获取列表」按各自的端点探测
  （Anthropic `/v1/models`、Gemini `/v1beta/models`），网关不提供列表时手动填模型名即可；
- **API Key**：密文显示、只回传掩码；编辑时留空表示保持不变，清空保存可回到模拟模式；
- 「测试连接」会实际请求模型的列表端点，Key 错误 / 路径不对会直接显示原因；
- 切换后**新建会话立即生效**；已有会话在下一条消息时自动切换模型
  （示例 2/3 的多轮记忆会重置，等同重启服务）；
- 至少保留一个供应商；删除启用中的供应商会自动切到列表第一个；
- 保存供应商成功后自动关闭设置弹窗；模型上下文窗口等参数仍在模型行的「编辑」里配置，
  点「保存模型」后持久化，下次打开继续可改；
- 配置持久化在本地 `.web-config.json`（已 gitignore，含 Key），优先级高于 `.env`，
  删除该文件即回退到 `.env`；旧版单供应商 / 单模型格式会自动迁移成多模型结构。

### 思考等级（reasoning / thinking）的供应商适配

「让模型想多久」这件事**没有统一标准**，每家供应商的参数名与档位划分都不一样。
本项目把它抽象成「**方言（划分方式）+ 档位**」：档位跟着**模型**保存，
顶栏 ▾ 菜单里可以随时切换，设置页的模型编辑面板里可以改「划分方式」。
`src/reasoning.ts` 是唯一的适配层，`src/llm.ts` 负责把它翻译成各客户端的字段：

| 划分方式（方言） | 供应商 | 请求字段 | 档位划分 |
|---|---|---|---|
| OpenAI 思考强度档 | OpenAI（GPT-5 / o 系） | `reasoning_effort` | none / minimal / low / medium / high / xhigh / max |
| 智谱 GLM 深度思考开关 | 智谱 AI（GLM-4.5+） | `thinking.type` | default / enabled / disabled（**两态开关**） |
| DeepSeek 思考开关 + 强度 | DeepSeek 官方 | `thinking.type` + `reasoning_effort` | 关闭 / 开启 / minimal→max 五档强度 |
| Anthropic 扩展思考预算 | Anthropic（Claude 经典） | `thinking.budget_tokens` | 2k / 8k / 16k / 32k / 自适应 |
| Anthropic 输出强度档 | Anthropic（新版 effort） | `output_config.effort` | low / medium / high / xhigh / max |
| Gemini 思考预算 | Gemini 2.5 | `thinkingConfig.thinkingBudget` | 0（关）/ -1（动态）/ 1024 / 8192 / 24576 |
| Gemini 思考等级 | Gemini 3 | `thinkingConfig.thinkingLevel` | LOW / MEDIUM / HIGH |
| 通义千问 思考开关 / 预算 | 阿里云百炼（Qwen3） | `enable_thinking` + `thinking_budget` | 开 / 关 / 1k / 8k / 32k |
| 不设置（通用兼容） | 任意 | — | 不发送任何思考参数 |
| 自定义 JSON | 任意（中转站私有字段） | 手写 | 例如 `{"reasoning":{"effort":"high"}}` |

- **自动识别**：默认档位是 `auto` —— 按 BASE_URL 主机（bigmodel.cn / deepseek.com /
  openai.com / anthropic.com / googleapis.com / dashscope…）、模型名前缀（glm / deepseek /
  gpt-5 / o3 / claude / gemini / qwen）与协议推断方言，设置页会显示「自动识别为 XXX」；
- **协议优先**：Anthropic Messages / Gemini 原生接口的思考参数与 OpenAI 系完全不同，
  所以 `anthropic` 协议下自动落到 Anthropic 方言、`gemini` 协议下落到 Gemini 方言；
  若你手动把方言配到不匹配的协议上，设置页会给出 ⚠ 提示，`llm.ts` 会做**近似换算**
  （`reasoning_effort` ↔ `budget_tokens` / `thinkingLevel`）而不是静默丢弃；
- **默认不干预**：档位默认「供应商默认」＝不发送任何思考参数，因此不认识这些字段的
  中转站不会被塞奇怪参数；只有你显式选了档位才会往请求里加字段；
- DeepSeek 的参数组合由探针脚本实测确认（`.setting/probe-reasoning-levels.mjs`，
  因为带 Key 所以放在已 gitignore 的 `.setting/` 下：`thinking.type=disabled`
  之后响应里确实不再有 `reasoning_content`）；
  OpenAI / Anthropic / Gemini 的字段与取值来自各自官方 SDK 的类型定义。


架构：`node:http` + SSE（无 Express）｜前端原生 HTML/CSS/JS（无框架、无构建）。
事件协议与翻译层见 `src/server/events.ts` / `stream.ts`，细节见 Wiki §3.12。
后端按「入口 + 路由 + 域模块」分层（`index.ts` 只做 dispatch，业务在 `server/routes/*.ts`）；
前端通用件拆在 `public/modules/`（原生 ESM：Markdown 渲染、Agent profile、弹窗组件），
仍无构建步骤；页内弹窗支持 Esc 与点击遮罩关闭。

### 接入第三方 Agent（只需要一个 Git 地址）

「＋ 新建对话」弹窗底部有 **🔌 外部 Agent** 区块：粘贴任意 Git 仓库地址 → 服务端
`git clone --depth 1` 到 `.setting/agents/` → 自动识别启动方式 → 注册为可选择的会话类型。
例如 DeepSeek 的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)、
任何带 CLI 入口的 agent 工具仓库，都可以这样接入。

识别优先级：**① 仓库根 `agent.json` 清单（推荐约定）→ ② package.json 的 bin / main 字段
（Node 类工具）→ ③ 常见入口文件（cli.js / index.js / agent.py / main.py …）**。
都没有也没关系，接入时会让你补一条启动命令。

`agent.json` 清单格式（放在你的仓库根，本工作台和第三方都能照此提供）：

```json
{
  "name": "my-agent",
  "description": "一句话介绍",
  "command": "node",
  "args": ["cli.js", "--prompt", "{{prompt}}"],
  "passCredentials": false
}
```

- `{{prompt}}` 占位符会替换成用户消息；没有占位符时，消息以一行 JSON
  `{"message":"…"}` 从 stdin 传入；
- 启动命令的 **stdout** 按块流式转发到聊天界面，非 0 退出展示 stderr 尾部；
- 每条消息 = 启动一次子进程（180s 超时），外部工具自己管理上下文；
- `passCredentials: true` 时才把当前启用供应商的网关配置注入子进程环境
  （`AGENT_API_KEY` / `AGENT_BASE_URL` / `AGENT_MODEL` 及 `OPENAI_*` 同名变量），
  默认不传 —— 谨慎对可信仓库开启；
- 接入 = 在服务器上运行第三方代码，请只添加可信仓库。
- 支持 `https://` / `git@` / `file:///`（本地测试用）地址。

### 通用 Agent 的内置工具（编程助手形态）

默认的「通用 Agent」除了基础工具（计算器 / 时间 / 天气 / 邮件）外，绑定了一套编程开发工具：

| 工具 | 作用 | 审批 |
|---|---|---|
| `terminal` | 在项目根目录执行 shell 命令（构建 / 测试 / git / 装依赖），输出限量、120s 超时 | ✅ 需批准 |
| `write_file` | 创建或覆盖项目内文件 | ✅ 需批准 |
| `read_file` | 读取项目内文本文件（授权路径内，超长截断） | 直接执行 |
| `list_dir` | 列目录（跳过 node_modules / .git 等） | 直接执行 |
| `grep_search` | 正则搜索项目文本（限量返回 文件:行号:内容） | 直接执行 |

安全边界：读写/搜索走 files.ts 的授权前缀校验（只能碰项目根与已添加的远程文件夹）；
`terminal` / `write_file` 与发邮件一样，模型调用后会先 interrupt 弹出人工审批卡，批准才执行。

**能力隔离**：通用 / 房产是两个 Agent profile（`src/agent/profile.ts`）。每个 profile 自带
工具 allowlist 与审批策略，工具执行节点只按当前 profile 的 local map 查工具；模型即使伪造
跨域调用（例如通用会话调 `house_search`），也只会得到「当前 Agent 不支持工具」的失败结果，
不会执行其他域工具，也不会进入审批。会话与每轮记录都保存 `agentProfileId`，供列表、回放与
审计区分执行域。

**历史会话回放**：每轮对话（用户消息 + 全部事件）都会记录在服务端，换浏览器或清空缓存后
点击历史会话会自动从服务端拉取并按原样重放，不再出现「打开为空」。

## 桌面端（Electron）

```bash
npm run desktop             # 默认端口 3123（环境变量 DESKTOP_PORT 可换）
```

- **架构**：Electron 主进程（`desktop/main.cjs`）把现有 HTTP 服务
  （`npx tsx src/server/index.ts`）作为**子进程**拉起，浏览器内核窗口直接加载
  `http://127.0.0.1:3123` —— 前端 / 服务端逻辑零改动，`npm run web` 照旧可用；
- **细节**：窗口就绪才显示（无白屏闪烁）；外部链接交给系统浏览器打开；
  **隐藏系统标题栏**（Windows `titleBarStyle:hidden + titleBarOverlay`）：右上角
  最小化/最大化/关闭由原生绘制、颜色跟随应用深浅主题，顶栏即拖拽区；
  单实例锁（重复启动自动聚焦已有窗口）；退出时同步等待 `taskkill /T` 完成，
  确保 npx→node→tsx 子进程树不会残留；环境变量 `DESKTOP_DEVTOOLS=1` 可在窗口里打开 DevTools。

## 知识库（外部 RAG）

工作台**不内置向量库 / embedding** —— 检索与入库委托给一个**外部 RAG 服务**，
通用 Agent 自动获得 `retrieve_docs` 工具。侧栏「📚 知识库（RAG）」打开管理面板：

- **通用 HTTP 契约**（外部服务按此实现即可，无需改造本工作台）：

  | 动作 | 请求 | 说明 |
  |---|---|---|
  | 入库 | `POST {RAG_URL}/ingest` | `{collection, documents:[{id, name, text, meta}]}`；切块 / embedding 由服务完成 |
  | 检索 | `POST {RAG_URL}/search` | `{collection, query, topK}` → `{hits:[{text, score, name?}]}`（字段名宽松解析） |
  | 清空 | `POST {RAG_URL}/reset` | `{collection}` |
  | 删除 | `POST {RAG_URL}/delete`（可选） | `{collection, ids}` |
  | 鉴权 | `Authorization: Bearer <key>` | Key 可留空 |

- **两个入库入口**：① 知识库面板选项目 / 文件夹「全量入库」（自动扫描文本文件，
  跳过 node_modules / .git / 密钥 / 锁文件，单次 ≤300 个文件）或粘贴文本；
  ② 发消息时的 📎 文本附件**自动顺手入库**（best-effort，失败不影响对话）；
- **两个检索出口**：聊天中问知识库相关内容时，通用 Agent 自动调用
  `retrieve_docs`（命中片段带来源与分数，回答要求标注来源，检索不到会如实说明）；
  面板内也有检索测试框；
- **本地登记**：`.web-config.json` 的 `rag` 键只存「送进去过什么」的花名册与
  服务地址 / 集合名 / topK 配置（真实索引在外部服务侧）；仓库里没有本地向量数据；
- **安全**：入库只允许授权路径（`files.ts` 授权前缀校验），`.env / *lock*` 等敏感文件不入库。

## 房产找房（贝壳官方 AI）

侧栏「🏠 找房数据源（贝壳）」管理数据源；新建对话时选「房产 Agent」即得到一个
贝壳顾问式 Agent（`src/agent/estate.ts`），对话特征与通用 Agent 一致（流式 / 工具卡 / 审批）。

**首次使用两步（面板里自动完成）**：

1. **安装 CLI**：服务端从贝壳官方 GitHub 下载 win32-x64 二进制（默认白名单内零 npm 依赖），
   sha256 校验后解压到 `.setting/beike/`；已装过（PATH 里有 `beike`）则自动识别；
2. **保存授权 Key**：浏览器打开 <https://building.ke.com/?action=get-key&source=beike_skill>
   登录后复制页面显示的完整凭证 → 面板粘贴保存（走 `beike auth KEY --save`，
   Key 只落贝壳本地凭证 `~/.beike`，工作台不落盘不回显）。

**Agent 的工具集**（`src/tools-estate.ts`，全部包装贝壳官方 `beike` CLI 子进程）：

| 工具 | 对应命令 | 说明 |
|---|---|---|
| `house_search` | `beike buy/rent search` | 二手房 / 新房 / 整租 / 合租搜索 |
| `house_lookup` | `detail / resolve / material / resblock / plate` | 房源详情 / 口语描述转 ID / 户型图 / 小区 / 板块 |
| `house_market` | `market / sold / rank / policy / district / school` | 行情 / 成交 / 排行 / 政策 / 学区 |
| `house_map` | 本地 geocode | 把一组候选地址解析成坐标，返回内嵌 OSM 地图 + 高德/腾讯/百度直链（免 key，≤6 个点位） |
| `house_agents` | `agent / agent-detail` | 经纪人搜索 / 详情 |
| `house_appoint` | `rent/buy appoint` | 预约带看（**高风险**，必须人工审批） |
| `house_contact` | `rent/buy contact` | 经纪人加微（**高风险**，必须人工审批） |

**对比区位地图**：`house_map` 用 <https://nominatim.openstreetmap.org>（串行 ≥1.1s + 内存缓存，
遵守 1 req/s 限流）把候选地址解析为经纬度，前端渲染 OSM iframe 地图；每个点位附带
高德 / 腾讯 / 百度地图 marker 直链按钮（三个平台原生免 key）。解析失败的候选不放弃，
仍会以「未定位」行列出。**城市名/区域名尽量用「小区名」而不是方言简称，命中率高很多。**

**说明与坑**：

- 每轮对话后台会 fire-and-forget 上报 `beike analyze`（官方协议要求，静默执行）；
- 贝壳渲染出来的房价 / 行情 / 排名**不是实时行情**，Agent 回答时会声明统计口径；
- CLI 甩 `-32001 / CLI_UPGRADE_REQUIRED` 时会自动重装再重试一次；
- 真·找房消耗贝壳侧配额：模拟模式（未配模型 Key）用内置演示数据渲染同样的事件流，
  不会调用贝壳 CLI。

## 内置示例（5 个学习 Demo）

新建对话时可选「通用 Agent」（默认）或以下示例 —— 每个示例是一张刻意保持教学形态的图，
用来观察特定结构的运行方式：

| # | 文件 | 学习重点 | 运行 |
|---|------|---------|------|
| 1 | `src/agent/basic.ts` | **基础 ReAct Agent**：State / Node / Edge / 条件边 / 工具循环 | `npm run demo:1` |
| 2 | `src/agent/memory.ts` | **对话记忆**：Checkpointer 检查点 + thread_id 多轮记忆 | `npm run demo:2` |
| 3 | `src/agent/hitl.ts` | **Human-in-the-loop**：interrupt() 暂停 + 人工审批高风险操作 | `npm run demo:3` |
| 4 | `src/agent/multi.ts` | **多 Agent 协作**：Supervisor 主管 + 员工子图分派任务 | `npm run demo:4` |
| 5 | `src/agent/parallel.ts` | **并行 map-reduce**：Send API 动态分发 + 自定义 State/reducer | `npm run demo:5` |

> 通用 Agent 的定义在 `src/agent/general.ts` —— 它就是把示例 1/2/3 的能力
> （工具循环 + 记忆 + 审批）按产品逻辑组合后的形态。CLI（`npm run demo:1~5`）
> 保留用于命令行学习：示例 1~4 带 **token 级流式输出**（思考过程灰色 + 打字机效果），
> 也可传自定义问题，例如 `npx tsx src/cli.ts 1 "帮我算一下 (5+3)*2"`、
> `npx tsx src/cli.ts 5 "咖啡, 露营, 极光"`。

## 项目结构

```
src/
  config.ts      # 统一读取 .env（baseURL / apiKey / model），切换供应商不改业务代码
  llm.ts         # 模型工厂：多协议（OpenAI/Responses/Anthropic/Gemini）接入任意网关
  tools.ts       # 4 个自定义工具（calculator / 时间 / 天气 / 发邮件），zod 声明参数
  tools-dev.ts   # 编程开发工具（terminal / 读写文件 / 搜索），通用 Agent 使用
  tools-rag.ts   # 知识检索工具 retrieve_docs：调外部 RAG 服务（通用 HTTP 契约）
  tools-estate.ts# 房产工具集（贝壳 CLI 包装：找房/行情/地图/经纪人/预约/加微）
  agent/
    workflow.ts  # 默认编排：需求理解 → 澄清 → ReAct/审批 → 结果反思（消费 profile）
    profile.ts   # Agent profile 类型 / 工具 allowlist / 上下文预算 / kind → profile 派生
    context-builder.ts # prompt 分层、最近消息窗口与工具结果预算投影
    approvals.ts # 按 profile 拆分的审批登记（general / estate / demo）
    general.ts   # 通用 Agent profile：工具集 + 系统提示词
    estate.ts    # 房产 Agent profile：贝壳顾问式流程
    basic.ts     # 示例 1：亲手搭一张 ReAct 图（不借助 prebuilt 的 createAgent）
    memory.ts    # 示例 2：compile({ checkpointer }) 获得多轮记忆
    hitl.ts      # 审批工具节点工厂 + 示例 3：interrupt()/Command.resume
    multi.ts     # 示例 4：子图当节点，主管用虚拟工具 delegate 路由
    parallel.ts  # 示例 5：Send API 并行 map-reduce + Annotation.Root 自定义状态
  cli.ts         # CLI 入口：token 流式 + 节点日志 + 审批交互
  server/        # Web 界面（参考 ZCode）：SSE 服务 + 原生前端，见「Web 界面」
    index.ts     # HTTP 入口：安全头/认证/静态/集中 dispatch/信号处理（业务不写这里）
    health.ts    # /healthz 存活探针 + /readyz 就绪探针（目录可写/关闭中检查）
    lifecycle.ts # 在途请求统计 + 优雅退出（SSE 通知/超时强断/flush/退出码）
    logging.ts   # 结构化日志（stdout JSON、密钥打码、LOG_LEVEL）
    audit.ts     # 安全动作审计（append-only NDJSON，认证失败/外部 Agent/安装）
    session-store.ts # 会话 journal（NDJSON 回放 + compact + flushJournal）
    routes/      # 各域 handler：chat / config / sessions / external / projects / files / rag / estate
    rag.ts       # 外部 RAG 接入：契约客户端 + 配置 + 文件夹扫描入库 + 📎 自动入库
    estate.ts    # 贝壳 CLI 客户端：安装/鉴权/命令映射 + Nominatim geocode + 地图数据
    settings.ts  # 多供应商 × 多模型管理（.web-config.json 读写、迁移、思考等级）
desktop/
  main.cjs       # Electron 桌面端：子进程托管 Web 服务 + BrowserWindow 加载
scripts/
  list-models.ts # npm run models：查询网关支持的模型列表（排查 400 的利器）
tests/
  unit/          # 纯函数/内存状态单测（Markdown、files、workflow、context、profile、prehistory）
  integration/   # 临时服务端冒烟（mock 模式，SSE/回放/静态分发）
  security/      # 跨站/认证/坏 JSON/413/目录穿越边界
  helpers/       # 临时服务端托管（随机端口 + 隔离 journal/配置）
.github/workflows/ci.yml  # CI：typecheck + 语法门 + npm test
├── Dockerfile / docker-compose.yml  # 单实例容器部署（/data 数据卷，见 docs/deployment.md）
docs/
  agent-wiki.md          # 完整学习 Wiki（概念/模块/调用链/模板）
  agent-orchestration.md # 端到端编排：请求/选图/工具/审批/SSE/压缩
  agent-orchestration-vs-zcode.md # 与 ZCode / DSH 的流程编排对比
  deployment.md          # 部署运维：Docker / 探针 / 优雅退出 / 日志 / 反向代理
```

## 踩坑记录（排查 400）

网关返回 **HTTP 400 且无响应体**，最常见原因是 **模型名不在网关支持列表里**
（例如 `gpt-4o-mini` 并非所有中转站都有）。排查三步：

1. `npm run models` 查看网关实际支持的模型列表；
2. 把 `.env` 里的 `MODEL` 改成列表里的 id（如 `deepseek-v4-flash`）；
3. 重跑 demo。

`.env` 里的真实配置在本地，已通过 `.gitignore` 排除，不会提交。

## 架构治理与生产化计划

当前项目默认定位是本地学习型工作台；如果要把 Web 服务开放到局域网、云服务器或长期运行，
治理顺序与结论见 Wiki [§9 架构治理与生产化路线](docs/agent-wiki.md#9-架构治理与生产化路线结论摘要)。
重点覆盖默认监听地址、认证与 CSRF、密钥保护、子进程限额、原子配置、会话恢复、
自动化测试、Docker 部署和审计日志。改动时请守住「零框架、前端零依赖和运行依赖白名单」的约束。

### 代码结构与质量门（Phase 3）

- **后端分层**：`src/server/index.ts` 只做 server 创建、认证/同源/安全头、静态分发与
  **集中路由 dispatch**；业务按域拆在 `src/server/routes/*.ts`（chat / config / sessions /
  external / projects / files / rag / estate），请求体读取与 413 排水在 `http-body.ts`。
- **前端零构建 ESM**：`public/app.js` 通过原生 `<script type="module">` 引入
  `public/modules/format.js`（Markdown / 格式化 / URL 白名单）与
  `public/modules/ui-dialog.js`（错误横幅 + 页面内对话框），仍无打包步骤。
- **测试**：`tests/unit` / `tests/integration` / `tests/security` 三档（Node 内置
  `node:test`，共 45 例），`npm test` 一键运行；测试强制 mock 模式并隔离临时
  journal / 配置，不读取真实 Key、不消耗网关配额。
- **CI**：`.github/workflows/ci.yml` 在 push / PR 到 `main` 时执行
  `npm ci` → `npm run typecheck` → 前端与桌面端 `node --check` → `npm test`。

### 当前已落地的安全默认值（Phase 0）

- **只监听本机**：服务默认绑定 `127.0.0.1`（环境变量 `HOST` 可改，如 `0.0.0.0` 开放局域网）。
  填非 loopback 地址且未配置 `AUTH_TOKEN` 时，启动横幅会打双行 ⚠ 醒目警告；
  桌面端强制 `HOST=127.0.0.1`，不受误配影响。
- **开放网络未认证只读**：`HOST` 为非 loopback 且未设置 `AUTH_TOKEN` 时，
  一切非 GET 请求返回 403（中文提示），GET 只读接口不受限 —— 防止异地修改配置、
  执行命令、消耗网关配额。
- **请求体限量**：除文件上传（12MB 白名单）外的单次请求体上限 2MB，
  超限返回 413 与中文提示；实现按字节累计并在超限后「丢弃式排水」，不吃内存。

### 访问认证与同源防线（Phase 1）

- **Bearer 认证**：在 `.env` 里设置 `AUTH_TOKEN=任意令牌` 即开启。开启后所有
  `/api/*`（除 `/healthz`、`/readyz` 与静态页）都要求 `Authorization: Bearer <令牌>`；
  浏览器首次访问会弹框索要令牌并保存在 localStorage，之后不再询问。令牌校验
  使用 sha256 摘要 + 常量时间比较，无时序侧信道。
- **跨站防护**：浏览器式的跨站请求（`Origin` 与本站不符、`Sec-Fetch-Site:
  cross-site`）即使带了令牌也会被 403 拒绝 —— 防恶意页面借浏览器自动带上
  令牌外打接口。「改世界的动作」（外部 Agent 增删改/运行/凭证注入、贝壳 CLI
  安装）全部落盘到 `.setting/audit.ndjson`，事后可追溯。
- **安全响应头**：所有响应带 `X-Content-Type-Options: nosniff`、
  `Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、内容安全策略
  （脚本仅限本站内联，iframe 仅允许贝壳大地图）。
- **外部 Agent 管控**：启动命令限 `node/npm/npx/pnpm/pnpx/yarn/python*`
  白名单（裸名）或必须落在该 Agent 自己 clone 目录内的路径；凭证注入
  （网关 Key 进入子进程环境）默认关闭，开启需二次确认；同并发跑的上限 2 条。
- **贝壳 CLI 安装加固**：下载仅接受官方 host 白名单（含 HTTPS 强制、拒绝
  重定向出去）、`System32\tar.exe` 绝对路径解压、临时文件校验后改名、
  sha256 摘要必须一致；CLI 版本过低不再自动下载新版本，需要你在面板手动点。

### 本地可靠性与状态恢复（Phase 2）

- **配置原子落盘**：`.web-config.json` 的写入走「临时文件 + fsync + 原子改名」，
  Windows 下写入抖动自动重试；另存一份 `.bak` 滚动备份，主文件损坏时启动自动抢救
  （两份都坏则降级为空白配置，服务照常起来）。
- **对话不随重启丢**：会话（含标题、项目归属、每轮消息与事件流）持续记入
  `.setting/sessions.ndjson`（gitignore，不入库）。服务重启后历史会话原样
  回来，网页端跟往常一样回放；删除过的对话重启后不会复活。
- **重启后的审批有明确引导**：重启恢复了「等审批」的卡片，但图的暂停状态无法
  跨进程恢复 —— 此时点「同意/拒绝」会得到一条明确的中文提示，要求把那条指令
  重新发一次（绝不静默重复执行可能改世界的操作）。
- **重启后的上下文续命**：已恢复会话的下一条消息会自动附带一份「重启前的对话
  摘录」（最近 12 轮、单轮限长），让带记忆的模型对话保持连续；只注入一次，
  不反复消耗上下文预算。
- **防误触与并发上限**：同一会话同时只允许一条回答在生成（重复发送提示稍候）；
  同一会话两次发送至少间隔 1.5 秒；贝壳 CLI 的并发查询上限 2。
  超限都是中文提示，不会出现「跑两次」或幽灵审批。

### 部署与可观测性（Phase 4）

- **Docker 单实例部署**：`Dockerfile` 基于 `node:22-slim`，多阶段安装依赖后以非 root
  运行；`docker-compose.yml` 只映射到宿主机 `127.0.0.1`，强制 `AUTH_TOKEN`，配置 /
  会话 / 审计统一挂载到 `./data`（gitignore）。完整步骤见
  [`docs/deployment.md`](docs/deployment.md)。已在 Docker 28.5.1 实测镜像构建、
  healthcheck、`docker stop`（约 0.8s 内，退出码 0）与纯 NDJSON 日志。
- **健康探针**：`GET /healthz` 只证明进程存活（liveness，永不 503）；
  `GET /readyz` 检查配置目录与 journal 目录可写、且未在关闭中（readiness，异常回 503）。
  两者免认证、只回版本/耗时/布尔值，Docker healthcheck 已内置。
- **优雅退出**：收到 `SIGINT` / `SIGTERM`（Windows 另有 `SIGBREAK`）后停止接新请求、
  给进行中的 SSE 补一帧 `shutdown` 再断开、最多等 10 秒让在途请求收尾、flush
  journal/audit 后退出；超时强断并以退出码 1 结束。重复信号会立即退出。
- **结构化日志**：每个请求一行 stdout JSON（`X-Request-Id` / method / path / status /
  durationMs），密钥字段打码、不记录用户消息；`LOG_LEVEL` 可调。认证失败等安全动作
  仍单独写入 append-only 审计文件，不随日志级别关闭。

## 学习路线建议

1. 先跑 **示例 1**，把 `src/agent/basic.ts` 的注释和图结构对照着看，
   理解「节点 = 处理步骤，边 = 执行顺序，状态 = 节点间传递的数据」；
2. 再跑 **示例 2**，体会同一张图加上 checkpointer 之后的行为差异；
3. **示例 3** 演示了 Agent 落地必学的「人工把关」能力（发邮件/付款前审批）；
4. 接着看 **示例 4**，理解如何用子图把多个 agent 组合成团队；
5. 最后跑 **示例 5**（`npm run demo:5 "咖啡, 露营, 极光"`），掌握 Send 并行分发
   与 reducer 汇聚 —— 多 Agent 之外另一种扩展方向。
