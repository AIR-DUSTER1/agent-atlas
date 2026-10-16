/**
 * ============================================================
 * rag.ts — 外部 RAG 服务接入（通用 HTTP 契约）
 * ============================================================
 * 设计定位：本工作台【不内置向量库 / embedding】，检索与入库全部
 * 委托给一个「外部 RAG 服务」。向量存储、切块、embedding（通常是
 * OpenAI 兼容 /embeddings）都由该服务内部完成；这里只是一个 HTTP 客户端。
 *
 * 通用 HTTP 契约（外部服务需要实现的最小接口）：
 *   POST {baseURL}/ingest   → { collection, documents:[{ id, name, text, meta? }] }
 *                             ← 任意 JSON（推荐 { ok, indexed, chunks }）
 *   POST {baseURL}/search   → { collection, query, topK }
 *                             ← { hits:[{ text, score, name?, source? }] }
 *                               （hits/results 两种键名都兼容，text/content 都识别）
 *   POST {baseURL}/reset    → { collection }                      （清空集合）
 *   POST {baseURL}/delete   → { collection, ids:[...] }           （可选，删除单个文档）
 *   鉴权：请求头 Authorization: Bearer <key>（Key 可留空）
 *
 * 本地持久化：.web-config.json 的 `rag` 键（走 config-store 的 mergeConfig，
 * 与 providers / projects / externalAgents 共存互不覆盖）：
 *   { baseURL, apiKey, collection, topK, docs: { id → 入库登记 } }
 * docs 只是「我们送进去了什么」的花名册，真实索引在外部服务里。
 *
 * 数据入口（两层）：
 *   1. 知识库面板 📚 —— 按项目 / 文件夹扫描文本文件批量入库（前端触发）
 *   2. 发消息自动入库 —— 处理 /api/chat 时把 📎 文本附件顺手送进知识库
 * 检索出口：通用 Agent 的 retrieve_docs 工具（tools-rag.ts）+ 面板检索测试。
 */
import { promises as fsp } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { readConfig, mergeConfig } from "./config-store.js";
import { assertAuthorized, PROJECT_ROOT, SKIPPED_DIRS } from "./files.js";
import { maskKey } from "./settings.js";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
interface RagDocMeta {
  name: string;
  bytes: number;
  chunks: number | null;   // 外部服务若返回切块数则记录，否则 null
  at: number;              // 入库时间戳
  source: string;          // 来源描述（文件夹扫描 / 聊天附件 / 手动文本）
}
interface RagSaved {
  baseURL: string;
  apiKey: string;
  collection: string;
  topK: number;
  docs: Record<string, RagDocMeta>;
}

const DEFAULTS = { collection: "default", topK: 5 };
const MAX_SEARCH_CHARS = 4_000;      // 迟缓网关兜底：摘要长度截断
const SEARCH_TIMEOUT_MS = 30_000;
const INGEST_TIMEOUT_MS = 90_000;

let rag: RagSaved = { baseURL: "", apiKey: "", ...DEFAULTS, docs: {} };
let ragLoaded = false;

/** 惰性加载一次：保证任何入口（服务启动 / 检索工具 / 一次性脚本）都能拿到配置 */
export async function loadRag(): Promise<void> {
  const saved = await readConfig();
  const r = (saved.rag ?? {}) as Partial<RagSaved>;
  rag = {
    baseURL: typeof r.baseURL === "string" ? r.baseURL : "",
    apiKey: typeof r.apiKey === "string" ? r.apiKey : "",
    collection: typeof r.collection === "string" && r.collection.trim() ? r.collection : DEFAULTS.collection,
    topK: typeof r.topK === "number" && r.topK >= 1 && r.topK <= 20 ? Math.round(r.topK) : DEFAULTS.topK,
    docs: r.docs && typeof r.docs === "object" && !Array.isArray(r.docs) ? (r.docs as Record<string, RagDocMeta>) : {},
  };
  ragLoaded = true;
}

const ensureLoaded =(): Promise<void> => (ragLoaded ? Promise.resolve() : loadRag());

function validRagBaseURL(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(u)) throw new Error("RAG 服务地址必须是 http(s) 开头的完整 URL，例如 http://127.0.0.1:8000");
  return u;
}

async function persistRag(): Promise<void> {
  await mergeConfig({ rag });
}

export function isRagConfigured(): boolean {
  return Boolean(rag.baseURL);
}

/** 公开视图（入口处惰性加载，保证一次性脚本 / 工具独进程也能读到配置） */
export async function getRagPublic(): Promise<Record<string, unknown>> {
  await ensureLoaded();
  return {
    configured: isRagConfigured(),
    baseURL: rag.baseURL,
    apiKeyMasked: maskKey(rag.apiKey),
    hasKey: Boolean(rag.apiKey),
    collection: rag.collection,
    topK: rag.topK,
    docs: Object.entries(rag.docs).map(([id, d]) => ({ id, ...d })),
  };
}

