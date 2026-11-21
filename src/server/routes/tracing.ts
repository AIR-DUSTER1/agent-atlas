/**
 * ============================================================
 * server/routes/tracing.ts — LangSmith 追踪设置接口
 * ============================================================
 * GET  /api/tracing  返回脱敏后的追踪配置与有效性
 * PUT  /api/tracing  保存追踪配置（Key 不传=保持，空串=清除）
 *
 * 该接口只改观测配置，不启动网络请求，也不把 API Key 回传浏览器。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parsedJsonOf } from "../http-body.js";
import { saveTraceSettings, traceSettingsSnapshot } from "../trace-settings.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function handleGetTracing(res: ServerResponse): void {
  sendJson(res, 200, traceSettingsSnapshot());
}

export async function handleSaveTracing(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const body = parsedJsonOf<Record<string, unknown>>(req)!;
    sendJson(res, 200, await saveTraceSettings(body));
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}