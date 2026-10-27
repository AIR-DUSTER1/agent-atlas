/**
 * ui/field.ts — label / 控件 / 说明 / 错误统一布局
 * ============================================================
 * 确保每个设置项有稳定可访问关系；错误文案用 aria-live 与 aria-describedby
 * 关联，不再只在页面底部显示一个全局状态。
 */
import { h } from "./h.js";

export interface FieldOptions {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  control: HTMLElement;
  className?: string;
}

export function field(options: FieldOptions): HTMLDivElement {
  const hintId = options.hint ? `${options.id}-hint` : "";
  const errorId = options.error ? `${options.id}-error` : "";
  const describedBy = [options.control.getAttribute("aria-describedby"), hintId, errorId].filter(Boolean).join(" ");
  if (!options.control.id) options.control.id = options.id;
  if (describedBy) options.control.setAttribute("aria-describedby", describedBy);
  if (options.error) options.control.setAttribute("aria-invalid", "true");
  return h("div", { class: ["ui-field", options.error ? "has-error" : "", options.className].filter(Boolean).join(" ") },
    h("label", { class: "ui-field-label", for: options.id }, options.label),
    options.control,
    options.hint ? h("p", { id: hintId, class: "ui-field-hint" }, options.hint) : null,
    h("p", {
      id: errorId || undefined,
      class: "ui-field-error",
      role: options.error ? "alert" : undefined,
      "aria-live": options.error ? "polite" : undefined,
      hidden: !options.error,
    }, options.error ?? ""),
  );
}
