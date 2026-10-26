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
import { mountBlock, updateTurnCaption } from "../render/messages.js";
import {
  appendReasoning, mountPart, scheduleTextRender, setPendingApproval,
  updateToolCard,
} from "../render/parts.js";
import { TOOL_ICONS } from "../modules/format.js";
import type {
  AgentEvent, AssistantBlock, AssistantPart, InterruptPayload,
  TextPart, ToolPart,
} from "../modules/types.js";

/* ---------------------------------------------------------------------------
 * 增量事件处理
 * ------------------------------------------------------------------------- */
export function appendToken(ablock: AssistantBlock, text: string): void {
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
  scrollBottom();
}

export function upsertToolCall(
  ablock: AssistantBlock, ev: { id: string; name?: string; argsFragment?: string }
): void {
  let part = [...ablock.parts].reverse().find(
    (p): p is ToolPart => p.p === "tool" && p.id === ev.id
  );
  if (!part) {
    const created: ToolPart = { p: "tool", id: ev.id, name: ev.name || "", argsText: "", result: null };
    ablock.parts.push(created);
    mountPart(ablock, created);
    return;
  }
  // 名字可能晚于首个分片到达：补进卡片头部（图标也一起换）
  if (ev.name && !part.name) {
    part.name = ev.name;
    const refs = partEls.get(part);
    if (refs) {
      const nameEl = refs.el.querySelector(".tool-name");
      if (nameEl) nameEl.textContent = ev.name;
      const iconEl = refs.el.querySelector(".tool-icon");
      if (iconEl) iconEl.textContent = TOOL_ICONS[ev.name] || "🔧";
    }
  }
  part.argsText += ev.argsFragment || "";
  updateToolCard(part);
  scrollBottom();
}

export function fillToolResult(
  ablock: AssistantBlock, ev: { id: string; content: string; isError?: boolean }
): void {
  const sid = state.currentId;
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
  scrollBottom();
}

export function addNodeChip(ablock: AssistantBlock, name: string): void {
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
  scrollBottom();
}

export function addInterrupt(ablock: AssistantBlock, payload: InterruptPayload): void {
  if (payload.type === "clarification") {
    const part: AssistantPart = { p: "clarification", req: payload, status: "pending" };
    ablock.parts.push(part);
    mountPart(ablock, part);
  } else {
    const part: AssistantPart = { p: "approval", req: payload, status: "pending" };
    ablock.parts.push(part);
    mountPart(ablock, part);
  }
  setPendingApproval(true);
  scrollBottom(true);
}

export function addErrorBlock(message: string): void {
  const block = { t: "error" as const, text: message };
  transcript(state.currentId).push(block);
  mountBlock(block);
  scrollBottom(true);
}

/* ---------------------------------------------------------------------------
 * 主分派
 * ------------------------------------------------------------------------- */
export function handleEvent(ev: AgentEvent, ablock: AssistantBlock): void {
  switch (ev.type) {
    case "token": appendToken(ablock, ev.text); break;
    case "reasoning": appendReasoning(ablock, ev); break;
    case "tool_call": upsertToolCall(ablock, ev); break;
    case "tool_result": fillToolResult(ablock, ev); break;
    case "node": addNodeChip(ablock, ev.name); break;
    case "ai_message": {
      const last = ablock.parts[ablock.parts.length - 1];
      if (!last || last.p !== "text" || last.text !== ev.content) {
        const part: AssistantPart = { p: "text", text: ev.content, streaming: true };
        ablock.parts.push(part);
        mountPart(ablock, part);
      }
      break;
    }
    case "interrupt": addInterrupt(ablock, ev.payload); break;
    case "usage": {
      // 上下文容量 ≈ 最近一次模型调用的 输入 + 输出；缓存占比 = cache_read / 输入
      const sid = state.currentId;
      if (!sid) break;
      const u = state.usage[sid] || (state.usage[sid] = { lastInput: 0, lastOutput: 0, lastCache: 0 });
      u.lastInput = ev.inputTokens;
      u.lastOutput = ev.outputTokens;
      u.lastCache = ev.cacheReadTokens || 0;
      u.contextTokens = ev.inputTokens + ev.outputTokens;
      ablock._usage = { lastInput: ev.inputTokens, lastOutput: ev.outputTokens, lastCache: u.lastCache };
      updateTurnCaption(ablock);
      updateContextBar();
      saveLocal();
      break;
    }
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
    case "error": addErrorBlock(ev.message); break;
    case "done": break;
    default: {
      // 穷尽性校验：新增事件类型时这里编译失败（而不是运行时静默失联）
      const exhaustive: never = ev;
      console.warn("[stream] 未知事件", exhaustive);
    }
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
