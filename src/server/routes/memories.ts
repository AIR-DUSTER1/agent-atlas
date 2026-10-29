/**
 * routes/memories.ts — Memory Slot 管理路由（按 Agent scope 隔离）
 * ============================================================
 * GET    /api/memories?profileId=general|estate&history=1
 * POST   /api/memories   { profileId?, key, content, tags?, allowPII? }
 * DELETE /api/memories/:id?profileId=general|estate
 * 路由只依赖统一 Slot；本地 / HTTP Provider 的选择由注册表决定。
 */
import { readBody, respondBadRequest } from "../http-body.js";
import type { MemoryProfileId } from "../../memory/provider.js";
import { memoryScope, isMemoryProfileId } from "../../memory/scope.js";
import { memorySlot } from "../../memory/slot.js";
import { localMemoryStoreStatus } from "../../memory/providers/local-store.js";
import { exportLocalMemories, importLocalMemories } from "../../memory/import-export.js";
import { readMemoryConfig } from "../memory-config.js";

function profileIdOf(raw: string | null | undefined): MemoryProfileId | null {
  if (!raw) return "general";
  return isMemoryProfileId(raw) ? raw : null;
}

function respondInvalidScope(res: import("node:http").ServerResponse): void {
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "profileId 只能是 general 或 estate" }));
}

export async function handleListMemories(
  res: import("node:http").ServerResponse,
  rawProfileId?: string | null,
  includeHistory = false
): Promise<void> {
  const profileId = profileIdOf(rawProfileId);
  if (!profileId) return respondInvalidScope(res);
  const memories = await memorySlot.list(memoryScope(profileId), { includeHistory });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    memories,
    profileId,
    providerId: await memorySlot.providerId(),
    providers: memorySlot.registered(),
    store: localMemoryStoreStatus(),
  }));
}

export async function handleSaveMemory(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as {
    profileId?: unknown;
    key?: unknown;
    content?: unknown;
    tags?: unknown;
  };
  const profileId = profileIdOf(typeof body.profileId === "string" ? body.profileId : undefined);
  if (!profileId) return respondInvalidScope(res);
  const key = typeof body.key === "string" ? body.key : "";
  const content = typeof body.content === "string" ? body.content : "";
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((item): item is string => typeof item === "string")
    : undefined;
  if (!key.trim() || !content.trim()) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "主题（key）与内容（content）都不能为空" }));
    return;
  }
  try {
    const config = await readMemoryConfig();
    const entry = await memorySlot.save({
      scope: memoryScope(profileId),
      key,
      content,
      source: "user",
      ...(tags ? { tags } : {}),
      ...(config.local.allowPII ? { allowPII: true } : {}),
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, entry, profileId }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleDeleteMemory(
  res: import("node:http").ServerResponse,
  id: string,
  rawProfileId?: string | null
): Promise<void> {
  const profileId = profileIdOf(rawProfileId);
  if (!profileId) return respondInvalidScope(res);
  try {
    const gone = await memorySlot.delete(id, memoryScope(profileId));
    if (!gone) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "该记忆不存在（可能已被删除，或不属于当前 Agent）" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, profileId }));
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}
export async function handleExportMemories(
  res: import("node:http").ServerResponse,
  rawProfileId?: string | null,
  includeHistory = false
): Promise<void> {
  const profileId = profileIdOf(rawProfileId);
  if (!profileId) return respondInvalidScope(res);
  const snapshot = await exportLocalMemories(memoryScope(profileId), { includeHistory });
  const date = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="memories-${profileId}-${date}.json"`,
  });
  res.end(JSON.stringify(snapshot, null, 2));
}

export async function handleImportMemories(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      profileId?: unknown;
      mode?: unknown;
      snapshot?: unknown;
    };
    const profileId = profileIdOf(typeof body.profileId === "string" ? body.profileId : undefined);
    if (!profileId) return respondInvalidScope(res);
    const config = await readMemoryConfig();
    const result = await importLocalMemories(memoryScope(profileId), body.snapshot, {
      mode: body.mode === "replace" ? "replace" : "merge",
      allowPII: config.local.allowPII,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, profileId, ...result }));
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}
