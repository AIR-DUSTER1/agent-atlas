/**
 * estate-tool-errors.test.ts — 贝壳业务失败不能伪装成成功
 * ============================================================
 * 守：CLI exit 0 但 JSON 顶层 ok:false/error 时，必须识别为业务失败。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertTrustedInstallUrl, beikeBusinessError, isBeikeAuthFailure, probeBeikeMcpKey } from "../../src/server/estate.js";
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

test("贝壳 Key 在 CLI doctor 误报时由 MCP tools/list 复验", async () => {
  const originalFetch = globalThis.fetch;
  const headers = new Headers();
  let method = "";
  try {
    globalThis.fetch = (async (_input, init) => {
      const sent = new Headers(init?.headers);
      sent.forEach((value, key) => headers.set(key, value));
      method = String((JSON.parse(String(init?.body || "{}")) as { method?: string }).method || "");
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"house_search"}]}}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    assert.equal(await probeBeikeMcpKey("test-key", "v0.2.28"), true);
    assert.equal(headers.get("authorization"), "Bearer test-key");
    assert.equal(headers.get("x-beike-cli-version"), "0.2.28");
    assert.equal(headers.get("user-agent"), "beike-cli/0.2.28");
    assert.match(headers.get("x-beike-session-id") || "", /^[0-9a-f-]{36}$/);
    assert.equal(method, "tools/list");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP initialize 成功不再被误判为业务 Key 有效", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"布丁MCP服务"}}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;
    assert.equal(await probeBeikeMcpKey("source-mismatched-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("贝壳登录只使用系统浏览器且一次点击只打开一次", async () => {
  const [source, client, html] = await Promise.all([
    readFile(new URL("../../src/server/estate.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/client/views/estate.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/client/index.html", import.meta.url), "utf8"),
  ]);
  const start = source.slice(
    source.indexOf("export function startBeikeLogin"),
    source.indexOf("async function activateBeikeLoginGate"),
  );
  assert.match(source, /startBeikeLogin\(\{ open: false \}\)/);
  assert.match(source, /beike\.loginUrlPrepared/);
  assert.match(start, /const url = BEIKE_KEY_URL/);
  assert.equal((start.match(/openExternalUrl\(/g) || []).length, 1);
  assert.doesNotMatch(start, /\["login"\]|playwright-core|loginBeikeInManagedBrowser/);
  assert.match(source, /BEIKE_LOGIN_SOURCE = "agentatlas"/);
  assert.match(source, /BEIKE_SOURCE: BEIKE_LOGIN_SOURCE/);
  assert.doesNotMatch(source, /beike_skill/);
  assert.match(client, /source=agentatlas/);
  assert.match(client, /status\.textContent = "🔐 需要登录"/);
  assert.match(client, /navigator\.clipboard.*readText/);
  assert.match(client, /pasteEstateKeyFromClipboard/);
  assert.match(client, /从剪贴板读取/);
  assert.match(html, /source=agentatlas/);
  assert.match(html, /estate-key-paste/);
  assert.match(html, /页面显示的是掩码/);
  assert.match(source, /检测到的是页面掩码/);
  assert.doesNotMatch(html, /登录窗口由 agentatlas 托管|estate-login-recover/);
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
  assert.match(estate, /probeBeikeMcpKey\(key, found\.version\)/);
  assert.match(estate, /method: "tools\/list"/);
  assert.match(estate, /来源或会话可能不匹配/);
  assert.match(estate, /beike\.keyValidated/);
});

test("外链打开器拒绝非白名单协议与域名", () => {
  const allow = new Set(["building.ke.com"]);
  assert.equal(assertAllowedExternalUrl("https://building.ke.com/login", allow).hostname, "building.ke.com");
  assert.equal(assertTrustedInstallUrl("https://release-assets.githubusercontent.com/asset?signature=x", "二进制下载地址"), undefined);
  assert.throws(() => assertAllowedExternalUrl("http://building.ke.com/login", allow), /HTTPS/);
  assert.throws(() => assertAllowedExternalUrl("https://evil.example/login", allow), /白名单/);
});
