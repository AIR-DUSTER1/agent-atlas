/**
 * ============================================================
 * routing/decide.ts — L3 编排：规则 → 向量 → 模型 → 守卫
 * ============================================================
 * 职责：把各层串成一次决策，任一层弃权就继续降级，最终一定给出一个
 * RouteDecision（最差是「当前 agent 处理」）。
 *
 * 设计立场：
 *  - **快速路径不碰网络**：规则层有把握时直接返回，向量与模型层零调用；
 *  - **任何异常都降级不抛出**：路由失败不是对话失败，用户最多多回答一句；
 *  - 模型层用超时 + 单次尝试（路由要快，失败就按规则走）。
 */
import { scoreRoutingCandidates, fastPathVerdict } from "./rules.js";
import { decideRoute, fallbackDecision } from "./guards.js";
import { mergeCategoryScores } from "./rules.js";
import { buildHierarchicalPlan, splitIntents, type HierarchicalPlan } from "./intents.js";
import type {
  RouteCandidateSummary,
  RouteDecision,
  RoutingCandidate,
  RoutingLimits,
  RoutingSettings,
} from "./types.js";
import type { DecisionBackend } from "./backends/index.js";
import type { VectorFinder } from "./vector.js";

export interface DecideInput {
  /** 用户本轮文本（不裁剪历史，路由只看这一条） */
  text: string;
  candidates: readonly RoutingCandidate[];
  settings: RoutingSettings;
  /** 模型层后端；rules-only 或不可用时传 null */
  backend?: DecisionBackend | null;
  /** 向量层；未配置 RAG 时传 null（此时整层跳过，零网络调用） */
  vector?: VectorFinder | null;
  /** 已转回次数 */
  handoffCount: number;
  signal?: AbortSignal;
}

