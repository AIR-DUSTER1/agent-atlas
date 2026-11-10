/**
 * ============================================================
 * ui/config-control.ts — 配置表单公共组件
 * ============================================================
 * 职责：统一标记配置输入框 / 文本域 / 下拉框，并提供动态字段组合入口。
 * 设计立场：
 *  - 新表单用 configField({ control, label, ... }) 组合，不在页面重复写控件壳；
 *  - 既有静态表单通过 enhanceConfigFields() 幂等水合，迁移无需重写整块 HTML；
 *  - 搜索框、开关、滑杆和文件选择器不属于配置值控件，不进入公共控件集合。
 */
import { field as createField, type FieldOptions } from "./field.js";

export const CONFIG_ROOT_SELECTOR = ":is(#settings-page, #provider-modal, #fs-modal, #kb-modal, #estate-modal, #job-modal)";

const CONTROL_TARGET_SELECTOR = `:is(
  .field > input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="hidden"]),
  .field > select,
  .field > textarea,
  .key-row > input:not([type="checkbox"]):not([type="radio"]),
  .key-row > textarea,
  .pf-select,
  .cap-ctx,
  .reason-custom,
  .routing-field > input:not([type="range"]),
  .routing-field > select,
  .routing-test-row > input,
  .memory-add-row > textarea
)`;

export const CONFIG_CONTROL_SELECTOR = `${CONFIG_ROOT_SELECTOR} ${CONTROL_TARGET_SELECTOR}`;

/** 给单个控件补公共组件标识；可重复调用，不改变 id/name/事件绑定。 */
export function enhanceConfigControl<T extends HTMLElement>(control: T): T {
  const textarea = control.tagName === "TEXTAREA";
  control.classList.add("ui-input");
  control.classList.add(textarea ? "ui-config-textarea" : "ui-config-control");
  control.dataset.uiComponent = "config-control";
  return control;
}

/** 动态表单组合入口：复用 field / input 原语，同时自动挂公共配置控件样式。 */
export function configField(options: FieldOptions): HTMLDivElement {
  return createField({ ...options, control: enhanceConfigControl(options.control) });
}

/** 静态 HTML 渐进增强：设置页及配置弹窗加载后调用一次即可。 */
export function enhanceConfigFields(root: ParentNode = document): number {
  const found = new Set<HTMLElement>();
  if (root instanceof Element && root.matches(CONFIG_CONTROL_SELECTOR)) {
    found.add(root as HTMLElement);
  }
  for (const control of root.querySelectorAll<HTMLElement>(CONFIG_CONTROL_SELECTOR)) {
    found.add(control);
  }
  for (const control of found) enhanceConfigControl(control);
  return found.size;
}
