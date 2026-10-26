/**
 * ============================================================
 * settings.ts — Web 设置页后端：多供应商 × 多模型管理
 * ============================================================
 * 数据模型（v2，落盘在 .web-config.json，已 gitignore）：
 *
 *   providers: [
 *     {
 *       id, name, baseURL, apiKey, protocol,          // 「一个供应商」= 一套网关凭据
 *       models: [                                     // ★ 一个供应商可挂多个模型
 *         {
 *           id, name, label?,                         // name = 真正发给网关的 model 字段
 *           modality: "text" | "vision",              // 该模型能否吃图片
 *           manualContextWindow?,                     // 手动指定上下文窗口（优先于网关）
 *           reasoning: { dialect, level, custom? },   // ★ 该模型的思考等级（按供应商方言）
 *         }
 *       ],
 *       activeModelId,                                // 该供应商当前选中的模型
 *     }
 *   ],
 *   activeId: 启用的供应商 id
 *
 * 为什么把「模型」从供应商里拆成数组？
 *   同一个网关（一套 baseURL + Key）通常能提供好几个模型
 *   （例如 DeepSeek 官方同时有 deepseek-flash 与 deepseek-v4-pro），
 *   旧版每个供应商只能存一个模型名，切换模型就得建一个「供应商」，
 *   于是顶栏下拉里出现一堆同网关的重复条目，而真正想选的第二个模型却没有入口。
 *
 * 分层：.env < .web-config.json < 运行中内存。
 * 兼容旧格式：
 *   - v1 供应商（单个 model 字段）→ 自动迁移成 models 数组里的一个条目；
 *   - 更老的平铺格式 { baseURL, apiKey, model } → 迁移成一个供应商档案。
 * 首次启动且无文件时：从 .env 播种一个内存供应商（用户改动后才落盘）。
 *
 * 安全：API Key 永远不回传明文 —— 列表接口只返回掩码（maskKey），
 * 前端编辑时留空 Key 表示「保持不变」。
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { config, isProtocol, type Protocol } from "../config.js";
import {
  DEFAULT_REASONING,
  DIALECTS,
  getDialect,
  isDialectId,
  resolveReasoning,
  type ReasoningDialectId,
  type ReasoningSetting,
} from "../reasoning.js";
import { SETTINGS_FILE, mergeConfig } from "./config-store.js";
import { maskKey, modelInfoCache, type GatewayModelInfo } from "./settings-cache.js";

// ---------------------------------------------------------------------------
// 内部数据结构
// ---------------------------------------------------------------------------
interface ModelEntry {
  id: string;
  /** 真正发给网关的模型名（model 字段） */
  name: string;
  label?: string;
  /** 模型能力：text 纯文本（默认）/ vision 多模态 */
  modality: "text" | "vision";
  /** 手动上下文窗口（tokens）：优先于网关 context_length */
  manualContextWindow?: number;
  reasoning: ReasoningSetting;
}

interface Provider {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  /** 请求协议：openai / openai-responses / anthropic / gemini（决定请求路径与鉴权） */
  protocol: Protocol;
  models: ModelEntry[];
  /** 该供应商当前启用的模型 id */
  activeModelId: string;
}

/** 未手填且网关未返回窗口时的安全默认值；仅影响展示与容量条，不发送给模型。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

let providers: Provider[] = [];
let activeId: string | null = null;

/* ---------------------------------------------------------------------------
 * 受控访问器（供 settings-crud.ts 使用）：状态仍是本模块私有，外部只能经函数访问
 * ------------------------------------------------------------------------- */
export function providersRef(): Provider[] { return providers; }
export function activeIdRef(): string | null { return activeId; }
export function setActiveIdRef(id: string | null): void { activeId = id; }
export type { Provider as ProviderRef, ModelEntry as ModelEntryRef };

// 内部工具（部分以 *ForCrud 导出，供 settings-crud.ts 的写操作复用）
export function validBaseURLForCrud(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(u)) throw new Error("BASE_URL 必须是 http(s) 开头的完整地址，例如 https://api.example.com/v1");
  return u;
}

