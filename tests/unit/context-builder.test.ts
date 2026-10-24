/**
 * context-builder.test.ts — 模型上下文投影的确定性预算测试
 * ============================================================
 * 守住：工具结果只投影裁剪、原消息不被改写、最近窗口不切断 tool call/result 配对。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { buildAgentContext, resolveContextPolicy } from "../../src/agent/context-builder.js";
import type { AgentProfile } from "../../src/agent/profile.js";

function profile(policy?: AgentProfile["contextPolicy"]): AgentProfile {
  return {
    id: "general",
    displayName: "上下文测试 Agent",
    systemPrompt: "系统提示",
    tools: [],
    approvalDescriptions: {},
    contextPolicy: policy,
  };
}

test("上下文策略有安全默认值，并采用 profile 覆盖", () => {
  assert.equal(resolveContextPolicy(profile()).maxRecentMessages, 32);
  assert.equal(resolveContextPolicy(profile({ maxRecentMessages: 4, maxToolResultChars: 300 })).maxRecentMessages, 4);
});

test("超长工具结果按 profile 预算裁剪，原 ToolMessage 不变", () => {
  const original = "HEAD-" + "x".repeat(500) + "-TAIL";
  const tool = new ToolMessage({
    content: original,
    tool_call_id: "call-1",
    name: "grep_search",
    status: "success",
  });
  const built = buildAgentContext({
    profile: profile({ maxRecentMessages: 8, maxToolResultChars: 300 }),
    messages: [new HumanMessage("查一下"), tool],
  });

  const projected = built.messages.find((message) => message instanceof ToolMessage) as ToolMessage;
  assert.ok(projected instanceof ToolMessage);
  assert.equal(tool.content, original);
  assert.ok(String(projected.content).length <= 300);
  assert.match(String(projected.content), /HEAD-/);
  assert.doesNotMatch(String(projected.content), /-TAIL/);
  assert.equal(built.truncatedToolResults, 1);
});

test("terminal 结果优先保留尾部，便于保留真实错误", () => {
  const tool = new ToolMessage({
    content: "OLD-OUTPUT-" + "x".repeat(500) + "-FINAL-ERROR",
    tool_call_id: "call-2",
    name: "terminal",
    status: "error",
  });
  const built = buildAgentContext({
    profile: profile({ maxRecentMessages: 8, maxToolResultChars: 300 }),
    messages: [tool],
  });
  const projected = built.messages.find((message) => message instanceof ToolMessage) as ToolMessage;
  assert.match(String(projected.content), /FINAL-ERROR/);
  assert.doesNotMatch(String(projected.content), /OLD-OUTPUT-/);
});

test("最近消息窗口不从 ToolMessage 中间切断工具调用对", () => {
  const ai = new AIMessage({
    content: "",
    tool_calls: [{ name: "get_current_time", args: {}, id: "call-3" }],
  });
  const tool = new ToolMessage({ content: "12:00", tool_call_id: "call-3", name: "get_current_time" });
  const built = buildAgentContext({
    profile: profile({ maxRecentMessages: 2, maxToolResultChars: 300 }),
    messages: [
      new HumanMessage("旧消息"),
      ai,
      tool,
      new AIMessage("现在 12 点"),
    ],
  });

  assert.equal(built.omittedMessages, 1);
  assert.ok(built.messages.some((message) => message === ai || message instanceof AIMessage && message.tool_calls?.length));
  assert.ok(built.messages.some((message) => message instanceof ToolMessage));
  assert.match(String(built.messages[1].content), /已省略较早的 1 条消息/);
});

test("需求 brief、澄清和反思注记进入 system 上下文，不混入用户消息", () => {
  const built = buildAgentContext({
    profile: profile(),
    messages: [new HumanMessage("继续")],
    requirementBrief: "只分析项目结构",
    clarificationHistory: "不修改任何文件",
    reviewFeedback: "补充风险说明",
  });

  assert.match(String(built.messages[1].content), /需求理解/);
  assert.match(String(built.messages[1].content), /历史澄清/);
  assert.match(String(built.messages[1].content), /上一轮反思反馈/);
});

test("回炉投影：反思反馈存在时末尾草稿并入注记，请求以 HumanMessage 结尾", () => {
  const built = buildAgentContext({
    profile: profile(),
    messages: [
      new HumanMessage("介绍你自己"),
      new AIMessage("第一版回答"),
    ],
    reviewFeedback: "补充能力说明",
  });

  const notes = String(built.messages[1].content);
  assert.match(notes, /上一轮草稿/);
  assert.match(notes, /第一版回答/);
  assert.match(notes, /上一轮反思反馈/);
  // 草稿被移出消息列表：末尾必须是 HumanMessage（思考型网关要求末条 assistant 带
  // reasoning_content，@langchain/openai 序列化会丢弃 → 400）
  const last = built.messages[built.messages.length - 1];
  assert.equal(last.getType(), "human");
});

test("无反思反馈时末尾 AIMessage 保持在消息列表（正常轮不误伤）", () => {
  const built = buildAgentContext({
    profile: profile(),
    messages: [
      new HumanMessage("介绍你自己"),
      new AIMessage("正常回答"),
    ],
  });
  const last = built.messages[built.messages.length - 1];
  assert.equal(last.getType(), "ai");
});

test("二次回炉：连续多版草稿全部移出消息列表，注记保留最新一版", () => {
  const built = buildAgentContext({
    profile: profile(),
    messages: [
      new HumanMessage("介绍你自己"),
      new AIMessage("第一版回答"),
      new AIMessage("第二版回答（更新）"),
    ],
    reviewFeedback: "还是不够好",
  });

  const notes = String(built.messages[1].content);
  assert.match(notes, /第二版回答（更新）/);
  assert.doesNotMatch(notes, /第一版回答/);
  // 连续草稿全部弹出：末尾回到 HumanMessage
  const last = built.messages[built.messages.length - 1];
  assert.equal(last.getType(), "human");
  assert.equal(built.messages.filter((m) => m.getType() === "ai").length, 0);
});
