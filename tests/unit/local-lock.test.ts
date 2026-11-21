/**
 * local-lock.test.ts — 文件模式本地访问密码锁（U3）
 * 覆盖：设置/校验/清除往返、配对通道（resolveAccessToken 接受访问密码）、
 * 未设锁时配对行为不变。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearLocalLock, getLocalLock, hasLocalLock, resetLocalLockCacheForTests,
  setLocalLock, verifyLocalLockPassword,
} from "../../src/server/security/local-lock.js";
import { resolveAccessToken } from "../../src/server/persistence/accounts.js";

async function withTempLockFile<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "local-lock-"));
  process.env.LOCAL_LOCK_FILE = join(dir, "local-user.json");
  resetLocalLockCacheForTests();
  try {
    return await fn();
  } finally {
    delete process.env.LOCAL_LOCK_FILE;
    delete process.env.AUTH_TOKEN;
    resetLocalLockCacheForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

test("密码锁设置/校验/清除往返", async () => {
  await withTempLockFile(async () => {
    assert.equal(await hasLocalLock(), false);
    await setLocalLock("a-strong-password-1", "本地用户");
    assert.equal(await hasLocalLock(), true);
    assert.equal(await verifyLocalLockPassword("a-strong-password-1"), true);
    assert.equal(await verifyLocalLockPassword("wrong-password-x"), false);
    const state = await getLocalLock();
    assert.equal(state?.displayName, "本地用户");
    assert.ok(state && state.passwordHash.startsWith("scrypt$"));
    await clearLocalLock();
    assert.equal(await hasLocalLock(), false);
    assert.equal(await verifyLocalLockPassword("a-strong-password-1"), false);
  });
});

test("未设锁时文件模式配对只认 AUTH_TOKEN，行为不变", async () => {
  await withTempLockFile(async () => {
    process.env.AUTH_TOKEN = "bootstrap-token";
    const bad = await resolveAccessToken("a-strong-password-1");
    assert.equal(bad, null, "无锁时访问密码不能配对");
    const ok = await resolveAccessToken("bootstrap-token");
    assert.ok(ok && ok.role === "admin");
  });
});

test("设锁后访问密码可完成配对（U3 登录门页的 file 适配）", async () => {
  await withTempLockFile(async () => {
    await setLocalLock("a-strong-password-1");
    // 无 AUTH_TOKEN 的文件模式：访问密码就是配对凭据
    const paired = await resolveAccessToken("a-strong-password-1");
    assert.ok(paired && paired.userId === "local");
    assert.equal(await resolveAccessToken("wrong-password-x"), null);
  });
});

test("AUTH_TOKEN 救援通道始终可用（与密码锁并存）", async () => {
  await withTempLockFile(async () => {
    await setLocalLock("a-strong-password-1");
    process.env.AUTH_TOKEN = "bootstrap-token";
    const viaToken = await resolveAccessToken("bootstrap-token");
    assert.ok(viaToken && viaToken.role === "admin");
    const viaPassword = await resolveAccessToken("a-strong-password-1");
    assert.ok(viaPassword && viaPassword.userId === "local");
  });
});