export function activeProviderForCrud(): Provider | undefined {
  return providers.find((p) => p.id === activeId);
}

export function activeModelOfForCrud(p: Provider | undefined): ModelEntry | undefined {
  if (!p) return undefined;
  return p.models.find((m) => m.id === p.activeModelId) ?? p.models[0];
}

/** 当前启用模型的显示名（usage 事件 / 统计页按模型聚合用；无配置时给空串） */
export function getActiveModelLabel(): string {
  const m = activeModelOfForCrud(activeProviderForCrud());
  return m ? (m.label || m.name) : "";
}

/** 把「启用的供应商 + 它的启用模型」真正套到运行时 config 上（llm.ts 建模型时读它） */
export function applyActiveToConfigForCrud(): void {
  const p = activeProviderForCrud();
  if (!p) return;
  config.baseURL = p.baseURL;
  config.apiKey = p.apiKey;
  config.protocol = p.protocol ?? "openai";
  const m = activeModelOfForCrud(p);
  if (m) {
    config.model = m.name;
    config.reasoning = { ...DEFAULT_REASONING, ...m.reasoning };
  } else {
    config.reasoning = { ...DEFAULT_REASONING };
  }
}

export async function persistForCrud(): Promise<void> {
  // merge 写入：只覆盖 providers/activeId，不碰同文件的 projects / externalAgents 等键
  await mergeConfig({ version: 2, providers, activeId });
}

/** 解析模型字段（新增 / 更新共用）——只返回「调用方真的传了」的键 */
export function parseModelFieldsForCrud(input: {
  modality?: unknown; contextWindow?: unknown; reasoning?: unknown; dialect?: unknown; level?: unknown; custom?: unknown;
}): Partial<Pick<ModelEntry, "modality" | "manualContextWindow" | "reasoning">> {
  const out: Partial<Pick<ModelEntry, "modality" | "manualContextWindow" | "reasoning">> = {};
  if (input.modality === "vision" || input.modality === "text") out.modality = input.modality;

  if (input.contextWindow !== undefined) {
    if (input.contextWindow === null || input.contextWindow === "") {
      out.manualContextWindow = undefined; // 空 = 清除手动值，回到「自动从网关获取」
    } else {
      const n = Number(input.contextWindow);
      if (!Number.isFinite(n) || n < 1024) throw new Error("上下文窗口需为不小于 1024 的数字（tokens）");
      out.manualContextWindow = Math.round(n);
    }
  }

  // 思考等级：既接受 { reasoning: { dialect, level, custom } } 整体，也接受扁平字段。
  // ★ 只写入调用方给出的键 —— 顶栏快捷切换只传 level，不能把用户选好的方言冲回 auto。
  const raw = (input.reasoning && typeof input.reasoning === "object" ? input.reasoning : {}) as Record<string, unknown>;
  const dialectRaw = raw.dialect ?? input.dialect;
  const levelRaw = raw.level ?? input.level;
  const customRaw = raw.custom ?? input.custom;
  if (dialectRaw !== undefined || levelRaw !== undefined || customRaw !== undefined) {
    const reasoning: Partial<ReasoningSetting> = {};
    if (dialectRaw !== undefined) {
      if (!isDialectId(dialectRaw)) throw new Error(`未知的思考等级方言：${String(dialectRaw)}（见设置页下拉里的可选值）`);
      reasoning.dialect = dialectRaw;
    }
    if (levelRaw !== undefined) {
      if (typeof levelRaw !== "string" || !levelRaw.trim()) throw new Error("思考等级档位不能为空");
      reasoning.level = levelRaw.trim();
    }
    if (customRaw !== undefined) {
      const text = String(customRaw ?? "");
      if (text.length > 4000) throw new Error("自定义 JSON 过长（上限 4000 字符）");
      reasoning.custom = text;
    }
    out.reasoning = reasoning as ReasoningSetting;
  }
  return out;
}

/**
 * 校验「方言 + 档位」组合（在合并完最终值之后调用）：
 * 档位必须属于该方言，自定义 JSON 必须能解析 —— 否则用户选了档位却什么也没发生。
 */
