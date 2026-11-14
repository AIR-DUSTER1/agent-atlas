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
import {
  JOB_SUPPORTED_CITIES, exportJobGreetTargets, initJobGreetProfile, readManifest, saveJobGreetings,
} from "../../src/server/job.js";
import { writeJobHtmlReport } from "../../src/server/job-html.js";
import { writeJobWorkbook } from "../../src/server/job-workbook.js";
import { checkJobListHealth } from "../../src/server/job-health.js";
import { applyJobSelector, loadJobSelectorRuntime } from "../../src/server/job-selectors.js";
import { parseNativeCard } from "../../src/server/job-cards.js";
import {
  canonicalJobPlatform, createJobRecord, detectOutsourcing, mergeJobRecords, normalizeStoredJob, parseSalaryK,
  parseWorkHours, parseWorkRest, queryJobRecords, scoreJob,
  JOB_GREETING_MAX_LEN, type JobManifest, type JobRecord,
} from "../../src/server/job-model.js";

const byName = (name: string): { invoke: (input: unknown) => Promise<unknown> } => {
  const found = jobTools.find((item) => item.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found as unknown as { invoke: (input: unknown) => Promise<unknown> };
};

const profile = { keywords: ["Agent开发"], city: "青岛" as const, salaryMin: 10, salaryMax: 20, years: 2 };

test("工具集：七个工具都在，且名字符合 job_ 前缀约定", () => {
  assert.deepEqual(jobTools.map((item) => item.name).sort(), [
    "job_collect", "job_diagnose", "job_enrich", "job_greet", "job_greet_save", "job_query", "job_summary",
  ]);
});

test("职业 profile：只绑定 job_* 与基础工具，不带开发/知识库/找房工具", () => {
  const names = jobProfile.tools.map((item) => item.name);
  assert.ok(names.includes("job_collect"));
  assert.ok(names.includes("job_greet"));
  assert.ok(names.includes("job_greet_save"));
  assert.ok(names.includes("calculator"));
  for (const forbidden of ["terminal", "write_file", "retrieve_docs", "house_search", "delegate_agent"]) {
    assert.ok(!names.includes(forbidden), `不应包含 ${forbidden}`);
  }
});

test("审批登记：采集/补详情/写回招呼语必须审批，查询、概览与招呼语准备不登记", () => {
  assert.ok(jobApprovals.job_collect);
  assert.ok(jobApprovals.job_enrich);
  assert.ok(jobApprovals.job_diagnose);
  assert.ok(jobApprovals.job_greet_save);
  assert.equal(jobApprovals.job_query, undefined);
  assert.equal(jobApprovals.job_summary, undefined);
  assert.equal(jobApprovals.job_greet, undefined);
  const text = jobApprovals.job_collect({ city: "青岛", keywords: ["Agent开发"], salaryMin: 10, salaryMax: 20, years: 2 });
  assert.match(text, /青岛/);
  assert.match(text, /Agent开发/);
  assert.match(text, /10-20K/);
  assert.match(jobApprovals.job_diagnose({ platforms: ["boss"], apply: true }), /selectors\.json/);
  assert.match(jobApprovals.job_greet_save({ items: [{ key: "k", greeting: "g" }] }), /1 条/);
  assert.match(jobApprovals.job_greet_save({ items: [] }), /0 条/);
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
  const outsource = detectOutsourcing("", "某人力资源有限公司", "", "人力资源");
  assert.equal(outsource.isOutsourcing, "是");
  const doubtful = detectOutsourcing("开发工程师", "某科技公司", "项目制驻点开发", "人工智能");
  assert.equal(doubtful.isOutsourcing, "待确认");
});

test("外包判定对齐上游：职位名含外包直接判是，公司/JD/行业 token 命中", () => {
  assert.equal(detectOutsourcing("Java外包工程师", "某科技公司", "", "软件").isOutsourcing, "是");
  const named = detectOutsourcing("开发工程师", "京北方信息技术", "", "软件");
  assert.equal(named.isOutsourcing, "是");
  assert.match(named.outsourcingReason, /京北方/);
  assert.equal(detectOutsourcing("开发工程师", "思特沃克软件", "", "软件").isOutsourcing, "是");
  assert.equal(detectOutsourcing("开发工程师", "某科技公司", "需长期入职甲方现场办公", "软件").isOutsourcing, "是");
  assert.equal(detectOutsourcing("开发工程师", "某人力服务公司", "", "人力服务").isOutsourcing, "待确认");
  assert.equal(detectOutsourcing("前端工程师", "某科技公司", "", "互联网").isOutsourcing, "否");
});

test("平台归一化：常见别名统一到 canonical，查询能用别名过滤", () => {
  assert.equal(canonicalJobPlatform("zhipin"), "boss");
  assert.equal(canonicalJobPlatform("BOSS直聘"), "boss");
  assert.equal(canonicalJobPlatform("51job"), "job51");
  assert.equal(canonicalJobPlatform("前程无忧"), "job51");
  assert.equal(canonicalJobPlatform(" zhaopin "), "zhilian");
  assert.equal(canonicalJobPlatform("leipin"), "liepin");
  assert.equal(canonicalJobPlatform("智联招聘"), "zhilian");
  assert.equal(canonicalJobPlatform("水滴招聘"), null);
  const rows = [
    job(),
    job({ platform: "前程无忧", applyUrl: "https://example.com/job/5", title: "前端工程师" }),
  ];
  const hit = queryJobRecords(rows, { platform: "51job" }, 10);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.platform, "前程无忧");
});

