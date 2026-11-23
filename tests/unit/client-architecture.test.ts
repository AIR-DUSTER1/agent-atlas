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
import { readClientIndexHtml } from "../helpers/client-html.js";

const ROOT = join(fileURLToPath(new URL("../../", import.meta.url)));
const CLIENT = join(ROOT, "src", "client");

/**
 * P0 迁移预算：只允许下降；新增文件默认预算为 0。
 * key 是相对 `src/client/` 的**当前**路径（views 已按页面重组进 views/<page>/）。
 * 搬页面时必须一起改这里 —— 旧 key 会静默 miss 成预算 0。
 */
const INNER_HTML_BUDGET: Record<string, number> = {
  "composer/menu.ts": 3,
  "render/messages.ts": 3,
  "render/parts.ts": 1,
  "views/chat/attachments.ts": 8,
  "views/chat/composer-bar.ts": 5,
  "views/estate/estate.ts": 3,
  "views/external/external.ts": 2,
  "views/settings/models/model-form.ts": 3,
  "views/settings/models/model-panel.ts": 8,
  "views/app/navigation.ts": 3,
  "views/app/projects.ts": 3,
  "views/kb/rag.ts": 11,
  "views/app/sessions.ts": 2,
  "views/settings/models/settings-backup.ts": 2,
  "views/settings/commands/settings-commands.ts": 0,
  "views/settings/mcp/settings-mcp.ts": 0,
  "views/settings/memories/settings-memories.ts": 2,
  "views/settings/skills/settings-skills.ts": 2,
  "views/welcome/shell.ts": 5,
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

// 框架迁移 M0：vendor 强制断言退役，改为「依赖清单守门」——
// 业务源码 import 的 npm 包必须在登记表内（新增依赖先登记再 import）。
const REGISTERED_CLIENT_PACKAGES = new Set([
  "chart.js", "lucide", "marked", "dompurify", "highlight.js",
  // M4 起引入（登记见 .plans/development-docs/engineering-standards.md §3）
  "vue", "pinia", "antdv-next",
]);

test("业务源码 import 的 npm 前端包必须在登记表内", async () => {
  const violations: string[] = [];
  for (const file of await listTs(CLIENT)) {
    const rel = relative(CLIENT, file).replaceAll("\\", "/");
    // 去掉注释再抓 import，避免 banner 里的示例路径误报
    const source = (await readFile(file, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
    for (const spec of importsOf(source)) {
      if (spec.startsWith(".") || spec.startsWith("#")) continue;
      // NodeNext 下相对导入写 .js 后缀；types-only 双引号 import 也可能是本地路径
      if (!spec.includes("/") && !spec.startsWith("@") && spec.endsWith(".js")) continue;
      const pkg = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0] ?? spec;
      if (!REGISTERED_CLIENT_PACKAGES.has(pkg)) violations.push(`${rel}: ${spec}`);
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
        // views 已按页面重组，房产实现可能位于 views/estate/ 或任意页面子目录
        if (/views\/(?:[^/]+\/)*estate|tools-estate|租金|rental/i.test(spec)) {
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
  const html = await readClientIndexHtml();
  assert.deepEqual(computeInlineScriptHashes(html), [...CSP_SCRIPT_HASHES]);
  const csp = SECURITY_HEADERS["Content-Security-Policy"] ?? "";
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(csp, /frame-src/);
  for (const hash of CSP_SCRIPT_HASHES) assert.ok(csp.includes(`'${hash}'`));
});

test("index.html 引用的样式全部进入构建产物", async () => {
  const html = await readClientIndexHtml();
  const linked = [...html.matchAll(/href=["']\/styles\/([^"'?#]+\.css)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1] ?? "");
  // styles 已按页面分到子目录：断言「文件名在引用列表里」，不苛求位置
  assert.ok(linked.some((n) => n.endsWith("subagents.css")), "子代理页样式必须由 index.html 显式引用");
  for (const name of linked) {
    const built = await readFile(join(ROOT, "src", "server", "public", "styles", name), "utf8").catch(() => "");
    assert.ok(built.trim().length > 0, `缺少构建样式产物：${name}`);
  }
  const buildScript = await readFile(join(ROOT, "scripts", "build-web.ts"), "utf8");
  // 样式按目录自动发现（递归收集，支持 base/ chat/ settings/<view>/ 子目录）
  assert.match(buildScript, /collect\(STYLE_DIR\)|readdir\(STYLE_DIR/);
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
test("旧 vendor 构建链已退役，不得回流", async () => {
  for (const path of ["scripts/build-vendor.ts", "scripts/vendor-entries.ts"]) {
    await assert.rejects(readFile(join(ROOT, path), "utf8"), `${path} 已由 Vite 取代，不得重新加入`);
  }
});

test("模型重试默认折叠且上下文容量保留历史 used", async () => {
  const parts = await readFile(join(CLIENT, "render", "parts.ts"), "utf8");
  assert.match(parts, /p: "model_retry"/);
  assert.match(parts, /document\.createElement\("details"\)/);
  assert.doesNotMatch(parts, /modelRetry[^\n]*\.open\s*=\s*true/);
  const events = await readFile(join(CLIENT, "stream", "events.ts"), "utf8");
  assert.match(events, /case "model_retry": upsertModelRetry/);
  assert.match(events, /u\.contextWindow = ev\.contextWindow/);
  const composer = await readFile(join(CLIENT, "views", "chat", "composer-bar.ts"), "utf8");
  // M4 4.6：容量条派生计算迁往 stores/context-meter.ts（组件只消费）
  const meter = await readFile(join(CLIENT, "stores", "chat", "context-meter.ts"), "utf8");
  assert.match(meter, /const scale = s\.inputBudget \?\? s\.contextWindow/);
  assert.match(composer, /inputBudget: u\.contextInputBudget/);
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

  // 不变式：任何切换模型的入口都必须先过 prepareModelSwitch。
  // 顶栏菜单不再自己调它，而是统一委托 activateModel —— 因此断言「委托链完整」，
  // 而不是「菜单文件里出现某个函数名」。后者只是实现位置：菜单曾绕过
  // activateModel 手写 POST .../models/:id，跨供应商时静默失效，而这条断言
  // 因为函数名还在文件里，一直是绿的。
  const menu = await readFile(join(CLIENT, "views", "chat", "composer-bar.ts"), "utf8");
  assert.match(menu, /activateModel\(p\.id, m\.id\)/, "顶栏菜单必须走统一的激活入口");
  assert.doesNotMatch(
    menu,
    /providers\/\$\{p\.id\}\/models\/\$\{m\.id\}/,
    "顶栏菜单不得绕过 activateModel 直接调模型更新接口（跨供应商时会静默失效）",
  );
  const actions = await readFile(join(CLIENT, "views", "settings", "models", "model-actions.ts"), "utf8");
  assert.match(actions, /prepareModelSwitch\(providerId, modelId\)/, "activateModel 必须保留切小窗口前的压缩守门");
});

test("客户端错误上报只发送摘要、版本身份与视图，不发送 stack/密钥/对话", async () => {
  const source = await readFile(join(CLIENT, "observability", "client-errors.ts"), "utf8");
  assert.doesNotMatch(source, /\.stack\b|Authorization|AUTH_TOKEN|localStorage|prompt/i);
  assert.match(source, /message:\s*summary/);
  assert.match(source, /version:\s*BUILD_INFO\.version/);
  assert.match(source, /commit:\s*BUILD_INFO\.commit/);
  assert.match(source, /buildId:\s*BUILD_INFO\.buildId/);
  assert.match(source, /view:\s*currentView\(\)/);
});
