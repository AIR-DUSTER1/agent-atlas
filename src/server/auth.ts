/**
 * ============================================================
 * auth.ts — 引导密钥校验 + API 会话认证
 * ============================================================
 * AUTH_TOKEN 只用于换取短期 HttpOnly 会话；受保护 API 默认只认 Cookie。
 * 开发模式为兼容现有脚本保留 Bearer，PRODUCTION=1 时关闭该兼容路径。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { verifyBearer } from "./auth-bearer.js";
import { verifySessionRequest } from "./security/session.js";

function currentToken(): string {
  return (process.env.AUTH_TOKEN ?? "").trim();
}

export function isAuthEnabled(): boolean {
  return currentToken().length > 0;
}

export const UNAUTHORIZED_MSG =
  "需要认证：请先通过 POST /api/auth/session 使用 AUTH_TOKEN 登录；会话过期后重新登录即可";

function constantTimeSecretEqual(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(req: IncomingMessage): string {
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? "").trim());
  return match?.[1]?.trim() ?? "";
}

export function verifyLoginSecret(candidate: string): boolean {
  return constantTimeSecretEqual(candidate, currentToken());
}

/**
 * /metrics 专用认证：优先接受已登录会话；生产环境 Prometheus 可用独立
 * METRICS_TOKEN。该 token 不能访问 /api/*，避免监控凭据扩大为控制面凭据。
 */
export function verifyMetricsAuth(req: IncomingMessage): boolean {
  if (verifyRequestAuth(req)) return true;
  const expected = (process.env.METRICS_TOKEN ?? "").trim();
  return constantTimeSecretEqual(bearerToken(req), expected);
}

/** 受保护 API：Cookie 会话优先；仅非生产环境接受旧 Bearer 兼容。 */
export function verifyRequestAuth(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  if (verifySessionRequest(req)) return true;
  if (process.env.PRODUCTION !== "1" && verifyBearer(req)) return true;
  return false;
}

export { verifyBearer } from "./auth-bearer.js";
