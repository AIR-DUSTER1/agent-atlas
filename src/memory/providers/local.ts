/**
 * providers/local.ts — 默认本地 Memory Provider
 * ============================================================
 * 实现保存、历史版本、作用域过滤、相关性检索与命中统计；文件与迁移仍由
 * local-store 负责，搜索排序由 local-search 负责。CLI 与 Web 使用同一实现。
 */
import type {
  MemoryProvider,
  MemoryProviderHealth,
  MemoryRecord,
  MemorySaveInput,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
} from "../provider.js";
import { rankMemories } from "./local-search.js";
import {
  MAX_ACTIVE_MEMORIES,
  MAX_CONTENT_CHARS,
  MAX_KEY_CHARS,
  ensureLocalStoreLoaded,
  localMemoryStoreStatus,
  readLocalRecords,
  touchLocalRecords,
  updateLocalRecords,
} from "./local-store.js";
import { detectSensitiveMemory } from "../sensitive.js";
import { sameMemoryScope } from "../scope.js";

const MAX_TAGS = 6;
const MAX_TAG_CHARS = 32;

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim().slice(0, MAX_TAG_CHARS);
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local" as const;
  readonly capabilities = {
    read: true as const,
    write: true,
    delete: true,
    search: true as const,
    health: true,
  };

  async health(): Promise<MemoryProviderHealth> {
    const startedAt = Date.now();
    await ensureLocalStoreLoaded();
    const status = localMemoryStoreStatus();
    const mapped = status.state === "future"
      ? "unavailable" as const
      : status.state === "corrupt" || status.state === "error"
        ? "degraded" as const
        : "ok" as const;
    return {
      providerId: this.id,
      status: mapped,
      latencyMs: Date.now() - startedAt,
      ...(status.message ? { message: status.message } : {}),
    };
  }

  async save(input: MemorySaveInput): Promise<MemoryRecord> {
    const cleanKey = input.key.trim();
    const cleanContent = input.content.trim();
    if (!cleanKey) throw new Error("记忆主题（key）不能为空");
    if (!cleanContent) throw new Error("记忆内容不能为空");
    if (cleanKey.length > MAX_KEY_CHARS) throw new Error(`记忆主题过长（上限 ${MAX_KEY_CHARS} 字符）`);
    if (cleanContent.length > MAX_CONTENT_CHARS) {
      throw new Error(`记忆内容过长（${cleanContent.length} 字符，上限 ${MAX_CONTENT_CHARS}）`);
    }
    const finding = detectSensitiveMemory(`${cleanKey}\n${cleanContent}`);
    if (finding) {
      if (finding.kind === "secret") throw new Error(`拒绝保存：${finding.reason}。请改用环境变量或密钥管理`);
      if (!input.allowPII) throw new Error(`拒绝保存：${finding.reason}。如确需保存，请在记忆设置中显式允许 PII`);
    }
    const tags = cleanTags(input.tags);
    return updateLocalRecords((draft) => {
      const activeTotal = draft.filter((item) => item.status === "active").length;
      const existing = draft.find((item) =>
        item.status === "active" &&
        sameMemoryScope(item.scope, input.scope) &&
        item.key.toLocaleLowerCase() === cleanKey.toLocaleLowerCase()
      );
      const now = Date.now();
      if (existing && existing.content === cleanContent) {
        existing.updatedAt = now;
        existing.source = input.source;
        if (tags) existing.tags = tags;
        return { ...existing, scope: { ...existing.scope }, tags: [...existing.tags] };
      }
      if (existing) existing.status = "superseded";
      if (!existing && activeTotal >= MAX_ACTIVE_MEMORIES) {
        throw new Error(`记忆已达上限 ${MAX_ACTIVE_MEMORIES} 条，请先在设置里删除不再需要的条目`);
      }
      const entry: MemoryRecord = {
        id: crypto.randomUUID(),
        scope: { ...input.scope },
        key: cleanKey,
        content: cleanContent,
        tags: tags ?? [],
        source: input.source,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      draft.push(entry);
      return { ...entry, scope: { ...entry.scope }, tags: [...entry.tags] };
    });
  }

  async delete(id: string, scope: MemoryScope): Promise<boolean> {
    return updateLocalRecords((draft) => {
      const index = draft.findIndex((item) => item.id === id && sameMemoryScope(item.scope, scope));
      if (index < 0) return false;
      draft.splice(index, 1);
      return true;
    });
  }

  async list(scope: MemoryScope, options: { includeHistory?: boolean } = {}): Promise<MemoryRecord[]> {
    const items = await readLocalRecords();
    return items
      .filter((item) => sameMemoryScope(item.scope, scope))
      .filter((item) => options.includeHistory || item.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    const items = (await readLocalRecords()).filter((item) => sameMemoryScope(item.scope, query.scope));
    const ranked = rankMemories(items, query.text, MAX_ACTIVE_MEMORIES);
    const selected = ranked.slice(0, Math.max(1, query.limit));
    const touched = touchLocalRecords(selected.map((item) => item.record.id));
    const touchedById = new Map(touched.map((item) => [item.id, item]));
    return {
      records: selected.map((item) => touchedById.get(item.record.id) ?? item.record),
      total: ranked.length,
      degraded: false,
      providerId: this.id,
    };
  }
}

let localProvider: LocalMemoryProvider | null = null;

export function getLocalMemoryProvider(): LocalMemoryProvider {
  localProvider ??= new LocalMemoryProvider();
  return localProvider;
}
