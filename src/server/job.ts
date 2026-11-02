/**
 * ============================================================
 * server/job.ts — 求职岗位能力接入（job-hunter 技能 CLI 客户端）
 * ============================================================
 * 设计定位：岗位采集 / 补详情 / Excel 交付与 HTML 报告生成全部委托给 job-hunter 技能链路的
 * Python CLI（`python -m scripts.main`）。本模块是它的子进程客户端：
 *   - 探测：找到 python 解释器 + job-hunter 技能根目录 + 依赖是否装齐
 *   - 执行：collect / enrich / login / verify / doctor 子命令
 *   - 产出：读取 out/ 下的「最新岗位清单.json」作为结构化数据源
 *
 * 关键约束（与技能文档一致的硬边界）：
 *   - **必须在技能根目录执行**：`scripts` 是包名，`python -m scripts.main`
 *     只能从技能根目录解析，换目录会 ModuleNotFoundError；
 *   - **必须设置 JOBHUNT_HOME**：否则登录态与产出写进技能目录，升级即丢；
 *   - 登录与过风控是**交互步骤**，必须停了下来等用户扫码 —— 因此
 *     `login`/`verify` 不封装成 Agent 工具，只在设置页提供按钮；
 *   - 采集耗时长（四平台 × 2 页约 3-5 分钟），单次子进程超时要给足。
 */
import { runControlled } from "./subprocess.js";
import { promises as fsp } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, mergeConfig } from "./config-store.js";
import { writeJobHtmlReport } from "./job-html.js";
import { writeAudit } from "./audit.js";
import { recordDependency } from "./observability/dependency-status.js";
import { CircuitBreaker } from "./runtime/circuit-breaker.js";
import { log } from "./logging.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 常量（限量即上限）
// ---------------------------------------------------------------------------
/** 单次探测 / doctor 的最长时间 */
const PROBE_TIMEOUT_MS = 20_000;
/** 采集：四平台 × 2 页约 3-5 分钟，给 12 分钟上限 */
const COLLECT_TIMEOUT_MS = 720_000;
/** 补详情：逐条打开岗位页，比采集更慢 */
const ENRICH_TIMEOUT_MS = 900_000;
/** 子进程输出上限（CLI 会打印进度，不能无限收） */
const MAX_OUTPUT_BYTES = 2_000_000;
/** 工具结果进模型上下文的字符上限 */
const MAX_RESULT_CHARS = 26_000;
/** 单次返回给模型的岗位条数上限（超出按分数截断） */
const MAX_JOBS_IN_RESULT = 40;
/** 清单 JSON 读取上限，防止误指向超大文件 */
const MAX_MANIFEST_BYTES = 20_000_000;

/** 独立的熔断器与并发控制：CLI 进程很重，不能与其它依赖共享状态 */
const jobBreaker = new CircuitBreaker("job-hunter", 3, 60_000);

/** 支持的平台 id（与技能 CLI 的 --platforms 取值一致） */
export const JOB_PLATFORMS = ["boss", "zhilian", "job51", "liepin"] as const;
export type JobPlatform = (typeof JOB_PLATFORMS)[number];

/** 平台显示名 */
export const JOB_PLATFORM_LABELS: Record<JobPlatform, string> = {
  boss: "BOSS直聘",
  zhilian: "智联招聘",
  job51: "前程无忧",
  liepin: "猎聘",
};

/** 技能文档里明确支持的城市（其它城市需先补 CITY_* 编码） */
export const JOB_SUPPORTED_CITIES = ["青岛", "济南", "北京", "上海", "深圳", "杭州", "成都"] as const;

// ---------------------------------------------------------------------------
// 配置（.web-config.json 的 job 键）
// ---------------------------------------------------------------------------
interface JobSaved {
  /** job-hunter 技能根目录；空 = 尝试用户目录下的默认位置 */
  skillDir?: string;
  /** python 解释器；空 = 用 PATH 上的 python */
  pythonBin?: string;
  /** 数据目录（登录态 + 产出）；空 = <skillDir>/job-data */
  dataDir?: string;
  /** 上次采集用的默认城市（纯便利，不参与采集决策） */
  lastCity?: string;
}

let saved: JobSaved = {};
let loaded = false;

/** job-hunter 技能的默认安装位置（zcode agents 技能目录） */
function defaultSkillCandidates(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home
    ? [
      join(home, ".agents", "skills", "job-hunter"),
      join(home, ".zcode", "skills", "job-hunter"),
    ]
    : [];
}

