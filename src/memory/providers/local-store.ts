/**
 * providers/local-store.ts — 本地记忆文件、schema 迁移与原子持久化
 * ============================================================
 * 职责：唯一接触 `.setting/memories.json` 的模块。对外只暴露记录快照与串行变更，
 * 让上层 Provider 专注语义、检索模块专注排序，避免三处各自读写文件。
 *
 * 设计立场：本地记忆是小体量白名单，采用内存副本 + 全量原子重写；v1 数组
 * 自动迁移为 v2 对象，坏文件改名隔离而不是静默覆盖，未来版本文件 fail-closed。
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryRecord, MemoryScope, MemorySource, MemoryStatus } from "../provider.js";
import { DEFAULT_MEMORY_PROFILE, memoryScope, sameMemoryScope, scopeKey } from "../scope.js";

export const MEMORY_SCHEMA_VERSION = 2;
export const MAX_ACTIVE_MEMORIES = 500;
export const MAX_HISTORY_RECORDS = 1000;
export const MAX_KEY_CHARS = 50;
export const MAX_CONTENT_CHARS = 500;
export const MAX_TAGS = 6;
export const MAX_TAG_CHARS = 32;

const DEFAULT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".setting",
  "memories.json"
);

export type LocalStoreState = "ok" | "missing" | "migrated" | "corrupt" | "future" | "error";

export interface LocalMemoryStoreStatus {
  state: LocalStoreState;
  file: string;
  loaded: boolean;
  migratedFrom?: number;
  quarantinedTo?: string;
  message?: string;
  activeCount: number;
  historyCount: number;
}

interface MemoryFileV2 {
  schemaVersion: 2;
  entries: MemoryRecord[];
}

let records: MemoryRecord[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
let blocked = false;
let storeFile = resolveFile();
let statusState: LocalStoreState = "missing";
let statusExtra: Pick<LocalMemoryStoreStatus, "migratedFrom" | "quarantinedTo" | "message"> = {};
let writeQueue: Promise<void> = Promise.resolve();

function resolveFile(): string {
  return process.env.MEMORIES_FILE || DEFAULT_FILE;
}

function finiteTime(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScope(value: unknown): MemoryScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return memoryScope(DEFAULT_MEMORY_PROFILE);
  const rec = value as { profileId?: unknown; userId?: unknown };
  return memoryScope(rec.profileId, typeof rec.userId === "string" ? rec.userId : undefined);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim().slice(0, MAX_TAG_CHARS);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

function normalizeSource(value: unknown): MemorySource {
  return value === "user" || value === "import" ? value : "agent";
}

function normalizeStatus(value: unknown): MemoryStatus {
  return value === "superseded" ? "superseded" : "active";
}

function normalizeRecord(item: unknown, fallbackScope: MemoryScope): MemoryRecord | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Partial<MemoryRecord> & { source?: unknown; status?: unknown; tags?: unknown };
  const key = cleanText(rec.key);
  const content = cleanText(rec.content);
  if (!key || !content) return null;
  const now = Date.now();
  const createdAt = finiteTime(rec.createdAt, now);
  const updatedAt = finiteTime(rec.updatedAt, createdAt);
  const lastUsedAt = finiteTime(rec.lastUsedAt, 0);
  return {
    id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : randomUUID(),
    scope: normalizeScope(rec.scope ?? fallbackScope),
    key: key.slice(0, MAX_KEY_CHARS),
    content: content.slice(0, MAX_CONTENT_CHARS),
    tags: normalizeTags(rec.tags),
    source: normalizeSource(rec.source),
    status: normalizeStatus(rec.status),
    createdAt,
    updatedAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(typeof rec.useCount === "number" && Number.isFinite(rec.useCount) && rec.useCount > 0
      ? { useCount: Math.floor(rec.useCount) }
      : {}),
  };
}

/** 同 scope + key 最多一个 active；异常重复数据按 updatedAt 新者保留。 */
function normalizeRecords(items: unknown[], fallbackScope: MemoryScope): MemoryRecord[] {
  const normalized = items
    .map((item) => normalizeRecord(item, fallbackScope))
    .filter((item): item is MemoryRecord => Boolean(item))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activeKeys = new Set<string>();
  for (const item of normalized) {
    if (item.status !== "active") continue;
    const key = `${scopeKey(item.scope)}\u0000${item.key.toLocaleLowerCase()}`;
    if (activeKeys.has(key)) item.status = "superseded";
    else activeKeys.add(key);
  }
  return normalized;
}

function cloneScope(scope: MemoryScope): MemoryScope {
  return { profileId: scope.profileId, userId: scope.userId };
}

function cloneRecord(record: MemoryRecord): MemoryRecord {
  return { ...record, scope: cloneScope(record.scope), tags: [...record.tags] };
}

function cloneRecords(items: MemoryRecord[]): MemoryRecord[] {
  return items.map(cloneRecord);
}

