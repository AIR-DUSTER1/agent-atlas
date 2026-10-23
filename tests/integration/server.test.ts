/**
 * tests/integration/server.test.ts — HTTP 主链路（mock 模式，零真实模型调用）
 * ============================================================
 * 覆盖：healthz / config(mock) / 会话创建 / chat SSE / transcript 回放 /
 * 404 / 400 / 静态页面与 ESM 模块分发（含 MIME）。
 * 服务端按规定从 tests/helpers 启动（临时端口 + 临时 journal / 配置文件）。
 */
import assert from "node:assert/strict";
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

/** 读取 SSE 直到 done 事件（带超时） */
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

test("healthz / readyz 与 config 形状（mock 模式）", async () => {
  const raw = await fetch(srv.base + "/healthz");
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/, "每个响应都应带 X-Request-Id");

  const health = await json("/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.match(health.body.version, /^\d+\.\d+\.\d+/);
  assert.ok(health.body.uptimeSeconds >= 0);

  const ready = await json("/readyz");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ok, true);
  assert.equal(ready.body.shuttingDown, false);
  assert.deepEqual(ready.body.checks, { configStore: true, sessionStore: true });

  const cfg = await json("/api/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.mock, true, "测试必须跑在 mock 模式");
  assert.ok(Array.isArray(cfg.body.demos));
});

test("会话创建 → chat SSE → transcript 回放", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  assert.equal(mk.status, 200);
  const id = mk.body.id;
  assert.ok(id);

  const stream = await readSse("/api/chat", { sessionId: id, message: "帮我算一下 1+1" });
  assert.equal(stream.status, 200);
  assert.ok(stream.events.some((e) => e.type === "token"), "应有 token 事件");
  assert.equal(stream.events.at(-1).type, "done");

  const tr = await json(`/api/sessions/${id}/transcript`);
  assert.equal(tr.status, 200);
  assert.ok(Array.isArray(tr.body.records) && tr.body.records.length >= 1);
  assert.equal(tr.body.records.at(-1).user, "帮我算一下 1+1");
});

test("错误路径：未知 API 404、缺 message 400、未知会话 chat 404", async () => {
  assert.equal((await json("/api/does-not-exist")).status, 404);
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  assert.equal((await json("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: mk.body.id, message: "   " }),
  })).status, 400);
  assert.equal((await json("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "no-such-session", message: "hi" }),
  })).status, 404);
});

test("resume：没有待确认事项时 choice 返回 400，不误当审批处理", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const res = await json("/api/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: mk.body.id, choice: "A" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /没有待确认/);
});

test("审批：interrupt 后保留 pending，批准能恢复并执行工具", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const sessionId = mk.body.id;
  const first = await readSse("/api/chat", { sessionId, message: "帮我发邮件给 test@example.com，主题是测试" });
  const interrupt = first.events.find((event) => event.type === "interrupt");
  assert.equal(interrupt?.payload?.type, "approval");

  const sessions = await json("/api/sessions");
  const pending = sessions.body.find((item: { id: string }) => item.id === sessionId);
  assert.equal(pending?.pendingApproval, true, "interrupt 后 done 不能清掉待审批状态");

  const resumed = await readSse("/api/resume", { sessionId, decision: "approve" });
  const result = resumed.events.find((event) => event.type === "tool_result");
  assert.match(String(result?.content ?? ""), /邮件已发送/);

  const afterResume = await json("/api/sessions");
  const cleared = afterResume.body.find((item: { id: string }) => item.id === sessionId);
  assert.equal(cleared?.pendingApproval, false);
});

test("文件搜索接口：最多 20 条，跳过依赖目录", async () => {
  const res = await json("/api/fs/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "app.js" }),
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.files));
  assert.ok(res.body.files.length > 0);
  assert.ok(res.body.files.length <= 20);
  assert.ok(res.body.files.every((f: any) => !f.rel.includes("node_modules")));
});

test("压缩上下文：mock 模式走本地摘录并保留轮次回放", async () => {
  const mk = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "agent" }),
  });
  const id = mk.body.id;
  const stream = await readSse("/api/chat", { sessionId: id, message: "记住暗号：蓝鲸" });
  assert.equal(stream.status, 200);

  const compact = await json(`/api/sessions/${id}/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(compact.status, 200);
  assert.equal(compact.body.usedModel, false);
  assert.match(compact.body.summary, /较早对话摘录/);
  assert.ok(compact.body.beforeChars > 0);

  const tr = await json(`/api/sessions/${id}/transcript`);
  assert.equal(tr.body.records.at(-1).user, "记住暗号：蓝鲸");
});

test("静态分发：index 引用 module 脚本，modules/*.js 可达且 MIME 正确", async () => {
  const index = await fetch(srv.base + "/");
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);

  for (const file of ["/app.js", "/modules/format.js", "/modules/ui-dialog.js"]) {
    const res = await fetch(srv.base + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type") ?? "", /text\/javascript/, file);
  }
});
