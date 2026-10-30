/** llm-transport.test.ts — OpenCode Go 会话路由头回归测试（全程 mock，不耗 API 配额） */
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../src/config.js";
import { buildGatewayTransportHeaders, createChatModel } from "../../src/llm.js";
import { PRODUCT_USER_AGENT } from "../../src/product.js";
import { DEFAULT_REASONING } from "../../src/reasoning.js";

test("仅 OpenCode 网关生成专用会话头", () => {
  const headers = buildGatewayTransportHeaders(
    "https://opencode.ai/zen/go/v1",
    "web-session-123"
  );
  assert.equal(headers?.["x-opencode-session"], "web-session-123");
  assert.equal(headers?.["User-Agent"], PRODUCT_USER_AGENT);
  assert.ok(buildGatewayTransportHeaders("https://api.example.com/v1", "web-session-123") === undefined);

  const sanitized = buildGatewayTransportHeaders(
    "https://opencode.ai/zen/go/v1",
    "web session/with unsafe chars"
  );
  assert.equal(sanitized?.["x-opencode-session"], "web-session-with-unsafe-chars");
});

test("Responses 请求实际携带稳定的 OpenCode 会话头", async () => {
  const original = {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    protocol: config.protocol,
    reasoning: { ...config.reasoning },
  };
  const captured = { url: "", headers: new Headers() };
  const mockFetch: typeof fetch = async (input, init) => {
    captured.url = input instanceof Request ? input.url : String(input);
    captured.headers = new Headers(init?.headers);
    return new Response(JSON.stringify({
      id: "resp_test",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "deepseek-v4.1-flash",
      output_text: "ok",
      output: [{
        type: "message",
        id: "msg_test",
        status: "completed",
        role: "assistant",
        phase: null,
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    config.baseURL = "https://opencode.ai/zen/go/v1";
    config.apiKey = "test-key";
    config.model = "deepseek-v4.1-flash";
    config.protocol = "openai-responses";

    const model = createChatModel(0, {
      sessionId: "web-session-123",
      fetch: mockFetch,
    });
    await model.invoke("ping");

    assert.match(captured.url, /\/responses$/);
    assert.equal(captured.headers.get("x-opencode-session"), "web-session-123");
    assert.equal(captured.headers.get("user-agent"), PRODUCT_USER_AGENT);
  } finally {
    config.baseURL = original.baseURL;
    config.apiKey = original.apiKey;
    config.model = original.model;
    config.protocol = original.protocol;
    config.reasoning = original.reasoning;
  }
});

test("并发模型快照互不串线，且不修改全局 config", async () => {
  const before = {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    protocol: config.protocol,
  };
  const makeFetch = (captured: { url: string; model: string }): typeof fetch => async (input, init) => {
    captured.url = input instanceof Request ? input.url : String(input);
    const payload = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    captured.model = payload.model ?? "";
    return new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: captured.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const firstCapture = { url: "", model: "" };
  const secondCapture = { url: "", model: "" };
  const runtime = (baseURL: string, model: string, capture: typeof firstCapture) => ({
    label: model,
    baseURL,
    apiKey: "snapshot-key",
    protocol: "openai" as const,
    model,
    reasoning: { ...DEFAULT_REASONING },
    requestTimeoutMs: 5_000,
  });

  try {
    const first = createChatModel(0, {
      sessionId: "subagent-first",
      fetch: makeFetch(firstCapture),
      runtime: runtime("https://first.example/v1", "model-first", firstCapture),
    });
    const second = createChatModel(0, {
      sessionId: "subagent-second",
      fetch: makeFetch(secondCapture),
      runtime: runtime("https://second.example/v1", "model-second", secondCapture),
    });
    await Promise.all([first.invoke("ping"), second.invoke("ping")]);
    assert.match(firstCapture.url, /^https:\/\/first\.example\/v1\/chat\/completions/);
    assert.match(secondCapture.url, /^https:\/\/second\.example\/v1\/chat\/completions/);
    assert.equal(firstCapture.model, "model-first");
    assert.equal(secondCapture.model, "model-second");
    assert.deepEqual(
      { baseURL: config.baseURL, apiKey: config.apiKey, model: config.model, protocol: config.protocol },
      before,
    );
  } finally {
    config.baseURL = before.baseURL;
    config.apiKey = before.apiKey;
    config.model = before.model;
    config.protocol = before.protocol;
  }
});
