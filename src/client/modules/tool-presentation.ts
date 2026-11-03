/**
 * modules/tool-presentation.ts — 工具调用的统一分类、图标与摘要
 * ============================================================
 * 职责：把任意内置工具、业务工具或 MCP 工具名归入稳定类别，并生成
 * 面向用户的动作名称、参数摘要与结果区标题。
 *
 * 设计立场：
 *  - 分类只依赖工具名和参数文本，不依赖后端事件新增字段，离线回放也能恢复；
 *  - 未知工具永远回落到「工具调用」，保证 MCP / 新工具不会因分类缺失而消失；
 *  - 这里只做纯函数展示决策，不执行工具，也不把参数内容注入 HTML。
 */
import type { IconName } from "../ui/icon.js";
import type { ToolPart } from "./types.js";

export type ToolCategoryId =
  | "file-read"
  | "file-write"
  | "file-edit"
  | "image-read"
  | "command"
  | "file-search"
  | "browser"
  | "web"
  | "knowledge"
  | "memory"
  | "agent"
  | "computer"
  | "estate"
  | "job"
  | "mcp"
  | "other";

export interface ToolCategoryDefinition {
  id: ToolCategoryId;
  label: string;
  icon: IconName;
  argsLabel: string;
  resultLabel: string;
}

export const TOOL_CATEGORIES: Record<ToolCategoryId, ToolCategoryDefinition> = {
  "file-read": { id: "file-read", label: "文件读取", icon: "FileText", argsLabel: "读取参数", resultLabel: "文件内容" },
  "file-write": { id: "file-write", label: "文件写入", icon: "Pencil", argsLabel: "写入参数", resultLabel: "写入结果" },
  "file-edit": { id: "file-edit", label: "编辑文件", icon: "Code", argsLabel: "编辑参数", resultLabel: "编辑结果" },
  "image-read": { id: "image-read", label: "读取图片", icon: "Image", argsLabel: "图片参数", resultLabel: "图片信息" },
  command: { id: "command", label: "运行命令", icon: "Terminal", argsLabel: "命令", resultLabel: "命令输出" },
  "file-search": { id: "file-search", label: "文件检索", icon: "Search", argsLabel: "检索条件", resultLabel: "匹配结果" },
  browser: { id: "browser", label: "浏览器操作", icon: "Globe", argsLabel: "操作参数", resultLabel: "页面快照" },
  web: { id: "web", label: "网页读取", icon: "Link", argsLabel: "抓取参数", resultLabel: "页面内容" },
  knowledge: { id: "knowledge", label: "知识检索", icon: "BookOpen", argsLabel: "检索参数", resultLabel: "知识片段" },
  memory: { id: "memory", label: "长期记忆", icon: "Brain", argsLabel: "记忆参数", resultLabel: "记忆结果" },
  agent: { id: "agent", label: "子代理协作", icon: "Waypoints", argsLabel: "委派参数", resultLabel: "子代理结果" },
  computer: { id: "computer", label: "电脑操作", icon: "Monitor", argsLabel: "操作参数", resultLabel: "执行结果" },
  estate: { id: "estate", label: "房产查询", icon: "House", argsLabel: "查询参数", resultLabel: "查询结果" },
  job: { id: "job", label: "求职查询", icon: "Briefcase", argsLabel: "查询参数", resultLabel: "查询结果" },
  mcp: { id: "mcp", label: "MCP 工具", icon: "Plug", argsLabel: "调用参数", resultLabel: "工具结果" },
  other: { id: "other", label: "工具调用", icon: "Wrench", argsLabel: "参数", resultLabel: "结果" },
};

/** 同批分组内按固定顺序排列，避免类别顺序随调用顺序抖动。 */
export const TOOL_CATEGORY_ORDER: ToolCategoryId[] = [
  "file-read", "file-write", "file-edit", "image-read", "command", "file-search",
  "browser", "web", "knowledge", "memory", "agent", "computer",
  "estate", "job", "mcp", "other",
];

export interface ToolPresentation {
  category: ToolCategoryDefinition;
  rawName: string;
  summary: string;
}

type ToolPartLike = Pick<ToolPart, "name" | "argsText" | "result">;
type ToolArgs = Record<string, unknown>;

const FILE_WRITE_NAME = /(?:^|_)(?:write|create|save)_(?:file|text)(?:$|_)|(?:^|_)(?:file|text)_(?:write|create|save)(?:$|_)/;
const FILE_EDIT_NAME = /(?:^|_)(?:edit|patch|replace|modify)_(?:file|text)(?:$|_)|(?:^|_)(?:file|text)_(?:edit|patch|replace|modify)(?:$|_)|apply_patch|str_replace/;
const IMAGE_READ_NAME = /(?:^|_)(?:read|view|open|load|get)_image(?:$|_)|(?:^|_)image_(?:read|view|open|load|get)(?:$|_)/;
const FILE_READ_NAME = /(?:^|_)(?:read|view|open|load|cat)_(?:file|text)(?:$|_)|(?:^|_)(?:file|text)_(?:read|view|open|load|cat)(?:$|_)|(?:^|_)list_(?:dir|directory|files)(?:$|_)|(?:^|_)directory_tree(?:$|_)/;
const COMMAND_NAME = /(?:^|_)(?:terminal|shell|bash|powershell|command|exec|execute)(?:$|_)|(?:^|_)(?:run|exec|execute)_(?:command|script)(?:$|_)/;
const SEARCH_NAME = /(?:^|_)(?:grep|search|find|glob)(?:_|$)/;

