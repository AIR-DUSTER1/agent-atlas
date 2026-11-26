/**
 * modules/chat-flow.ts — 对话轮次连续性工具
 *
 * 审批 / 澄清恢复不是新一轮用户对话：它的事件必须并回当前助手块，
 * 否则实时流和历史回放都会生成额外头像、重复的用量与工具汇总。
 * 这里只处理纯数据结构，不依赖 DOM，供 main 与单测共用。
 */

import type { AssistantBlock, AssistantPart, ChatBlock, ToolPart } from "./types.js";

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

/** 澄清节点已经有专用卡片，不再用静态节点徽章重复表达。 */
export function isClarifyNodeName(name: string): boolean {
  return name.split(/[/:]/).filter(Boolean).includes("clarify");
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

/** 旧缓存迁移：审批 part 必须排在对应工具卡之前，避免“先完成、后审批”的视觉顺序。 */
export function normalizeApprovalOrder(block: AssistantBlock): boolean {
  if (!Array.isArray(block.parts)) return false;
  const approvals = block.parts.filter((part): part is Extract<AssistantPart, { p: "approval" }> => part.p === "approval");
  const tools = block.parts.filter((part): part is ToolPart => part.p === "tool");
  const usedTools = new Set<ToolPart>();
  let changed = false;
  for (const approval of approvals) {
    if (approval.status === "pending" && approval.collapsed === true) {
      approval.collapsed = false;
      changed = true;
    }
    const matching = tools.filter((candidate) => !usedTools.has(candidate) && candidate.name === approval.req.toolName);
    const approvalIndex = block.parts.indexOf(approval);
    const byDistance = [...matching].sort((left, right) =>
      Math.abs(block.parts.indexOf(left) - approvalIndex) - Math.abs(block.parts.indexOf(right) - approvalIndex));
    // 同一工具名可能重复出现（例如连续 terminal）。审批优先绑定等待审批的卡片，
    // 其次绑定尚未产生结果的卡片，最后才用最近的已完成卡兼容旧缓存。
    const tool = matching.find((candidate) => candidate.awaitingApproval)
      ?? matching.find((candidate) => !candidate.result)
      ?? byDistance[0];
    if (!tool) continue;
    usedTools.add(tool);
    const toolIndex = block.parts.indexOf(tool);
    if (toolIndex !== approvalIndex + 1) {
      block.parts.splice(approvalIndex, 1);
      block.parts.splice(block.parts.indexOf(tool), 0, approval);
      changed = true;
    }
  }
  return changed;
}
