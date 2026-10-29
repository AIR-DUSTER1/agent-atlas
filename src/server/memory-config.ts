/**
 * server/memory-config.ts — Memory Slot 配置的读取、校验与安全落盘
 * ============================================================
 * `memory` 键与其他配置共存于 .web-config.json，只通过 mergeConfig 局部写入。
 * API Key 对外只给掩码；编辑时缺省/空串保留旧值，clearApiKey 才显式清除。
 */
import { mergeConfig, readConfig } from "./config-store.js";

export type MemoryPreset = "generic" | "hindsight";
export type MemoryAuthMode = "none" | "bearer";

export interface MemoryHttpConfig {
  enabled: boolean;
  preset: MemoryPreset;
  baseURL: string;
  authMode: MemoryAuthMode;
  apiKey: string;
  timeoutMs: number;
  searchLimit: number;
  writeEnabled: boolean;
  banks: { general: string; estate: string };
}

export interface MemoryConfig {
  activeProvider: "local" | "http";
  local: { allowPII: boolean };
  http: MemoryHttpConfig;
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
    banks: { general: "", estate: "" },
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

function normalizedBaseURL(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const raw = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("外部记忆 baseURL 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("外部记忆 baseURL 只允许 http:// 或 https://");
  }
  if (url.username || url.password) throw new Error("外部记忆 baseURL 不允许包含用户名或密码");
  return raw;
}

export function normalizeMemoryConfig(value: unknown): MemoryConfig {
  const root = record(value);
  const local = record(root.local);
  const http = record(root.http);
  const banks = record(http.banks);
  const enabled = http.enabled === true;
  const preset = http.preset === "hindsight" ? "hindsight" : "generic";
  const authMode = http.authMode === "none" ? "none" : "bearer";
  const baseURL = normalizedBaseURL(http.baseURL);
  const activeRequested = root.activeProvider === "http";
  const activeProvider = activeRequested && enabled && Boolean(baseURL) ? "http" : "local";
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
      },
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
    banks?: { general?: unknown; estate?: unknown };
  };
}

/** 只计算合并结果，不落盘；连接测试可复用同一套校验。 */
export function mergeMemoryConfigPatch(current: MemoryConfig, patch: MemoryConfigPatch): MemoryConfig {
  const incoming = record(patch);
  const httpPatch = record(incoming.http);
  const localPatch = record(incoming.local);
  const banksPatch = record(httpPatch.banks);
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
      },
    },
  });
  if (merged.http.enabled && !merged.http.baseURL) {
    throw new Error("启用 HTTP 记忆时必须填写 baseURL");
  }
  if (incoming.activeProvider === "http" && !merged.http.enabled) {
    throw new Error("切换到 HTTP 记忆前必须先启用 HTTP Provider");
  }
  if (merged.http.preset === "hindsight" && merged.http.enabled) {
    if (!merged.http.banks.general || !merged.http.banks.estate) {
      throw new Error("Hindsight 模式必须分别配置 general / estate bank，不能共用默认值");
    }
    if (merged.http.banks.general === merged.http.banks.estate) {
      throw new Error("general 与 estate 的 Hindsight bank 必须不同，避免 Agent 记忆串域");
    }
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
  };
}
