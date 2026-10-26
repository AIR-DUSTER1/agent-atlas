/**
 * ============================================================
 * core/api.ts — 带 Bearer 认证自愈的 fetch 封装
 * ============================================================
 * 职责：所有 /api 请求的唯一出口。401 时弹框收集令牌并重试一次。
 * 设计立场：
 *  - 错误统一转成 Error（message 直接用服务端中文文案），调用方只管 catch 显示；
 *  - 权限/同源类 403 不重试（弹框也解决不了），错误文案直接透传；
 *  - 令牌存 localStorage（服务端 AUTH_TOKEN 场景），密码框输入不落明文日志。
 */

import { LS_AUTH_TOKEN } from "./state.js";
import { uiPrompt } from "../modules/ui-dialog.js";

export function getAuthToken(): string {
  try { return localStorage.getItem(LS_AUTH_TOKEN) || ""; } catch { return ""; }
}

/** 401 时收集 token：预填上次的值；取消则抛错阻止继续（不弹第二次） */
async function ensureAuthToken(hint?: string): Promise<string> {
  const token = await uiPrompt(
    hint || "服务已开启访问认证，请输入访问令牌（服务端 .env 的 AUTH_TOKEN）：",
    { title: "访问认证", okText: "连接", defaultValue: getAuthToken(), password: true }
  );
  if (token == null || typeof token !== "string") throw new Error("未提供访问令牌，请求已取消");
  const trimmed = token.trim();
  try { localStorage.setItem(LS_AUTH_TOKEN, trimmed); } catch { /* 隐私模式 */ }
  return trimmed;
}

/**
 * 401 自愈的 fetch 包装：带 Bearer 头；收到 401 弹框收集 token 后重试一次。
 * 权限/同源类 403 不重试（弹框也解决不了），错误文案直接透传。
 */
export async function authFetch(path: string, options: RequestInit = {}, retried = false): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", "Bearer " + token);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !retried) {
    await ensureAuthToken("访问令牌无效（可能与服务端不一致），请重新输入：");
    return authFetch(path, options, true);
  }
  return res;
}

/** JSON 请求 + 统一错误转换：失败抛 Error(服务端中文文案) */
export async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(path, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
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
