/**
 * workflow-plan.test.ts — 自主执行流程的领域状态与 LangGraph 接入
 * ============================================================
 * 覆盖：流程创建、步骤推进、单一 active 步骤、流程收口，以及
 * analyze 产出的 plan 能被 update_workflow_plan 工具推进到 completed。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import {
  applyWorkflowPlanToolInput,
  createWorkflowPlanFromDraft,
  finalizeWorkflowPlan,
  normalizeWorkflowPlanDraft,
  WORKFLOW_PLAN_TOOL_NAME,
} from "../../src/workflow-plan.js";
import { createWorkflowGraph, parseRequirementAnalysis, type WorkflowChatModel } from "../../src/agent/workflow.js";
import type { AgentProfile } from "../../src/agent/profile.js";

const testProfile: AgentProfile = {
  id: "general",
  displayName: "流程测试 Agent",
  systemPrompt: "流程测试",
  tools: [],
  approvalDescriptions: {},
};

test("流程草稿：补齐步骤 id、首个步骤进入执行中", () => {
  const draft = normalizeWorkflowPlanDraft({
    goal: "修复并验证登录流程",
    steps: [
      { title: "定位登录失败原因" },
      { id: "verify", title: "运行回归测试" },
    ],
  });
  assert.ok(draft);
  const plan = createWorkflowPlanFromDraft(draft, 1_000, "plan-test");
  assert.ok(plan);
  assert.equal(plan.id, "plan-test");
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps.map((step) => step.id), ["step-1", "verify"]);
  assert.equal(plan.activeStepId, "step-1");
  assert.equal(plan.steps[0]?.status, "in_progress");
  assert.equal(plan.steps[1]?.status, "pending");
});

test("流程推进：完成当前步骤后自动把下一步投入执行，并保持单一 active", () => {
  const draft = normalizeWorkflowPlanDraft({
    goal: "完成发布",
    steps: [{ title: "构建" }, { title: "测试" }, { title: "发布" }],
  });
  assert.ok(draft);
  const initial = createWorkflowPlanFromDraft(draft, 1_000, "plan-update");
  assert.ok(initial);
  const next = applyWorkflowPlanToolInput(initial, {
    updates: [
      { stepId: "step-1", status: "completed", note: "build passed" },
      { stepId: "step-2", status: "in_progress" },
    ],
  }, 2_000);
  assert.ok(next);
  assert.equal(next.revision, 2);
  assert.equal(next.steps[0]?.status, "completed");
  assert.equal(next.steps[0]?.note, "build passed");
  assert.equal(next.steps[1]?.status, "in_progress");
  assert.equal(next.activeStepId, "step-2");
  assert.equal(next.status, "running");
});

test("流程收口：所有步骤完成或跳过后状态为 completed", () => {
  const draft = normalizeWorkflowPlanDraft({
    goal: "收集信息",
    steps: [{ title: "读取文档" }, { title: "检查附件" }],
  });
  assert.ok(draft);
  const initial = createWorkflowPlanFromDraft(draft, 1_000, "plan-final");
  assert.ok(initial);
  const done = applyWorkflowPlanToolInput(initial, {
    updates: [
      { stepId: "step-1", status: "completed" },
      { stepId: "step-2", status: "skipped", note: "没有附件" },
    ],
  }, 2_000);
  assert.ok(done);
  assert.equal(done.status, "completed");
  assert.equal(done.activeStepId, null);
  const finalized = finalizeWorkflowPlan(done, "completed", 3_000);
  assert.equal(finalized, done, "已收口流程不应重复制造 revision");
});

test("需求分析：plan JSON 被规范化，简单任务保持 null", () => {
  const withPlan = parseRequirementAnalysis(JSON.stringify({
    understood: true,
    brief: "先修代码再测试",
    questions: [],
    plan: { goal: "修复", steps: [{ title: "读代码" }, { title: "跑测试" }] },
  }));
  assert.equal(withPlan.plan?.steps.length, 2);
  const simple = parseRequirementAnalysis(JSON.stringify({ understood: true, brief: "你好", questions: [] }));
  assert.equal(simple.plan, null);
});

/** 按脚本返回工具调用或文本；用于验证 planProgress 节点而非真实网关。 */
class PlanThenAnswerModel extends BaseChatModel {
  private step = 0;

  constructor() { super({}); }

  _llmType(): string { return "plan-then-answer-fake"; }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.step += 1;
    const message = this.step === 1
      ? new AIMessage({
          content: "",
          tool_calls: [{
            name: WORKFLOW_PLAN_TOOL_NAME,
            args: { updates: [
              { stepId: "step-1", status: "completed", note: "已读取文件" },
              { stepId: "step-2", status: "in_progress" },
            ] },
            id: "plan-update-1",
            type: "tool_call",
          }],
        })
      : this.step === 2
        ? new AIMessage({
            content: "",
            tool_calls: [{
              name: WORKFLOW_PLAN_TOOL_NAME,
              args: { updates: [{ stepId: "step-2", status: "completed", note: "测试通过" }] },
              id: "plan-update-2",
              type: "tool_call",
            }],
          })
        : new AIMessage("已完成代码修复并通过测试。");
    return { generations: [{ text: "", message }] };
  }
}

test("LangGraph：analyze 计划可由受控工具推进并在反思后收口", async () => {
  const analyst = new FakeListChatModel({
    responses: [JSON.stringify({
      understood: true,
      brief: "修复并验证代码",
      questions: [],
      plan: { goal: "修复并验证代码", steps: [{ title: "读取代码" }, { title: "运行测试" }] },
    })],
  });
  const reviewer = new FakeListChatModel({
    responses: [JSON.stringify({ passes: true, reason: "有测试证据", feedback: "" })],
  });
  const agent = new PlanThenAnswerModel();
  const graph = createWorkflowGraph(testProfile, {
    agent: agent as unknown as WorkflowChatModel,
    analyst: analyst as unknown as WorkflowChatModel,
    reviewer: reviewer as unknown as WorkflowChatModel,
  }, { checkpointer: new MemorySaver() });
  const result = await graph.invoke(
    { messages: [new HumanMessage("修复代码并运行测试")] },
    { configurable: { thread_id: `plan-${randomUUID()}` } },
  ) as unknown as {
    workflowPlan?: {
      status: string;
      activeStepId: string | null;
      steps: Array<{ status: string; note?: string }>;
    };
    messages: Array<{ content: unknown }>;
  };
  assert.ok(result.workflowPlan);
  assert.equal(result.workflowPlan?.status, "completed");
  assert.equal(result.workflowPlan?.activeStepId, null);
  assert.deepEqual(result.workflowPlan?.steps.map((step) => step.status), ["completed", "completed"]);
  assert.equal(result.workflowPlan?.steps[1]?.note, "测试通过");
  assert.ok(result.messages.some((message) => String(message.content).includes("已完成代码修复")));
});