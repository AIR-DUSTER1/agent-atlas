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
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { runSubagent, subagentProfileOf, DELEGATE_TOOL_NAME } from "../../src/agent/subagent.js";
import { generalProfile } from "../../src/agent/general.js";
import { createTeamTools } from "../../src/tools-team.js";
import { buildDelegationCatalog } from "../../src/delegation-catalog.js";
import { defaultModelRuntime } from "../../src/model-runtime.js";
import { resetSubagentStateForTests } from "../../src/subagent-state.js";
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
    models: {
      agent: fixedModel("这是一个 LangGraph.js 学习项目。"),
      analyst: fixedModel(ANALYSIS_OK),
      reviewer: fixedModel(REVIEW_OK),
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /LangGraph\.js 学习项目/);
  assert.equal(result.agentId, "general");
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
    models: {
      agent: fake as unknown as WorkflowChatModel,
      analyst: fake as unknown as WorkflowChatModel,
      reviewer: fake as unknown as WorkflowChatModel,
    },
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
    models: {
      agent: broken,
      analyst: fixedModel(ANALYSIS_OK),
      reviewer: fixedModel(REVIEW_OK),
    },
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
  assert.match(sub.analystGuidance ?? "", /工具|权限/);
});

test("general profile 的委派工具与审批文案已登记", () => {
  assert.ok(generalProfile.tools.some((item) => item.name === DELEGATE_TOOL_NAME));
  const describe = generalProfile.approvalDescriptions?.[DELEGATE_TOOL_NAME];
  assert.ok(describe);
  const text = describe({ agent: "general", task: "分析代码", prompt: "只做审查", tools: ["read_file"] });
  assert.match(text, /general/);
  assert.match(text, /read_file/);
  assert.match(text, /只做审查/);
});


test("动态委派：主 Agent 赋予的专项提示词与工具子集真实进入子 Profile", async () => {
  resetSubagentStateForTests();
  const parentRuntime = { ...defaultModelRuntime(), label: "父图冻结模型-Test" };
  try {
    const readTool = tool(async () => "file-content", {
      name: "read_file",
      description: "读取授权文件",
      schema: z.object({ path: z.string() }),
    });
    const catalog = buildDelegationCatalog({
      parentTools: [readTool],
      parentApprovals: { read_file: (args) => `读取 ${String(args.path)}` },
    });
    let capturedPrompt = "";
    let capturedTools: string[] = [];
    let capturedModel = "";
    const [delegate] = createTeamTools(catalog, {
      parentModelRuntime: parentRuntime,
      run: async (profile, task, options) => {
        capturedPrompt = profile.systemPrompt;
        capturedTools = profile.tools.map((item) => item.name);
        capturedModel = options.modelRuntime?.label ?? "";
        return {
          ok: true,
          text: `完成：${task}`,
          durationMs: 12,
          agentId: profile.id,
          model: options.modelRuntime?.label ?? "",
          toolsUsed: ["read_file"],
        };
      },
    });
    assert.ok(delegate);
    const raw = await delegate.invoke({
      agent: "general",
      task: "分析 README",
      prompt: "你是只做事实核验的审查员，不要修改文件。",
      tools: ["read_file"],
    });
    const payload = JSON.parse(String(raw)) as { ok: boolean; agent: string; assignedTools: string[] };
    assert.equal(payload.ok, true);
    assert.equal(payload.agent, "general");
    assert.deepEqual(payload.assignedTools, ["read_file"]);
    assert.match(capturedPrompt, /事实核验/);
    assert.deepEqual(capturedTools, ["read_file"]);
    assert.equal(capturedModel, "父图冻结模型-Test");
  } finally {
    resetSubagentStateForTests();
  }
});

test("动态委派拒绝目录外工具，不启动子 Agent", async () => {
  resetSubagentStateForTests();
  let runs = 0;
  const catalog = buildDelegationCatalog({
    parentTools: [],
    parentApprovals: {},
  });
  const [delegate] = createTeamTools(catalog, {
    run: async (profile) => {
      runs += 1;
      return {
        ok: true, text: "不应执行", durationMs: 0, agentId: profile.id, model: "test", toolsUsed: [],
      };
    },
  });
  assert.ok(delegate);
  const raw = await delegate.invoke({
    agent: "general",
    task: "测试",
    prompt: "测试",
    tools: ["write_file"],
  });
  assert.match(String(raw), /不在当前可分配目录/);
  assert.equal(runs, 0);
  resetSubagentStateForTests();
});


test("父请求取消信号透传到子 Agent 模型调用", async () => {
  const controller = new AbortController();
  let started = false;
  const waiting: WorkflowChatModel = {
    invoke: async (_input, options) => {
      started = true;
      return await new Promise<AIMessage>((_resolve, reject) => {
        const abort = () => reject(new Error("aborted by parent"));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const running = runSubagent(TEST_PROFILE, "长任务", {
    models: { agent: waiting, analyst: waiting, reviewer: waiting },
    signal: controller.signal,
  });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const result = await running;
  assert.equal(result.ok, false);
  assert.match(result.text, /取消/);
});
