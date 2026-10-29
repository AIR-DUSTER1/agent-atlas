/**
 * ============================================================
 * context-window.ts — 模型窗口预算的唯一计算口径
 * ============================================================
 * 职责：把「模型总窗口」拆成输出预留、安全余量与可用输入预算，
 * 并提供保守的文本 token 估算。Agent 裁剪与前端容量条必须共用这一口径。
 * 设计立场：
 * - 窗口来自当前模型，而不是固定字符数；换模型后重建图即换预算；
 * - 输出预留按窗口比例封顶，避免小窗口模型把输入空间全部占满；
 * - 估算器宁可略高估：CJK/非 ASCII 约 1 字 1 token，ASCII 约 4 字 1 token。
 */

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const MIN_CONTEXT_WINDOW_TOKENS = 1_024;
const MIN_OUTPUT_RESERVE_TOKENS = 256;
const MAX_OUTPUT_RESERVE_TOKENS = 8_192;
const OUTPUT_RESERVE_RATIO = 0.25;
const SAFETY_MARGIN_RATIO = 0.05;
const MIN_SAFETY_MARGIN_TOKENS = 64;
const MAX_SAFETY_MARGIN_TOKENS = 32_768;

export interface ContextWindowBudget {
  /** 供应商声明的模型总窗口。 */
  contextWindow: number;
  /** 给模型回答/思考保留的 token。 */
  outputReserveTokens: number;
  /** 防止 tokenizer 估算误差与供应商额外计费字段的安全余量。 */
  safetyMarginTokens: number;
  /** 本轮输入（system + 历史 + 当前消息）可用的 token 上限。 */
  inputBudgetTokens: number;
}

/** 当前请求真正能装多少输入；所有裁剪/展示都应使用这里的结果。 */
export function createContextWindowBudget(contextWindow?: number | null): ContextWindowBudget {
  const window = Number.isFinite(contextWindow) && Number(contextWindow) >= MIN_CONTEXT_WINDOW_TOKENS
    ? Math.floor(Number(contextWindow))
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const outputReserveTokens = Math.min(
    MAX_OUTPUT_RESERVE_TOKENS,
    Math.max(MIN_OUTPUT_RESERVE_TOKENS, Math.floor(window * OUTPUT_RESERVE_RATIO)),
  );
  // 安全余量不能吃掉小窗口仅有的输入空间：取窗口的 5%，但对极小窗口
  // 至少给当前用户消息留出一半窗口，避免预算变成 0 后整个历史被丢弃。
  const safeMarginCeiling = Math.max(MIN_SAFETY_MARGIN_TOKENS, Math.floor(window / 2));
  const safetyMarginTokens = Math.max(0, Math.min(
    MAX_SAFETY_MARGIN_TOKENS,
    safeMarginCeiling,
    Math.ceil(window * SAFETY_MARGIN_RATIO),
  ));
  return {
    contextWindow: window,
    outputReserveTokens,
    safetyMarginTokens,
    inputBudgetTokens: Math.max(0, window - outputReserveTokens - safetyMarginTokens),
  };
}

/** 保守估算：非 ASCII 字符按 1 token，ASCII 按 4 字符 1 token。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let nonAscii = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) nonAscii += 1;
  }
  const ascii = Math.max(0, text.length - nonAscii);
  return nonAscii + Math.ceil(ascii / 4);
}
