/**
 * turn-record.ts — 轮次事件落 journal 前的规范化与体积控制
 * ============================================================
 * 实时 SSE 需要保留细粒度 token 与 usage 快照；历史 journal 不需要把同一份
 * 数据无限重复。这里只做确定性投影：不改 UI 回放语义，也不改 checkpoint。
 */
import type { AgentEvent, UsageEvent } from "./events.js";
export interface TurnStorageSummary {
  /** 归并前的原始事件数（usage 快照、token 分片均按原始条数计）。 */
  originalEvents: number;
  /** 最终进入 journal 的事件数。 */
  storedEvents: number;
  /** 因 MAX_RECORD_EVENTS 丢弃的前部事件数。 */
  droppedEvents: number;
  eventLimit: number;
  /** 相邻 token / reasoning 分片合并掉的条数。 */
  mergedTokenChunks: number;
  mergedReasoningChunks: number;
  /** 为控制 journal 体积而省略的 reasoning 字符数。 */
  reasoningCharsDropped: number;
  /** 同 callId / 连续旧快照归并掉的 usage 事件数。 */
  dedupedUsageEvents: number;
}

/** 单轮 journal 的硬上限：异常循环仍要留证据，不能撑爆磁盘。 */
export const MAX_RECORD_EVENTS = 3000;
/** 单轮 reasoning 落盘上限：思考流通常重复且只用于复盘，保留完整开头即可。 */
export const MAX_RECORD_REASONING_CHARS = 20_000;

export interface CanonicalTurnEvents {
  events: AgentEvent[];
  storage: TurnStorageSummary;
}

/**
 * usage 只保留每个 callId 的最终快照；旧 journal 无 callId 时，连续相同签名
 * 只留一条。internal 调用同样保留：它们不进上下文条，但确实是模型成本。
 */
function canonicalUsage(events: AgentEvent[]): { events: AgentEvent[]; deduped: number } {
  const out: AgentEvent[] = [];
  let deduped = 0;
  const byCallId = new Map<string, number>();
  let legacySignature = "";
  let legacyIndex = -1;
  for (const event of events) {
    if (event.type !== "usage") {
      out.push(event);
      continue;
    }
    const callId = event.callId?.trim();
    if (callId) {
      const previous = byCallId.get(callId);
      if (previous !== undefined) {
        out[previous] = event;
        deduped += 1;
      }
      else {
        byCallId.set(callId, out.length);
        out.push(event);
      }
      continue;
    }
    const signature = `${event.model ?? ""}|${event.inputTokens}|${event.outputTokens}|${event.cacheReadTokens}`;
    if (signature === legacySignature && legacyIndex >= 0 && legacyIndex === out.length - 1) {
      out[legacyIndex] = event;
      deduped += 1;
      continue;
    }
    legacySignature = signature;
    legacyIndex = out.length;
    out.push(event);
  }
  return { events: out, deduped };
}

/** 相邻 token / reasoning 分片合并，既保留正文回放，也显著减少行数。 */
function mergeTextChunks(events: AgentEvent[]): {
  events: AgentEvent[];
  mergedTokenChunks: number;
  mergedReasoningChunks: number;
} {
  const out: AgentEvent[] = [];
  let mergedTokenChunks = 0;
  let mergedReasoningChunks = 0;
  for (const event of events) {
    const last = out.at(-1);
    if (
      last && (last.type === "token" || last.type === "reasoning") &&
      (event.type === "token" || event.type === "reasoning") &&
      last.type === event.type && last.node === event.node
    ) {
      if (last.type === "token" && event.type === "token") {
        last.text += event.text;
        mergedTokenChunks += 1;
        continue;
      }
      if (last.type === "reasoning" && event.type === "reasoning") {
        last.text += event.text;
        mergedReasoningChunks += 1;
        continue;
      }
    }
    out.push(event.type === "token" || event.type === "reasoning" ? { ...event } : event);
  }
  return { events: out, mergedTokenChunks, mergedReasoningChunks };
}

/** reasoning 超预算时只截掉尾部，并在正文末尾留下可审计标记。 */
function capReasoning(events: AgentEvent[]): { events: AgentEvent[]; charsDropped: number } {
  let remaining = MAX_RECORD_REASONING_CHARS;
  let charsDropped = 0;
  const out = events.map((event) => {
    if (event.type !== "reasoning") return event;
    if (remaining <= 0) {
      charsDropped += event.text.length;
      return { ...event, text: "…（思考记录已达单轮上限，后续内容未落盘）" };
    }
    if (event.text.length <= remaining) {
      remaining -= event.text.length;
      return event;
    }
    const head = event.text.slice(0, remaining);
    charsDropped += event.text.length - remaining;
    remaining = 0;
    return { ...event, text: `${head}\n…（思考记录已达单轮上限，后续内容未落盘）` };
  });
  return { events: out, charsDropped };
}

export function canonicalizeTurnEvents(events: AgentEvent[]): CanonicalTurnEvents {
  const originalEvents = events.length;
  const usageDeduped = canonicalUsage(events);
  const merged = mergeTextChunks(usageDeduped.events);
  const capped = capReasoning(merged.events);
  const droppedEvents = Math.max(0, capped.events.length - MAX_RECORD_EVENTS);
  const retained = droppedEvents ? capped.events.slice(-MAX_RECORD_EVENTS) : capped.events;
  return {
    events: retained,
    storage: {
      originalEvents,
      storedEvents: retained.length,
      droppedEvents,
      eventLimit: MAX_RECORD_EVENTS,
      mergedTokenChunks: merged.mergedTokenChunks,
      mergedReasoningChunks: merged.mergedReasoningChunks,
      reasoningCharsDropped: capped.charsDropped,
      dedupedUsageEvents: usageDeduped.deduped,
    },
  };
}

/** 只有真正发生归并/裁剪时才保留 storage 元数据，普通轮次不额外占体积。 */
export function describeTurnStorage(storage: TurnStorageSummary): TurnStorageSummary | undefined {
  return storage.droppedEvents > 0 || storage.mergedTokenChunks > 0 ||
    storage.mergedReasoningChunks > 0 || storage.reasoningCharsDropped > 0 ||
    storage.dedupedUsageEvents > 0
    ? storage
    : undefined;
}
