/**
 * ============================================================
 * core/api.ts — 带会话自愈的 fetch 封装
 * ============================================================
 * 职责：所有 /api 请求的唯一出口。401 时先静默用设备凭据换短期会话，
 * 只有新公网设备才弹一次 AUTH_TOKEN 配对框，并只重试一次。
 * 设计立场：
 *  - 引导密钥不写入 localStorage，浏览器请求只携带 HttpOnly 会话；
 *  - 本机与已配对设备不弹框；并发 401 共用同一次静默恢复；
 *  - 登录失败 / 限流文案原样透传，不吞成笼统网络错误。
 */

import { uiPrompt } from "../ui/dialog.js";

let loginInFlight: Promise<boolean> | null = null;

/** /api 业务错误：保留 HTTP 状态与机器可读 code，调用方可区分可恢复冲突与真正失败。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function postSession(token?: string): Promise<Response> {
  return fetch("/api/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token ? { token } : {}),
  });
}

async function loginSession(hint?: string): Promise<boolean> {
  const silent = await postSession();
  if (silent.ok) return true;
  if (silent.status !== 401) {
    const data = await silent.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `建立设备会话失败（HTTP ${silent.status}）`);
  }

  const token = await uiPrompt(
    hint || "此设备尚未配对。首次使用请输入访问令牌（服务端 .env 的 AUTH_TOKEN），之后将自动保持登录：",
    { title: "设备配对", okText: "配对", password: true }
  );
  if (token == null || typeof token !== "string" || !token.trim()) {
    throw new Error("未提供访问令牌，请求已取消");
  }
  const res = await postSession(token.trim());
  if (res.ok) return true;
  const data = await res.json().catch(() => ({})) as { error?: string };
  throw new Error(data.error || `设备配对失败（HTTP ${res.status}）`);
}

async function ensureAuthSession(hint?: string): Promise<void> {
  if (!loginInFlight) {
    loginInFlight = loginSession(hint).finally(() => { loginInFlight = null; });
  }
  await loginInFlight;
}

/** 401 自愈的 fetch 包装：Cookie 会话 + 一次登录重试。 */
export async function authFetch(path: string, options: RequestInit = {}, retried = false): Promise<Response> {
  const headers = new Headers(options.headers || {});
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: options.credentials ?? "same-origin",
  });
  if (res.status === 401 && !retried && !path.startsWith("/api/auth/")) {
    await ensureAuthSession("访问令牌无效或会话已过期，请重新输入：");
    return authFetch(path, options, true);
  }
  return res;
}

/** JSON 请求 + 统一错误转换：失败抛 ApiError（服务端中文文案 + status/code） */
export async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(path, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data.code);
  }
  return res.json() as Promise<T>;
}

/** POST JSON 的简写：绝大多数写接口都用这一种形状 */
export function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 注销当前 HttpOnly 会话。 */
export async function logoutSession(): Promise<void> {
  const res = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `退出失败（HTTP ${res.status}）`);
  }
}
