/**
 * ============================================================
 * tools-job.ts — 求职岗位 Agent 的工具集（内置采集流程的模型接口）
 * ============================================================
 * 数据来自 server/job.ts 的内置浏览器采集器（BOSS直聘 / 智联 /
 * 前程无忧 / 猎聘 四平台采集 → 规则打分 → 排除外包 → Excel + HTML 报告交付）。
 *
 * 约定（与仓库其它工具一致）：
 *   - zod schema + describe 全中文；description 写清「何时用/何时不用」
 *   - 失败不 throw 穿透图：返回中文错误 JSON，让模型转述
 *   - **job_collect 是重操作**：3-5 分钟子进程 + 会登录态访问招聘站点，
 *     在 agent/approvals.ts 的 job profile 策略登记，执行前必须人工审批
 *   - 只读类（查清单 / 概览 / 招呼语准备）直接执行；补详情也会访问外网但只读公开页面，
 *     登记在审批表里意味着用户能看到「要抓哪些站点」，这是本项目的既有立场
 *   - job_greet_save 会改写本地清单文件并重出报告，按 §5.4 登记审批
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  collectJobs, diagnoseJobs, enrichJobs, exportJobGreetTargets, initJobGreetProfile, queryJobs,
  readManifest, saveJobGreetings,
  JOB_GREETING_MAX_LEN, JOB_PLATFORMS, JOB_SUPPORTED_CITIES, MAX_JOBS_IN_RESULT, jobIdentity,
  type JobRecord,
} from "./server/job.js";
import { isPluginEnabled } from "./plugin-state.js";

/** 统一收尾：把结果压成模型可读的 JSON 字符串，超长截断并标注。 */
function payload(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= 26_000) return text;
  return JSON.stringify({
    truncated: true,
    note: "返回内容过长已截断，请缩小范围（加关键词 / 城市 / 提高分数门槛）后重查",
    text: text.slice(0, 26_000),
  });
}

function badArgs(message: string): string {
  return JSON.stringify({ error: message });
}

function pluginOff(): string | null {
  return isPluginEnabled("job")
    ? null
    : "求职岗位插件已停用，请先在「设置 → 插件」中启用。";
}

/** 给模型看的岗位摘要：只留决策需要的字段，避免把长文本灌进上下文。 */
function summarizeJob(job: JobRecord): Record<string, unknown> {
  return {
    title: job.title,
    company: job.company,
    platform: job.platform,
    salary: job.salary,
    city: job.city,
    experience: job.experience,
    education: job.education,
    score: Math.round(job.score * 10) / 10,
    scoreDetail: job.scoreDetail,
    isOutsourcing: job.isOutsourcing,
    outsourcingReason: job.outsourcingReason,
    companySize: job.companySize,
    companyIndustry: job.companyIndustry,
    companyFinancing: job.companyFinancing,
    workRest: job.workRest,
    hrActive: job.hrActive,
    published: job.published,
    status: job.status,
    applyUrl: job.applyUrl,
    direction: job.direction,
    greeting: job.greeting,
  };
}

