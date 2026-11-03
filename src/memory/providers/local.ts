/**
 * providers/local.ts — 默认本地 Memory Provider
 * ============================================================
 * 实现保存、候选确认、生命周期、作用域过滤、相关性检索与命中统计；文件与迁移
 * 仍由 local-store 负责。CLI 与 Web 使用同一实现，Agent 只能看到统一 Provider 契约。
 */
import type {
  MemoryListOptions,
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
  MAX_CONTENT_CHARS,
  MAX_KEY_CHARS,
  activeMemoryLimit,
  ensureLocalStoreLoaded,
  localMemoryStoreStatus,
  readLocalRecords,
  refreshLocalLifecycle,
  touchLocalRecords,
  updateLocalRecords,
} from "./local-store.js";
import { detectSensitiveMemory } from "../sensitive.js";
import { sameMemoryScope } from "../scope.js";
import { expirationForCategory } from "../lifecycle.js";
import { hybridMemoryRank, scheduleMemoryEmbedding, scheduleVectorRemoval } from "../semantic.js";

const MAX_TAGS = 6;
const MAX_TAG_CHARS = 32;
const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function statusMatches(record: MemoryRecord, options: MemoryListOptions): boolean {
  if (options.statuses?.length) return options.statuses.includes(record.status);
  return options.includeHistory === true || record.status === "active";
}

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local" as const;
  readonly capabilities = {
    read: true as const,
    write: true,
    delete: true,
    search: true as const,
    health: true,
    lifecycle: true,
  };

  async health(): Promise<MemoryProviderHealth> {
    const startedAt = Date.now();
    await ensureLocalStoreLoaded();
    const status = localMemoryStoreStatus();
    const mapped = status.state === "future"
      ? "unavailable" as const
      : status.state === "corrupt" || status.state === "error" || status.state === "degraded"
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
    const nextStatus = input.status ?? "active";
    const entry = await updateLocalRecords((draft) => {
      const now = Date.now();
      const category = input.category ?? "other";
      const scoped = draft.filter((item) => sameMemoryScope(item.scope, input.scope));
      const existing = scoped.find((item) =>
        item.status === nextStatus &&
        item.key.toLocaleLowerCase() === cleanKey.toLocaleLowerCase()
      );
      if (existing && existing.content === cleanContent) {
        existing.updatedAt = now;
        existing.source = input.source;
        existing.confidence = Math.max(existing.confidence ?? 1, input.confidence ?? 1);
        if (tags) existing.tags = tags;
        if (nextStatus === "active") {
          existing.lastConfirmedAt = now;
          existing.expiresAt = input.expiresAt ?? expirationForCategory(category, now);
        }
        return { ...existing, scope: { ...existing.scope }, tags: [...existing.tags] };
      }
      if (nextStatus === "active") {
        const activeTotal = scoped.filter((item) => item.status === "active").length;
        const sameKeyActive = scoped.find((item) =>
          item.status === "active" && item.key.toLocaleLowerCase() === cleanKey.toLocaleLowerCase()
        );
        if (!sameKeyActive && activeTotal >= activeMemoryLimit()) {
          throw new Error(`当前 Agent 的长期记忆已达上限 ${activeMemoryLimit()} 条，请先在设置里删除不再需要的条目`);
        }
        if (sameKeyActive) {
          sameKeyActive.status = "superseded";
          sameKeyActive.updatedAt = now;
        }
      } else {
        // 候选更新只替换同主题的旧候选，绝不能提前覆盖当前 active 记忆。
        for (const item of scoped) {
          if (item.status === "candidate" && item.key.toLocaleLowerCase() === cleanKey.toLocaleLowerCase()) {
            item.status = "archived";
            item.updatedAt = now;
          }
        }
      }
      const created: MemoryRecord = {
        id: crypto.randomUUID(),
        scope: { ...input.scope },
        key: cleanKey,
        content: cleanContent,
        tags: tags ?? [],
        source: input.source,
        status: nextStatus,
        category,
        confidence: input.confidence ?? (nextStatus === "active" ? 1 : 0.7),
        ...(input.expiresAt
          ? { expiresAt: input.expiresAt }
          : nextStatus === "candidate"
            ? { expiresAt: now + CANDIDATE_TTL_MS }
            : { expiresAt: expirationForCategory(category, now) }),
        ...(nextStatus === "active" ? { lastConfirmedAt: now } : {}),
        ...(input.origin ? { origin: { ...input.origin } } : {}),
        createdAt: now,
        updatedAt: now,
      };
      draft.push(created);
      return { ...created, scope: { ...created.scope }, tags: [...created.tags] };
    });
    if (entry.status === "active") scheduleMemoryEmbedding(entry);
    return entry;
  }

  async delete(id: string, scope: MemoryScope): Promise<boolean> {
    const gone = await updateLocalRecords((draft) => {
      const index = draft.findIndex((item) => item.id === id && sameMemoryScope(item.scope, scope));
      if (index < 0) return false;
      draft.splice(index, 1);
      return true;
    });
    if (gone) scheduleVectorRemoval(scope, id);
    return gone;
  }

  async confirm(id: string, scope: MemoryScope, options: { expiresAt?: number } = {}): Promise<MemoryRecord | null> {
    const confirmed = await updateLocalRecords((draft) => {
      const candidate = draft.find((item) =>
        item.id === id && sameMemoryScope(item.scope, scope) && item.status === "candidate"
      );
      if (!candidate) return null;
      const now = Date.now();
      for (const item of draft) {
        if (
          item.id !== candidate.id &&
          item.status === "active" &&
          sameMemoryScope(item.scope, scope) &&
          item.key.toLocaleLowerCase() === candidate.key.toLocaleLowerCase()
        ) {
          item.status = "superseded";
          item.replacedBy = candidate.id;
          item.updatedAt = now;
        }
      }
      candidate.status = "active";
      candidate.updatedAt = now;
      candidate.lastConfirmedAt = now;
      candidate.staleAt = undefined;
      candidate.expiresAt = options.expiresAt ?? expirationForCategory(candidate.category, now);
      return { ...candidate, scope: { ...candidate.scope }, tags: [...candidate.tags] };
    });
    if (confirmed) scheduleMemoryEmbedding(confirmed);
    return confirmed;
  }

  async reject(id: string, scope: MemoryScope): Promise<boolean> {
    return this.delete(id, scope);
  }

  async list(scope: MemoryScope, options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    await refreshLocalLifecycle();
    const items = await readLocalRecords();
    return items
      .filter((item) => sameMemoryScope(item.scope, scope))
      .filter((item) => statusMatches(item, options))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    await refreshLocalLifecycle();
    const items = (await readLocalRecords()).filter((item) => sameMemoryScope(item.scope, query.scope));
    const ranked = rankMemories(items, query.text, activeMemoryLimit());
    const hybrid = await hybridMemoryRank(items, query.text, Math.max(1, query.limit));
    const touched = touchLocalRecords(hybrid.records.map((item) => item.id));
    const touchedById = new Map(touched.map((item) => [item.id, item]));
    return {
      records: hybrid.records.map((item) => touchedById.get(item.id) ?? item),
      total: ranked.length,
      degraded: hybrid.degraded,
      providerId: this.id,
      ...(hybrid.message ? { message: hybrid.message } : {}),
    };
  }
}

let localProvider: LocalMemoryProvider | null = null;

export function getLocalMemoryProvider(): LocalMemoryProvider {
  localProvider ??= new LocalMemoryProvider();
  return localProvider;
}