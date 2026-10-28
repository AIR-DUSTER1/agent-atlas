/**
 * ============================================================
 * release-check.ts — 生产镜像发布前自检
 * ============================================================
 * 职责：在不启动 HTTP 服务的前提下检查运行镜像是否满足发布契约。
 * 设计立场：
 *  - 检查生产环境变量、必需静态产物、数据目录可写与非 root；
 *  - 反向检查 Electron / TypeScript / tests / docs 等不应进入运行镜像的内容；
 *  - 只输出结构化 JSON，不打印密钥或环境变量值，适合 CI 与容器 smoke test。
 */
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWritableDirectories,
  productionEnvironmentChecks,
  type ReadinessCheck,
} from "./production.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 缺任意一项都会造成登录页白屏、图表失效或 CSP import map 断裂。 */
export const REQUIRED_RUNTIME_ASSETS = [
  "src/server/index.ts",
  "src/agent/general.ts",
  "scripts/data-cli.ts",
  "src/server/public/index.html",
  "src/server/public/main.js",
  "src/server/public/vendor/chart.js",
  "src/server/public/vendor/chart-lib.js",
  "src/server/public/vendor/icons.js",
  "src/server/public/vendor/icons-lib.js",
  "src/server/public/vendor/markdown.js",
  "src/server/public/vendor/marked-lib.js",
  "src/server/public/vendor/dompurify-lib.js",
  "src/server/public/vendor/highlight.js",
  "src/server/public/vendor/highlight-lib.js",
  "src/server/public/styles/tokens.css",
  "src/server/public/styles/reset.css",
  "src/server/public/styles/layout.css",
  "src/server/public/styles/typography.css",
  "src/server/public/styles/chat.css",
  "src/server/public/styles/composer.css",
  "src/server/public/styles/modals.css",
  "src/server/public/styles/settings.css",
  "src/server/public/styles/plugins.css",
  "src/server/public/styles/responsive.css",
  "src/server/public/styles/desktop.css",
  "src/server/public/styles/ui.css",
] as const;

/** 运行镜像只允许生产依赖；这些路径出现即说明 Docker 分层或依赖分类回退了。 */
export const FORBIDDEN_RUNTIME_PATHS = [
  "node_modules/electron",
  "node_modules/typescript",
  "tests",
  "docs",
  "desktop",
  ".plans",
  ".env",
  ".web-config.json",
  "src/client",
] as const;

export interface ProductionReleaseCheckOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试注入；Linux 容器应为非 0。Windows 没有 uid，传 null 表示跳过。 */
  processUid?: number | null;
  platform?: NodeJS.Platform;
}

function result(id: string, ok: boolean, message: string, category: ReadinessCheck["category"]): ReadinessCheck {
  return { id, ok, message, category };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function dataFiles(root: string, env: NodeJS.ProcessEnv): string[] {
  return [
    env.WEB_CONFIG_FILE || join(root, ".setting", "web-config.json"),
    env.SESSIONS_FILE || join(root, ".setting", "sessions.ndjson"),
    env.CHECKPOINT_FILE || join(root, ".setting", "checkpoints.ndjson"),
    env.MEMORIES_FILE || join(root, ".setting", "memories.json"),
    env.AUDIT_FILE || join(root, ".setting", "audit.ndjson"),
  ];
}

/** 纯检查入口：不启动服务、不加载用户配置，便于单元测试与镜像 smoke test 复用。 */
export async function collectProductionReleaseChecks(
  options: ProductionReleaseCheckOptions = {}
): Promise<ReadinessCheck[]> {
  const root = resolve(options.root ?? PROJECT_ROOT);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const uid = options.processUid === undefined
    ? (typeof process.getuid === "function" ? process.getuid() : null)
    : options.processUid;
  const checks: ReadinessCheck[] = [];

  checks.push(result(
    "production-mode",
    env.PRODUCTION === "1",
    env.PRODUCTION === "1" ? "PRODUCTION=1 已启用" : "发布自检必须设置 PRODUCTION=1",
    "deployment"
  ));
  // 即使忘记 PRODUCTION=1，也继续报告缺哪些生产密钥；最终仍由 production-mode 单独阻断。
  checks.push(...productionEnvironmentChecks(env.PRODUCTION === "1" ? env : { ...env, PRODUCTION: "1" }));

  let pkg: { version?: string; dependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as typeof pkg;
    checks.push(result("package", true, `运行包 ${pkg.version || "unknown"} 可读取`, "deployment"));
  } catch (err) {
    checks.push(result("package", false, `package.json 不可读：${err instanceof Error ? err.message : String(err)}`, "deployment"));
  }
  checks.push(result(
    "tsx-dependency",
    Boolean(pkg.dependencies?.tsx),
    pkg.dependencies?.tsx ? "tsx 已登记为生产依赖" : "tsx 必须放在 dependencies，否则精简运行镜像无法启动",
    "deployment"
  ));

  try {
    const requireFromRoot = createRequire(join(root, "package.json"));
    requireFromRoot.resolve("tsx");
    checks.push(result("tsx-runtime", true, "tsx 运行时可解析", "deployment"));
  } catch {
    checks.push(result("tsx-runtime", false, "node_modules 中缺少 tsx 运行时", "deployment"));
  }

  const missingAssets: string[] = [];
  for (const relative of REQUIRED_RUNTIME_ASSETS) {
    if (!(await exists(join(root, relative)))) missingAssets.push(relative);
  }
  checks.push(result(
    "runtime-assets",
    missingAssets.length === 0,
    missingAssets.length === 0
      ? "入口、vendor 与样式产物齐全"
      : `缺少运行产物：${missingAssets.join(", ")}`,
    "deployment"
  ));

  const forbidden = [];
  for (const relative of FORBIDDEN_RUNTIME_PATHS) {
    if (await exists(join(root, relative))) forbidden.push(relative);
  }
  checks.push(result(
    "runtime-surface",
    forbidden.length === 0,
    forbidden.length === 0
      ? "运行镜像未包含开发工具、测试或敏感配置"
      : `运行镜像包含禁止路径：${forbidden.join(", ")}`,
    "security"
  ));

  const nonRoot = platform === "win32" || uid === null || uid !== 0;
  checks.push(result(
    "non-root",
    nonRoot,
    nonRoot ? "进程未以 root 身份运行" : "生产镜像不允许 root 用户运行",
    "security"
  ));

  try {
    await assertWritableDirectories(dataFiles(root, env).map((file) => dirname(file)));
    checks.push(result("data-writable", true, "配置、会话、检查点、记忆与审计目录可写", "data"));
  } catch (err) {
    checks.push(result(
      "data-writable",
      false,
      err instanceof Error ? err.message : String(err),
      "data"
    ));
  }

  return checks;
}

export function failedReleaseChecks(checks: ReadinessCheck[]): ReadinessCheck[] {
  return checks.filter((check) => !check.ok);
}
