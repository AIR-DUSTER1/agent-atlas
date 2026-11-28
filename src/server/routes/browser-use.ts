/**
 * routes/browser-use.ts — Browser Use 状态、画面与关闭接口
 * ============================================================
 * 浏览器截图只存在内存，并通过现有认证边界返回；所有响应 no-store，禁止缓存
 * 用户页面内容。会话 id 严格校验，路径参数由 index.ts 解码后传入。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  closeBrowserSession, getBrowserPageState, getBrowserScreenshot, getBrowserUsePublicStatus,
  openBrowser,
} from "../browser-use.js";
import { parsedJsonOf, BodyTooLargeError, respondBadRequest } from "../http-body.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function handleBrowserStatus(res: ServerResponse): void {
  sendJson(res, 200, getBrowserUsePublicStatus());
}

export function handleBrowserState(res: ServerResponse, rawSessionId: string): void {
  try {
    const state = getBrowserPageState(rawSessionId);
    if (!state) { sendJson(res, 404, { error: "Browser Use 会话不存在或已关闭" }); return; }
    sendJson(res, 200, state);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function handleBrowserScreenshot(res: ServerResponse, rawSessionId: string): void {
  try {
    const screenshot = getBrowserScreenshot(rawSessionId);
    if (!screenshot) { sendJson(res, 404, { error: "Browser Use 画面尚未就绪" }); return; }
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(screenshot.length),
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(screenshot);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleBrowserClose(
  res: ServerResponse,
  req: IncomingMessage,
  rawSessionId: string,
): Promise<void> {
  try {
    sendJson(res, 200, { ok: await closeBrowserSession(rawSessionId) });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /api/browser/sessions/:id/navigate —— 用户在右侧画面地址栏手动导航。
 * 复用 browser_open 的同一条路径（openBrowser）：会话不存在则创建、URL 过统一
 * SSRF 防线（内网地址默认拒绝）、导航计入审计。
 */
export async function handleBrowserNavigate(
  res: ServerResponse,
  req: IncomingMessage,
  rawSessionId: string,
): Promise<void> {
  try {
    const body = parsedJsonOf<{ url?: unknown }>(req)!;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new Error("请输入要访问的网址");
    const result = await openBrowser(rawSessionId, url, false);
    sendJson(res, 200, { ok: true, url: result.state.url, title: result.state.title });
  } catch (err) {
    if (err instanceof BodyTooLargeError) { respondBadRequest(res, req, err); return; }
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
