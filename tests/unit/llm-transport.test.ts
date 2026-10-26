/** llm-transport.test.ts — OpenCode Go 会话路由头回归测试（全程 mock，不耗 API 配额） */
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../src/config.js";
import { buildGatewayTransportHeaders, createChatModel } from "../../src/llm.js";

test("仅 OpenCode 网关生成专用会话头", () => {
  const headers = buildGatewayTransportHeaders(
    "https://opencode.ai/zen/go/v1",
    "web-session-123"
  );
  assert.equal(headers?.["x-opencode-session"], "web-session-123");
  assert.equal(headers?.["User-Agent"], "langgraph-agent-workbench/1.0");
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
    assert.equal(captured.headers.get("user-agent"), "langgraph-agent-workbench/1.0");
  } finally {
    config.baseURL = original.baseURL;
    config.apiKey = original.apiKey;
    config.model = original.model;
    config.protocol = original.protocol;
    config.reasoning = original.reasoning;
  }
});