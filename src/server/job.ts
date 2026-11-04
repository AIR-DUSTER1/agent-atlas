/**
 * job.ts — 求职岗位 Agent 的原生执行服务
 * ============================================================
 * 职责：维护数据目录、调用内置浏览器采集/补详情、增量合并清单并导出 Excel + HTML。
 * 设计立场：不依赖外部 skill、Python 或平台 CLI；登录态和交付物全部落在应用数据目录。
 */
import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, mergeConfig } from "./config-store.js";
import { writeJobHtmlReport } from "./job-html.js";
import { writeJobWorkbook } from "./job-workbook.js";
import { collectNativeJobs, enrichNativeJobs, getJobBrowserInfo, loginNativeJob } from "./job-browser.js";
import { diagnoseNativeJobSites, type JobDiagnosisResult } from "./job-diagnose.js";
import { JOB_VERDICT_LABEL } from "./job-health.js";
import {
  JOB_MAX_KEYWORDS, JOB_MAX_PAGES, JOB_PLATFORMS, JOB_PLATFORM_LABELS, JOB_SUPPORTED_CITIES,
  MAX_JOBS_IN_RESULT, jobIdentity, mergeJobRecords, normalizeStoredJob, queryJobRecords, scoreJob,
  type JobManifest, type JobPlatform, type JobQuery, type JobRecord, type JobSearchProfile,
} from "./job-model.js";
import { writeAudit } from "./audit.js";
import { recordDependency } from "./observability/dependency-status.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(MODULE_DIR, "..", "..", ".setting", "job-data");
const MAX_RESULT_CHARS = 26_000;
const MAX_MANIFEST_BYTES = 20_000_000;
const MANIFEST_NAME = "最新岗位清单.json";

interface JobSaved {
  dataDir?: string;
  lastCity?: string;
}

let saved: JobSaved = {};
let loaded = false;

export {
  JOB_PLATFORMS, JOB_PLATFORM_LABELS, JOB_SUPPORTED_CITIES, MAX_JOBS_IN_RESULT,
  type JobManifest, type JobPlatform, type JobQuery, type JobRecord,
};

export async function loadJob(): Promise<void> {
  const cfg = await readConfig();
  const source = (cfg.job ?? {}) as Record<string, unknown>;
  saved = {
    dataDir: typeof source.dataDir === "string" && source.dataDir.trim() ? source.dataDir.trim() : "",
    lastCity: typeof source.lastCity === "string" ? source.lastCity : "",
  };
  loaded = true;
}

const ensureLoaded = (): Promise<void> => (loaded ? Promise.resolve() : loadJob());
async function persistJob(): Promise<void> { await mergeConfig({ job: saved }); }

export function resolveJobDataDir(): string {
  if (!saved.dataDir) return DEFAULT_DATA_DIR;
  return isAbsolute(saved.dataDir) ? saved.dataDir : join(DEFAULT_DATA_DIR, saved.dataDir);
}

export interface JobStatus {
  installed: boolean;
  hasOverride: boolean;
  browserOK: boolean;
  browserName: string;
  browserError: string;
  dataDir: string;
  lastRunJobs: number;
  lastRunAt: string;
  profilePresent: boolean;
  platform: string;
  error?: string;
}

export async function getJobPublic(): Promise<JobStatus> {
  await ensureLoaded();
  const browser = getJobBrowserInfo();
  const dataDir = resolveJobDataDir();
  const manifest = await readManifest().catch(() => null);
  let profilePresent = false;
  try {
    profilePresent = (await fsp.readdir(join(dataDir, ".profile"))).length > 0;
  } catch { /* 首次使用尚无登录态 */ }
  return {
    installed: browser.available,
    hasOverride: Boolean(saved.dataDir),
    browserOK: browser.available,
    browserName: browser.name,
    browserError: browser.error,
    dataDir,
    lastRunJobs: manifest?.jobs.length ?? 0,
    lastRunAt: manifest?.fetchedAt ?? "",
    profilePresent,
    platform: process.platform,
  };
}

export async function saveJobConfig(input: { dataDir?: unknown }): Promise<JobStatus> {
  await ensureLoaded();
  if (input.dataDir !== undefined) {
    if (typeof input.dataDir !== "string") throw new Error("数据目录必须是字符串");
    saved.dataDir = input.dataDir.trim();
  }
  await persistJob();
  writeAudit("job.updated", { dataDir: saved.dataDir });
  return getJobPublic();
}

