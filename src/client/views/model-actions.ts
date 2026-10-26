/**
 * ============================================================
 * views/model-actions.ts — 供应商 / 模型的写操作与网关探测
 * ============================================================
 * 职责：保存供应商、删除供应商、添加/删除模型、激活模型、切换思考等级、
 * 拉取网关模型清单。
 * 设计立场：
 *  - 每个写操作结束后统一 applyConfigState(await /api/config)：
 *    全站文案（顶栏 / 侧栏 / chip / 容量条分母）一处刷新，避免局部不同步；
 *  - 失败一律落到状态条（设置页内）或 uiAlert（页外），不抛穿透；
 *  - Key 留空 = 不修改：请求体里根本不带 apiKey 字段，服务端按缺省处理。
 */

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { uiAlert, uiConfirm } from "../modules/ui-dialog.js";
import { applyConfigState } from "./composer-bar.js";
import { isSettingsPageOpen } from "./settings.js";
import { closeProviderForm } from "./model-form.js";
import { renderGatewayModels, renderModelPanel, renderPendingModels, renderProviderList } from "./model-panel.js";
import {
  currentEditingModel, currentEditingProvider, editingModelId, editingProviderId,
  inputValue, pendingModels, providerFormMode, selectedProviderId, selectedProvider,
  setEditingModelId, setEditingProviderId, setGatewayModels, setInput, setPendingModels,
  setProviderFormMode, setProviderModalStatus, setSelectedProviderId, setSettingsStatus,
  setGatewayStatus,
} from "./model-store.js";
import type { AppConfig, GatewayModel, ModelEntry, ProviderEntry } from "../modules/types.js";

/** 测试连接 / 拉取模型：pending=供应商弹窗表单；detail=右栏当前供应商。 */
export async function fetchGatewayModelChips(target: "detail" | "pending" = "detail"): Promise<void> {
  const formOpen = target === "pending";
  const p = formOpen ? currentEditingProvider() : selectedProvider();
  const baseURL = formOpen ? inputValue("pf-base-url") : (p?.baseURL || "");
  const apiKeyRaw = formOpen ? inputValue("pf-api-key") : "";
  if (!baseURL) { setGatewayStatus(target, "✗ 请先填写 BASE_URL", "err"); return; }
  const body: Record<string, unknown> = { baseURL };
  if (apiKeyRaw) body.apiKey = apiKeyRaw;
  else if (p?.id) body.providerId = p.id;
  body.protocol = formOpen
    ? (($("pf-protocol") as HTMLSelectElement | null)?.value || "openai")
    : (p?.protocol || "openai");

  setGatewayStatus(target, "正在连接网关…", "");
  try {
    const res = await api<{
      ok: boolean; models?: GatewayModel[]; error?: string; contextWindow?: number;
    }>("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setGatewayModels(res.models || []);
      renderGatewayModels(target);
      setGatewayStatus(target, `✓ 连接成功，网关共 ${res.models?.length ?? 0} 个模型${formOpen ? " —— 点一下即可加入初始模型" : " —— 下面点一下即可添加"}`, "ok");
      // 拉取成功会把 context_length 写入服务端缓存 → 刷新配置以更新容量条分母
      if (res.contextWindow) applyConfigState(await api<AppConfig>("/api/config"));
    } else {
      setGatewayStatus(target, `✗ ${res.error || "连接失败"}`, "err");
    }
  } catch (err) {
    setGatewayStatus(target, `✗ ${(err as Error).message}`, "err");
  }
}

/** 新增供应商弹窗：把模型加入待提交清单。 */
export function addPendingModelByName(name: string, meta: GatewayModel | null): void {
  const modelName = (name || "").trim();
  if (!modelName) { setProviderModalStatus("✗ 模型名不能为空", "err"); return; }
  if (pendingModels.some((m) => m.name === modelName)) {
    setProviderModalStatus("✗ 该模型已在初始模型清单里", "err");
    return;
  }
  setPendingModels([...pendingModels, {
    name: modelName,
    modality: meta?.supportsVision ? "vision" : "text",
    contextWindow: meta?.contextWindow ?? null,
  }]);
  setInput("pf-new-model-name", "");
  renderPendingModels();
  renderGatewayModels("pending");
  setProviderModalStatus(`✓ 已加入初始模型（保存供应商时一起提交，共 ${pendingModels.length} 个）`, "ok");
}

/** 把模型直接加到右栏当前供应商。 */
export async function addModelByName(name: string, meta: GatewayModel | null): Promise<void> {
  const modelName = (name || "").trim();
  if (!modelName) { setSettingsStatus("✗ 模型名不能为空", "err"); return; }
  const targetProviderId = selectedProviderId || editingProviderId;
  if (!targetProviderId) { setSettingsStatus("✗ 请先从左侧选择供应商", "err"); return; }
  try {
    const res = await api<{ created?: boolean; model: ModelEntry }>(
      `/api/config/providers/${targetProviderId}/models`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: modelName,
          modality: meta?.supportsVision ? "vision" : undefined,
          contextWindow: meta?.contextWindow ?? undefined,
        }),
      }
    );
    applyConfigState(await api<AppConfig>("/api/config"));
    setInput("pf-model-new", "");
    renderGatewayModels("detail");
    setSettingsStatus(res.created ? `✓ 已添加模型「${modelName}」并设为该供应商的启用模型` : `✓ 「${modelName}」已存在，已更新并设为启用模型`, "ok");
    setSelectedProviderId(targetProviderId);
    const { openModelForm } = await import("./model-form.js");
    openModelForm(targetProviderId, res.model.id);
  } catch (err) {
    setSettingsStatus(`✗ ${(err as Error).message}`, "err");
  }
}

