# antdv-next 组件离线速查（agentatlas 常用子集）

> 版本基线：`antdv-next@1.8.2`（CLI 离线元数据到 1.5.2，API 未变的部分两者一致）。
> 本文件只收录本项目**实际用到或已评估**的组件；需要新组件时先跑
> `npx antdv info <C> --ver 1.5.2`，再把结论补进来，不要凭记忆加。

## 场景选型速查

| 场景 | 用 | 不要用 |
|---|---|---|
| 提交/取消按钮 | `Button`（`htmlType="submit"`） | 手写 `<button class="btn">` |
| 单行 / 多行文本 | `Input` / `Input.TextArea` | 手写 `ui-config-control` |
| 密码 | `Input.Password`（自带切换 + `aria-pressed`） | 手写密码框+眼睛按钮 |
| 开关 | `Switch`（原生 `role="switch"` + `aria-checked`） | 手写 role=switch 的 checkbox |
| 互斥选项 ≤4 | `Segmented` | `Select`（浮层成本不划算） |
| 下拉 | 无 `selectOption` 断言才用 `Select` | 有原生 select 断言时用 `<select>` |
| 服务端/区块错误 | `Alert` | 手写 `<p class="error">` |
| 字段校验错误 | 自建 `<p role="alert">` | `FormItem` 的 `help` |
| 空态 / 标签 | `Empty` / `Tag` | 手写 `.empty` / `.chip` |
| 二次确认 | `Popconfirm` 或项目 `uiConfirm` | `window.confirm` |
| 弹窗 | 项目既有 `#*-modal` 骨架 | `Modal`（会破坏遮罩与焦点契约） |

## 国际化与主题

```ts
import { ConfigProvider, theme } from "antdv-next";
import zhCN from "antdv-next/locale/zh_CN";
// theme.darkAlgorithm / theme.defaultAlgorithm / theme.compactAlgorithm
```

`ConfigProvider` 是纯上下文组件（**不产生包裹 DOM**），可安全包在任意根节点外层。
本项目统一经 `src/client/ui/antdv-provider.vue` 使用，不要直接写。

`ThemeConfig.token` 常用键（本项目已映射的加 ✅）：

| Token | 含义 | 项目对应 |
|---|---|---|
| `colorPrimary` | 主色 | ✅ `--accent` |
| `colorBgBase` | 全局底色 | ✅ `--bg` |
| `colorBgContainer` | 卡片/输入底 | ✅ `--bg-elev` |
| `colorBgElevated` | 浮层底 | ✅ `--bg-elev` |
| `colorBorder` | 边框 | ✅ `--border` |
| `colorText` / `colorTextSecondary` | 正文 / 次要 | ✅ `--text` / `--text-2` |
| `colorSuccess` / `colorError` / `colorWarning` | 状态色 | ✅ `--green` / `--red` / `--amber` |
| `borderRadius` / `SM` / `LG` | 圆角 | ✅ 9 / 6 / 14（`--radius-*`） |
| `fontSize` / `SM` / `LG` | 字号 | ✅ 13 / 12 / 15（`--font-*`） |
| `controlHeight` / `SM` / `LG` | 控件高度 | ✅ 34 / 28 / 38 |
| `lineWidthFocus` | 焦点线宽 | ✅ 0（项目用独立 `:focus-visible` 环） |

## Button

Props：`type`（`primary`/`default`/`dashed`/`link`/`text`）、`htmlType`、
`block`、`danger`、`ghost`、`loading`、`disabled`、`shape`、`size`、`icon`、
`color`、`variant`、`autoInsertSpace`（默认 `true`，两汉字间插空格）。
Events：`click`。Slots：`icon`、`loadingIcon`。

- 表单提交必须 `html-type="submit"`；`loading` 会自动禁用。
- 文本断言注意自动空格：`"登录" → "登 录"`。

## Input / Input.Password / Input.TextArea

Props：`value`、`allowClear`、`count`、`disabled`、`id`、`maxlength`、`prefix`、
`suffix`、`showCount`、`status`（`error`/`warning`）、`size`、`type`、`variant`。
Events：`change`、`pressEnter`、`clear`。

- `v-model:value`（不是 `v-model`）。
- `id` 透传到真实 `<input>`；`aria-*` 也透传。
- `Input.Password` 自带显示切换：`<span role="button" aria-label="显示" aria-pressed>`。
- **已废弃**：`addonAfter` / `addonBefore` / `bordered`（用 `variant` 替代）。

## Form / FormItem

`Form` Props：`layout`（`horizontal`/`vertical`）、`model`、`rules`、`labelAlign`、
`labelCol`、`wrapperCol`、`validateTrigger`、`disabled`、`size`、`scrollToFirstError`。
Events：`submit`、`finish`、`finishFailed`。

`FormItem` Props：`label`、`name`、`htmlFor`（或 `html-for`）、`validateStatus`、
`help`、`required`、`colon`、`extra`。

- `FormItem` 自动输出 `<label for="…">`，但**只有当你在插槽里放的是带 `id` 的单控件**时才对得上。
- ⚠ **`help` 渲染到 `.ant-form-item-explain-error`，不带 `role="alert"`**。
  需要播报的场景必须自建 `<p role="alert">`。
- `validateStatus="error"` 会同时给控件加 `ant-input-status-error` 类。

## Alert

Props：`type`（`success`/`info`/`warning`/`error`）、`title`、`message`、`description`、
`showIcon`、`closable`、`banner`、`role`。
**自带 `role="alert"`**，`message` 走纯文本（不解析 HTML），是服务端错误的正确载体。

## Switch

Props：`checked`（`v-model:checked`）、`disabled`、`loading`、`size`、
`checkedChildren` / `unCheckedChildren`、`checkedValue` / `unCheckedValue`。
渲染为 `<button role="switch" aria-checked="true|false">`，原生 `.click()` 可切换。

## Checkbox

Props：`checked`（`v-model:checked`）、`disabled`、`indeterminate`、`checkedValue`。
渲染为真实 `<input type="checkbox">`，原生 `.click()` 可切换。

## Select

Props：`value`（`v-model:value`）、`options`、`allowClear`、`disabled`、`mode`、
`showSearch`、`filterOption`、`placeholder`、`labelInValue`、`fieldNames`。

- ⚠ 渲染 `<div class="ant-select">…<input role="combobox">`，**不是原生 `<select>`**。
- e2e 里 `selectOption()` / `.value` 全部不可用。
- 需要保留原生 select 契约时，老实用 `<select>`。

## Segmented

Props：`value`（`v-model:value`）、`options`、`block`、`disabled`、`size`、`vertical`。
渲染 `role="radiogroup"` + `label > input[type=radio]` + `.ant-segmented-item-label`。
点击 `.ant-segmented-item` 即可切换（已实测）。

## Empty

Props：`description`（默认"暂无数据"，会被追加到自定义文案**前面**）、`image`。
⚠ 默认描述会拼在前面：`Empty description="还没有备份"` → 文本为 `"暂无数据还没有备份"`。
需要纯净文案时传 `:image="Empty.PRESENTED_IMAGE_SIMPLE"` 并断言 `toContain`。

## Tag

Props：`color`、`closable`、`disabled`、`icon`、`variant`、`bordered`。

## 未在本项目启用（不要擅自引入）

`Modal` / `Drawer` / `Popconfirm` 会自带遮罩、焦点陷阱与 teleport 目标，
与既有 `#*-modal` 骨架契约冲突；`Table` / `DatePicker` / `Upload` / `Tree`
体积大且当前无场景。要引入先论证体积与契约，再登记进工程规范 §3.1。
