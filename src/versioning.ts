/**
 * ============================================================
 * versioning.ts — 产品版本、构建标识与发布一致性
 * ============================================================
 * 职责：以 package.json.version 为唯一产品版本源，生成不可变构建元数据并校验仓库内版本引用。
 * 设计立场：产品版本与构建号、API 版本、数据 schema 版本彼此独立；构建元数据只能自动生成。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_INFO_RELATIVE_PATH = join("src", "server", "public", "build-info.json");

export const BUILD_CHANNELS = ["dev", "alpha", "beta", "rc", "stable"] as const;
export type BuildChannel = (typeof BUILD_CHANNELS)[number];
export type PrereleaseStage = "alpha" | "beta" | "rc";
export type ReleaseStage = PrereleaseStage | "stable";

export interface BuildInfo {
  version: string;
  channel: BuildChannel;
  releaseStage: ReleaseStage;
  commit: string;
  builtAt: string;
  buildId: string;
}

export interface ParsedReleaseVersion {
  version: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: { stage: PrereleaseStage; sequence: number } | null;
  releaseStage: ReleaseStage;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{7,64}|unknown)$/i;

/** 当前规范只允许 alpha / beta / rc + 数字作为预发布段，避免出现不可比较的渠道名。 */
export function parseReleaseVersion(version: string): ParsedReleaseVersion {
  const normalized = version.trim();
  const match = SEMVER_PATTERN.exec(normalized);
  if (!match) throw new Error(`版本号 ${JSON.stringify(version)} 不是 SemVer 2.0 格式`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4];
  if (!prerelease) {
    return { version: normalized, major, minor, patch, prerelease: null, releaseStage: "stable" };
  }
  const parts = prerelease.split(".");
  const stage = parts[0];
  if (stage !== "alpha" && stage !== "beta" && stage !== "rc") {
    throw new Error("预发布段只允许 alpha.N、beta.N 或 rc.N");
  }
  if (parts.length !== 2 || !/^(0|[1-9]\d*)$/.test(parts[1] ?? "")) {
    throw new Error("预发布版本必须使用 alpha.N、beta.N 或 rc.N，N 为无前导零整数");
  }
  const sequence = Number(parts[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("预发布版本序号 N 必须是安全的正整数");
  }
  return {
    version: normalized,
    major,
    minor,
    patch,
    prerelease: { stage, sequence },
    releaseStage: stage,
  };
}

const STAGE_ORDER: Record<PrereleaseStage, number> = { alpha: 0, beta: 1, rc: 2 };

/** 按 SemVer 2.0 比较产品版本；构建元数据不参与排序。 */
export function compareReleaseVersions(leftVersion: string, rightVersion: string): number {
  const left = parseReleaseVersion(leftVersion);
  const right = parseReleaseVersion(rightVersion);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  if (left.prerelease.stage !== right.prerelease.stage) {
    return STAGE_ORDER[left.prerelease.stage] - STAGE_ORDER[right.prerelease.stage];
  }
  return left.prerelease.sequence - right.prerelease.sequence;
}

function sameCoreVersion(left: ParsedReleaseVersion, right: ParsedReleaseVersion): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

/**
 * main 合并版本门禁：
 * - main 只接收 beta / rc / stable，alpha 留在开发分支；
 * - 版本必须严格高于 main 基线；
 * - 同一 core 的 beta/rc 序号每次只能递增 1，避免跳号或复用。
 */
export function collectMainMergeVersionIssues(baseVersion: string, nextVersion: string): string[] {
  const issues: string[] = [];
  const base = parseReleaseVersion(baseVersion);
  const next = parseReleaseVersion(nextVersion);
  if (next.releaseStage === "alpha") {
    issues.push("main 分支不接受 alpha 版本；请先推进到 beta.N 再合并");
  }
  if (compareReleaseVersions(next.version, base.version) <= 0) {
    issues.push(`main 合并必须提升产品版本：基线 ${base.version}，当前 ${next.version}`);
  }
  if (
    sameCoreVersion(base, next) &&
    base.prerelease &&
    next.prerelease &&
    base.prerelease.stage === next.prerelease.stage &&
    (base.prerelease.stage === "beta" || base.prerelease.stage === "rc") &&
    next.prerelease.sequence !== base.prerelease.sequence + 1
  ) {
    issues.push(
      `同一 ${base.prerelease.stage} 线路每次 main 合并只能递增 1：` +
      `${base.version} → ${base.prerelease.stage}.${base.prerelease.sequence + 1}`,
    );
  }
  return issues;
}

function normalizeChannel(value: string | undefined): BuildChannel {
  const channel = (value || "dev").trim().toLowerCase();
  if (!(BUILD_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`RELEASE_CHANNEL 必须是 ${BUILD_CHANNELS.join(" / ")} 之一`);
  }
  return channel as BuildChannel;
}

function resolveCommit(root: string, env: NodeJS.ProcessEnv): string {
  const supplied = env.GIT_COMMIT?.trim();
  if (supplied) {
    if (!COMMIT_PATTERN.test(supplied)) throw new Error("GIT_COMMIT 必须是 7–64 位十六进制提交号或 unknown");
    return supplied.toLowerCase();
  }
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    return COMMIT_PATTERN.test(commit) ? commit.toLowerCase() : "unknown";
  } catch {
    return "unknown";
  }
}

function resolveBuiltAt(env: NodeJS.ProcessEnv, now: Date): string {
  const raw = env.BUILD_TIME?.trim();
  if (raw && raw !== "unknown") {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error("BUILD_TIME 必须是可解析的 ISO 时间");
    return date.toISOString();
  }
  return now.toISOString();
}

