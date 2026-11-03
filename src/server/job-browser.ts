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
import {
  JOB_CITY_CODES, JOB_PLATFORM_LABELS,
  createJobRecord, decodeObfuscatedDigits, detectOutsourcing,
  parseWorkHours, parseWorkRest, scoreJob,
  type JobPlatform, type JobRecord, type JobSearchProfile,
} from "./job-model.js";

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
const JOB_HEADLESS = process.env.JOB_BROWSER_HEADLESS === "1";

let operationQueue: Promise<unknown> = Promise.resolve();
let lastNavigationAt = 0;
let navigationCount = 0;

class PlatformBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformBlockedError";
  }
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

async function withPersistentBrowser<T>(
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

async function goto(page: Page, url: string, settleMs = 2_000): Promise<void> {
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

async function pageBlockedReason(page: Page): Promise<string> {
  const fromUrl = blockedReason(page.url());
  if (fromUrl) return fromUrl;
  const title = await page.title().catch(() => "");
  if (/security verification|安全验证|验证连接安全性/i.test(title)) return "站点安全验证";
  const body = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  if (/正在验证连接安全性|请勾选下方复选框|安全验证|访问验证/i.test(body.slice(0, 1_000))) return "站点安全验证";
  return "";
}

function normalizeUrl(value: string, base: string): string {
  if (!value) return "";
  try {
    const url = new URL(value, base);
    url.search = "";
    url.hash = "";
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

type RawCard = {
  text: string;
  title: string;
  salary: string;
  href: string;
  company: string;
  tags: string[];
  payload?: Record<string, unknown>;
  companyInfo?: string[];
};

const SALARY_RE = /(\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*(?:K|k|千|万|元\/月|元\/天)|面议|\*+\s*-\s*\*+\s*元)/;

function parseCommonCard(platform: string, raw: RawCard, direction: string): JobRecord | null {
  const text = decodeObfuscatedDigits(raw.text).replace(/\r/g, "");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = decodeObfuscatedDigits(raw.title || lines[0] || "").replace(/[-\s]*\d[\d.\-]*\s*(?:[Kk]|元\/月|元\/天)?\s*$/, "").trim();
  if (!title) return null;
  const salary = decodeObfuscatedDigits(raw.salary || lines.find((line) => SALARY_RE.test(line))?.match(SALARY_RE)?.[0] || "");
  const experience = lines.find((line) => /^(经验不限|应届|\d+(?:-\d+)?年(?:以上|以内)?|在校\/应届)/.test(line)) || "";
  const education = lines.find((line) => /^(本科|硕士|博士|大专|学历不限|中专\/中技|高中)$/.test(line)) || "";
  const city = lines.find((line) => /[\u4e00-\u9fa5]{2,8}[·\s][\u4e00-\u9fa5]{2,8}/.test(line) && line.length < 45) || "";
  const company = raw.company || lines.find((line) => /(有限公司|股份有限公司|集团|科技|信息技术|网络|研究院|事务所|工作室)$/.test(line) && line.length <= 32) || "";
  const welfare = [...new Set(raw.tags.filter((tag) => /(五险|一金|双休|年假|补贴|奖金|公积金|餐|班车|住宿|培训|旅游|节日)/.test(tag)))].join("、");
  return createJobRecord(platform, {
    title, company, salary, city, experience, education,
    applyUrl: normalizeUrl(raw.href, ""), welfare,
    workRest: parseWorkRest(`${welfare} ${text}`),
    workHours: parseWorkHours(`${welfare} ${text}`),
    direction,
  });
}

async function readZhilianVue(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    type VueLike = { $props?: { list?: unknown[] } };
    type HostLike = HTMLElement & { __vue__?: VueLike };
    const card = document.querySelector<HTMLElement>(".job-card");
    let node = card?.parentElement as HostLike | null;
    let vm: VueLike | undefined = node?.__vue__;
    for (let depth = 0; !vm?.$props?.list && node && depth < 7; depth += 1) {
      node = node.parentElement as HostLike | null;
      vm = node?.__vue__;
    }
    const list = vm?.$props?.list;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").map((item) => {
      const x = item as Record<string, unknown>;
      const welfare = Array.isArray(x.welfareLabel)
        ? x.welfareLabel.map((tag) => typeof tag === "string" ? tag : String((tag as Record<string, unknown>)?.name ?? (tag as Record<string, unknown>)?.label ?? "")).filter(Boolean)
        : [];
      return {
        name: x.name, url: x.positionURL || x.positionUrl || "", publish: x.publishTime || x.firstPublishTime || "",
        salary60: x.salary60 || "", salaryReal: x.salaryReal || "", company: x.companyName || "",
        size: x.companySize || "", industry: x.industryName || "", financing: x.financingStage || "",
        city: x.workCity || "", district: x.cityDistrict || "", exp: x.workingExp || "", edu: x.education || "",
        welfare, jd: x.jobDescription || "",
      };
    });
  });
}

