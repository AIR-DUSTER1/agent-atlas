/**
 * ui/card.ts — 默认 / 交互 / 空态 / 危险卡片原语
 * ============================================================
 * 只提供结构与语义，不承担业务状态。交互卡必须由调用方使用 button 或在内部
 * 提供可键盘操作控件，避免把 div 伪装成按钮。
 */
import type { Child } from "./h.js";
import { h } from "./h.js";

export type CardTone = "default" | "interactive" | "empty" | "danger";
export interface CardOptions {
  tone?: CardTone;
  title?: string;
  className?: string;
  children?: Child[];
}

export function card(options: CardOptions = {}): HTMLElement {
  return h("section", { class: ["ui-card", `ui-card-${options.tone ?? "default"}`, options.className].filter(Boolean).join(" ") },
    options.title ? h("h3", { class: "ui-card-title" }, options.title) : null,
    h("div", { class: "ui-card-body" }, ...(options.children ?? [])),
  );
}
