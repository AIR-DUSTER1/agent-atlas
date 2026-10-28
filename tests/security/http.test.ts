/**
 * tests/security/http.test.ts — HTTP 边界攻击面（全部离线）
 * ============================================================
 * 覆盖：跨站 Origin 拒绝、malformed JSON 400、超限请求体 413（丢弃式排水后
 * 客户端仍能拿到状态码）、认证 Bearer 校验、静态目录穿越拒绝。
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "../helpers/server.js";

let srv: RunningServer;
let authSrv: RunningServer;

before(async () => {
  srv = await startServer();
  authSrv = await startServer({ AUTH_TOKEN: "test-secret" });
});
after(async () => {
  await srv?.stop();
  await authSrv?.stop();
});

/** 裸 TCP：写入请求头（可声明超大 Content-Length）→ 读响应直到超时/EOF → 主动断开。
 *  不解析 chunked，只要拿到状态行与响应体片段即可断言。 */
function rawSocketStatus(base: string, requestText: string): Promise<string> {
  const url = new URL(base);
  return new Promise((resolvePromise, reject) => {
    const sock = connect(Number(url.port), url.hostname);
    let data = "";
    const finish = () => { sock.destroy(); resolvePromise(data); };
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      data += chunk;
      if (data.includes("请求体过大")) finish(); // 413 响应体已到齐，无需等连接关闭
    });
    sock.on("error", (err) => (data ? resolvePromise(data) : reject(err)));
    sock.on("close", finish);
    sock.setTimeout(5_000, finish);
    sock.write(requestText);
  });
}

/** node:http 原始请求：便于控制 Origin 头（fetch 会禁设 Origin）；
 *  agent:false 不复用 keep-alive 池，避免撞 server.keepAliveTimeout 造成假慢。 */
function rawPost(base: string, path: string, headers: Record<string, string | number>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    let received: import("node:http").IncomingMessage | null = null;
    const req = request(base + path, { method: "POST", agent: false, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      received = res;
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", (err) => {
      // 413 排水结束后服务端发 FIN；个别 Windows 场景客户端仍会先收到 RST。
      // 只要响应头已到达就按已收到处理（响应体的完整性由断言保证）。
      if (received) resolvePromise({ status: received.statusCode ?? 0, body: "" });
      else reject(err);
    });
    req.end(body);
  });
}

