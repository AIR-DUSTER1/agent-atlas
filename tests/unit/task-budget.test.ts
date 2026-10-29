/**
 * task-budget.test.ts — 逻辑任务跨审批预算/台账
 * ============================================================
 * 守：审批/澄清/继续继承同一任务；等待时间不计入活动时长；预算按去重后的
 * 工具/模型调用计算；台账只保留可复用事实，不无限保存原始输出。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../../src/server/sessions.js";
import {
  beginTaskSegment, endTaskSegment, observeTaskEvent, renderTaskLedger, taskLimit, taskSnapshot,
} from "../../src/server/task-budget.js";

function session(): Session {
  return {
    id: "s", kind: "agent", agentProfileId: "general", demo: null, agentId: null,
    projectId: "default", title: "t", createdAt: 0, graph: null, threadId: "th",
    pendingApproval: null, configVersion: 1, turns: 0, turnHistory: [],
    resumeUninjected: false, resumeUnavailable: false, contextSummary: null,
    contextSummaryInjected: false, lastCompactTurnId: null, permissionMode: "approve",
    activeTask: null, taskLedger: "",
  };
}

const limits = { turnTimeoutMs: 10_000, idleTimeoutMs: 5_000, maxToolCalls: 2, maxModelCalls: 2 };

test("继续继承任务，工具/模型按 id 去重并写入台账", () => {
  const s = session();
  beginTaskSegment(s, false, "修复会话折叠");
  observeTaskEvent(s, { type: "tool_call", id: "t1", name: "read_file", argsFragment: "{\"path\":\"a.ts\"}" });
  observeTaskEvent(s, { type: "tool_call", id: "t1", name: "read_file", argsFragment: "" });
  observeTaskEvent(s, { type: "tool_result", id: "t1", content: "const x = 1", isError: false });
  observeTaskEvent(s, { type: "usage", inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, callId: "m1" });
  assert.equal(taskSnapshot(s)?.toolCalls, 1);
  assert.equal(taskSnapshot(s)?.modelCalls, 1);
  assert.match(renderTaskLedger(s.activeTask), /read_file/);

  endTaskSegment(s);
  beginTaskSegment(s, true, "继续");
  assert.equal(taskSnapshot(s)?.toolCalls, 1, "继续不能重置任务预算/台账");
  assert.match(s.taskLedger, /a\.ts/);
});

test("预算超限给出明确原因（工具/模型/停滞）", () => {
  const s = session();
  beginTaskSegment(s, false, "任务");
  observeTaskEvent(s, { type: "tool_call", id: "t1", name: "a", argsFragment: "{}" });
  observeTaskEvent(s, { type: "tool_call", id: "t2", name: "b", argsFragment: "{}" });
  observeTaskEvent(s, { type: "tool_call", id: "t3", name: "c", argsFragment: "{}" });
  assert.equal(taskLimit(s, limits)?.reason, "tools");

  s.activeTask!.toolCalls.clear();
  s.activeTask!.toolCallCount = 0;
  s.activeTask!.lastActivityAt = Date.now() - 6_000;
  assert.equal(taskLimit(s, limits)?.reason, "idle");
});

test("用户显式继续会开启新预算窗口，但保留台账和累计成本", () => {
  const s = session();
  beginTaskSegment(s, false, "原始任务");
  for (let i = 0; i < 3; i += 1) {
    observeTaskEvent(s, { type: "tool_call", id: `t-${i}`, name: "read_file", argsFragment: "{}" });
  }
  s.activeTask!.limited = true;
  s.activeTask!.budgetBaseToolCalls = 0;
  endTaskSegment(s);
  const before = taskSnapshot(s)!.toolCalls;
  beginTaskSegment(s, false, "继续");
  assert.equal(taskSnapshot(s)!.toolCalls, before, "累计工具数不能清零");
  assert.equal(taskLimit(s, limits), null, "新窗口不继承旧窗口已用满的工具预算");
  assert.match(s.taskLedger, /read_file/);
});

test("结束片段后等待审批的时间不计入活动时长", async () => {
  const s = session();
  beginTaskSegment(s, false, "任务");
  await new Promise((resolve) => setTimeout(resolve, 20));
  endTaskSegment(s);
  const first = taskSnapshot(s)?.activeMs ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((taskSnapshot(s)?.activeMs ?? 0) < first + 20, "等待审批期间不应继续计时");
});


test("重启后首次「继续」从 journal 恢复最近任务台账，但预算窗口重新开始", () => {
  const s = session();
  s.turnHistory = [{
    turnId: "turn-old",
    agentProfileId: "general",
    user: "修复会话折叠",
    events: [
      { type: "tool_call", id: "t-old", name: "read_file", argsFragment: '{"path":"sessions.ts"}' },
      { type: "tool_result", id: "t-old", content: "已读取 sessions.ts", isError: false },
      { type: "usage", inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 0, callId: "old-1" },
      { type: "interrupt", payload: { type: "clarification", question: "继续吗", options: [], allowCustom: true } },
    ],
    startedAt: Date.now() - 60_000,
  }];
  beginTaskSegment(s, false, "继续");
  assert.match(s.taskLedger, /sessions\.ts/);
  assert.equal(taskSnapshot(s)?.toolCalls, 1);
  assert.equal(taskSnapshot(s)?.modelCalls, 1);
  assert.equal(taskLimit(s, limits), null, "旧任务计入台账但不耗尽新预算窗口");
});

test("usage 流式累计快照按峰值计算，不把分片重复相加", () => {
  const s = session();
  beginTaskSegment(s, false, "统计");
  observeTaskEvent(s, { type: "usage", inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, callId: "m1" });
  observeTaskEvent(s, { type: "usage", inputTokens: 150, outputTokens: 20, totalTokens: 170, cacheReadTokens: 0, callId: "m1" });
  assert.equal(taskSnapshot(s)?.inputTokens, 150);
  assert.equal(taskSnapshot(s)?.outputTokens, 20);
});
