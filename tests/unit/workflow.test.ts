import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Command, MemorySaver } from "@langchain/langgraph";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createWorkflowGraph,
  parseRequirementAnalysis,
  parseReviewResult,
  type WorkflowChatModel,
} from "../../src/agent/workflow.js";
import type { AgentProfile } from "../../src/agent/profile.js";
import { generalProfile } from "../../src/agent/general.js";
import { estateProfile } from "../../src/agent/estate.js";
import { calculator } from "../../src/tools.js";
import { AGENT_RECURSION_LIMIT } from "../../src/config.js";

const testProfile: AgentProfile = {
  id: "general",
  displayName: "测试 Agent",
  systemPrompt: "测试系统提示",
  tools: [],
  approvalDescriptions: {},
};

/** 带真实工具的 profile：连续模式的「每轮有工具动作」路径需要一个能真执行的工具。 */
const toolProfile: AgentProfile = {
  ...testProfile,
  tools: [calculator],
};

/** 模拟“登录失效”一类不可继续状态：工具返回 stopAgent，图必须给出收尾后结束。 */
const stoppingTool = tool(
  async () => JSON.stringify({ error: "需要登录", authRequired: true, loginUrl: "https://building.ke.com/?action=get-key&source=agentatlas", stopAgent: true }),
  {
    name: "calculator",
    description: "测试用停止工具",
    schema: z.object({ expression: z.string() }),
  },
);
const stoppingToolProfile: AgentProfile = { ...testProfile, tools: [stoppingTool] };

/**
 * 可脚本化的工具调用假模型：响应为 "TOOL" 时发一次 calculator 调用（直接执行，
 * 不触发审批也不触碰风险评估模型），否则按原文输出。用来模拟「连续回炉期间
 * 每轮都有工具动作」——这正是空转熔断保持清零的前提。
 */
class ScriptedToolCallModel extends BaseChatModel {
  private script: string[];

  constructor(responses: string[]) {
    super({});
    this.script = [...responses];
  }

  _llmType(): string {
    return "scripted-tool-call-fake";
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const next = this.script.shift() ?? "答（脚本耗尽）";
    const message: AIMessage = next === "TOOL"
      ? new AIMessage({
          content: "",
          tool_calls: [{ name: "calculator", args: { expression: "1+1" }, id: `call_${this.script.length}`, type: "tool_call" }],
        })
      : new AIMessage(next);
    return { generations: [{ text: "", message }] };
  }
}

test("需求分析：fenced JSON + 两个选项 → 进入澄清", () => {
  const result = parseRequirementAnalysis([
    "```json",
    JSON.stringify({
      understood: false,
      brief: "用户想找房但没说城市",
      questions: [{
        id: "q1",
        question: "你想在哪个城市找房？",
        options: [
          { id: "A", label: "北京", description: "优先看北京房源" },
          { id: "B", label: "上海", description: "优先看上海房源" },
        ],
      }],
    }),
    "```",
  ].join("\n"));
  assert.equal(result.understood, false);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0]?.question, "你想在哪个城市找房？");
  assert.deepEqual(result.questions[0]?.options.map((item) => item.id), ["A", "B"]);
  assert.equal(result.questions[0]?.options[0]?.description, "优先看北京房源");
});

test("需求分析：旧单问载荷（顶层 question + options）自动提升成一道题", () => {
  const result = parseRequirementAnalysis(JSON.stringify({
    understood: false,
    brief: "缺少城市",
    question: "你想在哪个城市找房？",
    options: [{ id: "A", label: "北京" }, { id: "B", label: "上海" }],
    allowCustom: true,
  }));
  assert.equal(result.understood, false);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0]?.allowCustom, true);
});

test("需求分析：多题一次问完，逐题保留选项", () => {
  const result = parseRequirementAnalysis(JSON.stringify({
    understood: false,
    brief: "求职信息缺口四项",
    questions: [
      { id: "q1", question: "找什么方向？", options: [{ id: "A", label: "前端" }, { id: "B", label: "后端" }] },
      { id: "q2", question: "在哪个城市？", options: [{ id: "A", label: "青岛" }, { id: "B", label: "济南" }] },
      { id: "q3", question: "期望月薪？", options: [{ id: "A", label: "15-20K" }, { id: "B", label: "20-30K" }] },
    ],
  }));
  assert.equal(result.questions.length, 3);
  assert.deepEqual(result.questions.map((item) => item.id), ["q1", "q2", "q3"]);
  // 选项 id 只在本道题内唯一：两道题都用 A/B 是合法的
  assert.deepEqual(result.questions.map((item) => item.options.map((option) => option.id)), [["A", "B"], ["A", "B"], ["A", "B"]]);
});

