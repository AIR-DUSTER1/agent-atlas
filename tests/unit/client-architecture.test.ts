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
  "render/messages.ts": 3,
  "render/parts.ts": 1,
  "views/attachments.ts": 8,
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
  "views/settings-commands.ts": 0,
  "views/settings-mcp.ts": 0,
  "views/settings-memories.ts": 2,
  "views/settings-skills.ts": 2,
  "views/settings-stats.ts": 10,
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

test("index.html 引用的样式全部进入构建产物", async () => {
  const html = await readFile(join(CLIENT, "index.html"), "utf8");
  const linked = [...html.matchAll(/href=["']\/styles\/([^"'?#]+\.css)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1] ?? "");
  assert.ok(linked.includes("subagents.css"), "子代理页样式必须由 index.html 显式引用");
  for (const name of linked) {
    const built = await readFile(join(ROOT, "src", "server", "public", "styles", name), "utf8").catch(() => "");
    assert.ok(built.trim().length > 0, `缺少构建样式产物：${name}`);
  }
  const buildScript = await readFile(join(ROOT, "scripts", "build-client.ts"), "utf8");
  assert.match(buildScript, /readdir\(STYLE_DIR/);
  assert.match(buildScript, /index\.html 引用了未找到的样式/);
});
test("委派卡覆盖运行中与完成态且不拼 HTML", async () => {
  const source = await readFile(join(CLIENT, "render", "delegate-card.ts"), "utf8");
  assert.match(source, /const pending = !part\.result/);
  assert.match(source, /dataset: \{ delegateState: stateClass \}/);
  assert.match(source, /正在等待主 Agent 下发完整任务与工具子集/);
  assert.match(source, /payload\?\.usage\?\.totalTokens/);
  assert.match(source, /toolsUsed/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});
test("vendor 清单输出名唯一且不与 tsc wrapper 冲突", () => {
  const outputs = VENDOR_ENTRIES.map((entry) => entry.outputFile);
  assert.equal(new Set(outputs).size, outputs.length);
  for (const wrapper of VENDOR_WRAPPER_FILES) assert.ok(!outputs.includes(wrapper));
});

test("模型重试默认折叠且上下文容量保留历史 used", async () => {
  const parts = await readFile(join(CLIENT, "render", "parts.ts"), "utf8");
  assert.match(parts, /p: "model_retry"/);
  assert.match(parts, /document\.createElement\("details"\)/);
  assert.doesNotMatch(parts, /modelRetry[^\n]*\.open\s*=\s*true/);
  const events = await readFile(join(CLIENT, "stream", "events.ts"), "utf8");
  assert.match(events, /case "model_retry": upsertModelRetry/);
  assert.match(events, /u\.contextWindow = ev\.contextWindow/);
  const composer = await readFile(join(CLIENT, "views", "composer-bar.ts"), "utf8");
  assert.match(composer, /const inputBudget = u\.contextInputBudget/);
  assert.match(composer, /const scale = inputBudget \?\? win/);
  assert.match(composer, /contextInputBudget = cfg\.contextBudget\?\.inputBudgetTokens/);
  assert.match(composer, /usage\.contextWindow = cfg\.contextWindow/);
  assert.match(composer, /targetChanged = previousProvider\?\.id !== nextProvider\?\.id/);
  assert.match(composer, /usage\.contextPending = true/);
  const turn = await readFile(join(CLIENT, "stream", "turn.ts"), "utf8");
  assert.match(turn, /contextTokens: previousUsage\?\.contextTokens/);
  assert.match(turn, /contextWindow: state\.config\?\.contextWindow/);
  assert.match(turn, /contextPending: true/);
  assert.doesNotMatch(turn, /context-bar.*classList\.add\("hidden"\)/, "发送等待期保留 ZCode 式历史 context meter");
  const streamEvents = await readFile(join(CLIENT, "stream", "events.ts"), "utf8");
  assert.match(streamEvents, /u\.contextPending \|\| !u\.contextTokens/);
  assert.match(streamEvents, /u\.contextPending = false/);
});

test("切换更小窗口模型前走 ZCode 式压缩守门", async () => {
  const guard = await readFile(join(CLIENT, "actions", "model-switch.ts"), "utf8");
  assert.match(guard, /contextInputBudget/);
  assert.match(guard, /输出预留/);
  assert.match(guard, /used <= available/);
  assert.match(guard, /compactContext\(\)/);
  assert.match(guard, /完整聊天记录仍保留/);
  const compact = await readFile(join(CLIENT, "actions", "compact.ts"), "utf8");
  assert.match(compact, /Promise<boolean>/);
  const menu = await readFile(join(CLIENT, "views", "composer-bar.ts"), "utf8");
  assert.match(menu, /prepareModelSwitch\(p\.id, m\.id\)/);
});

test("客户端错误上报只发送摘要、版本与视图，不发送 stack/密钥/对话", async () => {
  const source = await readFile(join(CLIENT, "observability", "client-errors.ts"), "utf8");
  assert.doesNotMatch(source, /\.stack\b|Authorization|AUTH_TOKEN|localStorage|prompt/i);
  assert.match(source, /message:\s*summary/);
  assert.match(source, /version:\s*APP_VERSION/);
  assert.match(source, /view:\s*currentView\(\)/);
});
