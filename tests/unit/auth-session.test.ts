/** auth-session.test.ts — 会话 Cookie、注销重放与失败限流 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  issueSession, resetSessionSecurityForTests, revokeSession, sessionCookie, verifySessionToken,
} from "../../src/server/security/session.js";
import { FailureRateLimiter } from "../../src/server/security/rate-limit.js";

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