export function assertReasoningValidForCrud(reasoning: ReasoningSetting, ctx: { baseURL: string; model: string; protocol: Protocol }): void {
  const resolved = resolveReasoning(reasoning, ctx);
  if (resolved.error) throw new Error(resolved.error);
  const dialect = getDialect(resolved.dialect);
  const level = reasoning.level ?? "default";
  const known = dialect.levels.some((l) => l.id === level);
  if (!known && level !== "custom") {
    throw new Error(
      `「${dialect.label}」没有「${level}」这个档位（可选：${dialect.levels.map((l) => l.id).join(" / ")}）`
    );
  }
}

/** 把一个「模型输入」解析成 ModelEntry（新增 / 从网关导入都用它） */
export function toModelEntryForCrud(input: {
  name?: unknown; label?: unknown; modality?: unknown; contextWindow?: unknown; reasoning?: unknown;
}): ModelEntry {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("模型名不能为空（可先点「获取列表」从网关选择）");
  const extra = parseModelFieldsForCrud(input);
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;
  return {
    id: randomUUID(),
    name,
    label,
    modality: extra.modality ?? "text",
    manualContextWindow: extra.manualContextWindow,
    reasoning: extra.reasoning ?? { ...DEFAULT_REASONING },
  };
}

// ---------------------------------------------------------------------------
// 启动加载（含旧格式迁移 / .env 播种）
// ---------------------------------------------------------------------------
/** 把文件里的一条供应商记录（v1 或 v2）规范成 v2 结构 */
function normalizeProvider(raw: Record<string, unknown>): Provider {
  const id = typeof raw.id === "string" && raw.id ? raw.id : randomUUID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "未命名供应商";
  const baseURL = String(raw.baseURL ?? "").trim().replace(/\/+$/, "");
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
  const protocol = isProtocol(raw.protocol) ? raw.protocol : "openai";

  const models: ModelEntry[] = [];
  if (Array.isArray(raw.models)) {
    for (const item of raw.models as Array<Record<string, unknown>>) {
      if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
      const reasoningRaw = (item.reasoning && typeof item.reasoning === "object" ? item.reasoning : {}) as Record<string, unknown>;
      const dialect = isDialectId(reasoningRaw.dialect) ? (reasoningRaw.dialect as ReasoningDialectId | "auto") : "auto";
      models.push({
        id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
        name: item.name.trim(),
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : undefined,
        modality: item.modality === "vision" ? "vision" : "text",
        manualContextWindow: typeof item.manualContextWindow === "number" ? item.manualContextWindow : undefined,
        reasoning: {
          dialect,
          level: typeof reasoningRaw.level === "string" && reasoningRaw.level ? reasoningRaw.level : "default",
          custom: typeof reasoningRaw.custom === "string" ? reasoningRaw.custom : undefined,
        },
      });
    }
  }

  // ── v1 迁移：单个 model + modality + manualContextWindow → models 里的一个条目 ──
  if (!models.length && typeof raw.model === "string" && raw.model.trim()) {
    models.push({
      id: randomUUID(),
      name: raw.model.trim(),
      modality: raw.modality === "vision" ? "vision" : "text",
      manualContextWindow: typeof raw.manualContextWindow === "number" ? raw.manualContextWindow : undefined,
      reasoning: { ...DEFAULT_REASONING },
    });
  }

  const activeModelId =
    typeof raw.activeModelId === "string" && models.some((m) => m.id === raw.activeModelId)
      ? (raw.activeModelId as string)
      : models[0]?.id ?? "";

  return { id, name, baseURL, apiKey, protocol, models, activeModelId };
}