export async function saveProvider(): Promise<void> {
  const name = inputValue("pf-name");
  const baseURL = inputValue("pf-base-url");
  const apiKeyRaw = inputValue("pf-api-key");
  if (!name) { setProviderModalStatus("✗ 名称不能为空", "err"); return; }
  if (!baseURL) { setProviderModalStatus("✗ BASE_URL 不能为空", "err"); return; }

  const body: Record<string, unknown> = {
    name, baseURL,
    protocol: ($("pf-protocol") as HTMLSelectElement | null)?.value || "openai",
  };
  if (apiKeyRaw) body.apiKey = apiKeyRaw; // 留空 = 不修改已保存的 Key

  try {
    let nextProviderId = editingProviderId || selectedProviderId;
    let message = "";
    if (editingProviderId) {
      const res = await api<{ activeChanged?: boolean }>(`/api/config/providers/${editingProviderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      message = res.activeChanged ? "✓ 已保存并应用到当前会话配置" : "✓ 已保存（该供应商未启用）";
    } else {
      if (!pendingModels.length) {
        setProviderModalStatus("✗ 至少添加一个初始模型（可先点「获取列表」从网关选择）", "err");
        return;
      }
      body.models = pendingModels.map((m) => ({
        name: m.name, modality: m.modality, contextWindow: m.contextWindow ?? undefined,
      }));
      const res = await api<{ provider: ProviderEntry; activeChanged?: boolean }>("/api/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      nextProviderId = res.provider.id;
      message = `✓ 已添加供应商（${res.provider.models.length} 个模型）${res.activeChanged ? "并启用" : ""}`;
    }

    applyConfigState(await api<AppConfig>("/api/config"));
    setProviderFormMode(null);
    setEditingProviderId(null);
    setEditingModelId(null);
    setPendingModels([]);
    setGatewayModels([]);
    setSelectedProviderId(nextProviderId);
    $("provider-modal-mask")?.classList.add("hidden");
    $("model-form-wrap")?.classList.add("hidden");
    renderProviderList();
    setSettingsStatus(message, "ok");
  } catch (err) {
    setProviderModalStatus(`✗ ${(err as Error).message}`, "err");
  }
}

export async function removeModel(providerId: string, modelId: string, name: string): Promise<void> {
  if (!(await uiConfirm(`确定删除模型「${name}」？`, { title: "删除模型", okText: "删除", danger: true }))) return;
  try {
    await api(`/api/config/providers/${providerId}/models/${modelId}`, { method: "DELETE" });
    applyConfigState(await api<AppConfig>("/api/config"));
    if (editingModelId === modelId) {
      const { closeModelForm } = await import("./model-form.js");
      closeModelForm();
    }
    renderModelPanel();
    setSettingsStatus(`✓ 已删除模型「${name}」`, "ok");
  } catch (err) {
    setSettingsStatus(`✗ ${(err as Error).message}`, "err");
  }
}

/** 切换「供应商 + 模型」（顶栏下拉、供应商列表的模型 chip、设为启用模型 都走它） */
export async function activateModel(providerId: string, modelId: string | null): Promise<void> {
  try {
    const res = await api<{
      name: string; model: string; reasoningLabel?: string; mock?: boolean;
    }>("/api/config/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, modelId }),
    });
    applyConfigState(await api<AppConfig>("/api/config"));
    if (isSettingsPageOpen()) {
      setSettingsStatus(`✓ 已启用「${res.name} · ${res.model}」· 思考等级 ${res.reasoningLabel || "默认"}${res.mock ? "（无 Key → 模拟模式）" : ""}`, "ok");
      renderModelPanel();
    }
  } catch (err) {
    if (isSettingsPageOpen()) setSettingsStatus(`✗ ${(err as Error).message}`, "err");
    else uiAlert(`切换失败：${(err as Error).message}`, "切换模型");
  }
}

/** 顶栏快捷调整当前模型的思考等级（档位来自该供应商的方言） */
export async function setReasoningLevel(level: string): Promise<void> {
  try {
    await api("/api/config/reasoning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    });
    applyConfigState(await api<AppConfig>("/api/config"));
    const label = state.config?.reasoning?.label || level;
    if (isSettingsPageOpen()) {
      setSettingsStatus(`✓ 思考等级已切换为「${label}」`, "ok");
      const p = currentEditingProvider();
      const m = currentEditingModel();
      if (p && m) {
        const { openModelForm } = await import("./model-form.js");
        openModelForm(p.id, m.id);
      }
    }
  } catch (err) {
    uiAlert(`思考等级切换失败：${(err as Error).message}`, "思考等级");
  }
}

export async function removeProvider(id: string, name: string): Promise<void> {
  if (!(await uiConfirm(`确定删除供应商「${name}」？（它下面的模型会一起删除）`, { title: "删除供应商", okText: "删除", danger: true }))) return;
  try {
    const wasEditing = editingProviderId === id;
    await api(`/api/config/providers/${id}`, { method: "DELETE" });
    applyConfigState(await api<AppConfig>("/api/config"));
    if (wasEditing) closeProviderForm();
    if (selectedProviderId === id) setSelectedProviderId(null);
    renderProviderList();
  } catch (err) {
    uiAlert(`删除失败：${(err as Error).message}`, "删除供应商");
  }
}
