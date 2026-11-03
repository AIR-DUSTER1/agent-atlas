/**
 * providers/local-store.ts — 本地记忆内存索引、v2 迁移与事件存储适配
 * ============================================================
 * 职责：唯一接触 `.setting/memory-store/` 的模块。对外只暴露记录快照与串行变更；
 * 事件日志、快照和 manifest 由 local-events 处理，生命周期由 lifecycle 处理。
 *
 * 设计立场：单进程内维护记录索引，所有写操作串行；每次变更先 append 事件再更新
 * 内存，达到阈值后生成新快照代际。损坏文件隔离而不是静默覆盖，未来版本 fail-closed。
 */
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import type { MemoryCategory, MemoryRecord, MemoryScope, MemorySource, MemoryStatus } from "../provider.js";
import { DEFAULT_MEMORY_PROFILE, memoryScope, sameMemoryScope, scopeKey } from "../scope.js";
import { applyLifecycleTransitions } from "../lifecycle.js";
import {
  MEMORY_STORE_SCHEMA_VERSION,
  MemoryStoreFutureError,
  appendStoreChanges,
  loadV3Store,
  readStoreManifest,
  shouldCompact,
  storeFootprint,
  writeStoreGenerations,
  type MemoryStoreManifest,
  type StoreChange,
} from "./local-events.js";
import {
  resolveLegacyMemoryFile,
  resolveMemoryStoreDir,
} from "./local-store-paths.js";

export const MEMORY_SCHEMA_VERSION = MEMORY_STORE_SCHEMA_VERSION;
export const MAX_ACTIVE_MEMORIES = 2000;
export const MAX_HISTORY_RECORDS = 5000;
export const MAX_KEY_CHARS = 50;
export const MAX_CONTENT_CHARS = 500;
export const MAX_TAGS = 6;
export const MAX_TAG_CHARS = 32;

export type LocalStoreState = "ok" | "missing" | "migrated" | "corrupt" | "future" | "error" | "degraded";

export interface LocalMemoryStoreStatus {
  state: LocalStoreState;
  file: string;
  storeDir: string;
  loaded: boolean;
  migratedFrom?: number;
  quarantinedTo?: string;
  message?: string;
  activeCount: number;
  candidateCount: number;
  staleCount: number;
  historyCount: number;
  eventCount: number;
  bytes?: number;
}

let activePerScope = MAX_ACTIVE_MEMORIES;
let historyPerScope = MAX_HISTORY_RECORDS;
let records: MemoryRecord[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
let blocked = false;
let storeDir = resolveMemoryStoreDir();
let legacyFile = resolveLegacyMemoryFile();
let manifest: MemoryStoreManifest | null = null;
let statusState: LocalStoreState = "missing";
let statusExtra: Pick<LocalMemoryStoreStatus, "migratedFrom" | "quarantinedTo" | "message" | "bytes"> = {};
let writeQueue: Promise<void> = Promise.resolve();
let usageDirty = false;
let usageTimer: ReturnType<typeof setTimeout> | undefined;
let eventCount = 0;

export function configureLocalMemoryRetention(options: { activePerScope?: number; historyPerScope?: number }): void {
  if (Number.isInteger(options.activePerScope) && options.activePerScope! > 0) activePerScope = options.activePerScope!;
  if (Number.isInteger(options.historyPerScope) && options.historyPerScope! > 0) historyPerScope = options.historyPerScope!;
  if (historyPerScope < activePerScope) historyPerScope = activePerScope;
}

export function activeMemoryLimit(): number { return activePerScope; }
export function historyMemoryLimit(): number { return historyPerScope; }
export function memoryStoreDir(): string { return storeDir; }
export function memoriesFilePath(): string { return legacyFile; }

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
  return value === "candidate" || value === "stale" || value === "superseded" || value === "archived"
    ? value
    : "active";
}

function normalizeCategory(value: unknown): MemoryCategory {
  return value === "preference" || value === "project_fact" || value === "correction" || value === "identity"
    ? value
    : "other";
}

