---
name: antdv
description: 使用 antdv-next 组件库编写、重构或排查 agentatlas 前端组件时使用；覆盖组件选型、Props/Events/Slots 查询、主题 token 映射、表单与可访问性契约。不用于纯后端接口、Agent 图或发布部署改动。
---

# antdv-next（agentatlas 适配层）

> 上游权威：<https://www.antdv-next.com/docs/vue/for-agents-cn.md>、官方 Skill
> <https://github.com/antdv-next/cli/blob/main/skills/antdv/SKILL.md>。
> 本文件只补「在 agentatlas 里怎么用、哪些不能用」。冲突时以 `AGENTS.md` 与
> `.plans/development-docs/engineering-standards.md` 为准。

先读 `AGENTS.md` 与工程规范 §3、§5。

## 铁律：查 API 前不要凭记忆写

```bash
npx antdv info Button --ver 1.5.2     # Props / Events / Slots / 默认值
npx antdv doc Button                  # 完整 Markdown
npx antdv demo Select basic           # 可运行 Demo
npx antdv token Button                # Design Token
npx antdv semantic Table              # class / styles 语义结构
```

- **必须带 `--ver 1.5.2`**：随包离线元数据只到 1.5.2，而项目是 1.8.x；不带版本时
  CLI 会拿 `^1.8.2` 去查不存在的元数据并报 `v1.8.2 not found`（CLI 缺陷，非用法错）。
- **`antdv lint` / `antdv usage` 是空壳**（只打印 `Parsed args`，永远退出 0）。
  不得写进质量门冒充覆盖；退化 API 由 `tests/unit/antdv-usage.test.ts` 断言。

## 本项目的六条硬约束

1. **只在页面 SFC（`views/<page>/**/*.vue`）里 import**。`.ts` 不得 import `antdv-next`
   （`tests/unit/client-architecture.test.ts` 守门）。
2. **模板最外层包 `<AntdvProvider>`**：它承载深/浅主题 + 中文 locale，且不产生包裹元素。
   自建 `ConfigProvider` 或私有 `theme.token` 视为违规。
   import 路径按 SFC 所在层级补 `../` 指向 `src/client/ui/antdv-provider.vue`
   （页面已按 `views/<page>/` 组织，深度随目录变化，不要在文档里写死相对层级）。
3. **`darkAlgorithm` 不是顶层具名导出**，只能 `import { theme }` 后用
   `theme.darkAlgorithm`。顶层具名导入过 tsc 但 Vite 报 `MISSING_EXPORT`。
4. **DOM 契约优先于"用上组件库"**（按需深入层有坑表与 e2e 驱动方式）。
5. **主题只能改 `ui/antdv-theme.ts` 的种子表**，它必须与 `styles/tokens.css` 同源；
   单点微调用组件自带 `classes`/`styles`，禁止 `!important` 覆盖 `.ant-*`。
6. **体积必须留在懒加载**：antdv 引入链全程经动态 import。改完跑
   `npm run build:client`，确认 `grep -c "ant-btn\|css-var-v-" assets/app.js` 为 0。

## 改造一个新面板

1. `npx antdv info <C> --ver 1.5.2` 确认 Props/Events/Slots。
2. SFC 包 `<AntdvProvider>`，控件全用 antdv，不混手写控件。
3. `grep` 测试文件，逐个核对既有 `id`/`class`/`role` 是否仍存在。
4. 字段错误 `role="alert"`，服务端错误 `Alert`。
5. `npm run typecheck && npm run test:vue`；新增组件要登记进 `antdv-usage.test.ts`。
6. `npm run build:client`，确认 `app.js` 无 `ant-*` 特征串。

## 三个已踩过的陷阱（务必先看）

1. **`<Switch>` 必须首字母大写、且不能 import 别名**
   `<switch>` 会被当原生元素（DOM 里出现幽灵 `<switch>`，组件完全不生效）；
   `import { Switch as ASwitch }` 后写 `<ASwitch>` 也解析不到 —— `<script setup>`
   只把**原始名**暴露给模板。正确：`import { Switch }` + `<Switch>`。
2. **Select 的 `aria-label` 落在最外层 `.ant-select` 容器**，不在内部 combobox input 上。
3. **数字输入不要用 antdv `Input`**：实测 `v-model.number` 不生效（值是字符串）。
   项目里 17 个数字字段保持原生 `<input type="number">`。

## 按需深入（渐进式披露）

写代码时才读对应文件，不要一次性全读：

- 选组件 / 查 Props·Events·Slots / 主题 token 映射 →
  `references/components-cheatsheet.md`（含场景选型速查表；先查 CLI 再补录）。
- 写 / 改 e2e 与组件驱动断言（原生事件替代 API、`selectOption` 为什么失效、
  契约坑表）→ `references/testing-contract.md`。

收尾：体积登记进工程规范 §3.1，用法变化写 `.plans/development-docs/agent-wiki.md`；
不提交 `src/server/public/`、截图或测试报告。
