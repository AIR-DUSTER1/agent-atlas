/**
 * ============================================================
 * routing/backends/systemone.ts — 可选后端：systemone 概率协议
 * ============================================================
 * 职责：向实现了 `POST /v1/systemone` 的服务（Jev-Style / OpenJev / decider 等）
 * 发一次决策请求，把概率分布翻译成 RawDecision。
 *
 * 设计立场：
 *  - **协议保证结构**：上游返回的是 `{choice, probabilities, confidence}`，
 *    不需要解析模型自由生成的 JSON —— 这是本后端相对 openai-compat 的唯一优势，
 *    也是它值得保留的理由；
 *  - 只发 `state` + `questions`，**不把对话历史、附件、工具结果带出去**；
 *  - criteria 必须精简（上游问题+选项上限 2,048 tokens），这里按每条 40 字截断；
 *  - 服务不可达 / 超时 / 坏响应 → 返回 null 弃权，绝不抛错。
 *
 * 分层约束：本文件属于路由层，**不 import server/***。熔断器由上层（服务端）
 * 注入一个最小接口，单元测试与 CLI 场景下默认直连（无熔断）。
 */
import type { RoutingCandidate, RoutingLimits, RoutingSettings } from "../types.js";
import { decisionFromProbabilities, type DecisionBackend, type RawDecision } from "./index.js";

/** 每条 criteria 的目标长度；上游 2,048 token 限制要求「一句话讲清」。 */
const MAX_CRITERION_CHARS = 40;
/** criteria 总字符的安全上限（按 1 token ≈ 1.6 中文字符倒推的保守估计）。 */
const MAX_CRITERIA_TOTAL_CHARS = 3_000;
const MAX_CANDIDATES = 32;

/** 熔断器最小契约：只需「执行或在打开时快速失败」这一种能力。 */
export interface RoutingBreaker {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const passthroughBreaker: RoutingBreaker = { run: (fn) => fn() };

export interface SystemoneCriteria {
  [agentId: string]: string;
}

/** 把候选渲染成 criteria：agentId → 一句适用场景。 */
export function buildCriteria(candidates: readonly RoutingCandidate[]): SystemoneCriteria {
  const criteria: SystemoneCriteria = {};
  let used = 0;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const source = candidate.routing.suitableFor[0] ?? candidate.description ?? candidate.name;
    const oneLine = source.replace(/\s+/g, " ").trim().slice(0, MAX_CRITERION_CHARS);
    const text = oneLine || candidate.name;
    if (used + text.length > MAX_CRITERIA_TOTAL_CHARS) break;
    criteria[candidate.agentId] = text;
    used += text.length;
  }
  return criteria;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 解析上游响应。
 * `confidence` 缺失时按 `(k·p_max − 1)/(k − 1)` 自己算 —— 这是上游文档给出的
 * 归一化公式，保证选项数不同时阈值仍然可比。
 */
export function parseSystemoneResponse(
  body: unknown,
  candidates: readonly RoutingCandidate[],
  limits: RoutingLimits,
): RawDecision | null {
  const root = asRecord(body);
  const answers = asRecord(root?.answers ? asRecord(root.answers) : root);
  if (!answers) return null;
  const route = asRecord(answers.route) ?? asRecord(root?.route);
  if (!route) return null;

  const rawProbabilities = asRecord(route.probabilities);
  const probabilities: Record<string, number> = {};
  for (const candidate of candidates) {
    const value = Number(rawProbabilities?.[candidate.agentId]);
    if (Number.isFinite(value) && value >= 0) probabilities[candidate.agentId] = value;
  }
  // 概率全缺时退回 choice（协议保证 choice 一定在，但 probabilities 可能被裁剪）
  const choice = typeof route.choice === "string" ? route.choice.trim() : "";
  if (!Object.keys(probabilities).length) {
    if (!choice) return null;
    for (const candidate of candidates) probabilities[candidate.agentId] = candidate.agentId === choice ? 1 : 0;
  }

  const values = Object.values(probabilities);
  const k = values.length;
  const pMax = Math.max(...values, 0);
  const explicit = Number(route.confidence);
  const confidence = Number.isFinite(explicit)
    ? Math.min(1, Math.max(0, explicit))
    : k > 1 ? Math.min(1, Math.max(0, (k * pMax - 1) / (k - 1))) : pMax;

  return decisionFromProbabilities({
    probabilities,
    candidates,
    confidence,
    reason: typeof route.reason === "string"
      ? route.reason.trim().slice(0, 200)
      : `决策服务判定 ${choice || "未知"}（p=${pMax.toFixed(2)}）`,
  });
}

export function createSystemoneBackend(
  settings: RoutingSettings,
  options: { breaker?: RoutingBreaker } = {},
): DecisionBackend {
  const breaker = options.breaker ?? passthroughBreaker;
  const base = settings.systemone.baseURL.trim().replace(/\/+$/, "");
  return {
    id: "systemone",
    unavailableReason: base ? null : "未填写决策服务地址（设置 → 路由）",
    async decide(input) {
      if (!base || !input.candidates.length) return null;
      const criteria = buildCriteria(input.candidates);
      if (!Object.keys(criteria).length) return null;
      const body = JSON.stringify({
        state: input.text.slice(0, 8_000),
        questions: {
          route: {
            type: "choice",
            instructions: "哪个 Agent 最适合处理这件事？",
            criteria,
          },
        },
      });
      return breaker.run(async () => {
        const response = await fetch(`${base}/v1/systemone`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(settings.systemone.apiKey ? { Authorization: `Bearer ${settings.systemone.apiKey}` } : {}),
          },
          body,
          signal: input.signal ?? AbortSignal.timeout(settings.decideTimeoutMs),
        });
        if (!response.ok) throw new Error(`决策服务返回 ${response.status}`);
        return parseSystemoneResponse(await response.json(), input.candidates, input.limits);
      }).catch(() => null);
    },
  };
}
