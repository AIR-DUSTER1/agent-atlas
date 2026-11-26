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
  const releaseChannel = process.env.RELEASE_CHANNEL || "dev";
  const suffix = randomBytes(4).toString("hex");
  const image = process.env.SMOKE_IMAGE || `agentatlas:smoke-${suffix}`;
  const container = `agent-smoke-${suffix}`;
  const baseTagArgs = [
    "build",
    "--build-arg", `IMAGE_VERSION=${version}`,
    "--build-arg", `GIT_COMMIT=${commit}`,
    "--build-arg", `BUILD_TIME=${buildTime}`,
    "--build-arg", `RELEASE_CHANNEL=${releaseChannel}`,
    "-t", image,
    ".",
  ];

  must(["version"]);
  console.log(`构建镜像 ${image} ...`);
  must(baseTagArgs, { inherit: true, timeout: 30 * 60_000 });

  const labels = JSON.parse(must([
    "image", "inspect", "--format", "{{json .Config.Labels}}", image,
  ]).stdout) as Record<string, string>;
  if (labels["org.opencontainers.image.version"] !== version) {
    throw new Error(`镜像版本标签 ${labels["org.opencontainers.image.version"] || "(missing)"} 与 package.json ${version} 不一致`);
  }
  const imageId = must(["image", "inspect", "--format", "{{.Id}}", image]).stdout;
  const imageDisplaySize = must(["image", "ls", image, "--format", "{{.Size}}"]).stdout;
  const rootfsKb = Number(must([
    "run", "--rm", "--user", "root", "--entrypoint", "sh", image,
    "-lc", "du -sx / | cut -f1",
  ], { timeout: 60_000 }).stdout);
  const rootfsMiB = rootfsKb / 1024;
  const maxImageMb = Number(process.env.SMOKE_MAX_IMAGE_MB || "700");
  if (!Number.isFinite(rootfsMiB) || rootfsMiB <= 0) throw new Error(`无法读取镜像 rootfs 大小：${rootfsKb}`);
  if (!Number.isFinite(maxImageMb) || maxImageMb <= 0) throw new Error(`SMOKE_MAX_IMAGE_MB 非法：${process.env.SMOKE_MAX_IMAGE_MB}`);
  if (rootfsMiB > maxImageMb) {
    throw new Error(`镜像 rootfs ${rootfsMiB.toFixed(1)} MiB 超过预算 ${maxImageMb} MiB（docker images: ${imageDisplaySize}）`);
  }
  console.log(`镜像大小 ${imageDisplaySize} / rootfs ${rootfsMiB.toFixed(1)} MiB（预算 ${maxImageMb} MiB），ID ${imageId}`);

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
    "-e", `METRICS_TOKEN=smoke-metrics-${suffix}-token`,
    image,
    "node", "--import", "tsx", "src/server/index.ts", "--check-production",
  ]);
  must([
    "run", "--rm",
    image,
    "node", "--import", "tsx", "scripts/data-cli.ts", "check",
  ]);
  const browserSmoke = must([
    "run", "--rm",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:size=256m,mode=1777",
    "-e", "HOME=/tmp",
    image,
    "node", "--import", "tsx", "scripts/browser-smoke.ts",
  ], { timeout: 120_000 });
  console.log(`浏览器 smoke：${browserSmoke.stdout}`);

  let containerCreated = false;
  try {
    must([
      "run", "-d", "--name", container,
      "-p", "127.0.0.1::3000",
      "-e", `AUTH_TOKEN=smoke-login-${suffix}-secret`,
      "-e", `METRICS_TOKEN=smoke-metrics-${suffix}-token`,
      "-e", "LOG_LEVEL=info",
      image,
    ]);
    containerCreated = true;
    const mapping = must(["port", container, "3000/tcp"]).stdout;
    const match = mapping.match(/:(\d+)\s*$/m);
    if (!match) throw new Error(`无法解析容器端口：${mapping}`);
    const base = `http://127.0.0.1:${match[1]}`;

    const health = await waitHttp(`${base}/healthz`);
    const healthBody = await health.json() as { version?: string; buildId?: string; commit?: string };
    if (healthBody.version !== version) throw new Error(`healthz 版本 ${healthBody.version || "(missing)"} 与 package.json ${version} 不一致`);
    if (!healthBody.buildId || !healthBody.commit) throw new Error("healthz 缺少 buildId/commit");
    const ready = await waitHttp(`${base}/readyz`);
    const index = await waitHttp(`${base}/`);
    const csp = index.headers.get("content-security-policy") || "";
    if (!csp.includes("default-src 'self'")) throw new Error("首页缺少 CSP");
    await waitHttp(`${base}/assets/app.js`);
    await waitHttp(`${base}/assets/chart.js`);
    await waitHttp(`${base}/styles/base/ui.css`);

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
    const versionResponse = await fetch(`${base}/api/version`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5_000),
    });
    if (!versionResponse.ok) throw new Error(`版本接口 smoke 失败：HTTP ${versionResponse.status}`);
    const versionBody = await versionResponse.json() as { version?: string; buildId?: string; commit?: string };
    if (versionBody.version !== version || !versionBody.buildId || !versionBody.commit) {
      throw new Error(`版本接口内容异常：${JSON.stringify(versionBody)}`);
    }
    const pluginsResponse = await fetch(`${base}/api/plugins`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5_000),
    });
    if (!pluginsResponse.ok) throw new Error(`插件状态 smoke 失败：HTTP ${pluginsResponse.status}`);
    const pluginsBody = await pluginsResponse.json() as {
      container?: boolean;
      enabled?: { computer?: boolean };
    };
    if (pluginsBody.container !== true || pluginsBody.enabled?.computer !== false) {
      throw new Error(`Docker 容器必须禁用 Computer Use：${JSON.stringify(pluginsBody)}`);
    }
    const metrics = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Bearer smoke-metrics-${suffix}-token` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!metrics.ok) throw new Error(`指标抓取 smoke 失败：HTTP ${metrics.status}`);
    if (!(await metrics.text()).includes("agent_http_requests_total")) throw new Error("指标输出缺少 HTTP 计数");
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
      imageDisplaySize,
      rootfsMiB: Number(rootfsMiB.toFixed(1)),
      labels,
      checks: {
        healthz: health.status,
        readyz: ready.status,
        index: index.status,
        authCookie: true,
        versionApi: versionResponse.status,
        plugins: pluginsResponse.status,
        metrics: metrics.status,
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
