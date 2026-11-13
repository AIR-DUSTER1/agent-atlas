/**
 * ============================================================
 * render/parts.ts — 助手回合内「单个部件」的挂载与重绘
 * ============================================================
 * 职责：text / thinking / node / tool / approval / clarification 六种 part
 * 的 DOM 结构、增量更新与交互绑定。
 * 设计立场：
 *  - 骨架用 innerHTML，正文一律 textContent（模型输出与工具结果都是不可信内容）；
 *  - 渲染函数必须幂等：同一 part 重复调用不能产生重复 DOM（approval 折叠靠它）；
 *  - 节流（55ms）只作用于 token 很碎的 text / thinking，其余即时刷新。
 */

import {
  ensureMarkdownRenderer, fmtArgs, nodeIcon, nodeLabel, renderMarkdown,
} from "../modules/format.js";
import {
  TOOL_CATEGORIES, TOOL_CATEGORY_ORDER, describeTool, type ToolCategoryId,
} from "../modules/tool-presentation.js";
import {
  blockBodies, partEls, saveLocal, state, textTimers, thinkingTimers,
} from "../core/state.js";
import { scrollBottom } from "../core/dom.js";
import { decideApproval } from "../actions/approvals.js";
import { renderClarificationCard as renderClarificationCardImpl } from "./clarify-card.js";
import { renderToolEnhancers } from "./tool-enhancers.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import { renderDelegateInToolCard } from "./delegate-card.js";
import { refreshConclusionMedia } from "./conclusion-media.js";
import { enhanceCodeBlocks } from "./code-enhance.js";
import type {
  AgentEvent, AssistantBlock, AssistantPart, ApprovalPart, ClarificationPart,
  ModelRetryPart, NodePart, RoutePart, TextPart, ThinkingPart, ToolPart,
} from "../modules/types.js";

/** 「超过两个」才收进 tools；1–2 个保持平铺 */
export const TOOL_GROUP_MIN = 3;

const THROTTLE_MS = 55;

/* ---------------------------------------------------------------------------
 * 思考过程
 * ------------------------------------------------------------------------- */
export function updateThinkingPart(part: ThinkingPart): void {
  const refs = partEls.get(part);
  if (!refs) return;
  if (refs.textEl) refs.textEl.textContent = part.text;
  // 摘要只保留“思考中”这一临时状态；完成后不再显示字数或展开/收起文案。
  if (refs.metaEl) {
    refs.metaEl.textContent = part.streaming ? "思考中" : "";
    refs.metaEl.classList.toggle("hidden", !part.streaming);
  }
}

/** 思考内容节流渲染：token 很碎，逐片重排会拖慢长回答。 */
export function scheduleThinkingRender(part: ThinkingPart): void {
  if (thinkingTimers.has(part)) return;
  thinkingTimers.set(part, setTimeout(() => {
    thinkingTimers.delete(part);
    updateThinkingPart(part);
  }, THROTTLE_MS));
}

/** 供应商原生思考增量：同一节点的连续分片合并；新一轮思考另起折叠块。 */
export function appendReasoning(ablock: AssistantBlock, ev: { text?: string; node?: string }, visible = true): void {
  const text = String(ev.text || "");
  if (!text) return;
  const node = ev.node || "agent";
  let last: AssistantPart | undefined = ablock.parts[ablock.parts.length - 1];
  let nodeSeen = false;
  // 事件顺序可能是 node 更新先于 messages 分片：把刚出现的静态 chip 升级为折叠卡。
  if (last && last.p === "node" && last.name === node) {
    partEls.get(last)?.el.remove();
    ablock.parts.pop();
    nodeSeen = true;
    last = ablock.parts[ablock.parts.length - 1];
  }
  if (!last || last.p !== "thinking" || last.node !== node || !last.streaming) {
    const part: ThinkingPart = { p: "thinking", node, text: "", streaming: true, nodeSeen };
    ablock.parts.push(part);
    mountPart(ablock, part);
    last = part;
  }
  last.text += text;
  scheduleThinkingRender(last);
  if (visible) scrollBottom();
}

/* ---------------------------------------------------------------------------
 * 模型请求重试
 * ------------------------------------------------------------------------- */
