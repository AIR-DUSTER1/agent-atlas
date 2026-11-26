/**
 * job.ts — 求职岗位 Agent 的原生执行服务
 * ============================================================
 * 职责：维护数据目录、调用内置浏览器采集/补详情、增量合并清单并导出 Excel + HTML。
 * 设计立场：不依赖外部 skill、Python 或平台 CLI；登录态和交付物全部落在应用数据目录。
 */
import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, mergeConfig } from "./config-store.js";
import { writeJobHtmlReport } from "./job-html.js";
import { writeJobWorkbook } from "./job-workbook.js";
import { collectNativeJobs, enrichNativeJobs, getJobBrowserInfo, loginNativeJob } from "./job-browser.js";
import { diagnoseNativeJobSites, type JobDiagnosisResult } from "./job-diagnose.js";
import { JOB_VERDICT_LABEL } from "./job-health.js";
import {
  JOB_GREETING_MAX_LEN, JOB_MAX_KEYWORDS, JOB_MAX_PAGES, JOB_PLATFORMS, JOB_PLATFORM_LABELS, JOB_SUPPORTED_CITIES,
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
  JOB_GREETING_MAX_LEN, JOB_PLATFORMS, JOB_PLATFORM_LABELS, JOB_SUPPORTED_CITIES, MAX_JOBS_IN_RESULT,
  jobIdentity,
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
  const absolute = resolve(saved.dataDir);
  if (absolute !== DEFAULT_DATA_DIR && !absolute.startsWith(DEFAULT_DATA_DIR.endsWith(sep) ? DEFAULT_DATA_DIR : DEFAULT_DATA_DIR + sep)) {
    throw new Error("求职数据目录必须是「应用数据目录下的相对路径」：当前值会写入应用目录之外，被拒绝。请改回相对路径（例如 job-data / custom/job）");
  }
  return absolute;
}export interface JobStatus {
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

async function writeManifest(jobs: JobRecord[], dataDirHint?: string): Promise<JobManifest> {
  const dataDir = dataDirHint ?? resolveJobDataDir();
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
  /** 跳过采集前的登录预检：仅在用户明确接受数据残缺时使用。 */
  skipLoginCheck?: boolean;
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
  /** 未登录导致中止时，需要用户去登录的平台中文名（供工具层给模型直接指向动作）。 */
  needsLogin?: string[];
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
  // 输出目录跟着清单走（清单与 Excel 永远同目录），测试传临时数据目录时自然生效
  const outDir = dirname(manifest.path);
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
    result = await collectNativeJobs(
      resolveJobDataDir(), normalized.profile, normalized.platforms, normalized.pages,
      { skipLoginCheck: input.skipLoginCheck === true },
    );
  } catch (err) {
    recordDependency("job", "down", "岗位采集失败");
    return { ok: false, summary: `采集失败：${err instanceof Error ? err.message : String(err)}` };
  }
  // 必需平台未登录时采集器直接中止（不返回岗位），这里要把「该去登录」讲清楚，
  // 而不是让用户以为是站点改版或没岗位。
  if (result.login?.needsLogin.length) {
    recordDependency("job", "degraded", "岗位采集被登录预检拦截");
    return {
      ok: false,
      summary: `已中止采集：${result.login.needsLogin.map((platform) => JOB_PLATFORM_LABELS[platform]).join("、")}未登录。` +
        `${result.login.details.join("；")}。请到「设置 → 插件 → 求职岗位」登录后再采集；` +
        "如果只想要残缺数据，可传 skipLoginCheck=true 强行采集。",
      output: tail(result.warnings.join("\n")),
      needsLogin: result.login.needsLogin.map((platform) => JOB_PLATFORM_LABELS[platform]),
    };
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
  // 过滤与清洗结果要如实报出来：用户看到「采到 60 条只剩 38 条」时需要知道原因
  const filter = result.filter;
  const filterText = filter.droppedIrrelevant || filter.droppedCity || filter.jdCleaned
    ? `；过滤 ${filter.droppedIrrelevant + filter.droppedCity} 条不相关（关键词 ${filter.droppedIrrelevant} / 城市 ${filter.droppedCity}）` +
      `${filter.jdCleaned ? `；JD 清洗 ${filter.jdCleaned} 条` : ""}`
    : "";
  return {
    ok: true,
    summary: `采集完成：新增 ${merged.added} 条、更新 ${merged.updated} 条、保留 ${merged.carried} 条，共 ${manifest.jobs.length} 条（${counts}）${filterText}${warningText}`,
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
    return old ? { ...job, status: old.status, remark: old.remark, greeting: old.greeting } : job;
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

// ---------------------------------------------------------------------------
// 招呼语闭环（内化上游 job-hunter 的 greet 三步流）：
// init 生成画像模板 → export 导出待写清单给模型撰写 → save 校验写回并重新交付。
// 全程不触外网；画像属于数据目录（随 job-data 走），不属于应用代码。
// ---------------------------------------------------------------------------

const GREET_PROFILE_NAME = "profile.md";
/** 导出给模型的 JD 截断长度：足够判断岗位要求，又不撑爆上下文。 */
const GREET_JD_MAX_CHARS = 1_200;
const GREET_EXPORT_DEFAULT_TOP = 10;
const GREET_EXPORT_MAX_TOP = MAX_JOBS_IN_RESULT;

const GREET_PROFILE_TEMPLATE = `# 求职者画像（招呼语撰写依据）

这份画像只有用户本人与求职 Agent 会读：招呼语只允许引用这里真实存在的内容，
画像里没有的一律不写 —— 宁可短，也不要编造。补全后保存本文件即可重新导出待写清单。

## 基本信息
- 当前身份：（如「3 年后端经验的工程师」；联系方式不要写进招呼语）
- 目标方向：（与采集方向一致，如 Agent 开发 / 前端开发）

## 按方向的简历文件（供 agent 挑选对应经历，招呼语里只写要点）
| 方向 | 简历文件路径 | 备注 |
|---|---|---|
| （方向名） | （本地路径） | |

## 技术栈（按真实会用的写）
- 

## 项目弹药（3-6 个，每条带量化成果）
1. **项目名**：一句话说清做了什么；量化成果（如「把 X 从 A 降到 B」「支撑 N 次/日调用」）；对应 JD 里的哪些关键词。
2. 

## 写作要点（招呼语上限 ${JOB_GREETING_MAX_LEN} 字）
- 开头直点岗位名，不写「尊敬的 HR」这类套话。
- 中间挑 1-2 个与 JD 最贴的项目，优先量化数字。
- 岗位要求里有不会的，坦诚说明学习能力，不要硬凑。
- 不写薪资期望，不写与岗位无关的经历，不编造。
`;

export interface JobGreetExportItem {
  key: string;
  platform: string;
  title: string;
  company: string;
  salary: string;
  city: string;
  score: number;
  direction: string;
  workRest: string;
  hrActive: string;
  companySize: string;
  companyIndustry: string;
  applyUrl: string;
  jdText: string;
}

export interface JobGreetExport {
  ok: true;
  profilePath: string;
  hasProfile: boolean;
  profile: string;
  maxLen: number;
  remaining: number;
  exported: number;
  /** 其中有多少条带 JD（能写贴合版），其余只能写简版。 */
  withJd: number;
  /** 跨平台去重合并掉的重复岗位数（同公司同名岗）。 */
  deduped: number;
  items: JobGreetExportItem[];
  note: string;
}

/** 生成画像模板；已存在时不覆盖（画像内容是用户手填的，覆盖等于毁稿），force 才重置。 */
export async function initJobGreetProfile(force = false, dataDirHint?: string): Promise<{ ok: boolean; path: string; created: boolean; summary: string }> {
  await ensureLoaded();
  const dataDir = dataDirHint ?? resolveJobDataDir();
  await fsp.mkdir(dataDir, { recursive: true });
  const path = join(dataDir, GREET_PROFILE_NAME);
  let exists = false;
  try { await fsp.access(path); exists = true; } catch { /* 首次生成 */ }
  if (exists && !force) {
    return { ok: true, path, created: false, summary: `画像已存在：${path}。请补全内容后再导出待写清单；要重置模板请明确指定 force。` };
  }
  await fsp.writeFile(path, GREET_PROFILE_TEMPLATE, "utf8");
  writeAudit("job.greet", { action: "init", reset: exists, force });
  return { ok: true, path, created: true, summary: `画像模板已${exists ? "重置" : "生成"}：${path}` };
}

async function readGreetProfile(dataDirHint?: string): Promise<string> {
  try {
    return await fsp.readFile(join(dataDirHint ?? resolveJobDataDir(), GREET_PROFILE_NAME), "utf8");
  } catch { return ""; }
}

function slimGreetTarget(job: JobRecord): JobGreetExportItem {
  return {
    key: jobIdentity(job),
    platform: job.platform,
    title: job.title,
    company: job.company,
    salary: job.salary,
    city: job.city,
    score: Math.round(job.score * 10) / 10,
    direction: job.direction,
    workRest: job.workRest,
    hrActive: job.hrActive,
    companySize: job.companySize,
    companyIndustry: job.companyIndustry,
    applyUrl: job.applyUrl,
    jdText: job.jdText.length > GREET_JD_MAX_CHARS ? `${job.jdText.slice(0, GREET_JD_MAX_CHARS)}…` : job.jdText,
  };
}

/** 公司名/岗位名归一，用于跨平台查重（去掉标点与空格，中文保持原样）。 */
function normalizeNameKey(text: string): string {
  return text.replace(/[^\w\u4e00-\u9fa5]/g, "").toLowerCase();
}

/**
 * 跨平台去重：同一公司在 BOSS 和猎聘各发一份时其实是同一个岗位。
 *
 * 不去重的话会给同一岗位写两份几乎一样的招呼语，纯属浪费。
 * 保留策略：有 JD 的优先（能写贴合版），其次分数高的。
 */
function dedupeAcrossPlatforms(jobs: readonly JobRecord[]): { jobs: JobRecord[]; deduped: number } {
  const best = new Map<string, JobRecord>();
  const order: string[] = [];
  for (const job of jobs) {
    const key = `${normalizeNameKey(job.company)}|${normalizeNameKey(job.title)}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, job);
      order.push(key);
      continue;
    }
    const existingHasJd = Boolean(existing.jdText.trim());
    const nextHasJd = Boolean(job.jdText.trim());
    // 先比有无 JD（true 更大），再比分数
    if (nextHasJd !== existingHasJd ? nextHasJd : job.score > existing.score) best.set(key, job);
  }
  return { jobs: order.map((key) => best.get(key)!), deduped: jobs.length - order.length };
}

/** 导出待写招呼语清单（默认按分数取前 10 条；overwrite 重写已写过的）。dataDirHint 供测试使用。 */
export async function exportJobGreetTargets(
  input: { top?: number; overwrite?: boolean } = {},
  dataDirHint?: string,
): Promise<JobGreetExport> {
  await ensureLoaded();
  const manifest = await readManifest(dataDirHint);
  if (!manifest?.jobs.length) throw new Error("还没有岗位清单：请先 job_collect。");
  const top = Math.max(1, Math.min(GREET_EXPORT_MAX_TOP, Math.round(input.top ?? GREET_EXPORT_DEFAULT_TOP)));
  const pool = input.overwrite ? manifest.jobs : manifest.jobs.filter((job) => !job.greeting.trim());
  // 去重在三件事之前：否则「剩余条数」和「导出条数」都会偏大
  const { jobs: unique, deduped } = dedupeAcrossPlatforms(pool);
  // 有 JD 的排前面（能写贴合版），同组内按分数降序
  const ordered = [...unique]
    .sort((a, b) => Number(Boolean(b.jdText.trim())) - Number(Boolean(a.jdText.trim())) || b.score - a.score)
    .slice(0, top);
  const profile = await readGreetProfile(dataDirHint);
  return {
    ok: true,
    profilePath: join(dataDirHint ?? resolveJobDataDir(), GREET_PROFILE_NAME),
    hasProfile: Boolean(profile.trim()),
    profile,
    maxLen: JOB_GREETING_MAX_LEN,
    remaining: unique.length,
    exported: ordered.length,
    withJd: ordered.filter((job) => Boolean(job.jdText.trim())).length,
    deduped,
    items: ordered.map(slimGreetTarget),
    note:
      "逐条撰写招呼语后用 job_greet_save 写回，JSON 数组格式 [{\"key\":\"…\",\"greeting\":\"…\"}]。" +
      `每条不超过 ${JOB_GREETING_MAX_LEN} 字：开头直点岗位名，只引用画像里真实存在的内容，优先量化数字，` +
      "岗位要求超出时坦诚说明，不写薪资期望、不编造。" +
      (deduped ? `已合并 ${deduped} 条跨平台重复岗位（同公司同名岗）。` : "") +
      (profile.trim() ? "" : "注意：画像还不存在，请先让用户确认后用 job_greet action=init 生成并补全，再撰写。"),
  };
}

export interface JobGreetSaveOutcome {
  ok: boolean;
  summary: string;
  saved: number;
  truncated: number;
  /** 质量存疑但仍写入的条目（标题 + 问题列表）；只提示不拦截，最终由人判断。 */
  flagged: Array<{ title: string; problems: string[] }>;
  xlsxPath?: string;
  htmlPath?: string;
}

/** 招呼语过短阈值（字符数）：低于这个长度基本没有信息量。 */
const GREETING_MIN_LEN = 20;

/** JD 页面文案特征：混进招呼语会直接暴露「这是抄的」。 */
const JD_UI_TEXT_PATTERN = /去App|去APP|点击查看地图|查看更多信息|随时沟通|BOSS直聘|kanzhun|招聘者/;
/** 敬语开头：招呼语应该直接点岗位，而不是「您好，我是…」。 */
const HONORIFIC_PATTERN = /^\s*(您好|你好|尊敬的|各位)/;
/** 薪资期望的各种说法；后面紧跟着数字或「面议/不低于」才算命中。 */
const SALARY_EXPECTATION_PATTERN = /(期望薪资|薪资期望|薪资范围|待遇要求|月薪|年薪|工资|薪资)[^。；\n]{0,8}?(\d|面议|不低于|左右|以上)/;

/**
 * 招呼语质量检查：返回问题列表，空数组表示通过。
 *
 * 只提示不拦截——是否采用最终由人判断，但问题必须可见。这四类都是上游实测
 * 会真实发生的错误（把 JD 页面文案抄进去、开头堆敬语、写了薪资、太短没内容）。
 */
export function greetingProblems(text: string): string[] {
  const problems: string[] = [];
  if ([...text].length < GREETING_MIN_LEN) problems.push(`过短（<${GREETING_MIN_LEN} 字），信息量不足`);
  if (JD_UI_TEXT_PATTERN.test(text)) problems.push("混入了 JD 页面文案（如「去App」「随时沟通」）");
  if (HONORIFIC_PATTERN.test(text)) problems.push("以敬语开头（建议直接点岗位名）");
  if (SALARY_EXPECTATION_PATTERN.test(text)) problems.push("写了薪资期望（应留到沟通时谈）");
  return problems;
}

/** 校验并写回招呼语：key 对不上逐条报错（不静默丢弃），超长截断并计数。dataDirHint 供测试使用。 */
export async function saveJobGreetings(
  items: Array<{ key: string; greeting: string }>,
  dataDirHint?: string,
): Promise<JobGreetSaveOutcome> {
  await ensureLoaded();
  const manifest = await readManifest(dataDirHint);
  if (!manifest?.jobs.length) throw new Error("还没有岗位清单：请先 job_collect。");
  const byKey = new Map(manifest.jobs.map((job) => [jobIdentity(job), job]));
  const unknown = items.filter((item) => !byKey.has(item.key)).map((item) => item.key);
  if (unknown.length) {
    throw new Error(`以下 key 不在当前清单里（清单可能已重新采集），请用 job_greet 重新导出后再写：${unknown.join("、")}`);
  }
  const applied = items.filter((item) => typeof item.greeting === "string" && item.greeting.trim());
  if (!applied.length) throw new Error("没有可写回的招呼语：每条都需要非空的 greeting 字段。");
  let truncated = 0;
  const flagged: Array<{ title: string; problems: string[] }> = [];
  for (const item of applied) {
    const chars = [...item.greeting.trim()];
    if (chars.length > JOB_GREETING_MAX_LEN) truncated += 1;
    const text = chars.slice(0, JOB_GREETING_MAX_LEN).join("");
    const target = byKey.get(item.key)!;
    target.greeting = text;
    // 质量校验用**截断后**的文本：截断可能正好切掉某个问题特征
    const problems = greetingProblems(text);
    if (problems.length) flagged.push({ title: target.title, problems });
  }
  const updatedManifest = await writeManifest(manifest.jobs, dataDirHint);
  const deliverables = await refreshDeliverables(updatedManifest);
  writeAudit("job.greet", { action: "save", saved: applied.length, truncated, flagged: flagged.length });
  return {
    ok: true,
    summary: `招呼语已写回 ${applied.length} 条${truncated ? `，超长截断 ${truncated} 条` : ""}` +
      `${flagged.length ? `，${flagged.length} 条质量存疑（已写入，建议人工过一遍）` : ""}。` +
      `Excel：${deliverables.xlsxPath ?? "未生成"}；HTML：${deliverables.htmlPath ?? "未生成"}`,
    saved: applied.length,
    truncated,
    flagged,
    ...(deliverables.xlsxPath ? { xlsxPath: deliverables.xlsxPath } : {}),
    ...(deliverables.htmlPath ? { htmlPath: deliverables.htmlPath } : {}),
  };
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
