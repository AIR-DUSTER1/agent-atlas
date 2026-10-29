/**
 * turn-record.test.ts — journal 落盘投影的确定性与可审计性
 * ============================================================
 * 守：usage 按 callId 留终值；旧无 callId 只消连续重复；token/reasoning
 * 合并不丢正文；截断必有 storage 元数据。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../../src/server/events.js";
import { canonicalizeTurnEvents, MAX_RECORD_EVENTS } from "../../src/server/turn-record.js";

const usage = (input: number, output: number, callId?: string, internal = false): AgentEvent => ({
  type: "usage", inputTokens: input, outputTokens: output, totalTokens: input + output,
  cacheReadTokens: 0, ...(callId ? { callId } : {}), internal,
});

test("usage：同 callId 保留最新快照，internal 成本不被丢弃", () => {
  const result = canonicalizeTurnEvents([
    usage(100, 10, "call-a"),
    usage(120, 20, "call-a", true),
    usage(200, 30, "call-b"),
  ]);
  assert.equal(result.events.filter((event) => event.type === "usage").length, 2);
  assert.deepEqual(result.events.filter((event) => event.type === "usage").map((event) => [
    event.inputTokens, event.outputTokens, "internal" in event ? event.internal : false,
  ]), [[120, 20, true], [200, 30, false]]);
  assert.equal(result.storage.dedupedUsageEvents, 1);
});

test("旧 usage：只合并连续相同签名，相同数值的非连续调用仍是两次", () => {
  const result = canonicalizeTurnEvents([
    usage(100, 10),
    usage(100, 10),
    { type: "node", name: "agent" },
    usage(100, 10),
  ]);
  assert.equal(result.events.filter((event) => event.type === "usage").length, 2);
  assert.equal(result.storage.dedupedUsageEvents, 1);
});

test("token / reasoning 相邻分片合并，正文内容不丢", () => {
  const result = canonicalizeTurnEvents([
    { type: "token", text: "你", node: "agent" },
    { type: "token", text: "好", node: "agent" },
    { type: "reasoning", text: "想", node: "analyze" },
    { type: "reasoning", text: "一下", node: "analyze" },
  ]);
  assert.deepEqual(result.events, [
    { type: "token", text: "你好", node: "agent" },
    { type: "reasoning", text: "想一下", node: "analyze" },
  ]);
  assert.equal(result.storage.mergedTokenChunks, 1);
  assert.equal(result.storage.mergedReasoningChunks, 1);
});

test("超过事件上限时保留尾部并明确记录丢弃区间", () => {
  const events: AgentEvent[] = Array.from({ length: MAX_RECORD_EVENTS + 12 }, (_, index) => ({
    type: "node", name: `step-${index}`,
  }));
  const result = canonicalizeTurnEvents(events);
  assert.equal(result.events.length, MAX_RECORD_EVENTS);
  assert.equal(result.storage.droppedEvents, 12);
  assert.equal(result.storage.originalEvents, MAX_RECORD_EVENTS + 12);
  assert.equal(result.events[0].type, "node");
  assert.equal(result.events[0].type === "node" ? result.events[0].name : "", "step-12");
});

test("reasoning 总量超预算时截尾并记录字符数", () => {
  const result = canonicalizeTurnEvents([
    { type: "reasoning", text: "a".repeat(25_000), node: "agent" },
  ]);
  const event = result.events[0];
  assert.equal(event.type, "reasoning");
  assert.match(event.type === "reasoning" ? event.text : "", /思考记录已达单轮上限/);
  assert.ok(result.storage.reasoningCharsDropped > 0);
});
