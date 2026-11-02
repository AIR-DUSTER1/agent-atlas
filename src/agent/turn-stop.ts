/**
 * turn-stop.ts — 工具结果驱动的本轮终止契约
 * ============================================================
 * 某些工具一旦返回不可继续的系统状态（例如外部服务要求重新登录），继续回到模型
 * 只会重复调用同一能力。工具在 JSON 顶层返回 `stopAgent:true`，这里只检查当前
 * 最新 AI 工具调用的对应结果，避免历史标记误伤后续回合。
 */
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return part.text;
    }
    return "";
  }).join("");
}

function toolResultStopsTurn(content: BaseMessage["content"]): boolean {
  const text = messageText(content).trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return false;
  try {
    const payload = JSON.parse(text) as { stopAgent?: unknown };
    return payload.stopAgent === true;
  } catch {
    return false;
  }
}

/** 最新 AI 消息发起的任一工具返回 stopAgent:true 时结束本轮。 */
export function toolResultsStopTurn(messages: readonly BaseMessage[]): boolean {
  let lastAiIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.getType() === "ai") {
      lastAiIndex = index;
      break;
    }
  }
  if (lastAiIndex < 0) return false;

  const lastAi = messages[lastAiIndex] as AIMessage;
  const callIds = new Set((lastAi.tool_calls ?? []).map((call) => call.id).filter(Boolean));
  for (let index = lastAiIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.getType() !== "tool") continue;
    const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
    if (callIds.size > 0 && (typeof toolCallId !== "string" || !callIds.has(toolCallId))) continue;
    if (toolResultStopsTurn(message.content)) return true;
  }
  return false;
}
