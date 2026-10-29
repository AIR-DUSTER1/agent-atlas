/**
 * tools-web.ts — 网页内容抓取工具（通用 Agent 的「看网页」能力）
 *
 * browser_fetch：打开一个 URL，把 HTML 转成纯文本返回给模型——查官方文档、
 * 读 release notes、看线上报错页这类高频刚需。
 *
 * 与 computer_* 的分工：
 *   - computer_screenshot/click 是「像素级桌面控制」，适合操作本机 GUI；
 *   - browser_fetch 是「语义级网页读取」，只取正文，不需要开浏览器窗口；
 *   - 两者都不能执行页面 JS：这里是纯 HTTP GET + 静态剥离标签。
 *
 * 安全设计（SSRF 是本工具唯一的真实风险面）：
 *   - 只放行 http/https（禁 file: / data: / ftp: 等）；
 *   - 默认**拒绝**内网/环回/链路本地地址（169.254 云元数据是典型攻击目标）；
 *     本机 RAG / mock 服务确实可能要用 —— 通过 allowLocalhost 显式放行；
 *   - 手动跟随重定向并逐跳复查目标地址，避免「公网地址 302 到 127.0.0.1」绕过；
 *   - 只读工具，不登记审批（AGENTS.md §5.4：只读类直接执行）。
 *
 * 输出形态（JSON 字符串）：{ url, finalUrl, title, text, truncated, note }
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { PRODUCT_USER_AGENT } from "./product.js";

/** 抓取超时：网页比 API 慢，但仍要防挂死 */
const FETCH_TIMEOUT_MS = 15_000;
/** 返回给模型的正文上限（字符）：留出上下文预算，超长截断并提示分段 */
const TEXT_LIMIT = 8_000;
/** 单次响应体读取上限（字节）：防止超大页面吃内存 */
const BODY_LIMIT = 4_000_000;
/** 重定向最多跟随次数（逐跳校验，防 302 绕过内网限制） */
const MAX_REDIRECTS = 5;

/** 内网 / 环回 / 链路本地判定：命中即拒绝（除非 allowLocalhost） */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  // IPv4 字面量
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 云元数据 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 唯一的本地/链路本地前缀
  if (/^f[cd]/.test(host) || /^fe80:/.test(host)) return true;
  // 单标签主机名（如 "intranet"）可能是内网 DNS
  if (!host.includes(".") && !host.includes(":")) return true;
  return false;
}

