/**
 * provider.ts — Memory Provider 的稳定领域契约
 * ============================================================
 * 这里只定义纯类型，不读写文件、不依赖 Agent 或 server，供本地 Provider、
 * HTTP Provider、工具层与 workflow 共用。模型工具 schema 不暴露这些差异。
 */
export type MemoryProviderId = "local" | "http";
export type MemoryProfileId = "general" | "estate";
export type MemorySource = "agent" | "user" | "import";
export type MemoryStatus = "active" | "superseded";

export interface MemoryScope {
  profileId: MemoryProfileId;
  /** 当前是单用户部署；保留字段是为了外部 Provider 未来扩展时不必改契约。 */
  userId: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  tags: string[];
  source: MemorySource;
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount?: number;
}

export interface MemorySaveInput {
  scope: MemoryScope;
  key: string;
  content: string;
  tags?: string[];
  source: MemorySource;
}

export interface MemorySearchQuery {
  text: string;
  scope: MemoryScope;
  limit: number;
}

export interface MemorySearchResult {
  records: MemoryRecord[];
  total: number;
  degraded: boolean;
  providerId: MemoryProviderId;
}

export interface MemoryProviderHealth {
  providerId: MemoryProviderId;
  status: "ok" | "degraded" | "unavailable";
  latencyMs?: number;
  message?: string;
}

export interface MemoryProvider {
  readonly id: MemoryProviderId;
  readonly capabilities: {
    read: true;
    write: boolean;
    delete: boolean;
    search: true;
    health: boolean;
  };
  health(): Promise<MemoryProviderHealth>;
  save(input: MemorySaveInput): Promise<MemoryRecord>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  list(scope: MemoryScope, options?: { includeHistory?: boolean }): Promise<MemoryRecord[]>;
  delete(id: string, scope: MemoryScope): Promise<boolean>;
}
