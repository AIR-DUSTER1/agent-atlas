/**
 * ============================================================
 * routing/backends/index.ts — 决策后端接口与工厂
 * ============================================================
 * 职责：定义 L3 的唯一入口，并按配置选择具体后端；后端不可用一律返回 null，
 * 由上层降级到纯规则，绝不抛错打断对话。
 *
 * 设计立场：
 *  - 后端只负责「给一份用户文本，返回候选上的概率分布」；
 *    白名单、阈值、多意图这些判断全部在 guards.ts，后端不参与；
 *  - `null` 表示「这一层弃权」，与「模型说不知道」是两件事：
 *    前者是能力缺失，后者是置信度低，处置方式不同。
 */
import type { RoutingCandidate, RoutingLimits } from "../types.js";

export interface RawDecision {
  /** 模型选中的 agent id（未归一化，可能需要 G1 白名单校正） */
  agentId: string;
  /** 0..1 置信度，口径由后端自己说明 */
  confidence: number;
  /** top1 − top2；后端拿不到时给 1（单候选语义） */
  margin: number;
  reason: string;
  /** 拆出的意图；后端不拆就返回空数组（守卫会跳过 G4） */
  intents: Array<{ text: string; agentId: string }>;
  /** 实际使用的候选项与概率，供日志与事件排障 */
  probabilities: Record<string, number>;
}

export interface DecisionBackend {
  /** 后端标识，写进事件与日志 */
  readonly id: string;
  /** 不可用时的原因（用于设置页提示）；可用时为 null */
  readonly unavailableReason: string | null;
  decide(input: {
    text: string;
    candidates: readonly RoutingCandidate[];
    limits: RoutingLimits;
    signal?: AbortSignal;
  }): Promise<RawDecision | null>;
}

/** 把概率分布整理成 RawDecision 的公共实现，两个后端共用同一份口径。 */
export function decisionFromProbabilities(input: {
  probabilities: Record<string, number>;
  candidates: readonly RoutingCandidate[];
  confidence: number;
  reason?: string;
  intents?: Array<{ text: string; agentId: string }>;
}): RawDecision {
  const entries = [...new Set(input.candidates.map((item) => item.agentId))]
    .map((agentId) => [agentId, Math.max(0, Number(input.probabilities[agentId]) || 0)] as const)
    .sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  const second = entries[1];
  const margin = top ? Math.max(0, top[1] - (second?.[1] ?? 0)) : 0;
  return {
    agentId: top?.[0] ?? "",
    confidence: clamp01(input.confidence),
    margin,
    reason: input.reason ?? (top ? `模型判定 ${top[0]}（p=${top[1].toFixed(2)}）` : "模型没有给出候选"),
    intents: input.intents ?? [],
    probabilities: Object.fromEntries(entries),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 配置里声明的后端名可能是脏值；只认三个已知 id。 */
export function normalizeBackendId(value: unknown): "openai-compat" | "systemone" | "rules-only" {
  if (value === "systemone" || value === "rules-only") return value;
  return "openai-compat";
}
