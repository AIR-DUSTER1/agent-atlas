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

/** 在静态表单的 .field 容器内显示就地错误，并维护 aria-describedby/invalid。 */
export function setFieldError(controlId: string, message: string): void {
  const control = document.getElementById(controlId);
  if (!control) return;
  let field = control.closest<HTMLElement>(".field, .ui-field");
  if (!field) field = control.parentElement;
  if (!field) return;
  let error = field.querySelector<HTMLElement>(`[data-field-error-for="${controlId}"]`);
  if (!error) {
    error = h("p", { class: "ui-field-error", role: "alert", "aria-live": "polite", dataset: { fieldErrorFor: controlId } });
    field.appendChild(error);
  }
  const errorId = `${controlId}-field-error`;
  error.id = errorId;
  error.textContent = message;
  error.hidden = !message;
  control.setAttribute("aria-invalid", message ? "true" : "false");
  const describedBy = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== errorId);
  if (message) describedBy.push(errorId);
  if (describedBy.length) control.setAttribute("aria-describedby", describedBy.join(" "));
  else control.removeAttribute("aria-describedby");
}

export function clearFieldError(controlId: string): void {
  setFieldError(controlId, "");
}
