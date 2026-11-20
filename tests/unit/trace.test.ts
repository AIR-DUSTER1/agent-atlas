/** trace.test.ts — LangSmith tracer 构造边界、endpoint 校验与脱敏规则 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTraceMetadata,
  createTraceCallbacks,
  redactTraceText,
  validateTraceEndpoint,
} from "../../src/agent/trace.js";

const BASE = {
  backend: "langsmith" as const,
  apiKey: "lsv2_test_key",
  project: "agentatlas-test",
  endpoint: "https://api.smith.langchain.com",
  anonymize: true,
  agentId: "agentatlas",
  agentEnvironment: "local",
};

test("默认关闭不构造 callback", async () => {
  const result = await createTraceCallbacks({ ...BASE, backend: "off" });
  assert.deepEqual(result.callbacks, []);
  assert.equal(result.warning, undefined);
});

test("LangSmith 开启但缺少 Key 时安全降级", async () => {
  const result = await createTraceCallbacks({ ...BASE, apiKey: "" });
  assert.deepEqual(result.callbacks, []);
  assert.match(result.warning ?? "", /API Key/);
});

test("endpoint 只接受安全的公网 HTTPS 地址", () => {
  assert.equal(validateTraceEndpoint("https://api.smith.langchain.com"), null);
  assert.match(validateTraceEndpoint("http://api.smith.langchain.com") ?? "", /https/);
  assert.match(validateTraceEndpoint("https://user:pass@api.smith.langchain.com") ?? "", /用户名或密码/);
  assert.match(validateTraceEndpoint("https://127.0.0.1") ?? "", /localhost|内网/);
  assert.match(validateTraceEndpoint("https://10.0.0.8") ?? "", /localhost|内网/);
  assert.match(validateTraceEndpoint("https://192.168.1.2") ?? "", /localhost|内网/);
  assert.match(validateTraceEndpoint("https://172.20.1.2") ?? "", /localhost|内网/);
  assert.match(validateTraceEndpoint("https://[::1]") ?? "", /localhost|内网/);
});

test("PII 脱敏按规则顺序替换且不误伤带字母的订单号", () => {
  const text = "手机 13800138000，身份证 11010519491231002X，卡号 6222020202020202020，订单 A1234567890123456";
  const redacted = redactTraceText(text);
  assert.match(redacted, /<phone>/);
  assert.match(redacted, /<id-card>/);
  assert.match(redacted, /<card>/);
  assert.match(redacted, /A1234567890123456/);
  assert.doesNotMatch(redacted, /13800138000|11010519491231002X|6222020202020202020/);
});

test("trace metadata 只包含内部标识并限制长度", () => {
  assert.deepEqual(buildTraceMetadata("session-1", "general"), {
    sessionId: "session-1",
    profileId: "general",
    agent_id: "agentatlas",
    agent_environment: "local",
  });
  assert.equal(buildTraceMetadata("s".repeat(300), "p".repeat(100)).sessionId.length, 200);
  assert.equal(buildTraceMetadata("s", "p".repeat(100)).profileId.length, 80);
});

test("合法配置可以构造 LangChainTracer，但不触发网络请求", async () => {
  const result = await createTraceCallbacks(BASE);
  assert.equal(result.warning, undefined);
  assert.equal(result.callbacks.length, 1);
});
