/**
 * auto-approval-audit.test.ts — 自主放行必须进入安全审计
 * ============================================================
 * 守：低风险自动决定的工具名、理由、来源都落到 hitl.decided，且不记录参数。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("自主放行写 hitl.decided decision=auto，并带审查理由", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-auto-audit-"));
  process.env.AUDIT_FILE = join(dir, "audit.ndjson");
  try {
    const audit = await import("../../src/server/audit.js");
    audit.resetAuditStateForTests();
    const { recordAutoApprovalAudit } = await import("../../src/server/routes/chat.js");
    recordAutoApprovalAudit(
      { id: "s-auto", agentProfileId: "general" } as never,
      {
        type: "risk_decision",
        decision: "auto",
        toolName: "terminal",
        reason: "只读取工作区状态，可恢复",
        callId: "risk:thread:call-1",
      }
    );
    await audit.flushAudit();
    const lines = (await readFile(join(dir, "audit.ndjson"), "utf8")).trim().split("\n");
    const event = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    assert.equal(event.ev, "hitl.decided");
    assert.equal(event.sessionId, "s-auto");
    assert.equal(event.toolName, "terminal");
    assert.equal(event.decision, "auto");
    assert.equal(event.source, "tool-risk");
    assert.match(String(event.reason), /可恢复/);
  } finally {
    delete process.env.AUDIT_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});