/** 保存配置；apiKey 未传 = 保持不变，空串 = 清除。返回前端公共视图。 */
export async function saveRagConfig(input: {
  baseURL: string; apiKey?: unknown; collection?: unknown; topK?: unknown;
}): Promise<Record<string, unknown>> {
  await ensureLoaded();  if (!input.baseURL || !String(input.baseURL).trim()) throw new Error("RAG 服务地址不能为空");
  rag.baseURL = validRagBaseURL(String(input.baseURL));
  if (typeof input.apiKey === "string") rag.apiKey = input.apiKey.trim();
  if (typeof input.collection === "string" && input.collection.trim()) rag.collection = input.collection.trim();
  if (input.topK !== undefined && input.topK !== null && input.topK !== "") {
    const n = Number(input.topK);
    if (!Number.isFinite(n) || n < 1 || n > 20) throw new Error("topK 需为 1-20 的数字");
    rag.topK = Math.round(n);
  }
  await persistRag();
  return getRagPublic();
}

// ---------------------------------------------------------------------------
// HTTP 客户端（契约适配：字段名宽容解析）
// ---------------------------------------------------------------------------
function ragHeaders(): Record<string, string> {
  return rag.apiKey
    ? { "Content-Type": "application/json", Authorization: `Bearer ${rag.apiKey}` }
    : { "Content-Type": "application/json" };
}

function ragError(res: Response, what: string): Error {
  return new Error(`RAG 服务 ${what} 返回 HTTP ${res.status}（检查服务地址 / 鉴权 / 服务是否实现 ${what} 接口）`);
}