async function cardsRaw(page: Page, selector: string): Promise<RawCard[]> {
  return page.locator(selector).evaluateAll((nodes) => nodes.map((node) => {
    const el = node as HTMLElement;
    const link = el.querySelector<HTMLAnchorElement>('a[href*="/job_detail"],a[href*="job"],a[href]');
    const title = el.querySelector<HTMLElement>(".job-name,.job-title,[class*='job-name'],[class*='job-title']")?.innerText || "";
    const salary = el.querySelector<HTMLElement>(".job-salary,.salary,[class*='salary']")?.innerText || "";
    const company = el.querySelector<HTMLElement>(".company-name,.cname,[class*='company-name']")?.innerText || "";
    const tags = [...el.querySelectorAll<HTMLElement>(".tag,.tag-list span,[class*='tag'] span")]
      .map((tag) => (tag.innerText || "").trim()).filter(Boolean).slice(0, 20);
    return { text: el.innerText || "", title, salary, href: link?.href || "", company, tags };
  }));
}

async function collectBoss(page: Page, profile: JobSearchProfile, pages: number): Promise<JobRecord[]> {
  const city = JOB_CITY_CODES.boss[profile.city];
  const found: JobRecord[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(keyword)}&city=${city}&page=${pageNo}`;
      await goto(page, url, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`BOSS直聘：${blocked}`);
      const raw = await cardsRaw(page, ".job-card-wrap");
      if (!raw.length) throw new PlatformBlockedError("BOSS直聘未登录或列表为空，请先在求职数据源面板登录 BOSS直聘");
      for (const item of raw) {
        const job = parseCommonCard("BOSS直聘", item, keyword);
        if (job) found.push(job);
      }
      if (raw.length < 3) break;
    }
  }
  return found;
}

async function collectZhilian(page: Page, profile: JobSearchProfile, pages: number): Promise<JobRecord[]> {
  const jl = JOB_CITY_CODES.zhilian[profile.city];
  const found: JobRecord[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      await goto(page, `https://www.zhaopin.com/sou/jl${jl}/p${pageNo}?kw=${encodeURIComponent(keyword)}`, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`智联招聘：${blocked}`);
      const records = await readZhilianVue(page).catch(() => []);
      if (records.length) {
        for (const record of records) {
          const title = String(record.name ?? "").trim();
          if (!title) continue;
          const real = String(record.salaryReal ?? "");
          const salary = String(record.salary60 ?? "") || (() => {
            const match = real.match(/^(\d+)-(\d+)$/);
            return match ? `${Number(match[1]) / 1000}-${Number(match[2]) / 1000}K` : "";
          })();
          const jdText = String(record.jd ?? "");
          const company = String(record.company ?? "").trim() || "（智联未披露）";
          const industry = String(record.industry ?? "");
          const city = String(record.city ?? "");
          const district = String(record.district ?? "");
          found.push(createJobRecord("智联招聘", {
            title, company, salary, city: district ? `${city}·${district}` : city,
            experience: String(record.exp ?? ""), education: String(record.edu ?? ""),
            companySize: String(record.size ?? ""), companyIndustry: industry,
            companyFinancing: String(record.financing ?? ""), published: String(record.publish ?? ""),
            applyUrl: normalizeUrl(String(record.url ?? ""), "https://www.zhaopin.com"), jdText,
            welfare: Array.isArray(record.welfare) ? record.welfare.map(String).join("、") : "",
            workRest: parseWorkRest(`${String(record.welfare ?? "")} ${jdText}`),
            workHours: parseWorkHours(`${String(record.welfare ?? "")} ${jdText}`),
            direction: keyword,
          }));
        }
      } else {
        const raw = await cardsRaw(page, ".job-card,[class*='joblist-box__item']");
        for (const item of raw) {
          const job = parseCommonCard("智联招聘", item, keyword);
          if (job) found.push(job);
        }
      }
      if (records.length < 3 && found.length > 0) break;
    }
  }
  return found;
}

