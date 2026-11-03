/**
 * server/memory-config.ts — Memory Slot 配置的读取、校验与安全落盘
 * ============================================================
 * `memory` 键与其他配置共存于 .web-config.json，只通过 mergeConfig 局部写入。
 * API Key 对外只给掩码；编辑时缺省/空串保留旧值，clearApiKey 才显式清除。
 *
 * 自动沉淀、Embedding 与保留策略全部兼容旧配置缺失；任一新字段无效时回退默认值，
 * 不能因为一次配置升级让整个聊天服务不可用。
 */
import { mergeConfig, readConfig } from "./config-store.js";

export type MemoryPreset = "generic" | "hindsight";
export type MemoryAuthMode = "none" | "bearer";
export type MemoryDistillationMode = "off" | "confirm" | "smart";
export type MemoryEmbeddingPreset = "openai-compatible";

export interface MemoryHttpConfig {
  enabled: boolean;
  preset: MemoryPreset;
  baseURL: string;
  authMode: MemoryAuthMode;
  apiKey: string;
  timeoutMs: number;
  searchLimit: number;
  writeEnabled: boolean;
  banks: Record<"general" | "estate" | "job", string>;
}

export interface MemoryDistillationConfig {
  mode: MemoryDistillationMode;
  maxPerTurn: number;
  hourlyLimit: number;
}

export interface MemoryEmbeddingConfig {
  enabled: boolean;
  preset: MemoryEmbeddingPreset;
  baseURL: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  dimensions: number;
  minSimilarity: number;
}

export interface MemoryRetentionConfig {
  activePerScope: number;
  historyPerScope: number;
  staleGraceDays: number;
  preferenceDays: number;
  projectFactDays: number;
  correctionDays: number;
  identityDays: number;
}

export interface MemoryConfig {
  activeProvider: "local" | "http";
  local: { allowPII: boolean };
  http: MemoryHttpConfig;
  distillation: MemoryDistillationConfig;
  embedding: MemoryEmbeddingConfig;
  retention: MemoryRetentionConfig;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  activeProvider: "local",
  local: { allowPII: false },
  http: {
    enabled: false,
    preset: "generic",
    baseURL: "",
    authMode: "bearer",
    apiKey: "",
    timeoutMs: 8000,
    searchLimit: 8,
    writeEnabled: true,
    banks: { general: "", estate: "", job: "" },
  },
  distillation: {
    mode: "smart",
    maxPerTurn: 3,
    hourlyLimit: 20,
  },
  embedding: {
    enabled: false,
    preset: "openai-compatible",
    baseURL: "",
    model: "",
    apiKey: "",
    timeoutMs: 8000,
    dimensions: 0,
    minSimilarity: 0.25,
  },
  retention: {
    activePerScope: 2000,
    historyPerScope: 5000,
    staleGraceDays: 30,
    preferenceDays: 180,
    projectFactDays: 120,
    correctionDays: 365,
    identityDays: 365,
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function normalizedBaseURL(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const raw = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} baseURL 不是合法 URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} baseURL 只允许 http:// 或 https://`);
  }
  if (url.username || url.password) throw new Error(`${label} baseURL 不允许包含用户名或密码`);
  return raw;
}

