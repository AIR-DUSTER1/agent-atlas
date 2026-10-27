/**
 * ============================================================
 * observability/client-errors.ts — 浏览器错误摘要上报
 * ============================================================
 * 只上报错误类型/摘要、前端版本与视图名；绝不发送 stack、对话、附件或令牌。
 * 同页最多 20 条且按摘要去重，避免错误风暴打满服务端。
 */
import { APP_VERSION } from "../core/state.js";

let installed = false;
const sent = new Set<string>();
const MAX_REPORTS = 20;

function currentView(): string {
  if (document.body.classList.contains("settings-open")) return "settings";
  if (document.body.classList.contains("sidebar-open")) return "workspace-sidebar";
  return "workspace";
}

function summarize(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`.replace(/\s+/g, " ").trim().slice(0, 300);
  return String(value ?? "unknown").replace(/\s+/g, " ").trim().slice(0, 300);
}

function report(message: unknown): void {
  if (sent.size >= MAX_REPORTS) return;
  const summary = summarize(message);
  if (!summary || sent.has(summary)) return;
  sent.add(summary);
  void fetch("/api/client-errors", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: summary, version: APP_VERSION, view: currentView() }),
  }).catch(() => {});
}

/** 在 init 之前调用；重复调用无副作用。 */
export function installClientErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => report(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => report(event.reason));
}
