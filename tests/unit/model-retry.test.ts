/**
 * model-retry.test.ts — 模型请求自动重试
 * ============================================================
 * 守：默认 10 次重试；只重试 408/429/5xx/超时/网络错误；成功与最终失败都会
 * 产生前端可观测记录，用户取消与 400 不隐式消耗请求。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../../src/config.js";
import {
  clearModelRetryRecords, drainModelRetryRecords, invokeWithModelRetry,
} from "../../src/model-retry.js";

test("默认自动重试 10 次，共 11 次请求", () => {
  assert.equal(config.modelRequestRetries, 10);
});

test("瞬时错误按次数重试，成功后输出重试与成功记录", async () => {
  const previous = config.modelRequestRetries;
  config.modelRequestRetries = 2;
  const sid = "model-retry-success";
  try {
    let calls = 0;
    const result = await invokeWithModelRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("HTTP 503 Service Unavailable");
      return "ok";
    }, { sessionId: sid });
    assert.equal(result, "ok");
    assert.equal(calls, 3);
    const records = drainModelRetryRecords(sid);
    assert.deepEqual(records.map((item) => item.phase), ["retry", "retry", "success"]);
    assert.deepEqual(records.map((item) => item.retries), [1, 2, 2]);
    assert.equal(records[2]?.attempt, 3);
  } finally {
    config.modelRequestRetries = previous;
    clearModelRetryRecords(sid);
  }
});

test("400 与用户取消不重试，最终失败保留原因", async () => {
  const previous = config.modelRequestRetries;
  config.modelRequestRetries = 3;
  const bad = "model-retry-400";
  await assert.rejects(() => invokeWithModelRetry(async () => {
    throw new Error("HTTP 400 invalid_request_error");
  }, { sessionId: bad }), /400/);
  let records = drainModelRetryRecords(bad);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.phase, "failed");
  assert.equal(records[0]?.retries, 0, "确定性错误不能虚增已重试次数");
  assert.match(records[0]?.reason ?? "", /400/);

  const controller = new AbortController();
  controller.abort();
  const cancelled = "model-retry-cancel";
  await assert.rejects(() => invokeWithModelRetry(async (signal) => {
    assert.equal(signal?.aborted, true);
    throw new Error("This operation was aborted");
  }, { sessionId: cancelled, parentSignal: controller.signal }), /aborted/);
  records = drainModelRetryRecords(cancelled);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.phase, "failed");
  config.modelRequestRetries = previous;
  clearModelRetryRecords(bad);
  clearModelRetryRecords(cancelled);
});
