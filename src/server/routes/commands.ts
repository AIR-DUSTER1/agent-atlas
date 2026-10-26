/**
 * ============================================================
 * routes/commands.ts — 用户自定义命令的 HTTP 接口
 * ============================================================
 * GET    /api/commands        列出全部命令（前端斜杠菜单与设置页共用）
 * POST   /api/commands        新增或更新（同名覆盖）
 * DELETE /api/commands/:name  删除
 * 校验与持久化都在 server/commands.ts；这里只做 HTTP 形状与中文错误。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { deleteCommand, listCommands, saveCommand } from "../commands.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleListCommands(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { commands: await listCommands() });
}

export async function handleSaveCommand(res: ServerResponse, req: IncomingMessage): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "请求体不是合法的 JSON" });
    return;
  }
  try {
    const { command, created } = await saveCommand(payload);
    sendJson(res, 200, { command, created, commands: await listCommands() });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleDeleteCommand(res: ServerResponse, name: string): Promise<void> {
  try {
    const result = await deleteCommand(decodeURIComponent(name));
    if (!result.removed) {
      sendJson(res, 404, { error: `命令「${decodeURIComponent(name)}」不存在` });
      return;
    }
    sendJson(res, 200, { removed: true, commands: result.commands });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
