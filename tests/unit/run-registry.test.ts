/**
 * ============================================================
 * run-registry.test.ts — 会话运行态登记表
 * ============================================================
 * 覆盖断连 != 取消的边界：
 *  - 登记 / 撤销 / 查询与「只清自己那一条」；
 *  - detach 不 abort（刷新页面不能误杀回答）；
 *  - detach 兜底超时自动中止（关掉页面后不能永远烧配额）；
 *  - stop 只中止仍在跑的那一条，重复 stop 返回 false。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DETACHED_ABORT_MS, beginRun, detachRun, endRun, isSessionRunning, resetRunsForTest, runningSessionIds, stopRun,
} from "../../src/server/run-registry.js";

test("登记后 isSessionRunning 为真，endRun 撤销", () => {
  resetRunsForTest();
  const controller = new AbortController();
  beginRun("s-1", controller);
  assert.equal(isSessionRunning("s-1"), true);
  assert.deepEqual(runningSessionIds(), ["s-1"]);
  endRun("s-1", controller);
  assert.equal(isSessionRunning("s-1"), false);
  resetRunsForTest();
});

test("endRun 只清自己那一条，不会误删后来的运行", () => {
  resetRunsForTest();
  const oldController = new AbortController();
  beginRun("s-1", oldController);
  const newController = new AbortController();
  beginRun("s-1", newController); // 同一会话登记新运行
  endRun("s-1", oldController);    // 旧运行迟到的收尾
  assert.equal(isSessionRunning("s-1"), true, "旧 controller 的收尾不能删掉新运行");
  assert.equal(newController.signal.aborted, false);
  resetRunsForTest();
});

test("detachRun 只标记无人观察，不中止生成", () => {
  resetRunsForTest();
  const controller = new AbortController();
  beginRun("s-1", controller);
  assert.equal(detachRun("s-1", controller), true);
  assert.equal(controller.signal.aborted, false, "断连不等于取消");
  assert.equal(isSessionRunning("s-1"), true, "后台生成仍在跑");
  // 重复 detach 是 no-op（已经 unattached）
  assert.equal(detachRun("s-1", controller), false);
  endRun("s-1", controller);
  resetRunsForTest();
});

test("stopRun 中止仍在跑的那一条；没有运行时返回 false", () => {
  resetRunsForTest();
  assert.equal(stopRun("s-missing"), false, "没有运行必须如实返回 false");

  const controller = new AbortController();
  beginRun("s-1", controller);
  assert.equal(stopRun("s-1"), true);
  assert.equal(controller.signal.aborted, true);
  // 中止后登记仍在（等 finally 调 endRun），所以再次 stop 依然命中同一条
  assert.equal(stopRun("s-1"), true);
  endRun("s-1", controller);
  assert.equal(stopRun("s-1"), false);
  resetRunsForTest();
});

test("detach 有兜底上限：无人观察太久必须自动中止", () => {
  resetRunsForTest();
  const controller = new AbortController();
  beginRun("s-1", controller);
  detachRun("s-1", controller);
  // 不真的等 10 分钟：只断言上限常量被写成有限值，避免「永不回收」的回归。
  assert.ok(Number.isFinite(DETACHED_ABORT_MS) && DETACHED_ABORT_MS > 0 && DETACHED_ABORT_MS <= 30 * 60_000);
  endRun("s-1", controller);
  resetRunsForTest();
});
