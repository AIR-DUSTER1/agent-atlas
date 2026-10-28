/** auth-session.test.ts — 会话 Cookie、注销重放与失败限流 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  clearSessionCookie, clearSessionCookieOnResponse, issueSession, parseCookies,
  resetSessionSecurityForTests, revokeSession, sessionCookie, sessionFromRequest,
  sessionTtlHours, setSessionCookie, verifySessionRequest, verifySessionToken,
} from "../../src/server/security/session.js";
import { FailureRateLimiter, clientIp } from "../../src/server/security/rate-limit.js";

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
} = {}): IncomingMessage {
  const headers: Record<string, string | string[]> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.forwarded) headers["x-forwarded-for"] = options.forwarded;
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
