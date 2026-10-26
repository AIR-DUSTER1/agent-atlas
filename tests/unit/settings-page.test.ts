/** settings-page.test.ts — 独立设置页入口、布局与旧弹窗清理回归 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../src/server/public/", import.meta.url);

test("设置入口固定在左下，顶栏不再散放记忆/统计/设置按钮", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const topbar = html.slice(html.indexOf('<header id="topbar">'), html.indexOf("</header>"));
  assert.doesNotMatch(topbar, /id="(memories|stats|settings)-btn"/);
  assert.match(html, /<div class="side-footer">[\s\S]*id="settings-btn"[\s\S]*id="side-model"/);
});

test("设置页包含返回按钮、全部分区与集中面板", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /id="settings-page"/);
  assert.ok(html.indexOf('id="settings-back-btn"') < html.indexOf('class="settings-nav-item active"'));
  for (const view of ["models", "plugins", "memories", "stats"]) {
    assert.match(html, new RegExp(`data-settings-panel="${view}"`));
  }
  assert.doesNotMatch(html, /id="(settings|memories|stats)-mask"/);
});

test("前端通过独立页面函数切换分区并统一关闭", async () => {
  const app = await readFile(new URL("app.js", root), "utf8");
  assert.match(app, /function openSettings\(view = "models"/);
  assert.match(app, /function showSettingsView\(view\)/);
  assert.match(app, /function closeSettingsPage\(\)/);
  assert.match(app, /dataset\.settingsView/);
  assert.doesNotMatch(app, /settings-mask|memories-mask|stats-mask/);
});