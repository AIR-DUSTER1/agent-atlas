/**
 * memory-store.ts — Memory Slot 的兼容门面
 * ============================================================
 * 旧调用方可以继续使用 save/list/search/note；内部已改为走 `memory/slot.ts`。
 * 同步 list 只反映本地文件，便于备份/诊断；所有 Agent、工具与管理 API 使用 Slot。
 */
import type { MemoryProfileId, MemoryRecord, MemoryScope, MemorySource } from "./memory/provider.js";
import { DEFAULT_MEMORY_PROFILE, memoryScope, sameMemoryScope } from "./memory/scope.js";
import {
  MAX_INJECT_MEMORIES,
  MEMORY_PROMPT_CHAR_BUDGET,
  memorySlot,
  resetMemorySlotForTests,
  type MemoryNoteOptions,
} from "./memory/slot.js";
import {
  ensureLocalStoreLoaded,
  flushLocalUsage,
  loadedLocalRecords,
  localMemoryStoreStatus,
  memoriesFilePath,
  resetLocalStore,
} from "./memory/providers/local-store.js";
import { getLocalMemoryProvider } from "./memory/providers/local.js";

export type MemoryEntry = MemoryRecord;
export type { MemoryRecord, MemoryScope, MemorySource };
export { MAX_INJECT_MEMORIES, MEMORY_PROMPT_CHAR_BUDGET };

export interface MemoryPromptOptions {
  profileId?: MemoryProfileId;
  query?: string;
  limit?: number;
  charBudget?: number;
}

export interface MemorySaveOptions {
  tags?: string[];
  allowPII?: boolean;
}

function profileScope(profileId: MemoryProfileId | undefined): MemoryScope {
  return memoryScope(profileId ?? DEFAULT_MEMORY_PROFILE);
}

export async function loadMemories(profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE): Promise<number> {
  await ensureLocalStoreLoaded();
  return (await getLocalMemoryProvider().list(profileScope(profileId))).length;
}

/** 同步视图只用于已加载的本地文件；跨 Provider 列表请用 listMemoriesAsync。 */
export function listMemories(
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE,
  options: { includeHistory?: boolean } = {}
): MemoryRecord[] {
  const scope = profileScope(profileId);
  return loadedLocalRecords()
    .filter((item) => sameMemoryScope(item.scope, scope))
    .filter((item) => options.includeHistory || item.status === "active")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listMemoriesAsync(
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE,
  options: { includeHistory?: boolean } = {}
): Promise<MemoryRecord[]> {
  return memorySlot.list(profileScope(profileId), options);
}

export async function saveMemory(
  key: string,
  content: string,
  source: MemorySource,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE,
  options: MemorySaveOptions = {}
): Promise<MemoryRecord> {
  return memorySlot.save({
    scope: profileScope(profileId),
    key,
    content,
    source,
    ...(options.tags ? { tags: options.tags } : {}),
    ...(options.allowPII ? { allowPII: true } : {}),
  });
}

export async function deleteMemory(
  id: string,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE
): Promise<boolean> {
  return memorySlot.delete(id, profileScope(profileId));
}

export async function searchMemories(
  query: string,
  limit = 10,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE
): Promise<MemoryRecord[]> {
  const result = await memorySlot.search({
    text: query,
    scope: profileScope(profileId),
    limit,
  });
  return result.records;
}

export async function memoryNoteForPrompt(options: MemoryPromptOptions = {}): Promise<string | null> {
  const noteOptions: MemoryNoteOptions = {
    scope: profileScope(options.profileId),
    query: options.query ?? "",
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.charBudget !== undefined ? { charBudget: options.charBudget } : {}),
  };
  return memorySlot.note(noteOptions);
}

/** 设置页/诊断用的本地数据源状态；不包含记忆原文。 */
export function memoryStoreStatus() {
  return localMemoryStoreStatus();
}

export function flushMemoryUsage(): Promise<void> {
  return flushLocalUsage();
}

export { memoriesFilePath };

/** 测试专用：清空本地内存态、重绑 MEMORIES_FILE，并重置 Slot 注册表。 */
export function resetMemoryStore(): void {
  resetLocalStore();
  resetMemorySlotForTests();
}
