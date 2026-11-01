/**
 * tests/integration/routing.test.ts — 路由层端到端（mock 模式，不耗配额）
 * ============================================================
 * 守三件事：
 *  1. 默认关闭时图里不出现 route 节点（行为与引入前一致）；
 *  2. 开启后规则命中能真的把任务派给子代理，并把结论回填给主 Agent；
 *  3. 派发只授予只读工具（写操作不会被路由绕过审批）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { createWorkflowGraph, type WorkflowModels } from "../../src/agent/workflow.js";
import { resetSubagentStateForTests, replaceSubagentStateForServer } from "../../src/subagent-state.js";
import { resetRoutingStateForTests, replaceRoutingStateForServer } from "../../src/routing/state.js";
import { DEFAULT_ROUTING_LIMITS, DEFAULT_ROUTING_THRESHOLDS, type RoutingSettings } from "../../src/routing/types.js";
import type { AgentProfile } from "../../src/agent/profile.js";

function settings(patch: Partial<RoutingSettings> = {}): RoutingSettings {
  return {
    enabled: true,
    backend: "rules-only",
    llm: { providerId: null, modelId: null, temperature: 0, structuredOutput: true, maxOutputTokens: 300 },
    systemone: { baseURL: "", expectedModel: "", apiKey: "" },
    thresholds: DEFAULT_ROUTING_THRESHOLDS,
    limits: DEFAULT_ROUTING_LIMITS,
    decideTimeoutMs: 6_000,
    ...patch,
  };
}

/** 最小 profile：只要有一个只读工具即可（派发链路不依赖具体工具语义）。 */
function profile(): AgentProfile {
  return {
    id: "general",
    displayName: "测试 Agent",
    systemPrompt: "你是测试 Agent",
    tools: [],
    approvalDescriptions: {},
  };
}

/** 分析节点说「已明确」，反思节点说「通过」，主 Agent 给一句结论。 */
function models(answer = "已由子代理完成检索，共 3 个候选。"): WorkflowModels {
  const analyst = new FakeListChatModel({ responses: ['{"understood":true,"brief":"找房源","question":"","options":[]}'] });
  const agent = new FakeListChatModel({ responses: [answer] });
  const reviewer = new FakeListChatModel({ responses: ['{"passes":true,"reason":"ok","feedback":""}'] });
  return {
    analyst: analyst as unknown as WorkflowModels["analyst"],
    agent: agent as unknown as WorkflowModels["agent"],
    reviewer: reviewer as unknown as WorkflowModels["reviewer"],
  };
}

/** 假派发器：不发任何网络请求，直接返回一段「子代理已完成」的结论。 */
function fakeDispatch(text = "已按 briefing 检索：3 个候选，均价 5800/月。") {
  const calls: Array<{ agent: string; task: string; tools: string[] }> = [];
  const runner: typeof import("../../src/tools-team.js").dispatchToAgent = async (request) => {
    calls.push({
      agent: request.agent.id,
      task: request.task,
      tools: request.entries.map((entry) => entry.tool.name),
    });
    return {
      ok: true,
      text,
      durationMs: 12,
      agentId: request.agent.id,
      model: "fake-model",
      toolsUsed: request.entries.map((entry) => entry.tool.name),
    };
  };
  return { runner, calls };
}

test("默认关闭：不进入 route 节点，行为与引入前一致", async () => {
  resetRoutingStateForTests();
  resetSubagentStateForTests();
  const dispatch = fakeDispatch();
  const graph = createWorkflowGraph(profile(), models("直接回答"), {
    checkpointer: new MemorySaver(),
    dispatchRunner: dispatch.runner,
  });
  const result = await graph.invoke(
    { messages: [{ role: "user", content: "帮我租房，看看房源" }] },
    { configurable: { thread_id: "routing-disabled" }, recursionLimit: 50 },
  );
  const state = result as { routeDecision: { kind: string } | null };
  // 关闭时 route 节点直接返回 null，也不会有任何派发
  assert.equal(state.routeDecision, null);
  assert.equal(dispatch.calls.length, 0);
});

test("开启 + 规则命中：派发给 estate 并把结论回填给主 Agent", async () => {
  resetSubagentStateForTests();
  replaceRoutingStateForServer(settings());
  const dispatch = fakeDispatch();

  const graph = createWorkflowGraph(profile(), models("综合子代理结论：已找到 3 个候选房源。"), {
    checkpointer: new MemorySaver(),
    dispatchRunner: dispatch.runner,
  });
  const result = await graph.invoke(
    { messages: [{ role: "user", content: "帮我租房，看看北京朝阳的房源和小区" }] },
    { configurable: { thread_id: "routing-rule-hit" }, recursionLimit: 50 },
  );
  const state = result as {
    messages: Array<{ content: unknown; getType?: () => string }>;
    routeDecision: { kind: string; layer: string; agentId?: string } | null;
    dispatchBrief: string;
  };
  assert.ok(state.routeDecision, "应产出路由决策");
  assert.equal(state.routeDecision!.kind, "dispatch");
  assert.equal(state.routeDecision!.layer, "rule");
  assert.equal(state.routeDecision!.agentId, "estate");
  // 假派发器被调用一次，且任务稿就是用户原话
  assert.equal(dispatch.calls.length, 1);
  assert.equal(dispatch.calls[0]!.agent, "estate");
  assert.match(dispatch.calls[0]!.task, /租房/);
  // 结论作为已知事实回填
  assert.match(state.dispatchBrief, /3 个候选/);
  resetRoutingStateForTests();
  resetSubagentStateForTests();
});

