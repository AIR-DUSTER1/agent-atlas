/**
 * tests/unit/routing-intents.test.ts — 意图切分与分层归并（R8）
 * ============================================================
 * 守：分隔符切分、短碎片过滤、截断显式告知、分层深度固定 2 层、类别数上限。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHierarchicalPlan,
  needsHierarchy,
  splitIntents,
} from "../../src/routing/intents.js";

const MAX_CHARS = 4_000;

test("切分：中文分隔符与连接词都能切开", () => {
  const { intents } = splitIntents("帮我找北京的房；然后算下月供。还有查一下天气", MAX_CHARS);
  assert.equal(intents.length, 3);
  assert.match(intents[0]!.text, /找北京的房/);
  assert.match(intents[1]!.text, /算下月供/);
  assert.match(intents[2]!.text, /查一下天气/);
});

test("切分：没有分隔符时整段算一个意图", () => {
  const { intents, truncated } = splitIntents("帮我找一下北京朝阳区两居室", MAX_CHARS);
  assert.equal(intents.length, 1);
  assert.equal(truncated, 0);
});

test("切分：过短的碎片被过滤（语气词不单独成意图）", () => {
  const { intents } = splitIntents("好的；帮我查一下房源信息；谢谢", MAX_CHARS);
  assert.equal(intents.length, 1);
  assert.match(intents[0]!.text, /查一下房源信息/);
});

test("切分：空文本返回空数组", () => {
  assert.deepEqual(splitIntents("", MAX_CHARS), { intents: [], truncated: 0 });
  assert.deepEqual(splitIntents("   \n  ", MAX_CHARS), { intents: [], truncated: 0 });
});

test("切分：单条超过字符上限会被截断", () => {
  const long = "很长的意图".repeat(500);
  const { intents } = splitIntents(long, 100);
  assert.equal(intents[0]!.text.length, 100);
});

test("分层：按类别归并，组内保持原始顺序", () => {
  const plan = buildHierarchicalPlan(
    [
      { text: "找房源", agentId: "estate" },
      { text: "写代码", agentId: "dev" },
      { text: "算月供", agentId: "estate" },
    ],
    {
      maxCategories: 6,
      categoryOf: (agentId) => (agentId === "estate" ? "居住" : agentId === "dev" ? "研发" : ""),
    },
  );
  assert.equal(plan.total, 3);
  const living = plan.groups.find((group) => group.category === "居住");
  assert.ok(living);
  assert.equal(living!.count, 2);
  assert.deepEqual(living!.items.map((item) => item.text), ["找房源", "算月供"]);
});

test("分层：类别数超限时并入最后一组但计数不丢", () => {
  const plan = buildHierarchicalPlan(
    [
      { text: "a", agentId: "x" },
      { text: "b", agentId: "y" },
      { text: "c", agentId: "z" },
    ],
    { maxCategories: 2, categoryOf: (agentId) => agentId },
  );
  assert.equal(plan.groups.length, 2);
  const totalCounted = plan.groups.reduce((sum, group) => sum + group.count, 0);
  assert.equal(totalCounted, 3);
  assert.match(plan.groups[1]!.summary, /并入/);
});

test("分层：超过意图上限时截断并给出截断数", () => {
  const intents = Array.from({ length: 12 }, (_, index) => ({ text: `任务${index}`, agentId: "estate" }));
  const plan = buildHierarchicalPlan(intents, {
    maxCategories: 6,
    maxIntents: 10,
    categoryOf: () => "居住",
  });
  assert.equal(plan.total, 10);
  assert.equal(plan.truncated, 2);
});

test("分层：类别为空的意图归入「其他」", () => {
  const plan = buildHierarchicalPlan([{ text: "随手一问", agentId: "none" }], {
    maxCategories: 6,
    categoryOf: () => "",
  });
  assert.equal(plan.groups[0]!.category, "其他");
});

test("分层触发：严格大于阈值才触发", () => {
  assert.equal(needsHierarchy(20, 20), false);
  assert.equal(needsHierarchy(21, 20), true);
  assert.equal(needsHierarchy(0, 20), false);
});
