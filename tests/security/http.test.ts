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

test("认证开启：无 Bearer 401，正确 Bearer 放行", async () => {
  const noAuth = await fetch(authSrv.base + "/api/sessions");
  assert.equal(noAuth.status, 401);

  const ok = await fetch(authSrv.base + "/api/sessions", { headers: { Authorization: "Bearer test-secret" } });
  assert.equal(ok.status, 200);

  const wrong = await fetch(authSrv.base + "/api/sessions", { headers: { Authorization: "Bearer wrong" } });
  assert.equal(wrong.status, 401);
});

test("静态分发拒绝目录穿越（明文/编码）", async () => {
  for (const path of ["/../.env", "/%2e%2e%2f%2e%2e%2fpackage.json", "/modules/../config-store.ts", "/modules/%2e%2e%2fsecret.js"]) {
    const res = await fetch(srv.base + path);
    assert.notEqual(res.status, 200, path);
  }
});
