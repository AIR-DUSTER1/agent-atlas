/**
 * job-browser.ts — 求职 Agent 的内置采集与登录执行器
 * ============================================================
 * 直接驱动系统 Chrome/Edge，内置四平台搜索、列表解析、详情补全与持久登录态；
 * 不再查找外部 skill、Python 或脚本目录。所有浏览器操作串行并加入站点间冷却。
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { browserDisplayName, findBrowserExecutable } from "./browser-use.js";
import { parseNativeCard, parseZhilianRecords, readZhilianVueRecords } from "./job-cards.js";
import { inferCardCandidates, normalizeSelector, readCandidateCards, readCardsFromSelector, type RawJobCard } from "./job-dom.js";
import { loadJobSelectorRuntime, type JobSelectorRuntime } from "./job-selectors.js";
import {
  JOB_CITY_CODES, JOB_PLATFORM_LABELS, detectOutsourcing,
  parseWorkHours, parseWorkRest, scoreJob,
  type JobPlatform, type JobRecord, type JobSearchProfile,
} from "./job-model.js";
import { checkJobListHealth } from "./job-health.js";

const PROFILE_DIR_NAME = ".profile";
const NAV_TIMEOUT_MS = 30_000;
const MIN_NAV_GAP_MS = 2_000;
const NAV_JITTER_MS = 1_500;
const COOL_EVERY_NAV = 8;
const COOL_DELAY_MS = 7_000;
const PLATFORM_GAP_MS = 4_000;
const DETAIL_TEXT_LIMIT = 20_000;
const LOGIN_TIMEOUT_MS = 4 * 60_000 + 30_000;
/** 默认使用可见浏览器，便于用户在站点弹出安全验证时完成一次人工确认。 */
export const JOB_HEADLESS = process.env.JOB_BROWSER_HEADLESS === "1";

let operationQueue: Promise<unknown> = Promise.resolve();
let lastNavigationAt = 0;
let navigationCount = 0;

class PlatformBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformBlockedError";
  }
}

/** 诊断和采集共用的列表页地址；平台顺序不影响调用方。 */
export function jobSearchUrl(platform: JobPlatform, city: JobSearchProfile["city"], keyword: string, pageNo = 1): string {
  if (platform === "boss") {
    return `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(keyword)}&city=${JOB_CITY_CODES.boss[city]}&page=${pageNo}`;
  }
  if (platform === "zhilian") {
    return `https://www.zhaopin.com/sou/jl${JOB_CITY_CODES.zhilian[city]}/p${pageNo}?kw=${encodeURIComponent(keyword)}`;
  }
  if (platform === "job51") {
    return `https://we.51job.com/pc/search?jobArea=${JOB_CITY_CODES.job51[city]}&keyword=${encodeURIComponent(keyword)}&searchType=2&pageNum=${pageNo}`;
  }
  return `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&dq=${JOB_CITY_CODES.liepin[city]}&currentPage=${pageNo - 1}`;
}

