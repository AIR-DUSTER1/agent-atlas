/**
 * ============================================================
 * context-builder.ts — Agent prompt 与消息上下文投影
 * ============================================================
 * 纯函数：把 profile 固定提示、需求 brief、澄清/反思注记和消息历史组装成
 * 本轮模型输入。工具结果只在这里按 profile 预算裁剪，原始 checkpoint /
 * transcript 不改写，避免历史回放与 UI 结果被截断。
 */
import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentContextPolicy, AgentProfile } from "./profile.js";
import { createContextWindowBudget, estimateTextTokens, type ContextWindowBudget } from "../context-window.js";

const MAX_CONTEXT_MESSAGES = 10_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;
const TRUNCATION_MARKER_MIN = 40;
/** 回炉草稿并入注记的字符上限（草稿过长时截头部，反思反馈会指明要改哪里） */
const MAX_REVISION_DRAFT_CHARS = 4_000;

export interface AgentContextInput {
  profile: AgentProfile;
  messages: BaseMessage[];
  requirementBrief?: string;
  clarificationHistory?: string;
  reviewFeedback?: string;
  /** 会话权限模式注记（permission.ts 生成；approve 默认行为时为空串不注入） */
  permissionNote?: string;
  /** 跨会话长期记忆注记（memory-store 生成；无记忆时为空不注入） */
  memoryNote?: string;
  /** 技能注记（skills.ts 按用户消息关键词命中生成；未命中为 undefined，零开销） */
  skillNote?: string;
  /** 跨审批/澄清仍保留的任务台账（server/task-budget.ts 生成） */
  taskLedger?: string;
  /** 本任务预算使用情况（供模型主动收口，不等待硬超时） */
  budgetNote?: string;
  /** 当前模型总窗口；未提供时用安全默认 200k。 */
  contextWindow?: number | null;
}

export interface AgentContextResult {
  messages: BaseMessage[];
  omittedMessages: number;
  truncatedToolResults: number;
  budget: ContextWindowBudget;
  estimatedInputTokens: number;
}

export function resolveContextPolicy(profile: AgentProfile): AgentContextPolicy {
  return {
    maxRecentMessages: Math.max(2, profile.contextPolicy?.maxRecentMessages ?? MAX_CONTEXT_MESSAGES),
    maxToolResultChars: Math.max(256, profile.contextPolicy?.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS),
    maxContextChars: Math.max(8_000, profile.contextPolicy?.maxContextChars ?? 4_000_000),
  };
}

function toolContentText(message: ToolMessage): string {
  if (typeof message.content === "string") return message.content;
  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

/** terminal 错误通常在尾部；其它工具（搜索、JSON）优先保留头部。 */
function truncateToolText(text: string, maxChars: number, toolName: string): string {
  if (text.length <= maxChars) return text;
  const marker = `\n…（工具结果过长已截断，原始 ${text.length} 字符）`;
  const budget = Math.max(0, maxChars - marker.length);
  if (toolName === "terminal") {
    return `${marker}\n${text.slice(-budget)}`;
  }
  return `${text.slice(0, budget)}${marker}`;
}

function cloneProjectedToolMessage(message: ToolMessage, maxChars: number): ToolMessage {
  const text = truncateToolText(toolContentText(message), maxChars, message.name ?? "");
  if (text === message.content) return message;
  return new ToolMessage({
    id: message.id,
    content: text,
    tool_call_id: message.tool_call_id,
    name: message.name,
    status: message.status,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

const MAX_PROJECTED_IMAGE_URL_CHARS = 2_000;

/** 多模态图片块只在当前轮有价值；历史截图转成文字占位，避免每轮重新吃几十万字符。 */
function projectImageContent(content: BaseMessage["content"]): { content: BaseMessage["content"]; changed: boolean } {
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const projected = content.map((part) => {
    if (!part || typeof part !== "object" || !("type" in part)) return part;
    const block = part as { type?: unknown; image_url?: { url?: unknown } };
    if (block.type !== "image_url" || typeof block.image_url?.url !== "string") return part;
    if (block.image_url.url.length <= MAX_PROJECTED_IMAGE_URL_CHARS) return part;
    changed = true;
    return { type: "text", text: "【历史图片已省略；如需查看请重新附加】" } as BaseMessage["content"][number];
  });
  return { content: projected as BaseMessage["content"], changed };
}

/** 消息 content（string 或内容块数组）拍平成纯文本 */
function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text ?? "") : ""))
    .join("");
}