// ---------------------------------------------------------------------------
// 1. job_collect：四平台采集 + 打分 + 导出 Excel（重操作 → 审批）
// ---------------------------------------------------------------------------
export const jobCollectTool = tool(
  async ({ keywords, city, salaryMin, salaryMax, years, pages, platforms }) => {
    const off = pluginOff();
    if (off) return badArgs(off);
    // 四个关键字段都先做「缺什么」检查，再谈有效性：先告诉模型该问用户什么，
    // 比只说「city 不能为空」有用得多。
    const missing: string[] = [];
    if (!keywords?.length) missing.push("目标岗位方向");
    if (!city?.trim()) missing.push("目标城市");
    if (typeof salaryMin !== "number" || typeof salaryMax !== "number") missing.push("期望月薪区间");
    if (typeof years !== "number") missing.push("工作年限");
    if (missing.length) {
      return badArgs(
        `采集前缺少必要信息：${missing.join("、")}。` +
        "这些直接决定采什么、怎么排序，猜错等于白跑。请先向用户确认（一次问完，不要分多轮）。",
      );
    }
    if (!JOB_SUPPORTED_CITIES.includes(city!.trim() as (typeof JOB_SUPPORTED_CITIES)[number])) {
      return badArgs(
        `城市「${city}」目前不在求职 Agent 支持列表内。可选：${JOB_SUPPORTED_CITIES.join("、")}。` +
        "其它城市需要先补平台城市编码，请如实告知用户。",
      );
    }

    const outcome = await collectJobs({
      keywords: keywords!,
      city: city!.trim() as (typeof JOB_SUPPORTED_CITIES)[number],
      salaryMin: salaryMin!,
      salaryMax: salaryMax!,
      years: years!,
      ...(typeof pages === "number" ? { pages } : {}),
      ...(platforms?.length ? { platforms } : {}),
    });
    if (!outcome.ok) {
      return payload({ ok: false, summary: outcome.summary, output: outcome.output });
    }
    const jobs = outcome.manifest?.jobs ?? [];
    const top = [...jobs].sort((a, b) => b.score - a.score).slice(0, MAX_JOBS_IN_RESULT);
    const outsourceCount = jobs.filter((job) => job.isOutsourcing === "是").length;
    return payload({
      ok: true,
      summary: outcome.summary,
      total: jobs.length,
      outsourcing: outsourceCount,
      // 只给 Top N，避免把整张表灌进上下文
      returned: top.length,
      jobs: top.map(summarizeJob),
      ...(outcome.xlsxPath ? { xlsxPath: outcome.xlsxPath } : {}),
      ...(outcome.htmlPath ? { htmlPath: outcome.htmlPath } : {}),
      ...(outcome.htmlError ? { htmlError: outcome.htmlError } : {}),
      note: outcome.xlsxPath
        ? `Excel 与 HTML 报告已生成在求职数据目录的 out/ 下（Excel：${outcome.xlsxPath}；HTML：${outcome.htmlPath || "未生成"}；岗位清单 JSON 是唯一权威数据源）。` +
          "需要更多条目请用 job_query 加条件筛选，不要让我复述整张表。"
        : "Excel 生成失败，请把错误转述给用户。需要更多条目请用 job_query。",
    });
  },
  {
    name: "job_collect",
    description:
      "使用内置浏览器流程从 BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘采集岗位，按匹配度打分、自动识别外包，并导出 Excel 与同名 HTML 报告；不依赖外部 Skill 或 Python。" +
      "何时用：用户想找工作、想筛岗位，且已明确「岗位方向 + 城市 + 期望月薪 + 工作年限」四项。" +
      "何时不用：用户只想看已有清单用 job_query；只想补 JD 详情用 job_enrich。" +
      "注意：这是重操作（3-5 分钟，会访问招聘站点），执行前系统会人工审批。",
    schema: z.object({
      keywords: z.array(z.string()).optional().describe("目标岗位方向，可多个，如 [\"Agent开发\", \"大模型应用\"]"),
      city: z.string().optional().describe(`目标城市，支持：${JOB_SUPPORTED_CITIES.join("、")}`),
      // 四个关键字段都设为可选：缺字段时由工具返回「还缺什么、该怎么问」的中文提示，
      // 比 zod 直接抛 Invalid input 对模型有用得多（模型读不懂 schema 报错）。
      salaryMin: z.number().optional().describe("期望月薪下限（K，税前），如 10"),
      salaryMax: z.number().optional().describe("期望月薪上限（K，税前），如 20"),
      years: z.number().optional().describe("工作年限，如 2；应届填 0"),
      pages: z.number().int().min(1).max(3).optional().describe("每个关键词翻页数，默认 1；最多 3 页，翻越多越容易触发风控"),
      platforms: z.array(z.enum(JOB_PLATFORMS)).optional().describe("只跑指定平台；不填表示四平台全跑"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 2. job_query：在已有清单里筛选（纯本地，不触发 CLI）
// ---------------------------------------------------------------------------
export const jobQueryTool = tool(
  async ({ keyword, city, excludeOutsourcing, minScore, status, platform, limit }) => {
    const off = pluginOff();
    if (off) return badArgs(off);
    try {
      const result = await queryJobs({
        ...(keyword ? { keyword } : {}),
        ...(city ? { city } : {}),
        ...(typeof excludeOutsourcing === "boolean" ? { excludeOutsourcing } : {}),
        ...(typeof minScore === "number" ? { minScore } : {}),
        ...(status ? { status } : {}),
        ...(platform ? { platform } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
      });
      return payload({
        ok: true,
        matched: result.total,
        returned: result.jobs.length,
        jobs: result.jobs.map(summarizeJob),
        note: result.total > result.jobs.length
          ? `共匹配 ${result.total} 条，只返回前 ${result.jobs.length} 条。可以说「看更多」时提高 limit 或加条件。`
          : undefined,
      });
    } catch (err) {
      return badArgs(err instanceof Error ? err.message : String(err));
    }
  },
  {
    name: "job_query",
    description:
      "在已采集的岗位清单里按条件筛选并排序（纯本地查询，不联网、不耗配额）。" +
      "何时用：用户问「有哪些岗位」「帮我筛掉外包」「XX 公司的岗位」「已投递的还剩哪些」。" +
      "何时不用：清单还不存在时先 job_collect；要补 JD 全文用 job_enrich。",
    schema: z.object({
      keyword: z.string().optional().describe("模糊匹配岗位名 / 公司名 / 方向 / 行业"),
      city: z.string().optional().describe("城市过滤"),
      excludeOutsourcing: z.boolean().optional().describe("true = 排除判定为外包的岗位"),
      minScore: z.number().optional().describe("最低匹配分（0-100），如 70"),
      status: z.enum(["待投递", "已投递", "已面试", "已结束"]).optional().describe("按投递状态过滤"),
      platform: z.string().optional().describe("平台过滤，如 BOSS直聘 / 智联招聘"),
      limit: z.number().int().min(1).max(MAX_JOBS_IN_RESULT).optional().describe("返回条数上限，默认 20"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 3. job_enrich：补 JD 全文 / 地址 / HR 活跃（只读抓取 → 审批）
// ---------------------------------------------------------------------------
export const jobEnrichTool = tool(
  async ({ limit }) => {
    const off = pluginOff();
    if (off) return badArgs(off);
    const outcome = await enrichJobs(typeof limit === "number" ? limit : 10);
    if (!outcome.ok) {
      return payload({ ok: false, summary: outcome.summary, output: outcome.output });
    }
    return payload({
      ok: true,
      summary: outcome.summary,
      note: "字段留空是数据本身的限制，不是失败：多数 JD 只写「双休」不写具体上下班时间；" +
        "猎聘常隐藏雇主名（已兜底为「（猎聘未披露）」）。别把空字段当成缺陷去补。",
    });
  },
  {
    name: "job_enrich",
    description:
      "给已有清单补 JD 全文、工作地址、HR 最近活跃、公司规模等详情（逐条打开岗位页，只读）。" +
      "何时用：用户想看某类岗位的具体要求，或需要判断 HR 是否活跃再决定投不投。" +
      "何时不用：刚采集完不要立刻补——应与采集间隔几分钟，否则大概率被风控。" +
      "执行前系统会人工审批。",
    schema: z.object({
      limit: z.number().int().min(1).max(50).optional().describe("本次最多补几条，默认 10；条数越多越容易被风控"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 4. job_greet：招呼语闭环的准备动作（生成画像 / 导出待写 / 查看进度）
//    纯本地不触外网，与 job_query 同级不登记审批
// ---------------------------------------------------------------------------
export const jobGreetTool = tool(
  async ({ action, top, overwrite, force }) => {
    const off = pluginOff();
    if (off) return badArgs(off);
    try {
      if (action === "init") {
        const result = await initJobGreetProfile(force === true);
        return payload({
          ok: result.ok,
          created: result.created,
          path: result.path,
          summary: result.summary,
          note: "请把画像模板给用户过目并请其补全真实经历与量化成果；画像空着就不要开始写招呼语，否则只能写空话。",
        });
      }
      if (action === "export") {
        const result = await exportJobGreetTargets({
          ...(typeof top === "number" ? { top } : {}),
          ...(overwrite === true ? { overwrite: true } : {}),
        });
        return payload({
          ok: true,
          profilePath: result.profilePath,
          hasProfile: result.hasProfile,
          profile: result.profile,
          maxLen: result.maxLen,
          remaining: result.remaining,
          exported: result.exported,
          items: result.items,
          note: result.note,
        });
      }
      const manifest = await readManifest();
      if (!manifest) return badArgs("还没有岗位清单：请先采集一次岗位。");
      const written = manifest.jobs.filter((job) => job.greeting.trim()).length;
      const pending = manifest.jobs
        .filter((job) => !job.greeting.trim())
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((job) => ({ key: jobIdentity(job), title: job.title, company: job.company, score: Math.round(job.score * 10) / 10 }));
      return payload({
        ok: true,
        written,
        total: manifest.jobs.length,
        next: pending,
        note: written === manifest.jobs.length
          ? "全部岗位都已写招呼语；要重写已写的用 job_greet action=export 加 overwrite=true。"
          : undefined,
      });
    } catch (err) {
      return badArgs(err instanceof Error ? err.message : String(err));
    }
  },
  {
    name: "job_greet",
    description:
      "招呼语闭环的准备动作：action=init 在求职数据目录生成画像模板 profile.md；action=export 导出待写招呼语清单（含画像全文与 JD 摘要，供撰写）；action=status 查看已写/待写进度。" +
      "何时用：用户想给目标岗位准备打招呼的开场白、想先建或补全求职画像。" +
      "何时不用：只看岗位用 job_query；写回已完成的招呼语用 job_greet_save。" +
      "纯本地操作，不访问外网。",
    schema: z.object({
      action: z.enum(["init", "export", "status"]).describe("init=生成画像模板；export=导出待写清单；status=查看进度"),
      top: z.number().int().min(1).max(MAX_JOBS_IN_RESULT).optional().describe("export 时最多导出几条，默认 10（按分数从高到低）"),
      overwrite: z.boolean().optional().describe("export 时 true = 连已写过招呼语的岗位一起重新导出，默认只导未写的"),
      force: z.boolean().optional().describe("init 时 true = 重置已存在的画像模板（用户手填内容会被覆盖，谨慎使用）"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 5. job_greet_save：写回撰写好的招呼语（写本地清单 → 审批）
// ---------------------------------------------------------------------------
export const jobGreetSaveTool = tool(
  async ({ items }) => {
    const off = pluginOff();
    if (off) return badArgs(off);
    if (!items?.length) {
      return badArgs("items 为空：请传 [{\"key\":\"…\",\"greeting\":\"…\"}] 数组，key 来自 job_greet 导出的 items。");
    }
    try {
      const result = await saveJobGreetings(items);
      return payload({
        ok: true,
        summary: result.summary,
        saved: result.saved,
        truncated: result.truncated,
        ...(result.xlsxPath ? { xlsxPath: result.xlsxPath } : {}),
        ...(result.htmlPath ? { htmlPath: result.htmlPath } : {}),
        note: "招呼语已进入清单与 Excel；再次采集或补详情都不会被覆盖。写超长的部分被截断到 " + JOB_GREETING_MAX_LEN + " 字。",
      });
    } catch (err) {
      return badArgs(err instanceof Error ? err.message : String(err));
    }
  },
  {
    name: "job_greet_save",
    description:
      "把撰写好的招呼语批量写回岗位清单，并重新生成 Excel 与 HTML 报告（只写本地求职数据目录，执行前系统会人工审批）。" +
      "何时用：job_greet action=export 导出待写清单、逐条撰写完成后一次性提交。" +
      "何时不用：还没导出待写清单、还没让用户确认画像时先别写。" +
      "key 必须与导出时一致，任何 key 对不上都会整批拒绝，不会静默丢弃。",
    schema: z.object({
      // 不设 min(1)：空 items / 空 greeting 由执行体返回「还缺什么」的中文提示，
      // 比 zod 的英文校验报错对模型有用（与 job_collect 四要素同思路）
      items: z.array(z.object({
        key: z.string().describe("岗位唯一键，来自 job_greet 导出 items 的 key 字段"),
        greeting: z.string().describe(`招呼语正文，不超过 ${JOB_GREETING_MAX_LEN} 字`),
      })).describe("待写回的招呼语列表，一次可以提交多条"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 6. job_profile_summary：清单概览（数量分布，不返回岗位明细）
// ---------------------------------------------------------------------------
export const jobSummaryTool = tool(
  async () => {
    const off = pluginOff();
    if (off) return badArgs(off);
    const manifest = await readManifest().catch((err) => {
      throw new Error(err instanceof Error ? err.message : String(err));
    });
    if (!manifest) {
      return badArgs("还没有岗位清单：请先采集一次岗位。");
    }
    const byDirection = new Map<string, number>();
    const byPlatform = new Map<string, number>();
    const byStatus = new Map<string, number>();
    let outsourcing = 0;
    let scoreSum = 0;
    for (const job of manifest.jobs) {
      const direction = job.direction || "未分类";
      byDirection.set(direction, (byDirection.get(direction) ?? 0) + 1);
      byPlatform.set(job.platform || "未知", (byPlatform.get(job.platform || "未知") ?? 0) + 1);
      byStatus.set(job.status, (byStatus.get(job.status) ?? 0) + 1);
      if (job.isOutsourcing === "是") outsourcing += 1;
      scoreSum += job.score;
    }
    const total = manifest.jobs.length;
    return payload({
      ok: true,
      total,
      outsourcing,
      averageScore: total ? Math.round((scoreSum / total) * 10) / 10 : 0,
      byDirection: Object.fromEntries(byDirection),
      byPlatform: Object.fromEntries(byPlatform),
      byStatus: Object.fromEntries(byStatus),
      note: "这是概览口径；具体岗位请用 job_query。Excel 交付物在求职数据目录的 out/ 下。",
    });
  },
  {
    name: "job_summary",
    description:
      "已有岗位清单的概览：总数、外包条数、平均分、按方向/平台/投递状态的分布。" +
      "何时用：用户问「一共采了多少」「外包多少」「各方向分布」。" +
      "何时不用：要看具体岗位用 job_query。",
    schema: z.object({}),
  }
);

// ---------------------------------------------------------------------------
// 5. job_diagnose：站点结构诊断；用户明确要求修复时才固化候选
// ---------------------------------------------------------------------------
export const jobDiagnoseTool = tool(
  async ({ platforms, keywords, city, apply, detail }) => {
    const off = pluginOff();
    if (off) return badArgs(off);
    try {
      const outcome = await diagnoseJobs({
        ...(platforms?.length ? { platforms } : {}),
        ...(keywords?.length ? { keywords } : {}),
        ...(city?.trim() ? { city: city.trim() } : {}),
        apply: apply === true,
        ...(typeof detail === "number" ? { detail } : {}),
      });
      return payload({
        ok: outcome.ok,
        summary: outcome.summary,
        reportPath: outcome.reportPath,
        applied: outcome.report.applied,
        platforms: outcome.report.platforms.map((item) => ({
          platform: item.platform,
          verdict: item.verdict,
          cardCount: item.cardCount,
          jobs: item.jobs,
          fields: item.fields,
          candidates: item.candidates.slice(0, 3),
          notes: item.notes,
          snapshots: item.snapshots,
        })),
        note: outcome.report.ok
          ? "各平台结构正常。"
          : "把异常平台、命中率和快照位置如实告诉用户；只有 verified=true 的候选才可建议 apply。",
      });
    } catch (err) {
      return badArgs(err instanceof Error ? err.message : String(err));
    }
  },
  {
    name: "job_diagnose",
    description:
      "诊断 BOSS直聘 / 智联招聘 / 前程无忧 / 猎聘的页面结构，区分被风控、真实空结果和站点改版；结构异常时会推断候选并在真实页面验证。" +
      "何时用：采集返回 0 条、提示结构变化、字段大量缺失，或用户明确要求检查招聘站点适配。" +
      "何时不用：正常采集用 job_collect；只想看已有清单用 job_query。" +
      "apply=true 只固化本次验证通过的候选，会写入求职数据目录的 selectors.json 并保留 .bak；执行前系统会人工审批。",
    schema: z.object({
      platforms: z.array(z.enum(JOB_PLATFORMS)).optional().describe("只诊断指定平台；不填表示四平台全检"),
      keywords: z.array(z.string()).optional().describe("诊断用搜索词；不填沿用 Agent开发"),
      city: z.string().optional().describe(`诊断城市；不填沿用上次采集城市或青岛。支持：${JOB_SUPPORTED_CITIES.join("、")}`),
      apply: z.boolean().optional().describe("是否固化本次真实验证通过的选择器，默认 false"),
      detail: z.number().int().min(0).max(3).optional().describe("每个平台补几条详情一起检查，默认 1；0 表示只看列表"),
    }),
  }
);

export const jobTools = [jobCollectTool, jobQueryTool, jobEnrichTool, jobGreetTool, jobGreetSaveTool, jobSummaryTool, jobDiagnoseTool];
