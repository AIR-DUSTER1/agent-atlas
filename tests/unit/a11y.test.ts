/**
 * a11y.test.ts — 可访问性与主题对比度回归
 * ============================================================
 * 守：主要表单控件有可访问名称、图标按钮有 label、消息流有 live region、
 * 焦点环与 reduced-motion 存在，并验证核心文字在深/浅主题达到 4.5:1。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readClientIndexHtml } from "../helpers/client-html.js";
import { resolveClientPath } from "../helpers/client-source.js";

// views/ 已按页面重组进 views/<page>/：统一经 resolveClientPath 解析，
// 避免每个断言都写死页面目录名。
const read = async (path: string): Promise<string> =>
  readFile(new URL(`../../src/client/${await resolveClientPath(path)}`, import.meta.url), "utf8");

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * (linear[0] ?? 0) + .7152 * (linear[1] ?? 0) + .0722 * (linear[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test("核心正文与弱化文字满足 WCAG AA 4.5:1", () => {
  assert.ok(contrast("#e6e6ea", "#1b1c1f") >= 4.5);
  assert.ok(contrast("#8a8a94", "#232428") >= 4.5);
  assert.ok(contrast("#242830", "#f7f8fa") >= 4.5);
  assert.ok(contrast("#6b7280", "#ffffff") >= 4.5);
});

test("表单控件具有可访问名称，消息流与状态点使用 live region", async () => {
  const html = await readClientIndexHtml();
  // M4 4.1/4.2：迁往 Vue 组件的面板，字段可访问名称在组件模板上断言
  for (const id of [
    "input", "ui-dialog-input",
  ]) {
    assert.match(html, new RegExp(`(?:input|textarea) id="${id}"[^>]*aria-label=`), id);
  }
  // M4 4.4：kb-query 随知识库弹窗迁往 Vue 组件
  const kbVue = await read("views/kb-panel-vue.vue");
  assert.match(kbVue, /id="kb-query"[^>]*aria-label="知识库检索问题"/, "kb-query");
  const mcpVue = await read("views/settings-mcp-vue.vue");
  assert.match(mcpVue, /id="mcp-id"[\s\S]{0,300}aria-label="MCP 服务器标识"/, "mcp-id");
  assert.match(mcpVue, /id="mcp-command"[\s\S]{0,300}aria-label="MCP 启动命令"/, "mcp-command");
  const commandsVue = await read("views/settings-commands-vue.vue");
  assert.match(commandsVue, /id="cmd-name"[\s\S]{0,400}aria-label="命令名"/, "cmd-name");
  assert.match(commandsVue, /id="cmd-template"[\s\S]{0,400}aria-label="命令模板"/, "cmd-template");
  const skillsVue = await read("views/settings-skills-vue.vue");
  assert.match(skillsVue, /id="skill-upload-file"[\s\S]{0,500}aria-label="选择技能文件"/, "skill-upload-file");
  assert.match(skillsVue, /id="skills-search"[\s\S]{0,300}aria-label="搜索技能"/, "skills-search");
  assert.match(html, /id="messages"[^>]*role="log"[^>]*aria-live="polite"/);
  assert.match(html, /id="status-dot"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("全局焦点环与 reduced-motion 由设计 token 提供", async () => {
  const css = await read("styles/base/tokens.css");
  assert.match(css, /:where\(button, a, input, textarea, select, \[tabindex\]\):focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /outline: 2px solid var\(--border-focus\)/);
});
