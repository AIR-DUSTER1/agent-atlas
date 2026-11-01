/**
 * ============================================================
 * routing/types.ts — 路由决策层的共享类型
 * ============================================================
 * 职责：把「候选 agent 名片」「分层决策结果」「阈值与上限」定义成纯类型，
 * 供规则层 / 向量层 / 模型层 / 守卫层共用，避免各层各自声明一套形状。
 *
 * 设计立场：
 *  - 决策只有三种结局（dispatch / ask / main），任何一层都能「弃权」，
 *    弃权不是错误而是降级；
 *  - 分层信息（layer）必须随结果一起返回：用户看到的「为什么派给这个 agent」
 *    必须能追溯到某一层，否则无法排障；
 *  - 阈值与上限只在这里出现一次，不允许各后端各写一遍常量。
 */
import type { AgentProfileId } from "../agent/profile.js";

/** 子代理的路由名片：规则层与模型层共用同一份事实。 */
export interface SubagentRouting {
  /** 强信号关键词（小写比较）：命中即计正分 */
  keywords: readonly string[];
  /** 领域类别，供「超过 N 个意图」时的分层归并使用 */
  category?: string;
  /** 适用场景（自然语言）：模型层的 criteria 从这里取前 1–2 条摘要 */
  suitableFor: readonly string[];
  /** 不适用场景：负向信号，用来压低误派 */
  notSuitableFor: readonly string[];
  /**
   * 交给子代理时是否继承某个领域 profile 的系统提示与领域规则。
   * 不填 = 使用通用的「后台子代理」提示词。
   */
  domainProfile?: AgentProfileId;
}

export const EMPTY_SUBAGENT_ROUTING: SubagentRouting = Object.freeze({
  keywords: Object.freeze([]) as readonly string[],
  suitableFor: Object.freeze([]) as readonly string[],
  notSuitableFor: Object.freeze([]) as readonly string[],
});

/** 一个可参与路由竞争的候选（只含启用中的子代理）。 */
export interface RoutingCandidate {
  agentId: string;
  name: string;
  description: string;
  routing: SubagentRouting;
}

/** 规则层对单个候选的打分结果。 */
export interface RuleScore {
  agentId: string;
  name: string;
  /** 归一化到 0..1 的规则分 */
  score: number;
  /** 归一化前的原始分（命中长度 + 命中数加权 − 负向惩罚） */
  raw: number;
  hits: string[];
  negatives: string[];
  category?: string;
}

/** 向量层的一次命中。 */
export interface VectorHit {
  agentId: string;
  score: number;
}

/** 意图：模型层拆出来的「一件需要独立处理的事」。 */
export interface Intent {
  text: string;
  /** 期望承接该意图的 agent id；"none" 表示没有合适的子代理 */
  agentId: string;
}

/** 决策来自哪一层；fallback = 各层弃权后的兜底。 */
export type RouteLayer = "rule" | "vector" | "model" | "fallback";

/** 决策结局：派发 / 询问用户 / 当前 agent 处理。 */
export type RouteKind = "dispatch" | "ask" | "main";

/** 候选摘要：写进事件与日志的可读形态（不含全文，避免日志膨胀）。 */
export interface RouteCandidateSummary {
  agentId: string;
  name: string;
  score: number;
}

export interface RouteDecision {
  kind: RouteKind;
  layer: RouteLayer;
  /** kind = dispatch 时必有 */
  agentId?: string;
  agentName?: string;
  /** 0..1；规则层用归一化分数，模型层用模型自报置信度 */
  confidence: number;
  /** top1 − top2；只有一个候选时为 1 */
  margin: number;
  /** 面向用户的一句中文依据 */
  reason: string;
  candidates: RouteCandidateSummary[];
  /** 拆出的意图（模型层才有；规则层为单意图假设） */
  intents: Intent[];
  /** 本轮已发生的转回次数 */
  handoffCount: number;
}

export interface RoutingThresholds {
  /** 规则层直接派发所需的最低归一化分 */
  ruleAutoAccept: number;
  /** 规则层直接派发所需的 top1 − top2 分差 */
  ruleMargin: number;
  /** 向量层直接派发的相似度门槛 */
  vectorAccept: number;
  /** 模型层置信度门槛 */
  modelConfidence: number;
  /** 模型层候选分差门槛 */
  candidateMargin: number;
}

export interface RoutingLimits {
  /** 超过该意图数走分层分类 */
  hierarchicalAbove: number;
  /** 意图解析上限，超出截断并显式告知 */
  maxIntents: number;
  /** 分层时最多归并出的类别数 */
  maxCategories: number;
  /** 一次请求最多转回次数（R7 硬约束） */
  maxHandoffs: number;
  /** 分层计划单次最多实际派发的子任务数 */
  maxPlanDispatches: number;
  /** 单条意图文本上限 */
  maxIntentTextChars: number;
}

/** 决策后端：三选一；缺省用 openai-compat。 */
export type RoutingBackendId = "openai-compat" | "systemone" | "rules-only";

/**
 * 模型层配置。providerId / modelId 为 null 时沿用「当前启用的供应商 × 模型」，
 * 这样默认配置零填写即可工作。
 */
export interface RoutingModelSettings {
  providerId: string | null;
  modelId: string | null;
  temperature: number;
  /** 网关支持 response_format 时置 true；不支持时后端自动降级为纯提示词约束 */
  structuredOutput: boolean;
  maxOutputTokens: number;
}

/** systemone 协议后端（Jev-Style / OpenJev / decider 等）的远端地址。 */
export interface RoutingSystemoneSettings {
  baseURL: string;
  expectedModel: string;
  apiKey: string;
}

export interface RoutingSettings {
  /** 默认关闭：行为与未引入路由时完全一致 */
  enabled: boolean;
  backend: RoutingBackendId;
  llm: RoutingModelSettings;
  systemone: RoutingSystemoneSettings;
  thresholds: RoutingThresholds;
  limits: RoutingLimits;
  /** 模型层单次调用超时（毫秒） */
  decideTimeoutMs: number;
}

export const DEFAULT_ROUTING_THRESHOLDS: Readonly<RoutingThresholds> = Object.freeze({
  ruleAutoAccept: 0.85,
  ruleMargin: 0.3,
  vectorAccept: 0.62,
  modelConfidence: 0.7,
  candidateMargin: 0.15,
});

export const DEFAULT_ROUTING_LIMITS: Readonly<RoutingLimits> = Object.freeze({
  hierarchicalAbove: 20,
  maxIntents: 50,
  maxCategories: 6,
  maxHandoffs: 1,
  maxPlanDispatches: 8,
  maxIntentTextChars: 4_000,
});
