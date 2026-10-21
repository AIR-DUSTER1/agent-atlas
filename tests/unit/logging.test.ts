/**
 * tests/unit/logging.test.ts — 结构化日志的纯函数边界（离线）
 * ============================================================
 * 覆盖：固定字段不可被业务覆盖、密钥打码、长文本/数组截断、LOG_LEVEL 阈值。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLogLine, isLevelEnabled, newRequestId, redact } from "../../src/server/logging.js";

test("buildLogLine：固定字段在后，业务字段不能覆盖 time/level/event", () => {
  const line = buildLogLine(
    "info",
    "http_request",
    { requestId: "r1", status: 200, durationMs: 12, event: "fake", level: "error" },
    new Date("2026-01-02T03:04:05.000Z")
  );
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed.time, "2026-01-02T03:04:05.000Z");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.event, "http_request");
  assert.equal(parsed.status, 200);
  assert.equal(parsed.requestId, "r1");
});

test("redact：敏感字段打码、正常指标保留、长文本与数组截断", () => {
  const out = redact({
    apiKey: "sk-secret",
    Authorization: "Bearer x",
    nested: { password: "p", inputTokens: 12 },
    long: "a".repeat(400),
    arr: Array.from({ length: 60 }, (_, i) => i),
  }) as {
    apiKey: string; Authorization: string; nested: { password: string; inputTokens: number };
    long: string; arr: unknown[];
  };

  assert.equal(out.apiKey, "***");
  assert.equal(out.Authorization, "***");
  assert.equal(out.nested.password, "***");
  assert.equal(out.nested.inputTokens, 12);
  assert.match(out.long, /^a{300}…\(共 400 字符\)$/);
  assert.equal(out.arr.length, 51);
  assert.match(String(out.arr.at(-1)), /共 60 项/);
});

test("redact：循环引用在深度上限截断，不会栈溢出", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic.self = cyclic;
  const out = JSON.stringify(redact(cyclic));
  assert.match(out, /depth-limit/);
});

test("LOG_LEVEL 阈值：warn 隐藏 info，silent 隐藏 error，非法值回退 info", () => {
  const previous = process.env.LOG_LEVEL;
  try {
    process.env.LOG_LEVEL = "warn";
    assert.equal(isLevelEnabled("info"), false);
    assert.equal(isLevelEnabled("warn"), true);
    process.env.LOG_LEVEL = "silent";
    assert.equal(isLevelEnabled("error"), false);
    process.env.LOG_LEVEL = "verbose";
    assert.equal(isLevelEnabled("info"), true);
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});

test("newRequestId：每次生成唯一 UUID", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});