export function normalizeMemoryConfig(value: unknown): MemoryConfig {
  const root = record(value);
  const local = record(root.local);
  const http = record(root.http);
  const banks = record(http.banks);
  const distillation = record(root.distillation);
  const embedding = record(root.embedding);
  const retention = record(root.retention);
  const enabled = http.enabled === true;
  const preset = http.preset === "hindsight" ? "hindsight" : "generic";
  const authMode = http.authMode === "none" ? "none" : "bearer";
  const baseURL = normalizedBaseURL(http.baseURL, "外部记忆");
  const activeRequested = root.activeProvider === "http";
  const activeProvider = activeRequested && enabled && Boolean(baseURL) ? "http" : "local";
  const distillationMode = distillation.mode === "off" || distillation.mode === "confirm"
    ? distillation.mode
    : "smart";
  return {
    activeProvider,
    local: { allowPII: local.allowPII === true },
    http: {
      enabled,
      preset,
      baseURL,
      authMode,
      apiKey: typeof http.apiKey === "string" ? http.apiKey.trim() : "",
      timeoutMs: boundedInt(http.timeoutMs, DEFAULT_MEMORY_CONFIG.http.timeoutMs, 500, 30_000),
      searchLimit: boundedInt(http.searchLimit, DEFAULT_MEMORY_CONFIG.http.searchLimit, 1, 20),
      writeEnabled: http.writeEnabled !== false,
      banks: {
        general: typeof banks.general === "string" ? banks.general.trim().slice(0, 100) : "",
        estate: typeof banks.estate === "string" ? banks.estate.trim().slice(0, 100) : "",
        job: typeof banks.job === "string" ? banks.job.trim().slice(0, 100) : "",
      },
    },
    distillation: {
      mode: distillationMode,
      maxPerTurn: boundedInt(distillation.maxPerTurn, DEFAULT_MEMORY_CONFIG.distillation.maxPerTurn, 1, 10),
      hourlyLimit: boundedInt(distillation.hourlyLimit, DEFAULT_MEMORY_CONFIG.distillation.hourlyLimit, 1, 200),
    },
    embedding: {
      enabled: embedding.enabled === true,
      preset: "openai-compatible",
      baseURL: normalizedBaseURL(embedding.baseURL, "Embedding"),
      model: typeof embedding.model === "string" ? embedding.model.trim().slice(0, 160) : "",
      apiKey: typeof embedding.apiKey === "string" ? embedding.apiKey.trim() : "",
      timeoutMs: boundedInt(embedding.timeoutMs, DEFAULT_MEMORY_CONFIG.embedding.timeoutMs, 500, 30_000),
      dimensions: boundedInt(embedding.dimensions, DEFAULT_MEMORY_CONFIG.embedding.dimensions, 0, 16_384),
      minSimilarity: boundedNumber(embedding.minSimilarity, DEFAULT_MEMORY_CONFIG.embedding.minSimilarity, 0, 1),
    },
    retention: {
      activePerScope: boundedInt(retention.activePerScope, DEFAULT_MEMORY_CONFIG.retention.activePerScope, 100, 50_000),
      historyPerScope: boundedInt(retention.historyPerScope, DEFAULT_MEMORY_CONFIG.retention.historyPerScope, 100, 100_000),
      staleGraceDays: boundedInt(retention.staleGraceDays, DEFAULT_MEMORY_CONFIG.retention.staleGraceDays, 1, 3650),
      preferenceDays: boundedInt(retention.preferenceDays, DEFAULT_MEMORY_CONFIG.retention.preferenceDays, 1, 3650),
      projectFactDays: boundedInt(retention.projectFactDays, DEFAULT_MEMORY_CONFIG.retention.projectFactDays, 1, 3650),
      correctionDays: boundedInt(retention.correctionDays, DEFAULT_MEMORY_CONFIG.retention.correctionDays, 1, 3650),
      identityDays: boundedInt(retention.identityDays, DEFAULT_MEMORY_CONFIG.retention.identityDays, 1, 3650),
    },
  };
}

export async function readMemoryConfig(): Promise<MemoryConfig> {
  const config = await readConfig();
  return normalizeMemoryConfig(config.memory);
}

export interface MemoryConfigPatch {
  activeProvider?: unknown;
  local?: { allowPII?: unknown };
  http?: {
    enabled?: unknown;
    preset?: unknown;
    baseURL?: unknown;
    authMode?: unknown;
    apiKey?: unknown;
    clearApiKey?: unknown;
    timeoutMs?: unknown;
    searchLimit?: unknown;
    writeEnabled?: unknown;
    banks?: { general?: unknown; estate?: unknown; job?: unknown };
  };
  distillation?: { mode?: unknown; maxPerTurn?: unknown; hourlyLimit?: unknown };
  embedding?: {
    enabled?: unknown;
    baseURL?: unknown;
    model?: unknown;
    apiKey?: unknown;
    clearApiKey?: unknown;
    timeoutMs?: unknown;
    dimensions?: unknown;
    minSimilarity?: unknown;
  };
  retention?: {
    activePerScope?: unknown;
    historyPerScope?: unknown;
    staleGraceDays?: unknown;
    preferenceDays?: unknown;
    projectFactDays?: unknown;
    correctionDays?: unknown;
    identityDays?: unknown;
  };
}

