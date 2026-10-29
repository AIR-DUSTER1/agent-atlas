/**
 * memory/import-export.ts — 本地记忆的可移植快照
 * ============================================================
 * 导入/导出只操作本地记忆文件，确保 HTTP Provider 模式下仍有一份可备份归档；
 * 导入按 scope 隔离、整批校验后一次性原子写入，避免部分成功留下半套数据。
 */
import { randomUUID } from "node:crypto";
import type { MemoryRecord, MemoryScope } from "./provider.js";
import { detectSensitiveMemory } from "./sensitive.js";
import { sameMemoryScope } from "./scope.js";
import {
  MAX_ACTIVE_MEMORIES,
  MAX_CONTENT_CHARS,
  MAX_KEY_CHARS,
  ensureLocalStoreLoaded,
  readLocalRecords,
  updateLocalRecords,
} from "./providers/local-store.js";

export interface MemoryExportV2 {
  schemaVersion: 2;
  exportedAt: number;
  scope: MemoryScope;
  memories: MemoryRecord[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function time(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeImported(item: unknown, scope: MemoryScope, index: number, usedIds: Set<string>, allowPII: boolean): MemoryRecord {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 条记忆格式不正确`);
  const rec = item as Partial<MemoryRecord>;
  const key = text(rec.key);
  const content = text(rec.content);
  if (!key || !content) throw new Error(`第 ${index + 1} 条记忆缺少 key 或 content`);
  if (key.length > MAX_KEY_CHARS) throw new Error(`第 ${index + 1} 条记忆主题过长`);
  if (content.length > MAX_CONTENT_CHARS) throw new Error(`第 ${index + 1} 条记忆内容过长`);
  const sensitive = detectSensitiveMemory(`${key}\n${content}`);
  if (sensitive?.kind === "secret") throw new Error(`第 ${index + 1} 条记忆疑似包含密钥，已拒绝整批导入`);
  if (sensitive?.kind === "pii" && !allowPII) throw new Error(`第 ${index + 1} 条记忆疑似包含 PII；如确需导入请先显式允许 PII`);
  const providedId = text(rec.id);
  const id = providedId && !usedIds.has(providedId) ? providedId : randomUUID();
  usedIds.add(id);
  const now = Date.now();
  return {
    id,
    scope: { ...scope },
    key,
    content,
    tags: Array.isArray(rec.tags) ? rec.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 6) : [],
    source: "import",
    status: rec.status === "superseded" ? "superseded" : "active",
    createdAt: time(rec.createdAt, now),
    updatedAt: time(rec.updatedAt, now),
    ...(typeof rec.lastUsedAt === "number" ? { lastUsedAt: rec.lastUsedAt } : {}),
    ...(typeof rec.useCount === "number" ? { useCount: rec.useCount } : {}),
  };
}

export async function exportLocalMemories(
  scope: MemoryScope,
  options: { includeHistory?: boolean } = {}
): Promise<MemoryExportV2> {
  await ensureLocalStoreLoaded();
  const memories = (await readLocalRecords())
    .filter((item) => sameMemoryScope(item.scope, scope))
    .filter((item) => options.includeHistory || item.status === "active")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { schemaVersion: 2, exportedAt: Date.now(), scope: { ...scope }, memories };
}

export async function importLocalMemories(
  scope: MemoryScope,
  payload: unknown,
  options: { mode?: "merge" | "replace"; allowPII?: boolean } = {}
): Promise<{ imported: number; replaced: boolean }> {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as { memories?: unknown; entries?: unknown; schemaVersion?: unknown }
    : null;
  if (typeof root?.schemaVersion === "number" && root.schemaVersion > 2) {
    throw new Error("导入文件来自更高 schema 版本，请升级应用后再导入");
  }
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.memories)
      ? root.memories
      : Array.isArray(root?.entries)
        ? root.entries
        : null;
  if (!raw) throw new Error("导入文件缺少 memories 数组");
  if (raw.length > 1_000) throw new Error("单次最多导入 1000 条记忆");
  const usedIds = new Set<string>();
  const imported = raw.map((item, index) => normalizeImported(item, scope, index, usedIds, options.allowPII === true));
  const activeImported = imported.filter((item) => item.status === "active").length;
  if (activeImported > MAX_ACTIVE_MEMORIES) throw new Error(`单次最多导入 ${MAX_ACTIVE_MEMORIES} 条 active 记忆`);
  const mode = options.mode === "replace" ? "replace" : "merge";
  await updateLocalRecords((draft) => {
    if (mode === "replace") {
      for (let index = draft.length - 1; index >= 0; index -= 1) {
        if (sameMemoryScope(draft[index].scope, scope)) draft.splice(index, 1);
      }
      draft.push(...imported);
      return;
    }
    const incomingKeys = new Set(
      imported.filter((item) => item.status === "active").map((item) => item.key.toLocaleLowerCase())
    );
    for (const record of draft) {
      if (
        record.status === "active" &&
        sameMemoryScope(record.scope, scope) &&
        incomingKeys.has(record.key.toLocaleLowerCase())
      ) {
        record.status = "superseded";
      }
    }
    draft.push(...imported);
  });
  return { imported: imported.length, replaced: mode === "replace" };
}
