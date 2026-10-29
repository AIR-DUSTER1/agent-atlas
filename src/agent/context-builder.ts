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
const DEFAULT_MAX_CONTEXT_CHARS = 48_000;
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
    maxContextChars: Math.max(8_000, profile.contextPolicy?.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS),
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

/**
 * 构建本轮模型可见消息。
 * - 不把 review/analysis 的 JSON 写入 messages；
 * - 最近消息窗口不会从 ToolMessage 中间切断工具调用；
 * - 只投影工具结果，不改 checkpoint 中的原消息；
 * - 当前轮截屏保留图片块；历史大图投影成文字占位，避免每轮重复吃 base64。
 */
export function buildAgentContext(input: AgentContextInput): AgentContextResult {
  const policy = resolveContextPolicy(input.profile);
  const total = input.messages.length;
  const windowStart = Math.max(0, total - policy.maxRecentMessages);
  let start = windowStart;
  // 字符预算兜底：消息数不等于 token 数，长工具结果仍可能把 32 条窗口推到几十 K。
  // 最新消息是当前请求，必须无条件保留；其余旧消息用剩余字符预算从新到旧装。
  // dataURL 不计文本预算：历史图片会在下面先投影成短占位，当前轮附件也不能
  // 因 base64 长度把用户刚发的消息整条裁掉。
  if (total > 0) {
    let usedChars = messageText(input.messages[total - 1]?.content).length;
    let boundedStart = total - 1;
    for (let index = total - 2; index >= windowStart; index -= 1) {
      usedChars += messageText(input.messages[index]?.content).length;
      if (usedChars > policy.maxContextChars) {
        boundedStart = index + 1;
        break;
      }
      boundedStart = index;
    }
    start = boundedStart;
  }
  // ToolMessage 必须和它对应的 AIMessage tool_call 一起送入模型；宁可多保留一条。
  while (start > 0 && input.messages[start]?.getType() === "tool") start -= 1;

  const omittedMessages = start;
  let truncatedToolResults = 0;
  // 只有最近一条用户消息之后的多模态内容属于「当前轮」；更早的大图必须投影成
  // 文本占位，否则每次继续都会把历史截图重新塞给模型。这里按消息身份判断，
  // 避免把用户当前轮刚附加的图片误删。
  let lastHumanIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.getType() === "human") { lastHumanIndex = index; break; }
  }
  const projected = input.messages.slice(start).map((message, offset) => {
    const absoluteIndex = start + offset;
    const inCurrentTurn = lastHumanIndex >= 0 && absoluteIndex >= lastHumanIndex;
    const imageProjection = inCurrentTurn ? { content: message.content, changed: false } : projectImageContent(message.content);
    const withImageProjection = imageProjection.changed
      ? Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content: imageProjection.content })
      : message;
    if (!(withImageProjection instanceof ToolMessage)) return withImageProjection;
    const next = cloneProjectedToolMessage(withImageProjection, policy.maxToolResultChars);
    if (next !== withImageProjection) truncatedToolResults += 1;
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
    input.taskLedger || "",
    input.budgetNote || "",
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