export async function loadSettings(): Promise<void> {
  let saved: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    saved = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    saved = null; // 文件不存在 = 没有 Web 端配置
  }

  if (saved && Array.isArray(saved.providers) && saved.providers.length) {
    // ── 供应商数组（v1 单模型 / v2 多模型都会在这里被规范成 v2）──
    providers = (saved.providers as Array<Record<string, unknown>>)
      .filter((p) => p && typeof p.baseURL === "string" && /^https?:\/\//.test(p.baseURL))
      .map(normalizeProvider);
    if (!providers.length) return seedFromEnv();
    const savedActive = typeof saved.activeId === "string" ? saved.activeId : "";
    activeId = providers.some((p) => p.id === savedActive) ? savedActive : providers[0].id;
    applyActiveToConfigForCrud(); // ★ 启动时把启用中的供应商 + 模型真正套到 config 上
    return;
  }

  if (saved && typeof saved.baseURL === "string") {
    // ── 更老的单供应商平铺格式 → 迁移成一个档案 ──
    providers = [normalizeProvider({ ...saved, id: randomUUID(), name: "默认供应商" })];
    activeId = providers[0].id;
    applyActiveToConfigForCrud();
    await persistForCrud().catch(() => {});
    return;
  }

  seedFromEnv();
}

/** 无文件：从 .env 播种一个内存供应商（任何修改后才会写入文件） */
function seedFromEnv(): void {
  const model: ModelEntry = {
    id: randomUUID(),
    name: config.model,
    modality: "text",
    reasoning: { ...DEFAULT_REASONING },
  };
  providers = [{
    id: "default",
    name: "默认供应商（.env）",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    protocol: config.protocol,
    models: [model],
    activeModelId: model.id,
  }];
  activeId = providers[0].id;
}

// ---------------------------------------------------------------------------
// 查询（对外只给掩码 + 解析好的展示信息）
// ---------------------------------------------------------------------------
export interface PublicModel {
  id: string;
  /** 发给网关的模型名 */
  name: string;
  /** 显示名（默认等于 name） */
  displayName: string;
  modality: "text" | "vision";
  manualContextWindow: number | null;
  /** 该模型实际生效的上下文窗口（手动 > 网关 > 默认 200k） */
  contextWindow: number;
  /** 上下文窗口来源，设置页据此标注“手动 / 网关 / 默认”。 */
  contextWindowSource: "manual" | "gateway" | "default";
  /** 思考等级设置（auto = 自动识别方言） */
  reasoning: ReasoningSetting;
  /** 解析后的方言 id 与档位（auto 会被解析成具体方言） */
  reasoningDialect: ReasoningDialectId;
  reasoningLevel: string;
  reasoningLabel: string;
  reasoningError: string | null;
  /** 该供应商下当前启用的模型 */
  active: boolean;
  gateway: GatewayModelInfo | null;
}

export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string;
  hasKey: boolean;
  keyMasked: string;
  active: boolean;
  protocol: Protocol;
  /** 当前启用模型的名字（无模型时为空串，兼容旧前端字段） */
  model: string;
  activeModelId: string | null;
  models: PublicModel[];
}

export function listProviders(): PublicProvider[] {
  return providers.map(toPublicForCrud);
}

export function getActiveId(): string | null {
  return activeId;
}

export function getActiveModelId(): string | null {
  return activeModelOfForCrud(activeProviderForCrud())?.id ?? null;
}

export function toPublicModelForCrud(p: Provider, m: ModelEntry): PublicModel {
  const ctx = { baseURL: p.baseURL, model: m.name, protocol: p.protocol };
  const resolved = resolveReasoning(m.reasoning, ctx);
  const gateway = modelInfoCache.get(p.id)?.get(m.name) ?? null;
  const manualContextWindow = m.manualContextWindow ?? null;
  const gatewayContextWindow = gateway?.contextWindow ?? null;
  const contextWindow = manualContextWindow ?? gatewayContextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextWindowSource = manualContextWindow
    ? "manual"
    : gatewayContextWindow ? "gateway" : "default";
  return {
    id: m.id,
    name: m.name,
    displayName: m.label || m.name,
    modality: m.modality ?? "text",
    manualContextWindow,
    contextWindow,
    contextWindowSource,
    reasoning: { ...DEFAULT_REASONING, ...m.reasoning },
    reasoningDialect: resolved.dialect,
    reasoningLevel: resolved.level,
    reasoningLabel: resolved.label,
    reasoningError: resolved.error ?? null,
    active: m.id === p.activeModelId,
    gateway,
  };
}

