/**
 * ============================================================
 * routes/auth.ts — 设备静默会话 / 用户访问令牌 / 续期 / 注销
 * ============================================================
 * 文件模式：AUTH_TOKEN 是单用户配对密钥。
 * PostgreSQL 模式：AUTH_TOKEN 只用于管理员 bootstrap；普通用户必须使用
 * 数据库中的独立访问令牌，登录后设备绑定到真实 userId。
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { isAuthEnabled } from "../auth.js";
import {
  clearSessionCookieOnResponse, issueSession, revokeSession, sessionFromRequest,
  sessionTtlHours, setSessionCookie, verifySessionToken, verifySessionRequest,
} from "../security/session.js";
import {
  clearDeviceCookieOnResponse, ensureDeviceIdentity, enrollDeviceIdentity, userIdentityForRequest,
  renewDeviceCookie, type RequestIdentity,
} from "../security/device.js";
import { authFailureLimiter, clientIp, type RateLimitDecision } from "../security/rate-limit.js";
import { checkAccountLock, clearAccountFailures, recordAccountFailure, resetAccountLocksForTests } from "../security/account-lock.js";
import { validatePasswordPolicy, verifyPassword } from "../security/password.js";
import {
  clearLocalLock, getLocalLock, hasLocalLock, setLocalLock, verifyLocalLockPassword,
} from "../security/local-lock.js";
import { writeAudit } from "../audit.js";
import { migrateStoredSecrets } from "../config-store.js";
import { log } from "../logging.js";
import {
  bumpCredentialEpoch, findUserByUsername, getAuthGateState, resolveAccessToken,
  setUserPassword, setMustChangePassword, touchLastLogin,
} from "../persistence/accounts.js";
import { isPostgresBackend } from "../persistence/postgres.js";
import { deviceFromRequest } from "../security/device.js";
import { runWithUserContext } from "../user-context.js";

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function ipTag(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function rateLimited(res: ServerResponse, decision: RateLimitDecision): void {
  writeJson(res, 429, {
    error: `认证失败次数过多，请在 ${decision.retryAfterSeconds} 秒后重试`,
  }, { "Retry-After": String(decision.retryAfterSeconds) });
}

function assertRateAvailable(req: IncomingMessage, res: ServerResponse): boolean {
  const decision = authFailureLimiter.check(clientIp(req));
  if (decision.allowed) return true;
  rateLimited(res, decision);
  return false;
}

function recordFailure(req: IncomingMessage): RateLimitDecision {
  return authFailureLimiter.recordFailure(clientIp(req));
}

function issueAutoSession(req: IncomingMessage, res: ServerResponse, identity: RequestIdentity): void {
  const { token, payload } = issueSession(Date.now(), undefined, identity);
  setSessionCookie(res, token);
  renewDeviceCookie(res, identity);
  writeAudit("auth_session_issued", { ip: ipTag(clientIp(req)), mode: identity.deviceId === "local" ? "loopback" : "device" });
  writeJson(res, 200, {
    ok: true,
    authenticated: true,
    authRequired: isAuthEnabled(),
    autoSession: true,
    userId: identity.userId,
    role: identity.role,
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

function sessionOwner(req: IncomingMessage): { userId: string; role: "admin" | "member" } | null {
  const payload = verifySessionRequest(req);
  return payload?.userId ? { userId: payload.userId, role: payload.role ?? "member" } : null;
}

export async function handleAuthStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  const identity = userIdentityForRequest(req);
  if (!isAuthEnabled()) {
    writeJson(res, 200, {
      authenticated: true,
      authRequired: false,
      autoSession: true,
      userId: identity?.userId,
      role: identity?.role ?? "admin",
    });
    return;
  }

  const payload = verifySessionRequest(req);
  if (payload && identity) {
    renewDeviceCookie(res, identity);
    writeJson(res, 200, {
      authenticated: true,
      authRequired: true,
      autoSession: true,
      userId: identity.userId,
      role: identity.role,
      expiresAt: payload.exp,
      ttlSeconds: Math.max(0, Math.round((payload.exp - Date.now()) / 1000)),
    });
    return;
  }

  if (identity) {
    // 凭据纪元门禁（U1）：改密后旧设备 Cookie 不再静默换发会话，必须重新输入密码。
    if (isPostgresBackend()) {
      const state = await getAuthGateState(identity.userId);
      const epoch = state?.credentialEpoch ?? null;
      const device = deviceFromRequest(req);
      if (epoch !== null && (!device || device.iat < epoch)) {
        clearSessionCookieOnResponse(res);
        writeJson(res, 401, {
          authenticated: false,
          authRequired: true,
          needsLogin: true,
          error: "凭据已更新，请重新登录",
        });
        return;
      }
    }
    issueAutoSession(req, res, identity);
    return;
  }

  writeJson(res, 401, { authenticated: false, authRequired: true, needsPairing: true, error: "此设备尚未配对" });
}

export async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  let identity = userIdentityForRequest(req);
  if (!isAuthEnabled()) {
    if (!identity) {
      const deviceId = enrollDeviceIdentity(res);
      identity = {
        userId: isPostgresBackend() ? "local" : deviceId,
        deviceId,
        role: "admin",
      };
    }
    issueAutoSession(req, res, identity);
    return;
  }

  let token = "";
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { token?: unknown };
    token = typeof body.token === "string" ? body.token.trim() : "";
  } catch (err) {
    recordFailure(req);
    throw err;
  }

  if (!token && identity) {
    issueAutoSession(req, res, identity);
    return;
  }
  if (!token) {
    writeJson(res, 401, {
      authenticated: false,
      authRequired: true,
      needsPairing: true,
      error: "此设备尚未配对，请输入用户访问令牌",
    });
    return;
  }

  if (!assertRateAvailable(req, res)) return;
  const owner = await resolveAccessToken(token);
  if (!owner) {
    const decision = recordFailure(req);
    writeAudit("auth_login_failed", { ip: ipTag(clientIp(req)), remaining: decision.remainingIp });
    if (!decision.allowed) {
      rateLimited(res, decision);
      return;
    }
    writeJson(res, 401, { error: `访问令牌无效；还可尝试 ${decision.remainingIp} 次` });
    return;
  }

  authFailureLimiter.clear(clientIp(req));
  const nextIdentity: RequestIdentity = identity
    ? {
        ...identity,
        userId: isPostgresBackend() ? owner.userId : identity.deviceId,
        role: owner.role,
      }
    : (() => {
        const deviceId = enrollDeviceIdentity(res, owner);
        return {
          userId: isPostgresBackend() ? owner.userId : deviceId,
          deviceId,
          role: owner.role,
        };
      })();
  if (identity) renewDeviceCookie(res, nextIdentity);
  const { token: sessionToken, payload } = issueSession(Date.now(), undefined, nextIdentity);
  setSessionCookie(res, sessionToken);
  await migrateStoredSecrets().catch((err) => {
    log("warn", "config_secret_migration_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  runWithUserContext({ userId: nextIdentity.userId, deviceId: nextIdentity.deviceId, role: nextIdentity.role }, () => {
    writeAudit("auth_login_succeeded", { ip: ipTag(clientIp(req)), role: nextIdentity.role });
  });
  writeJson(res, 200, {
    ok: true,
    authenticated: true,
    authRequired: true,
    autoSession: true,
    userId: nextIdentity.userId,
    role: nextIdentity.role,
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

export async function handleAuthRenew(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  const identity = userIdentityForRequest(req);
  if (!isAuthEnabled()) {
    writeJson(res, 200, { ok: true, authRequired: false, autoSession: true });
    return;
  }

  const token = sessionFromRequest(req);
  const payload = token ? verifySessionToken(token) : null;
  const owner = identity ?? (payload?.userId ? { userId: payload.userId, role: payload.role ?? "member" } : null);
  if (owner) {
    const nextIdentity: RequestIdentity = {
      userId: owner.userId,
      deviceId: identity?.deviceId ?? owner.userId,
      role: owner.role,
    };
    const next = issueSession(Date.now(), payload?.sid, nextIdentity);
    setSessionCookie(res, next.token);
    if (identity) renewDeviceCookie(res, nextIdentity);
    writeAudit("auth_session_renewed", { ip: ipTag(clientIp(req)), mode: identity ? "device" : "session", userId: owner.userId });
    writeJson(res, 200, {
      ok: true,
      autoSession: Boolean(identity),
      userId: owner.userId,
      role: owner.role,
      expiresAt: next.payload.exp,
    });
    return;
  }

  const decision = recordFailure(req);
  if (!decision.allowed) {
    rateLimited(res, decision);
    return;
  }
  writeJson(res, 401, { error: "会话已过期，请重新配对设备" });
}

export async function handleAuthLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = sessionFromRequest(req);
  revokeSession(token);
  clearSessionCookieOnResponse(res);
  clearDeviceCookieOnResponse(res);
  writeAudit("auth_logout", { ip: ipTag(clientIp(req)) });
  writeJson(res, 200, { ok: true });
}
// ---------------------------------------------------------------------------
// 用户名密码登录 / 当前用户 / 自助改密（用户体系改造 U1）
// ---------------------------------------------------------------------------

/** 登录门禁状态缓存清除钩子：测试与改密流程使用。 */
export { resetAccountLocksForTests };

