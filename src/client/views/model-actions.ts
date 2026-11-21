/**
 * ============================================================
 * views/model-actions.ts — 供应商 / 模型的写操作与网关探测（M4 4.3 起）
 * ============================================================
 * 职责：保存供应商、删除供应商、添加/删除模型、激活模型、切换思考等级、
 * 拉取网关模型清单、加入待提交清单。全部经 stores/models 驱动，DOM 只剩
 * 状态条（model-status.ts，Vue 模板内的无绑定元素）。
 * 设计立场：
 *  - 每个写操作结束后统一 applyConfigState(await /api/config)：
 *    全站文案与 Vue 面板一处刷新，避免局部不同步；
 *  - 失败一律落到状态条（设置页内）或 uiAlert（页外），不抛穿透；
 *  - Key 留空 = 不修改：请求体里根本不带 apiKey 字段，服务端按缺省处理。
 */
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { prepareModelSwitch } from "../actions/model-switch.js";
import { uiAlert, uiConfirm } from "../ui/dialog.js";
import { applyConfigState } from "./composer-bar.js";
import { isSettingsPageOpen } from "./settings.js";
import {
  setGatewayStatus, setProviderModalStatus, setSettingsStatus,
} from "./model-status.js";
import type { AppConfig, GatewayModel, ModelEntry } from "../modules/types.js";

interface ProviderFormValues {
  name: string;
  baseURL: string;
  apiKey: string;
  protocol: string;
}

/** store 经动态 import 进入：model-actions 在 1:1 过渡树链上（composer-bar 引用），静态图不得出现 pinia。 */
async function store() {
  const { useModelsStore } = await import("../stores/models.js");
  return useModelsStore();
}

async function syncConfig(): Promise<void> {
  const cfg = await api<AppConfig>("/api/config");
  applyConfigState(cfg);
  (await store()).syncConfig(cfg);
}

/** 测试连接 / 拉取模型：pending=供应商弹窗表单；detail=右栏当前供应商。 */
export async function fetchGatewayModelChips(
  target: "detail" | "pending" = "detail",
  formValues?: ProviderFormValues,
): Promise<void> {
  const models = await store();
  const formOpen = target === "pending";
  const p = formOpen ? models.currentEditingProvider : models.selectedProvider;
  const baseURL = formOpen ? (formValues?.baseURL ?? "") : (p?.baseURL || "");
  const apiKeyRaw = formOpen ? (formValues?.apiKey ?? "") : "";
  if (!baseURL) { setGatewayStatus(target, "✗ 请先填写 BASE_URL", "err"); return; }
  const body: Record<string, unknown> = { baseURL };
  if (apiKeyRaw) body.apiKey = apiKeyRaw;
  else if (p?.id) body.providerId = p.id;
  body.protocol = formOpen
    ? (formValues?.protocol || "openai")
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
      models.setGatewayModels(res.models || []);
      setGatewayStatus(target, `✓ 连接成功，网关共 ${res.models?.length ?? 0} 个模型${formOpen ? " —— 点一下即可加入初始模型" : " —— 下面点一下即可添加"}`, "ok");
      // 拉取成功会把 context_length 写入服务端缓存 → 刷新配置以更新容量条分母
      if (res.contextWindow) await syncConfig();
    } else {
      setGatewayStatus(target, `✗ ${res.error || "连接失败"}`, "err");
    }
  } catch (err) {
    setGatewayStatus(target, `✗ ${(err as Error).message}`, "err");
  }
}

/** 新增供应商弹窗：把模型加入待提交清单。 */
export async function addPendingModelByName(name: string, meta: GatewayModel | null): Promise<void> {
  const models = await store();
  const modelName = (name || "").trim();
  if (!modelName) { setProviderModalStatus("✗ 模型名不能为空", "err"); return; }
  if (models.pendingModels.some((m) => m.name === modelName)) {
    setProviderModalStatus("✗ 该模型已在初始模型清单里", "err");
    return;
  }
  models.addPendingModel({
    name: modelName,
    modality: meta?.supportsVision ? "vision" : "text",
    contextWindow: meta?.contextWindow ?? null,
  });
  setProviderModalStatus(`✓ 已加入初始模型（保存供应商时一起提交，共 ${models.pendingModels.length} 个）`, "ok");
}

/** 把模型直接加到右栏当前供应商。 */
export async function addModelByName(name: string, meta: GatewayModel | null): Promise<void> {
  const models = await store();
  const modelName = (name || "").trim();
  if (!modelName) { setSettingsStatus("✗ 模型名不能为空", "err"); return; }
  const targetProviderId = models.selectedProviderId || models.editingProviderId;
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
      },
    );
    await syncConfig();
    models.selectProvider(targetProviderId);
    setSettingsStatus(res.created ? `✓ 已添加模型「${modelName}」并设为该供应商的启用模型` : `✓ 「${modelName}」已存在，已更新并设为启用模型`, "ok");
    models.openModelForm(targetProviderId, res.model.id);
  } catch (err) {
    setSettingsStatus(`✗ ${(err as Error).message}`, "err");
  }
}

