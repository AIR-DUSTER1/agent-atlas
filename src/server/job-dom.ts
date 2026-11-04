/**
 * job-dom.ts — 招聘列表的候选链读取与结构推断
 * ============================================================
 * 卡片字段从注册表候选链按序命中并记录 fallback；容器完全失效时按
 * “重复块 + 文本像岗位 +（需要时）含链接”推断候选，不写站点硬编码。
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import type { JobPlatform } from "./job-model.js";
import type { JobSelectorRuntime } from "./job-selectors.js";

type SelectorScope = Page | Locator;

export interface RawJobCard {
  text: string;
  title: string;
  salary: string;
  href: string;
  company: string;
  companyUrl: string;
  tags: string[];
  payload?: Record<string, unknown>;
  companyInfo?: string[];
}

export interface CandidateCardRead {
  selector: string;
  cards: RawJobCard[];
}

export interface InferredCardCandidate {
  selector: string;
  count: number;
  matches: number;
  withLink: number;
  texty: number;
  keywordHit: number;
  depth: number;
  score: number;
  sample: string;
}

interface CardFieldConfig {
  platform: JobPlatform;
  title: string[];
  salary: string[];
  link: string[];
  company: string[];
  companyLink: string[];
  tags: string[];
  payload: string[];
  companyInfo: string[];
}

/** 把静态浏览器表达式编译成无 tsx 名称注入的普通函数。 */
function compileBrowserExpression<TResult, TArg>(source: string): (arg: TArg) => TResult {
  return new Function("arg", `return (${source})(arg);`) as (arg: TArg) => TResult;
}

export function normalizeSelector(selector: string): string {
  const value = selector.trim();
  if (value.startsWith("css:")) return value.slice(4).trim();
  if (value.startsWith("tag:")) return value.slice(4).trim();
  if (value.startsWith("//")) return `xpath=${value}`;
  return value;
}

function cardFields(runtime: JobSelectorRuntime, platform: JobPlatform): CardFieldConfig {
  const get = (key: string): string[] => runtime.candidates(platform, key).map(normalizeSelector);
  return {
    platform,
    title: get("card_title"),
    salary: get("card_salary"),
    link: get("card_link"),
    company: get("company_name").concat(get("card_footer")),
    companyLink: get("card_company_link").concat(get("company_link")),
    tags: get("card_tags").concat(get("tags")).concat(get("card_skill_tags")),
    payload: get("card_payload"),
    companyInfo: get("company_info"),
  };
}

/** 按候选链找容器；命中后备项会写进运行时统计。 */
export async function findCardSelector(
  scope: SelectorScope,
  runtime: JobSelectorRuntime,
  platform: JobPlatform,
  overrideSelector = "",
): Promise<string> {
  const chain = overrideSelector ? [overrideSelector] : runtime.candidates(platform, "card");
  for (const candidate of chain) {
    const selector = normalizeSelector(candidate);
    const count = await scope.locator(selector).count().catch(() => 0);
    if (count > 0) {
      if (!overrideSelector) runtime.recordHit(platform, "card", true, candidate);
      return selector;
    }
  }
  if (!overrideSelector) runtime.recordHit(platform, "card", false);
  return "";
}

/**
 * Playwright 会把回调源码注入页面执行；tsx/esbuild 的 keepNames 可能给回调内
 * 函数加 `__name` 而在页面里未定义。这里用字符串表达式绕开编译注入。
 */
const READ_CARDS_EXPRESSION = String.raw`(config) => {
  const textOf = function (el, chain) {
    for (const selector of chain) {
      try {
        const node = el.querySelector(selector);
        const text = (node && (node.innerText || node.textContent) || "").trim();
        if (text) return text;
      } catch (error) {}
    }
    return "";
  };
  const hrefOf = function (el, chain) {
    for (const selector of chain) {
      try {
        const node = el.querySelector(selector);
        if (node && node.href) return node.href;
      } catch (error) {}
    }
    return "";
  };
  const textsOf = function (el, chain) {
    for (const selector of chain) {
      try {
        const values = Array.from(el.querySelectorAll(selector)).map(function (node) {
          return (node.innerText || node.textContent || "").trim();
        }).filter(Boolean);
        if (values.length) return values.slice(0, 30);
      } catch (error) {}
    }
    return [];
  };
  const payloadOf = function (el) {
    for (const selector of config.fields.payload) {
      try {
        const node = el.matches(selector) ? el : el.querySelector(selector);
        const raw = node && node.getAttribute("sensorsdata") || "";
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      } catch (error) {}
    }
    return {};
  };
  const nodes = config.selector ? document.querySelectorAll(config.selector) : [];
  return Array.from(nodes).map(function (el) {
    return {
      text: el.innerText || "",
      title: textOf(el, config.fields.title),
      salary: textOf(el, config.fields.salary),
      href: hrefOf(el, config.fields.link),
      company: textOf(el, config.fields.company),
      companyUrl: hrefOf(el, config.fields.companyLink),
      tags: textsOf(el, config.fields.tags),
      payload: payloadOf(el),
      companyInfo: textsOf(el, config.fields.companyInfo),
    };
  });
}`;

async function readCardsBySelector(
  page: Page,
  selector: string,
  fields: CardFieldConfig,
): Promise<RawJobCard[]> {
  if (!selector) return [];
  return page.evaluate(
    compileBrowserExpression<RawJobCard[], { selector: string; fields: CardFieldConfig }>(READ_CARDS_EXPRESSION),
    { selector, fields },
  );
}