test("页面响应头不再放行任意 inline script", async () => {
  const res = await fetch(srv.base + "/");
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /script-src[^;]*'sha256-/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});
test("跨站 POST 被拒（Origin 非本机）", async () => {
  const res = await rawPost(srv.base, "/api/sessions", { Origin: "http://evil.example" }, JSON.stringify({ kind: "agent" }));
  assert.equal(res.status, 403);
});

test("malformed JSON → 400 中文错误", async () => {
  const res = await rawPost(srv.base, "/api/sessions", {}, "{ not json");
  assert.equal(res.status, 400);
  assert.match(res.body, /error/);
});

test("请求体超限 → 413（排水后客户端能拿到状态码）", async () => {
  // 用裸 TCP 测：声明 3MB 只发 1 字节，先读完响应再断开。
  // 不用 node:http 客户端 —— Windows loopback 上「服务端早回 413 + 请求体未读完」
  // 会让 http 客户端偶发 ECONNRESET（尚未读到响应头），curl/浏览器正常；
  // 裸 socket「先读响应后断开」才是这条路径的可靠验收方式（与 wiki 记录一致）。
  const raw = await rawSocketStatus(srv.base, [
    "POST /api/chat HTTP/1.1",
    `Host: ${new URL(srv.base).host}`,
    "Content-Type: application/json",
    "Content-Length: 3000000",
    "",
    "{",
  ].join("\r\n"));
  assert.match(raw, /^HTTP\/1\.1 413/);
  assert.match(raw, /请求体过大/);
});

test("探针免认证：开启 AUTH_TOKEN 后 /healthz 与 /readyz 仍可直接访问", async () => {
  for (const path of ["/healthz", "/readyz"]) {
    const res = await fetch(authSrv.base + path);
    assert.equal(res.status, 200, path);
    const body = await res.json() as { ok?: boolean };
    assert.equal(body.ok, true, path);
  }
});

test("认证开启：无 Bearer 401，正确 Bearer 放行", async () => {
  const noAuth = await fetch(authSrv.base + "/api/sessions");
  assert.equal(noAuth.status, 401);

  const ok = await fetch(authSrv.base + "/api/sessions", { headers: { Authorization: "Bearer test-secret" } });
  assert.equal(ok.status, 200);

  const wrong = await fetch(authSrv.base + "/api/sessions", { headers: { Authorization: "Bearer wrong" } });
  assert.equal(wrong.status, 401);
});

test("静态分发拒绝目录穿越、未知扩展与 vendor 探测", async () => {
  for (const path of [
    "/../.env",
    "/%2e%2e%2f%2e%2e%2fpackage.json",
    "/modules/../config-store.ts",
    "/modules/%2e%2e%2fsecret.js",
    "/vendor/../package.json",
    "/vendor/",
    "/vendor/chart-lib.js.map",
    "/vendor/unknown.txt",
    "/styles/unknown.css",
    "/views/unknown/index.js",
  ]) {
    const res = await fetch(srv.base + path);
    assert.notEqual(res.status, 200, path);
  }
});

test("会话登录 → Cookie 访问 → 续期 → 注销后旧 Cookie 失效", async () => {
  const login = await fetch(authSrv.base + "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-secret" }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /lg_agent_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0];

  const status = await fetch(authSrv.base + "/api/auth/session", { headers: { Cookie: cookie } });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { authenticated?: boolean }).authenticated, true);

  const sessions = await fetch(authSrv.base + "/api/sessions", { headers: { Cookie: cookie } });
  assert.equal(sessions.status, 200);

  const renew = await fetch(authSrv.base + "/api/auth/session/renew", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(renew.status, 200);
  const renewedCookie = (renew.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(renewedCookie, /lg_agent_session=/);

  const logout = await fetch(authSrv.base + "/api/auth/logout", {
    method: "POST",
    headers: { Cookie: renewedCookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);

  const replay = await fetch(authSrv.base + "/api/sessions", { headers: { Cookie: renewedCookie } });
  assert.equal(replay.status, 401, "注销后的 token 不能重放");
});

test("登录失败达到阈值返回 429，正确密钥也不能绕过冷却", async () => {
  const limited = await startServer({ AUTH_TOKEN: "rate-limit-secret" });
  try {
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(limited.base + "/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong" }),
      });
      assert.equal(res.status, 401, `第 ${i + 1} 次失败仍应可重试`);
    }
    const fifth = await fetch(limited.base + "/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    assert.equal(fifth.status, 429);
    assert.ok(Number(fifth.headers.get("retry-after")) > 0);

    const correctDuringCooldown = await fetch(limited.base + "/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "rate-limit-secret" }),
    });
    assert.equal(correctDuringCooldown.status, 429);
  } finally {
    await limited.stop();
  }
});
test("认证开启时 /metrics 与 /api/diagnostics 不可匿名读取", async () => {
  assert.equal((await fetch(authSrv.base + "/metrics")).status, 401);
  assert.equal((await fetch(authSrv.base + "/api/diagnostics")).status, 401);
});

test("METRICS_TOKEN 仅授权指标端点，不能调用控制面 API", async () => {
  const metricsSrv = await startServer({
    AUTH_TOKEN: "test-secret",
    METRICS_TOKEN: "metrics-scrape-token-123456",
  });
  try {
    const metrics = await fetch(metricsSrv.base + "/metrics", {
      headers: { Authorization: "Bearer metrics-scrape-token-123456" },
    });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /agent_http_inflight_requests|agent_process_uptime_seconds/);
    const diagnostics = await fetch(metricsSrv.base + "/api/diagnostics", {
      headers: { Authorization: "Bearer metrics-scrape-token-123456" },
    });
    assert.equal(diagnostics.status, 401);
  } finally {
    await metricsSrv.stop();
  }
});