function modelRetrySummary(part: ModelRetryPart): string {
  const latest = part.records.at(-1);
  if (!latest) return "模型请求重试";
  const maxRetries = Math.max(0, latest.totalAttempts - 1);
  if (latest.phase === "success") {
    return `模型重试 ${latest.retries}/${maxRetries} · 第 ${latest.attempt} 次请求成功`;
  }
  if (latest.phase === "failed") {
    return `模型重试 ${latest.retries}/${maxRetries} · ${latest.totalAttempts} 次请求后失败`;
  }
  return `模型重试 ${latest.retries}/${maxRetries} · 下次为第 ${latest.attempt + 1}/${latest.totalAttempts} 次请求`;
}

export function updateModelRetryPart(part: ModelRetryPart): void {
  const refs = partEls.get(part);
  if (!refs) return;
  const title = refs.el.querySelector<HTMLElement>(".model-retry-title");
  if (title) title.textContent = modelRetrySummary(part);
  if (refs.textEl) {
    refs.textEl.replaceChildren(...part.records.map((record) => {
      const item = document.createElement("div");
      item.className = "model-retry-item";
      const state = record.phase === "success"
        ? "成功"
        : record.phase === "failed" ? "最终失败" : "将重试";
      item.textContent = `第 ${record.attempt}/${record.totalAttempts} 次 · ${state} · ${record.reason}`;
      return item;
    }));
  }
}

export function upsertModelRetry(
  ablock: AssistantBlock,
  ev: Extract<AgentEvent, { type: "model_retry" }>,
  visible = true
): void {
  let part = [...ablock.parts].reverse().find((item): item is ModelRetryPart => item.p === "model_retry");
  if (!part) {
    part = { p: "model_retry", records: [] };
    ablock.parts.push(part);
    mountPart(ablock, part);
  }
  part.records.push({ ...ev });
  updateModelRetryPart(part);
  if (visible) scrollBottom();
}

/* ---------------------------------------------------------------------------
 * 工具卡
 * ------------------------------------------------------------------------- */
export function mountToolCard(block: AssistantBlock, card: HTMLElement): void {
  blockBodies.get(block)?.appendChild(card);
}

function isToolCategoryId(value: string): value is ToolCategoryId {
  return value in TOOL_CATEGORIES;
}

function createToolCategorySection(categoryId: ToolCategoryId): HTMLElement {
  const category = TOOL_CATEGORIES[categoryId];
  const section = h("section", {
    class: "tool-category-section",
    dataset: { categorySection: categoryId, toolCategory: categoryId },
  },
    h("div", { class: "tool-category-heading" },
      h("span", { class: "tool-category-heading-icon" }, icon(category.icon, { size: 12 })),
      h("span", { class: "tool-category-heading-label" }, category.label),
      h("span", { class: "tool-category-heading-count" }),
    ),
    h("div", { class: "tool-category-items" }),
  );
  return section;
}

/** 找到（或创建）一个分类区；工具名晚到导致类别变化时也能原地迁移。 */
function ensureToolCategorySection(items: HTMLElement, categoryId: ToolCategoryId): HTMLElement {
  const existing = [...items.children].find(
    (child): child is HTMLElement => child instanceof HTMLElement &&
      child.dataset.categorySection === categoryId,
  );
  if (existing) return existing;
  const section = createToolCategorySection(categoryId);
  items.appendChild(section);
  return section;
}

