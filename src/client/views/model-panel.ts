/**
 * ============================================================
 * views/model-panel.ts — 设置页左栏供应商导航 + 右栏详情 + 模型列表
 * ============================================================
 * 职责：供应商列表、选中项详情（Key 状态 / 协议 / 模型数 / 操作按钮）、
 * 右栏模型行与「待提交模型」「网关模型 chips」的渲染。
 * 设计立场：
 *  - 左栏只放导航，右栏放详情 —— 首次配置时认知负担最小；
 *  - 每行模型自带「启用 / 编辑 / 删除」三个动作，不做二级菜单；
 *  - 渲染必须能安全地在空供应商 / 空模型时降级（显示引导文案）。
 */

import { $ } from "../core/dom.js";
import { fmtTokens } from "../modules/format.js";
import { PROTOCOL_LABEL } from "./composer-bar.js";
import {
  currentEditingProvider, gatewayModels, pendingModels, providers, selectedProvider,
  selectedProviderId, setPendingModels, setSelectedProviderId, settingsFocusProviderId,
  setSettingsFocus,
} from "./model-store.js";
import type { ProviderEntry } from "../modules/types.js";

/** 首次进入设置页优先选中"启用中"供应商；菜单定位优先。 */
function ensureProviderSelection(): void {
  const list = providers();
  if (settingsFocusProviderId && list.some((provider) => provider.id === settingsFocusProviderId)) {
    setSelectedProviderId(settingsFocusProviderId);
    setSettingsFocus(null);
  }
  if (!selectedProviderId || !list.some((provider) => provider.id === selectedProviderId)) {
    setSelectedProviderId(list.find((provider) => provider.active)?.id ?? list[0]?.id ?? null);
  }
}

export function selectProvider(providerId: string | null): void {
  if (!providerId) return;
  // 供应商连接配置在独立弹窗里；左栏始终只负责"当前查看哪个供应商"。
  if (currentEditingProvider()) {
    void import("./model-form.js").then((m) => m.closeProviderForm());
  }
  setSelectedProviderId(providerId);
  setSettingsFocus(null);
  renderProviderList();
}

/** 左栏只放供应商导航；详情与模型全部收进右栏，降低首次配置认知负担。 */
export function renderProviderList(): void {
  const list = $("provider-list");
  if (!list) return;
  ensureProviderSelection();
  const all = providers();
  const count = $("provider-count");
  if (count) count.textContent = `${all.length} 个`;
  list.innerHTML = "";

  for (const p of all) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "provider-nav-item"
      + (p.id === selectedProviderId ? " active" : "")
      + (p.active ? " in-use" : "");
    button.innerHTML = `
      <span class="provider-nav-dot"></span>
      <span class="provider-nav-copy">
        <span class="provider-nav-name"></span>
        <span class="provider-nav-url"></span>
      </span>
      <span class="provider-nav-count"></span>`;
    const nameEl = button.querySelector(".provider-nav-name");
    if (nameEl) nameEl.textContent = p.name;
    const urlEl = button.querySelector(".provider-nav-url");
    if (urlEl) urlEl.textContent = p.baseURL;
    const cntEl = button.querySelector(".provider-nav-count");
    if (cntEl) cntEl.textContent = `${(p.models || []).length} 模型`;
    button.title = `${p.name}\n${p.baseURL}`;
    button.addEventListener("click", () => selectProvider(p.id));
    list.appendChild(button);
  }
  renderProviderDetail();
}

function detailBadge(text: string, cls = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = "provider-detail-badge" + (cls ? " " + cls : "");
  span.textContent = text;
  return span;
}

/** 右栏：所选供应商概览 + 操作 + 模型列表。新增/编辑连接走独立弹窗。 */
function renderProviderDetail(): void {
  const detail = $("provider-detail");
  const empty = $("provider-empty");
  if (!detail || !empty) return;
  const p = selectedProvider();
  if (!p) {
    empty.classList.remove("hidden");
    detail.classList.add("hidden");
    return;
  }

  empty.classList.add("hidden");
  detail.classList.remove("hidden");
  const all = providers();
  const nameEl = $("provider-detail-name");
  if (nameEl) nameEl.textContent = p.name;
  const urlEl = $("provider-detail-url");
  if (urlEl) urlEl.textContent = p.baseURL;
  $("provider-detail-active")?.classList.toggle("hidden", !p.active);
  const badges = $("provider-detail-badges");
  if (badges) {
    badges.innerHTML = "";
    badges.appendChild(detailBadge(p.hasKey ? "✓ Key 已保存" : "无 Key", p.hasKey ? "ok" : "warn"));
    if (p.protocol !== "openai") badges.appendChild(detailBadge(PROTOCOL_LABEL[p.protocol] || p.protocol, "proto"));
    badges.appendChild(detailBadge(`${(p.models || []).length} 个模型`));
  }

  const useBtn = $("provider-use-btn") as HTMLButtonElement | null;
  const editBtn = $("provider-edit-btn");
  const delBtn = $("provider-delete-btn");
  for (const btn of [useBtn, editBtn, delBtn]) btn?.classList.remove("hidden");
  if (useBtn) {
    useBtn.textContent = p.active ? "使用中" : "启用";
    useBtn.disabled = Boolean(p.active);
  }
  delBtn?.classList.toggle("hidden", all.length <= 1);
  renderModelPanel();
}

