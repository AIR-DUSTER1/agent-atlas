/**
 * ============================================================
 * stream/events.ts — SSE 事件 → 对话块更新（协议消费端）
 * ============================================================
 * 职责：解析 data: 帧，把每个 AgentEvent 落到对应的 part 上。
 * 设计立场：
 *  - 这是「后端协议 → 前端结构」的唯一翻译处；服务端新增事件时必须在这里加
 *    case（switch 尾部的 never 断言会让漏接编译失败，而不是运行时静默失联）；
 *  - 增量事件（token / tool_call）只更新既有 part 的文本与状态，不重建 DOM；
 *  - usage 事件同时驱动上下文容量条与会话级缓存，故会写 state.usage。
 */

import { partEls, saveLocal, state, transcript } from "../core/state.js";
import { scrollBottom } from "../core/dom.js";
import { updateContextBar } from "../views/composer-bar.js";
import { setWorkflowPlan } from "../views/workflow-plan.js";
import { mountBlock, updateTurnCaption } from "../render/messages.js";
import { refreshConclusionMedia, sanitizeEstateConclusionText } from "../render/conclusion-media.js";
import {
  appendReasoning, mountPart, renderTextPart, scheduleTextRender, setPendingApproval,
  updateThinkingPart, updateToolCard, upsertModelRetry,
} from "../render/parts.js";

import type {
  AgentEvent, AssistantBlock, AssistantPart, InterruptPayload,
  TextPart, ToolPart, UsageInfo,
} from "../modules/types.js";

/* ---------------------------------------------------------------------------
 * 增量事件处理
 * ------------------------------------------------------------------------- */
function sealStreamingParts(ablock: AssistantBlock, kinds: Array<"text" | "thinking"> = ["text", "thinking"]): void {
  for (const part of ablock.parts) {
    if (!kinds.includes(part.p as "text" | "thinking") || !("streaming" in part) || !part.streaming) continue;
    part.streaming = false;
    if (part.p === "text") {
      part.text = sanitizeEstateConclusionText(ablock, part.text);
      renderTextPart(part);
    } else if (part.p === "thinking") updateThinkingPart(part);
  }
}
export function appendToken(ablock: AssistantBlock, text: string, visible = true): void {
  const parts = ablock.parts;
  let last = parts[parts.length - 1];
  if (!last || last.p !== "text" || !last.streaming) {
    const part: TextPart = { p: "text", text: "", streaming: true };
    parts.push(part);
    mountPart(ablock, part);
    last = part;
  }
  if (last.p === "text") {
    last.text += text;
    scheduleTextRender(last);
  }
  if (visible) scrollBottom();
}

export function upsertToolCall(
  ablock: AssistantBlock, ev: { id: string; name?: string; argsFragment?: string }, visible = true
): void {
  sealStreamingParts(ablock);

  let part = [...ablock.parts].reverse().find(
    (p): p is ToolPart => p.p === "tool" && p.id === ev.id
  );
  if (!part) {
    const created: ToolPart = { p: "tool", id: ev.id, name: ev.name || "", argsText: "", result: null };
    ablock.parts.push(created);
    mountPart(ablock, created);
    return;
  }
  // 名字可能晚于首个分片到达；updateToolCard 会同步重算分类、图标和摘要。
  if (ev.name && !part.name) part.name = ev.name;
  part.argsText += ev.argsFragment || "";
  updateToolCard(part);
  if (visible) scrollBottom();
}

export function fillToolResult(
  ablock: AssistantBlock, ev: { id: string; content: string; isError?: boolean }, sid: string | null, visible = true
): void {
  const blocks = (sid ? state.blocks[sid] : []) || [];
  // 结果可能晚于换会话到达：先在当前块找，再回退到本会话所有助手块
  const fromAll = blocks
    .flatMap((b) => (b.t === "assistant" ? b.parts : []))
    .reverse()
    .find((p): p is ToolPart => p.p === "tool" && p.id === ev.id);
  const part = ablock.parts.find((p): p is ToolPart => p.p === "tool" && p.id === ev.id) || fromAll;
  if (!part) return;
  part.result = { content: ev.content, isError: Boolean(ev.isError) };
  updateToolCard(part);
  if (visible) scrollBottom();
}