function loginRejected(res: ServerResponse, username: string, req: IncomingMessage, message: string): void {
  const account = recordAccountFailure(username, ipTag(clientIp(req)));
  const decision = recordFailure(req);
  writeAudit("auth_login_failed", { ip: ipTag(clientIp(req)), username, remainingIp: decision.remainingIp });
  if (account.locked) {
    writeJson(res, 429, {
      error: `该账户已被临时锁定，请 ${account.retryAfterSeconds} 秒后重试`,
    }, { "Retry-After": String(account.retryAfterSeconds) });
    return;
  }
  if (!decision.allowed) {
    rateLimited(res, decision);
    return;
  }
  writeJson(res, 401, { error: message });
}

export async function handlePasswordLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  if (!isPostgresBackend()) {
    // 文件模式：单用户「local」，用户名可省略；必须已设置访问密码锁（U3）。
    let body: { username?: unknown; password?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || "{}") as { username?: unknown; password?: unknown };
    } catch {
      writeJson(res, 400, { error: "请求体不是合法 JSON，请提交 { password }" });
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      writeJson(res, 400, { error: "缺少密码；文件模式只需输入访问密码" });
      return;
    }
    if (!assertRateAvailable(req, res)) return;
    if (!(await verifyLocalLockPassword(password))) {
      const decision = recordFailure(req);
      writeAudit("auth_login_failed", { ip: ipTag(clientIp(req)), mode: "local-lock" });
      if (!decision.allowed) { rateLimited(res, decision); return; }
      writeJson(res, 401, { error: `访问密码不正确；还可尝试 ${decision.remainingIp} 次` });
      return;
    }
    authFailureLimiter.clear(clientIp(req));
    const identity = userIdentityForRequest(req)
      ?? (() => {
        const deviceId = enrollDeviceIdentity(res);
        return { userId: "local", deviceId, role: "admin" as const };
      })();
    if (userIdentityForRequest(req)) renewDeviceCookie(res, identity);
    const { token: sessionToken, payload } = issueSession(Date.now(), undefined, identity);
    setSessionCookie(res, sessionToken);
    writeAudit("auth_login_succeeded", { ip: ipTag(clientIp(req)), mode: "local-lock" });
    writeJson(res, 200, {
      ok: true,
      authenticated: true,
      userId: identity.userId,
      role: identity.role,
      user: { displayName: "本地用户", role: identity.role, mustChangePassword: false },
      expiresAt: payload.exp,
      ttlSeconds: sessionTtlHours() * 3600,
    });
    return;
  }

  let username = "";
  let password = "";
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { username?: unknown; password?: unknown };
    username = typeof body.username === "string" ? body.username.trim() : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    writeJson(res, 400, { error: "请求体不是合法 JSON，请提交 { username, password }" });
    return;
  }
  if (!username || !password) {
    writeJson(res, 400, { error: "缺少用户名或密码；两者都必填" });
    return;
  }

  if (!assertRateAvailable(req, res)) return;
  const locked = checkAccountLock(username);
  if (locked.locked) {
    writeJson(res, 429, {
      error: `该账户已被临时锁定，请 ${locked.retryAfterSeconds} 秒后重试`,
    }, { "Retry-After": String(locked.retryAfterSeconds) });
    return;
  }

  const row = await findUserByUsername(username);
  // 用户不存在 / 已禁用 / 未设密码：统一话术 + 统一计失败，不给枚举面。
  if (!row || row.status !== "active" || !row.password_hash) {
    loginRejected(res, username, req, "用户名或密码不正确");
    return;
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    loginRejected(res, username, req, "用户名或密码不正确");
    return;
  }

  clearAccountFailures(username);
  authFailureLimiter.clear(clientIp(req));
  await touchLastLogin(row.id);

  const existing = userIdentityForRequest(req);
  const nextIdentity: RequestIdentity = existing
    ? { ...existing, userId: row.id, role: row.role }
    : (() => {
        const deviceId = enrollDeviceIdentity(res, { userId: row.id, role: row.role });
        return { userId: row.id, deviceId, role: row.role };
      })();
  if (existing) renewDeviceCookie(res, nextIdentity);
  const { token: sessionToken, payload } = issueSession(Date.now(), undefined, nextIdentity);
  setSessionCookie(res, sessionToken);
  runWithUserContext({ userId: nextIdentity.userId, deviceId: nextIdentity.deviceId, role: nextIdentity.role }, () => {
    writeAudit("auth_login_succeeded", { ip: ipTag(clientIp(req)), role: nextIdentity.role, username: row.username });
  });
  writeJson(res, 200, {
    ok: true,
    authenticated: true,
    userId: nextIdentity.userId,
    role: nextIdentity.role,
    user: {
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: row.must_change_password,
    },
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

export async function handleAuthMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  const identity = userIdentityForRequest(req);
  const payload = verifySessionRequest(req);
  const userId = identity?.userId ?? payload?.userId;
  if (!userId) {
    writeJson(res, 401, { authenticated: false, error: "尚未登录", needsLogin: true });
    return;
  }
  if (!isPostgresBackend()) {
    writeJson(res, 200, {
      userId,
      username: null,
      displayName: "本地管理员",
      role: identity?.role ?? "admin",
      mustChangePassword: false,
      backend: "file",
    });
    return;
  }
  const state = await getAuthGateState(userId);
  if (!state) {
    writeJson(res, 401, { authenticated: false, error: "用户不存在或已禁用", needsLogin: true });
    return;
  }
  writeJson(res, 200, {
    userId,
    username: state.username,
    displayName: state.displayName,
    role: state.role,
    mustChangePassword: state.mustChangePassword,
    backend: "postgres",
  });
}

export async function handleAuthPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  const identity = userIdentityForRequest(req);
  const payload = verifySessionRequest(req);
  const userId = identity?.userId ?? payload?.userId;
  if (!userId) {
    writeJson(res, 401, { error: "尚未登录，无法修改密码", needsLogin: true });
    return;
  }

  let currentPassword = "";
  let newPassword = "";
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { currentPassword?: unknown; newPassword?: unknown };
    currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  } catch {
    writeJson(res, 400, { error: "请求体不是合法 JSON，请提交 { currentPassword, newPassword }" });
    return;
  }

  if (!isPostgresBackend()) {
    // 文件模式：访问密码锁的设置/修改（未设锁时 currentPassword 可空）。
    const lock = await getLocalLock();
    if (lock && !(await verifyLocalLockPassword(currentPassword))) {
      writeJson(res, 400, { error: "当前访问密码不正确" });
      return;
    }
    const policyError = validatePasswordPolicy("", newPassword);
    if (policyError) {
      writeJson(res, 400, { error: policyError });
      return;
    }
    await setLocalLock(newPassword);
    revokeSession(sessionFromRequest(req));
    clearSessionCookieOnResponse(res);
    writeAudit("local_lock_changed", { ip: ipTag(clientIp(req)) });
    writeJson(res, 200, { ok: true, enabled: true, reloginRequired: true });
    return;
  }

  const state = await getAuthGateState(userId);
  if (!state) {
    writeJson(res, 401, { error: "用户不存在或已禁用" });
    return;
  }
  // 已设密码：必须先验证当前密码；未设密码（bootstrap/仅令牌用户）：允许首设。
  if (state.passwordHash) {
    if (!currentPassword) {
      writeJson(res, 400, { error: "缺少当前密码；已设置密码的用户必须先验证旧密码" });
      return;
    }
    if (!(await verifyPassword(currentPassword, state.passwordHash))) {
      const decision = recordFailure(req);
      writeAudit("auth_password_change_failed", { ip: ipTag(clientIp(req)) });
      if (!decision.allowed) {
        rateLimited(res, decision);
        return;
      }
      writeJson(res, 400, { error: "当前密码不正确" });
      return;
    }
  }
  const policyError = validatePasswordPolicy(state.username ?? "", newPassword);
  if (policyError) {
    writeJson(res, 400, { error: policyError });
    return;
  }

  await setUserPassword(userId, await import("../security/password.js").then((m) => m.hashPassword(newPassword)), false);
  await setMustChangePassword(userId, false);
  await bumpCredentialEpoch(userId);
  // 安全优先：本设备 Cookie 一并清除，其他设备由凭据纪元门禁在下一请求 401。
  revokeSession(sessionFromRequest(req));
  clearSessionCookieOnResponse(res);
  clearDeviceCookieOnResponse(res);
  writeAudit("user_password_changed", { ip: ipTag(clientIp(req)), userId });
  writeJson(res, 200, { ok: true, reloginRequired: true });
}

