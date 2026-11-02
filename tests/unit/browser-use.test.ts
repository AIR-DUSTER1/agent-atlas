/**
 * browser-use.test.ts — Browser Use 安全边界与接线回归
 * ============================================================
 * 不启动真实 Chrome：本文件守 URL 防线、会话 id、插件 fail-closed、工具审批与
 * 右侧画面接线。真实浏览器闭环由本地 smoke 验证，避免 CI 强依赖 GUI/Chrome。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { browserOpenTool, browserTools } from "../../src/tools-browser.js";
import { normalizeBrowserSessionId } from "../../src/server/browser-use.js";
import { assertAllowedHttpUrl, assertAllowedWebSocketUrl, isPrivateHost } from "../../src/url-guard.js";
import { generalProfileWithPlugins } from "../../src/agent/general.js";
import { resetPluginStateForTests, setPluginEnabledState } from "../../src/plugin-state.js";
import { buildDelegationCatalog } from "../../src/delegation-catalog.js";
import { createWorkflowGraph, type WorkflowChatModel } from "../../src/agent/workflow.js";

beforeEach(() => resetPluginStateForTests());
afterEach(() => resetPluginStateForTests());

test("Browser Use 会话 id 严格限制字符集与长度", () => {
  assert.equal(normalizeBrowserSessionId("session_01-ab"), "session_01-ab");
  assert.throws(() => normalizeBrowserSessionId("../../etc/passwd"), /非法/);
  assert.throws(() => normalizeBrowserSessionId("a".repeat(129)), /非法/);
  assert.throws(() => normalizeBrowserSessionId(""), /非法/);
});

test("Browser Use 与 browser_fetch 共用 SSRF 防线", () => {
  assert.equal(isPrivateHost("127.0.0.1"), true);
  assert.equal(isPrivateHost("192.168.1.2"), true);
  assert.equal(isPrivateHost("intranet"), true);
  assert.equal(isPrivateHost("example.com"), false);
  assert.equal(assertAllowedHttpUrl("https://example.com/docs", false).hostname, "example.com");
  assert.throws(() => assertAllowedHttpUrl("http://127.0.0.1:3000", false), /内网/);
  assert.equal(assertAllowedHttpUrl("http://127.0.0.1:3000", true).port, "3000");
  assert.throws(() => assertAllowedHttpUrl("file:///etc/passwd", true), /协议/);
  assert.equal(assertAllowedWebSocketUrl("wss://example.com/socket", false).hostname, "example.com");
  assert.throws(() => assertAllowedWebSocketUrl("ws://example.com/socket", false), /wss/);
  assert.throws(() => assertAllowedWebSocketUrl("wss://127.0.0.1/socket", false), /内网/);
  assert.equal(assertAllowedWebSocketUrl("ws://127.0.0.1/socket", true).hostname, "127.0.0.1");
});

test("Browser Use 插件停用时工具 fail-closed，启用后只审批 browser_act", async () => {
  assert.equal(browserTools.length, 5);
  const disabled = JSON.parse(String(await browserOpenTool.invoke(
    { url: "https://example.com" },
    { configurable: { thread_id: "session-a" } },
  ))) as { error?: string };
  assert.match(disabled.error ?? "", /插件已停用/);

  setPluginEnabledState({ browser: true });
  const profile = generalProfileWithPlugins();
  assert.ok(profile.tools.some((item) => item.name === "browser_open"));
  assert.ok("browser_act" in profile.approvalDescriptions);
  assert.equal("browser_open" in profile.approvalDescriptions, false);
});

test("Browser Use 没有 thread_id 时不会误用全局会话", async () => {
  setPluginEnabledState({ browser: true });
  const result = JSON.parse(String(await browserOpenTool.invoke({ url: "https://example.com" }))) as { error?: string };
  assert.match(result.error ?? "", /会话上下文/);
});

test("Browser Use 不进入子代理工具目录，交互始终留在主会话", () => {
  const catalog = buildDelegationCatalog({
    parentTools: browserTools,
    parentApprovals: {},
    includeEstateTools: false,
  });
  assert.deepEqual(catalog.map((entry) => entry.tool.name), []);
});

test("browser_act 在人工审批前不会触碰浏览器", async () => {
  setPluginEnabledState({ browser: true });
  const analysis = JSON.stringify({ understood: true, brief: "点击页面", question: "", options: [] });
  const review = JSON.stringify({ passes: true, reason: "完成", feedback: "" });
  const agent: WorkflowChatModel = {
    invoke: async () => new AIMessage({
      content: "",
      tool_calls: [{ name: "browser_act", args: { action: "click", ref: "e1" }, id: "browser-approval" }],
    }),
  };
  const fixed = (content: string): WorkflowChatModel => ({ invoke: async () => new AIMessage(content) });
  const graph = createWorkflowGraph(generalProfileWithPlugins(), {
    agent,
    analyst: fixed(analysis),
    reviewer: fixed(review),
  }, { checkpointer: new MemorySaver() });
  const result = await graph.invoke(
    { messages: [new HumanMessage("点击页面按钮")] },
    { configurable: { thread_id: "browser-approval-test", permission_mode: "approve" } },
  ) as unknown as { __interrupt__?: Array<{ value?: { toolName?: string } }> };
  assert.equal(result.__interrupt__?.[0]?.value?.toolName, "browser_act");
});

test("右侧 Browser Use 面板、样式与工具卡增强已接线", async () => {
  const html = await readFile("src/client/index.html", "utf8");
  const main = await readFile("src/client/main.ts", "utf8");
  const view = await readFile("src/client/views/browser-use.ts", "utf8");
  const serverIndex = await readFile("src/server/index.ts", "utf8");
  assert.match(html, /id="browser-dock"/);
  assert.match(html, /href="\/styles\/browser-use.css"/);
  assert.match(html, /id="browser-dock-screen"/);
  assert.match(html, /id="browser-dock-close"[^>]*aria-label="关闭 Browser Use 浏览器"/);
  assert.match(html, /id="browser-dock-state"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(main, /renderBrowserInToolCard/);
  assert.match(view, /state\.currentId !== sessionId/);
  assert.match(serverIndex, /\/api\/browser\/status/);
  assert.match(serverIndex, /browserMatch/);
});
