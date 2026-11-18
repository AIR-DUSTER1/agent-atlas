/**
 * tests/unit/prehistory.test.ts — 重启后历史上文注入（T2-4）
 * ============================================================
 * 守语义：只注入一次（resumeUninjected 无论成功与否置 false）；
 * 无记忆图的 demo1/4 不注入；纯工具轮跳过；用户/助手文本按上限截断。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, TurnRecord } from "../../src/server/sessions.js";
import { buildPrehistoryNote } from "../../src/server/sessions.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-test",
    kind: "agent",
    agentProfileId: "general",
    demo: null,
    agentId: null,
    ownerId: "local",
    deviceId: "local",
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
    contextSummary: null,
    contextSummaryInjected: false,
    lastCompactTurnId: null,
    permissionMode: "approve",
    activeTask: null,
    taskLedger: "",
    ...overrides,
  };
}

function turn(user: string, aiText: string): TurnRecord {
  return {
    turnId: `turn-${user}`,
    agentProfileId: "general",
    user,
    events: aiText ? [{ type: "token", text: aiText } as TurnRecord["events"][number]] : [],
    startedAt: Date.now(),
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

test("journal compact 必须保留设备归属，重启回放后仍按原设备隔离", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-journal-compact-"));
  const file = join(dir, "sessions.ndjson");
  const previous = process.env.SESSIONS_FILE;
  process.env.SESSIONS_FILE = file;
  const store = await import("../../src/server/session-store.js");
  try {
    store.resetJournalStore();
    const filler = "x".repeat(2_100_000);
    const lines = [
      JSON.stringify({ ev: "schema", schemaVersion: store.JOURNAL_SCHEMA_VERSION }),
      JSON.stringify({
        ev: "session",
        session: {
          id: "session-a", kind: "agent", agentProfileId: "general", demo: null, agentId: null,
          deviceId: "device-a", projectId: "default", title: "设备 A", createdAt: Date.now(),
          threadId: "thread-a", permissionMode: "approve",
        },
      }),
      JSON.stringify({
        ev: "turn", id: "session-a", turnId: "turn-a", user: filler,
        events: [], startedAt: Date.now(),
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    await store.replaySessions();
    await store.maybeCompactJournal();
    const compacted = await readFile(file, "utf8");
    assert.match(compacted, /"deviceId":"device-a"/);

    store.resetJournalStore();
    await store.replaySessions();
    assert.equal(store.journalSnapshot()[0]?.deviceId, "device-a");
  } finally {
    store.resetJournalStore();
    if (previous === undefined) delete process.env.SESSIONS_FILE;
    else process.env.SESSIONS_FILE = previous;
    store.resetJournalStore();
    await rm(dir, { recursive: true, force: true });
  }
});
