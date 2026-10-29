/**
 * memory-store.ts — 长期记忆领域服务与旧调用面的兼容层
 * ============================================================
 * 职责：实现保存、删除、检索和作用域过滤；底层文件与 schema 交给
 * `memory/providers/local-store.ts`，后续 Provider 插槽会复用同一语义。
 *
 * 设计立场：scope 是必填领域边界，旧调用未传时只回退到 general，绝不跨域；
 * 同 scope + key 更新保留稳定 id，任何 Agent 都不能借默认值读写 estate 数据。
 */
import { randomUUID } from "node:crypto";
import type { MemoryProfileId, MemoryRecord, MemoryScope, MemorySource } from "./memory/provider.js";
import { DEFAULT_MEMORY_PROFILE, memoryScope, sameMemoryScope } from "./memory/scope.js";
import {
  MAX_ACTIVE_MEMORIES,
  MAX_CONTENT_CHARS,
  MAX_KEY_CHARS,
  ensureLocalStoreLoaded,
  loadedLocalRecords,
  localMemoryStoreStatus,
  memoriesFilePath,
  readLocalRecords,
  resetLocalStore,
  updateLocalRecords,
} from "./memory/providers/local-store.js";

export type MemoryEntry = MemoryRecord;
export type { MemoryRecord, MemoryScope, MemorySource };

/** 每轮注入上限；M2 会在此基础上加入相关性与字符预算。 */
const DEFAULT_INJECT_LIMIT = 30;

export interface MemoryPromptOptions {
  profileId?: MemoryProfileId;
  query?: string;
  limit?: number;
}

function profileScope(profileId: MemoryProfileId | undefined): MemoryScope {
  return memoryScope(profileId ?? DEFAULT_MEMORY_PROFILE);
}

function activeInScope(items: MemoryRecord[], scope: MemoryScope): MemoryRecord[] {
  return items
    .filter((item) => item.status === "active" && sameMemoryScope(item.scope, scope))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadMemories(profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE): Promise<number> {
  await ensureLocalStoreLoaded();
  return activeInScope(await readLocalRecords(), profileScope(profileId)).length;
}

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

/** 异步列表是唯一可靠入口：确保文件加载后再按 scope 过滤。 */
export async function listMemoriesAsync(
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE,
  options: { includeHistory?: boolean } = {}
): Promise<MemoryRecord[]> {
  const scope = profileScope(profileId);
  const items = await readLocalRecords();
  const filtered = items.filter((item) => sameMemoryScope(item.scope, scope));
  return (options.includeHistory ? filtered : filtered.filter((item) => item.status === "active"))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 新增或更新当前 scope 下的 active 记忆；返回落库后的条目。 */
export async function saveMemory(
  key: string,
  content: string,
  source: MemorySource,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE,
  options: { tags?: string[] } = {}
): Promise<MemoryRecord> {
  const cleanKey = key.trim();
  const cleanContent = content.trim();
  if (!cleanKey) throw new Error("记忆主题（key）不能为空");
  if (!cleanContent) throw new Error("记忆内容不能为空");
  if (cleanKey.length > MAX_KEY_CHARS) throw new Error(`记忆主题过长（上限 ${MAX_KEY_CHARS} 字符）`);
  if (cleanContent.length > MAX_CONTENT_CHARS) {
    throw new Error(`记忆内容过长（${cleanContent.length} 字符，上限 ${MAX_CONTENT_CHARS}）`);
  }
  const scope = profileScope(profileId);
  return updateLocalRecords((draft) => {
    const activeTotal = draft.filter((item) => item.status === "active").length;
    const existing = draft.find((item) =>
      item.status === "active" &&
      sameMemoryScope(item.scope, scope) &&
      item.key.toLocaleLowerCase() === cleanKey.toLocaleLowerCase()
    );
    const now = Date.now();
    if (existing) {
      existing.content = cleanContent;
      existing.source = source;
      existing.updatedAt = now;
      if (options.tags) existing.tags = [...options.tags];
      return { ...existing, scope: { ...existing.scope }, tags: [...existing.tags] };
    }
    if (activeTotal >= MAX_ACTIVE_MEMORIES) {
      throw new Error(`记忆已达上限 ${MAX_ACTIVE_MEMORIES} 条，请先在设置里删除不再需要的条目`);
    }
    const entry: MemoryRecord = {
      id: randomUUID(),
      scope: { ...scope },
      key: cleanKey,
      content: cleanContent,
      tags: options.tags ? [...options.tags] : [],
      source,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    draft.push(entry);
    return { ...entry, scope: { ...entry.scope }, tags: [...entry.tags] };
  });
}

export async function deleteMemory(
  id: string,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE
): Promise<boolean> {
  const scope = profileScope(profileId);
  return updateLocalRecords((draft) => {
    const index = draft.findIndex((item) => item.id === id && sameMemoryScope(item.scope, scope));
    if (index < 0) return false;
    draft.splice(index, 1);
    return true;
  });
}

/** 关键词检索（M1 兼容实现；M2 会替换为确定性相关性评分）。 */
export async function searchMemories(
  query: string,
  limit = 10,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE
): Promise<MemoryRecord[]> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = await listMemoriesAsync(profileId);
  if (!terms.length) return items.slice(0, limit);
  return items
    .filter((entry) => {
      const haystack = `${entry.key}\n${entry.content}\n${entry.tags.join(" ")}`.toLocaleLowerCase();
      return terms.some((term) => haystack.includes(term));
    })
    .slice(0, limit);
}

/**
 * 动态生成当轮 system 注记，只读取当前 profile 的 active 记忆。
 * 不写入 checkpoint，因此不会在长会话中反复累积。
 */
export async function memoryNoteForPrompt(options: MemoryPromptOptions = {}): Promise<string | null> {
  const profileId = options.profileId ?? DEFAULT_MEMORY_PROFILE;
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_INJECT_LIMIT, 8));
  const query = options.query?.trim() ?? "";
  const selected = query
    ? await searchMemories(query, limit, profileId)
    : (await listMemoriesAsync(profileId)).slice(0, limit);
  if (!selected.length) return null;
  const lines = selected.map((entry) => `- [${entry.key}] ${entry.content}`);
  return `【跨会话长期记忆（当前 Agent 专属，回答时遵循；与当前对话冲突时以用户最新说法为准）】\n${lines.join("\n")}`;
}

/** 设置页/诊断用的数据源状态；不包含记忆原文。 */
export function memoryStoreStatus() {
  return localMemoryStoreStatus();
}

export { memoriesFilePath };

/** 测试专用：清空内存态并重绑 MEMORIES_FILE。 */
export function resetMemoryStore(): void {
  resetLocalStore();
}
