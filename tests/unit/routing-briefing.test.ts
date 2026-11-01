/**
 * tests/unit/routing-briefing.test.ts — 任务书模板与转回标记
 * ============================================================
 * 守：六小节齐全、负向词自动进「不要做」、超出范围只认末尾小节。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIEFING_SECTIONS,
  briefingSectionMissing,
  parseOutOfScope,
  renderBriefing,
} from "../../src/routing/briefing.js";

test("任务书：六小节齐全", () => {
  const text = renderBriefing({
    background: "用户想找北京朝阳的两居室，预算 6000",
    goal: "给出 3-5 个候选房源并说明取舍",
    tools: ["house_search", "calculator"],
  });
  assert.deepEqual(briefingSectionMissing(text), []);
  for (const section of BRIEFING_SECTIONS) assert.ok(text.includes(section), `缺少 ${section}`);
});

test("任务书：已知事实缺省时写明「无」而不是留空", () => {
  const text = renderBriefing({ background: "背景", goal: "目标", tools: [] });
  assert.match(text, /【已知事实】\n {2}- 无/);
});

test("任务书：负向词自动进「不要做」并去重", () => {
  const text = renderBriefing({
    background: "背景",
    goal: "目标",
    tools: ["house_search"],
    avoid: ["天气查询"],
    routing: {
      keywords: [],
      suitableFor: [],
      notSuitableFor: ["天气查询", "写代码"],
    },
  });
  const avoidSection = text.slice(text.indexOf("【边界】"));
  assert.match(avoidSection, /天气查询/);
  assert.match(avoidSection, /写代码/);
  // 重复项只出现一次
  assert.equal((avoidSection.match(/天气查询/g) ?? []).length, 1);
});

test("任务书：outOfScope 约定必须出现在边界小节里", () => {
  const text = renderBriefing({ background: "背景", goal: "目标", tools: ["a"] });
  assert.match(text, /【超出范围】/);
});

test("任务书：超长输入被截断并标注", () => {
  const text = renderBriefing({
    background: "很长".repeat(2_000),
    goal: "目标",
    tools: [],
  });
  assert.ok(text.length <= 6_100);
  assert.match(text, /已截断/);
});

test("超出范围：只在末尾小节识别，正文中间提到不算", () => {
  const mid = "我做了很多事，其中提到【超出范围】但这不是末尾报告。\n之后还有正常内容";
  assert.equal(parseOutOfScope(mid), null);

  const tail = "已完成房源检索，共 3 条候选。\n\n【超出范围】该问题需要天气数据，本代理无此工具。\n建议：general";
  const report = parseOutOfScope(tail);
  assert.ok(report);
  assert.match(report!.reason, /需要天气数据/);
  assert.deepEqual(report!.suggested, ["general"]);
});

test("超出范围：空正文返回 null", () => {
  assert.equal(parseOutOfScope(""), null);
  assert.equal(parseOutOfScope("【超出范围】   "), null);
});
