/**
 * tests/unit/core-file-budgets.test.ts — 核心文件职责边界护栏
 * ============================================================
 * 规模数字只是触发审计的信号；真正的规则是入口只做门面、页面只做根壳、
 * 每个节点/样式文件有单一职责。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readClientIndexHtml } from "../helpers/client-html.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT = join(ROOT, "src", "client");
const WORKFLOW = join(ROOT, "src", "agent", "workflow");
const STYLES = join(CLIENT, "styles");
const MAX_NODE_LINES = 300;
const MAX_PAGE_LINES = 300;
const MAX_CSS_LINES = 300;

async function filesUnder(dir: string, suffix: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(path);
  }
  return output;
}

async function lineCount(path: string): Promise<number> {
  return (await readFile(path, "utf8")).split(/\r?\n/).length - 1;
}

test("workflow 公共门面保持薄层，节点与职责文件不超过预算", async () => {
  const facade = await readFile(join(ROOT, "src", "agent", "workflow.ts"), "utf8");
  assert.ok((facade.split(/\r?\n/).length - 1) <= 80, "workflow.ts 应只保留公共 re-export");
  assert.doesNotMatch(facade, /StateGraph|Annotation\.Root|createAnalyzeNode|createReviewNode/);
  for (const file of await filesUnder(WORKFLOW, ".ts")) {
    assert.ok(await lineCount(file) <= MAX_NODE_LINES, `工作流模块超过 ${MAX_NODE_LINES} 行：${relative(ROOT, file)}`);
  }
});

test("HTML 入口保持薄壳，页面片段不超过预算", async () => {
  const source = await readFile(join(CLIENT, "index.html"), "utf8");
  assert.ok((source.split(/\r?\n/).length - 1) <= 120, "src/client/index.html 应只保留根壳与 include 清单");
  assert.match(source, /@include pages\//);
  assert.doesNotMatch(source, /id="settings-page"/, "设置页结构不能重新塞回入口");
  for (const file of await filesUnder(join(CLIENT, "pages"), ".html")) {
    assert.ok(await lineCount(file) <= MAX_PAGE_LINES, `页面片段超过 ${MAX_PAGE_LINES} 行：${relative(ROOT, file)}`);
  }
});

test("拆分后的 chat/settings 样式文件不超过预算，入口不引用旧单体文件", async () => {
  const styles = await readdir(STYLES, { withFileTypes: true });
  const splitStyles = styles
    .filter((entry) => entry.isFile() && /^(chat|settings)-.*\.css$/.test(entry.name))
    .map((entry) => join(STYLES, entry.name));
  assert.ok(splitStyles.length >= 10);
  for (const file of splitStyles) {
    assert.ok(await lineCount(file) <= MAX_CSS_LINES, `样式文件超过 ${MAX_CSS_LINES} 行：${relative(ROOT, file)}`);
  }
  const html = await readClientIndexHtml();
  assert.doesNotMatch(html, /\/styles\/(chat|settings)\.css/);
  const linked = [...html.matchAll(/href=["']\/styles\/([^"'?#]+\.css)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1] ?? "");
  const allCss = styles.filter((entry) => entry.isFile() && entry.name.endsWith(".css")).map((entry) => entry.name);
  assert.deepEqual([...new Set(linked)].sort(), allCss.sort(), "每个 CSS 必须且只能由入口引用一次");
});