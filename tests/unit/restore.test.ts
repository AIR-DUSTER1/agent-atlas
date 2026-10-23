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

  await writeFile(file, [
    session("answered", 1),
    approval("answered"),
    { ev: "decided", id: "answered", status: "answered" },
    session("pending", 2),
    approval("pending"),
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  process.env.SESSIONS_FILE = file;
  process.env.WEB_CONFIG_FILE = join(dir, "web-config.json");
  process.env.API_KEY = "";
  try {
    const { restoreSessions, getSession } = await import("../../src/server/sessions.js");
    assert.equal(await restoreSessions(), 2);

    const answered = getSession("answered");
    assert.equal(answered?.pendingApproval, null);
    assert.equal(answered?.resumeUnavailable, false);

    const pending = getSession("pending");
    assert.equal(pending?.pendingApproval?.type, "clarification");
    assert.equal(pending?.resumeUnavailable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SESSIONS_FILE;
    delete process.env.WEB_CONFIG_FILE;
    delete process.env.API_KEY;
  }
});
