/**
 * tests/unit/lifecycle.test.ts — 优雅退出状态机（离线，不真起服务）
 * ============================================================
 * 覆盖：关闭中拒绝新请求、SSE 收到 shutdown 帧后被 abort、在途归零 → exit 0、
 * 超时强制断连 → exit 1、重复 shutdown 幂等。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { createLifecycle, type ShutdownDeps } from "../../src/server/lifecycle.js";

process.env.LOG_LEVEL = "silent";

interface FakeSse {
  res: ServerResponse;
  state: { written: string; aborted: boolean };
}

function fakeSse(): FakeSse {
  const state = { written: "", aborted: false };
  const res = {
    writableEnded: false,
    write(chunk: string) { state.written += chunk; return true; },
  } as unknown as ServerResponse;
  return { res, state };
}

function deps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    closeServer: () => { calls.push("closeServer"); },
    closeIdleConnections: () => { calls.push("closeIdle"); },
    closeAllConnections: () => { calls.push("closeAll"); },
    flush: async () => { calls.push("flush"); },
    exit: (code) => { calls.push(`exit:${code}`); },
    ...overrides,
  };
}

function registerFakeSse(lc: ReturnType<typeof createLifecycle>, sse: FakeSse): () => void {
  return lc.registerSse(sse.res, () => { sse.state.aborted = true; });
}

test("关闭：拒绝新请求、通知 SSE、在途归零后退出 0", async () => {
  const lc = createLifecycle();
  assert.equal(lc.beginRequest(), true);
  const sse = fakeSse();
  const unregister = registerFakeSse(lc, sse);
  assert.equal(lc.inFlight(), 1);

  const d = deps();
  const pending = lc.shutdown(d);

  assert.equal(lc.isShuttingDown(), true);
  assert.equal(lc.beginRequest(), false, "关闭中不得再接受新请求");
  assert.equal(sse.state.aborted, true, "SSE 连接应被 abort");
  assert.match(sse.state.written, /"type":"shutdown"/);
  assert.deepEqual(d.calls.slice(0, 2), ["closeServer", "closeIdle"]);

  lc.endRequest();
  assert.equal(await pending, "drained");
  assert.ok(d.calls.includes("flush"));
  assert.ok(d.calls.includes("exit:0"));

  unregister(); // 已清空也不应报错
});

test("关闭超时：强制断开剩余连接并退出 1", async () => {
  const lc = createLifecycle();
  lc.beginRequest();
  const d = deps({ timeoutMs: 30 });
  assert.equal(await lc.shutdown(d), "timeout");
  assert.ok(d.calls.includes("closeAll"));
  assert.ok(d.calls.includes("exit:1"));
  lc.endRequest();
});

test("shutdown 幂等：重复调用只执行一次 flush/exit", async () => {
  const lc = createLifecycle();
  const d = deps();
  assert.equal(await lc.shutdown(d), "drained");
  assert.equal(await lc.shutdown(d), "drained");
  assert.equal(d.calls.filter((call) => call === "flush").length, 1);
  assert.equal(d.calls.filter((call) => call === "exit:0").length, 1);
});
