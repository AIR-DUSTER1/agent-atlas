/**
 * job-health.ts — 招聘采集结构健康分级
 * ============================================================
 * 把“采不到”拆成被风控、卡片/关键字段失效、低质量降级与正常四档；
 * 判定只接收解析后的 JobRecord，避免诊断逻辑与站点适配互相耦合。
 */
import type { JobPlatform, JobRecord } from "./job-model.js";

export type JobHealthVerdict = "OK" | "DEGRADED" | "BROKEN" | "BLOCKED";

export interface JobFieldHealth {
  name: string;
  hit: number;
  total: number;
  rate: number;
}

export interface JobPlatformHealthReport {
  platform: JobPlatform;
  verdict: JobHealthVerdict;
  cardCount: number;
  jobs: number;
  fields: JobFieldHealth[];
  fallbacks: Array<{ platform: JobPlatform; key: string; primary: string; used: string; count: number }>;
  candidates: Array<Record<string, unknown>>;
  snapshots: Record<string, string>;
  notes: string[];
}

const RANK: Record<JobHealthVerdict, number> = { OK: 0, DEGRADED: 1, BROKEN: 2, BLOCKED: 3 };

export function worseJobVerdict(left: JobHealthVerdict, right: JobHealthVerdict): JobHealthVerdict {
  return RANK[left] >= RANK[right] ? left : right;
}

function rateVerdict(rate: number, critical: boolean): JobHealthVerdict {
  if (critical) return rate < 0.6 ? "BROKEN" : rate < 0.9 ? "DEGRADED" : "OK";
  return rate < 0.4 ? "BROKEN" : rate < 0.7 ? "DEGRADED" : "OK";
}

function addField(fields: JobFieldHealth[], name: string, hit: number, total: number): JobFieldHealth {
  const field = { name, hit, total, rate: total ? Math.round((hit / total) * 1000) / 1000 : 0 };
  fields.push(field);
  return field;
}

/** 列表页健康检查：标题/链接是关键字段，薪资/公司是次关键字段。 */
export function checkJobListHealth(
  platform: JobPlatform,
  jobs: readonly JobRecord[],
  cardCount: number,
  options: { linkless?: boolean } = {},
): JobPlatformHealthReport {
  const report: JobPlatformHealthReport = {
    platform,
    verdict: "OK",
    cardCount,
    jobs: jobs.length,
    fields: [],
    fallbacks: [],
    candidates: [],
    snapshots: {},
    notes: [],
  };
  if (!cardCount && !jobs.length) {
    report.verdict = "BROKEN";
    report.notes.push("卡片容器命中 0 个元素，且没有从接口/Vue 数据拿到岗位");
    return report;
  }
  if (!jobs.length) {
    report.verdict = "BROKEN";
    report.notes.push("卡片存在但一条岗位都没解析出来，卡片内部字段选择器可能已失效");
    return report;
  }
  const total = jobs.length;
  const title = jobs.filter((job) => Boolean(job.title.trim())).length;
  const link = jobs.filter((job) => Boolean(job.applyUrl.trim())).length;
  const salary = jobs.filter((job) => Boolean(job.salary.trim())).length;
  const company = jobs.filter((job) => Boolean(job.company.trim())).length;
  const experience = jobs.filter((job) => Boolean(job.experience.trim())).length;
  const education = jobs.filter((job) => Boolean(job.education.trim())).length;
  addField(report.fields, "title", title, total);
  addField(report.fields, "apply_url", link, total);
  addField(report.fields, "salary", salary, total);
  addField(report.fields, "company", company, total);
  addField(report.fields, "experience", experience, total);
  addField(report.fields, "education", education, total);
  report.verdict = worseJobVerdict(report.verdict, rateVerdict(title / total, true));
  if (!options.linkless) report.verdict = worseJobVerdict(report.verdict, rateVerdict(link / total, true));
  report.verdict = worseJobVerdict(report.verdict, rateVerdict(salary / total, false));
  report.verdict = worseJobVerdict(report.verdict, rateVerdict(company / total, false));
  if (!cardCount) {
    report.verdict = worseJobVerdict(report.verdict, "DEGRADED");
    report.notes.push(`卡片容器命中 0 个元素，但拿到了 ${jobs.length} 条接口/Vue 数据；点击详情与登录判定已降级`);
  }
  if (Math.max(cardCount, jobs.length) < 3) {
    report.verdict = worseJobVerdict(report.verdict, "DEGRADED");
    report.notes.push(`只拿到 ${Math.max(cardCount, jobs.length)} 条，容器可能只匹配到部分元素`);
  }
  if (report.verdict !== "OK") {
    for (const field of report.fields) if (field.total && !field.hit) report.notes.push(`字段「${field.name}」全部为空`);
  }
  return report;
}

/** 详情页健康检查：JD 是硬要求，其余字段只报告填充率。 */
export function checkJobDetailHealth(
  platform: JobPlatform,
  jobs: readonly JobRecord[],
  unsupported: ReadonlySet<string> = new Set(),
): JobPlatformHealthReport {
  const report: JobPlatformHealthReport = {
    platform,
    verdict: jobs.length ? "OK" : "DEGRADED",
    cardCount: jobs.length,
    jobs: jobs.length,
    fields: [],
    fallbacks: [],
    candidates: [],
    snapshots: {},
    notes: jobs.length ? [] : ["没有可检查的详情样本"],
  };
  if (!jobs.length) return report;
  const checks: Array<[string, (job: JobRecord) => boolean]> = [
    ["jd", (job) => Boolean(job.jdText.trim())],
    ["address", (job) => Boolean(job.address.trim())],
    ["company_intro", (job) => Boolean(job.companyIntro.trim())],
    ["hr_active", (job) => Boolean(job.hrActive.trim())],
    ["work_rest", (job) => Boolean(job.workRest.trim())],
    ["company_size", (job) => Boolean(job.companySize.trim())],
    ["published", (job) => Boolean(job.published.trim())],
  ];
  for (const [name, check] of checks) {
    if (unsupported.has(name)) {
      report.notes.push(`字段「${name}」平台不提供，跳过`);
      continue;
    }
    const hit = jobs.filter(check).length;
    addField(report.fields, name, hit, jobs.length);
    if (name === "jd") report.verdict = worseJobVerdict(report.verdict, rateVerdict(hit / jobs.length, true));
  }
  if (!report.fields.find((field) => field.name === "jd")?.hit) report.notes.push("JD 全部为空，详情容器可能已变更");
  return report;
}

export const JOB_VERDICT_LABEL: Record<JobHealthVerdict, string> = {
  OK: "正常",
  DEGRADED: "降级",
  BROKEN: "结构变更",
  BLOCKED: "被风控",
};
