/**
 * provider.ts — Memory Provider 的稳定领域契约
 * ============================================================
 * 这里只定义纯类型，不读写文件、不依赖 Agent 或 server，供本地 Provider、
 * HTTP Provider、工具层与 workflow 共用。模型工具 schema 不暴露这些差异。
 */
export type MemoryProviderId = "local" | "http";
export type MemoryProfileId = "general" | "estate" | "job";
export type MemorySource = "agent" | "user" | "import";
export type MemoryStatus = "candidate" | "active" | "stale" | "superseded" | "archived";
export type MemoryCategory = "preference" | "project_fact" | "correction" | "identity" | "other";
export type MemoryOrigin = "manual" | "agent_tool" | "auto" | "import" | "http";

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
  /** 记忆语义类别；旧记录缺省按 other 处理。 */
  category?: MemoryCategory;
  /** 自动沉淀置信度，0-1；人工记录默认 1。 */
  confidence?: number;
  /** 生命周期到期时间；缺省表示不自动过期。 */
  expiresAt?: number;
  /** 进入 stale 的时间，用于宽限后归档。 */
  staleAt?: number;
  /** 最近一次由用户确认或自动沉淀验证的时间。 */
  lastConfirmedAt?: number;
  /** 只记录来源标识与模式，不保存原始对话正文。 */
  origin?: { mode: MemoryOrigin; sessionId?: string; turnId?: string };
  /** 被哪条新记忆替代；保留时间线。 */
  replacedBy?: string;
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
  /** 自动沉淀默认先写 candidate；工具/手动保存默认 active。 */
  status?: MemoryStatus;
  category?: MemoryCategory;
  confidence?: number;
  expiresAt?: number;
  origin?: MemoryRecord["origin"];
  /** 仅供设置页显式开启；Agent 工具始终不传。 */
  allowPII?: boolean;
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
  message?: string;
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
    lifecycle?: boolean;
  };
  health(): Promise<MemoryProviderHealth>;
  save(input: MemorySaveInput): Promise<MemoryRecord>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  list(scope: MemoryScope, options?: MemoryListOptions): Promise<MemoryRecord[]>;
  delete(id: string, scope: MemoryScope): Promise<boolean>;
  confirm?(id: string, scope: MemoryScope, options?: { expiresAt?: number }): Promise<MemoryRecord | null>;
  reject?(id: string, scope: MemoryScope): Promise<boolean>;
}

export interface MemoryListOptions {
  includeHistory?: boolean;
  /** 显式状态过滤；未传时沿用旧语义：默认 active，includeHistory=true 返回全部。 */
  statuses?: MemoryStatus[];
}

export interface MemoryProposal {
  action: "create" | "update" | "merge" | "ignore";
  key: string;
  content: string;
  tags?: string[];
  category?: MemoryCategory;
  confidence?: number;
  reason?: string;
}
