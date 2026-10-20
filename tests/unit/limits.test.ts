/**
 * tests/unit/limits.test.ts — 并发/节流闸（纯内存，无 IO）
 * ============================================================
 * 守三个语义：同会话唯一流（第二次申请必失败）、节流窗口（1.5s 内连发必失败）、
 * 资源桶（满即中文报错，异常路径也必须归还令牌）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireSessionSlot, assertChatInterval, limitInspect, runWithLimit } from "../../src/server/limits.js";

test("acquireSessionSlot：同会话唯一流，释放后可再申请", () => {
  const release = acquireSessionSlot("s-unit-1");
  assert.throws(() => acquireSessionSlot("s-unit-1"), /还在生成中/);
  release();
  const again = acquireSessionSlot("s-unit-1");
  again();
});

test("assertChatInterval：1.5s 内第二次抛错，窗口外放行", () => {
  assertChatInterval("s-unit-2");
  assert.throws(() => assertChatInterval("s-unit-2"), /发送太快/);
  // 直接把上次时间戳回拨到窗口之外（不改时钟，只验证窗口逻辑）
  const saved = Date.now;
  try {
    Date.now = () => saved() + 10_000;
    assert.doesNotThrow(() => assertChatInterval("s-unit-2"));
  } finally {
    Date.now = saved;
  }
});

test("runWithLimit：满桶抛中文错误，结束后占用归零", async () => {
  let releaseA: (() => void) | null = null;
  const a = runWithLimit("k-unit", 1, () => new Promise<void>((r) => (releaseA = r)));
  await Promise.resolve();
  assert.equal(limitInspect("k-unit"), 1);
  await assert.rejects(runWithLimit("k-unit", 1, async () => 1), /并发已达上限/);
  releaseA!();
  await a;
  assert.equal(limitInspect("k-unit"), 0);
  assert.equal(await runWithLimit("k-unit", 1, async () => 42), 42);
});

test("runWithLimit：fn 抛错也归还令牌", async () => {
  await assert.rejects(
    runWithLimit("k-unit-err", 1, async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(limitInspect("k-unit-err"), 0);
});
