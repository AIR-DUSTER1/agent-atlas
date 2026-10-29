/* ============================================================
   modules/format.ts — 纯文本渲染与格式化（无 DOM 状态依赖）
   ============================================================
   从 app 拆出的「无副作用」层：增强 Markdown（marked + DOMPurify）与安全 fallback、
   token 与字节大小格式化 / 思考角标 / URL 白名单。
   支持：围栏代码块 / 行内代码 / 加粗斜体 / 链接 / 标题 / 列表 / 引用 /
   表格 / 分割线；对「流式中途未闭合的围栏」也能正确渲染成代码块。
   ============================================================ */

import type { ToolPart } from "./types.js";
import { safeHref as safeUrlHref, safeImageSrc as safeUrlImage } from "../ui/safe-url.js";

export const NODE_ICONS: Record<string, string> = {
  analyze: "🧭", clarify: "❓", review: "🔎",
  agent: "🧠", tools: "🔧", supervisor: "👔", researcher: "🔍", writer: "✍️",
};
export const NODE_LABELS: Record<string, string> = { analyze: "需求理解", clarify: "需求澄清", review: "结果反思" };
export const TOOL_ICONS: Record<string, string> = {
  calculator: "🧮", get_weather: "☁️", get_current_time: "⏰", send_email: "📧",
  delegate: "🧭", retrieve_docs: "📚",
  // 多智能体协同（委派子 Agent）
  delegate_agent: "👥",
  // 跨会话长期记忆
  memory_save: "🧠", memory_recall: "🔎",
  // 房产 Agent（贝壳）
  house_search: "🏙", house_lookup: "🔍", house_market: "📈", house_map: "🗺️",
  house_agents: "👤", house_appoint: "📅", house_contact: "🤝",
};

export function nodeIcon(name: string): string {
  return NODE_ICONS[name.split("/")[0]] || "⚙️";
}
export function nodeLabel(name: string): string {
  return NODE_LABELS[name.split("/")[0]] || name;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderInline(text: string): string {
  let h = escapeHtml(text);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h;
}

function renderMarkdownFallback(src: string): string {
  const fences: Array<{ lang: string; code: string }> = [];
  // 1. 提取围栏代码块（含未闭合的流式半截）
  src = src.replace(/```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    fences.push({ lang, code: code.replace(/\n$/, "") });
    return `\u0000F${fences.length - 1}\u0000`;
  });

  // 2. 逐行做块级解析
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  const isFence = (l: string): boolean => /^\u0000F\d+\u0000\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) { out.push(line); i++; continue; }
    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); i++; continue; }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      // buf 至少含当前行（入口已匹配 >），循环内每轮 i++，必然终止
      out.push(`<blockquote>${buf.map(renderInline).join("<br>")}</blockquote>`);
      continue;
    }

    // 表格：| a | b | 换行 |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const parseRow = (l: string): string[] => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].includes("|")) { rows.push(parseRow(lines[i])); i++; }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      );
      continue;
    }

    // 列表
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(ul ? /^\s*[-*]\s+(.*)$/ : /^\s*\d+[.、]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${renderInline(m[1])}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // 普通段落（连续非空行，行间以 <br> 连接）
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isFence(lines[i]) &&
      !/^(#{1,4})\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.、]\s+/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) &&
      !/^\s*>/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      out.push(`<p>${buf.map(renderInline).join("<br>")}</p>`);
    } else {
      // 兜底：当前行不属于任何块（如流式中的半截表格行），直接按段落输出，保证 i 前进
      out.push(`<p>${renderInline(lines[i])}</p>`);
      i++;
    }
  }

  let html = out.join("\n");
  // 3. 还原代码块
  html = html.replace(/\u0000F(\d+)\u0000/g, (_m, n: string) => {
    const f = fences[Number(n)];
    return `<pre><code${f.lang ? ` class="language-${escapeHtml(f.lang)}"` : ""}>${escapeHtml(f.code)}</code></pre>`;
  });
  return html;
}

type MarkdownRenderer = (source: string) => string;
let enhancedMarkdownRenderer: MarkdownRenderer | null = null;
let markdownLoadPromise: Promise<boolean> | null = null;

const MARKDOWN_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th",
  "thead", "tr", "ul",
];
const MARKDOWN_ATTRS = ["href", "src", "alt", "title", "class", "lang", "target", "rel"];

/** 动态加载 marked + DOMPurify；失败时继续使用内置安全 fallback，不阻断消息流。 */
export function ensureMarkdownRenderer(): Promise<boolean> {
  markdownLoadPromise ??= import("../vendor/markdown.js")
    .then(({ marked, DOMPurify }) => {
      marked.setOptions({ gfm: true, breaks: true });
      DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
        if (node.tagName === "A") {
          const safe = safeUrlHref(node.getAttribute("href"));
          if (!safe) node.removeAttribute("href");
          else node.setAttribute("href", safe);
          if (/^https?:/i.test(safe ?? "")) {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer");
          } else {
            node.removeAttribute("target");
            node.removeAttribute("rel");
          }
        }
        if (node.tagName === "IMG") {
          const safe = safeUrlImage(node.getAttribute("src"));
          if (!safe || !/^(https:|data:image\/)/i.test(safe)) node.removeAttribute("src");
          else node.setAttribute("src", safe);
        }
      });
      enhancedMarkdownRenderer = (source: string): string => {
        const raw = marked.parse(source, { async: false }) as string;
        return DOMPurify.sanitize(raw, {
          ALLOWED_TAGS: MARKDOWN_TAGS,
          ALLOWED_ATTR: MARKDOWN_ATTRS,
          FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
          ALLOW_DATA_ATTR: false,
        });
      };
      return true;
    })
    .catch(() => {
      markdownLoadPromise = null;
      return false;
    });
  return markdownLoadPromise;
}

/** 增强渲染器就绪后使用 marked + DOMPurify；未就绪时保持同步 fallback。 */
export function renderMarkdown(src: string): string {
  return enhancedMarkdownRenderer ? enhancedMarkdownRenderer(src) : renderMarkdownFallback(src);
}
export function fmtArgs(part: Pick<ToolPart, "argsText">): string {
  try { return JSON.stringify(JSON.parse(part.argsText), null, 2); } catch { return part.argsText || "…"; }
}

/**
 * 百分比统一保留一位小数；未真正达到 100% 时最多显示 99.9%，
 * 避免 99.95% 一类数值被四舍五入后误读成缓存全命中。
 */
export function fmtPercent(value: number | null | undefined): string {
  const safe = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (safe <= 0) return "0.0%";
  if (safe >= 100) return "100.0%";
  return `${Math.min(99.9, safe).toFixed(1)}%`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "–";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 100_000) return Math.round(n / 1000) + "k";
  if (n >= 10_000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString("zh-CN");
}

export function fmtSize(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

/** 思考等级角标：供应商默认时不显示，避免噪音 */
export function reasoningTag(model: { reasoningLevel?: string; reasoningLabel?: string } | null | undefined): string {
  return model?.reasoningLevel && model.reasoningLevel !== "default" ? model.reasoningLabel || "" : "";
}

/** 房源图片来源白名单：只放行 https 与 data:image（拒绝 http:// / 相对路径等） */
export function safeImageSrc(url: unknown): string {
  const safe = safeUrlImage(typeof url === "string" ? url : "");
  return safe && /^(https:|data:image\/)/i.test(safe) ? safe : "";
}

/** 链接 href 白名单：https / http / mailto 与同源相对路径；危险协议一律拒绝。 */
export function safeHref(url: unknown): string | null {
  return typeof url === "string" ? safeUrlHref(url) : null;
}
