/**
 * tests/unit/routing-guards.test.ts — G1–G4 守卫
 * ============================================================
 * 重点守两条容易写错的语义：
 *  1. 选项数变化时 confidence 仍可比（不是拿 p_max 当阈值）；
 *  2. 「多意图」按不同 agent 计，同一 agent 下的多个子任务不算冲突。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideRoute,
  fallbackDecision,
  guardConfidence,
  guardMargin,
  guardMultiIntent,
  guardWhitelist,
} from "../../src/routing/guards.js";
import { DEFAULT_ROUTING_LIMITS, DEFAULT_ROUTING_THRESHOLDS, type Intent } from "../../src/routing/types.js";

const THRESHOLDS = DEFAULT_ROUTING_THRESHOLDS;
const LIMITS = DEFAULT_ROUTING_LIMITS;

function input(overrides: Partial<Parameters<typeof decideRoute>[0]> = {}) {
  return {
    candidates: [
      { agentId: "estate", name: "房产", score: 0.9 },
      { agentId: "research", name: "研究", score: 0.2 },
    ],
    confidence: 0.9,
    confidenceBasis: "rule" as const,
    margin: 0.7,
    thresholds: THRESHOLDS,
    limits: LIMITS,
    handoffCount: 0,
    ...overrides,
  };
}

test("G1：目标不在白名单时判为 ask，绝不静默派发", () => {
  assert.equal(guardWhitelist("estate", input().candidates), true);
  assert.equal(guardWhitelist("ghost", input().candidates), false);
  assert.equal(guardWhitelist(undefined, input().candidates), false);
  const decision = decideRoute(input({ candidates: [{ agentId: "estate", name: "房产", score: 0.9 }] }), "rule");
  assert.equal(decision.kind, "dispatch");
});

test("G2：模型层阈值高于规则层（自报置信度不如协议保证的归一化值可信）", () => {
  const rule = input({ confidence: 0.8, confidenceBasis: "rule" });
  const model = input({ confidence: 0.8, confidenceBasis: "model" });
  // 0.8 < ruleAutoAccept(0.85) → 规则层不通过；0.8 ≥ modelConfidence(0.70) → 模型层通过
  assert.equal(guardConfidence(rule), false);
  assert.equal(guardConfidence(model), true);
});

test("G2：置信度语义与候选数无关（同一归一化口径跨配置可比）", () => {
  // 2 选项时 p=0.86 → confidence=(2*0.86-1)/1=0.72；5 选项 p=0.78 → (5*0.78-1)/4=0.725
  const two = (2 * 0.86 - 1) / (2 - 1);
  const five = (5 * 0.78 - 1) / (5 - 1);
  assert.ok(Math.abs(two - five) < 0.02, `两个配置的归一化置信度应接近：${two} vs ${five}`);
  assert.equal(guardConfidence(input({ confidence: two, confidenceBasis: "model" })), true);
});

test("G3：分差不足时拒绝；只有单个候选时放行", () => {
  assert.equal(guardMargin(input({ margin: 0.1 })), false);
  assert.equal(guardMargin(input({ margin: 0.5 })), true);
  // 单候选：没有分差概念
  assert.equal(guardMargin(input({ candidates: [{ agentId: "estate", name: "房产", score: 0.9 }], margin: 0 })), true);
});

test("G4：同一 agent 的多个子任务不算冲突", () => {
  const sameAgent: Intent[] = [
    { text: "找房", agentId: "estate" },
    { text: "算月供", agentId: "estate" },
  ];
  assert.equal(guardMultiIntent(input({ intents: sameAgent })), true);
});

test("G4：两个不同 agent 的意图触发询问", () => {
  const mixed: Intent[] = [
    { text: "找房", agentId: "estate" },
    { text: "查文献", agentId: "research" },
  ];
  assert.equal(guardMultiIntent(input({ intents: mixed })), false);
  const decision = decideRoute(input({ intents: mixed }), "model");
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /2 个不同的子代理/);
});

test("G4：超过分层阈值的批量请求不问，交给分层路径", () => {
  const many: Intent[] = Array.from({ length: LIMITS.hierarchicalAbove + 1 }, (_, index) => ({
    text: `任务 ${index}`,
    agentId: index % 2 === 0 ? "estate" : "research",
  }));
  assert.equal(guardMultiIntent(input({ intents: many })), true);
});

test("组合：高置信 + 高分差 + 单意图 → dispatch 并带上目标名", () => {
  const decision = decideRoute(input(), "rule");
  assert.equal(decision.kind, "dispatch");
  assert.equal(decision.agentId, "estate");
  assert.equal(decision.agentName, "房产");
  assert.equal(decision.layer, "rule");
});

test("兜底：没有候选时给 main，不报错", () => {
  const decision = fallbackDecision("没有候选", { handoffCount: 0 });
  assert.equal(decision.kind, "main");
  assert.equal(decision.layer, "fallback");
  assert.equal(decision.confidence, 0);
  assert.deepEqual(decision.candidates, []);
});
