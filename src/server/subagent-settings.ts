/**
 * subagent-settings.ts — 子代理配置持久化与设置页 API 数据边界
 * ============================================================
 * .web-config.json 的 subagents 是唯一落盘位置。本模块负责：
 *  - 启动时读取并兼容字段缺失；
 *  - 串行化新增 / 编辑 / 启停 / 删除，写盘成功后才替换内存状态；
 *  - 校验名称、说明与模型引用；
 *  - 返回不含密钥的设置页快照，并标记固定模型是否仍可用。
 */
import { randomUUID } from "node:crypto";
import { mergeConfig, readConfig } from "./config-store.js";
import { writeAudit } from "./audit.js";
import { resolveModelRuntime, type SubagentModelSelection } from "../model-runtime.js";
import { isAgentProfileId, type AgentProfileId } from "../agent/profile.js";
import type { SubagentRouting } from "../routing/types.js";
import {
  cloneSubagent,
  cloneSubagents,
  DEFAULT_SUBAGENTS,
  getSubagentSnapshot,
  replaceSubagentStateForServer,
  type SubagentConfig,
} from "../subagent-state.js";

export interface PublicSubagent extends SubagentConfig {
  modelLabel: string;
  modelAvailable: boolean;
  /** 是否参与路由竞争（有分类别或关键词）；兜底型 agent 为 false */
  routable: boolean;
}

/** 路由元数据字段上限：设置页是手填的，不能让人贴一整段提示词进来。 */
const MAX_KEYWORDS = 40;
const MAX_KEYWORD_CHARS = 24;
const MAX_CATEGORY_CHARS = 20;
const MAX_SUITABLE_ITEMS = 8;
const MAX_NOT_SUITABLE_ITEMS = 8;
const MAX_SCENARIO_CHARS = 120;

export interface SubagentSettingsSnapshot {
  agents: PublicSubagent[];
}

let writeQueue: Promise<void> = Promise.resolve();

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field}必须是字符串`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}不能为空`);
  if (normalized.length > max) throw new Error(`${field}不能超过 ${max} 个字符`);
  return normalized;
}

function normalizeModel(value: unknown): SubagentModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "inherit" };
  const record = value as Record<string, unknown>;
  if (record.mode === "fixed" && typeof record.providerId === "string" && typeof record.modelId === "string") {
    return { mode: "fixed", providerId: record.providerId, modelId: record.modelId };
  }
  return { mode: "inherit" };
}

function parseModelInput(value: unknown): SubagentModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model 必须是 { mode: 'inherit' } 或 { mode: 'fixed', providerId, modelId }");
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "inherit") return { mode: "inherit" };
  if (record.mode === "fixed") {
    if (typeof record.providerId !== "string" || !record.providerId.trim()) throw new Error("固定模型缺少 providerId");
    if (typeof record.modelId !== "string" || !record.modelId.trim()) throw new Error("固定模型缺少 modelId");
    return { mode: "fixed", providerId: record.providerId.trim(), modelId: record.modelId.trim() };
  }
  throw new Error("model.mode 只能是 inherit 或 fixed");
}

function stringList(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field}必须是字符串数组`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${field}必须是字符串数组`);
    const text = item.trim();
    if (!text) continue;
    if (text.length > maxChars) throw new Error(`${field}中每一项不能超过 ${maxChars} 个字符`);
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

/** 读取兼容：旧配置没有 routing 字段时按空名片处理，不报错也不挪用默认值。 */
function normalizeRouting(raw: unknown): SubagentRouting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { keywords: [], suitableFor: [], notSuitableFor: [] };
  }
  const record = raw as Record<string, unknown>;
  const category = typeof record.category === "string" ? record.category.trim().slice(0, MAX_CATEGORY_CHARS) : "";
  const domainProfile = isAgentProfileId(record.domainProfile) ? record.domainProfile : undefined;
  return {
    keywords: Array.isArray(record.keywords)
      ? record.keywords.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, MAX_KEYWORDS)
      : [],
    ...(category ? { category } : {}),
    suitableFor: Array.isArray(record.suitableFor)
      ? record.suitableFor.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, MAX_SUITABLE_ITEMS)
      : [],
    notSuitableFor: Array.isArray(record.notSuitableFor)
      ? record.notSuitableFor.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, MAX_NOT_SUITABLE_ITEMS)
      : [],
    ...(domainProfile ? { domainProfile } : {}),
  };
}

