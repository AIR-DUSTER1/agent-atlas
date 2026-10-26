/**
 * ============================================================
 * views/model-form.ts — 供应商连接弹窗 + 单模型编辑面板
 * ============================================================
 * 职责：供应商新增/编辑表单的开合与回填，模型编辑面板（名称 / 显示名 /
 * 多模态 / 上下文窗口 / 思考等级方言与档位）。
 * 设计立场：
 *  - API Key 只写不读：编辑时留空 = 保持不变，界面只显示服务端回的掩码；
 *  - 方言与协议不匹配时给明确提示（llm.ts 会近似换算，不会静默丢弃）；
 *  - 表单状态全部落在 model-store，本模块只负责 DOM 读写与校验提示。
 */

import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import {
  currentEditingModel, currentEditingProvider, inputValue, providers,
  setEditingModelId, setEditingProviderId, setInput, setProviderFormMode,
  setProviderModalStatus,
} from "./model-store.js";
import { renderGatewayModels, renderModelPanel, renderPendingModels, renderProviderList } from "./model-panel.js";
import { setGatewayModels, setPendingModels } from "./model-store.js";
import { isSettingsPageOpen } from "./settings.js";
import type { DialectInfo, ReasoningLevel } from "../modules/types.js";

export function openProviderForm(providerId: string | null, focusModelId?: string): void {
  setProviderFormMode(providerId ? "edit" : "create");
  setEditingProviderId(providerId || null);
  if (providerId) {
    void import("./model-store.js").then((m) => m.setSelectedProviderId(providerId));
  }
  setEditingModelId(null);
  const p = currentEditingProvider();
  const title = $("provider-modal-title");
  if (title) title.textContent = p ? "编辑供应商" : "添加供应商";
  const sub = $("provider-modal-sub");
  if (sub) {
    sub.textContent = p
      ? "修改连接信息不会影响已配置模型；API Key 留空表示保持原值。"
      : "填写连接信息并添加至少一个初始模型，保存后即可在左侧切换。";
  }
  const mode = $("pf-mode");
  if (mode) {
    mode.textContent = p ? p.name : "新增供应商";
    mode.className = "key-state" + (p ? " ok" : "");
  }
  setInput("pf-name", p?.name || "");
  setInput("pf-base-url", p?.baseURL || "");
  setInput("pf-api-key", "");
  const keyInput = $("pf-api-key") as HTMLInputElement | null;
  if (keyInput) keyInput.type = "password";
  const proto = $("pf-protocol") as HTMLSelectElement | null;
  if (proto) proto.value = p?.protocol || "openai";
  const keyState = $("pf-key-state");
  if (keyState) {
    keyState.textContent = p ? (p.hasKey ? `已保存 ${p.keyMasked || ""}，留空则不修改` : "未保存 Key") : "";
    keyState.className = "key-state" + (p?.hasKey ? " ok" : "");
  }
  setInput("pf-new-model-name", "");
  $("pf-initial-models")?.classList.toggle("hidden", Boolean(p));
  const testBtn = $("pf-test");
  if (testBtn) testBtn.textContent = p ? "测试连接" : "测试连接 / 拉取模型";
  setGatewayModels([]);
  if (!p) setPendingModels([]);
  $("provider-modal-mask")?.classList.remove("hidden");
  closeModelForm();
  renderProviderList();
  renderPendingModels();
  renderGatewayModels("pending");
  setProviderModalStatus("", "");
  requestAnimationFrame(() => $("pf-name")?.focus());
  if (focusModelId && p) openModelForm(p.id, focusModelId);
}

export function closeProviderForm(): void {
  const mask = $("provider-modal-mask");
  if (!mask) return;
  mask.classList.add("hidden");
  setProviderFormMode(null);
  setEditingProviderId(null);
  setEditingModelId(null);
  setPendingModels([]);
  setGatewayModels([]);
  setInput("pf-new-model-name", "");
  const gw = $("pf-new-gateway-models");
  if (gw) gw.innerHTML = "";
  setProviderModalStatus("", "");
  if (isSettingsPageOpen()) renderProviderList();
}

export function closeModelForm(): void {
  setEditingModelId(null);
  $("model-form-wrap")?.classList.add("hidden");
}

/** 单个模型的编辑面板（模型名 / 显示名 / 多模态 / 上下文 / 思考等级） */
export function openModelForm(providerId: string, modelId: string): void {
  const p = providers().find((x) => x.id === providerId);
  const m = p && (p.models || []).find((x) => x.id === modelId);
  if (!p || !m) return;
  setEditingProviderId(p.id);
  setEditingModelId(m.id);
  const mode = $("mf-mode");
  if (mode) {
    mode.textContent = `${p.name} · ${m.displayName}`;
    mode.className = "key-state ok";
  }
  setInput("mf-name", m.name);
  setInput("mf-label", m.displayName === m.name ? "" : m.displayName);
  const vision = $("mf-vision") as HTMLInputElement | null;
  if (vision) vision.checked = m.modality === "vision";
  setInput("mf-ctx", m.manualContextWindow ? String(m.manualContextWindow) : "");
  renderDialectSelect(m.reasoning?.dialect || "auto", m.reasoning?.level || "default", m.reasoning?.custom || "");
  $("model-form-wrap")?.classList.remove("hidden");
  renderModelPanel();
  $("mf-name")?.focus();
}

