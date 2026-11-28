/**
 * ============================================================
 * fault-injection.test.ts — 真实 HTTP 进程级故障注入
 * ============================================================
 * 覆盖单元测试不容易证明的路径：客户端读取首个 SSE 块后断开，服务端必须
 * 取消生成、记录 aborted 轮次、递增断连指标且继续存活；不可写路径必须
 * fail-closed，而不是只在“权限位看起来可写”时误判。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWritableDirectories } from "../../src/server/production.js";
import { startServer } from "../helpers/server.js";

interface SessionListItem {
  id: string;
  running?: boolean;
}

/** 轮询 /api/sessions 直到某会话满足条件（轮询语义本身也是被测契约：前端就靠它）。 */
async function pollSessions(
  base: string,
  sessionId: string,
  predicate: (session: SessionListItem) => boolean,
  timeoutMs = 8_000,
): Promise<SessionListItem | null> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionListItem | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions`);
    if (response.status !== 200) return null;
    const list = await response.json() as SessionListItem[];
    last = list.find((item) => item.id === sessionId) ?? null;
    if (last && predicate(last)) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  }
  return last;
}

test("不可写挂载路径（ENOTDIR）被写探针拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-readonly-"));
  const file = join(dir, "not-a-directory");
  try {
    await writeFile(file, "occupied", "utf8");
    await assert.rejects(
      () => assertWritableDirectories([join(file, "data")]),
      /生产数据目录不可写/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE 客户端中途断开：不取消生成，后台跑完并入档", async () => {
  const srv = await startServer();
  try {
    const sessionResponse = await fetch(srv.base + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "agent" }),
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json() as { id: string };

    const controller = new AbortController();
    const response = await fetch(srv.base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        message: "帮我查北京天气，然后写一首很长的诗，包含春夏秋冬、城市、人物和完整故事",
      }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    controller.abort();
    await reader.cancel().catch(() => {});

    // 断开 ≠ 取消：服务端必须继续生成，并在列表里如实报 running=true
    // （刷新页面后侧栏「生成中」就靠这个字段还原）。
    const running = await pollSessions(srv.base, session.id, (s) => s.running === true);
    assert.equal(running?.running, true, "断连后生成应继续，列表 running 应为 true");

    const metricsDeadline = Date.now() + 8_000;
    let metrics = "";
    while (Date.now() < metricsDeadline) {
      metrics = await (await fetch(srv.base + "/metrics")).text();
      if (/agent_sse_disconnects_total\{[^}]*\}\s+1/.test(metrics)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.match(metrics, /agent_sse_disconnects_total\{[^}]*\}\s+1/);

    // 模拟模式一轮很快就跑完：等它自然结束，running 必须回到 false，
    // 且这一轮（含断连之后的全部事件）完整入档。
    const finished = await pollSessions(srv.base, session.id, (s) => s.running === false, 20_000);
    assert.equal(finished?.running, false, "后台生成应自然结束");

    const health = await fetch(srv.base + "/healthz");
    assert.equal(health.status, 200);
    const transcript = await fetch(srv.base + `/api/sessions/${session.id}/transcript`);
    assert.equal(transcript.status, 200);
    const body = await transcript.json() as { records?: Array<{ events?: Array<{ type?: string }> }> };
    const events = body.records?.[0]?.events ?? [];
    assert.ok(events.length > 0, "断连前的部分事件应已入档");
    assert.ok(events.some((event) => event.type === "usage"), "断连后的生成应继续到收尾事件");
  } finally {
    await srv.stop();
  }
});

test("显式停止接口：中止正在进行的生成，没有运行时返回 409", async () => {
  const srv = await startServer();
  try {
    const sessionResponse = await fetch(srv.base + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "agent" }),
    });
    const session = await sessionResponse.json() as { id: string };

    // 先确认空闲时会话没有运行：停止接口必须如实拒绝，而不是假装成功。
    const idleStop = await fetch(srv.base + `/api/sessions/${session.id}/stop`, { method: "POST" });
    assert.equal(idleStop.status, 409);

    const controller = new AbortController();
    const response = await fetch(srv.base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        message: "写一首很长的诗，包含春夏秋冬、城市、人物和完整故事，越长越好",
      }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);

    const stop = await fetch(srv.base + `/api/sessions/${session.id}/stop`, { method: "POST" });
    assert.equal(stop.status, 200);
    const stopBody = await stop.json() as { ok?: boolean };
    assert.equal(stopBody.ok, true);

    controller.abort();
    await reader.cancel().catch(() => {});

    // 停止后必须真的把生成收掉，并把这一轮按 aborted 入档。
    const stopped = await pollSessions(srv.base, session.id, (s) => s.running === false, 10_000);
    assert.equal(stopped?.running, false, "停止后不应再报告 running");
    const metrics = await (await fetch(srv.base + "/metrics")).text();
    assert.match(metrics, /agent_sse_streams_total\{[^}]*status="aborted"[^}]*\}\s+1/);

    const transcript = await fetch(srv.base + `/api/sessions/${session.id}/transcript`);
    const body = await transcript.json() as { records?: Array<{ events?: unknown[] }> };
    assert.ok((body.records?.[0]?.events?.length ?? 0) > 0, "停止前的部分事件应已入档");
  } finally {
    await srv.stop();
  }
});
