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

test("SSE 客户端中途断开：取消生成、入档 aborted 并保持服务可用", async () => {
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

    let metrics = "";
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const metricResponse = await fetch(srv.base + "/metrics");
      assert.equal(metricResponse.status, 200);
      metrics = await metricResponse.text();
      if (/agent_sse_disconnects_total\{[^}]*\}\s+1/.test(metrics)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.match(metrics, /agent_sse_disconnects_total\{[^}]*\}\s+1/);
    assert.match(metrics, /agent_sse_streams_total\{[^}]*status="aborted"[^}]*\}\s+1/);

    const health = await fetch(srv.base + "/healthz");
    assert.equal(health.status, 200);
    const transcript = await fetch(srv.base + `/api/sessions/${session.id}/transcript`);
    assert.equal(transcript.status, 200);
    const body = await transcript.json() as { records?: Array<{ events?: unknown[] }> };
    assert.ok((body.records?.[0]?.events?.length ?? 0) > 0, "断开前的部分事件应已入档");
  } finally {
    await srv.stop();
  }
});
