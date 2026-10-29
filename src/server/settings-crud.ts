/**
 * ============================================================
 * settings-crud.ts — 供应商 / 模型的写操作（增 / 改 / 删 / 切换）
 * ============================================================
 * 职责：八个写接口 —— addProvider / updateProvider / deleteProvider / activate /
 * addModel / updateModel / deleteModel / setReasoning。
 * 设计立场：
 *  - 与 settings.ts 分离：那边持有内存状态与对外装配（读），这里只做写；
 *    两者通过 settings.ts 导出的受控访问器操作同一份状态（不复制、不缓存）；
 *  - 每个写操作结束必须 persistForCrud()（落 .web-config.json，原子写由 config-store 保证）；
 *  - 影响「当前启用项」的操作返回 activeChanged，路由层据此决定是否重建模型实例。
 */

import { randomUUID } from "node:crypto";
import { isProtocol } from "../config.js";
import {
  activeIdRef, activeModelOfForCrud, activeProviderForCrud, applyActiveToConfigForCrud, assertReasoningValidForCrud,
  parseModelFieldsForCrud, persistForCrud, providersRef, setActiveIdRef, toModelEntryForCrud,
  toPublicForCrud, toPublicModelForCrud, validBaseURLForCrud,
  type ModelEntryRef, type ProviderRef,
} from "./settings.js";
import { refreshModelInfo } from "./settings-gateway.js";
import { config } from "../config.js";
import { DEFAULT_REASONING, resolveReasoning } from "../reasoning.js";
import { getReasoningState, type PublicModel, type PublicProvider } from "./settings.js";

/* 本文件内沿用短名，避免满屏 Ref 后缀 */
type Provider = ProviderRef;
type ModelEntry = ModelEntryRef;


// ---------------------------------------------------------------------------
// 供应商：增 / 改 / 删 / 切换
// ---------------------------------------------------------------------------

/** 添加供应商；若是第一个供应商则自动启用 */
export async function addProvider(input: {
  name?: string; baseURL?: string; apiKey?: string; protocol?: unknown;
  /** v2：直接带一组模型 */
  models?: unknown;
  /** v1 兼容：单个模型名 */
  model?: string; modality?: unknown; contextWindow?: unknown;
}): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const name = input.name?.trim();
  if (!name) throw new Error("供应商名称不能为空");
  if (!input.baseURL) throw new Error("BASE_URL 不能为空");
  if (input.protocol !== undefined && !isProtocol(input.protocol)) {
    throw new Error("协议只支持 openai / openai-responses / anthropic / gemini");
  }

  const models: ModelEntry[] = [];
  if (Array.isArray(input.models)) {
    for (const item of input.models as Array<Record<string, unknown>>) models.push(toModelEntryForCrud(item ?? {}));
  }
  if (!models.length && input.model?.trim()) {
    models.push(toModelEntryForCrud({ name: input.model, modality: input.modality, contextWindow: input.contextWindow }));
  }
  if (!models.length) throw new Error("至少填一个模型名（可先点「获取列表」从网关选择）");
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.name)) throw new Error(`模型「${m.name}」重复了`);
    seen.add(m.name);
  }

  const provider: Provider = {
    id: randomUUID(),
    name,
    baseURL: validBaseURLForCrud(input.baseURL),
    apiKey: (input.apiKey ?? "").trim(),
    protocol: isProtocol(input.protocol) ? input.protocol : "openai",
    models,
    activeModelId: models[0].id,
  };
  providersRef().push(provider);

  const activeChanged = providersRef().length === 1;
  if (activeChanged) {
    setActiveIdRef(provider.id);
    applyActiveToConfigForCrud();
  }
  await persistForCrud();
  return { provider: toPublicForCrud(provider), activeChanged };
}

/** 更新供应商本身（名称 / 网关 / Key / 协议）；模型请用 addModel / updateModel */
export async function updateProvider(id: string, input: {
  name?: string; baseURL?: string; apiKey?: string; protocol?: unknown;
}): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const p = providersRef().find((x) => x.id === id);
  if (!p) throw new Error("供应商不存在");
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("供应商名称不能为空");
    p.name = input.name.trim();
  }
  if (input.baseURL !== undefined) p.baseURL = validBaseURLForCrud(input.baseURL);
  if (typeof input.apiKey === "string") p.apiKey = input.apiKey.trim();
  if (input.protocol !== undefined) {
    if (!isProtocol(input.protocol)) throw new Error("协议只支持 openai / openai-responses / anthropic / gemini");
    p.protocol = input.protocol;
  }

  const activeChanged = p.id === activeIdRef();
  if (activeChanged) applyActiveToConfigForCrud();
  await persistForCrud();
  return { provider: toPublicForCrud(p), activeChanged };
}

