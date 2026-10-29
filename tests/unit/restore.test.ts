import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// checkpoint 模块加载时不读 env（单例在首次调用时才绑定 CHECKPOINT_FILE），静态导入安全；
// session-store 则相反 —— JOURNAL_FILE 在模块加载即固化，必须等用例设好 env 后动态导入
import { resetCheckpointSaver, PersistentSaver } from "../../src/checkpoint.js";

test("restoreSessions：只恢复 status=pending 的审批/澄清", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-restore-"));
  const file = join(dir, "sessions.ndjson");
  // 检查点也指向临时目录：restoreSessions 会读它判定「是否还有持久线程记忆」
  const ckptFile = join(dir, "checkpoints.ndjson");
  process.env.CHECKPOINT_FILE = ckptFile;
  const session = (id: string, createdAt: number) => ({
    ev: "session",
    session: {
      id, kind: "agent", demo: null, agentId: null, projectId: "default",
      title: id, createdAt, threadId: `th-${id}`,
    },
  });
  const approval = (id: string) => ({
    ev: "approval",
    id,
    toolName: "clarification",
    payload: {
      type: "clarification",
      question: "选哪个？",
      options: [{ id: "A", label: "北京" }, { id: "B", label: "上海" }],
      allowCustom: true,
    },
  });
  const estate = {
    ev: "session",
    session: {
      id: "estate", kind: "estate", agentProfileId: "estate", demo: null, agentId: null,
      projectId: "default", title: "房产", createdAt: 3, threadId: "th-estate",
    },
  };
  const spoofedGeneral = {
    ev: "session",
    session: {
      id: "spoofed-general", kind: "agent", agentProfileId: "estate", demo: null, agentId: null,
      projectId: "default", title: "伪造通用身份", createdAt: 4, threadId: "th-spoofed-general",
    },
  };
  const spoofedEstate = {
    ev: "session",
    session: {
      id: "spoofed-estate", kind: "estate", agentProfileId: "general", demo: null, agentId: null,
      projectId: "default", title: "伪造房产身份", createdAt: 5, threadId: "th-spoofed-estate",
    },
  };
  const spoofedTurn = {
    ev: "turn", id: "spoofed-general", turnId: "turn-spoofed", agentProfileId: "estate",
    user: "伪造轮次身份", events: [], startedAt: 100, finishedAt: 150, durationMs: 50,
  };
  const invalidKind = {
    ev: "session",
    session: {
      id: "invalid-kind", kind: "not-a-real-kind", demo: null, agentId: null,
      projectId: "default", title: "非法会话", createdAt: 6, threadId: "th-invalid",
    },
  };
  const legacyId = {
    ev: "turn", id: "answered", ts: 123_456,
    user: "旧轮次", events: [],
  };

  await writeFile(file, [
    session("answered", 1),
    approval("answered"),
    { ev: "decided", id: "answered", status: "answered" },
    session("pending", 2),
    approval("pending"),
    estate,
    spoofedGeneral,
    spoofedTurn,
    spoofedEstate,
    invalidKind,
    legacyId,
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  process.env.SESSIONS_FILE = file;
  process.env.WEB_CONFIG_FILE = join(dir, "web-config.json");
  process.env.API_KEY = "";
  try {
    const { restoreSessions, getSession } = await import("../../src/server/sessions.js");
    assert.equal(await restoreSessions(), 5);

    const answered = getSession("answered");
    assert.equal(answered?.pendingApproval, null);
    assert.equal(answered?.resumeUnavailable, false);
    assert.equal(answered?.agentProfileId, "general", "旧 journal 按 kind 派生 profile");
    assert.equal(answered?.turnHistory[0]?.turnId, "legacy-answered-0", "旧轮次要稳定回填 turnId");
    assert.equal(answered?.turnHistory[0]?.startedAt, 123_456, "旧轮次用 journal ts 回填 startedAt");

    const pending = getSession("pending");
    assert.equal(pending?.pendingApproval?.type, "clarification");
    assert.equal(pending?.resumeUnavailable, true);

    const restoredEstate = getSession("estate");
    assert.equal(restoredEstate?.agentProfileId, "estate");

    const spoofedAgent = getSession("spoofed-general");
    assert.equal(spoofedAgent?.agentProfileId, "general", "journal 自报 profile 不能覆盖 kind");
    assert.equal(spoofedAgent?.turnHistory[0]?.agentProfileId, "general");
    assert.equal(spoofedAgent?.turnHistory[0]?.turnId, "turn-spoofed");
    assert.equal(spoofedAgent?.turnHistory[0]?.durationMs, 50);

    const spoofedEstateSession = getSession("spoofed-estate");
    assert.equal(spoofedEstateSession?.agentProfileId, "estate");

    assert.equal(getSession("invalid-kind"), undefined, "未知 kind 必须 fail-closed");
  } finally {
    delete process.env.SESSIONS_FILE;
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.API_KEY;
    delete process.env.CHECKPOINT_FILE;
    await rm(dir, { recursive: true, force: true });
    // 先删 env 再重置：让单例绑定回落默认值，下一个用例设自己的 env 后从头绑定
    resetCheckpointSaver();
    const { resetJournalStore } = await import("../../src/server/session-store.js");
    resetJournalStore();
  }
});

test("restoreSessions：有持久检查点的会话不再注入 journal 摘录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-restore-"));
  const journalFile = join(dir, "sessions.ndjson");
  const ckptFile = join(dir, "checkpoints.ndjson");
  try {
    // journal：两个带历史轮的 agent 会话，threadId 一有一无检查点
    const session = (id: string, threadId: string) => ({
      ev: "session",
      session: {
        id, kind: "agent", demo: null, agentId: null, projectId: "default",
        title: id, createdAt: 1, threadId,
      },
    });
    const turn = (id: string) => ({
      ev: "turn", id, turnId: `turn-${id}`, user: "历史消息", events: [
        { type: "token", text: "历史回答" },
      ], startedAt: 100, finishedAt: 150, durationMs: 50,
    });
    await writeFile(journalFile, [
      session("with-ckpt", "th-has"),
      turn("with-ckpt"),
      session("no-ckpt", "th-none"),
      turn("no-ckpt"),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");

    // 检查点文件：只给 th-has 落一个真实检查点
    process.env.CHECKPOINT_FILE = ckptFile;
    process.env.SESSIONS_FILE = journalFile;
    process.env.WEB_CONFIG_FILE = join(dir, "web-config.json");
    process.env.API_KEY = "";
    // journal 与 checkpoint 都是模块级单例状态：换文件前必须重置（上一用例已回放过一次）
    const { resetJournalStore } = await import("../../src/server/session-store.js");
    resetJournalStore();
    resetCheckpointSaver();
    const saver = new PersistentSaver(ckptFile);
    await saver.put(
      { configurable: { thread_id: "th-has" } },
      {
        v: 4, id: "ckpt-0001", ts: "2026-01-01T00:00:00.000Z",
        channel_values: {}, channel_versions: {}, versions_seen: {},
      } as never,
      { source: "loop", step: 1, writes: null, parents: {} } as never
    );
    await saver.flush();

    const { restoreSessions, getSession } = await import("../../src/server/sessions.js");
    await restoreSessions();

    // 有检查点：完整线程记忆已恢复，无需（也不能）再注入摘录
    assert.equal(getSession("with-ckpt")?.resumeUninjected, false);
    // 无检查点：维持旧降级路径 —— 下一轮注入 journal 摘录
    assert.equal(getSession("no-ckpt")?.resumeUninjected, true);
  } finally {
    delete process.env.CHECKPOINT_FILE;
    delete process.env.SESSIONS_FILE;
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.API_KEY;
    await rm(dir, { recursive: true, force: true });
    resetCheckpointSaver();
    const { resetJournalStore } = await import("../../src/server/session-store.js");
    resetJournalStore(); // 同上：重置回默认绑定，后续文件拿到干净空态
  }
});

