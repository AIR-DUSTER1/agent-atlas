/**
 * ============================================================
 * security/device.ts — 浏览器设备身份与静默续期凭据
 * ============================================================
 * 职责：为每个浏览器实例签发稳定的 HttpOnly 设备 Cookie，并在本机直连、
 * 已配对设备或有效旧会话下自动换取短期会话。
 * 设计立场：
 *  - 浏览器无法获得真实 MAC；设备 Cookie 是隐私与跨平台兼容性更好的稳定身份；
 *  - 设备 Cookie 只用于静默换取短期会话，不直接替代所有 API 的会话校验；
 *  - 本机直连使用固定 local 身份；代理转发必须带转发头，避免把公网请求误判为本机；
 *  - 签名不混入 boot nonce，服务重启后设备仍可自动恢复，无需再次弹框。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendSetCookie, issueSession, parseCookies, setSessionCookie, verifySessionRequest } from "./session.js";

export const DEVICE_COOKIE = "lg_agent_device";
export const LOCAL_DEVICE_ID = "local";
export const DEFAULT_DEVICE_TTL_DAYS = 180;
const MAX_DEVICE_TTL_DAYS = 365;
const DEVICE_VERSION = 1;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const requestDevices = new WeakMap<IncomingMessage, string>();
const autoAuthorizedRequests = new WeakSet<IncomingMessage>();

interface DevicePayload {
  v: 1;
  did: string;
  iat: number;
  exp: number;
}

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function deviceTtlDays(): number {
  const raw = Number(envValue("DEVICE_TTL_DAYS"));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DEVICE_TTL_DAYS;
  return Math.min(MAX_DEVICE_TTL_DAYS, Math.max(1, Math.round(raw)));
}

function signingKey(): string {
  const secret = envValue("SESSION_SECRET") || `dev-device:${envValue("AUTH_TOKEN")}`;
  return `agentatlas-device-v1\u0000${secret}`;
}

function sign(data: string): string {
  return createHmac("sha256", signingKey()).update(data).digest("base64url");
}

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function issueDeviceIdentity(now = Date.now(), did: string = randomUUID()): { token: string; payload: DevicePayload } {
  const payload: DevicePayload = {
    v: DEVICE_VERSION,
    did,
    iat: now,
    exp: now + deviceTtlDays() * 86_400_000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${data}.${sign(data)}`, payload };
}

export function verifyDeviceToken(token: string, now = Date.now()): DevicePayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const data = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!data || !signature || !safeEqualText(signature, sign(data))) return null;
  let payload: DevicePayload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as DevicePayload;
  } catch {
    return null;
  }
  if (
    !payload || payload.v !== DEVICE_VERSION || typeof payload.did !== "string" ||
    !DEVICE_ID_PATTERN.test(payload.did) || typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" || payload.exp <= now || payload.iat > now + 60_000
  ) return null;
  return payload;
}

export function deviceFromRequest(req: IncomingMessage, now = Date.now()): DevicePayload | null {
  const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  return token ? verifyDeviceToken(token, now) : null;
}

function secureCookie(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRODUCTION === "1" || env.COOKIE_SECURE?.toLowerCase() === "true";
}

export function deviceCookie(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const maxAge = deviceTtlDays() * 86_400;
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie(env) ? "; Secure" : ""}`;
}

export function clearDeviceCookie(env: NodeJS.ProcessEnv = process.env): string {
  return `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie(env) ? "; Secure" : ""}`;
}

function socketLoopback(remoteAddress: string | undefined): boolean {
  const normalized = (remoteAddress ?? "").replace(/^::ffff:/i, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

/** 直连本机才自动信任；出现任何转发头都按代理后的远端客户端处理。 */
export function isDirectLoopbackRequest(req: IncomingMessage): boolean {
  if (!socketLoopback(req.socket.remoteAddress)) return false;
  return !req.headers.forwarded && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"];
}