/** 校验并规范化 URL；不安全时抛中文错误（模型会转述给用户） */
function assertFetchable(raw: string, allowLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("URL 格式不合法：需要完整地址，例如 https://example.com/docs");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的协议 ${url.protocol}：只允许 http / https`);
  }
  if (!allowLocalhost && isPrivateHost(url.hostname)) {
    throw new Error(
      `拒绝访问内网地址 ${url.hostname}：出于安全考虑默认禁止（防 SSRF）。` +
      "如果确实要读本机或局域网服务，请把 allowLocalhost 设为 true。"
    );
  }
  return url;
}

/** 剥 script/style/注释，再把标签换成换行 —— 零依赖的「HTML 转文本」 */
function htmlToText(html: string): string {
  let s = html;
  // 整个 <head> 先丢掉：title/style/meta/script 对正文无用，
  // 留下 title 文字还会混进正文（模型会把它当成第一段内容）
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  // 整块丢弃（内容对模型无用且噪声最大）
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // 块级标签换行，行内标签保留空格，避免单词黏连
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  // 实体解码（只处理最常见的几个，够读文档）
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  // 折叠空白：连续空行压成一个，行内多空格压成一个
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line, i, arr) => line || (i > 0 && arr[i - 1]))
    .join("\n")
    .trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return m[1].replace(/\s+/g, " ").trim().slice(0, 200);
}

/** 读取响应体，超过字节上限即停止（不下载完整个大文件） */
async function readCapped(res: Response, limitBytes: number): Promise<{ text: string; capped: boolean }> {
  const body = res.body;
  if (!body) return { text: "", capped: false };
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) {
        text += decoder.decode(value, { stream: true });
        return { text, capped: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, capped: false };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

interface FetchOutcome {
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
  capped: boolean;
}

/** 手动跟随重定向：每一跳都重新校验目标地址（防 302 打进内网） */
async function fetchWithRedirects(start: URL, allowLocalhost: boolean): Promise<FetchOutcome> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // 有些站点直接拒绝空 UA
        "User-Agent": `${PRODUCT_USER_AGENT} (+local agent tools)`,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`网关返回 ${res.status} 重定向但没有 Location 头`);
      const next = new URL(location, current);
      // 关键：逐跳复查，不能信任第一跳的校验结果
      assertFetchable(next.href, allowLocalhost);
      current = next;
      continue;
    }

    if (!res.ok) {
      throw new Error(`抓取失败：HTTP ${res.status}${res.status === 404 ? "（页面不存在）" : ""}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const { text: raw, capped } = await readCapped(res, BODY_LIMIT);

    // 纯文本 / JSON 直接返回；HTML 才剥标签
    if (/^text\/plain|^application\/json/i.test(contentType)) {
      const text = raw.slice(0, TEXT_LIMIT);
      return {
        finalUrl: current.href,
        title: "",
        text,
        truncated: raw.length > TEXT_LIMIT,
        capped,
      };
    }
    if (!/html|xml/i.test(contentType) && contentType) {
      throw new Error(`不支持的内容类型 ${contentType}（只处理 HTML / 纯文本 / JSON）`);
    }

    const title = extractTitle(raw);
    const full = htmlToText(raw);
    const text = full.slice(0, TEXT_LIMIT);
    return { finalUrl: current.href, title, text, truncated: full.length > TEXT_LIMIT, capped };
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次，已停止（可能是循环跳转）`);
}

export const browserFetch = tool(
  async ({ url, allowLocalhost }) => {
    try {
      const target = assertFetchable(url, Boolean(allowLocalhost));
      const outcome = await fetchWithRedirects(target, Boolean(allowLocalhost));
      if (!outcome.text.trim()) {
        return JSON.stringify({
          url: target.href,
          finalUrl: outcome.finalUrl,
          title: outcome.title,
          text: "",
          note: "页面抓取成功但没有提取到正文（可能是纯 JS 渲染的页面）。这种情况本工具读不到内容 —— 可以改用 computer_screenshot 看渲染后的界面，或直接请用户贴关键内容。",
        });
      }
      const notes: string[] = [];
      if (outcome.truncated) {
        notes.push(`正文超过 ${TEXT_LIMIT} 字符已截断；如需后续内容请针对性地抓更具体的页面（如详情页/分页）。`);
      }
      if (outcome.capped) {
        notes.push(`响应体超过 ${Math.round(BODY_LIMIT / 1_000_000)}MB 已停止读取。`);
      }
      notes.push("回答时如需引用，请注明来源 URL。");
      return JSON.stringify({
        url: target.href,
        finalUrl: outcome.finalUrl,
        title: outcome.title,
        text: outcome.text,
        truncated: outcome.truncated,
        note: notes.join(" "),
      });
    } catch (err) {
      // 工具失败不穿透图：返回模型可读的中文错误（AGENTS.md §5.4）
      return JSON.stringify({
        url,
        error: err instanceof Error ? err.message : String(err),
        note: "抓取失败。如果是内网地址被拒，这是安全策略；如果是网络问题，可稍后重试或换用其他来源。",
      });
    }
  },
  {
    name: "browser_fetch",
    description:
      "抓取一个网页并返回其正文纯文本（含页面标题）。" +
      "适用：读官方文档、release notes、博客、issue 页面、公开 JSON 接口等。\n" +
      "不适用：需要登录的页面、纯 JS 渲染的内容（抓不到正文）、本机/内网地址（默认被拒，需 allowLocalhost）。\n" +
      "只读操作，直接执行，不会弹出审批。",
    schema: z.object({
      url: z.string().describe("完整 URL，必须以 http:// 或 https:// 开头，例如 https://nodejs.org/api/fs.html"),
      allowLocalhost: z
        .boolean()
        .optional()
        .describe("是否允许访问本机/内网地址。默认 false（防 SSRF）；只有用户明确要求读本地服务时才设为 true"),
    }),
  }
);