function parseArgs(text: string): ToolArgs | null {
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as ToolArgs : null;
  } catch {
    return null;
  }
}

function textArg(args: ToolArgs | null, keys: string[]): string {
  if (!args) return "";
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function countArg(args: ToolArgs | null, keys: string[]): number | null {
  if (!args) return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

function firstScalar(args: ToolArgs | null): string {
  if (!args) return "";
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function compact(value: string, max = 140): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function categoryForName(rawName: string): ToolCategoryDefinition {
  const name = rawName.toLowerCase();
  const mcp = name.startsWith("mcp__");
  const leaf = mcp ? name.split("__").slice(2).join("__") : name;

  if (leaf === "computer_screenshot" || IMAGE_READ_NAME.test(leaf)) return TOOL_CATEGORIES["image-read"];
  if (FILE_WRITE_NAME.test(leaf)) return TOOL_CATEGORIES["file-write"];
  if (FILE_EDIT_NAME.test(leaf)) return TOOL_CATEGORIES["file-edit"];
  if (FILE_READ_NAME.test(leaf)) return TOOL_CATEGORIES["file-read"];
  if (COMMAND_NAME.test(leaf)) return TOOL_CATEGORIES.command;
  if (leaf === "browser_fetch" || /^(?:web|http)_(?:fetch|get|read)$/.test(leaf)) return TOOL_CATEGORIES.web;
  if (leaf === "retrieve_docs" || /^(?:rag|knowledge)_/.test(leaf)) return TOOL_CATEGORIES.knowledge;
  if (leaf === "delegate_agent" || leaf === "delegate" || /^agent_/.test(leaf)) return TOOL_CATEGORIES.agent;
  if (leaf.startsWith("browser_")) return TOOL_CATEGORIES.browser;
  if (leaf.startsWith("memory_")) return TOOL_CATEGORIES.memory;
  if (leaf.startsWith("computer_")) return TOOL_CATEGORIES.computer;
  if (leaf.startsWith("house_")) return TOOL_CATEGORIES.estate;
  if (leaf.startsWith("job_")) return TOOL_CATEGORIES.job;
  if (SEARCH_NAME.test(leaf)) return TOOL_CATEGORIES["file-search"];
  if (mcp) return TOOL_CATEGORIES.mcp;
  return TOOL_CATEGORIES.other;
}

/** 从命令、路径、查询等参数中提取一眼可读的操作摘要。 */
function summarize(category: ToolCategoryId, rawName: string, args: ToolArgs | null, argsText: string): string {
  const path = textArg(args, ["path", "file_path", "filepath", "target", "filename", "file"]);
  const url = textArg(args, ["url", "href"]);
  const query = textArg(args, ["query", "pattern", "keyword", "q", "text"]);
  const action = textArg(args, ["action", "operation", "op"]);

  if (category === "file-write" || category === "file-edit") {
    const size = countArg(args, ["content", "text", "patch", "old_string", "new_string"]);
    return compact([path || "文件", size !== null && category === "file-write" ? `${size} 字符` : ""].filter(Boolean).join(" · "));
  }
  if (category === "file-read") {
    if (rawName.toLowerCase().endsWith("list_dir")) return compact(path || "项目根目录");
    return compact(path || "读取文件");
  }
  if (category === "image-read") return compact(path || (rawName === "computer_screenshot" ? "截取当前屏幕" : "读取图片"));
  if (category === "command") return compact(textArg(args, ["command", "cmd", "script"]) || "执行命令");
  if (category === "file-search") return compact([query ? `/${query}/` : "搜索文件", path || ""].filter(Boolean).join(" · "));
  if (category === "browser") return compact([action, url, textArg(args, ["ref"])].filter(Boolean).join(" · ") || "浏览器操作");
  if (category === "web") return compact(url || query || "读取网页");
  if (category === "knowledge") return compact(query || "检索知识库");
  if (category === "memory") return compact(textArg(args, ["key", "query", "content"]) || action || "长期记忆");
  if (category === "agent") return compact(textArg(args, ["agentId", "agent_id", "agent", "task"]) || "委派子代理");
  if (category === "computer") return compact([action, textArg(args, ["combo", "text"])].filter(Boolean).join(" · ") || rawName.replace(/^computer_/, "") || "电脑操作");
  if (category === "estate" || category === "job") return compact(query || action || textArg(args, ["city", "houseId", "house_id", "keywords"]) || "业务查询");
  const fallback = firstScalar(args) || argsText;
  return compact(fallback || (category === "mcp" ? "MCP 工具" : "调用工具"));
}

export function describeTool(part: ToolPartLike): ToolPresentation {
  const rawName = (part.name || "tool").trim();
  const category = categoryForName(rawName);
  const args = parseArgs(part.argsText);
  return {
    category,
    rawName,
    summary: summarize(category.id, rawName, args, part.argsText),
  };
}