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

import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { fmtPercent, fmtTokens } from "../modules/format.js";
import { quickReasoningDisplayLabel, visibleQuickReasoningLevels } from "../modules/reasoning-display.js";
import { activateModel } from "./model-actions.js";
import { prepareModelSwitch } from "../actions/model-switch.js";
import { closeCmMenus } from "./navigation.js";
import type { AppConfig, ModelEntry, ProviderEntry } from "../modules/types.js";

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

/** 顶栏按钮 / 侧栏 / 徽章 / composer chip 的统一刷新 */
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
  const sideText = $("side-model-text");
  if (sideText) sideText.textContent = mock ? `模拟模式 · ${cfg.model}` : `${active ? active.name + " · " : ""}${modelLabel}`;
  const btnText = $("provider-btn-text");
  if (btnText) btnText.textContent = mock
    ? `模拟模式 · ${cfg.model}`
    : `${activeModel?.modality === "vision" ? "🖼 " : ""}${modelLabel}`;
  const reasonBadge = $("provider-btn-reason");
  if (reasonBadge) {
    const tag = activeModel && activeModel.reasoningLevel !== "default" ? activeModel.reasoningLabel : "";
    reasonBadge.textContent = tag;
    reasonBadge.classList.toggle("hidden", !tag);
    reasonBadge.title = tag ? `当前思考等级：${tag}` : "";
  }
  renderComposerBar();
  updateContextBar();
}

/** 更新两个 chip 上的文字（applyConfigState 每次都会调用） */
export function renderComposerBar(): void {
  const cfg = state.config;
  if (!cfg || !$("cm-model")) return;
  const m = activeModelEntryOf();
  const modelText = document.querySelector("#cm-model .cm-text");
  if (modelText) modelText.textContent = cfg.mock ? `模拟模式 · ${cfg.model}` : (m?.displayName || cfg.model);
  const r = cfg.reasoning || {};
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
        try {
          if (!(await prepareModelSwitch(p.id, m.id))) {
            closeCmMenus();
            return;
          }
          await api(`/api/config/providers/${p.id}/models/${m.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ makeActive: true }),
          });
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
  manage.addEventListener("click", () => { closeCmMenus(); void import("./settings.js").then((m) => m.openSettings()); });
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
  const levels = visibleQuickReasoningLevels(r.levels, r.dialect);
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
export function updateContextBar(): void {
  const bar = $("context-bar");
  const u = state.currentId ? state.usage[state.currentId] : undefined;
  if (!bar) return;
  if (!u || !u.contextTokens) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");

  // 分母跟随当前目标模型；used 保留最近一次主模型请求的历史峰值。
  const win = u.contextWindow ?? state.config?.contextWindow ?? null;
  const fill = $("ctx-fill");
  const text = $("ctx-text");
  if (!fill || !text) return;
  const requestText = `${u.contextPending ? "上一请求" : "请求"} ↑ ${fmtTokens(u.lastInput)} · ↓ ${fmtTokens(u.lastOutput)}`;
  const inputBudget = u.contextInputBudget
    ?? state.config?.contextBudget?.inputBudgetTokens
    ?? null;
  if (win) {
    // 进度条用「输入预算」做分母：输出预留本来就不应被历史吃掉，
    // 否则 200k 窗口在 150k used 时仍显示健康，实际下一次请求可能已无输出空间。
    const scale = inputBudget ?? win;
    const pct = Math.min(100, (u.contextTokens / scale) * 100);
    fill.style.width = Math.max(1.5, pct) + "%";
    fill.className = "ctx-fill" + (pct > 92 ? " danger" : pct > 80 ? " warn" : "");
    const warning = u.contextTokens > scale ? " · 已超出输入预算，请压缩上下文" : "";
    const budgetText = inputBudget
      ? `当前会话上下文 ${fmtTokens(u.contextTokens)} / ${fmtTokens(inputBudget)} tokens（${pct.toFixed(1)}% · 模型窗口 ${fmtTokens(win)}，输出预留 ${fmtTokens(u.outputReserveTokens)}，安全余量 ${fmtTokens(u.safetyMarginTokens)}）`
      : `当前会话上下文 ${fmtTokens(u.contextTokens)} / ${fmtTokens(win)} tokens（${pct.toFixed(1)}% · 当前模型窗口）`;
    text.textContent = `${budgetText} · ${requestText}${warning}`;
  } else {
    fill.style.width = "0%";
    fill.className = "ctx-fill";
    text.textContent = `当前会话上下文 ${fmtTokens(u.contextTokens)} tokens · ${requestText} · 容量未知（设置里「获取列表」后显示占比）`;
  }

  const cacheEl = $("ctx-cache");
  if (!cacheEl) return;
  if (u.lastInput > 0 && u.lastCache > 0) {
    cacheEl.textContent = `缓存命中 ${fmtPercent((u.lastCache / u.lastInput) * 100)}`;
    cacheEl.classList.remove("hidden");
  } else {
    cacheEl.classList.add("hidden");
  }
}