export function toPublicForCrud(p: Provider): PublicProvider {
  const activeM = activeModelOfForCrud(p);
  return {
    id: p.id,
    name: p.name,
    baseURL: p.baseURL,
    hasKey: Boolean(p.apiKey),
    keyMasked: maskKey(p.apiKey),
    active: p.id === activeId,
    protocol: p.protocol ?? "openai",
    model: activeM?.name ?? "",
    activeModelId: activeM?.id ?? null,
    models: p.models.map((m) => toPublicModelForCrud(p, m)),
  };
}

/** 启用中供应商的模型能力（vision = 可接收图片输入） */
export function getActiveModality(): "text" | "vision" {
  return activeModelOfForCrud(activeProviderForCrud())?.modality ?? "text";
}

/** 启用中「供应商 + 模型」的上下文窗口长度（手动 > 网关 > 默认 200k）；
 *  没有任何启用模型时才返回 undefined。 */
export function getContextWindowForActive(): number | undefined {
  const p = activeProviderForCrud();
  const m = activeModelOfForCrud(p);
  if (!p || !m) return undefined;
  if (m.manualContextWindow) return m.manualContextWindow;
  return modelInfoCache.get(p.id)?.get(m.name)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * 当前启用模型的思考等级状态（给前端渲染「等级下拉 + 说明」用）。
 * dialect 是 auto 时会带上解析结果，前端展示「自动识别为 XXX」。
 */
export function getReasoningState() {
  const p = activeProviderForCrud();
  const m = activeModelOfForCrud(p);
  const setting: ReasoningSetting = { ...DEFAULT_REASONING, ...(m?.reasoning ?? {}) };
  const resolved = resolveReasoning(setting, { baseURL: p?.baseURL, model: m?.name, protocol: p?.protocol });
  const dialect = getDialect(resolved.dialect);
  return {
    dialect: resolved.dialect,
    dialectLabel: dialect.label,
    vendor: dialect.vendor,
    field: dialect.field,
    scheme: dialect.scheme,
    auto: (setting.dialect ?? "auto") === "auto",
    level: resolved.level,
    label: resolved.label,
    error: resolved.error ?? null,
    custom: setting.custom ?? "",
    levels: dialect.levels.map((l) => ({ id: l.id, label: l.label, desc: l.desc })),
  };
}

/** 方言目录（设置页渲染「思考等级划分方式」下拉用） */
export function listDialects() {
  return DIALECTS.map((d) => ({
    id: d.id,
    label: d.label,
    vendor: d.vendor,
    field: d.field,
    scheme: d.scheme,
    protocols: d.protocols ?? null,
    levels: d.levels.map((l) => ({ id: l.id, label: l.label, desc: l.desc })),
  }));
}

// ---------------------------------------------------------------------------

/* ---------------------------------------------------------------------------
 * 供 settings-gateway.ts 使用的只读访问器（不暴露可写的 providers 数组）
 * ------------------------------------------------------------------------- */
export interface GatewayProviderView {
  id: string;
  baseURL: string;
  apiKey: string;
  protocol: Protocol;
}

/** 取供应商只读视图：传 id 取指定，不传取当前启用项 */
export function getProviderViewForGateway(id?: string): GatewayProviderView | null {
  const p = id ? providers.find((x) => x.id === id) : activeProviderForCrud();
  return p ? { id: p.id, baseURL: p.baseURL, apiKey: p.apiKey, protocol: p.protocol } : null;
}

export function validBaseURLForGateway(url: string): string {
  return validBaseURLForCrud(url);
}

// 拆出去的三块再导出，既有调用方（routes/*、index.ts）无需改动
export {
  refreshModelInfo, fetchModelDetails, fetchGatewayModelList, fetchGatewayModels,
} from "./settings-gateway.js";
export { maskKey, type GatewayModelInfo } from "./settings-cache.js";
export {
  addProvider, updateProvider, deleteProvider, activate,
  addModel, updateModel, deleteModel, setReasoning,
} from "./settings-crud.js";
