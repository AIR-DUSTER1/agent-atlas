/**
 * turn-stop.ts — 工具结果驱动的本轮终止契约
 * ============================================================
 * 某些工具一旦返回不可继续的系统状态（例如外部服务要求重新登录），继续回到模型
 * 只会重复调用同一能力。工具在 JSON 顶层返回 `stopAgent:true`，这里只检查当前
 * 最新 AI 工具调用的对应结果，避免历史标记误伤后续回合。
 */
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

/** 工具声明的本轮停止原因；只保留可安全展示给用户的字段。 */
export interface ToolStopResult {
  stopAgent: true;
  error?: string;
  authRequired?: boolean;
  loginUrl?: string;
  action?: string;
}

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

function parseToolStopResult(content: BaseMessage["content"]): ToolStopResult | null {
  const text = messageText(content).trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload.stopAgent !== true) return null;
    return {
      stopAgent: true,
      ...(typeof payload.error === "string" && payload.error.trim() ? { error: payload.error.trim() } : {}),
      ...(payload.authRequired === true ? { authRequired: true } : {}),
      ...(typeof payload.loginUrl === "string" && payload.loginUrl.trim() ? { loginUrl: payload.loginUrl.trim() } : {}),
      ...(typeof payload.action === "string" && payload.action.trim() ? { action: payload.action.trim() } : {}),
    };
  } catch {
    return null;
  }
}

/** 最新 AI 消息发起的任一工具返回 stopAgent:true 时，返回首个停止原因。 */
export function latestToolStopResult(messages: readonly BaseMessage[]): ToolStopResult | null {
  let lastAiIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.getType() === "ai") {
      lastAiIndex = index;
      break;
    }
  }
  if (lastAiIndex < 0) return null;

  const lastAi = messages[lastAiIndex] as AIMessage;
  const callIds = new Set((lastAi.tool_calls ?? []).map((call) => call.id).filter(Boolean));
  for (let index = lastAiIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.getType() !== "tool") continue;
    const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
    if (callIds.size > 0 && (typeof toolCallId !== "string" || !callIds.has(toolCallId))) continue;
    const stop = parseToolStopResult(message.content);
    if (stop) return stop;
  }
  return null;
}

/** 最新 AI 消息发起的任一工具返回 stopAgent:true 时结束本轮。 */
export function toolResultsStopTurn(messages: readonly BaseMessage[]): boolean {
  return latestToolStopResult(messages) !== null;
}
