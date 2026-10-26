/** plugin-registry.test.ts — 插件类型与设置页集中管理回归 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientSource } from "../helpers/client-source.js";
import {
  BUILTIN_PLUGINS,
  PLUGIN_TRANSPORTS,
  pluginTransportMeta,
} from "../../src/client/modules/plugin-registry.js";

test("内置 RAG 按真实 HTTP 契约分类，不伪装成 MCP", () => {
  const rag = BUILTIN_PLUGINS.find((plugin) => plugin.id === "rag");
  const estate = BUILTIN_PLUGINS.find((plugin) => plugin.id === "estate");
  assert.equal(rag?.transport, "http");
  assert.equal(estate?.transport, "cli");
  assert.equal(pluginTransportMeta("http").short, "HTTP");
  assert.equal(pluginTransportMeta("mcp").short, "MCP");
  assert.match(PLUGIN_TRANSPORTS.mcp.description, /server/);
});

test("RAG 与找房数据源集中到设置页插件分区", async () => {
  const root = new URL("../../src/client/", import.meta.url);
  const html = await readFile(new URL("index.html", root), "utf8");
    const app = await readClientSource();
  assert.match(html, /data-settings-view="plugins"/);
  assert.match(html, /id="settings-view-plugins"/);
  assert.match(html, /id="plugin-list"/);
  assert.doesNotMatch(html, /id="kb-btn"|id="estate-btn"/);
  assert.match(app, /function renderPluginCards\(\)/);
  assert.match(app, /pluginTransportMeta\(plugin\.transport\)/);
  assert.match(app, /if \(plugin\.id === "rag"\) void import\("\.\/rag\.js"\)\.then\(\(m\) => m\.openKb\(\)\)/);
});