/** 右栏模型列表：当前供应商的已有模型（启用 / 编辑 / 删除）。 */
export function renderModelPanel(): void {
  const list = $("pf-model-list");
  if (!list) return;
  list.innerHTML = "";
  const p = selectedProvider();
  const countEl = $("pf-model-count");
  if (countEl) {
    countEl.textContent = p ? `共 ${(p.models || []).length} 个 · 一个供应商可添加多个模型` : "";
  }
  const models = p ? (p.models || []) : [];
  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = p
      ? "还没有模型：在下面输入模型名，或点「获取列表」从网关挑选（可加多个）"
      : "先从左侧选择供应商";
    list.appendChild(empty);
    return;
  }

  for (const m of models) {
    const row = document.createElement("div");
    row.className = "model-row" + (m.active ? " active" : "") + (m.id === m.id ? "" : "");
    row.innerHTML = `
      <button type="button" class="m-pick" title="设为该供应商的启用模型">${m.active ? "✓" : "○"}</button>
      <div class="m-info">
        <div class="m-name"></div>
        <div class="m-detail"></div>
      </div>
      <div class="m-actions">
        <button type="button" class="m-edit">编辑</button>
        <button type="button" class="m-del">删除</button>
      </div>`;
    const nameEl = row.querySelector(".m-name");
    if (nameEl) nameEl.textContent = `${m.modality === "vision" ? "🖼 " : ""}${m.displayName || m.name}`;
    const contextSource = m.contextWindowSource === "manual"
      ? "手动"
      : m.contextWindowSource === "gateway" ? "网关" : "默认";
    const detailEl = row.querySelector(".m-detail");
    if (detailEl) {
      detailEl.textContent =
        `${m.name} · 思考等级 ${m.reasoningLabel || "供应商默认"}`
        + (m.contextWindow ? ` · 窗口 ${fmtTokens(m.contextWindow)}（${contextSource}）` : "");
    }
    row.querySelector(".m-pick")?.addEventListener("click", () => {
      if (!m.active && p) void import("./model-actions.js").then((a) => a.activateModel(p.id, m.id));
    });
    row.querySelector(".m-edit")?.addEventListener("click", () => {
      if (p) void import("./model-form.js").then((fm) => fm.openModelForm(p.id, m.id));
    });
    row.querySelector(".m-del")?.addEventListener("click", () => {
      if (p) void import("./model-actions.js").then((a) => a.removeModel(p.id, m.id, m.name));
    });
    list.appendChild(row);
  }
}

/** 新增供应商弹窗里的待提交模型清单：只在内存中，保存供应商时一起提交。 */
export function renderPendingModels(): void {
  const list = $("pf-pending-model-list");
  if (!list) return;
  list.innerHTML = "";
  if (!pendingModels.length) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = "还没有初始模型，请在下方输入模型名或从网关列表选择。";
    list.appendChild(empty);
    return;
  }
  for (const m of pendingModels) {
    const row = document.createElement("div");
    row.className = "pending-model-row";
    row.innerHTML = `
      <span class="pending-model-name"></span>
      <span class="pending-model-meta"></span>
      <button type="button" class="pending-model-remove">移除</button>`;
    const nameEl = row.querySelector(".pending-model-name");
    if (nameEl) nameEl.textContent = m.name;
    const metaEl = row.querySelector(".pending-model-meta");
    if (metaEl) {
      metaEl.textContent = [
        m.modality === "vision" ? "多模态" : "文本",
        m.contextWindow ? `窗口 ${fmtTokens(m.contextWindow)}` : "",
      ].filter(Boolean).join(" · ");
    }
    row.querySelector(".pending-model-remove")?.addEventListener("click", () => {
      setPendingModels(pendingModels.filter((item) => item.name !== m.name));
      renderPendingModels();
      renderGatewayModels("pending");
    });
    list.appendChild(row);
  }
}

/** 从网关拉取的模型清单：detail=右栏已有供应商；pending=新增供应商弹窗。 */
export function renderGatewayModels(target: "detail" | "pending" = "detail"): void {
  const box = $(target === "pending" ? "pf-new-gateway-models" : "gateway-models");
  if (!box) return;
  box.innerHTML = "";
  if (!gatewayModels.length) return;
  const label = document.createElement("div");
  label.className = "gw-label";
  label.textContent = `网关返回 ${gatewayModels.length} 个模型（点一下直接添加）：`;
  box.appendChild(label);
  const wrap = document.createElement("div");
  wrap.className = "gw-chips";
  const targetProvider = target === "pending" ? null : selectedProvider();
  const existing = new Set(
    target === "pending"
      ? pendingModels.map((m) => m.name)
      : (targetProvider?.models || []).map((m) => m.name)
  );
  for (const m of gatewayModels) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "gw-chip" + (existing.has(m.id) ? " added" : "");
    chip.textContent = (existing.has(m.id) ? "✓ " : "＋ ") + m.id
      + (m.contextWindow ? ` · ${fmtTokens(m.contextWindow)}` : "")
      + (m.supportsVision ? " · 🖼" : "")
      + (m.supportsReasoning ? " · ⚡" : "");
    chip.title = `${m.id}\n上下文：${m.contextWindow ?? "未知"}\n多模态：${m.supportsVision ? "是" : "未知"} · 支持推理：${m.supportsReasoning ? "是" : "未知"}`;
    chip.addEventListener("click", () => {
      void import("./model-actions.js").then((mod) => {
        if (target === "pending") mod.addPendingModelByName(m.id, m);
        else void mod.addModelByName(m.id, m);
      });
    });
    wrap.appendChild(chip);
  }
  box.appendChild(wrap);
}

/** 供顶栏菜单等外部处使用：当前左栏选中的供应商 */
export function currentlySelectedProvider(): ProviderEntry | null {
  return selectedProvider();
}