export function addNodeChip(ablock: AssistantBlock, name: string, visible = true): void {
  sealStreamingParts(ablock);
  // 同一节点的思考卡已经承担了步骤标题，不再重复生成静态 chip。
  const thinking = [...ablock.parts].reverse().find(
    (part) => part.p === "thinking" && part.node === name && !part.nodeSeen
  );
  if (thinking) {
    if (thinking.p === "thinking") thinking.nodeSeen = true;
    return;
  }
  const last = ablock.parts[ablock.parts.length - 1];
  if (last && last.p === "node" && last.name === name) return; // 相邻去重
  const part: AssistantPart = { p: "node", name };
  ablock.parts.push(part);
  mountPart(ablock, part);
  if (visible) scrollBottom();
}

/**
 * 把「等审批」标到对应的工具卡上。
 *
 * 工具卡从参数流式阶段就显示「运行中」，但审批类工具在这一刻其实**还没执行** ——
 * interrupt 是执行前的闸门。不标出来用户会以为命令已经在跑、审批只是事后补签。
 * 载荷里没有 callId，按工具名取「最近一张尚无结果的同名卡」：同一轮的同名同参调用
 * 会被签名去重，不会有多张并存，这个匹配是确定的。
 */
function markAwaitingApproval(ablock: AssistantBlock, toolName: string, pending: boolean): void {
  for (let i = ablock.parts.length - 1; i >= 0; i -= 1) {
    const part = ablock.parts[i];
    if (part?.p !== "tool" || part.name !== toolName || part.result) continue;
    part.awaitingApproval = pending;
    void import("../render/parts.js").then((m) => m.updateToolCard(part));
    return;
  }
}

export function addInterrupt(ablock: AssistantBlock, payload: InterruptPayload, sid: string | null, visible = true): void {
  sealStreamingParts(ablock);
  if (payload.type === "approval") markAwaitingApproval(ablock, payload.toolName, true);
  if (payload.type === "clarification") {
    const part: AssistantPart = { p: "clarification", req: payload, status: "pending" };
    ablock.parts.push(part);
    mountPart(ablock, part);
  } else {
    const part: AssistantPart = { p: "approval", req: payload, status: "pending" };
    ablock.parts.push(part);
    mountPart(ablock, part);
  }
  setPendingApproval(true, sid);
  if (visible) scrollBottom(true);
  // interrupt 之后这一轮就没有更多内容了：服务端会立刻补 done/end，但浏览器拿到
  // 流末尾的时机不可控（代理缓冲、close 事件竞争都会拖）。这里主动把该会话的
  // 「生成中」状态收掉 —— 否则用户在这个窗口里点「批准并执行」会被
  // decideApproval 的流占用守卫拦住，表现就是按钮点不动。
  releaseStreamAfterInterrupt(sid, ablock);
}

/**
 * interrupt 到达即视为本轮结束：解除本会话的流占用，让审批/澄清可以立即响应。
 *
 * 只清「确实属于这个块」的那条流，避免误伤用户随后新发起的一轮。
 * 后续 resume 会登记全新的流对象，所以这里删掉旧的一条不会影响它。
 */
function releaseStreamAfterInterrupt(sid: string | null, ablock: AssistantBlock): void {
  if (!sid) return;
  const stream = state.streams[sid];
  if (!stream || stream.ablock !== ablock) return;
  delete state.streams[sid];
  // 后台会话（用户已切走）不碰输入区；当前会话则恢复发送按钮、隐藏停止按钮。
  if (sid === state.currentId) void import("../stream/turn.js").then((m) => m.syncComposerState(sid));
  sideRenderSessions();
}

/** 侧栏「生成中」标记挂在 state.streams 上，解除流占用后必须重绘才能消失。 */
function sideRenderSessions(): void {
  void import("../views/sessions.js").then((m) => m.renderSessions());
}

export function addErrorBlock(message: string, sid: string | null = state.currentId): void {
  const block = { t: "error" as const, text: message };
  transcript(sid).push(block);
  if (sid === state.currentId) {
    mountBlock(block);
    scrollBottom(true);
  }
  saveLocal();
}

/* ---------------------------------------------------------------------------
 * 主分派
 * ------------------------------------------------------------------------- */
