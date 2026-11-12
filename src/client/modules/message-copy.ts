/**
 * modules/message-copy.ts — 从助手回合中提取可复制的最终总结
 * ============================================================
 * 一个助手回合包含思考、工具卡、审批卡和正文。复制总结只允许取最后一段
 * 已完成正文；若它后面还有工具/审批/澄清动作，说明该段不是最终交付，返回空。
 */
import type { AssistantBlock } from "./types.js";

const NON_FINAL_PARTS = new Set(["tool", "approval", "clarification"]);

export function assistantSummaryText(block: AssistantBlock): string {
  for (let index = block.parts.length - 1; index >= 0; index -= 1) {
    const part = block.parts[index];
    if (!part || part.p !== "text" || part.streaming) continue;
    const text = part.text.trim();
    if (!text) continue;
    const hasLaterAction = block.parts
      .slice(index + 1)
      .some((later) => NON_FINAL_PARTS.has(later.p));
    return hasLaterAction ? "" : text;
  }
  return "";
}