test("需求分析：缺选项的题被丢弃，其余题保留；一道都不成立则继续执行", () => {
  const partial = parseRequirementAnalysis(JSON.stringify({
    understood: false,
    questions: [
      { id: "q1", question: "只有一个选项", options: [{ id: "A", label: "唯一" }] },
      { id: "q2", question: "这题合法", options: [{ id: "A", label: "甲" }, { id: "B", label: "乙" }] },
    ],
  }));
  assert.equal(partial.understood, false);
  assert.deepEqual(partial.questions.map((item) => item.id), ["q2"]);

  const none = parseRequirementAnalysis(JSON.stringify({
    understood: false,
    questions: [{ id: "q1", question: "只有一个选项", options: [{ id: "A", label: "唯一" }] }],
  }));
  assert.equal(none.understood, true);
  assert.deepEqual(none.questions, []);
});

test("需求分析：超过 4 题时截断到 4 题", () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`,
    question: `问题 ${index + 1}`,
    options: [{ id: "A", label: "甲" }, { id: "B", label: "乙" }],
  }));
  const result = parseRequirementAnalysis(JSON.stringify({ understood: false, questions }));
  assert.equal(result.questions.length, 4);
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
  assert.deepEqual(broken.questions, []);
});

test("需求分析：字段等价写法与选项 id 兜底", () => {
  const result = parseRequirementAnalysis(JSON.stringify({
    needsClarification: true,
    brief: "需要确认范围",
    questions: [{
      text: "这次要改哪些文件？",
      options: [
        { label: "只改前端" },
        { label: "只改后端" },
      ],
    }],
  }));
  assert.equal(result.understood, false);
  assert.equal(result.questions.length, 1);
  assert.deepEqual(result.questions[0]?.options.map((item) => item.id), ["A", "B"]);
  // 缺 id 时按顺序补 q1
  assert.equal(result.questions[0]?.id, "q1");
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
  assert.match(estateProfile.reviewerGuidance ?? "", /location\/images/);
  assert.match(estateProfile.reviewerGuidance ?? "", /分间面积/);
  // 找房调研的图文交付不能是可选项：模型必须优先产出地图与户型图工具结果。
  assert.match(estateProfile.systemPrompt, /区位是找房调研的默认交付/);
  assert.match(estateProfile.systemPrompt, /必须调用 house_map/);
  assert.match(estateProfile.systemPrompt, /户型图同样是默认交付/);
  assert.match(estateProfile.systemPrompt, /house_lookup\(action=material\)/);
  assert.match(estateProfile.systemPrompt, /location\.lat\/lng/);
  assert.match(estateProfile.systemPrompt, /Markdown 图片语法/);
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
  ) as unknown as { __interrupt__?: Array<{ value: { type: string; questions: Array<{ options: unknown[] }> } }> };
  assert.equal(paused.__interrupt__?.[0]?.value.type, "clarification");
  // 模型回的还是旧单问形状，图出口统一成 questions 数组（一道题）
  assert.equal(paused.__interrupt__?.[0]?.value.questions.length, 1);
  assert.equal(paused.__interrupt__?.[0]?.value.questions[0]?.options.length, 2);

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

test("无头模式：澄清不挂起，自动采用首个选项并记入台账", async () => {
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
      "已按北京给出找房建议。",
      JSON.stringify({ passes: true, reason: "回答满足需求", feedback: "" }),
    ],
  });
  const graph = createWorkflowGraph(testProfile, {
    agent: fake as unknown as WorkflowChatModel,
    analyst: fake as unknown as WorkflowChatModel,
    reviewer: fake as unknown as WorkflowChatModel,
  }, { checkpointer: new MemorySaver() });
  const threadId = `headless-${randomUUID()}`;
  const result = await graph.invoke(
    { messages: [new HumanMessage("帮我找房")] },
    { configurable: { thread_id: threadId, headless: true } },
  ) as unknown as {
    messages: Array<{ content: unknown }>;
    __interrupt__?: unknown[];
    clarificationHistory?: string;
    requirementBrief?: string;
    headlessAssumption?: string;
  };

  // 关键：不挂起（否则无人应答的外部调用会拿到空输出）
  assert.equal(result.__interrupt__, undefined, "无头模式不得产生 interrupt");
  assert.ok(result.messages.some((m) => m.content === "已按北京给出找房建议。"));
  assert.match(result.clarificationHistory ?? "", /北京/, "假设应写进澄清历史");
  assert.match(result.requirementBrief ?? "", /【无头模式自动假设】/, "假设应进入需求 brief");
  assert.match(result.headlessAssumption ?? "", /先看哪个城市/);
  assert.match(result.headlessAssumption ?? "", /北京/);
});

test("连续模式：每轮有工具动作时不受三次回炉上限约束，直到反思通过才结束", async () => {
  // 消费序列：analyze → (工具, 答1, 拒) ×4 → (工具, 答5, 过)。
  // 普通模式在第 4 次失败（attempts=3）就强制结束；连续模式必须继续到第 5 轮通过。
  const agentFake = new ScriptedToolCallModel([
    "TOOL", "答1", "TOOL", "答2", "TOOL", "答3", "TOOL", "答4", "TOOL", "答5",
  ]);
  const judgeFake = new FakeListChatModel({
    responses: [
      JSON.stringify({ understood: true, brief: "构建并验证项目", question: "", options: [] }),
      JSON.stringify({ passes: false, reason: "未完成", feedback: "继续执行" }),
      JSON.stringify({ passes: false, reason: "未完成", feedback: "继续执行" }),
      JSON.stringify({ passes: false, reason: "未完成", feedback: "继续执行" }),
      JSON.stringify({ passes: false, reason: "未完成", feedback: "继续执行" }),
      JSON.stringify({ passes: true, reason: "构建完成且测试通过", feedback: "" }),
    ],
  });
  const graph = createWorkflowGraph(toolProfile, {
    agent: agentFake as unknown as WorkflowChatModel,
    analyst: judgeFake as unknown as WorkflowChatModel,
    reviewer: judgeFake as unknown as WorkflowChatModel,
  }, { checkpointer: new MemorySaver() });
  const result = await graph.invoke(
    { messages: [new HumanMessage("构建并验证项目")] },
    { recursionLimit: AGENT_RECURSION_LIMIT, configurable: { thread_id: `continuous-${randomUUID()}`, continuous: true } },
  ) as unknown as { messages: Array<{ content: unknown }>; reviewAttempts?: number; continuousMode?: boolean };

  // 标记必须写入图状态：审批 resume 走同一线程检查点，靠它续存
  assert.equal(result.continuousMode, true);
  assert.equal(result.reviewAttempts, 5);
  const answers = result.messages.map((message) => String(message.content));
  assert.ok(answers.includes("答5"), "第 4 次失败后必须继续回炉并产出第 5 个回答");
});

test("连续模式：反思连续失败且期间无任何工具动作时，三轮即空转熔断", async () => {
  const fake = new FakeListChatModel({
    responses: [
      JSON.stringify({ understood: true, brief: "长任务", question: "", options: [] }),
      "空转1", JSON.stringify({ passes: false, reason: "未完成", feedback: "继续" }),
      "空转2", JSON.stringify({ passes: false, reason: "未完成", feedback: "继续" }),
      "空转3", JSON.stringify({ passes: false, reason: "未完成", feedback: "继续" }),
      "空转4", JSON.stringify({ passes: false, reason: "未完成", feedback: "继续" }),
    ],
  });
  const graph = createWorkflowGraph(testProfile, {
    agent: fake as unknown as WorkflowChatModel,
    analyst: fake as unknown as WorkflowChatModel,
    reviewer: fake as unknown as WorkflowChatModel,
  }, { checkpointer: new MemorySaver() });
  const result = await graph.invoke(
    { messages: [new HumanMessage("做一个大项目")] },
    { recursionLimit: AGENT_RECURSION_LIMIT, configurable: { thread_id: `idle-${randomUUID()}`, continuous: true } },
  ) as unknown as { messages: Array<{ content: unknown }>; reviewAttempts?: number };

  // 熔断在第 3 次失败反思后生效：第 4 个纯文本回答不应存在
  const answers = result.messages.map((message) => String(message.content)).filter((text) => text.startsWith("空转"));
  assert.equal(answers.length, 3);
  assert.equal(result.reviewAttempts, 3);
});

test("工具返回 stopAgent 时生成登录收尾并结束本轮，不再调用模型重试", async () => {
  const agentFake = new ScriptedToolCallModel(["TOOL", "不应出现的第二次回答"]);
  const analystFake = new FakeListChatModel({
    responses: [JSON.stringify({ understood: true, brief: "查询房源", question: "", options: [] })],
  });
  const reviewerFake = new FakeListChatModel({
    responses: [JSON.stringify({ passes: true, reason: "无需反思", feedback: "" })],
  });
  const graph = createWorkflowGraph(stoppingToolProfile, {
    agent: agentFake as unknown as WorkflowChatModel,
    analyst: analystFake as unknown as WorkflowChatModel,
    reviewer: reviewerFake as unknown as WorkflowChatModel,
  }, { checkpointer: new MemorySaver() });
  const result = await graph.invoke(
    { messages: [new HumanMessage("帮我找青岛两室")] },
    { configurable: { thread_id: `stop-tool-${randomUUID()}` } },
  ) as unknown as { messages: BaseMessage[] };

  const texts = result.messages.map((message) => String(message.content));
  assert.ok(texts.some((text) => text.includes("需要登录")));
  assert.equal(texts.includes("不应出现的第二次回答"), false);
  const last = result.messages.at(-1);
  assert.equal(last?.getType(), "ai");
  assert.match(String(last?.content), /请按以下步骤恢复/);
  assert.match(String(last?.content), /保存成功后回复「继续」/);
});
