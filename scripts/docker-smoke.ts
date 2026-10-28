/**
 * ============================================================
 * docker-smoke.ts — 生产镜像构建与运行验收
 * ============================================================
 * 一条命令验证：多阶段构建、标签、精简运行面、生产自检、健康探针、静态资源、
 * HttpOnly 登录/注销和优雅停止。失败时保留明确 JSON 证据并清理临时容器。
 * 该脚本不连接真实模型，也不读取 .env / .web-config.json。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface CommandResult { status: number | null; stdout: string; stderr: string }

function run(args: string[], options: { inherit?: boolean; timeout?: number } = {}): CommandResult {
  const result = spawnSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
  };
}

function must(args: string[], options: { inherit?: boolean; timeout?: number } = {}): CommandResult {
  const result = run(args, options);
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} 失败（exit=${result.status}）：${result.stderr || result.stdout}`);
  }
  return result;
}

async function waitHttp(url: string, attempts = 40): Promise<Response> {
  let lastError = "";
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`等待 ${url} 超时：${lastError}`);
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version?: string };
  const version = pkg.version || "0.0.0";
  const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const commit = process.env.GIT_COMMIT || (git.status === 0 ? git.stdout.trim() : "unknown");
  const buildTime = new Date().toISOString();
  const suffix = randomBytes(4).toString("hex");
  const image = process.env.SMOKE_IMAGE || `langgraph-agent-demo:smoke-${suffix}`;
  const container = `agent-smoke-${suffix}`;
  const baseTagArgs = [
    "build",
    "--build-arg", `APP_VERSION=${version}`,
    "--build-arg", `GIT_COMMIT=${commit}`,
    "--build-arg", `BUILD_TIME=${buildTime}`,
    "-t", image,
    ".",
  ];

  must(["version"]);
  console.log(`构建镜像 ${image} ...`);
  must(baseTagArgs, { inherit: true, timeout: 20 * 60_000 });

  const labels = JSON.parse(must([
    "image", "inspect", "--format", "{{json .Config.Labels}}", image,
  ]).stdout) as Record<string, string>;
  const imageId = must(["image", "inspect", "--format", "{{.Id}}", image]).stdout;
  const imageSize = Number(must(["image", "inspect", "--format", "{{.Size}}", image]).stdout);

  must([
    "run", "--rm", "--entrypoint", "node", image, "-e",
    "const fs=require('fs');const p=['node_modules/electron','node_modules/typescript','tests','docs','desktop','src/client'];const found=p.filter(x=>fs.existsSync('/app/'+x));if(found.length){console.error(found.join(','));process.exit(1)}",
  ]);

  const dataKey = randomBytes(32).toString("base64");
  must([
    "run", "--rm",
    "-e", "PRODUCTION=1",
    "-e", "NODE_ENV=production",
    "-e", `AUTH_TOKEN=smoke-login-${suffix}-secret`,
    "-e", `SESSION_SECRET=smoke-session-${suffix}-${randomBytes(24).toString("hex")}`,
    "-e", `DATA_KEY=${dataKey}`,
    image,
    "node", "--import", "tsx", "src/server/index.ts", "--check-production",
  ]);

  let containerCreated = false;
  try {
    must([
      "run", "-d", "--name", container,
      "-p", "127.0.0.1::3000",
      "-e", `AUTH_TOKEN=smoke-login-${suffix}-secret`,
      "-e", "LOG_LEVEL=info",
      image,
    ]);
    containerCreated = true;
    const mapping = must(["port", container, "3000/tcp"]).stdout;
    const match = mapping.match(/:(\d+)\s*$/m);
    if (!match) throw new Error(`无法解析容器端口：${mapping}`);
    const base = `http://127.0.0.1:${match[1]}`;

    const health = await waitHttp(`${base}/healthz`);
    const ready = await waitHttp(`${base}/readyz`);
    const index = await waitHttp(`${base}/`);
    const csp = index.headers.get("content-security-policy") || "";
    if (!csp.includes("default-src 'self'")) throw new Error("首页缺少 CSP");
    await waitHttp(`${base}/main.js`);
    await waitHttp(`${base}/vendor/chart-lib.js`);
    await waitHttp(`${base}/styles/ui.css`);

    const login = await fetch(`${base}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: `smoke-login-${suffix}-secret` }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!login.ok) throw new Error(`登录 smoke 失败：HTTP ${login.status}`);
    const setCookie = login.headers.get("set-cookie") || "";
    if (!/HttpOnly/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie)) {
      throw new Error(`会话 Cookie 属性错误：${setCookie}`);
    }
    const cookie = setCookie.split(";")[0] || "";
    const status = await fetch(`${base}/api/auth/session`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5_000),
    });
    if (!status.ok) throw new Error(`认证状态 smoke 失败：HTTP ${status.status}`);
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    if (!logout.ok) throw new Error(`注销 smoke 失败：HTTP ${logout.status}`);

    must(["stop", "-t", "15", container]);

    const logs = must(["logs", container]).stdout;
    if (!logs.includes("server_stopped")) throw new Error("容器停止日志缺少 server_stopped，优雅退出未生效");

    const report = {
      ok: true,
      image,
      imageId,
      imageSize,
      labels,
      checks: {
        healthz: health.status,
        readyz: ready.status,
        index: index.status,
        authCookie: true,
        logout: logout.status,
        gracefulStop: true,
        runtimeSurfaceClean: true,
      },
      builtAt: buildTime,
    };
    const output = resolve(process.env.SMOKE_REPORT || "artifacts/image-smoke.json");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(report));
  } finally {
    if (containerCreated) run(["rm", "-f", container]);
    if (!process.env.SMOKE_KEEP_IMAGE) run(["image", "rm", "-f", image]);
  }
}

await main();
