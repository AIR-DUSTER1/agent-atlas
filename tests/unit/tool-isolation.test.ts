/**
 * tool-isolation.test.ts — Agent profile 工具隔离 / 审批边界回归
 * ============================================================
 * 守三条语义：
 *   1. profile.tools 是唯一 allowlist，模型伪造跨域工具时 fail-closed；
 *   2. 审批只在当前 profile 登记的工具上触发，不依赖全局工具表；
 *   3. tools.ts 不再把开发工具与房产工具拼成一个全局注册表。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { calculator } from "../../src/tools.js";
import { generalProfile } from "../../src/agent/general.js";
import { estateProfile } from "../../src/agent/estate.js";
import { createApprovalToolsNode } from "../../src/agent/hitl.js";
import { createWorkflowGraph, type WorkflowChatModel } from "../../src/agent/workflow.js";

const ANALYSIS = JSON.stringify({
  understood: true,
  brief: "测试需求",
  question: "",
  options: [],
});
const REVIEW = JSON.stringify({ passes: true, reason: "满足需求", feedback: "" });

function fixedModel(content: string): WorkflowChatModel {
  return { invoke: async () => new AIMessage(content) };
}

function scriptedAgent(responses: AIMessage[]): WorkflowChatModel {
  let index = 0;
  return {
    invoke: async () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
}

function models(agent: WorkflowChatModel) {
  return { agent, analyst: fixedModel(ANALYSIS), reviewer: fixedModel(REVIEW) };
}

function toolCall(name: string, args: Record<string, unknown>): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: `call-${name}` }],
  });
}

type GraphResult = {
  messages: Array<{ content: unknown; getType?: () => string }>;
  __interrupt__?: Array<{ value: { type?: string; toolName?: string } }>;
};

test("profile 工具集互不越界，审批项都包含在各自 allowlist 内", () => {
  const generalNames = generalProfile.tools.map((tool) => tool.name);
  const estateNames = estateProfile.tools.map((tool) => tool.name);

  assert.ok(!generalNames.includes("house_search"));
  assert.ok(!generalNames.includes("house_appoint"));
  assert.ok(!estateNames.includes("terminal"));
  assert.ok(!estateNames.includes("write_file"));
  assert.ok(!estateNames.includes("send_email"));
  assert.ok(!estateNames.includes("retrieve_docs"));

  for (const name of Object.keys(generalProfile.approvalDescriptions)) {
    assert.ok(generalNames.includes(name), `通用审批项缺少工具：${name}`);
  }
  for (const name of Object.keys(estateProfile.approvalDescriptions)) {
    assert.ok(estateNames.includes(name), `房产审批项缺少工具：${name}`);
  }
});

test("通用 Agent 图拒绝伪造的房产工具调用，不执行也不中断", async () => {
  const graph = createWorkflowGraph(generalProfile, models(scriptedAgent([
    toolCall("house_search", { query: "北京" }),
    new AIMessage("当前 Agent 不支持该操作。"),
  ])));
  const result = await graph.invoke(
    { messages: [new HumanMessage("帮我找房")] },
    { configurable: { thread_id: "isolation-general" } }
  ) as unknown as GraphResult;

  const rejected = result.messages.find((message) => message.getType?.() === "tool");
  assert.ok(rejected instanceof ToolMessage);
  assert.match(String(rejected.content), /当前 Agent 不支持工具「house_search」/);
  assert.equal(rejected.status, "error");
  assert.equal(result.__interrupt__, undefined);
});

test("房产 Agent 图拒绝伪造的开发工具调用，不执行也不中断", async () => {
  const graph = createWorkflowGraph(estateProfile, models(scriptedAgent([
    toolCall("terminal", { command: "echo hacked" }),
    new AIMessage("当前 Agent 不支持该操作。"),
  ])));
  const result = await graph.invoke(
    { messages: [new HumanMessage("执行命令")] },
    { configurable: { thread_id: "isolation-estate" } }
  ) as unknown as GraphResult;

  const rejected = result.messages.find((message) => message.getType?.() === "tool");
  assert.ok(rejected instanceof ToolMessage);
  assert.match(String(rejected.content), /当前 Agent 不支持工具「terminal」/);
  assert.equal(rejected.status, "error");
  assert.equal(result.__interrupt__, undefined);
});

test("房产 Agent 图拒绝伪造的 write_file 调用，不执行也不中断", async () => {
  const graph = createWorkflowGraph(estateProfile, models(scriptedAgent([
    toolCall("write_file", { path: "hacked.txt", content: "x" }),
    new AIMessage("当前 Agent 不支持该操作。"),
  ])));
  const result = await graph.invoke(
    { messages: [new HumanMessage("写一个文件")] },
    { configurable: { thread_id: "isolation-estate-write" } }
  ) as unknown as GraphResult;

  const rejected = result.messages.find((message) => message.getType?.() === "tool");
  assert.ok(rejected instanceof ToolMessage);
  assert.match(String(rejected.content), /当前 Agent 不支持工具「write_file」/);
  assert.equal(rejected.status, "error");
  assert.equal(result.__interrupt__, undefined);
});

test("通用 Agent 的 terminal 进入审批，停在工具执行之前", async () => {
  const graph = createWorkflowGraph(generalProfile, models(scriptedAgent([
    toolCall("terminal", { command: "echo hi" }),
  ])));
  const result = await graph.invoke(
    { messages: [new HumanMessage("执行 echo")] },
    { configurable: { thread_id: "approval-general" } }
  ) as unknown as GraphResult;

  assert.equal(result.__interrupt__?.[0]?.value.type, "approval");
  assert.equal(result.__interrupt__?.[0]?.value.toolName, "terminal");
});

test("房产 Agent 的 house_appoint 进入审批，停在工具执行之前", async () => {
  const graph = createWorkflowGraph(estateProfile, models(scriptedAgent([
    toolCall("house_appoint", {
      houseId: "H-1",
      date: "2026-10-24",
      start: "10",
      end: "12",
    }),
  ])));
  const result = await graph.invoke(
    { messages: [new HumanMessage("帮我预约看房")] },
    { configurable: { thread_id: "approval-estate" } }
  ) as unknown as GraphResult;

  assert.equal(result.__interrupt__?.[0]?.value.type, "approval");
  assert.equal(result.__interrupt__?.[0]?.value.toolName, "house_appoint");
});

test("同名工具在装配期直接失败，避免静默覆盖", () => {
  const duplicate = [calculator, calculator] as StructuredToolInterface[];
  assert.throws(
    () => createApprovalToolsNode({ tools: duplicate, approvalDescriptions: {} }),
    /Agent 工具名重复：calculator/
  );
});

test("审批项未绑定当前 profile 工具时在装配期直接失败", () => {
  assert.throws(
    () => createApprovalToolsNode({
      tools: [calculator],
      approvalDescriptions: {
        terminal: (args) => `执行 ${String(args.command)}`,
      },
    }),
    /Agent 审批项未绑定工具：terminal/
  );
});

test("源码层不再存在跨域全局工具表", async () => {
  const toolsSource = await readFile(new URL("../../src/tools.ts", import.meta.url), "utf8");
  const hitlSource = await readFile(new URL("../../src/agent/hitl.ts", import.meta.url), "utf8");
  const generalSource = await readFile(new URL("../../src/agent/general.ts", import.meta.url), "utf8");
  const estateSource = await readFile(new URL("../../src/agent/estate.ts", import.meta.url), "utf8");

  assert.doesNotMatch(toolsSource, /toolsByName|tools-dev|tools-estate/);
  assert.doesNotMatch(hitlSource, /toolsByName|APPROVAL_TOOLS/);
  assert.doesNotMatch(generalSource, /estate\.js|tools-estate|house_(search|appoint|contact)/);
  assert.doesNotMatch(estateSource, /tools-dev|tools-rag|retrieveDocs|sendEmail/);
});
