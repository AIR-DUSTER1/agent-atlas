/**
 * memory.test.ts — 长期记忆作用域、迁移与工具隔离回归
 * ============================================================
 * 守：v1 数组无损升级 v2、坏文件隔离、general/estate 不互读、
 * workflow 只注入当前 profile 的记忆，以及工具写入不越界。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import {
  resetMemoryStore,
  loadMemories,
  saveMemory,
  deleteMemory,
  searchMemories,
  memoryNoteForPrompt,
  listMemories,
  listMemoriesAsync,
  memoryStoreStatus,
  flushMemoryUsage,
  MAX_INJECT_MEMORIES,
  MEMORY_PROMPT_CHAR_BUDGET,
} from "../../src/memory-store.js";
import { memorySlot } from "../../src/memory/slot.js";
import { memorySave, memoryRecall, createMemoryTools } from "../../src/tools-memory.js";
import { rankMemories } from "../../src/memory/providers/local-search.js";
import type { MemoryProvider, MemoryRecord } from "../../src/memory/provider.js";
import { memoryScope } from "../../src/memory/scope.js";
import { buildAgentContext } from "../../src/agent/context-builder.js";
import { subagentProfileOf } from "../../src/agent/subagent.js";
import { generalProfile } from "../../src/agent/general.js";
import { estateProfile } from "../../src/agent/estate.js";
import type { AgentProfile } from "../../src/agent/profile.js";

const testProfile: AgentProfile = {
  id: "general",
  displayName: "测试 Agent",
  systemPrompt: "测试系统提示",
  tools: [],
  approvalDescriptions: {},
};

async function freshStore(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-mem-"));
  const file = join(dir, "memories.json");
  process.env.MEMORIES_FILE = file;
  resetMemoryStore();
  return { dir, file };
}

async function dropStore(dir: string): Promise<void> {
  delete process.env.MEMORIES_FILE;
  resetMemoryStore();
  await rm(dir, { recursive: true, force: true });
}

test("v1 数组自动迁移 v2：原字段保留，旧记忆默认归入 general", async () => {
  const { dir, file } = await freshStore();
  try {
    await writeFile(file, JSON.stringify([
      { id: "m1", key: "测试命令", content: "npm test", createdAt: 1, updatedAt: 2, source: "agent" },
    ]), "utf8");
    resetMemoryStore();
    assert.equal(await loadMemories("general"), 1);
    assert.equal(memoryStoreStatus().state, "migrated");
    assert.equal(memoryStoreStatus().migratedFrom, 1);
    const general = await listMemoriesAsync("general");
    assert.equal(general[0].id, "m1");
    assert.deepEqual(general[0].scope, { profileId: "general", userId: "local" });
    assert.equal(general[0].status, "active");

    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      schemaVersion: number;
      entries: Array<{ scope: { profileId: string } }>;
    };
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.entries[0].scope.profileId, "general");
    assert.equal(await loadMemories("estate"), 0, "旧数据不能被房产 Agent 继承");
  } finally {
    await dropStore(dir);
  }
});

test("存储核心：同 scope 同 key 新内容进入历史，跨 scope 不覆盖", async () => {
  const { dir, file } = await freshStore();
  try {
    const first = await saveMemory("回答风格", "结论先行", "agent", "general");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await saveMemory("回答风格", "结论先行，少用列表", "user", "general");
    assert.notEqual(second.id, first.id, "内容变化应生成新 active 版本");
    const estate = await saveMemory("回答风格", "房产回答要带风险提示", "user", "estate");
    assert.notEqual(estate.id, first.id);
    assert.equal(await loadMemories("general"), 1);
    assert.equal(await loadMemories("estate"), 1);
    assert.equal(listMemories("general").length, 1);
    assert.equal(listMemories("estate").length, 1);

    const persisted = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: number; entries: unknown[] };
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.entries.length, 3, "general 两条历史 + estate 一条 active");
  } finally {
    await dropStore(dir);
  }
});

test("作用域删除：不能用 general 默认值删除 estate 记忆", async () => {
  const { dir } = await freshStore();
  try {
    const estate = await saveMemory("房源偏好", "只看整租", "user", "estate");
    assert.equal(await deleteMemory(estate.id), false);
    assert.equal(await deleteMemory(estate.id, "estate"), true);
    assert.equal(await loadMemories("estate"), 0);
  } finally {
    await dropStore(dir);
  }
});

test("输入校验与坏文件隔离：坏 JSON 改名 .corrupt，不静默覆盖原文", async () => {
  const { dir, file } = await freshStore();
  try {
    await assert.rejects(() => saveMemory("  ", "内容", "agent"), /主题/);
    await assert.rejects(() => saveMemory("主题", "", "agent"), /内容/);
    await assert.rejects(() => saveMemory("k".repeat(51), "内容", "agent"), /主题过长/);
    await writeFile(file, "{ 不是 JSON", "utf8");
    resetMemoryStore();
    assert.equal(await loadMemories(), 0);
    assert.equal(memoryStoreStatus().state, "corrupt");
    assert.ok(memoryStoreStatus().quarantinedTo);
    const names = await readdir(dir);
    assert.ok(names.some((name) => name.includes(".corrupt-")), "原坏文件必须保留为隔离副本");
  } finally {
    await dropStore(dir);
  }
});

test("注入只含当前 scope：general 记忆不会进入 estate system 注记", async () => {
  const { dir } = await freshStore();
  try {
    await saveMemory("回答风格", "结论先行", "agent", "general");
    await saveMemory("房产口吻", "必须说明数据来源", "user", "estate");
    const generalNote = await memoryNoteForPrompt({ profileId: "general", query: "回答 风格" });
    const estateNote = await memoryNoteForPrompt({ profileId: "estate", query: "房产 口吻" });
    assert.match(generalNote ?? "", /结论先行/);
    assert.doesNotMatch(generalNote ?? "", /数据来源/);
    assert.match(estateNote ?? "", /数据来源/);
    assert.doesNotMatch(estateNote ?? "", /结论先行/);

    const context = buildAgentContext({
      profile: testProfile,
      messages: [new HumanMessage("以后回答先给结论")],
      memoryNote: generalNote ?? undefined,
    });
    const systemNotes = context.messages.filter((message) => message.getType() === "system");
    assert.equal(systemNotes.length, 2);
    assert.match(String(systemNotes[1].content), /跨会话长期记忆/);
  } finally {
    await dropStore(dir);
  }
});

test("工具：按闭包 scope 读写，成功/失败均返回中文文本", async () => {
  const { dir } = await freshStore();
  try {
    const saved = await memorySave.invoke({ key: "称呼", content: "称呼用户为老李" });
    assert.match(String(saved), /已记住.*称呼/);
    const tooLong = await memorySave.invoke({ key: "称呼", content: "x".repeat(600) });
    assert.match(String(tooLong), /内容过长/);
    const hit = await memoryRecall.invoke({ query: "称呼" });
    assert.match(String(hit), /老李/);

    const estateTools = createMemoryTools("estate");
    await estateTools.memorySave.invoke({ key: "城市", content: "用户在上海" });
    assert.match(String(await estateTools.memoryRecall.invoke({ query: "上海" })), /上海/);
    assert.doesNotMatch(String(await memoryRecall.invoke({ query: "上海" })), /用户在上海/);
  } finally {
    await dropStore(dir);
  }
});

test("轻量检索：多词 OR、大小写不敏感、空查询返回当前 scope 最新条目", async () => {
  const { dir } = await freshStore();
  try {
    await saveMemory("Editor", "Use VSCode", "agent", "general");
    await saveMemory("天气", "用户在北京", "agent", "general");
    const hits = await searchMemories("editor 北京", 10, "general");
    assert.equal(hits.length, 2);
    assert.equal((await searchMemories("", 1, "general")).length, 1);
  } finally {
    await dropStore(dir);
  }
});

test("历史版本：内容变化保留 superseded，完全相同只刷新不新增", async () => {
  const { dir, file } = await freshStore();
  try {
    const first = await saveMemory("回答风格", "结论先行", "agent", "general");
    const second = await saveMemory("回答风格", "结论先行，少用列表", "user", "general");
    assert.notEqual(second.id, first.id);
    const active = await listMemoriesAsync("general");
    assert.equal(active.length, 1);
    assert.equal(active[0].content, "结论先行，少用列表");
    const history = await listMemoriesAsync("general", { includeHistory: true });
    assert.equal(history.length, 2);
    assert.equal(history.find((item) => item.id === first.id)?.status, "superseded");

    await saveMemory("回答风格", "结论先行，少用列表", "agent", "general");
    assert.equal((await listMemoriesAsync("general", { includeHistory: true })).length, 2, "同内容不新增历史");

    const persisted = JSON.parse(await readFile(file, "utf8")) as { entries: Array<{ status: string }> };
    assert.equal(persisted.entries.filter((item) => item.status === "active").length, 1);
  } finally {
    await dropStore(dir);
  }
});

test("相关性评分：key 命中优先于 content，中文 bigram 可命中近似表达", () => {
  const now = Date.now();
  const base = { scope: { profileId: "general" as const, userId: "local" }, tags: [], source: "agent" as const, status: "active" as const, createdAt: now, updatedAt: now };
  const ranked = rankMemories([
    { ...base, id: "content", key: "其他", content: "用户希望回答风格保持一致" },
    { ...base, id: "key", key: "回答风格", content: "结论先行" },
    { ...base, id: "irrelevant", key: "部署", content: "使用 Docker" },
  ], "回答风格", 8, now);
  assert.equal(ranked[0].record.id, "key");
  assert.ok(ranked.some((item) => item.record.id === "content"));
  assert.ok(!ranked.some((item) => item.record.id === "irrelevant"));
});

test("注入预算：最多 8 条且总字符不超过 2400，空查询不注入", async () => {
  const { dir } = await freshStore();
  try {
    for (let i = 0; i < 12; i += 1) {
      await saveMemory(`主题${i}`, `偏好内容${i} ${"细节".repeat(80)}`, "agent", "general");
    }
    const note = await memoryNoteForPrompt({ profileId: "general", query: "主题 偏好" });
    assert.ok(note);
    assert.ok(note.length <= MEMORY_PROMPT_CHAR_BUDGET, `actual=${note.length}`);
    assert.ok((note.match(/\n- \[/g) ?? []).length <= MAX_INJECT_MEMORIES);
    assert.equal(await memoryNoteForPrompt({ profileId: "general", query: "   " }), null);
  } finally {
    await dropStore(dir);
  }
});

test("命中统计：searchMemories 更新 useCount/lastUsedAt，并节流后落盘", async () => {
  const { dir, file } = await freshStore();
  try {
    await saveMemory("回答风格", "结论先行", "agent", "general");
    const hits = await searchMemories("回答风格", 8, "general");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].useCount, 1);
    assert.ok(hits[0].lastUsedAt);
    await flushMemoryUsage();
    const persisted = JSON.parse(await readFile(file, "utf8")) as { entries: Array<{ useCount?: number; lastUsedAt?: number }> };
    assert.equal(persisted.entries[0].useCount, 1);
    assert.ok(persisted.entries[0].lastUsedAt);
  } finally {
    await dropStore(dir);
  }
});

test("敏感信息：secret 永远拒绝，PII 默认拒绝但显式 allowPII 可保存", async () => {
  const { dir } = await freshStore();
  try {
    await assert.rejects(
      () => saveMemory("API", "token=sk-abcdefghijklmnopqrstuvwxyz", "agent", "general"),
      /拒绝保存.*密钥/
    );
    await assert.rejects(
      () => saveMemory("电话", "用户手机号 13800138000", "agent", "general"),
      /手机号|身份证/
    );
    const saved = await saveMemory("电话", "用户手机号 13800138000", "user", "general", { allowPII: true });
    assert.match(saved.content, /13800138000/);
  } finally {
    await dropStore(dir);
  }
});

test("Provider Slot：可替换实现、重复注册拒绝、故障检索降级", async () => {
  const { dir } = await freshStore();
  try {
    const records = new Map<string, MemoryRecord>();
    const fake: MemoryProvider = {
      id: "http",
      capabilities: { read: true, write: true, delete: true, search: true, health: true },
      async health() { return { providerId: "http", status: "ok" }; },
      async save(input) {
        const record = {
          id: `fake-${records.size + 1}`,
          scope: input.scope,
          key: input.key,
          content: input.content,
          tags: input.tags ?? [],
          source: input.source,
          status: "active" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        records.set(record.id, record);
        return record;
      },
      async search(query) {
        const found = [...records.values()]
          .filter((item) => item.key.includes(query.text) || item.content.includes(query.text))
          .slice(0, query.limit)
          .map((item) => ({ ...item, scope: query.scope }));
        return { records: found, total: found.length, degraded: false, providerId: "http" };
      },
      async list(scope) {
        return [...records.values()].map((item) => ({ ...item, scope }));
      },
      async delete(id) { return records.delete(id); },
    };
    memorySlot.register(fake, { replace: true, activate: true });
    assert.equal(await memorySlot.providerId(), "http");
    await memorySlot.save({ scope: memoryScope("general"), key: "槽", content: "外部记忆", source: "agent" });
    const result = await memorySlot.search({ scope: memoryScope("general"), text: "外部", limit: 8 });
    assert.equal(result.records[0]?.content, "外部记忆");
    assert.throws(() => memorySlot.register(fake), /已注册/);

    const broken: MemoryProvider = {
      ...fake,
      async search() { throw new Error("mock 外部记忆超时"); },
    };
    memorySlot.register(broken, { replace: true, activate: true });
    const degraded = await memorySlot.search({ scope: memoryScope("general"), text: "外部", limit: 8 });
    assert.equal(degraded.degraded, true);
    assert.match(degraded.message ?? "", /超时/);
  } finally {
    await dropStore(dir);
  }
});

test("工具挂载隔离：general 挂记忆工具，estate 与子 Agent 均不挂", () => {
  const generalNames = generalProfile.tools.map((item) => item.name);
  assert.ok(generalNames.includes("memory_save"));
  assert.ok(generalNames.includes("memory_recall"));

  const estateNames = estateProfile.tools.map((item) => item.name);
  assert.ok(!estateNames.includes("memory_save"), "租房 Agent 默认不能写长期记忆");
  assert.ok(!estateNames.includes("memory_recall"), "租房 Agent 默认不能读长期记忆工具");

  const subNames = subagentProfileOf(generalProfile).tools.map((item) => item.name);
  assert.ok(!subNames.includes("memory_save"));
  assert.ok(!subNames.includes("memory_recall"));
  assert.ok(!subNames.includes("delegate_agent"));
});
