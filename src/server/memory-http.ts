/**
 * memory-http.ts — Generic / Hindsight HTTP Memory Provider 与运行时装配
 * ============================================================
 * 所有外部请求都受 URL 白名单、超时、响应大小、字段白名单和熔断保护；
 * 外部服务失败只让 Slot 降级，不参与 /readyz，也不会阻断主聊天启动。
 */
import { Buffer } from "node:buffer";
import type {
  MemoryProvider,
  MemoryProviderHealth,
  MemoryRecord,
  MemorySaveInput,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
} from "../memory/provider.js";
import { sameMemoryScope } from "../memory/scope.js";
import { memorySlot } from "../memory/slot.js";
import { LocalMemoryProvider } from "../memory/providers/local.js";
import { log } from "./logging.js";
import {
  DEFAULT_MEMORY_CONFIG,
  readMemoryConfig,
  type MemoryConfig,
  type MemoryHttpConfig,
} from "./memory-config.js";

const MAX_RESPONSE_BYTES = 512 * 1024;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const MAX_RECORD_CONTENT = 500;

class MemoryHttpError extends Error {
  constructor(message: string, readonly category: "timeout" | "auth" | "server" | "network" | "bad_response" | "circuit") {
    super(message);
    this.name = "MemoryHttpError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 6) : [];
}

function sourceOf(value: unknown): MemorySaveInput["source"] {
  return value === "user" || value === "import" ? value : "agent";
}

function makeRecord(item: unknown, scope: MemoryScope, fallback?: MemorySaveInput): MemoryRecord | null {
  const rec = record(item);
  const nested = record(rec.memory);
  const metadata = record(rec.metadata ?? nested.metadata);
  const content = text(rec.content) || text(rec.text) || text(nested.content) || text(rec.memory);
  if (!content && !fallback) return null;
  const finalContent = (content || fallback?.content || "").slice(0, MAX_RECORD_CONTENT);
  const key = text(rec.key) || text(metadata.key) || fallback?.key || finalContent.slice(0, 50);
  const id = text(rec.externalId) || text(rec.id) || text(rec.memoryId) || text(rec.memory_id) || crypto.randomUUID();
  const now = Date.now();
  return {
    id,
    scope,
    key: key.slice(0, 50),
    content: finalContent,
    tags: stringArray(rec.tags).length ? stringArray(rec.tags) : (fallback?.tags ?? []),
    source: sourceOf(rec.source ?? metadata.source ?? fallback?.source),
    status: "active",
    createdAt: timestamp(rec.createdAt ?? rec.created_at, now),
    updatedAt: timestamp(rec.updatedAt ?? rec.updated_at ?? rec.createdAt ?? rec.created_at, now),
  };
}

function recordsFromPayload(payload: unknown, scope: MemoryScope): MemoryRecord[] {
  const root = record(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root.records)
      ? root.records
      : Array.isArray(root.memories)
        ? root.memories
        : Array.isArray(root.results)
          ? root.results
          : Array.isArray(root.items)
            ? root.items
            : [];
  return list
    .map((item) => makeRecord(item, scope))
    .filter((item): item is MemoryRecord => Boolean(item))
    .filter((item) => sameMemoryScope(item.scope, scope))
    .slice(0, 500);
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new MemoryHttpError("外部记忆服务响应过大，已中止读取", "bad_response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new MemoryHttpError("外部记忆服务响应过大，已中止读取", "bad_response");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function parseJson(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new MemoryHttpError("外部记忆服务返回了无法解析的数据", "bad_response");
  }
}

export class HttpMemoryProvider implements MemoryProvider {
  readonly id = "http" as const;
  readonly capabilities: MemoryProvider["capabilities"];
  private failures = 0;
  private openUntil = 0;
  private halfOpenProbe = false;

  constructor(private readonly config: MemoryHttpConfig) {
    this.capabilities = {
      read: true,
      write: config.writeEnabled,
      delete: config.preset === "generic" && config.writeEnabled,
      search: true,
      health: true,
    };
  }

  private assertCircuit(): void {
    if (this.openUntil === 0) return;
    if (Date.now() < this.openUntil) {
      throw new MemoryHttpError("外部记忆服务暂时熔断，稍后自动重试", "circuit");
    }
    if (this.halfOpenProbe) {
      throw new MemoryHttpError("外部记忆服务正在半开探测", "circuit");
    }
    this.halfOpenProbe = true;
  }

  private succeeded(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
  }

  private failed(): void {
    this.failures += 1;
    this.halfOpenProbe = false;
    if (this.failures >= CIRCUIT_FAILURE_THRESHOLD) this.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }

