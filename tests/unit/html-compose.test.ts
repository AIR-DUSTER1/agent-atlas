/**
 * tests/unit/html-compose.test.ts — 页面片段组装安全回归
 * ============================================================
 * 守：入口能组合出完整页面；include 不能越界、不能跟随符号链接、不能循环。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composeHtml } from "../../scripts/compose-html.js";

const CLIENT = fileURLToPath(new URL("../../src/client/", import.meta.url));

test("组合产物 div/section 配对平衡（片段手改防回归）", async () => {
  const html = await composeHtml(join(CLIENT, "index.html"), CLIENT);
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["div", "section", "aside", "nav", "form", "fieldset"]) {
    const opens = (stripped.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
    const closes = (stripped.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    assert.equal(opens, closes, `${tag} 标签不配对：${opens} 开 / ${closes} 闭（某个片段的收尾标签被改坏）`);
  }
});

test("源码入口可组装出完整页面且不保留 include 标记", async () => {
  const html = await composeHtml(join(CLIENT, "index.html"), CLIENT);
  assert.match(html, /<title>agentatlas<\/title>/);
  assert.match(html, /id="settings-page"/);
  assert.match(html, /id="plugin-list"/);
  // M4 4.4：kb-modal 由 Vue 组件渲染（骨架保留 #kb-mask 挂载容器）
  assert.match(html, /id="kb-mask"/);
  const kbVue = await readFile(new URL("../../src/client/views/kb-panel-vue.vue", import.meta.url), "utf8");
  assert.match(kbVue, /id="kb-modal"/);
  // M4 4.4：job-fix-hint 随求职弹窗迁往 Vue 组件
  assert.match(html, /id="job-mask"/);
  const jobVue = await readFile(new URL("../../src/client/views/job-panel-vue.vue", import.meta.url), "utf8");
  assert.match(jobVue, /id="job-fix-hint"/);
  assert.doesNotMatch(html, /<!--\s*@include\s+/);
});

test("HTML include 检测循环引用", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-html-compose-"));
  try {
    const pages = join(root, "pages");
    await mkdir(pages, { recursive: true });
    await writeFile(join(root, "index.html"), "<!-- @include pages/a.html -->", "utf8");
    await writeFile(join(pages, "a.html"), "<!-- @include b.html -->", "utf8");
    await writeFile(join(pages, "b.html"), "<!-- @include a.html -->", "utf8");
    await assert.rejects(() => composeHtml(join(root, "index.html"), root), /循环引用/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTML include 拒绝越出 pages 的路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-html-compose-"));
  try {
    const pages = join(root, "pages");
    await mkdir(pages, { recursive: true });
    await writeFile(join(root, "secret.html"), "secret", "utf8");
    await writeFile(join(root, "index.html"), "<!-- @include pages/../secret.html -->", "utf8");
    await assert.rejects(() => composeHtml(join(root, "index.html"), root), /越出 pages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});