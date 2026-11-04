/**
 * job-diagnose.ts — 招聘站点结构诊断与候选固化
 * ============================================================
 * 在真实列表页区分被风控、结构变更和正常空结果；结构异常时推断候选、
 * 用同一解析器验证，只有用户明确 apply 时才写入本地选择器覆盖层。
 */
import { join } from "node:path";
import type { Page } from "playwright-core";
import { enrichJobInPage, goto, inferNativeCardCandidates, inspectNativeJobPage, jobSearchUrl, JOB_HEADLESS, pageBlockedReason, withPersistentBrowser } from "./job-browser.js";
import { snapshotJobPage } from "./job-dom.js";
import {
  checkJobDetailHealth, checkJobListHealth, worseJobVerdict,
  type JobHealthVerdict, type JobPlatformHealthReport,
} from "./job-health.js";
import type { JobPlatform, JobSearchProfile } from "./job-model.js";
import { applyJobSelector, loadJobSelectorRuntime, type JobSelectorRuntime } from "./job-selectors.js";

const PLATFORM_COOLDOWN_MS = 15_000;

export interface JobDiagnosisOptions {
  detail?: number;
  apply?: boolean;
  simulate?: JobPlatform;
}

export interface JobDiagnosisApplied {
  platform: JobPlatform;
  selector: string;
  path: string;
}

export interface JobDiagnosisResult {
  at: string;
  overall: JobHealthVerdict;
  ok: boolean;
  platforms: JobPlatformHealthReport[];
  applied: JobDiagnosisApplied[];
  simulated: JobPlatform | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactCandidate(candidate: Awaited<ReturnType<typeof inferNativeCardCandidates>>[number]): Record<string, unknown> {
  return {
    selector: candidate.selector,
    cardCount: candidate.cardCount,
    parsed: candidate.parsed,
    titleRate: candidate.titleRate,
    linkRate: candidate.linkRate,
    salaryRate: candidate.salaryRate,
    verified: candidate.verified,
    sample: candidate.sample,
  };
}

async function diagnosePlatform(
  page: Page,
  runtime: JobSelectorRuntime,
  dataDir: string,
  platform: JobPlatform,
  profile: JobSearchProfile,
  options: JobDiagnosisOptions,
  diagnoseDir: string,
): Promise<{ report: JobPlatformHealthReport; applied?: { selector: string; path: string } }> {
  const keyword = profile.keywords[0] ?? "开发";
  const url = jobSearchUrl(platform, profile.city, keyword, 1);
  try {
    await goto(page, url, 3_500);
  } catch (err) {
    const report = checkJobListHealth(platform, [], 0, { linkless: platform === "zhilian" });
    report.verdict = "BROKEN";
    report.notes.push(`页面打不开：${err instanceof Error ? err.message : String(err)}`);
    return { report };
  }
  const blocked = await pageBlockedReason(page);
  if (blocked) {
    const report = checkJobListHealth(platform, [], 0, { linkless: platform === "zhilian" });
    report.verdict = "BLOCKED";
    report.notes.push(`被风控拦截（${blocked}），请先在数据源面板完成登录或验证`);
    report.snapshots = await snapshotJobPage(page, platform, diagnoseDir);
    return { report };
  }

  let read = await inspectNativeJobPage(page, runtime, platform, keyword);
  const simulated = options.simulate === platform;
  if (simulated) read = { jobs: [], cardCount: 0, selector: "" };
  const report = checkJobListHealth(platform, read.jobs, read.cardCount, { linkless: platform === "zhilian" });
  report.fallbacks = runtime.fallbacks().filter((item) => item.platform === platform);
  if (report.verdict === "BROKEN" || report.verdict === "DEGRADED") {
    report.snapshots = await snapshotJobPage(page, platform, diagnoseDir);
    const candidates = await inferNativeCardCandidates(page, runtime, platform, keyword).catch(() => []);
    report.candidates = candidates.map(compactCandidate);
    const verified = candidates.filter((candidate) => candidate.verified);
    report.notes.push(verified.length
      ? `推断出 ${verified.length} 个可用候选，可执行“诊断并修复”固化`
      : candidates.length
        ? "推断出候选但岗位名/链接填充率不足，需要人工查看快照"
        : "未推断出候选，页面结构可能整体重写，需要人工介入");
  }

  const detail = Math.max(0, Math.min(3, Math.round(options.detail ?? 1)));
  if (detail > 0 && read.jobs.length && report.verdict !== "BLOCKED") {
    const sample = read.jobs.slice(0, detail);
    for (const job of sample) {
      try { await enrichJobInPage(page, job, runtime); }
      catch (err) { report.notes.push(`详情补全失败：${err instanceof Error ? err.message : String(err)}`); }
    }
    const detailReport = checkJobDetailHealth(platform, sample, runtime.unsupportedFields(platform));
    report.fields.push(...detailReport.fields);
    report.notes.push(...detailReport.notes);
    report.verdict = worseJobVerdict(report.verdict, detailReport.verdict);
    if (detailReport.verdict !== "OK" && !Object.keys(report.snapshots).length) {
      report.snapshots = await snapshotJobPage(page, platform, diagnoseDir);
    }
  }
  if (report.fallbacks.length) report.notes.push("有字段靠后备选择器命中，建议固化首选值");

  const best = report.candidates
    .filter((candidate) => candidate.verified === true && typeof candidate.selector === "string")
    .sort((left, right) => Number(right.titleRate ?? 0) - Number(left.titleRate ?? 0))[0];
  if (options.apply && best && !simulated) {
    const selector = String(best.selector);
    const result = await applyJobSelector(dataDir, platform, "card", selector, {
      ...best,
      checkedAt: new Date().toISOString(),
      keyword,
    });
    return { report, applied: { selector, path: result.path } };
  }
  return { report };
}

/** 诊断入口；报告落盘由 server/job.ts 负责，避免浏览器层知道数据目录布局。 */
export async function diagnoseNativeJobSites(
  dataDir: string,
  profile: JobSearchProfile,
  platforms: readonly JobPlatform[],
  options: JobDiagnosisOptions = {},
): Promise<JobDiagnosisResult> {
  const runtime = await loadJobSelectorRuntime(dataDir);
  const diagnoseDir = join(dataDir, "out", "diagnose");
  const applied: JobDiagnosisApplied[] = [];
  return withPersistentBrowser(dataDir, JOB_HEADLESS, async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    const reports: JobPlatformHealthReport[] = [];
    // BOSS 的风控最敏感，放到最后，避免前面平台的验证窗口影响它。
    const order = [...platforms].sort((left, right) => Number(left === "boss") - Number(right === "boss"));
    for (let index = 0; index < order.length; index += 1) {
      const platform = order[index]!;
      const outcome = await diagnosePlatform(page, runtime, dataDir, platform, profile, options, diagnoseDir);
      reports.push(outcome.report);
      if (outcome.applied) applied.push({ platform, ...outcome.applied });
      if (index < order.length - 1) await sleep(PLATFORM_COOLDOWN_MS);
    }
    let overall: JobHealthVerdict = "OK";
    for (const report of reports) overall = worseJobVerdict(overall, report.verdict);
    return {
      at: new Date().toISOString(),
      overall,
      ok: overall === "OK",
      platforms: reports,
      applied,
      simulated: options.simulate ?? null,
    };
  });
}
