/**
 * ============================================================
 * settings-gateway.ts — 网关模型清单探测（多协议 /models）
 * ============================================================
 * 职责：按供应商协议探测模型列表、把 context_length / 能力标记灌进内存缓存，
 * 供前端的上下文容量条与「从网关添加模型」使用。
 * 设计立场：
 *  - 与 settings.ts 的「供应商落盘 / CRUD」分离：这里只读配置、不写配置文件；
 *  - 三种协议的列表端点与鉴权头完全不同（OpenAI Bearer / Anthropic x-api-key /
 *    Gemini query key），差异全部收在本文件，调用方只看到统一的 Map；
 *  - 探测失败一律抛中文错误（设置页「测试连接」直接展示给用户）。
 */

import { config, isProtocol, type Protocol } from "../config.js";
import { getProviderViewForGateway, validBaseURLForGateway } from "./settings.js";
import { modelInfoCache, type GatewayModelInfo } from "./settings-cache.js";

// 模型元信息缓存：context_length（上下文窗口）来自网关 /models 返回的字段
// （与 scripts/list-models.ts 看到的 GatewayModel.context_length 同源），
// 用于前端的「上下文容量条」与「从网关添加模型时预填能力」。
// 缓存按 供应商id → 模型id → 元信息 组织，仅存内存。
// ---------------------------------------------------------------------------

/** API Key 掩码：只露出首尾，避免明文回传到浏览器 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/**
 * 后台刷新启用中供应商的模型列表（拉不到就静默放弃），
 * 目的：把 context_length / 能力标记灌进缓存，让容量条与「添加模型」有依据。
 * 在服务启动 / 切换供应商 / 增删模型时 fire-and-forget 调用。
 */
export async function refreshModelInfo(): Promise<void> {
  const p = getProviderViewForGateway();
  if (!p || !p.apiKey) return; // 无 Key（模拟模式）时网关必然 401，不折腾
  try {
    const details = await fetchModelDetails({ providerId: p.id });
    modelInfoCache.set(p.id, details);
  } catch {
    /* 网关不可达 / Key 无效 → 容量条退化为「未知窗口」形态 */
  }
}

/**
 * 用给定（或指定供应商已保存）的网关配置拉取模型列表 —— 同时充当「测试连接」。
 * 优先级：显式 baseURL/apiKey > providerId 对应的已存档案 > 当前启用的供应商。
 * 按 provider 协议探测模型列表：openai 系、anthropic、gemini 各自的列表端点与鉴权头。
 * 返回 {模型id → 元信息} 映射（网关不报的字段就是 undefined）。
 */
export async function fetchModelDetails(opts: { baseURL?: string; apiKey?: string; providerId?: string; protocol?: unknown }): Promise<Map<string, GatewayModelInfo>> {
  let url = opts.baseURL?.trim();
  let key = opts.apiKey;
  let protocol: Protocol | undefined;
  if ((!url || key === undefined) && opts.providerId) {
    const p = getProviderViewForGateway(opts.providerId);
    if (!p) throw new Error("供应商不存在");
    url = url || p.baseURL;
    key = key !== undefined && key !== "" ? key : p.apiKey;
    protocol = p.protocol;
  }
  if (!url) url = config.baseURL;
  if (!protocol && opts.protocol !== undefined && isProtocol(opts.protocol)) protocol = opts.protocol;
  const u = validBaseURLForGateway(url);

  // ── Anthropic Messages 原生：GET {base}/v1/models，x-api-key 鉴权 ──
  if (protocol === "anthropic") {
    const res = await fetch(`${u}/v1/models?limit=100`, {
      headers: { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}（Anthropic 协议：检查地址是否指向 {网关}/anthropic 一类根路径、Key 是否有效）`);
    const body = await res.json() as { data?: Array<{ id?: string; display_name?: string }> };
    const details = new Map<string, GatewayModelInfo>();
    for (const m of body.data ?? []) {
      if (m.id) details.set(m.id, {});
      else if (m.display_name) details.set(m.display_name, {});
    }
    if (!details.size) throw new Error("网关连接成功，但没有返回任何模型");
    return details;
  }

  // ── Gemini 原生：GET {base}/v1beta/models?key=… ──
  if (protocol === "gemini") {
    const res = await fetch(`${u}/v1beta/models?pageSize=100&key=${encodeURIComponent(key ?? "")}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}（Gemini 协议：检查地址是否为 {网关} 根路径、Key 是否有效）`);
    const body = await res.json() as { models?: Array<{ name?: string; inputTokenLimit?: number }> };
    const details = new Map<string, GatewayModelInfo>();
    for (const m of body.models ?? []) {
      if (m.name) details.set(m.name.replace(/^models\//, ""), { contextWindow: m.inputTokenLimit });
    }
    if (!details.size) throw new Error("网关连接成功，但没有返回任何模型");
    return details;
  }

  // ── OpenAI Chat Completions / Responses API：GET {base}/models ──
  const res = await fetch(`${u}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`网关返回 HTTP ${res.status}（检查地址是否以 /v1 结尾、Key 是否有效）`);
  }
  const body = (await res.json()) as {
    data?: Array<{
      id?: string; context_length?: number; inputTokenLimit?: number;
      supports_vision?: boolean; supportsVision?: boolean;
      supports_reasoning?: boolean; supportsReasoning?: boolean;
    }>;
  };
  const details = new Map<string, GatewayModelInfo>();
  for (const m of body.data ?? []) {
    if (!m.id) continue;
    details.set(m.id, {
      contextWindow: typeof m.context_length === "number" ? m.context_length : typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined,
      supportsVision: typeof m.supports_vision === "boolean" ? m.supports_vision : m.supportsVision,
      supportsReasoning: typeof m.supports_reasoning === "boolean" ? m.supports_reasoning : m.supportsReasoning,
    });
  }
  if (!details.size) throw new Error("网关连接成功，但没有返回任何模型");
  return details;
}

/**
 * 拉取模型列表（设置页「获取列表」用）：
 * 返回每个模型的 id 与网关给出的元信息（上下文窗口 / 多模态 / 是否支持推理），
 * 前端据此渲染「可点击添加」的模型清单，并预填能力开关。
 */
export async function fetchGatewayModelList(opts: { baseURL?: string; apiKey?: string; providerId?: string; protocol?: unknown }): Promise<Array<{ id: string } & GatewayModelInfo>> {
  const details = await fetchModelDetails(opts);
  const providerId = opts.providerId ?? getProviderViewForGateway()?.id;
  if (providerId) {
    const merged = modelInfoCache.get(providerId) ?? new Map<string, GatewayModelInfo>();
    for (const [k, v] of details) merged.set(k, { ...(merged.get(k) ?? {}), ...v });
    modelInfoCache.set(providerId, merged);
  }
  return [...details.entries()]
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 兼容旧调用：只要模型 id 列表 */
export async function fetchGatewayModels(opts: { baseURL?: string; apiKey?: string; providerId?: string; protocol?: unknown }): Promise<string[]> {
  return (await fetchGatewayModelList(opts)).map((m) => m.id);
}
