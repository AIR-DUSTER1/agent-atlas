/**
 * job-model.ts — 求职 Agent 的内部领域模型与规则
 * ============================================================
 * 把原技能中的岗位字段、评分、外包识别和增量合并规则收进应用运行时；
 * 招聘站点适配、浏览器生命周期和交付物写入各自独立，模型只看到结构化工具结果。
 */

export const JOB_PLATFORMS = ["boss", "zhilian", "job51", "liepin"] as const;
export type JobPlatform = (typeof JOB_PLATFORMS)[number];

export const JOB_PLATFORM_LABELS: Record<JobPlatform, string> = {
  boss: "BOSS直聘",
  zhilian: "智联招聘",
  job51: "前程无忧",
  liepin: "猎聘",
};

export const JOB_SUPPORTED_CITIES = ["青岛", "济南", "北京", "上海", "深圳", "杭州", "成都"] as const;
export type JobSupportedCity = (typeof JOB_SUPPORTED_CITIES)[number];

export const JOB_STATUS_OPTIONS = ["待投递", "已投递", "已面试", "已结束"] as const;
export type JobStatusValue = (typeof JOB_STATUS_OPTIONS)[number];

/** 平台搜索编码；缺失值的城市在工具层拒绝，不进入浏览器。 */
export const JOB_CITY_CODES = {
  boss: { 青岛: "101120200", 济南: "101120100", 北京: "101010100", 上海: "101020100", 深圳: "101280600", 杭州: "101210100", 成都: "101270100" },
  zhilian: { 青岛: "703", 济南: "702", 北京: "530", 上海: "538", 深圳: "765", 杭州: "653", 成都: "801" },
  job51: { 青岛: "120300", 济南: "120200", 北京: "010000", 上海: "020000", 深圳: "040000", 杭州: "080200", 成都: "090200" },
  liepin: { 青岛: "250070", 济南: "250020", 北京: "010", 上海: "020", 深圳: "050090", 杭州: "070020", 成都: "280020" },
} as const satisfies Record<JobPlatform, Record<JobSupportedCity, string>>;

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
  isOutsourcing: "是" | "否" | "待确认";
  outsourcingReason: string;
  published: string;
  hrActive: string;
  hrName: string;
  companySize: string;
  companyIntro: string;
  companyIndustry: string;
  companyFinancing: string;
  workRest: string;
  workHours: string;
  welfare: string;
  address: string;
  status: JobStatusValue;
  applyUrl: string;
  jdText: string;
  direction: string;
  remark: string;
  fetchedAt: string;
  companyUrl: string;
}

export interface JobManifest {
  jobs: JobRecord[];
  fetchedAt: string;
  path: string;
}

export interface JobSearchProfile {
  keywords: string[];
  city: JobSupportedCity;
  salaryMin: number;
  salaryMax: number;
  years: number;
}

export interface PlatformCollectionResult {
  jobs: JobRecord[];
  warnings: string[];
}

export interface JobQuery {
  keyword?: string;
  city?: string;
  excludeOutsourcing?: boolean;
  minScore?: number;
  status?: string;
  platform?: string;
}

export const MAX_JOBS_IN_RESULT = 40;
export const JOB_MAX_KEYWORDS = 6;
export const JOB_MAX_PAGES = 3;

const OUTSOURCING_COMPANY = /(人力资源|劳务|派遣|外包|驻场|人才服务|科锐|中软国际|软通动力|文思海辉|博彦|法本|佰钧成|中电金信)/i;
const OUTSOURCING_TEXT = /(人力外包|劳务派遣|驻场开发|驻场|外派|客户现场|按人天|人员外包|项目外包)/i;
const OUTSOURCING_SOFT = /(短期项目|项目制|客户项目|驻点)/i;

/** BOSS 页面会把薪资数字替换成私有区字符，统一还原成普通数字。 */
export function decodeObfuscatedDigits(value: string): string {
  return [...value].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xe031 && code <= 0xe039) return String(code - 0xe031);
    return char;
  }).join("");
}