function summaries(candidates: readonly RoutingCandidate[], scores: Map<string, number>): RouteCandidateSummary[] {
  return candidates
    .map((candidate) => ({
      agentId: candidate.agentId,
      name: candidate.name,
      score: scores.get(candidate.agentId) ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/** 规则层：唯一真正「零成本」的一层，任何配置下都先跑。 */
function ruleLayer(input: DecideInput): {
  decision: RouteDecision | null;
  scores: ReturnType<typeof scoreRoutingCandidates>;
} {
  const scores = scoreRoutingCandidates(
    input.candidates.map((candidate) => ({
      agentId: candidate.agentId,
      name: candidate.name,
      keywords: candidate.routing.keywords,
      notSuitableFor: candidate.routing.notSuitableFor,
      ...(candidate.routing.category ? { category: candidate.routing.category } : {}),
    })),
    input.text,
  );
  if (!scores.length) return { decision: null, scores };
  const verdict = fastPathVerdict(scores, input.settings.thresholds);
  if (!verdict.accept || !verdict.top) return { decision: null, scores };
  const scoreMap = new Map(scores.map((item) => [item.agentId, item.score]));
  return {
    decision: {
      kind: "dispatch",
      layer: "rule",
      agentId: verdict.top.agentId,
      agentName: verdict.top.name,
      confidence: verdict.top.score,
      margin: verdict.margin,
      reason: `规则命中「${verdict.top.hits.join("、")}」，交给「${verdict.top.name}」。`,
      candidates: summaries(input.candidates, scoreMap),
      intents: [{ text: input.text.trim(), agentId: verdict.top.agentId }],
      handoffCount: input.handoffCount,
    },
    scores,
  };
}

/** 向量层：只在 RAG 已配置时存在；返回相似度排序的候选。 */
async function vectorLayer(input: DecideInput): Promise<RouteDecision | null> {
  if (!input.vector) return null;
  const hits = await input.vector
    .find(input.text, input.candidates.map((candidate) => candidate.agentId))
    .catch(() => []);
  const top = hits[0];
  if (!top || top.score < input.settings.thresholds.vectorAccept) return null;
  const candidate = input.candidates.find((item) => item.agentId === top.agentId);
  if (!candidate) return null;
  const second = hits[1];
  const margin = top.score - (second?.score ?? 0);
  // 向量层只有一个「够像」的命中才算数；两个都像时交给模型层判断。
  if (second && second.score >= input.settings.thresholds.vectorAccept) return null;
  const scoreMap = new Map(hits.map((hit) => [hit.agentId, hit.score]));
  return {
    kind: "dispatch",
    layer: "vector",
    agentId: top.agentId,
    agentName: candidate.name,
    confidence: top.score,
    margin,
    reason: `向量相似度最高的是「${candidate.name}」（${top.score.toFixed(2)}）。`,
    candidates: summaries(input.candidates, scoreMap),
    intents: [{ text: input.text.trim(), agentId: top.agentId }],
    handoffCount: input.handoffCount,
  };
}

/** 模型层：一次调用，走守卫；任何失败都返回 null。 */
async function modelLayer(input: DecideInput): Promise<RouteDecision | null> {
  const backend = input.backend;
  if (!backend || backend.unavailableReason) return null;
  const timeout = AbortSignal.timeout(input.settings.decideTimeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const raw = await backend
    .decide({
      text: input.text,
      candidates: input.candidates,
      limits: input.settings.limits,
      signal,
    })
    .catch(() => null);
  if (!raw) return null;
  // 模型说「没有合适的 agent」：直接兜底，不要再用低置信度去问用户。
  if (!raw.agentId || raw.agentId === "none") {
    return fallbackDecision("模型判断没有特别合适的子代理，由当前 Agent 处理。", {
      handoffCount: input.handoffCount,
      candidates: input.candidates.map((candidate) => ({ agentId: candidate.agentId, name: candidate.name, score: raw.probabilities[candidate.agentId] ?? 0 })),
      intents: raw.intents,
    });
  }
  const scoreMap = new Map(Object.entries(raw.probabilities));
  return decideRoute({
    candidates: summaries(input.candidates, scoreMap),
    confidence: raw.confidence,
    confidenceBasis: "model",
    margin: raw.margin,
    intents: raw.intents,
    thresholds: input.settings.thresholds,
    limits: input.settings.limits,
    handoffCount: input.handoffCount,
    reason: raw.reason,
  }, "model");
}

/**
 * 主入口。层级顺序固定：规则 → 向量 → 模型；
 * 每层成功即返回，全部弃权则落到「当前 agent 处理」。
 */
export async function decideRouteForText(input: DecideInput): Promise<RouteDecision> {
  if (!input.candidates.length) {
    return fallbackDecision("当前没有可参与路由的子代理，由当前 Agent 处理。", {
      handoffCount: input.handoffCount,
    });
  }

  const rule = ruleLayer(input);
  if (rule.decision) return rule.decision;

  const vector = await vectorLayer(input);
  if (vector) return vector;

  const model = await modelLayer(input);
  if (model) return model;

  // 全部弃权：给出可解释的兜底，而不是静默。
  const topRule = rule.scores[0];
  return fallbackDecision(
    topRule && topRule.score > 0
      ? `规则只给出弱信号（最高「${topRule.name}」${topRule.score.toFixed(2)}），不够确定，由当前 Agent 处理。`
      : "没有识别出明确的子代理需求，由当前 Agent 处理。",
    {
      handoffCount: input.handoffCount,
      candidates: summaries(input.candidates, new Map(rule.scores.map((item) => [item.agentId, item.score]))),
    },
  );
}

/**
 * 分层计划：意图数超过阈值时（R8）把「一刀切派发」换成「先归大类再列子任务」。
 *
 * 触发时机与主决策分开，因为两者的产出物不同：
 *  - 主决策给的是「派给谁」，用于单个 agent 上下文；
 *  - 分层给的是「一张计划卡」，必须让用户确认后才执行（否则一次请求可能触发
 *    几十次模型调用，是真实的配额风险）。
 */
export function buildPlanForText(input: {
  text: string;
  candidates: readonly RoutingCandidate[];
  settings: RoutingSettings;
  intents?: readonly { text: string; agentId: string }[];
}): HierarchicalPlan {
  // 优先用模型拆出的意图；没有就退回确定性切分（零成本，能覆盖「；」「然后」这类显式分段）。
  const split = splitIntents(input.text, input.settings.limits.maxIntentTextChars);
  const source = input.intents?.length
    ? input.intents.map((intent) => ({ text: intent.text, agentId: intent.agentId }))
    : split.intents.map((intent) => ({ text: intent.text, agentId: guessAgentId(intent.text, input.candidates) }));
  const categoryOf = (agentId: string): string => {
    const candidate = input.candidates.find((item) => item.agentId === agentId);
    return candidate?.routing.category?.trim() ?? "";
  };
  return buildHierarchicalPlan(source, {
    maxCategories: input.settings.limits.maxCategories,
    maxIntents: input.settings.limits.maxIntents,
    categoryOf,
  });
}

/** 兜底：用规则给单条意图找最可能的 agent；找不到归 "none"。 */
function guessAgentId(text: string, candidates: readonly RoutingCandidate[]): string {
  const scores = scoreRoutingCandidates(
    candidates.map((candidate) => ({
      agentId: candidate.agentId,
      name: candidate.name,
      keywords: candidate.routing.keywords,
      notSuitableFor: candidate.routing.notSuitableFor,
    })),
    text,
  );
  return scores[0] && scores[0].score > 0 ? scores[0].agentId : "none";
}

/** 供设置页/测试使用的类别归并视图。 */
export { mergeCategoryScores };