test("开启 + 无关键词命中：兜底给当前 Agent，不派发", async () => {
  resetSubagentStateForTests();
  replaceRoutingStateForServer(settings());
  const dispatch = fakeDispatch();
  const graph = createWorkflowGraph(profile(), models("我自己回答"), {
    checkpointer: new MemorySaver(),
    dispatchRunner: dispatch.runner,
  });
  const result = await graph.invoke(
    { messages: [{ role: "user", content: "今天心情不错，随便聊聊" }] },
    { configurable: { thread_id: "routing-fallback" }, recursionLimit: 50 },
  );
  const state = result as { routeDecision: { kind: string } | null };
  assert.ok(state.routeDecision);
  assert.equal(state.routeDecision!.kind, "main");
  assert.equal(dispatch.calls.length, 0, "兜底时不应派发");
  resetRoutingStateForTests();
  resetSubagentStateForTests();
});

test("开启 + 无头模式：路由询问退化为当前 Agent 处理，不挂起", async () => {
  resetSubagentStateForTests();
  // 用一个不可能通过的阈值，强制模型层也弃权 → 走兜底；同时保证不进 ask
  replaceRoutingStateForServer(settings({ thresholds: { ...DEFAULT_ROUTING_THRESHOLDS, ruleAutoAccept: 1, ruleMargin: 1 } }));
  const dispatch = fakeDispatch();
  const graph = createWorkflowGraph(profile(), models("无头直接答"), {
    checkpointer: new MemorySaver(),
    dispatchRunner: dispatch.runner,
  });
  const result = await graph.invoke(
    { messages: [{ role: "user", content: "帮我租房" }] },
    { configurable: { thread_id: "routing-headless", headless: true }, recursionLimit: 50 },
  );
  const state = result as { __interrupt__?: unknown[]; routeDecision: { kind: string } | null };
  assert.equal(state.__interrupt__, undefined, "无头模式不应挂起");
  assert.ok(state.routeDecision);
  assert.notEqual(state.routeDecision!.kind, "ask");
  resetRoutingStateForTests();
  resetSubagentStateForTests();
});

test("派发只授予只读工具：带审批文案的工具不会进入子代理", async () => {
  resetSubagentStateForTests();
  replaceSubagentStateForServer([
    {
      id: "risky",
      name: "危险代理",
      description: "测试用",
      enabled: true,
      model: { mode: "inherit" },
      routing: { keywords: ["危险", "写文件", "删除"], category: "测试", suitableFor: [], notSuitableFor: [] },
      builtIn: false,
      createdAt: 0,
      updatedAt: 0,
    },
  ]);
  replaceRoutingStateForServer(settings());
  const dispatch = fakeDispatch("done");
  // 用一个真实的、已登记审批的工具做「写操作」代表；它同时也是 profile.tools 的成员，
  // 满足「审批项必须绑定工具」的装配约束。
  const writeTool = {
    name: "write_file",
    description: "写文件（测试用）",
    schema: undefined,
    invoke: async () => "written",
  } as unknown as AgentProfile["tools"][number];
  const riskyProfile: AgentProfile = {
    ...profile(),
    tools: [writeTool],
    approvalDescriptions: { write_file: () => "写入文件" },
  };
  const graph = createWorkflowGraph(riskyProfile, models("done"), {
    checkpointer: new MemorySaver(),
    dispatchRunner: dispatch.runner,
  });
  await graph.invoke(
    { messages: [{ role: "user", content: "危险操作：帮我写文件" }] },
    { configurable: { thread_id: "routing-readonly" }, recursionLimit: 50 },
  );
  assert.equal(dispatch.calls.length, 1);
  // 关键断言：审批登记的 write_file 没有被下放给子代理。
  // （house_* 这类只读工具会被自动补进目录，这是预期行为。）
  assert.ok(
    !dispatch.calls[0]!.tools.includes("write_file"),
    `高风险工具不应被路由下放，实际工具集：${dispatch.calls[0]!.tools.join("、")}`,
  );
  resetRoutingStateForTests();
  resetSubagentStateForTests();
});

test("超出范围：子代理报 outOfScope 后最多再路由一次，然后交主 Agent", async () => {
  resetSubagentStateForTests();
  replaceRoutingStateForServer(settings({ limits: { ...DEFAULT_ROUTING_LIMITS, maxHandoffs: 1 } }));
  let round = 0;
  const calls: string[] = [];
  const runner: typeof import("../../src/tools-team.js").dispatchToAgent = async (request) => {
    round += 1;
    calls.push(request.agent.id);
    return {
      ok: true,
      text: round === 1
        ? "房源检索完成。\n\n【超出范围】该问题需要天气数据，本代理无此工具。"
        : "补充完成。",
      durationMs: 5,
      agentId: request.agent.id,
      model: "fake-model",
      toolsUsed: [],
    };
  };
  const graph = createWorkflowGraph(profile(), models("最终回答"), {
    checkpointer: new MemorySaver(),
    dispatchRunner: runner,
  });
  const result = await graph.invoke(
    { messages: [{ role: "user", content: "帮我租房，顺便看看房源和小区" }] },
    { configurable: { thread_id: "routing-handoff" }, recursionLimit: 50 },
  );
  const state = result as { handoffCount: number; routeHistory: string[]; dispatchBrief: string };
  // 第二次路由会排除已试过的 estate → 没有候选 → 兜底给主 Agent
  assert.ok(state.handoffCount <= 1, `转回次数不得超过 1，实际 ${state.handoffCount}`);
  assert.ok(calls.length <= 2, `派发次数不得超过 2，实际 ${calls.length}`);
  assert.match(state.dispatchBrief, /超出范围/);
  resetRoutingStateForTests();
  resetSubagentStateForTests();
});