/** 动态刷新分组：类别、工具名、次数与审批/运行/失败状态都以卡片 DOM 为准。 */
function refreshToolGroup(group: HTMLElement | null): void {
  if (!group) return;
  const items = group.querySelector<HTMLElement>(".tool-group-items");
  if (!items) return;
  const cards = [...group.querySelectorAll<HTMLElement>(".tool-card")];

  for (const card of cards) {
    const raw = card.dataset.toolCategory || "other";
    const categoryId = isToolCategoryId(raw) ? raw : "other";
    const section = ensureToolCategorySection(items, categoryId);
    const categoryItems = section.querySelector<HTMLElement>(".tool-category-items");
    if (categoryItems && card.parentElement !== categoryItems) categoryItems.appendChild(card);
  }

  const sections = [...items.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && Boolean(child.dataset.categorySection),
  );
  for (const section of sections) {
    const count = section.querySelectorAll(".tool-card").length;
    if (!count) {
      section.remove();
      continue;
    }
    const countEl = section.querySelector<HTMLElement>(".tool-category-heading-count");
    if (countEl) countEl.textContent = `${count} 次`;
  }
  sections.sort((a, b) => {
    const ai = TOOL_CATEGORY_ORDER.indexOf(a.dataset.categorySection as ToolCategoryId);
    const bi = TOOL_CATEGORY_ORDER.indexOf(b.dataset.categorySection as ToolCategoryId);
    return (ai < 0 ? TOOL_CATEGORY_ORDER.length : ai) - (bi < 0 ? TOOL_CATEGORY_ORDER.length : bi);
  });
  for (const section of sections) items.appendChild(section);

  // 工具组只展示执行轨迹，默认折叠；房产地图与户型图在最终结论附件区展示。
  const categoryCounts = new Map<ToolCategoryId, number>();
  const nameCounts = new Map<string, number>();
  for (const card of cards) {
    const raw = card.dataset.toolCategory || "other";
    const categoryId = isToolCategoryId(raw) ? raw : "other";
    categoryCounts.set(categoryId, (categoryCounts.get(categoryId) || 0) + 1);
    const rawName = card.querySelector(".tool-name")?.textContent?.trim() || "tool";
    nameCounts.set(rawName, (nameCounts.get(rawName) || 0) + 1);
  }
  const categorySummary = [...categoryCounts.entries()]
    .sort((a, b) => TOOL_CATEGORY_ORDER.indexOf(a[0]) - TOOL_CATEGORY_ORDER.indexOf(b[0]))
    .map(([id, count]) => `${TOOL_CATEGORIES[id].label} ×${count}`)
    .join(" · ");
  const nameSummary = [...nameCounts.entries()]
    .map(([name, count]) => count > 1 ? `${name} ×${count}` : name)
    .join(" · ");
  const summaryText = [categorySummary, nameSummary].filter(Boolean).join("｜");

  const countEl = group.querySelector(".tool-group-count");
  if (countEl) countEl.textContent = `${cards.length} 次调用`;
  const namesEl = group.querySelector(".tool-group-names");
  if (namesEl) namesEl.textContent = summaryText;
  const statusEl = group.querySelector(".tool-group-status");
  if (statusEl) {
    const awaiting = cards.filter((card) => card.classList.contains("awaiting")).length;
    const running = cards.filter((card) => card.classList.contains("running")).length;
    const needsAction = cards.filter((card) => card.classList.contains("needs-action")).length;
    const errors = cards.filter((card) => card.classList.contains("err")).length;
    statusEl.textContent = awaiting
      ? `${awaiting} 个待审批${running ? ` · ${running} 个运行中` : ""}`
      : running ? `${running} 个运行中`
        : needsAction ? `${needsAction} 个需要处理`
          : errors ? `${errors} 个失败`
            : "全部完成";
    statusEl.className = `tool-group-status${needsAction ? " warn" : errors && !running && !awaiting ? " err" : ""}`;
  }
  group.title = `${cards.length} 次工具调用：${summaryText}`;
}

/** 将 tools 节点前紧邻的工具卡按类别分组；摘要同时保留类别与原始工具名。 */
export function groupToolCallsIfNeeded(
  block: AssistantBlock, body: HTMLElement, nodePart: NodePart
): HTMLElement | null {
  const nodeIndex = block.parts.indexOf(nodePart);
  if (nodeIndex < 0) return null;
  let start = nodeIndex - 1;
  while (start >= 0 && block.parts[start].p === "tool") start -= 1;
  const tools = block.parts.slice(start + 1, nodeIndex).filter((p): p is ToolPart => p.p === "tool");
  if (tools.length < TOOL_GROUP_MIN) return null;
  const firstCard = partEls.get(tools[0])?.el;
  if (!firstCard || firstCard.parentElement !== body) return null;

  // 工具组只展示执行轨迹，默认折叠；结论中的地图和图片由 conclusion-media 渲染。
  const details = h("details", { class: "tool-group" },
    h("summary", { class: "tool-group-summary" },
      h("span", { class: "tool-group-caret" }, "▶"),
      h("span", { class: "tool-group-icon" }, icon("Wrench", { size: 13 })),
      h("span", { class: "tool-group-title" }, "工具调用"),
      h("span", { class: "tool-group-count" }),
      h("span", { class: "tool-group-names" }),
      h("span", { class: "tool-group-status" }),
    ),
    h("div", { class: "tool-group-items" }),
  );
  firstCard.parentElement.insertBefore(details, firstCard);
  const items = details.querySelector<HTMLElement>(".tool-group-items");
  if (items) {
    for (const tool of tools) {
      const card = partEls.get(tool)?.el;
      if (!card) continue;
      const categoryId = describeTool(tool).category.id;
      const section = ensureToolCategorySection(items, categoryId);
      section.querySelector<HTMLElement>(".tool-category-items")?.appendChild(card);
    }
  }
  refreshToolGroup(details);
  return details;
}

