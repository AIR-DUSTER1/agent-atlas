/**
 * routes/stats.ts — 使用统计：把 journal 已记录的 usage 聚合成可视图表
 * ============================================================
 * GET /api/stats 只读，不落任何状态。响应同时给出「近 7 天」与「近 30 天」：
 *   totals       区间内轮次 / 输入输出与缓存 token / 有记录会话 / 委派次数
 *   byDay        自然日补齐的每日桶（无数据也返回 0，图表时间轴不断裂）
 *   byModel      区间内按模型聚合的调用次数与 token
 *   topSessions  区间内最活跃的会话
 * 时间窗口按服务器本地自然日计算，包含今天；journal 回放后的 turnHistory 同样计入。
 */
import { listSessions, type Session, type TurnRecord } from "../sessions.js";

const RANGE_WINDOWS = [
  { id: "7d", label: "近 7 天", days: 7 },
  { id: "30d", label: "近 30 天", days: 30 },
] as const;
const TOP_SESSIONS = 8;     // 每个区间最多返回的活跃会话数
const DELEGATE_TOOL = "delegate_agent";
const UNKNOWN_MODEL = "未知模型";

type StatsRangeId = (typeof RANGE_WINDOWS)[number]["id"];

interface UsageLite {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  model?: string;
  callId?: string;
}

interface UsageCall {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model?: string;
}

export interface StatsTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  sessions: number;
  delegateCalls: number;
  /** 实际模型 API 调用次数；按 callId 或旧数据连续快照去重后计算。 */
  modelCalls: number;
}

