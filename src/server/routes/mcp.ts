/**
 * ============================================================
 * routes/mcp.ts — MCP server 管理接口
 * ============================================================
 * GET    /api/mcp              全局开关 + 服务器列表 + 连接状态
 * POST   /api/mcp              新增服务器（同 id 覆盖）
 * PATCH  /api/mcp              全局暂停 / 恢复
 * POST   /api/mcp/import       批量导入 .mcp.json
 * PATCH  /api/mcp/:id          局部更新名称 / 命令 / 启停 / 审批
 * POST   /api/mcp/:id/test     测试连接并列出工具（保留连接）
 * DELETE /api/mcp/:id          删除并断开
 * 连接与协议在 server/mcp.ts；这里只做 HTTP 形状与中文错误。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import {
  deleteMcpServer, importMcpServers, isMcpEnabled, listMcpStatus,
  saveMcpServer, setMcpEnabled, testMcpServer, updateMcpServer,
} from "../mcp.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    throw new Error("请求体不是合法的 JSON");
  }
}

async function mcpState(): Promise<{ enabled: boolean; servers: Awaited<ReturnType<typeof listMcpStatus>> }> {
  const [enabled, servers] = await Promise.all([isMcpEnabled(), listMcpStatus()]);
  return { enabled, servers };
}

export async function handleListMcp(res: ServerResponse): Promise<void> {
  const state = await mcpState();
  sendJson(res, 200, state);
}

export async function handleSaveMcp(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const payload = await readJson(req);
    const { server, created } = await saveMcpServer(payload);
    sendJson(res, 200, { server, created, ...(await mcpState()) });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleSetMcpEnabled(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const payload = await readJson(req) as { enabled?: unknown };
    if (typeof payload.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    await setMcpEnabled(payload.enabled);
    sendJson(res, 200, await mcpState());
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleImportMcp(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const payload = await readJson(req) as { config?: unknown; overwrite?: unknown };
    if (payload.config === undefined) throw new Error("缺少 MCP 导入配置");
    if (payload.overwrite !== undefined && typeof payload.overwrite !== "boolean") {
      throw new Error("overwrite 必须是布尔值");
    }
    const result = await importMcpServers(payload.config, payload.overwrite === true);
    sendJson(res, 200, { ...result, ...(await mcpState()) });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleUpdateMcp(res: ServerResponse, req: IncomingMessage, id: string): Promise<void> {
  try {
    const payload = await readJson(req);
    const { server, servers } = await updateMcpServer(decodeURIComponent(id), payload);
    sendJson(res, 200, { server, servers, enabled: await isMcpEnabled() });
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
    sendJson(res, 200, { removed: true, ...(await mcpState()) });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
