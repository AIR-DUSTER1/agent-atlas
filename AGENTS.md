# AGENTS.md — 项目规范（面向人类与 AI 助手的统一约束）

> 本文件是本仓库**所有代码生成 / 修改工作的最高约定**。目标是：内容一致性高、
> 质量门明确、维护心智负担最低。开工前先读完本文件；与本文件冲突的历史代码，
> 新代码以本文件为准（旧代码按「最小改动」原则不必返工）。

---

## 1. 项目定位一句话

agentatlas：LangGraph.js（TypeScript）+ 零框架实现的 Agent 工具集：`node:http` + SSE 后端、
TypeScript 前端（tsc 编译，无打包器）、多供应商模型配置、外加 Electron 桌面端壳
与「外部 RAG 知识库」HTTP 客户端。**保留学习示例，同时作为可正常使用的本地产品维护**。

后续能力路线：Hook、独立电脑操作 Agent、岗位获取 Agent、简历投递 Agent。规划与实现边界见
`docs/agentatlas-roadmap.md`；未完成能力不得在 README「当前能力」中冒充已交付。

## 2. 技术栈红线（不许随意突破）

| 约束 | 说明 |
|---|---|
| TS 配置 | `strict` + `NodeNext` + `noEmit`；ESM 导入**必须带 `.js` 后缀**（`import x from "./foo.js"`） |
| 运行时依赖 | 服务端白名单：`@langchain/core` `@langchain/langgraph` `@langchain/openai` `@langchain/anthropic` `@langchain/google-genai` `dotenv` `zod`；electron 仅 devDependency |
| 前端依赖 | `src/client/` 可引入 npm 库（图表 / 图标 / 语法高亮 / Markdown 等），但须在 §2.1 登记版本、许可证与产物体积；**禁止引入 UI 框架**（React/Vue/Svelte）与需要打包器的构建链（Vite/Webpack/Tailwind CLI） |
| 前端 TypeScript | 前端源码是 `.ts`（`src/client/`），**必须有类型**，禁止无类型 JS；`npm run build:client` 编译到 `src/server/public/`（构建产物 gitignore） |
| 单一职责 | 文件按职责拆分，不设行数硬指标：一个文件只做一件事、能被一句话说清即可；超过 ~500 行时先问「是不是混了两件事」 |
| 样式分层 | 禁止恢复单文件 `style.css`；CSS 按 token / reset / layout / surface / responsive / ui 职责拆分，业务文件不覆盖主题原始色 |
| 可访问性 | 图标按钮必须有 `aria-label`/`title`；表单控件必须有 label 或 `aria-label`；正文与弱化文字对比度 ≥ 4.5:1；流式区使用 live region |
| 可选前端能力 | 图表 / Markdown / 高亮必须动态加载并具备降级路径，不得进入 `main.ts` 启动闭包 |
| HTTP 后端零框架 | 不引入 Express/Fastify 等；路由照 §4 模式写顺序 `if` 分支 |
| 直跑 TS | `tsx` 直跑，不做编译产物；新增脚本能被 `tsx` 直接执行 |

新增依赖前先问：标准库 / 现有依赖能否解决？不能时在方案里单独说明理由，并登记到下表。

### 2.1 前端依赖登记表

只允许「浏览器可直接加载的 ESM、无 Node 内置依赖、许可证宽松」的库。新增一行时必须实测
`esbuild --bundle --minify` 后的 raw/gzip 体积，避免悄悄把首屏拖垮。
「状态」列区分「已安装」与「已定选型、尚未落地」——未落地的不算进 `package.json`。

| 依赖 | 用途 | 许可证 | 体积（min / gzip） | 状态 |
|---|---|---|---|---|
| `chart.js` 4.6.1 | 统计页柱状 / 折线 / 环形图 | MIT | 201 KB / 69 KB（按需注册控制器） | 已安装 |
| `lucide` 1.61.0 | 线性图标（按图标具名导入，勿整包） | ISC | 70 个图标 23 KB / 4 KB | 已安装 |
| `marked` 18.1.1 | Markdown 解析（必须与 DOMPurify 同批引入） | MIT | 45 KB / 14 KB | 已安装 |
| `dompurify` 3.4.17 | 渲染前 HTML 净化，守住注入防线 | MPL-2.0 OR Apache-2.0 | 30 KB / 12 KB | 已安装 |
| `highlight.js` 11.12.0 | 代码块语法高亮（按语言子包导入） | BSD-3-Clause | 67 KB / 22 KB（10 种语言） | 已安装 |

