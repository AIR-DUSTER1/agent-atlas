/**
 * estate-tool-errors.test.ts — 贝壳业务失败不能伪装成成功
 * ============================================================
 * 守：CLI exit 0 但 JSON 顶层 ok:false/error 时，必须识别为业务失败。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { beikeBusinessError, extractBeikeLoginUrl, isBeikeAuthFailure } from "../../src/server/estate.js";
import { assertAllowedExternalUrl } from "../../src/server/external-open.js";

test("贝壳 JSON 业务失败识别：ok:false / error 字符串", () => {
  assert.equal(
    beikeBusinessError({ error: "Unknown tool: 'rent_market_search'", ok: false }),
    "Unknown tool: 'rent_market_search'",
  );
  assert.equal(beikeBusinessError({ error: "参数不完整" }), "参数不完整");
  assert.equal(beikeBusinessError({ ok: true, data: "正常结果" }), null);
  assert.equal(beikeBusinessError("<参考数据>"), null);
});

test("贝壳登录失效识别：覆盖当前 CLI 与常见 401 文案", () => {
  assert.equal(isBeikeAuthFailure(JSON.stringify({ error: "invalid cli request", ok: false })), true);
  assert.equal(isBeikeAuthFailure("Invalid or missing Authorization header"), true);
  assert.equal(isBeikeAuthFailure("HTTP 401 Unauthorized"), true);
  assert.equal(isBeikeAuthFailure("Bearer Key 无效或已过期"), true);
  assert.equal(isBeikeAuthFailure("请先登录后重试"), true);
  assert.equal(isBeikeAuthFailure("参数不完整"), false);
  assert.equal(isBeikeAuthFailure("Unknown tool: rent_market_search"), false);
});

test("贝壳登录链接提取：只接受 building.ke.com HTTPS", () => {
  assert.equal(
    extractBeikeLoginUrl("请打开 https://building.ke.com/?action=get-key&source=beike_skill。"),
    "https://building.ke.com/?action=get-key&source=beike_skill",
  );
  assert.equal(extractBeikeLoginUrl("https://building.ke.com.evil.example/?action=get-key"), null);
  assert.equal(extractBeikeLoginUrl("http://building.ke.com/?action=get-key"), null);
});

test("贝壳 CLI 串行限速，认证失败后熔断冷却", async () => {
  const source = await readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8");
  assert.match(source, /BEIKE_CLI_CONCURRENCY = 1/);
  assert.match(source, /BEIKE_CLI_MIN_INTERVAL_MS = 1_500/);
  assert.match(source, /BEIKE_BREAKER_FAILURES = 2/);
  assert.match(source, /BEIKE_BREAKER_COOLDOWN_MS = 60_000/);
  assert.match(source, /BEIKE_LOGIN_COOLDOWN_MS = 60_000/);
  assert.match(source, /runBeikeThrottled\(/);
  assert.match(source, /!beikeCredentialVerified\) return/);
  assert.match(source, /beikeCredentialVerified = true/);
});

test("认证门禁只准备登录链接，手动入口才打开浏览器", async () => {
  const source = await readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8");
  assert.match(source, /startBeikeLogin\(\{ open: false \}\)/);
  assert.match(source, /options\.open !== false/);
  assert.match(source, /beike\.loginUrlPrepared/);
  assert.doesNotMatch(source, /已自动打开浏览器登录页/);
});

test("外链打开器拒绝非白名单协议与域名", () => {
  const allow = new Set(["building.ke.com"]);
  assert.equal(assertAllowedExternalUrl("https://building.ke.com/login", allow).hostname, "building.ke.com");
  assert.throws(() => assertAllowedExternalUrl("http://building.ke.com/login", allow), /HTTPS/);
  assert.throws(() => assertAllowedExternalUrl("https://evil.example/login", allow), /白名单/);
});