/** 连通性探测：向 {baseURL}/ 发任意请求，能收到 HTTP 响应（无论状态码）即视为可达 */
export async function testRagConnection(opts?: { baseURL?: string; apiKey?: string }): Promise<Record<string, unknown>> {
  await ensureLoaded();
  const base = validRagBaseURL(opts?.baseURL ?? rag.baseURL);
  const key = opts?.apiKey !== undefined ? String(opts.apiKey) : rag.apiKey;
  let res: Response;
  try {
    res = await fetch(base + "/", {
      method: "GET",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`连接失败：${e instanceof Error ? e.message : String(e)}`);
  }
  let body = "";
  try { body = (await res.text()).slice(0, 200); } catch { /* 忽略 */ }
  return { ok: true, status: res.status, body };
}

interface RagHit { name: string; text: string; score: number; source: string }
interface RagNormalized { id: string | null; name: string; text: string; score: number; source: string; meta: Record<string, unknown> }

/** 解析 search 返回的命中结构（兼容 hits / results、text / content、meta 内外两种来源字段） */
function parseHits(body: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const key of ["hits", "results", "documents", "data"]) {
    const v = (body as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  throw new Error("RAG 服务 search 返回格式无法解析（期望 hits/results 数组）");
}

function pickStr(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function normalizeHit(h: Record<string, unknown>): RagHit {
  const meta = (h.meta && typeof h.meta === "object" ? h.meta : h.metadata && typeof h.metadata === "object" ? h.metadata : null) as Record<string, unknown> | null;
  const name = pickStr(h, ["name", "title", "document", "file"]) ?? pickStr(meta, ["name", "title", "file"]) ?? "未命名片段";
  const source = pickStr(h, ["source", "path", "url"]) ?? pickStr(meta, ["source", "path", "url"]) ?? "";
  const text = pickStr(h, ["text", "content", "chunk", "snippet", "page_content"]) ?? "";
  const scoreNum = h.score ?? meta?.score;
  const score = typeof scoreNum === "number" ? scoreNum : Number.isFinite(Number(scoreNum)) ? Number(scoreNum) : 0;
  return { name, text: text.slice(0, MAX_SEARCH_CHARS) ?? "", score, source };
}

/** 检索（对外统一入口：工具与知识库面板都用它） */
export async function searchRag(query: string, topK?: number): Promise<{ query: string; hits: RagHit[]; service: string }> {
  await ensureLoaded();
  if (!isRagConfigured()) throw new Error("未配置外部 RAG 服务：请在 📚 知识库面板填写服务地址");
  const q = query.trim();
  if (!q) throw new Error("检索词不能为空");
  const res = await fetch(rag.baseURL + "/search", {
    method: "POST",
    headers: ragHeaders(),
    body: JSON.stringify({
      collection: rag.collection,
      query: q,
      topK: topK && topK >= 1 ? Math.min(20, Math.round(topK)) : rag.topK,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw ragError(res, "search");
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object") throw new Error("RAG 服务 search 返回了非 JSON 内容");
  const hits = parseHits(body as Record<string, unknown>).map(normalizeHit);
  return { query: q, hits, service: rag.baseURL };
}

/** 入库：送一批文档给外部服务（切块 / embedding 都由服务端完成） */
async function ragIngest(documents: Array<{ id: string; name: string; text: string; meta: Record<string, unknown> }>): Promise<{ indexed: number; chunks: number | null }> {
  const res = await fetch(rag.baseURL + "/ingest", {
    method: "POST",
    headers: ragHeaders(),
    body: JSON.stringify({ collection: rag.collection, documents }),
    signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
  });
  if (!res.ok) throw ragError(res, "ingest");
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* 契约不强制返回体 */ }
  const indexed = documents.length;
  const chunksRaw = body.chunks ?? body.indexed ?? body.count;
  const chunks = Number.isFinite(Number(chunksRaw)) ? Number(chunksRaw) : null;
  return { indexed, chunks };
}

async function registerDocs(entries: Array<{ id: string; meta: RagDocMeta }>): Promise<void> {
  for (const { id, meta } of entries) rag.docs[id] = meta;
  await persistRag();
}

/** 手动文本入库（知识库面板「粘贴文本」/ 聊天附件共用） */
export async function ingestText(name: string, text: string, source: string): Promise<Record<string, unknown>> {
  await ensureLoaded();
  if (!isRagConfigured()) throw new Error("未配置外部 RAG 服务：请先在 📚 知识库面板填写服务地址");
  const content = text.trim();
  if (!content) throw new Error("文本内容为空");
  const id = randomUUID();
  const { chunks } = await ragIngest([{ id, name, text: content, meta: { source } }]);
  await registerDocs([{ id, meta: { name, bytes: content.length, chunks, at: Date.now(), source } }]);
  return getRagPublic();
}

/** 删除单个文档：优先通知外部服务（POST /delete），随后总是移除本地登记 */
export async function deleteRagDoc(id: string): Promise<Record<string, unknown>> {
  await ensureLoaded();
  if (rag.docs[id] && isRagConfigured()) {
    try {
      await fetch(rag.baseURL + "/delete", {
        method: "POST",
        headers: ragHeaders(),
        body: JSON.stringify({ collection: rag.collection, ids: [id] }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { /* 外部服务不支持 /delete 时忽略：本地移除登记即可 */ }
  }
  delete rag.docs[id];
  await persistRag();
  return getRagPublic();
}

/** 清空集合：POST /reset + 清掉本地登记 */
export async function clearRag(): Promise<Record<string, unknown>> {
  await ensureLoaded();
  if (!isRagConfigured()) throw new Error("未配置外部 RAG 服务");
  await fetch(rag.baseURL + "/reset", {
    method: "POST",
    headers: ragHeaders(),
    body: JSON.stringify({ collection: rag.collection }),
    signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
  }).then(async (res) => {
    if (!res.ok) throw ragError(res, "reset");
  }).catch(async (e) => {
    // 服务不支持 /reset：不打断本地清理，但提示用户
    console.warn("[rag] reset 失败：", e instanceof Error ? e.message : e);
  });
  rag.docs = {};
  await persistRag();
  return getRagPublic();
}

// ---------------------------------------------------------------------------
// 文件夹扫描入库（知识库面板「全量入库」）
// ---------------------------------------------------------------------------
const INGEST_EXTS = new Set([
  ".txt", ".md", ".mdx", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log",
  ".html", ".htm", ".xml", ".css", ".svg",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
  ".py", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".sql",
  ".sh", ".bat", ".ps1", ".dockerfile", ".toml", ".yaml", ".yml", ".ini", ".conf", ".properties",
]);
const LOCK_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "cargo.lock", "poetry.lock"]);
const MAX_SCAN_FILES = 300;          // 一次扫描最多入库的文件数
const MAX_FILE_CHARS = 300_000;      // 单文件入库上限（超大文件截断并打标记）
const MAX_BATCH_BYTES = 600_000;     // 单次 /ingest 请求的文本总量上限
const MAX_BATCH_DOCS = 10;           // 单次 /ingest 请求最多文档数

interface ScanFile { id: string; name: string; rel: string; text: string; truncated: boolean }

async function scanAuthorizedFolder(rootRaw: string): Promise<ScanFile[]> {
  const root = resolve(rootRaw.trim());
  assertAuthorized(root); // 只允许授权根（项目根 / 已添加文件夹）
  const st = await fsp.stat(root).catch(() => { throw new Error("路径不存在"); });
  if (!st.isDirectory()) throw new Error("该路径不是文件夹");

  const files: ScanFile[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_SCAN_FILES) return;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (files.length >= MAX_SCAN_FILES) return;
      const full = resolve(dir, d.name);
      if (d.isDirectory()) {
        if (SKIPPED_DIRS.has(d.name)) continue;
        await walk(full);
        continue;
      }
      if (!d.isFile()) continue;
      if (d.name.startsWith(".") || LOCK_FILES.has(d.name)) continue; // 密钥/锁文件不入库
      if (!INGEST_EXTS.has(extname(d.name).toLowerCase()) && !/\bdockerfile$/i.test(d.name)) continue;
      const st2 = await fsp.stat(full).catch(() => null);
      if (!st2 || st2.size > MAX_FILE_CHARS * 2) continue; // 超大文件（>600KB）直接跳过
      const buf = await fsp.readFile(full).catch(() => null);
      if (!buf || buf.subarray(0, 4000).includes(0)) continue; // 二进制
      const text = buf.toString("utf8");
      const truncated = text.length > MAX_FILE_CHARS;
      files.push({
        id: randomUUID(),
        name: d.name,
        rel: full.startsWith(PROJECT_ROOT) ? full.slice(PROJECT_ROOT.length + 1) : full,
        text: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
        truncated,
      });
    }
  }

  await walk(root);
  return files;
}

/** 批量入库一个授权目录下的所有文本文件；返回统计 + 最新文档登记 */
export async function ingestFolder(rootRaw: string): Promise<{
  ingested: number; skipped: number; chunks: number | null;
  docs: Array<{ id: string; name: string; rel: string; truncated: boolean }>;
}> {
  await ensureLoaded();
  if (!isRagConfigured()) throw new Error("未配置外部 RAG 服务：请先保存服务地址");
  const files = await scanAuthorizedFolder(rootRaw);
  const root = resolve(rootRaw.trim());
  const rootName = basename(root) || root;

  // 分批送外部服务：每批 ≤10 个文档且 ≤600k 字符
  const batches: Array<Array<ScanFile>> = [];
  let cur: ScanFile[] = [];
  let curBytes = 0;
  for (const f of files) {
    const bytes = Buffer.byteLength(f.text, "utf8");
    if (cur.length && (cur.length >= MAX_BATCH_DOCS || curBytes + bytes > MAX_BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += bytes;
  }
  if (cur.length) batches.push(cur);

  const registry: Array<{ id: string; meta: RagDocMeta }> = [];
  const summary: Array<{ id: string; name: string; rel: string; truncated: boolean }> = [];
  let chunks: number | null = null;
  for (const batch of batches) {
    const { chunks: c } = await ragIngest(batch.map((f) => ({
      id: f.id,
      name: f.name,
      text: f.text,
      meta: { source: `${rootName}/${f.rel}`, ingestedAt: new Date().toISOString() },
    })));
    if (typeof c === "number") chunks = (chunks ?? 0) + c;
    for (const f of batch) {
      registry.push({ id: f.id, meta: { name: f.name, bytes: f.text.length, chunks: null, at: Date.now(), source: `${rootName}/${f.rel}` } });
      summary.push({ id: f.id, name: f.name, rel: f.rel, truncated: f.truncated });
    }
  }
  await registerDocs(registry);
  return { ingested: summary.length, skipped: 0, chunks, docs: summary };
}

/**
 * 发消息自动入库（/api/chat 调用）：把本次 📎 的文本附件送进外部知识库。
 * 失败静默（best-effort）：RAG 不可用绝不能影响主聊天流程。
 */
export async function ingestChatAttachments(
  files: Array<{ name: string; content: string; truncated: boolean }>
): Promise<void> {
  await ensureLoaded();
  if (!isRagConfigured() || !files.length) return;
  try {
    await ingestTextBatch(files.map((f) => ({
      name: `${f.name}${f.truncated ? "（截断版）" : ""}`,
      text: f.content,
      source: "聊天附件",
    })), "聊天附件");
  } catch (e) {
    console.warn("[rag] 附件自动入库失败（不影响对话）：", e instanceof Error ? e.message : e);
  }
}

/** 多文本一次性入库（自动入库共用底层；不给 HTTP 端点直连） */
async function ingestTextBatch(
  items: Array<{ name: string; text: string; source: string }>,
  source: string
): Promise<void> {
  const documents = items
    .filter((f) => f.text.trim())
    .map((f) => {
      const text = f.text.length > MAX_FILE_CHARS ? f.text.slice(0, MAX_FILE_CHARS) : f.text;
      return { id: randomUUID(), name: f.name, text, meta: { source: f.source || source, ingestedAt: new Date().toISOString() } };
    });
  if (!documents.length) return;
  await ragIngest(documents);
  await registerDocs(documents.map((d) => ({
    id: d.id,
    meta: { name: d.name, bytes: d.text.length, chunks: null, at: Date.now(), source: (d.meta.source as string) || source },
  })));
}

export type { RagDocMeta };
