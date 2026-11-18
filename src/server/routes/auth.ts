/**
 * ============================================================
 * routes/auth.ts — 设备静默会话 / 用户访问令牌 / 续期 / 注销
 * ============================================================
 * 文件模式：AUTH_TOKEN 是单用户配对密钥。
 * PostgreSQL 模式：AUTH_TOKEN 只用于管理员 bootstrap；普通用户必须使用
 * 数据库中的独立访问令牌，登录后设备绑定到真实 ownerId。
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
  clearDeviceCookieOnResponse, ensureDeviceIdentity, enrollDeviceIdentity, ownerIdentityForRequest,
  renewDeviceCookie, type RequestIdentity,
} from "../security/device.js";
import { authFailureLimiter, clientIp, type RateLimitDecision } from "../security/rate-limit.js";
import { writeAudit } from "../audit.js";
import { migrateStoredSecrets } from "../config-store.js";
import { log } from "../logging.js";
import { resolveAccessToken } from "../persistence/accounts.js";
import { isPostgresBackend } from "../persistence/postgres.js";
import { runWithTenantContext } from "../tenant-context.js";

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
    ownerId: identity.ownerId,
    role: identity.role,
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

function sessionOwner(req: IncomingMessage): { ownerId: string; role: "admin" | "member" } | null {
  const payload = verifySessionRequest(req);
  return payload?.ownerId ? { ownerId: payload.ownerId, role: payload.role ?? "member" } : null;
}

export async function handleAuthStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  const identity = ownerIdentityForRequest(req);
  if (!isAuthEnabled()) {
    writeJson(res, 200, {
      authenticated: true,
      authRequired: false,
      autoSession: true,
      ownerId: identity?.ownerId,
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
      ownerId: identity.ownerId,
      role: identity.role,
      expiresAt: payload.exp,
      ttlSeconds: Math.max(0, Math.round((payload.exp - Date.now()) / 1000)),
    });
    return;
  }

  if (identity) {
    issueAutoSession(req, res, identity);
    return;
  }

  writeJson(res, 401, { authenticated: false, authRequired: true, needsPairing: true, error: "此设备尚未配对" });
}

export async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  let identity = ownerIdentityForRequest(req);
  if (!isAuthEnabled()) {
    if (!identity) {
      const deviceId = enrollDeviceIdentity(res);
      identity = {
        ownerId: isPostgresBackend() ? "local" : deviceId,
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
        ownerId: isPostgresBackend() ? owner.ownerId : identity.deviceId,
        role: owner.role,
      }
    : (() => {
        const deviceId = enrollDeviceIdentity(res, owner);
        return {
          ownerId: isPostgresBackend() ? owner.ownerId : deviceId,
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
  runWithTenantContext({ ownerId: nextIdentity.ownerId, deviceId: nextIdentity.deviceId, role: nextIdentity.role }, () => {
    writeAudit("auth_login_succeeded", { ip: ipTag(clientIp(req)), role: nextIdentity.role });
  });
  writeJson(res, 200, {
    ok: true,
    authenticated: true,
    authRequired: true,
    autoSession: true,
    ownerId: nextIdentity.ownerId,
    role: nextIdentity.role,
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

export async function handleAuthRenew(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureDeviceIdentity(req, res);
  const identity = ownerIdentityForRequest(req);
  if (!isAuthEnabled()) {
    writeJson(res, 200, { ok: true, authRequired: false, autoSession: true });
    return;
  }

  const token = sessionFromRequest(req);
  const payload = token ? verifySessionToken(token) : null;
  const owner = identity ?? (payload?.ownerId ? { ownerId: payload.ownerId, role: payload.role ?? "member" } : null);
  if (owner) {
    const nextIdentity: RequestIdentity = {
      ownerId: owner.ownerId,
      deviceId: identity?.deviceId ?? owner.ownerId,
      role: owner.role,
    };
    const next = issueSession(Date.now(), payload?.sid, nextIdentity);
    setSessionCookie(res, next.token);
    if (identity) renewDeviceCookie(res, nextIdentity);
    writeAudit("auth_session_renewed", { ip: ipTag(clientIp(req)), mode: identity ? "device" : "session", ownerId: owner.ownerId });
    writeJson(res, 200, {
      ok: true,
      autoSession: Boolean(identity),
      ownerId: owner.ownerId,
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