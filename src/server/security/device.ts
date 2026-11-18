/**
 * ============================================================
 * security/device.ts — 浏览器设备身份、用户 owner 绑定与静默续期
 * ============================================================
 * 职责：为每个浏览器实例签发稳定的 HttpOnly 设备 Cookie，并把设备绑定到
 * PostgreSQL users.id（文件模式回落到 local/设备身份）。
 * 设计立场：
 *  - 浏览器无法获得真实 MAC；设备 Cookie 只证明设备，不证明用户；
 *  - ownerId 必须来自已认证用户或 local bootstrap，绝不能由前端传入；
 *  - 设备 Cookie 只换短期会话，所有业务 API 仍校验短期会话；
 *  - 本机直连使用 bootstrap 管理员身份；公网新设备必须先用用户访问令牌配对。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendSetCookie, issueSession, parseCookies, setSessionCookie, verifySessionRequest } from "./session.js";
import { isPostgresBackend, localOwnerIdentity } from "../persistence/postgres.js";

export const DEVICE_COOKIE = "lg_agent_device";
export const LOCAL_DEVICE_ID = "local";
export const DEFAULT_DEVICE_TTL_DAYS = 180;
const MAX_DEVICE_TTL_DAYS = 365;
const DEVICE_VERSION = 2;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const requestIdentities = new WeakMap<IncomingMessage, RequestIdentity>();
const autoAuthorizedRequests = new WeakSet<IncomingMessage>();

export type DeviceRole = "admin" | "member";

export interface RequestIdentity {
  ownerId: string;
  deviceId: string;
  role: DeviceRole;
}

interface DevicePayload {
  v: 1 | 2;
  did: string;
  /** v2：真实用户 owner；v1 旧 Cookie 没有该字段。 */
  uid?: string;
  role?: DeviceRole;
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
  return `agentatlas-device-v2\u0000${secret}`;
}

function sign(data: string): string {
  return createHmac("sha256", signingKey()).update(data).digest("base64url");
}

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function localRequestIdentity(deviceId = LOCAL_DEVICE_ID): RequestIdentity {
  const local = localOwnerIdentity();
  return {
    ownerId: local?.ownerId ?? LOCAL_DEVICE_ID,
    deviceId,
    role: local?.role ?? "admin",
  };
}

