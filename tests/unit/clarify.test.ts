/**
 * clarify.test.ts — 澄清载荷归一化与多题答案拼装
 * ============================================================
 * 守：新旧两种载荷都归一化成 questions 数组；多题提交必须带题面
 * （否则模型只看到一串答案分不清对应关系）；单题仍回传选项 id 保持旧协议。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answeredCount, answerLinesOf, buildClarifySubmission, normalizeClarify, summarizeClarify,
  MAX_SUBMISSION_CHARS,
  type ClarifyAnswer,
} from "../../src/client/modules/clarify.js";
import type { ClarificationPayload } from "../../src/client/modules/types.js";

const twoOptions = [{ id: "A", label: "甲" }, { id: "B", label: "乙", description: "乙的说明" }];

function answer(optionId: string | null, label: string, detail?: string): ClarifyAnswer {
  return { optionId, label, ...(detail ? { detail } : {}) };
}

test("归一化：新多题载荷原样保留，选项 id 只在本道题内唯一", () => {
  const payload: ClarificationPayload = {
    type: "clarification",
    questions: [
      { id: "q1", question: "方向？", options: twoOptions, allowCustom: true },
      { id: "q2", question: "城市？", options: twoOptions, allowCustom: false },
    ],
  };
  const questions = normalizeClarify(payload);
  assert.deepEqual(questions.map((item) => item.id), ["q1", "q2"]);
  assert.deepEqual(questions.map((item) => item.options.map((option) => option.id)), [["A", "B"], ["A", "B"]]);
  assert.equal(questions[1]?.allowCustom, false);
});

test("归一化：旧单问载荷提升成一道题", () => {
  const questions = normalizeClarify({
    type: "clarification",
    question: "先看哪个城市？",
    options: twoOptions,
    allowCustom: true,
  });
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.question, "先看哪个城市？");
  assert.equal(questions[0]?.allowCustom, true);
});

test("归一化：缺选项的题被丢弃；一道都不成立时返回空数组", () => {
  const partial = normalizeClarify({
    type: "clarification",
    questions: [
      { id: "q1", question: "只有一个选项", options: [{ id: "A", label: "唯一" }], allowCustom: true },
      { id: "q2", question: "合法题", options: twoOptions, allowCustom: true },
    ],
  });
  assert.deepEqual(partial.map((item) => item.id), ["q2"]);

  const none = normalizeClarify({ type: "clarification", questions: [] });
  assert.deepEqual(none, []);
  assert.deepEqual(normalizeClarify(null), []);
});

test("归一化：超过 4 题截断，题 id 缺失按顺序补", () => {
  const questions = normalizeClarify({
    type: "clarification",
    questions: Array.from({ length: 6 }, () => ({ question: "题", options: twoOptions, allowCustom: true })),
  });
  assert.equal(questions.length, 4);
  assert.deepEqual(questions.map((item) => item.id), ["q1", "q2", "q3", "q4"]);
});

test("单题提交回传选项 id（保持旧协议），自定义输入回传原文", () => {
  const questions = normalizeClarify({
    type: "clarification",
    questions: [{ id: "q1", question: "城市？", options: twoOptions, allowCustom: true }],
  });
  assert.equal(buildClarifySubmission(questions, { q1: answer("A", "甲") }), "A");
  assert.equal(buildClarifySubmission(questions, { q1: answer(null, "青岛崂山区") }), "青岛崂山区");
  assert.equal(buildClarifySubmission(questions, {}), "");
});

test("多题提交必须带题面，选项说明进括号", () => {
  const questions = normalizeClarify({
    type: "clarification",
    questions: [
      { id: "q1", question: "方向？", options: twoOptions, allowCustom: true },
      { id: "q2", question: "城市？", options: twoOptions, allowCustom: true },
    ],
  });
  const submission = buildClarifySubmission(questions, {
    q1: answer("A", "甲"),
    q2: answer("B", "乙", "乙的说明"),
  });
  assert.equal(submission, "方向？：甲；城市？：乙（乙的说明）");
  // 部分作答时只拼已答的题，不产生空行
  assert.equal(buildClarifySubmission(questions, { q1: answer("A", "甲") }), "方向？：甲");
});

test("提交文本超过 2000 字时按题均分预算截断，每题都保留内容", () => {
  const questions = normalizeClarify({
    type: "clarification",
    questions: [
      { id: "q1", question: "方向？", options: twoOptions, allowCustom: true },
      { id: "q2", question: "城市？", options: twoOptions, allowCustom: true },
    ],
  });
  const long = "长".repeat(600);
  const submission = buildClarifySubmission(questions, {
    q1: answer(null, long),
    q2: answer(null, long),
  });
  assert.ok(submission.length <= MAX_SUBMISSION_CHARS, "拼装结果不得超过服务端上限");
  // 两道题的题面都要保留，否则模型分不清哪段答案对应哪道题
  assert.ok(submission.includes("方向？："));
  assert.ok(submission.includes("城市？："));
});

test("单题提交超长同样截断到上限", () => {
  const questions = normalizeClarify({
    type: "clarification",
    questions: [{ id: "q1", question: "城市？", options: twoOptions, allowCustom: true }],
  });
  const submission = buildClarifySubmission(questions, { q1: answer(null, "长".repeat(3_000)) });
  assert.equal(submission.length, MAX_SUBMISSION_CHARS);
});

test("已答摘要与逐题答案行保持一致", () => {
  const questions = normalizeClarify({
    type: "clarification",
    questions: [
      { id: "q1", question: "方向？", options: twoOptions, allowCustom: true },
      { id: "q2", question: "城市？", options: twoOptions, allowCustom: true },
    ],
  });
  const answers = { q1: answer("A", "甲"), q2: answer("B", "乙", "乙的说明") };
  assert.equal(summarizeClarify(questions, answers), "方向？：甲；城市？：乙（乙的说明）");
  assert.deepEqual(answerLinesOf(questions, answers), [
    { question: "方向？", answer: "甲" },
    { question: "城市？", answer: "乙（乙的说明）" },
  ]);
  assert.equal(answeredCount(questions, answers), 2);
  assert.equal(answeredCount(questions, { q1: answer("A", "甲") }), 1);
  assert.equal(answeredCount(questions, {}), 0);
});

test("单题摘要不带题面（沿用旧的「已选择：北京」文案）", () => {
  const questions = normalizeClarify({
    type: "clarification",
    questions: [{ id: "q1", question: "城市？", options: twoOptions, allowCustom: true }],
  });
  assert.equal(summarizeClarify(questions, { q1: answer("A", "甲") }), "甲");
});