// ---------------------------------------------------------------------------
// 凭据纪元门禁：改密后旧会话 / 旧设备静默会话在统一入口失效
// ---------------------------------------------------------------------------

/**
 * 统一认证口调用。已有会话或设备 Cookie 的请求必须满足：
 *   会话 iat >= 凭据纪元 或 设备 Cookie iat >= 凭据纪元。
 * 两者都没有（Bearer 脚本 / 本机回环）不在此校验，交由原有认证路径。
 */
export async function assertFreshCredentials(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!isPostgresBackend()) return true;
  const identity = userIdentityForRequest(req);
  const payload = verifySessionRequest(req);
  const userId = identity?.userId ?? payload?.userId;
  if (!userId) return true;
  const state = await getAuthGateState(userId);
  if (!state || state.credentialEpoch === null) return true;
  const epoch = state.credentialEpoch;
  const sessionFresh = payload ? payload.iat >= epoch : null;
  if (sessionFresh) return true;
  const device = deviceFromRequest(req);
  if (device && device.iat >= epoch) return true;
  if (!payload && !device) return true; // Bearer / 回环路径无 Cookie，不在纪元门禁范围
  clearSessionCookieOnResponse(res);
  writeJson(res, 401, {
    error: "凭据已更新，请重新登录",
    authRequired: true,
    needsLogin: true,
  });
  writeAudit("auth_stale_credentials_rejected", { ip: ipTag(clientIp(req)), userId });
  return false;
}

