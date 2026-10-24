/**
 * tests/unit/subagent.test.ts — 子 Agent 执行器回归
 * ============================================================
 * 守住阶段 1 的三条安全默认与黑盒交互语义：
 *   1. 正常链路：假模型跑通 analyze→agent→review，结果含答案与耗时；
 *   2. 澄清拦截：子图 interrupt 无法冒泡 → 转模型可读错误（不挂死、不半截结果）；
 *   3. 深度 = 1：子 profile 剔除 delegate_agent；黑盒规则追加进分析提示。
 * 全部用 FakeListChatModel / 脚本化模型，不消耗真实 API。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { runSubagent, subagentProfileOf, DELEGATE_TOOL_NAME } from "../../src/agent/subagent.js";
import { generalProfile } from "../../src/agent/general.js";
import type { AgentProfile } from "../../src/agent/profile.js";
import type { WorkflowChatModel } from "../../src/agent/workflow.js";

const TEST_PROFILE: AgentProfile = {
  id: "general",
  displayName: "测试 Agent",
  systemPrompt: "测试系统提示",
  tools: [],
  approvalDescriptions: {},
};

function fixedModel(content: string): WorkflowChatModel {
  return { invoke: async () => new AIMessage(content) };
}

const ANALYSIS_OK = JSON.stringify({ understood: true, brief: "读取项目名", question: "", options: [] });
const REVIEW_OK = JSON.stringify({ passes: true, reason: "满足需求", feedback: "" });

test("正常链路：子图跑完 analyze→agent→review，结果含答案与耗时", async () => {
  const result = await runSubagent(TEST_PROFILE, "总结这个项目的定位", {
    agent: fixedModel("这是一个 LangGraph.js 学习项目。"),
    analyst: fixedModel(ANALYSIS_OK),
    reviewer: fixedModel(REVIEW_OK),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /LangGraph\.js 学习项目/);
  assert.match(result.text, /耗时/);
  assert.ok(result.durationMs >= 0);
});

test("澄清拦截：子图请求澄清时转模型可读错误，不返回半截结果", async () => {
  const clarifyAnalysis = JSON.stringify({
    understood: false,
    brief: "范围不明",
    question: "要看哪个目录？",
    options: [
      { id: "A", label: "src", description: "" },
      { id: "B", label: "tests", description: "" },
    ],
  });
  // FakeListChatModel 顺序吐出：analyze(澄清) —— 图在 clarify 节点 interrupt 停止
  const fake = new FakeListChatModel({ responses: [clarifyAnalysis, "不应到达的回答"] });
  const result = await runSubagent(TEST_PROFILE, "帮我看看", {
    agent: fake as unknown as WorkflowChatModel,
    analyst: fake as unknown as WorkflowChatModel,
    reviewer: fake as unknown as WorkflowChatModel,
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /澄清/);
  assert.match(result.text, /重试/);
});

test("agent 模型异常穿透子图 → 转中文执行失败，不 throw", async () => {
  const broken: WorkflowChatModel = {
    invoke: async () => { throw new Error("gateway 503"); },
  };
  const result = await runSubagent(TEST_PROFILE, "任务", {
    agent: broken,
    analyst: fixedModel(ANALYSIS_OK),
    reviewer: fixedModel(REVIEW_OK),
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /执行失败/);
  assert.match(result.text, /503/);
});

test("空任务书直接拒绝", async () => {
  const result = await runSubagent(TEST_PROFILE, "   ");
  assert.equal(result.ok, false);
  assert.match(result.text, /任务书为空/);
});

test("子 profile 副本：剔除 delegate_agent（深度=1）并追加黑盒分析规则", () => {
  const generalWithDelegate: AgentProfile = {
    ...TEST_PROFILE,
    tools: [...TEST_PROFILE.tools, { name: DELEGATE_TOOL_NAME } as never],
  };
  const sub = subagentProfileOf(generalWithDelegate);
  assert.equal(sub.tools.some((item) => item.name === DELEGATE_TOOL_NAME), false);
  assert.match(sub.analystGuidance ?? "", /不要请求澄清/);
  assert.match(sub.analystGuidance ?? "", /只读/);
});

test("general profile 的委派工具与审批文案已登记", () => {
  assert.ok(generalProfile.tools.some((item) => item.name === DELEGATE_TOOL_NAME));
  assert.ok(DELEGATE_TOOL_NAME in (generalProfile.approvalDescriptions ?? {}));
});