/** 删除供应商（至少保留一个）；删的是启用中的 → 自动切到第一个 */
export async function deleteProvider(id: string): Promise<{ activeChanged: boolean }> {
  if (providersRef().length <= 1) throw new Error("至少保留一个供应商");
  const idx = providersRef().findIndex((x) => x.id === id);
  if (idx === -1) throw new Error("供应商不存在");
  const wasActive = providersRef()[idx].id === activeIdRef();
  providersRef().splice(idx, 1);
  let activeChanged = false;
  if (wasActive) {
    setActiveIdRef(providersRef()[0].id);
    applyActiveToConfigForCrud();
    activeChanged = true;
  }
  await persistForCrud();
  return { activeChanged };
}

/**
 * 启用「供应商 + 模型」。
 * 顶栏下拉现在直接列出「每个供应商的每个模型」，所以这里一次到位：
 * 传 modelId 就同时切换该供应商内的启用模型。
 */
export async function activate(id: string, modelId?: string): Promise<{
  activeChanged: boolean; name: string; model: string; reasoningLabel: string;
}> {
  const p = providersRef().find((x) => x.id === id);
  if (!p) throw new Error("供应商不存在");
  if (!p.models.length) throw new Error(`「${p.name}」还没有添加模型，先编辑补上再启用`);
  // 先记录旧组合再修改：同供应商内换模型也必须重建图；否则旧会话会继续用旧模型。
  const previousProviderId = activeIdRef();
  const previousModelId = activeModelOfForCrud(activeProviderForCrud())?.id;
  if (modelId) {
    const target = p.models.find((m) => m.id === modelId);
    if (!target) throw new Error("模型不存在（可能已被删除）");
    p.activeModelId = target.id;
  }
  const nextModelId = activeModelOfForCrud(p)?.id;
  const activeChanged = previousProviderId !== p.id || previousModelId !== nextModelId;
  setActiveIdRef(p.id);
  applyActiveToConfigForCrud();
  await persistForCrud();
  const state = getReasoningState();
  return { activeChanged, name: p.name, model: config.model, reasoningLabel: state.label };
}

// ---------------------------------------------------------------------------
// 模型：增 / 改 / 删（一个供应商可以挂多个模型）
// ---------------------------------------------------------------------------

/** 给某个供应商添加模型；同名模型已存在时按「更新」处理（返回 created=false） */
export async function addModel(providerId: string, input: {
  name?: unknown; label?: unknown; modality?: unknown; contextWindow?: unknown;
  reasoning?: unknown; dialect?: unknown; level?: unknown; custom?: unknown;
  /** true = 添加后立即设为该供应商的启用模型（默认 true） */
  makeActive?: unknown;
}): Promise<{ provider: PublicProvider; model: PublicModel; created: boolean; activeChanged: boolean }> {
  const p = providersRef().find((x) => x.id === providerId);
  if (!p) throw new Error("供应商不存在");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("模型名不能为空（可先点「获取列表」从网关选择）");

  const existing = p.models.find((m) => m.name === name);
  const extra = parseModelFieldsForCrud(input);
  if (existing) {
    if (extra.modality) existing.modality = extra.modality;
    if ("manualContextWindow" in extra) existing.manualContextWindow = extra.manualContextWindow;
    if (extra.reasoning) {
      const merged = { ...DEFAULT_REASONING, ...existing.reasoning, ...extra.reasoning };
      assertReasoningValidForCrud(merged, { baseURL: p.baseURL, model: existing.name, protocol: p.protocol });
      existing.reasoning = merged;
    }
    if (typeof input.label === "string" && input.label.trim()) existing.label = input.label.trim();
    if (input.makeActive !== false) p.activeModelId = existing.id;
    const activeChanged = p.id === activeIdRef();
    if (activeChanged) applyActiveToConfigForCrud();
    await persistForCrud();
    return { provider: toPublicForCrud(p), model: toPublicModelForCrud(p, existing), created: false, activeChanged };
  }

  const entry = toModelEntryForCrud(input);
  entry.name = name;
  assertReasoningValidForCrud(entry.reasoning, { baseURL: p.baseURL, model: entry.name, protocol: p.protocol });
  p.models.push(entry);
  if (input.makeActive !== false) p.activeModelId = entry.id;
  const activeChanged = p.id === activeIdRef();
  if (activeChanged) applyActiveToConfigForCrud();
  await persistForCrud();
  return { provider: toPublicForCrud(p), model: toPublicModelForCrud(p, entry), created: true, activeChanged };
}

