/**
 * memory/semantic.ts — 可选 Embedding 与混合召回
 * ============================================================
 * 外部 Embedding 只负责“候选召回”，最终仍通过生命状态、scope、置信度与注入预算
 * 过滤；服务不可用或维度不匹配时静默降级到现有词法排序，绝不阻塞聊天。
 */
import type { MemoryRecord, MemoryScope } from "./provider.js";
import { rankMemories, type RankedMemory } from "./providers/local-search.js";
import {
  contentHash,
  loadVectorIndex,
  removeVector,
  upsertVector,
  upsertVectors,
} from "./vector-index.js";

export interface SemanticMemoryConfig {
  enabled: boolean;
  baseURL: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  dimensions: number;
  minSimilarity: number;
}

export interface SemanticMemoryStatus {
  enabled: boolean;
  model: string;
  indexed: number;
  dimensions: number;
  updatedAt: number | null;
  message?: string;
}

export interface HybridSearchResult {
  records: MemoryRecord[];
  semantic: boolean;
  degraded: boolean;
  message?: string;
}

let config: SemanticMemoryConfig = {
  enabled: false,
  baseURL: "",
  model: "",
  apiKey: "",
  timeoutMs: 8000,
  dimensions: 0,
  minSimilarity: 0.25,
};

export function configureSemanticMemory(next: SemanticMemoryConfig | null): void {
  config = next ? { ...next } : {
    enabled: false,
    baseURL: "",
    model: "",
    apiKey: "",
    timeoutMs: 8000,
    dimensions: 0,
    minSimilarity: 0.25,
  };
}

export function semanticMemoryConfig(): SemanticMemoryConfig {
  return { ...config };
}

export function memoryEmbeddingAvailable(): boolean {
  return config.enabled && Boolean(config.baseURL && config.model);
}

function endpoint(): string {
  return config.baseURL.endsWith("/embeddings") ? config.baseURL : `${config.baseURL.replace(/\/+$/, "")}/embeddings`;
}

