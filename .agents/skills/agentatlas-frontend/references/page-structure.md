# 页面目录归属规则（工程规范 §4.1 详表）

> 本文件是 `$agentatlas-frontend` 的按需深入层：新建/移动页面、判断代码该落在
> 哪一层时再读。红线摘要见 SKILL.md；权威文档是 `.plans/development-docs/engineering-standards.md`。

## 目录归属

| 代码性质 | 归属 | 说明 |
|---|---|---|
| 页面专属 SFC / legacy 桥 / Vue 挂载模块 | `views/<page>/` | 一个页面一个目录，与页面同名 |
| 设置页分区 | `views/settings/<view>/` | 目录名必须与 `stores/settings.ts` 分区 key 一一对应 |
| 跨页共享逻辑 | `core/` / `modules/` / `stores/` | 上移而不是跨页 import |
| 跨页交互原语 / 图标 / 基础组件 | `ui/` | 图标白名单 `ui/icons.ts`，Vue 基础组件同层 |
| 通用消息渲染 | `render/` | 业务专属卡经增强注册表注入，不得 import 房产/求职实现 |

## 硬性禁令

- `views/` 根目录不得有文件（守门 `tests/unit/view-layout.test.ts`）。
- `src/client/apps/` 与 `src/client/pages/` 均已退役，不得回流。
- 叶子页面之间不得互相 import；共享需求一律上移 `core/` / `modules/` / `ui/` / `stores/`。
- 新增模块必须登记进 `tests/helpers/client-source.ts` 的 `CLIENT_SOURCES`，否则测试静默失效。

## 守门清单

- `tests/unit/view-layout.test.ts`：目录结构与 views 根目录纯净性。
- `tests/unit/client-architecture.test.ts`：auth-gate 覆盖层、antdv import 边界等。
- `tests/unit/framework-boundaries.test.ts`：组件不得 import `src/server/**`、状态只经 Pinia store。
