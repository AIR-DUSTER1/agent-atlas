/**
 * ============================================================
 * security/session.ts — HMAC 会话签发、Cookie 与注销
 * ============================================================
 * 职责：把引导密钥 AUTH_TOKEN 换成本进程有效的短期会话 Cookie。
 * 设计立场：
 *  - 无 JWT 依赖；HMAC-SHA256 覆盖完整 payload，任何字段篡改都会失败；
 *  - 每次进程启动加入随机 boot nonce，重启后旧 Cookie 自动失效，不做持久会话；
 *  - 注销把 sid 放入进程内撤销表，防已登出 token 在过期前重放；
 *  - Cookie 默认 HttpOnly + SameSite=Strict；生产模式必须 Secure。
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const SESSION_COOKIE = "lg_agent_session";
export const DEFAULT_SESSION_TTL_HOURS = 12;
const MAX_SESSION_TTL_HOURS = 24 * 30;
const SESSION_VERSION = 1;
const BOOT_NONCE = randomBytes(16).toString("base64url");
const revokedSessions = new Map<string, number>();

interface SessionPayload {
  v: 1;
  sid: string;
  iat: number;
  exp: number;
}

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function sessionTtlHours(): number {
  const raw = Number(envValue("SESSION_TTL_HOURS"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_TTL_HOURS;
  return Math.min(MAX_SESSION_TTL_HOURS, Math.max(1, raw));
}

function sessionSigningKey(): string {
  const secret = envValue("SESSION_SECRET") || `dev-session:${envValue("AUTH_TOKEN")}`;
  if (!secret.trim()) throw new Error("会话签名密钥未配置");
  return `${secret}\u0000${BOOT_NONCE}`;
}

function sign(data: string): string {
  return createHmac("sha256", sessionSigningKey()).update(data).digest("base64url");
}

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 解析 Cookie；同名重复时取第一条，拒绝畸形段而不抛错。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of (header ?? "").split(";")) {
    const idx = chunk.indexOf("=");
    if (idx <= 0) continue;
    const name = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (!name || name in out) continue;
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

export function sessionFromRequest(req: IncomingMessage): string | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token || null;
}

/** 签发新会话；注入 now 便于测试过期与时钟偏移。 */
export function issueSession(now = Date.now(), sid: string = randomUUID()): { token: string; payload: SessionPayload } {
  const ttlMs = sessionTtlHours() * 60 * 60 * 1000;
  const payload: SessionPayload = { v: SESSION_VERSION, sid, iat: now, exp: now + ttlMs };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${data}.${sign(data)}`, payload };
}

export function verifySessionToken(token: string, now = Date.now()): SessionPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const data = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!data || !signature || !safeEqualText(signature, sign(data))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (
    !payload || payload.v !== SESSION_VERSION || typeof payload.sid !== "string" || !payload.sid ||
    typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
    payload.exp <= now || payload.iat > now + 60_000 || revokedSessions.has(payload.sid)
  ) return null;
  return payload;
}

export function verifySessionRequest(req: IncomingMessage, now = Date.now()): SessionPayload | null {
  const token = sessionFromRequest(req);
  return token ? verifySessionToken(token, now) : null;
}

function secureCookie(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRODUCTION === "1" || env.COOKIE_SECURE?.toLowerCase() === "true";
}

export function sessionCookie(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const maxAge = Math.round(sessionTtlHours() * 3600);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie(env) ? "; Secure" : ""}`;
}

export function clearSessionCookie(env: NodeJS.ProcessEnv = process.env): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie(env) ? "; Secure" : ""}`;
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader("Set-Cookie", sessionCookie(token));
}

export function clearSessionCookieOnResponse(res: ServerResponse): void {
  res.setHeader("Set-Cookie", clearSessionCookie());
}

/** 注销当前 token：即使攻击者留下旧副本，下一次验证也会因 sid 撤销而失败。 */
export function revokeSession(token: string | null, now = Date.now()): void {
  if (!token) return;
  const payload = verifySessionToken(token, now);
  if (payload) revokedSessions.set(payload.sid, payload.exp);
  const cutoff = now - 60_000;
  for (const [sid, exp] of revokedSessions) if (exp < cutoff) revokedSessions.delete(sid);
}

/** 测试专用：清除进程内撤销表；生产进程没有调用入口。 */
export function resetSessionSecurityForTests(): void {
  revokedSessions.clear();
}
