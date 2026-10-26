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

const DEFAULT_MAX_RECENT_MESSAGES = 32;
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
}

export interface AgentContextResult {
  messages: BaseMessage[];
  omittedMessages: number;
  truncatedToolResults: number;
}

export function resolveContextPolicy(profile: AgentProfile): AgentContextPolicy {
  return {
    maxRecentMessages: Math.max(2, profile.contextPolicy?.maxRecentMessages ?? DEFAULT_MAX_RECENT_MESSAGES),
    maxToolResultChars: Math.max(256, profile.contextPolicy?.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS),
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

/** 图片内容块判定：多模态工具结果（computer_screenshot）整体保留，不做字符截断 */
function hasImageContent(content: BaseMessage["content"]): boolean {
  return Array.isArray(content) && content.some(
    (part) => typeof part === "object" && part !== null && "type" in part && (part as { type: unknown }).type === "image_url"
  );
}

/** 消息 content（string 或内容块数组）拍平成纯文本 */
function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text ?? "") : ""))
    .join("");
}

/**
 * 构建本轮模型可见消息。
 * - 不把 review/analysis 的 JSON 写入 messages；
 * - 最近消息窗口不会从 ToolMessage 中间切断工具调用；
 * - 只投影工具结果，不改 checkpoint 中的原消息；
 * - 截屏等多模态工具结果保留图片块（截断 base64 等于毁掉整张图）。
 */
export function buildAgentContext(input: AgentContextInput): AgentContextResult {
  const policy = resolveContextPolicy(input.profile);
  const total = input.messages.length;
  let start = Math.max(0, total - policy.maxRecentMessages);
  // ToolMessage 必须和它对应的 AIMessage tool_call 一起送入模型；宁可多保留一条。
  while (start > 0 && input.messages[start]?.getType() === "tool") start -= 1;

  const omittedMessages = start;
  let truncatedToolResults = 0;
  const projected = input.messages.slice(start).map((message) => {
    if (!(message instanceof ToolMessage)) return message;
    if (hasImageContent(message.content)) return message;
    const next = cloneProjectedToolMessage(message, policy.maxToolResultChars);
    if (next !== message) truncatedToolResults += 1;
    return next;
  });

  // 回炉投影：review 不通过时消息末尾是本轮草稿（可能连续多版：二次回炉后是
  // v1、v2 两条 AIMessage 排在末尾）。思考型网关（DeepSeek thinking 等）硬校验
  // 「请求末条 assistant 必带 reasoning_content」，而 @langchain/openai 序列化会
  // 把它丢弃 → 400（与 multi.ts 的坑同源）。把草稿全部移出消息列表、最新一版
  // 并入 system 注记，请求以 HumanMessage 结尾，模型仍有完整草稿可修订。
  let revisionNote = "";
  while (input.reviewFeedback && projected.length && projected[projected.length - 1]?.getType() === "ai") {
    const draftMsg = projected.pop();
    if (draftMsg) {
      const draft = messageText(draftMsg.content).trim();
      if (draft && !revisionNote) {
        revisionNote = `【上一轮草稿（按下面的反思反馈修订后重新回答）】\n${draft.slice(0, MAX_REVISION_DRAFT_CHARS)}`;
      }
    }
  }

  const notes = [
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
    omittedMessages ? `【上下文窗口】已省略较早的 ${omittedMessages} 条消息，完整历史仍保存在会话记录中。` : "",
  ].filter(Boolean);

  return {
    messages: [
      new SystemMessage(input.profile.systemPrompt),
      ...(notes.length ? [new SystemMessage(notes.join("\n\n"))] : []),
      ...projected,
    ],
    omittedMessages,
    truncatedToolResults,
  };
}
