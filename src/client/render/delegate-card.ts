/**
 * ============================================================
 * render/delegate-card.ts — 委派卡（delegate_agent 结果的可视化）
 * ============================================================
 * 职责：把 delegate_agent 返回的 JSON 渲染成「子 Agent 干了什么」的摘要：
 * 目标 Agent、耗时、用过的工具，再附上结论正文。
 * 设计立场：
 *  - 子 Agent 的完整对话仍是黑盒（不把它的中间消息灌进主会话），
 *    但「用了哪几个工具 + 花了多久」足以让用户判断结论可信度 ——
 *    这是 F8「过程可见」的最小可用形态；
 *  - 解析失败就退回纯文本（旧会话 / 旧格式数据仍能正常显示）；
 *  - 骨架 innerHTML + 正文 textContent（结论来自模型，不可信）。
 */

import type { ToolPart } from "../modules/types.js";

interface DelegatePayload {
  ok?: boolean;
  text?: string;
  durationMs?: number;
  toolsUsed?: string[];
  assignedTools?: string[];
  agent?: string;
  agentName?: string;
  model?: string;
  profile?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number };
}

const PROFILE_LABELS: Record<string, string> = {
  general: "通用 Agent",
  estate: "房产找房 Agent",
};

/** 尝试把工具结果解析成委派载荷；解析不出来返回 null */
function parseDelegate(content: string): DelegatePayload | null {
  try {
    const data = JSON.parse(content) as DelegatePayload;
    if (!data || typeof data !== "object") return null;
    // 必须至少有 text 或 durationMs，才认定是委派载荷（避免误判别的 JSON 工具）
    if (typeof data.text !== "string" && typeof data.durationMs !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 给委派工具卡追加一段摘要。
 * 返回 true 表示已渲染（调用方不必再做别的处理）。
 */
export function renderDelegateInToolCard(part: ToolPart, card: HTMLElement): boolean {
  if (part.name !== "delegate_agent" || !part.result) return false;
  const payload = parseDelegate(part.result.content);
  if (!payload) return false;

  card.querySelector(".delegate-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "delegate-wrap";
  wrap.innerHTML = `
    <div class="delegate-head">
      <span class="delegate-icon">👥</span>
      <span class="delegate-title"></span>
      <span class="delegate-meta"></span>
    </div>
    <div class="delegate-tools"></div>`;

  const titleEl = wrap.querySelector(".delegate-title");
  if (titleEl) {
    const id = payload.agent ?? payload.profile ?? "";
    const label = payload.agentName ?? PROFILE_LABELS[id] ?? id ?? "子 Agent";
    titleEl.textContent = payload.ok === false ? `委派到${label} · 未成功` : `委派到${label}`;
  }
  const metaEl = wrap.querySelector(".delegate-meta");
  if (metaEl) {
    const secs = typeof payload.durationMs === "number" ? (payload.durationMs / 1000).toFixed(1) : "?";
    const tokens = typeof payload.usage?.totalTokens === "number" && payload.usage.totalTokens > 0
      ? ` · ${payload.usage.totalTokens.toLocaleString("zh-CN")} tokens`
      : "";
    metaEl.textContent = `${payload.model ? `${payload.model} · ` : ""}耗时 ${secs}s${tokens}`;
  }

  const toolsEl = wrap.querySelector(".delegate-tools");
  if (toolsEl) {
    const tools = Array.isArray(payload.toolsUsed) ? payload.toolsUsed : [];
    const assigned = Array.isArray(payload.assignedTools) ? payload.assignedTools : [];
    if (tools.length || assigned.length) {
      const label = document.createElement("span");
      label.className = "delegate-tools-label";
      label.textContent = tools.length
        ? `用了 ${tools.length} 个工具：`
        : `已分配 ${assigned.length} 个工具（本次未调用）：`;
      toolsEl.appendChild(label);
      for (const name of (tools.length ? tools : assigned)) {
        const chip = document.createElement("span");
        chip.className = "delegate-tool-chip";
        chip.textContent = name;
        toolsEl.appendChild(chip);
      }
    } else {
      toolsEl.remove();
    }
  }

  card.querySelector(".tool-body")?.appendChild(wrap);
  return true;
}
