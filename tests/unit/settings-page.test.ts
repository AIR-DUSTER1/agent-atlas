/** settings-page.test.ts — 独立设置页入口、布局与旧弹窗清理回归 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientFiles, readClientSource } from "../helpers/client-source.js";

const root = new URL("../../src/client/", import.meta.url);

test("设置导航按工作台/扩展/数据分组，并支持搜索过滤与 / 聚焦", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const settings = await readClientFiles(["views/settings.ts", "main.ts"]);
  assert.match(html, /id="settings-search"/);
  assert.match(html, /data-settings-group="workbench"/);
  assert.match(html, /data-settings-group="extensions"/);
  assert.match(html, /data-settings-group="data"/);
  assert.match(settings, /export function bindSettingsNavigation\(/);
  assert.match(settings, /button\.classList\.toggle\("hidden", !match\)/);
  assert.match(settings, /event\.key === "Escape" && input\.value/);
  assert.match(settings, /event\.key !== "\/"/);
  assert.match(settings, /bindSettingsNavigation\(\);/);
});
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
    const app = await readClientSource();
  assert.match(app, /function openSettings\(view = "models"/);
  assert.match(app, /function showSettingsView\(view(?:: string)?\): void/);
  assert.match(app, /function closeSettingsPage\(\): void/);
  assert.match(app, /dataset\.settingsView/);
  assert.doesNotMatch(app, /settings-mask|memories-mask|stats-mask/);
});
test("模型与供应商采用左栏选择、右栏模型详情", async () => {
  const root = new URL("../../src/client/", import.meta.url);
  const html = await readFile(new URL("index.html", root), "utf8");
    const app = await readClientSource();
  assert.match(html, /class="provider-workspace"/);
  assert.match(html, /id="provider-list"/);
  assert.match(html, /id="provider-detail"/);
  assert.match(html, /id="pf-model-list"/);
  assert.match(app, /function selectProvider\(providerId: string \| null\): void/);
  assert.match(app, /function renderProviderDetail\(\): void/);
  assert.match(app, /provider-nav-item/);
  assert.doesNotMatch(app, /row\.querySelector\("\.p-use"\)/);
});

test("新增与编辑供应商使用独立弹窗，左栏选中态不再被创建态覆盖", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
    const app = await readClientSource();
  const detailStart = html.indexOf('id="provider-detail"');
  const detailEnd = html.indexOf('id="settings-status"', detailStart);
  const detail = html.slice(detailStart, detailEnd);
  assert.match(html, /id="provider-modal-mask"[\s\S]*role="dialog"/);
  assert.match(html, /id="pf-initial-models"/);
  assert.match(html, /id="provider-modal-close"/);
  assert.doesNotMatch(detail, /id="provider-form-wrap"/, "连接表单不能继续占用右栏详情");
  assert.match(app, /provider-modal-mask/);
  assert.match(app, /function closeProviderForm\(\): void/);
  assert.match(app, /\(p\.id === selectedProviderId \? " active" : ""\)/);
  assert.doesNotMatch(app, /providerFormMode !== "create" && p\.id === selectedProviderId/);
});

test("使用统计展示 7/30 天、KPI、Chart.js 六图与数据表降级", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const stats = await readClientFiles(["views/stats/index.ts", "views/stats/kpi.ts", "views/stats/charts.ts", "views/stats/tables.ts"]);
  assert.match(html, /id="stats-window-overview"/);
  assert.match(html, /id="stats-kpis"/);
  assert.match(html, /id="stats-charts"/);
  assert.match(html, /id="stats-tables"/);
  assert.match(html, /id="stats-refresh"/);
  assert.match(stats, /activeRangeId = "7d"/);
  assert.match(stats, /await import\("\.\.\/\.\.\/vendor\/chart\.js"\)/);
  assert.match(stats, /renderKpis/);
  assert.match(stats, /renderTables/);
  assert.match(stats, /ResizeObserver/);
  assert.match(stats, /toBase64Image/);
  assert.match(stats, /toolCalls/);
  assert.match(stats, /byHour/);
  assert.match(stats, /图表暂不可用/);
  assert.match(stats, /8_000/);
});
test("设置表单密钥只显示掩码，必填错误就地呈现", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const forms = await readClientFiles([
    "views/settings-memories.ts", "views/settings-commands.ts", "ui/field.ts",
  ]);
  assert.match(html, /id="pf-api-key" type="password"/);
  assert.match(html, /id="kb-key" type="password"/);
  assert.match(html, /id="estate-key" type="password"/);
  assert.match(forms, /export function setFieldError\(controlId: string, message: string\): void/);
  assert.match(forms, /setFieldError\("mem-key"/);
  assert.match(forms, /setFieldError\("cmd-name"/);
  assert.match(forms, /aria-invalid/);
});
test("长期记忆插槽：本地 / HTTP 配置、连接测试、scope 与导入导出齐备", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const source = await readClientFiles(["views/settings-memories.ts", "views/settings.ts"]);
  for (const id of [
    "mem-active-provider", "mem-health-badge", "mem-http-enabled", "mem-http-preset",
    "mem-http-base-url", "mem-http-api-key", "mem-test-http-btn", "mem-save-config-btn",
    "mem-profile-filter", "mem-search", "mem-history-toggle", "mem-export-btn", "mem-import-file",
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /id="mem-http-api-key" type="password"/);
  assert.match(source, /refreshMemorySettings/);
  assert.match(source, /testMemoryHttpFromForm/);
  assert.match(source, /snapshot/);
  assert.match(source, /authFetch\(`\/api\/memories\/export/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*`[^`]*\$\{[^}]*apiKey/);
});
test("MCP Servers 页面支持全局暂停、单服务器启停、JSON 导入与弹窗编辑", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const source = await readClientFiles(["views/settings-mcp.ts", "main.ts", "views/settings.ts"]);
  for (const id of [
    "mcp-summary", "mcp-global-enabled", "mcp-global-state", "mcp-import-btn",
    "mcp-import-file", "mcp-refresh-btn", "mcp-add-btn", "mcp-list",
    "mcp-editor-mask", "mcp-editor-title", "mcp-id", "mcp-name", "mcp-command",
    "mcp-args", "mcp-approval", "mcp-editor-delete", "mcp-editor-save",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /accept="\.json,application\/json"/);
  assert.match(source, /bindMcpSettings/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /\/api\/mcp\/import/);
  assert.match(source, /parseArgs/);
  assert.match(source, /envKeys/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /isMcpEditorOpen/);
  assert.doesNotMatch(source, /innerHTML/);
});
test("技能库支持上传、启停、分页与卡片删除", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const source = await readClientFiles(["views/settings-skills.ts", "main.ts", "views/settings.ts"]);
  for (const id of [
    "skills-refresh-btn", "skills-search", "skill-upload-btn", "skill-upload-file",
    "skills-count", "skills-count-all", "skills-count-enabled", "skills-count-disabled",
    "skills-list", "skills-pagination",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /accept="\.md,\.markdown,text\/markdown"/);
  assert.match(html, /data-skill-filter="all"/);
  assert.match(html, /data-skill-filter="enabled"/);
  assert.match(html, /data-skill-filter="disabled"/);
  assert.doesNotMatch(html, /id="skill-create-btn"/, "新建技能统一走 skill-creator");
  assert.doesNotMatch(html, /id="skill-editor-details"/, "设置页不再提供手写技能编辑表单");
  assert.doesNotMatch(html, /id="skill-(?:add|clear|delete)-btn"/);
  assert.match(source, /importSkillsFromFiles/);
  assert.match(source, /\/api\/skills\/import/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /skill-enabled-toggle/);
  assert.match(source, /SKILLS_PER_PAGE = 5/);
  assert.match(source, /function renderPagination/);
  assert.match(source, /function filterSkills/);
  assert.match(source, /启用技能 \$\{skill\.name\}/);
  assert.match(source, /function updateSkillEnabled/);
  assert.match(source, /async function deleteSkillCard/);
  assert.match(source, /skill-delete-btn/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /skill\.path/);
  assert.doesNotMatch(source, /openSkillEditor|saveSkillFromForm|currentEditingId/);
});