async function persist(next: MemoryRecord[]): Promise<void> {
  const file: MemoryFileV2 = { schemaVersion: MEMORY_SCHEMA_VERSION, entries: next };
  await mkdir(dirname(storeFile), { recursive: true });
  const tmp = `${storeFile}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(file, null, 2), "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }
  try {
    await rename(tmp, storeFile);
  } catch {
    // Windows 偶发 EPERM/ENOENT：清掉旧目标后重试一次；失败时保留 tmp 供排障。
    await unlink(storeFile).catch(() => {});
    await rename(tmp, storeFile);
  }
}

async function quarantine(): Promise<string | undefined> {
  const target = `${storeFile}.corrupt-${Date.now()}`;
  try {
    await rename(storeFile, target);
    return target;
  } catch {
    return undefined;
  }
}

async function load(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(storeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      records = [];
      loaded = true;
      blocked = false;
      statusState = "missing";
      statusExtra = {};
      return;
    }
    records = [];
    loaded = true;
    blocked = false;
    statusState = "error";
    statusExtra = { message: error instanceof Error ? error.message : String(error) };
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    records = [];
    loaded = true;
    blocked = false;
    const quarantinedTo = await quarantine();
    statusState = "corrupt";
    statusExtra = {
      ...(quarantinedTo ? { quarantinedTo } : {}),
      message: error instanceof Error ? error.message : String(error),
    };
    return;
  }

  const legacy = Array.isArray(parsed);
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as { schemaVersion?: unknown; entries?: unknown }
    : null;
  const version = legacy ? 1 : object?.schemaVersion;
  if (typeof version === "number" && version > MEMORY_SCHEMA_VERSION) {
    records = [];
    loaded = true;
    blocked = true;
    statusState = "future";
    statusExtra = { message: `记忆文件 schemaVersion=${version} 高于当前支持的 ${MEMORY_SCHEMA_VERSION}，已拒绝写入；请升级或回滚应用` };
    return;
  }
  const entries = legacy ? parsed as unknown[] : object?.entries;
  if (!Array.isArray(entries)) {
    records = [];
    loaded = true;
    blocked = false;
    const quarantinedTo = await quarantine();
    statusState = "corrupt";
    statusExtra = { ...(quarantinedTo ? { quarantinedTo } : {}), message: "根对象缺少 entries 数组" };
    return;
  }

  const normalized = normalizeRecords(entries, memoryScope(DEFAULT_MEMORY_PROFILE));
  records = normalized;
  loaded = true;
  blocked = false;
  if (legacy) {
    try {
      await persist(records);
      statusState = "migrated";
      statusExtra = { migratedFrom: 1 };
    } catch (error) {
      statusState = "error";
      statusExtra = { message: `v1 迁移写入失败：${error instanceof Error ? error.message : String(error)}` };
    }
  } else {
    statusState = "ok";
    statusExtra = {};
  }
}

export async function ensureLocalStoreLoaded(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = load().finally(() => { loading = null; });
  }
  await loading;
}

export async function readLocalRecords(): Promise<MemoryRecord[]> {
  await ensureLocalStoreLoaded();
  return cloneRecords(records);
}

/** 已加载状态下供同步列表视图使用；调用方必须先 await 加载入口。 */
export function loadedLocalRecords(): MemoryRecord[] {
  return cloneRecords(records);
}

function normalizeAfterMutation(next: MemoryRecord[]): MemoryRecord[] {
  return normalizeRecords(next, memoryScope(DEFAULT_MEMORY_PROFILE))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 串行变更：加载、修改、全量落盘必须在一个临界区内完成。 */
export async function updateLocalRecords<T>(mutator: (draft: MemoryRecord[]) => T): Promise<T> {
  let result!: T;
  const run = writeQueue.then(async () => {
    await ensureLocalStoreLoaded();
    if (blocked) {
      throw new Error(statusExtra.message || "记忆文件版本不受支持，已拒绝写入");
    }
    const draft = cloneRecords(records);
    result = mutator(draft);
    const normalized = normalizeAfterMutation(draft);
    await persist(normalized);
    records = normalized;
    statusState = "ok";
    statusExtra = {};
  });
  writeQueue = run.catch(() => {});
  await run;
  return result;
}

export async function replaceLocalRecords(next: MemoryRecord[]): Promise<void> {
  await updateLocalRecords((draft) => {
    draft.splice(0, draft.length, ...cloneRecords(next));
  });
}

export function countActiveRecords(items: MemoryRecord[], scope?: MemoryScope): number {
  return items.filter((item) => item.status === "active" && (!scope || sameMemoryScope(item.scope, scope))).length;
}

export function localMemoryStoreStatus(): LocalMemoryStoreStatus {
  return {
    state: statusState,
    file: storeFile,
    loaded,
    ...statusExtra,
    activeCount: countActiveRecords(records),
    historyCount: records.length,
  };
}

export function memoriesFilePath(): string {
  return storeFile;
}

/** 测试与恢复后重载：清空内存态并重绑 MEMORIES_FILE。 */
export function resetLocalStore(): void {
  records = [];
  loaded = false;
  loading = null;
  blocked = false;
  storeFile = resolveFile();
  statusState = "missing";
  statusExtra = {};
  writeQueue = Promise.resolve();
}
