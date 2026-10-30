/**
 * tests/unit/plugin-controls.test.ts — 插件启停与 Agent 能力边界
 * ============================================================
 * 守三件事：
 *   1. 未配置时 RAG / 找房保持兼容默认，Computer Use 默认关闭；
 *   2. 启停状态会真实改变 general / estate profile 的 tool allowlist；
 *   3. 关闭插件后审批项同步收敛，不留下装配期悬空审批。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { generalProfileWithPlugins } from "../../src/agent/general.js";
import { estateProfileWithPlugins } from "../../src/agent/estate.js";
import { COMPUTER_TOOL_NAMES, computerScreenshot } from "../../src/tools-computer.js";
import { retrieveDocs } from "../../src/tools-rag.js";
import {
  getPluginEnabledSnapshot,
  isPluginSupported,
  resetPluginStateForTests,
  setPluginEnabledState,
} from "../../src/plugin-state.js";

beforeEach(() => resetPluginStateForTests());
afterEach(() => resetPluginStateForTests());

test("插件默认值：RAG / 找房兼容开启，Computer Use 显式关闭", () => {
  const enabled = getPluginEnabledSnapshot();
  assert.equal(enabled.rag, true);
  assert.equal(enabled.estate, true);
  assert.equal(enabled.computer, false);

  const profile = generalProfileWithPlugins();
  assert.ok(profile.tools.some((tool) => tool.name === "retrieve_docs"));
  assert.equal(profile.tools.some((tool) => tool.name.startsWith("computer_")), false);
  assert.equal("computer_click" in profile.approvalDescriptions, false);
  assert.equal("terminal" in profile.approvalDescriptions, true);
});

test("关闭 RAG 会移除 retrieve_docs，不影响基础工具", () => {
  setPluginEnabledState({ rag: false });
  const profile = generalProfileWithPlugins();
  assert.equal(profile.tools.some((tool) => tool.name === "retrieve_docs"), false);
  assert.equal(profile.tools.some((tool) => tool.name === "terminal"), true);
  assert.match(profile.systemPrompt, /知识库检索/);
});

test("平台支持矩阵：Computer Use 仅允许 Windows", () => {
  assert.equal(isPluginSupported("rag", "linux"), true);
  assert.equal(isPluginSupported("estate", "linux"), true);
  assert.equal(isPluginSupported("computer", "linux"), false);
  assert.equal(isPluginSupported("computer", "win32"), true);
});

test("Computer Use 已启用时仅在 Windows 装配电脑工具与审批项", () => {
  setPluginEnabledState({ computer: true });
  const profile = generalProfileWithPlugins();
  if (!isPluginSupported("computer")) {
    assert.equal(getPluginEnabledSnapshot().computer, false);
    assert.equal(profile.tools.some((tool) => tool.name.startsWith("computer_")), false);
    assert.equal("computer_click" in profile.approvalDescriptions, false);
    return;
  }
  for (const name of COMPUTER_TOOL_NAMES) {
    assert.ok(profile.tools.some((tool) => tool.name === name), `缺少电脑工具：${name}`);
  }
  for (const name of ["computer_click", "computer_type", "computer_key", "computer_scroll"]) {
    assert.ok(name in profile.approvalDescriptions, `缺少电脑审批：${name}`);
  }
  assert.equal("computer_screenshot" in profile.approvalDescriptions, false);
});

test("关闭找房插件会移除所有 house_* 工具并清空房产审批", () => {
  setPluginEnabledState({ estate: false });
  const profile = estateProfileWithPlugins();
  assert.equal(profile.tools.some((tool) => tool.name.startsWith("house_")), false);
  assert.deepEqual(profile.approvalDescriptions, {});
  assert.ok(profile.tools.some((tool) => tool.name === "calculator"));
  assert.match(profile.systemPrompt, /找房数据源插件已停用/);
});
test("关闭后的工具即使被旧图调用也 fail-closed，不触达外部服务", async () => {
  setPluginEnabledState({ rag: false, computer: false });
  const ragResult = await retrieveDocs.invoke({ query: "测试检索" });
  const parsed = JSON.parse(String(ragResult)) as { error?: string };
  assert.match(parsed.error ?? "", /插件已停用/);

  const computerResult = await computerScreenshot.invoke();
  assert.match(String(computerResult), /插件已停用/);
});