export async function readManifest(dataDirHint?: string): Promise<JobManifest | null> {
  if (!dataDirHint) await ensureLoaded();
  const dataDir = dataDirHint ?? resolveJobDataDir();
  const path = join(dataDir, "out", MANIFEST_NAME);
  let stat;
  try { stat = await fsp.stat(path); } catch { return null; }
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error(`岗位清单过大（${stat.size} 字节），拒绝读取`);
  const parsed = JSON.parse(await fsp.readFile(path, "utf8")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown }).jobs) ? (parsed as { jobs: unknown[] }).jobs : []);
  const jobs = rows.map(normalizeStoredJob).filter((job): job is JobRecord => Boolean(job));
  const fetchedAt = jobs.map((job) => job.fetchedAt).filter(Boolean).sort().at(-1) ?? "";
  return { jobs, fetchedAt, path };
}

async function writeManifest(jobs: JobRecord[]): Promise<JobManifest> {
  const dataDir = resolveJobDataDir();
  const outDir = join(dataDir, "out");
  await fsp.mkdir(outDir, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const path = join(outDir, MANIFEST_NAME);
  const manifest: JobManifest = { jobs, fetchedAt, path };
  const temp = `${path}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(jobs, null, 2), "utf8");
  await fsp.rename(temp, path);
  return manifest;
}

export interface CollectInput extends JobSearchProfile {
  pages?: number;
  platforms?: JobPlatform[];
}

export interface JobDiagnoseInput {
  keywords?: string[];
  city?: string;
  platforms?: JobPlatform[];
  apply?: boolean;
  detail?: number;
  simulate?: JobPlatform;
}

export interface JobDiagnoseOutcome {
  ok: boolean;
  summary: string;
  output: string;
  reportPath: string;
  report: JobDiagnosisResult;
}

export interface CliOutcome {
  ok: boolean;
  summary: string;
  output?: string;
  manifest?: JobManifest;
  htmlPath?: string;
  htmlError?: string;
  xlsxPath?: string;
}

function normalizeCollectInput(input: CollectInput): { profile: JobSearchProfile; pages: number; platforms: JobPlatform[] } {
  const keywords = [...new Set(input.keywords.map((item) => item.trim()).filter(Boolean))].slice(0, JOB_MAX_KEYWORDS);
  if (!keywords.length) throw new Error("目标岗位方向不能为空");
  if (!JOB_SUPPORTED_CITIES.includes(input.city)) throw new Error(`暂不支持城市「${input.city}」；可选：${JOB_SUPPORTED_CITIES.join("、")}`);
  if (!Number.isFinite(input.salaryMin) || !Number.isFinite(input.salaryMax) || input.salaryMin > input.salaryMax) {
    throw new Error("期望月薪区间不合法，请给出 min <= max 的税前月薪（K）");
  }
  if (!Number.isFinite(input.years) || input.years < 0) throw new Error("工作年限不合法");
  const pages = Math.max(1, Math.min(JOB_MAX_PAGES, Math.round(input.pages ?? 1)));
  const platforms = [...new Set(input.platforms?.length ? input.platforms : JOB_PLATFORMS)];
  return {
    profile: { keywords, city: input.city, salaryMin: input.salaryMin, salaryMax: input.salaryMax, years: input.years },
    pages, platforms,
  };
}

function tail(text: string, limit = 2_000): string { return text.length > limit ? text.slice(-limit) : text; }

async function refreshDeliverables(manifest: JobManifest): Promise<{ xlsxPath?: string; htmlPath?: string; htmlError?: string }> {
  const outDir = join(resolveJobDataDir(), "out");
  let xlsxPath: string | undefined;
  let htmlPath: string | undefined;
  let htmlError: string | undefined;
  try { xlsxPath = await writeJobWorkbook(manifest, outDir); }
  catch (err) { return { htmlError: `Excel 生成失败：${err instanceof Error ? err.message : String(err)}` }; }
  try { htmlPath = await writeJobHtmlReport(manifest); }
  catch (err) { htmlError = err instanceof Error ? err.message : String(err); }
  return { xlsxPath, htmlPath, htmlError };
}

export async function collectJobs(input: CollectInput): Promise<CliOutcome> {
  await ensureLoaded();
  const normalized = normalizeCollectInput(input);
  const previous = (await readManifest().catch(() => null))?.jobs ?? [];
  let result;
  try {
    result = await collectNativeJobs(resolveJobDataDir(), normalized.profile, normalized.platforms, normalized.pages);
  } catch (err) {
    recordDependency("job", "down", "岗位采集失败");
    return { ok: false, summary: `采集失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!result.jobs.length) {
    recordDependency("job", "degraded", "岗位采集未返回数据");
    return {
      ok: false,
      summary: `所选平台均未采到岗位。${result.warnings.join("；") || "请先在求职数据源面板登录 BOSS直聘，或稍后重试。"}`,
      output: tail(result.warnings.join("\n")),
    };
  }
  const activePlatforms = new Set(normalized.platforms.map((platform) => JOB_PLATFORM_LABELS[platform]));
  const merged = mergeJobRecords(result.jobs, previous, activePlatforms);
  const manifest = await writeManifest(merged.jobs);
  const deliverables = await refreshDeliverables(manifest);
  saved.lastCity = normalized.profile.city;
  await persistJob();
  recordDependency("job", "ok", "岗位采集正常");
  writeAudit("job.collect", {
    city: normalized.profile.city,
    platforms: normalized.platforms,
    added: merged.added,
    updated: merged.updated,
    carried: merged.carried,
  });
  const byPlatform = new Map<string, number>();
  for (const job of result.jobs) byPlatform.set(job.platform, (byPlatform.get(job.platform) ?? 0) + 1);
  const counts = [...byPlatform.entries()].map(([name, count]) => `${name} ${count}`).join(" · ");
  const warningText = result.warnings.length ? `；注意：${result.warnings.join("；")}` : "";
  return {
    ok: true,
    summary: `采集完成：新增 ${merged.added} 条、更新 ${merged.updated} 条、保留 ${merged.carried} 条，共 ${manifest.jobs.length} 条（${counts}）${warningText}`,
    output: tail([...result.warnings, `Excel: ${deliverables.xlsxPath ?? "未生成"}`, `HTML: ${deliverables.htmlPath ?? "未生成"}`].join("\n")),
    manifest,
    ...deliverables,
  };
}