export async function loadJob(): Promise<void> {
  const cfg = await readConfig();
  const j = (cfg.job ?? {}) as Partial<JobSaved>;
  saved = {
    skillDir: typeof j.skillDir === "string" && j.skillDir.trim() ? j.skillDir.trim() : "",
    pythonBin: typeof j.pythonBin === "string" && j.pythonBin.trim() ? j.pythonBin.trim() : "",
    dataDir: typeof j.dataDir === "string" && j.dataDir.trim() ? j.dataDir.trim() : "",
    lastCity: typeof j.lastCity === "string" ? j.lastCity : "",
  };
  loaded = true;
}

const ensureLoaded = (): Promise<void> => (loaded ? Promise.resolve() : loadJob());

async function persistJob(): Promise<void> {
  await mergeConfig({ job: saved });
}

// ---------------------------------------------------------------------------
// 探测：技能目录 / python / 依赖
// ---------------------------------------------------------------------------
export interface JobStatus {
  /** 技能目录是否找到（脚本存在） */
  installed: boolean;
  /** 实际使用的技能目录 */
  skillDir: string;
  /** 是否来自配置覆盖 */
  hasOverride: boolean;
  /** python 是否可用，以及版本 */
  pythonOK: boolean;
  pythonVersion: string;
  /** DrissionPage + openpyxl 是否都能 import */
  depsOK: boolean;
  depsError: string;
  /** 数据目录（登录态与产出） */
  dataDir: string;
  /** 最近一次清单的条数与时间（没有产出时为空） */
  lastRunJobs: number;
  lastRunAt: string;
  /** 已有登录态的平台（按 .profile 目录存在推断，仅作提示） */
  profilePresent: boolean;
  platform: string;
}

/** 解析实际要用的技能目录：配置优先，其次默认候选位置。 */
async function resolveSkillDir(): Promise<string | null> {
  const candidates = [
    ...(saved.skillDir ? [saved.skillDir] : []),
    ...defaultSkillCandidates(),
  ];
  for (const dir of candidates) {
    const marker = join(dir, "scripts", "main.py");
    try {
      await fsp.access(marker);
      return dir;
    } catch { /* 继续试下一个 */ }
  }
  return null;
}

function resolvePythonBin(): string {
  return saved.pythonBin || (process.platform === "win32" ? "python" : "python3");
}

function resolveDataDir(skillDir: string): string {
  if (saved.dataDir) return isAbsolute(saved.dataDir) ? saved.dataDir : join(skillDir, saved.dataDir);
  return join(skillDir, "job-data");
}

