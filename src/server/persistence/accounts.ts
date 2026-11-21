/**
 * ============================================================
 * persistence/accounts.ts — 多用户账号、访问令牌与 bootstrap 管理员
 * ============================================================
 * 职责：把 AUTH_TOKEN 限定为管理员引导密钥，用户使用独立一次性/长期访问令牌
 * 换取设备会话；所有令牌只保存 SHA-256 摘要。
 *
 * 设计立场：数据库模式下 userId 来自 users.id，绝不把浏览器设备 ID 当用户 ID；
 * 文件模式仍保留 local 单用户身份。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  isPostgresBackend, localUserIdentity, querySystem, setLocalUserIdentity,
  withSystemTransaction,
} from "./postgres.js";
import { hashPassword } from "../security/password.js";

export type AccountRole = "admin" | "member";

export interface AuthenticatedUser {
  userId: string;
  role: AccountRole;
  displayName: string;
}

export interface CreatedUser {
  userId: string;
  displayName: string;
  role: AccountRole;
  token: string;
}

/** 用户管理列表行；绝不包含 password_hash。 */
export interface ManagedUser {
  userId: string;
  username: string | null;
  displayName: string;
  role: AccountRole;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 用户名规则：3-32 位字母/数字/下划线/点/连字符，避免同形字与空白歧义。 */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

export function validateUsername(username: string): string | null {
  if (!USERNAME_PATTERN.test(username)) {
    return "用户名需 3-32 位，以字母或数字开头，只能含字母、数字、下划线、点、连字符";
  }
  if (username === "local") {
    return "用户名 local 为本地单用户保留名，请换一个";
  }
  return null;
}

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeTextEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return left.length === right.length && left.equals(right);
}

/** 首次启动创建管理员；local 直连和 AUTH_TOKEN 都绑定到这个 owner。 */
export async function ensureBootstrapAdmin(): Promise<AuthenticatedUser> {
  if (!isPostgresBackend()) {
    const local = { userId: "local", role: "admin" as const, displayName: "本地管理员" };
    setLocalUserIdentity({ userId: local.userId, role: local.role });
    return local;
  }

  const cached = localUserIdentity();
  if (cached) return { userId: cached.userId, role: cached.role, displayName: "管理员" };

  const existing = await querySystem<{ id: string; display_name: string; role: AccountRole }>(
    `SELECT id, display_name, role FROM users
     WHERE role = 'admin' AND status = 'active'
     ORDER BY created_at ASC LIMIT 1`,
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    setLocalUserIdentity({ userId: row.id, role: row.role });
    return { userId: row.id, role: row.role, displayName: row.display_name };
  }

  const inserted = await querySystem<{ id: string }>(
    `INSERT INTO users(display_name, role, username)
     VALUES ($1, 'admin', $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [envValue("BOOTSTRAP_ADMIN_NAME") || "管理员", bootstrapAdminUsername()],
  );
  const userId = inserted.rows[0]?.id;
  if (userId) {
    // 计划 U1：bootstrap 管理员用户名可被 BOOTSTRAP_ADMIN_USERNAME 覆盖；默认 admin。
    // 若唯一索引冲突（已存在同名用户）说明库已初始化过，回落到查询。
    setLocalUserIdentity({ userId, role: "admin" });
    return { userId, role: "admin", displayName: envValue("BOOTSTRAP_ADMIN_NAME") || "管理员" };
  }
  const fallback = await querySystem<{ id: string; display_name: string; role: AccountRole }>(
    `SELECT id, display_name, role FROM users
     WHERE role = 'admin' AND status = 'active'
     ORDER BY created_at ASC LIMIT 1`,
  );
  const row = fallback.rows[0];
  if (!row) throw new Error("创建管理员失败：数据库未返回用户 ID");
  setLocalUserIdentity({ userId: row.id, role: row.role });
  return { userId: row.id, role: row.role, displayName: row.display_name };
}

/** bootstrap 管理员的登录名；可用 BOOTSTRAP_ADMIN_USERNAME 覆盖，默认 admin。 */
export function bootstrapAdminUsername(): string {
  const raw = envValue("BOOTSTRAP_ADMIN_USERNAME");
  return raw && USERNAME_PATTERN.test(raw) ? raw : "admin";
}

/** 文件模式：只认 AUTH_TOKEN；数据库模式：先查用户令牌，再允许管理员引导密钥。 */
export async function resolveAccessToken(token: string): Promise<AuthenticatedUser | null> {
  const candidate = token.trim();
  if (!candidate) return null;
  const bootstrap = envValue("AUTH_TOKEN");
  const isBootstrap = Boolean(bootstrap) && constantTimeTextEqual(candidate, bootstrap);

  if (!isPostgresBackend()) {
    // 本地访问密码锁（U3）：设锁后，访问密码与 AUTH_TOKEN 都可完成设备配对；
    // 密码不匹配时同样走 401 + IP 限流路径，不给枚举面。
    if (!isBootstrap) {
      const { verifyLocalLockPassword } = await import("../security/local-lock.js");
      if (await verifyLocalLockPassword(candidate)) return ensureBootstrapAdmin();
    }
    return isBootstrap ? ensureBootstrapAdmin() : null;
  }

  const result = await querySystem<{ id: string; display_name: string; role: AccountRole }>(
    `SELECT u.id, u.display_name, u.role
     FROM auth_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1
       AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > now())
       AND u.status = 'active'
     LIMIT 1`,
    [hashToken(candidate)],
  );
  const row = result.rows[0];
  if (row) return { userId: row.id, role: row.role, displayName: row.display_name };
  return isBootstrap ? ensureBootstrapAdmin() : null;
}

export async function findUserById(userId: string): Promise<AuthenticatedUser | null> {
  if (!isPostgresBackend()) {
    return userId === "local"
      ? { userId: "local", role: "admin", displayName: "本地管理员" }
      : null;
  }
  const result = await querySystem<{ id: string; display_name: string; role: AccountRole }>(
    `SELECT id, display_name, role FROM users WHERE id = $1 AND status = 'active' LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return row ? { userId: row.id, role: row.role, displayName: row.display_name } : null;
}

