/** trace-settings.test.ts — 追踪配置归一化、Key 掩码与端点校验 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TraceRuntimeConfig } from "../../src/config.js";
import {
  getTraceSettings,
  normalizeTraceSettings,
  parseTraceInput,
  replaceTraceSettingsForTest,
  traceSettingsSnapshot,
} from "../../src/server/trace-settings.js";

const BASE: TraceRuntimeConfig = {
  backend: "off",
  apiKey: "",
  project: "agentatlas",
  endpoint: "https://api.smith.langchain.com",
  anonymize: true,
  agentId: "agentatlas",
  agentEnvironment: "local",
};

test("追踪配置兼容坏字段并回退安全默认值", () => {
  const normalized = normalizeTraceSettings({ backend: "unknown", project: "", endpoint: "", anonymize: false }, BASE);
  assert.equal(normalized.backend, "off");
  assert.equal(normalized.project, "agentatlas");
  assert.equal(normalized.endpoint, "https://api.smith.langchain.com");
  assert.equal(normalized.anonymize, false);
});

test("Key 留空保持、空串清除、非法 endpoint 拒绝", () => {
  const previous = { ...BASE, apiKey: "old-key", backend: "langsmith" as const };
  assert.equal(parseTraceInput({}, previous).apiKey, "old-key");
  assert.equal(parseTraceInput({ apiKey: "" }, previous).apiKey, "");
  assert.throws(() => parseTraceInput({ endpoint: "http://127.0.0.1:3000" }, previous), /https|内网/);
});

test("公开快照只返回掩码，并正确判定 effective", () => {
  const original = getTraceSettings();
  try {
    replaceTraceSettingsForTest({
      ...BASE,
      backend: "langsmith",
      apiKey: "lsv2-secret-key",
      project: "agentatlas-test",
    });
    const snapshot = traceSettingsSnapshot();
    assert.equal(snapshot.backend, "langsmith");
    assert.equal(snapshot.hasApiKey, true);
    assert.equal(snapshot.effective, true);
    assert.notEqual(snapshot.keyMasked, "lsv2-secret-key");
    assert.equal(snapshot.warning, null);
    assert.equal("apiKey" in snapshot, false);
  } finally {
    replaceTraceSettingsForTest(original);
  }
});

test("缺少 Key 或非法 endpoint 时快照仍可读取但不可用", () => {
  const original = getTraceSettings();
  try {
    replaceTraceSettingsForTest({ ...BASE, backend: "langsmith", apiKey: "" });
    const missing = traceSettingsSnapshot();
    assert.equal(missing.effective, false);
    assert.match(missing.warning ?? "", /API Key/);

    replaceTraceSettingsForTest({ ...BASE, backend: "langsmith", apiKey: "key", endpoint: "http://127.0.0.1" });
    const invalid = traceSettingsSnapshot();
    assert.equal(invalid.effective, false);
    assert.match(invalid.warning ?? "", /https|内网/);
  } finally {
    replaceTraceSettingsForTest(original);
  }
});
