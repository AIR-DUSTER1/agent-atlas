/**
 * ============================================================
 * server/trace-settings.ts — LangSmith 追踪配置的 server 边界
 * ============================================================
 * 职责：读取 .env 默认值，叠加 .web-config.json 的 tracing 快照，校验并持久化；
 * 对外只返回掩码与是否有效，真实 API Key 只在 server 内存中交给 trace 工厂。
 *
 * 设计立场：
 *  - 配置优先级与全仓库一致：.env < .web-config.json < 运行中内存；
 *  - 该模块可 import agent/trace 的纯校验，但 agent 不得反向 import server；
 *  - 关闭、缺 Key、非法 endpoint 都只降级为 warning，不阻塞主任务启动。
 */
import { config, type TraceBackend, type TraceRuntimeConfig } from "../config.js";
import { mergeConfig, readConfig } from "./config-store.js";
import { maskKey } from "./settings-cache.js";
import { writeAudit } from "./audit.js";
import { validateTraceEndpoint } from "../agent/trace.js";

export interface TraceSettingsSnapshot {
  backend: TraceBackend;
  project: string;
  endpoint: string;
  anonymize: boolean;
  agentId: string;
  agentEnvironment: string;
  hasApiKey: boolean;
  keyMasked: string;
  /** 当前配置是否能真正构造 tracer；missing key / bad endpoint 时为 false。 */
  effective: boolean;
  /** 给人看的不可用原因；正常关闭时为 null。 */
  warning: string | null;
}

let current: TraceRuntimeConfig = cloneConfig(config.trace);

function cloneConfig(value: TraceRuntimeConfig): TraceRuntimeConfig {
  return { ...value };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, field: string, max: number, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${field}必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field}不能超过 ${max} 个字符`);
  return trimmed || fallback;
}

function parseBackend(value: unknown, fallback: TraceBackend): TraceBackend {
  if (value === undefined || value === null) return fallback;
  if (value === "off" || value === "langsmith") return value;
  throw new Error("追踪后端只支持 off 或 langsmith");
}

/** 磁盘配置坏值不能阻断启动；未知后端按 off 处理。 */
function normalizeBackend(value: unknown, fallback: TraceBackend): TraceBackend {
  return value === "off" || value === "langsmith" ? value : value === undefined ? fallback : "off";
}

/** 把磁盘中的 tracing 对象规范成完整配置；字段坏了就回退默认值。 */
export function normalizeTraceSettings(raw: unknown, defaults: TraceRuntimeConfig = config.trace): TraceRuntimeConfig {
  const record = asRecord(raw);
  if (!record) return cloneConfig(defaults);
  const backend = normalizeBackend(record.backend, defaults.backend);
  const apiKey = typeof record.apiKey === "string" ? record.apiKey : defaults.apiKey;
  const project = text(record.project, "LangSmith 项目名", 120, defaults.project);
  const endpoint = text(record.endpoint, "LangSmith Endpoint", 400, defaults.endpoint);
  return {
    backend,
    apiKey,
    project,
    endpoint,
    anonymize: record.anonymize === undefined ? defaults.anonymize : record.anonymize !== false,
    agentId: text(record.agentId, "LangSmith Agent ID", 120, defaults.agentId),
    agentEnvironment: text(record.agentEnvironment, "LangSmith Agent 环境", 80, defaults.agentEnvironment),
  };
}

/** 只接受设置页提交的字段；apiKey 不传=保持，空串=清除。 */
export function parseTraceInput(input: Record<string, unknown>, previous: TraceRuntimeConfig = current): TraceRuntimeConfig {
  const backend = parseBackend(input.backend, previous.backend);
  const apiKey = input.apiKey === undefined
    ? previous.apiKey
    : typeof input.apiKey === "string" ? input.apiKey.trim() : (() => { throw new Error("LangSmith API Key 必须是字符串"); })();
  const project = text(input.project, "LangSmith 项目名", 120, previous.project);
  const endpoint = text(input.endpoint, "LangSmith Endpoint", 400, previous.endpoint);
  const agentId = text(input.agentId, "LangSmith Agent ID", 120, previous.agentId);
  const agentEnvironment = text(input.agentEnvironment, "LangSmith Agent 环境", 80, previous.agentEnvironment);
  const endpointError = validateTraceEndpoint(endpoint);
  if (endpointError) throw new Error(endpointError);
  return {
    backend,
    apiKey,
    project,
    endpoint,
    anonymize: input.anonymize === undefined ? previous.anonymize : input.anonymize !== false,
    agentId,
    agentEnvironment,
  };
}

export async function loadTraceSettings(): Promise<void> {
  const stored = await readConfig();
  current = normalizeTraceSettings(stored.tracing, config.trace);
}

export function getTraceSettings(): TraceRuntimeConfig {
  return cloneConfig(current);
}

export function traceSettingsSnapshot(): TraceSettingsSnapshot {
  const endpointError = validateTraceEndpoint(current.endpoint);
  const missingKey = !current.apiKey.trim();
  const warning = current.backend !== "langsmith"
    ? null
    : missingKey ? "已选择 LangSmith，但未配置 API Key；追踪保持关闭"
      : endpointError;
  return {
    backend: current.backend,
    project: current.project,
    endpoint: current.endpoint,
    anonymize: current.anonymize,
    agentId: current.agentId,
    agentEnvironment: current.agentEnvironment,
    hasApiKey: Boolean(current.apiKey.trim()),
    keyMasked: maskKey(current.apiKey),
    effective: current.backend === "langsmith" && !warning,
    warning,
  };
}

export async function saveTraceSettings(input: Record<string, unknown>): Promise<TraceSettingsSnapshot> {
  const next = parseTraceInput(input, current);
  await mergeConfig({ tracing: next });
  current = next;
  const snapshot = traceSettingsSnapshot();
  writeAudit("trace.updated", {
    backend: next.backend,
    effective: snapshot.effective,
    anonymize: next.anonymize,
  });
  return snapshot;
}

/** 测试和进程重启时使用；不触碰磁盘。 */
export function replaceTraceSettingsForTest(next: TraceRuntimeConfig): void {
  current = cloneConfig(next);
}