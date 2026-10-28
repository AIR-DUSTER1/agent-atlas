/**
 * ============================================================
 * release-check.test.ts — 生产镜像运行面与发布工程守门
 * ============================================================
 * 用临时“镜像根”验证 release-check 的正反路径，并静态检查 Dockerfile /
 * compose 的关键约束，防止以后重新把 devDependencies、测试或密钥打进运行层。
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  FORBIDDEN_RUNTIME_PATHS,
  REQUIRED_RUNTIME_ASSETS,
  collectProductionReleaseChecks,
  failedReleaseChecks,
} from "../../src/server/release-check.js";

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
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.9.0-beta.1", dependencies: { tsx: "4.23.15" } }));
  for (const relative of REQUIRED_RUNTIME_ASSETS) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), "fixture", "utf8");
  }
  await mkdir(join(root, "node_modules", "tsx"), { recursive: true });
  await writeFile(join(root, "node_modules", "tsx", "package.json"), JSON.stringify({ name: "tsx", version: "4.23.15", main: "index.cjs" }));
  await writeFile(join(root, "node_modules", "tsx", "index.cjs"), "module.exports = {};\n", "utf8");
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
  assert.equal(pkg.version, "0.9.0-beta.1");
  assert.ok(pkg.dependencies.tsx);
  assert.ok(!pkg.dependencies.electron);
  assert.ok(!pkg.dependencies.typescript);
  for (const name of ["chart.js", "dompurify", "highlight.js", "lucide", "marked"]) {
    assert.ok(pkg.devDependencies[name], `${name} 应只用于构建`);
  }

  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /AS builder/);
  assert.match(dockerfile, /AS production-deps/);
  assert.match(dockerfile, /AS runtime/);
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  assert.doesNotMatch(runtime, /COPY[^\n]*(tests|docs|desktop|src\/client)/);
  assert.match(runtime, /USER node/);
  assert.match(runtime, /CHECKPOINT_FILE=\/data\/checkpoints\.ndjson/);
  assert.match(runtime, /MEMORIES_FILE=\/data\/memories\.json/);
  assert.match(runtime, /scripts\/data-cli\.ts/);

  const productionCompose = await readFile("docker-compose.production.yml", "utf8");
  assert.match(productionCompose, /\$\{AGENT_IMAGE:\?/);
  assert.match(productionCompose, /COOKIE_SECURE: "true"/);
  assert.match(productionCompose, /read_only: true/);
  assert.match(productionCompose, /cap_drop:/);
  assert.match(productionCompose, /no-new-privileges:true/);

  const dockerignore = await readFile(".dockerignore", "utf8");
  for (const pattern of [".env", ".web-config.json*", ".setting", "data", "*.log"]) {
    assert.ok(dockerignore.includes(pattern), `.dockerignore 缺少 ${pattern}`);
  }
  assert.equal(new Set(REQUIRED_RUNTIME_ASSETS).size, REQUIRED_RUNTIME_ASSETS.length);
  assert.ok(FORBIDDEN_RUNTIME_PATHS.includes("node_modules/electron"));
});
test("CI 外部 Action 全部固定到完整 commit SHA", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
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
});
