/**
 * memory-store.ts — 长期记忆领域服务与旧调用面的兼容层
 * ============================================================
 * 职责：实现保存、版本化、删除、相关性检索、注入预算与作用域过滤；
 * 底层文件交给 `memory/providers/local-store.ts`，后续 Provider 插槽复用语义。
 *
 * 设计立场：scope 是不可回退的安全边界；同 scope + key 的新内容保留旧版本，
 * 注入只取当前问题真正相关的 active 记忆，并以条数 + 字符双预算限制上下文占用。
 */
import { randomUUID } from "node:crypto";
import type { MemoryProfileId, MemoryRecord, MemoryScope, MemorySource } from "./memory/provider.js";
import { DEFAULT_MEMORY_PROFILE, memoryScope, sameMemoryScope } from "./memory/scope.js";
import { rankMemories } from "./memory/providers/local-search.js";
import {
  MAX_ACTIVE_MEMORIES,
  MAX_CONTENT_CHARS,
  MAX_KEY_CHARS,
  ensureLocalStoreLoaded,
  flushLocalUsage,
  loadedLocalRecords,
  localMemoryStoreStatus,
  memoriesFilePath,
  readLocalRecords,
  resetLocalStore,
  touchLocalRecords,
  updateLocalRecords,
} from "./memory/providers/local-store.js";
import { detectSensitiveMemory } from "./memory/sensitive.js";

export type MemoryEntry = MemoryRecord;
export type { MemoryRecord, MemoryScope, MemorySource };

export const MAX_INJECT_MEMORIES = 8;
export const MEMORY_PROMPT_CHAR_BUDGET = 2400;
const MAX_MEMORY_TAGS = 6;
const MAX_MEMORY_TAG_CHARS = 32;

export interface MemoryPromptOptions {
  profileId?: MemoryProfileId;
  query?: string;
  limit?: number;
  charBudget?: number;
}

export interface MemorySaveOptions {
  tags?: string[];
  /** 默认 false；只有设置页显式开启后才允许保存明显 PII。 */
  allowPII?: boolean;
}

function profileScope(profileId: MemoryProfileId | undefined): MemoryScope {
  return memoryScope(profileId ?? DEFAULT_MEMORY_PROFILE);
}

function activeInScope(items: MemoryRecord[], scope: MemoryScope): MemoryRecord[] {
  return items
    .filter((item) => item.status === "active" && sameMemoryScope(item.scope, scope))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim().slice(0, MAX_MEMORY_TAG_CHARS);
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= MAX_MEMORY_TAGS) break;
  }
  return result;
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

/** 新增或更新当前 scope 下的 active 记忆；内容变化时保留 superseded 历史。 */
export async function saveMemory(
  key: string,
  content: string,
  source: MemorySource,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE,
  options: MemorySaveOptions = {}
): Promise<MemoryRecord> {
  const cleanKey = key.trim();
  const cleanContent = content.trim();
  if (!cleanKey) throw new Error("记忆主题（key）不能为空");
  if (!cleanContent) throw new Error("记忆内容不能为空");
  if (cleanKey.length > MAX_KEY_CHARS) throw new Error(`记忆主题过长（上限 ${MAX_KEY_CHARS} 字符）`);
  if (cleanContent.length > MAX_CONTENT_CHARS) {
    throw new Error(`记忆内容过长（${cleanContent.length} 字符，上限 ${MAX_CONTENT_CHARS}）`);
  }
  const finding = detectSensitiveMemory(`${cleanKey}\n${cleanContent}`);
  if (finding) {
    if (finding.kind === "secret") throw new Error(`拒绝保存：${finding.reason}。请改用环境变量或密钥管理`);
    if (!options.allowPII) throw new Error(`拒绝保存：${finding.reason}。如确需保存，请在记忆设置中显式允许 PII`);
  }
  const scope = profileScope(profileId);
  const tags = cleanTags(options.tags);
  return updateLocalRecords((draft) => {
    const activeTotal = draft.filter((item) => item.status === "active").length;
    const existing = draft.find((item) =>
      item.status === "active" &&
      sameMemoryScope(item.scope, scope) &&
      item.key.toLocaleLowerCase() === cleanKey.toLocaleLowerCase()
    );
    const now = Date.now();
    if (existing && existing.content === cleanContent) {
      existing.updatedAt = now;
      existing.source = source;
      if (tags) existing.tags = tags;
      return { ...existing, scope: { ...existing.scope }, tags: [...existing.tags] };
    }
    if (existing) existing.status = "superseded";
    if (!existing && activeTotal >= MAX_ACTIVE_MEMORIES) {
      throw new Error(`记忆已达上限 ${MAX_ACTIVE_MEMORIES} 条，请先在设置里删除不再需要的条目`);
    }
    const entry: MemoryRecord = {
      id: randomUUID(),
      scope: { ...scope },
      key: cleanKey,
      content: cleanContent,
      tags: tags ?? [],
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

/** 确定性相关性检索；命中后更新 lastUsedAt/useCount（1 秒合并落盘）。 */
export async function searchMemories(
  query: string,
  limit = 10,
  profileId: MemoryProfileId = DEFAULT_MEMORY_PROFILE
): Promise<MemoryRecord[]> {
  const items = await listMemoriesAsync(profileId);
  const ranked = rankMemories(items, query, limit);
  const touched = touchLocalRecords(ranked.map((item) => item.record.id));
  const touchedById = new Map(touched.map((item) => [item.id, item]));
  return ranked.map((item) => touchedById.get(item.record.id) ?? item.record);
}

/**
 * 动态生成当轮 system 注记。没有查询、没有命中或外部 Provider 降级时不注入；
 * 最多 8 条 + 2400 字符，超出时明确提示模型可改用 memory_recall 精准查询。
 */
export async function memoryNoteForPrompt(options: MemoryPromptOptions = {}): Promise<string | null> {
  const query = options.query?.trim() ?? "";
  if (!query) return null;
  const profileId = options.profileId ?? DEFAULT_MEMORY_PROFILE;
  const limit = Math.max(1, Math.min(options.limit ?? MAX_INJECT_MEMORIES, MAX_INJECT_MEMORIES));
  const budget = Math.max(200, Math.min(options.charBudget ?? MEMORY_PROMPT_CHAR_BUDGET, MEMORY_PROMPT_CHAR_BUDGET));
  const selected = await searchMemories(query, limit, profileId);
  if (!selected.length) return null;

  const header = "【跨会话长期记忆（当前 Agent 专属，按本轮问题筛选；与用户最新说法冲突时以最新说法为准）】";
  let body = "";
  let omitted = 0;
  for (const [index, entry] of selected.entries()) {
    const full = `\n- [${entry.key}] ${entry.content}`;
    const available = budget - header.length - body.length - 48;
    if (full.length <= available) {
      body += full;
      continue;
    }
    if (available > 80) {
      body += `\n- [${entry.key}] ${entry.content.slice(0, available - entry.key.length - 6).trimEnd()}…`;
    }
    omitted = selected.length - index - 1;
    break;
  }
  if (!body) return null;
  const tail = omitted > 0 ? `\n（因字符预算省略 ${omitted} 条记忆，可用 memory_recall 按关键词查询）` : "";
  return header + body + tail;
}

/** 设置页/诊断用的数据源状态；不包含记忆原文。 */
export function memoryStoreStatus() {
  return localMemoryStoreStatus();
}

export function flushMemoryUsage(): Promise<void> {
  return flushLocalUsage();
}

export { memoriesFilePath };

/** 测试专用：清空内存态并重绑 MEMORIES_FILE。 */
export function resetMemoryStore(): void {
  resetLocalStore();
}