async function collect51Job(page: Page, profile: JobSearchProfile, pages: number): Promise<JobRecord[]> {
  const city = JOB_CITY_CODES.job51[profile.city];
  const found: JobRecord[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      await goto(page, `https://we.51job.com/pc/search?jobArea=${city}&keyword=${encodeURIComponent(keyword)}&searchType=2&pageNum=${pageNo}`, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`前程无忧：${blocked}`);
      const raw = await page.locator(".joblist-item").evaluateAll((nodes) => nodes.map((node) => {
        const el = node as HTMLElement;
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse((el.getAttribute("sensorsdata") || el.querySelector("[sensorsdata]")?.getAttribute("sensorsdata") || "{}")) as Record<string, unknown>; } catch { /* 页面字段异常时退回文本解析 */ }
        const link = el.querySelector<HTMLAnchorElement>('a[href*="jobs.51job.com"],a[href]');
        const company = el.querySelector<HTMLElement>("a.comp .cname,.cname")?.innerText || "";
        const companyInfo = [...el.querySelectorAll<HTMLElement>("a.comp .dc")].map((node) => node.innerText.trim()).filter(Boolean);
        const tags = [...el.querySelectorAll<HTMLElement>(".tag")].map((tag) => tag.innerText.trim()).filter(Boolean);
        return { text: el.innerText || "", title: String(payload.jobTitle || ""), salary: String(payload.jobSalary || ""), href: link?.href || "", company, tags, companyInfo, payload };
      }));
      for (const item of raw) {
        const job = parseCommonCard("前程无忧", item, keyword);
        if (!job) continue;
        const payload = item.payload ?? {};
        job.city = String(payload.jobArea || job.city);
        job.experience = String(payload.jobYear || job.experience);
        job.education = String(payload.jobDegree || job.education);
        job.published = String(payload.jobTime || "");
        job.companyIndustry = item.companyInfo?.find((value) => !/人|民营|外资|国企|合资|上市|创业|事业/.test(value)) || "";
        job.companySize = item.companyInfo?.find((value) => /人|以上/.test(value)) || "";
        job.companyFinancing = item.companyInfo?.find((value) => /民营|外资|国企|合资|上市|创业|事业/.test(value)) || "";
        const jobId = String(payload.jobId || "");
        if (jobId) job.applyUrl = `https://jobs.51job.com/all/${jobId}.html`;
        found.push(job);
      }
    }
  }
  return found;
}

async function collectLiepin(page: Page, profile: JobSearchProfile, pages: number): Promise<JobRecord[]> {
  const dq = JOB_CITY_CODES.liepin[profile.city];
  const found: JobRecord[] = [];
  for (const keyword of profile.keywords) {
    for (let pageNo = 0; pageNo < pages; pageNo += 1) {
      await goto(page, `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}&dq=${dq}&currentPage=${pageNo}`, 2_500);
      const blocked = await pageBlockedReason(page);
      if (blocked) throw new PlatformBlockedError(`猎聘：${blocked}`);
      const raw = await cardsRaw(page, ".jobDetailBox");
      for (const item of raw) {
        const job = parseCommonCard("猎聘", item, keyword);
        if (job) {
          job.company ||= "（猎聘未披露）";
          found.push(job);
        }
      }
      if (raw.length < 3) break;
    }
  }
  return found;
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
    const jobs: JobRecord[] = [];
    const warnings: string[] = [];
    for (const platform of platforms) {
      try {
        const batch = platform === "boss" ? await collectBoss(page, profile, pages)
          : platform === "zhilian" ? await collectZhilian(page, profile, pages)
            : platform === "job51" ? await collect51Job(page, profile, pages)
              : await collectLiepin(page, profile, pages);
        jobs.push(...batch);
        if (!batch.length) warnings.push(`${JOB_PLATFORM_LABELS[platform]}返回 0 条`);
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

const LOGIN_SELECTORS: Record<JobPlatform, string[]> = {
  boss: [".nav-figure", ".user-nav .figure", ".header-user"],
  zhilian: [".user-info", ".user-head", ".header-user", "[class*='userInfo']"],
  job51: [".uname", ".user-name", ".header-user", "[class*='userName']"],
  liepin: [".user-info", ".user-name", ".header-user", "[class*='userInfo']"],
};

async function loginDomHit(context: BrowserContext, platform: JobPlatform): Promise<boolean> {
  const pages = context.pages();
  for (const page of pages) {
    const url = page.url().toLowerCase();
    if (/login|passport|signin/.test(url)) continue;
    for (const selector of LOGIN_SELECTORS[platform]) {
      if (await page.locator(selector).count().catch(() => 0)) return true;
    }
  }
  return false;
}

export async function loginNativeJob(platform: JobPlatform, dataDir: string): Promise<{ ok: boolean; output: string }> {
  return withPersistentBrowser(dataDir, false, async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15_000);
    const before = (await context.cookies()).length;
    await page.goto(LOGIN_URLS[platform], { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      if (await loginDomHit(context, platform)) {
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

export async function enrichNativeJobs(
  dataDir: string,
  jobs: JobRecord[],
  limit: number,
): Promise<{ jobs: JobRecord[]; updated: number; warnings: string[] }> {
  return withPersistentBrowser(dataDir, JOB_HEADLESS, async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    const targets = jobs.filter((job) => job.applyUrl).slice(0, limit);
    const warnings: string[] = [];
    let updated = 0;
    for (const job of targets) {
      try {
        await goto(page, job.applyUrl, 2_000);
        const blocked = await pageBlockedReason(page);
        if (blocked) {
          warnings.push(`${job.platform}：${blocked}`);
          break;
        }
        const text = (await page.locator("body").innerText({ timeout: 8_000 })).slice(0, DETAIL_TEXT_LIMIT);
        job.jdText = extractSection(text);
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
        updated += 1;
      } catch (err) {
        warnings.push(`${job.title}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { jobs, updated, warnings };
  });
}