/** 写入校验：字段类型与长度不对时抛中文错误，让设置页能直接展示。 */
function parseRoutingInput(value: unknown): SubagentRouting {
  if (value === undefined) return { keywords: [], suitableFor: [], notSuitableFor: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("routing 必须是对象");
  const record = value as Record<string, unknown>;
  const keywords = stringList(record.keywords, "路由关键词", MAX_KEYWORDS, MAX_KEYWORD_CHARS);
  const suitableFor = stringList(record.suitableFor, "适用场景", MAX_SUITABLE_ITEMS, MAX_SCENARIO_CHARS);
  const notSuitableFor = stringList(record.notSuitableFor, "不适用场景", MAX_NOT_SUITABLE_ITEMS, MAX_SCENARIO_CHARS);
  const categoryRaw = record.category;
  if (categoryRaw !== undefined && categoryRaw !== null && typeof categoryRaw !== "string") {
    throw new Error("类别必须是字符串");
  }
  const category = typeof categoryRaw === "string" ? categoryRaw.trim() : "";
  if (category.length > MAX_CATEGORY_CHARS) throw new Error(`类别不能超过 ${MAX_CATEGORY_CHARS} 个字符`);
  const domainRaw = record.domainProfile;
  if (domainRaw !== undefined && domainRaw !== null && domainRaw !== "" && !isAgentProfileId(domainRaw)) {
    throw new Error("domainProfile 只能是 general 或 estate，留空表示使用通用子代理提示词");
  }
  const domainProfile: AgentProfileId | undefined = isAgentProfileId(domainRaw) ? domainRaw : undefined;
  return {
    keywords,
    ...(category ? { category } : {}),
    suitableFor,
    notSuitableFor,
    ...(domainProfile ? { domainProfile } : {}),
  };
}

function normalizeSaved(raw: unknown): SubagentConfig[] {
  if (!Array.isArray(raw)) return cloneSubagents(DEFAULT_SUBAGENTS);
  const seen = new Set<string>();
  const result: SubagentConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 60)
      : id;
    const description = typeof record.description === "string"
      ? record.description.trim().slice(0, 500)
      : "";
    result.push({
      id,
      name,
      description,
      enabled: record.enabled !== false,
      model: normalizeModel(record.model),
      routing: normalizeRouting(record.routing),
      builtIn: record.builtIn === true,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
    });
  }
  return result;
}

export async function loadSubagentSettings(): Promise<void> {
  const stored = await readConfig();
  replaceSubagentStateForServer(normalizeSaved(stored.subagents));
}

function publicAgent(agent: SubagentConfig): PublicSubagent {
  const runtime = resolveModelRuntime(agent.model);
  return {
    ...cloneSubagent(agent),
    modelLabel: runtime?.label ?? (agent.model.mode === "fixed" ? "固定模型不可用" : "当前主对话模型"),
    modelAvailable: Boolean(runtime),
    routable: isRoutable(agent.routing),
  };
}

/** 有类别或关键词才算「能参与路由竞争」；两者都空说明它是兜底型 agent。 */
function isRoutable(routing: SubagentRouting): boolean {
  return routing.keywords.length > 0 || Boolean(routing.category);
}

export function getSubagentSettings(): SubagentSettingsSnapshot {
  return { agents: getSubagentSnapshot().map(publicAgent) };
}

function validateModel(model: SubagentModelSelection): SubagentModelSelection {
  if (model.mode === "fixed") {
    if (!resolveModelRuntime(model)) {
      throw new Error("所选供应商或模型不存在，请重新选择");
    }
    return { mode: "fixed", providerId: model.providerId, modelId: model.modelId };
  }
  return { mode: "inherit" };
}

function enqueue(run: () => Promise<void>): Promise<SubagentSettingsSnapshot> {
  const task = writeQueue.then(run);
  writeQueue = task.catch(() => {});
  return task.then(() => getSubagentSettings());
}

export function createSubagent(input: {
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  model?: unknown;
  routing?: unknown;
}): Promise<SubagentSettingsSnapshot> {
  return enqueue(async () => {
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    const now = Date.now();
    const agent: SubagentConfig = {
      id: `sub-${randomUUID().slice(0, 8)}`,
      name: text(input.name, "名称", 60),
      description: text(input.description, "用途说明", 500),
      enabled: input.enabled !== false,
      model: validateModel(parseModelInput(input.model)),
      routing: parseRoutingInput(input.routing),
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };
    const current = getSubagentSnapshot();
    if (current.some((item) => item.name === agent.name)) throw new Error(`子代理名称「${agent.name}」已存在`);
    const next = [...current, agent];
    await mergeConfig({ subagents: next });
    replaceSubagentStateForServer(next);
    writeAudit("subagent.created", { id: agent.id, name: agent.name, model: agent.model });
  });
}

export function updateSubagent(
  id: string,
  input: {
    name?: unknown;
    description?: unknown;
    enabled?: unknown;
    model?: unknown;
    routing?: unknown;
  },
): Promise<SubagentSettingsSnapshot> {
  return enqueue(async () => {
    const current = getSubagentSnapshot();
    const index = current.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("子代理不存在或已被删除");
    const before = current[index]!;
    const nextAgent: SubagentConfig = {
      ...before,
      ...(input.name !== undefined ? { name: text(input.name, "名称", 60) } : {}),
      ...(input.description !== undefined ? { description: text(input.description, "用途说明", 500) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      ...(input.model !== undefined ? { model: validateModel(parseModelInput(input.model)) } : {}),
      ...(input.routing !== undefined ? { routing: parseRoutingInput(input.routing) } : {}),
      updatedAt: Date.now(),
    };
    if (current.some((item) => item.id !== id && item.name === nextAgent.name)) {
      throw new Error(`子代理名称「${nextAgent.name}」已存在`);
    }
    const next = [...current];
    next[index] = nextAgent;
    await mergeConfig({ subagents: next });
    replaceSubagentStateForServer(next);
    writeAudit("subagent.updated", { id, enabled: nextAgent.enabled, model: nextAgent.model });
  });
}

export function deleteSubagent(id: string): Promise<SubagentSettingsSnapshot> {
  return enqueue(async () => {
    const current = getSubagentSnapshot();
    if (!current.some((item) => item.id === id)) throw new Error("子代理不存在或已被删除");
    const next = current.filter((item) => item.id !== id);
    await mergeConfig({ subagents: next });
    replaceSubagentStateForServer(next);
    writeAudit("subagent.deleted", { id });
  });
}
