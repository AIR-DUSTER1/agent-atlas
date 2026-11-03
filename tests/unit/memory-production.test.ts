/**
 * memory-production.test.ts — 自动沉淀、生命周期与语义召回回归
 * ============================================================
 * 守：候选不注入且确认后生效、TTL 自动 stale、模型输出归一化、Embedding 失败降级
 * 与向量召回可工作。所有外部服务均用本地 mock，不消耗真实 API 配额。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resetMemoryStore } from "../../src/memory-store.js";
import { memorySlot } from "../../src/memory/slot.js";
import { memoryScope } from "../../src/memory/scope.js";
import { heuristicMemoryProposals, normalizeMemoryProposals } from "../../src/memory/distillation.js";
import { configureMemoryDistillation, distillTurn, resetMemoryDistillationForTests } from "../../src/server/memory-distillation.js";
import { applyLifecycleTransitions } from "../../src/memory/lifecycle.js";
import { configureSemanticMemory, rebuildMemoryVectorIndex } from "../../src/memory/semantic.js";
import { localMemoryStoreStatus as memorySlotLocalStatus, readLocalRecords } from "../../src/memory/providers/local-store.js";

async function freshStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-memory-prod-"));
  process.env.MEMORIES_FILE = join(dir, "memories.json");
  process.env.MEMORY_STORE_DIR = join(dir, "memory-store");
  resetMemoryStore();
  return dir;
}

async function dropStore(dir: string): Promise<void> {
  delete process.env.MEMORIES_FILE;
  delete process.env.MEMORY_STORE_DIR;
  resetMemoryStore();
  resetMemoryDistillationForTests();
  configureSemanticMemory(null);
  await rm(dir, { recursive: true, force: true });
}

test("自动沉降低置信候选默认不注入，确认后才成为 active", async () => {
  const dir = await freshStore();
  try {
    configureMemoryDistillation({ mode: "confirm", maxPerTurn: 3, hourlyLimit: 20 });
    const result = await distillTurn({
      sessionId: "s1",
      turnId: "t1",
      profileId: "general",
      userText: "请记住：以后回答都先给结论，少用列表。",
      assistantText: "好的。",
    }, {
      complete: async () => JSON.stringify({
        memories: [{
          action: "create",
          key: "回答风格",
          content: "回答先给结论，少用列表",
          category: "preference",
          confidence: 0.92,
        }],
      }),
    });
    assert.equal(result.saved, 1);
    assert.equal(result.activated, 0, "confirm 模式不能自动激活");
    assert.equal(await memorySlot.note({ scope: memoryScope("general"), query: "回答风格" }), null);
    const candidates = await memorySlot.list(memoryScope("general"), { statuses: ["candidate"] });
    assert.equal(candidates.length, 1);
    const active = await memorySlot.confirm(candidates[0].id, memoryScope("general"));
    assert.equal(active?.status, "active");
    assert.match((await memorySlot.note({ scope: memoryScope("general"), query: "回答风格" })) ?? "", /先给结论/);
  } finally {
    await dropStore(dir);
  }
});

test("自动沉淀 smart 模式只自动激活高置信非身份记忆", async () => {
  const dir = await freshStore();
  try {
    configureMemoryDistillation({ mode: "smart", maxPerTurn: 3, hourlyLimit: 20 });
    await distillTurn({
      sessionId: "s2",
      turnId: "t2",
      profileId: "general",
      userText: "以后项目测试统一用 npm test。",
      assistantText: "已记录。",
    }, {
      complete: async () => JSON.stringify({
        memories: [
          { action: "create", key: "测试命令", content: "项目测试统一用 npm test", category: "project_fact", confidence: 0.91 },
          { action: "create", key: "用户称呼", content: "称用户为老师", category: "identity", confidence: 0.99 },
        ],
      }),
    });
    const active = await memorySlot.list(memoryScope("general"), { statuses: ["active"] });
    const candidates = await memorySlot.list(memoryScope("general"), { statuses: ["candidate"] });
    assert.equal(active.length, 1);
    assert.equal(active[0].key, "测试命令");
    assert.equal(candidates.length, 1, "identity 始终需要人工确认");
  } finally {
    await dropStore(dir);
  }
});

test("生命周期：到期 active 自动 stale，宽限后归档", () => {
  const now = Date.now();
  const base = {
    id: "m1",
    scope: memoryScope("general"),
    key: "偏好",
    content: "结论先行",
    tags: [],
    source: "agent" as const,
    category: "preference" as const,
    createdAt: now - 1000,
    updatedAt: now - 1000,
  };
  const stale = applyLifecycleTransitions([{ ...base, status: "active", expiresAt: now - 1 }], now);
  assert.equal(stale.changed, true);
  assert.equal(stale.records[0].status, "stale");
  const archived = applyLifecycleTransitions([{
    ...base,
    status: "stale",
    staleAt: now - 31 * 24 * 60 * 60 * 1000,
  }], now);
  assert.equal(archived.records[0].status, "archived");
});

test("模型输出与规则提取会过滤敏感内容并限制候选数", () => {
  const proposals = normalizeMemoryProposals(JSON.stringify({
    memories: [
      { action: "create", key: "安全", content: "回答简洁", category: "preference", confidence: 0.9 },
      { action: "create", key: "密钥", content: "token=sk-abcdefghijklmnopqrstuvwxyz" },
    ],
  }));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].key, "安全");
  assert.equal(heuristicMemoryProposals("请记住：password=abcdefg").length, 0);
});

test("v3 事件日志达到阈值后压缩，重启仍能恢复全部记录", async () => {
  const dir = await freshStore();
  try {
    for (let index = 0; index < 520; index += 1) {
      await memorySlot.save({
        scope: memoryScope("general"),
        key: `批量主题${index}`,
        content: `批量内容${index}`,
        source: "user",
        status: "active",
      });
    }
    const before = memorySlotLocalStatus();
    assert.ok(before.eventCount < 100, `压缩后事件数应下降，actual=${before.eventCount}`);
    resetMemoryStore();
    const loaded = await memorySlot.list(memoryScope("general"), { statuses: ["active"] });
    assert.equal(loaded.length, 520);
  } finally {
    await dropStore(dir);
  }
});

test("Embedding 混合召回：无词法重合也能按向量召回，失败自动降级", async () => {
  const dir = await freshStore();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}") as { input?: string | string[] };
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];
    const data = inputs.map((text) => ({
      embedding: String(text).includes("甲") || String(text).includes("目标") ? [1, 0] : [0, 1],
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    configureSemanticMemory({
      enabled: true,
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: "mock-embedding",
      apiKey: "",
      timeoutMs: 2000,
      dimensions: 2,
      minSimilarity: 0.1,
    });
    await memorySlot.save({
      scope: memoryScope("general"), key: "甲主题", content: "甲内容", source: "user", status: "active",
    });
    await memorySlot.save({
      scope: memoryScope("general"), key: "乙主题", content: "乙内容", source: "user", status: "active",
    });
    const records = await readLocalRecords();
    await rebuildMemoryVectorIndex(memoryScope("general"), records);
    const hits = await memorySlot.search({ scope: memoryScope("general"), text: "目标", limit: 2 });
    assert.equal(hits.degraded, false);
    assert.equal(hits.records[0].key, "甲主题");

    configureSemanticMemory({
      enabled: true,
      baseURL: "http://127.0.0.1:1/v1",
      model: "down",
      apiKey: "",
      timeoutMs: 100,
      dimensions: 2,
      minSimilarity: 0.1,
    });
    const fallback = await memorySlot.search({ scope: memoryScope("general"), text: "甲主题", limit: 2 });
    assert.equal(fallback.degraded, true);
    assert.equal(fallback.records[0].key, "甲主题", "Embedding 失败必须保留词法结果");
    const note = await memorySlot.note({ scope: memoryScope("general"), query: "甲主题" });
    assert.match(note ?? "", /甲内容/, "语义降级后的词法结果仍应进入系统注记");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dropStore(dir);
  }
});