test("作息解析：单双休优先于双休，中文时刻规整且过滤热线噪声与超长时段", () => {
  assert.equal(parseWorkRest("单双休 五险一金"), "单双休");
  assert.equal(parseWorkRest("周末双休 带薪年假"), "双休");
  assert.equal(parseWorkRest("大小周 弹性"), "大小周");
  assert.equal(parseWorkHours("上班时间 早9点-晚6点 午休1小时"), "09:00-18:00");
  assert.equal(parseWorkHours("工作时间 9:00-18:00"), "09:00-18:00");
  assert.equal(parseWorkHours("朝九晚六 双休"), "09:00-18:00");
  assert.equal(parseWorkHours("工作时间 8:00-23:00"), "");
  const noisy = `${"岗位职责：负责平台开发。".repeat(10)}客服热线 9:00-18:00`;
  assert.equal(parseWorkHours(noisy), "");
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

test("增量合并：投递状态、备注与招呼语受保护，未采平台与有招呼语的岗位不被冲掉", () => {
  const old = job({ status: "已投递", remark: "已约面", greeting: "您好，看到贵司 Agent 岗…" });
  const fresh = job({ company: "某科技公司（更新）" });
  const other = job({ platform: "智联招聘", applyUrl: "https://example.com/job/2", title: "后端工程师" });
  const merged = mergeJobRecords([fresh], [old, other], new Set(["BOSS直聘"]));
  assert.equal(merged.jobs.length, 2);
  assert.equal(merged.jobs.find((item) => item.applyUrl === old.applyUrl)?.status, "已投递");
  assert.equal(merged.jobs.find((item) => item.applyUrl === old.applyUrl)?.greeting, "您好，看到贵司 Agent 岗…");
  assert.equal(merged.jobs.some((item) => item.platform === "智联招聘"), true);
  // 待投递、无备注，但已写招呼语的岗位（本次该平台跑过且未再现）也要保留
  const greeted = job({ applyUrl: "https://example.com/job/9", greeting: "已写好招呼语" });
  const carried = mergeJobRecords([], [greeted], new Set(["BOSS直聘"]));
  assert.equal(carried.carried, 1);
  assert.equal(carried.jobs.length, 1);
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

test("招呼语闭环：画像不覆盖/force 重置、导出按分截断 JD、写回校验 key 与超长并重出报告", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "job-greet-"));
  try {
    const outDir = join(dataDir, "out");
    await mkdir(outDir, { recursive: true });
    const rows = [
      job({ score: 82.5, jdText: "负责平台开发".repeat(250) }),
      job({ title: "前端工程师", score: 71, applyUrl: "https://example.com/job/4", greeting: "旧招呼语" }),
    ];
    await writeFile(join(outDir, "最新岗位清单.json"), JSON.stringify(rows), "utf8");

    const init = await initJobGreetProfile(false, dataDir);
    assert.equal(init.created, true);
    // 用户手填的画像不被 init 覆盖，force 才重置
    await writeFile(join(dataDir, "profile.md"), "# 用户已补全的画像", "utf8");
    assert.equal((await initJobGreetProfile(false, dataDir)).created, false);
    assert.equal(await readFile(join(dataDir, "profile.md"), "utf8"), "# 用户已补全的画像");
    assert.equal((await initJobGreetProfile(true, dataDir)).created, true);
    assert.match(await readFile(join(dataDir, "profile.md"), "utf8"), /项目弹药/);

    const exported = await exportJobGreetTargets({}, dataDir);
    assert.equal(exported.exported, 1); // 已有招呼语的不导
    assert.equal(exported.items[0]?.applyUrl, "https://example.com/job/1");
    assert.ok(exported.items[0]!.jdText.length <= 1_201); // JD 超长截断带省略号
    assert.match(exported.profile, /项目弹药/);
    assert.equal(exported.maxLen, JOB_GREETING_MAX_LEN);
    const all = await exportJobGreetTargets({ overwrite: true }, dataDir);
    assert.equal(all.exported, 2);

    // key 对不上整批拒绝，不静默丢弃
    await assert.rejects(
      saveJobGreetings([{ key: "https://example.com/none", greeting: "你好" }], dataDir),
      /不在当前清单/,
    );
    await assert.rejects(
      saveJobGreetings([{ key: "https://example.com/job/1", greeting: "  " }], dataDir),
      /没有可写回的招呼语/,
    );
    // 超长截断写回并重出 Excel/HTML
    const saved = await saveJobGreetings([{ key: "https://example.com/job/1", greeting: "好".repeat(260) }], dataDir);
    assert.equal(saved.saved, 1);
    assert.equal(saved.truncated, 1);
    assert.ok(saved.xlsxPath && saved.htmlPath);
    const loaded = await readManifest(dataDir);
    assert.ok(loaded);
    const target = loaded.jobs.find((item) => item.applyUrl === "https://example.com/job/1");
    assert.equal([...(target?.greeting ?? "")].length, JOB_GREETING_MAX_LEN);
    assert.equal(loaded.jobs.find((item) => item.applyUrl === "https://example.com/job/4")?.greeting, "旧招呼语");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("原生 XLSX 与同名 HTML：ZIP 头、投递状态列和 HTML 转义", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "job-native-"));
  try {
    const outDir = join(dataDir, "out");
    await mkdir(outDir, { recursive: true });
    const manifest: JobManifest = { jobs: [job({ greeting: "您好，看到贵司 Agent 岗位…" })], fetchedAt: "2026-11-03T12:00:00.000Z", path: join(outDir, "最新岗位清单.json") };
    await writeFile(manifest.path, JSON.stringify(manifest.jobs), "utf8");
    const xlsx = await writeJobWorkbook(manifest, outDir);
    const bytes = await readFile(xlsx);
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.ok(bytes.length > 1_000);
    const rawWorkbook = bytes.toString("utf8");
    assert.match(rawWorkbook, /点击投递/);
    assert.match(rawWorkbook, /招呼语/);
    assert.match(rawWorkbook, /您好，看到贵司 Agent 岗位…/);
    assert.match(rawWorkbook, /TargetMode="External"/);
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

test("选择器注册表：默认候选可用，本地固化带备份并记录 learned 证据", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "job-selectors-"));
  try {
    const initial = await loadJobSelectorRuntime(dataDir);
    assert.equal(initial.source, "default");
    assert.equal(initial.primary("boss", "card"), "css:.job-card-wrap");
    const first = await applyJobSelector(dataDir, "boss", "card", "css:.new-card", { titleRate: 0.9 });
    assert.deepEqual(first.next[0], "css:.new-card");
    assert.ok(first.next.includes("css:.job-card-wrap"));
    const loaded = await loadJobSelectorRuntime(dataDir);
    assert.equal(loaded.source, "override");
    assert.equal(loaded.primary("boss", "card"), "css:.new-card");
    await applyJobSelector(dataDir, "boss", "card", "css:.newer-card");
    const backup = await readFile(join(dataDir, "selectors.json.bak"), "utf8");
    assert.match(backup, /\.new-card/);
    const saved = JSON.parse(await readFile(join(dataDir, "selectors.json"), "utf8")) as { learned: Array<{ key: string }> };
    assert.equal(saved.learned.length, 2);
    assert.equal(saved.learned[0]?.key, "card");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("结构健康：正常列表 OK，容器失效 BROKEN，Vue 有数据但 DOM 失效降级", () => {
  assert.equal(checkJobListHealth("boss", [job()], 3).verdict, "OK");
  assert.equal(checkJobListHealth("boss", [], 0).verdict, "BROKEN");
  assert.equal(checkJobListHealth("zhilian", [job({ platform: "智联招聘" })], 0, { linkless: true }).verdict, "DEGRADED");
});

test("卡片解析：绝对投递链接不能被空 base 丢掉，结构自愈才能验证链接率", () => {
  const parsed = parseNativeCard("boss", {
    text: "Agent开发 15-25K 示例科技 青岛·市南 3-5年 本科",
    title: "Agent开发",
    salary: "15-25K",
    href: "https://example.com/job_detail/1?from=list",
    company: "示例科技",
    companyUrl: "",
    tags: ["五险一金", "双休"],
  }, "Agent开发");
  assert.ok(parsed);
  assert.equal(parsed.applyUrl, "https://example.com/job_detail/1");
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
