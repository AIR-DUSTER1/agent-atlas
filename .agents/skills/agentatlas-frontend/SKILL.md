---
name: agentatlas-frontend
description: "修改 agentatlas Web 前端、HTML 片段、CSS、设置页、可访问性或浏览器构建资产时使用；不用于后端接口、Agent 图或发布部署本身。"
---

# Agentatlas Frontend

## 开始前

1. 阅读项目根目录 `AGENTS.md` 和 `docs/engineering-standards.md`。
2. 确认改动属于 `src/client/**`、`src/client/pages/**` 或 `src/client/styles/**`。
3. 先找同页面/同组件基线，复用 `core/state.ts`、`core/dom.ts`、`ui/*`、`render/*` 与现有 API 层。

## 不可破坏的边界

- 前端只使用原生 TypeScript；禁止 React/Vue/Svelte、Vite/Webpack/Tailwind CLI 和整体打包器。
- 业务代码只通过 `/api/*` 访问服务端；不得 import 服务端源码或类型实现。
- npm 前端库只能经 `src/client/vendor/*` wrapper 接入；新增依赖必须先登记体积与许可证。
- 页面结构放 `src/client/pages/`；`index.html` 只保留根壳、CSP、build-info 注入点和 include 清单。
- CSS 按功能拆分并由入口显式加载；禁止恢复单体样式、循环 `@import` 或跨文件覆盖主题 token。
- 用户内容走 `textContent`、`h()` 或 `DOMPurify` 安全路径；禁止把用户输入拼进 `innerHTML`。
- 图标按钮必须有 `aria-label`/`title`；表单必须有 label 或 `aria-label`；流式区使用 live region。
- 图表、Markdown、高亮必须动态加载并有降级路径，不得进入 `main.ts` 启动闭包。
- 不手工修改版本号或日期构建号；构建脚本负责生成版本身份。

## 实施流程

1. 先确定是静态片段、动态渲染、状态、API 还是样式层的问题。
2. HTML 新片段使用 include；CSS 新文件加入入口清单；业务逻辑放对应模块而非 `main.ts`。
3. 新 API 消费需要服务端契约时，使用 `$agentatlas-service-contract`。
4. 新 Agent 工具卡或审批展示需要运行时语义时，使用 `$agentatlas-agent-runtime`。
5. 同时检查桌面端布局、移动宽度、键盘操作、Esc/遮罩关闭和 reduced-motion。

## 最低验证

```bash
npm run typecheck
npm run build:client
node --import tsx --test --test-concurrency=1 tests/unit/client-architecture.test.ts tests/unit/ui-styles.test.ts tests/unit/a11y.test.ts tests/unit/html-compose.test.ts
```

涉及交互时运行相关 Playwright 用例；页面、设置或消息渲染改动通常需要 `npm run e2e`。

## 收尾

- 更新 README 的用户操作说明和 `docs/agent-wiki.md`。
- 检查构建产物的 build-info、CSP hash、样式清单与静态白名单。
- 不提交 `src/server/public/`、截图、测试报告或临时浏览器数据。
