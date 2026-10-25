/**
 * routes/stats.ts — 使用统计（F2）：把 journal 里已有但从未消费的 usage 变成报表
 * ============================================================
 * GET /api/stats —— 只读聚合，不落任何状态：
 *   totals     总轮次 / 输入输出与缓存 token / 会话数 / 委派次数
 *   byDay      近 30 天每天的轮次与 token（条形图数据源）
 *   byModel    按模型（usage 事件的 model 字段，旧数据归「未知模型」）
 *   topSessions 轮次最多的 8 个会话
 * 数据源是 sessions 的内存 turnHistory（journal 回放后同样在内存），
 * 与逐轮 usage 累加天然一致；空数据返回零值形状，前端不炸。
 */
import { listSessions, type Session, type TurnRecord } from "../sessions.js";

const BY_DAY_WINDOW = 30;   // 按天聚合的回看窗口（天）
const TOP_SESSIONS = 8;     // 轮次 Top 榜长度
const DELEGATE_TOOL = "delegate_agent";

interface UsageLite {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function isUsageEvent(ev: unknown): ev is UsageLite & { type: "usage"; model?: string } {
  if (typeof ev !== "object" || ev === null) return false;
  const rec = ev as { type?: unknown; inputTokens?: unknown };
  return rec.type === "usage" && typeof rec.inputTokens === "number";
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface StatsResult {
  totals: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    sessions: number;
    delegateCalls: number;
  };
  byDay: Array<{ date: string; turns: number; inputTokens: number; outputTokens: number }>;
  byModel: Array<{ model: string; turns: number; inputTokens: number; outputTokens: number }>;
  topSessions: Array<{ sessionId: string; title: string; turns: number; tokens: number }>;
}

/** 聚合纯函数（导出供单测直接构造 Session 断言） */
export function buildStats(sessions: Session[]): StatsResult {
  const totals = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, sessions: 0, delegateCalls: 0 };
  const dayMap = new Map<string, { turns: number; inputTokens: number; outputTokens: number }>();
  const modelMap = new Map<string, { turns: number; inputTokens: number; outputTokens: number }>();
  const sessionRows: Array<{ sessionId: string; title: string; turns: number; tokens: number }> = [];

  for (const session of sessions) {
    let sessionTurns = 0;
    let sessionTokens = 0;
    for (const record of session.turnHistory as TurnRecord[]) {
      totals.turns += 1;
      sessionTurns += 1;
      const day = dayMap.get(dayKey(record.startedAt)) ?? { turns: 0, inputTokens: 0, outputTokens: 0 };
      day.turns += 1;
      // 同一轮可能有多条 usage（多节点 / 分片），全部累加后按「净增量」进日/模型桶，
      // 避免同一轮的重复快照把「上下文大小」当成消耗重复计费展示
      let turnInput = 0;
      let turnOutput = 0;
      for (const ev of record.events) {
        if (isUsageEvent(ev)) {
          turnInput += ev.inputTokens;
          turnOutput += ev.outputTokens;
          totals.cacheReadTokens += ev.cacheReadTokens;
          const model = ev.model || "未知模型";
          const bucket = modelMap.get(model) ?? { turns: 0, inputTokens: 0, outputTokens: 0 };
          bucket.turns += 1;
          bucket.inputTokens += ev.inputTokens;
          bucket.outputTokens += ev.outputTokens;
          modelMap.set(model, bucket);
        } else if (
          typeof ev === "object" && ev !== null &&
          (ev as { type?: unknown }).type === "tool_call" &&
          (ev as { name?: unknown }).name === DELEGATE_TOOL
        ) {
          totals.delegateCalls += 1;
        }
      }
      totals.inputTokens += turnInput;
      totals.outputTokens += turnOutput;
      sessionTokens += turnInput + turnOutput;
      day.inputTokens += turnInput;
      day.outputTokens += turnOutput;
      dayMap.set(dayKey(record.startedAt), day);
    }
    if (sessionTurns > 0) {
      totals.sessions += 1;
      sessionRows.push({ sessionId: session.id, title: session.title, turns: sessionTurns, tokens: sessionTokens });
    }
  }

  const byDay = [...dayMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-BY_DAY_WINDOW);

  const byModel = [...modelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  const topSessions = sessionRows
    .sort((a, b) => b.turns - a.turns || b.tokens - a.tokens)
    .slice(0, TOP_SESSIONS);

  return { totals, byDay, byModel, topSessions };
}

export async function handleStats(res: import("node:http").ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(buildStats(listSessions())));
}
