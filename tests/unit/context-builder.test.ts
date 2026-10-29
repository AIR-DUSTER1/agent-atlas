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
import { createContextWindowBudget, estimateTextTokens } from "../../src/context-window.js";

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
  assert.equal(resolveContextPolicy(profile()).maxRecentMessages, 10_000);
  assert.equal(resolveContextPolicy(profile({ maxRecentMessages: 4, maxToolResultChars: 300 })).maxRecentMessages, 4);
  assert.ok(resolveContextPolicy(profile()).maxContextChars > 0);
});

test("token 预算生效：最近消息再长也不能无限膨胀", () => {
  const built = buildAgentContext({
    profile: profile({ maxRecentMessages: 8, maxToolResultChars: 8_000, maxContextChars: 1_000 }),
    contextWindow: 32_000,
    messages: [
      new HumanMessage("旧消息"),
      new HumanMessage("x".repeat(100_000)),
      new HumanMessage("最新消息"),
    ],
  });
  assert.ok(built.omittedMessages >= 1);
  assert.match(String(built.messages[1].content), /已省略较早的/);
});

test("超预算的最新用户消息仍必须保留", () => {
  const built = buildAgentContext({
    profile: profile({ maxRecentMessages: 8, maxToolResultChars: 8_000, maxContextChars: 1_000 }),
    contextWindow: 8_192,
    messages: [
      new HumanMessage("旧消息"),
      new HumanMessage("当前请求：" + "x".repeat(2_000)),
    ],
  });
  // 当前请求本身就是最新消息，绝不能因体积被裁掉；旧消息是否同级保留由
  // 上面的“总字符预算”用例负责验证。
  assert.match(String(built.messages.at(-1)?.content), /当前请求/);
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


test("历史大图投影为文字占位，当前轮刚附加的图片保留", () => {
  const big = "data:image/png;base64," + "A".repeat(10_000);
  const history = new HumanMessage({
    content: [
      { type: "text", text: "历史图片" },
      { type: "image_url", image_url: { url: big } },
    ],
  });
  const current = new HumanMessage({
    content: [
      { type: "text", text: "当前图片" },
      { type: "image_url", image_url: { url: big } },
    ],
  });
  const built = buildAgentContext({
    profile: profile({ maxRecentMessages: 8, maxToolResultChars: 8_000, maxContextChars: 200_000 }),
    messages: [history, current],
  });
  assert.match(JSON.stringify(history.content), /data:image\/png;base64/);
  assert.match(JSON.stringify(current.content), /data:image\/png;base64/);
  const serialized = JSON.stringify(built.messages);
  assert.match(serialized, /历史图片已省略/);
  assert.match(serialized, /当前图片/);
  assert.equal((serialized.match(/data:image\/png;base64/g) ?? []).length, 1, "只保留最近一条 HumanMessage 的图片");
});

test("任务台账与预算注记进入 system，不混入用户正文", () => {
  const built = buildAgentContext({
    profile: profile(),
    messages: [new HumanMessage("继续")],
    taskLedger: "【任务台账】已读 sessions.ts",
    budgetNote: "已用工具 3/30",
  });
  const notes = String(built.messages[1].content);
  assert.match(notes, /已读 sessions\.ts/);
  assert.match(notes, /已用工具 3\/30/);
});


test("窗口预算：输出预留、安全余量与输入预算来自同一计算口径", () => {
  const small = createContextWindowBudget(32_000);
  assert.equal(small.contextWindow, 32_000);
  assert.equal(small.outputReserveTokens, 8_000);
  assert.equal(small.safetyMarginTokens, 1_600);
  assert.equal(small.inputBudgetTokens, 22_400);
  const large = createContextWindowBudget(1_000_000);
  assert.equal(large.outputReserveTokens, 8_192);
  assert.equal(large.safetyMarginTokens, 32_768);
  assert.equal(large.inputBudgetTokens, 959_040);
});

test("token 估算对中文保守、对 ASCII 约 4 字符/token", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("中文"), 2);
  assert.ok(estimateTextTokens("中a") >= 2);
});

test("更大的模型窗口会装入更多历史，不再卡在固定字符数", () => {
  const messages = Array.from({ length: 400 }, (_, index) => new HumanMessage(`第${index}轮：` + "x".repeat(600)));
  const small = buildAgentContext({ profile: profile(), messages, contextWindow: 32_000 });
  const large = buildAgentContext({ profile: profile(), messages, contextWindow: 200_000 });
  assert.ok(large.messages.length > small.messages.length, "窗口越大应装入越多历史");
  const latestTokens = estimateTextTokens(String(messages.at(-1)?.content));
  assert.ok(large.estimatedInputTokens <= large.budget.inputBudgetTokens + latestTokens);
});


test("窗口溢出时旧历史压成受预算约束的摘要，而不是静默消失", () => {
  const messages = [
    new HumanMessage("很早以前：项目根目录是 D:/code/agent"),
    new AIMessage("收到，后续修改都基于该目录。"),
    new HumanMessage("x".repeat(200_000)),
    new HumanMessage("最新问题"),
  ];
  const built = buildAgentContext({ profile: profile(), messages, contextWindow: 32_000 });
  assert.ok(built.omittedMessages >= 1);
  const notes = String(built.messages[1].content);
  assert.match(notes, /较早对话摘要/);
  assert.match(notes, /D:\/code\/agent/);
  assert.ok(built.estimatedInputTokens <= built.budget.inputBudgetTokens + estimateTextTokens("x".repeat(200_000)), "摘要不应让预算失控");
});
