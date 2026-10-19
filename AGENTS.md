# AGENTS.md — 项目规范（面向人类与 AI 助手的统一约束）

> 本文件是本仓库**所有代码生成 / 修改工作的最高约定**。目标是：内容一致性高、
> 质量门明确、维护心智负担最低。开工前先读完本文件；与本文件冲突的历史代码，
> 新代码以本文件为准（旧代码按「最小改动」原则不必返工）。

---

## 1. 项目定位一句话

LangGraph.js（TypeScript）+ 零框架实现的 Agent 工作台：`node:http` + SSE 后端、
原生 HTML/CSS/JS 前端（无构建）、多供应商模型配置、外加 Electron 桌面端壳
与「外部 RAG 知识库」HTTP 客户端。**学习项目形态，可正常当产品用**。

## 2. 技术栈红线（不许随意突破）

| 约束 | 说明 |
|---|---|
| TS 配置 | `strict` + `NodeNext` + `noEmit`；ESM 导入**必须带 `.js` 后缀**（`import x from "./foo.js"`） |
| 运行时依赖白名单 | `@langchain/core` `@langchain/langgraph` `@langchain/openai` `@langchain/anthropic` `@langchain/google-genai` `dotenv` `zod`；electron 仅 devDependency |
| 前端零依赖 | `public/` 内禁止引入任何 npm 包、禁止构建步骤；需要新能力自己写原生 JS 微实现 |
| HTTP 后端零框架 | 不引入 Express/Fastify 等；路由照 §4 模式写顺序 `if` 分支 |
| 直跑 TS | `tsx` 直跑，不做编译产物；新增脚本能被 `tsx` 直接执行 |

新增依赖前先问：现有白名单能否解决？不能时在方案里单独说明理由。

## 3. 目录职责（放错位置 = 架构破坏）

```
src/
  config.ts        # 全局运行时配置（.env 播种，可被内存覆盖；勿在别处直接读 process.env）
  llm.ts           # 唯一的模型工厂：多协议差异全部收拢于此，graph 代码不感知协议
  tools.ts         # 基础工具（calculator / 时间 / 天气 / send_email），zod 声明参数
  tools-dev.ts     # 编程开发工具（terminal / read_file / write_file / list_dir / grep_search）
  tools-rag.ts     # 知识检索工具 retrieve_docs（只调 server/rag.ts，不直接碰网络细节）
  tools-*.ts       # 新增同类工具集按 tools-<主题>.ts 命名，一个文件一个主题
  agent/           # LangGraph 图定义（State/Node/Edge 全在这里；general.ts = 产品默认图）
  cli.ts           # CLI 入口；server/ 不 import cli，cli 可 import 一切
  server/          # HTTP/SSE 服务端：一个模块一个职责，单文件命名（rag.ts / files.ts / sessions.ts …）
  server/public/   # 前端三件套 index.html / style.css / app.js + 版本号常量 APP_VERSION
desktop/main.cjs   # Electron 主进程（CJS！package.json 是 "type":"module"，桌面端必须 .cjs）
docs/              # 公开文档（agent-wiki.md 等），只放用户可读内容
.plans/            # 开发过程内部文档：架构计划 / 阶段清单 / 攻面分析 / 私有交接。
                   # gitignore 挡住、**永不提交**（本仓库已公开，攻面细节 = 给攻击者的地图）
```

- 文档先分流再落笔：给用户/operator 看的 → `README.md` / `docs/`；给自己/AI 的工作过程文档
  → `.plans/`。`docs/` 与 `.plans/` 是双向禁令：内部文档不得进 `docs/`，用户文档不藏 `.plans/`。

- `src/agent/*` 只依赖 `src/` 顶层与 `@langchain/*`，**禁止 import `server/*`**（图要在 CLI 下可独立运行）。
- `src/server/*` 可以 import `src/` 顶层；互相之间通过导出函数协作，不做隐式单例外的全局状态。
- 前端 `public/app.js` 只能与 `/api/*` 通信，不 import 服务端代码。

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
  前端 `app.js` 的 `handleEvent` switch 加 case → 空数据/半途错误测试回放路径。
- SSE 帧即 `data: {json}\n\n`；一帧一事件；`done` 由 streamToClient 兜底补发，不要手写。

### 5.4 高风险操作审批（hitl.ts 为唯一登记处）
- 新的「执行后改世界」的工具（执行命令 / 写文件 / 发送外部消息…）必须在
  `hitl.ts` 的 `APPROVAL_TOOLS` 登记（含描述文案）；只读类工具（读/列/搜/检索）不登记、直接执行。
- 工具执行失败**不要 throw 穿透图**：返回「模型可读的中文错误文本」或 JSON `{error}`，让模型转述。

### 5.5 JSON 序列化陷阱（已踩两次的坑）
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
npm run typecheck            # tsc --noEmit，零报错
node --check src/server/public/app.js   # 前端语法门（无构建、无 lint，只能这样守）
node --check desktop/main.cjs           # 桌面端语法门
```

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
- Windows 上用 `spawn` 启动 `.cmd`（npx）必须 `shell: true`；杀进程树用 `taskkill /pid X /T /F`（desktop/main.cjs 已示范）。
- curl.exe 在 PS5.1 里的 JSON 引号极易坏，改用 `Invoke-RestMethod`。
- Web 服务端口固定 3000、桌面端 3123，测试用 3456+，不抢用户日常进程。

## 9. 文档同步（不是可选项）

- 每次交付**必须同步**更新：`README.md`（用户视角：功能怎么用） +
  `docs/agent-wiki.md`（模块视角：§3 加模块小节、§7 加/更新踩坑表）。
- **开发计划 / 攻面分析 / 阶段交接 → 只写 `.plans/`，永不进 git**（§3 目录职责）。
  需要向用户公开的结论（如「新增了认证」）提炼到 README / wiki 的功能说明层面，
  不带弱点清单、攻击路径、内部提交号对照表。
- 新增外部契约（对外 HTTP/RAG 形状）要在 README 用表格写全请求/响应示例。
- 提交信息用一行中文短句（「新增 xxx」「修复 xxx：原因」），与现有 git log 风格一致。

## 10. 提交规范

- 只改 `git status` 里本任务相关文件；`.env`、`.web-config.json`、`.plans/` 永不入库。
- **提交前清点**：`git status --short` 里不得出现 `.plans/`、临时测试脚本、
  含真实 Key/内网地址的文件；`git ls-files | grep -i plan` 应为空。
- 改动前 `git diff` 自查一遍：没有调试残留（console.log / 临时脚本 / 注释掉的代码块）。
- 大改动拆逻辑相邻的小提交；提交前必须过 §7 全部质量门。
