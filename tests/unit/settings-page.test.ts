/** settings-page.test.ts — 独立设置页入口、布局与旧弹窗清理回归 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientFiles, readClientSource } from "../helpers/client-source.js";
import { quickReasoningDisplayLabel, visibleQuickReasoningLevels } from "../../src/client/modules/reasoning-display.js";
import { readClientIndexHtml } from "../helpers/client-html.js";

const root = new URL("../../src/client/", import.meta.url);

test("设置导航按工作台/扩展/数据分组，并支持搜索过滤与 / 聚焦", async () => {
  // M4 4.5：导航迁往 Vue 组件 + settings store，结构契约在组件/状态层上断言
  const nav = await readClientFiles(["views/settings-nav-vue.vue", "stores/settings.ts"]);
  assert.match(nav, /id="settings-search"/);
  assert.match(nav, /:data-settings-group="group\.id"/);
  assert.match(nav, /id: "workbench"/);
  assert.match(nav, /id: "extensions"/);
  assert.match(nav, /id: "data"/);
  assert.match(nav, /event\.key === "Escape" && searchTerm\.value/);
  assert.match(nav, /event\.key !== "\/"/);
  assert.match(nav, /filteredGroups/);
});
test("设置入口固定在左下，顶栏不再散放记忆/统计/设置按钮", async () => {
  const html = await readClientIndexHtml();
  const topbar = html.slice(html.indexOf('<header id="topbar">'), html.indexOf("</header>"));
  assert.doesNotMatch(topbar, /id="(memories|stats|settings)-btn"/);
  assert.doesNotMatch(topbar, /id="provider-btn"|class="provider-switch"/);
  assert.match(html, /id="cm-model"/);
  assert.match(html, /<div class="side-footer">[\s\S]*id="settings-btn"[\s\S]*id="side-model"/);
});

test("设置页包含返回按钮、全部分区与集中面板", async () => {
  const html = await readClientIndexHtml();
  assert.match(html, /id="settings-page"/);
  // M4 4.5：导航 active 类在 Vue 组件内，静态骨架保留 #settings-nav-mount 挂载点
  assert.ok(html.indexOf('id="settings-back-btn"') < html.indexOf('id="settings-nav-mount"'));
  for (const view of ["models", "plugins", "subagents", "tracing", "memories", "stats"]) {
    assert.match(html, new RegExp(`data-settings-panel="${view}"`));
  }
  assert.doesNotMatch(html, /id="(settings|memories|stats)-mask"/);
});

test("插件页不再重复展示 MCP 接入类型", async () => {
  const html = await readClientIndexHtml();
  const start = html.indexOf('id="settings-view-plugins"');
  const end = html.indexOf('id="settings-view-subagents"', start);
  assert.ok(start >= 0 && end > start);
  const pluginsPage = html.slice(start, end);
  assert.doesNotMatch(pluginsPage, /MCP 标准 server/);
  assert.doesNotMatch(pluginsPage, /MCP 是独立扩展类型/);
  const nav = await readClientFiles(["stores/settings.ts"]);
  assert.match(nav, /view: "mcp"/);
});
test("设置页大标题不再重复展示说明文案", async () => {
  const html = await readClientIndexHtml();
  const start = html.indexOf('id="settings-page"');
  const end = html.indexOf("<!-- 供应商连接配置", start);
  assert.ok(start >= 0 && end > start);
  const settingsPage = html.slice(start, end);
  assert.doesNotMatch(settingsPage, /<p class="settings-sub">/);
  assert.doesNotMatch(settingsPage, /模型、插件、子代理、长期记忆与使用统计集中管理/);
});
test("链路追踪设置页支持安全 opt-in、Key 掩码和保存契约", async () => {
  const html = await readClientIndexHtml();
  // M4 4.2：分区 body 迁入 Vue 组件，静态帧只留挂载容器 #tracing-panel
  const source = await readClientFiles([
    "views/settings-tracing-vue.vue",
    "stores/tracing.ts",
    "views/settings-tracing.ts",
    "views/settings.ts",
  ]);
  assert.match(html, /id="settings-view-tracing"/);
  assert.match(html, /id="tracing-panel"/);
  for (const id of [
    "tracing-enabled", "tracing-backend", "tracing-project",
    "tracing-endpoint", "tracing-agent-id", "tracing-agent-environment", "tracing-api-key", "tracing-clear-key", "tracing-anonymize",
    "tracing-warning", "tracing-status", "tracing-save-btn",
  ]) assert.match(source, new RegExp(`id="${id}"`), id);
  const nav = await readClientFiles(["stores/settings.ts"]);
  assert.match(nav, /view: "tracing"/);
  assert.match(source, /开启即表示允许对话内容发送到 LangSmith/);
  assert.match(source, /\/api\/tracing/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /mountTracingVue/);
  assert.match(source, /tracing-clear-key/);
  assert.doesNotMatch(source, /innerHTML/);
});

test("前端通过独立页面函数切换分区并统一关闭", async () => {
    const app = await readClientSource();
  assert.match(app, /function openSettings\(view = "models"/);
  assert.match(app, /function showSettingsView\(view(?:: string)?\): void/);
  assert.match(app, /function closeSettingsPage\(\): void/);
  // M4 4.5：导航状态改由 settings store 承接（state.settingsView 仅作 legacy 镜像）
  assert.match(app, /useSettingsStore\(\)\.show\(next\)/);
  assert.doesNotMatch(app, /settings-mask|memories-mask|stats-mask/);
});
test("模型与供应商采用左栏选择、右栏模型详情", async () => {
  const root = new URL("../../src/client/", import.meta.url);
  const html = await readClientIndexHtml();
  // M4 4.3：模型面板迁往 Vue 组件，结构契约在组件模板上断言
  const app = await readClientFiles(["views/models-panel-vue.vue", "stores/models.ts"]);
  assert.match(html, /id="settings-modal"/);
  assert.match(app, /class="provider-workspace"/);
  assert.match(app, /id="provider-list"/);
  assert.match(app, /id="provider-detail"/);
  assert.match(app, /id="pf-model-list"/);
  assert.match(app, /function selectProvider\(provider: ProviderEntry\): void/);
  assert.match(app, /provider-nav-item/);
  assert.doesNotMatch(app, /row\.querySelector\("\.p-use"\)/);
  assert.doesNotMatch(html, /「启用」的供应商 \+ 它当前的模型决定聊天用哪个模型/);
});

test("新增与编辑供应商使用独立弹窗，左栏选中态不再被创建态覆盖", async () => {
  const html = await readClientIndexHtml();
  // M4 4.3：供应商弹窗迁往 Vue 组件，结构契约在组件模板上断言
  const modal = await readClientFiles(["views/provider-form-vue.vue", "stores/models.ts"]);
  const panel = await readClientFiles(["views/models-panel-vue.vue"]);
  assert.match(html, /id="provider-modal-mask"/);
  assert.match(modal, /id="provider-modal" role="dialog"/);
  assert.match(modal, /id="pf-initial-models"/);
  assert.match(modal, /id="provider-modal-close"/);
  assert.match(modal, /id="provider-form-wrap"/);
  assert.match(panel, /class="provider-nav-item"/);
  assert.match(panel, /active: p\.id === store\.selectedProviderId/);
  assert.doesNotMatch(modal, /providerFormMode !== "create" && p\.id === selectedProviderId/);
});

test("使用统计展示 7/30 天、KPI、Chart.js 六图与数据表降级", async () => {
  const html = await readClientIndexHtml();
  // M4 4.2：分区 body 迁入 Vue 组件（stats-panel-vue.vue），静态帧只留 #stats-modal
  const stats = await readClientFiles([
    "views/stats-panel-vue.vue",
    "stores/stats.ts",
    "views/stats/charts.ts",
    "views/stats/index.ts",
  ]);
  assert.match(html, /id="settings-view-stats"/);
  assert.match(html, /id="stats-modal"/);
  for (const id of ["stats-window-overview", "stats-kpis", "stats-charts", "stats-tables", "stats-refresh"]) {
    assert.match(stats, new RegExp(`id="${id}"`), id);
  }
  assert.match(stats, /activeRangeId: "7d"/);
  // Chart.js 必须动态加载；深度不设死，页面可按 views/<page>/ 任意层级组织
  assert.match(stats, /import\("(?:\.\.\/)+vendor\/chart\.js"\)/);
  assert.match(stats, /CHART_SPECS/);
  assert.match(stats, /stats-chart-card/);
  assert.match(stats, /ResizeObserver/);
  assert.match(stats, /toBase64Image/);
  assert.match(stats, /toolCalls/);
  assert.match(stats, /byHour/);
  assert.match(stats, /图表暂不可用/);
  assert.match(stats, /8_000/);
});
test("设置表单密钥只显示掩码，必填错误就地呈现", async () => {
  const html = await readClientIndexHtml();
  const forms = await readClientFiles([
    "views/settings-memories.ts", "views/settings-commands-vue.vue", "ui/field.ts",
  ]);
  // M4 4.3：pf-api-key 随供应商弹窗迁往 Vue 组件
  const providerForm = await readClientFiles(["views/provider-form-vue.vue"]);
  assert.match(providerForm, /id="pf-api-key"[\s\S]{0,200}type="password"/);
  // M4 4.4：kb-key 随知识库弹窗迁往 Vue 组件
  const kbVue = await readClientFiles(["views/kb-panel-vue.vue"]);
  assert.match(kbVue, /id="kb-key"[\s\S]{0,200}type="password"/);
  // M4 4.4：estate-key 随贝壳弹窗迁往 Vue 组件
  const estateVue = await readClientFiles(["views/estate-panel-vue.vue"]);
  assert.match(estateVue, /id="estate-key"[\s\S]{0,200}type="password"/);
  assert.match(forms, /export function setFieldError\(controlId: string, message: string\): void/);
  // M4 4.1：命令名错误改由 Vue 组件就地呈现（aria-invalid + role=alert）
  assert.match(forms, /errors\.name/);
  assert.match(forms, /aria-invalid/);
  assert.match(forms, /role="alert"/);
});
test("记忆与个性化：默认上下文、本地 / HTTP 配置、scope 与导入导出齐备", async () => {
  const html = await readClientIndexHtml();
  // M4 4.2：记忆面板迁往 Vue 组件，id/结构契约在组件模板上断言
  const source = await readClientFiles(["views/settings-memories-vue.vue", "stores/memories.ts"]);
  for (const id of [
    "mem-active-provider", "mem-health-badge", "mem-http-enabled", "mem-http-preset",
    "mem-http-base-url", "mem-http-api-key", "mem-test-http-btn", "mem-save-config-btn",
    "mem-personalization-enabled", "mem-personalization-text", "mem-personalization-save-btn",
    "mem-profile-filter", "mem-search", "mem-history-toggle", "mem-export-btn", "mem-import-file",
  ]) assert.match(source, new RegExp(`id="${id}"`), id);
  assert.match(source, /id="mem-personalization-text"[^>]*placeholder="例如：我常驻上海，负责产品研发；回答先给结论，复杂任务分步骤说明；默认中文，方案优先保证可维护性。"/);
  assert.doesNotMatch(source, /例如：我在青岛从事前端开发/);
  assert.match(source, /请勿填写密钥或敏感凭据/);
  assert.match(source, /id="mem-http-api-key"[\s\S]{0,200}type="password"/);
  assert.match(source, /refreshSettings/);
  assert.match(source, /testHttp/);
  assert.match(source, /savePersonalization/);
  assert.match(source, /personalization: patch/);
  assert.doesNotMatch(source, /id="mem-(?:key|content|add-btn)"/);
  assert.match(source, /snapshot/);
  assert.match(source, /authFetch\(`\/api\/memories\/export/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*`[^`]*\$\{[^}]*apiKey/);
});
test("MCP Servers 页面支持全局暂停、单服务器启停、JSON 导入与弹窗编辑", async () => {
  const html = await readClientIndexHtml();
  // M4 4.2：MCP 面板迁往 Vue 组件，id/结构契约在组件模板上断言
  const source = await readClientFiles(["views/settings-mcp-vue.vue", "stores/mcp.ts"]);
  for (const id of [
    "mcp-summary", "mcp-global-enabled", "mcp-global-state", "mcp-import-btn",
    "mcp-import-file", "mcp-refresh-btn", "mcp-add-btn", "mcp-list",
    "mcp-editor-mask", "mcp-editor-title", "mcp-command-line", "mcp-command-parse",
    "mcp-command-preview", "mcp-command-preview-text", "mcp-id", "mcp-name", "mcp-command",
    "mcp-args", "mcp-approval", "mcp-editor-delete", "mcp-editor-save",
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), id);
  }
  assert.match(source, /accept="\.json,application\/json"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /\/api\/mcp\/import/);
  assert.match(source, /parseArgs/);
  assert.match(source, /envKeys/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /parseMcpCommandLine/);
  assert.match(source, /applyQuickCommandLine/);
  assert.match(source, /mcp-command-preview/);
  assert.match(source, /mcp-test-result/);
  assert.match(source, /测试中/);

  assert.doesNotMatch(source, /innerHTML/);
});
test("技能库支持上传、启停、分页与卡片删除", async () => {
  const html = await readClientIndexHtml();
  // M4 4.2：技能面板迁往 Vue 组件，id/结构契约在组件模板上断言
  const source = await readClientFiles(["views/settings-skills-vue.vue", "stores/skills.ts"]);
  for (const id of [
    "skills-refresh-btn", "skills-search", "skill-upload-btn", "skill-upload-file",
    "skills-count", "skills-list", "skills-pagination",
  ]) {
    assert.match(source, new RegExp(`id="${id}"`), id);
  }
  // 三个计数徽标用动态 id 绑定渲染（skills-count-all / -enabled / -disabled）
  assert.match(source, /:id="`skills-count-\$\{tab\}`"/);
  assert.match(source, /accept="\.md,\.markdown,text\/markdown"/);
  // 三个筛选 tab 用 v-for 动态绑定 data-skill-filter（all / enabled / disabled）
  assert.match(source, /:data-skill-filter="tab"/);
  assert.match(source, /\['all', 'enabled', 'disabled'\] as const/);
  assert.doesNotMatch(html, /id="skill-create-btn"/, "新建技能统一走 skill-creator");
  assert.doesNotMatch(html, /id="skill-editor-details"/, "设置页不再提供手写技能编辑表单");
  assert.doesNotMatch(html, /id="skill-(?:add|clear|delete)-btn"/);
  assert.match(source, /importFiles/);
  assert.match(source, /\/api\/skills\/import/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /skill-enabled-toggle/);
  assert.match(source, /SKILLS_PER_PAGE = 5/);
  // 分页/筛选/启停/删除语义在组件层保留（函数名随 Vue 化调整）
  assert.match(source, /const paginationTokens = computed/);
  assert.match(source, /function setFilter/);
  assert.match(source, /启用技能 \$\{skill\.name\}/);
  assert.match(source, /async function toggleEnabled/);
  assert.match(source, /async function removeSkill/);
  assert.match(source, /skill-delete-btn/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /skill\.path/);
  assert.doesNotMatch(source, /openSkillEditor|saveSkillFromForm|currentEditingId/);
});


test("子代理设置页支持列表、启停、新增编辑删除与继承/固定模型", async () => {
  const html = await readClientIndexHtml();
  // M4 4.2：子代理面板迁往 Vue 组件，id/结构契约在组件模板上断言
  const source = await readClientFiles(["views/settings-subagents-vue.vue", "stores/subagents.ts"]);
  const css = await readFile(new URL("styles/subagents.css", root), "utf8");
  for (const id of [
    "subagents-list", "subagents-empty", "subagents-empty-title", "subagents-empty-copy",
    "subagent-add-btn", "subagent-status", "subagent-stat-total", "subagent-stat-enabled",
    "subagent-stat-disabled", "subagent-search", "subagents-result-count",
    "subagent-editor-mask", "subagent-editor", "subagent-name", "subagent-description",
    "subagent-model-mode", "subagent-model-hint", "subagent-provider", "subagent-model",
    "subagent-enabled", "subagent-delete-btn", "subagent-save-btn",
  ]) assert.match(source, new RegExp(`id="${id}"`), id);
  const navSrc = await readClientFiles(["stores/settings.ts"]);
  assert.match(navSrc, /view: "subagents"/);
  assert.match(source, /value="inherit"/);
  assert.match(source, /value="fixed"/);
  assert.match(source, /\/api\/subagents/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /mode: "inherit"/);
  assert.match(source, /mode: "fixed", providerId, modelId/);
  assert.match(source, /type SubagentFilter = "all" \| "enabled" \| "disabled"/);
  assert.match(source, /const filteredAgents = computed/);
  assert.match(source, /data-subagent-filter/);
  assert.match(source, /function trapEditorFocus/);
  assert.match(source, /尚未保存，确定放弃本次修改/);
  assert.match(source, /运行时授权工具/);
  // 原生 textarea 默认约 20 列宽，必须显式占满字段，否则表单出现窄条并浪费横向空间。
  assert.match(css, /\.subagent-editor textarea\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.subagent-editor textarea\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.subagent-editor textarea\s*\{[^}]*resize:\s*vertical/s);
  assert.doesNotMatch(source, /innerHTML/);
});


test("思考快捷菜单只隐藏供应商默认并简化原生档位文案", () => {
  const levels = [
    { id: "default", label: "供应商默认", desc: "" },
    { id: "none", label: "不思考 (none)", desc: "" },
    { id: "low", label: "低 (low)", desc: "" },
    { id: "high", label: "高 (high)", desc: "" },
    { id: "max", label: "强度·最高 (max)", desc: "" },
  ];
  assert.deepEqual(
    visibleQuickReasoningLevels(levels).map((level) => level.id),
    ["none", "low", "high", "max"],
  );
  assert.equal(quickReasoningDisplayLabel(levels[1]), "不思考 (none)");
  assert.equal(quickReasoningDisplayLabel(levels[4]), "最高 (max)");
});
