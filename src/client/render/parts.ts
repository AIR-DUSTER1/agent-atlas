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
  ensureMarkdownRenderer, fmtArgs, nodeIcon, nodeLabel, renderMarkdown, TOOL_ICONS,
} from "../modules/format.js";
import {
  blockBodies, partEls, saveLocal, state, textTimers, thinkingTimers,
} from "../core/state.js";
import { scrollBottom } from "../core/dom.js";
import { decideApproval, decideClarification } from "../actions/approvals.js";
import { renderToolEnhancers } from "./tool-enhancers.js";
import { h } from "../ui/h.js";
import { icon } from "../ui/icon.js";
import { renderDelegateInToolCard } from "./delegate-card.js";
import { enhanceCodeBlocks } from "./code-enhance.js";
import type {
  AssistantBlock, AssistantPart, ApprovalPart, ClarificationPart,
  NodePart, TextPart, ThinkingPart, ToolPart,
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
  const stateText = part.streaming ? "思考中" : `${part.text.length} 字`;
  if (refs.metaEl) refs.metaEl.textContent = `${stateText} · ${refs.el instanceof HTMLDetailsElement && refs.el.open ? "收起" : "展开"}`;
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
export function appendReasoning(ablock: AssistantBlock, ev: { text?: string; node?: string }): void {
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
  scrollBottom();
}

/* ---------------------------------------------------------------------------
 * 工具卡
 * ------------------------------------------------------------------------- */
export function mountToolCard(block: AssistantBlock, card: HTMLElement): void {
  blockBodies.get(block)?.appendChild(card);
}

/** 将 tools 节点前紧邻的工具卡折叠成一个可展开分组，摘要保留工具名与次数。 */
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

  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = tool.name || "tool";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const nameSummary = [...counts.entries()]
    .map(([name, count]) => count > 1 ? `${name} ×${count}` : name)
    .join(" · ");
  const running = tools.filter((tool) => !tool.result).length;
  const errors = tools.filter((tool) => tool.result?.isError).length;
  const status = running ? `${running} 个运行中` : errors ? `${errors} 个失败` : "全部完成";

  const details = h("details", { class: "tool-group" },
    h("summary", { class: "tool-group-summary" },
      h("span", { class: "tool-group-caret" }, "▶"),
      h("span", { class: "tool-group-icon" }, icon("Wrench", { size: 13 })),
      h("span", { class: "tool-group-title" }, "tools"),
      h("span", { class: "tool-group-count" }),
      h("span", { class: "tool-group-names" }),
      h("span", { class: "tool-group-status" }),
    ),
    h("div", { class: "tool-group-items" }),
  );
  const countEl = details.querySelector(".tool-group-count");
  if (countEl) countEl.textContent = `${tools.length} 次调用`;
  const namesEl = details.querySelector(".tool-group-names");
  if (namesEl) namesEl.textContent = nameSummary;
  const statusEl = details.querySelector(".tool-group-status");
  if (statusEl) statusEl.textContent = status;
  details.title = `${tools.length} 次工具调用：${nameSummary}`;
  const items = details.querySelector(".tool-group-items");
  firstCard.parentElement.insertBefore(details, firstCard);
  if (items) {
    for (const tool of tools) {
      const el = partEls.get(tool)?.el;
      if (el) items.appendChild(el);
    }
  }
  return details;
}