export function applyUsage(
  ev: Extract<AgentEvent, { type: "usage" }>,
  ablock?: AssistantBlock,
  sid: string | null = state.currentId,
): void {
  if (!sid) return;
  const u = state.usage[sid] || (state.usage[sid] = { lastInput: 0, lastOutput: 0, lastCache: 0 });
  // 新服务端事件直接携带任务快照；旧 journal 没有这些字段时才走下面的本地峰值推算。
  if (typeof ev.taskInputTokens === "number" && typeof ev.taskOutputTokens === "number") {
    u.taskInput = ev.taskInputTokens;
    u.taskOutput = ev.taskOutputTokens;
    u.taskTools = ev.taskToolCalls ?? u.taskTools;
    u.taskModels = ev.taskModelCalls ?? u.taskModels;
    u.taskActiveMs = ev.taskActiveMs ?? u.taskActiveMs;
  } else {
    // 旧 journal 没有服务端任务快照时的兼容推算：内部 analyze/review/tool-risk
    // 也是真实成本；只有主循环 usage 才可覆盖当前请求上下文与缓存口径。
    const usageKey = ev.callId ?? `${ev.node ?? ""}|${ev.inputTokens}|${ev.outputTokens}|${ev.internal ? 1 : 0}`;
    const peaks = (u.usagePeaks ??= {});
    const previous = peaks[usageKey] ?? { input: 0, output: 0 };
    const next = { input: Math.max(previous.input, ev.inputTokens), output: Math.max(previous.output, ev.outputTokens) };
    peaks[usageKey] = next;
    const taskPeaks = (u.taskUsagePeaks ??= {});
    const alreadyCounted = taskPeaks[usageKey] ?? { input: 0, output: 0 };
    const taskNext = {
      input: Math.max(alreadyCounted.input, next.input),
      output: Math.max(alreadyCounted.output, next.output),
    };
    taskPeaks[usageKey] = taskNext;
    u.taskInput = (u.taskInput ?? 0) + Math.max(0, taskNext.input - alreadyCounted.input);
    u.taskOutput = (u.taskOutput ?? 0) + Math.max(0, taskNext.output - alreadyCounted.output);
  }
  u.lastActivityAt = Date.now();
  if (typeof ev.contextWindow === "number") u.contextWindow = ev.contextWindow;
  if (typeof ev.contextInputBudget === "number") u.contextInputBudget = ev.contextInputBudget;
  if (typeof ev.outputReserveTokens === "number") u.outputReserveTokens = ev.outputReserveTokens;
  if (typeof ev.safetyMarginTokens === "number") u.safetyMarginTokens = ev.safetyMarginTokens;
  saveLocal();
  if (ev.internal) return;
  // 上下文占用是「本次请求送进去的 input」，不能把生成出来的 output 再加一次：
  // 下一轮只有 input 会重新进入上下文，output 已在 checkpoint 中体现为一条回答。
  const context = ev.inputTokens;
  // 一轮内可能多次调用主 Agent（工具后继续）；容量条取本轮输入峰值，避免工具间隙回跳。
  if (u.contextPending || !u.contextTokens || context >= u.contextTokens) {
    u.lastInput = ev.inputTokens;
    u.lastOutput = ev.outputTokens;
    u.lastCache = ev.cacheReadTokens || 0;
    u.contextTokens = context;
    if (ablock) ablock._usage = { lastInput: ev.inputTokens, lastOutput: ev.outputTokens, lastCache: u.lastCache };
  }
  // 新模型窗口可能更小，第一份主请求 usage 允许把旧模型的历史峰值下调。
  u.contextPending = false;
  if (ablock) updateTurnCaption(ablock);
  if (sid === state.currentId) updateContextBar();
  saveLocal();
}
export function handleEvent(ev: AgentEvent, ablock: AssistantBlock, sid: string | null = state.currentId): void {
  const visible = sid === state.currentId;
  if (sid) {
    const u = state.usage[sid] || (state.usage[sid] = { lastInput: 0, lastOutput: 0, lastCache: 0 });
    u.lastActivityAt = Date.now();
    if (ev.type === "tool_call") {
      const seenTools = (u.seenToolIds ??= new Set<string>());
      if (!seenTools.has(ev.id)) {
        seenTools.add(ev.id);
        u.taskTools = (u.taskTools ?? 0) + 1;
      }
    }
    if (ev.type === "token" || ev.type === "tool_call" || ev.type === "tool_result") {
      // 仅用于让容量条也能跟随活动；真正任务耗时由服务端 SSE 结束后重新拉取。
      u.taskActiveMs = (u.taskActiveMs ?? 0);
    }
  }
  switch (ev.type) {
    case "token": sealStreamingParts(ablock, ["thinking"]); appendToken(ablock, ev.text, visible); break;
    case "reasoning": sealStreamingParts(ablock, ["text"]); appendReasoning(ablock, ev, visible); break;
    case "model_retry": upsertModelRetry(ablock, ev, visible); break;
    case "tool_call": upsertToolCall(ablock, ev, visible); break;
    case "tool_result": sealStreamingParts(ablock); fillToolResult(ablock, ev, sid, visible); break;
    case "node": addNodeChip(ablock, ev.name, visible); break;
    case "ai_message": {
      sealStreamingParts(ablock);
      const last = ablock.parts[ablock.parts.length - 1];
      const content = sanitizeEstateConclusionText(ablock, ev.content);
      if (!last || last.p !== "text" || last.text !== content) {
        const part: AssistantPart = { p: "text", text: content, streaming: false };
        ablock.parts.push(part);
        mountPart(ablock, part);
      }
      refreshConclusionMedia(ablock);
      break;
    }
    case "interrupt": addInterrupt(ablock, ev.payload, sid, visible); break;
    case "workflow_plan": setWorkflowPlan(ev.plan, sid); break;
    case "clarification_note": {
      // 无头模式：澄清没有挂起，只把「问了什么 + 假设了什么」留成一条引用块，
      // 否则下游看到的是一个凭空执行的任务，无从判断假设是否合理。
      sealStreamingParts(ablock);
      const text = ev.question
        ? `无头模式自动假设：${ev.assumption}（原问题：${ev.question}）`
        : `无头模式自动假设：${ev.assumption}`;
      const part: AssistantPart = { p: "text", text: `> ${text}`, streaming: false };
      ablock.parts.push(part);
      mountPart(ablock, part);
      break;
    }
    case "task_usage": {
      // 结束时以服务端权威快照封口，补上最后一个 usage 之后的活动时长；
      // 平均输出速度因此不会停在半路，也不会把同一条 usage 重复累加。
      const u = state.usage[sid || state.currentId || ""];
      if (u) {
        u.taskInput = ev.inputTokens;
        u.taskOutput = ev.outputTokens;
        u.taskTools = ev.toolCalls;
        u.taskModels = ev.modelCalls;
        u.taskActiveMs = ev.activeMs;
        if (sid === state.currentId) updateContextBar();
        saveLocal();
      }
      break;
    }
    case "route_decision": {
      // 路由卡：同一轮可能有多张（首次派发 + 一次转回），按序追加即可。
      sealStreamingParts(ablock);
      const part: AssistantPart = {
        p: "route",
        kind: ev.kind,
        layer: ev.layer,
        ...(ev.agentId ? { agentId: ev.agentId } : {}),
        ...(ev.agentName ? { agentName: ev.agentName } : {}),
        confidence: ev.confidence,
        margin: ev.margin,
        reason: ev.reason,
        candidates: ev.candidates,
        handoffCount: ev.handoffCount,
      };
      ablock.parts.push(part);
      mountPart(ablock, part);
      if (visible) scrollBottom();
      break;
    }
    // 自动放行只写安全审计，不额外占用聊天正文；保留 case 以维持协议穷尽检查。
    case "risk_decision": break;
    case "usage": applyUsage(ev, ablock, sid); break;
    case "shutdown": {
      // 服务端优雅退出的最后一帧：常驻顶部提示；刷新时若服务已恢复则自然消失
      let banner = document.getElementById("shutdown-banner");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "shutdown-banner";
        banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px 16px;" +
          "background:#8a5a00;color:#fff;text-align:center;font-size:13px";
        document.body.appendChild(banner);
      }
      banner.textContent = ev.message || "服务正在关闭，请稍后刷新页面重连";
      break;
    }
    case "error": addErrorBlock(ev.message, sid); break;
    case "done":
      sealStreamingParts(ablock);
      refreshConclusionMedia(ablock);
      break;
    default: {
      // 穷尽性校验：新增事件类型时这里编译失败（而不是运行时静默失联）
      const exhaustive: never = ev;
      console.warn("[stream] 未知事件", exhaustive);
    }
  }
  if (ev.type === "reasoning" || ev.type === "tool_call" || ev.type === "tool_result"
    || ev.type === "node" || ev.type === "interrupt" || ev.type === "route_decision") {
    // 后续仍有思考/工具时，上一版文本不是最终结论，先撤掉旧媒体。
    refreshConclusionMedia(ablock);
  }
}

/* ---------------------------------------------------------------------------
 * SSE 帧解析：data: {json}\n\n，一帧一事件
 * ------------------------------------------------------------------------- */
export async function consumeSSE(
  res: Response, onEvent: (ev: AgentEvent) => void
): Promise<void> {
  if (!res.body) throw new Error("响应没有可读流");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          try { onEvent(JSON.parse(line.slice(6)) as AgentEvent); } catch { /* 忽略坏帧 */ }
        }
      }
    }
  }
}