/** 保存供应商（表单值由 Vue 弹窗传入；Key 留空 = 不修改）。 */
export async function saveProvider(form: ProviderFormValues): Promise<void> {
  const models = await store();
  const name = form.name.trim();
  const baseURL = form.baseURL.trim();
  const apiKeyRaw = form.apiKey;
  if (!name) { setProviderModalStatus("✗ 名称不能为空", "err"); return; }
  if (!baseURL) { setProviderModalStatus("✗ BASE_URL 不能为空", "err"); return; }

  const body: Record<string, unknown> = {
    name, baseURL,
    protocol: form.protocol || "openai",
  };
  if (apiKeyRaw) body.apiKey = apiKeyRaw; // 留空 = 不修改已保存的 Key

  try {
    const editingProviderId = models.editingProviderId;
    let nextProviderId = editingProviderId || models.selectedProviderId;
    let message = "";
    if (editingProviderId) {
      const res = await api<{ activeChanged?: boolean }>(`/api/config/providers/${editingProviderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      message = res.activeChanged ? "✓ 已保存并应用到当前会话配置" : "✓ 已保存（该供应商未启用）";
    } else {
      if (!models.pendingModels.length) {
        setProviderModalStatus("✗ 至少添加一个初始模型（可先点「获取列表」从网关选择）", "err");
        return;
      }
      body.models = models.pendingModels.map((m) => ({
        name: m.name, modality: m.modality, contextWindow: m.contextWindow ?? undefined,
      }));
      const res = await api<{ provider: { id: string; models: ModelEntry[] }; activeChanged?: boolean }>(
        "/api/config/providers",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      nextProviderId = res.provider.id;
      message = `✓ 已添加供应商（${res.provider.models.length} 个模型）${res.activeChanged ? "并启用" : ""}`;
    }

    await syncConfig();
    models.closeProviderForm();
    models.selectProvider(nextProviderId);
    setSettingsStatus(message, "ok");
  } catch (err) {
    setProviderModalStatus(`✗ ${(err as Error).message}`, "err");
  }
}

export async function removeModel(providerId: string, modelId: string, name: string): Promise<void> {
  if (!(await uiConfirm(`确定删除模型「${name}」？`, { title: "删除模型", okText: "删除", danger: true }))) return;
  const models = await store();
  try {
    await api(`/api/config/providers/${providerId}/models/${modelId}`, { method: "DELETE" });
    await syncConfig();
    if (models.editingModelId === modelId) models.closeModelForm();
    setSettingsStatus(`✓ 已删除模型「${name}」`, "ok");
  } catch (err) {
    setSettingsStatus(`✗ ${(err as Error).message}`, "err");
  }
}

/** 切换「供应商 + 模型」（顶栏下拉、模型行选中、设为启用模型 都走它） */
export async function activateModel(providerId: string, modelId: string | null): Promise<void> {
  try {
    if (modelId && !(await prepareModelSwitch(providerId, modelId))) return;
    const res = await api<{
      name: string; model: string; reasoningLabel?: string; mock?: boolean;
    }>("/api/config/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, modelId }),
    });
    await syncConfig();
    if (isSettingsPageOpen()) {
      setSettingsStatus(`✓ 已启用「${res.name} · ${res.model}」· 思考等级 ${res.reasoningLabel || "默认"}${res.mock ? "（无 Key → 模拟模式）" : ""}`, "ok");
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
    await syncConfig();
    const label = state.config?.reasoning?.label || level;
    if (isSettingsPageOpen()) {
      setSettingsStatus(`✓ 思考等级已切换为「${label}」`, "ok");
      const models = await store();
      const p = models.currentEditingProvider;
      const m = models.currentEditingModel;
      if (p && m) models.openModelForm(p.id, m.id);
    }
  } catch (err) {
    uiAlert(`思考等级切换失败：${(err as Error).message}`, "思考等级");
  }
}

export async function removeProvider(id: string, name: string): Promise<void> {
  if (!(await uiConfirm(`确定删除供应商「${name}」？（它下面的模型会一起删除）`, { title: "删除供应商", okText: "删除", danger: true }))) return;
  const models = await store();
  try {
    const wasEditing = models.editingProviderId === id;
    await api(`/api/config/providers/${id}`, { method: "DELETE" });
    await syncConfig();
    if (wasEditing) models.closeProviderForm();
    if (models.selectedProviderId === id) models.selectProvider(null);
    models.ensureSelection();
  } catch (err) {
    uiAlert(`删除失败：${(err as Error).message}`, "删除供应商");
  }
}
