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

test("HTML 入口是唯一页面结构来源，体量受控且不再拆片段", async () => {
  const source = await readFile(join(CLIENT, "index.html"), "utf8");
  // M4 4.5 收尾：pages/ 片段组装退役，入口本身承载全部静态骨架。
  // 预算从 120 提到 420 是因为结构合并回来了；再涨说明又在往入口塞新面板 ——
  // 新面板应做成 Vue 组件 + 挂载容器，而不是往入口堆标记。
  assert.ok(
    (source.split(/\r?\n/).length - 1) <= 420,
    "src/client/index.html 静态骨架超预算，新面板请用 Vue 组件 + 挂载容器",
  );
  assert.doesNotMatch(source, /@include pages\//, "include 片段机制已退役");
  assert.match(source, /id="settings-page"/, "设置页骨架应在入口内");
  // pages/ 目录不允许回流（回流等于把入口拆成两处维护）
  const pagesExists = await readdir(join(CLIENT, "pages")).then(() => true).catch(() => false);
  assert.equal(pagesExists, false, "src/client/pages 已随 M4 4.5 退役");
});

/** 递归收集 styles/ 下的 CSS，返回相对 styles/ 的路径（含子目录）。 */
async function collectCss(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await collectCss(join(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith(".css")) out.push(rel);
  }
  return out;
}

test("拆分后的 chat/settings 样式文件不超过预算，入口不引用旧单体文件", async () => {
  // styles/ 已按页面分到 base/ chat/ settings/<view>/ 等子目录，必须递归统计。
  const allCss = (await collectCss(STYLES)).sort();
  const splitStyles = allCss.filter((rel) => /(^|\/)(chat|settings)[-\w]*\.css$/.test(rel.split("/").pop() ?? ""));
  assert.ok(splitStyles.length >= 10, `chat/settings 拆分样式数量异常：${splitStyles.length}`);
  for (const rel of splitStyles) {
    assert.ok(await lineCount(join(STYLES, rel)) <= MAX_CSS_LINES, `样式文件超过 ${MAX_CSS_LINES} 行：styles/${rel}`);
  }
  const html = await readClientIndexHtml();
  // 旧单体文件不得回流（styles/chat.css 与 styles/settings.css 顶层路径）
  assert.doesNotMatch(html, /\/styles\/(chat|settings)\.css/);
  const linked = [...html.matchAll(/href=["']\/styles\/([^"'?#]+\.css)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1] ?? "");
  assert.deepEqual([...new Set(linked)].sort(), allCss, "每个 CSS 必须且只能由入口引用一次");
});

test("styles 目录按页面分类，根目录不得平铺 CSS", async () => {
  // 与 views/ 同构：styles/ 根目录只允许存在子目录（分类目录装全部 CSS）。
  const entries = await readdir(STYLES, { withFileTypes: true });
  const stray = entries.filter((e) => e.isFile() && e.name.endsWith(".css")).map((e) => e.name);
  assert.deepEqual(stray, [], `styles/ 根目录不应再有 CSS，请并入对应分类目录：${stray.join("、")}`);
});