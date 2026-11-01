/**
 * reasoning-passthrough.test.ts — 思考型网关的 reasoning_content 回传
 * ============================================================
 * 覆盖三件事（全部走 mock fetch，零真实调用）：
 *   1. patchReasoningPayload 只在能精确匹配时补字段，且不重复补；
 *   2. 端到端：入站思考 → rememberHistoryReasoning → 出站请求体带字段；
 *   3. 兜底：网关反过来拒绝该字段时，重试关闭回传并成功。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  clearReasoningRecords, disableReasoningPassthrough, patchReasoningPayload,
  rememberHistoryReasoning, reasoningPassthroughEnabled,
} from "../../src/reasoning-passthrough.js";
import { invokeWithModelRetry } from "../../src/model-retry.js";
import { config } from "../../src/config.js";

const SESSION = "passthrough-test";

function assistantPayload(content: string, toolCallIds: string[] = []): string {
  return JSON.stringify({
    model: "m",
    messages: [
      { role: "user", content: "帮我算 17×23" },
      {
        role: "assistant",
        content,
        ...(toolCallIds.length
          ? { tool_calls: toolCallIds.map((id) => ({ id, type: "function", function: { name: "calculator", arguments: "{}" } })) }
          : {}),
      },
    ],
  });
}

test("回传：只给匹配到的 assistant 补 reasoning_content", () => {
  clearReasoningRecords(SESSION);
  rememberHistoryReasoning(SESSION, [
    new HumanMessage("帮我算 17×23"),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call_abc", name: "calculator", args: {} }],
      additional_kwargs: { reasoning_content: "需要先调用计算器" },
    }),
  ]);

  const patched = JSON.parse(patchReasoningPayload(assistantPayload("", ["call_abc"]), SESSION)) as {
    messages: Array<{ role: string; reasoning_content?: string }>;
  };
  assert.equal(patched.messages[1]?.reasoning_content, "需要先调用计算器");

  // 已有字段时不重复写（幂等）
  assert.equal(patchReasoningPayload(JSON.stringify(patched), SESSION), JSON.stringify(patched));
  clearReasoningRecords(SESSION);
});

test("回传：没有记录 / 正文对不上时请求体原样不动", () => {
  clearReasoningRecords(SESSION);
  const body = assistantPayload("随便聊聊");
  assert.equal(patchReasoningPayload(body, SESSION), body, "无记录时零改动");

  rememberHistoryReasoning(SESSION, [
    new AIMessage({ content: "完全不同的回答", additional_kwargs: { reasoning_content: "思考" } }),
  ]);
  assert.equal(patchReasoningPayload(body, SESSION), body, "正文不匹配时不补字段");
  clearReasoningRecords(SESSION);
});

test("回传：tool_call id 优先于正文匹配", () => {
  clearReasoningRecords(SESSION);
  rememberHistoryReasoning(SESSION, [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call_A", name: "calculator", args: {} }],
      additional_kwargs: { reasoning_content: "A 的思考" },
    }),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call_B", name: "calculator", args: {} }],
      additional_kwargs: { reasoning_content: "B 的思考" },
    }),
  ]);
  const patched = JSON.parse(patchReasoningPayload(assistantPayload("", ["call_B"]), SESSION)) as {
    messages: Array<{ reasoning_content?: string }>;
  };
  assert.equal(patched.messages[1]?.reasoning_content, "B 的思考");
  clearReasoningRecords(SESSION);
});

test("回传：关闭后不再补字段（网关拒绝该字段时的兜底状态）", () => {
  clearReasoningRecords(SESSION);
  rememberHistoryReasoning(SESSION, [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call_x", name: "calculator", args: {} }],
      additional_kwargs: { reasoning_content: "思考" },
    }),
  ]);
  const body = assistantPayload("", ["call_x"]);
  assert.notEqual(patchReasoningPayload(body, SESSION), body);
  disableReasoningPassthrough(SESSION);
  assert.equal(reasoningPassthroughEnabled(SESSION), false);
  assert.equal(patchReasoningPayload(body, SESSION), body);
  clearReasoningRecords(SESSION);
});

test("兜底：400 点名 reasoning_content 时关闭回传并重试成功", async () => {
  const original = config.modelRequestRetries;
  config.modelRequestRetries = 1;
  clearReasoningRecords("retry-session");
  let calls = 0;
  try {
    const result = await invokeWithModelRetry(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("400 The reasoning_content in the thinking mode must be passed back to the API");
      }
      return "ok";
    }, { sessionId: "retry-session" });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
    assert.equal(reasoningPassthroughEnabled("retry-session"), false, "命中后该会话回传被关闭");
  } finally {
    config.modelRequestRetries = original;
    clearReasoningRecords("retry-session");
  }
});

test("兜底：普通 400 不重试（确定性错误保持原语义）", async () => {
  const original = config.modelRequestRetries;
  config.modelRequestRetries = 3;
  let calls = 0;
  try {
    await assert.rejects(
      () => invokeWithModelRetry(async () => {
        calls += 1;
        throw new Error("400 Invalid request: messages must not be empty");
      }, { sessionId: "bad-request-session" }),
      /Invalid request/,
    );
    assert.equal(calls, 1);
  } finally {
    config.modelRequestRetries = original;
    clearReasoningRecords("bad-request-session");
  }
});
