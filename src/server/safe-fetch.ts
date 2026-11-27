/**
 * safe-fetch.ts — 服务端出站 HTTP 统一入口（SSRF 防线）
 * ============================================================
 * 所有从用户/配置可控 URL 发起的服务端 fetch 都应走本函数而不是原生 fetch：
 *   1. URL 解析 + 协议校验（http/https，默认拒绝私网/环回/链路本地）；
 *   2. 限制重定向，避免目标用 30x 跳到内网；
 *   3. 统一 AbortSignal.timeout（防止无超时请求挂死事件循环）。
 *
 * 审核报告 P1-6：systemone / memory-http / rag / settings-gateway / job-browser
 * 的直连 fetch 都要替换到本入口。
 */
import { assertAllowedHttpUrl } from "../url-guard.js";

export interface SafeFetchInit extends RequestInit {
  /** 允许访问本机/内网；默认 false。服务端系统内部的服务（如本地 RAG/记忆）可以显式打开，但必须调用方自己知道它可信。 */
  allowLocalhost?: boolean;
  /** 重定向次数上限，默认 3；超过直接抛错。 */
  maxRedirects?: number;
  /** 整个请求超时毫秒，默认 10s。 */
  timeoutMs?: number;
}

function timeoutSignal(ms: number, existing?: AbortSignal): AbortSignal {
  if (!existing) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  existing.addEventListener("abort", () => ctrl.abort(), { once: true });
  const timer = setTimeout(() => ctrl.abort(), ms);
  const sig = ctrl.signal as AbortSignal;
  sig.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return sig;
}

export async function safeFetch(input: string, init: SafeFetchInit = {}): Promise<Response> {
  const raw = typeof input === "string" ? input : String(input);
  const url = assertAllowedHttpUrl(raw, init.allowLocalhost === true);
  let response = await fetch(url.toString(), {
    ...init,
    signal: timeoutSignal(init.timeoutMs ?? 10_000, init.signal ?? undefined),
  });
  let redirects = 0;
  while (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
    redirects += 1;
    if (redirects > (init.maxRedirects ?? 3)) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("出站请求重定向次数过多，已中断");
    }
    const next = new URL(response.headers.get("location") as string, url).toString();
    assertAllowedHttpUrl(next, init.allowLocalhost === true);
    await response.body?.cancel?.().catch(() => {});
    response = await fetch(next, {
      ...init,
      signal: timeoutSignal(init.timeoutMs ?? 10_000, init.signal ?? undefined),
    });
  }
  return response;
}