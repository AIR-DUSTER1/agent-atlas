/**
 * ============================================================
 * load-baseline.test.ts — 单实例生产负载基线
 * ============================================================
 * 基线不是压测排名，而是防止明显的 O(n²) / 阻塞回归：
 *  - 1000 个会话、30 天 usage 聚合在合理时间内完成；
 *  - 10 个独立会话并发走 mock SSE，不串行阻塞；
 *  - 100KB 用户消息可通过 HTTP body 与 transcript 往返。
 * 全程 mock，不消耗真实模型配额。
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { buildStats } from "../../src/server/routes/stats.js";
import type { Session } from "../../src/server/sessions.js";
import { startServer } from "../helpers/server.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function syntheticSessions(count: number, now: number): Session[] {
  return Array.from({ length: count }, (_, index) => {
    const startedAt = now - (index % 30) * DAY_MS;
    return {
      id: `load-session-${index}`,
      title: `负载会话 ${index}`,
      createdAt: startedAt,
      kind: "agent",
      turnHistory: [{
        turnId: `load-turn-${index}`,
        agentProfileId: "general",
        user: `第 ${index} 条消息`,
        events: [
          { type: "usage", inputTokens: 1000 + index, outputTokens: 200, cacheReadTokens: 300, model: "mock-load", callId: `call-${index}` },
          { type: "tool_call", id: `tool-${index}`, name: index % 2 ? "calculator" : "get_weather" },
          { type: "done" },
        ],
        startedAt,
        finishedAt: startedAt + 100,
        durationMs: 100,
      }],
    } as unknown as Session;
  });
}

test("1000 会话 / 30 天统计聚合保持线性基线", () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const started = performance.now();
  const stats = buildStats(syntheticSessions(1000, now), now);
  const elapsed = performance.now() - started;
  const thirtyDays = stats.ranges.find((range) => range.id === "30d");
  assert.ok(thirtyDays);
  assert.equal(thirtyDays.days, 30);
  assert.equal(thirtyDays.byDay.length, 30);
  assert.equal(thirtyDays.totals.modelCalls, 1000);
  assert.equal(thirtyDays.totals.sessions, 1000);
  assert.ok(elapsed < 3_000, `1000 会话聚合耗时 ${elapsed.toFixed(0)}ms，超过 3s 基线`);
});

test("10 个会话并发、100KB 消息可完成 HTTP / SSE 往返", async () => {
  const srv = await startServer();
  try {
    const created = await Promise.all(Array.from({ length: 11 }, async () => {
      const response = await fetch(srv.base + "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "agent" }),
      });
      assert.equal(response.status, 200);
      return await response.json() as { id: string };
    }));
    assert.equal(new Set(created.map((item) => item.id)).size, 11);

    const concurrentStarted = performance.now();
    const responses = await Promise.all(created.slice(0, 10).map((session, index) => fetch(srv.base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, message: `并发会话 ${index}` }),
      signal: AbortSignal.timeout(20_000),
    })));
    const bodies = await Promise.all(responses.map((response) => response.text()));
    const elapsed = performance.now() - concurrentStarted;
    assert.ok(responses.every((response) => response.status === 200));
    assert.ok(bodies.every((body) => body.includes('"type":"done"')));
    assert.ok(elapsed < 20_000, `10 并发 SSE 耗时 ${elapsed.toFixed(0)}ms，超过 20s 基线`);

    const largeMessage = "# 负载测试标题\\n".repeat(18_000);
    assert.ok(Buffer.byteLength(largeMessage, "utf8") >= 100_000);
    const large = await fetch(srv.base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: created[10]!.id, message: largeMessage }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(large.status, 200);
    const largeBody = await large.text();
    assert.ok(largeBody.includes('"type":"done"'));

    const transcript = await fetch(srv.base + `/api/sessions/${created[10]!.id}/transcript`);
    assert.equal(transcript.status, 200);
    const record = await transcript.json() as { records?: Array<{ user?: string }> };
    assert.equal(record.records?.[0]?.user?.length, largeMessage.length);
  } finally {
    await srv.stop();
  }
});
