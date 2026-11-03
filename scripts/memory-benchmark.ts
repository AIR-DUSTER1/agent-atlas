/**
 * memory-benchmark.ts — 本地记忆规模与检索基准
 * ============================================================
 * 默认生成 10,000 active + 40,000 历史记录，测量首次建库、重启恢复与检索延迟。
 * 这是内部压测脚本：使用临时目录，不触碰用户真实记忆，也不调用模型/Embedding。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { MemoryRecord } from "../src/memory/provider.js";
import { memoryScope } from "../src/memory/scope.js";
import {
  configureLocalMemoryRetention,
  ensureLocalStoreLoaded,
  replaceLocalRecords,
  resetLocalStore,
} from "../src/memory/providers/local-store.js";
import { rankMemories } from "../src/memory/providers/local-search.js";
import { memorySlot } from "../src/memory/slot.js";
import { resetMemoryStore } from "../src/memory-store.js";

const TOTAL = Math.max(1000, Number(process.env.MEMORY_BENCH_TOTAL || 50_000));
const ACTIVE = Math.min(TOTAL, Math.max(100, Number(process.env.MEMORY_BENCH_ACTIVE || 10_000)));
const SEARCHES = Math.max(1, Number(process.env.MEMORY_BENCH_SEARCHES || 100));

function records(): MemoryRecord[] {
  const now = Date.now();
  const profiles = ["general", "estate", "job"] as const;
  return Array.from({ length: TOTAL }, (_, index) => {
    const profile = profiles[index % profiles.length];
    const active = index < ACTIVE;
    return {
      id: `bench-${index}`,
      scope: memoryScope(profile),
      key: active ? `基准主题${index}` : `历史主题${index}`,
      content: `这是第 ${index} 条基准记忆，包含部署、测试与回答风格关键词 ${"内容".repeat(8)}`,
      tags: [`tag-${index % 20}`],
      source: "user",
      status: active ? "active" : "superseded",
      category: index % 2 ? "preference" : "project_fact",
      confidence: 0.9,
      createdAt: now - index,
      updatedAt: now - index,
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    };
  });
}

const dir = await mkdtemp(join(tmpdir(), "agent-memory-bench-"));
process.env.MEMORY_STORE_DIR = join(dir, "memory-store");
configureLocalMemoryRetention({ activePerScope: 50_000, historyPerScope: 100_000 });
resetMemoryStore();
try {
  const data = records();
  const writeStart = performance.now();
  await replaceLocalRecords(data);
  const writeMs = performance.now() - writeStart;

  resetLocalStore();
  const loadStart = performance.now();
  await ensureLocalStoreLoaded();
  const loadMs = performance.now() - loadStart;

  const query = "基准主题 部署 回答风格";
  const scope = memoryScope("general");
  const sample = (await memorySlot.list(scope, { statuses: ["active"] })).slice(0);
  const searchStart = performance.now();
  for (let index = 0; index < SEARCHES; index += 1) rankMemories(sample, query, 50);
  const searchMs = (performance.now() - searchStart) / SEARCHES;
  console.log(JSON.stringify({
    total: TOTAL,
    active: ACTIVE,
    writeMs: Math.round(writeMs),
    loadMs: Math.round(loadMs),
    searchAvgMs: Number(searchMs.toFixed(2)),
    searches: SEARCHES,
  }, null, 2));
} finally {
  resetMemoryStore();
  delete process.env.MEMORY_STORE_DIR;
  await rm(dir, { recursive: true, force: true });
}