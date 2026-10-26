/**
 * ============================================================
 * routes/mcp.ts — MCP server 管理接口
 * ============================================================
 * GET    /api/mcp              列出配置 + 连接状态 + 已知工具
 * POST   /api/mcp              新增或更新（同 id 覆盖）
 * POST   /api/mcp/:id/test     测试连接并列出工具（保留连接）
 * DELETE /api/mcp/:id          删除并断开
 * 连接与协议在 server/mcp.ts；这里只做 HTTP 形状与中文错误。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { deleteMcpServer, listMcpStatus, saveMcpServer, testMcpServer } from "../mcp.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleListMcp(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { servers: await listMcpStatus() });
}

export async function handleSaveMcp(res: ServerResponse, req: IncomingMessage): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "请求体不是合法的 JSON" });
    return;
  }
  try {
    const { server, created } = await saveMcpServer(payload);
    sendJson(res, 200, { server, created, servers: await listMcpStatus() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleTestMcp(res: ServerResponse, id: string): Promise<void> {
  try {
    const status = await testMcpServer(decodeURIComponent(id));
    sendJson(res, 200, { status });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleDeleteMcp(res: ServerResponse, id: string): Promise<void> {
  const decoded = decodeURIComponent(id);
  try {
    const result = await deleteMcpServer(decoded);
    if (!result.removed) {
      sendJson(res, 404, { error: `MCP server「${decoded}」不存在` });
      return;
    }
    sendJson(res, 200, { removed: true, servers: await listMcpStatus() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
