/** plugin-registry.test.ts — 插件类型、启停入口与设置页集中管理回归 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientIndexHtml } from "../helpers/client-html.js";
import {
  BUILTIN_PLUGINS,
  PLUGIN_TRANSPORTS,
  pluginTransportMeta,
} from "../../src/client/modules/plugin-registry.js";

test("内置 RAG / 贝壳 / Browser Use / Computer Use 按真实接入类型分类", () => {
  const rag = BUILTIN_PLUGINS.find((plugin) => plugin.id === "rag");
  const estate = BUILTIN_PLUGINS.find((plugin) => plugin.id === "estate");
  const computer = BUILTIN_PLUGINS.find((plugin) => plugin.id === "computer");
  const browser = BUILTIN_PLUGINS.find((plugin) => plugin.id === "browser");
  assert.equal(rag?.transport, "http");
  assert.equal(estate?.transport, "cli");
  assert.equal(computer?.transport, "builtin");
  assert.equal(computer?.defaultEnabled, false);
  assert.equal(browser?.transport, "builtin");
  assert.equal(browser?.defaultEnabled, false);
  assert.match(browser?.description ?? "", /右侧/);
  assert.equal(pluginTransportMeta("http").short, "HTTP");
  assert.equal(pluginTransportMeta("mcp").short, "MCP");
  assert.equal(pluginTransportMeta("builtin").short, "内置");
  assert.match(PLUGIN_TRANSPORTS.mcp.description, /server/);
});

test("RAG、找房数据源、Browser Use 与 Computer Use 集中到设置页插件分区并可启停", async () => {
  const root = new URL("../../src/client/", import.meta.url);
  const html = await readClientIndexHtml();
  const shell = await readFile(new URL("views/shell.ts", root), "utf8");
  const navigation = await readFile(new URL("views/navigation.ts", root), "utf8");
  // M4 4.1：卡片渲染与启停写回迁往 Vue 组件 + Pinia store，h() 渲染器退役
  const pluginPanel = await readFile(new URL("views/settings-plugins-vue.vue", root), "utf8");
  const pluginSettings = await readFile(new URL("views/settings-plugins.ts", root), "utf8");
  const pluginStore = await readFile(new URL("stores/plugins.ts", root), "utf8");
  // M4 4.5：导航迁往 store（settings-nav-vue 渲染 data-settings-view）
  const navStore = await readFile(new URL("stores/settings.ts", root), "utf8");
  assert.match(navStore, /view: "plugins"/);
  assert.match(html, /id="settings-view-plugins"/);
  assert.match(html, /id="plugin-list"/);
  assert.match(html, /id="plugin-status"/);
  assert.doesNotMatch(html, /id="kb-btn"|id="estate-btn"/);
  // Vue 卡片 DOM 契约（e2e 依赖）：data-plugin-id / role=switch / 状态文案 / 传输类型标识
  assert.match(pluginPanel, /:data-plugin-id="row\.plugin\.id"/);
  assert.match(pluginPanel, /:data-transport="row\.transport\.id"/);
  assert.match(pluginPanel, /role="switch"/);
  assert.match(pluginPanel, /plugin-switch/);
  assert.match(pluginPanel, /已启用|已停用/);
  assert.match(pluginPanel, /readinessOf/);
  assert.match(pluginPanel, /plugin\.id !== "computer"/);
  assert.match(pluginSettings, /refreshPluginPanel/);
  assert.match(pluginStore, /PATCH/);
  assert.match(pluginStore, /syncToLegacyState/);
  assert.match(shell, /refreshWelcomePluginCopy\(\)/);
  assert.match(navigation, /refreshWelcomePluginCopy/);
});
