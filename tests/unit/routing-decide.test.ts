/**
 * tests/unit/routing-decide.test.ts — 层级编排与降级矩阵
 * ============================================================
 * 守计划 §3.4 的降级矩阵：每一行一个用例。
 * 全部用假后端 / 假向量实现，不发网络请求、不耗配额。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideRouteForText } from "../../src/routing/decide.js";
import type { DecisionBackend, RawDecision } from "../../src/routing/backends/index.js";
import type { VectorFinder } from "../../src/routing/vector.js";
import {
  DEFAULT_ROUTING_LIMITS,
  DEFAULT_ROUTING_THRESHOLDS,
  type RoutingCandidate,
  type RoutingSettings,
} from "../../src/routing/types.js";

const SETTINGS: RoutingSettings = {
  enabled: true,
  backend: "openai-compat",
  llm: { providerId: null, modelId: null, temperature: 0, structuredOutput: true, maxOutputTokens: 300 },
  systemone: { baseURL: "", expectedModel: "", apiKey: "" },
  thresholds: DEFAULT_ROUTING_THRESHOLDS,
  limits: DEFAULT_ROUTING_LIMITS,
  decideTimeoutMs: 6_000,
};

const CANDIDATES: RoutingCandidate[] = [
  {
    agentId: "estate",
    name: "房产",
    description: "房源检索",
    routing: {
      keywords: ["租房", "买房", "房源", "小区"],
      category: "居住",
      suitableFor: ["检索房源并对比"],
      notSuitableFor: ["天气查询"],
    },
  },
  {
    agentId: "research",
    name: "研究",
    description: "资料调研",
    routing: { keywords: ["调研", "文献"], category: "研究", suitableFor: [], notSuitableFor: [] },
  },
];

/** 记录调用次数的假后端 */
function fakeBackend(result: RawDecision | null, options: { throws?: boolean } = {}) {
  const calls: number[] = [];
  const backend: DecisionBackend = {
    id: "fake",
    unavailableReason: null,
    async decide() {
      calls.push(Date.now());
      if (options.throws) throw new Error("网关 500");
      return result;
    },
  };
  return { backend, calls };
}

function fakeVector(hits: Array<{ agentId: string; score: number }>) {
  const calls: number[] = [];
  const finder: VectorFinder = {
    async find() {
      calls.push(Date.now());
      return hits;
    },
  };
  return { finder, calls };
}

test("降级：规则唯一高置信 → 直接派发，且不调用向量与模型", async () => {
  const { backend, calls: modelCalls } = fakeBackend(null);
  const { finder, calls: vectorCalls } = fakeVector([{ agentId: "research", score: 0.99 }]);
  const decision = await decideRouteForText({
    text: "帮我租房，看看房源和小区",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: finder,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "dispatch");
  assert.equal(decision.layer, "rule");
  assert.equal(decision.agentId, "estate");
  // 关键：快速路径不产生任何外部调用
  assert.equal(modelCalls.length, 0);
  assert.equal(vectorCalls.length, 0);
});

test("降级：规则不确定 + 向量唯一高置信 → 规则层弃权后由向量派发", async () => {
  const { backend, calls: modelCalls } = fakeBackend(null);
  const { finder } = fakeVector([{ agentId: "research", score: 0.88 }]);
  const decision = await decideRouteForText({
    text: "帮我看看这个",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: finder,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "dispatch");
  assert.equal(decision.layer, "vector");
  assert.equal(decision.agentId, "research");
  assert.equal(modelCalls.length, 0);
});

test("降级：向量两个候选都够像 → 让位给模型层", async () => {
  const raw: RawDecision = {
    agentId: "estate",
    confidence: 0.9,
    margin: 1,
    reason: "模型判定 estate",
    intents: [],
    probabilities: { estate: 1, research: 0 },
  };
  const { backend, calls } = fakeBackend(raw);
  const { finder } = fakeVector([
    { agentId: "estate", score: 0.8 },
    { agentId: "research", score: 0.75 },
  ]);
  const decision = await decideRouteForText({
    text: "帮我看看这个",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: finder,
    handoffCount: 0,
  });
  assert.equal(decision.layer, "model");
  assert.equal(calls.length, 1);
});

test("降级：RAG 未配置（vector=null）→ 零向量调用，直接进模型层", async () => {
  const raw: RawDecision = {
    agentId: "estate",
    confidence: 0.9,
    margin: 1,
    reason: "模型判定",
    intents: [],
    probabilities: { estate: 1 },
  };
  const { backend, calls } = fakeBackend(raw);
  const decision = await decideRouteForText({
    text: "帮我看看这个",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: null,
    handoffCount: 0,
  });
  assert.equal(decision.layer, "model");
  assert.equal(calls.length, 1);
});

test("降级：后端抛错 → 兜底到当前 agent，不把异常抛给对话", async () => {
  const { backend } = fakeBackend(null, { throws: true });
  const decision = await decideRouteForText({
    text: "帮我看看这个",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: null,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "main");
  assert.equal(decision.layer, "fallback");
});

test("降级：后端返回 null（坏输出弃权）→ 兜底", async () => {
  const { backend } = fakeBackend(null);
  const decision = await decideRouteForText({
    text: "帮我看看这个",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: null,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "main");
  assert.equal(decision.layer, "fallback");
});

test("降级：模型低置信度 → 走守卫变成 ask，而不是勉强派发", async () => {
  const raw: RawDecision = {
    agentId: "estate",
    confidence: 0.4,
    margin: 1,
    reason: "有点像房产",
    intents: [],
    probabilities: { estate: 1 },
  };
  const { backend } = fakeBackend(raw);
  const decision = await decideRouteForText({
    text: "帮我看看这个",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: null,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /低于阈值/);
});

test("降级：模型说 none → 直接当前 agent 处理，不问用户", async () => {
  const raw: RawDecision = {
    agentId: "none",
    confidence: 0,
    margin: 0,
    reason: "没有合适的",
    intents: [],
    probabilities: {},
  };
  const { backend } = fakeBackend(raw);
  const decision = await decideRouteForText({
    text: "今天天气如何",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend,
    vector: null,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "main");
  assert.equal(decision.layer, "fallback");
});

test("降级：没有候选 → 直接兜底，不调用任何层", async () => {
  const { backend, calls } = fakeBackend(null);
  const decision = await decideRouteForText({
    text: "随便聊聊",
    candidates: [],
    settings: SETTINGS,
    backend,
    vector: null,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "main");
  assert.equal(calls.length, 0);
});

test("转回：handoffCount 透传到决策里（供 UI 与上限判断）", async () => {
  const decision = await decideRouteForText({
    text: "帮我租房",
    candidates: CANDIDATES,
    settings: SETTINGS,
    backend: null,
    vector: null,
    handoffCount: 1,
  });
  assert.equal(decision.handoffCount, 1);
});

test("rules-only：backend=null 时规则命中仍能派发", async () => {
  const decision = await decideRouteForText({
    text: "帮我买房，想看看小区",
    candidates: CANDIDATES,
    settings: { ...SETTINGS, backend: "rules-only" },
    backend: null,
    vector: null,
    handoffCount: 0,
  });
  assert.equal(decision.kind, "dispatch");
  assert.equal(decision.layer, "rule");
});
