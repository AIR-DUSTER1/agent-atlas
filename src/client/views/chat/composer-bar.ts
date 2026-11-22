/**
 * ============================================================
 * views/composer-bar.ts — 输入框上方的模型 / 思考等级快捷切换 + 容量条
 * ============================================================
 * 职责：composer bar 两个 chip 的文案、下拉菜单内容、上下文容量条与缓存占比。
 * 设计立场：
 *  - 这里是「配置 → 界面文案」的唯一映射处：applyConfigState 一次调用刷新全部；
 *  - 模型菜单按「供应商分组 × 组内全部模型」平铺 —— 同一个网关的第二、第三个
 *    模型必须有入口，不能让用户为了换模型再建一个供应商；
 *  - used 取主模型最近一次请求的 input usage（不再叠加 output），分母使用
 *    当前模型扣除输出预留后的输入预算；切换模型只换预算，不清空历史。
 */

import { $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { state } from "../../core/state.js";
import { uiAlert } from "../../ui/dialog.js";
import { quickReasoningDisplayLabel, visibleQuickReasoningLevels } from "../../modules/reasoning-display.js";
import { activateModel } from "../settings/models/model-actions.js";
import { closeCmMenus } from "../app/navigation.js";
import type { AppConfig, ModelEntry, ProviderEntry } from "../../modules/types.js";

/** 请求协议 → 徽标短文案（openai 是默认，不显示徽标） */
export const PROTOCOL_LABEL: Record<string, string> = {
  "openai-responses": "Responses",
  "anthropic": "Anthropic",
  "gemini": "Gemini",
};

export function activeProviderOf(): ProviderEntry | null {
  return (state.config?.providers || []).find((p) => p.active) || null;
}

export function activeModelEntryOf(): ModelEntry | null {
  const p = activeProviderOf();
  return (p?.models || []).find((m) => m.active) || null;
}

/** 侧栏 / 徽章 / composer chip 的统一刷新 */
export function applyConfigState(cfg: AppConfig): void {
  const previousWindow = state.config?.contextWindow ?? null;
  const previousProvider = activeProviderOf();
  const previousModel = activeModelEntryOf();
  state.config = cfg;
  const nextProvider = activeProviderOf();
  const nextModel = activeModelEntryOf();
  const targetChanged = previousProvider?.id !== nextProvider?.id || previousModel?.id !== nextModel?.id;
  // ZCode 的 context meter 把历史 used 与当前 runtime 的 contextWindow 分离。
  // 切换模型时保留每会话的 used，立即用新模型窗口重算；下一份主 usage 允许下调。
  if (cfg.contextWindow && (targetChanged || cfg.contextWindow !== previousWindow)) {
    for (const usage of Object.values(state.usage)) {
      usage.contextWindow = cfg.contextWindow;
      usage.contextInputBudget = cfg.contextBudget?.inputBudgetTokens;
      usage.outputReserveTokens = cfg.contextBudget?.outputReserveTokens;
      usage.safetyMarginTokens = cfg.contextBudget?.safetyMarginTokens;
      usage.contextPending = true;
    }
  }
  const mock = Boolean(cfg.mock);
  $("mode-badge")?.classList.toggle("hidden", !mock);
  const sideModel = $("side-model");
  sideModel?.classList.toggle("mock", mock);
  const active = (cfg.providers || []).find((p) => p.active);
  const activeModel = (active?.models || []).find((m) => m.active);
  const modelLabel = activeModel?.displayName || cfg.model;
  const mockLabel = activeModel?.displayName ? `模拟模式 · ${activeModel.displayName}` : "模拟模式";
  const sideText = $("side-model-text");
  if (sideText) sideText.textContent = mock ? mockLabel : `${active ? active.name + " · " : ""}${modelLabel}`;
  renderComposerBar();
  updateContextBar();
  // M4 4.3：模型管理面板（Vue）随配置刷新（动态 import 保 1:1 静态图干净）
  void import("../../stores/settings/models/models.js")
    .then(({ useModelsStore }) => useModelsStore().syncConfig(cfg))
    .catch(() => {});
}

/** 更新两个 chip 上的文字（applyConfigState 每次都会调用） */
export function renderComposerBar(): void {
  const cfg = state.config;
  if (!cfg || !$("cm-model")) return;
  const m = activeModelEntryOf();
  const modelText = document.querySelector("#cm-model .cm-text");
  const mockLabel = m?.displayName ? `模拟模式 · ${m.displayName}` : "模拟模式";
  if (modelText) modelText.textContent = cfg.mock ? mockLabel : (m?.displayName || cfg.model);
  const r = cfg.reasoning || {};
  const levels = visibleQuickReasoningLevels(r.levels);
  // 没有可切换档位时不显示入口：点开只有「无需设置」，属于死路菜单
  // （无供应商 / 通用兼容方言的 levels 只有被隐藏的 default）
  const thinkGroup = document.querySelector<HTMLElement>("#cm-thinking")?.closest(".cm-group");
  thinkGroup?.classList.toggle("hidden", levels.length === 0);
  const thinkText = document.querySelector("#cm-thinking .cm-text");
  if (thinkText) {
    const lvl = (r.levels || []).find((l) => l.id === r.level);
    thinkText.textContent = quickReasoningDisplayLabel(lvl, r.label || "默认");
  }
  // 弹出菜单开着时同步刷新内容
  const modelMenu = $("cm-model-menu");
  if (modelMenu && !modelMenu.classList.contains("hidden")) renderModelMenu(modelMenu);
  const thinkMenu = $("cm-thinking-menu");
  if (thinkMenu && !thinkMenu.classList.contains("hidden")) renderThinkingMenu(thinkMenu);
}

export function toggleCmMenu(
  chipId: string, menuId: string, render: (menu: HTMLElement) => void
): void {
  const chip = $(chipId);
  const menu = $(menuId);
  if (!chip || !menu) return;
  const opening = menu.classList.contains("hidden");
  closeCmMenus();
  if (opening) {
    render(menu);
    menu.classList.remove("hidden");
    chip.classList.add("on");
  }
}

/** 模型菜单：按供应商分组列出全部「供应商 × 模型」组合，点击即切换 */
export function renderModelMenu(menu: HTMLElement): void {
  const cfg = state.config;
  if (!cfg) return;
  menu.innerHTML = "";
  if (!(cfg.providers || []).length) {
    const empty = document.createElement("div");
    empty.className = "cm-desc";
    empty.textContent = "当前为模拟模式；前往设置添加供应商后可切换模型。";
    menu.appendChild(empty);
    return;
  }
  for (const p of cfg.providers || []) {
    const sec = document.createElement("div");
    sec.className = "cm-sec";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name;
    const protoSpan = document.createElement("span");
    protoSpan.className = "cm-sub";
    protoSpan.textContent = p.protocol && p.protocol !== "openai" ? (PROTOCOL_LABEL[p.protocol] || p.protocol) : "";
    sec.append(nameSpan, protoSpan);
    menu.appendChild(sec);
    for (const m of p.models || []) {
      // 全局切换器里只给「当前正在使用的模型」打勾（启用中的供应商 × 它选中的模型），
      // 其他供应商各自选中的模型不打勾，避免菜单里同时出现多个 ✓
      const isCurrent = Boolean(p.active) && Boolean(m.active);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cm-item" + (isCurrent ? " active" : "");
      item.innerHTML = `<span class="ck">${isCurrent ? "✓" : ""}</span><span class="cm-label"></span><span class="cm-sub">${m.modality === "vision" ? "🖼 多模态" : ""}</span>`;
      const label = item.querySelector(".cm-label");
      if (label) label.textContent = m.displayName || m.name;
      item.title = isCurrent ? "当前模型" : `切换到 ${p.name} · ${m.name}`;
      item.addEventListener("click", async () => {
        if (isCurrent) { closeCmMenus(); return; }
        item.disabled = true;
        // 必须走 activateModel（POST /api/config/activate）：它会同时切「供应商」
        // 与「模型」。早先这里手写 POST .../models/:id {makeActive:true} 只改
        // 供应商内部的 activeModelId，跨供应商切换时服务端静默忽略、返回 200，
        // 界面什么都不变 —— 菜单看起来"点不动"。
        try {
          await activateModel(p.id, m.id);
          applyConfigState(await api<AppConfig>("/api/config"));
        } catch (err) {
          uiAlert(`切换失败：${(err as Error).message}`, "切换模型");
        }
        closeCmMenus();
      });
      menu.appendChild(item);
    }
  }
  const divider = document.createElement("div");
  divider.className = "cm-divider";
  menu.appendChild(divider);
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "cm-item";
  manage.innerHTML = `<span class="ck"></span><span class="cm-label">管理供应商与模型…</span>`;
  manage.addEventListener("click", () => { closeCmMenus(); void import("../settings/settings.js").then((m) => m.openSettings()); });
  menu.appendChild(manage);
}

/** 思考等级菜单：选项来自当前模型方言（/api/config 的 reasoning.levels） */
export function renderThinkingMenu(menu: HTMLElement): void {
  const r = state.config?.reasoning || {};
  menu.innerHTML = "";
  const sec = document.createElement("div");
  sec.className = "cm-sec";
  const head = document.createElement("span");
  head.textContent = activeModelEntryOf()?.displayName || state.config?.model || "当前模型";
  sec.append(head);
  menu.appendChild(sec);
  const levels = visibleQuickReasoningLevels(r.levels);
  if (!levels.length) {
    const empty = document.createElement("div");
    empty.className = "cm-desc";
    empty.textContent = "该模型无需额外设置思考等级";
    menu.appendChild(empty);
  }
  for (const l of levels) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cm-item" + (l.id === r.level ? " active" : "");
    item.innerHTML = `<span class="ck">${l.id === r.level ? "✓" : ""}</span><span class="cm-label"></span>`;
    const label = item.querySelector(".cm-label");
    if (label) label.textContent = quickReasoningDisplayLabel(l);
    item.title = l.desc || "";
    item.addEventListener("click", async () => {
      if (l.id === r.level) { closeCmMenus(); return; }
      item.disabled = true;
      try {
        await api("/api/config/reasoning", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 带上当前方言：确保「档位」按同一套划分方式解释
          body: JSON.stringify({ dialect: r.dialect && r.dialect !== "auto" ? r.dialect : undefined, level: l.id }),
        });
        applyConfigState(await api<AppConfig>("/api/config"));
      } catch (err) {
        uiAlert(`设置失败：${(err as Error).message}`, "思考等级");
      }
      closeCmMenus();
    });
    menu.appendChild(item);
  }
}