export function issueDeviceIdentity(
  now = Date.now(),
  did: string = randomUUID(),
  owner: Pick<RequestIdentity, "ownerId" | "role"> = localRequestIdentity(),
): { token: string; payload: DevicePayload } {
  const payload: DevicePayload = {
    v: DEVICE_VERSION,
    did,
    uid: owner.ownerId,
    role: owner.role,
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
  const validVersion = payload?.v === 1 || payload?.v === 2;
  const validOwner = payload.v === 1
    ? true
    : typeof payload.uid === "string" && payload.uid.length > 0 && (payload.role === "admin" || payload.role === "member");
  if (
    !payload || !validVersion || !validOwner ||
    typeof payload.did !== "string" || !DEVICE_ID_PATTERN.test(payload.did) ||
    typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
    payload.exp <= now || payload.iat > now + 60_000
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

function identityFromDevice(payload: DevicePayload): RequestIdentity | null {
  if (payload.v === 1) {
    if (isPostgresBackend()) return null;
    return { ownerId: payload.did, deviceId: payload.did, role: "admin" };
  }
  if (!payload.uid || !payload.role) return null;
  return { ownerId: payload.uid, deviceId: payload.did, role: payload.role };
}

function sessionIdentity(req: IncomingMessage): RequestIdentity | null {
  const session = verifySessionRequest(req);
  if (!session) return null;
  if (session.ownerId) {
    return {
      ownerId: session.ownerId,
      deviceId: deviceFromRequest(req)?.did ?? session.ownerId,
      role: session.role ?? "member",
    };
  }
  return localRequestIdentity();
}

function cache(req: IncomingMessage, identity: RequestIdentity): RequestIdentity {
  requestIdentities.set(req, identity);
  return identity;
}

/**
 * 在任何 API 路由前解析/建立设备身份。
 * 返回值保留为设备 ID 兼容旧调用；owner 通过 ownerIdentityForRequest 获取。
 */
export function ensureDeviceIdentity(req: IncomingMessage, res: ServerResponse): string | null {
  const cached = requestIdentities.get(req);
  if (cached) return cached.deviceId;

  const existing = deviceFromRequest(req);
  if (existing) {
    const identity = identityFromDevice(existing);
    if (!identity) return null;
    cache(req, identity);
    return identity.deviceId;
  }

  if (isDirectLoopbackRequest(req)) {
    const identity = localRequestIdentity();
    cache(req, identity);
    return identity.deviceId;
  }

  const session = sessionIdentity(req);
  if (session) {
    cache(req, session);
    return session.deviceId;
  }

  if (!authEnabled()) {
    const deviceId = randomUUID();
    const identity: RequestIdentity = isPostgresBackend()
      ? localRequestIdentity(deviceId)
      : { ownerId: deviceId, deviceId, role: "admin" };
    cache(req, identity);
    appendSetCookie(res, deviceCookie(issueDeviceIdentity(Date.now(), identity.deviceId, identity).token));
    return identity.deviceId;
  }

  return null;
}

/** 路由取 owner 时使用；正常 HTTP 流程已由 ensureDeviceIdentity 填充。 */
export function ownerIdentityForRequest(req: IncomingMessage): RequestIdentity | null {
  const cached = requestIdentities.get(req);
  if (cached) return cached;
  const existing = deviceFromRequest(req);
  if (existing) {
    const identity = identityFromDevice(existing);
    if (identity) return cache(req, identity);
  }
  return null;
}

export function deviceIdentityForRequest(req: IncomingMessage): string | null {
  return ownerIdentityForRequest(req)?.deviceId ?? deviceFromRequest(req)?.did ?? null;
}

/**
 * 可信设备在业务请求入口直接换取短期会话。
 * 只有拥有有效设备 owner 或有效旧会话才能静默续期。
 */
export function ensureDeviceSession(req: IncomingMessage, res: ServerResponse): string | null {
  const deviceId = ensureDeviceIdentity(req, res);
  const identity = ownerIdentityForRequest(req);
  if (!deviceId || !identity) return deviceId;
  if (!authEnabled() || verifySessionRequest(req)) return deviceId;
  const { token } = issueSession(Date.now(), undefined, identity);
  setSessionCookie(res, token);
  autoAuthorizedRequests.add(req);
  return deviceId;
}

export function hasAuthorizedDeviceSession(req: IncomingMessage): boolean {
  return autoAuthorizedRequests.has(req);
}

/**
 * 旧 Bearer 兼容路径没有浏览器设备 Cookie。为保持脚本跨请求可用，
 * 用 token 摘要派生稳定 API 设备身份；生产数据库模式只接受 AUTH_TOKEN。
 */
export function adoptBearerIdentity(req: IncomingMessage, res: ServerResponse): string | null {
  const existing = ownerIdentityForRequest(req);
  if (existing) return existing.deviceId;
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? "").trim());
  if (!match?.[1]) return null;
  const expected = envValue("AUTH_TOKEN");
  const bearer = match[1].trim();
  if (isPostgresBackend() && (!expected || bearer !== expected)) return null;
  const digest = createHash("sha256").update(bearer).digest("hex").slice(0, 32);
  const identity: RequestIdentity = {
    ownerId: localRequestIdentity().ownerId,
    deviceId: `api-${digest}`,
    role: "admin",
  };
  cache(req, identity);
  renewDeviceCookie(res, identity);
  return identity.deviceId;
}

export function isAdminRequest(req: IncomingMessage): boolean {
  return ownerIdentityForRequest(req)?.role === "admin";
}
export function requireOwnerIdentity(req: IncomingMessage, res: ServerResponse): RequestIdentity | null {
  const identity = ownerIdentityForRequest(req);
  if (identity) return identity;
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "设备身份缺失或已过期，请刷新页面重新建立会话", authRequired: true }));
  return null;
}

/** 兼容旧路由：返回 ownerId，不再返回设备 ID；需要设备用 ownerIdentityForRequest。 */
export function requireDeviceIdentity(req: IncomingMessage, res: ServerResponse): string | null {
  return requireOwnerIdentity(req, res)?.ownerId ?? null;
}

/** 登录成功或静默续期时刷新设备凭据；本机固定身份不需要 Cookie。 */
export function renewDeviceCookie(res: ServerResponse, identity: RequestIdentity): void;
export function renewDeviceCookie(res: ServerResponse, deviceId: string, owner?: Pick<RequestIdentity, "ownerId" | "role">): void;
export function renewDeviceCookie(
  res: ServerResponse,
  identityOrDeviceId: RequestIdentity | string,
  owner?: Pick<RequestIdentity, "ownerId" | "role">,
): void {
  const identity = typeof identityOrDeviceId === "string"
    ? { deviceId: identityOrDeviceId, ...(owner ?? localRequestIdentity()) }
    : identityOrDeviceId;
  if (identity.deviceId === LOCAL_DEVICE_ID) return;
  const current = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  const values = current == null ? [] : Array.isArray(current) ? current.map(String) : [String(current)];
  if (values.some((value) => value.includes(`${DEVICE_COOKIE}=`))) return;
  const issued = issueDeviceIdentity(Date.now(), identity.deviceId, identity);
  appendSetCookie(res, deviceCookie(issued.token));
}

export function enrollDeviceIdentity(
  res: ServerResponse,
  owner: Pick<RequestIdentity, "ownerId" | "role"> = localRequestIdentity(),
): string {
  const deviceId = randomUUID();
  const effectiveOwner = !isPostgresBackend() && owner.ownerId === LOCAL_DEVICE_ID
    ? { ...owner, ownerId: deviceId }
    : owner;
  const issued = issueDeviceIdentity(Date.now(), deviceId, effectiveOwner);
  appendSetCookie(res, deviceCookie(issued.token));
  return issued.payload.did;
}

export function clearDeviceCookieOnResponse(res: ServerResponse): void {
  appendSetCookie(res, clearDeviceCookie());
}