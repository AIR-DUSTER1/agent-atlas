/**
 * ============================================================
 * routing/guards.ts — G1–G4 守卫（纯函数，可单测）
 * ============================================================
 * 职责：把各层的原始判断（分数 / 置信度 / 意图）收敛成三选一结局：
 * 派发、问用户、当前 agent 处理。守卫不调模型、不读文件。
 *
 * 设计立场：
 *  - **拿不准就问，不猜**：错派给用户的观感远差于多问一句；
 *  - 置信度必须是「按候选数归一化过」的口径，否则加一个 agent 就让所有请求
 *    突然变成不确定（这是把 p_max 直接当置信度的经典错误）；
 *  - 守卫只做否决，不做事后修补：没有任何一条守卫能把 low-confidence 抬成 dispatch。
 */
import type {
  Intent,
  RouteCandidateSummary,
  RouteDecision,
  RoutingLimits,
  RoutingThresholds,
} from "./types.js";

export interface GuardInput {
  candidates: readonly RouteCandidateSummary[];
  /** 归一化后的置信度 0..1；规则层用 ruleScore，模型层用模型自报值 */
  confidence: number;
  /** 置信度口径：模型自报的置信度与规则分不可用同一阈值直接比 */
  confidenceBasis: "rule" | "model" | "vector";
  margin: number;
  /** 拆出的意图；空数组表示「尚未拆分」，此时跳过 G4 */
  intents?: readonly Intent[];
  thresholds: RoutingThresholds;
  limits: RoutingLimits;
  /** 已转回次数，用于 R7 的 ≤1 约束 */
  handoffCount: number;
  /** 规则层给的依据文本；模型层传入自己的 reason */
  reason?: string;
}

function thresholdFor(basis: GuardInput["confidenceBasis"], thresholds: RoutingThresholds): number {
  if (basis === "model") return thresholds.modelConfidence;
  if (basis === "vector") return thresholds.vectorAccept;
  return thresholds.ruleAutoAccept;
}

/** G1：目标必须在候选白名单里，防止上游/模型幻觉出不存在的 agent。 */
export function guardWhitelist(agentId: string | undefined, candidates: readonly RouteCandidateSummary[]): boolean {
  if (!agentId) return false;
  return candidates.some((item) => item.agentId === agentId);
}

/** G2：置信度达标。 */
export function guardConfidence(input: GuardInput): boolean {
  return input.confidence >= thresholdFor(input.confidenceBasis, input.thresholds);
}

/** G3：领先幅度达标（只有模型层用 candidateMargin，规则层用 ruleMargin）。 */
export function guardMargin(input: GuardInput): boolean {
  const need = input.confidenceBasis === "model" ? input.thresholds.candidateMargin : input.thresholds.ruleMargin;
  // 只有一个候选时没有「分差」可言，直接放行——否则单 agent 场景永远无法派发。
  if (input.candidates.length <= 1) return true;
  return input.margin >= need;
}

/**
 * G4：多意图冲突。口径是「映射到两个以上不同 agent」，不是「两个以上子任务」。
 * 同一 agent 下的多个子任务（例如「找房 + 算月供」都归 estate）不算冲突。
 */
export function guardMultiIntent(input: GuardInput): boolean {
  const intents = input.intents ?? [];
  if (!intents.length) return true;
  // 超过分层阈值的批量请求走「分层 + 计划卡片」，不再按多意图冲突追问。
  if (intents.length > input.limits.hierarchicalAbove) return true;
  const agents = new Set(intents.map((intent) => intent.agentId).filter((id) => id && id !== "none"));
  return agents.size < 2;
}

/** 命中两个以上不同 agent 的意图数（给事件与提示文案用）。 */
export function distinctIntentAgents(input: GuardInput): string[] {
  const intents = input.intents ?? [];
  return [...new Set(intents.map((intent) => intent.agentId).filter((id) => id && id !== "none"))];
}

/**
 * 组装最终决策。调用方负责提供各层结果，本函数只做「最后一票」。
 * 顺序固定：先 G1 白名单，再 G2/G3 置信度与分差，最后 G4 多意图。
 */
export function decideRoute(input: GuardInput, layer: RouteDecision["layer"]): RouteDecision {
  const top = input.candidates[0];
  const base: RouteDecision = {
    kind: "main",
    layer,
    confidence: input.confidence,
    margin: input.margin,
    reason: input.reason ?? "",
    candidates: [...input.candidates],
    intents: [...(input.intents ?? [])],
    handoffCount: input.handoffCount,
  };

  if (!top) {
    return { ...base, kind: "main", reason: input.reason || "没有可用的候选子代理，由当前 Agent 处理。" };
  }

  // G1：白名单
  if (!guardWhitelist(top.agentId, input.candidates)) {
    return { ...base, kind: "ask", reason: "路由结果指向了不存在的子代理，请确认希望如何处理。" };
  }

  // G4 先判：多意图冲突时即使单项置信度很高也要问（用户可能想拆成多个请求）。
  if (!guardMultiIntent(input)) {
    const agents = distinctIntentAgents(input);
    return {
      ...base,
      kind: "ask",
      reason: `这个请求同时涉及 ${agents.length} 个不同的子代理（${agents.join("、")}），请确认先做哪一个。`,
    };
  }

  const confidenceOk = guardConfidence(input);
  const marginOk = guardMargin(input);
  if (!confidenceOk || !marginOk) {
    const why = !confidenceOk
      ? `不确定该交给哪个子代理（置信度 ${input.confidence.toFixed(2)} 低于阈值 ${thresholdFor(input.confidenceBasis, input.thresholds).toFixed(2)}）`
      : `有两个候选都很接近（分差 ${input.margin.toFixed(2)} 低于阈值 ${input.thresholds.candidateMargin.toFixed(2)}）`;
    return { ...base, kind: "ask", reason: `${why}，请确认。` };
  }

  return {
    ...base,
    kind: "dispatch",
    agentId: top.agentId,
    agentName: top.name,
    reason: input.reason || `由「${top.name}」处理（置信度 ${input.confidence.toFixed(2)}）。`,
  };
}

/** 全部弃权时的兜底决策：当前 agent 自己干，绝不报错。 */
export function fallbackDecision(
  reason: string,
  options: { handoffCount: number; candidates?: readonly RouteCandidateSummary[]; intents?: readonly Intent[] },
): RouteDecision {
  return {
    kind: "main",
    layer: "fallback",
    confidence: 0,
    margin: 0,
    reason,
    candidates: [...(options.candidates ?? [])],
    intents: [...(options.intents ?? [])],
    handoffCount: options.handoffCount,
  };
}