export function updateToolCard(part: ToolPart): void {
  const refs = partEls.get(part);
  if (!refs) return;
  const card = refs.el;
  const presentation = describeTool(part);
  card.dataset.toolCategory = presentation.category.id;

  const iconEl = card.querySelector<HTMLElement>(".tool-icon");
  if (iconEl && iconEl.dataset.categoryIcon !== presentation.category.icon) {
    iconEl.dataset.categoryIcon = presentation.category.icon;
    iconEl.replaceChildren(icon(presentation.category.icon, { size: 13 }));
  }
  const categoryEl = card.querySelector(".tool-category");
  if (categoryEl) categoryEl.textContent = presentation.category.label;
  const nameEl = card.querySelector(".tool-name");
  if (nameEl) nameEl.textContent = presentation.rawName;
  const preview = card.querySelector(".tool-args-preview");
  if (preview) preview.textContent = presentation.summary;
  const labels = card.querySelectorAll<HTMLElement>(".tool-label");
  if (labels[0]) labels[0].textContent = presentation.category.argsLabel;
  if (labels[1]) labels[1].textContent = presentation.category.resultLabel;

  const argsPre = card.querySelector(".args-pre");
  if (argsPre) argsPre.textContent = fmtArgs(part);

  const status = card.querySelector(".tool-status");
  // 等审批 ≠ 运行中：审批是执行前的闸门，此时工具一次都还没跑。
  // 不改文案的话用户会以为命令已经在执行，审批只是事后确认。
  if (!part.result && part.awaitingApproval && status) {
    card.classList.remove("running");
    card.classList.add("awaiting");
    status.className = "tool-status awaiting";
    status.textContent = "⏸ 待审批";
  }
  if (part.result && status) {
    // awaiting 也要清：批准后工具真正开始执行，琥珀色「待审批」边框不能留着
    card.classList.remove("running", "awaiting");
    card.classList.add(part.result.isError ? "err" : "ok");
    status.className = "tool-status " + (part.result.isError ? "err" : "ok");
    const unsupported = part.result.isError && /当前 Agent 不支持工具/.test(String(part.result.content));
    status.textContent = unsupported ? "✕ 不支持" : part.result.isError ? "✕ 失败" : "✓ 完成";
    const resultPre = card.querySelector(".result-pre");
    if (resultPre) {
      resultPre.textContent = part.result.content;
      resultPre.className = "result-pre" + (part.result.isError ? " err" : "");
    }
    // 知识库 / 房产等业务增强由 main.ts 注册，render/* 不反向依赖 views/*
    renderToolEnhancers(part, card);
  }
  // 委派卡在参数阶段就显示目标与授权边界，结果到达后原地替换为执行摘要。
  if (part.name === "delegate_agent") renderDelegateInToolCard(part, card);
  refreshToolGroup(card.closest<HTMLElement>(".tool-group"));
}
/* ---------------------------------------------------------------------------
 * 正文文本
 * ------------------------------------------------------------------------- */
const enhancedTextParts = new WeakSet<TextPart>();

function paintText(part: TextPart, el: HTMLElement): void {
  el.innerHTML = renderMarkdown(part.text);
  if (part.streaming) el.appendChild(h("span", { class: "cursor", "aria-hidden": "true" }));
  else void enhanceCodeBlocks(el);
}

