/**
 * ============================================================
 * memory-store.ts — 跨会话长期记忆（F1）的存储核心
 * ============================================================
 * 职责：维护一份小白名单数据「值得跨会话记住的事实与偏好」，
 * 供三处共用——Agent 工具（tools-memory.ts，模型主动读写）、
 * 上下文注入（workflow.ts 每轮拼 system 注记）、设置页 API（管理）。
 *
 * 设计立场：
 * - 规模是「几十条 × 一行」量级，与 journal/checkpoint 的大日志不同：
 *   采用「内存权威 + 每次变更全量原子重写」（临时文件 + rename，
 *   config-store 同模式），不做 append/compact —— 简单可靠优先；
 * - key 语义 = 主题短语（如「回答风格」「测试命令」）：同 key 保存
 *   视为更新（保留稳定 id，刷新 updatedAt），不无限堆重复条目；
 * - 注入侧只取最近更新的 MAX_INJECT 条，每条一行拼进 system 注记；
 *   不进 checkpoint 历史，只在当轮请求里出现 —— 不占长期上下文预算。
 *
 * 边界：`.setting/memories.json`（gitignore）；测试钩子 MEMORIES_FILE。
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./server/logging.js";

/** 记忆总条数上限：超过拒绝新增（保护注入预算与文件体积） */
const MAX_MEMORIES = 200;
/** 每轮注入进 system 注记的条数上限（最近更新优先） */
const MAX_INJECT = 30;
const MAX_KEY_CHARS = 50;
const MAX_CONTENT_CHARS = 500;

// 注意层数：本文件在 src/ 顶层，回退一层到仓库根（wiki §7.3 的坑）
const DEFAULT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".setting",
  "memories.json"
);

export interface MemoryEntry {
  id: string;
  /** 主题短语；同 key 再保存 = 更新该条 */
  key: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** agent = 模型经 memory_save 写入；user = 设置页手动添加 */
  source: "agent" | "user";
}

const entries = new Map<string, MemoryEntry>(); // key → entry
let loaded = false;
let storeFile = resolveFile();

function resolveFile(): string {
  return process.env.MEMORIES_FILE || DEFAULT_FILE;
}

export async function loadMemories(): Promise<number> {
  if (loaded) return entries.size;
  loaded = true;
  let raw = "";
  try {
    raw = await readFile(storeFile, "utf8");
  } catch {
    return 0; // 文件不存在 = 全新启动，空记忆
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("根元素不是数组");
    for (const item of parsed) {
      const entry = normalizeEntry(item);
      if (entry) entries.set(entry.key, entry);
    }
  } catch (err) {
    // 坏文件不炸服务：从空记忆继续（记忆是增强能力，不是关键路径）
    entries.clear();
    log("warn", "memories_load_failed", {
      file: storeFile,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return entries.size;
}

function normalizeEntry(item: unknown): MemoryEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const rec = item as Partial<MemoryEntry>;
  if (typeof rec.key !== "string" || !rec.key.trim()) return null;
  if (typeof rec.content !== "string" || !rec.content.trim()) return null;
  return {
    id: typeof rec.id === "string" && rec.id ? rec.id : randomUUID(),
    key: rec.key.trim().slice(0, MAX_KEY_CHARS),
    content: rec.content.trim().slice(0, MAX_CONTENT_CHARS),
    createdAt: typeof rec.createdAt === "number" ? rec.createdAt : Date.now(),
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now(),
    source: rec.source === "user" ? "user" : "agent",
  };
}

/** 全量原子重写（小白名单数据不值得 append/compact 的复杂度） */
async function persist(): Promise<void> {
  const all = [...entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  const tmp = `${storeFile}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
  await rename(tmp, storeFile);
}

export function listMemories(): MemoryEntry[] {
  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 新增或更新（同 key 覆盖，保留稳定 id）；返回落库后的条目。 */
export async function saveMemory(
  key: string,
  content: string,
  source: "agent" | "user"
): Promise<MemoryEntry> {
  await loadMemories();
  const cleanKey = key.trim();
  const cleanContent = content.trim();
  if (!cleanKey) throw new Error("记忆主题（key）不能为空");
  if (!cleanContent) throw new Error("记忆内容不能为空");
  if (cleanKey.length > MAX_KEY_CHARS) throw new Error(`记忆主题过长（上限 ${MAX_KEY_CHARS} 字符）`);
  if (cleanContent.length > MAX_CONTENT_CHARS) {
    throw new Error(`记忆内容过长（${cleanContent.length} 字符，上限 ${MAX_CONTENT_CHARS}）`);
  }
  const existing = entries.get(cleanKey);
  if (!existing && entries.size >= MAX_MEMORIES) {
    throw new Error(`记忆已达上限 ${MAX_MEMORIES} 条，请先在设置里删除不再需要的条目`);
  }
  const now = Date.now();
  const entry: MemoryEntry = existing
    ? { ...existing, content: cleanContent, updatedAt: now, source }
    : { id: randomUUID(), key: cleanKey, content: cleanContent, createdAt: now, updatedAt: now, source };
  entries.set(cleanKey, entry);
  await persist();
  return entry;
}

export async function deleteMemory(id: string): Promise<boolean> {
  await loadMemories();
  for (const [key, entry] of entries) {
    if (entry.id === id) {
      entries.delete(key);
      await persist();
      return true;
    }
  }
  return false;
}

/** 关键词检索（memory_recall 工具用）：空格分词、不区分大小写，命中 key 或 content。 */
export function searchMemories(query: string, limit = 10): MemoryEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return listMemories().slice(0, limit);
  return listMemories()
    .filter((entry) => {
      const haystack = `${entry.key}\n${entry.content}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    })
    .slice(0, limit);
}

/**
 * 每轮注入进 system 注记的记忆清单（最近更新优先，上限 MAX_INJECT 条）。
 * 动态拼进当轮请求、不落 checkpoint —— 长会话不会累积重复占预算。
 */
export function memoryNoteForPrompt(): string | null {
  if (!entries.size) return null;
  const all = listMemories();
  const injected = all.slice(0, MAX_INJECT);
  const lines = injected.map((entry) => `- [${entry.key}] ${entry.content}`);
  const overflow = all.length - injected.length;
  const tail = overflow > 0
    ? `\n（另有 ${overflow} 条较早的记忆未注入，可用 memory_recall 按关键词查询）`
    : "";
  return `【跨会话长期记忆（此前会话沉淀的事实与偏好，回答时遵循；与当前对话冲突时以用户最新说法为准）】\n${lines.join("\n")}${tail}`;
}

/** 测试专用：清空内存态并重绑 MEMORIES_FILE */
export function resetMemoryStore(): void {
  entries.clear();
  loaded = false;
  storeFile = resolveFile();
}
