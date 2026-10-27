/**
 * ============================================================
 * routes/auth.ts — 会话登录 / 状态 / 续期 / 注销
 * ============================================================
 * 登录失败按 IP + 全局双桶限流；认证响应只含过期时间，不回显密钥。
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { isAuthEnabled, verifyLoginSecret } from "../auth.js";
import {
  clearSessionCookieOnResponse, issueSession, revokeSession, sessionFromRequest,
  sessionTtlHours, setSessionCookie, verifySessionToken, verifySessionRequest,
} from "../security/session.js";
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

export async function handleAuthStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthEnabled()) {
    writeJson(res, 200, { authenticated: true, authRequired: false });
    return;
  }
  const payload = verifySessionRequest(req);
  if (!payload) {
    writeJson(res, 401, { authenticated: false, authRequired: true, error: "未登录或会话已过期" });
    return;
  }
  writeJson(res, 200, {
    authenticated: true,
    authRequired: true,
    expiresAt: payload.exp,
    ttlSeconds: Math.max(0, Math.round((payload.exp - Date.now()) / 1000)),
  });
}

export async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthEnabled()) {
    writeJson(res, 200, { ok: true, authRequired: false });
    return;
  }
  if (!assertRateAvailable(req, res)) return;
  let token = "";
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { token?: unknown };
    token = typeof body.token === "string" ? body.token.trim() : "";
  } catch (err) {
    recordFailure(req);
    throw err;
  }
  if (!token || !verifyLoginSecret(token)) {
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
  await migrateStoredSecrets().catch((err) => {
    log("warn", "config_secret_migration_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  writeAudit("auth_login_succeeded", { ip: ipTag(clientIp(req)) });
  writeJson(res, 200, {
    ok: true,
    authenticated: true,
    expiresAt: payload.exp,
    ttlSeconds: sessionTtlHours() * 3600,
  });
}

export async function handleAuthRenew(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthEnabled()) {
    writeJson(res, 200, { ok: true, authRequired: false });
    return;
  }
  if (!assertRateAvailable(req, res)) return;
  const token = sessionFromRequest(req);
  const payload = token ? verifySessionToken(token) : null;
  if (!payload) {
    const decision = recordFailure(req);
    if (!decision.allowed) {
      rateLimited(res, decision);
      return;
    }
    writeJson(res, 401, { error: "会话已过期，请重新登录" });
    return;
  }
  const next = issueSession(Date.now(), payload.sid);
  setSessionCookie(res, next.token);
  writeAudit("auth_session_renewed", { ip: ipTag(clientIp(req)) });
  writeJson(res, 200, { ok: true, expiresAt: next.payload.exp });
}

export async function handleAuthLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = sessionFromRequest(req);
  revokeSession(token);
  clearSessionCookieOnResponse(res);
  writeAudit("auth_logout", { ip: ipTag(clientIp(req)) });
  writeJson(res, 200, { ok: true });
}
