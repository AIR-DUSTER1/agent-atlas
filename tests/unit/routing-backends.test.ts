/**
 * tests/unit/routing-backends.test.ts — 两个决策后端的协议与容错
 * ============================================================
 * 守：请求形状、宽松解析（围栏/前后缀）、坏输出一律弃权（返回 null 而非抛错）、
 * 概率归一、confidence 缺失时的上游公式复算。
 * 全部用假 fetch / 直接喂 JSON，不发真实请求。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDecisionJson,
  renderCandidateList,
  toRawDecision,
} from "../../src/routing/backends/openai.js";
import {
  buildCriteria,
  parseSystemoneResponse,
} from "../../src/routing/backends/systemone.js";
import { normalizeBackendId, decisionFromProbabilities } from "../../src/routing/backends/index.js";
import { DEFAULT_ROUTING_LIMITS, type RoutingCandidate } from "../../src/routing/types.js";

const LIMITS = DEFAULT_ROUTING_LIMITS;

const CANDIDATES: RoutingCandidate[] = [
  {
    agentId: "estate",
    name: "房产找房子代理",
    description: "处理房源检索与对比",
    routing: {
      keywords: ["租房"],
      category: "居住",
      suitableFor: ["按城市/预算/区域检索房源并给出对比结论", "评估小区、板块与通勤取舍"],
      notSuitableFor: ["天气查询", "写代码"],
      domainProfile: "estate",
    },
  },
  {
    agentId: "research",
    name: "研究员",
    description: "做资料调研",
    routing: {
      keywords: ["调研"],
      suitableFor: ["收集并比对多个来源的资料"],
      notSuitableFor: ["房源检索"],
    },
  },
];

/* --------------------------- openai-compat --------------------------- */

test("openai 后端：候选清单只放 suitableFor 前两条，负向词保留", () => {
  const text = renderCandidateList(CANDIDATES);
  assert.match(text, /estate（房产找房子代理）/);
  assert.match(text, /按城市\/预算\/区域检索房源/);
  assert.match(text, /不适用：天气查询、写代码/);
  // 第三条 suitableFor 不该出现（criteria 必须精简）
  assert.doesNotMatch(text, /只列两条/);
});

test("openai 后端：宽松解析接受 ```json 围栏与前后缀", () => {
  assert.deepEqual(parseDecisionJson('```json\n{"agentId":"estate","confidence":0.9}\n```'), {
    agentId: "estate", confidence: 0.9,
  });
  assert.deepEqual(parseDecisionJson('好的，结果是：{"agentId":"estate"} 以上。'), { agentId: "estate" });
  assert.equal(parseDecisionJson("完全不是 JSON"), null);
  assert.equal(parseDecisionJson(""), null);
});

test("openai 后端：合法输出被转成 RawDecision，intents 幻觉 id 归 none", () => {
  const raw = toRawDecision(
    {
      agentId: "estate",
      confidence: 0.82,
      reason: "用户在问房源区位",
      intents: [
        { text: "找北京朝阳两居室", agentId: "estate" },
        { text: "顺便查天气", agentId: "ghost-agent" },
      ],
    },
    CANDIDATES,
    LIMITS,
  );
  assert.ok(raw);
  assert.equal(raw!.agentId, "estate");
  assert.equal(raw!.confidence, 0.82);
  assert.equal(raw!.intents.length, 2);
  assert.equal(raw!.intents[1]?.agentId, "none");
});

test("openai 后端：坏输出一律弃权（返回 null，不猜）", () => {
  assert.equal(toRawDecision(null, CANDIDATES, LIMITS), null);
  assert.equal(toRawDecision({}, CANDIDATES, LIMITS), null);
  // 幻觉 agent id：说明模型没用我们给的清单 → 整体弃权，不交给 G1 擦屁股
  assert.equal(toRawDecision({ agentId: "ghost" }, CANDIDATES, LIMITS), null);
  // 合法地表示「没有合适的」
  const none = toRawDecision({ agentId: "none", confidence: 0.1 }, CANDIDATES, LIMITS);
  assert.ok(none);
  assert.equal(none!.agentId, "none");
});

