/**
 * user-auth.test.ts — 用户体系改造 U1 的登录原语
 * 覆盖：scrypt 哈希往返 / 密码策略 / 账户锁定 / 凭据纪元门禁的纯函数路径。
 * 登录端点全链路（双用户 RLS 隔离）在 tests/integration/postgres.test.ts 补充。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hashPassword, MIN_PASSWORD_LENGTH, validatePasswordPolicy, verifyPassword,
} from "../../src/server/security/password.js";
import {
  ACCOUNT_LOCK_THRESHOLD, checkAccountLock, clearAccountFailures,
  recordAccountFailure, resetAccountLocksForTests,
} from "../../src/server/security/account-lock.js";
import {
  bootstrapPasswordFilePath, resolveInitialAdminPassword,
} from "../../src/server/security/bootstrap-password.js";
import { isSelfAdminMutation } from "../../src/server/routes/users.js";
import { unauthenticatedAuthBody } from "../../src/server/routes/auth.js";

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

// ---------------------------------------------------------------------------
// 数据库模式登录入口：匿名 401 必须引导到「用户名 + 密码」门页
// 回归背景：文件模式沿用 AUTH_TOKEN 配对，PG 模式此前也返回 needsPairing，
// 于是新部署的前端卡在「设备配对」框，而库里 admin 根本没有密码 —— 永远进不去。
// ---------------------------------------------------------------------------

function withBackend<T>(backend: "file" | "postgres", run: () => T): T {
  const previous = process.env.STATE_BACKEND;
  process.env.STATE_BACKEND = backend;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.STATE_BACKEND;
    else process.env.STATE_BACKEND = previous;
  }
}

test("匿名 401 载荷：postgres 走 needsLogin 且不提令牌，file 走 needsPairing", () => {
  withBackend("postgres", () => {
    const body = unauthenticatedAuthBody({ pairing: "此设备尚未配对" });
    assert.equal(body.needsLogin, true, "数据库模式必须弹用户名密码登录页");
    assert.equal(body.needsPairing, undefined, "数据库模式不得再引导到令牌配对");
    assert.equal(body.authRequired, true);
    assert.doesNotMatch(String(body.error), /令牌/, "数据库模式不能提示输入访问令牌");
  });
  withBackend("file", () => {
    const body = unauthenticatedAuthBody({ pairing: "此设备尚未配对" });
    assert.equal(body.needsPairing, true, "文件模式仍是 AUTH_TOKEN 配对");
    assert.equal(body.needsLogin, undefined);
    assert.equal(body.error, "此设备尚未配对");
  });
});

// ---------------------------------------------------------------------------
// 数据库模式初始管理员密码：没有它，登录页永远进不去
// ---------------------------------------------------------------------------

test("初始密码文件默认与 web-config.json 同目录，可用 BOOTSTRAP_ADMIN_PASSWORD_FILE 覆盖", () => {
  const previous = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  try {
    assert.equal(
      bootstrapPasswordFilePath(join("/data", "web-config.json")),
      join("/data", "bootstrap-admin-password.txt"),
    );
    process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE = "/run/secrets/bootstrap-pass.txt";
    assert.equal(bootstrapPasswordFilePath("/data/web-config.json"), "/run/secrets/bootstrap-pass.txt");
  } finally {
    if (previous === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE = previous;
  }
});

test("初始密码：未配置时生成随机强密码并写 0600 文件，重启复用不换值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bootstrap-pass-"));
  const previousEnv = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const previousFile = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  try {
    const configFile = join(dir, "web-config.json");
    const first = await resolveInitialAdminPassword(configFile);
    assert.equal(first.source, "generated");
    assert.equal(validatePasswordPolicy("", first.password), null, "生成的密码必须过策略");
    assert.ok(first.file, "生成路径必须落盘");
    const onDisk = (await readFile(first.file as string, "utf8")).trim();
    assert.equal(onDisk, first.password, "文件内容必须就是密码本身");
    // POSIX 上必须是 0600；Windows 走 ACL，chmod 语义不同，跳过该断言
    if (process.platform !== "win32") {
      const mode = (await stat(first.file as string)).mode & 0o777;
      assert.equal(mode, 0o600, "初始密码文件必须只有属主可读写");
    }
    const second = await resolveInitialAdminPassword(configFile);
    assert.equal(second.source, "file");
    assert.equal(second.password, first.password, "重启不得换掉已生成的密码");
  } finally {
    if (previousEnv === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD = previousEnv;
    if (previousFile === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE = previousFile;
    await rm(dir, { recursive: true, force: true });
  }
});

test("初始密码：BOOTSTRAP_ADMIN_PASSWORD 优先且不落盘；弱密码启动即报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bootstrap-pass-env-"));
  const previousEnv = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const previousFile = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  try {
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "env-provided-strong-pass";
    const fromEnv = await resolveInitialAdminPassword(join(dir, "web-config.json"));
    assert.equal(fromEnv.source, "env");
    assert.equal(fromEnv.password, "env-provided-strong-pass");
    assert.equal(fromEnv.file, null, "env 提供的密码不应写盘");

    process.env.BOOTSTRAP_ADMIN_PASSWORD = "short";
    await assert.rejects(
      () => resolveInitialAdminPassword(join(dir, "web-config.json")),
      /BOOTSTRAP_ADMIN_PASSWORD 不满足密码策略/,
      "弱密码必须在启动阶段就失败，而不是让人反复试错登录",
    );
  } finally {
    if (previousEnv === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD = previousEnv;
    if (previousFile === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE = previousFile;
    await rm(dir, { recursive: true, force: true });
  }
});
