/** runtime-resilience.test.ts — 熔断、资源队列与幂等退避 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CircuitBreaker, CircuitOpenError } from "../../src/server/runtime/circuit-breaker.js";
import { ResourceGauge } from "../../src/server/runtime/resource-gauge.js";
import { isRetryableHttpStatus, retryWithBackoff } from "../../src/server/runtime/retry.js";

test("熔断：closed → open → half-open → closed", async () => {
  let now = 1_000;
  const breaker = new CircuitBreaker("test", 2, 1_000, () => now);
  await assert.rejects(() => breaker.run(async () => { throw new Error("fail-1"); }));
  assert.equal(breaker.snapshot().state, "closed");
  await assert.rejects(() => breaker.run(async () => { throw new Error("fail-2"); }));
  assert.equal(breaker.snapshot().state, "open");
  await assert.rejects(() => breaker.run(async () => "blocked"), (err) => err instanceof CircuitOpenError);
  now += 1_001;
  assert.equal(await breaker.run(async () => "probe-ok"), "probe-ok");
  assert.equal(breaker.snapshot().state, "closed");
});

test("资源队列：容量满后排队，队列满拒绝，完成后槽位归还", async () => {
  const gauge = new ResourceGauge("rag-test", 1, 1, 2_000);
  let releaseFirst!: () => void;
  const first = gauge.run(() => new Promise<string>((resolve) => { releaseFirst = () => resolve("first"); }));
  const second = gauge.run(async () => "second");
  await assert.rejects(() => gauge.run(async () => "third"), /队列已满/);
  assert.deepEqual(gauge.snapshot(), { id: "rag-test", active: 1, queued: 1, capacity: 1, maxQueue: 1 });
  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(gauge.snapshot().active, 0);
});

test("资源队列：等待超时后出队并报中文错误", async () => {
  const gauge = new ResourceGauge("slow", 1, 2, 30);
  let release!: () => void;
  const first = gauge.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(() => gauge.run(async () => "never"), /等待超过/);
  release();
  await first;
  assert.equal(gauge.snapshot().queued, 0);
});

test("指数退避只重试明确允许的错误", async () => {
  let calls = 0;
  const value = await retryWithBackoff(async () => {
    calls += 1;
    if (calls < 3) throw new Error("transient");
    return "ok";
  }, { retries: 2, baseDelayMs: 50, jitterRatio: 0 });
  assert.equal(value, "ok");
  assert.equal(calls, 3);

  let fatalCalls = 0;
  await assert.rejects(() => retryWithBackoff(async () => {
    fatalCalls += 1;
    throw new Error("fatal");
  }, { retries: 3, baseDelayMs: 50, shouldRetry: () => false }));
  assert.equal(fatalCalls, 1);
  assert.equal(isRetryableHttpStatus(408), true);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(400), false);
});

test("SSE 执行器包含心跳且在 finally 清理", async () => {
  const source = await readFile(fileURLToPath(new URL("../../src/server/routes/chat.ts", import.meta.url)), "utf8");
  assert.match(source, /setInterval\(\(\) => \{/);
  assert.match(source, /: heartbeat/);
  assert.match(source, /clearInterval\(heartbeat\)/);
});