function authEnabled(): boolean {
  return envValue("AUTH_TOKEN").length > 0;
}

/**
 * 在任何 API 路由前解析/建立设备身份。
 * 新设备只有在本机直连、认证关闭或已有合法短期会话时才会自动注册；
 * 公网新设备必须走一次 AUTH_TOKEN 配对。
 */
export function ensureDeviceIdentity(req: IncomingMessage, res: ServerResponse): string | null {
  const cached = requestDevices.get(req);
  if (cached) return cached;

  const existing = deviceFromRequest(req);
  if (existing) {
    requestDevices.set(req, existing.did);
    return existing.did;
  }

  if (isDirectLoopbackRequest(req)) {
    requestDevices.set(req, LOCAL_DEVICE_ID);
    return LOCAL_DEVICE_ID;
  }

  if (!authEnabled() || verifySessionRequest(req)) {
    const issued = issueDeviceIdentity();
    requestDevices.set(req, issued.payload.did);
    appendSetCookie(res, deviceCookie(issued.token));
    return issued.payload.did;
  }

  return null;
}

/** 路由取设备归属时使用；正常 HTTP 流程已由 ensureDeviceIdentity 填充。 */
export function deviceIdentityForRequest(req: IncomingMessage): string | null {
  return requestDevices.get(req) ?? deviceFromRequest(req)?.did ?? null;
}

/**
 * 可信设备在业务请求入口直接换取短期会话。
 * 这样首访本机或设备 Cookie 续期不会先制造一个 401，也不会污染登录失败限流。
 */
export function ensureDeviceSession(req: IncomingMessage, res: ServerResponse): string | null {
  const deviceId = ensureDeviceIdentity(req, res);
  if (!deviceId || !authEnabled() || verifySessionRequest(req)) return deviceId;
  const { token } = issueSession();
  setSessionCookie(res, token);
  autoAuthorizedRequests.add(req);
  return deviceId;
}

export function hasAuthorizedDeviceSession(req: IncomingMessage): boolean {
  return autoAuthorizedRequests.has(req);
}

/**
 * 旧 Bearer 兼容路径没有浏览器设备 Cookie。为保持脚本跨请求可用，
 * 用 token 摘要派生稳定 API 设备身份；它不能与任何浏览器设备串会话。
 */
export function adoptBearerIdentity(req: IncomingMessage, res: ServerResponse): string | null {
  const existing = deviceIdentityForRequest(req);
  if (existing) return existing;
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? "").trim());
  if (!match?.[1]) return null;
  const digest = createHash("sha256").update(match[1]).digest("hex").slice(0, 32);
  const deviceId = `api-${digest}`;
  requestDevices.set(req, deviceId);
  renewDeviceCookie(res, deviceId);
  return deviceId;
}

export function requireDeviceIdentity(req: IncomingMessage, res: ServerResponse): string | null {
  const deviceId = deviceIdentityForRequest(req);
  if (deviceId) return deviceId;
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "设备身份缺失或已过期，请刷新页面重新建立会话", authRequired: true }));
  return null;
}

/** 登录成功或静默续期时刷新设备凭据；本机固定身份不需要 Cookie。 */
export function renewDeviceCookie(res: ServerResponse, deviceId: string): void {
  if (deviceId === LOCAL_DEVICE_ID) return;
  const current = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  const values = current == null ? [] : Array.isArray(current) ? current.map(String) : [String(current)];
  if (values.some((value) => value.includes(`${DEVICE_COOKIE}=`))) return;
  const issued = issueDeviceIdentity(Date.now(), deviceId);
  appendSetCookie(res, deviceCookie(issued.token));
}

export function enrollDeviceIdentity(res: ServerResponse): string {
  const issued = issueDeviceIdentity();
  appendSetCookie(res, deviceCookie(issued.token));
  return issued.payload.did;
}

export function clearDeviceCookieOnResponse(res: ServerResponse): void {
  appendSetCookie(res, clearDeviceCookie());
}
