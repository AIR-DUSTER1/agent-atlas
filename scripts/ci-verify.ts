/**
 * ============================================================
 * scripts/ci-verify.ts — main 合并前的 CI 等价验证
 * ============================================================
 * 职责：在候选提交上按顺序复刻 GitHub CI 的 quality / e2e / image 门禁。
 * 约束：
 *  - Docker daemon 不可用直接失败，不能用静态检查冒充镜像 smoke；
 *  - 版本门禁默认以 origin/main 为基线，运行前应先 fetch；
 *  - GitHub dependency-review 只能在 PR 中执行，本脚本结束时会明确提示。
 */
import { spawnSync } from "node:child_process";

interface VerifyStep {
  name: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const ROOT = process.cwd();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const baseRef = process.env.VERSION_BASE_REF?.trim() || "origin/main";

function commandText(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): void {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    timeout: options.timeoutMs ?? 20 * 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandText(command, args)} 失败（exit=${result.status ?? "unknown"}）`);
  }
}

function output(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandText(command, args)} 失败`);
  return result.stdout.trim();
}

function npmStep(name: string, script: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): VerifyStep {
  return {
    name,
    args: ["run", script],
    env: options.env,
    timeoutMs: options.timeoutMs,
  };
}

const commit = process.env.GIT_COMMIT?.trim() || output("git", ["rev-parse", "HEAD"]);
const steps: VerifyStep[] = [
  { name: "安装锁文件精确依赖", args: ["ci"], timeoutMs: 20 * 60_000 },
  npmStep("版本规范一致性", "version:check"),
  npmStep("main 版本递增", "version:main-guard", { env: { VERSION_BASE_REF: baseRef } }),
  npmStep("项目 Skill 分层", "skills:check"),
  npmStep("服务端 / 客户端 / 桌面类型检查", "typecheck"),
  npmStep("前端构建", "build:client"),
  npmStep("桌面构建", "build:desktop"),
  npmStep("Node 单元 / 集成 / 安全测试", "test", { env: { API_KEY: "", AUTH_TOKEN: "" }, timeoutMs: 20 * 60_000 }),
  npmStep("安全模块覆盖率", "coverage:security"),
  npmStep("持久化覆盖率", "coverage:persistence"),
  npmStep("认证路由覆盖率", "coverage:routes"),
  npmStep("Vue 组件测试", "test:vue"),
  npmStep("生产依赖审计", "audit:prod", { env: { NPM_AUDIT_REGISTRY: "https://registry.npmjs.org" } }),
  npmStep("CycloneDX SBOM", "sbom"),
  npmStep("浏览器 E2E", "e2e", { env: { API_KEY: "", AUTH_TOKEN: "" }, timeoutMs: 30 * 60_000 }),
  npmStep("生产镜像构建与 smoke", "image:smoke", {
    env: {
      GIT_COMMIT: commit,
      SMOKE_IMAGE: `agent-ci:${commit}`,
      RELEASE_CHANNEL: process.env.RELEASE_CHANNEL?.trim() || "dev",
    },
    timeoutMs: 40 * 60_000,
  }),
];

function main(): void {
  if (process.argv.includes("--list")) {
    for (const [index, step] of steps.entries()) {
      console.log(`${index + 1}. ${step.name}: ${commandText(npmCommand, step.args)}`);
    }
    return;
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 24) {
    throw new Error(`本地 Node 为 ${process.versions.node}，与 GitHub CI 固定的 Node 24 不一致`);
  }
  try {
    output("git", ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  } catch {
    throw new Error(`版本基线 ${baseRef} 不存在；请先执行 git fetch origin main，或显式设置 VERSION_BASE_REF`);
  }
  try {
    output("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    throw new Error("Docker daemon 不可用：CI 包含镜像构建与 smoke，无法验证时禁止合并 main");
  }

  console.log(`CI 等价验证开始：commit=${commit} base=${baseRef}`);
  for (const [index, step] of steps.entries()) {
    console.log(`\n[ci:verify ${index + 1}/${steps.length}] ${step.name}`);
    run(npmCommand, step.args, { env: step.env, timeoutMs: step.timeoutMs });
  }
  console.log("\n✓ CI 等价验证全部通过");
  console.log("提示：GitHub PR 专属的 dependency-review 仍需在目标 PR 上为同一提交保持绿色。");
}

try {
  main();
} catch (error) {
  console.error(`\n✗ CI 等价验证失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
