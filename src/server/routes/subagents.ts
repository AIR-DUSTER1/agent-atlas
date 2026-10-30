/**
 * routes/subagents.ts — 子代理配置 CRUD 接口
 * ============================================================
 * GET    /api/subagents            列表 + 模型可用状态
 * POST   /api/subagents            新增运行时子代理
 * PATCH  /api/subagents/:id        编辑 / 启停
 * DELETE /api/subagents/:id        删除
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import {
  createSubagent,
  deleteSubagent,
  getSubagentSettings,
  updateSubagent,
} from "../subagent-settings.js";
import { bumpConfigVersion } from "../sessions.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function handleListSubagents(res: ServerResponse): void {
  sendJson(res, 200, getSubagentSettings());
}

export async function handleCreateSubagent(
  res: ServerResponse,
  req: IncomingMessage,
): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    const snapshot = await createSubagent(body);
    bumpConfigVersion();
    sendJson(res, 200, snapshot);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleUpdateSubagent(
  res: ServerResponse,
  req: IncomingMessage,
  id: string,
): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      throw new Error("enabled 必须是布尔值");
    }
    const snapshot = await updateSubagent(id, body);
    bumpConfigVersion();
    sendJson(res, 200, snapshot);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleDeleteSubagent(
  res: ServerResponse,
  id: string,
): Promise<void> {
  try {
    const snapshot = await deleteSubagent(id);
    bumpConfigVersion();
    sendJson(res, 200, snapshot);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
