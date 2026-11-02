/**
 * routes/browser-use.ts — Browser Use 状态、画面与关闭接口
 * ============================================================
 * 浏览器截图只存在内存，并通过现有认证边界返回；所有响应 no-store，禁止缓存
 * 用户页面内容。会话 id 严格校验，路径参数由 index.ts 解码后传入。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import {
  closeBrowserSession, getBrowserPageState, getBrowserScreenshot, getBrowserUsePublicStatus,
} from "../browser-use.js";

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
    await readBody(req);
    sendJson(res, 200, { ok: await closeBrowserSession(rawSessionId) });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
