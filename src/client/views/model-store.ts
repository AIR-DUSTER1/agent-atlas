/**
 * ============================================================
 * views/model-store.ts — 设置页「供应商 × 模型」的编辑态与查询
 * ============================================================
 * 职责：持有设置页表单的临时状态（当前选中的供应商 / 正在编辑的模型 /
 * 待提交模型 / 网关模型清单），以及这批状态的 getter 与状态条文案。
 * 设计立场：
 *  - 这批状态只在设置页内有意义，不放进全局 state（避免跨页面污染）；
 *  - 其它模块一律通过这里的 getter 读取，不直接摸变量；
 *  - setSettingsStatus / setProviderModalStatus 也放这里：它们是同一批表单的反馈条。
 */

import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import type { GatewayModel, ModelEntry, ProviderEntry } from "../modules/types.js";

export let settingsFocusProviderId: string | null = null; // 从菜单「编辑」进来时高亮的供应商
export let selectedProviderId: string | null = null;     // 左栏当前选中的供应商
export let providerFormMode: "edit" | "create" | null = null;
export let editingProviderId: string | null = null;
export let editingModelId: string | null = null;
export let pendingModels: Array<{ name: string; modality: string; contextWindow: number | null }> = [];
export let gatewayModels: GatewayModel[] = [];

export function setSettingsFocus(id: string | null): void {
  settingsFocusProviderId = id;
}
export function setSelectedProviderId(id: string | null): void {
  selectedProviderId = id;
}
export function setProviderFormMode(mode: "edit" | "create" | null): void {
  providerFormMode = mode;
}
export function setEditingProviderId(id: string | null): void {
  editingProviderId = id;
}
export function setEditingModelId(id: string | null): void {
  editingModelId = id;
}
export function setPendingModels(next: typeof pendingModels): void {
  pendingModels = next;
}
export function setGatewayModels(next: GatewayModel[]): void {
  gatewayModels = next;
}

export function providers(): ProviderEntry[] {
  return state.config?.providers || [];
}

export function selectedProvider(): ProviderEntry | null {
  return providers().find((provider) => provider.id === selectedProviderId) ?? null;
}

export function currentEditingProvider(): ProviderEntry | null {
  return editingProviderId ? providers().find((x) => x.id === editingProviderId) ?? null : null;
}

export function currentEditingModel(): ModelEntry | null {
  const p = currentEditingProvider();
  return p && editingModelId ? (p.models || []).find((m) => m.id === editingModelId) ?? null : null;
}

/** 表单输入框取值（textarea / input 共用） */
export function setInput(id: string, value: string): void {
  const el = $(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (el) el.value = value;
}

export function inputValue(id: string): string {
  return (($(id) as HTMLInputElement | null)?.value || "").trim();
}

export function selectValue(id: string, fallback: string): string {
  return ($(id) as HTMLSelectElement | null)?.value || fallback;
}

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
