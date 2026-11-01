/**
 * tests/unit/routing-rules.test.ts — L1 规则匹配与快速路径
 * ============================================================
 * 守四件事：命中计分、负向词压制、归一化下限（不因唯一候选而虚高）、
 * 快速路径边界（差一点就不能走）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fastPathVerdict,
  mergeCategoryScores,
  scoreRoutingCandidates,
} from "../../src/routing/rules.js";

const ESTATE = {
  agentId: "estate",
  name: "房产",
  keywords: ["租房", "买房", "房源", "小区"],
  notSuitableFor: ["天气", "写代码"],
  category: "居住",
};

const RESEARCH = {
  agentId: "research",
  name: "研究",
  keywords: ["调研", "文献"],
  notSuitableFor: ["房源"],
  category: "研究",
};

test("规则：多关键词命中累加，且按分数降序", () => {
  const scores = scoreRoutingCandidates([RESEARCH, ESTATE], "帮我租房，看看房源和小区");
  assert.equal(scores[0]?.agentId, "estate");
  assert.ok((scores[0]?.score ?? 0) > 0);
  assert.deepEqual(scores[0]?.hits.sort(), ["小区", "房源", "租房"].sort());
});

test("规则：负向词扣分足以推翻正向命中", () => {
  // 「房源」命中 estate 关键词，但「天气」命中 notSuitableFor，权重更高
  const scores = scoreRoutingCandidates([ESTATE], "帮我查天气，顺便问问房源");
  const estate = scores[0]!;
  assert.ok(estate.negatives.includes("天气"));
  assert.ok(estate.score < 0.85, `负向命中后不应达到自动派发阈值，实际 ${estate.score}`);
});

test("规则：没有关键词命中时全 0（规则层弃权）", () => {
  const scores = scoreRoutingCandidates([ESTATE, RESEARCH], "今天心情不错");
  assert.deepEqual(scores.map((item) => item.score), [0, 0]);
  assert.equal(fastPathVerdict(scores, { ruleAutoAccept: 0.85, ruleMargin: 0.3 }).accept, false);
});

test("规则：单一候选不会被归一化成 1.0 而误触发快速路径", () => {
  // 只命中 2 字关键词：raw = 2 + 5 = 7 → 1−e^(−7/5) ≈ 0.753，低于 0.85 阈值
  const scores = scoreRoutingCandidates([
    { agentId: "solo", name: "单例", keywords: ["调研"], notSuitableFor: [] },
  ], "做个调研");
  const score = scores[0]?.score ?? 0;
  assert.ok(score > 0.7 && score < 0.85, `单关键词应落在「交模型层」区间，实际 ${score}`);
  assert.equal(fastPathVerdict(scores, { ruleAutoAccept: 0.85, ruleMargin: 0.3 }).accept, false);
});

test("规则：两个领域词同时命中才够快速路径（中文标定）", () => {
  const oneWord = scoreRoutingCandidates([ESTATE], "帮我租房");
  assert.ok((oneWord[0]?.score ?? 0) < 0.85, "单个关键词不该直接派发");
  const twoWords = scoreRoutingCandidates([ESTATE], "帮我租房，看看小区房源");
  assert.ok((twoWords[0]?.score ?? 0) >= 0.85, "多个领域词命中应可直接派发");
});

test("规则：空文本不崩且分数为 0", () => {
  const scores = scoreRoutingCandidates([ESTATE], "");
  assert.equal(scores.length, 1);
  assert.equal(scores[0]?.score, 0);
  assert.deepEqual(scores[0]?.hits, []);
});

test("快速路径：分数与分差任一不达标都不放行", () => {
  const strong = { agentId: "a", name: "A", score: 0.9, raw: 36, hits: [], negatives: [] };
  const weak = { agentId: "b", name: "B", score: 0.5, raw: 20, hits: [], negatives: [] };
  assert.equal(fastPathVerdict([strong, weak], { ruleAutoAccept: 0.85, ruleMargin: 0.3 }).accept, true);
  // 分数不够
  assert.equal(fastPathVerdict([{ ...strong, score: 0.84 }, weak], { ruleAutoAccept: 0.85, ruleMargin: 0.3 }).accept, false);
  // 分差不够（两个都高）
  assert.equal(fastPathVerdict([strong, { ...weak, score: 0.7 }], { ruleAutoAccept: 0.85, ruleMargin: 0.3 }).accept, false);
});

test("类别归并：同类分数相加，零分不入组", () => {
  const scores = scoreRoutingCandidates(
    [ESTATE, { agentId: "rent", name: "租房", keywords: ["租房"], notSuitableFor: [], category: "居住" }, RESEARCH],
    "租房",
  );
  const merged = mergeCategoryScores(scores);
  const living = merged.find((item) => item.category === "居住");
  assert.ok(living);
  assert.deepEqual(living!.agentIds.sort(), ["estate", "rent"]);
  assert.equal(merged.some((item) => item.category === "研究"), false);
});