/** 「思考等级划分方式」下拉：自动识别 + 全部方言（每家供应商的档位都不一样） */
export function renderDialectSelect(dialect: string, level: string, custom: string): void {
  const dialects: DialectInfo[] = state.config?.dialects || [];
  const dSel = $("mf-dialect") as HTMLSelectElement | null;
  if (!dSel) return;
  dSel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "自动识别（按网关地址 / 模型名判断）";
  dSel.appendChild(auto);
  for (const d of dialects) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.label} —— ${d.vendor}`;
    opt.title = d.scheme;
    dSel.appendChild(opt);
  }
  dSel.value = dialect;
  renderLevelSelect(dialect, level, custom);
}

/** 「思考等级」下拉：档位来自选中的方言（OpenAI 五档 / 智谱两态 / Anthropic 预算…） */
export function renderLevelSelect(dialect: string, level: string, custom: string): void {
  const cfg = state.config;
  const dialects: DialectInfo[] = cfg?.dialects || [];
  const effective = dialect === "auto" ? (cfg?.reasoning?.dialect || "none") : dialect;
  const d = dialects.find((x) => x.id === effective);
  const lSel = $("mf-level") as HTMLSelectElement | null;
  if (!lSel) return;
  lSel.innerHTML = "";
  const levels: ReasoningLevel[] = d?.levels || [{ id: "default", label: "供应商默认", desc: "" }];
  for (const lv of levels) {
    const opt = document.createElement("option");
    opt.value = lv.id;
    opt.textContent = lv.label;
    opt.title = lv.desc;
    lSel.appendChild(opt);
  }
  lSel.value = levels.some((l) => l.id === level) ? level : "default";
  const hint = $("mf-dialect-hint");
  if (hint) {
    hint.textContent = dialect === "auto"
      ? `当前自动识别为「${cfg?.reasoning?.dialectLabel || "—"}」`
      : (d ? `请求字段 ${d.field}` : "");
  }
  // 方言与协议不匹配时给出提示（llm.ts 会做近似换算，不会白选，但语义可能略有偏差）
  const protocol = currentEditingProvider()?.protocol || "openai";
  const mismatch = d?.protocols && !d.protocols.includes(protocol);
  const scheme = $("mf-scheme");
  if (scheme) {
    scheme.textContent = (d?.scheme || "")
      + (mismatch && d?.protocols
        ? `\n⚠ 这个划分方式是为「${d.protocols.join(" / ")}」协议准备的，当前供应商用的是「${String(protocol)}」协议：档位会按近似方式换算后发送（详见 README 的思考等级章节）。`
        : "");
  }
  const showCustom = effective === "custom" && lSel.value === "custom";
  $("mf-custom")?.classList.toggle("hidden", !showCustom);
  const customEl = $("mf-custom") as HTMLInputElement | null;
  if (customEl) customEl.value = showCustom ? custom : "";
}

/** 保存「模型编辑面板」里的改动（含思考等级） */
export async function saveModel(): Promise<void> {
  const { api } = await import("../core/api.js");
  const { applyConfigState } = await import("./composer-bar.js");
  const { setSettingsStatus } = await import("./model-store.js");
  const p = currentEditingProvider();
  const m = currentEditingModel();
  if (!p || !m) return;
  const name = inputValue("mf-name");
  if (!name) { setSettingsStatus("✗ 模型名不能为空", "err"); return; }
  const dialect = ($("mf-dialect") as HTMLSelectElement | null)?.value || "auto";
  const level = ($("mf-level") as HTMLSelectElement | null)?.value || "default";
  try {
    const res = await api<{ model: { reasoningLabel?: string } }>(
      `/api/config/providers/${p.id}/models/${m.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          label: inputValue("mf-label"),
          modality: ($("mf-vision") as HTMLInputElement | null)?.checked ? "vision" : "text",
          contextWindow: inputValue("mf-ctx"), // 空串 = 清除手动上下文
          reasoning: {
            dialect,
            level,
            custom: dialect === "custom" ? (($("mf-custom") as HTMLInputElement | null)?.value || "") : "",
          },
        }),
      }
    );
    applyConfigState(await api<import("../modules/types.js").AppConfig>("/api/config"));
    openModelForm(p.id, m.id);
    setSettingsStatus(`✓ 已保存模型「${name}」· 思考等级 ${res.model.reasoningLabel || "默认"}`, "ok");
  } catch (err) {
    setSettingsStatus(`✗ ${(err as Error).message}`, "err");
  }
}