/** 提取月薪中位数（K）。支持 K、万、元/月、元/天和面议。 */
export function parseSalaryK(value: string): number {
  const text = decodeObfuscatedDigits(value).replace(/\s+/g, "");
  if (!text || /面议/.test(text)) return 0;
  const mixed = text.match(/(\d+(?:\.\d+)?)(K|k|千|万)\s*[-~至]\s*(\d+(?:\.\d+)?)(K|k|千|万)/);
  if (mixed) {
    const low = normalizeSalary(Number(mixed[1]), mixed[2]!);
    const high = normalizeSalary(Number(mixed[3]), mixed[4]!);
    return Math.round(((low + high) / 2) * 10) / 10;
  }
  const range = text.match(/(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*(K|k|千|万|元\/月|元\/天)/);
  if (!range) {
    const single = text.match(/(\d+(?:\.\d+)?)\s*(K|k|千|万|元\/月|元\/天)/);
    if (!single) return 0;
    return normalizeSalary(Number(single[1]), single[2]!);
  }
  const low = normalizeSalary(Number(range[1]), range[3]!);
  const high = normalizeSalary(Number(range[2]), range[3]!);
  return Math.round(((low + high) / 2) * 10) / 10;
}

function normalizeSalary(value: number, unit: string): number {
  if (!Number.isFinite(value)) return 0;
  if (unit === "万") return value * 10;
  if (unit === "元/天") return value * 22 / 1_000;
  if (unit === "元/月") return value / 1_000;
  return value;
}

function parseExperienceRange(text: string, years: number): [number, number] | null {
  const value = text.replace(/\s+/g, "");
  if (!value || /经验不限|不限/.test(value)) return [0, 99];
  if (/应届|在校/.test(value)) return [0, 1];
  const range = value.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)年/);
  if (range) return [Number(range[1]), Number(range[2])];
  const above = value.match(/(\d+(?:\.\d+)?)年以上/);
  if (above) return [Number(above[1]), 99];
  const below = value.match(/(\d+(?:\.\d+)?)年以内/);
  if (below) return [0, Number(below[1])];
  return years >= 0 ? null : null;
}

/** 常见岗位方向的同义词组；内置流程不依赖模型临时扩词。 */
const KEYWORD_SYNONYMS: Record<string, string[]> = {
  agent开发: ["agent", "智能体", "ai应用", "ai开发", "大模型应用", "llm应用"],
  大模型应用: ["大模型", "llm", "agent", "智能体", "ai应用"],
  大模型开发: ["大模型", "llm", "agent", "智能体", "ai开发"],
  前端开发: ["前端", "web", "react", "vue", "javascript"],
  后端开发: ["后端", "java", "python", "go", "node"],
  数据分析: ["数据分析", "bi", "sql", "数据仓库", "数据开发"],
};

export function keywordVariants(keyword: string): string[] {
  const normalized = keyword.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized) return [];
  const direct = KEYWORD_SYNONYMS[normalized] ?? [];
  return [...new Set([normalized, ...direct.map((item) => item.replace(/\s+/g, ""))])];
}

function scoreTitle(title: string, keywords: string[]): number {
  const target = title.toLowerCase().replace(/\s+/g, "");
  let best = 0;
  for (const keyword of keywords) {
    for (const token of keywordVariants(keyword)) {
      if (!token) continue;
      const index = target.indexOf(token);
      if (index >= 0) best = Math.max(best, index < 12 ? 35 : 30);
      const parts = token.split(/[\s/、,，]+/).filter((part) => part.length > 1);
      if (!parts.length) continue;
      const hits = parts.filter((part) => target.includes(part)).length;
      if (hits) best = Math.max(best, 35 * hits / parts.length * 0.8);
    }
  }
  return best;
}

function scoreSalary(salaryK: number, low: number, high: number): number {
  if (!salaryK) return 12;
  if (salaryK < low) return Math.max(0, 25 * (1 - ((low - salaryK) / Math.max(low, 1)) * 2));
  if (salaryK > high) return Math.max(0, 25 * (1 - ((salaryK - high) / Math.max(high, 1)) * 0.5));
  const mid = (low + high) / 2;
  const pos = 1 - Math.abs(salaryK - mid) / Math.max(mid - low, 1);
  return 18 + 7 * Math.max(0, Math.min(1, pos));
}

function scoreExperience(text: string, years: number): number {
  const range = parseExperienceRange(text, years);
  if (!range) return 9;
  const [low, high] = range;
  if (years >= low && years <= high) return 15;
  return years < low
    ? Math.max(0, 15 - (low - years) * 6)
    : Math.max(0, 15 - (years - high) * 4);
}