/** 管理员通过 CLI 创建用户；返回的 token 只显示一次，不落日志。 */
export async function createUserWithToken(input: {
  displayName: string;
  email?: string;
  role?: AccountRole;
  expiresAt?: Date | null;
}): Promise<CreatedUser> {
  if (!isPostgresBackend()) throw new Error("创建用户需要 STATE_BACKEND=postgres");
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("displayName 不能为空");
  const role: AccountRole = input.role === "admin" ? "admin" : "member";
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const userId = await withSystemTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users(display_name, email, role) VALUES ($1, $2, $3) RETURNING id`,
      [displayName, input.email?.trim() || null, role],
    );
    const id = user.rows[0]?.id;
    if (!id) throw new Error("创建用户失败：数据库未返回用户 ID");
    await client.query(
      `INSERT INTO auth_tokens(user_id, token_hash, label, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [id, tokenHash, "initial-access", input.expiresAt ?? null],
    );
    return id;
  });
  return { userId, displayName, role, token };
}
// ---------------------------------------------------------------------------
// 用户名密码登录（用户体系改造 U1）
// ---------------------------------------------------------------------------

export interface LoginUserRow {
  id: string;
  username: string;
  display_name: string;
  role: AccountRole;
  status: "active" | "disabled";
  password_hash: string | null;
  must_change_password: boolean;
}

/** 按登录名查用户（大小写不敏感）；不校验密码——哈希校验由调用方在锁定检查后做。 */
export async function findUserByUsername(username: string): Promise<LoginUserRow | null> {
  if (!isPostgresBackend()) return null;
  const result = await querySystem<LoginUserRow>(
    `SELECT id, username, display_name, role, status, password_hash, must_change_password
     FROM users WHERE lower(username) = lower($1) LIMIT 1`,
    [username],
  );
  return result.rows[0] ?? null;
}

