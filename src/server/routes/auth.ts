/**
 * ============================================================
 * routes/auth.ts — 设备静默会话 / 登录 / 续期 / 注销
 * ============================================================
 * 本机直连和已配对设备不再反复弹出令牌框；新公网设备仍需一次 AUTH_TOKEN
 * 配对。设备 Cookie 只负责换短期会话，所有业务 API 仍校验短期会话。
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { isAuthEnabled, verifyLoginSecret } from "../auth.js";
import {
  clearSessionCookieOnResponse, issueSession, revokeSession, sessionFromRequest,
  sessionTtlHours, setSessionCookie, verifySessionToken, verifySessionRequest,
} from "../security/session.js";
import {
  clearDeviceCookieOnResponse, ensureDeviceIdentity, enrollDeviceIdentity, LOCAL_DEVICE_ID,
  renewDeviceCookie,
} from "../security/device.js";
import { authFailureLimiter, clientIp, type RateLimitDecision } from "../security/rate-limit.js";
import { writeAudit } from "../audit.js";
import { migrateStoredSecrets } from "../config-store.js";
import { log } from "../logging.js";

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

function issueAutoSession(req: IncomingMessage, res: ServerResponse, deviceId: string): void {
  const { token, payload } = issueSession();
  setSessionCookie(res, token);
  renewDeviceCookie(res, deviceId);
  writeAudit("auth_session_issued", { ip: ipTag(clientIp(req)), mode: deviceId === LOCAL_DEVICE_ID ? "loopback" : "device" });
  writeJson(res, 200, {
    ok: true,
    authenticated: true,
    authRequired: isAuthEnabled(),
    autoSession: true,
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

export async function handleAuthStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const deviceId = ensureDeviceIdentity(req, res);
  if (!isAuthEnabled()) {
    writeJson(res, 200, { authenticated: true, authRequired: false, autoSession: true });
    return;
  }

  const payload = verifySessionRequest(req);
  if (payload) {
    if (deviceId) renewDeviceCookie(res, deviceId);
    writeJson(res, 200, {
      authenticated: true,
      authRequired: true,
      autoSession: Boolean(deviceId),
      expiresAt: payload.exp,
      ttlSeconds: Math.max(0, Math.round((payload.exp - Date.now()) / 1000)),
    });
    return;
  }

  if (deviceId) {
    issueAutoSession(req, res, deviceId);
    return;
  }

  writeJson(res, 401, { authenticated: false, authRequired: true, needsPairing: true, error: "此设备尚未配对" });
}

export async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let deviceId = ensureDeviceIdentity(req, res);
  if (!isAuthEnabled()) {
    if (!deviceId) deviceId = enrollDeviceIdentity(res);
    issueAutoSession(req, res, deviceId);
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

  if (!token) {
    if (deviceId) {
      issueAutoSession(req, res, deviceId);
      return;
    }
    writeJson(res, 401, {
      authenticated: false,
      authRequired: true,
      needsPairing: true,
      error: "此设备尚未配对，请输入一次访问令牌",
    });
    return;
  }

  if (!assertRateAvailable(req, res)) return;
  if (!verifyLoginSecret(token)) {
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
  const { token: sessionToken, payload } = issueSession();
  setSessionCookie(res, sessionToken);
  if (!deviceId) deviceId = enrollDeviceIdentity(res);
  else renewDeviceCookie(res, deviceId);
  await migrateStoredSecrets().catch((err) => {
    log("warn", "config_secret_migration_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  writeAudit("auth_login_succeeded", { ip: ipTag(clientIp(req)) });
  writeJson(res, 200, {
    ok: true,
    authenticated: true,
    authRequired: true,
    autoSession: true,
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

export async function handleAuthRenew(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const deviceId = ensureDeviceIdentity(req, res);
  if (!isAuthEnabled()) {
    writeJson(res, 200, { ok: true, authRequired: false, autoSession: true });
    return;
  }

  const token = sessionFromRequest(req);
  const payload = token ? verifySessionToken(token) : null;
  if (payload || deviceId) {
    const next = issueSession(Date.now(), payload?.sid);
    setSessionCookie(res, next.token);
    if (deviceId) renewDeviceCookie(res, deviceId);
    writeAudit("auth_session_renewed", { ip: ipTag(clientIp(req)), mode: deviceId ? "device" : "session" });
    writeJson(res, 200, { ok: true, autoSession: Boolean(deviceId), expiresAt: next.payload.exp });
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
