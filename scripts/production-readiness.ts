/**
 * ============================================================
 * production-readiness.ts — 只读生产 readiness 检查器
 * ============================================================
 * 用法：npm run readiness
 * 只检查、不启动服务、不创建目录、不修改配置；任一硬门失败以退出码 1 结束。
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../src/server/files.js";
import { productionEnvironmentChecks, inspectWritableDirectories, isProductionMode, type ReadinessCheck } from "../src/server/production.js";
import { SETTINGS_FILE } from "../src/server/config-store.js";
import { journalPath } from "../src/server/session-store.js";
import { checkpointFilePath } from "../src/checkpoint.js";
import { memoriesFilePath } from "../src/memory-store.js";
import { auditFilePath } from "../src/server/audit.js";

const REQUIRED_ARTIFACTS = [
  "src/server/public/index.html",
  "src/server/public/main.js",
  "src/server/public/styles/tokens.css",
  "src/server/public/styles/layout.css",
  "src/server/public/vendor/chart.js",
  "src/server/public/vendor/icons-lib.js",
];

function check(id: string, ok: boolean, message: string, category: ReadinessCheck["category"]): ReadinessCheck {
  return { id, category, ok, message };
}

async function checkArtifacts(): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  for (const rel of REQUIRED_ARTIFACTS) {
    const st = await stat(join(PROJECT_ROOT, rel)).catch(() => null);
    checks.push(check(
      `artifact:${rel}`,
      Boolean(st?.isFile() && st.size > 0),
      st?.isFile() && st.size > 0 ? `${rel} 已生成` : `缺少构建产物 ${rel}，请运行 npm run build:client`,
      "deployment"
    ));
  }
  return checks;
}

function stableObject(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
}

async function checkLockfile(): Promise<ReadinessCheck[]> {
  try {
    const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    const lock = JSON.parse(await readFile(join(PROJECT_ROOT, "package-lock.json"), "utf8")) as {
      lockfileVersion?: number;
      name?: string;
      version?: string;
      packages?: Record<string, { name?: string; version?: string; dependencies?: unknown; devDependencies?: unknown }>;
    };
    const root = lock.packages?.[""];
    const same = Boolean(
      root &&
      lock.lockfileVersion && lock.lockfileVersion >= 3 &&
      lock.name === pkg.name && lock.version === pkg.version &&
      root.name === pkg.name && root.version === pkg.version &&
      stableObject(root.dependencies) === stableObject(pkg.dependencies) &&
      stableObject(root.devDependencies) === stableObject(pkg.devDependencies)
    );
    return [check(
      "lockfile",
      same,
      same ? "package-lock.json 与 package.json 一致" : "package-lock.json 已漂移，请运行 npm install 并提交更新后的锁文件",
      "test"
    )];
  } catch (err) {
    return [check("lockfile", false, `无法校验 package-lock.json：${err instanceof Error ? err.message : String(err)}`, "test")];
  }
}

async function main(): Promise<void> {
  const dataFiles = [SETTINGS_FILE, journalPath(), checkpointFilePath(), memoriesFilePath(), auditFilePath()];
  const checks = [
    check("production-mode", isProductionMode(), "PRODUCTION=1 已启用", "deployment"),
    ...productionEnvironmentChecks(),
    ...await checkArtifacts(),
    ...await checkLockfile(),
    ...await inspectWritableDirectories(dataFiles.map((file) => dirname(file))),
  ];

  for (const item of checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"} [${item.category}] ${item.message}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n生产 readiness：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.log("修复以上 FAIL 项后重新运行：npm run readiness");
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error(`readiness 检查异常：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
