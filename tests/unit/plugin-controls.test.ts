/**
 * tests/unit/plugin-controls.test.ts — 插件启停与 Agent 能力边界
 * ============================================================
 * 守三件事：
 *   1. 未配置时 RAG / 找房保持兼容默认，Browser Use / Computer Use 默认关闭；
 *   2. 启停状态会真实改变 general / estate profile 的 tool allowlist；
 *   3. 关闭插件后审批项同步收敛，不留下装配期悬空审批。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { generalProfileWithPlugins } from "../../src/agent/general.js";
import { estateProfileWithPlugins } from "../../src/agent/estate.js";
import { jobProfileWithPlugins } from "../../src/agent/job.js";
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

test("插件默认值：RAG / 找房兼容开启，Browser Use / Computer Use 显式关闭", () => {
  const enabled = getPluginEnabledSnapshot();
  assert.equal(enabled.rag, true);
  assert.equal(enabled.estate, true);
  assert.equal(enabled.browser, false);
  assert.equal(enabled.computer, false);

  const profile = generalProfileWithPlugins();
  assert.ok(profile.tools.some((tool) => tool.name === "retrieve_docs"));
  assert.equal(profile.tools.some((tool) => tool.name.startsWith("computer_")), false);
  for (const name of ["browser_open", "browser_snapshot", "browser_navigate", "browser_scroll", "browser_act"]) {
    assert.equal(profile.tools.some((tool) => tool.name === name), false);
  }
  assert.equal("computer_click" in profile.approvalDescriptions, false);
  assert.equal("terminal" in profile.approvalDescriptions, true);

  for (const scoped of [estateProfileWithPlugins(), jobProfileWithPlugins()]) {
    assert.equal(scoped.tools.some((tool) => tool.name.startsWith("browser_")), false);
    assert.equal(scoped.tools.some((tool) => tool.name.startsWith("computer_")), false);
    assert.equal("browser_act" in scoped.approvalDescriptions, false);
    assert.equal("computer_click" in scoped.approvalDescriptions, false);
  }
});

test("Browser Use 启用后装配浏览器工具，只有 browser_act 需要审批", () => {
  setPluginEnabledState({ browser: true });
  const profile = generalProfileWithPlugins();
  for (const name of ["browser_open", "browser_snapshot", "browser_navigate", "browser_scroll", "browser_act"]) {
    assert.ok(profile.tools.some((tool) => tool.name === name), `缺少浏览器工具：${name}`);
  }
  assert.ok("browser_act" in profile.approvalDescriptions);
  // 浏览器工具装配后：browser_open 必须登记审批（allowLocalhost 属于模型可控内网放行，
  // 审核后按 P1-7 收敛为必须人工确认），browser_fetch 同理；链接导航/快照/滚动保持只读直接执行。
  for (const name of ["browser_open", "browser_fetch"]) {
    assert.ok(name in profile.approvalDescriptions, `${name} 必须登记审批`);
  }
  for (const name of ["browser_snapshot", "browser_navigate", "browser_scroll"]) {
    assert.equal(name in profile.approvalDescriptions, false);
  }
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
  assert.equal(isPluginSupported("browser", "linux"), true);
  assert.equal(isPluginSupported("computer", "linux"), false);
  assert.equal(isPluginSupported("computer", "win32"), true);
  assert.equal(isPluginSupported("computer", "win32", true), false);
  assert.equal(isPluginSupported("computer", "win32", false), true);
});

test("Docker / 容器环境即使请求启用 Computer Use 也保持关闭", () => {
  const previous = process.env.BROWSER_USE_CONTAINER;
  process.env.BROWSER_USE_CONTAINER = "1";
  try {
    setPluginEnabledState({ computer: true });
    assert.equal(getPluginEnabledSnapshot().computer, false);
    assert.equal(isPluginSupported("computer", "win32"), false);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_USE_CONTAINER;
    else process.env.BROWSER_USE_CONTAINER = previous;
  }
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

test("平台插件启用后对通用、房产与求职 Profile 显式装配，领域工具仍保持隔离", () => {
  setPluginEnabledState({ browser: true, computer: true });
  const profiles = {
    general: generalProfileWithPlugins(),
    estate: estateProfileWithPlugins(),
    job: jobProfileWithPlugins(),
  };

  for (const [name, profile] of Object.entries(profiles)) {
    for (const toolName of ["browser_open", "browser_snapshot", "browser_navigate", "browser_scroll", "browser_act"]) {
      assert.ok(profile.tools.some((tool) => tool.name === toolName), `${name} 缺少平台工具 ${toolName}`);
    }
    assert.ok("browser_act" in profile.approvalDescriptions, `${name} 缺少 browser_act 审批`);
    if (isPluginSupported("computer")) {
      for (const toolName of COMPUTER_TOOL_NAMES) {
        assert.ok(profile.tools.some((tool) => tool.name === toolName), `${name} 缺少平台工具 ${toolName}`);
      }
      for (const approval of ["computer_click", "computer_type", "computer_key", "computer_scroll"]) {
        assert.ok(approval in profile.approvalDescriptions, `${name} 缺少 ${approval} 审批`);
      }
    }
    if (name !== "general") assert.match(profile.systemPrompt, /平台插件已启用/);
  }

  const estateNames = profiles.estate.tools.map((tool) => tool.name);
  const jobNames = profiles.job.tools.map((tool) => tool.name);
  assert.ok(!estateNames.includes("terminal"));
  assert.ok(!estateNames.includes("retrieve_docs"));
  assert.ok(!estateNames.includes("job_collect"));
  assert.ok(!jobNames.includes("house_search"));
  assert.ok(!jobNames.includes("terminal"));
  assert.ok("house_appoint" in profiles.estate.approvalDescriptions);
  assert.ok("job_collect" in profiles.job.approvalDescriptions);
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
