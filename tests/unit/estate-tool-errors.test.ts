/**
 * estate-tool-errors.test.ts — 贝壳业务失败不能伪装成成功
 * ============================================================
 * 守：CLI exit 0 但 JSON 顶层 ok:false/error 时，必须识别为业务失败。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertTrustedInstallUrl, beikeBusinessError, isBeikeAuthFailure } from "../../src/server/estate.js";
import { beikeCallbackRelayHtml } from "../../src/server/estate-login-browser.js";
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

test("贝壳 CLI 查询串行限速，认证失败后熔断冷却", async () => {
  const source = await readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8");
  assert.match(source, /BEIKE_CLI_CONCURRENCY = 1/);
  assert.match(source, /BEIKE_CLI_MIN_INTERVAL_MS = 1_500/);
  assert.match(source, /BEIKE_BREAKER_FAILURES = 2/);
  assert.match(source, /BEIKE_BREAKER_COOLDOWN_MS = 60_000/);
  assert.match(source, /runBeikeThrottled\(/);
  assert.match(source, /!beikeCredentialVerified\) return/);
  assert.match(source, /beikeCredentialVerified = true/);
});

test("贝壳受控登录回调页只在同源 opener 间转发一次性票据", () => {
  const html = beikeCallbackRelayHtml();
  assert.match(html, /type: "alps-state"/);
  assert.match(html, /type: "cas-ticket"/);
  assert.match(html, /location\.origin/);
  assert.match(html, /window\.close/);
  assert.doesNotMatch(html, /bear_key|localStorage|sessionStorage/);
});

test("贝壳受控登录窗口已接入服务端、设置页和登录卡", async () => {
  const [estate, browserLogin, client, html] = await Promise.all([
    readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/server/estate-login-browser.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/client/views/estate.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/client/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(estate, /loginBeikeInManagedBrowser\(saveBeikeKey\)/);
  assert.match(estate, /beike\.loginManaged/);
  assert.doesNotMatch(estate, /openExternalUrl/);
  assert.match(browserLogin, /context\.route\(BEIKE_CALLBACK_ROUTE/);
  assert.match(browserLogin, /localStorage\.getItem\("bk_bearer_key"\)/);
  assert.match(browserLogin, /headless: options\.headless === true/);
  assert.match(client, /打开受控登录窗口/);
  assert.match(html, /登录窗口由 agentatlas 托管/);
  assert.doesNotMatch(html, /estate-login-recover/);
});

test("认证门禁只准备登录链接，手动入口启动受控登录", async () => {
  const source = await readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8");
  const start = source.slice(
    source.indexOf("export function startBeikeLogin"),
    source.indexOf("async function activateBeikeLoginGate"),
  );
  assert.match(source, /startBeikeLogin\(\{ open: false \}\)/);
  assert.match(source, /beike\.loginUrlPrepared/);
  assert.match(start, /const url = BEIKE_KEY_URL/);
  assert.match(start, /loginBeikeInManagedBrowser\(saveBeikeKey\)/);
  assert.doesNotMatch(start, /openExternalUrl|\["login"\]/);
  assert.doesNotMatch(source, /已自动打开浏览器登录页/);
});

test("Windows 安装器使用官方 manifest 的 windows 平台键", async () => {
  const source = await readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8");
  assert.match(source, /pickLatestBinary\("windows", "amd64"\)/);
  assert.doesNotMatch(source, /pickLatestBinary\("win32", "x64"\)/);
  assert.doesNotMatch(source, /pickLatestBinary\("windows", "x64"\)/);
});

test("保存 Key 的失败原因完整展示，不回退成未知错误", async () => {
  const [client, route] = await Promise.all([
    readFile(new URL("../../src/client/views/estate.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/server/routes/estate.ts", import.meta.url), "utf8"),
  ]);
  assert.match(client, /message\?: string; error\?: string/);
  assert.match(client, /res\.message \|\| res\.error/);
  assert.match(route, /error: r\.message/);
  const estate = await readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8");
  assert.match(estate, /previousKey = await fsp\.readFile/);
  assert.match(estate, /fsp\.writeFile\(BEIKE_CRED_FILE, previousKey/);
});

test("外链打开器拒绝非白名单协议与域名", () => {
  const allow = new Set(["building.ke.com"]);
  assert.equal(assertAllowedExternalUrl("https://building.ke.com/login", allow).hostname, "building.ke.com");
  assert.equal(assertTrustedInstallUrl("https://release-assets.githubusercontent.com/asset?signature=x", "二进制下载地址"), undefined);
  assert.throws(() => assertAllowedExternalUrl("http://building.ke.com/login", allow), /HTTPS/);
  assert.throws(() => assertAllowedExternalUrl("https://evil.example/login", allow), /白名单/);
});