/** 被窗口省略的旧消息不是直接消失：按剩余预算压成可用事实摘要，减少“失忆”。 */
function buildOmittedHistoryDigest(messages: BaseMessage[], maxTokens: number): string {
  if (!messages.length || maxTokens <= 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const type = message.getType();
    if (type !== "human" && type !== "ai") continue;
    const text = messageText(message.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const label = type === "human" ? "用户" : "助手";
    const candidate = `- ${label}：${text.slice(0, 240)}`;
    const tokens = estimateTextTokens(candidate);
    if (used + tokens > maxTokens) break;
    lines.push(candidate);
    used += tokens;
  }
  if (!lines.length) return "";
  lines.reverse();
  return `【较早对话摘要】\n${lines.join("\n")}`;
}

/** 估算单条消息的 token；工具调用参数也计入，避免大参数漏预算。 */
function estimateMessageTokens(message: BaseMessage): number {
  if (typeof message.content === "string") return estimateTextTokens(message.content);
  if (!Array.isArray(message.content)) return 0;
  let tokens = 0;
  for (const part of message.content) {
    if (typeof part === "string") {
      tokens += estimateTextTokens(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if ("text" in part) tokens += estimateTextTokens(String((part as { text?: unknown }).text ?? ""));
    // 图片不按 base64 字符计费；按供应商普遍使用的单图上限做保守估值。
    else if ((part as { type?: unknown }).type === "image_url") tokens += 1_024;
  }
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(calls) && calls.length) {
    try { tokens += estimateTextTokens(JSON.stringify(calls)); } catch { /* 循环引用时忽略参数估算 */ }
  }
  return tokens;
}

/**
 * 构建本轮模型可见消息。
 * - 预算来自当前模型窗口，不再用固定字符数/固定消息数把上下文卡死；
 * - 最新用户消息必须保留；更早历史从新到旧装入剩余输入预算；
 * - ToolMessage 必须和对应 AIMessage tool_call 成对保留；
 * - 工具结果只投影，不改 checkpoint 原消息；历史大图转文字占位。
 */
export function buildAgentContext(input: AgentContextInput): AgentContextResult {
  const policy = resolveContextPolicy(input.profile);
  const budget = createContextWindowBudget(input.contextWindow);
  let lastHumanIndex = -1;
  for (let cursor = input.messages.length - 1; cursor >= 0; cursor -= 1) {
    if (input.messages[cursor]?.getType() === "human") { lastHumanIndex = cursor; break; }
  }
  const projectedAll = input.messages.map((message, index) => {
    const inCurrentTurn = lastHumanIndex >= 0 && index >= lastHumanIndex;
    const imageProjection = inCurrentTurn ? { content: message.content, changed: false } : projectImageContent(message.content);
    const withImageProjection = imageProjection.changed
      ? Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content: imageProjection.content })
      : message;
    if (!(withImageProjection instanceof ToolMessage)) return withImageProjection;
    return cloneProjectedToolMessage(withImageProjection, policy.maxToolResultChars);
  });

  // 回炉投影：review 不通过时消息末尾是本轮草稿（可能连续多版）。
  // 思考型网关要求末条 assistant 自带 reasoning_content，而序列化会丢弃它；
  // 因此把草稿移出消息列表、并入 system 注记，让请求以 HumanMessage 结尾。
  let revisionNote = "";
  if (input.reviewFeedback) {
    while (projectedAll.length && projectedAll[projectedAll.length - 1]?.getType() === "ai") {
      const draftMsg = projectedAll.pop();
      if (!draftMsg) continue;
      const draft = messageText(draftMsg.content).trim();
      if (draft && !revisionNote) {
        revisionNote = `【上一轮草稿（按下面的反思反馈修订后重新回答）】\n${draft.slice(0, MAX_REVISION_DRAFT_CHARS)}`;
      }
    }
  }

  const fixedNotes = [
    input.requirementBrief ? `【需求理解】${input.requirementBrief}` : "",
    input.clarificationHistory
      ? (input.requirementBrief?.includes(input.clarificationHistory)
        ? ""
        : `【历史澄清（仅在相关时参考）】${input.clarificationHistory}`)
      : "",
    revisionNote,
    input.reviewFeedback ? `【上一轮反思反馈】${input.reviewFeedback}` : "",
    input.permissionNote || "",
    input.memoryNote || "",
    input.skillNote || "",
    input.taskLedger || "",
    input.budgetNote || "",
  ].filter(Boolean);
  const omittedNoteReserveTokens = 64;
  const fixedTokens = estimateTextTokens(input.profile.systemPrompt)
    + estimateTextTokens(fixedNotes.join("\n\n"))
    + omittedNoteReserveTokens;
  const historyBudget = Math.max(0, budget.inputBudgetTokens - fixedTokens);

  const total = projectedAll.length;
  const scanFloor = Math.max(0, total - Math.max(2, policy.maxRecentMessages));
  let start = total;
  let estimatedHistoryTokens = 0;
  for (let index = total - 1; index >= scanFloor; index -= 1) {
    const messageTokens = estimateMessageTokens(projectedAll[index]!);
    // 当前最新消息即使本身超预算也必须保留；其余消息装不下就停。
    if (index < total - 1 && estimatedHistoryTokens + messageTokens > historyBudget) break;
    estimatedHistoryTokens += messageTokens;
    start = index;
  }
  // ToolMessage 不能单独出现；向前补齐对应的 tool_call 消息，宁可略超预算。
  while (start > 0 && start < total && projectedAll[start]?.getType() === "tool") start -= 1;

  const omittedMessages = start;
  const omittedTokens = projectedAll.slice(0, start).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const digestBudget = omittedMessages
    ? Math.min(1_600, Math.max(0, historyBudget - estimatedHistoryTokens))
    : 0;
  const historyDigest = buildOmittedHistoryDigest(projectedAll.slice(0, start), digestBudget);
  const digestTokens = estimateTextTokens(historyDigest);
  // 摘要也占请求预算：优先从更早历史回退同样大小的空间；最近一段工具调用链
  // 必须保持完整，不能为了腾摘要空间把 tool_calls 与 ToolMessage 拆开。
  let trimTokens = digestTokens;
  while (trimTokens > 0 && start < total - 1) {
    const headTokens = estimateMessageTokens(projectedAll[start]!);
    if (headTokens > trimTokens) break;
    const next = projectedAll[start + 1];
    if (next?.getType() === "tool") break;
    trimTokens -= headTokens;
    start += 1;
  }
  const notes = [
    ...fixedNotes,
    historyDigest,
    start > 0 ? `【上下文窗口】已省略较早的 ${start} 条消息（约 ${omittedTokens} tokens），完整历史仍保存在会话记录中。` : "",
  ].filter(Boolean);
  const messages: BaseMessage[] = [
    new SystemMessage(input.profile.systemPrompt),
    ...(notes.length ? [new SystemMessage(notes.join("\n\n"))] : []),
    ...projectedAll.slice(start),
  ];
  const truncatedToolResults = projectedAll
    .slice(start)
    .filter((message, index) => message instanceof ToolMessage && message !== input.messages[start + index])
    .length;
  const estimatedInputTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

  return {
    messages,
    omittedMessages,
    truncatedToolResults,
    budget,
    estimatedInputTokens,
  };
}
