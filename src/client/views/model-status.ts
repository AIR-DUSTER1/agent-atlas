/**
 * ============================================================
 * views/model-status.ts — 模型管理状态条（框架迁移 M4 批次 4.3）
 * ============================================================
 * 职责：#settings-status / #provider-modal-status 两个状态条的统一写入口。
 * 两个元素都在 Vue 模板里以「无绑定元素」渲染，外部 DOM 写入安全；
 * 这是 legacy 消费方（model-actions / composer-bar）与 Vue 面板的共享反馈面。
 */
import { $ } from "../core/dom.js";

export function setSettingsStatus(text: string, kind: string): void {
  const el = $("settings-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

export function setProviderModalStatus(text: string, kind: string): void {
  const el = $("provider-modal-status");
  if (!el) return;
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

export function setGatewayStatus(target: "detail" | "pending", text: string, kind: string): void {
  if (target === "pending") setProviderModalStatus(text, kind);
  else setSettingsStatus(text, kind);
}
