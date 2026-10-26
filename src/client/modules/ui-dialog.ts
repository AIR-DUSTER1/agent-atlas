/* ============================================================
   modules/ui-dialog.ts — 全局错误横幅 + 页面内对话框组件
   ============================================================
   从 app 拆出的「纯交互」层：
   - showFatalBanner：任何未捕获异常在页面顶部挂红色横幅（全局错误可见化）
   - uiAlert / uiConfirm / uiPrompt：替代原生 alert/confirm/prompt。
     原生对话框被部分浏览器环境（自动化参数、企业策略）拦截或样式突兀；
     这里用页面内组件实现同样语义：Promise 化，await 后拿结果。
   多个弹窗请求会串行排队展示，不会相互覆盖（见 uiDialogState.queue）。
   依赖 index.html 的 #ui-dialog-* 骨架。
   ============================================================ */

import type { HudDialogOptions } from "./types.js";

const $ = (id: string): HTMLElement | null => document.getElementById(id);

/** 全局错误可见化：任何未捕获异常都在页面上挂红色横幅（不再只进控制台） */
export function showFatalBanner(message: string): void {
  let banner = document.getElementById("fatal-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fatal-banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;background:#e5604f;color:#fff;" +
      "padding:8px 14px;font-size:12.5px;font-family:monospace;white-space:pre-wrap;" +
      "word-break:break-all;max-height:40vh;overflow:auto;";
    document.body.appendChild(banner);
  }
  banner.textContent = "⚠ 页面脚本错误（把这段文字发给助手排查）： " + message;
}

// 全局兜底：未捕获异常 / 未处理的 Promise 拒绝都推到横幅
window.addEventListener("error", (e) => showFatalBanner(e.message));
window.addEventListener("unhandledrejection", (e) => showFatalBanner(String(e.reason)));

interface QueuedDialog {
  options: HudDialogOptions;
  resolve: (value: string | boolean | null) => void;
}

const uiDialogState: {
  open: boolean;
  queue: QueuedDialog[];
  mode: "alert" | "confirm" | "prompt" | null;
  resolve: ((value: string | boolean | null) => void) | null;
} = { open: false, queue: [], mode: null, resolve: null };

function uiDialog(options: HudDialogOptions): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    uiDialogState.queue.push({ options, resolve });
    if (!uiDialogState.open) uiDialogShowNext();
  });
}

function uiDialogShowNext(): void {
  const next = uiDialogState.queue.shift();
  const mask = $("ui-dialog-mask");
  if (!next || !mask) { uiDialogState.open = false; return; }
  uiDialogState.open = true;
  const { title, message, mode, defaultValue = "", placeholder = "", okText, cancelText, danger } = next.options;
  const titleEl = $("ui-dialog-title");
  if (titleEl) titleEl.textContent = title || (mode === "confirm" ? "请确认" : "提示");
  const msgEl = $("ui-dialog-msg");
  if (msgEl) msgEl.textContent = message; // textContent 防注入；CSS pre-wrap 保留换行
  const inputRow = $("ui-dialog-input-row");
  const input = $("ui-dialog-input") as HTMLInputElement | null;
  inputRow?.classList.toggle("hidden", mode !== "prompt");
  if (input) {
    input.value = defaultValue;
    input.placeholder = placeholder;
    // 令牌类输入需要密文显示（password: true）
    input.type = next.options.password ? "password" : "text";
  }
  const okBtn = $("ui-dialog-ok");
  if (okBtn) {
    okBtn.textContent = okText || (mode === "alert" ? "知道了" : "确定");
    okBtn.className = "btn " + (danger ? "btn-danger" : "btn-approve");
  }
  const cancelBtn = $("ui-dialog-cancel");
  if (cancelBtn) {
    cancelBtn.textContent = cancelText || "取消";
    cancelBtn.classList.toggle("hidden", mode === "alert");
  }
  uiDialogState.mode = mode;
  uiDialogState.resolve = next.resolve;
  mask.classList.remove("hidden");
  if (mode === "prompt" && input) { input.focus(); input.select(); }
  else okBtn?.focus();
}

/** 关闭当前弹窗并回传结果；队列里还有就继续展示下一个 */
function uiDialogFinish(value: string | boolean | null): void {
  if (!uiDialogState.open) return;
  const resolve = uiDialogState.resolve;
  $("ui-dialog-mask")?.classList.add("hidden");
  uiDialogState.resolve = null;
  uiDialogState.mode = null;
  uiDialogState.open = false;
  resolve?.(value);
  uiDialogShowNext();
}

export function uiAlert(message: string, title?: string): Promise<string | boolean | null> {
  return uiDialog({ message, title, mode: "alert" });
}
export function uiConfirm(message: string, opts: Partial<HudDialogOptions> = {}): Promise<string | boolean | null> {
  return uiDialog({ message, mode: "confirm", ...opts });
}
export function uiPrompt(message: string, opts: Partial<HudDialogOptions> = {}): Promise<string | boolean | null> {
  return uiDialog({ message, mode: "prompt", ...opts });
}

/** 全局 Esc 兜底：关闭当前页内对话框；队列中的下一个由 uiDialogFinish 自动继续。 */
export function cancelActiveDialog(): void {
  uiDialogFinish(uiDialogState.mode === "prompt" ? null : false);
}

// 组件事件绑定（module 脚本在 DOM 解析完成后执行，元素此时已存在）
(() => {
  const mask = $("ui-dialog-mask");
  if (!mask) { console.warn("[ui-dialog] 未找到弹窗骨架，原生对话框将被兜底使用"); return; }
  const finishCancel = (): void => uiDialogFinish(uiDialogState.mode === "prompt" ? null : false);
  const promptValue = (): string => ($("ui-dialog-input") as HTMLInputElement | null)?.value ?? "";
  $("ui-dialog-ok")?.addEventListener("click", () => {
    uiDialogFinish(uiDialogState.mode === "prompt" ? promptValue() : true);
  });
  $("ui-dialog-cancel")?.addEventListener("click", finishCancel);
  mask.addEventListener("click", (e) => { if (e.target === mask) finishCancel(); });
  mask.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      uiDialogFinish(uiDialogState.mode === "prompt" ? promptValue() : true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishCancel();
    }
  });
})();
