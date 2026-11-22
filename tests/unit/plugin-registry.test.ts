/** plugin-registry.test.ts — 插件类型、启停入口与设置页集中管理回归 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolveClientPath } from "../helpers/client-source.js";
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
  // views/ 已按页面重组，统一经 resolveClientPath 解析（避免写死页面目录）
  const read = async (name: string): Promise<string> =>
    readFile(new URL(await resolveClientPath(name), root), "utf8");
  const shell = await read("views/shell.ts");
  const navigation = await read("views/navigation.ts");
  // M4 4.1：卡片渲染与启停写回迁往 Vue 组件 + Pinia store，h() 渲染器退役
  const pluginPanel = await read("views/settings-plugins-vue.vue");
  const pluginSettings = await read("views/settings-plugins.ts");
  const pluginStore = await read("stores/plugins.ts");
  // M4 4.5：导航迁往 store（settings-nav-vue 渲染 data-settings-view）
  const navStore = await read("stores/settings.ts");
  assert.match(navStore, /view: "plugins"/);
  assert.match(html, /id="settings-view-plugins"/);
  assert.match(html, /id="plugin-list"/);
  assert.match(html, /id="plugin-status"/);
  assert.doesNotMatch(html, /id="kb-btn"|id="estate-btn"/);
  // Vue 卡片 DOM 契约（e2e 依赖）：data-plugin-id / 启停开关 / 状态文案 / 传输类型标识
  assert.match(pluginPanel, /:data-plugin-id="row\.plugin\.id"/);
  assert.match(pluginPanel, /:data-transport="row\.transport\.id"/);
  // 启停开关改 antdv Switch：role="switch" 是它运行时输出的，源码里只剩组件标签。
  // 断言组件存在且受控于 row.enabled（受控 = 状态只有一个来源）。
  assert.match(pluginPanel, /<Switch[\s\S]{0,300}:checked="row\.enabled"/);
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
