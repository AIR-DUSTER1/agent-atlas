/**
 * ============================================================
 * production.ts — 生产模式硬门禁与可写性检查
 * ============================================================
 * 职责：把「生产需要哪些环境变量、数据目录是否真的可写」收拢为一处。
 * 设计立场：
 *  - 默认开发模式完全放行，PRODUCTION=1 才启用 fail-closed；
 *  - 环境检查保持纯函数，启动器和 readiness 脚本共用同一套规则；
 *  - 目录检查使用短超时写探针，避免只读挂载、满盘或网络盘卡死被误判为 ready。
 */
import { constants } from "node:fs";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ReadinessCategory = "security" | "data" | "observability" | "deployment" | "test" | "docs";

export interface ReadinessCheck {
  id: string;
  category: ReadinessCategory;
  ok: boolean;
  message: string;
}

const WRITE_PROBE_TIMEOUT_MS = 1_500;
const PLACEHOLDER_SECRET = /^(change-me|changeme|test-secret|secret|password|token)$/i;

function nonEmpty(value: string | undefined): string {
  return (value ?? "").trim();
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_SECRET.test(value) || /change[-_ ]?me/i.test(value);
}

/** PRODUCTION=1 才是生产模式；其它值只视为开发/演示。 */
export function isProductionMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRODUCTION === "1";
}

/** DATA_KEY 必须是恰好 32 字节的 base64；返回归一后的错误文案。 */
export function validateDataKey(value: string): string | null {
  if (!value) return "缺少 DATA_KEY（32 字节 base64，用于 AES-256-GCM 加密敏感配置）";
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32) return "DATA_KEY 必须是 32 字节的 base64（例如：openssl rand -base64 32）";
    if (bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      return "DATA_KEY 不是规范 base64，请重新生成";
    }
  } catch {
    return "DATA_KEY 不是合法 base64";
  }
  return null;
}

/**
 * 生产环境变量组合检查。纯函数：不读文件、不改系统，供启动器和 CLI 共用。
 * 空数组 = 非生产模式或全部通过。
 */
export function productionEnvironmentChecks(env: NodeJS.ProcessEnv = process.env): ReadinessCheck[] {
  if (!isProductionMode(env)) return [];
  const checks: ReadinessCheck[] = [];
  const add = (id: string, ok: boolean, message: string, category: ReadinessCategory = "security") => {
    checks.push({ id, category, ok, message });
  };

  const authToken = nonEmpty(env.AUTH_TOKEN);
  add(
    "auth-token",
    authToken.length >= 16 && !isPlaceholder(authToken),
    authToken ? "AUTH_TOKEN 至少 16 位且不能使用示例占位值" : "生产模式必须设置 AUTH_TOKEN"
  );

  const sessionSecret = nonEmpty(env.SESSION_SECRET);
  add(
    "session-secret",
    sessionSecret.length >= 32 && !isPlaceholder(sessionSecret),
    sessionSecret ? "SESSION_SECRET 至少 32 位且不能使用示例占位值" : "生产模式必须设置 SESSION_SECRET"
  );

  const dataKeyError = validateDataKey(nonEmpty(env.DATA_KEY));
  add("data-key", dataKeyError === null, dataKeyError ?? "DATA_KEY 已配置");

  const metricsToken = nonEmpty(env.METRICS_TOKEN);
  if (metricsToken) {
    add(
      "metrics-token",
      metricsToken.length >= 16 && !isPlaceholder(metricsToken),
      "METRICS_TOKEN 至少 16 位且不能使用示例占位值",
      "observability"
    );
  }

  add(
    "cookie-secure",
    nonEmpty(env.COOKIE_SECURE).toLowerCase() !== "false",
    "生产模式 COOKIE_SECURE 不能为 false（必须经 HTTPS 反代访问）",
    "deployment"
  );

  add(
    "runtime-mode",
    nonEmpty(env.NODE_ENV) !== "development",
    "生产模式不能同时设置 NODE_ENV=development",
    "deployment"
  );

  return checks;
}

export function formatReadinessFailures(checks: ReadinessCheck[]): string {
  return checks.filter((c) => !c.ok).map((c) => `- ${c.message}`).join("\n");
}

/** 启动时同步门禁：只检查环境变量，不触碰磁盘。 */
export function assertProductionEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const failures = productionEnvironmentChecks(env).filter((c) => !c.ok);
  if (failures.length) {
    throw new Error(`生产模式配置不完整：\n${formatReadinessFailures(failures)}`);
  }
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("写探针超时")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 真实写一个短命探针文件再删除，覆盖 mkdir 成功但挂载只读/满盘的情况。 */
export async function assertWritableDirectories(dirs: string[]): Promise<void> {
  const unique = [...new Set(dirs.filter(Boolean))];
  const failures: string[] = [];
  for (const dir of unique) {
    const probe = `${dir}/.agent-ready-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await withTimeout((async () => {
        await mkdir(dir, { recursive: true });
        await access(dir, constants.W_OK);
        await writeFile(probe, "ready", { encoding: "utf8", flag: "wx", mode: 0o600 });
      })(), WRITE_PROBE_TIMEOUT_MS);
    } catch (err) {
      failures.push(`${dir}：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await unlink(probe).catch(() => {});
    }
  }
  if (failures.length) {
    throw new Error(`生产数据目录不可写：\n${failures.map((f) => `- ${f}`).join("\n")}`);
  }
}

/** 生产启动门禁：数据目录可写 + 不能误把 mock 模型当成生产模型。 */
export async function assertProductionRuntimeReady(options: {
  apiKey: string;
  dataFiles: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = options.env ?? process.env;
  if (!isProductionMode(env)) return;
  assertProductionEnvironment(env);
  if (!options.apiKey.trim()) {
    throw new Error("生产模式禁止 mock 模型：请先在 .env 或 Web 设置中配置至少一个可用供应商；服务本次拒绝启动");
  }
  const dirs = options.dataFiles.filter(Boolean).map((file) => dirname(file));
  await assertWritableDirectories(dirs);
}

/** readiness CLI 用：只读检查目录是否存在且当前用户可写，不创建目录、不落探针。 */
export async function inspectWritableDirectories(dirs: string[]): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  for (const dir of [...new Set(dirs.filter(Boolean))]) {
    try {
      const st = await withTimeout(stat(dir), WRITE_PROBE_TIMEOUT_MS);
      if (!st.isDirectory()) throw new Error("不是目录");
      await withTimeout(access(dir, constants.W_OK), WRITE_PROBE_TIMEOUT_MS);
      checks.push({ id: `writable:${dir}`, category: "data", ok: true, message: `${dir} 可写` });
    } catch (err) {
      checks.push({
        id: `writable:${dir}`,
        category: "data",
        ok: false,
        message: `数据目录不存在或不可写：${dir}（${err instanceof Error ? err.message : String(err)}）`,
      });
    }
  }
  return checks;
}
