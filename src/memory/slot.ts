/**
 * slot.ts — Memory Provider 统一门面
 * ============================================================
 * Agent 工具、workflow、管理 API 只依赖本模块。它负责默认 Provider、能力校验、
 * 检索降级和注入预算；具体本地 / HTTP 差异不会泄漏到调用方。
 */
import type {
  MemoryProvider,
  MemoryProviderHealth,
  MemoryProviderId,
  MemoryRecord,
  MemorySaveInput,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
} from "./provider.js";
import { getLocalMemoryProvider } from "./providers/local.js";
import {
  activateMemoryProvider,
  activeMemoryProviderId,
  getActiveMemoryProvider,
  getMemoryProvider,
  registerMemoryProvider,
  registeredMemoryProviders,
  resetMemoryRegistryForTests,
} from "./registry.js";

export const MAX_INJECT_MEMORIES = 8;
export const MEMORY_PROMPT_CHAR_BUDGET = 2400;

export interface MemoryMetricsSink {
  save(providerId: MemoryProviderId, ok: boolean, latencyMs: number, sensitiveBlocked: boolean): void;
  recall(providerId: MemoryProviderId, profileId: string, hit: boolean, count: number, degraded: boolean, latencyMs: number): void;
  injected(providerId: MemoryProviderId, profileId: string, count: number): void;
  health(providerId: MemoryProviderId, status: string, latencyMs: number): void;
}

const noopMetrics: MemoryMetricsSink = {
  save: () => {},
  recall: () => {},
  injected: () => {},
  health: () => {},
};
let metricsSink: MemoryMetricsSink = noopMetrics;

/** 由 server 层注入 Prometheus sink；memory 领域本身不依赖 server。 */
export function configureMemoryMetricsSink(sink: MemoryMetricsSink | null): void {
  metricsSink = sink ?? noopMetrics;
}

export interface MemoryNoteOptions {
  scope: MemoryScope;
  query: string;
  limit?: number;
  charBudget?: number;
}

function ensureReady(): void {
  if (!getMemoryProvider("local")) {
    registerMemoryProvider(getLocalMemoryProvider());
  }
  if (activeMemoryProviderId() === null) activateMemoryProvider("local");
}

function buildMemoryNote(
  result: MemorySearchResult,
  limit: number,
  budget: number
): string | null {
  if (result.degraded || !result.records.length) return null;
  const selected = result.records.slice(0, limit);
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

export const memorySlot = {
  async providerId(): Promise<MemoryProviderId> {
    ensureReady();
    return getActiveMemoryProvider().id;
  },

  registered(): ReturnType<typeof registeredMemoryProviders> {
    ensureReady();
    return registeredMemoryProviders();
  },

  register(provider: MemoryProvider, options: { replace?: boolean; activate?: boolean } = {}): void {
    registerMemoryProvider(provider, options);
  },

  activate(id: MemoryProviderId): void {
    ensureReady();
    activateMemoryProvider(id);
  },

  async health(): Promise<MemoryProviderHealth> {
    ensureReady();
    const provider = getActiveMemoryProvider();
    const startedAt = Date.now();
    try {
      const result = await provider.health();
      metricsSink.health(result.providerId, result.status, result.latencyMs ?? Date.now() - startedAt);
      return result;
    } catch (error) {
      const result: MemoryProviderHealth = {
        providerId: provider.id,
        status: "unavailable",
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      };
      metricsSink.health(result.providerId, result.status, result.latencyMs ?? 0);
      return result;
    }
  },

  async save(input: MemorySaveInput): Promise<MemoryRecord> {
    ensureReady();
    const provider = getActiveMemoryProvider();
    const startedAt = Date.now();
    if (!provider.capabilities.write) {
      const error = new Error(`记忆 Provider「${provider.id}」当前为只读，不能保存`);
      metricsSink.save(provider.id, false, Date.now() - startedAt, false);
      throw error;
    }
    try {
      const record = await provider.save(input);
      metricsSink.save(provider.id, true, Date.now() - startedAt, false);
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metricsSink.save(provider.id, false, Date.now() - startedAt, /拒绝保存/.test(message));
      throw error;
    }
  },

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    ensureReady();
    const provider = getActiveMemoryProvider();
    const startedAt = Date.now();
    try {
      const result = await provider.search(query);
      metricsSink.recall(provider.id, query.scope.profileId, result.records.length > 0, result.records.length, result.degraded, Date.now() - startedAt);
      return result;
    } catch (error) {
      metricsSink.recall(provider.id, query.scope.profileId, false, 0, true, Date.now() - startedAt);
      return {
        records: [],
        total: 0,
        degraded: true,
        providerId: provider.id,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async list(scope: MemoryScope, options: { includeHistory?: boolean } = {}): Promise<MemoryRecord[]> {
    ensureReady();
    const provider = getActiveMemoryProvider();
    if (!provider.capabilities.read) return [];
    return provider.list(scope, options);
  },

  async delete(id: string, scope: MemoryScope): Promise<boolean> {
    ensureReady();
    const provider = getActiveMemoryProvider();
    if (!provider.capabilities.delete) throw new Error(`记忆 Provider「${provider.id}」不支持删除`);
    return provider.delete(id, scope);
  },

  async note(options: MemoryNoteOptions): Promise<string | null> {
    const query = options.query.trim();
    if (!query) return null;
    const limit = Math.max(1, Math.min(options.limit ?? MAX_INJECT_MEMORIES, MAX_INJECT_MEMORIES));
    const budget = Math.max(200, Math.min(options.charBudget ?? MEMORY_PROMPT_CHAR_BUDGET, MEMORY_PROMPT_CHAR_BUDGET));
    const result = await this.search({ scope: options.scope, text: query, limit });
    const note = buildMemoryNote(result, limit, budget);
    if (note) {
      const count = (note.match(/\n- \[/g) ?? []).length;
      metricsSink.injected(result.providerId, options.scope.profileId, count);
    }
    return note;
  },
};

/** HTTP Provider 启动或配置变更时使用；会先确保本地 Provider 始终可回退。 */
export function registerLocalMemoryProvider(): void {
  ensureReady();
}

/** 测试专用：清空注册表后再注册一个新的本地 Provider。 */
export function resetMemorySlotForTests(): void {
  resetMemoryRegistryForTests();
  ensureReady();
}
