/**
 * job-cards.ts — 招聘列表卡片到领域模型的纯转换层
 * ============================================================
 * DOM 读取只负责产出 RawJobCard；本文件统一处理 BOSS/智联/51/猎聘的
 * 文本差异、Vue 列表与 51job sensorsdata，方便采集和结构诊断共用同一解析器。
 */
import type { Page } from "playwright-core";
import type { RawJobCard } from "./job-dom.js";
import {
  createJobRecord, decodeObfuscatedDigits, parseWorkHours, parseWorkRest,
  type JobPlatform, type JobRecord,
} from "./job-model.js";

const SALARY_RE = /(\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*(?:K|k|千|万|元\/月|元\/天)|面议|\*+\s*-\s*\*+\s*元)/;
const WELFARE_RE = /(五险|一金|公积金|保险|年假|双休|单休|大小周|体检|餐|补贴|奖金|期权|股票|股权|培训|旅游|班车|住宿|宿舍|节日|假期|法定|零食|下午茶|团建|弹性|调休|福利|关怀|礼金)/;

function normalizeUrl(value: string, base: string): string {
  if (!value) return "";
  try {
    const url = base ? new URL(value, base) : new URL(value);
    url.search = "";
    url.hash = "";
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function stripTitle(value: string): string {
  return decodeObfuscatedDigits(value)
    .replace(/[-\s]*\d[\d.\-]*\s*(?:[Kk]|元\/月|元\/天)?\s*$/, "")
    .trim();
}

function linesOf(raw: RawJobCard): string[] {
  return decodeObfuscatedDigits(raw.text).replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
}

/** 卡片文本统一解析；字段仍保留平台原始语义，不在 UI 前做评分。 */
export function parseNativeCard(platform: JobPlatform, raw: RawJobCard, direction: string): JobRecord | null {
  const lines = linesOf(raw);
  const title = stripTitle(raw.title || lines[0] || "");
  if (!title) return null;
  const salary = decodeObfuscatedDigits(raw.salary || lines.find((line) => SALARY_RE.test(line))?.match(SALARY_RE)?.[0] || "");
  const experience = lines.map((line) => line.match(/经验不限|应届|在校|\d+(?:-\d+)?年(?:以上|以内)?/)?.[0] ?? "").find(Boolean) || "";
  const education = lines.map((line) => line.match(/统招本科|本科|硕士|博士|大专|学历不限|中专|高中|初中/)?.[0] ?? "").find(Boolean) || "";
  const cityLine = lines.find((line) => (line.includes("·") || /【[^】]+】|[\u4e00-\u9fa5]{2,8}\s+[\u4e00-\u9fa5]{2,8}/.test(line)) && line.length < 50) || "";
  const bracketedCity = cityLine.match(/【([^】]+)】/)?.[1]?.replaceAll("-", "·") ?? "";
  const city = bracketedCity || cityLine.split(/\s+/).filter(Boolean).slice(0, 1).join("");
  const company = raw.company.trim() || lines.find((line) => /(有限公司|股份有限公司|集团|科技|信息技术|网络|研究院|事务所|工作室)$/.test(line) && line.length <= 34) || "";
  const tags = raw.tags.map((tag) => decodeObfuscatedDigits(tag).trim()).filter(Boolean);
  const welfare = [...new Set(tags.filter((tag) => WELFARE_RE.test(tag)))].join("、");
  const job = createJobRecord(platform === "boss" ? "BOSS直聘" : platform === "zhilian" ? "智联招聘" : platform === "job51" ? "前程无忧" : "猎聘", {
    title,
    company: platform === "liepin" ? company || "（猎聘未披露）" : company,
    salary,
    city,
    experience,
    education,
    applyUrl: normalizeUrl(raw.href, ""),
    companyUrl: normalizeUrl(raw.companyUrl, ""),
    welfare,
    workRest: parseWorkRest(`${welfare} ${raw.text}`),
    workHours: parseWorkHours(`${welfare} ${raw.text}`),
    direction,
  });
  if (platform === "job51") applyJob51Payload(job, raw);
  return job;
}

function applyJob51Payload(job: JobRecord, raw: RawJobCard): void {
  const payload = raw.payload ?? {};
  job.city = String(payload.jobArea || job.city);
  job.experience = String(payload.jobYear || job.experience);
  job.education = String(payload.jobDegree || job.education);
  job.published = String(payload.jobTime || job.published || "");
  job.companyIndustry = raw.companyInfo?.find((value) => !/人|民营|外资|国企|合资|上市|创业|事业/.test(value)) || job.companyIndustry;
  job.companySize = raw.companyInfo?.find((value) => /人|以上/.test(value)) || job.companySize;
  job.companyFinancing = raw.companyInfo?.find((value) => /民营|外资|国企|合资|上市|创业|事业/.test(value)) || job.companyFinancing;
  const jobId = String(payload.jobId || "");
  if (jobId) job.applyUrl = `https://jobs.51job.com/all/${jobId}.html`;
}

const READ_ZHILIAN_EXPRESSION = String.raw`(selectors) => {
  let node = null;
  for (const selector of selectors) {
    try {
      const hit = document.querySelector(selector);
      if (hit) { node = hit; break; }
    } catch (error) {}
  }
  let vm = node && node.__vue__;
  for (let depth = 0; !(vm && vm.$props && vm.$props.list) && node && depth < 8; depth += 1) {
    node = node.parentElement;
    vm = node && node.__vue__;
  }
  const list = vm && vm.$props && vm.$props.list;
  if (!Array.isArray(list)) return [];
  return list.filter(function (item) { return Boolean(item) && typeof item === "object"; }).map(function (value) {
    const welfare = Array.isArray(value.welfareLabel)
      ? value.welfareLabel.map(function (tag) {
        return typeof tag === "string" ? tag : String(tag && (tag.name || tag.label) || "");
      }).filter(Boolean)
      : [];
    return {
      name: value.name,
      url: value.positionURL || value.positionUrl || "",
      publish: value.publishTime || value.firstPublishTime || "",
      salary60: value.salary60 || "",
      salaryReal: value.salaryReal || "",
      company: value.companyName || "",
      size: value.companySize || "",
      industry: value.industryName || "",
      financing: value.financingStage || "",
      city: value.workCity || "",
      district: value.cityDistrict || "",
      exp: value.workingExp || "",
      edu: value.education || "",
      skills: Array.isArray(value.jobSkillTags) ? value.jobSkillTags.map(function (tag) { return tag && tag.name; }).filter(Boolean) : [],
      welfare,
      jd: value.jobDescription || "",
    };
  });
}`;

/** 智联优先读 Vue 数据：字段更全且有详情链接，卡片 DOM 只做兜底与健康检查。 */
export async function readZhilianVueRecords(page: Page, hostSelectors: readonly string[]): Promise<Record<string, unknown>[]> {
  const hosts = hostSelectors.map((item) => item.startsWith("css:") ? item.slice(4) : item).filter(Boolean);
  const expression = new Function("selectors", `return (${READ_ZHILIAN_EXPRESSION})(selectors);`) as (selectors: string[]) => Record<string, unknown>[];
  return page.evaluate(expression, hosts);
}

export function parseZhilianRecords(records: readonly Record<string, unknown>[], direction: string): JobRecord[] {
  const output: JobRecord[] = [];
  for (const record of records) {
    const title = String(record.name ?? "").trim();
    if (!title) continue;
    const real = String(record.salaryReal ?? "");
    const salary = String(record.salary60 ?? "") || (() => {
      const match = real.match(/^(\d+)-(\d+)$/);
      return match ? `${Number(match[1]) / 1000}-${Number(match[2]) / 1000}K` : "";
    })();
    const jdText = String(record.jd ?? "").trim();
    const city = String(record.city ?? "");
    const district = String(record.district ?? "");
    const welfare = Array.isArray(record.welfare) ? record.welfare.map(String).join("、") : "";
    output.push(createJobRecord("智联招聘", {
      title,
      company: String(record.company ?? "").trim() || "（智联未披露）",
      salary,
      city: district ? `${city}·${district}` : city,
      experience: String(record.exp ?? ""),
      education: String(record.edu ?? ""),
      companySize: String(record.size ?? ""),
      companyIndustry: String(record.industry ?? ""),
      companyFinancing: String(record.financing ?? ""),
      published: String(record.publish ?? ""),
      applyUrl: normalizeUrl(String(record.url ?? ""), "https://www.zhaopin.com"),
      jdText,
      welfare,
      workRest: parseWorkRest(`${welfare} ${jdText}`),
      workHours: parseWorkHours(`${welfare} ${jdText}`),
      direction,
    }));
  }
  return output;
}