test("restoreSessions：压缩后的 threadId、摘要与注入状态从 journal 恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-restore-compact-"));
  const journalFile = join(dir, "sessions.ndjson");
  process.env.CHECKPOINT_FILE = join(dir, "checkpoints.ndjson");
  process.env.SESSIONS_FILE = journalFile;
  process.env.WEB_CONFIG_FILE = join(dir, "web-config.json");
  process.env.API_KEY = "";
  try {
    const rows = [
      {
        ev: "session",
        session: {
          id: "compact-restore", kind: "agent", demo: null, agentId: null,
          projectId: "default", title: "压缩恢复", createdAt: 1, threadId: "th-old",
        },
      },
      {
        ts: 10, ev: "compact", id: "compact-restore", threadId: "th-new",
        summary: "保留暗号蓝鲸", beforeChars: 50_000, afterChars: 7,
        lastCompactTurnId: "turn-old",
      },
      { ts: 11, ev: "contextInjected", id: "compact-restore" },
    ];
    await writeFile(journalFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const { resetJournalStore } = await import("../../src/server/session-store.js");
    resetJournalStore();
    resetCheckpointSaver();
    const { restoreSessions, getSession, takeContextSummary } = await import("../../src/server/sessions.js");
    await restoreSessions();
    const session = getSession("compact-restore");
    assert.equal(session?.threadId, "th-new");
    assert.equal(session?.contextSummary, "保留暗号蓝鲸");
    assert.equal(session?.contextSummaryInjected, true);
    assert.equal(session?.lastCompactTurnId, "turn-old");
    assert.equal(takeContextSummary(session!), null, "已注入过的摘要重启后不能重复占用预算");
  } finally {
    delete process.env.CHECKPOINT_FILE;
    delete process.env.SESSIONS_FILE;
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.API_KEY;
    await rm(dir, { recursive: true, force: true });
    resetCheckpointSaver();
    const { resetJournalStore } = await import("../../src/server/session-store.js");
    resetJournalStore();
  }
});