export function renderTextPart(part: TextPart): void {
  const refs = partEls.get(part);
  if (!refs) return;
  paintText(part, refs.el);
  if (enhancedTextParts.has(part)) return;
  enhancedTextParts.add(part);
  void ensureMarkdownRenderer().then((ready) => {
    if (ready && partEls.get(part)?.el === refs.el) paintText(part, refs.el);
  });
}
export function scheduleTextRender(part: TextPart): void {
  if (textTimers.has(part)) return;
  textTimers.set(part, setTimeout(() => {
    textTimers.delete(part);
    renderTextPart(part);
  }, THROTTLE_MS));
}

/* ---------------------------------------------------------------------------
 * 审批卡 / 澄清卡
 * ------------------------------------------------------------------------- */
export function renderApprovalCard(part: ApprovalPart, el: HTMLElement): void {
  const req = part.req;
  const pending = part.status === "pending";
  if (!pending && part.collapsed === undefined) part.collapsed = true;
  const collapsed = Boolean(part.collapsed);
  const approved = part.status === "approved" || part.status === "resolved";
  const rejected = part.status === "rejected";
  el.classList.toggle("done-approve", approved);
  el.classList.toggle("done-reject", rejected);
  el.classList.toggle("collapsed", collapsed);
  el.replaceChildren(
    h("button", { type: "button", class: "approval-summary", "aria-expanded": String(!collapsed) },
      h("span", { class: "approval-summary-icon" }, icon("ShieldAlert", { size: 15 })),
      h("span", { class: "approval-summary-copy" }, h("strong"), h("small")),
      h("span", { class: "approval-verdict" }),
      h("span", { class: "approval-chevron" }, icon("ChevronRight", { size: 12 })),
    ),
    h("div", { class: "approval-body" },
      h("div", { class: "approval-risk-reason hidden" }),
      h("div", { class: "approval-desc" }),
      h("div", { class: "approval-args" }),
      h("div", { class: "approval-actions" }),
    ),
  );
  const strong = el.querySelector(".approval-summary-copy strong");
  if (strong) {
    strong.textContent = pending
      ? (req.riskReason ? "AI 判定高风险 · 需要审批" : "需要人工审批")
      : "人工审批已完成";
  }
  const small = el.querySelector(".approval-summary-copy small");
  if (small) small.textContent = `${req.toolName || "工具操作"}${req.riskReason ? " · 自主评估" : ""}`;
  const verdict = el.querySelector(".approval-verdict");
  if (verdict) {
    verdict.textContent = pending
      ? "待确认"
      : part.status === "approved" ? "✅ 已批准"
        : part.status === "rejected" ? "🚫 已拒绝"
          : "此前已处理";
    verdict.classList.toggle("ok", approved);
    verdict.classList.toggle("err", rejected);
  }
  const riskEl = el.querySelector(".approval-risk-reason");
  if (riskEl) {
    riskEl.classList.toggle("hidden", !req.riskReason);
    riskEl.textContent = req.riskReason ? `自主风险评估：${req.riskReason}` : "";
  }
  const descEl = el.querySelector(".approval-desc");
  if (descEl) descEl.textContent = `Agent 请求执行高风险工具「${req.toolName}」：${req.description}`;
  const argsEl = el.querySelector(".approval-args");
  if (argsEl) argsEl.textContent = JSON.stringify(req.args, null, 2);
  el.querySelector(".approval-summary")?.addEventListener("click", () => {
    part.collapsed = !part.collapsed;
    renderApprovalCard(part, el);
    saveLocal();
  });

  const actions = el.querySelector(".approval-actions");
  if (!actions) return;
  if (pending) {
    const ok = document.createElement("button");
    ok.className = "btn btn-approve";
    ok.textContent = "✓ 批准并执行";
    ok.addEventListener("click", () => { void decideApproval(part, "approved"); });
    const no = document.createElement("button");
    no.className = "btn btn-reject";
    no.textContent = "✕ 拒绝";
    no.addEventListener("click", () => { void decideApproval(part, "rejected"); });
    actions.append(ok, no);
  } else {
    actions.remove();
  }
}

