/**
 * workflow/message-utils.ts — 图节点共享的消息读取与停止文案
 * ============================================================
 * 这里只做纯读取和文本收口，不调模型、不写状态，便于节点独立测试。
 */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolStopResult } from "../turn-stop.js";
import {
  MAX_TOOL_RESULT_TEXT,
  RECENT_MESSAGE_CHARS,
  RECENT_MESSAGE_COUNT,
  RECENT_TOOL_RESULT_COUNT,
} from "./limits.js";

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

export function lastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message instanceof HumanMessage) return contentText(message.content);
  }
  return "";
}

export function recentContext(messages: BaseMessage[]): string {
  return messages
    .slice(-RECENT_MESSAGE_COUNT)
    .map((message) => {
      const text = contentText(message.content).replace(/\s+/g, " ").trim();
      if (!text) return "";
      return `${message.getType()}: ${text.slice(0, RECENT_MESSAGE_CHARS)}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** 反思需要对照本轮工具结果，否则「与工具结果矛盾」这条判定无从谈起；只取最近几条并截断。 */
export function recentToolResults(messages: BaseMessage[]): string {
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] instanceof HumanMessage) {
      turnStart = i + 1;
      break;
    }
  }
  return messages
    .slice(turnStart)
    .filter((message) => message.getType() === "tool")
    .slice(-RECENT_TOOL_RESULT_COUNT)
    .map((message) => contentText(message.content).replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_RESULT_TEXT))
    .filter(Boolean)
    .join("\n");
}

/** 把工具的停止原因收口成用户可执行的一段话，避免停止分支静默结束。 */
export function stopNoticeText(stop: ToolStopResult): string {
  if (stop.authRequired) {
    const loginLine = stop.loginUrl ? `\n\n官方登录页：${stop.loginUrl}` : "";
    return "贝壳鉴权未通过，本轮已暂停，避免继续触发风控。" +
      loginLine +
      "\n\n请按以下步骤恢复：\n" +
      "1. 点击上方工具卡里的「打开官方登录页」，用贝壳找房 App 扫码；\n" +
      "2. 扫码成功后，点击页面 Key 右侧的「复制」；\n" +
      "3. 打开「设置 → 插件 → 找房数据源」，点「从剪贴板读取」并保存。\n\n" +
      "保存成功后回复「继续」，我会接着原任务执行。";
  }
  const reason = stop.error || "工具返回了需要人工处理的状态";
  return `本轮已暂停：${reason}。\n\n请按工具卡里的提示处理；完成后回复「继续」，我会接着执行。`;
}