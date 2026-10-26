/**
 * stats.test.ts — 使用统计聚合（近 7 天 / 近 30 天）回归
 * ============================================================
 * 守：空数据补齐自然日；双窗口边界；多轮多模型累加；delegate 计数；
 * 按天/模型桶与 Top 会话排序。所有断言固定 generatedAt，避免跨日波动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStats, type StatsRangeResult } from "../../src/server/routes/stats.js";
import type { Session, TurnRecord } from "../../src/server/sessions.js";

/** 最小可聚合 Session（buildStats 只读 id/title/turnHistory） */
function fakeSession(id: string, title: string, records: TurnRecord[]): Session {
  return { id, title, turnHistory: records } as unknown as Session;
}

function turn(startedAt: number, events: unknown[]): TurnRecord {
  return {
    turnId: `t-${startedAt}-${Math.random().toString(36).slice(2, 6)}`,
    agentProfileId: "general",
    user: "问题",
    events: events as never,
    startedAt,
  };
}

const usage = (inputTokens: number, outputTokens: number, model?: string, cacheReadTokens = 0) =>
  ({ type: "usage", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens, ...(model ? { model } : {}) });

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const T0 = new Date(2026, 9, 24, 10, 0, 0).getTime();

function range(stats: ReturnType<typeof buildStats>, id: "7d" | "30d"): StatsRangeResult {
  const found = stats.ranges.find((item) => item.id === id);
  assert.ok(found, `缺少 ${id} 区间`);
  return found;
}

test("空数据返回近 7/30 天零值形状，并补齐每天桶", () => {
  const stats = buildStats([], NOW);
  assert.equal(stats.ranges.length, 2);
  for (const [id, days] of [["7d", 7], ["30d", 30]] as const) {
    const item = range(stats, id);
    assert.equal(item.days, days);
    assert.equal(item.byDay.length, days);
    assert.ok(item.byDay.every((day) => day.turns === 0 && day.inputTokens === 0 && day.outputTokens === 0));
    assert.equal(item.totals.turns, 0);
    assert.equal(item.totals.inputTokens, 0);
    assert.equal(item.totals.sessions, 0);
    assert.deepEqual(item.byModel, []);
    assert.deepEqual(item.topSessions, []);
  }
});

test("多轮多模型聚合：双窗口 totals/byDay/byModel 与逐轮 usage 累加一致", () => {
  const session = fakeSession("s1", "会话一", [
    turn(T0, [
      usage(100, 20, "模型A", 10),
      usage(50, 10, "模型A", 5), // 同轮第二条 usage（分析+回答两节点）也要计入
    ]),
    turn(T0 + 1000, [usage(200, 30, "模型B", 20)]),
    turn(T0 + DAY, [
      usage(10, 5), // 无 model 字段（旧数据）→ 未知模型
      { type: "tool_call", id: "tc1", name: "delegate_agent", argsFragment: "" },
    ]),
  ]);
  const stats = buildStats([session], NOW);

  for (const item of stats.ranges) {
    assert.equal(item.totals.turns, 3);
    assert.equal(item.totals.inputTokens, 360);
    assert.equal(item.totals.outputTokens, 65);
    assert.equal(item.totals.cacheReadTokens, 35);
    assert.equal(item.totals.sessions, 1);
    assert.equal(item.totals.delegateCalls, 1);
    assert.equal(item.topSessions[0]?.title, "会话一");
    assert.equal(item.topSessions[0]?.turns, 3);
  }

  const week = range(stats, "7d");
  const activeDays = week.byDay.filter((day) => day.turns > 0);
  assert.equal(activeDays.length, 2, "跨两天各一条");
  assert.equal(activeDays[0].turns, 2);
  assert.equal(activeDays[0].inputTokens, 350);
  assert.equal(activeDays[1].turns, 1);

  const modelA = week.byModel.find((m) => m.model === "模型A");
  assert.equal(modelA?.inputTokens, 150);
  assert.equal(modelA?.calls, 2, "同轮两条 usage 各计一次模型调用");
  assert.ok(week.byModel.some((m) => m.model === "未知模型"));
  // 排序：token 总量大者在前（模型B=230 > 模型A=180）
  assert.equal(week.byModel[0].model, "模型B");
});

test("近 7 天与近 30 天分别按自然日边界过滤", () => {
  const atNoonDaysAgo = (days: number) => new Date(2026, 9, 26 - days, 12, 0, 0).getTime();
  const sessions = [
    fakeSession("inside-7", "七天内", [turn(atNoonDaysAgo(6), [usage(7, 1, "m")])]),
    fakeSession("inside-30", "八天前", [turn(atNoonDaysAgo(8), [usage(8, 1, "m")])]),
    fakeSession("edge-30", "二十九天前", [turn(atNoonDaysAgo(29), [usage(29, 1, "m")])]),
    fakeSession("outside", "三十天前", [turn(atNoonDaysAgo(30), [usage(30, 1, "m")])]),
  ];
  const stats = buildStats(sessions, NOW);
  const week = range(stats, "7d");
  const month = range(stats, "30d");

  assert.equal(week.totals.turns, 1);
  assert.equal(week.totals.sessions, 1);
  assert.equal(week.totals.inputTokens, 7);
  assert.equal(month.totals.turns, 3);
  assert.equal(month.totals.sessions, 3);
  assert.equal(month.totals.inputTokens, 44);
  assert.ok(!month.topSessions.some((item) => item.sessionId === "outside"));
  assert.equal(month.byDay.at(-1)?.date, "2026-10-26");
  assert.equal(month.byDay[0]?.date, "2026-09-27");
});

test("Top 会话按区间轮次排序，无记录会话不入榜", () => {
  const busy = fakeSession("busy", "活跃", [turn(T0, [usage(1, 1, "m")]), turn(T0, [usage(1, 1, "m")])]);
  const quiet = fakeSession("quiet", "安静", [turn(T0, [usage(2, 2, "m")])]);
  const idle = fakeSession("idle", "只看没聊", []);
  const week = range(buildStats([idle, busy, quiet], NOW), "7d");
  assert.equal(week.totals.sessions, 2, "无轮次的会话不计入有记录会话数");
  assert.deepEqual(week.topSessions.map((item) => item.sessionId), ["busy", "quiet"]);
});