export interface StatsDayBucket {
  date: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface StatsModelBucket {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface StatsRangeResult {
  id: StatsRangeId;
  label: string;
  days: number;
  startDate: string;
  endDate: string;
  totals: StatsTotals;
  byDay: StatsDayBucket[];
  byModel: StatsModelBucket[];
  topSessions: Array<{ sessionId: string; title: string; turns: number; tokens: number }>;
}

export interface StatsResult {
  generatedAt: number;
  ranges: StatsRangeResult[];
}

function isUsageEvent(ev: unknown): ev is UsageLite & { type: "usage" } {
  if (typeof ev !== "object" || ev === null) return false;
  const rec = ev as { type?: unknown; inputTokens?: unknown };
  return rec.type === "usage" && typeof rec.inputTokens === "number" && Number.isFinite(rec.inputTokens);
}

/**
 * 把一轮 events 还原成真实的模型调用列表。
 * 新事件用 stream.ts 的 callId 精确归并；旧 journal 没有 callId，
 * 但同一调用会把相同 usage 快照重复写入多片，因此按连续签名去重。
 */
function extractUsageCalls(events: unknown[]): UsageCall[] {
  const calls: UsageCall[] = [];
  const byCallId = new Map<string, UsageCall>();
  let lastLegacySignature: string | null = null;

  for (const ev of events) {
    if (!isUsageEvent(ev)) continue;
    const inputTokens = Math.max(0, ev.inputTokens);
    const outputTokens = typeof ev.outputTokens === "number" && Number.isFinite(ev.outputTokens)
      ? Math.max(0, ev.outputTokens)
      : 0;
    const cacheReadTokens = typeof ev.cacheReadTokens === "number" && Number.isFinite(ev.cacheReadTokens)
      ? Math.max(0, ev.cacheReadTokens)
      : 0;
    const callId = typeof ev.callId === "string" && ev.callId ? ev.callId : null;

    if (callId) {
      const existing = byCallId.get(callId);
      if (existing) {
        // 同一次调用可能有 input / output / cache 分片；最终快照取各字段最大值。
        existing.inputTokens = Math.max(existing.inputTokens, inputTokens);
        existing.outputTokens = Math.max(existing.outputTokens, outputTokens);
        existing.cacheReadTokens = Math.max(existing.cacheReadTokens, cacheReadTokens);
        if (!existing.model && ev.model) existing.model = ev.model;
      } else {
        const call = { inputTokens, outputTokens, cacheReadTokens, model: ev.model };
        byCallId.set(callId, call);
        calls.push(call);
      }
      continue;
    }

    const signature = `${ev.model || ""}|${inputTokens}|${outputTokens}|${cacheReadTokens}`;
    if (signature === lastLegacySignature) continue;
    lastLegacySignature = signature;
    calls.push({ inputTokens, outputTokens, cacheReadTokens, model: ev.model });
  }
  return calls;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addLocalDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyDay(date: string): StatsDayBucket {
  return { date, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

/** 单区间聚合；双区间共用同一批 turnHistory，保证口径完全一致。 */
function buildRange(
  sessions: Session[],
  generatedAt: number,
  definition: (typeof RANGE_WINDOWS)[number],
): StatsRangeResult {
  const today = startOfLocalDay(generatedAt);
  const startAt = addLocalDays(today, -(definition.days - 1));
  const endExclusiveAt = addLocalDays(today, 1);
  const dateKeys = Array.from({ length: definition.days }, (_, index) => dayKey(addLocalDays(startAt, index)));
  const dayMap = new Map(dateKeys.map((date) => [date, emptyDay(date)]));
  const modelMap = new Map<string, StatsModelBucket>();
  const sessionRows: StatsRangeResult["topSessions"] = [];
  const totals: StatsTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    sessions: 0,
    delegateCalls: 0,
    modelCalls: 0,
  };

  for (const session of sessions) {
    let sessionTurns = 0;
    let sessionTokens = 0;
    for (const record of session.turnHistory as TurnRecord[]) {
      if (!Number.isFinite(record.startedAt) || record.startedAt < startAt || record.startedAt >= endExclusiveAt) continue;
      const date = dayKey(record.startedAt);
      const day = dayMap.get(date);
      if (!day) continue;
      day.turns += 1;
      totals.turns += 1;
      sessionTurns += 1;

      for (const call of extractUsageCalls(record.events)) {
        const model = call.model || UNKNOWN_MODEL;
        day.inputTokens += call.inputTokens;
        day.outputTokens += call.outputTokens;
        day.cacheReadTokens += call.cacheReadTokens;
        totals.inputTokens += call.inputTokens;
        totals.outputTokens += call.outputTokens;
        totals.cacheReadTokens += call.cacheReadTokens;
        totals.modelCalls += 1;
        sessionTokens += call.inputTokens + call.outputTokens;
        const bucket = modelMap.get(model) ?? {
          model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
        };
        bucket.calls += 1;
        bucket.inputTokens += call.inputTokens;
        bucket.outputTokens += call.outputTokens;
        bucket.cacheReadTokens += call.cacheReadTokens;
        modelMap.set(model, bucket);
      }
      for (const ev of record.events) {
        if (
          typeof ev === "object" && ev !== null &&
          (ev as { type?: unknown }).type === "tool_call" &&
          (ev as { name?: unknown }).name === DELEGATE_TOOL
        ) {
          totals.delegateCalls += 1;
        }
      }
    }
    if (sessionTurns > 0) {
      totals.sessions += 1;
      sessionRows.push({
        sessionId: session.id,
        title: session.title || "未命名会话",
        turns: sessionTurns,
        tokens: sessionTokens,
      });
    }
  }

  const byModel = [...modelMap.values()].sort((a, b) =>
    (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.calls - a.calls
  );
  const topSessions = sessionRows
    .sort((a, b) => b.turns - a.turns || b.tokens - a.tokens)
    .slice(0, TOP_SESSIONS);

  return {
    id: definition.id,
    label: definition.label,
    days: definition.days,
    startDate: dateKeys[0],
    endDate: dateKeys[dateKeys.length - 1],
    totals,
    byDay: [...dayMap.values()],
    byModel,
    topSessions,
  };
}

/** 聚合纯函数（导出供单测固定 generatedAt，避免跨日波动）。 */
export function buildStats(sessions: Session[], generatedAt = Date.now()): StatsResult {
  return {
    generatedAt,
    ranges: RANGE_WINDOWS.map((definition) => buildRange(sessions, generatedAt, definition)),
  };
}

export async function handleStats(res: import("node:http").ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(buildStats(listSessions())));
}