function normalizeOrigin(value: unknown): MemoryRecord["origin"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const mode = rec.mode === "manual" || rec.mode === "agent_tool" || rec.mode === "auto" || rec.mode === "import" || rec.mode === "http"
    ? rec.mode
    : undefined;
  if (!mode) return undefined;
  return {
    mode,
    ...(typeof rec.sessionId === "string" ? { sessionId: rec.sessionId.slice(0, 160) } : {}),
    ...(typeof rec.turnId === "string" ? { turnId: rec.turnId.slice(0, 160) } : {}),
  };
}

function normalizeRecord(item: unknown, fallbackScope: MemoryScope): MemoryRecord | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Partial<MemoryRecord> & { source?: unknown; status?: unknown; tags?: unknown; origin?: unknown };
  const key = cleanText(rec.key);
  const content = cleanText(rec.content);
  if (!key || !content) return null;
  const now = Date.now();
  const createdAt = finiteTime(rec.createdAt, now);
  const updatedAt = finiteTime(rec.updatedAt, createdAt);
  const lastUsedAt = finiteTime(rec.lastUsedAt, 0);
  const expiresAt = finiteTime(rec.expiresAt, 0);
  const staleAt = finiteTime(rec.staleAt, 0);
  const lastConfirmedAt = finiteTime(rec.lastConfirmedAt, 0);
  return {
    id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : randomUUID(),
    scope: normalizeScope(rec.scope ?? fallbackScope),
    key: key.slice(0, MAX_KEY_CHARS),
    content: content.slice(0, MAX_CONTENT_CHARS),
    tags: normalizeTags(rec.tags),
    source: normalizeSource(rec.source),
    status: normalizeStatus(rec.status),
    category: normalizeCategory(rec.category),
    confidence: typeof rec.confidence === "number" && Number.isFinite(rec.confidence)
      ? Math.max(0, Math.min(1, rec.confidence))
      : 1,
    ...(expiresAt ? { expiresAt } : {}),
    ...(staleAt ? { staleAt } : {}),
    ...(lastConfirmedAt ? { lastConfirmedAt } : {}),
    ...(normalizeOrigin(rec.origin) ? { origin: normalizeOrigin(rec.origin) } : {}),
    ...(typeof rec.replacedBy === "string" && rec.replacedBy ? { replacedBy: rec.replacedBy } : {}),
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
  return {
    ...record,
    scope: cloneScope(record.scope),
    tags: [...record.tags],
    ...(record.origin ? { origin: { ...record.origin } } : {}),
  };
}

function cloneRecords(items: MemoryRecord[]): MemoryRecord[] {
  return items.map(cloneRecord);
}

/** 每个 scope 独立裁剪：preserve 状态优先，剩余槽位按更新时间保留最新的历史版本。 */
function pruneHistory(items: MemoryRecord[]): MemoryRecord[] {
  const groups = new Map<string, MemoryRecord[]>();
  for (const item of items) {
    const key = scopeKey(item.scope);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const keep = new Set<string>();
  for (const group of groups.values()) {
    const preserve = group.filter((item) => item.status !== "superseded" && item.status !== "archived");
    const removable = group
      .filter((item) => item.status === "superseded" || item.status === "archived")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const item of preserve) keep.add(item.id);
    const slots = Math.max(0, historyPerScope - preserve.length);
    for (const item of removable.slice(-slots)) keep.add(item.id);
  }
  return items.filter((item) => keep.has(item.id));
}

