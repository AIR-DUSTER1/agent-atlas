/**
 * memory/providers/local-events.ts — v3 事件日志、scope 快照与 manifest
 * ============================================================
 * 每次状态变更只追加 scope 事件；压缩时生成新快照与新空日志，最后原子切换
 * manifest。崩溃发生在切换前会保留旧视图，发生在切换后则只留下可回收孤儿文件。
 */
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { MemoryRecord } from "../provider.js";
import { scopeKey } from "../scope.js";
import { atomicWriteJson, createEmptyFile, readUtf8, scopeDirectoryName } from "./local-store-paths.js";

export const MEMORY_STORE_SCHEMA_VERSION = 3;
const EVENT_COMPACT_THRESHOLD = 500;

export interface StoreScopePointer {
  profileId: string;
  userId: string;
  snapshot: string;
  events: string;
}

export interface MemoryStoreManifest {
  schemaVersion: 3;
  updatedAt: number;
  scopes: Record<string, StoreScopePointer>;
}

interface StoreSnapshot {
  schemaVersion: 3;
  scopeKey: string;
  entries: MemoryRecord[];
}

type StoreEvent =
  | { schemaVersion: 3; type: "upsert"; at: number; record: MemoryRecord }
  | { schemaVersion: 3; type: "delete"; at: number; id: string };

export interface StoreChange {
  type: "upsert" | "delete";
  record: MemoryRecord;
}

export interface LoadedStore {
  manifest: MemoryStoreManifest;
  records: MemoryRecord[];
  eventCount: number;
  badLines: number;
}

export class MemoryStoreFutureError extends Error {
  constructor(public readonly version: number) {
    super(`记忆存储 schemaVersion=${version} 高于当前支持的 ${MEMORY_STORE_SCHEMA_VERSION}，已拒绝写入`);
  }
}

function safeRelative(root: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value)) return null;
  const target = resolve(root, value);
  const rel = relative(root, target);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? value : null;
}

function normalizeManifest(value: unknown, root: string): MemoryStoreManifest {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const version = Number(raw.schemaVersion);
  if (Number.isFinite(version) && version > MEMORY_STORE_SCHEMA_VERSION) throw new MemoryStoreFutureError(version);
  if (version !== MEMORY_STORE_SCHEMA_VERSION) throw new Error("记忆 manifest schemaVersion 不受支持");
  const scopesRaw = raw.scopes && typeof raw.scopes === "object" && !Array.isArray(raw.scopes)
    ? raw.scopes as Record<string, unknown>
    : {};
  const scopes: Record<string, StoreScopePointer> = {};
  for (const [key, item] of Object.entries(scopesRaw)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const snapshot = safeRelative(root, rec.snapshot);
    const events = safeRelative(root, rec.events);
    if (!snapshot || !events || typeof rec.profileId !== "string" || typeof rec.userId !== "string") continue;
    scopes[key] = { profileId: rec.profileId, userId: rec.userId, snapshot, events };
  }
  return {
    schemaVersion: 3,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
    scopes,
  };
}

function recordMap(records: MemoryRecord[]): Map<string, MemoryRecord> {
  return new Map(records.map((record) => [record.id, record]));
}

function applyEvent(map: Map<string, MemoryRecord>, event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const raw = event as Record<string, unknown>;
  if (raw.type === "upsert" && raw.record && typeof raw.record === "object") {
    const record = raw.record as MemoryRecord;
    if (!record.id) return false;
    map.set(record.id, record);
    return true;
  }
  if (raw.type === "delete" && typeof raw.id === "string") {
    map.delete(raw.id);
    return true;
  }
  return false;
}

function parseEvents(raw: string): { entries: unknown[]; badLines: number } {
  const lines = raw.split(/\r?\n/);
  const entries: unknown[] = [];
  let badLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { entries, badLines };
}

