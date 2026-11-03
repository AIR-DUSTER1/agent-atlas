/**
 * routes/memory.ts — Memory Slot 配置、语义索引与运行状态
 * ============================================================
 * GET  /api/memory/config          安全配置视图（Key 只回掩码）
 * PUT  /api/memory/config          合并保存并热切换 Provider / Embedding
 * POST /api/memory/test            对候选/已保存 HTTP 配置做连接测试
 * POST /api/memory/embedding/test  临时测试 Embedding 配置，不落盘
 * POST /api/memory/reindex         重建当前 Agent 的向量索引
 * GET  /api/memory/status           Provider、本地存储与语义索引状态
 */
import { readBody, respondBadRequest } from "../http-body.js";
import { writeAudit } from "../audit.js";
import { memorySlot } from "../../memory/slot.js";
import { localMemoryStoreStatus, readLocalRecords } from "../../memory/providers/local-store.js";
import { isMemoryProfileId, memoryScope } from "../../memory/scope.js";
import {
  configureSemanticMemory,
  embedTexts,
  rebuildMemoryVectorIndex,
  semanticMemoryConfig,
  semanticMemoryStatus,
} from "../../memory/semantic.js";
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

function profileOf(raw: string | null | undefined) {
  const profileId = isMemoryProfileId(raw) ? raw : "general";
  return { profileId, scope: memoryScope(profileId) };
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
      distillationMode: saved.distillation.mode,
      embeddingEnabled: saved.embedding.enabled,
      embeddingModel: saved.embedding.model,
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

/** 不保存配置，只验证 Embedding 地址、鉴权、模型与维度。 */
export async function handleTestEmbeddingMemory(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  const previous = semanticMemoryConfig();
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as MemoryConfigPatch;
    const current = await readMemoryConfig();
    const candidate = mergeMemoryConfigPatch(current, body);
    if (!candidate.embedding.enabled) throw new Error("请先启用语义召回");
    configureSemanticMemory(candidate.embedding);
    const [vector] = await embedTexts(["agentatlas memory embedding test"]);
    sendJson(res, 200, { ok: true, dimensions: vector.length, model: candidate.embedding.model });
  } catch (err) {
    respondBadRequest(res, req, err);
  } finally {
    configureSemanticMemory(previous);
  }
}

export async function handleReindexMemory(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage
): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { profileId?: unknown };
    const raw = typeof body.profileId === "string" ? body.profileId : "general";
    if (!isMemoryProfileId(raw)) throw new Error("profileId 只能是 general、estate 或 job");
    const config = await readMemoryConfig();
    if (config.activeProvider !== "local") throw new Error("语义索引只对内置本地记忆生效，请先切回本地 Provider");
    const scope = memoryScope(raw);
    const records = (await readLocalRecords()).filter((record) =>
      record.scope.profileId === scope.profileId && record.scope.userId === scope.userId && record.status === "active"
    );
    const status = await rebuildMemoryVectorIndex(scope, records);
    writeAudit("memory.semantic.reindexed", { profileId: raw, indexed: status.indexed, model: status.model });
    sendJson(res, 200, { ok: true, status });
  } catch (err) {
    respondBadRequest(res, req, err);
  }
}

export async function handleMemoryStatus(
  res: import("node:http").ServerResponse,
  rawProfileId?: string | null
): Promise<void> {
  const { scope } = profileOf(rawProfileId);
  const localRecords = await readLocalRecords();
  const activeCount = localRecords.filter((record) =>
    record.status === "active" && record.scope.profileId === scope.profileId && record.scope.userId === scope.userId
  ).length;
  sendJson(res, 200, {
    activeProvider: await memorySlot.providerId(),
    health: await memorySlot.health(),
    providers: memorySlot.registered(),
    localStore: localMemoryStoreStatus(),
    semantic: await semanticMemoryStatus(scope, activeCount),
    config: publicMemoryConfig(await readMemoryConfig()),
  });
}