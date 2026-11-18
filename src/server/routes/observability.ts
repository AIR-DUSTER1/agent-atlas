/**
 * routes/observability.ts — /metrics 与 /api/diagnostics 响应层
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { clientIp, FailureRateLimiter } from "../security/rate-limit.js";
import { incCounter } from "../observability/metrics.js";
import { log } from "../logging.js";
import { renderMetrics } from "../observability/metrics.js";
import { buildDiagnostics } from "../observability/diagnostics.js";
import { BUILD_INFO } from "../build-info.js";

export function handleVersion(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(BUILD_INFO));
}

export function handleMetrics(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
  res.end(renderMetrics());
}

export async function handleDiagnostics(res: ServerResponse): Promise<void> {
  const body = await buildDiagnostics();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const clientErrorLimiter = new FailureRateLimiter(30, 300, 60_000);

/** 前端只上报错误摘要；不接收 stack、对话内容或附件。 */
export async function handleClientError(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const decision = clientErrorLimiter.recordFailure(clientIp(req));
  if (!decision.allowed) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(decision.retryAfterSeconds) });
    res.end(JSON.stringify({ error: "客户端错误上报过于频繁，请稍后重试" }));
    return;
  }
  const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message.replace(/\s+/g, " ").trim().slice(0, 300) : "unknown";
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : "";
  const commit = typeof body.commit === "string" && /^[0-9a-f]{7,64}$/i.test(body.commit) ? body.commit.toLowerCase() : "";
  const buildId = typeof body.buildId === "string" && /^[a-z]+[A-Za-z0-9._-]{1,119}$/.test(body.buildId) ? body.buildId : "";
  const view = typeof body.view === "string" && /^[a-z0-9_-]{1,60}$/i.test(body.view) ? body.view : "unknown";
  incCounter("agent_client_errors_total", { view });
  log("warn", "client_error", { requestId, version, commit, buildId, view, message });
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}
