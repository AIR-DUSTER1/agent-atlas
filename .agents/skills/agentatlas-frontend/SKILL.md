---
name: agentatlas-frontend
description: "修改 agentatlas Web 前端、HTML 片段、CSS、设置页、可访问性或浏览器构建资产时使用；不用于后端接口、Agent 图或发布部署本身。"
---

# Agentatlas Frontend

## 开始前

1. 阅读项目根目录 `AGENTS.md` 和 `.plans/development-docs/engineering-standards.md`。
2. 确认改动属于 `src/client/views/<page>/**`（页面代码）、`src/client/ui/**`、
   `src/client/modules/**`、`src/client/core/**` 或 `src/client/styles/**`。
3. 先找同页面基线：`views/<page>/` 里已有的 SFC / legacy 桥 / 挂载模块就是范例，
   复用 `core/state.ts`、`core/dom.ts`、`ui/*`、`render/*` 与现有 API 层。

## 页面目录规范（工程规范 §4.1）

- **一个页面一个目录**：`views/<page>/`。页面专属的 SFC、legacy 桥、Vue 挂载模块同目录。
- `views/` 根目录不得有文件；`src/client/apps/` 与 `src/client/pages/` 均已退役不得回流。
- 设置页分区必须在 `views/settings/<view>/`，且与 `stores/settings.ts` 的分区 key 一一对应。
- 跨页共享上移到 `core/` / `modules/` / `ui/` / `stores/`；叶子页面之间不得互相 import。
- 守门：`tests/unit/view-layout.test.ts`（6 条），`npm test` 已包含。

## 不可破坏的边界

- 前端技术栈为 Vue 3 SFC + Pinia + antdv-next（限通用控件），构建链 Vite；新增页面不得再手写 `h()` DOM。
- 组件不得 import `src/server/**`；业务状态只能经 store，不得在组件内私建副本（`framework-boundaries.test.ts` 断言）。
- 业务代码只通过 `/api/*` 访问服务端；不得 import 服务端源码或类型实现。
- npm 前端库必须在工程规范 §3 登记体积与许可证；antdv 细则见 `$antdv` Skill。
- `index.html` 只保留根壳、CSP 与 build-info 注入点（片段机制已退役）。
- CSS 按功能拆分并由入口显式加载；禁止恢复单体样式、循环 `@import` 或跨文件覆盖主题 token。
- 用户内容走 `textContent`、`h()` 或 `DOMPurify` 安全路径；禁止把用户输入拼进 `innerHTML`。
- 图标按钮必须有 `aria-label`/`title`；表单必须有 label 或 `aria-label`；流式区使用 live region。
- 图表、Markdown、高亮必须动态加载并有降级路径，不得进入 `main.ts` 启动闭包。
- 不手工修改版本号或日期构建号；构建脚本负责生成版本身份。

## 实施流程

1. 先确定是页面结构、动态渲染、状态、API 还是样式层的问题。
2. 新页面建 `views/<page>/` 目录，组件 + 挂载模块同目录；业务逻辑放对应模块而非 `main.ts`。
3. 新 API 消费需要服务端契约时，使用 `$agentatlas-service-contract`。
4. 新 Agent 工具卡或审批展示需要运行时语义时，使用 `$agentatlas-agent-runtime`。
5. 同时检查桌面端布局、移动宽度、键盘操作、Esc/遮罩关闭和 reduced-motion。

## 最低验证

```bash
npm run typecheck
npm run build:client
node --import tsx --test --test-concurrency=1 tests/unit/view-layout.test.ts tests/unit/client-architecture.test.ts tests/unit/ui-styles.test.ts tests/unit/a11y.test.ts tests/unit/html-compose.test.ts
```

涉及交互时运行相关 Playwright 用例；页面、设置或消息渲染改动通常需要 `npm run e2e`。

## 收尾

- 更新 README 的用户操作说明和 `.plans/development-docs/agent-wiki.md`。
- 检查构建产物的 build-info、CSP hash、样式清单与静态白名单。
- 不提交 `src/server/public/`、截图、测试报告或临时浏览器数据。
