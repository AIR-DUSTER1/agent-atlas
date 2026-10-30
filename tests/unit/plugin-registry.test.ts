/** plugin-registry.test.ts — 插件类型、启停入口与设置页集中管理回归 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientSource } from "../helpers/client-source.js";
import {
  BUILTIN_PLUGINS,
  PLUGIN_TRANSPORTS,
  pluginTransportMeta,
} from "../../src/client/modules/plugin-registry.js";

test("内置 RAG / 贝壳 / Computer Use 按真实接入类型分类", () => {
  const rag = BUILTIN_PLUGINS.find((plugin) => plugin.id === "rag");
  const estate = BUILTIN_PLUGINS.find((plugin) => plugin.id === "estate");
  const computer = BUILTIN_PLUGINS.find((plugin) => plugin.id === "computer");
  assert.equal(rag?.transport, "http");
  assert.equal(estate?.transport, "cli");
  assert.equal(computer?.transport, "builtin");
  assert.equal(computer?.defaultEnabled, false);
  assert.equal(pluginTransportMeta("http").short, "HTTP");
  assert.equal(pluginTransportMeta("mcp").short, "MCP");
  assert.equal(pluginTransportMeta("builtin").short, "内置");
  assert.match(PLUGIN_TRANSPORTS.mcp.description, /server/);
});

test("RAG、找房数据源与 Computer Use 集中到设置页插件分区并可启停", async () => {
  const root = new URL("../../src/client/", import.meta.url);
  const html = await readFile(new URL("index.html", root), "utf8");
  const shell = await readFile(new URL("views/shell.ts", root), "utf8");
  const navigation = await readFile(new URL("views/navigation.ts", root), "utf8");
  const pluginSettings = await readFile(new URL("views/settings-plugins.ts", root), "utf8");
  const app = await readClientSource();
  assert.match(html, /data-settings-view="plugins"/);
  assert.match(html, /id="settings-view-plugins"/);
  assert.match(html, /id="plugin-list"/);
  assert.match(html, /id="plugin-status"/);
  assert.doesNotMatch(html, /id="kb-btn"|id="estate-btn"/);
  assert.match(app, /function renderPluginCards\(\)/);
  assert.match(app, /pluginTransportMeta\(plugin\.transport\)/);
  assert.match(app, /plugin\.id === "rag"/);
  assert.match(app, /plugin\.id === "estate"/);
  assert.match(app, /plugin\.id === "computer"/);
  assert.match(app, /plugin-switch/);
  assert.match(pluginSettings, /toggle\.disabled = !supported/);
  assert.match(shell, /refreshWelcomePluginCopy\(\)/);
  assert.match(navigation, /refreshWelcomePluginCopy/);
});