/**
 * checkpoint-sanitize.ts — 缩小 Responses 元数据与图片的 checkpoint 体积
 * ============================================================
 * 职责：在图节点返回消息前做有损但安全的投影：保留 id/model/usage/status/
 * reasoning 摘要，移掉网关回显的完整 tools schema 与超大 output 列表。
 * 设计立场：只处理「持久化和下一轮模型请求都不需要」的冗余字段；不改正文、
 * 图片、tool_calls、tool_call_id 等协议必需字段，避免破坏 HITL 恢复与工具配对。
 */
import type { BaseMessage } from "@langchain/core/messages";

const KEEP_METADATA_KEYS = new Set([
  "model_provider", "id", "model_name", "model", "object", "created_at",
  "status", "finish_reason", "finishReason", "stop_reason", "stopReason",
  "usage", "tokenUsage", "reasoning", "stop_sequence",
  "cache_creation_input_tokens", "cache_read_input_tokens",
  "input_tokens", "output_tokens", "total_tokens",
]);

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (KEEP_METADATA_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** 返回可安全持久化的消息副本；无变化时返回原对象。 */
export function sanitizeCheckpointMessage<T extends BaseMessage>(message: T): T {
  const metadata = message.response_metadata as Record<string, unknown> | undefined;
  const additional = message.additional_kwargs as Record<string, unknown> | undefined;
  let changed = false;
  const responseMetadata = metadata ? sanitizeMetadata(metadata) : metadata;
  if (metadata && Object.keys(responseMetadata ?? {}).length !== Object.keys(metadata).length) changed = true;
  const additionalKwargs = additional
    ? Object.fromEntries(Object.entries(additional).filter(([key]) => !["tools", "instructions"].includes(key)))
    : additional;
  if (additional && Object.keys(additionalKwargs ?? {}).length !== Object.keys(additional).length) changed = true;
  if (!changed) return message;
  const copy = Object.create(Object.getPrototypeOf(message)) as T;
  Object.assign(copy, message, {
    response_metadata: responseMetadata,
    additional_kwargs: additionalKwargs,
  });
  return copy;
}


function sanitizeSerializedMessage(value: Record<string, unknown>): Record<string, unknown> {
  const kwargs = value.kwargs;
  if (!kwargs || typeof kwargs !== "object") return value;
  const source = kwargs as Record<string, unknown>;
  const metadata = source.response_metadata;
  const additional = source.additional_kwargs;
  return {
    ...value,
    kwargs: {
      ...source,
      ...(metadata && typeof metadata === "object"
        ? { response_metadata: sanitizeMetadata(metadata as Record<string, unknown>) }
        : {}),
      ...(additional && typeof additional === "object"
        ? {
            additional_kwargs: Object.fromEntries(
              Object.entries(additional as Record<string, unknown>)
                .filter(([key]) => !["tools", "instructions", "output"].includes(key)),
            ),
          }
        : {}),
    },
  };
}

/** compact 旧 NDJSON 时使用：对 serde JSON 中的消息做与运行时相同的 metadata 投影。 */
export function sanitizeSerializedCheckpoint<T>(value: T): T {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    const kind = Array.isArray(record.id) ? record.id.at(-1) : undefined;
    if (kind === "HumanMessage" || kind === "AIMessage" || kind === "AIMessageChunk" || kind === "ToolMessage") {
      return sanitizeSerializedMessage(record);
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) out[key] = walk(child);
    return out;
  };
  return walk(value) as T;
}