function scoreCompany(size: string, financing: string, industry: string): number {
  let score = 4;
  if (/100-499|100-999|150-500/.test(size)) score = 7;
  else if (/500-999|500-2000|1000|5000/.test(size)) score = 6;
  else if (/20-99|少于50|1-49/.test(size)) score = 3.5;
  else if (/10000|人以上/.test(size)) score = 5;
  if (/已上市|上市|不需要融资/.test(financing)) score += 5;
  else if (/C轮|D轮|E轮|战略融资/.test(financing)) score += 4;
  else if (/A轮|B轮|天使轮/.test(financing)) score += 2.5;
  else score += 3;
  if (/人工智能|互联网|计算机软件|IT服务|软件/.test(industry)) score += 3;
  else if (!/人力资源|中介/.test(industry)) score += 1.5;
  return Math.min(15, score);
}

function scoreActivity(hrActive: string, published: string): number {
  let score = 2;
  if (/刚刚|在线|今日|1小时|小时前/.test(hrActive)) score = 6;
  else if (/12小时|24小时|昨日|昨天|1天/.test(hrActive)) score = 4.5;
  else if (/2天|3天|本周|天内/.test(hrActive)) score = 3;
  else if (/周|月/.test(hrActive)) score = 1.5;
  if (/刚刚|今天|今日|小时前/.test(published)) score += 4;
  else if (/昨天|1天|天内/.test(published)) score += 3;
  else if (/近一周|本周|7天/.test(published)) score += 2;
  else if (/月|30天/.test(published)) score += 1;
  else score += 1.5;
  return Math.min(10, score);
}

export function detectOutsourcing(company: string, jdText: string, industry: string): Pick<JobRecord, "isOutsourcing" | "outsourcingReason"> {
  const companyHit = company.match(OUTSOURCING_COMPANY)?.[1];
  if (companyHit) return { isOutsourcing: "是", outsourcingReason: `公司名称命中：${companyHit}` };
  const textHit = jdText.match(OUTSOURCING_TEXT)?.[1];
  if (textHit) return { isOutsourcing: "是", outsourcingReason: `岗位描述命中：${textHit}` };
  if (/人力资源|中介/.test(industry)) return { isOutsourcing: "待确认", outsourcingReason: `行业为${industry}` };
  const soft = jdText.match(OUTSOURCING_SOFT)?.[1];
  if (soft) return { isOutsourcing: "待确认", outsourcingReason: `岗位描述出现：${soft}` };
  return { isOutsourcing: "否", outsourcingReason: "" };
}

export function parseWorkRest(text: string): string {
  const value = text.replace(/\s+/g, "");
  if (/双休|周末双休/.test(value)) return "双休";
  if (/大小周/.test(value)) return "大小周";
  if (/单休/.test(value)) return "单休";
  if (/做五休二|上五休二/.test(value)) return "做五休二";
  return "";
}

