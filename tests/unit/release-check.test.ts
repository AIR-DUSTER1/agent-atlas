/**
 * ============================================================
 * release-check.test.ts — 生产镜像运行面与发布工程守门
 * ============================================================
 * 用临时“镜像根”验证 release-check 的正反路径，并静态检查 Dockerfile /
 * compose 的关键约束，防止以后重新把 devDependencies、测试或密钥打进运行层。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  FORBIDDEN_RUNTIME_PATHS,
  REQUIRED_RUNTIME_ASSETS,
  collectProductionReleaseChecks,
  failedReleaseChecks,
} from "../../src/server/release-check.js";
import { parseReleaseVersion } from "../../src/versioning.js";

const PRODUCTION_ENV: NodeJS.ProcessEnv = {
  PRODUCTION: "1",
  NODE_ENV: "production",
  AUTH_TOKEN: "test-auth-token-with-enough-length",
  SESSION_SECRET: "test-session-secret-with-at-least-thirty-two-characters",
  DATA_KEY: randomBytes(32).toString("base64"),
  COOKIE_SECURE: "true",
};

async function makeRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-release-check-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    version: "0.7.0-beta.1",
    dependencies: { tsx: "4.23.15", "playwright-core": "1.64.1" },
  }));
  for (const relative of REQUIRED_RUNTIME_ASSETS) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    if (relative === "src/server/public/build-info.json") continue;
    await writeFile(join(root, relative), "fixture", "utf8");
  }
  await writeFile(join(root, "src/server/public/build-info.json"), JSON.stringify({
    version: "0.7.0-beta.1",
    channel: "dev",
    releaseStage: "beta",
    commit: "12345678",
    builtAt: "2026-11-18T12:00:00.000Z",
    buildId: "dev.20261118T120000Z.12345678",
  }), "utf8");
  await mkdir(join(root, "node_modules", "tsx"), { recursive: true });
  await writeFile(join(root, "node_modules", "tsx", "package.json"), JSON.stringify({ name: "tsx", version: "4.23.15", main: "index.cjs" }));
  await writeFile(join(root, "node_modules", "tsx", "index.cjs"), "module.exports = {};\n", "utf8");
  await mkdir(join(root, "node_modules", "playwright-core"), { recursive: true });
  await writeFile(join(root, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "1.64.1", main: "index.js" }));
  await writeFile(join(root, "node_modules", "playwright-core", "index.js"), "module.exports = {};\n", "utf8");
  return root;
}

function envFor(root: string): NodeJS.ProcessEnv {
  return {
    ...PRODUCTION_ENV,
    WEB_CONFIG_FILE: join(root, "data", "web-config.json"),
    SESSIONS_FILE: join(root, "data", "sessions.ndjson"),
    CHECKPOINT_FILE: join(root, "data", "checkpoints.ndjson"),
    MEMORIES_FILE: join(root, "data", "memories.json"),
    AUDIT_FILE: join(root, "data", "audit.ndjson"),
  };
}

test("生产发布自检：完整运行面通过", async () => {
  const root = await makeRuntimeFixture();
  try {
    const checks = await collectProductionReleaseChecks({
      root,
      env: envFor(root),
      platform: "linux",
      processUid: 1000,
    });
    assert.deepEqual(failedReleaseChecks(checks), []);
    assert.ok(checks.some((check) => check.id === "runtime-surface" && check.ok));
    assert.ok(checks.some((check) => check.id === "non-root" && check.ok));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生产发布自检：固定浏览器路径存在才通过", async () => {
  const root = await makeRuntimeFixture();
  try {
    const present = await collectProductionReleaseChecks({
      root,
      env: { ...envFor(root), BROWSER_USE_EXECUTABLE_PATH: process.execPath },
      platform: "linux",
      processUid: 1000,
    });
    assert.ok(present.some((check) => check.id === "browser-executable" && check.ok));
    const missing = await collectProductionReleaseChecks({
      root,
      env: { ...envFor(root), BROWSER_USE_EXECUTABLE_PATH: join(root, "missing-browser") },
      platform: "linux",
      processUid: 1000,
    });
    assert.ok(failedReleaseChecks(missing).some((check) => check.id === "browser-executable"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生产发布自检：缺产物、开发文件、root 与弱环境均 fail-closed", async () => {
  const root = await makeRuntimeFixture();
  try {
    await rm(join(root, REQUIRED_RUNTIME_ASSETS[3]), { force: true });
    await mkdir(join(root, "node_modules", "typescript"), { recursive: true });
    const checks = await collectProductionReleaseChecks({
      root,
      env: { ...envFor(root), PRODUCTION: "0", SESSION_SECRET: "", COOKIE_SECURE: "false" },
      platform: "linux",
      processUid: 0,
    });
    const failed = new Set(failedReleaseChecks(checks).map((check) => check.id));
    assert.ok(failed.has("runtime-assets"));
    assert.ok(failed.has("runtime-surface"));
    assert.ok(failed.has("non-root"));
    assert.ok(failed.has("production-mode"));
    assert.ok(failed.has("session-secret"));
    assert.ok(failed.has("cookie-secure"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("发布工程：依赖分类与镜像边界不回退", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    version: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.doesNotThrow(() => parseReleaseVersion(pkg.version));
  assert.ok(pkg.dependencies.tsx);
  assert.ok(!pkg.dependencies.electron);
  assert.ok(!pkg.dependencies.typescript);
  for (const name of ["chart.js", "dompurify", "highlight.js", "lucide", "marked"]) {
    assert.ok(pkg.devDependencies[name], `${name} 应只用于构建`);
  }
  // Vue 运行时只存在于 Vite 产物，且运行层会删除前端源码。
  // 若误放回 dependencies，npm ci --omit=dev 会把整套组件库及其传递依赖带进生产镜像。
  for (const name of ["antdv-next", "pinia", "vue"]) {
    assert.ok(pkg.devDependencies[name], `${name} 应只用于前端构建`);
    assert.ok(!pkg.dependencies[name], `${name} 不得进入生产运行依赖`);
  }

  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY tsconfig\.json tsconfig\.client\.json tsconfig\.desktop\.json vite\.config\.ts \.\//);
  assert.match(dockerfile, /src\/server\/public\/styles\/base\/ui\.css/);
  assert.doesNotMatch(dockerfile, /src\/server\/public\/styles\/ui\.css/);
  assert.match(dockerfile, /AS builder/);
  assert.match(dockerfile, /AS production-deps/);
  assert.match(dockerfile, /npm ci --omit=dev --omit=optional --ignore-scripts/, "生产依赖必须排除 optional peer，防止 Vue/TypeScript 回流");
  assert.match(dockerfile, /COPY --from=builder[^\n]*@esbuild\/linux-x64/, "运行镜像必须回填 tsx 所需的 esbuild 平台二进制");
  assert.match(dockerfile, /AS runtime-base/);
  assert.match(dockerfile, /AS runtime/);
  assert.match(dockerfile, /AS minimal/);
  assert.match(dockerfile, /chromium-headless-shell/);
  assert.match(dockerfile, /CHROME_HEADLESS_SHELL_SHA256=[0-9a-f]{64}/);
  assert.match(dockerfile, /BROWSER_USE_EXECUTABLE_PATH=\/opt\/chrome-headless-shell\/chrome-headless-shell/);
  assert.match(dockerfile, /BROWSER_USE_CONTAINER=1/);
  assert.match(dockerfile, /BEIKE_INSTALL_DIR=\/data\/tools\/beike/);
  assert.match(dockerfile, /BEIKE_USER_HOME=\/data\/beike-home/);
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  assert.doesNotMatch(runtime, /COPY[^\n]*(tests|docs|desktop|src\/client)/);
  assert.match(runtime, /USER node/);
  assert.match(runtime, /CHECKPOINT_FILE=\/data\/checkpoints\.ndjson/);
  assert.match(runtime, /MEMORIES_FILE=\/data\/memories\.json/);
  assert.match(runtime, /MEMORY_STORE_DIR=\/data\/memory-store/);
  // 允许两种运行面策略：精确清单复制，或整体复制 src/scripts 后在运行层删除 client。
  const copiesWholeSource = /COPY[^\n]*\/app\/src \.\/src/.test(runtime);
  const copiesWholeScripts = /COPY[^\n]*\/app\/scripts \.\/scripts/.test(runtime);
  if (copiesWholeSource) {
    assert.match(runtime, /rm -rf src\/client/, "整体复制策略必须移除前端源码");
    assert.ok(copiesWholeScripts, "整体复制 src 时必须同时复制 scripts");
  } else {
    assert.match(runtime, /scripts\/data-cli\.ts/);
    for (const entry of await readdir("src", { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "client") continue;
      assert.match(
        runtime,
        new RegExp(`COPY[^\\n]*\\/app\\/src\\/${entry.name} \\.\\/src\\/${entry.name}`),
        `Docker runtime 未复制 src/${entry.name}`,
      );
    }
  }

  const productionCompose = await readFile("docker-compose.production.yml", "utf8");
  assert.match(productionCompose, /\$\{AGENT_IMAGE:\?/);
  assert.match(productionCompose, /COOKIE_SECURE: "true"/);
  assert.match(productionCompose, /read_only: true/);
  assert.match(productionCompose, /cap_drop:/);
  assert.match(productionCompose, /no-new-privileges:true/);
  assert.match(productionCompose, /shm_size: 256mb/);
  assert.match(productionCompose, /pids_limit: 512/);

  const dockerignore = await readFile(".dockerignore", "utf8");
  for (const pattern of [".env", ".web-config.json*", ".setting", ".agents", "data", "*.log"]) {
    assert.ok(dockerignore.includes(pattern), `.dockerignore 缺少 ${pattern}`);
  }
  assert.equal(new Set(REQUIRED_RUNTIME_ASSETS).size, REQUIRED_RUNTIME_ASSETS.length);
  assert.ok(FORBIDDEN_RUNTIME_PATHS.includes("node_modules/electron"));
  assert.ok(FORBIDDEN_RUNTIME_PATHS.includes(".agents"));
});
test("main 合并 CI 验收入口与镜像 smoke 路径保持一致", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["ci:verify"], "tsx scripts/ci-verify.ts");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /name: Vue component tests/);
  assert.match(workflow, /npm run test:vue/);
  const smoke = await readFile("scripts/docker-smoke.ts", "utf8");
  assert.match(smoke, /styles\/base\/ui\.css/);
  assert.doesNotMatch(smoke, /styles\/ui\.css/);
  assert.match(smoke, /pluginsBody\.container/);
  assert.match(smoke, /Docker 容器必须禁用 Computer Use/);
  const agents = await readFile("AGENTS.md", "utf8");
  assert.match(agents, /git fetch origin main && npm run ci:verify/);
  assert.match(agents, /Docker daemon 不可用[\s\S]*禁止合并 main/);
  const listed = spawnSync(process.execPath, ["--import", "tsx", "scripts/ci-verify.ts", "--list"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /image:smoke/);
  assert.match(listed.stdout, /test:vue/);
  assert.match(listed.stdout, /version:main-guard/);
});

test("依赖审查覆盖 main/dev PR，且不重复挂在高成本 CI 上", async () => {
  const [ciWorkflow, dependencyWorkflow] = await Promise.all([
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile(".github/workflows/dependency-review.yml", "utf8"),
  ]);
  assert.match(dependencyWorkflow, /pull_request:\s*\r?\n\s*branches:\s*\[main, dev\]/);
  assert.match(dependencyWorkflow, /actions\/dependency-review-action@[0-9a-f]{40}/);
  assert.match(dependencyWorkflow, /fail-on-severity:\s*high/);
  assert.doesNotMatch(ciWorkflow, /^\s{2}dependency-review:/m, "dependency-review 不应重复挂在高成本 CI 工作流");
});

test("CI 外部 Action 全部固定到完整 commit SHA", async () => {
  const [ciWorkflow, dependencyWorkflow] = await Promise.all([
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile(".github/workflows/dependency-review.yml", "utf8"),
  ]);
  const workflow = `${ciWorkflow}\n${dependencyWorkflow}`;
  const refs = [...workflow.matchAll(/uses:\s*([^\s#]+)(?:\s*#\s*(\S+))?/g)].map((match) => ({
    ref: match[1] ?? "",
    version: match[2] ?? "",
  }));
  assert.ok(refs.length >= 10, `CI Action 数量异常：${refs.length}`);
  for (const item of refs) {
    assert.match(item.ref, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, item.ref);
    assert.match(item.version, /^v\d+\.\d+\.\d+$/, `${item.ref} 缺少可读版本注释`);
  }
  assert.ok(refs.some((item) => item.ref === "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25"));
  assert.doesNotMatch(workflow, /aquasecurity\/trivy-action@0\.28\.0/);
  assert.match(ciWorkflow, /fetch-depth: 0/);
  assert.match(ciWorkflow, /name: Main merge version advance/);
  assert.match(ciWorkflow, /VERSION_BASE_REF:.*github\.event\.pull_request\.base\.sha/);
  assert.match(ciWorkflow, /npm run version:main-guard/);
});