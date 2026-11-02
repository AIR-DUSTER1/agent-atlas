/**
 * modules/reasoning-display.ts — 思考等级快捷菜单的展示规则
 * ============================================================
 * 后端方言只提供供应商原生有效档位；快捷菜单隐藏不发送参数的「供应商默认」，
 * 并去掉「思考·」「强度·」等重复前缀。
 */
import type { ReasoningLevel } from "./types-api.js";

export function isQuickReasoningLevelHidden(level: ReasoningLevel): boolean {
  return level.id === "default";
}

export function visibleQuickReasoningLevels(
  levels: readonly ReasoningLevel[] | undefined,
): ReasoningLevel[] {
  return (levels ?? []).filter((level) => !isQuickReasoningLevelHidden(level));
}

export function simplifyReasoningLabel(label: string): string {
  return label
    .replace(/^思考[·:：]\s*/, "")
    .replace(/^强度[·:：]\s*/, "")
    .replace(/^开启思考（默认强度）$/, "默认强度")
    .trim();
}

export function quickReasoningDisplayLabel(
  level: ReasoningLevel | undefined,
  fallback = "默认",
): string {
  if (!level || level.id === "default") return fallback;
  return simplifyReasoningLabel(level.label) || fallback;
}