/** 更新某个模型的全部可编辑字段（模型名 / 显示名 / 多模态 / 上下文窗口 / 思考等级） */
export async function updateModel(providerId: string, modelId: string, input: {
  name?: unknown; label?: unknown; modality?: unknown; contextWindow?: unknown;
  reasoning?: unknown; dialect?: unknown; level?: unknown; custom?: unknown;
  makeActive?: unknown;
}): Promise<{ provider: PublicProvider; model: PublicModel; activeChanged: boolean }> {
  const p = providersRef().find((x) => x.id === providerId);
  if (!p) throw new Error("供应商不存在");
  const m = p.models.find((x) => x.id === modelId);
  if (!m) throw new Error("模型不存在");

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new Error("模型名不能为空");
    if (p.models.some((x) => x.id !== m.id && x.name === name)) throw new Error(`该供应商里已经有模型「${name}」了`);
    m.name = name;
  }
  if (input.label !== undefined) {
    const label = typeof input.label === "string" ? input.label.trim() : "";
    m.label = label || undefined;
  }
  const extra = parseModelFieldsForCrud(input);
  if (extra.modality) m.modality = extra.modality;
  if ("manualContextWindow" in extra) m.manualContextWindow = extra.manualContextWindow;
  if (extra.reasoning) {
    const merged = { ...DEFAULT_REASONING, ...m.reasoning, ...extra.reasoning };
    assertReasoningValidForCrud(merged, { baseURL: p.baseURL, model: m.name, protocol: p.protocol });
    m.reasoning = merged;
  }
  if (input.makeActive === true) p.activeModelId = m.id;

  const activeChanged = p.id === activeIdRef();
  if (activeChanged) applyActiveToConfigForCrud();
  await persistForCrud();
  return { provider: toPublicForCrud(p), model: toPublicModelForCrud(p, m), activeChanged };
}

/** 删除模型（每个供应商至少保留一个）；删的是启用中的 → 自动切到第一个 */
export async function deleteModel(providerId: string, modelId: string): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const p = providersRef().find((x) => x.id === providerId);
  if (!p) throw new Error("供应商不存在");
  if (p.models.length <= 1) throw new Error("每个供应商至少保留一个模型");
  const idx = p.models.findIndex((x) => x.id === modelId);
  if (idx === -1) throw new Error("模型不存在");
  const wasActive = p.models[idx].id === p.activeModelId;
  p.models.splice(idx, 1);
  if (wasActive) p.activeModelId = p.models[0].id;
  const activeChanged = p.id === activeIdRef();
  if (activeChanged) applyActiveToConfigForCrud();
  await persistForCrud();
  return { provider: toPublicForCrud(p), activeChanged };
}

/**
 * 只改「思考等级」——顶栏快捷切换与设置页档位下拉都走它。
 * 不传 providerId/modelId 时作用于当前启用的模型。
 */
export async function setReasoning(input: {
  providerId?: unknown; modelId?: unknown;
  dialect?: unknown; level?: unknown; custom?: unknown;
}): Promise<{ providerId: string; modelId: string; provider: PublicProvider; model: PublicModel; reasoningLabel: string; activeChanged: boolean }> {
  const p = (typeof input.providerId === "string" ? providersRef().find((x) => x.id === input.providerId) : undefined) ?? activeProviderForCrud();
  if (!p) throw new Error("供应商不存在");
  const m = (typeof input.modelId === "string" ? p.models.find((x) => x.id === input.modelId) : undefined) ?? activeModelOfForCrud(p);
  if (!m) throw new Error("该供应商还没有模型");
  const extra = parseModelFieldsForCrud({ dialect: input.dialect, level: input.level, custom: input.custom });
  const merged = { ...DEFAULT_REASONING, ...m.reasoning, ...(extra.reasoning ?? {}) };
  assertReasoningValidForCrud(merged, { baseURL: p.baseURL, model: m.name, protocol: p.protocol });
  m.reasoning = merged;

  const activeChanged = p.id === activeIdRef();
  if (activeChanged) applyActiveToConfigForCrud();
  await persistForCrud();
  const resolved = resolveReasoning(m.reasoning, { baseURL: p.baseURL, model: m.name, protocol: p.protocol });
  return { providerId: p.id, modelId: m.id, provider: toPublicForCrud(p), model: toPublicModelForCrud(p, m), reasoningLabel: resolved.label, activeChanged };
}

