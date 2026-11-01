/**
 * ============================================================
 * server/routing-settings.ts — 路由配置的持久化边界
 * ============================================================
 * .web-config.json 的 routing 键是唯一落盘位置。本模块负责读取（兼容字段缺失）、
 * 校验并写入运行时状态；agent 层只读 routing/state.ts。
 *
 * 设计立场：
 *  - 默认 enabled=false：不打开就与引入路由前完全一致，符合 AGENTS.md §5.5
 *    对「可执行程序」层能力的治理立场；
 *  - 阈值必须单调可比（0..1），上限必须有正整数边界，任何越界都回中文错误；
 *  - API Key 只进不出：对外快照永远只给「有没有」。
 */
import { readConfig, mergeConfig } from "./config-store.js";
import { writeAudit } from "./audit.js";
import {
  DEFAULT_ROUTING_LIMITS,
  DEFAULT_ROUTING_THRESHOLDS,
  type RoutingSettings,
} from "../routing/types.js";
import { normalizeBackendId } from "../routing/backends/index.js";
import {
  DEFAULT_ROUTING_SETTINGS,
  getRoutingPublicSettings,
  getRoutingSettings,
  replaceRoutingStateForServer,
} from "../routing/state.js";

export interface RoutingSettingsSnapshot {
  settings: RoutingSettings;
  /** systemone 的 Key 是否已设置（明文永不回传） */
  hasSystemoneKey: boolean;
  /** 是否配置了外部 RAG（决定向量层是否存在） */
  vectorAvailable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ratio(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`${field}必须是数字`);
  if (num < 0 || num > 1) throw new Error(`${field}必须在 0 到 1 之间`);
  return num;
}

function integer(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error(`${field}必须是整数`);
  if (num < min || num > max) throw new Error(`${field}必须在 ${min} 到 ${max} 之间`);
  return num;
}