/** 只计算合并结果，不落盘；连接测试可复用同一套校验。 */
export function mergeMemoryConfigPatch(current: MemoryConfig, patch: MemoryConfigPatch): MemoryConfig {
  const incoming = record(patch);
  const httpPatch = record(incoming.http);
  const localPatch = record(incoming.local);
  const banksPatch = record(httpPatch.banks);
  const distillationPatch = record(incoming.distillation);
  const embeddingPatch = record(incoming.embedding);
  const retentionPatch = record(incoming.retention);
  const merged = normalizeMemoryConfig({
    activeProvider: incoming.activeProvider ?? current.activeProvider,
    local: {
      allowPII: localPatch.allowPII ?? current.local.allowPII,
    },
    http: {
      enabled: httpPatch.enabled ?? current.http.enabled,
      preset: httpPatch.preset ?? current.http.preset,
      baseURL: httpPatch.baseURL ?? current.http.baseURL,
      authMode: httpPatch.authMode ?? current.http.authMode,
      apiKey: httpPatch.clearApiKey === true
        ? ""
        : typeof httpPatch.apiKey === "string" && httpPatch.apiKey.trim()
          ? httpPatch.apiKey.trim()
          : current.http.apiKey,
      timeoutMs: httpPatch.timeoutMs ?? current.http.timeoutMs,
      searchLimit: httpPatch.searchLimit ?? current.http.searchLimit,
      writeEnabled: httpPatch.writeEnabled ?? current.http.writeEnabled,
      banks: {
        general: banksPatch.general ?? current.http.banks.general,
        estate: banksPatch.estate ?? current.http.banks.estate,
        job: banksPatch.job ?? current.http.banks.job,
      },
    },
    distillation: {
      mode: distillationPatch.mode ?? current.distillation.mode,
      maxPerTurn: distillationPatch.maxPerTurn ?? current.distillation.maxPerTurn,
      hourlyLimit: distillationPatch.hourlyLimit ?? current.distillation.hourlyLimit,
    },
    embedding: {
      enabled: embeddingPatch.enabled ?? current.embedding.enabled,
      preset: "openai-compatible",
      baseURL: embeddingPatch.baseURL ?? current.embedding.baseURL,
      model: embeddingPatch.model ?? current.embedding.model,
      apiKey: embeddingPatch.clearApiKey === true
        ? ""
        : typeof embeddingPatch.apiKey === "string" && embeddingPatch.apiKey.trim()
          ? embeddingPatch.apiKey.trim()
          : current.embedding.apiKey,
      timeoutMs: embeddingPatch.timeoutMs ?? current.embedding.timeoutMs,
      dimensions: embeddingPatch.dimensions ?? current.embedding.dimensions,
      minSimilarity: embeddingPatch.minSimilarity ?? current.embedding.minSimilarity,
    },
    retention: {
      activePerScope: retentionPatch.activePerScope ?? current.retention.activePerScope,
      historyPerScope: retentionPatch.historyPerScope ?? current.retention.historyPerScope,
      staleGraceDays: retentionPatch.staleGraceDays ?? current.retention.staleGraceDays,
      preferenceDays: retentionPatch.preferenceDays ?? current.retention.preferenceDays,
      projectFactDays: retentionPatch.projectFactDays ?? current.retention.projectFactDays,
      correctionDays: retentionPatch.correctionDays ?? current.retention.correctionDays,
      identityDays: retentionPatch.identityDays ?? current.retention.identityDays,
    },
  });
  if (merged.http.enabled && !merged.http.baseURL) {
    throw new Error("启用 HTTP 记忆时必须填写 baseURL");
  }
  if (incoming.activeProvider === "http" && !merged.http.enabled) {
    throw new Error("切换到 HTTP 记忆前必须先启用 HTTP Provider");
  }
  if (merged.http.preset === "hindsight" && merged.http.enabled) {
    const banks = merged.http.banks;
    if (!banks.general || !banks.estate || !banks.job) {
      throw new Error("Hindsight 模式必须分别配置 general / estate / job bank，不能共用默认值");
    }
    if (new Set([banks.general, banks.estate, banks.job]).size !== 3) {
      throw new Error("general / estate / job 的 Hindsight bank 必须互不相同，避免 Agent 记忆串域");
    }
  }
  if (merged.embedding.enabled && (!merged.embedding.baseURL || !merged.embedding.model)) {
    throw new Error("启用语义召回时必须填写 Embedding baseURL 和模型名");
  }
  if (merged.retention.historyPerScope < merged.retention.activePerScope) {
    throw new Error("历史保留上限不能小于 active 上限");
  }
  return merged;
}

/** 空 apiKey 保留旧值，避免用户编辑其他字段时误清凭据。 */
export async function saveMemoryConfig(patch: MemoryConfigPatch): Promise<MemoryConfig> {
  const current = await readMemoryConfig();
  const merged = mergeMemoryConfigPatch(current, patch);
  await mergeConfig({ memory: merged });
  return merged;
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

/** 外部 API 的安全视图：真实 Key 永不回传。 */
export function publicMemoryConfig(config: MemoryConfig) {
  return {
    activeProvider: config.activeProvider,
    local: { ...config.local },
    http: {
      ...config.http,
      apiKey: "",
      hasApiKey: Boolean(config.http.apiKey),
      keyMasked: maskSecret(config.http.apiKey),
      banks: { ...config.http.banks },
    },
    distillation: { ...config.distillation },
    embedding: {
      ...config.embedding,
      apiKey: "",
      hasApiKey: Boolean(config.embedding.apiKey),
      keyMasked: maskSecret(config.embedding.apiKey),
    },
    retention: { ...config.retention },
  };
}