引入方式：不引 Vite/Webpack。用 esbuild（已是 `tsx` 的传递依赖）把每个库打成**自包含**
ESM 放 `public/vendor/`；`tsc` 照旧从 `node_modules` 读类型；浏览器用 `<script type="importmap">`
把裸名映射到 `/vendor/<name>.js`。因此应用代码写标准 `import { Chart } from "chart.js"`，
既类型安全又无需打包整个前端。新增 vendor 库要同时更新 `scripts/build-vendor.ts` 的入口清单
与 `src/server/static.ts` 的目录白名单。

## 3. 目录职责（放错位置 = 架构破坏）

```
src/
  config.ts        # 全局运行时配置（.env 播种，可被内存覆盖；勿在别处直接读 process.env）
  product.ts       # 产品名与对外客户端身份常量（UA / MCP clientInfo 统一来源）
  llm.ts           # 唯一的模型工厂：多协议差异全部收拢于此，graph 代码不感知协议
  tools.ts         # 基础工具（calculator / 时间 / 天气 / send_email），zod 声明参数
  tools-dev.ts     # 编程开发工具（terminal / read_file / write_file / list_dir / grep_search）
  tools-rag.ts     # 知识检索工具 retrieve_docs（只调 server/rag.ts，不直接碰网络细节）
  tools-web.ts     # 网页抓取工具 browser_fetch（纯 HTTP + 剥标签；内网默认拒，防 SSRF）
  skills.ts        # 技能库：扫描 .setting/skills/*.md，按关键词命中注入
  plugin-state.ts  # 内置插件运行时启停状态（agent 层只读，不直接碰 server）
  memory-store.ts  # 跨会话长期记忆（每轮动态注入 system 注记）
  tools-*.ts       # 新增同类工具集按 tools-<主题>.ts 命名，一个文件一个主题
  agent/           # LangGraph 图定义（State/Node/Edge 全在这里；general.ts = 产品默认图）
  cli.ts           # CLI 入口；server/ 不 import cli，cli 可 import 一切
  server/          # HTTP/SSE 服务端：一个模块一个职责，单文件命名（rag.ts / files.ts / sessions.ts …）
                   #   mcp.ts = MCP 客户端（JSON-RPC over stdio）；commands.ts = 自定义命令
                   #   plugin-settings.ts = 内置插件启停持久化；routes/plugins.ts = 启停 API
  client/          # 前端源码（TypeScript，唯一真相）
    main.ts        #   入口：初始化与全部 DOM 事件绑定
    core/          #   状态 / DOM / API（state.ts 是唯一可变状态源）
    ui/            #   无业务 DOM 原语（h/button/input/dialog/menu/toast…）
    styles/        #   tokens 与按职责拆分的 CSS
    modules/       #   纯函数与协议类型（format / chat-flow / types…）
    vendor/        #   第三方库唯一隔离层；业务只能 import wrapper，不能直接 import npm 前端库
    render/        #   渲染层（parts 部件 / messages 块）
    stream/        #   SSE 消费与一轮对话生命周期
    composer/      #   输入框 / 命令与 @ 文件菜单
    views/         #   各业务视图（会话/项目/设置/RAG/房产…；settings-plugins.ts = 插件目录与开关）
    actions/       #   审批、压缩等动作
    index.html / styles/*.css
  server/public/   # ★ 前端构建产物（npm run build:client 生成，gitignore，勿手改）
desktop/           # Electron 桌面端源码（TypeScript）
  main.ts          #   主进程：子进程托管 Web 服务 + 窗口（编成 ESM .js 运行）
  preload.ts       #   渲染进程桥（sandbox 下只支持 CJS，构建时编成 preload.cjs）
  build/           #   ★ 构建产物（npm run build:desktop 生成，gitignore，勿手改）
docs/              # 公开文档（agent-wiki.md 等），只放用户可读内容
.plans/            # 开发过程内部文档：架构计划 / 阶段清单 / 攻面分析 / 私有交接。
                   # gitignore 挡住、**永不提交**（本仓库已公开，攻面细节 = 给攻击者的地图）
```

- 文档先分流再落笔：给用户/operator 看的 → `README.md` / `docs/`；给自己/AI 的工作过程文档
  → `.plans/`。`docs/` 与 `.plans/` 是双向禁令：内部文档不得进 `docs/`，用户文档不藏 `.plans/`。

