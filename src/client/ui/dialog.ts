/**
 * ui/dialog.ts — 页面内对话框、队列、焦点陷阱与全局错误横幅
 * ============================================================
 * 不使用原生 alert/confirm/prompt：它们样式不可控、在自动化/企业策略下可能
 * 被拦截。多个请求串行排队；对话框关闭后恢复触发元素焦点，Tab 不逃出弹层。
 */
import { h } from "./h.js";

const $ = (id: string): HTMLElement | null => document.getElementById(id);

export interface DialogOptions {
  mode: "alert" | "confirm" | "prompt";
  message: string;
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  password?: boolean;
}
const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

export function showFatalBanner(message: string): void {
  let banner = document.getElementById("fatal-banner");
  if (!banner) {
    banner = h("div", { id: "fatal-banner", class: "fatal-banner", role: "alert" });
    document.body.appendChild(banner);
  }
  banner.textContent = "页面脚本错误（把这段文字发给助手排查）： " + message;
}

window.addEventListener("error", (event) => showFatalBanner(event.message));
window.addEventListener("unhandledrejection", (event) => showFatalBanner(String(event.reason)));

interface QueuedDialog {
  options: DialogOptions;
  resolve: (value: string | boolean | null) => void;
}

interface DialogState {
  open: boolean;
  queue: QueuedDialog[];
  mode: "alert" | "confirm" | "prompt" | null;
  resolve: QueuedDialog["resolve"] | null;
  previousFocus: HTMLElement | null;
}

const state: DialogState = { open: false, queue: [], mode: null, resolve: null, previousFocus: null };

function setPageInert(value: boolean): void {
  const app = $("app");
  if (!app) return;
  if (value) {
    app.setAttribute("aria-hidden", "true");
    if ("inert" in HTMLElement.prototype) app.setAttribute("inert", "");
  } else {
    app.removeAttribute("inert");
    app.removeAttribute("aria-hidden");
  }
}

function focusables(): HTMLElement[] {
  const dialog = $("ui-dialog");
  return dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden) : [];
}

function trapTab(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const items = focusables();
  if (!items.length) {
    $("ui-dialog")?.focus();
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    last?.focus();
    event.preventDefault();
  } else if (!event.shiftKey && document.activeElement === last) {
    first?.focus();
    event.preventDefault();
  }
}

function dialog(options: DialogOptions): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    state.queue.push({ options, resolve });
    if (!state.open) showNext();
  });
}

function showNext(): void {
  const next = state.queue.shift();
  const mask = $("ui-dialog-mask");
  if (!next || !mask) {
    state.open = false;
    state.mode = null;
    state.resolve = null;
    next?.resolve(next.options.mode === "prompt" ? null : false);
    return;
  }
  state.open = true;
  state.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const { title, message, mode, defaultValue = "", placeholder = "", okText, cancelText, danger } = next.options;
  const titleEl = $("ui-dialog-title");
  const msgEl = $("ui-dialog-msg");
  if (titleEl) titleEl.textContent = title || (mode === "confirm" ? "请确认" : "提示");
  if (msgEl) msgEl.textContent = message;

  const inputRow = $("ui-dialog-input-row");
  const input = $("ui-dialog-input") as HTMLInputElement | null;
  inputRow?.classList.toggle("hidden", mode !== "prompt");
  if (input) {
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.type = next.options.password ? "password" : "text";
  }

  const okButton = $("ui-dialog-ok") as HTMLButtonElement | null;
  if (okButton) {
    okButton.textContent = okText || (mode === "alert" ? "知道了" : "确定");
    okButton.className = "btn " + (danger ? "btn-danger" : "btn-approve");
  }
  const cancelButton = $("ui-dialog-cancel");
  if (cancelButton) {
    cancelButton.textContent = cancelText || "取消";
    cancelButton.classList.toggle("hidden", mode === "alert");
  }

  state.mode = mode;
  state.resolve = next.resolve;
  setPageInert(true);
  mask.classList.remove("hidden");
  $("ui-dialog")?.setAttribute("aria-describedby", "ui-dialog-msg");
  requestAnimationFrame(() => {
    if (mode === "prompt" && input) {
      input.focus();
      input.select();
    } else {
      (focusables()[0] ?? okButton as HTMLElement | null)?.focus();
    }
  });
}

function finish(value: string | boolean | null): void {
  if (!state.open) return;
  const resolve = state.resolve;
  const previous = state.previousFocus;
  $("ui-dialog-mask")?.classList.add("hidden");
  setPageInert(false);
  state.resolve = null;
  state.mode = null;
  state.open = false;
  state.previousFocus = null;
  resolve?.(value);
  previous?.focus();
  showNext();
}

export function uiAlert(message: string, title?: string): Promise<string | boolean | null> {
  return dialog({ message, title, mode: "alert" });
}

export function uiConfirm(message: string, options: Partial<DialogOptions> = {}): Promise<string | boolean | null> {
  return dialog({ message, mode: "confirm", ...options });
}

export function uiPrompt(message: string, options: Partial<DialogOptions> = {}): Promise<string | boolean | null> {
  return dialog({ message, mode: "prompt", ...options });
}

export function cancelActiveDialog(): void {
  finish(state.mode === "prompt" ? null : false);
}

export function isDialogOpen(): boolean {
  return state.open;
}

// module 脚本在 body 末尾执行，骨架此时已经存在；事件只在模块加载时绑定一次。
(() => {
  const mask = $("ui-dialog-mask");
  if (!mask) return;
  const cancel = (): void => finish(state.mode === "prompt" ? null : false);
  const promptValue = (): string => ($("ui-dialog-input") as HTMLInputElement | null)?.value ?? "";
  $("ui-dialog-ok")?.addEventListener("click", () => {
    finish(state.mode === "prompt" ? promptValue() : true);
  });
  $("ui-dialog-cancel")?.addEventListener("click", cancel);
  mask.addEventListener("click", (event) => { if (event.target === mask) cancel(); });
  mask.addEventListener("keydown", (event) => {
    trapTab(event);
    if (event.key === "Enter" && state.mode !== "prompt") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
})();