export async function readStoreManifest(storeDir: string): Promise<MemoryStoreManifest | null> {
  const raw = await readUtf8(join(storeDir, "manifest.json"));
  if (raw === null) return null;
  try {
    return normalizeManifest(JSON.parse(raw), storeDir);
  } catch (error) {
    if (error instanceof MemoryStoreFutureError) throw error;
    throw new Error(`记忆 manifest 损坏：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadV3Store(storeDir: string, manifest: MemoryStoreManifest): Promise<LoadedStore> {
  const map = new Map<string, MemoryRecord>();
  let eventCount = 0;
  let badLines = 0;
  for (const pointer of Object.values(manifest.scopes)) {
    const snapshotRaw = await readUtf8(join(storeDir, pointer.snapshot));
    if (snapshotRaw) {
      try {
        const snapshot = JSON.parse(snapshotRaw) as StoreSnapshot;
        if (Array.isArray(snapshot.entries)) {
          for (const record of snapshot.entries) if (record?.id) map.set(record.id, record);
        } else {
          badLines += 1;
        }
      } catch {
        badLines += 1;
      }
    }
    const eventsRaw = await readUtf8(join(storeDir, pointer.events));
    if (eventsRaw) {
      const parsed = parseEvents(eventsRaw);
      eventCount += parsed.entries.length;
      badLines += parsed.badLines;
      for (const event of parsed.entries) applyEvent(map, event);
    }
  }
  return { manifest, records: [...map.values()], eventCount, badLines };
}

function groupRecords(records: MemoryRecord[]): Map<string, MemoryRecord[]> {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = scopeKey(record.scope);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return groups;
}

async function writeManifest(storeDir: string, manifest: MemoryStoreManifest): Promise<void> {
  await atomicWriteJson(join(storeDir, "manifest.json"), manifest);
}

/** 全量生成新快照代际；用于首次迁移、压缩与关闭前冲刷。 */
export async function writeStoreGenerations(storeDir: string, records: MemoryRecord[]): Promise<MemoryStoreManifest> {
  const generation = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const manifest: MemoryStoreManifest = { schemaVersion: 3, updatedAt: Date.now(), scopes: {} };
  for (const [key, entries] of groupRecords(records)) {
    const first = entries[0];
    const dirName = scopeDirectoryName(first.scope.profileId, first.scope.userId);
    const scopeDir = join(storeDir, "scopes", dirName);
    const snapshotRel = `scopes/${dirName}/snapshot-${generation}.json`;
    const eventsRel = `scopes/${dirName}/events-${generation}.ndjson`;
    await mkdir(scopeDir, { recursive: true });
    await atomicWriteJson(join(storeDir, snapshotRel), {
      schemaVersion: 3,
      scopeKey: key,
      entries,
    } satisfies StoreSnapshot);
    await createEmptyFile(join(storeDir, eventsRel));
    manifest.scopes[key] = {
      profileId: first.scope.profileId,
      userId: first.scope.userId,
      snapshot: snapshotRel,
      events: eventsRel,
    };
  }
  await writeManifest(storeDir, manifest);
  await cleanupOldGenerations(storeDir, manifest);
  return manifest;
}

async function cleanupOldGenerations(storeDir: string, manifest: MemoryStoreManifest): Promise<void> {
  const keep = new Set<string>();
  for (const pointer of Object.values(manifest.scopes)) {
    keep.add(resolve(storeDir, pointer.snapshot));
    keep.add(resolve(storeDir, pointer.events));
  }
  const scopesDir = join(storeDir, "scopes");
  const dirs = await readdir(scopesDir, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const fullDir = join(scopesDir, dir.name);
    const files = await readdir(fullDir).catch(() => []);
    for (const file of files) {
      if (!/^(?:snapshot|events)-.*\.(?:json|ndjson)$/.test(file)) continue;
      const path = resolve(fullDir, file);
      if (!keep.has(path)) await rm(path, { force: true }).catch(() => {});
    }
  }
}

async function appendEvents(path: string, events: StoreEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * 追加变更。新 scope 先建立空快照 + 空日志，再追加同一批事件；manifest 只在
 * 新 scope 出现时更新，普通 upsert 不重写 manifest。
 */
export async function appendStoreChanges(
  storeDir: string,
  manifest: MemoryStoreManifest,
  changes: StoreChange[],
  allRecords: MemoryRecord[],
): Promise<MemoryStoreManifest> {
  if (!changes.length) return manifest;
  const grouped = new Map<string, StoreChange[]>();
  for (const change of changes) {
    const key = scopeKey(change.record.scope);
    const group = grouped.get(key) ?? [];
    group.push(change);
    grouped.set(key, group);
  }
  let nextManifest = manifest;
  for (const [key, group] of grouped) {
    let pointer = nextManifest.scopes[key];
    if (!pointer) {
      const scope = group[0].record.scope;
      const dirName = scopeDirectoryName(scope.profileId, scope.userId);
      const generation = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const snapshotRel = `scopes/${dirName}/snapshot-${generation}.json`;
      const eventsRel = `scopes/${dirName}/events-${generation}.ndjson`;
      const initialEntries = allRecords.filter((record) => scopeKey(record.scope) === key);
      await atomicWriteJson(join(storeDir, snapshotRel), { schemaVersion: 3, scopeKey: key, entries: initialEntries } satisfies StoreSnapshot);
      await createEmptyFile(join(storeDir, eventsRel));
      pointer = { profileId: scope.profileId, userId: scope.userId, snapshot: snapshotRel, events: eventsRel };
      nextManifest = {
        ...nextManifest,
        updatedAt: Date.now(),
        scopes: { ...nextManifest.scopes, [key]: pointer },
      };
      await writeManifest(storeDir, nextManifest);
    }
    const events: StoreEvent[] = group.map((change) => change.type === "delete"
      ? { schemaVersion: 3, type: "delete", at: Date.now(), id: change.record.id }
      : { schemaVersion: 3, type: "upsert", at: Date.now(), record: change.record });
    await appendEvents(join(storeDir, pointer.events), events);
  }
  void allRecords;
  return nextManifest;
}

export function shouldCompact(eventCount: number): boolean {
  return eventCount >= EVENT_COMPACT_THRESHOLD;
}

export async function storeFootprint(storeDir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        files += 1;
        bytes += (await stat(path).catch(() => ({ size: 0 }))).size;
      }
    }
  }
  await walk(storeDir);
  return { bytes, files };
}

export async function quarantineStoreFile(path: string): Promise<string | undefined> {
  const target = `${path}.corrupt-${Date.now()}`;
  try {
    await rename(path, target);
    return target;
  } catch {
    return undefined;
  }
}