export function updateToolCard(part: ToolPart): void {
  const refs = partEls.get(part);
  if (!refs) return;
  const card = refs.el;
  const firstLine = (part.result?.content || part.argsText || "").split("\n")[0] || "";
  const preview = card.querySelector(".tool-args-preview");
  if (preview) preview.textContent = firstLine.slice(0, 120);
  const argsPre = card.querySelector(".args-pre");
  if (argsPre) argsPre.textContent = fmtArgs(part);

  const status = card.querySelector(".tool-status");
  if (part.result && status) {
    card.classList.remove("running");
    card.classList.add(part.result.isError ? "err" : "ok");
    status.className = "tool-status " + (part.result.isError ? "err" : "ok");
    const unsupported = part.result.isError && /当前 Agent 不支持工具/.test(String(part.result.content));
    status.textContent = unsupported ? "✕ 不支持" : part.result.isError ? "✕ 失败" : "✓ 完成";
    const resultPre = card.querySelector(".result-pre");
    if (resultPre) {
      resultPre.textContent = part.result.content;
      resultPre.className = "result-pre" + (part.result.isError ? " err" : "");
    }
    // 委派是通用编排能力，直接渲染耗时与子 Agent 工具
    if (part.name === "delegate_agent") renderDelegateInToolCard(part, card);
    // 知识库 / 房产等业务增强由 main.ts 注册，render/* 不反向依赖 views/*
    renderToolEnhancers(part, card);
  }
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
  const req = part.req;
  el.replaceChildren(
    h("div", { class: "approval-title" }, icon("CircleAlert", { size: 15 }), "需求澄清（请选择一个方向）"),
    h("div", { class: "approval-desc" }),
    h("div", { class: "clarify-options" }),
    h("div", { class: "clarify-custom hidden" }),
    h("div", { class: "approval-actions" }),
  );
  const descEl = el.querySelector(".approval-desc");
  if (descEl) descEl.textContent = req.question || "请补充关键信息后继续";
  const options = el.querySelector(".clarify-options");
  const actions = el.querySelector(".approval-actions");

  if (part.status === "pending") {
    for (const opt of Array.isArray(req.options) ? req.options : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clarify-option";
      const label = document.createElement("span");
      label.className = "clarify-option-label";
      label.textContent = `${opt.id}. ${opt.label}`;
      button.appendChild(label);
      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "clarify-option-desc";
        desc.textContent = opt.description;
        button.appendChild(desc);
      }
      button.addEventListener("click", () => {
        void decideClarification(part, opt.id, `${opt.label}${opt.description ? `（${opt.description}）` : ""}`);
      });
      options?.appendChild(button);
    }

    if (req.allowCustom !== false) {
      const custom = el.querySelector(".clarify-custom");
      if (custom) {
        custom.classList.remove("hidden");
        const input = document.createElement("input");
        input.className = "clarify-input";
        input.type = "text";
        input.maxLength = 2000;
        input.placeholder = "也可以直接输入补充说明…";
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "btn btn-approve";
        submit.textContent = "提交";
        const fire = (): void => {
          const value = input.value.trim();
          if (value) void decideClarification(part, value, value);
        };
        submit.addEventListener("click", fire);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            fire();
          }
        });
        custom.append(input, submit);
      }
    }
  } else {
    el.classList.add("done-approve");
    const verdict = document.createElement("div");
    verdict.className = "approval-verdict";
    verdict.textContent = part.answer ? `已选择：${part.answer}` : "此前已处理";
    actions?.appendChild(verdict);
  }
}

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
        h("span", { class: "thinking-chevron" }, icon("ChevronRight", { size: 11 })),
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
        h("span", { class: "tool-name" }),
        h("span", { class: "tool-args-preview" }),
        h("span", { class: "tool-status" }, h("span", { class: "spinner" }), "运行中"),
        h("span", { class: "chevron" }, "▶"),
      ),
      h("div", { class: "tool-body" },
        h("div", { class: "tool-section" }, h("div", { class: "tool-label" }, "参数 (流式)"), h("pre", { class: "args-pre" })),
        h("div", { class: "tool-section" }, h("div", { class: "tool-label" }, "结果"), h("pre", { class: "result-pre" }, "…")),
      ),
    );
    const iconEl = card.querySelector(".tool-icon");
    if (iconEl) iconEl.textContent = TOOL_ICONS[part.name] || "🔧";
    const nameEl = card.querySelector(".tool-name");
    if (nameEl) nameEl.textContent = part.name || "tool";
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

/** 供 stream 层使用的当前会话判定（避免各处重复查表） */
export function setPendingApproval(on: boolean): void {
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = on;
}
