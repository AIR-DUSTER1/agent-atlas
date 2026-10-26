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
test("模型与供应商采用左栏选择、右栏模型详情", async () => {
  const root = new URL("../../src/server/public/", import.meta.url);
  const html = await readFile(new URL("index.html", root), "utf8");
  const app = await readFile(new URL("app.js", root), "utf8");
  assert.match(html, /class="provider-workspace"/);
  assert.match(html, /id="provider-list"/);
  assert.match(html, /id="provider-detail"/);
  assert.match(html, /id="pf-model-list"/);
  assert.match(app, /function selectProvider\(providerId\)/);
  assert.match(app, /function renderProviderDetail\(\)/);
  assert.match(app, /provider-nav-item/);
  assert.doesNotMatch(app, /row\.querySelector\("\.p-use"\)/);
});

test("新增与编辑供应商使用独立弹窗，左栏选中态不再被创建态覆盖", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const app = await readFile(new URL("app.js", root), "utf8");
  const detailStart = html.indexOf('id="provider-detail"');
  const detailEnd = html.indexOf('id="settings-status"', detailStart);
  const detail = html.slice(detailStart, detailEnd);
  assert.match(html, /id="provider-modal-mask"[\s\S]*role="dialog"/);
  assert.match(html, /id="pf-initial-models"/);
  assert.match(html, /id="provider-modal-close"/);
  assert.doesNotMatch(detail, /id="provider-form-wrap"/, "连接表单不能继续占用右栏详情");
  assert.match(app, /provider-modal-mask/);
  assert.match(app, /function closeProviderForm\(\)/);
  assert.match(app, /\(p\.id === selectedProviderId \? " active" : ""\)/);
  assert.doesNotMatch(app, /providerFormMode !== "create" && p\.id === selectedProviderId/);
});

test("使用统计展示近 7 天与近 30 天，并用原生 SVG 图表渲染", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const app = await readFile(new URL("app.js", root), "utf8");
  assert.match(html, /id="stats-window-overview"/);
  assert.match(html, /id="stats-chart"/);
  assert.match(html, /id="stats-refresh"/);
  assert.match(html, /id="stats-models"/);
  assert.match(html, /id="stats-sessions"/);
  assert.doesNotMatch(html, /id="stats-days"/, "旧的单区间按天列表应已移除");
  assert.match(app, /activeStatsRange = "7d"/);
  assert.match(app, /function renderStatsChart\(range\)/);
  assert.match(app, /document\.createElementNS\(SVG_NS/);
  assert.match(app, /stats-window-card/);
  assert.match(app, /stats-chart-svg/);
});
