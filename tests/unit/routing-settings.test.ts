/**
 * tests/unit/routing-settings.test.ts — 路由配置的校验契约
 * ============================================================
 * 只测 `parseRoutingInput`（纯函数）：**不写盘、不改内存状态**。
 *
 * 这里曾经直接调 `saveRoutingSettings`，结果写进真实 `.web-config.json`，
 * 后续依赖默认配置的用例（memory-http 的连接测试）随机失败 —— 单测不该
 * 拥有改仓库配置的能力。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoutingInput } from "../../src/server/routing-settings.js";
import { DEFAULT_ROUTING_SETTINGS } from "../../src/routing/state.js";
import type { RoutingSettings } from "../../src/routing/types.js";

function current(patch: Partial<RoutingSettings> = {}): RoutingSettings {
  return {
    ...DEFAULT_ROUTING_SETTINGS,
    llm: { ...DEFAULT_ROUTING_SETTINGS.llm },
    systemone: { ...DEFAULT_ROUTING_SETTINGS.systemone },
    thresholds: { ...DEFAULT_ROUTING_SETTINGS.thresholds },
    limits: { ...DEFAULT_ROUTING_SETTINGS.limits },
    ...patch,
  };
}

test("默认值：不传任何字段时保持当前配置", () => {
  const base = current();
  const next = parseRoutingInput({}, base);
  assert.equal(next.enabled, base.enabled);
  assert.equal(next.backend, base.backend);
  assert.deepEqual(next.thresholds, base.thresholds);
  assert.deepEqual(next.limits, base.limits);
});

test("阈值越界拒绝，并给出中文说明", () => {
  assert.throws(
    () => parseRoutingInput({ thresholds: { ruleAutoAccept: 1.5 } }, current()),
    /规则自动派发阈值必须在 0 到 1 之间/,
  );
  assert.throws(
    () => parseRoutingInput({ thresholds: { modelConfidence: -0.1 } }, current()),
    /模型置信度阈值必须在 0 到 1 之间/,
  );
  assert.throws(
    () => parseRoutingInput({ thresholds: { candidateMargin: "abc" } }, current()),
    /候选分差阈值必须是数字/,
  );
});

test("上限必须正整数且在范围内", () => {
  assert.throws(
    () => parseRoutingInput({ limits: { maxHandoffs: 1.5 } }, current()),
    /最大转回次数必须是整数/,
  );
  assert.throws(
    () => parseRoutingInput({ limits: { maxHandoffs: 9 } }, current()),
    /最大转回次数必须在 0 到 3 之间/,
  );
  assert.throws(
    () => parseRoutingInput({ limits: { maxIntents: 2 } }, current()),
    /意图上限必须在 5 到 200 之间/,
  );
});

test("供应商与模型必须成对出现", () => {
  assert.throws(
    () => parseRoutingInput({ llm: { providerId: "p1", modelId: null } }, current()),
    /必须同时指定供应商与模型/,
  );
  assert.throws(
    () => parseRoutingInput({ llm: { providerId: null, modelId: "m1" } }, current()),
    /必须同时指定供应商与模型/,
  );
});

test("选择 systemone 后端时地址必填", () => {
  assert.throws(
    () => parseRoutingInput({ backend: "systemone", systemone: { baseURL: "" } }, current()),
    /必须填写决策服务地址/,
  );
});

test("地址必须是 http(s)，尾斜杠被规范化掉", () => {
  assert.throws(
    () => parseRoutingInput({ backend: "systemone", systemone: { baseURL: "127.0.0.1:8765" } }, current()),
    /必须是 http\(s\) 开头的完整 URL/,
  );
  const next = parseRoutingInput(
    { backend: "systemone", systemone: { baseURL: "http://127.0.0.1:8765///", apiKey: "secret-key" } },
    current(),
  );
  assert.equal(next.systemone.baseURL, "http://127.0.0.1:8765");
  assert.equal(next.systemone.apiKey, "secret-key");
});

test("Key 留空表示保持不变，显式空串才清除", () => {
  const withKey = current({ systemone: { baseURL: "http://127.0.0.1:8765", expectedModel: "", apiKey: "k1" } });
  // 不传 apiKey 字段 → 保持
  const kept = parseRoutingInput({ systemone: { baseURL: "http://127.0.0.1:8765" } }, withKey);
  assert.equal(kept.systemone.apiKey, "k1");
  // 显式传空串 → 清除
  const cleared = parseRoutingInput({ systemone: { baseURL: "http://127.0.0.1:8765", apiKey: "" } }, withKey);
  assert.equal(cleared.systemone.apiKey, "");
});

test("未知后端名回落到 openai-compat", () => {
  assert.equal(parseRoutingInput({ backend: "not-a-backend" }, current()).backend, "openai-compat");
});

test("enabled 只有布尔 true 才开启", () => {
  assert.equal(parseRoutingInput({ enabled: "yes" }, current()).enabled, false);
  assert.equal(parseRoutingInput({ enabled: true }, current()).enabled, true);
});

test("决策超时有下界（防止把路由配成必然超时）", () => {
  assert.throws(
    () => parseRoutingInput({ decideTimeoutMs: 10 }, current()),
    /决策超时必须在 500 到 120000 之间/,
  );
});
