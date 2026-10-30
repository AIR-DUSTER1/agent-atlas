/**
 * modules/reasoning-display.ts — 思考等级快捷菜单的展示规则
 * ============================================================
 * 后端保留完整方言档位供模型设置页和旧配置兼容；顶栏快捷菜单只展示
 * 用户真正会切换的强度项：
 *  - 隐藏「供应商默认」；
 *  - DeepSeek 隐藏「开启思考（默认强度）」；
 *  - 去掉「思考·」「强度·」等重复前缀。
 */
import type { ReasoningLevel } from "./types-api.js";

export function isQuickReasoningLevelHidden(
  level: ReasoningLevel,
  dialect: string | undefined,
): boolean {
  if (level.id === "default") return true;
  return dialect === "deepseek-thinking" && level.id === "enabled";
}

export function visibleQuickReasoningLevels(
  levels: readonly ReasoningLevel[] | undefined,
  dialect: string | undefined,
): ReasoningLevel[] {
  return (levels ?? []).filter((level) => !isQuickReasoningLevelHidden(level, dialect));
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
