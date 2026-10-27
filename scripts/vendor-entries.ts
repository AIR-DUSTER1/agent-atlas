/**
 * scripts/vendor-entries.ts — 前端 vendor 构建的唯一清单
 * ============================================================
 * 这里只描述“哪个 npm 库需要打成浏览器自包含 ESM”，构建脚本与安全扫描
 * 共用同一份清单，避免 package.json、import map、产物集合三处漂移。
 */
export interface VendorEntry {
  /** npm 包说明名，只用于日志 */ name: string;
  /** 输出到 src/server/public/vendor 的文件名 */ outputFile: string;
  /** esbuild stdin 内容；必须只依赖清单内包 */ source: string;
  /** SPDX 许可证，登记与人工审计用 */ license: string;
}

/** 业务 wrapper 文件；tsc 输出后仍保留裸导入，由 import map 指向 *-lib.js */
export const VENDOR_WRAPPER_FILES = [
  "chart.js",
  "icons.js",
  "markdown.js",
  "highlight.js",
] as const;

/** 每个 npm 库的浏览器自包含产物；输出名刻意与 wrapper 分开，避免 tsc 覆盖 */
export const VENDOR_ENTRIES: VendorEntry[] = [
  {
    name: "chart.js",
    outputFile: "chart-lib.js",
    license: "MIT",
    source: `
      import { Chart, registerables } from "chart.js";
      Chart.register(...registerables);
      export { Chart };
    `,
  },
  {
    name: "lucide",
    outputFile: "icons-lib.js",
    license: "ISC",
    source: `
      export {
        Plus, Search, Settings, Paperclip, Send, Square, Sun, Moon, Monitor,
        ChevronDown, ChevronRight, ChevronLeft, X, Check, Trash2, Download,
        Upload, Folder, FolderOpen, FileText, Image, Link, Wrench, Brain,
        ShieldCheck, ShieldAlert, Bot, User, House, MapPin, RefreshCw,
        CircleAlert, CircleCheck, Clock, Copy, Terminal, MoreHorizontal, Pencil,
        SlidersHorizontal, Plug, Database, BarChart3, LineChart, PieChart,
        Activity, Zap, Globe, MessageSquare, Command, BookOpen, Server, Menu,
        ArrowDown, ArrowLeft, ArrowRight, ExternalLink, Eye, EyeOff, LoaderCircle, Info,
        TriangleAlert, CircleX, Sparkles, Map, Settings2, PanelLeft,
        ChevronsUpDown, Calendar, Code, FileCode, FolderTree, CheckCircle2,
        XCircle
      } from "lucide";
    `,
  },
  {
    name: "marked",
    outputFile: "marked-lib.js",
    license: "MIT",
    source: `export { marked } from "marked";`,
  },
  {
    name: "dompurify",
    outputFile: "dompurify-lib.js",
    license: "MPL-2.0 OR Apache-2.0",
    source: `export { default as DOMPurify } from "dompurify";`,
  },
  {
    name: "highlight.js",
    outputFile: "highlight-lib.js",
    license: "BSD-3-Clause",
    source: `
      import hljs from "highlight.js/lib/core";
      import bash from "highlight.js/lib/languages/bash";
      import css from "highlight.js/lib/languages/css";
      import javascript from "highlight.js/lib/languages/javascript";
      import json from "highlight.js/lib/languages/json";
      import markdown from "highlight.js/lib/languages/markdown";
      import plaintext from "highlight.js/lib/languages/plaintext";
      import python from "highlight.js/lib/languages/python";
      import sql from "highlight.js/lib/languages/sql";
      import typescript from "highlight.js/lib/languages/typescript";
      import xml from "highlight.js/lib/languages/xml";
      import yaml from "highlight.js/lib/languages/yaml";
      hljs.registerLanguage("bash", bash);
      hljs.registerLanguage("css", css);
      hljs.registerLanguage("javascript", javascript);
      hljs.registerLanguage("js", javascript);
      hljs.registerLanguage("json", json);
      hljs.registerLanguage("markdown", markdown);
      hljs.registerLanguage("md", markdown);
      hljs.registerLanguage("plaintext", plaintext);
      hljs.registerLanguage("text", plaintext);
      hljs.registerLanguage("python", python);
      hljs.registerLanguage("py", python);
      hljs.registerLanguage("sql", sql);
      hljs.registerLanguage("typescript", typescript);
      hljs.registerLanguage("ts", typescript);
      hljs.registerLanguage("xml", xml);
      hljs.registerLanguage("html", xml);
      hljs.registerLanguage("yaml", yaml);
      hljs.registerLanguage("yml", yaml);
      export default hljs;
    `,
  },
];
