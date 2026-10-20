/**
 * tests/unit/prehistory.test.ts — 重启后历史上文注入（T2-4）
 * ============================================================
 * 守语义：只注入一次（resumeUninjected 无论成功与否置 false）；
 * 无记忆图的 demo1/4 不注入；纯工具轮跳过；用户/助手文本按上限截断。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session, TurnRecord } from "../../src/server/sessions.js";
import { buildPrehistoryNote } from "../../src/server/sessions.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-test",
    kind: "agent",
    demo: null,
    agentId: null,
    projectId: "default",
    title: "测试",
    createdAt: Date.now(),
    graph: null,
    threadId: "t-test",
    pendingApproval: null,
    configVersion: 1,
    turns: 0,
    turnHistory: [],
    resumeUninjected: true,
    resumeUnavailable: false,
    ...overrides,
  };
}

function turn(user: string, aiText: string): TurnRecord {
  return {
    user,
    events: aiText ? [{ type: "token", text: aiText } as TurnRecord["events"][number]] : [],
  };
}

test("未从 journal 恢复（resumeUninjected=false）→ null", () => {
  const s = makeSession({ resumeUninjected: false, turnHistory: [turn("在吗", "在")] });
  assert.equal(buildPrehistoryNote(s), null);
});

test("agent 会话带历史 → 生成摘录且只注入一次", () => {
  const s = makeSession({ turnHistory: [turn("第一问", "第一答"), turn("第二问", "第二答")] });
  const note = buildPrehistoryNote(s);
  assert.ok(note);
  assert.match(note!, /用户: 第一问/);
  assert.match(note!, /助手: 第二答/);
  assert.equal(s.resumeUninjected, false);
  assert.equal(buildPrehistoryNote(s), null, "第二次调用不得重复注入");
});

test("demo1/4 无记忆图 → null，但仍消耗注入机会", () => {
  for (const demo of [1, 4] as const) {
    const s = makeSession({ kind: "demo", demo, turnHistory: [turn("问", "答")] });
    assert.equal(buildPrehistoryNote(s), null);
    assert.equal(s.resumeUninjected, false);
  }
});

test("demo2/3 有记忆图 → 注入", () => {
  for (const demo of [2, 3] as const) {
    const s = makeSession({ kind: "demo", demo, turnHistory: [turn("问", "答")] });
    assert.ok(buildPrehistoryNote(s));
  }
});

test("纯工具轮（无 token 文本）跳过", () => {
  const s = makeSession({ turnHistory: [turn("只查天气", ""), turn("再问", "答")] });
  const note = buildPrehistoryNote(s);
  assert.ok(note);
  assert.ok(!note!.includes("只查天气"));
});

test("超长文本按 2000/4000 字符截断", () => {
  const longUser = "U".repeat(5000);
  const longAi = "A".repeat(9000);
  const s = makeSession({ turnHistory: [turn(longUser, longAi)] });
  const note = buildPrehistoryNote(s)!;
  assert.ok(note.includes("U".repeat(2000) + "\n"), "用户话截断到 2000");
  assert.ok(!note.includes("U".repeat(2001)));
  assert.ok(note.includes("A".repeat(4000)));
  assert.ok(!note.includes("A".repeat(4001)));
});
