/**
 * client-architecture.test.ts — 前端依赖方向与迁移预算守门
 * ============================================================
 * 守：业务源码不得直连 npm 前端库；UI 原语不得依赖业务；通用水合/流层不得
 * import 房产实现；存量 innerHTML 只减不增；CSP 内联脚本 hash 与 index 同步。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { computeInlineScriptHashes } from "../../scripts/csp-integrity.js";
import { CSP_SCRIPT_HASHES } from "../../src/server/csp-hashes.js";
import { SECURITY_HEADERS } from "../../src/server/http-guard.js";
import { VENDOR_ENTRIES, VENDOR_WRAPPER_FILES } from "../../scripts/vendor-entries.js";

const ROOT = join(fileURLToPath(new URL("../../", import.meta.url)));
const CLIENT = join(ROOT, "src", "client");
const VENDOR_PACKAGES = new Set(["chart.js", "lucide", "marked", "dompurify", "highlight.js"]);

/** P0 迁移预算：只允许下降；新增文件默认预算为 0。 */
const INNER_HTML_BUDGET: Record<string, number> = {
  "composer/menu.ts": 3,
  "render/delegate-card.ts": 1,
  "render/messages.ts": 3,
  "render/parts.ts": 7,
  "views/attachments.ts": 9,
  "views/composer-bar.ts": 5,
  "views/estate.ts": 3,
  "views/external.ts": 2,
  "views/model-form.ts": 3,
  "views/model-menu.ts": 2,
  "views/model-panel.ts": 8,
  "views/navigation.ts": 3,
  "views/projects.ts": 3,
  "views/rag.ts": 11,
  "views/sessions.ts": 2,
  "views/settings-backup.ts": 2,
  "views/settings-commands.ts": 2,
  "views/settings-mcp.ts": 2,
  "views/settings-memories.ts": 2,
  "views/settings-skills.ts": 2,
  "views/settings-stats.ts": 10,
  "views/settings.ts": 2,
  "views/shell.ts": 5,
};

async function listTs(dir: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await listTs(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) output.push(path);
  }
  return output;
}

function importsOf(source: string): string[] {
  const specs: string[] = [];
  const staticImport = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticImport, dynamicImport]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) specs.push(match[1] ?? match[2] ?? "");
  }
  return specs;
}

test("业务源码只通过 client/vendor wrapper 使用 npm 前端库", async () => {
  const violations: string[] = [];
  for (const file of await listTs(CLIENT)) {
    const rel = relative(CLIENT, file).replaceAll("\\", "/");
    if (rel.startsWith("vendor/")) continue;
    for (const spec of importsOf(await readFile(file, "utf8"))) {
      if (VENDOR_PACKAGES.has(spec)) violations.push(`${rel}: ${spec}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("ui 原语不得依赖 state/api/views 或房产实现", async () => {
  const uiDir = join(CLIENT, "ui");
  let files: string[] = [];
  try { files = await listTs(uiDir); } catch { /* P0 时目录尚未创建 */ }
  const violations: string[] = [];
  for (const file of files) {
    for (const spec of importsOf(await readFile(file, "utf8"))) {
      if (/core\/(state|api)|views\/|estate/i.test(spec)) {
        violations.push(`${relative(CLIENT, file)}: ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("通用 render/stream 不 import 租房或房产实现", async () => {
  const violations: string[] = [];
  for (const sub of ["render", "stream"]) {
    for (const file of await listTs(join(CLIENT, sub))) {
      for (const spec of importsOf(await readFile(file, "utf8"))) {
        if (/views\/estate|tools-estate|租金|rental/i.test(spec)) {
          violations.push(`${relative(CLIENT, file)}: ${spec}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("存量 innerHTML / insertAdjacentHTML 只减不增", async () => {
  const violations: string[] = [];
  for (const file of await listTs(CLIENT)) {
    const rel = relative(CLIENT, file).replaceAll("\\", "/");
    const source = await readFile(file, "utf8");
    const count = (source.match(/\.innerHTML\s*=|insertAdjacentHTML\s*\(/g) ?? []).length;
    const budget = INNER_HTML_BUDGET[rel] ?? 0;
    if (count > budget) violations.push(`${rel}: ${count} > ${budget}`);
  }
  assert.deepEqual(violations, []);
});

test("CSP hash 与 index 内联脚本严格同步且不放行任意 inline script", async () => {
  const html = await readFile(join(CLIENT, "index.html"), "utf8");
  assert.deepEqual(computeInlineScriptHashes(html), [...CSP_SCRIPT_HASHES]);
  const csp = SECURITY_HEADERS["Content-Security-Policy"] ?? "";
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  for (const hash of CSP_SCRIPT_HASHES) assert.ok(csp.includes(`'${hash}'`));
});

test("vendor 清单输出名唯一且不与 tsc wrapper 冲突", () => {
  const outputs = VENDOR_ENTRIES.map((entry) => entry.outputFile);
  assert.equal(new Set(outputs).size, outputs.length);
  for (const wrapper of VENDOR_WRAPPER_FILES) assert.ok(!outputs.includes(wrapper));
});
