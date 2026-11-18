/** auth-session.test.ts — 会话 Cookie、注销重放与失败限流 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  clearSessionCookie, clearSessionCookieOnResponse, issueSession, parseCookies,
  resetSessionSecurityForTests, revokeSession, sessionCookie, sessionFromRequest,
  sessionTtlHours, setSessionCookie, verifySessionRequest, verifySessionToken,
} from "../../src/server/security/session.js";
import { FailureRateLimiter, clientIp } from "../../src/server/security/rate-limit.js";
import {
  deviceCookie, ensureDeviceIdentity, ensureDeviceSession, hasAuthorizedDeviceSession,
  isDirectLoopbackRequest, issueDeviceIdentity, verifyDeviceToken, deviceFromRequest, ownerIdentityForRequest,
  deviceIdentityForRequest, isAdminRequest, adoptBearerIdentity, requireOwnerIdentity, requireDeviceIdentity,
  renewDeviceCookie, enrollDeviceIdentity, clearDeviceCookieOnResponse, deviceTtlDays,
} from "../../src/server/security/device.js";

test("HMAC 会话可校验；篡改与过期均失败", () => {
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  process.env.SESSION_TTL_HOURS = "12";
  try {
    resetSessionSecurityForTests();
    const now = Date.now();
    const { token, payload } = issueSession(now);
    assert.equal(verifySessionToken(token, now + 1)?.sid, payload.sid);
    assert.equal(verifySessionToken(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"), now + 1), null);
    assert.equal(verifySessionToken(token, payload.exp + 1), null);
  } finally {
    delete process.env.SESSION_SECRET;
    delete process.env.SESSION_TTL_HOURS;
    resetSessionSecurityForTests();
  }
});

test("注销撤销 sid，旧 token 不能重放", () => {
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  try {
    resetSessionSecurityForTests();
    const now = Date.now();
    const { token, payload } = issueSession(now);
    revokeSession(token, now + 1);
    assert.equal(verifySessionToken(token, now + 2), null);
    const renewed = issueSession(now + 2, payload.sid);
    assert.equal(verifySessionToken(renewed.token, now + 3), null, "同 sid 续期也不能绕过注销");
  } finally {
    delete process.env.SESSION_SECRET;
    resetSessionSecurityForTests();
  }
});

test("生产 Cookie 带 Secure / HttpOnly / SameSite=Strict", () => {
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  try {
    const cookie = sessionCookie("signed-token", { PRODUCTION: "1", COOKIE_SECURE: "true" });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=/);
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

test("失败限流：单 IP 5 次达到冷却，窗口过期自动恢复", () => {
  const limiter = new FailureRateLimiter(5, 100, 60_000);
  const now = 1_000_000;
  for (let i = 0; i < 4; i += 1) {
    assert.equal(limiter.recordFailure("1.2.3.4", now + i).allowed, true);
  }
  const blocked = limiter.recordFailure("1.2.3.4", now + 5);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(limiter.check("1.2.3.4", now + 60_010).allowed, true);
  assert.equal(limiter.check("5.6.7.8", now + 60_010).allowed, true);
});

test("失败限流：全局 100 次同样阻断所有 IP", () => {
  const limiter = new FailureRateLimiter(5, 100, 60_000);
  for (let i = 0; i < 100; i += 1) limiter.recordFailure(`ip-${i % 20}`, 1_000_000 + i);
  assert.equal(limiter.check("new-ip", 1_000_100).allowed, false);
});

function fakeRequest(options: {
  cookie?: string;
  forwarded?: string | string[];
  remote?: string;
  authorization?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string | string[]> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.forwarded) headers["x-forwarded-for"] = options.forwarded;
  if (options.authorization) headers.authorization = options.authorization;
  return {
    headers,
    socket: { remoteAddress: options.remote ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

test("TTL 默认值、非法值与上下界稳定", () => {
  const env = process.env;
  try {
    delete env.SESSION_TTL_HOURS;
    assert.equal(sessionTtlHours(), 12);
    env.SESSION_TTL_HOURS = "not-a-number";
    assert.equal(sessionTtlHours(), 12);
    env.SESSION_TTL_HOURS = "0.5";
    assert.equal(sessionTtlHours(), 1);
    env.SESSION_TTL_HOURS = "99999";
    assert.equal(sessionTtlHours(), 24 * 30);
  } finally {
    delete env.SESSION_TTL_HOURS;
  }
});

test("Cookie 解析拒绝畸形段、保留首值并兼容非法编码", () => {
  const parsed = parseCookies("a=1; broken; =bad; a=2; c=%E4%B8%AD; d=%E0%A4%A");
  assert.equal(parsed.a, "1");
  assert.equal(parsed.c, "中");
  assert.equal(parsed.d, "%E0%A4%A");
  assert.equal(parsed.broken, undefined);
  assert.equal(parseCookies(undefined).a, undefined);
});

test("请求 Cookie 与签名校验共享同一条路径", () => {
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  try {
    resetSessionSecurityForTests();
    const now = Date.now();
    const { token } = issueSession(now);
    const req = fakeRequest({ cookie: `other=x; lg_agent_session=${encodeURIComponent(token)}` });
    assert.equal(sessionFromRequest(req), token);
    assert.ok(verifySessionRequest(req, now + 1));
    assert.equal(verifySessionRequest(fakeRequest(), now), null);
    assert.equal(verifySessionToken("missing-dot", now), null);
    assert.equal(verifySessionToken("a.b.c", now), null);
    revokeSession(null);
    revokeSession("not-valid");
  } finally {
    delete process.env.SESSION_SECRET;
    resetSessionSecurityForTests();
  }
});

test("开发模式使用进程内兜底签名；未来签发时间视为伪造", () => {
  const now = Date.now();
  delete process.env.SESSION_SECRET;
  delete process.env.AUTH_TOKEN;
  resetSessionSecurityForTests();
  const dev = issueSession(now);
  assert.ok(verifySessionToken(dev.token, now + 1));

  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  try {
    const future = issueSession(now + 120_000);
    assert.equal(verifySessionToken(future.token, now), null);
  } finally {
    delete process.env.SESSION_SECRET;
    resetSessionSecurityForTests();
  }
});

test("Set-Cookie 写入与清除保持 HttpOnly / SameSite=Strict", () => {
  const headers: Record<string, string | number | readonly string[]> = {};
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as ServerResponse;
  process.env.SESSION_TTL_HOURS = "2";
  try {
    setSessionCookie(res, "token with spaces");
    assert.match(String(headers["set-cookie"]), /HttpOnly/);
    assert.match(String(headers["set-cookie"]), /SameSite=Strict/);
    assert.match(String(headers["set-cookie"]), /Max-Age=7200/);
    clearSessionCookieOnResponse(res);
    assert.match(String(headers["set-cookie"]), /Max-Age=0/);
    assert.match(clearSessionCookie({ COOKIE_SECURE: "true" }), /Secure/);
  } finally {
    delete process.env.SESSION_TTL_HOURS;
  }
});

test("代理 IP：默认不信任伪造头，显式 TRUST_PROXY 才取首跳", () => {
  const direct = fakeRequest({ forwarded: "203.0.113.9, 10.0.0.2", remote: "127.0.0.1" });
  delete process.env.TRUST_PROXY;
  assert.equal(clientIp(direct), "127.0.0.1");
  process.env.TRUST_PROXY = "1";
  try {
    assert.equal(clientIp(direct), "203.0.113.9");
    assert.equal(clientIp(fakeRequest({ forwarded: ["198.51.100.2, 10.0.0.2"], remote: "127.0.0.1" })), "198.51.100.2");
    assert.equal(clientIp(fakeRequest({ remote: "127.0.0.2" })), "127.0.0.2");
  } finally {
    delete process.env.TRUST_PROXY;
  }
});

test("限流 clear/reset 清除单 IP 与全局桶，剩余次数可见", () => {
  const limiter = new FailureRateLimiter(3, 4, 60_000);
  assert.equal(limiter.recordFailure("a", 1000).remainingIp, 2);
  limiter.clear("a");
  assert.equal(limiter.check("a", 1001).remainingIp, 3);
  limiter.recordFailure("a", 1002);
  limiter.recordFailure("b", 1003);
  limiter.reset();
  const decision = limiter.check("c", 1004);
  assert.equal(decision.allowed, true);
  assert.equal(decision.remainingIp, 3);
  assert.equal(decision.remainingGlobal, 4);
});


test("设备身份 HMAC 可校验；篡改、过期与生产 Cookie 属性正确", () => {
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  process.env.DEVICE_TTL_DAYS = "90";
  try {
    const now = Date.now();
    const issued = issueDeviceIdentity(now);
    assert.equal(verifyDeviceToken(issued.token, now + 1)?.did, issued.payload.did);
    assert.equal(verifyDeviceToken(issued.token.slice(0, -1) + (issued.token.endsWith("a") ? "b" : "a"), now + 1), null);
    assert.equal(verifyDeviceToken(issued.token, issued.payload.exp + 1), null);
    const cookie = deviceCookie(issued.token, { PRODUCTION: "1", COOKIE_SECURE: "true" });
    assert.match(cookie, /lg_agent_device=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=7776000/);
  } finally {
    delete process.env.SESSION_SECRET;
    delete process.env.DEVICE_TTL_DAYS;
  }
});

function fakeResponse(): import("node:http").ServerResponse {
  const headers = new Map<string, string | number | readonly string[]>();
  return {
    setHeader(name: string, value: string | number | readonly string[]) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
  } as unknown as import("node:http").ServerResponse;
}

test("本机直连才自动信任，代理转发头会强制按远端设备处理", () => {
  process.env.AUTH_TOKEN = "auth-token-for-device-test";
  try {
    const localRes = fakeResponse();
    const local = fakeRequest();
    assert.equal(isDirectLoopbackRequest(local), true);
    assert.equal(ensureDeviceIdentity(local, localRes), "local");
    assert.equal(localRes.getHeader("set-cookie"), undefined);

    const proxied = fakeRequest({ forwarded: "198.51.100.8, 127.0.0.1" });
    assert.equal(isDirectLoopbackRequest(proxied), false);
    assert.equal(ensureDeviceIdentity(proxied, fakeResponse()), null);
  } finally {
    delete process.env.AUTH_TOKEN;
  }
});

test("可信本机设备在业务入口直接获得短期会话，不先制造 401", () => {
  process.env.AUTH_TOKEN = "auth-token-for-device-test";
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  try {
    const req = fakeRequest();
    const res = fakeResponse();
    assert.equal(ensureDeviceSession(req, res), "local");
    assert.equal(hasAuthorizedDeviceSession(req), true);
    assert.match(String(res.getHeader("set-cookie")), /lg_agent_session=/);
  } finally {
    delete process.env.AUTH_TOKEN;
    delete process.env.SESSION_SECRET;
  }
});

test("认证关闭时远端设备自动获得签名设备 Cookie", () => {
  delete process.env.AUTH_TOKEN;
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  try {
    const res = fakeResponse();
    const deviceId = ensureDeviceIdentity(fakeRequest({ remote: "198.51.100.9" }), res);
    assert.ok(deviceId && deviceId !== "local");
    assert.match(String(res.getHeader("set-cookie")), /lg_agent_device=/);
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

test("设备 Cookie 解析、owner 映射、Bearer 与续期写入完整路径", () => {
  process.env.SESSION_SECRET = "session-secret-for-test-at-least-32-chars";
  process.env.AUTH_TOKEN = "device-route-token-at-least-32-chars";
  try {
    const issued = issueDeviceIdentity(Date.now(), "device-owner-a", { ownerId: "owner-a", role: "member" });
    const cookie = deviceCookie(issued.token).split(";")[0];
    const req = fakeRequest({ cookie, remote: "198.51.100.20" });
    const res = fakeResponse();
    assert.equal(deviceFromRequest(req)?.did, "device-owner-a");
    assert.equal(ensureDeviceIdentity(req, res), "device-owner-a");
    assert.deepEqual(ownerIdentityForRequest(req), { ownerId: "owner-a", deviceId: "device-owner-a", role: "member" });
    assert.equal(deviceIdentityForRequest(req), "device-owner-a");
    assert.equal(isAdminRequest(req), false);
    assert.deepEqual(requireOwnerIdentity(req, res), { ownerId: "owner-a", deviceId: "device-owner-a", role: "member" });
    assert.equal(requireDeviceIdentity(req, res), "owner-a");

    const bearer = fakeRequest({ authorization: "Bearer legacy-bearer-token" });
    const bearerRes = fakeResponse();
    assert.equal(adoptBearerIdentity(bearer, bearerRes), `api-${createHash("sha256").update("legacy-bearer-token").digest("hex").slice(0, 32)}`);
    renewDeviceCookie(bearerRes, "device-renewed");
    renewDeviceCookie(bearerRes, "device-renewed");
    assert.match(String(bearerRes.getHeader("set-cookie")), /lg_agent_device=/);
  } finally {
    delete process.env.SESSION_SECRET;
    delete process.env.AUTH_TOKEN;
  }
});

test("设备 TTL 边界与敏感文件权限收紧可重复执行", async () => {
  process.env.DEVICE_TTL_DAYS = "9999";
  try {
    assert.equal(deviceTtlDays(), 365);
  } finally {
    delete process.env.DEVICE_TTL_DAYS;
  }
  process.env.DEVICE_TTL_DAYS = "0";
  try {
    assert.equal(deviceTtlDays(), 180);
  } finally {
    delete process.env.DEVICE_TTL_DAYS;
  }

  const dir = await mkdtemp(join(tmpdir(), "agent-permissions-"));
  const file = join(dir, "secret.txt");
  try {
    await writeFile(file, "secret", "utf8");
    const { secureFilePermissions } = await import("../../src/server/security/file-permissions.js");
    await secureFilePermissions(file);
    await secureFilePermissions(file);
    await secureFilePermissions(dir, true);
    await secureFilePermissions(join(dir, "missing.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("设备注册与注销 Cookie 清理使用可验证的设备身份", () => {
  const res = fakeResponse();
  const deviceId = enrollDeviceIdentity(res);
  assert.ok(deviceId);
  const cookie = String(res.getHeader("set-cookie"));
  assert.match(cookie, /lg_agent_device=/);
  clearDeviceCookieOnResponse(res);
  assert.match(String(res.getHeader("set-cookie")), /Max-Age=0/);
});