export function parseWorkHours(text: string): string {
  const match = text.match(/(?:上午|下午|早上|晚上)?\s*(\d{1,2}):(\d{2})\s*[-~至]\s*(?:上午|下午|早上|晚上)?\s*(\d{1,2}):(\d{2})/);
  if (!match) return "";
  let end = Number(match[3]);
  if (/下午|晚上/.test(match[0]) && end < 12) end += 12;
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}-${String(end).padStart(2, "0")}:${match[4]}`;
}

export function createJobRecord(platform: string, partial: Partial<JobRecord>): JobRecord {
  return {
    platform,
    title: "",
    company: "",
    salary: "",
    salaryNum: 0,
    city: "",
    experience: "",
    education: "",
    score: 0,
    scoreDetail: "",
    isOutsourcing: "否",
    outsourcingReason: "",
    published: "",
    hrActive: "",
    hrName: "",
    companySize: "",
    companyIntro: "",
    companyIndustry: "",
    companyFinancing: "",
    workRest: "",
    workHours: "",
    welfare: "",
    address: "",
    status: "待投递",
    applyUrl: "",
    jdText: "",
    direction: "",
    remark: "",
    fetchedAt: "",
    companyUrl: "",
    ...partial,
  };
}

export function scoreJob(job: JobRecord, profile: JobSearchProfile): JobRecord {
  const salaryK = job.salaryNum || parseSalaryK(job.salary);
  const title = scoreTitle(job.title, profile.keywords);
  const salary = scoreSalary(salaryK, profile.salaryMin, profile.salaryMax);
  const experience = scoreExperience(job.experience, profile.years);
  const company = scoreCompany(job.companySize, job.companyFinancing, job.companyIndustry);
  const activity = scoreActivity(job.hrActive, job.published);
  let total = title + salary + experience + company + activity;
  if (job.isOutsourcing === "是") total *= 0.35;
  else if (job.isOutsourcing === "待确认") total *= 0.8;
  let detail = `岗位${title.toFixed(0)}/35 薪资${salary.toFixed(0)}/25 经验${experience.toFixed(0)}/15 公司${company.toFixed(0)}/15 活跃${activity.toFixed(0)}/10`;
  if (job.isOutsourcing === "是") detail += " ×外包折减";
  else if (job.isOutsourcing === "待确认") detail += " ×外包待确认折减";
  return { ...job, salaryNum: salaryK, score: Math.round(Math.min(100, total) * 10) / 10, scoreDetail: detail };
}

/** 兼容旧版 job-hunter JSON 的 snake_case 字段，读取时无损投影成应用内模型。 */
export function normalizeStoredJob(raw: unknown): JobRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const text = (...keys: string[]): string => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "string") return candidate;
      if (typeof candidate === "number") return String(candidate);
    }
    return "";
  };
  const number = (...keys: string[]): number => {
    for (const key of keys) {
      const candidate = Number(value[key]);
      if (Number.isFinite(candidate)) return candidate;
    }
    return 0;
  };
  const title = text("title");
  if (!title) return null;
  const outsourcing = text("isOutsourcing", "is_outsourcing");
  const status = text("status");
  return createJobRecord(text("platform"), {
    title,
    company: text("company"),
    salary: text("salary"),
    salaryNum: number("salaryNum", "salary_num"),
    city: text("city"),
    experience: text("experience"),
    education: text("education"),
    score: number("score"),
    scoreDetail: text("scoreDetail", "score_detail"),
    isOutsourcing: outsourcing === "是" || outsourcing === "待确认" ? outsourcing : "否",
    outsourcingReason: text("outsourcingReason", "outsourcing_reason"),
    published: text("published"),
    hrActive: text("hrActive", "hr_active"),
    hrName: text("hrName", "hr_name"),
    companySize: text("companySize", "company_size"),
    companyIntro: text("companyIntro", "company_intro"),
    companyIndustry: text("companyIndustry", "company_industry"),
    companyFinancing: text("companyFinancing", "company_financing"),
    workRest: text("workRest", "work_rest"),
    workHours: text("workHours", "work_hours"),
    welfare: text("welfare"),
    address: text("address"),
    status: JOB_STATUS_OPTIONS.includes(status as JobStatusValue) ? status as JobStatusValue : "待投递",
    applyUrl: text("applyUrl", "apply_url"),
    jdText: text("jdText", "jd_text"),
    direction: text("direction"),
    remark: text("remark"),
    fetchedAt: text("fetchedAt", "fetched_at"),
    companyUrl: text("companyUrl", "company_url"),
  });
}

export function jobIdentity(job: JobRecord): string {
  return job.applyUrl.trim() || `${job.platform}|${job.title.trim()}|${job.company.trim()}`;
}

export function mergeJobRecords(
  fresh: JobRecord[],
  previous: JobRecord[],
  activePlatforms: ReadonlySet<string>,
): { jobs: JobRecord[]; added: number; updated: number; carried: number } {
  const now = new Date().toISOString();
  const previousByKey = new Map(previous.map((job) => [jobIdentity(job), job]));
  const freshKeys = new Set(fresh.map(jobIdentity));
  let added = 0;
  let updated = 0;
  let carried = 0;
  const jobs = fresh.map((job) => {
    const old = previousByKey.get(jobIdentity(job));
    if (!old) {
      added += 1;
      return { ...job, fetchedAt: now };
    }
    updated += 1;
    return {
      ...job,
      status: old.status || job.status,
      remark: old.remark || job.remark,
      fetchedAt: now,
    };
  });
  for (const old of previous) {
    if (freshKeys.has(jobIdentity(old))) continue;
    const samePlatform = activePlatforms.has(old.platform);
    if (!samePlatform || old.status !== "待投递" || old.remark) {
      jobs.push(old);
      carried += 1;
    }
  }
  return { jobs, added, updated, carried };
}

export function queryJobRecords(jobs: JobRecord[], query: JobQuery, limit: number): JobRecord[] {
  const keyword = query.keyword?.trim().toLowerCase() ?? "";
  return jobs
    .filter((job) => {
      if (keyword && !`${job.title} ${job.company} ${job.direction} ${job.companyIndustry}`.toLowerCase().includes(keyword)) return false;
      if (query.city && !job.city.includes(query.city)) return false;
      if (query.excludeOutsourcing && job.isOutsourcing === "是") return false;
      if (typeof query.minScore === "number" && job.score < query.minScore) return false;
      if (query.status && job.status !== query.status) return false;
      if (query.platform && job.platform !== query.platform) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, limit);
}
