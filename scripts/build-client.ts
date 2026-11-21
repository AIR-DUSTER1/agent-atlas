/**
 * scripts/build-client.ts — 前端构建（框架迁移 M3：Vite 接管，源码不动）
 * ============================================================
 * 流程：compose 片段组装 → 注入构建身份 → CSP hash 校验 → 写 index.vite.html
 * → vite build（把 main.ts 及其依赖、vendor wrapper 的 npm 包打进 assets/）→
 * 复制 styles → 写 build-info → 产物自检。
 *
 * M3 变化：页面入口与依赖图由 Vite 打包（assets/app.js + 动态增强 chunk），
 * 类型检查仍由 `npm run typecheck`（tsc --noEmit）承担。
 * ⚠ 过渡期双产物（对计划「vendor 停止生成」的有意偏离，记入 agent-wiki）：
 * tool-rendering 等 e2e 仍通过 `import("/render/parts.js")` 旧 1:1 路径拿内部模块，
 * 所以 tsc 1:1 树与 vendor *-lib.js 继续产出，直到 M4 按批改写测试、M5 清底。
 * 动态加载红线不受影响：wrapper 的 await import(...) 由 Vite 分割成独立 chunk，
 * 「图表 / Markdown / 高亮不进首屏启动闭包」的语义保持。
 */
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { build as viteBuild } from "vite";
import { promisify } from "node:util";
import { buildVendors } from "./build-vendor.js";

const execFileAsync = promisify(execFile);
import { assertCspHashHtml } from "./csp-integrity.js";
import { composeHtml } from "./compose-html.js";
import { createBuildInfo, injectBuildInfoHtml, writeBuildInfo } from "../src/versioning.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "client");
const OUT = join(ROOT, "src", "server", "public");
const STYLE_DIR = join(SRC, "styles");
/** 组装后的临时入口：gitignore；vite 以它为 rollup input，构建后重命名为 index.html */
const COMPOSED_ENTRY = join(SRC, "index.vite.html");

/**
 * 样式按目录自动发现，禁止再维护第二份手写白名单。
 * 历史上 subagents.css 因为漏登记而 404，页面虽然能加载，交互却退化成裸文本。
 */
async function copyStyles(indexHtml: string): Promise<void> {
  const entries = await readdir(STYLE_DIR, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => entry.name)
    .sort();
  if (!names.length) throw new Error("styles/ 下没有可发布的 CSS 文件");

  await mkdir(join(OUT, "styles"), { recursive: true });
  for (const name of names) {
    await copyFile(join(STYLE_DIR, name), join(OUT, "styles", name));
  }

  const linked = [...indexHtml.matchAll(/href=["']\/styles\/([^"'?#]+\.css)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1] ?? "");
  const missing = linked.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new Error(`index.html 引用了未找到的样式：${[...new Set(missing)].join("、")}`);
  }
}

async function main(): Promise<void> {
  // 每次从空产物目录构建，防止已删除模块继续被静态服务
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 页面先组装并注入自动构建身份；CSP hash 必须针对最终 HTML 计算，否则片段迁移会白屏
  const buildInfo = await createBuildInfo({ root: ROOT });
  const indexHtml = injectBuildInfoHtml(await composeHtml(join(SRC, "index.html"), SRC), buildInfo);
  assertCspHashHtml(indexHtml);
  await writeFile(COMPOSED_ENTRY, indexHtml, "utf8");

  try {
    await viteBuild({
      configFile: join(ROOT, "vite.config.ts"),
      logLevel: "info",
    });
  } catch (err) {
    console.error("✗ Vite 构建失败");
    throw err;
  } finally {
    await rm(COMPOSED_ENTRY, { force: true });
  }

  // vite 以 input 文件名输出（index.vite.html）→ 重命名为 index.html（vite 版本，
  // 脚本引用已改写为 ./assets/app.js —— 不能再用 composed 文本覆盖回去）
  await rename(join(OUT, "index.vite.html"), join(OUT, "index.html"));

  // 过渡期双产物：tsc 1:1 树 + vendor 库（e2e 的内部模块导入依赖它们，见文件头说明）
  const tscBin = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  try {
    await execFileAsync(process.execPath, [tscBin, "-p", join(ROOT, "tsconfig.client.json")], {
      cwd: ROOT,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    console.error("✗ 前端 TypeScript 编译失败");
    process.exit(1);
  }
  await buildVendors();

  await copyStyles(indexHtml);
  await writeBuildInfo(ROOT, buildInfo);

  // 产物自检：入口 HTML / 打包脚本 / 样式必须存在，否则页面会白屏而 CI 仍是绿的
  const entries = await readdir(OUT, { withFileTypes: true });
  const names = entries.map((e) => e.name);
  if (!names.includes("index.html")) {
    console.error("✗ 构建产物缺少 index.html（vite input/outDir 是否被改过？）");
    process.exit(1);
  }
  const assets = await readdir(join(OUT, "assets")).catch(() => [] as string[]);
  if (!assets.includes("app.js")) {
    console.error("✗ 构建产物缺少 assets/app.js（rollup entryFileNames 是否被改过？）");
    process.exit(1);
  }
  const vendorEntries = await readdir(join(OUT, "vendor")).catch(() => [] as string[]);
  if (!vendorEntries.some((name) => name.endsWith("-lib.js"))) {
    console.error("✗ 过渡期双产物缺少 vendor 库（e2e 依赖 1:1 路径，见文件头说明）");
    process.exit(1);
  }
  console.log(`✓ 前端构建完成 → src/server/public/ (${buildInfo.version} · ${buildInfo.buildId})`);
}

void main();