- `src/agent/*` 只依赖 `src/` 顶层与 `@langchain/*`，**禁止 import `server/*`**（图要在 CLI 下可独立运行）。
- `src/server/*` 可以 import `src/` 顶层；互相之间通过导出函数协作，不做隐式单例外的全局状态。
- 前端 `src/client/**` 只能与 `/api/*` 通信，不 import 服务端代码（类型也不允许）。
- 业务前端源码不得直接 import npm 前端库；只允许 `src/client/vendor/*` wrapper 接触第三方 API。
- 通用消息渲染不得 import 房产 / 租房实现；业务专属工具卡通过渲染增强注册表注入。

## 4. 代码风格（全仓库统一）

1. **注释**：一律中文；解释「为什么」而不是「是什么」。
   模块头部必须有 banner 注释：两行说完职责 + 设计立场（关键约束、契约、坑）。
   踩过的坑写成注释（含现象、原因、对策），这是本仓库最重要的资产。
2. **命名**：文件/模块小写（`config-store.ts` 这类复合词用连字符）；导出函数动词开头；
   类型 `PascalCase`；常量全大写 + 下划线；避免缩写（`msg` 可，`m` 不可）。
3. **校验**：请求体/参数解析用 zod（工具侧）或手写类型守卫 + 中文错误（路由侧）；
   错误信息面向用户，中文、说清「缺什么/怎么改」。
4. **异步**：`async/await` 风格；网络调用一律 `AbortSignal.timeout(ms)`；
   后台不需要阻塞主流程的任务 fire-and-forget 时必须自吞异常（`void fn()` 且 fn 内 try/catch）。
5. **常量即上限**：任何截断/限量（字符数、条数、超时）定义成模块顶部 `UPPER_SNAKE` 常量并注释含义。
6. **不写无意义注释**、不加花哨 emoji 装饰代码、不为一致性而一致性重构。

## 5. 关键横切约定（违反即出 bug 的地方）

### 5.1 配置与持久化（.web-config.json）
- 分层：`.env` < `.web-config.json` < 运行中内存。多模块**共用同一个 JSON 文件**
  （providers / projects / externalAgents / rag 并存）。
- **写入只能走 `config-store.ts` 的 `mergeConfig({ key: value })`**，只合并自己键；
  服务端运行时修改后必须 `await persist()`；**禁止整文件覆写**。
- API Key 一律不回传明文：对外只给 `maskKey`；「编辑时留空 = 保持不变，空串 = 清除」。
  承载 Key 的文件（`.env`、`.web-config.json`）已 gitignore，不得移除。

### 5.2 路径与内容安全（files.ts 为唯一权威）
- 任何文件读取/浏览/入库必须经 `assertAuthorized`（授权前缀校验，win32 忽略大小写）；
  用户输入路径永远先 `resolve` 再校验，**不得信任前端传来的路径文本**。
- 文本处理三件套必须同时做：二进制检测（前几 KB 含 `\0` 即拒）、超长截断（常量声明）、
  `SKIPPED_DIRS` / 敏感文件跳过（dotfiles、`*lock*`、密钥类）。
- 列目录最大条数、单文件字符上限等全部走 files.ts 既有常量语义，不要新造一套。

### 5.3 事件协议（server ↔ 前端）
- 新增事件类型：`server/events.ts` 加变体（注释写清对应哪块 UI）→
  产出端在 `server/stream.ts`（或 mock.ts / external.ts）吐出 →
  前端 `stream/events.ts` 的 `handleEvent` switch 加 case（尾部 never 断言会强制穷尽）
  → `modules/types-api.ts` 的 `AgentEvent` 联合加变体 → 空数据/半途错误测试回放路径。
- SSE 帧即 `data: {json}\n\n`；一帧一事件；`done` 由 streamToClient 兜底补发，不要手写。

### 5.4 高风险操作审批（hitl.ts 为唯一登记处）
- 新的「执行后改世界」的工具（执行命令 / 写文件 / 发送外部消息…）必须在
  `hitl.ts` 的 `APPROVAL_TOOLS` 登记（含描述文案）；只读类工具（读/列/搜/检索）不登记、直接执行。
- 工具执行失败**不要 throw 穿透图**：返回「模型可读的中文错误文本」或 JSON `{error}`，让模型转述。

### 5.5 扩展机制分层（改这些位置前先想清楚层次）

| 机制 | 是什么 | 是否执行代码 | 风险 |
|---|---|---|---|
| 技能 `.setting/skills/*.md` | 按关键词注入的**文档** | ❌ 永不执行 | 只影响提示词 |
| 自定义命令 `.setting/commands.json` | 输入框里的**提示词模板** | ❌ 只填文本 | 只影响提示词 |
| MCP server（`server/mcp.ts`） | 外部**程序**（子进程） | ✅ 会跑第三方代码 | 工具默认全登记审批；只接受可信来源 |

