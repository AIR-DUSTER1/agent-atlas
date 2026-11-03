/**
 * tests/unit/tools-job.test.ts — 求职 Agent 的工具契约与内置规则
 * ============================================================
 * 守：四平台工具能力、审批边界、四要素校验、评分/外包/合并/查询、
 * 原生 XLSX 与同名 HTML 交付，以及「不再依赖外部 Skill / Python」的架构约束。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { jobTools } from "../../src/tools-job.js";
import { jobApprovals } from "../../src/agent/approvals.js";
import { jobProfile } from "../../src/agent/job.js";
import { JOB_SUPPORTED_CITIES, readManifest } from "../../src/server/job.js";
import { writeJobHtmlReport } from "../../src/server/job-html.js";
import { writeJobWorkbook } from "../../src/server/job-workbook.js";
import {
  createJobRecord, detectOutsourcing, mergeJobRecords, normalizeStoredJob, parseSalaryK, queryJobRecords, scoreJob, type JobManifest, type JobRecord,
} from "../../src/server/job-model.js";

const byName = (name: string): { invoke: (input: unknown) => Promise<unknown> } => {
  const found = jobTools.find((item) => item.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found as unknown as { invoke: (input: unknown) => Promise<unknown> };
};

const profile = { keywords: ["Agent开发"], city: "青岛" as const, salaryMin: 10, salaryMax: 20, years: 2 };

test("工具集：四个工具都在，且名字符合 job_ 前缀约定", () => {
  assert.deepEqual(jobTools.map((item) => item.name).sort(), ["job_collect", "job_enrich", "job_query", "job_summary"]);
});

test("职业 profile：只绑定 job_* 与基础工具，不带开发/知识库/找房工具", () => {
  const names = jobProfile.tools.map((item) => item.name);
  assert.ok(names.includes("job_collect"));
  assert.ok(names.includes("calculator"));
  for (const forbidden of ["terminal", "write_file", "retrieve_docs", "house_search", "delegate_agent"]) {
    assert.ok(!names.includes(forbidden), `不应包含 ${forbidden}`);
  }
});

test("审批登记：采集与补详情必须审批，查询与概览不登记", () => {
  assert.ok(jobApprovals.job_collect);
  assert.ok(jobApprovals.job_enrich);
  assert.equal(jobApprovals.job_query, undefined);
  assert.equal(jobApprovals.job_summary, undefined);
  const text = jobApprovals.job_collect({ city: "青岛", keywords: ["Agent开发"], salaryMin: 10, salaryMax: 20, years: 2 });
  assert.match(text, /青岛/);
  assert.match(text, /Agent开发/);
  assert.match(text, /10-20K/);
});

test("采集：缺少薪资或年限时拒绝，并说明缺什么", async () => {
  const result = await byName("job_collect").invoke({ keywords: ["Agent开发"], city: "青岛" } as never);
  const parsed = JSON.parse(String(result)) as { error?: string };
  assert.match(parsed.error!, /期望月薪区间/);
  assert.match(parsed.error!, /工作年限/);
});

test("采集：城市不在支持列表时明确拒绝并给出可选城市", async () => {
  const result = await byName("job_collect").invoke({ keywords: ["Agent开发"], city: "拉萨", salaryMin: 10, salaryMax: 20, years: 2 } as never);
  const parsed = JSON.parse(String(result)) as { error?: string };
  assert.match(parsed.error!, /不在求职 Agent 支持列表内/);
  assert.match(parsed.error!, new RegExp(JOB_SUPPORTED_CITIES[0]!));
});

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return createJobRecord("BOSS直聘", {
    title: "Agent 开发工程师", company: "某科技公司", salary: "15-25K", salaryNum: 20,
    city: "青岛·市南", experience: "3-5年", education: "本科", score: 82.5,
    scoreDetail: "岗位35/薪资22/经验15/公司8/活跃2.5", isOutsourcing: "否",
    published: "2026-10-30", hrActive: "刚刚", companySize: "100-499人",
    companyIndustry: "人工智能", companyFinancing: "B轮", workRest: "双休",
    welfare: "五险一金", address: "青岛市南区", status: "待投递",
    applyUrl: "https://example.com/job/1", direction: "Agent开发", companyIntro: "专注 <Agent> 平台",
    ...patch,
  });
}

test("评分与外包识别：五维评分、混合薪资单位、外包折减与待确认规则可复现", () => {
  assert.equal(parseSalaryK("7千-1.2万·13薪"), 9.5);
  const scored = scoreJob(job(), profile);
  assert.ok(scored.score > 60 && scored.score <= 100);
  assert.match(scored.scoreDetail, /岗位\d+\/35/);
  const outsource = detectOutsourcing("某人力资源有限公司", "", "人力资源");
  assert.equal(outsource.isOutsourcing, "是");
  const doubtful = detectOutsourcing("某科技公司", "项目制驻点开发", "人工智能");
  assert.equal(doubtful.isOutsourcing, "待确认");
});

test("旧版 snake_case 清单可无损迁移到内置模型", () => {
  const normalized = normalizeStoredJob({
    platform: "BOSS直聘", title: "Agent 开发", company: "旧公司", salary_num: 18,
    is_outsourcing: "待确认", apply_url: "https://example.com/legacy", score_detail: "旧拆解",
  });
  assert.ok(normalized);
  assert.equal(normalized.salaryNum, 18);
  assert.equal(normalized.isOutsourcing, "待确认");
  assert.equal(normalized.applyUrl, "https://example.com/legacy");
  assert.equal(normalized.status, "待投递");
});

test("增量合并：保留投递状态与备注，未采平台不被冲掉", () => {
  const old = job({ status: "已投递", remark: "已约面" });
  const fresh = job({ company: "某科技公司（更新）" });
  const other = job({ platform: "智联招聘", applyUrl: "https://example.com/job/2", title: "后端工程师" });
  const merged = mergeJobRecords([fresh], [old, other], new Set(["BOSS直聘"]));
  assert.equal(merged.jobs.length, 2);
  assert.equal(merged.jobs.find((item) => item.applyUrl === old.applyUrl)?.status, "已投递");
  assert.equal(merged.jobs.some((item) => item.platform === "智联招聘"), true);
});

test("查询：关键词、城市、外包和最低分过滤，并按分数降序", () => {
  const rows = [
    job({ score: 88 }),
    job({ title: "后端开发", city: "北京·朝阳", score: 74, platform: "智联招聘", applyUrl: "https://example.com/job/2" }),
    job({ title: "Java 驻场开发", score: 91, isOutsourcing: "是", applyUrl: "https://example.com/job/3" }),
  ];
  const result = queryJobRecords(rows, { city: "青岛", excludeOutsourcing: true, minScore: 70 }, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, "Agent 开发工程师");
});

test("原生 XLSX 与同名 HTML：ZIP 头、投递状态列和 HTML 转义", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "job-native-"));
  try {
    const outDir = join(dataDir, "out");
    await mkdir(outDir, { recursive: true });
    const manifest: JobManifest = { jobs: [job()], fetchedAt: "2026-11-03T12:00:00.000Z", path: join(outDir, "最新岗位清单.json") };
    await writeFile(manifest.path, JSON.stringify(manifest.jobs), "utf8");
    const xlsx = await writeJobWorkbook(manifest, outDir);
    const bytes = await readFile(xlsx);
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.ok(bytes.length > 1_000);
    const loaded = await readManifest(dataDir);
    assert.ok(loaded);
    const html = await writeJobHtmlReport(loaded);
    assert.equal(html, xlsx.replace(/\.xlsx$/i, ".html"));
    const content = await readFile(html, "utf8");
    assert.match(content, /求职岗位清单报告/);
    assert.match(content, /专注 &lt;Agent&gt; 平台/);
    assert.doesNotMatch(content, /<script[\s>]/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("架构约束：求职执行服务不再引用 skill 根目录、Python 脚本或子进程 CLI", async () => {
  const [server, browser] = await Promise.all([
    readFile(new URL("../../src/server/job.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/server/job-browser.ts", import.meta.url), "utf8"),
  ]);
  const source = `${server}\n${browser}`;
  assert.doesNotMatch(source, /scripts\/main\.py|pythonBin|runControlled\(|job-hunter 技能根目录/);
  assert.match(source, /launchPersistentContext/);
  assert.match(source, /collectNativeJobs/);
  const [html, view] = await Promise.all([
    readFile(new URL("../../src/client/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../src/client/views/job.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /job-skill-dir|job-python-bin|技能根目录|Python 解释器/);
  assert.match(html, /job-data-dir/);
  assert.match(view, /无需 Python \/ Skill/);
});
