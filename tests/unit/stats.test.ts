/**
 * stats.test.ts — 使用统计聚合（F2）回归
 * 守：空数据零值形状；多轮多模型累加与 journal 逐轮 usage 一致；
 * delegate 计数；按天/模型桶与 Top 会话排序。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStats } from "../../src/server/routes/stats.js";
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

const usage = (inputTokens: number, outputTokens: number, model?: string) =>
  ({ type: "usage", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 0, ...(model ? { model } : {}) });

const DAY = 86_400_000;
const T0 = new Date("2026-10-24T10:00:00").getTime();

test("空数据返回零值形状，不炸", () => {
  const stats = buildStats([]);
  assert.equal(stats.totals.turns, 0);
  assert.equal(stats.totals.inputTokens, 0);
  assert.equal(stats.totals.sessions, 0);
  assert.deepEqual(stats.byDay, []);
  assert.deepEqual(stats.byModel, []);
  assert.deepEqual(stats.topSessions, []);
});

test("多轮多模型聚合：totals/byDay/byModel 与逐轮 usage 累加一致", () => {
  const session = fakeSession("s1", "会话一", [
    turn(T0, [
      usage(100, 20, "模型A"),
      usage(50, 10, "模型A"), // 同轮第二条 usage（分析+回答两节点）也要计入
    ]),
    turn(T0 + 1000, [usage(200, 30, "模型B")]),
    turn(T0 + DAY, [
      usage(10, 5), // 无 model 字段（旧数据）→ 未知模型
      { type: "tool_call", id: "tc1", name: "delegate_agent", argsFragment: "" },
    ]),
  ]);
  const stats = buildStats([session]);

  assert.equal(stats.totals.turns, 3);
  assert.equal(stats.totals.inputTokens, 360);
  assert.equal(stats.totals.outputTokens, 65);
  assert.equal(stats.totals.sessions, 1);
  assert.equal(stats.totals.delegateCalls, 1);

  assert.equal(stats.byDay.length, 2, "跨两天各一条");
  assert.equal(stats.byDay[0].turns, 2);
  assert.equal(stats.byDay[0].inputTokens, 350);
  assert.equal(stats.byDay[1].turns, 1);

  const modelA = stats.byModel.find((m) => m.model === "模型A");
  assert.equal(modelA?.inputTokens, 150);
  assert.equal(modelA?.turns, 2, "同轮两条 usage 各计一次模型调用");
  assert.ok(stats.byModel.some((m) => m.model === "未知模型"));
  // 排序：token 总量大者在前（模型B=230 > 模型A=180）
  assert.equal(stats.byModel[0].model, "模型B");

  assert.equal(stats.topSessions.length, 1);
  assert.equal(stats.topSessions[0].title, "会话一");
  assert.equal(stats.topSessions[0].turns, 3);
});

test("Top 会话按轮次排序，无记录会话不入榜", () => {
  const busy = fakeSession("busy", "活跃", [turn(T0, [usage(1, 1, "m")]), turn(T0, [usage(1, 1, "m")])]);
  const idle = fakeSession("idle", "只看没聊", []);
  const stats = buildStats([idle, busy]);
  assert.equal(stats.totals.sessions, 1, "无轮次的会话不计入有记录会话数");
  assert.equal(stats.topSessions[0].sessionId, "busy");
});
