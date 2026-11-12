/**
 * routes/memories.ts — Memory Slot 管理路由（按 Agent scope 隔离）
 * ============================================================
 * 列表 / 自动候选确认与拒绝 / 导出导入都只依赖统一 Slot；
 * profileId 在三类 Agent 之间强隔离，任何路由都不能跨 scope 查找或删除。
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

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function respondInvalidScope(res: import("node:http").ServerResponse): void {
  sendJson(res, 400, { error: "profileId 只能是 general、estate 或 job" });
}

export async function handleListMemories(
  res: import("node:http").ServerResponse,
  rawProfileId?: string | null,
  includeHistory = false
): Promise<void> {
  const profileId = profileIdOf(rawProfileId);
  if (!profileId) return respondInvalidScope(res);
  const memories = await memorySlot.list(memoryScope(profileId), { includeHistory });
  sendJson(res, 200, {
    memories,
    profileId,
    providerId: await memorySlot.providerId(),
    providers: memorySlot.registered(),
    store: localMemoryStoreStatus(),
  });
}

export async function handleListMemoryCandidates(
  res: import("node:http").ServerResponse,
  rawProfileId?: string | null
): Promise<void> {
  const profileId = profileIdOf(rawProfileId);
  if (!profileId) return respondInvalidScope(res);
  const memories = await memorySlot.list(memoryScope(profileId), { statuses: ["candidate"] });
  sendJson(res, 200, { memories, profileId });
}

export async function handleConfirmMemory(
  res: import("node:http").ServerResponse,
  id: string,
  rawProfileId?: string | null
): Promise<void> {
  const profileId = profileIdOf(rawProfileId);
  if (!profileId) return respondInvalidScope(res);
  try {
    const entry = await memorySlot.confirm(id, memoryScope(profileId));
    if (!entry) {
      sendJson(res, 404, { error: "候选记忆不存在、已被处理，或不属于当前 Agent" });
      return;
    }
    sendJson(res, 200, { ok: true, entry, profileId });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleRejectMemory(
  res: import("node:http").ServerResponse,
  id: string,
  rawProfileId?: string | null
): Promise<void> {
  const profileId = profileIdOf(rawProfileId);
  if (!profileId) return respondInvalidScope(res);
  try {
    const gone = await memorySlot.reject(id, memoryScope(profileId));
    if (!gone) {
      sendJson(res, 404, { error: "候选记忆不存在、已被处理，或不属于当前 Agent" });
      return;
    }
    sendJson(res, 200, { ok: true, profileId });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
      sendJson(res, 404, { error: "该记忆不存在（可能已被删除，或不属于当前 Agent）" });
      return;
    }
    sendJson(res, 200, { ok: true, profileId });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
    sendJson(res, 200, { ok: true, profileId, ...result });
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}
