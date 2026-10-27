/**
 * ui/input.ts — text / textarea / password / select 原语
 * ============================================================
 * 输入控件只生成可访问 DOM，不读全局 state；id / name / autocomplete 必须由
 * 调用方显式传入，方便 field 关联 label 与错误说明。
 */
import { h } from "./h.js";

export interface CommonInputOptions {
  id: string;
  name?: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  describedBy?: string;
  invalid?: boolean;
}

export function textInput(options: CommonInputOptions & { type?: "text" | "search" | "email" | "url" }): HTMLInputElement {
  return h("input", {
    id: options.id,
    name: options.name,
    class: ["ui-input", options.className].filter(Boolean).join(" "),
    type: options.type ?? "text",
    value: options.value ?? "",
    placeholder: options.placeholder,
    required: options.required,
    disabled: options.disabled,
    "aria-describedby": options.describedBy,
    "aria-invalid": options.invalid ? "true" : undefined,
    autocomplete: "off",
    spellcheck: "false",
  });
}

export function passwordInput(options: CommonInputOptions): HTMLInputElement {
  return h("input", {
    id: options.id,
    name: options.name,
    class: ["ui-input", options.className].filter(Boolean).join(" "),
    type: "password",
    value: options.value ?? "",
    placeholder: options.placeholder,
    required: options.required,
    disabled: options.disabled,
    "aria-describedby": options.describedBy,
    "aria-invalid": options.invalid ? "true" : undefined,
    autocomplete: "current-password",
    spellcheck: "false",
  });
}

export interface TextareaOptions extends CommonInputOptions {
  rows?: number;
  maxLength?: number;
}

export function textarea(options: TextareaOptions): HTMLTextAreaElement {
  return h("textarea", {
    id: options.id,
    name: options.name,
    class: ["ui-input", "ui-textarea", options.className].filter(Boolean).join(" "),
    rows: options.rows ?? 4,
    maxlength: options.maxLength,
    placeholder: options.placeholder,
    required: options.required,
    disabled: options.disabled,
    "aria-describedby": options.describedBy,
    "aria-invalid": options.invalid ? "true" : undefined,
  }, options.value ?? "");
}

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectOptions extends CommonInputOptions { options: SelectOption[] }

export function select(options: SelectOptions): HTMLSelectElement {
  const el = h("select", {
    id: options.id,
    name: options.name,
    class: ["ui-input", "ui-select", options.className].filter(Boolean).join(" "),
    required: options.required,
    disabled: options.disabled,
    "aria-describedby": options.describedBy,
    "aria-invalid": options.invalid ? "true" : undefined,
  });
  for (const item of options.options) {
    el.appendChild(h("option", { value: item.value, disabled: item.disabled, selected: item.value === options.value }, item.label));
  }
  return el;
}
