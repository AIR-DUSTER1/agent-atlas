import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Command, MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  createWorkflowGraph,
  parseRequirementAnalysis,
  parseReviewResult,
  type WorkflowChatModel,
} from "../../src/agent/workflow.js";
import type { AgentProfile } from "../../src/agent/profile.js";
import { generalProfile } from "../../src/agent/general.js";
import { estateProfile } from "../../src/agent/estate.js";

const testProfile: AgentProfile = {
  id: "general",
  displayName: "测试 Agent",
  systemPrompt: "测试系统提示",
  tools: [],
  approvalDescriptions: {},
};

test("需求分析：fenced JSON + 两个选项 → 进入澄清", () => {
  const result = parseRequirementAnalysis([
    "```json",
    JSON.stringify({
      understood: false,
      brief: "用户想找房但没说城市",
      question: "你想在哪个城市找房？",
      options: [
        { id: "A", label: "北京", description: "优先看北京房源" },
        { id: "B", label: "上海", description: "优先看上海房源" },
      ],
    }),
    "```",
  ].join("\n"));
  assert.equal(result.understood, false);
  assert.equal(result.question, "你想在哪个城市找房？");
  assert.deepEqual(result.options.map((item) => item.id), ["A", "B"]);
  assert.equal(result.options[0].description, "优先看北京房源");
});

test("需求分析：缺少选项或 JSON 损坏时宁可继续执行", () => {
  const missingOptions = parseRequirementAnalysis(JSON.stringify({
    understood: false,
    brief: "信息不足",
    question: "选哪个？",
    options: [{ id: "A", label: "只有一个" }],
  }));
  assert.equal(missingOptions.understood, true);

  const broken = parseRequirementAnalysis("模型开始胡说，没有 JSON");
  assert.equal(broken.understood, true);
  assert.deepEqual(broken.options, []);
});

test("需求分析：字段等价写法与选项 id 兜底", () => {
  const result = parseRequirementAnalysis(JSON.stringify({
    needsClarification: true,
    brief: "需要确认范围",
    question: "这次要改哪些文件？",
    options: [
      { label: "只改前端" },
      { label: "只改后端" },
    ],
  }));
  assert.equal(result.understood, false);
  assert.deepEqual(result.options.map((item) => item.id), ["A", "B"]);
});

test("结果反思：明确失败才回炉，坏输出默认通过", () => {
  const failed = parseReviewResult(JSON.stringify({
    passes: false,
    reason: "遗漏了预算约束",
    feedback: "补上预算范围再回答",
  }));
  assert.equal(failed.passes, false);
  assert.equal(failed.feedback, "补上预算范围再回答");

  assert.equal(parseReviewResult("not json").passes, true);
  assert.equal(parseReviewResult(JSON.stringify({ passes: true })).passes, true);
});

test("通用与房产 profile 注入不同的分析 / 反思领域规则", () => {
  assert.match(generalProfile.analystGuidance ?? "", /只分析/);
  assert.match(generalProfile.reviewerGuidance ?? "", /未验证/);
  assert.match(estateProfile.analystGuidance ?? "", /租房/);
  assert.match(estateProfile.analystGuidance ?? "", /houseId/);
  assert.match(estateProfile.reviewerGuidance ?? "", /宏观均价/);
  assert.match(estateProfile.reviewerGuidance ?? "", /预约或加微/);
});

