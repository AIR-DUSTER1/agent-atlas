/**
 * ui/button.ts — 统一按钮原语
 * ============================================================
 * 只负责视觉变体、可访问性与 loading 状态，不绑定业务事件。调用方通过
 * onClick 注入行为；字符串事件处理器被 h() 拒绝。
 */
import { h } from "./h.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md";
export interface ButtonOptions {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit" | "reset";
  title?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const variant = options.variant ?? "secondary";
  const size = options.size ?? "md";
  return h("button", {
    type: options.type ?? "button",
    class: ["ui-button", `ui-button-${variant}`, `ui-button-${size}`, options.className].filter(Boolean).join(" "),
    title: options.title,
    disabled: options.disabled || options.loading,
    "aria-busy": options.loading ? "true" : undefined,
    onclick: options.onClick,
  },
  options.loading ? h("span", { class: "ui-button-spinner", "aria-hidden": "true" }) : null,
  h("span", { class: "ui-button-label" }, options.label));
}

/** 运行中切换 loading，同时保留原 disabled 语义。 */
export function setButtonLoading(el: HTMLButtonElement, loading: boolean): void {
  if (loading && el.disabled) el.dataset.wasDisabled = "1";
  el.classList.toggle("is-loading", loading);
  el.disabled = loading || el.dataset.wasDisabled === "1";
  el.setAttribute("aria-busy", String(loading));
  let spinner = el.querySelector<HTMLElement>(".ui-button-spinner");
  if (loading && !spinner) {
    spinner = h("span", { class: "ui-button-spinner", "aria-hidden": "true" });
    el.prepend(spinner);
  } else if (!loading) {
    spinner?.remove();
    delete el.dataset.wasDisabled;
  }
}
