/**
 * ============================================================
 * settings-cache.ts — 网关模型元信息缓存 + API Key 掩码
 * ============================================================
 * 职责：保存「供应商 × 模型 → context_length / 能力标记」的内存缓存，
 * 以及对外回传 Key 时的掩码函数。
 * 设计立场：
 *  - 缓存是纯内存态（重启即失），不落盘 —— 网关是唯一真相；
 *  - settings.ts（拼装对外的 PublicProvider）与 settings-gateway.ts（探测）
 *    都要用它，独立成最小模块避免两者互相 import 成环；
 *  - 掩码只露首尾 4 位：够人肉核对，不够被还原。
 */

/** 网关 /models 里能拿到的模型元信息（拿不到就是 undefined） */
export interface GatewayModelInfo {
  contextWindow?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

/** 供应商id → 模型id → 元信息（仅内存，重启即失） */
export const modelInfoCache = new Map<string, Map<string, GatewayModelInfo>>();

/** API Key 掩码：只露出首尾，避免明文回传到浏览器 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