  private url(path: string): string {
    return `${this.config.baseURL.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Headers {
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
    if (this.config.authMode === "bearer" && this.config.apiKey) {
      headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    }
    return headers;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    this.assertCircuit();
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        ...init,
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      this.failed();
      const name = error instanceof Error ? error.name : "";
      if (/timeout|abort/i.test(name) || /timeout|aborted/i.test(String(error))) {
        throw new MemoryHttpError(`外部记忆服务请求超时（${this.config.timeoutMs}ms）`, "timeout");
      }
      throw new MemoryHttpError("无法连接外部记忆服务", "network");
    }
    let raw: string;
    try {
      raw = await readLimited(response);
    } catch (error) {
      this.failed();
      throw error;
    }
    if (!response.ok) {
      this.failed();
      if (response.status === 401 || response.status === 403) {
        throw new MemoryHttpError("外部记忆服务鉴权失败，请检查 API Key", "auth");
      }
      throw new MemoryHttpError(`外部记忆服务暂时不可用（HTTP ${response.status}）`, "server");
    }
    let payload: unknown;
    try {
      payload = parseJson(raw);
    } catch (error) {
      this.failed();
      throw error;
    }
    this.succeeded();
    return payload;
  }

  private bank(scope: MemoryScope): string {
    const bank = this.config.banks[scope.profileId];
    if (!bank) throw new MemoryHttpError(`未配置 ${scope.profileId} 的 Hindsight bank`, "bad_response");
    return encodeURIComponent(bank);
  }

  async health(): Promise<MemoryProviderHealth> {
    const startedAt = Date.now();
    try {
      const payload = await this.request("/health", { method: "GET" });
      const status = text(record(payload).status).toLowerCase();
      return {
        providerId: "http",
        status: !status || status === "ok" || status === "healthy" ? "ok" : "degraded",
        latencyMs: Date.now() - startedAt,
        ...(status && status !== "ok" && status !== "healthy" ? { message: `外部状态：${status.slice(0, 40)}` } : {}),
      };
    } catch (error) {
      return {
        providerId: "http",
        status: "unavailable",
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : "外部记忆服务不可用",
      };
    }
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    const payload = this.config.preset === "hindsight"
      ? await this.request(`/v1/default/banks/${this.bank(query.scope)}/memories/recall`, {
        method: "POST",
        body: JSON.stringify({ query: query.text, limit: Math.min(query.limit, this.config.searchLimit) }),
      })
      : await this.request("/memories/search", {
        method: "POST",
        body: JSON.stringify({ scope: query.scope, query: query.text, limit: Math.min(query.limit, this.config.searchLimit) }),
      });
    const all = recordsFromPayload(payload, query.scope);
    return {
      records: all.slice(0, Math.min(query.limit, this.config.searchLimit)),
      total: all.length,
      degraded: false,
      providerId: "http",
    };
  }

  async save(input: MemorySaveInput): Promise<MemoryRecord> {
    if (!this.capabilities.write) throw new Error("外部记忆当前配置为只读，不能保存");
    const payload = this.config.preset === "hindsight"
      ? await this.request(`/v1/default/banks/${this.bank(input.scope)}/memories`, {
        method: "POST",
        body: JSON.stringify({
          content: input.content,
          tags: input.tags ?? [],
          metadata: { key: input.key, source: input.source, profileId: input.scope.profileId, userId: input.scope.userId },
        }),
      })
      : await this.request("/memories", {
        method: "POST",
        body: JSON.stringify({
          scope: input.scope,
          key: input.key,
          content: input.content,
          tags: input.tags ?? [],
          source: input.source,
        }),
      });
    const root = record(payload);
    return makeRecord(root.record ?? root.memory ?? payload, input.scope, input) ?? {
      id: text(root.externalId) || crypto.randomUUID(),
      scope: { ...input.scope },
      key: input.key.slice(0, 50),
      content: input.content.slice(0, MAX_RECORD_CONTENT),
      tags: [...(input.tags ?? [])],
      source: input.source,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async list(scope: MemoryScope, options: { includeHistory?: boolean } = {}): Promise<MemoryRecord[]> {
    if (this.config.preset === "hindsight") {
      const payload = await this.request(`/v1/default/banks/${this.bank(scope)}/memories/recall`, {
        method: "POST",
        body: JSON.stringify({ query: "", limit: 500 }),
      });
      return recordsFromPayload(payload, scope);
    }
    const query = new URLSearchParams({ profileId: scope.profileId, userId: scope.userId });
    if (options.includeHistory) query.set("history", "1");
    const payload = await this.request(`/memories?${query.toString()}`, { method: "GET" });
    return recordsFromPayload(payload, scope);
  }

  async delete(id: string, scope: MemoryScope): Promise<boolean> {
    if (!this.capabilities.delete) throw new Error("当前外部记忆 Provider 不支持删除");
    void scope;
    const payload = await this.request(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
    return record(payload).ok !== false;
  }
}

/** 只做连接测试，不改变当前 active Provider。 */
export async function testHttpMemoryConfig(config: MemoryHttpConfig): Promise<MemoryProviderHealth> {
  return new HttpMemoryProvider(config).health();
}

export interface MemoryRuntimeState {
  config: MemoryConfig;
  providerId: "local" | "http";
  registered: ReturnType<typeof memorySlot.registered>;
}

/**
 * 启动与配置保存后调用：HTTP 未启用 / 地址缺失时只激活本地 Provider；
 * 外部服务健康失败不回退掉配置本身，下一次请求仍可由熔断/半开恢复。
 */
export async function applyMemoryRuntime(config?: MemoryConfig): Promise<MemoryRuntimeState> {
  let resolved: MemoryConfig;
  try {
    resolved = config ?? await readMemoryConfig();
  } catch (error) {
    // 坏配置不能让聊天服务起不来：保留磁盘原文，运行时回退本地并留告警。
    log("warn", "memory_config_invalid", {
      message: error instanceof Error ? error.message : String(error),
      action: "fallback_local",
    });
    resolved = structuredClone(DEFAULT_MEMORY_CONFIG);
  }
  memorySlot.register(new LocalMemoryProvider(), {
    replace: true,
    activate: resolved.activeProvider === "local",
  });
  if (resolved.http.enabled && resolved.http.baseURL) {
    memorySlot.register(new HttpMemoryProvider(resolved.http), {
      replace: true,
      activate: resolved.activeProvider === "http",
    });
  }
  if (resolved.activeProvider === "local") memorySlot.activate("local");
  const providerId = await memorySlot.providerId();
  log("info", "memory_runtime_configured", {
    providerId,
    preset: resolved.http.preset,
    httpEnabled: resolved.http.enabled,
    writeEnabled: resolved.http.writeEnabled,
  });
  return { config: resolved, providerId, registered: memorySlot.registered() };
}