export async function enrichJobs(limit = 10): Promise<CliOutcome> {
  await ensureLoaded();
  const manifest = await readManifest();
  if (!manifest?.jobs.length) return { ok: false, summary: "还没有岗位清单：请先 job_collect。" };
  const previousByKey = new Map(manifest.jobs.map((job) => [jobIdentity(job), job]));
  const safeLimit = Math.max(1, Math.min(50, Math.round(limit)));
  let result;
  try {
    result = await enrichNativeJobs(resolveJobDataDir(), manifest.jobs, safeLimit);
  } catch (err) {
    recordDependency("job", "down", "岗位补详情失败");
    return { ok: false, summary: `补详情失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const jobs = result.jobs.map((job) => {
    const old = previousByKey.get(jobIdentity(job));
    return old ? { ...job, status: old.status, remark: old.remark } : job;
  });
  const updatedManifest = await writeManifest(jobs);
  const deliverables = await refreshDeliverables(updatedManifest);
  recordDependency("job", "ok", "岗位补详情正常");
  writeAudit("job.enrich", { updated: result.updated, warnings: result.warnings });
  return {
    ok: true,
    summary: `补详情完成（${result.updated}/${safeLimit} 条）。${result.warnings.length ? `提示：${result.warnings.join("；")}` : ""}`,
    output: tail([...result.warnings, `Excel: ${deliverables.xlsxPath ?? "未生成"}`, `HTML: ${deliverables.htmlPath ?? "未生成"}`].join("\n")),
    manifest: updatedManifest,
    ...deliverables,
  };
}

export async function startLogin(platform: JobPlatform): Promise<CliOutcome> {
  await ensureLoaded();
  const result = await loginNativeJob(platform, resolveJobDataDir());
  return { ok: result.ok, summary: result.output, output: result.output };
}

export async function diagnoseJobs(input: JobDiagnoseInput = {}): Promise<JobDiagnoseOutcome> {
  await ensureLoaded();
  const keywords = [...new Set((input.keywords ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, JOB_MAX_KEYWORDS);
  if (!keywords.length) keywords.push("Agent开发");
  const city = (input.city?.trim() || saved.lastCity || "青岛") as JobSearchProfile["city"];
  if (!JOB_SUPPORTED_CITIES.includes(city)) throw new Error(`暂不支持城市「${city}」；可选：${JOB_SUPPORTED_CITIES.join("、")}`);
  const simulate = input.simulate && JOB_PLATFORMS.includes(input.simulate) ? input.simulate : undefined;
  const platforms = simulate
    ? [simulate]
    : [...new Set(input.platforms?.length ? input.platforms : JOB_PLATFORMS)].filter((item): item is JobPlatform => JOB_PLATFORMS.includes(item));
  if (!platforms.length) throw new Error(`至少选择一个诊断平台；可选：${JOB_PLATFORMS.join(" / ")}`);
  const profile: JobSearchProfile = { keywords, city, salaryMin: 10, salaryMax: 20, years: 2 };
  const report = await diagnoseNativeJobSites(resolveJobDataDir(), profile, platforms, {
    detail: input.detail,
    apply: Boolean(input.apply),
    simulate,
  });
  const reportDir = join(resolveJobDataDir(), "out", "diagnose");
  await fsp.mkdir(reportDir, { recursive: true });
  const stamp = report.at.replace(/[-:]/g, "").replace(/T/, "_").replace(/\..+/, "");
  const reportPath = join(reportDir, `结构诊断_${stamp}.json`);
  await fsp.writeFile(reportPath, `${JSON.stringify({ ...report, profile }, null, 2)}\n`, "utf8");
  writeAudit("job.diagnose", {
    city,
    platforms,
    overall: report.overall,
    applied: report.applied,
    reportPath,
  });
  recordDependency("job", report.ok ? "ok" : "degraded", `岗位结构诊断：${JOB_VERDICT_LABEL[report.overall]}`);
  const lines = report.platforms.map((item) => {
    const fields = item.fields.filter((field) => field.total).map((field) => `${field.name} ${Math.round(field.rate * 100)}%`).join(" ");
    return `[${JOB_VERDICT_LABEL[item.verdict]}] ${JOB_PLATFORM_LABELS[item.platform]}：${item.cardCount} 张卡片 / ${item.jobs} 条${fields ? `；${fields}` : ""}${item.notes.length ? `；${item.notes.join("；")}` : ""}`;
  });
  const appliedText = report.applied.length
    ? `；已固化 ${report.applied.map((item) => `${JOB_PLATFORM_LABELS[item.platform]} ${item.selector}`).join("、")}`
    : "";
  return {
    ok: report.ok,
    summary: `结构诊断完成：${JOB_VERDICT_LABEL[report.overall]}${appliedText}`,
    output: [...lines, `报告：${reportPath}`].join("\n"),
    reportPath,
    report,
  };
}

export async function doctorJob(): Promise<{ ok: boolean; text: string }> {
  await ensureLoaded();
  const browser = getJobBrowserInfo();
  const dataDir = resolveJobDataDir();
  const manifest = await readManifest().catch(() => null);
  let writable = false;
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    const probe = join(dataDir, `.write-probe-${process.pid}`);
    await fsp.writeFile(probe, "ok", "utf8");
    await fsp.rm(probe, { force: true });
    writable = true;
  } catch { /* 下面统一报告 */ }
  const ok = browser.available && writable;
  const text = [
    `[${browser.available ? "✓" : "✗"}] 浏览器：${browser.available ? browser.name : browser.error}`,
    `[${writable ? "✓" : "✗"}] 数据目录：${dataDir}`,
    `[✓] 内置采集流程：BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘`,
    `[${manifest ? "✓" : "!"}] 最近清单：${manifest ? `${manifest.jobs.length} 条` : "暂无"}`,
  ].join("\n");
  return { ok, text };
}

export async function queryJobs(query: JobQuery): Promise<{ jobs: JobRecord[]; total: number; manifestPath: string }> {
  const manifest = await readManifest();
  if (!manifest) throw new Error("还没有岗位清单：请先采集一次岗位");
  const jobs = queryJobRecords(manifest.jobs, query, MAX_JOBS_IN_RESULT);
  return { jobs, total: manifest.jobs.length, manifestPath: manifest.path };
}

/** 给测试或维护脚本复用：按当前清单重新评分。 */
export function rescoreManifest(manifest: JobManifest, profile: JobSearchProfile): JobManifest {
  return { ...manifest, jobs: manifest.jobs.map((job) => scoreJob(job, profile)) };
}

export { MAX_RESULT_CHARS };
