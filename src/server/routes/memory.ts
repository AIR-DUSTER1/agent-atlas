/**
 * routes/memory.ts — Memory Slot 配置、连接测试与运行状态
 * ============================================================
 * GET  /api/memory/config  安全配置视图（Key 只回掩码）
 * PUT  /api/memory/config  合并保存并热切换 Provider
 * POST /api/memory/test    对候选/已保存 HTTP 配置做连接测试
 * GET  /api/memory/status  Provider + 本地文件状态
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { writeAudit } from "../audit.js";
import { memorySlot } from "../../memory/slot.js";
import { localMemoryStoreStatus } from "../../memory/providers/local-store.js";
import {
  mergeMemoryConfigPatch,
  publicMemoryConfig,
  readMemoryConfig,
  saveMemoryConfig,
  type MemoryConfigPatch,
} from "../memory-config.js";
import { applyMemoryRuntime, testHttpMemoryConfig } from "../memory-http.js";

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleGetMemoryConfig(res: import("node:http").ServerResponse): Promise<void> {
  sendJson(res, 200, { config: publicMemoryConfig(await readMemoryConfig()) });
}

export async function handleUpdateMemoryConfig(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as MemoryConfigPatch;
    const saved = await saveMemoryConfig(body);
    const runtime = await applyMemoryRuntime(saved);
    writeAudit("memory.config.updated", {
      providerId: runtime.providerId,
      httpEnabled: saved.http.enabled,
      preset: saved.http.preset,
      writeEnabled: saved.http.writeEnabled,
      allowPII: saved.local.allowPII,
    });
    sendJson(res, 200, {
      ok: true,
      config: publicMemoryConfig(saved),
      providerId: runtime.providerId,
      providers: runtime.registered,
    });
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleTestMemory(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    const raw = (await readBody(req)) || "{}";
    const parsed = raw.trim() ? JSON.parse(raw) as MemoryConfigPatch : {};
    const current = await readMemoryConfig();
    const candidate = mergeMemoryConfigPatch(current, parsed);
    if (!candidate.http.enabled || !candidate.http.baseURL) {
      throw new Error("请先启用 HTTP 记忆并填写 baseURL");
    }
    const health = await testHttpMemoryConfig(candidate.http);
    sendJson(res, 200, { ok: health.status === "ok", health });
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleMemoryStatus(res: import("node:http").ServerResponse): Promise<void> {
  sendJson(res, 200, {
    activeProvider: await memorySlot.providerId(),
    health: await memorySlot.health(),
    providers: memorySlot.registered(),
    localStore: localMemoryStoreStatus(),
    config: publicMemoryConfig(await readMemoryConfig()),
  });
}
