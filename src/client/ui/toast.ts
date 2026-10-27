/**
 * ui/toast.ts — 非阻塞轻提示
 * ============================================================
 * 成功/一般信息用 polite，错误用 alert；自动消失前可通过 hover / focus 暂停，
 * 并提供显式关闭按钮。提示是辅助反馈，不承载必须确认的决策。
 */
import { h } from "./h.js";

export type ToastTone = "info" | "success" | "warning" | "error";
export interface ToastOptions {
  durationMs?: number;
  dismissible?: boolean;
}

const MAX_TOASTS = 4;
let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = h("div", { id: "ui-toast-region", class: "ui-toast-region", "aria-live": "polite", "aria-atomic": "false" });
  document.body.appendChild(region);
  return region;
}

export function toast(message: string, tone: ToastTone = "info", options: ToastOptions = {}): () => void {
  const host = ensureRegion();
  const root = h("div", {
    class: ["ui-toast", `ui-toast-${tone}`].join(" "),
    role: tone === "error" ? "alert" : "status",
  }, h("span", { class: "ui-toast-message" }, message));
  let timer: number | null = null;
  let remaining = options.durationMs ?? 4200;
  let startedAt = 0;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    root.classList.add("is-leaving");
    window.setTimeout(() => root.remove(), 120);
  };

  const pause = (): void => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - startedAt;
  };
  const resume = (): void => {
    if (closed || timer !== null || remaining <= 0) return;
    startedAt = Date.now();
    timer = window.setTimeout(close, remaining);
  };

  if (options.dismissible !== false) {
    root.appendChild(h("button", {
      class: "ui-toast-close",
      type: "button",
      "aria-label": "关闭提示",
      onclick: close,
    }, "×"));
  }
  root.addEventListener("pointerenter", pause);
  root.addEventListener("pointerleave", resume);
  root.addEventListener("focusin", pause);
  root.addEventListener("focusout", resume);
  host.appendChild(root);

  while (host.children.length > MAX_TOASTS) host.firstElementChild?.remove();
  startedAt = Date.now();
  timer = window.setTimeout(close, remaining);
  return close;
}