test("工作流：需求不清时 interrupt，选择后继续 ReAct 并完成反思", async () => {
  const fake = new FakeListChatModel({
    responses: [
      JSON.stringify({
        understood: false,
        brief: "用户想找房但城市未定",
        question: "先看哪个城市？",
        options: [
          { id: "A", label: "北京", description: "北京房源" },
          { id: "B", label: "上海", description: "上海房源" },
        ],
      }),
      "已按你的选择完成找房建议。",
      JSON.stringify({ passes: true, reason: "回答满足需求", feedback: "" }),
    ],
  });
  const models = {
    agent: fake as unknown as WorkflowChatModel,
    analyst: fake as unknown as WorkflowChatModel,
    reviewer: fake as unknown as WorkflowChatModel,
  };
  const graph = createWorkflowGraph(testProfile, models, { checkpointer: new MemorySaver() });
  const threadId = `workflow-${randomUUID()}`;
  const config = { configurable: { thread_id: threadId } };

  const paused = await graph.invoke(
    { messages: [new HumanMessage("帮我找房")] },
    config
  ) as unknown as { __interrupt__?: Array<{ value: { type: string; options: unknown[] } }> };
  assert.equal(paused.__interrupt__?.[0]?.value.type, "clarification");
  assert.equal(paused.__interrupt__?.[0]?.value.options.length, 2);

  const finished = await graph.invoke(new Command({ resume: "A" }), config) as unknown as {
    messages: Array<{ content: unknown }>;
    requirementBrief?: string;
    clarificationHistory?: string;
  };
  assert.ok(finished.messages.some((message) => message.content === "已按你的选择完成找房建议。"));
  assert.match(finished.requirementBrief ?? "", /北京/);
  assert.match(finished.clarificationHistory ?? "", /北京/);
  assert.ok(finished.messages.every((message) => !String(message.content).includes("understood")));
});

test("工作流：反思不通过时带反馈回炉一次，然后结束", async () => {
  const fake = new FakeListChatModel({
    responses: [
      JSON.stringify({ understood: true, brief: "用户要一个简短自我介绍", question: "", options: [] }),
      "我是 Agent。",
      JSON.stringify({ passes: false, reason: "缺少能力说明", feedback: "补充你能做什么" }),
      "我是 Agent，可以查天气、算数和读文件。",
      JSON.stringify({ passes: true, reason: "已补齐", feedback: "" }),
    ],
  });
  const graph = createWorkflowGraph(testProfile, {
    agent: fake as unknown as WorkflowChatModel,
    analyst: fake as unknown as WorkflowChatModel,
    reviewer: fake as unknown as WorkflowChatModel,
  }, { checkpointer: new MemorySaver() });
  const threadId = `workflow-${randomUUID()}`;
  const result = await graph.invoke(
    { messages: [new HumanMessage("介绍一下你自己")] },
    { configurable: { thread_id: threadId } }
  ) as unknown as { messages: Array<{ content: unknown }>; reviewAttempts?: number };

  const answers = result.messages.map((message) => message.content);
  assert.ok(answers.includes("我是 Agent。"));
  assert.ok(answers.includes("我是 Agent，可以查天气、算数和读文件。"));
  assert.ok(answers.every((content) => !String(content).includes("补充你能做什么")));
  assert.equal(result.reviewAttempts, 2);
});

test("工作流：反思连续不通过时最多回炉三次，第四次失败强制结束", async () => {
  // 消费序列：analyze → (答1, 拒) → (答2, 拒) → (答3, 拒) → (答4, 拒·达上限)
  const fake = new FakeListChatModel({
    responses: [
      JSON.stringify({ understood: true, brief: "用户要求覆盖四个要点", question: "", options: [] }),
      "答1", JSON.stringify({ passes: false, reason: "缺要点", feedback: "补要点" }),
      "答2", JSON.stringify({ passes: false, reason: "缺要点", feedback: "补要点" }),
      "答3", JSON.stringify({ passes: false, reason: "缺要点", feedback: "补要点" }),
      "答4", JSON.stringify({ passes: false, reason: "缺要点", feedback: "补要点" }),
    ],
  });
  const graph = createWorkflowGraph(testProfile, {
    agent: fake as unknown as WorkflowChatModel,
    analyst: fake as unknown as WorkflowChatModel,
    reviewer: fake as unknown as WorkflowChatModel,
  }, { checkpointer: new MemorySaver() });
  const threadId = `workflow-${randomUUID()}`;
  const result = await graph.invoke(
    { messages: [new HumanMessage("请覆盖四个要点")] },
    { configurable: { thread_id: threadId } }
  ) as unknown as { messages: Array<{ content: unknown }>; reviewAttempts?: number };

  const answers = result.messages.map((message) => message.content);
  assert.ok(answers.includes("答4"));
  assert.equal(result.reviewAttempts, 4);
});