Hook 为后续规划项，不属于当前运行时。落地时按“可执行代码”治理：默认关闭、按事件授权、超时/递归/输出上限、关键副作用审批与审计；不得把 Hook 混同为技能文档或命令模板。

新增扩展能力时先判断它属于哪一层：能做成文档/模板的就不要做成程序。

### 5.6 JSON 序列化陷阱（已踩两次的坑）
- async 导出函数（如 `getRagPublic`）在路由里**必须 await**；
  `JSON.stringify(promise)` 静默得到 `{}`，导致前端数据「凭空消失」。
- 前端 `innerHTML` 模板搭骨架 + `textContent` 填正文（天然防注入）；
  用户可见内容不拼进模板字符串。

## 6. 增改检查单（做完自查）

新增 HTTP 接口：
1. 业务写成 `src/server/<模块>.ts` 导出 async 函数（内部 throw 中文错误）；
2. `index.ts` 在**兜底 404 之前**插 `if (pathname === ... && method)`：
   `readBody` → try 里 `await 业务` 再 `writeHead(200)`；catch 转 400 JSON；
   注意「先 await 业务，再 writeHead」顺序，失败才可能正常回 4xx；
3. GET /api/* 已统一 no-store，无需重复设置；新前端逻辑配套更新 `APP_VERSION`。

新增工具：schema 用 zod + `describe` 中文；`description` 写清「何时用/何时不用」；
在相关 graph 的 `tools` 数组绑定；高风险则 §5.4 登记；依赖网络/外部服务的能力放 server 层。

新增 LangGraph 图/节点：State 尽量复用 `MessagesAnnotation`；子图复用现有节点函数
（如 `approvalToolsNode`）；`stream.ts` 翻译层能吃下新节点的流事件再合并。

新增供应商协议：只改 `llm.ts` + `config.ts` 的 `Protocol` + settings 的下拉/探测端点。

配置新增字段：先想清楚放内存 `config`、`.web-config.json`（mergeConfig 新键）还是
session 级；持久化字段的**读取处要兼容字段缺失**（旧配置文件没有它）。

## 7. 质量门（交付前必须全绿）

```bash
npm run typecheck            # 后端 + 前端 + 桌面端三套 tsconfig，零报错
npm run build:client         # 前端构建门：编译 + 自检 main.js / index.html / styles / vendor 产物
npm run build:desktop        # 桌面端构建门：编译 + 自检 main.js / preload.cjs 产物
npm test                     # 单测 / 集成 / 安全三档（mock 模式，不耗真实配额）
```

桌面端源码已是 TypeScript，`typecheck` 已含 `tsconfig.desktop.json`，因此不再需要
`node --check` 手查语法；`build:desktop` 在编译之外还会确认两个产物真的生成
（缺 `preload.cjs` 桌面端会白屏且 preload 失效 —— CI 同步做这一步）。

涉及服务端逻辑 / 新接口时，用**最小手动验证**：启动服务（`$env:PORT=3456` 起临时端口）
+ curl/Invoke-RestMethod 打一遍成功与失败路径；外部依赖（RAG、网关）用「本地 mock
小脚本」模拟（参考 Temp 目录 mock-rag.cjs 模式）。**验证严禁消耗用户真实 API 配额**：
不配置 Key 走 mock 模式，或临时覆盖环境变量，或只测不调模型的部分。

前端有改动时：确认 `APP_VERSION` 已递增（页面顶部横幅可肉眼核对），并测一遍
主题切换、发送、停止、弹窗开关（Esc / 点遮罩）不回归。

## 8. 平台与环境坑（Windows / PowerShell 5.1 着重看）

- **PowerShell 5.1 默认 GBK 无 BOM**：脚本文件含中文必须 UTF-8 BOM，或干脆全英文，
  否则解析即炸（本仓库测试脚本曾因此规律性失败两次）。
- **后台进程孤儿**：Shell 工具里 Start-Process / Start-Job 起的服务在命令结束会被杀，
  但 Electron/npx 链可能存活 → 下一轮测试端口被旧进程占用（EADDRINUSE 静默打到旧状态 brilliantly 表现为「数据翻倍」）。
  规则：每轮测试**换端口**，结束后按 `CommandLine` 匹配清理 node 孤儿。
- Windows 上用 `spawn` 启动 `.cmd`（npx）必须 `shell: true`；杀进程树用 `taskkill /pid X /T /F`（desktop/main.ts 已示范）。
- curl.exe 在 PS5.1 里的 JSON 引号极易坏，改用 `Invoke-RestMethod`。
- Web 服务端口固定 3000、桌面端 3123，测试用 3456+，不抢用户日常进程。

## 9. 文档同步（不是可选项）

- 每次交付**必须同步**更新：`README.md`（用户视角：功能怎么用） +
  `docs/agent-wiki.md`（模块视角：§3 加模块小节、§7 加/更新踩坑表）。
- **开发计划 / 攻面分析 / 阶段交接 → 只写 `.plans/`，永不进 git**（§3 目录职责）。
  需要向用户公开的结论（如「新增了认证」）提炼到 README / wiki 的功能说明层面，
  不带弱点清单、攻击路径、内部提交号对照表。
- 新增外部契约（对外 HTTP/RAG 形状）要在 README 用表格写全请求/响应示例。
- 提交信息按 §10 的类型前缀单行格式生成；类型、空格、中文主题和禁止多行规则均不得省略。

## 10. 提交规范

### 10.1 强制格式

整个提交信息**只能有一行**，不换行，不分标题和正文：

```text
<type>: <主题概括>，<具体变更1>，<具体变更2>，<具体变更3>
```

- 类型后必须使用**半角冒号 + 一个空格**：`feat: `，不得写成 `feat：` 或 `feat:`。
- 主题使用中文，简明描述“做了什么”，并优先点明受影响的页面、模块或能力。
- 一个提交只表达一个主题，不混入不相关变更。
- 提交信息末尾不加句号或其他收尾标点。
- 允许在同一行用中文逗号补充 1–3 个具体变更，但不得拆成多行或重复概括。

### 10.2 类型

| 类型 | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat: 通知中心添加空状态显示和分页条件渲染` |
| `fix` | 修复缺陷、小改动、补漏、调整 | `fix: 修复角色编辑弹窗标题显示和表单初始化问题` |
| `refactor` | 大规模重构（多文件、改变代码结构） | `refactor: 将全局状态管理从 Vuex 迁移到 Pinia` |
| `style` | 样式调整 | `style: 调整图纸表格内边距和操作按钮间距` |
| `i18n` | 国际化相关 | `i18n: 将通知相关国际化文本提取到独立文件` |
| `chore` | 构建、依赖、工具、仓库规范 | `chore: 添加 sortablejs 依赖` |

### 10.3 `fix` 与 `refactor` 边界

必须使用 `fix` 的场景：

- 修复 bug、补漏或调整配置；
- 移除/添加单个配置项；
- 调整样式、间距或布局细节；
- 补充缺失逻辑，例如 `nextTick`、事件监听；
- 修改单个或少量文件的局部代码；
- 补充类型定义、修复 TypeScript 类型错误。

只有**同时满足**以下条件才允许使用 `refactor`：

- 涉及 **5 个及以上文件**的结构调整；
- 改变整体架构或设计模式；
- 替换技术方案；
- 重新组织目录结构。

不满足上述全部条件的改动一律使用 `fix`，不得滥用 `refactor`。

### 10.4 严格禁止

- 禁止多行提交信息；
- 禁止空行分隔标题和正文；
- 禁止序号列表；
- 禁止先写概括、再写一行展开描述的重复主题格式。

正确示例：

```text
fix: 修复 BasicTable 组件类型定义缺失问题，补充 flexHeight 和 rowClassName 属性，为 useDataSource 添加参数类型接口，修复 checkedRowKeys 的 Set 泛型类型不兼容
```

错误示例：

```text
fix: 修复 BasicTable 组件类型定义

fix: 补充 flexHeight、rowClassName、size 等缺失属性到 BasicTableProps 接口，为 useDataSource 函数添加 DataSourceContext 参数类型，修复 checkedRowKeys 的 Set 泛型与 string[] | number[] 不兼容问题
```

### 10.5 仓库检查

- 只改 `git status` 里本任务相关文件；`.env`、`.web-config.json`、`.plans/` 永不入库。
- **提交前清点**：`git status --short` 里不得出现 `.plans/`、临时测试脚本、
  含真实 Key/内网地址的文件；`git ls-files | grep -i plan` 应为空。
- 提交前自查 `git diff`：不得遗留调试用 `console.log`、临时脚本或注释掉的代码块。
- 大改动拆逻辑相邻的小提交；提交前必须通过 §7 全部质量门。
