/**
 * tests/unit/html-compose.test.ts — 客户端入口 HTML 结构回归
 * ============================================================
 * M4 4.5 收尾后 pages/ 片段组装已退役：index.html 就是唯一入口，Vite 直接消费。
 * 本文件继续守「入口结构完整 + 标签配对」，并新增反向断言防止有人把片段机制
 * 加回来（那会重新引入「源码入口与实际页面不一致」的调试陷阱）。
 */
import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = fileURLToPath(new URL("../../src/client/", import.meta.url));

async function readIndex(): Promise<string> {
  return readFile(new URL("../../src/client/index.html", import.meta.url), "utf8");
}

test("入口 div/section 配对平衡（手改防回归）", async () => {
  const html = await readIndex();
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["div", "section", "aside", "nav", "form", "fieldset", "main", "header", "footer"]) {
    const opens = (stripped.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
    const closes = (stripped.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    assert.equal(opens, closes, `${tag} 标签不配对：${opens} 开 / ${closes} 闭（某处收尾标签被改坏）`);
  }
});

test("入口包含完整页面结构，且不再使用 include 片段机制", async () => {
  const html = await readIndex();
  assert.match(html, /<title>agentatlas<\/title>/);
  assert.match(html, /id="settings-page"/);
  assert.match(html, /id="plugin-list"/);
  // M4 4.4：kb-modal 由 Vue 组件渲染（骨架保留 #kb-mask 挂载容器）
  assert.match(html, /id="kb-mask"/);
  const kbVue = await readFile(new URL("../../src/client/views/kb/kb-panel-vue.vue", import.meta.url), "utf8");
  assert.match(kbVue, /id="kb-modal"/);
  // M4 4.4：job-fix-hint 随求职弹窗迁往 Vue 组件
  assert.match(html, /id="job-mask"/);
  const jobVue = await readFile(new URL("../../src/client/views/job/job-panel-vue.vue", import.meta.url), "utf8");
  assert.match(jobVue, /id="job-fix-hint"/);
  // M4 4.5 收尾：include 机制退役 —— 入口里不得再出现 @include 标记
  assert.doesNotMatch(html, /<!--\s*@include\s+/);
});

test("pages/ 片段目录与组装脚本不得回流", async () => {
  // 机制退役的硬约束：目录/脚本任一个回来，就说明入口又被拆成两处维护
  for (const path of [join(CLIENT, "pages"), join(CLIENT, "..", "..", "scripts", "compose-html.ts")]) {
    const exists = await lstat(path).then(() => true).catch(() => false);
    assert.equal(exists, false, `${path} 已随 M4 4.5 退役，不允许回流`);
  }
});
