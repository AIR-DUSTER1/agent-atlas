/**
 * memory/vector-index.ts — scope 级向量索引文件
 * ============================================================
 * 向量与事件日志分开存放，避免正文事件被大数组拖慢。写入使用原子替换；
 * 模型名或维度不匹配时整份索引视为失效，由调用方后台重建。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoryScope } from "./provider.js";
import { scopeKey } from "./scope.js";
import { atomicWriteJson, scopeDirectoryName } from "./providers/local-store-paths.js";
import { memoryStoreDir } from "./providers/local-store.js";

export const VECTOR_INDEX_SCHEMA_VERSION = 1;

export interface StoredVector {
  vector: number[];
  hash: string;
  updatedAt: number;
}

interface VectorIndexFile {
  schemaVersion: 1;
  model: string;
  dimensions: number;
  updatedAt: number;
  vectors: Record<string, StoredVector>;
}

let cache: { path: string; value: VectorIndexFile } | null = null;
const queues = new Map<string, Promise<void>>();

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function indexPath(scope: MemoryScope): string {
  return join(
    memoryStoreDir(),
    "scopes",
    scopeDirectoryName(scope.profileId, scope.userId),
    "index",
    "vectors.json",
  );
}

async function readIndex(path: string): Promise<VectorIndexFile | null> {
  if (cache?.path === path) return cache.value;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as VectorIndexFile;
    if (parsed.schemaVersion !== VECTOR_INDEX_SCHEMA_VERSION || !parsed.vectors) return null;
    cache = { path, value: parsed };
    return parsed;
  } catch {
    return null;
  }
}

async function writeIndex(path: string, value: VectorIndexFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, value);
  cache = { path, value };
}

function enqueue(path: string, work: () => Promise<void>): Promise<void> {
  const previous = queues.get(path) ?? Promise.resolve();
  const run = previous.then(work);
  queues.set(path, run.catch(() => {}));
  return run;
}

export interface VectorIndexSnapshot {
  model: string;
  dimensions: number;
  vectors: Map<string, StoredVector>;
  updatedAt: number;
}

export async function loadVectorIndex(scope: MemoryScope): Promise<VectorIndexSnapshot | null> {
  const path = indexPath(scope);
  const parsed = await readIndex(path);
  if (!parsed) return null;
  return {
    model: parsed.model,
    dimensions: parsed.dimensions,
    vectors: new Map(Object.entries(parsed.vectors)),
    updatedAt: parsed.updatedAt,
  };
}

export interface VectorWrite {
  recordId: string;
  vector: number[];
  hash: string;
}

export async function upsertVectors(
  scope: MemoryScope,
  model: string,
  dimensions: number,
  writes: VectorWrite[],
): Promise<void> {
  if (!writes.length) return;
  const path = indexPath(scope);
  await enqueue(path, async () => {
    const current = await readIndex(path);
    const compatible = current && current.model === model && current.dimensions === dimensions;
    const value: VectorIndexFile = compatible
      ? { ...current, updatedAt: Date.now(), vectors: { ...current.vectors } }
      : {
          schemaVersion: VECTOR_INDEX_SCHEMA_VERSION,
          model,
          dimensions,
          updatedAt: Date.now(),
          vectors: {},
        };
    const now = Date.now();
    for (const write of writes) {
      value.vectors[write.recordId] = { vector: write.vector, hash: write.hash, updatedAt: now };
    }
    await writeIndex(path, value);
  });
}

export async function upsertVector(
  scope: MemoryScope,
  recordId: string,
  model: string,
  dimensions: number,
  vector: number[],
  hash: string,
): Promise<void> {
  await upsertVectors(scope, model, dimensions, [{ recordId, vector, hash }]);
}

export async function removeVector(scope: MemoryScope, recordId: string): Promise<void> {
  const path = indexPath(scope);
  await enqueue(path, async () => {
    const current = await readIndex(path);
    if (!current || !(recordId in current.vectors)) return;
    const vectors = { ...current.vectors };
    delete vectors[recordId];
    await writeIndex(path, { ...current, updatedAt: Date.now(), vectors });
  });
}

export async function clearVectorIndex(scope: MemoryScope): Promise<void> {
  const path = indexPath(scope);
  await enqueue(path, async () => {
    cache = null;
    await unlink(path).catch(() => {});
  });
}

export function vectorIndexScopeKey(scope: MemoryScope): string {
  return scopeKey(scope);
}