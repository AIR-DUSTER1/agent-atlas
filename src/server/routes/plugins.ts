/**
 * ============================================================
 * routes/plugins.ts — 内置插件目录与启停接口
 * ============================================================
 * GET   /api/plugins              读取三类插件当前启停状态
 * PATCH /api/plugins/:id          只切换 enabled，不碰插件自身配置
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../http-body.js";
import { getPluginSettings, setPluginEnabled } from "../plugin-settings.js";
import { bumpConfigVersion } from "../sessions.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function handleListPlugins(res: ServerResponse): void {
  sendJson(res, 200, getPluginSettings());
}

export async function handleSetPluginEnabled(
  res: ServerResponse,
  req: IncomingMessage,
  id: string
): Promise<void> {
  try {
    const payload = JSON.parse((await readBody(req)) || "{}") as { enabled?: unknown };
    const before = getPluginSettings().enabled;
    const after = await setPluginEnabled(id, payload.enabled);
    if (before[id as keyof typeof before] !== after.enabled[id as keyof typeof after.enabled]) {
      // 工具 allowlist 随插件状态变化；已有会话下一条消息前重建图。
      bumpConfigVersion();
    }
    sendJson(res, 200, after);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
