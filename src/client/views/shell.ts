/**
 * ============================================================
 * views/shell.ts — 新建对话弹窗 / 欢迎页卡片与示例 chips
 * ============================================================
 * 职责：通用 Agent 卡、内置示例卡、房产 Agent 卡、示例问题 chips。
 * 设计立场：
 *  - 卡片全部是「点击即建会话」的入口，具体建会话走注入的 createSession；
 *  - 文案来自 AGENT_PROFILES（单一来源），这里不硬编码产品名。
 */

import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { uiAlert } from "../ui/dialog.js";
import { AGENT_PROFILES } from "../modules/agent-profile.js";
import type { SessionKind } from "../modules/types.js";

let createSessionFn: (
  kind?: SessionKind | null, demo?: number | null, prefill?: string | null, agentId?: string
) => Promise<void> = async () => {};

export function bindCreateSession(fn: typeof createSessionFn): void {
  createSessionFn = fn;
}

/** 通用 Agent 的常规示例（点击 → 新建通用 Agent 会话并预填） */
export const GENERAL_EXAMPLES = [
  "帮我算一下 (128+512)*3，再看看现在几点了",
  "查一下北京的天气，适合穿什么",
  "给 boss@example.com 发一封邮件，主题是周报",
  "附加一个文件，帮我总结它的要点（用 📎 选择）",
];

export function buildDemoCards(container: HTMLElement | null): void {
  if (!container) return;
  container.innerHTML = "";

  // 通用 Agent（默认）：正常产品逻辑 —— 工具 + 文件上下文 + 多轮记忆 + 审批
  const general = AGENT_PROFILES.general;
  const agentCard = document.createElement("button");
  agentCard.className = "demo-card";
  agentCard.innerHTML = `
    <div class="d-head"><span class="d-num">${general.icon}</span><span class="d-name">${general.label} <span class="d-default">默认</span></span></div>
    <div class="d-desc">${general.description}</div>
    <div class="d-eg">${general.example}</div>`;
  agentCard.addEventListener("click", async () => {
    try { await createSessionFn("agent", null, null); }
    catch (err) { uiAlert("创建对话失败：" + (err as Error).message, "创建对话"); }
  });
  container.appendChild(agentCard);

  // 内置示例（学习 Demo）
  for (const d of state.config?.demos || []) {
    const card = document.createElement("button");
    card.className = "demo-card";
    card.innerHTML = `
      <div class="d-head"><span class="d-num">${d.id}</span><span class="d-name"></span></div>
      <div class="d-desc"></div>
      <div class="d-eg"></div>`;
    const nameEl = card.querySelector(".d-name");
    if (nameEl) nameEl.textContent = d.name;
    const descEl = card.querySelector(".d-desc");
    if (descEl) descEl.textContent = d.desc;
    const egEl = card.querySelector(".d-eg");
    if (egEl) egEl.textContent = "示例：" + d.example;
    card.addEventListener("click", async () => {
      try {
        await createSessionFn("demo", d.id, d.example);
      } catch (err) { uiAlert("创建对话失败：" + (err as Error).message, "创建对话"); }
    });
    container.appendChild(card);
  }

  // 房产 Agent（贝壳）：真实找房 / 对比区位地图 / 户型图 / 预约带看
  const estate = AGENT_PROFILES.estate;
  const estateCard = document.createElement("button");
  estateCard.className = "demo-card";
  estateCard.innerHTML = `
    <div class="d-head"><span class="d-num">${estate.icon}</span><span class="d-name">${estate.label}</span></div>
    <div class="d-desc">${estate.description}</div>
    <div class="d-eg" id="estate-card-hint">示例：${estate.example}</div>`;
  estateCard.addEventListener("click", async () => {
    try { await createSessionFn("estate"); }
    catch (err) { uiAlert("创建对话失败：" + (err as Error).message, "创建对话"); }
  });
  container.appendChild(estateCard);
}

export function buildExampleChips(): void {
  const wrap = $("example-chips");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const text of GENERAL_EXAMPLES) {
    const chip = document.createElement("button");
    chip.className = "ex-chip";
    chip.textContent = text;
    chip.addEventListener("click", async () => {
      try {
        await createSessionFn("agent", null, text);
      } catch (err) { uiAlert("创建对话失败：" + (err as Error).message, "创建对话"); }
    });
    wrap.appendChild(chip);
  }
}

export function openModal(): void {
  $("modal-mask")?.classList.remove("hidden");
}

export function closeModal(): void {
  $("modal-mask")?.classList.add("hidden");
}
