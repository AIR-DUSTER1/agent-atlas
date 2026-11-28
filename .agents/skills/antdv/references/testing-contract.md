# antdv-next e2e / 组件驱动契约（已实测）

> 本文件是 `$antdv` 技能的按需深入层：写或改 e2e、组件交互断言时再读。
> SKILL.md 的六条硬约束与三个陷阱仍然优先；冲突时以 SKILL.md 与 `AGENTS.md` 为准。

## 控件替换的坑（已实测）

| 契约 | 结论 |
|---|---|
| `id` 透传 | `Input`/`Button`/`Select`/`Switch`/`Segmented` 都把 `id` 落到真实可交互元素 |
| 原生事件 | `el.value=…; dispatchEvent(new Event("input"))` 可驱动 `v-model:value`；`el.click()` 可驱动 `Switch`/`Checkbox` |
| `Select` ≠ `<select>` | 渲染 `<input role="combobox">` + 浮层。`selectOption()`/`.value` 断言全部失效 → 改用原生 `<select>`，或同步改写断言 |
| `FormItem help` | **不带 `role="alert"`**。字段错误必须自建 `<p role="alert">`；服务端错误用 `Alert`（自带该 role） |
| `Button` 中文字距 | 两个汉字间自动插空格（"登录"→"登 录"）。断言用 `toContain` 或 `:auto-insert-space="false"` |
| 焦点环 | 项目已有全局 `:focus-visible`，主题里 `lineWidthFocus: 0`，不要叠加组件阴影 |

## e2e 驱动方式

```ts
await selectAntdvOption(page, "#tracing-backend", "LangSmith 云端");  // Select
expect(await antdvSelectText(page, "#tracing-backend")).toBe("关闭（默认）");
await page.locator('[role="switch"]').click();                       // Switch
await expect(locator).toHaveAttribute("aria-checked", "true");
```

`selectOption()` / `toHaveValue()` / `uncheck()` 对 antdv 组件全部无效。

## 断言取舍速记

- 文本断言一律 `toContain`：中文字距、`Empty` 默认描述拼接都会破坏 `toBe` 精确匹配。
- 状态断言断 `aria-*`（`aria-checked`），不断内部类名（`.ant-*` 由主题控制，随版本漂移）。
- 浮层组件（Select 下拉）断言用 `role="combobox"` 的输入框 + `aria-label`，不要找 `.ant-select-dropdown` 节点层级。
