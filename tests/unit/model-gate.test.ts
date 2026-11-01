/**
 * model-gate.test.ts — 供应商级并发闸的 429 语义与可配置容量
 * ============================================================
 * 守三件事：
 *   1. 槽位满 → 排队；排队超时抛 ResourceBusyError（路由层据此回 429，不是 400）；
 *   2. 队列满 → 立即 ResourceBusyError，不占槽位；
 *   3. acquireSlot 与 run 一样保证归还，且重复调用释放函数幂等。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ResourceBusyError, ResourceGauge, isResourceBusyError,
} from "../../src/server/runtime/resource-gauge.js";
import { acquireModelSlot, resetModelGates, runWithModelSlot } from "../../src/server/runtime/model-gate.js";

test("资源繁忙错误：类型守卫跨模块成立，带 Retry-After 秒数", async () => {
  const gauge = new ResourceGauge("busy-test", 1, 1, 20);
  let release!: () => void;
  const first = gauge.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(
    () => gauge.run(async () => "never"),
    (err) => {
      assert.equal(isResourceBusyError(err), true, "队列满必须抛 ResourceBusyError");
      assert.ok(err instanceof ResourceBusyError);
      assert.ok(err.retryAfterSeconds >= 1);
      return true;
    },
  );
  release();
  await first;
});

test("排队超时：抛 ResourceBusyError（可重试），不是普通 Error", async () => {
  const gauge = new ResourceGauge("timeout-test", 1, 4, 30);
  let release!: () => void;
  const first = gauge.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(
    () => gauge.run(async () => "never"),
    (err) => isResourceBusyError(err) && /等待超过/.test((err as Error).message),
  );
  release();
  await first;
  assert.equal(gauge.snapshot().active, 0, "异常路径也必须归还槽位");
});

test("acquireSlot：手动释放且幂等，释放后容量恢复", async () => {
  const gauge = new ResourceGauge("slot-test", 1, 2, 1_000);
  const release = await gauge.acquireSlot();
  assert.equal(gauge.snapshot().active, 1);
  release();
  release(); // 重复调用不应把 active 减成负数
  assert.equal(gauge.snapshot().active, 0);
  const second = await gauge.acquireSlot();
  second();
  assert.equal(gauge.snapshot().active, 0);
});

test("模型闸：容量可由环境变量放宽，重置后生效", async () => {
  const original = process.env.MODEL_CONCURRENCY_PER_PROVIDER;
  try {
    process.env.MODEL_CONCURRENCY_PER_PROVIDER = "2";
    resetModelGates();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = runWithModelSlot("p-config", () => new Promise<void>((r) => { releaseA = r; }));
    const b = runWithModelSlot("p-config", () => new Promise<void>((r) => { releaseB = r; }));
    // run 先 await 取槽位，执行体在下一个微任务才跑，先让出一次事件循环
    await new Promise((r) => setTimeout(r, 20));
    // 容量 2：两个都能直接拿到，第三个进队列
    const third = runWithModelSlot("p-config", async () => "third");
    releaseA();
    releaseB();
    assert.equal(await a, undefined);
    assert.equal(await b, undefined);
    assert.equal(await third, "third", "排队者在前两个释放后应拿到槽位");
  } finally {
    if (original === undefined) delete process.env.MODEL_CONCURRENCY_PER_PROVIDER;
    else process.env.MODEL_CONCURRENCY_PER_PROVIDER = original;
    resetModelGates();
  }
});

test("模型闸：acquireModelSlot 与 run 共享同一供应商闸门", async () => {
  const original = process.env.MODEL_CONCURRENCY_PER_PROVIDER;
  try {
    process.env.MODEL_CONCURRENCY_PER_PROVIDER = "1";
    resetModelGates();
    const release = await acquireModelSlot("p-shared");
    let ranInside = false;
    const queued = runWithModelSlot("p-shared", async () => { ranInside = true; return "ok"; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ranInside, false, "槽位被 acquireModelSlot 占着时 run 必须排队");
    release();
    assert.equal(await queued, "ok");
    assert.equal(ranInside, true);
  } finally {
    if (original === undefined) delete process.env.MODEL_CONCURRENCY_PER_PROVIDER;
    else process.env.MODEL_CONCURRENCY_PER_PROVIDER = original;
    resetModelGates();
  }
});