/**
 * 上下文容量条 + 缓存占比。
 * 数据来源：模型响应里的 usage（input ≈ 当时整段对话的上下文，
 * input_token_details.cache_read ≈ 提示词缓存命中）；分母来自产生该用量时
 * 服务端写入的模型 context_length，并按会话落盘（未知时只显示 token 数）。
 */
/**
 * 容量条发布：把 usage 汇总成快照，经 window 事件推给 Vue 组件。
 * 为什么不用 store.apply：bundle 与 1:1 副本是两个模块实例（各有独立 pinia），
 * 直接跨实例取 store 拿不到同一份状态；window 事件是两者都可靠的通道。
 * 为什么不用 core state 响应式：state 是普通对象，Vue 无法追踪其变更。
 */
export function updateContextBar(): void {
  const u = state.currentId ? state.usage[state.currentId] : undefined;
  const snapshot = !u || !u.contextTokens ? null : {
    contextTokens: u.contextTokens,
    lastInput: u.lastInput,
    lastOutput: u.lastOutput,
    lastCache: u.lastCache,
    contextWindow: u.contextWindow ?? state.config?.contextWindow ?? null,
    inputBudget: u.contextInputBudget ?? state.config?.contextBudget?.inputBudgetTokens ?? null,
    outputReserveTokens: u.outputReserveTokens ?? 0,
    safetyMarginTokens: u.safetyMarginTokens ?? 0,
    taskOutput: u.taskOutput ?? 0,
    taskActiveMs: u.taskActiveMs ?? 0,
    contextPending: Boolean(u.contextPending),
  };
  void import("../../stores/chat/context-meter.js")
    .then(({ publishContextMeter }) => publishContextMeter(snapshot))
    .catch(() => {});
}

/** 挂载容量条组件（幂等；composer 初始化时调用）。 */
export async function mountContextMeter(): Promise<void> {
  void import("./context-meter-vue.js")
    .then((m) => m.mountContextMeterVue())
    .catch(() => {});
}
