/**
 * markdown-security.test.ts — Markdown 净化与高亮降级契约
 * ============================================================
 * Node 没有 DOM，因此不在这里执行 DOMPurify；这里守浏览器实现的关键结构：
 * 动态加载 vendor wrapper、显式标签/属性 allowlist、URL hook、外链加固，
 * 以及高亮库失败时仍保留代码与复制按钮。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path: string): Promise<string> =>
  readFile(new URL(`../../src/client/${path}`, import.meta.url), "utf8");

test("Markdown 使用 marked + DOMPurify 动态加载并显式净化", async () => {
  const source = await read("modules/format.ts");
  assert.match(source, /import\("\.\.\/vendor\/markdown\.js"\)/);
  assert.match(source, /DOMPurify\.sanitize\(raw/);
  assert.match(source, /ALLOWED_TAGS: MARKDOWN_TAGS/);
  assert.match(source, /ALLOWED_ATTR: MARKDOWN_ATTRS/);
  assert.match(source, /FORBID_TAGS: \["script", "style", "iframe", "object", "embed", "form"\]/);
  assert.match(source, /afterSanitizeAttributes/);
  assert.match(source, /noopener noreferrer/);
  assert.match(source, /safeUrlImage/);
});

test("Markdown 加载失败继续使用安全 fallback，不阻断消息", async () => {
  const source = await read("modules/format.ts");
  assert.match(source, /let enhancedMarkdownRenderer: MarkdownRenderer \| null = null/);
  assert.match(source, /catch\(\(\) => \{/);
  assert.match(source, /return enhancedMarkdownRenderer \? enhancedMarkdownRenderer\(src\) : renderMarkdownFallback\(src\)/);
});

test("代码高亮动态加载，失败仍保留代码和复制按钮", async () => {
  const source = await read("render/code-enhance.ts");
  assert.match(source, /import\("\.\.\/vendor\/highlight\.js"\)/);
  assert.match(source, /\.catch\(\(\) => null\)/);
  assert.match(source, /代码已复制/);
  assert.match(source, /class: "code-copy-btn"/);
  assert.match(source, /highlightElement\(item\.code\)/);
});