function text(value: unknown, field: string, max: number, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${field}必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field}不能超过 ${max} 个字符`);
  return trimmed;
}

function httpURL(value: string, field: string): string {
  if (!value) return "";
  if (!/^https?:\/\/.+/.test(value)) throw new Error(`${field}必须是 http(s) 开头的完整 URL`);
  return value.replace(/\/+$/, "");
}

/** 读取兼容：旧配置没有 routing 键 → 全部默认值，enabled=false。 */
function normalizeSaved(raw: unknown): RoutingSettings {
  const base: RoutingSettings = {
    ...DEFAULT_ROUTING_SETTINGS,
    llm: { ...DEFAULT_ROUTING_SETTINGS.llm },
    systemone: { ...DEFAULT_ROUTING_SETTINGS.systemone },
    thresholds: { ...DEFAULT_ROUTING_THRESHOLDS },
    limits: { ...DEFAULT_ROUTING_LIMITS },
  };
  const record = asRecord(raw);
  if (!record) return base;
  const llm = asRecord(record.llm) ?? {};
  const systemone = asRecord(record.systemone) ?? {};
  const thresholds = asRecord(record.thresholds) ?? {};
  const limits = asRecord(record.limits) ?? {};
  return {
    enabled: record.enabled === true,
    backend: normalizeBackendId(record.backend),
    llm: {
      providerId: typeof llm.providerId === "string" && llm.providerId.trim() ? llm.providerId.trim() : null,
      modelId: typeof llm.modelId === "string" && llm.modelId.trim() ? llm.modelId.trim() : null,
      temperature: typeof llm.temperature === "number" && Number.isFinite(llm.temperature) ? llm.temperature : 0,
      structuredOutput: llm.structuredOutput !== false,
      maxOutputTokens: typeof llm.maxOutputTokens === "number" && llm.maxOutputTokens > 0
        ? Math.round(llm.maxOutputTokens)
        : DEFAULT_ROUTING_SETTINGS.llm.maxOutputTokens,
    },
    systemone: {
      baseURL: typeof systemone.baseURL === "string" ? systemone.baseURL.trim() : "",
      expectedModel: typeof systemone.expectedModel === "string" ? systemone.expectedModel.trim() : "",
      apiKey: typeof systemone.apiKey === "string" ? systemone.apiKey : "",
    },
    thresholds: {
      ruleAutoAccept: typeof thresholds.ruleAutoAccept === "number" ? thresholds.ruleAutoAccept : DEFAULT_ROUTING_THRESHOLDS.ruleAutoAccept,
      ruleMargin: typeof thresholds.ruleMargin === "number" ? thresholds.ruleMargin : DEFAULT_ROUTING_THRESHOLDS.ruleMargin,
      vectorAccept: typeof thresholds.vectorAccept === "number" ? thresholds.vectorAccept : DEFAULT_ROUTING_THRESHOLDS.vectorAccept,
      modelConfidence: typeof thresholds.modelConfidence === "number" ? thresholds.modelConfidence : DEFAULT_ROUTING_THRESHOLDS.modelConfidence,
      candidateMargin: typeof thresholds.candidateMargin === "number" ? thresholds.candidateMargin : DEFAULT_ROUTING_THRESHOLDS.candidateMargin,
    },
    limits: {
      hierarchicalAbove: typeof limits.hierarchicalAbove === "number" ? limits.hierarchicalAbove : DEFAULT_ROUTING_LIMITS.hierarchicalAbove,
      maxIntents: typeof limits.maxIntents === "number" ? limits.maxIntents : DEFAULT_ROUTING_LIMITS.maxIntents,
      maxCategories: typeof limits.maxCategories === "number" ? limits.maxCategories : DEFAULT_ROUTING_LIMITS.maxCategories,
      maxHandoffs: typeof limits.maxHandoffs === "number" ? limits.maxHandoffs : DEFAULT_ROUTING_LIMITS.maxHandoffs,
      maxPlanDispatches: typeof limits.maxPlanDispatches === "number" ? limits.maxPlanDispatches : DEFAULT_ROUTING_LIMITS.maxPlanDispatches,
      maxIntentTextChars: typeof limits.maxIntentTextChars === "number" ? limits.maxIntentTextChars : DEFAULT_ROUTING_LIMITS.maxIntentTextChars,
    },
    decideTimeoutMs: typeof record.decideTimeoutMs === "number" && record.decideTimeoutMs > 0
      ? Math.round(record.decideTimeoutMs)
      : DEFAULT_ROUTING_SETTINGS.decideTimeoutMs,
  };
}

export async function loadRoutingSettings(): Promise<void> {
  const stored = await readConfig();
  replaceRoutingStateForServer(normalizeSaved(stored.routing));
}

/**
 * 校验并归一化一次配置输入（纯函数，不写盘、不改内存状态）。
 *
 * 与 `saveRoutingSettings` 分开的理由：校验规则是配置契约的一部分，
 * 单测必须能验证它而**不触碰真实配置文件** —— 否则会在测试间互相污染
 * （踩过一次：本文件的测试写盘后，后续依赖默认配置的用例随机失败）。
 */
export function parseRoutingInput(input: Record<string, unknown>, current: RoutingSettings): RoutingSettings {
  const llm = asRecord(input.llm) ?? {};
  const systemone = asRecord(input.systemone) ?? {};
  const thresholds = asRecord(input.thresholds) ?? {};
  const limits = asRecord(input.limits) ?? {};

  const providerId = text(llm.providerId, "路由供应商", 80, "") || null;
  const modelId = text(llm.modelId, "路由模型", 120, "") || null;
  if ((providerId && !modelId) || (!providerId && modelId)) {
    throw new Error("路由模型必须同时指定供应商与模型，或两者都留空以沿用当前模型");
  }

  const apiKeyInput = systemone.apiKey;
  if (apiKeyInput !== undefined && typeof apiKeyInput !== "string") throw new Error("决策服务 Key 必须是字符串");
  const apiKey = typeof apiKeyInput === "string" ? apiKeyInput.trim() : current.systemone.apiKey;

  const next: RoutingSettings = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    backend: normalizeBackendId(input.backend ?? current.backend),
    llm: {
      providerId,
      modelId,
      temperature: ratio(llm.temperature ?? current.llm.temperature, "路由温度", 0),
      structuredOutput: llm.structuredOutput === undefined ? current.llm.structuredOutput : llm.structuredOutput !== false,
      maxOutputTokens: integer(llm.maxOutputTokens, "输出 token 上限", current.llm.maxOutputTokens, 50, 2_000),
    },
    systemone: {
      baseURL: httpURL(text(systemone.baseURL, "决策服务地址", 400, ""), "决策服务地址"),
      expectedModel: text(systemone.expectedModel, "期望模型名", 200, ""),
      apiKey,
    },
    thresholds: {
      ruleAutoAccept: ratio(thresholds.ruleAutoAccept, "规则自动派发阈值", current.thresholds.ruleAutoAccept),
      ruleMargin: ratio(thresholds.ruleMargin, "规则分差阈值", current.thresholds.ruleMargin),
      vectorAccept: ratio(thresholds.vectorAccept, "向量相似度阈值", current.thresholds.vectorAccept),
      modelConfidence: ratio(thresholds.modelConfidence, "模型置信度阈值", current.thresholds.modelConfidence),
      candidateMargin: ratio(thresholds.candidateMargin, "候选分差阈值", current.thresholds.candidateMargin),
    },
    limits: {
      hierarchicalAbove: integer(limits.hierarchicalAbove, "分层触发意图数", current.limits.hierarchicalAbove, 1, 200),
      maxIntents: integer(limits.maxIntents, "意图上限", current.limits.maxIntents, 5, 200),
      maxCategories: integer(limits.maxCategories, "最大分类数", current.limits.maxCategories, 1, 20),
      maxHandoffs: integer(limits.maxHandoffs, "最大转回次数", current.limits.maxHandoffs, 0, 3),
      maxPlanDispatches: integer(limits.maxPlanDispatches, "单次计划派发上限", current.limits.maxPlanDispatches, 1, 50),
      maxIntentTextChars: integer(limits.maxIntentTextChars, "单条意图字符上限", current.limits.maxIntentTextChars, 200, 20_000),
    },
    decideTimeoutMs: integer(input.decideTimeoutMs, "决策超时", current.decideTimeoutMs, 500, 120_000),
  };

  if (next.backend === "systemone" && !next.systemone.baseURL) {
    throw new Error("选择 systemone 后端时必须填写决策服务地址（例如 http://127.0.0.1:8765）");
  }
  return next;
}

/**
 * 保存配置。`systemone.apiKey` 的语义与全仓库一致：
 * 不传 = 保持不变，空串 = 清除，非空 = 覆盖。
 */
export async function saveRoutingSettings(input: Record<string, unknown>): Promise<RoutingSettingsSnapshot> {
  const next = parseRoutingInput(input, getRoutingSettings());
  await mergeConfig({ routing: next });
  replaceRoutingStateForServer(next);
  writeAudit("routing.updated", { enabled: next.enabled, backend: next.backend });
  return routingSnapshot();
}

export function routingSnapshot(): RoutingSettingsSnapshot {
  return {
    settings: getRoutingPublicSettings(),
    hasSystemoneKey: Boolean(getRoutingSettings().systemone.apiKey),
    vectorAvailable: Boolean(vectorAvailableProbe()),
  };
}

/** 由 server 注入：RAG 是否已配置（决定向量层是否存在）。默认实现返回 false。 */
let vectorAvailableProbe: () => boolean = () => false;

export function configureRoutingVectorProbe(probe: (() => boolean) | null): void {
  vectorAvailableProbe = probe ?? (() => false);
}
