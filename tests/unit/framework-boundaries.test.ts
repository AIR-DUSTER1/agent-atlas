/**
 * ============================================================
 * framework-boundaries.test.ts — 框架迁移红线守门（M0 落地）
 * ============================================================
 * 计划：`.plans/development-docs/framework-migration-plan.md` §4-M0。
 * 新技术栈红线必须能被 CI 自动拒绝：
 *  - Vue 组件与前端 TS 不得 import server；
 *  - 领域层（agent/memory/routing）不沾 hono/vue/antdv-next；
 *  - hono 系只允许出现在 src/server/**；
 *  - v-html 只允许出现在 DOMPurify 封装文件（白名单显式登记，新增需评审）；
 *  - routes 不 import node:fs（自 architecture.test.ts 迁移保留语义）。
 * M2 完成前为过渡期：旧顺序分发与新路由共存，import 形状差异在本文件白名单登记。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");

async function listFiles(dir: string, exts: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name === "public" || entry.name === "node_modules") continue;
    if (entry.isDirectory()) files.push(...await listFiles(full, exts));
    else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) files.push(full);
  }
  return files;
}

function relPath(file: string): string {
  return relative(ROOT, file).replaceAll("\\", "/");
}

/** v-html 白名单：只允许出现在 DOMPurify 封装指令文件内；新增条目必须先评审。 */
const V_HTML_WHITELIST: string[] = [];

test("前端源码不得 import 服务端模块（Vue 组件与旧 TS 同查）", async () => {
  const files = await listFiles(join(SRC, "client"), [".ts", ".vue"]);
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']*)["']/g)) {
      const spec = match[1] ?? "";
      if (/(^|\/)(server)(\/|\.ts)/.test(spec) || spec.includes("../server")) {
        violations.push(`${relPath(file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("领域层不得 import 框架（hono / vue / antdv-next / pinia）", async () => {
  const violations: string[] = [];
  for (const domain of ["agent", "memory", "routing"]) {
    for (const file of await listFiles(join(SRC, domain), [".ts"])) {
      const source = await readFile(file, "utf8");
      if (/\bfrom\s+["'](hono|@hono\/|vue|pinia|antdv-next|@antdv\/)/.test(source)) {
        violations.push(relPath(file));
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("hono 系依赖只允许出现在 src/server/**", async () => {
  const violations: string[] = [];
  for (const top of ["agent", "memory", "routing", "client"]) {
    for (const file of await listFiles(join(SRC, top), [".ts", ".vue"])) {
      const source = await readFile(file, "utf8");
      if (/\bfrom\s+["'](hono|@hono\/)/.test(source)) violations.push(relPath(file));
    }
  }
  for (const file of await listFiles(SRC, [".ts"])) {
    const rel = relPath(file);
    if (rel.startsWith("src/server/") || rel.startsWith("src/agent/") || rel.startsWith("src/memory/")
      || rel.startsWith("src/routing/") || rel.startsWith("src/client/")) continue;
    const source = await readFile(file, "utf8");
    if (/\bfrom\s+["'](hono|@hono\/)/.test(source)) violations.push(rel);
  }
  assert.deepEqual(violations, []);
});

test("v-html 只允许出现在 DOMPurify 封装白名单内（M4 起生效，当前应无 .vue 文件）", async () => {
  const vueFiles = await listFiles(join(SRC, "client"), [".vue"]);
  const violations: string[] = [];
  for (const file of vueFiles) {
    const source = await readFile(file, "utf8");
    if (/v-html/.test(source) && !V_HTML_WHITELIST.includes(relPath(file))) {
      violations.push(`${relPath(file)}：不在 v-html 白名单，新增必须先评审`);
    }
  }
  assert.deepEqual(violations, []);
});

test("守门自检：客户端存在 TS 源（防止目录被误删后断言空转）", async () => {
  const files = await listFiles(join(SRC, "client"), [".ts"]);
  assert.ok(files.length > 50, `client TS 源数量异常：${files.length}`);
});
