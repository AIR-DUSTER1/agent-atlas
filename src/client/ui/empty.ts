/**
 * ui/empty.ts — 统一空态
 * ============================================================
 * 空态必须回答「为什么空」与「下一步做什么」；行动按钮由调用方注入，
 * 避免组件内部猜业务。
 */
import { h } from "./h.js";
import { icon, type IconName } from "./icon.js";

export interface EmptyOptions {
  title: string;
  description: string;
  iconName?: IconName;
  action?: HTMLElement;
  className?: string;
}

export function emptyState(options: EmptyOptions): HTMLElement {
  return h("div", { class: ["ui-empty", options.className].filter(Boolean).join(" ") },
    options.iconName ? h("div", { class: "ui-empty-icon" }, icon(options.iconName, { size: 22, strokeWidth: 1.6 })) : null,
    h("strong", { class: "ui-empty-title" }, options.title),
    h("p", { class: "ui-empty-description" }, options.description),
    options.action ?? null,
  );
}
