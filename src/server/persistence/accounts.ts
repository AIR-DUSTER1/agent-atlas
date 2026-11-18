/**
 * ============================================================
 * persistence/accounts.ts — 多用户账号、访问令牌与 bootstrap 管理员
 * ============================================================
 * 职责：把 AUTH_TOKEN 限定为管理员引导密钥，用户使用独立一次性/长期访问令牌
 * 换取设备会话；所有令牌只保存 SHA-256 摘要。
 *
 * 设计立场：数据库模式下 ownerId 来自 users.id，绝不把浏览器设备 ID 当用户 ID；
 * 文件模式仍保留 local 单用户身份。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  isPostgresBackend, localOwnerIdentity, querySystem, setLocalOwnerIdentity,
  withSystemTransaction,
} from "./postgres.js";

export type AccountRole = "admin" | "member";

export interface AuthenticatedOwner {
  ownerId: string;
  role: AccountRole;
  displayName: string;
}

export interface CreatedUser {
  ownerId: string;
  displayName: string;
  role: AccountRole;
  token: string;
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
export async function ensureBootstrapAdmin(): Promise<AuthenticatedOwner> {
  if (!isPostgresBackend()) {
    const local = { ownerId: "local", role: "admin" as const, displayName: "本地管理员" };
    setLocalOwnerIdentity({ ownerId: local.ownerId, role: local.role });
    return local;
  }

  const cached = localOwnerIdentity();
  if (cached) return { ownerId: cached.ownerId, role: cached.role, displayName: "管理员" };

  const existing = await querySystem<{ id: string; display_name: string; role: AccountRole }>(
    `SELECT id, display_name, role FROM users
     WHERE role = 'admin' AND status = 'active'
     ORDER BY created_at ASC LIMIT 1`,
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    setLocalOwnerIdentity({ ownerId: row.id, role: row.role });
    return { ownerId: row.id, role: row.role, displayName: row.display_name };
  }

  const inserted = await querySystem<{ id: string }>(
    `INSERT INTO users(display_name, role) VALUES ($1, 'admin') RETURNING id`,
    [envValue("BOOTSTRAP_ADMIN_NAME") || "管理员"],
  );
  const ownerId = inserted.rows[0]?.id;
  if (!ownerId) throw new Error("创建管理员失败：数据库未返回用户 ID");
  setLocalOwnerIdentity({ ownerId, role: "admin" });
  return { ownerId, role: "admin", displayName: envValue("BOOTSTRAP_ADMIN_NAME") || "管理员" };
}

/** 文件模式：只认 AUTH_TOKEN；数据库模式：先查用户令牌，再允许管理员引导密钥。 */
export async function resolveAccessToken(token: string): Promise<AuthenticatedOwner | null> {
  const candidate = token.trim();
  if (!candidate) return null;
  const bootstrap = envValue("AUTH_TOKEN");
  const isBootstrap = Boolean(bootstrap) && constantTimeTextEqual(candidate, bootstrap);

  if (!isPostgresBackend()) {
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
  if (row) return { ownerId: row.id, role: row.role, displayName: row.display_name };
  return isBootstrap ? ensureBootstrapAdmin() : null;
}

export async function findOwnerById(ownerId: string): Promise<AuthenticatedOwner | null> {
  if (!isPostgresBackend()) {
    return ownerId === "local"
      ? { ownerId: "local", role: "admin", displayName: "本地管理员" }
      : null;
  }
  const result = await querySystem<{ id: string; display_name: string; role: AccountRole }>(
    `SELECT id, display_name, role FROM users WHERE id = $1 AND status = 'active' LIMIT 1`,
    [ownerId],
  );
  const row = result.rows[0];
  return row ? { ownerId: row.id, role: row.role, displayName: row.display_name } : null;
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
  const ownerId = await withSystemTransaction(async (client) => {
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
  return { ownerId, displayName, role, token };
}