function normalizeAfterMutation(next: unknown[]): MemoryRecord[] {
  return pruneHistory(normalizeRecords(next, memoryScope(DEFAULT_MEMORY_PROFILE)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function changeList(previous: MemoryRecord[], next: MemoryRecord[]): StoreChange[] {
  const before = new Map(previous.map((record) => [record.id, record]));
  const after = new Map(next.map((record) => [record.id, record]));
  const changes: StoreChange[] = [];
  for (const [id, record] of after) {
    const old = before.get(id);
    if (!old || JSON.stringify(old) !== JSON.stringify(record)) {
      changes.push({ type: "upsert", record });
    }
  }
  for (const [id, record] of before) {
    if (!after.has(id)) changes.push({ type: "delete", record });
  }
  return changes;
}

async function readLegacyRecords(): Promise<{ entries: unknown[]; version: number } | null> {
  let raw: string;
  try {
    raw = await readFile(legacyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const quarantineTarget = `${legacyFile}.corrupt-${Date.now()}`;
    await rename(legacyFile, quarantineTarget).catch(() => {});
    statusState = "corrupt";
    statusExtra = { ...(quarantineTarget ? { quarantinedTo: quarantineTarget } : {}), message: "旧记忆文件不是合法 JSON" };
    return { entries: [], version: 2 };
  }
  const legacy = Array.isArray(parsed);
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as { schemaVersion?: unknown; entries?: unknown }
    : null;
  const version = legacy ? 1 : Number(object?.schemaVersion ?? 0);
  if (version > 2) throw new Error(`旧记忆文件 schemaVersion=${version} 不受支持`);
  const entries = legacy ? parsed as unknown[] : object?.entries;
  if (!Array.isArray(entries)) {
    const quarantineTarget = `${legacyFile}.corrupt-${Date.now()}`;
    await rename(legacyFile, quarantineTarget).catch(() => {});
    statusState = "corrupt";
    statusExtra = { ...(quarantineTarget ? { quarantinedTo: quarantineTarget } : {}), message: "旧记忆文件缺少 entries 数组" };
    return { entries: [], version: 2 };
  }
  return { entries, version };
}

async function load(): Promise<void> {
  storeDir = resolveMemoryStoreDir();
  legacyFile = resolveLegacyMemoryFile();
  try {
    const existing = await readStoreManifest(storeDir);
    if (existing) {
      manifest = existing;
      const loadedStore = await loadV3Store(storeDir, existing);
      records = normalizeAfterMutation(loadedStore.records);
      eventCount = loadedStore.eventCount;
      loaded = true;
      blocked = false;
      statusState = loadedStore.badLines ? "degraded" : "ok";
      statusExtra = loadedStore.badLines ? { message: `已跳过 ${loadedStore.badLines} 条损坏记忆记录` } : {};
      return;
    }

    const legacy = await readLegacyRecords();
    if (!legacy) {
      records = [];
      manifest = null;
      loaded = true;
      blocked = false;
      statusState = "missing";
      statusExtra = {};
      return;
    }
    records = normalizeAfterMutation(legacy.entries);
    manifest = await writeStoreGenerations(storeDir, records);
    eventCount = 0;
    const backup = `${legacyFile}.v2-backup`;
    await rename(legacyFile, backup).catch(() => {});
    loaded = true;
    blocked = false;
    statusState = statusState === "corrupt" ? "corrupt" : "migrated";
    statusExtra = { ...statusExtra, migratedFrom: legacy.version };
  } catch (error) {
    records = [];
    loaded = true;
    // v3 manifest 或回放出错时必须 fail-closed：宁可只读，也不能用空内存覆盖原存储。
    blocked = true;
    if (error instanceof MemoryStoreFutureError) {
      statusState = "future";
      statusExtra = { message: error.message };
    } else {
      statusState = "error";
      statusExtra = { message: error instanceof Error ? error.message : String(error) };
    }
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

async function persistState(previous: MemoryRecord[], next: MemoryRecord[]): Promise<void> {
  const changes = changeList(previous, next);
  if (!changes.length) return;
  if (!manifest) {
    manifest = await writeStoreGenerations(storeDir, next);
    eventCount = 0;
  } else {
    manifest = await appendStoreChanges(storeDir, manifest, changes, next);
    eventCount += changes.length;
    if (shouldCompact(eventCount)) {
      manifest = await writeStoreGenerations(storeDir, next);
      eventCount = 0;
    }
  }
  usageDirty = false;
  if (usageTimer) clearTimeout(usageTimer);
  usageTimer = undefined;
  statusState = "ok";
  statusExtra = {};
}

/** 串行变更：生命周期推进、加载、修改、事件落盘必须在一个临界区内完成。 */
export async function updateLocalRecords<T>(mutator: (draft: MemoryRecord[]) => T): Promise<T> {
  let result!: T;
  const run = writeQueue.then(async () => {
    await ensureLocalStoreLoaded();
    if (blocked) throw new Error(statusExtra.message || "记忆文件版本不受支持，已拒绝写入");
    const lifecycle = applyLifecycleTransitions(records);
    const base = lifecycle.records;
    const draft = cloneRecords(base);
    result = mutator(draft);
    const normalized = normalizeAfterMutation(draft);
    await persistState(records, normalized);
    records = normalized;
  });
  writeQueue = run.catch(() => {});
  await run;
  return result;
}

/** 读列表中短暂推进到期状态；没有变化时零写盘。 */
export async function refreshLocalLifecycle(): Promise<void> {
  const run = writeQueue.then(async () => {
    await ensureLocalStoreLoaded();
    if (blocked) return;
    const lifecycle = applyLifecycleTransitions(records);
    if (!lifecycle.changed) return;
    const normalized = normalizeAfterMutation(lifecycle.records);
    await persistState(records, normalized);
    records = normalized;
  });
  writeQueue = run.catch(() => {});
  await run;
}

function scheduleUsagePersist(): void {
  if (usageTimer) return;
  usageTimer = setTimeout(() => {
    usageTimer = undefined;
    void flushLocalUsage().catch(() => {});
  }, 1000);
  usageTimer.unref?.();
}

/** 检索命中后只更新内存计数，1 秒合并落盘；高频对话不会每轮都重写整份索引。 */
export function touchLocalRecords(ids: string[], now = Date.now()): MemoryRecord[] {
  if (!loaded || blocked || !ids.length) return [];
  const targets = new Set(ids);
  const touched: MemoryRecord[] = [];
  for (const record of records) {
    if (record.status !== "active" || !targets.has(record.id)) continue;
    record.lastUsedAt = now;
    record.useCount = (record.useCount ?? 0) + 1;
    touched.push(cloneRecord(record));
  }
  if (touched.length) {
    usageDirty = true;
    scheduleUsagePersist();
  }
  return touched;
}

/** 关停、测试或设置页刷新前强制把命中计数并回快照。 */
export async function flushLocalUsage(): Promise<void> {
  const run = writeQueue.then(async () => {
    await ensureLocalStoreLoaded();
    if (!usageDirty || blocked) return;
    manifest = await writeStoreGenerations(storeDir, records);
    eventCount = 0;
    usageDirty = false;
    statusState = "ok";
    statusExtra = {};
  });
  writeQueue = run.catch(() => {});
  await run;
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
    file: legacyFile,
    storeDir,
    loaded,
    ...statusExtra,
    activeCount: countActiveRecords(records),
    candidateCount: records.filter((item) => item.status === "candidate").length,
    staleCount: records.filter((item) => item.status === "stale").length,
    historyCount: records.length,
    eventCount,
  };
}

export async function localMemoryStoreStatusAsync(): Promise<LocalMemoryStoreStatus> {
  const status = localMemoryStoreStatus();
  const footprint = await storeFootprint(storeDir);
  return { ...status, bytes: footprint.bytes };
}

/** 测试与恢复后重载：清空内存态并重绑路径。 */
export function resetLocalStore(): void {
  records = [];
  loaded = false;
  loading = null;
  blocked = false;
  storeDir = resolveMemoryStoreDir();
  legacyFile = resolveLegacyMemoryFile();
  manifest = null;
  statusState = "missing";
  statusExtra = {};
  writeQueue = Promise.resolve();
  usageDirty = false;
  usageTimer = undefined;
  eventCount = 0;
}