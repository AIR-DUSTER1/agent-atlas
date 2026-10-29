/**
 * providers/local-search.ts — 无 embedding 的确定性记忆相关性排序
 * ============================================================
 * 用 key / tag / content / 中文 bigram / 最近使用五项加权，兼顾中英文短查询；
 * 只返回当前 scope 的 active 记录。算法可解释、零网络、零新增依赖。
 */
import type { MemoryRecord } from "../provider.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_DAYS = 30;

export interface RankedMemory {
  record: MemoryRecord;
  score: number;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function queryTokens(query: string): string[] {
  const text = normalize(query);
  if (!text) return [];
  const tokens = new Set<string>();
  for (const part of text.split(/[\s,，。.!！?？;；:：/\\|()[\]{}<>《》"']+/u)) {
    if (part) tokens.add(part);
  }
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens].filter(Boolean);
}

function recencyBonus(record: MemoryRecord, now: number): number {
  const usedAt = record.lastUsedAt ?? record.updatedAt;
  const ageDays = Math.max(0, now - usedAt) / DAY_MS;
  return Math.max(0, 1 - ageDays / RECENCY_DAYS);
}

/** 分数仅用于同一 scope 内排序；0 分表示与当前问题无关，不参与注入。 */
export function rankMemories(records: MemoryRecord[], query: string, limit = 8, now = Date.now()): RankedMemory[] {
  const tokens = queryTokens(query);
  if (!tokens.length) {
    return records
      .filter((record) => record.status === "active")
      .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
      .slice(0, Math.max(1, limit))
      .map((record) => ({ record, score: 0 }));
  }

  const ranked: RankedMemory[] = [];
  for (const record of records) {
    if (record.status !== "active") continue;
    const key = normalize(record.key);
    const content = normalize(record.content);
    const tags = record.tags.map(normalize);
    const all = `${key}\n${content}\n${tags.join(" ")}`;
    let score = 0;
    for (const token of tokens) {
      if (key === token) score += 8;
      else if (key.includes(token)) score += 5;
      if (tags.some((tag) => tag === token)) score += 4;
      if (content.includes(token)) score += 3;
      if (/\p{Script=Han}/u.test(token) && token.length === 2 && all.includes(token)) score += 2;
    }
    if (score <= 0) continue;
    score += recencyBonus(record, now);
    ranked.push({ record, score });
  }
  return ranked
    .sort((a, b) =>
      b.score - a.score ||
      (b.record.lastUsedAt ?? b.record.updatedAt) - (a.record.lastUsedAt ?? a.record.updatedAt) ||
      a.record.key.localeCompare(b.record.key)
    )
    .slice(0, Math.max(1, limit));
}
