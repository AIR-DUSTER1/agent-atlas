/**
 * tests/integration/agent-profile.test.ts — Agent identity 端到端回归
 * ============================================================
 * 守 API 契约：新会话创建 / 会话列表 / transcript 轮次都必须带
 * agentProfileId；审批审计 hitl.decided 也必须能区分执行域。
 * 全程 mock 模式，不调用真实模型。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "../helpers/server.js";

let srv: RunningServer;

before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(srv.base + path, init);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function readSse(path: string, payload: unknown): Promise<{ status: number; events: any[] }> {
  const res = await fetch(srv.base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) return { status: res.status, events: [] };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: any[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!frame.startsWith("data: ")) continue;
      const ev = JSON.parse(frame.slice(6));
      events.push(ev);
      if (ev.type === "done") { await reader.cancel(); return { status: 200, events }; }
    }
  }
  return { status: 200, events };
}

test("会话创建 / 列表 / transcript 均携带 agentProfileId", async () => {
  const general = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  assert.equal(general.status, 200);
  assert.equal(general.body.agentProfileId, "general");

  const estate = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "estate" }),
  });
  assert.equal(estate.status, 200);
  assert.equal(estate.body.agentProfileId, "estate");

  const demo = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "demo", demo: 1 }),
  });
  assert.equal(demo.status, 200);
  assert.equal(demo.body.agentProfileId, null);

  const list = await json("/api/sessions");
  assert.equal(list.status, 200);
  assert.equal(list.body.find((item: any) => item.id === general.body.id)?.agentProfileId, "general");
  assert.equal(list.body.find((item: any) => item.id === estate.body.id)?.agentProfileId, "estate");
  assert.equal(list.body.find((item: any) => item.id === demo.body.id)?.agentProfileId, null);

  const stream = await readSse("/api/chat", { sessionId: general.body.id, message: "你好" });
  assert.equal(stream.status, 200);

  const transcript = await json(`/api/sessions/${general.body.id}/transcript`);
  assert.equal(transcript.status, 200);
  assert.equal(transcript.body.records.at(-1)?.agentProfileId, "general");
  assert.match(transcript.body.records.at(-1)?.turnId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(typeof transcript.body.records.at(-1)?.durationMs, "number");
});

test("审批审计 hitl.decided 携带 agentProfileId", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const sessionId = mk.body.id;

  const first = await readSse("/api/chat", {
    sessionId,
    message: "帮我发邮件给 test@example.com，主题是身份审计",
  });
  assert.equal(first.events.find((event) => event.type === "interrupt")?.payload?.type, "approval");

  const resumed = await readSse("/api/resume", { sessionId, decision: "approve" });
  assert.ok(resumed.events.some((event) => event.type === "done"));

  const auditPath = join(dirname(srv.journalPath), "audit.ndjson");
  let audit = "";
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { audit = await readFile(auditPath, "utf8"); } catch { /* 审计写入是异步的 */ }
    if (audit.includes("hitl.decided")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const decided = audit
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.ev === "hitl.decided" && event.sessionId === sessionId);
  assert.equal(decided?.agentProfileId, "general");
});
