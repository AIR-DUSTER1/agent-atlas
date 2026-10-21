/**
 * tests/unit/subprocess.test.ts — 受控子进程的超时与输出上限
 * ============================================================
 * 真起 node 子进程注入故障（不用 mock），验证 5.14「子进程超时」路径：
 * 超时会杀整棵进程树、输出超限保留头部并终止，且都不把异常抛给调用方。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runControlled } from "../../src/server/subprocess.js";

test("子进程超时：整棵进程树被杀，killedBy=timeout", async () => {
  const started = Date.now();
  const result = await runControlled(process.execPath, {
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 300,
  });
  assert.equal(result.killedBy, "timeout");
  assert.equal(result.code, -1);
  assert.match(result.stderr, /超过 300ms 被终止/);
  // Windows taskkill 有兜底 5s；这里留足余量但防止真挂死
  assert.ok(Date.now() - started < 10_000, "超时终止不应永久卡住");
});

test("子进程输出超限：保留已收头部并终止", async () => {
  const result = await runControlled(process.execPath, {
    args: ["-e", "process.stdout.write('x'.repeat(5000))"],
    timeoutMs: 10_000,
    stdoutMaxBytes: 1024,
  });
  assert.equal(result.killedBy, "output-limit");
  assert.ok(result.stdout.length <= 1024);
  assert.match(result.stderr, /输出超出上限被终止/);
});
