/**
 * user-auth.test.ts — 用户体系改造 U1 的登录原语
 * 覆盖：scrypt 哈希往返 / 密码策略 / 账户锁定 / 凭据纪元门禁的纯函数路径。
 * 登录端点全链路（双用户 RLS 隔离）在 tests/integration/postgres.test.ts 补充。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword, MIN_PASSWORD_LENGTH, validatePasswordPolicy, verifyPassword,
} from "../../src/server/security/password.js";
import {
  ACCOUNT_LOCK_THRESHOLD, checkAccountLock, clearAccountFailures,
  recordAccountFailure, resetAccountLocksForTests,
} from "../../src/server/security/account-lock.js";
import { isSelfAdminMutation } from "../../src/server/routes/users.js";

test("scrypt 哈希往返：正确密码通过，错误密码拒绝", async () => {
  const stored = await hashPassword("correct-horse-battery");
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct-horse-battery", stored), true);
  assert.equal(await verifyPassword("wrong-password-xx", stored), false);
});

test("scrypt 盐随机：同密码两次哈希结果不同但都能通过校验", async () => {
  const a = await hashPassword("same-password-123");
  const b = await hashPassword("same-password-123");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password-123", a), true);
  assert.equal(await verifyPassword("same-password-123", b), true);
});

test("哈希串损坏或算法不符时返回 false，不抛错", async () => {
  assert.equal(await verifyPassword("whatever-pass-1", "bcrypt$garbage"), false);
  assert.equal(await verifyPassword("whatever-pass-1", "scrypt$1$1$1$bad$bad"), false);
  assert.equal(await verifyPassword("whatever-pass-1", ""), false);
});

test("密码策略：长度不足 / 与用户名相同被拒，合法通过", () => {
  assert.match(validatePasswordPolicy("alice", "short") ?? "", new RegExp(`${MIN_PASSWORD_LENGTH}`));
  assert.equal(validatePasswordPolicy("alicezhang", "alicezhang"), "密码不能与用户名相同");
  assert.equal(validatePasswordPolicy("alice", "a-very-good-password"), null);
  assert.equal(validatePasswordPolicy("", "a-very-good-password"), null);
});

test("账户锁定：连续失败达阈值锁定，解锁后窗口内计数清零", () => {
  resetAccountLocksForTests();
  const now = 1_000_000;
  for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD - 1; i += 1) {
    const decision = recordAccountFailure("bob", "iptag", now + i);
    assert.equal(decision.locked, false);
  }
  const locked = recordAccountFailure("bob", "iptag", now + 100);
  assert.equal(locked.locked, true);
  assert.ok(locked.retryAfterSeconds >= 900);
  // 锁定期内的 check 也返回锁定
  const during = checkAccountLock("bob", now + 200);
  assert.equal(during.locked, true);
  // 窗口过期后解锁
  const after = checkAccountLock("bob", now + 100 + 15 * 60_000 + 1);
  assert.equal(after.locked, false);
  assert.equal(after.remaining, ACCOUNT_LOCK_THRESHOLD);
  resetAccountLocksForTests();
});

test("账户锁定：登录成功清零失败计数", () => {
  resetAccountLocksForTests();
  const now = 2_000_000;
  for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD - 2; i += 1) {
    recordAccountFailure("carol", "iptag", now + i);
  }
  clearAccountFailures("carol");
  const state = checkAccountLock("carol", now + 10);
  assert.equal(state.locked, false);
  assert.equal(state.remaining, ACCOUNT_LOCK_THRESHOLD);
  resetAccountLocksForTests();
});

test("账户锁定：不同用户名互不影响", () => {
  resetAccountLocksForTests();
  const now = 3_000_000;
  for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD - 1; i += 1) {
    recordAccountFailure("dave", "iptag", now + i);
  }
  assert.equal(checkAccountLock("eve", now).locked, false);
  assert.equal(checkAccountLock("dave", now).remaining, 1);
  resetAccountLocksForTests();
});
test("用户管理：管理员不能禁用或降级自己", () => {
  assert.equal(isSelfAdminMutation("admin-1", "admin-1", { status: "disabled" }), true);
  assert.equal(isSelfAdminMutation("admin-1", "admin-1", { role: "member" }), true);
  assert.equal(isSelfAdminMutation("admin-1", "admin-1", { status: "active" }), false);
  assert.equal(isSelfAdminMutation("admin-1", "admin-2", { status: "disabled" }), false);
  assert.equal(isSelfAdminMutation(undefined, "admin-1", { role: "member" }), false);
});
