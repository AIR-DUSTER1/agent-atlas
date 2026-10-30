/**
 * ============================================================
 * render/delegate-card.ts — 子代理委派过程与结果卡
 * ============================================================
 * 职责：在工具卡内展示「正在委派 / 已完成 / 未完成」、目标子代理、
 * 模型、耗时、token 与工具轨迹。
 * 设计立场：
 *  - 运行中即可看到目标与授权工具，不能等最终 JSON 才出现子代理信息；
 *  - 结果解析失败退回通用工具卡，不影响旧会话回放；
 *  - 全部骨架使用 h()/textContent，模型输出与工具名不拼 HTML。
 */
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
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

interface DelegateArgs {
  agent?: string;
  task?: string;
  prompt?: string;
  tools?: string[];
}

const PROFILE_LABELS: Record<string, string> = {
  general: "通用 Agent",
  estate: "房产找房 Agent",
};

/** 尝试把工具结果解析成委派载荷；解析不出来返回 null。 */
function parseDelegate(content: string): DelegatePayload | null {
  try {
    const data = JSON.parse(content) as DelegatePayload;
    if (!data || typeof data !== "object") return null;
    if (typeof data.text !== "string" && typeof data.durationMs !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

/** 参数流是分片到达的，只有形成完整 JSON 后才用于展示。 */
function parseArgs(content: string): DelegateArgs | null {
  try {
    const data = JSON.parse(content) as DelegateArgs;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function metaItem(label: string, value: string, title?: string): HTMLElement {
  return h("span", { class: "delegate-meta-item", title: title || value },
    h("span", null, label),
    h("strong", null, value),
  );
}

/**
 * 给委派工具卡追加过程/结果摘要。
 * 返回 true 表示已渲染（调用方不必再做别的处理）。
 */
export function renderDelegateInToolCard(part: ToolPart, card: HTMLElement): boolean {
  if (part.name !== "delegate_agent") return false;
  const payload = part.result ? parseDelegate(part.result.content) : null;
  if (part.result && !payload) return false;

  const args = parseArgs(part.argsText);
  const pending = !part.result;
  const failed = Boolean(part.result?.isError) || payload?.ok === false;
  const agentId = payload?.agent ?? payload?.profile ?? args?.agent ?? "";
  const label = payload?.agentName ?? PROFILE_LABELS[agentId] ?? (agentId || "子 Agent");
  const usedTools = stringList(payload?.toolsUsed);
  const assignedTools = stringList(payload?.assignedTools).length
    ? stringList(payload?.assignedTools)
    : stringList(args?.tools);
  const stateClass = pending ? "running" : failed ? "error" : "done";

  card.querySelector(".delegate-wrap")?.remove();
  const stateText = pending ? "运行中" : failed ? "未完成" : "已完成";
  const wrap = h("section", {
    class: `delegate-wrap ${stateClass}`,
    dataset: { delegateState: stateClass },
    "aria-label": `${label}${stateText}`,
  },
    h("div", { class: "delegate-head" },
      h("span", { class: "delegate-icon", "aria-hidden": "true" }, icon("Bot", { size: 15 })),
      h("div", { class: "delegate-heading" },
        h("span", { class: "delegate-kicker" }, pending ? "正在委派" : "子代理结果"),
        h("strong", { class: "delegate-title" }, label),
      ),
      h("span", { class: `delegate-state ${stateClass}` },
        icon(pending ? "LoaderCircle" : failed ? "CircleX" : "CircleCheck", { size: 12 }),
        stateText,
      ),
    ),
  );

  const meta = h("div", { class: "delegate-meta" });
  if (pending) {
    meta.append(
      metaItem("上下文", "独立执行"),
      metaItem("权限", "本次工具授权"),
      ...(assignedTools.length ? [metaItem("工具", `${assignedTools.length} 项已授权`)] : []),
    );
  } else {
    const seconds = typeof payload?.durationMs === "number" ? (payload.durationMs / 1000).toFixed(1) : "?";
    if (payload?.model) meta.append(metaItem("模型", payload.model, payload.model));
    meta.append(metaItem("耗时", `${seconds}s`));
    const totalTokens = payload?.usage?.totalTokens;
    if (typeof totalTokens === "number" && totalTokens > 0) {
      meta.append(metaItem("用量", `${totalTokens.toLocaleString("zh-CN")} tokens`));
    }
    if (typeof payload?.usage?.cacheReadTokens === "number" && payload.usage.cacheReadTokens > 0) {
      meta.append(metaItem("缓存", `${payload.usage.cacheReadTokens.toLocaleString("zh-CN")} tokens`));
    }
  }
  if (meta.childElementCount) wrap.appendChild(meta);

  const task = args?.task?.trim();
  if (task) {
    wrap.appendChild(h("p", { class: "delegate-task", title: task }, task));
  }

  const tools = usedTools.length ? usedTools : assignedTools;
  if (tools.length) {
    const toolsEl = h("div", { class: "delegate-tools" },
      h("span", { class: "delegate-tools-label" },
        usedTools.length ? `工具轨迹 · ${usedTools.length}` : `已授权但尚未调用 · ${assignedTools.length}`,
      ),
    );
    for (const name of tools) {
      toolsEl.appendChild(h("span", { class: "delegate-tool-chip", title: name }, name));
    }
    wrap.appendChild(toolsEl);
  } else if (pending) {
    wrap.appendChild(h("p", { class: "delegate-pending-copy" }, "正在等待主 Agent 下发完整任务与工具子集…"));
  }

  card.querySelector(".tool-body")?.appendChild(wrap);
  return true;
}