/** 跑一段 python -c，返回 stdout（用于版本与依赖探测）。 */
async function runPython(code: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await runControlled(resolvePythonBin(), {
    args: ["-c", code],
    timeoutMs,
    env: { ...process.env },
    stdoutMaxBytes: MAX_OUTPUT_BYTES,
  });
  return { ok: r.code === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/**
 * 依赖探测：DrissionPage 与 openpyxl 都必须能 import。
 *
 * 技能文档强调 Python 必须 3.10+（签名里用了 `X | None`，3.9 运行时求值会炸），
 * 所以这里把版本也一起报出来，避免「依赖装好了但版本不够」的静默失败。
 */
const DEPS_PROBE = [
  "import sys",
  "mods = []",
  "for name in ('DrissionPage', 'openpyxl'):",
  "    try:",
  "        __import__(name); mods.append(name + ':ok')",
  "    except Exception as exc: mods.append(name + ':fail:' + type(exc).__name__)",
  "print('|'.join([sys.version.split()[0]] + mods))",
].join("\n");

export interface JobDepsProbe {
  pythonOK: boolean;
  pythonVersion: string;
  depsOK: boolean;
  depsError: string;
}

/** 探测 python 与依赖；任何异常都转成可读状态而不是抛出。 */
export async function probeJobDeps(): Promise<JobDepsProbe> {
  const result = await runPython(DEPS_PROBE).catch(() => ({ ok: false, stdout: "", stderr: "无法执行 python" }));
  if (!result.ok) {
    return {
      pythonOK: false,
      pythonVersion: "",
      depsOK: false,
      depsError: result.stderr || "无法执行 python：请确认已安装 Python 3.10+ 并在 PATH 中",
    };
  }
  const parts = result.stdout.split("|");
  const version = parts[0] ?? "";
  const missing = parts.slice(1).filter((item) => item.includes(":fail:"));
  const major = Number(version.split(".")[0]);
  const minor = Number(version.split(".")[1]);
  const versionOK = major > 3 || (major === 3 && minor >= 10);
  return {
    pythonOK: true,
    pythonVersion: version,
    depsOK: missing.length === 0 && versionOK,
    depsError: missing.length
      ? `缺少依赖：${missing.map((item) => item.split(":")[0]).join("、")}。请执行 pip install -r requirements.txt`
      : versionOK ? "" : `Python 版本过低（${version}），需要 3.10+`,
  };
}

/** 当前状态（路由 /api/job 与设置页卡片用）。 */
export async function getJobPublic(): Promise<JobStatus> {
  await ensureLoaded();
  const skillDir = await resolveSkillDir();
  const probe = await probeJobDeps();
  const dataDir = skillDir ? resolveDataDir(skillDir) : "";
  const manifest = skillDir ? await readManifest(skillDir).catch(() => null) : null;
  const profilePresent = dataDir ? await pathExists(join(dataDir, ".profile")) : false;
  return {
    installed: Boolean(skillDir),
    skillDir: skillDir ?? "",
    hasOverride: Boolean(saved.skillDir),
    pythonOK: probe.pythonOK,
    pythonVersion: probe.pythonVersion,
    depsOK: probe.depsOK,
    depsError: probe.depsError,
    dataDir,
    lastRunJobs: manifest?.jobs.length ?? 0,
    lastRunAt: manifest?.fetchedAt ?? "",
    profilePresent,
    platform: process.platform,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

/** 保存配置（设置页「管理数据源」用）。 */
export async function saveJobConfig(input: {
  skillDir?: unknown;
  pythonBin?: unknown;
  dataDir?: unknown;
}): Promise<JobStatus> {
  await ensureLoaded();
  const next: JobSaved = { ...saved };
  if (input.skillDir !== undefined) {
    if (typeof input.skillDir !== "string") throw new Error("技能目录必须是字符串");
    const trimmed = input.skillDir.trim();
    if (trimmed) {
      const marker = join(trimmed, "scripts", "main.py");
      if (!await pathExists(marker)) {
        throw new Error(`「${trimmed}」下没有 scripts/main.py，请填 job-hunter 技能根目录`);
      }
    }
    next.skillDir = trimmed;
  }
  if (input.pythonBin !== undefined) {
    if (typeof input.pythonBin !== "string") throw new Error("Python 解释器必须是字符串");
    next.pythonBin = input.pythonBin.trim();
  }
  if (input.dataDir !== undefined) {
    if (typeof input.dataDir !== "string") throw new Error("数据目录必须是字符串");
    next.dataDir = input.dataDir.trim();
  }
  saved = next;
  await persistJob();
  writeAudit("job.updated", { skillDir: saved.skillDir, hasPythonOverride: Boolean(saved.pythonBin) });
  return getJobPublic();
}

// ---------------------------------------------------------------------------
// 执行 CLI
// ---------------------------------------------------------------------------
interface CliRunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 在技能根目录执行 `python -m scripts.main <args>`。
 * 必须 cwd = 技能根目录，否则 `scripts` 包解析不到。
 */
async function runJobCli(args: string[], timeoutMs: number): Promise<CliRunResult> {
  await ensureLoaded();
  const skillDir = await resolveSkillDir();
  if (!skillDir) {
    throw new Error("未找到 job-hunter 技能：请在「设置 → 插件 → 求职岗位」填写技能根目录");
  }
  const dataDir = resolveDataDir(skillDir);
  await fsp.mkdir(dataDir, { recursive: true });
  const r = await runControlled(resolvePythonBin(), {
    args: ["-m", "scripts.main", ...args],
    cwd: skillDir,
    timeoutMs,
    env: {
      ...process.env,
      // 数据目录必须显式给：否则登录态写进技能目录，升级技能就丢
      JOBHUNT_HOME: dataDir,
    },
    stdoutMaxBytes: MAX_OUTPUT_BYTES,
  });
  return {
    ok: r.code === 0,
    code: r.code,
    stdout: r.stdout,
    stderr: r.killedBy
      ? `${r.stderr}\n（执行超过 ${Math.round(timeoutMs / 1000)} 秒被终止）`.trim()
      : r.stderr,
  };
}

// ---------------------------------------------------------------------------
// 清单读取：out/最新岗位清单.json
// ---------------------------------------------------------------------------
export interface JobRecord {
  platform: string;
  title: string;
  company: string;
  salary: string;
  salaryNum: number;
  city: string;
  experience: string;
  education: string;
  score: number;
  scoreDetail: string;
  isOutsourcing: string;
  outsourcingReason: string;
  published: string;
  hrActive: string;
  companySize: string;
  companyIntro: string;
  companyIndustry: string;
  companyFinancing: string;
  workRest: string;
  workHours: string;
  welfare: string;
  address: string;
  status: string;
  applyUrl: string;
  direction: string;
  remark: string;
  fetchedAt: string;
}

export interface JobManifest {
  jobs: JobRecord[];
  fetchedAt: string;
  path: string;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function asNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/** 把 Python dataclass 的 __dict__ 投影成稳定形状（字段名转 camelCase）。 */
function toJobRecord(raw: Record<string, unknown>): JobRecord {
  return {
    platform: asText(raw.platform),
    title: asText(raw.title),
    company: asText(raw.company),
    salary: asText(raw.salary),
    salaryNum: asNumber(raw.salary_num),
    city: asText(raw.city),
    experience: asText(raw.experience),
    education: asText(raw.education),
    score: asNumber(raw.score),
    scoreDetail: asText(raw.score_detail),
    isOutsourcing: asText(raw.is_outsourcing),
    outsourcingReason: asText(raw.outsourcing_reason),
    published: asText(raw.published),
    hrActive: asText(raw.hr_active),
    companySize: asText(raw.company_size),
    companyIntro: asText(raw.company_intro),
    companyIndustry: asText(raw.company_industry),
    companyFinancing: asText(raw.company_financing),
    workRest: asText(raw.work_rest),
    workHours: asText(raw.work_hours),
    welfare: asText(raw.welfare),
    address: asText(raw.address),
    status: asText(raw.status) || "待投递",
    applyUrl: asText(raw.apply_url),
    direction: asText(raw.direction),
    remark: asText(raw.remark),
    fetchedAt: asText(raw.fetched_at),
  };
}

/**
 * 读取技能产出的最新清单。
 *
 * 为什么读 JSON 而不是解析 Excel：技能同时产出 `最新岗位清单.json`，
 * 它是下一次增量合并的基准（含投递状态），字段比 Excel 更全（含 JD 全文）。
 * Excel 只作为给用户的交付物，不进入模型上下文。
 */
export async function readManifest(skillDirHint?: string): Promise<JobManifest | null> {
  const skillDir = skillDirHint ?? await resolveSkillDir();
  if (!skillDir) return null;
  const path = join(resolveDataDir(skillDir), "out", "最新岗位清单.json");
  let stat;
  try {
    stat = await fsp.stat(path);
  } catch {
    return null;
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`岗位清单过大（${Math.round(stat.size / 1024 / 1024)} MB），请清理 out 目录后重试`);
  }
  const text = await fsp.readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("岗位清单 JSON 解析失败，可能上次采集被中断写坏了；重新采集即可覆盖");
  }
  if (!Array.isArray(parsed)) return null;
  const jobs = parsed
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map(toJobRecord);
  return { jobs, fetchedAt: jobs[0]?.fetchedAt ?? "", path };
}

// ---------------------------------------------------------------------------
// 采集 / 补详情
// ---------------------------------------------------------------------------
export interface CollectInput {
  keywords: string[];
  city: string;
  salaryMin?: number;
  salaryMax?: number;
  years?: number;
  pages?: number;
  platforms?: JobPlatform[];
}

export interface CliOutcome {
  ok: boolean;
  /** 面向模型的简短结论（成功时含条数，失败时含可操作原因） */
  summary: string;
  /** CLI 原始输出尾部（供排障，已截断） */
  output?: string;
  /** 采集完成后的清单（仅成功时） */
  manifest?: JobManifest;
  /** 已生成的 HTML 报告路径；生成失败时省略 */
  htmlPath?: string;
  /** HTML 报告生成失败原因；Excel 采集成功时不把整个结果判成失败 */
  htmlError?: string;
}

/** 把 CLI 输出尾部压成一段可读文本（排障用，不含敏感信息）。 */
function tailOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
  if (!combined) return "";
  const clipped = combined.length > 1_500 ? `…\n${combined.slice(-1_500)}` : combined;
  return clipped;
}

/**
 * 采集岗位。这是重操作（3-5 分钟），只应在用户明确要求并确认过意图后调用。
 * 失败不抛错：返回可读的 `summary`，让模型转述并建议下一步。
 */
export async function collectJobs(input: CollectInput): Promise<CliOutcome> {
  const keywords = input.keywords.map((item) => item.trim()).filter(Boolean);
  if (!keywords.length) return { ok: false, summary: "缺少岗位关键词：请先向用户确认目标岗位方向" };
  if (!input.city?.trim()) return { ok: false, summary: "缺少城市：请先向用户确认目标城市" };

  const args = [
    "collect",
    "--keywords", keywords.join(","),
    "--city", input.city.trim(),
  ];
  if (typeof input.salaryMin === "number" && typeof input.salaryMax === "number") {
    args.push("--salary", String(input.salaryMin), String(input.salaryMax));
  }
  if (typeof input.years === "number") args.push("--years", String(input.years));
  if (typeof input.pages === "number" && input.pages > 0) args.push("--pages", String(Math.min(10, Math.round(input.pages))));
  if (input.platforms?.length) args.push("--platforms", input.platforms.join(","));
  // 采集与补详情分开跑：混在一起大概率被风控（技能文档明确要求）
  args.push("--enrich", "0");

  let result: CliRunResult;
  try {
    result = await jobBreaker.run(() => runJobCli(args, COLLECT_TIMEOUT_MS));
  } catch (err) {
    recordDependency("job", "down", "岗位采集失败");
    return {
      ok: false,
      summary: `采集失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!result.ok) {
    recordDependency("job", "down", "岗位采集失败");
    log("warn", "job_collect_failed", { code: result.code });
    return {
      ok: false,
      summary: collectFailureHint(result),
      output: tailOutput(result.stdout, result.stderr),
    };
  }
  recordDependency("job", "ok", "岗位采集正常");
  const manifest = await readManifest().catch(() => null);
  // CLI 成功退出意味着 Excel 与清单 JSON 已写完；这里再生成同名 HTML 交付物。
  // 报告失败不让耗时数分钟的采集变成失败，但要告诉用户 Excel 可用、HTML 需重试。
  const html: { path?: string; error?: string } | null = manifest
    ? await writeJobHtmlReport(manifest).then(
      (path) => ({ path }),
      (err) => ({ error: err instanceof Error ? err.message : String(err) }),
    )
    : null;
  const count = manifest?.jobs.length ?? 0;
  const htmlSuffix = html?.path ? "HTML 报告已生成。" : html?.error ? `HTML 报告生成失败：${html.error}` : "";
  return {
    ok: true,
    summary: count
      ? `采集完成，清单共 ${count} 条岗位（已按分数排序）。${htmlSuffix}`
      : "采集命令执行完成，但清单里没有岗位：通常是未登录或被风控，请先在设置页登录对应平台。",
    output: tailOutput(result.stdout, result.stderr),
    ...(manifest ? { manifest } : {}),
    ...(html?.path ? { htmlPath: html.path } : {}),
    ...(html?.error ? { htmlError: html.error } : {}),
  };
}

/** 把 CLI 失败翻译成「用户能照着做」的下一步。 */
function collectFailureHint(result: CliRunResult): string {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (text.includes("modulenotfounderror") || text.includes("no module named")) {
    return "采集失败：缺少 Python 依赖（DrissionPage / openpyxl）。请在技能根目录执行 pip install -r requirements.txt 后重试。";
  }
  if (text.includes("没有采集到任何岗位") || text.includes("登录")) {
    return "采集失败：可能未登录或触发风控。请在「设置 → 插件 → 求职岗位」点「登录 BOSS直聘」扫码后再试。";
  }
  if (result.code !== 0 && !result.stderr.trim()) {
    return "采集失败：技能 CLI 异常退出但没有输出。请到设置页点「自检」看环境是否就绪。";
  }
  return `采集失败（退出码 ${result.code}）：${tailOutput(result.stdout, result.stderr).slice(-400)}`;
}

/** 补详情（JD 全文、地址、HR 活跃等）。建议与采集间隔几分钟。 */
export async function enrichJobs(limit = 10): Promise<CliOutcome> {
  const safeLimit = Math.max(1, Math.min(50, Math.round(limit)));
  let result: CliRunResult;
  try {
    result = await jobBreaker.run(() => runJobCli(["enrich", "--limit", String(safeLimit)], ENRICH_TIMEOUT_MS));
  } catch (err) {
    recordDependency("job", "down", "岗位补详情失败");
    return { ok: false, summary: `补详情失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!result.ok) {
    recordDependency("job", "down", "岗位补详情失败");
    return {
      ok: false,
      summary: `补详情失败（退出码 ${result.code}）：${tailOutput(result.stdout, result.stderr).slice(-400)}`,
      output: tailOutput(result.stdout, result.stderr),
    };
  }
  recordDependency("job", "ok", "岗位补详情正常");
  const manifest = await readManifest().catch(() => null);
  // 补详情会改写清单字段；同步刷新报告，避免用户拿到旧 HTML。
  const htmlPath = manifest ? await writeJobHtmlReport(manifest).catch(() => undefined) : undefined;
  return {
    ok: true,
    summary: `补详情完成（本次最多处理 ${safeLimit} 条）。注意：上下班时间等字段多数 JD 本就没有，留空是正常的。` +
      (htmlPath ? "HTML 报告已同步刷新。" : ""),
    output: tailOutput(result.stdout, result.stderr),
    ...(manifest ? { manifest } : {}),
    ...(htmlPath ? { htmlPath } : {}),
  };
}

/** 准备登录（在设置页点按钮时调用；返回提示文本，不阻塞等待扫码）。 */
export async function startLogin(platform: JobPlatform): Promise<CliOutcome> {
  // login 会阻塞等待扫码（最长 5 分钟），这里给足超时；设置页会同步等待。
  const result = await runJobCli(["login", platform], 330_000).catch((err) => ({
    ok: false,
    code: -1,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
  }));
  return {
    ok: result.ok,
    summary: result.ok
      ? `${JOB_PLATFORM_LABELS[platform]} 登录流程结束。请在浏览器里完成扫码；成功后登录态会保存到数据目录。`
      : `${JOB_PLATFORM_LABELS[platform]} 登录未完成：${tailOutput(result.stdout, result.stderr).slice(-300)}`,
    output: tailOutput(result.stdout, result.stderr),
  };
}

/** 环境自检（设置页「自检」按钮；对应技能 CLI 的 doctor 子命令）。 */
export async function doctorJob(): Promise<{ ok: boolean; text: string }> {
  const result = await runJobCli(["doctor"], 60_000).catch((err) => ({
    ok: false,
    code: -1,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
  }));
  return { ok: result.ok, text: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
}

// ---------------------------------------------------------------------------
// 工具层用的查询接口
// ---------------------------------------------------------------------------
export interface JobQuery {
  /** 关键词（岗位名/公司名/方向，模糊匹配） */
  keyword?: string;
  city?: string;
  /** 只看非外包 */
  excludeOutsourcing?: boolean;
  /** 最低分 */
  minScore?: number;
  /** 投递状态过滤 */
  status?: string;
  /** 平台过滤 */
  platform?: string;
  limit?: number;
}

/**
 * 按条件筛选清单。这是纯本地查询：不触发 CLI、不耗配额。
 * 排序沿用技能的打分（越高越匹配）。
 */
export async function queryJobs(query: JobQuery): Promise<{ jobs: JobRecord[]; total: number; manifestPath: string }> {
  const manifest = await readManifest();
  if (!manifest) {
    throw new Error("还没有岗位清单：请先让 Agent 采集一次岗位（需要先确认岗位方向、城市、薪资与年限）");
  }
  const keyword = query.keyword?.trim().toLowerCase() ?? "";
  const city = query.city?.trim().toLowerCase() ?? "";
  const status = query.status?.trim() ?? "";
  const platform = query.platform?.trim().toLowerCase() ?? "";
  const minScore = typeof query.minScore === "number" ? query.minScore : 0;
  const limit = Math.max(1, Math.min(MAX_JOBS_IN_RESULT, Math.round(query.limit ?? 20)));

  const filtered = manifest.jobs.filter((job) => {
    if (city && !job.city.toLowerCase().includes(city)) return false;
    if (platform && !job.platform.toLowerCase().includes(platform)) return false;
    if (status && job.status !== status) return false;
    if (minScore > 0 && job.score < minScore) return false;
    if (query.excludeOutsourcing && job.isOutsourcing === "是") return false;
    if (keyword) {
      const haystack = `${job.title} ${job.company} ${job.direction} ${job.companyIndustry}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => b.score - a.score);
  return { jobs: filtered.slice(0, limit), total: filtered.length, manifestPath: manifest.path };
}

export { MAX_RESULT_CHARS, MAX_JOBS_IN_RESULT };
