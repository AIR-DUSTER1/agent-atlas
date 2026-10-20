/**
 * tests/unit/format.test.ts — 前端渲染纯函数（无 DOM）
 * ============================================================
 * 重点守两件事：① Markdown 先转义再解析，HTML/脚本注入不成立；
 * ② URL 白名单（javascript: / http:）与流式半截围栏的宽容渲染。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeHtml,
  fmtSize,
  fmtTokens,
  nodeIcon,
  renderInline,
  renderMarkdown,
  safeHref,
  safeImageSrc,
} from "../../src/server/public/modules/format.js";

test("escapeHtml：五个危险字符全部转义", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;'");
});

test("renderInline：代码/加粗/斜体/链接", () => {
  assert.equal(renderInline("`a<b`"), "<code>a&lt;b</code>");
  assert.equal(renderInline("**粗**"), "<strong>粗</strong>");
  assert.equal(renderInline("*斜*"), "<em>斜</em>");
  assert.equal(
    renderInline("[文档](https://example.com/a?b=1)"),
    '<a href="https://example.com/a?b=1" target="_blank" rel="noopener">文档</a>',
  );
});

test("renderMarkdown：标题/列表/表格/围栏代码", () => {
  assert.match(renderMarkdown("## 标题"), /<h2>标题<\/h2>/);
  assert.match(renderMarkdown("- a\n- b"), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(renderMarkdown("1. 一\n2. 二"), /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(
    renderMarkdown("|a|b|\n|---|---|\n|1|2|"),
    /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/,
  );
  const code = renderMarkdown("```ts\nconst a = 1 < 2;\n```");
  assert.match(code, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
});

test("renderMarkdown：HTML 注入被转义（不生成 script 标签）", () => {
  const html = renderMarkdown('<script>alert("x")</script>');
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
});

test("renderMarkdown：流式中途未闭合的围栏也能渲染成代码块", () => {
  const html = renderMarkdown("```js\nlet x = 1");
  assert.match(html, /<pre><code>let x = 1<\/code><\/pre>/);
});

test("safeHref：只放行 https，javascript:/http:/data: 一律 null", () => {
  assert.equal(safeHref("https://example.com"), "https://example.com");
  assert.equal(safeHref("http://example.com"), null);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref(undefined), null);
});

test("safeImageSrc：https 与 data:image 放行，其余拒绝", () => {
  assert.equal(safeImageSrc("https://img.example.com/a.png"), "https://img.example.com/a.png");
  assert.equal(safeImageSrc("data:image/png;base64,AA"), "data:image/png;base64,AA");
  assert.equal(safeImageSrc("http://img.example.com/a.png"), "");
  assert.equal(safeImageSrc("javascript:alert(1)"), "");
});

test("fmtTokens / fmtSize / nodeIcon 边界", () => {
  assert.equal(fmtTokens(null), "–");
  assert.equal(fmtTokens(9999), "9,999");
  assert.equal(fmtTokens(10000), "10.0k");
  assert.equal(fmtTokens(123456), "123k");
  assert.equal(fmtSize(999), "999 B");
  assert.equal(fmtSize(1536), "1.5 KB");
  assert.equal(fmtSize(2 * 1048576), "2.0 MB");
  assert.equal(nodeIcon("tools/toolnode"), "🔧");
  assert.equal(nodeIcon("unknown"), "⚙️");
});
