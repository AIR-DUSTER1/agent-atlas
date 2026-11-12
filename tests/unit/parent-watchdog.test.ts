/**
 * parent-watchdog.test.ts — 桌面端父进程退出联动
 * ============================================================
 * 守卫 Electron 主进程消失后 Web 服务必须自动走退出链路；
 * 同时确认 stop 幂等，避免服务正常关闭后看门狗仍然触发。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isProcessAlive, startParentWatchdog } from "../../src/server/parent-watchdog.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("父进程消失后只触发一次退出回调", async () => {
  let calls = 0;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("看门狗未在期限内触发")), 500);
    startParentWatchdog({
      parentPid: 42,
      intervalMs: 50,
      isAlive: () => false,
      onParentGone: () => {
        calls += 1;
        clearTimeout(timeout);
        setTimeout(resolve, 70);
      },
    });
  });
  assert.equal(calls, 1);
});

test("父进程存活时不触发；stop 后也不再检查", async () => {
  let calls = 0;
  const stop = startParentWatchdog({
    parentPid: 42,
    intervalMs: 50,
    isAlive: () => false,
    onParentGone: () => { calls += 1; },
  });
  stop();
  stop();
  await delay(120);
  assert.equal(calls, 0);
});

test("进程存活探测：当前进程为真，非法 PID 为假", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});
