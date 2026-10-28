/**
 * ui-styles.test.ts — 拆分样式与图标清单完整性
 * ============================================================
 * 守：index 只引用拆分后的样式、文件真实存在、花括号平衡；HTML 中所有
 * data-icon 都必须在 vendor/icons 白名单导出，避免线上出现空图标。
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLIENT = join(fileURLToPath(new URL("../../src/client/", import.meta.url)));

test("index 样式全部位于 styles 且构建文件存在", async () => {
  const html = await readFile(join(CLIENT, "index.html"), "utf8");
  const links = [...html.matchAll(/<link rel="stylesheet" href="\/styles\/([a-z-]+\.css)"/g)].map((match) => match[1] ?? "");
  assert.ok(links.length >= 10);
  assert.deepEqual(links.slice(0, 2), ["tokens.css", "reset.css"]);
  assert.equal(links.at(-1), "ui.css");
  const actual = (await readdir(join(CLIENT, "styles"))).filter((name) => name.endsWith(".css")).sort();
  assert.deepEqual([...new Set(links)].sort(), actual);
  assert.doesNotMatch(html, /href="\/style\.css"/);
});

test("拆分后的 CSS 花括号平衡且无 @import 隐式依赖", async () => {
  for (const file of await readdir(join(CLIENT, "styles"))) {
    if (!file.endsWith(".css")) continue;
    const css = await readFile(join(CLIENT, "styles", file), "utf8");
    const opens = (css.match(/\{/g) ?? []).length;
    const closes = (css.match(/\}/g) ?? []).length;
    assert.equal(opens, closes, `${file} 花括号不平衡`);
    assert.doesNotMatch(css, /@import\s/, `${file} 不应依赖隐式 @import`);
  }
});

test("CSS 变量要么在样式里定义，要么由运行时内联注入", async () => {
  const dir = join(CLIENT, "styles");
  const css = (await Promise.all(
    (await readdir(dir)).filter((name) => name.endsWith(".css"))
      .map((name) => readFile(join(dir, name), "utf8")),
  )).join("\n");
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] ?? ""));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1] ?? ""));
  // 这两个由脚本内联设置（icon.ts 的 size、stats 条形宽度），且都带 fallback
  const RUNTIME_INJECTED = new Set(["--icon-size", "--bar-width"]);
  const missing = [...used].filter((name) => !defined.has(name) && !RUNTIME_INJECTED.has(name));
  assert.deepEqual(missing, [], `以下 CSS 变量既未定义也非运行时注入：${missing.join(", ")}`);
});

test("HTML data-icon 均在 Lucide 白名单中导出", async () => {
  const html = await readFile(join(CLIENT, "index.html"), "utf8");
  const iconsSource = await readFile(join(CLIENT, "vendor", "icons.ts"), "utf8");
  const exported = new Set(
    iconsSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/[A-Z][A-Za-z0-9]+/g) ?? [],
  );
  const used = new Set([...html.matchAll(/data-icon="([A-Za-z0-9]+)"/g)].map((match) => match[1] ?? ""));
  const missing = [...used].filter((name) => !exported.has(name));
  assert.deepEqual(missing, []);
});