function asVectors(payload: unknown): number[][] {
  if (!payload || typeof payload !== "object") throw new Error("Embedding 响应不是 JSON 对象");
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("Embedding 响应缺少 data 数组");
  return data.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Embedding data 项格式错误");
    const vector = (item as { embedding?: unknown }).embedding;
    if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Embedding 返回了非法向量");
    }
    return vector as number[];
  });
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!memoryEmbeddingAvailable()) throw new Error("语义召回未启用");
  if (!texts.length) return [];
  let response: Response;
  try {
    response = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error && /timeout|abort/i.test(error.message)
      ? "Embedding 请求超时"
      : `Embedding 请求失败：${error instanceof Error ? error.message : String(error)}`;
    throw new Error(message);
  }
  if (!response.ok) throw new Error(`Embedding 服务返回 HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Embedding 响应不是合法 JSON");
  }
  const vectors = asVectors(payload);
  if (vectors.length !== texts.length) throw new Error("Embedding 返回数量与输入不一致");
  const dimensions = vectors[0]?.length ?? 0;
  if (config.dimensions > 0 && dimensions !== config.dimensions) {
    throw new Error(`Embedding 维度为 ${dimensions}，配置要求 ${config.dimensions}`);
  }
  if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("Embedding 返回的向量维度不一致");
  return vectors;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  if (!aa || !bb) return 0;
  return dot / Math.sqrt(aa * bb);
}

function embeddingText(record: MemoryRecord): string {
  return `${record.key}\n${record.tags.join(" ")}\n${record.content}`;
}

export async function indexMemoryRecord(record: MemoryRecord): Promise<void> {
  if (!memoryEmbeddingAvailable() || record.status !== "active") return;
  const text = embeddingText(record);
  const [vector] = await embedTexts([text]);
  await upsertVector(record.scope, record.id, config.model, vector.length, vector, contentHash(text));
}

export function scheduleMemoryEmbedding(record: MemoryRecord): void {
  void indexMemoryRecord(record).catch(() => {});
}

export function scheduleVectorRemoval(scope: MemoryScope, recordId: string): void {
  void removeVector(scope, recordId).catch(() => {});
}

export async function rebuildMemoryVectorIndex(scope: MemoryScope, records: MemoryRecord[]): Promise<SemanticMemoryStatus> {
  if (!memoryEmbeddingAvailable()) throw new Error("语义召回未启用或配置不完整");
  const active = records.filter((record) => record.status === "active");
  for (let start = 0; start < active.length; start += 16) {
    const batch = active.slice(start, start + 16);
    const texts = batch.map(embeddingText);
    const vectors = await embedTexts(texts);
    const dimensions = vectors[0]?.length ?? 0;
    await upsertVectors(scope, config.model, dimensions, batch.map((record, index) => ({
      recordId: record.id,
      vector: vectors[index],
      hash: contentHash(texts[index]),
    })));
  }
  return semanticMemoryStatus(scope, active.length);
}

export async function semanticMemoryStatus(scope: MemoryScope, activeCount?: number): Promise<SemanticMemoryStatus> {
  const index = await loadVectorIndex(scope);
  return {
    enabled: memoryEmbeddingAvailable(),
    model: config.model,
    indexed: index?.vectors.size ?? 0,
    dimensions: index?.dimensions ?? config.dimensions,
    updatedAt: index?.updatedAt ?? null,
    ...(activeCount !== undefined && index && index.vectors.size < activeCount
      ? { message: `索引待补齐：${index.vectors.size}/${activeCount}` }
      : {}),
  };
}

function fusedRank(
  lexical: RankedMemory[],
  vector: Array<{ record: MemoryRecord; similarity: number }>,
): Array<{ record: MemoryRecord; score: number }> {
  const scores = new Map<string, { record: MemoryRecord; score: number }>();
  for (const [index, item] of lexical.entries()) {
    scores.set(item.record.id, { record: item.record, score: 1 / (60 + index + 1) });
  }
  for (const [index, item] of vector.entries()) {
    const current = scores.get(item.record.id);
    const score = 1 / (60 + index + 1);
    scores.set(item.record.id, { record: item.record, score: (current?.score ?? 0) + score });
  }
  const now = Date.now();
  return [...scores.values()]
    .map((item) => {
      const confirmed = item.record.lastConfirmedAt ? 0.0015 : 0;
      const confidence = (item.record.confidence ?? 1) * 0.001;
      const ageDays = Math.max(0, now - (item.record.lastUsedAt ?? item.record.updatedAt)) / 86_400_000;
      return { ...item, score: item.score + confirmed + confidence + Math.max(0, 1 - ageDays / 180) * 0.0005 };
    })
    .sort((a, b) => b.score - a.score);
}

export async function hybridMemoryRank(records: MemoryRecord[], query: string, limit: number): Promise<HybridSearchResult> {
  const lexical = rankMemories(records, query, 50);
  if (!memoryEmbeddingAvailable() || !query.trim()) {
    return {
      records: lexical.slice(0, limit).map((item) => item.record),
      semantic: false,
      degraded: false,
    };
  }
  try {
    const index = await loadVectorIndex(records[0]?.scope ?? { profileId: "general", userId: "local" });
    if (!index || index.model !== config.model) {
      return {
        records: lexical.slice(0, limit).map((item) => item.record),
        semantic: false,
        degraded: true,
        message: "向量索引尚未构建，已降级词法召回",
      };
    }
    const [queryVector] = await embedTexts([query]);
    const active = records.filter((record) => record.status === "active");
    const vectors = active
      .map((record) => {
        const stored = index.vectors.get(record.id);
        if (!stored || stored.hash !== contentHash(embeddingText(record))) return null;
        const similarity = cosine(queryVector, stored.vector);
        return similarity >= config.minSimilarity ? { record, similarity } : null;
      })
      .filter((item): item is { record: MemoryRecord; similarity: number } => Boolean(item))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 50);
    return {
      records: fusedRank(lexical, vectors).slice(0, limit).map((item) => item.record),
      semantic: true,
      degraded: false,
    };
  } catch (error) {
    return {
      records: lexical.slice(0, limit).map((item) => item.record),
      semantic: false,
      degraded: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}