test("openai 后端：confidence 越界被夹到 0..1", () => {
  const high = toRawDecision({ agentId: "estate", confidence: 9 }, CANDIDATES, LIMITS);
  assert.equal(high!.confidence, 1);
  const low = toRawDecision({ agentId: "estate", confidence: -3 }, CANDIDATES, LIMITS);
  assert.equal(low!.confidence, 0);
  const missing = toRawDecision({ agentId: "estate" }, CANDIDATES, LIMITS);
  assert.equal(missing!.confidence, 0);
});

/* ----------------------------- systemone ---------------------------- */

test("systemone：criteria 每条截断到 40 字，且只放 suitableFor[0]", () => {
  const criteria = buildCriteria(CANDIDATES);
  assert.deepEqual(Object.keys(criteria), ["estate", "research"]);
  assert.ok((criteria.estate?.length ?? 0) <= 40);
  assert.match(criteria.estate!, /检索房源/);
});

test("systemone：概率分布解析 + 分差计算", () => {
  const raw = parseSystemoneResponse(
    {
      answers: {
        route: {
          type: "choice",
          choice: "estate",
          probabilities: { estate: 0.91, research: 0.09 },
          confidence: 0.82,
        },
      },
    },
    CANDIDATES,
    LIMITS,
  );
  assert.ok(raw);
  assert.equal(raw!.agentId, "estate");
  assert.equal(raw!.confidence, 0.82);
  assert.ok(Math.abs(raw!.margin - 0.82) < 1e-9);
});

test("systemone：缺 confidence 时按 (k·p_max−1)/(k−1) 复算", () => {
  const raw = parseSystemoneResponse(
    { answers: { route: { probabilities: { estate: 0.8, research: 0.2 } } } },
    CANDIDATES,
    LIMITS,
  );
  assert.ok(raw);
  // k=2, p_max=0.8 → (1.6-1)/1 = 0.6
  assert.ok(Math.abs(raw!.confidence - 0.6) < 1e-9);
});

test("systemone：缺 probabilities 时退回 choice", () => {
  const raw = parseSystemoneResponse(
    { answers: { route: { choice: "research" } } },
    CANDIDATES,
    LIMITS,
  );
  assert.ok(raw);
  assert.equal(raw!.agentId, "research");
  assert.equal(raw!.probabilities.research, 1);
});

test("systemone：坏响应返回 null", () => {
  assert.equal(parseSystemoneResponse(null, CANDIDATES, LIMITS), null);
  assert.equal(parseSystemoneResponse({}, CANDIDATES, LIMITS), null);
  assert.equal(parseSystemoneResponse({ answers: {} }, CANDIDATES, LIMITS), null);
  assert.equal(parseSystemoneResponse({ answers: { route: {} } }, CANDIDATES, LIMITS), null);
});

/* ------------------------------ 公共部分 ---------------------------- */

test("后端名规范化：未知值回落到 openai-compat", () => {
  assert.equal(normalizeBackendId("systemone"), "systemone");
  assert.equal(normalizeBackendId("rules-only"), "rules-only");
  assert.equal(normalizeBackendId("bogus"), "openai-compat");
  assert.equal(normalizeBackendId(undefined), "openai-compat");
});

test("概率整理：只保留候选内的 id，按概率降序", () => {
  const raw = decisionFromProbabilities({
    probabilities: { estate: 0.3, research: 0.7, ghost: 0.9 },
    candidates: CANDIDATES,
    confidence: 0.5,
  });
  assert.equal(raw.agentId, "research");
  assert.equal(raw.probabilities.ghost, undefined);
  assert.ok(Math.abs(raw.margin - 0.4) < 1e-9);
});
