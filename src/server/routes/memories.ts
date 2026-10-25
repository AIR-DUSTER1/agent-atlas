/**
 * routes/memories.ts — 跨会话长期记忆的管理路由（设置页「记忆」弹窗）
 * ============================================================
 * GET    /api/memories        列出全部记忆（updatedAt 倒序）
 * POST   /api/memories        新增或更新（同 key 覆盖；source 标 user）
 * DELETE /api/memories/:id    删除指定条目
 * 只动本服务的 .setting/memories.json，属低风险操作：不走审批、不进 audit
 * （与 Agent 工具 memory_save 同一存储，见 src/memory-store.ts）。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { deleteMemory, listMemories, loadMemories, saveMemory } from "../../memory-store.js";

export async function handleListMemories(res: import("node:http").ServerResponse): Promise<void> {
  await loadMemories();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ memories: listMemories() }));
}

export async function handleSaveMemory(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as { key?: unknown; content?: unknown };
  const key = typeof body.key === "string" ? body.key : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!key.trim() || !content.trim()) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "主题（key）与内容（content）都不能为空" }));
    return;
  }
  try {
    const entry = await saveMemory(key, content, "user");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, entry }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleDeleteMemory(
  res: import("node:http").ServerResponse,
  id: string
): Promise<void> {
  const gone = await deleteMemory(id);
  if (!gone) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "该记忆不存在（可能已被删除）" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
}
