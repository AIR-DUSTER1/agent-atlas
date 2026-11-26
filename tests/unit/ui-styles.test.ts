/**
 * ui-styles.test.ts — 拆分样式与图标清单完整性
 * ============================================================
 * 守：index 只引用拆分后的样式、文件真实存在、花括号平衡；HTML 中所有
 * data-icon 都必须在 ui/icons 白名单导出，避免线上出现空图标。
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readClientIndexHtml } from "../helpers/client-html.js";

const CLIENT = join(fileURLToPath(new URL("../../src/client/", import.meta.url)));

/** 递归收集 styles/ 下的 CSS 相对路径（styles 已按页面分到子目录）。 */
async function collectCss(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await collectCss(join(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith(".css")) out.push(rel);
  }
  return out;
}

test("index 样式全部位于 styles 且构建文件存在", async () => {
  const html = await readClientIndexHtml();
  const links = [...html.matchAll(/<link rel="stylesheet" href="\/styles\/([a-z0-9/-]+\.css)"/g)].map((match) => match[1] ?? "");
  assert.ok(links.length >= 10);
  // 层叠顺序契约：tokens 最先、ui 最后（分类后仍在同一顺序链里）
  assert.ok(links[0]?.endsWith("tokens.css"), `首个样式应为 tokens.css，实际 ${links[0]}`);
  assert.ok(links[1]?.endsWith("reset.css"), `第二个样式应为 reset.css，实际 ${links[1]}`);
  assert.ok(links.at(-1)?.endsWith("ui.css"), `最后一个样式应为 ui.css，实际 ${links.at(-1)}`);
  const actual = (await collectCss(join(CLIENT, "styles"))).sort();
  assert.deepEqual([...new Set(links)].sort(), actual, "每个 CSS 必须且只能由入口引用一次");
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
    (await collectCss(dir)).map((rel) => readFile(join(dir, rel), "utf8")),
  )).join("\n");
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] ?? ""));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1] ?? ""));
  // 这两个由脚本内联设置（icon.ts 的 size、stats 条形宽度），且都带 fallback
  const RUNTIME_INJECTED = new Set(["--icon-size", "--bar-width"]);
  const missing = [...used].filter((name) => !defined.has(name) && !RUNTIME_INJECTED.has(name));
  assert.deepEqual(missing, [], `以下 CSS 变量既未定义也非运行时注入：${missing.join(", ")}`);
});

test("配置表单公共组件共享高度、焦点环与占位样式", async () => {
  const css = await readFile(join(CLIENT, "styles", "base", "ui.css"), "utf8");
  assert.match(css, /配置表单公共组件：ui\/config-control\.ts/);
  assert.match(css, /\.ui-config-control\s*\{\s*min-height:\s*38px/s);
  assert.match(css, /\.ui-config-textarea\s*\{[^}]*resize:\s*vertical/s);
  assert.match(css, /\.ui-config-control:focus[\s\S]*?border-color:\s*var\(--border-focus\)[^}]*box-shadow:\s*0 0 0 3px var\(--info-bg\)/s);
  assert.match(css, /\.ui-config-control::placeholder[\s\S]*?color:\s*var\(--text-3\)/s);
});

test("新建对话按钮跨主题保持固定高度、可见边框且不产生侧栏抖动", async () => {
  const [layout, tokens] = await Promise.all([
    readFile(join(CLIENT, "styles", "base", "layout.css"), "utf8"),
    readFile(join(CLIENT, "styles", "base", "tokens.css"), "utf8"),
  ]);
  assert.match(layout, /#new-chat-btn\s*\{[^}]*display:\s*inline-flex[^}]*height:\s*37px[^}]*border:\s*1px dashed/s);
  assert.match(layout, /#new-chat-btn\s*\{[^}]*background:\s*color-mix\([^}]*--accent/s);
  assert.doesNotMatch(tokens, /--border-strong:\s*var\(--border-strong\)/);
});

test("房产弹窗操作按钮统一高度并对齐，状态独占下一行", async () => {
  const css = await readFile(join(CLIENT, "styles", "settings", "plugins", "plugins.css"), "utf8");
  assert.match(css, /#estate-modal \.kb-actions[^}]*align-items:\s*stretch[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /#estate-modal \.kb-actions > button[^}]*min-height:\s*36px[^}]*margin-top:\s*0/s);
  assert.match(css, /#estate-modal \.kb-actions > \.settings-status[^}]*flex:\s*1 1 100%/s);
});

test("知识库操作按钮统一高度并对齐，避免测试连接被默认上边距推偏", async () => {
  const css = await readFile(join(CLIENT, "styles", "settings", "plugins", "plugins.css"), "utf8");
  assert.match(css, /\.kb-actions > button[^}]*display:\s*inline-flex[^}]*min-height:\s*36px[^}]*margin-top:\s*0/s);
  assert.match(css, /\.kb-actions > button[^}]*box-sizing:\s*border-box/s);
});

test("求职登录提示使用高对比警示底色，避免黄底灰字看不清", async () => {
  const css = await readFile(join(CLIENT, "styles", "settings", "job", "settings-job.css"), "utf8");
  assert.match(css, /\.job-fix-hint\s*\{[^}]*background:\s*var\(--warning-bg\)[^}]*color:\s*var\(--content-1\)[^}]*font-size:\s*var\(--font-md\)/s);
  assert.doesNotMatch(css, /\.job-fix-hint\s*\{[^}]*background:\s*var\(--amber-soft\)/s);
});

test("贝壳登录失效显示为需要处理并自动展开登录入口", async () => {
  const [css, estate] = await Promise.all([
    readFile(join(CLIENT, "styles", "chat", "chat-tools.css"), "utf8"),
    readFile(join(CLIENT, "views", "estate", "estate.ts"), "utf8"),
  ]);
  assert.match(css, /\.tool-card\.needs-approval,[\s\S]*?\.tool-card\.needs-action\s*\{[^}]*border-left-color:\s*var\(--amber\)/s);
  assert.match(css, /\.tool-group-status\.warn\s*\{[^}]*color:\s*var\(--amber\)/s);
  assert.match(estate, /card\.classList\.add\("needs-action", "open", "estate-auth-required"\)/);
  assert.match(estate, /status\.textContent = "🔐 需要登录"/);
  assert.match(estate, /settingsButton\.textContent = "打开找房数据源设置"/);
});
test("HTML data-icon 均在 Lucide 白名单中导出", async () => {
  const html = await readClientIndexHtml();
  const iconsSource = await readFile(join(CLIENT, "ui", "icons.ts"), "utf8");
  const exported = new Set(
    iconsSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/[A-Z][A-Za-z0-9]*/g) ?? [],
  );
  const used = new Set([...html.matchAll(/data-icon="([A-Za-z0-9]+)"/g)].map((match) => match[1] ?? ""));
  const missing = [...used].filter((name) => !exported.has(name));
  assert.deepEqual(missing, []);
});
