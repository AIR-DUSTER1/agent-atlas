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
}

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
  };
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