export function renderClarificationCard(part: ClarificationPart, el: HTMLElement): void {
  renderClarificationCardImpl(part, el);
}

/* 澄清卡实现在 render/clarify-card.ts（多题逐答、进度与提交），
   parts.ts 只做分派，保持「一个文件一件事」。 */
export { clarificationAnswerLines } from "./clarify-card.js";

/* ---------------------------------------------------------------------------
 * 单个 part 的挂载（按 p 分派）
 * ------------------------------------------------------------------------- */
export function mountPart(block: AssistantBlock, part: AssistantPart): void {
  const body = blockBodies.get(block);
  if (!body) return;
  unmountTyping(block);

  if (part.p === "text") {
    const el = document.createElement("div");
    el.className = "md";
    body.appendChild(el);
    partEls.set(part, { el });
    renderTextPart(part);
    // 历史回放时没有 done 事件；最终文本挂载完成即可补齐结论附件。
    if (!part.streaming) refreshConclusionMedia(block);
    return;
  }

  if (part.p === "thinking") {
    const details = document.createElement("details");
    details.className = "thinking-block";
    details.append(
      h("summary", { class: "thinking-summary" },
        h("span", { class: "thinking-spark" }, icon("Brain", { size: 13 })),
        h("span", { class: "thinking-title" }, "思考过程"),
        h("span", { class: "thinking-node" }),
        h("span", { class: "thinking-meta" }),
        h("span", { class: "thinking-chevron" }, icon("ChevronRight", { size: 12 })),
      ),
      h("div", { class: "thinking-body" }, h("pre", { class: "thinking-text" })),
    );
    const nodeEl = details.querySelector(".thinking-node");
    if (nodeEl) nodeEl.textContent = `${nodeIcon(part.node)} ${nodeLabel(part.node)}`;
    body.appendChild(details);
    partEls.set(part, {
      el: details,
      textEl: details.querySelector<HTMLElement>(".thinking-text") ?? undefined,
      metaEl: details.querySelector<HTMLElement>(".thinking-meta") ?? undefined,
    });
    details.addEventListener("toggle", () => updateThinkingPart(part));
    updateThinkingPart(part);
    return;
  }

  if (part.p === "model_retry") {
    const details = document.createElement("details");
    details.className = "model-retry-block";
    details.append(
      h("summary", { class: "model-retry-summary" },
        h("span", { class: "model-retry-icon" }, icon("RefreshCw", { size: 13 })),
        h("span", { class: "model-retry-title" }, "模型请求重试"),
        h("span", { class: "model-retry-chevron" }, icon("ChevronRight", { size: 11 })),
      ),
      h("div", { class: "model-retry-body" }),
    );
    body.appendChild(details);
    partEls.set(part, {
      el: details,
      textEl: details.querySelector<HTMLElement>(".model-retry-body") ?? undefined,
    });
    updateModelRetryPart(part);
    return;
  }

  if (part.p === "node") {
    if (part.name === "tools") {
      const grouped = groupToolCallsIfNeeded(block, body, part);
      if (grouped) {
        partEls.set(part, { el: grouped });
        return;
      }
    }
    const chip = document.createElement("span");
    chip.className = "node-chip";
    chip.textContent = `${nodeIcon(part.name)} ${nodeLabel(part.name)}`;
    const row = document.createElement("div");
    row.className = "node-row";
    row.appendChild(chip);
    body.appendChild(row);
    partEls.set(part, { el: row });
    return;
  }

  if (part.p === "tool") {
    const card = document.createElement("div");
    card.className = "tool-card running";
    card.replaceChildren(
      h("div", { class: "tool-head" },
        h("span", { class: "tool-icon" }),
        h("span", { class: "tool-category" }),
        h("span", { class: "tool-name" }),
        h("span", { class: "tool-args-preview" }),
        h("span", { class: "tool-status" }, h("span", { class: "spinner" }), "运行中"),
        h("span", { class: "chevron" }, "▶"),
      ),
      h("div", { class: "tool-body" },
        h("div", { class: "tool-section" }, h("div", { class: "tool-label" }, "参数"), h("pre", { class: "args-pre" })),
        h("div", { class: "tool-section" }, h("div", { class: "tool-label" }, "结果"), h("pre", { class: "result-pre" }, "…")),
      ),
    );
    card.querySelector(".tool-head")?.addEventListener("click", () => card.classList.toggle("open"));
    mountToolCard(block, card);
    partEls.set(part, { el: card });
    updateToolCard(part);
    return;
  }

  if (part.p === "approval") {
    const el = document.createElement("div");
    el.className = "approval-card";
    renderApprovalCard(part, el);
    body.appendChild(el);
    partEls.set(part, { el });
    return;
  }

  if (part.p === "clarification") {
    const el = document.createElement("div");
    el.className = "approval-card clarification-card";
    renderClarificationCard(part, el);
    body.appendChild(el);
    partEls.set(part, { el });
    return;
  }

  if (part.p === "route") {
    body.appendChild(renderRouteCard(part));
    return;
  }
}

