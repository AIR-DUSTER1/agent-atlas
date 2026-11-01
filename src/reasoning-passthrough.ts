/**
 * ============================================================
 * reasoning-passthrough.ts — 思考型网关的 reasoning_content 回传
 * ============================================================
 * 问题：DeepSeek 等思考型模型要求多轮请求把历史 assistant 的 reasoning_content
 * 原样带回，否则 400「The reasoning_content in the thinking mode must be
 * passed back to the API」。@langchain/openai 入站会把该字段存进
 * additional_kwargs，但出站序列化整段丢弃（fetch 拦截实测确认）。
 *
 * 设计立场：
 *  - 只在能精确匹配时补字段：先登记「网关确实给过我们」的思考文本，
 *    下次请求按 tool_call id（优先）或正文精确匹配再注入，从不编造。
 *  - 唯一的注入点是 HTTP 边界（llm.ts 的 fetch 封装）—— 只有那里能改到真正
 *    发出去的请求体；消息对象上挂 additional_kwargs 带不出去。
 *  - 内存记录有上限，且可被「网关反过来拒绝该字段」的兜底路径关闭。
 */
import type { BaseMessage } from "@langchain/core/messages";

/** 单会话最多保留多少条历史思考（覆盖长任务的多轮工具链） */
const MAX_RECORDS_PER_SESSION = 60;
/** 单条思考文本入内存的上限 */
const MAX_REASONING_CHARS = 16_000;
/** 匹配用的正文上限（正文再长也不影响匹配） */
const MAX_MATCH_CONTENT_CHARS = 8_000;
/** 会话记录数上限，防止会话 id 无限增长 */
const MAX_SESSIONS = 200;

interface ReasoningRecord {
  /** assistant 正文（tool_calls 轮常为空串） */
  content: string;
  /** 该轮 tool_call 的 id 集合；有 id 时优先按 id 匹配 */
  toolCallIds: string[];
  /** 供应商原生思考文本 */
  reasoning: string;
}

const records = new Map<string, ReasoningRecord[]>();
const disabled = new Set<string>();

function sessionKey(sessionId: string | undefined): string {
  return sessionId?.trim() ? sessionId : "default";
}

/** 该会话是否仍允许回传（命中「网关拒绝该字段」后会被关闭） */
export function reasoningPassthroughEnabled(sessionId: string | undefined): boolean {
  return !disabled.has(sessionKey(sessionId));
}

/**
 * 关闭某会话的思考回传。用于兜底：网关返回 400 且错误信息指明
 * reasoning_content 时，继续补字段只会一错再错，改为按原始请求重发。
 */
export function disableReasoningPassthrough(sessionId: string | undefined): void {
  const key = sessionKey(sessionId);
  disabled.add(key);
  records.delete(key);
}

/** 清空会话记录（删除会话 / 测试隔离用） */
export function clearReasoningRecords(sessionId: string | undefined): void {
  const key = sessionKey(sessionId);
  records.delete(key);
  disabled.delete(key);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: unknown; text?: unknown };
      // 思考块不算正文，否则拼出来的正文与入站消息对不上
      if (block.type === "thinking" || block.type === "reasoning" || block.type === "reasoning_content") return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

function reasoningOf(message: BaseMessage): string {
  const additional = message.additional_kwargs as { reasoning_content?: unknown; reasoning?: unknown } | undefined;
  const metadata = message.response_metadata as { reasoning_content?: unknown } | undefined;
  for (const value of [additional?.reasoning_content, additional?.reasoning, metadata?.reasoning_content]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function toolCallIdsOf(message: unknown): string[] {
  const calls = (message as { tool_calls?: Array<{ id?: unknown }> } | null)?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => (typeof call?.id === "string" ? call.id : "")).filter(Boolean);
}

function pushRecord(key: string, record: ReasoningRecord): void {
  if (!record.reasoning) return;
  if (!records.has(key) && records.size >= MAX_SESSIONS) {
    const oldest = records.keys().next().value;
    if (oldest) records.delete(oldest);
  }
  const list = records.get(key) ?? [];
  const same = (a: ReasoningRecord, b: ReasoningRecord): boolean =>
    a.content === b.content && a.toolCallIds.join(",") === b.toolCallIds.join(",");
  const duplicate = list.find((item) => same(item, record));
  if (duplicate) duplicate.reasoning = record.reasoning;
  else {
    list.push(record);
    if (list.length > MAX_RECORDS_PER_SESSION) list.splice(0, list.length - MAX_RECORDS_PER_SESSION);
  }
  records.set(key, list);
}

/**
 * 从一段消息历史里登记思考文本。每次模型调用前由消息装配层调用：
 * 这样服务重启后（内存记录清空）也能从 checkpoint 的 additional_kwargs
 * 重新建立回传能力，不需要把思考另存一份。
 */
export function rememberHistoryReasoning(sessionId: string | undefined, messages: BaseMessage[]): void {
  const key = sessionKey(sessionId);
  if (disabled.has(key)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const type = typeof message.getType === "function" ? message.getType() : "";
    if (type && type !== "ai") continue;
    const reasoning = reasoningOf(message);
    if (!reasoning) continue;
    pushRecord(key, {
      content: contentText(message.content).slice(0, MAX_MATCH_CONTENT_CHARS),
      toolCallIds: toolCallIdsOf(message),
      reasoning: reasoning.slice(0, MAX_REASONING_CHARS),
    });
  }
}

/** 找对应记录：tool_call id 命中优先，其次正文完全一致；取最近一条。 */function findRecord(list: ReasoningRecord[], key: { content: string; toolCallIds: string[] }): ReasoningRecord | undefined {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const record = list[index]!;
    if (key.toolCallIds.length && record.toolCallIds.length) {
      if (key.toolCallIds.some((id) => record.toolCallIds.includes(id))) return record;
      continue;
    }
    if (key.content && record.content === key.content) return record;
  }
  return undefined;
}

/**
 * 给 chat/completions 请求体补 reasoning_content。
 * 无记录 / 非 assistant 消息 / 已有该字段时一律不动；返回原字符串表示未变更。
 */
export function patchReasoningPayload(body: string, sessionId: string | undefined): string {
  const key = sessionKey(sessionId);
  if (disabled.has(key)) return body;
  const list = records.get(key);
  if (!list?.length) return body;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  const messages = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return body;
  let changed = false;
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    if (typeof message.reasoning_content === "string" && message.reasoning_content) continue;
    const record = findRecord(list, {
      content: contentText(message.content).slice(0, MAX_MATCH_CONTENT_CHARS),
      toolCallIds: toolCallIdsOf(message),
    });
    if (!record) continue;
    message.reasoning_content = record.reasoning;
    changed = true;
  }
  return changed ? JSON.stringify(payload) : body;
}