/** 读注册表首选/候选容器；overrideSelector 用于诊断或临时自愈后的重试。 */
export async function readCandidateCards(
  page: Page,
  runtime: JobSelectorRuntime,
  platform: JobPlatform,
  overrideSelector = "",
): Promise<CandidateCardRead> {
  const selector = await findCardSelector(page, runtime, platform, overrideSelector);
  const cards = await readCardsBySelector(page, selector, cardFields(runtime, platform));
  return { selector: selector ? (overrideSelector || `css:${selector}`) : "", cards };
}

export async function readCardsFromSelector(page: Page, selector: string, runtime: JobSelectorRuntime, platform: JobPlatform): Promise<RawJobCard[]> {
  return readCardsBySelector(page, normalizeSelector(selector), cardFields(runtime, platform));
}

/** 纯结构推断：站点改版后不依赖旧 class，先找出反复出现的职位列表块。 */
const INFER_CARD_EXPRESSION = String.raw`(input) => {
  const keywords = ["招聘", "K", "k", "薪", "年", "本科", "大专", "经验", "公司"];
  const exclude = /nav|footer|header|menu|crumb|sidebar|breadcrumb|pagination|pager|toolbar|tab-|advert|banner|slogan|copyright|login|register|filter|select-box|dropdown|popover|modal|dialog|toast|skeleton|loading|placeholder/i;
  const groups = new Map();
  const depthOf = function (el) {
    let value = 0;
    let node = el.parentElement;
    while (node) { value += 1; node = node.parentElement; }
    return value;
  };
  const classesOf = function (el) {
    return (typeof el.className === "string" ? el.className : "")
      .split(/\s+/).filter(Boolean).map(function (item) { return item.replace(/[-_]?\d+$/, ""); })
      .filter(function (item) { return item.length > 2; });
  };
  for (const node of document.querySelectorAll("body *")) {
    const cls = (typeof node.className === "string" ? node.className : "").trim();
    if (!cls || exclude.test(cls)) continue;
    const parts = classesOf(node);
    if (!parts.length) continue;
    const signature = node.tagName.toLowerCase() + "." + Array.from(new Set(parts)).sort().join(".");
    const bucket = groups.get(signature) || [];
    bucket.push(node);
    groups.set(signature, bucket);
  }
  const results = [];
  for (const entry of groups) {
    const signature = entry[0];
    const elements = entry[1];
    if (elements.length < input.minRepeat || elements.length > input.maxRepeat) continue;
    const first = elements[0];
    const level = depthOf(first);
    if (level < 2) continue;
    let withLink = 0;
    let texty = 0;
    let keywordHit = 0;
    let sample = "";
    for (let index = 0; index < elements.length; index += 1) {
      const el = elements[index];
      if (el.querySelector("a[href]")) withLink += 1;
      const text = (el.innerText || "").trim();
      if (text.length >= 20 && text.length <= 2000) texty += 1;
      if (index === 0) sample = text.slice(0, 120);
      if (keywords.some(function (word) { return text.indexOf(word) >= 0; })) keywordHit += 1;
    }
    if (!texty || (input.requireLinks && withLink < elements.length * 0.5)) continue;
    const parts = classesOf(first);
    const tag = first.tagName.toLowerCase();
    const classPart = parts[0] || "";
    let selector = classPart ? tag + "." + CSS.escape(classPart) : tag;
    let matches = 0;
    try { matches = document.querySelectorAll(selector).length; } catch (error) { matches = 0; }
    if (!matches && classPart) {
      selector = tag + '[class^="' + classPart.replaceAll("'", "") + '"]';
      try { matches = document.querySelectorAll(selector).length; } catch (error) { matches = 0; }
    }
    if (!matches || matches < elements.length * 0.5) continue;
    let score = elements.length * (texty / elements.length);
    if (input.requireLinks) score *= withLink / elements.length;
    score *= 1 + keywordHit / elements.length;
    results.push({ selector: "css:" + selector, signature, count: elements.length, matches, withLink, texty, keywordHit, depth: level, score, sample });
  }
  results.sort(function (left, right) { return Number(right.score) - Number(left.score); });
  return results.slice(0, input.limit);
}`;

export async function inferCardCandidates(
  page: Page,
  options: { minRepeat?: number; maxRepeat?: number; limit?: number; requireLinks?: boolean } = {},
): Promise<InferredCardCandidate[]> {
  const raw = await page.evaluate(
    compileBrowserExpression<Array<Record<string, unknown>>, {
      minRepeat: number; maxRepeat: number; limit: number; requireLinks: boolean;
    }>(INFER_CARD_EXPRESSION),
    {
    minRepeat: options.minRepeat ?? 6,
    maxRepeat: options.maxRepeat ?? 80,
    limit: options.limit ?? 6,
    requireLinks: options.requireLinks ?? true,
    },
  );
  return raw.map((item) => ({
    selector: String(item.selector ?? ""),
    count: Number(item.count ?? 0),
    matches: Number(item.matches ?? 0),
    withLink: Number(item.withLink ?? 0),
    texty: Number(item.texty ?? 0),
    keywordHit: Number(item.keywordHit ?? 0),
    depth: Number(item.depth ?? 0),
    score: Number(item.score ?? 0),
    sample: String(item.sample ?? ""),
  })).filter((item) => item.selector.startsWith("css:"));
}

export async function snapshotJobPage(page: Page, platform: JobPlatform, outDir: string): Promise<Record<string, string>> {
  await fsp.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "_").replace(/\..+/, "");
  const output: Record<string, string> = {};
  try {
    const htmlPath = join(outDir, `${platform}_${stamp}.html`);
    await fsp.writeFile(htmlPath, await page.content(), "utf8");
    output.html = htmlPath;
  } catch { /* 快照失败不阻塞诊断结论 */ }
  try {
    const screenshotPath = join(outDir, `${platform}_${stamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    output.screenshot = screenshotPath;
  } catch { /* 同上 */ }
  return output;
}