function enqueue<T>(action: () => Promise<T>): Promise<T> {
  const run = operationQueue.then(action, action);
  operationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function getJobBrowserInfo(): { available: boolean; name: string; executable: string; error: string } {
  const executable = findBrowserExecutable();
  return {
    available: Boolean(executable),
    name: executable ? browserDisplayName(executable) : "",
    executable: executable ?? "",
    error: executable ? "" : "未找到 Chrome / Edge / Chromium；可设置 BROWSER_USE_EXECUTABLE_PATH",
  };
}

function profileDir(dataDir: string): string {
  return join(dataDir, PROFILE_DIR_NAME);
}

export async function withPersistentBrowser<T>(
  dataDir: string,
  headless: boolean,
  action: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  return enqueue(async () => {
    const executable = findBrowserExecutable();
    if (!executable) throw new Error(getJobBrowserInfo().error);
    const dir = profileDir(dataDir);
    await fsp.mkdir(dir, { recursive: true });
    const { chromium } = await import("playwright-core");
    const context = await chromium.launchPersistentContext(dir, {
      executablePath: executable,
      headless,
      locale: "zh-CN",
      viewport: { width: 1400, height: 900 },
      acceptDownloads: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    try {
      return await action(context);
    } finally {
      await context.close().catch(() => {});
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanPause(): Promise<void> {
  const now = Date.now();
  const gap = MIN_NAV_GAP_MS + Math.floor(Math.random() * NAV_JITTER_MS);
  const wait = Math.max(0, lastNavigationAt + gap - now);
  if (wait) await sleep(wait);
  navigationCount += 1;
  if (navigationCount % COOL_EVERY_NAV === 0) await sleep(COOL_DELAY_MS);
  lastNavigationAt = Date.now();
}

export async function goto(page: Page, url: string, settleMs = 2_000): Promise<void> {
  await humanPause();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  if (settleMs) await page.waitForTimeout(settleMs);
}

function blockedReason(url: string): string {
  const value = url.toLowerCase();
  if (value.includes("_security_check")) return "BOSS 安全校验";
  if (value.includes("safe.liepin.com") || value.includes("verifysms")) return "猎聘短信验证";
  if (value.includes("captcha") || value.includes("verify")) return "站点验证码";
  return "";
}

export async function pageBlockedReason(page: Page): Promise<string> {
  const fromUrl = blockedReason(page.url());
  if (fromUrl) return fromUrl;
  const title = await page.title().catch(() => "");
  if (/security verification|安全验证|验证连接安全性/i.test(title)) return "站点安全验证";
  // BOSS 虚拟列表会周期性重渲染；等待过久会让随后读到的卡片引用失效。
  const body = await page.locator("body").innerText({ timeout: 300 }).catch(() => "");
  if (/正在验证连接安全性|请勾选下方复选框|安全验证|访问验证/i.test(body.slice(0, 1_000))) return "站点安全验证";
  return "";
}

export interface NativePageRead {
  jobs: JobRecord[];
  cardCount: number;
  selector: string;
}

export interface NativeCandidateCheck {
  selector: string;
  cardCount: number;
  parsed: number;
  titleRate: number;
  linkRate: number;
  salaryRate: number;
  verified: boolean;
  sample: string;
  jobs: JobRecord[];
}

function parseRawCards(platform: JobPlatform, cards: readonly RawJobCard[], direction: string): JobRecord[] {
  return cards.map((card) => parseNativeCard(platform, card, direction)).filter((job): job is JobRecord => Boolean(job));
}

/** 读单页岗位；不在此处做自愈，诊断与采集共用这一份解析口径。 */
export async function inspectNativeJobPage(
  page: Page,
  runtime: JobSelectorRuntime,
  platform: JobPlatform,
  direction: string,
  overrideSelector = "",
): Promise<NativePageRead> {
  const read = await readCandidateCards(page, runtime, platform, overrideSelector);
  let jobs = parseRawCards(platform, read.cards, direction);
  if (platform === "zhilian") {
    const records = await readZhilianVueRecords(page, runtime.candidates(platform, "vue_host")).catch(() => []);
    const fromVue = parseZhilianRecords(records, direction);
    if (fromVue.length) jobs = fromVue;
  }
  if (platform === "boss" && jobs.length && jobs.filter((job) => job.salary).length < jobs.length * 0.6) {
    // BOSS 虚拟列表会重渲染；整批/大面积读空薪资时，重新取元素再解析一次。
    const fresh = await readCandidateCards(page, runtime, platform, overrideSelector || read.selector);
    const rescued = parseRawCards(platform, fresh.cards, direction);
    if (rescued.length && !jobs.some((job) => job.salary)) jobs = rescued;
    else {
      const byKey = new Map(rescued.map((job) => [`${job.title}|${job.company}`, job]));
      jobs = jobs.map((job) => ({ ...job, salary: job.salary || byKey.get(`${job.title}|${job.company}`)?.salary || "" }));
    }
  }
  return { jobs, cardCount: read.cards.length, selector: read.selector };
}

/** 推断并验证卡片候选；只有卡片数、标题和链接达到门槛才标记 verified。 */
export async function inferNativeCardCandidates(
  page: Page,
  runtime: JobSelectorRuntime,
  platform: JobPlatform,
  direction: string,
): Promise<NativeCandidateCheck[]> {
  const inferred = await inferCardCandidates(page, { requireLinks: platform !== "zhilian" });
  const output: NativeCandidateCheck[] = [];
  for (const candidate of inferred) {
    const cards = await readCardsFromSelector(page, candidate.selector, runtime, platform).catch(() => []);
    const jobs = parseRawCards(platform, cards, direction);
    const parsed = jobs.length;
    const titleRate = parsed ? jobs.filter((job) => Boolean(job.title)).length / parsed : 0;
    const linkRate = parsed ? jobs.filter((job) => Boolean(job.applyUrl)).length / parsed : 0;
    const salaryRate = parsed ? jobs.filter((job) => Boolean(job.salary)).length / parsed : 0;
    output.push({
      selector: candidate.selector,
      cardCount: cards.length,
      parsed,
      titleRate: Math.round(titleRate * 1000) / 1000,
      linkRate: Math.round(linkRate * 1000) / 1000,
      salaryRate: Math.round(salaryRate * 1000) / 1000,
      verified: cards.length >= 3 && titleRate >= 0.6 && (platform === "zhilian" || linkRate >= 0.6),
      sample: candidate.sample,
      jobs,
    });
  }
  return output.sort((left, right) => Number(right.verified) - Number(left.verified) || right.titleRate - left.titleRate || right.parsed - left.parsed);
}

async function recoverPageJobs(
  page: Page,
  runtime: JobSelectorRuntime,
  platform: JobPlatform,
  direction: string,
): Promise<{ read: NativePageRead; selector: string } | null> {
  const candidates = await inferNativeCardCandidates(page, runtime, platform, direction).catch(() => []);
  const best = candidates.find((candidate) => candidate.verified);
  if (!best?.jobs.length) return null;
  if (normalizeSelector(best.selector) === normalizeSelector(runtime.primary(platform, "card"))) return null;
  runtime.overrideInMemory(platform, "card", [best.selector]);
  const read = await inspectNativeJobPage(page, runtime, platform, direction, best.selector);
  return { read, selector: best.selector };
}

async function pageLooksEmpty(page: Page): Promise<boolean> {
  const text = await page.locator("body").innerText({ timeout: 300 }).catch(() => "");
  return /暂无(?:相关|匹配)?(?:职位|岗位)|没有找到(?:相关|匹配)?(?:职位|岗位)|未找到(?:相关|匹配)?(?:职位|岗位)|换个关键词|搜索结果为空/i.test(text.slice(0, 2_000));
}

type PlatformBatch = { jobs: JobRecord[]; warnings: string[] };

async function readPageForCollection(
  page: Page,
  runtime: JobSelectorRuntime,
  platform: JobPlatform,
  direction: string,
): Promise<{ read: NativePageRead; recovered: string; noResults: boolean }> {
  let read = await inspectNativeJobPage(page, runtime, platform, direction);
  const health = checkJobListHealth(platform, read.jobs, read.cardCount, { linkless: platform === "zhilian" });
  if (health.verdict === "OK") return { read, recovered: "", noResults: false };
  if (!read.jobs.length && !read.cardCount && await pageLooksEmpty(page)) {
    return { read, recovered: "", noResults: true };
  }
  const recovered = await recoverPageJobs(page, runtime, platform, direction);
  if (recovered) read = recovered.read;
  return { read, recovered: recovered?.selector ?? "", noResults: false };
}

function recoveryWarning(platform: JobPlatform, selector: string, count: number): string {
  return `${JOB_PLATFORM_LABELS[platform]}检测到结构变化，已用临时选择器 ${selector} 救回 ${count} 条；请运行「诊断并修复」固化`;
}

async function collectBoss(page: Page, runtime: JobSelectorRuntime, profile: JobSearchProfile, pages: number): Promise<PlatformBatch> {
  const city = JOB_CITY_CODES.boss[profile.city];
  const found: JobRecord[] = [];
  const warnings: string[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(keyword)}&city=${city}&page=${pageNo}`;
      await goto(page, url, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`BOSS直聘：${blocked}`);
      const read = await readPageForCollection(page, runtime, "boss", keyword);
      if (read.recovered && !warnings.some((item) => item.includes("临时选择器"))) {
        warnings.push(recoveryWarning("boss", read.recovered, read.read.jobs.length));
      }
      if (read.noResults) {
        warnings.push("BOSS直聘返回 0 条（页面显示无匹配岗位）");
        break;
      }
      if (!read.read.jobs.length) {
        if (!found.length) throw new PlatformBlockedError("BOSS直聘未登录、列表为空或结构未识别，请先登录并运行结构诊断");
        break;
      }
      found.push(...read.read.jobs);
      if (read.read.cardCount < 3) break;
    }
  }
  return { jobs: found, warnings };
}

async function collectZhilian(page: Page, runtime: JobSelectorRuntime, profile: JobSearchProfile, pages: number): Promise<PlatformBatch> {
  const jl = JOB_CITY_CODES.zhilian[profile.city];
  const found: JobRecord[] = [];
  const warnings: string[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      await goto(page, `https://www.zhaopin.com/sou/jl${jl}/p${pageNo}?kw=${encodeURIComponent(keyword)}`, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`智联招聘：${blocked}`);
      const read = await readPageForCollection(page, runtime, "zhilian", keyword);
      if (read.recovered && !warnings.some((item) => item.includes("临时选择器"))) {
        warnings.push(recoveryWarning("zhilian", read.recovered, read.read.jobs.length));
      }
      if (read.noResults) {
        warnings.push("智联招聘返回 0 条（页面显示无匹配岗位）");
        break;
      }
      if (!read.read.jobs.length) break;
      found.push(...read.read.jobs);
      if (read.read.jobs.length < 3) break;
    }
  }
  return { jobs: found, warnings };
}

async function collect51Job(page: Page, runtime: JobSelectorRuntime, profile: JobSearchProfile, pages: number): Promise<PlatformBatch> {
  const city = JOB_CITY_CODES.job51[profile.city];
  const found: JobRecord[] = [];
  const warnings: string[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      await goto(page, `https://we.51job.com/pc/search?jobArea=${city}&keyword=${encodeURIComponent(keyword)}&searchType=2&pageNum=${pageNo}`, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`前程无忧：${blocked}`);
      const read = await readPageForCollection(page, runtime, "job51", keyword);
      if (read.recovered && !warnings.some((item) => item.includes("临时选择器"))) {
        warnings.push(recoveryWarning("job51", read.recovered, read.read.jobs.length));
      }
      if (read.noResults) {
        warnings.push("前程无忧返回 0 条（页面显示无匹配岗位）");
        break;
      }
      if (!read.read.jobs.length) break;
      found.push(...read.read.jobs);
      if (read.read.jobs.length < 3) break;
    }
  }
  return { jobs: found, warnings };
}

async function collectLiepin(page: Page, runtime: JobSelectorRuntime, profile: JobSearchProfile, pages: number): Promise<PlatformBatch> {
  const dq = JOB_CITY_CODES.liepin[profile.city];
  const found: JobRecord[] = [];
  const warnings: string[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 0; pageNo < pages; pageNo += 1) {
      await goto(page, `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&dq=${dq}&currentPage=${pageNo}`, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`猎聘：${blocked}`);
      const read = await readPageForCollection(page, runtime, "liepin", keyword);
      if (read.recovered && !warnings.some((item) => item.includes("临时选择器"))) {
        warnings.push(recoveryWarning("liepin", read.recovered, read.read.jobs.length));
      }
      if (read.noResults) {
        warnings.push("猎聘返回 0 条（页面显示无匹配岗位）");
        break;
      }
      if (!read.read.jobs.length) break;
      found.push(...read.read.jobs);
      if (read.read.cardCount < 3) break;
    }
  }
  return { jobs: found, warnings };
}

function dedupeJobs(jobs: JobRecord[]): JobRecord[] {
  const seen = new Set<string>();
  const output: JobRecord[] = [];
  for (const job of jobs) {
    const key = job.applyUrl || `${job.platform}|${job.title}|${job.company}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(job);
  }
  return output;
}

export async function collectNativeJobs(
  dataDir: string,
  profile: JobSearchProfile,
  platforms: readonly JobPlatform[],
  pages: number,
): Promise<{ jobs: JobRecord[]; warnings: string[] }> {
  return withPersistentBrowser(dataDir, JOB_HEADLESS, async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    const runtime = await loadJobSelectorRuntime(dataDir);
    const jobs: JobRecord[] = [];
    const warnings: string[] = runtime.warning ? [runtime.warning] : [];
    for (const platform of platforms) {
      try {
        const batch = platform === "boss" ? await collectBoss(page, runtime, profile, pages)
          : platform === "zhilian" ? await collectZhilian(page, runtime, profile, pages)
            : platform === "job51" ? await collect51Job(page, runtime, profile, pages)
              : await collectLiepin(page, runtime, profile, pages);
        jobs.push(...batch.jobs);
        warnings.push(...batch.warnings);
        if (!batch.jobs.length && !batch.warnings.length) warnings.push(`${JOB_PLATFORM_LABELS[platform]}返回 0 条`);
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
      await sleep(PLATFORM_GAP_MS);
    }
    const scored = dedupeJobs(jobs).map((job) => {
      const outsourcing = detectOutsourcing(job.company, job.jdText, job.companyIndustry);
      return scoreJob({ ...job, ...outsourcing }, profile);
    });
    return { jobs: scored, warnings };
  });
}

const LOGIN_URLS: Record<JobPlatform, string> = {
  boss: "https://www.zhipin.com/web/user/?ka=header-login",
  zhilian: "https://passport.zhaopin.com/login",
  job51: "https://login.51job.com/login.php",
  liepin: "https://www.liepin.com/user/login/",
};

async function loginDomHit(context: BrowserContext, platform: JobPlatform, runtime: JobSelectorRuntime): Promise<boolean> {
  const pages = context.pages();
  for (const page of pages) {
    const url = page.url().toLowerCase();
    if (/login|passport|signin/.test(url)) continue;
    for (const selector of runtime.candidates(platform, "logged_in")) {
      const normalized = selector.startsWith("css:") ? selector.slice(4) : selector.startsWith("//") ? `xpath=${selector}` : selector;
      if (await page.locator(normalized).count().catch(() => 0)) return true;
    }
  }
  return false;
}

export async function loginNativeJob(platform: JobPlatform, dataDir: string): Promise<{ ok: boolean; output: string }> {
  return withPersistentBrowser(dataDir, false, async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    const runtime = await loadJobSelectorRuntime(dataDir);
    page.setDefaultTimeout(15_000);
    const before = (await context.cookies()).length;
    await page.goto(LOGIN_URLS[platform], { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      if (await loginDomHit(context, platform, runtime)) {
        return { ok: true, output: `${JOB_PLATFORM_LABELS[platform]}登录成功，登录态已保存到本地浏览器资料。` };
      }
      const cookies = await context.cookies();
      if (cookies.length > before && !/login|passport|signin|verify|captcha/i.test(page.url())) {
        return { ok: true, output: `${JOB_PLATFORM_LABELS[platform]}登录 cookie 已保存。` };
      }
    }
    return { ok: false, output: `${JOB_PLATFORM_LABELS[platform]}登录等待超时，请重新点击登录按钮。` };
  });
}

function extractSection(text: string): string {
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const start = normalized.search(/职位描述|岗位职责|工作内容|职位详情/);
  if (start < 0) return normalized.slice(0, 4_000);
  const tail = normalized.slice(start);
  const end = tail.search(/公司介绍|公司信息|企业介绍|工商信息|工作地址|职位地址/);
  return (end > 0 ? tail.slice(0, end) : tail).slice(0, 6_000);
}

/** 打开一条岗位详情并回填；诊断与 job_enrich 共用同一套字段口径。 */
export async function enrichJobInPage(page: Page, job: JobRecord, runtime: JobSelectorRuntime): Promise<boolean> {
  if (!job.applyUrl) return false;
  await goto(page, job.applyUrl, 2_000);
  const blocked = await pageBlockedReason(page);
  if (blocked) throw new PlatformBlockedError(`${job.platform}：${blocked}`);
  const text = (await page.locator("body").innerText({ timeout: 8_000 })).slice(0, DETAIL_TEXT_LIMIT);
  let jdText = "";
  if (job.platform === "猎聘") {
    const selector = normalizeSelector(runtime.primary("liepin", "jd_box"));
    jdText = selector ? await page.locator(selector).first().innerText({ timeout: 1_500 }).catch(() => "") : "";
  }
  job.jdText = jdText.trim() || extractSection(text);
  job.address ||= text.match(/(?:工作地址|上班地址|职位地址|地图完整地址)[：:]?\s*([^\n]{5,100})/)?.[1]?.trim() ?? "";
  job.hrActive ||= text.match(/(刚刚活跃|今日活跃|本周活跃|\d+\s*(?:分钟|小时|天)前活跃|\d+\s*(?:分钟|小时|天)前在线|一周前在线)/)?.[1] ?? "";
  job.hrName ||= text.match(/([\u4e00-\u9fa5]{1,3})(先生|女士)/)?.[0] ?? "";
  job.published ||= text.match(/(?:发布于|更新于)\s*(\d+\s*(?:分钟|小时|天|周|个月)前|今天|今日|昨天)/)?.[1] ?? "";
  job.companySize ||= text.match(/(少于50人|50-150人|150-500人|500-1000人|1000-5000人|5000-10000人|10000人以上|\d+-\d+人)/)?.[1] ?? "";
  job.companyIndustry ||= text.match(/(?:企业行业|行业)[：:]\s*([^\n|]{2,30})/)?.[1]?.trim() ?? "";
  job.welfare ||= text.match(/(?:福利待遇|福利)[：:]?\s*([^\n]{2,160})/)?.[1]?.trim() ?? "";
  const blob = `${job.welfare} ${job.jdText} ${text.slice(0, 4_000)}`;
  job.workRest ||= parseWorkRest(blob);
  job.workHours ||= parseWorkHours(blob);
  Object.assign(job, detectOutsourcing(job.company, job.jdText, job.companyIndustry));
  return true;
}

export async function enrichNativeJobs(
  dataDir: string,
  jobs: JobRecord[],
  limit: number,
): Promise<{ jobs: JobRecord[]; updated: number; warnings: string[] }> {
  return withPersistentBrowser(dataDir, JOB_HEADLESS, async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    const runtime = await loadJobSelectorRuntime(dataDir);
    const targets = jobs.filter((job) => job.applyUrl).slice(0, limit);
    const warnings: string[] = [];
    let updated = 0;
    for (const job of targets) {
      try {
        if (await enrichJobInPage(page, job, runtime)) updated += 1;
      } catch (err) {
        warnings.push(`${job.title}：${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof PlatformBlockedError) break;
      }
    }
    return { jobs, updated, warnings };
  });
}
