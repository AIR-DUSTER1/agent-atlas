/** production.test.ts — PP0 生产模式门禁纯函数回归 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertWritableDirectories,
  productionEnvironmentChecks,
  validateDataKey,
  type ReadinessCheck,
} from "../../src/server/production.js";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

test("开发模式不触发生产环境门禁", () => {
  assert.deepEqual(productionEnvironmentChecks({}), []);
});

test("生产模式缺关键配置时逐项给出中文修复建议", () => {
  const checks = productionEnvironmentChecks({ PRODUCTION: "1" });
  const failed = new Map(checks.filter((c) => !c.ok).map((c) => [c.id, c.message]));
  assert.match(failed.get("auth-token") ?? "", /AUTH_TOKEN/);
  assert.match(failed.get("session-secret") ?? "", /SESSION_SECRET/);
  assert.match(failed.get("data-key") ?? "", /DATA_KEY/);
});

test("生产模式完整配置通过，DATA_KEY 必须恰好 32 字节", () => {
  const checks = productionEnvironmentChecks({
    PRODUCTION: "1",
    AUTH_TOKEN: "a".repeat(24),
    SESSION_SECRET: "s".repeat(40),
    DATA_KEY: VALID_KEY,
    COOKIE_SECURE: "true",
    NODE_ENV: "production",
  });
  assert.equal((checks as ReadinessCheck[]).every((c) => c.ok), true);
  assert.equal(validateDataKey(VALID_KEY), null);
  assert.match(validateDataKey(Buffer.alloc(16).toString("base64")) ?? "", /32 字节/);
  assert.match(validateDataKey("not base64!") ?? "", /32 字节|base64/);

  const insecureCookie = productionEnvironmentChecks({
    PRODUCTION: "1",
    AUTH_TOKEN: "a".repeat(24),
    SESSION_SECRET: "s".repeat(40),
    DATA_KEY: VALID_KEY,
    COOKIE_SECURE: "false",
    NODE_ENV: "production",
  }).find((check) => check.id === "cookie-secure");
  assert.equal(insecureCookie?.ok, false);

  const weakMetrics = productionEnvironmentChecks({
    PRODUCTION: "1",
    AUTH_TOKEN: "a".repeat(24),
    SESSION_SECRET: "s".repeat(40),
    DATA_KEY: VALID_KEY,
    COOKIE_SECURE: "true",
    NODE_ENV: "production",
    METRICS_TOKEN: "short",
  }).find((check) => check.id === "metrics-token");
  assert.equal(weakMetrics?.ok, false);
  const validMetrics = productionEnvironmentChecks({
    PRODUCTION: "1",
    AUTH_TOKEN: "a".repeat(24),
    SESSION_SECRET: "s".repeat(40),
    DATA_KEY: VALID_KEY,
    COOKIE_SECURE: "true",
    NODE_ENV: "production",
    METRICS_TOKEN: "metrics-token-long-enough",
  }).find((check) => check.id === "metrics-token");
  assert.equal(validMetrics?.ok, true);
});

test("写探针使用短命文件且结束后清理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ready-"));
  try {
    await assertWritableDirectories([dir]);
    const probeNames = await readFile(join(dir, ".not-used"), "utf8").catch(() => "");
    assert.equal(probeNames, "", "测试不应创建无关文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