/** must_change_password 门禁：除 /api/auth/* 外全部 403。 */
export async function assertPasswordChangeAllowed(
  req: IncomingMessage, res: ServerResponse, pathname: string,
): Promise<boolean> {
  if (!isPostgresBackend() || pathname.startsWith("/api/auth/")) return true;
  const identity = userIdentityForRequest(req);
  const payload = verifySessionRequest(req);
  const userId = identity?.userId ?? payload?.userId;
  if (!userId) return true;
  const state = await getAuthGateState(userId);
  if (!state?.mustChangePassword) return true;
  writeJson(res, 403, {
    error: "首次登录或密码已被重置，必须先修改密码",
    code: "password_change_required",
  });
  return false;
}

// ---------------------------------------------------------------------------
// 本地访问密码锁管理（U3，仅文件模式；pg 模式走用户管理）
// ---------------------------------------------------------------------------

function requireLocalIdentity(req: IncomingMessage, res: ServerResponse): boolean {
  const identity = userIdentityForRequest(req);
  if (identity) return true;
  writeJson(res, 401, { error: "设备身份缺失或已过期，请刷新页面重新建立会话", authRequired: true });
  return false;
}

export async function handleLocalLockStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  if (isPostgresBackend()) {
    writeJson(res, 404, { error: "多用户模式的密码管理在用户管理页" });
    return;
  }
  writeJson(res, 200, { enabled: await hasLocalLock() });
}