/** 登录成功后的审计字段：更新 last_login_at；失败不影响登录流程。 */
export async function touchLastLogin(userId: string): Promise<void> {
  if (!isPostgresBackend()) return;
  await querySystem(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
}

export async function setUserPassword(userId: string, passwordHash: string, mustChange = false): Promise<void> {
  if (!isPostgresBackend()) throw new Error("设置密码需要 STATE_BACKEND=postgres");
  await querySystem(
    `UPDATE users SET password_hash = $2, must_change_password = $3, updated_at = now() WHERE id = $1`,
    [userId, passwordHash, mustChange],
  );
}

export async function setMustChangePassword(userId: string, mustChange: boolean): Promise<void> {
  if (!isPostgresBackend()) throw new Error("更新用户需要 STATE_BACKEND=postgres");
  await querySystem(
    `UPDATE users SET must_change_password = $2, updated_at = now() WHERE id = $1`,
    [userId, mustChange],
  );
}

export async function hasPassword(userId: string): Promise<boolean> {
  if (!isPostgresBackend()) return false;
  const result = await querySystem<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return Boolean(result.rows[0]?.password_hash);
}

// ---------------------------------------------------------------------------
// 用户管理（用户体系改造 U2）：admin 管理面；文件模式无管理面
// ---------------------------------------------------------------------------

export async function listUsers(): Promise<ManagedUser[]> {
  if (!isPostgresBackend()) return [];
  const result = await querySystem<{
    id: string; username: string | null; display_name: string; role: AccountRole;
    status: "active" | "disabled"; must_change_password: boolean; password_hash: string | null;
    created_at: Date; last_login_at: Date | null;
  }>(
    `SELECT id, username, display_name, role, status, must_change_password, password_hash,
            created_at, last_login_at
     FROM users ORDER BY created_at ASC`,
  );
  return result.rows.map((row) => ({
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password,
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    lastLoginAt: row.last_login_at
      ? (row.last_login_at instanceof Date ? row.last_login_at.toISOString() : String(row.last_login_at))
      : null,
  }));
}

export async function createManagedUser(input: {
  username: string;
  displayName: string;
  role: AccountRole;
  password: string;
}): Promise<ManagedUser> {
  if (!isPostgresBackend()) throw new Error("创建用户需要 STATE_BACKEND=postgres");
  const username = input.username.trim();
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  const displayName = input.displayName.trim() || username;
  const passwordHash = await hashPassword(input.password);
  const result = await querySystem<{ id: string; created_at: Date }>(
    `INSERT INTO users(username, display_name, role, password_hash, must_change_password)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, created_at`,
    [username, displayName, input.role, passwordHash],
  );
  const row = result.rows[0];
  if (!row) throw new Error("创建用户失败：数据库未返回用户 ID");
  return {
    userId: row.id,
    username,
    displayName,
    role: input.role,
    status: "active",
    mustChangePassword: true,
    hasPassword: true,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    lastLoginAt: null,
  };
}

export async function setUserRole(userId: string, role: AccountRole): Promise<void> {
  if (!isPostgresBackend()) throw new Error("更新用户需要 STATE_BACKEND=postgres");
  await querySystem(
    `UPDATE users SET role = $2, updated_at = now() WHERE id = $1`,
    [userId, role],
  );
}

/** 软删除：status=disabled + 吊销全部令牌 + 删除设备绑定；数据行保留（RLS 归属不变）。 */
export async function softDeleteUser(userId: string): Promise<void> {
  if (!isPostgresBackend()) throw new Error("删除用户需要 STATE_BACKEND=postgres");
  await withSystemTransaction(async (client) => {
    await client.query(
      `UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1`,
      [userId],
    );
    await client.query(
      `UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query(`DELETE FROM devices WHERE user_id = $1`, [userId]);
  });
}

export async function setUserStatus(userId: string, status: "active" | "disabled"): Promise<void> {
  if (!isPostgresBackend()) throw new Error("更新用户需要 STATE_BACKEND=postgres");
  await withSystemTransaction(async (client) => {
    await client.query(
      `UPDATE users SET status = $2, updated_at = now() WHERE id = $1`,
      [userId, status],
    );
    if (status === "disabled") {
      await client.query(
        `UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await client.query(`DELETE FROM devices WHERE user_id = $1`, [userId]);
    }
  });
}

/** 守卫：最后一个 active admin 不可禁用/删除/降级，否则无人可管。 */
export async function isLastActiveAdmin(userId: string): Promise<boolean> {
  if (!isPostgresBackend()) return false;
  const result = await querySystem<{ count: string }>(
    `SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND status = 'active'`,
  );
  if (Number(result.rows[0]?.count ?? "0") > 1) return false;
  const self = await querySystem<{ role: AccountRole; status: string }>(
    `SELECT role, status FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = self.rows[0];
  return Boolean(row && row.role === "admin" && row.status === "active");
}

/** 重置密码：生成临时密码（只在本响应出现一次），置 must_change_password。 */
export async function resetUserPassword(userId: string): Promise<string> {
  if (!isPostgresBackend()) throw new Error("重置密码需要 STATE_BACKEND=postgres");
  const tempPassword = `${randomUUID().replace(/-/g, "").slice(0, 6)}${randomBytes(3).toString("base64url")}!Aa`;
  await setUserPassword(userId, await hashPassword(tempPassword), true);
  return tempPassword;
}

/** 吊销某用户全部访问令牌（改密/禁用后调用；设备 Cookie 同步失效）。 */
export async function revokeUserTokens(userId: string): Promise<void> {
  if (!isPostgresBackend()) return;
  await querySystem(
    `UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

export async function listUserTokens(userId: string): Promise<Array<{
  id: string; label: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string;
}>> {
  if (!isPostgresBackend()) return [];
  const result = await querySystem<{
    id: string; label: string | null; expires_at: Date | null; revoked_at: Date | null; created_at: Date;
  }>(
    `SELECT id, label, expires_at, revoked_at, created_at
     FROM auth_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    label: row.label,
    expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at)) : null,
    revokedAt: row.revoked_at ? (row.revoked_at instanceof Date ? row.revoked_at.toISOString() : String(row.revoked_at)) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

export async function createUserToken(userId: string, label: string, expiresAt: Date | null): Promise<string> {
  if (!isPostgresBackend()) throw new Error("创建令牌需要 STATE_BACKEND=postgres");
  const token = randomBytes(32).toString("base64url");
  await querySystem(
    `INSERT INTO auth_tokens(user_id, token_hash, label, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), label.trim() || null, expiresAt],
  );
  return token;
}

export async function revokeUserToken(userId: string, tokenId: string): Promise<void> {
  if (!isPostgresBackend()) throw new Error("吊销令牌需要 STATE_BACKEND=postgres");
  await querySystem(
    `UPDATE auth_tokens SET revoked_at = now() WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL`,
    [userId, tokenId],
  );
}

// ---------------------------------------------------------------------------
// 凭据纪元（credential epoch）：改密后强制全部会话与设备静默会话重登
// ---------------------------------------------------------------------------

/** 读用户凭据纪元；null 表示从未改密（旧会话/旧设备 Cookie 都继续有效）。 */
export async function getCredentialEpoch(userId: string): Promise<number | null> {
  if (!isPostgresBackend()) return credentialEpochMemory.get(userId) ?? null;
  const result = await querySystem<{ credential_epoch: Date | null }>(
    `SELECT credential_epoch FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const epoch = result.rows[0]?.credential_epoch;
  return epoch ? (epoch instanceof Date ? epoch.getTime() : new Date(epoch).getTime()) : null;
}

export async function bumpCredentialEpoch(userId: string): Promise<void> {
  const now = new Date();
  if (isPostgresBackend()) {
    await querySystem(
      `UPDATE users SET credential_epoch = $2, updated_at = now() WHERE id = $1`,
      [userId, now],
    );
  }
  credentialEpochMemory.set(userId, now.getTime());
}

const credentialEpochMemory = new Map<string, number>();

/** 测试钩子。 */
export function resetAccountStateForTests(): void {
  credentialEpochMemory.clear();
}

/** 认证门禁状态：一次查询拿齐改密标记与凭据纪元（无缓存，走主键点查）。 */
export interface AuthGateState {
  mustChangePassword: boolean;
  credentialEpoch: number | null;
  username: string | null;
  passwordHash: string | null;
  displayName: string;
  role: AccountRole;
}

export async function getAuthGateState(userId: string): Promise<AuthGateState | null> {
  if (!isPostgresBackend()) return null;
  const result = await querySystem<{
    must_change_password: boolean; credential_epoch: Date | null; username: string | null;
    password_hash: string | null; display_name: string; role: AccountRole; status: string;
  }>(
    `SELECT must_change_password, credential_epoch, username, password_hash, display_name, role, status
     FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    mustChangePassword: row.must_change_password,
    credentialEpoch: row.credential_epoch
      ? (row.credential_epoch instanceof Date ? row.credential_epoch.getTime() : new Date(row.credential_epoch).getTime())
      : null,
    username: row.username,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    role: row.role,
  };
}