/* ---------------------------------------------------------------------------
 * 打字指示器
 * ------------------------------------------------------------------------- */
export function mountTyping(block: AssistantBlock): void {
  const body = blockBodies.get(block);
  if (!body || block._typing) return;
  const t = document.createElement("div");
  t.className = "typing";
  t.replaceChildren(h("i"), h("i"), h("i"));
  body.appendChild(t);
  block._typing = t;
}

export function unmountTyping(block: AssistantBlock): void {
  if (block._typing) { block._typing.remove(); block._typing = null; }
}

/** 审批状态属于产生 interrupt 的会话，不能写到用户当前正在查看的另一个会话。 */
export function setPendingApproval(on: boolean, sid: string | null = state.currentId): void {
  const s = state.sessions.find((x) => x.id === sid);
  if (s) s.pendingApproval = on;
}

/* ---------------------------------------------------------------------------
 * 路由决策卡
 * ------------------------------------------------------------------------- */
const ROUTE_LAYER_LABELS: Record<RoutePart["layer"], string> = {
  rule: "规则匹配",
  vector: "向量比对",
  model: "决策模型",
  fallback: "降级兜底",
};

const ROUTE_KIND_LABELS: Record<RoutePart["kind"], string> = {
  dispatch: "已派发",
  ask: "等待确认",
  main: "当前 Agent",
};

/**
 * 路由卡：默认折叠，摘要行直接给出「派给谁 + 来自哪一层」。
 * 展开后给出置信度、分差与候选打分，方便判断是否误派。
 */
export function renderRouteCard(part: RoutePart): HTMLElement {
  const details = document.createElement("details");
  details.className = `route-card layer-${part.layer} kind-${part.kind}`;
  const target = part.kind === "dispatch" && part.agentName
    ? part.agentName
    : ROUTE_KIND_LABELS[part.kind];
  details.append(
    h("summary", { class: "route-summary" },
      h("span", { class: "route-icon" }, icon("Waypoints", { size: 13 })),
      h("span", { class: "route-title" }, `路由：${target}`),
      h("span", { class: "route-layer" }, ROUTE_LAYER_LABELS[part.layer]),
      h("span", { class: "route-chevron" }, icon("ChevronRight", { size: 11 })),
    ),
    h("div", { class: "route-body" }),
  );
  const body = details.querySelector(".route-body");
  if (!body) return details;

  body.appendChild(h("p", { class: "route-reason" }, part.reason || "（无依据说明）"));

  const metrics = [
    `置信度 ${part.confidence.toFixed(2)}`,
    part.candidates.length > 1 ? `分差 ${part.margin.toFixed(2)}` : "",
    part.handoffCount > 0 ? `已转回 ${part.handoffCount} 次` : "",
  ].filter(Boolean);
  if (metrics.length) body.appendChild(h("div", { class: "route-metrics" }, metrics.join("  ·  ")));

  if (part.candidates.length) {
    const list = h("div", { class: "route-candidates" });
    for (const candidate of part.candidates.slice(0, 6)) {
      const row = h("div", { class: "route-candidate" },
        h("span", { class: "route-candidate-name" }, candidate.name),
        h("span", { class: "route-candidate-score" }, candidate.score.toFixed(2)),
      );
      if (candidate.agentId === part.agentId) row.classList.add("chosen");
      list.appendChild(row);
    }
    body.appendChild(list);
  }
  return details;
}
