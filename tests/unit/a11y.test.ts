/**
 * a11y.test.ts — 可访问性与主题对比度回归
 * ============================================================
 * 守：主要表单控件有可访问名称、图标按钮有 label、消息流有 live region、
 * 焦点环与 reduced-motion 存在，并验证核心文字在深/浅主题达到 4.5:1。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../../src/client/${path}`, import.meta.url), "utf8");

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
  const html = await read("index.html");
  for (const id of [
    "input", "mem-key", "mem-content", "cmd-name", "cmd-template", "skill-upload-file", "skills-search",
    "mcp-id", "mcp-command", "kb-query", "ui-dialog-input",
  ]) {
    assert.match(html, new RegExp(`(?:input|textarea) id="${id}"[^>]*aria-label=`), id);
  }
  assert.match(html, /id="messages"[^>]*role="log"[^>]*aria-live="polite"/);
  assert.match(html, /id="status-dot"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("全局焦点环与 reduced-motion 由设计 token 提供", async () => {
  const css = await read("styles/tokens.css");
  assert.match(css, /:where\(button, a, input, textarea, select, \[tabindex\]\):focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /outline: 2px solid var\(--border-focus\)/);
});
