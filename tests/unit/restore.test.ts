import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("restoreSessions：只恢复 status=pending 的审批/澄清", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-restore-"));
  const file = join(dir, "sessions.ndjson");
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
    await rm(dir, { recursive: true, force: true });
    delete process.env.SESSIONS_FILE;
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.API_KEY;
  }
});
