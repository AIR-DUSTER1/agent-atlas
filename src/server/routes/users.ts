/**
 * ============================================================
 * routes/users.ts — 用户管理（admin 管理面，用户体系改造 U2）
 * ============================================================
 * GET    /api/users                       用户列表（含令牌摘要）
 * POST   /api/users                       创建用户（用户名/显示名/角色/初始密码）
 * PATCH  /api/users/:id                   禁用/启用/改角色/改显示名
 * POST   /api/users/:id/reset-password    重置密码 → 一次性临时密码
 * DELETE /api/users/:id                   软删除（status=disabled + 吊销令牌/设备）
 * GET    /api/users/:id/tokens            访问令牌列表
 * POST   /api/users/:id/tokens            创建访问令牌（明文只出现一次）
 * DELETE /api/users/:id/tokens/:tokenId   吊销令牌
 *
 * 权限：全部走 index.ts 的 isAdminOnlyApi 门禁（admin only）。
 * 文件模式：一律 404（单用户无管理面，见用户体系计划 §5.1）。
 * 守卫：不能禁用/删除自己；最后一个 active admin 不可禁用/删除/降级。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parsedJsonOf } from "../http-body.js";
import { writeAudit } from "../audit.js";
import { clientIp } from "../security/rate-limit.js";
import { createHash } from "node:crypto";
import {
  createManagedUser, createUserToken, isLastActiveAdmin, listUserTokens, listUsers,
  resetUserPassword, revokeUserToken, setMustChangePassword,
  setUserRole, setUserStatus, softDeleteUser, validateUsername, type AccountRole,
} from "../persistence/accounts.js";
import { isPostgresBackend } from "../persistence/postgres.js";

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function ipTag(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function fileModeRejected(res: ServerResponse): void {
  sendJson(res, 404, { error: "当前为单用户模式（文件后端），没有用户管理面" });
}

function adminActionAudit(req: IncomingMessage, event: string, detail: Record<string, unknown>): void {
  writeAudit(event, { ip: ipTag(clientIp(req)), ...detail });
}

export async function handleListUsers(res: ServerResponse): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  sendJson(res, 200, { users: await listUsers() });
}

export async function handleCreateUser(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  // 解析上移到路由层 jsonRaw（M2 批次 7b）：坏 JSON 由 onError 统一 400
  const body = parsedJsonOf<Record<string, unknown>>(req)!;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role: AccountRole = body.role === "admin" ? "admin" : "member";
  const usernameError = validateUsername(username);
  if (usernameError) { sendJson(res, 400, { error: usernameError }); return; }
  if (!displayName) { sendJson(res, 400, { error: "缺少显示名；显示名用于界面展示" }); return; }
  if (!password) { sendJson(res, 400, { error: "缺少初始密码；用户首登时会被要求修改" }); return; }
  try {
    const user = await createManagedUser({ username, displayName, role, password });
    adminActionAudit(req, "user_created", { userId: user.userId, role: user.role });
    sendJson(res, 200, { user });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, message.includes("重复") || message.includes("duplicate") ? 409 : 400, { error: message });
  }
}

export async function handleUpdateUser(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  // 解析上移到路由层 jsonRaw（M2 批次 7b）：坏 JSON 由 onError 统一 400
  const body = parsedJsonOf<Record<string, unknown>>(req)!;
  const actorId = id;
  const wantsDisable = body.status === "disabled";
  const wantsDemote = body.role === "member";
  if ((wantsDisable || (body.role !== undefined && wantsDemote)) && await isLastActiveAdmin(actorId)) {
    sendJson(res, 409, { error: "这是最后一个可用的管理员，不能禁用或降级；请先创建另一个管理员" });
    return;
  }
  try {
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "disabled") {
        sendJson(res, 400, { error: "status 只能是 active 或 disabled" });
        return;
      }
      await setUserStatus(actorId, body.status);
      adminActionAudit(req, body.status === "disabled" ? "user_disabled" : "user_enabled", { userId: actorId });
    }
    if (body.role !== undefined) {
      if (body.role !== "admin" && body.role !== "member") {
        sendJson(res, 400, { error: "role 只能是 admin 或 member" });
        return;
      }
      await setUserRole(actorId, body.role);
      adminActionAudit(req, "user_role_changed", { userId: actorId, role: body.role });
    }
    if (body.mustChangePassword !== undefined) {
      if (typeof body.mustChangePassword !== "boolean") {
        sendJson(res, 400, { error: "mustChangePassword 必须是布尔值" });
        return;
      }
      await setMustChangePassword(actorId, body.mustChangePassword);
    }
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleResetUserPassword(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  // 允许重置最后一个管理员的密码（丢了密码必须有人能救回来）；禁用/删除才有守卫。
  try {
    const tempPassword = await resetUserPassword(id);
    adminActionAudit(req, "user_password_reset", { userId: id });
    sendJson(res, 200, { tempPassword, mustChangePassword: true });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleDeleteUser(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  if (await isLastActiveAdmin(id)) {
    sendJson(res, 409, { error: "这是最后一个可用的管理员，不能删除；请先创建另一个管理员" });
    return;
  }
  try {
    await softDeleteUser(id);
    adminActionAudit(req, "user_deleted", { userId: id });
    sendJson(res, 200, { ok: true, dataRetained: true });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleListUserTokens(res: ServerResponse, id: string): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  sendJson(res, 200, { tokens: await listUserTokens(id) });
}

export async function handleCreateUserToken(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  // 解析上移到路由层 jsonRaw（M2 批次 7b）：坏 JSON 由 onError 统一 400
  const body = parsedJsonOf<Record<string, unknown>>(req)!;
  const label = typeof body.label === "string" ? body.label : "";
  let expiresAt: Date | null = null;
  if (typeof body.expiresInDays === "number" && Number.isFinite(body.expiresInDays) && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
  }
  try {
    const token = await createUserToken(id, label, expiresAt);
    adminActionAudit(req, "user_token_created", { userId: id });
    sendJson(res, 200, { token, note: "访问令牌只显示一次；请通过安全渠道交给用户。" });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleRevokeUserToken(req: IncomingMessage, res: ServerResponse, id: string, tokenId: string): Promise<void> {
  if (!isPostgresBackend()) { fileModeRejected(res); return; }
  try {
    await revokeUserToken(id, tokenId);
    adminActionAudit(req, "user_token_revoked", { userId: id, tokenId });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
