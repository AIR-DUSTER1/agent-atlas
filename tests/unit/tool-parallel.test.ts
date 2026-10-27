/**
 * tool-parallel.test.ts — 工具批量并发执行（F8 阶段 2）
 * ============================================================
 * 守三条：
 *   1. 无需审批的工具在同一轮里**并发**执行（总耗时接近最慢的那个，不是累加）；
 *   2. 结果顺序仍按模型发起的 tool_calls 顺序回填（模型读起来才连贯）；
 *   3. 审批类工具保持串行（一次只弹一张卡），且不影响并发批次的结果。
 */
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { test } from "node:test";
import { z } from "zod";
import { createApprovalToolsNode } from "../../src/agent/hitl.js";

/** 造一个睡固定时长再返回的假工具 */
function sleepyTool(name: string, ms: number) {
  return tool(
    async ({ tag }) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${name}:${tag}`;
    },
    {
      name,
      description: `测试工具 ${name}`,
      schema: z.object({ tag: z.string() }),
    }
  );
}

/** 组装一次工具节点调用（3 个 tool_call，全是可直接执行的只读工具） */
function makeState(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
  return {
    messages: [
      new HumanMessage("并行测试"),
      new AIMessage({
        content: "",
        tool_calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args, type: "tool_call" as const })),
      }),
    ],
  };
}

test("无需审批的多个工具并发执行：总耗时接近最慢的单个，而不是累加", async () => {
  const slow = sleepyTool("slow_tool", 300);
  const slow2 = sleepyTool("slow_tool2", 300);
  const slow3 = sleepyTool("slow_tool3", 300);
  const node = createApprovalToolsNode({
    tools: [slow, slow2, slow3],
    approvalDescriptions: {}, // 空 = 全部直接执行
    profileId: "general",
  });

  const started = Date.now();
  const result = await node(
    makeState([
      { id: "c1", name: "slow_tool", args: { tag: "a" } },
      { id: "c2", name: "slow_tool2", args: { tag: "b" } },
      { id: "c3", name: "slow_tool3", args: { tag: "c" } },
    ]) as never
  );
  const elapsed = Date.now() - started;

  // 串行会是 900ms+；并发应接近 300~500ms。给足 CI 抖动余量但仍能区分。
  assert.ok(elapsed < 700, `应并发执行（实际 ${elapsed}ms，串行约 900ms）`);
  assert.equal(result.messages.length, 3);
});

test("结果顺序与模型发起的 tool_calls 顺序一致（并发不改变顺序）", async () => {
  // 故意让「先发起的工具更慢」——若按完成顺序回填，结果顺序会被打乱
  const slowFirst = sleepyTool("first_slow", 250);
  const fastSecond = sleepyTool("second_fast", 20);
  const node = createApprovalToolsNode({
    tools: [slowFirst, fastSecond],
    approvalDescriptions: {},
    profileId: "general",
  });

  const result = await node(
    makeState([
      { id: "c1", name: "first_slow", args: { tag: "1" } },
      { id: "c2", name: "second_fast", args: { tag: "2" } },
    ]) as never
  );

  const messages = result.messages as ToolMessage[];
  assert.equal(messages.length, 2);
  assert.equal(messages[0].tool_call_id, "c1", "第一个结果应属于第一个 tool_call");
  assert.equal(messages[0].name, "first_slow");
  assert.equal(messages[1].tool_call_id, "c2", "第二个结果应属于第二个 tool_call");
  assert.equal(messages[1].name, "second_fast");
});

test("登记审批的工具不被塞进并发批次（走 interrupt，一次一张卡）", async () => {
  const readTool = sleepyTool("read_only", 10);
  const writeTool = sleepyTool("needs_approval", 10);
  let approvalsShown = 0;
  const node = createApprovalToolsNode({
    tools: [readTool, writeTool],
    approvalDescriptions: {
      needs_approval: () => { approvalsShown += 1; return "会改世界的操作"; },
    },
    profileId: "general",
  });

  // 只发一个调用：审批工具必须走 interrupt —— 在图外直接调节点时，
  // interrupt() 会抛「outside the context of a graph」，这正是「没被并入
  // 并发批次直接执行」的证据。若它被误并入批处理，这里会正常返回结果。
  await assert.rejects(
    () => node(makeState([{ id: "c1", name: "needs_approval", args: { tag: "x" } }]) as never),
    /interrupt\(\) outside|outside the context of a graph/,
    "审批工具必须走 interrupt，不能被当作可直接执行的工具并发跑掉"
  );
});

test("只读权限下 deny 的调用也走批处理，且返回模型可读的拒绝文案", async () => {
  const writeTool = sleepyTool("write_file", 10);
  const node = createApprovalToolsNode({
    tools: [writeTool],
    approvalDescriptions: { write_file: () => "写文件" },
    profileId: "general",
  });

  const result = await node(
    makeState([{ id: "c1", name: "write_file", args: { tag: "x" } }]) as never,
    { configurable: { permission_mode: "readonly" } }
  );
  const messages = result.messages as ToolMessage[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, "error");
  assert.match(String(messages[0].content), /只读/);
});

test("重复相同工具调用复用本轮结果，不再次执行", async () => {
  let runs = 0;
  const echo = tool(
    async ({ tag }) => { runs += 1; return `echo:${tag}`; },
    { name: "echo_tool", description: "重复调用测试", schema: z.object({ tag: z.string() }) }
  );
  const node = createApprovalToolsNode({ tools: [echo], approvalDescriptions: {}, profileId: "general" });
  const first = await node(makeState([{ id: "dup-1", name: "echo_tool", args: { tag: "same" } }]) as never);
  const firstResult = first.messages[0] as ToolMessage;
  const second = await node({
    messages: [
      new HumanMessage("重复调用测试"),
      new AIMessage({ content: "", tool_calls: [{ id: "dup-1", name: "echo_tool", args: { tag: "same" }, type: "tool_call" }] }),
      firstResult,
      new AIMessage({ content: "", tool_calls: [{ id: "dup-2", name: "echo_tool", args: { tag: "same" }, type: "tool_call" }] }),
    ],
  } as never);
  assert.equal(runs, 1, "相同参数的工具只能执行一次");
  assert.match(String((second.messages[0] as ToolMessage).content), /复用本轮上一次/);
});

test("自主审批重复调用命中去重，不再重复调用风险评估模型", async () => {
  let executions = 0;
  let assessments = 0;
  const writeish = tool(
    async ({ path }) => { executions += 1; return `wrote:${path}`; },
    { name: "writeish", description: "自主审批测试", schema: z.object({ path: z.string() }) }
  );
  const node = createApprovalToolsNode({
    tools: [writeish],
    approvalDescriptions: { writeish: () => "可能修改文件" },
    profileId: "general",
    riskAssessor: async () => {
      assessments += 1;
      return { highRisk: false, reason: "仅项目内文件" };
    },
  });
  const state1 = makeState([{ id: "risk-1", name: "writeish", args: { path: "a.txt" } }]);
  const first = await node(state1 as never, { configurable: { permission_mode: "autonomous", thread_id: "t-risk" } });
  const second = await node({
    messages: [
      new HumanMessage("自主审批测试"),
      new AIMessage({ content: "", tool_calls: [{ id: "risk-1", name: "writeish", args: { path: "a.txt" }, type: "tool_call" }] }),
      first.messages[0],
      new AIMessage({ content: "", tool_calls: [{ id: "risk-2", name: "writeish", args: { path: "a.txt" }, type: "tool_call" }] }),
    ],
  } as never, { configurable: { permission_mode: "autonomous", thread_id: "t-risk" } });
  assert.equal(executions, 1);
  assert.equal(assessments, 1, "相同意图与参数的重复调用不应重复风险评估");
  assert.match(String((second.messages[0] as ToolMessage).content), /复用本轮上一次/);
});