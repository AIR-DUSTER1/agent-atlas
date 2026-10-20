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

test("healthz 与 config 形状（mock 模式）", async () => {
  const health = await json("/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.body, "ok");
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