/** 设置 / 更新访问密码锁；必须持有有效设备身份（已配对或本机回环）。 */
export async function handleSetLocalLock(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  if (isPostgresBackend()) {
    writeJson(res, 404, { error: "多用户模式的密码管理在用户管理页" });
    return;
  }
  if (!requireLocalIdentity(req, res)) return;
  if (!assertRateAvailable(req, res)) return;
  let currentPassword = "";
  let newPassword = "";
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { currentPassword?: unknown; newPassword?: unknown };
    currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  } catch {
    writeJson(res, 400, { error: "请求体不是合法 JSON" });
    return;
  }
  const lock = await getLocalLock();
  if (lock && !(await verifyLocalLockPassword(currentPassword))) {
    writeJson(res, 400, { error: "当前访问密码不正确" });
    return;
  }
  const policyError = validatePasswordPolicy("", newPassword);
  if (policyError) {
    writeJson(res, 400, { error: policyError });
    return;
  }
  await setLocalLock(newPassword);
  writeAudit("local_lock_changed", { ip: ipTag(clientIp(req)) });
  writeJson(res, 200, { ok: true, enabled: true });
}

/** 清除访问密码锁；忘记密码且无法登录时走 scripts/clear-local-lock.ts（本机权限）。 */
export async function handleClearLocalLock(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  if (isPostgresBackend()) {
    writeJson(res, 404, { error: "多用户模式没有本地密码锁" });
    return;
  }
  if (!requireLocalIdentity(req, res)) return;
  if (!assertRateAvailable(req, res)) return;
  let currentPassword = "";
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { currentPassword?: unknown };
    currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  } catch {
    writeJson(res, 400, { error: "请求体不是合法 JSON" });
    return;
  }
  const lock = await getLocalLock();
  if (!lock) {
    writeJson(res, 200, { ok: true, enabled: false });
    return;
  }
  if (!(await verifyLocalLockPassword(currentPassword))) {
    const decision = recordFailure(req);
    writeAudit("local_lock_clear_failed", { ip: ipTag(clientIp(req)) });
    if (!decision.allowed) { rateLimited(res, decision); return; }
    writeJson(res, 400, { error: `当前访问密码不正确；还可尝试 ${decision.remainingIp} 次` });
    return;
  }
  await clearLocalLock();
  authFailureLimiter.clear(clientIp(req));
  writeAudit("local_lock_cleared", { ip: ipTag(clientIp(req)) });
  writeJson(res, 200, { ok: true, enabled: false });
}
