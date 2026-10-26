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