function buildIdFor(channel: BuildChannel, builtAt: string, commit: string): string {
  const timestamp = builtAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${channel}.${timestamp}.${commit.slice(0, 8)}`;
}

export async function readPackageVersion(root = PROJECT_ROOT): Promise<string> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error("package.json 缺少字符串 version");
  if (pkg.version !== pkg.version.trim()) throw new Error("package.json version 不得包含首尾空白");
  parseReleaseVersion(pkg.version);
  return pkg.version;
}

export async function createBuildInfo(options: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): Promise<BuildInfo> {
  const root = options.root ?? PROJECT_ROOT;
  const env = options.env ?? process.env;
  const version = await readPackageVersion(root);
  const { releaseStage } = parseReleaseVersion(version);
  const channel = normalizeChannel(env.RELEASE_CHANNEL);
  const commit = resolveCommit(root, env);
  const builtAt = resolveBuiltAt(env, options.now ?? new Date());
  return { version, channel, releaseStage, commit, builtAt, buildId: buildIdFor(channel, builtAt, commit) };
}

export function validateBuildInfo(value: unknown): BuildInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("build-info 必须是对象");
  const info = value as Record<string, unknown>;
  if (typeof info.version !== "string") throw new Error("build-info.version 缺失");
  const { releaseStage } = parseReleaseVersion(info.version);
  if (!(BUILD_CHANNELS as readonly string[]).includes(String(info.channel))) {
    throw new Error("build-info.channel 非法");
  }
  if (info.releaseStage !== releaseStage) throw new Error("build-info.releaseStage 与版本号不一致");
  if (typeof info.commit !== "string" || !COMMIT_PATTERN.test(info.commit)) {
    throw new Error("build-info.commit 非法");
  }
  if (typeof info.builtAt !== "string" || Number.isNaN(new Date(info.builtAt).getTime())) {
    throw new Error("build-info.builtAt 非法");
  }
  const expectedBuildId = buildIdFor(info.channel as BuildChannel, new Date(info.builtAt).toISOString(), info.commit);
  if (info.buildId !== expectedBuildId) throw new Error("build-info.buildId 与 channel/时间/提交不一致");
  return info as unknown as BuildInfo;
}

export async function writeBuildInfo(root: string, info: BuildInfo): Promise<void> {
  const target = join(root, BUILD_INFO_RELATIVE_PATH);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(info, null, 2) + "\n", "utf8");
}

export async function readBuildInfoFile(root = PROJECT_ROOT): Promise<BuildInfo> {
  const target = join(root, BUILD_INFO_RELATIVE_PATH);
  const info = validateBuildInfo(JSON.parse(await readFile(target, "utf8")) as unknown);
  const version = await readPackageVersion(root);
  if (info.version !== version) {
    throw new Error(`build-info ${info.version} 与 package.json ${version} 不一致，请重新运行 npm run build:client`);
  }
  return info;
}

export function readRuntimeBuildInfo(root = PROJECT_ROOT): BuildInfo {
  const target = join(root, BUILD_INFO_RELATIVE_PATH);
  if (!existsSync(target)) throw new Error("缺少 build-info.json，请先运行 npm run build:client");
  const info = validateBuildInfo(JSON.parse(readFileSync(target, "utf8")) as unknown);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || info.version !== pkg.version) {
    throw new Error(`build-info ${info.version} 与 package.json ${String(pkg.version)} 不一致，请重新运行 npm run build:client`);
  }
  return info;
}

export function renderBuildInfoMeta(info: BuildInfo): string {
  const escape = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    `<meta name="agentatlas-version" content="${escape(info.version)}" />`,
    `<meta name="agentatlas-channel" content="${escape(info.channel)}" />`,
    `<meta name="agentatlas-release-stage" content="${escape(info.releaseStage)}" />`,
    `<meta name="agentatlas-commit" content="${escape(info.commit)}" />`,
    `<meta name="agentatlas-built-at" content="${escape(info.builtAt)}" />`,
    `<meta name="agentatlas-build-id" content="${escape(info.buildId)}" />`,
  ].join("\n  ");
}

export function injectBuildInfoHtml(html: string, info: BuildInfo): string {
  const token = "<!-- @build-info -->";
  if (!html.includes(token)) throw new Error("index.html 缺少 <!-- @build-info --> 注入点");
  return html.replace(token, renderBuildInfoMeta(info));
}

/** 发布规范检查：可单独运行，也被版本测试复用。 */
export async function collectVersioningIssues(root = PROJECT_ROOT): Promise<string[]> {
  const issues: string[] = [];
  let version = "";
  try {
    version = await readPackageVersion(root);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }

  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    issues.push(`package-lock.json 版本不是 ${version}`);
  }

  const badgeVersion = version.replace(/-/g, "--");
  const readme = await readFile(join(root, "README.md"), "utf8");
  if (!readme.includes(`version-${badgeVersion}-`)) issues.push(`README.md 版本徽章未同步到 ${version}`);

  for (const relative of [
    "docs/product-wiki.md",
    "docs/production-checklist.md",
    "docs/deployment.md",
    "docs/self-hosting.md",
    "docs/upgrade-rollback.md",
    "docs/postgres-multitenant.md",
    "docs/support.md",
  ]) {
    const text = await readFile(join(root, relative), "utf8");
    if (!text.includes(version)) issues.push(`${relative} 未标记当前版本 ${version}`);
  }

  const buildPath = join(root, BUILD_INFO_RELATIVE_PATH);
  if (existsSync(buildPath)) {
    try {
      const info = validateBuildInfo(JSON.parse(await readFile(buildPath, "utf8")) as unknown);
      if (info.version !== version) issues.push(`build-info.json 版本不是 ${version}`);
    } catch (err) {
      issues.push(`build-info.json 无效：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return issues;
}
