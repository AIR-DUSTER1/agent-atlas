/**
 * modules/chat-flow.ts — 对话轮次连续性工具
 *
 * 审批 / 澄清恢复不是新一轮用户对话：它的事件必须并回当前助手块，
 * 否则实时流和历史回放都会生成额外头像、重复的用量与工具汇总。
 * 这里只处理纯数据结构，不依赖 DOM，供 main 与单测共用。
 */

import type { AssistantBlock, AssistantPart, ChatBlock } from "./types.js";

const LEGACY_CONTINUATION_PREFIXES = [/^（人工审批：/, /^（需求澄清：/];

interface TranscriptRecordLike {
  continuation?: boolean;
  user?: unknown;
}

/** 新 journal 用 continuation 标记；旧记录按历史文案兼容识别。 */
export function isContinuationRecord(record: TranscriptRecordLike | null | undefined): boolean {
  if (record?.continuation === true) return true;
  const user = typeof record?.user === "string" ? record.user : "";
  return LEGACY_CONTINUATION_PREFIXES.some((pattern) => pattern.test(user));
}

/** 找当前对话最后一个助手块，供审批恢复复用。 */
export function lastAssistantBlock(blocks: ChatBlock[] | null | undefined): AssistantBlock | null {
  if (!Array.isArray(blocks)) return null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.t === "assistant") return block;
  }
  return null;
}

/** 找到某个审批 / 澄清 part 所属的助手块。 */
export function assistantBlockContaining(
  blocks: ChatBlock[] | null | undefined,
  part: AssistantPart | null | undefined
): AssistantBlock | null {
  if (!Array.isArray(blocks) || !part) return null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.t === "assistant" && Array.isArray(block.parts) && block.parts.includes(part)) return block;
  }
  return null;
}

/**
 * 迁移旧本地缓存：连续 assistant 块只可能来自审批恢复的旧渲染 bug，
 * 合并 parts 并保留最后一次用量，刷新页面后即可恢复单头像。
 */
export function mergeAdjacentAssistantBlocks(blocks: ChatBlock[] | null | undefined): ChatBlock[] {
  if (!Array.isArray(blocks)) return [];
  const merged: ChatBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (block?.t === "assistant" && previous?.t === "assistant") {
      if (!Array.isArray(previous.parts)) previous.parts = [];
      previous.parts.push(...(Array.isArray(block.parts) ? block.parts : []));
      if (block._usage) previous._usage = block._usage;
      continue;
    }
    merged.push(block);
  }
  return merged;
}
